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

/**
 * F3 — patient & resource identity resolution.
 *
 * This module exists to prevent ONE class of harm: writing clinical data against
 * the wrong patient. Everything else about it is bookkeeping.
 *
 * The shape of the problem is that an EMR and the harness name the same person
 * differently. The EMR says `Patient/e63a…` with an MRN in *its* identifier
 * system; we say `f1-pt-0001`. Nothing in either id tells you they are the same
 * human. So we carry an explicit, auditable cross-reference, and we make the
 * write path refuse rather than guess.
 *
 * THREE RULES, in order of importance:
 *
 * 1. **A fuzzy match NEVER auto-applies.** Resemblance is not identity. A
 *    plausible-looking link between two similar people is worse than no link,
 *    because the clinical data then flows confidently to the wrong chart.
 * 2. **Ambiguity is an outcome, not an error.** Two candidates is a real
 *    answer — it means a human must decide — and it must block the write, not
 *    raise a 500 that someone retries until it happens to match.
 * 3. **Every link records HOW it was made.** A link a human verified and a link
 *    inferred from a name and a birth date are not the same evidence, and the
 *    console has to be able to say which one it is holding.
 */
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------ identifier systems */

export type IdentifierKind = 'mrn' | 'npi' | 'ssn' | 'oid' | 'emr-patient-id' | 'dl' | 'other';
export type IdentifiedEntity = 'patient' | 'practitioner' | 'organization' | 'device';

export interface IdentifierSystem {
  system: string;
  kind: IdentifierKind;
  entityKind: IdentifiedEntity;
  /**
   * Authoritative means a human or a registration system vouched for this
   * identifier. A match on an authoritative system is a fact; a match anywhere
   * else is at best a lead.
   */
  authoritative: boolean;
  label: string;
}

/**
 * Seeded systems. Deliberately small — this is a registry you extend per
 * connection, not a catalogue of every URI in healthcare.
 */
export const DEFAULT_IDENTIFIER_SYSTEMS: readonly IdentifierSystem[] = [
  { system: 'urn:mrn', kind: 'mrn', entityKind: 'patient', authoritative: true, label: 'Medical record number (unqualified)' },
  { system: 'urn:oid:2.16.840.1.113883.4.1', kind: 'ssn', entityKind: 'patient', authoritative: true, label: 'US Social Security number' },
  { system: 'http://hl7.org/fhir/sid/us-npi', kind: 'npi', entityKind: 'practitioner', authoritative: true, label: 'US National Provider Identifier' },
  { system: 'urn:ananthealth:emr-patient-id', kind: 'emr-patient-id', entityKind: 'patient', authoritative: true, label: "The EMR's own Patient.id" },
  { system: 'urn:ananthealth:local-patient-id', kind: 'emr-patient-id', entityKind: 'patient', authoritative: false, label: 'Our local patient id' },
];

/** Durable, extensible `system → { kind, entityKind, authoritative }` map. */
export class IdentifierSystemRegistry {
  private readonly bySystem = new Map<string, IdentifierSystem>();

  constructor(seed: readonly IdentifierSystem[] = DEFAULT_IDENTIFIER_SYSTEMS) {
    for (const entry of seed) this.bySystem.set(entry.system, entry);
  }

  register(entry: IdentifierSystem): IdentifierSystem {
    if (!entry.system) throw new Error('identifier-system-system-required');
    this.bySystem.set(entry.system, entry);
    return entry;
  }

  /** Register an assigner OID for a specific connection, e.g. an Epic MRN namespace. */
  registerOid(oid: string, opts: { entityKind?: IdentifiedEntity; authoritative?: boolean; label?: string } = {}): IdentifierSystem {
    return this.register({
      system: `urn:oid:${oid.replace(/^urn:oid:/, '')}`,
      kind: 'oid',
      entityKind: opts.entityKind ?? 'patient',
      authoritative: opts.authoritative ?? true,
      label: opts.label ?? `Assigner OID ${oid}`,
    });
  }

  lookup(system: string): IdentifierSystem | undefined {
    return this.bySystem.get(system);
  }

  isAuthoritative(system: string): boolean {
    return this.bySystem.get(system)?.authoritative === true;
  }

  systems(): IdentifierSystem[] {
    return [...this.bySystem.values()];
  }

