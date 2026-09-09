# Renal Enterprise — Delivery Roadmap (phases & definition of done)

> Working plan to move the harness from a **2-facility governed demo** to an
> **end-to-end, real-time, enterprise-scale Renal solution** with coherent UI.
>
> Companion doc: `docs/renal-enterprise-e2e-analysis.md` (the gap analysis this
> plan executes). Each phase below is **independently demoable**, lands as
> **fully-tested, committed slices** (like P0–P3), and lists its own
> **Definition of Done / exit criteria** so we can check it off.

---

## Sequencing at a glance

```mermaid
flowchart LR
  A0[A0 · Anemia CDSS P0-P3 · done] --> R0
  A0 --> DSTQ[DST-Q · quick wins]
  R0[R0 · Redis real-time event sim] --> R1
  U[U · UI rationalization & cohesion] --> R2
  DSTQ --> R3
  R1[R1 · Enterprise world + complete data] --> R2
  R2[R2 · Region/network operations (exec)] --> R3
  R3[R3 · DST at enterprise scale] --> R4[R4 · E2E demo hardening]
```

- **Critical path**: A0 → R0 → R1 → R2 → R3 → R4.
- **Runs alongside (parallel, independent)**: **DST-Q** and **U** can start
  immediately and fold into each later phase.

---

## A0 — Anemia/ESA CDSS (✅ delivered)

Reference governed closed loop (P0) → governance/red-team/coverage (P1) → Python
trainer + same-contract trained serving (P2) → external validation/study/MDR (P3).
Commits `93e8a1b..2c185b0`. Full suite 667 + 3 skipped. (Not re-planned here.)

---

## R0 — Real-time event simulation over Redis

**Objective.** Demonstrate the sim fleet producing **canonical events through
Redis** and Exec reacting live — no polling for the event wall.

**Deliverables**
- Instantiate `BrokerEventRouter` in dev + bootstrap; bind `anant.canonical.events`
  → dispatch; canonical-event registry for the projection.
- Redis demo mode: run with `HH_EVENTBROKER_DRIVER=redis-streams|bullmq` +
  `HH_REDIS_URL` (docker `anant-health-redis`); every sim `WorldEffect` →
  `RealmEventBridge` → outbox → Redis (durable/replayable).
- Exec **live events** endpoint (SSE, or bounded `/api/live/events` tail) +
  per-facility filter; **“LIVE · Redis”** badge + event ticker surfaced in Exec
  (Swarm control / a new Ops wall). Replay-from-Redis button.
- In-process path stays the deterministic default (CI/tests untouched).

**Definition of done**
1. With Redis mode on, a started `dialysis-demo` fleet pushes events into Redis and
   the Exec event wall updates in near-real-time (no 4s poll for the wall).
2. `/admin/broker` shows the redis-streams/bullmq driver healthy + delivered
   counts; replay re-publishes the last N.
3. Full vitest + tsc green in default mode; real-broker conformance still passes
   under `RUN_REAL_BROKER_TESTS=1`.
4. One red-team/assurance finding path unaffected (governance still on canonical
   domain, not transport).

---

## DST-Q — Dempster–Shafer quick wins (independent, parallel)

**Objective.** Put the existing D-S substrate to work on decisions clinicians see
today, before the fleet scale work.

**Deliverables**
1. **Belief-aware My Work** — `/api/work` queue (platform-routes `buildWorkQueue`)
   scores items by `decisionValue × Bel − γ·Pl(harm)`, gates `awaiting-approval`
   on `Pl(harm)` and conflict `K`; show `Bel/Pl/K` on each My Work row/drawer.
2. **ESA episode evidence fusion** — `anemia.esa-response` episodes carry fused
   evidence (lab + trend + prior-response) → `Bel/Pl/K` + status on the Class-C
   suggestion before it lands in My Work; resolve gate consistent with episodes.
3. **Multi-signal early-warning** — new small module fuses vitals + labs +
   missed-treatment + ESA-no-response into a per-patient **deterioration belief**;
   open an alert/episode only when `Bel ≥ gate` and `K` low. Exec surface to
   visualize signals → fused belief. Complements CfC/LTC (forecast) with
   combined-evidence warrant (DST).

**Definition of done**
1. My Work ordering changes when belief/harm differ from urgency rank (unit test +
   live check); Bel/Pl/K visible.
2. ESA suggestion carries a fused rating; an episode with contested evidence
   (`K ≥ gate`) is not silently acted on.
3. Early-warning fires only above the belief gate for a synthetic patient with
   corroborated signals, and stays silent for a single noisy signal.
4. Full suite + tsc green; exec shows the new fields with the existing style.

---

## U — UI rationalization & cohesion

