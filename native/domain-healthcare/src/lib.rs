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

mod baseline;

use domain_kit::{
    AttributeField, AttributeKind, BaselineDynamics, Comparator, DomainPack, EntityProfile,
    EntityStateSchema, EventFeatureSchema, InterventionSpec, ObserverRule, PopulationSpec,
    PulseScenario, PulseStep, RuleNode, RuleTerm, ScenarioGenerator, SegmentSpec, Severity,
    StateDimension,
};
use liquid_core::CfcConfig;

use crate::baseline::HealthcareBaseline;

pub const DOMAIN_ID: &str = "healthcare";

pub struct HealthcareDomain {
    state_schema: EntityStateSchema,
    event_schema: EventFeatureSchema,
    baseline: HealthcareBaseline,
}

impl Default for HealthcareDomain {
    fn default() -> Self {
        let dims = [
            ("vitals_instability", "Vitals Instability", "#2a78d6"),
            ("infection_marker", "Infection Marker", "#eb6834"),
            ("treatment_response", "Treatment Response", "#1baf7a"),
            ("mobility", "Mobility", "#eda100"),
            ("deterioration_risk", "Deterioration Risk", "#e87ba4"),
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
                    "abnormal_vital_reading".to_string(),
                    "fever_spike".to_string(),
                    "missed_medication".to_string(),
                    "lab_marker_elevated".to_string(),
                ],
            },
            baseline: HealthcareBaseline,
        }
    }
}

impl DomainPack for HealthcareDomain {
    fn id(&self) -> &str {
        DOMAIN_ID
    }

    fn title(&self) -> &str {
        "Healthcare"
    }

