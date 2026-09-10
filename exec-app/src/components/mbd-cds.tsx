"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Beaker,
  CheckCircle2,
  FileText,
  GitBranch,
  Link2,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { EmptyView, Eyebrow, Metric, ProgressBar, Tag, usePaged, LoadMore } from "./ui";
import {
  MBD_ACTION_LABEL,
  mbdActionTone,
  mbdAnalyteTone,
  adviseMbd,
  fetchMbdAssurance,
  fetchMbdCoupling,
  fetchMbdMdr,
  fetchMbdState,
  fetchMbdTwin,
  fetchMbdValidation,
  mbdWhatIf,
  recordMbdStudy,
  runMbdRedTeam,
  snapshotMbdDrift,
  type MbdAssuranceView,
  type MbdCandidate,
  type MbdCouplingRow,
  type MbdStateView,
  type MbdTwinView,
  type MbdValidationView,
  type MbdWhatIfResult,
} from "../lib/mbd";
import type { NavigationId } from "../lib/types";

type Props = { onNavigate?: (id: NavigationId) => void };

const HORIZONS = [30, 60, 90];

/** The coupled contract: one lever, three analytes, no free lunch. */
function CouplingTable({ rows }: { rows: MbdCouplingRow[] }) {
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Lever (+ from current)</span>
        <span>Δ phosphate</span>
        <span>Δ corrected Ca</span>
        <span>Δ PTH</span>
        <span>Coupling read</span>
        <span>Safety read</span>
      </div>
      {rows.map((r) => (
        <div className="adq-cand-row" key={r.lever}>
          <span className="adq-cand-label">
            <strong>{r.lever}</strong>
            <em>90-day horizon</em>
          </span>
          <span className={`adq-mono ${r.phosphate < 0 ? "is-mint" : r.phosphate > 0 ? "is-amber" : ""}`}>{r.phosphate > 0 ? "+" : ""}{r.phosphate}</span>
          <span className={`adq-mono ${r.correctedCalcium > 0 ? "is-red" : r.correctedCalcium < 0 ? "is-mint" : ""}`}>{r.correctedCalcium > 0 ? "+" : ""}{r.correctedCalcium}</span>
          <span className={`adq-mono ${r.pth < 0 ? "is-mint" : r.pth > 0 ? "is-amber" : ""}`}>{r.pth > 0 ? "+" : ""}{r.pth}</span>
          <span>
            {r.phosphate < 0 && r.correctedCalcium > 0 ? <Tag tone="amber">phosphate down, calcium up</Tag>
              : r.phosphate <= 0 && r.pth <= 0 ? <Tag tone="mint">two analytes move the right way</Tag>
              : <Tag tone="neutral">one analyte only</Tag>}
          </span>
          <span>{r.correctedCalcium > 0.3 ? <Tag tone="red">calcium-raising</Tag> : <Tag tone="mint">calcium-safe</Tag>}</span>
        </div>
      ))}
    </div>
  );
}

