"use client";

import { useEffect, useMemo, useState } from "react";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FlaskConical,
  HeartHandshake,
  MapPin,
  ShieldCheck,
  Stethoscope,
  Target,
} from "lucide-react";
import { assessmentResponses, outcomeEpisodes, patientTimeline } from "../lib/catalogs";
import { fetchEarlyWarning, fetchPatientEvents, startLivePatients, type EarlyWarningReadout, type HarnessPatient, type RuntimeEventRow } from "../lib/harness";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

const EW_TONE: Record<string, "mint" | "amber" | "red" | "violet" | "neutral"> = {
  corroborated: "red",
  weak: "amber",
  contested: "violet",
  reassured: "mint",
};

function patientLabel(p?: HarnessPatient): string {
  if (!p) return "—";
  const [facility, num] = p.id.split("-pt-");
  return `${facility ?? p.realmId} · Patient ${(num ?? p.id).padStart(2, "0")}`;
}

function patientInitials(p?: HarnessPatient): string {
  const num = p?.id.split("-pt-").pop()?.replace(/\D/g, "") ?? "";
  return `P${num.padStart(2, "0").slice(-2)}`;
}

type LabFlag = { code: string; value: string; flag: "ok" | "H" | "L" };

function labFlags(labs?: HarnessPatient["state"]["labs"]): LabFlag[] {
  if (!labs) return [];
  const out: LabFlag[] = [];
  if (typeof labs.K === "number") out.push({ code: "K", value: `${labs.K.toFixed(1)} mmol/L`, flag: labs.K > 5.5 ? "H" : labs.K < 3.5 ? "L" : "ok" });
  if (typeof labs.HGB === "number") out.push({ code: "HGB", value: `${labs.HGB.toFixed(1)} g/dL`, flag: labs.HGB < 10 ? "L" : "ok" });
  if (typeof labs.URR === "number") out.push({ code: "URR", value: `${labs.URR}%`, flag: labs.URR < 65 ? "L" : "ok" });
  if (typeof labs.PHOS === "number") out.push({ code: "PHOS", value: `${labs.PHOS.toFixed(1)} mg/dL`, flag: labs.PHOS > 5.5 ? "H" : "ok" });
  return out;
}

function riskTone(risk?: number): "mint" | "amber" | "red" {
  if (risk === undefined) return "mint";
  if (risk > 0.6) return "red";
  if (risk > 0.3) return "amber";
  return "mint";
}

