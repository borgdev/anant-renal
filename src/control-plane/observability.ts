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

// Observability primitives — distributed-tracing span shape, metrics
// registration, and SLO evaluation. In-process reference implementation.

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: 'ok' | 'error' | 'in-progress';
  readonly events: readonly { readonly at: string; readonly name: string; readonly attributes?: Record<string, unknown> }[];
}

export interface MetricPoint {
  readonly name: string;
  readonly value: number;
  readonly at: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface SLO {
  readonly id: string;
  readonly description: string;
  readonly indicator: 'availability' | 'latency-p95' | 'error-rate' | 'freshness';
  readonly objective: number; // e.g. 0.999 or 500 (ms)
  readonly windowDays: number;
  evaluate(points: readonly MetricPoint[]): { met: boolean; observed: number };
}

export class SLOTelemetry {
  private readonly spans = new Map<string, Span>();
  private readonly metrics: MetricPoint[] = [];
  private readonly slos = new Map<string, SLO>();

  startSpan(name: string, traceId: string, spanId: string, opts?: { parentSpanId?: string; attributes?: Record<string, string | number | boolean> }): Span {
    const span: Span = {
      traceId,
      spanId,
      ...(opts?.parentSpanId ? { parentSpanId: opts.parentSpanId } : {}),
      name,
      startedAt: new Date().toISOString(),
      attributes: opts?.attributes ?? {},
      status: 'in-progress',
      events: [],
    };
    this.spans.set(spanId, span);
    return span;
  }

  endSpan(spanId: string, status: 'ok' | 'error'): Span | undefined {
    const s = this.spans.get(spanId);
    if (!s) return undefined;
    const ended: Span = { ...s, endedAt: new Date().toISOString(), status };
    this.spans.set(spanId, ended);
    return ended;
  }

  recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
    this.metrics.push({ name, value, at: new Date().toISOString(), labels });
  }

  registerSLO(slo: SLO): void { this.slos.set(slo.id, slo); }

  evaluateSLOs(): readonly { readonly sloId: string; readonly met: boolean; readonly observed: number }[] {
    const out: { sloId: string; met: boolean; observed: number }[] = [];
    for (const [id, slo] of this.slos) {
      const scoped = this.metrics.filter((m) => m.name === slo.indicator);
      const r = slo.evaluate(scoped);
      out.push({ sloId: id, met: r.met, observed: r.observed });
    }
    return out;
  }

  listSpans(): readonly Span[] { return Array.from(this.spans.values()); }
  listMetrics(): readonly MetricPoint[] { return this.metrics; }
}
