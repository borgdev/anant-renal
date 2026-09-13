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

// F4 — terminology & code registry.
//
// The regression net for the whole stage: enumerate EVERY code the write path
// emits and assert it resolves to a real, versioned, displayed concept. Before
// F4 the engine's internal slugs were written straight into RxNorm / LOINC /
// CVX / SNOMED fields, so a clinician received `epoetin-alfa` where an RxCUI
// belongs. Adding a new slug without registering it now fails here.

import { describe, it, expect, beforeEach } from 'vitest';
import { effectToFhirResource } from '../src/fhir/effect-map.js';
import {
  codeRegistry,
  terminologyReport,
  UnmappedCodeError,
  localCodeSystem,
  looksLikeCode,
  type CodeDomain,
} from '../src/fhir/code-registry.js';
import { parseDose, requireDose, UnparseableDoseError } from '../src/fhir/dose.js';
import type { WorldEffect } from '../src/realm/types.js';
import type { FhirCtx } from '../src/fhir/types.js';

const ctx: FhirCtx = {
  scopeId: 'realm:terminology-test',
  sourceId: 'terminology-test',
  ingestedAt: '2026-09-13T00:00:00.000Z',
};

const emit = (effect: WorldEffect, opts: { patientRef?: string } = {}) =>
  effectToFhirResource(effect, { ctx, ...(opts.patientRef ? { patientRef: opts.patientRef } : {}) });

/* ------------------------------------------------------------------ inputs */

/** Every code-bearing vocabulary the engine emits, taken from the emit sites. */
const LAB_SLUGS = [
  'K', 'POTASSIUM', 'HGB', 'PHOS', 'ALBUMIN', 'CREATININE', 'BICARB', 'CRP', 'WBC',
  'PROCALCITONIN', 'NEUTPCT', 'LYMPHPCT', 'NONHDL', 'VITD', 'PTH', 'FERRITIN', 'TSAT',
  'CALCIUM', 'HBSAB', 'BCULT', 'URR', 'KTV', 'KTV-DEL', 'SPKTV', 'KTV-PD',
] as const;
const DRUG_SLUGS = [
  'epoetin-alfa', 'darbepoetin-alfa', 'sevelamer', 'calcium-acetate', 'cinacalcet',
  'calcitriol', 'lanthanum-carbonate', 'sucroferric-oxyhydroxide', 'ferric-citrate',
  'ferric-sucrose', 'sevelamer-carbonate', 'phosphate-binder',
] as const;
const VACCINE_SLUGS = ['hepatitis-b', 'influenza', 'pneumococcal', 'sars-cov-2'] as const;
const SAFETY_SLUGS = [
  'hypoxia', 'missed-treatment', 'bacteremia', 'line-associated-bacteremia', 'access-risk',
  'lab-critical', 'repeated-abnormal-labs', 'ecg-peaked-t-pattern', 'sepsis.detected',
] as const;
const ASSESSMENT_SLUGS = [
  'phq9', 'gad7', 'auditc', 'moca', 'braden', 'morse-fall', 'kdqol', 'mna', 'cage',
  'phq2', 'handgrip', 'access-care-audit', 'hand-hygiene-audit', 'safety-event-close',
] as const;
const FOLLOWUP_SLUGS = ['routine', 'nephro-clinic', 'adequacy-consult', 'payer-followup'] as const;
const ROLE_SLUGS = ['nephrologist', 'nephrology', 'dietitian', 'nurse'] as const;
const TASK_SLUGS = ['facilities', 'clinical-review', 'documentation'] as const;
const DISPOSITIONS = ['home', 'home-health', 'snf', 'hospice', 'transfer', 'ama', 'expired'] as const;

