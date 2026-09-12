import { S } from '../state.js';
import { api, consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { dataGrid, esc, toast } from '../core/theme.js';

export const sh = {
  val(id) { return document.getElementById(id)?.value || ''; },
  set(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; },
  async req(method, url, body) {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(((await res.json())?.error) || res.status);
    return res.json();
  },
  wireSearch(inputId, tbodyId) {
    const inp = document.getElementById(inputId);
    if (inp) inp.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(`#${tbodyId} tr`).forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
  },
  wireDelete(tbody) {
    tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const url = b.dataset.del; // e.g. "facilities/<id>"
      if (!confirm(`Delete ${url.split('/')[0].slice(0, -1)} '${decodeURIComponent(url.split('/').slice(1).join('/'))}'?`)) return;
      try { await sh.req('DELETE', '/admin/settings/' + url); toast('Deleted', 'good'); loadSettingsTab(); }
      catch (e) { toast('Delete failed: ' + e.message, 'err'); }
    }));
  },
};

export async function renderSettings() {
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Admin · Settings</h2>
      <p class="page-sub">Master data for your organization — facilities, units, patients, assessment catalog, lifecycle stages, nudge templates, and durable realms. Persisted in the swappable SQL store.</p></div></div>
    <div class="tabs">
      ${['facilities', 'units', 'patients', 'assessments', 'lifecycle', 'nudges', 'realms'].map(t => `<button class="tab ${S.settingsTab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div id="settings-body"><div class="muted">Loading…</div></div>`;
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => { S.settingsTab = b.dataset.tab; S.settingsEdit = ''; loadSettingsTab(); }));
  await loadSettingsTab();
}

export async function loadSettingsTab() {
  const body = document.getElementById('settings-body');
  if (!body) return;
  if (S.settingsTab === 'facilities') return loadFacilitiesTab(body);
  if (S.settingsTab === 'units') return loadUnitsTab(body);
  if (S.settingsTab === 'patients') return loadPatientsTab(body);
  if (S.settingsTab === 'assessments') return loadAssessmentsTab(body);
  if (S.settingsTab === 'lifecycle') return loadLifecycleTab(body);
  if (S.settingsTab === 'nudges') return loadNudgesTab(body);
  if (S.settingsTab === 'realms') return loadRealmsTab(body);
}

export function bindCrudActions(body, editFields) {
  body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const url = del.dataset.del;
      if (!confirm(`Delete ${url.split('/')[0].slice(0, -1)} '${decodeURIComponent(url.split('/').slice(1).join('/'))}'?`)) return;
      sh.req('DELETE', '/admin/settings/' + url).then(() => { toast('Deleted', 'good'); loadSettingsTab(); }).catch((err) => toast('Delete failed: ' + err.message, 'err'));
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit && editFields) editFields(JSON.parse(edit.dataset.edit));
  });
}

