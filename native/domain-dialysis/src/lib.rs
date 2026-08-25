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

//! Dialysis domain pack — in-center HD / home HD / PD patient trajectories.
//!
//! Five state dimensions model a dialysis patient's clinical trajectory:
//! `vitals_instability`, `deterioration_risk` (composite), `ktv_adequacy` (high = good),
//! `phosphate` (high = bad), and `anemia_severity` (high = bad). A deterministic hand-authored
//! baseline ODE (`DialysisBaseline`) captures the well-known dynamics (missed treatments erode
//! Kt/V and worsen anemia/phosphate; access complications and vitals instability push
//! deterioration risk up; treatment restores equilibrium). The CfC/LTC learned residual
//! corrects the baseline from data: `ΔX_final = ΔX_baseline + α · R_θ`.
//!
//! This is the harness's replacement for its original hand-authored physiology
//! (`src/realm/ambient.ts::draw()` / `PatientTrajectoryProcess`) — the K/HGB/URR/PHOS lab
//! values it simulated map onto `ktv_adequacy`, `anemia_severity`, and `phosphate` here.

mod baseline;

use domain_kit::{
    AttributeField, AttributeKind, BaselineDynamics, Comparator, DomainPack, EntityProfile,
    EntityStateSchema, EventFeatureSchema, InterventionSpec, ObserverRule, PopulationSpec,
    PulseScenario, PulseStep, RuleNode, RuleTerm, ScenarioGenerator, SegmentSpec, Severity,
    StateDimension,
};
use liquid_core::CfcConfig;

use crate::baseline::DialysisBaseline;

pub const DOMAIN_ID: &str = "dialysis";

pub struct DialysisDomain {
    state_schema: EntityStateSchema,
    event_schema: EventFeatureSchema,
    baseline: DialysisBaseline,
}

impl Default for DialysisDomain {
    fn default() -> Self {
        let dims = [
            ("vitals_instability", "Vitals Instability", "#2a78d6"),
            ("deterioration_risk", "Deterioration Risk", "#e87ba4"),
            ("ktv_adequacy", "Kt/V Adequacy", "#1baf7a"),
            ("phosphate", "Phosphate", "#eb6834"),
            ("anemia_severity", "Anemia Severity", "#eda100"),
        ];
        let dimensions = dims
            .into_iter()
            .map(|(key, label, color)| StateDimension {
                key: key.to_string(),
                label: label.to_string(),
                unit: None,
                min: 0.0,
                max: 1.0,
                color: color.to_string(),
            })
            .collect();

        Self {
            state_schema: EntityStateSchema { dimensions },
            event_schema: EventFeatureSchema {
                features: vec![
                    "missed_treatment".to_string(),
                    "access_complication".to_string(),
                    "lab_marker_elevated".to_string(),
                    "abnormal_vital_reading".to_string(),
                    "diet_phosphate_violation".to_string(),
                ],
            },
            baseline: DialysisBaseline,
        }
    }
}

impl DomainPack for DialysisDomain {
    fn id(&self) -> &str {
        DOMAIN_ID
    }

    fn title(&self) -> &str {
        "Dialysis"
    }

    fn description(&self) -> &str {
        "In-center HD / home HD / PD patients — Kt/V adequacy, phosphate, and anemia \
         trajectories evolving into an early-warning deterioration-risk signal."
    }

    fn state_schema(&self) -> &EntityStateSchema {
        &self.state_schema
    }

    fn event_feature_schema(&self) -> &EventFeatureSchema {
        &self.event_schema
    }

    fn baseline(&self) -> &dyn BaselineDynamics {
        &self.baseline
    }

    fn cfc_config(&self) -> CfcConfig {
        let mut config = CfcConfig::new(self.event_schema.len(), 16);
        config.output_size = Some(self.state_schema.len());
        config.backbone_layers = 1;
        config.backbone_units = 32;
        config
    }

