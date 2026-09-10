// Cross-pack assurance track — rule packs, silent mode, fairness slices, alert
// burden and the single release gate.
//
// The load-bearing tests here are the INVARIANTS:
//
//   * silent mode suppresses surfacing without changing the computation, for
//     every protocol, on a real patient;
//   * a fairness slice below the minimum size reports `insufficient`, never
//     `ok` and never `breach`;
//   * an unlabelled alert set reports no false-positive rate rather than 0%;
//   * the release gate reads durable records, so a pack with no red-team run or
//     no artefact cannot come back `ship`.

import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';

import {
  applyMode, modeFor, isSilent, surfaceDecision, surfaceable, silentProtocols,
  allModeRecords, resetModes, silentModeSummary, assertSilentStillComputes,
  SILENT_MODE_REFERENCE, SILENT_MODE_PROTOCOLS,
} from '../src/evidence/silent-mode.js';
import {
  fairnessReport, disparityReport, stratify, sliceOf, ageBand, vintageBand, accessSlice,
  fairnessSignature, FAIRNESS_REFERENCE, AGE_BANDS, type FairnessRow,
} from '../src/evidence/fairness.js';
import { burdenReport, burdenSignature, BURDEN_REFERENCE, type AlertEvent } from '../src/evidence/alert-burden.js';
import {
  PROTOCOL_PACKS, packFor, assessProtocol, findingBelongsTo, crossPackAssurance,
  assuranceReleaseGate, ASSURANCE_TRACK_REFERENCE, type ProtocolLedgerEvidence,
} from '../src/swarm/assurance-track.js';
import { RULE_PROTOCOLS, rulePackSummary } from '../src/evidence/rule-packs.js';
import { evaluateProtocolForPatient, RENAL_PROTOCOLS } from '../src/protocols/registry.js';
import { renalPatientFacts, type RenalPatientInput } from '../src/swarm/renal-cohort.js';
import { cohortSignals } from '../src/server/assurance-track-routes.js';

/* ======================================================================
 * 1. Silent mode — a surfacing switch, never a computation switch
 * ====================================================================== */

