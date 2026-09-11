import { S } from '../state.js';
import { clientValidate } from './validation.js';

export let CONSOLE_DOMAIN = null;

export let CONSOLE_LEARN = null;

export const FALLBACK_DOMAIN = {
  effectKinds: ['record-vitals', 'record-assessment', 'order-lab', 'order-med', 'result-lab', 'admit-patient', 'transfer-patient', 'discharge-patient', 'notify-staff', 'record-agent-thought'],
  effectTemplates: {
    'record-vitals': { hr: 82, bp: '132/80', spo2: 96, temp: 36.8, rr: 16 },
    'record-assessment': { assessmentId: 'phq2', score: 2, band: 'mild' },
    'order-lab': { code: '17861-6', priority: 'routine' },
    'order-med': { code: '853653', dose: '50 mg', route: 'PO', frequency: 'Q8H' },
    'result-lab': { code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' },
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
    lifecycleKinds: [['clinical', 'Clinical'], ['billing', 'Billing'], ['care', 'Care'], ['research', 'Research']],
    facilityKinds: [['dialysis', 'Dialysis'], ['primary-care', 'Primary care'], ['urgent-care', 'Urgent care'], ['hospital', 'Hospital']],
    retentionEntities: ['audit_events', 'event_outbox', 'webhook_deliveries', 'fhir_resources', 'billing_usage', 'alert_events'],
    unitsDefault: 'ICH-A,ICH-B,ICH-C',
    patientCountDefault: 20,
    defaultMeasureId: 'ecqm:M21Basic/1.0.0',
    demoLabs: { k: 4.2, hgb: 11.5, urr: 68, phos: 5.1 },
  },
};

export const FALLBACK_LEARN = [
  { id: 'sync-vsac', title: 'Set up VSAC value-set expansion', body: 'Register a UMLS account, paste the API key into the VSAC source card, click Test, then Sync now. Value sets for CMS165 (Controlling High Blood Pressure) and CMS122 (Diabetes A1c) will appear as artifacts.', action: { label: 'Open VSAC card', view: 'research' } },
  { id: 'sync-kdigo', title: 'Refresh KDIGO guideline snapshots', body: 'The KDIGO CKD guideline is fetched via the PubMed adapter (search terms include "chronic kidney disease"). Trigger a sync and open the provenance drawer to see the latest PMIDs.', action: { label: 'Sync PubMed', view: 'research' } },
  { id: 'trace-measure', title: 'Trace a CMS eCQM to its source paragraph', body: 'Open the Knowledge browser, filter by publisher CMS, click the CMS eCQMs card, open Provenance, and follow any Measure→Library link to the exact FHIR resource on GitHub with SHA-256 verification.', action: { label: 'Browse eCQMs', view: 'measures' } },
  { id: 'ingest-local', title: 'Upload a facility policy PDF (Local Corpus)', body: 'Facility-specific policies live in Realm → Local Corpus. Uploaded documents run through the M19 entity compiler and produce provenance-tracked artifacts scoped to your realm only.', action: { label: 'Open Realm', view: 'realm' } },
  { id: 'run-agent', title: 'Ask a knowledge-aware agent', body: 'Every published agent has access to the full Knowledge tool bus (list_sources, sync_source, get_artifact, trace_provenance). Try: "Cite the CMS165 numerator criteria and show me the value set expansion."', action: { label: 'Open agents', view: 'agents' } },
];

export const FILES = {
  '/admin/summary': 'summary.json',
  '/admin/agents': 'agents.json',
  '/admin/measures': 'measures.json',
  '/admin/assessments': 'assessments.json',
  '/admin/lifecycle': 'lifecycle.json',
  '/admin/research/sources': 'research.json',
  '/admin/realms/demo': 'realm.json',
};

export async function api(method, path, body) {
  if (method === 'GET') {
    const [base, qs] = path.split('?');
    const file = FILES[base];
    if (!file) {
      // Not a bundled snapshot — hit the live Fastify backend (dev/prod),
      // which serves /admin/knowledge/* and friends with real data.
      try {
        const res = await fetch(path, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return await res.json();
      } catch (err) {
        console.warn('[admin-ui] GET', path, 'failed:', err instanceof Error ? err.message : err);
        return {};
      }
    }
    const raw = await loadFile(file);
    const params = new URLSearchParams(qs || '');
    if (base === '/admin/summary') return raw;
    if (base === '/admin/agents') {
      let list = raw;
      const pack = params.get('pack'); if (pack) list = list.filter(a => a.packId === pack);
      const q = (params.get('q') || '').toLowerCase();
      if (q) list = list.filter(a => (a.id + ' ' + a.displayName + ' ' + (a.description||'')).toLowerCase().includes(q));
      return { count: list.length, total: raw.length, agents: list };
    }
    if (base === '/admin/measures') return { count: raw.length, measures: raw };
    if (base === '/admin/assessments') return { count: raw.length, assessments: raw };
    if (base === '/admin/lifecycle') return { stages: raw };
    if (base === '/admin/research/sources') return { count: raw.length, sources: raw };
    if (base === '/admin/realms/demo') return raw;
    return {};
  }
  // Writes: local-only for the demo
  if (path === '/admin/drafts/validate') return clientValidate(body.yaml);
  if (path === '/admin/drafts' && method === 'POST') {
    const v = clientValidate(body.yaml);
    const existing = drafts.findIndex(d => d.packId === body.packId && d.id === body.id);
    const rec = { packId: body.packId, id: body.id, yaml: body.yaml, status: body.status || 'draft', authorRef: 'user:you', updatedAt: new Date().toISOString(), validation: v };
    if (existing >= 0) { drafts[existing] = rec; audit(body.status === 'in-review' ? 'submit-review' : 'update-draft', body.packId, body.id); }
    else { drafts.unshift(rec); audit('create-draft', body.packId, body.id); }
    saveDrafts();
    return rec;
  }
  if (path.match(/\/admin\/drafts\/[^/]+\/[^/]+\/publish$/)) {
    const [, , , packId, id] = path.split('/');
    const idx = drafts.findIndex(d => d.packId === packId && d.id === id);
    if (idx < 0) throw new Error('draft not found');
    const d = drafts[idx];
    if (!d.validation.ok) throw new Error('cannot publish invalid draft');
    // Move into agents cache (mock: mark published + move to published list)
    const agents = await loadFile('agents.json');
    const spec = clientValidate(d.yaml).spec;
    agents.unshift({ packId: d.packId, id: d.id, displayName: spec.displayName, description: spec.description, setting: spec.labels?.setting, lifecycleStage: spec.labels?.lifecycleStage, triggerKind: spec.trigger?.kind, triggerEventType: spec.trigger?.eventType, baseFeeUsd: spec.billing?.baseFeeUsd, __justPublished: true });
    cache['agents.json'] = agents;
    drafts.splice(idx, 1);
    saveDrafts();
    audit('publish', packId, id, body?.note);
    return { published: true };
  }
  if (path.match(/\/admin\/drafts\/[^/]+\/[^/]+\/reject$/)) {
    const [, , , packId, id] = path.split('/');
    const d = drafts.find(x => x.packId === packId && x.id === id);
    if (d) d.status = 'draft';
    saveDrafts();
    audit('reject', packId, id, body?.note);
    return { rejected: true };
  }
  if (path.match(/\/admin\/drafts\/[^/]+\/[^/]+$/) && method === 'DELETE') {
    const [, , , packId, id] = path.split('/');
    const idx = drafts.findIndex(d => d.packId === packId && d.id === id);
    if (idx >= 0) { drafts.splice(idx, 1); saveDrafts(); audit('delete-draft', packId, id); }
    return { deleted: true };
  }
  return {};
}

export function audit(action, packId, agentId, note) { auditLog.unshift({ timestamp: new Date().toISOString(), actorRef: 'user:you', action, packId, agentId, note: note || undefined }); saveAudit(); }

export const auditLog = [];

export const cache = {};

export async function consoleDomain() {
  if (CONSOLE_DOMAIN) return CONSOLE_DOMAIN;
  try {
    const d = (await api('GET', '/admin/console/domain')).domain || FALLBACK_DOMAIN;
    if (!d.domainOptions) d.domainOptions = FALLBACK_DOMAIN.domainOptions;
    CONSOLE_DOMAIN = d;
    S.dom = d;
  } catch (_) { CONSOLE_DOMAIN = FALLBACK_DOMAIN; S.dom = FALLBACK_DOMAIN; }
  return CONSOLE_DOMAIN;
}

export async function consoleLearn() {
  if (CONSOLE_LEARN) return CONSOLE_LEARN;
  try { CONSOLE_LEARN = (await api('GET', '/admin/console/learn')).recipes || FALLBACK_LEARN; }
  catch (_) { CONSOLE_LEARN = FALLBACK_LEARN; }
  return CONSOLE_LEARN;
}

export const drafts = [];

export async function ensurePacks() {
  if (packsLoaded) return S.PACKS;
  try {
    const data = await api('GET', '/admin/agents');
    const ids = [...new Set((data.agents || []).map((a) => a.packId).filter(Boolean))];
    if (ids.length) S.PACKS = [...new Set([...S.PACKS, ...ids])];
  } catch { /* keep fallback */ }
  packsLoaded = true;
  return S.PACKS;
}

export async function loadFile(name) {
  if (!cache[name]) cache[name] = await fetch(name).then(r => r.json());
  return cache[name];
}

export let packsLoaded = false;

export function saveAudit() { /* in-memory */ }

export function saveDrafts() { /* in-memory */ }
