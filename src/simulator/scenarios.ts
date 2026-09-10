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

const LAB_CODES = ['K', 'HGB', 'URR', 'PHOS', 'FERRITIN', 'TSAT'] as const;
const ASSESSMENTS = [
  { id: 'phq9', band: 'mild', lo: 2, hi: 6 },
  { id: 'phq9', band: 'moderate', lo: 7, hi: 12 },
  { id: 'ess', band: 'none', lo: 0, hi: 3 },
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
  }));
}

/** Record a screening assessment on a rotating ~40% subset. */
function recordAssessments({ patientIds, rng }: ScriptEmitInput): WorldEffect[] {
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

function dialysisScript(): SimScriptEntry[] {
  return [
    every('labs', 3, 'md', orderLabs),
    every('vitals', 2, 'nurse', recordVitals),
    every('assessment', 24, 'nurse', recordAssessments),
    every('followup', 6, 'md', scheduleFollowups),
    every('claims', 48, 'coder', submitClaims),
    every('safety', 18, 'nurse', safetyFlags),
    every('safety-critical', 72, 'nurse', criticalSafetyFlag),
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
          at('seed-assessment', 1, 'nurse', recordAssessments),
          every('claims', 48, 'coder', submitClaims),
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
