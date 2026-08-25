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

// Clinical coding systems — the canonical identifiers used throughout the
// harness. All ontology nodes carry (system, code, display) triples so the
// hypergraph can bind facts, measure evidence, and agent I/O to authoritative
// vocabularies. The harness ships class hierarchies + high-value subsets for
// each system; full releases (SNOMED CT full, ICD-10-CM full, etc.) are loaded
// via the ontology-loader pipeline against the licensed source distributions.

export type CodingSystemId =
  | 'snomed-ct'          // SNOMED International Clinical Terms
  | 'loinc'              // Logical Observation Identifiers Names and Codes
  | 'rxnorm'             // NLM RxNorm (drugs)
  | 'rxnorm:ndc'         // National Drug Code (via RxNorm crosswalk)
  | 'icd-10-cm'          // Clinical Modification (US diagnoses)
  | 'icd-10-pcs'         // Procedure Coding System (US inpatient procedures)
  | 'icd-11'             // WHO ICD-11
  | 'cpt'                // AMA CPT (outpatient procedures)
  | 'hcpcs'              // HCPCS Level II (durable medical, drugs, transport)
  | 'ndc'                // FDA National Drug Code
  | 'unii'               // FDA Unique Ingredient Identifier
  | 'atc'                // WHO Anatomical Therapeutic Chemical
  | 'meddra'             // Medical Dictionary for Regulatory Activities
  | 'ucum'               // Units of Measure
  | 'hl7-v2'             // HL7 v2 code tables
  | 'hl7-v3'             // HL7 v3 coding
  | 'fhir-code-system'   // FHIR built-in code systems
  | 'omop:vocabulary'    // OMOP concept ids
  | 'umls:cui'           // UMLS Concept Unique Identifier
  | 'gudid'              // FDA GUDID device UDIs
  | 'sop-instance-uid'   // DICOM SOP Instance UID
  | 'loinc:document'     // LOINC document types
  | 'nucc:taxonomy'      // NUCC Provider Taxonomy
  | 'npi'                // National Provider Identifier
  | 'oid';               // Generic HL7 OID

export interface CodingSystem {
  readonly id: CodingSystemId;
  readonly title: string;
  readonly steward: string;
  readonly url: string;
  readonly license: 'public-domain' | 'us-federal' | 'snomed-affiliate' | 'commercial' | 'creative-commons';
  readonly currentRelease: string;
  readonly notes?: string;
}

