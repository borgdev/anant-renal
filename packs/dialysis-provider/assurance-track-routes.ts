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

// Cross-pack assurance routes.
//
//   GET  /admin/swarm/assurance/overview      — one row per protocol pack + the cohort findings
//   GET  /admin/swarm/assurance/gate          — the single release gate for the whole set
//   GET  /admin/swarm/assurance/fairness      — slice report per dimension (age/sex/vintage/access)
//   GET  /admin/swarm/assurance/burden        — alert burden over the live cohort
//   GET  /admin/swarm/assurance/modes         — per-protocol surfacing modes
//   POST /admin/swarm/assurance/modes         — set a mode (durable, reason required to activate)
//   GET  /admin/swarm/assurance/rules         — the guideline rule packs
//   POST /admin/swarm/assurance/mode-probe    — prove silent mode did not change the computation
//
// The cohort is the same ledger-derived cohort the protocol cockpit reads, so
// the fairness and burden numbers here are the real cohort's, not a fixture.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { renalPatientFacts, type RenalPatientInput } from '../../src/swarm/renal-cohort.js';
import type { PackPatient, PackRouteContribution } from '../../src/control-plane/pack-contributions.js';
import type { ProtocolPackDescriptor } from '../../src/swarm/assurance-packs.js';
import { DIALYSIS_ASSURANCE_PACKS } from './assurance-packs.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient } from '../../src/protocols/registry.js';
import { getSwarmWorkspace } from '../../src/server/swarm-routes.js';
import type { SwarmWorkspaceStore, WorkspaceDoc } from '../../src/swarm/workspace.js';
import {
  assuranceReleaseGate, crossPackAssurance, packFor,
  ASSURANCE_TRACK_REFERENCE, type AssuranceInputs,
} from '../../src/swarm/assurance-track.js';
import {
  applyMode, allModeRecords, isProtocolId, modeRecord, silentModeSummary,
  assertSilentStillComputes, SILENT_MODE_REFERENCE, type ProtocolMode,
} from '../../src/evidence/silent-mode.js';
import {
  fairnessReport, disparityReport, fairnessSignature, SLICE_DIMENSIONS, FAIRNESS_DIMENSION_LABELS,
  FAIRNESS_REFERENCE, type FairnessRow, type SliceDimension,
} from '../../src/evidence/fairness.js';
import {
  burdenReport, burdenSignature, BURDEN_REFERENCE, type AlertEvent,
} from '../../src/evidence/alert-burden.js';
import { RULE_PACKS, RULE_PROTOCOLS, rulePackSummary, rulePackEditions, enforcementGaps, rulesForProtocol } from '../../src/evidence/rule-packs.js';
import type { ProtocolId } from '../../src/protocols/shared-state.js';

export interface AssuranceRouteOptions {
  /** The platform's patient projection. */
  patients: () => readonly PackPatient[];
  /**
   * Every INSTALLED pack's assurance declaration, collected by the platform.
   * Empty means no installed pack declared one — which the track reports, rather
   * than falling back to a hardcoded list and calling the result clean (G4).
   */
  packs: () => readonly ProtocolPackDescriptor[];
}

