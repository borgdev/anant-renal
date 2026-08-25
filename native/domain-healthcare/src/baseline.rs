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

use domain_kit::BaselineDynamics;

pub const ABNORMAL_VITAL_READING: usize = 0;
pub const FEVER_SPIKE: usize = 1;
pub const MISSED_MEDICATION: usize = 2;
pub const LAB_MARKER_ELEVATED: usize = 3;

pub const VITALS_INSTABILITY: usize = 0;
pub const INFECTION_MARKER: usize = 1;
pub const TREATMENT_RESPONSE: usize = 2;
pub const MOBILITY: usize = 3;
pub const DETERIORATION_RISK: usize = 4;

/// A post-operative monitoring ODE: vitals instability and infection markers rise from
/// clinical events, treatment response (efficacy of the current care plan) erodes when
/// medication is missed, mobility declines with instability/infection, and deterioration risk
/// accumulates from all three while treatment response and time work against it.
pub struct HealthcareBaseline;

impl BaselineDynamics for HealthcareBaseline {
    fn delta(&self, state: &[f32], event: &[f32], dt: f32) -> Vec<f32> {
        let vitals_instability = state[VITALS_INSTABILITY];
        let infection_marker = state[INFECTION_MARKER];
        let treatment_response = state[TREATMENT_RESPONSE];
        let mobility = state[MOBILITY];
        let deterioration_risk = state[DETERIORATION_RISK];

        let d_vitals_instability =
            0.6 * event[ABNORMAL_VITAL_READING] * (1.0 - vitals_instability) - 0.12 * vitals_instability;
        let d_infection_marker = 0.5 * event[FEVER_SPIKE] * (1.0 - infection_marker)
            + 0.4 * event[LAB_MARKER_ELEVATED] * (1.0 - infection_marker)
            - 0.08 * infection_marker;
        let d_treatment_response = -0.4 * event[MISSED_MEDICATION] * treatment_response + 0.05 * (1.0 - treatment_response);
        let d_mobility =
            -0.15 * infection_marker * mobility - 0.1 * vitals_instability * mobility + 0.04 * treatment_response * (1.0 - mobility);
        let d_deterioration_risk = 0.35 * vitals_instability * (1.0 - deterioration_risk)
            + 0.35 * infection_marker * (1.0 - deterioration_risk)
            + 0.2 * (1.0 - mobility) * (1.0 - deterioration_risk)
            - 0.2 * treatment_response * deterioration_risk
            - 0.05 * deterioration_risk;

        vec![
            d_vitals_instability * dt,
            d_infection_marker * dt,
            d_treatment_response * dt,
            d_mobility * dt,
            d_deterioration_risk * dt,
        ]
    }
}
