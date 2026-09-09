#!/usr/bin/env python3
"""
Anemia / ESA dose trainer — P2 "real trainer" (still synthetic, see §4 notes).

Trains the paper's architecture on a deterministic synthetic cohort:
  • encoder   EN(x -> 25 -> 5 -> 2)      — contractive autoencoder latent (z)
  • decoder   DE(2 -> 5 -> 25 -> x_hat)  — reconstruction head
  • regressor RN(2 -> 6 -> 1)            — predicts the next weekly ESA dose
                                            (units/wk) from the latent z
All activations leaky ReLU(0.3); linear layers Glorot-init; patient-disjoint
70/30 split; permutation importances (Rᵢ) reported aggregated to feature id.

NO TRAIN/SERVE DRIFT: the input vector is built from anemia-train/feature_catalog.json
(the same catalog the TS server mirrors + a drift test enforces), and the exported
artifact self-describes its layout. The TS side only ever reads the artifact.

Run:  python3 anemia-train/train.py            # -> anemia-train/artifacts/
Print: a single JSON report on stdout (mirrors native/liquid-train behaviour).
"""

import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

HERE = Path(__file__).resolve().parent


# ----------------------------------------------------------------------------
# 1. Feature catalog (single source of truth for both trainer + server)
# ----------------------------------------------------------------------------
def load_catalog():
    with open(HERE / "feature_catalog.json", "r", encoding="utf-8") as fh:
        return json.load(fh)


CATALOG = load_catalog()
FEATURES = {f["id"]: f for f in CATALOG["features"]}
LAYOUT = CATALOG["vector"]["layout"]
INPUT_DIM = CATALOG["vector"]["inputDim"]


def norm(v, lo, hi):
    """Per-feature-domain normalization to [-1,1], clamped (mirrors TS esaLatent)."""
    return max(-1.0, min(1.0, (v - lo) / (hi - lo) * 2.0 - 1.0))


def hgb_weeks(trend, current_hgb):
    """Deterministic 12-week Hb series ending at currentHgb (mirrors the TS builder)."""
    t = list(trend) if trend is not None else []
    if not t:
        t = [current_hgb]
    if t[-1] != current_hgb:
        t = t + [current_hgb]
    if len(t) > 12:
        t = t[-12:]
    while len(t) < 12:
        t.insert(0, t[0])
    return t


def build_vector(window):
    """Build the fixed 20-dim input vector from a window dict.

    Order = catalog layout: 12 hgb weeks (oldest->newest, last = currentHgb),
    6 current labs, priorEpo, onESA indicator.
    """
    vals = []
    for w in hgb_weeks(window.get("hgbTrendLast90d"), float(window["currentHgb"])):
        vals.append(norm(w, FEATURES["hgb"]["min"], FEATURES["hgb"]["max"]))
    for feat_id in ("mcv", "ferritin", "transferrinSat", "crp", "calcium", "pth"):
        f = FEATURES[feat_id]
        v = float(window.get(feat_id, (f["min"] + f["max"]) / 2))
        vals.append(norm(v, f["min"], f["max"]))
    pe = FEATURES["priorEpo"]
    vals.append(norm(float(window.get("currentDose", 0.0)) or 0.0, pe["min"], pe["max"]))
    vals.append(1.0 if window.get("onESA", True) else 0.0)
    assert len(vals) == INPUT_DIM, f"vector length {len(vals)} != {INPUT_DIM}"
    return vals


# ----------------------------------------------------------------------------
# 2. Synthetic cohort generator (deterministic, seeded)
# ----------------------------------------------------------------------------
def clinician_next(on_esa, current_hgb, dose, rising):
    """KDIGO-consistent 'clinician' dose decision — mirrors the P0 surrogate so
    the trained model learns the reference policy (golden parity is then real).
    Weekly dose is capped at a realistic clinical maximum (MAX_DOSE)."""
    if not on_esa:
        if current_hgb >= 10.0:
            return 0.0
        return 2000.0
    if current_hgb > 12.0:
        if current_hgb > 13.0 or rising:
            return 0.0
        return min(MAX_DOSE, int(round(dose * 0.75 / 500.0)) * 500.0)
    if current_hgb < 10.0:
        return min(MAX_DOSE, int(round(dose * 1.25 / 500.0)) * 500.0)
    return min(MAX_DOSE, dose)


