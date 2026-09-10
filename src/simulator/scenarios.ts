/******************************************************************************
 * Simulator — built-in scenarios.
 *
 *   dialysis-demo — the showcase: two dialysis facilities, the real liquid
 *                   (CfC/LTC) trajectory engine, and a lively scripted event
 *                   mix (labs, vitals, assessments, follow-ups, claims, safety
 *                   flags incl. one HITL-suspending critical flag).
 *   dialysis-basic — lean, legacy engine, fully deterministic — used by tests
 *                   to assert the schedule fires exactly as declared.
 *
 * Script entry `emit` builders only use `rng` for decisions, so both scenarios
 * are reproducible for a given seed + realm clock.
 ******************************************************************************/

import type { ScriptEmitInput, SimScenario, SimScriptEntry } from './types.js';
import type { WorldEffect } from '../realm/types.js';
import type { Realm } from '../realm/realm.js';

const LAB_CODES = ['K', 'HGB', 'URR', 'PHOS', 'FERRITIN', 'TSAT'] as const;
const ASSESSMENTS = [
  { id: 'phq9', band: 'mild', lo: 2, hi: 6 },
  { id: 'phq9', band: 'moderate', lo: 7, hi: 12 },
  { id: 'ess', band: 'none', lo: 0, hi: 3 },
] as const;

// ---- F1 renal protocol foundations ----
/** CKD-MBD / nutrition / inflammation / infection panel ordered on a periodic cadence. */
export const PANEL_CODES = ['CALCIUM', 'PTH', 'ALBUMIN', 'CREATININE', 'BICARB', 'CRP', 'WBC', 'PROCALCITONIN'] as const;
/** Sessions open every 48 realm-hours; telemetry/close are gated on their offset within that cycle. */
const SESSION_CYCLE_HOURS = 48;
const SESSION_TELEMETRY_OFFSET = 6;
const SESSION_END_OFFSET = 12;
const ACCESS_EVENTS = ['cannulation-difficulty', 'angioplasty', 'thrombosis', 'declot', 'infection'] as const;
const MAINTENANCE_MEDS = [
  { code: 'sevelamer', dose: '800 mg', route: 'PO', frequency: 'three times daily', indication: 'hyperphosphatemia' },
  { code: 'calcium-acetate', dose: '667 mg', route: 'PO', frequency: 'three times daily', indication: 'hyperphosphatemia' },
  { code: 'cinacalcet', dose: '30 mg', route: 'PO', frequency: 'daily', indication: 'secondary-hyperparathyroidism' },
  { code: 'calcitriol', dose: '0.25 mcg', route: 'PO', frequency: 'daily', indication: 'vitamin-d-deficiency' },
] as const;

const every = (id: string, hours: number, viaRole: SimScriptEntry['viaRole'], emit: (i: ScriptEmitInput) => WorldEffect[]): SimScriptEntry =>
  ({ id, everyHours: hours, viaRole, emit });

const at = (id: string, hour: number, viaRole: SimScriptEntry['viaRole'], emit: (i: ScriptEmitInput) => WorldEffect[]): SimScriptEntry =>
  ({ id, atHour: hour, viaRole, emit });

