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

// Vendor conformance double (Phase 2) — a FHIR server that behaves like a named
// vendor, so certification can be exercised without a sandbox account.
//
// This is a SERVER double, not a test stub. It answers over the same injectable
// transport a live sandbox would use, which means `runContractTest` runs its
// UNMODIFIED code path against it. A stub that faked the CLIENT would prove
// nothing about the client; a server double exercises the real auth provider,
// the real capability negotiator and the real write-path guards.
//
// It deliberately reproduces the differences that decide whether an integration
// works, because those are the ones a profile can get wrong:
//
//   - the vendor's OWN CapabilityStatement, carrying only the resource types and
//     interactions that vendor declares. Discovery is evidence and must win over
//     the profile, so the two are allowed to disagree.
//   - SMART Backend Services: it verifies a REAL RS384 `client_assertion`
//     against the public key derived from the client's private key, and rejects
//     a broken signature, a wrong `aud`, a wrong `iss`/`sub` or an expired `exp`.
//   - non-standard required headers (Epic's client id). Missing means 401.
//   - the write surface. Athena declares no `create` at all, so a
//     MedicationRequest proposal receives a 405 and the degradation ladder has
//     to engage rather than the write silently appearing to succeed.
//
// What it is NOT: a FHIR implementation. It answers the handful of interactions
// the contract test performs, and returns an OperationOutcome shouting
// `not-supported` for anything else, so an unexpected call is a finding rather
// than a quiet pass.

import { createPublicKey, createVerify } from 'node:crypto';
import { CLIENT_ASSERTION_TYPE, requiresTokenEndpoint } from './auth.js';
import type { FetchLike, HttpResponseLike } from './http.js';
import {
  vendorProfile, type FhirInteraction, type VendorId, type VendorProfile,
} from './vendor-profile.js';

/** One request the double handled — the raw evidence a certification run produced. */
export interface DoubleRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Why it was refused, when it was. Never a credential. */
  readonly note?: string;
}

export interface ConformanceDoubleOptions {
  readonly vendor: VendorId;
  /** Base URL the double answers on. Defaults to a vendor-flavoured test host. */
  readonly baseUrl?: string;
  /**
   * Private key PEM the CLIENT signs its assertion with. The double derives the
   * public key from it, so a signature is genuinely checked. Omit it and the
   * token endpoint refuses every assertion, which is the honest answer.
   */
  readonly clientPrivateKeyPem?: string;
  /** The client id the assertion must name. */
  readonly clientId?: string;
  /** The access token the double issues, and then insists on. */
  readonly accessToken?: string;
  /** Set false to simulate a server that exposes no `/metadata` at all. */
  readonly serveMetadata?: boolean;
  /**
   * Override the declared interactions. Discovery is what counts, so a test can
   * describe a server NARROWER than its own profile and the negotiator must
   * believe the server rather than the profile.
   */
  readonly interactions?: Readonly<Record<string, readonly FhirInteraction[]>>;
  readonly now?: () => number;
}

export interface ConformanceDouble {
  readonly vendor: VendorId;
  readonly profile: VendorProfile;
  readonly baseUrl: string;
  readonly tokenEndpoint: string;
  readonly accessToken: string;
  /** The transport to inject into the contract test. */
  readonly fetch: FetchLike;
  /** Every request, in order — the evidence trail. */
  readonly requests: readonly DoubleRequest[];
  /** The statement it serves, for assertions that do not want HTTP in the way. */
  readonly capabilityStatement: Record<string, unknown>;
}

const SOFTWARE_NAMES: Readonly<Record<VendorId, string>> = {
  epic: 'Epic',
  cerner: 'Cerner Millennium / Oracle Health',
  athena: 'athenahealth',
  generic: 'FhirEmulator',
};

const SOFTWARE_VERSIONS: Readonly<Record<VendorId, string>> = {
  epic: '2026.1',
  cerner: '2026.01',
  athena: '2026.2',
  generic: '1.0.0',
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

function outcome(status: number, code: string, diagnostics: string): HttpResponseLike {
  return jsonResponse(
    status,
    { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] },
    { 'content-type': 'application/fhir+json' },
  );
}

/**
 * A CapabilityStatement shaped like the vendor's own.
 *
 * One `server` rest block whose resource list is exactly `interactions`, so
 * `summarizeCapabilities` reads back what the vendor really declares rather than
 * what the profile hoped for.
 */
