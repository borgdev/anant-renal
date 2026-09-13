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
 * business logic, computational optimization techniques,
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

// FHIR/EMR connection configuration and the live contract test (F0.2 + F0.3).
//
// Two things this surface must never do:
//
//   1. **Accept a literal secret.** The Kafka route established the pattern:
//      a `binding:NAME` reference is fine, a 24+ character opaque blob is
//      rejected with `secret-value-rejected`. The same guard runs here, on every
//      `*Ref` field, plus a PEM-specific check — pasting a private key into a
//      web form is the single most likely way a key leaks into a log.
//
//   2. **Claim a test it did not run.** `POST .../test` makes REAL network calls:
//      it reads the vendor's CapabilityStatement, exercises the credential, and
//      probes a live read. If it cannot reach the server it says so. This is
//      deliberately unlike the Kafka contract test, which verifies shape only
//      and performs no network call at all.
//
// The report it returns is the point of the package: it tells the operator which
// of the flows we need are available, which are DEGRADED and to what rung, and
// whether the vendor profile overstates what the server can actually do.

import type { FastifyInstance } from 'fastify';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { FhirIntegration, FhirIntegrationStatus, SwarmWorkspaceStore } from '../swarm/workspace.js';
import { FhirClient, FhirClientError } from '../fhir/client.js';
import {
  createAuthProvider, requiresTokenEndpoint, type AuthConfig, type AuthProviderContext,
} from '../fhir/auth.js';
import {
  negotiateCapabilities, parseCapabilityStatement, summarizeCapabilities,
  type CapabilityReport, type CapabilityStatementSummary,
} from '../fhir/capability.js';
import { buildCapabilityStatement, FHIR_VERSION } from '../fhir/metadata.js';
import { registerTerminologySurface } from './terminology-routes.js';
import { errorToFhirReply } from '../fhir/operation-outcome.js';
import { isVendorId, vendorProfile, type FhirAuthMode, type VendorId } from '../fhir/vendor-profile.js';
import { fhirSecretsProvider, SecretsStoreError } from '../control-plane/file-secrets.js';
import type { SecretsProvider } from '../control-plane/secrets.js';
import type { FetchLike } from '../fhir/http.js';

/** The regex that distinguishes a binding reference from a pasted secret. */
const LITERAL_SECRET = /^[A-Za-z0-9_+/=]{24,}$/;

/** Fields that must hold a `binding:NAME` reference rather than a value. */
const SECRET_REF_FIELDS = [
  'secretRef', 'tokenRef', 'passwordRef', 'privateKeyRef', 'clientSecretRef', 'refreshTokenRef',
] as const;

const AUTH_MODES: readonly FhirAuthMode[] = [
  'none', 'bearer', 'smart-backend-services', 'oauth2-delegated', 'basic', 'mtls',
];

export interface RegisterFhirIntegrationRoutesOptions {
  /** Where the encrypted secret store lives. Defaults to `HH_STORAGE` or `.harness`. */
  storeDir?: string;
  /** Injectable for tests; defaults to the encrypted file provider. */
  secrets?: SecretsProvider;
}

