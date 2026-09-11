import { api, drafts } from './api.js';
import { esc, hydrateIcons } from './theme.js';
import { draftsFromServer } from '../views/agent-runtime.js';
import { plFetch } from '../views/platform-admin.js';

export function emptyStateHTML(title, sub, actionHTML = '') {
  return `<div class="state-card"><div class="state-icon"><i data-lucide="inbox"></i></div><div class="state-title">${esc(title)}</div><div class="state-sub">${sub || ''}</div>${actionHTML ? `<div class="state-action">${actionHTML}</div>` : ''}</div>`;
}

export function errorStateHTML(err) {
  return `<div class="state-card error"><div class="state-icon"><i data-lucide="triangle-alert"></i></div><div class="state-title">Couldn't load this realm</div><div class="state-sub">${esc(String(err || 'unknown error'))}</div></div>`;
}

export function loadFailureHTML(subject, err) {
  const msg = String(err || 'unknown error');
  const denied = /role-not-permitted-for-console|^403$|not-authenticated/.test(msg);
  const unauth = /not-authenticated/.test(msg);
  const title = unauth ? 'Sign in to continue' : denied ? 'Not permitted for your role' : `Couldn't load ${subject}`;
  const sub = unauth
    ? 'Your session has ended. Sign in again to load this page.'
    : denied
      ? 'This surface belongs to the other console. The fields below were NOT loaded with defaults.'
      : msg;
  return `<div class="state-card error"><div class="state-icon"><i data-lucide="shield-alert"></i></div><div class="state-title">${esc(title)}</div><div class="state-sub">${esc(sub)}</div></div>`;
}

export async function loadRealmsForScope() {
  try { const r = await api('GET', '/admin/realms'); return (r.realms || []).map((x) => x.id); }
  catch (_) { return []; }
}

export function loadingHTML() {
  return `<div class="state-card"><div class="skeleton skeleton-block" style="width:100%;max-width:420px;"></div><div class="skeleton skeleton-line" style="width:60%;"></div><div class="skeleton skeleton-line" style="width:45%;"></div></div>`;
}

export async function mountScope(loadBody) {
  const select = document.getElementById('scope-realm');
  const refresh = document.getElementById('scope-refresh');
  if (!select || !refresh) return;
  const ids = await loadRealmsForScope();
  if (ids.length && !ids.includes(realmScope)) realmScope = ids[0];
  select.innerHTML = ids.map((id) => `<option value="${esc(id)}" ${id === realmScope ? 'selected' : ''}>${esc(id)}</option>`).join('') || '<option value="">no realms</option>';
  const run = () => { if (realmScope && typeof loadBody === 'function') loadBody(realmScope); else setScopeHint('Create a realm in World → Realm to populate this view.'); };
  select.addEventListener('change', () => { realmScope = select.value; run(); });
  refresh.addEventListener('click', run);
  run();
  if (window.hydrateIcons) window.hydrateIcons();
}

export const pageTabs = document.getElementById('page-tabs');

export let realmScope = '';

export function releaseGateHTML(gate) {
  if (!gate || !gate.verdict) return '<div class="muted" style="font-size:12px;">Gate evidence unavailable.</div>';
  const { input, verdict } = gate;
  const tone = verdict.decision === 'ship' ? 'good' : verdict.decision === 'hold' ? 'warn' : 'bad';
  const chip = (ok, label) => `<span class="pill ${ok ? 'good' : 'warn'}">${esc(label)} ${ok ? '✓' : '…'}</span>`;
  const green = (input.green || []).map((c) => `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.plane)}</td><td><span class="pill ${c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : 'warn'}">${esc(c.status)}</span></td><td>${esc(c.check)}</td><td class="muted" style="font-size:11px;">${esc(c.evidence || '')}</td></tr>`).join('');
  const red = (input.red || []).map((r) => `<span class="pill ${r.contained ? 'good' : 'bad'}">${esc(r.id)} ${r.contained ? 'contained' : 'OPEN'}</span>`).join('');
  return `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="pill ${tone}" style="font-size:12px;">${esc(verdict.decision.toUpperCase())}</span>
      <span class="muted" style="font-size:12px;">score ${verdict.score} · green ${Math.round((verdict.greenScore || 0) * 100)}%</span>
      ${chip(verdict.redOpen === 0, `${verdict.redOpen} red open`)}
      ${chip(verdict.sourcesCurrent, 'sources current')}
      ${chip(verdict.approvalsMet, 'approvals met')}
    </div>
    ${(verdict.blocks || []).length ? `<div class="muted" style="font-size:12px;margin-top:6px;">Blocks: <b>${(verdict.blocks || []).map((b) => esc(b)).join(', ')}</b></div>` : ''}
    ${(verdict.reasons || []).length ? `<div class="muted" style="font-size:12px;margin-top:2px;">Holds: ${(verdict.reasons || []).map((b) => esc(b)).join('; ')}</div>` : ''}
    <div class="muted" style="font-size:11px;margin-top:8px;">Red findings: ${red || '<span class="muted">none</span>'}</div>
    <div style="overflow-x:auto;margin-top:8px;"><table style="width:100%;"><thead><tr><th>Check</th><th>Plane</th><th>Status</th><th>Assertion</th><th>Evidence</th></tr></thead><tbody>${green || '<tr><td colspan="5" class="muted">No green checks.</td></tr>'}</tbody></table></div>`;
}

export function scopeShell(title, subtitle, extraHeader = '') {
  return `
    <div class="page-header"><div><h2 class="page-title">${esc(title)}</h2><p class="page-sub">${esc(subtitle)}</p></div>${extraHeader}</div>
    <div class="scope-bar">
      <span class="scope-title">Realm</span>
      <select id="scope-realm" class="scope-select"></select>
      <button class="btn btn-ghost" id="scope-refresh"><i data-lucide="refresh-cw"></i> Refresh</button>
      <span class="scope-hint" id="scope-hint"></span>
    </div>
    <div id="scope-body"></div>`;
}

export function setCount(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val ?? '—');
}

export function setScopeHint(text) {
  const el = document.getElementById('scope-hint');
  if (el) el.innerHTML = text || '';
}

export async function updateSidebarCounts() {
  const s = await api('GET', '/admin/summary');
  setCount('c-agents', s.agents.total);
  // Cohort count is the operator's own catalog, so it comes from the cohort API
  // rather than the bundled snapshot.
  (async () => {
    try { setCount('c-cohorts', (await plFetch('GET', '/admin/cohorts')).count); }
    catch (_) { setCount('c-cohorts', '—'); }
  })();
  // Drafts count comes from the real authoring service when reachable.
  (async () => {
    const live = await draftsFromServer();
    setCount('c-drafts', live !== null ? live.length : drafts.length);
  })();
  setCount('c-measures', s.measures.total);
  setCount('c-assessments', s.assessments.total);
  setCount('c-research', s.researchSources);
  try {
    const r = await api('GET', '/admin/realms/demo');
    setCount('c-realm', (r.patients?.length ?? 0) + 'p');
    setCount('c-presences', r.presences?.length ?? '—');
    setCount('c-effects', r.effects?.length ?? '—');
    setCount('c-experiences', r.experiences?.length ?? '—');
    setCount('c-episodes', r.episodes?.length ?? '—');
    setCount('c-attributions', r.attributions?.length ?? '—');
  } catch (_) { /* realm snapshot not present */ }
}
