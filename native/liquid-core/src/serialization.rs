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

use std::path::Path;

use candle_nn::VarMap;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Sidecar metadata persisted alongside `model.safetensors` (liquid-ai.md §38).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelMetadata {
    pub format_version: u32,
    pub model_type: String,
    pub input_size: usize,
    pub hidden_size: usize,
    pub output_size: Option<usize>,
    pub time_scale_seconds: f64,
    pub prediction_mode: String,
    pub feature_schema: String,
    pub model_version: String,
}

/// Save trainable parameters to `<dir>/model.safetensors` and metadata to `<dir>/model.json`
/// (liquid-ai.md §38).
pub fn save_model(varmap: &VarMap, metadata: &ModelMetadata, dir: impl AsRef<Path>) -> Result<()> {
    let dir = dir.as_ref();
    std::fs::create_dir_all(dir)?;
    varmap.save(dir.join("model.safetensors"))?;
    let metadata_json = serde_json::to_string_pretty(metadata)?;
    std::fs::write(dir.join("model.json"), metadata_json)?;
    Ok(())
}

/// Load trainable parameters from `<dir>/model.safetensors` into `varmap`, and read back the
/// sidecar metadata from `<dir>/model.json`.
pub fn load_model(varmap: &mut VarMap, dir: impl AsRef<Path>) -> Result<ModelMetadata> {
    let dir = dir.as_ref();
    varmap.load(dir.join("model.safetensors"))?;
    let metadata_json = std::fs::read_to_string(dir.join("model.json"))?;
    let metadata = serde_json::from_str(&metadata_json)?;
    Ok(metadata)
}
