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

/// A single term an observer rule's condition can reference (liquid-ai.md §64's
/// `WHEN risk > 0.7 AND d(risk)/dt > 0.1 ...` style predicates).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleTerm {
    /// Current value of a state dimension, e.g. `state("risk")`.
    State { dim: String },
    /// `d(state[dim])/dt` over the most recent tick.
    Velocity { dim: String },
    /// `‖ΔX_observed − ΔX_predicted‖` for the most recent tick (the "dynamics anomaly"
    /// primitive from liquid-ai.md §30/§64).
    Residual,
    /// Placeholder until Phase 4 training produces a real uncertainty estimate — always 1.0.
    Confidence,
    Const { value: f32 },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Comparator {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
}

/// A boolean condition tree over `RuleTerm`s. The UI's Rule Builder edits the common case —
/// a flat `And` of `Cmp` leaves — but the type supports full nesting for programmatic/future
/// use.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleNode {
    Cmp { lhs: RuleTerm, op: Comparator, rhs: RuleTerm },
    And { terms: Vec<RuleNode> },
    Or { terms: Vec<RuleNode> },
    Not { term: Box<RuleNode> },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Good,
    Warning,
    Serious,
    Critical,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObserverRule {
    pub id: String,
    pub domain_id: String,
    pub name: String,
    pub condition: RuleNode,
    pub severity: Severity,
    pub message: String,
    pub enabled: bool,
}

/// Everything a rule condition can read for one entity at one tick.
pub struct EvalContext<'a> {
    pub schema: &'a EntityStateSchema,
    pub state: &'a [f32],
    pub velocity: &'a [f32],
    pub residual_magnitude: f32,
}

impl RuleTerm {
    fn resolve(&self, ctx: &EvalContext) -> f32 {
        match self {
            RuleTerm::State { dim } => ctx
                .schema
                .index_of(dim)
                .and_then(|i| ctx.state.get(i))
                .copied()
                .unwrap_or(f32::NAN),
            RuleTerm::Velocity { dim } => ctx
                .schema
                .index_of(dim)
                .and_then(|i| ctx.velocity.get(i))
                .copied()
                .unwrap_or(f32::NAN),
            RuleTerm::Residual => ctx.residual_magnitude,
            RuleTerm::Confidence => 1.0,
            RuleTerm::Const { value } => *value,
        }
    }
}

impl RuleNode {
    pub fn evaluate(&self, ctx: &EvalContext) -> bool {
        match self {
            RuleNode::Cmp { lhs, op, rhs } => {
                let (l, r) = (lhs.resolve(ctx), rhs.resolve(ctx));
                match op {
                    Comparator::Gt => l > r,
                    Comparator::Gte => l >= r,
                    Comparator::Lt => l < r,
                    Comparator::Lte => l <= r,
                    Comparator::Eq => (l - r).abs() < 1e-6,
                }
            }
            RuleNode::And { terms } => terms.iter().all(|t| t.evaluate(ctx)),
            RuleNode::Or { terms } => terms.iter().any(|t| t.evaluate(ctx)),
            RuleNode::Not { term } => !term.evaluate(ctx),
        }
    }
}

impl ObserverRule {
    pub fn fires(&self, ctx: &EvalContext) -> bool {
        self.enabled && self.condition.evaluate(ctx)
    }
}