export function vendorCapabilityStatement(
  vendor: VendorId,
  interactions: Readonly<Record<string, readonly FhirInteraction[]>>,
): Record<string, unknown> {
  const profile = vendorProfile(vendor);
  const resource = Object.entries(interactions).map(([type, codes]) => ({
    type,
    interaction: codes.map((code) => ({ code })),
  }));
  return {
    resourceType: 'CapabilityStatement',
    id: `conformance-double-${vendor}`,
    url: `urn:ananthealth:conformance-double:${vendor}`,
    version: SOFTWARE_VERSIONS[vendor],
    name: `${vendor}-conformance-double`,
    title: `${profile.label} conformance double`,
    status: 'active',
    date: '2026-09-14',
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    software: { name: SOFTWARE_NAMES[vendor], version: SOFTWARE_VERSIONS[vendor] },
    implementation: { description: `Conformance double for ${profile.label}` },
    rest: [{
      mode: 'server',
      security: {
        cors: true,
        service: [{
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/restful-security-service',
            code: 'SMART-on-FHIR',
          }],
        }],
      },
      // A vendor with no export at all must NOT advertise one — the negotiator
      // reads this and would otherwise claim a bulk export we cannot perform.
      ...(profile.supported.bulkExport === 'none'
        ? {}
        : { operation: [{ name: 'export', definition: 'http://hl7.org/fhir/OperationDefinition/Patient-export' }] }),
      resource,
    }],
  };
}

type AssertionVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Create a double that behaves like `vendor`.
 *
 * Everything it refuses is refused for a reason it names, because the point of
 * the exercise is to learn WHAT a vendor will not do during onboarding rather
 * than in production.
 */
