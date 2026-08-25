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

// M20: Real CQL evaluator. Wraps cql-execution + cql-exec-fhir to run the
// actual measure logic that CMS publishes \u2014 no hand-transcribed rules.
//
// Behavior:
//   * Loads the primary Library ELM (referenced by FHIR Measure.library)
//     plus every transitive Library dependency from our on-disk store.
//   * Wires a CodeService backed by our ValueSetRegistry (inline-first, VSAC
//     when configured, unresolved otherwise).
//   * Uses cql-exec-fhir PatientSource to iterate patients in a FHIR bundle.
//   * For each Measure.group.population.criteria, evaluates the referenced
//     expression from the primary library and records raw + membership.
//   * Returns a fully-provenanced EvaluationResult.
//
// Non-goals: we do not translate CQL text \u2192 ELM. The upstream repo ships
// pre-compiled ELM JSON in every Library.content (contentType application/elm+json).

import { readFileSync } from 'node:fs';
import type { StoredMeasure, StoredLibrary, StoredValueSet, EvaluationInput, EvaluationResult, PopulationCode, PopulationResult, UpstreamRef, ISODate } from './types.js';
import { ValueSetRegistry } from './value-set-registry.js';
import cqlPkg from 'cql-execution';
import cqlFhirPkg from 'cql-exec-fhir';

const { Library, Repository, Executor, CodeService, Code, ValueSet: CqlValueSet } = cqlPkg;
const { PatientSource } = cqlFhirPkg;

function nowIso(): ISODate { return new Date().toISOString(); }

/** Build a Repository from a collection of ELM JSON docs keyed by library name/version. */
function buildRepository(elmDocs: { name: string; version: string; elm: unknown }[]): unknown {
  // cql-execution's Repository takes { "LibraryName": elm } or { "LibraryName-Version": elm }.
  // We register both name and name-version so cross-library includes resolve deterministically.
  const libsByKey: Record<string, unknown> = {};
  for (const d of elmDocs) {
    const versionSanitized = d.version.replace(/\./g, '-');
    libsByKey[d.name] = d.elm;
    libsByKey[`${d.name}-${d.version}`] = d.elm;
    libsByKey[`${d.name}-${versionSanitized}`] = d.elm;
  }
  return new Repository(libsByKey);
}

/** Build a CodeService (used by CQL "in ValueSet" / "in CodeSystem" checks). */
function buildCodeService(valueSets: StoredValueSet[]): unknown {
  // cql-execution's CodeService accepts the shape { [vsUrl]: { [version]: Code[] } }
  // where each Code exposes code/system/version/display fields. Since our concrete
  // shape doesn't line up with the library's internal ValueSetDictionary type,
  // we build the map dynamically and let the runtime consume it (any-cast at the
  // constructor boundary only).
  const map: Record<string, Record<string, unknown[]>> = {};
  for (const vs of valueSets) {
    const version = vs.version ?? 'default';
    map[vs.url] = map[vs.url] ?? {};
    const codeArr: unknown[] = vs.expansion.codes.map((c) => new Code(c.code, c.system, c.version ?? undefined, c.display ?? undefined));
    map[vs.url]![version] = codeArr;
  }
  return new (CodeService as unknown as new (m: unknown) => unknown)(map);
}

interface EvaluatorOpts {
  measures: StoredMeasure[];
  libraries: StoredLibrary[];
  valueSetRegistry: ValueSetRegistry;
}

export class MeasureEvaluator {
  private readonly measuresById = new Map<string, StoredMeasure>();
  private readonly librariesByName = new Map<string, StoredLibrary>();
  private readonly librariesByUrl = new Map<string, StoredLibrary>();
  private readonly vsr: ValueSetRegistry;

  constructor(opts: EvaluatorOpts) {
    for (const m of opts.measures) {
      this.measuresById.set(m.id, m);
      this.measuresById.set(m.cmsId, m);
    }
    for (const l of opts.libraries) {
      this.librariesByName.set(l.name, l);
      this.librariesByName.set(`${l.name}/${l.version}`, l);
      if (l.url) this.librariesByUrl.set(l.url, l);
    }
    this.vsr = opts.valueSetRegistry;
  }

