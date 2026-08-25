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

// CMS-universe pack: turn CMS regulatory programs into executable metadata
// that other packs can bind their measures and workflows to. This pack now
// delegates to `CMSSourceRegistry` in healthcare-core and preserves a
// backward-compatible `CMS_PROGRAMS` snapshot for existing consumers.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';
import { seedCMSSources, CMSSourceRegistry, ALL_CMS_MEASURES, type CMSSource, type CMSMeasureSpec } from '../../src/healthcare-core/cms-source-registry.js';

export interface CmsProgram {
  id: string;
  title: string;
  authority: 'CMS' | 'CDC' | 'FDA';
  citation: string;
  triggers: {
    measures: readonly string[];
    controls: readonly string[];
  };
  effectiveFrom?: string;
}

/** Build the executable registry the harness runs against. Loads all default CMS measures. */
export function buildCMSRegistry(extraSources: readonly CMSSource[] = [], extraMeasures: readonly CMSMeasureSpec[] = []): CMSSourceRegistry {
  const r = new CMSSourceRegistry();
  for (const s of seedCMSSources) r.registerSource(s);
  for (const s of extraSources) r.registerSource(s);
  for (const m of ALL_CMS_MEASURES) r.registerMeasure(m);
  for (const m of extraMeasures) r.registerMeasure(m);
  return r;
}

/** Backward-compatible snapshot of CMS programs, derived from the registry. */
export const CMS_PROGRAMS: readonly CmsProgram[] = seedCMSSources.map((s) => ({
  id: s.id,
  title: s.title,
  authority: s.steward as 'CMS' | 'CDC' | 'FDA',
  citation: s.citation,
  triggers: { measures: [], controls: ['audit-provenance', 'data-quality'] },
  effectiveFrom: s.effectiveFrom,
}));

export function programsFor(measureId: string): CmsProgram[] {
  return CMS_PROGRAMS.filter((p) => p.triggers.measures.includes(measureId));
}

export const cmsUniversePack: DomainPack = Object.freeze({
  id: 'cms-universe',
  version: '0.2.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: [
    'executable-regulatory-metadata',
    'measure-catalog',
    'reporting-obligations',
    'source-change-detection',
    'authoritative-registry',
  ],
  cmsUniverse: seedCMSSources.map((s) => ({ id: s.id, title: s.title, authority: s.steward, ...(s.effectiveFrom ? { effectiveFrom: s.effectiveFrom } : {}) })),
  requiredControls: ['access-policy', 'audit-provenance', 'source-registry'],
});
