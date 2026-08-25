import type { NavigationId } from "./types";

export type WorkflowTone = "neutral" | "mint" | "amber" | "red" | "blue" | "violet";
export type WorkflowStepState = "done" | "current" | "pending" | "blocked";

export type WorkflowDetail = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  tone?: WorkflowTone;
  owner: string;
  scope: string;
  due?: string;
  metrics?: Array<{ label: string; value: string; detail?: string }>;
  evidence?: Array<{ label: string; value: string; source?: string }>;
  activity?: Array<{ time: string; title: string; detail: string; state?: WorkflowStepState }>;
  steps?: Array<{ label: string; detail: string; state: WorkflowStepState }>;
  control?: string;
  primary?: { label: string; target: NavigationId };
  security?: {
    serverAssembled: true;
    role: string;
    scope: string;
    purpose: string;
    redactions: string[];
    policyVersion: string;
    configurationVersion: string;
    traceId: string;
  };
};

export type OpenWorkflowDetail = (detail: WorkflowDetail) => void;
