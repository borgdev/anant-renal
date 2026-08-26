import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  configurationObjects,
  configurationValidations,
  integrationConnections,
  onboardingStates,
  tenantConfigurationReleases,
  tenantEnvironments,
} from "../../db/schema";
import type {
  AdminConsoleSnapshot,
  AgentConfiguration,
  ConfigurationValidationView,
  KafkaBridgeConfiguration,
  OnboardingStep,
  OnboardingStepId,
  RuntimePolicyConfiguration,
} from "../control-plane/contracts";
import type { RuntimeActor } from "../runtime/authorization";
import { hashJson } from "../runtime/crypto";
import { runRuntimeRedTeam } from "../runtime/evals";
import {
  activeConfigurationVersion,
  agentConfigurationFromManifest,
  BASE_CONFIGURATION_VERSION,
  DEFAULT_ENVIRONMENT_ID,
  effectiveAgentManifests,
  effectiveRuntimePolicy,
  validateAgentConfiguration,
  validateRuntimePolicy,
} from "./configuration-repository";
import { ControlPlaneError, requireSafeIdentifier } from "./request-security";

const DEFAULT_TENANT = "demo-renal-enterprise";
const DEFAULT_TOPICS: KafkaBridgeConfiguration["topicMappings"] = [
  { direction: "inbound", topic: "renal.canonical.events.v1", contract: "canonical-event@1.0.0" },
  { direction: "outbound", topic: "renal.governed.commands.v1", contract: "governed-command@1.0.0" },
  { direction: "inbound", topic: "renal.command.acknowledgements.v1", contract: "command-ack@1.0.0" },
];

type EnvironmentRow = typeof tenantEnvironments.$inferSelect;
type ConnectionRow = typeof integrationConnections.$inferSelect;
type ReleaseRow = typeof tenantConfigurationReleases.$inferSelect;

function now() {
  return new Date().toISOString();
}

function rawSecretKey(value: string) {
  return /(^|[-_])(password|passwd|secret|token|api[-_]?key|private[-_]?key)($|[-_])/i.test(value);
}

function rejectEmbeddedSecrets(value: unknown, path = "payload") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (rawSecretKey(key) && key !== "secretRef") {
      throw new ControlPlaneError(`RAW_SECRET_FIELD_BLOCKED:${path}.${key}`, 400);
    }
    rejectEmbeddedSecrets(nested, `${path}.${key}`);
  }
}

function safeText(value: unknown, name: string, max = 160) {
  return requireSafeIdentifier(typeof value === "string" ? value : null, name, max);
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") throw new ControlPlaneError("BRIDGE_URL_REQUIRED", 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError("BRIDGE_URL_INVALID", 400);
  }
  if (url.protocol !== "https:") throw new ControlPlaneError("BRIDGE_HTTPS_REQUIRED", 400);
  if (url.username || url.password) throw new ControlPlaneError("BRIDGE_URL_CREDENTIALS_BLOCKED", 400);
  return url.toString().replace(/\/$/, "");
}

function parseTopics(value: unknown) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 24) {
    throw new ControlPlaneError("KAFKA_TOPIC_MAPPINGS_INVALID", 400);
  }
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (row.direction !== "inbound" && row.direction !== "outbound") {
      throw new ControlPlaneError(`KAFKA_TOPIC_DIRECTION_INVALID:${index}`, 400);
    }
    return {
      direction: row.direction,
      topic: safeText(row.topic, `KAFKA_TOPIC_${index}`, 180),
      contract: safeText(row.contract, `KAFKA_CONTRACT_${index}`, 120),
    };
  });
}

function kafkaView(connection?: ConnectionRow): KafkaBridgeConfiguration {
  if (!connection) {
    return {
      connectionId: null,
      displayName: "Organization Kafka bridge",
      bridgeUrl: "https://bridge.customer.example",
      clusterAlias: "renal-enterprise-events",
      securityProtocol: "SASL_SSL",
      secretRef: "binding:KAFKA_BRIDGE_TOKEN",
      consumerGroup: "renal-swarm-control-plane",
      topicMappings: DEFAULT_TOPICS,
      status: "not-configured",
      lastTestedAt: null,
      testMode: "not-run",
      testSummary: "Save the bridge contract, then run a server-side connectivity test.",
    };
  }
  let result: Record<string, unknown> = {};
  try {
    result = connection.lastTestResultJson ? JSON.parse(connection.lastTestResultJson) as Record<string, unknown> : {};
  } catch {
    result = {};
  }
  return {
    connectionId: connection.connectionId,
    displayName: connection.displayName,
    bridgeUrl: connection.endpointUrl,
    clusterAlias: connection.clusterAlias,
    securityProtocol: connection.securityProtocol as KafkaBridgeConfiguration["securityProtocol"],
    secretRef: connection.secretRef,
    consumerGroup: connection.consumerGroup,
    topicMappings: JSON.parse(connection.topicMappingsJson) as KafkaBridgeConfiguration["topicMappings"],
    status: connection.status,
    lastTestedAt: connection.lastTestedAt,
    testMode: result.mode === "live-bridge" ? "live-bridge" : connection.lastTestedAt ? "contract-only" : "not-run",
    testSummary: typeof result.summary === "string" ? result.summary : "Bridge configuration saved; connectivity has not been tested.",
  };
}

