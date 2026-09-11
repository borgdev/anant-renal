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

// Fleet generation governor — couples how fast the simulated fleet produces
// events to how fast the rest of the system consumes them.
//
// The alternative (and what we did first) is to make the consumer keep up with an
// unbounded producer. That is the wrong end: a fleet can always be given a faster
// clock, and when it outruns delivery the only outcomes are a growing backlog, a
// saturated process, or both. Measuring on this machine with the demo fleet
// running: ~74 events/s produced against ~59/s delivered, one core at ~100%, and a
// backlog creeping up indefinitely.
//
// So the cadence is closed-loop instead of guessed:
//
//   backlog  < LOW      → run at the configured pace (the demo the operator asked for)
//   backlog  > HIGH     → slow the clocks
//   backlog  > CRITICAL → stop the clocks until it drains (generation pauses; nothing is lost)
//
// Hysteresis (separate engage/release thresholds) is deliberate: a single
// threshold would flap between paces every tick and make the fleet's behaviour
// depend on timing noise. Every decision is reported, because a fleet that slows
// itself down without saying so is its own kind of silent failure.

export type GovernorState = 'unthrottled' | 'throttled' | 'paused';

export interface GovernorThresholds {
  /** Below this backlog the fleet runs at its configured pace. */
  readonly low: number;
  /** Above this the fleet is slowed. */
  readonly high: number;
  /** Above this generation stops until the backlog drains to `low`. */
  readonly critical: number;
  /** Multiplier applied to the wall tick interval while throttled (>1 = slower). */
  readonly slowFactor: number;
}

export const DEFAULT_GOVERNOR_THRESHOLDS: GovernorThresholds = {
  low: 500,
  high: 5_000,
  critical: 25_000,
  slowFactor: 4,
};

export interface GovernorReport {
  readonly state: GovernorState;
  readonly backlog: number;
  /** Wall ms between realm ticks currently in force. */
  readonly tickIntervalMs: number;
  readonly baseTickIntervalMs: number;
  readonly changes: number;
  readonly lastReason: string;
}

export interface FleetGovernorOptions {
  /** Current undelivered backlog (outbox pending, or any queue depth). */
  readonly readBacklog: () => Promise<number>;
  /** Fleet is currently generating (a paused fleet is left alone). */
  readonly isRunning: () => boolean;
  /** Apply a wall tick interval to every realm clock. */
  readonly setTickInterval: (msPerTick: number) => void;
  readonly stopClocks: () => void;
  readonly startClocks: () => void;
  readonly baseTickIntervalMs: number;
  readonly thresholds?: Partial<GovernorThresholds>;
  readonly onDecision?: (report: GovernorReport) => void;
}

export class FleetGovernor {
  private state: GovernorState = 'unthrottled';
  private backlog = 0;
  private changes = 0;
  private lastReason = 'not yet evaluated';
  private readonly thresholds: GovernorThresholds;
  /** Set while paused BY THE GOVERNOR, so it knows to release later. */
  private pausedByGovernor = false;

  constructor(private readonly opts: FleetGovernorOptions) {
    this.thresholds = { ...DEFAULT_GOVERNOR_THRESHOLDS, ...(opts.thresholds ?? {}) };
  }

  report(): GovernorReport {
    return {
      state: this.state,
      backlog: this.backlog,
      tickIntervalMs: this.state === 'throttled'
        ? Math.round(this.opts.baseTickIntervalMs * this.thresholds.slowFactor)
        : this.opts.baseTickIntervalMs,
      baseTickIntervalMs: this.opts.baseTickIntervalMs,
      changes: this.changes,
      lastReason: this.lastReason,
    };
  }

  /** One control step. Cheap: a single backlog read plus at most two clock calls. */
  async step(): Promise<GovernorReport> {
    this.backlog = await this.opts.readBacklog();
    const running = this.opts.isRunning();

    // A fleet the operator paused stays paused: the governor only ever releases
    // what it paused itself.
    if (!running && !this.pausedByGovernor) return this.report();

    const base = this.opts.baseTickIntervalMs;
    const slow = Math.round(base * this.thresholds.slowFactor);

    // One branch per state, each of which either transitions or explains why it is
    // holding. A catch-all `else` here previously overwrote the unthrottled reason
    // with the paused one, so a healthy fleet reported 'holding generation pause'.
    if (this.state === 'unthrottled') {
      if (this.backlog >= this.thresholds.high) {
        this.transition('throttled', `backlog ${this.backlog} ≥ high ${this.thresholds.high}: slowing fleet ${this.thresholds.slowFactor}×`);
        this.opts.setTickInterval(slow);
      } else {
        this.lastReason = `backlog ${this.backlog} < high ${this.thresholds.high}: fleet at configured pace (${base}ms)`;
      }
    } else if (this.state === 'throttled') {
      if (this.backlog >= this.thresholds.critical) {
        this.transition('paused', `backlog ${this.backlog} ≥ critical ${this.thresholds.critical}: generation paused until it drains`);
        this.opts.stopClocks();
        this.pausedByGovernor = true;
      } else if (this.backlog <= this.thresholds.low) {
        this.transition('unthrottled', `backlog ${this.backlog} ≤ low ${this.thresholds.low}: fleet back to configured pace`);
        this.opts.setTickInterval(base);
      } else {
        this.lastReason = `backlog ${this.backlog}: holding slowed pace (${slow}ms) until it falls to ${this.thresholds.low}`;
      }
    } else if (this.backlog <= this.thresholds.low) {
      // paused BY THE GOVERNOR — release in two stages: resume, then unthrottle.
      this.transition('throttled', `backlog ${this.backlog} ≤ low ${this.thresholds.low}: generation resumed (still throttled)`);
      this.opts.startClocks();
      this.pausedByGovernor = false;
    } else {
      this.lastReason = `backlog ${this.backlog}: holding generation pause until it falls to ${this.thresholds.low}`;
    }

    return this.report();
  }

  private transition(state: GovernorState, reason: string): void {
    this.state = state;
    this.changes += 1;
    this.lastReason = reason;
    this.opts.onDecision?.(this.report());
  }
}
