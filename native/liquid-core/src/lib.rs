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

//! Native Rust/Candle implementation of Closed-form Continuous-time (CfC) and Liquid
//! Time-Constant (LTC) networks — see `liquid-ai.md` at the repo root for the full engineering
//! spec this crate implements incrementally, and `docs/ROADMAP.md` for what's landed so far.
//!
//! - [`cell::CfcCell`] / [`sequence::Cfc`]: dense wiring, [`config::CfcMode::Default`] only.
//! - [`cell::LtcCell`] / [`sequence::Ltc`]: conductance-based ODE, Dense/Sparse/Ncp wiring,
//!   three solvers (semi-implicit Euler production, Euler/RK4 references).
//! - [`model::LiquidModel`]: runtime enum unifying the two for callers that don't care which
//!   backs a given domain.
//!
//! Training (autograd optimizer state, datasets, checkpoints) lives in the separate
//! `liquid-train` crate so this one stays inference-only and wasm-buildable.

pub mod activation;
pub mod backbone;
pub mod cell;
pub mod config;
pub mod error;
pub mod mapping;
pub mod model;
pub mod sequence;
pub mod serialization;
pub mod wiring;

pub use cell::{CfcCell, ContinuousTimeCell, LtcCell};
pub use config::{ActivationKind, CfcConfig, CfcMode, LtcConfig, MappingType, OdeSolverKind, WiringConfig};
pub use error::{LiquidError, Result};
pub use model::{LiquidForwardOutput, LiquidModel, LiquidStepOutput};
pub use sequence::{Cfc, CfcOutput, Ltc, LtcOutput};
