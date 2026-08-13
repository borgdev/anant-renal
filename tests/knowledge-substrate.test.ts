import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapKnowledgeLayer } from '../src/knowledge/index.js';

describe('M20 knowledge substrate (pack ⇄ source hypergraph)', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'hh-substrate-'));
  const layer = bootstrapKnowledgeLayer({ storeDir });

  it('registers 36 sources with 10+ pack subscriptions', () => {
    expect(layer.sources.list().length).toBe(36);
    const subs = layer.sources.allSubscriptions();
    const packIds = new Set(subs.map((s) => s.packId));
    expect(packIds.size).toBeGreaterThanOrEqual(10);
    expect(subs.length).toBeGreaterThanOrEqual(30);
  });

  it('emits a reach table where a shared source (rxnorm) fans out to multiple packs', () => {
    const reach = layer.sources.reachTable();
    const rxn = reach.find((r) => r.sourceId === 'nlm.rxnorm');
    expect(rxn).toBeDefined();
    expect(rxn!.packs.length).toBeGreaterThanOrEqual(3);
  });

  it('bills a pack with categories, tiers, and blocking-source list', () => {
    const bill = layer.sources.bill('ckd-navigation');
    expect(bill.totalSources).toBeGreaterThan(0);
    expect(Object.keys(bill.byCategory).length).toBeGreaterThan(0);
    expect(Object.keys(bill.byTier).length).toBeGreaterThan(0);
  });

  it('fanout for a source lists every consuming pack and effective cadence', () => {
    const fan = layer.sources.fanout('nlm.rxnorm');
    expect(fan.totalPacks).toBeGreaterThan(0);
    expect(fan.subscriptions.length).toBeGreaterThan(0);
    expect(fan.effectiveCadence).toBeDefined();
  });

  it('scheduler exposes due sources deterministically (fresh boot means all cadenced sources due)', () => {
    const due = layer.scheduler.dueSources();
    // All non-"on-demand" sources should be due on a cold boot
    expect(due.length).toBeGreaterThan(0);
    // Sorted by overdueBy descending
    for (let i = 1; i < due.length; i++) {
      expect(due[i - 1]!.overdueBy).toBeGreaterThanOrEqual(due[i]!.overdueBy);
    }
  });

  it('secrets registry is namespaced per source and audits updates', () => {
    layer.secrets.set('nlm.vsac', 'UMLS_API_KEY', 'test-key-abc', 'test-user');
    const audit = layer.secrets.list('nlm.vsac');
    expect(audit.find((r) => r.key === 'UMLS_API_KEY')?.hasValue).toBe(true);
    expect(layer.secrets.get('nlm.vsac', 'UMLS_API_KEY')).toBe('test-key-abc');
    // Cross-namespace isolation
    expect(layer.secrets.get('nlm.umls', 'UMLS_API_KEY')).toBeUndefined();
    layer.secrets.clear('nlm.vsac', 'UMLS_API_KEY');
    expect(layer.secrets.get('nlm.vsac', 'UMLS_API_KEY')).toBeUndefined();
    rmSync(storeDir, { recursive: true, force: true });
  });
});
