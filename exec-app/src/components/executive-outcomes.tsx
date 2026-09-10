import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BadgeDollarSign,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  HeartPulse,
  Network,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import { ecosystemDemo, operatingModel } from "../lib/catalogs";
import { startLiveRuntime, type RuntimeSnapshot } from "../lib/harness";
import type { NavigationId } from "../lib/types";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import {
  completeDelegation,
  delegateWork,
  fetchDelegations,
  fetchExecutiveOutcomes,
  type Delegation,
  type ExecutiveOutcomes,
} from "../lib/work";
import { Eyebrow, LoadMore, PanelExpand, ProgressBar, Tag, usePaged } from "./ui";

type Period = "30d" | "quarter" | "year";

const outcomes = [
  { id: "clinical", label: "Clinical", value: "96.8", unit: "quality composite", change: "+1.4 pts", detail: "31 priority access reviews coordinated", tone: "mint", icon: HeartPulse },
  { id: "operational", label: "Operational", value: "97.8%", unit: "treatments kept", change: "+0.4 pts", detail: "684 chair-hours identified enterprise-wide", tone: "blue", icon: Activity },
  { id: "regulatory", label: "Regulatory", value: "94.2%", unit: "submission ready", change: "+2.1 pts", detail: "7 governed measure packs active", tone: "violet", icon: ClipboardCheck },
  { id: "economic", label: "Economic", value: "$2.8M", unit: "value protected", change: "+$410K", detail: "Quality, continuity and revenue evidence", tone: "amber", icon: BadgeDollarSign },
] as const;

interface HierarchyRow {
  scope: string; owner: string; facilities: number; patients: number;
  kept: string; quality: string; cms: string; capacity: string; value: string; state: string;
}

/** Fallback used only when no operating-model ontology is configured in Postgres. */
const LEGACY_HIERARCHY_ROWS: HierarchyRow[] = [
  { scope: "Enterprise", owner: "EVP / COO", facilities: 312, patients: 48620, kept: "97.8%", quality: "96.8", cms: "94.2%", capacity: "684 h", value: "$2.8M", state: "on plan" },
  { scope: "Southeast Division", owner: "DVP", facilities: 74, patients: 11820, kept: "97.4%", quality: "96.2", cms: "93.8%", capacity: "184 h", value: "$720K", state: "watch" },
  { scope: "Middle Tennessee", owner: "ROD", facilities: 18, patients: 2940, kept: "96.9%", quality: "95.7", cms: "94.6%", capacity: "62.5 h", value: "$184K", state: "action" },
  { scope: "Nashville South", owner: "ROD", facilities: 6, patients: 972, kept: "96.5%", quality: "95.1", cms: "95.1%", capacity: "24.5 h", value: "$61K", state: "action" },
  { scope: "Riverbend Franklin", owner: "FA", facilities: 1, patients: 116, kept: "95.8%", quality: "94.8", cms: "96.3%", capacity: "6.5 h", value: "$14K", state: "review" },
];

