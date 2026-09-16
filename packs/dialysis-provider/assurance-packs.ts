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

// This pack's assurance declarations — the seven protocol packs it implements.
//
// These used to be a `PROTOCOL_PACKS` constant inside `src/swarm/assurance-track.ts`,
// a platform module. So the table that calls itself "Cross-pack assurance", whose
// entire claim is that it reads the installed pack set, was actually reading seven
// names typed into the platform — and a new specialty was invisible to it until
// someone edited the platform. Same defect as the one G1 fixed for routes, in a
// second place.
//
// The declarations now live with the pack that owns them, and the track receives
// them. Nothing here is platform knowledge: which protocol id each module
// implements, which model it registers, which red-team scenarios are its own, and
// how to probe its own trained artefact are all facts only the pack has.

import type { ProtocolPackDescriptor, ArtifactStatusLike } from '../../src/swarm/assurance-packs.js';
import { normaliseArtifactStatus } from '../../src/swarm/assurance-packs.js';
import { ESA_MODEL_ID, ESA_RED_TEAM_IDS, ESA_COVERAGE_DEFAULTS } from '../../src/swarm/anemia-governance.js';
import { ADEQUACY_MODEL_ID, ADEQUACY_RED_TEAM_IDS, ADEQUACY_COVERAGE_DEFAULTS } from '../../src/swarm/adequacy-governance.js';
import { FLUID_MODEL_ID, FLUID_RED_TEAM_IDS, FLUID_COVERAGE_DEFAULTS } from '../../src/swarm/fluid-governance.js';
import { ACCESS_MODEL_ID, ACCESS_RED_TEAM_IDS, ACCESS_COVERAGE_DEFAULTS } from '../../src/swarm/access-governance.js';
import { MBD_MODEL_ID, MBD_RED_TEAM_IDS, MBD_COVERAGE_DEFAULTS } from '../../src/swarm/mbd-governance.js';
import { NUTRITION_MODEL_ID, NUTRITION_RED_TEAM_IDS, NUTRITION_COVERAGE_DEFAULTS } from '../../src/swarm/nutrition-governance.js';
import { INFECTION_MODEL_ID, INFECTION_RED_TEAM_IDS, INFECTION_COVERAGE_DEFAULTS } from '../../src/swarm/infection-governance.js';
import { accessArtifactStatus } from '../../src/swarm/access-model.js';
import { adequacyArtifactStatus } from '../../src/swarm/adequacy-model.js';
import { fluidArtifactStatus } from '../../src/swarm/fluid-model.js';
import { mbdArtifactStatus } from '../../src/swarm/mbd-model.js';
import { nutritionArtifactStatus } from '../../src/swarm/nutrition-model.js';
import { infectionArtifactStatus } from '../../src/swarm/infection-model.js';
import { loadEsaArtifact } from '../../src/swarm/anemia-model.js';

/**
 * Anemia's trained artefact is a regression head with different metrics — no AUROC
 * to read a band from. It states its own band rather than being forced into the
 * classifier shape, which is the whole reason `normaliseArtifactStatus` accepts a
 * declared band.
 */
function esaArtifactStatus(): ArtifactStatusLike {
  const artifact = loadEsaArtifact();
  if (!artifact) {
    return { present: false, band: 'insufficient', note: 'no trained ESA artefact on disk' };
  }
  const { testMae, baselineMae, nTest } = artifact.metrics;
  const beatsBaseline = testMae < baselineMae;
  const band: ArtifactStatusLike['band'] = !beatsBaseline ? 'insufficient' : nTest < 30 ? 'watch' : 'pass';
  return {
    present: true,
    band,
    note: beatsBaseline
      ? `test MAE ${testMae} beats the ${baselineMae} baseline over ${nTest} held-out windows`
      : `test MAE ${testMae} does not beat the ${baselineMae} baseline`,
    metrics: artifact.metrics,
  };
}

/** Every protocol this pack implements, in protocol order. */
export const DIALYSIS_ASSURANCE_PACKS: readonly ProtocolPackDescriptor[] = Object.freeze([
  {
    protocol: 'anemia', slice: 'P1', modelId: ESA_MODEL_ID, redTeamIds: ESA_RED_TEAM_IDS,
    coverageDefaults: ESA_COVERAGE_DEFAULTS, artifactProbe: esaArtifactStatus,
    routes: '/admin/swarm/anemia', mdrKind: 'esa-mdr-file',
  },
  {
    protocol: 'adequacy', slice: 'P2', modelId: ADEQUACY_MODEL_ID, redTeamIds: ADEQUACY_RED_TEAM_IDS,
    coverageDefaults: ADEQUACY_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(adequacyArtifactStatus()),
    routes: '/admin/swarm/adequacy', mdrKind: 'adequacy-mdr-file',
  },
  {
    protocol: 'fluid', slice: 'P3', modelId: FLUID_MODEL_ID, redTeamIds: FLUID_RED_TEAM_IDS,
    coverageDefaults: FLUID_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(fluidArtifactStatus()),
    routes: '/admin/swarm/fluid', mdrKind: 'fluid-mdr-file',
  },
  {
    protocol: 'access', slice: 'P4', modelId: ACCESS_MODEL_ID, redTeamIds: ACCESS_RED_TEAM_IDS,
    coverageDefaults: ACCESS_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(accessArtifactStatus()),
    routes: '/admin/swarm/access', mdrKind: 'access-mdr-file',
  },
  {
    protocol: 'ckd-mbd', slice: 'P4', modelId: MBD_MODEL_ID, redTeamIds: MBD_RED_TEAM_IDS,
    coverageDefaults: MBD_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(mbdArtifactStatus()),
    routes: '/admin/swarm/mbd', mdrKind: 'mbd-mdr-file',
  },
  {
    protocol: 'nutrition-electrolytes', slice: 'P5', modelId: NUTRITION_MODEL_ID, redTeamIds: NUTRITION_RED_TEAM_IDS,
    coverageDefaults: NUTRITION_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(nutritionArtifactStatus()),
    routes: '/admin/swarm/nutrition', mdrKind: 'nutrition-mdr-file',
  },
  {
    protocol: 'infection', slice: 'P6', modelId: INFECTION_MODEL_ID, redTeamIds: INFECTION_RED_TEAM_IDS,
    coverageDefaults: INFECTION_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(infectionArtifactStatus()),
    routes: '/admin/swarm/infection', mdrKind: 'infection-mdr-file',
  },
]);
