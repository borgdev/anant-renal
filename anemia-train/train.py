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


# The head predicts the BAND, not the magnitude. The clinician rule is a band
# decision (suspend / reduce / hold / increase) whose magnitude is the protocol's
# own step, so regressing the magnitude with MSE optimises the wrong thing: it is
# scored by how close the units are, not by whether the decision was right. The
# head chooses the band; the protocol supplies the step.
BANDS = ["suspend", "reduce", "hold", "increase"]
BAND_FACTORS = {"suspend": 0.0, "reduce": 0.75, "hold": 1.0, "increase": 1.25}
# not-on-ESA patients are initiated at a fixed start dose rather than a factor of 0
ESA_INITIATION_DOSE = 2000.0


def band_of(label, prior):
    """Which band the recorded decision belongs to (the label the head learns)."""
    if label <= 0:
        return 0 if prior > 0 else 2  # suspend when on ESA, otherwise hold at zero
    if label > prior:
        return 3
    if label < prior:
        return 1
    return 2


def dose_for_band(band, prior, on_esa):
    """The protocol's step for a band — identical arithmetic to the trainer's
    clinician rule, so the model cannot invent a magnitude of its own."""
    if band == 0:
        return 0.0
    if band == 1:
        return min(MAX_DOSE, int(round(prior * BAND_FACTORS["reduce"] / 500.0)) * 500.0)
    if band == 3:
        return ESA_INITIATION_DOSE if not on_esa else min(MAX_DOSE, int(round(prior * BAND_FACTORS["increase"] / 500.0)) * 500.0)
    return prior


def served_dose(model, z, prior_dose, extra=None, on_esa=None):
    """Serve the band the head chooses through the protocol's own step."""
    prior = prior_dose if torch.is_tensor(prior_dose) else torch.tensor(list(prior_dose), dtype=torch.float32)
    logits = model.band(z, extra)
    band = torch.argmax(logits, dim=1)
    esa = on_esa if on_esa is not None else torch.ones_like(prior)
    out = prior.clone()
    for idx, name in enumerate(BANDS):
        mask = band == idx
        if not bool(mask.any()):
            continue
        if name == "suspend":
            out[mask] = 0.0
        elif name == "reduce":
            out[mask] = torch.round(prior[mask] * BAND_FACTORS["reduce"] / 500.0) * 500.0
        elif name == "increase":
            init = torch.where(esa[mask] > 0, torch.round(prior[mask] * BAND_FACTORS["increase"] / 500.0) * 500.0, torch.full_like(prior[mask], ESA_INITIATION_DOSE))
            out[mask] = init
    return torch.clamp(out, 0.0, MAX_DOSE)


def head_features(x):
    """Skip features for the residual head: the decision variable (hgb), the dose
    on record and the on-ESA flag, straight from the input vector.

    The 2-D latent is the interpretable manifold the paper's contract asks for,
    but forcing the dose head to see the band decision only through a 2-D
    bottleneck loses two thirds of the dose changes. A residual head is allowed to
    see what it is residualising on; the latent remains the explanation surface.
    """
    return torch.cat([x[:, 11:12], x[:, 18:20]], dim=1)


# ----------------------------------------------------------------------------
# 3. Model — contractive autoencoder + latent dose regressor
# ----------------------------------------------------------------------------
def xavier_linear(in_f, out_f):
    layer = nn.Linear(in_f, out_f)
    nn.init.xavier_uniform_(layer.weight, gain=nn.init.calculate_gain("leaky_relu", 0.3))
    nn.init.zeros_(layer.bias)
    return layer


