import type { GraphEdge, GraphNode, OutcomeEpisode, TraceSpan } from "./types";
import publicBenchmarkSnapshot from "../config/public-benchmarks.json";

export const demoContext = {
  label: "Synthetic care environment",
  organization: "Riverbend Kidney Care",
  region: "Middle Tennessee",
  generatedAt: "2026-08-21T06:00:00Z",
  disclaimer:
    "All patient, treatment, staffing and operational records are synthetic. Regulatory sources and labeled public benchmarks are authoritative public data snapshots.",
};

export const outcomeEpisodes: OutcomeEpisode[] = [
  {
    id: "OUT-1042",
    title: "Post-discharge treatment continuity",
    patient: "Maya Ortiz",
    patientId: "SYN-10042",
    facility: "Riverbend Franklin",
    status: "review",
    urgency: "critical",
    due: "Resolve in 42 min",
    confidence: 0.96,
    signals: ["Discharged 07:14", "No confirmed chair", "Ride benefit expired"],
    recommendation: "Confirm the 14:30 chair and create a transportation task.",
    owner: "Care coordination",
    evidenceCount: 9,
    actionClass: "B",
  },
  {
    id: "OUT-1039",
    title: "Assessment-derived symptom review",
    patient: "James Carter",
    patientId: "SYN-10017",
    facility: "Riverbend Columbia",
    status: "new",
    urgency: "high",
    due: "Review before 11:10",
    confidence: 0.91,
    signals: ["Repeated post-treatment dizziness", "Three-assessment pattern"],
    recommendation: "Route the cited responses to the charge nurse for review.",
    owner: "Charge nurse",
    evidenceCount: 6,
    actionClass: "C",
  },
  {
    id: "OUT-1037",
    title: "Vascular access observation",
    patient: "Asha Patel",
    patientId: "SYN-10008",
    facility: "Riverbend Franklin",
    status: "ready",
    urgency: "high",
    due: "Ready for nurse review",
    confidence: 0.98,
    signals: ["Tenderness documented", "Catheter present", "No culture result"],
    recommendation: "Create a nurse assessment task; no autonomous diagnosis.",
    owner: "Infection prevention",
    evidenceCount: 7,
    actionClass: "C",
  },
  {
    id: "OUT-1034",
    title: "Phosphorus trajectory review",
    patient: "Daniel Brooks",
    patientId: "SYN-10031",
    facility: "Riverbend Murfreesboro",
    status: "new",
    urgency: "watch",
    due: "Review this week",
    confidence: 0.88,
    signals: ["Three-month upward trend", "Side effect in free text"],
    recommendation: "Prepare evidence for dietitian and clinician review.",
    owner: "Interdisciplinary team",
    evidenceCount: 8,
    actionClass: "C",
  },
];

export const patientTimeline = [
  { time: "07:14", type: "ADT", label: "Hospital discharge posted", source: "FHIR Encounter", state: "verified" },
  { time: "07:14", type: "Kafka", label: "adt.discharge received", source: "hospital.transition.v2", state: "verified" },
  { time: "07:15", type: "State", label: "Next treatment unconfirmed", source: "Temporal projection", state: "derived" },
  { time: "07:15", type: "Assessment", label: "Tuesday ride no longer available", source: "Question 14 · exact answer retained", state: "derived" },
  { time: "07:16", type: "Swarm", label: "Five cells submitted bounded proposals", source: "Cell registry", state: "derived" },
  { time: "07:17", type: "Harness", label: "One policy-compliant plan assembled", source: "Policy pack 4.2", state: "review" },
];

export const assessmentResponses = [
  {
    id: "AR-1401",
    question: "Can you reliably get to every treatment next week?",
    answer: "No. My daughter started night shift and cannot drive me on Tuesdays anymore.",
    format: "Free text",
    source: "Life & Treatment Check-in · v3.1",
    effective: "2026-08-18",
    extracted: [
      { concept: "Transportation barrier", confidence: 0.96, status: "human confirmed" },
      { concept: "Tuesday-specific constraint", confidence: 0.94, status: "human confirmed" },
    ],
  },
  {
    id: "AR-1402",
    question: "What is most important for your treatment schedule?",
    answer: "I need to keep my morning shift at work, so afternoons are easier.",
    format: "Free text",
    source: "Life goals · v2.0",
    effective: "2026-08-18",
    extracted: [
      { concept: "Employment goal", confidence: 0.93, status: "human confirmed" },
      { concept: "Afternoon preference", confidence: 0.97, status: "human confirmed" },
    ],
  },
  {
    id: "AR-1403",
    question: "How difficult was transportation this week?",
    answer: "4 / 5 — very difficult",
    format: "Structured scale",
    source: "Access barrier screen · v1.4",
    effective: "2026-08-18",
    extracted: [{ concept: "Transportation severity: 4", confidence: 1, status: "deterministic" }],
  },
];

