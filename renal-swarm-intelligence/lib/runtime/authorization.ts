/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

import { env } from "cloudflare:workers";
import operatingModel from "../../config/enterprise-operating-model.json";
import type { RuntimeRole } from "./types";

const roles = new Set<RuntimeRole>(["evp", "dvp", "rod", "fa", "medical", "quality", "finance", "biomed"]);

export type RuntimeActor = {
  email: string;
  role: RuntimeRole;
  scopeLevel: string;
  scopeId: string;
  authentication: "workspace-header" | "adapter-token" | "owner-demo";
  syntheticDelegation: boolean;
};

export function resolveRuntimeActor(request: Request, requestedRole?: string): RuntimeActor {
  const email = request.headers.get("oai-authenticated-user-email");
  const authorization = request.headers.get("authorization");
  const runtimeEnvironment = env as unknown as Record<string, unknown>;
  const adapterToken = runtimeEnvironment.RUNTIME_ADAPTER_TOKEN;
  const adapterAuthorized = typeof adapterToken === "string" && adapterToken.length >= 24 && authorization === `Bearer ${adapterToken}`;
  const ownerDemo = runtimeEnvironment.RUNTIME_DEMO_MODE === "enabled" && request.headers.get("x-runtime-synthetic") === "owner-demo";
  if (!email && !adapterAuthorized && !ownerDemo) throw new Error("AUTHENTICATION_REQUIRED");

  if (requestedRole && !operatingModel.synthetic && !adapterAuthorized) throw new Error("AUTHORIZATION_DENIED: UI role delegation is disabled outside the synthetic operating model");
  const role = requestedRole && roles.has(requestedRole as RuntimeRole) ? requestedRole as RuntimeRole : adapterAuthorized ? "evp" : "dvp";
  const roleConfig = operatingModel.roles.find((item) => item.id === role) ?? operatingModel.roles[1];
  const scope = operatingModel.scopePath.find((item) => item.level === roleConfig.scopeLevel) ?? operatingModel.scopePath[0];
  return {
    email: email ?? (adapterAuthorized ? "kafka-adapter@runtime" : "owner-demo@synthetic.local"),
    role,
    scopeLevel: roleConfig.scopeLevel,
    scopeId: scope.id,
    authentication: email ? "workspace-header" : adapterAuthorized ? "adapter-token" : "owner-demo",
    syntheticDelegation: Boolean(operatingModel.synthetic && requestedRole && role === requestedRole),
  };
}

export function requireAdapterOrOperator(actor: RuntimeActor, capability: "ingest" | "replay" | "approve" | "acknowledge" | "simulate" | "knowledge") {
  if (actor.authentication === "adapter-token" && capability !== "ingest" && capability !== "acknowledge") throw new Error("AUTHORIZATION_DENIED: adapter identity cannot exercise operator capability");
  if (capability === "ingest" && actor.authentication !== "adapter-token" && actor.authentication !== "owner-demo" && !["evp", "dvp"].includes(actor.role)) throw new Error("AUTHORIZATION_DENIED");
  if (capability === "approve" && !["evp", "dvp", "rod", "fa", "medical", "quality", "finance", "biomed"].includes(actor.role)) throw new Error("AUTHORIZATION_DENIED");
  if (capability === "acknowledge" && !["evp", "dvp", "rod", "fa"].includes(actor.role) && actor.authentication !== "adapter-token") throw new Error("AUTHORIZATION_DENIED");
}

export function authorizedForScope(actor: RuntimeActor, actionScopeId: string): { allowed: boolean; reason: string } {
  const scopePath = operatingModel.scopePath;
  const actorIndex = scopePath.findIndex((scope) => scope.id === actor.scopeId);
  const actionIndex = scopePath.findIndex((scope) => scope.id === actionScopeId);
  if (actorIndex === -1 || actionIndex === -1) {
    return { allowed: actor.scopeId === actionScopeId, reason: actor.scopeId === actionScopeId ? "Exact configured scope match" : `Scope ${actionScopeId} is outside the configured operating hierarchy` };
  }
  const allowed = actorIndex <= actionIndex;
  return { allowed, reason: allowed ? `${actor.scopeLevel} authority contains ${scopePath[actionIndex].level} scope` : `${actor.scopeLevel} authority does not contain ${scopePath[actionIndex].level} scope` };
}

export function requireBridgeActor(actor: RuntimeActor) {
  if (actor.authentication !== "adapter-token") throw new Error("ADAPTER_AUTHENTICATION_REQUIRED");
}
