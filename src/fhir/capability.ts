/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// Capability discovery and negotiation (F0.3 + F1.3).
//
// Two jobs:
//
//   1. Read a vendor's `/metadata` `CapabilityStatement` into a small summary we
//      can cache on the connection.
//   2. Reconcile that against the vendor PROFILE and against the flows we
//      actually need, producing a report the operator sees BEFORE enabling
//      anything.
//
// The second job is the point. A profile is a hypothesis; discovery is the
// evidence. Where they disagree we report the disagreement rather than trusting
// either — a profile that quietly overstates support is worse than no profile,
// and discovering that Athena cannot accept a MedicationRequest proposal during
// onboarding is worth far more than discovering it in production.

import type { FhirInteraction, ProposalRung, VendorProfile } from './vendor-profile.js';
import { interactionsFor, routeProposal, supportsInteraction } from './vendor-profile.js';

/* ---------------------------------------------------- CapabilityStatement */

export interface CapabilityStatementSoftware {
  name?: string;
  version?: string;
  releaseDate?: string;
}

export interface CapabilityStatementInteraction {
  code?: string;
}

export interface CapabilityStatementOperation {
  name?: string;
  definition?: string;
}

export interface CapabilityStatementResource {
  type?: string;
  profile?: string;
  supportedProfile?: string[];
  interaction?: CapabilityStatementInteraction[];
  operation?: CapabilityStatementOperation[];
  versioning?: string;
  readHistory?: boolean;
  updateCreate?: boolean;
  searchInclude?: string[];
  searchRevInclude?: string[];
}

export interface CapabilityStatementSecurity {
  cors?: boolean;
  description?: string;
  service?: Array<{ coding?: Array<{ code?: string; display?: string }> }>;
}

export interface CapabilityStatementRest {
  mode?: 'client' | 'server';
  documentation?: string;
  security?: CapabilityStatementSecurity;
  resource?: CapabilityStatementResource[];
  interaction?: CapabilityStatementInteraction[];
  operation?: CapabilityStatementOperation[];
}

export interface CapabilityStatement {
  resourceType: 'CapabilityStatement';
  id?: string;
  url?: string;
  version?: string;
  name?: string;
  title?: string;
  status?: string;
  date?: string;
  kind?: string;
  fhirVersion?: string;
  format?: string[];
  software?: CapabilityStatementSoftware;
  implementation?: { description?: string; url?: string };
  rest?: CapabilityStatementRest[];
}

export class CapabilityStatementError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CapabilityStatementError';
  }
}

/**
 * Accept only something that is actually a CapabilityStatement. A server that
 * returns an `OperationOutcome` or an HTML error page at `/metadata` should say
 * so here rather than surfacing as a confusing "no resources" downstream.
 */
export function parseCapabilityStatement(value: unknown): CapabilityStatement {
  if (!value || typeof value !== 'object') {
    throw new CapabilityStatementError('capability-statement-not-an-object', 'not-an-object');
  }
  const rt = (value as { resourceType?: unknown }).resourceType;
  if (rt !== 'CapabilityStatement') {
    throw new CapabilityStatementError(
      `capability-statement-unexpected-resourceType: ${String(rt ?? 'missing')}`,
      'unexpected-resource-type',
    );
  }
  return value as CapabilityStatement;
}

/** The cacheable digest we store on a connection and show the operator. */
export interface CapabilityStatementSummary {
  readonly softwareName?: string;
  readonly softwareVersion?: string;
  readonly fhirVersion?: string;
  readonly implementationUrl?: string;
  readonly formats: readonly string[];
  /** Server-mode rest block we summarised (a client block describes something else). */
  readonly resourceTypes: readonly string[];
  /** resourceType → the interaction codes the server declares. */
  readonly interactions: Readonly<Record<string, readonly string[]>>;
  /** Resource types the server declares an `$export`-style operation for. */
  readonly bulkExportTypes: readonly string[];
  /** Whether the server advertises any export operation at all. */
  readonly supportsBulkExport: boolean;
  readonly cors: boolean;
  readonly securityServices: readonly string[];
  readonly readAt: string;
}

