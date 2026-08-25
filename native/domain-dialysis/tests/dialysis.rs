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

//! Phase 2 acceptance tests for the dialysis domain pack:
//!   • the baseline ODE behaves correctly in isolation (missed treatment erodes Kt/V, diet
//!     violations raise phosphate, a treated patient recovers),
//!   • observer rules fire exactly when their conditions hold,
//!   • intervention deltas land on the right dimensions,
//!   • CfC config input/output sizes match the schemas,
//!   • the seeded scenario generator is deterministic.

use domain_dialysis::DialysisDomain;
use domain_kit::{DomainPack, EntityStateSchema, EvalContext};

fn domain() -> DialysisDomain {
    DialysisDomain::default()
}

fn ctx_for<'a>(schema: &'a EntityStateSchema, state: &'a [f32], velocity: &'a [f32]) -> EvalContext<'a> {
    EvalContext {
        schema,
        state,
        velocity,
        residual_magnitude: 0.0,
    }
}

// ---- Baseline ODE ----

#[test]
fn missed_treatment_erodes_ktv_adequacy() {
    let d = domain();
    let state = d.initial_state();
    let mut event = vec![0.0; d.event_feature_schema().len()];
    event[0] = 1.0; // missed_treatment
    let delta = d.baseline().delta(&state, &event, 1.0);
    let ktv = d.state_schema().index_of("ktv_adequacy").unwrap();
    assert!(delta[ktv] < 0.0, "missed treatment must erode Kt/V, got {}", delta[ktv]);
}

#[test]
fn missed_treatment_worsens_anemia() {
    let d = domain();
    let state = d.initial_state();
    let mut event = vec![0.0; d.event_feature_schema().len()];
    event[0] = 1.0; // missed_treatment
    let delta = d.baseline().delta(&state, &event, 1.0);
    let anemia = d.state_schema().index_of("anemia_severity").unwrap();
    assert!(delta[anemia] > 0.0, "missed treatment must worsen anemia, got {}", delta[anemia]);
}

#[test]
fn diet_phosphate_violation_raises_phosphate() {
    let d = domain();
    let state = d.initial_state();
    let mut event = vec![0.0; d.event_feature_schema().len()];
    event[4] = 1.0; // diet_phosphate_violation
    let delta = d.baseline().delta(&state, &event, 1.0);
    let phos = d.state_schema().index_of("phosphate").unwrap();
    assert!(delta[phos] > 0.0, "diet violation must raise phosphate, got {}", delta[phos]);
}

#[test]
fn abnormal_vitals_and_access_complication_raise_instability_and_risk() {
    let d = domain();
    let state = d.initial_state();
    let vitals = d.state_schema().index_of("vitals_instability").unwrap();
    let risk = d.state_schema().index_of("deterioration_risk").unwrap();

    let mut event = vec![0.0; d.event_feature_schema().len()];
    event[3] = 1.0; // abnormal_vital_reading
    let delta = d.baseline().delta(&state, &event, 1.0);
    assert!(delta[vitals] > 0.0);

    let mut event = vec![0.0; d.event_feature_schema().len()];
    event[1] = 1.0; // access_complication
    let delta = d.baseline().delta(&state, &event, 1.0);
    assert!(delta[vitals] > 0.0);
    assert!(delta[risk] > 0.0);
}

#[test]
fn treated_patient_recovers_toward_equilibrium() {
    // A patient mid-insult (low Kt/V, high phosphate, high anemia, unstable vitals) with no
    // fresh events should be recovering: Kt/V climbs, phosphate/anemia/vitals fall.
    let d = domain();
    let state = vec![0.5, 0.5, 0.3, 0.7, 0.7];
    let event = vec![0.0; d.event_feature_schema().len()];
    let delta = d.baseline().delta(&state, &event, 1.0);
    let schema = d.state_schema();
    assert!(delta[schema.index_of("ktv_adequacy").unwrap()] > 0.0, "Kt/V should recover");
    assert!(delta[schema.index_of("phosphate").unwrap()] < 0.0, "phosphate should clear");
    assert!(delta[schema.index_of("anemia_severity").unwrap()] < 0.0, "anemia should recover");
    assert!(delta[schema.index_of("vitals_instability").unwrap()] < 0.0, "vitals should stabilize");
}

#[test]
fn baseline_deltas_scale_with_dt() {
    let d = domain();
    let state = d.initial_state();
    let event = vec![1.0; d.event_feature_schema().len()];
    let dt1 = d.baseline().delta(&state, &event, 1.0);
    let dt2 = d.baseline().delta(&state, &event, 2.0);
    for (a, b) in dt1.iter().zip(&dt2) {
        assert!((b - 2.0 * a).abs() < 1e-5, "delta must scale linearly with dt: {a} vs {b}");
    }
}

// ---- Observer rules ----

