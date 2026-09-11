import { S } from '../state.js';
import { api } from '../core/api.js';
import { rawJson } from '../core/auth.js';
import { humanMs } from '../core/format.js';
import { loadPatientDatalist } from '../core/search.js';
import { main } from '../core/shell.js';
import { dataGrid, esc, toast } from '../core/theme.js';

export async function doFhirExport(showJson) {
  const realmId = document.getElementById('fhir-export-realm')?.value || S.fhirSel;
  const out = document.getElementById('fhir-export-summary');
  try {
    const res = await fetch(`/admin/fhir/export/${encodeURIComponent(realmId)}`);
    const b = await res.json();
    if (!res.ok) throw new Error(b.error || res.status);
    const counts = {};
    (b.entry || []).forEach(e => { const t = e.resource?.resourceType || '?'; counts[t] = (counts[t] || 0) + 1; });
    const summary = Object.entries(counts).map(([t, n]) => `${t} × ${n}`).join(', ');
    out.innerHTML = `<span style="color:var(--good);">Exported ${(b.entry || []).length} resources from <code>${esc(realmId)}</code> — ${esc(summary)}</span>`;
    const dl = document.getElementById('fhir-download');
    if (dl) { dl.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/fhir+json' })); }
    if (showJson) out.innerHTML += `<pre style="max-height:260px;overflow:auto;background:var(--code-bg);color:var(--code-fg);padding:8px;border-radius:6px;margin-top:8px;">${esc(JSON.stringify(b, null, 2))}</pre>`;
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
}

export async function loadFhirMirror() {
  try {
    const res = await fetch('/admin/fhir/resources');
    const j = await res.json();
    const rows = (j.resources || []);
    const c = document.getElementById('fhir-mirror-count'); if (c) c.textContent = rows.length;
    dataGrid({
      el: 'fhir-resources-grid', filename: 'fhir-resources', pageSize: 8, empty: 'No resources persisted yet — ingest a bundle.',
      columns: [
        { key: 'resourceType', label: 'Resource', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
        { key: 'kind', label: 'Kind', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
        { key: 'entityId', label: 'Entity id', render: (v) => `<code>${esc(v || '—')}</code>` },
        { key: 'realmId', label: 'Realm' },
        { key: 'direction', label: 'Dir', render: (v) => `<span class="pill ${v === 'out' ? 'muted' : 'good'}">${esc(v)}</span>` },
        { key: 'ingestedAt', label: 'Ingested' },
      ],
      data: rows,
    });
  } catch { /* grid stays empty */ }
}

export async function loadUsersGrid() {
  const el = document.getElementById('users-grid');
  if (!el) return;
  const r = await rawJson('GET', '/admin/auth/users');
  dataGrid({
    el: 'users-grid', filename: 'users', pageSize: 10, empty: 'No users yet — create one above.',
    columns: [
      { key: 'username', label: 'Username', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'displayName', label: 'Name', render: (v) => esc(v || '—') },
      { key: 'role', label: 'Role', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
      { key: 'clearance', label: 'Clearance', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'purposeOfUse', label: 'Purpose of use', render: (v) => esc((v || []).join(', ')) },
      { key: 'createdAt', label: 'Created', render: (v) => esc(v ? v.slice(0, 16).replace('T', ' ') : '—') },
      { key: 'lastLoginAt', label: 'Last login', render: (v) => esc(v ? v.slice(0, 16).replace('T', ' ') : '—') },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, row) => `<span class="row-actions">
        <button class="btn btn-ghost" data-reset-user="${esc(row.username)}" title="Reset password"><i data-lucide="key-round"></i></button>
        <button class="btn btn-ghost" data-del-user="${esc(row.username)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: r.users || [],
  });
}

export async function renderCompliance() {
  const [compliance, audit] = await Promise.all([
    api('GET', '/admin/compliance').catch(() => null),
    api('GET', '/admin/audit').catch(() => ({ audit: [] })),
  ]);
  const c = compliance ?? {};
  const auditStat = c.audit ?? { total: 0, byAction: {}, byClassification: {} };
  const inv = c.phiInventory ?? { fhirResources: 0, byType: {}, byKind: {} };
  const actionPills = Object.entries(auditStat.byAction || {}).map(([k, v]) => `<span class="pill muted">${esc(k)} × ${v}</span>`).join(' ');
  const typePills = Object.entries(inv.byType || {}).map(([k, v]) => `<span class="pill brand">${esc(k)} × ${v}</span>`).join(' ');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Compliance</h2>
      <p class="page-sub">Audit mirror (FHIR AuditEvent), retention status, and the PHI inventory across realms.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${auditStat.total}</div><div class="lbl">Audit events</div></div>
      <div class="stat-card"><div class="num">${(c.retention || []).length}</div><div class="lbl">Retention policies</div></div>
      <div class="stat-card"><div class="num">${inv.fhirResources}</div><div class="lbl">FHIR resources stored</div></div>
      <div class="stat-card"><div class="num">${Object.keys(inv.byKind || {}).length}</div><div class="lbl">Entity kinds in PHI inventory</div></div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Audit activity</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${actionPills || '<span class="pill muted">no actions</span>'}</div>
      <a class="btn" href="/admin/audit/fhir" target="_blank" style="margin-top:8px;">Export audit as FHIR AuditEvent Bundle</a>
      <div id="co-audit" style="margin-top:8px;"></div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">PHI inventory (FHIR resources by type)</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${typePills || '<span class="pill muted">none stored</span>'}</div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Retention policies</h3><div id="co-retention"></div></div>
  `;
  dataGrid({ el: 'co-audit', filename: 'compliance-audit', pageSize: 10, columns: [{ key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` }, { key: 'actorRef', label: 'Actor' }, { key: 'action', label: 'Action' }, { key: 'resourceType', label: 'Resource' }, { key: 'classification', label: 'Class', render: (v) => `<span class="pill muted">${esc(v)}</span>` }, { key: 'occurredAt', label: 'When' }], data: audit.audit || [] });
  dataGrid({ el: 'co-retention', filename: 'compliance-retention', columns: [{ key: 'entity', label: 'Entity', render: (v) => `<code>${esc(v)}</code>` }, { key: 'maxAgeMs', label: 'Keep for', align: 'right', render: (v) => humanMs(v) }, { key: 'scopeId', label: 'Scope', render: (v) => esc(v || 'all') }, { key: 'enabled', label: 'On', render: (v) => (v === 1 ? '✓' : '—') }], data: (c.retention || []) });
}

export async function renderFhirPanel() {
  const [realms, map, coverage] = await Promise.all([
    api('GET', '/admin/realms').catch(() => ({ realms: [] })),
    api('GET', '/admin/fhir/map').catch(() => ({ resourceToKind: {}, kindToResources: {} })),
    api('GET', '/admin/fhir/coverage').catch(() => null),
  ]);
  const realmsArr = (realms.realms || []).map(r => r.id);
  if (!S.fhirSel || !realmsArr.includes(S.fhirSel)) S.fhirSel = realmsArr[0] || '';
  const kindRows = Object.entries(map.resourceToKind || {}).map(([rt, k]) => `<tr><td><code>${esc(rt)}</code></td><td><span class="pill muted">${esc(k)}</span></td></tr>`).join('');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">FHIR entities</h2>
      <p class="page-sub">Every entity consumes and produces FHIR R4 — ingest a Bundle to hydrate a realm, export a realm as a Bundle, and read any entity as its resource. Ingestion also rides the live hypergraph bridge.</p></div></div>
    <div class="cards" style="grid-template-columns: repeat(3,1fr);">
      <div class="stat-card"><div class="num">${Object.keys(map.resourceToKind || {}).length}</div><div class="lbl">Mapped resource types</div></div>
      <div class="stat-card"><div class="num">${realmsArr.length}</div><div class="lbl">Realms (export/ingest target)</div></div>
      <div class="stat-card"><div class="num" id="fhir-mirror-count">…</div><div class="lbl">Persisted resources</div></div>
    </div>
    <div class="detail">
      <h3 style="margin-top:0;">Ingest a FHIR Bundle</h3>
      <div class="field-row">
        <div class="field"><label>Realm</label><select id="fhir-realm">${realmsArr.map(id => `<option value="${esc(id)}" ${id === S.fhirSel ? 'selected' : ''}>${esc(id)}</option>`).join('') || '<option value="">no realms</option>'}</select></div>
        <div class="field" style="flex:1;"><label>Bundle (JSON)</label><textarea id="fhir-bundle" rows="6" style="font-family:var(--code-fg);font-size:12px;" placeholder='{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"Patient","id":"p9",...}}]}'>${esc(S.fhirBundleText)}</textarea></div>
        <div class="field"><label>Type</label><select id="fhir-bundle-type"><option value="collection">collection</option><option value="transaction">transaction</option><option value="batch">batch</option><option value="message">message</option></select></div>
        <div class="field"><label>Bundle id (replay-safe)</label><input id="fhir-bundle-id" placeholder="optional"></div>
        <div class="field"><label>&nbsp;</label><label class="field checkbox" style="flex-direction:row;gap:6px;align-items:center;"><input type="checkbox" id="fhir-dryrun"> Dry run</label></div>
        <div class="field" style="align-self:flex-end;"><button id="fhir-ingest" class="btn brand">Ingest bundle</button></div>
      </div>
      <div id="fhir-result" style="margin-top:8px;font-size:12px;"></div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <div class="field-row">
        <div class="field"><label>Realm export</label><select id="fhir-export-realm">${realmsArr.map(id => `<option value="${esc(id)}" ${id === S.fhirSel ? 'selected' : ''}>${esc(id)}</option>`).join('') || ''}</select></div>
        <div class="field"><label>&nbsp;</label><button id="fhir-export" class="btn">Export realm → Bundle</button></div>
        <div class="field"><label>&nbsp;</label><button id="fhir-view" class="btn">View bundle JSON</button></div>
        <div class="field"><label>&nbsp;</label><a id="fhir-download" class="btn" style="text-decoration:none;" download="bundle.json">Download</a></div>
      </div>
      <div id="fhir-export-summary" style="margin-top:8px;font-size:12px;"></div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Resource → kind map</h3>
      <div style="max-height:180px;overflow:auto;"><table class="panel"><thead><tr><th>FHIR resource</th><th>Entity kind</th></tr></thead><tbody>${kindRows || '<tr><td colspan="2">no mapping</td></tr>'}</tbody></table></div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">R4 coverage report</h3>
      <div class="cards" style="grid-template-columns: repeat(4,1fr);margin-bottom:10px;">
        <div class="stat-card"><div class="num">${coverage?.r4Total ?? '…'}</div><div class="lbl">R4 resource types</div></div>
        <div class="stat-card"><div class="num">${coverage?.typedTotal ?? '…'}</div><div class="lbl">Typed</div></div>
        <div class="stat-card"><div class="num">${coverage?.mappedTotal ?? '…'}</div><div class="lbl">Mapped to kinds</div></div>
        <div class="stat-card"><div class="num">${coverage?.missingTotal ?? '…'}</div><div class="lbl">Not typed</div></div>
      </div>
      <div class="field"><label>Filter typed resources</label><input id="fhir-cov-filter" placeholder="e.g. Condition, Schedule, Invoice, ..."></div>
      <div style="max-height:240px;overflow:auto;margin-top:6px;"><table class="panel" id="fhir-cov-table"><thead><tr><th>FHIR resource</th><th>Entity kind</th><th>Mapped</th></tr></thead>
        <tbody>${(coverage?.typed || []).map((t) => `<tr data-rt="${esc(t.resourceType)}"><td><code>${esc(t.resourceType)}</code></td><td>${t.kind ? `<span class="pill muted">${esc(t.kind)}</span>` : '<span class="muted">—</span>'}</td><td>${t.mapped ? '<span class="pill good">✓ wire</span>' : '<span class="pill warn">typed only</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">no data</td></tr>'}</tbody></table></div>
      <p class="page-sub" style="font-size:12px;margin-top:8px;">${coverage?.auditProvenance?.projected ? `AuditEvent → provenance stream: <span style="color:var(--good);">live</span> — every canonical event projects to an R4 AuditEvent (canonicalToFhirAudit), mirrored as a Bundle at <code>/admin/audit/fhir</code> and rolled up in <code>/admin/compliance</code>.` : 'AuditEvent projection not reported.'}</p>
      <details><summary class="muted" style="cursor:pointer;font-size:12px;">Show ${coverage?.missingTotal ?? 0} untyped R4 resources</summary>
        <div style="font-size:11px;color:var(--muted);max-height:160px;overflow:auto;">${(coverage?.missing || []).join(', ')}</div>
      </details>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Durable mirror</h3><div id="fhir-resources-grid"></div></div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Read an entity as FHIR</h3>
      <div class="field-row">
        <div class="field"><label>Realm</label><select id="fhir-read-realm">${realmsArr.map((id) => `<option value="${esc(id)}" ${id === S.fhirSel ? 'selected' : ''}>${esc(id)}</option>`).join('') || ''}</select></div>
        <div class="field"><label>Kind</label><select id="fhir-read-kind">${[...new Set(Object.values(map.resourceToKind || {}))].map((k) => `<option>${esc(k)}</option>`).join('') || '<option value="">no kinds</option>'}</select></div>
        <div class="field"><label>Entity id</label><input id="fhir-read-id" placeholder="f1-pt-0001"></div>
        <div class="field"><label>&nbsp;</label><button class="btn" id="fhir-read">Read resource</button></div>
      </div>
      <pre id="fhir-read-out" class="detail" style="background:var(--code-bg);color:var(--code-fg);padding:10px;border-radius:8px;white-space:pre-wrap;max-height:240px;overflow:auto;margin-top:8px;"></pre>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">CDS Hooks demo</h3>
      <div class="field-row">
        <div class="field"><label>Realm</label><select id="fhir-cds-realm">${realmsArr.map((id) => `<option value="${esc(id)}" ${id === S.fhirSel ? 'selected' : ''}>${esc(id)}</option>`).join('') || ''}</select></div>
        <div class="field"><label>Hook</label><select id="fhir-cds-hook"><option>medication-prescribe</option><option>order-sign</option><option>patient-view</option></select></div>
        <div class="field"><label>Patient</label><input id="fhir-cds-patient" placeholder="f1-pt-0001" list="fhir-cds-patient-list"><datalist id="fhir-cds-patient-list"></datalist></div>
        <div class="field"><label>&nbsp;</label><button class="btn" id="fhir-cds-run">Get decision support cards</button></div>
      </div>
      <div id="fhir-cds-out" style="margin-top:8px;"></div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">FHIR Subscription / CDC poll</h3>
      <p class="page-sub" style="font-size:12px;">Poll a FHIR server's <code>_lastUpdated</code> history, hydrate the changes, and <strong>apply them to a realm</strong> (twin-mode keep-current). Point it at a real EHR, or use the built-in in-process emulator for a live pull with zero setup.</p>
      <div class="field-row">
        <div class="field" style="flex:1;"><label>Base URL</label><input id="fhir-sub-base" placeholder="https://ehr.example.org/fhir" value="http://127.0.0.1:3000/fhir-mock"></div>
        <div class="field"><label>Bearer token</label><input id="fhir-sub-bearer" placeholder="optional"></div>
        <div class="field"><label>Realm</label><select id="fhir-sub-realm">${realmsArr.map((id) => `<option value="${esc(id)}" ${id === S.fhirSel ? 'selected' : ''}>${esc(id)}</option>`).join('') || ''}</select></div>
        <div class="field"><label>Resource types</label><input id="fhir-sub-types" value="Patient,Observation,Encounter,Condition,Procedure"></div>
        <div class="field"><label>&nbsp;</label><button class="btn" id="fhir-sub-seed">Seed emulator</button></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" id="fhir-sub-run">Run one poll</button></div>
      </div>
      <div id="fhir-sub-emulator" style="margin-top:6px;"></div>
      <div id="fhir-sub-out" style="margin-top:8px;"></div>
    </div>
  `;
  document.getElementById('fhir-realm')?.addEventListener('change', (e) => { S.fhirSel = e.target.value; });
  document.getElementById('fhir-cds-realm')?.addEventListener('change', (e) => { loadPatientDatalist(e.target.value, 'fhir-cds-patient-list'); });
  loadPatientDatalist(document.getElementById('fhir-cds-realm')?.value || S.fhirSel, 'fhir-cds-patient-list');
  document.getElementById('fhir-bundle')?.addEventListener('input', (e) => { S.fhirBundleText = e.target.value; });
  document.getElementById('fhir-ingest')?.addEventListener('click', async () => {
    const out = document.getElementById('fhir-result');
    try {
      const bundle = JSON.parse(document.getElementById('fhir-bundle').value || '{}');
      bundle.type = document.getElementById('fhir-bundle-type').value;
      const bundleId = document.getElementById('fhir-bundle-id').value.trim();
      if (bundleId) bundle.id = bundleId;
      const dryRun = document.getElementById('fhir-dryrun').checked;
      const res = await fetch('/admin/fhir/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ realmId: S.fhirSel, bundle, ...(dryRun ? { dryRun: true } : {}) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || j.message || res.status);
      S.fhirResult = j;
      out.innerHTML = `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <span class="pill brand">${esc(j.bundleType || 'collection')}</span>
          <span class="pill muted">${esc(j.mode || '')}</span>
          ${j.dryRun ? '<span class="pill warn">dry run — not persisted</span>' : ''}
          ${j.rolledBack ? '<span class="pill bad">rolled back</span>' : ''}
          ${j.duplicate ? '<span class="pill good">idempotent replay</span>' : ''}
          <span class="pill good">${j.applied ?? 0} applied</span>
          <span class="pill muted">${j.persisted ?? 0} persisted</span>
        </div>
        <div class="muted" style="font-size:12px;">Ingested ${j.hydrated} resources → ${j.effectsApplied} effects applied, ${j.structuralUpserts} structural upserts.${j.effectsRejected ? ` <span style="color:var(--bad);">${j.effectsRejected} effects rejected.</span>` : ''}${j.skipped?.length ? ` skipped: ${esc(j.skipped.join(', '))}` : ''}</div>
        ${(j.entries && j.entries.length) ? `<div style="margin-top:8px;max-height:200px;overflow:auto;"><table class="panel"><thead><tr><th>#</th><th>Resource</th><th>Method</th><th>Status</th><th>Location</th><th>Issue</th></tr></thead><tbody>${j.entries.map((e) => `<tr><td>${e.index}</td><td><code>${esc(e.resourceType || '')}</code>${e.id ? `/${esc(e.id)}` : ''}</td><td>${esc(e.requestMethod || 'POST')}</td><td>${e.status < 300 ? `<span class="pill good">${e.status}</span>` : `<span class="pill bad">${e.status}</span>`}</td><td>${esc(e.location || '')}</td><td class="muted">${e.issue ? esc(e.issue.code + (e.issue.diagnostics ? ' — ' + e.issue.diagnostics : '')) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
      if (!dryRun) await loadFhirMirror();
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  });
  document.getElementById('fhir-export')?.addEventListener('click', () => doFhirExport(false));
  document.getElementById('fhir-view')?.addEventListener('click', () => doFhirExport(true));
  // Entity read.
  document.getElementById('fhir-read')?.addEventListener('click', async () => {
    const out = document.getElementById('fhir-read-out');
    const realmId = document.getElementById('fhir-read-realm').value;
    const kind = document.getElementById('fhir-read-kind').value;
    const id = document.getElementById('fhir-read-id').value.trim();
    if (!kind || !id) { out.textContent = 'Pick a kind and enter an entity id.'; return; }
    try {
      const res = await fetch(`/admin/fhir/entity/${encodeURIComponent(realmId)}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      out.textContent = JSON.stringify(j, null, 2);
    } catch (err) { out.textContent = 'Error: ' + err.message; }
  });
  // CDS Hooks demo.
  document.getElementById('fhir-cds-run')?.addEventListener('click', async () => {
    const out = document.getElementById('fhir-cds-out');
    const realmId = document.getElementById('fhir-cds-realm').value;
    const hook = document.getElementById('fhir-cds-hook').value;
    const patientId = document.getElementById('fhir-cds-patient').value.trim();
    try {
      const res = await fetch('/admin/fhir/cds-hooks?realmId=' + encodeURIComponent(realmId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook, hookInstance: 'ui-' + Date.now(), context: { patientId } }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      const cards = j.cards || [];
      out.innerHTML = cards.length === 0 ? '<div class="muted">No decision support cards returned.</div>' : cards.map((c) => `<div class="section-card" style="margin:0 0 8px;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span class="pill ${c.indicator === 'warning' ? 'warn' : c.indicator === 'critical' ? 'bad' : 'good'}">${esc(c.indicator || 'info')}</span><strong>${esc(c.summary)}</strong></div><div style="font-size:13px;">${esc(c.detail || '')}</div>${c.source ? `<div class="muted" style="font-size:11px;margin-top:4px;">${esc(c.source.label || '')}</div>` : ''}</div>`).join('');
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  });
  // R4 coverage report filter.
  document.getElementById('fhir-cov-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#fhir-cov-table tbody tr').forEach((tr) => {
      tr.style.display = !q || String(tr.getAttribute('data-rt') || '').toLowerCase().includes(q) ? '' : 'none';
    });
  });
  // Seed the in-process FHIR emulator.
  document.getElementById('fhir-sub-seed')?.addEventListener('click', async () => {
    const em = document.getElementById('fhir-sub-emulator');
    const base = document.getElementById('fhir-sub-base').value.trim();
    if (base !== 'http://127.0.0.1:3000/fhir-mock') {
      em.innerHTML = `<span class="muted" style="font-size:12px;">The in-process emulator lives at <code>http://127.0.0.1:3000/fhir-mock</code> — set Base URL to it to use it.</span>`;
      return;
    }
    try {
      const res = await fetch('/admin/fhir/emulator/seed', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      em.innerHTML = `<span style="color:var(--good);">Emulator seeded: ${j.seeded} resources (${Object.entries(j.byType || {}).map(([t, n]) => `${t}×${n}`).join(', ')}). Now run one poll → it applies to the realm.</span>`;
    } catch (err) { em.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
  });
  // FHIR Subscription / CDC poll.
  document.getElementById('fhir-sub-run')?.addEventListener('click', async () => {
    const out = document.getElementById('fhir-sub-out');
    const baseUrl = document.getElementById('fhir-sub-base').value.trim();
    const resourceTypes = document.getElementById('fhir-sub-types').value.split(',').map((s) => s.trim()).filter(Boolean);
    const bearerToken = document.getElementById('fhir-sub-bearer').value.trim();
    try {
      const res = await fetch('/admin/fhir/subscription/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl, ...(bearerToken ? { bearerToken } : {}), resourceTypes, realmId: document.getElementById('fhir-sub-realm').value }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || j.error || res.status);
      out.innerHTML = `<span style="color:var(--good);">Polled ${esc(baseUrl)} → fetched ${j.fetched} resource(s), ${j.events} canonical event(s) (${(j.eventTypes || []).join(', ') || 'none'}).${j.ingested != null ? ` Applied ${j.ingested} → <strong>${j.structuralUpserts} structural upsert(s)</strong> to the realm.` : ''} Cursor: <code>${esc(j.nextSince)}</code></span>`;
    } catch (err) { out.innerHTML = `<span style="color:var(--bad);">Poll failed: ${esc(String(err))}</span> <span class="muted">(point the base URL at a reachable FHIR server or the in-process emulator)</span>`; }
  });
  await loadFhirMirror();
}

export async function renderUsers() {
  const r = await rawJson('GET', '/admin/auth/users');
  const meta = await rawJson('GET', '/admin/auth/meta');
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Console users</h2>
      <p class="page-sub">Local sign-in accounts for the operator console. Passwords are scrypt-hashed; every principal is mirrored to the identity registry for governance + audit.</p></div></div>
    <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
      <div class="stat-card"><div class="num">${r.users ? r.users.length : 0}</div><div class="lbl">Users</div></div>
      <div class="stat-card"><div class="num">${r.activeSessions ?? 0}</div><div class="lbl">Active sessions</div></div>
    </div>
    <div class="detail" style="margin-bottom:14px;">
      <h3 style="margin-top:0;">Create user</h3>
      <div class="field-row">
        <div class="field"><label>Username</label><input id="u-user" placeholder="clinical-mgr"></div>
        <div class="field"><label>Display name</label><input id="u-name" placeholder="Clinical Manager"></div>
        <div class="field"><label>Password</label><input id="u-pass" placeholder="min 4 chars"></div>
        <div class="field"><label>Role</label><select id="u-role">${(meta.roles || []).map((rr) => `<option>${esc(rr)}</option>`).join('')}</select></div>
        <div class="field"><label>Clearance</label><select id="u-clr">${(meta.clearances || []).map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Purpose of use</label><select id="u-pou">${(meta.purposesOfUse || []).map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
        <button class="btn btn-primary" id="u-create"><i data-lucide="user-plus"></i> Create user</button>
      </div>
    </div>
    <div id="users-grid"></div>`;
  const create = document.getElementById('u-create');
  if (create) create.addEventListener('click', async () => {
    const body = {
      username: document.getElementById('u-user').value.trim(),
      displayName: document.getElementById('u-name').value.trim(),
      password: document.getElementById('u-pass').value,
      role: document.getElementById('u-role').value,
      clearance: document.getElementById('u-clr').value,
      purposeOfUse: [document.getElementById('u-pou').value],
    };
    const res = await rawJson('POST', '/admin/auth/users', body);
    if (res.error) toast('Create failed: ' + res.error, 'err');
    else {
      toast('User ' + res.user.username + ' created', 'good');
      ['u-user', 'u-name', 'u-pass'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
      loadUsersGrid();
    }
  });
  // Row actions (reset password / delete) via delegation on the persistent container.
  const grid = document.getElementById('users-grid');
  if (grid) grid.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-user]');
    if (del) {
      const u = del.dataset.delUser;
      const res = await rawJson('DELETE', '/admin/auth/users/' + encodeURIComponent(u));
      if (!res.error) toast('User removed: ' + u, 'good'); else toast('Delete failed: ' + res.error, 'err');
      loadUsersGrid(); return;
    }
    const rst = e.target.closest('[data-reset-user]');
    if (rst) {
      const u = rst.dataset.resetUser;
      const pass = prompt('New password for ' + u + ':', '');
      if (pass == null) return;
      const res = await rawJson('POST', '/admin/auth/users/' + encodeURIComponent(u) + '/reset-password', { password: pass });
      if (!res.error) toast('Password reset for ' + u, 'good'); else toast('Reset failed: ' + res.error, 'err');
    }
  });
  loadUsersGrid();
}
