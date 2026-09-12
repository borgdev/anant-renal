"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Beaker,
  CheckCircle2,
  FileText,
  FlaskConical,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingDown,
  TrendingUp,
  Waves,
} from "lucide-react";
import { EmptyView, Eyebrow, Metric, PanelExpand, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import {
  ADEQUACY_ACTION_LABEL,
  adviseAdequacy,
  fetchAdequacyAssurance,
  fetchAdequacyFeatures,
  fetchAdequacyMdr,
  fetchAdequacyQip,
  fetchAdequacyState,
  fetchAdequacyTwin,
  fetchAdequacyValidation,
  runAdequacyRedTeam,
  runAdequacyValidation,
  seedAdequacyDemo,
  resetAdequacyDemo,
  snapshotAdequacyDrift,
  type AdequacyAssuranceView,
  type AdequacyCandidate,
  type AdequacyFeaturesView,
  type AdequacyRecommendation,
  type AdequacyStateView,
  type AdequacyTwinView,
  type AdequacyValidationView,
  type AdequacyWhatIfResult,
  type QipTieInView,
} from "../lib/adequacy";
import type { NavigationId } from "../lib/types";
import RankedActionsPanel from "./ranked-actions-panel";

type Props = { onNavigate?: (id: NavigationId) => void };

const actionTone = (action: AdequacyRecommendation["action"]) =>
  action === "blocked" || action === "adherence-first" ? "red" : action === "hold" ? "mint" : action === "review-access" ? "amber" : "blue";

const bandTone = (inBand: boolean, hasValue: boolean) => (!hasValue ? "neutral" : inBand ? "mint" : "amber");

/** Prescription simulator matrix: clearance AND hypotension risk side by side. */
function CandidateTable({ result }: { result: AdequacyWhatIfResult }) {
  const rows = useMemo(
    () => [...result.candidates].sort((a, b) => a.minutesDelta - b.minutesDelta || a.qbDelta - b.qbDelta),
    [result.candidates],
  );
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Prescription</span>
        <span>Expected spKt/V</span>
        <span>Expected URR</span>
        <span>IDH risk</span>
        <span>Trade-off</span>
        <span>Status</span>
      </div>
      {rows.map((c) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>
              {c.prescriptionMinutes} min{c.prescriptionQb ? ` · Qb ${c.prescriptionQb}` : ""}
            </em>
          </span>
          <span className="adq-mono">{c.expectedSpKtV ?? "—"}</span>
          <span className="adq-mono">{c.expectedUrrPct ?? "—"}%</span>
          <span className="adq-mono">{c.expectedIdhRisk ?? "—"}</span>
          <span className="adq-mono">{c.score}</span>
          <span>
            {!c.allowed ? (
              <Tag tone="red">
                <AlertTriangle size={11} /> {c.blockedReason ?? "guardrail"}
              </Tag>
            ) : c.meetsBand ? (
              <Tag tone="mint">
                <CheckCircle2 size={11} /> in band
              </Tag>
            ) : c.overDelivery ? (
              <Tag tone="amber">
                <TrendingDown size={11} /> over-delivery
              </Tag>
            ) : (
              <Tag tone="neutral">out of band</Tag>
            )}
          </span>
        </div>
      ))}
      <p className="adq-note">{result.note}</p>
    </div>
  );
}

