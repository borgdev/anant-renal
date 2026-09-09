export type NavigationId =
  | "my-work"
  | "ecosystem"
  | "agents"
  | "command"
  | "patient"
  | "anemia"
  | "intelligence"
  | "assessments"
  | "facility"
  | "cms"
  | "executive"
  | "assurance"
  | "admin"
  | "configuration";

export type OutcomeStatus = "new" | "review" | "ready" | "resolved";

export interface OutcomeEpisode {
  id: string;
  title: string;
  patient: string;
  patientId: string;
  facility: string;
  status: OutcomeStatus;
  urgency: "critical" | "high" | "watch";
  due: string;
  confidence: number;
  signals: string[];
  recommendation: string;
  owner: string;
  evidenceCount: number;
  actionClass: "A" | "B" | "C" | "D";
}

export interface TraceSpan {
  id: string;
  label: string;
  system: string;
  duration: string;
  status: "ok" | "review" | "blocked";
  detail: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "enterprise" | "division" | "region" | "facility" | "patient" | "assessment" | "signal" | "cluster" | "cell" | "policy" | "action" | "intervention" | "outcome" | "measure" | "source";
  x: number;
  y: number;
  z: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}
