"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Beaker,
  ClipboardCheck,
  CloudDownload,
  Dna,
  FlaskConical,
  Gauge,
  HeartPulse,
  Info,
  LockKeyhole,
  RefreshCw,
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
  fetchAnemiaFeatures,
  fetchAnemiaState,
  resetAnemiaDemo,
  seedAnemiaDemo,
  type AnemiaStateView,
  type EsaDirection,
  type EsaFeaturesView,
  type EsaRecommendation,
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

  useEffect(() => {
    let active = true;
    void fetchAnemiaFeatures().then((f) => { if (active) setFeatures(f); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "features load failed"); });
    void fetchAnemiaState().then((s) => { if (active) setState(s); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "state load failed"); });
    return () => { active = false; };
  }, []);

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
    </div>
  );
}
