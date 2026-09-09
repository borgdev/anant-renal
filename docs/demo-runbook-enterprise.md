# R4 — E2E demo runbook (persona journeys + hardening)

How to run the full renal-enterprise demo end-to-end with complete data, regional
D-S operations, and the Redis live wall — and what to check at each stop.

## 1. Launch the world (R1 complete data)

```bash
# backend (in-process broker is fine for a single-host demo; redis optional)
ANANT_ENV=demo HH_DEMO_SIM=1 HH_DEMO_SIM_SCENARIO=dialysis-enterprise npm run dev
# exec console (Vite build)
cd exec-app && npm run build   # then open http://127.0.0.1:3000/exec/
```

- 6 facilities across **Middle TN / East TN / West TN**, 42 patients.
- Every patient is created with a deterministic **90-day history** — labs (K, HGB,
  URR, PHOS), vitals, missed treatments, ESA escalations consistent with its
  trajectory — so Patient intelligence and the deterioration watch have real
  context from minute zero (no "no labs yet").
- Verify: Patient intelligence → select any `rb-*-pt-*` patient → labs are
  populated and match the trajectory chip.

## 2. Persona journeys

| # | Persona | Journey | Proof points |
|---|---|---|---|
| 1 | **Network MD (region)** | Open My Work → the D-S rows (`evidence · Bel · Pl · K`) rank the highest-commitment episodes first → approve a Class-C/ESA item → watch it advance in Outcome Command → verify. | Bel/Pl/K row readout; approved episode → Coordinating/Resolved; ESA Class-C only in MD scope. |
| 2 | **Facility nurse** | Patient intelligence → early-warning watch: see the selected patient's deterioration Bel/Pl/K + cohort alerts. | Watch strip below the identity panel; posture tones (corroborated red-alert/weak amber/contested violet). |
| 3 | **Region operator** | Swarm control → **Regional operations** board: per-region census (realms/units/patients) + D-S deterioration roll-up; alerts surface to the top. | Region cards; `Default` demo watch population when the EW demo cohort is present; enterprise alert count. |
| 4 | **Administrator** | Agent ops / Configuration → open the live wall (`LIVE · in-process` or `LIVE · redis-streams`) and confirm the event ticker streams broker events. | `/api/live/events` tail; retained count; no raw errors. |
| 5 | **Anemia MD** | Anemia & ESA → Run advisor → D-S suggestion readout on the Class-C card; then find the same episode in My Work. | `D-S evidence · Bel · Pl · K` + priority matching My Work's rule. |

## 3. Redis real-time mode (optional, docker)

```bash
docker compose up -d anant-health-redis
ANANT_ENV=demo HH_EVENTBROKER_DRIVER=redis-streams HH_REDIS_URL=redis://localhost:6379 HH_DEMO_SIM=1 npm run dev
```

- Swarm control live wall shows **`LIVE · redis-streams`** and the retained count
  grows as the simulator publishes canonical events through the stream.
- Health: `GET /health` reports `broker.ok` + `deadLetter`.
- Broker status panel: `GET /admin/broker` (admin console).

## 4. Drill checklist (hardening gate)

- [ ] No app-code console `[error]` across the five journeys above.
- [ ] **Session-expiry drill**: while logged in, restart the backend (`tsx watch`
      reload) → within one poll the global **"Session expired — Sign in again"**
      banner appears on *any* page; Sign in again returns to a fresh session.
- [ ] Determinism: restart with the same scenario seed → same patient histories,
      same EW postures, same region roll-up.
- [ ] Cleanup: `npm run demo:cleanup` (or the admin Demo cleanup panel) stops the
      sim + drops `sim:*` realms and demo episodes/releases; verified realms and
      the outbox backlog are untouched.

## 5. Hardening tooling (added)

- **Automated console/a11y/responsive harness** — `scripts/ui-console-check.mjs`
  (Playwright). API-login → drives every exec page at desktop + tablet widths,
  asserting zero console/page errors, keyboard Tab reachability, no horizontal
  overflow, and AA text contrast.
  ```bash
  npm i -D playwright && npx playwright install chromium
  node scripts/ui-console-check.mjs --base http://127.0.0.1:3000
  ```
- **One-shot Redis real-time demo** — `docker-compose.demo-redis.yml` overlay:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.demo-redis.yml up -d --build
  ```
  Postgres + Redis (BullMQ + `redis-streams`) + the app on the
  `dialysis-enterprise` world at http://localhost:3000 — Swarm control shows
  `LIVE · redis-streams`. Tear down with the matching `down`.

## 6. What still gates on

- Wiring the real region hierarchy (admin ontology operating model) into the
  regional board instead of id-derived region names (R2 follow-up).
- Full manual keyboard/contrast/responsive sweep across every page as a spot
  pass over the automated harness results.
