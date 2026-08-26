"use client";

import type {
  AdminConsoleSnapshot,
  AgentConfiguration,
  AgentOperationsSnapshot,
  WorkItemContextResponse,
  WorkItemReference,
} from "./contracts";

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Control-plane request failed");
  return payload;
}

export async function fetchWorkItemContext(reference: WorkItemReference) {
  const params = new URLSearchParams({
    entityId: reference.entityId,
    entityType: reference.entityType,
  });
  if (reference.target) params.set("target", reference.target);
  if (reference.requestedRole) params.set("roleId", reference.requestedRole);
  const response = await fetch("/api/v1/work-items?" + params.toString(), {
    cache: "no-store",
    credentials: "same-origin",
  });
  return responseJson<WorkItemContextResponse>(response);
}

export async function fetchAgentOperations(roleId = "dvp") {
  const params = new URLSearchParams({ roleId });
  const response = await fetch("/api/v1/agents?" + params.toString(), {
    cache: "no-store",
    credentials: "same-origin",
  });
  return responseJson<AgentOperationsSnapshot>(response);
}

export async function mutateAgentOperations(
  action: "replay" | "step",
  roleId = "dvp",
) {
  const response = await fetch("/api/v1/agents", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, roleId }),
  });
  return responseJson<AgentOperationsSnapshot>(response);
}

export async function fetchAdminConsole(roleId = "dvp") {
  const params = new URLSearchParams({ roleId });
  const response = await fetch("/api/v1/admin?" + params.toString(), {
    cache: "no-store",
    credentials: "same-origin",
  });
  return responseJson<AdminConsoleSnapshot>(response);
}

export async function mutateAdminConsole(
  action:
    | "save-organization"
    | "save-kafka"
    | "test-kafka"
    | "save-agent"
    | "save-policy"
    | "validate-release"
    | "activate-release",
  input: Record<string, unknown> & { agent?: AgentConfiguration } = {},
  roleId = "dvp",
) {
  const response = await fetch("/api/v1/admin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, roleId, ...input }),
  });
  return responseJson<AdminConsoleSnapshot>(response);
}
