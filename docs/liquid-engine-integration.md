# Local CfC/LTC Engine + WASM — Implementation Plan

> **Goal:** bring the Closed-form Continuous-time (CfC) / Liquid Time-constant (LTC)
> liquid-neural-network engine — currently living in the standalone `anant-cfc` demo — into
> this repo as a first-class, locally-run module, and ship a browser-runnable WASM build for
> in-UI "what-if" forecasting. The harness stops simulating patient trajectories with
> hand-authored `base ± jitter` physiology and starts evolving them under **learned** dynamics,
> while preserving the two non-negotiables: *no mocks in the path* and *deterministic replay*.
>
> Status: **DRAFT — planning only. No code has been moved yet.**

---

## 1. What we are extracting (from `anant-cfc`)

`anant-cfc` is intentionally structured for this extraction. The engine and the demo are
already separate crates.

| Crate (in `anant-cfc`) | Role | Extract? |
|---|---|---|
| `crates/liquid-core` | Native Rust CfC + LTC on [Candle](https://github.com/huggingface/candle). Inference-only, compiles to `wasm32-unknown-unknown`. `crate-type = ["rlib", "cdylib"]`. Deps: candle-core, candle-nn, serde, thiserror, rand, rand_chacha. | **Yes — verbatim** |
| `crates/liquid-train` | Training: AdamW, gradient clipping, synthetic dataset generation. Native-only (never wasm). Deps: liquid-core, domain-kit, candle. | **Yes — verbatim** |
| `crates/domain-kit` | Generic schema traits: `DomainPack`, `BaselineDynamics`, `EntityStateSchema`, `EventFeatureSchema`, `ObserverRule`, `InterventionSpec`, `PopulationSpec`, `ScenarioGenerator`, `EvalContext`. | **Yes — trimmed** (drop cyber/churn/iot/fraud/industrial deps) |
| `crates/liquid-wasm` | `wasm-bindgen` bindings (`WasmSimulation`) + all six domain packs. | **Partial** — keep the binding, replace domain packs with our own |
| `crates/domain-packs/healthcare` | Post-op deterioration domain (5 dims, 4 event features). | **Re-author** for dialysis (flagship) |
| `crates/server`, `crates/cli`, `web/` | Axum API, sim loop, SPA, React UI. | **No** — leave in `anant-cfc` as the multi-domain showcase |
| `infra/`, `data/` | Compose, migrations, SQLite DB. | **No** |

### The core computation (must preserve exactly)

The heart is a **learned residual on top of a deterministic baseline ODE**
(`liquid-ai.md` §2/§29, implemented in `crates/server/src/sim.rs::tick_domain`):

```
event_features  = scenario.next_event(t, dt)             // [n_features]
baseline_delta  = baseline.delta(state, event_features, dt)   // [n_state], hand-authored ODE
residual        = model.step(input=event_features, hidden, dt).prediction   // [n_state], learned
final_delta[i]  = baseline_delta[i] + α · residual[i]     // α = pack.residual_alpha() (default 0.15)
state[i]       += final_delta[i]
velocity[i]     = final_delta[i] / dt
```

Critical implementation detail from `tick_domain`: **detach `hidden` after every step**
(`entity.hidden = step_out.hidden.detach()`). Model params are `is_variable=true` (for
training), so feeding hidden forward without detaching chains the autograd graph across the
entity's whole lifetime → unbounded memory growth. Same for the WASM forecast loop.

### Public API surface to carry over

**Rust (`liquid_core`):**

```rust
pub enum LiquidModel { Cfc(Cfc), Ltc(Ltc) }
impl LiquidModel {
    pub fn step(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<LiquidStepOutput>; // { prediction, hidden }
    pub fn forward(&self, inputs, initial_state, delta_t) -> Result<LiquidForwardOutput>;               // trainer
    pub fn zero_state(&self, batch, device, dtype) -> Result<Tensor>;
    pub fn hidden_size(&self) -> usize;
    pub fn model_type(&self) -> &'static str; // "cfc" | "ltc"
}
// Config: CfcConfig, LtcConfig, WiringConfig, OdeSolverKind, MappingType, ActivationKind, CfcMode
// Serialization: liquid_core::serialization::load_model/save_model (SafeTensors)
```

**WASM (`liquid_wasm`) — the JS-facing surface we keep:**

```js
new WasmSimulation(domainId, modelKind /* "cfc"|"ltc" */, weights /* Uint8Array SafeTensors */, seed)
sim.forkFrom(stateJson /* {"<dim>": value} */, t)   // start forecast from "now", not cold
sim.forecast(steps, dtSec, interventionJson /* [["<dim>", delta], ...] */) -> JSON [{t, stage, state}]
```

---

## 2. Target architecture in this repo

```
healthcare-harness/
├─ native/                          # NEW — Rust liquid engine workspace
│  ├─ Cargo.toml                    #   workspace: liquid-core, liquid-train, liquid-wasm, domain-dialysis
│  ├─ .cargo/config.toml            #   [build] rustflags --cfg getrandom_backend="wasm_js" (see §5)
│  ├─ liquid-core/                  #   vendored from anant-cfc (verbatim)
│  ├─ liquid-train/                 #   vendored from anant-cfc (verbatim)
│  ├─ domain-kit/                   #   vendored, trimmed to traits we need
│  ├─ domain-dialysis/              #   NEW — DialysisDomain (K/HGB/URR/PHOS + deterioration)
│  └─ liquid-wasm/                  #   wasm-bindgen bindings → WasmSimulation
├─ src/liquid/                      # NEW — TypeScript boundary layer
│  ├─ index.ts                      #   public facade + types
│  ├─ wasm.ts                       #   lazy-load liquid_wasm.js (Node 22 can import .wasm)
│  ├─ trajectory.ts                 #   TrajectoryAmbientProcess — replaces hand-authored physiology
│  ├─ trainer.ts                    #   spawns `cargo run -p liquid-train` training jobs
│  ├─ model-store.ts                #   trained weights registry (SafeTensors on disk, indexed in DB)
│  └─ forecast.ts                   #   what-if / counterfactual glue
├─ src/realm/ambient.ts             #   MODIFY — PatientTrajectoryProcess/LabMaturationProcess
├─ src/realm/counterfactual.ts      #   MODIFY — runCounterfactual uses learned dynamics
├─ src/server/liquid-routes.ts      #   NEW — /admin/liquid/* routes (train, promote, forecast, compare)
├─ admin-ui/                        #   MODIFY — "Forecast" panel (WASM what-if) + training workbench
└─ tests/liquid-*.test.ts           #   NEW — parity, determinism, integration
```

Rules of the boundary:

- **Rust owns all numerics.** The TS side never re-implements CfC/LTC math — it calls the WASM
  bundle (same code the native trainer uses). This is `anant-cfc`'s own invariant
  ("the same Rust code the server runs — not a JS reimplementation").
- **`liquid-wasm` depends on `liquid-core` + `domain-dialysis` only** — never `liquid-train` —
  keeping the browser bundle inference-only.
- **The realm treats a forecast as just another ambient system effect** — ledgered, attributed,
  gated, replayable. Learned dynamics never bypass the governance path.

---

## 3. The dialysis domain pack (the real work)

`anant-cfc`'s healthcare domain is **post-op deterioration** (5 dims: vitals instability,
infection marker, treatment response, mobility, deterioration risk). Our flagship is **dialysis**
— so we re-author the domain for the lab values the harness already simulates
(`src/realm/ambient.ts::draw()`: K, HGB, URR, PHOS).

