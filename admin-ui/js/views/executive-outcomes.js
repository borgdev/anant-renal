import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export async function renderPlatformExecutive() {
  let outcomes = { verifiedEpisodes: 0, met: 0, realizedValue: 0, byKind: {} };
  try { outcomes = (await plFetch('GET', '/admin/executive/outcomes')).outcomes; } catch (e) { /* ignore */ }
  let delegations = [];
  try { delegations = (await plFetch('GET', '/admin/executive/delegations')).delegations || []; } catch (e) { /* ignore */ }
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Executive Outcomes</h2>
      <p class="page-sub">Journey N — material movements, verified value (not activity counts), and sponsor/delegate analysis to an owner with an SLA.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(3,1fr);">
      <div class="stat-card"><div class="num">${outcomes.verifiedEpisodes}</div><div class="lbl">Verified outcomes</div></div>
      <div class="stat-card"><div class="num">${outcomes.met}</div><div class="lbl">Met measures</div></div>
      <div class="stat-card"><div class="num">$${(outcomes.realizedValue || 0).toLocaleString()}</div><div class="lbl">Realized value</div></div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Delegations</h3>
      <button class="btn btn-primary" onclick="plExecAction('delegate')">Delegate analysis</button>
      <table style="width:100%;margin-top:10px;">
        <thead><tr><th>Title</th><th>Owner</th><th>SLA</th><th>Status</th><th>Outcome</th><th>Actions</th></tr></thead>
        <tbody>${delegations.map((d) => `
          <tr>
            <td>${esc(d.title)}<div class="muted" style="font-size:11px;">${esc(d.reason || '')}</div></td>
            <td>${esc(d.owner)}</td>
            <td>${esc(d.sla)}</td>
            <td><span class="pill ${d.status === 'done' ? 'good' : d.status === 'in-progress' ? 'brand' : 'muted'}">${esc(d.status)}</span></td>
            <td>${d.outcome ? `${d.outcome.verified ? '✓' : '✗'} verified${d.outcome.value ? ' · $' + d.outcome.value.toLocaleString() : ''}` : '<span class="muted">—</span>'}</td>
            <td style="white-space:nowrap;">
              ${d.status !== 'done' ? `<button class="btn btn-ghost" onclick="plExecAction('complete','${esc(d.id)}')">Complete</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No delegations — sponsor one above.</td></tr>'}</tbody>
      </table>
    </div>`;
}
