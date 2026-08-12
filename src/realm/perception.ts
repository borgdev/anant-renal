// PerceptionRouter — the sensory system.
//
// Raw events (entity mutations, effect applications, ambient events, clock
// ticks) enter the router. It filters them per presence and delivers only
// what that presence is allowed to perceive.

import { randomUUID } from 'node:crypto';
import type { AgentPresence, EntityUrn, PerceivedEvent } from './types.js';
import type { PresenceRegistry } from './presence.js';

export interface RawEvent {
  kind: string; // 'entity.updated', 'effect.applied', 'ambient.result-ready', 'clock.tick'
  entityUrn?: EntityUrn;
  entityKind?: string;
  entityId?: string;
  facilityId?: string;
  unitId?: string;
  patientId?: string;
  payload: Record<string, unknown>;
  realmAt: string;
}

type Subscriber = { presenceId: string; cb: (e: PerceivedEvent) => void };

export class PerceptionRouter {
  private subs: Subscriber[] = [];
  private log: PerceivedEvent[] = []; // ring buffer for operator inspection
  private maxLog = 5000;

  constructor(private readonly presences: PresenceRegistry) {}

  subscribe(presenceId: string, cb: (e: PerceivedEvent) => void): () => void {
    const s = { presenceId, cb };
    this.subs.push(s);
    return () => { this.subs = this.subs.filter((x) => x !== s); };
  }

  broadcast(event: RawEvent): PerceivedEvent[] {
    const delivered: PerceivedEvent[] = [];
    for (const sub of this.subs) {
      const presence = this.presences.get(sub.presenceId);
      if (!presence) continue;
      if (presence.attention === 'paused') continue;

      // Event-kind subscription filter
      const wantAll = presence.perceptualRange.eventTypes.includes('*');
      if (!wantAll && !presence.perceptualRange.eventTypes.includes(event.kind)) continue;

      // Locality filter
      if (event.entityKind && event.entityId) {
        if (!this.presences.canPerceive(presence, event.entityKind, event.entityId, event.facilityId, event.unitId)) continue;
      } else if (event.facilityId && event.facilityId !== presence.location.facilityId) {
        continue;
      }

      const perceived: PerceivedEvent = {
        eventId: randomUUID(),
        presenceId: presence.presenceId,
        at: new Date().toISOString(),
        realmAt: event.realmAt,
        kind: event.kind,
        ...(event.entityUrn !== undefined ? { entityUrn: event.entityUrn } : {}),
        payload: event.payload,
      };
      sub.cb(perceived);
      this.presences.markPerceived(presence.presenceId, perceived.at);
      delivered.push(perceived);
      this.recordLog(perceived);
    }
    return delivered;
  }

  private recordLog(p: PerceivedEvent) {
    this.log.push(p);
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
  }
  recentLog(limit = 200): PerceivedEvent[] { return this.log.slice(-limit); }
}
