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

use domain_kit::BaselineDynamics;

// Event feature indices (event-feature-schema order, see `lib.rs`).
pub const MISSED_TREATMENT: usize = 0;
pub const ACCESS_COMPLICATION: usize = 1;
pub const LAB_MARKER_ELEVATED: usize = 2;
pub const ABNORMAL_VITAL_READING: usize = 3;
pub const DIET_PHOSPHATE_VIOLATION: usize = 4;

// State dimension indices (state-schema order, see `lib.rs`).
pub const VITALS_INSTABILITY: usize = 0;
pub const DETERIORATION_RISK: usize = 1;
pub const KTV_ADEQUACY: usize = 2;
pub const PHOSPHATE: usize = 3;
pub const ANEMIA_SEVERITY: usize = 4;

/// Dialysis baseline ODE — the deterministic, hand-authored manifold the CfC/LTC learned
/// residual corrects (`ΔX_final = ΔX_baseline + α · R_θ`).
///
/// **Time units:** `dt` is in **realm-hours** (the harness realm ticks hourly), so the rates
/// below are per-hour deltas — a single tick produces a small, stable increment and the
/// trajectory converges over days, which is the right timescale for dialysis.
///
/// Encodes the domain's well-known dynamics (mirroring the intent of the harness's original
/// hand-authored physiology in `src/realm/ambient.ts`):
///   • missed treatments erode Kt/V adequacy (K rises / URR falls) and stall recovery,
///   • missed treatments + elevated lab markers worsen anemia severity,
///   • diet phosphate violations and missed treatments raise phosphate burden,
///   • abnormal vitals and access complications raise vitals instability,
///   • deterioration risk accumulates from instability, low Kt/V, high phosphate, and anemia,
///     and is offset by adequate dialysis.
/// A treated, adherent patient's equilibrium decays back toward stable (recovery terms are
/// gated on "not missing").
pub struct DialysisBaseline;

impl BaselineDynamics for DialysisBaseline {
    fn delta(&self, state: &[f32], event: &[f32], dt: f32) -> Vec<f32> {
        let vitals = state[VITALS_INSTABILITY];
        let risk = state[DETERIORATION_RISK];
        let ktv = state[KTV_ADEQUACY];
        let phos = state[PHOSPHATE];
        let anemia = state[ANEMIA_SEVERITY];

        let missed = event[MISSED_TREATMENT];

        // Vitals instability rises from abnormal vitals + access complications; decays down.
        // Rates are per realm-hour (dt in hours) — the harness realm ticks hourly.
        let d_vitals =
            0.25 * event[ABNORMAL_VITAL_READING] * (1.0 - vitals)
                + 0.2 * event[ACCESS_COMPLICATION] * (1.0 - vitals)
                - 0.05 * vitals;

        // Composite deterioration risk — accumulates from the four insult channels, offset by
        // adequate dialysis and time.
        let d_risk = 0.06 * vitals * (1.0 - risk)
            + 0.08 * (1.0 - ktv) * (1.0 - risk)
            + 0.06 * phos * (1.0 - risk)
            + 0.05 * anemia * (1.0 - risk)
            + 0.12 * event[ACCESS_COMPLICATION] * (1.0 - risk)
            - 0.04 * ktv * risk
            - 0.02 * risk;

        // Kt/V adequacy (high = good): eroded by missed treatments; only recovers toward
        // adequate when the patient actually dialyzes.
        let d_ktv = -0.1 * missed * ktv + 0.02 * (1.0 - missed) * (1.0 - ktv);

        // Phosphate (high = bad): diet violations + missed treatments (lost clearance) push it
        // up; dialysis clears it (gated on not missing).
        let d_phos = 0.15 * event[DIET_PHOSPHATE_VIOLATION] * (1.0 - phos)
            + 0.06 * missed * (1.0 - phos)
            - 0.03 * (1.0 - missed) * phos;

        // Anemia severity (high = bad): missed treatments + elevated lab markers worsen it;
        // recovers when treated.
        let d_anemia = 0.05 * missed * (1.0 - anemia)
            + 0.04 * event[LAB_MARKER_ELEVATED] * (1.0 - anemia)
            - 0.02 * (1.0 - missed) * anemia;

        vec![
            d_vitals * dt,
            d_risk * dt,
            d_ktv * dt,
            d_phos * dt,
            d_anemia * dt,
        ]
    }
}
