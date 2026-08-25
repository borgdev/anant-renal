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

// Builds the bundled JSON snapshots the admin-ui shell reads from `admin-ui/`.
//
// The Operator Console (admin-ui/index.html) is a bundled-snapshot demo shell:
// its `api()` GET shim serves catalog routes from local JSON files next to
// index.html (summary.json, agents.json, measures.json, assessments.json,
// lifecycle.json, research.json, realm.json). Only realm.json ships in the
// repo, which is why the dashboard hangs on "Loading…" — the rest are missing.
//
// This script regenerates them from the real source data so the shell renders:
//   npx tsx scripts/build-admin-snapshots.ts
//
// (The deploy pipeline normally writes these via pplx-tool; this makes the
// dev-server-served shell self-sufficient too.)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateAgentSpec } from '../src/agents/index.js';
import { ALL_CMS_MEASURES } from '../src/healthcare-core/cms-measure-catalog.js';
import { LIFECYCLE_STAGES } from '../src/lifecycle/index.js';
import { RESEARCH_SOURCES } from '../src/research/index.js';
import {
  PHQ9, GAD7, AUDIT_C, BRADEN, MORSE, KDQOL_36_SUMMARY, MNA_SF,
  CAM_DELIRIUM, FRAIL_SCALE, SDOH_5_DOMAIN, ADL_KATZ, IADL_LAWTON, MOCA_SUMMARY,
} from '../src/assessments/index.js';

const UI = resolve(process.cwd(), 'admin-ui');

// Mirrors loadAllAgents() in src/server/admin-routes.ts (reads pack agent YAML).
const PACK_ROOTS: readonly { id: string; dir: string }[] = [
  { id: 'flagship-agents', dir: 'packs/flagship-agents/agents' },
  { id: 'dialysis-deep', dir: 'packs/dialysis-deep/agents' },
  { id: 'primary-care-deep', dir: 'packs/primary-care-deep/agents' },
  { id: 'urgent-care-deep', dir: 'packs/urgent-care-deep/agents' },
  { id: 'research-pharma', dir: 'packs/research-pharma/agents' },
  { id: 'dialysis-provider', dir: 'packs/dialysis-provider/agents' },
];

function loadAgents(): {
  packId: string; id: string; displayName: string; description?: string;
  setting?: string; lifecycleStage?: string;
  triggerKind: string; triggerEventType?: string;
  baseFeeUsd?: number; budgetCapMonthlyUsd?: number;
}[] {
  const out: ReturnType<typeof loadAgents> = [];
  for (const p of PACK_ROOTS) {
    let files: string[];
    try { files = readdirSync(p.dir).filter((f) => f.endsWith('.yaml')); } catch { continue; }
    for (const f of files) {
      try {
        const raw = parseYaml(readFileSync(join(p.dir, f), 'utf8'));
        const spec = validateAgentSpec(raw);
        const labels = (spec.labels ?? {}) as Record<string, string | undefined>;
        out.push({
          packId: p.id,
          id: spec.id,
          displayName: spec.displayName,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          ...(labels.setting !== undefined ? { setting: labels.setting } : {}),
          ...(labels.lifecycleStage !== undefined ? { lifecycleStage: labels.lifecycleStage } : {}),
          triggerKind: spec.trigger.kind,
          ...(spec.trigger.kind === 'event' && spec.trigger.eventType !== undefined ? { triggerEventType: spec.trigger.eventType } : {}),
          ...(spec.billing?.baseFeeUsd !== undefined ? { baseFeeUsd: spec.billing.baseFeeUsd } : {}),
          ...(spec.billing?.budgetCapMonthlyUsd !== undefined ? { budgetCapMonthlyUsd: spec.billing.budgetCapMonthlyUsd } : {}),
        });
      } catch { /* skip malformed agent yaml */ }
    }
  }
  return out;
}

const agents = loadAgents();

const measures = ALL_CMS_MEASURES.map((m) => {
  const title = (m as { title?: string }).title;
  const programId = (m as { programId?: string }).programId;
  return {
    id: m.id,
    ...(programId !== undefined ? { programId } : {}),
    name: title ?? (m as { description?: string }).description ?? m.id,
    description: title ?? (m as { description?: string }).description ?? m.id,
  };
});

const ASSESSMENTS = [PHQ9, GAD7, AUDIT_C, BRADEN, MORSE, KDQOL_36_SUMMARY, MNA_SF, CAM_DELIRIUM, FRAIL_SCALE, SDOH_5_DOMAIN, ADL_KATZ, IADL_LAWTON, MOCA_SUMMARY];
const assessments = ASSESSMENTS.map((a) => ({
  id: a.id,
  title: a.title,
  ...(a.loinc !== undefined ? { loinc: a.loinc } : {}),
  domain: a.domain,
  itemCount: a.items.length,
}));

const lifecycle = LIFECYCLE_STAGES.map((s) => ({ id: s.stage }));

const research = RESEARCH_SOURCES.map((s) => ({ id: s.id, name: s.title, category: s.category }));

const byPack: Record<string, number> = {};
for (const a of agents) byPack[a.packId] = (byPack[a.packId] ?? 0) + 1;

const summary = {
  agents: { total: agents.length, byPack },
  measures: { total: measures.length },
  assessments: { total: assessments.length },
  lifecycleStages: lifecycle.length,
  researchSources: research.length,
};

const files: Record<string, unknown> = {
  'agents.json': agents,
  'measures.json': measures,
  'assessments.json': assessments,
  'lifecycle.json': lifecycle,
  'research.json': research,
  'summary.json': summary,
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(UI, name), JSON.stringify(data, null, 2));
  console.log(`wrote admin-ui/${name} (${Array.isArray(data) ? data.length + ' entries' : Object.keys(data).length + ' keys'})`);
}
console.log(`\nsummary: ${summary.agents.total} agents · ${summary.measures.total} measures · ${summary.assessments.total} assessments · ${summary.lifecycleStages} lifecycle stages · ${summary.researchSources} research sources`);
