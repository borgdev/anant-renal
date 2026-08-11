import type { AccessDecision } from './access.js';

// The audit ledger is append-only and content-addressed. Every entry chains to
// its predecessor via a running hash so tampering is detectable, and every
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

// Small, dependency-free stable hash. Not cryptographic strength; sufficient
// for chain-integrity checks in tests and demos. Adapters can swap in SHA-256.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class AuditLedger {
  private readonly events: SealedAuditEvent[] = [];

  append(event: AuditEvent): SealedAuditEvent {
    const previousHash = this.events.length === 0 ? '0'.repeat(8) : this.events[this.events.length - 1]!.hash;
    const sequence = this.events.length;
    const payload = stableStringify({ ...event, sequence, previousHash });
    const hash = fnv1aHex(payload);
    const sealed: SealedAuditEvent = Object.freeze({ ...event, sequence, previousHash, hash });
    this.events.push(sealed);
    return sealed;
  }

  all(): readonly SealedAuditEvent[] {
    return this.events;
  }

  /** Recomputes every hash to detect tampering. Returns null on success, else the first bad index. */
  verify(): number | null {
    let previousHash = '0'.repeat(8);
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i]!;
      const { hash: _hash, ...rest } = e;
      const payload = stableStringify({ ...rest, previousHash });
      const expected = fnv1aHex(payload);
      if (expected !== e.hash || e.previousHash !== previousHash) return i;
      previousHash = e.hash;
    }
    return null;
  }
}
