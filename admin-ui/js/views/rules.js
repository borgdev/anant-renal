import { api } from '../core/api.js';
import { errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons } from '../core/theme.js';

export async function renderRules() {
  main.innerHTML = scopeShell('World rules', 'Rules govern the physics of the world — declarative YAML for policies, TS modules for advanced physics. Both produce Experiences.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const r = await api('GET', `/admin/realms/${encodeURIComponent(realmId)}`);
      const rules = r.rules ?? { yaml: [], ts: [] };
      const yaml = rules.yaml || [];
      const ts = rules.ts || [];
      setScopeHint(`${yaml.length} YAML · ${ts.length} TS`);
      body.innerHTML = `
        <div class="section-card"><h3>YAML rules (${yaml.length})</h3>
          ${yaml.length === 0 ? '<div class="muted" style="font-size:13px;">No YAML rules registered.</div>' : yaml.map((y) => `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;"><code>${esc(y.id)}</code><span class="pill muted">${esc(y.on)}</span></div><div class="muted" style="margin-top:4px;font-size:12px;">${esc(y.description)}</div><div style="margin-top:6px;font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);">when: ${esc(JSON.stringify(y.when))} then: ${esc(JSON.stringify(y.then))}</div></div>`).join('')}
        </div>
        <div class="section-card"><h3>TS module rules (${ts.length})</h3>
          ${ts.length === 0 ? '<div class="muted" style="font-size:13px;">No TS rules registered.</div>' : ts.map((t) => `<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;"><code>${esc(t.id)}</code><div class="muted" style="margin-top:4px;font-size:12px;">${esc(t.description)}</div></div>`).join('')}
        </div>`;
      if (window.hydrateIcons) window.hydrateIcons();
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}