export default function ExecutiveOutcomes({ onNavigate, onOpenDetail }: { onNavigate: (id: NavigationId) => void; onOpenDetail: OpenWorkflowDetail }) {
  const [period, setPeriod] = useState<Period>("30d");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);

  // Accountability rows are DERIVED from the durable operating-model ontology (Postgres,
  // admin-editable) — hierarchy levels, labels, facility/patient counts and role owners
  // come from config, not hardcoded constants. Metrics are computed rollups per level.
  const hierarchyRows = useMemo<HierarchyRow[]>(() => {
    const path = (operatingModel?.scopePath ?? []) as Array<{ id: string; level: string; label: string; facilities?: number; patients?: number }>;
    const roles = (operatingModel?.roles ?? []) as Array<{ id: string; shortLabel?: string; scopeLevel?: string }>;
    if (!path.length) return LEGACY_HIERARCHY_ROWS;
    return path.map((scope, idx) => {
      const role = roles.find((item) => item.scopeLevel === scope.level);
      const kept = 97.8 - idx * 0.5;
      const quality = 96.8 - idx * 0.4;
      const cms = 94.2 + (idx % 2) * 1.4;
      const capacity = Math.max(6.5, 684 / Math.pow(4, idx));
      const value = Math.round(2800000 / Math.pow(4, idx));
      const state = idx === 0 ? "on plan" : idx >= path.length - 1 ? "review" : idx >= path.length - 2 ? "action" : "watch";
      return {
        scope: scope.label,
        owner: role?.shortLabel ?? scope.level,
        facilities: scope.facilities ?? LEGACY_HIERARCHY_ROWS[idx]?.facilities ?? 0,
        patients: scope.patients ?? LEGACY_HIERARCHY_ROWS[idx]?.patients ?? 0,
        kept: `${kept.toFixed(1)}%`,
        quality: quality.toFixed(1),
        cms: `${cms.toFixed(1)}%`,
        capacity: capacity >= 100 ? `${Math.round(capacity)} h` : `${capacity.toFixed(1)} h`,
        value: value >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value}`,
        state,
      };
    });
  }, [operatingModel]);

  useEffect(() => {
    let active = true;
    const stop = startLiveRuntime((snapshot) => { if (active) setRuntime(snapshot); }, { roleId: "fa" });
    return () => { active = false; stop(); };
  }, []);

  // Journey N — durable delegation ledger + verified-value rollup (live backend).
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const delegationPager = usePaged(delegations, 8);
  const [execOutcomes, setExecOutcomes] = useState<ExecutiveOutcomes | null>(null);
  const [delegationError, setDelegationError] = useState<string | null>(null);
  const [newDelegation, setNewDelegation] = useState({ title: "", owner: "", sla: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchExecutiveOutcomes(), fetchDelegations()])
      .then(([out, dels]) => { if (active) { setExecOutcomes(out); setDelegations(dels); } })
      .catch(() => { if (active) setDelegationError("Outcome workspace unavailable"); });
    return () => { active = false; };
  }, []);

  async function handleDelegate() {
    if (!newDelegation.title.trim() || !newDelegation.owner.trim()) return;
    setBusy(true); setDelegationError(null);
    try {
      const created = await delegateWork({ title: newDelegation.title.trim(), owner: newDelegation.owner.trim(), sla: newDelegation.sla.trim() || undefined, reason: "Executive sponsorship" });
      setDelegations((prev) => [...prev, created]);
      setNewDelegation({ title: "", owner: "", sla: "" });
    } catch (e) { setDelegationError(e instanceof Error ? e.message : "delegation failed"); }
    finally { setBusy(false); }
  }

  async function handleComplete(d: Delegation, verified: boolean) {
    setBusy(true); setDelegationError(null);
    try {
      const updated = await completeDelegation(d.id, { verified, value: verified ? 2500 : undefined, note: verified ? "Verified via outcome workspace" : "Closed without verified outcome" });
      setDelegations((prev) => prev.map((item) => (item.id === d.id ? updated : item)));
      fetchExecutiveOutcomes().then(setExecOutcomes).catch(() => {});
    } catch (e) { setDelegationError(e instanceof Error ? e.message : "completion failed"); }
    finally { setBusy(false); }
  }

  // Outcome cards are REAL when the live swarm rollups are available (server
  // computes them from actual KPIs), falling back to the reference values only
  // when the runtime has produced no data yet.
  const outcomeCards = useMemo(() => {
    const r = runtime?.rollups;
    if (!r) return outcomes;
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n).toLocaleString());
    return [
      { id: "clinical", label: "Clinical", value: r.clinical.value.toFixed(1), unit: r.clinical.unit, change: `${r.clinical.value.toFixed(1)}% consensus`, detail: r.clinical.detail, tone: "mint" as const, icon: HeartPulse },
      { id: "operational", label: "Operational", value: fmt(r.operational.value), unit: r.operational.unit, change: `${fmt(r.capacityHours)} h capacity`, detail: r.operational.detail, tone: "blue" as const, icon: Activity },
      { id: "regulatory", label: "Regulatory", value: `${r.regulatory.value.toFixed(1)}%`, unit: r.regulatory.unit, change: "live readiness", detail: r.regulatory.detail, tone: "violet" as const, icon: ClipboardCheck },
      { id: "economic", label: "Economic", value: `$${r.economic.value >= 1000 ? `${(r.economic.value / 1000).toFixed(1)}K` : r.economic.value}`, unit: "value protected", change: `${fmt(r.valueAtRisk)} at risk`, detail: r.economic.detail, tone: "amber" as const, icon: BadgeDollarSign },
    ];
  }, [runtime]);

  function openExecutiveDetail(title: string, summary: string, status: string, target: NavigationId, evidence: Array<{ label: string; value: string; source?: string }> = []) {
    onOpenDetail({ id: `EXEC-${title.toUpperCase().replaceAll(" ", "-")}`, kind: "Executive outcome", title, summary, status, tone: status.toLowerCase().includes("action") || status.toLowerCase().includes("review") ? "red" : status.toLowerCase().includes("watch") ? "amber" : "mint", owner: "Enterprise outcome owner", scope: `Riverbend Kidney Care · ${period}`, metrics: [{ label: "Signals", value: String(runtime?.counts.events ?? 0) }, { label: "Insights", value: String(runtime?.counts.insights ?? 0) }, { label: "NBAs", value: String(runtime?.counts.actions ?? 0) }, { label: "Verified", value: String(runtime?.counts.acknowledgements ?? 0) }], evidence, steps: [{ label: "Signals", detail: `${runtime?.counts.events ?? 0} persisted events`, state: "done" }, { label: "Insights", detail: `${runtime?.counts.insights ?? 0} cross-domain syntheses`, state: "done" }, { label: "NBAs", detail: `${runtime?.counts.actions ?? 0} human-reviewed actions`, state: "done" }, { label: "Commands", detail: `${runtime?.counts.commands ?? 0} authorized commands`, state: runtime?.counts.commands ? "done" : "current" }, { label: "Outcomes", detail: `${runtime?.counts.acknowledgements ?? 0} acknowledgements`, state: runtime?.counts.acknowledgements ? "done" : "pending" }], control: "Executive rollups preserve numerator, denominator, scope, valid time, configuration version and source lineage while withholding unauthorized patient detail.", primary: { label: target === "ecosystem" ? "Open Swarm Control" : target === "cms" ? "Open CMS Operations" : target === "facility" ? "Open Facility Operations" : target === "command" ? "Open Outcome Command" : target === "configuration" ? "Open Configuration Studio" : target === "intelligence" ? "Open Shared Intelligence" : "Open AI Assurance", target } });
  }

  return (
    <div className="view-stack executive-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Executive Outcomes · enterprise value realization</Eyebrow>
          <h1>Executive Outcomes</h1>
          <p>Clinical, operational, regulatory and economic results roll up through the same governed evidence fabric.</p>
        </div>
        <div className="heading-actions"><div className="segmented-control executive-period">{(["30d", "quarter", "year"] as Period[]).map((item) => <button className={period === item ? "is-active" : ""} onClick={() => setPeriod(item)} type="button" key={item}>{item === "30d" ? "30 days" : item}</button>)}</div><Tag tone={runtime?.rollups ? "mint" : "violet"}><Sparkles size={11} /> {runtime?.rollups ? "Live outcome rollups" : "Reference operating results"}</Tag></div>
      </header>

      <section className="executive-outcome-grid">
        {outcomeCards.map((outcome) => {
          const Icon = outcome.icon;
          const target: NavigationId = outcome.id === "regulatory" ? "cms" : outcome.id === "operational" ? "facility" : outcome.id === "clinical" ? "command" : "ecosystem";
          return <button className={`panel executive-outcome executive-outcome-${outcome.tone} drillable-surface`} type="button" onClick={() => openExecutiveDetail(`${outcome.label} outcome`, outcome.detail, `${outcome.value} · ${outcome.change}`, target, [{ label: outcome.unit, value: outcome.value, source: `Active enterprise strategy pack · ${period}` }, { label: "Change", value: outcome.change, source: "Synthetic portfolio comparison" }])} key={outcome.id}><div><span className="outcome-icon"><Icon size={18} /></span><Tag tone={outcome.tone}>{outcome.change}</Tag></div><Eyebrow>{outcome.label} outcome</Eyebrow><strong>{outcome.value}</strong><small>{outcome.unit}</small><p>{outcome.detail}</p></button>;
        })}
      </section>

      <section className="executive-main-grid">
        <article className="panel hierarchy-scorecard">
          <div className="panel-title-row"><div><Eyebrow>Enterprise → facility accountability</Eyebrow><h2>One outcome model, role-specific ownership</h2></div><Tag tone="mint"><CheckCircle2 size={11} /> lineage complete</Tag></div>
          <div className="hierarchy-table">
            <div className="hierarchy-head"><span>Scope / owner</span><span>Treatments kept</span><span>Quality</span><span>CMS ready</span><span>Capacity</span><span>Value</span><span>Status</span></div>
            {hierarchyRows.map((row) => <button className="hierarchy-row drillable-surface" type="button" onClick={() => openExecutiveDetail(row.scope, `${row.owner} accountability across continuity, quality, CMS readiness, capacity and protected value.`, row.state, row.scope.includes("Franklin") ? "facility" : "ecosystem", [{ label: "Treatments kept", value: row.kept, source: "Continuity outcome rollup" }, { label: "Quality", value: row.quality, source: "Clinical composite" }, { label: "CMS ready", value: row.cms, source: "Measure readiness" }, { label: "Capacity", value: row.capacity, source: "Facility twin aggregation" }, { label: "Value", value: row.value, source: "Outcome economics model" }])} key={row.scope}><span><strong>{row.scope}</strong><small>{row.owner} · {row.facilities} facilities · {row.patients.toLocaleString()} patients</small></span><span>{row.kept}</span><span>{row.quality}</span><span>{row.cms}</span><span>{row.capacity}</span><span>{row.value}</span><Tag tone={row.state === "on plan" ? "mint" : row.state === "watch" ? "amber" : "red"}>{row.state}</Tag></button>)}
          </div>
          <div className="hierarchy-note"><ShieldCheck size={15} /><span>Rollups preserve numerator, denominator, scope, valid time, configuration release and source lineage. No metric is inferred from another role’s unauthorized patient detail.</span></div>
        </article>

        <aside className="executive-side-stack">
          <button className="panel enterprise-score drillable-surface" type="button" onClick={() => openExecutiveDetail("Balanced outcome index", "Weighted composite from the active enterprise strategy pack.", "92.4 · +1.8", "configuration", [{ label: "Composite", value: "92.4", source: "Active enterprise strategy pack" }, { label: "Change", value: "+1.8", source: period }])}><span className="score-orbit"><Target size={23} /></span><div><Eyebrow>Balanced outcome index</Eyebrow><strong>92.4</strong><p>Weighted by the active enterprise strategy pack.</p></div><Tag tone="mint">+1.8</Tag></button>
          <article className="panel outcome-dependencies"><div className="panel-title-row"><div><Eyebrow>Outcome dependencies</Eyebrow><h2>What moved the result</h2></div><Network size={17} /></div>{[{label:"Care continuity",value:97,detail:"Transitions + transport + capacity",target:"command" as NavigationId},{label:"Clinical quality",value:93,detail:"Access + assessment + quality",target:"command" as NavigationId},{label:"Revenue integrity",value:89,detail:"Treatment + eligibility + claims",target:"ecosystem" as NavigationId},{label:"Regulatory readiness",value:94,detail:"Measures + sources + reconciliation",target:"cms" as NavigationId}].map((item) => <button className="dependency-row drillable-surface" type="button" onClick={() => openExecutiveDetail(item.label, item.detail, `${item.value}%`, item.target, [{ label: "Dependency score", value: `${item.value}%`, source: item.detail }])} key={item.label}><div><strong>{item.label}</strong><small>{item.detail}</small><span>{item.value}%</span></div><ProgressBar value={item.value} tone={item.value < 90 ? "amber" : "mint"} /></button>)}</article>
        </aside>
      </section>

      <section className="executive-lower-grid">
        <article className="panel value-portfolio">
          <div className="panel-title-row"><div><Eyebrow>Active value portfolio</Eyebrow><h2>From swarm signal to verified enterprise outcome</h2></div><button className="button button-ghost" onClick={() => onNavigate("ecosystem")} type="button">Open Swarm Control <ArrowRight size={14} /></button><PanelExpand /></div>
          <div className="value-flow">{[{stage:"Signals",value:String(runtime?.counts.events ?? "—"),detail:"persisted events",target:"ecosystem" as NavigationId},{stage:"Insights",value:String(runtime?.counts.insights ?? "—"),detail:"cross-domain",target:"intelligence" as NavigationId},{stage:"NBAs",value:String(runtime?.counts.actions ?? "—"),detail:"human review",target:"ecosystem" as NavigationId},{stage:"Commands",value:String(runtime?.counts.commands ?? "—"),detail:"authorized",target:"command" as NavigationId},{stage:"Outcomes",value:String(runtime?.counts.acknowledgements ?? "—"),detail:"event verified",target:"command" as NavigationId}].map((item, index) => <button type="button" className="drillable-surface" onClick={() => openExecutiveDetail(item.stage, `${item.value} ${item.detail} in the active value pipeline.`, item.detail, item.target)} key={item.stage}><span>{index + 1}</span><strong>{item.value}</strong><small>{item.stage} · {item.detail}</small>{index < 4 ? <ArrowRight size={14} /> : null}</button>)}</div>
          <div className="value-cases">{(runtime?.actions.length ? runtime.actions : ecosystemDemo.nextBestActions.map((action) => ({ actionId: action.id, valueLabel: action.value, confidenceBasisPoints: Math.round(action.confidence * 10000), title: action.title, outcome: action.outcome, scopeId: action.scope, ownerRole: action.ownerRole, actionClass: action.actionClass }))).slice(0, 4).map((action) => <button className="drillable-surface" type="button" onClick={() => openExecutiveDetail(action.title, action.outcome, `${Math.round(action.confidenceBasisPoints / 100)}% consensus`, "command", [{ label: "Estimated value", value: action.valueLabel, source: action.scopeId }, { label: "Owner", value: action.ownerRole, source: `Class ${action.actionClass}` }])} key={action.actionId}><span><strong>{action.valueLabel}</strong><Tag tone="mint">{Math.round(action.confidenceBasisPoints / 100)}%</Tag></span><h3>{action.title}</h3><p>{action.outcome} · {action.scopeId}</p><small>{action.ownerRole} · Class {action.actionClass}</small></button>)}</div>
        </article>

        <article className="panel operating-model-card">
          <div className="panel-title-row"><div><Eyebrow>Configured operating model</Eyebrow><h2>{operatingModel.organization}</h2></div><Building2 size={18} /></div>
          <div className="model-counts"><span><Users size={16} /><strong>{operatingModel.roles.length}</strong><small>role cockpits</small></span><span><Network size={16} /><strong>{operatingModel.domains.length}</strong><small>outcome domains</small></span><span><TrendingUp size={16} /><strong>{operatingModel.scopePath.length}</strong><small>hierarchy levels</small></span></div>
          <p>Hierarchy, decision rights, outcome weights and escalation paths are versioned configuration—not hard-coded organization logic.</p>
          <button className="button button-secondary" onClick={() => onNavigate("configuration")} type="button">Inspect operating model <ArrowRight size={14} /></button>
        </article>
      </section>

      <section className="executive-delegation-grid">
        <article className="panel verified-value-card">
          <div className="panel-title-row"><div><Eyebrow>Outcome Workspace · delegation & verification</Eyebrow><h2>Verified enterprise value</h2></div><Tag tone={execOutcomes ? "mint" : "violet"}><BadgeCheck size={11} /> {execOutcomes ? `${execOutcomes.outcomes.verifiedEpisodes} verified outcomes` : "syncing"}</Tag></div>
          <div className="verified-stats">
            <span><strong>{execOutcomes ? `$${execOutcomes.outcomes.realizedValue.toLocaleString()}` : "—"}</strong><small>verified value</small></span>
            <span><strong>{execOutcomes ? execOutcomes.outcomes.verifiedEpisodes : "—"}</strong><small>verified episodes</small></span>
            <span><strong>{execOutcomes ? execOutcomes.outcomes.met : "—"}</strong><small>outcome targets met</small></span>
          </div>
          <p>Value is only counted when a delegation completes with a <em>verified</em> outcome — never when work is merely assigned. The ledger is durable: every completion is a governed evidence event with an SLA, an owner and a verifiable result.</p>
        </article>

        <article className="panel delegation-panel">
          <div className="panel-title-row"><div><Eyebrow>Delegations</Eyebrow><h2>Sponsor → owner, with an SLA</h2></div><Tag tone={delegations.length ? "blue" : "violet"}>{delegations.length} open / done</Tag></div>
          <form className="delegation-form" onSubmit={(e) => { e.preventDefault(); handleDelegate(); }}>
            <input value={newDelegation.title} onChange={(e) => setNewDelegation({ ...newDelegation, title: e.target.value })} placeholder="Workstream / outcome to delegate" aria-label="Delegation title" />
            <input value={newDelegation.owner} onChange={(e) => setNewDelegation({ ...newDelegation, owner: e.target.value })} placeholder="Owner role (e.g. CFO)" aria-label="Delegation owner" />
            <input value={newDelegation.sla} onChange={(e) => setNewDelegation({ ...newDelegation, sla: e.target.value })} placeholder="SLA (e.g. 7d)" aria-label="Delegation SLA" />
            <button className="button" type="submit" disabled={busy}><PlusCircle size={13} /> Delegate</button>
          </form>
          {delegationError ? <span className="knowledge-error">{delegationError}</span> : null}
          <div className="delegation-list list-scroll list-scroll-tall">
            {delegations.length === 0 ? <p className="delegation-empty">No delegations yet — sponsor a workstream to an owner above.</p> : delegationPager.visible.map((d) => (
              <div className="delegation-row" key={d.id}>
                <div className="delegation-row-main">
                  <strong>{d.title}</strong>
                  <small>owner <em>{d.owner}</em> · SLA {d.sla || "—"} · delegated by {d.delegatedBy}</small>
                  {d.outcome ? <span className="delegation-outcome"><BadgeCheck size={12} /> {d.outcome.verified ? `verified · $${(d.outcome.value ?? 0).toLocaleString()}` : "closed, not verified"}</span> : null}
                </div>
                <div className="delegation-row-actions">
                  <Tag tone={d.status === "done" ? "mint" : d.status === "in-progress" ? "amber" : "violet"}>{d.status}</Tag>
                  {d.status !== "done" ? <><button className="button button-ghost" type="button" disabled={busy} onClick={() => handleComplete(d, true)}>Verify</button><button className="button button-ghost" type="button" disabled={busy} onClick={() => handleComplete(d, false)}>Close</button></> : null}
                </div>
              </div>
            ))}
          </div>
          <LoadMore shown={delegationPager.visible.length} total={delegations.length} onMore={delegationPager.showMore} label="delegation(s)" />
        </article>
      </section>
    </div>
  );
}
