"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Activity,
  Bell,
  Blocks,
  BookOpenText,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardCheck,
  CloudCog,
  DatabaseZap,
  ExternalLink,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  ListChecks,
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
import { outcomeEpisodes } from "../lib/demo-data";
import { fetchWorkItemContext } from "../lib/control-plane/client";
import type { NavigationId, RoleId } from "../lib/types";
import type { WorkflowDetail } from "../lib/workflow-detail";

/* ── Dynamic module imports ─────────────────────────────────────────── */

function ModuleLoading({ label }: { label: string }) {
  return (
    <section className="module-loading" aria-live="polite">
      <span className="module-loading-orbit" />
      <p>Loading {label}…</p>
    </section>
  );
}

const PatientIntelligence    = dynamic(() => import("./components/patient-intelligence"),    { loading: () => <ModuleLoading label="patient intelligence" /> });
const SwarmControl           = dynamic(() => import("./components/swarm-control"),           { loading: () => <ModuleLoading label="swarm control" /> });
const AgentOperations        = dynamic(() => import("./components/agent-operations"),        { loading: () => <ModuleLoading label="agent operations" /> });
const AssessmentIntelligence = dynamic(() => import("./components/assessment-intelligence"), { loading: () => <ModuleLoading label="assessment intelligence" /> });
const IntelligenceWorkspace  = dynamic(() => import("./components/intelligence-workspace"),  { ssr: false, loading: () => <ModuleLoading label="shared intelligence" /> });
const FacilityTwin           = dynamic(() => import("./components/facility-twin"),           { loading: () => <ModuleLoading label="facility twin" /> });
const CmsControl             = dynamic(() => import("./components/cms-control"),             { loading: () => <ModuleLoading label="CMS control room" /> });
const ExecutiveOutcomes      = dynamic(() => import("./components/executive-outcomes"),      { loading: () => <ModuleLoading label="executive outcomes" /> });
const AssuranceCenter        = dynamic(() => import("./components/assurance-center"),        { loading: () => <ModuleLoading label="assurance center" /> });
const AdminConsole           = dynamic(() => import("./components/admin-console"),           { loading: () => <ModuleLoading label="platform admin" /> });
const ConfigurationStudio    = dynamic(() => import("./components/configuration-studio"),    { loading: () => <ModuleLoading label="configuration studio" /> });

/* ── Role definitions ───────────────────────────────────────────────── */

interface RoleProfile {
  initials: string;
  name: string;
  roleLabel: string;
  scopeLabel: string;
}

const roleProfiles: Record<RoleId, RoleProfile> = {
  evp:     { initials: "JH", name: "Jordan Hayes",  roleLabel: "Enterprise Operations Executive", scopeLabel: "Riverbend Kidney Care" },
  dvp:     { initials: "AR", name: "Alex Rivera",   roleLabel: "Division Vice President",          scopeLabel: "Southeast Division" },
  rod:     { initials: "MT", name: "Marcus Taylor", roleLabel: "Regional Operations Director",     scopeLabel: "Middle Tennessee" },
  fa:      { initials: "SP", name: "Sam Park",      roleLabel: "Facility Administrator",           scopeLabel: "Riverbend Franklin" },
  medical: { initials: "DK", name: "Dr. D. Kim",    roleLabel: "Medical Director",                 scopeLabel: "Riverbend Franklin" },
  quality: { initials: "LC", name: "Laura Chen",    roleLabel: "Regional Quality Director",        scopeLabel: "Middle Tennessee" },
  finance: { initials: "RP", name: "Robin Park",    roleLabel: "VP Finance",                       scopeLabel: "Southeast Division" },
  biomed:  { initials: "AJ", name: "Alex Johnson",  roleLabel: "Biomedical Director",              scopeLabel: "Southeast Division" },
};

const roleGroups: { label: string; roles: RoleId[] }[] = [
  { label: "Enterprise", roles: ["evp"] },
  { label: "Division",   roles: ["dvp", "finance", "biomed"] },
  { label: "Region",     roles: ["rod", "quality"] },
  { label: "Facility",   roles: ["fa", "medical"] },
];