/** Trajectory band for the modelled clearance + the Kt/V target band. */
function ClearanceBand({ recommendation }: { recommendation: AdequacyRecommendation }) {
  const current = recommendation.current.spKtV;
  const expected = recommendation.recommended.expectedSpKtV;
  if (current === undefined && expected === undefined) return null;
  const max = 2.0;
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div className="adq-band">
      <div className="adq-band-track">
        <div className="adq-band-target" style={{ left: pct(1.2), width: `${(0.2 / max) * 100}%` }} title="Kt/V band 1.2–1.4" />
        {current !== undefined ? <span className="adq-band-mark is-current" style={{ left: pct(current) }} title={`delivered ${current}`} /> : null}
        {expected !== undefined ? <span className="adq-band-mark is-expected" style={{ left: pct(expected) }} title={`expected ${expected}`} /> : null}
      </div>
      <div className="adq-band-legend">
        <span>
          <i className="is-current" /> delivered spKt/V {current ?? "—"}
        </span>
        <span>
          <i className="is-expected" /> expected after change {expected ?? "—"}
        </span>
        <span>target band 1.2–1.4</span>
      </div>
    </div>
  );
}

export default function AdequacyCds({ onNavigate }: Props) {
  const [features, setFeatures] = useState<AdequacyFeaturesView | null>(null);
  const [state, setState] = useState<AdequacyStateView | null>(null);
  const [assurance, setAssurance] = useState<AdequacyAssuranceView | null>(null);
  const [validation, setValidation] = useState<AdequacyValidationView | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [qip, setQip] = useState<QipTieInView | null>(null);
  const [twin, setTwin] = useState<AdequacyTwinView | null>(null);
  const [advice, setAdvice] = useState<{ recommendation: AdequacyRecommendation; whatIf: AdequacyWhatIfResult; coverageBlocked: boolean } | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patients = usePaged(state?.windows ?? [], 10);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [f, s, a, v, m, q] = await Promise.all([
        fetchAdequacyFeatures(),
        fetchAdequacyState(),
        fetchAdequacyAssurance(),
        fetchAdequacyValidation(),
        fetchAdequacyMdr(),
        fetchAdequacyQip(),
      ]);
      setFeatures(f);
      setState(s);
      setAssurance(a);
      setValidation(v);
      setMdr(m.mdr);
      setQip(q);
      const first = s.windows[0]?.patientId ?? "";
      setSelected((prev) => prev || first);
      if (first) setTwin(await fetchAdequacyTwin(first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the adequacy pack");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAdvise = useCallback(async (model: "reference" | "trained") => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adviseAdequacy({ patientId: selected, model });
      setAdvice({ recommendation: result.recommendation, whatIf: result.whatIf, coverageBlocked: !result.coverage.covered });
      setTwin(await fetchAdequacyTwin(selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : "advise failed");
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const withAction = useCallback(async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setMessage(await fn());
      await load();
      void label;
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const band = features?.reference;

  return (
    <div className="pc-root">
      <header className="pc-header">
        <div className="pc-header-main">
          <Eyebrow>P1 · dialysis adequacy protocol pack</Eyebrow>
          <h1>Dialysis adequacy (Kt/V)</h1>
          <p>
            Daugirdas urea-kinetic prior + a gradient-boosted clearance head, over the real session ledger. Every
            candidate prescription reports expected <strong>spKt/V / URR</strong> and expected{" "}
            <strong>intradialytic-hypotension risk</strong> together, because clearance is never worth a crash. Advisory
            only: the platform holds no machine-control authority.
          </p>
        </div>
        <div className="pc-header-actions">
          <button className="pc-btn" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={14} /> {busy ? "Working…" : "Refresh"}
          </button>
          {onNavigate ? (
            <button className="pc-btn ghost" onClick={() => onNavigate("protocols")}>
              Protocol cockpit
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="pc-error">{error}</div> : null}
      {message ? <div className="adq-message">{message}</div> : null}

      <section className="pc-kpis">
        <Metric label="Patients evaluated" value={String(state?.patients ?? "—")} detail={`${state?.withClearanceData ?? 0} with clearance data`} />
        <Metric label="Delivered in band" value={state ? `${state.inBandPct}%` : "—"} detail={`target spKt/V ${band?.ktvTarget ?? 1.2}–${band?.ktvFrequent ?? 1.4}`} />
        <Metric label="Sessions tracked" value={String(state?.kpis.sessionsTracked ?? "—")} detail={`${state?.kpis.blockedByGuardrails ?? 0} guardrail-blocked windows`} />
        <Metric
          label="Clearance head"
          value={validation?.report.metrics?.head.mape !== undefined ? `${validation.report.metrics.head.mape}% MAPE` : "—"}
          detail={validation?.report.metrics ? `corr ${validation.report.metrics.head.correlation ?? "—"} · prior MAE ${validation.report.metrics.referencePrior.mae ?? "—"}` : "no artifact"}
        />
      </section>

      <RankedActionsPanel
        payload={state?.actions}
        protocol="adequacy"
        emptyHint="Every evaluated window was in the Kt/V band or blocked by the IDH/telemetry guardrail. A clearance change is never worth a crash, so no adequacy action was warranted."
      />


      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>A · advisor console</Eyebrow>
          <PanelExpand label="Pick a live patient from the ledger, then run the prior or the trained head" />
        </div>
        <div className="adq-console">
          <label>
            <span>Patient (live ledger window)</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— select —</option>
              {(state?.windows ?? []).map((w) => (
                <option key={w.patientId} value={w.patientId}>
                  {w.patientId} · URR {w.recommendation.current.urrPct ?? "—"}%
                </option>
              ))}
            </select>
          </label>
          <div className="adq-console-actions">
            <button className="pc-btn" onClick={() => void runAdvise("reference")} disabled={busy || !selected}>
              <Activity size={14} /> Run prior advisor
            </button>
            <button className="pc-btn" onClick={() => void runAdvise("trained")} disabled={busy || !selected}>
              <Sparkles size={14} /> Run trained head
            </button>
            <button className="pc-btn ghost" onClick={() => void withAction("seed", async () => { const r = await seedAdequacyDemo(); return `episodes: ${r.opened.length} opened · ${r.existing.length} existing · ${r.closed.length} closed`; })}>
              Seed episodes
            </button>
            <button className="pc-btn ghost" onClick={() => void withAction("reset", async () => `removed ${(await resetAdequacyDemo()).removed} episodes`)}>
              Reset episodes
            </button>
          </div>
        </div>

        {advice ? (
          <div className="adq-recommendation">
            <div className="adq-rec-head">
              <Tag tone={actionTone(advice.recommendation.action)}>{ADEQUACY_ACTION_LABEL[advice.recommendation.action]}</Tag>
              <Tag tone={bandTone(advice.recommendation.inTargetBand, advice.recommendation.current.spKtV !== undefined)}>
                {advice.recommendation.inTargetBand ? "in Kt/V band" : "outside band"}
              </Tag>
              <Tag tone="violet">{advice.recommendation.model.kind}</Tag>
              {advice.coverageBlocked ? <Tag tone="amber">coverage gate blocked</Tag> : null}
            </div>
            <p className="adq-rec-note">{advice.recommendation.note}</p>
            <div className="adq-rec-grid">
              <div>
                <small>Delivered spKt/V</small>
                <strong>{advice.recommendation.current.spKtV ?? "—"}</strong>
              </div>
              <div>
                <small>Delivered URR</small>
                <strong>{advice.recommendation.current.urrPct ?? "—"}%</strong>
              </div>
              <div>
                <small>Weekly Kt/V</small>
                <strong>{advice.recommendation.current.weeklyKtV ?? "—"}</strong>
              </div>
              <div>
                <small>Expected spKt/V</small>
                <strong>{advice.recommendation.recommended.expectedSpKtV ?? "—"}</strong>
              </div>
              <div>
                <small>Expected URR</small>
                <strong>{advice.recommendation.recommended.expectedUrrPct ?? "—"}%</strong>
              </div>
              <div>
                <small>Expected IDH risk</small>
                <strong>{advice.recommendation.recommended.expectedIdhRisk ?? "—"}</strong>
              </div>
            </div>
            {advice.recommendation.trained ? (
              <p className="adq-note">
                Trained head {advice.recommendation.trained.artifactId}: URR {advice.recommendation.trained.predictedUrrPct}% (prior{" "}
                {advice.recommendation.trained.priorUrrPct}%, correction {advice.recommendation.trained.correction}) · band{" "}
                {advice.recommendation.trained.band.low}–{advice.recommendation.trained.band.high}
              </p>
            ) : null}
            <ClearanceBand recommendation={advice.recommendation} />
            <div className="adq-guards">
              {advice.recommendation.guardrails.flags.length === 0 ? (
                <Tag tone="mint">
                  <ShieldCheck size={11} /> no guardrail flags
                </Tag>
              ) : (
                advice.recommendation.guardrails.flags.map((f) => (
                  <Tag key={f} tone={f.includes("cardiac") || f.includes("adherence") || f.includes("recirculation") ? "red" : "amber"}>
                    {f}
                  </Tag>
                ))
              )}
            </div>
            {advice.recommendation.guardrails.blockReason ? (
              <p className="adq-block-reason">
                <AlertTriangle size={13} /> {advice.recommendation.guardrails.blockReason}
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyView title="No recommendation yet" description="Select a patient and run the advisor." />
        )}
      </section>

      {advice ? (
        <section className="pc-panel">
          <div className="pc-panel-head">
            <Eyebrow>C · prescription simulator</Eyebrow>
            <PanelExpand label="Counterfactual time/flow matrix with the fluid coupling — blocked candidates show why" />
          </div>
          <CandidateTable result={advice.whatIf} />
        </section>
      ) : null}

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>D · patient twin over the real ledger</Eyebrow>
          <PanelExpand label="Delivered session parameters → predicted clearance vs measured URR (MAPE target ≤ 5%)" />
        </div>
        {twin ? (
          <div className="adq-twin">
            <div className="adq-twin-facts">
              <span>
                <small>Sessions</small>
                <strong>{twin.twin.summary.sessionCount}</strong>
              </span>
              <span>
                <small>Mean delivered</small>
                <strong>{twin.twin.summary.avgDeliveredMinutes ?? "—"} min</strong>
              </span>
              <span>
                <small>Mean Qb</small>
                <strong>{twin.twin.summary.avgQb ?? "—"}</strong>
              </span>
              <span>
                <small>Adherence</small>
                <strong>{twin.twin.summary.avgAdherencePct ?? "—"}%</strong>
              </span>
              <span>
                <small>Modelled spKt/V</small>
                <strong>{twin.twin.summary.avgPredictedSpKtV ?? "—"}</strong>
              </span>
              <span>
                <small>Latest URR</small>
                <strong>{twin.twin.summary.latestObservedUrrPct ?? "—"}%</strong>
              </span>
            </div>
            <div className="adq-twin-drift">
              <Tag tone={twin.drift.verdict === "pass" ? "mint" : twin.drift.verdict === "watch" ? "amber" : "neutral"}>
                <Gauge size={11} /> drift {twin.drift.verdict} (n={twin.drift.n})
              </Tag>
              <span className="adq-mono">MAPE {twin.drift.mapePct ?? "—"}% / target {twin.drift.targetMapePct}%</span>
              <span className="adq-mono">MAE {twin.drift.mae ?? "—"}</span>
              <span className="adq-mono">bias {twin.drift.bias ?? "—"}</span>
              <span className="adq-muted">attributed by {twin.twin.provenance.attributedBy}</span>
            </div>
            <p className="adq-note">{twin.drift.note}</p>
            {twin.drift.rows.length ? (
              <div className="adq-drift-rows">
                <div className="adq-drift-head">
                  <span>Observed at</span>
                  <span>Observed URR</span>
                  <span>Predicted URR</span>
                  <span>Error</span>
                </div>
                {twin.drift.rows.slice(-6).map((r) => (
                  <div className="adq-drift-row" key={r.at}>
                    <span className="adq-mono">{r.at.slice(0, 10)}</span>
                    <span className="adq-mono">{r.observedUrrpct}%</span>
                    <span className="adq-mono">{r.predictedUrrPct ?? "—"}</span>
                    <span className={`adq-mono ${(r.errorPct ?? 0) <= twin.drift.targetMapePct ? "is-close" : "is-wide"}`}>
                      {r.errorPct !== undefined ? `${r.errorPct}%` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyView title="No twin yet" description="Select a patient to build the ledger twin." />
        )}
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>B · governance</Eyebrow>
          <PanelExpand label="Coverage gate · activation gate · behavioral red team · drift" />
        </div>
        <div className="pc-detail-grid">
          <div className="pc-detail-card">
            <h4>
              <ShieldCheck size={13} /> Advisor gate
            </h4>
            <Tag tone={assurance?.gate.status === "active" ? "mint" : assurance?.gate.status === "gated" ? "amber" : "red"}>
              {assurance?.gate.status ?? "—"}
            </Tag>
            <ul className="pc-drivers">
              {(assurance?.gate.gates ?? []).map((g) => (
                <li key={g.name}>
                  <strong>{g.passed ? "✓" : "✕"} {g.name}</strong> — {g.observed}
                </li>
              ))}
            </ul>
            <p className="adq-muted">Open findings: {assurance?.openFindings ?? 0}</p>
          </div>
          <div className="pc-detail-card">
            <h4>
              <FlaskConical size={13} /> Behavioral red team (rt-017…rt-020)
            </h4>
            <div className="adq-rt">
              {(assurance?.redTeam.scenarios ?? []).map((s) => (
                <div className="adq-rt-row" key={s.id}>
                  <span className="adq-mono">{s.id}</span>
                  <span>{s.name}</span>
                  <Tag tone={s.probe.passed ? "mint" : "red"}>{s.probe.passed ? "contained" : "failed"}</Tag>
                </div>
              ))}
            </div>
            <div className="adq-console-actions">
              <button className="pc-btn ghost" onClick={() => void withAction("red-team", async () => { const r = await runAdequacyRedTeam(); return `red team: ${r.probes.filter((p) => p.passed).length}/${r.probes.length} contained`; })}>
                Run red team
              </button>
              <button className="pc-btn ghost" onClick={() => void withAction("drift", async () => { const r = await snapshotAdequacyDrift(); return `drift ${r.snapshot.verdict} · KS ${r.snapshot.ksStatistic} · latent shift ${r.snapshot.latentShift}`; })}>
                Snapshot drift
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>E/F · trained head, validation and CMS tie-in</Eyebrow>
          <PanelExpand label="Artifact metrics, acceptance criteria against the recorded targets, and the real CMS Kt/V measure" />
        </div>
        <div className="pc-detail-grid">
          <div className="pc-detail-card">
            <h4>
              <Sparkles size={13} /> Clearance head
            </h4>
            <p className="adq-muted">
              {validation?.report.artifactPresent
                ? `${validation.report.artifactId} · trained ${validation.report.trainedAt?.slice(0, 10)} · ${validation.report.rows} rows / ${validation.report.patients} patients (synthetic)`
                : "artifact not present — the advisor degrades to the mechanistic prior"}
            </p>
            <div className="adq-attribution">
              {(assurance?.model.artifact.attribution ?? []).map((a) => (
                <div className="adq-attr-row" key={a.feature}>
                  <span className="adq-mono">{a.feature}</span>
                  <ProgressBar value={Math.round(a.share * 100)} tone="blue" />
                  <span className="adq-mono">{a.share}</span>
                </div>
              ))}
            </div>
            <div className="adq-console-actions">
              <button
                className="pc-btn ghost"
                onClick={() => void withAction("validation", async () => {
                  const r = await runAdequacyValidation();
                  return `validation re-run · MAPE ${r.report.metrics?.head.mape ?? "—"}% · correlation ${r.report.metrics?.head.correlation ?? "—"}`;
                })}
              >
                <FlaskConical size={13} /> Re-run validation
              </button>
            </div>
          </div>
          <div className="pc-detail-card">
            <h4>
              <Beaker size={13} /> Acceptance criteria (§2.3)
            </h4>
            <div className="adq-criteria">
              {(validation?.report.criteria ?? []).map((c) => (
                <div className="adq-criteria-row" key={c.criterion}>
                  <span>{c.criterion}</span>
                  <span className="adq-muted">{c.target}</span>
                  <Tag tone={c.met ? "mint" : "red"}>{c.met ? "met" : "not met"}</Tag>
                </div>
              ))}
            </div>
            <p className="adq-note">{validation?.report.note}</p>
            <h4>
              <FileText size={13} /> CMS Kt/V QIP tie-in
            </h4>
            <p className="adq-muted">
              {qip?.measure ? `${qip.measure.measure} · ${qip.measure.complete}% complete · ${qip.measure.records} (source: ${qip.source})` : "CMS dataset not present"}
            </p>
            {mdr ? (
              <p className="adq-muted">
                MDR file: {String((mdr.classification as Record<string, unknown>)?.riskClass ?? "—")} · machine control{" "}
                {String((mdr.cybersecurity as Record<string, unknown>)?.machineControlAuthority ?? "none")}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Live windows from the session ledger</Eyebrow>
          <PanelExpand label="Every patient the advisor can serve, with coverage and guardrail status" />
        </div>
        <div className="pc-table">
          <div className="pc-table-head">
            <span>Patient</span>
            <span>Action</span>
            <span>spKt/V / URR</span>
            <span>Coverage / guardrails</span>
          </div>
          {patients.visible.map((w) => (
            <div className="pc-table-row" key={w.patientId}>
              <span className="pc-mono">{w.patientId}</span>
              <span>
                <Tag tone={actionTone(w.recommendation.action)}>{ADEQUACY_ACTION_LABEL[w.recommendation.action]}</Tag>
              </span>
              <span className="pc-mono">
                {w.recommendation.current.spKtV ?? "—"} / {w.recommendation.current.urrPct ?? "—"}%
              </span>
              <span className="adq-signals">
                <Tag tone={w.coverage.covered ? "mint" : "neutral"}>
                  {w.coverage.covered ? "covered" : "coverage blocked"}
                </Tag>
                <span className="adq-muted">{w.recommendation.guardrails.flags.length} flags</span>
              </span>
            </div>
          ))}
        </div>
        <LoadMore
          shown={patients.visible.length}
          total={patients.visible.length + patients.remaining}
          onMore={patients.showMore}
          label="Show more patients"
        />
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Feature contract</Eyebrow>
          <PanelExpand label="Inputs the clearance head reads, with reference bounds" />
        </div>
        <div className="adq-features">
          {(features?.features ?? []).map((f) => (
            <div className="adq-feature" key={f.id}>
              <span className="adq-mono">{f.id}</span>
              <span>{f.label}</span>
              <span className="adq-muted">
                {f.min}–{f.max} {f.unit}
              </span>
              <span className="adq-mono">r={f.relevance}</span>
            </div>
          ))}
        </div>
        <div className="adq-safety">
          <Tag tone="mint">
            <Waves size={11} /> machine control: {features?.safety.machineControl ?? "none"}
          </Tag>
          <Tag tone="violet">
            <Timer size={11} /> time step {features?.reference.timeStepMinutes ?? 15} min · Qb step {features?.reference.qbStepMlMin ?? 25} mL/min
          </Tag>
          <Tag tone="amber">
            <TrendingUp size={11} /> max Qb {features?.reference.maxQb ?? "—"}
          </Tag>
        </div>
      </section>
    </div>
  );
}
