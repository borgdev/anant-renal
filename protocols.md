


AI/ML for Renal Care Protocols
Deep research: scientific evidence, model strategy, and an integrated decision system for advanced CKD and dialysis

I would **not** build seven independent renal AI models. The science points toward a more valuable architecture: a **continuous renal patient-state model** with protocol-specific observers, treatment-response models, and hard clinical safety contracts. Dialysis is almost an ideal domain for this because the same patient generates repeated interventions and measurements over multiple timescales—from second/minute-level machine telemetry to multi-week ESA response and multi-month mineral-bone trajectories.

I completed a deeper literature review and created the full technical report here:

[Download the renal AI/ML deep-research report](sandbox:/mnt/data/renal_ai_ml_deep_research.docx)

## What the research says

The evidence is surprisingly uneven. I would rank the seven areas this way:

| Priority | Clinical area                                  | AI/ML maturity    | Why                                                                           |
| -------- | ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| **1**    | Fluid / dry weight / intradialytic hypotension | **Very high**     | Large longitudinal datasets; real-time prediction demonstrated                |
| **2**    | Anemia / ESA / iron                            | **Very high**     | Personalized treatment-response and dosing already demonstrated               |
| **3**    | Dialysis adequacy                              | **High**          | Machine data can estimate Kt/V/URR continuously                               |
| **4**    | Vascular access                                | **High emerging** | Audio/deep learning can detect AVF stenosis; excellent multimodal opportunity |
| **5**    | CKD-MBD                                        | **Moderate**      | Strong physiological problem, but ML literature is still relatively immature  |
| **6**    | Nutrition / electrolytes                       | **Moderate**      | Useful PEW and hyperkalemia predictors exist                                  |
| **7**    | Infection / vaccination                        | **Mixed**         | BSI prediction is useful; prevention itself is primarily rules/workflow       |

A major 2026 review of AI in dialysis reaches essentially the same broad conclusion: the leading application areas are intradialytic event prediction, anemia optimization, vascular-access monitoring, prognosis, and treatment personalization, but routine clinical deployment remains much less mature than model-development literature might suggest. ([PubMed][1])

---

# 1. Fluid management may be your strongest showcase

This is the area where I think your dynamic-system approach could make the clearest scientific contribution.

A particularly important paper is:

**Yun et al., “Real-time dual prediction of intradialytic hypotension and hypertension using an explainable deep learning model,” Scientific Reports, 2023.**

They studied **302,774 hemodialysis sessions from 11,110 patients** and used a Temporal Fusion Transformer. Their model predicted severe intradialytic hypotension within the following hour with **AUROC 0.953**. Other hypotension and hypertension definitions achieved AUROCs around 0.89. ([nature.com][2])

That paper is important for more than its accuracy.

It demonstrates that renal care should be modeled as:

$$
State(t)
\rightarrow
Trajectory(t:t+\Delta)
\rightarrow
Risk
$$

rather than:

$$
Current\ Lab
\rightarrow
Classification
$$

This fits extremely well with continuous-time modeling.

Another multicenter study used **62,227 dialysis sessions** and found LightGBM particularly effective for IDH prediction across several definitions. ([ScienceDirect][3])

Earlier work using machine-generated time-series data showed that trends and derivatives in BP, venous pressure, transmembrane pressure, pulse pressure and blood-flow data could predict intradialytic adverse events before they happened. ([PubMed][4])

### The opportunity goes beyond IDH prediction

Most papers stop at:

> “Patient has 82% probability of hypotension.”

Your system should continue:

> “Patient has 82% probability of hypotension in the next 35 minutes.”

Then:

> “If UF remains at 850 mL/h → risk 82%.”

> “If UF falls to 650 mL/h → estimated risk 41%, projected session fluid removal −0.45 L.”

> “If treatment extends 30 minutes → projected risk 29% while preserving volume goal.”

Now you have transitioned from **risk prediction** to **dynamic decision support**.

That is substantially more differentiated.

---

# 2. Anemia is probably the most mature AI treatment-control problem

This is another extremely strong area.

A 2023 study used **36,677 observations from 623 dialysis patients** and developed a multi-head self-attention model for individualized hemoglobin prediction and ESA recommendations.

It achieved hemoglobin prediction MAE of:

**0.451 g/dL**

versus:

**0.593 g/dL for the comparison RNN.**

Their simulation suggested target hemoglobin achievement could increase from **86.3% under clinician prescriptions to 92.7% using model recommendations**. The authors appropriately noted that prospective validation was still required. ([PubMed Central (PMC)][5])

And this isn't an isolated idea. Renal anemia has been studied using reinforcement learning for more than a decade because it is almost a textbook delayed-control problem. ([PubMed][6])

There is also the Anemia Control Model, a commercially deployed AI-based decision-support approach in dialysis; recent reviews describe it as one of the more mature examples of AI reaching actual renal practice. ([PubMed][7])

KDIGO published an updated **2026 Anemia in CKD guideline**, so the clinical-rule component can also be grounded in a current authoritative standard. ([KDIGO][8])

### Your anemia state could look like

$$
S_{anemia}(t)=
[
Hb,\dot{Hb},
Ferritin,
TSAT,
ESA,
Iron,
CRP,
Kt/V,
Bleeding,
Transfusion,
Inflammation
]
$$

The important element is \(\dot{Hb}\)—the **trajectory**, not simply Hb.

The decision system should predict:

$$
P(Hb_{t+1w}),\;
P(Hb_{t+2w}),\;
P(Hb_{t+4w})
$$

conditional on different actions:

$$
do(ESA=+10\%)
$$

$$
do(ESA=-10\%)
$$

$$
do(Iron=100mg)
$$

$$
do(Hold\ ESA)
$$

That is far more powerful than an ESA recommendation based solely on today's hemoglobin.

