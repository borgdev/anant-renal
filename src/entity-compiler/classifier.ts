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

// Classifier: CanonicalEntity -> Archetype + confidence-based emit decision.

import type { CanonicalEntity, Archetype } from './types.js';

export interface Classification {
  archetype: Archetype;
  shouldEmit: boolean;
  reasons: string[];
}

export function classify(entity: CanonicalEntity): Classification {
  const reasons: string[] = [];

  // Reject outright: very low confidence AND no signal at all
  if (entity.confidence === 'low' && entity.fields.length === 0 && (!entity.workflow || entity.workflow.length === 0)) {
    return { archetype: 'reference-only', shouldEmit: false, reasons: ['no fields or workflow steps detected'] };
  }

  // Workflow entities
  if (entity.kind === 'workflow' && entity.workflow && entity.workflow.length > 0) {
    reasons.push(`workflow with ${entity.workflow.length} steps`);
    return { archetype: 'procedure-runner', shouldEmit: entity.confidence !== 'low', reasons };
  }

  // Data entities
  if (entity.kind === 'data' && entity.fields.length > 0) {
    if (entity.hints.phi || entity.fields.some((f) => f.phi)) {
      reasons.push('PHI fields present \u2192 record-steward');
      return { archetype: 'record-steward', shouldEmit: true, reasons };
    }
    reasons.push('reference/lookup data \u2192 catalog-manager');
    return { archetype: 'catalog-manager', shouldEmit: true, reasons };
  }

  // Concept entities
  if (entity.kind === 'concept') {
    // measurable if it has any numeric field or is named like a score/measure
    const measurable = entity.fields.some((f) => f.type === 'number') || /score|scale|index|measure|rate|ratio/i.test(entity.name);
    if (measurable) {
      reasons.push('measurable concept \u2192 assessor');
      return { archetype: 'assessor', shouldEmit: entity.confidence !== 'low', reasons };
    }
    reasons.push('descriptive concept only \u2014 added to reference catalog, no agent emitted');
    return { archetype: 'reference-only', shouldEmit: false, reasons };
  }

  reasons.push('could not classify');
  return { archetype: 'reference-only', shouldEmit: false, reasons };
}
