/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// F7 — the dialysis session, and access, on the wire.
//
// Before this the EMR saw a renal patient who was never dialysed:
// `start-session`, `end-session` and `record-access` all fell through
// `effectResourceType()` to `[]`.
//
// D3: a SESSION is a `Procedure`; the EPISODE of care is ONE long-lived
// `Encounter` that many sessions attach to.

import { describe, expect, it } from 'vitest';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { serializeEntity } from '../src/fhir/mapping.js';
import { effectToFhirResource, effectResourceType } from '../src/fhir/effect-map.js';
import { ingestFhirBundle } from '../src/fhir/bundle-ingest.js';
import { codeRegistry } from '../src/fhir/code-registry.js';
import type { WorldEffect } from '../src/realm/types.js';
import type { Bundle, FhirCtx, FhirResource } from '../src/fhir/types.js';

function ctx(realmId: string, at = '2026-09-13T00:00:00.000Z'): FhirCtx {
  return { realmId, facilityId: 'f1', scopeId: realmId, sourceId: 'test', ingestedAt: at };
}

let realmSeq = 0;
function makeRealm() {
  const id = `realm:f7-${++realmSeq}`;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  realm.start();
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1 });
  const patientId = realm.graph.listKind('patient')[0]!.id;
  const md = realm.spawnPresence({
    agentSpecId: 'rounding-md', runId: `r-${realmSeq}`, role: 'md', clearance: 'restricted-phi',
    purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' },
  });
  const emit = (effect: WorldEffect) => realm.emit(md.presenceId, effect);
  return { realm, hg, patientId, presenceId: md.presenceId, emit, id };
}

/** One complete session: start → some telemetry → end. */
function runSession(h: ReturnType<typeof makeRealm>, sessionId: string, opts: { preWeightKg: number; postWeightKg: number; ufVolumeL: number }) {
  h.emit({ kind: 'start-session', patientId: h.patientId, sessionId, modality: 'hemodialysis', prescribedMinutes: 240, targetUfL: opts.ufVolumeL });
  h.emit({ kind: 'record-session-telemetry', patientId: h.patientId, minute: 60, bp: '128/78', hr: 82, qb: 350 });
  h.emit({ kind: 'record-session-telemetry', patientId: h.patientId, minute: 180, bp: '104/62', hr: 88, qb: 340 });
  h.emit({
    kind: 'end-session', patientId: h.patientId, deliveredMinutes: 238, ufVolumeL: opts.ufVolumeL,
    qbAvg: 345, recirculationPct: 8, preWeightKg: opts.preWeightKg, postWeightKg: opts.postWeightKg,
  });
}

const resourceIds = (rs: FhirResource[]) => rs.map((r) => r.id).filter((id): id is string => typeof id === 'string');