interface ContractStep {
  id: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

interface ContractResult {
  ok: boolean;
  status: FhirIntegrationStatus;
  summary: string;
  steps: ContractStep[];
  requests: Array<{ method: string; path: string; status: number; attempt: number }>;
  capabilities?: CapabilityStatementSummary;
  report?: CapabilityReport;
}

export async function registerFhirIntegrationRoutes(
  app: FastifyInstance,
  opts: RegisterFhirIntegrationRoutesOptions = {},
): Promise<void> {
  // An ENCAPSULATED scope, on purpose.
  //
  // Fastify's `setErrorHandler` is not path-scoped, so registering one on the
  // root app replaces error handling for EVERY route — which is exactly what a
  // first attempt did here, and it turned the tolerant JSON parser's 400 into a
  // 500 for every other endpoint in the product. A plugin scope is Fastify's
  // answer: the handler below applies to the routes registered inside it and
  // nothing else.
  await app.register(async (scope) => {
    scope.setErrorHandler((err, _req, reply) => {
      const { status, outcome } = errorToFhirReply(err);
      reply.code(status).header('content-type', 'application/fhir+json').send(outcome);
    });
    registerFhirSurface(scope, opts);
  });
}

/** The routes themselves, registered on whichever scope owns the error handler. */
function registerFhirSurface(
  app: FastifyInstance,
  opts: RegisterFhirIntegrationRoutesOptions,
): void {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const storeDir = opts.storeDir ?? process.env['HH_STORAGE'] ?? '.harness';
  const secrets: SecretsProvider = opts.secrets ?? fhirSecretsProvider(storeDir);

  /* ------------------------------------------------- our own statement */

  /**
   * `GET /fhir/metadata` — what WE are.
   *
   * Public by design: a capability statement is a discovery document, and a
   * vendor cannot register us as a Bulk Data source or a CDS service without
   * reading it. It contains no PHI and no configuration.
   */
  app.get('/fhir/metadata', async (req, reply) => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
    const scheme = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const baseUrl = `${scheme}://${host}/api/v1/fhir`;
    reply.header('content-type', 'application/fhir+json');
    return buildCapabilityStatement({
      baseUrl,
      generatedAt: new Date().toISOString(),
    });
  });

  /** A plain-JSON view of the same facts, for the console. */
  app.get('/admin/platform/integrations/fhir/metadata', async () => {
    const statement = buildCapabilityStatement({
      generatedAt: new Date().toISOString(),
    });
    const summary = summarizeCapabilities(statement, new Date().toISOString());
    return { fhirVersion: FHIR_VERSION, statement, summary };
  });

  /* ---------------------------------------------------- terminology (F4) */

  // $lookup / $validate-code / CodeSystem / ValueSet, so a receiver can resolve
  // the codes we send (including the local ones it cannot look up elsewhere).
  registerTerminologySurface(app);

  /* ------------------------------------------------------ read + write */

  app.get('/admin/platform/integrations/fhir', async () => {
    const integration = await ws().getFhirIntegration();
    return {
      integration,
      // Names and versions only. Never a value.
      secrets: await safeSecretList(secrets),
      secretsConfigured: secrets instanceof Object && !(secrets.constructor.name === 'UnavailableSecretsProvider'),
      profiles: profileSummaries(),
    };
  });

  app.put<{ Body: Record<string, unknown> }>('/admin/platform/integrations/fhir', async (req, reply) => {
    const body = req.body ?? {};

    // --- guard 1: a `*Ref` field must be a binding NAME, not a secret value.
    for (const field of SECRET_REF_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      const text = String(value);
      if (LITERAL_SECRET.test(text)) {
        return reply.code(400).send({
          error: 'secret-value-rejected',
          field,
          detail: 'Send a secret binding reference (e.g. binding:EMR_CLIENT_KEY), never the secret value itself.',
        });
      }
    }

    // --- guard 2: a PEM looks like nothing else. Catch it explicitly so the
    // error names the actual mistake rather than tripping guard 1 by length.
    for (const field of SECRET_REF_FIELDS) {
      const value = body[field];
      if (typeof value === 'string' && value.includes('BEGIN') && value.includes('PRIVATE KEY')) {
        return reply.code(400).send({
          error: 'secret-value-rejected',
          field,
          detail: 'That is a private key. Store it in the secrets provider and send only the binding name.',
        });
      }
    }

    // --- validation
    const vendor = body.vendor === undefined ? undefined : String(body.vendor);
    if (vendor !== undefined && !isVendorId(vendor)) {
      return reply.code(400).send({ error: 'invalid-vendor', allowed: Object.keys(profileSummaries()).length ? ['epic', 'cerner', 'athena', 'generic'] : [] });
    }
    const authMode = body.authMode === undefined ? undefined : String(body.authMode) as FhirAuthMode;
    if (authMode !== undefined && !AUTH_MODES.includes(authMode)) {
      return reply.code(400).send({ error: 'invalid-auth-mode', allowed: AUTH_MODES });
    }
    const effectiveProfile = vendorProfile(vendor ?? 'generic');
    const effectiveMode = authMode ?? effectiveProfile.authMode;
    if (requiresTokenEndpoint(effectiveMode) && body.tokenEndpoint === undefined) {
      return reply.code(400).send({
        error: 'token-endpoint-required',
        detail: `${effectiveMode} needs a tokenEndpoint before the connection can be tested.`,
      });
    }
    if (body.baseUrl !== undefined) {
      const base = String(body.baseUrl);
      if (base.length > 0 && !/^https?:\/\//i.test(base)) {
        return reply.code(400).send({ error: 'invalid-base-url', detail: 'baseUrl must be an absolute http(s) URL.' });
      }
    }
    const writePolicy = body.writePolicy;
    if (writePolicy !== undefined) {
      if (!writePolicy || typeof writePolicy !== 'object' || Array.isArray(writePolicy)) {
        return reply.code(400).send({ error: 'invalid-write-policy' });
      }
      for (const [kind, policy] of Object.entries(writePolicy as Record<string, unknown>)) {
        if (!['off', 'shadow', 'bound'].includes(String(policy))) {
          return reply.code(400).send({
            error: 'invalid-write-policy',
            kind,
            allowed: ['off', 'shadow', 'bound'],
            detail: '`shadow` is the default. Moving a kind to `bound` is a deliberate, human-gated cutover.',
          });
        }
      }
    }

    const integration = await ws().saveFhirIntegration(body);
    return { integration };
  });

