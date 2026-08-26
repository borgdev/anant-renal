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
