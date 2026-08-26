import { and, desc, eq, isNull, like } from "drizzle-orm";
import measurePacks from "../../config/measure-packs.json";
import publicSources from "../../config/public-sources.json";
import { getDb } from "../../db";
import {
  acknowledgements,
  agentExecutions,
  agentProposals,
  auditEvents,
  authoritySnapshots,
  commands,
  driftSnapshots,
  eventEnvelopes,
  eventOutbox,
  evidenceObjects,
  evidenceReviews,
  incidents,
  measureResults,
  modelRegistry,
  nextBestActions,
  outcomeEpisodes,
  policyEvaluations,
  roleAssignments,
  submissionPackages,
  swarmInsights,
  temporalStates,
  topologyEdges,
  topologyNodes,
  traceSpans,
} from "../../db/schema";
import { graphEdges, graphNodes } from "../demo-data";
import { authorizedForScope, resolveRuntimeActor, type RuntimeActor } from "./authorization";
import { hashJson } from "./crypto";
import { runtimeReplayEvents } from "./fixtures";
import { authorizedForAction, derivePortfolio, evaluateEligibleCells, simulateFacilityPlan, simulatePolicyReplay, validateCanonicalEvent } from "./kernel";
import {
  activeConfigurationVersion,
  BASE_CONFIGURATION_VERSION,
  effectiveAgentManifests,
  effectiveRuntimePolicy,
} from "../server/configuration-repository";
import type { CanonicalEvent, ReplayEventSeed, RuntimeRole } from "./types";

export const RUNTIME_TENANT = "demo-renal-enterprise";
export const RUNTIME_CONFIGURATION = BASE_CONFIGURATION_VERSION;

type Db = ReturnType<typeof getDb>;

export async function materializeReplayEvent(seed: ReplayEventSeed): Promise<CanonicalEvent> {
  const contentHash = seed.integrity?.contentHash ?? await hashJson(seed.payload);
  return { ...seed, integrity: { algorithm: "sha256", contentHash } } as CanonicalEvent;
}

export async function resetRuntime() {
  const db = getDb();
  const tenantTables = [acknowledgements, agentProposals, agentExecutions, commands, eventOutbox, nextBestActions, policyEvaluations, swarmInsights, measureResults, submissionPackages, traceSpans, topologyEdges, topologyNodes, temporalStates, evidenceReviews, evidenceObjects, outcomeEpisodes, eventEnvelopes, driftSnapshots, incidents, roleAssignments] as const;
  for (const table of tenantTables) await db.delete(table).where(eq(table.tenantId, RUNTIME_TENANT));
  return { reset: true };
}

export async function replayRuntime(actor: RuntimeActor) {
  await resetRuntime();
  const events: CanonicalEvent[] = [];
  for (const seed of runtimeReplayEvents) {
    const event = await materializeReplayEvent(seed);
    await persistEvent(event, actor, false);
    events.push(event);
  }
  await persistPortfolio(events, actor);
  await seedRuntimeAssurance();
  return runtimeSnapshot();
}

export async function stepRuntime(actor: RuntimeActor) {
  const db = getDb();
  const accepted = await db.select({ eventId: eventEnvelopes.eventId }).from(eventEnvelopes).where(eq(eventEnvelopes.tenantId, RUNTIME_TENANT));
  const acceptedIds = new Set(accepted.map((item) => item.eventId));
  const next = runtimeReplayEvents.find((event) => !acceptedIds.has(event.eventId));
  if (!next) return { complete: true, snapshot: await runtimeSnapshot() };
  const event = await materializeReplayEvent(next);
  await persistEvent(event, actor, true);
  return { complete: false, acceptedEventId: event.eventId, snapshot: await runtimeSnapshot() };
}

export async function ingestRuntimeEvent(value: unknown, actor: RuntimeActor) {
  const validation = validateCanonicalEvent(value);
  if (!validation.ok) return { accepted: false, errors: validation.errors };
  if (validation.event.tenantId !== RUNTIME_TENANT) return { accepted: false, errors: ["tenant scope is not authorized for this reference runtime"] };
  const calculatedHash = await hashJson(validation.event.payload);
  if (calculatedHash !== validation.event.integrity.contentHash) return { accepted: false, errors: ["payload integrity hash mismatch"] };
  const result = await persistEvent(validation.event, actor, true);
  return { accepted: true, ...result };
}