  /**
   * `FhirCtx.identifierSystems` — declared in `types.ts` and, before F3, never
   * populated. `system → the index path a Reference resolves to` is not
   * expressible as a flat string map, so this reports the systems we own and the
   * caller supplies the id.
   */
  toCtxMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.systems()) out[entry.system] = entry.label;
    return out;
  }
}

/* --------------------------------------------------------------- normalisation */

/**
 * The comparison form for a name. Prefixes, punctuation, case and diacritics
 * are noise; a hyphen in "O'Brien-Smith" must not make it a different person.
 */
export function normaliseName(value: string | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\.?\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits only — an MRN comparison must not care about dashes or spaces. */
export function normaliseIdentifier(value: string | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase().replace(/[\s-]+/g, '');
}

export interface PatientDemographics {
  family?: string;
  given?: string;
  birthDate?: string;
  sex?: string;
  /** MRN as it appears on the incoming resource. */
  mrn?: string;
  /** Any other `identifier` values, kept as `system|value` for exact matching. */
  identifiers?: Array<{ system: string; value: string }>;
}

/** Read the demographics + identifiers off a FHIR Patient (loose R4 subset). */
export function demographicsFromPatient(patient: unknown): PatientDemographics {
  const p = (patient ?? {}) as {
    name?: Array<{ family?: string; given?: string[] }>;
    birthDate?: string;
    gender?: string;
    identifier?: Array<{ system?: string; value?: string }>;
  };
  const name = p.name?.[0];
  const identifiers = (p.identifier ?? [])
    .filter((i): i is { system: string; value: string } => typeof i?.system === 'string' && typeof i?.value === 'string')
    .map((i) => ({ system: i.system, value: i.value }));
  return {
    ...(name?.family ? { family: name.family } : {}),
    ...(name?.given?.[0] ? { given: name.given[0] } : {}),
    ...(p.birthDate ? { birthDate: p.birthDate } : {}),
    ...(p.gender ? { sex: p.gender } : {}),
    ...(identifiers.length > 0 ? { identifiers } : {}),
  };
}

/* ----------------------------------------------------------------- the ladder */

export type IdentityMethod = 'exact-identifier' | 'cross-reference' | 'demographics' | 'fuzzy';
export type IdentityStatus = 'resolved' | 'ambiguous' | 'unresolved';

export interface IdentityCandidate {
  localPatientId: string;
  confidence: number;
  method: IdentityMethod;
  /** Why this candidate was proposed — shown to the human who has to decide. */
  reasons: string[];
}

export interface IdentityResolution {
  status: IdentityStatus;
  /** Set only when `status === 'resolved'`. */
  localPatientId?: string;
  confidence?: number;
  method?: IdentityMethod;
  candidates: IdentityCandidate[];
  reasons: string[];
  /**
   * True whenever the write path must refuse. `ambiguous` and `unresolved` are
   * both refusals — one needs a decision, the other needs data.
   */
  blocksWrite: boolean;
}

export interface LocalPatientDemographics extends PatientDemographics {
  localPatientId: string;
  /** Prior links we already hold for this patient. */
  crossReferences?: Array<{ remoteSystem: string; remotePatientId: string; verified: boolean }>;
}

export interface IdentityResolveOptions {
  /** Below this, a match is not usable for a write. */
  minConfidence?: number;
  /** Turn off demographic inference entirely (a pure identifier-only deployment). */
  allowDemographics?: boolean;
  /** Candidates within this distance of the best are treated as a tie. */
  ambiguityMargin?: number;
  /** Optional sink so an ambiguous outcome becomes a human task. */
  onAmbiguous?: (resolution: IdentityResolution) => void;
}

export const IDENTITY_MIN_CONFIDENCE = 0.9;
export const IDENTITY_AMBIGUITY_MARGIN = 0.05;
export const IDENTITY_DEMOGRAPHIC_CONFIDENCE = 0.95;
export const IDENTITY_FUZZY_CEILING = 0.9;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** 0..1 similarity between two names, order-insensitive. */
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Compare the sorted token sets so "Smith John" matches "john smith".
  const ta = na.split(' ').sort().join(' ');
  const tb = nb.split(' ').sort().join(' ');
  if (ta === tb) return 1;
  const longest = Math.max(ta.length, tb.length);
  return Math.max(0, 1 - levenshtein(ta, tb) / longest);
}

