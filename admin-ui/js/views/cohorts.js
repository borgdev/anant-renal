import { main } from '../core/shell.js';
import { esc, hydrateIcons, toast } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export const COHORT_DIAGNOSIS_LABEL = {
  members: 'admissible',
  'data-gap': 'data gap',
  'criteria-too-strict': 'threshold out of range',
  'no-joint-overlap': 'criteria cannot be met together',
  'insufficient-coverage': 'nothing evaluated',
};

export function cohortAddCriterion(bucket) {
  cohortSyncCriteria();
  cohortDraft[bucket].push(emptyCriterion());
  cohortRenderCriteria();
}

export function cohortCancelEdit() {
  cohortDraft = null;
  const host = document.getElementById('cohort-editor');
  if (host) host.innerHTML = '';
}

export function cohortComparatorOptions(selected) {
  const list = (cohortMetrics && cohortMetrics.comparators) || ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'present', 'absent', 'outside'];
  return list.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

export function cohortCriterionBlock(bucket, title, hint) {
  const rows = cohortDraft[bucket];
  return `<div style="flex:1 1 420px;min-width:320px;">
    <div style="display:flex;align-items:center;gap:8px;"><label style="font-weight:600;font-size:12px;">${esc(title)}</label><span class="muted" style="font-size:11px;">${esc(hint)}</span></div>
    <div id="cohort-${esc(bucket)}-rows">${rows.map((_, i) => cohortCriterionRow(bucket, i)).join('') || '<div class="muted" style="font-size:11px;padding:6px 0;">no criteria — every cohort needs at least one</div>'}</div>
    <button class="btn btn-ghost" style="margin-top:6px;" onclick="cohortAddCriterion('${esc(bucket)}')">+ Add criterion</button>
  </div>`;
}

export function cohortCriterionInput(el) {
  const row = el.closest('.cohort-criterion');
  if (!row || !cohortDraft) return;
  const bucket = row.dataset.bucket;
  const index = Number(row.dataset.index);
  const field = el.dataset.field;
  if (!bucket || !cohortDraft[bucket] || !cohortDraft[bucket][index]) return;
  cohortDraft[bucket][index][field] = el.value;
  // Changing the metric or the comparator changes which value widget applies,
  // so those two re-render the rows. Typing must not, or focus is lost.
  if (field === 'metric' || field === 'comparator') cohortRenderCriteria();
}

export function cohortCriterionRow(bucket, index) {
  const c = cohortDraft[bucket][index];
  const spec = cohortMetrics ? cohortMetrics.metrics.find((m) => m.id === c.metric) : undefined;
  const bindsValue = !['present', 'absent'].includes(c.comparator);
  const isOutside = c.comparator === 'outside';
  const valueControl = !bindsValue ? '<span class="muted" style="font-size:11px;">no value</span>'
    : isOutside
      ? `<input data-field="min" type="number" step="any" placeholder="min" value="${esc(c.min)}" style="width:76px;" oninput="cohortCriterionInput(this)" />
         <input data-field="max" type="number" step="any" placeholder="max" value="${esc(c.max)}" style="width:76px;" oninput="cohortCriterionInput(this)" />`
      : `<input data-field="value" type="${spec && spec.valueType !== 'number' ? 'text' : 'number'}" step="any" placeholder="value" value="${esc(c.value)}" style="width:96px;" oninput="cohortCriterionInput(this)" />`;
  return `<div class="cohort-criterion" data-bucket="${esc(bucket)}" data-index="${index}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:5px 0;border-bottom:1px solid var(--line);">
    <select data-field="metric" style="flex:1 1 320px;min-width:240px;" onchange="cohortCriterionInput(this)">${cohortMetricOptions(c.metric)}</select>
    <select data-field="comparator" style="width:104px;" onchange="cohortCriterionInput(this)">${cohortComparatorOptions(c.comparator)}</select>
    ${valueControl}
    <input data-field="note" type="text" placeholder="note shown to the reviewer (optional)" value="${esc(c.note)}" style="flex:1 1 200px;min-width:150px;" oninput="cohortCriterionInput(this)" />
    <button class="btn btn-ghost" onclick="cohortRemoveCriterion('${esc(bucket)}', ${index})">×</button>
  </div>`;
}

