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

/// The deterministic "manifold" stand-in (see `docs/ROADMAP.md`'s design-decision note): a
/// small, hand-authored ODE that plays the architectural role `liquid-ai.md` assigns to the
/// HGFS manifold. Its output is combined with the CfC/LTC learned residual:
/// `ΔX_final = ΔX_baseline + α · R_θ`.
pub trait BaselineDynamics: Send + Sync {
    /// `state`: current entity state (schema-ordered). `event`: current event feature vector
    /// (event-feature-schema-ordered). `dt`: elapsed seconds. Returns `ΔX_baseline`,
    /// schema-ordered, the same length as `state`.
    fn delta(&self, state: &[f32], event: &[f32], dt: f32) -> Vec<f32>;
}