async function persistEvent(event: CanonicalEvent, actor: RuntimeActor, rebuildPortfolio: boolean) {
  const db = getDb();
  const existing = await db.select().from(eventEnvelopes).where(eq(eventEnvelopes.eventId, event.eventId)).limit(1);
  if (existing[0]) return { idempotentReplay: true, eventId: event.eventId };
  const traceId = event.correlationId ? await hashJson({ tenant: event.tenantId, correlation: event.correlationId }).then((hash) => hash.slice(0, 32)) : crypto.randomUUID().replaceAll("-", "");
  const payloadJson = JSON.stringify(event.payload);
  await db.insert(eventEnvelopes).values({
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    tenantId: event.tenantId,
    subjectType: event.subject.type,
    subjectId: event.subject.id,
    purpose: event.purpose,
    validTime: event.validTime,
    recordedTime: event.recordedTime,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    sourceSystem: event.source.system,
    sourceResource: event.source.resource,
    contentHash: event.integrity.contentHash,
    payloadJson,
    status: "accepted",
    partitionKey: `${event.tenantId}:${event.subject.id}`,
    traceId,
  });
  await appendTrace(db, traceId, null, "event.accepted", "event-gateway", "ok", 1, { eventType: event.eventType, actor: actor.email, integrity: "verified" });
  await db.insert(evidenceObjects).values({
    evidenceId: `EVID-${event.eventId}`,
    tenantId: event.tenantId,
    subjectType: event.subject.type,
    subjectId: event.subject.id,
    evidenceType: event.eventType,
    sourceEventId: event.eventId,
    exactText: typeof event.payload.answer === "string" ? event.payload.answer : null,
    structuredJson: payloadJson,
    confidenceBasisPoints: typeof event.payload.humanConfirmed === "boolean" && event.payload.humanConfirmed ? 10000 : 9900,
    validFrom: event.validTime,
    validTo: null,
    recordedAt: event.recordedTime,
    purpose: event.purpose,
    contentHash: event.integrity.contentHash,
  });
  const stateType = event.eventType.replace(/\.v\d+$/, "");
  await db.update(temporalStates).set({ recordedTo: event.recordedTime }).where(and(eq(temporalStates.tenantId, event.tenantId), eq(temporalStates.entityType, event.subject.type), eq(temporalStates.entityId, event.subject.id), eq(temporalStates.stateType, stateType), isNull(temporalStates.recordedTo)));
  await db.insert(temporalStates).values({
    stateId: `STATE-${event.eventId}`,
    tenantId: event.tenantId,
    entityType: event.subject.type,
    entityId: event.subject.id,
    stateType,
    stateJson: payloadJson,
    validFrom: event.validTime,
    validTo: null,
    recordedFrom: event.recordedTime,
    recordedTo: null,
    sourceEventId: event.eventId,
  });
  await ensureTopology(db, event);
  await projectEventTopology(db, event);
  if (event.eventType === "adt.discharge.v2") await ensureContinuityEpisode(db, event);
  const manifests = await effectiveAgentManifests(event.tenantId);
  const proposals = evaluateEligibleCells(event, manifests);
  for (const cellProposal of proposals) {
    const manifest = manifests.find((item) => item.id === cellProposal.agentId);
    const executionId = `EXEC-${event.eventId}-${cellProposal.agentId}`;
    const outputHash = await hashJson(cellProposal);
    await db.insert(agentExecutions).values({
      executionId,
      tenantId: event.tenantId,
      agentId: cellProposal.agentId,
      agentVersion: manifest?.version ?? "1.0.0",
      eventId: event.eventId,
      episodeId: event.correlationId ?? null,
      traceId,
      status: "completed",
      inputHash: event.integrity.contentHash,
      outputHash,
      confidenceBasisPoints: cellProposal.confidenceBasisPoints,
      latencyMs: 1,
      abstentionReason: null,
      costMicrounits: 0,
      startedAt: event.recordedTime,
      completedAt: event.recordedTime,
    });
    await db.insert(agentProposals).values({
      proposalId: `PROP-${event.eventId}-${cellProposal.agentId}`,
      tenantId: event.tenantId,
      executionId,
      episodeId: event.correlationId ?? null,
      agentId: cellProposal.agentId,
      proposalType: cellProposal.proposalType,
      proposalJson: JSON.stringify(cellProposal),
      confidenceBasisPoints: cellProposal.confidenceBasisPoints,
      conflictGroup: cellProposal.conflictGroup ?? null,
      status: "proposed",
    });
    await appendTrace(db, traceId, null, "cell.completed", cellProposal.agentId, "ok", 1, { proposalType: cellProposal.proposalType, confidenceBasisPoints: cellProposal.confidenceBasisPoints, modelCalls: 0 });
  }
  if (rebuildPortfolio) await persistPortfolio(await loadCanonicalEvents(db), actor);
  return { idempotentReplay: false, eventId: event.eventId, proposals: proposals.length, traceId };
}

async function ensureContinuityEpisode(db: Db, event: CanonicalEvent) {
  await db.insert(outcomeEpisodes).values({
    episodeId: event.correlationId ?? "OUT-RUNTIME-1042",
    tenantId: event.tenantId,
    outcomeType: "post-discharge-continuity",
    scopeType: "facility",
    scopeId: String(event.payload.facilityId ?? "facility-franklin"),
    subjectId: event.subject.id,
    title: "Post-discharge treatment continuity",
    status: "observed",
    urgency: "critical",
    confidenceBasisPoints: 9900,
    ownerRole: "fa",
    actionClass: "B",
    evidenceCount: 1,
    currentRecommendation: "Awaiting sufficient evidence for a governed proposal.",
    openedAt: event.recordedTime,
    resolvedAt: null,
    version: 1,
  }).onConflictDoNothing({ target: outcomeEpisodes.episodeId });
}

