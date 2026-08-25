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

export default function AuditPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Audit ledger</h1>
      <div className="hh-card">
        <div className="hh-kv"><span className="k">Chain valid</span><span>{demo.auditValid ? 'yes' : 'no'}</span></div>
        <div className="hh-kv"><span className="k">Entries</span><span>{demo.audit.length}</span></div>
      </div>
      <div className="hh-card">
        <table className="hh-table">
          <thead><tr><th>#</th><th>Action</th><th>Actor</th><th>Hash</th></tr></thead>
          <tbody>
            {demo.audit.map((a) => (
              <tr key={a.sequence}><td>{a.sequence}</td><td>{a.action}</td><td>{a.actorId}</td><td><code>{a.hash}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
