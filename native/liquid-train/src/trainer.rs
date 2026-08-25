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

use candle_core::backprop::GradStore;
use candle_core::{DType, Device, Result, Var};
use candle_nn::{AdamW, Optimizer, ParamsAdamW, VarBuilder, VarMap};
use domain_kit::DomainPack;
use serde::{Deserialize, Serialize};

use liquid_core::{Cfc, Ltc, LiquidModel};

use crate::dataset::{generate_dataset, SequenceSample};
use crate::loss::LiquidLoss;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Cfc,
    Ltc,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrainingConfig {
    pub model_kind: ModelKind,
    pub epochs: usize,
    pub learning_rate: f64,
    pub num_sequences: usize,
    pub sequence_length: usize,
    pub gradient_clip: Option<f64>,
    pub loss: LiquidLoss,
    pub seed: u64,
}

impl Default for TrainingConfig {
    fn default() -> Self {
        Self {
            model_kind: ModelKind::Cfc,
            epochs: 30,
            learning_rate: 1e-2,
            num_sequences: 24,
            sequence_length: 40,
            gradient_clip: Some(1.0),
            loss: LiquidLoss::Mse,
            seed: 1,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EpochMetric {
    pub epoch: usize,
    pub loss: f32,
    pub grad_norm: f32,
}

/// Rescales every tracked var's gradient in `grads` in place so their combined L2 norm is at
/// most `max_norm` (liquid-ai.md §36) — important for LTC in particular, since `ode_unfolds`
/// sub-stepping deepens the gradient path. Returns the pre-clip norm (useful for logging).
fn clip_grad_norm(grads: &mut GradStore, vars: &[Var], max_norm: f64) -> Result<f64> {
    let mut total_sq = 0f64;
    for var in vars {
        if let Some(g) = grads.get(var.as_tensor()) {
            total_sq += g.sqr()?.sum_all()?.to_scalar::<f32>()? as f64;
        }
    }
    let total_norm = total_sq.sqrt();
    if total_norm > max_norm && total_norm > 0.0 {
        let scale = max_norm / (total_norm + 1e-6);
        for var in vars {
            if let Some(g) = grads.get(var.as_tensor()) {
                let scaled = (g * scale)?;
                grads.insert(var.as_tensor(), scaled);
            }
        }
    }
    Ok(total_norm)
}

fn build_model(pack: &dyn DomainPack, kind: ModelKind, vb: VarBuilder, seed: u64) -> Result<LiquidModel> {
    Ok(match kind {
        ModelKind::Cfc => Cfc::new(pack.cfc_config(), vb)?.into(),
        ModelKind::Ltc => Ltc::new(pack.ltc_config(), vb, seed)?.into(),
    })
}

/// Trains a fresh model for `pack` from scratch. `on_epoch` is called after every epoch (used
/// to stream progress to the UI); BPTT falls out of calling `.backward()` on the loss computed
/// over the whole unrolled sequence (liquid-ai.md §33) — there's no separate BPTT algorithm to
/// implement, truncation would mean chunking `sequence_length` (not done here; sequences are
/// short enough in this demo that full BPTT is fine).
pub fn train(
    pack: &dyn DomainPack,
    config: &TrainingConfig,
    device: &Device,
    mut on_epoch: impl FnMut(EpochMetric),
) -> Result<(LiquidModel, VarMap)> {
    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DType::F32, device);
    let model = build_model(pack, config.model_kind, vb, config.seed)?;

    let dataset: Vec<SequenceSample> =
        generate_dataset(pack, config.num_sequences, config.sequence_length, config.seed, config.seed, device)?;

    let vars = varmap.all_vars();
    let mut optimizer = AdamW::new(vars.clone(), ParamsAdamW { lr: config.learning_rate, ..Default::default() })?;

    for epoch in 0..config.epochs {
        let mut epoch_loss = 0.0f32;
        let mut epoch_grad_norm = 0.0f64;

        for sample in &dataset {
            let inputs = sample.inputs.unsqueeze(0)?;
            let dt = sample.delta_t.unsqueeze(0)?;
            let target = sample.target.unsqueeze(0)?;

            let out = model.forward(&inputs, None, Some(&dt))?;
            let loss = config.loss.compute(&out.sequence, &target)?;

            let mut grads = loss.backward()?;
            let grad_norm = match config.gradient_clip {
                Some(max_norm) => clip_grad_norm(&mut grads, &vars, max_norm)?,
                None => 0.0,
            };
            optimizer.step(&grads)?;

            epoch_loss += loss.to_scalar::<f32>()?;
            epoch_grad_norm += grad_norm;
        }

        let metric = EpochMetric {
            epoch,
            loss: epoch_loss / dataset.len() as f32,
            grad_norm: (epoch_grad_norm / dataset.len() as f64) as f32,
        };
        on_epoch(metric);
    }

    Ok((model, varmap))
}

/// Mean absolute residual error on a fresh (held-out — different seed offset) rollout, used to
/// compare baseline-only / untrained / trained models (the Model Comparison page). Predicting
/// all-zero residual is the "the baseline already explains everything" null hypothesis
/// (liquid-ai.md §78).
pub fn evaluate_mae(pack: &dyn DomainPack, model: Option<&LiquidModel>, config: &TrainingConfig, device: &Device) -> Result<f32> {
    let eval_rollout_seed = config.seed.wrapping_add(999_983);
    let dataset =
        generate_dataset(pack, config.num_sequences.max(4), config.sequence_length, config.seed, eval_rollout_seed, device)?;

    let mut total_abs = 0f64;
    let mut count = 0usize;

    for sample in &dataset {
        let predicted = match model {
            Some(model) => {
                let inputs = sample.inputs.unsqueeze(0)?;
                let dt = sample.delta_t.unsqueeze(0)?;
                model.forward(&inputs, None, Some(&dt))?.sequence.squeeze(0)?
            }
            None => sample.target.zeros_like()?,
        };
        let diff = (predicted - &sample.target)?.abs()?;
        total_abs += diff.sum_all()?.to_scalar::<f32>()? as f64;
        count += diff.elem_count();
    }

    Ok((total_abs / count as f64) as f32)
}
