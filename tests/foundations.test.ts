import { describe, expect, it } from 'vitest';
import { checkPackBoundaries, targetPackFromSpecifier, packIdFromPath } from '../src/control-plane/pack-boundaries.js';
import { loadConfig, ConfigError } from '../src/server/config.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { resolve } from 'node:path';

describe('pack import boundaries', () => {
  it('packIdFromPath extracts pack id', () => {
    const root = '/repo';
    expect(packIdFromPath(root, '/repo/packs/dialysis-provider/index.ts')).toBe('dialysis-provider');
    expect(packIdFromPath(root, '/repo/src/kernel/index.ts')).toBeNull();
  });
  it('targetPackFromSpecifier detects cross-pack imports', () => {
    expect(targetPackFromSpecifier('../../packs/payer/index.js')).toBe('payer');
    expect(targetPackFromSpecifier('../../src/hypergraph/index.js')).toBeNull();
  });
  it('current repo has zero cross-pack import violations', () => {
    const root = resolve(process.cwd());
    const violations = checkPackBoundaries(root, [
      { id: 'healthcare-core' },
      { id: 'dialysis-provider', extends: [{ id: 'healthcare-core' }] },
      { id: 'ckd-navigation', extends: [{ id: 'healthcare-core' }] },
      { id: 'payer', extends: [{ id: 'healthcare-core' }] },
      { id: 'cms-universe', extends: [{ id: 'healthcare-core' }] },
      { id: 'oncology-provider', extends: [{ id: 'healthcare-core' }] },
      { id: 'infusion-provider', extends: [{ id: 'healthcare-core' }] },
      { id: 'care-management', extends: [{ id: 'healthcare-core' }] },
    ]);
    expect(violations).toEqual([]);
  });
});

describe('server config', () => {
  it('requires database url in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
  it('supplies defaults in development', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.httpPort).toBe(8080);
    expect(cfg.databaseUrl).toContain('postgres');
    expect(cfg.telemetryLogLevel).toBe('info');
  });
  it('parses HH_HTTP_PORT', () => {
    const cfg = loadConfig({ NODE_ENV: 'development', HH_HTTP_PORT: '9090' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.httpPort).toBe(9090);
  });
});

describe('telemetry pipeline', () => {
  it('records spans, metrics, and logs', () => {
    const sink = new InMemorySink();
    let t = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    const tel = new Telemetry('test', sink, 'debug', clock);
    const span = tel.startSpan('do-thing', { attributes: { k: 'v' } });
    span.end('ok');
    tel.metric('http.request', 1, { attributes: { method: 'GET' } });
    tel.log('info', 'hello', { traceId: 'abc' });
    expect(sink.records.length).toBe(3);
    const s = sink.records.find((r) => r.kind === 'span');
    expect(s && 'durationMs' in s && s.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('respects log level threshold', () => {
    const sink = new InMemorySink();
    const tel = new Telemetry('test', sink, 'warn');
    tel.log('info', 'nope');
    tel.log('warn', 'yep');
    expect(sink.records.length).toBe(1);
  });
});
