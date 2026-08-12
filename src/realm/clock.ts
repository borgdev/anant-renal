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

  advanceBy(deltaMs: number): ClockTick {
    this._seq += 1;
    this._realmAt = new Date(this._realmAt.getTime() + deltaMs);
    const tick: ClockTick = { seq: this._seq, wallAt: new Date().toISOString(), realmAt: this._realmAt.toISOString(), deltaMs };
    for (const cb of this.subs) cb(tick);
    return tick;
  }
}
