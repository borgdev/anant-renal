// My Work — the universal role-scoped decision queue (port plan Phase B/C).
//
// The queue is SERVER-assembled: GET /api/work derives items from real state
// (outcome episodes awaiting decision, pending evidence reviews, releases
// awaiting approval/activation, bridge DLQ incidents) and filters them by the
// session role's consoles + capabilities. The browser only renders what the
// server says the current session may see and act on — it never decides
// authorization.

export type PlatformWorkKind = "episode" | "review" | "release" | "dlq";
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
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `work request failed: ${path}`);
  return payload;
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
  opts: { approver?: string; reason?: string; idempotencyKey?: string } = {},
): Promise<{ accepted?: boolean; state?: string; duplicate?: boolean; error?: string }> {
  return fetchJson<{ accepted?: boolean; state?: string; duplicate?: boolean; error?: string }>(`/api/work/${encodeURIComponent(id)}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      ...(opts.approver ? { approver: opts.approver } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    }),
  });
}

/** Server-issued session context (role, consoles, pack/lens, capabilities). */
export async function fetchContext(): Promise<PlatformContext> {
  return fetchJson<PlatformContext>("/api/context");
}
