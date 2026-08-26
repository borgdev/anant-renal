import type { NavigationId } from "../types";
import type { WorkflowDetail } from "../workflow-detail";

export type WorkItemReference = {
  entityId: string;
  entityType: string;
  target?: NavigationId;
  requestedRole?: string;
};

export type WorkItemContextResponse = {
  detail: WorkflowDetail;
};

export type AgentCategory = "ai-agent" | "deterministic" | "optimization" | "hybrid";

export type AgentView = {
  id: string;
  enabled: boolean;
  name: string;
  version: string;
  mode: string;
  category: AgentCategory;
  description: string;
  domains: string[];
  ownerRoles: string[];
  inputs: string[];
  outputs: string[];
  allowedActions: string[];
  approvalClass: "A" | "B" | "C" | "D";
  evaluationGateBasisPoints: number;
  killSwitchAvailable: boolean;
  dataBoundary: string;
  memoryBoundary: string;
  runtime: {
    status: "healthy" | "watch" | "idle";
    executions: number;
    completed: number;
    failed: number;
    abstained: number;
    averageLatencyMs: number;
    costMicrounits: number;
    lastTraceId: string | null;
  };
};

export type AgentMessage = {
  id: string;
  time: string;
  from: string;
  to: string;
  kind: "signal" | "execution" | "proposal" | "insight" | "policy";
  summary: string;
  status: "accepted" | "completed" | "proposed" | "review" | "blocked";
  traceId: string | null;
  episodeId: string | null;
};

export type AgentOperationsSnapshot = {
  generatedAt: string;
  configurationVersion: string;
  policyVersion: string;
  runtimeStatus: "active" | "empty";
  agents: AgentView[];
  messages: AgentMessage[];
  totals: {
    agents: number;
    aiAgents: number;
    deterministic: number;
    optimization: number;
    executions: number;
    proposals: number;
    conflicts: number;
    costMicrounits: number;
  };
  boundary: {
    browserAuthority: "none";
    agentAuthority: "proposal-only";
    policyDefault: "block";
    externalWritesEnabled: boolean;
    transport: string;
  };
};

export type AgentConfiguration = {
  id: string;
  name: string;
  version: string;
  mode: string;
  inputs: string[];
  outputs: string[];
  allowedActions: string[];
  approvalClass: "A" | "B" | "C" | "D";
  evaluationGateBasisPoints: number;
  killSwitchAvailable: boolean;
  enabled: boolean;
};

export type RuntimePolicyConfiguration = {
  version: string;
  defaultDecision: "block";
  escalationThresholdBasisPoints: number;
  minThresholdBasisPoints: number;
  maxThresholdBasisPoints: number;
  externalWritesEnabled: false;
};

export type OnboardingStepId =
  | "organization"
  | "identity"
  | "kafka"
  | "adapters"
  | "agents"
  | "cms"
  | "validate"
  | "activate";

export type OnboardingStep = {
  id: OnboardingStepId;
  label: string;
  detail: string;
  status: "complete" | "current" | "pending" | "blocked";
};

export type KafkaBridgeConfiguration = {
  connectionId: string | null;
  displayName: string;
  bridgeUrl: string;
  clusterAlias: string;
  securityProtocol: "SASL_SSL" | "SSL" | "PLAINTEXT";
  secretRef: string;
  consumerGroup: string;
  topicMappings: Array<{ direction: "inbound" | "outbound"; topic: string; contract: string }>;
  status: "not-configured" | "draft" | "contract-verified" | "verified" | "active" | "error";
  lastTestedAt: string | null;
  testMode: "not-run" | "contract-only" | "live-bridge";
  testSummary: string;
};

export type ConfigurationReleaseView = {
  releaseId: string;
  version: string;
  status: "draft" | "validated" | "active" | "retired" | "blocked";
  changeSummary: string;
  contentHash: string;
  objectCount: number;
  createdBy: string;
  createdAt: string;
  validatedAt: string | null;
  activatedAt: string | null;
};

export type ConfigurationValidationView = {
  validationId: string;
  releaseId: string;
  suite: "schema" | "green" | "red" | "integration" | "promotion";
  status: "passed" | "failed" | "blocked";
  scoreBasisPoints: number;
  checks: Array<{ name: string; passed: boolean; observed: string }>;
  evidenceHash: string;
  runAt: string;
};

export type AdminConsoleSnapshot = {
  generatedAt: string;
  tenant: {
    tenantId: string;
    environmentId: string;
    displayName: string;
    environmentName: string;
    deploymentMode: "reference" | "non-production" | "production";
    timeZone: string;
    dataRegion: string;
    status: "onboarding" | "ready" | "active" | "blocked";
    persisted: boolean;
  };
  onboarding: {
    status: "not-started" | "in-progress" | "ready" | "active" | "blocked";
    completionBasisPoints: number;
    currentStep: OnboardingStepId;
    steps: OnboardingStep[];
  };
  kafka: KafkaBridgeConfiguration;
  agents: AgentConfiguration[];
  policy: RuntimePolicyConfiguration;
  releases: ConfigurationReleaseView[];
  validations: ConfigurationValidationView[];
  activeConfigurationVersion: string;
  activation: {
    runtimeEffect: "hot-reload";
    codeRedeployRequired: false;
    externalWritesEnabled: false;
    productionGate: string;
  };
};
