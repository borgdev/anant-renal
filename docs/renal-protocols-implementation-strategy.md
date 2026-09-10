# Renal Protocol Implementation Strategy — 6 Remaining Protocols

> Companion to `protocols.md` (the deep-research report). This document turns that report into an
> implementation plan **grounded in what already exists in this repository**, and — per the
> "make sure we are creating the correct models" requirement — pins each protocol to the
> **model that the primary literature actually supports** (verified against the papers, not just
> the summary). Every model claim below is tagged with its source and whether it was
> independently verified from the publication record.

---

## 0. Verified evidence base (correct model per protocol)

Verification method: Europe PMC REST (`resultType=core` abstracts) for each DOI/PMID, plus the
four paper PDFs already in the repo (`anemia.pdf`, `Digital twin.PDF`, `current Opinon Article.pdf`,
`Brier et al. 2018`). PMC/Nature HTML pages are bot-challenged; the REST abstracts carry the
methods + metrics used here.

| # | Protocol | Primary source (verified) | Data scale | Published model | Reported result | **Correct model to build here** |
|---|---|---|---|---|---|---|
| 1 | Fluid / dry weight / IDH | Yun et al., *Sci Rep* 2023 (DOI 10.1038/s41598-023-45282-1) | 302,774 sessions / 11,110 pts | **Temporal Fusion Transformer** + seq-to-seq attention | AUROC **0.953 / 0.892 / 0.889** (IDH-1/IDH-2/IDHTN, 1-hour horizon), AUPRC > RNN/LightGBM/RF/logreg; top features age + previous session (static), SBP + elapsed time (dynamic) | **Stage 1 LightGBM/XGBoost baseline** (interpretable, fast) → **Stage 2 CfC/LTC shared state** for multi-horizon + **counterfactual UF/temperature/duration simulation** (the published papers do *not* do counterfactuals — that is our differentiator). TFT is a benchmark, not a first build. |
| 2 | Anemia / ESA / iron | Yang et al., *Heliyon* 2023 (10.1016/j.heliyon.2022.e12613); Escandell-Montero et al., *Artif Intell Med* 2014 (10.1016/j.artmed.2014.07.004); Brier & Gaweda 2011/2018 (local PDFs) | 36,677 points / 623 pts; RL study on a physiological simulator | **Multi-head self-attention (Informer-style)** for Hb + ESA recommendation; **fitted-Q iteration** RL vs protocol | Hb MAE **0.451 vs 0.593 g/dL** (RNN); simulated in-target **92.7% vs 86.3%**; Hb<10 **7.3% vs 13.7%**; FQI RL: **+27.6% in-target, −5.13% drug** | **Already built** (reference surrogate → PK exposure → MPC what-if → twin + offline drift). Optional next: attention prediction head as the P2 trained artifact. RL stays **offline/sequence**: supervised → treatment-response → counterfactual → constrained optimisation → offline RL (never online). |
| 3 | Dialysis adequacy | Kim et al., *Sci Rep* 2021 (10.1038/s41598-021-94964-1); Liu et al., *Ren Fail* 2024 (10.1080/0886022X.2024.2420826) | 1,333 sessions / 61 pts (240 machine measurements/session); 1,869 sessions / 373 pts (87 vars) | **XGBoost** vs RF/CNN/GRU/linear; **Random Forest** for spKt/V>1.4 | XGBoost MAPE **2.500**, RMSE 2.906, Corr **0.873** (best of all, beats CNN/GRU/linear); RF AUROC **0.873** test, **0.868** non-invasive-only; top vars: access type, gender, BMI, UF volume, duration | **Gradient boosting (XGBoost/RF) + mechanistic Daugirdas/urea-kinetic prior** (physics baseline + ML residual). **Do NOT** lead with a transformer — the evidence says trees win. Continuous spKt/V + uncertainty, then **prescription simulator** (+25 min, +50 mL/min Qb) coupled to the fluid risk. |
| 4 | Vascular access | Park et al., *Korean J Radiol* 2022 (10.3348/kjr.2022.0364); Ota et al., *Sensors* 2020 (10.3390/s20174852) | 40 pts prospective (80 recordings); 20 pts, 192 kHz | **Mel-spectrogram DCNN** (ResNet50 / EfficientNetB5) vs DSA ground truth; CNN + BiLSTM over heartbeat-segmented bruit | ResNet50 AUROC **0.99**, EfficientNetB5 **0.98** for ≥50% stenosis; Ota: accuracy 70–93%, AUC 0.75–0.92 (5 sound classes) | **CNN on mel spectrograms + patient-specific Δ-from-baseline detector** (the key is longitudinal change, not absolute classification) → then **multimodal fusion** (bruit + venous/arterial pressure trend + delivered clearance + access history). New sensing modality = highest differentiation, but needs a data-collection story. |
| 5 | CKD-MBD | Chen et al., *BMC Med Inform Decis Mak* 2026 (10.1186/s12911-026-03678-9); KDIGO CKD-MBD guideline | 718 pts / 5 centres | **SVM + SHAP** (cross-sectional risk) | AUC **0.840**; top predictors PreCr, PreUrea, PreK, PreCO₂CP, PTH | **Coupled multi-output temporal model** for [P, Ca, PTH] — the published work is only next-month risk, so our target is *trajectory + treatment response* (binder/calcimimetic/vitamin D/dialysis dose/diet). Tree/SVM baselines for the risk head; DST fusion + KDIGO coupling rules as the safety contract. |
| 6 | Nutrition / electrolytes | Cai et al., *BMC Nephrol* 2025 (10.1186/s12882-025-04476-7); Li et al. deep-learning albumin (PMC10127046) | 908 pts; incident HD cohort | **XGBoost + SHAP** (PEW); deep learning (albumin) | PEW AUC **0.827** (95% CI 0.772–0.883), sens 0.727 / spec 0.762 / F1 0.544 / Brier 0.125; SHAP top: predialysis creatinine, handgrip, non-HDL-C, Kt/V, hs-CRP | **XGBoost risk head + latent "nutrition/inflammation" state** that separates poor intake vs inflammation vs dilution vs catabolism vs inadequate dialysis (each needs a different action). Hyperkalaemia: **longitudinal K forecast** (tree/state model) + **ECG model as adjunct only** — lab confirmation gates every high-risk action. |
| 7 | Infection / vaccination | Zhou et al., *Heliyon* 2023 (10.1016/j.heliyon.2023.e18263); CDC dialysis BSI framework | 391 pts (18.9% BSI) | **XGBoost + SHAP + nomogram** | AUC **0.914** (95% CI 0.861–0.964), ACC 86.3%; top: temperature, non-AVF access, procalcitonin, NLR | **Split by design**: ML for **early BSI triage** (tree model), and **rules/workflow state machines** for prevention (vaccination due, serology follow-up, hand-hygiene/access-care audits, catheter >90 d with mature AVF escalation). Never ML for infection-prevention compliance. |

