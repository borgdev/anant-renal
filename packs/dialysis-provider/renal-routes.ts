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

// F1 — Renal data-model read routes.
//
//   GET /admin/swarm/renal/cohort                       — per-patient renal facts
//                                                         (sessions, access, panel
//                                                         labs, exposures, signals)
//   GET /admin/swarm/renal/summary                      — fleet roll-up
//   GET /admin/swarm/renal/patients/:patientId/sessions — full session + access history
//
// Every value is derived from the realm ledger / patient state (F1 sim objects);
// this router invents nothing. Exec-guarded via the /admin/swarm/* prefix.
//
// This file used to be `src/server/renal-routes.ts` — a platform module that
// happened to serve dialysis. It lives here now because the endpoints a specialty
// serves are part of the specialty. The load-bearing change is what it no longer
// does: it used to call `renalPatientInputs(RealmRegistry.list())` itself, so the
// platform could not scope, filter or replace the population it was handing to a
// pack, and the pack reached for a platform singleton to find out who its
// patients were. It now receives the projection through `deps.patients`.
//
// The `patients` option is still honoured because tests inject fixtures through
// it; the platform's source is the default and lives at the call site.

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PackPatient, PackRouteContribution } from '../../src/control-plane/pack-contributions.js';
import {
  buildRenalCohort, renalPatientFacts, RENAL_PANEL_KEYS, RENAL_CORE_LAB_KEYS,
  type RenalPatientFacts,
} from '../../src/swarm/renal-cohort.js';

export interface RenalRouteOptions {
  /** The patients to report on. Supplied by the platform; overridden by tests. */
  patients: () => readonly PackPatient[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });

export async function registerRenalRoutes(app: FastifyInstance, opts: RenalRouteOptions): Promise<void> {
  const patients = opts.patients;
  const findPatient = (id: string): { input: PackPatient; facts: RenalPatientFacts } | undefined => {
    const input = patients().find((p) => p.id === id);
    if (!input) return undefined;
    return { input, facts: renalPatientFacts(input) };
  };

  app.get('/admin/swarm/renal/cohort', async () => {
    const { patients: facts, summary } = buildRenalCohort(patients());
    return {
      generatedAt: new Date().toISOString(),
      summary,
      panelKeys: [...RENAL_PANEL_KEYS],
      coreLabKeys: [...RENAL_CORE_LAB_KEYS],
      patients: facts,
    };
  });

  app.get('/admin/swarm/renal/summary', async () => {
    const { summary } = buildRenalCohort(patients());
    return { generatedAt: new Date().toISOString(), summary };
  });

  app.get<{ Params: { patientId: string } }>('/admin/swarm/renal/patients/:patientId/sessions', async (request, reply) => {
    const found = findPatient(request.params.patientId);
    if (!found) return error(reply, 404, `patient-not-found: ${request.params.patientId}`);
    const state = found.input.state as Record<string, unknown>;
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const accessObservations = Array.isArray(state.accessObservations) ? state.accessObservations : [];
    return {
      generatedAt: new Date().toISOString(),
      patientId: found.facts.patientId,
      realmId: found.facts.realmId,
      access: found.facts.access,
      sessionSummary: found.facts.sessions,
      sessions,
      accessObservations,
      labs: found.facts.labs,
      signals: found.facts.signals,
    };
  });
}

/** This pack's route surface. */
export const renalRoutes: readonly PackRouteContribution[] = Object.freeze([
  {
    id: 'dialysis.renal',
    scope: 'exec',
    prefixes: ['/admin/swarm/renal'],
    register(app, deps) {
      return registerRenalRoutes(app, { patients: deps.patients });
    },
  },
]);
