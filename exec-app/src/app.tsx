import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  Blocks,
  BookOpenText,
  Box,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  ClipboardList,
  CloudCog,
  DatabaseZap,
  FlaskConical,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorUp,
  Network,
  Settings2,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UserRound,
  X,
} from "lucide-react";
import SwarmControl from "./components/swarm-control";
import MyWork from "./components/my-work";
import ExecutiveOutcomes from "./components/executive-outcomes";
import AgentOperations from "./components/agent-operations";
import CommandCockpit from "./components/command-cockpit";
import PatientIntelligence from "./components/patient-intelligence";
import AssessmentIntelligence from "./components/assessment-intelligence";
import IntelligenceWorkspace from "./components/intelligence-workspace";
import FacilityTwin from "./components/facility-twin";
import CmsControl from "./components/cms-control";
import AnemiaCds from "./components/anemia-cds";
import ProtocolCockpit from "./components/protocol-cockpit";
import AssuranceCenter from "./components/assurance-center";
import AdminConsole from "./components/admin-console";
import ConfigurationStudio from "./components/configuration-studio";
import WorkflowDetailDrawer from "./components/workflow-detail-drawer";
import { Tag } from "./components/ui";
import { demoContext, outcomeEpisodes } from "./lib/catalogs";
import { fetchWorkItemContext, fetchRuntimeSnapshot } from "./lib/harness";
import { onSessionExpired } from "./lib/session";
import { fetchContext } from "./lib/work";
import type { MeUser } from "./lib/auth";
import type { NavigationId } from "./lib/types";
import type { WorkflowDetail } from "./lib/workflow-detail";

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
      { id: "my-work", label: "My Work", icon: ClipboardList },
      { id: "ecosystem", label: "Swarm control", icon: LayoutDashboard, badge: "LIVE" },
      { id: "agents", label: "Agent operations", icon: Blocks, badge: "12" },
      { id: "command", label: "Outcome command", icon: Gauge, badge: "4" },
      { id: "patient", label: "Patient intelligence", icon: UserRound },
      { id: "anemia", label: "Anemia & ESA", icon: HeartPulse, badge: "CDSS" },
      { id: "protocols", label: "Protocol cockpit", icon: FlaskConical, badge: "7" },
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
  { nav: "ecosystem", eyebrow: "1 · See the ecosystem", title: "The full renal-care enterprise fits one governed cockpit.", body: "Switch role and scope, inspect cross-facility insights, rank next-best actions and simulate policy changes without changing runtime state." },
  { nav: "agents", eyebrow: "2 · Inspect the specialists", title: "Twelve bounded cells contribute without owning the decision.", body: "Inspect each cell manifest, trigger contract, proposal authority, evaluation gate and kill-switch boundary." },
  { nav: "command", eyebrow: "3 · Detect the break", title: "A discharge event opens an outcome loop.", body: "The harness joins a synthetic discharge, a missing chair confirmation and a transportation barrier into one reviewable continuity episode." },
  { nav: "executive", eyebrow: "4 · Prove enterprise value", title: "Every authorized action rolls into clinical, operational, regulatory and economic outcomes.", body: "Executives see portfolio performance without losing role boundaries, valid time, denominator detail or source lineage." },
  { nav: "assurance", eyebrow: "5 · Prove before release", title: "Green and red teams gate every change.", body: "Contract tests, groundedness, isolation and adversarial scenarios must pass before a model, prompt, policy or measure pack can be promoted." },
  { nav: "configuration", eyebrow: "6 · Adapt without rebuilding", title: "The harness is configured for change through 2039.", body: "FHIR and Kafka mappings, agent permissions, action classes, source versions and measure logic can evolve independently under approval." },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator", md: "Medical Director", nurse: "Nurse", pharmacist: "Pharmacist",
  coder: "Medical Coder", auditor: "Compliance Auditor", "facilities-tech": "Facilities Technician", safety: "Safety Officer",
};

