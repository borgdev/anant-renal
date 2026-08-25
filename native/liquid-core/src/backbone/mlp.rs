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

use candle_core::{Module, Result, Tensor};
use candle_nn::{linear, Linear, VarBuilder};

use crate::config::ActivationKind;

/// Shared MLP backbone feeding a cell's heads (liquid-ai.md §11): `Linear -> act -> Linear
/// -> act -> ...`, configurable depth/width. With zero layers, the backbone is the identity
/// and heads consume the raw `[input; hidden]` concatenation directly.
pub struct CfcBackbone {
    layers: Vec<Linear>,
    activation: ActivationKind,
    output_dim: usize,
}

impl CfcBackbone {
    pub fn new(
        input_dim: usize,
        num_layers: usize,
        units: usize,
        activation: ActivationKind,
        vb: VarBuilder,
    ) -> Result<Self> {
        let mut layers = Vec::with_capacity(num_layers);
        let mut in_dim = input_dim;
        for i in 0..num_layers {
            layers.push(linear(in_dim, units, vb.pp(format!("layer{i}")))?);
            in_dim = units;
        }
        Ok(Self {
            layers,
            activation,
            output_dim: if num_layers == 0 { input_dim } else { units },
        })
    }

    pub fn output_dim(&self) -> usize {
        self.output_dim
    }

    pub fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let mut z = x.clone();
        for layer in &self.layers {
            z = self.activation.apply(&layer.forward(&z)?)?;
        }
        Ok(z)
    }
}
