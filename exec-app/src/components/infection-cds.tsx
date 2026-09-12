"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  FileText,
  FlaskConical,
  GitBranch,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Syringe,
  Thermometer,
} from "lucide-react";
import { EmptyView, Eyebrow, LoadMore, Metric, ProgressBar, Tag, usePaged } from "./ui";
import {
  INFECTION_ACTION_LABEL,
  bandTone,
  cultureTone,
  infectionActionTone,
  preventionTone,
  adviseInfection,
  fetchInfectionAssurance,
  fetchInfectionMdr,
  fetchInfectionPrevention,
  fetchInfectionSafety,
  fetchInfectionSeparation,
  fetchInfectionState,
  fetchInfectionTwin,
  fetchInfectionValidation,
  infectionWhatIf,
  recordInfectionStudy,
  runInfectionRedTeam,
  snapshotInfectionDrift,
  type BsiAssessment,
  type InfectionCandidate,
  type InfectionPreventionPanel,
  type InfectionSafetyView,
  type InfectionSeparationView,
  type InfectionStateView,
  type InfectionTwinView,
  type InfectionValidationView,
  type InfectionAssuranceView,
  type InfectionWhatIfResult,
  type PreventionTask,
} from "../lib/infection";
import type { NavigationId } from "../lib/types";
import RankedActionsPanel from "./ranked-actions-panel";

type Props = { onNavigate?: (id: NavigationId) => void };

