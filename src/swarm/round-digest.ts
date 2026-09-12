// "Since your last round" — the answer to the question a clinician actually asks
// when they sit down: what changed while I was not looking, and what is new?
//
// The whole design problem here is the BASELINE. A digest of "the fleet is bad" is
// worthless; a digest of "these four patients got worse since your last round, in
// this order" is a worklist. That needs a stored snapshot, so a round can be closed
// explicitly and the next one diffed against it. There is no way to reconstruct the
// past severity of a patient from the ledger — severity is a function of the whole
// window at a moment — so the snapshot is the only honest baseline, and when there
// is none the digest says so instead of presenting "everything is new".
//
// Two rules the diff obeys:
//   1. A movement under the floor (< 0.05 severity) is not reported as change. These
//      severities come from fixed rules, so a zero-drift patient must not appear at
//      all just because a mean moved in the fourth decimal.
//   2. "Newly at risk" means green/unknown BEFORE and red/amber NOW — not merely a
//      rise. A patient who was already red and got redder is a "worsened", and
//      calling that "new" would make the digest look like it found more than it did.
import { RENAL_PROTOCOLS, evaluateProtocolForPatient, protocolById, type ProtocolStatus } from '../protocols/registry.js';
import type { RenalPatientFacts } from '../swarm/renal-cohort.js';

/** A severity move smaller than this is not reported as a change. */
export const ROUND_MOVEMENT_FLOOR = 0.05;

export type RoundDirection = 'worsened' | 'improved';

export interface RoundProtocolState {
  status: ProtocolStatus;
  severity: number;
}

export interface RoundPatientState {
  patientId: string;
  realmId: string;
  facilityId?: string;
  /** Worst status across every protocol, and the worst severity that produced it. */
  worstStatus: ProtocolStatus;
  worstSeverity: number;
  /** The protocol that carries the worst status — what to look at first. */
  worstProtocol: string;
  protocols: Record<string, RoundProtocolState>;
}

export interface RoundSnapshot {
  takenAt: string;
  takenBy: string;
  patients: RoundPatientState[];
}

export interface RoundMovement {
  patientId: string;
  realmId: string;
  facilityId?: string;
  protocol: string;
  protocolLabel: string;
  substate: string;
  before: RoundProtocolState;
  after: RoundProtocolState;
  /** Positive = worse. */
  deltaSeverity: number;
  direction: RoundDirection;
  /** True only when the patient crossed from green/unknown into red/amber. */
  newlyAtRisk: boolean;
  drivers: string[];
}

export interface RoundDigest {
  /** Null when no previous round has been recorded — the digest then says so. */
  since: { takenAt: string; takenBy: string; patients: number } | null;
  now: { takenAt: string; takenBy: string; patients: number };
  movements: RoundMovement[];
  /** Patients that crossed into red/amber, worst first. */
  newlyAtRisk: RoundMovement[];
  /** Patients that were red/amber before and are no longer. */
  improved: RoundMovement[];
  /** Patients present in the previous round but absent now (discharged, removed). */
  departed: Array<{ patientId: string; realmId: string; worstStatus: ProtocolStatus; worstSeverity: number }>;
  /** Patients with no previous record at all. */
  appeared: RoundPatientState[];
  summary: {
    worsened: number;
    improved: number;
    unchanged: number;
    newlyAtRisk: number;
    netSeverityChange: number;
    /** Fleet-wide worst severity now vs before. */
    fleetSeverityNow: number;
    fleetSeverityBefore: number;
  };
  reading: string[];
}

const AT_RISK: readonly ProtocolStatus[] = ['red', 'amber'];

/** Worst status wins red > amber > green > unknown; ties break on the higher severity. */
const WORSE: Record<ProtocolStatus, number> = { red: 3, amber: 2, green: 1, unknown: 0 };

/**
 * Snapshot every patient × protocol.
 *
 * This runs the SAME per-patient evaluation the cockpit uses, so the digest can
 * never disagree with the board the reader is looking at. It deliberately does not
 * reuse the cockpit's patient list: that is sliced to 30 for display, and a digest
 * computed over a slice would silently stop mentioning a whole facility.
 */