async function persistPortfolio(events: CanonicalEvent[], actor: RuntimeActor) {
  const db = getDb();
  const policy = await effectiveRuntimePolicy(RUNTIME_TENANT);
  const portfolio = derivePortfolio(events, policy.escalationThresholdBasisPoints);
  const existingActions = await db.select().from(nextBestActions).where(eq(nextBestActions.tenantId, RUNTIME_TENANT));
  const existingById = new Map(existingActions.map((action) => [action.actionId, action]));
  await db.delete(swarmInsights).where(eq(swarmInsights.tenantId, RUNTIME_TENANT));
  if (portfolio.conflicts.length) await db.update(agentProposals).set({ status: "conflicted" }).where(and(eq(agentProposals.tenantId, RUNTIME_TENANT), eq(agentProposals.conflictGroup, "chair-capacity")));
  await db.delete(policyEvaluations).where(and(eq(policyEvaluations.tenantId, RUNTIME_TENANT), like(policyEvaluations.evaluationId, "POL-NBA-%")));
  for (const insight of portfolio.insights) await db.insert(swarmInsights).values({ insightId: insight.id, tenantId: RUNTIME_TENANT, episodeId: insight.episodeId ?? null, title: insight.title, summary: insight.summary, scopeId: insight.scopeId, confidenceBasisPoints: insight.confidenceBasisPoints, state: insight.state, contributorsJson: JSON.stringify(insight.agentIds), conflictsJson: JSON.stringify(insight.conflicts) });
  for (const action of portfolio.nbas) {
    const evaluationId = `POL-NBA-${action.id}`;
    const existing = existingById.get(action.id);
    const lifecycleStatus = existing && ["emitted", "completed", "approved"].includes(existing.status) ? existing.status : action.status;
    await db.insert(policyEvaluations).values({ evaluationId, tenantId: RUNTIME_TENANT, policyVersion: policy.version, entityType: "next-best-action", entityId: action.id, actorRole: actor.role, decision: action.status === "blocked" ? "block" : "review", reasonsJson: JSON.stringify(action.policyReasons), thresholdBasisPoints: policy.escalationThresholdBasisPoints });
    const values = { actionId: action.id, tenantId: RUNTIME_TENANT, episodeId: action.episodeId ?? null, rank: action.rank, title: action.title, outcome: action.outcome, scopeId: action.scopeId, ownerRole: action.ownerRole, dueAt: action.dueAt, valueLabel: action.valueLabel, confidenceBasisPoints: action.confidenceBasisPoints, actionClass: action.actionClass, evidenceCount: action.evidenceCount, agentIdsJson: JSON.stringify(action.agentIds), audienceJson: JSON.stringify(action.audience), status: lifecycleStatus, policyEvaluationId: evaluationId, updatedAt: new Date().toISOString() };
    await db.insert(nextBestActions).values(values).onConflictDoUpdate({ target: nextBestActions.actionId, set: values });
  }
  const continuity = portfolio.nbas.find((action) => action.episodeId === "OUT-RUNTIME-1042");
  const [continuityEpisode] = await db.select().from(outcomeEpisodes).where(eq(outcomeEpisodes.episodeId, "OUT-RUNTIME-1042")).limit(1);
  if (continuity && continuityEpisode?.status !== "resolved") await db.update(outcomeEpisodes).set({ status: continuity.status === "blocked" ? "blocked" : "awaiting-approval", confidenceBasisPoints: continuity.confidenceBasisPoints, evidenceCount: continuity.evidenceCount, currentRecommendation: continuity.title, version: Math.max(2, continuityEpisode?.version ?? 1), updatedAt: new Date().toISOString() }).where(eq(outcomeEpisodes.episodeId, "OUT-RUNTIME-1042"));
}

export async function approveRuntimeAction(actionId: string, actor: RuntimeActor) {
  const db = getDb();
  const policy = await effectiveRuntimePolicy(RUNTIME_TENANT);
  const [action] = await db.select().from(nextBestActions).where(and(eq(nextBestActions.tenantId, RUNTIME_TENANT), eq(nextBestActions.actionId, actionId))).limit(1);
  if (!action) throw new Error("NEXT_BEST_ACTION_NOT_FOUND");
  if (action.status === "completed") return { approved: true, idempotentReplay: true, commandId: `CMD-${actionId}`, outcomeAlreadyVerified: true, externalWriteEnabled: false, reasons: ["Outcome already completed"] };
  if (action.status === "emitted" || action.status === "approved") return { approved: true, idempotentReplay: true, commandId: `CMD-${actionId}`, outboxTopic: "service-coordination.review-requested.v1", externalWriteEnabled: false, reasons: ["Governed command already exists"] };
  if (action.status === "blocked") return { approved: false, reasons: ["The action is below the active policy threshold and cannot be approved"] };
  const authorization = authorizedForAction(actor.role, action.actionClass as "A" | "B" | "C" | "D", action.ownerRole as RuntimeRole);
  const scopeAuthorization = authorizedForScope(actor, action.scopeId);
  const allowed = authorization.allowed && scopeAuthorization.allowed;
  const reasons = [...authorization.reasons, scopeAuthorization.reason];
  const evaluationId = `POL-APPROVAL-${actionId}-${crypto.randomUUID()}`;
  await db.insert(policyEvaluations).values({ evaluationId, tenantId: RUNTIME_TENANT, policyVersion: policy.version, entityType: "next-best-action-approval", entityId: actionId, actorRole: actor.role, decision: allowed ? "allow" : "block", reasonsJson: JSON.stringify(reasons), thresholdBasisPoints: policy.escalationThresholdBasisPoints });
  await recordRoleAssignment(db, actor);
  const auditId = `AUD-${actionId}-${crypto.randomUUID()}`;
  await db.insert(auditEvents).values({ eventId: auditId, category: "policy-decision", actor: actor.email, action: "approve-next-best-action", entityType: "next-best-action", entityId: actionId, decision: allowed ? "approved" : "blocked", evidenceHash: await hashJson({ actionId, actor: actor.email, role: actor.role, reasons }), detail: JSON.stringify({ role: actor.role, scopeId: actor.scopeId, authentication: actor.authentication, syntheticDelegation: actor.syntheticDelegation }), configurationVersion: RUNTIME_CONFIGURATION });
  if (!allowed) {
    return { approved: false, reasons };
  }
  const commandId = `CMD-${actionId}`;
  const idempotencyKey = `runtime-${actionId}-v1`;
  const payload = { actionId, episodeId: action.episodeId, scopeId: action.scopeId, requestedBy: actor.email, role: actor.role, title: action.title, externalWriteEnabled: false };
  await db.update(nextBestActions).set({ status: "emitted", updatedAt: new Date().toISOString() }).where(eq(nextBestActions.actionId, actionId));
  await db.insert(commands).values({ commandId, tenantId: RUNTIME_TENANT, actionId, commandType: "service-coordination.review-requested.v1", destination: "kafka-outbox", idempotencyKey, payloadJson: JSON.stringify(payload), status: "emitted", emittedAt: new Date().toISOString(), acknowledgedAt: null }).onConflictDoNothing({ target: commands.idempotencyKey });
  const envelope = await commandEnvelope(commandId, action, payload);
  await db.insert(eventOutbox).values({ outboxId: `OUTBOX-${commandId}`, tenantId: RUNTIME_TENANT, topic: "service-coordination.review-requested.v1", messageKey: action.scopeId, envelopeJson: JSON.stringify(envelope), status: "pending", attempts: 0, nextAttemptAt: null, publishedAt: null }).onConflictDoNothing({ target: eventOutbox.outboxId });
  if (action.episodeId) await db.update(outcomeEpisodes).set({ status: "coordinating", version: 3, updatedAt: new Date().toISOString() }).where(eq(outcomeEpisodes.episodeId, action.episodeId));
  return { approved: true, commandId, outboxTopic: "service-coordination.review-requested.v1", externalWriteEnabled: false, reasons };
}