function environmentFallback(): AdminConsoleSnapshot["tenant"] {
  return {
    tenantId: DEFAULT_TENANT,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    displayName: "Riverbend Dialysis",
    environmentName: "reference",
    deploymentMode: "reference",
    timeZone: "America/Chicago",
    dataRegion: "United States",
    status: "onboarding",
    persisted: false,
  };
}

function environmentView(environment?: EnvironmentRow): AdminConsoleSnapshot["tenant"] {
  if (!environment) return environmentFallback();
  return {
    tenantId: environment.tenantId,
    environmentId: environment.environmentId,
    displayName: environment.displayName,
    environmentName: environment.environmentName,
    deploymentMode: environment.deploymentMode,
    timeZone: environment.timeZone,
    dataRegion: environment.dataRegion,
    status: environment.status,
    persisted: true,
  };
}

function stepState(
  environment: EnvironmentRow | undefined,
  connection: ConnectionRow | undefined,
  releases: ReleaseRow[],
) {
  const active = releases.some((release) => release.status === "active");
  const validated = releases.some((release) => release.status === "validated" || release.status === "active");
  const draft = releases.length > 0;
  const kafkaSaved = Boolean(connection);
  const kafkaTested = connection?.status === "contract-verified" || connection?.status === "verified" || connection?.status === "active";
  const complete: Record<OnboardingStepId, boolean> = {
    organization: Boolean(environment),
    identity: Boolean(environment),
    kafka: kafkaTested,
    adapters: kafkaSaved && kafkaTested,
    agents: draft,
    cms: Boolean(environment),
    validate: validated,
    activate: active,
  };
  const order: Array<{ id: OnboardingStepId; label: string; detail: string }> = [
    { id: "organization", label: "Organization", detail: "Tenant, environment, region and operating boundary" },
    { id: "identity", label: "Identity & roles", detail: "Workspace identity mapped to scoped enterprise roles" },
    { id: "kafka", label: "Kafka bridge", detail: "HTTPS bridge, topic allowlist and secret binding reference" },
    { id: "adapters", label: "Data adapters", detail: "Canonical event and acknowledgement contracts" },
    { id: "agents", label: "Agent pack", detail: "Triggers, proposals, eval gate and kill switch" },
    { id: "cms", label: "CMS pack", detail: "Versioned public authorities and measure contracts" },
    { id: "validate", label: "Validate", detail: "Schema, green-team, red-team and integration gates" },
    { id: "activate", label: "Activate", detail: "Hot configuration release with rollback target" },
  ];
  const firstPending = order.findIndex((step) => !complete[step.id]);
  const steps: OnboardingStep[] = order.map((step, index) => ({
    ...step,
    status: complete[step.id] ? "complete" : index === firstPending ? "current" : "pending",
  }));
  const completed = steps.filter((step) => step.status === "complete").length;
  return {
    steps,
    currentStep: (steps.find((step) => step.status === "current")?.id ?? "activate") as OnboardingStepId,
    completionBasisPoints: Math.round((completed / steps.length) * 10000),
    status: active ? "active" as const : completed >= steps.length - 1 ? "ready" as const : environment ? "in-progress" as const : "not-started" as const,
  };
}

