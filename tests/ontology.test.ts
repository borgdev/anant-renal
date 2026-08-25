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

import { describe, expect, it } from 'vitest';
import { OntologyGraph, seedOntology, CODING_SYSTEMS } from '../src/ontology/index.js';

describe('Ontology', () => {
  it('lists all major coding systems', () => {
    const ids = CODING_SYSTEMS.map((s) => s.id);
    for (const need of ['snomed-ct','loinc','rxnorm','icd-10-cm','icd-10-pcs','cpt','hcpcs','ndc','ucum','fhir-code-system','omop:vocabulary','umls:cui']) {
      expect(ids).toContain(need);
    }
  });
  it('seeds concepts across systems', () => {
    const g = seedOntology(new OntologyGraph());
    expect(g.countConcepts()).toBeGreaterThan(80);
    expect(g.getConcept('snomed-ct','46177005')?.display).toContain('End-stage');
    expect(g.getConcept('loinc','48642-3')?.display).toContain('Glomerular');
    expect(g.getConcept('rxnorm','866426')?.display).toContain('Metformin');
    expect(g.getConcept('icd-10-cm','N18.6')?.display).toContain('End stage renal disease');
  });
  it('descendantsOf follows is-a edges', () => {
    const g = seedOntology(new OntologyGraph());
    const kids = g.descendantsOf('snomed-ct', '73211009');
    const codes = kids.map((c) => c.code);
    expect(codes).toContain('44054006'); // T2DM
    expect(codes).toContain('46635009'); // T1DM
  });
  it('expands value sets: diabetes-any, esrd, vital-signs', () => {
    const g = seedOntology(new OntologyGraph());
    const dm = g.expandValueSet('vs:diabetes-any').map((c) => c.code);
    expect(dm).toContain('E11.9');
    expect(dm).toContain('73211009');
    const esrd = g.expandValueSet('vs:end-stage-renal-disease').map((c) => c.code);
    expect(esrd).toContain('46177005');
    expect(esrd).toContain('N18.6');
    const vitals = g.expandValueSet('vs:vital-signs');
    expect(vitals.length).toBeGreaterThanOrEqual(9);
  });
});
