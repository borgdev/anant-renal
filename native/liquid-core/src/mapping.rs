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
use candle_nn::VarBuilder;

use crate::config::MappingType;

/// Elementwise remap applied to raw feature vectors before/after a cell (liquid-ai.md §20):
/// `Identity` (x'=x), `Linear` (x'=x⊙w), `Affine` (x'=x⊙w+b). `w`/`b` are per-feature
/// (shape `[dim]`) and broadcast over the batch dimension.
pub enum FeatureMap {
    Identity,
    Linear { w: Tensor },
    Affine { w: Tensor, b: Tensor },
}

impl FeatureMap {
    pub fn new(kind: MappingType, dim: usize, vb: VarBuilder) -> Result<Self> {
        Ok(match kind {
            MappingType::Identity => FeatureMap::Identity,
            MappingType::Linear => {
                let w = vb.get_with_hints(dim, "w", candle_nn::Init::Const(1.0))?;
                FeatureMap::Linear { w }
            }
            MappingType::Affine => {
                let w = vb.get_with_hints(dim, "w", candle_nn::Init::Const(1.0))?;
                let b = vb.get_with_hints(dim, "b", candle_nn::Init::Const(0.0))?;
                FeatureMap::Affine { w, b }
            }
        })
    }

    pub fn apply(&self, x: &Tensor) -> Result<Tensor> {
        match self {
            FeatureMap::Identity => Ok(x.clone()),
            FeatureMap::Linear { w } => x.broadcast_mul(w),
            FeatureMap::Affine { w, b } => x.broadcast_mul(w)?.broadcast_add(b),
        }
    }
}
