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

const COLUMNS = ['identified', 'investigating', 'intervening', 'monitoring', 'closed'] as const;

export default function QapiPage() {
  const demo = runDemoReplay();
  // Synthesize QAPI cases from missed-treatment case counts to keep the demo self-contained.
  const board: Record<(typeof COLUMNS)[number], string[]> = {
    identified: demo.cases.slice(0, 1).map((c) => `${c.id} · ${c.reason ?? 'unknown'}`),
    investigating: demo.cases.slice(1, 2).map((c) => c.id),
    intervening: [],
    monitoring: [],
    closed: [],
  };
  return (
    <>
      <h1>QAPI board</h1>
      <div className="hh-grid">
        {COLUMNS.map((col) => (
          <div key={col} className="hh-card">
            <h2>{col}</h2>
            {board[col].length === 0 ? <p>—</p> : board[col].map((c) => <div key={c} className="hh-kv"><span>{c}</span></div>)}
          </div>
        ))}
      </div>
    </>
  );
}
