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

//! Training (AdamW, synthetic dataset generation, gradient clipping) for `liquid-core` models
//! — kept as a separate crate so `liquid-core` stays inference-only and wasm-buildable
//! (liquid-ai.md §69's training/inference split, done at crate granularity).
//!
//! Checkpointing reuses `liquid_core::serialization` directly (SafeTensors + JSON metadata)
//! rather than a bespoke format here.

pub mod dataset;
pub mod loss;
pub mod trainer;

pub use dataset::{generate_dataset, SequenceSample};
pub use loss::LiquidLoss;
pub use trainer::{evaluate_mae, train, EpochMetric, ModelKind, TrainingConfig};