Proposed state schema (`domain-dialysis/src/lib.rs`):

| Dim | Meaning | Bounds | Notes |
|---|---|---|---|
| `vitals_instability` | HR/BP variance | 0–1 | replaces `PatientTrajectoryProcess` drift |
| `deterioration_risk` | composite risk (primary) | 0–1 | feeds observer rules + counterfactual gates |
| `ktv_adequacy` | Kt/V trend | 0–1 | the QIP measure the CQL evaluator scores |
| `phosphate` | Phos trend | 0–1 | high side = worse |
| `anemia_severity` | HGB/URR trend | 0–1 | high = worse |

Event features: `missed_treatment`, `access_complication`, `lab_marker_elevated`,
`abnormal_vital_reading`, `diet_phosphate_violation`.

Baseline ODE: port the harness's existing *intent* (missed treatment → K rises, URR falls;
recovering → HGB rises) into a `BaselineDynamics` impl, then let the residual learn the
correction from data. `cfc_config()` mirrors the shape: `input_size = #events`,
`output_size = #state_dims`.

Observer rules (carry over the velocity/regime idea from anant):
- `ktv-below-threshold`: `ktv_adequacy < 0.35` → Critical
- `rapid-deterioration`: `velocity(deterioration_risk) > 0.12` → Serious (the "regime change" signal)
- `phosphate-compound`: `phosphate > 0.5 AND vitals_instability > 0.5` → Critical