/** Order a rotating set of labs for every patient (some stat). Matures into results via LabMaturationProcess. */
function orderLabs({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
  return patientIds.map((pid) => ({
    kind: 'order-lab',
    patientId: pid,
    code: LAB_CODES[Math.min(LAB_CODES.length - 1, Math.floor(rng() * LAB_CODES.length))] as (typeof LAB_CODES)[number],
    priority: rng() < 0.2 ? 'stat' : 'routine',
  }));
}

/** Record drifting vitals for every patient. */
function recordVitals({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
  return patientIds.map((pid) => ({
    kind: 'record-vitals',
    patientId: pid,
    hr: 72 + Math.round(rng() * 30),
    spo2: 93 + Math.round(rng() * 6),
    bp: '128/78',
    temp: Number((36.2 + rng() * 0.7).toFixed(1)),
  }));
}

/** Record a screening assessment on a rotating ~40% subset. */function recordAssessments({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
  const a = ASSESSMENTS[Math.min(ASSESSMENTS.length - 1, Math.floor(rng() * ASSESSMENTS.length))] as (typeof ASSESSMENTS)[number];
  const pick = patientIds.filter(() => rng() < 0.4);
  return pick.map((pid) => ({
    kind: 'record-assessment',
    patientId: pid,
    assessmentId: a.id,
    score: a.lo + Math.floor(rng() * (a.hi - a.lo + 1)),
    band: a.band,
  }));
}

/** Order each on-ESA patient's current weekly ESA dose (Paper-A dosing events). */
function orderEsa({ realm }: ScriptEmitInput): WorldEffect[] {
  const out: WorldEffect[] = [];
  for (const p of realm.graph.listKind('patient')) {
    const dose = Number((p.state as { esaDose?: unknown }).esaDose);
    if (!Number.isFinite(dose) || dose <= 0) continue;
    out.push({
      kind: 'order-med', patientId: p.id, code: 'epoetin-alfa',
      dose: String(Math.round(dose)), route: 'IV', frequency: 'weekly', indication: 'anemia',
    });
  }
  return out;
}

/** Schedule a nephrology follow-up for one rotating patient. */
function scheduleFollowups({ patientIds, seq, rng }: ScriptEmitInput): WorldEffect[] {
  const pid = patientIds[seq % patientIds.length];
  if (!pid) return [];
  const when = new Date(Date.now() + 1 * 86_400_000).toISOString();
  return [{ kind: 'schedule-followup', patientId: pid, when, resource: rng() < 0.5 ? 'nephrology' : 'dietitian', followupKind: 'routine' }];
}

/** Submit a dialysis claim (single CPT — below the HITL high-dollar gate). */
function submitClaims({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
  return patientIds.map((pid) => ({
    kind: 'submit-claim',
    encounterId: `enc-${pid}`,
    payerId: rng() < 0.7 ? 'payer:medicare' : 'payer:commercial',
    cptCodes: ['90960'],
    icd10Codes: ['N18.6'],
  }));
}

/** A rotating moderate safety flag (applies; drives rules/experiences). */
function safetyFlags({ patientIds, seq, rng }: ScriptEmitInput): WorldEffect[] {
  const pid = patientIds[seq % patientIds.length];
  if (!pid) return [];
  return [{ kind: 'flag-safety-event', patientId: pid, safetyKind: rng() < 0.5 ? 'missed-treatment' : 'access-risk', severity: 'moderate' }];
}

/** A rare critical safety flag — severity 'critical' suspends into HITL for approval. */
function criticalSafetyFlag({ patientIds, seq, rng }: ScriptEmitInput): WorldEffect[] {
  const pid = patientIds[Math.floor(rng() * patientIds.length)];
  if (!pid) return [];
  return [{ kind: 'flag-safety-event', patientId: pid, safetyKind: 'lab-critical', severity: 'critical' }];
}

/** Patient state lookup keyed by patient id (access type, open session, …). */
function stateById(realm: Realm): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const p of realm.graph.listKind('patient')) out.set(p.id, p.state as Record<string, unknown>);
  return out;
}

/** F1 — open a dialysis session for every patient (fluid / adequacy protocols). */
function sessionStarts({ patientIds, rng, realm }: ScriptEmitInput): WorldEffect[] {
  const states = stateById(realm);
  return patientIds.map((pid) => {
    const catheter = (states.get(pid)?.access as { type?: string } | undefined)?.type === 'catheter';
    const prescribedMinutes = catheter ? 195 + Math.round(rng() * 20) : 210 + Math.round(rng() * 30);
    return {
      kind: 'start-session' as const,
      patientId: pid,
      modality: (rng() < 0.15 ? 'hemodiafiltration' : 'hemodialysis') as 'hemodialysis' | 'hemodiafiltration',
      prescribedMinutes,
      targetUfL: Number((1.8 + rng() * 1.7).toFixed(1)),
      dialyser: catheter ? 'FX80' : 'FX100',
      qbPrescribed: catheter ? 300 : 350,
      qdPrescribed: 500,
      tempC: 36.5,
    };
  });
}

/** F1 — one mid-session telemetry point per open session. */
function sessionTelemetry({ patientIds, rng, realm, elapsedHours }: ScriptEmitInput): WorldEffect[] {
  if (elapsedHours % SESSION_CYCLE_HOURS !== SESSION_TELEMETRY_OFFSET) return [];
  const states = stateById(realm);
  const out: WorldEffect[] = [];
  for (const pid of patientIds) {
    const current = states.get(pid)?.currentSession as { prescribedMinutes?: number; targetUfL?: number } | undefined;
    if (!current) continue;
    const prescribed = current.prescribedMinutes ?? 210;
    const target = current.targetUfL ?? 2.5;
    const catheter = (states.get(pid)?.access as { type?: string } | undefined)?.type === 'catheter';
    const roll = rng();
    out.push({
      kind: 'record-session-telemetry',
      patientId: pid,
      minute: Math.round(prescribed / 2),
      bp: `${118 + Math.round(rng() * 14)}/${74 + Math.round(rng() * 8)}`,
      hr: 76 + Math.round(rng() * 14),
      qb: catheter ? 300 : 350,
      qd: 500,
      venousPressure: 150 + Math.round(rng() * 60),
      arterialPressure: -140 - Math.round(rng() * 40),
      ufRateMlH: Math.round(((target * 1000) / Math.max(1, prescribed)) * 10) / 10,
      ufVolumeL: Number((target * 0.5).toFixed(2)),
      tempC: 36.4,
      ...(roll < 0.18 ? { symptoms: ['cramping'] } : roll < 0.26 ? { symptoms: ['hypotension'] } : {}),
    });
  }
  return out;
}

/** F1 — close each open session with delivered dose, UF, recirculation and complications. */
function sessionCloses({ patientIds, rng, realm, elapsedHours }: ScriptEmitInput): WorldEffect[] {
  if (elapsedHours % SESSION_CYCLE_HOURS !== SESSION_END_OFFSET) return [];
  const states = stateById(realm);
  const out: WorldEffect[] = [];
  for (const pid of patientIds) {
    const state = states.get(pid) ?? {};
    const current = state.currentSession as { prescribedMinutes?: number; targetUfL?: number } | undefined;
    if (!current) continue;
    const prescribed = current.prescribedMinutes ?? 210;
    const target = current.targetUfL ?? 2.5;
    const catheter = (state.access as { type?: string } | undefined)?.type === 'catheter';
    const stoppedEarly = rng() < 0.12;
    const ufVolumeL = Number((target * (stoppedEarly ? 0.7 : 0.85 + rng() * 0.15)).toFixed(2));
    const preWeightKg = Number((68 + rng() * 32).toFixed(1));
    out.push({
      kind: 'end-session',
      patientId: pid,
      deliveredMinutes: stoppedEarly ? Math.round(prescribed * 0.72) : prescribed - Math.round(rng() * 8),
      ufVolumeL,
      qbAvg: catheter ? 298 : 348,
      recirculationPct: Number((catheter ? 11 + rng() * 6 : 3.5 + rng() * 6).toFixed(1)),
      preWeightKg,
      postWeightKg: Number((preWeightKg - ufVolumeL).toFixed(1)),
      stoppedEarly,
      ...(stoppedEarly ? { complication: 'intradialytic-hypotension' } : {}),
    });
  }
  return out;
}

/** F1 — CKD-MBD / nutrition / inflammation / infection panel for every patient. */
function panelLabs({ patientIds }: ScriptEmitInput): WorldEffect[] {
  const out: WorldEffect[] = [];
  for (const pid of patientIds) {
    for (const code of PANEL_CODES) out.push({ kind: 'order-lab', patientId: pid, code, priority: 'routine' });
  }
  return out;
}

/** F1 — access surveillance observation on one rotating patient. */
function accessObservations({ patientIds, seq, rng }: ScriptEmitInput): WorldEffect[] {
  const pid = patientIds[seq % Math.max(1, patientIds.length)];
  if (!pid) return [];
  if (rng() < 0.5) return [];
  const event = ACCESS_EVENTS[Math.min(ACCESS_EVENTS.length - 1, Math.floor(rng() * ACCESS_EVENTS.length))] as (typeof ACCESS_EVENTS)[number];
  return [{ kind: 'record-access', patientId: pid, event, note: 'access surveillance (cannulation pressures, recirculation)' }];
}

/** F1 — weekly maintenance exposures: phosphate binder, calcimimetic, vitamin D, IV iron. */
function maintenanceMeds({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
  const out: WorldEffect[] = [];
  for (const pid of patientIds) {
    const med = MAINTENANCE_MEDS[Math.min(MAINTENANCE_MEDS.length - 1, Math.floor(rng() * MAINTENANCE_MEDS.length))] as (typeof MAINTENANCE_MEDS)[number];
    out.push({ kind: 'order-med', patientId: pid, code: med.code, dose: med.dose, route: med.route, frequency: med.frequency, indication: med.indication });
    if (rng() < 0.4) out.push({ kind: 'order-med', patientId: pid, code: 'ferric-sucrose', dose: '125', route: 'IV', frequency: 'weekly', indication: 'iron-deficiency' });
  }
  return out;
}

function dialysisScript(): SimScriptEntry[] {
  return [
    every('labs', 3, 'md', orderLabs),
    // Weekly ESA order for each on-ESA patient → REAL dosing events on the
    // ledger (Paper-A event stream; the anemia patient twin reads these).
    every('esa', 168, 'md', orderEsa),
    every('vitals', 2, 'nurse', recordVitals),
    every('assessment', 24, 'nurse', recordAssessments),
    every('followup', 6, 'md', scheduleFollowups),
    every('claims', 48, 'coder', submitClaims),
    every('safety', 18, 'nurse', safetyFlags),
    every('safety-critical', 72, 'nurse', criticalSafetyFlag),
    // ---- F1 renal protocol foundations: sessions, access, MBD/nutrition/infection ----
    every('session-start', 48, 'nurse', sessionStarts),
    every('session-telemetry', 6, 'nurse', sessionTelemetry),
    every('session-close', 6, 'nurse', sessionCloses),
    at('panel-baseline', 5, 'md', panelLabs),
    every('panel', 336, 'md', panelLabs),
    at('access-baseline', 8, 'nurse', accessObservations),
    every('access-surveillance', 96, 'nurse', accessObservations),
    every('maintenance-meds', 168, 'md', maintenanceMeds),
  ];
}

export const DIALYSIS_DEMO: SimScenario = {
  id: 'dialysis-demo',
  label: 'Dialysis enterprise demo',
  description: 'Two dialysis facilities running the liquid (CfC/LTC) trajectory engine with a scripted event mix — labs, vitals, assessments, follow-ups, claims and safety flags, including an HITL-suspending critical flag. One realm-hour per 250ms wall.',
  seed: 42,
  startAt: new Date('2026-08-01T06:00:00.000Z'),
  pace: { realmHoursPerTick: 1, wallMsPerTick: 250 },
  realms: [
    {
      id: 'sim:renal-a',
      trajectoryEngine: 'liquid',
      facility: { facilityId: 'riverbend-franklin', kind: 'dialysis', name: 'Riverbend Franklin', units: ['ICH-A', 'ICH-B'], patientCount: 6 },
      presences: ['md', 'nurse', 'coder'],
      script: { entries: dialysisScript() },
    },
    {
      id: 'sim:renal-b',
      trajectoryEngine: 'liquid',
      facility: { facilityId: 'riverbend-brentwood', kind: 'dialysis', name: 'Riverbend Brentwood', units: ['ICH-C', 'ICH-D'], patientCount: 6 },
      presences: ['md', 'nurse', 'coder'],
      script: { entries: dialysisScript() },
    },
  ],
};

export const DIALYSIS_BASIC: SimScenario = {
  id: 'dialysis-basic',
  label: 'Dialysis basic (deterministic)',
  description: 'A single legacy-engine facility with a minimal deterministic script — used by tests to assert the schedule fires exactly as declared.',
  seed: 7,
  startAt: new Date('2026-08-01T06:00:00.000Z'),
  pace: { realmHoursPerTick: 1, wallMsPerTick: 1000 },
  realms: [
    {
      id: 'sim:test-a',
      facility: { facilityId: 'sim-fac-a', kind: 'dialysis', name: 'Sim Facility A', units: ['U-1'], patientCount: 4 },
      presences: ['md', 'nurse', 'coder'],
      script: {
        entries: [
          every('labs', 3, 'md', orderLabs),
          every('vitals', 2, 'nurse', recordVitals),
          every('esa', 168, 'md', orderEsa),
          at('seed-assessment', 1, 'nurse', recordAssessments),
          every('claims', 48, 'coder', submitClaims),
          // F1 — keep the basic script minimal but exercise the full session
          // lifecycle so the reducer path is covered deterministically.
          every('session-start', 48, 'nurse', sessionStarts),
          every('session-telemetry', 6, 'nurse', sessionTelemetry),
          every('session-close', 6, 'nurse', sessionCloses),
        ],
      },
    },
  ],
};

export const DIALYSIS_ENTERPRISE: SimScenario = {
  id: 'dialysis-enterprise',
  label: 'Dialysis enterprise (multi-region fleet)',
  description: 'Enterprise-scale deterministic fleet — three Tennessee regions, six facilities, ~48 patients, every one running the liquid (CfC/LTC) trajectory engine with the full scripted event mix (labs, vitals, assessments, follow-ups, claims, safety flags). Completes the demo world with cross-facility breadth; launch with HH_DEMO_SIM_SCENARIO=dialysis-enterprise.',
  seed: 2026,
  startAt: new Date('2026-08-01T06:00:00.000Z'),
  pace: { realmHoursPerTick: 1, wallMsPerTick: 350 },
  realms: [
    { id: 'sim:ent-midtn-a', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-nashville-a', kind: 'dialysis', name: 'Riverbend Nashville A (Middle TN)', units: ['ICH-A', 'ICH-B', 'ICH-C'], patientCount: 8 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
    { id: 'sim:ent-midtn-b', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-nashville-b', kind: 'dialysis', name: 'Riverbend Nashville B (Middle TN)', units: ['ICH-D', 'ICH-E'], patientCount: 6 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
    { id: 'sim:ent-easttn-a', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-knoxville-a', kind: 'dialysis', name: 'Riverbend Knoxville (East TN)', units: ['ICH-A', 'ICH-B', 'ICH-C'], patientCount: 8 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
    { id: 'sim:ent-easttn-b', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-chattanooga-a', kind: 'dialysis', name: 'Riverbend Chattanooga (East TN)', units: ['ICH-A', 'ICH-B'], patientCount: 6 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
    { id: 'sim:ent-westtn-a', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-memphis-a', kind: 'dialysis', name: 'Riverbend Memphis (West TN)', units: ['ICH-A', 'ICH-B', 'ICH-C'], patientCount: 8 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
    { id: 'sim:ent-westtn-b', trajectoryEngine: 'liquid', facility: { facilityId: 'rb-jackson-a', kind: 'dialysis', name: 'Riverbend Jackson (West TN)', units: ['ICH-A', 'ICH-B'], patientCount: 6 }, presences: ['md', 'nurse', 'coder'], script: { entries: dialysisScript() } },
  ],
};

const SCENARIOS: SimScenario[] = [DIALYSIS_DEMO, DIALYSIS_BASIC, DIALYSIS_ENTERPRISE];

export function listScenarios(): Array<{ id: string; label: string; description: string; seed: number; realms: number }> {
  return SCENARIOS.map((s) => ({ id: s.id, label: s.label, description: s.description, seed: s.seed, realms: s.realms.length }));
}

export function scenarioFor(id: string): SimScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
