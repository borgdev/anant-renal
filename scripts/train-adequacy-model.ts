// Train the adequacy clearance head (P1 step E) — trees over the Daugirdas prior.
//
//   npx tsx scripts/train-adequacy-model.ts
//
// Trains on the SYNTHETIC longitudinal cohort (src/simulator/longitudinal.ts),
// evaluates on a patient-level split against persistence AND the mechanistic
// prior, writes adequacy-train/artifacts/adequacy.ktv-v1.json and prints the
// model card. Synthetic data only — never claim real-cohort validation here.

import { buildAdequacyTrainingRows, defaultAdequacyTrainingSpecs, saveAdequacyArtifact, trainAdequacyArtifact, loadAdequacyArtifact } from '../src/swarm/adequacy-model.js';

const rows = buildAdequacyTrainingRows(defaultAdequacyTrainingSpecs());
const artifact = trainAdequacyArtifact(rows, { salt: 'adequacy-v1' });
const path = saveAdequacyArtifact(artifact);

console.log('adequacy clearance head trained');
console.log('  artifact     ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients', artifact.rows, '/', artifact.patients, '(synthetic)');
console.log('  head MAE     ', artifact.metrics.head.mae, '| MAPE', artifact.metrics.head.mape, '%');
console.log('  persistence  ', artifact.metrics.persistence.mae);
console.log('  prior alone  ', artifact.metrics.referencePrior.mae);
console.log('  vs persistence', artifact.metrics.headVsPersistenceImprovementPct, '% | vs prior', artifact.metrics.headVsReferenceImprovementPct, '%');
console.log('  attribution  ', (artifact.modelCard.attribution as Array<{ feature: string; share: number }>).slice(0, 5).map((a) => `${a.feature}=${a.share}`).join(' '));
console.log('  reload check ', loadAdequacyArtifact()?.id ?? 'FAILED');

// Acceptance criteria from the implementation strategy §2.3: MAPE ≤ 5%, Corr ≥ 0.85.
const mape = artifact.metrics.head.mape ?? 100;
const corr = artifact.metrics.head.correlation ?? 0;
console.log('  acceptance   ', `MAPE ${mape}% (≤5%) ${mape <= 5 ? 'PASS' : 'FAIL'} · Corr ${corr} (≥0.85) ${corr >= 0.85 ? 'PASS' : 'FAIL'}`);
console.log('  note         ', 'persistence (last measured URR) is a strong floor for stable patients; the head exists for counterfactual prescriptions, which persistence cannot answer.');
