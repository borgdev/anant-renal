// Orchestrator: input dir/file -> classify -> emit -> validate -> write pack + report.

import { loadDirectory } from './loaders.js';
import { enrichWithOllama, type ExtractorConfig } from './narrative-extractor.js';
import { classify } from './classifier.js';
import { emitAgents } from './emitter.js';
import { writePack, type PackWriteOptions } from './pack-writer.js';
import { validateAgentSpec, type AgentSpec } from '../agents/index.js';
import type { CanonicalEntity, CompileReport, EmittedAgentPreview, RejectedEntity } from './types.js';

export * from './types.js';
export * from './loaders.js';
export * from './classifier.js';
export * from './emitter.js';
export * from './pack-writer.js';
export { enrichWithOllama } from './narrative-extractor.js';

export interface CompileOptions extends PackWriteOptions {
  inputPath: string;
  ownerOrg: string;
  useOllama?: boolean;
  ollama?: ExtractorConfig;
  dryRun?: boolean;
}

export async function compileEntityPack(opts: CompileOptions): Promise<{
  report: CompileReport;
  agents: AgentSpec[];
}> {
  // 1. Load
  const loaded: CanonicalEntity[] = loadDirectory(opts.inputPath);

  // 2. (Optional) Ollama refinement of narrative entities
  const enriched = opts.useOllama
    ? (await enrichWithOllama(loaded, opts.ollama ?? {})).enriched
    : loaded;

  // 3. Classify + emit + validate
  const perEntity: EmittedAgentPreview[] = [];
  const rejected: RejectedEntity[] = [];
  const warnings: string[] = [];
  const allAgents: AgentSpec[] = [];

  for (const e of enriched) {
    const cls = classify(e);
    if (!cls.shouldEmit) {
      rejected.push({ entityId: e.id, reasons: cls.reasons });
      continue;
    }
    const raw = emitAgents(e, cls.archetype, { packId: opts.packId });
    const validAgents: AgentSpec[] = [];
    const failReasons: string[] = [];
    for (const a of raw) {
      try {
        const validated = validateAgentSpec(a);
        validAgents.push(validated);
      } catch (err) {
        failReasons.push(`${a.id}: ${(err as Error).message}`);
      }
    }
    if (validAgents.length === 0) {
      rejected.push({ entityId: e.id, reasons: ['all emitted agents failed validation', ...failReasons] });
      continue;
    }
    if (failReasons.length) warnings.push(...failReasons);
    allAgents.push(...validAgents);
    perEntity.push({
      entityId: e.id,
      archetype: cls.archetype,
      agentIds: validAgents.map((a) => a.id),
      reasons: cls.reasons,
    });
  }

  // 4. Write (unless dry-run)
  if (!opts.dryRun && allAgents.length > 0) {
    writePack(allAgents, opts);
  }

  const report: CompileReport = {
    compiledAt: new Date().toISOString(),
    inputPath: opts.inputPath,
    packId: opts.packId,
    ownerOrg: opts.ownerOrg,
    entitiesLoaded: enriched.length,
    entitiesEmitted: perEntity.length,
    entitiesRejected: rejected.length,
    agentsGenerated: allAgents.length,
    perEntity,
    rejected,
    warnings,
  };
  return { report, agents: allAgents };
}
