"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Braces,
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Code2,
  DatabaseZap,
  GitBranch,
  History,
  RadioTower,
  Layers3,
  LockKeyhole,
  Plus,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TestTube2,
} from "lucide-react";
import { agentManifests, domainPacks, measurePacks, operatingModel, publicSources, runtimePolicy, sourceMappings } from "../lib/catalogs";
import { configurationAction, fetchReleaseGate, type ReleaseGateView } from "../lib/harness";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import type { NavigationId } from "../lib/types";
import { Eyebrow, PanelExpand, Tag } from "./ui";

type ConfigTab = "organization" | "domains" | "adapters" | "events" | "cells" | "measures" | "policies";

function configCodeFor(tab: ConfigTab): string[] {
  // The organization ontology lines are DERIVED from the durable operating-model
  // catalog (Postgres — admin Ontology editor), not hardcoded.
  const scopePath = (operatingModel?.scopePath ?? []) as Array<{ level: string }>;
  const ontologyRoles = (operatingModel?.roles ?? []) as Array<{ id: string }>;
  const organizationLines = [
    `model: ${String(operatingModel?.model ?? "large-dialysis-enterprise")}`,
    `hierarchy: ${scopePath.map((s) => s.level).join(" > ") || "enterprise > division > region > market > facility"}`,
    `roles: ${ontologyRoles.map((r) => r.id).join(", ") || "evp, dvp, rod, fa, medical, quality, finance, biomed"}`,
    "decision_rights: role + scope + purpose",
    `synthetic_demo: ${operatingModel?.synthetic ? "true" : "false"}`,
  ];
  return {
    organization: organizationLines,
    domains: [`registry: domain-packs@${domainPacks.version}`, `reference_active: ${domainPacks.packs.filter((pack) => pack.state === "reference-active").map((pack) => pack.id).join(", ")}`, `framework_ready: ${domainPacks.packs.filter((pack) => pack.state === "framework-ready").length}`, "activation: schema + adapter + eval + owner approval", "default_state: disabled"],
    adapters: ["adapter: organization-kafka-bridge", "ingress: HTTPS canonical event", "egress: durable D1 outbox", "kafka: external bridge with idempotent producer", "secrets: deployment bindings only"],
    events: ["contract: canonical-event@1.0.0", "compatibility: backward", "key: tenant_id + subject_id", "idempotency: event_id", "time: valid_time + recorded_time"],
    cells: ["cell: continuity-cell@1.0.0", "approval_class: B", "allowed: create-coordinator-task", "eval_gate: 0.92", "kill_switch: enabled"],
    measures: ["pack: ktv-comprehensive@2026.2", "authority: cms-qip-2026-spec", "effective: 2026-01-01", "submission: EQRS", "gold_parity: 1.00"],
    policies: [`policy: ${runtimePolicy?.version ?? ""}`, `default: ${runtimePolicy?.defaultDecision ?? "block"}`, "clinical_change: clinician_approval", "service_change: coordinator_approval", "live_submit: dual_approval + external credential"],
  }[tab] ?? [];
}

