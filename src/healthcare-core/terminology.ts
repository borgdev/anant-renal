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

// Terminology plane. Every clinical code the harness reasons about is
// declared as a Code(system, code, display) tuple + belongs to a versioned
// ValueSet. Packs bind measures / DQ rules / workflows to value sets so a
// terminology update never requires code changes — only a value-set version bump.
//
// The bundled value sets here are minimal seed content. Production
// deployments load full CMS + VSAC value sets through the source registry
// (see cms-source-registry.ts) — this file establishes the types and a few
// concrete examples used by the dialysis + payer packs.

export type CodeSystem =
  | 'http://loinc.org'
  | 'http://snomed.info/sct'
  | 'http://www.nlm.nih.gov/research/umls/rxnorm'
  | 'http://hl7.org/fhir/sid/icd-10-cm'
  | 'http://www.ama-assn.org/go/cpt'
  | 'https://terminology.hl7.org/CodeSystem/HCPCS'
  | 'http://hl7.org/fhir/sid/ndc'
  | 'http://terminology.hl7.org/CodeSystem/v2-0203'
  | 'http://terminology.hl7.org/CodeSystem/v3-ActCode'
  | string; // extensible for local code systems

export interface Code {
  readonly system: CodeSystem;
  readonly code: string;
  readonly display?: string;
  readonly version?: string;
}

export interface ValueSet {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly effectiveFrom: string; // ISO date
  readonly codes: readonly Code[];
  readonly steward?: string; // e.g. "CMS", "VSAC", "local"
  readonly url?: string;
}

const LOINC = 'http://loinc.org' as const;
const SCT = 'http://snomed.info/sct' as const;
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm' as const;
const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm' as const;
// Concepts we declare ourselves because no authoritative code exists — same
// pattern as src/fhir/code-registry.ts. Never guess a licensed id.
const LOCAL_ACCESS_TYPE = 'urn:ananthealth:codesystem:access-type' as const;

/** Seed value sets referenced by dialysis + payer packs. */
export const seedValueSets: readonly ValueSet[] = Object.freeze([
  {
    id: 'vs:dialysis.labs.core',
    name: 'Dialysis core labs',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    steward: 'CMS',
    codes: [
      { system: LOINC, code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood' },
      { system: LOINC, code: '2823-3', display: 'Potassium [Moles/volume] in Serum or Plasma' },
      { system: LOINC, code: '2777-1', display: 'Phosphate [Mass/volume] in Serum or Plasma' },
      { system: LOINC, code: '1751-7', display: 'Albumin [Mass/volume] in Serum or Plasma' },
      // Was a self-declared 'KTV-DEL' placeholder. Delivered HD Kt/V is 70961-8;
      // note 18262-6 / 18263-4 are LDL / HDL cholesterol, not Kt/V.
      { system: LOINC, code: '70961-8', display: 'Kt/V.Hemodialysis' },
    ],
  },
  {
    id: 'vs:ckd.stages',
    name: 'CKD stage codes',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    steward: 'CMS',
    codes: [
      { system: ICD10, code: 'N18.1', display: 'Chronic kidney disease, stage 1' },
      { system: ICD10, code: 'N18.2', display: 'Chronic kidney disease, stage 2' },
      { system: ICD10, code: 'N18.3', display: 'Chronic kidney disease, stage 3' },
      { system: ICD10, code: 'N18.4', display: 'Chronic kidney disease, stage 4' },
      { system: ICD10, code: 'N18.5', display: 'Chronic kidney disease, stage 5' },
      { system: ICD10, code: 'N18.6', display: 'End stage renal disease' },
    ],
  },
  {
    id: 'vs:esa.medications',
    name: 'Erythropoiesis-stimulating agents',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    steward: 'VSAC',
    codes: [
      { system: RXNORM, code: '105694', display: 'epoetin alfa' },
      // 349849 is NOT darbepoetin alfa (RxNav returns no name for it).
      { system: RXNORM, code: '283838', display: 'darbepoetin alfa' },
    ],
  },
  {
    id: 'vs:vascular-access.types',
    name: 'Dialysis vascular-access types',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    steward: 'CMS',
    codes: [
      // These are presence concepts, not the *creation* procedures the set
      // previously carried: 426340003 is "Creation of graft fistula for
      // dialysis", and 272248001 / 128124002 do not exist at all.
      { system: SCT, code: '312317000', display: 'Arteriovenous graft' },
      { system: LOCAL_ACCESS_TYPE, code: 'avf', display: 'Arteriovenous fistula (native)' },
      { system: LOCAL_ACCESS_TYPE, code: 'cvc', display: 'Central venous catheter' },
    ],
  },
  {
    id: 'vs:oncology.chemo-agents',
    name: 'Oncology chemo/immunotherapy agents (seed)',
    version: '2026.1',
    effectiveFrom: '2026-01-01',
    steward: 'VSAC',
    codes: [
      { system: RXNORM, code: '2555', display: 'cisplatin' },
      { system: RXNORM, code: '3639', display: 'doxorubicin' },
      // 40048 is carboplatin and 1919504 is durvalumab — neither is what the
      // set claimed. A chemo value set that names the wrong agent is the worst
      // version of this defect class.
      { system: RXNORM, code: '1547545', display: 'pembrolizumab' },
    ],
  },
]);

/** Terminology service — resolves value sets + tests membership. */
export class TerminologyService {
  private readonly byId = new Map<string, ValueSet>();

  constructor(seed: readonly ValueSet[] = seedValueSets) {
    for (const vs of seed) this.byId.set(vs.id, vs);
  }

  register(vs: ValueSet): void {
    this.byId.set(vs.id, vs);
  }

  resolve(id: string): ValueSet {
    const vs = this.byId.get(id);
    if (!vs) throw new Error(`Unknown value set: ${id}`);
    return vs;
  }

  contains(valueSetId: string, code: Code): boolean {
    const vs = this.resolve(valueSetId);
    return vs.codes.some((c) => c.system === code.system && c.code === code.code);
  }

  all(): readonly ValueSet[] {
    return Array.from(this.byId.values());
  }
}