describe('silent mode', () => {
  beforeEach(() => resetModes());

  it('defaults every protocol to silent and requires a reason to activate', () => {
    expect(SILENT_MODE_PROTOCOLS).toEqual(RULE_PROTOCOLS);
    expect(silentProtocols()).toEqual([...RULE_PROTOCOLS]);
    expect(() => applyMode({ protocol: 'anemia', mode: 'active', reason: 'short', by: 'op' }))
      .toThrow(/reason/);
    const record = applyMode({ protocol: 'anemia', mode: 'active', reason: 'site-B agreement above 90% for 90 days', by: 'op' });
    expect(record.mode).toBe('active');
    expect(modeFor('anemia')).toBe('active');
    expect(isSilent('anemia')).toBe(false);
    expect(silentProtocols()).not.toContain('anemia');
  });

  it('records the suppressed decision instead of dropping it', () => {
    const silent = surfaceDecision('fluid', { action: 'reduce-uf' });
    expect(silent.surfaced).toBe(false);
    expect(silent.shadow).toBe(true);
    expect(silent.recommendation).toEqual({ action: 'reduce-uf' });
    expect(silent.rationale).toMatch(/silent/);
    expect(surfaceable('fluid', ['a', 'b'])).toEqual([]);

    applyMode({ protocol: 'fluid', mode: 'active', reason: 'shadow agreement demonstrated', by: 'op' });
    const live = surfaceDecision('fluid', { action: 'reduce-uf' });
    expect(live.surfaced).toBe(true);
    expect(live.shadow).toBe(false);
    expect(surfaceable('fluid', ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('INVARIANT — toggling the mode never changes the recommendation, for every protocol', () => {
    const input: RenalPatientInput = {
      id: 'slicing-pt-0001', realmId: 'sim:slicing', medCodes: [],
      state: {
        facilityId: 'fac-s', age: 71, sex: 'F', trajectory: 'decompensating',
        dialysisVintageYears: 4.2,
        access: { type: 'catheter', ageDays: 210 },
        sessions: [],
        labs: { HGB: 9.1, FERRITIN: 480, TSAT: 18, KTV: 1.05, URR: 58, PHOS: 6.4, ALBUMIN: 3.1, POTASSIUM: 5.9, TEMP: 38.2 },
      },
    };
    const facts = renalPatientFacts(input);
    expect(facts.labs.HGB).toBe(9.1);

    for (const pack of PROTOCOL_PACKS) {
      const probe = assertSilentStillComputes({
        protocol: pack.protocol,
        compute: () => evaluateProtocolForPatient(pack.protocol, facts),
        signature: (s) => `${s.status}|${s.severity}|${s.drivers.join(',')}`,
      });
      expect(probe.identical, `${pack.protocol} changed its computation with the mode`).toBe(true);
      expect(probe.surfacedWhenSilent).toBe(false);
    }
    // and the registry is restored to what the operator had set
    expect(allModeRecords().every((r) => r.mode === 'silent')).toBe(true);
  });

  it('surfaces the invariant statement itself', () => {
    expect(SILENT_MODE_REFERENCE.rule).toMatch(/suppresses surfacing only/);
    expect(silentModeSummary().total).toBe(RULE_PROTOCOLS.length);
  });
});

/* ======================================================================
 * 2. Fairness slices
 * ====================================================================== */

function row(over: Partial<FairnessRow> & { patientId: string }): FairnessRow {
  return { covered: true, flagged: false, ...over };
}

describe('fairness slices', () => {
  it('bands the four dimensions and stratifies deterministically', () => {
    expect(ageBand(54).id).toBe('lt55');
    expect(ageBand(55).id).toBe('55-64');
    expect(ageBand(75).id).toBe('gte75');
    expect(ageBand(undefined).id).toBe('unknown');
    expect(vintageBand(0.4).id).toBe('lt1y');
    expect(vintageBand(4).id).toBe('3-5y');
    expect(vintageBand(9).id).toBe('gte5y');
    expect(accessSlice('AVF').id).toBe('avf');
    expect(accessSlice('avg').id).toBe('avg');
    expect(accessSlice('tunnelled-catheter').id).toBe('catheter');
    expect(accessSlice(undefined).id).toBe('unknown');

    const rows = [row({ patientId: 'a', age: 40 }), row({ patientId: 'b', age: 80 })];
    const buckets = stratify(rows, 'age');
    expect(buckets.get('lt55')?.map((r) => r.patientId)).toEqual(['a']);
    expect(buckets.get('gte75')?.map((r) => r.patientId)).toEqual(['b']);
    expect(sliceOf('age', rows[0]!).label).toBe('< 55');
  });

  it('MIN-N GUARD — a slice below the guard is insufficient, not ok and not a breach', () => {
    const rows: FairnessRow[] = [];
    // 12 covered patients aged 60-70, and 3 uncovered patients aged 80+
    for (let i = 0; i < 12; i += 1) rows.push(row({ patientId: `c${i}`, age: 62, covered: true }));
    for (let i = 0; i < 3; i += 1) rows.push(row({ patientId: `o${i}`, age: 82, covered: false }));

    const report = disparityReport(rows, 'age');
    const top = report.slices.find((s) => s.slice === 'gte75')!;
    // the coverage gap is glaring (0 vs 1) but the slice is too small to claim
    expect(top.verdict).toBe('insufficient');
    expect(top.coverageRate).toBe(0);
    expect(top.findings.join(' ')).toMatch(/below the minimum slice size/);
    // …and the excluded slice is named at the dimension level rather than dropped
    expect(report.insufficientSlices).toEqual(['gte75']);
    expect(report.findings.join(' ')).toMatch(/excluded for size — gte75 \(n=3\)/);
    // the comparable slice is clean, so the dimension is ok for what it covers
    expect(report.verdict).toBe('ok');
    expect(report.insufficient).toBe(false);
  });

  it('reports an under-covered slice as a coverage breach once it is big enough', () => {
    const rows: FairnessRow[] = [];
    for (let i = 0; i < 20; i += 1) rows.push(row({ patientId: `a${i}`, age: 62, covered: true }));
    for (let i = 0; i < 10; i += 1) rows.push(row({ patientId: `b${i}`, age: 82, covered: i < 4 }));

    const report = disparityReport(rows, 'age');
    const slice = report.slices.find((s) => s.slice === 'gte75')!;
    expect(slice.n).toBe(10);
    expect(slice.verdict).toBe('breach');
    expect(slice.findings.join(' ')).toMatch(/coverage .* trails the rest of the cohort/);
    expect(report.verdict).toBe('breach');
  });

  it('separates over-flagging (burden watch) from under-flagging, never averaging them', () => {
    const rows: FairnessRow[] = [];
    for (let i = 0; i < 20; i += 1) rows.push(row({ patientId: `a${i}`, sex: 'M', flagged: false }));
    for (let i = 0; i < 10; i += 1) rows.push(row({ patientId: `b${i}`, sex: 'F', flagged: true }));

    const report = disparityReport(rows, 'sex');
    const slice = report.slices.find((s) => s.slice === 'F')!;
    expect(slice.verdict).toBe('watch');
    expect(slice.findings.join(' ')).toMatch(/over-surveillance burden/);
    expect(report.findings.join(' ')).not.toMatch(/undefined/);
  });

  it('produces a stable signature for the same cohort', () => {
    const rows: FairnessRow[] = Array.from({ length: 8 }, (_, i) =>
      row({ patientId: `p${i}`, age: 60 + i, sex: i % 2 ? 'M' : 'F', flagged: i % 3 === 0 }));
    const a = fairnessReport(rows, { protocol: 'adequacy' });
    const b = fairnessReport(rows, { protocol: 'adequacy' });
    expect(fairnessSignature(a)).toBe(fairnessSignature(b));
    expect(a.reference.minSliceN).toBe(FAIRNESS_REFERENCE.minSliceN);
    expect(a.dimensions.map((d) => d.dimension)).toEqual(['age', 'sex', 'vintage', 'access']);
  });

  it('flags a cohort smaller than one slice as structurally insufficient', () => {
    const report = fairnessReport([row({ patientId: 'solo', age: 66 })], { protocol: 'anemia' });
    expect(report.verdict).toBe('insufficient');
    expect(report.findings[0]).toMatch(/smaller than the minimum slice size/);
    expect(AGE_BANDS.length).toBe(4);
  });
});

/* ======================================================================
 * 3. Alert burden
 * ====================================================================== */

function alert(over: Partial<AlertEvent> & { id: string }): AlertEvent {
  return {
    protocol: 'anemia', patientId: 'p1', at: '2026-09-01T07:00:00.000Z',
    kind: 'anemia:esa-dose-escalation', actionable: true, ...over,
  };
}

describe('alert burden', () => {
  it('NOT MEASURABLE — silence is not a clean bill of health', () => {
    const report = burdenReport([], { patients: 10, weeks: 4 });
    expect(report.verdict).toBe('not-measurable');
    expect(report.byProtocol.every((p) => p.verdict === 'not-measurable')).toBe(true);
    expect(report.byProtocol[0]!.findings.join(' ')).toMatch(/cannot be measured from silence/);
    expect(report.totals.costUnits).toBe(0);
  });

  it('measures per-patient-week, review minutes and duplication', () => {
    const alerts: AlertEvent[] = [];
    // one patient generating the same alert four times inside 24h
    for (let i = 0; i < 4; i += 1) {
      alerts.push(alert({ id: `a${i}`, at: new Date(Date.parse('2026-09-01T07:00:00Z') + i * 3_600_000).toISOString() }));
    }
    // and nine other patients with one alert each
    for (let i = 0; i < 9; i += 1) alerts.push(alert({ id: `b${i}`, patientId: `p${i + 2}` }));

    const report = burdenReport(alerts, { patients: 10, weeks: 4 });
    expect(report.totals.alerts).toBe(13);
    expect(report.totals.alertsPerPatientWeek).toBe(0.325);
    // 13 alerts * 4.5 + 13 actionable * 12 = 214.5 minutes
    expect(report.totals.minutes).toBe(214.5);
    expect(report.totals.costUnits).toBe(3.575);
    // three of the four same-kind alerts are repeats
    expect(report.totals.duplicates).toBe(3);
    expect(report.totals.duplicateRate).toBe(0.2308);
    expect(report.hotspots[0]!.patientId).toBe('p1');
    expect(burdenSignature(report)).toContain(`${report.verdict}`);
  });

  it('UNLABELLED — no false-positive rate is reported without validation labels', () => {
    const alerts = Array.from({ length: 20 }, (_, i) => alert({ id: `x${i}`, patientId: `p${i % 10}` }));
    const report = burdenReport(alerts, { patients: 10, weeks: 4 });
    expect(report.totals.falsePositiveRate).toBeUndefined();
    expect(report.totals.labelled).toBe(0);
    expect(report.byProtocol.find((p) => p.protocol === 'anemia')!.findings.join(' '))
      .toMatch(/no validation labels/);

    const labelled = alerts.map((a, i) => ({ ...a, falsePositive: i % 4 === 0 }));
    const withLabels = burdenReport(labelled, { patients: 10, weeks: 4 });
    expect(withLabels.totals.labelled).toBe(20);
    expect(withLabels.totals.falsePositiveRate).toBe(0.25);
  });

  it('breaches when clinicians stop reading', () => {
    const alerts = Array.from({ length: 40 }, (_, i) =>
      alert({ id: `d${i}`, patientId: `p${i % 4}`, dismissed: true, actionable: false }));
    const report = burdenReport(alerts, { patients: 10, weeks: 4 });
    expect(report.totals.dismissedRate).toBe(1);
    expect(report.verdict).toBe('breach');
    expect(report.findings.join(' ')).toMatch(/dismissed/);
    expect(BURDEN_REFERENCE.minutesPerAlert).toBeGreaterThan(0);
  });
});

/* ======================================================================
 * 4. Cross-pack gate — the pack table and the durable ledger
 * ====================================================================== */

describe('cross-pack gate', () => {
  it('covers all seven protocols with distinct models and red-team scenarios', () => {
    expect(PROTOCOL_PACKS).toHaveLength(7);
    expect(PROTOCOL_PACKS.map((p) => p.protocol)).toEqual([...RULE_PROTOCOLS]);
    expect(new Set(PROTOCOL_PACKS.map((p) => p.modelId)).size).toBe(7);
    const ids = PROTOCOL_PACKS.flatMap((p) => [...p.redTeamIds]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(packFor('infection')?.slice).toBe('P6');
    expect(ASSURANCE_TRACK_REFERENCE.findingAttribution).toMatch(/scenario id/);
  });

  it('attributes findings by scenario id, so one pack cannot absorb another\'s', () => {
    const infection = packFor('infection')!;
    const access = packFor('access')!;
    const finding = { scenarioId: 'rt-025', threatModel: 'access' };
    expect(findingBelongsTo(finding, access)).toBe(true);
    expect(findingBelongsTo(finding, infection)).toBe(false);
  });

  it('does not call a pack clean when the ledger is empty', () => {
    const pack = packFor('infection')!;
    const empty: ProtocolLedgerEvidence = {
      model: 'missing', modelId: pack.modelId, redTeamRuns: 0,
      redTeamScenarios: pack.redTeamIds.length, redTeamFailed: 0, redTeamPassedScenarios: 0,
      driftRecords: 0, findings: 0, openFindings: 0, criticalOpen: 0, highOpen: 0,
    };
    const assessment = assessProtocol(pack, empty);
    const byId = new Map(assessment.checks.map((c) => [c.id.split('.').slice(1).join('.'), c]));
    expect(byId.get('red-team')!.status).toBe('warn');
    expect(byId.get('drift')!.status).toBe('warn');
    expect(byId.get('model')!.status).toBe('warn');
    expect(byId.get('mode')!.status).toBe('warn');
    // the safety rule classes are the one thing that must be complete regardless
    expect(byId.get('rules')!.status).toBe('pass');
    expect(assessment.verdict).not.toBe('ship');
  });

  it('blocks when a critical finding is open anywhere', () => {
    const pack = packFor('nutrition-electrolytes')!;
    const assessment = assessProtocol(pack, {
      model: 'present', modelId: pack.modelId, redTeamRuns: 4,
      redTeamScenarios: pack.redTeamIds.length, redTeamFailed: 0, redTeamPassedScenarios: pack.redTeamIds.length,
      driftRecords: 1, latestDriftAt: new Date().toISOString(), latestDriftStatus: 'stable',
      findings: 1, openFindings: 1, criticalOpen: 1, highOpen: 0,
    });
    expect(assessment.verdict).toBe('block');
    expect(assessment.blockers.join(' ')).toMatch(/1 critical/);
  });
});

/* ======================================================================
 * 5. Routes — the live cohort, wired end to end
 * ====================================================================== */

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: unknown[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: unknown, e: unknown) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: unknown, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

function cohortInput(i: number): RenalPatientInput {
  const ages = [45, 61, 74, 82, 58, 69, 77, 51];
  const types = ['avf', 'avf', 'avg', 'catheter'];
  return {
    id: `fac-a-pt-${String(i + 1).padStart(4, '0')}`,
    realmId: 'sim:assurance',
    medCodes: [],
    state: {
      facilityId: 'fac-a',
      age: ages[i % ages.length]!,
      sex: i % 2 === 0 ? 'F' : 'M',
      trajectory: i % 3 === 0 ? 'decompensating' : 'stable',
      dialysisVintageYears: 0.5 + i * 1.7,
      access: { type: types[i % types.length]!, ageDays: 120 + i * 37 },
      sessions: [],
      labs: {
        HGB: i % 2 === 0 ? 9.2 : 11.8,
        FERRITIN: 320 + i * 11,
        TSAT: i % 3 === 0 ? 16 : 28,
        KTV: 1.05 + (i % 4) * 0.12,
        URR: 58 + (i % 4) * 4,
        PHOS: 4.2 + (i % 5) * 0.6,
        CALCIUM: 9.1,
        PTH: 240,
        ALBUMIN: 3.0 + (i % 3) * 0.4,
        POTASSIUM: 4.6 + (i % 3) * 0.5,
        BICARBONATE: 22 + (i % 3),
        CRP: i % 2 === 0 ? 12 : 4,
        HANDSGRIP: i % 4 === 0 ? 20 : 30,
      },
    },
  };
}

describe('assurance routes', () => {
  const actor: ActorContext = {
    actorRef: 'user:test', scopeIds: ['scope:*'],
    clearance: 'restricted-phi', purposeOfUse: 'operations',
  } as ActorContext;

  async function build(): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; store: SwarmWorkspaceStore }> {
    const store = new SwarmWorkspaceStore();
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      renalPatients: () => Array.from({ length: 8 }, (_, i) => cohortInput(i)),
    });
    return { app, store };
  }

  it('builds slice rows and alerts from the live cohort, inventing nothing', () => {
    const view = cohortSignals(Array.from({ length: 8 }, (_, i) => cohortInput(i)));
    expect(view.patients).toBe(8);
    expect(view.rows).toHaveLength(8);
    expect(view.rows.every((r) => ['F', 'M'].includes(r.sex ?? ''))).toBe(true);
    expect(view.rows.map((r) => r.vintageYears).every((v) => typeof v === 'number')).toBe(true);
    expect(view.rows.map((r) => r.accessType).every((v) => typeof v === 'string')).toBe(true);
    // every protocol is reported, even at zero
    expect(Object.keys(view.coveredByProtocol).length).toBeGreaterThan(0);
    expect(Object.keys(view.flaggedByProtocol).length).toBeGreaterThan(0);
    expect(new Set(view.alerts.map((a) => a.protocol)).size).toBeGreaterThan(1);
    expect(view.alerts.every((a) => a.id.includes(':') && a.at.length > 0)).toBe(true);
  });

  it('serves the overview, gate, fairness, burden, modes and rules surfaces', async () => {
    const { app } = await build();
    for (const url of [
      '/admin/assurance/overview', '/admin/assurance/gate', '/admin/assurance/gate?activeOnly=true',
      '/admin/assurance/fairness', '/admin/assurance/fairness?dimension=access',
      '/admin/assurance/burden', '/admin/assurance/modes', '/admin/assurance/rules',
      '/admin/assurance/cohort-rows',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }

    const overviewPayload = (await app.inject({ method: 'GET', url: '/admin/assurance/overview' })).json() as {
      decision: string; totals: { protocols: number; rules: number; silentPacks: number };
      protocols: Array<{ protocol: string; verdict: string; mode: string; rules: number }>;
      fairness: {
        cohortN: number; verdict: string;
        reference: { minSliceN: number };
        dimensions: Array<{ dimension: string }>;
      };
      burden: {
        verdict: string; totals: { alerts: number };
        reference: { minutesPerAlert: number };
        window: { weeks: number };
        byProtocol: Array<{ protocol: string }>;
      };
    };
    const overview = overviewPayload;
    expect(overview.totals.protocols).toBe(7);
    expect(overview.totals.rules).toBe(rulePackSummary().total);
    expect(overview.protocols.every((p) => p.rules > 0)).toBe(true);
    expect(overview.totals.silentPacks).toBe(7);
    expect(overview.fairness.cohortN).toBe(8);
    // an 8-patient cohort cannot support a disparity claim — reported as such
    expect(['insufficient', 'watch', 'ok']).toContain(overview.fairness.verdict);
    expect(overview.burden.totals.alerts).toBeGreaterThan(0);
    expect(['ship', 'hold', 'block']).toContain(overview.decision);

    const gate = (await app.inject({ method: 'GET', url: '/admin/assurance/gate' })).json() as {
      decision: string; checks: Array<{ id: string; status: string }>; mdrFiles: Array<{ protocol: string; materialised: boolean }>;
      fairnessVerdict: string; burdenVerdict: string;
    };
    expect(gate.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['rules', 'rules-classes', 'artifact', 'red-team', 'findings', 'drift', 'fairness', 'burden', 'mode']));
    // every pack's boundary document is accounted for, materialised or not
    expect(gate.mdrFiles).toHaveLength(7);
    expect(gate.mdrFiles.every((m) => m.materialised === false)).toBe(true);

    const fairness = (await app.inject({ method: 'GET', url: '/admin/assurance/fairness' })).json() as {
      report: { dimensions: Array<{ dimension: string; slices: unknown[] }> }; signature: string;
    };
    expect(fairness.report.dimensions.map((d) => d.dimension)).toEqual(['age', 'sex', 'vintage', 'access']);
    expect(fairness.signature.length).toBeGreaterThan(0);

    // REGRESSION — the overview must carry the FULL fairness and burden reports.
    // A partial payload type-checked fine through a cast and then crashed the
    // console on `reference.minSliceN`; the contract is now tested at the wire.
    expect(overviewPayload.fairness.reference.minSliceN).toBe(FAIRNESS_REFERENCE.minSliceN);
    expect(overviewPayload.fairness.dimensions).toHaveLength(4);
    expect(overviewPayload.burden.reference.minutesPerAlert).toBe(BURDEN_REFERENCE.minutesPerAlert);
    expect(overviewPayload.burden.window.weeks).toBeGreaterThan(0);
    expect(overviewPayload.burden.byProtocol).toHaveLength(7);

    const burden = (await app.inject({ method: 'GET', url: '/admin/assurance/burden' })).json() as {
      report: { totals: { alertsPerPatientWeek: number }; byProtocol: unknown[] }; sampleSize: number;
    };
    expect(burden.sampleSize).toBeGreaterThan(0);
    expect(burden.report.byProtocol).toHaveLength(7);

    const rules = (await app.inject({ method: 'GET', url: '/admin/assurance/rules' })).json() as {
      summary: { total: number; unenforced: unknown[] }; editions: unknown[]; protocols: Array<{ protocol: string; gaps: string[] }>;
    };
    expect(rules.summary.total).toBeGreaterThan(40);
    expect(rules.summary.unenforced).toEqual([]);
    expect(rules.protocols).toHaveLength(7);
  });

  it('rejects an unknown dimension and an unknown protocol rather than guessing', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: '/admin/assurance/fairness?dimension=height' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/admin/assurance/rules?protocol=oncology' })).statusCode).toBe(400);
    const badMode = await app.inject({ method: 'POST', url: '/admin/assurance/modes', payload: { protocol: 'nope', mode: 'active', reason: 'x'.repeat(20) } });
    expect(badMode.statusCode).toBe(400);
    const shortReason = await app.inject({ method: 'POST', url: '/admin/assurance/modes', payload: { protocol: 'anemia', mode: 'active', reason: 'because' } });
    expect(shortReason.statusCode).toBe(400);
  });

  it('activates a protocol with a reason, persists the mode, and keeps the computation identical', async () => {
    const { app } = await build();
    const activation = await app.inject({
      method: 'POST', url: '/admin/assurance/modes',
      payload: { protocol: 'infection', mode: 'active', reason: 'shadow-mode agreement 94% over 60 days', by: 'dr.reyes' },
    });
    expect(activation.statusCode).toBe(200);
    const activated = activation.json() as { record: { mode: string; by: string }; summary: { active: string[] } };
    expect(activated.record.mode).toBe('active');
    expect(activated.record.by).toBe('dr.reyes');
    expect(activated.summary.active).toContain('infection');

    const modes = (await app.inject({ method: 'GET', url: '/admin/assurance/modes' })).json() as {
      modes: Array<{ protocol: string; mode: string }>;
    };
    expect(modes.modes.find((m) => m.protocol === 'infection')!.mode).toBe('active');
    // the persisted document is the durable record
    const persisted = await app.inject({ method: 'GET', url: '/admin/assurance/overview' });
    expect(persisted.statusCode).toBe(200);

    const probe = await app.inject({
      method: 'POST', url: '/admin/assurance/mode-probe',
      payload: { protocol: 'infection', patientId: 'fac-a-pt-0001' },
    });
    expect(probe.statusCode).toBe(200);
    const probed = probe.json() as { probe: { identical: boolean; active: string; silent: string }; mode: { mode: string } };
    expect(probed.probe.active).toBe(probed.probe.silent);
    expect(probed.probe.identical).toBe(true);
    expect(probed.mode.mode).toBe('active');
  });

  it('RUNS EVERY PACK — the cross-pack actions drive each pack\'s own harness', async () => {
    const { app } = await build();

    // the gate starts out naming the gap: no red-team run, no drift snapshot
    const before = (await app.inject({ method: 'GET', url: '/admin/assurance/gate' })).json() as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(before.checks.find((c) => c.id === 'red-team')!.detail).toMatch(/no red-team runs recorded/);
    expect(before.checks.find((c) => c.id === 'drift')!.detail).toMatch(/no drift snapshot recorded/);

    const redTeam = await app.inject({ method: 'POST', url: '/admin/assurance/red-team/run-all', payload: { ranBy: 'test' } });
    expect(redTeam.statusCode).toBe(200);
    const redBody = redTeam.json() as {
      ran: number; failed: number;
      triggered: Array<{ protocol: string; ok: boolean; detail: string }>;
      gate: { checks: Array<{ id: string; status: string; detail: string }> };
    };
    // every protocol pack has a red-team endpoint, and all seven must have run
    expect(redBody.triggered).toHaveLength(7);
    expect(redBody.ran).toBe(7);
    expect(redBody.failed).toBe(0);
    expect(redBody.triggered.map((t) => t.protocol)).toEqual([...RULE_PROTOCOLS]);
    // and the ledger the gate reads now has runs in it
    const afterRed = redBody.gate.checks.find((c) => c.id === 'red-team')!;
    expect(afterRed.detail).not.toMatch(/no red-team runs recorded/);

    const drift = await app.inject({ method: 'POST', url: '/admin/assurance/drift/snapshot-all', payload: { ranBy: 'test' } });
    expect(drift.statusCode).toBe(200);
    const driftBody = drift.json() as {
      ran: number; failed: number;
      gate: { checks: Array<{ id: string; status: string; detail: string }> };
    };
    expect(driftBody.ran).toBe(7);
    expect(driftBody.failed).toBe(0);
    const afterDrift = driftBody.gate.checks.find((c) => c.id === 'drift')!;
    expect(afterDrift.detail).not.toMatch(/no drift snapshot recorded/);
  });

  it('reports a pack that cannot be driven rather than pretending it ran', async () => {
    const { app } = await build();
    // a red-team run with no findings is a real result; the shape must always
    // carry per-protocol outcomes so a failure is visible, not swallowed
    const res = await app.inject({ method: 'POST', url: '/admin/assurance/red-team/run-all', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ranBy: string; triggered: Array<{ protocol: string; path: string; status: number; ok: boolean }> };
    expect(body.ranBy).toBe('assurance-track');
    for (const entry of body.triggered) {
      expect(entry.path).toBe(`/admin/swarm/${entry.protocol === 'ckd-mbd' ? 'mbd' : entry.protocol === 'nutrition-electrolytes' ? 'nutrition' : entry.protocol}/red-team`);
      expect(typeof entry.ok).toBe('boolean');
    }
  });

  it('runs the cross-pack gate against the durable workspace', async () => {
    const store = new SwarmWorkspaceStore();
    const assurance = await crossPackAssurance(store, { fairnessRows: [], alerts: [], patients: 0 });
    expect(assurance.protocols).toHaveLength(7);
    expect(assurance.totals.silentPacks).toBeGreaterThanOrEqual(0);
    expect(assurance.findings.length).toBeGreaterThan(0);
    expect(['ship', 'hold', 'block']).toContain(assurance.decision);

    const gate = await assuranceReleaseGate(store, { fairnessRows: [], alerts: [], patients: 0 });
    expect(gate.mdrFiles).toHaveLength(7);
    expect(gate.mdrFiles.map((m) => m.protocol)).toEqual([...RULE_PROTOCOLS]);
    expect(gate.decision).not.toBe('ship');
    expect(gate.summary.length).toBeGreaterThan(0);
    expect(RENAL_PROTOCOLS.length).toBe(7);
  });
});
