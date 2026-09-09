/******************************************************************************
 * DST-Q #3 — ESA suggestion evidence fusion.
 *
 * Pure unit coverage for `src/swarm/anemia-dst.ts`: evidence refs are derived
 * only from what the advisor actually consumed, and the fused Bel/Pl/K posture
 * is honest about how rich (and how real) the window is.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import { esaEvidenceRefsFor, esaSuggestionDst } from '../src/swarm/anemia-dst.js';
import type { EsaPatientWindow } from '../src/swarm/anemia.js';

function window(over: Partial<EsaPatientWindow> = {}): EsaPatientWindow {
  return {
    patientId: 'p-esa-t',
    currentHgb: 10.6,
    onESA: true,
    currentDose: 8000,
    asOf: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('esaEvidenceRefsFor', () => {
  it('always reflects the charted Hb and the KDIGO anchor', () => {
    const refs = esaEvidenceRefsFor(window({ onESA: false }));
    const ids = refs.map((r) => r.sourceId);
    expect(ids).toContain('esa:chart:hgb');
    expect(ids).toContain('catalog:kdigo-band');
    expect(refs[0]?.contentType).toBe('fact');
  });

  it('only emits refs for labs the window actually carries', () => {
    const refs = esaEvidenceRefsFor(window({ ferritin: 640, crp: 6 }));
    const ids = refs.map((r) => r.sourceId);
    expect(ids).toContain('esa:chart:ferritin');
    expect(ids).toContain('esa:chart:crp');
    expect(ids).not.toContain('esa:chart:mcv');
    expect(ids).not.toContain('esa:chart:pth');
  });

  it('maps history to events and an on-ESA state to a medication event', () => {
    const refs = esaEvidenceRefsFor(window({ hgbTrendLast90d: [10, 10.2, 10.4], esaEscalationsLast90d: 2 }));
    const byContent = refs.filter((r) => r.contentType === 'event').map((r) => r.sourceId);
    expect(byContent).toContain('esa:history:hgb-trend');
    expect(byContent).toContain('esa:history:esa-escalation');
    expect(byContent).toContain('esa:medication:esa');
  });
});

describe('esaSuggestionDst', () => {
  it('is undefined-free and internally consistent for a full window', () => {
    const out = esaSuggestionDst(window({
      mcv: 92, ferritin: 640, transferrinSat: 28, crp: 6, calcium: 9.2, pth: 120,
      hgbTrendLast90d: [10.1, 10.3, 10.4, 10.6],
      lastIronPanelAt: '2026-08-01T00:00:00Z',
    }));
    expect(out.belief).toBeGreaterThanOrEqual(0);
    expect(out.belief).toBeLessThanOrEqual(out.plausibility);
    expect(out.plausibility).toBeLessThanOrEqual(1);
    expect(out.uncertainty).toBeGreaterThanOrEqual(0);
    expect(out.conflictMass).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(1);
    expect(out.sources.length).toBe(out.refs.length);
    // hgb + 6 labs + trend + on-ESA + iron panel + KDIGO
    expect(out.refs.length).toBe(11);
  });

  it('reads a rich, fresh window as corroborated and scores it above a sparse one', () => {
    const rich = esaSuggestionDst(window({
      mcv: 92, ferritin: 640, transferrinSat: 28, crp: 6, calcium: 9.2, pth: 120,
      hgbTrendLast90d: [10.1, 10.3, 10.4, 10.6],
      lastIronPanelAt: '2026-08-01T00:00:00Z',
    }));
    const sparse = esaSuggestionDst(window({ onESA: false }));
    expect(rich.evidenceStatus).toBe('corroborated');
    expect(rich.belief).toBeGreaterThanOrEqual(0.55);
    expect(rich.score).toBeGreaterThan(sparse.score);
    expect(rich.belief).toBeGreaterThan(sparse.belief);
    expect(sparse.evidenceStatus).toBe('weak');
  });

  it('keeps the KDIGO reference object honest (low reliability, never a fact)', () => {
    const refs = esaEvidenceRefsFor(window({ onESA: false }));
    const kdigo = refs.find((r) => r.sourceId === 'catalog:kdigo-band');
    expect(kdigo?.contentType).toBe('object');
    // catalog/reference sources carry the low synthetic reliability dial.
    const out = esaSuggestionDst(window({ onESA: false }));
    const kdigoSource = out.sources.find((s) => s.sourceId === 'catalog:kdigo-band');
    expect(kdigoSource?.alpha).toBeLessThanOrEqual(0.4);
  });
});
