/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// Specialty bindings (G6) — the console for "which specialty applies here, and
// which one is shown here".
//
// The three flags are presented as three separate controls with their own
// labels, never as one "enabled" switch, because the whole point of the model is
// that they are different questions. The panel also states plainly that hidden is
// not the same as stopped: an operator who hides a specialty needs to know
// whether it is still evaluating their patients.

import { esc, hydrateIcons, toast } from '../core/theme.js';
import { main } from '../core/shell.js';
import { loadFailureHTML } from '../core/scope.js';
import { plFetch } from './platform-admin.js';

let state = { bindings: [], issues: [], installed: [], scopes: [], viewerScopeIds: [], resolved: [] };
let editingId = null;

const boolPill = (v, on = 'mint', off = 'muted') => `<span class="pill ${v ? on : off}">${v ? 'yes' : 'no'}</span>`;

/** One resolved pack, as the CURRENT caller sees it. */
function resolvedRow(r) {
  // The configuration worth warning about is not "off" — it is running while
  // invisible, because nothing on any screen would reveal it.
  const hazard = r.applied && !r.show;
  return `<tr>
    <td><code>${esc(r.packId)}</code>${r.primary ? ' <span class="pill mint">leads</span>' : ''}</td>
    <td>${boolPill(r.applied, 'mint', 'muted')}</td>
    <td class="muted" style="font-size:11px;">${r.appliedScopes.length ? esc(r.appliedScopes.join(', ')) : '—'}</td>
    <td>${boolPill(r.show, 'mint', 'muted')}</td>
    <td>${boolPill(r.entitled, 'mint', 'amber')}</td>
    <td class="muted" style="font-size:11px;">${esc(r.reason)}${r.reason === 'no-binding' ? ' <span class="pill muted">install default</span>' : ''}</td>
    <td>${hazard ? '<span class="pill red" title="This specialty evaluates patients while no console shows it.">computes, hidden</span>' : ''}</td>
  </tr>`;
}

function bindingRow(b) {
  const flags = [
    b.applied ? '<span class="pill mint">applied</span>' : '<span class="pill muted">not applied</span>',
    b.show ? '<span class="pill mint">shown</span>' : '<span class="pill muted">hidden</span>',
    b.entitled ? '' : '<span class="pill amber">unlicensed</span>',
    b.primary ? '<span class="pill mint">leads</span>' : '',
  ].filter(Boolean).join(' ');
  return `<tr>
    <td><code>${esc(b.scope)}</code></td>
    <td><code>${esc(b.packId)}</code></td>
    <td style="display:flex;gap:4px;flex-wrap:wrap;">${flags}</td>
    <td class="muted" style="font-size:11px;">${esc(b.by || '')}${b.note ? ` · ${esc(b.note)}` : ''}</td>
    <td style="white-space:nowrap;">
      <button class="btn" onclick="plBindEdit('${esc(b.id)}')">Edit</button>
      <button class="btn" onclick="plBindDelete('${esc(b.id)}')">Delete</button>
    </td>
  </tr>`;
}

function issuesHTML(issues) {
  if (!issues.length) return '<div class="muted" style="font-size:12px;">No configuration problems.</div>';
  return `<div style="display:grid;gap:5px;">${issues.map((i) => `
    <div style="font-size:12px;color:${i.blocking ? 'var(--bad)' : 'var(--warn)'};">
      <span class="pill ${i.blocking ? 'red' : 'amber'}">${i.blocking ? 'blocking' : 'warning'}</span>
      <code>${esc(i.code)}</code> — ${esc(i.detail)}
    </div>`).join('')}</div>`;
}

