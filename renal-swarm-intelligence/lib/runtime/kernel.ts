import runtimePolicy from "../../config/runtime-policy.json";
import type { EffectiveAgentManifest } from "../server/configuration-repository";
import type { ActionClass, CanonicalEvent, CellProposal, RuntimeInsight, RuntimeNba, RuntimeRole } from "./types";

type Rule = {
  agentId: string;
  matches: (eventType: string) => boolean;
  proposal: (event: CanonicalEvent) => CellProposal;
};

const rules: Rule[] = [
  { agentId: "transition-cell", matches: (type) => type === "adt.discharge.v2", proposal: () => proposal("transition-cell", "transition.gap", "Discharge is recorded but the next treatment is not confirmed.", 9900, "propose-treatment-confirmation", "B", "fa") },
  { agentId: "continuity-cell", matches: (type) => type === "adt.discharge.v2" || type === "staffing.coverage.changed.v1", proposal: (event) => proposal("continuity-cell", "continuity.risk", event.eventType.startsWith("staffing") ? "Coverage gaps expose 43 scheduled treatments." : "A treatment break is likely without service coordination.", 9600, "create-coordinator-task", "B", "rod", "continuity-plan") },
  { agentId: "assessment-cell", matches: (type) => type === "assessment.response.v1", proposal: () => proposal("assessment-cell", "assessment.fact-candidate", "Exact patient answer supports a confirmed Tuesday transportation barrier.", 9600, "request-human-confirmation", "C", "fa") },
  { agentId: "capacity-cell", matches: (type) => type === "facility.capacity.changed.v2" || type === "staffing.coverage.changed.v1" || type === "machine.maintenance.signal.v1", proposal: (event) => proposal("capacity-cell", "capacity.option", event.eventType.startsWith("machine") ? "Sequence maintenance inside three safe windows." : "A 14:30 chair remains compatible with machine and staffing constraints.", 9800, "propose-schedule-plan", "B", "rod", "chair-capacity") },
  { agentId: "access-cell", matches: (type) => type === "quality.measure.changed.v1", proposal: () => proposal("access-cell", "access.review-needed", "Catheter variance and patient-reported tenderness require a nurse review.", 9700, "create-nurse-review", "C", "medical") },
  { agentId: "cms-cell", matches: (type) => type === "cms.submission.gap.v1", proposal: () => proposal("cms-cell", "submission.gap", "Forty-nine denominator rows need mapping reconciliation before packaging.", 10000, "create-data-quality-task", "B", "quality", "mapping-variance") },
  { agentId: "workforce-cell", matches: (type) => type === "staffing.coverage.changed.v1", proposal: () => proposal("workforce-cell", "workforce.coverage-option", "Seven credential-compatible float staff can close the highest-risk gaps.", 9700, "propose-coverage-option", "B", "rod", "continuity-plan") },
  { agentId: "demand-cell", matches: (type) => type === "referral.received.v1" || type === "facility.capacity.changed.v2", proposal: () => proposal("demand-cell", "demand.capacity-option", "Nine starts fit the available market capacity if maintenance windows remain protected.", 9500, "propose-demand-plan", "B", "dvp", "chair-capacity") },
  { agentId: "quality-cell", matches: (type) => type === "quality.measure.changed.v1", proposal: () => proposal("quality-cell", "quality.review-needed", "Regional variation crossed the configured improvement-review threshold.", 9800, "create-quality-review", "C", "quality") },
  { agentId: "experience-cell", matches: (type) => type === "experience.response.v1" || type === "assessment.response.v1", proposal: () => proposal("experience-cell", "equity.review-needed", "Transportation and schedule barriers form a reviewable experience cluster.", 9400, "create-experience-followup", "C", "fa") },
  { agentId: "revenue-cell", matches: (type) => type === "claim.status.changed.v2", proposal: () => proposal("revenue-cell", "revenue.review-needed", "A mapping release correlates with $184K of clean-claim variance.", 9900, "create-revenue-cycle-review", "B", "finance", "mapping-variance") },
  { agentId: "asset-cell", matches: (type) => type === "machine.maintenance.signal.v1", proposal: () => proposal("asset-cell", "maintenance.option", "Three preventive-maintenance windows protect 18 chair-hours.", 9700, "draft-maintenance-work-order", "B", "biomed", "chair-capacity") },
];

