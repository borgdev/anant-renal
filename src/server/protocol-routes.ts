/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

// F3 — Protocol operations shell (the cockpit API).
//
//   GET /admin/swarm/protocols                 — registry (config view)
//   GET /admin/swarm/protocols/cockpit         — green/amber/red across all
//                                                protocols + per-patient shared
//                                                state + multi-horizon forecasts
//   GET /admin/swarm/protocols/evaluation      — F2 head-vs-baseline report
//   GET /admin/swarm/protocols/:id             — one protocol in depth
//
// A protocol appears in the cockpit by being registered in
// src/protocols/registry.ts — no page scaffolding, no per-protocol route code.
// Every status is derived from the realm ledger / patient state (F1).

import type { FastifyInstance, FastifyReply } from 'fastify';
import { RealmRegistry } from '../realm/registry.js';
import { buildRenalCohort, renalPatientInputs, type RenalPatientInput } from '../swarm/renal-cohort.js';
import { buildRenalState, forecastRenalState, RENAL_FORECAST_HORIZONS_DAYS, RENAL_SUBSTATES } from '../protocols/shared-state.js';
import { runF2Evaluation, defaultCohort, type F2EvaluationReport } from '../protocols/shared-state.js';
import {
  RENAL_PROTOCOLS, assessProtocols, cockpitIndex,
  evaluateProtocolForPatient, protocolById,
} from '../protocols/registry.js';
import { PRIOR_CATALOG } from '../protocols/priors.js';

export interface ProtocolRouteOptions {
  /** Override the patient source (tests). Defaults to every realm in the registry. */
  patients?: () => RenalPatientInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });

/** Default patient source: ledger-derived renal inputs across every registered realm. */
function registryPatients(): RenalPatientInput[] {
  return renalPatientInputs(RealmRegistry.list());
}

let cachedEvaluation: { report: F2EvaluationReport; at: number } | undefined;
const EVALUATION_TTL_MS = 5 * 60_000;

export async function registerProtocolRoutes(app: FastifyInstance, opts: ProtocolRouteOptions = {}): Promise<void> {
  const patientSource = opts.patients ?? registryPatients;

  app.get('/admin/swarm/protocols', async () => ({
    generatedAt: new Date().toISOString(),
    count: RENAL_PROTOCOLS.length,
    substates: RENAL_SUBSTATES,
    priors: PRIOR_CATALOG,
    protocols: RENAL_PROTOCOLS,
  }));

  app.get('/admin/swarm/protocols/cockpit', async () => {
    const { patients, summary } = buildRenalCohort(patientSource());
    const reports = assessProtocols(patients);
    const index = cockpitIndex(reports, summary);
    const patientRows = patients
      .map((facts) => {
        const state = buildRenalState(facts);
        const forecasts = forecastRenalState(state);
        return {
          patientId: facts.patientId,
          realmId: facts.realmId,
          facilityId: facts.facilityId ?? null,
          trajectory: facts.trajectory ?? null,
          instabilityIndex: state.instabilityIndex,
          latent: state.latent,
          protocols: RENAL_PROTOCOLS.map((p) => {
            const row = evaluateProtocolForPatient(p.id, facts);
            return { protocol: p.id, substate: p.substate, status: row.status, severity: row.severity, drivers: row.drivers };
          }),
          forecasts: forecasts.map((f) => ({
            protocol: f.protocol, substate: f.substate, target: f.target, unit: f.unit,
            horizonDays: f.horizonDays, value: f.value, band: f.band, threshold: f.threshold ?? null, meetsTarget: f.meetsTarget ?? null,
          })),
        };
      })
      .sort((a, b) => b.instabilityIndex - a.instabilityIndex)
      .slice(0, 30);
    return {
      generatedAt: new Date().toISOString(),
      horizonsDays: [...RENAL_FORECAST_HORIZONS_DAYS],
      index,
      summary,
      protocols: reports,
      patients: patientRows,
      patientCount: patients.length,
    };
  });

  app.get('/admin/swarm/protocols/evaluation', async () => {
    const now = Date.now();
    if (!cachedEvaluation || now - cachedEvaluation.at > EVALUATION_TTL_MS) {
      cachedEvaluation = { report: runF2Evaluation({ patients: defaultCohort(), horizonsDays: [7, 28], salt: 'api' }), at: now };
    }
    return { generatedAt: cachedEvaluation.report.generatedAt, cachedAt: new Date(cachedEvaluation.at).toISOString(), report: cachedEvaluation.report };
  });

  app.get<{ Params: { id: string } }>('/admin/swarm/protocols/:id', async (request, reply) => {
    const descriptor = protocolById(request.params.id);
    if (!descriptor) return error(reply, 404, `protocol-not-found: ${request.params.id}`);
    const { patients, summary } = buildRenalCohort(patientSource());
    const evaluated = patients.map((facts) => {
      const row = evaluateProtocolForPatient(descriptor.id, facts);
      const state = buildRenalState(facts);
      const forecasts = forecastRenalState(state).filter((f) => f.protocol === descriptor.id);
      return { ...row, instabilityIndex: state.instabilityIndex, latent: state.latent, forecasts };
    });
    const report = assessProtocols(patients).find((r) => r.protocol === descriptor.id);
    return {
      generatedAt: new Date().toISOString(),
      protocol: descriptor,
      report,
      summary,
      patients: evaluated.sort((a, b) => b.severity - a.severity).slice(0, 25),
      patientCount: evaluated.length,
    };
  });
}

/** Test hook — drop the memoized evaluation report. */
export function resetProtocolEvaluationCache(): void {
  cachedEvaluation = undefined;
}
