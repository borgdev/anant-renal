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

import { api } from '../core/api.js';
import { emptyStateHTML, errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export async function renderEpisodes() {
  main.innerHTML = scopeShell('Episodes', 'Every meaningful moment for an agent is an Episode — structured, hashed, replayable. This is the corpus of world play.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const r = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}/episodes`);
      const rows = r.episodes || [];
      setScopeHint(`${rows.length} episode${rows.length === 1 ? '' : 's'}`);
      if (!rows.length) { body.innerHTML = emptyStateHTML('No episodes yet', 'Spawn presences and tick the clock — episodes open around meaningful agent moments.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'episodes-scope', filename: 'episodes', pageSize: 15, empty: 'No episodes yet.',
        columns: [
          { key: 'openedAt', label: 'Opened', render: (v) => `<span class="muted">${esc(v || '')}</span>` },
          { key: 'agentSpecId', label: 'Agent', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'role', label: 'Role', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
          { key: 'localGoal', label: 'Local goal' },
          { key: 'fx', label: 'Effects', render: (_v, e) => { const k = (e.effects || []).map((x) => x.kind).slice(0, 3); return `${e.effects?.length ?? 0} <span class="muted">${k.length ? `(${esc(k.join(', '))})` : ''}</span>`; } },
          { key: 'importance', label: 'Importance', render: (v) => `<span class="pill ${v === 'critical' ? 'bad' : v === 'notable' ? 'warn' : 'muted'}">${esc(v)}</span>` },
          { key: 'status', label: 'Status', render: (v) => `<span class="pill ${v === 'pruned' ? 'muted' : v === 'closed' ? 'good' : 'brand'}">${esc(v)}</span>` },
          { key: 'hash', label: 'Hash', render: (v) => `<code style="font-size:11px;">${esc(v)}</code>` },
          { key: '_actions', label: '', sortable: false, filter: false, render: (_v, e) => e.status === 'closed' ? `<button class="btn btn-ghost" onclick="window.replayEpisode('${esc(e.episodeId)}')">Replay</button>` : '<span class="muted">—</span>' },
        ],
        data: rows,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}