**Unverified-from-source (cited in `protocols.md`, treated as secondary):** Liu et al., *JMIR* 2021
(10.2196/27098) time-dependent-feature adverse-event prediction. The direction (slopes/derivatives
of machine telemetry precede events) is consistent with the fluid protocol and does not change any
model choice above.

### Model-choice corrections vs. the report's framing

1. **Adequacy is not a deep-learning problem.** Both adequacy papers put tree ensembles on top
   (XGBoost Corr 0.873; RF AUROC 0.873) and beat CNN/GRU/linear. Our first adequacy model must be
   **XGBoost/RF + mechanistic Kt/V prior**, not the shared temporal encoder.
2. **The flagship fluid model is TFT in the literature, but our build starts with boosting.**
   The published value is *real-time risk*; our added value is *counterfactual intervention
   simulation* (UF rate / duration / temperature / target weight). Ship the interpretable baseline
   first, then the CfC/LTC state + simulator.
3. **Anemia's strongest published predictor is attention (Informer-style), not the manifold model
   we implemented.** Our current stack is clinically coherent (KDIGO band + iron-first vetoes + PK
   exposure + MPC + twin drift); adding the attention head is the optional accuracy step, not a
   correctness fix.
4. **CKD-MBD published models predict *high phosphate*, not the coupled system.** KDIGO requires
   P/Ca/PTH interpreted serially and together — so we must build a **coupled multi-output** model
   even though no paper did.
