import type { FastifyInstance } from 'fastify';

/**
 * Console domain catalog — the option lists, default payloads, staff packs and
 * Learn recipes that used to live as hardcoded literals inside
 * `admin-ui/index.html`. Serving them from the backend keeps the operator
 * console fully server-sourced (the UI only keeps mirror literals as a
 * first-paint fallback for offline / static-snapshot builds).
 *
 * Routes are mounted under `/admin/console/*`, so they inherit the same admin
 * API guard (session + role) as the rest of the operator console.
 */

export interface EffectTemplate {
  [key: string]: unknown;
}

export interface StaffPack {
  id: string;
  label: string;
  agentSpecId: string;
  /** Default checked state in the world-builder wizard. */
  checked: boolean;
}

export interface ArchetypeOption {
  value: string;
  label: string;
}

export interface WhatIfPreset {
  id: string;
  label: string;
  effects: [string, number][];
}

export interface ConsoleDomain {
  /** Drive-the-sim effect kinds selectable in the Realm view. */
  effectKinds: string[];
  /** Payload templates keyed by effect kind (positional patientId/unitId merged in the UI). */
  effectTemplates: Record<string, EffectTemplate>;
  /** Staff packs for the Build-a-world wizard. */
  staffPacks: StaffPack[];
  /** Realm archetypes (dialysis / primary-care / urgent-care / hospital). */
  archetypes: ArchetypeOption[];
  /** What-If forecast intervention presets. */
  whatIfPresets: WhatIfPreset[];
  /** Defaults for the counterfactual rehearsal composer. */
  counterfactualDefault: {
    facilityId: string;
    units: string;
    patientCount: number;
    advanceTicks: number;
    interventions: { kind: string; effect: Record<string, number> }[];
  };
  /** Defaults for the nudge ledger composer. */
  nudgeDefault: {
    channels: string[];
    kind: string;
    expectedEffect: Record<string, number>;
  };
  /** Reusable option lists / defaults used across Settings + Enterprise views. */
  domainOptions: {
    roleOptions: string[];
    clearanceOptions: string[];
    trajectories: string[];
    lifecycleKinds: { value: string; label: string }[];
    facilityKinds: { value: string; label: string }[];
    retentionEntities: string[];
    unitsDefault: string;
    patientCountDefault: number;
    defaultMeasureId: string;
    demoLabs: { k: number; hgb: number; urr: number; phos: number };
  };
}

export interface LearnRecipe {
  id: string;
  title: string;
  body: string;
  action: { label: string; view: string };
}

export const DEFAULT_MEASURE_ID = 'ecqm:M21Basic/1.0.0';

