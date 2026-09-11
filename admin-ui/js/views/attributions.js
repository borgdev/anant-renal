import { api } from '../core/api.js';
import { emptyStateHTML, errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export async function renderAttributions() {
  main.innerHTML = scopeShell('Consequence attributions', 'After an episode closes, downstream world effects are matched to attribution rules; matches shape the agent’s self-model preferences. This is how experience becomes character.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const [aRes, epsRes] = await Promise.all([
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}/attributions`),
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}/episodes`),
      ]);
      const attrs = aRes.attributions || [];
      const stats = aRes.stats || { total: 0, byOutcome: {}, byRule: {}, openWindows: 0 };
      const eps = new Map((epsRes.episodes || []).map((e) => [e.episodeId, e]));
      const pillFor = (o) => o === 'positive' ? 'good' : o === 'negative' ? 'bad' : 'muted';
      setScopeHint(`${stats.total} total · ${stats.openWindows ?? 0} open window(s)`);
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">
          <div class="section-card" style="margin:0;"><div style="font-size:22px;font-weight:600;color:var(--brand)">${stats.total}</div><div class="muted" style="font-size:11px;">total attributions</div></div>
          <div class="section-card" style="margin:0;"><div style="font-size:22px;font-weight:600;color:var(--good)">${stats.byOutcome?.positive ?? 0}</div><div class="muted" style="font-size:11px;">positive</div></div>
          <div class="section-card" style="margin:0;"><div style="font-size:22px;font-weight:600;color:var(--bad)">${stats.byOutcome?.negative ?? 0}</div><div class="muted" style="font-size:11px;">negative</div></div>
          <div class="section-card" style="margin:0;"><div style="font-size:22px;font-weight:600;">${stats.openWindows ?? 0}</div><div class="muted" style="font-size:11px;">episodes still in window</div></div>
        </div>`;
      if (!attrs.length) { body.innerHTML += emptyStateHTML('No attributions yet', 'Close some episodes, then let downstream world effects arrive within the attribution window.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML += '';
      body.innerHTML += '<div id="scope-grid"></div>';
      dataGrid({
        el: 'scope-grid', stateKey: 'attributions-scope', filename: 'attributions', pageSize: 15, empty: 'No attributions yet.',
        columns: [
          { key: 'attributedAt', label: 'Attributed at', render: (v) => `<span class="muted">${esc(v || '')}</span>` },
          { key: 'ruleId', label: 'Rule', render: (v) => `<code>${esc(v)}</code>` },
          { key: 'outcome', label: 'Outcome', render: (_v, a) => `<span class="pill ${pillFor(a.consequence?.outcome)}">${esc(a.consequence?.outcome)}</span>` },
          { key: 'weight', label: 'Weight', render: (_v, a) => (a.consequence?.weight ?? 0).toFixed(2) },
          { key: 'kind', label: 'Kind', render: (_v, a) => `<code>${esc(a.consequence?.kind)}</code>` },
          { key: 'presenceId', label: 'Presence', render: (v) => `<span class="muted" style="font-size:11px;">${esc((v || '').slice(0, 8))}…</span>` },
          { key: 'episode', label: 'Episode', render: (_v, a) => { const ep = eps.get(a.episodeId); return ep ? `<code>${esc(ep.agentSpecId)}</code> <span class="muted">(${esc(ep.localGoal)})</span>` : `<code style="font-size:11px;">${esc((a.episodeId || '').slice(0, 10))}…</code>`; } },
        ],
        data: attrs,
      });
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}
