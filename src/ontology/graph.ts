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

// OntologyGraph — the harness's terminology backbone.
//
// Concepts are (system, code, display) triples. Relationships express
// SNOMED/ICD/RxNorm/LOINC class hierarchies (`is-a`, `part-of`, `has-ingredient`,
// `has-dose-form`, `has-measured-property`, `mapped-to`). Value sets are
// bounded queries over the graph (e.g. "all descendants of Diabetes Mellitus")
// and are what CMSMeasureSpec references.
//
// The harness ships high-value subsets seeded in `seeds.ts`. Full releases
// arrive via loaders (`loaders/loinc-loader.ts`, etc.) that pull the licensed
// distributions and expand nodes + edges. Everything is hypergraph-backed so
// value sets can also express relational queries like "codes with LOINC
// property=urea AND system=serum".

import type { CodingSystemId } from './systems.js';

export interface ConceptNode {
  readonly system: CodingSystemId;
  readonly code: string;
  readonly display: string;
  readonly effectiveFrom?: string;
  readonly retiredAt?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}
export interface ConceptRelationship {
  readonly source: { readonly system: CodingSystemId; readonly code: string };
  readonly target: { readonly system: CodingSystemId; readonly code: string };
  readonly predicate: 'is-a' | 'part-of' | 'has-ingredient' | 'has-dose-form' | 'has-strength' | 'has-measured-property' | 'has-specimen' | 'mapped-to' | 'replaced-by' | 'associated-morphology' | 'finding-site' | 'causative-agent';
  readonly effectiveFrom?: string;
}
export interface ValueSetDefinition {
  readonly id: string;                      // e.g. "vs:esrd-patients-in-facility"
  readonly title: string;
  readonly description: string;
  readonly includes: readonly ValueSetInclude[];
  readonly excludes?: readonly ValueSetInclude[];
  readonly bindingStrength: 'required' | 'extensible' | 'preferred' | 'example';
  readonly steward: string;
  readonly source?: { readonly url: string; readonly citation?: string };
}
export type ValueSetInclude =
  | { readonly kind: 'codes'; readonly system: CodingSystemId; readonly codes: readonly string[] }
  | { readonly kind: 'descendants-of'; readonly system: CodingSystemId; readonly root: string }
  | { readonly kind: 'filter'; readonly system: CodingSystemId; readonly attribute: string; readonly op: 'equals' | 'in' | 'regex'; readonly value: string | readonly string[] }
  | { readonly kind: 'value-set'; readonly valueSetId: string };

export class OntologyGraph {
  private readonly concepts = new Map<string, ConceptNode>();
  private readonly outgoing = new Map<string, ConceptRelationship[]>();
  private readonly valueSets = new Map<string, ValueSetDefinition>();

  private key(system: CodingSystemId, code: string): string { return `${system}::${code}`; }

  addConcept(c: ConceptNode): void { this.concepts.set(this.key(c.system, c.code), c); }
  addRelationship(r: ConceptRelationship): void {
    const k = this.key(r.source.system, r.source.code);
    const arr = this.outgoing.get(k) ?? [];
    arr.push(r);
    this.outgoing.set(k, arr);
  }
  registerValueSet(v: ValueSetDefinition): void { this.valueSets.set(v.id, v); }

  getConcept(system: CodingSystemId, code: string): ConceptNode | undefined { return this.concepts.get(this.key(system, code)); }
  descendantsOf(system: CodingSystemId, root: string): readonly ConceptNode[] {
    const out: ConceptNode[] = [];
    const seen = new Set<string>();
    const stack = [this.key(system, root)];
    while (stack.length) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = this.concepts.get(cur);
      if (node && cur !== this.key(system, root)) out.push(node);
      // find all inbound is-a edges by scanning outgoing (harness stores forward edges only)
      for (const [srcKey, rels] of this.outgoing) {
        for (const r of rels) {
          if (r.predicate === 'is-a' && this.key(r.target.system, r.target.code) === cur) {
            stack.push(srcKey);
          }
        }
      }
    }
    return out;
  }

  expandValueSet(id: string): readonly ConceptNode[] {
    const vs = this.valueSets.get(id);
    if (!vs) return [];
    const collected = new Map<string, ConceptNode>();
    const applyIncludes = (incs: readonly ValueSetInclude[]): void => {
      for (const inc of incs) {
        if (inc.kind === 'codes') {
          for (const code of inc.codes) {
            const c = this.getConcept(inc.system, code);
            if (c) collected.set(this.key(c.system, c.code), c);
          }
        } else if (inc.kind === 'descendants-of') {
          const root = this.getConcept(inc.system, inc.root);
          if (root) collected.set(this.key(root.system, root.code), root);
          for (const c of this.descendantsOf(inc.system, inc.root)) collected.set(this.key(c.system, c.code), c);
        } else if (inc.kind === 'filter') {
          for (const c of this.concepts.values()) {
            if (c.system !== inc.system) continue;
            const attr = c.attributes?.[inc.attribute];
            if (attr === undefined) continue;
            if (inc.op === 'equals' && String(attr) === String(inc.value)) collected.set(this.key(c.system, c.code), c);
            else if (inc.op === 'in' && Array.isArray(inc.value) && inc.value.includes(String(attr))) collected.set(this.key(c.system, c.code), c);
            else if (inc.op === 'regex' && new RegExp(String(inc.value)).test(String(attr))) collected.set(this.key(c.system, c.code), c);
          }
        } else if (inc.kind === 'value-set') {
          for (const c of this.expandValueSet(inc.valueSetId)) collected.set(this.key(c.system, c.code), c);
        }
      }
    };
    applyIncludes(vs.includes);
    if (vs.excludes) {
      const toRemove = new Set<string>();
      const stash = new Map(collected);
      collected.clear();
      applyIncludes(vs.excludes);
      const excl = new Set([...collected.keys()]);
      collected.clear();
      for (const [k, v] of stash) { if (!excl.has(k)) collected.set(k, v); else toRemove.add(k); }
      void toRemove;
    }
    return [...collected.values()];
  }

  listValueSets(): readonly ValueSetDefinition[] { return [...this.valueSets.values()]; }
  listConcepts(): readonly ConceptNode[] { return [...this.concepts.values()]; }
  countConcepts(): number { return this.concepts.size; }
}
