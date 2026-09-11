import { api } from '../core/api.js';
import { emptyStateHTML, errorStateHTML, loadingHTML, mountScope, scopeShell, setScopeHint } from '../core/scope.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons } from '../core/theme.js';

export async function renderSentience() {
  main.innerHTML = scopeShell('Sentience panel', 'Every agent carries a Universal Goal (know thyself) and Local Goals per episode. Free will is enacted at Choice Points where alternatives were seen and weighed.');
  await mountScope(async (realmId) => {
    const body = document.getElementById('scope-body');
    if (!body) return;
    body.innerHTML = loadingHTML();
    try {
      const [smRes, epsRes] = await Promise.all([
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}/self-models`),
        api('GET', `/admin/realms/${encodeURIComponent(realmId)}/episodes`),
      ]);
      const sms = smRes.selfModels || [];
      const eps = epsRes.episodes || [];
      setScopeHint(`${sms.length} self-model${sms.length === 1 ? '' : 's'}`);
      if (!sms.length) { body.innerHTML = emptyStateHTML('No self-models yet', 'Agents build a self-model as they run episodes and receive consequences.', '<button class="btn btn-primary" onclick="goTo(\'realm\')"><i data-lucide="building-2"></i> Open Realm management</button>'); return; }
      body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;">
        ${sms.map((s) => {
          const mine = eps.filter((e) => e.presenceId === s.presenceId);
          const critical = mine.filter((e) => e.importance === 'critical').length;
          const topEffect = Object.entries(s.effects.byKind || {}).sort((a, b) => b[1] - a[1])[0];
          const prefShifts = Object.entries(s.preferences || {}).filter(([, w]) => Math.abs(w - 1) > 0.05);
          return `<div class="section-card">
          <div style="display:flex;justify-content:space-between;align-items:start;"><div><h3 style="margin:0 0 4px 0;">${esc(s.agentSpecId)}</h3><span class="pill muted">${esc(s.role)}</span></div>
            <div style="text-align:right;"><div style="font-size:20px;font-weight:600;color:var(--brand)">${((s.competence?.score ?? 0) * 100).toFixed(0)}%</div><div class="muted" style="font-size:11px;">competence</div></div>
          </div>
          <div style="margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;">
            <div><div style="font-weight:600;">${s.episodes?.total ?? 0}</div><div class="muted" style="font-size:11px;">episodes</div></div>
            <div><div style="font-weight:600;">${s.choices?.deliberated ?? 0}</div><div class="muted" style="font-size:11px;">deliberations</div></div>
            <div><div style="font-weight:600;color:${critical > 0 ? 'var(--bad)' : 'var(--fg)'}">${critical}</div><div class="muted" style="font-size:11px;">critical eps</div></div>
          </div>
          <div style="margin-top:10px;font-size:12px;">Most frequent action: ${topEffect ? `<code>${esc(topEffect[0])}</code> ×${topEffect[1]}` : '<span class="muted">none yet</span>'}</div>
          <div style="margin-top:6px;font-size:12px;">Preference shifts: ${prefShifts.length ? prefShifts.map(([k, w]) => `<span class="pill ${w > 1 ? 'good' : 'bad'}">${esc(k)} ${w.toFixed(2)}</span>`).join(' ') : '<span class="muted">baseline</span>'}</div>
          <div style="margin-top:6px;font-size:12px;">Milestones: ${(s.milestones || []).map((m) => `<span class="pill muted">${esc(m)}</span>`).join(' ') || '<span class="muted">none</span>'}</div>
          <div style="margin-top:10px;"><button class="btn btn-ghost" style="padding:5px 10px;font-size:11px;" onclick="window.generateRichNarrative('${esc(s.presenceId)}')">Generate rich narrative</button></div>
          <div id="narrative-${esc(s.presenceId)}" style="margin-top:8px;border-top:1px dashed var(--border);padding-top:8px;"></div>
        </div>`;
        }).join('')}
      </div>`;
      if (window.hydrateIcons) window.hydrateIcons();
    } catch (e) { body.innerHTML = errorStateHTML(e); }
  });
}