  listMeasures(): StoredMeasure[] { return [...new Set(this.measuresById.values())]; }

  /** Resolve a measure id — accepts the canonical id (`ecqm:...`), a plain CMS id
   * (`CMS165...`), or a `cms:`-prefixed id. Matching ignores case and punctuation
   * so `M21Basic`, `M21-BASIC`, and `cms:M21Basic` all resolve. */
  getMeasure(id: string): StoredMeasure | undefined {
    const direct = this.measuresById.get(id);
    if (direct) return direct;
    // catalog-style prefix: 'cms:CMS165FHIRControllingHighBloodPressure' → 'CMS165FHIRControllingHighBloodPressure'
    if (id.startsWith('cms:')) {
      const viaStrip = this.measuresById.get(id.slice(4));
      if (viaStrip) return viaStrip;
    }
    const stripped = id.startsWith('cms:') ? id.slice(4) : id;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(stripped);
    for (const m of this.measuresById.values()) {
      if (norm(m.cmsId) === target) return m;
    }
    return undefined;
  }

  /** Resolve the primary + transitive libraries the measure needs. */
  private resolveLibraries(measure: StoredMeasure): StoredLibrary[] {
    const chosen = new Map<string, StoredLibrary>();
    const queue: string[] = [...measure.libraryRefs];
    while (queue.length > 0) {
      const ref = queue.shift()!;
      let lib = this.librariesByUrl.get(ref);
      if (!lib) {
        // Sometimes Measure.library is a bare name or a Library/xxx reference; try last-segment lookup.
        const tail = ref.split('/').pop() ?? ref;
        lib = this.librariesByName.get(tail) ?? this.librariesByName.get(tail.split('|')[0]!);
      }
      if (!lib || chosen.has(lib.id)) continue;
      chosen.set(lib.id, lib);
      // Follow transitive includes from ELM
      const includes = extractIncludes(lib.content.elmJson);
      for (const inc of includes) {
        const found = this.librariesByName.get(`${inc.name}/${inc.version ?? ''}`) ?? this.librariesByName.get(inc.name);
        if (found && !chosen.has(found.id)) queue.push(found.name);
      }
    }
    return [...chosen.values()];
  }

  /** Pre-resolve every value set referenced by the given libraries. */
  private async resolveValueSets(libs: StoredLibrary[]): Promise<StoredValueSet[]> {
    const urls = new Set<string>();
    for (const l of libs) for (const u of l.valueSetRefs) urls.add(u);
    const out: StoredValueSet[] = [];
    for (const u of urls) out.push(await this.vsr.resolve(u));
    return out;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const measure = this.measuresById.get(input.measureId);
    if (!measure) throw new Error(`unknown measure: ${input.measureId}`);

    const libs = this.resolveLibraries(measure);
    if (libs.length === 0) throw new Error(`no libraries resolved for measure ${measure.id}. Measure.library=${JSON.stringify(measure.libraryRefs)}`);

    // Primary library = first library ref
    const primary = libs.find((l) => measure.libraryRefs[0]?.endsWith(l.name) || measure.libraryRefs[0]?.endsWith(`${l.name}/${l.version}`)) ?? libs[0]!;
    if (!primary.content.elmJson) throw new Error(`primary library ${primary.id} has no ELM JSON content`);

    const valueSets = await this.resolveValueSets(libs);
    const unresolved = valueSets.filter((v) => v.source === 'unresolved');
    if (unresolved.length > 0) {
      // Continue evaluation \u2014 CQL will treat missing codes as empty sets \u2014 but flag prominently.
      // Alternative could be to hard-fail; we choose "evaluate + flag" so operators see which VSets need attention.
    }

    // Build ELM docs list, filter to those with ELM JSON present
    const elmDocs = libs.filter((l) => l.content.elmJson).map((l) => ({ name: l.name, version: l.version, elm: l.content.elmJson }));

    const repo = buildRepository(elmDocs);
    // cql-execution Library constructor takes (elmJsonOrIdentifier, repository)
    const cqlLibrary = new Library(primary.content.elmJson, repo);
    const codeService = buildCodeService(valueSets);

    // Determine measurement period
    const measurementPeriod = input.measurementPeriod ?? {
      start: measure.effectivePeriod?.start ?? new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
      end: measure.effectivePeriod?.end ?? new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10),
    };

