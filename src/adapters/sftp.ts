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