**Objective.** Make both consoles **make sense** as one product: right page for the
right user, consistent terminology, coherent states and interactions — and a way
to *prove* it (a health check), not just feel it.

**Deliverables**
1. **Persona × page matrix** — Admin UI (setup/data/world) vs Exec
   (admin / clinician-MD / ops-executive). For every exec page and every admin
   section: intended user, key task, data source, primary action. Flag overlaps
   (e.g., Swarm control + Executive outcomes + AI Assurance appear in both
   consoles — decide primary home + cross-link or de-duplicate).
2. **Terminology & IA pass** — one term per concept across consoles (episode,
   cell, work item, NBA, finding, release, delegation, study, validation). Align
   nav labels (Exec “Outcome command” vs My Work; payer lens renames). Audit exec
   lens renames (LENS_TEXT) so no renal terms leak to payer.
3. **Shared interaction/state rules** — consistent page-head, panel, drawer, tag
   tones, empty/loading/error/expired-session patterns (extend the anemia
   session-expiry handling to ALL exec pages), numeric + date formatting, Bel/Pl/K
   presentation, synthetic labels, and cross-console deep links (exec ↔ admin
   switch already exists; add per-entity deep links).
4. **UI health check** — a repeatable sweep (pageerror/console scan, reload-race
   guard, keyboard tab, contrast, no overlapping/clipped panels, responsive
   breakpoints) run across every exec page + admin section; encode as a runnable
   checklist/script so regressions are caught.
