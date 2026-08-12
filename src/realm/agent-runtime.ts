// AgentRealmRuntime — the bridge between AgentSpec and Realm.
//
// A spec by itself is a static declaration. The runtime brings it to life
// by:
//   1. Deriving a Presence from the spec's scope + governance + labels
//   2. Registering a Behavior — a function that maps perceived events to
//      emitted World Effects
//   3. Spawning the presence in a realm and subscribing it to perception
//
// Behaviors are pluggable. A default catalog of behaviors covers the
// common patterns declared in our 173 packs (rounding-md, charge-nurse,
// pharmacist-review, claims-coder, safety-monitor, kt-v-outreach, etc.).
// Agents without a matching behavior get a passive presence — they appear
// in the realm and can perceive, but do not emit effects. Adding new
// behaviors is how the harness grows.

import type { AgentSpec } from '../agents/index.js';
import type { Realm } from './realm.js';
import type { AgentPresence, EmittedEffect, PerceivedEvent, WorldEffect } from './types.js';
import { resolveChoice, type Option } from './choice.js';
import type { Episode } from './episode.js';

export type BehaviorContext = {
  realm: Realm;
  presence: AgentPresence;
  emit: (effect: WorldEffect) => EmittedEffect | undefined;
  spec: AgentSpec;
  // Open a deliberated choice with alternatives. The resolver applies
  // self-model preferences, picks stochastically within the band, and
  // records the ChoicePoint on the current episode.
  choose: <T>(options: Array<Option<T>>, rngSeed?: number) => { chosenAction: T; chosenOptionId: string };
  // Currently open episode for this presence (created by the runtime
  // when perception arrives).
  currentEpisode?: Episode;
};

export type Behavior = {
  id: string; // e.g. 'md.rounding'
  description: string;
  matches: (spec: AgentSpec) => boolean;
  onPerceive?: (event: PerceivedEvent, ctx: BehaviorContext) => void;
  onSpawn?: (ctx: BehaviorContext) => void;
};

// ---- Behavior registry ----
class BehaviorRegistry {
  private behaviors: Behavior[] = [];
  register(b: Behavior) { this.behaviors.push(b); }
  find(spec: AgentSpec): Behavior | undefined { return this.behaviors.find((b) => b.matches(spec)); }
  list(): readonly Behavior[] { return this.behaviors; }
}
export const behaviorRegistry = new BehaviorRegistry();

// ---- Role/clearance derivation from spec ----
function deriveRole(spec: AgentSpec): AgentPresence['role'] {
  const label = (spec.labels?.role ?? '').toLowerCase();
  if (['nurse', 'md', 'pa', 'pharmacist', 'coder', 'ops', 'auditor', 'tech', 'admin'].includes(label)) return label as AgentPresence['role'];
  const id = spec.id.toLowerCase();
  if (id.includes('nurse') || id.includes('rn')) return 'nurse';
  if (id.includes('md') || id.includes('physician') || id.includes('provider') || id.includes('rounding')) return 'md';
  if (id.includes('pharm') || id.includes('med-review')) return 'pharmacist';
  if (id.includes('coder') || id.includes('coding') || id.includes('claim')) return 'coder';
  if (id.includes('auth') || id.includes('audit') || id.includes('compliance')) return 'auditor';
  if (id.includes('tech')) return 'tech';
  if (id.includes('scheduler') || id.includes('scheduling') || id.includes('intake') || id.includes('outreach') || id.includes('billing') || id.includes('ops')) return 'ops';
  return 'ops';
}

function deriveClearance(spec: AgentSpec): AgentPresence['clearance'] {
  return spec.governance.clearanceRequired;
}

// ---- The runtime ----
export interface SpawnedAgent {
  presence: AgentPresence;
  spec: AgentSpec;
  behavior?: Behavior;
  unsubscribe: () => void;
}

function deriveLocalGoal(evt: PerceivedEvent, spec: AgentSpec): string {
  if (evt.kind === 'clock.tick') return 'observe the passage of time';
  if (evt.kind.startsWith('experience.')) return `respond to ${evt.kind.slice('experience.'.length)}`;
  if (evt.kind === 'effect.applied') return `witness a ${(evt.payload as { effect?: { kind?: string } }).effect?.kind ?? 'world event'}`;
  return `attend to ${spec.displayName}`;
}

