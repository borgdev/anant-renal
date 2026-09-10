// Guideline rule packs — the thresholds as first-class, cited, executable code.
//
// The load-bearing test here is the DRIFT test: every rule records the pack
// constant it mirrors, and this suite resolves that constant at runtime and
// asserts it still equals the rule's bound. Change a clinical threshold in a
// pack without updating the guideline record (or the reverse) and the suite
// fails — so the guideline copy can never silently drift from the code that
// enforces it.

import { describe, expect, it } from 'vitest';
import {
  RULE_PACKS, RULE_PACK_BINDINGS, RULE_PROTOCOLS, rulesForProtocol, ruleById, bindingFor,
  evaluateRule, rulePackSummary, enforcementGaps, rulePackEditions,
  type RuleDefinition,
} from '../src/evidence/rule-packs.js';
import { HGB_TARGET } from '../src/swarm/anemia.js';
import { KTV_TARGET, KTV_TARGET_FREQUENT, URR_FLOOR_PCT, IDWG_FLAG_KG, NADIR_SBP_FLOOR } from '../src/protocols/priors.js';
import { MBD_REFERENCE } from '../src/swarm/mbd.js';
import { ADEQUACY_COVERAGE_DEFAULTS } from '../src/swarm/adequacy-governance.js';
import { NUTRITION_REFERENCE } from '../src/swarm/nutrition.js';
import { NUTRITION_COVERAGE_DEFAULTS } from '../src/swarm/nutrition-governance.js';
import { INFECTION_REFERENCE } from '../src/swarm/infection.js';
import { ACCESS_REFERENCE } from '../src/swarm/access.js';
import { UF_RATE_PER_KG_SAFE, UF_RATE_PER_KG_HIGH, UF_RATE_STEP } from '../src/swarm/fluid.js';

/** The runtime constants the rules are declared to mirror. */
const CONSTANTS: Record<string, unknown> = {
  HGB_TARGET,
  KTV_TARGET, KTV_TARGET_FREQUENT, URR_FLOOR_PCT, IDWG_FLAG_KG, NADIR_SBP_FLOOR,
  MBD_REFERENCE, NUTRITION_REFERENCE, INFECTION_REFERENCE, ACCESS_REFERENCE,
  ADEQUACY_COVERAGE_DEFAULTS, NUTRITION_COVERAGE_DEFAULTS,
  UF_RATE_PER_KG_SAFE, UF_RATE_PER_KG_HIGH, UF_RATE_STEP,
};