5. **AVF AI's real signal is change from the patient's own baseline**, not one-shot stenosis
   classification (both AVF papers classify clipped recordings; Ota uses 5 sound classes).

---

## 1. Architecture thesis (already 80% present in this repo)

`protocols.md` argues for one renal state + protocol observers + safety contract, not seven silos.
This codebase already implements that shape — the anemia protocol is the reference implementation:

```
realm events ──► event ledger ──► protocol observers (bounded cells) ──► DST evidence fusion
                                        │                                        │
                                        ▼                                        ▼
                              continuous state (liquid CfC/LTC)        NBA ranker (belief-aware)
                                        │                                        │
                                        ▼                                        ▼
                        counterfactual / what-if simulation         outcome episode → Class-A/B/C/D approval
                                        │                                        │
                                        └──────────► safety contract (guardrails + coverage + red-team) ◄──┘
                                                                                 │
                                                                        clinician acts → observed outcome
                                                                                 │
                                                                        drift / calibration feedback
```

**Existing platform assets to reuse (do not reinvent):**

| Concern | Existing implementation |
|---|---|
| Continuous state / multi-timescale dynamics | `native/domain-dialysis` (5 dims: vitals_instability, deterioration_risk, ktv_adequacy, phosphate, anemia_severity), `src/liquid/trajectory.ts` (`TrajectoryAmbientProcess`), `src/liquid/forecast.ts` (what-if), `src/liquid/regime.ts` (τ / regime change) |
| Observer/agent contract | `src/swarm/cells.ts` (12 renal cells), `src/realm/ambient.ts` (LabMaturation, PatientTrajectory, InsuranceClock), `src/realm/rules.ts` → Experiences |
| Evidence fusion + honesty | `src/evidence/dempster.ts`, `src/evidence/reliability.ts`, DST readouts in `src/swarm/work-dst.ts`, `early-warning.ts`, `anemia-dst.ts` |
| Decision + governance | `src/swarm/nba.ts`, `outcome-episode.ts`, `durable-coordinator.ts`, approvals (`ApprovalClass A–D`), `release.ts`, `platform-routes.ts` (My Work, `/api/work`), `assurance-finding` lifecycle |
| Durable state | `swarm_workspace` kinds (`src/swarm/workspace.ts`), SQL store, Postgres mode |
| Protocol template | **anemia**: `anemia.ts` (cells+features+guardrails+surrogate) → `anemia-governance.ts` (coverage/red-team/drift/gate) → `anemia-model.ts` (trained artifact) → `anemia-forecast.ts` (what-if + MPC) → `anemia-exposure.ts` (PK) → `anemia-twin.ts` (real ledger + drift) → `anemia-phenotype.ts` → `anemia-validation.ts` (P3/MDR) → `anemia-routes.ts` → exec `Anemia & ESA` panel |
| Real-world reference data | CMS QIP CSVs (`cms-data/*.csv` → `src/cms/qip.ts`): Kt/V, NHSN BSI, hypercalcaemia, depression, CAHPS, DFC |
| Simulation | `src/simulator/` (scenarios, scripted events, longitudinal history, fleet persistence, step) + realm graph |
| UI pattern | exec protocol page: Eyebrow + KPI metrics + governed panels + paged lists + what-if chart + DST readout + provenance |

### The "protocol pack" — the 8 artifacts every remaining protocol needs

Repeat exactly the anemia template so governance, evidence and UI stay uniform:

