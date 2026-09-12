// My Work — the universal role-scoped decision queue (port plan Phase B/C).
//
// The queue is SERVER-assembled: GET /api/work derives items from real state
// (outcome episodes awaiting decision, pending evidence reviews, releases
// awaiting approval/activation, bridge DLQ incidents) and filters them by the
// session role's consoles + capabilities. The browser only renders what the
// server says the current session may see and act on — it never decides
// authorization.
import { responseOrThrow } from "./session";
export type PlatformWorkKind = "episode" | "review" | "release" | "dlq" | "cohort" | "action";
export type PlatformUrgency = "high" | "medium" | "low";
export type ConsoleId = "exec" | "ops";

export interface PlatformWorkItem {
  id: string;
  kind: PlatformWorkKind;
  title: string;
  summary: string;
  state: string;
  urgency: PlatformUrgency;
  scope: string;
  owner: string;
  sla: string;
  console: ConsoleId;
  capability: string;
  actions: string[];
  at: string;
  /** DST-Q — Dempster–Shafer belief readout (present on evidence-driven episode items). */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
  evidenceStatus?: "corroborated" | "weak" | "contested";
  /** DST-Q — belief-aware decision priority in [0,1]; orders items within an urgency tier. */
  dstPriority?: number;
}

export interface PlatformWorkDetail {
  id: string;
  kind: string;
  title: string;
  state: string;
  scope: string;
  owner: string;
  why: string;
  overview: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  contributions: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  activity: Array<Record<string, unknown>>;
  decision: { allowed: string[]; reasonRequiredFor: string[] };
  execution: Record<string, unknown> | null;
  outcome: Record<string, unknown>;
  assurance: Record<string, unknown>;
}

export interface PlatformContext {
  authenticated: boolean;
  user: { username: string; displayName: string; role: string; clearance: string; purposeOfUse: string[]; scopeIds: string[] } | null;
  role: string | null;
  consoles: ConsoleId[];
  pack: { id: string; lens: string };
  navigation: Array<{ id: string; label: string; console: ConsoleId; href: string }>;
  capabilities: string[];
  aggregates: Record<string, number>;
  configuration: { activeVersion: string | null };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

/** Role-scoped My Work queue (server-filtered by session role). */
export async function fetchMyWork(): Promise<PlatformWorkItem[]> {
  const res = await fetchJson<{ items: PlatformWorkItem[]; total: number }>("/api/work");
  return res.items ?? [];
}

/** Universal detail for a work item (episode / review / release / dlq). */
export async function fetchWorkDetail(id: string): Promise<PlatformWorkDetail> {
  const res = await fetchJson<{ detail: PlatformWorkDetail }>(`/api/work/${encodeURIComponent(id)}`);
  return res.detail;
}

/** Execute a typed, idempotent action on a work item. */
export async function performWorkAction(
  id: string,
  action: string,
  opts: { approver?: string; reason?: string; idempotencyKey?: string; deferUntil?: string; handedTo?: string; handedToConsole?: string } = {},
): Promise<{
  accepted?: boolean;
  state?: string;
  duplicate?: boolean;
  error?: string;
  /** Where the approved order landed — the difference between a signature and an act. */
  dispatch?: { effectId: string; effectKind: string; orderUrn?: string; replayed: boolean };
  /** Why it did not land. An approval that changed nothing must say so. */
  dispatchError?: { code: string; message: string };
}> {
  return fetchJson(`/api/work/${encodeURIComponent(id)}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      ...(opts.approver ? { approver: opts.approver } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.deferUntil ? { deferUntil: opts.deferUntil } : {}),
      ...(opts.handedTo ? { handedTo: opts.handedTo } : {}),
      ...(opts.handedToConsole ? { handedToConsole: opts.handedToConsole } : {}),
    }),
  });
}

/** Server-issued session context (role, consoles, pack/lens, capabilities). */
export async function fetchContext(): Promise<PlatformContext> {
  return fetchJson<PlatformContext>("/api/context");
}

/* ---------- Journey N — executive outcomes + delegation (Outcome Workspace) ---------- */

export interface ExecutiveOutcomes {
  outcomes: { verifiedEpisodes: number; byKind: Record<string, number>; realizedValue: number; met: number };
  episodes: Array<{ kind: string; state: string }>;
}
export interface Delegation {
  id: string; title: string; reason: string; sourceId: string; owner: string; sla: string;
  status: "open" | "in-progress" | "done"; delegatedBy: string;
  outcome?: { verified: boolean; value?: number; note?: string }; doneAt?: string;
}
export interface SubmissionPackageView {
  id: string; measureId: string; period: { start: string; end: string };
  status: "draft" | "validated" | "approved" | "submitted" | "reconciled" | "rejected";
  resultsIncluded: number; manifestHash: string; approvals?: Array<{ approver: string; class: string }>;
  evidenceWindow?: { start: string; end: string }; receipt?: { status: string; referenceId: string };
  transmissionBlocked?: { reason: string };
}

/** Verified-value rollup (Journey N) — value, not activity counts. */
export async function fetchExecutiveOutcomes(): Promise<ExecutiveOutcomes> {
  return fetchJson<ExecutiveOutcomes>("/admin/executive/outcomes");
}
/** Durable executive delegations. */
export async function fetchDelegations(): Promise<Delegation[]> {
  const res = await fetchJson<{ delegations: Delegation[] }>("/admin/executive/delegations");
  return res.delegations ?? [];
}
/** Sponsor/delegate analysis to an owner with an SLA. */
export async function delegateWork(input: { title: string; owner: string; sla?: string; reason?: string; sourceId?: string }): Promise<Delegation> {
  const res = await fetchJson<{ delegation: Delegation }>("/admin/executive/delegate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, delegatedBy: "executive" }),
  });
  return res.delegation;
}
/** Advance/complete a delegation with a verified outcome. */
export async function completeDelegation(id: string, outcome: { verified: boolean; value?: number; note?: string }): Promise<Delegation> {
  const res = await fetchJson<{ delegation: Delegation }>(`/admin/executive/delegations/${encodeURIComponent(id)}/status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done", ...outcome }),
  });
  return res.delegation;
}

/* ---------- Journey K — CMS/EQRS submission lifecycle (Quality/CMS surface) ---------- */

/** Live submission packages (dual Class-D approval → reference-mode gate → receipt). */
export async function fetchSubmissions(): Promise<SubmissionPackageView[]> {
  const res = await fetchJson<{ packages: SubmissionPackageView[] }>("/admin/platform/submissions");
  return res.packages ?? [];
}
/** Open a new EQRS submission package for the payment year. */
export async function createSubmission(input: { measureId: string; period: { start: string; end: string }; resultsIncluded?: number }): Promise<SubmissionPackageView> {
  const res = await fetchJson<{ package: SubmissionPackageView }>("/admin/platform/submissions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, createdBy: "executive" }),
  });
  return res.package;
}
/** Record a Class-D approval (call twice with distinct approvers). */
export async function approveSubmission(id: string, approver: string): Promise<{ package: SubmissionPackageView; approvals: number }> {
  return fetchJson<{ package: SubmissionPackageView; approvals: number }>(`/admin/platform/submissions/${encodeURIComponent(id)}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ approver }),
  });
}
