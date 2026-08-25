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

/// One named, bounded dimension of an entity's state vector (e.g. "risk", 0..1).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StateDimension {
    pub key: String,
    pub label: String,
    pub unit: Option<String>,
    pub min: f32,
    pub max: f32,
    /// Hex color for charts, assigned in fixed categorical order (dataviz skill).
    pub color: String,
}

/// The full state schema for a domain's entities. Order is significant: it fixes the layout
/// of the `StateVector`s that flow through baseline dynamics and the CfC residual output.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntityStateSchema {
    pub dimensions: Vec<StateDimension>,
}

impl EntityStateSchema {
    pub fn len(&self) -> usize {
        self.dimensions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.dimensions.is_empty()
    }

    pub fn index_of(&self, key: &str) -> Option<usize> {
        self.dimensions.iter().position(|d| d.key == key)
    }

    pub fn zero_state(&self) -> Vec<f32> {
        vec![0.0; self.dimensions.len()]
    }

    pub fn clamp(&self, state: &mut [f32]) {
        for (value, dim) in state.iter_mut().zip(self.dimensions.iter()) {
            *value = value.clamp(dim.min, dim.max);
        }
    }

    pub fn as_map(&self, state: &[f32]) -> std::collections::HashMap<String, f32> {
        self.dimensions
            .iter()
            .zip(state.iter())
            .map(|(dim, value)| (dim.key.clone(), *value))
            .collect()
    }
}

/// Named input features derived from raw domain events — this is what feeds the CfC cell's
/// `input` (liquid-ai.md's `DynamicsFeatures`), distinct from the entity `StateDimension`s the
/// cell's residual output is expressed in.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventFeatureSchema {
    pub features: Vec<String>,
}

impl EventFeatureSchema {
    pub fn len(&self) -> usize {
        self.features.len()
    }

    pub fn is_empty(&self) -> bool {
        self.features.is_empty()
    }
}