---

# 3. Dialysis adequacy is almost ready-made for AI

This area has good evidence and relatively clean targets.

The standard clinical metric is generally spKt/V or URR, but conventional measurement depends on blood sampling. Meanwhile, dialysis machines are already generating large quantities of information about blood flow, dialysate flow, UF, pressures, duration and treatment parameters.

A Scientific Reports study showed machine learning could infer dialysis adequacy from repeatedly measured dialysis-machine data. XGBoost performed best, with a reported correlation of approximately **0.873** between predicted and observed adequacy. ([PubMed Central (PMC)][9])

A 2024 study involving **1,869 sessions from 373 patients** predicted whether spKt/V exceeded 1.4 with a test AUROC of **0.873**. Importantly, even a model relying only on relatively easy-to-obtain non-invasive variables retained AUROC around **0.868**. ([PubMed][10])

There is even newer 2026 evidence supporting similar non-invasive/machine-learning estimation approaches. ([PubMed][11])

But again, don't stop at:

> Predicted Kt/V = 1.17.

The system should say:

> Predicted Kt/V = 1.17 ± 0.08.

> Primary drivers: shortened session, effective blood flow, access performance.

> Extend session 25 minutes → predicted Kt/V 1.31.

> Increase Qb 50 mL/min → predicted Kt/V 1.29 but estimated IDH risk increases from 14% to 21%.

Now **adequacy and fluid safety become one coupled decision problem**.

That coupling is where the real product emerges.

---

# 4. Vascular access is potentially a killer feature

I would invest seriously here.

AI research has shown that AV fistula sounds can be converted into spectrograms and classified with CNN/deep-learning models to identify stenosis.

One study prospectively recorded AVF sounds using an electronic stethoscope and compared deep-learning predictions with angiographic evidence of ≥50% stenosis. ([PubMed][12])

Other work has developed deep-learning systems specifically for AVF bruit analysis and automated stenosis screening. ([PubMed Central (PMC)][13])

Imagine putting a low-cost digital stethoscope at every dialysis chair.

Instead of relying solely on:

> “Does this bruit sound abnormal?”

you maintain:

$$
AVF_{baseline}
$$

and then measure:

$$
\Delta AcousticSignature_t
$$

for each patient.

Combine that with:

$$
VenousPressure
+
ArterialPressure
+
BloodFlow
+
Kt/V
+
Recirculation
+
CannulationDifficulty
+
AccessHistory
$$

You now have a **vascular-access digital twin**.

The system could say:

> AV fistula acoustic signature changed 18% from patient baseline over 21 days.

> Venous pressure trend +12%.

> Delivered clearance −7%.

> Estimated clinically significant stenosis risk: 74%.

> Recommend duplex ultrasound/access evaluation.

That is both clinically understandable and commercially impressive.

KDOQI's current vascular-access guideline framework already provides the clinical decision context for monitoring lesions, dysfunction, cannulation and access complications. ([Kidney Foundation][14])

---

# 5. CKD-MBD may actually be the most interesting scientific problem

The ML literature here is weaker—but the **problem itself is beautiful for dynamic modeling**.

KDIGO emphasizes that phosphate, calcium and PTH should be interpreted serially and together rather than as isolated biochemical abnormalities. ([KDIGO][15])

The underlying system is coupled:

$$
Phosphate
\leftrightarrow
Calcium
\leftrightarrow
PTH
\leftrightarrow
Vitamin\ D
$$

with treatment interventions:

$$
Binder
$$

$$
Calcimimetic
$$

$$
VitaminD
$$

$$
DialysisDose
$$

$$
Diet
$$

and substantial delay between action and measured response.

A very recent **2026 multicenter study involving 718 hemodialysis patients across five centers** developed an explainable ML model for hyperphosphatemia. The best SVM reached **AUROC 0.840**; influential predictors included predialysis creatinine, urea, potassium, CO₂ combining power and PTH. ([PubMed][16])

But the published framing is still:

$$
Patient \rightarrow High\ phosphorus?
$$

I would instead build:

$$
[Ca,P,PTH]_{t}
\rightarrow
[Ca,P,PTH]_{t+30d}
$$

conditioned upon treatment.

For example:

> Current state:
> P 6.5, corrected Ca 8.7, PTH 720.

> No intervention:
> P(Phosphate > 6.0 in 30d) = 79%.

> Binder adherence intervention:
> predicted P = 5.6.

> Calcimimetic increase:
> predicted PTH = 590 but calcium trajectory approaches lower safety boundary.

That becomes a **multivariable control system**, not a protocol reminder.

I think this could become one of the most novel components of your renal platform.

---

# 6. Nutrition should be modeled as metabolic state, not albumin alone

A 2025 study examined **908 maintenance-hemodialysis patients** and built explainable models for protein-energy wasting.

XGBoost achieved **AUROC 0.827**, with important features including predialysis creatinine, hand-grip strength, Kt/V, hs-CRP and lipid measurements. ([PubMed Central (PMC)][17])

Separate deep-learning research has also predicted low serum albumin among new dialysis patients using longitudinal EHR data. ([PubMed Central (PMC)][18])

A more useful latent nutritional state would combine:

$$
NutritionState=
f(
Albumin,
WeightTrajectory,
LeanMass,
Creatinine,
CRP,
Intake,
Appetite,
Kt/V,
Hospitalization,
Activity
)
$$

That helps distinguish:

**poor intake**

from

**inflammation**

from

**fluid dilution**

from

**catabolic illness**

from

**inadequate dialysis**.

Those conditions might all produce a falling albumin, but they demand very different interventions.

---

# 7. Hyperkalemia is a compelling multimodal AI problem

There is published work using ML analysis of ECGs to identify different degrees of hyperkalemia in ESRD patients. ([PubMed][19])

