import { describe, expect, it } from 'vitest';
import { buildCMSRegistry } from '../packs/cms-universe/index.js';
import { ALL_CMS_MEASURES, ESRD_QIP_MEASURES } from '../src/healthcare-core/cms-source-registry.js';

describe('CMS measure catalog', () => {
  it('seeds ESRD-QIP measures with denominator + numerator + evidence', () => {
    for (const m of ESRD_QIP_MEASURES) {
      expect(m.id.startsWith('cms:esrd-qip:') || m.id.startsWith('nhsn:')).toBe(true);
      expect(m.denominator.description.length).toBeGreaterThan(0);
      expect(m.numerator.description.length).toBeGreaterThan(0);
      expect(m.evidenceRequirements.length).toBeGreaterThan(0);
      expect(m.source.url).toMatch(/^https?:\/\//);
    }
  });

  it('builds a registry preloaded with the full measure catalog', () => {
    const r = buildCMSRegistry();
    const listed = r.listMeasures();
    expect(listed.length).toBe(ALL_CMS_MEASURES.length);
    // ESRD-QIP measures resolve to their program source.
    const kt = listed.find((m) => m.id === 'cms:esrd-qip:kt-v');
    expect(kt?.programId).toBe('cms:esrd:qip');
    expect(r.measuresForSource('cms:esrd:qip').length).toBeGreaterThan(5);
  });

  it('covers CMS-0057-F, MIPS, VBP, IQR, PI, NHSN programs', () => {
    const programs = new Set(ALL_CMS_MEASURES.map((m) => m.programId));
    for (const expected of ['cms:esrd:qip', 'cms:iqr', 'cms:hvbp', 'cms:mips', 'cms:promoting-interoperability', 'nhsn:dialysis', 'cms:0057-f']) {
      expect(programs.has(expected)).toBe(true);
    }
  });
});
