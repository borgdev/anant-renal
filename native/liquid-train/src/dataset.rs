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

use candle_core::{Device, Result, Tensor};
use domain_kit::DomainPack;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// One training sequence: `inputs`/`delta_t` are what the model consumes; `target` is the
/// residual it should learn to predict (`ΔX_observed − ΔX_baseline`, liquid-ai.md §29).
pub struct SequenceSample {
    /// `[time, input_size]`
    pub inputs: Tensor,
    /// `[time, 1]`
    pub delta_t: Tensor,
    /// `[time, output_size]`
    pub target: Tensor,
}

/// A small, fixed, seeded all-pairs coupling the hand-authored baseline ODE doesn't model:
/// each state dimension is mildly pulled toward every other dimension's current value. This
/// stands in for "real-world dynamics the deterministic baseline doesn't capture" so training
/// has a genuine (if synthetic) signal to recover — see liquid-ai.md §78/§81's framing: does
/// the learned residual explain trajectory behavior the baseline doesn't?
struct HiddenCoupling {
    matrix: Vec<f32>,
    n: usize,
}

impl HiddenCoupling {
    fn new(n: usize, seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed ^ 0xC0FFEE);
        let matrix = (0..n * n).map(|_| (rng.gen::<f32>() - 0.5) * 0.12).collect();
        Self { matrix, n }
    }

    fn delta(&self, state: &[f32], dt: f32) -> Vec<f32> {
        let mut out = vec![0.0f32; self.n];
        for i in 0..self.n {
            for j in 0..self.n {
                if i != j {
                    out[i] += self.matrix[i * self.n + j] * state[j] * (1.0 - state[i]);
                }
            }
        }
        out.iter().map(|v| v * dt).collect()
    }
}

/// Rolls out `num_sequences` independent scenario runs of `sequence_length` steps each, using
/// the domain's own scenario generator + baseline ODE plus the synthetic hidden coupling above
/// as the "true" (unmodeled) extra dynamics. Each sample's `target` is exactly what a perfect
/// residual learner would need to predict at every step.
///
/// `system_seed` fixes the hidden-coupling matrix — i.e. *which* unmodeled dynamics this
/// dataset's targets came from. `rollout_seed` varies the sampled trajectories (scenario
/// timing jitter) within that same system. A genuine held-out evaluation set must reuse the
/// training `system_seed` (same underlying system) with a different `rollout_seed` (different
/// sampled trajectories) — reusing a different `system_seed` would silently evaluate against
/// an unrelated system's ground truth, which is meaningless.
pub fn generate_dataset(
    pack: &dyn DomainPack,
    num_sequences: usize,
    sequence_length: usize,
    system_seed: u64,
    rollout_seed: u64,
    device: &Device,
) -> Result<Vec<SequenceSample>> {
    let schema = pack.state_schema();
    let event_schema = pack.event_feature_schema();
    let coupling = HiddenCoupling::new(schema.len(), system_seed);

    let mut samples = Vec::with_capacity(num_sequences);

    for seq_idx in 0..num_sequences {
        let mut scenario = pack.new_scenario(rollout_seed.wrapping_add(seq_idx as u64 * 1009 + 1));
        let mut state = pack.initial_state();
        let mut t = 0.0f32;
        let dt = 1.0f32;

        let mut inputs = Vec::with_capacity(sequence_length * event_schema.len());
        let mut dts = Vec::with_capacity(sequence_length);
        let mut targets = Vec::with_capacity(sequence_length * schema.len());

        for _ in 0..sequence_length {
            t += dt;
            let event = scenario.next_event(t, dt);
            let baseline_delta = pack.baseline().delta(&state, &event, dt);
            let hidden_delta = coupling.delta(&state, dt);

            for i in 0..state.len() {
                state[i] = (state[i] + baseline_delta[i] + hidden_delta[i]).clamp(schema.dimensions[i].min, schema.dimensions[i].max);
            }

            inputs.extend_from_slice(&event);
            dts.push(dt);
            targets.extend_from_slice(&hidden_delta);
        }

        let inputs_t = Tensor::from_vec(inputs, (sequence_length, event_schema.len()), device)?;
        let dt_t = Tensor::from_vec(dts, (sequence_length, 1), device)?;
        let target_t = Tensor::from_vec(targets, (sequence_length, schema.len()), device)?;

        samples.push(SequenceSample { inputs: inputs_t, delta_t: dt_t, target: target_t });
    }

    Ok(samples)
}
