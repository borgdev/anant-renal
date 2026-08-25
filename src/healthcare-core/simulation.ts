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

// Simulation runs are the durable record of "we replayed this pack against
// this window with this policy version and got these numbers." They are the
// contract for pack promotion: no simulation, no deploy.

export interface SimulationRun {
  id: string;
  packId: string;
  packVersion: string;
  policyVersion: string;
  sourceWindow: { from: string; to: string };
  startedAt: string;
  completedAt?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  metrics: Readonly<Record<string, number>>;
  notes?: string;
}

export class SimulationLog {
  private readonly runs = new Map<string, SimulationRun>();

  start(run: Omit<SimulationRun, 'status' | 'metrics'> & { metrics?: Readonly<Record<string, number>> }): SimulationRun {
    if (this.runs.has(run.id)) throw new Error(`Simulation already started: ${run.id}`);
    const next: SimulationRun = Object.freeze({
      ...run,
      status: 'running',
      metrics: Object.freeze({ ...(run.metrics ?? {}) }),
    });
    this.runs.set(run.id, next);
    return next;
  }

  complete(id: string, completedAt: string, metrics: Readonly<Record<string, number>>, status: 'succeeded' | 'failed' = 'succeeded', notes?: string): SimulationRun {
    const existing = this.runs.get(id);
    if (!existing) throw new Error(`Unknown simulation: ${id}`);
    const merged: SimulationRun = { ...existing, status, metrics: Object.freeze({ ...metrics }), completedAt };
    if (notes !== undefined) merged.notes = notes;
    const next: SimulationRun = Object.freeze(merged);
    this.runs.set(id, next);
    return next;
  }

  get(id: string): SimulationRun {
    const r = this.runs.get(id);
    if (!r) throw new Error(`Unknown simulation: ${id}`);
    return r;
  }

  all(): readonly SimulationRun[] {
    return [...this.runs.values()];
  }
}
