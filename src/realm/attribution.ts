// Consequence Attribution — auto-scores the outcomes that follow a
// ChoicePoint, so an agent's Self-Model gets shaped by its own history
// without a human labeler.
//
// Model:
//   - Every closed Episode that has a ChoicePoint opens an attribution
//     window (default 4 realm-hours after the last chosen effect).
//   - Downstream effects landing in the ledger during the window are
//     classified against a small rule table: safety events, adverse
//     lab shifts, or unresolved perception → NEGATIVE; care completion,
//     stable trajectory, resolution of the opening perception → POSITIVE;
//     everything else → NEUTRAL.
//   - The classifier emits a Consequence for each choice-effect kind the
//     agent chose, weighted by how strong the signal is.
//   - Consequences flow into SelfModelRegistry.applyConsequence, which
//     shifts preference weights and rolling competence.
//
// Deterministic, replayable, no LLM. All rules are pure functions.

import type { Episode, EpisodeStore } from './episode.js';
import type { SelfModelRegistry, Consequence } from './self-model.js';
import type { EffectLedger } from './effect-ledger.js';
import type { EmittedEffect, WorldEffect } from './types.js';

export interface AttributionRule {
  id: string;
  description: string;
  match: (downstream: WorldEffect, episode: Episode) => { outcome: Consequence['outcome']; weight: number } | null;
}

export const DEFAULT_ATTRIBUTION_RULES: AttributionRule[] = [
  {
    id: 'safety-event-after-med-action',
    description: 'A flag-safety-event downstream of a med order/administer/titrate attributes negatively to that action kind.',
    match: (d, ep) => {
      if (d.kind !== 'flag-safety-event') return null;
      const patientId = (d as { patientId?: string }).patientId;
      const hadMedAction = ep.effects.some((e) => (e.kind === 'order-med' || e.kind === 'administer-med' || e.kind === 'titrate-med') && (e as { patientId?: string }).patientId === patientId);
      if (!hadMedAction) return null;
      const severity = (d as { severity?: string }).severity ?? 'moderate';
      const weight = severity === 'critical' ? 1.0 : severity === 'high' ? 0.8 : severity === 'moderate' ? 0.5 : 0.3;
      return { outcome: 'negative', weight };
    },
  },
  {
    id: 'hold-med-averted-safety',
    description: 'A hold-med with no downstream safety-event during the window attributes positively (silence = success).',
    match: (d, ep) => {
      // Handled as absence-of-evidence separately below via flush; here match discharge-home for the same patient as positive outcome.
      if (d.kind !== 'discharge-patient') return null;
      if ((d as { disposition?: string }).disposition !== 'home' && (d as { disposition?: string }).disposition !== 'home-health') return null;
      const patientId = (d as { patientId?: string }).patientId;
      const cared = ep.effects.some((e) => (e.kind === 'hold-med' || e.kind === 'update-care-plan' || e.kind === 'record-assessment') && (e as { patientId?: string }).patientId === patientId);
      if (!cared) return null;
      return { outcome: 'positive', weight: 0.6 };
    },
  },
  {
    id: 'claim-followup-scheduled',
    description: 'A submit-claim followed by schedule-followup attributes positively to claim submission.',
    match: (d, ep) => {
      if (d.kind !== 'schedule-followup') return null;
      const hadClaim = ep.effects.some((e) => e.kind === 'submit-claim');
      if (!hadClaim) return null;
      return { outcome: 'positive', weight: 0.4 };
    },
  },
  {
    id: 'lab-normal-after-order',
    description: 'A lab result without abnormal flag downstream of an order-lab attributes positively.',
    match: (d, ep) => {
      if (d.kind !== 'result-lab') return null;
      const abn = (d as { abnormal?: string }).abnormal;
      if (abn && abn !== '') return null;
      const code = (d as { code?: string }).code;
      const hadOrder = ep.effects.some((e) => e.kind === 'order-lab' && (e as { code?: string }).code === code);
      if (!hadOrder) return null;
      return { outcome: 'positive', weight: 0.3 };
    },
  },
  {
    id: 'lab-abnormal-after-order',
    description: 'A lab result with an H/HH/L/LL abnormal flag downstream of an order-lab attributes negatively.',
    match: (d, ep) => {
      if (d.kind !== 'result-lab') return null;
      const abn = (d as { abnormal?: string }).abnormal;
      if (!abn) return null;
      const code = (d as { code?: string }).code;
      const hadOrder = ep.effects.some((e) => e.kind === 'order-lab' && (e as { code?: string }).code === code);
      if (!hadOrder) return null;
      const weight = (abn === 'HH' || abn === 'LL') ? 0.6 : 0.3;
      return { outcome: 'negative', weight };
    },
  },
  {
    id: 'notify-then-transfer',
    description: 'A patient-transfer downstream of a notify-staff attributes positively (escalation worked).',
    match: (d, ep) => {
      if (d.kind !== 'transfer-patient') return null;
      const hadNotify = ep.effects.some((e) => e.kind === 'notify-staff');
      if (!hadNotify) return null;
      return { outcome: 'positive', weight: 0.5 };
    },
  },
];

