import { S } from '../state.js';
import { api, drafts, ensurePacks, loadFile } from '../core/api.js';
import { NAV, allowedSections } from '../core/nav.js';
import { main } from '../core/shell.js';
import { esc, toast } from '../core/theme.js';
import { plFetch } from './platform-admin.js';

export function addStep() { editorState.steps.push({ id: 'step-' + (editorState.steps.length + 1), skill: '' }); renderSteps(); }

export async function cloneAgent(packId, id) {
  const agents = await loadFile('agents.json');
  const a = agents.find(x => x.packId === packId && x.id === id);
  if (!a) return;
  const newId = prompt(`Clone as new agent id:`, id + '-copy');
  if (!newId) return;
  // Build a minimal scaffold from the published agent summary
  renderEditor({
    id: newId,
    packId: a.packId,
    displayName: a.displayName + ' (copy)',
    description: a.description || '',
    triggerKind: a.triggerKind || 'event',
    eventType: a.triggerEventType || '',
    setting: a.setting || '',
    lifecycleStage: a.lifecycleStage || '',
    baseFeeUsd: a.baseFeeUsd || 0,
    steps: [{ id: 'step-1', skill: '' }],
  });
  setTimeout(generateYaml, 100);
}

export function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

export async function editDraft(packId, id) {
  try {
    const res = await fetch(`/admin/drafts/${encodeURIComponent(packId)}/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const d = await res.json();
      if (d && d.yaml) { renderEditor({ id, packId, yaml: d.yaml }); return; }
    }
  } catch { /* offline */ }
  const d = drafts.find(x => x.packId === packId && x.id === id);
  if (!d) return;
  renderEditor({ id, packId, yaml: d.yaml });
}

export let editorState = { id: '', packId: '', displayName: '', description: '', triggerKind: 'event', eventType: '', cron: '', scope: 'facility', phiHandling: 'read', purposeOfUse: 'treatment', clearanceRequired: 'phi', baseFeeUsd: 0, budgetCapMonthlyUsd: '', setting: '', lifecycleStage: '', steps: [{ id: 'step-1', skill: '' }], yaml: '' };

export function generateYaml() {
  readForm();
  const s = editorState;
  if (!s.id || !s.packId || !s.displayName) return toast('Fill id, pack, and name first', 'err');
  const lines = [
    `id: ${s.id}`,
    `version: 1.0.0`,
    `packId: ${s.packId}`,
    `displayName: ${JSON.stringify(s.displayName)}`,
  ];
  if (s.description) lines.push(`description: ${JSON.stringify(s.description)}`);
  lines.push(`scope: ${s.scope}`);
  lines.push(`trigger:`);
  lines.push(`  kind: ${s.triggerKind}`);
  if (s.triggerKind === 'event' && s.eventType) lines.push(`  eventType: ${s.eventType}`);
  if (s.triggerKind === 'cron' && s.cron) lines.push(`  expression: ${JSON.stringify(s.cron)}`);
  lines.push(`inputs: {}`);
  lines.push(`outputs: {}`);
  lines.push(`plan:`);
  lines.push(`  type: sequence`);
  lines.push(`  children:`);
  for (const st of s.steps) {
    lines.push(`    - type: step`);
    lines.push(`      step:`);
    lines.push(`        id: ${st.id}`);
    lines.push(`        skill: ${st.skill || 'noop'}`);
    lines.push(`        inputs: {}`);
  }
  lines.push(`governance:`);
  lines.push(`  phiHandling: ${s.phiHandling}`);
  lines.push(`  purposeOfUse: [${s.purposeOfUse}]`);
  lines.push(`  clearanceRequired: ${s.clearanceRequired}`);
  lines.push(`billing:`);
  lines.push(`  baseFeeUsd: ${s.baseFeeUsd}`);
  if (s.budgetCapMonthlyUsd !== '') lines.push(`  budgetCapMonthlyUsd: ${s.budgetCapMonthlyUsd}`);
  if (s.setting || s.lifecycleStage) {
    lines.push(`labels:`);
    if (s.setting) lines.push(`  setting: ${s.setting}`);
    if (s.lifecycleStage) lines.push(`  lifecycleStage: ${s.lifecycleStage}`);
  }
  editorState.yaml = lines.join('\n') + '\n';
  document.getElementById('yaml-editor').value = editorState.yaml;
  validateNow();
}

export function readForm() {
  editorState.id = document.getElementById('f-id').value.trim();
  editorState.packId = document.getElementById('f-pack').value;
  editorState.displayName = document.getElementById('f-name').value;
  editorState.description = document.getElementById('f-desc').value;
  editorState.scope = document.getElementById('f-scope').value;
  editorState.triggerKind = document.getElementById('f-trigger').value;
  editorState.eventType = document.getElementById('f-event').value;
  editorState.cron = document.getElementById('f-cron').value;
  editorState.phiHandling = document.getElementById('f-phi').value;
  editorState.purposeOfUse = document.getElementById('f-pou').value;
  editorState.clearanceRequired = document.getElementById('f-clearance').value;
  editorState.setting = document.getElementById('f-setting').value;
  editorState.lifecycleStage = document.getElementById('f-lifecycle').value;
  editorState.baseFeeUsd = parseFloat(document.getElementById('f-fee').value) || 0;
  editorState.budgetCapMonthlyUsd = document.getElementById('f-cap').value ? parseFloat(document.getElementById('f-cap').value) : '';
}

export async function refreshSyntheticBadge() {
  const badge = document.getElementById('synthetic-badge');
  if (!badge) return;
  try {
    const j = await plFetch('GET', '/admin/platform/organization');
    const synthetic = !!(j.organization && j.organization.synthetic);
    badge.style.display = synthetic ? '' : 'none';
  } catch { badge.style.display = 'none'; }
}

export function removeStep(i) { editorState.steps.splice(i, 1); renderSteps(); }

export async function renderEditor(initial) {
  await ensurePacks();
  Object.assign(editorState, { id: '', packId: '', displayName: '', description: '', triggerKind: 'event', eventType: '', cron: '', scope: 'facility', phiHandling: 'read', purposeOfUse: 'treatment', clearanceRequired: 'phi', baseFeeUsd: 0, budgetCapMonthlyUsd: '', setting: '', lifecycleStage: '', steps: [{ id: 'step-1', skill: '' }], yaml: '' }, initial);
  main.innerHTML = `
    <div class="page-header">
      <div><h2 class="page-title">${initial.id ? `Edit draft: <code>${esc(initial.id)}</code>` : 'New agent'}</h2><p class="page-sub">Fill the form to scaffold YAML, or edit the YAML directly on the right. Live validated.</p></div>
      <div class="flex"><button class="btn" onclick="goTo('drafts')">Cancel</button></div>
    </div>
    <div class="editor">
      <div class="editor-pane">
        <h3>Structured form</h3>
        <div class="form-row"><label>Agent ID</label><input id="f-id" placeholder="kebab-case-id" value="${esc(editorState.id)}" /></div>
        <div class="form-row"><label>Pack</label><select id="f-pack">
          <option value="">choose a pack…</option>
          ${S.PACKS.map(p => `<option${editorState.packId === p ? ' selected' : ''}>${p}</option>`).join('')}
        </select></div>
        <div class="form-row"><label>Display name</label><input id="f-name" value="${esc(editorState.displayName)}" /></div>
        <div class="form-row"><label>Description</label><textarea id="f-desc">${esc(editorState.description)}</textarea></div>
        <div class="form-row"><label>Scope</label><select id="f-scope">${['org','region','facility','patient'].map(x => `<option${editorState.scope===x?' selected':''}>${x}</option>`).join('')}</select></div>
        <div class="form-row"><label>Trigger</label><select id="f-trigger">${['event','cron','webhook','manual'].map(x => `<option${editorState.triggerKind===x?' selected':''}>${x}</option>`).join('')}</select></div>
        <div class="form-row" id="row-event" ${editorState.triggerKind !== 'event' ? 'style="display:none"' : ''}><label>Event type</label><input id="f-event" placeholder="lab.result-arrived" value="${esc(editorState.eventType)}" /></div>
        <div class="form-row" id="row-cron" ${editorState.triggerKind !== 'cron' ? 'style="display:none"' : ''}><label>Cron</label><input id="f-cron" placeholder="0 9 * * *" value="${esc(editorState.cron)}" /></div>
        <div class="form-row"><label>Plan steps</label>
          <div>
            <div class="steps-list" id="steps"></div>
            <button class="btn btn-ghost" style="margin-top:6px;font-size:12px;" onclick="addStep()">+ Add step</button>
          </div>
        </div>
        <div class="form-row"><label>PHI handling</label><select id="f-phi">${['none','read','read-write'].map(x => `<option${editorState.phiHandling===x?' selected':''}>${x}</option>`).join('')}</select></div>
        <div class="form-row"><label>Purpose of use</label><select id="f-pou">${['treatment','operations','compliance','research','break-glass'].map(x => `<option${editorState.purposeOfUse===x?' selected':''}>${x}</option>`).join('')}</select></div>
        <div class="form-row"><label>Clearance</label><select id="f-clearance">${['public','internal','confidential','phi','restricted-phi'].map(x => `<option${editorState.clearanceRequired===x?' selected':''}>${x}</option>`).join('')}</select></div>
        <div class="form-row"><label>Setting label</label><input id="f-setting" placeholder="dialysis|primary-care|urgent-care|…" value="${esc(editorState.setting)}" /></div>
        <div class="form-row"><label>Lifecycle stage</label><input id="f-lifecycle" placeholder="active-care|onboarding|discharge|…" value="${esc(editorState.lifecycleStage)}" /></div>
        <div class="form-row"><label>Base fee USD</label><input id="f-fee" type="number" step="0.01" value="${editorState.baseFeeUsd}" /></div>
        <div class="form-row"><label>Monthly budget cap USD</label><input id="f-cap" type="number" step="1" value="${editorState.budgetCapMonthlyUsd}" placeholder="optional" /></div>
        <div class="actions">
          <button class="btn btn-primary" onclick="generateYaml()">Generate YAML →</button>
        </div>
      </div>

      <div class="editor-pane">
        <h3>YAML source <span class="pill muted" style="margin-left:6px;">live validated</span></h3>
        <textarea id="yaml-editor" spellcheck="false" placeholder="Click 'Generate YAML' or paste an AgentSpec here…">${esc(editorState.yaml)}</textarea>
        <div id="validation-result"></div>
        <div class="actions">
          <button class="btn" onclick="validateNow()">Validate</button>
          <button class="btn" onclick="saveDraft('draft')">Save draft</button>
          <button class="btn btn-primary" onclick="saveDraft('in-review')">Submit for review</button>
        </div>
      </div>
    </div>
  `;
  renderSteps();
  document.getElementById('f-trigger')?.addEventListener('change', (e) => {
    editorState.triggerKind = e.target.value;
    document.getElementById('row-event').style.display = editorState.triggerKind === 'event' ? '' : 'none';
    document.getElementById('row-cron').style.display = editorState.triggerKind === 'cron' ? '' : 'none';
  });
  document.getElementById('yaml-editor')?.addEventListener('input', debounce(() => validateNow(), 400));
  if (editorState.yaml) validateNow();
}

export function renderSteps() {
  document.getElementById('steps').innerHTML = editorState.steps.map((s, i) => `
    <div class="step-row">
      <input placeholder="step id" value="${esc(s.id)}" oninput="editorState.steps[${i}].id=this.value" />
      <input placeholder="skill (e.g. sql.query)" value="${esc(s.skill)}" oninput="editorState.steps[${i}].skill=this.value" />
      <button onclick="removeStep(${i})" ${editorState.steps.length === 1 ? 'disabled' : ''}>×</button>
    </div>
  `).join('');
}

export async function validateNow() {
  const yaml = document.getElementById('yaml-editor').value;
  editorState.yaml = yaml;
  const v = await api('POST', '/admin/drafts/validate', { yaml });
  const box = document.getElementById('validation-result');
  if (v.ok) box.innerHTML = `<div class="validation ok">✓ Valid AgentSpec</div>`;
  else box.innerHTML = `<div class="validation err"><b>${v.errors.length} error${v.errors.length===1?'':'s'}</b><ul>${v.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
}

export function viewAllowed(view) {
  const allowed = allowedSections();
  if (!allowed) return true;
  return NAV.some((g) => allowed.includes(g.section) && g.items.some((it) => it.view === view));
}
