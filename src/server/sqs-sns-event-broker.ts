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

// AWS SNS/SQS EventBroker driver (optional deps — lazy load). Topic → SNS
// topic; consume from a bound SQS queue. Publish uses MessageGroupId +
// MessageDeduplicationId (FIFO) for ordering + idempotency; failed handlers are
// left in the queue until the redrive policy moves them to the DLQ.

import type { StreamBinding, StreamMessage } from '../adapters/event-stream.js';
import {
  encodeCanonicalEvent,
  type EventBroker,
  type EventBrokerDriver,
  type EventBrokerHealth,
  type EventBrokerPublishOptions,
  type EventBrokerRecord,
} from './event-broker.js';
import { lazyRequire } from './lazy-require.js';

// Minimal structural types for the AWS SDK surface we use (SDKs not installed).
interface SnsClient { send(cmd: { input: unknown; constructor: { name: string } }): Promise<unknown>; }
interface SqsClient { send(cmd: { input: unknown; constructor: { name: string } }): Promise<unknown>; }
interface AwsLibs { SNS: new (opts?: Record<string, unknown>) => SnsClient; SQS: new (opts?: Record<string, unknown>) => SqsClient; }

export interface SqsSnsEventBrokerDeps {
  readonly topicArn: string;
  readonly queueUrl: string;
  readonly region?: string;
  readonly pollMs?: number;
  readonly maxAttempts?: number;
  readonly dlqUrl?: string;
  /** Injected AWS SDKs for tests (defaults to lazy require). */
  readonly sdk?: AwsLibs;
}

export class SqsSnsEventBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'sqs-sns';
  private readonly topicArn: string;
  private readonly queueUrl: string;
  private readonly region: string;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly dlqUrl: string | undefined;
  private readonly getSdk: () => AwsLibs;
  private sns?: SnsClient;
  private sqs?: SqsClient;
  private started = false;
  private timer?: NodeJS.Timeout;
  private readonly handlers = new Map<string, (msg: StreamMessage) => Promise<void>>();
  private dead = 0;

  constructor(deps: SqsSnsEventBrokerDeps) {
    this.topicArn = deps.topicArn;
    this.queueUrl = deps.queueUrl;
    this.region = deps.region ?? 'us-east-1';
    this.pollMs = deps.pollMs ?? 250;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.dlqUrl = deps.dlqUrl;
    this.getSdk = deps.sdk ? () => deps.sdk! : lazyRequire<AwsLibs>('@aws-sdk/client-sns-sqs');
  }

  async start(): Promise<void> {
    const sdk = this.getSdk();
    this.sns = new sdk.SNS({ region: this.region });
    this.sqs = new sdk.SQS({ region: this.region });
    this.started = true;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.started = false;
  }

  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    if (!this.sns) throw new Error('sqs-sns broker not started');
    const payload = { value: encodeCanonicalEvent(record.event), key: opts?.partitionKey ?? record.event.id, headers: { 'x-event-id': record.event.id, ...(record.headers ?? {}) } };
    await this.sns.send({ input: {
      TopicArn: this.topicArn,
      Message: JSON.stringify(payload),
      MessageGroupId: opts?.partitionKey ?? record.event.scopeId ?? record.event.id,
      MessageDeduplicationId: record.event.id,
      MessageAttributes: { 'x-event-id': { DataType: 'String', StringValue: record.event.id } },
    }, constructor: { name: 'PublishCommand' } });
  }

  async subscribe(binding: StreamBinding, handler: (msg: StreamMessage) => Promise<void>): Promise<void> {
    this.handlers.set(binding.topic, handler);
  }

  private async poll(): Promise<void> {
    if (!this.started || !this.sqs) return;
    try {
      const res = await this.sqs.send({ input: { QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }, constructor: { name: 'ReceiveMessageCommand' } }) as { Messages?: Array<{ MessageId: string; ReceiptHandle: string; Body: string; Attributes?: Record<string, string> }> };
      for (const m of res.Messages ?? []) {
        let parsed: { value: string; key?: string; headers?: Record<string, string> } | undefined;
        try { parsed = JSON.parse(m.Body ?? '{}') as { value: string; key?: string; headers?: Record<string, string> }; } catch { parsed = undefined; }
        const topic = this.handlers.size === 1 ? [...this.handlers.keys()][0]! : 'anant.canonical.events';
        const msg: StreamMessage = {
          topic, partition: 0, offset: m.MessageId, key: parsed?.key ?? null, value: parsed?.value ?? m.Body ?? '',
          ...(parsed?.headers ? { headers: parsed.headers } : {}),
          timestamp: m.Attributes?.['SentTimestamp'] ? new Date(Number(m.Attributes['SentTimestamp'])).toISOString() : new Date().toISOString(),
        };
        const handler = this.handlers.get(topic);
        if (!handler) { await this.delete(m.ReceiptHandle); continue; }
        try {
          await handler(msg);
          await this.delete(m.ReceiptHandle);
        } catch {
          this.dead += 1; // visibility timeout will redeliver; redrive policy → DLQ
        }
      }
    } catch { /* transient */ }
  }

  private async delete(receiptHandle: string): Promise<void> {
    if (!this.sqs) return;
    await this.sqs.send({ input: { QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }, constructor: { name: 'DeleteMessageCommand' } }).catch(() => undefined);
  }

  async health(): Promise<EventBrokerHealth> {
    try {
      if (!this.sqs) return { ok: false, driver: 'sqs-sns' };
      await this.sqs.send({ input: { QueueUrl: this.queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }, constructor: { name: 'GetQueueAttributesCommand' } });
      return { ok: true, driver: 'sqs-sns', detail: this.queueUrl };
    } catch (err) {
      return { ok: false, driver: 'sqs-sns', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async deadLetterSize(): Promise<number> {
    if (!this.dlqUrl || !this.sqs) return this.dead;
    try {
      const res = await this.sqs.send({ input: { QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }, constructor: { name: 'GetQueueAttributesCommand' } }) as { Attributes?: Record<string, string> };
      return Number(res.Attributes?.['ApproximateNumberOfMessages'] ?? 0);
    } catch {
      return this.dead;
    }
  }
}
