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

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// A deterministic, seeded synthetic event source (liquid-ai.md's irregular-event-stream
/// framing, §26) that drives a live demo simulation without needing real production data.
pub trait ScenarioGenerator: Send {
    /// Advance by `dt` seconds (simulation time `t` is tracked by the caller) and return the
    /// event feature vector active at this tick, event-feature-schema-ordered. Implementations
    /// typically hold their own decaying internal signal state so the baseline/CfC step
    /// functions can stay memoryless with respect to "how long ago did X happen."
    fn next_event(&mut self, t: f32, dt: f32) -> Vec<f32>;

    /// Human-readable label for the currently active scenario stage (e.g.
    /// `"credential_access"`), shown in the UI's scenario timeline.
    fn stage_label(&self) -> &str;
}

/// One scripted event pulse: at simulated time `at` (within the loop cycle), the event
/// feature at `index` gets set to `1.0` and starts decaying.
pub struct PulseStep {
    pub at: f32,
    pub index: usize,
    pub label: &'static str,
}

/// A generic, reusable escalating-then-looping scenario: a fixed schedule of event pulses
/// (each decaying exponentially, §26's irregular-event-stream framing) that repeats every
/// `cycle_length` simulated seconds. Every domain pack uses this rather than hand-rolling its
/// own scenario generator — see `domain-packs/cyber` for the original bespoke version this was
/// extracted from.
///
/// Three things vary per entity, all deterministically derived from `seed` so a given entity's
/// behavior is reproducible run to run:
/// - **phase offset** across the *full* cycle (not just a few seconds), so entities aren't all
///   mid-pulse at the same moment;
/// - **intensity** (~0.4–1.2×) applied to every pulse this entity experiences;
/// - **participation** — a per-step, per-entity coin flip fixed for the entity's lifetime, so
///   some entities never experience a given scripted event at all (e.g. some accounts never see
///   a competitor visit).
///
/// Earlier versions only varied the phase offset by a few seconds out of a much longer cycle,
/// which does not change an entity's long-run *time-average* event exposure — since every
/// entity eventually walks the identical, identically-scaled pulse schedule, the whole
/// population's baseline ODE converges toward the same fixed point regardless of seed. That
/// surfaced as a real defect: a live population visibly homogenizing to a single risk value
/// within minutes (see docs/EXECUTIVE_REVIEW.md's review findings). Intensity and participation
/// give each entity a genuinely different long-run equilibrium, not just a different phase.
pub struct PulseScenario {
    signals: Vec<f32>,
    tau_decay: f32,
    cycle_length: f32,
    offset: f32,
    intensity: f32,
    participation: Vec<bool>,
    stage_label: String,
    steps: Vec<PulseStep>,
}

impl PulseScenario {
    pub fn new(num_features: usize, steps: Vec<PulseStep>, cycle_length: f32, tau_decay: f32, seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let offset = rng.gen::<f32>() * cycle_length;
        let intensity = 0.4 + rng.gen::<f32>() * 0.8;
        let participation = steps.iter().map(|_| rng.gen::<f32>() < 0.8).collect();
        Self {
            signals: vec![0.0; num_features],
            tau_decay,
            cycle_length,
            offset,
            intensity,
            participation,
            stage_label: "calm".to_string(),
            steps,
        }
    }
}

impl ScenarioGenerator for PulseScenario {
    fn next_event(&mut self, t: f32, dt: f32) -> Vec<f32> {
        let t_mod = (t + self.offset).rem_euclid(self.cycle_length);

        let decay = (-dt / self.tau_decay).exp();
        for signal in &mut self.signals {
            *signal *= decay;
        }

        for (step, participates) in self.steps.iter().zip(&self.participation) {
            if *participates && (t_mod - step.at).abs() < dt.max(0.05) {
                self.signals[step.index] = self.intensity;
                self.stage_label = step.label.to_string();
            }
        }
        if self.steps.first().is_some_and(|first| t_mod < first.at) {
            self.stage_label = "calm".to_string();
        }

        self.signals.clone()
    }

    fn stage_label(&self) -> &str {
        &self.stage_label
    }
}
