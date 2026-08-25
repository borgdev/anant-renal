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

// Structured telemetry pipeline.
//
// Emits JSON-line spans, metrics, and log records with a consistent envelope.
// The transport is an injected `TelemetrySink` — production installs write to
// stdout for a Fluent Bit / OTel collector to pick up; tests use an in-memory
// sink. The envelope mirrors OpenTelemetry semantics but has no dependency on
// the OTel SDK so we control every field.

export interface SpanRecord {
  readonly kind: 'span';
  readonly service: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly attributes: Record<string, unknown>;
  readonly status: 'ok' | 'error';
  readonly error?: { message: string; type?: string; stack?: string };
}
export interface LogRecord {
  readonly kind: 'log';
  readonly service: string;
  readonly traceId?: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly at: string;
  readonly message: string;
  readonly attributes: Record<string, unknown>;
}
export interface MetricRecord {
  readonly kind: 'metric';
  readonly service: string;
  readonly at: string;
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly attributes: Record<string, unknown>;
}

export type TelemetryRecord = SpanRecord | LogRecord | MetricRecord;

export interface TelemetrySink {
  write(record: TelemetryRecord): void;
}

export class StdoutSink implements TelemetrySink {
  write(record: TelemetryRecord): void {
    // Structured JSON on stdout for a log collector to ingest.
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

export class InMemorySink implements TelemetrySink {
  readonly records: TelemetryRecord[] = [];
  write(record: TelemetryRecord): void { this.records.push(record); }
}

export class Telemetry {
  constructor(
    private readonly service: string,
    private readonly sink: TelemetrySink,
    private readonly level: 'debug' | 'info' | 'warn' | 'error' = 'info',
    private readonly clock: () => Date = () => new Date(),
    private readonly rng: () => string = () => Math.random().toString(36).slice(2, 18),
  ) {}

  startSpan(name: string, ctx?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> }): { end: (status?: 'ok' | 'error', error?: Error) => void; traceId: string; spanId: string } {
    const startedAt = this.clock().toISOString();
    const traceId = ctx?.traceId ?? this.rng();
    const spanId = this.rng();
    const attrs = { ...(ctx?.attributes ?? {}) };
    return {
      traceId, spanId,
      end: (status = 'ok', error?: Error) => {
        const endedAt = this.clock().toISOString();
        const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
        const record: SpanRecord = {
          kind: 'span', service: this.service, traceId, spanId,
          ...(ctx?.parentSpanId !== undefined ? { parentSpanId: ctx.parentSpanId } : {}),
          name, startedAt, endedAt, durationMs, attributes: attrs, status,
          ...(error ? { error: { message: error.message, type: error.name, ...(error.stack !== undefined ? { stack: error.stack } : {}) } } : {}),
        };
        this.sink.write(record);
      },
    };
  }

  metric(name: string, value: number, opts?: { unit?: string; attributes?: Record<string, unknown> }): void {
    const record: MetricRecord = {
      kind: 'metric', service: this.service, at: this.clock().toISOString(),
      name, value,
      ...(opts?.unit !== undefined ? { unit: opts.unit } : {}),
      attributes: opts?.attributes ?? {},
    };
    this.sink.write(record);
  }

  log(level: LogRecord['level'], message: string, opts?: { traceId?: string; attributes?: Record<string, unknown> }): void {
    const priority = { debug: 0, info: 1, warn: 2, error: 3 };
    if (priority[level] < priority[this.level]) return;
    const record: LogRecord = {
      kind: 'log', service: this.service,
      ...(opts?.traceId !== undefined ? { traceId: opts.traceId } : {}),
      level, at: this.clock().toISOString(),
      message, attributes: opts?.attributes ?? {},
    };
    this.sink.write(record);
  }
}