export async function loadFacilitiesTab(body) {
  const dom = await consoleDomain();
  const [d, r] = await Promise.all([api('GET', '/admin/settings/facilities'), api('GET', '/admin/settings/realms')]);
  const rows = d.facilities || [];
  const realmOpts = (r.realms || []).map(x => `<option value="${esc(x.realmId)}">${esc(x.realmId)}</option>`).join('');
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Id</span><input id="sf-id" placeholder="facility-1"></label>
        <label class="field"><span>Name</span><input id="sf-name" placeholder="Northside Dialysis"></label>
        <label class="field"><span>Kind</span><select id="sf-kind">${(dom.domainOptions.facilityKinds || []).map((o) => { const kv = Array.isArray(o) ? { v: o[0], l: o[1] } : { v: o.value, l: o.label }; return `<option value="${esc(kv.v)}">${esc(kv.l)}</option>`; }).join('')}</select></label>
        <label class="field"><span>Realm</span><select id="sf-realm">${realmOpts || '<option value="realm:default">realm:default</option>'}</select></label>
        <button class="btn btn-primary" id="sf-add"><i data-lucide="plus"></i> Add</button>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Facilities</h3><div id="sf-grid"></div></div>`;
  document.getElementById('sf-add')?.addEventListener('click', async () => {
    const payload = { id: sh.val('sf-id'), realmId: sh.val('sf-realm'), name: sh.val('sf-name'), kind: sh.val('sf-kind') };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/facilities/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/facilities', payload);
      toast(S.settingsEdit ? 'Facility updated' : 'Facility added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'sf-grid', filename: 'facilities', empty: 'No facilities yet.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'name', label: 'Name' },
      { key: 'kind', label: 'Kind', render: (v) => v ? `<span class="pill muted">${esc(v)}</span>` : '—' },
      { key: 'realmId', label: 'Realm' },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, name: r.name, kind: r.kind || 'dialysis', realmId: r.realmId }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="facilities/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id; sh.set('sf-id', v.id); sh.set('sf-name', v.name); sh.set('sf-kind', v.kind); sh.set('sf-realm', v.realmId);
    document.getElementById('sf-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadUnitsTab(body) {
  const [d, fac, r] = await Promise.all([api('GET', '/admin/settings/units'), api('GET', '/admin/settings/facilities'), api('GET', '/admin/settings/realms')]);
  const rows = d.units || [];
  const facOpts = (fac.facilities || []).map(x => `<option value="${esc(x.id)}">${esc(x.id)}</option>`).join('');
  const realmOpts = (r.realms || []).map(x => `<option value="${esc(x.realmId)}">${esc(x.realmId)}</option>`).join('');
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Id</span><input id="su-id" placeholder="f1-ICH-A"></label>
        <label class="field"><span>Code</span><input id="su-code" placeholder="ICH-A"></label>
        <label class="field"><span>Facility</span><select id="su-facility">${facOpts || '<option value="f1">f1</option>'}</select></label>
        <label class="field"><span>Realm</span><select id="su-realm">${realmOpts || '<option value="realm:default">realm:default</option>'}</select></label>
        <button class="btn btn-primary" id="su-add"><i data-lucide="plus"></i> Add</button>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Units</h3><div id="su-grid"></div></div>`;
  document.getElementById('su-add')?.addEventListener('click', async () => {
    const payload = { id: sh.val('su-id'), code: sh.val('su-code'), facilityId: sh.val('su-facility'), realmId: sh.val('su-realm') };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/units/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/units', payload);
      toast(S.settingsEdit ? 'Unit updated' : 'Unit added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'su-grid', filename: 'units', empty: 'No units yet.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'code', label: 'Code', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
      { key: 'facilityId', label: 'Facility' },
      { key: 'realmId', label: 'Realm' },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, code: r.code, facilityId: r.facilityId, realmId: r.realmId }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="units/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id; sh.set('su-id', v.id); sh.set('su-code', v.code); sh.set('su-facility', v.facilityId); sh.set('su-realm', v.realmId);
    document.getElementById('su-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadPatientsTab(body) {
  const dom = await consoleDomain();
  const [d, fac, un, r] = await Promise.all([
    api('GET', '/admin/settings/patients'), api('GET', '/admin/settings/facilities'),
    api('GET', '/admin/settings/units'), api('GET', '/admin/settings/realms'),
  ]);
  const rows = d.patients || [];
  const facOpts = (fac.facilities || []).map(x => `<option value="${esc(x.id)}">${esc(x.id)}</option>`).join('');
  const unitOpts = (un.units || []).map(x => `<option value="${esc(x.id)}">${esc(x.code)}</option>`).join('');
  const realmOpts = (r.realms || []).map(x => `<option value="${esc(x.realmId)}">${esc(x.realmId)}</option>`).join('');
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Id</span><input id="sp-id" placeholder="f1-pt-0001"></label>
        <label class="field"><span>Name</span><input id="sp-name" placeholder="optional"></label>
        <label class="field"><span>Age</span><input id="sp-age" type="number" min="0" placeholder="0"></label>
        <label class="field"><span>Sex</span><select id="sp-sex"><option value=""></option><option>F</option><option>M</option></select></label>
        <label class="field"><span>Trajectory</span><select id="sp-trajectory"><option value=""></option>${(dom.domainOptions.trajectories || []).map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="field"><span>Facility</span><select id="sp-facility">${facOpts || '<option value="f1">f1</option>'}</select></label>
        <label class="field"><span>Unit</span><select id="sp-unit">${unitOpts || '<option value="f1-ICH-A">f1-ICH-A</option>'}</select></label>
        <label class="field"><span>Realm</span><select id="sp-realm">${realmOpts || '<option value="realm:default">realm:default</option>'}</select></label>
        <button class="btn btn-primary" id="sp-add"><i data-lucide="plus"></i> Add</button>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Patients</h3><div id="sp-grid"></div></div>`;
  document.getElementById('sp-add')?.addEventListener('click', async () => {
    const age = Number(sh.val('sp-age'));
    const payload = {
      id: sh.val('sp-id'), facilityId: sh.val('sp-facility'), unitId: sh.val('sp-unit'), realmId: sh.val('sp-realm'),
      name: sh.val('sp-name') || undefined, sex: sh.val('sp-sex') || undefined,
      trajectory: sh.val('sp-trajectory') || undefined, ...(sh.val('sp-age') ? { age } : {}),
    };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/patients/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/patients', payload);
      toast(S.settingsEdit ? 'Patient updated' : 'Patient added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'sp-grid', filename: 'patients', empty: 'No patients yet.', pageSize: 25,
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'name', label: 'Name', render: (v) => esc(v || '—') },
      { key: 'age', label: 'Age' }, { key: 'sex', label: 'Sex' },
      { key: 'trajectory', label: 'Trajectory', render: (v) => `<span class="pill ${v==='decompensating'||v==='underdialyzed'||v==='hyperphosphatemia'||v==='anemic-worsening'?'bad':v==='stable'?'good':'muted'}">${esc(v || '—')}</span>` },
      { key: 'facilityId', label: 'Facility' }, { key: 'unitId', label: 'Unit' },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, name: r.name || '', age: r.age ?? '', sex: r.sex || '', trajectory: r.trajectory || '', facilityId: r.facilityId, unitId: r.unitId, realmId: r.realmId }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="patients/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id;
    ['sp-id', 'sp-name', 'sp-age', 'sp-sex', 'sp-trajectory', 'sp-facility', 'sp-unit', 'sp-realm'].forEach((id, i) => sh.set(id, [v.id, v.name, v.age, v.sex, v.trajectory, v.facilityId, v.unitId, v.realmId][i]));
    document.getElementById('sp-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadAssessmentsTab(body) {
  const d = await api('GET', '/admin/settings/assessments');
  const rows = d.assessments || [];
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Id</span><input id="sa-id" placeholder="assess-1"></label>
        <label class="field"><span>Title</span><input id="sa-title" placeholder="Dialysis Symptom Index"></label>
        <label class="field"><span>Loinc</span><input id="sa-loinc" placeholder="optional"></label>
        <label class="field"><span>Domain</span><input id="sa-domain" placeholder="dialysis"></label>
        <label class="field"><span>Items</span><input id="sa-items" type="number" min="0" placeholder="0"></label>
        <button class="btn btn-primary" id="sa-add"><i data-lucide="plus"></i> Add</button>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Assessment catalog</h3><div id="sa-grid"></div></div>`;
  document.getElementById('sa-add')?.addEventListener('click', async () => {
    const payload = {
      id: sh.val('sa-id'), title: sh.val('sa-title'), domain: sh.val('sa-domain'),
      ...(sh.val('sa-loinc') ? { loinc: sh.val('sa-loinc') } : {}),
      ...(sh.val('sa-items') ? { itemCount: Number(sh.val('sa-items')) } : {}),
    };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/assessments/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/assessments', payload);
      toast(S.settingsEdit ? 'Assessment updated' : 'Assessment added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'sa-grid', filename: 'assessments', empty: 'No assessments in the catalog yet.',
    columns: [
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'title', label: 'Title' },
      { key: 'loinc', label: 'Loinc', render: (v) => v ? `<code>${esc(v)}</code>` : '—' },
      { key: 'domain', label: 'Domain', render: (v) => v ? `<span class="pill muted">${esc(v)}</span>` : '—' },
      { key: 'itemCount', label: 'Items', align: 'right' },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, title: r.title, loinc: r.loinc || '', domain: r.domain, itemCount: r.itemCount ?? 0 }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="assessments/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id;
    sh.set('sa-id', v.id); sh.set('sa-title', v.title); sh.set('sa-loinc', v.loinc); sh.set('sa-domain', v.domain); sh.set('sa-items', v.itemCount);
    document.getElementById('sa-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadLifecycleTab(body) {
  const dom = await consoleDomain();
  const d = await api('GET', '/admin/settings/lifecycle');
  const rows = d.lifecycle || [];
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Id</span><input id="sl-id" placeholder="stage-intake"></label>
        <label class="field"><span>Order</span><input id="sl-order" type="number" min="0" placeholder="0"></label>
        <label class="field"><span>Label</span><input id="sl-label" placeholder="Intake"></label>
        <label class="field"><span>Kind</span><select id="sl-kind">${(dom.domainOptions.lifecycleKinds || []).map((o) => { const kv = Array.isArray(o) ? { v: o[0], l: o[1] } : { v: o.value, l: o.label }; return `<option value="${esc(kv.v)}">${esc(kv.l)}</option>`; }).join('')}</select></label>
        <button class="btn btn-primary" id="sl-add"><i data-lucide="plus"></i> Add</button>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Lifecycle stages</h3><div id="sl-grid"></div></div>`;
  document.getElementById('sl-add')?.addEventListener('click', async () => {
    const payload = { id: sh.val('sl-id'), label: sh.val('sl-label'), kind: sh.val('sl-kind'), ...(sh.val('sl-order') ? { orderNum: Number(sh.val('sl-order')) } : {}) };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/lifecycle/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/lifecycle', payload);
      toast(S.settingsEdit ? 'Stage updated' : 'Stage added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'sl-grid', filename: 'lifecycle', empty: 'No lifecycle stages yet.',
    columns: [
      { key: 'orderNum', label: '#', align: 'right' },
      { key: 'id', label: 'Id', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'label', label: 'Label' },
      { key: 'kind', label: 'Kind', render: (v) => `<span class="pill brand">${esc(v)}</span>` },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, orderNum: r.orderNum ?? 0, label: r.label, kind: r.kind }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="lifecycle/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id;
    sh.set('sl-id', v.id); sh.set('sl-order', v.orderNum); sh.set('sl-label', v.label); sh.set('sl-kind', v.kind);
    document.getElementById('sl-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadNudgesTab(body) {
  const d = await api('GET', '/admin/settings/nudges');
  const rows = d.nudges || [];
  body.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="field-row">
        <label class="field"><span>Nudge kind</span><input id="sn-kind" placeholder="medication-adherence"></label>
        <label class="field"><span>Channel</span><select id="sn-channel"><option value="in-app">In-app</option><option value="sms">SMS</option><option value="email">Email</option><option value="pager">Pager</option></select></label>
        <label class="field" style="flex:1;min-width:220px;"><span>Description</span><input id="sn-desc" placeholder="Prompt the care team to follow up on missed dialysis sessions"></label>
        <button class="btn btn-primary" id="sn-add"><i data-lucide="plus"></i> Add</button>
      </div>
      <div class="field-row" style="margin-top:8px;">
        <label class="field" style="flex:1;"><span>Expected effect (JSON)</span><input id="sn-effect" placeholder='{"outcome":"attendance","lift":0.12}'></label>
      </div>
    </div>
    <div class="detail" style="margin-top:12px;"><h3 style="margin-top:0;">Nudge templates</h3><div id="sn-grid"></div></div>`;
  document.getElementById('sn-add')?.addEventListener('click', async () => {
    const payload = {
      nudgeKind: sh.val('sn-kind'), channel: sh.val('sn-channel'),
      ...(sh.val('sn-desc') ? { description: sh.val('sn-desc') } : {}),
      ...(sh.val('sn-effect') ? { expectedEffectJson: sh.val('sn-effect') } : {}),
      ...(S.settingsEdit ? { id: S.settingsEdit } : {}),
    };
    try {
      if (S.settingsEdit) await sh.req('PUT', `/admin/settings/nudges/${encodeURIComponent(S.settingsEdit)}`, payload);
      else await sh.req('POST', '/admin/settings/nudges', payload);
      toast(S.settingsEdit ? 'Nudge template updated' : 'Nudge template added', 'good'); S.settingsEdit = ''; loadSettingsTab();
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  });
  dataGrid({
    el: 'sn-grid', filename: 'nudges', empty: 'No nudge templates yet.',
    columns: [
      { key: 'nudgeKind', label: 'Nudge kind', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'channel', label: 'Channel', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'description', label: 'Description', render: (v) => esc(v || '—') },
      { key: 'expectedEffectJson', label: 'Expected effect', render: (v) => v ? `<code>${esc(v)}</code>` : '—', hide: true },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions">
        <button class="btn btn-ghost" data-edit='${esc(JSON.stringify({ id: r.id, nudgeKind: r.nudgeKind, channel: r.channel, description: r.description || '', expectedEffectJson: r.expectedEffectJson || '' }))}' title="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost" data-del="nudges/${encodeURIComponent(r.id)}" title="Delete"><i data-lucide="trash-2"></i></button>
      </span>` },
    ],
    data: rows,
  });
  bindCrudActions(body, (v) => {
    S.settingsEdit = v.id;
    sh.set('sn-kind', v.nudgeKind); sh.set('sn-channel', v.channel); sh.set('sn-desc', v.description); sh.set('sn-effect', v.expectedEffectJson);
    document.getElementById('sn-add').innerHTML = '<i data-lucide="save"></i> Update';
    toast('Editing ' + v.id + ' — change fields then Update', 'good');
  });
}

export async function loadRealmsTab(body) {
  const r = await api('GET', '/admin/settings/realms');
  const rows = r.realms || [];
  body.innerHTML = `
    <div class="detail" style="margin-top:0;"><h3 style="margin-top:0;">Durable realm snapshots</h3>
      <p class="page-sub" style="margin-bottom:10px;">Persisted realm records (survive restarts). Live realm lifecycle — create, tick, delete — lives in <b>World → Realm</b>.</p>
      <div id="sr-grid"></div>
    </div>`;
  dataGrid({
    el: 'sr-grid', filename: 'realms', empty: 'No persisted realm snapshots yet — create a realm from World → Realm.',
    columns: [
      { key: 'realmId', label: 'Realm', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'mode', label: 'Mode', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'createdAt', label: 'Created' }, { key: 'updatedAt', label: 'Updated' },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<span class="row-actions"><button class="btn btn-ghost" data-del="realms/${encodeURIComponent(r.realmId)}" title="Delete snapshot"><i data-lucide="trash-2"></i></button></span>` },
    ],
    data: rows,
  });
  bindCrudActions(body);
}
