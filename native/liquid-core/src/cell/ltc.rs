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

use candle_core::{DType, Device, Result, Tensor};
use candle_nn::{Init, VarBuilder};

use super::ContinuousTimeCell;
use crate::activation::{sigmoid, softplus};
use crate::config::{LtcConfig, OdeSolverKind};
use crate::mapping::FeatureMap;
use crate::wiring;

/// Conductance-based Liquid Time-Constant cell (liquid-ai.md §14-19).
///
/// The continuous-time dynamics for hidden state `v` (per neuron `i`):
///
/// ```text
/// dv_i/dt = [ gleak_i·(vleak_i − v_i)
///           + Σ_j  act_rec[j,i](v_j)·(erev_rec[j,i] − v_i)
///           + Σ_k  act_sens[k,i](x_k)·(erev_sens[k,i] − v_i) ] / cm_i
/// ```
///
/// where `act(x) = W·sigmoid(σ·(x−μ))` is the (masked, positive-constrained) synaptic
/// activation. [`OdeSolverKind::SemiImplicitEuler`] solves the linear-in-`v` part of this
/// implicitly each of `ode_unfolds` sub-steps (freezing the nonlinear activation at the
/// previous sub-step), which is what makes the stiff conductance ODE tractable at large
/// `Δt` without the sub-stepping blowing up; `Euler`/`Rk4` are explicit references.
///
/// Not validated against the Python `ncps` reference implementation (liquid-ai.md §54) — no
/// Python/torch environment was available while building this. Validated instead by internal
/// consistency: finite outputs across the `Δt ∈ {0, 1, 10, 100, 1000}` range, solvers agreeing
/// at small `Δt`, and `ode_unfolds` refinement converging. Treat as unverified against the
/// reference until that gap is closed.
pub struct LtcCell {
    config: LtcConfig,

    input_map: FeatureMap,

    gleak_raw: Tensor,
    vleak: Tensor,
    cm_raw: Tensor,

    w_raw: Tensor,
    sigma_raw: Tensor,
    mu: Tensor,
    erev: Tensor,
    recurrent_mask: Tensor,

    sensory_w_raw: Tensor,
    sensory_sigma_raw: Tensor,
    sensory_mu: Tensor,
    sensory_erev: Tensor,
    sensory_mask: Tensor,
}

/// `gleak`/`cm`/masked `w`/`sigma`, softplus'd (and masked) from raw params — depend only on
/// the model's weights, never on `v`/batch/Δt, so they're computed once per `step()` call and
/// shared (read-only) across every `ode_unfolds` sub-step and every batch-parallel chunk,
/// instead of being recomputed from scratch on every sub-step (previously up to `4×ode_unfolds`
/// times per call, for the RK4 solver's 4 `dvdt` evaluations per sub-step).
struct RecurrentWeights {
    gleak: Tensor,
    cm: Tensor,
    w: Tensor,
    sigma: Tensor,
}

/// Below this many rows, a batch chunk runs on the spawning thread — splitting a handful of
/// rows across cores loses to thread spawn/join overhead rather than beating it.
const MIN_CHUNK: usize = 64;

impl LtcCell {
    pub fn new(config: LtcConfig, vb: VarBuilder, seed: u64) -> Result<Self> {
        let h = config.hidden_size;
        let i = config.input_size;
        let device = vb.device().clone();

        let input_map = FeatureMap::new(config.input_mapping, i, vb.pp("input_map"))?;

        let gleak_raw = vb.get_with_hints(h, "gleak_raw", Init::Const(0.5))?;
        let vleak = vb.get_with_hints(h, "vleak", Init::Uniform { lo: -0.2, up: 0.2 })?;
        let cm_raw = vb.get_with_hints(h, "cm_raw", Init::Const(0.5))?;

        let w_raw = vb.get_with_hints((h, h), "w_raw", Init::Uniform { lo: -1.0, up: 1.0 })?;
        let sigma_raw = vb.get_with_hints((h, h), "sigma_raw", Init::Const(0.5))?;
        let mu = vb.get_with_hints((h, h), "mu", Init::Uniform { lo: -0.3, up: 0.3 })?;
        let erev = vb.get_with_hints((h, h), "erev", Init::Uniform { lo: -1.0, up: 1.0 })?;

        let sensory_w_raw = vb.get_with_hints((i, h), "sensory_w_raw", Init::Uniform { lo: -1.0, up: 1.0 })?;
        let sensory_sigma_raw = vb.get_with_hints((i, h), "sensory_sigma_raw", Init::Const(0.5))?;
        let sensory_mu = vb.get_with_hints((i, h), "sensory_mu", Init::Uniform { lo: -0.3, up: 0.3 })?;
        let sensory_erev = vb.get_with_hints((i, h), "sensory_erev", Init::Uniform { lo: -1.0, up: 1.0 })?;

        let recurrent_mask = wiring::generate_mask(&config.wiring, h, h, false, seed, &device)?;
        let sensory_mask = wiring::generate_mask(&config.wiring, i, h, true, seed.wrapping_add(1), &device)?;

        Ok(Self {
            config,
            input_map,
            gleak_raw,
            vleak,
            cm_raw,
            w_raw,
            sigma_raw,
            mu,
            erev,
            recurrent_mask,
            sensory_w_raw,
            sensory_sigma_raw,
            sensory_mu,
            sensory_erev,
            sensory_mask,
        })
    }

