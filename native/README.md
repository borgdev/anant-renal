# native/ — Liquid (CfC/LTC) engine

Rust workspace embedding the **Closed-form Continuous-time (CfC)** and **Liquid Time-constant
(LTC)** engine from the `anant-cfc` demo, so the healthcare-harness owns the trajectory
dynamics it simulates with. Rust owns all numerics; the TypeScript layer calls the same code
compiled to WASM (never a JS reimplementation), preserving the "no mocks in the path" /
no-drift invariant.

## Provenance

- **Source:** `anant-cfc` workspace, `crates/liquid-core`, `crates/liquid-train`,
  `crates/domain-kit`, `crates/domain-packs/healthcare`, `crates/liquid-wasm`.
- **Embedded on:** 2026-08-15.
- **Engine design spec:** `docs/liquid-engine-integration.md` (this repo) and `liquid-ai.md`
  (upstream).
- **Trim:** non-healthcare domain packs (cyber, churn, iot, fraud, industrial) were dropped.
  `liquid-wasm` binds only the healthcare domain for now; the dialysis domain (`domain-dialysis`)
  replaces it in a later phase.

## Layout

```
liquid-core/        inference engine (CfC + LTC), wasm-buildable, no training
liquid-train/       training (AdamW, gradient clip, synthetic datasets) — native only
domain-kit/         schema/rule/intervention/population traits
domain-healthcare/  post-op deterioration domain (seed pack, from anant-cfc)
domain-dialysis/    dialysis domain pack (Kt/V, phosphate, anemia, deterioration) — Phase 2
liquid-wasm/        wasm-bindgen bindings (WasmSimulation: new/forkFrom/forecast)
```

## Commands

```bash
cargo build --workspace            # native build
cargo test  --workspace            # engine numerics + training-beats-baseline tests
# wasm build (needs wasm32-unknown-unknown + wasm-pack):
cd liquid-wasm && wasm-pack build --target web --out-dir pkg
```
