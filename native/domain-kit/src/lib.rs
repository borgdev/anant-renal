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

//! Generic metadata/rules primitives that domain packs and the UI editors build on: entity
//! state schema, wiring choice, baseline (deterministic "manifold stand-in") dynamics,
//! observer rules, interventions, and the `DomainPack` trait that ties them together.
//! See `docs/ROADMAP.md` for the phased plan this crate is part of.

mod baseline;
mod domain_pack;
mod intervention;
mod observer;
mod population;
mod schema;
mod scenario;

pub use baseline::BaselineDynamics;
pub use domain_pack::DomainPack;
pub use intervention::InterventionSpec;
pub use observer::{Comparator, EvalContext, ObserverRule, RuleNode, RuleTerm, Severity};
pub use population::{generate_population, AttributeField, AttributeKind, EntityProfile, PopulationSpec, SegmentSpec};
pub use schema::{EntityStateSchema, EventFeatureSchema, StateDimension};
pub use scenario::{PulseScenario, PulseStep, ScenarioGenerator};
