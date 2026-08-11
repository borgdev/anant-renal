// Break-glass emergency-access ledger. The AccessEvaluator already accepts
// an emergency flag; break-glass adds an *append-only ledger* that captures
// the reason, the elevated scope, the duration, and the post-event review
// status. Zero-trust posture requires that every emergency grant be
// justifiable and reviewable.

export interface BreakGlassGrant {
  readonly id: string;
  readonly requestedAt: string;
  readonly actorRef: string;
  readonly patientRef: string;
  readonly reason: string;
  readonly clinicalNecessityStatement: string;
  readonly elevatedScopeIds: readonly string[];
  readonly maxDurationMinutes: number;
  readonly expiresAt: string;
  readonly approvedBy?: string; // if pre-approval required
  readonly reviewedAt?: string;
  readonly reviewOutcome?: 'appropriate' | 'requires-training' | 'policy-violation';
  readonly reviewerRef?: string;
}

export class BreakGlassLedger {
  private readonly entries = new Map<string, BreakGlassGrant>();

  request(input: Omit<BreakGlassGrant, 'id' | 'expiresAt'>): BreakGlassGrant {
    const requestedMs = Date.parse(input.requestedAt);
    const expiresAt = new Date(requestedMs + input.maxDurationMinutes * 60000).toISOString();
    const grant: BreakGlassGrant = {
      id: `bg:${input.actorRef}:${input.patientRef}:${input.requestedAt}`,
      expiresAt,
      ...input,
    };
    this.entries.set(grant.id, grant);
    return grant;
  }

  review(id: string, reviewerRef: string, outcome: NonNullable<BreakGlassGrant['reviewOutcome']>, at: string): BreakGlassGrant {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Break-glass grant not found: ${id}`);
    const updated: BreakGlassGrant = { ...e, reviewerRef, reviewOutcome: outcome, reviewedAt: at };
    this.entries.set(id, updated);
    return updated;
  }

  active(now: string): readonly BreakGlassGrant[] {
    const t = Date.parse(now);
    return Array.from(this.entries.values()).filter((e) => Date.parse(e.expiresAt) > t && !e.reviewedAt);
  }

  unreviewed(): readonly BreakGlassGrant[] {
    return Array.from(this.entries.values()).filter((e) => !e.reviewedAt);
  }

  list(): readonly BreakGlassGrant[] { return Array.from(this.entries.values()); }
}