    pub fn config(&self) -> &LtcConfig {
        &self.config
    }

    fn gleak(&self) -> Result<Tensor> {
        softplus(&self.gleak_raw)?.affine(1.0, self.config.epsilon)
    }

    fn cm(&self) -> Result<Tensor> {
        softplus(&self.cm_raw)?.affine(1.0, self.config.epsilon)
    }

    fn masked_w(&self) -> Result<Tensor> {
        softplus(&self.w_raw)?.mul(&self.recurrent_mask)
    }

    fn masked_sensory_w(&self) -> Result<Tensor> {
        softplus(&self.sensory_w_raw)?.mul(&self.sensory_mask)
    }

    fn compute_recurrent_weights(&self) -> Result<RecurrentWeights> {
        Ok(RecurrentWeights {
            gleak: self.gleak()?,
            cm: self.cm()?,
            w: self.masked_w()?,
            sigma: softplus(&self.sigma_raw)?.affine(1.0, self.config.epsilon)?,
        })
    }

    /// `x`: `[batch, input_size]`. Returns `(numerator, denominator)` contributions from the
    /// sensory synapses, each `[batch, hidden_size]` — constant for the whole `step()` call
    /// since the input doesn't change across `ode_unfolds` sub-steps.
    fn sensory_terms(&self, x: &Tensor) -> Result<(Tensor, Tensor)> {
        let sigma = softplus(&self.sensory_sigma_raw)?.affine(1.0, self.config.epsilon)?;
        let w = self.masked_sensory_w()?;

        let x_expand = x.unsqueeze(2)?; // [B, I, 1]
        let mu_e = self.sensory_mu.unsqueeze(0)?; // [1, I, H]
        let sigma_e = sigma.unsqueeze(0)?;
        let w_e = w.unsqueeze(0)?;
        let erev_e = self.sensory_erev.unsqueeze(0)?;

        let diff = x_expand.broadcast_sub(&mu_e)?; // [B, I, H]
        let arg = sigma_e.broadcast_mul(&diff)?;
        let act = sigmoid(&arg)?.broadcast_mul(&w_e)?; // [B, I, H]
        let rev = act.broadcast_mul(&erev_e)?;

        let numerator = rev.sum(1)?; // [B, H]
        let denominator = act.sum(1)?;
        Ok((numerator, denominator))
    }

    /// `v`: `[batch, hidden_size]`. Returns `(numerator, denominator)` from the recurrent
    /// synapses at the current sub-step's `v` (must be recomputed every sub-step, unlike the
    /// sensory terms) — `weights` supplies the batch-independent `sigma`/`w`.
    fn recurrent_terms(&self, v: &Tensor, weights: &RecurrentWeights) -> Result<(Tensor, Tensor)> {
        let v_expand = v.unsqueeze(2)?; // [B, H(j), 1]
        let mu_e = self.mu.unsqueeze(0)?; // [1, H(j), H(i)]
        let sigma_e = weights.sigma.unsqueeze(0)?;
        let w_e = weights.w.unsqueeze(0)?;
        let erev_e = self.erev.unsqueeze(0)?;

        let diff = v_expand.broadcast_sub(&mu_e)?; // [B, H(j), H(i)]
        let arg = sigma_e.broadcast_mul(&diff)?;
        let act = sigmoid(&arg)?.broadcast_mul(&w_e)?;
        let rev = act.broadcast_mul(&erev_e)?;

        let numerator = rev.sum(1)?; // [B, H(i)]
        let denominator = act.sum(1)?;
        Ok((numerator, denominator))
    }

