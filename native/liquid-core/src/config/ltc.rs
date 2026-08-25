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

use super::{MappingType, WiringConfig};

/// Numerical integrator for the LTC ODE (liquid-ai.md §17). `SemiImplicitEuler` is the
/// production default — the linear-in-`v` part of the conductance ODE is solved implicitly
/// (so the nonlinear synaptic activation can be frozen at the previous state without the
/// stiffness blowing up), while `Euler`/`Rk4` are explicit references used for solver-
/// agreement validation, at a materially higher per-step cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum OdeSolverKind {
    #[default]
    SemiImplicitEuler,
    Euler,
    Rk4,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LtcConfig {
    pub input_size: usize,
    pub hidden_size: usize,
    pub output_size: Option<usize>,

    /// Internal integration steps per `step()` call (liquid-ai.md §18): `dt_sub = Δt / N`.
    pub ode_unfolds: usize,
    pub solver: OdeSolverKind,

    pub epsilon: f64,

    pub input_mapping: MappingType,
    pub output_mapping: MappingType,

    pub wiring: WiringConfig,
}

impl LtcConfig {
    pub fn new(input_size: usize, hidden_size: usize) -> Self {
        Self {
            input_size,
            hidden_size,
            output_size: None,
            ode_unfolds: 6,
            solver: OdeSolverKind::default(),
            epsilon: 1e-8,
            input_mapping: MappingType::default(),
            output_mapping: MappingType::default(),
            wiring: WiringConfig::default(),
        }
    }
}
