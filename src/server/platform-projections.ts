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

// THE platform projections: who exists, and what happened.
//
// This module exists because the platform's answer to those two questions was
// previously spread across eleven route modules. Every specialty that reasoned
// over a patient population called `renalPatientInputs(RealmRegistry.list())`
// itself, and seven of them carried their own `ledgerEvents()` — byte-identical
// loops over every realm's ledger, each returning a locally-named alias of the
// same shape. The duplication was invisible because the names differed.
//
// Consequence, and the reason this is a correctness fix rather than tidying: the
// platform could not scope, filter or replace the population it was handing to a
// pack, so `applied` on a specialty binding had nothing to enforce, and a pack
// held a reference to the realm registry across a runtime rebuild.
//
// Both providers are ZERO-ARGUMENT today. When the population becomes
// scope-filtered they widen to take the actor, and every existing zero-argument
// provider stays assignable — which is why the packs can be migrated before that
// work lands.

import { RealmRegistry } from '../realm/registry.js';
import { renalPatientInputs, type RenalPatientInput } from '../swarm/renal-cohort.js';
import type { ProjectedEvent } from '../control-plane/pack-contributions.js';

/** Every patient that exists, across every registered realm. */
export function patientProjection(): RenalPatientInput[] {
  return renalPatientInputs(RealmRegistry.list());
}

/**
 * Every effect on every realm ledger, as the canonical event shape.
 *
 * `realmAt` is carried deliberately: a specialty twin that compares wall-clock
 * timestamps sees a fortnight of accelerated realm time as a few minutes and
 * reports the history insufficient. The realm clock is the clinically meaningful
 * time and the platform is the only thing that can supply it.
 */
export function eventProjection(): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  for (const realm of RealmRegistry.list()) {
    for (const effect of realm.ledger.listAll()) {
      const payload = effect.effect as Record<string, unknown>;
      const patientId = payload.patientId;
      out.push({
        realmId: realm.id,
        eventId: effect.effectId,
        kind: (effect.effect as { kind: string }).kind,
        emittedAt: effect.emittedAt,
        ...(effect.realmAt ? { realmAt: effect.realmAt } : {}),
        ...(typeof patientId === 'string' ? { patientId } : {}),
        payload,
      });
    }
  }
  return out;
}