const FHIR_INTERACTIONS = new Set<FhirInteraction>(['read', 'search', 'create', 'update', 'delete']);

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function interactionCodes(resource: CapabilityStatementResource): string[] {
  return (resource.interaction ?? [])
    .map((i) => asString(i.code))
    .filter((c): c is string => Boolean(c));
}

function operationNames(ops: readonly CapabilityStatementOperation[] | undefined): string[] {
  return (ops ?? [])
    .map((o) => asString(o.name))
    .filter((n): n is string => Boolean(n));
}

/** Is this operation an export? `export`, `patient-export`, `group-export`. */
function isExportOperation(name: string): boolean {
  return name === 'export' || name.endsWith('-export') || name.startsWith('export-');
}

export function summarizeCapabilities(cs: CapabilityStatement, readAt: string): CapabilityStatementSummary {
  // Prefer the server-mode block: a client block describes what the server CAN
  // call, which is the opposite of what we are asking.
  const servers = (cs.rest ?? []).filter((r) => r.mode === 'server');
  const rest = servers.length > 0 ? servers : (cs.rest ?? []);

  const interactions: Record<string, string[]> = {};
  const resourceTypes: string[] = [];
  const bulkExportTypes: string[] = [];
  let supportsBulkExport = false;
  let cors = false;
  const securityServices = new Set<string>();

  for (const block of rest) {
    if (block.security?.cors) cors = true;
    for (const svc of block.security?.service ?? []) {
      for (const coding of svc.coding ?? []) {
        const code = asString(coding.code);
        if (code) securityServices.add(code);
      }
    }
    if (operationNames(block.operation).some(isExportOperation)) supportsBulkExport = true;

    for (const resource of block.resource ?? []) {
      const type = asString(resource.type);
      if (!type) continue;
      if (!resourceTypes.includes(type)) resourceTypes.push(type);
      const codes = interactionCodes(resource);
      const existing = interactions[type] ?? [];
      interactions[type] = [...new Set([...existing, ...codes])];
      if (operationNames(resource.operation).some(isExportOperation)) {
        supportsBulkExport = true;
        if (!bulkExportTypes.includes(type)) bulkExportTypes.push(type);
      }
    }
  }

  return {
    ...(asString(cs.software?.name) ? { softwareName: asString(cs.software?.name)! } : {}),
    ...(asString(cs.software?.version) ? { softwareVersion: asString(cs.software?.version)! } : {}),
    ...(asString(cs.fhirVersion) ? { fhirVersion: asString(cs.fhirVersion)! } : {}),
    ...(asString(cs.implementation?.url) ? { implementationUrl: asString(cs.implementation?.url)! } : {}),
    formats: cs.format ?? [],
    resourceTypes,
    interactions,
    bulkExportTypes,
    supportsBulkExport,
    cors,
    securityServices: [...securityServices],
    readAt,
  };
}

/* ------------------------------------------------------------- negotiation */

/**
 * The flows this integration needs. Each names the resource and interaction it
 * depends on, so a "not available" answer is concrete rather than a shrug.
 */
export interface RequiredFlow {
  readonly id: string;
  readonly label: string;
  readonly resourceType: string;
  readonly interaction: FhirInteraction;
  /** True when the integration cannot function at all without it. */
  readonly essential: boolean;
}

