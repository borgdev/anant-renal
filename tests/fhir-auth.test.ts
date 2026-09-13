/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClientAssertion, SmartBackendServicesAuth, BearerAuth, NoneAuth,
  OAuth2DelegatedAuth, createAuthProvider, secretKey, requiresTokenEndpoint,
  FhirAuthError, CLIENT_ASSERTION_TYPE,
} from '../src/fhir/auth.js';
import {
  FileSecretsProvider, UnavailableSecretsProvider, fhirSecretsProvider,
  deriveKey, SecretsStoreError, SECRETS_KEY_ENV,
} from '../src/control-plane/file-secrets.js';
import { InMemorySecretsProvider } from '../src/control-plane/secrets.js';
import { FhirClient, FhirClientHttpError, nextLink, bundleResources } from '../src/fhir/client.js';
import { RateLimiter, backoffDelay, parseRetryAfter, isRetryableStatus, redactFhirPath } from '../src/fhir/http.js';
import { headerValue, type FetchLike, type HttpResponseLike } from '../src/fhir/http.js';

/* ------------------------------------------------------------------ fakes */

interface Recorder {
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? headers[n] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A transport that answers from a scripted list, then repeats the last entry. */
function scriptedFetch(steps: HttpResponseLike[], rec: Recorder): FetchLike {
  return async (url, init) => {
    rec.calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const step = steps[Math.min(rec.calls.length - 1, steps.length - 1)];
    return step as HttpResponseLike;
  };
}

const instant = { sleep: async () => undefined };

/* -------------------------------------------------- shared key material */

// Generated once for the file. `createSign` needs a REAL key — a placeholder
// string fails inside OpenSSL with "DECODER routines::unsupported", which reads
// like a code error rather than a fixture error.
let testPrivateKeyPem = '';
let testPublicKeyPem = '';

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  testPublicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

/* -------------------------------------------------- client assertion JWT */

describe('SMART Backend Services client_assertion (F1.2)', () => {
  const privateKeyPem = () => testPrivateKeyPem;
  const publicKeyPem = () => testPublicKeyPem;

  it('produces a verifiable RS384 JWT with the fields RFC 7523 requires', () => {
    const now = Date.UTC(2026, 8, 12, 12, 0, 0);
    const jwt = buildClientAssertion({
      clientId: 'client-abc',
      tokenEndpoint: 'https://emr.example/token',
      privateKeyPem: privateKeyPem(),
      now,
      jti: 'jti-fixed',
    });

    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && signatureB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString()) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString()) as Record<string, unknown>;

    expect(header.alg).toBe('RS384');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe('client-abc');
    expect(payload.sub).toBe('client-abc');
    expect(payload.aud).toBe('https://emr.example/token');
    expect(payload.jti).toBe('jti-fixed');
    // Short-lived: this assertion is single-use and travels to the vendor.
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(300);
    expect(Number(payload.iat)).toBe(Math.floor(now / 1000));

    // The signature must actually verify — otherwise the vendor rejects us and
    // the failure looks like a permissions problem.
    const verifier = createVerify('RSA-SHA384');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    expect(verifier.verify(publicKeyPem(), Buffer.from(signatureB64!, 'base64url'))).toBe(true);
  });

