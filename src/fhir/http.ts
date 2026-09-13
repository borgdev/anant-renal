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

// Outbound HTTP primitives for the FHIR client (F1.5).
//
// Kept separate from `client.ts` so the auth providers can share the transport
// seam without importing the client (which would be a cycle). Everything here is
// pure or injectable: no module-level state, no ambient clock, no global fetch
// beyond the default.

/** The minimal response shape we depend on. Compatible with the WHATWG Response. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: HeaderReader;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface HeaderReader {
  get(name: string): string | null;
}

/** An injectable transport. Tests supply a fake; production uses global fetch. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return res as unknown as HttpResponseLike;
};

/** Read a header from either a real Headers object or a plain record. */
export function headerValue(res: HttpResponseLike, name: string): string | undefined {
  const h = res.headers;
  if (!h) return undefined;
  const viaGet = h.get(name);
  if (viaGet !== null && viaGet !== undefined) return viaGet;
  for (const [k, v] of Object.entries(h as unknown as Record<string, string>)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}

export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  timeoutMs: 20_000,
};

/**
 * Only 429 and 5xx are retried, plus transport failures. A 4xx is a statement
 * about the request and repeating it verbatim cannot help — a 400 retried three
 * times is three times the load for the same answer.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse `Retry-After` (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

/**
 * Jittered exponential backoff. The jitter is what stops a fleet of workers
 * that were throttled together from retrying together.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  // Full jitter: spread across [0, capped] rather than a fixed ±10%.
  return Math.round(random() * capped);
}

/**
 * A token-bucket limiter. Vendors throttle per app, so the limiter is per
 * connection rather than per process.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefillMs;
    if (elapsed <= 0) return;
    const perMs = this.requestsPerMinute / 60_000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * perMs);
    this.lastRefillMs = t;
  }

  /** Milliseconds to wait before a request may proceed. 0 means go now. */
  delayMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const perMs = this.requestsPerMinute / 60_000;
    if (perMs <= 0) return 60_000;
    return Math.ceil((1 - this.tokens) / perMs);
  }

  /** Consume one token. Returns false when the caller should have waited. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async acquire(sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    for (;;) {
      const wait = this.delayMs();
      if (wait <= 0 && this.tryAcquire()) return;
      await sleep(wait > 0 ? wait : 1);
    }
  }

  /** For tests and the health panel. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap on a response body we will parse. A FHIR server that returns a 2 GB
 * document should be a loud failure, not an out-of-memory crash.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function assertBodySize(text: string, url: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new Error(`fhir-response-too-large: ${bytes} bytes from ${url} exceeds ${MAX_RESPONSE_BYTES}`);
  }
}

/** Query parameters that are safe to log: paging and cursors, never identifiers. */
const SAFE_QUERY_PARAMS = ['_count', '_page', '_sort', '_offset', '_since', '_type', '_typeFilter'];

/**
 * Redact an outbound FHIR path for logging.
 *
 * A path routinely carries an identifier (`Patient/f1-pt-0001`) and a search
 * query can carry one too (`Observation?patient=Patient/123&code=K`). Either in
 * a structured log — or in an error string that gets persisted into a
 * `last_error` column — is PHI in a place it should not be.
 *
 * We keep the SHAPE (which resource, which operation, how it was paged) and drop
 * the values. A name segment is redacted; an operation segment (`$export`) is
 * kept, because it names a capability rather than a subject.
 */
export function redactFhirPath(path: string): string {
  const [rawPath = '', query] = path.split('?');
  const segments = rawPath.split('/').filter((s) => s.length > 0);
  const redacted = segments
    .map((seg, i) => (i === 0 || seg.startsWith('$') ? seg : '{id}'))
    .join('/');
  if (query === undefined) return redacted;
  const params = new URLSearchParams(query);
  const kept = SAFE_QUERY_PARAMS
    .map((key) => {
      const value = params.get(key);
      return value === null ? undefined : `${key}=${value}`;
    })
    .filter((s): s is string => s !== undefined);
  return kept.length > 0 ? `${redacted}?${kept.join('&')}` : `${redacted}?{redacted}`;
}