  /* --------------------------------------------------- the contract test */

  /**
   * Run a REAL contract test against the configured (or supplied) connection.
   *
   * An operator may override the endpoint and binding NAMES in the body so they
   * can try before saving — but never a secret VALUE, because the guard above
   * applies here too.
   */
  app.post<{ Body: Record<string, unknown> }>('/admin/platform/integrations/fhir/test', async (req, reply) => {
    const body = req.body ?? {};
    for (const field of SECRET_REF_FIELDS) {
      const value = body[field];
      if (typeof value === 'string' && LITERAL_SECRET.test(value)) {
        return reply.code(400).send({ error: 'secret-value-rejected', field });
      }
    }

    const stored = await ws().getFhirIntegration();
    const merged: FhirIntegration = { ...stored, ...(body as Partial<FhirIntegration>) };

    if (!merged.baseUrl) {
      return reply.code(400).send({
        error: 'base-url-required',
        detail: 'Set a base URL (or pass one in the body) before running the contract test.',
      });
    }

    const result = await runContractTest(merged, secrets);

    // Persist the outcome. Separate from saving config so a failed test never
    // overwrites the credentials it just failed to use.
    const integration = await ws().recordFhirTest({
      status: result.status,
      testMode: 'live',
      testSummary: result.summary,
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
      ...(result.report ? { capabilityReport: result.report } : {}),
    });

    // A contract test that cannot reach the server is a 502; one that reached it
    // but found missing flows is a 200 with a report, because that IS the answer.
    if (!result.ok && result.steps.some((s) => s.id === 'capability' && s.status === 'failed')) {
      return reply.code(502).send({ ...result, integration });
    }
    return { ...result, integration };
  });
}

/* ------------------------------------------------------------- internals */

async function safeSecretList(secrets: SecretsProvider): Promise<readonly string[]> {
  try {
    const keys = await secrets.list();
    // Names only — the provider never returns values from `list`.
    return [...keys].sort();
  } catch {
    // An unavailable store is not an error for a read of names.
    return [];
  }
}

function profileSummaries(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ['epic', 'cerner', 'athena', 'generic'] as VendorId[]) {
    const p = vendorProfile(id);
    out[id] = {
      label: p.label,
      authMode: p.authMode,
      confidence: p.confidence,
      requiredHeaders: p.requiredHeaders,
      scopes: p.scopes,
      bulkExport: p.supported.bulkExport,
      proposalIntent: p.supported.proposalIntent,
      conversionObservable: p.supported.conversionObservable,
      maxPageSize: p.supported.maxPageSize,
      rateLimit: p.rateLimit,
      notes: p.notes,
    };
  }
  return out;
}

