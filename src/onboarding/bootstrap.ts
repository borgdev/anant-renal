// M16 — Onboarding bootstrap
//
// Idempotent, transaction-like bootstrap that turns a declarative
// OrganizationTemplate into: a ProviderOrg (federation), N realms
// (one per facility), each populated with units and (optionally) seed
// patient data. Manual form UI, CSV upload, and JSON API all reduce
// to this single function so day-1 setup is deterministic and
// re-runnable.
//
// Templates are provided for common shapes (single independent clinic,
// small multi-site group, hospital + ambulatory network). Manual mode
// composes any custom shape.

import { RealmRegistry } from '../realm/registry.js';
import { Realm } from '../realm/realm.js';
import type { RealmMode } from '../realm/types.js';
import { populateFacility } from '../realm/sim-populator.js';
import type { FacilitySeed } from '../realm/sim-populator.js';
import { Federation } from '../realm/federation.js';

export type FacilityKind = FacilitySeed['kind'];

export interface FacilitySpec {
  facilityId: string;
  kind: FacilityKind;
  name: string;
  units: string[];
  patientCount?: number;
}

export interface OrganizationTemplate {
  orgId: string;
  displayName: string;
  mode?: RealmMode;               // 'shadow' | 'assist' | 'auto' (default 'shadow')
  facilities: FacilitySpec[];
  sampleData?: boolean;           // if true, populate synthetic patients
  seedPatientCountDefault?: number; // default per facility if unspecified
}

export interface BootstrapResult {
  orgId: string;
  createdOrg: boolean;
  realms: Array<{ realmId: string; facilityId: string; created: boolean; patientCount: number; unitCount: number }>;
  totalPatients: number;
  totalUnits: number;
  totalFacilities: number;
  warnings: string[];
}

const DEFAULT_MODE: RealmMode = 'sim';
const DEFAULT_SEED_PATIENTS = 20;

/** Idempotent — safe to re-run with the same template; existing realms & orgs are reused. */
export function createOrgWithFacilities(t: OrganizationTemplate): BootstrapResult {
  if (!t.orgId) throw new Error('bootstrap: orgId required');
  if (!t.displayName) throw new Error('bootstrap: displayName required');
  if (!t.facilities?.length) throw new Error('bootstrap: at least one facility required');

  const mode = t.mode ?? DEFAULT_MODE;
  const seedDefault = t.seedPatientCountDefault ?? DEFAULT_SEED_PATIENTS;
  const warnings: string[] = [];

  // 1. Org
  const existingOrg = Federation.getOrg(t.orgId);
  const createdOrg = !existingOrg;
  const realmIds: string[] = existingOrg ? [...existingOrg.realmIds] : [];

  // 2. Realms per facility
  const results: BootstrapResult['realms'] = [];
  for (const f of t.facilities) {
    if (!f.facilityId || !f.name || !f.kind || !f.units?.length) {
      warnings.push(`facility skipped (missing required fields): ${JSON.stringify(f)}`);
      continue;
    }
    const realmId = `${t.orgId}-${f.facilityId}`;
    let realm: Realm;
    let created = false;
    const existingRealm = RealmRegistry.get(realmId);
    if (existingRealm) {
      realm = existingRealm;
    } else {
      realm = RealmRegistry.create({ id: realmId, mode });
      created = true;
    }
    if (!realmIds.includes(realmId)) realmIds.push(realmId);

    // 3. Facility + units + optional patients
    const patientCount = t.sampleData ? (f.patientCount ?? seedDefault) : 0;
    const seedResult = populateFacility(realm, {
      facilityId: f.facilityId,
      kind: f.kind,
      name: f.name,
      units: f.units,
      patientCount,
    });

    results.push({
      realmId,
      facilityId: f.facilityId,
      created,
      patientCount: seedResult.patientIds.length,
      unitCount: seedResult.unitIds.length,
    });
  }

  // 4. Update federation
  Federation.registerOrg({ orgId: t.orgId, displayName: t.displayName, realmIds });

  return {
    orgId: t.orgId,
    createdOrg,
    realms: results,
    totalPatients: results.reduce((n, r) => n + r.patientCount, 0),
    totalUnits: results.reduce((n, r) => n + r.unitCount, 0),
    totalFacilities: results.length,
    warnings,
  };
}

// ---------- Named templates ----------
export interface OnboardingTemplate {
  id: string;
  displayName: string;
  description: string;
  build(orgId: string, orgDisplayName: string): OrganizationTemplate;
}

