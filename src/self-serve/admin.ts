// M18 — Governed self-serve admin.
//
// Per-realm pack toggles, meter overrides, custom effect kinds, HITL
// gate builder, and branding — all governed through IdentityRegistry
// (only role: admin) and logged to the identity audit trail.

import { IdentityRegistry } from '../identity/registry.js';

export interface RealmPackToggles {
  realmId: string;
  enabledPacks: string[];        // pack ids
  disabledAgents: string[];      // agent ids to explicitly disable
  updatedAt: string;
  updatedBy?: string;
}

export interface MeterOverride {
  realmId: string;
  unit: string;                  // e.g. 'llm.tokens.input'
  priceUsdPerUnit: number;
  budgetCapMonthlyUsd?: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface CustomEffectKind {
  realmId: string;
  kind: string;
  schema: Record<string, unknown>;
  purpose: string;
  hitlRequired: boolean;
  createdAt: string;
}

export interface HitlGateSpec {
  realmId: string;
  gateId: string;
  agentSelector: string;         // agent id glob (e.g. 'oncology-*')
  afterStepId: string;
  role: string;
  slaMinutes: number;
  createdAt: string;
}

export interface RealmBranding {
  realmId: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  brandName?: string;
  supportEmail?: string;
  updatedAt: string;
}

const packToggles = new Map<string, RealmPackToggles>();
const meterOverrides = new Map<string, MeterOverride[]>();     // realmId → list
const customEffects = new Map<string, CustomEffectKind[]>();   // realmId → list
const hitlGates = new Map<string, HitlGateSpec[]>();           // realmId → list
const branding = new Map<string, RealmBranding>();

function requireAdmin(actorSubjectId?: string): void {
  if (!actorSubjectId) return; // internal calls (bootstrap/tests)
  const p = IdentityRegistry.getPrincipal(actorSubjectId);
  if (!p) throw new Error('actor-not-authenticated');
  if (p.role !== 'admin') throw new Error(`actor-not-admin:${actorSubjectId}`);
}

export const SelfServeAdmin = {
  // Pack toggles
  setPackToggles(input: Omit<RealmPackToggles, 'updatedAt'>, actorSubjectId?: string): RealmPackToggles {
    requireAdmin(actorSubjectId);
    const rec: RealmPackToggles = { ...input, updatedAt: new Date().toISOString(), ...(actorSubjectId ? { updatedBy: actorSubjectId } : {}) };
    packToggles.set(input.realmId, rec);
    IdentityRegistry.audit('self-serve.pack-toggles.set', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${input.realmId} packs=${input.enabledPacks.length}` });
    return rec;
  },
  getPackToggles(realmId: string): RealmPackToggles | undefined { return packToggles.get(realmId); },
  listPackToggles(): RealmPackToggles[] { return [...packToggles.values()]; },

  // Meter overrides
  addMeterOverride(input: Omit<MeterOverride, 'updatedAt'>, actorSubjectId?: string): MeterOverride {
    requireAdmin(actorSubjectId);
    const rec: MeterOverride = { ...input, updatedAt: new Date().toISOString(), ...(actorSubjectId ? { updatedBy: actorSubjectId } : {}) };
    const list = meterOverrides.get(input.realmId) ?? [];
    const idx = list.findIndex((m) => m.unit === input.unit);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    meterOverrides.set(input.realmId, list);
    IdentityRegistry.audit('self-serve.meter-override.set', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${input.realmId} unit=${input.unit}` });
    return rec;
  },
  listMeterOverrides(realmId: string): MeterOverride[] { return meterOverrides.get(realmId) ?? []; },

  // Custom effect kinds
  registerCustomEffect(input: Omit<CustomEffectKind, 'createdAt'>, actorSubjectId?: string): CustomEffectKind {
    requireAdmin(actorSubjectId);
    const rec: CustomEffectKind = { ...input, createdAt: new Date().toISOString() };
    const list = customEffects.get(input.realmId) ?? [];
    list.push(rec);
    customEffects.set(input.realmId, list);
    IdentityRegistry.audit('self-serve.custom-effect.registered', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${input.realmId} kind=${input.kind}` });
    return rec;
  },
  listCustomEffects(realmId: string): CustomEffectKind[] { return customEffects.get(realmId) ?? []; },

  // HITL gates
  addHitlGate(input: Omit<HitlGateSpec, 'createdAt' | 'gateId'>, actorSubjectId?: string): HitlGateSpec {
    requireAdmin(actorSubjectId);
    const gateId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rec: HitlGateSpec = { ...input, gateId, createdAt: new Date().toISOString() };
    const list = hitlGates.get(input.realmId) ?? [];
    list.push(rec);
    hitlGates.set(input.realmId, list);
    IdentityRegistry.audit('self-serve.hitl-gate.added', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${input.realmId} selector=${input.agentSelector}` });
    return rec;
  },
  listHitlGates(realmId: string): HitlGateSpec[] { return hitlGates.get(realmId) ?? []; },
  removeHitlGate(realmId: string, gateId: string, actorSubjectId?: string): boolean {
    requireAdmin(actorSubjectId);
    const list = hitlGates.get(realmId) ?? [];
    const next = list.filter((g) => g.gateId !== gateId);
    hitlGates.set(realmId, next);
    IdentityRegistry.audit('self-serve.hitl-gate.removed', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${realmId} gateId=${gateId}` });
    return list.length !== next.length;
  },

  // Branding
  setBranding(input: Omit<RealmBranding, 'updatedAt'>, actorSubjectId?: string): RealmBranding {
    requireAdmin(actorSubjectId);
    const rec: RealmBranding = { ...input, updatedAt: new Date().toISOString() };
    branding.set(input.realmId, rec);
    IdentityRegistry.audit('self-serve.branding.set', { ...(actorSubjectId ? { subjectId: actorSubjectId } : {}), note: `realmId=${input.realmId}` });
    return rec;
  },
  getBranding(realmId: string): RealmBranding | undefined { return branding.get(realmId); },
  listBranding(): RealmBranding[] { return [...branding.values()]; },
};
