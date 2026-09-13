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

import { S } from '../state.js';
import { NAV } from './nav.js';
import { esc, hydrateIcons } from './theme.js';

export function renderPageTabs() {
  const tabsEl = document.getElementById('page-tabs');
  if (!tabsEl) return;
  const group = tabbedSectionForView(S.currentView);
  if (!group) { tabsEl.style.display = 'none'; tabsEl.innerHTML = ''; return; }
  tabsEl.style.display = '';
  tabsEl.innerHTML = tabStripHTML(group);
  if (window.hydrateIcons) window.hydrateIcons();
}

export function tabStripHTML(group) {
  return group.items.map((it) => {
    const active = S.currentView === it.view ? ' active' : '';
    const count = it.count ? `<span class="count" id="${it.count}">—</span>` : '';
    return `<button class="tab${active}" data-view="${esc(it.view)}" title="${esc(it.label)}"><i data-lucide="${esc(it.icon)}"></i><span>${esc(it.label)}</span>${count}</button>`;
  }).join('');
}

export function tabbedSectionForView(view) {
  return NAV.find((g) => g.tabbed && g.items.some((it) => it.view === view)) || null;
}
