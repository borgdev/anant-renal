"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Droplets,
  FileText,
  Gauge,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Timer,
  Waves,
} from "lucide-react";
import { EmptyView, Eyebrow, Metric, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import {
  adviseFluid,
  fetchFluidArtifact,
  fetchFluidAssurance,
  fetchFluidFeatures,
  fetchFluidMdr,
  fetchFluidState,
  fetchFluidTwin,
  fetchFluidValidation,
  idhEventTone,
  runFluidRedTeam,
  fluidActionTone,
  FLUID_ACTION_LABEL,
  recordFluidStudy,
  type FluidAssuranceView,
  type FluidCandidate,
  type FluidRecommendation,
  type FluidStateView,
  type FluidTwinView,
  type FluidValidationView,
  type FluidWhatIfResult,
} from "../lib/fluid";
import type { NavigationId } from "../lib/types";

type Props = { onNavigate?: (id: NavigationId) => void };

const HORIZONS = [15, 30, 60];

const riskTone = (risk: number | undefined): "mint" | "amber" | "red" | "neutral" =>
  risk === undefined ? "neutral" : risk >= 0.35 ? "red" : risk >= 0.18 ? "amber" : "mint";

/** Per-horizon intra-session risk: the protocol's 15/30/60-minute clocks. */
function HorizonRiskStrip({ label, risk, compare }: { label: string; risk?: Record<string, number> | undefined; compare?: boolean }) {
  if (!risk) return null;
  return (
    <div className={`fd-horizons ${compare ? "is-compare" : ""}`}>
      <span className="fd-horizons-label">{label}</span>
      {HORIZONS.map((m) => {
        const value = risk[String(m)] ?? risk[m as unknown as string];
        return (
          <span className="fd-horizon" key={m}>
            <em>{m} min</em>
            <strong className={`is-${riskTone(value)}`}>{value === undefined ? "—" : `${Math.round(value * 100)}%`}</strong>
          </span>
        );
      })}
    </div>
  );
}

/** Counterfactual UF matrix: fluid-goal achievement against per-horizon IDH risk. */
function UfMatrix({ result }: { result: FluidWhatIfResult }) {
  const rows = useMemo(
    () => [...result.candidates].sort((a, b) => a.ufRateMlH - b.ufRateMlH || a.minutes - b.minutes),
    [result.candidates],
  );
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>UF profile</span>
        <span>Fluid removed</span>
        <span>Goal met</span>
        <span>Risk 15/30/60</span>
        <span>Trade-off</span>
        <span>Status</span>
      </div>
      {rows.map((c: FluidCandidate) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>
              UF {c.ufRateMlH} mL/h · {c.ufRatePerKg} mL/kg/h · {c.minutes} min
            </em>
          </span>
          <span className="adq-mono">{c.fluidRemovedL} L</span>
          <span className="adq-mono">{c.goalAchievedPct}%</span>
          <span className="adq-mono">
            {HORIZONS.map((m) => `${Math.round((c.idhRiskByMinute[String(m)] ?? 0) * 100)}%`).join(" / ")}
          </span>
          <span className="adq-mono">{c.score}</span>
          <span>
            {!c.allowed ? (
              <Tag tone="red">
                <AlertTriangle size={11} /> {c.blockedReason ?? "guardrail"}
              </Tag>
            ) : c.aboveRefillCeiling ? (
              <Tag tone="amber">
                <Waves size={11} /> above refill ceiling
              </Tag>
            ) : result.recommended === c ? (
              <Tag tone="mint">
                <CheckCircle2 size={11} /> safest that meets goal
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

export default function FluidCds({ onNavigate }: Props) {
  const [state, setState] = useState<FluidStateView | null>(null);
  const [assurance, setAssurance] = useState<FluidAssuranceView | null>(null);
  const [validation, setValidation] = useState<FluidValidationView | null>(null);
  const [artifact, setArtifact] = useState<FluidAssuranceView["model"]["artifact"] | null>(null);
  const [reference, setReference] = useState<{ ufRatePerKgSafe: number; ufRatePerKgHigh: number; horizonsMin: number[]; nadirSbpFloor: number } | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [advice, setAdvice] = useState<{ recommendation: FluidRecommendation; whatIf: FluidWhatIfResult; coverageBlocked: boolean } | null>(null);
  const [twin, setTwin] = useState<FluidTwinView | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [model, setModel] = useState<"reference" | "trained">("reference");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [featuresView, stateView, assuranceView, validationView, artifactView] = await Promise.all([
        fetchFluidFeatures(),
        fetchFluidState(),
        fetchFluidAssurance(),
        fetchFluidValidation(),
        fetchFluidArtifact(),
      ]);
      setReference(featuresView.reference);
      setState(stateView);
      setAssurance(assuranceView);
      setValidation(validationView);
      setArtifact(artifactView.artifact);
      const first = stateView.windows[0]?.patientId ?? "";
      setSelected((current) => current || first);
      if (first) setTwin(await fetchFluidTwin(first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the fluid pack");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runAdvice = useCallback(async (patientId: string, which: "reference" | "trained") => {
    if (!patientId) return;
    setBusy("advice");
    try {
      const [response, twinView] = await Promise.all([adviseFluid({ patientId, model: which }), fetchFluidTwin(patientId)]);
      setAdvice({
        recommendation: response.recommendation,
        whatIf: response.whatIf,
        coverageBlocked: !response.coverage.covered,
      });
      setTwin(twinView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "advise failed");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (selected) void runAdvice(selected, model);
  }, [selected, model, runAdvice]);

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

  const windowPager = usePaged(state?.windows ?? [], 8);
  const twinPager = usePaged(twin?.twin.sessions ?? [], 8);

  if (error && !state) return <EmptyView title="Fluid & IDH pack unavailable" description={error} />;
  if (!state || !assurance) {
    return (
      <div className="pc-page">
        <div className="pc-loading">
          <RefreshCw className="is-spinning" size={16} /> loading fluid / IDH protocol pack…
        </div>
      </div>
    );
  }

  const drift = twin?.drift;
  const rateSafe = reference?.ufRatePerKgSafe ?? 10;

  return (
    <div className="pc-page">
      <header className="pc-header">
        <div>
          <Eyebrow>P2 · fluid · dry weight · intradialytic hypotension</Eyebrow>
          <h1>Fluid &amp; IDH</h1>
          <p className="pc-sub">
            Intra-session ultrafiltration counterfactual over the real ledger: per-horizon IDH risk at 15/30/60 minutes, a UF
            profile that meets the fluid goal only inside the plasma-refill ceiling, and a twin that scores the observed
            events. Advisory only — the platform never writes a UF rate, target weight or machine setting.
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
        <Metric label="Patients with telemetry" value={String(state.withTelemetry)} detail={`${state.patients} in the renal cohort`} />
        <Metric label="Sessions tracked" value={String(state.kpis.sessionsTracked)} detail={`${state.kpis.telemetryPoints} intra-session samples`} />
        <Metric label="Hypotensive sessions" value={`${state.kpis.hypotensionRatePct}%`} detail="nadir < 90 mmHg or a ≥20 mmHg fall" tone={state.kpis.hypotensionRatePct > 15 ? "red" : "amber"} />
        <Metric label="Guardrail-blocked" value={String(state.kpis.blockedByGuardrails)} detail={`${state.kpis.coverageBlocked} blocked by the coverage gate`} tone={state.kpis.blockedByGuardrails ? "amber" : "mint"} />
        <Metric label="Advisor gate" value={assurance.gate.status} detail={assurance.model.artifact.ranker === "head" ? "learned head ranks" : "mechanistic prior ranks"} tone={assurance.gate.status === "active" ? "mint" : assurance.gate.status === "gated" ? "amber" : "red"} />
        <Metric label="Model" value={assurance.model.artifact.present ? `${assurance.model.artifact.id}` : "prior only"} detail={`artifact v${assurance.model.artifact.version ?? "—"}`} />
      </div>

      {/* ---------- A/C: advisor + counterfactual simulator ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Gauge size={15} /> Session advisor
            </h2>
            <div className="pc-inline">
              <select value={selected} onChange={(e) => setSelected(e.target.value)} className="pc-select">
                {state.windows.map((w) => (
                  <option key={w.patientId} value={w.patientId}>
                    {w.patientId} · {w.recommendation.current.ufRatePerKg ?? "—"} mL/kg/h
                  </option>
                ))}
              </select>
              <button className="pc-btn ghost" disabled={busy !== null} onClick={() => setModel(model === "reference" ? "trained" : "reference")}>
                <Sparkles size={13} /> {model === "reference" ? "reference" : "trained"}
              </button>
            </div>
          </div>

          {advice ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={fluidActionTone(advice.recommendation.action)}>{FLUID_ACTION_LABEL[advice.recommendation.action]}</Tag>
                <Tag tone={advice.coverageBlocked ? "red" : "mint"}>{advice.coverageBlocked ? "coverage gate: blocked" : "coverage gate: pass"}</Tag>
                <Tag tone={advice.recommendation.guardrails.ufEscalationAllowed ? "mint" : "amber"}>
                  UF escalation {advice.recommendation.guardrails.ufEscalationAllowed ? "permitted" : "refused"}
                </Tag>
                <Tag tone="neutral">{advice.recommendation.model.kind}</Tag>
              </div>

              <div className="adq-facts">
                <span>
                  <em>UF rate</em>
                  <strong>{advice.recommendation.current.ufRateMlH ?? "—"} mL/h</strong>
                </span>
                <span>
                  <em>Per kg</em>
                  <strong className={(advice.recommendation.current.ufRatePerKg ?? 0) > rateSafe ? "is-red" : "is-mint"}>
                    {advice.recommendation.current.ufRatePerKg ?? "—"} mL/kg/h
                  </strong>
                </span>
                <span>
                  <em>Nadir SBP</em>
                  <strong>{advice.recommendation.current.nadirSbp ?? "—"} mmHg</strong>
                </span>
                <span>
                  <em>IDWG</em>
                  <strong>{advice.recommendation.current.idwgKg ?? "—"} kg</strong>
                </span>
                <span>
                  <em>Volume</em>
                  <strong>{advice.recommendation.current.ufVolumeL ?? "—"} L</strong>
                </span>
              </div>

              <HorizonRiskStrip label="Current rate" risk={advice.recommendation.current.idhRiskByMinute} />
              <HorizonRiskStrip label="Recommended profile" risk={advice.recommendation.recommended.expectedIdhRiskByMinute} compare />

              {advice.recommendation.trained ? (
                <p className="adq-note">
                  Learned head {advice.recommendation.trained.artifactId}: 60-min risk {advice.recommendation.trained.headRisk60} vs
                  mechanistic {advice.recommendation.trained.priorRisk60} — ranking with the <strong>{advice.recommendation.trained.ranker}</strong>.
                </p>
              ) : null}

              <p className="adq-note">{advice.recommendation.note}</p>

              {advice.recommendation.guardrails.flags.length ? (
                <div className="pc-inline pc-wrap">
                  {advice.recommendation.guardrails.flags.map((f) => (
                    <Tag key={f} tone={f.includes("no-") || f.includes("not-reassessed") || f.includes("adherence") ? "red" : "amber"}>
                      {f.replace(/-/g, " ")}
                    </Tag>
                  ))}
                </div>
              ) : null}

              <div className="pc-inline pc-wrap">
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("accept", async () => { await recordFluidStudy({ patientId: advice.recommendation.patientId, action: "accept", clinician: "nurse-lead" }); return "study record saved: accepted"; })}>
                  <CheckCircle2 size={13} /> Record accept
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("modify", async () => { await recordFluidStudy({ patientId: advice.recommendation.patientId, action: "modify", clinician: "nurse-lead" }); return "study record saved: modified"; })}>
                  <Timer size={13} /> Record modify
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
              <Waves size={15} /> UF counterfactual
            </h2>
            <span className="pc-panel-note">
              rate × time grid · ceiling {reference?.ufRatePerKgSafe ?? 10} mL/kg/h · horizons {HORIZONS.join("/")} min
            </span>
          </div>
          {advice ? <UfMatrix result={advice.whatIf} /> : null}
        </div>
      </section>

      {/* ---------- D: twin + observed events ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <HeartPulse size={15} /> Patient twin — observed vs predicted IDH
          </h2>
          <span className="pc-panel-note">
            {twin ? `${twin.twin.summary.idhEvents} event(s) over ${twin.twin.summary.sessionsWithTelemetry} telemetry-scored session(s) · provenance ${twin.twin.provenance.attributedBy}` : ""}
          </span>
        </div>

        {drift ? (
          <div className="pc-inline pc-wrap">
            <Tag tone={drift.verdict === "pass" ? "mint" : drift.verdict === "watch" ? "amber" : "neutral"}>drift verdict: {drift.verdict}</Tag>
            <Tag tone="neutral">AUROC {drift.auroc ?? "—"} (target ≥{drift.targetAuroc})</Tag>
            <Tag tone="neutral">observed {Math.round(drift.observedRate * 100)}% vs predicted {Math.round(drift.meanPredicted * 100)}%</Tag>
            <Tag tone={Math.abs(drift.calibrationGap) > 0.15 ? "amber" : "mint"}>calibration gap {drift.calibrationGap}</Tag>
            {drift.leadTimeMinutes !== undefined ? <Tag tone="blue">mean lead {drift.leadTimeMinutes} min</Tag> : null}
          </div>
        ) : null}
        {drift ? <p className="adq-note">{drift.note}</p> : null}

        {twin && twin.twin.sessions.length ? (
          <div className="adq-candidates">
            <div className="adq-cand-head">
              <span>Session</span>
              <span>Delivered</span>
              <span>UF volume</span>
              <span>Nadir / drop</span>
              <span>Predicted risk</span>
              <span>Event</span>
            </div>
            {twinPager.visible.map((s) => (
              <div className="adq-cand-row" key={s.sessionId}>
                <span className="adq-cand-label">
                  <strong>{s.sessionId}</strong>
                  <em>{s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"}</em>
                </span>
                <span className="adq-mono">
                  {s.deliveredMinutes} / {s.prescribedMinutes ?? "—"} min
                </span>
                <span className="adq-mono">{s.ufVolumeL ?? "—"} L</span>
                <span className="adq-mono">
                  {s.nadirSystolic ?? "—"}
                  {s.maxDropMmHg !== undefined ? ` (−${s.maxDropMmHg})` : ""}
                </span>
                <span className="adq-mono">{s.predictedRiskAtNadir ?? "—"}</span>
                <span>
                  <Tag tone={idhEventTone(s.idhEvent)}>{s.idhEvent ? "IDH event" : "stable"}</Tag>
                  {s.symptoms.length ? <em className="adq-sym"> {s.symptoms.join(", ")}</em> : null}
                </span>
              </div>
            ))}
            <LoadMore shown={twinPager.visible.length} total={twin.twin.sessions.length} onMore={twinPager.showMore} label="sessions" />
          </div>
        ) : (
          <EmptyView title="No telemetry-scored sessions yet" description="The twin needs intra-session telemetry (session.telemetry.v1) before it can score an IDH event." />
        )}
      </section>

      {/* ---------- live windows ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Live sessions — ledger windows
          </h2>
          <span className="pc-panel-note">{state.source}</span>
        </div>
        <div className="adq-candidates">
          <div className="adq-cand-head">
            <span>Patient</span>
            <span>UF rate / kg</span>
            <span>IDWG</span>
            <span>Nadir SBP</span>
            <span>Action</span>
            <span>Coverage</span>
          </div>
          {windowPager.visible.map((w) => (
            <div className="adq-cand-row" key={w.patientId}>
              <span className="adq-cand-label">
                <strong>{w.patientId}</strong>
                <em>{w.__displayFacility ?? "—"} · target weight {w.dryWeightSource ?? "—"}</em>
              </span>
              <span className="adq-mono">
                {w.recommendation.current.ufRateMlH ?? "—"} / {w.recommendation.current.ufRatePerKg ?? "—"}
              </span>
              <span className="adq-mono">{w.recommendation.current.idwgKg ?? "—"} kg</span>
              <span className="adq-mono">{w.recommendation.current.nadirSbp ?? "—"}</span>
              <span>
                <Tag tone={fluidActionTone(w.recommendation.action)}>{FLUID_ACTION_LABEL[w.recommendation.action]}</Tag>
              </span>
              <span>
                <Tag tone={w.coverage.covered ? "mint" : "amber"}>{w.coverage.covered ? "covered" : w.coverage.reason ?? "out of domain"}</Tag>
              </span>
            </div>
          ))}
          <LoadMore shown={windowPager.visible.length} total={state.windows.length} onMore={windowPager.showMore} label="windows" />
        </div>
      </section>

      {/* ---------- B/E/F: governance, artifact, validation, MDR ---------- */}
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
          <div className="adq-facts">
            <span>
              <em>Registered</em>
              <strong>{assurance.model.registered ? "yes" : "no"}</strong>
            </span>
            <span>
              <em>Telemetry gate</em>
              <strong>{String(assurance.coverage.defaults.minTelemetryPoints ?? "—")} points</strong>
            </span>
            <span>
              <em>Target weight age</em>
              <strong>≤ {String(assurance.coverage.defaults.dryWeightMaxAgeDays ?? "—")} d</strong>
            </span>
            <span>
              <em>Open findings</em>
              <strong className={assurance.openFindings ? "is-red" : "is-mint"}>{assurance.openFindings}</strong>
            </span>
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
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("red-team", async () => { const r = await runFluidRedTeam(); return `red team: ${r.probes.filter((p) => p.passed).length}/${r.probes.length} probes contained`; })}>
              <ShieldCheck size={13} /> Run rt-021..024
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("mdr", async () => { const r = await fetchFluidMdr(); setMdr(r.mdr); return "MDR technical file materialised"; })}>
              <FileText size={13} /> Build MDR file
            </button>
          </div>
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Droplets size={15} /> Artifact &amp; acceptance
            </h2>
            <span className="pc-panel-note">{artifact?.present ? `${artifact.id} v${artifact.version}` : "no artifact"}</span>
          </div>
          {artifact?.present ? (
            <>
              <div className="adq-facts">
                <span>
                  <em>AUROC</em>
                  <strong className={artifact.meetsSyntheticAurocTarget ? "is-mint" : "is-amber"}>{artifact.metrics?.auroc ?? "—"}</strong>
                </span>
                <span>
                  <em>Prior AUROC</em>
                  <strong>{artifact.metrics?.priorAuroc ?? "—"}</strong>
                </span>
                <span>
                  <em>Brier</em>
                  <strong className={artifact.improvesCalibration ? "is-mint" : "is-red"}>{artifact.metrics?.brier ?? "—"}</strong>
                </span>
                <span>
                  <em>Prior Brier</em>
                  <strong>{artifact.metrics?.priorBrier ?? "—"}</strong>
                </span>
                <span>
                  <em>Rows / patients</em>
                  <strong>
                    {artifact.rows ?? 0} / {artifact.patients ?? 0}
                  </strong>
                </span>
              </div>
              <div className="pc-inline pc-wrap">
                <Tag tone={artifact.meetsSyntheticAurocTarget ? "mint" : "red"}>AUROC ≥ 0.85 {artifact.meetsSyntheticAurocTarget ? "met" : "not met"}</Tag>
                <Tag tone={artifact.beatsPriorDiscrimination ? "mint" : "amber"}>beats prior {artifact.beatsPriorDiscrimination ? "yes" : "no"}</Tag>
                <Tag tone={artifact.improvesCalibration ? "mint" : "red"}>calibration better {artifact.improvesCalibration ? "yes" : "no"}</Tag>
                <Tag tone="blue">ranker: {artifact.ranker}</Tag>
              </div>
              {artifact.attribution?.length ? (
                <div className="pc-bars">
                  {artifact.attribution.slice(0, 6).map((a) => (
                    <div className="pc-bar-row" key={a.feature}>
                      <span className="pc-bar-label">{a.feature}</span>
                      <ProgressBar value={a.share} />
                      <span className="adq-mono">{(a.share * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyView title="No trained artifact" description="Train with `npx tsx scripts/train-fluid-model.ts`; until then the mechanistic prior ranks." />
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
              <FileText size={13} /> Protocol cockpit
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
