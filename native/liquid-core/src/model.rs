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

use crate::cell::ContinuousTimeCell;
use crate::sequence::{Cfc, Ltc};

/// Runtime enum over the two continuous-time model families (liquid-ai.md §49), so callers
/// (the simulation loop, the trainer) can hold "a liquid model" without caring which cell
/// backs it.
pub enum LiquidModel {
    Cfc(Cfc),
    Ltc(Ltc),
}

pub struct LiquidStepOutput {
    pub prediction: Tensor,
    pub hidden: Tensor,
}

pub struct LiquidForwardOutput {
    pub sequence: Tensor,
    pub final_state: Tensor,
}

impl LiquidModel {
    pub fn step(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<LiquidStepOutput> {
        let (prediction, hidden) = match self {
            LiquidModel::Cfc(m) => m.step(input, hidden, delta_t)?,
            LiquidModel::Ltc(m) => m.step(input, hidden, delta_t)?,
        };
        Ok(LiquidStepOutput { prediction, hidden })
    }

    /// Sequence-level forward pass — used by the trainer (BPTT falls out of calling
    /// `.backward()` on a loss computed over this unrolled sequence, per liquid-ai.md §33; no
    /// separate BPTT algorithm needs implementing).
    pub fn forward(&self, inputs: &Tensor, initial_state: Option<&Tensor>, delta_t: Option<&Tensor>) -> Result<LiquidForwardOutput> {
        let (sequence, final_state) = match self {
            LiquidModel::Cfc(m) => {
                let out = m.forward(inputs, initial_state, delta_t)?;
                (out.sequence, out.final_state)
            }
            LiquidModel::Ltc(m) => {
                let out = m.forward(inputs, initial_state, delta_t)?;
                (out.sequence, out.final_state)
            }
        };
        Ok(LiquidForwardOutput { sequence, final_state })
    }

    pub fn zero_state(&self, batch: usize, device: &Device, dtype: DType) -> Result<Tensor> {
        match self {
            LiquidModel::Cfc(m) => m.cell().zero_state(batch, device, dtype),
            LiquidModel::Ltc(m) => m.cell().zero_state(batch, device, dtype),
        }
    }

    pub fn hidden_size(&self) -> usize {
        match self {
            LiquidModel::Cfc(m) => m.cell().hidden_size(),
            LiquidModel::Ltc(m) => m.cell().hidden_size(),
        }
    }

    pub fn model_type(&self) -> &'static str {
        match self {
            LiquidModel::Cfc(_) => "cfc",
            LiquidModel::Ltc(_) => "ltc",
        }
    }
}

impl From<Cfc> for LiquidModel {
    fn from(m: Cfc) -> Self {
        LiquidModel::Cfc(m)
    }
}

impl From<Ltc> for LiquidModel {
    fn from(m: Ltc) -> Self {
        LiquidModel::Ltc(m)
    }
}
