export type SubjectType = "patient" | "facility" | "cohort" | "submission";
export type ActionClass = "A" | "B" | "C" | "D";
export type RuntimeRole = "evp" | "dvp" | "rod" | "fa" | "medical" | "quality" | "finance" | "biomed";

export interface CanonicalEvent {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  tenantId: string;
  subject: { type: SubjectType; id: string };
  purpose: string;
  validTime: string;
  recordedTime: string;
  correlationId?: string;
  causationId?: string;
  source: { system: string; resource: string; version?: string };
  integrity: { algorithm: "sha256"; contentHash: string };
  classification?: string[];
  payload: Record<string, unknown>;
}

export interface ReplayEventSeed extends Omit<CanonicalEvent, "integrity"> {
  integrity?: CanonicalEvent["integrity"];
}

export interface CellProposal {
  agentId: string;
  proposalType: string;
  summary: string;
  confidenceBasisPoints: number;
  action: string;
  actionClass: ActionClass;
  ownerRole: RuntimeRole;
  conflictGroup?: string;
  abstentionReason?: string;
}

export interface RuntimeNba {
  id: string;
  episodeId?: string;
  rank: number;
  title: string;
  outcome: string;
  scopeId: string;
  ownerRole: RuntimeRole;
  dueAt: string;
  valueLabel: string;
  confidenceBasisPoints: number;
  actionClass: ActionClass;
  evidenceCount: number;
  agentIds: string[];
  audience: RuntimeRole[];
  status: "queued" | "review" | "blocked";
  policyReasons: string[];
}

export interface RuntimeInsight {
  id: string;
  episodeId?: string;
  title: string;
  summary: string;
  scopeId: string;
  confidenceBasisPoints: number;
  state: string;
  agentIds: string[];
  conflicts: string[];
}