I would implement two different systems.

The first is a **longitudinal potassium forecast**:

$$
P(K_{next}>6.0)
$$

using:

diet + previous K + interdialytic interval + medications + residual renal function + dialysis prescription + missed treatment + bicarbonate + glucose.

The second is **acute ECG surveillance**.

Then combine them:

$$
Risk_{K}
=
f(
TrajectoryRisk,
ECGSignal,
Symptoms,
CurrentState
)
$$

But because hyperkalemia can be immediately life-threatening, the AI should trigger laboratory confirmation/emergency workflows rather than autonomously direct therapy.

---

# 8. Infection requires a different AI strategy

There is genuine ML value for **early infection detection**.

A 2023 study involving 391 hemodialysis patients who underwent blood cultures found XGBoost achieved **AUC 0.914** for bloodstream infection. Important predictors included temperature, non-AVF access, procalcitonin and neutrophil-to-lymphocyte ratio. ([PubMed Central (PMC)][20])

But I would not build “AI infection-prevention recommendations.”

CDC's dialysis infection-prevention framework is largely explicit and auditable: BSI surveillance, hand-hygiene observation, access-care observation, competency assessment, patient education, catheter reduction, chlorhexidine skin antisepsis, hub disinfection and catheter-site management. ([CDC][21])

Those are ideal for:

**Observer → Guard → Task/Action**

rather than ML.

So:

> Catheter + fever + rising NLR/PCT → learned BSI risk.

while:

> HBV vaccination due → deterministic protocol.

> Hand hygiene audit overdue → deterministic workflow.

> Catheter >90 days with mature AVF → workflow escalation.

The distinction is important.

---

# The architecture I would build

This is where I think your existing approach has a substantial advantage.

Instead of:

$$
Model_{Anemia}
$$

$$
Model_{Fluid}
$$

$$
Model_{MBD}
$$

$$
Model_{Adequacy}
$$

I would create:

$$
\boxed{RenalPatientState(t)}
$$

feeding multiple physiological substates:

$$
\begin{aligned}
S_F &= Fluid/Hemodynamic \\
S_A &= Anemia/Iron \\
S_M &= Mineral/Bone \\
S_E &= Electrolyte/AcidBase \\
S_N &= Nutrition/Inflammation \\
S_V &= VascularAccess \\
S_I &= Infection
\end{aligned}
$$

and use a shared continuous-time encoder.

Conceptually:

$$
Events
\rightarrow
CfC/LTC
\rightarrow
Latent\ Renal\ State
$$

then:

$$
LatentState
\rightarrow
ProtocolObservers
$$

then:

$$
Observers
\rightarrow
CandidateActions
$$

then:

$$
CandidateActions
\rightarrow
StateSimulation
$$

then:

$$
SafetyContract
\rightarrow
NBA
$$

then:

$$
Clinician
\rightarrow
Action
$$

then observed response comes back into the state.

This becomes a real **closed-loop renal intelligence system**.

---

# Where CfC/LTC could be genuinely differentiated

Dialysis contains several simultaneous clocks.

**Minutes:** BP, UF, venous pressure, blood flow.

**Days:** fluid accumulation, potassium, interdialytic weight gain.

**Weeks:** ESA/iron → Hb.

**Months:** phosphate/PTH/mineral bone disease and nutritional decline.

A continuous-time model has a strong conceptual advantage because the input isn't naturally sampled at a single uniform frequency.

The useful scientific experiment isn't simply:

> CfC versus LSTM accuracy.

It should be:

$$
\text{Can one continuous latent state forecast multiple physiological horizons?}
$$

and:

$$
\text{Does patient-specific state adaptation outperform population models?}
$$

and especially:

$$
\text{Can it accurately predict response to interventions?}
$$

That's a much stronger paper.

---

# And I would be cautious about reinforcement learning

RL is intellectually attractive here, and anemia RL work already exists. ([PubMed][6])

But in production I would sequence it:

**Prediction → treatment-response estimation → counterfactual simulation → constrained optimization → offline RL → prospective decision support.**

I would not begin with:

> AI chooses ESA dose.

or:

> AI controls UF.

because observational dialysis data contain severe **confounding by indication**.

The physician chose a treatment precisely because the patient was in a particular clinical state. Naively learning from actions can therefore mistake clinician behavior for causal treatment benefit.

That is probably the single biggest scientific trap in this project.

---

# What I would build first

If the goal is both **scientific credibility and a spectacular demonstration**, I would start with four capabilities:

1. **Live Dialysis Intelligence** — real-time UF/BP/IDH trajectory and intervention simulation.
2. **Anemia Intelligence** — 1/2/4-week Hb trajectory with ESA/iron next-best-action.
3. **Continuous Adequacy** — predicted Kt/V every session plus prescription simulation.
4. **Access Intelligence** — AVF acoustic signature + pressure/flow trajectory + stenosis risk.

Then add CKD-MBD as the first major **multi-month dynamic-control module**.

Once those are integrated, this stops looking like “AI applied to dialysis.” It starts looking like a **renal physiological operating system**: one continuously evolving patient state driving protocol surveillance, prediction, counterfactual reasoning and clinician-controlled action. That is a materially stronger product thesis than any of the individual ML papers I found.