export interface AttributionRecord {
  attributionId: string;
  episodeId: string;
  presenceId: string;
  downstreamEffectId: string;
  ruleId: string;
  consequence: Consequence;
  attributedAt: string;
}

export interface AttributorOpts {
  windowMs?: number; // real ms window after episode close
  rules?: AttributionRule[];
}

// The Attributor listens to the ledger for new effects and, for each,
// walks any recently-closed episodes whose window is still open and
// tests attribution rules. Records each attribution and pushes the
// consequence into the SelfModelRegistry.
export class ConsequenceAttributor {
  private records: AttributionRecord[] = [];
  private rules: AttributionRule[];
  private windowMs: number;
  private closedEpisodeWindow = new Map<string, { closedAtMs: number }>();

  constructor(
    private readonly ledger: EffectLedger,
    private readonly episodes: EpisodeStore,
    private readonly selfModel: SelfModelRegistry,
    opts: AttributorOpts = {},
  ) {
    this.rules = opts.rules ?? DEFAULT_ATTRIBUTION_RULES;
    this.windowMs = opts.windowMs ?? 4 * 3_600_000;
    this.ledger.onAppend((entry) => this.onLedgerEntry(entry));
  }

  // Called by the runtime when it closes an episode — starts the window.
  noteEpisodeClosed(episodeId: string, closedAtMs: number): void {
    this.closedEpisodeWindow.set(episodeId, { closedAtMs });
  }

  private onLedgerEntry(entry: EmittedEffect): void {
    const now = Date.now();
    for (const [episodeId, window] of this.closedEpisodeWindow) {
      if (now - window.closedAtMs > this.windowMs) {
        this.closedEpisodeWindow.delete(episodeId);
        continue;
      }
      const ep = this.episodes.get(episodeId);
      if (!ep || ep.status === 'pruned') continue;
      // Skip attribution when the downstream effect *is* one of this
      // episode's own effects.
      if (ep.consequences.includes(entry.effectId)) continue;
      for (const rule of this.rules) {
        const match = rule.match(entry.effect, ep);
        if (!match) continue;
        const consequence: Consequence = {
          effectId: entry.effectId,
          kind: this.pickPreferenceKind(ep, entry.effect),
          outcome: match.outcome,
          weight: match.weight,
        };
        this.selfModel.applyConsequence(ep.presenceId, consequence);
        this.records.push({
          attributionId: `attr:${entry.effectId}:${ep.episodeId}:${rule.id}`,
          episodeId: ep.episodeId,
          presenceId: ep.presenceId,
          downstreamEffectId: entry.effectId,
          ruleId: rule.id,
          consequence,
          attributedAt: new Date().toISOString(),
        });
      }
    }
  }

  // The preference-shaping kind is the most-recently-chosen effect kind
  // in the episode (the choice most likely responsible).
  private pickPreferenceKind(ep: Episode, _downstream: WorldEffect): string {
    if (ep.effects.length === 0) return 'unknown';
    return ep.effects[ep.effects.length - 1]!.kind;
  }

  all(): AttributionRecord[] { return [...this.records]; }
  forPresence(presenceId: string): AttributionRecord[] { return this.records.filter((r) => r.presenceId === presenceId); }
  forEpisode(episodeId: string): AttributionRecord[] { return this.records.filter((r) => r.episodeId === episodeId); }
  stats() {
    const byOutcome: Record<string, number> = {};
    const byRule: Record<string, number> = {};
    for (const r of this.records) {
      byOutcome[r.consequence.outcome] = (byOutcome[r.consequence.outcome] ?? 0) + 1;
      byRule[r.ruleId] = (byRule[r.ruleId] ?? 0) + 1;
    }
    return { total: this.records.length, byOutcome, byRule, openWindows: this.closedEpisodeWindow.size };
  }
}
