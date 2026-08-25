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

use serde::{Deserialize, Serialize};

use super::WiringConfig;

/// Operating mode for the CfC cell's time-gating formula (liquid-ai.md §9).
///
/// Only [`CfcMode::Default`] is implemented in Phase 0. `NoGate` and `Pure` are part of
/// the published CfC formulation but require golden-vector parity testing against the
/// official `ncps` reference implementation (spec §54) before they can be trusted for
/// anything beyond experimentation, so [`crate::cell::CfcCell::step`] returns an error if
/// they're selected. Tracked for Phase 3/4.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CfcMode {
    #[default]
    Default,
    NoGate,
    Pure,
}

/// Elementwise input/output remapping (liquid-ai.md §20): `Identity` (x'=x), `Linear`
/// (x'=x⊙w), or `Affine` (x'=x⊙w+b).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum MappingType {
    #[default]
    Identity,
    Linear,
    Affine,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivationKind {
    #[default]
    Silu,
    Tanh,
    Relu,
    Gelu,
}

impl ActivationKind {
    pub fn apply(&self, x: &candle_core::Tensor) -> candle_core::Result<candle_core::Tensor> {
        match self {
            ActivationKind::Silu => candle_nn::ops::silu(x),
            ActivationKind::Tanh => x.tanh(),
            ActivationKind::Relu => x.relu(),
            ActivationKind::Gelu => x.gelu_erf(),
        }
    }
}

/// Configuration for a [`crate::cell::CfcCell`] / [`crate::sequence::Cfc`] model
/// (liquid-ai.md §10).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CfcConfig {
    pub input_size: usize,
    pub hidden_size: usize,
    pub output_size: Option<usize>,

    pub mode: CfcMode,

    pub backbone_layers: usize,
    pub backbone_units: usize,
    pub backbone_activation: ActivationKind,

    pub input_mapping: MappingType,
    pub output_mapping: MappingType,

    pub wiring: WiringConfig,

    pub epsilon: f64,
}

impl CfcConfig {
    pub fn new(input_size: usize, hidden_size: usize) -> Self {
        Self {
            input_size,
            hidden_size,
            output_size: None,
            mode: CfcMode::default(),
            backbone_layers: 1,
            backbone_units: 64,
            backbone_activation: ActivationKind::default(),
            input_mapping: MappingType::default(),
            output_mapping: MappingType::default(),
            wiring: WiringConfig::default(),
            epsilon: 1e-8,
        }
    }
}
