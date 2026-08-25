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

/* tslint:disable */
/* eslint-disable */

/**
 * A single entity's local simulation: same baseline ODE + scenario generator + CfC/LTC
 * residual pipeline as `server::sim::tick_domain`, run entirely in the browser.
 */
export class WasmSimulation {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Advances `steps` ticks of `dt` seconds each, optionally applying an intervention's
     * effect once at the start (`intervention_json`: `[["dim", delta], ...]`, matching
     * `InterventionSpec::effect` — pass `"[]"` for none). Returns a JSON array of
     * `{t, stage, state}`, one entry per tick — computed entirely locally, no network
     * round-trip.
     */
    forecast(steps: number, dt: number, intervention_json: string): string;
    /**
     * Forks the local simulation to a specific point — typically the live server's current
     * state for the entity being explored — so forecasts start from "now," not a cold entity.
     * `state_json`: `{"<dim_key>": <value>, ...}`.
     */
    forkFrom(state_json: string, t: number): void;
    /**
     * `weights`: raw SafeTensors bytes for a trained model, or an empty slice for a fresh
     * (randomly-initialized) model — matching what the server does for a domain with nothing
     * promoted yet.
     */
    constructor(domain_id: string, model_kind: string, weights: Uint8Array, seed: number);
    /**
     * Override the residual weight `α` in `ΔX_final = ΔX_baseline + α·R_θ`. The harness runs
     * `α = 0` (baseline-only, deterministic) until trained weights are promoted, then restores
     * the pack's default so the learned residual is active.
     */
    setResidualAlpha(alpha: number): void;
    /**
     * Advance a single tick driven by an **external** event-feature vector (rather than the
     * internal seeded scenario) — this is how the harness realm drives patient trajectories
     * from its effect ledger. `event_json`: `[<feature>, ...]` in event-feature-schema order.
     * Returns `{"t", "stage", "state": {<dim_key>: value}}`.
     */
    stepWithEvents(event_json: string, dt: number): string;
}

export function init(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmsimulation_free: (a: number, b: number) => void;
    readonly wasmsimulation_forecast: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmsimulation_forkFrom: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmsimulation_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly wasmsimulation_setResidualAlpha: (a: number, b: number) => void;
    readonly wasmsimulation_stepWithEvents: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly init: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
