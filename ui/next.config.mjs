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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Silence the multi-lockfile warning by pinning the tracing root to the ui/.
  outputFileTracingRoot: __dirname,
  webpack: (config) => {
    // The core is authored as TypeScript with `.js` ESM import specifiers
    // (NodeNext convention). Next.js webpack needs to know how to resolve
    // those to their `.ts` sources when they live outside `ui/`.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    // Make sure ts/tsx from the parent repo is resolvable.
    const existingExts = config.resolve.extensions ?? ['.js', '.jsx', '.ts', '.tsx', '.json'];
    config.resolve.extensions = Array.from(new Set([...existingExts, '.ts', '.tsx']));
    // Add the repo root to module resolution so `../../src/...` resolves cleanly.
    config.resolve.modules = Array.from(new Set([...(config.resolve.modules ?? []), repoRoot, path.join(repoRoot, 'node_modules')]));
    return config;
  },
};
export default nextConfig;
