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

// Lazy loader for the wasm-bindgen liquid (CfC/LTC) bundle.
//
//   • Node (server + tests): reads the `.wasm` bytes and passes them to `__wbg_init(bytes)`,
//     which uses `WebAssembly.instantiate` directly (no `fetch`, no browser globals).
//   • Browser (admin UI, later phase): `__wbg_init()` fetches the `.wasm` relative to
//     `import.meta.url`.
//
// The generated `liquid_wasm.d.ts` references DOM lib types (`RequestInfo`, `Response`, …) that
// are not in this Node-only tsconfig, so we type the module surface ourselves (`LiquidWasmModule`)
// and cast at the boundary.

import type { LiquidSimulation } from './types.js';

export interface LiquidWasmModule {
  default(input?: unknown): Promise<unknown>;
  WasmSimulation: new (domainId: string, modelKind: string, weights: Uint8Array, seed: number) => LiquidSimulation;
}

type SimulationCtor = LiquidWasmModule['WasmSimulation'];

const isNode = typeof process !== 'undefined' && typeof process.versions?.node === 'string';

let _ready: Promise<SimulationCtor> | null = null;
let _ctor: SimulationCtor | null = null;

/** Load + instantiate the wasm bundle once; resolves to the `WasmSimulation` constructor. */
export function ensureWasmSimulation(): Promise<SimulationCtor> {
  if (!_ready) {
    _ready = (async () => {
      const mod = (await import('./wasm/liquid_wasm.js')) as unknown as LiquidWasmModule;
      const load = mod.default;
      if (isNode) {
        // node:fs is only required in Node; import it dynamically so a browser bundle never
        // sees it (wasm-pack --target web output is otherwise browser-clean).
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const wasmPath = fileURLToPath(new URL('./wasm/liquid_wasm_bg.wasm', import.meta.url));
        const bytes = readFileSync(wasmPath);
        // Object form avoids the deprecated positional-arg path and still instantiates via
        // WebAssembly.instantiate(bytes) in Node (no fetch of a file:// URL).
        await load({ module_or_path: bytes });
      } else {
        await load();
      }
      _ctor = mod.WasmSimulation;
      return _ctor;
    })();
  }
  return _ready;
}

/**
 * Synchronously returns the `WasmSimulation` constructor if the wasm is already loaded, else
 * null. Lets a *synchronous* realm tick (e.g. inside `runCounterfactual`) see the engine the
 * moment it's been awaited elsewhere (pre-load with `ensureWasmSimulation()` first).
 */
export function tryGetWasmSimulation(): SimulationCtor | null {
  return _ctor;
}