[1]: https://pubmed.ncbi.nlm.nih.gov/41702483/?utm_source=chatgpt.com "Artificial intelligence and machine learning applications in dialysis: Current applications, challenges, and future directions - PubMed"
[2]: https://www.nature.com/articles/s41598-023-45282-1?utm_source=chatgpt.com "Real-time dual prediction of intradialytic hypotension and hypertension using an explainable deep learning model | Scientific Reports"
[3]: https://www.sciencedirect.com/science/article/pii/S0169260723003632?utm_source=chatgpt.com "Machine learning-based intradialytic hypotension prediction of patients undergoing hemodialysis: A multicenter retrospective study - ScienceDirect"
[4]: https://pubmed.ncbi.nlm.nih.gov/34491204/?utm_source=chatgpt.com "Machine Learning Analysis of Time-Dependent Features for Predicting Adverse Events During Hemodialysis Therapy: Model Development and Validation Study - PubMed"
[5]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9898283/?utm_source=chatgpt.com "Multi-head self-attention mechanism enabled individualized hemoglobin prediction and treatment recommendation systems in anemia management for hemodialysis patients - PMC"
[6]: https://pubmed.ncbi.nlm.nih.gov/25091172/?utm_source=chatgpt.com "Optimization of anemia treatment in hemodialysis patients ... - PubMed"
[7]: https://pubmed.ncbi.nlm.nih.gov/41208283/?utm_source=chatgpt.com "Artificial intelligence in kidney disease and dialysis: from data mining to clinical impact - PubMed"
[8]: https://kdigo.org/guidelines/anemia-in-ckd/kdigo-2026-anemia-in-ckd-guideline-2/?utm_source=chatgpt.com "KDIGO-2026-Anemia-in-CKD-Guideline – KDIGO"
[9]: https://pmc.ncbi.nlm.nih.gov/articles/PMC8322325/?utm_source=chatgpt.com "Dialysis adequacy predictions using a machine learning method - PMC"
[10]: https://pubmed.ncbi.nlm.nih.gov/39526333/?utm_source=chatgpt.com "Prediction of dialysis adequacy using data-driven machine learning algorithms - PubMed"
[11]: https://pubmed.ncbi.nlm.nih.gov/42337499/?utm_source=chatgpt.com "Validation of online clearance monitoring and machine learning-based prediction of dialysis adequacy in Vietnamese hemodialysis patients: a cross-sectional study."
[12]: https://pubmed.ncbi.nlm.nih.gov/36174999/?utm_source=chatgpt.com "Feasibility of Deep Learning-Based Analysis of Auscultation for Screening Significant Stenosis of Native Arteriovenous Fistula for Hemodialysis Requiring Angioplasty - PubMed"
[13]: https://pmc.ncbi.nlm.nih.gov/articles/PMC7506665/?utm_source=chatgpt.com "Evaluation of Hemodialysis Arteriovenous Bruit by Deep Learning - PMC"
[14]: https://www.kidney.org/professionals/kdoqi/guidelines-and-commentaries/vascular-access?utm_source=chatgpt.com "KDOQI Vascular Access Guidelines and Clinical Tools | NKF"
[15]: https://kdigo.org/guidelines/ckd-mbd/?utm_source=chatgpt.com "CKD-Mineral and Bone Disorder (CKD-MBD) – KDIGO"
[16]: https://pubmed.ncbi.nlm.nih.gov/42410613/?utm_source=chatgpt.com "An explainable machine learning model for predicting high phosphorus risk in patients on maintenance hemodialysis: a multicenter retrospective study - PubMed"
[17]: https://pmc.ncbi.nlm.nih.gov/articles/PMC12523148/?utm_source=chatgpt.com "Explainable machine learning models for predicting of protein-energy wasting in patients on maintenance haemodialysis - PMC"
[18]: https://pmc.ncbi.nlm.nih.gov/articles/PMC10127046/?utm_source=chatgpt.com "Application of deep learning to predict the low serum albumin in new hemodialysis patients - PMC"
[19]: https://pubmed.ncbi.nlm.nih.gov/37199267/?utm_source=chatgpt.com "Prediction of hyperkalemia in ESRD patients by identification of ..."
[20]: https://pmc.ncbi.nlm.nih.gov/articles/PMC10375788/?utm_source=chatgpt.com "Early identification of bloodstream infection in hemodialysis patients by machine learning - PMC"
[21]: https://www.cdc.gov/dialysis-safety/hcp/clinical-safety/index.html?utm_source=chatgpt.com "Best Practices for Bloodstream Infection Prevention in Dialysis Setting | Dialysis Safety | CDC"

================================

