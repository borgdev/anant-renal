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
import { AssessmentRegistry, PHQ9, GAD7, BRADEN, CAM_DELIRIUM, ALL_ASSESSMENTS } from '../src/assessments/library.js';

describe('AssessmentRegistry', () => {
  const reg = new AssessmentRegistry();

  it('registers 13+ instruments across domains', () => {
    expect(ALL_ASSESSMENTS.length).toBeGreaterThanOrEqual(13);
    expect(reg.listByDomain('mental-health').length).toBeGreaterThanOrEqual(2);
    expect(reg.listByDomain('function').length).toBeGreaterThanOrEqual(2);
  });
  it('scores PHQ-9 with band interpretation', () => {
    const r = reg.score(PHQ9.id, { q1:3,q2:3,q3:2,q4:2,q5:2,q6:2,q7:1,q8:1,q9:0 });
    expect(r.total).toBe(16);
    expect(r.band.label).toBe('Moderately severe');
    expect(r.band.triggersAgentId).toBe('depression-follow-up');
  });
  it('scores GAD-7 and lands mild', () => {
    const r = reg.score(GAD7.id, { q1:1,q2:1,q3:1,q4:1,q5:1,q6:1,q7:1 });
    expect(r.total).toBe(7);
    expect(r.band.label).toBe('Mild');
  });
  it('scores Braden and triggers pressure-injury prevention on high risk', () => {
    const r = reg.score(BRADEN.id, { sensory:1, moisture:1, activity:1, mobility:1, nutrition:2, friction:1 });
    expect(r.total).toBe(7);
    expect(r.band.triggersAgentId).toBe('pressure-injury-prevention');
  });
  it('evaluates CAM by formula', () => {
    const neg = reg.score(CAM_DELIRIUM.id, { acute:true, inattention:false, disorganized:true, alteredLoc:false });
    expect(neg.total).toBe(0);
    const pos = reg.score(CAM_DELIRIUM.id, { acute:true, inattention:true, disorganized:false, alteredLoc:true });
    expect(pos.total).toBe(1);
    expect(pos.band.triggersAgentId).toBe('delirium-workup');
  });
});
