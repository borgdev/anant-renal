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

use candle_core::{DType, Device, Tensor};
use candle_nn::{VarBuilder, VarMap};

use liquid_core::{Cfc, CfcConfig, ContinuousTimeCell};

fn build_model(input_size: usize, hidden_size: usize, output_size: Option<usize>) -> (Cfc, Device) {
    let device = Device::Cpu;
    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DType::F32, &device);
    let mut config = CfcConfig::new(input_size, hidden_size);
    config.output_size = output_size;
    let model = Cfc::new(config, vb).expect("model should build");
    (model, device)
}

fn assert_all_finite(t: &Tensor) {
    let values = t.flatten_all().unwrap().to_vec1::<f32>().unwrap();
    for v in values {
        assert!(v.is_finite(), "expected finite value, got {v}");
    }
}

#[test]
fn cfc_single_step() {
    let (model, device) = build_model(4, 8, None);
    let batch = 2;

    let input = Tensor::randn(0f32, 1f32, (batch, 4), &device).unwrap();
    let hidden = model.cell().zero_state(batch, &device, DType::F32).unwrap();
    let delta_t = Tensor::ones((batch, 1), DType::F32, &device).unwrap();

    let (output, next_hidden) = model.step(&input, &hidden, &delta_t).unwrap();

    assert_eq!(output.dims(), &[batch, 8]);
    assert_eq!(next_hidden.dims(), &[batch, 8]);
    assert_all_finite(&output);
}

#[test]
fn cfc_sequence() {
    let (model, device) = build_model(4, 8, Some(3));
    let (batch, time) = (2, 5);

    let inputs = Tensor::randn(0f32, 1f32, (batch, time, 4), &device).unwrap();
    let out = model.forward(&inputs, None, None).unwrap();

    assert_eq!(out.sequence.dims(), &[batch, time, 3]);
    assert_eq!(out.final_state.dims(), &[batch, 8]);
    assert_all_finite(&out.sequence);
}

#[test]
fn cfc_variable_dt() {
    let (model, device) = build_model(4, 8, None);
    let (batch, time) = (2, 6);

    let inputs = Tensor::randn(0f32, 1f32, (batch, time, 4), &device).unwrap();
    // Irregular elapsed time per step, e.g. 2ms, 17s, 4h ... (liquid-ai.md §26).
    let dts: Vec<f32> = vec![0.002, 17.0, 14400.0, 1.0, 0.5, 3600.0];
    let delta_t = Tensor::from_vec(dts, (1, time, 1), &device)
        .unwrap()
        .broadcast_as((batch, time, 1))
        .unwrap()
        .contiguous()
        .unwrap();

    let out = model.forward(&inputs, None, Some(&delta_t)).unwrap();

    assert_eq!(out.sequence.dims(), &[batch, time, 8]);
    assert_all_finite(&out.sequence);
    assert_all_finite(&out.final_state);
}

#[test]
fn cfc_zero_dt() {
    let (model, device) = build_model(4, 8, None);
    let batch = 3;

    let input = Tensor::randn(0f32, 1f32, (batch, 4), &device).unwrap();
    let hidden = model.cell().zero_state(batch, &device, DType::F32).unwrap();
    let delta_t = Tensor::zeros((batch, 1), DType::F32, &device).unwrap();

    let (output, next_hidden) = model.step(&input, &hidden, &delta_t).unwrap();

    assert_all_finite(&output);
    assert_all_finite(&next_hidden);
}