export const CONSOLE_DOMAIN: ConsoleDomain = {
  effectKinds: [
    'record-vitals',
    'record-assessment',
    'order-lab',
    'order-med',
    'result-lab',
    'admit-patient',
    'transfer-patient',
    'discharge-patient',
    'notify-staff',
    'record-agent-thought',
  ],
  effectTemplates: {
    'record-vitals': { hr: 82, bp: '132/80', spo2: 96, temp: 36.8, rr: 16 },
    'record-assessment': { assessmentId: 'phq2', score: 2, band: 'mild' },
    'order-lab': { code: '17861-6', priority: 'routine' },
    'order-med': { code: '853653', dose: '50 mg', route: 'PO', frequency: 'Q8H' },
    'result-lab': { code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' },
    // Positional unitId overrides from the Drive-the-sim selects win over these fallbacks.
    'admit-patient': { unitId: 'ICH-A' },
    'transfer-patient': { toUnitId: 'ICH-B' },
    'discharge-patient': {},
    'notify-staff': { role: 'md', message: 'Escalation needed' },
    'record-agent-thought': { note: 'Considering next step' },
  },
  staffPacks: [
    { id: 'wb-md', label: 'Rounding MD', agentSpecId: 'md', checked: true },
    { id: 'wb-nurse', label: 'Charge nurses (one per unit)', agentSpecId: 'nurse', checked: true },
    { id: 'wb-rx', label: 'Pharmacist review', agentSpecId: 'pharmacist', checked: true },
    { id: 'wb-coder', label: 'Claims coder', agentSpecId: 'coder', checked: true },
    { id: 'wb-safety', label: 'Safety monitor', agentSpecId: 'safety', checked: false },
  ],
  archetypes: [
    { value: 'dialysis', label: 'Dialysis facility' },
    { value: 'primary-care', label: 'Primary care clinic' },
    { value: 'urgent-care', label: 'Urgent care' },
    { value: 'hospital', label: 'Hospital ward' },
  ],
  whatIfPresets: [
    { id: 'adjust-prescription', label: 'Adjust prescription', effects: [['ktv_adequacy', 0.25], ['phosphate', -0.15]] },
    { id: 'dietitian-nudge', label: 'Dietitian nudge', effects: [['phosphate', -0.2], ['deterioration_risk', -0.05]] },
    { id: 'escalate-nephrologist', label: 'Escalate to nephrologist', effects: [['deterioration_risk', -0.25], ['vitals_instability', -0.15]] },
  ],
  counterfactualDefault: {
    facilityId: 'cf-fac',
    units: 'ICH-A,ICH-B',
    patientCount: 12,
    advanceTicks: 48,
    interventions: [{ kind: 'event-effect', effect: { diet_phosphate_violation: -0.2 } }],
  },
  nudgeDefault: {
    channels: ['in-app', 'sms', 'email', 'calendar', 'fhir'],
    kind: 'dietitian-nudge',
    expectedEffect: { diet_phosphate_violation: -0.2 },
  },
  domainOptions: {
    roleOptions: ['nurse', 'md', 'pharmacist', 'coder', 'safety'],
    clearanceOptions: ['phi', 'restricted-phi', 'internal'],
    trajectories: ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'],
    lifecycleKinds: [
      { value: 'clinical', label: 'Clinical' },
      { value: 'billing', label: 'Billing' },
      { value: 'care', label: 'Care' },
      { value: 'research', label: 'Research' },
    ],
    facilityKinds: [
      { value: 'dialysis', label: 'Dialysis' },
      { value: 'primary-care', label: 'Primary care' },
      { value: 'urgent-care', label: 'Urgent care' },
      { value: 'hospital', label: 'Hospital' },
    ],
    retentionEntities: ['audit_events', 'event_outbox', 'webhook_deliveries', 'fhir_resources', 'billing_usage', 'alert_events'],
    unitsDefault: 'ICH-A,ICH-B,ICH-C',
    patientCountDefault: 20,
    defaultMeasureId: DEFAULT_MEASURE_ID,
    demoLabs: { k: 4.2, hgb: 11.5, urr: 68, phos: 5.1 },
  },
};

export const LEARN_RECIPES: LearnRecipe[] = [
  {
    id: 'sync-vsac',
    title: 'Set up VSAC value-set expansion',
    body: 'Register a UMLS account, paste the API key into the VSAC source card, click Test, then Sync now. Value sets for CMS165 (Controlling High Blood Pressure) and CMS122 (Diabetes A1c) will appear as artifacts.',
    action: { label: 'Open VSAC card', view: 'research' },
  },
  {
    id: 'sync-kdigo',
    title: 'Refresh KDIGO guideline snapshots',
    body: 'The KDIGO CKD guideline is fetched via the PubMed adapter (search terms include "chronic kidney disease"). Trigger a sync and open the provenance drawer to see the latest PMIDs.',
    action: { label: 'Sync PubMed', view: 'research' },
  },
  {
    id: 'trace-measure',
    title: 'Trace a CMS eCQM to its source paragraph',
    body: 'Open the Knowledge browser, filter by publisher CMS, click the CMS eCQMs card, open Provenance, and follow any Measure→Library link to the exact FHIR resource on GitHub with SHA-256 verification.',
    action: { label: 'Browse eCQMs', view: 'measures' },
  },
  {
    id: 'ingest-local',
    title: 'Upload a facility policy PDF (Local Corpus)',
    body: "Facility-specific policies live in Realm → Local Corpus. Uploaded documents run through the M19 entity compiler and produce provenance-tracked artifacts scoped to your realm only.",
    action: { label: 'Open Realm', view: 'realm' },
  },
  {
    id: 'run-agent',
    title: 'Ask a knowledge-aware agent',
    body: 'Every published agent has access to the full Knowledge tool bus (list_sources, sync_source, get_artifact, trace_provenance). Try: "Cite the CMS165 numerator criteria and show me the value set expansion."',
    action: { label: 'Open agents', view: 'agents' },
  },
];

export async function registerConsoleDomainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/console/domain', async () => ({ domain: CONSOLE_DOMAIN }));
  app.get('/admin/console/learn', async () => ({ recipes: LEARN_RECIPES }));
}
