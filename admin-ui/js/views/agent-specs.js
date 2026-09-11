import { loadFailureHTML } from '../core/scope.js';
import { esc, hydrateIcons, toast } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export const CFG_SPEC_PILL = { published: 'good', draft: 'brand', 'in-review': 'warn', rejected: 'bad' };

export async function cfgSpecDelete(i) {
  const row = cfgSpecRows[i]; if (!row) return;
  if (!confirm(`Delete the stored spec for ${row.packId}/${row.agentId}? The YAML tree is the source it was imported from, so re-importing will bring it back.`)) return;
  try {
    await plFetch('DELETE', `/admin/platform/agent-specs/${encodeURIComponent(row.packId)}/${encodeURIComponent(row.agentId)}`);
    toast('Deleted', 'good');
    cfgSpecsBody();
  } catch (e) { toast(e.message, 'bad'); }
}

export async function cfgSpecExport(i) {
  const row = cfgSpecRows[i]; if (!row) return;
  try {
    const j = await plFetch('POST', `/admin/platform/agent-specs/${encodeURIComponent(row.packId)}/${encodeURIComponent(row.agentId)}/materialize`, {});
    toast(`Exported to ${j.exported ? j.exported.path : 'the tree'}`, 'good');
    cfgSpecsBody();
  } catch (e) { toast(e.message, 'bad'); }
}

export async function cfgSpecImport(dryRun) {
  try {
    const j = await plFetch('POST', '/admin/platform/agent-specs/import', dryRun ? { dryRun: true } : {});
    const r = j.report || {};
    const skipped = r.skipped ? `, ${r.skipped} skipped as invalid` : '';
    toast(`${dryRun ? 'Would import' : 'Imported'}: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged${skipped}`, r.skipped ? 'err' : 'good');
    cfgSpecsBody();
  } catch (e) { toast(e.message, 'bad'); }
}

