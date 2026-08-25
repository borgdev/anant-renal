/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

//! Native↔WASM parity golden vectors (Phase 4).
//!
//! Replicates the WASM `WasmSimulation::advance` math (baseline ODE + CfC residual, clamped)
//! natively, for a fixed model init + event sequence. The golden outputs below must match the
//! WASM bundle's `stepWithEvents` for the same inputs (`tests/liquid-parity.test.ts`), proving
//! "no mocks in the path" — the same Rust code compiled to both targets, no drift.
//!
//! Determinism note: candle's CPU random init is unseeded (OS entropy), so a *random-init*
//! model is not reproducible run-to-run — the realm gates α to 0 (baseline-only) until trained
//! weights exist. The learned path becomes deterministic the moment weights are loaded from a
//! SafeTensors file, which is exactly what `trained_weights_golden_alpha1` pins.

use candle_core::{DType, Device, Tensor};
use candle_nn::{VarBuilder, VarMap};
use domain_dialysis::DialysisDomain;
use domain_kit::DomainPack;
use liquid_core::{Cfc, LiquidModel};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/parity_model.safetensors");

/// One replica of the WASM advance: 24 hourly ticks over a repeating event pattern
/// (missed → phos-violation → calm), CfC residual scaled by `alpha`, state clamped.
fn step_sequence(model: &LiquidModel, pack: &DialysisDomain, alpha: f32, steps: usize) -> Vec<f32> {
    let device = Device::Cpu;
    let schema = pack.state_schema();
    let mut state = pack.initial_state();
    let mut hidden = model.zero_state(1, &device, DType::F32).unwrap();

    for i in 0..steps {
        let event: Vec<f32> = match i % 3 {
            0 => vec![1.0, 0.0, 0.0, 0.0, 0.0], // missed_treatment
            1 => vec![0.0, 0.0, 0.0, 0.0, 1.0], // diet_phosphate_violation
            _ => vec![0.0; 5],                 // calm
        };
        let baseline_delta = pack.baseline().delta(&state, &event, 1.0);
        let input = Tensor::from_vec(event, (1, 5), &device).unwrap();
        let dt_tensor = Tensor::from_vec(vec![1.0f32], (1, 1), &device).unwrap();
        let step_out = model.step(&input, &hidden, &dt_tensor).unwrap();
        hidden = step_out.hidden.detach();
        let residual: Vec<f32> = step_out.prediction.flatten_all().unwrap().to_vec1().unwrap();
        for (i, r) in residual.iter().enumerate() {
            state[i] += baseline_delta[i] + alpha * r;
        }
        schema.clamp(&mut state);
    }
    state
}

fn run_fresh(alpha: f32, steps: usize) -> Vec<f32> {
    let pack = DialysisDomain::default();
    let device = Device::Cpu;
    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DType::F32, &device);
    let model: LiquidModel = Cfc::new(pack.cfc_config(), vb).unwrap().into();
    step_sequence(&model, &pack, alpha, steps)
}

fn run_fixture(alpha: f32, steps: usize) -> Vec<f32> {
    let pack = DialysisDomain::default();
    let device = Device::Cpu;
    let bytes = std::fs::read(FIXTURE).expect("parity fixture missing — run the ignored regenerate_fixture test once");
    let vb = VarBuilder::from_buffered_safetensors(bytes, DType::F32, &device).expect("load fixture");
    let model: LiquidModel = Cfc::new(pack.cfc_config(), vb).unwrap().into();
    step_sequence(&model, &pack, alpha, steps)
}

const ALPHA0_GOLDEN: [f32; 5] = [0.043798365, 0.7189349, 0.43466473, 0.7349391, 0.40493095];
// From `cargo test -p domain-dialysis --test parity -- --ignored --nocapture regenerate_fixture`.
const FIXTURE_GOLDEN: [f32; 5] = [1.0, 0.07914606, 0.3338799, 0.0, 0.068443865];

#[test]
fn baseline_golden_alpha0() {
    // α=0 is the pure deterministic baseline ODE — no model weights involved, so this is the
    // cross-target "pipeline no-drift" guarantee (must match `tests/liquid-parity.test.ts`).
    let state = run_fresh(0.0, 24);
    for (got, want) in state.iter().zip(ALPHA0_GOLDEN.iter()) {
        assert!((got - want).abs() < 1e-5, "alpha0 golden drift: got {got}, want {want}");
    }
}

#[test]
fn trained_weights_golden_alpha1() {
    // α=1 on the committed trained-weight fixture — the real learned path. Loading the same
    // SafeTensors into native and wasm must give identical trajectories (see vitest parity).
    let state = run_fixture(1.0, 24);
    for (got, want) in state.iter().zip(FIXTURE_GOLDEN.iter()) {
        assert!((got - want).abs() < 1e-5, "fixture alpha1 golden drift: got {got}, want {want}");
    }
}

#[test]
fn loaded_weights_are_deterministic() {
    let a = run_fixture(1.0, 24);
    let b = run_fixture(1.0, 24);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x, y, "loaded-weight runs must be bit-identical");
    }
}

/// One-time fixture generator: builds a fresh random CfC, saves its weights to
/// `tests/fixtures/parity_model.safetensors`, and prints the α=1 golden so it can be embedded
/// in `FIXTURE_GOLDEN` (and mirrored in `tests/liquid-parity.test.ts`). Commit the generated
/// file — do not re-run (candle's CPU init is unseeded, so regenerating yields a new model).
#[test]
#[ignore = "regenerates the committed fixture — run explicitly with --ignored --nocapture"]
fn regenerate_fixture() {
    let pack = DialysisDomain::default();
    let device = Device::Cpu;
    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DType::F32, &device);
    let model: LiquidModel = Cfc::new(pack.cfc_config(), vb).unwrap().into();
    let dir = std::path::Path::new(FIXTURE).parent().unwrap();
    std::fs::create_dir_all(dir).unwrap();
    varmap.save(FIXTURE).unwrap();
    eprintln!("FIXTURE_GOLDEN={:?}", step_sequence(&model, &pack, 1.0, 24));
}