    fn default_observer_rules(&self) -> Vec<ObserverRule> {
        vec![
            ObserverRule {
                id: "ktv-below-threshold".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Kt/V below threshold".to_string(),
                condition: RuleNode::Cmp {
                    lhs: RuleTerm::State { dim: "ktv_adequacy".to_string() },
                    op: Comparator::Lt,
                    rhs: RuleTerm::Const { value: 0.35 },
                },
                severity: Severity::Critical,
                message: "Kt/V adequacy has dropped below 0.35 — dialysis adequacy at risk.".to_string(),
                enabled: true,
            },
            ObserverRule {
                id: "rapid-deterioration".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Rapid deterioration".to_string(),
                condition: RuleNode::Cmp {
                    lhs: RuleTerm::Velocity { dim: "deterioration_risk".to_string() },
                    op: Comparator::Gt,
                    rhs: RuleTerm::Const { value: 0.12 },
                },
                severity: Severity::Serious,
                message: "Deterioration risk is climbing quickly (d/dt > 0.12).".to_string(),
                enabled: true,
            },
            ObserverRule {
                id: "phosphate-compound".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Hyperphosphatemia + instability".to_string(),
                condition: RuleNode::And {
                    terms: vec![
                        RuleNode::Cmp {
                            lhs: RuleTerm::State { dim: "phosphate".to_string() },
                            op: Comparator::Gt,
                            rhs: RuleTerm::Const { value: 0.5 },
                        },
                        RuleNode::Cmp {
                            lhs: RuleTerm::State { dim: "vitals_instability".to_string() },
                            op: Comparator::Gt,
                            rhs: RuleTerm::Const { value: 0.5 },
                        },
                    ],
                },
                severity: Severity::Critical,
                message: "Elevated phosphate combined with vitals instability.".to_string(),
                enabled: true,
            },
        ]
    }

    fn default_interventions(&self) -> Vec<InterventionSpec> {
        vec![
            InterventionSpec {
                id: "adjust-dialysis-prescription".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Adjust dialysis prescription".to_string(),
                description: "Increase dialysis dose / frequency to restore Kt/V adequacy.".to_string(),
                cost: 2.0,
                effect: vec![("ktv_adequacy".to_string(), 0.25), ("phosphate".to_string(), -0.15)],
            },
            InterventionSpec {
                id: "dietitian-nudge".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Dietitian nudge".to_string(),
                description: "Reinforce phosphate-binder adherence and diet.".to_string(),
                cost: 0.5,
                effect: vec![("phosphate".to_string(), -0.2), ("deterioration_risk".to_string(), -0.05)],
            },
            InterventionSpec {
                id: "escalate-nephrologist".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Escalate to nephrologist".to_string(),
                description: "Immediate nephrology review.".to_string(),
                cost: 3.0,
                effect: vec![("deterioration_risk".to_string(), -0.25), ("vitals_instability".to_string(), -0.15)],
            },
        ]
    }

    fn seed_entities(&self) -> Vec<(String, String)> {
        vec![
            ("patient-d01".to_string(), "Patient D01 — Chair 6 · In-Center HD".to_string()),
            ("patient-d02".to_string(), "Patient D02 — Chair 12 · In-Center HD".to_string()),
            ("patient-d03".to_string(), "Patient D03 — Home HD / PD".to_string()),
        ]
    }

    fn showcase_entities(&self) -> Vec<EntityProfile> {
        vec![
            EntityProfile::new(
                "patient-d01",
                "Patient D01 — Chair 6 · In-Center HD",
                &[("shift_schedule", "MWF"), ("access_type", "fistula"), ("vintage_years", "8"), ("dm_status", "dm"), ("phos_binder_adherence", "good"), ("complication_cost_usd", "42000")],
                true,
            ),
            EntityProfile::new(
                "patient-d02",
                "Patient D02 — Chair 12 · In-Center HD",
                &[("shift_schedule", "TTS"), ("access_type", "graft"), ("vintage_years", "3"), ("dm_status", "none"), ("phos_binder_adherence", "partial"), ("complication_cost_usd", "28000")],
                true,
            ),
            EntityProfile::new(
                "patient-d03",
                "Patient D03 — Home HD / PD",
                &[("shift_schedule", "home"), ("access_type", "pd"), ("vintage_years", "2"), ("dm_status", "none"), ("phos_binder_adherence", "good"), ("complication_cost_usd", "19000")],
                true,
            ),
        ]
    }