describe('F7 · the session is a Procedure inside a standing episode Encounter', () => {
  it('start-session creates the session entity and ONE episode; end-session closes the same Procedure', () => {
    const h = makeRealm();
    const sessionId = 'sess-1';
    runSession(h, sessionId, { preWeightKg: 72.4, postWeightKg: 70.1, ufVolumeL: 2.3 });

    const sessions = h.realm.graph.listKind('dialysis-session');
    const episodes = h.realm.graph.listKind('dialysis-episode');
    expect(sessions).toHaveLength(1);
    expect(episodes).toHaveLength(1);
    // The entity id IS the sessionId we passed — this is what makes start/end
    // close one resource rather than two.
    expect(sessions[0]!.id).toBe(sessionId);

    const [procedure, ...metrics] = serializeEntity(sessions[0]!, ctx(h.id));
    const p = procedure as { resourceType: string; id: string; status: string; encounter?: { reference: string }; performedPeriod?: { start?: string; end?: string }; code?: { coding?: Array<{ code: string }> } };
    expect(p.resourceType).toBe('Procedure');
    expect(p.id).toBe(sessionId);
    expect(p.status).toBe('completed');
    // D3 — the session attaches to the episode Encounter.
    expect(p.encounter?.reference).toBe(`Encounter/${episodes[0]!.id}`);
    expect(p.performedPeriod?.start).toBeDefined();
    expect(p.performedPeriod?.end).toBeDefined();
    // The treatment is a real SNOMED procedure, not a slug.
    expect(p.code?.coding?.[0]?.code).toBe('302497006');

    // Delivered metrics reference the Procedure.
    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics) {
      const o = m as { partOf?: Array<{ reference: string }>; partOfMissing?: never };
      if (o.partOf) expect(o.partOf[0]?.reference).toBe(`Procedure/${sessionId}`);
    }
    const metricCodes = metrics.map((m) => (m as { code: { coding: Array<{ code: string }> } }).code.coding[0]?.code);
    expect(metricCodes).toContain('99741-1'); // ultrafiltrate volume removed
  });

  it('the dry weight is its own entity, using the dry-body-weight code', () => {
    const h = makeRealm();
    runSession(h, 'sess-dw', { preWeightKg: 72.4, postWeightKg: 70.1, ufVolumeL: 2.3 });
    const weights = h.realm.graph.listKind('dry-weight');
    expect(weights).toHaveLength(1);
    expect(weights[0]!.id).toBe('sess-dw-dry-weight');
    const resources = serializeEntity(weights[0]!, ctx(h.id));
    const obs = resources[0] as { code: { coding: Array<{ code: string; display?: string }> }; valueQuantity: { value: number; unit: string } };
    expect(obs.code.coding[0]?.code).toBe('8341-0'); // Dry body weight Measured — not plain body weight
    expect(obs.valueQuantity).toEqual({ value: 70.1, unit: 'kg' });
  });

  it('serializing the same session twice does not produce two procedures', () => {
    const h = makeRealm();
    runSession(h, 'sess-dup', { preWeightKg: 80, postWeightKg: 77.5, ufVolumeL: 2.5 });
    const rec = h.realm.graph.listKind('dialysis-session')[0]!;
    const first = serializeEntity(rec, ctx(h.id));
    const second = serializeEntity(rec, ctx(h.id));
    expect(resourceIds(first)).toEqual(resourceIds(second));
    expect(first.filter((r) => r.resourceType === 'Procedure')).toHaveLength(1);
  });

  it('reconcile, do not duplicate — N sessions yield exactly ONE episode', () => {
    const h = makeRealm();
    for (let i = 1; i <= 5; i += 1) {
      runSession(h, `sess-${i}`, { preWeightKg: 72 - i * 0.1, postWeightKg: 70 - i * 0.1, ufVolumeL: 2.2 });
    }
    expect(h.realm.graph.listKind('dialysis-session')).toHaveLength(5);
    expect(h.realm.graph.listKind('dialysis-episode')).toHaveLength(1);
    const episode = h.realm.graph.listKind('dialysis-episode')[0]!;
    expect((episode.state as { sessionCount?: number }).sessionCount).toBe(5);

    // ...and every session attaches to that one Encounter.
    const [encounter] = serializeEntity(episode, ctx(h.id));
    const e = encounter as { resourceType: string; type?: Array<{ coding?: Array<{ code: string }> }>; status: string };
    expect(e.resourceType).toBe('Encounter');
    expect(e.status).toBe('in-progress');
    expect(e.type?.[0]?.coding?.[0]?.code).toBe('265764009'); // renal dialysis
    for (const s of h.realm.graph.listKind('dialysis-session')) {
      const [p] = serializeEntity(s, ctx(h.id));
      expect((p as { encounter?: { reference: string } }).encounter?.reference).toBe(`Encounter/${episode.id}`);
    }
  });

  it('a second modality opens a second episode (one per patient × facility × modality)', () => {
    const h = makeRealm();
    runSession(h, 'sess-hd', { preWeightKg: 72, postWeightKg: 70, ufVolumeL: 2 });
    h.emit({ kind: 'start-session', patientId: h.patientId, sessionId: 'sess-hdf', modality: 'hemodiafiltration', prescribedMinutes: 240, targetUfL: 2 });
    h.emit({ kind: 'end-session', patientId: h.patientId, deliveredMinutes: 240, ufVolumeL: 2, postWeightKg: 69.8 });
    expect(h.realm.graph.listKind('dialysis-episode')).toHaveLength(2);
    expect(h.realm.graph.listKind('dialysis-session')).toHaveLength(2);
  });

  it('dry weight carries IDWG once there is a previous session to compare with', () => {
    const h = makeRealm();
    runSession(h, 'sess-w1', { preWeightKg: 72, postWeightKg: 70, ufVolumeL: 2 });
    runSession(h, 'sess-w2', { preWeightKg: 73.4, postWeightKg: 70.2, ufVolumeL: 3.2 });
    const weights = h.realm.graph.listKind('dry-weight');
    expect(weights).toHaveLength(2);
    const second = weights.find((w) => w.id === 'sess-w2-dry-weight')!;
    const st = second.state as { weightKg: number; idwgKg?: number };
    expect(st.weightKg).toBe(70.2);
    // pre 73.4 − previous post 70.0 = 3.4
    expect(st.idwgKg).toBeCloseTo(3.4, 1);
  });
});

