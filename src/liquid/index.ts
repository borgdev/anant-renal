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

// Liquid (CfC/LTC) engine — TS boundary layer.
//
// Rust owns all numerics (native/); this module loads the same code compiled to WASM and
// exposes it to the harness. No JS reimplementation — no drift.

export * from './types.js';
export { ensureWasmSimulation, tryGetWasmSimulation } from './wasm.js';
export { LiquidModelStore, type ActiveModelRecord, type ModelMetrics, type LiquidComparison, type ModelKindMetrics } from './model-store.js';
export { TrajectoryAmbientProcess, type LiquidTrajectoryOptions } from './trajectory.js';
export { LiquidTrainer, type TrainRequest, type TrainingRunResult, type TrainingRunner } from './trainer.js';
export { forecastPatient, type ForecastPoint, type WhatIfRequest } from './forecast.js';
export { projectDialysisState, trajectoryLabel, type ProjectedState } from './project.js';
export { RegimeDetector, makeRegimeRule, computeEffectiveTau, tauDtFactor, type Regime, type RegimeSignal, type RegimeDetectorOptions } from './regime.js';
export { buildLabsBundle, scoreLabs, type LabPatient, type PatientScore, type ScoreResult, type MeasurementPeriod } from './cql.js';