/** Build the auth configuration for a stored connection. */
function authConfigFor(integration: FhirIntegration): AuthConfig {
  const mode = integration.authMode;
  switch (mode) {
    case 'none':
      return { mode: 'none' };
    case 'bearer':
      return { mode: 'bearer', tokenRef: integration.tokenRef ?? 'binding:EMR_BEARER_TOKEN' };
    case 'basic':
      return {
        mode: 'basic',
        username: integration.username ?? 'fhir',
        passwordRef: integration.passwordRef ?? 'binding:EMR_PASSWORD',
      };
    case 'smart-backend-services':
      return {
        mode: 'smart-backend-services',
        clientId: integration.clientId ?? '',
        tokenEndpoint: integration.tokenEndpoint ?? '',
        privateKeyRef: integration.privateKeyRef ?? 'binding:EMR_CLIENT_PRIVATE_KEY',
        scopes: integration.scopes ?? 'system/*.read',
        ...(integration.kid ? { kid: integration.kid } : {}),
      };
    case 'oauth2-delegated':
      return {
        mode: 'oauth2-delegated',
        clientId: integration.clientId ?? '',
        tokenEndpoint: integration.tokenEndpoint ?? '',
        clientSecretRef: integration.clientSecretRef ?? 'binding:EMR_CLIENT_SECRET',
        refreshTokenRef: integration.refreshTokenRef ?? 'binding:EMR_REFRESH_TOKEN',
        scopes: integration.scopes ?? 'patient/*.read',
      };
    case 'mtls':
      // Certificate-based auth needs a TLS agent, which is a deployment concern
      // rather than a per-request header. Report it honestly rather than
      // pretending a header will do.
      return { mode: 'none' };
    default:
      return { mode: 'none' };
  }
}

export interface ContractTestOptions {
  readonly now?: () => string;
  /**
   * Injectable transport. The route does not supply one — a contract test is
   * supposed to hit the real server — but a test does, so the negotiation logic
   * can be exercised deterministically.
   */
  readonly fetch?: FetchLike;
}

