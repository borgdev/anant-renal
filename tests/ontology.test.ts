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
