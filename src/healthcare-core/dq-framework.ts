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

// Full DQ framework — the eleven categories called out in the design chat:
// completeness, conformance, consistency, uniqueness, timeliness, validity,
// provenance, drift, reconciliation, quarantine, remediation.
//
// This layer is intentionally distinct from `data-quality.ts` (which is the
// generic rule engine). It defines the *categories*, per-category rule
// contracts, and the quarantine + remediation queues.

import type { CanonicalEvent } from './events.js';
import type { DataQualityFinding, DqSeverity } from './data-quality.js';

export type DQCategory =
  | 'completeness'
  | 'conformance'
  | 'consistency'
  | 'uniqueness'
  | 'timeliness'
  | 'validity'
  | 'provenance'
  | 'drift'
  | 'reconciliation';

export interface DQRule {
  readonly id: string;
  readonly category: DQCategory;
  readonly description: string;
  readonly severity: DqSeverity;
  evaluate(events: readonly CanonicalEvent[]): DataQualityFinding[];
}

// ---- Built-in category rules ----------------------------------------------

export const completenessRule = (id: string, requiredFields: readonly string[], eventTypes: readonly string[]): DQRule => ({
  id,
  category: 'completeness',
  description: `Required fields present on ${eventTypes.join(',')}: ${requiredFields.join(',')}`,
  severity: 'error',
  evaluate(events) {
    const findings: DataQualityFinding[] = [];
    for (const e of events) {
      if (!eventTypes.includes(e.type)) continue;
      for (const f of requiredFields) {
        if (e.payload[f] === undefined || e.payload[f] === null || e.payload[f] === '') {
          findings.push({ ruleId: id, severity: 'error', entityId: e.id, message: `Missing ${f} on ${e.type}`, evidence: { eventId: e.id, field: f } });
        }
      }
    }
    return findings;
  },
});

export const uniquenessRule = (id: string, eventTypes: readonly string[]): DQRule => ({
  id,
  category: 'uniqueness',
  description: `Event ids unique across ${eventTypes.join(',')}`,
  severity: 'critical',
  evaluate(events) {
    const seen = new Map<string, string>();
    const findings: DataQualityFinding[] = [];
    for (const e of events) {
      if (!eventTypes.includes(e.type)) continue;
      const prev = seen.get(e.id);
      if (prev) findings.push({ ruleId: id, severity: 'critical', entityId: e.id, message: `Duplicate event id`, evidence: { previous: prev, current: e.id } });
      seen.set(e.id, e.id);
    }
    return findings;
  },
});

export const timelinessRule = (id: string, eventType: string, maxLagMinutes: number): DQRule => ({
  id,
  category: 'timeliness',
  description: `${eventType} ingested within ${maxLagMinutes} minutes of occurrence`,
  severity: 'warning',
  evaluate(events) {
    const findings: DataQualityFinding[] = [];
    for (const e of events) {
      if (e.type !== eventType) continue;
      const occurred = Date.parse(e.occurredAt);
      const ingested = Date.parse(e.provenance.ingestedAt);
      if (!Number.isFinite(occurred) || !Number.isFinite(ingested)) continue;
      const lagMin = (ingested - occurred) / 60000;
      if (lagMin > maxLagMinutes) {
        findings.push({ ruleId: id, severity: 'warning', entityId: e.id, message: `Lag ${lagMin.toFixed(1)}m exceeds ${maxLagMinutes}m`, evidence: { lagMin, maxLagMinutes } });
      }
    }
    return findings;
  },
});

export const validityRule = <T>(id: string, eventType: string, field: string, predicate: (v: T) => boolean): DQRule => ({
  id,
  category: 'validity',
  description: `${eventType}.${field} passes predicate`,
  severity: 'error',
  evaluate(events) {
    const findings: DataQualityFinding[] = [];
    for (const e of events) {
      if (e.type !== eventType) continue;
      const v = e.payload[field] as T | undefined;
      if (v === undefined) continue;
      if (!predicate(v)) findings.push({ ruleId: id, severity: 'error', entityId: e.id, message: `${field} invalid`, evidence: { value: v } });
    }
    return findings;
  },
});

export const provenanceRule = (id: string): DQRule => ({
  id,
  category: 'provenance',
  description: 'Every event carries a sourceId + observedAt',
  severity: 'critical',
  evaluate(events) {
    return events.flatMap<DataQualityFinding>((e) => {
      if (!e.provenance.sourceId || !e.provenance.observedAt) {
        return [{ ruleId: id, severity: 'critical', entityId: e.id, message: 'Missing provenance', evidence: { provenance: e.provenance } }];
      }
      return [];
    });
  },
});

export interface DriftBaseline {
  readonly eventType: string;
  readonly expectedFieldSet: readonly string[];
}

export const conformanceRule = (id: string, baseline: DriftBaseline): DQRule => ({
  id,
  category: 'conformance',
  description: `${baseline.eventType} conforms to declared schema`,
  severity: 'error',
  evaluate(events) {
    const findings: DataQualityFinding[] = [];
    for (const e of events) {
      if (e.type !== baseline.eventType) continue;
      const unknownFields = Object.keys(e.payload).filter((k) => !baseline.expectedFieldSet.includes(k));
      if (unknownFields.length > 0) {
        findings.push({ ruleId: id, severity: 'error', entityId: e.id, message: `Unexpected fields: ${unknownFields.join(',')}`, evidence: { unknownFields } });
      }
    }
    return findings;
  },
});