function proposal(agentId: string, proposalType: string, summary: string, confidenceBasisPoints: number, action: string, actionClass: ActionClass, ownerRole: RuntimeRole, conflictGroup?: string): CellProposal {
  return { agentId, proposalType, summary, confidenceBasisPoints, action, actionClass, ownerRole, conflictGroup };
}

export function validateCanonicalEvent(value: unknown): { ok: true; event: CanonicalEvent } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["event must be an object"] };
  const event = value as Partial<CanonicalEvent>;
  if (!event.eventId || typeof event.eventId !== "string") errors.push("eventId is required");
  if (!event.eventType || typeof event.eventType !== "string" || !/^[a-z][a-z0-9.-]+\.v[1-9][0-9]*$/.test(event.eventType)) errors.push("eventType must be versioned");
  if (!event.tenantId || typeof event.tenantId !== "string") errors.push("tenantId is required");
  if (!event.subject?.id || !event.subject?.type) errors.push("subject type and id are required");
  if (!event.validTime || Number.isNaN(Date.parse(event.validTime))) errors.push("validTime must be an ISO date-time");
  if (!event.recordedTime || Number.isNaN(Date.parse(event.recordedTime))) errors.push("recordedTime must be an ISO date-time");
  if (!event.source?.system || !event.source?.resource) errors.push("source system and resource are required");
  if (event.integrity?.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(event.integrity?.contentHash ?? "")) errors.push("sha256 integrity hash is required");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) errors.push("payload must be an object");
  return errors.length ? { ok: false, errors } : { ok: true, event: event as CanonicalEvent };
}

export function evaluateEligibleCells(event: CanonicalEvent, manifests?: EffectiveAgentManifest[]): CellProposal[] {
  const eventContract = event.eventType.replace(/\.v\d+$/, "");
  const configured = manifests ? new Map(manifests.map((manifest) => [manifest.id, manifest])) : null;
  return rules
    .filter((rule) => {
      if (!rule.matches(event.eventType)) return false;
      if (!configured) return true;
      const manifest = configured.get(rule.agentId);
      return Boolean(manifest?.enabled && manifest.inputs.includes(eventContract));
    })
    .map((rule) => rule.proposal(event));
}

export function authorizedForAction(role: RuntimeRole, actionClass: ActionClass, ownerRole: RuntimeRole): { allowed: boolean; reasons: string[] } {
  if (actionClass === "A") return { allowed: true, reasons: ["Class A read-only action"] };
  if (actionClass === "D") return { allowed: false, reasons: ["Class D requires a dual-approval workflow and independently controlled source-system connector", "The reference runtime cannot satisfy that boundary"] };
  if (role === ownerRole) return { allowed: true, reasons: [`${role} matches the configured owner role`] };
  if (actionClass === "B") {
    const serviceOwners: RuntimeRole[] = ["fa", "rod", "dvp"];
    const serviceReviewers: RuntimeRole[] = ["evp", "dvp", "rod", "fa"];
    if (serviceOwners.includes(ownerRole) && serviceReviewers.includes(role)) return { allowed: true, reasons: [`${role} is a configured service-coordination reviewer`] };
    if (["evp", "dvp"].includes(role) && ["finance", "biomed"].includes(ownerRole)) return { allowed: true, reasons: [`${role} has portfolio authority for the ${ownerRole} review domain`] };
  }
  if (actionClass === "C" && ["medical", "quality", "fa"].includes(role)) return { allowed: true, reasons: [`${role} is a configured clinical-review task reviewer; no clinical change is authorized`] };
  return { allowed: false, reasons: [`${role} is not authorized for Class ${actionClass} owned by ${ownerRole}`] };
}