describe('F7 · vascular access on the wire', () => {
  it('an access measurement is an Observation with coded components', () => {
    const h = makeRealm();
    h.emit({ kind: 'record-access', patientId: h.patientId, event: 'surveillance', accessFlowMlMin: 780, recirculationPct: 6, venousPressureMmHg: 145 });
    const resources = effectToFhirResource(
      { kind: 'record-access', patientId: h.patientId, event: 'surveillance', accessFlowMlMin: 780, recirculationPct: 6, venousPressureMmHg: 145 },
      { ctx: ctx(h.id) },
    );
    expect(resources).toHaveLength(1);
    const obs = resources[0] as { resourceType: string; category: Array<{ coding: Array<{ code: string }> }>; component: Array<{ code: { coding: Array<{ code: string }> }; valueQuantity: { value: number } }> };
    expect(obs.resourceType).toBe('Observation');
    expect(obs.category[0]?.coding[0]?.code).toBe('hemodynamic');
    const codes = obs.component.map((c) => c.code.coding[0]?.code);
    expect(codes).toContain('252076005'); // venous pressure (SNOMED)
    expect(obs.component.map((c) => c.valueQuantity.value)).toContain(780);
  });

  it('a thrombosis is an AdverseEvent, an angioplasty is a Procedure', () => {
    const h = makeRealm();
    const thrombosis = effectToFhirResource({ kind: 'record-access', patientId: h.patientId, event: 'thrombosis', note: 'no intervention on a progressive stenosis' }, { ctx: ctx(h.id) });
    expect(thrombosis[0]!.resourceType).toBe('AdverseEvent');
    expect((thrombosis[0] as { actuality: string }).actuality).toBe('actual');

    const angio = effectToFhirResource({ kind: 'record-access', patientId: h.patientId, event: 'angioplasty' }, { ctx: ctx(h.id) });
    expect(angio[0]!.resourceType).toBe('Procedure');
  });

  it('creates a vascular-access Device once an access-creating event names the type', () => {
    const h = makeRealm();
    h.emit({ kind: 'record-access', patientId: h.patientId, event: 'avf-created', note: 'left brachiocephalic' });
    const access = h.realm.graph.listKind('vascular-access');
    expect(access).toHaveLength(1);
    expect((access[0]!.state as { accessType: string }).accessType).toBe('avf');

    const resources = serializeEntity(access[0]!, ctx(h.id));
    expect(resources.map((r) => r.resourceType)).toEqual(['Device', 'DeviceUseStatement']);
    const device = resources[0] as { id: string; type?: { coding?: Array<{ system: string }> } };
    expect(device.id).toBe(access[0]!.id);
    // `avf` has no verified concept, so it is a declared LOCAL code — never a
    // guessed SNOMED id.
    expect(device.type?.coding?.[0]?.system).toBe('urn:ananthealth:codesystem:access-type');
  });

  it('thrombosis retires the access', () => {
    const h = makeRealm();
    h.emit({ kind: 'record-access', patientId: h.patientId, event: 'avf-created' });
    h.emit({ kind: 'record-access', patientId: h.patientId, event: 'thrombosis', note: 'clotted' });
    const access = h.realm.graph.listKind('vascular-access')[0]!;
    expect((access.state as { status: string }).status).toBe('failed');
    const [device] = serializeEntity(access, ctx(h.id));
    expect((device as { status: string }).status).toBe('inactive');
  });
});

