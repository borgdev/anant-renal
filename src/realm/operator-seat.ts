// M12 — Conversational operator seat.
//
// Natural-language directive → typed intent to change realm state.
// Pattern-based parser (deterministic) with a pluggable LLM fallback.
//
// Verbs supported:
//   - spawn              "spawn a nurse in unit-a"
//   - nudge-preference   "bias nurse-1 toward hold-med by 0.3"
//   - add-rule           "add a rule: when critical safety event, notify md"
//   - submit-intent      "get patient-1 discharged safely"
//   - explain            "explain nurse-1's last decision"
//
// Every directive is returned as a proposed Diff which the operator must
// confirm before it applies; applying records a WorldEffect kind='operator-directive'
// in the ledger for full audit trail.

import type { Realm } from './realm.js';
import type { WorldEffect } from './types.js';

export type OperatorVerb = 'spawn' | 'nudge-preference' | 'add-rule' | 'submit-intent' | 'explain';

export interface OperatorDirective {
  verb: OperatorVerb;
  targetRef?: string;
  payload: Record<string, unknown>;
  originalText: string;
  reasoning: string;
  confidence: number; // 0..1
}

export interface OperatorLLMAdapter {
  id: string;
  parse(text: string): Promise<OperatorDirective | undefined>;
}

/** Deterministic pattern parser for common phrasings. Returns undefined if no pattern matches. */
export function parseDirectiveDeterministic(text: string): OperatorDirective | undefined {
  const t = text.trim().toLowerCase();

  // spawn a <role> in <unitId>
  const spawn = /^spawn (?:an? )?([a-z-]+)(?:\s+in\s+([a-z0-9-]+))?/.exec(t);
  if (spawn) {
    const [, role, unitId] = spawn;
    return {
      verb: 'spawn',
      payload: { role, unitId: unitId ?? null },
      originalText: text,
      reasoning: `Detected 'spawn' verb with role='${role}'${unitId ? ` in unit='${unitId}'` : ''}.`,
      confidence: 0.9,
    };
  }

  // bias <presenceId> toward <effectKind> by <delta>
  // e.g. "bias nurse-1 toward hold-med by 0.3"
  const nudge = /^(?:bias|nudge)\s+(\S+)\s+(?:toward|for)\s+([a-z-]+)\s+by\s+(-?\d*\.?\d+)/.exec(t);
  if (nudge) {
    const [, presenceId, effectKind, deltaStr] = nudge;
    return {
      verb: 'nudge-preference',
      targetRef: presenceId ?? '',
      payload: { presenceId, effectKind, delta: Number(deltaStr) },
      originalText: text,
      reasoning: `Detected preference nudge for '${presenceId}' effectKind='${effectKind}' delta=${deltaStr}.`,
      confidence: 0.92,
    };
  }

  // add a rule: when <trigger>, <action>
  const rule = /^(?:add|create) (?:an? |a )?rule[:\s]+(.+)/.exec(t);
  if (rule) {
    return {
      verb: 'add-rule',
      payload: { ruleText: (rule[1] ?? '').trim() },
      originalText: text,
      reasoning: `Detected 'add rule' directive. Rule body will be queued for review.`,
      confidence: 0.75,
    };
  }

  // get <subject> discharged safely | resolve safety event for <subject> | process claim for <subject> | fix station <subject>
  const dis = /^(?:get\s+)?([a-z0-9-]+)\s+discharged\s+safely/.exec(t);
  if (dis) {
    return {
      verb: 'submit-intent',
      targetRef: dis[1] ?? '',
      payload: { intentKind: 'discharge-patient-safely', subjectRef: dis[1], description: text, priority: 'normal' },
      originalText: text,
      reasoning: `Detected discharge intent for '${dis[1]}'.`,
      confidence: 0.9,
    };
  }
  const safety = /^resolve\s+safety(?:\s+event)?\s+(?:for\s+)?([a-z0-9-]+)/.exec(t);
  if (safety) {
    return {
      verb: 'submit-intent',
      targetRef: safety[1] ?? '',
      payload: { intentKind: 'resolve-safety-event', subjectRef: safety[1], description: text, priority: 'high' },
      originalText: text,
      reasoning: `Detected safety-event resolution intent for '${safety[1]}'.`,
      confidence: 0.9,
    };
  }
  const claim = /^process\s+claim\s+(?:for\s+)?([a-z0-9-]+)/.exec(t);
  if (claim) {
    return {
      verb: 'submit-intent',
      targetRef: claim[1] ?? '',
      payload: { intentKind: 'process-claim', subjectRef: claim[1], description: text, priority: 'normal' },
      originalText: text,
      reasoning: `Detected claim-processing intent for encounter '${claim[1]}'.`,
      confidence: 0.9,
    };
  }
  const fix = /^fix\s+station\s+([a-z0-9-]+)/.exec(t);
  if (fix) {
    return {
      verb: 'submit-intent',
      targetRef: fix[1] ?? '',
      payload: { intentKind: 'fix-station', subjectRef: fix[1], description: text, priority: 'high' },
      originalText: text,
      reasoning: `Detected fix-station intent for '${fix[1]}'.`,
      confidence: 0.92,
    };
  }

  // explain <presenceId>['s last decision]
  const explain = /^explain\s+([a-z0-9-]+)/.exec(t);
  if (explain) {
    return {
      verb: 'explain',
      targetRef: explain[1] ?? '',
      payload: { presenceId: explain[1], scope: 'last-decision' },
      originalText: text,
      reasoning: `Detected explanation request for '${explain[1]}'.`,
      confidence: 0.85,
    };
  }

  return undefined;
}

