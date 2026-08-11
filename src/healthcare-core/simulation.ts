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