export function snapshotRound(
  facts: readonly RenalPatientFacts[],
  opts: { takenBy: string; takenAt: string },
): RoundSnapshot {
  return {
    takenAt: opts.takenAt,
    takenBy: opts.takenBy,
    patients: facts.map((f) => {
      const protocols: Record<string, RoundProtocolState> = {};
      let worstStatus: ProtocolStatus = 'unknown';
      let worstSeverity = 0;
      let worstProtocol = '';
      for (const p of RENAL_PROTOCOLS) {
        const row = evaluateProtocolForPatient(p.id, f);
        protocols[p.id] = { status: row.status, severity: row.severity };
        // Red beats amber beats green; a tie goes to the higher severity so the
        // named protocol is the one actually driving the number.
        if (
          WORSE[row.status] > WORSE[worstStatus]
          || (WORSE[row.status] === WORSE[worstStatus] && row.severity > worstSeverity)
        ) {
          worstStatus = row.status;
          worstSeverity = row.severity;
          worstProtocol = p.id;
        }
      }
      return {
        patientId: f.patientId,
        realmId: f.realmId,
        ...(f.facilityId !== undefined ? { facilityId: f.facilityId } : {}),
        worstStatus,
        worstSeverity,
        worstProtocol,
        protocols,
      };
    }),
  };
}

/** Per-protocol drivers, so a movement names what moved rather than only how much. */
function driversFor(protocol: string, facts: readonly RenalPatientFacts[], patientId: string): string[] {
  const f = facts.find((x) => x.patientId === patientId);
  if (!f) return [];
  return evaluateProtocolForPatient(protocol as Parameters<typeof evaluateProtocolForPatient>[0], f).drivers;
}

/**
 * Diff two rounds.
 *
 * Signature deliberately avoids the round timestamps: a re-run over unchanged data
 * must produce a byte-identical digest, so it can be asserted and diffed in tests
 * and support.
 */
