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

use candle_core::{Result, Tensor};
use serde::{Deserialize, Serialize};

/// Loss functions for residual-dynamics training (liquid-ai.md §34). `ResidualWeightedMse`
/// with all-ones weights is equivalent to `Mse`; the weighted form exists for future per-
/// dimension weighting (e.g. penalizing a "risk" dimension's error more than others).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum LiquidLoss {
    #[default]
    Mse,
    Mae,
    Huber,
}

impl LiquidLoss {
    pub fn compute(&self, prediction: &Tensor, target: &Tensor) -> Result<Tensor> {
        let diff = (prediction - target)?;
        match self {
            LiquidLoss::Mse => diff.sqr()?.mean_all(),
            LiquidLoss::Mae => diff.abs()?.mean_all(),
            LiquidLoss::Huber => {
                // Smooth L1 / Huber with delta=1: 0.5*x^2 for |x|<=1, |x|-0.5 otherwise.
                let abs_diff = diff.abs()?;
                let quadratic = diff.sqr()?.affine(0.5, 0.0)?;
                let linear = abs_diff.affine(1.0, -0.5)?;
                let is_small = abs_diff.le(1.0)?.to_dtype(diff.dtype())?;
                let is_large = (1.0 - &is_small)?;
                (quadratic.mul(&is_small)? + linear.mul(&is_large)?)?.mean_all()
            }
        }
    }
}
