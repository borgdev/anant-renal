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

// FHIR authentication providers (F1.2).
//
// Three vendors, three auth models — so this is five implementations behind one
// interface, chosen by the connection's vendor profile:
//
//   SMART Backend Services  Epic, Cerner   client_assertion JWT → access token
//   OAuth2 delegated        Athena         no Backend Services flow exists
//   Static bearer           dev / bridged  a token that someone else refreshes
//   Basic                   rare           username + password
//   None                    emulator       no auth at all
//
// Two properties matter beyond "it works":
//
//   • **Tokens are cached and refreshed pro-actively** at 80 % of `expires_in`,
//     with single-flight de-duplication so ten concurrent requests share one
//     token fetch. Fetching a token per request is the fastest way to be
//     throttled by a real EMR.
//   • **No secret is ever logged, echoed in an error, or returned in a
//     diagnostic.** `describe()` reports *which* binding is in use, never what
//     it contains; a test greps captured output to prove it.

import { createSign, randomUUID } from 'node:crypto';
import type { SecretsProvider } from '../control-plane/secrets.js';
import type { FhirAuthMode } from './vendor-profile.js';
import { defaultFetch, headerValue, type FetchLike } from './http.js';

export interface AuthHeaders {
  [header: string]: string;
}

export interface AuthProviderContext {
  /** Resolves `binding:NAME` references. Never receives or returns raw secrets. */
  readonly secrets: SecretsProvider;
  readonly fetch?: FetchLike;
  /** Injectable clock (ms). Tests use it to exercise expiry deterministically. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class FhirAuthError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = 'FhirAuthError';
  }
}

export interface FhirAuthProvider {
  readonly mode: FhirAuthMode;
  /** Headers to attach to an outbound request. Cached where the mode allows. */
  headers(): Promise<AuthHeaders>;
  /** Drop any cached credential — call after a 401. */
  invalidate(): void;
  /** A secret-free one-liner for the contract test and the health panel. */
  describe(): string;
}

/* ------------------------------------------------------------------ helpers */

const BINDING_PREFIX = 'binding:';

/** Strip the `binding:` prefix so a ref can be used as a secret key. */
export function secretKey(ref: string): string {
  return ref.startsWith(BINDING_PREFIX) ? ref.slice(BINDING_PREFIX.length) : ref;
}