/** Tripwire colours for the culture contract. */
function CultureBanner({ status, turnaroundHours }: { status: string; turnaroundHours: number }) {
  const blocked = status === "none";
  return (
    <div className={`inf-contract ${blocked ? "is-blocking" : ""}`}>
      {blocked ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
      <div>
        <strong>
          {blocked
            ? "No culture on file — an antimicrobial discussion is refused."
            : `Culture on file (${status}).`}
        </strong>
        <p>
          Culture-before-antibiotic is a <strong>rule</strong>, not a preference: this platform proposes the cultures and
          the clinical review. It never names an antimicrobial, a dose or a duration, and it holds no prescribing
          authority. A result takes about {turnaroundHours} h to rule in.
        </p>
      </div>
    </div>
  );
}

/** The triage half: a scored, banded, driver-attributed suspicion — never a treatment. */
function TriageCard({ assessment, drivers, priorScore }: { assessment: BsiAssessment; drivers: Array<{ id: string; label: string; value: number; contribution: number; boundary?: string }>; priorScore?: number }) {
  const tone = bandTone(assessment.band);
  return (
    <div className="pc-panel inf-triage">
      <div className="pc-panel-head">
        <h2>
          <Thermometer size={15} /> BSI triage (statistical half)
        </h2>
        <span className="pc-inline pc-wrap">
          <Tag tone={tone}>{assessment.band}</Tag>
          <Tag tone={assessment.febrile ? "red" : "neutral"}>{assessment.febrile ? "febrile" : "afebrile"}</Tag>
          <Tag tone={cultureTone(assessment.culture.status)}>culture: {assessment.culture.status}</Tag>
          <Tag tone="neutral">{assessment.temperatureReadings} reading(s)</Tag>
        </span>
      </div>
      <div className="pc-kpis inf-kpis">
        <Metric label="Triage score" value={assessment.probability.toFixed(3)} detail="reference surrogate" tone={tone === "neutral" ? "default" : tone} />
        <Metric label="Peak temperature" value={assessment.measured.peakTemperatureC !== undefined ? `${assessment.measured.peakTemperatureC} °C` : "—"} detail={`latest ${assessment.measured.temperatureC ?? "—"} °C`} tone={assessment.febrile ? "red" : "mint"} />
        <Metric label="Procalcitonin" value={assessment.measured.procalcitoninNgMl !== undefined ? `${assessment.measured.procalcitoninNgMl} ng/mL` : "—"} detail=">0.5 watch, >2.0 high" />
        <Metric label="NLR" value={assessment.measured.nlr !== undefined ? String(assessment.measured.nlr) : "—"} detail=">6 is the sepsis-triage signal" />
        <Metric label="Catheter days" value={String(assessment.measured.catheterDays ?? 0)} detail=">90 days needs a necessity review" tone={(assessment.measured.catheterDays ?? 0) > 90 ? "amber" : "mint"} />
        {priorScore !== undefined ? <Metric label="Temperature rule" value={priorScore.toFixed(2)} detail="graded CDC/NHSN criteria (the baseline)" /> : null}
      </div>

      <Eyebrow>What the score is made of — largest contribution first</Eyebrow>
      <div className="inf-drivers">
        {drivers.slice(0, 8).map((d) => (
          <div className="inf-driver" key={d.id}>
            <span className="inf-driver-label">
              {d.label} <em>{d.value}</em>
            </span>
            <ProgressBar value={Math.min(100, Math.abs(d.contribution) * 300)} tone={d.contribution > 0.15 ? "red" : d.contribution > 0 ? "amber" : "blue"} />
            <span className="adq-mono">{d.contribution > 0 ? "+" : ""}{d.contribution}</span>
            {d.boundary ? <span className="inf-driver-boundary">{d.boundary}</span> : null}
          </div>
        ))}
      </div>

      <Eyebrow>Reference criteria that fired (CDC/NHSN)</Eyebrow>
      <div className="pc-inline pc-wrap">
        {assessment.criteria.map((c) => (
          <Tag key={c.id} tone={c.met ? "amber" : "neutral"}>
            {c.met ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} {c.id} · {c.detail}
          </Tag>
        ))}
      </div>
      <p className="adq-note">
        Both halves are shown side by side on purpose. The triage ranks suspicion from surveillance data; the prevention
        board below is computed from records and rules and does not read the triage score at all.
      </p>
    </div>
  );
}

/** The deterministic half: rule-referenced, due-dated, and explicitly model-free. */
function PreventionBoard({ panel }: { panel: InfectionPreventionPanel | null; }) {
  const tasks = panel?.plan.tasks ?? [];
  const pager = usePaged(tasks, 8);
  return (
    <div className="pc-panel inf-prevention">
      <div className="pc-panel-head">
        <h2>
          <Syringe size={15} /> Prevention board (deterministic half)
        </h2>
        <span className="pc-inline pc-wrap">
          <Tag tone="mint">
            <ShieldCheck size={11} /> no model involved
          </Tag>
          <Tag tone="neutral">{panel?.plan.overdueCount ?? 0} overdue / {panel?.plan.dueCount ?? 0} due</Tag>
        </span>
      </div>
      <p className="pc-sub inf-prevention-sub">
        Vaccination due-dates, series completion, serology follow-up, audit cadence and catheter-day escalation are
        state machines over the records. Re-running produces the identical plan — the signature below is the proof, and
        the governance gate re-checks it against a triage perturbation.
      </p>
      {panel ? (
        <>
          <div className="pc-inline pc-wrap inf-signature">
            <Tag tone="violet"><GitBranch size={11} /> signature</Tag>
            <code className="adq-mono">{panel.determinism.signature.slice(0, 96)}…</code>
            <Tag tone={panel.determinism.stable ? "mint" : "red"}>{panel.determinism.stable ? "stable across runs" : "UNSTABLE"}</Tag>
          </div>
          {tasks.length === 0 ? (
            <p className="adq-note">No immunisation, serology, audit or catheter-day obligation is outstanding.</p>
          ) : (
            <div className="inf-tasks">
              {pager.visible.map((t: PreventionTask) => (
                <div className={`inf-task ${t.overdue ? "is-overdue" : ""}`} key={t.id}>
                  <div className="inf-task-head">
                    <Tag tone={preventionTone(t)}>{t.kind}</Tag>
                    <strong>{t.label}</strong>
                    <span className="inf-task-due">
                      {t.overdue ? `overdue (due ${t.dueAt.slice(0, 10)})` : `due ${t.dueAt.slice(0, 10)}`} · {t.ownerRole}
                    </span>
                  </div>
                  <p className="inf-task-why">{t.because}</p>
                  <div className="pc-inline pc-wrap">
                    <Tag tone="neutral">{t.rule.ruleId}</Tag>
                    <Tag tone="neutral">{t.rule.source}</Tag>
                    <Tag tone="blue">{t.rule.threshold}</Tag>
                    <Tag tone="mint">deterministic · model-free</Tag>
                  </div>
                  <div className="pc-inline pc-wrap">
                    {t.rule.read.map((r) => (
                      <Tag key={`${t.id}-${r.record}`} tone="neutral">
                        {r.record} = {r.value}
                      </Tag>
                    ))}
                  </div>
                </div>
              ))}
              <LoadMore shown={pager.visible.length} total={tasks.length} onMore={pager.showMore} label="prevention task(s)" />
            </div>
          )}
        </>
      ) : (
        <p className="pc-loading">loading the prevention plan…</p>
      )}
    </div>
  );
}

/** What-if: every candidate labelled by the half that produced it, and the refusals. */
function WhatIfMatrix({ result }: { result: InfectionWhatIfResult }) {
  const rows = useMemo(
    () => [...result.candidates].sort((a, b) => (a.allowed === b.allowed ? a.score - b.score : a.allowed ? -1 : 1)),
    [result.candidates],
  );
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Action</span>
        <span>Half</span>
        <span>Triage 90 d</span>
        <span>Culture window</span>
        <span>Catheter days</span>
        <span>Expected harm</span>
      </div>
      {rows.map((c: InfectionCandidate) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>{c.deterministic ? `deterministic · ${c.ruleId ?? "rule"}` : `triage · burden ${c.burden}`}</em>
          </span>
          <span>
            <Tag tone={c.half === "prevention" ? "mint" : "amber"}>{c.half}</Tag>
          </span>
          <span className="adq-mono">{c.projected.probability}</span>
          <span className="adq-mono">{c.projected.cultureHours} h</span>
          <span className="adq-mono">{c.projected.catheterDays}</span>
          <span>
            <span className="pc-inline pc-wrap">
              <span className="adq-mono">{c.score}</span>
              {result.recommended === c ? <Tag tone="mint"><CheckCircle2 size={11} /> lowest harm</Tag> : null}
            </span>
          </span>
        </div>
      ))}
      <div className="inf-refused">
        <Eyebrow>Refused by design — the antimicrobial boundary</Eyebrow>
        {result.refused.map((r) => (
          <div className="inf-refused-row" key={r.action}>
            <Ban size={14} />
            <div>
              <strong>{r.label}</strong>
              <p>{r.refusedReason}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="adq-note">{result.note}</p>
    </div>
  );
}

export default function InfectionCds({ onNavigate }: Props) {
  const [state, setState] = useState<InfectionStateView | null>(null);
  const [assurance, setAssurance] = useState<InfectionAssuranceView | null>(null);
  const [validation, setValidation] = useState<InfectionValidationView | null>(null);
  const [safety, setSafety] = useState<InfectionSafetyView | null>(null);
  const [prevention, setPrevention] = useState<InfectionPreventionPanel | null>(null);
  const [separation, setSeparation] = useState<InfectionSeparationView | null>(null);
  const [advice, setAdvice] = useState<{
    action: string;
    note: string;
    assessment: BsiAssessment;
    drivers: Array<{ id: string; label: string; value: number; contribution: number; boundary?: string }>;
    priorScore: number;
    whatIf: InfectionWhatIfResult;
    trained?: { artifactId: string; probability: number; drivers: Array<{ feature: string; gain: number; share: number }> };
  } | null>(null);
  const [twin, setTwin] = useState<InfectionTwinView | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stateView, assuranceView, validationView, safetyView, separationView] = await Promise.all([
        fetchInfectionState(),
        fetchInfectionAssurance(),
        fetchInfectionValidation(),
        fetchInfectionSafety(),
        fetchInfectionSeparation(),
      ]);
      setState(stateView);
      setAssurance(assuranceView);
      setValidation(validationView);
      setSafety(safetyView);
      setSeparation(separationView);
      const first = stateView.windows[0]?.patientId ?? "";
      setSelected((current) => current || first);
      if (first) {
        setTwin(await fetchInfectionTwin(first));
        setPrevention(await fetchInfectionPrevention(first));
      } else {
        setPrevention(await fetchInfectionPrevention());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the infection pack");
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

  const runAdvice = useCallback(async (patientId: string, model: "reference" | "trained" = "reference") => {
    if (!patientId) return;
    setBusy("advice");
    try {
      const [response, whatIf, twinView, preventionPanel] = await Promise.all([
        adviseInfection({ patientId, model }),
        infectionWhatIf({ patientId }),
        fetchInfectionTwin(patientId),
        fetchInfectionPrevention(patientId),
      ]);
      setAdvice({
        action: response.recommendation.action,
        note: response.recommendation.note,
        assessment: response.assessment,
        drivers: response.recommendation.assessment.drivers,
        priorScore: response.priorScore,
        whatIf: whatIf.result,
        ...(response.trained ? { trained: response.trained } : {}),
      });
      setTwin(twinView);
      setPrevention(preventionPanel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "advise failed");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (selected) void runAdvice(selected);
  }, [selected, runAdvice]);

  const windowPager = usePaged(state?.windows ?? [], 8);
  const culturePager = usePaged(twin?.score.rows ?? [], 8);

  if (error && !state) return <EmptyView title="Infection pack unavailable" description={error} />;
  if (!state || !assurance) {
    return (
      <div className="pc-page">
        <div className="pc-loading">
          <RefreshCw className="is-spinning" size={16} /> loading infection / vaccination protocol pack…
        </div>
      </div>
    );
  }

  const artifact = validation?.report;
  const gate = assurance.gate;
  const cultureStatus = advice?.assessment.culture.status ?? safety?.probe.assessment.culture.status ?? "none";

  return (
    <div className="pc-page">
      <header className="pc-header">
        <div>
          <Eyebrow>P6 · infection &amp; vaccination · triage (statistical) + prevention (deterministic)</Eyebrow>
          <h1>Infection &amp; vaccination</h1>
          <p className="pc-sub">
            P6 answers a question in two halves, and the split is the design. The <strong>triage</strong> scores
            bloodstream-infection suspicion from serial temperatures, procalcitonin, NLR/WBC, access type and catheter
            days. The <strong>prevention</strong> half is a deterministic state machine over immunisation records,
            serology results, audit cadence and catheter days — it never reads a model, and it never waits for a fever.
            <strong> Blood cultures come before any antimicrobial discussion</strong>, and the platform names no drug, no
            dose and no duration.
          </p>
        </div>
        <div className="pc-actions">
          <button className="pc-btn" disabled={busy !== null} onClick={() => void load()}>
            <RefreshCw size={14} className={busy === "reload" ? "is-spinning" : ""} /> Refresh
          </button>
          <button
            className="pc-btn"
            disabled={busy !== null}
            onClick={() => void withAction("redteam", async () => {
              const result = await runInfectionRedTeam();
              return `Red team rt-037…rt-040: ${result.probes.filter((p) => p.passed).length}/${result.probes.length} probes pass (${result.passed ? "no findings" : "findings raised"}).`;
            })}
          >
            <ShieldAlert size={14} /> Red team
          </button>
          <button
            className="pc-btn"
            disabled={busy !== null}
            onClick={() => void withAction("drift", async () => {
              const { snapshot } = await snapshotInfectionDrift();
              return `Drift ${snapshot.metric}: KS ${snapshot.ksStatistic} — ${snapshot.verdict} (prevention separation ${snapshot.separation.deterministic && snapshot.separation.modelIndependent ? "intact" : "BROKEN"}).`;
            })}
          >
            <Activity size={14} /> Snapshot drift
          </button>
          <button
            className="pc-btn"
            disabled={busy !== null}
            onClick={() => void withAction("mdr", async () => {
              const document = await fetchInfectionMdr();
              setMdr(document.mdr);
              return "MDR file built from the live gate, artifact and acceptance criteria.";
            })}
          >
            <FileText size={14} /> Build MDR
          </button>
        </div>
      </header>

      {status ? <p className="pc-status">{status}</p> : null}
      {error ? <p className="pc-error">{error}</p> : null}

      <CultureBanner status={cultureStatus} turnaroundHours={safety?.cultureTurnaroundHours ?? 48} />

      <div className="pc-kpis">
        <Metric label="Patients tracked" value={String(state.kpis.patientsTracked)} detail={`${state.withSerialReadings} with ≥3 serial temperatures`} />
        <Metric label="Febrile" value={String(state.kpis.febrile)} detail={`${state.kpis.highBand} triaging in the high band`} tone={state.kpis.febrile ? "red" : "mint"} />
        <Metric label="Culture required first" value={String(state.kpis.cultureRequired)} detail="febrile with no culture on file" tone={state.kpis.cultureRequired ? "amber" : "mint"} />
        <Metric label="Catheters in situ" value={String(state.kpis.catheterInSitu)} detail={`${state.kpis.catheterEscalation} escalated for necessity review`} tone={state.kpis.catheterInSitu ? "amber" : "mint"} />
        <Metric label="Vaccination due" value={String(state.kpis.vaccinationDue)} detail={`${state.kpis.serologyFollowup} with a serology recheck`} tone={state.kpis.vaccinationDue ? "amber" : "mint"} />
        <Metric label="Prevention overdue" value={String(state.kpis.preventionOverdue)} detail="deterministic tasks past their date" tone={state.kpis.preventionOverdue ? "red" : "mint"} />
      </div>

      <RankedActionsPanel
        payload={state?.actions}
        protocol="infection"
        emptyHint="No triage band crossed an action threshold and no prevention task was due — vaccination, serology, hand-hygiene and access-care cadences are all current."
      />

      {/* ---------- A: triage + prevention, side by side ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <FlaskConical size={15} /> Patient window
            </h2>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="pc-select">
              {state.windows.map((w) => (
                <option key={w.patientId} value={w.patientId}>
                  {w.patientId} · {w.serialReadings} reading(s) · {w.recommendation.assessment.band} · {w.preventionOverdue} overdue
                </option>
              ))}
            </select>
          </div>
          {advice ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={infectionActionTone(advice.action as never)}>{INFECTION_ACTION_LABEL[advice.action as never] ?? advice.action}</Tag>
                <Tag tone={advice.assessment.febrile ? "red" : "mint"}>{advice.assessment.febrile ? "febrile" : "afebrile"}</Tag>
                <Tag tone={bandTone(advice.assessment.band)}>band {advice.assessment.band}</Tag>
                {advice.trained ? <Tag tone="violet">trained head {advice.trained.probability}</Tag> : null}
              </div>
              <p className="pc-sub">{advice.note}</p>
              <div className="inf-window-facts">
                <span>Temperature {advice.assessment.measured.temperatureC ?? "—"} °C (peak {advice.assessment.measured.peakTemperatureC ?? "—"})</span>
                <span>PCT {advice.assessment.measured.procalcitoninNgMl ?? "—"} ng/mL</span>
                <span>NLR {advice.assessment.measured.nlr ?? "—"}</span>
                <span>WBC {advice.assessment.measured.wbc ?? "—"} ×10³/µL</span>
                <span>Catheter days {advice.assessment.measured.catheterDays ?? 0}</span>
                <span>Culture {advice.assessment.culture.status}</span>
              </div>
            </>
          ) : (
            <p className="pc-loading">loading the window…</p>
          )}
        </div>

        <TriageCard
          assessment={advice?.assessment ?? safety!.probe.assessment}
          drivers={advice?.drivers ?? safety!.probe.assessment.drivers}
          priorScore={advice?.priorScore}
        />
      </section>

      <PreventionBoard panel={prevention} />

      {/* ---------- C: what-if + the refusals ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <GitBranch size={15} /> Plan counterfactual
          </h2>
          <span className="pc-inline pc-wrap">
            <Tag tone="neutral">missed culture {advice?.whatIf ? "weighted 3.0×" : "—"}</Tag>
            <Tag tone="neutral">delayed treatment weighted 2.2×</Tag>
            <Tag tone="neutral">unecessary isolation 0.5×</Tag>
          </span>
        </div>
        {advice?.whatIf ? <WhatIfMatrix result={advice.whatIf} /> : <p className="pc-loading">loading the counterfactual…</p>}
        {advice?.whatIf ? (
          <>
            <Eyebrow>Deterministic prevention schedule (no model input)</Eyebrow>
            <div className="pc-inline pc-wrap">
              <Tag tone="mint">≤30 d: {advice.whatIf.prevention.counts.at30}</Tag>
              <Tag tone="amber">≤90 d: {advice.whatIf.prevention.counts.at90}</Tag>
              <Tag tone="blue">≤180 d: {advice.whatIf.prevention.counts.at180}</Tag>
              <Tag tone="red">overdue: {advice.whatIf.prevention.counts.overdue}</Tag>
              <Tag tone="violet">{advice.whatIf.prevention.modelFree ? "model-free" : "MODEL PRESENT"}</Tag>
            </div>
          </>
        ) : null}
      </section>

      {/* ---------- D: twin over the real ledger ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Activity size={15} /> Twin over the ledger
            </h2>
            {twin ? <span className="pc-inline pc-wrap"><Tag tone="neutral">{twin.twin.provenance.temperatureEvents} temps</Tag><Tag tone="neutral">{twin.twin.provenance.cultureResults} cultures</Tag><Tag tone="neutral">{twin.twin.provenance.immunisationEvents} immunisations</Tag></span> : null}
          </div>
          {twin ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={twin.score.verdict === "pass" ? "mint" : twin.score.verdict === "insufficient" ? "neutral" : "amber"}>
                  triage {twin.score.verdict}
                </Tag>
                <Tag tone="neutral">AUROC {twin.score.auroc ?? "—"} (target {twin.score.targetAuroc})</Tag>
                <Tag tone="neutral">Brier {twin.score.brier ?? "—"}</Tag>
                <Tag tone="neutral">{twin.score.positives}/{twin.score.cultureRows} positive</Tag>
                <Tag tone={twin.stability.stable && twin.stability.modelIndependent ? "mint" : "red"}>
                  prevention {twin.stability.stable && twin.stability.modelIndependent ? "stable & model-independent" : "UNSTABLE"}
                </Tag>
              </div>
              <p className="adq-note">{twin.score.note}</p>
              <p className="adq-note">{twin.stability.note}</p>
              <Eyebrow>Prospectively scored cultures</Eyebrow>
              <div className="inf-cultures">
                {culturePager.visible.map((c) => (
                  <div className={`inf-culture ${c.label === 1 ? "is-positive" : ""}`} key={c.at}>
                    <span className="adq-mono">{c.at.slice(0, 10)}</span>
                    <Tag tone={c.label === 1 ? "red" : "mint"}>{c.label === 1 ? "positive" : "no growth"}</Tag>
                    <span className="adq-mono">score {c.score}</span>
                    <Tag tone={bandTone(c.band)}>{c.band}</Tag>
                    <span className="inf-culture-meta">{c.readings} readings{c.observedTemperatureC !== undefined ? ` · peak ${c.observedTemperatureC} °C` : ""}</span>
                  </div>
                ))}
              </div>
              <LoadMore shown={culturePager.visible.length} total={twin.score.rows.length} onMore={culturePager.showMore} label="culture(s)" />
            </>
          ) : (
            <p className="pc-loading">loading the twin…</p>
          )}
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <ShieldCheck size={15} /> Separation &amp; governance
            </h2>
            <Tag tone={gate.status === "active" ? "mint" : gate.status === "blocked" ? "red" : "amber"}>{gate.status}</Tag>
          </div>
          {separation ? (
            <>
              <p className="pc-sub">{separation.claim}</p>
              <div className="pc-inline pc-wrap">
                <Tag tone={separation.separation.deterministic ? "mint" : "red"}>deterministic: {String(separation.separation.deterministic)}</Tag>
                <Tag tone={separation.separation.modelIndependent ? "mint" : "red"}>model-independent: {String(separation.separation.modelIndependent)}</Tag>
                <Tag tone="neutral">{separation.separation.taskCount} task(s)</Tag>
              </div>
              <div className="pc-inline pc-wrap">
                {separation.separation.ruleIds.map((r) => <Tag key={r} tone="neutral">{r}</Tag>)}
              </div>
            </>
          ) : null}
          <Eyebrow>Activation gate</Eyebrow>
          <div className="pc-inline pc-wrap">
            {gate.gates.map((g) => (
              <Tag key={g.name} tone={g.passed ? "mint" : "red"}>
                {g.passed ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} {g.name}
              </Tag>
            ))}
          </div>
          <Eyebrow>Red team rt-037…rt-040</Eyebrow>
          <div className="inf-scenarios">
            {assurance.redTeam.scenarios.map((s) => (
              <div className={`inf-scenario ${s.probe.passed ? "" : "is-failing"}`} key={s.id}>
                <div className="inf-task-head">
                  <Tag tone={s.probe.passed ? "mint" : "red"}>{s.id}</Tag>
                  <strong>{s.name}</strong>
                </div>
                <p className="inf-task-why">{s.probeLabel}</p>
                <div className="pc-inline pc-wrap">
                  {s.probe.checks.map((c) => (
                    <Tag key={`${s.id}-${c.name}`} tone={c.passed ? "mint" : "red"}>{c.passed ? "✓" : "✗"} {c.name}</Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="pc-inline pc-wrap">
            <Tag tone={assurance.openFindings ? "red" : "mint"}>{assurance.openFindings} open finding(s)</Tag>
            <Tag tone="neutral">{assurance.drift.length} drift snapshot(s)</Tag>
            <Tag tone="red">antimicrobial authority: none</Tag>
          </div>
        </div>
      </section>

      {/* ---------- E/F: artifact, validation, MDR ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <FlaskConical size={15} /> Trained triage head &amp; validation
          </h2>
          {artifact ? (
            <span className="pc-inline pc-wrap">
              <Tag tone={artifact.acceptanceMet ? "mint" : "amber"}>{artifact.acceptanceMet ? "acceptance met" : "acceptance not met"}</Tag>
              <Tag tone="neutral">{artifact.artifactId}</Tag>
            </span>
          ) : null}
        </div>
        {artifact ? (
          <>
            <div className="pc-kpis inf-kpis">
              <Metric label="AUROC" value={String(artifact.classifier?.auroc ?? "—")} detail={`temperature-rule prior ${artifact.priorAuroc ?? "—"} (gain ${artifact.aurocGain ?? "—"})`} tone={(artifact.classifier?.auroc ?? 0) >= 0.85 ? "mint" : "amber"} />
              <Metric label="Brier" value={String(artifact.classifier?.brier ?? "—")} detail="proper score; lower is better" />
              <Metric label="ECE" value={String(artifact.classifier?.ece ?? "—")} detail="calibration gap" />
              <Metric label="Rows / patients" value={`${artifact.rows} / ${artifact.patients}`} detail="patient-level split, no leakage" />
            </div>
            <Eyebrow>Acceptance criteria</Eyebrow>
            <div className="inf-criteria">
              {artifact.criteria.map((c) => (
                <div className={`inf-criterion ${c.met ? "" : "is-unmet"}`} key={c.criterion}>
                  <span>{c.met ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}</span>
                  <strong>{c.criterion}</strong>
                  <em>{c.target}</em>
                  <code className="adq-mono">{typeof c.observed === "object" ? JSON.stringify(c.observed) : String(c.observed)}</code>
                </div>
              ))}
            </div>
            {artifact.generatorAudit ? (
              <>
                <Eyebrow>Per-generator audit (score vs observed)</Eyebrow>
                <div className="pc-inline pc-wrap">
                  {artifact.generatorAudit.map((g) => (
                    <Tag key={g.generator} tone={Math.abs(g.observedRate - g.meanScore) <= 0.15 ? "mint" : "amber"}>
                      {g.generator}: {g.meanScore} vs {g.observedRate} (n={g.rows})
                    </Tag>
                  ))}
                </div>
              </>
            ) : null}
            <p className="adq-note">{artifact.note}</p>
            <p className="adq-note">{artifact.benchmarkNote}</p>
          </>
        ) : (
          <p className="pc-loading">loading the validation report…</p>
        )}
      </section>

      {/* ---------- governance: settings, drift, safety contract ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head"><h2><ShieldAlert size={15} /> Culture contract</h2></div>
          {safety ? (
            <>
              <div className="inf-rules">
                {safety.rules.map((r) => (
                  <div className="inf-rule" key={r}>{r}</div>
                ))}
              </div>
              <Eyebrow>Refused unconditionally</Eyebrow>
              <div className="pc-inline pc-wrap">
                {safety.refused.map((r) => <Tag key={r.action} tone="red"><Ban size={11} /> {r.label}</Tag>)}
              </div>
            </>
          ) : <p className="pc-loading">loading…</p>}
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2><Syringe size={15} /> Immunisation schedule applied</h2>
          </div>
          {prevention ? (
            <>
              <div className="inf-schedule">
                {prevention.plan.schedule.map((s) => (
                  <div className="inf-schedule-row" key={s.vaccine}>
                    <strong>{s.label}</strong>
                    <em>every {s.intervalDays} d · {s.seriesDoses} dose(s)</em>
                  </div>
                ))}
              </div>
              <Eyebrow>Rules the engine applied</Eyebrow>
              <div className="inf-rules">
                {prevention.rules.map((r) => <div className="inf-rule" key={r}>{r}</div>)}
              </div>
              <button
                className="pc-btn"
                disabled={busy !== null}
                onClick={() => void withAction("prevention", async () => {
                  const panel = await fetchInfectionPrevention(selected || undefined);
                  setPrevention(panel);
                  return `Prevention re-run: ${panel.plan.tasks.length} task(s), signature ${panel.determinism.stable ? "unchanged" : "CHANGED"}.`;
                })}
              >
                <RefreshCw size={13} /> Re-run planner
              </button>
            </>
          ) : <p className="pc-loading">loading…</p>}
        </div>
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>Live patient windows</h2>
          <span className="pc-inline pc-wrap"><Tag tone="neutral">{state.source}</Tag><Tag tone="neutral">{state.windows.length} patient(s)</Tag></span>
        </div>
        <div className="inf-windows">
          {windowPager.visible.map((w) => (
            <div className="inf-window-row" key={w.patientId}>
              <button className="pc-link" onClick={() => setSelected(w.patientId)}>{w.patientId}</button>
              <Tag tone={bandTone(w.recommendation.assessment.band)}>{w.recommendation.assessment.band}</Tag>
              <span className="adq-mono">{w.recommendation.assessment.probability}</span>
              <span className="inf-culture-meta">{w.serialReadings} reading(s) · {w.recommendation.current.accessType ?? "—"} · culture {w.recommendation.assessment.culture.status}</span>
              <Tag tone={w.coverage.covered ? "mint" : "amber"}>{w.coverage.covered ? "covered" : "below coverage"}</Tag>
              <Tag tone={w.preventionOverdue ? "red" : "neutral"}>{w.preventionOverdue} overdue</Tag>
              <button
                className="pc-btn"
                disabled={busy !== null}
                onClick={() => void withAction(`study-${w.patientId}`, async () => {
                  await recordInfectionStudy({ patientId: w.patientId, action: "accept" });
                  return `Recorded the clinician disposition for ${w.patientId}.`;
                })}
              >
                Record disposition
              </button>
            </div>
          ))}
        </div>
        <LoadMore shown={windowPager.visible.length} total={state.windows.length} onMore={windowPager.showMore} label="patient window(s)" />
      </section>

      {mdr ? (
        <section className="pc-panel">
          <div className="pc-panel-head"><h2><FileText size={15} /> MDR file</h2></div>
          <pre className="adq-mono inf-mdr">{JSON.stringify(mdr, null, 2).slice(0, 4000)}</pre>
        </section>
      ) : null}
    </div>
  );
}
