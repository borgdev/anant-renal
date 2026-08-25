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

// Liquid trainer — drives the native `liquid-train` CLI (CfC/LTC residual training) and
// promotes the resulting SafeTensors artifact into the model store.
//
// Default runner spawns `cargo run -p liquid-train` in `native/`. A `TrainingRunner` is
// injectable so tests can substitute a deterministic fake (no cargo spawn in CI).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LiquidModelStore, type ActiveModelRecord, type ModelMetrics } from './model-store.js';

export interface TrainRequest {
  domain?: string; // 'dialysis'
  modelKind?: 'cfc' | 'ltc';
  epochs?: number;
  learningRate?: number;
  numSequences?: number;
  sequenceLength?: number;
  seed?: number;
}

export interface TrainingRunResult {
  modelId: string;
  modelKind: 'cfc' | 'ltc';
  artifactPath: string;
  losses: number[];
  finalLoss: number;
  baselineMae: number;
  trainedMae: number;
}

/** `args` = CLI args after `--`; resolves with the CLI's stdout (a JSON report). */
export type TrainingRunner = (args: string[], opts: { workDir: string }) => Promise<string>;

const NATIVE_ROOT = resolve(process.cwd(), 'native');

const defaultRunner: TrainingRunner = (args) =>
  new Promise<string>((resolveRun, reject) => {
    const child = spawn('cargo', ['run', '-q', '-p', 'liquid-train', '--', ...args], {
      cwd: NATIVE_ROOT,
      env: process.env as Record<string, string>,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(stderr.trim() || `liquid-train exited ${code ?? 'unknown'}`));
    });
  });

export class LiquidTrainer {
  constructor(
    private readonly store: LiquidModelStore,
    private readonly runner: TrainingRunner = defaultRunner,
    private readonly tmpRoot: string = join(process.cwd(), '.harness', 'liquid', 'tmp'),
  ) {}

  /** Run a training job, persist the artifact, and promote it as the active model. */
  async train(req: TrainRequest = {}): Promise<TrainingRunResult & { record: ActiveModelRecord }> {
    const domain = req.domain ?? 'dialysis';
    const modelKind = req.modelKind ?? 'cfc';
    const modelId = `${domain}-${modelKind}-${Date.now()}`;
    const workDir = join(this.tmpRoot, modelId);
    mkdirSync(workDir, { recursive: true });

    const args = [
      '--domain', domain,
      '--model-kind', modelKind,
      '--epochs', String(req.epochs ?? 10),
      '--lr', String(req.learningRate ?? 1e-2),
      '--num-sequences', String(req.numSequences ?? 12),
      '--sequence-length', String(req.sequenceLength ?? 24),
      '--seed', String(req.seed ?? 7),
      '--out-dir', workDir,
      '--model-id', modelId,
    ];
    const stdout = await this.runner(args, { workDir });
    const run = JSON.parse(stdout) as TrainingRunResult;
    const bytes = new Uint8Array(readFileSync(join(workDir, 'model.safetensors')));
    const metrics: ModelMetrics = {
      finalLoss: run.finalLoss,
      baselineMae: run.baselineMae,
      trainedMae: run.trainedMae,
      losses: run.losses,
    };
    const record = this.store.promote(domain, modelKind, bytes, run.modelId, metrics);
    return { ...run, record };
  }
}
