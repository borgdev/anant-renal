import { loadFailureHTML, releaseGateHTML } from '../core/scope.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons } from '../core/theme.js';
import { wsStatusPill } from './exec-workspace.js';

export async function paIntegrationsSection() {
  const el = document.getElementById('pa-int');
  if (!el) return;
  let integrations = null; let err = null;
  try { integrations = await plFetch('GET', '/admin/platform/integrations'); } catch (e) { err = e.message; }
  if (!integrations) { el.innerHTML = `<h3 style="margin-top:0;">Integration contract</h3>${loadFailureHTML('the integration contract', err)}`; return; }
  const k = integrations.kafka || {};
  const mappings = k.topicMappings || [];
  el.innerHTML = `
    <h3 style="margin-top:0;">Integration contract ${wsStatusPill(k.status)}</h3>
    <div class="field-row">
      <div class="field" style="flex:2;"><label>Bridge URL</label><input id="pa-url" value="${esc(k.bridgeUrl ?? '')}" /></div>
      <div class="field"><label>Cluster alias</label><input id="pa-alias" value="${esc(k.clusterAlias ?? '')}" /></div>
      <div class="field"><label>Protocol</label><select id="pa-proto">
        ${['SASL_SSL', 'SSL', 'PLAINTEXT'].map((p) => `<option ${k.securityProtocol === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select></div>
      <div class="field"><label>Consumer group</label><input id="pa-group" value="${esc(k.consumerGroup ?? '')}" /></div>
    </div>
    <div class="field-row">
      <div class="field" style="flex:3;"><label>Secret binding reference</label><input id="pa-secret" value="${esc(k.secretRef ?? '')}" /><small class="muted">Reference only — never enter the secret value; the server rejects anything that looks like one.</small></div>
      <button class="btn btn-primary" onclick="paSaveKafka()">Save contract</button>
      <button class="btn" onclick="paTestKafka()"><i data-lucide="cable" style="width:13px;height:13px"></i> Test contract</button>
    </div>
    ${mappings.length ? `<div style="margin-top:8px;">${mappings.map((m) => `<span class="pill ${m.direction === 'inbound' ? 'brand' : 'muted'}" style="margin-right:6px;">${esc(m.direction)} <code>${esc(m.topic)}</code> → ${esc(m.contract)}</span>`).join('')}</div>` : ''}
    ${k.testSummary ? `<div class="muted" style="font-size:12px;margin-top:8px;">${esc(k.testSummary)}${k.lastTestedAt ? ` · ${esc(String(k.lastTestedAt))}` : ''}</div>` : ''}
    <div id="pa-int-out" class="muted" style="font-size:12px;margin-top:6px;">Secrets live in deployment bindings. The contract test verifies authentication, the topic allowlist and the envelope schema.</div>`;
}

export async function paOrgSection() {
  const el = document.getElementById('pa-org');
  if (!el) return;
  let org = null; let realized = []; let err = null;
  try {
    const j = await plFetch('GET', '/admin/platform/organization');
    org = j.organization; realized = j.realized || [];
  } catch (e) { err = e.message; }
  if (!org) { el.innerHTML = `<h3 style="margin-top:0;">Organization</h3>${loadFailureHTML('the organization profile', err)}`; return; }
  const totalPatients = realized.reduce((n, r) => n + (r.patients || 0), 0);
  el.innerHTML = `
    <h3 style="margin-top:0;">Organization <span class="muted" style="font-weight:400;font-size:11px;">· one record for identity, deployment posture and the hierarchy</span></h3>
    <div class="field-row">
      <div class="field"><label>Display name</label><input id="pa-name" value="${esc(org.displayName ?? '')}" /></div>
      <div class="field"><label>Operating model</label><select id="pa-om">
        <option value="provider" ${org.operatingModel === 'provider' ? 'selected' : ''}>Provider</option>
        <option value="payer" ${org.operatingModel === 'payer' ? 'selected' : ''}>Payer</option>
        <option value="hybrid" ${org.operatingModel === 'hybrid' ? 'selected' : ''}>Hybrid</option>
      </select></div>
      <div class="field"><label>Environment</label><input id="pa-env" value="${esc(org.environmentName ?? 'reference')}" /></div>
      <div class="field"><label>Deployment mode</label><select id="pa-mode">
        ${['reference', 'non-production', 'production'].map((m) => `<option value="${m}" ${org.deploymentMode === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select></div>
      <div class="field"><label>Data region</label><input id="pa-data-region" value="${esc(org.dataRegion ?? 'United States')}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Region</label><input id="pa-region" value="${esc(org.region ?? '')}" /></div>
      <div class="field"><label>Timezone</label><input id="pa-tz" value="${esc(org.timezone ?? '')}" /></div>
      <div class="field"><label>Retention (days)</label><input id="pa-ret" type="number" value="${org.retentionDays ?? 365}" /></div>
      <div class="field checkbox"><label><input id="pa-synthetic" type="checkbox" ${org.synthetic ? 'checked' : ''}> <span>Synthetic demonstration data</span></label></div>
    </div>
    <div class="muted" style="font-size:12px;">Hierarchy: ${(org.scopePath || []).map((l) => esc(l.label || l.id)).join(' → ') || 'none yet'} — edit the structured hierarchy in <a href="#" onclick="goTo('platform-config');return false;">Configuration studio → Ontology</a>. Live: <b>${realized.length}</b> mapped levels · <b>${totalPatients}</b> patients.</div>
    <div style="margin-top:8px;"><button class="btn btn-primary" onclick="paSaveOrg()">Save organization</button></div>
    <div id="pa-org-out" class="muted" style="font-size:12px;margin-top:6px;">Saving updates the durable organization record; the executive lens reads it via <code>/api/context</code>.</div>`;
}

export async function paSteps() {
  const el = document.getElementById('pa-steps');
  if (!el) return;
  let boot = null; let err = null;
  try { boot = await plFetch('GET', '/admin/platform/bootstrap'); } catch (e) { err = e.message; }
  if (!boot) { el.innerHTML = `<h3 style="margin-top:0;">Customer launch readiness</h3>${loadFailureHTML('the launch journey', err)}`; return; }
  const o = boot.onboarding || { steps: [], gates: {}, currentStep: 'organization', readyForRehearsal: false };
  const done = (o.steps || []).filter((s) => s.status === 'complete').length;
  el.innerHTML = `
    <h3 style="margin-top:0;">Customer launch readiness
      <span class="muted" style="font-weight:400;font-size:11px;">· ${done}/${(o.steps || []).length} steps complete · environment ${esc(boot.status || 'onboarding')}</span></h3>
    <div class="cards" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-card"><div class="num">${done}/${(o.steps || []).length}</div><div class="lbl">Steps complete</div></div>
      <div class="stat-card"><div class="num">${esc(o.currentStep)}</div><div class="lbl">Current step</div></div>
      <div class="stat-card"><div class="num">${o.readyForRehearsal ? 'YES' : '—'}</div><div class="lbl">Ready for rehearsal</div></div>
    </div>
    <div style="margin-top:10px;">${(o.steps || []).map((s) => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);">
        <span style="font-weight:700;color:${s.status === 'complete' ? 'var(--good)' : s.status === 'active' ? 'var(--brand)' : 'var(--muted)'};">${s.status === 'complete' ? '✓' : s.status === 'active' ? '▸' : '·'}</span>
        <div style="flex:1;"><div style="font-weight:600;">${esc(s.label)} <span class="pill ${s.status === 'complete' ? 'good' : s.status === 'active' ? 'brand' : 'muted'}">${esc(s.status)}</span></div>
        <div class="muted" style="font-size:12px;">${esc(s.gate)}</div></div>
      </div>`).join('')}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${Object.entries(o.gates || {}).map(([k, v]) => `<span class="pill ${v ? 'good' : 'warn'}">${esc(k)} ${v ? '✓' : '…'}</span>`).join('')}</div>
    <div class="field-row" style="margin-top:12px;">
      <div class="field"><label>Resume at step</label><select id="pa-step">${(o.steps || []).map((s) => `<option value="${esc(s.id)}" ${s.id === o.currentStep ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Operating model</label><select id="pa-model">
        <option value="provider" ${o.operatingModel === 'provider' ? 'selected' : ''}>Provider</option>
        <option value="payer" ${o.operatingModel === 'payer' ? 'selected' : ''}>Payer</option>
        <option value="hybrid" ${o.operatingModel === 'hybrid' ? 'selected' : ''}>Hybrid</option>
      </select></div>
      <div class="field" style="align-self:flex-end;"><button class="btn btn-primary" onclick="paSaveOnboarding()">Save onboarding</button></div>
    </div>
    <div id="pa-step-out" class="muted" style="font-size:12px;margin-top:6px;">Saving onboarding changes the operating model and the resumed step — no redeploy.</div>`;
}

export async function paTopicsSection() {
  const el = document.getElementById('pa-topics');
  if (!el) return;
  let data = null; let err = null;
  try { data = await plFetch('GET', '/admin/platform/topics'); } catch (e) { err = e.message; }
  if (!data) { el.innerHTML = `<h3 style="margin-top:0;">Kafka topic plan</h3>${loadFailureHTML('the topic plan', err)}`; return; }
  const t = data.topics || data.defaults || { entries: [] };
  const required = [t.defaultOutputTopic, t.agentDlqTopic, t.actionCommandTopic, t.actionAckTopic, t.outcomeStateTopic, t.assuranceEventTopic].filter(Boolean);
  el.innerHTML = `
    <h3 style="margin-top:0;">Kafka topic plan <span class="muted" style="font-weight:400;font-size:11px;">· ${(t.entries || []).length} planned</span></h3>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">${required.map((x) => `<span class="pill brand"><code>${esc(x)}</code></span>`).join('') || '<span class="muted" style="font-size:12px;">No required topics configured yet.</span>'}</div>
    <div style="overflow-x:auto;margin-top:10px;"><table style="width:100%;"><thead><tr><th>Topic</th><th>Direction</th><th>Contract</th><th>Partitions</th><th>Key strategy</th><th>Owning agent</th></tr></thead>
      <tbody>${(t.entries || []).map((e) => `<tr><td><code>${esc(e.topic)}</code></td><td>${esc(e.direction)}</td><td>${esc(e.contract)}</td><td>${e.partitions ?? '—'}</td><td>${esc(e.keyStrategy ?? '—')}</td><td>${esc(e.owningAgent ?? '—')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No planned entries yet.</td></tr>'}</tbody></table></div>
    <div class="field" style="margin-top:8px;"><label>Entries (JSON)</label><textarea id="pa-entries" rows="6" class="code">${esc(JSON.stringify(t.entries ?? [], null, 2))}</textarea></div>
    <button class="btn btn-primary" onclick="paSaveTopics()">Save topic plan</button>
    <div id="pa-topics-out" class="muted" style="font-size:12px;margin-top:6px;">Failures route to the governed DLQ; each agent resolves exactly one output topic.</div>`;
}

export async function plFetch(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || j.message || res.status);
  return j;
}

export async function renderPlatformAdmin() {
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Platform admin</h2>
      <p class="page-sub">Customer launch: the gated journey, the organization profile (identity + deployment posture), the integration contract and the topic plan. Configuration objects, packs and the action policy live in <b>Configuration studio</b>.</p></div>
      <button class="btn" onclick="goTo('platform-config')">Configuration studio →</button></div>
    <div id="pa-steps" class="section-card">Loading journey…</div>
    <div id="pa-org" class="section-card">Loading organization…</div>
    <div id="pa-int" class="section-card">Loading integration contract…</div>
    <div id="pa-topics" class="section-card">Loading topic plan…</div>`;
  await Promise.all([paSteps(), paOrgSection(), paIntegrationsSection(), paTopicsSection()]);
  hydrateIcons();
}

export async function renderPlatformReleases() {
  let releases = []; let active = null; let gate = null; let err = null;
  try {
    const j = await plFetch('GET', '/admin/platform/releases');
    releases = j.releases || []; active = j.active || null;
    window.__plReleases = releases;
  } catch (e) { err = e.message; }
  if (err) { main.innerHTML = `<div class="page-header"><div><h2 class="page-title">Release center</h2></div></div>${loadFailureHTML('the release center', err)}`; hydrateIcons(); return; }
  try { gate = await plFetch('GET', '/admin/platform/release-gate'); } catch { /* panel reports its own state */ }
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Release center</h2>
      <p class="page-sub">Immutable release manifests — draft → validate → approve → canary → activate → rollback. Runtime confirms the active hash; customer configuration never needs a redeploy. An intentionally unsafe release cannot validate or activate.</p></div></div>
    <div class="detail">
      <h3 style="margin-top:0;">Release gate <span class="muted" style="font-weight:400;font-size:11px;">· green / red / sources / approvals, from the live policy</span></h3>
      ${releaseGateHTML(gate)}
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">New release</h3>
      <div class="field-row">
        <div class="field"><label>Version</label><input id="pr-version" placeholder="v1" /></div>
        <div class="field"><label>Change summary</label><input id="pr-summary" placeholder="What this release changes" style="min-width:320px;" /></div>
        <div class="field" style="align-self:flex-end;"><button class="btn btn-primary" id="pr-create">Create draft</button></div>
      </div>
      <div id="pr-out" style="margin-top:8px;font-size:12px;"></div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Releases</h3>
      <table style="width:100%;">
        <thead><tr><th>Version</th><th>Status</th><th>Summary</th><th>Gates</th><th>Canary</th><th>Actions</th></tr></thead>
        <tbody>${(releases || []).map((r) => `
          <tr>
            <td><code>${esc(r.version)}</code>${active && active.id === r.id ? ' <span class="pill good">active</span>' : ''}</td>
            <td><span class="pill ${r.status === 'active' ? 'good' : r.status === 'approved' ? 'brand' : r.status === 'canary' ? 'brand' : r.status === 'failed' ? 'bad' : r.status === 'validated' ? '' : 'warn'}">${esc(r.status)}</span></td>
            <td>${esc(r.changeSummary)}</td>
            <td>${(r.checks || []).filter((c) => !c.passed).length > 0
              ? `<span class="pill bad">${(r.checks || []).filter((c) => !c.passed).map((c) => c.name).join(', ')}</span>`
              : (r.checks || []).length > 0 ? `<span class="pill good">${(r.checks || []).filter((c) => c.passed).length}/${(r.checks || []).length} gates</span>` : '<span class="muted">—</span>'}</td>
            <td>${r.status === 'canary'
              ? `<span class="pill brand">${esc((r.canaryScopes || []).join(', '))}</span>`
              : r.canaryResult ? `<span class="pill ${r.canaryResult === 'pass' ? 'good' : 'bad'}">${esc(r.canaryResult)}</span>` : '<span class="muted">—</span>'}</td>
            <td style="white-space:nowrap;">
              ${(r.status === 'draft' || r.status === 'failed') ? `<button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','validate')">Validate</button>` : ''}
              ${r.status === 'validated' ? `<button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','request-approval')">Approve</button>` : ''}
              ${r.status === 'approved' ? `<button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','canary')">Canary</button><button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','activate')">Activate</button>` : ''}
              ${r.status === 'canary' ? `<button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','promote')">Promote</button><button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','fail')">Fail</button>` : ''}
              ${(r.status === 'active' || r.status === 'approved' || r.status === 'validated' || r.status === 'superseded') ? `<button class="btn btn-ghost" onclick="plReleaseAction('${esc(r.id)}','rollback')">Rollback</button>` : ''}
              ${r.dossier ? `<button class="btn btn-ghost" onclick="plDossier('${esc(r.id)}')">Dossier</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No releases yet — create a draft above.</td></tr>'}</tbody>
      </table>
      <div id="pl-dossier" style="margin-top:10px;font-size:12px;"></div>
    </div>
  `;
  document.getElementById('pr-create')?.addEventListener('click', async () => {
    const out = document.getElementById('pr-out');
    try {
      const j = await plFetch('POST', '/admin/platform/releases', {
        ...(document.getElementById('pr-version').value ? { version: document.getElementById('pr-version').value } : {}),
        ...(document.getElementById('pr-summary').value ? { changeSummary: document.getElementById('pr-summary').value } : {}),
      });
      out.innerHTML = `<span style="color:var(--good);">Created ${esc(j.release.version)} (${esc(j.release.status)}).</span>`;
      renderPlatformReleases();
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  });
}
