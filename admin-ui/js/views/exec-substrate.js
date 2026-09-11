import { esc, hydrateIcons, toast } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export const WS_CATALOG_KINDS = ['agent-manifest', 'measure-pack', 'public-source', 'domain-pack', 'operating-model', 'ecosystem', 'runtime-policy', 'public-benchmark', 'federal-fact', 'green-team-check', 'source-mapping', 'facility-station', 'assessment-response', 'outcome-episode-story', 'patient-timeline'];

export const WS_LEVELS = ['enterprise', 'division', 'region', 'market', 'facility'];

export async function cfgObjectsBody() {
  const body = document.getElementById('cfg-body');
  if (!body) return;
  const single = ['operating-model', 'ecosystem', 'runtime-policy', 'public-benchmark', 'domain-pack'];
  wsCatIsSingle = single.includes(wsCatKind);
  let rows = []; let err = null; let data = null; wsCatSingleId = null;
  try {
    if (wsCatIsSingle) {
      const j = await plFetch('GET', `/admin/platform/config-objects/${wsCatKind}`);
      data = j.data;
      wsCatSingleId = j.id ?? null;
      rows = wsCatKind === 'domain-pack' && data?.packs ? data.packs : wsCatKind === 'public-benchmark' && data?.benchmarks ? data.benchmarks : data ? [data] : [];
    } else {
      rows = (await plFetch('GET', `/admin/platform/config-objects/${wsCatKind}`)).rows || [];
    }
  } catch (e) { err = e.message; }
  wsCatRows = rows.map((r) => ({ r }));
  const keys = ['id', 'name', 'label', 'title', 'status', 'version', 'authority', 'state', 'sourceId', 'target', 'result'];
  const key = keys.find((k) => rows.some((r) => r && r[k] !== undefined)) || 'id';
  const table = `<div style="overflow-x:auto;"><table class="panel"><thead><tr><th>${key}</th><th>summary</th><th>actions</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr><td>${esc(String(r[key] ?? r.id ?? i))}</td><td class="muted" style="font-size:11px;">${esc(JSON.stringify(r).slice(0, 120))}</td><td style="white-space:nowrap;"><button class="btn btn-sm" title="Edit — persists to Postgres" onclick="wsCatalogEdit(${i})"><i data-lucide="pencil" style="width:13px;height:13px"></i></button><button class="btn btn-sm" title="Delete" onclick="wsCatalogDelete(${i})"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button></td></tr>`).join('')
    || `<tr><td colspan="3" class="muted">Empty — add below.</td></tr>`}</tbody></table></div>`;
  body.innerHTML = `
    ${err ? `<div class="state-card"><div class="state-title">${esc(err)}</div></div>` : ''}
    <div class="field-row" style="margin-bottom:12px;">
      <div class="field"><label>Catalog</label><select id="ws-cat-kind" onchange="wsCatKind=this.value;wsCatalogBody()">${WS_CATALOG_KINDS.map((k) => `<option value="${k}" ${k === wsCatKind ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field" style="flex:1;"><label>JSON payload</label><input id="ws-cat-json" placeholder='{"name":"New item"}'></div>
      <button class="btn btn-primary" onclick="wsCatalogCreate()"><i data-lucide="plus"></i> Add row</button>
      <button class="btn" onclick="cfgObjectsBody()"><i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Refresh</button></div>
    <div class="detail muted" style="font-size:11px;margin-bottom:8px;">Durable rows in Postgres (<code>swarm_workspace</code>) — the single source the executive console renders; the frontend bundles no JSON. ✎ and 🗑 persist immediately. Single-document kinds (operating-model / ecosystem / runtime-policy / public-benchmark / domain-pack) take the full document as the payload; use the <b>Ontology</b> tab for a structured operating-model editor.</div>
    ${table}`;
  hydrateIcons();
}

export function closeCatalogEdit() { const m = document.getElementById('ws-cat-modal'); if (m) m.remove(); }

export let wsCatEditIndex = -1;

export let wsCatIsSingle = false;

export let wsCatKind = 'agent-manifest';

export let wsCatRows = [];

export let wsCatSingleId = null;

export async function wsCatalogCreate() {
  let payload = {};
  try { payload = JSON.parse(document.getElementById('ws-cat-json').value || '{}'); } catch { toast('Payload must be valid JSON', 'bad'); return; }
  try { await plFetch('POST', `/admin/platform/config-objects/${wsCatKind}`, payload); toast('Row added', 'good'); cfgObjectsBody(); } catch (e) { toast(e.message, 'bad'); }
}

export async function wsCatalogDelete(i) {
  let id;
  if (wsCatIsSingle) id = wsCatSingleId;
  else { const row = wsCatRows[i]; id = row && row.r ? row.r.id : null; }
  if (!id) { toast('Cannot delete — no id on this row', 'bad'); return; }
  try { await plFetch('DELETE', `/admin/platform/config-objects/${wsCatKind}/${encodeURIComponent(id)}`); toast('Deleted', 'good'); cfgObjectsBody(); } catch (e) { toast(e.message, 'bad'); }
}

export function wsCatalogEdit(i) {
  const row = wsCatRows[i];
  const doc = row ? row.r : {};
  const json = JSON.stringify(doc, null, 2);
  const existing = document.getElementById('ws-cat-modal');
  if (existing) existing.remove();
  wsCatEditIndex = i;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="ws-cat-modal" style="z-index:90;"><div class="modal">
    <div class="modal-header"><h3>Edit ${esc(wsCatKind)} ${wsCatIsSingle ? '<span class="muted" style="font-weight:400;">· single-document</span>' : ''}</h3><button class="modal-close" id="ws-cat-modal-close" aria-label="Close">×</button></div>
    <div class="modal-body"><textarea id="ws-cat-edit" spellcheck="false" style="width:100%;min-height:360px;font-family:var(--mono,monospace);font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:10px;resize:vertical;">${esc(json)}</textarea></div>
    <div class="modal-footer"><button class="btn" id="ws-cat-modal-cancel">Cancel</button><button class="btn btn-primary" id="ws-cat-modal-save"><i data-lucide="save"></i> Save to Postgres</button></div>
  </div></div>`);
  hydrateIcons();
  document.getElementById('ws-cat-modal-close')?.addEventListener('click', closeCatalogEdit);
  document.getElementById('ws-cat-modal-cancel')?.addEventListener('click', closeCatalogEdit);
  document.getElementById('ws-cat-modal-save')?.addEventListener('click', async () => {
    let payload = {};
    try { payload = JSON.parse(document.getElementById('ws-cat-edit').value); } catch { toast('Invalid JSON', 'bad'); return; }
    await wsCatalogSaveEdit(payload);
  });
  document.getElementById('ws-cat-modal')?.addEventListener('click', (e) => { if (e.target && e.target.id === 'ws-cat-modal') closeCatalogEdit(); });
}

export async function wsCatalogSaveEdit(payload) {
  let id;
  if (wsCatIsSingle) id = wsCatSingleId;
  else { const row = wsCatRows[wsCatEditIndex]; id = row && row.r ? row.r.id : null; }
  if (!id) { toast('Cannot save — no id on this row', 'bad'); return; }
  try { await plFetch('PUT', `/admin/platform/config-objects/${wsCatKind}/${encodeURIComponent(id)}`, payload); closeCatalogEdit(); toast('Saved to Postgres', 'good'); cfgObjectsBody(); } catch (e) { toast(e.message, 'bad'); }
}