    /// `dv/dt` at state `v`, given precomputed sensory terms — used by the explicit solvers.
    fn dvdt(&self, v: &Tensor, sensory_num: &Tensor, sensory_denom: &Tensor, weights: &RecurrentWeights) -> Result<Tensor> {
        let (rec_num, rec_den) = self.recurrent_terms(v, weights)?;

        let leak = weights.gleak.broadcast_mul(&self.vleak.broadcast_sub(v)?)?;
        let rec_current = (&rec_num - &rec_den.broadcast_mul(v)?)?;
        let sensory_current = (sensory_num - &sensory_denom.broadcast_mul(v)?)?;

        let total = leak.broadcast_add(&rec_current)?.broadcast_add(&sensory_current)?;
        total.broadcast_div(&weights.cm)
    }

    fn semi_implicit_step(
        &self,
        v: &Tensor,
        sensory_num: &Tensor,
        sensory_denom: &Tensor,
        dt_sub: &Tensor,
        weights: &RecurrentWeights,
    ) -> Result<Tensor> {
        let (rec_num, rec_den) = self.recurrent_terms(v, weights)?;

        let cm_t = weights.cm.broadcast_div(dt_sub)?; // [B, H]
        let gleak_vleak = (&weights.gleak * &self.vleak)?; // [H]

        let numerator = cm_t
            .broadcast_mul(v)?
            .broadcast_add(&gleak_vleak)?
            .broadcast_add(&rec_num)?
            .broadcast_add(sensory_num)?;
        let denominator = cm_t.broadcast_add(&weights.gleak)?.broadcast_add(&rec_den)?.broadcast_add(sensory_denom)?;

        numerator.div(&denominator)
    }

    fn euler_step(
        &self,
        v: &Tensor,
        sensory_num: &Tensor,
        sensory_denom: &Tensor,
        dt_sub: &Tensor,
        weights: &RecurrentWeights,
    ) -> Result<Tensor> {
        let dv = self.dvdt(v, sensory_num, sensory_denom, weights)?;
        v.broadcast_add(&dv.broadcast_mul(dt_sub)?)
    }

    fn rk4_step(&self, v: &Tensor, sensory_num: &Tensor, sensory_denom: &Tensor, dt_sub: &Tensor, weights: &RecurrentWeights) -> Result<Tensor> {
        let half_dt = dt_sub.affine(0.5, 0.0)?;

        let k1 = self.dvdt(v, sensory_num, sensory_denom, weights)?;
        let v2 = v.broadcast_add(&k1.broadcast_mul(&half_dt)?)?;
        let k2 = self.dvdt(&v2, sensory_num, sensory_denom, weights)?;
        let v3 = v.broadcast_add(&k2.broadcast_mul(&half_dt)?)?;
        let k3 = self.dvdt(&v3, sensory_num, sensory_denom, weights)?;
        let v4 = v.broadcast_add(&k3.broadcast_mul(dt_sub)?)?;
        let k4 = self.dvdt(&v4, sensory_num, sensory_denom, weights)?;

        let sum = k1.add(&k2.affine(2.0, 0.0)?)?.add(&k3.affine(2.0, 0.0)?)?.add(&k4)?;
        v.broadcast_add(&sum.broadcast_mul(&dt_sub.affine(1.0 / 6.0, 0.0)?)?)
    }

    /// Runs the full `ode_unfolds` sub-step loop for one batch chunk (`input` already through
    /// `input_map`). Split out from `step()` so batch-parallel chunks can each call this
    /// independently on their own slice of the batch.
    fn integrate(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor, weights: &RecurrentWeights) -> Result<Tensor> {
        let (sensory_num, sensory_denom) = self.sensory_terms(input)?;

        let unfolds = self.config.ode_unfolds.max(1);
        // Floor dt_sub at epsilon: at Δt=0 the semi-implicit solver would otherwise divide by
        // zero (cm/dt_sub → ∞), which is the §57 "zero elapsed time must never produce NaN/Inf"
        // requirement in practice.
        let epsilon = self.config.epsilon;
        let dt_sub_raw = delta_t.affine(1.0 / unfolds as f64, 0.0)?;
        let dt_sub = dt_sub_raw.affine(1.0, -epsilon)?.relu()?.affine(1.0, epsilon)?;

        let mut v = hidden.clone();
        for _ in 0..unfolds {
            v = match self.config.solver {
                OdeSolverKind::SemiImplicitEuler => self.semi_implicit_step(&v, &sensory_num, &sensory_denom, &dt_sub, weights)?,
                OdeSolverKind::Euler => self.euler_step(&v, &sensory_num, &sensory_denom, &dt_sub, weights)?,
                OdeSolverKind::Rk4 => self.rk4_step(&v, &sensory_num, &sensory_denom, &dt_sub, weights)?,
            };
        }

        Ok(v)
    }