export const CODING_SYSTEMS: readonly CodingSystem[] = Object.freeze([
  { id: 'snomed-ct', title: 'SNOMED CT International + US Extension', steward: 'SNOMED International / NLM', url: 'https://www.snomed.org', license: 'snomed-affiliate', currentRelease: '2026-01-31' },
  { id: 'loinc', title: 'Logical Observation Identifiers Names and Codes', steward: 'Regenstrief Institute', url: 'https://loinc.org', license: 'creative-commons', currentRelease: '2.79' },
  { id: 'rxnorm', title: 'NLM RxNorm', steward: 'US NLM', url: 'https://www.nlm.nih.gov/research/umls/rxnorm', license: 'us-federal', currentRelease: '2026-06-02' },
  { id: 'rxnorm:ndc', title: 'RxNorm NDC crosswalk', steward: 'US NLM', url: 'https://mor.nlm.nih.gov/RxNav', license: 'us-federal', currentRelease: '2026-06-02' },
  { id: 'icd-10-cm', title: 'ICD-10-CM Clinical Modification', steward: 'CDC/CMS', url: 'https://www.cdc.gov/nchs/icd/icd10cm.htm', license: 'us-federal', currentRelease: 'FY-2026' },
  { id: 'icd-10-pcs', title: 'ICD-10-PCS Procedure Coding System', steward: 'CMS', url: 'https://www.cms.gov/medicare/icd-10/2026-icd-10-pcs', license: 'us-federal', currentRelease: 'FY-2026' },
  { id: 'icd-11', title: 'WHO ICD-11', steward: 'WHO', url: 'https://icd.who.int/', license: 'creative-commons', currentRelease: '2026-01' },
  { id: 'cpt', title: 'AMA Current Procedural Terminology', steward: 'AMA', url: 'https://www.ama-assn.org/practice-management/cpt', license: 'commercial', currentRelease: 'CY-2026' },
  { id: 'hcpcs', title: 'HCPCS Level II', steward: 'CMS', url: 'https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system', license: 'us-federal', currentRelease: 'CY-2026' },
  { id: 'ndc', title: 'FDA National Drug Code', steward: 'FDA', url: 'https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory', license: 'us-federal', currentRelease: '2026-Q2' },
  { id: 'unii', title: 'FDA Unique Ingredient Identifier', steward: 'FDA', url: 'https://precision.fda.gov/uniisearch', license: 'us-federal', currentRelease: '2026-Q2' },
  { id: 'atc', title: 'WHO ATC/DDD', steward: 'WHO Collaborating Centre', url: 'https://www.whocc.no/atc_ddd_index/', license: 'commercial', currentRelease: '2026' },
  { id: 'meddra', title: 'MedDRA', steward: 'ICH', url: 'https://www.meddra.org', license: 'commercial', currentRelease: '29.0' },
  { id: 'ucum', title: 'Unified Code for Units of Measure', steward: 'Regenstrief Institute', url: 'https://ucum.org', license: 'public-domain', currentRelease: '2.2' },
  { id: 'hl7-v2', title: 'HL7 v2 Table Sets', steward: 'HL7 International', url: 'https://www.hl7.org/implement/standards/product_brief.cfm?product_id=185', license: 'creative-commons', currentRelease: '2.9.1' },
  { id: 'hl7-v3', title: 'HL7 v3 Vocabulary', steward: 'HL7 International', url: 'https://www.hl7.org/implement/standards/product_brief.cfm?product_id=186', license: 'creative-commons', currentRelease: '2023' },
  { id: 'fhir-code-system', title: 'FHIR Built-in CodeSystems', steward: 'HL7 International', url: 'https://www.hl7.org/fhir/terminologies-systems.html', license: 'creative-commons', currentRelease: 'R5' },
  { id: 'omop:vocabulary', title: 'OMOP Common Data Model Vocabulary', steward: 'OHDSI', url: 'https://ohdsi.github.io/CommonDataModel', license: 'creative-commons', currentRelease: 'v5.4' },
  { id: 'umls:cui', title: 'UMLS Metathesaurus CUI', steward: 'US NLM', url: 'https://www.nlm.nih.gov/research/umls/', license: 'us-federal', currentRelease: '2026AA' },
  { id: 'gudid', title: 'FDA GUDID / UDI', steward: 'FDA', url: 'https://accessgudid.nlm.nih.gov', license: 'us-federal', currentRelease: '2026-Q2' },
  { id: 'sop-instance-uid', title: 'DICOM SOP Instance UID', steward: 'DICOM Standards Committee', url: 'https://www.dicomstandard.org', license: 'creative-commons', currentRelease: '2026a' },
  { id: 'loinc:document', title: 'LOINC Document Ontology', steward: 'Regenstrief Institute', url: 'https://loinc.org/document-ontology', license: 'creative-commons', currentRelease: '2.79' },
  { id: 'nucc:taxonomy', title: 'NUCC Provider Taxonomy', steward: 'NUCC', url: 'https://taxonomy.nucc.org', license: 'creative-commons', currentRelease: '26.0' },
  { id: 'npi', title: 'National Provider Identifier (NPI)', steward: 'CMS NPPES', url: 'https://npiregistry.cms.hhs.gov', license: 'us-federal', currentRelease: 'live' },
  { id: 'oid', title: 'HL7 OID Registry', steward: 'HL7 International', url: 'https://www.hl7.org/oid', license: 'creative-commons', currentRelease: 'live' },
]);
