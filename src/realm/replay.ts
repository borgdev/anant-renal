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

// Episode replay — deterministic reproduction of a stored ChoicePoint.
//
// Given a closed Episode with a ChoicePoint that recorded its rngRoll and
// the alternatives it saw, we can:
//   1. Re-score using the presence's *current* preferences -> "replay-now"
//   2. Re-score using the historical preference weights baked into the
//      ChoicePoint -> "replay-historical"
// and detect divergence (biography has since shifted).

import type { Episode } from './episode.js';
import type { SelfModelRegistry } from './self-model.js';

export interface ReplayOutcome {
  episodeId: string;
  storedChoice: string;
  replayHistorical: { chosenOptionId: string; matches: boolean };
  replayNow: { chosenOptionId: string; matches: boolean; note?: string };
  divergence: boolean;
  detail: string;
}

// Re-runs the choice using scores baked into the ChoicePoint (historical)
// and using current preferences from the SelfModel (now).
// The rngRoll is stored on the ChoicePoint; band selection is deterministic
// once scores are known.
export function replayEpisodeChoice(ep: Episode, selfModel: SelfModelRegistry): ReplayOutcome {
  const c = ep.choice;
  if (!c) throw new Error('episode-has-no-choice');

  const bandThreshold = 0.15;

  // 1. Historical replay — the finalScore fields already encode utility * historical preference.
  const historicalBest = Math.max(...c.presented.map((o) => o.finalScore));
  const historicalCandidates = c.presented.filter((o) => o.finalScore >= historicalBest - bandThreshold);
  const historicalIdx = Math.floor((c.rngRoll ?? 0) * historicalCandidates.length);
  const historicalPick = historicalCandidates[Math.min(historicalIdx, historicalCandidates.length - 1)]!;
  const replayHistorical = { chosenOptionId: historicalPick.optionId, matches: historicalPick.optionId === c.chosenOptionId };

  // 2. Replay-now — re-derive preferenceWeight from current SelfModel.
  //    The ChoicePoint carries option kinds implicitly via description; we
  //    treat the description prefix `[kind]` when present, else use the
  //    baked preferenceWeight. To keep this dependency-free we approximate
  //    using preferenceFor(presenceId, optionId).
  const nowScored = c.presented.map((o) => {
    // Attempt to look up current preference weight for the option's kind hint.
    const kindMatch = o.description.match(/\[kind:([^\]]+)\]/);
    const kind = kindMatch?.[1] ?? o.optionId;
    const currentPref = selfModel.preferenceFor(ep.presenceId, kind);
    const utility = o.finalScore / (o.preferenceWeight || 1);
    return { ...o, currentPref, currentScore: utility * currentPref };
  });
  const nowBest = Math.max(...nowScored.map((o) => o.currentScore));
  const nowCandidates = nowScored.filter((o) => o.currentScore >= nowBest - bandThreshold);
  const nowIdx = Math.floor((c.rngRoll ?? 0) * nowCandidates.length);
  const nowPick = nowCandidates[Math.min(nowIdx, nowCandidates.length - 1)]!;
  const matches = nowPick.optionId === c.chosenOptionId;
  const replayNow: { chosenOptionId: string; matches: boolean; note?: string } = matches
    ? { chosenOptionId: nowPick.optionId, matches }
    : { chosenOptionId: nowPick.optionId, matches, note: 'preferences shifted since episode' };

  const divergence = !replayNow.matches;
  const detail = divergence
    ? `Historical choice was "${c.chosenOptionId}" (${historicalPick.finalScore.toFixed(2)}). Current preferences now favor "${nowPick.optionId}" (${nowPick.currentScore.toFixed(2)}). The agent has been shaped by subsequent consequences.`
    : `The choice is stable: replaying with current preferences still yields "${c.chosenOptionId}".`;

  return {
    episodeId: ep.episodeId,
    storedChoice: c.chosenOptionId,
    replayHistorical,
    replayNow,
    divergence,
    detail,
  };
}
