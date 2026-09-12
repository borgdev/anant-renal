"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  GitBranch,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  TrendingUp,
  Waves,
} from "lucide-react";
import { EmptyView, Eyebrow, Metric, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import {
  ACCESS_ACTION_LABEL,
  accessActionTone,
  adviseAccess,
  fetchAccessAcoustic,
  fetchAccessAssurance,
  fetchAccessMdr,
  fetchAccessState,
  fetchAccessTwin,
  fetchAccessValidation,
  recordAccessStudy,
  runAccessRedTeam,
  snapshotAccessDrift,
  stenosisTone,
  type AccessAcousticView,
  type AccessAssuranceView,
  type AccessCandidate,
  type AccessStateView,
  type AccessTwinView,
  type AccessValidationView,
  type AccessWhatIfResult,
} from "../lib/access";
import type { NavigationId } from "../lib/types";
import RankedActionsPanel from "./ranked-actions-panel";

type Props = { onNavigate?: (id: NavigationId) => void };

const HORIZONS = [30, 90];

/** Δ-from-baseline trend strip: venous pressure % and the predicted stenosis probability. */
function TrendBar({ deltaPct, probability }: { deltaPct?: number | undefined; probability?: number | undefined }) {
  const width = Math.max(0, Math.min(100, Math.abs(deltaPct ?? 0)));
  return (
    <div className="ax-trend">
      <ProgressBar value={width} tone={stenosisTone(probability) === "neutral" ? "blue" : stenosisTone(probability) as "mint" | "amber" | "red" | "blue"} />
      <span className={`adq-mono is-${stenosisTone(probability)}`}>
        {deltaPct === undefined ? "—" : `${deltaPct > 0 ? "+" : ""}${deltaPct}%`}
      </span>
    </div>
  );
}

/** Surveillance × referral counterfactual with both thrombosis horizons. */
function PlanTable({ result }: { result: AccessWhatIfResult }) {
  const rows = useMemo(
    () => [...result.candidates].sort((a, b) => a.surveillanceIntervalDays - b.surveillanceIntervalDays || (a.arm === "refer-now" ? -1 : 1)),
    [result.candidates],
  );
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Plan</span>
        <span>P(throm) 30 d</span>
        <span>P(throm) 90 d</span>
        <span>Projected stenosis</span>
        <span>Detection delay</span>
        <span>Status</span>
      </div>
      {rows.map((c: AccessCandidate) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>
              {c.arm === "refer-now" ? "referral proposed" : "no imaging"} · burden {c.procedureBurden} · score {c.score}
            </em>
          </span>
          <span className="adq-mono">{c.thrombosisRiskByHorizon["30"] ?? "—"}</span>
          <span className="adq-mono">{c.thrombosisRiskByHorizon["90"] ?? "—"}</span>
          <span className="adq-mono">{c.projectedStenosisProbability}</span>
          <span className="adq-mono">{c.detectionDelayDays} d</span>
          <span>
            {!c.allowed ? (
              <Tag tone="red">
                <AlertTriangle size={11} /> {c.blockedReason ?? "guardrail"}
              </Tag>
            ) : result.recommended === c ? (
              <Tag tone="mint">
                <CheckCircle2 size={11} /> safest viable
              </Tag>
            ) : (
              <Tag tone="neutral">available</Tag>
            )}
          </span>
        </div>
      ))}
      <p className="adq-note">{result.note}</p>
    </div>
  );
}

