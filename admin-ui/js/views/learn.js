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

import { consoleLearn } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';

export async function renderLearn() {
  const recipes = await consoleLearn();
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Learn</h2><p class="page-sub">Short recipes for the most common Knowledge, Realm, and Agent workflows. Each one has a scoped Run-it-now.</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px">
      ${recipes.map(r => `<div class="card" style="padding:16px;border:1px solid var(--border);border-radius:8px">
        <h3 style="margin:0 0 6px">${esc(r.title)}</h3>
        <p style="color:#555">${esc(r.body)}</p>
        <button class="btn primary" onclick="nav.querySelector('[data-view=${r.action.view}]').click()">${esc(r.action.label)}</button>
      </div>`).join('')}
    </div>
  `;
}
