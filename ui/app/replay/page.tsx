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

import { runDemoReplay } from '@/lib/demo-data';

export default function ReplayPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Replay viewer</h1>
      <div className="hh-card">
        <h2>Batch summary</h2>
        <div className="hh-kv"><span className="k">Events</span><span>{demo.eventCount}</span></div>
        <div className="hh-kv"><span className="k">Emitted signals</span><span>{demo.emittedCount}</span></div>
        <div className="hh-kv"><span className="k">Cases opened</span><span>{demo.caseCount}</span></div>
        <div className="hh-kv"><span className="k">Worst DQ severity</span><span>{demo.worstSeverity ?? 'clean'}</span></div>
      </div>
      <div className="hh-card">
        <h2>Measure evaluations</h2>
        <table className="hh-table">
          <thead><tr><th>Measure</th><th>Numerator</th><th>Denominator</th><th>Score</th></tr></thead>
          <tbody>
            {demo.measures.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td>{m.numerator ?? '—'}</td>
                <td>{m.denominator ?? '—'}</td>
                <td>{m.score === undefined ? '—' : `${(m.score * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