Interventions (with cost, feeding the harness cost ledger + counterfactual nudge engine):
- `adjust-dialysis-prescription` ($2.0): `+ktv_adequacy`, `−phosphate`
- `dietitian-nudge` ($0.5): `−phosphate`, `−deterioration_risk`
- `escalate-nephrologist` ($3.0): `−deterioration_risk`, `−vitals_instability`

Population: reuse the harness's dialysis facility seeding (`sim-populator.ts` / `populateFacility`)
as the source of `EntityProfile`s, instead of anant's synthetic segments.

---

## 4. Implementation phases

### Phase 0 — Toolchain prerequisites
- Rust stable + `wasm32-unknown-unknown` target, `wasm-pack`.
- Verify candle + wasm in **this** repo with a throwaway build before wiring anything
  (the `getrandom` wasm quirks in §5 are the #1 thing that bites).
- **Acceptance:** `cd native && cargo build -p liquid-core && wasm-pack build --target web` succeeds.

### Phase 1 — Vendor the engine (mechanical)
1. Copy `liquid-core`, `liquid-train`, `domain-kit` into `native/`; trim `domain-kit` to the
   traits the harness needs; drop the non-healthcare domain packs.
2. Add `.cargo/config.toml` with the wasm rustflags; add the dual `getrandom` pins to
   `liquid-wasm`'s `Cargo.toml` (see §5).
3. Add a `native/README.md` documenting provenance (source repo, commit SHA, license) so the
   vendored code stays traceable.
4. **Acceptance:** `cargo test -p liquid-core` passes (CfC/LTC numerics + a training run that
   beats zero-residual baseline — the anant correctness test carries over).

### Phase 2 — Dialysis domain pack

> ✅ **Status (2026-08-15): implemented.** `native/domain-dialysis` — baseline ODE, 5 state
> dims, 5 event features, 3 observer rules, 3 costed interventions, population spec, seeded
> scenario generator. 15 tests passing (`cargo test -p domain-dialysis`).

1. Implement `domain-dialysis` per §3 (schema, baseline, observer rules, interventions,
   scenario generator).
2. Unit-test the baseline ODE in isolation (known inputs → expected deltas) and the observer
   rule firing (edge-triggered + cooldown).
3. **Acceptance:** `cargo test -p domain-dialysis` — rule fires exactly once across a threshold
   crossing; intervention deltas land on the right dims.

### Phase 3 — WASM bindings + TS boundary

> ✅ **Status (2026-08-15): implemented.**
> - `liquid-wasm` now binds `domain-dialysis`; added `stepWithEvents(eventJson, dt)` (external
>   event-driven ticks) + `setResidualAlpha(α)` (baseline-only until trained) + hidden detach
>   in a shared `advance()`.
> - WASM bundle staged at `src/liquid/wasm/` (rebuilt via `npm run liquid:wasm`).
> - `src/liquid/` TS boundary: `wasm.ts` (Node/browser loader), `types.ts`, `model-store.ts`
>   (`.harness/liquid/` weights registry), `trajectory.ts` (`TrajectoryAmbientProcess`),
>   `index.ts`.
> - Realm wired with `trajectoryEngine: 'legacy' | 'liquid'` (default `legacy`); the liquid
>   process projects learned dialysis state → K/HGB/URR/PHOS + vitals + risk on the entity
>   graph, driven by realm effects.
> - Tests: `tests/liquid-trajectory.test.ts` (5 passing) — wasm load + bounded state, missed-vs
>   -treated Kt/V, realm integration (plausible converging labs), legacy default, model store.
> - α is set to 0 (baseline-only, deterministic) until trained weights are promoted (Phase 6).

1. Port the `WasmSimulation` binding from `liquid-wasm` (keep `new`/`forkFrom`/`forecast`),
   bound to `domain-dialysis`.
2. `src/liquid/wasm.ts`: lazy-load the generated `liquid_wasm.js`; in Node (tests/dev), load the
   `.wasm` directly (Node 22 `WebAssembly` / wasm-pack `--target web` output is importable).
3. `src/liquid/model-store.ts`: persist trained weights (SafeTensors bytes) — file on disk under
   `.harness/liquid/`, row in the store (§7) for the active model per pack.
4. `src/liquid/trajectory.ts`: **`TrajectoryAmbientProcess`** implementing the existing
   `AmbientProcess` interface (`src/realm/ambient.ts`). Per realm tick:
   - gather each patient's event-feature vector from recent ledger effects (missed treatment,
     lab results, etc.),
   - call `forecast` (or native step when server-side) to get `ΔX`,
   - emit the resulting state change as normal ambient effects/`graph.patch`,
   - keep it **behind a flag** (`trajectoryEngine: 'liquid' | 'legacy'`) until parity is proven.
