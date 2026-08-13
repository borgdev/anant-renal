// M14.F — LLM adapter registry + health checks
//
// Central registry so the UI can enumerate configured planner/operator
// adapters, toggle them on/off at runtime, and probe them for reachability.
// Health checks send a canned prompt through the adapter's normal path and
// record latency + last-error. Registry state is process-local; adapters are
// re-registered by bootstrap on start.

import type { LLMPlannerAdapter } from './planner.js';
import type { OperatorLLMAdapter } from './operator-seat.js';

export type AdapterRole = 'planner' | 'operator';

export interface AdapterHealth {
  ok: boolean;
  latencyMs?: number;
  lastCheckedAt: string;
  lastError?: string;
}

export interface RegisteredAdapter {
  id: string;
  role: AdapterRole;
  displayName: string;
  enabled: boolean;
  endpoint?: string;
  model?: string;
  handle: LLMPlannerAdapter | OperatorLLMAdapter;
  health: AdapterHealth;
}

class LLMRegistryImpl {
  private adapters = new Map<string, RegisteredAdapter>();

  register(entry: Omit<RegisteredAdapter, 'health'> & { health?: AdapterHealth }): RegisteredAdapter {
    const health: AdapterHealth = entry.health ?? { ok: false, lastCheckedAt: new Date(0).toISOString() };
    const full: RegisteredAdapter = { ...entry, health };
    this.adapters.set(entry.id, full);
    return full;
  }

  unregister(id: string): boolean { return this.adapters.delete(id); }

  get(id: string): RegisteredAdapter | undefined { return this.adapters.get(id); }
  list(): RegisteredAdapter[] { return [...this.adapters.values()]; }
  listByRole(role: AdapterRole): RegisteredAdapter[] { return this.list().filter((a) => a.role === role); }

  setEnabled(id: string, enabled: boolean): RegisteredAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`llm-adapter-not-found:${id}`);
    a.enabled = enabled;
    return a;
  }

  /** Ping the adapter. Uses its own parse/plan path for planner, `parse` for operator. */
  async healthCheck(id: string): Promise<AdapterHealth> {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`llm-adapter-not-found:${id}`);
    const start = Date.now();
    try {
      if (a.role === 'operator') {
        const op = a.handle as OperatorLLMAdapter;
        const out = await op.parse('spawn a nurse in unit-a');
        a.health = {
          ok: out !== undefined,
          latencyMs: Date.now() - start,
          lastCheckedAt: new Date().toISOString(),
          ...(out === undefined ? { lastError: 'adapter returned undefined for canned prompt' } : {}),
        };
      } else {
        const pl = a.handle as LLMPlannerAdapter;
        // Give the planner a trivial intent and canned world summary to probe reachability.
        const stub = { intentId: 'health-check', intentKind: 'health-check', description: 'ping', priority: 'low' as const, submittedAt: new Date().toISOString(), submittedBy: 'health-check' };
        const out = await pl.plan(stub, 'health-check');
        a.health = {
          ok: Array.isArray(out),
          latencyMs: Date.now() - start,
          lastCheckedAt: new Date().toISOString(),
          ...(!Array.isArray(out) ? { lastError: 'planner did not return step array' } : {}),
        };
      }
    } catch (err) {
      a.health = {
        ok: false,
        latencyMs: Date.now() - start,
        lastCheckedAt: new Date().toISOString(),
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
    return a.health;
  }

  /** Public shape for admin routes — omits the raw handle (not serializable). */
  view(): Array<Omit<RegisteredAdapter, 'handle'>> {
    return this.list().map(({ handle: _handle, ...rest }) => rest);
  }
}

export const LLMRegistry = new LLMRegistryImpl();