def generate_cohort(rng, n_patients):
    """Each patient -> one final training window (12 weekly Hb + labs + dose) + label."""
    samples = []
    for _ in range(n_patients):
        on_esa = rng.random() < 0.92
        # Baseline labs (fixed per patient, within-domain, iron-replete, non-microcytic).
        mcv = float(np.clip(rng.normal(92.0, 5.0), 82.0, 104.0))
        ferritin = float(np.clip(rng.lognormal(math.log(640.0), 0.4), 120.0, 2600.0))
        tsat = float(np.clip(rng.normal(29.0, 6.0), 18.0, 55.0))
        crp = float(np.clip(rng.lognormal(math.log(6.0), 0.7), 0.5, 90.0))
        calcium = float(np.clip(rng.normal(9.2, 0.4), 8.2, 10.4))
        pth = float(np.clip(rng.lognormal(math.log(120.0), 0.5), 25.0, 900.0))
        # 12-week Hb path with autoregression + gentle mean reversion to ~11.0.
        h = [float(np.clip(rng.normal(10.7, 1.1), 7.4, 15.0))]
        for _ in range(11):
            nxt = h[-1] + rng.normal(0.0, 0.3) + (11.0 - h[-1]) * 0.08
            h.append(float(np.clip(nxt, 7.0, 16.0)))
        # Simulate weekly dose progression so prior-EPO is the dominant driver.
        dose = float(rng.integers(7, 25) * 500)  # 3500..12000 start
        for t in range(11):
            rising = (h[t] - h[max(0, t - 4)]) > 1.0
            dose = float(clinician_next(on_esa, h[t], dose, rising))
        rising = (h[11] - h[7]) > 1.0
        label = float(clinician_next(on_esa, h[11], dose, rising))
        window = {
            "currentHgb": h[11],
            "hgbTrendLast90d": h,
            "mcv": mcv, "ferritin": ferritin, "transferrinSat": tsat,
            "crp": crp, "calcium": calcium, "pth": pth,
            "onESA": on_esa, "currentDose": dose,
        }
        samples.append((window, label))
    return samples


MAX_DOSE = 20000.0


def served_dose(model, z):
    """Raw dose prediction clamped to a sane weekly dose range (both python + TS)."""
    return torch.clamp(model.dose(z)[:, 0] * 1000.0, 0.0, MAX_DOSE)


# ----------------------------------------------------------------------------
# 3. Model — contractive autoencoder + latent dose regressor
# ----------------------------------------------------------------------------
def xavier_linear(in_f, out_f):
    layer = nn.Linear(in_f, out_f)
    nn.init.xavier_uniform_(layer.weight, gain=nn.init.calculate_gain("leaky_relu", 0.3))
    nn.init.zeros_(layer.bias)
    return layer


class EsaDoseNet(nn.Module):
    """EN(20->25->5->2) + DE(2->5->25->20) + RN(2->16->1). leaky ReLU(0.3)."""

    def __init__(self, input_dim=INPUT_DIM):
        super().__init__()
        self.act = nn.LeakyReLU(0.3)
        self.e1 = xavier_linear(input_dim, 48)
        self.e2 = xavier_linear(48, 24)
        self.e3 = xavier_linear(24, 2)
        self.d1 = xavier_linear(2, 24)
        self.d2 = xavier_linear(24, 48)
        self.d3 = xavier_linear(48, input_dim)
        self.r1 = xavier_linear(2, 32)
        self.r2 = xavier_linear(32, 16)
        self.r3 = xavier_linear(16, 1)

    def encode(self, x):
        # Bounded latent z in [-1, 1]^2 — keeps the latent manifold interpretable
        # and the dose readout stable. The contractive Jacobian is over this output.
        return torch.tanh(self.e3(self.act(self.e2(self.act(self.e1(x))))))

    def decode(self, z):
        return self.d3(self.act(self.d2(self.act(self.d1(z)))))

    def dose(self, z):
        return self.r3(self.act(self.r2(self.act(self.r1(z)))))

    def forward(self, x):
        z = self.encode(x)
        return z, self.decode(z), self.dose(z)


def jacobian_norm(model, x):
    """Frobenius norm of the encoder Jacobian d z / d x (contractive penalty)."""
    x = x.detach().requires_grad_(True)
    z = model.encode(x)
    total = torch.zeros((), device=x.device)
    for j in range(z.shape[1]):
        g = torch.autograd.grad(z[:, j].sum(), x, create_graph=True, retain_graph=True)[0]
        total = total + (g ** 2).sum(dim=1).mean()
    return total