describe('F7 · no renal effect falls through to an empty projection', () => {
  it('effectResourceType names a resource for every session/access effect', () => {
    const h = makeRealm();
    const renal: WorldEffect[] = [
      { kind: 'start-session', patientId: h.patientId, modality: 'hemodialysis', prescribedMinutes: 240, targetUfL: 2 },
      { kind: 'end-session', patientId: h.patientId, deliveredMinutes: 240, ufVolumeL: 2 },
      { kind: 'record-access', patientId: h.patientId, event: 'surveillance', accessFlowMlMin: 780 },
      { kind: 'record-access', patientId: h.patientId, event: 'thrombosis' },
    ];
    for (const effect of renal) {
      expect(effectResourceType(effect), effect.kind).not.toEqual([]);
      expect(effectToFhirResource(effect, { ctx: ctx(h.id) }).length, effect.kind).toBeGreaterThan(0);
    }
  });

  it('a surveillance event carrying NO measurements projects nothing (rather than an empty Observation)', () => {
    const h = makeRealm();
    // effectResourceType states the CAPABILITY; a data-less event has nothing to
    // say, and an empty Observation is worse than none — it asserts a measurement
    // that was never taken.
    expect(effectResourceType({ kind: 'record-access', patientId: h.patientId, event: 'surveillance' })).toEqual(['Observation', 'Procedure', 'AdverseEvent']);
    expect(effectToFhirResource({ kind: 'record-access', patientId: h.patientId, event: 'surveillance' }, { ctx: ctx(h.id) })).toEqual([]);
  });

  it('the session codes resolve through the registry (F4), not as slugs', () => {
    codeRegistry.resetUsage();
    const h = makeRealm();
    h.emit({ kind: 'start-session', patientId: h.patientId, sessionId: 'sess-codes', modality: 'hemodialysis', prescribedMinutes: 240, targetUfL: 2 });
    h.emit({ kind: 'end-session', patientId: h.patientId, deliveredMinutes: 240, ufVolumeL: 2.4, qbAvg: 350, recirculationPct: 7, postWeightKg: 70.5 });
    const rec = h.realm.graph.listKind('dialysis-session')[0]!;
    serializeEntity(rec, ctx(h.id));
    serializeEntity(h.realm.graph.listKind('dry-weight')[0]!, ctx(h.id));
    const used = codeRegistry.usageReport().map((u) => `${u.domain}:${u.slug}`);
    expect(used).toContain('procedure:hemodialysis');
    expect(used).toContain('procedure-category:dialysis');
    expect(used).toContain('session-metric:uf-volume');
    expect(used).toContain('body-weight:dry-weight');
    for (const u of codeRegistry.usageReport()) {
      const entry = codeRegistry.lookup(u.domain, u.slug)!;
      expect(entry, `${u.domain}:${u.slug}`).toBeTruthy();
      expect(entry.version, `${u.domain}:${u.slug}`).toBeTruthy();
      expect(entry.display, `${u.domain}:${u.slug}`).toBeTruthy();
    }
  });
});