    /// Default thread cap, below `available_parallelism()` on machines with more logical
    /// threads than this. Empirically: on the dev box (AMD Ryzen 9 3900X, 12 cores / 24 SMT
    /// threads), capping at 16 beat using all 24 both on mean throughput and on run-to-run
    /// variance, repeatably, under real contention (3/3 trials) — using every SMT sibling
    /// thread for this memory-bandwidth-bound workload adds contention for shared L1/L2/memory
    /// bandwidth rather than real parallelism. This constant is that empirical finding, not a
    /// derived formula (e.g. "2/3 of logical count") — it hasn't been validated on other core
    /// counts or microarchitectures, so revisit it before trusting it on different hardware.
    const DEFAULT_MAX_THREADS: usize = 16;

    /// Thread cap for batch-parallel chunking — [`Self::DEFAULT_MAX_THREADS`] by default
    /// (capped further to `available_parallelism()` on smaller machines), overridable via
    /// `LIQUID_LTC_THREADS` for tuning experiments on other hardware.
    fn max_threads() -> usize {
        static MAX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        *MAX.get_or_init(|| {
            let available = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
            std::env::var("LIQUID_LTC_THREADS")
                .ok()
                .and_then(|s| s.parse().ok())
                .filter(|&n: &usize| n > 0)
                .unwrap_or_else(|| available.min(Self::DEFAULT_MAX_THREADS))
        })
    }

    /// Batch-parallel chunk plan: `(start, len)` pairs covering `0..batch`, split across up to
    /// [`Self::max_threads`]. Below [`MIN_CHUNK`] rows total, returns a single chunk covering
    /// the whole batch (no parallelism — not worth the overhead).
    fn batch_chunks(batch: usize) -> Vec<(usize, usize)> {
        let available = Self::max_threads();
        let n_chunks = (batch / MIN_CHUNK).clamp(1, available);
        if n_chunks <= 1 {
            return vec![(0, batch)];
        }
        let base = batch / n_chunks;
        let remainder = batch % n_chunks;
        let mut chunks = Vec::with_capacity(n_chunks);
        let mut start = 0;
        for i in 0..n_chunks {
            let len = base + usize::from(i < remainder);
            chunks.push((start, len));
            start += len;
        }
        chunks
    }
}

impl ContinuousTimeCell for LtcCell {
    type State = Tensor;

    fn hidden_size(&self) -> usize {
        self.config.hidden_size
    }

    fn zero_state(&self, batch: usize, device: &Device, dtype: DType) -> Result<Tensor> {
        Tensor::zeros((batch, self.config.hidden_size), dtype, device)
    }

    /// Batch-parallel across CPU cores: every op in `integrate` is independent per batch row
    /// (no cross-entity coupling anywhere in the recurrent/sensory synapse math), but candle's
    /// CPU elementwise backend is single-threaded — so at large batch, the full
    /// `[batch, hidden, hidden]` synapse computation otherwise runs on one core regardless of
    /// how many are available. `weights` is computed once here and shared read-only across
    /// every chunk and every `ode_unfolds` sub-step inside `integrate`.
    fn step(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<(Tensor, Tensor)> {
        let input = self.input_map.apply(input)?;
        let weights = self.compute_recurrent_weights()?;
        let batch = hidden.dims()[0];
        let chunks = Self::batch_chunks(batch);

        let v = if chunks.len() <= 1 {
            self.integrate(&input, hidden, delta_t, &weights)?
        } else {
            let chunk_tensors: Result<Vec<(Tensor, Tensor, Tensor)>> = chunks
                .iter()
                .map(|&(start, len)| -> Result<(Tensor, Tensor, Tensor)> {
                    Ok((input.narrow(0, start, len)?, hidden.narrow(0, start, len)?, delta_t.narrow(0, start, len)?))
                })
                .collect();
            let chunk_tensors = chunk_tensors?;

            let weights_ref = &weights;
            let parts: Vec<Tensor> = std::thread::scope(|scope| -> Result<Vec<Tensor>> {
                let handles: Vec<_> = chunk_tensors
                    .iter()
                    .map(|(input_c, hidden_c, dt_c)| scope.spawn(move || self.integrate(input_c, hidden_c, dt_c, weights_ref)))
                    .collect();
                handles.into_iter().map(|h| h.join().expect("ltc batch-chunk worker panicked")).collect()
            })?;
            Tensor::cat(&parts, 0)?
        };

        Ok((v.clone(), v))
    }
}