export default function ConfigurationStudio({ onOpenDetail, onNavigate }: { onOpenDetail: OpenWorkflowDetail; onNavigate: (id: NavigationId) => void }) {
  const [tab, setTab] = useState<ConfigTab>("organization");
  const [draft, setDraft] = useState(false);
  const [release, setRelease] = useState<{ version: string; status: string; dossierHash: string } | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseNotice, setReleaseNotice] = useState<string | null>(null);
  // The release gate is served by the backend (evaluateRelease). The studio used
  // to draw its own five-gate strip whose step states were driven only by "does a
  // release object exist" — an invented gate model beside the two real ones.
  const [gate, setGate] = useState<ReleaseGateView | null>(null);
  useEffect(() => { void fetchReleaseGate().then(setGate).catch(() => setGate(null)); }, []);
  const stats = useMemo(() => ({ cells: agentManifests.length, measures: measurePacks.length, sources: publicSources.length, roles: operatingModel.roles.length, domains: domainPacks.packs.length }), []);
  // Where each object REALLY lives. This editor used to be headed with plausible
  // filenames — riverbend-fhir-r4.yaml, action-boundary.yaml, continuity-cell.yaml
  // — that exist nowhere in the repository, while the content was generated from
  // durable configuration objects. Naming the real store is the whole fix.
  const filenames: Record<ConfigTab, string> = {
    organization: "swarm_workspace · operating-model",
    domains: "swarm_workspace · domain-pack",
    adapters: "swarm_workspace · source-mapping",
    events: "canonical-event@1.0.0 (compiled contract)",
    cells: "swarm_workspace · agent-manifest",
    measures: "swarm_workspace · measure-pack",
    policies: "swarm_workspace · runtime-policy",
  };

  async function configurationActionRun(action: "create-draft" | "validate" | "request-approval") {
    setReleaseBusy(true);
    try {
      const payload = await configurationAction(action, release?.version);
      setRelease(payload.release);
      setDraft(true);
      setReleaseNotice(action === "create-draft" ? "Draft dossier persisted with no runtime effect." : action === "validate" ? `${payload.checks?.length ?? 0} executable controls passed; release is validated.` : "Approval recorded; organization canary and promotion still remain outside this reference runtime.");
    } catch (error) {
      setReleaseNotice(error instanceof Error ? error.message : "Configuration workflow failed");
    } finally {
      setReleaseBusy(false);
    }
  }

  function openConfigurationDetail(title: string, summary: string, status: string, evidence: Array<{ label: string; value: string; source?: string }> = []) {
    onOpenDetail({ id: `CONFIG-${title.toUpperCase().replaceAll(" ", "-")}`, kind: "Configuration object", title, summary, status, tone: status.toLowerCase().includes("invalid") || status.toLowerCase().includes("blocked") ? "red" : status.toLowerCase().includes("draft") || status.toLowerCase().includes("pending") ? "amber" : "mint", owner: "Configuration governance", scope: `${tab} · ${filenames[tab]}`, metrics: [{ label: "Roles", value: String(stats.roles) }, { label: "Cells", value: String(stats.cells) }, { label: "Measures", value: String(stats.measures) }, { label: "Authority sources", value: String(stats.sources) }], evidence, activity: [{ time: "Active", title: "renal-harness-2026.08.5", detail: "Runtime schema, event kernel and policy harness", state: "done" }, ...(release ? [{ time: "Current", title: release.version, detail: `${release.status} · dossier ${release.dossierHash.slice(0, 12)}…`, state: release.status === "approved" ? "done" as const : "current" as const }] : [])], steps: [{ label: "Schema", detail: "Contract compatibility", state: release ? "done" : "current" }, { label: "Replay", detail: "Synthetic + golden data", state: release?.status === "validated" || release?.status === "approved" ? "done" : "pending" }, { label: "Evaluate", detail: "Green and red suites", state: release?.status === "validated" || release?.status === "approved" ? "done" : "pending" }, { label: "Approve", detail: "Role-specific quorum", state: release?.status === "approved" ? "done" : release?.status === "validated" ? "current" : "pending" }, { label: "Release", detail: "Organization canary + rollback", state: "pending" }], control: "Drafts, validation and approval dossiers are durable, but this reference runtime never promotes a configuration into an organization’s live environment automatically.", primary: { label: "Open AI Assurance", target: "assurance" } });
  }

  return (
    <div className="view-stack configuration-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Configuration studio · change without brittle rebuilds</Eyebrow>
          <h1>Configuration Studio</h1>
          <p>This is the technical catalog. Platform Admin owns the customer launch, executable release gates and zero-redeploy activation journey.</p>
        </div>
        <div className="heading-actions"><button className="button button-secondary" type="button" onClick={() => openConfigurationDetail("Release history", "Inspect the packaged baseline and the current persisted sandbox dossier with effective and rollback boundaries.", "Versioned", [{ label: "Packaged baseline", value: "renal-harness-2026.08.5", source: "Repository configuration" }, ...(release ? [{ label: "Current sandbox", value: release.version, source: `${release.status} · ${release.dossierHash}` }] : [])])}><History size={15} /> Catalog history</button><button className="button button-secondary" disabled={releaseBusy} onClick={() => void configurationActionRun("create-draft")} type="button"><Plus size={15} /> Draft sandbox</button><button className="button button-primary" onClick={() => onNavigate("admin")} type="button"><Settings2 size={15} /> Open Platform Admin</button></div>
      </header>

      <section className="config-release panel">
        <div className="release-context"><span className="release-icon"><GitBranch size={19} /></span><div><Eyebrow>Active configuration</Eyebrow><h2>{release ? release.version : "no draft release"}</h2><p>{release ? `Status ${release.status} · every promotable object pins a last-known-good target and keeps its change dossier.` : "Draft a change set to open a release dossier. The packaged baseline is the runtime's own schema, not a versioned file."}</p></div></div>
        <div className="release-stats"><span><small>Roles</small><strong>{stats.roles}</strong></span><span><small>Cells</small><strong>{stats.cells}</strong></span><span><small>Measure packs</small><strong>{stats.measures}</strong></span><span><small>Authority sources</small><strong>{stats.sources}</strong></span></div>
        {gate ? <Tag tone={gate.verdict.decision === "ship" ? "mint" : gate.verdict.decision === "hold" ? "amber" : "red"}>{gate.verdict.decision.toUpperCase()} · score {gate.verdict.score}</Tag> : null}
      </section>

      <section className="configuration-layout">
        <article className="panel config-editor">
          <div className="config-tabs" role="tablist" aria-label="Configuration domains">
            {(["organization", "domains", "adapters", "events", "cells", "measures", "policies"] as ConfigTab[]).map((item) => <button className={tab === item ? "is-active" : ""} role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)} type="button">{item === "organization" ? "org model" : item}</button>)}
          </div>
          <div className="editor-toolbar"><div><span className="config-icon"><Code2 size={16} /></span><span><small>Configuration object</small><strong>{tab}/{filenames[tab]}</strong></span></div><button className="editor-branch" type="button" onClick={() => openConfigurationDetail("Configuration branch", "The demonstration exposes a read-only active branch; promotion uses a content-addressed change-set dossier rather than mutable UI state.", "main · protected", [{ label: "Branch", value: "main", source: "Protected reference configuration" }, { label: "Object", value: filenames[tab], source: tab }])}>main <ChevronDown size={13} /></button><PanelExpand /></div>
          <div className="code-editor" aria-label="Read-only configuration preview">
            {configCodeFor(tab).map((line, index) => {
              const [key, ...rest] = line.split(":");
              return <div key={line}><span>{String(index + 1).padStart(2, "0")}</span><code><em>{key}</em>:<strong>{rest.join(":")}</strong></code></div>;
            })}
          </div>
          <div className="editor-footer"><span><CircleDot size={13} /> {releaseNotice ?? "Schema valid · no secrets present"}</span><div><button className="button button-ghost" type="button" onClick={() => openConfigurationDetail("Configuration comparison", `Compare ${filenames[tab]} with the active renal-harness-2026.08.5 object.`, release ? release.status : "No draft", configCodeFor(tab).map((line, index) => ({ label: `Line ${index + 1}`, value: line, source: filenames[tab] })))}>Compare</button><button className="button button-secondary" disabled={releaseBusy || !release || release.status !== "draft"} onClick={() => void configurationActionRun("validate")} type="button"><TestTube2 size={14} /> Validate draft</button><button className="button button-primary" disabled={releaseBusy || release?.status !== "validated"} onClick={() => void configurationActionRun("request-approval")} type="button"><Save size={14} /> Request approval</button></div></div>
        </article>

        <aside className="config-side-stack">
          <article className="panel promotion-card">
            <div className="panel-title-row"><div><Eyebrow>Release gate</Eyebrow><h2>Live checks</h2></div><ShieldCheck size={18} /></div>
            {gate ? <>
              <div className="release-stats">
                <span><small>Decision</small><strong>{gate.verdict.decision.toUpperCase()}</strong></span>
                <span><small>Green</small><strong>{Math.round((gate.verdict.greenScore ?? 0) * 100)}%</strong></span>
                <span><small>Red open</small><strong>{gate.verdict.redOpen}</strong></span>
                <span><small>Sources</small><strong>{gate.verdict.sourcesCurrent ? "current" : "stale"}</strong></span>
              </div>
              <div className="promotion-flow">
                {gate.input.green.slice(0, 6).map((check, index) => <button type="button" key={check.id} onClick={() => openConfigurationDetail(`${check.plane} · ${check.id}`, check.check, check.status, [{ label: "Evidence", value: check.evidence ?? "—", source: "Release gate" }, { label: "Plane", value: check.plane, source: "evaluateRelease" }])}><span>{index + 1}</span><div><strong>{check.plane}</strong><small>{check.status} · {check.id}</small></div>{check.status !== "pass" ? <ArrowRight size={13} /> : null}</button>)}
              </div>
              {gate.verdict.blocks.length ? <p className="muted">Blocks: {gate.verdict.blocks.join(", ")}</p> : null}
              {gate.verdict.reasons.length ? <p className="muted">Holds: {gate.verdict.reasons.join("; ")}</p> : null}
              <p className="muted">Scored by evaluateRelease against the LIVE action policy — green pass rate, red containment, source currency and approvals, each with its own evidence. An unsafe policy fails the suite and blocks the release.</p>
            </> : <p className="muted">Gate evidence unavailable — the release gate did not respond.</p>}
          </article>
          <article className="panel longevity-card"><Layers3 size={19} /><div><Eyebrow>2039 posture</Eyebrow><h3>Time-aware, not year-coded</h3><p>Effective windows, semantic versions and authority snapshots allow 2026 and 2039 rules to coexist and replay.</p></div></article>
          {draft ? <article className="panel draft-card"><SlidersHorizontal size={18} /><div><Eyebrow>Persisted change set</Eyebrow><strong>{release?.version ?? "Creating…"}</strong><p>{release?.dossierHash ? `Dossier ${release.dossierHash.slice(0, 12)}…` : "No runtime effect"}</p></div><Tag tone={release?.status === "approved" ? "mint" : release?.status === "validated" ? "blue" : "amber"}>{release?.status ?? "Draft"}</Tag></article> : null}
        </aside>
      </section>

      <section className="integration-contract panel">
        <div className="integration-header"><div><span className="integration-icon"><Cable size={18} /></span><div><Eyebrow>EMR adapter contract</Eyebrow><h2>Map once into the canonical event fabric</h2></div></div><div className="adapter-path"><span><DatabaseZap size={14} /> EMR / FHIR</span><ArrowRight size={14} /><span><RadioTower size={14} /> Kafka</span><ArrowRight size={14} /><span><Braces size={14} /> Canonical facts</span></div></div>
        <div className="mapping-table">
          <div className="mapping-head"><span>Canonical field</span><span>FHIR source</span><span>Kafka contract</span><span>Validation</span></div>
          {sourceMappings.map((mapping) => <button className="mapping-row drillable-surface" type="button" onClick={() => openConfigurationDetail(mapping.canonical, `FHIR source ${mapping.fhir} maps into canonical field ${mapping.canonical} and Kafka contract ${mapping.kafka}.`, mapping.status, [{ label: "Canonical field", value: mapping.canonical, source: "Canonical event contract" }, { label: "FHIR path", value: mapping.fhir, source: "EMR adapter mapping" }, { label: "Kafka contract", value: mapping.kafka, source: "AsyncAPI registry" }])} key={mapping.canonical}><code>{mapping.canonical}</code><span>{mapping.fhir}</span><code>{mapping.kafka}</code><Tag tone={mapping.status === "mapped" ? "mint" : "amber"}>{mapping.status}</Tag></button>)}
        </div>
        <div className="adapter-boundary"><LockKeyhole size={15} /><span>Credentials, network routes and tenant secrets stay outside this repository and enter through deployment bindings.</span><button type="button" onClick={() => openConfigurationDetail("Adapter runbook", "Deploy the HTTP-to-Kafka bridge with broker endpoints, authentication, topic allowlist, D1 outbox token and environment-specific network policy.", "Framework ready", [{ label: "Ingress", value: "HTTPS canonical event", source: "Authenticated adapter endpoint" }, { label: "Egress", value: "Durable D1 outbox", source: "Idempotent Kafka bridge" }, { label: "Secrets", value: "Deployment bindings only", source: "No repository credentials" }])}>Adapter runbook <ArrowRight size={13} /></button></div>
      </section>

      <section className="config-catalog">
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Renal ecosystem packs", "Modality, care-continuum and enterprise-service packs are independently activatable after schema, adapter, evaluation and owner approval.", `${stats.domains} packs`, domainPacks.packs.map((pack) => ({ label: pack.id, value: pack.state, source: pack.label })))}><Settings2 size={18} /><div><small>Renal ecosystem packs</small><strong>{stats.domains}</strong><span>{domainPacks.packs.filter((p) => p.state === "reference-active").length} active · {stats.domains - domainPacks.packs.filter((p) => p.state === "reference-active").length} framework-ready</span></div></button>
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Release gate", "Green checks, red containment, source currency and approvals for the next promotion — every number comes from evaluateRelease, none of them are configured here.", gate ? gate.verdict.decision.toUpperCase() : "unavailable", gate ? gate.input.green.map((c) => ({ label: `${c.plane} · ${c.id}`, value: c.status, source: c.evidence ?? "release gate" })) : [])}><ShieldCheck size={18} /><div><small>Release gate</small><strong>{gate ? gate.verdict.decision.toUpperCase() : "—"}</strong><span>{gate ? `${gate.input.green.length} checks · ${gate.verdict.redOpen} red open` : "not responding"}</span></div></button>
      </section>
    </div>
  );
}
