// M20 Knowledge Layer — types.
//
// The Knowledge Layer is the unified authoritative-source substrate of the
// harness. Every real-world document library a facility consults (drug refs,
// clinical guidelines, terminology, coverage determinations, fee schedules,
// nursing protocols, local formularies, order sets) is modeled here as a
// KnowledgeSource with a typed adapter, uniform provenance, and format-aware
// extractors.
//
// Design principles (aligned with harness "realm" paradigm):
//   1. Every artifact ever produced from any source carries a full UpstreamRef
//      chain — the same one used in src/measures/types.ts.
//   2. Sources are pluggable: adding a new adapter never touches consumers.
//   3. Access tiers are explicit — public/api-key/licensed/customer-supplied.
//   4. Every source declares its cadence; the scheduler drives sync.
//   5. Every fetch → extract → store step is an *event* in the effect ledger,
//      so the same episodes/sentience views the harness already renders keep
//      working across the new knowledge stack. No parallel provenance graph.

export type ISODate = string;

/** Access tier — determines whether the source can sync without operator setup. */
export type AccessTier =
  | 'public'            // no auth, freely reachable
  | 'api-key'           // free key required (VSAC/UMLS/LOINC/SNOMED via NLM)
  | 'licensed'          // commercial license required (UpToDate, Micromedex, CPT full)
  | 'customer-supplied' // operator uploads local docs (order sets, formulary, antibiogram)
  | 'entitlement';      // per-facility entitlement lookup (state PDMP, payer policies)

/** Update cadence — drives the scheduler. */
export type Cadence =
  | 'realtime'    // on-demand, no cache (e.g. NPI lookup)
  | 'event'       // subscribe to feed (RSS, webhook) — sync when notified
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'manual';     // operator-triggered only

/** Content format — determines which extractor runs. */
export type SourceFormat =
  | 'fhir-json'    // FHIR R4 JSON resources
  | 'fhir-xml'     // FHIR R4 XML resources
  | 'json-api'     // generic JSON REST
  | 'xml-api'      // generic XML REST (PubMed, DailyMed)
  | 'html'         // HTML page (needs readability extraction)
  | 'pdf'          // PDF document (text + section extraction)
  | 'csv'          // CSV file
  | 'tsv'
  | 'xlsx'         // Excel
  | 'xml-spl'      // SPL structured product labeling
  | 'zip-bundle'   // zip containing files (ICD-10 code tables ship as zip)
  | 'rss'          // RSS/Atom feed
  | 'hl7-v2'       // HL7 v2.x pipe-delimited
  | 'fixed-width'  // fixed-width (ESRD 2728/2746)
  | 'sql-dump'
  | 'text';

/** What kind of authoritative content this source publishes. */
export type SourceCategory =
  | 'ecqm'                     // eCQMs (FHIR Measure + CQL/ELM Library)
  | 'clinical-guideline'       // societal/federal guidelines (KDIGO, USPSTF, IDSA, CDC MMWR-RR)
  | 'drug-label'               // FDA-approved labeling / SPL
  | 'drug-safety'              // FAERS, recalls, shortages, alerts
  | 'drug-interaction'         // RxNav interactions, DDI
  | 'drug-reference'           // drug info compendia
  | 'terminology'              // code systems and value sets
  | 'coverage-determination'   // NCD, LCD, payer medical policies
  | 'fee-schedule'             // PFS, OPPS, IPPS, DMEPOS, PDPM, PDGM, CLFS
  | 'coding'                   // ICD-10-CM/PCS, HCPCS, CPT
  | 'accreditation-standard'   // Joint Commission, NCQA, CAP, HRSA-330
  | 'nursing-protocol'         // AACN, ANA, ISMP
  | 'infection-control'        // CDC IPC, NHSN definitions
  | 'immunization-schedule'    // ACIP
  | 'preventive-screening'     // USPSTF, AAP Bright Futures
  | 'trial-registry'           // ClinicalTrials.gov
  | 'literature-index'         // PubMed, MedlinePlus
  | 'interop-profile'          // US Core IG, IHE profiles, USCDI
  | 'provider-registry'        // NPI, PECOS, OIG exclusions, state license
  | 'formulary'                // customer local formulary
  | 'order-set'                // customer local order set
  | 'antibiogram'              // customer antibiogram
  | 'local-protocol'           // customer local protocol/pathway
  | 'other';

/** Uniform provenance — every extracted artifact keeps this in full. */
export interface UpstreamRef {
  sourceId: string;             // stable id of the KnowledgeSource
  sourceVersion: string;        // version stamp (repo commit, api version, spec year, etc.)
  canonicalUrl: string;         // link operators/clinicians can click back to
  rawUrl: string;               // exact URL we fetched
  fetchedAt: ISODate;
  contentHash: string;          // sha256 of raw bytes
  contentType: string;
  contentBytes: number;
  extractorId: string;
  extractorVersion: string;
  // Format-specific citation locator so an inference can be traced to a
  // paragraph/page/section/table row in the original.
  locator?: {
    page?: number;
    section?: string;
    paragraph?: number;
    tableRowId?: string;
    fhirResourceId?: string;
    xpath?: string;
    jsonPointer?: string;
    lineRange?: [number, number];
  };
}