1. **Domain engine** (`src/swarm/<protocol>.ts`): feature catalog + bounds, guardrails/vetoes, reference surrogate, safety class, cells, demo boundary, episode kinds.
2. **Governance** (`<protocol>-governance.ts`): coverage gate, red-team probes (seeded into the shared suite), advisor activation gate, KS drift.
3. **Trained model** (`<protocol>-model.ts` + trainer artifact): self-describing model + golden parity, served under the same contract (or documented "baseline first" per §0).
4. **What-if / counterfactual** (`<protocol>-forecast.ts`): candidate actions → projected trajectory + objective (MPC-style) → chosen action.
5. **Exposure / state inputs** (`<protocol>-exposure.ts` or equivalent): cumulative/time-weighted exposures (dose, iron, UF, binder, catheter-days).
6. **Twin + online drift** (`<protocol>-twin.ts`): real ledger/state → governed window; forecast-vs-observed calibration.
7. **Validation & regulatory** (`<protocol>-validation.ts`): external cohort metrics, study-mode acceptance, MDR file.
8. **Routes + exec panel** (`<protocol>-routes.ts`, exec component + CSS), registered in `app.ts`, guarded by `/admin/swarm/*` (exec roles).

---

## 2. Protocol specs (remaining 6)

Legend for effort: **S** ≈ 1–2 commits, **M** ≈ 3–5, **L** ≈ 6–10. Every protocol starts synthetic
(labelled) and moves to P3 real-data validation; safety class defaults to **B** (operator) or **C**
(clinician) — never autonomous.

### 2.1 Fluid / dry weight / intradialytic hypotension — *P0, flagship*

- **State**: interdialytic weight gain, pre/intra/post BP+HR, UF rate & volume, target weight, blood/dialysate flow, temperature, session duration, symptoms, missed treatments, access type, cardiac history.
- **Targets**: P(IDH-1 nadir SBP<90), P(IDH-2 SBP↓≥20 or MAP↓≥10), P(IDHTN SBP↑≥10) within **15/30/60 min**; severity; plus **projected session fluid removal**.
- **Actions (advisory)**: UF rate steps (−25/50%), sodium/temperature profile, session extension, target-weight reassessment, midodrine/positioning prompts.
- **Correct model**: LightGBM/XGBoost baseline → CfC/LTC shared state for multi-horizon → constrained action simulator; TFT as benchmark.
- **Sim data to add**: intra-session ticks (BP/UF/venous pressure/flow every 5–15 min), IDH/IDHTN events with timestamps, symptoms, intervention records.
- **Slices**: (a) engine + observer + guardrails; (b) what-if UF simulator + exec live panel; (c) governance (red-team: unsafe UF escalation, hypotension-blind recommendation); (d) twin + drift; (e) adequacy-coupled joint decision.
- **Acceptance**: calibrated AUROC ≥0.85 on synthetic held-out *sessions* (patient-level split), Brier ≤0.15, zero autonomous UF actions, red-team probes contained. **Effort L.**

### 2.2 Anemia — *P0, DONE (finish gaps)*

Shipped: reference surrogate + governance + trained CAE artifact + MPC what-if + PK exposure +
patient twin + online drift (MAPE 2.61% live) + phenotype + P3 validation/MDR, ledger-sourced ESA
orders. **Remaining (optional)**: attention prediction head (Informer-style) as an alternate trained
artifact; confirm/encode the **KDIGO 2026** target band and lab intervals in the guardrails;
retinol/reticulocyte inputs when real data arrives. **Effort S.**

### 2.3 Dialysis adequacy — *P0, cheapest strong win*

- **State**: session duration, Qb/Qd, dialyser, UF volume, pre/post weight, access type, recirculation, missed/shortened sessions, machine telemetry.
- **Targets**: **continuous spKt/V/URR + uncertainty** (not just a classifier); probability spKt/V < 1.2 / > 1.4; decomposed causes.
- **Actions**: extend duration, raise Qb, review access, dialyser change, adherence task — each with predicted adequacy **and** predicted IDH risk (coupling).
- **Correct model**: **XGBoost/RF + Daugirdas/urea-kinetic prior** (evidence-backed); then CfC/LTC only if it beats trees on multi-horizon.
- **Sim data to add**: per-session machine parameters (Qb, Qd, duration, UF, dialyser), URR/spKt/V labs, shortened-session events.
- **Slices**: (a) mechanistic prior + XGBoost residual model + observer cell; (b) prescription simulator (+25 min / +50 mL/min) with fluid trade-off; (c) governance (red-team: unsafe Qb escalation disregarding cardiac risk); (d) CMS QIP Kt/V tie-in (real CSV already parsed in `src/cms/qip.ts`).
- **Acceptance**: MAPE ≤5%, Corr ≥0.85 (patient-level split), non-invasive-only variant reported, simulator monotone in duration/Qb. **Effort M.**

