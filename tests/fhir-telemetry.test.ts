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

// F8 — intra-session telemetry, and the session as one atomic Bundle.
//
// The bug this file exists to prevent: telemetry was capped at 24 points with
// `.slice(-24)`, which silently discarded half of a 4-hour session at 5-minute
// cadence and nearly all of one at 1-minute. Nothing counted the loss, so the
// EMR saw a session that looked complete.
//
// The second thing it pins down: a machine channel is NOT a vital sign. A
// dialysate flow rate filed as a patient observation is wrong in a way an EMR
// will not correct for us.

import { describe, expect, it } from 'vitest';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { serializeEntity } from '../src/fhir/mapping.js';
import { effectToFhirResource, effectResourceType } from '../src/fhir/effect-map.js';
import {
  TELEMETRY_BATCH_SIZE,
  batchSessionBundle,
  bundleAtomicityNote,
  bundleStats,
  sessionTransactionBundle,
} from '../src/fhir/session-bundle.js';
import { MAX_SESSION_TELEMETRY_POINTS } from '../src/realm/effect-reducer.js';
import type { WorldEffect } from '../src/realm/types.js';
import type { FhirCtx, FhirResource } from '../src/fhir/types.js';

function ctx(realmId: string, at = '2026-09-13T00:00:00.000Z'): FhirCtx {
  return { realmId, facilityId: 'f1', scopeId: realmId, sourceId: 'test', ingestedAt: at };
}

let realmSeq = 0;
function makeRealm() {
  const id = `realm:f8-${++realmSeq}`;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  realm.start();
  populateFacility(realm, {
    facilityId: 'f1', kind: 'dialysis', name: 'Anant Dialysis', units: ['U1'], patientCount: 1,
  });
  const patientId = realm.graph.listKind('patient')[0]!.id;
  const md = realm.spawnPresence({
    agentSpecId: 'rounding-md', runId: `r-${realmSeq}`, role: 'md', clearance: 'restricted-phi',
    purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' },
  });
  const emit = (effect: WorldEffect) => realm.emit(md.presenceId, effect);
  return { realm, hg, patientId, presenceId: md.presenceId, emit, id };
}

/** A full channel set, so one point fans out to every kind of Observation. */
const FULL_CHANNELS = {
  bp: '128/78', hr: 82, tempC: 36.5,
  qb: 350, qd: 500, venousPressure: 140, arterialPressure: -120,
  ufRateMlH: 650, ufVolumeL: 1.2,
} as const;

/** Channels emitted per point: hr, temp, qb, qd, venous, arterial, uf-rate, uf-vol, bp. */
const OBS_PER_POINT = 9;

/**
 * What a session costs in resources, MEASURED not assumed: one `Procedure` plus
 * three delivered-metric `Observation`s, plus `OBS_PER_POINT` per telemetry
 * point (436 for a 48-point session, 6484 at the 720-point cap).
 */
const SESSION_RESOURCES = (points: number): number => 4 + points * OBS_PER_POINT;

function runTelemetrySession(
  h: ReturnType<typeof makeRealm>, sessionId: string, points: number,
  channels: Record<string, unknown> = FULL_CHANNELS,
) {
  h.emit({
    kind: 'start-session', patientId: h.patientId, sessionId,
    modality: 'hemodialysis', prescribedMinutes: 240, targetUfL: 2.5,
  });
  for (let i = 0; i < points; i++) {
    h.emit({
      kind: 'record-session-telemetry', patientId: h.patientId, minute: 5 * (i + 1),
      ...channels,
    } as WorldEffect);
  }
  h.emit({
    kind: 'end-session', patientId: h.patientId, deliveredMinutes: 238, ufVolumeL: 2.5,
    qbAvg: 345, recirculationPct: 8, preWeightKg: 72.4, postWeightKg: 70.1,
  });
  return h.realm.graph.listKind('dialysis-session')[0]!;
}

const telemetryOf = (session: { state: unknown }): Array<Record<string, unknown>> =>
  ((session.state as { telemetry?: Array<Record<string, unknown>> }).telemetry ?? []);

