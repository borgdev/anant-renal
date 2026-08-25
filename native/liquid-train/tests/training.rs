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

use candle_core::Device;
use domain_healthcare::HealthcareDomain;
use liquid_train::{evaluate_mae, train, ModelKind, TrainingConfig};

/// The acceptance gate from liquid-ai.md §78/§81: training must materially reduce loss on the
/// synthetic residual-prediction task, and the trained model's held-out MAE must beat the
/// "predict zero residual" baseline. If this doesn't hold, the architecture isn't adding
/// anything a zero-residual assumption doesn't already capture.
#[test]
fn cfc_training_reduces_loss_and_beats_zero_baseline() {
    let device = Device::Cpu;
    let pack = HealthcareDomain::default();

    let config = TrainingConfig {
        model_kind: ModelKind::Cfc,
        epochs: 15,
        learning_rate: 3e-2,
        num_sequences: 16,
        sequence_length: 24,
        gradient_clip: Some(1.0),
        seed: 11,
        ..Default::default()
    };

    let mut losses = Vec::new();
    let (model, _varmap) = train(&pack, &config, &device, |metric| losses.push(metric.loss)).unwrap();

    assert_eq!(losses.len(), config.epochs);
    for loss in &losses {
        assert!(loss.is_finite(), "loss must stay finite through training");
    }

    let first = losses[0];
    let last = *losses.last().unwrap();
    assert!(last < first, "loss should decrease over training: first={first} last={last}");

    let zero_baseline_mae = evaluate_mae(&pack, None, &config, &device).unwrap();
    let trained_mae = evaluate_mae(&pack, Some(&model), &config, &device).unwrap();
    assert!(
        trained_mae < zero_baseline_mae,
        "trained model should beat the zero-residual baseline on held-out data: trained={trained_mae} zero={zero_baseline_mae}"
    );
}

#[test]
fn ltc_training_runs_and_stays_finite() {
    let device = Device::Cpu;
    let pack = HealthcareDomain::default();

    let config = TrainingConfig {
        model_kind: ModelKind::Ltc,
        epochs: 5,
        learning_rate: 1e-2,
        num_sequences: 6,
        sequence_length: 12,
        gradient_clip: Some(1.0),
        seed: 3,
        ..Default::default()
    };

    let mut losses = Vec::new();
    let (model, _varmap) = train(&pack, &config, &device, |metric| losses.push(metric.loss)).unwrap();

    assert_eq!(losses.len(), config.epochs);
    for loss in &losses {
        assert!(loss.is_finite());
    }

    let mae = evaluate_mae(&pack, Some(&model), &config, &device).unwrap();
    assert!(mae.is_finite());
}