5. **Visual cohesion** — shared token file already exists (exec `tailwind.css` +
   admin `shell-base` tokens = same palette). Sweep to guarantee identical accent
   (#98aec0), spacing, typography, and that Tailwind v3 admin CDN layers don’t
   drift from exec globals.

**Definition of done**
1. Page matrix published and every page passes a one-line “who/task/action” audit;
   overlaps resolved (or explicitly linked).
2. Terminology glossary enforced (grep check) — no duplicate names for the same
   concept across consoles.
3. Empty/loading/error/expired-session states on every surface; no “Loading…”
   stuck screens (reload-race guard) anywhere.
4. UI health check passes all exec pages + admin sections with 0 page errors;
   exec + admin builds clean.
5. Contrast AA on interactive text; keyboard-navigable primary flows.

---

## R1 — Enterprise world + complete data

**Objective.** A presenter can stand up a **realistic multi-facility enterprise**
(regions → facilities → units → patients) with **complete longitudinal data** that
drives every domain (QIP, anemia/ESA, trajectory, claims, safety, capacity).

**Deliverables**
1. **Fleet/world builder** — deterministic enterprise generator driven by a config
   (or admin form): N regions × M facilities × units × patients; seed hundreds of
   facilities + thousands of patients as `sim:*` realms/master-data. Scale knob +
   preset worlds (e.g., 6 regions / 20–60 facilities / 300–800 patients).
2. **Rich longitudinal patient generator** — per patient: weekly labs (Hb, MCV,
   ferritin, TSAT, CRP, Ca, PTH; Kt/V, PHOS), monthly ESA dose + iron panel
   (feeds anemia P2/P3 cohort + episodes), session history (missed/completed with
   Kt/V delivered), vitals, assessments, claims + prior-auths, safety events —
   generated at seed, then evolved live by the simulator scripts.
3. Extend `SimRealmDef`/scenario model to **multi-facility-per-realm** (or fleet
   of realm-per-facility) so the demo spans regions; ensure realm/sim restore +
   cleanup scale (outbox/retention hygiene so the historical bloat doesn’t recur).
4. Swarm + anesthesia + payer + claims **read the richer data** (labs panel,
   anemia windows, QIP measure rows) — no hard-coded demo arrays.

**Definition of done**
1. Standing up the “enterprise preset” creates 20+ facilities / 300+ patients with
   longitudinal data in minutes; realms restore across restart; cleanup returns
   store size (retention + vacuum) to baseline.
2. Every patient has a complete 90-day lab/anemia window + session history; ESA
   program can advise on real seeded patients (not only p-esa-*).
3. Region counts flow to the live swarm layer (`/admin/swarm/integration` shows
   live across the fleet).
4. Full suite + tsc green; demo shows facility/region selectors populated from the
   fleet.

---

## R2 — Region / network operations (Exec)

**Objective.** Give admins, clinicians and ops executives a **real business
console at scale**: census, rollups, drill-down — built on real aggregation, not
labels.

**Deliverables**
1. **Regional rollup engine** (backend) — aggregate per-facility counts/metrics to
   region/network along the operating-model hierarchy (live, not the flat
   `deriveLiveSwarm` sum): census (admitted/missed/safety/labs-due/ESA), quality
   (QIP/CMS), ops (capacity/staffing), safety events, revenue. Drill-down path
   region → facility → unit → patient.
2. **Live census board** (Exec) — facilities grid with status heat, per-facility
   chips; filters by region/network; auto-refresh via the R0 live path or
   polling.
3. **Exec region lens** — new or upgraded nav (e.g., “Operations” or a region
   switcher) showing rollups + My Work **grouped by facility/region** for MDs.
4. **Facility heat / risk** — reuse DST-Q early-warning output to rank facilities
   (not just patients); cross-facility conflict surfaced to exec.

**Definition of done**
1. A seeded enterprise world shows correct region rollups that drill to a single
   facility and patient; numbers reconcile with per-facility state (no flat-labels).
2. Exec census board renders the fleet with live refresh and zero page errors.
3. MD My Work filters by facility/region; a clinician can go My Work → facility →
   patient → episode without leaving Exec.
4. Full suite + tsc green; browser-verified on the enterprise preset.

---

## R3 — DST at enterprise scale

**Objective.** Region-level evidence fusion + belief-aware operations across the
fleet (builds on DST-Q).

**Deliverables**
1. **Region-level D-S aggregation** — pool the same signal type across facilities,
   discount each facility’s mass by per-facility reliability (provenance kept),
   retain only when region `Bel` crosses a gate with low `K` (turns “12 facilities,
   1 signal each” into “SE region degrading, Bel 0.83”).
2. **Belief-aware operational decisions** — apply the DST-Q scoring to the region
   work queue + facility-risk ranking; surface `Bel/Pl/K` on rollups.
3. **Revenue-cycle / claims DST** — belief-aware adjudication (orders + auth +
   contract evidence) reusing reliability/discount machinery.
4. Fold DST-Q outputs (early-warning, ESA fusion) into region findings with full
   provenance.

**Definition of done**
1. Region aggregation unit test: many weak single-facility signals → a gated
   region finding; a lone noisy facility does not fire.
2. Exec rollups show region Bel/Pl/K; drill-down shows per-facility masses +
   reliability.
3. Claims/prior-auth episodes rank by belief; no regression on existing
   payer/swarm tests.
4. Full suite + tsc green; browser-verified on the enterprise preset.

---

## R4 — End-to-end demo hardening & packaging

**Objective.** A polished, repeatable enterprise demo.

**Deliverables**
1. **Demo journeys + runbook** — scripted journeys by persona: ops-exec (census →
   region rollup → drill), clinician (early-warning → My Work → approve → verify),
   anemia/ESA (advisor → Class-C → dose → measure), payer, CMS/regulatory,
   assurance/release. Each with its seed/state and expected screens.
2. **Drills at fleet scale** — load (concurrent GET), chaos (DLQ injection,
   broker restart/replay), restore (org/policy/pack/fleet) re-run on the
   enterprise preset.
3. **Packaging** — docker-compose with Redis mode on by default for the hosted
   demo (`ANANT_EVENTBROKER_DRIVER=redis-streams`), HH_DEMO_SIM preset world;
   OpenAPI/docs updated; landing page copy aligned to the enterprise story.
4. **Labels & readiness** — synthetic labeling everywhere; the U-health-check
   green on every journey.

**Definition of done**
1. All 6 persona journeys run from a single command (Redis mode) with no manual
   data fixing; runbook checked into `docs/`.
2. Drills pass at fleet scale; store size stays bounded (retention + vacuum).
3. Docker boot: app + postgres + redis (+ optional kafka) healthy; exec + admin +
   `/docs` all 200; demo world live.
4. Full suite + tsc + exec/admin builds green; UI health check green.

---

## How we’ll execute each phase

- One **todo list** per phase; work in **committed, fully-tested slices** (domain →
  routes/APIs → UI → tests → live-verify → commit + push), exactly as P0–P3.
- Every slice: backend `tsc`, exec `tsc`+build, targeted vitest, then **full suite**
  before commit; **live verify on :3000** in the browser; repo-memory note appended.
- Phases with hard data/scale dependencies (R1 fleet, R2 rollups, R3 region DST)
  are ordered on the critical path; **DST-Q** and **U** are independent and can
  start immediately.

---

## Suggested first moves

1. **R0** — Redis real-time event sim (your explicit ask) — unblocks the “live”
   feel for every later phase.
2. **U** — UI rationalization & cohesion (also your ask) — cheap, high value, and
   makes every later UI addition land coherently.
3. **DST-Q** — belief-aware My Work + ESA fusion + early-warning — independent,
   showcases DST immediately.

Then **R1 → R2 → R3 → R4** on the critical path.
