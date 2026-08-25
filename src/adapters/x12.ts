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

// X12 EDI adapter (270/271 eligibility, 278 prior-auth, 837/835 claims/remit).
// Segments delimited by '~', elements by '*', composites by ':'.

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export type X12TxSet = '270' | '271' | '278' | '837' | '835';

export interface X12Envelope {
  readonly interchangeControl: string;
  readonly transactionSet: X12TxSet;
  readonly senderId: string;
  readonly receiverId: string;
  readonly segments: readonly X12Segment[];
}

export interface X12Segment {
  readonly tag: string;
  readonly elements: readonly (string | readonly string[])[];
}

export interface X12MappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

const SEG = '~';
const ELE = '*';
const COMP = ':';

function parseSegments(raw: string): X12Segment[] {
  return raw
    .split(SEG)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map<X12Segment>((segRaw) => {
      const parts = segRaw.split(ELE);
      const tag = parts[0] ?? '';
      const elements = parts.slice(1).map((e) => (e.includes(COMP) ? e.split(COMP) : e));
      return { tag, elements };
    });
}

export function parseX12(raw: string): X12Envelope {
  const segments = parseSegments(raw);
  const isa = segments.find((s) => s.tag === 'ISA');
  const st = segments.find((s) => s.tag === 'ST');
  if (!isa || !st) throw new Error('X12: missing ISA or ST segment');
  const stFirst = st.elements[0];
  const txCode = typeof stFirst === 'string' ? stFirst : '';
  if (!['270', '271', '278', '837', '835'].includes(txCode)) {
    throw new Error(`X12: unsupported transaction set ${txCode}`);
  }
  const senderEl = isa.elements[5];
  const receiverEl = isa.elements[7];
  const isaEl13 = isa.elements[12];
  return {
    interchangeControl: typeof isaEl13 === 'string' ? isaEl13 : '',
    transactionSet: txCode as X12TxSet,
    senderId: typeof senderEl === 'string' ? senderEl.trim() : '',
    receiverId: typeof receiverEl === 'string' ? receiverEl.trim() : '',
    segments,
  };
}

const txToType: Record<X12TxSet, CanonicalEventType> = {
  '270': 'coverage.inquiry',
  '271': 'coverage.active',
  '278': 'prior-auth.submitted',
  '837': 'claim.submitted',
  '835': 'claim.remittance',
};

export function x12ToEvents(env: X12Envelope, opts: X12MappingOptions): CanonicalEvent[] {
  const type = txToType[env.transactionSet];
  const subjectId = extractSubscriber(env);
  const payload: Record<string, unknown> = { transactionSet: env.transactionSet, senderId: env.senderId };
  if (env.transactionSet === '271') payload['eligibility'] = extractEB(env);
  if (env.transactionSet === '837') payload['claim'] = extractCLM(env);
  if (env.transactionSet === '835') payload['remittance'] = extractBPR(env);
  return [{
    id: `event:x12:${env.transactionSet}:${env.interchangeControl}`,
    type,
    occurredAt: opts.ingestedAt,
    scopeId: opts.scopeId,
    subjectId,
    facilityId: opts.facilityId,
    payload,
    provenance: { sourceId: opts.sourceId, observedAt: opts.ingestedAt, ingestedAt: opts.ingestedAt },
    classification: 'phi',
  }];
}

function extractSubscriber(env: X12Envelope): string {
  const nm1 = env.segments.find((s) => {
    if (s.tag !== 'NM1') return false;
    const first = s.elements[0];
    return typeof first === 'string' && first === 'IL';
  });
  if (!nm1) return 'unknown-subscriber';
  const memberEl = nm1.elements[8];
  return typeof memberEl === 'string' ? memberEl : 'unknown-subscriber';
}

function extractEB(env: X12Envelope): Record<string, unknown> {
  const eb = env.segments.find((s) => s.tag === 'EB');
  if (!eb) return {};
  const first = eb.elements[0];
  const third = eb.elements[2];
  const fourth = eb.elements[3];
  return {
    eligibilityCode: typeof first === 'string' ? first : '',
    serviceType: typeof third === 'string' ? third : '',
    planCoverage: typeof fourth === 'string' ? fourth : '',
  };
}

function extractCLM(env: X12Envelope): Record<string, unknown> {
  const clm = env.segments.find((s) => s.tag === 'CLM');
  if (!clm) return {};
  const patientId = clm.elements[0];
  const totalCharges = clm.elements[1];
  return {
    patientControlNumber: typeof patientId === 'string' ? patientId : '',
    totalCharges: typeof totalCharges === 'string' ? Number(totalCharges) : 0,
  };
}

function extractBPR(env: X12Envelope): Record<string, unknown> {
  const bpr = env.segments.find((s) => s.tag === 'BPR');
  if (!bpr) return {};
  const amt = bpr.elements[1];
  return { paymentAmount: typeof amt === 'string' ? Number(amt) : 0 };
}
