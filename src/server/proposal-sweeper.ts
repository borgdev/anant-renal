/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

/**
 * F9.3 — the expiry sweeper, on a timer.
 *
 * The publisher gives every proposal an expiry, which means nothing unless
 * something acts on it. This is that something.
 *
 * Why it is a timer and not a job-bus enqueue: expiry is a function of TIME, and
 * the realm clock is not wall time. A queued job would have to be re-enqueued on
 * every interval anyway, so the interval IS the job. What the timer must not do
 * is die quietly, so every sweep is recorded and `status()` reports the last one.
 *
 * Three properties this gets right that a naive `setInterval` would not:
 *
 *  • **Single-flight.** A slow sweep (many retractions, a slow vendor) must not
 *    stack up sweeps behind it. The outbox drain learned this the hard way.
 *  • **The transport is resolved PER SWEEP, not at construction.** A connection
 *    configured (or corrected) after boot has to be picked up without a restart.
 *  • **A failed retraction is visible.** It is counted as `deferred` with the
 *    reason, and the row stays open — see `sweepExpired`.
 */
import { ProposalPublisher, type FhirProposal } from '../fhir/proposal.js';
import { resolveProposalTransport, type TransportResolution } from './proposal-transport.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';

export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface SweepReport {
  at: string;
  expired: number;
  retracted: number;
  /** Still out there, retraction failed — kept open and retried. */
  deferred: number;
  /** Which wire the retractions travelled down, and why not, if not. */
  transport: TransportResolution['kind'];
  transportReason?: string;
  deferredReasons: string[];
}

export interface ProposalSweeperStatus {
  running: boolean;
  intervalMs: number;
  sweeps: number;
  lastSweepAt?: string;
  lastReport?: SweepReport;
  lastError?: string;
  /** A sweep is in flight right now. */
  inFlight: boolean;
}

export interface ProposalSweeperDeps {
  /**
   * The workspace, or a function that resolves it.
   *
   * A function is the normal form: `registerFhirRoutes` builds this sweeper
   * BEFORE `registerSwarmRoutes` registers the workspace, so holding the store
   * at construction would capture `null` and the sweeper would never run.
   */
  workspace: SwarmWorkspaceStore | (() => SwarmWorkspaceStore | null | undefined);
  /**
   * Resolve the wire at sweep time. Returning `none` is not a failure of the
   * sweeper — proposals that were never sent can still be expired locally, and
   * the reason is reported.
   */
  resolveTransport: () => TransportResolution | Promise<TransportResolution>;
  intervalMs?: number;
  now?: () => string;
  onSweep?: (report: SweepReport) => void;
  onError?: (err: unknown) => void;
}

export class ProposalSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private sweeps = 0;
  private lastSweepAt: string | undefined;
  private lastReport: SweepReport | undefined;
  private lastError: string | undefined;
  private readonly intervalMs: number;
  private readonly now: () => string;

  constructor(private readonly deps: ProposalSweeperDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private workspace(): SwarmWorkspaceStore | null {
    const w = this.deps.workspace;
    return typeof w === 'function' ? w() ?? null : w;
  }

  /** Idempotent: calling it twice does not create two timers. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepNow().catch(() => undefined);
    }, this.intervalMs);
    // Never hold the process open for a maintenance timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): ProposalSweeperStatus {
    return {
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      sweeps: this.sweeps,
      ...(this.lastSweepAt ? { lastSweepAt: this.lastSweepAt } : {}),
      ...(this.lastReport ? { lastReport: this.lastReport } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      inFlight: this.inFlight,
    };
  }

  /** One sweep. Safe to call manually; refuses to overlap with a running one. */
  async sweepNow(): Promise<SweepReport> {
    const at = this.now();
    if (this.inFlight) {
      return (
        this.lastReport ?? {
          at, expired: 0, retracted: 0, deferred: 0, transport: 'none',
          transportReason: 'a sweep is already in flight', deferredReasons: [],
        }
      );
    }
    this.inFlight = true;
    try {
      const workspace = this.workspace();
      if (!workspace) {
        throw new Error('the swarm workspace is not registered, so no proposals can be swept');
      }
      const resolution = await this.deps.resolveTransport();
      // Retraction needs a wire; a resolution of `none` still lets us expire
      // proposals that were never sent anywhere.
      const publisher = new ProposalPublisher(
        workspace.proposalStore(),
        resolution.kind === 'none'
          ? {
              send: async () => ({
                ok: false as const,
                error: resolution.reason,
                retryable: true,
              }),
            }
          : resolution.transport,
        this.now,
      );

      const result = await publisher.sweepExpired(at);
      const report: SweepReport = {
        at,
        expired: result.expired,
        retracted: result.retracted,
        deferred: result.deferred,
        transport: resolution.kind,
        ...(resolution.kind === 'none' ? { transportReason: resolution.reason } : {}),
        deferredReasons: result.deferredProposals.map((p) => p.retractionReason ?? 'unknown'),
      };

      this.sweeps += 1;
      this.lastSweepAt = at;
      this.lastReport = report;
      this.lastError = undefined;
      this.deps.onSweep?.(report);
      return report;
    } catch (err) {
      // A sweep that dies must not take the timer with it, and must not fail
      // silently — the next interval retries either way.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.onError?.(err);
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}

/** Open proposals that have run out of time, without mutating anything. */
export function expiredWithoutSweep(proposals: readonly FhirProposal[], at: string): FhirProposal[] {
  return proposals.filter(
    (p) =>
      (p.lifecycle === 'created' || p.lifecycle === 'published' || p.lifecycle === 'surfaced') &&
      Date.parse(p.expiresAt) <= Date.parse(at),
  );
}