/** Candidate therapies: the coupled projection per horizon, with contract refusals visible. */
function CandidateTable({ result }: { result: MbdWhatIfResult }) {
  const rows = useMemo(() => [...result.candidates].sort((a, b) => (a.allowed === b.allowed ? a.score - b.score : a.allowed ? -1 : 1)), [result.candidates]);
  return (
    <div className="adq-candidates">
      <div className="adq-cand-head">
        <span>Therapy option</span>
        <span>P 30 d</span>
        <span>Ca 30 d</span>
        <span>PTH 30 d</span>
        <span>P / Ca / PTH 90 d</span>
        <span>Status</span>
      </div>
      {rows.map((c: MbdCandidate) => (
        <div className={`adq-cand-row ${c.allowed ? "" : "is-blocked"} ${result.recommended === c ? "is-picked" : ""}`} key={c.label}>
          <span className="adq-cand-label">
            <strong>{c.label}</strong>
            <em>
              {c.therapy.binderClass === "none" ? "no binder" : `${c.therapy.binderClass} ${c.therapy.binderMgPerDay} mg/d`}
              {" · "}
              calcimimetic {c.therapy.calcimimeticMgPerDay} mg/d · vit D {c.therapy.activeVitaminDMcgPerDay} mcg/d · pills {c.pillBurden}
            </em>
          </span>
          <span className={`adq-mono is-${mbdAnalyteTone("phosphate", c.points[30]?.phosphate)}`}>{c.points[30]?.phosphate ?? "—"}</span>
          <span className={`adq-mono is-${mbdAnalyteTone("correctedCalcium", c.points[30]?.correctedCalcium)}`}>{c.points[30]?.correctedCalcium ?? "—"}</span>
          <span className={`adq-mono is-${mbdAnalyteTone("pth", c.points[30]?.pth)}`}>{c.points[30]?.pth ?? "—"}</span>
          <span className="adq-mono">
            {c.points[90]?.phosphate ?? "—"} / {c.points[90]?.correctedCalcium ?? "—"} / {c.points[90]?.pth ?? "—"}
          </span>
          <span>
            {!c.allowed ? (
              <Tag tone="red">
                <AlertTriangle size={11} /> {c.violations[0] ?? "KDIGO contract"}
              </Tag>
            ) : result.recommended === c ? (
              <Tag tone="mint">
                <CheckCircle2 size={11} /> best allowed (score {c.score})
              </Tag>
            ) : (
              <Tag tone="neutral">allowed (score {c.score})</Tag>
            )}
          </span>
        </div>
      ))}
      <p className="adq-note">{result.note}</p>
    </div>
  );
}