Executive Summary
Renal dialysis is unusually well suited to AI because it produces dense longitudinal data: recurring laboratory panels, medication and ESA/iron dosing histories, weight and ultrafiltration trajectories, blood pressure time series, dialysis-machine telemetry, vascular-access signals, and repeated clinical outcomes. The literature now supports a transition from isolated risk scores toward continuous state estimation and treatment-response prediction.
The evidence is not equally mature across protocols. The strongest AI/ML evidence is in intradialytic hemodynamic prediction, anemia treatment support, dialysis adequacy estimation, and vascular-access surveillance. Mineral-bone disease, nutritional risk, electrolyte prediction, and infection detection have promising models but substantially less evidence for prospective clinical benefit. Infection-prevention and vaccination workflows are primarily protocol-adherence problems and should not be delegated to a learned model.
Priority Ranking
Rank	Protocol	AI maturity	Best ML role	Recommended model family	Product priority
1	Fluid / dry weight / IDH	High	Real-time forecasting + treatment-response	CfC/LTC + TFT/GBM baseline	P0
2	Anemia	High	Hb trajectory + ESA/iron recommendation	CfC/LTC + attention + constrained policy	P0
3	Dialysis adequacy	High	Continuous adequacy prediction + prescription simulation	GBM + temporal model + mechanistic Kt/V	P0
4	Vascular access	Moderate-high	Stenosis/thrombosis screening + failure prediction	Audio/image DL + longitudinal survival model	P0/P1
5	CKD-MBD	Moderate	Phosphate/PTH trajectory + response prediction	Temporal model + causal treatment-response	P1
6	Electrolytes / nutrition	Moderate	Hyperkalemia/PEW early warning	Temporal multimodal + ECG model	P1
7	Infection / vaccination	Moderate for diagnosis; low for autonomous intervention	Early BSI risk + compliance orchestration	GBM for BSI; rules/workflow for prevention	P1
Core recommendation: build one renal state-and-decision engine with protocol-specific observers and safety contracts, rather than seven independent prediction products. The system should maintain a patient-specific latent state, forecast the next clinically relevant trajectory, simulate candidate actions, and then constrain recommendations with guideline rules and clinician approval.
1. Scientific Framing: Dialysis Is a Dynamic System
Most published renal ML studies are still framed as supervised prediction problems: predict hypotension, high phosphorus, low albumin, inadequate Kt/V, or infection. That is useful but incomplete. Dialysis care is a partially observed dynamical system in which interventions change future state: ultrafiltration affects blood pressure and next-session weight; ESA changes hemoglobin with delayed dynamics; phosphate binders, diet, dialysis dose, vitamin D analogues and calcimimetics jointly affect phosphorus, calcium and PTH; access dysfunction changes effective clearance; infection and inflammation alter anemia and nutrition.
This makes continuous-time models such as CfC/LTC especially interesting. They can consume irregularly sampled laboratory and treatment events and update a compact latent physiological state between observations. However, a CfC/LTC model should be benchmarked against strong tabular and sequence baselines (LightGBM/XGBoost, TFT, attention models) and paired with mechanistic renal equations rather than treated as a replacement for established physiology.
2. Protocol-by-Protocol Evidence
2.1 Fluid, Dry Weight and Intradialytic Hemodynamics
This is the strongest target for a dynamic-system product. The most compelling large-scale paper located is Yun et al. (Scientific Reports, 2023), which trained an explainable Temporal Fusion Transformer on 302,774 hemodialysis sessions from 11,110 patients. It predicted severe intradialytic hypotension within one hour with AUROC 0.953, a broader hypotension definition with AUROC 0.892, and intradialytic hypertension with AUROC 0.889. The key methodological point is not merely the score: the model integrates time-varying and time-invariant variables and predicts during the session.
A 2023 multicenter retrospective study using 62,227 sessions found LightGBM to be the best-performing interpretable method across several hypotension definitions. Earlier work demonstrated quasi-real-time prediction of dialysis adverse events using slopes and differential features from machine telemetry and vital signs. Dry-weight studies using bioimpedance, blood-volume monitoring and clinical variables show that learned models can improve estimation, but dry weight remains a harder target because the ground truth is clinician-defined and imperfect.
    • Best scientific target: probability of IDH/IDHTN in the next 15, 30, 60 minutes plus estimated severity.
    • Better product target: counterfactual response to changing UF rate, sodium profile, temperature, blood-flow rate, session duration, or target weight.
    • Best architecture: CfC/LTC state estimator + calibrated event head + constrained action simulator; TFT/LightGBM as mandatory baselines.
    • Safety: no autonomous UF change initially. Recommend action ranges and require clinician confirmation; prospective silent-mode validation first.
2.2 Anemia Management
Anemia is the most mature example of AI-supported treatment personalization in dialysis. A 2023 study used 36,677 observations from 623 hemodialysis patients and a multi-head self-attention model to predict hemoglobin and recommend ESA doses. Hemoglobin MAE was 0.451 g/dL versus 0.593 for the comparison RNN; simulation suggested a higher proportion in target range (92.7% versus 86.3% under physician prescriptions), although the authors explicitly called for external and prospective validation.
The field also has a long history of reinforcement-learning approaches to ESA dosing and the commercially deployed Anemia Control Model (ACM). This is important because anemia is a delayed-control problem: today's ESA and iron decisions alter hemoglobin weeks later, and aggressive correction can increase cycling. The updated KDIGO 2026 Anemia in CKD guideline makes this an ideal domain for combining learned patient response with explicit clinical constraints.
    • State: Hb, Hb velocity, reticulocyte response if available, ferritin, TSAT, CRP/inflammation, iron exposure, ESA exposure, bleeding/transfusion events, dialysis adequacy.
    • Prediction: Hb distribution at 1, 2, 4 and 6 weeks; probability of leaving safe/desired bands.
    • Action: ESA dose, iron dose/hold, next lab timing, investigation flag for hyporesponsiveness.
    • Learning approach: supervised trajectory prediction first; offline policy evaluation second; only later consider constrained offline RL.
2.3 Dialysis Adequacy
Multiple studies show that delivered adequacy can be inferred from routinely captured machine and patient variables, reducing reliance on intermittent blood sampling. A 2021 Scientific Reports study found XGBoost performed best among tested methods using repeated dialysis-machine measurements. A 2024 study using 1,869 sessions from 373 patients reported Random Forest AUROC 0.873 for predicting spKt/V above 1.4, and a non-invasive subset still achieved AUROC 0.868. A 2026 multicenter study further supports the feasibility of pre-session Kt/V prediction.
    • Do not treat adequacy as a standalone classifier. Predict continuous spKt/V/URR with uncertainty and decompose likely causes of inadequate clearance.
    • Model access recirculation/failure, shortened treatment, low blood flow, dialyzer characteristics, body water/volume, UF, and adherence.
    • Provide a prescription simulator: 'If duration +30 min' or 'blood flow +50 mL/min', estimate expected adequacy and hemodynamic trade-off.
    • Mechanistic hybrid: Daugirdas/urea-kinetic equations provide a physics prior; ML models residual error and patient-specific effects.