/** One effect per emitted kind, sweeping every code-bearing field. */
function everyEmittedEffect(): WorldEffect[] {
  const effects: WorldEffect[] = [];
  const pid = 'pt-1';

  effects.push({ kind: 'admit-patient', patientId: pid, facilityId: 'f1', unitId: 'u1', reason: 'fluid overload' });
  effects.push({ kind: 'transfer-patient', patientId: pid, fromUnitId: 'u1', toUnitId: 'u2' });
  for (const disposition of DISPOSITIONS) effects.push({ kind: 'discharge-patient', patientId: pid, disposition });

  for (const code of LAB_SLUGS) {
    effects.push({ kind: 'order-lab', patientId: pid, code, priority: 'routine' });
    effects.push({ kind: 'result-lab', orderId: `o-${code}`, code, value: 1.2, unit: 'mg/dL' });
  }

  for (const code of DRUG_SLUGS) {
    for (const route of ['PO', 'IV', 'SC']) {
      effects.push({ kind: 'order-med', patientId: pid, code, dose: '800 mg', route, frequency: 'daily', indication: 'hyperphosphatemia' });
    }
  }

  effects.push({ kind: 'record-vitals', patientId: pid, hr: 82, spo2: 95, temp: 37.2, rr: 18, bp: '128/78' });
  effects.push({ kind: 'record-vitals', patientId: pid, bp: '110/60' });

  for (const assessmentId of ASSESSMENT_SLUGS) {
    effects.push({ kind: 'record-assessment', patientId: pid, assessmentId, score: 7, band: 'moderate' });
  }
  for (const vaccine of VACCINE_SLUGS) {
    effects.push({ kind: 'record-immunisation', patientId: pid, vaccine, seriesDose: 1, seriesTotal: 2 });
  }
  for (const safetyKind of SAFETY_SLUGS) {
    effects.push({ kind: 'flag-safety-event', patientId: pid, safetyKind, severity: 'high' });
  }
  for (const followupKind of FOLLOWUP_SLUGS) {
    for (const resource of ROLE_SLUGS) {
      effects.push({ kind: 'schedule-followup', patientId: pid, when: '2026-10-01T00:00:00.000Z', resource, followupKind });
    }
  }
  for (const ticketKind of TASK_SLUGS) {
    effects.push({ kind: 'open-ticket', ticketKind, subjectRef: `Patient/${pid}`, priority: 'high', summary: 'review' });
  }

  effects.push({ kind: 'update-care-plan', patientId: pid, patch: { title: 'Care plan' } });
  effects.push({ kind: 'submit-claim', encounterId: 'enc-1', payerId: 'payer-1', cptCodes: ['90960'], icd10Codes: ['N18.6'] });
  effects.push({ kind: 'request-prior-auth', patientId: pid, payerId: 'payer-1', serviceCode: '90960' });
  effects.push({ kind: 'operator-directive', originalText: 'Check the access' });

  // F7 — the renal wire model. Both session modalities and every access event,
  // so the net covers the codes the dialysis path emits.
  for (const modality of ['hemodialysis', 'hemodiafiltration'] as const) {
    effects.push({ kind: 'start-session', patientId: pid, sessionId: `s-${modality}`, modality, prescribedMinutes: 240, targetUfL: 2.4 });
  }
  effects.push({
    kind: 'end-session', patientId: pid, deliveredMinutes: 238, ufVolumeL: 2.4,
    qbAvg: 350, recirculationPct: 7, preWeightKg: 72, postWeightKg: 70.5, stoppedEarly: true, complication: 'hypotension',
  });
  for (const event of [
    'surveillance', 'cannulation-difficulty', 'angioplasty', 'thrombosis',
    'infection', 'declot', 'catheter-placed', 'avf-created',
  ] as const) {
    effects.push({
      kind: 'record-access', patientId: pid, event,
      accessFlowMlMin: 780, venousPressureMmHg: 145, arterialPressureMmHg: 120,
      recirculationPct: 6, measuredAtQb: 350,
    });
  }

  return effects;
}

/** Domains whose official code value IS the string we already use. */
const SLUG_IS_THE_CODE: ReadonlySet<CodeDomain> = new Set<CodeDomain>([
  'route', 'claim-type', 'encounter-class', 'observation-category',
  'discharge-disposition', 'security-label',
]);

/* ------------------------------------------------------------------- tests */

