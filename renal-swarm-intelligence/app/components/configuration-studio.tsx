"use client";

import { useMemo, useState } from "react";
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
import agentManifests from "../../config/agent-manifests.json";
import measurePacks from "../../config/measure-packs.json";
import publicSources from "../../config/public-sources.json";
import operatingModel from "../../config/enterprise-operating-model.json";
import domainPacks from "../../config/domain-packs.json";
import runtimePolicy from "../../config/runtime-policy.json";
import { sourceMappings } from "../../lib/demo-data";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import type { NavigationId } from "../../lib/types";
import { Eyebrow, Tag } from "./ui";

type ConfigTab = "organization" | "domains" | "adapters" | "events" | "cells" | "measures" | "policies";

const configCode: Record<ConfigTab, string[]> = {
  organization: ["model: large-dialysis-enterprise", "hierarchy: enterprise > division > region > market > facility", "roles: evp, dvp, rod, fa, medical, quality, finance, biomed", "decision_rights: role + scope + purpose", "synthetic_demo: true"],
  domains: [`registry: domain-packs@${domainPacks.version}`, `reference_active: ${domainPacks.packs.filter((pack) => pack.state === "reference-active").map((pack) => pack.id).join(", ")}`, `framework_ready: ${domainPacks.packs.filter((pack) => pack.state === "framework-ready").length}`, "activation: schema + adapter + eval + owner approval", "default_state: disabled"],
  adapters: ["adapter: organization-kafka-bridge", "ingress: HTTPS canonical event", "egress: durable D1 outbox", "kafka: external bridge with idempotent producer", "secrets: deployment bindings only"],
  events: ["contract: canonical-event@1.0.0", "compatibility: backward", "key: tenant_id + subject_id", "idempotency: event_id", "time: valid_time + recorded_time"],
  cells: ["cell: continuity-cell@1.0.0", "approval_class: B", "allowed: create-coordinator-task", "eval_gate: 0.92", "kill_switch: enabled"],
  measures: ["pack: ktv-comprehensive@2026.2", "authority: cms-qip-2026-spec", "effective: 2026-01-01", "submission: EQRS", "gold_parity: 1.00"],
  policies: [`policy: ${runtimePolicy.version}`, `default: ${runtimePolicy.defaultDecision}`, "clinical_change: clinician_approval", "service_change: coordinator_approval", "live_submit: dual_approval + external credential"],
};