### 2.4 Vascular access — *P1, differentiating sensor*

- **State**: access type/age, site, venous/arterial pressures, blood flow, recirculation, delivered clearance, cannulation difficulty, interventions, complications, **audio baseline**.
- **Targets**: P(≥50% stenosis), P(thrombosis within 30/90 d), **Δ acoustic signature from patient baseline**, Δ clearance.
- **Actions**: duplex ultrasound referral, access-team review, cannulation technique change, catheter-removal escalation (rules).
- **Correct model**: mel-spectrogram **CNN (ResNet50/EfficientNetB5)** + patient-relative change detector; longitudinal survival model on pressures/flow/clearance; multimodal fusion.
- **Sim data to add**: pressure trends (rising venous pressure), recirculation, access interventions; synthetic acoustic feature vectors (never fake audio as "real" — label clearly).
- **Slices**: (a) longitudinal pressure/flow observer + stenosis risk (no audio); (b) audio ingestion contract + baseline-change detector behind a feature flag; (c) fusion + referral workflow + governance.
- **Acceptance**: AUROC ≥0.80 longitudinal-only on synthetic; audio path gated and clearly labelled synthetic; referral always human-approved. **Effort M–L.**

### 2.5 CKD-MBD — *P2, strongest science*

- **State**: P, corrected Ca, PTH, vitamin D, albumin, binders (class/dose/adherence), calcimimetic, dialysis dose, diet, phosphate–protein intake proxy.
- **Targets**: coupled **[P, Ca, PTH] at +30/+60/+90 d**; P(>6.0 mg/dL); P(PTH out of range); safety-boundary probabilities (hypocalcaemia).
- **Actions**: binder titration/switch, calcimimetic change, vitamin D, adherence coaching, dialysis-dose change.
- **Correct model**: **coupled multi-output temporal model** (the published SVM is cross-sectional) + SHAP-style drivers; SVM/tree risk head as baseline; KDIGO coupling rules as hard contract.
- **Sim data to add**: serial P/Ca/PTH with delayed response, binder/calcimimetic exposures, adherence misses.
- **Slices**: (a) coupled set-point/response engine (like the anemia PK responder, but 3 outputs) + guardrails (never raise Ca above safety bound); (b) what-if therapy simulator; (c) governance red-team (unsafe Ca-raising combination); (d) twin + drift; (e) CMS hypercalcaemia tie-in.
- **Acceptance**: multi-output MAE reported per analyte, KDIGO rules block unsafe combinations, no autonomous therapy. **Effort L.**

### 2.6 Nutrition / electrolytes (PEW + hyperkalaemia + acidosis) — *P3*

- **State**: albumin, predialysis creatinine, weight/lean-mass trajectory, handgrip, non-HDL-C, hs-CRP, appetite/intake, GI symptoms, hospitalisation, Kt/V; K, bicarbonate/CO₂, interdialytic interval, diet, RAASi/other meds, residual function.
- **Targets**: P(PEW) with drivers (poor intake vs inflammation vs dilution vs catabolism vs inadequate dialysis); P(next pre-dialysis K > 6.0); bicarbonate trajectory; acute ECG signature (adjunct).
- **Actions**: dietitian referral, oral nutrition supplement, dialysis-dose/appetite review, binder/K-binder/diet plan, ECG + **urgent lab confirmation**, ED triage.
- **Correct model**: **XGBoost + SHAP** (PEW, evidence-backed), longitudinal K forecast (tree/state), ECG model as adjunct only.
- **Sim data to add**: albumin, creatinine, handgrip, non-HDL-C, CRP, K series, bicarbonate, ECG flags.
- **Acceptance**: AUC ≥0.80 synthetic held-out; every hyperkalaemia action requires lab confirmation; nutrition state disentangled into the five pathways. **Effort M–L.**

