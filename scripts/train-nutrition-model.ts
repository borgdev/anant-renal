// Train the nutrition artifact (P5 step E).
//
//   npx tsx scripts/train-nutrition-model.ts
//
// Two heads: a PEW classifier (the XGBoost-style GBDT with a SHAP-surrogate
// attribution, §2.6) and a next-session potassium forecast regressor. Synthetic
// cohorts with a KNOWN generating pathway, patient-level split, and both heads
// measured against their clinical prior (the PEW marker count / the mechanistic
// potassium forecast). The published XGBoost PEW result (AUC 0.827) is the
// BENCHMARK; the acceptance is AUC ≥ 0.80 on synthetic held-out data.

import { buildNutritionTrainingRows, saveNutritionArtifact, trainNutritionArtifact, loadNutritionArtifact } from '../src/swarm/nutrition-model.js';

const rows = buildNutritionTrainingRows();
const artifact = trainNutritionArtifact(rows, { salt: 'nutrition-v1' });
const path = saveNutritionArtifact(artifact);

console.log('nutrition / electrolyte artifact trained');
console.log('  artifact          ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients     ', artifact.rows, '/', artifact.patients, '(synthetic cohorts with a known generating pathway)');
console.log(
  '  PEW classifier    ',
  `AUROC ${artifact.classifier.metrics.auroc} (marker-count prior ${artifact.classifier.priorAuroc})`,
  `Brier ${artifact.classifier.metrics.brier}`,
  `ECE ${artifact.classifier.metrics.ece}`,
  `pos/neg ${artifact.classifier.metrics.positives}/${artifact.classifier.metrics.negatives}`,
);
console.log(
  '  K forecast head   ',
  `MAE ${artifact.regressor.metrics.mae} (mechanistic prior ${artifact.regressor.prior.mae})`,
  `RMSE ${artifact.regressor.metrics.rmse}`,
  `bias ${artifact.regressor.metrics.bias}`,
  `corr ${artifact.regressor.metrics.correlation}`,
);
console.log('  pathway audit     ', artifact.pathwayAudit.map((a) => `${a.pathway}: obs ${a.observedPewRate} / score ${a.meanScore} (n=${a.rows})`).join(' | '));
for (const pathway of artifact.pathwayAudit.map((a) => a.pathway)) {
  const top = artifact.pathwayAttribution[pathway]?.slice(0, 4).map((a) => `${a.feature}=${a.share}`).join(' ') ?? '';
  console.log(`  attribution ${pathway.padEnd(20)} ${top}`);
}
console.log('  reload check      ', loadNutritionArtifact()?.id ?? 'FAILED');

const meetsPew = artifact.classifier.metrics.auroc >= 0.8;
const beatsPrior = artifact.classifier.metrics.auroc > artifact.classifier.priorAuroc;
const improvesK = artifact.regressor.metrics.mae < (artifact.regressor.prior.mae ?? Number.POSITIVE_INFINITY);
console.log('  acceptance        ', `PEW AUROC ≥ 0.80 ${meetsPew ? 'PASS' : 'FAIL'} · beats marker-count prior ${beatsPrior ? 'PASS' : 'FAIL'} · potassium beats the mechanistic forecast ${improvesK ? 'PASS' : 'FAIL'}`);