2.4 Vascular Access Care
Vascular-access AI is attractive because it adds a new sensing modality rather than merely reusing EHR data. Deep-learning studies have converted AV fistula bruit into spectrograms and detected clinically significant stenosis using angiography or ultrasound as ground truth. A 2023 report also developed automated AVF stenosis screening from blood-flow sounds. This suggests a practical bedside device: a low-cost digital stethoscope or contact microphone feeding a model that detects longitudinal change from each patient's baseline.
    • Acoustic model: spectrogram encoder with patient-specific change detector.
    • Longitudinal model: access pressure, venous pressure, blood flow, recirculation, cannulation difficulty, interventions, access age.
    • Outputs: stenosis probability, thrombosis risk, 'change from baseline', recommended confirmatory ultrasound/referral.
    • A high-value differentiator is multimodal fusion: bruit + machine pressure waveforms + access history + adequacy changes.
2.5 CKD Mineral and Bone Disorder (CKD-MBD)
CKD-MBD has less mature AI evidence than anemia or IDH, but it is a strong scientific opportunity because calcium, phosphate and PTH form a coupled delayed-control system. KDIGO guidance emphasizes serial assessment and joint interpretation of phosphate, calcium and PTH rather than isolated values. A 2026 multicenter study of 718 maintenance hemodialysis patients produced an interpretable SVM model for hyperphosphatemia with AUROC 0.840; important predictors included predialysis creatinine, urea, potassium, CO2 combining power and PTH.
    • The product should predict trajectories, not only next-month 'high phosphorus'.
    • Model action effects for binder class/dose, adherence, dietary phosphate, dialysis dose, calcimimetic, vitamin D analogue, and calcium exposure.
    • Use a coupled multi-output model for phosphate, calcium and PTH; forcing separate models risks internally inconsistent recommendations.
    • Clinical rules should restrict unsafe combinations and enforce monitoring intervals; model recommendations remain advisory.
2.6 Nutrition and Electrolyte Control
The evidence is split into two problems. Nutritional deterioration can be predicted from routine data: a 2025 explainable XGBoost model for protein-energy wasting in 908 maintenance-hemodialysis patients achieved test AUROC 0.827, with predialysis creatinine, hand-grip strength, non-HDL cholesterol, Kt/V and hs-CRP among leading features. Separate deep-learning work predicts low serum albumin in incident hemodialysis patients. Electrolyte emergencies such as hyperkalemia can also be detected from ECG using ML, but ECG-derived potassium estimation should be an adjunct, not a substitute for laboratory confirmation when treatment decisions are high risk.
    • Nutrition state should combine intake, weight/body composition, albumin, creatinine, inflammation, hospitalization, appetite, GI symptoms and dialysis adequacy.
    • Hyperkalemia observer should forecast predialysis K and detect acute ECG signatures; action logic must distinguish emergency triage from routine management.
    • Metabolic acidosis can be incorporated as a trajectory variable linked to bicarbonate prescription, nutrition and dialysis delivery.
2.7 Infection Prevention and Vaccination
Machine learning can assist early infection recognition, but the prevention protocol itself is mainly deterministic. A 2023 study of 391 hemodialysis patients undergoing blood cultures found XGBoost achieved AUC 0.914 for bloodstream infection; temperature, non-AVF access, procalcitonin and neutrophil-to-lymphocyte ratio were among the most important variables. This is useful for triage, but it does not replace CDC infection-control procedures.
CDC's dialysis Core Interventions require surveillance and feedback, hand-hygiene observation, vascular-access care observation, staff education and competency, patient education, catheter reduction, chlorhexidine-based skin antisepsis, catheter-hub disinfection and appropriate exit-site antimicrobial practice. These are better implemented as auditable workflow state machines and compliance observers than as ML predictions.
    • ML: BSI/sepsis risk and early diagnostic support.
    • Rules/workflow: vaccination due dates, serology follow-up, isolation logic where applicable, hand hygiene/access-care audits, catheter reduction tasks.
    • Computer vision may eventually support hand-hygiene or PPE auditing, but governance/privacy burden is higher than the near-term value.
3. The Best Papers to Reproduce First
Protocol	Paper	Data scale	Method	Reported result	Why it matters	Reproduce?
Fluid/IDH	Yun et al., Sci Rep 2023	302,774 sessions; 11,110 pts	Temporal Fusion Transformer	AUROC 0.953 severe IDH	Large-scale real-time longitudinal forecasting	YES - #1
Anemia	Hsu et al., Heliyon 2023	36,677 points; 623 pts	Multi-head self-attention	Hb MAE 0.451 g/dL	Direct treatment recommendation problem	YES - #2
Adequacy	Kim et al., Sci Rep 2021	1,333 sessions; 61 pts	XGBoost/CNN/GRU	XGBoost best; corr 0.873	Machine-telemetry-to-adequacy mapping	YES - #3
Adequacy	2024 Ren Fail study	1,869 sessions; 373 pts	RF and other ML	AUROC 0.873	Non-invasive adequacy prediction	YES
Vascular access	Deep learning AVF sound studies	Prospective/small-to-moderate	CNN spectrogram models	Strong feasibility	New sensor + longitudinal baseline	YES - #4
CKD-MBD	Chen et al., BMC MIDM 2026	718 pts, 5 centers	SVM + SHAP	AUROC 0.840	Current multicenter phosphate-risk model	YES - #5
Nutrition	Cai et al., BMC Nephrol 2025	908 pts	XGBoost + SHAP	AUROC 0.827	PEW early-warning benchmark	YES
Infection	2023 Heliyon BSI model	391 pts	XGBoost + SHAP	AUC 0.914	Useful early infection triage	YES
4. Recommended Integrated Renal AI Architecture
A clinically credible system should separate four layers: state estimation, prediction, decision optimization, and safety/governance. This separation matters because a good predictor is not automatically a safe treatment policy.
Layer A — Renal Patient State
Continuously maintain a patient state containing static characteristics, comorbidities, access type, medications, laboratory values, dialysis prescription, machine telemetry, interdialytic weight, blood pressure, symptoms, adherence, hospital events and protocol status. Every observation and action is time stamped, allowing reconstruction of trajectory and treatment response.
Layer B — Physiological Dynamics
Use a shared CfC/LTC encoder for irregular longitudinal data, supplemented by protocol-specific heads. The shared latent state should model fluid/hemodynamics, erythropoiesis/iron, mineral-bone metabolism, electrolyte/acid-base balance, nutritional/inflammatory state and access performance. Benchmark against TFT, GRU/LSTM, LightGBM and simple clinical baselines.
Layer C — Protocol Observers
Create observers for IDH risk, dry-weight deviation, Hb drift, ESA hyporesponsiveness, phosphate/PTH drift, inadequate dialysis, access dysfunction, hyperkalemia, PEW and infection. Observers emit calibrated probabilities, expected time-to-event, confidence and the variables/trajectory segments driving the signal.
Layer D — Next Best Action
Generate candidate actions and predict their effect on future state. Initially use supervised treatment-response models and constrained optimization. Offline reinforcement learning is appropriate only when action logging, confounding control and off-policy evaluation are sufficiently strong.
Layer E — Clinical Safety Contract
Encode KDIGO/KDOQI/CDC rules, contraindications, hard dose/UF limits, required labs, escalation criteria and clinician-approval requirements. The learned model proposes; the safety layer constrains; the clinician authorizes.
5. Why CfC/LTC Is a Strong Research Bet Here
CfC/LTC is scientifically well matched to renal care because data arrive on multiple timescales: seconds-to-minutes during dialysis; days between sessions; weeks for ESA response; and months for PTH and nutritional trends. Continuous-time latent dynamics can naturally update across irregular intervals without forcing all observations into a fixed grid.
    • Fluid module: fastest dynamics, with minute-level BP/UF/machine telemetry.
    • Electrolytes: session-to-session dynamics with acute exceptions.
    • Anemia: delayed multi-week drug-response dynamics.
    • CKD-MBD: slower coupled control system with long treatment lags.
    • Nutrition/inflammation: slow trend with abrupt perturbations from hospitalization/infection.
