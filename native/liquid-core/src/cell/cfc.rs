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

use candle_core::{DType, Device, Module, Result, Tensor};
use candle_nn::{linear, Linear, VarBuilder};

use super::ContinuousTimeCell;
use crate::activation::sigmoid;
use crate::backbone::CfcBackbone;
use crate::config::{CfcConfig, CfcMode};
use crate::mapping::FeatureMap;

/// Closed-form Continuous-time (CfC) cell (liquid-ai.md §12).
///
/// `step` computes, for [`CfcMode::Default`]:
///
/// ```text
/// z     = concat(input_mapped, hidden)
/// z     = backbone(z)
/// ff1   = tanh(W1 z + b1)
/// ff2   = tanh(W2 z + b2)
/// gate  = sigmoid((Wa z + ba) * delta_t + (Wb z + bb))
/// next  = ff1 * (1 - gate) + ff2 * gate
/// ```
pub struct CfcCell {
    config: CfcConfig,

    input_map: FeatureMap,
    backbone: CfcBackbone,

    ff1: Linear,
    ff2: Linear,
    time_a: Linear,
    time_b: Linear,
}

impl CfcCell {
    pub fn new(config: CfcConfig, vb: VarBuilder) -> Result<Self> {
        let input_map = FeatureMap::new(config.input_mapping, config.input_size, vb.pp("input_map"))?;

        let backbone = CfcBackbone::new(
            config.input_size + config.hidden_size,
            config.backbone_layers,
            config.backbone_units,
            config.backbone_activation,
            vb.pp("backbone"),
        )?;
        let backbone_out = backbone.output_dim();

        let ff1 = linear(backbone_out, config.hidden_size, vb.pp("ff1"))?;
        let ff2 = linear(backbone_out, config.hidden_size, vb.pp("ff2"))?;
        let time_a = linear(backbone_out, config.hidden_size, vb.pp("time_a"))?;
        let time_b = linear(backbone_out, config.hidden_size, vb.pp("time_b"))?;

        Ok(Self {
            config,
            input_map,
            backbone,
            ff1,
            ff2,
            time_a,
            time_b,
        })
    }

    pub fn config(&self) -> &CfcConfig {
        &self.config
    }
}

impl ContinuousTimeCell for CfcCell {
    type State = Tensor;

    fn hidden_size(&self) -> usize {
        self.config.hidden_size
    }

    fn zero_state(&self, batch: usize, device: &Device, dtype: DType) -> Result<Tensor> {
        Tensor::zeros((batch, self.config.hidden_size), dtype, device)
    }

    fn step(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<(Tensor, Tensor)> {
        match self.config.mode {
            CfcMode::Default => self.step_default(input, hidden, delta_t),
            CfcMode::NoGate | CfcMode::Pure => Err(candle_core::Error::Msg(format!(
                "CfcMode::{:?} is not yet implemented (pending §54 reference parity testing)",
                self.config.mode
            ))),
        }
    }
}

impl CfcCell {
    fn step_default(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<(Tensor, Tensor)> {
        let input = self.input_map.apply(input)?;
        let z = Tensor::cat(&[&input, hidden], 1)?;
        let z = self.backbone.forward(&z)?;

        let ff1 = self.ff1.forward(&z)?.tanh()?;
        let ff2 = self.ff2.forward(&z)?.tanh()?;

        let ta = self.time_a.forward(&z)?;
        let tb = self.time_b.forward(&z)?;

        // delta_t is [batch, 1]; ta/tb are [batch, hidden] — broadcast-multiply then add.
        let gate_arg = ta.broadcast_mul(delta_t)?.broadcast_add(&tb)?;
        let gate = sigmoid(&gate_arg)?;

        let one_minus_gate = gate.affine(-1.0, 1.0)?;
        let next = ((&ff1 * &one_minus_gate)? + (&ff2 * &gate)?)?;

        Ok((next.clone(), next))
    }
}