export class OperatorSeat {
  private llm?: OperatorLLMAdapter | undefined;

  constructor(private realm: Realm, llm?: OperatorLLMAdapter) {
    if (llm) this.llm = llm;
  }

  setLLM(a: OperatorLLMAdapter | undefined): void { this.llm = a; }

  /** Parse a raw operator utterance; deterministic first, LLM fallback if configured. */
  async parse(text: string): Promise<OperatorDirective | undefined> {
    const det = parseDirectiveDeterministic(text);
    if (det) return det;
    if (this.llm) return this.llm.parse(text);
    return undefined;
  }

  /** Apply a directive to the realm. Requires an admin presence to record the audit effect. */
  apply(directive: OperatorDirective, adminPresenceId: string): { applied: boolean; note: string; effect?: WorldEffect } {
    // Every applied directive gets recorded as an audit-only effect.
    const effect: WorldEffect = {
      kind: 'operator-directive',
      verb: directive.verb,
      ...(directive.targetRef !== undefined ? { targetRef: directive.targetRef } : {}),
      payload: directive.payload,
      originalText: directive.originalText,
    };
    this.realm.emit(adminPresenceId, effect);
    // Execute side effects per verb.
    switch (directive.verb) {
      case 'nudge-preference': {
        const { presenceId, effectKind, delta } = directive.payload as { presenceId: string; effectKind: string; delta: number };
        this.realm.selfModel.nudgePreference(presenceId, effectKind, delta, `operator-directive:${directive.originalText}`);
        return { applied: true, note: `Preference for ${presenceId} on ${effectKind} nudged by ${delta}.`, effect };
      }
      case 'submit-intent': {
        const p = directive.payload as { intentKind: string; subjectRef?: string; description: string; priority: 'low' | 'normal' | 'high' | 'critical' };
        const intentEffect: WorldEffect = {
          kind: 'submit-intent',
          intentKind: p.intentKind,
          ...(p.subjectRef !== undefined ? { subjectRef: p.subjectRef } : {}),
          description: p.description,
          priority: p.priority,
        };
        this.realm.emit(adminPresenceId, intentEffect);
        return { applied: true, note: `Intent '${p.intentKind}' submitted for '${p.subjectRef ?? '(none)'}'.`, effect };
      }
      case 'explain': {
        const { presenceId } = directive.payload as { presenceId: string };
        const model = this.realm.selfModel.get(presenceId);
        if (!model) return { applied: true, note: `No self-model exists for '${presenceId}' yet.`, effect };
        const summary = Object.entries(model.preferences)
          .filter(([, v]) => Math.abs(v - 1.0) > 0.001)
          .sort((a, b) => Math.abs(b[1] - 1.0) - Math.abs(a[1] - 1.0))
          .slice(0, 5)
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(', ');
        return { applied: true, note: `Top preference shifts: ${summary || '(none learned yet)'}. Competence sample=${model.competence.sample}, score=${model.competence.score.toFixed(2)}.`, effect };
      }
      case 'spawn':
      case 'add-rule': {
        // Recorded as operator-directive for audit; concrete wiring left to caller (spawn requires role + agentSpec, add-rule requires DSL).
        return { applied: true, note: `Directive '${directive.verb}' recorded. Follow-up required to fully wire.`, effect };
      }
    }
  }
}