export async function acknowledgeRuntimeCommand(commandId: string, actor: RuntimeActor) {
  const db = getDb();
  const [command] = await db.select().from(commands).where(and(eq(commands.tenantId, RUNTIME_TENANT), eq(commands.commandId, commandId))).limit(1);
  if (!command) throw new Error("COMMAND_NOT_FOUND");
  if (command.status === "acknowledged") return { acknowledged: true, idempotentReplay: true, acknowledgementId: `ACK-${commandId}`, outcomeStatus: "resolved", measureResult: "100.00%" };
  const receivedAt = new Date().toISOString();
  const acknowledgementId = `ACK-${commandId}`;
  await db.insert(acknowledgements).values({ acknowledgementId, tenantId: RUNTIME_TENANT, commandId, acknowledgementType: "synthetic-downstream-completed", source: "facility-workflow-adapter", payloadJson: JSON.stringify({ actor: actor.email, outcomeObserved: true, synthetic: true }), receivedAt }).onConflictDoNothing({ target: acknowledgements.acknowledgementId });
  await db.update(commands).set({ status: "acknowledged", acknowledgedAt: receivedAt }).where(eq(commands.commandId, commandId));
  await db.update(nextBestActions).set({ status: "completed", updatedAt: receivedAt }).where(eq(nextBestActions.actionId, command.actionId));
  const [action] = await db.select().from(nextBestActions).where(eq(nextBestActions.actionId, command.actionId)).limit(1);
  if (action?.episodeId) await db.update(outcomeEpisodes).set({ status: "resolved", resolvedAt: receivedAt, version: 4, updatedAt: receivedAt }).where(eq(outcomeEpisodes.episodeId, action.episodeId));
  const evidenceHash = await hashJson({ commandId, acknowledgementId, receivedAt });
  await db.insert(measureResults).values({ resultId: `MEASURE-CONTINUITY-${command.actionId}`, tenantId: RUNTIME_TENANT, measurePackId: "continuity-outcome@2.1", scopeId: action?.scopeId ?? "facility-franklin", period: "2026-08", numerator: 1, denominator: 1, valueBasisPoints: 10000, status: "validated", sourceVersion: RUNTIME_CONFIGURATION, evidenceHash, calculatedAt: receivedAt }).onConflictDoNothing({ target: measureResults.resultId });
  await db.insert(auditEvents).values({ eventId: `AUD-${acknowledgementId}`, category: "human-action", actor: actor.email, action: "acknowledge-downstream-outcome", entityType: "command", entityId: commandId, decision: "completed", evidenceHash, detail: "Synthetic downstream acknowledgement closed the outcome loop; no external EMR write occurred.", configurationVersion: RUNTIME_CONFIGURATION }).onConflictDoNothing({ target: auditEvents.eventId });
  return { acknowledged: true, acknowledgementId, outcomeStatus: action?.episodeId ? "resolved" : "completed", measureResult: "100.00%" };
}

export async function simulateRuntimePolicy(thresholdBasisPoints: number) {
  const db = getDb();
  const policy = await effectiveRuntimePolicy(RUNTIME_TENANT);
  return simulatePolicyReplay(await loadCanonicalEvents(db), thresholdBasisPoints, {
    minThresholdBasisPoints: policy.minThresholdBasisPoints,
    maxThresholdBasisPoints: policy.maxThresholdBasisPoints,
    policyVersion: policy.version,
  });
}

export async function simulateRuntimeFacilityPlan(input: { facilityId: string; station: number; proposedAt: string }) {
  const db = getDb();
  return simulateFacilityPlan(await loadCanonicalEvents(db), input);
}

