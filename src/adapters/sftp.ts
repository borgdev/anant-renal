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

// SFTP drop adapter. Scheduled pull; files classified by extension and routed.

import type { CanonicalEvent } from '../healthcare-core/events.js';
import { parseX12, x12ToEvents } from './x12.js';
import { parseCDA, cdaToEvents } from './cda-lite.js';

export interface SFTPFile {
  readonly path: string;
  readonly bytes: string;
  readonly receivedAt: string;
  readonly senderId: string;
}

export interface SFTPClient {
  list(remoteDir: string): Promise<readonly string[]>;
  fetch(path: string): Promise<string>;
  markProcessed(path: string): Promise<void>;
}

export interface SFTPRoute {
  readonly matches: (path: string) => boolean;
  readonly convert: (file: SFTPFile, opts: SFTPRouteOptions) => CanonicalEvent[];
}

export interface SFTPRouteOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

export const defaultRoutes: readonly SFTPRoute[] = [
  {
    matches: (p) => /\.(x12|edi|edifact)$/i.test(p),
    convert: (file, opts) => x12ToEvents(parseX12(file.bytes), opts),
  },
  {
    matches: (p) => /\.xml$/i.test(p),
    convert: (file, opts) => cdaToEvents(parseCDA(file.bytes), opts),
  },
];

export async function processSFTPDrop(
  client: SFTPClient,
  remoteDir: string,
  opts: SFTPRouteOptions,
  routes: readonly SFTPRoute[] = defaultRoutes,
): Promise<{ processed: readonly string[]; events: CanonicalEvent[]; unrouted: readonly string[] }> {
  const paths = await client.list(remoteDir);
  const events: CanonicalEvent[] = [];
  const processed: string[] = [];
  const unrouted: string[] = [];
  for (const path of paths) {
    const route = routes.find((r) => r.matches(path));
    if (!route) { unrouted.push(path); continue; }
    const bytes = await client.fetch(path);
    const file: SFTPFile = { path, bytes, receivedAt: opts.ingestedAt, senderId: opts.sourceId };
    events.push(...route.convert(file, opts));
    await client.markProcessed(path);
    processed.push(path);
  }
  return { processed, events, unrouted };
}
