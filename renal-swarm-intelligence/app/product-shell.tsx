"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Activity,
  Bell,
  Blocks,
  BookOpenText,
  Box,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CloudCog,
  DatabaseZap,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Menu,
  Network,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRound,
  X,
} from "lucide-react";
import CommandCockpit from "./components/command-cockpit";
import { Tag } from "./components/ui";
import WorkflowDetailDrawer from "./components/workflow-detail-drawer";
import { demoContext, outcomeEpisodes } from "../lib/demo-data";
import { fetchWorkItemContext } from "../lib/control-plane/client";
import type { NavigationId } from "../lib/types";
import type { WorkflowDetail } from "../lib/workflow-detail";

function ModuleLoading({ label }: { label: string }) {
  return <section className="module-loading" aria-live="polite"><span className="module-loading-orbit" /><p>Loading {label}…</p></section>;
}

const PatientIntelligence = dynamic(() => import("./components/patient-intelligence"), { loading: () => <ModuleLoading label="patient intelligence" /> });
const SwarmControl = dynamic(() => import("./components/swarm-control"), { loading: () => <ModuleLoading label="swarm control" /> });
const AgentOperations = dynamic(() => import("./components/agent-operations"), { loading: () => <ModuleLoading label="agent operations" /> });
const AssessmentIntelligence = dynamic(() => import("./components/assessment-intelligence"), { loading: () => <ModuleLoading label="assessment intelligence" /> });
const IntelligenceWorkspace = dynamic(() => import("./components/intelligence-workspace"), { ssr: false, loading: () => <ModuleLoading label="shared intelligence" /> });
const FacilityTwin = dynamic(() => import("./components/facility-twin"), { loading: () => <ModuleLoading label="facility twin" /> });
const CmsControl = dynamic(() => import("./components/cms-control"), { loading: () => <ModuleLoading label="CMS control room" /> });
const ExecutiveOutcomes = dynamic(() => import("./components/executive-outcomes"), { loading: () => <ModuleLoading label="executive outcomes" /> });
const AssuranceCenter = dynamic(() => import("./components/assurance-center"), { loading: () => <ModuleLoading label="assurance center" /> });
const AdminConsole = dynamic(() => import("./components/admin-console"), { loading: () => <ModuleLoading label="platform admin" /> });
const ConfigurationStudio = dynamic(() => import("./components/configuration-studio"), { loading: () => <ModuleLoading label="configuration studio" /> });

type NavItem = {
  id: NavigationId;
  label: string;
  icon: typeof Gauge;
  badge?: string;
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { id: "ecosystem", label: "Swarm control", icon: LayoutDashboard, badge: "LIVE" },
      { id: "agents", label: "Agent operations", icon: Blocks, badge: "12" },
      { id: "command", label: "Outcome command", icon: Gauge, badge: "4" },
      { id: "patient", label: "Patient intelligence", icon: UserRound },
      { id: "facility", label: "Facility operations", icon: Box },
      { id: "assessments", label: "Assessment intelligence", icon: BookOpenText },
    ],
  },
  {
    label: "Understand",
    items: [
      { id: "intelligence", label: "Shared intelligence", icon: Network },
      { id: "executive", label: "Executive outcomes", icon: TrendingUp },
    ],
  },
  {
    label: "Govern",
    items: [
      { id: "cms", label: "CMS operations", icon: ClipboardCheck },
      { id: "assurance", label: "AI assurance", icon: ShieldCheck },
      { id: "admin", label: "Platform admin", icon: CloudCog, badge: "SETUP" },
      { id: "configuration", label: "Configuration studio", icon: Settings2 },
    ],
  },
];

