# Resilience Drills Runbook

Operational drills that exercise the real HTTP surface end-to-end — no mock
servers, no bypassing auth, no test doubles. Each drill logs in as the operator,
performs a real governed action, and asserts recovery.

All drills target `BASE_URL` (default `http://127.0.0.1:3000` — the dev server;
use `http://localhost:8080` against the full Docker boot in `docs/deployment.md`).

```bash
# defaults
BASE_URL=http://127.0.0.1:3000 node scripts/chaos-drill.mjs
BASE_URL=http://127.0.0.1:3000 node scripts/load-drill.mjs
BASE_URL=http://127.0.0.1:3000 node scripts/restore-drill.mjs
```

---

## 1. Chaos drill — `scripts/chaos-drill.mjs`

Injects a **real DLQ incident** (outbox row + incident bridge receipt) via a
gated fixture endpoint, then walks the operator DLQ journey and verifies restore.

```
admin login → DLQ baseline → inject incident → visible in DLQ →
acknowledge (owned) → replay (idempotent, original key) → incident cleared
```

- The fixture endpoint `POST /admin/platform/dlq/_drill/seed` is **gated**: it
  returns `403 chaos-drills-disabled` in production (`NODE_ENV=production` or
  `ANANT_ENV=production`). Enable explicitly with `HH_ENABLE_DRILLS=1`.
- Replay requires a broker. Against a broker-less runtime use `--skip-replay`
  (the acknowledge path still verifies ownership + restoration from the open
  list — acknowledge writes a durable `dlq-remediation` doc that removes the
  incident from the open view).
- **Restore semantics:** bridge receipts are immutable (first-write-wins). An
  incident is considered *open* until it has a durable `dlq-remediation` doc
  (acknowledged **or** replayed) — the DLQ view and My Work both derive *open*
  incidents from `openBridgeIncidents()`, so a remediated incident disappears
  from the open list while its history is preserved.

Exit code: non-zero if any check fails.

## 2. Load drill — `scripts/load-drill.mjs`

Concurrent GET load across the read surfaces an operator/exec session touches:

| Endpoint | What it proves |
|---|---|
| `/health` | infra health path holds under load |
| `/api/context` | session context (exec shell) |
| `/admin/platform/packs` | Pack Studio registry |
| `/admin/platform/dlq` | ops DLQ view |
| `/admin/swarm/state` | exec runtime state assembly |

```
CONCURRENCY=32 REQUESTS=400 BASE_URL=... node scripts/load-drill.mjs
```

Reports p50/p95/p99 latency, throughput, and error count per endpoint. **Pass
criterion: zero HTTP errors.** Latency expectations are environment-specific —
the dev server runs under `tsx` + in-memory SQLite, so expect slower p95 than a
built production image (`npm run build`, node:22, Postgres).

## 3. Restore drill — `scripts/restore-drill.mjs`

Proves operator-editable configuration is fully recoverable through the same
durable APIs used by the UI.

```
snapshot (org + admin policy + active pack)
  → mutate (org name/model, policy decision, synthetic flag)
  → verify mutation visible
  → restore (PUT snapshot back)
  → verify exact match
```

No direct DB access — only `PUT /admin/platform/organization`,
`PUT /admin/swarm/admin/policy` and the pack endpoints, i.e. exactly what the
operator console uses.

---

## When to run

- **After any infra/broker change** — chaos drill (with real broker).
- **Before a release rehearsal** — all three; the ten-ten gate assessment maps
  "Failure recovery" to these drills (`docs/ten-ten-gate-assessment.md`).
- **After UI refactors** — load drill against `/admin/platform/packs` +
  `/admin/swarm/state` to catch accidental per-request cost regressions.
- **Onboarding to a fresh environment** — restore drill verifies the
  configuration surface is round-trippable end-to-end.
