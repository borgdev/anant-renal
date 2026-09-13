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

import type { NavigationId } from "../../../../lib/types";
import { requireAdapterOrOperator } from "../../../../lib/runtime/authorization";
import { actorFromRequest } from "../../../../lib/runtime/engine";
import { resolveWorkItemContext } from "../../../../lib/server/work-item-context";
import {
  errorResponse,
  noStoreJson,
  requireSafeIdentifier,
} from "../../../../lib/server/request-security";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const entityId = requireSafeIdentifier(url.searchParams.get("entityId"), "ENTITY_ID");
    const entityType = requireSafeIdentifier(url.searchParams.get("entityType"), "ENTITY_TYPE", 100);
    const roleId = url.searchParams.get("roleId") ?? undefined;
    const actor = actorFromRequest(request, roleId);
    requireAdapterOrOperator(actor, "simulate");
    const target = url.searchParams.get("target") as NavigationId | null;
    const detail = await resolveWorkItemContext({
      entityId,
      entityType,
      target: target ?? undefined,
      requestedRole: roleId,
    }, actor);
    return noStoreJson({ detail });
  } catch (error) {
    return errorResponse(error);
  }
}
