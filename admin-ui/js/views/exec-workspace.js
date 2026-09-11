import { consoleDomain } from '../core/api.js';
import { main } from '../core/shell.js';
import { esc, hydrateIcons, toast } from '../core/theme.js';

export async function renderWsSubmissions() {
  const dom = await consoleDomain();
  let packages = []; let err = null;
  try { packages = (await wsFetch('/admin/platform/submissions')).packages || []; } catch (e) { err = e.message; }
  const rows = packages.map((p) => {
    const approvals = (p.approvals || []).length;
    const statusNote = p.status === 'approved' && approvals < 2 ? ` (${approvals}/2 Class-D)` : '';
    return `
    <div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--border);flex-wrap:wrap;">
      <span style="flex:1;min-width:180px;font-size:13px;"><b>${esc(p.measureId)}</b> <span class="muted" style="font-size:11px;">· ${esc(p.period.start)} → ${esc(p.period.end)}</span></span>
      ${wsStatusPill(p.status + statusNote)}
      <span class="muted" style="font-size:11px;">${p.resultsIncluded} results · ${esc(p.manifestHash.slice(0, 12))}…</span>
      ${p.evidenceWindow ? `<span class="muted" style="font-size:11px;">window ${esc(p.evidenceWindow.start)}→${esc(p.evidenceWindow.end)}</span>` : ''}
      ${p.receipt ? `<span class="pill ${p.receipt.status === 'accepted' ? 'good' : 'bad'}">${esc(p.receipt.status)} · ${esc(p.receipt.referenceId)}</span>` : ''}
      ${p.transmissionBlocked ? `<span class="muted" style="font-size:11px;max-width:220px;">⛔ ${esc(p.transmissionBlocked.reason.slice(0, 70))}</span>` : ''}
      <span style="white-space:nowrap;">
        ${(p.status === 'draft' || p.status === 'validated') ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','freeze')">Freeze</button>` : ''}
        ${(p.status === 'draft' || p.status === 'rejected') ? `<button class="btn btn-sm" onclick="wsSubmissionValidate('${p.id}')">Validate</button>` : ''}
        ${(p.status === 'validated' || (p.status === 'approved' && approvals < 2)) ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','approve')">Approve</button>` : ''}
        ${p.status === 'approved' && approvals >= 2 ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','submit')">Submit</button>` : ''}
        ${p.status === 'submitted' ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','receipt')">Receipt</button>` : ''}
        ${p.status === 'rejected' ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','correct')">Correct</button>` : ''}
        ${p.status === 'reconciled' ? `<button class="btn btn-sm" onclick="wsSubAction('${p.id}','reconcile')">Reconcile</button>` : ''}
        <button class="btn btn-sm" onclick="wsSubmissionDelete('${p.id}')"><i data-lucide="trash-2" style="width:13px;height:13px"></i></button>
      </span>
    </div>`;
  }).join('') || '<div class="muted">No submission packages.</div>';
  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">CMS submissions</h2><p class="page-sub">Journey K — draft → validate → freeze → dual Class-D approval → submit (reference-mode stops before live transmission and says why) → receipt → reconciled | rejected → correct → resubmit. Evidence snapshot + receipt retained.</p></div></div>
    ${err ? `<div class="state-card"><div class="state-title">${esc(err)}</div></div>` : ''}
    <div class="section-card"><h3>Create a submission package</h3>
      <div class="field-row"><div class="field" style="flex:2;"><label>Measure id</label><input id="sub-measure" value="${esc(dom.domainOptions.defaultMeasureId)}"></div>
      <div class="field" style="flex:1;"><label>Realm id</label><input id="sub-realm" placeholder="realm:c2"></div>
      <div class="field"><label>Period start</label><input id="sub-start" type="date"></div>
      <div class="field"><label>Period end</label><input id="sub-end" type="date"></div>
      <button class="btn btn-primary" onclick="wsSubmissionCreate()"><i data-lucide="plus"></i> Create package</button></div></div>
    <div class="section-card"><h3>Packages</h3>${rows}</div>`;
  hydrateIcons();
}

export async function wsFetch(path, init) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `request failed: ${path}`);
  return j;
}

export function wsStatusPill(status) {
  const tone = { active: 'good', validated: 'brand', approved: 'brand', draft: 'muted', 'contract-verified': 'good', confirmed: 'good', rejected: 'bad', pending: 'warn', passed: 'good', feasible: 'good', 'not-feasible': 'bad', submitted: 'brand', archived: 'muted' };
  return `<span class="pill ${tone[status] || 'muted'}">${esc(status)}</span>`;
}

export async function wsSubmissionCreate() {
  try {
    const start = document.getElementById('sub-start').value || `${new Date().getFullYear()}-01-01`;
    const end = document.getElementById('sub-end').value || `${new Date().getFullYear()}-12-31`;
    const j = await wsFetch('/admin/platform/submissions', { method: 'POST', body: JSON.stringify({ measureId: document.getElementById('sub-measure').value, realmId: document.getElementById('sub-realm').value, period: { start, end }, resultsIncluded: 214 }) });
    toast(`Package created (${j.package.status})`, 'good'); renderWsSubmissions();
  } catch (e) { toast(e.message, 'bad'); }
}

export async function wsSubmissionDelete(id) {
  try { await wsFetch(`/admin/platform/submissions/${id}`, { method: 'DELETE' }); toast('Package deleted', 'good'); renderWsSubmissions(); } catch (e) { toast(e.message, 'bad'); }
}

export async function wsSubmissionValidate(id) {
  try { await wsFetch(`/admin/platform/submissions/${id}/validate`, { method: 'POST', body: '{}' }); toast('Validated', 'good'); renderWsSubmissions(); } catch (e) { toast(e.message, 'bad'); }
}