export const driftRule = (id: string, baseline: DriftBaseline, minPresenceRatio = 0.9): DQRule => ({
  id,
  category: 'drift',
  description: `${baseline.eventType} field-presence within tolerance`,
  severity: 'warning',
  evaluate(events) {
    const scoped = events.filter((e) => e.type === baseline.eventType);
    if (scoped.length === 0) return [];
    const findings: DataQualityFinding[] = [];
    for (const f of baseline.expectedFieldSet) {
      const present = scoped.filter((e) => e.payload[f] !== undefined).length;
      const ratio = present / scoped.length;
      if (ratio < minPresenceRatio) {
        findings.push({ ruleId: id, severity: 'warning', message: `Field ${f} present in only ${(ratio * 100).toFixed(1)}%`, evidence: { field: f, ratio, minPresenceRatio } });
      }
    }
    return findings;
  },
});

export const reconciliationRule = (id: string, leftType: string, rightType: string, joinKey: string): DQRule => ({
  id,
  category: 'reconciliation',
  description: `${leftType} reconciles with ${rightType} on payload.${joinKey}`,
  severity: 'warning',
  evaluate(events) {
    const left = new Set(events.filter((e) => e.type === leftType).map((e) => String(e.payload[joinKey])));
    const right = new Set(events.filter((e) => e.type === rightType).map((e) => String(e.payload[joinKey])));
    const findings: DataQualityFinding[] = [];
    for (const k of left) if (!right.has(k)) findings.push({ ruleId: id, severity: 'warning', message: `Left ${leftType} without matching ${rightType}`, evidence: { key: k } });
    for (const k of right) if (!left.has(k)) findings.push({ ruleId: id, severity: 'warning', message: `Right ${rightType} without matching ${leftType}`, evidence: { key: k } });
    return findings;
  },
});

// ---- Quarantine + remediation queues --------------------------------------

export interface QuarantineEntry {
  readonly id: string;
  readonly eventId: string;
  readonly reason: string;
  readonly severity: DqSeverity;
  readonly ruleId: string;
  readonly enqueuedAt: string;
  readonly status: 'quarantined' | 'released' | 'discarded' | 'remediated';
  readonly remediation?: string;
}

export class QuarantineQueue {
  private readonly entries = new Map<string, QuarantineEntry>();

  quarantine(findings: readonly DataQualityFinding[], now: string = new Date().toISOString()): QuarantineEntry[] {
    const newEntries: QuarantineEntry[] = [];
    for (const f of findings) {
      if (f.severity !== 'error' && f.severity !== 'critical') continue;
      if (!f.entityId) continue;
      const entry: QuarantineEntry = {
        id: `q:${f.entityId}:${f.ruleId}`,
        eventId: f.entityId,
        reason: f.message,
        severity: f.severity,
        ruleId: f.ruleId,
        enqueuedAt: now,
        status: 'quarantined',
      };
      this.entries.set(entry.id, entry);
      newEntries.push(entry);
    }
    return newEntries;
  }

  release(id: string, remediation: string): QuarantineEntry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Quarantine entry not found: ${id}`);
    const updated: QuarantineEntry = { ...e, status: 'remediated', remediation };
    this.entries.set(id, updated);
    return updated;
  }

  discard(id: string, reason: string): QuarantineEntry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Quarantine entry not found: ${id}`);
    const updated: QuarantineEntry = { ...e, status: 'discarded', remediation: reason };
    this.entries.set(id, updated);
    return updated;
  }

  list(): readonly QuarantineEntry[] {
    return Array.from(this.entries.values());
  }
}

export class DQFramework {
  private readonly rules = new Map<string, DQRule>();
  readonly quarantine = new QuarantineQueue();

  register(rule: DQRule): void {
    this.rules.set(rule.id, rule);
  }

  evaluate(events: readonly CanonicalEvent[]): { findings: DataQualityFinding[]; byCategory: Record<DQCategory, DataQualityFinding[]> } {
    const findings: DataQualityFinding[] = [];
    const byCategory: Record<DQCategory, DataQualityFinding[]> = {
      completeness: [], conformance: [], consistency: [], uniqueness: [],
      timeliness: [], validity: [], provenance: [], drift: [], reconciliation: [],
    };
    for (const rule of this.rules.values()) {
      const out = rule.evaluate(events);
      for (const f of out) {
        findings.push(f);
        byCategory[rule.category].push(f);
      }
    }
    return { findings, byCategory };
  }

  gateAndQuarantine(events: readonly CanonicalEvent[]): {
    findings: DataQualityFinding[];
    quarantined: readonly QuarantineEntry[];
    proceed: boolean;
  } {
    const { findings } = this.evaluate(events);
    const quarantined = this.quarantine.quarantine(findings);
    const proceed = !findings.some((f) => f.severity === 'critical');
    return { findings, quarantined, proceed };
  }
}
