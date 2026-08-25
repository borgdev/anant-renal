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

export default function CasesPage() {
  const demo = runDemoReplay();
  return (
    <>
      <h1>Missed-treatment cases</h1>
      <div className="hh-card">
        <table className="hh-table">
          <thead>
            <tr><th>Case</th><th>Patient</th><th>Facility</th><th>Status</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {demo.cases.map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.patientId}</td>
                <td>{c.facilityId}</td>
                <td><span className={`hh-tag ${c.status === 'escalated' ? 'critical' : c.status === 'verifying' ? 'urgent' : ''}`}>{c.status}</span></td>
                <td>{c.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hh-card">
        <h2>Lab review queue</h2>
        <table className="hh-table">
          <thead>
            <tr><th>Lab</th><th>Patient</th><th>LOINC</th><th>Significance</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {demo.labs.map((l) => (
              <tr key={l.labId}>
                <td>{l.labId}</td>
                <td>{l.patientId}</td>
                <td>{l.loinc}</td>
                <td><span className={`hh-tag ${l.significance === 'critical' ? 'critical' : l.significance === 'urgent' ? 'urgent' : 'ok'}`}>{l.significance}</span></td>
                <td>{l.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
