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

// Train the infection artifact (P6 step E).
//
//   npx tsx scripts/train-infection-model.ts
//
// One head: a blood-culture-positivity classifier (the GBDT with a
// SHAP-surrogate attribution). Synthetic cohorts with a KNOWN generating family,
// patient-level split, and the head measured against the graded CDC/NHSN
// temperature-rule prior on the same held-out rows. The published dialysis BSI /
// NHSN surveillance criteria are the BENCHMARK; the acceptance is AUC ≥ 0.85
// while beating the temperature rule.
//
// The PREVENTION half is not trained here, by design: it is deterministic rules
// over records (see src/swarm/infection-prevention.ts) and the model card records
// that no model output reaches it.

import { buildInfectionTrainingRows, saveInfectionArtifact, trainInfectionArtifact, loadInfectionArtifact, INFECTION_MODEL_TARGET_AUROC } from '../src/swarm/infection-model.js';

const rows = buildInfectionTrainingRows();
const artifact = trainInfectionArtifact(rows, { salt: 'infection-v1' });
const path = saveInfectionArtifact(artifact);

console.log('infection / vaccination artifact trained');
console.log('  artifact          ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients     ', artifact.rows, '/', artifact.patients, '(synthetic cohorts with a known generator family)');
console.log(
  '  BSI classifier    ',
  `AUROC ${artifact.classifier.metrics.auroc} (temperature-rule prior ${artifact.classifier.priorAuroc}; gain ${artifact.classifier.aurocGain})`,
  `Brier ${artifact.classifier.metrics.brier}`,
  `ECE ${artifact.classifier.metrics.ece}`,
  `pos/neg ${artifact.classifier.metrics.positives}/${artifact.classifier.metrics.negatives}`,
);
console.log('  generator audit   ', artifact.generatorAudit.map((a) => `${a.generator}: obs ${a.observedRate} / score ${a.meanScore} (n=${a.rows})`).join(' | '));
for (const generator of artifact.generatorAudit.map((a) => a.generator)) {
  const top = artifact.generatorAttribution[generator]?.slice(0, 4).map((a) => `${a.feature}=${a.share}`).join(' ') ?? '';
  console.log(`  attribution ${generator.padEnd(24)} ${top}`);
}
console.log('  reliability bins  ', artifact.reliability.map((b) => `${b.bin}:${b.meanPredicted}→${b.observedRate}(n=${b.n})`).join(' '));
console.log('  reload check      ', loadInfectionArtifact()?.id ?? 'FAILED');
console.log('  prevention path   ', artifact.modelCard['preventionPath'] && (artifact.modelCard['preventionPath'] as { trained: boolean }).trained === false ? 'rules-only, model-free (recorded in the card)' : 'MISSING');

const meetsTarget = artifact.classifier.metrics.auroc >= INFECTION_MODEL_TARGET_AUROC;
const beatsPrior = artifact.classifier.metrics.auroc > artifact.classifier.priorAuroc;
console.log('  acceptance        ', `BSI AUROC ≥ ${INFECTION_MODEL_TARGET_AUROC} ${meetsTarget ? 'PASS' : 'FAIL'} · beats the temperature-rule prior ${beatsPrior ? 'PASS' : 'FAIL'}`);