export function cohortDeclineRow(a) {
  if (a.declines === 0 && a.acceptances === 0) {
    return `<div style="padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;"><code>${esc(a.cohortId)}</code> <span class="muted">— no decisions recorded. ${esc(a.recommendation)}</span></div>`;
  }
  const reasons = (a.reasons || []).map((r) => `<li>${esc(r.reason)} <span class="muted">×${r.count}</span></li>`).join('');
  return `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <strong>${esc(a.label)}</strong>
      <code style="font-size:11px;">${esc(a.cohortId)}</code>
      <span class="pill ${a.declines ? 'amber' : 'muted'}">${a.declines} declined</span>
      <span class="pill muted">${a.acceptances} accepted</span>
      <span class="pill muted">rate ${a.declineRate === null ? '—' : a.declineRate + '%'}</span>
      ${a.retireCandidate ? '<span class="pill red">retire candidate</span>' : ''}
      ${a.byVersion && a.byVersion.some((v) => v.stale) ? '<span class="pill muted">older versions excluded</span>' : ''}
    </div>
    ${reasons ? `<ul style="margin:6px 0 0 16px;padding:0;">${reasons}</ul>` : ''}
    <div class="muted" style="font-size:11px;margin-top:6px;">${esc(a.recommendation)}</div>
  </div>`;
}

export async function cohortDelete(id) {
  if (!window.confirm(`Delete cohort '${id}'? Its membership history stays durable, but nothing will evaluate it again.`)) return;
  try {
    await plFetch('DELETE', '/admin/cohorts/' + encodeURIComponent(id));
    toast(`Cohort removed · ${id}`);
  } catch (e) { toast(e.message, 'err'); }
  renderPlatformCohorts();
}

export let cohortDraft = null;

