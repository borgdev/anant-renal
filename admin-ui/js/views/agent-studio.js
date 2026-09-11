import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export async function renderPlatformAgents() {
  const { agents, total } = await plFetch('GET', '/admin/platform/agents');
  const list = agents || [];
  // Drafts resolve as `packId:id`; published agents by bare id.
  const paId = (a) => a.source === 'draft' ? `${a.packId}:${a.id}` : a.id;
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Agent Studio</h2>
      <p class="page-sub">One surface for authoring, triggers, topics, outputs, isolated tests, kill switch and rollback. Every row resolves a real output topic + DLQ and its run history.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${total ?? list.length}</div><div class="lbl">Total agents</div></div>
      <div class="stat-card"><div class="num">${list.filter((a) => a.source === 'published').length}</div><div class="lbl">Published</div></div>
      <div class="stat-card"><div class="num">${list.filter((a) => a.source === 'draft').length}</div><div class="lbl">Drafts</div></div>
      <div class="stat-card"><div class="num">${list.filter((a) => a.killSwitch).length}</div><div class="lbl">Killed</div></div>
    </div>
    <div class="detail">
      <table style="width:100%;">
        <thead><tr><th>Agent</th><th>Pack</th><th>Source</th><th>Trigger</th><th>Output topic</th><th>DLQ</th><th>Runs</th><th>Kill</th><th>Actions</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr>
            <td><code>${esc(a.id)}</code></td>
            <td>${esc(a.packId)}</td>
            <td><span class="pill ${a.source === 'published' ? 'good' : 'warn'}">${esc(a.source)}</span></td>
            <td>${esc(a.triggerKind)}</td>
            <td><code>${esc(a.outputTopic)}</code></td>
            <td><code>${esc(a.dlqTopic)}</code></td>
            <td>${a.runs ?? 0}</td>
            <td>${a.killSwitch ? '<span class="pill bad">killed</span>' : '<span class="pill good">armed</span>'}</td>
            <td style="white-space:nowrap;">
              <button class="btn btn-ghost" onclick="plAgentAction('${esc(paId(a))}','test')">Test</button>
              ${a.killSwitch
                ? `<button class="btn btn-ghost" onclick="plAgentAction('${esc(paId(a))}','un-kill')">Un-kill</button>`
                : `<button class="btn btn-ghost" onclick="plAgentKill('${esc(paId(a))}')">Kill</button>`}
              <button class="btn btn-ghost" onclick="plAgentRollback('${esc(paId(a))}')">Rollback</button>
              <button class="btn btn-ghost" onclick="plAgentOutputTopic('${esc(paId(a))}')">Output</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="9" class="muted">No agents found.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

export async function renderPlatformContext() {
  const c = await plFetch('GET', '/api/context');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Context API</h2>
      <p class="page-sub">GET /api/context — what the server says the current session may see and do. The UI never decides authorization.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(3,1fr);">
      <div class="stat-card"><div class="num">${esc(c.role ?? 'anonymous')}</div><div class="lbl">Role</div></div>
      <div class="stat-card"><div class="num">${(c.consoles || []).join('/')}</div><div class="lbl">Consoles</div></div>
      <div class="stat-card"><div class="num">${esc(c.pack?.id ?? '—')}</div><div class="lbl">Active pack · ${esc(c.pack?.lens ?? '')}</div></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Aggregates</h3><div class="cards" style="grid-template-columns: repeat(4,1fr);">${Object.entries(c.aggregates || {}).map(([k, v]) => `<div class="stat-card"><div class="num">${v}</div><div class="lbl">${esc(k)}</div></div>`).join('')}</div></div>
    <div class="detail"><h3 style="margin-top:0;">Navigation</h3>${(c.navigation || []).map((n) => `<div style="padding:3px 0;border-bottom:1px solid var(--border);"><span class="pill ${n.console === 'exec' ? 'brand' : 'muted'}">${esc(n.console)}</span> ${esc(n.label)} <span class="muted">→ ${esc(n.href)}</span></div>`).join('')}</div>
    <div class="detail"><h3 style="margin-top:0;">Capabilities (${c.capabilities?.length ?? 0})</h3><div style="display:flex;flex-wrap:wrap;gap:6px;">${(c.capabilities || []).map((x) => `<span class="pill muted">${esc(x)}</span>`).join('')}</div></div>
  `;
}
