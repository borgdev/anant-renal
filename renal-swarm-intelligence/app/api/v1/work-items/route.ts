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
