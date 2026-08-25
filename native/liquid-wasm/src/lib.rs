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

//! WASM bindings around `liquid-core`'s inference path plus the domain pack's baseline
//! dynamics + scenario generator, compiled to `wasm32-unknown-unknown`. This is
//! deliberately the *same* Rust code the server runs — not a JS reimplementation — so a
//! browser-local "what if" forecast can't drift from what the server would actually compute.
//!
//! No training here: this crate depends only on `liquid-core` (never `liquid-train`), keeping
//! the wasm bundle inference-only per liquid-ai.md §69's training/inference split.

use std::collections::HashMap;

use candle_core::{DType, Device, Tensor};
use candle_nn::{VarBuilder, VarMap};
use domain_dialysis::{DialysisDomain, DOMAIN_ID};
use domain_kit::DomainPack;
use liquid_core::{Cfc, LiquidModel, Ltc};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn build_pack(domain_id: &str) -> Option<Box<dyn DomainPack>> {
    match domain_id {
        DOMAIN_ID => Some(Box::new(DialysisDomain::default())),
        _ => None,
    }
}

fn build_model(pack: &dyn DomainPack, model_kind: &str, vb: VarBuilder, seed: u64) -> candle_core::Result<LiquidModel> {
    Ok(match model_kind {
        "ltc" => Ltc::new(pack.ltc_config(), vb, seed)?.into(),
        _ => Cfc::new(pack.cfc_config(), vb)?.into(),
    })
}

fn to_js_err(err: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&err.to_string())
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
struct ForecastTick {
    t: f32,
    stage: String,
    state: HashMap<String, f32>,
    /// α-scaled L2 magnitude of the learned residual — the "how far from baseline" signal the
    /// regime detector uses as a dynamics-divergence observable.
    residual_magnitude: f32,
}

/// A single entity's local simulation: same baseline ODE + scenario generator + CfC/LTC
/// residual pipeline as `server::sim::tick_domain`, run entirely in the browser.
#[wasm_bindgen]
pub struct WasmSimulation {
    pack: Box<dyn DomainPack>,
    model: LiquidModel,
    scenario: Box<dyn domain_kit::ScenarioGenerator>,
    state: Vec<f32>,
    hidden: Tensor,
    t: f32,
    device: Device,
    residual_alpha: f32,
}

#[wasm_bindgen]
impl WasmSimulation {
    /// `weights`: raw SafeTensors bytes for a trained model, or an empty slice for a fresh
    /// (randomly-initialized) model — matching what the server does for a domain with nothing
    /// promoted yet.
    #[wasm_bindgen(constructor)]
    pub fn new(domain_id: &str, model_kind: &str, weights: &[u8], seed: f64) -> Result<WasmSimulation, JsValue> {
        let pack = build_pack(domain_id).ok_or_else(|| JsValue::from_str(&format!("unknown domain: {domain_id}")))?;
        let device = Device::Cpu;
        let seed = seed as u64;

        let model: LiquidModel = if weights.is_empty() {
            let varmap = VarMap::new();
            let vb = VarBuilder::from_varmap(&varmap, DType::F32, &device);
            build_model(pack.as_ref(), model_kind, vb, seed).map_err(to_js_err)?
        } else {
            let vb = VarBuilder::from_buffered_safetensors(weights.to_vec(), DType::F32, &device).map_err(to_js_err)?;
            build_model(pack.as_ref(), model_kind, vb, seed).map_err(to_js_err)?
        };

        let hidden = model.zero_state(1, &device, DType::F32).map_err(to_js_err)?;
        let scenario = pack.new_scenario(seed);
        let state = pack.initial_state();
        let residual_alpha = pack.residual_alpha();

        Ok(WasmSimulation { pack, model, scenario, state, hidden, t: 0.0, device, residual_alpha })
    }

    /// Override the residual weight `α` in `ΔX_final = ΔX_baseline + α·R_θ`. The harness runs
    /// `α = 0` (baseline-only, deterministic) until trained weights are promoted, then restores
    /// the pack's default so the learned residual is active.
    #[wasm_bindgen(js_name = setResidualAlpha)]
    pub fn set_residual_alpha(&mut self, alpha: f32) {
        self.residual_alpha = alpha;
    }

