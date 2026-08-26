# Phase F — End-to-End Demo Runbook

> One scripted demo proves the entire closed loop and produces an audit/replay
> package (port plan Phase F exit). This runbook documents the journey and how
> to run it.

## The journey (what it proves)

```
admin login
  → green team (8 gates pass)
  → red team (8 adversarial scenarios, 0 findings under block policy)
  → release: draft → validate (5/5 real gates) → approve → activate (immutable dossier)
  → payer demo (durable outcome episodes on the shared coordinator)
  → My Work (user cockpit) surfaces care-gap closure + authorization review
  → approve care-gap → Coordinating (command path entered)
  → audit/replay package written (release dossier + gates + findings + work
    processed + episode states, content-hashed for deterministic replay)
```

`--fresh` additionally demonstrates Journey M: an unsafe runtime policy
(`defaultDecision: allow`) makes the red-team suite fail and create **blocking
findings** → they are remediated + retested + independently reviewed → closed →
only then does the release validate and activate.

## How to run

Requires the server running (dev: `npm run dev` on `:3000`, or a deployed
instance):

```bash
# Against the local dev server (default http://127.0.0.1:3000)
node scripts/full-journey.mjs

# Against another instance
BASE_URL=http://localhost:8080 node scripts/full-journey.mjs

# Include the unsafe→findings→remediation branch (Journey M)
node scripts/full-journey.mjs --fresh
```

Credentials default to `admin` / `admin123`; override with `ADMIN_USER` /
`ADMIN_PASS`.

## Output

- Console: one `✓`/`✗` per journey step; exit code 0 = full journey passed.
- Artifact: `audit-replay/phase-f-audit.json` — the audit/replay package:
  `release` (version/status/dossier contentHash), `gates`, `findingsBlocking`,
  `configuration.activeVersion`, `workProcessed`, `episodes`, and a
  deterministic `packageHash` (same content → same sha256, so a replay is
  provably identical).

## Idempotency

The journey is re-runnable. The payer demo seed is idempotent (existing episodes
are not re-created) and the care-gap approve step is skipped when a prior run
already advanced the episode — so repeat runs are safe and still pass.

## Related verification

- Unit/integration: `tests/e2e-closed-loop.test.ts` (the same journey at the
  test level, deterministic hash asserted).
- Security: `tests/security-isolation.test.ts` (role/scope isolation + break-glass).
- Infra config: `node scripts/docker-smoke.mjs` (compose stack compiles; app
  wired to Postgres/Redis; kafka profile adds the broker).