async function loadRows(tenantId: string, environmentId: string) {
  const db = getDb();
  const [environmentRows, connectionRows, releases, objects, validations] = await Promise.all([
    db.select().from(tenantEnvironments).where(and(eq(tenantEnvironments.tenantId, tenantId), eq(tenantEnvironments.environmentId, environmentId))).limit(1),
    db.select().from(integrationConnections).where(and(eq(integrationConnections.tenantId, tenantId), eq(integrationConnections.environmentId, environmentId), eq(integrationConnections.kind, "kafka-bridge"))).limit(1),
    db.select().from(tenantConfigurationReleases).where(and(eq(tenantConfigurationReleases.tenantId, tenantId), eq(tenantConfigurationReleases.environmentId, environmentId))).orderBy(desc(tenantConfigurationReleases.createdAt)).limit(20),
    db.select().from(configurationObjects).where(and(eq(configurationObjects.tenantId, tenantId), eq(configurationObjects.environmentId, environmentId))),
    db.select().from(configurationValidations).where(and(eq(configurationValidations.tenantId, tenantId), eq(configurationValidations.environmentId, environmentId))).orderBy(desc(configurationValidations.runAt)).limit(30),
  ]);
  return { environment: environmentRows[0], connection: connectionRows[0], releases, objects, validations };
}

async function workingAgents(tenantId: string, rows: Awaited<ReturnType<typeof loadRows>>) {
  const effective = (await effectiveAgentManifests(tenantId)).map(agentConfigurationFromManifest);
  const working = rows.releases.find((release) => release.status === "draft" || release.status === "validated");
  if (!working) return effective;
  const overrides = new Map<string, AgentConfiguration>();
  for (const object of rows.objects.filter((item) => item.releaseId === working.releaseId && item.objectType === "agent")) {
    const parsed = JSON.parse(object.payloadJson) as AgentConfiguration;
    overrides.set(parsed.id, { ...parsed, enabled: object.enabled });
  }
  return effective.map((agent) => overrides.get(agent.id) ?? agent);
}

async function workingPolicy(tenantId: string, rows: Awaited<ReturnType<typeof loadRows>>) {
  const effective = await effectiveRuntimePolicy(tenantId);
  const working = rows.releases.find((release) => release.status === "draft" || release.status === "validated");
  if (!working) return effective;
  const object = rows.objects.find((item) => item.releaseId === working.releaseId && item.objectType === "policy" && item.objectKey === "action-boundary");
  return object ? JSON.parse(object.payloadJson) as RuntimePolicyConfiguration : effective;
}

export async function adminConsoleSnapshot(
  tenantId = DEFAULT_TENANT,
  environmentId = DEFAULT_ENVIRONMENT_ID,
): Promise<AdminConsoleSnapshot> {
  const rows = await loadRows(tenantId, environmentId);
  const onboarding = stepState(rows.environment, rows.connection, rows.releases);
  const objectCounts = new Map<string, number>();
  for (const object of rows.objects) objectCounts.set(object.releaseId, (objectCounts.get(object.releaseId) ?? 0) + 1);
  const validations: ConfigurationValidationView[] = rows.validations.map((validation) => ({
    validationId: validation.validationId,
    releaseId: validation.releaseId,
    suite: validation.suite,
    status: validation.status,
    scoreBasisPoints: validation.scoreBasisPoints,
    checks: JSON.parse(validation.checksJson) as ConfigurationValidationView["checks"],
    evidenceHash: validation.evidenceHash,
    runAt: validation.runAt,
  }));
  return {
    generatedAt: now(),
    tenant: environmentView(rows.environment),
    onboarding,
    kafka: kafkaView(rows.connection),
    agents: await workingAgents(tenantId, rows),
    policy: await workingPolicy(tenantId, rows),
    releases: rows.releases.map((release) => ({
      releaseId: release.releaseId,
      version: release.version,
      status: release.status,
      changeSummary: release.changeSummary,
      contentHash: release.contentHash,
      objectCount: objectCounts.get(release.releaseId) ?? 0,
      createdBy: release.createdBy,
      createdAt: release.createdAt,
      validatedAt: release.validatedAt,
      activatedAt: release.activatedAt,
    })),
    validations,
    activeConfigurationVersion: await activeConfigurationVersion(tenantId, environmentId),
    activation: {
      runtimeEffect: "hot-reload",
      codeRedeployRequired: false,
      externalWritesEnabled: false,
      productionGate: "Live Kafka bridge verification, passing green/red suites, scoped approval and rollback target are required.",
    },
  };
}

async function persistOnboarding(actor: RuntimeActor, tenantId: string, environmentId: string) {
  const rows = await loadRows(tenantId, environmentId);
  const state = stepState(rows.environment, rows.connection, rows.releases);
  const values = {
    onboardingId: `ONBOARD-${environmentId}`,
    tenantId,
    environmentId,
    currentStep: state.currentStep,
    stepsJson: JSON.stringify(state.steps),
    status: state.status,
    updatedBy: actor.email,
    updatedAt: now(),
  };
  await getDb().insert(onboardingStates).values(values).onConflictDoUpdate({
    target: onboardingStates.onboardingId,
    set: values,
  });
}