### 2.7 Infection / vaccination — *P4, split ML vs rules*

- **State**: temperature, access type/catheter-days, procalcitonin, NLR, WBC, cultures, symptoms, vaccination/serology status, hand-hygiene & access-care audit state.
- **Targets**: P(BSI) triage score with drivers; vaccination-due and audit-due task generation; catheter-day escalation.
- **Actions**: blood-culture order (Class C), empiric-antibiotic *discussion* (never autonomous), isolation logic, vaccination outreach, audit tasks, catheter-removal escalation.
- **Correct model**: **XGBoost + SHAP** for BSI triage; **rules/workflow state machines** (CDC core interventions) for prevention — explicitly *not* ML.
- **Sim data to add**: vitals with fever spikes, PCT/NLR, access type, catheter days, vaccine due dates, audit counters.
- **Acceptance**: BSI triage AUC ≥0.85 synthetic; prevention tasks are deterministic + auditable; no autonomous antimicrobial action. **Effort M.**

---

## 3. Cross-cutting engineering plan

### 3.1 Data model extensions (all additive, synthetic-labelled)

| Addition | Where | Used by |
|---|---|---|
| Session records (start/end, prescription, UF goal/actual, Qb/Qd, dialyser, temperature) | new `SessionRecord` entity kind + sim script + FHIR `Procedure`/`Encounter` projection | fluid, adequacy |
| Intra-session vitals + machine telemetry (5–15 min) | realm entity state (`lastVitals` series) + script entries; FHIR `Observation` | fluid, adequacy |
| Access observations (pressures, recirculation, cannulation difficulty, access age) | realm entity `access` + script | access, adequacy |
| Acoustic feature vectors (never fake raw audio as real) | `access-acoustic` entity behind a flag | access |
| MBD exposures (binder/calcimimetic/vitamin D + adherence) | med orders via extended `order-med` codes | MBD |
| Nutrition/electrolyte labs (albumin, creatinine, K, CO₂, hs-CRP, non-HDL-C, handgrip) | `ambient.draw` + `LAB_CODES` extension | nutrition, electrolytes |
| Infection signals (temperature, PCT, NLR, catheter days, vaccine due) | labs + realm state | infection |

### 3.2 Model training strategy (matches §0 correctness)

1. **Baselines first**: logistic/linear + LightGBM/XGBoost per protocol — validate the data pipeline before any deep model.
2. **Shared state second**: one CfC/LTC encoder (`native/`) with protocol heads, trained by `liquid-train`-style CLI, benchmarked against the tabular baselines with **patient-level** splits.
3. **Artifacts are self-describing** with golden parity tests (as `anemia-train/` does) so train/serve cannot drift.
4. **Mechanistic priors** where physics exists (Daugirdas Kt/V, urea kinetics, ESA PK half-life, buffer/acid-base) — ML models the residual, not the physics.
5. **No random row splits.** Patient-level (and clinic-level for external validation) only.
6. **Calibration/metrics**: AUROC *and* AUPRC/Brier/calibration slope; MAE/MAPE for continuous; lead time and false-alert rate reported for real-time protocols.

### 3.3 Governance reuse (non-negotiable per protocol)

- Guardrail vetoes in the domain engine (analogous to iron-first).
- Coverage gate (out-of-domain / lab-density / manifold distance) before any recommendation.
- Red-team probes seeded into the shared suite, replayable against live admin policy.
- Activation gate + drift snapshots + findings lifecycle (already built).
- DST belief/plausibility/conflict readout on every recommendation (already built).
- Approval class per action; Class D (dual) for CMS submissions; break-glass audited.
- Synthetic labelling everywhere until real cohorts arrive.

### 3.4 exec UI pattern

