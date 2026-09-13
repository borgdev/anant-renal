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

import {
  activateRelease,
  adminConsoleSnapshot,
  saveAgent,
  saveKafka,
  saveOrganization,
  savePolicy,
  testKafka,
  validateRelease,
} from "../../../../lib/server/onboarding";
import {
  ControlPlaneError,
  errorResponse,
  noStoreJson,
  requireTrustedJsonMutation,
} from "../../../../lib/server/request-security";
import type { RuntimeActor } from "../../../../lib/runtime/authorization";
import { actorFromRequest } from "../../../../lib/runtime/engine";

function requirePlatformAdmin(actor: RuntimeActor) {
  if (actor.authentication === "adapter-token" || !["evp", "dvp"].includes(actor.role)) {
    throw new ControlPlaneError("AUTHORIZATION_DENIED", 403);
  }
}

export async function GET(request: Request) {
  try {
    const roleId = new URL(request.url).searchParams.get("roleId") ?? undefined;
    const actor = actorFromRequest(request, roleId);
    requirePlatformAdmin(actor);
    return noStoreJson(await adminConsoleSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedJsonMutation(request);
    const payload = await request.json() as Record<string, unknown>;
    const actor = actorFromRequest(request, typeof payload.roleId === "string" ? payload.roleId : undefined);
    requirePlatformAdmin(actor);
    switch (payload.action) {
      case "save-organization":
        await saveOrganization(actor, payload);
        break;
      case "save-kafka":
        await saveKafka(actor, payload);
        break;
      case "test-kafka":
        await testKafka(actor);
        break;
      case "save-agent":
        await saveAgent(actor, payload.agent);
        break;
      case "save-policy":
        await savePolicy(actor, payload.policy);
        break;
      case "validate-release":
        await validateRelease(actor, payload.releaseId);
        break;
      case "activate-release":
        await activateRelease(actor, payload.releaseId);
        break;
      default:
        throw new ControlPlaneError("UNSUPPORTED_ADMIN_ACTION", 400);
    }
    return noStoreJson(await adminConsoleSnapshot(), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
