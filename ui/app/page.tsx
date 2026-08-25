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

export default function Home() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Healthcare Harness</h1>
      <div className="hh-card">
        <h2>What this is</h2>
        <p>Model-agnostic, hypergraph-native harness that compiles healthcare intent + local data into deployable, auditable applications. Dialysis is the reference implementation; core is generic across provider, payer, health-system, and practice organizations.</p>
      </div>
      <div className="hh-grid">
        <div className="hh-card">
          <h2>Replay snapshot</h2>
          <div className="hh-kv"><span className="k">Events processed</span><span>{demo.eventCount}</span></div>
          <div className="hh-kv"><span className="k">Emitted signals</span><span>{demo.emittedCount}</span></div>
          <div className="hh-kv"><span className="k">Missed-treatment cases</span><span>{demo.caseCount}</span></div>
          <div className="hh-kv"><span className="k">Worst DQ severity</span><span>{demo.worstSeverity ?? 'clean'}</span></div>
          <div className="hh-kv"><span className="k">Audit chain valid</span><span>{demo.auditValid ? 'yes' : 'no'}</span></div>
        </div>
        <div className="hh-card">
          <h2>Registered packs</h2>
          {demo.packs.map((p) => (
            <div key={p.id} className="hh-kv"><span className="k">{p.id}</span><span>{p.version}</span></div>
          ))}
        </div>
        <div className="hh-card">
          <h2>Quality measures</h2>
          {demo.measures.map((m) => (
            <div key={m.id} className="hh-kv">
              <span className="k">{m.id}</span>
              <span>{m.score === undefined ? '—' : `${(m.score * 100).toFixed(0)}%`}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
