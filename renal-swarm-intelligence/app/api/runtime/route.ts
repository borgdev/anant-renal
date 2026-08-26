import {
  acknowledgeRuntimeCommand,
  actorFromRequest,
  approveRuntimeAction,
  createRuntimeSubmissionPackage,
  ingestRuntimeEvent,
  replayRuntime,
  requestRuntimeReview,
  resetRuntime,
  reviewRuntimeEvidence,
  runtimeSnapshot,
  simulateRuntimePolicy,
  simulateRuntimeFacilityPlan,
  stepRuntime,
} from "../../../lib/runtime/engine";
import { requireAdapterOrOperator } from "../../../lib/runtime/authorization";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "RUNTIME_ERROR";
  if (message === "AUTHENTICATION_REQUIRED") return 401;
  if (message.includes("AUTHORIZATION") || message.includes("ADAPTER_AUTHENTICATION")) return 403;
  if (message.endsWith("_NOT_FOUND")) return 404;
  if (message.includes("no such table")) return 503;
  return 500;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected runtime error";
  if (message.includes("no such table")) return "The runtime ledger is not initialized. Apply the generated D1 migration.";
  return message;
}

export async function GET(request: Request) {
  try {
    const actor = actorFromRequest(request);
    requireAdapterOrOperator(actor, "simulate");
    return Response.json(await runtimeSnapshot());
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : "";
    const roleId = typeof payload.roleId === "string" ? payload.roleId : undefined;
    const actor = actorFromRequest(request, roleId);

    if (action === "replay") {
      requireAdapterOrOperator(actor, "replay");
      return Response.json({ result: await replayRuntime(actor) }, { status: 201 });
    }
    if (action === "reset") {
      requireAdapterOrOperator(actor, "replay");
      return Response.json({ result: await resetRuntime() });
    }
    if (action === "step") {
      requireAdapterOrOperator(actor, "replay");
      return Response.json({ result: await stepRuntime(actor) }, { status: 201 });
    }
    if (action === "ingest") {
      requireAdapterOrOperator(actor, "ingest");
      const result = await ingestRuntimeEvent(payload.event, actor);
      return Response.json({ result }, { status: result.accepted ? 202 : 400 });
    }
    if (action === "approve") {
      requireAdapterOrOperator(actor, "approve");
      if (typeof payload.actionId !== "string" || !payload.actionId) return Response.json({ error: "actionId is required" }, { status: 400 });
      return Response.json({ result: await approveRuntimeAction(payload.actionId, actor) });
    }
    if (action === "acknowledge") {
      requireAdapterOrOperator(actor, "acknowledge");
      if (typeof payload.commandId !== "string" || !payload.commandId) return Response.json({ error: "commandId is required" }, { status: 400 });
      return Response.json({ result: await acknowledgeRuntimeCommand(payload.commandId, actor) });
    }
    if (action === "simulate") {
      requireAdapterOrOperator(actor, "simulate");
      const threshold = typeof payload.thresholdBasisPoints === "number" ? payload.thresholdBasisPoints : 8200;
      return Response.json({ result: await simulateRuntimePolicy(threshold) });
    }
    if (action === "simulate-facility") {
      requireAdapterOrOperator(actor, "simulate");
      const facilityId = typeof payload.facilityId === "string" ? payload.facilityId : "facility-franklin";
      const station = typeof payload.station === "number" ? payload.station : 4;
      const proposedAt = typeof payload.proposedAt === "string" ? payload.proposedAt : "2026-08-21T19:30:00.000Z";
      return Response.json({ result: await simulateRuntimeFacilityPlan({ facilityId, station, proposedAt }) });
    }
    if (action === "review-evidence") {
      requireAdapterOrOperator(actor, "knowledge");
      if (typeof payload.evidenceId !== "string" || !payload.evidenceId) return Response.json({ error: "evidenceId is required" }, { status: 400 });
      if (payload.decision !== "confirmed" && payload.decision !== "rejected") return Response.json({ error: "decision must be confirmed or rejected" }, { status: 400 });
      return Response.json({ result: await reviewRuntimeEvidence(payload.evidenceId, payload.decision, actor) }, { status: 201 });
    }
    if (action === "request-review") {
      requireAdapterOrOperator(actor, "knowledge");
      if (typeof payload.entityType !== "string" || typeof payload.entityId !== "string" || typeof payload.targetRole !== "string" || typeof payload.message !== "string") return Response.json({ error: "entityType, entityId, targetRole and message are required" }, { status: 400 });
      return Response.json({ result: await requestRuntimeReview({ entityType: payload.entityType, entityId: payload.entityId, targetRole: payload.targetRole, message: payload.message }, actor) }, { status: 201 });
    }
    if (action === "submission-package") {
      requireAdapterOrOperator(actor, "approve");
      return Response.json({ result: await createRuntimeSubmissionPackage(actor) }, { status: 201 });
    }
    return Response.json({ error: "Unsupported runtime action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: statusFor(error) });
  }
}