describe('F4 · every emitted code resolves to a real concept', () => {
  beforeEach(() => codeRegistry.resetUsage());

  it('enumerates the write path and resolves every code it emits', () => {
    const effects = everyEmittedEffect();
    for (const effect of effects) expect(() => emit(effect), effect.kind).not.toThrow();

    const usage = codeRegistry.usageReport();
    // A sweep this wide must touch a lot of distinct codes; if it drops to a
    // handful, the sweep has silently stopped exercising the mapper.
    expect(usage.length).toBeGreaterThan(60);

    const problems: string[] = [];
    for (const u of usage) {
      const entry = codeRegistry.lookup(u.domain, u.slug);
      if (!entry) { problems.push(`${u.domain}:${u.slug} did not resolve`); continue; }
      if (!entry.system) problems.push(`${u.domain}:${u.slug} has no system`);
      if (!entry.code) problems.push(`${u.domain}:${u.slug} has no code`);
      if (!entry.display) problems.push(`${u.domain}:${u.slug} has no display`);
      if (!entry.version) problems.push(`${u.domain}:${u.slug} has no version`);
      // A verified code in a licensed system must never just echo the slug —
      // unless the caller supplied the real code itself, which is legitimate.
      const suppliedARealCode = looksLikeCode(entry.system, u.slug);
      if (entry.fidelity === 'verified' && !SLUG_IS_THE_CODE.has(entry.domain) && !suppliedARealCode && entry.code === u.slug) {
        problems.push(`${u.domain}:${u.slug} still emits its own slug as the code`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('never writes an unverified code into a licensed code system', () => {
    // The honesty invariant: when no authoritative concept could be verified we
    // declare our OWN code system. Guessing a SNOMED id would look
    // authoritative and fail silently in the EMR.
    for (const entry of codeRegistry.unverified()) {
      expect(entry.system, `${entry.domain}:${entry.slug}`).toBe(localCodeSystem(entry.domain));
    }
  });

  it('DRUG codes are RxNorm RxCUIs, not slugs', () => {
    for (const slug of DRUG_SLUGS) {
      const entry = codeRegistry.resolve('drug', slug);
      const why = `drug:${slug}`;
      if (entry.fidelity === 'verified') {
        expect(entry.system, why).toBe('http://www.nlm.nih.gov/research/umls/rxnorm');
        expect(entry.code, why).toMatch(/^\d+$/);
        expect(entry.code, why).not.toBe(slug);
      }
    }
    // The specific drug the anaemia protocol orders most.
    const epoetin = codeRegistry.resolve('drug', 'epoetin-alfa');
    expect(epoetin.code).toBe('105694');
    expect(epoetin.display).toBe('epoetin alfa');
  });

  it('VACCINE codes are numeric CVX, not slugs', () => {
    for (const slug of VACCINE_SLUGS) {
      const entry = codeRegistry.resolve('vaccine', slug);
      expect(entry.system, slug).toBe('http://hl7.org/fhir/sid/cvx');
      expect(entry.code, slug).toMatch(/^\d+$/);
    }
    expect(codeRegistry.resolve('vaccine', 'influenza').code).toBe('150');
  });

  it('LAB codes are LOINC codes, and KTV-DEL is no longer a placeholder', () => {
    for (const slug of LAB_SLUGS) {
      const entry = codeRegistry.resolve('lab', slug);
      expect(entry.system, slug).toBe('http://loinc.org');
      expect(entry.code, slug).not.toBe('KTV-DEL');
      expect(entry.code, slug).toMatch(/^[0-9]+-[0-9]$/);
    }
    // The plan's own value for this (`18262-6`) is LDL cholesterol; the real
    // delivered-Kt/V code is 70961-8.
    const ktv = codeRegistry.resolve('lab', 'KTV-DEL');
    expect(ktv.code).toBe('70961-8');
    expect(ktv.display).toBe('Kt/V.Hemodialysis');
  });

  it('ASSESSMENT codes are LOINC instruments, using the TOTAL SCORE variant', () => {
    // seeds.ts had 72172-0/72109-2 swapped and 38208-5 (pain) as Braden.
    expect(codeRegistry.resolve('assessment', 'phq9').code).toBe('44261-6');
    expect(codeRegistry.resolve('assessment', 'gad7').code).toBe('70274-6');
    expect(codeRegistry.resolve('assessment', 'auditc').code).toBe('75626-2');
    expect(codeRegistry.resolve('assessment', 'moca').code).toBe('72172-0');
    expect(codeRegistry.resolve('assessment', 'braden').code).toBe('38227-5');
    // ...and the two that could not be verified at all are local, not guessed.
    expect(codeRegistry.resolve('assessment', 'kdqol').fidelity).toBe('local');
    expect(codeRegistry.resolve('assessment', 'cage').fidelity).toBe('local');
  });

  it('a verified entry in a licensed system cites where it was checked', () => {
    for (const entry of codeRegistry.entries()) {
      if (entry.fidelity !== 'verified') continue;
      expect(entry.source, `${entry.domain}:${entry.slug}`).toMatch(/verified|citation|specification/i);
    }
  });

  it('reports how much still needs terminology sign-off', () => {
    const report = terminologyReport();
    expect(report.total).toBe(codeRegistry.entries().length);
    expect(report.verified + report.local).toBe(report.total);
    // Every unverified entry is named, with the reason, for a reviewer.
    expect(report.needsSignOff.length).toBe(report.local);
    for (const row of report.needsSignOff) expect(row.why).toBeTruthy();
  });
});

describe('F4 · an unvalidated code refuses the write', () => {
  it('throws on a lab slug that is not registered', () => {
    expect(() => emit({ kind: 'order-lab', patientId: 'pt-1', code: 'NOT-A-LOINC-CODE', priority: 'routine' }))
      .toThrow(UnmappedCodeError);
  });

  it('throws on an unregistered drug, vaccine, and safety flag', () => {
    expect(() => emit({ kind: 'order-med', patientId: 'p', code: 'unobtainium', dose: '1 mg', route: 'PO', frequency: 'daily' }))
      .toThrow(UnmappedCodeError);
    expect(() => emit({ kind: 'record-immunisation', patientId: 'p', vaccine: 'placebo', seriesDose: 1 }))
      .toThrow(UnmappedCodeError);
    expect(() => emit({ kind: 'flag-safety-event', patientId: 'p', safetyKind: 'bad-vibes', severity: 'low' }))
      .toThrow(UnmappedCodeError);
  });

  it('the error names the slug and the remedy', () => {
    try {
      emit({ kind: 'result-lab', orderId: 'o', code: 'ZZZ', value: 1, unit: 'mg' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(UnmappedCodeError);
      const e = err as UnmappedCodeError;
      expect(e.domain).toBe('lab');
      expect(e.slug).toBe('ZZZ');
      expect(e.message).toContain('CODE_SEEDS');
    }
  });

  it('a valid code still writes (the gate is not a blanket refusal)', () => {
    const [resource] = emit({ kind: 'result-lab', orderId: 'o', code: 'K', value: 5.4, unit: 'mmol/L' });
    expect(resource).toBeDefined();
    const coding = (resource as { code: { coding: Array<{ code: string }> } }).code.coding[0];
    expect(coding?.code).toBe('2823-3');
  });

  it('accepts an already-coded value, but only a REGISTERED one', () => {
    // Real integrations send codes as well as slugs.
    const [byCode] = emit({ kind: 'order-lab', patientId: 'p', code: '17861-6', priority: 'routine' });
    expect((byCode as { code: { coding: Array<{ code: string }> } }).code.coding[0]?.code).toBe('17861-6');

    const [bySlug] = emit({ kind: 'order-lab', patientId: 'p', code: 'CALCIUM', priority: 'routine' });
    expect((bySlug as { code: { coding: Array<{ code: string }> } }).code.coding[0]?.code).toBe('17861-6');

    // ...and a code we do not know is still refused, so a typo cannot pass.
    expect(() => emit({ kind: 'order-lab', patientId: 'p', code: '99999-9', priority: 'routine' }))
      .toThrow(UnmappedCodeError);
  });
});

describe('F4 · dose handling (C9)', () => {
  it('reads a dose exactly', () => {
    expect(parseDose('0.25 mcg')).toEqual({ ok: true, dose: { amount: 0.25, unit: 'mcg' } });
    expect(parseDose('800 mg')).toEqual({ ok: true, dose: { amount: 800, unit: 'mg' } });
    expect(parseDose('800mg')).toEqual({ ok: true, dose: { amount: 800, unit: 'mg' } });
    expect(parseDose('8000')).toEqual({ ok: true, dose: { amount: 8000 } });
  });

  it('demonstrates what the pre-F4 regex did to the same strings', () => {
    // The old parse could not fail, so it always returned something.
    const oldParse = (s: string) => Number(s.replace(/[^0-9.]/g, '')) || undefined;
    expect(oldParse('1-2 tabs')).toBe(12);          // digits concatenated
    expect(oldParse('0.5 mg x 2')).toBe(0.52);      // digits concatenated
    expect(oldParse('q12h')).toBe(12);              // a FREQUENCY read as the dose
    expect(oldParse('two tablets')).toBeUndefined(); // dose silently dropped
  });

  it('refuses every one of those, and every write carrying one', () => {
    for (const bad of ['1-2 tabs', '0.5 mg x 2', 'q12h', 'two tablets', '~500', '']) {
      expect(parseDose(bad).ok, bad).toBe(false);
      expect(() => requireDose(bad), bad).toThrow(UnparseableDoseError);
    }
    // On the write path an EMPTY dose means "no dose stated" (the emitter left it
    // out), which is allowed — whereas a dose that is present but unreadable is
    // refused. The distinction matters: absence is a fact, garbage is a bug.
    expect(() => emit({ kind: 'order-med', patientId: 'p', code: 'calcitriol', dose: '', route: 'PO', frequency: 'daily' })).not.toThrow();
    for (const bad of ['1-2 tabs', '0.5 mg x 2', 'q12h', 'two tablets', '~500']) {
      expect(
        () => emit({ kind: 'order-med', patientId: 'p', code: 'calcitriol', dose: bad, route: 'PO', frequency: 'daily' }),
        bad,
      ).toThrow(UnparseableDoseError);
    }
  });

  it('writes the parsed amount and unit onto the medication request', () => {
    const [resource] = emit({
      kind: 'order-med', patientId: 'p', code: 'calcitriol', dose: '0.25 mcg', route: 'PO', frequency: 'daily',
    });
    const dosage = (resource as { dosageInstruction: Array<{ doseAndRate: Array<{ doseQuantity: { value: number; unit: string } }> }> }).dosageInstruction[0];
    expect(dosage?.doseAndRate[0]?.doseQuantity).toEqual({ value: 0.25, unit: 'mcg' });
  });
});

describe('F4 · payer and structural codes', () => {
  it('a dialysis claim is INSTITUTIONAL, not professional', () => {
    const [claim] = emit({ kind: 'submit-claim', encounterId: 'enc-1', payerId: 'payer-1', cptCodes: ['90960'], icd10Codes: ['N18.6'] });
    const type = (claim as { type: { coding: Array<{ code: string }> } }).type;
    expect(type.coding[0]?.code).toBe('institutional');
  });

  it('a prior-auth request is institutional too', () => {
    const [claim] = emit({ kind: 'request-prior-auth', patientId: 'p', payerId: 'payer-1', serviceCode: '90960' });
    expect((claim as { type: { coding: Array<{ code: string }> } }).type.coding[0]?.code).toBe('institutional');
  });

  it('blood pressure carries systolic and diastolic COMPONENTS under the panel code', () => {
    const [bp] = emit({ kind: 'record-vitals', patientId: 'p', bp: '128/78' });
    const obs = bp as { code: { coding: Array<{ code: string }> }; component: Array<{ code: { coding: Array<{ code: string }> }; valueQuantity: { value: number } }> };
    expect(obs.code.coding[0]?.code).toBe('55284-4');
    expect(obs.component.map((c) => c.code.coding[0]?.code)).toEqual(['8480-6', '8462-4']);
    expect(obs.component.map((c) => c.valueQuantity.value)).toEqual([128, 78]);
  });

  it('no coded reason or indication is invented', () => {
    const [admit] = emit({ kind: 'admit-patient', patientId: 'p', facilityId: 'f', unitId: 'u', reason: 'fluid overload' });
    const reason = (admit as { reasonCode?: Array<Record<string, unknown>> }).reasonCode?.[0];
    expect(reason).toEqual({ text: 'fluid overload' });
    expect(reason?.coding).toBeUndefined();
  });
});