/** Role → natural landing screen */
const roleDefaultNav: Record<RoleId, NavigationId> = {
  fa:      "command",
  rod:     "ecosystem",
  dvp:     "ecosystem",
  evp:     "executive",
  medical: "patient",
  quality: "cms",
  finance: "executive",
  biomed:  "facility",
};

/** Role → set of primary / most-relevant screens (highlighted in nav) */
const rolePrimaryScreens: Record<RoleId, ReadonlySet<NavigationId>> = {
  fa:      new Set(["command", "patient", "assessments", "facility"]),
  rod:     new Set(["ecosystem", "command", "intelligence"]),
  dvp:     new Set(["ecosystem", "executive", "intelligence"]),
  evp:     new Set(["executive", "ecosystem"]),
  medical: new Set(["patient", "assessments", "command"]),
  quality: new Set(["cms", "assurance", "intelligence"]),
  finance: new Set(["executive", "ecosystem"]),
  biomed:  new Set(["facility", "ecosystem"]),
};

/* ── Navigation definition (reordered: command first) ──────────────── */

type NavItem = { id: NavigationId; label: string; icon: typeof Gauge; badge?: string };

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    // Operate: daily work at every level — the screens people open every day
    label: "Operate",
    items: [
      { id: "command",     label: "Daily command",          icon: Gauge,           badge: "4" },
      { id: "patient",     label: "Clinical population",   icon: UserRound },
      { id: "assessments", label: "Clinical assessments",  icon: BookOpenText },
      { id: "facility",    label: "Facility & capacity",   icon: Box },
      { id: "ecosystem",   label: "Enterprise oversight",  icon: LayoutDashboard, badge: "LIVE" },
      { id: "agents",      label: "AI observers",          icon: Blocks,          badge: "12" },
    ],
  },
  {
    // Understand: population-level intelligence and strategic outcomes
    label: "Understand",
    items: [
      { id: "intelligence", label: "Intelligence graph",   icon: Network },
      { id: "executive",    label: "Strategic outcomes",   icon: TrendingUp },
    ],
  },
  {
    // Govern: regulatory compliance, AI quality gates, and domain-specific configuration
    // Platform infrastructure configuration lives in the Operator Console (Admin UI)
    label: "Govern",
    items: [
      { id: "cms",           label: "Regulatory compliance", icon: ClipboardCheck },
      { id: "assurance",     label: "AI assurance",          icon: ShieldCheck },
      { id: "configuration", label: "Domain configuration",  icon: Settings2 },
    ],
  },
];

/* ── Journey / getting-started steps ────────────────────────────────── */

const journeySteps: { nav: NavigationId; label: string; eyebrow: string; title: string; body: string }[] = [
  { nav: "ecosystem",    label: "Enterprise oversight",     eyebrow: "1 · Enterprise oversight",     title: "The full renal-care enterprise in one governed cockpit.",         body: "Switch role and scope, inspect cross-facility insights, rank next-best actions, replay Kafka traffic and simulate policy changes without touching runtime state." },
  { nav: "agents",       label: "AI observers",             eyebrow: "2 · AI observers",             title: "Twelve bounded observers perceive, assess and propose — they never act alone.", body: "Inspect each observer's perception scope, proposal authority, evaluation gate, runtime trace, cost ceiling and kill-switch boundary." },
  { nav: "command",      label: "Daily command",            eyebrow: "3 · Daily command",            title: "A discharge event opens an outcome loop.",                       body: "The harness joins a synthetic discharge, a missing chair confirmation and a transportation barrier into one reviewable continuity episode — visible to the facility team." },
  { nav: "assessments",  label: "Clinical assessments",     eyebrow: "4 · Clinical assessments",     title: "The clinical record already explained what matters.",             body: "Exact assessment answers stay attached while bounded extraction identifies a Tuesday ride gap and a goal to preserve morning work." },
  { nav: "intelligence", label: "Intelligence graph",       eyebrow: "5 · Intelligence graph",       title: "Cross-population intelligence makes the reasoning inspectable.",  body: "Every edge can be traced from source event to clinical state, cell proposal, policy decision and intended outcome." },
  { nav: "facility",     label: "Facility & capacity",      eyebrow: "6 · Facility & capacity",      title: "Operations contributes a policy-compatible chair.",               body: "The facility twin supplies capacity without letting an AI cell reserve, schedule or change care autonomously." },
  { nav: "cms",          label: "Regulatory compliance",    eyebrow: "7 · Regulatory compliance",    title: "The same fabric powers regulatory readiness.",                   body: "Versioned measure packs calculate completeness, preserve lineage and separate public benchmark facts from synthetic operating data." },
  { nav: "assurance",    label: "AI assurance",             eyebrow: "8 · AI assurance",             title: "Green and red teams gate every change.",                         body: "Contract tests, groundedness, isolation and adversarial scenarios must pass before a model, prompt, policy or measure pack can be promoted." },
  { nav: "executive",    label: "Strategic outcomes",       eyebrow: "9 · Strategic outcomes",       title: "Every authorized action rolls into clinical, operational, regulatory and economic outcomes.", body: "Leadership sees portfolio performance without losing role boundaries, valid time, denominator detail or source lineage." },
  { nav: "admin",        label: "Onboarding journey",       eyebrow: "10 · Onboarding journey",      title: "Onboarding is a visible, governed release journey.",              body: "Platform setup (org, Kafka, agents, validation, activation) lives in the Operator Console. This view shows what a configured and activated domain looks like." },
  { nav: "configuration",label: "Domain configuration",    eyebrow: "11 · Domain configuration",    title: "The renal harness is configured for change — not code.",          body: "FHIR→canonical mappings, adapter contracts, agent permissions, measure pack versions and action classes evolve independently under an approval gate. Platform infrastructure config lives in the Operator Console." },
];