export const publicBenchmarks = publicBenchmarkSnapshot.benchmarks.map((benchmark) => ({
  ...benchmark,
  period: publicBenchmarkSnapshot.period,
  facility: publicBenchmarkSnapshot.facility,
  city: publicBenchmarkSnapshot.city,
  state: publicBenchmarkSnapshot.state,
  ccn: publicBenchmarkSnapshot.ccn,
  source: "CMS Provider Data API",
  retrievedAt: publicBenchmarkSnapshot.retrievedAt,
}));

export const federalFacts = [
  { label: "CY 2026 ESRD PPS base rate", value: "$281.71", sourceId: "cms-cy2026-final", status: "Final" },
  { label: "Medicare ESRD facilities", value: "≈7,600", sourceId: "cms-cy2026-final", status: "Final" },
  { label: "Expected CY 2026 payments", value: "$6.0B", sourceId: "cms-cy2026-final", status: "Final" },
  { label: "2023 hospitalizations / person-year", value: "1.51", sourceId: "usrds-adr-2025", status: "Published" },
];

export const traceSpans: TraceSpan[] = [
  { id: "TR-1", label: "Discharge event accepted", system: "Kafka ingress", duration: "38 ms", status: "ok", detail: "Schema hospital.transition.v2 · event hash verified" },
  { id: "TR-2", label: "Patient state projected", system: "Bitemporal state", duration: "21 ms", status: "ok", detail: "Valid time and recorded time retained" },
  { id: "TR-3", label: "Assessment evidence joined", system: "Evidence fabric", duration: "64 ms", status: "ok", detail: "Two patient-scoped facts · exact spans attached" },
  { id: "TR-4", label: "Cells evaluated", system: "Swarm runtime", duration: "412 ms", status: "ok", detail: "5 eligible · 5 completed · no model fallback" },
  { id: "TR-5", label: "Policy arbitration", system: "Outcome harness", duration: "17 ms", status: "review", detail: "Class B action · coordinator approval required" },
  { id: "TR-6", label: "Outcome verification", system: "Action gateway", duration: "pending", status: "review", detail: "Waiting for chair and ride acknowledgments" },
];

export const graphNodes: GraphNode[] = [
  { id: "enterprise", label: "Riverbend Kidney Care", type: "enterprise", x: 0, y: 4.8, z: 0 },
  { id: "division", label: "Southeast Division", type: "division", x: 0, y: 3.7, z: 0.4 },
  { id: "region", label: "Middle Tennessee", type: "region", x: 0, y: 2.6, z: -0.2 },
  { id: "franklin", label: "Franklin", type: "facility", x: -3.4, y: 1.3, z: 0.6 },
  { id: "columbia", label: "Columbia", type: "facility", x: 0, y: 1.3, z: -0.6 },
  { id: "murfreesboro", label: "Murfreesboro", type: "facility", x: 3.4, y: 1.3, z: 0.5 },
  { id: "patient", label: "Maya Ortiz", type: "patient", x: -4.5, y: -0.2, z: -0.2 },
  { id: "assessment", label: "Ride answer", type: "assessment", x: -5.1, y: -1.7, z: 0.5 },
  { id: "discharge", label: "Discharge", type: "signal", x: -3.5, y: -1.7, z: -0.5 },
  { id: "workforce-cluster", label: "Weekend coverage cluster", type: "cluster", x: 0, y: -0.2, z: 0.6 },
  { id: "access-cluster", label: "Access risk cluster", type: "cluster", x: 4.2, y: -0.2, z: -0.5 },
  { id: "continuity", label: "Continuity cell", type: "cell", x: -2.1, y: -1.7, z: -0.7 },
  { id: "capacity", label: "Capacity cell", type: "cell", x: 0, y: -1.8, z: 0.9 },
  { id: "quality", label: "Quality cell", type: "cell", x: 2.2, y: -1.7, z: -0.4 },
  { id: "policy", label: "Action policy 4.2", type: "policy", x: 3.5, y: -3.1, z: 0.5 },
  { id: "plan", label: "Coverage + chair plan", type: "intervention", x: 0, y: -3.3, z: 0 },
  { id: "outcome", label: "Treatments kept", type: "outcome", x: 0, y: -4.8, z: 0.5 },
  { id: "measure", label: "Continuity measure", type: "measure", x: 2.7, y: -4.6, z: -0.6 },
  { id: "source", label: "FHIR Encounter", type: "source", x: -5.1, y: 1.3, z: 0.6 },
  { id: "cms-authority", label: "CMS authority", type: "source", x: 4.9, y: 3.4, z: -0.3 },
];

