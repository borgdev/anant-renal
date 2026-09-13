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

import { describe, expect, it } from 'vitest';
import { parseCsv, mapCsvRow } from '../src/adapters/csv.js';
import { parseHl7v2, mapHl7v2Message } from '../src/adapters/hl7v2-lite.js';

describe('CSV adapter', () => {
  it('parses and maps', () => {
    const rows = parseCsv('a,b\n1,2\n3,4');
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    const event = mapCsvRow(rows[0]!, {
      eventType: 'treatment.completed', subjectIdColumn: 'a', occurredAtColumn: 'b',
      facilityId: 'f', scopeId: 's', sourceId: 'demo', ingestedAt: '2026-08-01',
      payloadColumns: ['a'], classification: 'internal',
    }, 0);
    expect(event?.subjectId).toBe('1');
  });
});

describe('HL7 v2 adapter', () => {
  it('maps ADT^A01 to hospitalization.admitted', () => {
    const msg = 'MSH|^~\\&|SEND|SEND_FAC|RECV|RECV_FAC|20260801130000||ADT^A01|MSG001|P|2.5\nPID|1||P123||Doe^John';
    const seg = parseHl7v2(msg);
    expect(seg.length).toBe(2);
    const event = mapHl7v2Message(msg, { facilityId: 'f1', scopeId: 's1', sourceId: 'hl7', ingestedAt: '2026-08-01' });
    expect(event?.type).toBe('hospitalization.admitted');
    expect(event?.subjectId).toBe('P123');
  });
});

describe('FHIR adapter retirement (F0.6)', () => {
  it('has exactly one FHIR ingest path', async () => {
    // `src/adapters/fhir-lite.ts` was a second, lower-fidelity FHIR→canonical
    // mapper. It is gone; this asserts nothing re-introduces it, because two
    // FHIR paths that disagree is a silent drift bug rather than a loud one.
    const { existsSync } = await import('node:fs');
    expect(existsSync('src/adapters/fhir-lite.ts')).toBe(false);

    // And the surviving path is importable and is the one the bundle route uses.
    const canonical = await import('../src/fhir/canonical.js');
    expect(typeof canonical.ingestCanonicalEvents).toBe('function');
  });
});