The research question should not be 'Does CfC beat every model on AUROC?' A more valuable test is whether a shared continuous-time state improves multi-horizon forecasting, treatment-response estimation, calibration under missing/irregular data, transfer across clinics and patient-specific adaptation.
6. Experimental Program
Phase 1 — Retrospective Replication
    • Reproduce published baselines for IDH, anemia, adequacy, hyperphosphatemia, PEW and BSI on one harmonized renal data model.
    • Require patient-level and clinic-level splits; never randomly split individual rows from the same patient across train/test.
    • Measure AUROC/AUPRC where appropriate, calibration, Brier score, time-dependent concordance, MAE for continuous outcomes, and subgroup performance.
    • Establish simple baselines first: logistic/linear models, LightGBM/XGBoost, then TFT/attention, then CfC/LTC.
Phase 2 — Multi-task Renal State Model
    • Train one temporal encoder with protocol-specific output heads.
    • Predict several horizons simultaneously: within-session, next session, 1 week, 1 month.
    • Test whether multi-task learning improves data efficiency and robustness compared with seven separate models.
    • Add uncertainty estimates and abstention logic.
Phase 3 — Treatment-Response and Counterfactuals
    • Estimate individual treatment effects for UF/prescription changes, ESA/iron dosing and CKD-MBD therapies using doubly robust or causal representation methods.
    • Use target-trial emulation where possible; explicitly model time-varying confounding.
    • Validate counterfactual predictions against naturally occurring treatment changes before using them for recommendations.
Phase 4 — Prospective Silent Deployment
    • Run predictions without exposing them to clinicians.
    • Measure calibration drift, lead time, alert burden, false-positive cost and intervention opportunity.
    • Recalibrate per site and assess fairness across age, sex, dialysis vintage, access type and relevant demographic strata.
Phase 5 — Decision Support Trial
    • Expose recommendations with reasons, predicted benefit, uncertainty and guideline constraints.
    • Primary endpoints should include protocol-specific clinical outcomes and operational metrics, not just model accuracy.
    • Use stepped-wedge or cluster-randomized designs when individual randomization is operationally difficult.
7. Data Model Required
Domain	Minimum data	High-value optional data
Patient	age, sex, height, diagnosis, comorbidities, dialysis vintage	frailty, functional status, social factors
Session	start/end, prescription, UF goal/actual, blood/dialysate flow, dialyzer, temperature	continuous machine waveforms, relative blood volume
Vitals	pre/post BP/HR, intradialytic BP/HR	continuous non-invasive hemodynamics
Labs	Hb, ferritin, TSAT, Ca, P, PTH, K, bicarbonate/CO2, albumin, urea, creatinine	CRP, reticulocytes, FGF23, vitamin D
Treatments	ESA, IV/oral iron, binders, calcimimetic, vitamin D, antihypertensives	actual adherence / refill data
Access	type, age, interventions, complications	digital bruit, ultrasound, access flow
Events	IDH, cramps, early termination, ED/hospitalization, infection, transfusion	symptoms and patient-reported outcomes
Protocol	due labs, target states, exceptions, clinician overrides	reason for override and adjudicated outcome
8. Product Design: One System, Seven Protocols
A renal command center should show the current patient state, trajectory, protocol compliance, predicted risks and next-best actions. The core interaction is not 'query the chart.' It is 'what changed, what is likely to happen next, which protocol is drifting, and which intervention has the best expected benefit under safety constraints?'
    • Patient State Timeline: synchronized labs, dialysis sessions, medications, access interventions, hospitalizations and protocol exceptions.
    • Trajectory Panel: predicted Hb, phosphorus/PTH, potassium, weight/volume and adequacy with confidence bands.
    • Intradialytic Live Panel: BP/UF trajectory, IDH probability and recommended mitigation options.
    • Protocol Cockpit: green/amber/red status by anemia, MBD, fluid, adequacy, access, nutrition/electrolytes and infection.
    • Next Best Action: ranked actions with predicted effect, evidence basis, constraints and clinician override.
    • Decision Lineage: input state → model forecast → candidate actions → safety rules → final recommendation → clinician decision → observed outcome.
