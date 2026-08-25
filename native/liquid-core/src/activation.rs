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

pub fn sigmoid(x: &Tensor) -> Result<Tensor> {
    let neg_exp = x.neg()?.exp()?;
    neg_exp.affine(1.0, 1.0)?.recip()
}

/// `softplus(x) = ln(1+exp(x))`, used to keep physiological LTC parameters (conductances,
/// capacitance, synaptic steepness) positive while remaining differentiable (liquid-ai.md §19).
pub fn softplus(x: &Tensor) -> Result<Tensor> {
    x.exp()?.affine(1.0, 1.0)?.log()
}
