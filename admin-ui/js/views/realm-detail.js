import { S } from '../state.js';
import { api, consoleDomain } from '../core/api.js';
import { render } from '../core/router.js';
import { main } from '../core/shell.js';
import { dataGrid, esc, hydrateIcons, toast } from '../core/theme.js';
import { closeRealmModal, createModalHTML, openRealmModal, realmCard, trajPill } from './realm.js';

export async function loadRealmDetail(id) {
  const dom = await consoleDomain();
  const right = document.getElementById('rm-right');
  if (!right) return;
  right.innerHTML = '<div class="muted" style="padding:24px;">Loading…</div>';
  const [detail, patients] = await Promise.all([
    api('GET', `/admin/realms/${encodeURIComponent(id)}`),
    api('GET', `/admin/realms/${encodeURIComponent(id)}/patients`),
  ]);
  const presences = detail.presences || [];
  const recentEffects = (detail.recentEffects || []).slice().reverse();
  const experiences = detail.experiences || [];
  const costTotal = detail.cost?.totals?.totalUsd;
  const enginePill = detail.trajectoryEngine === 'liquid'
    ? '<span class="pill brand">Anant trajectory AI</span>'
    : '<span class="pill muted">legacy</span>';
  right.innerHTML = `
    <div class="detail" style="margin-top:0;">
      <div class="kv">
        <div class="k">Realm</div><div><code>${esc(detail.id || id)}</code> <span class="pill muted">${esc(detail.mode || 'sim')}</span> ${enginePill}</div>
        <div class="k">Realm time</div><div class="muted">${detail.realmAt ? new Date(detail.realmAt).toLocaleString() : '—'} · tick ${detail.seq ?? 0}</div>
        <div class="k">Cost accrued</div><div>${costTotal != null ? '$' + Number(costTotal).toFixed(2) : '—'}</div>
        <div class="k">Episodes / attributions</div><div>${detail.episodes?.total ?? 0} / ${detail.attribution?.total ?? 0}</div>
      </div>
      <div class="field-row" style="margin-top:10px;">
        <button class="btn" id="rm-tick"><i data-lucide="play"></i> Advance 1 hour</button>
        <button class="btn btn-danger" id="rm-delete"><i data-lucide="trash-2"></i> Delete realm</button>
      </div>
    </div>
    <div class="section-card">
      <h3>Drive the simulation</h3>
      <div class="field-row" style="align-items:flex-end;gap:10px;">
        <div class="field"><label>Agent spec</label><input id="rm-spec" value="nurse" style="width:110px"></div>
        <div class="field"><label>Role</label><select id="rm-role">${(dom.domainOptions.roleOptions || []).map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
        <div class="field"><label>Clearance</label><select id="rm-clear">${(dom.domainOptions.clearanceOptions || []).map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Facility</label><input id="rm-facility" value="f1" style="width:90px"></div>
        <div class="field"><label>Unit</label><input id="rm-unit" placeholder="ICH-A" style="width:90px"></div>
        <button class="btn btn-primary" id="rm-spawn"><i data-lucide="user-plus"></i> Spawn presence</button>
      </div>
      <div style="border-top:1px solid var(--border);margin:12px 0;"></div>
      <div class="field-row" style="align-items:flex-end;gap:10px;">
        <div class="field"><label>Emit as presence</label><select id="rm-eff-presence">${presences.map((p) => `<option value="${esc(p.presenceId)}">${esc(p.agentSpecId)}</option>`).join('') || '<option value="">no presences — spawn one first</option>'}</select></div>
        <div class="field"><label>Effect kind</label><select id="rm-eff-kind">${(dom.effectKinds || []).map((k) => `<option>${esc(k)}</option>`).join('')}</select></div>
        <div class="field"><label>Patient</label><select id="rm-eff-patient">${(patients.patients || []).map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('') || '<option value="">no patients</option>'}</select></div>
      </div>
      <div class="field" style="margin-top:8px;"><label>Effect JSON (kind + patientId are overridden by the selects)</label><textarea id="rm-eff-json" rows="5" style="font-family:"JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px;"></textarea></div>
      <div class="field-row" style="margin-top:8px;">
        <button class="btn btn-primary" id="rm-emit"><i data-lucide="send"></i> Emit effect</button>
      </div>
    </div>
    <div class="section-card">
      <h3>Local corpus</h3>
      <p class="page-sub" style="font-size:12px;margin:0 0 8px;">Upload a facility policy / protocol document — stored as a realm-scoped knowledge artifact (SHA-256 tracked) in <code>${esc(id)}</code>.</p>
      <div class="field-row">
        <div class="field" style="flex:1;"><input type="file" id="lc-file"></div>
        <button class="btn btn-primary" id="lc-upload"><i data-lucide="upload"></i> Upload</button>
      </div>
      <div id="lc-status" class="muted" style="font-size:12px;margin-top:6px;"></div>
      <div id="lc-docs" style="margin-top:8px;"></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Patients (${(patients.patients || []).length})</h3>
      <div id="rm-patients-grid"></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Agent presences (${presences.length})</h3>
      <div id="rm-presences-grid"></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Recent effects (${recentEffects.length})</h3>
      <div id="rm-effects-grid"></div>
    </div>
    <div class="detail"><h3 style="margin-top:0;">Experiences (${experiences.length})</h3>
      <div id="rm-experiences-grid"></div>
    </div>`;
  document.getElementById('rm-tick')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/admin/realms/${encodeURIComponent(id)}/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMs: 3600_000 }) });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
      toast(`Advanced 1 hour in ${id}`, 'good'); render();
    } catch (err) { toast('Tick failed: ' + err.message, 'err'); }
  });
  document.getElementById('rm-delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete realm ${id}? This stops its clock and removes it.`)) return;
    try {
      const res = await fetch(`/admin/realms/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
      S.realmSel = ''; toast('Realm removed', 'good'); render();
    } catch (err) { toast('Delete failed: ' + err.message, 'err'); }
  });
  // ---- Drive-the-sim: spawn a presence ----
  document.getElementById('rm-spawn')?.addEventListener('click', async () => {
    const body = {
      agentSpecId: document.getElementById('rm-spec').value || 'nurse',
      role: document.getElementById('rm-role').value,
      clearance: document.getElementById('rm-clear').value,
      facilityId: document.getElementById('rm-facility').value || 'f1',
      ...(document.getElementById('rm-unit').value ? { unitId: document.getElementById('rm-unit').value } : {}),
    };
    try {
      const res = await fetch(`/admin/realms/${encodeURIComponent(id)}/presences`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      toast(`Presence spawned (${body.agentSpecId})`, 'good');
      loadRealmDetail(id);
    } catch (err) { toast('Spawn failed: ' + err.message, 'err'); }
  });
  // ---- Drive-the-sim: emit an effect ----
  const effKind = document.getElementById('rm-eff-kind');
  const effPt = document.getElementById('rm-eff-patient');
  const effPresence = document.getElementById('rm-eff-presence');
  const effJson = document.getElementById('rm-eff-json');
  const effTemplate = (kind, patientId, unitId) => {
    const base = { ...(patientId ? { patientId } : {}), ...(unitId ? { unitId } : {}) };
    // Payload from the backend console-domain catalog; template fields win on
    // non-positional keys, while patientId/unitId positionals override.
    const t = (dom.effectTemplates && dom.effectTemplates[kind]) || {};
    return { ...t, ...base };
  };
  const fillEffectJson = () => {
    if (!effJson) return;
    const p = presences.find((x) => x.presenceId === effPresence?.value);
    const unit = p?.location?.unitId;
    const json = effTemplate(effKind?.value || 'record-vitals', effPt?.value, unit);
    effJson.value = JSON.stringify(json, null, 2);
  };
  if (effKind) effKind.addEventListener('change', fillEffectJson);
  if (effPt) effPt.addEventListener('change', fillEffectJson);
  if (effPresence) effPresence.addEventListener('change', fillEffectJson);
  fillEffectJson();
  document.getElementById('rm-emit')?.addEventListener('click', async () => {
    try {
      let eff = JSON.parse(effJson.value);
      eff = { ...eff, kind: effKind.value, ...(effPt.value ? { patientId: effPt.value } : {}) };
      const res = await fetch(`/admin/realms/${encodeURIComponent(id)}/emit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presenceId: effPresence.value, effect: eff }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      toast('Effect emitted', 'good');
      loadRealmDetail(id);
    } catch (err) { toast('Emit failed: ' + err.message, 'err'); }
  });
  // ---- Local corpus upload (realm-scoped knowledge artifact) ----
  document.getElementById('lc-upload')?.addEventListener('click', async () => {
    const input = document.getElementById('lc-file');
    const status = document.getElementById('lc-status');
    if (!input?.files || !input.files[0]) { if (status) status.textContent = 'Pick a file first.'; return; }
    const file = input.files[0];
    if (status) status.textContent = 'Uploading ' + file.name + '…';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; bytes.forEach((b) => { binary += String.fromCharCode(b); });
      const res = await fetch(`/admin/realms/${encodeURIComponent(id)}/local-corpus`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', dataBase64: btoa(binary) }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      if (status) status.innerHTML = `<span style="color:var(--good);">✓ Ingested — <code>${esc(j.artifactId)}</code> (${j.bytes} bytes · sha256 <code>${esc(j.hash.slice(0, 16))}…</code>)</span>`;
      input.value = '';
      loadLcDocs(id);
    } catch (err) { if (status) status.innerHTML = `<span style="color:var(--bad);">Upload failed: ${esc(String(err))}</span>`; }
  });
  loadLcDocs(id);
  // ---- Local corpus document list (uploaded protocols/SOPs) ----
  async function loadLcDocs(realmId) {
    const el = document.getElementById('lc-docs');
    if (!el) return;
    try {
      const res = await fetch(`/admin/realms/${encodeURIComponent(realmId)}/local-corpus`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      const docs = j.documents || [];
      el.innerHTML = docs.length === 0
        ? '<div class="muted" style="font-size:12px;">No documents uploaded. Agents scoped to this realm can cite these via <code>search_local_corpus</code>.</div>'
        : `<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">Uploaded documents (${docs.length}) — citable by agents</div>` +
          docs.map((d) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);font-size:12px;"><span><code>${esc(d.artifactId)}</code> · ${esc(d.filename)}</span><span class="muted">${d.bytes} B · ${new Date(d.uploadedAt).toLocaleString()}</span></div>`).join('');
    } catch (err) {
      el.innerHTML = `<span class="muted" style="font-size:12px;">Could not list corpus: ${esc(String(err))}</span>`;
    }
  }
  dataGrid({
    el: 'rm-patients-grid', filename: 'realm-patients', pageSize: 10, empty: 'No patients yet — create the realm with a seed (units + patient count).',
    columns: [
      { key: 'id', label: 'ID', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'trajectory', label: 'Trajectory', render: (v) => trajPill(v) },
      { key: 'hr', label: 'HR', render: (v) => esc(v ?? '—') },
      { key: 'spo2', label: 'SpO₂', render: (v) => esc(v ?? '—') },
      { key: 'K', label: 'K', render: (v) => esc(v ?? '—') },
      { key: 'urr', label: 'URR', render: (v) => esc(v ?? '—') },
      { key: 'phos', label: 'PHOS', render: (v) => esc(v ?? '—') },
      { key: '_actions', label: '', sortable: false, filter: false, render: (_v, r) => `<button class="btn btn-ghost" style="padding:2px 8px;" onclick="wiDeepLink={realmId:'${esc(id)}',patientId:'${esc(r.id)}'};goTo('liquid-whatif');" title="Open in What-If forecast"><i data-lucide="trending-up" style="width:13px;height:13px;"></i> What-If</button>` },
    ],
    data: (patients.patients || []).map(p => { const st = p.state || {}; const labs = st.labs || {}; return { id: p.id, trajectory: st.trajectory, hr: st.lastVitals?.hr, spo2: st.lastVitals?.spo2, K: labs.K, urr: labs.URR, phos: labs.PHOS }; }),
  });
  dataGrid({
    el: 'rm-presences-grid', filename: 'realm-presences', pageSize: 10, empty: 'No presences spawned yet.',
    columns: [
      { key: 'agentSpecId', label: 'Agent', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'role', label: 'Role', render: (v) => `<span class="pill muted">${esc(v)}</span>` },
      { key: 'loc', label: 'Location', render: (_v, r) => `${esc(r.location?.facilityId || '—')} / ${esc(r.location?.unitId || '—')}` },
      { key: 'attention', label: 'Attention', render: (v) => `<span class="pill ${v==='active'?'good':'muted'}">${esc(v)}</span>` },
    ],
    data: presences,
  });
  dataGrid({
    el: 'rm-effects-grid', filename: 'realm-effects', pageSize: 10, empty: 'No effects yet — tick the clock or emit an effect.',
    columns: [
      { key: 'realmAt', label: 'At', render: (v) => `<span class="muted">${esc(v || '')}</span>` },
      { key: 'kind', label: 'Kind', render: (_v, r) => `<span class="pill">${esc(r.effect?.kind || '')}</span>` },
      { key: 'detail', label: 'Detail', render: (_v, r) => `<span class="muted">${esc(JSON.stringify(r.effect || {}).slice(0, 130))}</span>` },
    ],
    data: recentEffects,
  });
  dataGrid({
    el: 'rm-experiences-grid', filename: 'realm-experiences', pageSize: 10, empty: 'No experiences yet.',
    columns: [
      { key: 'kind', label: 'Kind', render: (v) => `<code>${esc(v)}</code>` },
      { key: 'severity', label: 'Severity', render: (v) => `<span class="pill ${v==='critical'?'bad':v==='notice'?'good':'muted'}">${esc(v)}</span>` },
      { key: 'ruleId', label: 'Rule', render: (_v, r) => `<code>${esc(r.ruleId || r.ruleSource || '')}</code>` },
    ],
    data: experiences,
  });
  hydrateIcons();
}