export async function reviewRuntimeEvidence(evidenceId: string, decision: "confirmed" | "rejected", actor: RuntimeActor) {
  const db = getDb();
  const [evidence] = await db.select().from(evidenceObjects).where(and(eq(evidenceObjects.tenantId, RUNTIME_TENANT), eq(evidenceObjects.evidenceId, evidenceId))).limit(1);
  if (!evidence) throw new Error("EVIDENCE_NOT_FOUND");
  if (!["evp", "dvp", "rod", "fa", "medical", "quality"].includes(actor.role)) throw new Error("AUTHORIZATION_DENIED: role cannot review patient evidence");
  const contentHash = await hashJson({ evidenceId, decision, sourceHash: evidence.contentHash, reviewer: actor.email, role: actor.role });
  const reviewId = `REVIEW-${contentHash.slice(0, 24)}`;
  await db.insert(evidenceReviews).values({ reviewId, tenantId: RUNTIME_TENANT, evidenceId, decision, reviewer: actor.email, reviewerRole: actor.role, citedText: evidence.exactText, contentHash }).onConflictDoNothing({ target: evidenceReviews.reviewId });
  await db.insert(auditEvents).values({ eventId: `AUD-${reviewId}`, category: "human-action", actor: actor.email, action: `${decision}-assessment-evidence`, entityType: "evidence-object", entityId: evidenceId, decision: "completed", evidenceHash: contentHash, detail: JSON.stringify({ sourceEventId: evidence.sourceEventId, citedTextRetained: Boolean(evidence.exactText), role: actor.role }), configurationVersion: RUNTIME_CONFIGURATION }).onConflictDoNothing({ target: auditEvents.eventId });
  return { reviewId, evidenceId, decision, contentHash };
}

export async function requestRuntimeReview(input: { entityType: string; entityId: string; targetRole: string; message: string }, actor: RuntimeActor) {
  if (!input.entityType.trim() || !input.entityId.trim() || !input.targetRole.trim() || !input.message.trim()) throw new Error("REVIEW_REQUEST_INVALID");
  if (!["evp", "dvp", "rod", "fa", "medical", "quality", "finance", "biomed"].includes(actor.role)) throw new Error("AUTHORIZATION_DENIED: role cannot request human review");
  const evidenceHash = await hashJson({ ...input, requester: actor.email, role: actor.role, scopeId: actor.scopeId, configuration: RUNTIME_CONFIGURATION });
  const requestId = `REVIEW-REQUEST-${evidenceHash.slice(0, 20).toUpperCase()}`;
  const db = getDb();
  await db.insert(auditEvents).values({ eventId: requestId, category: "human-action", actor: actor.email, action: "request-human-review", entityType: input.entityType, entityId: input.entityId, decision: "requested", evidenceHash, detail: JSON.stringify({ targetRole: input.targetRole, message: input.message, requesterRole: actor.role, scopeId: actor.scopeId }), configurationVersion: RUNTIME_CONFIGURATION }).onConflictDoNothing({ target: auditEvents.eventId });
  return { requestId, status: "requested", targetRole: input.targetRole, evidenceHash };
}

export async function createRuntimeSubmissionPackage(actor: RuntimeActor) {
  const db = getDb();
  const pack = measurePacks.find((item) => item.id === "ktv-comprehensive");
  if (!pack) throw new Error("MEASURE_PACK_NOT_FOUND");
  const sources = publicSources.filter((source) => pack.sourceIds.includes(source.id));
  const authorityReady = pack.status === "active-final" && sources.length === pack.sourceIds.length && sources.every((source) => source.synthetic === false && !source.status.includes("proposed"));
  if (!authorityReady) throw new Error("AUTHORITY_RELEASE_GATE_BLOCKED");
  const results = await db.select().from(measureResults).where(eq(measureResults.tenantId, RUNTIME_TENANT));
  const manifestHash = await hashJson({ results, sources: sources.map((source) => ({ id: source.id, status: source.status, effectiveFrom: source.effectiveFrom, url: source.url })), measurePackVersion: pack.version, transmission: false });
  const packageId = `DRY-RUNTIME-${manifestHash.slice(0, 12).toUpperCase()}`;
  await db.insert(submissionPackages).values({ packageId, tenantId: RUNTIME_TENANT, program: "EQRS reference dry run", period: "PY2026", measurePackVersion: pack.version, rowCount: Math.max(4237, results.length), status: "validated", manifestHash, createdBy: actor.email, approvedBy: null, receiptJson: null }).onConflictDoNothing({ target: submissionPackages.packageId });
  await db.insert(auditEvents).values({ eventId: `AUD-${packageId}`, category: "human-action", actor: actor.email, action: "create-validated-submission-dry-run", entityType: "submission-package", entityId: packageId, decision: "completed", evidenceHash: manifestHash, detail: JSON.stringify({ authoritySourceIds: sources.map((source) => source.id), liveTransmission: false, approvalState: "dual approval not satisfied" }), configurationVersion: RUNTIME_CONFIGURATION }).onConflictDoNothing({ target: auditEvents.eventId });
  return { packageId, status: "validated", manifestHash, liveTransmission: false, resultsIncluded: results.length };
}

