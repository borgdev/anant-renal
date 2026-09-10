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

// F1 — Renal data-model read routes.
//
//   GET /admin/swarm/renal/cohort                     — per-patient renal facts
//                                                       (sessions, access, panel
//                                                       labs, exposures, signals)
//   GET /admin/swarm/renal/summary                    — fleet roll-up
//   GET /admin/swarm/renal/patients/:patientId/sessions — full session + access history
//
// Every value is derived from the realm ledger / patient state (F1 sim objects);
// this router invents nothing. Exec-guarded via the /admin/swarm/* prefix.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { RealmRegistry } from '../realm/registry.js';
import {
  buildRenalCohort, renalPatientFacts, RENAL_PANEL_KEYS, RENAL_CORE_LAB_KEYS,
  type RenalPatientFacts, type RenalPatientInput,
} from '../swarm/renal-cohort.js';

export interface RenalRouteOptions {
  /** Override the patient source (tests). Defaults to every realm in the registry. */
  patients?: () => RenalPatientInput[];
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });

/** Med codes ordered on the ledger for each patient (order-med effects). */
function medCodesByPatient(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const realm of RealmRegistry.list()) {
    for (const entry of realm.ledger.listAll()) {
      const effect = entry.effect as { kind?: string; patientId?: string; code?: string };
      if (effect.kind !== 'order-med') continue;
      const pid = effect.patientId;
      const code = effect.code;
      if (!pid || !code) continue;
      const list = out.get(pid) ?? [];
      if (!list.includes(code)) list.push(code);
      out.set(pid, list);
    }
  }
  return out;
}

/** Default patient source: patient entities across every registered realm. */
function registryPatients(): RenalPatientInput[] {
  const meds = medCodesByPatient();
  const out: RenalPatientInput[] = [];
  for (const realm of RealmRegistry.list()) {
    for (const patient of realm.graph.listKind('patient')) {
      out.push({
        id: patient.id,
        realmId: realm.id,
        state: patient.state as Record<string, unknown>,
        ...(meds.get(patient.id) ? { medCodes: meds.get(patient.id) } : {}),
      });
    }
  }
  return out;
}

export async function registerRenalRoutes(app: FastifyInstance, opts: RenalRouteOptions = {}): Promise<void> {
  const patients = opts.patients ?? registryPatients;
  const findPatient = (id: string): { input: RenalPatientInput; facts: RenalPatientFacts } | undefined => {
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
