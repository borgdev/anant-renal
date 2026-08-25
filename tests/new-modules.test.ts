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
import {
  TerminologyService,
  seedValueSets,
  canonicalUSCDIBindings,
  findBinding,
  CMSSourceRegistry,
  seedCMSSources,
  compileRuleCandidates,
  extractObligations,
  DQFramework,
  completenessRule,
  uniquenessRule,
  provenanceRule,
  reconciliationRule,
  isNonDeviceCDSCompliant,
  validateDeviceObservation,
  deviceObservationToEvents,
  AuditLedger,
} from '../src/index.js';
import {
  JobQueue,
  BreakGlassLedger,
  FeatureFlagRegistry,
  fnv1aHash,
  detectDrift,
  CrossPackRouter,
} from '../src/control-plane/index.js';
import { InMemorySecretsProvider, AuditingSecretsProvider } from '../src/control-plane/secrets.js';
import { parseX12, x12ToEvents, parseCDA, cdaToEvents, claimsRowsToEvents, hieNotificationToEvent } from '../src/adapters/index.js';
import { decideUMCase } from '../packs/payer/utilization-management.js';
import { stratifyRisk } from '../packs/payer/care-management.js';
import { evaluateEligibility } from '../packs/payer/network-and-benefits.js';
import { adjudicateClaim } from '../packs/payer/claims-operations.js';
import { decideAppeal } from '../packs/payer/appeals.js';
import { evaluateAnemia } from '../packs/dialysis-provider/medication/index.js';
import { evaluateProtocol } from '../packs/dialysis-provider/protocol-compliance/index.js';
import { evaluateIDWG, evaluateNutrition } from '../packs/dialysis-provider/nutrition/index.js';
import { detectRecurrence } from '../packs/dialysis-provider/transport/index.js';
import { generateQAPIPacket } from '../packs/dialysis-provider/qapi-evidence/index.js';

describe('terminology', () => {
  it('resolves seed value sets and tests membership', () => {
    const svc = new TerminologyService();
    const vs = svc.resolve('vs:ckd.stages');
    expect(vs.codes.length).toBeGreaterThan(0);
    expect(svc.contains('vs:ckd.stages', { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'N18.6' })).toBe(true);
    expect(svc.contains('vs:ckd.stages', { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'NOPE' })).toBe(false);
  });
  it('ships seed sets non-empty', () => {
    expect(seedValueSets.length).toBeGreaterThanOrEqual(5);
  });
});

describe('USCDI bindings', () => {
  it('maps harness event types to USCDI classes', () => {
    expect(canonicalUSCDIBindings.length).toBeGreaterThan(5);
    expect(findBinding('lab.result')?.uscdiId).toBe('uscdi:laboratory');
    expect(findBinding('unknown-type')).toBeUndefined();
  });
});

describe('CMS source registry', () => {
  it('ships seed sources and detects changes', () => {
    const r = new CMSSourceRegistry();
    for (const s of seedCMSSources) r.registerSource(s);
    expect(r.listSources().length).toBe(seedCMSSources.length);
    const change = r.recordChange({ sourceId: 'cms:esrd:qip', newVersion: 'PY-2028', changeSummary: 'threshold change' });
    expect(change.action).toBe('pack-review-required');
    expect(change.impactedPacks).toContain('dialysis-provider');
  });
});

describe('document rule-candidate compiler', () => {
  it('extracts obligation sentences and numeric hints', () => {
    const doc = {
      id: 'doc:example',
      authority: 'regulation' as const,
      title: 'Example Reg',
      version: '1',
      effectiveFrom: '2026-01-01',
      steward: 'CMS',
      text: 'The facility must notify CMS within 24 hours. Dosages shall not exceed 100 mg per treatment.',
      ingestedAt: '2026-01-02',
    };
    const obligations = extractObligations(doc.text);
    expect(obligations.length).toBe(2);
    const candidates = compileRuleCandidates(doc);
    expect(candidates[0]?.obligationVerb).toBe('must');
    expect(candidates.some((c) => c.timeframeHints.length > 0)).toBe(true);
    expect(candidates.some((c) => c.numericHints.length > 0)).toBe(true);
  });
});

