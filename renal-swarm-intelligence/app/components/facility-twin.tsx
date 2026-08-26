"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Gauge,
  HardHat,
  MapPinned,
  Play,
  RotateCcw,
  ShieldCheck,
  UsersRound,
  Waves,
} from "lucide-react";
import { facilityStations } from "../../lib/demo-data";
import { ensureRuntime, mutateRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

const stateMeta = {
  active: { label: "Active", tone: "mint" as const },
  turnover: { label: "Turnover", tone: "blue" as const },
  available: { label: "Available", tone: "neutral" as const },
  late: { label: "Late arrival", tone: "amber" as const },
  maintenance: { label: "Maintenance", tone: "red" as const },
};

type FacilitySimulation = { feasible: boolean; checks: Array<{ id: string; label: string; passed: boolean; evidenceEventIds: string[]; detail?: string }>; runtimeEffect: boolean; configuration: string };

export default function FacilityTwin({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const [scenario, setScenario] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [scenarioResult, setScenarioResult] = useState<FacilitySimulation | null>(null);
  const capacityEvent = runtime?.events.find((event) => event.eventType === "facility.capacity.changed.v2");

  useEffect(() => {
    let active = true;
    void ensureRuntime("fa").then((snapshot) => { if (active) setRuntime(snapshot); }).catch((error) => { if (active) setScenarioError(error instanceof Error ? error.message : "Runtime twin unavailable"); });
    return () => { active = false; };
  }, []);

  async function runScenario() {
    if (scenario) {
      setScenario(false);
      setScenarioResult(null);
      return;
    }
    setScenarioBusy(true);
    try {
      const result = await mutateRuntime<FacilitySimulation>("simulate-facility", "fa", { facilityId: "facility-franklin", station: 4, proposedAt: "2026-08-21T19:30:00.000Z" });
      setScenarioResult(result);
      setScenario(result.feasible);
      setScenarioError(result.feasible ? null : "One or more constraints failed; no plan advanced.");
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : "Facility simulation failed");
    } finally {
      setScenarioBusy(false);
    }
  }

  function openFacilityDetail(title: string, summary: string, status: string, target: NavigationId = "command", evidence: Array<{ label: string; value: string; source?: string }> = []) {
    onOpenDetail({ id: `FACILITY-${title.toUpperCase().replaceAll(" ", "-")}`, kind: "Facility digital twin", title, summary, status, tone: status.toLowerCase().includes("maintenance") || status.toLowerCase().includes("late") ? "red" : status.toLowerCase().includes("watch") ? "amber" : "mint", owner: "Facility administrator", scope: "Riverbend Franklin · shift 2", metrics: [{ label: "Runtime events", value: String(runtime?.counts.events ?? 0) }, { label: "Capacity executions", value: String(runtime?.executions.filter((item) => item.agentId === "capacity-cell").length ?? 0) }, { label: "Runtime effect", value: "False" }], evidence: evidence.length ? evidence : [{ label: "Capacity event", value: capacityEvent?.eventId ?? "Awaiting persisted capacity signal", source: capacityEvent?.sourceSystem ?? "Facility twin" }, { label: "Staff headroom", value: String(capacityEvent?.payload.staffRatioHeadroom ?? "—"), source: "facility.capacity.changed.v2" }], steps: [{ label: "Observe", detail: "Chair, staff, machine and arrival states joined", state: "done" }, { label: "Simulate", detail: scenarioResult ? `${scenarioResult.checks.length} constraints replayed` : "Safe scenario available", state: scenarioResult ? "done" : "current" }, { label: "Authorize", detail: "Human service-coordination decision", state: "pending" }, { label: "Verify", detail: "Downstream acknowledgement required", state: "pending" }], control: "The digital twin can project and compare plans. It cannot reserve a chair, change an order, notify a patient or write to the EMR.", primary: { label: target === "assessments" ? "Open Assessment Intelligence" : target === "assurance" ? "Open AI Assurance" : target === "facility" ? "Stay in Facility Operations" : "Open Outcome Command", target } });
  }

  return (
    <div className="view-stack facility-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Facility twin · Riverbend Franklin · synthetic operations</Eyebrow>
          <h1>Capacity with patient constraints intact.</h1>
          <p>A decision-support twin for chairs, staff, machines and arrivals—never an autonomous scheduler.</p>
        </div>
        <div className="heading-actions"><Tag tone={runtime ? "mint" : "violet"}><Activity size={11} /> {runtime ? `${runtime.counts.events} persisted events` : "Loading twin projection"}</Tag><button className="button button-secondary" type="button" onClick={() => openFacilityDetail("Shift 2 day view", "Inspect the treatment floor, current station states and the next six-hour constraint forecast.", "Operational view")}><CalendarRange size={15} /> Day view details</button></div>
      </header>

      <section className="facility-metrics metrics-grid">
        <button className="metric metric-mint drillable-surface" type="button" onClick={() => openFacilityDetail("Chair utilization", "Treatment-station occupancy projected across the active shift.", scenario ? "91% simulated" : "87% current")}><div className="metric-topline"><span>Chair utilization</span><Gauge size={14} /></div><strong>{scenario ? "91%" : "87%"}</strong><small>12 stations · shift 2</small></button>
        <button className="metric drillable-surface" type="button" onClick={() => openFacilityDetail("On-time starts", "Start-time performance with late-arrival and turnover context retained.", scenario ? "94% simulated" : "92% current")}><div className="metric-topline"><span>On-time starts</span><Clock3 size={14} /></div><strong>{scenario ? "94%" : "92%"}</strong><small>Target ≥90%</small></button>
        <button className="metric metric-amber drillable-surface" type="button" onClick={() => openFacilityDetail("Staffing margin", "Persisted ratio headroom is checked before a capacity proposal can advance.", capacityEvent ? `+${String(capacityEvent.payload.staffRatioHeadroom)}` : "Awaiting signal")}><div className="metric-topline"><span>Staffing margin</span><UsersRound size={14} /></div><strong>{capacityEvent ? `+${String(capacityEvent.payload.staffRatioHeadroom)}` : "—"}</strong><small>Persisted ratio headroom</small></button>
        <button className="metric metric-mint drillable-surface" type="button" onClick={() => openFacilityDetail("Capacity proposals", "Each constraint-cell execution is traced and remains advisory until a human authorization.", `${runtime?.executions.filter((item) => item.agentId === "capacity-cell").length ?? 0} executions`, "assurance")}><div className="metric-topline"><span>Capacity proposals</span><MapPinned size={14} /></div><strong>{runtime?.executions.filter((item) => item.agentId === "capacity-cell").length ?? "—"}</strong><small>Constraint-cell executions</small></button>
      </section>

      <section className="facility-layout">
        <article className="panel station-panel">
          <div className="panel-title-row"><div><Eyebrow>Operational topology</Eyebrow><h2>Treatment floor · shift 2</h2></div><div className="station-legend">{Object.entries(stateMeta).map(([key, meta]) => <span key={key}><i className={`station-dot station-${key}`} />{meta.label}</span>)}</div></div>
          <div className="floor-plan">
            <div className="nurse-axis"><span>Charge</span><strong>Clinical observation axis</strong><span>Supply</span></div>
            <div className="station-grid">
              {facilityStations.map((station) => {
                const meta = stateMeta[station.state];
                return (
                  <button className={`station station-${station.state} drillable-surface`} type="button" onClick={() => openFacilityDetail(`Station ${String(station.station).padStart(2, "0")}`, `${station.patient} · ${station.ends === "—" ? "No end time" : `Ends ${station.ends}`}`, meta.label, station.state === "available" ? "command" : "facility", [{ label: "Station state", value: meta.label, source: "Synthetic treatment-floor projection" }, { label: "Occupant", value: station.patient, source: "Shift 2 assignment context" }, { label: "Expected end", value: station.ends, source: "Capacity forecast" }])} key={station.station}>
                    <div className="station-head"><span>{String(station.station).padStart(2, "0")}</span><Tag tone={meta.tone}>{meta.label}</Tag></div>
                    <div className="station-machine"><span /><Waves size={16} /><span /></div>
                    <strong>{station.patient}</strong><small>{station.ends === "—" ? "No end time" : `Ends ${station.ends}`}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </article>

        <aside className="scenario-stack">
          <article className="panel scenario-card">
            <div className="panel-title-row"><div><Eyebrow>Continuity scenario</Eyebrow><h2>Place Maya at 14:30</h2></div><Tag tone={scenario ? "mint" : "violet"}>{scenario ? "Simulated" : "Draft"}</Tag></div>
            <p>Test the harness proposal against capacity, staff ratio, access needs and the patient’s afternoon preference.</p>
            <div className="scenario-input"><span>Proposed station</span><strong>Station 04 · 14:30</strong></div>
            <div className="scenario-checks">
              {(scenarioResult?.checks ?? [
                { id: "chair", label: "Chair & machine", passed: true, evidenceEventIds: [], detail: "Awaiting server replay" },
                { id: "staff", label: "Staff ratio", passed: true, evidenceEventIds: [], detail: "Awaiting server replay" },
                { id: "preference", label: "Patient constraint", passed: true, evidenceEventIds: [], detail: "Awaiting cited assessment" },
                { id: "boundary", label: "Clinical boundary", passed: true, evidenceEventIds: [], detail: "No runtime effect" },
              ]).map((check) => <button type="button" onClick={() => openFacilityDetail(check.label, check.detail ?? "Scenario constraint", check.passed ? "Passed" : "Blocked", check.id === "preference" ? "assessments" : "assurance", check.evidenceEventIds.map((id) => ({ label: "Evidence event", value: id, source: "Server-side facility replay" })))} key={check.id}>{check.passed ? <CheckCircle2 size={15} /> : <Activity size={15} />}<span><strong>{check.label}</strong><small>{check.detail ?? (check.evidenceEventIds.length ? `Evidence ${check.evidenceEventIds.join(" · ")}` : "Policy control")}</small></span></button>)}
            </div>
            <button className={`button ${scenario ? "button-secondary" : "button-primary"} scenario-button`} disabled={scenarioBusy || !runtime} onClick={() => void runScenario()} type="button">{scenarioBusy ? <><Activity size={15} /> Replaying constraints…</> : scenario ? <><RotateCcw size={15} /> Reset simulation</> : <><Play size={15} /> Run safe scenario</>}</button>
            {scenarioError ? <p className="action-feedback is-error">{scenarioError}</p> : scenarioResult ? <p className="action-feedback is-success"><ShieldCheck size={13} /> Server replay passed under {scenarioResult.configuration}; runtime effect: {String(scenarioResult.runtimeEffect)}.</p> : null}
          </article>

          <button className="panel capacity-cell-card drillable-surface" type="button" onClick={() => openFacilityDetail("Capacity cell · 1.0.0", "Constraint optimizer with a strict allowlist and no downstream write access.", "98% evaluation gate", "assurance")}>
            <div className="capacity-cell-top"><span><HardHat size={17} /></span><div><Eyebrow>Capacity cell · 1.0.0</Eyebrow><strong>Constraint optimizer</strong></div></div>
            <div className="capacity-contract"><span>Can</span><p>Propose schedule plans</p><span>Cannot</span><p>Reserve chairs · modify orders · notify patients</p></div>
            <div className="cell-confidence"><span>Evaluation gate</span><strong>98%</strong></div><ProgressBar value={98} tone="mint" />
          </button>
        </aside>
      </section>

      <section className="forecast-strip panel">
        <div className="forecast-heading"><Eyebrow>Next six hours</Eyebrow><h2>Constraint forecast</h2></div>
        {["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"].map((time, index) => <div className="forecast-hour" key={time}><span>{time}</span><div style={{ height: `${24 + [42,52,49,64,70,58,39][index]}%` }} /><small>{[72,82,79,94,98,88,69][index]}%</small></div>)}
        <div className="forecast-note"><ArrowRight size={16} /><span><strong>14:00 risk window</strong> · turnover compression, still policy-compatible in the simulated plan.</span></div>
      </section>
    </div>
  );
}
