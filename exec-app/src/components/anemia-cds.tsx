"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Beaker,
  CheckCircle2,
  ClipboardCheck,
  CloudDownload,
  Dna,
  FlaskConical,
  Gauge,
  HeartPulse,
  Info,
  Layers,
  LockKeyhole,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserRound,
} from "lucide-react";
import {
  adviseEsa,
  episodeTitle,
  ESA_MODEL_ID,
  fetchAnemiaAssurance,
  fetchAnemiaFeatures,
  fetchAnemiaMdr,
  fetchAnemiaState,
  fetchAnemiaStudy,
  fetchAnemiaValidation,
  recordAnemiaStudy,
  resetAnemiaDemo,
  runAnemiaRedTeam,
  runAnemiaValidation,
  seedAnemiaDemo,
  snapshotAnemiaDrift,
  type AnemiaStateView,
  type EsaAssuranceView,
  type EsaDirection,
  type EsaFeaturesView,
  type EsaMdrFileView,
  type EsaRecommendation,
  type EsaStudyView,
  type EsaValidationView,
} from "../lib/anemia";
import type { NavigationId } from "../lib/types";
import { Eyebrow, Metric, PanelExpand, Tag } from "./ui";

/** Panel review epoch — deterministic so iron-freshness checks behave like the tests. */
const REVIEW_AT = "2026-09-01T00:00:00Z";

const DIRECTION_META: Record<EsaDirection, { label: string; tone: "mint" | "amber" | "blue" | "red" | "neutral" }> = {
  hold: { label: "Hold dose", tone: "mint" },
  increase: { label: "Increase dose", tone: "amber" },
  reduce: { label: "Reduce dose", tone: "blue" },
  suspend: { label: "Suspend ESA", tone: "red" },
  blocked: { label: "Blocked by guardrail", tone: "red" },
};

const EP_TONE: Record<string, "mint" | "amber" | "blue" | "red" | "neutral"> = {
  AwaitingApproval: "amber",
  Resolved: "mint",
  Coordinating: "blue",
  Verifying: "blue",
  Proposed: "blue",
  Escalated: "red",
  Rejected: "red",
  Blocked: "red",
  Reopened: "amber",
};

function fmtDose(v: number | null): string {
  return v === null ? "—" : `${v.toLocaleString()} u/wk`;
}

