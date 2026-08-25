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

//! `liquid-train` CLI — train a CfC/LTC residual model for the dialysis domain and emit a
//! SafeTensors artifact + a JSON report.
//!
//! Invoked by the harness's `src/liquid/trainer.ts` (default runner) via
//! `cargo run -p liquid-train -- <args>`. Prints a single JSON object on stdout:
//!   { modelId, modelKind, artifactPath, losses[], finalLoss, baselineMae, trainedMae }
//!
//! Usage:
//!   liquid-train --out-dir <dir> [--domain dialysis] [--model-kind cfc|ltc]
//!                [--epochs 10] [--lr 0.01] [--num-sequences 12] [--sequence-length 24]
//!                [--seed 7] [--model-id <id>]

use candle_core::Device;
use domain_dialysis::DialysisDomain;
use domain_kit::DomainPack;
use liquid_core::serialization::{save_model, ModelMetadata};
use liquid_train::{evaluate_mae, train, EpochMetric, ModelKind, TrainingConfig};

fn arg(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).map(|i| args[i + 1].clone())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let domain = arg(&args, "--domain").unwrap_or_else(|| "dialysis".into());
    let kind_str = arg(&args, "--model-kind").unwrap_or_else(|| "cfc".into());
    let model_kind = match kind_str.as_str() {
        "ltc" => ModelKind::Ltc,
        _ => ModelKind::Cfc,
    };
    let epochs: usize = arg(&args, "--epochs").and_then(|v| v.parse().ok()).unwrap_or(10);
    let learning_rate: f64 = arg(&args, "--lr").and_then(|v| v.parse().ok()).unwrap_or(1e-2);
    let num_sequences: usize = arg(&args, "--num-sequences").and_then(|v| v.parse().ok()).unwrap_or(12);
    let sequence_length: usize = arg(&args, "--sequence-length").and_then(|v| v.parse().ok()).unwrap_or(24);
    let seed: u64 = arg(&args, "--seed").and_then(|v| v.parse().ok()).unwrap_or(7);
    let out_dir = arg(&args, "--out-dir").ok_or_else(|| anyhow::anyhow!("--out-dir is required"))?;
    let kind_tag = if matches!(model_kind, ModelKind::Cfc) { "cfc" } else { "ltc" };
    let model_id = arg(&args, "--model-id").unwrap_or_else(|| format!("{domain}-{kind_tag}-{seed}"));

    if domain != "dialysis" {
        anyhow::bail!("unsupported domain: {domain} (only 'dialysis' is wired to this CLI)");
    }

    let pack = DialysisDomain::default();
    let device = Device::Cpu;
    let config = TrainingConfig {
        model_kind,
        epochs,
        learning_rate,
        num_sequences,
        sequence_length,
        gradient_clip: Some(1.0),
        loss: Default::default(),
        seed,
    };

    let mut losses: Vec<f32> = Vec::new();
    let (model, varmap) = train(&pack, &config, &device, |m: EpochMetric| losses.push(m.loss))?;

    let metadata = ModelMetadata {
        format_version: 1,
        model_type: kind_tag.to_string(),
        input_size: pack.event_feature_schema().len(),
        hidden_size: pack.cfc_config().hidden_size,
        output_size: Some(pack.state_schema().len()),
        time_scale_seconds: 3600.0, // per realm-hour (matches DialysisBaseline's dt units)
        prediction_mode: "residual".to_string(),
        feature_schema: serde_json::to_string(&pack.event_feature_schema())?,
        model_version: "0.1.0".to_string(),
    };
    std::fs::create_dir_all(&out_dir)?;
    save_model(&varmap, &metadata, &out_dir)?;

    let baseline_mae = evaluate_mae(&pack, None, &config, &device)?;
    let trained_mae = evaluate_mae(&pack, Some(&model), &config, &device)?;

    let report = serde_json::json!({
        "modelId": model_id,
        "modelKind": kind_tag,
        "artifactPath": format!("{}/model.safetensors", out_dir.trim_end_matches('/')),
        "losses": losses,
        "finalLoss": losses.last().copied().unwrap_or(0.0),
        "baselineMae": baseline_mae,
        "trainedMae": trained_mae,
    });
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