export async function runtimeSnapshot() {
  const db = getDb();
  const [events, evidence, reviews, states, nodes, edges, episodes, executions, proposals, insights, actions, policies, runtimeCommands, acks, outbox, spans, measures, packages, models, drift, runtimeIncidents, authorities, audits] = await Promise.all([
    db.select().from(eventEnvelopes).where(eq(eventEnvelopes.tenantId, RUNTIME_TENANT)).orderBy(desc(eventEnvelopes.recordedTime)).limit(50),
    db.select().from(evidenceObjects).where(eq(evidenceObjects.tenantId, RUNTIME_TENANT)).orderBy(desc(evidenceObjects.recordedAt)).limit(50),
    db.select().from(evidenceReviews).where(eq(evidenceReviews.tenantId, RUNTIME_TENANT)).orderBy(desc(evidenceReviews.createdAt)).limit(50),
    db.select().from(temporalStates).where(eq(temporalStates.tenantId, RUNTIME_TENANT)).orderBy(desc(temporalStates.recordedFrom)).limit(50),
    db.select().from(topologyNodes).where(eq(topologyNodes.tenantId, RUNTIME_TENANT)).limit(100),
    db.select().from(topologyEdges).where(eq(topologyEdges.tenantId, RUNTIME_TENANT)).limit(200),
    db.select().from(outcomeEpisodes).where(eq(outcomeEpisodes.tenantId, RUNTIME_TENANT)).orderBy(desc(outcomeEpisodes.updatedAt)).limit(20),
    db.select().from(agentExecutions).where(eq(agentExecutions.tenantId, RUNTIME_TENANT)).orderBy(desc(agentExecutions.startedAt)).limit(100),
    db.select().from(agentProposals).where(eq(agentProposals.tenantId, RUNTIME_TENANT)).orderBy(desc(agentProposals.createdAt)).limit(100),
    db.select().from(swarmInsights).where(eq(swarmInsights.tenantId, RUNTIME_TENANT)).orderBy(desc(swarmInsights.confidenceBasisPoints)).limit(20),
    db.select().from(nextBestActions).where(eq(nextBestActions.tenantId, RUNTIME_TENANT)).orderBy(nextBestActions.rank).limit(20),
    db.select().from(policyEvaluations).where(eq(policyEvaluations.tenantId, RUNTIME_TENANT)).orderBy(desc(policyEvaluations.createdAt)).limit(30),
    db.select().from(commands).where(eq(commands.tenantId, RUNTIME_TENANT)).orderBy(desc(commands.createdAt)).limit(20),
    db.select().from(acknowledgements).where(eq(acknowledgements.tenantId, RUNTIME_TENANT)).orderBy(desc(acknowledgements.receivedAt)).limit(20),
    db.select().from(eventOutbox).where(eq(eventOutbox.tenantId, RUNTIME_TENANT)).orderBy(desc(eventOutbox.createdAt)).limit(20),
    db.select().from(traceSpans).where(eq(traceSpans.tenantId, RUNTIME_TENANT)).orderBy(desc(traceSpans.createdAt)).limit(100),
    db.select().from(measureResults).where(eq(measureResults.tenantId, RUNTIME_TENANT)).orderBy(desc(measureResults.calculatedAt)).limit(20),
    db.select().from(submissionPackages).where(eq(submissionPackages.tenantId, RUNTIME_TENANT)).orderBy(desc(submissionPackages.createdAt)).limit(10),
    db.select().from(modelRegistry).orderBy(desc(modelRegistry.lastEvaluatedAt)).limit(20),
    db.select().from(driftSnapshots).where(eq(driftSnapshots.tenantId, RUNTIME_TENANT)).orderBy(desc(driftSnapshots.measuredAt)).limit(20),
    db.select().from(incidents).where(eq(incidents.tenantId, RUNTIME_TENANT)).orderBy(desc(incidents.openedAt)).limit(20),
    db.select().from(authoritySnapshots).orderBy(desc(authoritySnapshots.effectiveFrom)).limit(30),
    db.select().from(auditEvents).where(eq(auditEvents.configurationVersion, RUNTIME_CONFIGURATION)).orderBy(desc(auditEvents.createdAt)).limit(50),
  ]);
  const completed = executions.filter((execution) => execution.status === "completed");
  const averageLatencyMs = completed.length ? Math.round(completed.reduce((sum, execution) => sum + execution.latencyMs, 0) / completed.length) : 0;
  const [effectiveConfiguration, effectivePolicy] = await Promise.all([
    activeConfigurationVersion(RUNTIME_TENANT),
    effectiveRuntimePolicy(RUNTIME_TENANT),
  ]);
  return {
    runtime: { status: events.length ? "active" : "empty", tenantId: RUNTIME_TENANT, configuration: effectiveConfiguration, policyVersion: effectivePolicy.version, source: "D1 persistent runtime + hot configuration", eventTransport: "HTTP ingress + Kafka outbox bridge", externalWritesEnabled: false, replayEventsAvailable: runtimeReplayEvents.length },
    counts: { events: events.length, evidence: evidence.length, evidenceReviews: reviews.length, temporalStates: states.length, topologyNodes: nodes.length, topologyEdges: edges.length, executions: executions.length, proposals: proposals.length, insights: insights.length, actions: actions.length, commands: runtimeCommands.length, acknowledgements: acks.length, measures: measures.length, auditEvents: audits.length },
    health: { completedExecutions: completed.length, failedExecutions: executions.filter((execution) => execution.status === "failed").length, abstentions: executions.filter((execution) => execution.status === "abstained").length, averageLatencyMs, totalCostMicrounits: executions.reduce((sum, execution) => sum + execution.costMicrounits, 0), conflicts: insights.reduce((sum, insight) => sum + JSON.parse(insight.conflictsJson).length, 0), pendingOutbox: outbox.filter((item) => item.status === "pending" || item.status === "leased").length, failedOutbox: outbox.filter((item) => item.status === "failed").length },
    events: events.map((event) => ({ ...event, payload: JSON.parse(event.payloadJson) })),
    evidence: evidence.map((item) => ({ ...item, structured: JSON.parse(item.structuredJson) })),
    evidenceReviews: reviews,
    temporalStates: states.map((item) => ({ ...item, state: JSON.parse(item.stateJson) })),
    topology: { nodes: nodes.map((node) => ({ id: node.nodeId, label: node.label, type: node.nodeType, x: node.xBasisPoints / 1000, y: node.yBasisPoints / 1000, z: node.zBasisPoints / 1000, attributes: JSON.parse(node.attributesJson) })), edges: edges.map((edge) => ({ id: edge.edgeId, source: edge.sourceNodeId, target: edge.targetNodeId, relation: edge.relation, confidence: edge.confidenceBasisPoints / 10000, provenance: JSON.parse(edge.provenanceJson) })) },
    episodes,
    executions,
    proposals: proposals.map((proposal) => ({ ...proposal, proposal: JSON.parse(proposal.proposalJson) })),
    insights: insights.map((insight) => ({ ...insight, agentIds: JSON.parse(insight.contributorsJson), conflicts: JSON.parse(insight.conflictsJson) })),
    actions: actions.map((action) => ({ ...action, agentIds: JSON.parse(action.agentIdsJson), audience: JSON.parse(action.audienceJson) })),
    policies: policies.map((policy) => ({ ...policy, reasons: JSON.parse(policy.reasonsJson) })),
    commands: runtimeCommands.map((command) => ({ ...command, payload: JSON.parse(command.payloadJson) })),
    acknowledgements: acks.map((ack) => ({ ...ack, payload: JSON.parse(ack.payloadJson) })),
    outbox: outbox.map((item) => ({ ...item, envelope: JSON.parse(item.envelopeJson) })),
    traces: spans.map((span) => ({ ...span, attributes: JSON.parse(span.attributesJson) })),
    measures,
    submissionPackages: packages,
    models,
    drift,
    incidents: runtimeIncidents,
    authoritySnapshots: authorities,
    audits,
  };
}