export async function cohortEdit(id) {
  await cohortMetricCatalog();
  const doc = await plFetch('GET', '/admin/cohorts/' + encodeURIComponent(id));
  const c = doc.cohort;
  cohortDraft = {
    isNew: false, id: c.definitionId, label: c.label, kind: c.kind, protocol: c.protocol,
    rationale: c.rationale, entryMode: c.entryMode === 'any' ? 'any' : 'all',
    entry: (c.entry || []).map(criterionToDraft), exit: (c.exit || []).map(criterionToDraft),
    suggestedAction: c.suggestedAction, approvalClass: c.approvalClass,
    mayNever: (c.mayNever || []).join('\n'), guard: (c.guard || []).join('\n'),
    minN: c.minN, criterionVersion: c.criterionVersion, owner: c.owner, enabled: c.enabled,
  };
  renderCohortEditor();
  document.getElementById('cohort-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export async function cohortEvaluateNow() {
  try {
    const r = await plFetch('POST', '/admin/cohorts/evaluate', { persist: true });
    toast(`Evaluated ${r.cohorts.length} cohorts · ${r.memberships} memberships · ${r.persisted} row(s) changed, ${r.unchanged} unchanged`);
  } catch (e) { toast(e.message, 'err'); }
  renderPlatformCohorts();
}

export async function cohortMetricCatalog() {
  if (!cohortMetrics) cohortMetrics = await plFetch('GET', '/admin/cohorts/metrics');
  return cohortMetrics;
}

export function cohortMetricOptions(selected) {
  if (!cohortMetrics) return '<option value="">— vocabulary unavailable —</option>';
  const opts = cohortMetrics.metrics.map((m) => {
    const label = `${m.id} · ${m.label}${m.unit ? ` (${m.unit})` : ''}`;
    return `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  return `<option value=""${selected ? '' : ' selected'}>— select a metric —</option>${opts}`;
}

export let cohortMetrics = null;

export async function cohortNew() {
  await cohortMetricCatalog();
  cohortDraft = {
    isNew: true, id: '', label: '', kind: 'suggested', protocol: 'cross', rationale: '',
    entryMode: 'all', entry: [emptyCriterion()], exit: [emptyCriterion()],
    suggestedAction: '', approvalClass: 'C', mayNever: '', guard: '',
    minN: 3, criterionVersion: '1.0.0', owner: 'clinical', enabled: true,
  };
  renderCohortEditor();
}

export function cohortReadForm() {
  cohortSyncCriteria();
  const d = cohortDraft;
  const text = (id, fallback = '') => {
    const el = document.getElementById(id);
    return el ? String(el.value).trim() : fallback;
  };
  const lines = (id) => text(id).split('\n').map((s) => s.trim()).filter(Boolean);
  const toNumber = (v) => {
    const s = String(v ?? '').trim();
    if (s === '') return undefined;
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  };
  const criteria = (bucket) => d[bucket].map((c) => {
    const spec = cohortMetrics ? cohortMetrics.metrics.find((m) => m.id === c.metric) : undefined;
    const numeric = !spec || spec.valueType === 'number';
    const out = { metric: c.metric, comparator: c.comparator };
    if (!['present', 'absent', 'outside'].includes(c.comparator)) {
      if (numeric) {
        const n = toNumber(c.value);
        if (n !== undefined) out.value = n;
      } else if (String(c.value).trim() !== '') out.value = String(c.value).trim();
    }
    if (c.comparator === 'outside') {
      const min = toNumber(c.min);
      const max = toNumber(c.max);
      if (min !== undefined) out.min = min;
      if (max !== undefined) out.max = max;
    }
    if (String(c.note ?? '').trim()) out.note = String(c.note).trim();
    return out;
  });
  return {
    id: d.id || text('cohort-id'),
    label: text('cohort-label'),
    kind: text('cohort-kind', 'suggested'),
    protocol: text('cohort-protocol', 'cross') || 'cross',
    rationale: text('cohort-rationale'),
    entryMode: text('cohort-entry-mode', 'all'),
    entry: criteria('entry'),
    exit: criteria('exit'),
    suggestedAction: text('cohort-action'),
    approvalClass: text('cohort-class', 'C'),
    mayNever: lines('cohort-maynever'),
    guard: lines('cohort-guard'),
    minN: toNumber(text('cohort-minn')) ?? 3,
    criterionVersion: text('cohort-version', '1.0.0') || '1.0.0',
    owner: text('cohort-owner', 'clinical') || 'clinical',
    enabled: text('cohort-enabled', 'true') === 'true',
  };
}

export function cohortRemoveCriterion(bucket, index) {
  cohortSyncCriteria();
  cohortDraft[bucket].splice(index, 1);
  cohortRenderCriteria();
}

export function cohortRenderCriteria() {
  if (!cohortDraft) return;
  cohortSyncCriteria();
  for (const bucket of ['entry', 'exit']) {
    const host = document.getElementById(`cohort-${bucket}-rows`);
    if (host) host.innerHTML = cohortDraft[bucket].map((_, i) => cohortCriterionRow(bucket, i)).join('');
  }
}

export function cohortRow(doc, state, decline) {
  const cov = state && state.coverage;
  const diagnosis = cov ? cov.diagnosis : 'insufficient-coverage';
  const tone = diagnosis === 'members' ? 'mint' : diagnosis === 'data-gap' ? 'amber' : 'red';
  const members = state ? state.members : '—';
  const prevalence = state ? (state.prevalence === 'insufficient' ? `below minN ${state.minN}` : `${state.prevalence}%`) : '—';
  const criterionCount = (doc.entry || []).length + (doc.exit || []).length;
  return `<div style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb, var(--elevate) 2%, transparent);">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div style="min-width:0;flex:1;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong style="font-size:13px;">${esc(doc.label)}</strong>
          <code style="font-size:11px;">${esc(doc.definitionId)}</code>
          <span class="pill muted">${esc(doc.kind)}</span>
          <span class="pill muted">${esc(doc.protocol)}</span>
          <span class="pill muted">v${esc(doc.criterionVersion)}</span>
          <span class="pill ${tone}">${esc(COHORT_DIAGNOSIS_LABEL[diagnosis] || diagnosis)}</span>
          ${doc.enabled ? '' : '<span class="pill muted">disabled</span>'}
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px;">${esc(doc.rationale || '')}</div>
        <div class="muted" style="font-size:11px;margin-top:4px;">entry ${(doc.entry || []).length} · exit ${(doc.exit || []).length}${doc.entryMode === 'any' ? ' (any)' : ''} · ${esc(doc.owner)} · class ${esc(doc.approvalClass)} · minN ${esc(doc.minN)} · ${criterionCount} criteria</div>
        ${cov ? `<div style="font-size:11px;margin-top:6px;color:${diagnosis === 'members' ? 'var(--good)' : 'var(--warn)'};">${esc(cov.verdict)}</div>` : ''}
        ${decline && decline.declines > 0 ? `<div class="muted" style="font-size:11px;margin-top:4px;">declines on v${esc(decline.criterionVersion)}: ${decline.declines} · accepted: ${decline.acceptances}${decline.clustered ? ' · clustered' : ''}${decline.retireCandidate ? ' · <b style="color:var(--bad);">retire candidate</b>' : ''}</div>` : ''}
      </div>
      <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <div style="text-align:right;"><div style="font-weight:700;font-size:16px;">${members}</div><div class="muted" style="font-size:10px;">members · ${esc(prevalence)}</div></div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-ghost" onclick="cohortEdit('${esc(doc.id)}')">Edit</button>
          <button class="btn btn-ghost" onclick="cohortToggle('${esc(doc.id)}', ${doc.enabled ? 'false' : 'true'})">${doc.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-ghost" onclick="cohortDelete('${esc(doc.id)}')">Delete</button>
        </div>
      </div>
    </div>
  </div>`;
}

export async function cohortSave() {
  if (!cohortDraft) return;
  const body = cohortReadForm();
  // Fail here with a sentence rather than letting the server answer with a
  // token — the operator is authoring a clinical proposition, not a payload.
  if (!body.id) return cohortShowError('an id is required (kebab-case, e.g. fluid-overload-risk)');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(body.id)) return cohortShowError(`invalid id '${body.id}' — use lowercase letters, digits and hyphens`);
  if (!body.label) return cohortShowError('a label is required');
  for (const bucket of ['entry', 'exit']) {
    if (body[bucket].length === 0) return cohortShowError(`${bucket} needs at least one criterion`);
    const blank = body[bucket].findIndex((c) => !c.metric);
    if (blank >= 0) return cohortShowError(`${bucket} criterion ${blank + 1} has no metric selected`);
    // A criterion that cannot compare is a criterion that never resolves, and
    // "never resolves" reads as a coverage gap forever. Catch it here.
    for (let i = 0; i < body[bucket].length; i += 1) {
      const c = body[bucket][i];
      const spec = cohortMetrics ? cohortMetrics.metrics.find((m) => m.id === c.metric) : undefined;
      const numeric = !spec || spec.valueType === 'number';
      const where = `${bucket} criterion ${i + 1} (${c.metric})`;
      if (c.comparator === 'outside') {
        if (c.min === undefined && c.max === undefined) return cohortShowError(`${where} needs a min or a max for 'outside'`);
      } else if (!['present', 'absent'].includes(c.comparator)) {
        if (numeric && typeof c.value !== 'number') return cohortShowError(`${where} needs a numeric value for '${c.comparator}'`);
        if (!numeric && c.value === undefined) return cohortShowError(`${where} needs a value for '${c.comparator}'`);
      }
    }
  }
  if (body.mayNever.length === 0) return cohortShowError('mayNever is required — state the boundary this cohort cannot cross');
  if (body.guard.length === 0) return cohortShowError('guard is required — name the guards that apply before acting');
  try {
    if (cohortDraft.isNew) {
      await plFetch('POST', '/admin/cohorts', body);
      toast(`Cohort created · ${body.id}`);
    } else {
      await plFetch('PUT', '/admin/cohorts/' + encodeURIComponent(body.id), body);
      toast(`Cohort saved · ${body.id} v${body.criterionVersion}`);
    }
  } catch (e) { return cohortShowError(e.message); }
  cohortDraft = null;
  renderPlatformCohorts();
}

export function cohortShowError(msg) {
  const host = document.getElementById('cohort-error');
  if (!host) { toast(msg, 'err'); return; }
  host.style.display = 'block';
  host.innerHTML = `<div style="padding:8px 10px;border:1px solid var(--bad);border-radius:6px;color:var(--bad);font-size:12px;">${esc(msg)}</div>`;
}

export function cohortSyncCriteria() {
  if (!cohortDraft) return;
  for (const bucket of ['entry', 'exit']) {
    const host = document.getElementById(`cohort-${bucket}-rows`);
    if (!host) continue;
    const rows = [...host.querySelectorAll('.cohort-criterion')].map((row) => {
      const read = (f) => {
        const el = row.querySelector(`[data-field="${f}"]`);
        return el ? el.value : '';
      };
      return { metric: read('metric'), comparator: read('comparator'), value: read('value'), min: read('min'), max: read('max'), note: read('note') };
    });
    if (rows.length > 0) cohortDraft[bucket] = rows;
  }
}

export async function cohortToggle(id, enabled) {
  try {
    const doc = await plFetch('GET', '/admin/cohorts/' + encodeURIComponent(id));
    const c = doc.cohort;
    await plFetch('PUT', '/admin/cohorts/' + encodeURIComponent(id), {
      id, label: c.label, kind: c.kind, protocol: c.protocol, rationale: c.rationale,
      entry: c.entry, exit: c.exit, ...(c.entryMode ? { entryMode: c.entryMode } : {}),
      suggestedAction: c.suggestedAction, approvalClass: c.approvalClass,
      mayNever: c.mayNever, guard: c.guard, minN: c.minN,
      criterionVersion: c.criterionVersion, owner: c.owner, enabled,
    });
    toast(`${id} ${enabled ? 'enabled' : 'disabled'}`);
  } catch (e) { toast(e.message, 'err'); }
  renderPlatformCohorts();
}

export function criterionToDraft(c) {
  return {
    metric: c.metric, comparator: c.comparator,
    value: c.value === undefined ? '' : String(c.value),
    min: c.min === undefined ? '' : String(c.min),
    max: c.max === undefined ? '' : String(c.max),
    note: c.note || '',
  };
}

export function emptyCriterion() { return { metric: '', comparator: 'gte', value: '', min: '', max: '', note: '' }; }

export function renderCohortEditor() {
  const host = document.getElementById('cohort-editor');
  if (!host || !cohortDraft) return;
  const d = cohortDraft;
  host.innerHTML = `
    <div class="detail" style="margin-top:12px;border-color:var(--brand);">
      <h3 style="margin-top:0;">${d.isNew ? 'New cohort' : `Editing ${esc(d.id)}`}</h3>
      <div id="cohort-error" style="display:none;margin-bottom:8px;"></div>
      <div class="field-row">
        <div class="field"><label>Id (kebab-case, immutable)</label><input id="cohort-id" type="text" value="${esc(d.id)}" ${d.isNew ? '' : 'disabled'} placeholder="e.g. fluid-overload-risk" /></div>
        <div class="field"><label>Label</label><input id="cohort-label" type="text" value="${esc(d.label)}" /></div>
        <div class="field"><label>Kind</label><select id="cohort-kind"><option value="suggested"${d.kind === 'suggested' ? ' selected' : ''}>suggested — proposes an action</option><option value="monitoring"${d.kind === 'monitoring' ? ' selected' : ''}>monitoring — observes only</option></select></div>
        <div class="field"><label>Protocol composed</label><input id="cohort-protocol" type="text" value="${esc(d.protocol)}" placeholder="a protocol id, or 'cross' for several" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Entry mode</label><select id="cohort-entry-mode"><option value="all"${d.entryMode === 'all' ? ' selected' : ''}>all — every criterion must hold</option><option value="any"${d.entryMode === 'any' ? ' selected' : ''}>any — one criterion admits</option></select></div>
        <div class="field"><label>criterionVersion (bump when a criterion changes)</label><input id="cohort-version" type="text" value="${esc(d.criterionVersion)}" /></div>
        <div class="field"><label>Owner</label><input id="cohort-owner" type="text" value="${esc(d.owner)}" /></div>
        <div class="field"><label>minN (below this the cohort reports insufficient, not a prevalence)</label><input id="cohort-minn" type="number" min="1" value="${esc(d.minN)}" /></div>
        <div class="field"><label>Enabled</label><select id="cohort-enabled"><option value="true"${d.enabled ? ' selected' : ''}>enabled</option><option value="false"${d.enabled ? '' : ' selected'}>disabled</option></select></div>
      </div>
      <div class="field"><label>Rationale — what this cohort is for, in the clinician's words</label><input id="cohort-rationale" type="text" value="${esc(d.rationale)}" /></div>
      <div class="field-row" style="align-items:flex-start;">
        ${cohortCriterionBlock('entry', 'Entry criteria', 'state AND trajectory — an unresolved criterion is never read as healthy')}
      </div>
      <div class="field-row" style="align-items:flex-start;">
        ${cohortCriterionBlock('exit', 'Exit criteria', 'mandatory — a cohort that can only grow is an inbox')}
      </div>
      <div class="field-row">
        <div class="field"><label>Suggested action (never executed automatically)</label><input id="cohort-action" type="text" value="${esc(d.suggestedAction)}" /></div>
        <div class="field"><label>Approval class</label><select id="cohort-class">${['A', 'B', 'C', 'D'].map((k) => `<option value="${k}"${d.approvalClass === k ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      </div>
      <div class="field-row" style="align-items:flex-start;">
        <div class="field" style="flex:1 1 320px;"><label>mayNever — the boundary this cohort cannot cross, one per line</label><textarea id="cohort-maynever" rows="3" style="width:100%;">${esc(d.mayNever)}</textarea></div>
        <div class="field" style="flex:1 1 320px;"><label>guard — the guards that apply before acting, one per line</label><textarea id="cohort-guard" rows="3" style="width:100%;">${esc(d.guard)}</textarea></div>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="btn btn-primary" onclick="cohortSave()">${d.isNew ? 'Create cohort' : 'Save changes'}</button>
        <button class="btn btn-ghost" onclick="cohortCancelEdit()">Cancel</button>
      </div>
    </div>`;
  hydrateIcons();
}

export async function renderPlatformCohorts() {
  let catalog = { count: 0, cohorts: [] };
  let state = { cohorts: [] };
  let declines = { cohorts: [] };
  let metrics = null;
  try { catalog = await plFetch('GET', '/admin/cohorts'); } catch (e) { toast(e.message, 'err'); }
  try { metrics = await cohortMetricCatalog(); } catch (e) { /* vocabulary unavailable */ }
  try { state = await plFetch('GET', '/admin/cohorts/state'); } catch (e) { /* evaluation unavailable */ }
  try { declines = await plFetch('GET', '/admin/cohorts/declines'); } catch (e) { /* no decisions yet */ }

  const stateById = new Map((state.cohorts || []).map((c) => [c.cohortId, c]));
  const declineById = new Map((declines.cohorts || []).map((d) => [d.cohortId, d]));
  const totalMembers = (state.cohorts || []).reduce((a, c) => a + c.members, 0);
  const totalUnresolved = (state.cohorts || []).reduce((a, c) => a + c.unresolved, 0);
  const dead = (state.cohorts || []).filter((c) => c.members === 0 && c.coverage && c.coverage.diagnosis !== 'members');

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Living cohorts</h2>
      <p class="page-sub">Membership as a durable, explainable, versioned edge. A cohort is a declared clinical proposition — entry over state <em>and</em> trajectory, a mandatory exit, the action it suggests, and the boundary it may never cross. Definitions are data: edit one here and the next evaluation uses it, with no deploy. <b>Nothing here acts</b> — a qualifying patient becomes a suggestion a human decides on.</p></div>
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <button class="btn" onclick="cohortNew()">New cohort</button>
        <button class="btn btn-primary" onclick="cohortEvaluateNow()">Evaluate now</button>
      </div></div>
    <div class="cards" style="grid-template-columns: repeat(4,1fr);">
      <div class="stat-card"><div class="num">${catalog.count || 0}</div><div class="lbl">Configured cohorts</div></div>
      <div class="stat-card"><div class="num">${totalMembers}</div><div class="lbl">Members right now</div></div>
      <div class="stat-card"><div class="num" style="color:${totalUnresolved ? 'var(--warn)' : 'inherit'};">${totalUnresolved}</div><div class="lbl">Unresolved (coverage, not risk)</div></div>
      <div class="stat-card"><div class="num" style="color:${dead.length ? 'var(--bad)' : 'inherit'};">${dead.length}</div><div class="lbl">Cannot admit anyone</div></div>
    </div>
    <div id="cohort-editor"></div>
    <div class="detail">
      <h3 style="margin-top:0;">Catalog</h3>
      <p class="muted" style="font-size:12px;">"0 members" is three different facts: nobody qualifies, nobody has the measurement, or the criteria cannot be satisfied <em>together</em>. The coverage column says which — reading it as "no patients at risk" is the failure this column exists to prevent.</p>
      <div style="display:grid;gap:8px;margin-top:8px;">${(catalog.cohorts || []).map((c) => cohortRow(c, stateById.get(c.id), declineById.get(c.id))).join('') || '<span class="muted" style="font-size:12px;">No cohorts configured.</span>'}</div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Decline analysis</h3>
      <p class="muted" style="font-size:12px;">A decline is the only signal that a clinician disagreed with a criterion. Declines are attributed to the version they were made against, so editing a definition (and bumping <code>criterionVersion</code>) legitimately re-opens the question — a new criterion has not been judged yet. Nothing below changes a cohort; the tuning step stays a human edit.</p>
      <div style="display:grid;gap:8px;margin-top:8px;">${(declines.cohorts || []).map(cohortDeclineRow).join('') || '<span class="muted" style="font-size:12px;">No human decisions recorded yet.</span>'}</div>
    </div>
    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Metric vocabulary <span class="pill muted">${metrics ? metrics.metrics.length : 0} metrics</span></h3>
      <p class="muted" style="font-size:12px;">Closed on purpose. Every metric names the module that computes it, so an authored cohort composes existing outputs rather than re-deriving clinical logic that could disagree with the protocol it belongs to.</p>
      <div style="max-height:260px;overflow:auto;margin-top:8px;">
        <table style="width:100%;font-size:12px;">
          <thead><tr><th>Metric</th><th>Unit</th><th>Type</th><th>Computed by</th></tr></thead>
          <tbody>${metrics ? metrics.metrics.map((m) => `<tr><td><code>${esc(m.id)}</code><div class="muted">${esc(m.label)}</div></td><td>${esc(m.unit || '—')}</td><td><span class="pill muted">${esc(m.valueType)}</span></td><td class="muted">${esc(m.source)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Vocabulary unavailable.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  hydrateIcons();
}
