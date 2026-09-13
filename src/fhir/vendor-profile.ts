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

// Vendor profiles (F1.1) — the single place an EMR's differences live.
//
// The decision to integrate with Epic, Cerner (Oracle Health) AND Athena means
// the vendor difference must be DATA, not an `if` in the client. Each profile
// declares how to authenticate, which non-standard headers are required, what
// the vendor actually supports, and — under D1 — how far down the proposal
// degradation ladder we must descend for a given resource.
//
// `confidence` is deliberately three-valued and is surfaced to the operator.
// A profile is a STARTING HYPOTHESIS; the live CapabilityStatement discovered
// by F0's contract test is what corrects it. A profile that quietly overstates
// support would be worse than no profile at all, so the report names the
// confidence rather than implying the matrix is authoritative.

/** The vendors we build for, plus a neutral profile for the emulator / HAPI. */
export type VendorId = 'epic' | 'cerner' | 'athena' | 'generic';

/** How a vendor wants us to authenticate. One auth provider implements each. */
export type FhirAuthMode =
  | 'none'
  | 'bearer'
  | 'smart-backend-services'
  | 'oauth2-delegated'
  | 'basic'
  | 'mtls';

/** A FHIR REST interaction we may attempt against a resource type. */
export type FhirInteraction = 'read' | 'search' | 'create' | 'update' | 'delete';

/** How we can tell that one of our proposals became a real order. */
export type ConversionStrategy =
  | 'identifier-search'
  | 'task-status'
  | 'reference-back'
  | 'none';

/** A three-valued capability verdict. `unverified` is NOT a soft yes. */
export type SupportLevel = 'supported' | 'unsupported' | 'unverified';

/** How much we trust a profile's `supported` block before a live contract test. */
export type VendorConfidence = 'verified' | 'vendor-documented' | 'assumed';

/**
 * The proposal degradation ladder (analysis §5.3). When a vendor cannot carry a
 * flow we DESCEND rather than fail — and the rung we land on is recorded on the
 * proposal with its reason, so an operator can see why an action never reached
 * the chart. Silently dropping to a lower rung would be the same defect class
 * as a swallowed error.
 */
export type ProposalRung =
  | 'direct'        // ServiceRequest / MedicationRequest at intent:'proposal'
  | 'task'          // Task requested + intent:'proposal'
  | 'cds-card'      // a card accepted in the clinician's own context
  | 'communication' // CommunicationRequest to a named clinician
  | 'harness-only'; // our own work queue; no EMR footprint

/** Ordered from strongest to weakest. */
export const PROPOSAL_LADDER: readonly ProposalRung[] = [
  'direct', 'task', 'cds-card', 'communication', 'harness-only',
];

/** Rank for comparison — lower is stronger. */
export function rungRank(rung: ProposalRung): number {
  return PROPOSAL_LADDER.indexOf(rung);
}

/** True when `a` is a stronger rung than `b`. */
export function rungAtLeast(a: ProposalRung, b: ProposalRung): boolean {
  return rungRank(a) <= rungRank(b);
}

export interface VendorSupport {
  /** Resource types the vendor exposes (a hypothesis — corrected by discovery). */
  readonly resourceTypes: readonly string[];
  /** resourceType → interactions we believe are permitted. */
  readonly interactions: Readonly<Record<string, readonly FhirInteraction[]>>;
  /** Which Bulk Data `$export` flavours the vendor offers. */
  readonly bulkExport: 'patient' | 'group' | 'both' | 'none' | 'limited';
  /** Does the vendor honour `intent: 'proposal'` on a write? */
  readonly proposalIntent: boolean;
  /** How a conversion can be observed. `none` means outcome is recorded `unknown`. */
  readonly conversionObservable: ConversionStrategy;
  /**
   * Can the vendor invoke us in context via CDS Hooks? This is not a resource
   * interaction — it is the vendor's ability to surface one of our suggestions
   * inside their own UI, which is the strongest rung available to a vendor with
   * no FHIR write scope.
   */
  readonly cdsHooks: boolean;
  /**
   * Can the vendor accept a `Procedure` at `status: 'in-progress'`? D3 opens the
   * session at start-session; where this is not `supported` we must hold the
   * session locally and emit once at end-session — a declared limitation, never
   * a surprise.
   */
  readonly inProgressProcedure: SupportLevel;
  /** Largest `_count` the vendor honours. */
  readonly maxPageSize: number;
}