export async function saveOrganization(actor: RuntimeActor, payload: Record<string, unknown>) {
  rejectEmbeddedSecrets(payload);
  const tenantId = DEFAULT_TENANT;
  const environmentId = DEFAULT_ENVIRONMENT_ID;
  const requestedDeploymentMode = payload.deploymentMode;
  if (requestedDeploymentMode !== "reference" && requestedDeploymentMode !== "non-production" && requestedDeploymentMode !== "production") {
    throw new ControlPlaneError("DEPLOYMENT_MODE_INVALID", 400);
  }
  const deploymentMode = requestedDeploymentMode as "reference" | "non-production" | "production";
  const values = {
    environmentId,
    tenantId,
    displayName: safeText(payload.displayName, "ORGANIZATION_NAME", 120),
    environmentName: safeText(payload.environmentName, "ENVIRONMENT_NAME", 48).toLowerCase(),
    deploymentMode,
    status: "onboarding" as const,
    timeZone: safeText(payload.timeZone, "TIME_ZONE", 80),
    dataRegion: safeText(payload.dataRegion, "DATA_REGION", 80),
    createdBy: actor.email,
    createdAt: now(),
    updatedAt: now(),
  };
  await getDb().insert(tenantEnvironments).values(values).onConflictDoUpdate({
    target: tenantEnvironments.environmentId,
    set: {
      displayName: values.displayName,
      environmentName: values.environmentName,
      deploymentMode: values.deploymentMode,
      status: values.status,
      timeZone: values.timeZone,
      dataRegion: values.dataRegion,
      updatedAt: values.updatedAt,
    },
  });
  await persistOnboarding(actor, tenantId, environmentId);
}

