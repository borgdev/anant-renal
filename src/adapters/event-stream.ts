// Event-stream adapter (Kafka-shaped, driver-injectable).

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface StreamMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timestamp: string;
}

export interface StreamBinding {
  readonly topic: string;
  readonly source: string;
  readonly eventType: CanonicalEventType;
  readonly subjectPath: string;
  readonly occurredAtPath?: string;
}

export interface StreamMappingOptions {
  facilityId: string;
  scopeId: string;
  ingestedAt: string;
  classification?: 'internal' | 'confidential' | 'phi';
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, seg) => {
    if (cur !== null && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[seg];
    }
    return undefined;
  }, obj);
}

export function streamMessageToEvent(msg: StreamMessage, binding: StreamBinding, opts: StreamMappingOptions): CanonicalEvent {
  let decoded: unknown = {};
  try { decoded = JSON.parse(msg.value); } catch { decoded = { rawValue: msg.value }; }
  const subject = getPath(decoded, binding.subjectPath);
  const occurredAt = binding.occurredAtPath ? getPath(decoded, binding.occurredAtPath) : msg.timestamp;
  return {
    id: `event:stream:${msg.topic}:${msg.partition}:${msg.offset}`,
    type: binding.eventType,
    occurredAt: typeof occurredAt === 'string' ? occurredAt : msg.timestamp,
    scopeId: opts.scopeId,
    subjectId: typeof subject === 'string' ? subject : 'unknown',
    facilityId: opts.facilityId,
    payload: (decoded !== null && typeof decoded === 'object') ? (decoded as Record<string, unknown>) : { value: msg.value },
    provenance: { sourceId: `stream:${binding.source}:${msg.topic}`, observedAt: msg.timestamp, ingestedAt: opts.ingestedAt },
    classification: opts.classification ?? 'phi',
  };
}