export default function MbdCds({ onNavigate }: Props) {
  const [state, setState] = useState<MbdStateView | null>(null);
  const [assurance, setAssurance] = useState<MbdAssuranceView | null>(null);
  const [validation, setValidation] = useState<MbdValidationView | null>(null);
  const [coupling, setCoupling] = useState<MbdCouplingRow[]>([]);
  const [advice, setAdvice] = useState<{
    recommendation: MbdStateView["windows"][number]["recommendation"];
    whatIf: MbdWhatIfResult;
    coupling: MbdCouplingRow[];
    trained?: { artifactId: string; point: { phosphate: number; correctedCalcium: number; pth: number }; priorPoint: { phosphate: number; correctedCalcium: number; pth: number }; ranker: string };
  } | null>(null);
  const [twin, setTwin] = useState<MbdTwinView | null>(null);
  const [mdr, setMdr] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stateView, assuranceView, validationView, couplingView] = await Promise.all([
        fetchMbdState(),
        fetchMbdAssurance(),
        fetchMbdValidation(),
        fetchMbdCoupling(),
      ]);
      setState(stateView);
      setAssurance(assuranceView);
      setValidation(validationView);
      setCoupling(couplingView.map);
      const first = stateView.windows[0]?.patientId ?? "";
      setSelected((current) => current || first);
      if (first) setTwin(await fetchMbdTwin(first));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the CKD-MBD pack");
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
        adviseMbd({ patientId, model }),
        mbdWhatIf({ patientId }),
        fetchMbdTwin(patientId),
      ]);
      setAdvice({ recommendation: response.recommendation, whatIf: whatIf.result, coupling: response.coupling, ...(response.trained ? { trained: response.trained } : {}) });
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
  const tripletPager = usePaged(twin?.twin.triplets ?? [], 8);

  if (error && !state) return <EmptyView title="CKD-MBD pack unavailable" description={error} />;
  if (!state || !assurance) {
    return (
      <div className="pc-page">
        <div className="pc-loading">
          <RefreshCw className="is-spinning" size={16} /> loading CKD-MBD protocol pack…
        </div>
      </div>
    );
  }

  const recommendation = advice?.recommendation;
  const drift = twin?.drift;

  return (
    <div className="pc-page">
      <header className="pc-header">
        <div>
          <Eyebrow>P4 · CKD-MBD · coupled [P, Ca, PTH] therapy advisory</Eyebrow>
          <h1>Mineral bone disorder</h1>
          <p className="pc-sub">
            A <strong>coupled</strong> responder: every lever is projected on phosphate, corrected calcium and PTH at
            once, because a binder that lowers phosphate can raise calcium. The KDIGO hard envelope is enforced in code
            — a projection that breaches the calcium ceiling, the hypocalcaemia floor or the phosphate floor is{" "}
            <strong>refused before it is scored</strong>. The platform prescribes nothing.
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
        <Metric label="Patients tracked" value={String(state.kpis.patientsTracked)} detail={`${state.withCompleteTriplet} with a complete [P, Ca, PTH] triplet`} />
        <Metric label="In KDIGO target" value={String(state.kpis.inTarget)} detail="all three analytes in range" tone="mint" />
        <Metric label="Hyperphosphataemic" value={String(state.kpis.hyperphosphatemic)} detail="phosphate above 5.5 mg/dL" tone={state.kpis.hyperphosphatemic ? "amber" : "mint"} />
        <Metric label="Hypercalcaemic" value={String(state.kpis.hypercalcemic)} detail="corrected calcium above the envelope ceiling" tone={state.kpis.hypercalcemic ? "red" : "mint"} />
        <Metric label="Safety reviews" value={String(state.kpis.safetyReviewProposed)} detail="hold / safety-review proposals (human decision)" tone={state.kpis.safetyReviewProposed ? "amber" : "mint"} />
        <Metric label="Coverage-blocked" value={String(state.kpis.coverageBlocked)} detail="fewer than 2 serial triplets, stale, or out of manifold" tone={state.kpis.coverageBlocked ? "amber" : "mint"} />
      </div>

      {/* ---------- A: the coupled advisor ---------- */}
      <section className="pc-grid-2">
        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Beaker size={15} /> Coupled therapy advisor
            </h2>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className="pc-select">
              {state.windows.map((w) => (
                <option key={w.patientId} value={w.patientId}>
                  {w.patientId} · P {w.recommendation.current.phosphate ?? "—"} · Ca {w.recommendation.current.correctedCalcium ?? "—"} · PTH {w.recommendation.current.pth ?? "—"}
                </option>
              ))}
            </select>
          </div>

          {recommendation ? (
            <>
              <div className="pc-inline pc-wrap">
                <Tag tone={mbdActionTone(recommendation.action)}>{MBD_ACTION_LABEL[recommendation.action]}</Tag>
                <Tag tone={recommendation.inTarget ? "mint" : "amber"}>{recommendation.inTarget ? "in KDIGO target" : "out of target"}</Tag>
                <Tag tone={recommendation.projection.safe ? "mint" : "red"}>{recommendation.projection.safe ? "projection inside the envelope" : "projection refused"}</Tag>
                <Tag tone="neutral">{recommendation.model.kind}</Tag>
              </div>

              <div className="adq-facts">
                <span>
                  <em>Phosphate</em>
                  <strong className={`is-${mbdAnalyteTone("phosphate", recommendation.current.phosphate)}`}>{recommendation.current.phosphate ?? "—"} mg/dL</strong>
                </span>
                <span>
                  <em>Corrected Ca</em>
                  <strong className={`is-${mbdAnalyteTone("correctedCalcium", recommendation.current.correctedCalcium)}`}>{recommendation.current.correctedCalcium ?? "—"} mg/dL</strong>
                </span>
                <span>
                  <em>PTH</em>
                  <strong className={`is-${mbdAnalyteTone("pth", recommendation.current.pth)}`}>{recommendation.current.pth ?? "—"} pg/mL</strong>
                </span>
                <span>
                  <em>Vitamin D (25-OH)</em>
                  <strong className={(recommendation.current.vitaminD ?? 99) < 30 ? "is-amber" : "is-mint"}>{recommendation.current.vitaminD ?? "—"} ng/mL</strong>
                </span>
                <span>
                  <em>Serial triplets</em>
                  <strong>{recommendation.current.triplets}</strong>
                </span>
                <span>
                  <em>Binder</em>
                  <strong>
                    {recommendation.current.therapy.binderClass === "none" ? "none" : `${recommendation.current.therapy.binderClass} ${recommendation.current.therapy.binderMgPerDay} mg/d`}
                  </strong>
                </span>
              </div>

              <div className="mbd-horizons">
                <span className="fd-horizons-label">projected set point (P / Ca / PTH)</span>
                {HORIZONS.map((h) => {
                  const point = recommendation.projection.points[String(h)];
                  return (
                    <span className="fd-horizon" key={h}>
                      <em>{h} d</em>
                      <strong className={`is-${mbdAnalyteTone("phosphate", point?.phosphate)}`}>
                        {point?.phosphate ?? "—"} · {point?.correctedCalcium ?? "—"} · {point?.pth ?? "—"}
                      </strong>
                    </span>
                  );
                })}
              </div>

              <p className="adq-note">{recommendation.note}</p>

              {recommendation.projection.violations.length ? (
                <div className="pc-inline pc-wrap">
                  {recommendation.projection.violations.map((v) => (
                    <Tag key={v} tone="red">
                      <AlertTriangle size={11} /> {v}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {recommendation.guardrails.flags.length ? (
                <div className="pc-inline pc-wrap">
                  {recommendation.guardrails.flags.map((f) => (
                    <Tag key={f} tone={f.includes("blocked") || f.includes("hypercal") ? "amber" : "neutral"}>
                      {f.replace(/-/g, " ")}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {advice?.trained ? (
                <div className="mbd-trained">
                  <div className="pc-inline pc-wrap">
                    <Tag tone="blue">{advice.trained.artifactId}</Tag>
                    <Tag tone={advice.trained.ranker === "head" ? "mint" : "amber"}>ranker: {advice.trained.ranker}</Tag>
                  </div>
                  <div className="adq-facts">
                    <span>
                      <em>Trained heads</em>
                      <strong className="is-mint">
                        {advice.trained.point.phosphate} · {advice.trained.point.correctedCalcium} · {advice.trained.point.pth}
                      </strong>
                    </span>
                    <span>
                      <em>Coupled responder</em>
                      <strong>
                        {advice.trained.priorPoint.phosphate} · {advice.trained.priorPoint.correctedCalcium} · {advice.trained.priorPoint.pth}
                      </strong>
                    </span>
                  </div>
                  <p className="adq-note">
                    The trained artifact projects the recommended therapy; the coupled responder remains the fallback the
                    heads are measured against on every analyte.
                  </p>
                </div>
              ) : null}

              <div className="pc-inline pc-wrap">
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void runAdvice(recommendation.patientId, "trained")}>
                  <Beaker size={13} /> Score with the trained heads
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("accept", async () => { await recordMbdStudy({ patientId: recommendation.patientId, action: "accept", clinician: "renal-md" }); return "study record saved: plan accepted"; })}>
                  <CheckCircle2 size={13} /> Accept plan
                </button>
                <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("modify", async () => { await recordMbdStudy({ patientId: recommendation.patientId, action: "modify", clinician: "renal-md" }); return "study record saved: modified"; })}>
                  <Activity size={13} /> Record modify
                </button>
              </div>
            </>
          ) : (
            <div className="pc-loading">
              <RefreshCw size={14} className="is-spinning" /> projecting…
            </div>
          )}
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <Link2 size={15} /> Coupling map — what one lever does to three analytes
            </h2>
            <span className="pc-panel-note">2.4 g/day binder step · 30 mg calcimimetic · 0.25 mcg vitamin D</span>
          </div>
          <CouplingTable rows={advice?.coupling ?? coupling} />
        </div>
      </section>

      {/* ---------- C: candidate therapies under the hard contract ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Candidate therapies under the KDIGO hard contract
          </h2>
          <span className="pc-panel-note">1.1 g per 1.0 mg/dL phosphate removed · calcium-based binders refused when calcium is raised</span>
        </div>
        {advice ? <CandidateTable result={advice.whatIf} /> : null}
        {advice?.whatIf.blocked ? (
          <p className="adq-note">
            No therapy is recommended for this window: {advice.whatIf.blockReason} The contract refuses every option rather
            than proposing a dose on thin data.
          </p>
        ) : null}
      </section>

      {/* ---------- D: the twin over the real ledger ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <GitBranch size={15} /> MBD twin — triplets reconstructed from the ledger
          </h2>
          <span className="pc-panel-note">
            {twin ? `${twin.twin.summary.completeTriplets} complete triplet(s) · ${twin.twin.summary.therapySteps} therapy step(s) · provenance ${twin.twin.provenance.attributedBy}` : ""}
          </span>
        </div>

        {drift ? (
          <div className="pc-inline pc-wrap">
            <Tag tone={drift.verdict === "pass" ? "mint" : drift.verdict === "watch" ? "amber" : "neutral"}>verdict: {drift.verdict}</Tag>
            <Tag tone="neutral">therapy steps scored {drift.steps}</Tag>
            <Tag tone={(drift.mae.phosphate ?? 9) <= drift.targetMaeMgDl ? "mint" : "amber"}>
              phosphate MAE {drift.mae.phosphate ?? "—"} (≤{drift.targetMaeMgDl})
            </Tag>
            <Tag tone={(drift.mae.correctedCalcium ?? 9) <= drift.targetMaeMgDl ? "mint" : "amber"}>
              corrected Ca MAE {drift.mae.correctedCalcium ?? "—"}
            </Tag>
            <Tag tone="neutral">PTH MAE {drift.mae.pth ?? "—"}</Tag>
          </div>
        ) : null}
        {drift ? <p className="adq-note">{drift.note}</p> : null}

        {twin && twin.twin.triplets.length ? (
          <div className="adq-candidates">
            <div className="adq-cand-head">
              <span>Triplet</span>
              <span>Phosphate</span>
              <span>Corrected Ca</span>
              <span>PTH</span>
              <span>Vitamin D</span>
              <span>Complete</span>
            </div>
            {tripletPager.visible.map((t, index) => (
              <div className="adq-cand-row" key={`${t.at}-${index}`}>
                <span className="adq-cand-label">
                  <strong>{t.at ? new Date(t.at).toLocaleDateString() : "—"}</strong>
                  <em>{t.albumin !== undefined ? `albumin ${t.albumin} g/dL → correction applied` : "no albumin — uncorrected"}</em>
                </span>
                <span className={`adq-mono is-${mbdAnalyteTone("phosphate", t.phosphate)}`}>{t.phosphate ?? "—"}</span>
                <span className={`adq-mono is-${mbdAnalyteTone("correctedCalcium", t.correctedCalcium)}`}>{t.correctedCalcium ?? "—"}</span>
                <span className={`adq-mono is-${mbdAnalyteTone("pth", t.pth)}`}>{t.pth ?? "—"}</span>
                <span className="adq-mono">{t.vitaminD ?? "—"}</span>
                <span>
                  <Tag tone={t.complete ? "mint" : "neutral"}>{t.complete ? "P + Ca + PTH" : "partial panel"}</Tag>
                </span>
              </div>
            ))}
            <LoadMore shown={tripletPager.visible.length} total={twin.twin.triplets.length} onMore={tripletPager.showMore} label="triplets" />
          </div>
        ) : (
          <EmptyView title="No complete triplets yet" description="The MBD twin needs phosphate, calcium and PTH results — and the coverage gate needs at least two serial triplets before the coupled model runs." />
        )}
      </section>

      {/* ---------- live windows ---------- */}
      <section className="pc-panel">
        <div className="pc-panel-head">
          <h2>
            <Activity size={15} /> Live windows — ledger triplets
          </h2>
          <span className="pc-panel-note">{state.source}</span>
        </div>
        <div className="adq-candidates">
          <div className="adq-cand-head">
            <span>Patient</span>
            <span>P / Ca / PTH</span>
            <span>Trend (P, 30 d)</span>
            <span>Therapy</span>
            <span>Action</span>
            <span>Coverage</span>
          </div>
          {windowPager.visible.map((w) => (
            <div className="adq-cand-row" key={w.patientId}>
              <span className="adq-cand-label">
                <strong>{w.patientId}</strong>
                <em>
                  {w.__displayFacility ?? "—"} · {w.triplets} triplet(s) · latent r={w.recommendation.latent.polarRadius}
                </em>
              </span>
              <span className="adq-mono">
                {w.recommendation.current.phosphate ?? "—"} / {w.recommendation.current.correctedCalcium ?? "—"} / {w.recommendation.current.pth ?? "—"}
              </span>
              <span className="adq-mono is-amber">{(w.recommendation as unknown as { current: { phosphateTrend30d?: number } }).current.phosphateTrend30d ?? "—"}</span>
              <span className="adq-mono">{w.therapy ? `${w.therapy.binderClass} ${w.therapy.binderMgPerDay}mg` : "—"}</span>
              <span>
                <Tag tone={mbdActionTone(w.recommendation.action)}>{MBD_ACTION_LABEL[w.recommendation.action]}</Tag>
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

          <div className="pc-inline pc-wrap">
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("red-team", async () => { const r = await runMbdRedTeam(); return `red team: ${r.probes.filter((p) => p.passed).length}/${r.probes.length} probes contained`; })}>
              <ShieldCheck size={13} /> Run rt-029..032
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("drift", async () => { const r = await snapshotMbdDrift(); return `drift: ${r.snapshot.verdict} (KS ${r.snapshot.ksStatistic})`; })}>
              <TrendingUp size={13} /> Drift snapshot
            </button>
            <button className="pc-btn ghost" disabled={busy !== null} onClick={() => void withAction("mdr", async () => { const r = await fetchMbdMdr(); setMdr(r.mdr); return "MDR technical file materialised"; })}>
              <FileText size={13} /> Build MDR file
            </button>
          </div>
        </div>

        <div className="pc-panel">
          <div className="pc-panel-head">
            <h2>
              <FileText size={15} /> Multi-output artifact &amp; acceptance
            </h2>
            <span className="pc-panel-note">
              {assurance.model.artifact.present ? `${assurance.model.artifact.id} v${assurance.model.artifact.version}` : "no artifact"}
            </span>
          </div>

          {assurance.model.artifact.present && assurance.model.artifact.metrics ? (
            <>
              <div className="pc-bars">
                {(["phosphate", "correctedCalcium", "pth"] as const).map((head) => {
                  const mae = assurance.model.artifact.metrics!.mae[head];
                  const prior = assurance.model.artifact.metrics!.priorMae[head];
                  return (
                    <div className="pc-bar-row" key={head}>
                      <span className="pc-bar-label">{head} MAE</span>
                      <ProgressBar value={Math.min(100, (mae / Math.max(prior, 0.0001)) * 100)} tone={mae <= prior ? "mint" : "red"} />
                      <span className="adq-mono">{mae} vs {prior}</span>
                    </div>
                  );
                })}
              </div>
              <div className="pc-inline pc-wrap">
                <Tag tone={assurance.model.artifact.beatsPriorOnAllHeads ? "mint" : "amber"}>
                  beats the coupled responder on all three analytes: {String(assurance.model.artifact.beatsPriorOnAllHeads)}
                </Tag>
                <Tag tone="neutral">head-error coupling {assurance.model.artifact.metrics.couplingCorrelation}</Tag>
                <Tag tone="neutral">
                  {assurance.model.artifact.rows ?? 0} rows / {assurance.model.artifact.patients ?? 0} patients
                </Tag>
              </div>
              {assurance.model.artifact.attribution ? (
                <div className="pc-bars">
                  {(["phosphate", "pth"] as const).map((head) =>
                    (assurance.model.artifact!.attribution?.[head] ?? []).slice(0, 4).map((a) => (
                      <div className="pc-bar-row" key={`${head}-${a.feature}`}>
                        <span className="pc-bar-label">
                          {head} · {a.feature}
                        </span>
                        <ProgressBar value={a.share * 100} />
                        <span className="adq-mono">{(a.share * 100).toFixed(1)}%</span>
                      </div>
                    )),
                  )}
                </div>
              ) : null}
              <p className="adq-note">{validation?.report.benchmarkNote}</p>
            </>
          ) : (
            <EmptyView title="No trained artifact" description="Train with `npx tsx scripts/train-mbd-model.ts`; until then the coupled mechanical responder serves every projection." />
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
