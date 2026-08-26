import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { auditEvents, eventOutbox, incidents } from "../../../../db/schema";
import { requireBridgeActor } from "../../../../lib/runtime/authorization";
import { actorFromRequest, RUNTIME_CONFIGURATION, RUNTIME_TENANT } from "../../../../lib/runtime/engine";
import { hashJson } from "../../../../lib/runtime/crypto";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "OUTBOX_ERROR";
  if (message === "AUTHENTICATION_REQUIRED") return 401;
  if (message.includes("ADAPTER_AUTHENTICATION")) return 403;
  if (message.includes("no such table")) return 503;
  return 500;
}

export async function GET(request: Request) {
  try {
    const actor = actorFromRequest(request);
    requireBridgeActor(actor);
    const db = getDb();
    const bridgeId = request.headers.get("x-bridge-id")?.trim();
    if (!bridgeId) return Response.json({ error: "x-bridge-id is required" }, { status: 400 });
    const now = new Date().toISOString();
    const claimable = or(eq(eventOutbox.status, "pending"), and(eq(eventOutbox.status, "failed"), lt(eventOutbox.attempts, 8), lte(eventOutbox.nextAttemptAt, now)), and(eq(eventOutbox.status, "leased"), lte(eventOutbox.lockedUntil, now)));
    const candidates = await db.select().from(eventOutbox).where(and(eq(eventOutbox.tenantId, RUNTIME_TENANT), claimable)).orderBy(asc(eventOutbox.createdAt)).limit(50);
    const lockedUntil = new Date(Date.now() + 60_000).toISOString();
    const rows = [];
    for (const candidate of candidates) {
      const [claimed] = await db.update(eventOutbox).set({ status: "leased", lockedBy: bridgeId, lockedUntil }).where(and(eq(eventOutbox.outboxId, candidate.outboxId), claimable)).returning();
      if (claimed) rows.push(claimed);
    }
    return Response.json({ lease: { bridgeId, lockedUntil }, messages: rows.map((row) => ({ ...row, envelope: JSON.parse(row.envelopeJson) })) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected outbox error" }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const actor = actorFromRequest(request);
    requireBridgeActor(actor);
    const bridgeId = request.headers.get("x-bridge-id")?.trim();
    if (!bridgeId) return Response.json({ error: "x-bridge-id is required" }, { status: 400 });
    const payload = (await request.json()) as Record<string, unknown>;
    const outboxId = typeof payload.outboxId === "string" ? payload.outboxId : "";
    const deliveryStatus = payload.status === "published" || payload.status === "failed" ? payload.status : null;
    if (!outboxId || !deliveryStatus) return Response.json({ error: "outboxId and published|failed status are required" }, { status: 400 });
    const db = getDb();
    const [existing] = await db.select().from(eventOutbox).where(and(eq(eventOutbox.tenantId, RUNTIME_TENANT), eq(eventOutbox.outboxId, outboxId))).limit(1);
    if (!existing) return Response.json({ error: "OUTBOX_MESSAGE_NOT_FOUND" }, { status: 404 });
    if (existing.status === "published" && deliveryStatus === "published") return Response.json({ outboxId, status: "published", idempotentReplay: true });
    if (existing.status !== "leased" || existing.lockedBy !== bridgeId) return Response.json({ error: "OUTBOX_LEASE_NOT_OWNED" }, { status: 409 });
    const now = new Date().toISOString();
    const attempts = existing.attempts + 1;
    const terminalFailure = deliveryStatus === "failed" && attempts >= 8;
    const retryDelay = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(attempts, 6)));
    await db.update(eventOutbox).set({ status: deliveryStatus, attempts: sql`${eventOutbox.attempts} + 1`, publishedAt: deliveryStatus === "published" ? now : null, nextAttemptAt: deliveryStatus === "failed" && !terminalFailure ? new Date(Date.now() + retryDelay).toISOString() : null, lockedBy: null, lockedUntil: null }).where(eq(eventOutbox.outboxId, outboxId));
    const evidenceHash = await hashJson({ outboxId, deliveryStatus, metadata: payload.metadata ?? null });
    await db.insert(auditEvents).values({ eventId: `AUD-${crypto.randomUUID()}`, category: "data-quality", actor: actor.email, action: "record-kafka-outbox-delivery", entityType: "event-outbox", entityId: outboxId, decision: deliveryStatus === "published" ? "completed" : "blocked", evidenceHash, detail: JSON.stringify({ topic: existing.topic, deliveryStatus, metadata: payload.metadata ?? null }), configurationVersion: RUNTIME_CONFIGURATION });
    if (terminalFailure) await db.insert(incidents).values({ incidentId: `INC-${outboxId}`, tenantId: RUNTIME_TENANT, severity: 2, status: "open", source: "kafka-outbox", summary: `${existing.topic} exhausted eight delivery attempts`, ownerRole: "dvp", openedAt: now, resolvedAt: null }).onConflictDoNothing({ target: incidents.incidentId });
    return Response.json({ outboxId, status: deliveryStatus, attempts, terminalFailure, nextAttemptAt: deliveryStatus === "failed" && !terminalFailure ? new Date(Date.now() + retryDelay).toISOString() : null, recordedAt: now });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected outbox error" }, { status: statusFor(error) });
  }
}