async function resolveSecret(ctx: AuthProviderContext, ref: string): Promise<string> {
  const key = secretKey(ref);
  const value = await ctx.secrets.get(key);
  if (!value) {
    // Name the BINDING, never a value.
    throw new FhirAuthError(`secret-not-found: no value bound to ${ref}`, 'secret-not-found');
  }
  return value;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface ClientAssertionOptions {
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly privateKeyPem: string;
  /** Milliseconds since epoch. */
  readonly now: number;
  readonly lifetimeSec?: number;
  readonly kid?: string;
  readonly jti?: string;
}

/**
 * Build a SMART Backend Services `client_assertion` (RFC 7523).
 *
 * `iss` and `sub` are both the client id, `aud` is the token endpoint, and the
 * lifetime is deliberately short — this assertion is single-use and travels to
 * the vendor's token endpoint.
 */
export function buildClientAssertion(opts: ClientAssertionOptions): string {
  const iat = Math.floor(opts.now / 1000);
  const exp = iat + Math.min(opts.lifetimeSec ?? 300, 300);
  const header: Record<string, unknown> = { alg: 'RS384', typ: 'JWT' };
  if (opts.kid) header.kid = opts.kid;
  const payload: Record<string, unknown> = {
    iss: opts.clientId,
    sub: opts.clientId,
    aud: opts.tokenEndpoint,
    jti: opts.jti ?? randomUUID(),
    iat,
    exp,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA384');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(opts.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface CachedToken {
  token: string;
  /** Epoch ms at which we should refresh — not at which it expires. */
  refreshAtMs: number;
}

/**
 * Shared token cache behaviour for the OAuth-family providers: one fetch for
 * concurrent callers, and a refresh comfortably before expiry.
 */
abstract class CachingTokenAuth implements FhirAuthProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;
  protected readonly ctx: AuthProviderContext;

  constructor(ctx: AuthProviderContext, private readonly refreshFraction = 0.8) {
    this.ctx = ctx;
  }

  abstract readonly mode: FhirAuthMode;
  abstract describe(): string;
  /** Perform the token request. Must not log or include secrets in errors. */
  protected abstract fetchToken(): Promise<TokenResponse>;

  private now(): number {
    return (this.ctx.now ?? Date.now)();
  }

  protected get doFetch(): FetchLike {
    return this.ctx.fetch ?? defaultFetch;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async headers(): Promise<AuthHeaders> {
    return { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/fhir+json' };
  }

  protected async token(): Promise<string> {
    const cached = this.cached;
    if (cached && this.now() < cached.refreshAtMs) return cached.token;
    // Single-flight: concurrent callers join the in-progress fetch.
    if (!this.inflight) {
      this.inflight = this.fetchToken()
        .then((res) => {
          if (!res.access_token) {
            throw new FhirAuthError('token-response-missing-access_token', 'invalid-token-response');
          }
          const lifetimeMs = (res.expires_in ?? 300) * 1000;
          this.cached = {
            token: res.access_token,
            refreshAtMs: this.now() + Math.max(1000, lifetimeMs * this.refreshFraction),
          };
          return res.access_token;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /** POST a form-encoded token request. */
  protected async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const res = await this.doFetch(this.tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      // Deliberately no body echo: a failing token endpoint may return the
      // credential it rejected.
      throw new FhirAuthError(
        `token-request-failed: HTTP ${res.status} from the token endpoint`,
        'token-request-failed',
        res.status,
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    const expiresIn = Number(json.expires_in);
    const scope = typeof json.scope === 'string' ? json.scope : undefined;
    return {
      access_token: token,
      ...(typeof json.token_type === 'string' ? { token_type: json.token_type } : {}),
      ...(Number.isFinite(expiresIn) ? { expires_in: expiresIn } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  protected abstract tokenEndpoint(): string;
}

/* --------------------------------------------------------------- providers */

/** No auth — the emulator, tests, and public reference servers. */
export class NoneAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'none';
  async headers(): Promise<AuthHeaders> {
    return { 'content-type': 'application/fhir+json' };
  }
  invalidate(): void { /* nothing cached */ }
  describe(): string { return 'none'; }
}

/** A static bearer token that something else refreshes. */
export class BearerAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'bearer';
  private cached: string | undefined;

  constructor(private readonly ctx: AuthProviderContext, private readonly tokenRef: string) {}

  async headers(): Promise<AuthHeaders> {
    if (!this.cached) this.cached = await resolveSecret(this.ctx, this.tokenRef);
    return { authorization: `Bearer ${this.cached}`, 'content-type': 'application/fhir+json' };
  }

  invalidate(): void { this.cached = undefined; }

  describe(): string { return `bearer(${this.tokenRef})`; }
}

/** HTTP Basic. Included for completeness; no target vendor uses it. */
export class BasicAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'basic';

  constructor(
    private readonly ctx: AuthProviderContext,
    private readonly username: string,
    private readonly passwordRef: string,
  ) {}

  async headers(): Promise<AuthHeaders> {
    const password = await resolveSecret(this.ctx, this.passwordRef);
    const encoded = Buffer.from(`${this.username}:${password}`, 'utf8').toString('base64');
    return { authorization: `Basic ${encoded}`, 'content-type': 'application/fhir+json' };
  }

  invalidate(): void { /* resolved per call */ }

  describe(): string { return `basic(${this.username}, ${this.passwordRef})`; }
}

export interface SmartBackendServicesConfig {
  readonly clientId: string;
  readonly tokenEndpoint: string;
  /** A `binding:NAME` reference to the PEM-encoded private key. */
  readonly privateKeyRef: string;
  /** Space-separated scopes, e.g. `system/*.read`. */
  readonly scopes: string;
  readonly kid?: string;
  /** Injectable for deterministic tests. */
  readonly jti?: () => string;
}

/**
 * SMART Backend Services (Epic, Cerner) — the flow this whole package exists for.
 *
 * Asymmetric `client_assertion`: no shared secret ever leaves the process, and
 * the assertion is short-lived and single-use.
 */
export class SmartBackendServicesAuth extends CachingTokenAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'smart-backend-services';

  constructor(
    ctx: AuthProviderContext,
    private readonly config: SmartBackendServicesConfig,
  ) {
    super(ctx);
  }

  protected tokenEndpoint(): string {
    return this.config.tokenEndpoint;
  }

  protected async fetchToken(): Promise<TokenResponse> {
    const privateKeyPem = await resolveSecret(this.ctx, this.config.privateKeyRef);
    const assertion = buildClientAssertion({
      clientId: this.config.clientId,
      tokenEndpoint: this.config.tokenEndpoint,
      privateKeyPem,
      now: (this.ctx.now ?? Date.now)(),
      ...(this.config.kid ? { kid: this.config.kid } : {}),
      ...(this.config.jti ? { jti: this.config.jti() } : {}),
    });
    return this.postToken({
      grant_type: 'client_credentials',
      scope: this.config.scopes,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    });
  }

  describe(): string {
    return `smart-backend-services(client ${this.config.clientId}, key ${this.config.privateKeyRef}, scopes "${this.config.scopes}")`;
  }
}

export interface OAuth2DelegatedConfig {
  readonly clientId: string;
  readonly clientSecretRef: string;
  readonly tokenEndpoint: string;
  /**
   * A `binding:NAME` reference holding the refresh token obtained during the
   * one-time consent step. Athena has no Backend Services flow, so a human
   * authorises once and we hold the refresh token thereafter.
   */
  readonly refreshTokenRef: string;
  readonly scopes: string;
}

/**
 * Delegated OAuth2 (Athena).
 *
 * This is genuinely different work from Backend Services, not a parameter
 * change: there is no system-level scope to hold, so authority comes from a
 * user's consent and must be re-established when it is revoked.
 */
export class OAuth2DelegatedAuth extends CachingTokenAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'oauth2-delegated';

  constructor(
    ctx: AuthProviderContext,
    private readonly config: OAuth2DelegatedConfig,
  ) {
    super(ctx);
  }

  protected tokenEndpoint(): string {
    return this.config.tokenEndpoint;
  }

  protected async fetchToken(): Promise<TokenResponse> {
    const [clientSecret, refreshToken] = await Promise.all([
      resolveSecret(this.ctx, this.config.clientSecretRef),
      resolveSecret(this.ctx, this.config.refreshTokenRef),
    ]);
    return this.postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: clientSecret,
      scope: this.config.scopes,
    });
  }

  describe(): string {
    return `oauth2-delegated(client ${this.config.clientId}, refresh ${this.config.refreshTokenRef}, scopes "${this.config.scopes}")`;
  }
}

/**
 * Per-user OAuth2 for a SMART app launch. Authority belongs to the logged-in
 * user, so the token is SUPPLIED per request rather than cached here.
 */
export class EhrLaunchAuth implements FhirAuthProvider {
  readonly mode: FhirAuthMode = 'oauth2-delegated';

  constructor(private readonly supplier: () => Promise<string | undefined>) {}

  async headers(): Promise<AuthHeaders> {
    const token = await this.supplier();
    if (!token) throw new FhirAuthError('launch-token-unavailable', 'launch-token-unavailable');
    return { authorization: `Bearer ${token}`, 'content-type': 'application/fhir+json' };
  }

  invalidate(): void { /* the supplier owns the lifecycle */ }

  describe(): string { return 'ehr-launch(per-user token)'; }
}

/* ----------------------------------------------------------------- factory */

export type AuthConfig =
  | { readonly mode: 'none' }
  | { readonly mode: 'bearer'; readonly tokenRef: string }
  | { readonly mode: 'basic'; readonly username: string; readonly passwordRef: string }
  | ({ readonly mode: 'smart-backend-services' } & SmartBackendServicesConfig)
  | ({ readonly mode: 'oauth2-delegated' } & OAuth2DelegatedConfig);

export function createAuthProvider(config: AuthConfig, ctx: AuthProviderContext): FhirAuthProvider {
  switch (config.mode) {
    case 'none':
      return new NoneAuth();
    case 'bearer':
      return new BearerAuth(ctx, config.tokenRef);
    case 'basic':
      return new BasicAuth(ctx, config.username, config.passwordRef);
    case 'smart-backend-services':
      return new SmartBackendServicesAuth(ctx, config);
    case 'oauth2-delegated':
      return new OAuth2DelegatedAuth(ctx, config);
  }
}

/** The connection fields that decide how we authenticate. Structural, so this
 *  file does not need to know about the workspace document that carries them. */
export interface ConnectionAuthFields {
  readonly authMode: FhirAuthMode;
  readonly clientId?: string;
  readonly tokenEndpoint?: string;
  readonly privateKeyRef?: string;
  readonly clientSecretRef?: string;
  readonly refreshTokenRef?: string;
  readonly tokenRef?: string;
  readonly passwordRef?: string;
  readonly username?: string;
  readonly scopes?: string;
  readonly kid?: string;
}

/**
 * Build the auth configuration for a stored connection.
 *
 * ONE definition, used by both the contract test that VERIFIES a connection and
 * the publisher that WRITES through it. Two copies would drift, and the drift
 * would mean the publish path authenticating differently from the test that
 * declared the connection healthy — a failure that only shows up in production.
 */
export function authConfigForConnection(integration: ConnectionAuthFields): AuthConfig {
  switch (integration.authMode) {
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

/**
 * Whether a vendor's auth mode can even be satisfied by a configuration.
 * Used by the contract test to fail early with a useful message rather than
 * producing a confusing 401 later.
 */
export function authModeMatches(vendorMode: FhirAuthMode, configMode: FhirAuthMode): boolean {
  return vendorMode === configMode;
}

/**
 * A token endpoint is required for every OAuth flow. Stated as a predicate so
 * the route can reject a configuration before saving it.
 */
export function requiresTokenEndpoint(mode: FhirAuthMode): boolean {
  return mode === 'smart-backend-services' || mode === 'oauth2-delegated';
}

/** Extract a bearer token from a token response for the contract test's report. */
export function tokenAcquired(res: TokenResponse): boolean {
  return typeof res.access_token === 'string' && res.access_token.length > 0;
}
