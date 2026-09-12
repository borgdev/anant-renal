"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Apple,
  ArrowRight,
  CheckCircle2,
  FileText,
  FlaskConical,
  GitBranch,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { EmptyView, Eyebrow, Metric, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import {
  NUTRITION_ACTION_LABEL,
  nutritionActionTone,
  pathwayTone,
  potassiumTone,
  adviseNutrition,
  fetchNutritionAssurance,
  fetchNutritionMdr,
  fetchNutritionPathways,
  fetchNutritionSafety,
  fetchNutritionState,
  fetchNutritionTwin,
  fetchNutritionValidation,
  nutritionWhatIf,
  recordNutritionStudy,
  runNutritionRedTeam,
  snapshotNutritionDrift,
  type NutritionAssuranceView,
  type NutritionCandidate,
  type NutritionSafetyView,
  type NutritionStateView,
  type NutritionTwinView,
  type NutritionValidationView,
  type NutritionWhatIfResult,
  type PewPathwayScore,
} from "../lib/nutrition";
import type { NavigationId } from "../lib/types";
import RankedActionsPanel from "./ranked-actions-panel";

type Props = { onNavigate?: (id: NavigationId) => void };

/** The five ways to lose albumin — never averaged into one "malnutrition" score. */
function PathwayBars({ pathways, dominant }: { pathways: PewPathwayScore[]; dominant?: string }) {
  return (
    <div className="pc-bars">
      {pathways.map((p, index) => (
        <div className={`nut-pathway ${p.pathway === dominant ? "is-dominant" : ""}`} key={p.pathway}>
          <div className="nut-pathway-head">
            <span className="pc-bar-label">{p.label}</span>
            <Tag tone={pathwayTone(index)}>{p.pathway}</Tag>
            <span className="adq-mono">{p.score}</span>
          </div>
          <ProgressBar value={p.score * 100} tone={p.score >= 0.6 ? "red" : p.score >= 0.3 ? "amber" : "blue"} />
          <p className="nut-pathway-why">{p.because}</p>
          {p.markers.length ? (
            <div className="pc-inline pc-wrap">
              {p.markers.map((m) => (
                <Tag key={`${p.pathway}-${m.marker}`} tone="neutral">
                  {m.marker} {m.value} {m.unit} (want {m.expected})
                </Tag>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Plan options with the pathway they target and the potassium they project. */
function PlanTable({ result }: { result: NutritionWhatIfResult }) {
  const rows = useMemo(
    () => [...result.candidates].sort((a, b) => (a.allowed === b.allowed ? a.score - b.score : a.allowed ? -1 : 1)),
    [result.candidates],
  );
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Intervention</span>
        <span>Albumin 90 d</span>
        <span>K 90 d</span>
        <span>Bicarb 90 d</span>
        <span>Markers resolved</span>
        <span>Status</span>
      </div>
      {rows.map((c: NutritionCandidate) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>
              targets {c.pathway} · burden {c.burden} · score {c.score}
            </em>
          </span>
          <span className="adq-mono is-mint">{c.projected.albumin}</span>
          <span className={`adq-mono is-${potassiumTone(c.projected.potassium)}`}>{c.projected.potassium}</span>
          <span className="adq-mono">{c.projected.bicarbonate}</span>
          <span className="adq-mono">{c.markersResolved}/5</span>
          <span>
            {!c.allowed ? (
              <Tag tone="neutral">
                <AlertTriangle size={11} /> {c.blockedReason ?? "blocked"}
              </Tag>
            ) : (
              <span className="pc-inline pc-wrap">
                {result.recommended === c ? (
                  <Tag tone="mint">
                    <CheckCircle2 size={11} /> best allowed
                  </Tag>
                ) : (
                  <Tag tone="neutral">allowed</Tag>
                )}
                {c.requiresLabConfirmation ? <Tag tone="amber">needs a fresh potassium</Tag> : null}
              </span>
            )}
          </span>
        </div>
      ))}
      <p className="adq-note">{result.note}</p>
    </div>
  );
}

export default function NutritionCds({ onNavigate }: Props) {
  const [state, setState] = useState<NutritionStateView | null>(null);
  const [assurance, setAssurance] = useState<NutritionAssuranceView | null>(null);
  const [validation, setValidation] = useState<NutritionValidationView | null>(null);
  const [safety, setSafety] = useState<NutritionSafetyView | null>(null);
  const [advice, setAdvice] = useState<{
    recommendation: NutritionStateView["windows"][number]["recommendation"];
    whatIf: NutritionWhatIfResult;
    pathwayShift: Array<{ pathway: string; before: number; after: number }>;
    trained?: { artifactId: string; pewProbability: number; drivers: Array<{ feature: string; gain: number; share: number }> };
  } | null>(null);
  const [twin, setTwin] = useState<NutritionTwinView | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stateView, assuranceView, validationView, safetyView] = await Promise.all([
        fetchNutritionState(),
        fetchNutritionAssurance(),
        fetchNutritionValidation(),
        fetchNutritionSafety(),
      ]);
      setState(stateView);
      setAssurance(assuranceView);
      setValidation(validationView);
      setSafety(safetyView);
      const first = stateView.windows[0]?.patientId ?? "";
      setSelected((current) => current || first);
      if (first) setTwin(await fetchNutritionTwin(first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the nutrition pack");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const withAction = useCallback(async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      setStatus(await fn());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const runAdvice = useCallback(async (patientId: string, model: "reference" | "trained") => {
    if (!patientId) return;
    setBusy("advice");
    try {
      const [response, whatIf, twinView] = await Promise.all([
        adviseNutrition({ patientId, model }),
        nutritionWhatIf({ patientId }),
        fetchNutritionTwin(patientId),
      ]);
      setAdvice({
        recommendation: { ...response.recommendation, coverage: response.coverage },
        whatIf: whatIf.result,
        pathwayShift: whatIf.pathwayShift,
        ...(response.trained ? { trained: response.trained } : {}),
      });
      setTwin(twinView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "advise failed");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (selected) void runAdvice(selected, "reference");
  }, [selected, runAdvice]);

  const windowPager = usePaged(state?.windows ?? [], 8);
  const observationPager = usePaged(twin?.twin.observations ?? [], 8);

  if (error && !state) return <EmptyView title="Nutrition pack unavailable" description={error} />;
  if (!state || !assurance) {
    return (
      <div className="pc-page">
        <div className="pc-loading">
          <RefreshCw className="is-spinning" size={16} /> loading nutrition / electrolyte protocol pack…
        </div>
      </div>
    );
  }

  const recommendation = advice?.recommendation;
  const drift = twin?.drift;
  const needsLab = recommendation?.safety.requiresLabConfirmation ?? false;

  return (
    <div className="pc-page">
      <header className="pc-header">
        <div>
          <Eyebrow>P5 · nutrition &amp; electrolytes · five-pathway PEW + potassium forecast</Eyebrow>
          <h1>Nutrition &amp; electrolytes</h1>
          <p className="pc-sub">
            Protein-energy wasting is <strong>disentangled into five pathways</strong> — poor intake, inflammation,
            dilution, catabolism and inadequate dialysis — because &ldquo;falling albumin&rdquo; has five different
            treatments. Potassium is projected to the next session from the interdialytic interval, the acidosis and the
            delivered dose. <strong>Every hyperkalaemia action requires a confirmatory lab</strong>, and an ECG pattern
            is an adjunct that never triggers an action on its own.
          </p>
        </div>
        <div className="pc-actions">
          <button className="pc-btn" disabled={busy !== null} onClick={() => void load()}>
            <RefreshCw size={14} className={busy === "reload" ? "is-spinning" : ""} /> Refresh
          </button>
        </div>
      </header>

      {status ? <p className="pc-status">{status}</p> : null}
      {error ? <p className="pc-error">{error}</p> : null}

      {needsLab ? (
        <div className="nut-contract">
          <ShieldAlert size={16} />
          <div>
            <strong>Lab confirmation required before any potassium-lowering action.</strong>
            <p>
              {recommendation?.potassium.note} An ECG pattern (if present) is recorded as an adjunct; it can never stand
              alone. The platform orders nothing — the confirmatory lab and any treatment are human decisions.
            </p>
          </div>
        </div>
      ) : null}

      <div className="pc-kpis">
        <Metric label="Patients tracked" value={String(state.kpis.patientsTracked)} detail={`${state.withSerialSeries} with a serial series`} />
        <Metric label="PEW detected" value={String(state.kpis.pew)} detail="≥3 of the 5 PEW markers" tone={state.kpis.pew ? "amber" : "mint"} />
        <Metric label="Inflammation-dominant" value={String(state.kpis.inflammationDominant)} detail="the CRP pathway leads — feeding will not fix it" tone={state.kpis.inflammationDominant ? "amber" : "mint"} />
        <Metric label="Potassium risk" value={String(state.kpis.hyperkalemiaRisk)} detail="P(K>6.0) at or above the escalation threshold" tone={state.kpis.hyperkalemiaRisk ? "red" : "mint"} />
        <Metric label="Acidosis" value={String(state.kpis.acidosis)} detail="bicarbonate below 22 mmol/L" tone={state.kpis.acidosis ? "amber" : "mint"} />
        <Metric label="Lab confirmations" value={String(state.kpis.labConfirmationRequired)} detail={`${state.kpis.ecgAdjuncts} ECG pattern(s) held as adjuncts`} tone={state.kpis.labConfirmationRequired ? "amber" : "mint"} />
      </div>

      <RankedActionsPanel
        payload={state?.actions}
        protocol="nutrition"
        emptyHint="No PEW pathway or potassium band crossed its action threshold, and no serial measurement window was thin enough to need a lab-confirmation task."
      />

      {/* ---------- A: five-pathway advisor ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Apple size={15} /> PEW advisor
            </h2>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="pc-select">
              {state.windows.map((w) => (
                <option key={w.patientId} value={w.patientId}>
                  {w.patientId} · albumin {w.recommendation.current.albumin ?? "—"} · K {w.recommendation.current.potassium ?? "—"}
                </option>
              ))}
            </select>
          </div>

          {recommendation ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={nutritionActionTone(recommendation.action)}>{NUTRITION_ACTION_LABEL[recommendation.action]}</Tag>
                <Tag tone={recommendation.pew.pew ? "amber" : "mint"}>
                  PEW {recommendation.pew.pew ? `yes · ${recommendation.pew.severity}` : "not met"} ({recommendation.pew.markersPresent}/5 markers)
                </Tag>
                <Tag tone="blue">dominant: {recommendation.pew.dominant}</Tag>
                {recommendation.safety.emergency ? <Tag tone="red">emergency pathway</Tag> : null}
                <Tag tone={recommendation.model.kind === "trained" ? "violet" : "neutral"}>{recommendation.model.kind}</Tag>
              </div>

              <div className="adq-facts">
                <span>
                  <em>Albumin</em>
                  <strong className={(recommendation.current.albumin ?? 9) < 3.5 ? "is-amber" : "is-mint"}>{recommendation.current.albumin ?? "—"} g/dL</strong>
                </span>
                <span>
                  <em>hs-CRP</em>
                  <strong className={(recommendation.current.crp ?? 0) > 10 ? "is-amber" : "is-mint"}>{recommendation.current.crp ?? "—"} mg/L</strong>
                </span>
                <span>
                  <em>Handgrip</em>
                  <strong className={(recommendation.current.handgripKg ?? 99) < 24 ? "is-amber" : "is-mint"}>{recommendation.current.handgripKg ?? "—"} kg</strong>
                </span>
                <span>
                  <em>Pre-dialysis K</em>
                  <strong className={`is-${potassiumTone(recommendation.current.potassium)}`}>{recommendation.current.potassium ?? "—"} mmol/L</strong>
                </span>
                <span>
                  <em>Bicarbonate</em>
                  <strong className={(recommendation.current.bicarbonate ?? 24) < 22 ? "is-amber" : "is-mint"}>{recommendation.current.bicarbonate ?? "—"} mmol/L</strong>
                </span>
                <span>
                  <em>delivered spKt/V</em>
                  <strong className={(recommendation.current.ktV ?? 1.4) < 1.2 ? "is-amber" : "is-mint"}>{recommendation.current.ktV ?? "—"}</strong>
                </span>
              </div>

              <div className="fd-horizons">
                <span className="fd-horizons-label">potassium forecast to the next session</span>
                <span className="fd-horizon">
                  <em>projected K</em>
                  <strong className={`is-${potassiumTone(recommendation.potassium.nextSession)}`}>{recommendation.potassium.nextSession ?? "—"}</strong>
                </span>
                <span className="fd-horizon">
                  <em>P(K&gt;6.0)</em>
                  <strong className={`is-${(recommendation.potassium.probabilityAbove6 ?? 0) >= 0.35 ? "red" : "mint"}`}>
                    {recommendation.potassium.probabilityAbove6 ?? "—"}
                  </strong>
                </span>
                <span className="fd-horizon">
                  <em>interval</em>
                  <strong className="is-neutral">{recommendation.potassium.intervalHours ?? "—"} h</strong>
                </span>
              </div>

              <div className="pc-bars">
                {recommendation.potassium.drivers.map((d) => (
                  <div className="pc-bar-row" key={d.id}>
                    <span className="pc-bar-label">{d.label}</span>
                    <ProgressBar value={Math.min(100, Math.abs(d.value) * 100)} tone={d.value > 0 ? "red" : "mint"} />
                    <span className="adq-mono">{d.value > 0 ? "+" : ""}{d.value}</span>
                  </div>
                ))}
              </div>

              <p className="adq-note">{recommendation.note}</p>

              {recommendation.plan.length ? (
                <div className="pc-inline pc-wrap">
                  <span className="pc-panel-note">plan:</span>
                  {recommendation.plan.map((a) => (
                    <Tag key={a} tone={nutritionActionTone(a)}>{NUTRITION_ACTION_LABEL[a]}</Tag>
                  ))}
                </div>
              ) : null}

              {recommendation.guardrails.flags.length ? (
                <div className="pc-inline pc-wrap">
                  {recommendation.guardrails.flags.map((f) => (
                    <Tag key={f} tone={f.includes("red-flag") || f.includes("stale") || f.includes("ecg") ? "red" : "neutral"}>
                      {f.replace(/-/g, " ")}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {advice?.trained ? (
                <div className="mbd-trained">
                  <div className="pc-inline pc-wrap">
                    <Tag tone="blue">{advice.trained.artifactId}</Tag>
                    <Tag tone={advice.trained.pewProbability >= 0.5 ? "amber" : "mint"}>
                      trained PEW probability {advice.trained.pewProbability}
                    </Tag>
                  </div>
                  <div className="pc-bars">
                    {advice.trained.drivers.slice(0, 5).map((d) => (
                      <div className="pc-bar-row" key={d.feature}>
                        <span className="pc-bar-label">{d.feature}</span>
                        <ProgressBar value={d.share * 100} />
                        <span className="adq-mono">{(d.share * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="pc-inline pc-wrap">
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void runAdvice(recommendation.patientId, "trained")}>
                  <FlaskConical size={13} /> Score with the trained head
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("accept", async () => { await recordNutritionStudy({ patientId: recommendation.patientId, action: "accept", clinician: "renal-dietitian" }); return "study record saved: plan accepted"; })}>
                  <CheckCircle2 size={13} /> Accept plan
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("modify", async () => { await recordNutritionStudy({ patientId: recommendation.patientId, action: "modify", clinician: "renal-dietitian" }); return "study record saved: modified"; })}>
                  <Activity size={13} /> Record modify
                </button>
              </div>
            </>
          ) : (
            <div className="pc-loading">
              <RefreshCw size={14} className="is-spinning" /> assessing pathways…
            </div>
          )}
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <GitBranch size={15} /> Five-pathway decomposition
            </h2>
            <span className="pc-panel-note">the leading pathway is the one the plan targets — the five are never averaged</span>
          </div>
          {recommendation ? <PathwayBars pathways={recommendation.pew.pathways} dominant={recommendation.pew.dominant} /> : null}
        </div>
      </section>

      {/* ---------- C: pathway-targeted plan counterfactual ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Plan counterfactual — every option judged on the pathway it targets
          </h2>
          <span className="pc-panel-note">
            {advice
              ? `contract: potassium > ${advice.whatIf.current.potassium !== undefined ? "5.8" : "—"} requires a lab ≤ ${safety?.maxLabAgeHours ?? 12} h old · escalation at P(K>6.0) ≥ ${safety?.escalationThreshold ?? 0.35}`
              : ""}
          </span>
        </div>
        {advice ? <PlanTable result={advice.whatIf} /> : null}

        {advice?.pathwayShift?.length ? (
          <div className="pc-bars">
            <span className="pc-panel-note">pathway attribution shift for the recommended action</span>
            {advice.pathwayShift.map((p) => (
              <div className="pc-bar-row" key={p.pathway}>
                <span className="pc-bar-label">{p.pathway}</span>
                <ProgressBar value={p.before * 100} tone={p.after < p.before ? "mint" : "amber"} />
                <span className="adq-mono">
                  {p.before} → {p.after}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ---------- D: serial twin ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <GitBranch size={15} /> Nutrition twin — serial series from the ledger
          </h2>
          <span className="pc-panel-note">
            {twin ? `${twin.twin.summary.observations} observation(s) · ${twin.twin.sessions.length} session(s) · dose source ${twin.twin.provenance.ktVSource} · provenance ${twin.twin.provenance.attributedBy}` : ""}
          </span>
        </div>

        {drift ? (
          <div className="pc-inline pc-wrap">
            <Tag tone={drift.verdict === "pass" ? "mint" : drift.verdict === "watch" ? "amber" : "neutral"}>verdict: {drift.verdict}</Tag>
            <Tag tone="neutral">forward pairs {drift.potassiumPairs}</Tag>
            <Tag tone={(drift.potassiumMae ?? 9) <= drift.targetMae ? "mint" : "amber"}>
              K MAE {drift.potassiumMae ?? "—"} (target ≤{drift.targetMae})
            </Tag>
            <Tag tone={(drift.auroc ?? 0) >= drift.targetAuroc ? "mint" : "amber"}>
              event AUROC {drift.auroc ?? "—"} (target ≥{drift.targetAuroc})
            </Tag>
            <Tag tone="neutral">{drift.events} observed K&gt;6.0 event(s)</Tag>
            {twin?.twin.ecgFlags.length ? <Tag tone="amber">{twin.twin.ecgFlags.length} ECG adjunct(s) — never a trigger</Tag> : null}
          </div>
        ) : null}
        {drift ? <p className="adq-note">{drift.note}</p> : null}

        {twin && twin.twin.observations.length ? (
          <div className="adq-candidates">
            <div className="adq-cand-head">
              <span>Observation</span>
              <span>Albumin</span>
              <span>CRP</span>
              <span>K</span>
              <span>Bicarb / handgrip</span>
              <span>Source</span>
            </div>
            {observationPager.visible.map((o, index) => (
              <div className="adq-cand-row" key={`${o.at}-${index}`}>
                <span className="adq-cand-label">
                  <strong>{o.at ? new Date(o.at).toLocaleDateString() : "—"}</strong>
                  <em>{o.at ? new Date(o.at).toLocaleTimeString() : ""}</em>
                </span>
                <span className={`adq-mono is-${(o.albumin ?? 9) < 3.5 ? "amber" : "mint"}`}>{o.albumin ?? "—"}</span>
                <span className="adq-mono">{(o.crp ?? 0) > 10 ? <em className="adq-sym">inflammation</em> : null} {o.crp ?? "—"}</span>
                <span className={`adq-mono is-${potassiumTone(o.potassium)}`}>{o.potassium ?? "—"}</span>
                <span className="adq-mono">
                  {o.bicarbonate ?? "—"} / {o.handgripKg ?? "—"}
                </span>
                <span className="adq-mono">{o.nonHdlMgDl !== undefined ? `non-HDL ${o.nonHdlMgDl}` : o.creatinineMgDl !== undefined ? `creatinine ${o.creatinineMgDl}` : "—"}</span>
              </div>
            ))}
            <LoadMore shown={observationPager.visible.length} total={twin.twin.observations.length} onMore={observationPager.showMore} label="observations" />
          </div>
        ) : (
          <EmptyView title="No serial nutrition series yet" description="The twin needs serial albumin / potassium / bicarbonate results (and a handgrip assessment) before the pathways and the potassium forecast can be scored." />
        )}
      </section>

      {/* ---------- live windows ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Live windows — ledger series
          </h2>
          <span className="pc-panel-note">{state.source}</span>
        </div>
        <div className="adq-candidates">
          <div className="adq-cand-head">
            <span>Patient</span>
            <span>Albumin / CRP</span>
            <span>K / P(K&gt;6)</span>
            <span>Pathway</span>
            <span>Action</span>
            <span>Coverage</span>
          </div>
          {windowPager.visible.map((w) => (
            <div className="adq-cand-row" key={w.patientId}>
              <span className="adq-cand-label">
                <strong>{w.patientId}</strong>
                <em>
                  {w.__displayFacility ?? "—"} · {w.serialObservations} observation(s) · {w.ecgPatternCount} ECG adjunct(s)
                </em>
              </span>
              <span className="adq-mono">
                {w.recommendation.current.albumin ?? "—"} / {w.recommendation.current.crp ?? "—"}
              </span>
              <span className={`adq-mono is-${potassiumTone(w.recommendation.potassium.nextSession)}`}>
                {w.recommendation.current.potassium ?? "—"} / {w.recommendation.potassium.probabilityAbove6 ?? "—"}
              </span>
              <span>
                <Tag tone="neutral">{w.recommendation.pew.dominant}</Tag>
              </span>
              <span>
                <Tag tone={nutritionActionTone(w.recommendation.action)}>{NUTRITION_ACTION_LABEL[w.recommendation.action]}</Tag>
              </span>
              <span>
                <Tag tone={w.coverage.covered ? "mint" : "amber"}>{w.coverage.covered ? "covered" : w.coverage.reason ?? "out of domain"}</Tag>
              </span>
            </div>
          ))}
          <LoadMore shown={windowPager.visible.length} total={state.windows.length} onMore={windowPager.showMore} label="windows" />
        </div>
      </section>

      {/* ---------- B / E / F: governance, artifact, MDR ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <ShieldCheck size={15} /> Governance, contract &amp; assurance
            </h2>
            {assurance.model.artifact.note ? <span className="pc-panel-note">{assurance.model.artifact.note}</span> : null}
          </div>

          {safety ? (
            <div className="nut-contract is-quiet">
              <ShieldAlert size={15} />
              <div>
                <strong>{safety.contract}</strong>
                <ul className="ax-audio-gates">
                  {safety.rules.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className="pc-inline pc-wrap">
            {assurance.gate.gates.map((g) => (
              <Tag key={g.name} tone={g.passed ? "mint" : "red"}>
                {g.passed ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} {g.name}
              </Tag>
            ))}
          </div>

          <div className="adq-candidates">
            <div className="adq-cand-head">
              <span>Red-team scenario</span>
              <span>Threat</span>
              <span>Probe</span>
              <span>Result</span>
            </div>
            {assurance.redTeam.scenarios.map((s) => (
              <div className="adq-cand-row" key={s.id}>
                <span className="adq-cand-label">
                  <strong>{s.id}</strong>
                  <em>{s.name}</em>
                </span>
                <span className="adq-mono">{s.threatModel}</span>
                <span className="adq-mono">{s.probeLabel}</span>
                <span>
                  <Tag tone={s.probe.passed ? "mint" : "red"}>{s.probe.passed ? "contained" : "failed"}</Tag>
                </span>
              </div>
            ))}
          </div>

          <div className="pc-inline pc-wrap">
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("red-team", async () => { const r = await runNutritionRedTeam(); return `red team: ${r.probes.filter((p) => p.passed).length}/${r.probes.length} probes contained`; })}>
              <ShieldCheck size={13} /> Run rt-033..036
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("drift", async () => { const r = await snapshotNutritionDrift(); return `drift: ${r.snapshot.verdict} (KS ${r.snapshot.ksStatistic})`; })}>
              <TrendingUp size={13} /> Drift snapshot
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("mdr", async () => { const r = await fetchNutritionMdr(); setMdr(r.mdr); return "MDR technical file materialised"; })}>
              <FileText size={13} /> Build MDR file
            </button>
          </div>
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <FileText size={15} /> PEW classifier + potassium head
            </h2>
            <span className="pc-panel-note">
              {assurance.model.artifact.present ? `${assurance.model.artifact.id} v${assurance.model.artifact.version}` : "no artifact"}
            </span>
          </div>

          {assurance.model.artifact.present ? (
            <>
              <div className="adq-facts">
                <span>
                  <em>PEW AUROC</em>
                  <strong className={assurance.model.artifact.meetsPewTarget ? "is-mint" : "is-red"}>
                    {assurance.model.artifact.classifier?.auroc ?? "—"}
                  </strong>
                </span>
                <span>
                  <em>Marker-count prior</em>
                  <strong>{assurance.model.artifact.priorAuroc ?? "—"}</strong>
                </span>
                <span>
                  <em>Brier / ECE</em>
                  <strong>
                    {assurance.model.artifact.classifier?.brier ?? "—"} / {assurance.model.artifact.classifier?.ece ?? "—"}
                  </strong>
                </span>
                <span>
                  <em>K forecast MAE</em>
                  <strong className={assurance.model.artifact.improvesPotassiumForecast ? "is-mint" : "is-amber"}>
                    {assurance.model.artifact.regressor?.mae ?? "—"} vs {assurance.model.artifact.regressorPrior?.mae ?? "—"}
                  </strong>
                </span>
                <span>
                  <em>Rows / patients</em>
                  <strong>
                    {assurance.model.artifact.rows ?? 0} / {assurance.model.artifact.patients ?? 0}
                  </strong>
                </span>
                <span>
                  <em>Pathways audited</em>
                  <strong>{assurance.model.artifact.pathwayAudit?.length ?? 0}/5</strong>
                </span>
              </div>

              {assurance.model.artifact.pathwayAudit?.length ? (
                <div className="pc-bars">
                  <span className="pc-panel-note">per-pathway audit: observed PEW rate vs mean model score</span>
                  {assurance.model.artifact.pathwayAudit.map((a) => (
                    <div className="pc-bar-row" key={a.pathway}>
                      <span className="pc-bar-label">{a.pathway}</span>
                      <ProgressBar value={a.meanScore * 100} tone={Math.abs(a.meanScore - a.observedPewRate) < 0.15 ? "mint" : "amber"} />
                      <span className="adq-mono">
                        {a.meanScore} / {a.observedPewRate} (n={a.rows})
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <p className="adq-note">{validation?.report.benchmarkNote}</p>
            </>
          ) : (
            <EmptyView title="No trained artifact" description="Train with `npx tsx scripts/train-nutrition-model.ts`; until then the five-pathway clinical rule set and the mechanistic potassium forecast serve the plan." />
          )}

          {validation ? (
            <>
              <div className="adq-candidates">
                <div className="adq-cand-head">
                  <span>Acceptance criterion</span>
                  <span>Target</span>
                  <span>Observed</span>
                  <span>Verdict</span>
                </div>
                {validation.report.criteria.map((c) => (
                  <div className="adq-cand-row" key={c.criterion}>
                    <span className="adq-cand-label">
                      <strong>{c.criterion}</strong>
                    </span>
                    <span className="adq-mono">{c.target}</span>
                    <span className="adq-mono">{typeof c.observed === "object" ? JSON.stringify(c.observed) : String(c.observed ?? "—")}</span>
                    <span>
                      <Tag tone={c.met ? "mint" : "red"}>{c.met ? "met" : "not met"}</Tag>
                    </span>
                  </div>
                ))}
              </div>
              <p className="adq-note">{validation.report.note}</p>
            </>
          ) : null}

          {mdr ? (
            <details className="pc-details">
              <summary>MDR / EU AI Act technical file</summary>
              <pre className="pc-pre">{JSON.stringify(mdr, null, 2)}</pre>
            </details>
          ) : null}

          <div className="pc-inline pc-wrap">
            <button className="pc-btn ghost" onClick={() => onNavigate?.("protocols")}>
              <ArrowRight size={13} /> Protocol cockpit
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