export function diffRounds(
  before: RoundSnapshot | null,
  after: RoundSnapshot,
  facts: readonly RenalPatientFacts[] = [],
  opts: { floor?: number; limit?: number } = {},
): RoundDigest {
  const floor = opts.floor ?? ROUND_MOVEMENT_FLOOR;
  const nowBy = new Map(after.patients.map((p) => [p.patientId, p]));

  if (!before) {
    return {
      since: null,
      now: { takenAt: after.takenAt, takenBy: after.takenBy, patients: after.patients.length },
      movements: [],
      newlyAtRisk: [],
      improved: [],
      departed: [],
      appeared: [],
      summary: {
        worsened: 0, improved: 0, unchanged: 0, newlyAtRisk: 0, netSeverityChange: 0,
        fleetSeverityNow: fleetSeverity(after), fleetSeverityBefore: fleetSeverity(after),
      },
      // No baseline is a FACT ABOUT THE RECORD, not a quiet empty digest. Without
      // this, an operator reads "nothing changed" when nothing has been recorded.
      reading: [
        'No previous round has been recorded, so there is nothing to compare against. This is the baseline: close a round to start comparing.',
      ],
    };
  }

  const beforeBy = new Map(before.patients.map((p) => [p.patientId, p]));
  const movements: RoundMovement[] = [];

  for (const patient of after.patients) {
    const prev = beforeBy.get(patient.patientId);
    if (!prev) continue;
    for (const p of RENAL_PROTOCOLS) {
      const a = patient.protocols[p.id];
      const b = prev.protocols[p.id];
      // A protocol the previous round did not evaluate cannot be diffed; skip
      // rather than treat the missing side as zero, which would invent a movement.
      if (!a || !b) continue;
      const delta = Math.round((a.severity - b.severity) * 1000) / 1000;
      if (Math.abs(delta) < floor) continue;
      movements.push({
        patientId: patient.patientId,
        realmId: patient.realmId,
        ...(patient.facilityId !== undefined ? { facilityId: patient.facilityId } : {}),
        protocol: p.id,
        protocolLabel: p.label,
        substate: p.substate,
        before: b,
        after: a,
        deltaSeverity: delta,
        direction: delta > 0 ? 'worsened' : 'improved',
        newlyAtRisk: delta > 0 && !AT_RISK.includes(b.status) && AT_RISK.includes(a.status),
        drivers: driversFor(p.id, facts, patient.patientId),
      });
    }
  }

  // Worsening first, then the size of the move — "what got worse, worst" is the
  // order a round is worked in. Improvements come after, and are never first.
  movements.sort(
    (x, y) =>
      Number(y.direction === 'worsened') - Number(x.direction === 'worsened')
      || Math.abs(y.deltaSeverity) - Math.abs(x.deltaSeverity)
      || x.patientId.localeCompare(y.patientId),
  );

  const newlyAtRisk = movements.filter((m) => m.newlyAtRisk);
  const improved = movements.filter((m) => m.direction === 'improved');
  const worsened = movements.filter((m) => m.direction === 'worsened');

  const departed = before.patients
    .filter((p) => !nowBy.has(p.patientId))
    .map((p) => ({ patientId: p.patientId, realmId: p.realmId, worstStatus: p.worstStatus, worstSeverity: p.worstSeverity }))
    .sort((a, b) => b.worstSeverity - a.worstSeverity);

  const appeared = after.patients.filter((p) => !beforeBy.has(p.patientId));

  const changed = new Set(movements.map((m) => m.patientId));
  const unchanged = after.patients.filter((p) => !changed.has(p.patientId) && beforeBy.has(p.patientId)).length;

  const fleetNow = fleetSeverity(after);
  const fleetBefore = fleetSeverity(before);

  const reading: string[] = [];
  if (worsened.length === 0 && improved.length === 0) {
    reading.push(
      `Nothing moved by more than ${floor} severity points since ${before.takenAt} — across ${after.patients.length} patient(s) and ${RENAL_PROTOCOLS.length} protocols, the picture is unchanged.`,
    );
  } else {
    reading.push(
      `${worsened.length} protocol patient-state(s) worsened and ${improved.length} improved since ${before.takenAt} (floor ${floor}).`,
    );
  }
  if (newlyAtRisk.length > 0) {
    const first = newlyAtRisk[0]!;
    reading.push(
      `${newlyAtRisk.length} patient-protocol(s) crossed into red/amber — the most severe is ${first.patientId} · ${first.protocolLabel} (${Math.round(first.before.severity * 100)}% → ${Math.round(first.after.severity * 100)}%).`,
    );
  } else if (movements.length > 0) {
    reading.push('No patient crossed into red or amber — the movement is within bands that were already being worked.');
  }
  if (departed.length > 0) {
    reading.push(`${departed.length} patient(s) from the previous round are no longer in the cohort (discharged, transferred or removed) and are not counted as improved.`);
  }
  if (appeared.length > 0) {
    reading.push(`${appeared.length} patient(s) have no previous record, so they are listed as new rather than as a movement.`);
  }
  reading.push(
    `Fleet-wide worst severity ${(fleetBefore * 100).toFixed(1)}% → ${(fleetNow * 100).toFixed(1)}% (${fleetNow >= fleetBefore ? '+' : ''}${((fleetNow - fleetBefore) * 100).toFixed(1)} pts).`,
  );

  return {
    since: { takenAt: before.takenAt, takenBy: before.takenBy, patients: before.patients.length },
    now: { takenAt: after.takenAt, takenBy: after.takenBy, patients: after.patients.length },
    movements: opts.limit !== undefined ? movements.slice(0, opts.limit) : movements,
    newlyAtRisk,
    improved,
    departed,
    appeared,
    summary: {
      worsened: worsened.length,
      improved: improved.length,
      unchanged,
      newlyAtRisk: newlyAtRisk.length,
      netSeverityChange: Math.round((fleetNow - fleetBefore) * 1000) / 1000,
      fleetSeverityNow: fleetNow,
      fleetSeverityBefore: fleetBefore,
    },
    reading,
  };
}

/** Mean worst severity across the cohort — one number for "how is the unit doing". */
function fleetSeverity(snapshot: RoundSnapshot): number {
  if (snapshot.patients.length === 0) return 0;
  const total = snapshot.patients.reduce((n, p) => n + p.worstSeverity, 0);
  return Math.round((total / snapshot.patients.length) * 1000) / 1000;
}

/** The protocol a movement belongs to, for a label lookup by id. */
export function protocolLabel(id: string): string {
  return protocolById(id)?.label ?? id;
}
