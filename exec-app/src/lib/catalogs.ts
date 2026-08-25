/**
 * Backend-driven catalogs — every value the exec console once imported from
 * src/data/*.json (or the removed lib/demo.ts) now loads from the harness
 * backend (/admin/swarm/catalog + substrate). The frontend holds ZERO synthetic
 * data; the admin console (Exec assets → Substrate) owns and edits these.
 */

import type { GraphEdge, GraphNode, OutcomeEpisode, TraceSpan } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Runtime-loaded catalogs — shapes mirror the JSON fixtures; components access
// fields directly, so these are intentionally untyped (any).

export let agentManifests: any[] = [];
export let measurePacks: any[] = [];
export let publicSources: any[] = [];
export let operatingModel: any = null;
export let domainPacks: { version: string; defaultState: string; packs: any[] } = { version: "", defaultState: "disabled", packs: [] };
export let ecosystemDemo: any = null;
export let redTeamScenarios: any[] = [];
export let runtimePolicy: any = null;
export let federalFacts: any[] = [];
export let greenTeamChecks: any[] = [];
export let sourceMappings: any[] = [];
export let facilityStations: any[] = [];
export let assessmentResponses: any[] = [];
export let outcomeEpisodes: OutcomeEpisode[] = [];
export let patientTimeline: any[] = [];
export let publicBenchmarks: any[] = [];
export let traceSpans: TraceSpan[] = [];
export let graphNodes: GraphNode[] = [];
export let graphEdges: GraphEdge[] = [];

export const demoContext: { label: string; organization: string; region: string; generatedAt: string; disclaimer: string } = {
  label: "Backend-driven care environment",
  organization: "Riverbend Kidney Care",
  region: "Middle Tennessee",
  generatedAt: "",
  disclaimer:
    "All patient, treatment, staffing and operational records are synthetic. Regulatory sources and labeled public benchmarks are authoritative public data snapshots.",
};

async function catalogJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `catalog request failed: ${path}`);
  return payload;
}

/** Fetch every catalog from the backend and populate the module exports. */
export async function loadCatalogs(): Promise<void> {
  const [catalogRes, scenariosRes, tracesRes, topologyRes] = await Promise.all([
    catalogJson<{ catalogs: Record<string, unknown> }>("/admin/swarm/catalog"),
    catalogJson<{ scenarios: Array<Record<string, unknown>> }>("/admin/swarm/red-team/scenarios").catch(() => ({ scenarios: [] })),
    catalogJson<{ traces: Array<Record<string, unknown>> }>("/admin/swarm/traces").catch(() => ({ traces: [] })),
    catalogJson<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }>("/admin/swarm/topology").catch(() => ({ nodes: [], edges: [] })),
  ]);
  const c = catalogRes.catalogs ?? {};
  agentManifests = (c["agent-manifest"] as Array<Record<string, unknown>>) ?? [];
  measurePacks = (c["measure-pack"] as Array<Record<string, unknown>>) ?? [];
  publicSources = (c["public-source"] as Array<Record<string, unknown>>) ?? [];
  operatingModel = (c["operating-model"] as Record<string, unknown>) ?? null;
  domainPacks = (c["domain-pack"] as { version: string; defaultState: string; packs: Array<Record<string, unknown>> }) ?? { version: "", defaultState: "disabled", packs: [] };
  ecosystemDemo = (c["ecosystem"] as Record<string, unknown>) ?? null;
  runtimePolicy = (c["runtime-policy"] as Record<string, unknown>) ?? null;
  federalFacts = (c["federal-fact"] as Array<Record<string, unknown>>) ?? [];
  greenTeamChecks = (c["green-team-check"] as Array<Record<string, unknown>>) ?? [];
  sourceMappings = (c["source-mapping"] as Array<Record<string, unknown>>) ?? [];
  facilityStations = (c["facility-station"] as Array<Record<string, unknown>>) ?? [];
  assessmentResponses = (c["assessment-response"] as Array<Record<string, unknown>>) ?? [];
  outcomeEpisodes = (c["outcome-episode-story"] as OutcomeEpisode[]) ?? [];
  patientTimeline = (c["patient-timeline"] as Array<Record<string, unknown>>) ?? [];
  const bench = (c["public-benchmark"] as Record<string, unknown> | null) ?? null;
  publicBenchmarks = Array.isArray(bench?.benchmarks)
    ? (bench.benchmarks as Array<Record<string, unknown>>).map((b) => ({ ...b, period: bench.period, facility: bench.facility, city: bench.city, state: bench.state, ccn: bench.ccn, source: "CMS Provider Data API", retrievedAt: bench.retrievedAt }))
    : [];
  redTeamScenarios = scenariosRes.scenarios ?? [];
  traceSpans = (tracesRes.traces ?? []).map((t) => ({
    id: String(t.spanId),
    label: String(t.name),
    system: String(t.system),
    duration: `${Number(t.durationMs ?? 0)} ms`,
    status: t.status === "blocked" ? ("blocked" as const) : t.status === "review" ? ("review" as const) : ("ok" as const),
    detail: String((t.attributes as Record<string, unknown> | undefined)?.detail ?? "persisted trace"),
  }));
  graphNodes = (topologyRes.nodes ?? []).map((n) => ({ id: String(n.id), label: String(n.label), type: String(n.type) as GraphNode["type"], x: Number(n.x), y: Number(n.y), z: Number(n.z) }));
  graphEdges = (topologyRes.edges ?? []).map((e) => ({ source: String(e.source), target: String(e.target), relation: String(e.relation) }));
  if (operatingModel) {
    demoContext.organization = String(operatingModel.organization ?? demoContext.organization);
    demoContext.region = String((operatingModel.scopePath as Array<Record<string, unknown>> | undefined)?.find?.((s) => s.level === "region")?.label ?? demoContext.region);
  }
}