describe('DQ framework', () => {
  it('runs all rule categories and quarantines critical findings', () => {
    const fw = new DQFramework();
    fw.register(completenessRule('rq:req', ['value'], ['lab.result-arrived']));
    fw.register(uniquenessRule('rq:uniq', ['lab.result-arrived']));
    fw.register(provenanceRule('rq:prov'));
    fw.register(reconciliationRule('rq:recon', 'claim.submitted', 'claim.remittance', 'claimId'));
    const events = [
      { id: 'a', type: 'lab.result-arrived' as const, occurredAt: '2026-01-01', scopeId: 's', subjectId: 'p', facilityId: 'f', payload: {}, provenance: { sourceId: 'x', observedAt: '2026-01-01', ingestedAt: '2026-01-01' }, classification: 'phi' as const },
      { id: 'a', type: 'lab.result-arrived' as const, occurredAt: '2026-01-01', scopeId: 's', subjectId: 'p', facilityId: 'f', payload: { value: 5 }, provenance: { sourceId: 'x', observedAt: '2026-01-01', ingestedAt: '2026-01-01' }, classification: 'phi' as const },
    ];
    const { findings, quarantined } = fw.gateAndQuarantine(events);
    expect(findings.length).toBeGreaterThan(0);
    expect(quarantined.length).toBeGreaterThan(0);
  });
});

describe('audit uses SHA-256', () => {
  it('produces 64-char hex hashes and detects tampering', () => {
    const l = new AuditLedger();
    l.append({ id: '1', occurredAt: '2026-01-01', actorId: 'u', scopeId: 's', action: 'act', traceId: 't', payload: {} });
    l.append({ id: '2', occurredAt: '2026-01-02', actorId: 'u', scopeId: 's', action: 'act', traceId: 't', payload: {} });
    const all = l.all();
    expect(all[0]!.hash.length).toBe(64);
    expect(l.verify()).toBeNull();
    (l as unknown as { events: Array<Record<string, unknown>> }).events[0] = { ...all[0], actorId: 'evil' };
    expect(l.verify()).toBe(0);
  });
});

describe('adapters', () => {
  it('X12 271 → coverage.active event', () => {
    const raw = 'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260101*1200*U*00401*000000001*0*P*:~ST*271*0001~NM1*IL*1*DOE*JOHN****MI*MEMBER123~EB*1*IND*30*HM~SE*4*0001~';
    const env = parseX12(raw);
    const events = x12ToEvents(env, { facilityId: 'f', scopeId: 's', sourceId: 'src', ingestedAt: '2026-01-01' });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('coverage.active');
    expect(events[0]?.subjectId).toBe('MEMBER123');
  });
  it('CDA extracts sections and maps to events', () => {
    const xml = '<ClinicalDocument><title>CCD</title><effectiveTime value="2026-01-01"/><patient><id extension="P1"/></patient><section><code code="30954-2"/><title>Results</title><text>Hgb 10.2</text></section></ClinicalDocument>';
    const doc = parseCDA(xml);
    const events = cdaToEvents(doc, { facilityId: 'f', scopeId: 's', sourceId: 'cda', ingestedAt: '2026-01-02' });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('lab.result-arrived');
  });
  it('claims file rows produce denied/remittance/submitted events', () => {
    const evs = claimsRowsToEvents(
      [
        { claimId: 'c1', memberId: 'm1', serviceDate: '2026-01-01', cpt: '90999', icd10: 'N18.6', chargeAmount: 500, payerId: 'p1' },
        { claimId: 'c2', memberId: 'm1', serviceDate: '2026-01-02', cpt: '90999', icd10: 'N18.6', chargeAmount: 500, paidAmount: 400, payerId: 'p1' },
        { claimId: 'c3', memberId: 'm1', serviceDate: '2026-01-03', cpt: '90999', icd10: 'N18.6', chargeAmount: 500, denialReason: 'CO-45', payerId: 'p1' },
      ],
      { facilityId: 'f', scopeId: 's', sourceId: 'src', ingestedAt: '2026-01-04' },
    );
    expect(evs.map((e) => e.type)).toEqual(['claim.submitted', 'claim.remittance', 'claim.denied']);
  });
  it('HIE admit notification maps correctly', () => {
    const e = hieNotificationToEvent(
      { notificationId: 'n1', notificationType: 'admit', patientRef: 'p1', facility: 'Hosp', occurredAt: '2026-01-01' },
      { facilityId: 'f', scopeId: 's', sourceId: 'hie', ingestedAt: '2026-01-01' },
    );
    expect(e.type).toBe('hospitalization.admitted');
  });
});

