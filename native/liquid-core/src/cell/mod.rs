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

pub use cfc::CfcCell;
pub use ltc::LtcCell;

use candle_core::{DType, Device, Result, Tensor};

/// Shared interface for continuous-time recurrent cells (liquid-ai.md §7). Sequence-level
/// models (e.g. [`crate::sequence::Cfc`]) operate exclusively through this trait so CfC and
/// the future LTC cell are interchangeable at the runtime boundary.
pub trait ContinuousTimeCell {
    type State;

    fn hidden_size(&self) -> usize;

    fn zero_state(&self, batch: usize, device: &Device, dtype: DType) -> Result<Self::State>;

    /// Advance the cell by `delta_t` (shape `[batch, 1]`) given `input` (shape
    /// `[batch, input_size]`). Returns `(output, next_state)`.
    fn step(&self, input: &Tensor, state: &Self::State, delta_t: &Tensor) -> Result<(Tensor, Self::State)>;
}