/** Durable per-protocol surfacing mode, persisted as a `protocol-mode` document. */
export interface ProtocolModeDoc extends WorkspaceDoc {
  protocol: string;
  mode: ProtocolMode;
  since: string;
  reason: string;
  by: string;
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface CohortSignalView {
  rows: FairnessRow[];
  alerts: AlertEvent[];
  patients: number;
  protocols: number;
  coveredByProtocol: Record<string, number>;
  flaggedByProtocol: Record<string, number>;
  generatedAt: string;
}

/**
 * Turn the live cohort into the two things the assurance track measures:
 * per-patient slice rows, and the alerts this cohort would raise today.
 *
 * Coverage maps to "the protocol could evaluate this patient at all"
 * (`unknown` status means the inputs were insufficient), and a flag maps to an
 * amber or red protocol status. Nothing is imputed.
 */
export function cohortSignals(inputs: readonly RenalPatientInput[]): CohortSignalView {
  const rows: FairnessRow[] = [];
  const alerts: AlertEvent[] = [];
  const coveredByProtocol: Record<string, number> = {};
  const flaggedByProtocol: Record<string, number> = {};
  const moment = NOW();

  for (const input of inputs) {
    const facts = renalPatientFacts(input);
    const state = input.state;
    const access = (state.access ?? {}) as Record<string, unknown>;
    const coveredProtocols: string[] = [];

    for (const descriptor of RENAL_PROTOCOLS) {
      const status = evaluateProtocolForPatient(descriptor.id, facts);
      const covered = status.status !== 'unknown';
      const flagged = status.status === 'red' || status.status === 'amber';
      if (covered) coveredProtocols.push(descriptor.id);
      if (covered) coveredByProtocol[descriptor.id] = (coveredByProtocol[descriptor.id] ?? 0) + 1;
      if (flagged) flaggedByProtocol[descriptor.id] = (flaggedByProtocol[descriptor.id] ?? 0) + 1;
      if (!flagged) continue;
      const actionable = status.signals.some((s) => s.severity === 'alert');
      const driver = status.drivers[0] ?? status.signals[0]?.label ?? descriptor.label;
      alerts.push({
        id: `${facts.patientId}:${descriptor.id}:${driver}`,
        protocol: descriptor.id,
        patientId: facts.patientId,
        at: facts.sessions.lastAt ?? moment,
        kind: `${descriptor.id}:${driver}`,
        actionable,
        severity: status.status === 'red' ? 'warn' : 'info',
      });
    }

    // A patient is "covered" for the slice when at least one protocol could
    // evaluate them; the per-protocol view rides on coveredByProtocol.
    rows.push({
      patientId: facts.patientId,
      ...(facts.age !== undefined ? { age: facts.age } : {}),
      ...(facts.sex !== undefined ? { sex: facts.sex } : {}),
      ...(numeric(state.dialysisVintageYears) !== undefined ? { vintageYears: numeric(state.dialysisVintageYears) } : {}),
      ...(stringOf(access.type) !== undefined ? { accessType: stringOf(access.type) } : {}),
      // ---- S5 L1: the demographic axes ----
      //
      // `structuralState` has written `race` / `ethnicity` / `birthSex` / `language`
      // onto every ingested patient since S6-prep, and until now NOTHING read them —
      // the fairness screen declared four renal dimensions and the data had no
      // consumer. These three are the axes healthcare equity is mostly measured on.
      //
      // Read from the entity state rather than from `facts`, which does not carry
      // them: `RenalPatientFacts` is the specialty's clinical projection and has no
      // business knowing a patient's race.
      ...(stringOf(state.race) !== undefined ? { race: stringOf(state.race) } : {}),
      ...(stringOf(state.ethnicity) !== undefined ? { ethnicity: stringOf(state.ethnicity) } : {}),
      ...(stringOf(state.language) !== undefined ? { language: stringOf(state.language) } : {}),
      // Sufficiency, NOT "some protocol reached a verdict".
      //
      // This was `coveredProtocols.length > 0` and a probe showed that is always true:
      // a patient with an EMPTY state scores `access` at `green` (severity 0.25), so
      // "some protocol decided" holds for a patient nobody has measured. Every row was
      // then `covered: true`, which made the coverage comparison `fairness.ts` performs
      // BEFORE it compares flag rates a constant — and `disparityReport` reads a
      // coverage gap as `breach`, so the one gate that could have caught a
      // data-capture disparity was the one measuring nothing.
      //
      // The rule below is `registry.ts`'s own `unknown` condition negated — a protocol
      // reports `unknown` when `sessions.count === 0 && panel.completenessPct < 50`.
      // Reusing the stated rule rather than inventing a second threshold is the point:
      // two definitions of "enough data" is how they drift apart.
      covered: facts.sessions.count > 0 || facts.panel.completenessPct >= 50,
      flagged: alerts.some((a) => a.patientId === facts.patientId),
      score: coveredProtocols.length,
    });
  }

  return {
    rows,
    alerts,
    patients: inputs.length,
    protocols: RENAL_PROTOCOLS.length,
    coveredByProtocol,
    flaggedByProtocol,
    generatedAt: moment,
  };
}

export async function registerAssuranceRoutes(app: FastifyInstance, opts: AssuranceRouteOptions): Promise<void> {
  const patients = opts.patients;
  const installedPacks = opts.packs;
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  /** Rehydrate any persisted mode records so a restart keeps the operator's intent. */
  async function hydrateModes(store: SwarmWorkspaceStore): Promise<void> {
    const docs = await store.list<ProtocolModeDoc>('protocol-mode');
    for (const doc of docs) {
      const protocol = doc.protocol;
      if (!protocol || !isProtocolId(protocol) || !doc.mode) continue;
      applyMode({
        protocol,
        mode: doc.mode,
        reason: doc.reason ?? 'restored from the durable mode registry',
        by: doc.by ?? 'system',
        ...(doc.since ? { at: doc.since } : {}),
      });
    }
  }

  function signals(): CohortSignalView {
    return cohortSignals(patients());
  }

  /**
   * The packs under review: everything INSTALLED that declared an assurance
   * contribution, falling back to this pack's own declarations.
   *
   * Before G4 this list was a constant inside `src/swarm/assurance-track.ts`, so
   * a second specialty was invisible to the track no matter what it declared.
   */
  function assurancePacks(): readonly ProtocolPackDescriptor[] {
    const installed = installedPacks();
    return installed.length > 0 ? installed : DIALYSIS_ASSURANCE_PACKS;
  }

  function assuranceInputs(view: CohortSignalView, dimensions?: readonly SliceDimension[]): AssuranceInputs {
    return {
      packs: assurancePacks(),
      fairnessRows: view.rows,
      alerts: view.alerts,
      patients: view.patients,
      ...(dimensions ? { dimensions } : {}),
    };
  }

  /* ---------- overview ---------- */

  app.get('/admin/swarm/assurance/overview', async () => {
    const store = ws();
    await hydrateModes(store);
    const view = signals();
    const assurance = await crossPackAssurance(store, assuranceInputs(view));
    return {
      generatedAt: NOW(),
      reference: ASSURANCE_TRACK_REFERENCE,
      decision: assurance.decision,
      totals: assurance.totals,
      protocols: assurance.protocols.map((p) => ({
        protocol: p.protocol,
        slice: packFor(p.protocol, assurancePacks())?.slice ?? null,
        modelId: p.modelId,
        routes: packFor(p.protocol, assurancePacks())?.routes ?? null,
        mdrKind: packFor(p.protocol, assurancePacks())?.mdrKind ?? null,
        verdict: p.verdict,
        mode: p.mode.mode,
        rules: p.ruleCount,
        ruleGaps: p.ruleGaps,
        artifact: { present: p.artifact.present, band: p.artifact.band, note: p.artifact.note },
        ledger: p.ledger,
        checks: p.checks,
        coveredPatients: view.coveredByProtocol[p.protocol] ?? 0,
        flaggedPatients: view.flaggedByProtocol[p.protocol] ?? 0,
      })),
      cohort: {
        patients: view.patients,
        protocols: view.protocols,
        alerts: view.alerts.length,
        coveredByProtocol: view.coveredByProtocol,
        flaggedByProtocol: view.flaggedByProtocol,
      },
      fairness: {
        ...assurance.fairness,
        signature: fairnessSignature(assurance.fairness),
      },
      burden: {
        ...assurance.burden,
        signature: burdenSignature(assurance.burden),
      },
      findings: assurance.findings,
    };
  });

  /* ---------- the release gate ---------- */

  /**
   * Drive every pack's own red-team harness, then re-read the gate.
   *
   * This is the answer to "the gate says five packs have no red-team run": the
   * packs each own that machinery, so the cross-pack action calls THEIR endpoint
   * rather than reimplementing it. Nothing is duplicated, and the entry that
   * lands in the ledger is the same one the pack's own page would have produced.
   */
  async function triggerPacks(
    app: FastifyInstance,
    cookie: string | undefined,
    suffix: 'red-team' | 'drift',
    ranBy: string,
  ): Promise<Array<{ protocol: string; path: string; status: number; ok: boolean; detail: string }>> {
    const triggered: Array<{ protocol: string; path: string; status: number; ok: boolean; detail: string }> = [];
    for (const pack of assurancePacks()) {
      const path = `${pack.routes}/${suffix}`;
      try {
        const response = await app.inject({
          method: 'POST',
          url: path,
          ...(cookie ? { headers: { cookie } } : {}),
          payload: { ranBy, metric: suffix === 'drift' ? 'cross-pack-ks' : undefined },
        });
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        let detail = ok ? `${suffix} recorded for ${pack.protocol}` : `HTTP ${response.statusCode}`;
        if (!ok) {
          try {
            const body = response.json() as { error?: string; message?: string };
            detail = body.error ?? body.message ?? detail;
          } catch { /* non-JSON error body */ }
        }
        triggered.push({ protocol: pack.protocol, path, status: response.statusCode, ok, detail });
      } catch (error) {
        triggered.push({
          protocol: pack.protocol,
          path,
          status: 0,
          ok: false,
          detail: error instanceof Error ? error.message : 'trigger failed',
        });
      }
    }
    return triggered;
  }

  app.post<{ Body: { ranBy?: string } }>('/admin/swarm/assurance/red-team/run-all', async (request) => {
    const store = ws();
    await hydrateModes(store);
    const ranBy = request.body?.ranBy?.trim() || 'assurance-track';
    const cookie = request.headers.cookie;
    const triggered = await triggerPacks(app, cookie, 'red-team', ranBy);
    const view = signals();
    const gate = await assuranceReleaseGate(store, assuranceInputs(view));
    return {
      generatedAt: NOW(),
      action: 'red-team/run-all',
      ranBy,
      triggered,
      ran: triggered.filter((t) => t.ok).length,
      failed: triggered.filter((t) => !t.ok).length,
      gate,
    };
  });

  app.post<{ Body: { ranBy?: string } }>('/admin/swarm/assurance/drift/snapshot-all', async (request) => {
    const store = ws();
    await hydrateModes(store);
    const ranBy = request.body?.ranBy?.trim() || 'assurance-track';
    const cookie = request.headers.cookie;
    const triggered = await triggerPacks(app, cookie, 'drift', ranBy);
    const view = signals();
    const gate = await assuranceReleaseGate(store, assuranceInputs(view));
    return {
      generatedAt: NOW(),
      action: 'drift/snapshot-all',
      ranBy,
      triggered,
      ran: triggered.filter((t) => t.ok).length,
      failed: triggered.filter((t) => !t.ok).length,
      gate,
    };
  });

  app.get<{ Querystring: { activeOnly?: string } }>('/admin/swarm/assurance/gate', async (request) => {
    const store = ws();
    await hydrateModes(store);
    const view = signals();
    const activeOnly = request.query?.activeOnly === 'true';
    const gate = await assuranceReleaseGate(store, { ...assuranceInputs(view), activeOnly });
    return {
      generatedAt: gate.generatedAt,
      reference: ASSURANCE_TRACK_REFERENCE,
      decision: gate.decision,
      summary: gate.summary,
      activeOnly,
      checks: gate.checks,
      mdrFiles: gate.mdrFiles,
      modes: gate.modes,
      rulePacks: gate.rulePacks,
      fairnessVerdict: gate.fairnessVerdict,
      burdenVerdict: gate.burdenVerdict,
      blockers: gate.blockers,
      warnings: gate.warnings,
      protocols: gate.assurance.protocols.map((p) => ({
        protocol: p.protocol,
        verdict: p.verdict,
        mode: p.mode.mode,
        blockers: p.blockers,
        warnings: p.warnings,
      })),
    };
  });

  /* ---------- fairness ---------- */

  app.get<{ Querystring: { dimension?: string; protocol?: string } }>('/admin/swarm/assurance/fairness', async (request, reply) => {
    const view = signals();
    const dimension = request.query?.dimension;
    if (dimension && !(SLICE_DIMENSIONS as readonly string[]).includes(dimension)) {
      return error(reply, 400, `unknown-dimension: ${dimension}`);
    }
    const protocolParam = request.query?.protocol;
    // A supplied-but-unrecognised protocol is REFUSED rather than silently answered
    // about a different one: `?protocol=mbd` used to return ANEMIA's fairness
    // report, which is a wrong answer shaped like a right one. The default for an
    // ABSENT protocol stays, because `fairnessReport` owns it and states it back.
    if (protocolParam && !isProtocolId(protocolParam)) return error(reply, 400, `unknown-protocol: ${protocolParam}`);
    const protocol: ProtocolId = protocolParam && isProtocolId(protocolParam) ? protocolParam : 'anemia';

    if (dimension) {
      const dimensionReport = disparityReport(view.rows, dimension as SliceDimension);
      return {
        generatedAt: NOW(),
        protocol,
        dimension: dimensionReport,
        reference: FAIRNESS_REFERENCE,
        cohort: { patients: view.patients, alerts: view.alerts.length },
      };
    }
    const report = fairnessReport(view.rows, { protocol });
    return {
      generatedAt: NOW(),
      protocol,
      report,
      signature: fairnessSignature(report),
      labels: FAIRNESS_DIMENSION_LABELS,
      reference: FAIRNESS_REFERENCE,
      cohort: { patients: view.patients, alerts: view.alerts.length },
    };
  });

  /* ---------- alert burden ---------- */

  app.get<{ Querystring: { weeks?: string } }>('/admin/swarm/assurance/burden', async (request) => {
    const view = signals();
    const weeks = Number(request.query?.weeks);
    const report = burdenReport(view.alerts, {
      patients: view.patients,
      ...(Number.isFinite(weeks) && weeks > 0 ? { weeks } : {}),
    });
    return {
      generatedAt: NOW(),
      report,
      signature: burdenSignature(report),
      reference: BURDEN_REFERENCE,
      cohort: { patients: view.patients, protocols: view.protocols },
      sampleSize: view.alerts.length,
    };
  });

  /* ---------- surfacing modes ---------- */

  app.get('/admin/swarm/assurance/modes', async () => {
    const store = ws();
    await hydrateModes(store);
    return {
      generatedAt: NOW(),
      reference: SILENT_MODE_REFERENCE,
      summary: silentModeSummary(),
      modes: allModeRecords().map((m) => ({
        ...m,
        routes: packFor(m.protocol, assurancePacks())?.routes ?? null,
      })),
    };
  });

  app.post<{ Body: { protocol?: string; mode?: ProtocolMode; reason?: string; by?: string } }>(
    '/admin/swarm/assurance/modes',
    async (request, reply) => {
      const body = request.body ?? {};
      const protocol = body.protocol;
      if (!protocol || !isProtocolId(protocol)) return error(reply, 400, `unknown-protocol: ${protocol ?? 'missing'}`);
      if (body.mode !== 'active' && body.mode !== 'silent') return error(reply, 400, 'invalid-mode: expected active|silent');
      const by = body.by?.trim() || 'operator';
      try {
        const record = applyMode({
          protocol,
          mode: body.mode,
          reason: body.reason ?? '',
          by,
        });
        const store = ws();
        const id = `protocol-mode:${protocol}`;
        const existing = await store.get('protocol-mode', id);
        const doc: Omit<ProtocolModeDoc, 'id' | 'createdAt' | 'updatedAt'> = {
          protocol,
          mode: record.mode,
          since: record.since,
          reason: record.reason,
          by: record.by,
        };
        if (existing) await store.update<ProtocolModeDoc>('protocol-mode', id, doc);
        else await store.create<ProtocolModeDoc>('protocol-mode', id, doc);
        return { generatedAt: NOW(), record, summary: silentModeSummary() };
      } catch (e) {
        return error(reply, 400, e instanceof Error ? e.message : 'mode-change-rejected');
      }
    },
  );

  /**
   * Prove the silent-mode invariant for one protocol: the pack must return the
   * identical recommendation in both modes. The caller supplies nothing — the
   * probe uses the cohort-level status as the computation, so the check is the
   * real one, not a toy.
   */
  app.post<{ Body: { protocol?: string; patientId?: string } }>('/admin/swarm/assurance/mode-probe', async (request, reply) => {
    const body = request.body ?? {};
    const protocol = body.protocol;
    if (!protocol || !isProtocolId(protocol)) return error(reply, 400, `unknown-protocol: ${protocol ?? 'missing'}`);
    const inputs = patients();
    const target = body.patientId ? inputs.find((p) => p.id === body.patientId) : inputs[0];
    if (!target) return error(reply, 404, 'no-patients-in-cohort');
    const facts = renalPatientFacts(target);
    const probe = assertSilentStillComputes({
      protocol,
      compute: () => evaluateProtocolForPatient(protocol, facts),
      signature: (s) => `${s.status}|${s.severity}|${s.drivers.join(',')}|${s.signals.map((x) => `${x.label}=${x.value}`).join(',')}`,
    });
    return {
      generatedAt: NOW(),
      protocol,
      patientId: facts.patientId,
      mode: modeRecord(protocol),
      probe,
      allModes: allModeRecords().map((m) => ({ protocol: m.protocol, mode: m.mode })),
    };
  });

  /* ---------- guideline rule packs ---------- */

  app.get<{ Querystring: { protocol?: string } }>('/admin/swarm/assurance/rules', async (request, reply) => {
    const protocolParam = request.query?.protocol;
    if (protocolParam && !isProtocolId(protocolParam)) return error(reply, 400, `unknown-protocol: ${protocolParam}`);
    const protocol = protocolParam && isProtocolId(protocolParam) ? protocolParam : undefined;
    return {
      generatedAt: NOW(),
      summary: rulePackSummary(),
      editions: rulePackEditions(),
      protocols: RULE_PROTOCOLS.map((p) => ({
        protocol: p,
        rules: rulesForProtocol(p),
        gaps: enforcementGaps(p),
      })),
      packs: protocol ? RULE_PACKS.filter((r) => r.protocol === protocol) : RULE_PACKS,
      sources: [...new Set(RULE_PACKS.map((r) => r.reference.source))],
      bindings: RULE_PACKS.length,
      driftCheck: 'tests/rule-packs.test.ts resolves every binding against its pack constant',
      packTable: assurancePacks().map((p) => ({ protocol: p.protocol, slice: p.slice, modelId: p.modelId, routes: p.routes, mdrKind: p.mdrKind })),
    };
  });

  /* ---------- seed for the console ---------- */

  app.get('/admin/swarm/assurance/cohort-rows', async () => {
    const view = signals();
    return {
      generatedAt: view.generatedAt,
      patients: view.patients,
      rows: view.rows,
      alerts: view.alerts,
    };
  });
}

/** This module's route surface. */
export const assuranceTrackRoutes: readonly PackRouteContribution[] = Object.freeze([
  {
    id: 'dialysis.assurance-track',
    scope: 'exec',
    prefixes: ['/admin/swarm/assurance'],
    register(app, deps) {
      return registerAssuranceRoutes(app, {
        patients: deps.patients,
        packs: deps.assurancePacks,
      });
    },
  },
]);
