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

mod cfc;
mod ltc;

pub use cfc::{ActivationKind, CfcConfig, CfcMode, MappingType};
pub use ltc::{LtcConfig, OdeSolverKind};

/// Neural connectivity mask for a cell's weight matrices (liquid-ai.md §21-23): it controls
/// which connections physically exist inside a cell.
///
/// `Sparse`/`Ncp` are wired into [`crate::cell::LtcCell`] (Phase 3), which manipulates its
/// weight tensors directly. [`crate::cell::CfcCell`] remains `Dense`-only: its backbone/heads
/// go through `candle_nn::Linear`, whose weight isn't exposed for per-forward-pass masking
/// without replacing it with a custom masked-linear layer — a bounded, separate follow-up
/// (see docs/ROADMAP.md's Phase 3 scope note) rather than something to bolt on here.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum WiringConfig {
    #[default]
    Dense,
    Sparse {
        /// Fraction of connections kept, in `(0, 1]`.
        connectivity: f32,
    },
    /// Structured sparse wiring generated from group sizes (sensory/inter/command/motor),
    /// loosely modeled on Neural Circuit Policies: sensory feeds inter, inter feeds command
    /// (+ sparse self-recurrence and a command→inter feedback loop), command feeds motor. This
    /// is *our* bounded reading of NCP-style structure, not a port of the original fan-in/
    /// fan-out sampling algorithm.
    Ncp {
        sensory: usize,
        inter: usize,
        command: usize,
        motor: usize,
    },
}

impl WiringConfig {
    pub fn hidden_size(&self) -> Option<usize> {
        match self {
            WiringConfig::Ncp { inter, command, motor, .. } => Some(inter + command + motor),
            _ => None,
        }
    }
}