export const REQUIRED_FLOWS: readonly RequiredFlow[] = [
  { id: 'capability', label: 'CapabilityStatement discovery', resourceType: 'CapabilityStatement', interaction: 'read', essential: true },
  { id: 'patient-read', label: 'Read a patient', resourceType: 'Patient', interaction: 'read', essential: true },
  { id: 'patient-search', label: 'Search patients (backfill / delta)', resourceType: 'Patient', interaction: 'search', essential: true },
  { id: 'encounter-read', label: 'Read encounters', resourceType: 'Encounter', interaction: 'search', essential: true },
  { id: 'episode-encounter-write', label: 'Open the episode Encounter (D3)', resourceType: 'Encounter', interaction: 'create', essential: true },
  { id: 'observation-read', label: 'Read observations (labs, vitals)', resourceType: 'Observation', interaction: 'search', essential: true },
  { id: 'procedure-read', label: 'Read procedures (dialysis sessions)', resourceType: 'Procedure', interaction: 'search', essential: true },
  { id: 'procedure-write', label: 'Write a session Procedure (D3)', resourceType: 'Procedure', interaction: 'create', essential: false },
  { id: 'proposal-service-request', label: "Publish a lab/referral proposal (intent:'proposal')", resourceType: 'ServiceRequest', interaction: 'create', essential: true },
  { id: 'proposal-medication-request', label: "Publish a medication proposal (intent:'proposal')", resourceType: 'MedicationRequest', interaction: 'create', essential: true },
  { id: 'task-write', label: 'Publish a work item as a Task', resourceType: 'Task', interaction: 'create', essential: false },
  { id: 'communication-write', label: 'Message a named clinician', resourceType: 'CommunicationRequest', interaction: 'create', essential: false },
  { id: 'provenance-write', label: 'Attach Provenance to what we publish', resourceType: 'Provenance', interaction: 'create', essential: false },
];

export type FlowVerdict = 'available' | 'degraded' | 'unavailable';

export interface FlowAssessment {
  readonly flow: RequiredFlow;
  readonly verdict: FlowVerdict;
  /** Where a proposal lands for this flow. Only meaningful for proposal flows. */
  readonly rung?: ProposalRung;
  readonly reason: string;
}

/**
 * Where the profile and live discovery disagree about a resource type. Reported
 * rather than resolved: we do not get to decide which of the two is right.
 */
export interface ProfileAccuracy {
  /** The profile claims support that discovery did not find. */
  readonly overstated: readonly string[];
  /** Discovery found support the profile did not claim. */
  readonly understated: readonly string[];
  readonly claimedCount: number;
  readonly discoveredCount: number;
  /** True when the profile claimed something the server does not have. */
  readonly profileOverstates: boolean;
}

export interface CapabilityReport {
  readonly vendor: string;
  readonly confidence: VendorProfile['confidence'];
  readonly discoveredAt: string;
  readonly server: { readonly softwareName?: string; readonly softwareVersion?: string; readonly fhirVersion?: string };
  readonly flows: readonly FlowAssessment[];
  readonly essentialBlocked: readonly string[];
  readonly accuracy: ProfileAccuracy;
  /** One line the operator can act on. */
  readonly headline: string;
}

function isProposalFlow(flow: RequiredFlow): boolean {
  return flow.id.startsWith('proposal-');
}

/**
 * Reconcile a profile against live discovery and against the flows we need.
 *
 * `discovered` may be undefined when the server exposes no `/metadata`. That is
 * itself a finding — we fall back to the profile and say so, rather than
 * pretending we verified anything.
 */
