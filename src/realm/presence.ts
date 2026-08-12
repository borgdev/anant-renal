// PresenceRegistry — who is in the world right now.
// Every agent that enters a realm acquires a Presence. Presence is the
// agent's body; moving it changes what the agent perceives.

import { randomUUID } from 'node:crypto';
import type { AgentPresence, EntityUrn, RealmId } from './types.js';

export interface PresenceInit {
  realmId: RealmId;
  agentSpecId: string;
  runId: string;
  role: AgentPresence['role'];
  clearance: AgentPresence['clearance'];
  purposeOfUse: AgentPresence['purposeOfUse'];
  location: AgentPresence['location'];
  perceptualRange?: Partial<AgentPresence['perceptualRange']>;
}

export class PresenceRegistry {
  private presences = new Map<string, AgentPresence>();
  private subs: Array<(evt: { kind: 'spawned' | 'moved' | 'attention' | 'retired'; presence: AgentPresence }) => void> = [];

  onChange(cb: (e: { kind: 'spawned' | 'moved' | 'attention' | 'retired'; presence: AgentPresence }) => void): () => void {
    this.subs.push(cb);
    return () => { this.subs = this.subs.filter((x) => x !== cb); };
  }
  private emit(kind: 'spawned' | 'moved' | 'attention' | 'retired', presence: AgentPresence) {
    for (const cb of this.subs) cb({ kind, presence });
  }

  spawn(init: PresenceInit): AgentPresence {
    const presenceId = randomUUID();
    const presence: AgentPresence = {
      presenceId,
      realmId: init.realmId,
      agentSpecId: init.agentSpecId,
      runId: init.runId,
      role: init.role,
      clearance: init.clearance,
      purposeOfUse: init.purposeOfUse,
      location: init.location,
      perceptualRange: {
        units: init.perceptualRange?.units ?? [init.location.unitId ?? '*'],
        patients: init.perceptualRange?.patients ?? ['*'],
        eventTypes: init.perceptualRange?.eventTypes ?? ['*'],
      },
      attention: 'active',
      spawnedAt: new Date().toISOString(),
    };
    this.presences.set(presenceId, presence);
    this.emit('spawned', presence);
    return presence;
  }

  move(presenceId: string, location: Partial<AgentPresence['location']>): AgentPresence {
    const p = this.presences.get(presenceId);
    if (!p) throw new Error(`presence-not-found: ${presenceId}`);
    p.location = { ...p.location, ...location };
    // Moving to a different unit updates perceptual range unless explicitly wildcarded
    if (location.unitId && !p.perceptualRange.units.includes('*')) {
      p.perceptualRange.units = [location.unitId];
    }
    this.emit('moved', p);
    return p;
  }

  setAttention(presenceId: string, attention: AgentPresence['attention']): AgentPresence {
    const p = this.presences.get(presenceId);
    if (!p) throw new Error(`presence-not-found: ${presenceId}`);
    p.attention = attention;
    this.emit('attention', p);
    return p;
  }

  retire(presenceId: string): void {
    const p = this.presences.get(presenceId);
    if (!p) return;
    this.presences.delete(presenceId);
    this.emit('retired', p);
  }

  get(presenceId: string): AgentPresence | undefined { return this.presences.get(presenceId); }
  list(): AgentPresence[] { return [...this.presences.values()]; }
  listAtFacility(facilityId: string): AgentPresence[] {
    return [...this.presences.values()].filter((p) => p.location.facilityId === facilityId);
  }
  listAtUnit(facilityId: string, unitId: string): AgentPresence[] {
    return [...this.presences.values()].filter((p) => p.location.facilityId === facilityId && p.location.unitId === unitId);
  }

  markPerceived(presenceId: string, at: string): void {
    const p = this.presences.get(presenceId);
    if (p) p.lastPerceivedAt = at;
  }

  // Given an entity, decide whether a presence should perceive it.
  canPerceive(presence: AgentPresence, entityKind: string, entityId: string, entityFacilityId?: string, entityUnitId?: string): boolean {
    // Facility scoping — always required in twin mode; sim mode uses the same rule for consistency.
    if (entityFacilityId && entityFacilityId !== presence.location.facilityId) return false;
    // Unit scoping
    if (entityUnitId) {
      const units = presence.perceptualRange.units;
      if (!units.includes('*') && !units.includes(entityUnitId)) return false;
    }
    // Patient scoping — check when entity is a patient
    if (entityKind === 'patient') {
      const patients = presence.perceptualRange.patients;
      if (!patients.includes('*') && !patients.includes(entityId)) return false;
    }
    return true;
  }
}