9. What Not to Do
    • Do not create a generic LLM that reads renal notes and directly recommends therapy without an explicit physiological state and safety layer.
    • Do not optimize only AUROC. In dialysis, calibration, lead time, false-alert rate and actionability are often more important.
    • Do not train on random rows when the same patient appears in both training and test sets.
    • Do not use physician actions as unquestioned ground truth for treatment recommendations; treatment data are confounded by indication.
    • Do not jump directly to online reinforcement learning in clinical care.
    • Do not automate infection-control rules or emergency hyperkalemia management solely from learned predictions.
10. Recommended First Product Release
The first release should focus on three tightly connected modules: (1) intradialytic hemodynamic risk and fluid/dry-weight intelligence, (2) anemia trajectory and ESA/iron decision support, and (3) continuous adequacy prediction. These three share the richest data streams, have the strongest published evidence, and demonstrate the central value proposition of a dynamic renal state engine.
Vascular-access intelligence should be the fourth module because it provides a visually compelling and commercially differentiating sensor capability. CKD-MBD, nutrition/electrolytes and infection should then be layered onto the same state model. This sequencing produces an integrated renal operating system rather than a collection of calculators.
11. Key Scientific Sources
1. KDIGO. Clinical Practice Guideline for the Evaluation and Management of Chronic Kidney Disease. Kidney International 2024;105(Suppl 4S):S117-S314. https://kdigo.org/guidelines/ckd-evaluation-and-management/
2. KDIGO. Clinical Practice Guideline Update for CKD-Mineral and Bone Disorder. Kidney International Supplements 2017. https://kdigo.org/guidelines/ckd-mbd/
3. KDIGO. Clinical Practice Guideline for the Management of Anemia in Chronic Kidney Disease. Kidney International 2026;109(Suppl 1S):S1-S99. https://kdigo.org/guidelines/anemia-in-ckd/
4. Lok CE, et al. KDOQI Clinical Practice Guideline for Vascular Access: 2019 Update. Am J Kidney Dis. 2020;75(4 Suppl 2):S1-S164. doi:10.1053/j.ajkd.2019.12.001.
5. Yun D, et al. Real-time dual prediction of intradialytic hypotension and hypertension using an explainable deep learning model. Scientific Reports. 2023;13:18054. doi:10.1038/s41598-023-45282-1.
6. Liu YS, et al. Machine Learning Analysis of Time-Dependent Features for Predicting Adverse Events During Hemodialysis Therapy. J Med Internet Res. 2021;23(9):e27098. doi:10.2196/27098.
7. Machine learning-based intradialytic hypotension prediction of patients undergoing hemodialysis: a multicenter retrospective study. Comput Methods Programs Biomed. 2023. doi:10.1016/j.cmpb.2023.107698.
8. Hsu et al. Multi-head self-attention mechanism enabled individualized hemoglobin prediction and treatment recommendation systems in anemia management for hemodialysis patients. Heliyon. 2023;9:e12613. doi:10.1016/j.heliyon.2022.e12613.
9. Escandell-Montero P, et al. Optimization of anemia treatment in hemodialysis patients via reinforcement learning. Artificial Intelligence in Medicine. 2014;62(1):47-60.
10. Kim HW, et al. Dialysis adequacy predictions using a machine learning method. Scientific Reports. 2021;11. doi:10.1038/s41598-021-94964-1.
11. Prediction of dialysis adequacy using data-driven machine learning algorithms. Renal Failure. 2024. doi:10.1080/0886022X.2024.2420826.
12. Chen J, et al. An explainable machine learning model for predicting high phosphorus risk in patients on maintenance hemodialysis: a multicenter retrospective study. BMC Medical Informatics and Decision Making. 2026. doi:10.1186/s12911-026-03678-9.
13. Deep learning analysis of blood flow sounds to detect arteriovenous fistula stenosis. 2023. PubMed PMID: 37658233.
14. Feasibility of Deep Learning-Based Analysis of Auscultation for Screening Significant Stenosis of Native Arteriovenous Fistula for Hemodialysis Requiring Angioplasty. 2022. PubMed PMID: 36174999.
15. Cai G, et al. Explainable machine learning models for predicting of protein-energy wasting in patients on maintenance haemodialysis. BMC Nephrology. 2025;26:562. doi:10.1186/s12882-025-04476-7.
16. Early identification of bloodstream infection in hemodialysis patients by machine learning. Heliyon. 2023;9:e18263. doi:10.1016/j.heliyon.2023.e18263.
17. David-Olawade AC, et al. Artificial intelligence and machine learning applications in dialysis: Current applications, challenges, and future directions. Clin Chim Acta. 2026;586:120908. doi:10.1016/j.cca.2026.120908.
18. Neri L, Zhang H, Usvyat LA. Artificial intelligence in kidney disease and dialysis: from data mining to clinical impact. Curr Opin Nephrol Hypertens. 2026;35(1):30-35.
19. American Society of Nephrology. Responsible Use of Artificial Intelligence to Improve Kidney Care: A Statement from the ASN. 2025/2026.
20. CDC. Best Practices for Bloodstream Infection Prevention in the Dialysis Setting. https://www.cdc.gov/dialysis-safety/hcp/clinical-safety/index.html

Important clinical note: This report is a research and product-development analysis, not a treatment protocol. Any production system should be validated prospectively, governed as clinical decision support, and reviewed by nephrologists, dialysis nurses, pharmacists, dietitians, infection-prevention specialists, and regulatory/quality teams.
