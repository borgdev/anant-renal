/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

// Outbound FHIR client (Phase 5 EHR-bridge). Read/search/push against a remote
// FHIR R4 server for twin-mode reconciliation. Injectable transport for tests;
// uses global fetch by default.

import type { Bundle, FhirResource } from './types.js';

export interface FhirClientOptions {
  baseUrl: string;
  bearerToken?: string;
  headers?: Record<string, string>;
  /** HTTP transport for tests. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export class FhirClientError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'FhirClientError'; }
}

export class FhirClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly doFetch: NonNullable<FhirClientOptions['fetch']>;

  constructor(opts: FhirClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.bearerToken = opts.bearerToken;
    this.extraHeaders = opts.headers ?? {};
    this.doFetch = opts.fetch ?? (async (url, init) => {
      const res = await fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/fhir+json',
      accept: 'application/fhir+json',
      ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      ...this.extraHeaders,
      ...extra,
    };
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.doFetch(`${this.baseUrl}/${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new FhirClientError(`FHIR ${method} ${path} → HTTP ${res.status}`, res.status);
    return res.json();
  }

  /** GET a resource by type + id. */
  async get<T extends FhirResource>(resourceType: string, id: string): Promise<T> {
    return (await this.req('GET', `${resourceType}/${encodeURIComponent(id)}`)) as T;
  }

  /** Search a resource type (query params map to `?k=v&...`). */
  async search<T extends FhirResource>(resourceType: string, query: Record<string, string> = {}): Promise<Bundle> {
    const qs = new URLSearchParams(query).toString();
    return (await this.req('GET', `${resourceType}${qs ? `?${qs}` : ''}`)) as Bundle;
  }

  /** Push (create/update) a resource; PUT by id when present, else POST. */
  async push<T extends FhirResource>(resource: T): Promise<T> {
    const method = resource.id ? 'PUT' : 'POST';
    const path = resource.id ? `${resource.resourceType}/${encodeURIComponent(resource.id)}` : resource.resourceType;
    return (await this.req(method, path, resource)) as T;
  }

  /** Execute an operation (e.g. `$export`, `$validate`). */
  async operation(operation: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    return this.req('GET', `${operation}${qs ? `?${qs}` : ''}`, body);
  }
}