async function loadCanonicalEvents(db: Db): Promise<CanonicalEvent[]> {
  const rows = await db.select().from(eventEnvelopes).where(eq(eventEnvelopes.tenantId, RUNTIME_TENANT)).orderBy(eventEnvelopes.recordedTime);
  return rows.map((row) => ({ eventId: row.eventId, eventType: row.eventType, schemaVersion: row.schemaVersion, tenantId: row.tenantId, subject: { type: row.subjectType as CanonicalEvent["subject"]["type"], id: row.subjectId }, purpose: row.purpose, validTime: row.validTime, recordedTime: row.recordedTime, correlationId: row.correlationId ?? undefined, causationId: row.causationId ?? undefined, source: { system: row.sourceSystem, resource: row.sourceResource }, integrity: { algorithm: "sha256", contentHash: row.contentHash }, payload: JSON.parse(row.payloadJson) }));
}

async function ensureTopology(db: Db, event: CanonicalEvent) {
  for (const node of graphNodes) await db.insert(topologyNodes).values({ nodeId: node.id, tenantId: event.tenantId, nodeType: node.type, label: node.label, scopeId: scopeForNode(node.id), attributesJson: JSON.stringify({ projection: "runtime", source: node.id === "cms-authority" ? "public-authority-registry" : "synthetic-event-fabric" }), xBasisPoints: Math.round(node.x * 1000), yBasisPoints: Math.round(node.y * 1000), zBasisPoints: Math.round(node.z * 1000), validFrom: event.validTime, validTo: null, sourceEventId: event.eventId }).onConflictDoNothing({ target: topologyNodes.nodeId });
  for (const edge of graphEdges) await db.insert(topologyEdges).values({ edgeId: `EDGE-${edge.source}-${edge.relation.replaceAll(" ", "-")}-${edge.target}`, tenantId: event.tenantId, sourceNodeId: edge.source, targetNodeId: edge.target, relation: edge.relation, confidenceBasisPoints: 10000, provenanceJson: JSON.stringify({ sourceEventId: event.eventId, configuration: RUNTIME_CONFIGURATION }), validFrom: event.validTime, validTo: null, sourceEventId: event.eventId }).onConflictDoNothing({ target: topologyEdges.edgeId });
}

async function projectEventTopology(db: Db, event: CanonicalEvent) {
  const eventNodeId = `event:${event.eventId}`;
  const sourceNodeId = `source:${event.source.system}`;
  const eventPosition = graphPosition(eventNodeId, 3.9);
  const sourcePosition = graphPosition(sourceNodeId, 5.5);
  await db.insert(topologyNodes).values({ nodeId: eventNodeId, tenantId: event.tenantId, nodeType: "signal", label: event.eventType, scopeId: event.subject.id, attributesJson: JSON.stringify({ validTime: event.validTime, contentHash: event.integrity.contentHash }), xBasisPoints: eventPosition.x, yBasisPoints: eventPosition.y, zBasisPoints: eventPosition.z, validFrom: event.validTime, validTo: null, sourceEventId: event.eventId }).onConflictDoNothing({ target: topologyNodes.nodeId });
  await db.insert(topologyNodes).values({ nodeId: sourceNodeId, tenantId: event.tenantId, nodeType: "source", label: event.source.system, scopeId: event.subject.id, attributesJson: JSON.stringify({ resource: event.source.resource }), xBasisPoints: sourcePosition.x, yBasisPoints: sourcePosition.y, zBasisPoints: sourcePosition.z, validFrom: event.validTime, validTo: null, sourceEventId: event.eventId }).onConflictDoNothing({ target: topologyNodes.nodeId });
  await db.insert(topologyEdges).values({ edgeId: `EDGE-${sourceNodeId}-asserts-${eventNodeId}`, tenantId: event.tenantId, sourceNodeId, targetNodeId: eventNodeId, relation: "asserts", confidenceBasisPoints: 10000, provenanceJson: JSON.stringify({ eventId: event.eventId, contentHash: event.integrity.contentHash }), validFrom: event.validTime, validTo: null, sourceEventId: event.eventId }).onConflictDoNothing({ target: topologyEdges.edgeId });
}

