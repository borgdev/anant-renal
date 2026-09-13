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

// Outbound FHIR client (F1.5) — hardened, and with the verbs an integration
// actually needs.
//
// What this file gained over its first version:
//
//   • Retry with jittered backoff, but ONLY on 429/5xx/transport errors. A 4xx
//     is a statement about the request; repeating it three times is three times
//     the load for the same answer.
//   • `Retry-After` is honoured rather than ignored.
//   • A per-connection rate limiter and timeout, so a fleet cannot throttle
//     itself out of an EMR.
//   • Pagination that follows `link[rel=next]`, bounded by page count.
//   • `If-Match` / `If-None-Exist`, which is what makes a re-publish an update
//     rather than a duplicate.
//   • A response size cap, so a broken server is a loud failure rather than an
//     out-of-memory crash.
//   • Auth delegated to a `FhirAuthProvider`, with a single retry after a 401 so
//     an expired token is refreshed once rather than never.
//   • A PHI-free request log hook.
//
// The injectable `fetch` seam is unchanged, so existing tests that pass a
// minimal `{ ok, status, json }` fake keep working: a response without `text()`
// or `headers` is tolerated throughout.

import type { Bundle, BundleEntry, FhirResource } from './types.js';
import type { FhirAuthProvider } from './auth.js';
import {
  DEFAULT_RETRY, RateLimiter, backoffDelay, defaultFetch, defaultSleep, headerValue,
  isRetryableStatus, parseRetryAfter, redactFhirPath, assertBodySize,
  type FetchLike, type HttpResponseLike, type RetryPolicy,
} from './http.js';
import { CapabilityStatementError, parseCapabilityStatement, type CapabilityStatement } from './capability.js';
import { errorToFhirReply, issuesFromBody, type OperationOutcome } from './operation-outcome.js';
import type { VendorProfile, VendorId } from './vendor-profile.js';
import { vendorProfile } from './vendor-profile.js';

export interface FhirClientOptions {
  baseUrl: string;
  /** Legacy static token. Prefer `auth`, which handles refresh. */
  bearerToken?: string;
  headers?: Record<string, string>;
  /**
   * Injectable transport for tests.
   *
   * Deliberately ONE signature rather than a union: a union of function types
   * defeats contextual typing, so `(url, init) => ...` would get implicitly-any
   * parameters at every call site. Test doubles that implement only
   * `{ ok, status, json }` satisfy `HttpResponseLike` structurally, so the single
   * permissive signature covers them without the union.
   */
  fetch?: FetchLike;
  /** An auth provider. Takes precedence over `bearerToken` when supplied. */
  auth?: FhirAuthProvider;
  /** Selects the rate-limit and page-size defaults. */
  vendor?: VendorProfile | VendorId;
  retry?: Partial<RetryPolicy>;
  /** A PHI-free hook for the health panel and the contract test's request log. */
  onRequest?: (entry: FhirRequestLogEntry) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FhirRequestLogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly attempt: number;
  readonly durationMs: number;
  readonly retried: boolean;
}

export class FhirClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FhirClientError';
  }
}

/**
 * A failure the SERVER described. Carries the `OperationOutcome` so a caller can
 * branch on the issue code instead of pattern-matching a message.
 */
export class FhirClientHttpError extends FhirClientError {
  constructor(
    message: string,
    status: number,
    readonly outcome: OperationOutcome | undefined,
    readonly issueCodes: readonly string[],
  ) {
    super(message, status);
    this.name = 'FhirClientHttpError';
  }
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Override the default retry policy for this call. */
  readonly retry?: Partial<RetryPolicy>;
}

export interface SearchOptions {
  /** Stop after this many pages. Guards against an unbounded server. */
  readonly maxPages?: number;
  readonly headers?: Record<string, string>;
}

export interface ExportRequest {
  /** `Patient` or `Group`. */
  readonly level?: 'Patient' | 'Group';
  readonly groupId?: string;
  readonly since?: string;
  readonly types?: readonly string[];
  readonly typeFilter?: readonly string[];
}

