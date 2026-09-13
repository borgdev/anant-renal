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

import { agentOperationsSnapshot } from "../../../../lib/server/agent-operations";
import {
  errorResponse,
  noStoreJson,
  requireTrustedJsonMutation,
} from "../../../../lib/server/request-security";
import { requireAdapterOrOperator } from "../../../../lib/runtime/authorization";
import {
  actorFromRequest,
  replayRuntime,
  stepRuntime,
} from "../../../../lib/runtime/engine";

export async function GET(request: Request) {
  try {
    const roleId = new URL(request.url).searchParams.get("roleId") ?? undefined;
    const actor = actorFromRequest(request, roleId);
    requireAdapterOrOperator(actor, "simulate");
    return noStoreJson(await agentOperationsSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedJsonMutation(request);
    const payload = await request.json() as Record<string, unknown>;
    const roleId = typeof payload.roleId === "string" ? payload.roleId : undefined;
    const actor = actorFromRequest(request, roleId);
    requireAdapterOrOperator(actor, "replay");
    if (payload.action === "replay") await replayRuntime(actor);
    else if (payload.action === "step") await stepRuntime(actor);
    else return noStoreJson({ error: "UNSUPPORTED_AGENT_OPERATION" }, { status: 400 });
    return noStoreJson(await agentOperationsSnapshot(), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
