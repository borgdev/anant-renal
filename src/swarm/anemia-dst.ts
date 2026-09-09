/******************************************************************************
 * DST-Q #3 — ESA suggestion evidence fusion.
 *
 * A Class-C ESA dose suggestion deserves the same Dempster–Shafer honesty as a
 * durable outcome episode. When the advisor runs we fuse the *actual evidence
 * the window carries* — charted labs (facts), the Hb trend and ESA history
 * (events), and the KDIGO/cell reference (catalog object) — into a belief
 * interval over the suggestion being sound:
 *
 *    Bel   — the mass fully committed to the suggestion (charted facts weigh
 *            the most: fact 0.7, event 0.5, reference object 0.3 → reliability
 *            alpha from the source dial).
 *    Pl    — what the evidence would still allow.
 *    K     — fused conflict (high K = contested posture).
 *    score — the same belief-aware decision priority used by My Work
 *            (Bel + λ·(Pl−Bel) − γ·Pl(harm)), so a sparse or stale window reads
 *            as weak and ranks below a richly-corroborated one everywhere.
 *
 * It deliberately reuses `fuseEpisodeEvidence` and the work-queue posture/scoring
 * helpers so the Class-C suggestion card and the episode in My Work tell one
 * consistent story.
 ******************************************************************************/

import { fuseEpisodeEvidence, type EpisodeEvidenceFusion } from './outcome-episode.js';
import { evidenceStatusFromFusion, dstPriorityFromFusion, type QueueEvidenceStatus } from './work-dst.js';
import type { EsaPatientWindow } from './anemia.js';
import type { EvidenceRef } from './types.js';

export interface EsaSuggestionDst {
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  evidenceStatus: QueueEvidenceStatus;
  /** Belief-aware decision priority in [0,1] (same rule as My Work). */
  score: number;
  sources: EpisodeEvidenceFusion['sources'];
  refs: EvidenceRef[];
}

/** Minimum charted (non-reference) observations before a suggestion reads corroborated. */
export const ESA_MIN_CHARTED_SUPPORT = 3;

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Optional numeric labs → charted fact evidence refs. */
const OPTIONAL_LABS: Array<{ id: 'mcv' | 'ferritin' | 'transferrinSat' | 'crp' | 'calcium' | 'pth'; source: string }> = [
  { id: 'mcv', source: 'esa:chart:mcv' },
  { id: 'ferritin', source: 'esa:chart:ferritin' },
  { id: 'transferrinSat', source: 'esa:chart:transferrin-sat' },
  { id: 'crp', source: 'esa:chart:crp' },
  { id: 'calcium', source: 'esa:chart:calcium' },
  { id: 'pth', source: 'esa:chart:pth' },
];

/**
 * Evidence refs for the suggestion — every ref maps to something the advisor
 * actually consumed from the window (never fabricated), with the source dial
 * assigning reliability: charted facts default α, catalog/reference objects low α.
 */
export function esaEvidenceRefsFor(window: EsaPatientWindow): EvidenceRef[] {
  const refs: EvidenceRef[] = [
    // Current Hb is always charted for the advisor to run.
    { sourceId: 'esa:chart:hgb', contentType: 'fact' },
  ];
  for (const lab of OPTIONAL_LABS) {
    if (window[lab.id] !== undefined && typeof window[lab.id] === 'number') {
      refs.push({ sourceId: lab.source, contentType: 'fact' });
    }
  }
  if (window.hgbTrendLast90d && window.hgbTrendLast90d.length >= 2) {
    refs.push({ sourceId: 'esa:history:hgb-trend', contentType: 'event' });
  }
  if ((window.esaEscalationsLast90d ?? 0) >= 1) {
    refs.push({ sourceId: 'esa:history:esa-escalation', contentType: 'event' });
  }
  if (window.onESA) {
    refs.push({ sourceId: 'esa:medication:esa', contentType: 'event' });
  }
  if (window.lastIronPanelAt) {
    refs.push({ sourceId: 'esa:chart:iron-panel', contentType: 'fact' });
  }
  // The KDIGO/cell reference the recommendation is anchored to.
  refs.push({ sourceId: 'catalog:kdigo-band', contentType: 'object' });
  return refs;
}

/** Fuse the advisor's evidence into a Bel/Pl/K readout for the suggestion. */
export function esaSuggestionDst(window: EsaPatientWindow): EsaSuggestionDst {
  const refs = esaEvidenceRefsFor(window);
  const fusion = fuseEpisodeEvidence(refs);
  let status = evidenceStatusFromFusion(fusion);
  // A reference catalog (KDIGO) is a prior, never corroboration by itself: a
  // suggestion only reads corroborated once enough *charted* observations back
  // it (mirrors the ESA lab-density coverage gate).
  const charted = refs.filter((r) => !r.sourceId.startsWith('catalog:')).length;
  if (status === 'corroborated' && charted < ESA_MIN_CHARTED_SUPPORT) status = 'weak';
  return {
    belief: round(fusion.belief),
    plausibility: round(fusion.plausibility),
    uncertainty: round(fusion.uncertainty),
    conflictMass: round(fusion.conflictMass),
    evidenceStatus: status,
    score: dstPriorityFromFusion(fusion, status),
    sources: fusion.sources,
    refs,
  };
}
