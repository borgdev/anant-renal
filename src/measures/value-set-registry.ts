// M20: Value Set Registry.
//
// Strategy (fail-honest, degrade gracefully):
//   1. If the FHIR Library carries an inline expansion for the value set,
//      use it.  (Some measure packages do this; most do not.)
//   2. Else if a VSAC UMLS API key is configured, expand via VSAC's FHIR
//      $expand endpoint.  Result is cached to disk with vsacExpansionDate.
//   3. Else mark the ValueSet as 'unresolved' with a specific reason. Any
//      measure that depends on an unresolved ValueSet is marked unevaluable
//      by the evaluator \u2014 with the missing OID and remediation instructions
//      returned to the operator, never a silently-wrong answer.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { StoredValueSet, Coding, ISODate } from './types.js';

function nowIso(): ISODate { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

/** Try to pull an OID out of a canonical URL. */
export function extractOid(url: string): string | undefined {
  const m = /(?:\/ValueSet\/|urn:oid:)(\d+(?:\.\d+)+)/.exec(url);
  return m ? m[1] : undefined;
}

export interface VSACConfig {
  /** UMLS API key. If unset, we skip VSAC and mark value sets unresolved. */
  apiKey?: string;
  /** Base URL, default 'https://cts.nlm.nih.gov/fhir'. */
  baseUrl?: string;
  /** Profile parameter, e.g. 'eCQM Update 2026-05-08'. Optional. */
  profile?: string;
}

export class ValueSetRegistry {
  private readonly cacheDir: string;
  private readonly vsac: VSACConfig;
  private readonly memo = new Map<string, StoredValueSet>();

  constructor(cacheDir: string, vsac: VSACConfig = {}) {
    this.cacheDir = cacheDir;
    this.vsac = vsac;
    mkdirSync(cacheDir, { recursive: true });
  }

  private cachePath(url: string): string {
    return join(this.cacheDir, `${sha16(url)}.json`);
  }

  /** Register an inline expansion (from a Measure/Library's contained ValueSet resource). */
  registerInline(url: string, source: 'inline-measure' | 'inline-library', title: string | undefined, version: string | undefined, codes: Coding[]): StoredValueSet {
    const record: StoredValueSet = {
      url,
      ...(extractOid(url) ? { oid: extractOid(url)! } : {}),
      ...(title ? { title } : {}),
      ...(version ? { version } : {}),
      source,
      expansion: { date: nowIso(), total: codes.length, codes },
    };
    this.memo.set(url, record);
    writeFileSync(this.cachePath(url), JSON.stringify(record, null, 2));
    return record;
  }

  /** Load any previously cached expansion for a URL. */
  private loadCached(url: string): StoredValueSet | null {
    const p = this.cachePath(url);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as StoredValueSet; }
    catch { return null; }
  }

  /** Resolve a value set URL. Returns cached, then tries VSAC, then unresolved. */
  async resolve(url: string): Promise<StoredValueSet> {
    if (this.memo.has(url)) return this.memo.get(url)!;
    const cached = this.loadCached(url);
    if (cached && cached.source !== 'unresolved') {
      this.memo.set(url, cached);
      return cached;
    }
    if (this.vsac.apiKey) {
      const vsacResult = await this.expandFromVsac(url);
      if (vsacResult) {
        this.memo.set(url, vsacResult);
        writeFileSync(this.cachePath(url), JSON.stringify(vsacResult, null, 2));
        return vsacResult;
      }
    }
    const unresolved: StoredValueSet = {
      url,
      ...(extractOid(url) ? { oid: extractOid(url)! } : {}),
      source: 'unresolved',
      expansion: { date: nowIso(), total: 0, codes: [] },
      unresolvedReason: this.vsac.apiKey
        ? 'VSAC expansion returned no codes; verify OID/profile'
        : 'No VSAC API key configured. Set VSAC_UMLS_API_KEY to enable NLM VSAC expansion.',
    };
    this.memo.set(url, unresolved);
    writeFileSync(this.cachePath(url), JSON.stringify(unresolved, null, 2));
    return unresolved;
  }

  private async expandFromVsac(url: string): Promise<StoredValueSet | null> {
    const base = this.vsac.baseUrl ?? 'https://cts.nlm.nih.gov/fhir';
    const oid = extractOid(url);
    if (!oid) return null;
    const auth = Buffer.from(`apikey:${this.vsac.apiKey!}`).toString('base64');
    const params = new URLSearchParams({ url: `http://cts.nlm.nih.gov/fhir/ValueSet/${oid}` });
    if (this.vsac.profile) params.set('profile', this.vsac.profile);
    const endpoint = `${base}/ValueSet/$expand?${params}`;
    const res = await fetch(endpoint, { headers: { 'authorization': `Basic ${auth}`, 'accept': 'application/fhir+json' } });
    if (!res.ok) return null;
    const j = await res.json() as {
      expansion?: { timestamp?: string; total?: number; contains?: { system: string; code: string; display?: string; version?: string }[]; identifier?: string };
      version?: string;
      title?: string;
    };
    if (!j.expansion?.contains) return null;
    return {
      url,
      oid,
      ...(j.title ? { title: j.title } : {}),
      ...(j.version ? { version: j.version } : {}),
      source: 'vsac',
      expansion: {
        date: j.expansion.timestamp ?? nowIso(),
        total: j.expansion.total ?? j.expansion.contains.length,
        codes: j.expansion.contains.map((c) => ({ system: c.system, code: c.code, ...(c.display ? { display: c.display } : {}), ...(c.version ? { version: c.version } : {}) })),
      },
      ...(j.expansion.identifier ? { vsac: { expansionIdentifier: j.expansion.identifier, ...(this.vsac.profile ? { profile: this.vsac.profile } : {}) } } : {}),
    };
  }

  /** All cached (loaded) value sets. */
  list(): StoredValueSet[] {
    if (!existsSync(this.cacheDir)) return [];
    const out: StoredValueSet[] = [];
    for (const f of readdirSync(this.cacheDir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(readFileSync(join(this.cacheDir, f), 'utf8')) as StoredValueSet); }
      catch { /* skip */ }
    }
    return out;
  }
}