/** Lens-aware terminology — the active solution-pack lens from /api/context.
 *  Payer users never see renal concepts (spec §6.4 acceptance). */
const LENS_TEXT = {
  brand: { provider: "Renal Swarm", payer: "Anant Payer" } as Record<string, string>,
  brandSub: { provider: "Observer Mechanics", payer: "Outcome orchestration" } as Record<string, string>,
  syntheticTag: { provider: "Synthetic patient data", payer: "Synthetic member data" } as Record<string, string>,
  statusLine: { provider: "12 cells · 14 policies · 8 verified sources", payer: "6 payer cells · 4 policies · 8 verified sources" } as Record<string, string>,
  patientNav: { provider: "Patient intelligence", payer: "Member intelligence" } as Record<string, string>,
};

function userInitials(user?: MeUser | null): string {
  const name = user?.displayName || user?.username || "Operator";
  return name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

export default function AppShell({ initialNav = "my-work", user, onLogout }: { initialNav?: NavigationId; user?: MeUser | null; onLogout?: () => void }) {
  const [activeNav, setActiveNav] = useState<NavigationId>(initialNav);
  const [selectedId, setSelectedId] = useState(outcomeEpisodes[0].id);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("hh-exec-sidebar") === "collapsed"; } catch { return false; } });
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [canSwitchToOps, setCanSwitchToOps] = useState(false);
  const [lens, setLens] = useState<"provider" | "payer" | "hybrid">("provider");
  // U #7 — one session-expiry banner for the whole console. Any 401 from any
  // fetch wrapper (harness/anemia/work/catalog) signals this; the page keeps its
  // own empty/loading/error states, but the sign-in gate is always the same.
  const [sessionExpired, setSessionExpired] = useState(false);
  const contextRequest = useRef(0);

  // Server-authorized console switcher (P0-6) + active lens. The pack/lens comes
  // from /api/context (the generic platform org's operating model) — the shell
  // adapts terminology so payer users never see renal concepts. The UI never
  // decides authorization or the lens.
  useEffect(() => {
    let active = true;
    void fetchContext().then((ctx) => {
      if (!active) return;
      setCanSwitchToOps((ctx.consoles ?? []).includes("ops"));
      if (ctx.pack?.lens === "payer" || ctx.pack?.lens === "hybrid") setLens(ctx.pack.lens);
    }).catch(() => { /* console/lens unavailable */ });
    return () => { active = false; };
  }, []);

  // U #7 — subscribe to 401s so the banner shows on whichever page it happens.
  useEffect(() => onSessionExpired(() => setSessionExpired(true)), []);

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("hh-exec-sidebar", next ? "collapsed" : "docked"); } catch { /* ignore */ }
      return next;
    });
  }

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
    // Render the caller's assembled context immediately (it is derived from
    // server state). The harness then enriches provenance server-side where a
    // branch exists (insight / nba / episode); otherwise the caller's context
    // is kept so every work item opens its own, non-generic drawer.
    setWorkflowDetail(reference);
    void fetchWorkItemContext({
      entityId: reference.id,
      entityType: reference.kind,
      ...(reference.primary?.target ? { target: reference.primary.target } : {}),
    }, reference).then(({ detail }) => {
      if (contextRequest.current === requestId) setWorkflowDetail(detail);
    }).catch(() => {
      // Keep the caller's assembled context on failure — never a blank drawer.
    });
  }, []);

  function openInbox() {
    void fetchRuntimeSnapshot().then((snapshot) => {
      const pendingActions = snapshot.actions.filter((a) => a.status === "review" || a.status === "queued");
      const pendingEpisodes = snapshot.episodes.filter((e) => e.state === "AwaitingApproval" || e.state === "Proposed" || e.state === "Observed");
      const hasWork = pendingActions.length > 0 || pendingEpisodes.length > 0 || (snapshot.health.conflicts ?? 0) > 0;
      openWorkflowDetail({
        id: "WORKFLOW-INBOX",
        kind: "Workflow inbox",
        title: "Workflow inbox",
        summary: hasWork
          ? `${pendingActions.length} next-best action(s) await approval · ${pendingEpisodes.length} outcome episode(s) open · ${snapshot.health.conflicts ?? 0} retained conflict(s).`
          : "No decisions are currently awaiting the operator. New signals appear here as soon as the harness retains them.",
        status: hasWork ? `${pendingActions.length + pendingEpisodes.length} open` : "Clear",
        tone: hasWork ? "amber" : "mint",
        owner: user?.displayName || user?.username || "Operator",
        scope: "All operator scopes",
        metrics: [
          { label: "Actions awaiting approval", value: String(pendingActions.length) },
          { label: "Open episodes", value: String(pendingEpisodes.length) },
          { label: "Retained conflicts", value: String(snapshot.health.conflicts ?? 0) },
          { label: "Total signals", value: String(snapshot.counts.events ?? 0) },
        ],
        evidence: [
          ...pendingActions.slice(0, 6).map((a) => ({ label: "Action", value: a.title, source: a.scopeId })),
          ...pendingEpisodes.slice(0, 6).map((e) => ({ label: "Episode", value: `${String(e.kind ?? "")} · ${String(e.subject ?? "")}`, source: String(e.state ?? "") })),
        ],
        steps: [
          { label: "Observe", detail: "Signals retained from the event fabric", state: "done" },
          { label: "Rank", detail: "Next-best actions scored by outcome, urgency and policy", state: "done" },
          { label: "Review", detail: hasWork ? "Operator decision required" : "No pending decision", state: hasWork ? "current" : "done" },
          { label: "Command", detail: "Approved actions become durable commands", state: "pending" },
        ],
        primary: { label: "Open Outcome Command", target: "command" },
      });
    }).catch(() => {
      openWorkflowDetail({
        id: "WORKFLOW-INBOX",
        kind: "Workflow inbox",
        title: "Workflow inbox",
        summary: "The live decision queue could not be loaded. Reconnect to see actions awaiting approval.",
        status: "Unavailable",
        tone: "red",
        owner: user?.displayName || user?.username || "Operator",
        scope: "All operator scopes",
        metrics: [{ label: "Status", value: "Unavailable" }],
        evidence: [],
        steps: [{ label: "Observe", detail: "Queue request failed", state: "blocked" }],
        primary: { label: "Open Outcome Command", target: "command" },
      });
    });
  }

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

  const module = (() => {
    switch (activeNav) {
      case "my-work": return <MyWork onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "ecosystem": return <SwarmControl onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "agents": return <AgentOperations onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "command": return <CommandCockpit selectedId={selectedId} onSelect={setSelectedId} onOpenDemo={launchDemo} onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "patient": return <PatientIntelligence onOpenDetail={openWorkflowDetail} />;
      case "anemia": return <AnemiaCds onNavigate={selectNav} />;
      case "protocols": return <ProtocolCockpit onNavigate={selectNav} />;
      case "assessments": return <AssessmentIntelligence onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "intelligence": return <IntelligenceWorkspace onOpenDetail={openWorkflowDetail} />;
      case "facility": return <FacilityTwin onOpenDetail={openWorkflowDetail} />;
      case "cms": return <CmsControl onOpenDetail={openWorkflowDetail} />;
      case "executive": return <ExecutiveOutcomes onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />;
      case "assurance": return <AssuranceCenter onOpenDetail={openWorkflowDetail} />;
      case "admin": return <AdminConsole onNavigate={selectNav} />;
      case "configuration": return <ConfigurationStudio onOpenDetail={openWorkflowDetail} onNavigate={selectNav} />;
    }
  })();

  return (
    <div className={`product-shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className={`sidebar ${collapsed ? "is-collapsed" : ""} ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark"><Activity size={21} aria-hidden="true" /></span>
          <div><strong>{LENS_TEXT.brand[lens] ?? "Renal Swarm"}</strong><small>{LENS_TEXT.brandSub[lens] ?? "Observer Mechanics"}</small></div>
          <button className="icon-button sidebar-collapse" onClick={toggleCollapse} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} type="button">{collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}</button>
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
                    <span>{item.id === "patient" ? (LENS_TEXT.patientNav[lens] ?? item.label) : item.label}</span>
                    {item.badge ? <small>{item.badge}</small> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="status-title"><span className="healthy-dot" /><strong>Harness healthy</strong><span>99.97%</span></div>
          <p>{LENS_TEXT.statusLine[lens] ?? "12 cells · 14 policies · 8 verified sources"}</p>
          <div className="status-footer"><span>Postgres outbox</span><span>v0.1.0</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation" type="button"><Menu size={19} /></button>
            <div className="workspace-context"><span>{activeNav === "my-work" || activeNav === "ecosystem" || activeNav === "executive" ? demoContext.organization : demoContext.region}</span><strong>{activeLabel}</strong></div>
          </div>
          <div className="topbar-right">
            <Tag tone="violet"><FlaskConical size={12} /> {LENS_TEXT.syntheticTag[lens] ?? "Synthetic patient data"}</Tag>
            <Tag tone="mint"><DatabaseZap size={12} /> Public sources verified</Tag>
            {canSwitchToOps ? (
              <a className="button button-ghost console-switch" href="/admin/ui/" title="Open the AnantHealth operator console (server-authorized)"><MonitorUp size={13} /> Operator console</a>
            ) : null}
            <button className="icon-button notification-button" aria-label="Open workflow inbox" type="button" onClick={() => void openInbox()}><Bell size={18} /><span /></button>
            <button className="profile-button" aria-label="Open operator profile and decision rights" type="button" onClick={() => openWorkflowDetail({ id: `PROFILE-${user?.username ?? "operator"}`, kind: "Operator profile", title: user?.displayName || user?.username || "Operator", summary: "Session identity, role, clearance and purpose-of-use scoping for this console. Authority is enforced server-side on every request.", status: "Session active", tone: "mint", owner: user?.displayName || user?.username || "Operator", scope: ROLE_LABELS[user?.role ?? ""] ?? (user?.role ?? "Operator"), metrics: [{ label: "Username", value: user?.username ?? "—" }, { label: "Role", value: user?.role ?? "—" }, { label: "Clearance", value: user?.clearance ?? "—" }, { label: "Purpose of use", value: (user?.purposeOfUse ?? []).join(", ") || "—" }], evidence: [{ label: "Session", value: user?.username ?? "operator", source: "Server-issued hh_session cookie" }], steps: [{ label: "Authenticate", detail: "Session resolved from hh_session", state: "done" }, { label: "Authorize", detail: "Role and scope evaluated server-side", state: "done" }, { label: "Use", detail: "Purpose-of-use scoped evidence only", state: "current" }], control: "The browser never grants authority. Each /admin/* request re-verifies the session, role and console scope.", primary: { label: "Inspect configuration", target: "configuration" } })}><span>{userInitials(user)}</span><div><strong>{user?.displayName || user?.username || "Operator"}</strong><small>{ROLE_LABELS[user?.role ?? ""] ?? (user?.role ?? "Operator")}</small></div></button>
            <button className="icon-button signout-button" aria-label="Sign out" title="Sign out" type="button" onClick={() => onLogout?.()}><LogOut size={17} /></button>
          </div>
        </header>

        {sessionExpired ? (
          <div className="session-expired-banner" role="alert">
            <ShieldAlert size={16} />
            <span><strong>Session expired.</strong> The server cleared your sign-in — this happens when the dev server restarts. Re-authenticate to keep working; no state is lost.</span>
            <button className="button button-secondary" type="button" onClick={() => window.location.reload()}>Sign in again</button>
          </div>
        ) : null}

        <main className="content-shell">
          {module}
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