/** A KnowledgeSource is one entry in the source registry. */
export interface KnowledgeSourceSpec {
  id: string;                       // e.g. 'openfda.drug.label', 'kdigo.ckd.2024'
  name: string;                     // human-readable name
  publisher: string;                // e.g. 'FDA', 'CDC', 'NLM', 'KDIGO', 'CMS', 'AACN'
  category: SourceCategory;
  tier: AccessTier;
  format: SourceFormat;
  cadence: Cadence;
  homepage: string;                 // where humans go to learn about it
  license: string;                  // e.g. 'Public Domain (US Gov)', 'CC-BY', 'UMLS License', 'AMA CPT License'
  description: string;              // 1-2 sentences on why a clinician uses it
  clinicalDomains: string[];        // e.g. ['cardiology', 'nephrology'] or ['all']
  requires?: {
    credentialName?: string;        // secret key name in the secret registry
    credentialSetup?: CredentialSetup;
  };
  fetchConfig: unknown;             // adapter-specific config; typed by the adapter
  scheduleHint?: {
    // Optional per-source override of the tier's default cron.
    cron?: string;
    nextRefreshAt?: ISODate;
  };
}

/** Instructions rendered by the credentials wizard on the source card. */
export interface CredentialSetup {
  registerUrl: string;
  registerLabel: string;
  steps: {
    text: string;
    subSteps?: string[];
    link?: { label: string; url: string };
  }[];
  fields: {
    name: string;
    label: string;
    kind: 'apiKey' | 'username' | 'password' | 'oauthClient' | 'oauthSecret' | 'url' | 'text';
    placeholder?: string;
    required: boolean;
  }[];
  testEndpoint: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    expectStatus: number[];
  };
  estimatedTime: string; // e.g. "2 minutes" or "up to 3 business days"
  cost: string;          // e.g. "Free" or "Free with UMLS license"
  notes?: string[];
}

/** Sync outcome recorded to the effect ledger. */
export interface SyncOutcome {
  sourceId: string;
  startedAt: ISODate;
  finishedAt: ISODate;
  status: 'ok' | 'partial' | 'skipped-unchanged' | 'failed' | 'needs-credential';
  fetched: number;         // resources/pages/rows fetched
  extracted: number;       // artifacts produced
  changes: SourceChange[];
  errors: { at: string; message: string }[];
  bytesIn: number;
  upstreamVersion?: string;
  message: string;
}

export interface SourceChange {
  kind: 'added' | 'removed' | 'updated';
  artifactId: string;
  before?: string;         // e.g. previous version
  after?: string;
  reason?: string;
}