    fn attribute_schema(&self) -> Vec<AttributeField> {
        vec![
            AttributeField { key: "shift_schedule".into(), label: "Shift schedule".into(), kind: AttributeKind::Text },
            AttributeField { key: "access_type".into(), label: "Access type".into(), kind: AttributeKind::Text },
            AttributeField { key: "vintage_years".into(), label: "Vintage (years)".into(), kind: AttributeKind::Number },
            AttributeField { key: "dm_status".into(), label: "Diabetes status".into(), kind: AttributeKind::Text },
            AttributeField { key: "phos_binder_adherence".into(), label: "Phosphate-binder adherence".into(), kind: AttributeKind::Text },
            AttributeField { key: "complication_cost_usd".into(), label: "Complication cost (USD)".into(), kind: AttributeKind::Number },
        ]
    }

    fn population_spec(&self) -> Option<PopulationSpec> {
        Some(PopulationSpec {
            id_prefix: "pt",
            base_attributes: Vec::new(),
            name_words: &["Bay", "Chair", "Shift", "Unit", "Pod", "Dialyzer", "Access", "KtV", "Phos", "Hemo"],
            segments: vec![
                SegmentSpec {
                    label_suffix: " — Shift A · In-Center HD",
                    count: 180,
                    attributes: vec![("shift_schedule", "MWF"), ("access_type", "fistula")],
                    pools: vec![("dm_status", &["none", "dm"]), ("phos_binder_adherence", &["good", "partial", "poor"])],
                    numeric: vec![("vintage_years", 1, 15), ("complication_cost_usd", 10_000, 45_000)],
                },
                SegmentSpec {
                    label_suffix: " — Shift B · In-Center HD",
                    count: 180,
                    attributes: vec![("shift_schedule", "TTS"), ("access_type", "graft")],
                    pools: vec![("dm_status", &["none", "dm"]), ("phos_binder_adherence", &["good", "partial", "poor"])],
                    numeric: vec![("vintage_years", 1, 12), ("complication_cost_usd", 12_000, 50_000)],
                },
                SegmentSpec {
                    label_suffix: " — Home HD / PD",
                    count: 100,
                    attributes: vec![("shift_schedule", "home"), ("access_type", "pd")],
                    pools: vec![("dm_status", &["none", "dm"]), ("phos_binder_adherence", &["good", "partial"])],
                    numeric: vec![("vintage_years", 1, 8), ("complication_cost_usd", 8_000, 30_000)],
                },
                SegmentSpec {
                    label_suffix: " — High-Risk (Catheter)",
                    count: 60,
                    attributes: vec![("shift_schedule", "MWF"), ("access_type", "catheter")],
                    pools: vec![("dm_status", &["dm"]), ("phos_binder_adherence", &["partial", "poor"])],
                    numeric: vec![("vintage_years", 1, 10), ("complication_cost_usd", 25_000, 80_000)],
                },
            ],
        })
    }

    fn population_seed(&self) -> u64 {
        7
    }

    fn primary_risk_key(&self) -> &str {
        "deterioration_risk"
    }

    fn value_attribute(&self) -> Option<&str> {
        Some("complication_cost_usd")
    }

    fn new_scenario(&self, seed: u64) -> Box<dyn ScenarioGenerator> {
        let steps = vec![
            PulseStep { at: 6.0, index: baseline::MISSED_TREATMENT, label: "missed_treatment" },
            PulseStep { at: 14.0, index: baseline::DIET_PHOSPHATE_VIOLATION, label: "diet_phosphate_violation" },
            PulseStep { at: 21.0, index: baseline::ACCESS_COMPLICATION, label: "access_complication" },
            PulseStep { at: 29.0, index: baseline::LAB_MARKER_ELEVATED, label: "lab_marker_elevated" },
            PulseStep { at: 37.0, index: baseline::ABNORMAL_VITAL_READING, label: "abnormal_vital_reading" },
        ];
        Box::new(PulseScenario::new(self.event_schema.len(), steps, 80.0, 7.0, seed))
    }

    fn initial_state(&self) -> Vec<f32> {
        // vitals_instability, deterioration_risk, ktv_adequacy, phosphate, anemia_severity
        // — a treated, adherent patient near equilibrium.
        vec![0.15, 0.12, 0.75, 0.45, 0.25]
    }
}
