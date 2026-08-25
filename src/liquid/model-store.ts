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

// Liquid model store — trained-weight registry for the CfC/LTC engine.
//
// SafeTensors weight files live on disk under `.harness/liquid/weights/` (like
// `.harness/measures/` for ELM artifacts); `models.json` records the active model per domain
// and `history.json` the full set of trained/promoted models. A promoted model survives
// restarts and is picked up by new liquid realms (Phase 6).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ModelMetrics {
  finalLoss: number;
  baselineMae: number;
  trainedMae: number;
  losses: number[];
}

export interface ActiveModelRecord {
  domain: string;
  modelId: string;
  modelKind: 'cfc' | 'ltc';
  fileName: string;
  promotedAt: string;
  metrics?: ModelMetrics;
}

export interface ModelKindMetrics {
  modelId: string;
  finalLoss: number;
  baselineMae: number;
  trainedMae: number;
}

/** CfC vs LTC vs baseline-only held-out MAE — the Model Comparison view. */
export interface LiquidComparison {
  domain: string;
  baselineMae: number | undefined;
  cfc: ModelKindMetrics | undefined;
  ltc: ModelKindMetrics | undefined;
}

const DEFAULT_ROOT = resolve(process.cwd(), '.harness', 'liquid');

export class LiquidModelStore {
  private readonly weightsDir: string;
  private readonly registryPath: string;
  private readonly historyPath: string;

  constructor(private readonly root: string = DEFAULT_ROOT) {
    mkdirSync(root, { recursive: true });
    this.weightsDir = join(root, 'weights');
    this.registryPath = join(root, 'models.json');
    this.historyPath = join(root, 'history.json');
  }

  private readRegistry(): Record<string, ActiveModelRecord> {
    if (!existsSync(this.registryPath)) return {};
    try {
      return JSON.parse(readFileSync(this.registryPath, 'utf8')) as Record<string, ActiveModelRecord>;
    } catch {
      return {};
    }
  }

  private writeRegistry(reg: Record<string, ActiveModelRecord>): void {
    writeFileSync(this.registryPath, JSON.stringify(reg, null, 2));
  }

  private readHistory(): Record<string, ActiveModelRecord> {
    if (!existsSync(this.historyPath)) return {};
    try {
      return JSON.parse(readFileSync(this.historyPath, 'utf8')) as Record<string, ActiveModelRecord>;
    } catch {
      return {};
    }
  }

  private writeHistory(hist: Record<string, ActiveModelRecord>): void {
    writeFileSync(this.historyPath, JSON.stringify(hist, null, 2));
  }

  listModels(): ActiveModelRecord[] {
    return Object.values(this.readRegistry());
  }

  history(domain?: string): ActiveModelRecord[] {
    const all = Object.values(this.readHistory());
    return domain ? all.filter((r) => r.domain === domain) : all;
  }

  activeModel(domain: string): ActiveModelRecord | undefined {
    return this.readRegistry()[domain];
  }

  /** Raw SafeTensors bytes for the active model of `domain`, or undefined if none promoted. */
  weightsFor(domain: string): Uint8Array | undefined {
    const rec = this.activeModel(domain);
    if (!rec) return undefined;
    const p = join(this.weightsDir, rec.fileName);
    if (!existsSync(p)) return undefined;
    return new Uint8Array(readFileSync(p));
  }

  /** Persist a trained model and mark it active for `domain`. Returns the record. */
  promote(domain: string, modelKind: ActiveModelRecord['modelKind'], weights: Uint8Array, modelId?: string, metrics?: ModelMetrics): ActiveModelRecord {
    mkdirSync(this.weightsDir, { recursive: true });
    const id = modelId ?? `${domain}-${modelKind}-${Date.now()}`;
    const fileName = `${id}.safetensors`;
    writeFileSync(join(this.weightsDir, fileName), Buffer.from(weights));
    const rec: ActiveModelRecord = {
      domain,
      modelId: id,
      modelKind,
      fileName,
      promotedAt: new Date().toISOString(),
      ...(metrics ? { metrics } : {}),
    };
    const reg = this.readRegistry();
    reg[domain] = rec;
    this.writeRegistry(reg);
    const hist = this.readHistory();
    hist[rec.modelId] = rec;
    this.writeHistory(hist);
    return rec;
  }

  /** Re-activate a previously-trained model (its weights file is already on disk). */
  promoteExisting(domain: string, modelId: string): ActiveModelRecord | undefined {
    const rec = this.readHistory()[modelId];
    if (!rec || rec.domain !== domain) return undefined;
    const p = join(this.weightsDir, rec.fileName);
    if (!existsSync(p)) return undefined;
    const reg = this.readRegistry();
    reg[domain] = rec;
    this.writeRegistry(reg);
    return rec;
  }

  /** CfC vs LTC vs baseline-only held-out MAE from the promoted/trained records. */
  compare(domain: string): LiquidComparison {
    const records = this.history(domain).filter((r) => r.metrics);
    const baselineMae = records[0]?.metrics?.baselineMae;
    const pick = (kind: 'cfc' | 'ltc'): ModelKindMetrics | undefined => {
      const rec = records.find((r) => r.modelKind === kind);
      if (!rec?.metrics) return undefined;
      return { modelId: rec.modelId, finalLoss: rec.metrics.finalLoss, baselineMae: rec.metrics.baselineMae, trainedMae: rec.metrics.trainedMae };
    };
    return { domain, baselineMae, cfc: pick('cfc'), ltc: pick('ltc') };
  }
}

