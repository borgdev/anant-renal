import { and, desc, eq } from "drizzle-orm";
import agentManifests from "../../config/agent-manifests.json";
import runtimePolicy from "../../config/runtime-policy.json";
import { getDb } from "../../db";
import {
  configurationObjects,
  tenantConfigurationReleases,
} from "../../db/schema";
import type {
  AgentConfiguration,
  RuntimePolicyConfiguration,
} from "../control-plane/contracts";

export const BASE_CONFIGURATION_VERSION = "renal-harness-2026.08.5";
export const DEFAULT_ENVIRONMENT_ID = "env-demo-reference";

export type EffectiveAgentManifest = {
  id: string;
  name: string;
  version: string;
  mode: string;
  inputs: string[];
  outputs: string[];
  allowedActions: string[];
  approvalClass: "A" | "B" | "C" | "D";
  evalGate: number;
  killSwitch: boolean;
  enabled: boolean;
};

const allowedClasses = new Set(["A", "B", "C", "D"]);
const forbiddenAutonomousActions = /prescrib|medication|clinical-order|submit-live|delete-record|autonomous/i;

function baseManifests(): EffectiveAgentManifest[] {
  return agentManifests.map((manifest) => ({
    ...manifest,
    approvalClass: manifest.approvalClass as EffectiveAgentManifest["approvalClass"],
    enabled: true,
  }));
}

function isMissingControlPlaneTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table") || message.includes("tenant_configuration_releases");
}

export function agentConfigurationFromManifest(manifest: EffectiveAgentManifest): AgentConfiguration {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    mode: manifest.mode,
    inputs: [...manifest.inputs],
    outputs: [...manifest.outputs],
    allowedActions: [...manifest.allowedActions],
    approvalClass: manifest.approvalClass,
    evaluationGateBasisPoints: Math.round(manifest.evalGate * 10000),
    killSwitchAvailable: manifest.killSwitch,
    enabled: manifest.enabled,
  };
}

export function manifestFromAgentConfiguration(agent: AgentConfiguration): EffectiveAgentManifest {
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    mode: agent.mode,
    inputs: [...agent.inputs],
    outputs: [...agent.outputs],
    allowedActions: [...agent.allowedActions],
    approvalClass: agent.approvalClass,
    evalGate: agent.evaluationGateBasisPoints / 10000,
    killSwitch: agent.killSwitchAvailable,
    enabled: agent.enabled,
  };
}

export function validateAgentConfiguration(agent: AgentConfiguration) {
  const checks = [
    { name: "Stable agent identifier", passed: /^[a-z][a-z0-9-]{2,80}$/.test(agent.id), observed: agent.id },
    { name: "Semantic version", passed: /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(agent.version), observed: agent.version },
    { name: "Bounded input contracts", passed: agent.inputs.length > 0 && agent.inputs.length <= 24 && agent.inputs.every((value) => /^[a-z][a-z0-9.-]+$/.test(value)), observed: `${agent.inputs.length} contracts` },
    { name: "Bounded output contracts", passed: agent.outputs.length > 0 && agent.outputs.length <= 16 && agent.outputs.every((value) => /^[a-z][a-z0-9.-]+$/.test(value)), observed: `${agent.outputs.length} contracts` },
    { name: "Proposal-only action allowlist", passed: agent.allowedActions.length > 0 && agent.allowedActions.every((value) => !forbiddenAutonomousActions.test(value)), observed: agent.allowedActions.join(", ") },
    { name: "Approval class", passed: allowedClasses.has(agent.approvalClass), observed: agent.approvalClass },
    { name: "Evaluation gate", passed: agent.evaluationGateBasisPoints >= 8000 && agent.evaluationGateBasisPoints <= 10000, observed: `${agent.evaluationGateBasisPoints / 100}%` },
    { name: "Kill switch available", passed: agent.killSwitchAvailable, observed: agent.killSwitchAvailable ? "available" : "missing" },
  ];
  return { checks, passed: checks.every((check) => check.passed) };
}

export function baseRuntimePolicy(): RuntimePolicyConfiguration {
  return {
    version: runtimePolicy.version,
    defaultDecision: "block",
    escalationThresholdBasisPoints: runtimePolicy.escalationThresholdBasisPoints,
    minThresholdBasisPoints: runtimePolicy.simulation.minThresholdBasisPoints,
    maxThresholdBasisPoints: runtimePolicy.simulation.maxThresholdBasisPoints,
    externalWritesEnabled: false,
  };
}