export async function renderPlatformBindings() {
  let data = null;
  let err = null;
  try { data = await plFetch('GET', '/admin/platform/specialty-bindings'); } catch (e) { err = e.message; }
  if (!data) {
    main.innerHTML = `<div class="page-header"><div><h2 class="page-title">Specialty bindings</h2></div></div>${loadFailureHTML('the specialty bindings', err)}`;
    hydrateIcons();
    return;
  }
  state = data;

  const editing = editingId ? state.bindings.find((b) => b.id === editingId) : null;
  const scopList = Array.from(new Set(['scope:*', ...state.scopes])).sort();
  const hidden = state.resolved.filter((r) => !r.show).length;

  main.innerHTML = `
    <div class="page-header"><div><h2 class="page-title">Specialty bindings</h2>
      <p class="page-sub">Which specialty <b>evaluates</b> this population, which one the console <b>shows</b>, and which one the customer is <b>licensed</b> for — three separate answers, because they are three separate questions. Hiding a specialty does not stop it: a pack that is applied but not shown still reads patient data, so that combination is flagged rather than allowed to look idle.</p></div></div>

    <div class="cards" style="grid-template-columns:repeat(5,1fr);">
      <div class="stat-card"><div class="num">${state.installed.length}</div><div class="lbl">Installed packs</div></div>
      <div class="stat-card"><div class="num">${state.bindings.length}</div><div class="lbl">Bindings</div></div>
      <div class="stat-card"><div class="num">${state.resolved.filter((r) => r.show).length}</div><div class="lbl">Shown to you</div></div>
      <div class="stat-card"><div class="num">${hidden}</div><div class="lbl">Hidden from you</div></div>
      <div class="stat-card"><div class="num">${state.issues.filter((i) => i.blocking).length}</div><div class="lbl">Blocking problems</div></div>
    </div>

    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Add or update a binding</h3>
      <p class="muted" style="font-size:12px;margin-top:0;">A binding is keyed on <b>scope + pack</b>, so saving the same pair again updates it rather than adding a second row. A <code>scope:*</code> rule applies everywhere; a realm or facility rule applies only to callers provisioned with that scope. A pack with no binding at all keeps the install default — installed means applied and shown.</p>
      <div class="field-row">
        <div class="field" style="flex:1.4;"><label>Scope</label>
          <input id="pb-scope" list="pb-scope-list" placeholder="scope:*" value="${esc(editing ? editing.scope : 'scope:*')}" />
          <datalist id="pb-scope-list">${scopList.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
        </div>
        <div class="field" style="flex:1.4;"><label>Pack</label>
          <select id="pb-pack">${state.installed.map((p) => `<option value="${esc(p)}"${editing && editing.packId === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
        </div>
        <div class="field checkbox"><label><input type="checkbox" id="pb-applied"${!editing || editing.applied ? ' checked' : ''} /> Applied — evaluates this population</label></div>
        <div class="field checkbox"><label><input type="checkbox" id="pb-show"${!editing || editing.show ? ' checked' : ''} /> Shown — renders this lens</label></div>
        <div class="field checkbox"><label><input type="checkbox" id="pb-entitled"${!editing || editing.entitled ? ' checked' : ''} /> Entitled — licensed</label></div>
        <div class="field checkbox"><label><input type="checkbox" id="pb-primary"${editing && editing.primary ? ' checked' : ''} /> Leads the console</label></div>
        <div class="field" style="flex:1;"><label>Note</label><input id="pb-note" value="${esc(editing && editing.note ? editing.note : '')}" placeholder="why this rule exists" /></div>
        <div class="field"><button class="btn btn-primary" onclick="plBindSave()">${editing ? 'Update' : 'Save'}</button></div>
        ${editing ? '<div class="field"><button class="btn" onclick="plBindCancel()">Cancel</button></div>' : ''}
      </div>
      <div id="pb-out" class="muted" style="font-size:12px;margin-top:6px;"></div>
    </div>

    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Configured bindings</h3>
      ${state.bindings.length ? `<div class="table-wrap"><table style="width:100%;"><thead><tr><th>Scope</th><th>Pack</th><th>Flags</th><th>Set by</th><th></th></tr></thead><tbody>${state.bindings.map(bindingRow).join('')}</tbody></table></div>`
        : '<div class="muted" style="font-size:12px;">No bindings — every installed pack follows the install default (applied and shown). This is what the deployment looked like before this model existed, which is why adding one changes nothing else.</div>'}
    </div>

    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">What this resolves to for you</h3>
      <p class="muted" style="font-size:12px;margin-top:0;">Your scopes: <code>${esc(state.viewerScopeIds.join(', ') || 'none (anonymous)')}</code>. The same configuration can resolve differently for a different operator, which is the point of scoping it.</p>
      <div class="table-wrap"><table style="width:100%;"><thead><tr><th>Pack</th><th>Applied</th><th>Applies at</th><th>Shown</th><th>Entitled</th><th>Decided by</th><th></th></tr></thead><tbody>${state.resolved.map(resolvedRow).join('')}</tbody></table></div>
    </div>

    <div class="detail" style="margin-top:12px;">
      <h3 style="margin-top:0;">Configuration health</h3>
      ${issuesHTML(state.issues || [])}
    </div>`;
  hydrateIcons();
}

/** Read the form. Returns undefined and reports when a required field is empty. */
function readBindingForm() {
  const out = document.getElementById('pb-out');
  const scope = (document.getElementById('pb-scope').value || '').trim();
  const packId = document.getElementById('pb-pack').value;
  if (!scope || !packId) {
    if (out) out.innerHTML = '<span style="color:var(--warn);">Scope and pack are both required.</span>';
    return undefined;
  }
  return {
    scope,
    packId,
    applied: document.getElementById('pb-applied').checked,
    show: document.getElementById('pb-show').checked,
    entitled: document.getElementById('pb-entitled').checked,
    primary: document.getElementById('pb-primary').checked,
    ...(document.getElementById('pb-note').value.trim() ? { note: document.getElementById('pb-note').value.trim() } : {}),
  };
}

window.plBindSave = async function plBindSave() {
  const body = readBindingForm();
  if (!body) return;
  const out = document.getElementById('pb-out');
  try {
    const r = await plFetch('PUT', '/admin/platform/specialty-bindings', body);
    const soft = (r.issues || []).filter((i) => !i.blocking);
    editingId = null;
    toast(soft.length ? `Saved with ${soft.length} warning(s)` : 'Binding saved');
    await renderPlatformBindings();
  } catch (e) {
    // The server refuses a binding that could not do what it appears to do, and
    // its reasons are the useful part of the message.
    if (out) out.innerHTML = `<span style="color:var(--bad);">${esc(e.message)}</span>`;
  }
};

window.plBindEdit = function plBindEdit(id) {
  editingId = id;
  renderPlatformBindings();
  document.getElementById('pb-scope')?.focus();
};

window.plBindCancel = function plBindCancel() {
  editingId = null;
  renderPlatformBindings();
};

window.plBindDelete = async function plBindDelete(id) {
  if (!confirm(`Delete the binding ${id}?\n\nThe pack returns to the install default (applied and shown), which is not the same as switching it off.`)) return;
  try {
    await plFetch('DELETE', `/admin/platform/specialty-bindings/${encodeURIComponent(id)}`);
    if (editingId === id) editingId = null;
    toast('Binding deleted — the pack follows the install default again');
  } catch (e) {
    toast(`Could not delete: ${e.message}`);
  }
  await renderPlatformBindings();
};
