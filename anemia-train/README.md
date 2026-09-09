# Anemia / ESA dose trainer (P2)

Offline trainer for the **Anant Health** anemia/ESA CDSS. Implements the
architecture of *"A Manifold Learning Model for Adjusting Anemia Treatment in
Chronic Kidney Disease"* (Array 2026): a **contractive autoencoder**
`EN(20→48→24→2)` + decoder + a latent **dose regressor** `RN(2→32→16→1)` (leaky
ReLU 0.3, Glorot init) that predicts the next weekly ESA dose (units/wk).

**Trainer language = Python; serving = TypeScript.** The trainer is an offline,
dev-only tool. It exports a self-describing JSON artifact that the TS server
(`src/swarm/anemia-model.ts`) loads and serves under the **same**
`EsaRecommendation` contract as the P0/P1 reference surrogate — guardrails +
coverage gate still apply. **Tests/CI never need Python**; they read the
committed artifact.

## Why this is honest

- **No train/serve drift** — the input vector layout + per-feature domain bounds
  live in `feature_catalog.json` (a drift test asserts it equals the TS
  `ESA_FEATURES`/`HGB_TARGET`/`ESA_DOSE_STEP` in `src/swarm/anemia.ts`). Both the
  Python trainer and the TS loader build the vector from that one catalog.
- **Still synthetic** — trained on a deterministic seeded cohort whose
  "clinician" decisions follow the KDIGO-consistent reference policy, until P3
  supplies a consented cohort. Every surface keeps the synthetic label.
- **Governed** — P1's coverage gate, iron-first guardrails, red-team rt-013..016
  and the advisor activation gate apply to the trained model unchanged.

## Run

```bash
# from the repo root (torch/numpy/sklearn already installed — no venv):
python3 anemia-train/train.py
# -> writes anemia-train/artifacts/anemia.esa-dose-v1.json
#    (+ anemia.esa-dose-v1.onnx when the torch.onnx export succeeds)
# prints a single JSON report on stdout (mirrors native/liquid-train)
```

Flags: `--seed`, `--patients`, `--epochs`, `--batch`, `--lr`,
`--contractive-lambda`, `--model-id`, `--model-version`, `--out-dir`.

## Artifact

`anemia-train/artifacts/anemia.esa-dose-v1.json` — self-describing:
`{ format, model, featureCatalog, vector.layout, architecture, weights,
relevance (permutation Rᵢ aggregated to feature id), golden (canonical window +
vector + prediction), metrics (trainMae/testMae/baselineMae/pearson), synthetic }`.

Golden parity (in `tests/anemia-trained.test.ts`) loads this artifact and asserts
the TypeScript forward pass reproduces the Python `golden.prediction` — proving
the served model == the trained model.