/* ── LocalStorage helpers ────────────────────────────────────────────── */

const LS_ROLE             = "rsi-role-id";
const LS_VISITED          = "rsi-visited-screens";
const LS_SETUP_DISMISSED  = "rsi-setup-dismissed";
const LS_CHECKLIST_OPEN   = "rsi-checklist-open";

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function readLocalSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

function writeLocalSet(key: string, value: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* ignore */ }
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function ProductShell({ initialNav }: { initialNav?: NavigationId } = {}) {
  /* State */
  const [roleId, setRoleId]                 = useState<RoleId>("fa");
  const [activeNav, setActiveNav]           = useState<NavigationId>("command");
  const [selectedId, setSelectedId]         = useState(outcomeEpisodes[0].id);
  const [visitedScreens, setVisitedScreens] = useState<Set<string>>(new Set());
  const [checklistOpen, setChecklistOpen]   = useState(true);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [demoOpen, setDemoOpen]             = useState(false);
  const [demoStep, setDemoStep]             = useState(0);
  const [sidebarOpen, setSidebarOpen]       = useState(false);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);

  const contextRequest = useRef(0);

  /* Hydrate from localStorage (client-only, after mount) */
  useEffect(() => {
    const savedRole  = safeGet(LS_ROLE) as RoleId | null;
    const role: RoleId = (savedRole && savedRole in roleProfiles) ? savedRole : "fa";

    setRoleId(role);
    // Honour a deep-link initialNav hint (sub-pages like /executive-outcomes);
    // fall back to the role's natural home screen.
    setActiveNav(initialNav ?? roleDefaultNav[role]);
    setVisitedScreens(readLocalSet(LS_VISITED));
    setChecklistOpen(safeGet(LS_CHECKLIST_OPEN) !== "false");
    setSetupDismissed(safeGet(LS_SETUP_DISMISSED) === "true");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Derived */
  const profile        = roleProfiles[roleId];
  const primaryScreens = rolePrimaryScreens[roleId];
  const currentStep    = journeySteps[demoStep];
  const visitedCount   = journeySteps.filter((s) => visitedScreens.has(s.nav)).length;
  const allVisited     = visitedCount === journeySteps.length;

  const activeLabel = useMemo(
    () => navGroups.flatMap((g) => g.items).find((item) => item.id === activeNav)?.label ?? "Outcome command",
    [activeNav],
  );

  /* Navigation ─────────────────────────────────────────────────────── */

  function selectNav(id: NavigationId) {
    setActiveNav(id);
    setSidebarOpen(false);
    const next = new Set(visitedScreens);
    next.add(id);
    setVisitedScreens(next);
    writeLocalSet(LS_VISITED, next);
  }

  function changeRole(id: RoleId) {
    setRoleId(id);
    safeSet(LS_ROLE, id);
    setRoleDropdownOpen(false);
    selectNav(roleDefaultNav[id]);
  }

  function continueWorkflow(id: NavigationId) {
    selectNav(id);
    setWorkflowDetail(null);
  }

  /* Checklist / setup ─────────────────────────────────────────────── */

  function toggleChecklist() {
    const next = !checklistOpen;
    setChecklistOpen(next);
    safeSet(LS_CHECKLIST_OPEN, String(next));
  }

  function dismissSetup() {
    setSetupDismissed(true);
    safeSet(LS_SETUP_DISMISSED, "true");
  }

  /* Workflow detail ────────────────────────────────────────────────── */

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
        { label: "Authenticate", detail: "Resolve workspace identity",  state: "current" },
        { label: "Authorize",    detail: "Evaluate role and scope",      state: "pending" },
        { label: "Assemble",     detail: "Project permitted evidence",   state: "pending" },
        { label: "Return",       detail: "Render safe context",          state: "pending" },
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
          { label: "Authenticate", detail: "Identity request received",              state: "done" },
          { label: "Authorize",    detail: "Request denied or unavailable",          state: "blocked" },
          { label: "Assemble",     detail: "Client-supplied evidence was not trusted", state: "pending" },
        ],
        control: "The interface fails closed. It does not fall back to client-assembled evidence or actions.",
      });
    });
  }, []);

  /* Demo ───────────────────────────────────────────────────────────── */

  function launchDemo() {
    setDemoStep(0);
    setDemoOpen(true);
    selectNav("ecosystem");
  }

  function moveDemo(direction: -1 | 1) {
    const next = Math.max(0, Math.min(journeySteps.length - 1, demoStep + direction));
    setDemoStep(next);
    selectNav(journeySteps[next].nav);
  }

  /* Close role dropdown on outside click */
  useEffect(() => {
    if (!roleDropdownOpen) return;
    function handle(event: MouseEvent) {
      if (!(event.target as Element).closest(".role-selector-wrap")) setRoleDropdownOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [roleDropdownOpen]);

  /* ── Render ────────────────────────────────────────────────────────── */
  return (
    <div className="product-shell">

      {/* ── Sidebar ── */}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Primary navigation">

        {/* Brand */}
        <div className="brand-lockup">
          <span className="brand-mark"><Activity size={21} aria-hidden="true" /></span>
          <div>
            <strong>Renal Swarm</strong>
            <small>Governed agentic outcome harness</small>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" type="button">
            <X size={18} />
          </button>
        </div>

        {/* Nav groups */}
        <nav className="nav-groups">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isPrimary = primaryScreens.has(item.id);
                const isActive  = activeNav === item.id;
                return (
                  <button
                    className={`nav-item${isActive ? " is-active" : ""}${isPrimary ? " is-primary" : ""}`}
                    key={item.id}
                    onClick={() => selectNav(item.id)}
                    type="button"
                    title={isPrimary ? `Primary screen for ${profile.roleLabel}` : undefined}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                    {isPrimary && !isActive
                      ? <span className="nav-primary-dot" aria-hidden="true" />
                      : item.badge
                        ? <small>{item.badge}</small>
                        : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Getting-started checklist */}
        <div className="sidebar-checklist">
          <button className="checklist-header" onClick={toggleChecklist} type="button">
            <ListChecks size={13} aria-hidden="true" />
            <span>Product tour</span>
            <span className="checklist-fraction">{visitedCount}/{journeySteps.length}</span>
            <ChevronDown
              size={12}
              className={`checklist-chevron${checklistOpen ? " is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
          {checklistOpen && (
            <div className="checklist-items">
              {journeySteps.map((step) => {
                const visited = visitedScreens.has(step.nav);
                return (
                  <button
                    className={`checklist-item${visited ? " is-done" : ""}`}
                    key={step.nav}
                    onClick={() => selectNav(step.nav)}
                    type="button"
                  >
                    {visited
                      ? <CheckCircle2 size={12} className="checklist-check" aria-hidden="true" />
                      : <Circle size={12} className="checklist-circle" aria-hidden="true" />}
                    <span>{step.label}</span>
                  </button>
                );
              })}
              {allVisited ? (
                <p className="checklist-complete"><Sparkles size={11} aria-hidden="true" /> All screens explored</p>
              ) : (
                <button className="button button-ghost checklist-demo-btn" onClick={launchDemo} type="button">
                  <Sparkles size={12} aria-hidden="true" /> Run guided demo
                </button>
              )}
            </div>
          )}
        </div>

        {/* Status + Admin UI link */}
        <div className="sidebar-status">
          <div className="status-title">
            <span className="healthy-dot" />
            <strong>Harness healthy</strong>
            <span>99.97%</span>
          </div>
          <p>12 agents · 14 policies · 8 verified sources</p>
          <div className="status-footer">
            <span>v0.9.0</span>
            <a
              className="admin-console-link"
              href="http://localhost:8080/admin/ui/"
              target="_blank"
              rel="noreferrer"
              title="Open the platform operator console"
            >
              <ExternalLink size={9} aria-hidden="true" /> Operator console
            </a>
          </div>
        </div>
      </aside>

      {/* ── Workspace ── */}
      <div className="workspace">

        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation" type="button">
              <Menu size={19} />
            </button>
            <div className="workspace-context">
              <span>{profile.scopeLabel}</span>
              <strong>{activeLabel}</strong>
            </div>
          </div>

          <div className="topbar-right">
            <Tag tone="violet"><FlaskConical size={12} aria-hidden="true" /> Synthetic</Tag>
            <Tag tone="mint"><DatabaseZap size={12} aria-hidden="true" /> CMS real</Tag>
            <button
              className="icon-button notification-button"
              aria-label="Open workflow notifications"
              type="button"
              onClick={() => openWorkflowDetail({
                id: "NOTIFY-REGION-03", kind: "Workflow inbox", title: "Workflow inbox",
                summary: "", status: "", owner: "", scope: "",
                primary: { label: "Open Swarm Control", target: "ecosystem" },
              })}
            >
              <Bell size={18} />
              <span />
            </button>

            {/* Role selector */}
            <div className="role-selector-wrap">
              <button
                className="profile-button"
                aria-label="Switch operating perspective and role"
                aria-expanded={roleDropdownOpen}
                type="button"
                onClick={() => setRoleDropdownOpen((v) => !v)}
              >
                <span>{profile.initials}</span>
                <div>
                  <strong>{profile.name}</strong>
                  <small>{profile.roleLabel}</small>
                </div>
                <ChevronDown
                  size={13}
                  className={`role-chevron${roleDropdownOpen ? " is-open" : ""}`}
                  aria-hidden="true"
                />
              </button>

              {roleDropdownOpen && (
                <div className="role-dropdown" role="listbox" aria-label="Select operating perspective">
                  <p className="role-dropdown-title">Switch operating perspective</p>
                  {roleGroups.map((group) => (
                    <div className="role-dropdown-group" key={group.label}>
                      <span>{group.label}</span>
                      {group.roles.map((id) => {
                        const p = roleProfiles[id];
                        return (
                          <button
                            className={`role-option${roleId === id ? " is-active" : ""}`}
                            key={id}
                            onClick={() => changeRole(id)}
                            role="option"
                            aria-selected={roleId === id}
                            type="button"
                          >
                            <span className="role-option-avatar">{p.initials}</span>
                            <div>
                              <strong>{p.name}</strong>
                              <small>{p.roleLabel} · {p.scopeLabel}</small>
                            </div>
                            {roleId === id && <CheckCircle2 size={13} aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  <div className="role-dropdown-note">
                    <ShieldCheck size={11} aria-hidden="true" />
                    Synthetic environment · No real patient data
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Mode banner — always visible, sticky under topbar */}
        <div className="mode-banner mode-banner-demo" role="status" aria-live="polite">
          <FlaskConical size={11} aria-hidden="true" />
          <span>Synthetic demo environment · Patient data is fictional · Public CMS sources are real · No EMR or clinical writes occur</span>
          <a
            className="mode-banner-link"
            href="http://localhost:8080/admin/ui/"
            target="_blank"
            rel="noreferrer"
          >
            Connect live data <ExternalLink size={9} aria-hidden="true" />
          </a>
        </div>

        {/* First-run setup banner — links to Admin UI, which owns platform setup */}
        {!setupDismissed && (
          <div className="setup-banner" role="alert">
            <CloudCog size={15} aria-hidden="true" />
            <div>
              <strong>Organization not connected.</strong>
              <span> Complete platform setup in the operator console to wire live Kafka, agents, CMS packs and activate the release.</span>
            </div>
            <a
              className="button button-primary setup-banner-cta"
              href="http://localhost:8080/admin/ui/"
              target="_blank"
              rel="noreferrer"
            >
              Open operator console <ExternalLink size={11} aria-hidden="true" />
            </a>
            <button
              className="icon-button setup-banner-close"
              aria-label="Dismiss setup notice"
              type="button"
              onClick={dismissSetup}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Main content */}
        <main className="content-shell">
          {activeNav === "ecosystem"    && <SwarmControl onNavigate={selectNav} onOpenDetail={openWorkflowDetail} roleId={roleId} onRoleChange={changeRole} />}
          {activeNav === "agents"       && <AgentOperations onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />}
          {activeNav === "command"      && <CommandCockpit selectedId={selectedId} onSelect={setSelectedId} onOpenDemo={launchDemo} onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />}
          {activeNav === "patient"      && <PatientIntelligence onOpenDetail={openWorkflowDetail} />}
          {activeNav === "assessments"  && <AssessmentIntelligence onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />}
          {activeNav === "intelligence" && <IntelligenceWorkspace onOpenDetail={openWorkflowDetail} />}
          {activeNav === "facility"     && <FacilityTwin onOpenDetail={openWorkflowDetail} />}
          {activeNav === "cms"          && <CmsControl onOpenDetail={openWorkflowDetail} />}
          {activeNav === "executive"    && <ExecutiveOutcomes onNavigate={selectNav} onOpenDetail={openWorkflowDetail} />}
          {activeNav === "assurance"    && <AssuranceCenter onOpenDetail={openWorkflowDetail} />}
          {activeNav === "admin"        && <AdminConsole onNavigate={selectNav} />}
          {activeNav === "configuration"&& <ConfigurationStudio onOpenDetail={openWorkflowDetail} onNavigate={selectNav} />}
        </main>
      </div>

      {/* Sidebar scrim (mobile) */}
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation overlay"
          type="button"
        />
      )}

      {/* ── Guided demo drawer ── */}
      <aside
        className={`demo-drawer${demoOpen ? " is-open" : ""}`}
        aria-label="Guided product demo"
        aria-hidden={!demoOpen}
      >
        <div className="demo-drawer-top">
          <div className="inline-cluster"><Sparkles size={15} aria-hidden="true" /><span>Guided enterprise journey</span></div>
          <button className="icon-button" onClick={() => setDemoOpen(false)} aria-label="Close guided demo" type="button">
            <X size={18} />
          </button>
        </div>
        <div className="demo-progress" aria-label={`Step ${demoStep + 1} of ${journeySteps.length}`}>
          {journeySteps.map((_, index) => (
            <span className={index <= demoStep ? "is-complete" : ""} key={index} />
          ))}
        </div>
        <div className="demo-copy">
          <p className="eyebrow">{currentStep.eyebrow}</p>
          <h2>{currentStep.title}</h2>
          <p>{currentStep.body}</p>
          <div className="demo-proof">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>Every screen preserves provenance, policy and human control.</span>
          </div>
        </div>
        <div className="demo-drawer-footer">
          <button
            className="button button-secondary"
            disabled={demoStep === 0}
            onClick={() => moveDemo(-1)}
            type="button"
          >
            <ChevronLeft size={16} aria-hidden="true" /> Back
          </button>
          {demoStep < journeySteps.length - 1 ? (
            <button className="button button-primary" onClick={() => moveDemo(1)} type="button">
              Next <ChevronRight size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              className="button button-primary"
              onClick={() => { setDemoOpen(false); selectNav(roleDefaultNav[roleId]); }}
              type="button"
            >
              <Activity size={16} aria-hidden="true" /> Back to my view
            </button>
          )}
        </div>
      </aside>

      {/* Workflow detail drawer */}
      <WorkflowDetailDrawer
        key={workflowDetail?.id ?? "closed"}
        detail={workflowDetail}
        onClose={() => setWorkflowDetail(null)}
        onNavigate={continueWorkflow}
      />
    </div>
  );
}