export function negotiateCapabilities(
  profile: VendorProfile,
  discovered: CapabilityStatementSummary | undefined,
  now: string,
): CapabilityReport {
  const flows: FlowAssessment[] = [];

  for (const flow of REQUIRED_FLOWS) {
    if (flow.resourceType === 'CapabilityStatement') {
      flows.push({
        flow,
        verdict: discovered ? 'available' : 'unavailable',
        reason: discovered ? 'CapabilityStatement read' : 'server exposes no /metadata',
      });
      continue;
    }

    const profileSupports = supportsInteraction(profile, flow.resourceType, flow.interaction);
    const discoveredSupports = discovered
      ? (() => {
          if (!discovered.resourceTypes.includes(flow.resourceType)) return false;
          const codes = discovered.interactions[flow.resourceType] ?? [];
          // `search` is implied by a plain `read` on servers that declare only one.
          if (flow.interaction === 'search' && codes.length === 0) return true;
          return codes.includes(flow.interaction);
        })()
      : undefined;

    // BOTH must agree before we call it available. Discovery wins when it is
    // present, because it is evidence; the profile only fills the gap.
    const available = discoveredSupports === undefined ? profileSupports : discoveredSupports;

    let verdict: FlowVerdict = available ? 'available' : 'unavailable';
    let reason = available
      ? discoveredSupports === undefined
        ? 'per vendor profile (no discovery available to confirm)'
        : `declared by ${profile.label}`
      : !profileSupports
        ? `the ${profile.label} profile does not claim ${flow.interaction} on ${flow.resourceType}`
        : `${profile.label} profile claims it but the server does not declare it`;

    let rung: ProposalRung | undefined;
    if (isProposalFlow(flow)) {
      rung = routeProposal(profile, flow.resourceType).rung;
      if (rung !== 'direct') {
        verdict = rung === 'harness-only' ? 'degraded' : 'degraded';
        reason = routeProposal(profile, flow.resourceType).reason;
      }
    }

    flows.push({
      flow,
      verdict,
      ...(rung ? { rung } : {}),
      reason,
    });
  }

  const essentialBlocked = flows
    .filter((f) => f.flow.essential && f.verdict === 'unavailable')
    .map((f) => f.flow.id);

  const accuracy = compareProfileToDiscovery(profile, discovered);

  const degraded = flows.filter((f) => f.verdict === 'degraded').length;
  const headline = essentialBlocked.length > 0
    ? `${essentialBlocked.length} essential flow(s) unavailable: ${essentialBlocked.join(', ')}`
    : degraded > 0
      ? `All essential flows available; ${degraded} proposal flow(s) degraded`
      : 'All required flows available';

  return {
    vendor: profile.id,
    confidence: profile.confidence,
    discoveredAt: now,
    server: {
      ...(discovered?.softwareName ? { softwareName: discovered.softwareName } : {}),
      ...(discovered?.softwareVersion ? { softwareVersion: discovered.softwareVersion } : {}),
      ...(discovered?.fhirVersion ? { fhirVersion: discovered.fhirVersion } : {}),
    },
    flows,
    essentialBlocked,
    accuracy,
    headline,
  };
}

export function compareProfileToDiscovery(
  profile: VendorProfile,
  discovered: CapabilityStatementSummary | undefined,
): ProfileAccuracy {
  if (!discovered) {
    return {
      overstated: [],
      understated: [],
      claimedCount: profile.supported.resourceTypes.length,
      discoveredCount: 0,
      profileOverstates: false,
    };
  }
  const claimed = new Set(profile.supported.resourceTypes);
  const found = new Set(discovered.resourceTypes);
  const overstated = [...claimed].filter((t) => !found.has(t));
  const understated = [...found].filter((t) => !claimed.has(t));
  return {
    overstated,
    understated,
    claimedCount: claimed.size,
    discoveredCount: found.size,
    profileOverstates: overstated.length > 0,
  };
}

/**
 * Cross-check a profile's *declared interactions* against discovery for a single
 * resource type. Used by the profile-accuracy test: a profile must not claim an
 * interaction the server does not declare.
 */
export function claimedInteractionsMissing(
  profile: VendorProfile,
  discovered: CapabilityStatementSummary,
  resourceType: string,
): readonly FhirInteraction[] {
  const claimed = interactionsFor(profile, resourceType);
  const declared = discovered.interactions[resourceType] ?? [];
  if (!discovered.resourceTypes.includes(resourceType)) return claimed;
  return claimed.filter((i) => !declared.includes(i));
}
