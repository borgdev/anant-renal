// Train the fluid / IDH head (P2 step E) — trees over the mechanistic UF prior.
//
//   npx tsx scripts/train-fluid-model.ts
//
// Synthetic session generator (physiologically consistent), patient-level split,
// compared against the mechanistic prior. Writes
// fluid-train/artifacts/fluid.idh-v1.json and prints the model card.
// The published TFT AUROC 0.953 stays the benchmark, not a claim.

import { buildFluidTrainingRows, saveFluidArtifact, trainFluidArtifact, loadFluidArtifact } from '../src/swarm/fluid-model.js';

const rows = buildFluidTrainingRows();
const artifact = trainFluidArtifact(rows, { salt: 'fluid-v1' });
const path = saveFluidArtifact(artifact);

console.log('fluid IDH head trained');
console.log('  artifact     ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients', artifact.rows, '/', artifact.patients, '(synthetic)');
console.log('  head AUROC   ', artifact.metrics.auroc, '| Brier', artifact.metrics.brier, '| ECE', artifact.metrics.ece);
console.log('  prior alone  ', artifact.metrics.priorAuroc, '| Brier', artifact.metrics.priorBrier);
console.log('  prior-only head', artifact.metrics.priorOnlyHeadAuroc, '(ablation: booster fed only the prior)');
console.log('  events       ', artifact.metrics.positives, 'pos /', artifact.metrics.negatives, 'neg');
console.log('  attribution  ', (artifact.modelCard.attribution as Array<{ feature: string; share: number }>).slice(0, 5).map((a) => `${a.feature}=${a.share}`).join(' '));
console.log('  reload check ', loadFluidArtifact()?.id ?? 'FAILED');

const auroc = artifact.metrics.auroc ?? 0;
const gain = (artifact.metrics.auroc ?? 0) - (artifact.metrics.priorAuroc ?? 0);
console.log('  acceptance   ', `AUROC ${auroc} (≥0.85 target) ${auroc >= 0.85 ? 'PASS' : 'FAIL'} · vs prior ${gain >= 0 ? '+' : ''}${Math.round(gain * 1000) / 1000}`);