export default function ConfigurationStudio({ onOpenDetail, onNavigate }: { onOpenDetail: OpenWorkflowDetail; onNavigate: (id: NavigationId) => void }) {
  const [tab, setTab] = useState<ConfigTab>("organization");
  const [draft, setDraft] = useState(false);
  const [release, setRelease] = useState<{ version: string; status: string; dossierHash: string } | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseNotice, setReleaseNotice] = useState<string | null>(null);
  const stats = useMemo(() => ({ cells: agentManifests.length, measures: measurePacks.length, sources: publicSources.length, roles: operatingModel.roles.length, domains: domainPacks.packs.length }), []);
  const filenames: Record<ConfigTab, string> = {
    organization: "enterprise-operating-model.json",
    domains: "domain-packs.json",
    adapters: "riverbend-fhir-r4.yaml",
    events: "hospital.transition.v2.yaml",
    cells: "continuity-cell.yaml",
    measures: "ktv-comprehensive.yaml",
    policies: "action-boundary.yaml",
  };

  async function configurationAction(action: "create-draft" | "validate" | "request-approval") {
    setReleaseBusy(true);
    try {
      const response = await fetch("/api/configuration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, roleId: "dvp", version: release?.version }) });
      const payload = await response.json() as { release?: { version: string; status: string; dossierHash: string }; error?: string; runtimeEffect?: boolean; checks?: unknown[] };
      if (!response.ok || !payload.release) throw new Error(payload.error ?? "Configuration workflow failed");
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
          <h1>Inspect every versioned object behind the harness.</h1>
          <p>This is the technical catalog. Platform Admin owns the customer launch, executable release gates and zero-redeploy activation journey.</p>
        </div>
        <div className="heading-actions"><button className="button button-secondary" type="button" onClick={() => openConfigurationDetail("Release history", "Inspect the packaged baseline and the current persisted sandbox dossier with effective and rollback boundaries.", "Versioned", [{ label: "Packaged baseline", value: "renal-harness-2026.08.5", source: "Repository configuration" }, ...(release ? [{ label: "Current sandbox", value: release.version, source: `${release.status} · ${release.dossierHash}` }] : [])])}><History size={15} /> Catalog history</button><button className="button button-secondary" disabled={releaseBusy} onClick={() => void configurationAction("create-draft")} type="button"><Plus size={15} /> Draft sandbox</button><button className="button button-primary" onClick={() => onNavigate("admin")} type="button"><Settings2 size={15} /> Open Platform Admin</button></div>
      </header>

      <section className="config-release panel">
        <div className="release-context"><span className="release-icon"><GitBranch size={19} /></span><div><Eyebrow>Packaged baseline catalog</Eyebrow><h2>renal-harness-2026.08.5</h2><p>Platform Admin can layer and hot-activate a validated tenant release over this rollback-safe baseline.</p></div></div>
        <div className="release-stats"><span><small>Roles</small><strong>{stats.roles}</strong></span><span><small>Cells</small><strong>{stats.cells}</strong></span><span><small>Measure packs</small><strong>{stats.measures}</strong></span><span><small>Authority sources</small><strong>{stats.sources}</strong></span></div>
        <Tag tone="mint"><CheckCircle2 size={11} /> 126 tests passed</Tag>
      </section>

      <section className="configuration-layout">
        <article className="panel config-editor">
          <div className="config-tabs" role="tablist" aria-label="Configuration domains">
            {(["organization", "domains", "adapters", "events", "cells", "measures", "policies"] as ConfigTab[]).map((item) => <button className={tab === item ? "is-active" : ""} role="tab" aria-selected={tab === item} key={item} onClick={() => setTab(item)} type="button">{item === "organization" ? "org model" : item}</button>)}
          </div>
          <div className="editor-toolbar"><div><span className="config-icon"><Code2 size={16} /></span><span><small>Configuration object</small><strong>{tab}/{filenames[tab]}</strong></span></div><button className="editor-branch" type="button" onClick={() => openConfigurationDetail("Configuration branch", "The demonstration exposes a read-only active branch; promotion uses a content-addressed change-set dossier rather than mutable UI state.", "main · protected", [{ label: "Branch", value: "main", source: "Protected reference configuration" }, { label: "Object", value: filenames[tab], source: tab }])}>main <ChevronDown size={13} /></button></div>
          <div className="code-editor" aria-label="Read-only configuration preview">
            {configCode[tab].map((line, index) => {
              const [key, ...rest] = line.split(":");
              return <div key={line}><span>{String(index + 1).padStart(2, "0")}</span><code><em>{key}</em>:<strong>{rest.join(":")}</strong></code></div>;
            })}
          </div>
          <div className="editor-footer"><span><CircleDot size={13} /> {releaseNotice ?? "Schema valid · no secrets present"}</span><div><button className="button button-ghost" type="button" onClick={() => openConfigurationDetail("Configuration comparison", `Compare ${filenames[tab]} with the active renal-harness-2026.08.5 object.`, release ? release.status : "No draft", configCode[tab].map((line, index) => ({ label: `Line ${index + 1}`, value: line, source: filenames[tab] })))}>Compare</button><button className="button button-secondary" disabled={releaseBusy || !release || release.status !== "draft"} onClick={() => void configurationAction("validate")} type="button"><TestTube2 size={14} /> Validate draft</button><button className="button button-primary" disabled={releaseBusy || release?.status !== "validated"} onClick={() => void configurationAction("request-approval")} type="button"><Save size={14} /> Request approval</button></div></div>
        </article>

        <aside className="config-side-stack">
          <article className="panel promotion-card">
            <div className="panel-title-row"><div><Eyebrow>Promotion contract</Eyebrow><h2>Five enforced gates</h2></div><ShieldCheck size={18} /></div>
            <div className="promotion-flow">
              {[{label:"Schema",detail:"Contract compatible"},{label:"Replay",detail:"Synthetic + golden data"},{label:"Evaluate",detail:"Green and red suites"},{label:"Approve",detail:"Role-specific quorum"},{label:"Release",detail:"Canary + rollback"}].map((step, index) => <button type="button" onClick={() => openConfigurationDetail(`${step.label} gate`, step.detail, release?.status ?? "Reference control", [{ label: "Gate order", value: String(index + 1), source: "Promotion contract" }, { label: "Current release", value: "renal-harness-2026.08.5", source: "Active reference" }])} key={step.label}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div>{index < 4 ? <ArrowRight size={13} /> : null}</button>)}
            </div>
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
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Renal ecosystem packs", "Modality, care-continuum and enterprise-service packs are independently activatable after schema, adapter, evaluation and owner approval.", `${stats.domains} packs`, domainPacks.packs.map((pack) => ({ label: pack.id, value: pack.state, source: pack.label })))}><Settings2 size={18} /><div><small>Renal ecosystem packs</small><strong>{stats.domains}</strong><span>1 active · {stats.domains - 1} framework-ready</span></div></button>
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Active versions", "Independent semantic versions and effective windows resolve configuration at event valid time.", "18 active", [{ label: "Resolution", value: "Bitemporal", source: "Valid time + recorded time" }])}><GitBranch size={18} /><div><small>Active versions</small><strong>18</strong><span>Bitemporal resolution</span></div></button>
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Replay fixtures", "Synthetic operating fixtures and separately labeled public facts exercise event contracts without representing live patient data.", "64 fixtures", [{ label: "Runtime replay", value: "11 canonical events", source: "Synthetic patient and operations" }, { label: "Public facts", value: String(stats.sources), source: "Real authority registry" }])}><TestTube2 size={18} /><div><small>Replay fixtures</small><strong>64</strong><span>Synthetic + public facts</span></div></button>
        <button className="panel catalog-card drillable-surface" type="button" onClick={() => openConfigurationDetail("Rollback coverage", "Every promotable object pins a last-known-good target and retains its change dossier.", "100%", [{ label: "Rollback target", value: "Pinned", source: "Promotion contract" }])}><ShieldCheck size={18} /><div><small>Rollback coverage</small><strong>100%</strong><span>Last known-good pinned</span></div></button>
      </section>
    </div>
  );
}