const demoSteps: { nav: NavigationId; eyebrow: string; title: string; body: string }[] = [
  {
    nav: "ecosystem",
    eyebrow: "1 · See the ecosystem",
    title: "The full renal-care enterprise fits one governed cockpit.",
    body: "Switch role and scope, inspect cross-facility insights, rank next-best actions, replay Kafka traffic and simulate policy changes without changing runtime state.",
  },
  {
    nav: "agents",
    eyebrow: "2 · Inspect the specialists",
    title: "Twelve bounded agents contribute without owning the decision.",
    body: "Inspect each agent manifest, trigger contract, proposal authority, evaluation gate, runtime trace, cost and kill-switch boundary.",
  },
  {
    nav: "command",
    eyebrow: "3 · Detect the break",
    title: "A discharge event opens an outcome loop.",
    body: "The harness joins a synthetic discharge, a missing chair confirmation and a transportation barrier into one reviewable continuity episode.",
  },
  {
    nav: "assessments",
    eyebrow: "4 · Understand the person",
    title: "The patient already explained what matters.",
    body: "Exact assessment answers stay attached while bounded extraction identifies a Tuesday ride gap and a goal to preserve morning work.",
  },
  {
    nav: "intelligence",
    eyebrow: "5 · Connect the evidence",
    title: "Shared intelligence makes the reasoning inspectable.",
    body: "Every edge can be traced from source event to patient state, cell proposal, policy decision and intended outcome.",
  },
  {
    nav: "facility",
    eyebrow: "6 · Find a viable path",
    title: "Operations contributes a policy-compatible chair.",
    body: "The facility twin supplies capacity without letting an AI cell reserve, schedule or change care autonomously.",
  },
  {
    nav: "cms",
    eyebrow: "7 · Reuse governed facts",
    title: "The same fabric powers regulatory readiness.",
    body: "Versioned measure packs calculate completeness, preserve lineage and separate public benchmark facts from synthetic operating data.",
  },
  {
    nav: "assurance",
    eyebrow: "8 · Prove before release",
    title: "Green and red teams gate every change.",
    body: "Contract tests, groundedness, isolation and adversarial scenarios must pass before a model, prompt, policy or measure pack can be promoted.",
  },
  {
    nav: "executive",
    eyebrow: "9 · Prove enterprise value",
    title: "Every authorized action rolls into clinical, operational, regulatory and economic outcomes.",
    body: "Executives see portfolio performance without losing role boundaries, valid time, denominator detail or source lineage.",
  },
  {
    nav: "admin",
    eyebrow: "10 · Launch a customer",
    title: "Onboarding becomes one visible, governed release journey.",
    body: "Define the organization, connect the Kafka bridge, configure an agent, run green and red suites, and hot-activate the release without rebuilding code.",
  },
  {
    nav: "configuration",
    eyebrow: "11 · Adapt without rebuilding",
    title: "The harness is configured for change through 2039.",
    body: "FHIR and Kafka mappings, agent permissions, action classes, source versions and measure logic can evolve independently under approval.",
  },
];