export interface VendorRateLimit {
  readonly requestsPerMinute: number;
  readonly burst: number;
}

export interface VendorProfile {
  readonly id: VendorId;
  readonly label: string;
  readonly authMode: FhirAuthMode;
  readonly fhirVersion: 'R4';
  /**
   * Non-standard request header NAMES this vendor requires. The profile carries
   * names only — a connection supplies the values, so no tenant or client
   * identifier is baked into source.
   */
  readonly requiredHeaders: readonly string[];
  readonly scopes: { readonly read: string; readonly write?: string };
  readonly supported: VendorSupport;
  readonly rateLimit: VendorRateLimit;
  readonly confidence: VendorConfidence;
  /** Human-readable caveats shown in the capability report. */
  readonly notes: readonly string[];
}

/**
 * Conservative starting hypotheses for throughput. Vendor limits are published
 * unevenly and change without notice, so these are deliberately low and are
 * corrected from live `429` / `Retry-After` behaviour during F0's contract test
 * and from each vendor's own documentation at onboarding.
 */
const CONSERVATIVE_RATE_LIMIT: VendorRateLimit = { requestsPerMinute: 120, burst: 20 };

/**
 * Resource types every R4 vendor is expected to expose. Used as the profile's
 * starting hypothesis; the contract test replaces it with what discovery says.
 */
const CORE_RESOURCES: readonly string[] = [
  'Patient', 'Practitioner', 'PractitionerRole', 'Organization', 'Location',
  'Encounter', 'EpisodeOfCare', 'Observation', 'ServiceRequest',
  'MedicationRequest', 'Condition', 'Procedure', 'DiagnosticReport',
  'CarePlan', 'CareTeam', 'Goal', 'Task', 'CommunicationRequest', 'Flag',
  'Appointment', 'Slot', 'DocumentReference', 'Immunization', 'Specimen',
  'Coverage', 'Consent', 'Provenance', 'AuditEvent',
];

const CORE_INTERACTIONS: Readonly<Record<string, readonly FhirInteraction[]>> = {
  Patient: ['read', 'search'],
  Practitioner: ['read', 'search'],
  PractitionerRole: ['read', 'search'],
  Organization: ['read', 'search'],
  Location: ['read', 'search'],
  Encounter: ['read', 'search', 'create', 'update'],
  EpisodeOfCare: ['read', 'search'],
  Observation: ['read', 'search', 'create'],
  ServiceRequest: ['read', 'search', 'create', 'update'],
  MedicationRequest: ['read', 'search', 'create', 'update'],
  Condition: ['read', 'search'],
  Procedure: ['read', 'search', 'create', 'update'],
  DiagnosticReport: ['read', 'search'],
  CarePlan: ['read', 'search', 'create', 'update'],
  CareTeam: ['read', 'search'],
  Goal: ['read', 'search', 'create', 'update'],
  Task: ['read', 'search', 'create', 'update'],
  CommunicationRequest: ['read', 'search', 'create'],
  Flag: ['read', 'search', 'create', 'update'],
  Appointment: ['read', 'search'],
  Slot: ['read', 'search'],
  DocumentReference: ['read', 'search', 'create'],
  Immunization: ['read', 'search', 'create'],
  Specimen: ['read', 'search'],
  Coverage: ['read', 'search'],
  Consent: ['read', 'search'],
  Provenance: ['read', 'search', 'create'],
  AuditEvent: ['read', 'search', 'create'],
};

/**
 * Read-only interactions, for a vendor whose write surface is not FHIR. Athena
 * keeps orders and scheduling in its proprietary APIs, so a FHIR write there is
 * not merely untested — it is not the mechanism.
 */