const telemetryResources = (resources: FhirResource[], sessionId: string): FhirResource[] =>
  resources.filter((r) => typeof r.id === 'string' && new RegExp(`^${sessionId}-t\\d+-`).test(r.id));

const codeOf = (r: FhirResource): string | undefined =>
  (r as { code?: { coding?: Array<{ code?: string }> } }).code?.coding?.[0]?.code;

const categoryOf = (r: FhirResource): string | undefined =>
  (r as { category?: Array<{ coding?: Array<{ code?: string }> }> }).category?.[0]?.coding?.[0]?.code;

describe('F8 · the telemetry cap counts what it drops', () => {
  it('keeps all 48 points of a 5-minute-cadence session (the old cap of 24 silently halved it)', () => {
    const h = makeRealm();
    const sessionId = 'sess-48';
    const session = runTelemetrySession(h, sessionId, 48);

    // The ledger itself must hold every point — this is the no-truncation claim.
    expect(telemetryOf(session)).toHaveLength(48);
    expect((session.state as { telemetryDropped?: number }).telemetryDropped).toBeUndefined();

    const resources = serializeEntity(session, ctx(h.id));
    expect(telemetryResources(resources, sessionId)).toHaveLength(48 * OBS_PER_POINT);
  });

  it('records telemetryDropped once the safety valve bites at the cap', () => {
    const h = makeRealm();
    const sessionId = 'sess-over';
    const over = 5;
    const session = runTelemetrySession(h, sessionId, MAX_SESSION_TELEMETRY_POINTS + over);

    expect(telemetryOf(session)).toHaveLength(MAX_SESSION_TELEMETRY_POINTS);
    // The loss is VISIBLE. Before F8 it simply vanished.
    expect((session.state as { telemetryDropped?: number }).telemetryDropped).toBe(over);

    const resources = serializeEntity(session, ctx(h.id));
    expect(telemetryResources(resources, sessionId)).toHaveLength(MAX_SESSION_TELEMETRY_POINTS * OBS_PER_POINT);
  });
});

