// Train the vascular access Δ-from-baseline head (P3 step E).
//
//   npx tsx scripts/train-access-model.ts
//
// Synthetic longitudinal access cohort, patient-level split, compared against
// the mechanistic stenosis prior AND a logistic Δ-only baseline. Writes
// access-train/artifacts/access.stenosis-v1.json and prints the model card.
//
// The published mel-spectrogram results (ResNet50 AUROC 0.99 / EfficientNetB5
// 0.98) are benchmarks for the audio path, not results of this system. The
// claim here is the strategy document's: longitudinal-only AUROC ≥ 0.80.

import { buildAccessTrainingRows, saveAccessArtifact, trainAccessArtifact, loadAccessArtifact } from '../src/swarm/access-model.js';
import { accessAcousticEnabled } from '../src/swarm/access-governance.js';
import { gbtAttribution } from '../src/protocols/gbdt.js';

const rows = buildAccessTrainingRows();
const artifact = trainAccessArtifact(rows, { salt: 'access-v1' });
const path = saveAccessArtifact(artifact);

const longitudinal = artifact.metrics.longitudinalOnlyAuroc ?? 0;
const prior = artifact.metrics.priorAuroc ?? 0;

console.log('vascular access Δ-from-baseline head trained');
console.log('  artifact          ', artifact.id, 'v' + artifact.version, '→', path);
console.log('  rows/patients     ', artifact.rows, '/', artifact.patients, '(synthetic)');
console.log('  longitudinal AUROC', longitudinal, '| Brier', artifact.metrics.brier, '| ECE', artifact.metrics.ece);
console.log('  head AUROC (with acoustic slot)', artifact.metrics.auroc);
console.log('  prior alone       ', prior, '| Brier', artifact.metrics.priorBrier);
console.log('  logistic Δ-baseline AUROC', artifact.metrics.baselineAuroc);
console.log('  events            ', artifact.metrics.positives, 'pos /', artifact.metrics.negatives, 'neg');
console.log('  attribution       ', gbtAttribution(artifact.model, 5).map((a) => `${a.feature}=${a.share}`).join(' '));
console.log('  acoustic flag     ', artifact.acoustic.flag, accessAcousticEnabled() ? 'ENABLED' : 'disabled', '| captures used', artifact.acoustic.captures);
console.log('  reload check      ', loadAccessArtifact()?.id ?? 'FAILED');
console.log('  acceptance        ', `longitudinal AUROC ${longitudinal} (≥0.80) ${longitudinal >= 0.8 ? 'PASS' : 'FAIL'} · vs prior ${longitudinal - prior >= 0 ? '+' : ''}${Math.round((longitudinal - prior) * 1000) / 1000}`);