describe('payer', () => {
  it('UM case decision honors CMS-0057-F SLAs', () => {
    const d = decideUMCase(
      { caseId: 'c1', memberId: 'm1', serviceCode: '90999', requestedAt: '2026-01-01', urgency: 'expedited', submittedBy: 'p', clinicalDocumentIds: [] },
      '2026-01-01T01:00:00Z',
      () => ({ outcome: 'approved', reasonCode: 'MEDICALLY_NECESSARY', basis: ['MCG-CH-1'], criteriaDocumentId: 'mcg', criteriaVersion: '2026' }),
      { ref: 'r', role: 'md' },
    );
    expect(d.slaHours).toBe(72);
    expect(d.outcome).toBe('approved');
  });
  it('claims adjudication produces a result', () => {
    const r = adjudicateClaim(
      { claimId: 'c', memberId: 'm', cpt: '90999', icd10: 'N18.6', chargeAmount: 100, coveredAt: '2026-01-01' },
      { id: 'rs', version: '1', adjudicate: () => ({ outcome: 'paid', paidAmount: 80, eob: [{ code: 'CO-45', amount: 20, reason: 'contractual' }] }) },
      '2026-01-01',
    );
    expect(r.outcome).toBe('paid');
    expect(r.paidAmount).toBe(80);
  });
  it('appeal escalates when upheld', () => {
    const d = decideAppeal(
      { appealId: 'a', originalCaseId: 'c', memberId: 'm', submittedAt: '2026-01-01', level: 'internal-first', rationale: 'r', supportingDocumentIds: [], newClinicalEvidence: [] },
      'upheld', 'no new evidence', { ref: 'r', role: 'md' }, 'standard', '2026-01-02',
    );
    expect(d.nextLevelAvailable).toBe('internal-second');
  });
  it('risk stratification', () => {
    const r = stratifyRisk({ memberId: 'm', ageYears: 78, recentEDVisits: 3, recentAdmissions: 2, chronicConditionCount: 4, medicationCount: 10 });
    expect(r.tier).toBe('complex');
  });
  it('eligibility inactive if terminated', () => {
    const a = evaluateEligibility({ memberId: 'm', planId: 'plan', effectivePeriod: { from: '2025-01-01', to: '2025-12-31' }, status: 'terminated', benefits: [] }, '2026-01-01');
    expect(a.active).toBe(false);
  });
});

describe('dialysis pack sub-packs', () => {
  it('anemia rules detect Hgb-below-9 not on ESA', () => {
    const flags = evaluateAnemia({ currentHgb: 8.5, onESA: false, esaEscalationsLast90d: 0, hgbTrendLast90d: [], lastIronPanelAt: '2026-01-01', asOf: '2026-01-02' });
    expect(flags).toContain('hgb-below-9-not-on-esa');
  });
  it('protocol deviation detects shortened treatment', () => {
    const rx = { patientId: 'p', effectiveFrom: '2026-01-01', bloodFlowMlMin: 400, dialysateFlowMlMin: 600, dialysateCompositionRef: 'std', targetKtV: 1.4, treatmentLengthMinutes: 240, ultrafiltrationGoalMl: 3000, prescriberRef: 'md' };
    const delivered = { treatmentId: 't', patientId: 'p', startedAt: '2026-01-01T08:00Z', endedAt: '2026-01-01T11:30Z', bloodFlowMlMinActual: 400, dialysateFlowMlMinActual: 600, treatmentLengthMinutesActual: 210, ultrafiltrationMlActual: 3000, complications: [] };
    const deviations = evaluateProtocol(rx, delivered, '2026-01-01T12:00Z');
    expect(deviations.some((d) => d.deviation === 'shortened-treatment')).toBe(true);
  });
  it('IDWG > 5% flags', () => {
    const flags = evaluateIDWG({ patientId: 'p', currentTreatmentAt: '2026-01-01', gainKg: 5, gainPctOfDryWeight: 6, toleratedUltrafiltrationRate: 'within-limits' });
    expect(flags).toContain('excess-idwg');
  });
  it('nutrition albumin < 3.5', () => {
    const flags = evaluateNutrition({ patientId: 'p', assessedAt: '2026-01-01', albuminGdL: 3.2 });
    expect(flags).toContain('albumin-below-3.5');
  });
  it('transport recurrence detector', () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400000).toISOString();
    const yesterday = new Date(now.getTime() - 86400000).toISOString();
    const incidents = [
      { incidentId: '1', patientId: 'p', occurredAt: twoDaysAgo, barrier: 'weather' as const, resultedInMissedTreatment: true, rescheduleAttempted: false },
      { incidentId: '2', patientId: 'p', occurredAt: yesterday, barrier: 'weather' as const, resultedInMissedTreatment: true, rescheduleAttempted: false },
    ];
    expect(detectRecurrence(incidents)).toBe(true);
  });
  it('QAPI packet flags missing IDT roles', () => {
    const packet = generateQAPIPacket({
      facilityId: 'f',
      reviewFrom: '2026-01-01', reviewTo: '2026-03-31',
      plan: { facilityId: 'f', version: '1', effectiveFrom: '2026-01-01', interdisciplinaryTeam: [{ ref: 'md1', role: 'medical-director' }], meetingCadence: 'monthly', priorityAreas: [], writtenPolicyDocumentId: 'd' },
      projects: [],
      investigations: [],
      dqFindings: [],
      generatedBy: 'system',
      now: '2026-04-01',
    });
    expect(packet.cmsSurveyReady).toBe(false);
    expect(packet.gaps.some((g) => g.includes('facility-administrator'))).toBe(true);
  });
});