export default function AccessCds({ onNavigate }: Props) {
  const [state, setState] = useState<AccessStateView | null>(null);
  const [assurance, setAssurance] = useState<AccessAssuranceView | null>(null);
  const [validation, setValidation] = useState<AccessValidationView | null>(null);
  const [acoustic, setAcoustic] = useState<AccessAcousticView | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [advice, setAdvice] = useState<{
    recommendation: AccessStateView["windows"][number]["recommendation"];
    whatIf: AccessWhatIfResult;
    riskSurface: Array<{ intervalDays: number; surveillanceOnly: number; surveillanceOnly30d: number; referNow: number }>;
  } | null>(null);
  const [twin, setTwin] = useState<AccessTwinView | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stateView, assuranceView, validationView, acousticView] = await Promise.all([
        fetchAccessState(),
        fetchAccessAssurance(),
        fetchAccessValidation(),
        fetchAccessAcoustic(),
      ]);
      setState(stateView);
      setAssurance(assuranceView);
      setValidation(validationView);
      setAcoustic(acousticView);
      const first = stateView.windows[0]?.patientId ?? "";
      setSelected((current) => current || first);
      if (first) setTwin(await fetchAccessTwin(first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the access pack");
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
      const [response, twinView] = await Promise.all([
        adviseAccess({ patientId, model }),
        fetchAccessTwin(patientId),
      ]);
      const surface = await (await fetch(`/admin/swarm/access/what-if`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId }),
      })).json() as { riskSurface: Array<{ intervalDays: number; surveillanceOnly: number; surveillanceOnly30d: number; referNow: number }> };
      setAdvice({ recommendation: response.recommendation, whatIf: response.whatIf, riskSurface: surface.riskSurface ?? [] });
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
  const twinPager = usePaged(twin?.twin.observations ?? [], 8);

  if (error && !state) return <EmptyView title="Vascular access pack unavailable" description={error} />;
  if (!state || !assurance) {
    return (
      <div className="pc-page">
        <div className="pc-loading">
          <RefreshCw className="is-spinning" size={16} /> loading vascular access protocol pack…
        </div>
      </div>
    );
  }

  const drift = twin?.drift;
  const recommendation = advice?.recommendation;

  return (
    <div className="pc-page">
      <header className="pc-header">
        <div>
          <Eyebrow>P3 · vascular access · stenosis surveillance &amp; referral</Eyebrow>
          <h1>Vascular access</h1>
          <p className="pc-sub">
            Longitudinal pressure / flow / recirculation observer with a Δ-from-baseline stenosis model and a
            surveillance-versus-imaging counterfactual. The audio path (mel-spectrogram features) is implemented behind
            a flag with provenance and synthetic labelling, and is <strong>off</strong> by default. Referrals are
            proposals for the access team — the platform never books a procedure.
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

      <div className="pc-kpis">
        <Metric label="Accesses tracked" value={String(state.kpis.accessesTracked)} detail={`${state.kpis.observations} surveillance observations`} />
        <Metric label="Measured series" value={String(state.withMeasuredSeries)} detail="pressure/flow series with a computable baseline" />
        <Metric label="Referrals proposed" value={String(state.kpis.referralProposed)} detail="all human-approved (Class C)" tone={state.kpis.referralProposed ? "amber" : "mint"} />
        <Metric label="Catheter accesses" value={String(state.kpis.catheterAccesses)} detail="deterministic catheter-day rules, not the model" tone="mint" />
        <Metric label="Coverage-blocked" value={String(state.kpis.coverageBlocked)} detail="fewer than 3 measured observations, or stale" tone={state.kpis.coverageBlocked ? "amber" : "mint"} />
        <Metric label="Advisor gate" value={assurance.gate.status} detail={`${assurance.model.artifact.id ?? "prior only"} · band ${assurance.model.artifact.band}`} tone={assurance.gate.status === "active" ? "mint" : "amber"} />
      </div>

      <RankedActionsPanel
        payload={state?.actions}
        protocol="access"
        emptyHint="Access referrals need serial Δ-from-baseline observations. Windows below the coverage gate (fewer than the required measurements) produce no action — that is the gate, not an oversight."
      />

      {/* ---------- A/C: advisor + counterfactual ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Stethoscope size={15} /> Access advisor
            </h2>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="pc-select">
              {state.windows.map((w) => (
                <option key={w.patientId} value={w.patientId}>
                  {w.patientId} · {Math.round((w.recommendation.stenosisProbability ?? 0) * 100)}% stenosis
                </option>
              ))}
            </select>
          </div>

          {recommendation ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={accessActionTone(recommendation.action)}>{ACCESS_ACTION_LABEL[recommendation.action]}</Tag>
                <Tag tone={recommendation.guardrails.referralAllowed ? "amber" : "neutral"}>
                  referral {recommendation.guardrails.referralAllowed ? "permitted" : "not permitted"}
                </Tag>
                {recommendation.guardrails.escalateNow ? <Tag tone="red">escalate now</Tag> : null}
                <Tag tone="neutral">{recommendation.model.kind}</Tag>
              </div>

              <div className="ax-probability">
                <span className="ax-probability-label">
                  <HeartPulse size={13} /> P(≥50% stenosis)
                </span>
                <strong className={`is-${stenosisTone(recommendation.stenosisProbability)}`}>
                  {Math.round(recommendation.stenosisProbability * 100)}%
                </strong>
                <div className="ax-probability-bars">
                  {HORIZONS.map((h) => (
                    <span key={h}>
                      <em>P(thrombosis) {h} d</em>
                      <ProgressBar value={Math.round((recommendation.thrombosisRiskByHorizon[String(h)] ?? 0) * 100)} tone={h === 30 ? "amber" : "red"} />
                      <b className="adq-mono">{recommendation.thrombosisRiskByHorizon[String(h)] ?? "—"}</b>
                    </span>
                  ))}
                </div>
              </div>

              <div className="adq-facts">
                <span>
                  <em>Access</em>
                  <strong>{recommendation.current.accessType ?? "—"} · {recommendation.current.accessAgeDays ?? "—"} d</strong>
                </span>
                <span>
                  <em>Venous pressure</em>
                  <strong className={(recommendation.current.venousPressureDeltaPct ?? 0) >= 25 ? "is-red" : "is-mint"}>
                    {recommendation.current.venousPressureMmHg ?? "—"} mmHg ({recommendation.current.venousPressureDeltaPct ?? 0}%)
                  </strong>
                </span>
                <span>
                  <em>Recirculation</em>
                  <strong className={(recommendation.current.recirculationPct ?? 0) > 10 ? "is-amber" : "is-mint"}>
                    {recommendation.current.recirculationPct ?? "—"}%
                  </strong>
                </span>
                <span>
                  <em>Access flow (Qa)</em>
                  <strong className={(recommendation.current.accessFlowDeltaPct ?? 0) <= -25 ? "is-red" : "is-mint"}>
                    {recommendation.current.accessFlowMlMin ?? "—"} mL/min ({recommendation.current.accessFlowDeltaPct ?? 0}%)
                  </strong>
                </span>
                <span>
                  <em>Cannulation</em>
                  <strong>{recommendation.current.cannulationDifficulty ?? "—"}</strong>
                </span>
                <span>
                  <em>Observations</em>
                  <strong>{recommendation.current.observations}</strong>
                </span>
              </div>

              <p className="adq-note">{recommendation.note}</p>

              {recommendation.guardrails.flags.length ? (
                <div className="pc-inline pc-wrap">
                  {recommendation.guardrails.flags.map((f) => (
                    <Tag key={f} tone={f.includes("post-intervention") || f.includes("catheter") ? "amber" : "neutral"}>
                      {f.replace(/-/g, " ")}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {advice?.riskSurface?.length ? (
                <div className="pc-bars">
                  <span className="pc-panel-note">projected 30-day thrombosis risk by surveillance interval</span>
                  {advice.riskSurface.map((s) => (
                    <div className="pc-bar-row" key={s.intervalDays}>
                      <span className="pc-bar-label">{s.intervalDays} d</span>
                      <ProgressBar value={Math.round(s.surveillanceOnly30d * 100)} tone="amber" />
                      <span className="adq-mono">{s.surveillanceOnly30d}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="pc-inline pc-wrap">
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("accept", async () => { await recordAccessStudy({ patientId: recommendation.patientId, action: "accept", clinician: "access-nurse" }); return "study record saved: referral accepted"; })}>
                  <CheckCircle2 size={13} /> Accept referral
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("modify", async () => { await recordAccessStudy({ patientId: recommendation.patientId, action: "modify", clinician: "access-nurse" }); return "study record saved: modified"; })}>
                  <Activity size={13} /> Record modify
                </button>
              </div>
            </>
          ) : (
            <div className="pc-loading">
              <RefreshCw size={14} className="is-spinning" /> scoring…
            </div>
          )}
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Waves size={15} /> Surveillance vs referral
            </h2>
            <span className="pc-panel-note">intervals 14/28/56/84 d · horizons 30/90 d · referral requires a measured trend</span>
          </div>
          {advice ? <PlanTable result={advice.whatIf} /> : null}
        </div>
      </section>

      {/* ---------- D: Δ-from-baseline twin ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <GitBranch size={15} /> Access twin — Δ from the patient&apos;s own baseline
          </h2>
          <span className="pc-panel-note">
            {twin ? `${twin.twin.summary.measured} measured observation(s) · ${twin.twin.summary.interventions} intervention(s) · ${twin.twin.summary.thromboses} thrombosis · provenance ${twin.twin.provenance.attributedBy}` : ""}
          </span>
        </div>

        {drift ? (
          <div className="pc-inline pc-wrap">
            <Tag tone={drift.verdict === "pass" ? "mint" : drift.verdict === "watch" ? "amber" : "neutral"}>verdict: {drift.verdict}</Tag>
            <Tag tone="neutral">AUROC {drift.auroc ?? "—"} (target ≥{drift.targetAuroc})</Tag>
            <Tag tone="neutral">observed {Math.round(drift.observedRate * 100)}% vs predicted {Math.round(drift.meanPredicted * 100)}%</Tag>
            {drift.leadTimeDays !== undefined ? <Tag tone="blue">mean lead {drift.leadTimeDays} d</Tag> : null}
          </div>
        ) : null}
        {drift ? <p className="adq-note">{drift.note}</p> : null}

        {twin && twin.twin.observations.length ? (
          <div className="adq-candidates">
            <div className="adq-cand-head">
              <span>Observation</span>
              <span>Venous pressure</span>
              <span>Δ pressure</span>
              <span>Qa / Δ Qa</span>
              <span>Recirc</span>
              <span>Outcome</span>
            </div>
            {twinPager.visible.map((o, index) => (
              <div className="adq-cand-row" key={`${o.at}-${index}`}>
                <span className="adq-cand-label">
                  <strong>{o.event.replace(/-/g, " ")}</strong>
                  <em>{o.at ? new Date(o.at).toLocaleString() : "—"}</em>
                </span>
                <span className="adq-mono">{o.venousPressureMmHg ?? "—"}</span>
                <TrendBar deltaPct={o.venousPressureDeltaPct} probability={o.stenosisProbability} />
                <span className="adq-mono">
                  {o.accessFlowMlMin ?? "—"} / {o.accessFlowDeltaPct ?? "—"}%
                </span>
                <span className="adq-mono">{o.recirculationPct ?? "—"}%</span>
                <span>
                  <Tag tone={o.outcome ? "red" : "mint"}>{o.outcome ? o.outcomeEvent ?? "intervention" : "no outcome"}</Tag>
                  {o.stenosisProbability !== undefined ? <em className="adq-sym"> p={o.stenosisProbability}</em> : null}
                </span>
              </div>
            ))}
            <LoadMore shown={twinPager.visible.length} total={twin.twin.observations.length} onMore={twinPager.showMore} label="observations" />
          </div>
        ) : (
          <EmptyView title="No measured observations yet" description="The access twin needs surveillance observations with pressure/flow measurements (access.observed.v1) before it can score a stenosis trajectory." />
        )}
      </section>

      {/* ---------- live windows ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Live accesses — ledger windows
          </h2>
          <span className="pc-panel-note">{state.source}</span>
        </div>
        <div className="adq-candidates">
          <div className="adq-cand-head">
            <span>Patient</span>
            <span>Venous pressure</span>
            <span>Δ pressure</span>
            <span>Recirc / Qa</span>
            <span>Action</span>
            <span>Coverage</span>
          </div>
          {windowPager.visible.map((w) => (
            <div className="adq-cand-row" key={w.patientId}>
              <span className="adq-cand-label">
                <strong>{w.patientId}</strong>
                <em>
                  {w.__displayFacility ?? "—"} · {w.recommendation.current.accessType ?? "—"} · {w.acousticCaptures} acoustic capture(s)
                </em>
              </span>
              <span className="adq-mono">{w.recommendation.current.venousPressureMmHg ?? "—"}</span>
              <TrendBar deltaPct={w.recommendation.current.venousPressureDeltaPct} probability={w.recommendation.stenosisProbability} />
              <span className="adq-mono">
                {w.recommendation.current.recirculationPct ?? "—"}% / {w.recommendation.current.accessFlowMlMin ?? "—"}
              </span>
              <span>
                <Tag tone={accessActionTone(w.recommendation.action)}>{ACCESS_ACTION_LABEL[w.recommendation.action]}</Tag>
              </span>
              <span>
                <Tag tone={w.coverage.covered ? "mint" : "amber"}>{w.coverage.covered ? "covered" : w.coverage.reason ?? "out of domain"}</Tag>
              </span>
            </div>
          ))}
          <LoadMore shown={windowPager.visible.length} total={state.windows.length} onMore={windowPager.showMore} label="windows" />
        </div>
      </section>

      {/* ---------- B / E / F: governance, audio flag, artifact, MDR ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <ShieldCheck size={15} /> Governance &amp; assurance
            </h2>
            {assurance.model.artifact.note ? <span className="pc-panel-note">{assurance.model.artifact.note}</span> : null}
          </div>

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

          {acoustic ? (
            <div className="ax-audio">
              <div className="pc-inline pc-wrap">
                <Tag tone={acoustic.enabled ? "amber" : "neutral"}>
                  {acoustic.flag} {acoustic.enabled ? "enabled" : "disabled"}
                </Tag>
                <Tag tone="neutral">{acoustic.eventKind}</Tag>
                <Tag tone="blue">{acoustic.capturesOnLedger} capture(s) on the ledger</Tag>
                <Tag tone="mint">synthetic feature vectors only — never audio</Tag>
              </div>
              <ul className="ax-audio-gates">
                {acoustic.gating.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
              <p className="adq-note">{acoustic.note}</p>
            </div>
          ) : null}

          <div className="pc-inline pc-wrap">
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("red-team", async () => { const r = await runAccessRedTeam(); return `red team: ${r.probes.filter((p) => p.passed).length}/${r.probes.length} probes contained`; })}>
              <ShieldCheck size={13} /> Run rt-025..028
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("drift", async () => { const r = await snapshotAccessDrift(); return `drift: ${r.snapshot.verdict} (KS ${r.snapshot.ksStatistic})`; })}>
              <TrendingUp size={13} /> Drift snapshot
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("mdr", async () => { const r = await fetchAccessMdr(); setMdr(r.mdr); return "MDR technical file materialised"; })}>
              <FileText size={13} /> Build MDR file
            </button>
          </div>
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <FileText size={15} /> Artifact &amp; acceptance
            </h2>
            <span className="pc-panel-note">
              {assurance.model.artifact.present ? `${assurance.model.artifact.id} v${assurance.model.artifact.version}` : "no artifact"}
            </span>
          </div>

          {assurance.model.artifact.present ? (
            <>
              <div className="adq-facts">
                <span>
                  <em>Longitudinal AUROC</em>
                  <strong className={assurance.model.artifact.meetsLongitudinalTarget ? "is-mint" : "is-red"}>
                    {assurance.model.artifact.metrics?.longitudinalOnlyAuroc ?? "—"}
                  </strong>
                </span>
                <span>
                  <em>Prior AUROC</em>
                  <strong>{assurance.model.artifact.metrics?.priorAuroc ?? "—"}</strong>
                </span>
                <span>
                  <em>Δ-only logistic</em>
                  <strong>{assurance.model.artifact.metrics?.baselineAuroc ?? "—"}</strong>
                </span>
                <span>
                  <em>Brier / ECE</em>
                  <strong>
                    {assurance.model.artifact.metrics?.brier ?? "—"} / {assurance.model.artifact.metrics?.ece ?? "—"}
                  </strong>
                </span>
                <span>
                  <em>Rows / patients</em>
                  <strong>
                    {assurance.model.artifact.rows ?? 0} / {assurance.model.artifact.patients ?? 0}
                  </strong>
                </span>
                <span>
                  <em>Acoustic captures used</em>
                  <strong className="is-mint">{assurance.model.artifact.acoustic?.captures ?? 0}</strong>
                </span>
              </div>

              {assurance.model.artifact.attribution?.length ? (
                <div className="pc-bars">
                  {assurance.model.artifact.attribution.slice(0, 6).map((a) => (
                    <div className="pc-bar-row" key={a.feature}>
                      <span className="pc-bar-label">{a.feature}</span>
                      <ProgressBar value={a.share * 100} />
                      <span className="adq-mono">{(a.share * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyView title="No trained artifact" description="Train with `npx tsx scripts/train-access-model.ts`; until then the mechanistic stenosis prior serves recommendations." />
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
              <p className="adq-note">{validation.report.benchmarkNote}</p>
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
