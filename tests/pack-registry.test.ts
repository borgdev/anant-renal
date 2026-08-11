import { describe, expect, it } from 'vitest';
import { PackRegistry, satisfies } from '../src/control-plane/index.js';
import { healthcareCorePack, dialysisProviderPack, ckdNavigationPack, payerPack, cmsUniversePack } from '../packs/index.js';

describe('PackRegistry', () => {
  it('resolves dependencies in order', () => {
    const r = new PackRegistry();
    r.register(healthcareCorePack);
    r.register(dialysisProviderPack);
    r.register(ckdNavigationPack);
    r.register(payerPack);
    r.register(cmsUniversePack);
    expect(r.all().map((p) => p.id)).toContain('dialysis-provider');
    expect(r.resolve('dialysis-provider').id).toBe('dialysis-provider');
  });

  it('fails on missing dependency', () => {
    const r = new PackRegistry();
    expect(() => r.register(dialysisProviderPack)).toThrow();
  });

  it('satisfies caret ranges', () => {
    expect(satisfies('0.2.0', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfies('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
  });
});