    fn description(&self) -> &str {
        "Post-operative monitoring — vitals, infection markers, and treatment response \
         evolving into an early-warning deterioration-risk trajectory."
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
                id: "high-deterioration-risk".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "High deterioration risk".to_string(),
                condition: RuleNode::Cmp {
                    lhs: RuleTerm::State { dim: "deterioration_risk".to_string() },
                    op: Comparator::Gt,
                    rhs: RuleTerm::Const { value: 0.7 },
                },
                severity: Severity::Critical,
                message: "Deterioration risk has crossed 0.7.".to_string(),
                enabled: true,
            },
            ObserverRule {
                id: "rapid-decline".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Rapid decline".to_string(),
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
                id: "infection-instability-compound".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Infection + instability".to_string(),
                condition: RuleNode::And {
                    terms: vec![
                        RuleNode::Cmp {
                            lhs: RuleTerm::State { dim: "infection_marker".to_string() },
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
                message: "Elevated infection marker combined with vitals instability.".to_string(),
                enabled: true,
            },
        ]
    }

    fn default_interventions(&self) -> Vec<InterventionSpec> {
        vec![
            InterventionSpec {
                id: "adjust-medication".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Adjust medication".to_string(),
                description: "Revise the medication plan.".to_string(),
                cost: 1.5,
                effect: vec![("treatment_response".to_string(), 0.3), ("infection_marker".to_string(), -0.15)],
            },
            InterventionSpec {
                id: "increase-monitoring".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Increase monitoring".to_string(),
                description: "Move to continuous vitals monitoring.".to_string(),
                cost: 1.0,
                effect: vec![("deterioration_risk".to_string(), -0.1)],
            },
            InterventionSpec {
                id: "escalate-physician".to_string(),
                domain_id: DOMAIN_ID.to_string(),
                name: "Escalate to physician".to_string(),
                description: "Immediate physician review.".to_string(),
                cost: 3.0,
                effect: vec![("deterioration_risk".to_string(), -0.25), ("vitals_instability".to_string(), -0.15)],
            },
        ]
    }

    fn seed_entities(&self) -> Vec<(String, String)> {
        vec![
            ("patient-a12".to_string(), "Patient A12 — Post-Op Ward".to_string()),
            ("patient-b07".to_string(), "Patient B07 — Post-Op Ward".to_string()),
            ("patient-c19".to_string(), "Patient C19 — ICU Step-Down".to_string()),
        ]
    }

    fn showcase_entities(&self) -> Vec<EntityProfile> {
        vec![
            EntityProfile::new(
                "patient-a12",
                "Patient A12 — Post-Op Ward",
                &[("ward", "Post-Op Ward"), ("age_band", "56-70"), ("comorbidity", "hypertension"), ("monitoring_level", "standard"), ("admit_days", "3")],
                true,
            ),
            EntityProfile::new(
                "patient-b07",
                "Patient B07 — Post-Op Ward",
                &[("ward", "Post-Op Ward"), ("age_band", "36-55"), ("comorbidity", "none"), ("monitoring_level", "standard"), ("admit_days", "2")],
                true,
            ),
            EntityProfile::new(
                "patient-c19",
                "Patient C19 — ICU Step-Down",
                &[("ward", "ICU Step-Down"), ("age_band", "71+"), ("comorbidity", "diabetes"), ("monitoring_level", "high"), ("admit_days", "6")],
                true,
            ),
        ]
    }

    fn attribute_schema(&self) -> Vec<AttributeField> {
        vec![
            AttributeField { key: "ward".into(), label: "Ward".into(), kind: AttributeKind::Text },
            AttributeField { key: "age_band".into(), label: "Age band".into(), kind: AttributeKind::Text },
            AttributeField { key: "comorbidity".into(), label: "Comorbidity".into(), kind: AttributeKind::Text },
            AttributeField { key: "monitoring_level".into(), label: "Monitoring".into(), kind: AttributeKind::Text },
            AttributeField { key: "admit_days".into(), label: "Admit days".into(), kind: AttributeKind::Number },
            AttributeField { key: "complication_cost_usd".into(), label: "Complication cost (USD)".into(), kind: AttributeKind::Number },
        ]
    }

    fn population_spec(&self) -> Option<PopulationSpec> {
        Some(PopulationSpec {
            id_prefix: "pt",
            base_attributes: Vec::new(),
            name_words: &["Ward", "Med", "Care", "Recovery", "Therapy", "Vitals", "Acute", "Post", "Step", "Tele"],
            segments: vec![
                SegmentSpec {
                    label_suffix: " — Post-Op Ward",
                    count: 200,
                    attributes: vec![("ward", "Post-Op Ward"), ("monitoring_level", "standard")],
                    pools: vec![("age_band", &["18-35", "36-55", "56-70", "71+"]), ("comorbidity", &["none", "hypertension", "diabetes", "copd"])],
                    numeric: vec![("admit_days", 1, 8), ("complication_cost_usd", 8_000, 25_000)],
                },
                SegmentSpec {
                    label_suffix: " — ICU Step-Down",
                    count: 150,
                    attributes: vec![("ward", "ICU Step-Down"), ("monitoring_level", "high")],
                    pools: vec![("age_band", &["36-55", "56-70", "71+"]), ("comorbidity", &["none", "hypertension", "diabetes", "copd"])],
                    numeric: vec![("admit_days", 2, 10), ("complication_cost_usd", 20_000, 60_000)],
                },
                SegmentSpec {
                    label_suffix: " — Oncology",
                    count: 150,
                    attributes: vec![("ward", "Oncology"), ("monitoring_level", "high")],
                    pools: vec![("age_band", &["36-55", "56-70", "71+"]), ("comorbidity", &["none", "hypertension", "diabetes"])],
                    numeric: vec![("admit_days", 2, 14), ("complication_cost_usd", 15_000, 80_000)],
                },
                SegmentSpec {
                    label_suffix: " — Telemetry",
                    count: 100,
                    attributes: vec![("ward", "Telemetry"), ("monitoring_level", "continuous")],
                    pools: vec![("age_band", &["18-35", "36-55", "56-70", "71+"]), ("comorbidity", &["none", "hypertension", "diabetes", "copd"])],
                    numeric: vec![("admit_days", 1, 5), ("complication_cost_usd", 6_000, 20_000)],
                },
            ],
        })
    }

    fn population_seed(&self) -> u64 {
        23
    }

    fn primary_risk_key(&self) -> &str {
        "deterioration_risk"
    }

    fn value_attribute(&self) -> Option<&str> {
        Some("complication_cost_usd")
    }

    fn new_scenario(&self, seed: u64) -> Box<dyn ScenarioGenerator> {
        let steps = vec![
            PulseStep { at: 6.0, index: 0, label: "abnormal_vital_reading" },
            PulseStep { at: 14.0, index: 2, label: "missed_medication" },
            PulseStep { at: 21.0, index: 1, label: "fever_spike" },
            PulseStep { at: 29.0, index: 3, label: "lab_marker_elevated" },
            PulseStep { at: 37.0, index: 0, label: "abnormal_vital_reading" },
        ];
        Box::new(PulseScenario::new(self.event_schema.len(), steps, 80.0, 7.0, seed))
    }

    fn initial_state(&self) -> Vec<f32> {
        // vitals_instability, infection_marker, treatment_response, mobility,
        // deterioration_risk — a stable patient responding to treatment.
        vec![0.1, 0.05, 0.6, 0.8, 0.1]
    }
}