export async function cfgSpecOpen(i) {
  let packId = ''; let agentId = ''; let yaml = ''; let status = 'draft';
  if (i !== null && i !== undefined) {
    const row = cfgSpecRows[i];
    if (!row) return;
    packId = row.packId; agentId = row.agentId;
    try {
      const j = await plFetch('GET', `/admin/platform/agent-specs/${encodeURIComponent(packId)}/${encodeURIComponent(agentId)}`);
      yaml = j.spec.yaml; status = j.spec.status;
    } catch (e) { toast(e.message, 'bad'); return; }
  } else {
    yaml = ['id: my-agent', 'version: 1.0.0', 'packId: my-pack', 'displayName: My agent', 'description: ""', 'scope: patient', 'trigger:', '  kind: manual', 'plan:', '  type: step', '  step:', '    id: s1', '    skill: llm.call', 'governance:', '  phiHandling: none', '  purposeOfUse: [treatment]', '  clearanceRequired: internal', 'billing: {}', ''].join('\n');
  }
  const existing = document.getElementById('cfg-spec-modal');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="cfg-spec-modal" style="z-index:90;"><div class="modal" style="max-width:900px;">
    <div class="modal-header"><h3>${agentId ? `Edit ${esc(packId)} / ${esc(agentId)}` : 'New agent spec'} <span class="muted" style="font-weight:400;font-size:11px;">· ${esc(status)} · stored in Postgres</span></h3><button class="modal-close" id="cfg-spec-close" aria-label="Close">×</button></div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field"><label>Pack id</label><input id="cfg-spec-pack" value="${esc(packId)}" placeholder="renal-swarm" ${agentId ? 'disabled' : ''} /></div>
        <div class="field"><label>Agent id</label><input id="cfg-spec-agent" value="${esc(agentId)}" placeholder="triage-agent" ${agentId ? 'disabled' : ''} /></div>
      </div>
      <div class="field"><label>Spec YAML <span class="muted" style="font-weight:400;">· validated against AgentSpecSchema before it is stored, so a bad spec is refused here rather than at runtime</span></label>
        <textarea id="cfg-spec-yaml" spellcheck="false" style="width:100%;min-height:360px;font-family:var(--mono,monospace);font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:10px;resize:vertical;">${esc(yaml)}</textarea></div>
      <div id="cfg-spec-issues" class="muted" style="font-size:12px;"></div>
    </div>
    <div class="modal-footer"><button class="btn" id="cfg-spec-cancel">Cancel</button><button class="btn btn-primary" id="cfg-spec-save"><i data-lucide="save"></i> ${agentId ? 'Save' : 'Create draft'}</button></div>
  </div></div>`);
  hydrateIcons();
  document.getElementById('cfg-spec-close')?.addEventListener('click', closeCfgSpec);
  document.getElementById('cfg-spec-cancel')?.addEventListener('click', closeCfgSpec);
  document.getElementById('cfg-spec-save')?.addEventListener('click', () => cfgSpecSave(!!agentId));
  document.getElementById('cfg-spec-modal')?.addEventListener('click', (e) => { if (e.target && e.target.id === 'cfg-spec-modal') closeCfgSpec(); });
}

export async function cfgSpecPublish(i) {
  const row = cfgSpecRows[i]; if (!row) return;
  if (!confirm(`Publish ${row.packId}/${row.agentId}? The stored row is what ships — the release gate scores this content, not the file it was imported from.`)) return;
  try {
    await plFetch('POST', `/admin/platform/agent-specs/${encodeURIComponent(row.packId)}/${encodeURIComponent(row.agentId)}/publish`, { note: 'published from the operator console' });
    toast('Published', 'good');
    cfgSpecsBody();
  } catch (e) { toast(e.message, 'bad'); }
}

export let cfgSpecRows = [];

export async function cfgSpecSave(isEdit) {
  const packId = (document.getElementById('cfg-spec-pack').value || '').trim();
  const agentId = (document.getElementById('cfg-spec-agent').value || '').trim();
  const yaml = document.getElementById('cfg-spec-yaml').value || '';
  const out = document.getElementById('cfg-spec-issues');
  if (!packId || !agentId || !yaml.trim()) {
    out.innerHTML = '<span style="color:var(--bad);">pack id, agent id and YAML are all required.</span>';
    return;
  }
  let res; let j = {};
  try {
    res = await fetch('/admin/platform/agent-specs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packId, agentId, yaml }) });
    j = await res.json().catch(() => ({}));
  } catch (e) { out.innerHTML = `<span style="color:var(--bad);">${esc(e.message)}</span>`; return; }
  if (!res.ok) {
    const detail = Array.isArray(j.issues) && j.issues.length ? `<ul style="margin:6px 0 0 16px;">${j.issues.map((x) => `<li>${esc(String(x))}</li>`).join('')}</ul>` : '';
    out.innerHTML = `<span style="color:var(--bad);">${esc(j.detail || j.error || String(res.status))}</span>${detail}`;
    return;
  }
  closeCfgSpec();
  toast(isEdit ? 'Draft saved' : 'Draft created', 'good');
  cfgSpecsBody();
}

export let cfgSpecStatus = '';

export let cfgSpecSummary = null;

export let cfgSpecs = [];

export async function cfgSpecsBody() {
  const body = document.getElementById('cfg-body');
  if (!body) return;
  let err = null;
  try {
    const j = await plFetch('GET', '/admin/platform/agent-specs');
    cfgSpecs = j.specs || [];
    cfgSpecSummary = j.summary || null;
  } catch (e) { err = e.message; }
  if (err) { body.innerHTML = loadFailureHTML('the agent-spec registry', err); hydrateIcons(); return; }

  const s = cfgSpecSummary || { total: 0, byStatus: {}, drift: { onlyOnDisk: [], onlyInStore: [], differing: [], inSync: 0 }, imported: false };
  const d = s.drift || { onlyOnDisk: [], onlyInStore: [], differing: [], inSync: 0 };
  const statuses = Object.keys(s.byStatus || {}).sort();
  cfgSpecRows = cfgSpecStatus ? cfgSpecs.filter((r) => r.status === cfgSpecStatus) : cfgSpecs;
  const CAP = 60;
  const shown = cfgSpecRows.slice(0, CAP);

  const rowsHTML = shown.map((r, i) => `<tr>
      <td>${esc(r.agentId)}</td>
      <td class="muted" style="font-size:11px;">${esc(r.packId)}</td>
      <td><span class="pill ${CFG_SPEC_PILL[r.status] || ''}">${esc(r.status)}</span></td>
      <td class="muted" style="font-size:11px;">v${esc(r.version || '—')}</td>
      <td class="muted" style="font-size:11px;font-family:var(--mono,monospace);" title="${esc(r.contentSha256)}">${esc(String(r.contentSha256 || '').slice(0, 8))}</td>
      <td class="muted" style="font-size:11px;">${r.importedFrom ? `imported · ${esc(String(r.importedFrom).split('/').slice(-2).join('/'))}` : 'authored here'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" title="Edit the stored YAML" onclick="cfgSpecOpen(${i})"><i data-lucide="pencil" style="width:13px;height:13px"></i></button>
        ${r.status === 'published' ? '' : `<button class="btn btn-sm" title="Publish — the row is what ships" onclick="cfgSpecPublish(${i})"><i data-lucide="check" style="width:13px;height:13px"></i></button>`}
        <button class="btn btn-sm" title="Export this row to the repository tree" onclick="cfgSpecExport(${i})"><i data-lucide="download" style="width:13px;height:13px"></i></button>
        <button class="btn btn-sm" title="Delete the row" onclick="cfgSpecDelete(${i})"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button>
      </td></tr>`).join('') || `<tr><td colspan="7" class="muted">${cfgSpecStatus ? `No ${esc(cfgSpecStatus)} specs.` : 'Registry empty — use <b>Import tree</b> to seed it from packs/*/agents and packs/*/drafts.'}</td></tr>`;

  const driftList = (label, ids, colour) => ids.length ? `<div style="margin-top:4px;"><span style="color:var(${colour});font-weight:600;">${label} (${ids.length})</span> <span class="muted" style="font-family:var(--mono,monospace);">${esc(ids.slice(0, 8).join(', '))}${ids.length > 8 ? ` … +${ids.length - 8}` : ''}</span></div>` : '';
  const driftTotal = d.onlyOnDisk.length + d.onlyInStore.length + d.differing.length;

  body.innerHTML = `
    <div class="field-row" style="margin-bottom:10px;align-items:flex-end;">
      <div class="field"><label>Status</label><select id="cfg-spec-status" onchange="cfgSpecStatus=this.value;cfgSpecsBody()"><option value="">all (${s.total})</option>${statuses.map((st) => `<option value="${esc(st)}" ${cfgSpecStatus === st ? 'selected' : ''}>${esc(st)} (${s.byStatus[st]})</option>`).join('')}</select></div>
      <button class="btn btn-primary" onclick="cfgSpecOpen(null)"><i data-lucide="plus"></i> New spec</button>
      <button class="btn" onclick="cfgSpecImport(true)"><i data-lucide="search" style="width:13px;height:13px"></i> Preview import</button>
      <button class="btn" onclick="cfgSpecImport(false)"><i data-lucide="upload" style="width:13px;height:13px"></i> Import tree</button>
      <button class="btn" onclick="cfgSpecsBody()"><i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Refresh</button>
    </div>
    <div class="detail muted" style="font-size:11px;margin-bottom:8px;">
      Durable rows in Postgres (<code>swarm_workspace</code>, kind <code>agent-spec</code>). Import is idempotent per content hash, so it is safe to run repeatedly: a matching file is skipped, a changed file updates its row, and a row whose file disappeared is <b>kept</b> and reported as drift rather than deleted.
      ${s.imported ? '' : ' <span style="color:var(--warn);">The tree has not been imported yet — this list is not the whole registry.</span>'}
    </div>
    <div class="field-row" style="gap:14px;flex-wrap:wrap;margin-bottom:10px;">
      ${statuses.map((st) => `<span class="muted" style="font-size:11px;"><span class="pill ${CFG_SPEC_PILL[st] || ''}">${esc(st)}</span> ${s.byStatus[st]}</span>`).join('')}
      <span class="muted" style="font-size:11px;">in sync with the tree: <b>${d.inSync}</b></span>
      <span class="muted" style="font-size:11px;">drift: <b style="color:var(${driftTotal ? '--warn' : '--good'});">${driftTotal}</b></span>
    </div>
    <div style="overflow-x:auto;"><table class="panel"><thead><tr><th>agent</th><th>pack</th><th>status</th><th>version</th><th>content</th><th>origin</th><th>actions</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>
    ${cfgSpecRows.length > CAP ? `<div class="muted" style="font-size:11px;margin-top:6px;">Showing ${CAP} of ${cfgSpecRows.length}. Filter by status to narrow.</div>` : ''}
    ${driftTotal ? `<div class="section-card" style="margin-top:12px;"><div class="detail" style="font-size:11px;"><b>Drift</b> — the rows and the YAML tree disagree here. Rows are the source of truth; export to reconcile a row outward, or run <b>Import tree</b> to pull a disk change in.
      ${driftList('in the store, not on disk', d.onlyInStore, '--good')}
      ${driftList('on disk, never imported', d.onlyOnDisk, '--warn')}
      ${driftList('both exist, content differs', d.differing, '--bad')}
    </div></div>` : ''}`;
  hydrateIcons();
}

export function closeCfgSpec() { const m = document.getElementById('cfg-spec-modal'); if (m) m.remove(); }
