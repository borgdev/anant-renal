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

use crate::cell::{ContinuousTimeCell, LtcCell};
use crate::config::LtcConfig;
use crate::mapping::FeatureMap;

pub struct LtcOutput {
    /// `[batch, time, output_dim]`
    pub sequence: Tensor,
    /// `[batch, hidden_size]`
    pub final_state: Tensor,
}

/// Sequence-level LTC model — the LTC counterpart to [`crate::sequence::Cfc`], with the same
/// projection/output-mapping/streaming shape.
pub struct Ltc {
    cell: LtcCell,
    projection: Option<Linear>,
    output_map: FeatureMap,
}

impl Ltc {
    pub fn new(config: LtcConfig, vb: VarBuilder, seed: u64) -> Result<Self> {
        let hidden_size = config.hidden_size;
        let output_size = config.output_size;
        let output_mapping = config.output_mapping;

        let cell = LtcCell::new(config, vb.pp("cell"), seed)?;

        let projection = match output_size {
            Some(o) => Some(linear(hidden_size, o, vb.pp("projection"))?),
            None => None,
        };
        let out_dim = output_size.unwrap_or(hidden_size);
        let output_map = FeatureMap::new(output_mapping, out_dim, vb.pp("output_map"))?;

        Ok(Self { cell, projection, output_map })
    }

    pub fn cell(&self) -> &LtcCell {
        &self.cell
    }

    pub fn step(&self, input: &Tensor, hidden: &Tensor, delta_t: &Tensor) -> Result<(Tensor, Tensor)> {
        let (h_out, next_state) = self.cell.step(input, hidden, delta_t)?;
        let projected = match &self.projection {
            Some(p) => p.forward(&h_out)?,
            None => h_out,
        };
        let output = self.output_map.apply(&projected)?;
        Ok((output, next_state))
    }

    pub fn forward(&self, inputs: &Tensor, initial_state: Option<&Tensor>, delta_t: Option<&Tensor>) -> Result<LtcOutput> {
        let (batch, time, _input_size) = inputs.dims3()?;
        let device = inputs.device();
        let dtype = inputs.dtype();

        let mut hidden = match initial_state {
            Some(s) => s.clone(),
            None => self.cell.zero_state(batch, device, dtype)?,
        };

        let mut outputs = Vec::with_capacity(time);
        for t in 0..time {
            let input_t = inputs.narrow(1, t, 1)?.squeeze(1)?;
            let dt_t = match delta_t {
                Some(dt) => dt.narrow(1, t, 1)?.squeeze(1)?,
                None => Tensor::ones((batch, 1), dtype, device)?,
            };
            let (output_t, next_hidden) = self.step(&input_t, &hidden, &dt_t)?;
            hidden = next_hidden;
            outputs.push(output_t.unsqueeze(1)?);
        }

        let sequence = Tensor::cat(&outputs, 1)?;
        Ok(LtcOutput { sequence, final_state: hidden })
    }
}