describe('control-plane ops', () => {
  it('job queue retries with backoff and dead-letters', async () => {
    const q = new JobQueue({ now: () => new Date('2026-01-01T00:00:00Z') });
    let calls = 0;
    q.registerHandler({
      kind: 'test',
      maxAttempts: 2,
      initialBackoffMs: 1000,
      maxBackoffMs: 5000,
      async handle() { calls++; throw new Error('boom'); },
    });
    q.enqueue('test', { x: 1 }, 'idem-1', 'trace-1');
    await q.runOnce(new Date('2026-01-01T00:00:10Z'));
    await q.runOnce(new Date('2026-01-01T00:10:00Z'));
    expect(q.deadLetterQueue().length).toBe(1);
    expect(calls).toBe(2);
  });
  it('secrets provider logs access', async () => {
    const inner = new InMemorySecretsProvider();
    await inner.set('k', 'v');
    const audited = new AuditingSecretsProvider(inner, () => ({ ref: 'u', purpose: 'test' }));
    await audited.get('k');
    expect(audited.audit().length).toBe(1);
  });
  it('break-glass ledger records reason and expiry', () => {
    const l = new BreakGlassLedger();
    const g = l.request({
      requestedAt: '2026-01-01T00:00:00Z', actorRef: 'u', patientRef: 'p',
      reason: 'code-blue', clinicalNecessityStatement: 'active resuscitation',
      elevatedScopeIds: ['scope:emergency'], maxDurationMinutes: 60,
    });
    expect(g.expiresAt).toBe('2026-01-01T01:00:00.000Z');
    expect(l.unreviewed().length).toBe(1);
  });
  it('feature flag percentage rollout is deterministic', () => {
    const r = new FeatureFlagRegistry();
    r.register({ id: 'f1', description: '', defaultValue: false, rules: [{ kind: 'percentage', percent: 100, saltHash: fnv1aHash }] });
    expect(r.evaluate('f1', { subjectRef: 'x', attributes: {} })).toBe(true);
  });
  it('schema drift detects removed field', () => {
    const findings = detectDrift(
      { id: 'b', eventType: 't', version: '1', fields: [{ name: 'a', type: 'string', required: true }, { name: 'b', type: 'number', required: false }] },
      [{ name: 'a', type: 'string', required: true }],
    );
    expect(findings.some((f) => f.kind === 'removed-field' && f.breaking)).toBe(true);
  });
  it('cross-pack router matches by event and pack', () => {
    const r = new CrossPackRouter();
    const matches = r.routeEvent('prior-auth.denied', 'payer');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.actions.some((a) => a.kind === 'open-case')).toBe(true);
  });
});

describe('device gateway + CDS attestation', () => {
  it('validates observation provenance', () => {
    const bad = { deviceRef: 'd', encounterRef: 'e', patientRef: 'p', observedAt: '2026-01-01', observations: [], gatewayProvenance: { gatewayId: '', gatewayVersion: '1', signedAt: '' } };
    const v = validateDeviceObservation(bad);
    expect(v.valid).toBe(false);
  });
  it('produces device.observation events', () => {
    const evs = deviceObservationToEvents(
      { deviceRef: 'dev', encounterRef: 'enc', patientRef: 'p', observedAt: '2026-01-01', deviceFdaProductCode: 'ABC', observations: [{ loincCode: 'KTV-DEL', value: 1.5, unit: 'ratio', aggregationWindow: '15min' }], gatewayProvenance: { gatewayId: 'g', gatewayVersion: '1', signedAt: '2026-01-01' } },
      { scopeId: 's', facilityId: 'f', ingestedAt: '2026-01-01' },
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe('device.observation');
  });
  it('non-device CDS compliance validator', () => {
    const compliant = isNonDeviceCDSCompliant({
      recommendationId: 'r', issuedAt: '2026-01-01', issuedBy: 'agent',
      fdaCategoryHint: 'non-device-cds',
      nonDeviceCdsCriteria: { notMakingSpecificRecommendation: false, clinicianCanIndependentlyReview: true, disclosesSourceData: true, disclosesLogicOrBasis: true, disclosesLimitations: true },
      oncDsi: { kind: 'not-dsi' }, inputRefs: [], rationaleText: '', warnings: [],
    });
    expect(compliant).toBe(true);
  });
});
