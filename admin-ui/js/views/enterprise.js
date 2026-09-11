import { api, consoleDomain } from '../core/api.js';
import { humanMs } from '../core/format.js';
import { main } from '../core/shell.js';
import { dataGrid, esc } from '../core/theme.js';

export let entTab = 'webhooks';

export async function renderEnterprisePanel() {
  const dom = await consoleDomain();
  const [enterprise, webhooks, alerts, retention, audit] = await Promise.all([
    api('GET', '/admin/enterprise').catch(() => null),
    api('GET', '/admin/webhooks').catch(() => ({ webhooks: [], stats: { pending: 0, delivered: 0, dead: 0 } })),
    api('GET', '/admin/alerts').catch(() => ({ rules: [], events: [] })),
    api('GET', '/admin/retention').catch(() => ({ policies: [] })),
    api('GET', '/admin/audit').catch(() => ({ audit: [] })),
  ]);
  const e = enterprise ?? {};
  const wStats = (webhooks.stats || { pending: 0, delivered: 0, dead: 0 });
  const tabs = [['webhooks', 'Webhooks'], ['alerts', 'Alert rules'], ['retention', 'Retention'], ['audit', 'Audit'], ['api', 'API docs']].map(([id, label]) =>
    `<button class="btn ${entTab === id ? 'brand' : ''}" data-tab="${id}" style="margin-right:6px;">${label}</button>`).join('');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Enterprise platform</h2>
      <p class="page-sub">Public <code>/api/v1</code> (OpenAPI + rate-limit + Idempotency-Key), durable webhooks, alert rules, retention, and the FHIR audit mirror.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${wStats.delivered}</div><div class="lbl">Webhook deliveries</div></div>
      <div class="stat-card"><div class="num">${(alerts.rules || []).length}</div><div class="lbl">Alert rules</div></div>
      <div class="stat-card"><div class="num">${(retention.policies || []).length}</div><div class="lbl">Retention policies</div></div>
      <div class="stat-card"><div class="num">${(audit.audit || []).length}</div><div class="lbl">Audit events (recent)</div></div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <div style="margin-bottom:10px;">${tabs}</div>
      <div id="ent-body"></div>
    </div>
  `;
  main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { entTab = b.dataset.tab; renderEnterprisePanel(); }));
  const body = document.getElementById('ent-body');
  if (entTab === 'webhooks') {
    body.innerHTML = `
      <div class="field-row">
        <div class="field"><label>URL</label><input id="wh-url" placeholder="https://hook.example.com/endpoint" /></div>
        <div class="field"><label>Secret</label><input id="wh-secret" placeholder="shared-secret" /></div>
        <div class="field"><label>Event types (JSON, '*' = all)</label><input id="wh-types" value='["*"]' /></div>
        <div class="field" style="align-self:flex-end;"><button id="wh-add" class="btn brand">Add webhook</button></div>
      </div>
      <div id="wh-list"></div>
      <div style="margin-top:8px;font-size:12px;color:var(--muted);">Deliveries: ${wStats.pending} pending · ${wStats.delivered} delivered · ${wStats.dead} dead (HMAC-SHA256 signed, retry → DLQ).</div>
    `;
    document.getElementById('wh-add')?.addEventListener('click', async () => {
      try {
        const eventTypes = JSON.parse(document.getElementById('wh-types').value || '["*"]');
        const res = await fetch('/admin/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: document.getElementById('wh-url').value, secret: document.getElementById('wh-secret').value, eventTypes }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || res.status);
        renderEnterprisePanel();
      } catch (err) { alert(String(err)); }
    });
    dataGrid({
      el: 'wh-list', filename: 'webhooks', pageSize: 8, empty: 'No webhook endpoints yet.',
      columns: [
        { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
        { key: 'url', label: 'URL' },
        { key: 'realmId', label: 'Realm', render: (v) => esc(v || '—') },
        { key: 'active', label: 'Active', render: (v) => `<span class="pill ${v === 1 ? 'good' : 'muted'}">${v === 1 ? 'on' : 'off'}</span>` },
        { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions"><button class="btn btn-ghost" onclick="entTestWebhook()" title="Send a test event"><i data-lucide="play"></i></button><button class="btn btn-ghost" onclick="entDelete('webhooks','${esc(r.id)}')" title="Delete"><i data-lucide="trash-2"></i></button></span>` },
      ],
      data: webhooks.webhooks || [],
    });
  } else if (entTab === 'alerts') {
    body.innerHTML = `
      <div class="field-row">
        <div class="field"><label>Metric</label><input id="al-metric" placeholder="broker.dlq" /></div>
        <div class="field"><label>Op</label><select id="al-op"><option>gt</option><option>gte</option><option>lt</option><option>lte</option><option>eq</option></select></div>
        <div class="field"><label>Threshold</label><input id="al-th" type="number" value="0" /></div>
        <div class="field"><label>Severity</label><select id="al-sev"><option>warning</option><option>critical</option><option>info</option></select></div>
        <div class="field" style="align-self:flex-end;"><button id="al-add" class="btn brand">Add rule</button></div>
        <div class="field" style="align-self:flex-end;"><button id="al-eval" class="btn">Evaluate now</button></div>
      </div>
      <div id="al-rules" style="margin-top:8px;"></div>
      <div id="al-events" style="margin-top:10px;"></div>
    `;
    document.getElementById('al-add')?.addEventListener('click', async () => {
      await fetch('/admin/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metric: document.getElementById('al-metric').value, op: document.getElementById('al-op').value, threshold: Number(document.getElementById('al-th').value), severity: document.getElementById('al-sev').value }) });
      renderEnterprisePanel();
    });
    document.getElementById('al-eval')?.addEventListener('click', async () => {
      await fetch('/admin/alerts/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metrics: { 'broker.dlq': 0, 'outbox.dead': 0 } }) });
      renderEnterprisePanel();
    });
    dataGrid({ el: 'al-rules', filename: 'alert-rules', columns: [{ key: 'metric', label: 'Metric' }, { key: 'op', label: 'Op' }, { key: 'threshold', label: 'Threshold', align: 'right' }, { key: 'severity', label: 'Severity', render: (v) => `<span class="pill ${v === 'critical' ? 'bad' : 'warn'}">${esc(v)}</span>` }, { key: 'enabled', label: 'On', render: (v) => (v === 1 ? '✓' : '—') }, { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" onclick="entDelete('alerts','${esc(r.id)}')" title="Delete"><i data-lucide="trash-2"></i></button>` }], data: alerts.rules || [] });
    dataGrid({ el: 'al-events', filename: 'alert-events', pageSize: 6, columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value', align: 'right' }, { key: 'severity', label: 'Severity', render: (v) => `<span class="pill ${v === 'critical' ? 'bad' : 'warn'}">${esc(v)}</span>` }, { key: 'firedAt', label: 'Fired' }], data: alerts.events || [] });
  } else if (entTab === 'retention') {
    body.innerHTML = `
      <div class="field-row">
        <div class="field"><label>Entity</label><select id="rt-entity">${(dom.domainOptions.retentionEntities || []).map((e) => `<option>${esc(e)}</option>`).join('')}</select></div>
        <div class="field"><label>Keep for</label><select id="rt-age"><option value="3600000">1 hour</option><option value="86400000">1 day</option><option value="604800000">7 days</option><option value="2592000000" selected>30 days</option><option value="7776000000">90 days</option><option value="15552000000">180 days</option><option value="31536000000">1 year</option><option value="315360000000">10 years</option></select></div>
        <div class="field" style="align-self:flex-end;"><button id="rt-add" class="btn brand">Add policy</button></div>
        <div class="field" style="align-self:flex-end;"><button id="rt-purge" class="btn">Purge now</button></div>
      </div>
      <div id="rt-list" style="margin-top:8px;"></div>
    `;
    document.getElementById('rt-add')?.addEventListener('click', async () => {
      await fetch('/admin/retention', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity: document.getElementById('rt-entity').value, maxAgeMs: Number(document.getElementById('rt-age').value) }) });
      renderEnterprisePanel();
    });
    document.getElementById('rt-purge')?.addEventListener('click', async () => {
      const res = await fetch('/admin/retention/purge', { method: 'POST' });
      alert(JSON.stringify((await res.json()).deleted));
    });
    dataGrid({ el: 'rt-list', filename: 'retention', columns: [{ key: 'entity', label: 'Entity', render: (v) => `<code>${esc(v)}</code>` }, { key: 'maxAgeMs', label: 'Keep for', align: 'right', render: (v) => humanMs(v) }, { key: 'scopeId', label: 'Scope', render: (v) => esc(v || 'all') }, { key: 'enabled', label: 'On', render: (v) => (v === 1 ? '✓' : '—') }, { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" onclick="entDelete('retention','${esc(r.id)}')" title="Delete"><i data-lucide="trash-2"></i></button>` }], data: retention.policies || [] });
  } else if (entTab === 'audit') {
    body.innerHTML = `<a class="btn" href="/admin/audit/fhir" target="_blank" style="margin-bottom:8px;">Export as FHIR AuditEvent Bundle</a><div id="au-grid"></div>`;
    dataGrid({ el: 'au-grid', filename: 'audit-events', pageSize: 10, columns: [{ key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` }, { key: 'actorRef', label: 'Actor' }, { key: 'action', label: 'Action' }, { key: 'resourceType', label: 'Resource' }, { key: 'classification', label: 'Class', render: (v) => `<span class="pill muted">${esc(v)}</span>` }, { key: 'occurredAt', label: 'When' }], data: audit.audit || [] });
  } else {
    body.innerHTML = `
      <p>OpenAPI documentation for the public surface is served at <a href="/docs" target="_blank">/docs</a> (Swagger UI) and <code>/docs/json</code>.</p>
      <div class="kv" style="margin-top:8px;">
        <div><div class="k">Public API</div><div class="v"><code>/api/v1/health · /packs · /measures · /realms · /fhir/{realm}/{kind}/{id} · /events · /audit · /dsar/…</code></div></div>
        <div><div class="k">Idempotency</div><div class="v">POST <code>/api/v1/events</code> honors the <code>Idempotency-Key</code> header</div></div>
        <div><div class="k">Rate limiting</div><div class="v"><code>HH_RATE_LIMIT_MAX</code> / <code>HH_RATE_LIMIT_WINDOW_MS</code> (default 300/min)</div></div>
        <div><div class="k">PHI masking</div><div class="v">FHIR + DSAR reads redact identifiers below <code>restricted-phi</code></div></div>
      </div>
    `;
  }
}
