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

use crate::schema::EntityStateSchema;

/// A named action a user can trigger against a running entity — a one-shot additive effect on
/// its state, plus the cost/business-impact terms the spec's intervention-simulation optimizer
/// (`argmin_A [Risk(...) + Cost(A) + BusinessImpact(A)]`) would weigh against candidate actions.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InterventionSpec {
    pub id: String,
    pub domain_id: String,
    pub name: String,
    pub description: String,
    pub cost: f32,
    /// `(dimension key, additive delta)` — applied once, clamped to the dimension's bounds.
    pub effect: Vec<(String, f32)>,
}

impl InterventionSpec {
    /// Apply this intervention's effect to `state` (schema-ordered) in place.
    pub fn apply(&self, schema: &EntityStateSchema, state: &mut [f32]) {
        for (key, delta) in &self.effect {
            if let Some(i) = schema.index_of(key) {
                state[i] += delta;
            }
        }
        schema.clamp(state);
    }
}