export const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = Object.freeze([
  {
    id: 'independent-dialysis-clinic',
    displayName: 'Independent dialysis clinic',
    description: 'Single-site ESRD dialysis center, 3 unit rooms, sample cohort.',
    build: (orgId, name) => ({
      orgId,
      displayName: name,
      mode: 'sim',
      sampleData: true,
      facilities: [{ facilityId: 'main', kind: 'dialysis', name, units: ['A', 'B', 'C'], patientCount: 24 }],
    }),
  },
  {
    id: 'urgent-care-group-5-site',
    displayName: '5-site urgent-care group',
    description: 'Multi-site urgent-care group with shared identity, individual realms per clinic.',
    build: (orgId, name) => ({
      orgId,
      displayName: name,
      mode: 'sim',
      sampleData: true,
      facilities: ['north', 'south', 'east', 'west', 'downtown'].map((n) => ({
        facilityId: `uc-${n}`,
        kind: 'urgent-care' as const,
        name: `${name} — ${n[0]!.toUpperCase()}${n.slice(1)}`,
        units: ['ROOM-1', 'ROOM-2', 'ROOM-3'],
        patientCount: 12,
      })),
    }),
  },
  {
    id: 'hospital-plus-ambulatory',
    displayName: 'Hospital + ambulatory network',
    description: 'Acute hospital + 3 primary-care clinics + 1 urgent-care.',
    build: (orgId, name) => ({
      orgId,
      displayName: name,
      mode: 'sim',
      sampleData: true,
      facilities: [
        { facilityId: 'main-hosp', kind: 'hospital', name: `${name} — Main Hospital`, units: ['ICU', 'MED-SURG', 'ED-OBS'], patientCount: 40 },
        { facilityId: 'clinic-a', kind: 'primary-care', name: `${name} — Primary A`, units: ['GEN'], patientCount: 15 },
        { facilityId: 'clinic-b', kind: 'primary-care', name: `${name} — Primary B`, units: ['GEN'], patientCount: 15 },
        { facilityId: 'clinic-c', kind: 'primary-care', name: `${name} — Primary C`, units: ['GEN'], patientCount: 15 },
        { facilityId: 'uc-main', kind: 'urgent-care', name: `${name} — Urgent Care`, units: ['ROOM-1', 'ROOM-2'], patientCount: 10 },
      ],
    }),
  },
  {
    id: 'primary-care-solo',
    displayName: 'Solo primary-care practice',
    description: 'Independent physician practice, single site.',
    build: (orgId, name) => ({
      orgId,
      displayName: name,
      mode: 'sim',
      sampleData: true,
      facilities: [{ facilityId: 'main', kind: 'primary-care', name, units: ['GEN'], patientCount: 10 }],
    }),
  },
]);

export function findTemplate(id: string): OnboardingTemplate | undefined {
  return ONBOARDING_TEMPLATES.find((t) => t.id === id);
}

// ---------- CSV parser ----------
/**
 * Parse a CSV of facility rows. Columns (order-independent, comma-delimited):
 *   facility_id, kind, name, units, patient_count
 * `units` is a semicolon-separated list.
 * `patient_count` is optional.
 */
export function parseFacilitiesCsv(csv: string): FacilitySpec[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return [];
  const header = splitCsvRow(lines[0]!).map((h) => h.trim().toLowerCase());
  const idx = {
    facility_id: header.indexOf('facility_id'),
    kind: header.indexOf('kind'),
    name: header.indexOf('name'),
    units: header.indexOf('units'),
    patient_count: header.indexOf('patient_count'),
  };
  if (idx.facility_id < 0 || idx.kind < 0 || idx.name < 0 || idx.units < 0) {
    throw new Error('CSV missing required columns: facility_id, kind, name, units');
  }
  const facilities: FacilitySpec[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!);
    const kind = cols[idx.kind]?.trim() as FacilityKind;
    if (!['dialysis', 'primary-care', 'urgent-care', 'hospital'].includes(kind)) {
      throw new Error(`CSV row ${i + 1}: invalid kind "${cols[idx.kind]}"`);
    }
    const facilityId = cols[idx.facility_id]?.trim();
    const name = cols[idx.name]?.trim();
    const unitsRaw = cols[idx.units]?.trim() ?? '';
    if (!facilityId || !name || !unitsRaw) throw new Error(`CSV row ${i + 1}: missing facility_id/name/units`);
    const units = unitsRaw.split(';').map((u) => u.trim()).filter(Boolean);
    const patientCount = idx.patient_count >= 0 && cols[idx.patient_count]?.trim()
      ? parseInt(cols[idx.patient_count]!.trim(), 10)
      : undefined;
    const spec: FacilitySpec = { facilityId, kind, name, units };
    if (patientCount !== undefined) spec.patientCount = patientCount;
    facilities.push(spec);
  }
  return facilities;
}

function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---------- Save-and-resume wizard state ----------
export interface WizardState {
  wizardId: string;
  orgId?: string;
  displayName?: string;
  currentStep: 'org' | 'facilities' | 'units' | 'seed-users' | 'review' | 'complete';
  facilities: FacilitySpec[];
  seedUsers?: Array<{ email: string; role: string }>;
  sampleData?: boolean;
  updatedAt: string;
}

const wizardStore = new Map<string, WizardState>();

export function startWizard(wizardId?: string): WizardState {
  const id = wizardId ?? `wiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state: WizardState = {
    wizardId: id,
    currentStep: 'org',
    facilities: [],
    updatedAt: new Date().toISOString(),
  };
  wizardStore.set(id, state);
  return state;
}

export function getWizard(id: string): WizardState | undefined { return wizardStore.get(id); }
export function listWizards(): WizardState[] { return [...wizardStore.values()]; }
export function saveWizard(state: WizardState): WizardState {
  state.updatedAt = new Date().toISOString();
  wizardStore.set(state.wizardId, state);
  return state;
}
export function deleteWizard(id: string): boolean { return wizardStore.delete(id); }

/** Complete a wizard by materializing its state through createOrgWithFacilities. */
export function completeWizard(id: string): BootstrapResult {
  const w = wizardStore.get(id);
  if (!w) throw new Error(`wizard-not-found:${id}`);
  if (!w.orgId || !w.displayName) throw new Error('wizard: orgId and displayName required');
  const template: OrganizationTemplate = {
    orgId: w.orgId,
    displayName: w.displayName,
    facilities: w.facilities,
    sampleData: !!w.sampleData,
  };
  const result = createOrgWithFacilities(template);
  w.currentStep = 'complete';
  wizardStore.set(id, w);
  return result;
}