/** Run the contract test steps and negotiate the capability report. */
export async function runContractTest(
  integration: FhirIntegration,
  secrets: SecretsProvider,
  opts: ContractTestOptions = {},
): Promise<ContractResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const steps: ContractStep[] = [];
  const requests: ContractResult['requests'] = [];
  const profile = vendorProfile(integration.vendor);
  const ctx: AuthProviderContext = { secrets };
  const authMode = integration.authMode;

  // --- 1. configuration completeness
  const missing: string[] = [];
  if (!integration.baseUrl) missing.push('baseUrl');
  if (requiresTokenEndpoint(authMode) && !integration.tokenEndpoint) missing.push('tokenEndpoint');
  if ((authMode === 'smart-backend-services' || authMode === 'oauth2-delegated') && !integration.clientId) {
    missing.push('clientId');
  }
  steps.push({
    id: 'config',
    label: 'Connection configuration',
    status: missing.length === 0 ? 'ok' : 'failed',
    detail: missing.length === 0
      ? `${profile.label} · ${authMode} · ${profile.confidence} profile confidence`
      : `missing: ${missing.join(', ')}`,
  });
  if (missing.length > 0) {
    return fail(status_for(missing), steps, requests, 'Configuration is incomplete');
  }

  // --- 2. the credential binding resolves (without ever touching its value)
  if (authMode !== 'none') {
    try {
      await createAuthProvider(authConfigFor(integration), ctx).headers();
      steps.push({
        id: 'credential',
        label: 'Credential',
        status: 'ok',
        detail: credentialDetail(integration, authMode),
      });
    } catch (err) {
      const detail = err instanceof SecretsStoreError
        ? err.message
        : err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err);
      steps.push({ id: 'credential', label: 'Credential', status: 'failed', detail });
      return fail('failed', steps, requests, 'Credential unavailable');
    }
  } else {
    steps.push({
      id: 'credential',
      label: 'Credential',
      status: 'skipped',
      detail: 'no auth configured (emulator or public reference server)',
    });
  }

  const client = new FhirClient({
    baseUrl: integration.baseUrl,
    ...(authMode !== 'none' ? { auth: createAuthProvider(authConfigFor(integration), ctx) } : {}),
    vendor: profile,
    ...(integration.vendorHeaders ? { headers: integration.vendorHeaders } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    onRequest: (e) => {
      requests.push({ method: e.method, path: e.path, status: e.status, attempt: e.attempt });
    },
    // The contract test is interactive: fail fast rather than retrying three
    // times while an operator waits.
    retry: { maxAttempts: 1 },
  });

  // --- 3. CapabilityStatement discovery
  let discovered: CapabilityStatementSummary | undefined;
  try {
    const statement = parseCapabilityStatement(await client.metadata());
    discovered = summarizeCapabilities(statement, now());
    steps.push({
      id: 'capability',
      label: 'CapabilityStatement discovery',
      status: 'ok',
      detail: `${discovered.softwareName ?? 'server'}${discovered.softwareVersion ? ` ${discovered.softwareVersion}` : ''} · FHIR ${discovered.fhirVersion ?? 'unknown'} · ${discovered.resourceTypes.length} resource type(s)`,
    });
  } catch (err) {
    const detail = err instanceof FhirClientError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    steps.push({
      id: 'capability',
      label: 'CapabilityStatement discovery',
      status: 'failed',
      detail: `${detail} — the server must expose /metadata for capability negotiation`,
    });
    return fail('failed', steps, requests, 'No CapabilityStatement');
  }

  // --- 4. A live read probe. Reading one resource proves more than /metadata.
  const probeType = (integration.resourceScope ?? []).find((t) => t !== 'CapabilityStatement') ?? 'Patient';
  try {
    const bundle = await client.search(probeType, { _count: '1' });
    const count = bundle.entry?.length ?? 0;
    steps.push({
      id: 'probe',
      label: `Live read probe (${probeType})`,
      status: 'ok',
      detail: `search returned ${count} entr${count === 1 ? 'y' : 'ies'}`,
    });
  } catch (err) {
    const detail = err instanceof FhirClientError ? err.message : String(err);
    steps.push({
      id: 'probe',
      label: `Live read probe (${probeType})`,
      status: 'failed',
      detail,
    });
  }

  // --- 5. Negotiate the flows we need against profile + discovery
  const report = negotiateCapabilities(profile, discovered, now());
  steps.push({
    id: 'negotiate',
    label: 'Flow negotiation',
    status: report.essentialBlocked.length === 0 ? 'ok' : 'failed',
    detail: report.headline,
  });

  const status: FhirIntegrationStatus = report.essentialBlocked.length > 0 ? 'degraded' : 'contract-verified';
  return {
    ok: report.essentialBlocked.length === 0,
    status,
    summary: report.headline,
    steps,
    requests,
    capabilities: discovered,
    report,
  };
}

function credentialDetail(integration: FhirIntegration, authMode: FhirAuthMode): string {
  switch (authMode) {
    case 'bearer':
      return `binding resolved (${integration.tokenRef ?? 'default'})`;
    case 'basic':
      return `username ${integration.username ?? '(none)'} · binding resolved`;
    case 'smart-backend-services':
      return `client ${integration.clientId} · assertion signed · scopes "${integration.scopes ?? ''}"`;
    case 'oauth2-delegated':
      return `client ${integration.clientId} · refresh binding resolved`;
    default:
      return authMode;
  }
}

function status_for(missing: string[]): FhirIntegrationStatus {
  return missing.length > 0 ? 'not-configured' : 'failed';
}

function fail(
  status: FhirIntegrationStatus,
  steps: ContractStep[],
  requests: ContractResult['requests'],
  summary: string,
): ContractResult {
  return { ok: false, status, summary, steps, requests };
}