export class AgentRealmRuntime {
  private spawned = new Map<string, SpawnedAgent>();
  constructor(private readonly realm: Realm) {}

  spawn(spec: AgentSpec, opts: { facilityId: string; unitId?: string; runId?: string } = { facilityId: 'default' }): SpawnedAgent {
    const role = deriveRole(spec);
    const clearance = deriveClearance(spec);
    // Facility-scoped agents see the whole facility; unit-scoped agents see one unit.
    const seesWholeFacility = spec.scope === 'facility' || spec.scope === 'org' || spec.scope === 'region';
    const presence = this.realm.spawnPresence({
      realmId: this.realm.id,
      agentSpecId: spec.id,
      runId: opts.runId ?? `${spec.id}-${Date.now()}`,
      role,
      clearance,
      purposeOfUse: spec.governance.purposeOfUse,
      location: { facilityId: opts.facilityId, ...(opts.unitId ? { unitId: opts.unitId } : {}) },
      perceptualRange: {
        units: seesWholeFacility ? ['*'] : [opts.unitId ?? '*'],
        patients: ['*'],
        eventTypes: ['*'],
      },
    });
    const behavior = behaviorRegistry.find(spec);
    // Ensure a self-model exists for this presence from spawn.
    this.realm.selfModel.ensure(presence);

    const openEpisodeIfNeeded = (evt: PerceivedEvent) => {
      const cur = this.realm.episodes.currentOpenFor(presence.presenceId);
      if (cur) return cur;
      return this.realm.episodes.openEpisode({
        presence,
        localGoal: deriveLocalGoal(evt, spec),
        openingPerception: [evt],
        openedAt: evt.realmAt,
      });
    };

    const ctx: BehaviorContext = {
      realm: this.realm, presence, spec,
      emit: (effect) => {
        const emitted = this.realm.emit(presence.presenceId, effect);
        const cur = this.realm.episodes.currentOpenFor(presence.presenceId);
        if (cur) this.realm.episodes.recordEffect(cur.episodeId, effect, emitted);
        return emitted;
      },
      choose: <T>(options: Array<Option<T>>, rngSeed?: number) => {
        const resolved = resolveChoice(options, { presenceId: presence.presenceId, selfModel: this.realm.selfModel, ...(rngSeed !== undefined ? { rngSeed } : {}) });
        const cur = this.realm.episodes.currentOpenFor(presence.presenceId);
        if (cur) this.realm.episodes.recordChoice(cur.episodeId, resolved.choice);
        return { chosenAction: resolved.action, chosenOptionId: resolved.choice.chosenOptionId };
      },
    };
    const unsubscribe = this.realm.subscribe(presence.presenceId, (evt) => {
      const ep = openEpisodeIfNeeded(evt);
      ctx.currentEpisode = ep;
      try { behavior?.onPerceive?.(evt, ctx); } catch { /* behavior fault does not kill realm */ }
      // Auto-close episodes on tick boundaries with importance derived from effects emitted.
      if (evt.kind === 'clock.tick') {
        const cur = this.realm.episodes.currentOpenFor(presence.presenceId);
        if (cur && cur.effects.length > 0) {
          const importance = cur.effects.some((e) => e.kind === 'flag-safety-event' || e.kind === 'hold-med') ? 'critical'
            : cur.effects.length > 3 ? 'notable' : 'routine';
          this.realm.episodes.closeEpisode(cur.episodeId, evt.realmAt, importance);
          this.realm.selfModel.refresh(presence, this.realm.episodes);
        }
      }
    });
    const rec: SpawnedAgent = { presence, spec, unsubscribe, ...(behavior ? { behavior } : {}) };
    this.spawned.set(presence.presenceId, rec);
    try { behavior?.onSpawn?.(ctx); } catch { /* ignore */ }
    return rec;
  }

  retire(presenceId: string): void {
    const s = this.spawned.get(presenceId);
    if (!s) return;
    s.unsubscribe();
    this.realm.retirePresence(presenceId);
    this.spawned.delete(presenceId);
  }

  list(): SpawnedAgent[] { return [...this.spawned.values()]; }
}

// ==== Default behavior catalog ====
// These behaviors bind common agent patterns to realm effects. Each behavior
// declares a `matches` predicate against AgentSpec — any spec that matches
// will get that behavior when spawned.