export function createConformanceDouble(opts: ConformanceDoubleOptions): ConformanceDouble {
  const profile = vendorProfile(opts.vendor);
  const baseUrl = (opts.baseUrl ?? `https://${opts.vendor}.conformance.test/fhir`).replace(/\/+$/, '');
  const tokenEndpoint = `${baseUrl}/token`;
  const accessToken = opts.accessToken ?? 'conformance-access-token';
  const clientId = opts.clientId ?? 'conformance-client';
  const now = opts.now ?? (() => Date.now());
  const interactions = opts.interactions ?? profile.supported.interactions;
  const requests: DoubleRequest[] = [];
  const capabilityStatement = vendorCapabilityStatement(opts.vendor, interactions);
  const needsAuth = profile.authMode !== 'none';

  const record = (method: string, path: string, status: number, note?: string): void => {
    requests.push({ method, path, status, ...(note === undefined ? {} : { note }) });
  };

  /** Auth plus the vendor's own extra headers, checked before any resource work. */
  const authorize = (
    headers: Readonly<Record<string, string>>,
  ): { readonly response: HttpResponseLike; readonly reason: string } | undefined => {
    if (needsAuth && headers['authorization'] !== `Bearer ${accessToken}`) {
      const reason = `${profile.label}: a valid bearer token is required on every request`;
      return { response: outcome(401, 'login', reason), reason };
    }
    for (const name of profile.requiredHeaders) {
      const present = Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
      if (!present) {
        const reason = `${profile.label} requires the ${name} header on every request`;
        return { response: outcome(401, 'login', reason), reason };
      }
    }
    return undefined;
  };

  /** Verify a real RS384 assertion. This is the flow the whole package exists for. */
  const verifyAssertion = (assertion: string): AssertionVerdict => {
    const parts = assertion.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'client_assertion is not a three-part JWT' };
    const headerPart = parts[0] ?? '';
    const payloadPart = parts[1] ?? '';
    const signaturePart = parts[2] ?? '';

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'client_assertion header or payload is not JSON' };
    }

    if (header['alg'] !== 'RS384') {
      return { ok: false, reason: `client_assertion alg must be RS384, got ${String(header['alg'])}` };
    }
    if (opts.clientPrivateKeyPem === undefined) {
      return { ok: false, reason: 'the double holds no client public key, so no assertion can be trusted' };
    }

    let signatureOk = false;
    try {
      const verifier = createVerify('RSA-SHA384');
      verifier.update(`${headerPart}.${payloadPart}`);
      verifier.end();
      signatureOk = verifier.verify(
        createPublicKey(opts.clientPrivateKeyPem),
        Buffer.from(signaturePart, 'base64url'),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return { ok: false, reason: 'client_assertion signature does not verify' };

    if (payload['iss'] !== clientId || payload['sub'] !== clientId) {
      return { ok: false, reason: 'client_assertion iss and sub must both be the client id' };
    }
    if (payload['aud'] !== tokenEndpoint) {
      return { ok: false, reason: `client_assertion aud must be the token endpoint (${tokenEndpoint})` };
    }
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] : 0;
    if (exp <= Math.floor(now() / 1000)) {
      return { ok: false, reason: 'client_assertion has expired' };
    }
    return { ok: true };
  };

  const fetchImpl: FetchLike = async (url, init) => {
    const relative = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    const withQuery = relative.length > 0 ? relative : '/';
    const path = withQuery.split('?')[0] ?? '/';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;

    /* ------------------------------------------------------ token endpoint */

    if (init.method === 'POST' && path === '/token') {
      if (!requiresTokenEndpoint(profile.authMode)) {
        record(init.method, path, 404, 'vendor has no token endpoint');
        return outcome(404, 'not-supported', `${profile.label} has no token endpoint`);
      }
      const form = new URLSearchParams(init.body ?? '');
      if (form.get('grant_type') !== 'client_credentials') {
        record(init.method, path, 400, 'grant_type');
        return outcome(400, 'invalid_request', 'grant_type must be client_credentials');
      }
      if (form.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE) {
        record(init.method, path, 400, 'client_assertion_type');
        return outcome(400, 'invalid_request', 'client_assertion_type must be the jwt-bearer URN');
      }
      const verdict = verifyAssertion(form.get('client_assertion') ?? '');
      if (!verdict.ok) {
        record(init.method, path, 401, verdict.reason);
        return outcome(401, 'invalid_client', verdict.reason);
      }
      record(init.method, path, 200, 'token issued');
      return jsonResponse(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: form.get('scope') ?? '',
      });
    }

    /* ----------------------------------------------------------------- auth */

    const denied = authorize(headers);
    if (denied) {
      // The note carries the REASON. A bare "refused" would hide the single fact
      // an operator needs from a certification run: which header or credential
      // the vendor would not accept.
      record(init.method, path, denied.response.status, denied.reason);
      return denied.response;
    }

    /* -------------------------------------------------------------- metadata */

    if (init.method === 'GET' && path === '/metadata') {
      if (opts.serveMetadata === false) {
        record(init.method, path, 404, 'this server exposes no /metadata');
        return outcome(404, 'not-found', 'this server exposes no CapabilityStatement');
      }
      record(init.method, path, 200, 'capability statement');
      return jsonResponse(200, capabilityStatement, { 'content-type': 'application/fhir+json' });
    }

    /* ------------------------------------------------------------- resources */

    const match = /^\/([A-Za-z]+)$/.exec(path);
    if (match) {
      const resourceType = match[1] ?? '';
      const declared = interactions[resourceType] ?? [];
      const requested = Number(new URL(url, baseUrl).searchParams.get('_count') ?? '');
      const cap = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, profile.supported.maxPageSize)
        : profile.supported.maxPageSize;

      if (init.method === 'GET') {
        if (!declared.includes('read') && !declared.includes('search')) {
          record(init.method, path, 404, `${resourceType} is not declared`);
          return outcome(404, 'not-supported', `${profile.label} declares no read/search for ${resourceType}`);
        }
        record(init.method, path, 200, `searchset (page size ${cap})`);
        return jsonResponse(200, {
          resourceType: 'Bundle',
          type: 'searchset',
          total: 0,
          // Return a next link when we clamped, so a client that paginates walks
          // the real ceiling rather than assuming its own `_count` was honoured.
          ...(Number.isFinite(requested) && requested > cap
            ? { link: [{ relation: 'self', url: `${baseUrl}${path}?_count=${cap}` }] }
            : {}),
          entry: [],
        });
      }

      if (init.method === 'POST') {
        if (!declared.includes('create')) {
          record(init.method, path, 405, `${resourceType} create is not supported`);
          return outcome(
            405,
            'not-supported',
            `${profile.label} does not accept a create on ${resourceType}`
              + (profile.supported.proposalIntent ? '' : ', and offers no FHIR write surface'),
          );
        }
        const id = `double-${requests.length.toString(36)}`;
        record(init.method, path, 201, `created ${resourceType}/${id}`);
        return jsonResponse(201, { resourceType, id }, {
          location: `${baseUrl}${path}/${id}`,
          'content-type': 'application/fhir+json',
        });
      }
    }

    record(init.method, path, 404, 'no route in the double');
    return outcome(404, 'not-found', `the conformance double has no route for ${init.method} ${path}`);
  };

  return {
    vendor: opts.vendor,
    profile,
    baseUrl,
    tokenEndpoint,
    accessToken,
    fetch: fetchImpl,
    requests,
    capabilityStatement,
  };
}