export async function renderRealm() {
  const dom = await consoleDomain();
  const d = await api('GET', '/admin/realms');
  const realms = d.realms || [];
  if (!S.realmSel || !realms.some(r => r.id === S.realmSel)) S.realmSel = realms[0]?.id || '';

  if (realms.length === 0) {
    main.innerHTML = `
      <div class="page-header"><div><h2 class="page-title">Realm management</h2>
        <p class="page-sub">No live realms yet. Create one (or use <b>Build a world</b>) — agents, patients, and the What-If forecast all run inside a realm.</p></div></div>
      <div class="detail" style="margin-top:0;">
        <p class="muted" style="margin-bottom:12px;">Create your first realm to start simulating patients and running What-If forecasts.</p>
        <button class="btn btn-primary" id="rm-open-create"><i data-lucide="plus"></i> Create a realm</button>
      </div>
      ${createModalHTML()}`;
    wireModal();
    return;
  }

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Realm management</h2>
      <p class="page-sub">Select a realm on the left — its patients and live state appear on the right. Click a realm to link the patient grid. Realms are <b>persisted</b> (creation spec → durable store) and restored on restart.</p></div></div>
    <div style="display:grid;grid-template-columns:300px 1fr;gap:14px;align-items:start;">
      <div class="detail" style="margin-top:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h3 style="margin:0;">Realms</h3>
          <button class="btn btn-primary" id="rm-open-create" style="height:30px;padding:0 10px;"><i data-lucide="plus"></i> Create</button>
        </div>
        ${realms.map(realmCard).join('')}
      </div>
      <div id="rm-right"><div class="muted" style="padding:24px;">Select a realm to view its patients.</div></div>
    </div>
    ${createModalHTML()}`;
  wireModal();
  document.querySelectorAll('.rm-card').forEach(c => c.addEventListener('click', () => selectRealm(c.dataset.id)));
  if (S.realmDeepLink && realms.some(r => r.id === S.realmDeepLink)) {
    S.realmSel = S.realmDeepLink; S.realmDeepLink = '';
    document.querySelectorAll('.rm-card').forEach(c => c.classList.toggle('active', c.dataset.id === S.realmSel));
  }
  if (S.realmSel) await loadRealmDetail(S.realmSel);
}

export function createRealm() {
  const id = (document.getElementById('rm-id')?.value || '').trim();
  const arch = document.getElementById('rm-arch')?.value || 'dialysis';
  const units = (document.getElementById('rm-units')?.value || S.dom.domainOptions.unitsDefault).split(',').map(s => s.trim()).filter(Boolean);
  const pt = Number(document.getElementById('rm-pt')?.value || 8);
  const clock = document.getElementById('rm-clock')?.value || 'sim';
  const engine = document.getElementById('rm-engine')?.value || 'liquid';
  if (!id) return toast('Enter a realm id', 'err');
  const body = { id, mode: clock, trajectoryEngine: engine, seed: { facilityId: 'f1', kind: arch, name: arch, units, patientCount: Math.max(1, Math.min(200, pt)) } };
  fetch('/admin/realms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (res) => {
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
      closeRealmModal(); S.realmSel = id; toast(`Realm ${id} created`, 'good'); render();
    })
    .catch((err) => toast('Create failed: ' + err.message, 'err'));
}

export async function selectRealm(id) {
  S.realmSel = id;
  document.querySelectorAll('.rm-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  await loadRealmDetail(id);
}

export function wireModal() {
  const open = document.getElementById('rm-open-create'); if (open) open.addEventListener('click', openRealmModal);
  const closeBtn = document.getElementById('rm-modal-close'); if (closeBtn) closeBtn.addEventListener('click', closeRealmModal);
  const cancel = document.getElementById('rm-modal-cancel'); if (cancel) cancel.addEventListener('click', closeRealmModal);
  const overlay = document.getElementById('rm-modal'); if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRealmModal(); });
  const createBtn = document.getElementById('rm-create'); if (createBtn) createBtn.addEventListener('click', createRealm);
}
