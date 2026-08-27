#!/usr/bin/env node
/**
 * Phase F — Docker Compose smoke test.
 *
 * Validates the deployment stack (docker-compose.yml) compiles and that every
 * service the port plan requires is present:
 *
 *   anant-health-app       — the AnantHealth server (API + admin console)
 *   anant-health-postgres  — durable event store
 *   anant-health-redis     — job bus / broker durability
 *   anant-health-kafka     — optional Kafka driver (--profile kafka)
 *
 * Usage:
 *   node scripts/docker-smoke.mjs          # config + structure checks (fast)
 *   node scripts/docker-smoke.mjs --up     # ALSO boot postgres+redis + healthcheck
 *
 * Exit code 0 = smoke passed.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const up = process.argv.includes('--up');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const run = (args) => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// 1. The compose file must compile.
try {
  run(['config', '-q']);
  check('compose config compiles', true, 'docker compose config -q → OK');
} catch {
  check('compose config compiles', false, 'docker compose config -q FAILED');
}

// 2. Core services must be present in the merged config.
try {
  const merged = JSON.parse(run(['config', '--format', 'json']));
  const services = Object.keys(merged.services ?? {});
  for (const s of ['anant-health-app', 'anant-health-postgres', 'anant-health-redis']) {
    check(`service ${s}`, services.includes(s), services.includes(s) ? 'present' : 'MISSING');
  }
  const app = merged.services?.['anant-health-app'] ?? {};
  check('app wired to Postgres', String(app.environment?.HH_DATABASE_URL ?? '').includes('postgres://'), app.environment?.HH_DATABASE_URL ?? '');
  check('app wired to Redis', String(app.environment?.HH_REDIS_URL ?? '').includes('redis://'), app.environment?.HH_REDIS_URL ?? '');
  const vols = app.volumes;
  const volList = Array.isArray(vols) ? vols.map((v) => String(v?.target ?? v)).join(',') : String(vols ?? '');
  check('app persists .harness', volList.includes('.harness'), volList || '(none)');
} catch (e) {
  check('merged config parse', false, String(e));
}

// 3. The optional Kafka profile must add the Kafka broker.
try {
  const kafka = JSON.parse(run(['--profile', 'kafka', 'config', '--format', 'json']));
  check('kafka profile adds broker', Boolean(kafka.services?.['anant-health-kafka']), 'anant-health-kafka present with --profile kafka');
} catch {
  check('kafka profile adds broker', false, '--profile kafka config FAILED');
}

// 4. Optional: boot Postgres + Redis (+ Kafka profile) and probe readiness.
if (up) {
  const withApp = process.argv.includes('--app');
  const svc = ['anant-health-postgres', 'anant-health-redis'];
  try {
    run(['--profile', 'kafka', 'up', '-d', ...svc, 'anant-health-kafka']);
    const healthy = async (s) => {
      const out = run(['ps', '--format', '{{.Service}} {{.Status}}']);
      const line = out.split('\n').find((l) => l.startsWith(s)) ?? '';
      return line.includes('healthy') || line.includes('(healthy)');
    };
    // Poll for health (kafka can take a while on first boot).
    const waitHealthy = async (s, tries = 24) => {
      for (let i = 0; i < tries; i++) {
        if (await healthy(s)) return true;
        await new Promise((r) => setTimeout(r, 2500));
      }
      return false;
    };
    const infraOk = (await waitHealthy('anant-health-postgres')) && (await waitHealthy('anant-health-redis')) && (await waitHealthy('anant-health-kafka'));
    check('stack boots (postgres+redis+kafka healthy)', Boolean(infraOk), infraOk ? 'all infra healthy' : 'not all healthy within timeout');

    if (withApp) {
      try {
        run(['--profile', 'kafka', 'up', '-d', '--build', 'anant-health-app']);
        // Resolve the ACTUAL host port (ANANT_HTTP_PORT in .env / compose maps
        // may differ from the container's 8080). `docker compose port` is the
        // source of truth for the published mapping.
        let port = 8080;
        try {
          const portOut = run(['--profile', 'kafka', 'port', 'anant-health-app', '8080']);
          const m = /0\.0\.0\.0:(\d+)/.exec(portOut) || /:(\d+)$/.exec(portOut.trim());
          if (m) port = Number(m[1]);
        } catch { /* fall back to 8080 */ }
        const probe = async (path) => {
          const http = await import('node:http');
          return new Promise((res) => {
            const req = http.get({ host: '127.0.0.1', port, path, timeout: 6000 }, (r) => {
              res(r.statusCode === 200);
              r.resume();
            });
            req.on('error', () => res(false));
            req.on('timeout', () => { req.destroy(); res(false); });
          });
        };
        const appOk = await probe('/health') && await probe('/admin/ui/') && await probe('/exec/');
        check('app boots (health + both UIs on :' + port + ')', Boolean(appOk), appOk ? '/health + /admin/ui/ + /exec/ 200' : 'app not reachable');
      } catch (e) {
        check('app boots (health + both UIs on :8080)', false, String(e));
      }
    }
  } catch (e) {
    check('stack boots (postgres+redis+kafka healthy)', false, String(e));
  }
}

// Report.
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name} — ${r.detail}`);
  if (r.ok) pass += 1;
}
const total = results.length;
console.log(`\nDocker smoke: ${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
