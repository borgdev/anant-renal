import { main } from '../core/shell.js';
import { esc } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export const FINDING_ACTIONS = ['assign', 'remediate', 'retest', 'review', 'close', 'disposition'];

export async function renderPlatformAssurance() {
  const a = await plFetch('GET', '/admin/platform/assurance');
  const f = await plFetch('GET', '/admin/platform/findings');
  const findings = f.findings || [];
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">AI Assurance</h2>
      <p class="page-sub">Green/red team + findings lifecycle — the "is this safe and releasable?" gate (spec §20). Critical/high findings block releases until remediation + retest + independent review closes them.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(5,1fr);">
      <div class="stat-card"><div class="num">${a.findings.open}</div><div class="lbl">Open findings</div></div>
      <div class="stat-card"><div class="num">${a.findings.blocking}</div><div class="lbl">Blocking (crit/high)</div></div>
      <div class="stat-card"><div class="num">${a.greenTeam.runs}</div><div class="lbl">Green runs</div></div>
      <div class="stat-card"><div class="num">${a.redTeam.runs}</div><div class="lbl">Red runs</div></div>
      <div class="stat-card"><div class="num">${a.releaseGate.verdict}</div><div class="lbl">Release gate</div></div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Suites</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn" id="pl-green-run">Run green team</button>
        <button class="btn" id="pl-red-run">Run red-team suite</button>
        <span class="muted" style="font-size:12px;align-self:center;">Red team evaluates the CURRENT admin policy — an unsafe policy fails and creates findings.</span>
      </div>
      <div id="pl-suite-out" style="margin-top:8px;font-size:12px;"></div>
      ${a.greenTeam.latest ? `<div style="margin-top:8px;font-size:12px;"><span class="pill good">green</span> latest ${a.greenTeam.latest.checks.length} gates · ${a.greenTeam.latest.ranBy}</div>` : ''}
      ${a.redTeam.latest ? `<div style="font-size:12px;margin-top:4px;"><span class="pill ${a.redTeam.latest.passed ? 'good' : 'bad'}">red</span> latest ${a.redTeam.latest.scenarioName} · ${a.redTeam.latest.passed ? 'contained' : 'violation'}</div>` : ''}
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Findings (${findings.length})</h3>
      <table style="width:100%;">
        <thead><tr><th>Severity</th><th>Status</th><th>Finding</th><th>Threat</th><th>Owner</th><th>Release</th><th>Actions</th></tr></thead>
        <tbody>${findings.map((x) => `
          <tr>
            <td><span class="pill ${x.severity === 'critical' ? 'bad' : x.severity === 'high' ? 'warn' : ''}">${esc(x.severity)}</span></td>
            <td><span class="pill ${x.status === 'closed' ? 'good' : 'muted'}">${esc(x.status)}</span></td>
            <td><code>${esc(x.title.slice(0, 48))}</code><div class="muted" style="font-size:11px;">${esc((x.observed || '').slice(0, 60))}</div></td>
            <td>${esc(x.threatModel)}</td>
            <td>${esc(x.owner ?? '—')}</td>
            <td>${x.releaseId ? `<code>${esc(x.releaseId.slice(0, 20))}</code>` : '<span class="muted">—</span>'}</td>
            <td style="white-space:nowrap;">
              ${x.status === 'open' ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','assign')">Assign</button>` : ''}
              ${(x.status === 'assigned' || x.status === 'open' || x.status === 'retest-failed') ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','remediate')">Remediate</button>` : ''}
              ${(x.status === 'remediating' || x.status === 'open') ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','retest')">Retest</button>` : ''}
              ${x.status === 'retest-passed' ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','review')">Review</button>` : ''}
              ${x.status === 'independently-reviewed' ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','close')">Close</button>` : ''}
              ${x.status !== 'closed' ? `<button class="btn btn-ghost" onclick="plFindingAction('${esc(x.id)}','disposition')">Disposition</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No findings — the event plane is clean.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  document.getElementById('pl-green-run')?.addEventListener('click', async () => {
    const out = document.getElementById('pl-suite-out');
    try {
      const j = await plFetch('POST', '/admin/platform/green-team/run', { ranBy: 'admin-console' });
      out.innerHTML = `<span style="color:var(--good);">Green team passed — ${j.run.checks.length} gates.</span>`;
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
    renderPlatformAssurance();
  });
  document.getElementById('pl-red-run')?.addEventListener('click', async () => {
    const out = document.getElementById('pl-suite-out');
    try {
      const j = await plFetch('POST', '/admin/platform/red-team/run-suite', { ranBy: 'admin-console' });
      out.innerHTML = j.passed
        ? `<span style="color:var(--good);">Red team contained — ${j.runs.length} scenarios, 0 findings.</span>`
        : `<span style="color:var(--bad);">Red team VIOLATION — ${j.runs.length} scenarios, ${j.findings.length} finding(s) created (blocking).</span>`;
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
    renderPlatformAssurance();
  });
}