describe('F8 · a machine channel is not a vital sign', () => {
  it('files vitals as vital-signs and machine channels as hemodynamic', () => {
    const h = makeRealm();
    const sessionId = 'sess-cat';
    const session = runTelemetrySession(h, sessionId, 1);
    const resources = telemetryResources(serializeEntity(session, ctx(h.id)), sessionId);

    const bySuffix = new Map(resources.map((r) => [String(r.id).replace(`${sessionId}-t0-`, ''), r]));
    expect(bySuffix.size).toBe(OBS_PER_POINT);

    // Patient measurements.
    for (const slug of ['hr', 'temp', 'bp']) {
      expect(categoryOf(bySuffix.get(slug)!)).toBe('vital-signs');
    }
    // Machine settings and readings. A dialysate flow rate is not a patient vital.
    for (const slug of ['qb', 'qd', 'venous-pressure', 'arterial-pressure', 'uf-rate', 'uf-volume']) {
      expect(categoryOf(bySuffix.get(slug)!)).toBe('hemodynamic');
    }

    // Real codes, not slugs, for the three we could verify against an authority.
    expect(codeOf(bySuffix.get('qd')!)).toBe('99712-2'); // LOINC dialysate flow rate
    expect(codeOf(bySuffix.get('venous-pressure')!)).toBe('252076005'); // SNOMED
    expect(codeOf(bySuffix.get('uf-volume')!)).toBe('99741-1'); // LOINC ultrafiltrate volume
    expect(codeOf(bySuffix.get('hr')!)).toBe('8867-4');
  });

  it('emits blood pressure as one panel with systolic/diastolic components', () => {
    const h = makeRealm();
    const sessionId = 'sess-bp';
    const session = runTelemetrySession(h, sessionId, 1);
    const bp = telemetryResources(serializeEntity(session, ctx(h.id)), sessionId)
      .find((r) => r.id === `${sessionId}-t0-bp`)!;

    expect(codeOf(bp)).toBe('55284-4');
    const components = (bp as { component?: Array<{ code: { coding: Array<{ code: string }> }; valueQuantity?: { value?: number } }> }).component;
    expect(components).toHaveLength(2);
    expect(components![0]!.code.coding[0]!.code).toBe('8480-6'); // systolic
    expect(components![0]!.valueQuantity?.value).toBe(128);
    expect(components![1]!.code.coding[0]!.code).toBe('8462-4'); // diastolic
    expect(components![1]!.valueQuantity?.value).toBe(78);
  });

  it('timestamps and links every reading to the session Procedure and the episode Encounter', () => {
    const h = makeRealm();
    const sessionId = 'sess-links';
    const session = runTelemetrySession(h, sessionId, 3);
    const resources = serializeEntity(session, ctx(h.id));
    const [procedure] = resources;
    const episodeId = (procedure as { encounter?: { reference?: string } }).encounter?.reference;
    expect(episodeId).toBeDefined();

    const telemetry = telemetryResources(resources, sessionId);
    expect(telemetry).toHaveLength(3 * OBS_PER_POINT);
    let previous = 0;
    for (const o of telemetry) {
      const obs = o as {
        effectiveDateTime?: string;
        partOf?: Array<{ reference?: string }>;
        encounter?: { reference?: string };
        subject?: { reference?: string };
      };
      const at = Date.parse(obs.effectiveDateTime!);
      expect(Number.isNaN(at)).toBe(false);
      // Order is preserved, so a chart plotted from this is chronological.
      expect(at).toBeGreaterThanOrEqual(previous);
      previous = at;
      // Every reading hangs off the Procedure it came from — that is what makes
      // it attributable rather than a loose series.
      expect(obs.partOf?.[0]?.reference).toBe(`Procedure/${sessionId}`);
      expect(obs.encounter?.reference).toBe(episodeId);
      expect(obs.subject?.reference).toBe(`Patient/${h.patientId}`);
    }
  });

  it('falls back to start + minute offset when a point carries no absolute timestamp', () => {
    const h = makeRealm();
    const sessionId = 'sess-derive';
    const session = runTelemetrySession(h, sessionId, 2);

    // Replay/EMR shape: absolute `at` absent, only the minute offset.
    const stripped = {
      ...session,
      state: {
        ...(session.state as Record<string, unknown>),
        telemetry: telemetryOf(session).map(({ at: _drop, ...rest }) => rest),
      },
    };
    const resources = telemetryResources(serializeEntity(stripped, ctx(h.id)), sessionId);
    const startedAt = Date.parse((session.state as { startedAt: string }).startedAt);

    expect(resources).toHaveLength(2 * OBS_PER_POINT);
    const hr0 = resources.find((r) => r.id === `${sessionId}-t0-hr`)!;
    const hr1 = resources.find((r) => r.id === `${sessionId}-t1-hr`)!;
    expect(Date.parse((hr0 as { effectiveDateTime: string }).effectiveDateTime)).toBe(startedAt + 5 * 60_000);
    expect(Date.parse((hr1 as { effectiveDateTime: string }).effectiveDateTime)).toBe(startedAt + 10 * 60_000);
  });

  it('does not invent a reading for a channel that was not sampled', () => {
    const h = makeRealm();
    const sessionId = 'sess-sparse';
    const session = runTelemetrySession(h, sessionId, 2, { hr: 80 });
    const resources = telemetryResources(serializeEntity(session, ctx(h.id)), sessionId);
    expect(resources).toHaveLength(2);
    expect(resources.every((r) => String(r.id).endsWith('-hr'))).toBe(true);
  });
});

