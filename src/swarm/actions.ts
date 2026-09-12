/******************************************************************************
 * Action catalog — THE single definition of what an action IS.
 *
 * Three things were previously smeared across the codebase and none of them was
 * "the actions":
 *   1. the executable effect payloads .... src/realm/types.ts (`WorldEffect`)
 *   2. the governed name vocabulary ...... src/swarm/types.ts (`WorldEffectKind`)
 *   3. WHO may perform one ............... src/swarm/cells.ts (`allowedActions`)
 * while an NBA candidate named no action at all — the action only appeared later
 * as a hardcoded literal at `dispatchCommand(...)`. This module closes that gap:
 * it is the only place that says what an action is called, what it is worth and
 * how that worth is denominated, so a value can never be rendered in the wrong
 * unit (the console used to multiply a signal count by 1000 and call it dollars).
 *
 * An NBA MUST name one of these kinds (`NbaCandidate.action`), and the cell that
 * proposes it must already list the kind in its `allowedActions` allowlist —
 * verified by `assertActionAllowed` / `rankNextBestActions`.
 ******************************************************************************/

import type { WorldEffectKind } from './types.js';

/** The denomination of an NBA's value claim. A `valueUnit` and its amount are
 *  what make `expectedOutcome` interpretable; the unit owns the scale. */
export type ActionValueUnit =
  | 'treatments' | 'chair-hours' | 'dollars' | 'claims' | 'authorizations'
  | 'labs' | 'doses' | 'assessments' | 'care-plans' | 'observations'
  | 'safety-events' | 'notifications' | 'tickets' | 'escalations'
  | 'objects' | 'plans' | 'approvals' | 'directives' | 'patients'
  | 'intents' | 'thoughts' | 'effects' | 'none';

/** Magnitude that counts as a full-credit outcome for a unit. The score uses the
 *  saturating curve `x / (x + scale)`, so values of different units are
 *  comparable, a bigger value always scores higher, and nothing ever collapses
 *  into an exact tie (the old `min(1, x / 50)` made every effect count ≥ 50
 *  score identically, so the ranking fell through to alphabetical order). */
export const UNIT_SCALE: Record<ActionValueUnit, number> = {
  treatments: 20,
  'chair-hours': 24,
  dollars: 250_000,
  claims: 200,
  authorizations: 50,
  labs: 200,
  doses: 200,
  assessments: 50,
  'care-plans': 50,
  observations: 500,
  'safety-events': 20,
  notifications: 100,
  tickets: 50,
  escalations: 20,
  objects: 20,
  plans: 20,
  approvals: 20,
  directives: 20,
  patients: 50,
  intents: 20,
  thoughts: 20,
  effects: 5_000,
  none: 1,
};

/** Display noun for a unit (singular/plural). */
export const UNIT_LABEL: Record<ActionValueUnit, { one: string; many: string }> = {
  treatments: { one: 'treatment', many: 'treatments' },
  'chair-hours': { one: 'chair-hour', many: 'chair-hours' },
  dollars: { one: 'dollar', many: 'dollars' },
  claims: { one: 'claim', many: 'claims' },
  authorizations: { one: 'authorization', many: 'authorizations' },
  labs: { one: 'lab result', many: 'lab results' },
  doses: { one: 'dose', many: 'doses' },
  assessments: { one: 'assessment', many: 'assessments' },
  'care-plans': { one: 'care plan', many: 'care plans' },
  observations: { one: 'observation', many: 'observations' },
  'safety-events': { one: 'safety event', many: 'safety events' },
  notifications: { one: 'notification', many: 'notifications' },
  tickets: { one: 'ticket', many: 'tickets' },
  escalations: { one: 'escalation', many: 'escalations' },
  objects: { one: 'object', many: 'objects' },
  plans: { one: 'plan', many: 'plans' },
  approvals: { one: 'approval', many: 'approvals' },
  directives: { one: 'directive', many: 'directives' },
  patients: { one: 'patient', many: 'patients' },
  intents: { one: 'intent', many: 'intents' },
  thoughts: { one: 'note', many: 'notes' },
  effects: { one: 'effect signal', many: 'effect signals' },
  none: { one: 'unit', many: 'units' },
};

export type ActionDomain = 'clinical' | 'operational' | 'financial' | 'safety' | 'governance';

export interface ActionDefinition {
  kind: WorldEffectKind;
  /** Imperative label ("Schedule follow-up"). */
  label: string;
  domain: ActionDomain;
  /** Unit this action's value is most often denominated in. */
  defaultUnit: ActionValueUnit;
}

/** Every action the swarm may propose. Exhaustive over `WorldEffectKind` — a new
 *  effect kind cannot be added without declaring it here (compile error). */
