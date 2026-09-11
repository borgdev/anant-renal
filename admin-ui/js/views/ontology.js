import { S } from '../state.js';
import { esc, hydrateIcons, toast } from '../core/theme.js';
import { WS_LEVELS } from './exec-substrate.js';
import { plFetch } from './platform-admin.js';
import { renderPlatformConfig } from './platform-config.js';

export const WS_ONTOLOGY_FIELDS = {
  scopePath: { title: 'Hierarchy levels (enterprise → facility)', prefix: 'node', fields: ['label', 'level', 'facilities', 'patients', 'id'] },
  roles: { title: 'Role cockpits', prefix: 'role', fields: ['id', 'shortLabel', 'label', 'scopeLevel', 'purpose', 'decisionRights'] },
  domains: { title: 'Outcome domains', prefix: 'domain', fields: ['id', 'label', 'ownerRoles', 'agentIds'] },
};

export async function cfgOntologyBody() {
  const body = document.getElementById('cfg-body');
  if (!body) return;
  let err = null;
  try {
    const j = await plFetch('GET', '/admin/ontology');
    S.wsOntology = j.ontology || { version: '2026.1.0', synthetic: true, organization: '', model: '', scopePath: [], roles: [], domains: [] };
    S.wsOntologyRealized = j.realized || { totalFacilities: 0, totalPatients: 0, perFacility: [] };
  } catch (e) { err = e.message; }
  const cards = Object.entries(WS_ONTOLOGY_FIELDS).map(([key, cfg]) => wsOntologyCard(key, cfg)).join('');
  body.innerHTML = `
    ${err ? `<div class="state-card"><div class="state-title">${esc(err)}</div></div>` : ''}
    <div class="state-card" style="margin-bottom:10px;"><b>Real master data (live from Postgres)</b>
      <span style="margin-left:10px;">🏥 <b>${S.wsOntologyRealized.totalFacilities}</b> facilities</span>
      <span style="margin-left:10px;">🧑‍🤝‍🧑 <b>${S.wsOntologyRealized.totalPatients}</b> patients</span>
      <span class="muted" style="font-size:11px;margin-left:10px;">${(S.wsOntologyRealized.perFacility || []).map((f) => `${esc(f.name)} (${f.patients})`).join(', ') || 'no master facilities yet'}</span>
      <button class="btn btn-sm" style="float:right;" onclick="wsOntologyPullLive()"><i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Pull live counts</button></div>
    <div class="section-card"><h3>Organization identity</h3>
      <div class="field-row">
        <div class="field"><label>Organization</label><input value="${esc(S.wsOntology.organization || '')}" oninput="wsOntology.organization=this.value"></div>
        <div class="field"><label>Model</label><input value="${esc(S.wsOntology.model || '')}" oninput="wsOntology.model=this.value"></div>
        <div class="field"><label>Version</label><input value="${esc(S.wsOntology.version || '')}" oninput="wsOntology.version=this.value"></div>
        <div class="field"><label><input type="checkbox" ${S.wsOntology.synthetic ? 'checked' : ''} onchange="wsOntology.synthetic=this.checked"> synthetic</label></div>
      </div></div>
    ${cards}
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="btn btn-primary" onclick="wsOntologySave()"><i data-lucide="save"></i> Save ontology to Postgres</button>
      <button class="btn" onclick="renderPlatformConfig()"><i data-lucide="x"></i> Discard</button></div>`;
  hydrateIcons();
}

export function wsOntologyAdd(key) {
  if (!S.wsOntology[key]) S.wsOntology[key] = [];
  const n = S.wsOntology[key].length + 1;
  const base = key === 'scopePath' ? { id: `node-${n}`, level: 'facility', label: '', facilities: 0, patients: 0 }
    : key === 'roles' ? { id: '', shortLabel: '', label: '', scopeLevel: 'facility', purpose: '', decisionRights: [] }
    : { id: '', label: '', ownerRoles: [], agentIds: [] };
  S.wsOntology[key].push(base);
  cfgOntologyBody();
}

export function wsOntologyCard(key, cfg) {
  const rows = S.wsOntology[key] || [];
  const header = cfg.fields.map((f) => `<th>${esc(f)}</th>`).join('') + '<th></th>';
  const tbody = rows.map((row, i) => `<tr>${cfg.fields.map((f) => {
    const val = row[f];
    const v = Array.isArray(val) ? val.join(', ') : (val ?? '');
    if (f === 'level' || f === 'scopeLevel') {
      return `<td><select onchange="wsOntologySet('${key}',${i},'${f}',this.value)">${WS_LEVELS.map((l) => `<option value="${l}" ${String(row[f]) === l ? 'selected' : ''}>${l}</option>`).join('')}</select></td>`;
    }
    return `<td><input style="min-width:90px;" value="${esc(v)}" oninput="wsOntologySet('${key}',${i},'${f}',this.value)"></td>`;
  }).join('')}<td><button class="btn btn-sm" onclick="wsOntologyRemove('${key}',${i})"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button></td></tr>`).join('');
  const empty = rows.length === 0 ? `<tr><td colspan="${cfg.fields.length + 1}" class="muted">No rows yet — add one below.</td></tr>` : '';
  return `<div class="section-card"><h3>${esc(cfg.title)} <span class="muted" style="font-weight:400;font-size:11px;">· ${rows.length}</span></h3>
    <div style="overflow-x:auto;"><table class="panel"><thead><tr>${header}</tr></thead><tbody>${tbody}${empty}</tbody></table></div>
    <button class="btn btn-sm" onclick="wsOntologyAdd('${key}')"><i data-lucide="plus"></i> Add ${esc(cfg.prefix.replace('-', ' '))}</button></div>`;
}

export function wsOntologyPullLive() {
  const r = S.wsOntologyRealized || {};
  (S.wsOntology.scopePath || []).forEach((node) => {
    if (node.level === 'enterprise') { node.facilities = r.totalFacilities ?? node.facilities; node.patients = r.totalPatients ?? node.patients; }
    else if (node.level === 'facility') {
      const match = (r.perFacility || []).find((f) => String(f.name).toLowerCase() === String(node.label).toLowerCase());
      if (match) node.patients = match.patients;
    }
  });
  cfgOntologyBody();
}

export function wsOntologyRemove(key, idx) {
  S.wsOntology[key].splice(idx, 1);
  cfgOntologyBody();
}

export async function wsOntologySave() {
  const payload = { version: S.wsOntology.version, synthetic: S.wsOntology.synthetic, organization: S.wsOntology.organization, model: S.wsOntology.model, scopePath: S.wsOntology.scopePath || [], roles: S.wsOntology.roles || [], domains: S.wsOntology.domains || [] };
  try { await plFetch('PUT', '/admin/ontology', payload); toast('Ontology saved to Postgres', 'good'); renderPlatformConfig(); } catch (e) { toast(e.message, 'bad'); }
}

export function wsOntologySet(key, idx, field, value) {
  if (!S.wsOntology[key]) S.wsOntology[key] = [];
  if (['decisionRights', 'ownerRoles', 'agentIds'].includes(field)) S.wsOntology[key][idx][field] = value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (['facilities', 'patients'].includes(field)) S.wsOntology[key][idx][field] = Number(value) || 0;
  else S.wsOntology[key][idx][field] = value;
}
