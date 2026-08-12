// M12 — Human-In-The-Loop gates.
//
// An HITL gate suspends an EmittedEffect BEFORE it applies mutations.
// The queue exposes pending approvals to operators; on approve, the effect
// re-enters the reducer as a normal emit. On reject, the gate records the
// rejection and no mutation runs.
//
// Gate matching: any (role, effectKind, severity) triple can be required.

import type { EmittedEffect, WorldEffect, AgentPresence } from './types.js';
import type { EffectLedger } from './effect-ledger.js';
import type { EntityGraph } from './entity-graph.js';

export interface HITLGate {
  id: string;
  matches(presence: AgentPresence, effect: WorldEffect): boolean;
  reason: string;
}

export interface ApprovalRecord {
  approvalId: string;
  gateId: string;
  presenceId: string;
  agentSpecId: string;
  effect: WorldEffect;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

export type ApprovalDecisionHook = (approval: ApprovalRecord) => void;

/** Manages HITL gates + pending approval queue as first-class entities. */
export class HITLRegistry {
  private gates: HITLGate[] = [];
  private queue: Map<string, ApprovalRecord> = new Map();
  private counter = 0;
  private hooks: ApprovalDecisionHook[] = [];

  constructor(private graph: EntityGraph, private ledger: EffectLedger) {}

  registerGate(g: HITLGate): void { this.gates.push(g); }
  listGates(): HITLGate[] { return [...this.gates]; }

  onDecision(cb: ApprovalDecisionHook): () => void {
    this.hooks.push(cb);
    return () => { this.hooks = this.hooks.filter((h) => h !== cb); };
  }

  /** Returns the first matching gate, if any. */
  match(presence: AgentPresence, effect: WorldEffect): HITLGate | undefined {
    for (const g of this.gates) if (g.matches(presence, effect)) return g;
    return undefined;
  }

  /** Suspend the effect. Creates an approval entity and stores it in the queue. */
  suspend(presence: AgentPresence, effect: WorldEffect, gate: HITLGate): ApprovalRecord {
    this.counter++;
    const approvalId = `appr-${this.counter}-${Math.random().toString(36).slice(2, 6)}`;
    const at = new Date().toISOString();
    const rec: ApprovalRecord = {
      approvalId,
      gateId: gate.id,
      presenceId: presence.presenceId,
      agentSpecId: presence.agentSpecId,
      effect,
      requestedAt: at,
      status: 'pending',
    };
    this.queue.set(approvalId, rec);
    // Materialize as an entity so it shows in graph snapshots + UI.
    this.graph.create('approval', approvalId, {
      gateId: gate.id,
      presenceId: presence.presenceId,
      agentSpecId: presence.agentSpecId,
      effectKind: effect.kind,
      effect: effect as unknown as Record<string, unknown>,
      requestedAt: at,
      status: 'pending',
      reason: gate.reason,
    });
    // Log a synthetic thought entry in the ledger so history is complete.
    this.ledger.append({
      presenceId: presence.presenceId,
      agentSpecId: presence.agentSpecId,
      realmAt: at,
      effect: { kind: 'record-agent-thought', note: `[HITL] gate ${gate.id} suspended ${effect.kind}: awaiting approval ${approvalId}` },
      status: 'shadow',
    });
    return rec;
  }

  pending(): ApprovalRecord[] {
    return [...this.queue.values()].filter((r) => r.status === 'pending');
  }
  all(): ApprovalRecord[] { return [...this.queue.values()]; }
  get(approvalId: string): ApprovalRecord | undefined { return this.queue.get(approvalId); }

  decide(approvalId: string, decision: 'approve' | 'reject', decidedBy: string, note?: string): ApprovalRecord {
    const rec = this.queue.get(approvalId);
    if (!rec) throw new Error(`approval-not-found: ${approvalId}`);
    if (rec.status !== 'pending') throw new Error(`approval-not-pending: ${approvalId}`);
    const at = new Date().toISOString();
    rec.status = decision === 'approve' ? 'approved' : 'rejected';
    rec.decidedAt = at;
    rec.decidedBy = decidedBy;
    if (note !== undefined) rec.note = note;
    // Update the approval entity.
    const urn = this.graph.urnFor('approval', approvalId);
    if (this.graph.get(urn)) {
      this.graph.patch(urn, { status: rec.status, decidedAt: at, decidedBy, decisionNote: note ?? null }, `hitl-decision`);
    }
    for (const h of this.hooks) h(rec);
    return rec;
  }
}

// ---- Default gates ----

export const DEFAULT_GATES: HITLGate[] = [
  {
    id: 'gate.critical-safety-event',
    reason: 'Critical safety events require operator approval before being logged externally.',
    matches: (_p, e) => e.kind === 'flag-safety-event' && (e as { severity?: string }).severity === 'critical',
  },
  {
    id: 'gate.expired-discharge',
    reason: 'Discharge with disposition=expired requires operator sign-off.',
    matches: (_p, e) => e.kind === 'discharge-patient' && (e as { disposition?: string }).disposition === 'expired',
  },
  {
    id: 'gate.high-dollar-claim',
    reason: 'Claims with multiple high-value CPT codes require RCM lead approval.',
    matches: (_p, e) => e.kind === 'submit-claim' && Array.isArray((e as { cptCodes?: string[] }).cptCodes) && ((e as { cptCodes?: string[] }).cptCodes?.length ?? 0) >= 4,
  },
];