/**
 * Birth dates: exact is a match, a transposed day/month is a plausible
 * transcription error, and anything else is not evidence of anything.
 */
export function birthDateAgreement(a: string | undefined, b: string | undefined): { points: number; reason?: string } {
  if (!a || !b) return { points: 0 };
  if (a === b) return { points: 1, reason: 'birth date exact' };
  const digits = (s: string) => s.replace(/\D/g, '');
  if (digits(a) === digits(b)) return { points: 1, reason: 'birth date exact (formatting differs)' };
  const [ay, am, ad] = a.split('-');
  const [by, bm, bd] = b.split('-');
  if (ay && by && ay === by) {
    if (am === bd && ad === bm) return { points: 0.5, reason: 'birth date day/month transposed' };
    if (am === bm) return { points: 0.3, reason: 'birth year and month agree' };
    return { points: 0.2, reason: 'birth year agrees' };
  }
  return { points: 0 };
}

/**
 * Resolve an incoming identity against the local population.
 *
 * Candidates come back in descending confidence. A candidate produced by
 * FUZZY evidence is capped below the auto-apply ceiling, so it can be shown to
 * a human but can never satisfy `status: 'resolved'` on its own.
 */
export function resolvePatientIdentity(
  incoming: PatientDemographics,
  population: readonly LocalPatientDemographics[],
  registry: IdentifierSystemRegistry,
  opts: IdentityResolveOptions = {},
): IdentityResolution {
  const minConfidence = opts.minConfidence ?? IDENTITY_MIN_CONFIDENCE;
  const margin = opts.ambiguityMargin ?? IDENTITY_AMBIGUITY_MARGIN;
  const allowDemographics = opts.allowDemographics ?? true;

  const reasons: string[] = [];
  const incomingIdentifiers = (incoming.identifiers ?? []).map((i) => ({
    system: i.system,
    value: normaliseIdentifier(i.value),
    authoritative: registry.isAuthoritative(i.system),
  }));

  const ranked: IdentityCandidate[] = [];

  for (const local of population) {
    const localReasons: string[] = [];

    // (a) exact identifier on an authoritative system → 1.0
    const localIdentifiers = (local.identifiers ?? []).map((i) => ({
      system: i.system,
      value: normaliseIdentifier(i.value),
      authoritative: registry.isAuthoritative(i.system),
    }));
    const exact = incomingIdentifiers.find(
      (a) => a.authoritative && localIdentifiers.some((b) => b.authoritative && b.system === a.system && b.value === a.value && a.value.length > 0),
    );
    if (exact) {
      ranked.push({ localPatientId: local.localPatientId, confidence: 1, method: 'exact-identifier', reasons: [`identifier ${exact.system}=${exact.value}`] });
      continue;
    }

    // (b) a cross-reference we already hold → 1.0
    const linked = (local.crossReferences ?? []).find((x) =>
      incomingIdentifiers.some((a) => a.system === x.remoteSystem && a.value === normaliseIdentifier(x.remotePatientId)),
    );
    if (linked) {
      ranked.push({
        localPatientId: local.localPatientId,
        confidence: 1,
        method: 'cross-reference',
        reasons: [`existing link ${linked.remoteSystem}=${linked.remotePatientId}${linked.verified ? ' (verified)' : ' (unverified)'}`],
      });
      continue;
    }

    // (c)/(d) demographics and name similarity
    if (!allowDemographics) continue;
    const family = nameSimilarity(incoming.family ?? '', local.family ?? '');
    const given = nameSimilarity(incoming.given ?? '', local.given ?? '');
    const dob = birthDateAgreement(incoming.birthDate, local.birthDate);
    const sexAgrees = incoming.sex && local.sex ? incoming.sex.toLowerCase() === local.sex.toLowerCase() : undefined;

    if (family === 1) localReasons.push('family name exact');
    else if (family >= 0.8) localReasons.push(`family name similar (${family.toFixed(2)})`);
    if (given === 1) localReasons.push('given name exact');
    else if (given >= 0.8) localReasons.push(`given name similar (${given.toFixed(2)})`);
    if (dob.reason) localReasons.push(dob.reason);
    if (sexAgrees === false) localReasons.push('sex differs');

    const exactDemographics = family === 1 && given === 1 && dob.points === 1 && sexAgrees !== false;
    if (exactDemographics) {
      ranked.push({ localPatientId: local.localPatientId, confidence: IDENTITY_DEMOGRAPHIC_CONFIDENCE, method: 'demographics', reasons: localReasons });
      continue;
    }

    // Fuzzy: plausible, never sufficient. A sex mismatch caps it hard — sex and
    // an exact name still agreeing on a wrong birth date is a real person pair.
    const score = family * 0.4 + given * 0.3 + dob.points * 0.25 + (sexAgrees === true ? 0.05 : 0);
    if (score >= 0.7) {
      const capped = Math.min(IDENTITY_FUZZY_CEILING, Number(score.toFixed(2)));
      ranked.push({
        localPatientId: local.localPatientId,
        confidence: sexAgrees === false ? Math.min(capped, 0.6) : capped,
        method: 'fuzzy',
        reasons: localReasons.length ? localReasons : ['weak demographic resemblance'],
      });
    }
  }

  ranked.sort((a, b) => b.confidence - a.confidence || a.localPatientId.localeCompare(b.localPatientId));

  const best = ranked[0];
  if (!best) {
    const resolution: IdentityResolution = {
      status: 'unresolved',
      candidates: [],
      reasons: [...reasons, incomingIdentifiers.length ? 'no candidate matched the supplied identifiers or demographics' : 'no identifiers or demographics supplied'],
      blocksWrite: true,
    };
    return resolution;
  }

  // A fuzzy best candidate is a LEAD, not an answer, even when it is alone.
  const usable = best.confidence >= minConfidence && best.method !== 'fuzzy';
  const ties = ranked.filter((c) => best.confidence - c.confidence <= margin);
  const ambiguous = !usable || ties.length > 1;

  if (ambiguous) {
    const resolution: IdentityResolution = {
      status: 'ambiguous',
      candidates: ranked.slice(0, 8),
      reasons: [
        ...reasons,
        !usable
          ? `best match is ${best.method} at ${best.confidence.toFixed(2)} — below ${minConfidence} or not an exact-link method`
          : `${ties.length} candidates within ${margin} of the best confidence`,
        'a human must confirm which patient this is before anything is written',
      ],
      blocksWrite: true,
    };
    opts.onAmbiguous?.(resolution);
    return resolution;
  }

  return {
    status: 'resolved',
    localPatientId: best.localPatientId,
    confidence: best.confidence,
    method: best.method,
    candidates: ranked.slice(0, 8),
    reasons: [...reasons, ...best.reasons],
    blocksWrite: false,
  };
}