class EsaDoseNet(nn.Module):
    """EN(20->48->24->2) + DE(2->24->48->20) + RN([z2|hgb|priorEpo|onESA]->32->16->1)."""

    def __init__(self, input_dim=INPUT_DIM):
        super().__init__()
        self.act = nn.LeakyReLU(0.3)
        self.e1 = xavier_linear(input_dim, 48)
        self.e2 = xavier_linear(48, 24)
        self.e3 = xavier_linear(24, 2)
        self.d1 = xavier_linear(2, 24)
        self.d2 = xavier_linear(24, 48)
        self.d3 = xavier_linear(48, input_dim)
        self.r1 = xavier_linear(5, 32)
        self.r2 = xavier_linear(32, 16)
        self.r3 = xavier_linear(16, len(BANDS))

    def encode(self, x):
        # Bounded latent z in [-1, 1]^2 — keeps the latent manifold interpretable
        # and the dose readout stable. The contractive Jacobian is over this output.
        return torch.tanh(self.e3(self.act(self.e2(self.act(self.e1(x))))))

    def decode(self, z):
        return self.d3(self.act(self.d2(self.act(self.d1(z)))))

    def band(self, z, extra=None):
        """Band logits: suspend / reduce / hold / increase."""
        head_in = z if extra is None else torch.cat([z, extra], dim=1)
        return self.r3(self.act(self.r2(self.act(self.r1(head_in)))))

    def forward(self, x):
        z = self.encode(x)
        hf = head_features(x)
        return z, self.decode(z), self.band(z, hf)


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
    # Patient-disjoint 70/15/15 split. The validation split exists so the head is
    # SELECTED on data it did not train on — reporting the last epoch's test MAE
    # was reading the test set twice (once to pick the epoch, once to report it).
    n = len(cohort)
    idx = list(range(n))
    rng.shuffle(idx)
    n_test = max(1, round(n * 0.15))
    n_val = max(1, round(n * 0.15))
    test_idx = set(idx[:n_test])
    val_idx = set(idx[n_test:n_test + n_val])
    train_s, train_y, val_s, val_y, test_s, test_y = [], [], [], [], [], []
    for i, (w, y) in enumerate(cohort):
        if i in test_idx:
            test_s.append(w)
            test_y.append(y)
        elif i in val_idx:
            val_s.append(w)
            val_y.append(y)
        else:
            train_s.append(w)
            train_y.append(y)

    def band_targets(samples, labels):
        return torch.tensor(
            [band_of(labels[i], samples[i]["currentDose"]) for i in range(len(labels))],
            dtype=torch.long,
        )

    Xtr = torch.tensor([build_vector(w) for w in train_s], dtype=torch.float32)
    Ytr = band_targets(train_s, train_y)
    Xval = torch.tensor([build_vector(w) for w in val_s], dtype=torch.float32)
    Yval = band_targets(val_s, val_y)
    Xte = torch.tensor([build_vector(w) for w in test_s], dtype=torch.float32)
    Yte = band_targets(test_s, test_y)
    train_prior = [w["currentDose"] for w in train_s]
    val_prior = [w["currentDose"] for w in val_s]
    test_prior = [w["currentDose"] for w in test_s]
    train_esa = torch.tensor([1.0 if w["onESA"] else 0.0 for w in train_s])
    val_esa = torch.tensor([1.0 if w["onESA"] else 0.0 for w in val_s])
    test_esa = torch.tensor([1.0 if w["onESA"] else 0.0 for w in test_s])

    # Per-sample weights: the change bands are the minority but the clinical
    # signal, so they carry more weight than the hold band.
    Wtr = torch.tensor([args.change_weight if (train_y[i] != train_s[i]["currentDose"]) else 1.0 for i in range(len(train_y))], dtype=torch.float32)
    CLASS_WEIGHTS = torch.tensor([2.0, 2.0, 1.0, 2.0])  # suspend, reduce, hold, increase

    model = EsaDoseNet()
    # End-to-end supervised: EN -> 2-D latent z -> the band head picks suspend /
    # reduce / hold / increase, and the PROTOCOL supplies the step. The 2-D latent
    # stays the interpretable manifold the paper's contract asks for, while the
    # reconstruction + contractive terms keep it stable.
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-4)
    best_state = None
    best_val = float("inf")
    best_epoch = 0
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(Xtr.shape[0])
        for b0 in range(0, Xtr.shape[0], args.batch):
            bi = perm[b0:b0 + args.batch]
            xb = Xtr[bi]
            z, recon, band_logits = model(xb)
            jac = jacobian_norm(model, xb)
            w = Wtr[bi]
            ce = nn.functional.cross_entropy(band_logits, Ytr[bi], weight=CLASS_WEIGHTS, reduction="none")
            loss = (ce * w).mean() \
                + 0.05 * nn.functional.mse_loss(recon, xb) \
                + args.contractive_lambda * jac
            opt.zero_grad()
            loss.backward()
            opt.step()
        # Model selection on the VALIDATION split; the test split is never read
        # until the final report.
        if epoch % args.eval_every == 0 or epoch == args.epochs - 1:
            model.eval()
            with torch.no_grad():
                pv = served_dose(model, model.encode(Xval), val_prior, head_features(Xval), val_esa)
                tv = torch.tensor(val_y, dtype=torch.float32)
                v = float((pv - tv).abs().mean())
            if v < best_val:
                best_val = v
                best_epoch = epoch
                best_state = {k: t.detach().clone() for k, t in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        pred_units = served_dose(model, model.encode(Xte), test_prior, head_features(Xte), test_esa)
        target_units = torch.tensor(test_y, dtype=torch.float32)
        test_mae = float((pred_units - target_units).abs().mean())
        pred_tr = served_dose(model, model.encode(Xtr), train_prior, head_features(Xtr), train_esa)
        target_tr = torch.tensor(train_y, dtype=torch.float32)
        train_mae = float((pred_tr - target_tr).abs().mean())
        band_pred = torch.argmax(model.band(model.encode(Xte), head_features(Xte)), dim=1)
        band_accuracy = float((band_pred == Yte).to(torch.float32).mean())
        base_mae = float((torch.tensor(test_prior, dtype=torch.float32) - target_units).abs().mean())
        # A dose advisor is judged on the cases that NEED a change: an overall MAE
        # is dominated by hold cases, where doing nothing already scores well.
        err = (pred_units - target_units).abs()
        label_delta = target_units - torch.tensor(test_prior, dtype=torch.float32)
        pred_delta = pred_units - torch.tensor(test_prior, dtype=torch.float32)
        changed = label_delta.abs() > 0
        unchanged = ~changed
        hold_mae = float(err[unchanged].mean()) if bool(unchanged.any()) else 0.0
        change_mae = float(err[changed].mean()) if bool(changed.any()) else 0.0
        # direction agreement on the change cases (a 0 prediction counts as wrong:
        # it is the one thing the clinician decided NOT to do)
        direction_ok = float(
            ((torch.sign(pred_delta) == torch.sign(label_delta)) & changed).sum()
        ) / max(1, int(changed.sum()))
        # unnecessary movements: the model moved at least half a step where the
        # clinician held — the failure mode that costs a dose change
        false_change_rate = float((pred_delta.abs() >= 250)[unchanged].to(torch.float32).mean()) if bool(unchanged.any()) else 0.0
        change_recall = float((pred_delta.abs() >= 250)[changed].to(torch.float32).mean()) if bool(changed.any()) else 0.0
        num = ((pred_units - pred_units.mean()) * (target_units - target_units.mean())).sum()
        den = torch.sqrt(((pred_units - pred_units.mean()) ** 2).sum() * ((target_units - target_units.mean()) ** 2).sum())
        pearson = float((num / den).clamp(-1, 1)) if den.item() > 0 else 0.0

    # Permutation importances (deterministic per column) aggregated to feature id.
    columns = [f"hgb_w{k}" for k in range(12)] + ["mcv", "ferritin", "transferrinSat", "crp", "calcium", "pth", "priorEpo", "onESA"]
    with torch.no_grad():
        pred = served_dose(model, model.encode(Xte), test_prior, head_features(Xte), test_esa)
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
                pred_p = served_dose(model, model.encode(xp), test_prior, head_features(xp), test_esa)
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
        gpred = float(served_dose(model, model.encode(gvec), [golden_window["currentDose"]], head_features(gvec), torch.tensor([1.0 if golden_window["onESA"] else 0.0]))[0].item())

    os.makedirs(args.out_dir, exist_ok=True)
    artifact_path = os.path.join(args.out_dir, f"{args.model_id}.json")
    artifact = {
        "format": "anant-esa-trained-v1",
        "model": {"id": args.model_id, "version": args.model_version, "kind": "trained"},
        "featureCatalog": CATALOG,
        "vector": {"inputDim": INPUT_DIM, "layout": LAYOUT},
        "architecture": {"encoder": [INPUT_DIM, 48, 24, 2], "decoder": [2, 24, 48, INPUT_DIM], "regressor": [5, 32, 16, 4], "activation": "leaky_relu_0.3", "contractive": True, "head": "band-classifier", "bands": BANDS, "bandFactors": BAND_FACTORS, "regressorInput": "latent2+priorHgb+priorEpo+onESA"},
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
        "metrics": {"trainMae": round(train_mae, 2), "testMae": round(test_mae, 2), "baselineMae": round(base_mae, 2), "maeGainVsBaseline": round(base_mae - test_mae, 2), "valMae": round(best_val, 2), "bestEpoch": best_epoch, "pearson": round(pearson, 4), "holdMae": round(hold_mae, 2), "changeMae": round(change_mae, 2), "directionAccuracy": round(direction_ok, 4), "changeRecall": round(change_recall, 4), "falseChangeRate": round(false_change_rate, 4), "bandAccuracy": round(band_accuracy, 4), "nTrain": len(train_s), "nVal": len(val_s), "nTest": len(test_s), "patients": len(cohort), "seed": args.seed},
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
                return self.model.band(self.model.encode(x), head_features(x))

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
        "maeGainVsBaseline": round(base_mae - test_mae, 2),
        "valMae": round(best_val, 2),
        "bestEpoch": best_epoch,
        "pearson": round(pearson, 4),
        "nTrain": len(train_s),
        "nVal": len(val_s),
        "nTest": len(test_s),
        "patients": len(cohort),
        "holdMae": round(hold_mae, 2),
        "changeMae": round(change_mae, 2),
        "directionAccuracy": round(direction_ok, 4),
        "changeRecall": round(change_recall, 4),
        "falseChangeRate": round(false_change_rate, 4),
        "bandAccuracy": round(band_accuracy, 4),
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
    p.add_argument("--patients", type=int, default=600)
    p.add_argument("--epochs", type=int, default=1000)
    p.add_argument("--batch", type=int, default=128)
    p.add_argument("--lr", type=float, default=4e-4)
    p.add_argument("--contractive-lambda", type=float, default=1e-4)
    p.add_argument("--change-weight", type=float, default=3.0)
    p.add_argument("--eval-every", type=int, default=1)
    p.add_argument("--model-id", default="anemia.esa-dose-v1")
    p.add_argument("--model-version", default="1.0.0")
    args = p.parse_args()
    train(args)


if __name__ == "__main__":
    main()
