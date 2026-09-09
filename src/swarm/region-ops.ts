/******************************************************************************
 * R2/R3 — regional operations + D-S at enterprise scale.
 *
 * R2: roll live realm snapshots up into a REGION census board (realms,
 *     facilities, units, patients, live effects) so a network operator sees
 *     one number per region instead of a per-realm scatter.
 * R3: aggregate the per-patient deterioration readouts (DST-Q #2) BY REGION —
 *     the same Bel/Pl/K posture counts (alerts / contested / watch / reassured)
 *     roll up to regional and enterprise levels, so "which region needs the
 *     MD this hour" is an evidence-level question, not a guess.
 *
 * Region identity today is derived deterministically from realm/facility ids
 * (the enterprise scenario encodes sim:ent-<region>); a real deployment would
 * swap in the org operating-model hierarchy from the admin ontology.
 ******************************************************************************/

import type { EarlyWarningReadout } from './early-warning.js';

/** Deterministic region for a realm id used by the sim fleet. */
export function regionFromRealmId(realmId: string): string {
  const m = /^sim:ent-(midtn|easttn|westtn)(?:-[a-z])?$/.exec(realmId ?? '');
  if (m) {
    const region: Record<string, string> = { midtn: 'Middle TN', easttn: 'East TN', westtn: 'West TN' };
    return region[m[1]!] ?? 'Enterprise';
  }
  return 'Default';
}

/** Deterministic region label for a facility id (best-effort; real deploys use the ontology). */
export function regionForFacility(facilityId: string | null | undefined, map: Record<string, string> = {}): string {
  const id = facilityId ?? '';
  if (map[id]) return map[id]!;
  const lower = id.toLowerCase();
  if (lower.includes('nashville') || lower.includes('midtn')) return 'Middle TN';
  if (lower.includes('knoxville') || lower.includes('chattanooga') || lower.includes('easttn')) return 'East TN';
  if (lower.includes('memphis') || lower.includes('jackson') || lower.includes('westtn')) return 'West TN';
  return 'Default';
}

export interface RealmCensusRow {
  realmId: string;
  patients?: number;
  units?: number;
  liveEffects?: number;
  presences?: number;
}

/** One operating-model scopePath node (region/market nodes may list facilityIds). */
export interface OntologyScopeNode {
  id?: string;
  level?: string;
  label?: string;
  facilityIds?: string[];
}

/** Build facilityId → region-label from the admin operating-model scopePath. */
export function buildRegionMembership(scopePath: OntologyScopeNode[]): Map<string, string> {
  const membership = new Map<string, string>();
  for (const node of scopePath) {
    const level = node.level ?? '';
    if (level !== 'region' && level !== 'market') continue;
    const label = node.label ?? node.id ?? level;
    for (const facilityId of node.facilityIds ?? []) membership.set(facilityId, label);
  }
  return membership;
}

/** Region for a facility: real ontology membership when configured, else id-derived. */
export function resolveRegionForFacility(
  membership: Map<string, string>,
  facilityId: string | null | undefined,
  realmId?: string | null,
): string {
  const id = facilityId ?? '';
  if (membership.has(id)) return membership.get(id)!;
  return regionFromRealmId(realmId ?? '');
}

export interface RegionCensus {
  regionId: string;
  label: string;
  realms: number;
  units: number;
  patients: number;
  liveEffects: number;
  presences: number;
}

export interface PostureCounts {
  patients: number;
  alerts: number;
  contested: number;
  watch: number;
  reassured: number;
  maxBelief: number | null;
}

export interface RegionDeterioration extends RegionCensus, PostureCounts {}

/** Group realm census rows by region and sum them (R2). When `regionOf` is
 *  provided (e.g. real ontology membership keyed by each facility's realm), it
 *  is used instead of the id-derived region. */
export function rollupRealmRegions(rows: RealmCensusRow[], regionOf?: (row: RealmCensusRow) => string): RegionCensus[] {
  const byRegion = new Map<string, RegionCensus>();
  for (const row of rows) {
    const regionId = regionOf ? regionOf(row) : regionFromRealmId(row.realmId ?? '');
    const cur = byRegion.get(regionId) ?? { regionId, label: regionId, realms: 0, units: 0, patients: 0, liveEffects: 0, presences: 0 };
    cur.realms += 1;
    cur.units += row.units ?? 0;
    cur.patients += row.patients ?? 0;
    cur.liveEffects += row.liveEffects ?? 0;
    cur.presences += row.presences ?? 0;
    byRegion.set(regionId, cur);
  }
  return [...byRegion.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Count deterioration postures across readouts (shared by whole + regional). */
export function countPostures(readouts: EarlyWarningReadout[]): PostureCounts {
  const counts: PostureCounts = { patients: readouts.length, alerts: 0, contested: 0, watch: 0, reassured: 0, maxBelief: null };
  for (const r of readouts) {
    if (r.posture === 'corroborated') counts.alerts += 1;
    else if (r.posture === 'contested') counts.contested += 1;
    else if (r.posture === 'weak') counts.watch += 1;
    else counts.reassured += 1;
    counts.maxBelief = Math.max(counts.maxBelief ?? 0, r.belief);
  }
  counts.maxBelief = counts.maxBelief === null ? null : Math.round(counts.maxBelief * 1000) / 1000;
  return counts;
}

/** Aggregate per-patient deterioration readouts by region (R3). */
export function aggregateDeteriorationByRegion(
  readouts: EarlyWarningReadout[],
  regionOf?: (r: EarlyWarningReadout) => string,
): RegionDeterioration[] {
  const byRegion = new Map<string, EarlyWarningReadout[]>();
  for (const r of readouts) {
    const regionId = (regionOf ? regionOf(r) : regionForFacility(r.facilityId)) ?? 'Default';
    const list = byRegion.get(regionId) ?? [];
    list.push(r);
    byRegion.set(regionId, list);
  }
  return [...byRegion.entries()]
    .map(([regionId, list]) => {
      const posture = countPostures(list);
      return {
        regionId,
        label: regionId,
        realms: 0,
        units: 0,
        liveEffects: 0,
        presences: 0,
        ...posture,
      };
    })
    .sort((a, b) => (b.alerts - a.alerts) || a.label.localeCompare(b.label));
}