/**
 * THE wrong-patient guardrail.
 *
 * Callers on a write path do not read `status`; they call this. A refusal is a
 * thrown error with a code, so it cannot be mistaken for "no result" and
 * silently skipped.
 */
export class UnresolvedPatientIdentityError extends Error {
  readonly code = 'unresolved-patient-identity';
  constructor(readonly resolution: IdentityResolution) {
    super(`patient identity ${resolution.status}: ${resolution.reasons.join('; ')}`);
    this.name = 'UnresolvedPatientIdentityError';
  }
}

export function requirePatientIdentity(resolution: IdentityResolution): string {
  if (resolution.status !== 'resolved' || !resolution.localPatientId) {
    throw new UnresolvedPatientIdentityError(resolution);
  }
  return resolution.localPatientId;
}

/* -------------------------------------------------- cross-reference records */

export interface PatientCrossReference {
  id: string;
  realmId?: string;
  localPatientId: string;
  remoteSystem: string;
  remotePatientId: string;
  confidence: number;
  method: IdentityMethod;
  linkedBy: string;
  linkedAt: string;
  /**
   * `verified` separates "a human confirmed this" from "we inferred it". A
   * high-risk write may require it.
   */
  verified: boolean;
  /**
   * Set on a row that has been RETIRED: it is no longer the answer for this
   * remote identity. Holds the surviving local patient id. A live link never
   * carries it — if it did, the merge would resolve to nothing at all.
   */
  supersededBy?: string;
}

export function crossReferenceId(localPatientId: string, remoteSystem: string, remotePatientId: string): string {
  return `${localPatientId}::${remoteSystem}::${normaliseIdentifier(remotePatientId)}`;
}

