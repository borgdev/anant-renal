import { createHash } from 'node:crypto';
import type { AccessDecision } from './access.js';

// The audit ledger is append-only and content-addressed. Every entry chains to
// its predecessor via a SHA-256 hash so tampering is detectable, and every
// entry captures who/what/why/when so post-hoc review is complete.

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  scopeId: string;
  action: string;
  traceId: string;
  resourceId?: string;
  decision?: AccessDecision;
  policyVersion?: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface SealedAuditEvent extends AuditEvent {
  sequence: number;
  previousHash: string;
  hash: string;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const GENESIS = '0'.repeat(64);

export class AuditLedger {
  private readonly events: SealedAuditEvent[] = [];

  append(event: AuditEvent): SealedAuditEvent {
    const previousHash = this.events.length === 0 ? GENESIS : this.events[this.events.length - 1]!.hash;
    const sequence = this.events.length;
    const payload = stableStringify({ ...event, sequence, previousHash });
    const hash = sha256Hex(payload);
    const sealed: SealedAuditEvent = Object.freeze({ ...event, sequence, previousHash, hash });
    this.events.push(sealed);
    return sealed;
  }

  all(): readonly SealedAuditEvent[] {
    return this.events;
  }

  /** Recomputes every hash to detect tampering. Returns null on success, else the first bad index. */
  verify(): number | null {
    let previousHash = GENESIS;
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i]!;
      const { hash: _hash, ...rest } = e;
      const payload = stableStringify({ ...rest, previousHash });
      const expected = sha256Hex(payload);
      if (expected !== e.hash || e.previousHash !== previousHash) return i;
      previousHash = e.hash;
    }
    return null;
  }
}