5. **Acceptance:** a realm with `trajectoryEngine: 'liquid'` produces plausible K/HGB/URR/PHOS
   trajectories that converge under the learned residual; legacy path still works via the flag.

### Phase 4 — Parity & the no-mocks invariant

> ✅ **Status (2026-08-15): implemented.**
> - Cross-target parity proven two ways: (a) α=0 baseline golden — the pure deterministic ODE
>   matches between native and WASM; (b) **α=1 on a committed trained-weight SafeTensors fixture**
>   (`native/domain-dialysis/tests/fixtures/parity_model.safetensors`) — loading the same weights
>   into native and WASM yields bit-identical trajectories. Tests: `native/.../tests/parity.rs`
>   (3 passing + 1 ignored generator) and `tests/liquid-parity.test.ts` (4 passing).
> - Determinism: native + wasm + whole-realm runs with the same (loaded weights, seed, timeline)
>   are bit-identical. Realm-level: two identical liquid realms produce identical patient traces.
> - **Important finding:** candle's CPU random init is unseeded (OS entropy), so a *random-init*
>   residual is not reproducible run-to-run. The realm therefore gates α=0 (baseline-only) until
>   trained weights exist; the learned path becomes deterministic the moment weights load from
>   disk. This is why the fixture (not random init) is the parity oracle.

1. **Native ↔ WASM parity test:** run the same model weights, same seed, same input sequence
   through the native `step` and the WASM `forecast`; assert bit-identical outputs.
   This is the *storage-layer-grade* extension of "no mocks in the path."
2. **Determinism test:** same weights + seed + timeline ⇒ identical realm trace (feeds the
   existing `replay`/`counterfactual` determinism guarantees).
3. **Acceptance:** parity + determinism tests land in `tests/liquid-parity.test.ts` and pass in CI.

### Phase 5 — Counterfactual rehearsal upgrade

> ✅ **Status (2026-08-15): implemented.**
> - Forks evolve under the liquid engine (realm built with `trajectoryEngine: 'liquid'`); a new
>   `event-effect` intervention biases the liquid trajectory's event features per patient
>   (`TrajectoryAmbientProcess.biasPatient`), e.g. fewer missed treatments / phosphate
>   violations vs. more sleep-disruption events.
> - **M24 promotion gates** added to `runCounterfactual`: `measureImproves` (mean Kt/V),
>   `noEquityRegression` (worst-off vitals-instability floor), `noPolicyViolation` (safety events).
>   Report gains `gates`, `promotable`, `gateReasons` + per-run `population` metrics.
> - `tryGetWasmSimulation()` lets the synchronous counterfactual ticks see a pre-loaded engine.
> - Acceptance `tests/liquid-counterfactual.test.ts` (4 passing): the M24 story — **gentle**
>   reminder improves the measure and is promotable; **insistent** reminder improves adherence
>   but degrades sleep-equity and is **refused** (reason surfaces "equity regression"); rehearsal
>   is deterministic.

1. Wire learned dynamics into `src/realm/counterfactual.ts`: each forked realm evolves under
   the liquid engine; an `intervention` maps to an anant-style `InterventionSpec` (effect deltas
   applied at fork time).
2. Add **gates** to the rehearsal selection layer (aligns with README M24): promote a variant
   only if (a) primary measure improves, (b) no equity metric regresses, (c) no policy violated.
