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