export const ACTION_CATALOG: Record<WorldEffectKind, ActionDefinition> = {
  'admit-patient': { kind: 'admit-patient', label: 'Admit patient', domain: 'clinical', defaultUnit: 'patients' },
  'transfer-patient': { kind: 'transfer-patient', label: 'Transfer patient', domain: 'clinical', defaultUnit: 'patients' },
  'discharge-patient': { kind: 'discharge-patient', label: 'Discharge patient', domain: 'clinical', defaultUnit: 'patients' },
  'order-lab': { kind: 'order-lab', label: 'Order lab', domain: 'clinical', defaultUnit: 'labs' },
  'result-lab': { kind: 'result-lab', label: 'Record lab result', domain: 'clinical', defaultUnit: 'labs' },
  'order-med': { kind: 'order-med', label: 'Order medication', domain: 'clinical', defaultUnit: 'doses' },
  'administer-med': { kind: 'administer-med', label: 'Administer medication', domain: 'clinical', defaultUnit: 'doses' },
  'hold-med': { kind: 'hold-med', label: 'Hold medication', domain: 'clinical', defaultUnit: 'doses' },
  'titrate-med': { kind: 'titrate-med', label: 'Titrate medication', domain: 'clinical', defaultUnit: 'doses' },
  'record-vitals': { kind: 'record-vitals', label: 'Record vitals', domain: 'clinical', defaultUnit: 'observations' },
  'record-assessment': { kind: 'record-assessment', label: 'Record assessment', domain: 'clinical', defaultUnit: 'assessments' },
  'update-care-plan': { kind: 'update-care-plan', label: 'Update care plan', domain: 'clinical', defaultUnit: 'care-plans' },
  'schedule-followup': { kind: 'schedule-followup', label: 'Schedule follow-up', domain: 'clinical', defaultUnit: 'treatments' },
  'notify-staff': { kind: 'notify-staff', label: 'Notify staff', domain: 'operational', defaultUnit: 'notifications' },
  'flag-safety-event': { kind: 'flag-safety-event', label: 'Flag safety event', domain: 'safety', defaultUnit: 'safety-events' },
  'submit-claim': { kind: 'submit-claim', label: 'Submit claim', domain: 'financial', defaultUnit: 'claims' },
  'request-prior-auth': { kind: 'request-prior-auth', label: 'Request prior authorization', domain: 'financial', defaultUnit: 'authorizations' },
  'record-agent-thought': { kind: 'record-agent-thought', label: 'Record agent note', domain: 'governance', defaultUnit: 'thoughts' },
  'assign-object': { kind: 'assign-object', label: 'Assign object', domain: 'operational', defaultUnit: 'objects' },
  'release-object': { kind: 'release-object', label: 'Release object', domain: 'operational', defaultUnit: 'objects' },
  'mark-object-state': { kind: 'mark-object-state', label: 'Mark object state', domain: 'operational', defaultUnit: 'objects' },
  'open-ticket': { kind: 'open-ticket', label: 'Open ticket', domain: 'operational', defaultUnit: 'tickets' },
  'update-ticket': { kind: 'update-ticket', label: 'Update ticket', domain: 'operational', defaultUnit: 'tickets' },
  'close-ticket': { kind: 'close-ticket', label: 'Close ticket', domain: 'operational', defaultUnit: 'tickets' },
  escalate: { kind: 'escalate', label: 'Escalate', domain: 'governance', defaultUnit: 'escalations' },
  'submit-intent': { kind: 'submit-intent', label: 'Submit intent', domain: 'governance', defaultUnit: 'intents' },
  'advance-plan': { kind: 'advance-plan', label: 'Advance plan', domain: 'governance', defaultUnit: 'plans' },
  'approve-effect': { kind: 'approve-effect', label: 'Approve effect', domain: 'governance', defaultUnit: 'approvals' },
  'operator-directive': { kind: 'operator-directive', label: 'Issue operator directive', domain: 'governance', defaultUnit: 'directives' },
};

export function actionDefinition(kind: WorldEffectKind): ActionDefinition {
  return ACTION_CATALOG[kind];
}

export function actionLabel(kind: WorldEffectKind): string {
  return ACTION_CATALOG[kind].label;
}

/** Format an amount in a declared unit — the ONLY value formatter, shared by both
 *  consoles so a count can never be re-denominated into currency downstream. */
export function formatActionValue(unit: ActionValueUnit, amount: number): string {
  const label = UNIT_LABEL[unit];
  if (unit === 'dollars') {
    if (amount >= 1_000_000) return `$${trim(amount / 1_000_000)}M`;
    if (amount >= 1_000) return `$${trim(amount / 1_000)}K`;
    return `$${Math.round(amount).toLocaleString('en-US')}`;
  }
  const n = Math.round(amount);
  return `${n.toLocaleString('en-US')} ${n === 1 ? label.one : label.many}`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Saturating normalisation: 0 at 0, 0.5 at `scale`, monotone and never capped. */
export function normaliseValue(unit: ActionValueUnit, amount: number): number {
  const scale = UNIT_SCALE[unit] || 1;
  const x = Math.max(0, amount);
  return x / (x + scale);
}

/** Value units a caller may declare without inventing a denomination. */
export function isActionValueUnit(v: string): v is ActionValueUnit {
  return Object.prototype.hasOwnProperty.call(UNIT_SCALE, v);
}