3. **Acceptance:** `tests/liquid-counterfactual.test.ts` — a "phosphate-nudge" rehearsal shows
   adherence improving while sleep-equity regresses, and the system refuses to promote it
   (the README M24 acceptance story, now with learned dynamics).

### Phase 6 — Training pipeline

> ✅ **Status (2026-08-15): implemented.**
> - `native/liquid-train/src/main.rs` — CLI binary: trains CfC/LTC on the dialysis domain,
>   saves a SafeTensors artifact (`save_model`), and prints a JSON report (losses, final loss,
>   baseline MAE, trained MAE). Smoke-tested: loss 0.019→0.0004, trained MAE 0.0144 < baseline
>   0.0169. Committed a deterministic trained fixture `native/domain-dialysis/tests/fixtures/trained_model.safetensors`.
> - `src/liquid/trainer.ts` (`LiquidTrainer`) spawns `cargo run -p liquid-train` (injectable
>   runner for tests), reads the artifact, and promotes it into the store with metrics.
> - `LiquidModelStore` extended: `metrics` on records, `history()` / `promoteExisting()` /
>   `compare(domain)` (CfC vs LTC vs baseline MAE).
> - Routes: `GET /admin/liquid/models`, `POST /admin/liquid/train`, `POST /admin/liquid/promote`,
>   `GET /admin/liquid/compare`.
> - **Realm hot-swap proven:** promoting a trained model makes a new liquid realm run LEARNED
>   dynamics (α active, loaded weights) — its patient traces diverge from the baseline-only
>   realm (`tests/liquid-train.test.ts`, 4 passing).

1. `src/liquid/trainer.ts` spawns `cargo run -p liquid-train` with a `TrainRequest`
   (model_kind, epochs, lr, sequence params, seed) — mirroring anant's `training.rs` + DTO.
2. Persist run metadata + loss curves; add `/admin/liquid/train`, `/admin/liquid/promote`,
   `/admin/liquid/compare` (CfC vs LTC vs baseline-only held-out MAE).
3. **Acceptance:** a training run completes, produces a SafeTensors artifact, and promoting it
   hot-swaps the realm's active model (anant's `replace_model` pattern).

### Phase 7 — Admin UI

> ✅ **Status (2026-08-15): implemented.**
> - `src/liquid/forecast.ts` (`forecastPatient`) — the What-If core: runs the WASM engine
>   locally, forks from a patient's current liquid state, applies a one-shot intervention, and
>   returns a projected labs/vitals/risk timeseries (α=0 until trained). Tests: `tests/liquid-forecast.test.ts` (4).
> - Shared projection extracted to `src/liquid/project.ts` (used by both the realm trajectory
>   process and the forecast service — no drift).
> - Admin UI (`admin-ui/index.html`): **Liquid engine** nav section with **What-If forecast**
>   (in-browser WASM forecast + SVG chart + stat cards, zero round-trip) and **Training
>   workbench** (models/compare + Train CfC/LTC buttons). WASM bundle staged at `admin-ui/liquid/`.
> - Added `GET /admin/realms/:id/patients` and `POST /admin/realms` now accepts
>   `trajectoryEngine` (so API-created realms can run the liquid engine).
> - Verified in-browser against the live dev server (screenshot + Playwright): realm created,
>   8 patients with learned liquid state, forecast rendered locally.

1. Add a **Forecast / What-If panel** to `admin-ui`: pick a patient → `forkFrom(current state)` →
   run `forecast` **in-browser via the WASM bundle** (zero round-trip) → chart trajectory under
   each intervention.
2. Add a **Training Workbench** tab (loss curve stream, model comparison).
3. **Acceptance:** the panel renders a live trajectory chart computed locally; the network tab
   shows no forecast requests.

### Phase 8 — (Optional, deep) Liquid hypergraph mechanic

