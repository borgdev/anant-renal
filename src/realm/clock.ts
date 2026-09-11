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

// Clock — the authority on time inside a Realm.
//
// Nothing in a realm advances except through a clock tick. The clock has
// two implementations behind one interface: WallClock (1s = 1s, used in
// twin mode) and AcceleratedClock (deterministic, seeded, used in sim).

import type { ClockTick, ClockKind } from './types.js';

export interface Clock {
  readonly kind: ClockKind;
  readonly seq: number;
  readonly realmAt: Date;
  subscribe(cb: (tick: ClockTick) => void): () => void;
  start(): void;
  stop(): void;
  advanceBy(deltaMs: number): ClockTick; // manual tick, used by tests and sim
  /**
   * Retune the wall cadence at runtime (how long between ticks). Realm time per
   * tick is unaffected. Optional: a clock that cannot be retuned simply omits it,
   * so a caller must not assume throttling is available.
   */
  setTickInterval?(msPerTick: number): void;
}

export class WallClock implements Clock {
  readonly kind = 'wall' as const;
  private _seq = 0;
  private _realmAt: Date;
  private handle: ReturnType<typeof setInterval> | null = null;
  private subs: Array<(t: ClockTick) => void> = [];
  private intervalMs: number;

  constructor(opts: { startAt?: Date; intervalMs?: number } = {}) {
    this._realmAt = opts.startAt ?? new Date();
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  get seq() { return this._seq; }
  get realmAt() { return new Date(this._realmAt); }

  subscribe(cb: (t: ClockTick) => void): () => void {
    this.subs.push(cb);
    return () => { this.subs = this.subs.filter((x) => x !== cb); };
  }

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => this.advanceBy(this.intervalMs), this.intervalMs);
  }
  stop(): void { if (this.handle) { clearInterval(this.handle); this.handle = null; } }

  /** See Clock.setTickInterval: same retuning, one wall second per tick by default. */
  setTickInterval(msPerTick: number): void {
    const next = Math.max(1, Math.round(msPerTick));
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = setInterval(() => this.advanceBy(this.intervalMs), this.intervalMs);
    }
  }

  advanceBy(deltaMs: number): ClockTick {
    this._seq += 1;
    this._realmAt = new Date(this._realmAt.getTime() + deltaMs);
    const tick: ClockTick = { seq: this._seq, wallAt: new Date().toISOString(), realmAt: this._realmAt.toISOString(), deltaMs };
    for (const cb of this.subs) cb(tick);
    return tick;
  }
}

// AcceleratedClock — configurable rate, deterministic.
// `msPerTick` wall interval between ticks; `realmMsPerTick` how much realm
// time each tick advances. Setting realmMsPerTick > msPerTick accelerates
// realm time.
export class AcceleratedClock implements Clock {
  readonly kind = 'accelerated' as const;
  private _seq = 0;
  private _realmAt: Date;
  private handle: ReturnType<typeof setInterval> | null = null;
  private subs: Array<(t: ClockTick) => void> = [];
  private msPerTick: number;
  private realmMsPerTick: number;

  constructor(opts: { startAt?: Date; msPerTick?: number; realmMsPerTick?: number } = {}) {
    this._realmAt = opts.startAt ?? new Date();
    this.msPerTick = opts.msPerTick ?? 100;
    this.realmMsPerTick = opts.realmMsPerTick ?? 60_000; // 1 minute of realm per tick by default
  }

  get seq() { return this._seq; }
  get realmAt() { return new Date(this._realmAt); }

  subscribe(cb: (t: ClockTick) => void): () => void {
    this.subs.push(cb);
    return () => { this.subs = this.subs.filter((x) => x !== cb); };
  }

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => this.advanceBy(this.realmMsPerTick), this.msPerTick);
  }
  stop(): void { if (this.handle) { clearInterval(this.handle); this.handle = null; } }

  /**
   * Retune how fast WALL time advances between ticks, leaving realm-time-per-tick
   * untouched.
   *
   * Slowing the wall interval is how a running fleet is throttled to match what
   * downstream can actually consume: fewer ticks per wall second means fewer
   * effects, without changing what one tick means clinically. Takes effect on the
   * next interval, so a running clock is restarted.
   */
  setTickInterval(msPerTick: number): void {
    const next = Math.max(1, Math.round(msPerTick));
    if (next === this.msPerTick) return;
    this.msPerTick = next;
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = setInterval(() => this.advanceBy(this.realmMsPerTick), this.msPerTick);
    }
  }

  get tickIntervalMs(): number { return this.msPerTick; }

  advanceBy(deltaMs: number): ClockTick {
    this._seq += 1;
    this._realmAt = new Date(this._realmAt.getTime() + deltaMs);
    const tick: ClockTick = { seq: this._seq, wallAt: new Date().toISOString(), realmAt: this._realmAt.toISOString(), deltaMs };
    for (const cb of this.subs) cb(tick);
    return tick;
  }
}