export default function AnemiaCds({ onNavigate }: { onNavigate?: (nav: NavigationId) => void }) {
  const [features, setFeatures] = useState<EsaFeaturesView | null>(null);
  const [state, setState] = useState<AnemiaStateView | null>(null);
  const [rec, setRec] = useState<EsaRecommendation | null>(null);
  const [busy, setBusy] = useState<"advise" | "demo" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assurance, setAssurance] = useState<EsaAssuranceView | null>(null);
  const [govBusy, setGovBusy] = useState<"redteam" | "drift" | null>(null);
  const [govError, setGovError] = useState<string | null>(null);
  const [validation, setValidation] = useState<EsaValidationView | null>(null);
  const [study, setStudy] = useState<EsaStudyView | null>(null);
  const [mdr, setMdr] = useState<EsaMdrFileView | null>(null);
  const [p3Busy, setP3Busy] = useState<"validation" | "study" | null>(null);
  const [p3Error, setP3Error] = useState<string | null>(null);

  const [form, setForm] = useState({
    patientId: "p-esa-1",
    currentHgb: "9.4",
    currentDose: "8000",
    mcv: "92",
    ferritin: "640",
    transferrinSat: "28",
    crp: "6",
    calcium: "9.2",
    pth: "120",
    lastIronPanelAt: "2026-08-01",
  });
  const [onESA, setOnESA] = useState(true);

  const episodes = state?.episodes ?? [];
  const kpis = state?.kpis;
  const maxRelevance = useMemo(() => {
    if (!features?.features.length) return 0.4;
    return Math.max(...features.features.map((f) => f.relevance));
  }, [features]);

  const reloadState = async () => {
    try { setState(await fetchAnemiaState()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "state load failed"); }
  };

  const reloadAssurance = async () => {
    try { setAssurance(await fetchAnemiaAssurance()); setGovError(null); }
    catch (err) { setGovError(err instanceof Error ? err.message : "assurance load failed"); }
  };

  useEffect(() => {
    let active = true;
    void fetchAnemiaFeatures().then((f) => { if (active) setFeatures(f); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "features load failed"); });
    void fetchAnemiaState().then((s) => { if (active) setState(s); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "state load failed"); });
    void fetchAnemiaAssurance().then((a) => { if (active) setAssurance(a); }).catch((err) => { if (active) setGovError(err instanceof Error ? err.message : "assurance load failed"); });
    return () => { active = false; };
  }, []);

  const runRedTeam = async () => {
    setGovBusy("redteam"); setGovError(null);
    try { await runAnemiaRedTeam(); await reloadAssurance(); }
    catch (err) { setGovError(err instanceof Error ? err.message : "red-team run failed"); }
    finally { setGovBusy(null); }
  };

  const runDrift = async () => {
    setGovBusy("drift"); setGovError(null);
    try { await snapshotAnemiaDrift(); await reloadAssurance(); }
    catch (err) { setGovError(err instanceof Error ? err.message : "drift snapshot failed"); }
    finally { setGovBusy(null); }
  };

  const reloadP3 = async () => {
    try {
      const [v, s, m] = await Promise.all([fetchAnemiaValidation(), fetchAnemiaStudy(), fetchAnemiaMdr()]);
      setValidation(v); setStudy(s); setMdr(m.file); setP3Error(null);
    } catch (err) { setP3Error(err instanceof Error ? err.message : "P3 load failed"); }
  };

  useEffect(() => { void reloadP3(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const runExternalValidation = async () => {
    setP3Busy("validation"); setP3Error(null);
    try { await runAnemiaValidation(); await reloadP3(); }
    catch (err) { setP3Error(err instanceof Error ? err.message : "external validation failed"); }
    finally { setP3Busy(null); }
  };

  const recordSampleStudy = async () => {
    setP3Busy("study"); setP3Error(null);
    try {
      // “Suggest, don’t auto-act” — three representative clinician decisions.
      await recordAnemiaStudy({ patientId: "p-esa-1", recommendedDose: 9500, clinicianAction: "accepted", by: "Dr. Alvarez (nephrology)", window: { currentHgb: 9.4, currentDose: 8000 } });
      await recordAnemiaStudy({ patientId: "p-esa-3", recommendedDose: 10000, clinicianAction: "adjusted", adjustedDose: 8000, by: "Dr. Chen", note: "Prefer slower titration", window: { currentHgb: 9.6, currentDose: 8000 } });
      await recordAnemiaStudy({ patientId: "p-esa-5", recommendedDose: 6000, clinicianAction: "withheld", by: "Dr. Alvarez (nephrology)", window: { currentHgb: 10.9, currentDose: 8000 } });
      await reloadP3();
    } catch (err) { setP3Error(err instanceof Error ? err.message : "study record failed"); }
    finally { setP3Busy(null); }
  };

  const numOr = (raw: string): number | undefined => (raw.trim() === "" ? undefined : Number(raw));

  const runAdvise = async () => {
    if (form.patientId.trim() === "" || form.currentHgb.trim() === "" || form.currentDose.trim() === "") {
      setError("patientId, currentHgb and currentDose are required before advising.");
      return;
    }
    const currentHgb = Number(form.currentHgb);
    const currentDose = Number(form.currentDose);
    const base = currentHgb - 0.4;
    const trend = [0, 1, 2, 3, 4].map((i) => Number((base + i * 0.1).toFixed(1)));
    setBusy("advise"); setError(null);
    try {
      const { recommendation } = await adviseEsa({
        patientId: form.patientId.trim(),
        currentHgb,
        currentDose,
        onESA,
        ...(numOr(form.mcv) !== undefined ? { mcv: Number(form.mcv) } : {}),
        ...(numOr(form.ferritin) !== undefined ? { ferritin: Number(form.ferritin) } : {}),
        ...(numOr(form.transferrinSat) !== undefined ? { transferrinSat: Number(form.transferrinSat) } : {}),
        ...(numOr(form.crp) !== undefined ? { crp: Number(form.crp) } : {}),
        ...(numOr(form.calcium) !== undefined ? { calcium: Number(form.calcium) } : {}),
        ...(numOr(form.pth) !== undefined ? { pth: Number(form.pth) } : {}),
        hgbTrendLast90d: trend,
        esaEscalationsLast90d: 0,
        ...(form.lastIronPanelAt ? { lastIronPanelAt: `${form.lastIronPanelAt}T00:00:00Z` } : {}),
        asOf: REVIEW_AT,
      });
      setRec(recommendation);
    } catch (err) { setError(err instanceof Error ? err.message : "advise failed"); }
    finally { setBusy(null); }
  };

  const runDemo = async () => {
    setBusy("demo"); setError(null);
    try { await seedAnemiaDemo(); await reloadState(); }
    catch (err) { setError(err instanceof Error ? err.message : "demo seed failed"); }
    finally { setBusy(null); }
  };

  const runReset = async () => {
    setBusy("reset"); setError(null);
    try { const r = await resetAnemiaDemo(); setRec(null); await reloadState(); if (r.removed) setRec(null); }
    catch (err) { setError(err instanceof Error ? err.message : "reset failed"); }
    finally { setBusy(null); }
  };

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const directionMeta = rec ? DIRECTION_META[rec.direction] : null;
  const hasFlags = (rec?.guardrails.flags.length ?? 0) > 0;
  // The dev server clears in-memory sessions on every src-file restart — a 401
  // here means the browser cookie is stale, not a product failure.
  const sessionExpired = [error, govError, p3Error].some((m) => (m ?? "").toLowerCase().includes("not-authenticated") || (m ?? "").toLowerCase().includes("session expired"));

  return (
    <div className="view-stack anemia-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Anemia &amp; ESA · P0 reference CDSS</Eyebrow>
          <h1>Anemia &amp; ESA dose support</h1>
          <p>The manifold-learning EPO advisor (Array 2026) as a governed decision-support journey — it recommends a dose, it never orders one.</p>
        </div>
        <div className="heading-actions">
          <Tag tone="violet"><LockKeyhole size={11} /> Class C · human-in-the-loop</Tag>
          <Tag tone="mint"><FlaskConical size={11} /> Reference surrogate {features?.model.version ?? "v0.1.0"}</Tag>
          <Tag tone="amber"><Sparkles size={11} /> Synthetic demo</Tag>
        </div>
      </header>

      {sessionExpired ? (
        <div className="admin-notice is-error esa-auth-banner">
          <ShieldAlert size={16} />
          <span><strong>Session expired.</strong> The server restarted and cleared your sign-in. Re-authenticate to keep using the advisor.</span>
          <button className="button button-secondary" type="button" onClick={() => window.location.reload()}>Sign in again</button>
        </div>
      ) : null}

      <section className="regulatory-banner panel">
        <div className="regulatory-icon"><ShieldCheck size={22} /></div>
        <div>
          <Eyebrow>Safety boundary · KDIGO + EU MDR posture</Eyebrow>
          <h2>CDSS recommends · never orders · iron first</h2>
          <p>The advisor proposes an ESA dose adjustment against the 10–12 g/dL KDIGO band. Any change reaches a patient only as a Class C (nephrologist) approval in My Work. Stale iron status or a microcytic picture blocks a recommendation outright.</p>
        </div>
        <Tag tone="violet"><LockKeyhole size={11} /> no autonomous ordering</Tag>
      </section>

      <section className="metrics-grid" aria-label="Anemia program metrics">
        <Metric label="Hb in band" value={kpis ? `${kpis.hgbInBandPct}%` : "—"} detail="Target 10–12 g/dL" tone="mint" />
        <Metric label="Low-EPO requirement" value={kpis ? `${kpis.esaLowEpoRequirement}%` : "—"} detail="Manifold low-dose cluster" />
        <Metric label="At-risk escalation" value={kpis ? String(kpis.atRiskEscalation) : "—"} detail="ESA dose creep / flat Hb" tone="amber" />
        <Metric label="Value at risk" value={kpis ? `$${(kpis.valueAtRiskUsd / 1000).toFixed(0)}k` : "—"} detail="Avoidable ESA spend / yr" tone="red" />
      </section>

      {error ? <div className="admin-notice is-error"><AlertTriangle size={15} /><span>{error}</span></div> : null}

      <section className="esa-main-grid">
        {/* ---- Advisor console ---- */}
        <article className="panel esa-console">
          <div className="panel-title-row">
            <div><Eyebrow>ESA dose advisor · surrogate {features?.model.id ?? "anemia.esa-dose-v0"}</Eyebrow><h2>Patient feature window</h2></div>
            <PanelExpand label="ESA advisor console" />
          </div>
          <p className="esa-hint">Enter the patient&apos;s current weekly window — the advisor returns a dose direction, drivers and the latent manifold position. Review epoch {REVIEW_AT.slice(0, 10)}.</p>

          <div className="admin-form-grid esa-form-grid">
            <label className="admin-form-wide"><span>Patient id</span><input aria-label="Patient id" value={form.patientId} onChange={(e) => set("patientId", e.target.value)} placeholder="p-esa-1" /></label>
            <label><span>Current Hb (g/dL)</span><input aria-label="Current hemoglobin" type="number" step="0.1" value={form.currentHgb} onChange={(e) => set("currentHgb", e.target.value)} /></label>
            <label><span>Current ESA dose (u/wk)</span><input aria-label="Current ESA dose" type="number" step="500" value={form.currentDose} onChange={(e) => set("currentDose", e.target.value)} /></label>
            <div className="esa-field-toggle"><span>On ESA</span><label className="config-toggle"><input type="checkbox" checked={onESA} onChange={(e) => setOnESA(e.target.checked)} /><span /><strong>{onESA ? "Yes" : "No"}</strong></label></div>
            <label><span>Last iron panel</span><input aria-label="Last iron panel date" type="date" value={form.lastIronPanelAt} onChange={(e) => set("lastIronPanelAt", e.target.value)} /></label>
            <label><span>MCV (fL)</span><input aria-label="MCV" type="number" value={form.mcv} onChange={(e) => set("mcv", e.target.value)} placeholder="92" /></label>
            <label><span>Ferritin (ng/mL)</span><input aria-label="Ferritin" type="number" value={form.ferritin} onChange={(e) => set("ferritin", e.target.value)} placeholder="640" /></label>
            <label><span>TSAT (%)</span><input aria-label="Transferrin saturation" type="number" value={form.transferrinSat} onChange={(e) => set("transferrinSat", e.target.value)} placeholder="28" /></label>
            <label><span>CRP (mg/L)</span><input aria-label="CRP" type="number" value={form.crp} onChange={(e) => set("crp", e.target.value)} placeholder="6" /></label>
            <label><span>Calcium (mg/dL)</span><input aria-label="Calcium" type="number" step="0.1" value={form.calcium} onChange={(e) => set("calcium", e.target.value)} placeholder="9.2" /></label>
            <label><span>PTH (pg/mL)</span><input aria-label="PTH" type="number" value={form.pth} onChange={(e) => set("pth", e.target.value)} placeholder="120" /></label>
          </div>

          <div className="esa-actions">
            <button className="button button-primary" type="button" disabled={busy !== null} onClick={() => void runAdvise()}>{busy === "advise" ? <RefreshCw size={14} className="spin" /> : <Dna size={14} />} Run advisor</button>
            <span className="esa-actions-note"><HeartPulse size={13} /> Band {features ? `${features.hgbTarget.min}–${features.hgbTarget.max} g/dL` : "10–12"} · step 500 u/wk</span>
          </div>

          {rec ? (
            <div className={`esa-reco esa-reco-${rec.direction}`}>
              <div className="esa-reco-head">
                <div>
                  <Eyebrow>Recommendation · {rec.patientId}</Eyebrow>
                  <h3>{directionMeta?.label}</h3>
                  <p>{rec.note}</p>
                </div>
                <Tag tone={directionMeta?.tone ?? "neutral"}>{directionMeta?.label}</Tag>
              </div>

              <div className="esa-reco-dose">
                <div><small>Current dose</small><strong>{fmtDose(rec.currentDose)}</strong></div>
                <div className="esa-reco-arrow">{rec.delta >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}<span>{rec.delta === 0 ? "no change" : `${rec.delta > 0 ? "+" : ""}${rec.delta.toLocaleString()} u/wk`}</span></div>
                <div><small>Recommended</small><strong>{fmtDose(rec.recommendedDose)}</strong></div>
              </div>

              {hasFlags ? (
                <div className="esa-flags">
                  {rec?.guardrails.flags.map((flag) => <span key={flag} className={rec?.guardrails.blocked ? "esa-chip is-block" : "esa-chip"}>{flag.replace(/-/g, " ")}</span>)}
                </div>
              ) : null}
              {rec?.guardrails.blocked && rec.guardrails.blockReason ? (
                <div className="esa-block-banner"><AlertTriangle size={15} /><span>{rec.guardrails.blockReason}</span></div>
              ) : null}
              {rec?.coverage ? rec.coverage.covered ? (
                <div className="esa-coverage-ok"><CheckCircle2 size={13} /><span>Coverage · in reference manifold (distance {rec.coverage.manifold.distance.toFixed(2)} ≤ {rec.coverage.manifold.threshold}) · lab density {rec.coverage.labDensity.observed}/{rec.coverage.labDensity.required}</span></div>
              ) : (
                <div className="esa-block-banner"><ShieldAlert size={15} /><span>{rec.coverage.reason ?? rec.note}</span></div>
              ) : null}

              <div className="esa-reco-cols">
                <div className="esa-reco-drivers">
                  <Eyebrow>Dominant drivers · permutation relevance</Eyebrow>
                  {rec?.drivers.slice(0, 6).map((d) => (
                    <div className="esa-driver" key={d.id}>
                      <span><strong>{d.label}</strong><small>{d.id}</small></span>
                      <div className="esa-driver-bar"><i style={{ width: `${maxRelevance ? Math.round((d.relevance / maxRelevance) * 100) : 0}%` }} /></div>
                      <em>{Math.round(d.relevance * 100)}%</em>
                    </div>
                  ))}
                </div>
                <div className="esa-latent">
                  <Eyebrow>Latent manifold position</Eyebrow>
                  <div className="esa-latent-readout">
                    <span><Activity size={13} /> Axis 1 · iron substrate</span><strong>{rec?.latent.l1.toFixed(2)}</strong>
                    <span><FlaskConical size={13} /> Axis 2 · ESA resistance</span><strong>{rec?.latent.l2.toFixed(2)}</strong>
                    <span><Gauge size={13} /> Polar radius</span><strong>{rec?.latent.polarRadius.toFixed(2)}</strong>
                    <span><Info size={13} /> Angle</span><strong>{Math.round((rec?.latent.polarAngleRad ?? 0) * 180 / Math.PI)}°</strong>
                  </div>
                  <p>Low axis-1 + high axis-2 marks the high-ESA-resistance, iron-poor region; low radius on both axes marks the low-EPO-requirement cluster where dose reduction is safe.</p>
                  <Tag tone="amber"><Sparkles size={11} /> {rec?.model.id} v{rec?.model.version} · synthetic</Tag>
                </div>
              </div>
            </div>
          ) : null}
        </article>

        {/* ---- Feature catalog + cells ---- */}
        <article className="panel esa-catalog">
          <div className="panel-title-row">
            <div><Eyebrow>Feature catalog · paper Table 1</Eyebrow><h2>Bounded anemia cells</h2></div>
            <Tag tone="mint">2 cells · Class C</Tag>
          </div>
          <div className="esa-band-card">
            <div><small>KDIGO target band</small><strong>{features ? `${features.hgbTarget.min}–${features.hgbTarget.max}` : "10–12"} <em>g/dL</em></strong></div>
            <div><small>Step size</small><strong>500 <em>u/wk</em></strong></div>
            <div><small>Safety class</small><strong>Class C <em>MD approval</em></strong></div>
          </div>
          <div className="esa-cell-list">
            {state?.cells.map((cell) => (
              <div className="esa-cell" key={cell.id}>
                <span className="esa-cell-icon"><Beaker size={15} /></span>
                <div><strong>{cell.displayName}</strong><small>{cell.id} · {cell.owner}</small></div>
                <Tag tone="violet">C</Tag>
              </div>
            ))}
          </div>
          <div className="esa-feature-table">
            <div className="esa-feature-head"><span>Feature</span><span>Relevance</span></div>
            {features?.features.map((f) => (
              <div className="esa-feature-row" key={f.id}>
                <span><strong>{f.label}</strong><small>{f.loinc ?? "loinc —"} · {f.unit}</small></span>
                <div className="esa-driver-bar"><i style={{ width: `${maxRelevance ? Math.round((f.relevance / maxRelevance) * 100) : 0}%` }} /></div>
                <em>{Math.round(f.relevance * 100)}%</em>
              </div>
            ))}
          </div>
          <p className="esa-catalog-note">Prior EPO dominates (40%), then MCV (16%) — the same ordering the paper&apos;s permutation analysis reports. In the P2 trained model these weights become learned.</p>
        </article>
      </section>

      {/* ---- Durable episodes ---- */}
      <section className="panel esa-episodes">
        <div className="panel-title-row">
          <div><Eyebrow>Durable episodes · shared coordinator · My Work</Eyebrow><h2>Anemia management loop</h2></div>
          <div className="esa-episode-actions">
            <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void runDemo()}>{busy === "demo" ? <RefreshCw size={14} className="spin" /> : <CloudDownload size={14} />} Seed demo</button>
            <button className="button button-ghost" type="button" disabled={busy !== null || episodes.length === 0} onClick={() => void runReset()}>{busy === "reset" ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />} Reset</button>
          </div>
        </div>
        {episodes.length === 0 ? (
          <div className="esa-empty"><Beaker size={22} /><span><strong>No anemia episodes yet</strong><small>Run “Seed demo” to open an AwaitingApproval (Class C) episode for My Work and replay the full approve → titrate → verify loop.</small></span><button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void runDemo()}><CloudDownload size={14} /> Seed demo</button></div>
        ) : (
          <div className="esa-episode-list">
            {episodes.map((ep) => {
              const title = episodeTitle(ep.kind, ep.subject);
              const classC = ep.proposal?.approvalClass ?? ep.approval?.approvalClass;
              const measure = ep.measureResult;
              return (
                <div className="esa-ep-row" key={ep.episodeId}>
                  <div className="esa-ep-main">
                    <span className="esa-ep-icon"><UserRound size={15} /></span>
                    <div><strong>{title}</strong><small>episode {ep.episodeId} · opened {new Date(ep.openedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></div>
                    <Tag tone={EP_TONE[ep.state] ?? "neutral"}>{ep.state}</Tag>
                    {classC ? <Tag tone="violet">Class {classC}</Tag> : null}
                  </div>
                  {ep.proposal?.recommendation ? <p className="esa-ep-reco">{ep.proposal.recommendation}</p> : null}
                  <div className="esa-ep-foot">
                    {ep.command?.effect ? <span><ClipboardCheck size={12} /> {ep.command.effect.replace(/-/g, " ")}</span> : null}
                    {ep.approval?.decision ? <span><ShieldCheck size={12} /> approved by {ep.approval.by} ({ep.approval.approvalClass})</span> : null}
                    {measure ? <span><Activity size={12} /> {measure.measureId} · {measure.met ? "met" : "not met"}</span> : null}
                    {ep.state === "AwaitingApproval" && onNavigate ? (
                      <button className="esa-ep-open" type="button" onClick={() => onNavigate("my-work")}>Open in My Work <ArrowRight size={13} /></button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- P1 · Advisor governance & coverage gate ---- */}
      <section className="panel esa-governance">
        <div className="panel-title-row">
          <div><Eyebrow>P1 · safe by default · EU AI Act / MDR</Eyebrow><h2>Advisor governance &amp; coverage gate</h2></div>
          <div className="esa-gov-actions">
            <Tag tone={assurance?.gate.status === "active" ? "mint" : assurance?.gate.status === "blocked" ? "red" : "amber"}>{assurance?.gate.status ?? "…"}</Tag>
            <button className="button button-secondary" type="button" disabled={govBusy !== null} onClick={() => void runRedTeam()}>{govBusy === "redteam" ? <RefreshCw size={14} className="spin" /> : <ShieldAlert size={14} />} Run red team</button>
            <button className="button button-ghost" type="button" disabled={govBusy !== null} onClick={() => void runDrift()}>{govBusy === "drift" ? <RefreshCw size={14} className="spin" /> : <Radar size={14} />} Drift snapshot</button>
          </div>
        </div>
        {govError ? <div className="admin-notice is-error"><AlertTriangle size={15} /><span>{govError}</span></div> : null}
        {!assurance ? (
          <div className="esa-gov-loading"><span>Loading assurance…</span></div>
        ) : (
          <div className="esa-gov-grid">
            <div className="esa-gov-col">
              <Eyebrow>Activation gates · interpretability + coverage + red team + posture</Eyebrow>
              <div className="esa-gate-list">
                {assurance.gate.gates.map((g) => (
                  <div className="esa-gate-row" key={g.name}>
                    <span className={g.passed ? "esa-gate-dot is-pass" : "esa-gate-dot is-fail"} />
                    <strong>{g.name}</strong>
                    <small>{g.observed}</small>
                    <Tag tone={g.passed ? "mint" : "red"}>{g.passed ? "pass" : "fail"}</Tag>
                  </div>
                ))}
              </div>
              {assurance.gate.reasons.length ? (
                <div className="esa-block-banner"><ShieldAlert size={15} /><span>{assurance.gate.reasons.join(" · ")}</span></div>
              ) : (
                <div className="esa-coverage-ok"><ShieldCheck size={13} /><span>Advisor may recommend (Class C only) — {assurance.gate.posture?.posture ?? "CDSS · HITL"} · {assurance.gate.posture?.approvalClass ?? "C"} · never autonomous</span></div>
              )}
              <div className="esa-gov-facts">
                <span><small>Model registry</small><strong>{assurance.model.registered ? assurance.model.record?.modelVersion ?? "registered" : "not registered"}</strong></span>
                <span><small>Coverage gate</small><strong>{assurance.coverage.enabled ? `on · ≥${assurance.coverage.defaults.minTrendSamples} Hb · radius ${assurance.coverage.defaults.manifoldRadius}` : "off"}</strong></span>
                <span><small>Open findings</small><strong>{assurance.findings.filter((f) => f.status !== "closed").length}</strong></span>
              </div>
            </div>
            <div className="esa-gov-col">
              <Eyebrow>Red-team probes rt-013…rt-016 · behavioral containment</Eyebrow>
              <div className="esa-probe-list">
                {assurance.redTeam.scenarios.map((s) => (
                  <div className="esa-probe-row" key={s.id}>
                    <strong>{s.id}</strong>
                    <span>{s.name}</span>
                    <small>{s.probe.checks[0]?.observed ?? ""}</small>
                    <Tag tone={s.probe.passed ? "mint" : "red"}>{s.probe.passed ? "contained" : "unsafe"}</Tag>
                  </div>
                ))}
              </div>
              <Eyebrow>Drift snapshots · {ESA_MODEL_ID}</Eyebrow>
              {assurance.drift.length === 0 ? (
                <p className="esa-gov-note">No drift snapshots yet — run “Drift snapshot” to write a KS snapshot.</p>
              ) : (
                <div className="esa-drift-list">
                  {assurance.drift.map((d) => (
                    <div className="esa-drift-row" key={d.driftId}>
                      <span><Radar size={12} /> {d.metric}</span>
                      <em>{Math.round(d.valueBasisPoints / 100)}%</em>
                      <Tag tone={d.status === "healthy" ? "mint" : "amber"}>{d.status}</Tag>
                    </div>
                  ))}
                </div>
              )}
              <p className="esa-gov-note">Coverage is a P1 gate — out-of-domain or low-density windows get a blocked verdict with a visible reason. Findings are immutable; red-team failures under an unsafe policy block the advisor gate.</p>
            </div>
          </div>
        )}
      </section>

      {/* ---- P3 · External validation & regulatory file ---- */}
      <section className="panel esa-governance">
        <div className="panel-title-row">
          <div><Eyebrow>P3 · external validation &amp; regulatory readiness</Eyebrow><h2>Validation, study-mode &amp; MDR file</h2></div>
          <div className="esa-gov-actions">
            {validation?.report ? <Tag tone={validation.report.verdict.passed ? "mint" : "red"}>validation {validation.report.verdict.passed ? "passed" : "failed"}</Tag> : null}
            {study ? <Tag tone="violet">acceptance {study.stats.acceptanceRatePct}%</Tag> : null}
            <button className="button button-secondary" type="button" disabled={p3Busy !== null} onClick={() => void runExternalValidation()}>{p3Busy === "validation" ? <RefreshCw size={14} className="spin" /> : <Beaker size={14} />} Run external validation</button>
            <button className="button button-ghost" type="button" disabled={p3Busy !== null} onClick={() => void recordSampleStudy()}>{p3Busy === "study" ? <RefreshCw size={14} className="spin" /> : <ClipboardCheck size={14} />} Record sample decisions</button>
          </div>
        </div>
        {p3Error ? <div className="admin-notice is-error"><AlertTriangle size={15} /><span>{p3Error}</span></div> : null}
        <div className="esa-p3-grid">
          <div className="esa-gov-col">
            <Eyebrow>External cohort · independent site-B</Eyebrow>
            {!validation?.report ? (
              <p className="esa-gov-note">No external validation report yet — run “Run external validation” to score the trained model against an independent cohort (protocol: MAE, % within one dose, quartiles, Spearman, Hb-forecast &lt; 10%).</p>
            ) : (
              <>
                <div className="esa-gov-facts">
                  <span><small>Site / cohort</small><strong>{validation.report.siteId} · {validation.report.cohortSize}</strong></span>
                  <span><small>MAE (u/wk)</small><strong>{validation.report.metrics.maeUnits}</strong></span>
                  <span><small>Within one step</small><strong>{validation.report.metrics.withinOneStepPct}%</strong></span>
                </div>
                <div className="esa-val-metrics">
                  <div className="esa-drift-row"><span><Radar size={12} /> Spearman</span><em>{validation.report.metrics.spearman}</em><Tag tone="mint">rank</Tag></div>
                  <div className="esa-drift-row"><span><Activity size={12} /> Hb-forecast MAE</span><em>{validation.report.metrics.hbForecastMaePct}%</em><Tag tone={validation.report.metrics.hbForecastMaePct < 10 ? "mint" : "amber"}>&lt;10% bar</Tag></div>
                  <div className="esa-drift-row"><span><Gauge size={12} /> Error quartiles</span><em>q1 {validation.report.metrics.errorQuartiles.q1} · med {validation.report.metrics.errorQuartiles.median} · q3 {validation.report.metrics.errorQuartiles.q3}</em></div>
                </div>
                <p className="esa-gov-note">{validation.report.verdict.reason} Report for {validation.report.modelId} v{validation.report.modelVersion} is durable and consumed by assurance.</p>
              </>
            )}
          </div>
          <div className="esa-gov-col">
            <Eyebrow>Study-mode · suggest, don&apos;t auto-act</Eyebrow>
            {study ? (
              <>
                <div className="esa-gov-facts">
                  <span><small>Decisions</small><strong>{study.stats.total}</strong></span>
                  <span><small>Acceptance</small><strong>{study.stats.acceptanceRatePct}%</strong></span>
                  <span><small>Clinician retained control</small><strong>{study.stats.clinicianRetainedControlPct}%</strong></span>
                </div>
                <div className="esa-probe-list">
                  {study.records.slice(0, 6).map((r) => (
                    <div className="esa-probe-row" key={r.id}>
                      <strong>{r.patientId}</strong>
                      <span>{r.clinicianAction}</span>
                      <small>{r.by}{r.adjustedDose !== undefined ? ` → ${r.adjustedDose}` : ""}</small>
                      <Tag tone={r.clinicianAction === "accepted" ? "mint" : r.clinicianAction === "adjusted" ? "amber" : "red"}>{r.clinicianAction}</Tag>
                    </div>
                  ))}
                </div>
                <p className="esa-gov-note">Every suggestion is Class C — the clinician accepts, adjusts, rejects or withholds; the platform records adoption (the paper’s physician-trust finding).</p>
              </>
            ) : null}
          </div>
          <div className="esa-gov-col">
            <Eyebrow>MDR / EU AI Act technical file</Eyebrow>
            {mdr ? (
              <>
                <div className="esa-gov-facts">
                  <span><small>Risk class</small><strong>{mdr.riskClass.aiAct}</strong></span>
                  <span><small>MDR</small><strong>{mdr.riskClass.mdr}</strong></span>
                  <span><small>Autonomy</small><strong>{mdr.hitlDesignRecord.autonomy}</strong></span>
                </div>
                <p className="esa-mdr-intent">{mdr.intendedUse}</p>
                <ul className="esa-mdr-list">
                  {mdr.clinicalEvaluationPlan.map((p) => <li key={p}>{p}</li>)}
                </ul>
                <div className="esa-flags">
                  <span className="esa-chip"><ShieldCheck size={11} /> Class {mdr.hitlDesignRecord.approvalClass} · {mdr.hitlDesignRecord.role}</span>
                  <span className="esa-chip">{mdr.synthetic ? "synthetic file — P3 real cohorts pending" : "real"}</span>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