export async function saveKafka(actor: RuntimeActor, payload: Record<string, unknown>) {
  rejectEmbeddedSecrets(payload);
  const environment = (await getDb().select().from(tenantEnvironments).where(eq(tenantEnvironments.environmentId, DEFAULT_ENVIRONMENT_ID)).limit(1))[0];
  if (!environment) throw new ControlPlaneError("ORGANIZATION_SETUP_REQUIRED", 409);
  const securityProtocol = payload.securityProtocol;
  if (securityProtocol !== "SASL_SSL" && securityProtocol !== "SSL" && securityProtocol !== "PLAINTEXT") {
    throw new ControlPlaneError("KAFKA_SECURITY_PROTOCOL_INVALID", 400);
  }
  if (environment.deploymentMode === "production" && securityProtocol === "PLAINTEXT") {
    throw new ControlPlaneError("PLAINTEXT_BLOCKED_IN_PRODUCTION", 400);
  }
  const secretRef = safeText(payload.secretRef, "SECRET_REF", 120);
  if (!/^binding:[A-Z][A-Z0-9_]{2,80}$/.test(secretRef)) {
    throw new ControlPlaneError("SECRET_REFERENCE_MUST_USE_RUNTIME_BINDING", 400);
  }
  const topics = parseTopics(payload.topicMappings);
  const timestamp = now();
  const values = {
    connectionId: `CONN-KAFKA-${DEFAULT_ENVIRONMENT_ID}`,
    tenantId: DEFAULT_TENANT,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    kind: "kafka-bridge" as const,
    displayName: safeText(payload.displayName, "CONNECTION_NAME", 120),
    endpointUrl: safeUrl(payload.bridgeUrl),
    clusterAlias: safeText(payload.clusterAlias, "CLUSTER_ALIAS", 120),
    securityProtocol,
    secretRef,
    consumerGroup: safeText(payload.consumerGroup, "CONSUMER_GROUP", 180),
    topicMappingsJson: JSON.stringify(topics),
    status: "draft" as const,
    lastTestedAt: null,
    lastTestResultJson: null,
    configurationVersion: BASE_CONFIGURATION_VERSION,
    updatedBy: actor.email,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await getDb().insert(integrationConnections).values(values).onConflictDoUpdate({
    target: integrationConnections.connectionId,
    set: { ...values, createdAt: undefined },
  });
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}

function bridgeBinding(secretRef: string) {
  const bindingName = secretRef.replace(/^binding:/, "");
  const runtimeEnvironment = env as unknown as Record<string, unknown>;
  const value = runtimeEnvironment[bindingName];
  return typeof value === "string" && value.length >= 24 ? value : null;
}

export async function testKafka(actor: RuntimeActor) {
  const db = getDb();
  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.connectionId, `CONN-KAFKA-${DEFAULT_ENVIRONMENT_ID}`)).limit(1);
  if (!connection) throw new ControlPlaneError("KAFKA_CONNECTION_NOT_FOUND", 404);
  const topics = JSON.parse(connection.topicMappingsJson) as KafkaBridgeConfiguration["topicMappings"];
  const url = new URL(connection.endpointUrl);
  const checks = [
    { name: "HTTPS control-plane boundary", passed: url.protocol === "https:", observed: url.origin },
    { name: "Secret stored by reference", passed: /^binding:[A-Z][A-Z0-9_]+$/.test(connection.secretRef), observed: connection.secretRef },
    { name: "Inbound canonical event topic", passed: topics.some((topic) => topic.direction === "inbound" && topic.contract.startsWith("canonical-event@")), observed: `${topics.length} topic mappings` },
    { name: "Outbound command acknowledgement loop", passed: topics.some((topic) => topic.contract.startsWith("command-ack@")), observed: topics.map((topic) => topic.contract).join(", ") },
    { name: "Consumer group is isolated", passed: connection.consumerGroup.length >= 8, observed: connection.consumerGroup },
  ];
  let mode: "contract-only" | "live-bridge" = "contract-only";
  let status: "contract-verified" | "verified" | "error" = checks.every((check) => check.passed) ? "contract-verified" : "error";
  let summary = "Bridge contract passed. The reference URL was not contacted and no broker connectivity is claimed.";
  const token = bridgeBinding(connection.secretRef);
  const isReferenceHost = url.hostname.endsWith(".example");
  if (!isReferenceHost && !token) {
    checks.push({ name: "Bridge secret binding resolved", passed: false, observed: `${connection.secretRef} is unavailable to the server runtime` });
    status = "error";
    summary = "The bridge URL is live-shaped, but its secret binding is unavailable; no network claim was made.";
  } else if (!isReferenceHost && token && checks.every((check) => check.passed)) {
    try {
      const healthUrl = new URL("/healthz", url);
      const response = await fetch(healthUrl, {
        headers: { authorization: `Bearer ${token}`, "x-renal-control-plane-probe": "v1" },
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json() as Record<string, unknown>;
      const healthy = response.ok && body.status === "healthy" && body.kafka === "connected";
      checks.push({ name: "Live bridge health", passed: healthy, observed: healthy ? "authenticated bridge and broker connected" : `HTTP ${response.status}` });
      mode = "live-bridge";
      status = healthy ? "verified" : "error";
      summary = healthy ? "Authenticated HTTPS bridge and downstream Kafka broker reported healthy." : "The bridge responded but did not prove downstream Kafka connectivity.";
    } catch (error) {
      checks.push({ name: "Live bridge health", passed: false, observed: error instanceof Error ? error.message : "bridge request failed" });
      mode = "live-bridge";
      status = "error";
      summary = "The live bridge probe failed; configuration was not promoted.";
    }
  }
  const testedAt = now();
  await db.update(integrationConnections).set({
    status,
    lastTestedAt: testedAt,
    lastTestResultJson: JSON.stringify({ mode, summary, checks }),
    updatedBy: actor.email,
    updatedAt: testedAt,
  }).where(eq(integrationConnections.connectionId, connection.connectionId));
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}

async function ensureDraftRelease(actor: RuntimeActor) {
  const db = getDb();
  const [draft] = await db.select().from(tenantConfigurationReleases).where(and(
    eq(tenantConfigurationReleases.tenantId, DEFAULT_TENANT),
    eq(tenantConfigurationReleases.environmentId, DEFAULT_ENVIRONMENT_ID),
    eq(tenantConfigurationReleases.status, "draft"),
  )).orderBy(desc(tenantConfigurationReleases.createdAt)).limit(1);
  if (draft) return draft;
  const [active] = await db.select().from(tenantConfigurationReleases).where(and(
    eq(tenantConfigurationReleases.tenantId, DEFAULT_TENANT),
    eq(tenantConfigurationReleases.environmentId, DEFAULT_ENVIRONMENT_ID),
    eq(tenantConfigurationReleases.status, "active"),
  )).orderBy(desc(tenantConfigurationReleases.activatedAt)).limit(1);
  const releaseId = `REL-${crypto.randomUUID()}`;
  const version = `renal-config-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${releaseId.slice(-6).toLowerCase()}`;
  const release: typeof tenantConfigurationReleases.$inferInsert = {
    releaseId,
    tenantId: DEFAULT_TENANT,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    version,
    status: "draft",
    baseVersion: active?.version ?? BASE_CONFIGURATION_VERSION,
    rollbackVersion: active?.version ?? BASE_CONFIGURATION_VERSION,
    changeSummary: "Agent configuration change set",
    contentHash: await hashJson({ version, state: "draft" }),
    createdBy: actor.email,
    validatedBy: null,
    activatedBy: null,
    createdAt: now(),
    validatedAt: null,
    activatedAt: null,
  };
  await db.insert(tenantConfigurationReleases).values(release);
  if (active) {
    const activeObjects = await db.select().from(configurationObjects).where(eq(configurationObjects.releaseId, active.releaseId));
    for (const object of activeObjects) {
      await db.insert(configurationObjects).values({
        ...object,
        objectId: `OBJ-${crypto.randomUUID()}`,
        releaseId,
        createdBy: actor.email,
        createdAt: now(),
        updatedAt: now(),
      });
    }
  }
  return release as ReleaseRow;
}

export async function saveAgent(actor: RuntimeActor, value: unknown) {
  rejectEmbeddedSecrets(value);
  const agent = value as AgentConfiguration;
  const baseAgents = (await effectiveAgentManifests(DEFAULT_TENANT)).map(agentConfigurationFromManifest);
  if (!agent || !baseAgents.some((candidate) => candidate.id === agent.id)) throw new ControlPlaneError("AGENT_NOT_FOUND", 404);
  if (!Array.isArray(agent.inputs) || !Array.isArray(agent.outputs) || !Array.isArray(agent.allowedActions)) {
    throw new ControlPlaneError("AGENT_CONTRACT_ARRAYS_REQUIRED", 400);
  }
  const release = await ensureDraftRelease(actor);
  const contentHash = await hashJson(agent);
  const db = getDb();
  const [existing] = await db.select().from(configurationObjects).where(and(
    eq(configurationObjects.releaseId, release.releaseId),
    eq(configurationObjects.objectType, "agent"),
    eq(configurationObjects.objectKey, agent.id),
  )).limit(1);
  const values = {
    objectId: existing?.objectId ?? `OBJ-${crypto.randomUUID()}`,
    tenantId: DEFAULT_TENANT,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    releaseId: release.releaseId,
    objectType: "agent" as const,
    objectKey: agent.id,
    schemaVersion: "agent-configuration@1.0.0",
    payloadJson: JSON.stringify(agent),
    contentHash,
    enabled: Boolean(agent.enabled),
    createdBy: actor.email,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  if (existing) await db.update(configurationObjects).set(values).where(eq(configurationObjects.objectId, existing.objectId));
  else await db.insert(configurationObjects).values(values);
  const allObjects = await db.select({ objectKey: configurationObjects.objectKey, contentHash: configurationObjects.contentHash }).from(configurationObjects).where(eq(configurationObjects.releaseId, release.releaseId));
  await db.update(tenantConfigurationReleases).set({
    status: "draft",
    contentHash: await hashJson(allObjects),
    changeSummary: `${agent.name} manifest updated through Admin Console`,
    validatedAt: null,
    validatedBy: null,
  }).where(eq(tenantConfigurationReleases.releaseId, release.releaseId));
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}

export async function savePolicy(actor: RuntimeActor, value: unknown) {
  rejectEmbeddedSecrets(value);
  const policy = value as RuntimePolicyConfiguration;
  if (!policy || typeof policy !== "object") throw new ControlPlaneError("POLICY_CONFIGURATION_REQUIRED", 400);
  const release = await ensureDraftRelease(actor);
  const contentHash = await hashJson(policy);
  const db = getDb();
  const [existing] = await db.select().from(configurationObjects).where(and(
    eq(configurationObjects.releaseId, release.releaseId),
    eq(configurationObjects.objectType, "policy"),
    eq(configurationObjects.objectKey, "action-boundary"),
  )).limit(1);
  const values = {
    objectId: existing?.objectId ?? `OBJ-${crypto.randomUUID()}`,
    tenantId: DEFAULT_TENANT,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    releaseId: release.releaseId,
    objectType: "policy" as const,
    objectKey: "action-boundary",
    schemaVersion: "runtime-policy@1.0.0",
    payloadJson: JSON.stringify(policy),
    contentHash,
    enabled: true,
    createdBy: actor.email,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  if (existing) await db.update(configurationObjects).set(values).where(eq(configurationObjects.objectId, existing.objectId));
  else await db.insert(configurationObjects).values(values);
  const allObjects = await db.select({ objectKey: configurationObjects.objectKey, contentHash: configurationObjects.contentHash }).from(configurationObjects).where(eq(configurationObjects.releaseId, release.releaseId));
  await db.update(tenantConfigurationReleases).set({
    status: "draft",
    contentHash: await hashJson(allObjects),
    changeSummary: `Runtime policy threshold updated to ${policy.escalationThresholdBasisPoints / 100}%`,
    validatedAt: null,
    validatedBy: null,
  }).where(eq(tenantConfigurationReleases.releaseId, release.releaseId));
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}

function suiteResult(
  suite: ConfigurationValidationView["suite"],
  checks: ConfigurationValidationView["checks"],
) {
  const passed = checks.every((check) => check.passed);
  return { suite, checks, passed, scoreBasisPoints: Math.round((checks.filter((check) => check.passed).length / Math.max(1, checks.length)) * 10000) };
}

export async function validateRelease(actor: RuntimeActor, requestedReleaseId?: unknown) {
  const db = getDb();
  const releaseId = typeof requestedReleaseId === "string" ? requestedReleaseId : undefined;
  const releases = await db.select().from(tenantConfigurationReleases).where(and(
    eq(tenantConfigurationReleases.tenantId, DEFAULT_TENANT),
    eq(tenantConfigurationReleases.environmentId, DEFAULT_ENVIRONMENT_ID),
  )).orderBy(desc(tenantConfigurationReleases.createdAt));
  const release = releaseId ? releases.find((item) => item.releaseId === releaseId) : releases.find((item) => item.status === "draft");
  if (!release) throw new ControlPlaneError("CONFIGURATION_RELEASE_NOT_FOUND", 404);
  if (release.status !== "draft") throw new ControlPlaneError("ONLY_DRAFT_RELEASES_CAN_BE_VALIDATED", 409);
  const rows = await loadRows(DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
  const agents = await workingAgents(DEFAULT_TENANT, rows);
  const policy = await workingPolicy(DEFAULT_TENANT, rows);
  const agentChecks = agents.flatMap((agent) => validateAgentConfiguration(agent).checks.map((check) => ({ ...check, name: `${agent.id}: ${check.name}` })));
  const policyChecks = validateRuntimePolicy(policy).checks.map((check) => ({ ...check, name: `action-boundary: ${check.name}` }));
  const schema = suiteResult("schema", [...agentChecks, ...policyChecks]);
  const green = suiteResult("green", [
    { name: "Every enabled agent has a bounded proposal allowlist", passed: agents.filter((agent) => agent.enabled).every((agent) => agent.allowedActions.length > 0), observed: `${agents.filter((agent) => agent.enabled).length} enabled agents` },
    { name: "All agents preserve human kill switches", passed: agents.every((agent) => agent.killSwitchAvailable), observed: `${agents.filter((agent) => agent.killSwitchAvailable).length}/${agents.length}` },
    { name: "No model can own an external write", passed: agents.every((agent) => agent.allowedActions.every((action) => !/submit-live|write-emr|change-order|prescrib/i.test(action))), observed: "proposal-only action vocabulary" },
    { name: "Runtime policy defaults to block", passed: policy.defaultDecision === "block" && policy.externalWritesEnabled === false, observed: `${policy.defaultDecision} · writes ${policy.externalWritesEnabled}` },
  ]);
  const redTeamResults = [];
  for (let index = 1; index <= 8; index += 1) redTeamResults.push(await runRuntimeRedTeam(`rt-${String(index).padStart(3, "0")}`));
  const red = suiteResult("red", redTeamResults.flatMap((result) => result.checks.map((check) => ({ ...check, name: `${result.scenarioId}: ${check.name}` }))));
  const kafka = kafkaView(rows.connection);
  const integration = suiteResult("integration", [
    { name: "Kafka bridge contract verified", passed: kafka.status === "contract-verified" || kafka.status === "verified" || kafka.status === "active", observed: `${kafka.status} · ${kafka.testMode}` },
    { name: "Canonical input and acknowledgement topics mapped", passed: kafka.topicMappings.some((item) => item.contract.startsWith("canonical-event@")) && kafka.topicMappings.some((item) => item.contract.startsWith("command-ack@")), observed: `${kafka.topicMappings.length} topic mappings` },
    { name: "No raw integration secret persisted", passed: kafka.secretRef.startsWith("binding:"), observed: kafka.secretRef },
  ]);
  const productionNeedsLive = rows.environment?.deploymentMode === "production";
  const promotion = suiteResult("promotion", [
    { name: "Environment-specific bridge gate", passed: !productionNeedsLive || kafka.status === "verified" || kafka.status === "active", observed: productionNeedsLive ? `production requires live verification; ${kafka.status}` : "reference environment accepts contract verification" },
    { name: "Rollback target pinned", passed: Boolean(release.rollbackVersion), observed: release.rollbackVersion ?? "missing" },
    { name: "Configuration is content addressed", passed: /^[a-f0-9]{64}$/.test(release.contentHash), observed: release.contentHash.slice(0, 16) },
  ]);
  const suites = [schema, green, red, integration, promotion];
  const validatedAt = now();
  for (const suite of suites) {
    const validationId = `VAL-${crypto.randomUUID()}`;
    const evidenceHash = await hashJson({ releaseId: release.releaseId, suite });
    await db.insert(configurationValidations).values({
      validationId,
      tenantId: DEFAULT_TENANT,
      environmentId: DEFAULT_ENVIRONMENT_ID,
      releaseId: release.releaseId,
      suite: suite.suite,
      status: suite.passed ? "passed" : "failed",
      scoreBasisPoints: suite.scoreBasisPoints,
      checksJson: JSON.stringify(suite.checks),
      evidenceHash,
      runBy: actor.email,
      runAt: validatedAt,
    });
  }
  const passed = suites.every((suite) => suite.passed);
  await db.update(tenantConfigurationReleases).set({
    status: passed ? "validated" : "blocked",
    validatedBy: actor.email,
    validatedAt,
  }).where(eq(tenantConfigurationReleases.releaseId, release.releaseId));
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}

export async function activateRelease(actor: RuntimeActor, requestedReleaseId?: unknown) {
  const db = getDb();
  const releaseId = typeof requestedReleaseId === "string" ? requestedReleaseId : undefined;
  const releases = await db.select().from(tenantConfigurationReleases).where(and(
    eq(tenantConfigurationReleases.tenantId, DEFAULT_TENANT),
    eq(tenantConfigurationReleases.environmentId, DEFAULT_ENVIRONMENT_ID),
  )).orderBy(desc(tenantConfigurationReleases.createdAt));
  const release = releaseId ? releases.find((item) => item.releaseId === releaseId) : releases.find((item) => item.status === "validated");
  if (!release) throw new ControlPlaneError("VALIDATED_CONFIGURATION_RELEASE_NOT_FOUND", 404);
  if (release.status !== "validated") throw new ControlPlaneError("RELEASE_MUST_PASS_ALL_GATES", 409);
  const [environment] = await db.select().from(tenantEnvironments).where(eq(tenantEnvironments.environmentId, DEFAULT_ENVIRONMENT_ID)).limit(1);
  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.connectionId, `CONN-KAFKA-${DEFAULT_ENVIRONMENT_ID}`)).limit(1);
  if (environment?.deploymentMode === "production" && connection?.status !== "verified" && connection?.status !== "active") {
    throw new ControlPlaneError("LIVE_KAFKA_VERIFICATION_REQUIRED", 409);
  }
  const activatedAt = now();
  for (const current of releases.filter((item) => item.status === "active")) {
    await db.update(tenantConfigurationReleases).set({ status: "retired" }).where(eq(tenantConfigurationReleases.releaseId, current.releaseId));
  }
  await db.update(tenantConfigurationReleases).set({
    status: "active",
    activatedBy: actor.email,
    activatedAt,
  }).where(eq(tenantConfigurationReleases.releaseId, release.releaseId));
  await db.update(tenantEnvironments).set({ status: "active", updatedAt: activatedAt }).where(eq(tenantEnvironments.environmentId, DEFAULT_ENVIRONMENT_ID));
  if (connection?.status === "verified") await db.update(integrationConnections).set({ status: "active", configurationVersion: release.version, updatedAt: activatedAt }).where(eq(integrationConnections.connectionId, connection.connectionId));
  await persistOnboarding(actor, DEFAULT_TENANT, DEFAULT_ENVIRONMENT_ID);
}
