"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  Building2,
  Cable,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudCog,
  DatabaseZap,
  ExternalLink,
  FileCheck2,
  Fingerprint,
  Gauge,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Play,
  Power,
  RadioTower,
  RefreshCw,
  Rocket,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  TestTube2,
  UsersRound,
  Workflow,
} from "lucide-react";
import measurePacks from "../../config/measure-packs.json";
import operatingModel from "../../config/enterprise-operating-model.json";
import publicSources from "../../config/public-sources.json";
import {
  fetchAdminConsole,
  mutateAdminConsole,
} from "../../lib/control-plane/client";
import type {
  AdminConsoleSnapshot,
  AgentConfiguration,
  KafkaBridgeConfiguration,
  OnboardingStepId,
  RuntimePolicyConfiguration,
} from "../../lib/control-plane/contracts";
import type { NavigationId } from "../../lib/types";
import { Eyebrow, ProgressBar, Tag } from "./ui";

const stepIcons: Record<OnboardingStepId, typeof Building2> = {
  organization: Building2,
  identity: UsersRound,
  kafka: RadioTower,
  adapters: Workflow,
  agents: Bot,
  cms: FileCheck2,
  validate: TestTube2,
  activate: Rocket,
};

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function topics(value: string): KafkaBridgeConfiguration["topicMappings"] {
  return lines(value).map((line) => {
    const [direction, topic, contract] = line.split("|").map((item) => item.trim());
    return { direction: direction === "outbound" ? "outbound" : "inbound", topic, contract };
  });
}

function topicText(value: KafkaBridgeConfiguration["topicMappings"]) {
  return value.map((item) => `${item.direction} | ${item.topic} | ${item.contract}`).join("\n");
}

function statusTone(status: string) {
  if (["active", "complete", "passed", "verified"].includes(status)) return "mint" as const;
  if (["blocked", "failed", "error"].includes(status)) return "red" as const;
  if (["validated", "contract-verified", "ready"].includes(status)) return "blue" as const;
  return "amber" as const;
}