export default function ProductShell({ initialNav = "ecosystem" }: { initialNav?: NavigationId }) {
  const [activeNav, setActiveNav] = useState<NavigationId>(initialNav);
  const [selectedId, setSelectedId] = useState(outcomeEpisodes[0].id);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const contextRequest = useRef(0);

  const currentDemo = demoSteps[demoStep];
  const activeLabel = useMemo(
    () => navGroups.flatMap((group) => group.items).find((item) => item.id === activeNav)?.label ?? "Swarm control",
    [activeNav],
  );

  function selectNav(id: NavigationId) {
    setActiveNav(id);
    setSidebarOpen(false);
  }

  function continueWorkflow(id: NavigationId) {
    selectNav(id);
    setWorkflowDetail(null);
  }

  const openWorkflowDetail = useCallback((reference: WorkflowDetail) => {
    const requestId = contextRequest.current + 1;
    contextRequest.current = requestId;
    setWorkflowDetail({
      id: reference.id,
      kind: reference.kind,
      title: "Resolving authorized context",
      summary: "The backend is applying identity, role, scope, purpose and evidence controls.",
      status: "Authorizing",
      tone: "blue",
      owner: "Renal control plane",
      scope: "Server trust boundary",
      steps: [
        { label: "Authenticate", detail: "Resolve workspace identity", state: "current" },
        { label: "Authorize", detail: "Evaluate role and scope", state: "pending" },
        { label: "Assemble", detail: "Project permitted evidence", state: "pending" },
        { label: "Return", detail: "Render safe context", state: "pending" },
      ],
    });
    void fetchWorkItemContext({
      entityId: reference.id,
      entityType: reference.kind,
      target: reference.primary?.target,
    }).then(({ detail }) => {
      if (contextRequest.current === requestId) setWorkflowDetail(detail);
    }).catch((error) => {
      if (contextRequest.current !== requestId) return;
      setWorkflowDetail({
        id: reference.id,
        kind: reference.kind,
        title: "Context unavailable",
        summary: error instanceof Error ? error.message : "The server could not assemble authorized context.",
        status: "Blocked",
        tone: "red",
        owner: "Renal control plane",
        scope: "No client fallback",
        steps: [
          { label: "Authenticate", detail: "Identity request received", state: "done" },
          { label: "Authorize", detail: "Request denied or unavailable", state: "blocked" },
          { label: "Assemble", detail: "Client-supplied evidence was not trusted", state: "pending" },
        ],
        control: "The interface fails closed. It does not fall back to client-assembled evidence or actions.",
      });
    });
  }, []);

  function launchDemo() {
    setDemoStep(0);
    setDemoOpen(true);
    setActiveNav("ecosystem");
  }

  function moveDemo(direction: -1 | 1) {
    const next = Math.max(0, Math.min(demoSteps.length - 1, demoStep + direction));
    setDemoStep(next);
    setActiveNav(demoSteps[next].nav);
  }

  return (
    <div className="product-shell">
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark"><Activity size={21} aria-hidden="true" /></span>
          <div><strong>Renal Swarm</strong><small>Governed agentic outcome harness</small></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" type="button"><X size={18} /></button>
        </div>

        <nav className="nav-groups">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button className={`nav-item ${activeNav === item.id ? "is-active" : ""}`} key={item.id} onClick={() => selectNav(item.id)} type="button">
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.badge ? <small>{item.badge}</small> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="status-title"><span className="healthy-dot" /><strong>Harness healthy</strong><span>99.97%</span></div>
          <p>12 agents · 14 policies · 8 verified sources</p>
          <div className="status-footer"><span>Replay mode</span><span>v0.9.0</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation" type="button"><Menu size={19} /></button>
            <div className="workspace-context"><span>{activeNav === "ecosystem" || activeNav === "executive" ? demoContext.organization : demoContext.region}</span><strong>{activeLabel}</strong></div>
          </div>
          <div className="topbar-right">
            <Tag tone="violet"><FlaskConical size={12} /> Synthetic patient data</Tag>
            <Tag tone="mint"><DatabaseZap size={12} /> Public sources verified</Tag>
            <button className="icon-button notification-button" aria-label="Open workflow notifications" type="button" onClick={() => openWorkflowDetail({ id: "NOTIFY-REGION-03", kind: "Workflow inbox", title: "Workflow inbox", summary: "", status: "", owner: "", scope: "", primary: { label: "Open Swarm Control", target: "ecosystem" } })}><Bell size={18} /><span /></button>
            <button className="profile-button" aria-label="Open operator profile and decision rights" type="button" onClick={() => openWorkflowDetail({ id: "ROLE-ROD-MTN", kind: "Operator context", title: "Operator context", summary: "", status: "", owner: "", scope: "", primary: { label: "Inspect configuration", target: "configuration" } })}><span>AR</span><div><strong>Alex Rivera</strong><small>Regional operator</small></div></button>
          </div>
        </header>

        <main className="content-shell">
          {activeNav === "ecosystem" ? <SwarmControl onNavigate={selectNav} onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "agents" ? <AgentOperations onNavigate={selectNav} onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "command" ? <CommandCockpit selectedId={selectedId} onSelect={setSelectedId} onOpenDemo={launchDemo} onNavigate={selectNav} onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "patient" ? <PatientIntelligence onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "assessments" ? <AssessmentIntelligence onNavigate={selectNav} onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "intelligence" ? <IntelligenceWorkspace onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "facility" ? <FacilityTwin onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "cms" ? <CmsControl onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "executive" ? <ExecutiveOutcomes onNavigate={selectNav} onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "assurance" ? <AssuranceCenter onOpenDetail={openWorkflowDetail} /> : null}
          {activeNav === "admin" ? <AdminConsole onNavigate={selectNav} /> : null}
          {activeNav === "configuration" ? <ConfigurationStudio onOpenDetail={openWorkflowDetail} onNavigate={selectNav} /> : null}
        </main>
      </div>

      {sidebarOpen ? <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation overlay" type="button" /> : null}

      <aside className={`demo-drawer ${demoOpen ? "is-open" : ""}`} aria-label="Guided product demo" aria-hidden={!demoOpen}>
        <div className="demo-drawer-top">
          <div className="inline-cluster"><Sparkles size={15} /><span>Guided enterprise journey</span></div>
          <button className="icon-button" onClick={() => setDemoOpen(false)} aria-label="Close guided demo" type="button"><X size={18} /></button>
        </div>
        <div className="demo-progress" aria-label={`Demo step ${demoStep + 1} of ${demoSteps.length}`}>
          {demoSteps.map((_, index) => <span className={index <= demoStep ? "is-complete" : ""} key={index} />)}
        </div>
        <div className="demo-copy">
          <p className="eyebrow">{currentDemo.eyebrow}</p>
          <h2>{currentDemo.title}</h2>
          <p>{currentDemo.body}</p>
          <div className="demo-proof"><ShieldCheck size={17} /><span>Every screen preserves provenance, policy and human control.</span></div>
        </div>
        <div className="demo-drawer-footer">
          <button className="button button-secondary" disabled={demoStep === 0} onClick={() => moveDemo(-1)} type="button"><ChevronLeft size={16} /> Back</button>
          {demoStep < demoSteps.length - 1 ? (
            <button className="button button-primary" onClick={() => moveDemo(1)} type="button">Next <ChevronRight size={16} /></button>
          ) : (
            <button className="button button-primary" onClick={() => { setDemoOpen(false); setActiveNav("ecosystem"); }} type="button"><Blocks size={16} /> Finish tour</button>
          )}
        </div>
      </aside>
      <WorkflowDetailDrawer key={workflowDetail?.id ?? "closed"} detail={workflowDetail} onClose={() => setWorkflowDetail(null)} onNavigate={continueWorkflow} />
    </div>
  );
}