export function validateRuntimePolicy(policy: RuntimePolicyConfiguration) {
  const checks = [
    { name: "Versioned policy object", passed: /^[a-z][a-z0-9-]+@\d+\.\d+\.\d+$/.test(policy.version), observed: policy.version },
    { name: "Default deny", passed: policy.defaultDecision === "block", observed: policy.defaultDecision },
    { name: "Bounded escalation threshold", passed: Number.isInteger(policy.escalationThresholdBasisPoints) && policy.escalationThresholdBasisPoints >= policy.minThresholdBasisPoints && policy.escalationThresholdBasisPoints <= policy.maxThresholdBasisPoints, observed: `${policy.escalationThresholdBasisPoints / 100}%` },
    { name: "Simulation bounds", passed: policy.minThresholdBasisPoints >= 5000 && policy.maxThresholdBasisPoints <= 10000 && policy.minThresholdBasisPoints < policy.maxThresholdBasisPoints, observed: `${policy.minThresholdBasisPoints}-${policy.maxThresholdBasisPoints}` },
    { name: "External writes disabled", passed: policy.externalWritesEnabled === false, observed: String(policy.externalWritesEnabled) },
  ];
  return { checks, passed: checks.every((check) => check.passed) };
}

export async function activeConfigurationVersion(
  tenantId: string,
  environmentId = DEFAULT_ENVIRONMENT_ID,
) {
  try {
    const [active] = await getDb()
      .select()
      .from(tenantConfigurationReleases)
      .where(and(
        eq(tenantConfigurationReleases.tenantId, tenantId),
        eq(tenantConfigurationReleases.environmentId, environmentId),
        eq(tenantConfigurationReleases.status, "active"),
      ))
      .orderBy(desc(tenantConfigurationReleases.activatedAt))
      .limit(1);
    return active?.version ?? BASE_CONFIGURATION_VERSION;
  } catch (error) {
    if (isMissingControlPlaneTable(error)) return BASE_CONFIGURATION_VERSION;
    throw error;
  }
}

export async function effectiveAgentManifests(
  tenantId: string,
  environmentId = DEFAULT_ENVIRONMENT_ID,
): Promise<EffectiveAgentManifest[]> {
  const base = baseManifests();
  try {
    const [active] = await getDb()
      .select()
      .from(tenantConfigurationReleases)
      .where(and(
        eq(tenantConfigurationReleases.tenantId, tenantId),
        eq(tenantConfigurationReleases.environmentId, environmentId),
        eq(tenantConfigurationReleases.status, "active"),
      ))
      .orderBy(desc(tenantConfigurationReleases.activatedAt))
      .limit(1);
    if (!active) return base;

    const objects = await getDb()
      .select()
      .from(configurationObjects)
      .where(and(
        eq(configurationObjects.releaseId, active.releaseId),
        eq(configurationObjects.objectType, "agent"),
      ));
    const overrides = new Map<string, EffectiveAgentManifest>();
    for (const object of objects) {
      const parsed = JSON.parse(object.payloadJson) as AgentConfiguration;
      const validation = validateAgentConfiguration(parsed);
      if (!validation.passed || parsed.id !== object.objectKey) {
        throw new Error("ACTIVE_CONFIGURATION_INVALID");
      }
      overrides.set(parsed.id, manifestFromAgentConfiguration({ ...parsed, enabled: object.enabled }));
    }
    return base.map((manifest) => overrides.get(manifest.id) ?? manifest);
  } catch (error) {
    if (isMissingControlPlaneTable(error)) return base;
    throw error;
  }
}

export async function effectiveRuntimePolicy(
  tenantId: string,
  environmentId = DEFAULT_ENVIRONMENT_ID,
): Promise<RuntimePolicyConfiguration> {
  const base = baseRuntimePolicy();
  try {
    const [active] = await getDb()
      .select()
      .from(tenantConfigurationReleases)
      .where(and(
        eq(tenantConfigurationReleases.tenantId, tenantId),
        eq(tenantConfigurationReleases.environmentId, environmentId),
        eq(tenantConfigurationReleases.status, "active"),
      ))
      .orderBy(desc(tenantConfigurationReleases.activatedAt))
      .limit(1);
    if (!active) return base;
    const [object] = await getDb()
      .select()
      .from(configurationObjects)
      .where(and(
        eq(configurationObjects.releaseId, active.releaseId),
        eq(configurationObjects.objectType, "policy"),
        eq(configurationObjects.objectKey, "action-boundary"),
      ))
      .limit(1);
    if (!object) return base;
    const parsed = JSON.parse(object.payloadJson) as RuntimePolicyConfiguration;
    if (!validateRuntimePolicy(parsed).passed) throw new Error("ACTIVE_CONFIGURATION_INVALID");
    return parsed;
  } catch (error) {
    if (isMissingControlPlaneTable(error)) return base;
    throw error;
  }
}
