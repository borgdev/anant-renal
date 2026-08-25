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

use liquid_core::{CfcConfig, LtcConfig};

use crate::baseline::BaselineDynamics;
use crate::intervention::InterventionSpec;
use crate::observer::ObserverRule;
use crate::population::{generate_population, AttributeField, EntityProfile, PopulationSpec};
use crate::schema::{EntityStateSchema, EventFeatureSchema};
use crate::scenario::ScenarioGenerator;

/// Ties a state schema, event-feature schema, baseline dynamics, CfC config, seed
/// rules/interventions, and a synthetic scenario generator into one registrable demo domain
/// (liquid-ai.md's "Domain Pack" concept from the project plan).
pub trait DomainPack: Send + Sync {
    fn id(&self) -> &str;
    fn title(&self) -> &str;
    fn description(&self) -> &str;

    fn state_schema(&self) -> &EntityStateSchema;
    fn event_feature_schema(&self) -> &EventFeatureSchema;

    fn baseline(&self) -> &dyn BaselineDynamics;

    /// CfC input_size must equal `event_feature_schema().len()`; output_size must equal
    /// `state_schema().len()` so the CfC's projected output aligns with the baseline ΔX it's
    /// a residual on (`ResidualDynamics` mode, liquid-ai.md §29).
    fn cfc_config(&self) -> CfcConfig;

    /// LTC counterpart to `cfc_config` — same input/output sizing, so it's a drop-in
    /// alternative for the residual role (used by the Model Comparison and Training Workbench
    /// pages). Default derives sizing from `cfc_config()`, dense wiring, semi-implicit Euler;
    /// override for domain-specific LTC tuning (wiring, `ode_unfolds`, solver).
    fn ltc_config(&self) -> LtcConfig {
        let cfc = self.cfc_config();
        let mut ltc = LtcConfig::new(cfc.input_size, cfc.hidden_size);
        ltc.output_size = cfc.output_size;
        ltc
    }

    /// Default weight `α` in `ΔX_final = ΔX_baseline + α · R_θ` (liquid-ai.md's architecture
    /// diagram, §2) — kept small by default since the seed model is randomly initialized
    /// (untrained) until Phase 4's training workbench exists.
    fn residual_alpha(&self) -> f32 {
        0.15
    }

    fn default_observer_rules(&self) -> Vec<ObserverRule>;
    fn default_interventions(&self) -> Vec<InterventionSpec>;

    /// Initial state for a freshly seeded entity. Override when the schema's zero vector isn't
    /// semantically sensible (e.g. a "trust" dimension shouldn't start at its floor).
    fn initial_state(&self) -> Vec<f32> {
        self.state_schema().zero_state()
    }

    /// `(entity_id, label)` pairs seeded at startup so the demo has something to watch
    /// immediately. Legacy entry point — the server now builds the world from `population()`,
    /// which defaults to this list (all spotlight, no attributes) for backward compat.
    fn seed_entities(&self) -> Vec<(String, String)>;

    /// Hand-authored spotlight entities (named showcase accounts/patients/… with rich
    /// attributes) prepended to the generated population. Defaults to none.
    fn showcase_entities(&self) -> Vec<EntityProfile> {
        Vec::new()
    }

    /// The population spec for this domain — rich packs return `Some` so the server can seed
    /// and scale a large record set in SQLite (`docs/ENTERPRISE_DEMO.md`). Domains without a
    /// spec fall back to `seed_entities()` (all spotlight, no attributes).
    fn population_spec(&self) -> Option<PopulationSpec> {
        None
    }

    /// Seed for the deterministic population generator — same seed + scale ⇒ same world every
    /// restart, so demo numbers are reproducible.
    fn population_seed(&self) -> u64 {
        42
    }

    /// How many spotlight (full-model + broadcast) entities each segment contributes.
    fn spotlight_per_segment(&self) -> usize {
        3
    }

    /// The full population for this domain at `scale` (1× base counts). The server calls this
    /// when seeding SQLite so "load larger records" is just a scale factor.
    fn scaled_population(&self, scale: u32) -> Vec<EntityProfile> {
        let mut profiles = self.showcase_entities();
        if let Some(spec) = self.population_spec() {
            profiles.extend(generate_population(&spec, self.population_seed(), self.spotlight_per_segment(), scale));
        } else {
            profiles.extend(
                self.seed_entities()
                    .into_iter()
                    .map(|(id, label)| EntityProfile::new(id, label, &[], true)),
            );
        }
        profiles
    }

    /// The full entity population for this domain (default 1× scale). Backward-compatible
    /// default: `seed_entities()`.
    fn population(&self) -> Vec<EntityProfile> {
        self.scaled_population(1)
    }

    /// Declared entity attributes, so the UI can label/filter by them generically.
    fn attribute_schema(&self) -> Vec<AttributeField> {
        Vec::new()
    }

    /// The state dimension treated as this domain's primary risk output — used by the
    /// analytics layer to rank entities and compute risk-band distributions. Defaults to the
    /// last dimension in the schema.
    fn primary_risk_key(&self) -> &str {
        self.state_schema()
            .dimensions
            .last()
            .map(|d| d.key.as_str())
            .unwrap_or("")
    }

    /// The generated-population attribute holding this entity's economic value in USD (e.g.
    /// `mrr_usd` for churn, `replacement_cost_usd` for IoT) — the basis for "revenue/exposure
    /// at risk" (`exposure_usd = value_attribute × primary_risk × value_multiplier`). `None` if
    /// the domain has no natural per-entity dollar figure.
    fn value_attribute(&self) -> Option<&str> {
        None
    }

    /// Multiplier applied to `value_attribute × primary_risk` to get "exposure" in dollars —
    /// e.g. churn annualizes MRR (×12) to get ARR at risk. Defaults to 1.0 (the attribute is
    /// already the right unit, e.g. a one-time replacement or incident cost).
    fn value_multiplier(&self) -> f32 {
        1.0
    }

    /// Max number of entities that run the full learned model each tick (tiered simulation).
    /// The rest of the population runs baseline-only dynamics server-side.
    fn sim_budget(&self) -> usize {
        16
    }

    /// Max trajectory points kept per entity (server-side history ring buffer for entity 360°
    /// and analytics, independent of what the client was watching live).
    fn history_capacity(&self) -> usize {
        90
    }

    /// A fresh, independently-seeded scenario generator for one entity.
    fn new_scenario(&self, seed: u64) -> Box<dyn ScenarioGenerator>;
}