function resolve(constant: string, path?: string): number | undefined {
  let value: unknown = CONSTANTS[constant];
  if (path) for (const seg of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[seg];
  return typeof value === 'number' ? value : undefined;
}

/** Which of a rule's bounds the binding is declared to mirror. */
function declaredBound(rule: RuleDefinition, path?: string): number | undefined {
  if (!path) return rule.bounds.value;
  const leaf = path.split('.').pop();
  // a band can be declared as min/max or lower/upper in the pack constant
  if (leaf === 'min' || leaf === 'lower') return rule.bounds.min;
  if (leaf === 'max' || leaf === 'upper') return rule.bounds.max;
  return rule.bounds.value;
}

describe('rule packs — the guideline thresholds are code', () => {
  it('declares cited, enforced rules across every protocol', () => {
    expect(RULE_PACKS.length).toBeGreaterThan(40);
    expect(RULE_PROTOCOLS).toHaveLength(7);
    for (const protocol of RULE_PROTOCOLS) {
      expect(rulesForProtocol(protocol).length, `${protocol} rules`).toBeGreaterThan(0);
    }
    for (const rule of RULE_PACKS) {
      expect(rule.id, `${rule.id} id`).toMatch(/^[a-z0-9.-]+$/);
      expect(RULE_PROTOCOLS).toContain(rule.protocol);
      expect(rule.reference.source, `${rule.id} source`).toBeTruthy();
      expect(rule.reference.edition, `${rule.id} edition`).toBeTruthy();
      expect(rule.reference.statement.length, `${rule.id} statement`).toBeGreaterThan(20);
      expect(rule.implementedIn, `${rule.id} implementedIn`).toMatch(/^src\//);
      expect(rule.enforcement, `${rule.id} enforcement`).toBeTruthy();
    }
    // ids are unique — the audit trail joins on them
    expect(new Set(RULE_PACKS.map((r) => r.id)).size).toBe(RULE_PACKS.length);
  });

  it('every numeric rule carries a bound and a comparator', () => {
    for (const rule of RULE_PACKS) {
      if (rule.comparator === 'present' || rule.comparator === 'never') continue;
      const has = rule.bounds.value !== undefined || rule.bounds.min !== undefined || rule.bounds.max !== undefined;
      expect(has, `${rule.id} must carry a bound`).toBe(true);
      if (rule.comparator === 'between' || rule.comparator === 'outside') {
        expect(rule.bounds.min, `${rule.id} min`).toBeDefined();
        expect(rule.bounds.max, `${rule.id} max`).toBeDefined();
      } else {
        expect(rule.bounds.value, `${rule.id} value`).toBeDefined();
      }
    }
  });

  it('NO DRIFT — every bound still equals the pack constant it mirrors', () => {
    expect(RULE_PACK_BINDINGS.length).toBeGreaterThan(30);
    for (const binding of RULE_PACK_BINDINGS) {
      const rule = ruleById(binding.ruleId);
      expect(rule, `binding for unknown rule ${binding.ruleId}`).toBeDefined();
      const runtime = resolve(binding.constant, binding.path);
      const declared = declaredBound(rule!, binding.path);
      expect(runtime, `${binding.ruleId}: ${binding.constant}${binding.path ? `.${binding.path}` : ''} not resolvable`).toBeDefined();
      expect(runtime, `${binding.ruleId}: ${binding.constant}${binding.path ? `.${binding.path}` : ''} has drifted from the rule pack`).toBe(declared);
    }
  });

  it('every rule with a numeric bound states where it is enforced', () => {
    const summary = rulePackSummary();
    expect(summary.total).toBe(RULE_PACKS.length);
    expect(summary.unenforced).toEqual([]);
    expect(Object.keys(summary.bySource).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(summary.byEnforcement)).toEqual(expect.arrayContaining(['guardrail', 'coverage-gate', 'authority', 'escalation', 'surveillance']));
    for (const protocol of RULE_PROTOCOLS) {
      const entry = summary.byProtocol[protocol]!;
      expect(entry.rules, `${protocol}`).toBeGreaterThan(0);
      expect(entry.sources.length, `${protocol} sources`).toBeGreaterThan(0);
    }
  });

  it('reports where a protocol is thin rather than claiming completeness', () => {
    // every protocol must at least declare a guardrail and a coverage gate —
    // the two classes that make a CDSS safe
    for (const protocol of RULE_PROTOCOLS) {
      const gaps = enforcementGaps(protocol);
      expect(gaps, `${protocol} gaps`).not.toContain('guardrail');
      expect(gaps, `${protocol} gaps`).not.toContain('coverage-gate');
    }
    // and the editions it is bound to
    const editions = rulePackEditions();
    expect(editions.length).toBeGreaterThanOrEqual(5);
    expect(editions.map((e) => e.source)).toContain('KDIGO');
    expect(editions.map((e) => e.source)).toContain('CDC');
    expect(editions.every((e) => e.rules > 0)).toBe(true);
  });

  it('evaluates each comparator', () => {
    const rule = (comparator: RuleDefinition['comparator'], bounds: RuleDefinition['bounds']): RuleDefinition => ({
      id: 'test.rule', protocol: 'ckd-mbd', name: 't', metric: 'X', unit: 'u', comparator, bounds,
      enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts',
      reference: { source: 'KDIGO', edition: 'test', statement: 'a test rule statement' },
    });
    expect(evaluateRule(rule('gte', { value: 1.2 }), 1.3).satisfied).toBe(true);
    expect(evaluateRule(rule('gte', { value: 1.2 }), 1.2).satisfied).toBe(true);
    expect(evaluateRule(rule('gte', { value: 1.2 }), 1.1).satisfied).toBe(false);
    expect(evaluateRule(rule('gt', { value: 1.2 }), 1.2).satisfied).toBe(false);
    expect(evaluateRule(rule('lt', { value: 3.5 }), 3.4).satisfied).toBe(true);
    expect(evaluateRule(rule('lte', { value: 10 }), 10).satisfied).toBe(true);
    expect(evaluateRule(rule('between', { min: 2.5, max: 5.5 }), 4).satisfied).toBe(true);
    expect(evaluateRule(rule('between', { min: 2.5, max: 5.5 }), 6).satisfied).toBe(false);
    expect(evaluateRule(rule('outside', { min: 2.5, max: 5.5 }), 6).satisfied).toBe(true);
    // an unmeasured value is never "satisfied"
    expect(evaluateRule(rule('gte', { value: 1.2 }), undefined).satisfied).toBe(false);
    expect(evaluateRule(rule('gte', { value: 1.2 }), undefined).detail).toMatch(/not measured/);
    // present / never encode contracts, not numbers
    expect(evaluateRule(rule('present', {}), undefined, true).satisfied).toBe(true);
    expect(evaluateRule(rule('present', {}), undefined, false).satisfied).toBe(false);
    expect(evaluateRule(rule('never', {}), undefined, false).satisfied).toBe(true);
    expect(evaluateRule(rule('never', {}), undefined, true).satisfied).toBe(false);
    // the bound is reported so an operator can see what was compared
    expect(evaluateRule(rule('between', { min: 8.4, max: 10.2 }), 11).against).toBe('8.4–10.2 u');
    expect(evaluateRule(rule('gte', { value: 1.2 }), 1).detail).toMatch(/violates/);
  });

  it('makes the safety contracts explicit (authority + never)', () => {
    const noAntimicrobial = ruleById('anant.antimicrobial.authority')!;
    expect(noAntimicrobial.comparator).toBe('never');
    expect(noAntimicrobial.enforcement).toBe('authority');
    expect(evaluateRule(noAntimicrobial, undefined, false).satisfied).toBe(true);

    const cultureFirst = ruleById('kdigo.hb.band');
    expect(cultureFirst).toBeDefined();
    const cultureRule = ruleById('cdc.culture.before-antibiotic')!;
    expect(cultureRule.comparator).toBe('present');
    expect(cultureRule.enforcement).toBe('guardrail');

    const modelFree = ruleById('anant.prevention.model-free')!;
    expect(modelFree.enforcement).toBe('authority');
    expect(modelFree.reference.source).toBe('AnantHQ');

    // the binding lookup powers the traceability view
    expect(bindingFor('kdigo.phosphate.band')!.path).toBe('phosphateTargetMgDl.upper');
    expect(bindingFor('nope')).toBeUndefined();
  });
});