One page per protocol: KPI strip → **Protocol cockpit** (green/amber/red for all seven) → trajectory
panel with confidence bands → live intra-session panel (fluid) → what-if simulator → DST readout →
durable episodes → governance (P1) → validation/MDR (P3). Reuse `usePaged`/`LoadMore`/`PanelExpand`,
`EvidenceTag`, `.list-scroll`, the what-if chart CSS, and the twin/drift panels.

---

## 4. Roadmap

```mermaid
graph LR
  A[Anemia ✅ done] --> B[Adequacy P0]
  B --> C[Fluid/IDH P0 flagship]
  C --> D[Access P1 sensor]
  D --> E[CKD-MBD P2 coupled control]
  E --> F[Nutrition/Electrolytes P3]
  F --> G[Infection P4 ML+rules]
  B -.shares session data.- C
  C -.trade-off.- B
  E -.uses-. B
```

| Phase | Protocols | Why now | Exit criteria |
|---|---|---|---|
| **Now** | Adequacy | Cheapest strong win; mechanistic prior + tree model; CMS Kt/V data already parsed; couples to fluid | Engine + observer + what-if + governance + exec page; MAPE ≤5% synthetic; red-team contained |
| **Next** | Fluid/IDH | #1 evidence + best showcase; couples with adequacy | Session-level AUROC ≥0.85; UF counterfactual simulator; no autonomous UF |
| **Then** | Access | New modality, commercial differentiation | Longitudinal observer live; audio path flagged/labelled; referral workflow |
| **Then** | CKD-MBD | Strongest science (coupled delayed control) | Coupled multi-output model + safety-bounded therapy what-if |
| **Then** | Nutrition/electrolytes | PEW + K; multimodal | Nutrition-state decomposition; K action gated by lab confirmation |
| **Last** | Infection | Split ML/rules; compliance-heavy | BSI triage AUC ≥0.85; deterministic prevention tasks auditable |

---

## 5. Risks and how this plan addresses them

| Risk | Mitigation baked into the plan |
|---|---|
| **Confounding by indication** (clinician actions are not ground truth) | Never treat logged actions as labels for recommendations; TreatmentResponse estimated with target-trial-style framing; counterfactuals validated against naturally occurring changes before clinical use; RL only offline and last |
| **Seven silos duplicating work** | One protocol pack template + shared state/observer/NBA/governance; each protocol adds modules, not a fork |
| **Deep learning where trees win** (adequacy) | §0 model-choice table forces the evidence-backed family first; DL must beat baselines to ship |
| **AUC-only optimisation** | Calibration (Brier, reliability), lead time, false-alert rate, actionability required in acceptance criteria |
| **Leakage from random row splits** | Patient-level (and clinic-level) splits mandated for every model + test |
| **Over-trust in synthetic results** | All data labelled synthetic; P3 real-cohort validation + drift monitoring gate any "validated" claim |
| **Unsafe automation** | Guardrails + coverage gate + red-team + approval classes; autonomous action prohibited for UF, antimicrobials, emergency K, and infection prevention |
| **Sensor governance (audio/ECG)** | Feature-flag the audio path, keep provenance/content hashes, no raw patient audio committed, explicit synthetic labels |

---

## 6. Immediate next slice (recommendation)

**Slice 6 — Dialysis adequacy observer + prescription simulator.** Rationale: highest
evidence-to-effort ratio (XGBoost/RF + Daugoudas prior), reuses the existing `ktv_adequacy` liquid
dimension and the real CMS Kt/V QIP data, produces a visible coupled decision
(+25 min duration vs IDH risk) that demonstrates the platform's differentiator, and it exercises
every part of the protocol-pack template cheaply before the larger fluid/protocol work.

**Deliverables**: `src/swarm/adequacy.ts` (+ types/guardrails/cells), `adequacy-forecast.ts`
(mechanistic prior + candidate prescription simulation), `adequacy-routes.ts`
(`/admin/swarm/adequacy/{state,advise,what-if}`), exec **Adequacy** page, simulator session data
(Qb/Qd/duration/UF + spKt/V labs), tests (unit + route + governance red-team), all synthetic-labelled.