function graphPosition(id: string, radius: number) {
  let seed = 2166136261;
  for (const character of id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const angle = (seed % 6283) / 1000;
  const elevation = (((seed >>> 8) % 2000) / 1000) - 1;
  return { x: Math.round(Math.cos(angle) * radius * 1000), y: Math.round(Math.sin(angle) * radius * 700), z: Math.round(elevation * 1600) };
}

function scopeForNode(nodeId: string) {
  if (["enterprise"].includes(nodeId)) return "enterprise-rbkc";
  if (["division", "cms-authority"].includes(nodeId)) return "division-southeast";
  if (["region", "franklin", "columbia", "murfreesboro", "workforce-cluster", "access-cluster", "quality", "measure"].includes(nodeId)) return "region-middle-tennessee";
  return "facility-franklin";
}

async function appendTrace(db: Db, traceId: string, parentSpanId: string | null, name: string, system: string, status: "ok" | "review" | "blocked" | "error", durationMs: number, attributes: Record<string, unknown>) {
  await db.insert(traceSpans).values({ spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16), traceId, parentSpanId, tenantId: RUNTIME_TENANT, name, system, status, durationMs, attributesJson: JSON.stringify(attributes) });
}

async function recordRoleAssignment(db: Db, actor: RuntimeActor) {
  const assignmentId = `ROLE-${await hashJson({ actor: actor.email, role: actor.role, scope: actor.scopeId }).then((hash) => hash.slice(0, 24))}`;
  await db.insert(roleAssignments).values({ assignmentId, tenantId: RUNTIME_TENANT, actorEmail: actor.email, roleId: actor.role, scopeLevel: actor.scopeLevel, scopeId: actor.scopeId, effectiveFrom: new Date().toISOString(), effectiveTo: null, syntheticDelegation: actor.syntheticDelegation }).onConflictDoNothing({ target: roleAssignments.assignmentId });
}

async function commandEnvelope(commandId: string, action: typeof nextBestActions.$inferSelect, payload: Record<string, unknown>): Promise<CanonicalEvent> {
  const now = new Date().toISOString();
  return { eventId: `EVT-${commandId}`, eventType: "service-coordination.review-requested.v1", schemaVersion: "1.0.0", tenantId: RUNTIME_TENANT, subject: { type: "cohort", id: action.scopeId }, purpose: "governed-service-coordination", validTime: now, recordedTime: now, correlationId: action.episodeId ?? action.actionId, source: { system: "renal-outcome-harness", resource: "Command", version: RUNTIME_CONFIGURATION }, integrity: { algorithm: "sha256", contentHash: await hashJson(payload) }, classification: ["synthetic", "audit"], payload };
}

async function seedRuntimeAssurance() {
  const db = getDb();
  for (const source of publicSources) {
    const contentHash = await hashJson({ id: source.id, authority: source.authority, status: source.status, published: source.published, effectiveFrom: source.effectiveFrom, url: source.url, refresh: source.refresh, synthetic: source.synthetic });
    await db.insert(authoritySnapshots).values({ sourceId: source.id, authority: source.authority, status: source.status, effectiveFrom: source.effectiveFrom, sourceUrl: source.url, contentHash, retrievedAt: "2026-08-21T12:00:00.000Z" }).onConflictDoNothing({ target: [authoritySnapshots.sourceId, authoritySnapshots.effectiveFrom] });
  }
  await db.insert(modelRegistry).values({ registryId: "MODEL-deterministic-runtime-5", modelId: "deterministic-runtime", modelVersion: "5.0.0", provider: "internal", purpose: "rules, policy and measure execution", status: "active", evaluationScoreBasisPoints: 10000, costMicrounitsPerCall: 0, killSwitch: true, lastEvaluatedAt: "2026-08-21T12:15:00.000Z" }).onConflictDoNothing({ target: modelRegistry.registryId });
  await db.insert(modelRegistry).values({ registryId: "MODEL-grounded-extractor-1", modelId: "grounded-assessment-extractor", modelVersion: "1.0.0", provider: "configurable", purpose: "cited fact candidates only", status: "candidate", evaluationScoreBasisPoints: 9680, costMicrounitsPerCall: 28, killSwitch: true, lastEvaluatedAt: "2026-08-21T12:15:00.000Z" }).onConflictDoNothing({ target: modelRegistry.registryId });
  await db.insert(driftSnapshots).values({ driftId: "DRIFT-contract-20260821", tenantId: RUNTIME_TENANT, targetId: "canonical-event@1.0.0", metric: "schema-rejection-rate", valueBasisPoints: 0, thresholdBasisPoints: 50, status: "healthy", measuredAt: "2026-08-21T12:15:00.000Z" }).onConflictDoNothing({ target: driftSnapshots.driftId });
  await db.insert(driftSnapshots).values({ driftId: "DRIFT-assessment-20260821", tenantId: RUNTIME_TENANT, targetId: "grounded-assessment-extractor@1.0.0", metric: "groundedness-delta", valueBasisPoints: 20, thresholdBasisPoints: 300, status: "healthy", measuredAt: "2026-08-21T12:15:00.000Z" }).onConflictDoNothing({ target: driftSnapshots.driftId });
}

export function actorFromRequest(request: Request, role?: string) {
  return resolveRuntimeActor(request, role);
}