export interface ExportJob {
  /** Where to poll for status. */
  readonly statusUrl: string;
  /** Present when the server answered `200` immediately. */
  readonly contentLocation?: string;
}

export interface ExportStatus {
  readonly status: 'running' | 'complete' | 'error' | 'unknown';
  readonly progress?: string;
  readonly outputs: readonly { type: string; url: string; count?: number }[];
  readonly deleted: readonly { type: string; url: string }[];
  readonly errors: readonly { type: string; url: string }[];
}

const MAX_PAGES_DEFAULT = 50;

export class FhirClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly doFetch: FetchLike;
  private readonly auth: FhirAuthProvider | undefined;
  private readonly profile: VendorProfile;
  private readonly retry: RetryPolicy;
  private readonly limiter: RateLimiter;
  private readonly onRequest: ((entry: FhirRequestLogEntry) => void) | undefined;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** Set once we learn the server's page ceiling differs from the profile's. */
  private observedMaxPageSize: number | undefined;

  constructor(opts: FhirClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.bearerToken = opts.bearerToken;
    this.extraHeaders = opts.headers ?? {};
    this.doFetch = opts.fetch ?? defaultFetch;
    this.auth = opts.auth;
    this.profile = typeof opts.vendor === 'string'
      ? vendorProfile(opts.vendor)
      : opts.vendor ?? vendorProfile('generic');
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.nowFn = opts.now ?? Date.now;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.limiter = new RateLimiter(
      this.profile.rateLimit.requestsPerMinute,
      this.profile.rateLimit.burst,
      this.nowFn,
    );
    this.onRequest = opts.onRequest;
  }

  /** The vendor profile in force, for callers needing its limits or ladder. */
  vendor(): VendorProfile {
    return this.profile;
  }

  /** Largest `_count` to send: the profile's value, corrected by observation. */
  maxPageSize(): number {
    return this.observedMaxPageSize ?? this.profile.supported.maxPageSize;
  }

  /* -------------------------------------------------------------- headers */

  private async baseHeaders(extra: Record<string, string>): Promise<Record<string, string>> {
    const auth = this.auth
      ? await this.auth.headers()
      : this.bearerToken
        ? { authorization: `Bearer ${this.bearerToken}` }
        : {};
    // Non-standard vendor header NAMES come from the profile; values arrive on
    // the connection. We only set a header we were given a value for.
    const vendorHeaders: Record<string, string> = {};
    for (const name of this.profile.requiredHeaders) {
      const supplied = this.extraHeaders[name] ?? this.extraHeaders[name.toLowerCase()];
      if (supplied) vendorHeaders[name] = supplied;
    }
    return {
      'content-type': 'application/fhir+json',
      accept: 'application/fhir+json',
      ...auth,
      ...this.extraHeaders,
      ...vendorHeaders,
      ...extra,
    };
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * One attempt. Returns the response and the parsed body; never throws on an
   * HTTP error status, because the retry loop needs to see it.
   */
  private async attempt(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ res: HttpResponseLike; parsed: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.retry.timeoutMs);
    try {
      const res = await this.doFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      let parsed: unknown;
      if (typeof res.text === 'function') {
        const text = await res.text();
        assertBodySize(text, url);
        parsed = text.trim() === '' ? undefined : safeJson(text);
      } else {
        // Minimal test doubles implement only `json()`.
        try { parsed = await res.json(); } catch { parsed = undefined; }
      }
      return { res, parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<{ status: number; headers: HttpResponseLike['headers']; body: T | undefined }> {
    const url = this.buildUrl(path);
    // The logged/error path is redacted: a FHIR path carries an identifier, and
    // these strings reach structured logs and persisted `last_error` columns.
    // The unredacted `url` is used only for the outbound request and the
    // size-guard message, neither of which is retained.
    const logPath = redactFhirPath(path);
    const policy = { ...this.retry, ...(opts.retry ?? {}) };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    let lastError: unknown;
    let refreshedAuth = false;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      await this.limiter.acquire(this.sleepFn);
      const started = this.nowFn();
      let res: HttpResponseLike;
      let parsed: unknown;
      try {
        const headers = await this.baseHeaders(opts.headers ?? {});
        ({ res, parsed } = await this.attempt(url, method, headers, body));
      } catch (err) {
        lastError = err;
        if (attempt < policy.maxAttempts) {
          await this.sleepFn(backoffDelay(attempt, policy, undefined, Math.random));
          continue;
        }
        throw new FhirClientError(
          `FHIR ${method} ${logPath} failed after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.onRequest?.({ method, path: logPath, status: res.status, attempt, durationMs: this.nowFn() - started, retried: attempt > 1 });

      if (res.ok) return { status: res.status, headers: res.headers, body: parsed as T | undefined };

      // A 401 with a managed auth provider means the cached token went stale.
      // Refresh once, and only once: a second 401 is a permissions problem.
      if (res.status === 401 && this.auth && !refreshedAuth) {
        refreshedAuth = true;
        this.auth.invalidate();
        attempt -= 1;
        continue;
      }

      if (isRetryableStatus(res.status) && attempt < policy.maxAttempts) {
        const retryAfterMs = parseRetryAfter(headerValue(res, 'retry-after'), this.nowFn());
        await this.sleepFn(backoffDelay(attempt, policy, retryAfterMs, Math.random));
        continue;
      }

      const issues = issuesFromBody(parsed);
      const codes = issues.map((i) => i.code);
      const detail = issues.find((i) => i.diagnostics)?.diagnostics;
      throw new FhirClientHttpError(
        `FHIR ${method} ${logPath} → HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status,
        issues.length > 0 ? { resourceType: 'OperationOutcome', issue: [...issues] } : undefined,
        codes,
      );
    }

    throw new FhirClientError(
      `FHIR ${method} ${logPath} failed: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'exhausted')}`,
    );
  }

  /* ------------------------------------------------------------- read ops */

  /** GET a resource by type + id. */
  async get<T extends FhirResource>(resourceType: string, id: string, opts: RequestOptions = {}): Promise<T> {
    const { body } = await this.requestJson<T>('GET', `${resourceType}/${encodeURIComponent(id)}`, opts);
    if (!body) throw new FhirClientError(`FHIR GET ${resourceType}/${id} returned no body`, 200);
    return body;
  }

  /** The FHIR verb name for `get`. */
  async read<T extends FhirResource>(resourceType: string, id: string, opts: RequestOptions = {}): Promise<T> {
    return this.get<T>(resourceType, id, opts);
  }

  /** Search a resource type (query params map to `?k=v&...`). */
  async search<T extends FhirResource>(
    resourceType: string,
    query: Record<string, string> = {},
    opts: RequestOptions = {},
  ): Promise<Bundle> {
    const qs = new URLSearchParams(query).toString();
    const { body } = await this.requestJson<Bundle>('GET', `${resourceType}${qs ? `?${qs}` : ''}`, opts);
    return body ?? { resourceType: 'Bundle', type: 'searchset', entry: [] };
  }

  /**
   * Follow `link[rel=next]` until the search is exhausted or `maxPages` is hit.
   *
   * Bounded on purpose: an EMR that never returns a short page would otherwise
   * keep us reading forever, and a backfill is not allowed to be unbounded.
   */
  async searchAll<T extends FhirResource>(
    resourceType: string,
    query: Record<string, string> = {},
    opts: SearchOptions = {},
  ): Promise<{ resources: T[]; pages: number; truncated: boolean }> {
    const maxPages = opts.maxPages ?? MAX_PAGES_DEFAULT;
    const withHeaders: RequestOptions = opts.headers ? { headers: opts.headers } : {};
    const resources: T[] = [];
    let pages = 0;

    let bundle = await this.search<T>(resourceType, {
      ...query,
      _count: query._count ?? String(this.maxPageSize()),
    }, withHeaders);

    for (;;) {
      pages += 1;
      for (const entry of bundle.entry ?? []) {
        if (entry.resource) resources.push(entry.resource as T);
      }
      const next = nextLink(bundle);
      if (!next || pages >= maxPages) {
        return { resources, pages, truncated: Boolean(next) };
      }
      const path = next.startsWith(this.baseUrl) ? next.slice(this.baseUrl.length + 1) : next;
      const { body } = await this.requestJson<Bundle>('GET', path, withHeaders);
      bundle = body ?? { resourceType: 'Bundle', type: 'searchset', entry: [] };
    }
  }

  /* ------------------------------------------------------------ write ops */

  /**
   * Create or update: a resource with an `id` is PUT, without one it is POST.
   *
   * `ifNoneExist` is what makes a retry safe — the server reconciles on the
   * identifier rather than creating a second copy.
   */
  async push<T extends FhirResource>(
    resource: T,
    opts: { ifNoneExist?: string; ifMatch?: string } = {},
  ): Promise<T> {
    const method = resource.id ? 'PUT' : 'POST';
    const path = resource.id
      ? `${resource.resourceType}/${encodeURIComponent(resource.id)}`
      : resource.resourceType;
    const headers: Record<string, string> = {};
    if (opts.ifNoneExist) headers['if-none-exist'] = opts.ifNoneExist;
    if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    const { body } = await this.requestJson<T>(method, path, {
      body: resource,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return (body ?? resource) as T;
  }

  /** POST a new resource. `ifNoneExist` avoids a duplicate on retry. */
  async create<T extends FhirResource>(resource: T, ifNoneExist?: string): Promise<T> {
    const { id: _ignored, ...rest } = resource as T & { id?: string };
    return this.push(rest as unknown as T, ifNoneExist ? { ifNoneExist } : {});
  }

  /** PUT an existing resource, optionally guarded by `If-Match`. */
  async update<T extends FhirResource>(resource: T, ifMatch?: string): Promise<T> {
    if (!resource.id) throw new FhirClientError('update requires a resource id');
    return this.push(resource, ifMatch ? { ifMatch } : {});
  }

  /** DELETE by type + id. */
  async remove(resourceType: string, id: string): Promise<void> {
    await this.requestJson<unknown>('DELETE', `${resourceType}/${encodeURIComponent(id)}`);
  }

  /** Read a response header from the last call — used for `ETag`. */
  static etag(res: HttpResponseLike): string | undefined {
    return headerValue(res, 'etag');
  }

  /* ------------------------------------------------------------- metadata */

  /** Read the server's CapabilityStatement. */
  async metadata(): Promise<CapabilityStatement> {
    const { body } = await this.requestJson<unknown>('GET', 'metadata');
    if (body === undefined) {
      throw new CapabilityStatementError('capability-statement-empty-body', 'empty-body');
    }
    return parseCapabilityStatement(body);
  }

  /* ----------------------------------------------------------- operations */

  /**
   * Execute an operation (`$export`, `$validate`, `Patient/$everything`).
   *
   * GET when there is no body, POST when there is — which is the distinction
   * FHIR actually makes between a query-style and a payload-style operation.
   */
  async operation(
    operation: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    const path = `${operation}${qs ? `?${qs}` : ''}`;
    const { body: out } = body === undefined
      ? await this.requestJson<unknown>('GET', path)
      : await this.requestJson<unknown>('POST', path, { body });
    return out;
  }

  /** `$validate` a resource. A validation failure is an ANSWER, not a throw. */
  async validate(resource: FhirResource): Promise<OperationOutcome | undefined> {
    try {
      const out = await this.operation(`${resource.resourceType}/$validate`, {}, resource);
      return out && typeof out === 'object' ? (out as OperationOutcome) : undefined;
    } catch (err) {
      return errorToFhirReply(err).outcome;
    }
  }

  /* ---------------------------------------------------------- bulk export */

  /**
   * Start a Bulk Data `$export`. Returns where to poll: the contract is a `202`
   * with `Content-Location`, and we do not assume a `200` with inline data.
   */
  async startExport(req: ExportRequest = {}): Promise<ExportJob> {
    const level = req.level ?? 'Patient';
    const path = level === 'Group' && req.groupId ? `Group/${req.groupId}/$export` : `${level}/$export`;
    const params: Record<string, string> = {};
    if (req.since) params._since = req.since;
    if (req.types?.length) params._type = req.types.join(',');
    if (req.typeFilter?.length) params._typeFilter = req.typeFilter.join(',');
    const qs = new URLSearchParams(params).toString();
    const full = `${path}${qs ? `?${qs}` : ''}`;

    const res = await this.requestJson<unknown>('GET', full);
    if (res.status === 200) {
      // Some servers answer inline; treat the request path as the location.
      return { statusUrl: full };
    }
    const contentLocation = res.headers
      ? headerValue({ ok: true, status: res.status, headers: res.headers, json: async () => undefined }, 'content-location')
      : undefined;
    if (!contentLocation) {
      throw new FhirClientError(`$export returned ${res.status} without a Content-Location`);
    }
    return { statusUrl: contentLocation };
  }

  /** Poll an export job and interpret the manifest. */
  async exportStatus(statusUrl: string): Promise<ExportStatus> {
    const path = statusUrl.startsWith(this.baseUrl) ? statusUrl.slice(this.baseUrl.length + 1) : statusUrl;
    try {
      const { status, headers, body } = await this.requestJson<Record<string, unknown>>('GET', path);
      // A 202 is a LEGITIMATE answer meaning "still working", and `202` is an
      // `ok` status, so it arrives on the success branch rather than as a throw.
      if (status === 202) {
        const progress = headers
          ? headerValue({ ok: true, status, headers, json: async () => undefined }, 'x-progress')
          : undefined;
        return {
          status: 'running',
          ...(progress ? { progress } : {}),
          outputs: [], deleted: [], errors: [],
        };
      }
      const manifest = body ?? {};
      const outputs = Array.isArray(manifest.output)
        ? (manifest.output as Array<{ type?: string; url?: string; count?: number }>)
            .filter((o) => typeof o.url === 'string')
            .map((o) => ({
              type: String(o.type ?? 'unknown'),
              url: String(o.url),
              ...(typeof o.count === 'number' ? { count: o.count } : {}),
            }))
        : [];
      const collect = (key: string) => Array.isArray(manifest[key])
        ? (manifest[key] as Array<{ type?: string; url?: string }>)
            .filter((o) => typeof o.url === 'string')
            .map((o) => ({ type: String(o.type ?? 'unknown'), url: String(o.url) }))
        : [];
      const progress = headers
        ? headerValue({ ok: true, status: 200, headers, json: async () => undefined }, 'x-progress')
        : undefined;
      return {
        status: 'complete',
        ...(progress ? { progress } : {}),
        outputs,
        deleted: collect('deleted'),
        errors: collect('error'),
      };
    } catch (err) {
      // A 202 that arrived as a thrown error on an older server still means
      // "running" — a legitimate state, not a failure.
      if (err instanceof FhirClientError && err.status === 202) {
        return { status: 'running', outputs: [], deleted: [], errors: [] };
      }
      throw err;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body is a real finding (an HTML error page, a proxy). Surface
    // it as undefined rather than throwing a parse error that hides the status.
    return undefined;
  }
}

/** The `link[rel=next]` URL of a bundle, if there is one. */
export function nextLink(bundle: Bundle): string | undefined {
  const link = (bundle as { link?: Array<{ relation?: string; url?: string }> }).link;
  return link?.find((l) => l.relation === 'next' && l.url)?.url;
}

/** Convenience for callers that only want the resources out of one page. */
export function bundleResources<T extends FhirResource>(bundle: Bundle | undefined): T[] {
  return (bundle?.entry ?? [])
    .map((e: BundleEntry) => e.resource)
    .filter((r): r is FhirResource => Boolean(r)) as T[];
}