export default function AdminConsole({ onNavigate }: { onNavigate: (id: NavigationId) => void }) {
  const [snapshot, setSnapshot] = useState<AdminConsoleSnapshot | null>(null);
  const [activeStep, setActiveStep] = useState<OnboardingStepId>("organization");
  const [selectedAgentId, setSelectedAgentId] = useState("assessment-cell");
  const [agentDraft, setAgentDraft] = useState<AgentConfiguration | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  const [organization, setOrganization] = useState({ displayName: "Riverbend Dialysis", environmentName: "reference", deploymentMode: "reference", timeZone: "America/Chicago", dataRegion: "United States" });
  const [kafka, setKafka] = useState({ displayName: "Organization Kafka bridge", bridgeUrl: "https://bridge.customer.example", clusterAlias: "renal-enterprise-events", securityProtocol: "SASL_SSL", secretRef: "binding:KAFKA_BRIDGE_TOKEN", consumerGroup: "renal-swarm-control-plane", topicMappings: "" });
  const [policy, setPolicy] = useState<RuntimePolicyConfiguration>({ version: "action-boundary@5.0.0", defaultDecision: "block", escalationThresholdBasisPoints: 8200, minThresholdBasisPoints: 7000, maxThresholdBasisPoints: 9500, externalWritesEnabled: false });

  function hydrate(result: AdminConsoleSnapshot) {
    setSnapshot(result);
    setOrganization({
      displayName: result.tenant.displayName,
      environmentName: result.tenant.environmentName,
      deploymentMode: result.tenant.deploymentMode,
      timeZone: result.tenant.timeZone,
      dataRegion: result.tenant.dataRegion,
    });
    setKafka({
      displayName: result.kafka.displayName,
      bridgeUrl: result.kafka.bridgeUrl,
      clusterAlias: result.kafka.clusterAlias,
      securityProtocol: result.kafka.securityProtocol,
      secretRef: result.kafka.secretRef,
      consumerGroup: result.kafka.consumerGroup,
      topicMappings: topicText(result.kafka.topicMappings),
    });
    setPolicy({ ...result.policy });
    const nextAgent = result.agents.find((agent) => agent.id === selectedAgentId) ?? result.agents[0];
    if (nextAgent) setAgentDraft({ ...nextAgent });
    if (!initialized.current) {
      initialized.current = true;
      setActiveStep(result.onboarding.currentStep);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchAdminConsole().then((result) => {
      if (active) hydrate(result);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Admin control plane unavailable");
    });
    return () => { active = false; };
  // Initial server hydration only; later updates are explicit mutations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(
    action: Parameters<typeof mutateAdminConsole>[0],
    input: Record<string, unknown> = {},
    success: string,
  ) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await mutateAdminConsole(action, input);
      hydrate(result);
      setNotice(success);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Admin operation failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const workingRelease = snapshot?.releases.find((release) => release.status === "draft" || release.status === "validated");
  const validatedRelease = snapshot?.releases.find((release) => release.status === "validated");
  const activeRelease = snapshot?.releases.find((release) => release.status === "active");
  const selectedValidation = useMemo(
    () => snapshot?.validations.filter((validation) => validation.releaseId === (workingRelease?.releaseId ?? activeRelease?.releaseId)) ?? [],
    [activeRelease?.releaseId, snapshot?.validations, workingRelease?.releaseId],
  );

  async function saveOrganization() {
    const result = await run("save-organization", organization, "Organization boundary saved. Workspace identity and scoped roles are now attached.");
    if (result) setActiveStep("kafka");
  }

  async function saveKafka() {
    await run("save-kafka", { ...kafka, topicMappings: topics(kafka.topicMappings) }, "Kafka bridge contract saved with a secret binding reference—no credential entered the browser or database.");
  }

  async function testKafka() {
    const result = await run("test-kafka", {}, "Kafka bridge gate completed. Inspect the result to see whether this was a contract-only or live broker verification.");
    if (result?.kafka.status === "contract-verified" || result?.kafka.status === "verified") setActiveStep("agents");
  }

  async function saveAgent() {
    if (!agentDraft) return;
    const result = await run("save-agent", { agent: agentDraft }, `${agentDraft.name} saved into a content-addressed draft release with no runtime effect.`);
    if (result) setActiveStep("validate");
  }

  async function savePolicy() {
    const result = await run("save-policy", { policy }, `Action boundary saved at ${policy.escalationThresholdBasisPoints / 100}% in the current draft release.`);
    if (result) setActiveStep("validate");
  }

  async function validate() {
    const result = await run("validate-release", { releaseId: workingRelease?.releaseId }, "Schema, green-team, red-team, integration and promotion suites completed and evidence was persisted.");
    if (result?.releases.some((release) => release.status === "validated")) setActiveStep("activate");
  }

  async function activate() {
    await run("activate-release", { releaseId: validatedRelease?.releaseId }, "Configuration is active. New server-side agent executions now resolve this release without a code redeploy.");
  }

  const progress = (snapshot?.onboarding.completionBasisPoints ?? 0) / 100;

  return (
    <div className="view-stack admin-console-view">
      <header className="view-heading admin-heading">
        <div>
          <Eyebrow>Platform Admin · customer launch command</Eyebrow>
          <h1>Connect the enterprise once. Operate it through configuration.</h1>
          <p>Onboard identity, Kafka, canonical adapters, agents and CMS packs; prove the release; then activate it without rebuilding the application.</p>
        </div>
        <div className="heading-actions">
          <Tag tone={statusTone(snapshot?.onboarding.status ?? "pending")}><Activity size={11} /> {snapshot?.onboarding.status ?? "loading"}</Tag>
          <button className="button button-secondary" type="button" onClick={() => void fetchAdminConsole().then(hydrate)}><RefreshCw size={15} /> Refresh</button>
          <button className="button button-primary" type="button" onClick={() => setActiveStep(snapshot?.onboarding.currentStep ?? "organization")}><Play size={15} /> Continue setup</button>
        </div>
      </header>

      <section className="admin-readiness panel">
        <div className="admin-readiness-main">
          <div><span className="admin-command-icon"><CloudCog size={22} /></span><span><Eyebrow>Customer launch readiness</Eyebrow><strong>{Math.round(progress)}% complete</strong></span></div>
          <ProgressBar value={progress} tone={progress === 100 ? "mint" : "blue"} />
        </div>
        <div className="admin-readiness-facts">
          <span><small>Environment</small><strong>{snapshot?.tenant.environmentName ?? "reference"}</strong></span>
          <span><small>Kafka gate</small><strong>{snapshot?.kafka.status ?? "not configured"}</strong></span>
          <span><small>Runtime release</small><strong>{snapshot?.activeConfigurationVersion ?? "base"}</strong></span>
          <span><small>Code redeploy</small><strong>Not required</strong></span>
        </div>
      </section>

      {notice ? <div className="admin-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div> : null}
      {error ? <div className="admin-notice is-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div> : null}

      <section className="admin-workspace-grid">
        <aside className="panel admin-step-rail" aria-label="Customer onboarding steps">
          <div><Eyebrow>Launch path</Eyebrow><h2>Eight closed loops</h2></div>
          <div className="admin-steps">
            {(snapshot?.onboarding.steps ?? []).map((step, index) => {
              const Icon = stepIcons[step.id];
              return (
                <button className={`${activeStep === step.id ? "is-active" : ""} is-${step.status}`} type="button" onClick={() => setActiveStep(step.id)} key={step.id}>
                  <span className="admin-step-index">{step.status === "complete" ? <Check size={13} /> : index + 1}</span>
                  <Icon size={16} />
                  <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                  <ChevronRight size={14} />
                </button>
              );
            })}
            {!snapshot ? <div className="admin-loading"><LoaderCircle className="is-spinning" size={18} /> Resolving control-plane state…</div> : null}
          </div>
        </aside>

        <article className="panel admin-stage">
          {activeStep === "organization" ? (
            <>
              <div className="admin-stage-head"><span><Building2 size={20} /></span><div><Eyebrow>Step 1 · organization boundary</Eyebrow><h2>Define where decisions are allowed to travel.</h2><p>This creates the durable tenant environment. Patient data never belongs in this screen.</p></div><Tag tone={snapshot?.tenant.persisted ? "mint" : "amber"}>{snapshot?.tenant.persisted ? "saved" : "not saved"}</Tag></div>
              <div className="admin-form-grid">
                <label><span>Organization name</span><input value={organization.displayName} onChange={(event) => setOrganization({ ...organization, displayName: event.target.value })} /></label>
                <label><span>Environment name</span><input value={organization.environmentName} onChange={(event) => setOrganization({ ...organization, environmentName: event.target.value })} /></label>
                <label><span>Deployment mode</span><select value={organization.deploymentMode} onChange={(event) => setOrganization({ ...organization, deploymentMode: event.target.value })}><option value="reference">Reference demo</option><option value="non-production">Non-production</option><option value="production">Production</option></select></label>
                <label><span>Time zone</span><input value={organization.timeZone} onChange={(event) => setOrganization({ ...organization, timeZone: event.target.value })} /></label>
                <label><span>Data region</span><input value={organization.dataRegion} onChange={(event) => setOrganization({ ...organization, dataRegion: event.target.value })} /></label>
              </div>
              <div className="admin-stage-footer"><div><ShieldCheck size={15} /><span>Tenant, role, scope and purpose are enforced server-side on every detail and mutation.</span></div><button className="button button-primary" disabled={Boolean(busy)} type="button" onClick={() => void saveOrganization()}>{busy === "save-organization" ? <LoaderCircle className="is-spinning" size={15} /> : <Save size={15} />} Save organization</button></div>
            </>
          ) : null}

          {activeStep === "identity" ? (
            <>
              <div className="admin-stage-head"><span><Fingerprint size={20} /></span><div><Eyebrow>Step 2 · identity and roles</Eyebrow><h2>Map people to scoped decision rights.</h2><p>The browser never grants authority. The server resolves workspace identity, role, organizational scope and purpose.</p></div><Tag tone={snapshot?.tenant.persisted ? "mint" : "amber"}>{snapshot?.tenant.persisted ? "attached" : "waiting"}</Tag></div>
              <div className="identity-control-grid">
                <section><KeyRound size={18} /><div><strong>Workspace identity</strong><p>Authenticated email is accepted from the hosting identity boundary; adapter tokens remain machine-only.</p></div><Tag tone="mint">server verified</Tag></section>
                <section><UsersRound size={18} /><div><strong>{operatingModel.roles.length} role templates</strong><p>EVP, DVP, ROD, FA, medical, quality, finance and biomed resolve against enterprise scope.</p></div><Tag tone="blue">configurable</Tag></section>
                <section><LockKeyhole size={18} /><div><strong>Default deny</strong><p>UI role switching exists only in the labeled synthetic environment; production roles come from server mappings.</p></div><Tag tone="violet">fail closed</Tag></section>
              </div>
              <div className="role-matrix-mini">{operatingModel.roles.map((role) => <span key={role.id}><strong>{role.label}</strong><small>{role.scopeLevel} · {role.decisionRights.length} rights</small></span>)}</div>
              <div className="admin-stage-footer"><div><ShieldCheck size={15} /><span>Identity setup is satisfied by the current hosted workspace boundary.</span></div><button className="button button-primary" type="button" onClick={() => setActiveStep("kafka")}>Configure Kafka <ArrowRight size={14} /></button></div>
            </>
          ) : null}

          {activeStep === "kafka" ? (
            <>
              <div className="admin-stage-head"><span><RadioTower size={20} /></span><div><Eyebrow>Step 3 · Kafka event fabric</Eyebrow><h2>Connect through the organization-owned HTTPS bridge.</h2><p>The hosted control plane has no raw broker socket. Your bridge sits next to Kafka and preserves the event-first operating model.</p></div><Tag tone={statusTone(snapshot?.kafka.status ?? "draft")}>{snapshot?.kafka.status ?? "not configured"}</Tag></div>
              <div className="kafka-boundary-map">
                <span><DatabaseZap size={17} /><small>EMR / services</small><strong>FHIR + events</strong></span><ArrowRight size={15} /><span><RadioTower size={17} /><small>Org network</small><strong>Kafka cluster</strong></span><ArrowRight size={15} /><span><Cable size={17} /><small>Org-owned edge</small><strong>HTTPS bridge</strong></span><ArrowRight size={15} /><span><ShieldCheck size={17} /><small>Hosted boundary</small><strong>Control plane</strong></span>
              </div>
              <div className="admin-form-grid kafka-form-grid">
                <label><span>Connection name</span><input value={kafka.displayName} onChange={(event) => setKafka({ ...kafka, displayName: event.target.value })} /></label>
                <label><span>Bridge HTTPS URL</span><input value={kafka.bridgeUrl} onChange={(event) => setKafka({ ...kafka, bridgeUrl: event.target.value })} /></label>
                <label><span>Cluster alias</span><input value={kafka.clusterAlias} onChange={(event) => setKafka({ ...kafka, clusterAlias: event.target.value })} /></label>
                <label><span>Security protocol</span><select value={kafka.securityProtocol} onChange={(event) => setKafka({ ...kafka, securityProtocol: event.target.value })}><option>SASL_SSL</option><option>SSL</option><option>PLAINTEXT</option></select></label>
                <label><span>Secret binding reference</span><input value={kafka.secretRef} onChange={(event) => setKafka({ ...kafka, secretRef: event.target.value })} /><small>Reference only; never enter the secret value.</small></label>
                <label><span>Consumer group</span><input value={kafka.consumerGroup} onChange={(event) => setKafka({ ...kafka, consumerGroup: event.target.value })} /></label>
                <label className="admin-form-wide"><span>Topic mappings · direction | topic | contract</span><textarea rows={5} value={kafka.topicMappings} onChange={(event) => setKafka({ ...kafka, topicMappings: event.target.value })} /></label>
              </div>
              <div className="kafka-test-result"><Gauge size={17} /><div><strong>{snapshot?.kafka.testMode === "live-bridge" ? "Live bridge verification" : "Contract verification"}</strong><p>{snapshot?.kafka.testSummary ?? "Save and test the bridge configuration."}</p></div>{snapshot?.kafka.lastTestedAt ? <time>{new Date(snapshot.kafka.lastTestedAt).toLocaleString()}</time> : null}</div>
              <div className="admin-stage-footer"><div><LockKeyhole size={15} /><span>Only <code>binding:NAME</code> is stored. Raw passwords, tokens and API keys are rejected.</span></div><span className="admin-footer-actions"><button className="button button-secondary" disabled={Boolean(busy)} type="button" onClick={() => void saveKafka()}><Save size={14} /> Save bridge</button><button className="button button-primary" disabled={Boolean(busy) || !snapshot?.kafka.connectionId} type="button" onClick={() => void testKafka()}>{busy === "test-kafka" ? <LoaderCircle className="is-spinning" size={14} /> : <TestTube2 size={14} />} Test connection</button></span></div>
            </>
          ) : null}

          {activeStep === "adapters" ? (
            <>
              <div className="admin-stage-head"><span><Workflow size={20} /></span><div><Eyebrow>Step 4 · canonical adapters</Eyebrow><h2>Map once; let every outcome reuse the facts.</h2><p>FHIR, operational and assessment payloads enter the same versioned event envelope with valid time, recorded time, integrity and lineage.</p></div><Tag tone={snapshot?.kafka.status.includes("verified") ? "mint" : "amber"}>{snapshot?.kafka.status.includes("verified") ? "ready" : "waiting on Kafka"}</Tag></div>
              <div className="adapter-contract-grid">
                {[{ name: "Canonical event", version: "1.0.0", detail: "Event id, tenant, subject, valid/recorded time, purpose, source and SHA-256" }, { name: "Assessment evidence", version: "1.0.0", detail: "Exact answer + structured fact candidate + confidence + human review" }, { name: "Governed command", version: "1.0.0", detail: "Action class, approvals, idempotency, destination and acknowledgement" }, { name: "CMS measure input", version: "2026.2", detail: "Authority version, denominator lineage, effective window and reconciliation" }].map((contract) => <section key={contract.name}><Braces size={17} /><div><strong>{contract.name}</strong><p>{contract.detail}</p></div><Tag tone="blue">v{contract.version}</Tag></section>)}
              </div>
              <div className="admin-stage-footer"><div><CheckCircle2 size={15} /><span>Adapters remain independently versioned and backward-compatible.</span></div><button className="button button-primary" type="button" onClick={() => setActiveStep("agents")}>Configure agents <ArrowRight size={14} /></button></div>
            </>
          ) : null}

          {activeStep === "agents" ? (
            <>
              <div className="admin-stage-head"><span><Bot size={20} /></span><div><Eyebrow>Step 5 · agent pack</Eyebrow><h2>Configure bounded specialists in the UI.</h2><p>Every save creates or updates a draft release. Nothing changes at runtime until all gates pass and an authorized operator activates it.</p></div><Tag tone={workingRelease ? statusTone(workingRelease.status) : "neutral"}>{workingRelease?.status ?? "base release"}</Tag></div>
              <div className="admin-agent-editor">
                <aside>{(snapshot?.agents ?? []).map((agent) => <button className={selectedAgentId === agent.id ? "is-active" : ""} type="button" onClick={() => { setSelectedAgentId(agent.id); setAgentDraft({ ...agent }); }} key={agent.id}><span><Bot size={14} /></span><div><strong>{agent.name}</strong><small>{agent.mode} · Class {agent.approvalClass}</small></div><i className={agent.enabled ? "is-on" : "is-off"} /></button>)}</aside>
                {agentDraft ? <section className="agent-config-form">
                  <div className="agent-config-title"><div><Eyebrow>{agentDraft.id}</Eyebrow><h3>{agentDraft.name}</h3></div><label className="config-toggle"><input type="checkbox" checked={agentDraft.enabled} onChange={(event) => setAgentDraft({ ...agentDraft, enabled: event.target.checked })} /><span /><strong>{agentDraft.enabled ? "Enabled" : "Paused"}</strong></label></div>
                  <div className="admin-form-grid">
                    <label><span>Name</span><input value={agentDraft.name} onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })} /></label>
                    <label><span>Semantic version</span><input value={agentDraft.version} onChange={(event) => setAgentDraft({ ...agentDraft, version: event.target.value })} /></label>
                    <label><span>Execution mode</span><input value={agentDraft.mode} onChange={(event) => setAgentDraft({ ...agentDraft, mode: event.target.value })} /></label>
                    <label><span>Approval ceiling</span><select value={agentDraft.approvalClass} onChange={(event) => setAgentDraft({ ...agentDraft, approvalClass: event.target.value as AgentConfiguration["approvalClass"] })}><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
                    <label className="admin-form-wide"><span>Evaluation gate · {Math.round(agentDraft.evaluationGateBasisPoints / 100)}%</span><input type="range" min="8000" max="10000" step="100" value={agentDraft.evaluationGateBasisPoints} onChange={(event) => setAgentDraft({ ...agentDraft, evaluationGateBasisPoints: Number(event.target.value) })} /></label>
                    <label><span>Trigger contracts · one per line</span><textarea rows={5} value={agentDraft.inputs.join("\n")} onChange={(event) => setAgentDraft({ ...agentDraft, inputs: lines(event.target.value) })} /></label>
                    <label><span>Typed outputs · one per line</span><textarea rows={5} value={agentDraft.outputs.join("\n")} onChange={(event) => setAgentDraft({ ...agentDraft, outputs: lines(event.target.value) })} /></label>
                    <label className="admin-form-wide"><span>Allowed proposals · one per line</span><textarea rows={4} value={agentDraft.allowedActions.join("\n")} onChange={(event) => setAgentDraft({ ...agentDraft, allowedActions: lines(event.target.value) })} /></label>
                  </div>
                  <div className="agent-config-guard"><ShieldCheck size={15} /><span>Kill switch required · proposal-only authority · tenant and purpose scoped evidence · no private agent memory</span></div>
                </section> : null}
              </div>
              <section className="policy-config-panel">
                <span className="policy-config-icon"><ShieldCheck size={19} /></span>
                <div className="policy-config-copy"><Eyebrow>Global action boundary</Eyebrow><strong>Default deny · escalation at {Math.round(policy.escalationThresholdBasisPoints / 100)}%</strong><p>This threshold changes which next-best actions surface for human review. It never enables an external write.</p></div>
                <label><span>Policy version</span><input value={policy.version} onChange={(event) => setPolicy({ ...policy, version: event.target.value })} /></label>
                <label className="policy-threshold"><span>{policy.minThresholdBasisPoints / 100}%</span><input type="range" min={policy.minThresholdBasisPoints} max={policy.maxThresholdBasisPoints} step="100" value={policy.escalationThresholdBasisPoints} onChange={(event) => setPolicy({ ...policy, escalationThresholdBasisPoints: Number(event.target.value) })} /><span>{policy.maxThresholdBasisPoints / 100}%</span></label>
                <button className="button button-secondary" disabled={Boolean(busy)} type="button" onClick={() => void savePolicy()}>{busy === "save-policy" ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />} Save policy</button>
              </section>
              <div className="admin-stage-footer"><div><GitBranch size={15} /><span>{workingRelease ? `${workingRelease.version} · ${workingRelease.objectCount} changed objects` : "Saving creates a new change set."}</span></div><button className="button button-primary" disabled={Boolean(busy) || !agentDraft} type="button" onClick={() => void saveAgent()}>{busy === "save-agent" ? <LoaderCircle className="is-spinning" size={15} /> : <Save size={15} />} Save agent draft</button></div>
            </>
          ) : null}

          {activeStep === "cms" ? (
            <>
              <div className="admin-stage-head"><span><FileCheck2 size={20} /></span><div><Eyebrow>Step 6 · CMS authority and measure packs</Eyebrow><h2>Keep public truth real and operating data replaceable.</h2><p>CMS sources are pinned by URL, status, effective date and content hash. Only patient and operating fixtures are synthetic in this demo.</p></div><Tag tone="mint">{publicSources.length} real sources</Tag></div>
              <div className="cms-admin-grid">
                <section><Eyebrow>Authority registry</Eyebrow>{publicSources.slice(0, 6).map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.id}><span><strong>{source.authority}</strong><small>{source.id} · {source.status}</small></span><ExternalLink size={13} /></a>)}</section>
                <section><Eyebrow>Measure packs</Eyebrow>{measurePacks.slice(0, 6).map((pack) => <div key={pack.id}><span><strong>{pack.name}</strong><small>{pack.version} · {pack.status}</small></span><Tag tone={pack.status.includes("active") ? "mint" : "amber"}>{pack.sourceIds.length} sources</Tag></div>)}</section>
              </div>
              <div className="admin-stage-footer"><div><FileCheck2 size={15} /><span>Public authority content is not mocked; every pack remains version and effective-date aware.</span></div><button className="button button-primary" type="button" onClick={() => setActiveStep("validate")}>Run release gates <ArrowRight size={14} /></button></div>
            </>
          ) : null}

          {activeStep === "validate" ? (
            <>
              <div className="admin-stage-head"><span><TestTube2 size={20} /></span><div><Eyebrow>Step 7 · release assurance</Eyebrow><h2>Red team and green team validate the same artifact.</h2><p>A release cannot activate unless schema, positive behavior, adversarial safety, integration and promotion checks all pass.</p></div><Tag tone={workingRelease ? statusTone(workingRelease.status) : "amber"}>{workingRelease?.status ?? "no draft"}</Tag></div>
              <div className="validation-suite-grid">
                {(["schema", "green", "red", "integration", "promotion"] as const).map((suite) => {
                  const result = selectedValidation.find((item) => item.suite === suite);
                  return <section key={suite}><span className={`validation-suite-icon is-${result?.status ?? "pending"}`}>{result?.status === "passed" ? <Check size={15} /> : suite === "red" ? <ShieldCheck size={15} /> : <TestTube2 size={15} />}</span><div><strong>{suite === "green" ? "Green team" : suite === "red" ? "Red team" : `${suite[0].toUpperCase()}${suite.slice(1)} gate`}</strong><p>{result ? `${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks · evidence ${result.evidenceHash.slice(0, 10)}…` : "Waiting for an executable validation run"}</p></div><Tag tone={statusTone(result?.status ?? "pending")}>{result?.status ?? "pending"}</Tag></section>;
                })}
              </div>
              {selectedValidation.length ? <div className="validation-check-list">{selectedValidation.flatMap((validation) => validation.checks.map((check) => <span key={`${validation.validationId}-${check.name}`}><i className={check.passed ? "is-pass" : "is-fail"}>{check.passed ? <Check size={11} /> : <CircleAlert size={11} />}</i><strong>{check.name}</strong><small>{check.observed}</small></span>)).slice(0, 12)}</div> : null}
              <div className="admin-stage-footer"><div><Fingerprint size={15} /><span>Results, scores and evidence hashes are durable and tied to the release.</span></div><button className="button button-primary" disabled={Boolean(busy) || !workingRelease || workingRelease.status !== "draft"} type="button" onClick={() => void validate()}>{busy === "validate-release" ? <LoaderCircle className="is-spinning" size={15} /> : <TestTube2 size={15} />} Run all gates</button></div>
            </>
          ) : null}

          {activeStep === "activate" ? (
            <>
              <div className="admin-stage-head"><span><Rocket size={20} /></span><div><Eyebrow>Step 8 · runtime activation</Eyebrow><h2>Promote configuration, not another code build.</h2><p>The server resolves the active content-addressed release on new events. The last active version remains the rollback target.</p></div><Tag tone={activeRelease ? "mint" : validatedRelease ? "blue" : "amber"}>{activeRelease ? "runtime active" : validatedRelease ? "ready to activate" : "waiting on gates"}</Tag></div>
              <div className="activation-hero">
                <span className="activation-orbit"><Power size={28} /></span>
                <div><Eyebrow>Zero-redeploy control plane</Eyebrow><h3>{validatedRelease?.version ?? activeRelease?.version ?? snapshot?.activeConfigurationVersion ?? BASE_FALLBACK}</h3><p>Agent manifests, policy thresholds, topic mappings, workflows and measure packs are runtime objects—not frontend code.</p></div>
                <div className="activation-facts"><span><small>Runtime effect</small><strong>Hot load</strong></span><span><small>Rollback</small><strong>{validatedRelease?.version ? "Pinned" : activeRelease ? "Available" : "Base"}</strong></span><span><small>External writes</small><strong>Disabled</strong></span></div>
              </div>
              <div className="release-ledger"><div className="release-ledger-head"><span>Release</span><span>Objects</span><span>Created by</span><span>State</span></div>{(snapshot?.releases ?? []).map((release) => <div key={release.releaseId}><span><strong>{release.version}</strong><small>{release.changeSummary}</small></span><span>{release.objectCount}</span><span>{release.createdBy}</span><Tag tone={statusTone(release.status)}>{release.status}</Tag></div>)}</div>
              <div className="production-gate-note"><ShieldCheck size={18} /><div><strong>Production remains deliberately gated.</strong><p>{snapshot?.activation.productionGate}</p></div></div>
              <div className="admin-stage-footer"><div><CloudCog size={15} /><span>Activation changes new server executions immediately; the application bundle is untouched.</span></div><span className="admin-footer-actions"><button className="button button-secondary" type="button" onClick={() => onNavigate("agents")}>Inspect Agent Operations</button><button className="button button-primary" disabled={Boolean(busy) || !validatedRelease} type="button" onClick={() => void activate()}>{busy === "activate-release" ? <LoaderCircle className="is-spinning" size={15} /> : <Rocket size={15} />} Activate release</button></span></div>
            </>
          ) : null}
        </article>
      </section>

      <section className="admin-closed-loop panel">
        <div><SlidersHorizontal size={18} /><span><Eyebrow>What becomes configurable</Eyebrow><strong>No redeploy for operating change</strong></span></div>
        {["Kafka topics & adapters", "Agent triggers & actions", "Policies & thresholds", "CMS measure packs", "Roles & workflows"].map((item) => <span key={item}><CheckCircle2 size={13} /> {item}</span>)}
      </section>
    </div>
  );
}

const BASE_FALLBACK = "renal-harness-2026.08.5";