/** Minimal storage seam so this module stays free of a workspace import. */
export interface IdentityLinkStore {
  listCrossReferences(realmId?: string): Promise<PatientCrossReference[]>;
  saveCrossReference(ref: PatientCrossReference): Promise<PatientCrossReference>;
  /**
   * Retire a link. Optional only so a minimal store still works — a store that
   * cannot delete MUST at least let `listCrossReferences` report `supersededBy`,
   * because a stale link that still resolves is a wrong-patient write waiting to
   * happen.
   */
  deleteCrossReference?(id: string): Promise<boolean>;
}

export interface LinkInput {
  realmId?: string;
  localPatientId: string;
  remoteSystem: string;
  remotePatientId: string;
  confidence: number;
  method: IdentityMethod;
  linkedBy: string;
  verified?: boolean;
}

export class PatientIdentityService {
  constructor(
    private readonly registry: IdentifierSystemRegistry,
    private readonly store: IdentityLinkStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async resolve(
    incoming: PatientDemographics,
    population: readonly LocalPatientDemographics[],
    opts: IdentityResolveOptions & { realmId?: string } = {},
  ): Promise<IdentityResolution> {
    // Our own prior links are part of the population: a second encounter for a
    // linked patient must resolve on the link, not on a re-derived resemblance.
    const links = await this.store.listCrossReferences(opts.realmId);
    const enriched: LocalPatientDemographics[] = population.map((p) => ({
      ...p,
      crossReferences: [
        ...(p.crossReferences ?? []),
        ...links
          .filter((l) => !l.supersededBy && l.localPatientId === p.localPatientId)
          .map((l) => ({ remoteSystem: l.remoteSystem, remotePatientId: l.remotePatientId, verified: l.verified })),
      ],
    }));
    return resolvePatientIdentity(incoming, enriched, this.registry, opts);
  }

  /** Record a link. A link is idempotent per (patient, system, id). */
  async link(input: LinkInput): Promise<PatientCrossReference> {
    const ref: PatientCrossReference = {
      id: crossReferenceId(input.localPatientId, input.remoteSystem, input.remotePatientId),
      ...(input.realmId ? { realmId: input.realmId } : {}),
      localPatientId: input.localPatientId,
      remoteSystem: input.remoteSystem,
      remotePatientId: input.remotePatientId,
      confidence: input.confidence,
      method: input.method,
      linkedBy: input.linkedBy,
      linkedAt: this.now(),
      verified: input.verified ?? input.method !== 'fuzzy',
    };
    return this.store.saveCrossReference(ref);
  }

  /** A human confirmed a link that was inferred (or that was ambiguous). */
  async verify(localPatientId: string, remoteSystem: string, remotePatientId: string, verifiedBy: string): Promise<PatientCrossReference> {
    return this.store.saveCrossReference({
      id: crossReferenceId(localPatientId, remoteSystem, remotePatientId),
      localPatientId,
      remoteSystem,
      remotePatientId,
      confidence: 1,
      method: 'cross-reference',
      linkedBy: verifiedBy,
      linkedAt: this.now(),
      verified: true,
    });
  }

  /**
   * A merge moved `fromLocalId` into `toLocalId`.
   *
   * The link is RE-POINTED and the old row RETIRED. Retiring matters more than
   * re-pointing: if both rows survive, a lookup by remote id can still find the
   * merged-away patient and send clinical data back to the dead chart — the same
   * wrong-patient outcome by a different route.
   */
  async mergeInto(fromLocalId: string, toLocalId: string, mergedBy: string): Promise<PatientCrossReference[]> {
    const links = (await this.store.listCrossReferences()).filter((l) => l.localPatientId === fromLocalId && !l.supersededBy);
    const out: PatientCrossReference[] = [];
    for (const link of links) {
      const newId = crossReferenceId(toLocalId, link.remoteSystem, link.remotePatientId);
      // The MOVED row is the live one — `supersededBy` is NOT set on it.
      const moved: PatientCrossReference = {
        ...link,
        id: newId,
        localPatientId: toLocalId,
        linkedBy: mergedBy,
        linkedAt: this.now(),
      };
      out.push(await this.store.saveCrossReference(moved));

      if (link.id === newId) continue;
      if (this.store.deleteCrossReference) {
        await this.store.deleteCrossReference(link.id);
      } else {
        // A store that cannot delete MUST still retire the row: `supersededBy`
        // marks it as no longer the answer for this remote identity.
        await this.store.saveCrossReference({ ...link, supersededBy: toLocalId });
      }
    }
    return out;
  }

  /**
   * Find the live link for a remote identity. A superseded row is never returned
   * — `supersededBy` means the row was retired by a merge.
   */
  async findLink(remoteSystem: string, remotePatientId: string): Promise<PatientCrossReference | undefined> {
    const wanted = normaliseIdentifier(remotePatientId);
    return (await this.store.listCrossReferences()).find(
      (l) => !l.supersededBy && l.remoteSystem === remoteSystem && normaliseIdentifier(l.remotePatientId) === wanted,
    );
  }
}

/* ------------------------------------------------- outbound identity (B2/B3) */

/**
 * A stable, deterministic id for an outbound resource, derived from the effect
 * that produced it.
 *
 * `push()` uses PUT on this id, so a replay UPDATES the resource it created
 * last time instead of POSTing a second one. Before this every outbound
 * resource was id-less, which for a retried write meant a duplicate order in
 * the EMR.
 */
export function stableResourceId(effectId: string, suffix?: string): string {
  const digest = createHash('sha1').update(`ananthealth:fhir:${effectId}`).digest('hex').slice(0, 32);
  return suffix ? `${digest}-${suffix}` : digest;
}

export interface OutboundIdentity {
  /** `Patient/<remoteId>` when we hold a verified link, else `Patient/<localId>`. */
  subjectReference: string;
  /** The local id we actually resolved, so the caller can key its own records. */
  localPatientId: string;
  /** The MRN in the EMR's own system — carried as an `identifier`, always. */
  identifiers: Array<{ system: string; value: string }>;
  remapped: boolean;
}

/**
 * Reverse mapping on emit. An outbound resource must name the patient the way
 * the RECEIVING system does, and must carry our MRN as an identifier regardless
 * — that is the only thing that will survive a vendor's own record merge.
 */
export function outboundPatientIdentity(input: {
  localPatientId: string;
  localMrn?: string;
  links: readonly PatientCrossReference[];
  preferVerified?: boolean;
}): OutboundIdentity {
  const eligible = input.links
    .filter((l) => l.localPatientId === input.localPatientId)
    .filter((l) => (input.preferVerified === false ? true : l.verified));
  const best = eligible.sort((a, b) => b.confidence - a.confidence)[0];
  const identifiers: Array<{ system: string; value: string }> = [];
  if (best) identifiers.push({ system: best.remoteSystem, value: best.remotePatientId });
  if (input.localMrn) identifiers.push({ system: 'urn:mrn', value: input.localMrn });
  return {
    subjectReference: best ? `Patient/${best.remotePatientId}` : `Patient/${input.localPatientId}`,
    localPatientId: input.localPatientId,
    identifiers,
    remapped: Boolean(best),
  };
}

/* ------------------------------------------------------ corrections (B5) */

export interface CorrectionNotice {
  resourceType?: string;
  resourceId?: string;
  action: 'entered-in-error' | 'deleted' | 'merge';
  reason: string;
}

/**
 * Detect a correction on an incoming resource.
 *
 * A correction SUPERSEDES; it never deletes. Deleting would erase the fact that
 * a wrong value was once recorded, which is exactly what an audit needs.
 */
export function correctionFrom(resource: unknown): CorrectionNotice | undefined {
  const r = (resource ?? {}) as { resourceType?: string; id?: string; status?: string; link?: Array<{ type?: string }> };
  if (r.status === 'entered-in-error') {
    return {
      ...(r.resourceType ? { resourceType: r.resourceType } : {}),
      ...(r.id ? { resourceId: r.id } : {}),
      action: 'entered-in-error',
      reason: `${r.resourceType ?? 'resource'} marked entered-in-error`,
    };
  }
  if (r.resourceType === 'Patient' && (r.link ?? []).some((l) => l.type === 'replaced-by')) {
    return {
      ...(r.id ? { resourceId: r.id } : {}),
      action: 'merge',
      reason: 'Patient.link replaced-by — this record was merged into another',
    };
  }
  return undefined;
}

/** `410 Gone` on a re-fetch is a deletion notice, not a transport failure. */
export function correctionFromStatus(status: number, resourceType?: string): CorrectionNotice | undefined {
  if (status === 410) {
    return { ...(resourceType ? { resourceType } : {}), action: 'deleted', reason: '410 Gone on re-fetch — the resource was removed at source' };
  }
  return undefined;
}
