import { api } from '../core/api.js';
import { emptyStateHTML, errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export async function renderExperiences() {
  main.innerHTML = scopeShell('Experiences', 'The world produces experiences via its rules; agents perceive them and may respond.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const r = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}`);
      const rows = (r.experiences || []).slice().reverse();
      setScopeHint(`${rows.length} recent experience${rows.length === 1 ? '' : 's'}`);
      if (!rows.length) { body.innerHTML = emptyStateHTML('No experiences yet', 'Experiences are produced by world rules as the realm runs — check back after a tick.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'experiences-scope', filename: 'experiences', pageSize: 20, empty: 'No experiences yet.',
        columns: [
          { key: 'producedAt', label: 'When', render: (v) => `<span class="muted">${esc(v || '')}</span>` },
          { key: 'kind', label: 'Kind', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'severity', label: 'Severity', render: (v) => `<span class="pill ${v === 'critical' ? 'bad' : v === 'warning' ? 'warn' : v === 'notice' ? 'good' : 'muted'}">${esc(v)}</span>` },
          { key: 'ruleSource', label: 'Source', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
          { key: 'ruleId', label: 'Rule', render: (_v, r2) => `<code>${esc(r2.ruleId || '')}</code>` },
          { key: 'payload', label: 'Payload', render: (v) => `<span class="muted" style="font-size:11px;">${esc(JSON.stringify(v))}</span>` },
        ],
        data: rows,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}
