/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// Train the COUPLED CKD-MBD artifact (P4 step E).
//
//   npx tsx scripts/train-mbd-model.ts
//
// Three coupled heads (phosphate, corrected calcium, PTH) trained on synthetic
// therapy-response cohorts, patient-level split, compared head-to-head with the
// mechanical coupled responder. The published cross-sectional SVM (AUC 0.840) is
// the benchmark for a risk classifier — not a result of this system. The §2.5
// acceptance is a per-analyte multi-output MAE.

import { buildMbdTrainingRows, saveMbdArtifact, trainMbdArtifact, loadMbdArtifact } from '../src/swarm/mbd-model.js';

const rows = buildMbdTrainingRows();
const artifact = trainMbdArtifact(rows, { salt: 'mbd-v1', horizonDays: 30 });
const path = saveMbdArtifact(artifact);

const heads = ['phosphate', 'correctedCalcium', 'pth'] as const;
console.log('coupled CKD-MBD artifact trained (multi-output)');
console.log('  artifact          ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients     ', artifact.rows, '/', artifact.patients, '(synthetic therapy-response cohorts)');
console.log('  horizon           ', artifact.horizonDays, 'd');
for (const head of heads) {
  const metrics = artifact.heads[head].metrics;
  console.log(
    `  ${head.padEnd(18)}MAE ${String(metrics.mae).padEnd(8)} (prior ${String(artifact.heads[head].prior.mae).padEnd(8)}) RMSE ${String(metrics.rmse).padEnd(8)} bias ${String(metrics.bias).padEnd(8)} corr ${metrics.correlation}`,
  );
}
console.log('  coupling (error correlation P vs Ca)', artifact.metrics.couplingCorrelation);
const attribution = artifact.modelCard.attribution as Record<string, Array<{ feature: string; share: number }>>;
console.log('  attribution phosphate', attribution.phosphate!.slice(0, 4).map((a) => `${a.feature}=${a.share}`).join(' '));
console.log('  attribution PTH      ', attribution.pth!.slice(0, 4).map((a) => `${a.feature}=${a.share}`).join(' '));
console.log('  reload check      ', loadMbdArtifact()?.id ?? 'FAILED');

const beats = heads.map((h) => artifact.metrics.mae[h] <= artifact.metrics.priorMae[h]);
console.log('  acceptance        ', `beats the coupled responder on all three analytes ${beats.every(Boolean) ? 'PASS' : `FAIL (${heads.filter((h, i) => !beats[i]).join(', ')})`}`);