/** Everything extracted from a fetch is a KnowledgeArtifact. */
export interface KnowledgeArtifact {
  id: string;                       // stable within the source (URL-safe)
  sourceId: string;
  category: SourceCategory;
  title: string;
  summary?: string;
  body?: string;                    // extracted text (for text-searchable artifacts)
  structured?: unknown;             // parsed structure (JSON, FHIR resource, etc.)
  clinicalDomains: string[];
  effective?: { start?: ISODate; end?: ISODate };
  upstream: UpstreamRef;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Adapter contract — one implementation per source class. */
export interface KnowledgeAdapter<Config = unknown> {
  readonly kind: string;                         // e.g. 'openfda', 'rxnav', 'cdc-html', 'pdf-guideline'
  readonly version: string;                      // extractorVersion recorded in provenance
  /** Fetch upstream and yield extracted artifacts. Emit change events per artifact. */
  sync(input: SyncInput<Config>): AsyncGenerator<AdapterEvent, SyncSummary, void>;
  /** Verify credentials without doing a full sync — used by the "Test" button. */
  testCredentials?(input: TestInput): Promise<TestResult>;
}

export interface SyncInput<Config> {
  spec: KnowledgeSourceSpec;
  config: Config;
  secrets: Record<string, string>;               // resolved from secret registry
  storeDir: string;                              // filesystem prefix for this source
  previousVersion?: string;                      // upstream version at last sync
  filter?: (id: string) => boolean;              // optional artifact filter
  concurrency?: number;
}

export type AdapterEvent =
  | { type: 'fetch'; url: string; ok: boolean; status: number; bytes: number }
  | { type: 'artifact'; artifact: KnowledgeArtifact; change: SourceChange | null }
  | { type: 'progress'; done: number; total: number | null; message?: string }
  | { type: 'warning'; message: string; url?: string }
  | { type: 'error'; message: string; url?: string };

export interface SyncSummary {
  upstreamVersion?: string;
  totalFetched: number;
  totalExtracted: number;
  changes: SourceChange[];
}

export interface TestInput {
  spec: KnowledgeSourceSpec;
  secrets: Record<string, string>;
}
export interface TestResult {
  ok: boolean;
  message: string;
  detail?: unknown;
}

// ===================================================================
// Pack ⇄ Source hypergraph
// ===================================================================
//
// Sources are consumed by MANY packs. Packs draw from MANY sources.
// Each connection is not just an edge — it's a *scoped subscription* the
// pack has to a slice of the source, used in one or more workflows/agents
// inside the pack.
//
// Example: `ckd-navigation` and `dialysis-deep` both consume
//   * KDIGO CKD 2024 guideline           (scope: recommendations 1-15)
//   * KDOQI Vascular Access 2020         (scope: full)
//   * RxNorm                              (scope: renally-adjusted drug classes)
//   * LOINC                               (scope: KDIGO lab panel)
//   * CMS ESRD PPS fee schedule           (scope: HCPCS G0xxx dialysis codes)
//   * NHSN Dialysis Event surveillance    (scope: bloodstream events)
//   * ACIP schedules                      (scope: dialysis-modified vax subset)
//   * ISMP High-Alert Meds                (scope: heparin + anticoag)
//
// The SAME KDIGO source is also consumed by `payer` pack (for PA rules) and
// `home-health` pack (for CKD home education content), each with different
// scopes.
//
// This is a many-to-many, scope-aware, cross-workflow relationship. We model
// it as a first-class hypergraph edge in the harness — not as duplicated
// per-pack copies of source data.

/** How a pack subscribes to a slice of a source. */
export interface PackSourceSubscription {
  packId: string;
  sourceId: string;
  /** Subset of the source this pack cares about. Adapters use this to filter sync. */
  scope: SourceScope;
  /** Which pack-internal workflows/agents depend on this subscription. */
  usedBy: PackUsage[];
  /**
   * Freshness contract: the strictest cadence required across all usedBy entries.
   * The scheduler upgrades a source's global cadence if any pack needs it fresher.
   */
  freshnessRequirement: Cadence;
  /** Whether missing/stale data blocks agent operation vs. degrades gracefully. */
  criticality: 'blocking' | 'degraded' | 'informational';
  /** Optional pack-specific transform layered on top of the shared extraction. */
  transformId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Scope describes WHICH slice of the source the pack subscribes to. */
export interface SourceScope {
  /** Filter by artifact id/prefix (e.g. only CMS165, CMS117; only ICD I50.x). */
  artifactIds?: string[];
  /** Filter by clinical domain (e.g. ['nephrology', 'endocrinology']). */
  clinicalDomains?: string[];
  /** Filter by code system + value set membership (e.g. only drugs in RxClass ATC 'C09'). */
  codeFilters?: { system: string; valueSetUrl?: string; codePrefixes?: string[] }[];
  /** Filter by section for PDF guidelines (e.g. recs 1–15 of KDIGO CKD). */
  sections?: string[];
  /** Filter by date range effective within measurement or care period. */
  effectiveRange?: { start?: ISODate; end?: ISODate };
  /** Freeform selector for adapters that need it (encoded per-adapter). */
  custom?: Record<string, unknown>;
}

/** Where inside a pack a source subscription is actually used. */
export interface PackUsage {
  workflowId?: string;      // pack workflow that references the source
  agentId?: string;         // agent (in the pack) that consults the source
  measureId?: string;       // measure that depends on the source
  ruleId?: string;          // rule/policy that cites the source
  purpose: string;          // 1-line why: e.g. "CKD stage classification", "renal drug dosing"
}

/** Cross-pack view of a single source — who uses it and how. */
export interface SourceConsumerFanout {
  sourceId: string;
  totalPacks: number;
  totalWorkflows: number;
  totalAgents: number;
  totalMeasures: number;
  subscriptions: PackSourceSubscription[];
  /** Aggregate freshness contract (strictest across all packs). */
  effectiveCadence: Cadence;
  /** True if any pack marks this source blocking. */
  anyBlocking: boolean;
}

/** Cross-source view of a single pack — what it depends on. */
export interface PackKnowledgeBill {
  packId: string;
  totalSources: number;
  bySources: PackSourceSubscription[];
  byCategory: Record<SourceCategory, number>;
  byTier: Record<AccessTier, number>;
  blockingSources: string[];             // sources whose absence blocks the pack
  missingCredentials: string[];          // sourceIds that need credentials the operator hasn't provided
  staleSources: string[];                // sources past nextRefreshAt
}

/** Registry event — written to effect ledger so realm/experiences views work. */
export type KnowledgeEvent =
  | { type: 'source-registered'; sourceId: string; at: ISODate }
  | { type: 'subscription-added'; packId: string; sourceId: string; at: ISODate }
  | { type: 'subscription-updated'; packId: string; sourceId: string; at: ISODate }
  | { type: 'sync-started'; sourceId: string; at: ISODate }
  | { type: 'sync-completed'; sourceId: string; outcome: SyncOutcome }
  | { type: 'credential-required'; sourceId: string; at: ISODate }
  | { type: 'freshness-violated'; sourceId: string; packIds: string[]; at: ISODate };