#[test]
fn ktv_below_threshold_fires_below_and_not_above() {
    let d = domain();
    let rules = d.default_observer_rules();
    let rule = rules.iter().find(|r| r.id == "ktv-below-threshold").unwrap();
    let schema = d.state_schema();
    let ktv = schema.index_of("ktv_adequacy").unwrap();
    let velocity = vec![0.0; schema.len()];

    let mut state = vec![0.0; schema.len()];
    state[ktv] = 0.3;
    assert!(rule.fires(&ctx_for(schema, &state, &velocity)), "should fire when Kt/V < 0.35");

    state[ktv] = 0.6;
    assert!(!rule.fires(&ctx_for(schema, &state, &velocity)), "should not fire when Kt/V >= 0.35");
}

#[test]
fn rapid_deterioration_fires_on_velocity() {
    let d = domain();
    let rules = d.default_observer_rules();
    let rule = rules.iter().find(|r| r.id == "rapid-deterioration").unwrap();
    let schema = d.state_schema();
    let risk = schema.index_of("deterioration_risk").unwrap();
    let state = vec![0.0; schema.len()];

    let mut velocity = vec![0.0; schema.len()];
    velocity[risk] = 0.15;
    assert!(rule.fires(&ctx_for(schema, &state, &velocity)), "should fire when d(risk)/dt > 0.12");

    velocity[risk] = 0.05;
    assert!(!rule.fires(&ctx_for(schema, &state, &velocity)), "should not fire when d(risk)/dt <= 0.12");
}

#[test]
fn phosphate_compound_requires_both_conditions() {
    let d = domain();
    let rules = d.default_observer_rules();
    let rule = rules.iter().find(|r| r.id == "phosphate-compound").unwrap();
    let schema = d.state_schema();
    let phos = schema.index_of("phosphate").unwrap();
    let vitals = schema.index_of("vitals_instability").unwrap();
    let velocity = vec![0.0; schema.len()];

    let mut state = vec![0.0; schema.len()];
    state[phos] = 0.6;
    assert!(!rule.fires(&ctx_for(schema, &state, &velocity)), "phosphate alone should not fire");

    state[vitals] = 0.6;
    assert!(rule.fires(&ctx_for(schema, &state, &velocity)), "phosphate + vitals instability should fire");
}

// ---- Interventions ----

#[test]
fn adjust_prescription_raises_ktv_and_lowers_phosphate() {
    let d = domain();
    let schema = d.state_schema();
    let spec = d.default_interventions().into_iter().find(|i| i.id == "adjust-dialysis-prescription").unwrap();
    let ktv = schema.index_of("ktv_adequacy").unwrap();
    let phos = schema.index_of("phosphate").unwrap();

    let mut state = d.initial_state();
    let before = state.clone();
    spec.apply(schema, &mut state);
    assert!((state[ktv] - before[ktv] - 0.25).abs() < 1e-6, "Kt/V should rise by 0.25");
    assert!((state[phos] - before[phos] + 0.15).abs() < 1e-6, "phosphate should fall by 0.15");
}

#[test]
fn dietitian_nudge_lowers_phosphate_and_risk() {
    let d = domain();
    let schema = d.state_schema();
    let spec = d.default_interventions().into_iter().find(|i| i.id == "dietitian-nudge").unwrap();
    let phos = schema.index_of("phosphate").unwrap();
    let risk = schema.index_of("deterioration_risk").unwrap();

    let mut state = d.initial_state();
    let before = state.clone();
    spec.apply(schema, &mut state);
    assert!(state[phos] < before[phos]);
    assert!(state[risk] < before[risk]);
}

#[test]
fn escalate_nephrologist_lowers_risk_and_vitals() {
    let d = domain();
    let schema = d.state_schema();
    let spec = d.default_interventions().into_iter().find(|i| i.id == "escalate-nephrologist").unwrap();
    let risk = schema.index_of("deterioration_risk").unwrap();
    let vitals = schema.index_of("vitals_instability").unwrap();

    let mut state = d.initial_state();
    let before = state.clone();
    spec.apply(schema, &mut state);
    assert!(state[risk] < before[risk]);
    assert!(state[vitals] < before[vitals]);
}

// ---- Config + schema invariants ----

#[test]
fn cfc_config_input_output_match_schemas() {
    let d = domain();
    let cfg = d.cfc_config();
    assert_eq!(cfg.input_size, d.event_feature_schema().len(), "CfC input must match event features");
    assert_eq!(cfg.output_size, Some(d.state_schema().len()), "CfC output must match state dims");
}

#[test]
fn initial_state_matches_schema_bounds() {
    let d = domain();
    let schema = d.state_schema();
    let state = d.initial_state();
    assert_eq!(state.len(), schema.len());
    for (v, dim) in state.iter().zip(&schema.dimensions) {
        assert!(*v >= dim.min && *v <= dim.max, "initial state {v} out of bounds for {}", dim.key);
    }
}

// ---- Scenario determinism ----

#[test]
fn scenario_is_deterministic_per_seed() {
    let d = domain();
    let mut a = d.new_scenario(42);
    let mut b = d.new_scenario(42);
    let mut ea = Vec::new();
    let mut eb = Vec::new();
    for t in 0..200 {
        let t_s = t as f32 * 0.5;
        ea.push(a.next_event(t_s, 0.5));
        eb.push(b.next_event(t_s, 0.5));
    }
    assert_eq!(ea, eb, "same seed must produce an identical event stream");
}
