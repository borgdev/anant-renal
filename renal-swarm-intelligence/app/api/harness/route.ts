import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { auditEvents, configurationReleases, evaluationRuns } from "../../../db/schema";
import { actorFromRequest } from "../../../lib/runtime/engine";
import { requireAdapterOrOperator } from "../../../lib/runtime/authorization";
import { runRuntimeRedTeam } from "../../../lib/runtime/evals";

const ACTIVE_CONFIGURATION = "renal-harness-2026.08.5";

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected harness error";
  if (message.includes("no such table")) {
    return "The assurance ledger is not initialized. Apply the generated D1 migration before enabling runtime writes.";
  }
  return message;
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "AUTHENTICATION_REQUIRED") return 401;
  if (message.includes("AUTHORIZATION")) return 403;
  if (message.endsWith("_NOT_FOUND")) return 404;
  if (message.includes("no such table")) return 503;
  return 500;
}

export async function GET(request: Request) {
  try {
    const runtimeActor = actorFromRequest(request);
    requireAdapterOrOperator(runtimeActor, "simulate");
    const db = getDb();
    const [actions, evaluations, releases] = await Promise.all([
      db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(20),
      db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt), desc(evaluationRuns.id)).limit(20),
      db.select().from(configurationReleases).orderBy(desc(configurationReleases.createdAt), desc(configurationReleases.id)).limit(10),
    ]);
    return Response.json({ configuration: ACTIVE_CONFIGURATION, actions, evaluations, releases });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: errorStatus(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const db = getDb();
    const runtimeActor = actorFromRequest(request, typeof payload.roleId === "string" ? payload.roleId : undefined);
    requireAdapterOrOperator(runtimeActor, "simulate");

    if (kind === "human-action") {
      const entityId = typeof payload.entityId === "string" ? payload.entityId.trim() : "";
      const action = typeof payload.action === "string" ? payload.action.trim() : "";
      const requestedEntityType = typeof payload.entityType === "string" ? payload.entityType.trim() : "outcome-episode";
      const entityType = ["outcome-episode", "next-best-action", "configuration-change"].includes(requestedEntityType) ? requestedEntityType : "outcome-episode";
      if (!entityId || !action) return Response.json({ error: "entityId and action are required" }, { status: 400 });
      const eventId = typeof payload.idempotencyKey === "string" && payload.idempotencyKey ? payload.idempotencyKey : crypto.randomUUID();
      const [inserted] = await db.insert(auditEvents).values({
        eventId,
        category: "human-action",
        actor: runtimeActor.email,
        action,
        entityType,
        entityId,
        decision: "requested",
        evidenceHash: typeof payload.evidenceHash === "string" ? payload.evidenceHash : "demo-evidence-hash",
        detail: "Synthetic demonstration action. No EMR, clinical or external submission write was performed.",
        configurationVersion: ACTIVE_CONFIGURATION,
      }).onConflictDoNothing({ target: auditEvents.eventId }).returning();
      if (inserted) return Response.json({ event: inserted, idempotentReplay: false }, { status: 201 });
      const [existing] = await db.select().from(auditEvents).where(eq(auditEvents.eventId, eventId)).limit(1);
      return Response.json({ event: existing, idempotentReplay: true }, { status: 200 });
    }

    if (kind === "red-team-replay") {
      const scenarioId = typeof payload.scenarioId === "string" ? payload.scenarioId : "";
      const result = await runRuntimeRedTeam(scenarioId);
      const [evaluation] = await db.insert(evaluationRuns).values({
        runId: typeof payload.runId === "string" && payload.runId ? payload.runId : crypto.randomUUID(),
        suite: "red",
        targetType: "runtime-control",
        targetVersion: ACTIVE_CONFIGURATION,
        scenarioId,
        status: result.passed ? "passed" : "failed",
        scoreBasisPoints: Math.round((result.checks.filter((check) => check.passed).length / result.checks.length) * 10000),
        evidenceHash: result.evidenceHash,
        configurationVersion: ACTIVE_CONFIGURATION,
      }).returning();
      return Response.json({ result, evaluation }, { status: result.passed ? 201 : 422 });
    }

    if (kind === "evaluation") {
      const suite = payload.suite === "green" || payload.suite === "red" || payload.suite === "contract" || payload.suite === "gold-set" ? payload.suite : null;
      if (!suite) return Response.json({ error: "A supported evaluation suite is required" }, { status: 400 });
      const [evaluation] = await db.insert(evaluationRuns).values({
        runId: typeof payload.runId === "string" && payload.runId ? payload.runId : crypto.randomUUID(),
        suite,
        targetType: typeof payload.targetType === "string" ? payload.targetType : "harness-release",
        targetVersion: typeof payload.targetVersion === "string" ? payload.targetVersion : ACTIVE_CONFIGURATION,
        scenarioId: typeof payload.scenarioId === "string" ? payload.scenarioId : null,
        status: "passed",
        scoreBasisPoints: typeof payload.scoreBasisPoints === "number" ? Math.max(0, Math.min(10000, Math.round(payload.scoreBasisPoints))) : 10000,
        evidenceHash: typeof payload.evidenceHash === "string" ? payload.evidenceHash : "demo-eval-evidence-hash",
        configurationVersion: ACTIVE_CONFIGURATION,
      }).returning();
      return Response.json({ evaluation }, { status: 201 });
    }

    return Response.json({ error: "Unsupported harness write kind" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: errorStatus(error) });
  }
}