describe('F8 · the whole session goes on the wire atomically', () => {
  it('emits one transaction Bundle for a 48-point session, and reports its real size', () => {
    const h = makeRealm();
    const sessionId = 'sess-bundle';
    const session = runTelemetrySession(h, sessionId, 48);
    const resources = serializeEntity(session, ctx(h.id));

    const bundles = batchSessionBundle(resources, { bundleId: sessionId });
    expect(bundles).toHaveLength(1);
    expect(resources.length).toBe(SESSION_RESOURCES(48));

    const [bundle] = bundles;
    expect(bundle!.type).toBe('transaction');
    expect(bundle!.entry).toHaveLength(resources.length);
    // Derived ids + PUT: replaying the same session overwrites, never duplicates.
    for (const entry of bundle!.entry!) {
      expect(entry.request?.method).toBe('PUT');
      expect(entry.request?.url).toBe(`${entry.resource!.resourceType}/${entry.resource!.id}`);
    }

    const stats = bundleStats(bundles);
    expect(stats.atomic).toBe(true);
    expect(stats.resources).toBe(resources.length);
    // Measured, not estimated. This is the number that decides whether a session
    // can be one request or has to be split.
    expect(stats.bytes).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `F8 · 48-point session → ${stats.resources} resources, ` +
      `${stats.bytes} bytes (${Math.round(stats.bytes / 1024)} KiB) as ONE atomic transaction`,
    );
  });

  it('splits a max-cadence session by default and says so instead of pretending it is atomic', () => {
    const h = makeRealm();
    const sessionId = 'sess-cadence';
    // 4 hours at 20-second cadence — the worst case the cap is sized for.
    const session = runTelemetrySession(h, sessionId, MAX_SESSION_TELEMETRY_POINTS);
    const resources = serializeEntity(session, ctx(h.id));
    expect(resources.length).toBeGreaterThan(TELEMETRY_BATCH_SIZE);

    const bundles = batchSessionBundle(resources, { bundleId: sessionId });
    expect(bundles.length).toBeGreaterThan(1);
    expect(bundles.reduce((n, b) => n + b.entry!.length, 0)).toBe(resources.length);
    const stats = bundleStats(bundles);
    expect(stats.atomic).toBe(false);
    expect(bundleAtomicityNote(bundles)).toMatch(/atomicity is PER BATCH/);
    // eslint-disable-next-line no-console
    console.log(
      `F8 · ${MAX_SESSION_TELEMETRY_POINTS}-point (20s cadence) session → ${stats.resources} resources, ` +
      `${stats.bytes} bytes (${Math.round(stats.bytes / 1024)} KiB) as ${stats.count} transactions`,
    );
  });

  it('an explicit batchSize splits a canonical session and loses no resource', () => {
    const h = makeRealm();
    const sessionId = 'sess-split';
    const session = runTelemetrySession(h, sessionId, 48);
    const resources = serializeEntity(session, ctx(h.id));

    const bundles = batchSessionBundle(resources, { bundleId: sessionId, batchSize: 100 });
    expect(bundles.length).toBeGreaterThan(1);
    // Every resource is present exactly once across the batches — a split must
    // not lose the tail.
    expect(bundles.reduce((n, b) => n + b.entry!.length, 0)).toBe(resources.length);
    const stats = bundleStats(bundles);
    expect(stats.atomic).toBe(false);
    expect(bundleAtomicityNote(bundles)).toMatch(/atomicity is PER BATCH/);
  });

  it('bounds a batch at TELEMETRY_BATCH_SIZE by default', () => {
    const h = makeRealm();
    const sessionId = 'sess-default-batch';
    const session = runTelemetrySession(h, sessionId, 48);
    const resources = serializeEntity(session, ctx(h.id));
    const many = [...resources, ...resources.map((r) => ({ ...r, id: `${r.id}-dup` }))];

    const bundles = batchSessionBundle(many, { bundleId: sessionId });
    expect(bundles.length).toBe(Math.ceil(many.length / TELEMETRY_BATCH_SIZE));
    for (const b of bundles) expect(b.entry!.length).toBeLessThanOrEqual(TELEMETRY_BATCH_SIZE);
  });

  it('produces the same bundle id set regardless of content (deterministic)', () => {
    const h = makeRealm();
    const sessionId = 'sess-det';
    const session = runTelemetrySession(h, sessionId, 2);
    const resources = serializeEntity(session, ctx(h.id));
    const opts = { bundleId: sessionId, timestamp: '2026-09-13T00:00:00.000Z' };
    expect(JSON.stringify(sessionTransactionBundle(resources, opts)))
      .toBe(JSON.stringify(sessionTransactionBundle(resources, opts)));
  });
});

