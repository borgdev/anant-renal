/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

// M20: Real FHIR-shaped measure types.
//
// These are subsets of the FHIR R4 resources we actually consume. Not a
// reimplementation of the spec \u2014 just the fields we hold on to. We never
// synthesize; we only project. Anything a Measure/Library carries that we
// don't extract stays in the raw JSON blob we persisted.

export type ISODate = string;
export type Sha = string;

export interface UpstreamRef {
  /** e.g. 'cqframework/ecqm-content-qicore-2025' */
  repo: string;
  /** File path inside the repo. */
  path: string;
  /** Git blob sha \u2014 identifies content, not commit. */
  blobSha: Sha;
  /** Commit sha of the repo at fetch time (or 'HEAD' if unknown). */
  commitSha: Sha;
  /** Raw fetch URL. */
  rawUrl: string;
  /** When we fetched this artifact. */
  fetchedAt: ISODate;
  /** sha256 of the raw file content, our own hash for integrity checks. */
  contentHash: Sha;
}

export interface StoredMeasure {
  /** Our canonical id, e.g. 'ecqm:CMS165FHIRControllingHighBloodPressure/v1.6.000' */
  id: string;
  /** The CMS id extracted from the resource name, e.g. 'CMS165'. */
  cmsId: string;
  /** FHIR Measure.name */
  name: string;
  /** FHIR Measure.title */
  title: string;
  /** FHIR Measure.version */
  version: string;
  /** FHIR Measure.status */
  status: 'draft' | 'active' | 'retired' | 'unknown';
  /** FHIR Measure.effectivePeriod */
  effectivePeriod?: { start?: ISODate; end?: ISODate };
  /** Canonical URLs of libraries this Measure depends on. */
  libraryRefs: string[];
  /** Raw FHIR Measure JSON (unmodified). */
  raw: unknown;
  upstream: UpstreamRef;
}

export interface StoredLibrary {
  /** e.g. 'AdultOutpatientEncounters/4.19.000' */
  id: string;
  /** FHIR Library.name */
  name: string;
  /** FHIR Library.version */
  version: string;
  /** FHIR Library.url (canonical) */
  url?: string;
  /** Extracted content by type. */
  content: {
    cql?: string;
    elmJson?: unknown; // parsed application/elm+json
    elmXml?: string;
  };
  /** Value set URLs referenced by this library. */
  valueSetRefs: string[];
  /** Code system URLs referenced. */
  codeSystemRefs: string[];
  upstream: UpstreamRef;
}

export interface Coding {
  system: string;
  code: string;
  display?: string;
  version?: string;
}

export interface StoredValueSet {
  /** e.g. 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.104.12.1011' */
  url: string;
  /** OID extracted from the URL if present. */
  oid?: string;
  title?: string;
  version?: string;
  /** How this expansion was obtained. */
  source: 'inline-measure' | 'inline-library' | 'vsac' | 'unresolved';
  expansion: {
    /** ISO date. */
    date: ISODate;
    total: number;
    codes: Coding[];
  };
  /** When source is 'vsac', the VSAC API request metadata. */
  vsac?: { expansionIdentifier?: string; profile?: string };
  /** When source is 'unresolved', why we could not expand. */
  unresolvedReason?: string;
}

// -------- Change detection --------
export type MeasureChangeKind =
  | 'added'
  | 'removed'
  | 'version-updated'
  | 'library-updated'
  | 'value-set-updated'
  | 'status-changed';

export interface MeasureChange {
  kind: MeasureChangeKind;
  measureId: string;
  before?: string; // version or sha
  after?: string;
  detectedAt: ISODate;
  detail?: string;
}

// -------- Evaluation --------
export interface EvaluationInput {
  measureId: string;
  /** FHIR R4 Bundle (transaction or collection) or array of FHIR resources. */
  bundle: unknown;
  /** Optional measurement period override (defaults to Measure.effectivePeriod). */
  measurementPeriod?: { start: ISODate; end: ISODate };
}

export type PopulationCode =
  | 'initial-population'
  | 'denominator'
  | 'denominator-exclusion'
  | 'denominator-exception'
  | 'numerator'
  | 'numerator-exclusion'
  | 'measure-population'
  | 'measure-population-exclusion'
  | 'measure-observation';

export interface PopulationResult {
  code: PopulationCode;
  criteriaExpression: string;
  /** The raw value returned from CQL for this population expression. */
  raw: unknown;
  /** Interpreted as a truthy population membership when the raw value evaluates truthy. */
  member: boolean;
}

export interface EvaluationResult {
  measureId: string;
  measureVersion: string;
  cmsId: string;
  measurementPeriod: { start: ISODate; end: ISODate };
  evaluatedAt: ISODate;
  /** Per-patient evaluation. Keyed by Patient.id. */
  patients: {
    patientId: string;
    populations: PopulationResult[];
    /** For proportion measures: true iff patient is in denom \u2212 denomExcl AND in numerator. Null when not in denominator. */
    met: boolean | null;
  }[];
  /** Provenance: source of the measure logic + libraries used. */
  provenance: {
    measure: UpstreamRef;
    libraries: UpstreamRef[];
    valueSetExpansionsAsOf: ISODate;
    valueSetSources: { url: string; source: StoredValueSet['source'] }[];
  };
}