# ----------------------------------------------------------------------------
# 4. Training
# ----------------------------------------------------------------------------
def train(args):
    rng = np.random.default_rng(args.seed)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    cohort = generate_cohort(rng, args.patients)
    # Patient-disjoint split by first-occurrence index.
    n = len(cohort)
    n_test = max(1, round(n * 0.3))
    idx = list(range(n))
    rng.shuffle(idx)
    test_idx = set(idx[:n_test])
    train_s, train_y, test_s, test_y = [], [], [], []
    for i, (w, y) in enumerate(cohort):
        if i in test_idx:
            test_s.append(w)
            test_y.append(y)
        else:
            train_s.append(w)
            train_y.append(y)

    Xtr = torch.tensor([build_vector(w) for w in train_s], dtype=torch.float32)
    Ytr = torch.tensor(train_y, dtype=torch.float32).view(-1, 1) / 1000.0
    Xte = torch.tensor([build_vector(w) for w in test_s], dtype=torch.float32)
    Yte = torch.tensor(test_y, dtype=torch.float32).view(-1, 1) / 1000.0

    # Per-sample weights — dose-CHANGE events (increase/reduce/suspend) are the
    # minority but the clinical signal; weight them so the model learns the band
    # logic instead of collapsing to "hold the prior dose".
    Wtr = torch.tensor([6.0 if (train_y[i] != train_s[i]["currentDose"]) else 1.0 for i in range(len(train_y))], dtype=torch.float32)

    model = EsaDoseNet()
    # End-to-end supervised: EN -> 2-D latent z -> RN predicts the next weekly
    # dose (k-units). A light reconstruction + contractive term keeps z a stable,
    # interpretable manifold while the dose objective forces z to encode the
    # dose-relevant signal (prior EPO + current Hb). This mirrors the paper's
    # EN(..->2) + RN(2->1) contract while staying trainable on our synthetic rule.
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-5)
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(Xtr.shape[0])
        for b0 in range(0, Xtr.shape[0], args.batch):
            bi = perm[b0:b0 + args.batch]
            xb = Xtr[bi]
            z, recon, dose_p = model(xb)
            jac = jacobian_norm(model, xb)
            w = Wtr[bi]
            loss = ((dose_p - Ytr[bi]) ** 2 * w.unsqueeze(1)).mean() \
                + 0.05 * nn.functional.mse_loss(recon, xb) \
                + args.contractive_lambda * jac
            opt.zero_grad()
            loss.backward()
            opt.step()
    model.eval()
    with torch.no_grad():
        pred_units = served_dose(model, model.encode(Xte))
        target_units = torch.tensor(test_y, dtype=torch.float32)
        test_mae = float((pred_units - target_units).abs().mean())
        pred_tr = served_dose(model, model.encode(Xtr))
        target_tr = torch.tensor(train_y, dtype=torch.float32)
        train_mae = float((pred_tr - target_tr).abs().mean())
        base_mae = float((torch.tensor([w["currentDose"] for w in test_s], dtype=torch.float32) - target_units).abs().mean())
        num = ((pred_units - pred_units.mean()) * (target_units - target_units.mean())).sum()
        den = torch.sqrt(((pred_units - pred_units.mean()) ** 2).sum() * ((target_units - target_units.mean()) ** 2).sum())
        pearson = float((num / den).clamp(-1, 1)) if den.item() > 0 else 0.0

    # Permutation importances (deterministic per column) aggregated to feature id.
    columns = [f"hgb_w{k}" for k in range(12)] + ["mcv", "ferritin", "transferrinSat", "crp", "calcium", "pth", "priorEpo", "onESA"]
    with torch.no_grad():
        pred = served_dose(model, model.encode(Xte))
        base_mse = float(((pred - target_units) ** 2).mean())
    imp = {}
    prng = np.random.default_rng(args.seed + 1)
    for c, col in enumerate(columns):
        worst = 0.0
        for _ in range(3):
            xp = Xte.clone()
            perm_idx = torch.from_numpy(prng.permutation(Xte.shape[0]))
            xp[:, c] = xp[perm_idx, c]
            with torch.no_grad():
                pred_p = served_dose(model, model.encode(xp))
            mse = float(((pred_p - target_units) ** 2).mean())
            worst = max(worst, mse)
        imp[col] = max(0.0, worst - base_mse)
    agg = {}
    for col, v in imp.items():
        key = "hgb" if col.startswith("hgb_w") else col
        agg[key] = agg.get(key, 0.0) + v
    total_imp = sum(agg.values()) or 1.0
    relevance = [{"id": k, "relevance": round(v / total_imp, 4)} for k, v in sorted(agg.items(), key=lambda kv: -kv[1])]

    # Golden window (mirrors the P0 seed p-esa-1 window) + model prediction.
    golden_window = {
        "currentHgb": 9.4, "hgbTrendLast90d": [8.8, 8.9, 9.0, 9.1, 9.2, 9.4],
        "mcv": 92.0, "ferritin": 640.0, "transferrinSat": 28.0, "crp": 6.0,
        "calcium": 9.2, "pth": 120.0, "onESA": True, "currentDose": 8000.0,
    }
    gvec = torch.tensor([build_vector(golden_window)], dtype=torch.float32)
    with torch.no_grad():
        gpred = float(served_dose(model, model.encode(gvec))[0].item())

    os.makedirs(args.out_dir, exist_ok=True)
    artifact_path = os.path.join(args.out_dir, f"{args.model_id}.json")
    artifact = {
        "format": "anant-esa-trained-v1",
        "model": {"id": args.model_id, "version": args.model_version, "kind": "trained"},
        "featureCatalog": CATALOG,
        "vector": {"inputDim": INPUT_DIM, "layout": LAYOUT},
        "architecture": {"encoder": [INPUT_DIM, 48, 24, 2], "decoder": [2, 24, 48, INPUT_DIM], "regressor": [2, 32, 16, 1], "activation": "leaky_relu_0.3", "contractive": True},
        "weights": {
            "encoder": [{"w": model.e1.weight.detach().tolist(), "b": model.e1.bias.detach().tolist()},
                        {"w": model.e2.weight.detach().tolist(), "b": model.e2.bias.detach().tolist()},
                        {"w": model.e3.weight.detach().tolist(), "b": model.e3.bias.detach().tolist()}],
            "regressor": [{"w": model.r1.weight.detach().tolist(), "b": model.r1.bias.detach().tolist()},
                          {"w": model.r2.weight.detach().tolist(), "b": model.r2.bias.detach().tolist()},
                          {"w": model.r3.weight.detach().tolist(), "b": model.r3.bias.detach().tolist()}],
        },
        "relevance": relevance,
        "golden": {"window": golden_window, "vector": [round(float(v), 6) for v in build_vector(golden_window)], "prediction": round(gpred, 2)},
        "metrics": {"trainMae": round(train_mae, 2), "testMae": round(test_mae, 2), "baselineMae": round(base_mae, 2), "pearson": round(pearson, 4), "nTrain": len(train_s), "nTest": len(test_s), "seed": args.seed},
        "synthetic": True,
    }
    with open(artifact_path, "w", encoding="utf-8") as fh:
        json.dump(artifact, fh, indent=1)

    # Optional ONNX export (record only — TS serves the JSON contract).
    try:
        import torch.onnx as _onnx

        class ServeModel(nn.Module):
            def __init__(self, model):
                super().__init__()
                self.model = model

            def forward(self, x):
                return self.model.dose(self.model.encode(x)) * 1000.0

        sm = ServeModel(model).eval()
        onnx_path = os.path.join(args.out_dir, f"{args.model_id}.onnx")
        torch.onnx.export(sm, gvec, onnx_path, input_names=["window"], output_names=["dose_units"], dynamic_axes=None)
    except Exception:
        pass

    report = {
        "modelId": args.model_id,
        "modelVersion": args.model_version,
        "artifactPath": artifact_path,
        "inputDim": INPUT_DIM,
        "latentDim": 2,
        "trainMae": round(train_mae, 2),
        "testMae": round(test_mae, 2),
        "baselineMae": round(base_mae, 2),
        "pearson": round(pearson, 4),
        "nTrain": len(train_s),
        "nTest": len(test_s),
        "relevance": relevance[:6],
        "goldenPrediction": round(gpred, 2),
        "seed": args.seed,
    }
    print(json.dumps(report))
    return report


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out-dir", default=str(HERE / "artifacts"))
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--patients", type=int, default=320)
    p.add_argument("--epochs", type=int, default=1000)
    p.add_argument("--batch", type=int, default=128)
    p.add_argument("--lr", type=float, default=4e-4)
    p.add_argument("--contractive-lambda", type=float, default=1e-4)
    p.add_argument("--model-id", default="anemia.esa-dose-v1")
    p.add_argument("--model-version", default="1.0.0")
    args = p.parse_args()
    train(args)


if __name__ == "__main__":
    main()