export function derivePortfolio(events: CanonicalEvent[], thresholdBasisPoints = runtimePolicy.escalationThresholdBasisPoints): { insights: RuntimeInsight[]; nbas: RuntimeNba[]; conflicts: string[] } {
  const types = new Set(events.map((event) => event.eventType));
  const has = (...required: string[]) => required.every((type) => types.has(type));
  const insights: RuntimeInsight[] = [];
  const candidates: RuntimeNba[] = [];
  const conflicts: string[] = [];
  if (has("staffing.coverage.changed.v1", "facility.capacity.changed.v2")) {
    insights.push({ id: "SI-RUNTIME-401", title: "Weekend coverage can protect 43 treatments", summary: "Workforce, capacity and continuity cells converged on a credential-compatible cross-facility plan.", scopeId: "region-middle-tennessee", confidenceBasisPoints: 9600, state: "human review", agentIds: ["workforce-cell", "capacity-cell", "continuity-cell"], conflicts: [] });
    candidates.push(nba("NBA-RUNTIME-2201", 1, "Protect 43 weekend treatments", "Continuity + workforce", "region-middle-tennessee", "rod", "2026-08-21T15:00:00.000Z", "43 treatments", 9600, "B", 18, ["workforce-cell", "capacity-cell", "continuity-cell"], ["evp", "dvp", "rod"], thresholdBasisPoints));
  }
  if (has("adt.discharge.v2", "assessment.response.v1", "facility.capacity.changed.v2")) {
    insights.push({ id: "SI-RUNTIME-402", episodeId: "OUT-RUNTIME-1042", title: "Discharge, transport and capacity evidence converge", summary: "Exact assessment evidence and a policy-compatible chair support a bounded continuity plan.", scopeId: "facility-franklin", confidenceBasisPoints: 9600, state: "FA review", agentIds: ["transition-cell", "assessment-cell", "continuity-cell", "capacity-cell"], conflicts: [] });
    candidates.push(nba("NBA-RUNTIME-2194", 2, "Confirm chair and transportation", "Post-discharge continuity", "facility-franklin", "fa", "2026-08-21T13:00:00.000Z", "1 treatment", 9600, "B", 9, ["transition-cell", "continuity-cell", "assessment-cell", "capacity-cell"], ["rod", "fa", "medical"], thresholdBasisPoints, "OUT-RUNTIME-1042"));
  }
  if (has("quality.measure.changed.v1")) {
    insights.push({ id: "SI-RUNTIME-403", title: "Access surveillance crossed a governed review boundary", summary: "Measure variance and patient-authored evidence support a nurse-led review without inferring diagnosis.", scopeId: "region-middle-tennessee", confidenceBasisPoints: 9400, state: "clinical review", agentIds: ["quality-cell", "access-cell", "assessment-cell"], conflicts: [] });
    candidates.push(nba("NBA-RUNTIME-2189", 3, "Open catheter reduction review", "Clinical quality", "region-middle-tennessee", "quality", "2026-08-28T12:00:00.000Z", "31 patients", 9400, "C", 22, ["quality-cell", "access-cell"], ["evp", "dvp", "rod", "medical", "quality"], thresholdBasisPoints));
  }
  if (has("claim.status.changed.v2", "cms.submission.gap.v1")) {
    insights.push({ id: "SI-RUNTIME-404", title: "One mapping release explains revenue and CMS gaps", summary: "Revenue and CMS cells independently traced both variances to fhir-r4.18.", scopeId: "division-southeast", confidenceBasisPoints: 9900, state: "data-owner review", agentIds: ["revenue-cell", "cms-cell"], conflicts: [] });
    candidates.push(nba("NBA-RUNTIME-2182", 4, "Resolve clean-claim mapping variance", "Revenue + regulatory integrity", "division-southeast", "finance", "2026-08-23T12:00:00.000Z", "$184K", 9900, "B", 28, ["revenue-cell", "cms-cell"], ["evp", "dvp", "finance", "quality"], thresholdBasisPoints));
  }
  if (has("machine.maintenance.signal.v1", "referral.received.v1")) {
    conflicts.push("Demand proposes nine starts while asset reliability protects three maintenance windows; capacity policy must sequence both.");
    insights.push({ id: "SI-RUNTIME-405", title: "Growth and maintenance proposals compete for chair capacity", summary: "The harness retained both proposals and marked the shared chair-capacity constraint for human arbitration.", scopeId: "market-nashville-south", confidenceBasisPoints: 9500, state: "conflict review", agentIds: ["demand-cell", "asset-cell", "capacity-cell"], conflicts: [...conflicts] });
  }
  return { insights, nbas: candidates, conflicts };
}