export const graphEdges: GraphEdge[] = [
  { source: "enterprise", target: "division", relation: "contains" },
  { source: "division", target: "region", relation: "contains" },
  { source: "region", target: "franklin", relation: "contains" },
  { source: "region", target: "columbia", relation: "contains" },
  { source: "region", target: "murfreesboro", relation: "contains" },
  { source: "franklin", target: "patient", relation: "serves" },
  { source: "assessment", target: "patient", relation: "describes" },
  { source: "source", target: "discharge", relation: "asserts" },
  { source: "discharge", target: "patient", relation: "changes state" },
  { source: "franklin", target: "workforce-cluster", relation: "contributes signal" },
  { source: "columbia", target: "workforce-cluster", relation: "contributes signal" },
  { source: "murfreesboro", target: "workforce-cluster", relation: "contributes signal" },
  { source: "franklin", target: "access-cluster", relation: "contributes signal" },
  { source: "murfreesboro", target: "access-cluster", relation: "contributes signal" },
  { source: "patient", target: "continuity", relation: "evaluated by" },
  { source: "workforce-cluster", target: "capacity", relation: "evaluated by" },
  { source: "access-cluster", target: "quality", relation: "evaluated by" },
  { source: "continuity", target: "plan", relation: "proposes" },
  { source: "capacity", target: "plan", relation: "constrains" },
  { source: "quality", target: "plan", relation: "constrains" },
  { source: "policy", target: "plan", relation: "governs" },
  { source: "plan", target: "outcome", relation: "seeks" },
  { source: "outcome", target: "measure", relation: "updates" },
  { source: "cms-authority", target: "measure", relation: "governs" },
  { source: "measure", target: "region", relation: "rolls up" },
];

export const facilityStations = Array.from({ length: 12 }, (_, index) => {
  const station = index + 1;
  const states = ["active", "active", "turnover", "available", "active", "late", "active", "available", "active", "maintenance", "active", "active"] as const;
  return {
    station,
    state: states[index],
    patient: states[index] === "active" ? `SYN-${10120 + index}` : states[index] === "late" ? "Arrival +18m" : "—",
    ends: states[index] === "active" ? `${10 + (index % 3)}:${index % 2 ? "40" : "20"}` : states[index] === "turnover" ? "10 min" : "—",
  };
});

export const greenTeamChecks = [
  { name: "Event contract compatibility", target: "100%", result: "100%", status: "pass" },
  { name: "Assessment evidence groundedness", target: "≥94%", result: "96.8%", status: "pass" },
  { name: "Cross-patient isolation", target: "100%", result: "100%", status: "pass" },
  { name: "Measure gold-set parity", target: "100%", result: "100%", status: "pass" },
  { name: "Command idempotency", target: "100%", result: "100%", status: "pass" },
  { name: "Outcome trace completeness", target: "≥99%", result: "99.7%", status: "pass" },
];

export const sourceMappings = [
  { canonical: "patient.identifier", fhir: "Patient.identifier", kafka: "patient.changed.v3", status: "mapped" },
  { canonical: "treatment.scheduledAt", fhir: "Appointment.start", kafka: "treatment.scheduled.v2", status: "mapped" },
  { canonical: "assessment.answer", fhir: "QuestionnaireResponse.item.answer", kafka: "assessment.response.v1", status: "mapped" },
  { canonical: "hospital.dischargedAt", fhir: "Encounter.period.end", kafka: "adt.discharge.v2", status: "mapped" },
  { canonical: "vascularAccess.type", fhir: "Procedure.code + Observation", kafka: "access.changed.v2", status: "review" },
];