> ✅ **Status (2026-08-15): implemented (regime-detection slice).**
> - WASM now returns `residualMagnitude` per step (the divergence-from-baseline observable).
> - `src/liquid/regime.ts`: `RegimeDetector` (pure core) + `makeRegimeRule()` (a realm `TsRule`).
>   Observables: time-constant collapse (τ < 1h + high velocity → high-reactivity), critical
>   slowing down (an active-bad dim's recovery timescale blows up), divergence (residual > 0.15).
> - Realm wiring: when `trajectoryEngine: 'liquid'`, the realm auto-registers the regime rule;
>   regime transitions become `liquid.regime-change` Experiences agents perceive.
> - Tests: `tests/liquid-regime.test.ts` (5) — divergence / critical-slowing / high-reactivity /
>   stable unit cases + a realm that emits regime Experiences when a patient destabilizes.
> - Deeper slice (τ as a native per-vertex hypergraph mechanic feeding energy/attractors) is
>   future work beyond this phase.

- Promote from "an engine the realm calls" to a native mechanic per `liquid-ai.md`: per-vertex
  learned time constant τ in `src/hypergraph/`, regime-change observables (time-constant
  collapse, critical slowing down) feeding `src/realm/rules.ts` → Experiences → agent perception.
- **Acceptance:** an entity's *dynamical regime* (not just a threshold crossing) becomes an
  observable that agents can react to.
- Note: this is the differentiation play. Phases 1–7 deliver the capability; Phase 8 delivers
  the moat. Sequence it after the plumbing is proven.

### Phase 9 — Durable storage + M25 nudges + deep τ/CQL slice

> ✅ **Status (2026-08-15): implemented.**

Three front-ends landed together, designed so the storage layer is **swappable without
re-jigging the application**:

**A. SQLite storage with a dialect seam (durable local realms / models / billing).**
- `src/server/sql/sql-db.ts` — `SqlDb` interface (`run`/`all`/`exec`) with two adapters:
  `SqliteSqlDb` (lazy `createRequire('node:sqlite')` — bypasses Vite/vitest's resolver so the
  tests run the real driver) and `PostgresSqlDb` (pg `Pool`). `rewritePlaceholders` converts
  `?` → `$n` so the same portable SQL runs on both.
- `src/server/sql/schema.ts` — portable migrations (TEXT PKs, JSON-as-TEXT, ISO timestamps):
  `realm_snapshots`, `billing_usage`, `nudge_ledger`, `counterfactual_runs` + indexes.
- `src/server/sql/sql-store.ts` — `SqlStore` writes only portable SQL; every SELECT aliases
  snake_case → camelCase row types. `src/server/sql/index.ts` — `buildSqlDb()` from
  `HH_STORAGE`/`HH_DB_PATH` (default `.harness/data/harness.db`; `:memory:` in tests) and a
  lazily-opened `getSqlStore()` singleton.
- **Swap story:** swapping SQLite → Postgres is constructing a different `SqlDb`; the store,
  schema, routes, and tests never change.
- Wiring: `POST /admin/realms` and `/admin/realms/:id/tick` persist a realm snapshot; the
  billing meter read persists a `billing_usage` row; `POST /admin/counterfactual/run` mirrors
  each run into `counterfactual_runs` (alongside the in-memory studio store). Read routes:
  `GET /admin/sql/realms[:id]`, `GET /admin/sql/billing`, `GET /admin/sql/counterfactuals`.
  Tests: `tests/sql-store.test.ts` (3) + `tests/sql-routes.test.ts` (5).

**B. M25 ambient nudge delivery — the Nudge Ledger + real-world channels.**
- `src/realm/nudges.ts` — `NudgeLedger` (deliver → status lifecycle → observe), `NudgeChannel`
  adapters (`InAppNudgeChannel` is real: work-artifact + `nudge.delivered` perception;
  sms/email/calendar/fhir are swappable `StubNudgeChannel`s), and
  `sqliteNudgePersistence(store)` so every delivery/observation survives restarts.
- Routes: `POST /admin/nudges`, `GET /admin/nudges`, `POST /admin/nudges/:id/observe`.
  Tests: `tests/nudges.test.ts` (2).

**C. The deeper hypergraph slice — adaptive per-vertex τ + CQL scoring.**
- `src/liquid/regime.ts` now exports `computeEffectiveTau(prev, cur)` (min over dims of
  |x|/|Δx| — a per-tick effective time constant) and `tauDtFactor(tau)` (high-reactivity
  τ<2h advances 1.5×, sluggish τ>24h slows to 0.7×).
- `src/liquid/trajectory.ts` wires it as a **native mechanic**: each patient vertex tracks
  `liquid.tau` + `liquid.tauFactor`, and the previous tick's τ scales the next tick's evolution
  (fast vertices move faster, slow vertices slower) — deterministic, so realms still replay.
- `src/liquid/cql.ts` — **feed the learned labs into the real CQL measure evaluator**:
  `buildLabsBundle(patient)` builds a FHIR Bundle (Patient + K/HGB/URR/PHOS LOINC
  Observations + Essential-hypertension SNOMED 59621000 Condition), and `scoreLabs(evaluator,
  measureId, patients)` runs real cql-execution over it. Degrades to
  `{ scored:false, reason:'measure-store-not-loaded' }` when no measure repo is synced
  (`.harness/measures/` absent). Tests: `tests/liquid-tau.test.ts` (3) + `tests/liquid-cql.test.ts`
  (3 — a hypertensive patient lands in the m21 numerator through the full pipeline).
- `POST /admin/liquid/score` exposes it over HTTP.

**D. Dev CQL scoring — seeded measure store (no network).**
- `scripts/seed-measure-store.mjs` (→ `npm run measures:seed`) writes the local m21 fixture
  into `.harness/measures/m21-local/` in the exact `loadFromDisk` layout (manifest + measure
  with `raw.group` populations + library with base64 ELM) — so `/admin/liquid/score` returns
  **real** CQL results in dev without VSAC/GitHub. `.harness/measures/` is gitignored
  (regenerate on demand). Verified live: hypertensive patient → `numerator:true`, `met:true`.
- Note: `getMeasureEvaluator()` caches per process; reseed then restart the dev server to pick
  up a changed store.

**E. Admin UI redesign — shadcn/Tailwind + dark/light theme + icons.**
- `admin-ui/index.html` now uses the **Tailwind Play CDN** + a shadcn-style design system:
  CSS-variable tokens (mapped to Tailwind colors: `background`, `foreground`, `card`,
  `primary`, `muted`, `accent`, `destructive`, `success`, `warning`) with a `.dark` class
  variant, and `@layer components` shadcn component classes (`btn`, `btn-primary`,
  `stat-card`, `table-wrap`, `pill`, `detail`, `form-row`, …) via `@apply`.
- **Theme**: header `theme-toggle` button toggles `.dark` on `<html>`, persists to
  `localStorage.hh-theme`, respects `prefers-color-scheme`; a bootstrap script applies it
  before first paint (no FOUC).
- **Icons**: lucide via CDN; nav, buttons, and stat cards carry `data-lucide` icons,
  hydrated with `lucide.createIcons()` after every render (`hydrateIcons()`).
- **New panel**: `renderDurableStorage()` (`data-view="durable"`) — persisted realm
  snapshots / billing / counterfactual runs from `/admin/sql/*` + the swap story.

**F. Settings admin — master-data CRUD on SQLite.**
- Master-data entities: **Realm** (`realm_snapshots`), **Facility** → **Unit** → **Patient**,
  persisted in new portable `facilities`/`units`/`patients` tables (+ indexes) via the same
  `SqlStore`/`SqlDb` seam. `src/server/settings-routes.ts` exposes
  `GET/POST /admin/settings/{facilities,units,patients}` (+ `PUT/DELETE :id`) and
  `GET/DELETE /admin/settings/realms`.
- Creating a realm with a seed now auto-populates the master data (facility + units + patients
  from the graph).
- UI: an **Admin** button in the top header bar (plus a `Settings` nav item under System) opens
  a tabbed `renderSettings()` view (Facilities / Units / Patients / Realms) with add, edit,
  delete, and search. Build-a-world's Realm Id is now a searchable combobox (datalist of live
  realms; opens an existing realm or creates a new one).

