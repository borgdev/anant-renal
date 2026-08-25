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
import { LifecycleRegistry, LIFECYCLE_STAGES, LongitudinalRecord, reconcileMedications } from '../src/lifecycle/index.js';

describe('LifecycleRegistry', () => {
  const reg = new LifecycleRegistry();
  it('covers full lifecycle', () => {
    const stages = LIFECYCLE_STAGES.map((s) => s.stage);
    for (const s of ['pre-registration','onboarding','active-care','transition-of-care','transplant-workup','post-transplant','palliative','hospice','bereavement','inactive','discharged']) {
      expect(stages).toContain(s);
    }
  });
  it('enforces legal transitions', () => {
    expect(reg.canTransition('onboarding', 'active-care')).toBe(true);
    expect(reg.canTransition('bereavement', 'active-care')).toBe(false);
  });
  it('resolves agent hooks by event', () => {
    const hooks = reg.agentsFor('onboarding', 'patient.arrived');
    expect(hooks).toContain('medication-reconciliation');
    expect(hooks).toContain('identity-verification');
  });
});

describe('LongitudinalRecord', () => {
  it('supports time-slicing and setting filtering', () => {
    const lr = new LongitudinalRecord();
    lr.append({ nodeId:'n1', patientId:'p1', kind:'problem', recordedAt:'2026-01-01T00:00:00Z', effectiveFrom:'2026-01-01', setting:'primary-care', coding:[{system:'icd-10-cm',code:'E11.9'}], authorRef:'user:clinician1', high:false } as never);
    lr.append({ nodeId:'n2', patientId:'p1', kind:'medication', recordedAt:'2026-02-01T00:00:00Z', effectiveFrom:'2026-02-01', setting:'primary-care', coding:[{system:'rxnorm',code:'866426'}], authorRef:'user:clinician1' } as never);
    const asOf = lr.query({ patientId:'p1', asOf:'2026-01-15' });
    expect(asOf.length).toBe(1);
    const meds = lr.currentMedicationList('p1');
    expect(meds.length).toBe(1);
  });
});

describe('reconcileMedications', () => {
  it('detects continued, held, new, and modified meds; flags high-alert', () => {
    const r = reconcileMedications({
      patientId:'p1', encounterId:'e1', targetSource:'discharge',
      homeList: [
        { rxnorm:'866426', display:'Metformin 500 MG', dose:'500 MG', frequency:'BID', source:'home', high:false },
        { rxnorm:'856987', display:'Warfarin 5 MG', dose:'5 MG', frequency:'QD', source:'home', high:true },
      ],
      currentList: [
        { rxnorm:'866426', display:'Metformin 500 MG', dose:'1000 MG', frequency:'BID', source:'inpatient', high:false },
        { rxnorm:'855332', display:'Apixaban 5 MG', dose:'5 MG', frequency:'BID', source:'inpatient', high:true },
      ],
    });
    const types = r.changes.map((c) => c.changeType);
    expect(types).toContain('modified');
    expect(types).toContain('held');
    expect(types).toContain('new');
    expect(r.flags.some((f) => f.startsWith('high-alert-'))).toBe(true);
  });
});