describe('F7 · volume is measured, not assumed', () => {
  it('one session serializes within a documented payload budget', () => {
    const h = makeRealm();
    runSession(h, 'sess-size', { preWeightKg: 72.4, postWeightKg: 70.1, ufVolumeL: 2.3 });
    const rec = h.realm.graph.listKind('dialysis-session')[0]!;
    const resources = serializeEntity(rec, ctx(h.id));

    // The session goes on the wire as ONE transaction bundle (atomicity is
    // inherited from ingestFhirBundle, proven in tests/fhir-bundle.test.ts).
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: resources.map((r) => ({ resource: r, request: { method: 'POST', url: r.resourceType } })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');

    // Two DIFFERENT budgets live here, so keep them apart. The session SUMMARY
    // (Procedure + delivered metrics) is a fixed handful of resources. Telemetry
    // is proportional to the sampling cadence and is F8's budget to own —
    // tests/fhir-telemetry.test.ts measures 436 resources / 376 KiB for a
    // 48-point session, which is why a session is shipped as a transaction
    // bundle rather than resource-by-resource.
    const telemetryResources = resources.filter((r) => /-t\d+-/.test(String(r.id)));
    const summary = resources.filter((r) => !/-t\d+-/.test(String(r.id)));

    // runSession samples TWO points, each carrying bp + hr + qb.
    expect(telemetryResources).toHaveLength(6);
    expect(summary.length).toBeLessThanOrEqual(8);
    expect(bytes).toBeLessThan(16 * 1024);
    // Recorded so a reviewer can see the number rather than infer it.
    console.log(
      `[F7] one dialysis session → ${summary.length} summary resources + ` +
      `${telemetryResources.length} telemetry; ${bytes} bytes (transaction bundle)`,
    );
  });

  it('the session bundle ingests atomically', async () => {
    const h = makeRealm();
    runSession(h, 'sess-tx', { preWeightKg: 72, postWeightKg: 70, ufVolumeL: 2 });
    const rec = h.realm.graph.listKind('dialysis-session')[0]!;
    const resources = serializeEntity(rec, ctx(h.id));
    const bundle = {
      resourceType: 'Bundle', type: 'transaction',
      entry: resources.map((r) => ({ resource: r, request: { method: 'POST', url: r.resourceType } })),
    };
    // ingestFhirBundle is async and treats a `transaction` as one atomic unit
    // (rollback on any entry failure, proven in tests/fhir-bundle.test.ts).
    const result = await ingestFhirBundle(h.realm, ctx(h.id), bundle as never, {});
    expect(result.mode).toBe('transaction');
    expect(result.rolledBack).toBe(false);
    expect(result.entries.length).toBe(resources.length);
  });
});

/* ---------------------------------------------------- F3 · inbound continuity */

describe('F3 · an inbound EMR Encounter is adopted, not duplicated', () => {
  /**
   * The gap this closes. F7 made us SERIALIZE the episode as one standing
   * Encounter, but nothing made an inbound Encounter ATTACH to it: the ingest
   * read only `status`/`subject` and threw the EMR's resource id away, so a
   * session started after the admission opened a SECOND episode of care and the
   * chart ended up holding two.
   */
  it('attaches the session to the EMR’s episode instead of opening a parallel one', async () => {
    const h = makeRealm();

    const bundle: Bundle = {
      resourceType: 'Bundle', type: 'transaction',
      entry: [
        { resource: { resourceType: 'Encounter', id: 'emr-enc-1', status: 'in-progress', subject: { reference: `Patient/${h.patientId}` } } },
      ],
    };
    const result = await ingestFhirBundle(h.realm, ctx(h.id), bundle, {});
    expect(result.rolledBack).toBe(false);

    runSession(h, 'sess-after-admit', { preWeightKg: 72.4, postWeightKg: 70.1, ufVolumeL: 2.3 });

    const episodes = h.realm.graph.listKind('dialysis-episode');
    // ONE episode, carrying the id the EMR already holds — so the Encounter we
    // serialize UPDATES the chart's episode rather than adding a second.
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.id).toBe('emr-enc-1');

    const session = h.realm.graph.listKind('dialysis-session')[0]!;
    const [procedure] = serializeEntity(session, ctx(h.id));
    expect((procedure as { encounter?: { reference: string } }).encounter?.reference).toBe('Encounter/emr-enc-1');
  });

  /**
   * The sharper half of the same defect, and why a derived key alone was not
   * enough. `admit-patient` writes the INGEST context's facility onto the
   * patient, and the episode key was derived from `patient.facilityId` — so an
   * admission from a facility other than the seeded one re-keyed the patient and
   * forked a second episode on the next session.
   */
  it('does not fork the episode when an inbound admission re-keys the facility', async () => {
    const h = makeRealm();
    runSession(h, 'sess-before', { preWeightKg: 72, postWeightKg: 70, ufVolumeL: 2 });
    expect(h.realm.graph.listKind('dialysis-episode')).toHaveLength(1);

    const bundle: Bundle = {
      resourceType: 'Bundle', type: 'transaction',
      entry: [
        { resource: { resourceType: 'Encounter', id: 'emr-enc-2', status: 'in-progress', subject: { reference: `Patient/${h.patientId}` } } },
      ],
    };
    // An admission arriving from the EMR's own facility id, not our 'f1'.
    await ingestFhirBundle(h.realm, { ...ctx(h.id), facilityId: 'EMR-FAC' }, bundle, {});
    // The admission DID move the patient — that part is intended.
    expect((h.realm.graph.listKind('patient')[0]!.state as { facilityId?: string }).facilityId).toBe('EMR-FAC');

    runSession(h, 'sess-after', { preWeightKg: 73, postWeightKg: 70.5, ufVolumeL: 2.5 });

    // Still ONE episode: the second session attached to the one we already
    // opened rather than deriving a key from the facility that just changed.
    const episodes = h.realm.graph.listKind('dialysis-episode');
    expect(episodes).toHaveLength(1);
    expect(h.realm.graph.listKind('dialysis-session')).toHaveLength(2);
    // ...and the EMR's own episode id is recorded on it, not discarded.
    expect((episodes[0]!.state as { emrEpisodeId?: string }).emrEpisodeId).toBe('emr-enc-2');
  });
});
