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

// The assurance-side contract between a pack and the cross-pack assurance track.
//
// G4, stated plainly: the track's whole claim is that it reads the INSTALLED pack
// set, and it read seven names typed into a platform module instead. A new
// specialty was invisible to it until someone edited that file. Contribution
// surfaces are plural — fixing route registration (G1) does not fix this one.
//
// So the descriptor lives here as a CONTRACT, the declarations live in the pack
// that owns them, and the track receives them as an argument. `src/swarm/` must
// not import `packs/`, so "receive" is the only direction available — which is
// also the honest one: a platform function cannot know which specialties exist.

import type { ProtocolId } from '../protocols/shared-state.js';

/** The narrow shape every pack's artefact probe is normalised into. */
export interface ArtifactStatusLike {
  present: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
  metrics?: unknown;
}

/**
 * What a pack declares about its own assurance posture.
 *
 * Every field here is something only the pack knows: which protocol id it
 * implements, which model it registers, which red-team scenarios belong to it,
 * and how to probe its own trained artefact. The platform supplies none of it and
 * must not guess.
 */
export interface ProtocolPackDescriptor {
  protocol: ProtocolId;
  /** P-number from the implementation strategy. */
  slice: string;
  modelId: string;
  redTeamIds: readonly string[];
  coverageDefaults: unknown;
  artifactProbe: () => ArtifactStatusLike;
  /** the pack's own console route, so a reviewer can walk from the table to it */
  routes: string;
  mdrKind: string;
}

const BANDS: readonly ArtifactStatusLike['band'][] = ['pass', 'watch', 'insufficient'];

/**
 * Packs report their artefact status in their own shape: some declare a `band`,
 * some expose their acceptance flags (`meetsTarget`, `beatsPriorDiscrimination`,
 * `improvesCalibration`) and a regression head has no AUROC at all. This is the
 * one place that normalises them, and it never invents a verdict: a declared
 * band wins, otherwise the band is derived from the pack's own flags.
 *
 * Moving probes into packs must not tempt anyone into forcing one shape on them —
 * the shapes are genuinely different and that difference is information.
 */
export function normaliseArtifactStatus(raw: object): ArtifactStatusLike {
  const r = raw as Record<string, unknown>;
  const present = r.present === true;
  const rows = typeof r.rows === 'number' ? r.rows : undefined;
  const note = typeof r.note === 'string'
    ? r.note
    : present
      ? `artefact present${rows !== undefined ? ` (${rows} rows)` : ''}${typeof r.mapePct === 'number' ? `, MAPE ${r.mapePct}%` : ''}`
      : 'no trained artefact';
  if (!present) return { present: false, band: 'insufficient', note };
  const declared = typeof r.band === 'string' && (BANDS as readonly string[]).includes(r.band)
    ? r.band as ArtifactStatusLike['band']
    : undefined;
  const flags = Object.entries(r)
    .filter(([k, v]) => typeof v === 'boolean' && /^(meets|beats|improves)/.test(k))
    .map(([, v]) => v as boolean);
  const band = declared
    ?? (flags.length === 0 ? 'watch' : flags.every(Boolean) ? 'pass' : flags.some(Boolean) ? 'watch' : 'insufficient');
  const metrics = r.metrics ?? r.classifier ?? r.regressor ?? r.mae;
  return { present: true, band, note, ...(metrics !== undefined ? { metrics } : {}) };
}

/**
 * Look a pack up in a COLLECTED set — never in a module-level constant.
 *
 * `packs` is a required parameter on purpose. A default would let a caller who
 * forgot to pass the installed set silently review seven renal packs and report a
 * clean track, which is the defect G4 is about.
 */
export function packFor(
  protocol: ProtocolId,
  packs: readonly ProtocolPackDescriptor[],
): ProtocolPackDescriptor | undefined {
  return packs.find((p) => p.protocol === protocol);
}