behaviorRegistry.register({
  id: 'md.rounding',
  description: 'Rounding MD reacts to abnormal labs: hyperkalemia holds ACEi, hyperphosphatemia orders binder, low HGB triggers ESA titration workup.',
  matches: (s) => /rounding|md|physician|provider/i.test(s.id) && !/consult|referral/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind !== 'effect.applied') return;
    const payload = evt.payload as { effect?: { kind?: string } };
    if (payload.effect?.kind !== 'result-lab') return;
    const eff = payload.effect as { kind: 'result-lab'; code: string; value: number; abnormal?: string; orderId: string };
    // Find the patient this lab pertains to.
    const order = ctx.realm.graph.get(ctx.realm.graph.urnFor('order', eff.orderId));
    const patientId = (order?.state as { patientId?: string })?.patientId;
    if (!patientId) return;
    if (eff.code === 'K' && eff.value > 5.5) {
      ctx.emit({ kind: 'record-agent-thought', note: `[md.rounding] K=${eff.value} on ${patientId} — evaluate ACEi hold.` });
      const meds = ctx.realm.graph.listKind('medication').filter((m) => {
        const st = m.state as { patientId?: string; code?: string; status?: string };
        return st.patientId === patientId && /lisinopril|enalapril|losartan|valsartan|spironolactone/i.test(st.code ?? '') && st.status === 'active';
      });
      for (const med of meds) {
        ctx.emit({ kind: 'hold-med', patientId, medOrderId: med.id, reason: `Hyperkalemia K=${eff.value}` });
      }
    }
    if (eff.code === 'PHOS' && eff.value > 5.5) {
      ctx.emit({ kind: 'record-agent-thought', note: `[md.rounding] Phos=${eff.value} on ${patientId} — start binder.` });
      ctx.emit({ kind: 'order-med', patientId, code: 'sevelamer', dose: '800mg', route: 'PO', frequency: 'TID with meals', indication: 'Hyperphosphatemia' });
    }
    if (eff.code === 'HGB' && eff.value < 10) {
      ctx.emit({ kind: 'record-agent-thought', note: `[md.rounding] HGB=${eff.value} on ${patientId} — CKD-anemia workup.` });
      ctx.emit({ kind: 'order-lab', patientId, code: 'IRON_STUDIES', priority: 'routine' });
    }
  },
});

behaviorRegistry.register({
  id: 'nurse.charge',
  description: 'Charge nurse escalates safety events, notifies MD on critical vitals, records observations.',
  matches: (s) => /charge|nurse|rn/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind !== 'ambient.vitals-drift') return;
    const p = evt.payload as { spo2?: number; hr?: number; trajectory?: string };
    const patientId = (evt.entityUrn ?? '').split(':').pop();
    if (!patientId) return;
    if ((p.spo2 ?? 100) < 90) {
      ctx.emit({ kind: 'record-agent-thought', note: `[nurse.charge] SpO2 ${p.spo2} on ${patientId} — escalate.` });
      ctx.emit({ kind: 'notify-staff', targetRole: 'md', priority: 'high', message: `SpO2 ${p.spo2} on ${patientId}`, patientRef: patientId });
      ctx.emit({ kind: 'flag-safety-event', patientId, safetyKind: 'hypoxia', severity: 'high' });
    }
    if ((p.hr ?? 0) > 120) {
      ctx.emit({ kind: 'record-agent-thought', note: `[nurse.charge] Tachycardia HR ${p.hr} on ${patientId}.` });
      ctx.emit({ kind: 'notify-staff', targetRole: 'md', priority: 'normal', message: `HR ${p.hr} on ${patientId}`, patientRef: patientId });
    }
  },
});

