// NLM RxNav adapters (RxNorm nomenclature + class-based interactions).

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, pMap, saveManifest, sha256, writeArtifact } from './base.js';

interface RxNavConfig { base: string; versionEndpoint?: string; }
const EX_VERSION = '0.20.0';

/**
 * RxNorm: pull ATC drug classes and the members of each class. This yields
 * a searchable per-class artifact set that packs use for renal-adjusted /
 * beers / high-alert filtering.
 */
export const rxnormAdapter: KnowledgeAdapter<RxNavConfig> = {
  kind: 'rxnav-rxnorm', version: EX_VERSION,
  async *sync(input): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const base = input.config.base;
    const current: { id: string; contentHash: string }[] = [];

    // Version check
    const vRes = await httpFetch(`${base}${input.config.versionEndpoint ?? '/version.json'}`, { accept: 'application/json' });
    yield { type: 'fetch', url: vRes.url, ok: vRes.ok, status: vRes.status, bytes: vRes.bytes };
    if (!vRes.ok) { return { totalFetched: 0, totalExtracted: 0, changes: [] }; }
    const version = (JSON.parse(vRes.bodyText) as { version?: string }).version ?? new Date().toISOString().slice(0, 10);

    // Pull ATC class tree (level 1 classes)
    const classes = ['A', 'B', 'C', 'D', 'G', 'H', 'J', 'L', 'M', 'N', 'P', 'R', 'S', 'V'];
    let total = 0;
    for (const atc of classes) {
      const url = `${base}/rxclass/classMembers.json?classId=${atc}&relaSource=ATC`;
      const res = await httpFetch(url, { accept: 'application/json' });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      const parsed = JSON.parse(res.bodyText) as { drugMemberGroup?: { drugMember?: { minConcept?: { rxcui?: string; name?: string; tty?: string } }[] } };
      const members = parsed.drugMemberGroup?.drugMember ?? [];
      const id = `atc-${atc}`;
      const structured = { atcClass: atc, members: members.map((m) => m.minConcept).filter(Boolean) };
      const json = JSON.stringify(structured);
      const hash = sha256(json);
      const artifact = buildArtifact({
        sourceSpec: input.spec,
        id,
        title: `ATC class ${atc} · ${members.length} drug members`,
        summary: `RxNorm class members for ATC top-level class ${atc}`,
        structured,
        clinicalDomains: ['all'],
        raw: { url, contentType: 'application/json', bytes: json.length, hash, upstreamVersion: version, fetchedAt: nowIso() },
        extractorId: 'rxnav-rxnorm', extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id, contentHash: hash });
      total += members.length;
      yield { type: 'progress', done: current.length, total: classes.length, message: `ATC ${atc}: ${members.length} drugs` };
    }

    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, upstreamVersion: version, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { upstreamVersion: version, totalFetched: current.length, totalExtracted: current.length, changes };
  },
  async testCredentials() { return { ok: true, message: 'RxNav is public; no credentials needed.' }; },
};

/** RxNav interaction (class-based; individual DDI API was deprecated 2024). */
export const rxnavInteractionAdapter: KnowledgeAdapter<RxNavConfig> = {
  kind: 'rxnav-interaction', version: EX_VERSION,
  async *sync(input): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    // The interaction API for individual RxCUIs was deprecated. We instead record
    // the current state as a machine-readable notice artifact so operators see
    // exactly what the harness can and cannot do here.
    const url = `${input.config.base}/version.json`;
    const res = await httpFetch(url, { accept: 'application/json' });
    yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
    const version = res.ok ? (JSON.parse(res.bodyText) as { version?: string }).version ?? '' : '';
    const id = 'notice.deprecation-2024';
    const summary = 'NLM deprecated the RxNav Drug Interaction API in 2024. Class-based interaction lookup via RxClass remains available. Operators should supply a proprietary DDI source (First Databank, Multum, Micromedex) via customer-supplied ingestion for production DDI screening.';
    const structured = { deprecationYear: 2024, replacement: 'RxClass class-based interaction and third-party DDI feeds', rxnavVersion: version };
    const json = JSON.stringify(structured);
    const hash = sha256(json);
    const artifact = buildArtifact({
      sourceSpec: input.spec, id, title: 'RxNav DDI API deprecated (2024)', summary, structured,
      raw: { url, contentType: 'application/json', bytes: json.length, hash, upstreamVersion: version, fetchedAt: nowIso() },
      extractorId: 'rxnav-interaction', extractorVersion: EX_VERSION,
    });
    writeArtifact(store, artifact);
    const current = [{ id, contentHash: hash }];
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, upstreamVersion: version, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { upstreamVersion: version, totalFetched: 1, totalExtracted: 1, changes };
  },
};

/** Suppress lint on unused imports in future strictness bumps. */
void pMap;