describe('F8 · a derived acoustic feature vector is not a measurement', () => {
  it('projects a labelled synthetic capture with provenance extensions, and never the audio', () => {
    const h = makeRealm();
    const effect: WorldEffect = {
      kind: 'record-access-acoustic', patientId: h.patientId, captureId: 'cap-1',
      features: [0.1, 0.2, 0.3], baseline: true, provenance: 'simulator:thrill-synth',
      synthetic: true, featureKind: 'mel-band-energies',
    };
    const [obs] = effectToFhirResource(effect, { ctx: ctx(h.id), patientRef: `Patient/${h.patientId}` });
    expect(obs!.resourceType).toBe('Observation');
    const ext = (obs as { extension?: Array<{ url: string; valueBoolean?: boolean; valueString?: string }> }).extension ?? [];
    expect(ext.find((e) => e.url.endsWith('/synthetic-capture'))?.valueBoolean).toBe(true);
    expect(ext.find((e) => e.url.endsWith('/capture-provenance'))?.valueString).toBe('simulator:thrill-synth');
    expect(JSON.stringify(obs)).not.toContain('0.1');
  });

  it('refuses to write an unlabelled capture on the write path', () => {
    const h = makeRealm();
    // Untrusted input: the type says `synthetic: true`, but JSON from a client
    // does not have to agree. The runtime check is what actually holds.
    const unlabelled = {
      kind: 'record-access-acoustic', patientId: h.patientId, captureId: 'cap-2',
      features: [0.1], baseline: false, provenance: 'unknown', synthetic: undefined,
    } as unknown as WorldEffect;
    expect(() => effectToFhirResource(unlabelled, { ctx: ctx(h.id) }))
      .toThrow(/synthetic flag is not set/);
  });

  it('refuses to write an unlabelled capture in the reducer too', () => {
    const h = makeRealm();
    const unlabelled = {
      kind: 'record-access-acoustic', patientId: h.patientId, captureId: 'cap-3',
      features: [0.1], baseline: false, provenance: 'unknown', synthetic: undefined,
    } as unknown as WorldEffect;
    expect(() => h.emit(unlabelled)).toThrow(/synthetic/);
  });

  it('declares the wire capability for both new effects', () => {
    expect(effectResourceType({
      kind: 'record-session-telemetry', patientId: 'p1', minute: 5, hr: 80,
    })).toEqual(['Observation']);
    expect(effectResourceType({
      kind: 'record-access-acoustic', patientId: 'p1', captureId: 'c', features: [0.1],
      baseline: true, provenance: 'sim', synthetic: true,
    })).toEqual(['Observation']);
  });
});

describe('F8 · an unsampled session is representable', () => {
  it('serializes a session with no telemetry to just its Procedure and metrics', () => {
    const h = makeRealm();
    const sessionId = 'sess-empty';
    h.emit({
      kind: 'start-session', patientId: h.patientId, sessionId,
      modality: 'hemodialysis', prescribedMinutes: 240, targetUfL: 2.5,
    });
    h.emit({
      kind: 'end-session', patientId: h.patientId, deliveredMinutes: 238, ufVolumeL: 2.5,
      qbAvg: 345, recirculationPct: 8, preWeightKg: 72.4, postWeightKg: 70.1,
    });
    const session = h.realm.graph.listKind('dialysis-session')[0]!;
    expect(telemetryOf(session)).toHaveLength(0);
    const resources = serializeEntity(session, ctx(h.id));
    expect(telemetryResources(resources, sessionId)).toHaveLength(0);
    // A data-less session projects nothing extra — that is a capability, not a failure.
    expect(resources.length).toBeGreaterThan(0);
  });
});