    /// Forks the local simulation to a specific point — typically the live server's current
    /// state for the entity being explored — so forecasts start from "now," not a cold entity.
    /// `state_json`: `{"<dim_key>": <value>, ...}`.
    #[wasm_bindgen(js_name = forkFrom)]
    pub fn fork_from(&mut self, state_json: &str, t: f32) -> Result<(), JsValue> {
        let state_map: HashMap<String, f32> = serde_json::from_str(state_json).map_err(to_js_err)?;
        let schema = self.pack.state_schema();
        let mut state = vec![0.0; schema.len()];
        for (i, dim) in schema.dimensions.iter().enumerate() {
            state[i] = *state_map.get(&dim.key).unwrap_or(&0.0);
        }
        self.state = state;
        self.t = t;
        self.hidden = self.model.zero_state(1, &self.device, DType::F32).map_err(to_js_err)?;
        Ok(())
    }

    /// Advance one tick by `dt` seconds given an explicit event-feature vector
    /// (event-feature-schema-ordered). Shared by `forecast` (events from the internal seeded
    /// scenario) and `stepWithEvents` (events from an external caller, e.g. the harness
    /// realm's effect ledger). Hidden state is detached every step so the autograd graph never
    /// chains across the entity's lifetime (same pattern as `server::sim::tick_domain`).
    fn advance(&mut self, event: &[f32], dt: f32) -> Result<ForecastTick, JsValue> {
        let schema = self.pack.state_schema();
        self.t += dt;
        let baseline_delta = self.pack.baseline().delta(&self.state, event, dt);

        let n_features = event.len();
        let input = Tensor::from_vec(event.to_vec(), (1, n_features), &self.device).map_err(to_js_err)?;
        let dt_tensor = Tensor::from_vec(vec![dt], (1, 1), &self.device).map_err(to_js_err)?;

        let step_out = self.model.step(&input, &self.hidden, &dt_tensor).map_err(to_js_err)?;
        // Detach: model params are variable (for training), so feeding hidden forward without
        // detaching chains the autograd graph across the entity's whole lifetime — unbounded
        // memory growth for a realm ticking thousands of times.
        self.hidden = step_out.hidden.detach();
        let residual = step_out.prediction.flatten_all().and_then(|t| t.to_vec1::<f32>()).map_err(to_js_err)?;

        let alpha = self.residual_alpha;
        let residual_magnitude = residual.iter().map(|r| (alpha * r).powi(2)).sum::<f32>().sqrt();
        for i in 0..self.state.len() {
            self.state[i] += baseline_delta[i] + alpha * residual[i];
        }
        schema.clamp(&mut self.state);

        Ok(ForecastTick {
            t: self.t,
            stage: self.scenario.stage_label().to_string(),
            state: schema.as_map(&self.state),
            residual_magnitude,
        })
    }

    /// Advances `steps` ticks of `dt` seconds each, optionally applying an intervention's
    /// effect once at the start (`intervention_json`: `[["dim", delta], ...]`, matching
    /// `InterventionSpec::effect` — pass `"[]"` for none). Returns a JSON array of
    /// `{t, stage, state}`, one entry per tick — computed entirely locally, no network
    /// round-trip.
    pub fn forecast(&mut self, steps: usize, dt: f32, intervention_json: &str) -> Result<String, JsValue> {
        let schema = self.pack.state_schema();

        let effect: Vec<(String, f32)> = serde_json::from_str(intervention_json).map_err(to_js_err)?;
        for (key, delta) in &effect {
            if let Some(i) = schema.index_of(key) {
                self.state[i] += delta;
            }
        }
        if !effect.is_empty() {
            schema.clamp(&mut self.state);
        }

        let mut ticks = Vec::with_capacity(steps);
        for _ in 0..steps {
            // Event computed at the post-advance time, matching the original tick ordering.
            let event = self.scenario.next_event(self.t + dt, dt);
            ticks.push(self.advance(&event, dt)?);
        }

        serde_json::to_string(&ticks).map_err(to_js_err)
    }

    /// Advance a single tick driven by an **external** event-feature vector (rather than the
    /// internal seeded scenario) — this is how the harness realm drives patient trajectories
    /// from its effect ledger. `event_json`: `[<feature>, ...]` in event-feature-schema order.
    /// Returns `{"t", "stage", "state": {<dim_key>: value}}`.
    #[wasm_bindgen(js_name = stepWithEvents)]
    pub fn step_with_events(&mut self, event_json: &str, dt: f32) -> Result<String, JsValue> {
        let event: Vec<f32> = serde_json::from_str(event_json).map_err(to_js_err)?;
        let tick = self.advance(&event, dt)?;
        serde_json::to_string(&tick).map_err(to_js_err)
    }
}