const READ_ONLY_INTERACTIONS: Readonly<Record<string, readonly FhirInteraction[]>> = Object.fromEntries(
  Object.entries(CORE_INTERACTIONS).map(([k, v]) => [k, v.filter((i) => i === 'read' || i === 'search')]),
);

export const EPIC_PROFILE: VendorProfile = {
  id: 'epic',
  label: 'Epic',
  authMode: 'smart-backend-services',
  fhirVersion: 'R4',
  // Epic requires the client id on every request in addition to the bearer token.
  requiredHeaders: ['Epic-Client-ID'],
  scopes: { read: 'system/*.read', write: 'system/*.write' },
  supported: {
    resourceTypes: CORE_RESOURCES,
    interactions: CORE_INTERACTIONS,
    bulkExport: 'both',
    proposalIntent: true,
    conversionObservable: 'identifier-search',
    cdsHooks: true,
    inProgressProcedure: 'unverified',
    maxPageSize: 100,
  },
  rateLimit: { requestsPerMinute: 600, burst: 60 },
  confidence: 'vendor-documented',
  notes: [
    'The most FHIR-mature of the three; treat as the reference implementation.',
    'Requires the client id header on every request, not only at token time.',
    'Confirm the in-progress Procedure behaviour at contract-test time.',
  ],
};

export const CERNER_PROFILE: VendorProfile = {
  id: 'cerner',
  label: 'Cerner / Oracle Health',
  authMode: 'smart-backend-services',
  fhirVersion: 'R4',
  requiredHeaders: [],
  scopes: { read: 'system/*.read', write: 'system/*.write' },
  supported: {
    resourceTypes: CORE_RESOURCES,
    interactions: CORE_INTERACTIONS,
    bulkExport: 'both',
    proposalIntent: true,
    conversionObservable: 'identifier-search',
    cdsHooks: true,
    inProgressProcedure: 'unverified',
    maxPageSize: 100,
  },
  rateLimit: { requestsPerMinute: 400, burst: 40 },
  confidence: 'vendor-documented',
  notes: [
    'Backend Services auth, but a different sandbox and page-size ceiling from Epic.',
    'Confirm the in-progress Procedure behaviour at contract-test time.',
  ],
};

export const ATHENA_PROFILE: VendorProfile = {
  id: 'athena',
  label: 'Athena',
  authMode: 'oauth2-delegated',
  fhirVersion: 'R4',
  requiredHeaders: [],
  // Athena exposes no Backend Services flow, so there is no system scope to hold.
  scopes: { read: 'launch/patient patient/*.read' },
  supported: {
    resourceTypes: CORE_RESOURCES,
    // Read-only over FHIR: orders and scheduling live in proprietary APIs.
    // This is a CONSERVATIVE STARTING HYPOTHESIS, not a verified fact — when the
    // contract test can read the sandbox's CapabilityStatement, discovery wins
    // and corrects this. Trusting it blindly when there IS no discovery would be
    // the profile-overstates-support failure this design exists to avoid.
    interactions: READ_ONLY_INTERACTIONS,
    bulkExport: 'limited',
    proposalIntent: false,
    conversionObservable: 'none',
    cdsHooks: true,
    inProgressProcedure: 'unverified',
    maxPageSize: 50,
  },
  rateLimit: { ...CONSERVATIVE_RATE_LIMIT },
  confidence: 'assumed',
  notes: [
    'No Backend Services flow — auth is delegated OAuth2 via the Athena marketplace.',
    'The FHIR surface is read-mostly; orders and scheduling go through proprietary APIs.',
    'Cannot accept a proposal directly, so proposals degrade to a CDS card or lower.',
    'Conversion is not observable, so outcomes are recorded `unknown` — never "rejected".',
    'The hardest of the three. Validate the capability matrix before committing a flow.',
  ],
};