  it('includes a kid when one is configured, and omits it otherwise', () => {
    const withKid = buildClientAssertion({ clientId: 'c', tokenEndpoint: 't', privateKeyPem: privateKeyPem(), now: 0, kid: 'key-7' });
    const header = JSON.parse(Buffer.from(withKid.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
    expect(header.kid).toBe('key-7');

    const withoutKid = buildClientAssertion({ clientId: 'c', tokenEndpoint: 't', privateKeyPem: privateKeyPem(), now: 0 });
    const header2 = JSON.parse(Buffer.from(withoutKid.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
    expect(header2.kid).toBeUndefined();
  });

  it('generates a fresh jti per assertion so a replay is detectable', () => {
    const a = buildClientAssertion({ clientId: 'c', tokenEndpoint: 't', privateKeyPem: privateKeyPem(), now: 0 });
    const b = buildClientAssertion({ clientId: 'c', tokenEndpoint: 't', privateKeyPem: privateKeyPem(), now: 0 });
    expect(a).not.toBe(b);
  });
});

/* -------------------------------------------------------- auth providers */

describe('auth providers (F1.2)', () => {
  const secrets = () => new InMemorySecretsProvider();

  it('resolves a bearer token from a binding and caches it', async () => {
    const s = secrets();
    await s.set('EMR_TOKEN', 'tok-1');
    const auth = new BearerAuth({ secrets: s }, 'binding:EMR_TOKEN');
    expect(await auth.headers()).toEqual({
      authorization: 'Bearer tok-1',
      'content-type': 'application/fhir+json',
    });
    await s.set('EMR_TOKEN', 'tok-2');
    // Still cached — the binding is read once.
    expect((await auth.headers()).authorization).toBe('Bearer tok-1');
    auth.invalidate();
    expect((await auth.headers()).authorization).toBe('Bearer tok-2');
  });

  it('reports a missing binding by NAME, never by value', async () => {
    const auth = new BearerAuth({ secrets: secrets() }, 'binding:EMR_MISSING');
    await expect(auth.headers()).rejects.toThrow(FhirAuthError);
    await expect(auth.headers()).rejects.toThrow(/EMR_MISSING/);
  });

  it('never puts a secret value in describe()', async () => {
    const s = secrets();
    await s.set('EMR_KEY', 'super-secret-key-material');
    const auth = new SmartBackendServicesAuth(
      { secrets: s },
      {
        clientId: 'client-abc',
        tokenEndpoint: 'https://emr.example/token',
        privateKeyRef: 'binding:EMR_KEY',
        scopes: 'system/*.read',
      },
    );
    const described = auth.describe();
    expect(described).toContain('binding:EMR_KEY');
    expect(described).not.toContain('super-secret-key-material');
  });

  it('sets no authorization header when auth is none', async () => {
    expect(await new NoneAuth().headers()).toEqual({ 'content-type': 'application/fhir+json' });
  });

  it('knows which modes need a token endpoint', () => {
    expect(requiresTokenEndpoint('smart-backend-services')).toBe(true);
    expect(requiresTokenEndpoint('oauth2-delegated')).toBe(true);
    expect(requiresTokenEndpoint('none')).toBe(false);
    expect(requiresTokenEndpoint('bearer')).toBe(false);
  });

  it('strips the binding: prefix to form the secret key', () => {
    expect(secretKey('binding:KAFKA_BRIDGE_TOKEN')).toBe('KAFKA_BRIDGE_TOKEN');
    expect(secretKey('PLAIN_KEY')).toBe('PLAIN_KEY');
  });
});

describe('token cache and refresh', () => {
  /** A token endpoint that counts its calls and can change its answer. */
  function tokenEndpoint(rec: Recorder, body: Record<string, unknown> = { access_token: 'tok', expires_in: 300 }) {
    return scriptedFetch([jsonResponse(200, body)], rec);
  }

  it('single-flights: ten concurrent requests share ONE token fetch', async () => {
    const rec: Recorder = { calls: [] };
    const s = new InMemorySecretsProvider();
    await s.set('K', testPrivateKeyPem);
    const auth = new SmartBackendServicesAuth(
      { secrets: s, fetch: tokenEndpoint(rec) },
      { clientId: 'c', tokenEndpoint: 'https://emr.example/token', privateKeyRef: 'binding:K', scopes: 'system/*.read' },
    );

    const headers = await Promise.all(Array.from({ length: 10 }, () => auth.headers()));
    expect(rec.calls).toHaveLength(1);
    // The token request is a form POST with the assertion type RFC 7523 defines.
    const body = new URLSearchParams(rec.calls[0]!.body ?? '');
    expect(rec.calls[0]!.method).toBe('POST');
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE);
    expect(body.get('client_assertion')).toBeTruthy();
    expect(headers.every((h) => h.authorization === 'Bearer tok')).toBe(true);
  });

  it('refreshes pro-actively at 80% of expires_in, not at expiry', async () => {
    const rec: Recorder = { calls: [] };
    const s = new InMemorySecretsProvider();
    await s.set('K', testPrivateKeyPem);
    let clock = 1_000_000;
    const auth = new SmartBackendServicesAuth(
      { secrets: s, fetch: tokenEndpoint(rec, { access_token: 'tok', expires_in: 100 }), now: () => clock },
      { clientId: 'c', tokenEndpoint: 'https://emr.example/token', privateKeyRef: 'binding:K', scopes: 'system/*.read' },
    );

    await auth.headers();
    expect(rec.calls).toHaveLength(1);

    // 70% of the lifetime: still valid, must NOT refetch.
    clock += 70_000;
    await auth.headers();
    expect(rec.calls).toHaveLength(1);

    // 85%: past the refresh point, must refetch BEFORE the token dies.
    clock += 15_000;
    await auth.headers();
    expect(rec.calls).toHaveLength(2);
  });

  it('never leaks the rejected credential when the token endpoint fails', async () => {
    const rec: Recorder = { calls: [] };
    const s = new InMemorySecretsProvider();
    // A REAL key, so the assertion is actually built and the failure comes from
    // the token endpoint rather than from a malformed fixture.
    await s.set('K', testPrivateKeyPem);
    const auth = new SmartBackendServicesAuth(
      { secrets: s, fetch: scriptedFetch([jsonResponse(400, { error: 'invalid_client', client_secret: 'LEAKME' })], rec) },
      { clientId: 'c', tokenEndpoint: 'https://emr.example/token', privateKeyRef: 'binding:K', scopes: 'system/*.read' },
    );

    const message = await auth.headers().then(
      () => { throw new Error('expected a failure'); },
      (e: Error) => e.message,
    );
    expect(message).toMatch(/token-request-failed/);
    // The endpoint's error BODY is never echoed — it may contain the credential
    // it just rejected.
    expect(message).not.toContain('LEAKME');
    expect(message).not.toContain('invalid_client');
  });

  it('refreshes a delegated refresh-token flow', async () => {
    const rec: Recorder = { calls: [] };
    const s = new InMemorySecretsProvider();
    await s.set('SECRET', 'cs');
    await s.set('REFRESH', 'rt');
    const auth = new OAuth2DelegatedAuth(
      { secrets: s, fetch: tokenEndpoint(rec) },
      {
        clientId: 'c', clientSecretRef: 'binding:SECRET', refreshTokenRef: 'binding:REFRESH',
        tokenEndpoint: 'https://athena.example/token', scopes: 'patient/*.read',
      },
    );
    await auth.headers();
    const body = new URLSearchParams(rec.calls[0]!.body ?? '');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('c');
  });
});

/* --------------------------------------------------------- secrets store */

describe('encrypted file secrets (F1.4)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'hh-fhir-secrets-'));

  it('round-trips a value and never writes it in the clear', async () => {
    const path = join(dir(), 's.json');
    const store = new FileSecretsProvider({ filePath: path, keyMaterial: 'a-passphrase-for-tests' });
    await store.set('EMR_KEY', 'the-private-key-material');
    expect(await store.get('EMR_KEY')).toBe('the-private-key-material');

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('the-private-key-material');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
  });

  it('writes the store 0600', async () => {
    const path = join(dir(), 's.json');
    const store = new FileSecretsProvider({ filePath: path, keyMaterial: 'pass' });
    await store.set('K', 'v');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to decrypt with the wrong key rather than returning garbage', async () => {
    const path = join(dir(), 's.json');
    const good = new FileSecretsProvider({ filePath: path, keyMaterial: 'right-key' });
    await good.set('K', 'v');
    const wrong = new FileSecretsProvider({ filePath: path, keyMaterial: 'wrong-key' });
    await expect(wrong.get('K')).rejects.toThrow(SecretsStoreError);
    await expect(wrong.get('K')).rejects.toThrow(/secret-undecryptable/);
  });

  it('versions on rotate and lists names only', async () => {
    const store = new FileSecretsProvider({ filePath: join(dir(), 's.json'), keyMaterial: 'pass' });
    await store.set('A', 'one');
    const rot = await store.rotate('A', 'two');
    expect(rot).toEqual({ previousVersion: 1, newVersion: 2 });
    expect(await store.get('A')).toBe('two');
    expect(await store.list()).toEqual(['A']);
    expect(await store.list('Z')).toEqual([]);
    // Metadata must never carry a value.
    expect(JSON.stringify(store.metadata())).not.toContain('two');
  });

  it('accepts a base64 32-byte key without stretching it', () => {
    const raw = Buffer.alloc(32, 7).toString('base64');
    expect(deriveKey(raw, 'ignored').kdf).toBe('raw');
    expect(deriveKey('a passphrase', Buffer.alloc(16).toString('base64')).kdf).toBe('scrypt');
  });

  it('carries the remedy when no key is configured', async () => {
    const provider = new UnavailableSecretsProvider('no key configured');
    await expect(provider.get('X')).rejects.toThrow(/secret-store-unavailable/);
    // Reading names is not an error, so the console can still render.
    expect(await provider.list()).toEqual([]);
  });

  it('fails on USE, not on construction, when the env key is absent', async () => {
    const previous = process.env[SECRETS_KEY_ENV];
    delete process.env[SECRETS_KEY_ENV];
    try {
      const provider = fhirSecretsProvider('/tmp/does-not-matter');
      // Constructing is fine — a server must boot without FHIR credentials.
      expect(provider).toBeInstanceOf(UnavailableSecretsProvider);
      await expect(provider.get('K')).rejects.toThrow(new RegExp(SECRETS_KEY_ENV));
    } finally {
      if (previous !== undefined) process.env[SECRETS_KEY_ENV] = previous;
    }
  });
});

/* ---------------------------------------------------- client hardening */

describe('FhirClient hardening (F1.5)', () => {
  const resource = { resourceType: 'ServiceRequest', id: 'sr-1', status: 'draft' } as never;

  it('retries 503 up to maxAttempts and then succeeds', async () => {
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(503, {}), jsonResponse(503, {}), jsonResponse(200, resource)], rec),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ...instant,
    });
    const out = await client.get('ServiceRequest', 'sr-1');
    expect(out).toMatchObject({ id: 'sr-1' });
    expect(rec.calls).toHaveLength(3);
  });

  it('does NOT retry a 400 — repeating a bad request cannot help', async () => {
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(400, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics: 'bad dosage' }] })], rec),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ...instant,
    });
    await expect(client.get('ServiceRequest', 'sr-1')).rejects.toThrow(FhirClientHttpError);
    expect(rec.calls).toHaveLength(1);
  });

  it('surfaces the OperationOutcome so a caller can branch on the issue code', async () => {
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(422, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'business-rule', diagnostics: 'iron panel stale' }] })], rec),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    const err = await client.get('ServiceRequest', 'sr-1').then(
      () => { throw new Error('expected a failure'); },
      (e: unknown) => e as FhirClientHttpError,
    );
    expect(err).toBeInstanceOf(FhirClientHttpError);
    expect(err.issueCodes).toContain('business-rule');
    expect(err.message).toContain('iron panel stale');
    expect(err.outcome?.issue[0]?.diagnostics).toBe('iron panel stale');
  });

  it('invalidates the token after a 401 and retries exactly once', async () => {
    const rec: Recorder = { calls: [] };
    let headers = 0;
    let invalidations = 0;
    const auth = {
      mode: 'bearer' as const,
      async headers() { headers += 1; return { authorization: `Bearer t${headers}` }; },
      invalidate() { invalidations += 1; },
      describe: () => 'fake',
    };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      auth,
      fetch: scriptedFetch([jsonResponse(401, {}), jsonResponse(200, resource)], rec),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ...instant,
    });

    const out = await client.get('ServiceRequest', 'sr-1');
    expect(out).toMatchObject({ id: 'sr-1' });
    expect(invalidations).toBe(1);
    // The refreshed token was used on the retry.
    expect(rec.calls[1]!.headers.authorization).toBe('Bearer t2');
  });

  it('gives up after a second 401 — that is a permissions problem, not a stale token', async () => {
    const rec: Recorder = { calls: [] };
    const auth = { mode: 'bearer' as const, async headers() { return { authorization: 'Bearer x' }; }, invalidate() { /* once */ }, describe: () => 'f' };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      auth,
      fetch: scriptedFetch([jsonResponse(401, {})], rec),
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1 },
      ...instant,
    });
    await expect(client.get('ServiceRequest', 'sr-1')).rejects.toThrow(/HTTP 401/);
    // One original + one refresh retry, then stop.
    expect(rec.calls).toHaveLength(2);
  });

  it('honours Retry-After rather than its own backoff', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    // An HTTP-date is second-resolution, so pin `now` rather than reading the
    // wall clock — otherwise the delta depends on the sub-second position and
    // the assertion is flaky.
    const target = Date.UTC(2026, 0, 1, 12, 0, 5);
    expect(parseRetryAfter(new Date(target).toUTCString(), target - 2000)).toBe(2000);
    // A malformed value is ignored rather than treated as zero.
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('only treats 429 and 5xx as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  it('applies jitter so a throttled fleet does not retry in lockstep', () => {
    const zero = backoffDelay(3, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 1 }, undefined, () => 0);
    const one = backoffDelay(3, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 1 }, undefined, () => 1);
    expect(zero).toBe(0);
    expect(one).toBe(4000);
    // A pinned Retry-After wins over the exponential estimate.
    expect(backoffDelay(3, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, timeoutMs: 1 }, 500, () => 1)).toBe(500);
  });

  it('follows link[rel=next] and caps the page count', async () => {
    const page1 = {
      resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'next', url: 'https://emr.example/fhir/Patient?_page=2' }],
      entry: [{ resource: { resourceType: 'Patient', id: 'p1' } }],
    };
    const page2 = {
      resourceType: 'Bundle', type: 'searchset',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p2' } },
        { resource: { resourceType: 'Patient', id: 'p3' } },
      ],
    };
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(200, page1), jsonResponse(200, page2)], rec),
      retry: { maxAttempts: 1 },
      ...instant,
    });

    const all = await client.searchAll('Patient', {});
    expect(all.pages).toBe(2);
    expect(all.truncated).toBe(false);
    expect(all.resources.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    // The next link was followed as a path, not re-prefixed with the base URL.
    expect(rec.calls[1]!.url).toBe('https://emr.example/fhir/Patient?_page=2');
  });

  it('reports truncation instead of reading a server forever', async () => {
    const endless = {
      resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'next', url: 'https://emr.example/fhir/Patient?_page=99' }],
      entry: [{ resource: { resourceType: 'Patient', id: 'p' } }],
    };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: async () => jsonResponse(200, endless),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    const all = await client.searchAll('Patient', {}, { maxPages: 3 });
    expect(all.pages).toBe(3);
    expect(all.truncated).toBe(true);
  });

  it('sends If-None-Exist so a retry reconciles instead of duplicating', async () => {
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(201, resource)], rec),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    await client.create({ resourceType: 'ServiceRequest', status: 'draft' } as never, 'https://anant.example/proposal|abc');
    expect(rec.calls[0]!.headers['if-none-exist']).toBe('https://anant.example/proposal|abc');
    expect(rec.calls[0]!.method).toBe('POST');
  });

  it('PUTs when an id is present so a re-publish is an update', async () => {
    const rec: Recorder = { calls: [] };
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(200, resource)], rec),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    await client.update(resource, 'W/"3"');
    expect(rec.calls[0]!.method).toBe('PUT');
    expect(rec.calls[0]!.headers['if-match']).toBe('W/"3"');
  });

  it('sets the profile’s non-standard header only when a value was supplied', async () => {
    const rec: Recorder = { calls: [] };
    const without = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      vendor: 'epic',
      fetch: scriptedFetch([jsonResponse(200, resource)], rec),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    await without.get('ServiceRequest', 'sr-1');
    // No client id was configured, so we must not send an empty header.
    expect(rec.calls[0]!.headers['Epic-Client-ID']).toBeUndefined();

    const rec2: Recorder = { calls: [] };
    const withId = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      vendor: 'epic',
      headers: { 'Epic-Client-ID': 'epic-app-1' },
      fetch: scriptedFetch([jsonResponse(200, resource)], rec2),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    await withId.get('ServiceRequest', 'sr-1');
    expect(rec2.calls[0]!.headers['Epic-Client-ID']).toBe('epic-app-1');
  });

  it('emits a PHI-free request log, redacting the identifier in the path', async () => {
    const rec: Recorder = { calls: [] };
    const entries: Array<Record<string, unknown>> = [];
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: scriptedFetch([jsonResponse(200, resource)], rec),
      retry: { maxAttempts: 1 },
      onRequest: (e) => entries.push({ ...e }),
      ...instant,
    });
    await client.get('ServiceRequest', 'sr-1');
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).sort()).toEqual(['attempt', 'durationMs', 'method', 'path', 'retried', 'status']);
    // The identifier must NOT survive into the log — a real path would carry a
    // patient id, and these entries are aggregated and retained.
    expect(JSON.stringify(entries)).not.toContain('sr-1');
    expect(entries[0]!.path).toBe('ServiceRequest/{id}');
  });

  it('redacts identifiers but keeps the shape and the safe paging params', () => {
    expect(redactFhirPath('Patient/f1-pt-0001')).toBe('Patient/{id}');
    expect(redactFhirPath('Patient/$export')).toBe('Patient/$export');
    expect(redactFhirPath('metadata')).toBe('metadata');
    // A search query can carry a patient reference; only paging survives.
    expect(redactFhirPath('Observation?patient=Patient/123&code=K')).toBe('Observation?{redacted}');
    expect(redactFhirPath('Observation?_count=100&_sort=-date')).toBe('Observation?_count=100&_sort=-date');
  });

  it('redacts the identifier from a thrown error message too, because those persist', async () => {
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: async () => jsonResponse(404, {}),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    const message = await client.get('Patient', 'f1-pt-0001').then(
      () => { throw new Error('expected a failure'); },
      (e: Error) => e.message,
    );
    expect(message).not.toContain('f1-pt-0001');
    expect(message).toContain('Patient/{id}');
    expect(message).toContain('404');
  });

  it('reads metadata through the capability parser', async () => {
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: async () => jsonResponse(200, { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [] }),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    expect((await client.metadata()).fhirVersion).toBe('4.0.1');
  });

  it('reports a 202 export as running rather than as a failure', async () => {
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: async () => jsonResponse(202, {}),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    const status = await client.exportStatus('Patient/$export');
    expect(status.status).toBe('running');
    expect(status.outputs).toEqual([]);
  });

  it('parses an export manifest', async () => {
    const client = new FhirClient({
      baseUrl: 'https://emr.example/fhir',
      fetch: async () => jsonResponse(200, {
        output: [{ type: 'Patient', url: 'https://x/1.ndjson', count: 12 }],
        deleted: [{ type: 'Observation', url: 'https://x/d.ndjson' }],
        error: [],
      }),
      retry: { maxAttempts: 1 },
      ...instant,
    });
    const status = await client.exportStatus('Patient/$export');
    expect(status.status).toBe('complete');
    expect(status.outputs).toEqual([{ type: 'Patient', url: 'https://x/1.ndjson', count: 12 }]);
    expect(status.deleted).toHaveLength(1);
  });
});