behaviorRegistry.register({
  id: 'pharmacist.review',
  description: 'Pharmacist audits new med orders for interaction/contraindication and holds when a recent K+ is elevated.',
  matches: (s) => /pharmac|med-review|medication-review/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind !== 'effect.applied') return;
    const payload = evt.payload as { effect?: { kind?: string; patientId?: string; code?: string } };
    if (payload.effect?.kind !== 'order-med') return;
    const eff = payload.effect as { kind: 'order-med'; patientId: string; code: string };
    if (!/lisinopril|enalapril|losartan|valsartan|spironolactone/i.test(eff.code)) return;
    // Look for a recent K result > 5.5 for this patient
    const recentK = ctx.realm.graph.listKind('result').find((r) => {
      const st = r.state as { code?: string; value?: number; orderId?: string };
      if (st.code !== 'K' || (st.value ?? 0) <= 5.5) return false;
      const order = ctx.realm.graph.get(ctx.realm.graph.urnFor('order', st.orderId ?? ''));
      return (order?.state as { patientId?: string })?.patientId === eff.patientId;
    });
    if (recentK) {
      ctx.emit({ kind: 'record-agent-thought', note: `[pharmacist.review] Recent K elevated \u2014 flag ${eff.code} order on ${eff.patientId}.` });
      // Find the just-created med order and hold it.
      const meds = ctx.realm.graph.listKind('medication').filter((m) => {
        const st = m.state as { patientId?: string; code?: string; status?: string };
        return st.patientId === eff.patientId && st.code === eff.code && st.status === 'active';
      });
      const last = meds[meds.length - 1];
      if (last) ctx.emit({ kind: 'hold-med', patientId: eff.patientId, medOrderId: last.id, reason: 'Pharmacist review \u2014 recent hyperkalemia' });
    }
  },
});

behaviorRegistry.register({
  id: 'coder.claims',
  description: 'Coder submits a claim when an encounter closes (patient discharged).',
  matches: (s) => /coder|claim|billing/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind !== 'effect.applied') return;
    const payload = evt.payload as { effect?: { kind?: string; patientId?: string; disposition?: string } };
    if (payload.effect?.kind !== 'discharge-patient') return;
    const eff = payload.effect as { kind: 'discharge-patient'; patientId: string; disposition: string };
    ctx.emit({ kind: 'record-agent-thought', note: `[coder.claims] Discharge \u2014 building claim for ${eff.patientId}.` });
    ctx.emit({ kind: 'submit-claim', encounterId: `${eff.patientId}-enc`, payerId: 'medicare-part-b', cptCodes: ['90999'], icd10Codes: ['N18.6'] });
  },
});

behaviorRegistry.register({
  id: 'outreach.ktv',
  description: 'Kt/V outreach agent orders monthly URR labs on ambient tick and follows up on underdialyzed results.',
  matches: (s) => /kt-?v|dialysis-adequacy|underdialysis/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind === 'effect.applied') {
      const payload = evt.payload as { effect?: { kind?: string; code?: string; value?: number; orderId?: string } };
      if (payload.effect?.kind === 'result-lab' && payload.effect.code === 'URR' && (payload.effect.value ?? 100) < 65) {
        const order = ctx.realm.graph.get(ctx.realm.graph.urnFor('order', payload.effect.orderId ?? ''));
        const patientId = (order?.state as { patientId?: string })?.patientId;
        if (patientId) {
          ctx.emit({ kind: 'record-agent-thought', note: `[outreach.ktv] URR ${payload.effect.value} on ${patientId} \u2014 schedule adequacy consult.` });
          ctx.emit({ kind: 'schedule-followup', patientId, when: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), resource: 'nephrologist', followupKind: 'adequacy-consult' });
        }
      }
    }
  },
});

behaviorRegistry.register({
  id: 'safety.monitor',
  description: 'Safety monitor watches for repeated abnormal labs on the same patient and files a safety event.',
  matches: (s) => /safety|adverse|risk-monitor/i.test(s.id),
  onPerceive: (evt, ctx) => {
    if (evt.kind !== 'effect.applied') return;
    const payload = evt.payload as { effect?: { kind?: string; abnormal?: string; orderId?: string } };
    if (payload.effect?.kind !== 'result-lab' || !payload.effect.abnormal) return;
    const order = ctx.realm.graph.get(ctx.realm.graph.urnFor('order', payload.effect.orderId ?? ''));
    const patientId = (order?.state as { patientId?: string })?.patientId;
    if (!patientId) return;
    // Count abnormal results for this patient in the ledger
    const abnormals = ctx.realm.ledger.listByKind('result-lab').filter((e) => {
      const inner = e.effect as { kind: 'result-lab'; abnormal?: string; orderId: string };
      if (!inner.abnormal) return false;
      const o = ctx.realm.graph.get(ctx.realm.graph.urnFor('order', inner.orderId));
      return (o?.state as { patientId?: string })?.patientId === patientId;
    });
    if (abnormals.length >= 2) {
      ctx.emit({ kind: 'flag-safety-event', patientId, safetyKind: 'repeated-abnormal-labs', severity: 'moderate' });
    }
  },
});