---

## 5. WASM build & the `getrandom` trap (do this first)

`liquid-wasm/Cargo.toml` in anant documents this precisely. Two `getrandom` majors arrive
transitively (candle via `rand`/`rand_distr` 0.9 → getrandom 0.3; domain-kit wiring via
`rand_chacha` 0.3 → rand_core 0.6 → getrandom 0.2). On `wasm32-unknown-unknown` **both** must
point at the browser's crypto or an untrained model's initial weight init fails at wasm *runtime*
(not compile time). Required, carried into `native/liquid-wasm/Cargo.toml`:

```toml
getrandom  = { version = "0.2", features = ["js"] }
getrandom3 = { package = "getrandom", version = "0.3", features = ["wasm_js"] }
```

and `.cargo/config.toml` (the Cargo feature alone isn't enough for 0.3):

```toml
[build]
rustflags = ["--cfg", "getrandom_backend=\"wasm_js\""]
```

Build + copy (mirrors `web/package.json`'s `build:wasm`):

```bash
cd native/liquid-wasm
wasm-pack build --target web --out-dir pkg
# copy pkg/liquid_wasm_bg.wasm, pkg/liquid_wasm.js, pkg/liquid_wasm.d.ts → src/liquid/wasm/
```

---

## 6. State mapping & integration points

| Harness today (`src/realm/ambient.ts`) | After integration |
|---|---|
| `PatientTrajectoryProcess` — ±1–3 HR/SpO2 drift off a string label | `TrajectoryAmbientProcess` — learned ΔX per patient |
| `LabMaturationProcess.draw()` — `base ± random jitter` | lab values derived from learned state dims (K, HGB, URR, PHOS) |
| `realm.ts` default ambient set | adds `trajectory` process when `trajectoryEngine: 'liquid'` |
| `counterfactual.ts` — same baseline + preference nudges | forked realms evolve under liquid engine + `InterventionSpec` deltas |
| `rules.ts` static thresholds | + velocity/regime-change observer rules from the domain pack |
| admin UI realm tab | + Forecast (WASM what-if) + Training Workbench |

Every learned mutation stays an **ambient system effect**: ledgered (append-only), attributed,
and gated by the existing effect authority — liquid dynamics do **not** get a bypass.

---

## 7. Storage

- **Weights/artifacts:** SafeTensors files under `.harness/liquid/` (like `.harness/measures/`).
- **Active model, training runs, loss curves, forecasts:** rows in the store. This is the
  natural driver for the SQLite-first store discussed separately — a `liquid_models`,
  `liquid_train_runs`, `liquid_forecasts` table set. Persisting realm state (Phase 5/7) and
  model metadata should land together.
- Keep anant's pattern: model promotion must survive restart (load active model at boot).

---

## 8. Testing strategy

| Test | Location | Proves |
|---|---|---|
| Engine numerics + train-beats-baseline | `cargo test -p liquid-core` | engine correctness (inherited) |
| Dialysis baseline ODE + observer rules | `cargo test -p domain-dialysis` | domain correctness |
| Native ↔ WASM parity | `tests/liquid-parity.test.ts` | no drift, no mocks |
| Deterministic replay with learned dynamics | `tests/liquid-parity.test.ts` | frozen weights + seed ⇒ identical trace |
| Realm integration | `tests/liquid-realm.test.ts` | ambient process, effects ledgered, flag toggle |
| Counterfactual gates | `tests/liquid-counterfactual.test.ts` | M24 promote/discard with learned dynamics |
| Training + promote hot-swap | `tests/liquid-train.test.ts` | artifact lifecycle |

Keep training as an opt-in/slow test; keep parity + determinism in the default `npm test` path.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| WASM `getrandom` runtime failure | Phase 0 probe build first; §5 config carried verbatim |
| Autograd memory growth (hidden chaining) | carry the `hidden.detach()` pattern from `tick_domain` into WASM forecast |
| Native ↔ WASM drift | Phase 4 parity test; single source of truth in Rust |
| Breaking deterministic replay | frozen weights + fixed seed per realm; determinism test; legacy flag |
| Dialysis domain re-authoring scope | Phase 2 isolated; reuse harness seeding; ship baseline-only first, residual second |
| Candle dep weight in CI | native workspace isolated from `npm install`; separate CI job |
| Training cost in tests | opt-in slow suite; small model config in CI |

---

## 10. Milestones (definition of done)

- **M1 (Phase 0–1):** engine vendored; `cargo test -p liquid-core` green; wasm build probe green.
- **M2 (Phase 2–3):** ✅ dialysis domain + WASM bindings; `TrajectoryAmbientProcess` behind a
  flag; realm runs learned trajectories.
- **M3 (Phase 4–5):** ✅ parity + determinism tests; counterfactual rehearsal runs learned dynamics
  with promotion gates (M24 gentle/insistent acceptance).
- **M4 (Phase 6–7):** ✅ done — training + promote + compare + realm hot-swap (6) and admin UI
  What-If forecast + training workbench (7).
- **M5 (Phase 8, optional):** ✅ liquid dynamics as a hypergraph mechanic — regime-change
  observables (τ collapse, critical slowing down, divergence) feeding the realm rules engine.
