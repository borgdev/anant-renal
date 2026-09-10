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