export default function PatientIntelligence({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const [patients, setPatients] = useState<HarnessPatient[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [patientEvents, setPatientEvents] = useState<RuntimeEventRow[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [watch, setWatch] = useState<EarlyWarningReadout[] | null>(null);

  // DST-Q #2 — early-warning watch: poll the server-fused cohort so new signals
  // (or a manual signal entry elsewhere) move the watch live without a reload.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const view = await fetchEarlyWarning();
        if (active) setWatch(view.cohort ?? []);
      } catch { /* advisory watch — never blocks the page */ }
    };
    void poll();
    timer = setInterval(() => void poll(), 6000);
    return () => { active = false; if (timer) clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    // Live patient list — the selector renders immediately, then keeps refreshing
    // so newly-spawned sim patients appear without a page reload.
    const stopPatients = startLivePatients((list) => {
      if (!active) return;
      setPatients(list);
      setSelectedId((prev) => (prev && list.some((p) => p.id === prev) ? prev : list[0]?.id ?? ""));
      setLoading(false);
    }, { intervalMs: 8000 });
    return () => { active = false; stopPatients(); };
  }, []);

  // Lightweight patient-scoped ledger — fetch only the selected patient's recent
  // events (the page used to subscribe to the full global runtime substrate,
  // which made Member/Patient intelligence slow as the fleet grew).
  const eventsReady = !loading && !!selectedId;
  useEffect(() => {
    if (!eventsReady) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      try {
        const row = await fetchPatientEvents(selectedId, 120);
        if (!active) return;
        setPatientEvents(row.events);
        setLedgerTotal(row.total);
      } catch { /* advisory — keep last known ledger */ }
    };
    void load();
    timer = setInterval(() => void load(), 6000);
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [eventsReady, selectedId]);

  const selected = useMemo(() => patients.find((p) => p.id === selectedId) ?? patients[0], [patients, selectedId]);

  const st = selected?.state ?? {};
  const vitals = st.lastVitals ?? {};
  const flags = labFlags(st.labs);
  const risk = typeof st.risk === "number" ? st.risk : undefined;
  const trajectory = st.trajectory ?? "unknown";
  // DST-Q #2 — selected patient's fused watch (if any) + cohort-level alerts.
  const selectedWatch = (watch ?? []).find((r) => r.patientId === selected?.id) ?? null;
  const cohortAlerts = (watch ?? []).filter((r) => r.alert);
  const problems = Array.isArray(st.problemList) ? st.problemList : [];
  const assessment = st.lastAssessment && typeof st.lastAssessment === "object"
    ? (st.lastAssessment as { id?: string; score?: number; band?: string; at?: string })
    : undefined;
  // Patient-scoped ledger: the endpoint returns this patient's events only,
  // newest-first; cap at the latest 50 to keep the DOM small.
  const realmEvents = patientEvents.slice(0, 50);
  const evidenceTotal = ledgerTotal || realmEvents.length;
  const scope = selected ? `${selected.realmId} · ${selected.id}` : "—";

  function openDetail(kind: string, title: string, summary: string, value: string, tone: "mint" | "amber" | "red" | "blue" = "mint") {
    onOpenDetail({
      id: `${kind}-${selected?.id ?? "pt"}`,
      kind,
      title,
      summary,
      status: value,
      tone,
      owner: "Facility coordinator",
      scope,
      metrics: [{ label: "Evidence objects", value: String(evidenceTotal) }, { label: "Realm", value: selected?.realmId ?? "—" }],
      evidence: [],
      steps: [{ label: "Observe", detail: "Source events accepted", state: "done" }, { label: "Reconcile", detail: "Bitemporal state assembled", state: "done" }, { label: "Review", detail: summary, state: "current" }, { label: "Verify", detail: "Await future event", state: "pending" }],
      primary: { label: "Open Shared Intelligence", target: "intelligence" },
    });
  }

  if (loading) {
    return <div className="module-loading"><div className="module-loading-orbit" /><p>Loading patients…</p></div>;
  }
  if (!selected) {
    return (
      <div className="view-stack patient-view">
        <header className="view-heading">
          <div>
            <Eyebrow>Patient intelligence</Eyebrow>
            <h1>No patients available</h1>
            <p>Live realms have no patients yet. Start the demo simulator (Renal Swarm → Simulator) or create a realm with a patient population, then return here.</p>
          </div>
        </header>
      </div>
    );
  }

  const stateCards = [
    { label: "Trajectory", value: trajectory, detail: risk !== undefined ? `risk ${Math.round(risk * 100)}%` : "learned projection", tone: riskTone(risk), icon: Target },
    { label: "Heart rate", value: vitals.hr ? `${vitals.hr} bpm` : "—", detail: vitals.at ? new Date(vitals.at).toLocaleString() : "no vitals recorded", tone: "mint", icon: Activity },
    { label: "SpO₂", value: vitals.spo2 ? `${vitals.spo2}%` : "—", detail: vitals.bp ? `BP ${vitals.bp}` : "not captured", tone: "mint", icon: HeartHandshake },
    { label: "Labs", value: flags.length ? flags[0]!.code : "—", detail: flags.length ? flags.map((f) => `${f.code} ${f.value}${f.flag !== "ok" ? ` · ${f.flag}` : ""}`).join("  ") : "no labs yet", tone: flags.some((f) => f.flag !== "ok") ? "amber" : "mint", icon: FlaskConical },
  ];

  return (
    <div className="view-stack patient-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Patient intelligence · live realm patients</Eyebrow>
          <h1>{patientLabel(selected)}</h1>
          <p>Select a patient to inspect its assembled state — vitals, labs, trajectory and risk projected from the live realm.</p>
        </div>
        <div className="heading-actions">
          <label className="patient-select">
            <span>Patient</span>
            <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)} aria-label="Select patient">
              {patients.map((p) => <option key={p.id} value={p.id}>{patientLabel(p)} · {p.realmId}</option>)}
            </select>
          </label>
          <Tag tone="violet"><ShieldCheck size={12} /> {selected.realmId} · {patients.length} patients</Tag>
          <button className="button button-secondary" type="button" onClick={() => openDetail("Evidence brief", "Evidence brief", "Review the exact sources and provenance before exporting.", `${evidenceTotal} objects`)}><ClipboardList size={15} /> Inspect evidence</button>
        </div>
      </header>

      <section className="patient-identity panel">
        <div className="patient-hero-avatar">{patientInitials(selected)}</div>
        <div className="patient-identity-copy">
          <div className="inline-cluster"><h2>{patientLabel(selected)}</h2><Tag tone={riskTone(risk)}>{trajectory}</Tag></div>
          <p>Age {st.age ?? "—"} · {st.sex ?? "unknown"} · {st.facilityId ?? "—"} · unit {st.unitId ?? "—"} · {selected.realmId}</p>
          <div className="identity-facts">
            <span><MapPin size={13} /> {st.facilityId ?? "unknown facility"}</span>
            <span><CheckCircle2 size={13} /> {st.admitted ? "Admitted" : "Not admitted"}</span>
            <span><ShieldCheck size={13} /> {problems.length ? `${problems.length} problem(s) on record` : "No problems listed"}</span>
          </div>
        </div>
        <div className="trust-score"><small>Deterioration risk</small><strong>{risk !== undefined ? `${Math.round(risk * 100)}%` : "—"}</strong><span>{evidenceTotal} evidence objects reconciled</span></div>
      </section>

      <section className="panel patient-early-watch" aria-label="Early-warning watch">
        <div className="panel-title-row">
          <div><Eyebrow>Early-warning watch · Dempster–Shafer fusion</Eyebrow><h2>Deterioration watch — vitals + labs + missed Tx + ESA response</h2></div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}><Tag tone={cohortAlerts.length ? "red" : "mint"}>{cohortAlerts.length} alert(s)</Tag></div>
        </div>
        {selectedWatch ? (
          <div className={`ew-card ew-${selectedWatch.posture}`}>
            <div className="ew-head">
              <span className={`tag tag-${EW_TONE[selectedWatch.posture] ?? "neutral"}`}>evidence {selectedWatch.posture}</span>
              <strong>Bel {selectedWatch.belief.toFixed(2)}</strong>
              <span>Pl {selectedWatch.plausibility.toFixed(2)}</span>
              <span>K {selectedWatch.conflictMass.toFixed(2)}</span>
              <span className="ew-count">{selectedWatch.signalCount} signal(s)</span>
            </div>
            {selectedWatch.alert ? (
              <div className="ew-alert"><AlertTriangle size={14} /><span>Auto-flagged — {selectedWatch.signalCount} independent signals agree on deterioration (Bel ≥ {selectedWatch.belief.toFixed(2)}, K {selectedWatch.conflictMass.toFixed(2)}). Escalate to the region MD / open an outcome episode.</span></div>
            ) : selectedWatch.posture === "contested" ? (
              <div className="ew-contested"><ShieldCheck size={14} /><span>Contested — alarming and reassuring evidence conflict (K {selectedWatch.conflictMass.toFixed(2)} ≥ contested gate). Held for human verification; never auto-flagged.</span></div>
            ) : (
              <p className="ew-copy">No auto-flag — {selectedWatch.posture === "weak" ? "commitment is building but below the alert gate" : "commitment to deterioration is low"}. Bel {selectedWatch.belief.toFixed(2)} · Pl {selectedWatch.plausibility.toFixed(2)} — the watch keeps fusing new signals as they arrive.</p>
            )}
            <div className="ew-signals">{selectedWatch.signals.slice(0, 8).map((s, i) => (
              <span key={`${s.kind}-${i}`} className={`ew-signal ${s.polarity}`} title={`reliability α ${s.alpha.toFixed(2)}`}>{s.polarity === "deteriorating" ? "▲" : "▽"} {s.label}</span>
            ))}</div>
            <p className="ew-footnote">Advisory watch — complements the CfC/LTC trajectory forecast. An auto-flag is a recommendation to review, never a diagnosis or an order.</p>
          </div>
        ) : (
          <p className="ew-copy">No fused watch for this patient yet{selected ? ` (${selected.id})` : ""} — the cohort below shows patients with active signal fusion.</p>
        )}
        {cohortAlerts.length ? (
          <div className="ew-alert-list">
            <Eyebrow>Cohort alerts · {cohortAlerts.length}</Eyebrow>
            {cohortAlerts.map((a) => (
              <button className="ew-alert-row" type="button" key={a.patientId} onClick={() => setSelectedId(a.patientId)}>
                <span className="tag tag-red">{a.patientId}</span>
                <span className="ew-row-copy">Bel {a.belief.toFixed(2)} · Pl {a.plausibility.toFixed(2)} · {a.signalCount} signals · {a.facilityId ?? "—"}</span>
                <span className="ew-row-arrow">open →</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="state-grid" aria-label="Current patient state">
        {stateCards.map((card) => {
          const Icon = card.icon;
          return (
            <button className="state-card drillable-surface" type="button" onClick={() => openDetail(`STATE-${card.label.toUpperCase()}`, card.label, card.detail, card.value)} key={card.label}>
              <div className={`state-icon state-${card.tone}`}><Icon size={17} /></div>
              <div><small>{card.label}</small><strong>{card.value}</strong><span>{card.detail}</span></div>
            </button>
          );
        })}
      </section>

      <section className="patient-main-grid">
        <article className="panel patient-narrative">
          <div className="panel-title-row">
            <div><Eyebrow>Vitals &amp; labs</Eyebrow><h2>Latest observations</h2></div>
            <Stethoscope size={18} />
          </div>
          <div className="narrative-block">
            <p>This patient is on a <strong>{trajectory}</strong> trajectory{risk !== undefined ? ` with a ${Math.round(risk * 100)}% deterioration risk` : ""}. Last vitals {vitals.hr ? `HR ${vitals.hr} bpm` : ""}{vitals.spo2 ? ` · SpO₂ ${vitals.spo2}%` : ""}{vitals.bp ? ` · BP ${vitals.bp}` : ""}{vitals.at ? ` — recorded ${new Date(vitals.at).toLocaleString()}` : ""}.</p>
            <div className="citation-row"><span>Realm ledger projection</span><span>{selected.realmId}</span><span>{vitals.at ? new Date(vitals.at).toLocaleString() : "no vitals yet"}</span></div>
          </div>
          <div className="ledger-table" style={{ marginTop: 6 }}>
            <div className="ledger-head"><span>Lab</span><span>Value</span><span>Status</span></div>
            {flags.length ? flags.map((f) => (
              <div className="ledger-row" key={f.code}><strong>{f.code}</strong><span>{f.value}</span><span className={`lab-flag ${f.flag === "ok" ? "ok" : "bad"}`}>{f.flag === "ok" ? "within range" : f.flag}</span></div>
            )) : <div className="ledger-row"><strong>—</strong><span>No lab results yet</span><span className="lab-flag ok">pending</span></div>}
          </div>
          <div className="narrative-boundary">
            <ShieldCheck size={17} />
            <div><strong>Grounding boundary active</strong><p>The projection summarizes realm evidence. It cannot diagnose, prescribe, alter orders or infer unsupported facts.</p></div>
          </div>
        </article>

        <aside className="panel outcome-loops-panel">
          <div className="panel-title-row"><div><Eyebrow>Clinical context</Eyebrow><h2>Trajectory · risk · problems</h2></div><span className="mini-count">{problems.length}</span></div>
          <div className="patient-context" style={{ marginBottom: 12 }}><Tag tone={riskTone(risk)}><AlertTriangle size={11} /> Risk {risk !== undefined ? `${Math.round(risk * 100)}%` : "—"}</Tag><Tag tone="mint">Trajectory {trajectory}</Tag></div>
          <ProgressBar value={risk !== undefined ? Math.round(risk * 100) : 0} tone={riskTone(risk)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {problems.map((problem) => <span className="problem-chip" key={problem}>{problem}</span>)}
            {!problems.length && <span className="problem-chip">No problems listed</span>}
          </div>
          <div className="patient-context" style={{ marginTop: 14 }}>
            {assessment
              ? <><span>Last assessment</span><strong>{assessment.id ?? "assessment"} · score {assessment.score ?? "—"} · {assessment.band ?? "—"}</strong></>
              : <><span>Assessment</span><strong>No assessment recorded yet</strong></>}
          </div>
          <div className="panel-title-row" style={{ marginTop: 16 }}><div><Eyebrow>Outcome loops</Eyebrow><h2>Reference portfolio</h2></div><span className="mini-count">{outcomeEpisodes.length}</span></div>
          <div className="outcome-loop-list">
            {outcomeEpisodes.slice(0, 3).map((episode) => (
              <button className="outcome-loop-card drillable-surface" type="button" onClick={() => openDetail("OUTCOME-LOOP", episode.title, episode.recommendation, "Open", "amber")} key={episode.id}>
                <div className="loop-card-top"><Tag tone="amber">Open</Tag><span>{episode.id}</span></div>
                <strong>{episode.title}</strong>
                <p>{episode.recommendation}</p>
              </button>
            ))}
          </div>
        </aside>
      </section>

      <section className="patient-lower-grid">
        <article className="panel evidence-ledger">
          <div className="panel-title-row"><div><Eyebrow>Bitemporal event ledger</Eyebrow><h2>What changed, and when we knew</h2></div><Tag tone="mint">{realmEvents.length} events</Tag></div>
          <div className="ledger-table">
            <div className="ledger-head"><span>Valid time</span><span>Evidence</span><span>Source</span><span>State</span></div>
            {(realmEvents.length ? realmEvents.map((event) => ({ time: new Date(event.recordedTime).toLocaleString(), label: event.eventType, source: event.sourceSystem, state: event.status === "accepted" ? "complete" : "review" })) : patientTimeline).map((event) => (
              <button className="ledger-row drillable-surface" type="button" onClick={() => onOpenDetail({ id: `LEDGER-${event.time}-${event.label}`, kind: "Bitemporal ledger entry", title: event.label, summary: `The event was retained from ${event.source} with its valid and recorded time.`, status: event.state, tone: event.state === "review" ? "amber" : "mint", owner: event.source, scope, metrics: [{ label: "Valid / recorded time", value: event.time }, { label: "State", value: event.state }], evidence: [{ label: "Source", value: event.source, source: "Canonical event envelope" }], steps: [{ label: "Ingest", detail: "Schema and integrity checked", state: "done" }, { label: "Persist", detail: "Immutable envelope retained", state: "done" }, { label: "Project", detail: "Patient state updated", state: "done" }, { label: "Review", detail: event.state, state: event.state === "review" ? "current" : "done" }], primary: { label: "Open Shared Intelligence", target: "intelligence" } })} key={`${event.time}-${event.label}`}>
                <time>{event.time}</time><strong>{event.label}</strong><span>{event.source}</span><Tag tone={event.state === "review" ? "amber" : event.state === "derived" ? "blue" : "mint"}>{event.state}</Tag>
              </button>
            ))}
          </div>
        </article>

        <article className="panel patient-assessment-preview">
          <div className="panel-title-row"><div><Eyebrow>Assessment evidence</Eyebrow><h2>Answers in context</h2></div><Tag tone="violet">{assessment ? "1 recorded" : "Reference"}</Tag></div>
          {assessment ? (
            <div className="answer-preview">
              <small>{assessment.id ?? "assessment"}</small>
              <p>Score {assessment.score ?? "—"} · {assessment.band ?? "—"}</p>
              <span>{assessment.at ? new Date(assessment.at).toLocaleString() : "recorded in realm"}</span>
            </div>
          ) : null}
          {assessmentResponses.slice(0, 2).map((response) => (
            <button className="answer-preview drillable-surface" type="button" onClick={() => openDetail("Assessment answer", response.question, response.answer, "Reference", "blue")} key={response.id}>
              <small>{response.question}</small>
              <p>“{response.answer}”</p>
              <span>{response.source} · {response.effective} (reference)</span>
            </button>
          ))}
        </article>
      </section>
    </div>
  );
}