function nba(id: string, rank: number, title: string, outcome: string, scopeId: string, ownerRole: RuntimeRole, dueAt: string, valueLabel: string, confidenceBasisPoints: number, actionClass: ActionClass, evidenceCount: number, agentIds: string[], audience: RuntimeRole[], thresholdBasisPoints: number, episodeId?: string): RuntimeNba {
  const aboveThreshold = confidenceBasisPoints >= thresholdBasisPoints;
  return { id, episodeId, rank, title, outcome, scopeId, ownerRole, dueAt, valueLabel, confidenceBasisPoints, actionClass, evidenceCount, agentIds, audience, status: aboveThreshold ? "review" : "blocked", policyReasons: aboveThreshold ? [`Confidence ${confidenceBasisPoints} ≥ threshold ${thresholdBasisPoints}`, `Class ${actionClass} requires ${ownerRole} or delegated review`] : [`Confidence ${confidenceBasisPoints} < threshold ${thresholdBasisPoints}`] };
}

export function simulatePolicyReplay(
  events: CanonicalEvent[],
  thresholdBasisPoints: number,
  options: { minThresholdBasisPoints: number; maxThresholdBasisPoints: number; policyVersion: string } = {
    minThresholdBasisPoints: runtimePolicy.simulation.minThresholdBasisPoints,
    maxThresholdBasisPoints: runtimePolicy.simulation.maxThresholdBasisPoints,
    policyVersion: runtimePolicy.version,
  },
) {
  const bounded = Math.max(options.minThresholdBasisPoints, Math.min(options.maxThresholdBasisPoints, Math.round(thresholdBasisPoints)));
  const portfolio = derivePortfolio(events, bounded);
  const surfaced = portfolio.nbas.filter((action) => action.status !== "blocked");
  const treatmentsProtected = surfaced.reduce((total, action) => total + (action.valueLabel.includes("treatment") ? Number.parseInt(action.valueLabel, 10) || 0 : action.valueLabel.includes("patients") ? Math.round((Number.parseInt(action.valueLabel, 10) || 0) * 0.35) : 0), 0);
  const humanReviews = surfaced.reduce((total, action) => total + (action.actionClass === "D" ? 2 : 1), 0);
  const estimatedValueDollars = surfaced.reduce((total, action) => total + (action.valueLabel.startsWith("$") ? (Number.parseInt(action.valueLabel.replace(/[^0-9]/g, ""), 10) || 0) * 1000 : action.valueLabel.includes("treatment") ? (Number.parseInt(action.valueLabel, 10) || 0) * 1250 : action.valueLabel.includes("patients") ? (Number.parseInt(action.valueLabel, 10) || 0) * 900 : 0), 0);
  return { thresholdBasisPoints: bounded, eventsReplayed: events.length, episodesSurfaced: surfaced.length, treatmentsProtected, humanReviews, estimatedValueDollars, blockedActions: portfolio.nbas.length - surfaced.length, conflicts: portfolio.conflicts.length, policyVersion: options.policyVersion };
}

export function simulateFacilityPlan(events: CanonicalEvent[], input: { facilityId: string; station: number; proposedAt: string }) {
  const capacity = events.find((event) => event.eventType === "facility.capacity.changed.v2" && event.subject.id === input.facilityId);
  const preferences = events.filter((event) => event.eventType === "assessment.response.v1" && event.subject.id === "SYN-10042");
  const preferredAfter = preferences.map((event) => event.payload.preferredAfterLocal).find((value): value is string => typeof value === "string");
  const localTime = new Date(input.proposedAt).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit" });
  const checks: Array<{ id: string; label: string; passed: boolean; evidenceEventIds: string[]; detail?: string }> = [
    { id: "chair-machine", label: "Chair & machine", passed: capacity?.payload.machineReady === true && Number(capacity.payload.station) === input.station, evidenceEventIds: capacity ? [capacity.eventId] : [] },
    { id: "staff-ratio", label: "Staff ratio", passed: Number(capacity?.payload.staffRatioHeadroom ?? -1) >= 0.4, evidenceEventIds: capacity ? [capacity.eventId] : [] },
    { id: "patient-constraint", label: "Patient schedule constraint", passed: Boolean(preferredAfter && localTime >= preferredAfter), evidenceEventIds: preferences.filter((event) => event.payload.preferredAfterLocal).map((event) => event.eventId) },
    { id: "clinical-boundary", label: "Clinical boundary", passed: true, evidenceEventIds: [], detail: "Simulation changes no order, prescription or schedule." },
  ];
  return { feasible: checks.every((item) => item.passed), facilityId: input.facilityId, station: input.station, proposedAt: input.proposedAt, checks, runtimeEffect: false, configuration: runtimePolicy.version };
}