/** The emulator, HAPI, and any public reference server. */
export const GENERIC_PROFILE: VendorProfile = {
  id: 'generic',
  label: 'Generic R4 (emulator / reference server)',
  authMode: 'none',
  fhirVersion: 'R4',
  requiredHeaders: [],
  scopes: { read: 'system/*.read', write: 'system/*.write' },
  supported: {
    resourceTypes: CORE_RESOURCES,
    interactions: CORE_INTERACTIONS,
    bulkExport: 'both',
    proposalIntent: true,
    conversionObservable: 'identifier-search',
    cdsHooks: true,
    inProgressProcedure: 'supported',
    maxPageSize: 100,
  },
  rateLimit: { requestsPerMinute: 6000, burst: 200 },
  confidence: 'verified',
  notes: ['In-process emulator or a public reference server. No auth, no vendor quirks.'],
};

export const VENDOR_PROFILES: Readonly<Record<VendorId, VendorProfile>> = {
  epic: EPIC_PROFILE,
  cerner: CERNER_PROFILE,
  athena: ATHENA_PROFILE,
  generic: GENERIC_PROFILE,
};

export function vendorProfile(id: string): VendorProfile {
  return VENDOR_PROFILES[id as VendorId] ?? GENERIC_PROFILE;
}

export function isVendorId(id: string): id is VendorId {
  return id in VENDOR_PROFILES;
}

/** Every interaction the profile permits on a resource type. */
export function interactionsFor(profile: VendorProfile, resourceType: string): readonly FhirInteraction[] {
  return profile.supported.interactions[resourceType] ?? [];
}

export function supportsInteraction(
  profile: VendorProfile,
  resourceType: string,
  interaction: FhirInteraction,
): boolean {
  if (!profile.supported.resourceTypes.includes(resourceType)) return false;
  return interactionsFor(profile, resourceType).includes(interaction);
}

export interface ProposalRouting {
  /** The strongest rung this vendor can carry the proposal on. */
  rung: ProposalRung;
  /** Why we are not on `direct`. Empty when we are. */
  reason: string;
  /** False when the rung has no EMR footprint at all. */
  reachesEmr: boolean;
}

/**
 * Where a proposal lands for this vendor — the degradation ladder, applied.
 *
 * A `direct` proposal requires BOTH that the vendor honours `intent: 'proposal'`
 * and that it accepts a create on the resource type. Either failing drops us one
 * rung, and the reason is recorded so the operator sees WHY an action did not
 * reach the chart as a first-class proposal.
 *
 *   direct → Task → CDS card → CommunicationRequest → harness only
 */
export function routeProposal(profile: VendorProfile, resourceType: string): ProposalRouting {
  const creates = supportsInteraction(profile, resourceType, 'create');

  if (profile.supported.proposalIntent && creates) {
    return { rung: 'direct', reason: '', reachesEmr: true };
  }

  const why = !profile.supported.proposalIntent
    ? `${profile.label} does not honour intent:'proposal'`
    : `${profile.label} does not accept a FHIR create on ${resourceType}`;

  if (supportsInteraction(profile, 'Task', 'create')) {
    return { rung: 'task', reason: `${why}; carried as a Task instead`, reachesEmr: true };
  }
  if (profile.supported.cdsHooks) {
    return {
      rung: 'cds-card',
      reason: `${why}; surfaced as a CDS Hooks card the clinician accepts in their own context`,
      reachesEmr: true,
    };
  }
  if (supportsInteraction(profile, 'CommunicationRequest', 'create')) {
    return { rung: 'communication', reason: `${why}; sent as a message to a named clinician`, reachesEmr: true };
  }
  return {
    rung: 'harness-only',
    reason: `${why}; no FHIR write surface and no in-context channel, so the proposal stays in the harness queue`,
    reachesEmr: false,
  };
}

/** CDS Hooks support is a declared profile fact, not an inference. */
export function supportsCdsHooks(profile: VendorProfile): boolean {
  return profile.supported.cdsHooks;
}

/** A one-line summary of a profile for logs and the capability report. */
export function describeProfile(profile: VendorProfile): string {
  return `${profile.label} · ${profile.authMode} · ${profile.confidence}`;
}
