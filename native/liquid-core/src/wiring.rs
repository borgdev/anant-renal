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

use candle_core::{Device, Result, Tensor};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::config::WiringConfig;

fn bernoulli_mask(rows: usize, cols: usize, density: f32, rng: &mut ChaCha8Rng) -> Vec<f32> {
    (0..rows * cols).map(|_| if rng.gen::<f32>() < density { 1.0 } else { 0.0 }).collect()
}

fn zeros(rows: usize, cols: usize) -> Vec<f32> {
    vec![0.0; rows * cols]
}

fn set_block(mask: &mut [f32], cols: usize, row_range: std::ops::Range<usize>, col_range: std::ops::Range<usize>, density: f32, rng: &mut ChaCha8Rng) {
    for r in row_range {
        for c in col_range.clone() {
            if rng.gen::<f32>() < density {
                mask[r * cols + c] = 1.0;
            }
        }
    }
}

/// Builds the `[rows, cols]` connectivity mask for a weight matrix, per `config`
/// (liquid-ai.md §21-23). `seed` makes the mask reproducible for a given model.
///
/// For `Ncp`, `rows`/`cols` are expected to be the recurrent hidden×hidden matrix
/// (`rows == cols == inter+command+motor`) or the sensory input×hidden matrix
/// (`rows == input_size`, `cols == inter+command+motor`) — the caller distinguishes these via
/// `sensory_rows`.
pub fn generate_mask(config: &WiringConfig, rows: usize, cols: usize, sensory_rows: bool, seed: u64, device: &Device) -> Result<Tensor> {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);

    let data = match config {
        WiringConfig::Dense => vec![1.0f32; rows * cols],
        WiringConfig::Sparse { connectivity } => bernoulli_mask(rows, cols, *connectivity, &mut rng),
        WiringConfig::Ncp { sensory, inter, command, motor } => {
            ncp_mask(rows, cols, sensory_rows, *sensory, *inter, *command, *motor, &mut rng)
        }
    };

    Tensor::from_vec(data, (rows, cols), device)
}

#[allow(clippy::too_many_arguments)]
fn ncp_mask(
    rows: usize,
    cols: usize,
    sensory_rows: bool,
    sensory: usize,
    inter: usize,
    command: usize,
    motor: usize,
    rng: &mut ChaCha8Rng,
) -> Vec<f32> {
    let mut mask = zeros(rows, cols);
    let inter_range = 0..inter;
    let command_range = inter..inter + command;
    let motor_range = inter + command..inter + command + motor;

    if sensory_rows {
        // input (sensory) -> inter, density 0.5. `sensory` is descriptive metadata (expected
        // group size); the mask connects every actual input row regardless, since the caller's
        // real `input_size` and the configured `sensory` count aren't required to match.
        let _ = sensory;
        set_block(&mut mask, cols, 0..rows, inter_range, 0.5, rng);
        return mask;
    }

    // Recurrent hidden -> hidden structure.
    set_block(&mut mask, cols, inter_range.clone(), inter_range.clone(), 0.3, rng); // inter -> inter
    set_block(&mut mask, cols, inter_range.clone(), command_range.clone(), 0.4, rng); // inter -> command
    set_block(&mut mask, cols, command_range.clone(), command_range.clone(), 0.3, rng); // command -> command
    set_block(&mut mask, cols, command_range.clone(), motor_range.clone(), 0.4, rng); // command -> motor
    set_block(&mut mask, cols, command_range.clone(), inter_range.clone(), 0.2, rng); // command -> inter (feedback)
    // motor -> * stays zero: motor is the readout layer.
    let _ = motor_range;

    mask
}