    // Wrap bundle for cql-exec-fhir
    const bundleForCql = normalizeToBundle(input.bundle);
    const patientSource = PatientSource.FHIRv401();
    patientSource.loadBundles([bundleForCql]);

    const executor = new (Executor as unknown as new (l: unknown, cs: unknown, params: Record<string, unknown>) => { exec(ps: unknown): Promise<{ patientResults?: Record<string, Record<string, unknown>> }> })(
      cqlLibrary,
      codeService,
      { 'Measurement Period': cqlIntervalFrom(measurementPeriod.start, measurementPeriod.end) },
    );
    const results = await executor.exec(patientSource);

    // results.patientResults: { [patientId]: { [expressionName]: value } }
    const patientEval: EvaluationResult['patients'] = [];
    for (const [patientId, exprMap] of Object.entries(results.patientResults ?? {})) {
      const populations: PopulationResult[] = [];
      const group = (measure.raw as { group?: { population?: { code?: { coding?: { code: string }[] }; criteria?: { expression?: string } }[] }[] }).group?.[0];
      for (const pop of group?.population ?? []) {
        const code = pop.code?.coding?.[0]?.code as PopulationCode | undefined;
        const exprName = pop.criteria?.expression;
        if (!code || !exprName) continue;
        const raw = (exprMap as Record<string, unknown>)[exprName];
        populations.push({
          code,
          criteriaExpression: exprName,
          raw,
          member: interpretMembership(raw),
        });
      }
      patientEval.push({
        patientId,
        populations,
        met: computeMet(populations),
      });
    }

    return {
      measureId: measure.id,
      measureVersion: measure.version,
      cmsId: measure.cmsId,
      measurementPeriod,
      evaluatedAt: nowIso(),
      patients: patientEval,
      provenance: {
        measure: measure.upstream,
        libraries: libs.map((l) => l.upstream),
        valueSetExpansionsAsOf: valueSets.reduce((max, v) => v.expansion.date > max ? v.expansion.date : max, ''),
        valueSetSources: valueSets.map((v) => ({ url: v.url, source: v.source })),
      },
    };
  }
}

// -------- Helpers --------

function extractIncludes(elm: unknown): { name: string; version?: string }[] {
  const e = elm as { library?: { includes?: { def?: { path?: string; localIdentifier?: string; version?: string }[] } } };
  const defs = e?.library?.includes?.def ?? [];
  const out: { name: string; version?: string }[] = [];
  for (const d of defs) {
    const nm = d.localIdentifier ?? d.path;
    if (nm) out.push({ name: nm, ...(d.version ? { version: d.version } : {}) });
  }
  return out;
}

function normalizeToBundle(input: unknown): unknown {
  const b = input as { resourceType?: string; entry?: unknown[] };
  if (b?.resourceType === 'Bundle' && Array.isArray(b.entry)) return b;
  if (Array.isArray(input)) return { resourceType: 'Bundle', type: 'collection', entry: (input as unknown[]).map((r) => ({ resource: r })) };
  throw new Error('Bundle must be FHIR Bundle or an array of resources');
}

function cqlIntervalFrom(startIso: string, endIso: string): unknown {
  // cql-execution's DateTime + Interval — accept the simpler shape and let the runtime coerce.
  return { start: startIso, end: endIso };
}

function interpretMembership(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'number') return raw > 0;
  if (typeof raw === 'object') return Object.keys(raw as object).length > 0;
  return Boolean(raw);
}

function computeMet(pops: PopulationResult[]): boolean | null {
  const byCode = new Map<PopulationCode, boolean>();
  for (const p of pops) byCode.set(p.code, p.member);
  const denom = byCode.get('denominator') === true;
  const denomExcl = byCode.get('denominator-exclusion') === true;
  const denomException = byCode.get('denominator-exception') === true;
  const num = byCode.get('numerator') === true;
  const numExcl = byCode.get('numerator-exclusion') === true;
  const inDenom = denom && !denomExcl;
  if (!inDenom) return null;
  if (num && !numExcl) return true;
  if (denomException) return null; // excluded from performance calc
  return false;
}

/** Convenience: load a bundle from a local file. */
export function loadBundleFromFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
