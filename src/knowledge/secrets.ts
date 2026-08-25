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

// Secret registry — file-backed with restrictive permissions. Values are stored
// unencrypted (per environment; production deployments should mount an encrypted
// volume or delegate to a KMS). We keep an audit trail of who set what and when.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretRecord {
  namespace: string; // usually sourceId
  key: string;       // e.g. UMLS_API_KEY
  hasValue: boolean; // never expose value in listings
  updatedAt: string;
  updatedBy?: string;
}

interface SecretsFile {
  secrets: Record<string, string>;         // "<namespace>::<key>" → value
  audit: SecretRecord[];
}

export class SecretRegistry {
  private readonly file: string;
  private data: SecretsFile = { secrets: {}, audit: [] };

  constructor(storeDir: string) {
    mkdirSync(storeDir, { recursive: true });
    this.file = join(storeDir, 'secrets.json');
    this.load();
  }
  private load(): void {
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as SecretsFile;
    }
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    try { chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
  }
  set(namespace: string, key: string, value: string, updatedBy?: string): void {
    this.data.secrets[`${namespace}::${key}`] = value;
    this.data.audit = this.data.audit.filter((r) => !(r.namespace === namespace && r.key === key));
    const rec: SecretRecord = { namespace, key, hasValue: value.length > 0, updatedAt: new Date().toISOString() };
    if (updatedBy) rec.updatedBy = updatedBy;
    this.data.audit.push(rec);
    this.save();
  }
  get(namespace: string, key: string): string | undefined {
    return this.data.secrets[`${namespace}::${key}`] ?? this.data.secrets[`__global__::${key}`];
  }
  bundleFor(namespace: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.data.secrets)) {
      const [ns, name] = k.split('::');
      if (ns === namespace || ns === '__global__') out[name!] = v;
    }
    return out;
  }
  list(namespace?: string): SecretRecord[] {
    return this.data.audit.filter((r) => !namespace || r.namespace === namespace || r.namespace === '__global__');
  }
  clear(namespace: string, key: string): void {
    delete this.data.secrets[`${namespace}::${key}`];
    this.data.audit = this.data.audit.filter((r) => !(r.namespace === namespace && r.key === key));
    this.save();
  }
}