describe('rate limiting', () => {
  it('starts with a full burst and refills over time', () => {
    let clock = 0;
    const limiter = new RateLimiter(60, 3, () => clock);
    expect(limiter.available()).toBe(3);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    // 60/min = 1 per second. After 1s we get one back.
    clock += 1000;
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('reports how long to wait rather than dropping the request', () => {
    const limiter = new RateLimiter(60, 1, () => 0);
    expect(limiter.delayMs()).toBe(0);
    limiter.tryAcquire();
    expect(limiter.delayMs()).toBeGreaterThan(0);
  });

  it('waits and then proceeds instead of failing', async () => {
    // A rate limiter needs a clock that ADVANCES; a frozen one can never refill
    // and the wait loop would spin forever.
    let clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(60_000, 1, () => clock);
    const sleep = async (ms: number) => { slept.push(ms); clock += ms; };

    await limiter.acquire(sleep);
    expect(slept).toHaveLength(0);
    // The bucket is now empty; the second call must wait rather than throw.
    await limiter.acquire(sleep);
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
  });
});

describe('small helpers', () => {
  it('reads headers from both a Headers-like object and a plain record', () => {
    const asObject = jsonResponse(200, {}, { etag: 'W/"1"' });
    expect(headerValue(asObject, 'ETag')).toBe('W/"1"');
    expect(headerValue({ ok: true, status: 200, json: async () => undefined }, 'ETag')).toBeUndefined();
  });

  it('finds the next link and the resources in a bundle', () => {
    const bundle = {
      resourceType: 'Bundle' as const, type: 'searchset' as const,
      link: [{ relation: 'self', url: 'a' }, { relation: 'next', url: 'b' }],
      entry: [{ resource: { resourceType: 'Patient', id: 'p1' } as never }],
    };
    expect(nextLink(bundle)).toBe('b');
    expect(bundleResources(bundle).map((r) => r.id)).toEqual(['p1']);
    expect(nextLink({ resourceType: 'Bundle', type: 'searchset' })).toBeUndefined();
  });

  it('creates each provider shape from a config', async () => {
    const s = new InMemorySecretsProvider();
    expect(createAuthProvider({ mode: 'none' }, { secrets: s })).toBeInstanceOf(NoneAuth);
    expect(createAuthProvider({ mode: 'bearer', tokenRef: 'binding:T' }, { secrets: s })).toBeInstanceOf(BearerAuth);
    expect(
      createAuthProvider(
        { mode: 'smart-backend-services', clientId: 'c', tokenEndpoint: 't', privateKeyRef: 'binding:K', scopes: 'system/*.read' },
        { secrets: s },
      ),
    ).toBeInstanceOf(SmartBackendServicesAuth);
  });
});
