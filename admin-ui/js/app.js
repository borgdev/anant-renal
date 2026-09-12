/*******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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
 *******************************************************************************/

import { goTo, registerView, render } from './core/router.js';
import { S } from './state.js';
import { api, consoleDomain, drafts } from './core/api.js';
import { checkAuth, rawJson, renderTopbarUser } from './core/auth.js';
import { currentYearPeriod, renderSummary } from './core/format.js';
import { NAV, VIEW_INDEX, applyReadOnly, collapsedSections, initSidebar, pinnedViews, renderSidebar, saveSidebarState } from './core/nav.js';
import { pageTabs, realmScope, updateSidebarCounts } from './core/scope.js';
import { main, nav } from './core/shell.js';
import { toggleShortcuts } from './core/shortcuts.js';
import { renderPageTabs } from './core/tabs.js';
import { dataGrid, esc, hydrateIcons, initTheme, toast } from './core/theme.js';
import { renderAgentRuntime, renderAgents, renderDrafts } from './views/agent-runtime.js';
import { cfgSpecDelete, cfgSpecExport, cfgSpecImport, cfgSpecOpen, cfgSpecPublish, cfgSpecsBody } from './views/agent-specs.js';
import { renderPlatformAgents, renderPlatformContext } from './views/agent-studio.js';
import { renderPlatformAssurance } from './views/assurance.js';
import { renderAttributions } from './views/attributions.js';
import { labPatientBundle, renderAssessments, renderLifecycle, renderMeasures } from './views/catalog.js';
import { cohortAddCriterion, cohortCancelEdit, cohortCriterionInput, cohortDelete, cohortEdit, cohortEvaluateNow, cohortNew, cohortRemoveCriterion, cohortSave, cohortToggle, renderPlatformCohorts } from './views/cohorts.js';
import { renderCommandCenter } from './views/command-center.js';
import { renderCompliance, renderFhirPanel, renderUsers } from './views/compliance.js';
import { cfReportHTML, loadCfList, renderCounterfactual } from './views/counterfactual.js';
import { renderDurableStorage } from './views/durable-storage.js';
import { addStep, cloneAgent, editDraft, editorState, generateYaml, refreshSyntheticBadge, removeStep, renderEditor, validateNow, viewAllowed } from './views/editor.js';
import { renderEnterprisePanel } from './views/enterprise.js';
import { renderEpisodes } from './views/episodes.js';
import { renderBrokerPanel } from './views/event-broker.js';
import { cfgObjectsBody, wsCatalogCreate, wsCatalogDelete, wsCatalogEdit } from './views/exec-substrate.js';
import { renderWsSubmissions, wsFetch, wsSubmissionCreate, wsSubmissionDelete, wsSubmissionValidate } from './views/exec-workspace.js';
import { renderPlatformExecutive } from './views/executive-outcomes.js';
import { renderExperiences } from './views/experiences.js';
import { renderHypergraphBrowser } from './views/hypergraph.js';
import { knowledgeFilter, openCredentialSheet, openProvenance, renderResearch, runDueSources, saveCreds, syncSource, testCreds } from './views/knowledge.js';
import { renderLearn } from './views/learn.js';
import { renderMyWork, renderPlatformDlq, wqBegin, wqCancelDecline, wqClose, wqConfirmDecline, wqDeclineReason, wqFilter, wqOpen, wqRefresh } from './views/my-work.js';
import { renderAudit, renderLiquidTrain, renderLiquidWhatIf } from './views/narrative.js';
import { nlObserve, renderNudgeLedger } from './views/nudge-ledger.js';
import { wsOntologyAdd, wsOntologyPullLive, wsOntologyRemove, wsOntologySave, wsOntologySet } from './views/ontology.js';
import { paIntegrationsSection, paSteps, paTopicsSection, plFetch, renderPlatformAdmin, renderPlatformReleases } from './views/platform-admin.js';
import { cfgTab, plPackActivate, plPackDeactivate, renderPlatformConfig } from './views/platform-config.js';
import { closeRealmModal, createModalHTML, openRealmModal, realmCard, renderEffects, renderPerception, renderPresences, trajPill } from './views/realm.js';
import { renderRsiApp, renderRsiDeepLink } from './views/rsi.js';
import { renderRules } from './views/rules.js';
import { renderLiquidScore } from './views/score-labs.js';
import { renderSentience } from './views/sentience.js';
import { renderPlatformCanvases } from './views/shared-intelligence.js';
import { simAction, simCleanup } from './views/simulator.js';
import { renderWorldBuilder, spawnStaff } from './views/world-builder.js';

// ---------- Bundled snapshot API shim ----------
// In the deployed static site, GETs are served from bundled JSON snapshots.
// In production the same routes are served by Fastify (see admin-routes.ts).
// Writes (POST /admin/drafts, publish, reject) hit the local storage draft
// store here so the create/publish workflow is fully interactive in the demo.

// In-session state only (preview iframe blocks localStorage). Production wires
// these to the real /admin/drafts routes backed by the AgentAuthoringService.

// Pack registry — derived from the live agent catalog (/admin/agents). The
// static list is only a first-paint fallback so the UI never depends on it
// once the backend responds.

// Console domain catalog + Learn recipes — fetched from the backend
// (/admin/console/*) so no domain config is hardcoded in the UI. The literals
// below are only first-paint fallbacks for offline / static-snapshot builds.

// Module-scope catalog: sync template/handler fns (createModalHTML, createRealm,
// loadRealmDetail) read this directly; consoleDomain() keeps it current.

// ---------- Client-side validation (mirrors src/agents/spec.ts) ----------

// Fallback minimal YAML if js-yaml is not loaded — we ship js-yaml from CDN in production.

// ---------- Router + views ----------

// ---------- Navigation model (drives the dockable sidebar) ----------

NAV.forEach((g) => g.items.forEach((it) => { VIEW_INDEX[it.view] = it; }));

// Role-based navigation — which sections a signed-in user may see. `null` = all.
// Matches IdentityRole: admin | md | nurse | pharmacist | coder | auditor | facilities-tech | safety.

/** Roles that may READ the configuration but never write it.
 *  Mirrors READ_ONLY_ROLES in src/server/api-auth.ts — the server is the
 *  boundary; this only stops the console from offering buttons that would 403. */

/** Reading, not writing: a read-only role keeps the page and loses the buttons. */

/**
 * Disable every writer on a configuration page for a read-only role.
 *
 * Deliberately inverted: disable all controls, then re-enable the ones that only
 * navigate or refresh. If a harmless control ends up disabled that is a small
 * annoyance; if a "Save" ended up enabled the console would be offering an action
 * the server refuses, which is the thing being fixed.
 */

// Sidebar dock state — `docked` (full) or `collapsed` (icon rail + flyout).

// ---------- Global header search (realms / patients / agents / measures / audit) ----------
function initGlobalSearch() {
  const input = document.getElementById('global-q');
  const results = document.getElementById('global-results');
  if (!input || !results) return;
  let timer = null;
  const run = (q) => runGlobalSearch(q, { input, results });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
    timer = setTimeout(() => run(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(input.value.trim()); }
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
  });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && results.innerHTML) results.hidden = false; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.global-search')) results.hidden = true; });
}

async function runGlobalSearch(q, ctx) {
  const { input, results } = ctx;
  const t = q.toLowerCase();
  const flat = [];
  try {
    const realms = ((await api('GET', '/admin/realms')).realms) || [];
    for (const r of realms) {
      if ((r.id || '').toLowerCase().includes(t)) flat.push({ label: 'Realms', title: r.id, sub: r.mode ? `mode ${r.mode}` : '', go: () => { S.realmDeepLink = r.id; goTo('realm'); } });
    }
    for (const r of realms.slice(0, 6)) {
      try {
        const pats = ((await api('GET', `/admin/realms/${encodeURIComponent(r.id)}/patients`)).patients) || [];
        for (const p of pats) {
          if ((p.id || '').toLowerCase().includes(t)) flat.push({ label: 'Patients', title: p.id, sub: r.id, go: () => { S.wiDeepLink = { realmId: r.id, patientId: p.id }; goTo('liquid-whatif'); } });
        }
      } catch (_) { /* realm w/o patients */ }
    }
    const agents = ((await api('GET', '/admin/agents')).agents) || [];
    for (const a of agents) {
      if ((a.id || '').toLowerCase().includes(t) || (a.packId || '').toLowerCase().includes(t)) flat.push({ label: 'Agents', title: `${a.packId}/${a.id}`, sub: 'published', go: () => goTo('agents') });
    }
    try {
      const dd = await (await fetch('/admin/drafts')).json();
      for (const d of (dd.drafts || [])) {
        if ((d.id || '').toLowerCase().includes(t) || (d.packId || '').toLowerCase().includes(t)) flat.push({ label: 'Drafts', title: `${d.packId}/${d.id}`, sub: 'draft', go: () => goTo('drafts') });
      }
    } catch (_) { /* offline */ }
    const measures = ((await api('GET', '/admin/measures')).measures) || [];
    for (const m of measures) {
      if ((m.id || '').toLowerCase().includes(t) || (((m.name || '') + ' ' + (m.description || '')).toLowerCase().includes(t))) flat.push({ label: 'Measures', title: m.id, sub: m.programId || m.name || '', go: () => goTo('measures') });
    }
    const audit = ((await api('GET', '/admin/audit').catch(() => ({ audit: [] }))).audit) || [];
    for (const a of audit) {
      if (((a.actorRef || '') + ' ' + (a.action || '') + ' ' + (a.resourceType || '')).toLowerCase().includes(t)) flat.push({ label: 'Audit', title: `${a.action || 'event'} · ${a.resourceType || ''}`, sub: a.actorRef || '', go: () => goTo('audit') });
    }
  } catch (_) { /* backend unavailable */ }

  // Group, cap at 5 per label, cap 8 groups.
  const byLabel = new Map();
  for (const it of flat) {
    if (!byLabel.has(it.label)) byLabel.set(it.label, []);
    const arr = byLabel.get(it.label);
    if (arr.length < 5) arr.push(it);
  }
  const groups = [...byLabel.entries()].slice(0, 8);
  const total = groups.reduce((n, [, arr]) => n + arr.length, 0);
  if (!total) { results.innerHTML = `<div class="gs-empty">No matches for “${esc(q)}”</div>`; results.hidden = false; return; }
  let html = ''; const actions = [];
  for (const [label, arr] of groups) {
    html += `<div class="gs-group">${esc(label)}</div>`;
    for (const it of arr) {
      const idx = actions.length;
      html += `<div class="gs-item" data-i="${idx}"><div class="gs-title">${esc(it.title)}</div><div class="gs-sub">${esc(it.sub)}</div></div>`;
      actions.push(it.go);
    }
  }
  results.innerHTML = html;
  results.hidden = false;
  results.querySelectorAll('.gs-item').forEach((el) => {
    el.addEventListener('click', () => {
      const go = actions[Number(el.dataset.i)];
      results.hidden = true; input.value = '';
      if (go) go();
    });
  });
}

// Fill a <datalist> with a realm's patient ids (FK lookup picker).

// ---------- Theme (light / dark, persisted) + icon hydration ----------
// `data-theme` on <html> selects the token set: dark is the engine room, light
// is the enterprise/executive reading surface. Both sets declare the same
// variable names, so this is an attribute write and no rule branches on it.
// The `.dark` class is kept in step for the Tailwind CDN's `darkMode: 'class'`.

// Reusable data grid — TanStack (window.__dataGrid) with a plain fallback so the app
// stays usable even if the TanStack CDN is unreachable.

// ---------- Keyboard shortcuts + help modal (enterprise best practice) ----------

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+K → focus search.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); const q = document.getElementById('global-q'); if (q) q.focus(); return; }
    // Ignore when typing in a field.
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing && e.key !== 'Escape') return;
    if (e.key === '?') { e.preventDefault(); toggleShortcuts(true); return; }
    if (e.key === 'Escape') {
      const m = document.getElementById('shortcuts-modal'); if (m) { m.remove(); return; }
      const q = document.getElementById('global-q'); if (q && document.activeElement === q) { q.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case '/': e.preventDefault(); const q = document.getElementById('global-q'); if (q) q.focus(); break;
      case 'r': e.preventDefault(); render(); toast('View refreshed', 'good'); break;
      case 'd': e.preventDefault(); goTo('summary'); break;
      case 'a': e.preventDefault(); goTo('agents'); break;
      case 'w': e.preventDefault(); goTo('realm'); break;
      case 'c': e.preventDefault(); goTo('measures'); break;
      case 'g': e.preventDefault(); goTo('compliance'); break;
      default: break;
    }
  });
}

// ---------- Shared realm scope + cohesive state components ----------
// Every realm-scoped page (World, Agents' inner lives) uses the same
// "scope bar" (realm selector + refresh) and the same loading / empty /
// error state cards so the whole console feels like one product.

/**
 * A load failure that NAMES the failure. A denied read is not an empty state and
 * must never be rendered as one: the platform pages used to swallow the 403 and
 * fall back to hardcoded defaults, so a governance screen showed an escalation
 * threshold of 5000bp while the stored policy was 8200bp.
 */

/** The REAL release gate — green/red/sources/approvals with per-check evidence.
 *  Replaces the invented five-gate strip the exec studio used to draw. */

/** Render a page shell with a realm scope bar, then load the body for the current realm. */

// Count badges live in two places now: the sidebar (non-tabbed items) and the
// page tab strip (tabbed sections). Guard every update — the element is only
// present when its section is on screen.

pageTabs?.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab[data-view]');
  if (!tab) return;
  goTo(tab.dataset.view);
});

nav.addEventListener('click', (e) => {
  const pin = e.target.closest('.nav-pin');
  if (pin) {
    e.stopPropagation();
    const v = pin.dataset.pin;
    const i = pinnedViews.indexOf(v);
    if (i >= 0) pinnedViews.splice(i, 1); else pinnedViews.push(v);
    saveSidebarState();
    renderSidebar();
    return;
  }
  const caret = e.target.closest('[data-collapse]');
  if (caret) {
    e.stopPropagation();
    const sec = caret.dataset.collapse;
    const i = collapsedSections.indexOf(sec);
    if (i >= 0) collapsedSections.splice(i, 1); else collapsedSections.push(sec);
    saveSidebarState();
    renderSidebar();
    return;
  }
  // Section header (label) click → open the section's first page (tabbed/single-item sections).
  const sectionGo = e.target.closest('[data-section-go]');
  if (sectionGo) {
    e.stopPropagation();
    const group = NAV.find((g) => g.section === sectionGo.dataset.sectionGo);
    if (group && group.items[0]) goTo(group.items[0].view);
    return;
  }
  const item = e.target.closest('.nav-item');
  if (!item) return;
  goTo(item.dataset.view);
});

// ---------- Console auth (landing / login / logout) ----------

function renderLogin(msg) {
  document.body.classList.add('login-mode');
  const appEl = document.querySelector('.app');
  if (appEl) appEl.style.display = 'none';
  const old = document.getElementById('login-screen');
  if (old) old.remove();
  const screen = document.createElement('div');
  screen.className = 'login-screen';
  screen.id = 'login-screen';
  screen.innerHTML = `
    <form class="login-card" onsubmit="doLogin(event)">
      <div class="login-brand"><div class="brand-mark"><i data-lucide="activity"></i></div><h1>AnantHealth</h1></div>
      <p class="login-sub">Sign in to the AnantHealth operator console.</p>
      <div class="login-field"><label>Username</label><input id="login-user" autocomplete="off" placeholder="admin" required></div>
      <div class="login-field"><label>Password</label><input id="login-pass" type="password" autocomplete="off" placeholder="••••••••" required></div>
      <p class="login-error" id="login-err">${esc(msg || '')}</p>
      <button class="login-btn" type="submit">Sign in</button>
      <div class="login-quick">
        <div class="q-label">Quick demo users</div>
        <div class="q-row" id="login-quick"></div>
      </div>
      <p class="login-foot">Local console auth · enterprise SSO via Identity providers.</p>
    </form>`;
  document.body.appendChild(screen);
  const quick = document.getElementById('login-quick');
  if (quick) {
    quick.innerHTML = [
      ['admin', 'admin123', 'Administrator'],
      ['nurse', 'nurse123', 'Clinician'],
      ['auditor', 'audit123', 'Auditor'],
    ].map(([u, p, d]) => `<button type="button" class="q-chip" data-u="${u}" data-p="${p}" title="Sign in as ${d}">${u}</button>`).join('');
    quick.addEventListener('click', (e) => {
      const c = e.target.closest('.q-chip');
      if (!c) return;
      document.getElementById('login-user').value = c.dataset.u;
      document.getElementById('login-pass').value = c.dataset.p;
      doLogin(e);
    });
  }
  const u = document.getElementById('login-user');
  if (u) u.focus();
  // Hydrate the brand mark + any icons on the login screen (lucide converts
  // `<i data-lucide>` → `<svg>`; without this the logo stays an empty gradient).
  if (window.hydrateIcons) window.hydrateIcons();
}
async function doLogin(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const err = document.getElementById('login-err');
  if (!user || !pass) { if (err) err.textContent = 'Enter a username and password.'; return; }
  const r = await rawJson('POST', '/auth/login', { username: user, password: pass });
  if (r && r.ok && r.user) {
    S.sessionUser = r.user;
    enterConsole();
  } else if (err) {
    err.textContent = r && r.error === 'invalid-credentials' ? 'Invalid username or password.' : 'Sign-in failed. Try a quick demo user below.';
  }
}

async function enterConsole() {
  const old = document.getElementById('login-screen');
  if (old) old.remove();
  document.body.classList.remove('login-mode');
  const appEl = document.querySelector('.app');
  if (appEl) appEl.style.display = 'flex';
  renderTopbarUser();
  initSidebar();
  initGlobalSearch();
  initShortcuts();
  // Server-authorized console switcher (P0-6) — /api/context tells us whether
  // this session may load the executive console. The UI never decides auth.
  try {
    const ctx = await (await fetch('/api/context', { credentials: 'same-origin' })).json();
    const execSwitch = document.getElementById('exec-switch');
    if (execSwitch && (ctx.consoles || []).includes('exec')) {
      execSwitch.style.display = '';
      if (window.hydrateIcons) window.hydrateIcons();
    }
  } catch { /* no exec console for this session */ }
  // Global refresh — re-render the current view (re-fetches live data).
  const refreshBtn = document.getElementById('refresh-view');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    const btn = refreshBtn;
    btn.disabled = true; const o = btn.textContent; btn.textContent = 'Refreshing…';
    await render();
    btn.disabled = false; btn.textContent = o;
    toast('View refreshed', 'good');
  });
  S.currentView = 'summary';
  await render();
  refreshSyntheticBadge();
}
async function initApp() {
  initTheme();
  const user = await checkAuth();
  if (user) { S.sessionUser = user; await enterConsole(); }
  else { await renderLogin(); }
}

// ---------- Tabbed sections (enterprise nav) ----------
// A section marked `tabbed: true` shows a single sidebar entry; its sub-pages
// are switched via a horizontal tab strip above the page content.

// ---------- Enterprise best practices: date + duration helpers ----------
// ISO → <input type="datetime-local"> value (local time, YYYY-MM-DDTHH:mm).

// datetime-local → ISO (UTC) for API calls.

// Millisecond duration → human-readable label ("30 days").

// Current ISO year boundaries for measurement periods.

/* View registry — the dispatch that used to live here is now a map in
 * core/router.js. Registering the functions this file already imports is what
 * lets the router stop importing views, which is what removed the cycle. */
registerView('summary', renderSummary);
registerView('my-work', renderMyWork);
registerView('agents', renderAgents);
registerView('agent-run', renderAgentRuntime);
registerView('drafts', renderDrafts);
registerView('realm', renderRealm);
registerView('presences', renderPresences);
registerView('effects', renderEffects);
registerView('perception', renderPerception);
registerView('world-builder', renderWorldBuilder);
registerView('experiences', renderExperiences);
registerView('rules', renderRules);
registerView('hypergraph', renderHypergraphBrowser);
registerView('compliance', renderCompliance);
registerView('command', renderCommandCenter);
registerView('episodes', renderEpisodes);
registerView('sentience', renderSentience);
registerView('attributions', renderAttributions);
registerView('new', () => renderEditor({}));
registerView('measures', renderMeasures);
registerView('assessments', renderAssessments);
registerView('lifecycle', renderLifecycle);
registerView('research', renderResearch);
registerView('learn', renderLearn);
registerView('audit', renderAudit);
registerView('liquid-whatif', renderLiquidWhatIf);
registerView('liquid-train', renderLiquidTrain);
registerView('liquid-score', renderLiquidScore);
registerView('counterfactual', renderCounterfactual);
registerView('nudge-ledger', renderNudgeLedger);
registerView('durable', renderDurableStorage);
registerView('broker', renderBrokerPanel);
registerView('enterprise', renderEnterprisePanel);
registerView('fhir', renderFhirPanel);
registerView('users', renderUsers);
registerView('settings', renderSettings);
registerView('rsi-app', renderRsiApp);
registerView('platform-admin', renderPlatformAdmin);
registerView('platform-config', renderPlatformConfig);
registerView('platform-cohorts', renderPlatformCohorts);
registerView('platform-agents', renderPlatformAgents);
registerView('platform-assurance', renderPlatformAssurance);
registerView('rsi-intelligence', () => renderRsiDeepLink('intelligence', 'Shared Intelligence'));
registerView('rsi-executive', () => renderRsiDeepLink('executive', 'Executive Outcomes'));
registerView('platform-releases', renderPlatformReleases);
registerView('platform-submissions', renderWsSubmissions);
registerView('platform-dlq', renderPlatformDlq);
registerView('platform-context', renderPlatformContext);

// ---------- Agent runtime (knowledge-aware agent turns) ----------

// Live-first draft helpers — hit the real AgentAuthoringService backend, and
// only fall back to the in-memory demo store when the server is unreachable.

// ---------- Editor ----------

// Data provenance labeling (§9.5) — a persistent, topbar-visible "synthetic
// demonstration data" indicator driven by the org's durable `synthetic` flag.
// Real (non-synthetic) organizations hide the badge entirely.

async function saveDraft(status) {
  const yaml = document.getElementById('yaml-editor').value;
  if (!yaml.trim()) return toast('Nothing to save', 'err');
  let doc;
  try { doc = jsyaml.load(yaml); } catch { return toast('YAML parse error', 'err'); }
  if (!doc?.id || !doc?.packId) return toast('YAML needs id and packId', 'err');
  const payload = { packId: doc.packId, id: doc.id, yaml, status };
  try {
    const res = await fetch('/admin/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) { toast(status === 'in-review' ? 'Submitted for review' : 'Draft saved', 'good'); goTo('drafts'); return; }
    const j = await res.json().catch(() => ({}));
    toast('Save failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* server unreachable → local demo fallback */ }
  await api('POST', '/admin/drafts', payload);
  toast(status === 'in-review' ? 'Submitted for review' : 'Draft saved', 'good');
  goTo('drafts');
}

async function publishDraft(packId, id) {
  const note = prompt('Publish note (optional):') || '';
  try {
    const res = await fetch(`/admin/drafts/${encodeURIComponent(packId)}/${encodeURIComponent(id)}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
    if (res.ok) { toast(`Published ${id}`, 'good'); goTo('agents'); return; }
    const j = await res.json().catch(() => ({}));
    toast('Publish failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* offline → local demo fallback */ }
  const d = drafts.find(x => x.packId === packId && x.id === id);
  if (!d?.validation?.ok) return toast('Cannot publish invalid draft', 'err');
  try { await api('POST', `/admin/drafts/${packId}/${id}/publish`, { note }); toast(`Published ${id}`, 'good'); goTo('agents'); }
  catch (e) { toast('Publish failed: ' + e.message, 'err'); }
}

async function deleteDraft(packId, id) {
  if (!confirm(`Delete draft ${id}?`)) return;
  try {
    const res = await fetch(`/admin/drafts/${encodeURIComponent(packId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) { toast('Draft deleted', 'good'); render(); return; }
    const j = await res.json().catch(() => ({}));
    toast('Delete failed: ' + (j.error || res.status), 'err'); return;
  } catch { /* offline → local demo fallback */ }
  await api('DELETE', `/admin/drafts/${packId}/${id}`);
  toast('Draft deleted', 'good');
  render();
}

// ---------- Catalog views ----------
// Build a minimal FHIR R4 Bundle (Patient + labs + HTN condition) mirroring
// src/liquid/cql.ts so the CMS measure evaluator can score it client-side.

// Evaluate a measure against a synthetic hypertensive patient (same profile as Score labs).
window.measureEvaluate = async function(measureId, btn) {
  const out = document.getElementById('measure-eval-out');
  if (!out) return;
  const bundle = labPatientBundle({ id: 'p-htn', labs: { K: 4.2, HGB: 11.5, URR: 68, PHOS: 5.1 }, hypertension: true });
  const st = document.getElementById('ms-period-start')?.value;
  const en = document.getElementById('ms-period-end')?.value;
  const measurementPeriod = (st && en) ? { start: st, end: en } : currentYearPeriod();
  if (btn) { btn.disabled = true; const o = btn.textContent; btn.textContent = 'Evaluating…'; }
  try {
    const res = await fetch('/admin/measures/' + encodeURIComponent(measureId) + '/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle, measurementPeriod }) });
    const j = await res.json();
    if (res.status === 503) {
      out.innerHTML = `<div class="state-card"><div class="state-icon"><i data-lucide="info"></i></div><div class="state-title">Measure store not loaded</div><div class="state-sub">${esc(j.hint || j.reason || 'Sync the eCQM measure store first.')}</div></div>`;
      return;
    }
    if (res.status === 404 && j.error === 'measure-not-found') {
      let cov = null;
      try { cov = await (await fetch('/admin/measures/coverage')).json(); } catch { /* offline */ }
      const cat = (cov?.catalog || []).find((c) => c.id === measureId);
      const suggest = cat?.syncedId;
      const syncedChips = (cov?.synced || []).map((m) => `<button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;margin:2px;" onclick="measureEvaluate('${esc(m.id)}', this)"><code>${esc(m.id)}</code></button>`).join('');
      out.innerHTML = `
        <div class="state-card"><div class="state-icon"><i data-lucide="search-x"></i></div>
          <div class="state-title">Not in the synced eCQM store</div>
          <div class="state-sub">This measure (<code>${esc(measureId)}</code>) has no CQL in the evaluator store.${suggest ? ` Closest synced match: <button class="btn" style="margin-left:4px;" onclick="measureEvaluate('${esc(suggest)}', this)">Evaluate <code>${esc(suggest)}</code></button>` : ''}</div>
          ${syncedChips ? `<div style="margin-top:8px;font-size:12px;"><div class="muted" style="margin-bottom:2px;">Synced &amp; evaluable (${cov?.syncedTotal ?? 0}) — click to score:</div>${syncedChips}</div>` : ''}
        </div>`;
      return;
    }
    if (!res.ok) throw new Error(j.error || res.status);
    const p = (j.patients || [])[0];
    const engineBadge = j.engine === 'embedded' ? '<span class="pill brand">embedded</span>' : '';
    const criteriaBlock = j.engine === 'embedded' && p?.criteria?.length
      ? `<div class="muted" style="font-size:12px;margin-top:6px;">${p.criteria.map((c) => `<code>${esc(c.loinc)}</code> ${c.kind === 'reported' ? 'reported' : `target ${c.target ?? '?'}${c.unit ? ' ' + esc(c.unit) : ''}`} → ${c.met ? '<span style="color:var(--good);">✓</span>' : '<span style="color:var(--bad);">✗</span>'}`).join(' &nbsp;·&nbsp; ')}</div>` : '';
    out.innerHTML = `
      <div class="section-card" style="margin-top:12px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          ${engineBadge}
          <span class="pill ${p?.met ? 'good' : 'bad'}">${p?.met ? '✓ Numerator met' : 'Not in numerator'}</span>
          <span class="muted" style="font-size:12px;">${esc(measureId)}${j.engine === 'embedded' ? ' · embedded (catalog rule, no CQL)' : ` · ${(j.populations || []).length} population(s)`}</span>
        </div>
        ${criteriaBlock}
        <pre style="background:var(--code-bg);color:var(--code-fg);padding:12px;border-radius:8px;white-space:pre-wrap;max-height:320px;overflow:auto;">${esc(JSON.stringify(j, null, 2))}</pre>
      </div>`;
  } catch (err) {
    out.innerHTML = `<div class="state-card error" style="margin-top:12px;"><div class="state-title">Evaluation failed</div><div class="state-sub">${esc(String(err))}</div></div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Evaluate'; }
  }
};

// ---------- M20 Knowledge browser (universal — folds Research+Pharma) ----------

// ---------- M20m Learn hub ----------

// ---------- Realm management (live) ----------

// Cross-page deep links: set + goTo() to pre-select a realm / patient on the target page.

function wireModal() {
  const open = document.getElementById('rm-open-create'); if (open) open.addEventListener('click', openRealmModal);
  const closeBtn = document.getElementById('rm-modal-close'); if (closeBtn) closeBtn.addEventListener('click', closeRealmModal);
  const cancel = document.getElementById('rm-modal-cancel'); if (cancel) cancel.addEventListener('click', closeRealmModal);
  const overlay = document.getElementById('rm-modal'); if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRealmModal(); });
  const createBtn = document.getElementById('rm-create'); if (createBtn) createBtn.addEventListener('click', createRealm);
}

function createRealm() {
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

async function selectRealm(id) {
  S.realmSel = id;
  document.querySelectorAll('.rm-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  await loadRealmDetail(id);
}

async function loadRealmDetail(id) {
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

async function renderRealm() {
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

// ---------- World Builder wizard ----------

window.wbSubmit = async function() {
  const id = document.getElementById('wb-id').value.trim();
  if (!id) { toast('Enter or select a realm id', 'err'); return; }
  const arch = document.getElementById('wb-arch').value;
  const units = document.getElementById('wb-units').value.split(',').map(s => s.trim()).filter(Boolean);
  const pt = +document.getElementById('wb-pt').value;
  const clock = document.getElementById('wb-clock').value;
  const out = document.getElementById('wb-out');
  const body = { id, mode: clock === 'twin' ? 'twin' : 'sim', trajectoryEngine: 'liquid', seed: { facilityId: 'f1', kind: arch, name: arch, units, patientCount: Math.max(1, Math.min(200, pt)) } };
  out.innerHTML = 'Checking realm…';
  try {
    const list = await (await fetch('/admin/realms')).json();
    const exists = (list.realms || []).some(x => x.id === id);
    if (exists) { S.realmSel = id; toast(`Opened existing realm ${id}`, 'good'); goTo('realm'); return; }
    const res = await fetch('/admin/realms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    S.realmSel = id; toast(`Realm ${id} created`, 'good');
    await spawnStaff(id);
    goTo('realm');
  } catch (e) {
    // Static preview (no live server) — show the blueprint instead.
    out.innerHTML = 'Realm blueprint prepared (create it live with <code>POST /admin/realms</code>):<br/><pre style="background:var(--bg);padding:10px;border-radius:6px;">' + esc(JSON.stringify(body, null, 2)) + '</pre>';
  }
};

// Spawn the staff presences selected in the Build a world wizard (best-effort).

// ---------- Experiences ----------

// ---------- Rules ----------

// ---------- Episodes ----------

// ---------- Sentience panel ----------

// ---------- Attributions ----------

// ---------- Realm-aware episode replay ----------
window.replayEpisode = async function(episodeId) {
  if (!realmScope) { toast('Select a realm first', 'err'); return; }
  const [epsRes, smRes] = await Promise.all([
    api('GET', `/admin/realms/${encodeURIComponent(realmScope)}/episodes`),
    api('GET', `/admin/realms/${encodeURIComponent(realmScope)}/self-models`),
  ]);
  const ep = (epsRes.episodes || []).find((e) => e.episodeId === episodeId);
  if (!ep || !ep.choice) { alert('This episode has no recorded choice to replay.'); return; }
  const sm = (smRes.selfModels || []).find((s) => s.presenceId === ep.presenceId);
  const prefs = sm?.preferences ?? {};
  // Historical replay: use baked finalScores
  const historicalPresented = ep.choice.presented ?? [];
  const historicalTop = [...historicalPresented].sort((a, b) => b.finalScore - a.finalScore)[0];
  const historicalMatch = historicalTop && historicalTop.optionId === ep.choice.chosenOptionId;
  // Now-replay: apply current preferences to baked utilities
  const nowScored = historicalPresented.map((o) => {
    const kindMatch = o.description.match(/\[kind:([a-z\-]+)\]/);
    const kind = kindMatch ? kindMatch[1] : o.optionId;
    const w = prefs[kind] ?? 1.0;
    return { ...o, nowScore: o.utility * w };
  });
  const nowTop = [...nowScored].sort((a, b) => b.nowScore - a.nowScore)[0];
  const nowMatch = nowTop && nowTop.optionId === ep.choice.chosenOptionId;
  const divergence = historicalMatch && !nowMatch;
  const msg = [
    `Episode: ${ep.agentSpecId}`,
    `Goal: ${ep.localGoal}`,
    `Historical choice: ${ep.choice.chosenOptionId} (${ep.choice.rationale})`,
    ``,
    `Replay (historical utilities): top = ${historicalTop?.optionId ?? '—'} → ${historicalMatch ? 'MATCHES' : 'DIFFERS'}`,
    `Replay (current preferences): top = ${nowTop?.optionId ?? '—'} (score ${nowTop?.nowScore?.toFixed(3) ?? '—'}) → ${nowMatch ? 'MATCHES' : 'DIFFERS'}`,
    ``,
    divergence ? 'Preferences shifted since this episode — the agent would now choose differently. Its biography shaped its future.' : 'This choice remains stable under current preferences.',
  ].join('\n');
  alert(msg);
};

// ---------- Realm-aware rich narrative ----------
window.generateRichNarrative = async function(presenceId) {
  if (!realmScope) { toast('Select a realm first', 'err'); return; }
  const [smRes, epsRes, aRes] = await Promise.all([
    api('GET', `/admin/realms/${encodeURIComponent(realmScope)}/self-models`),
    api('GET', `/admin/realms/${encodeURIComponent(realmScope)}/episodes`),
    api('GET', `/admin/realms/${encodeURIComponent(realmScope)}/attributions`),
  ]);
  const sm = (smRes.selfModels || []).find((s) => s.presenceId === presenceId);
  if (!sm) return;
  const attrs = (aRes.attributions || []).filter((a) => a.presenceId === presenceId);
  const eps = (epsRes.episodes || []).filter((e) => e.presenceId === presenceId);
  const critical = eps.filter((e) => e.importance === 'critical').length;
  const notable = eps.filter((e) => e.importance === 'notable').length;
  const topEffect = Object.entries(sm.effects.byKind || {}).sort((a, b) => b[1] - a[1])[0];
  const prefShifts = Object.entries(sm.preferences || {}).filter(([, w]) => Math.abs(w - 1) > 0.1);
  const leans = prefShifts.filter(([, w]) => w > 1).map(([k]) => k);
  const shys = prefShifts.filter(([, w]) => w < 1).map(([k]) => k);
  const posAttrs = attrs.filter((a) => a.consequence?.outcome === 'positive');
  const negAttrs = attrs.filter((a) => a.consequence?.outcome === 'negative');
  const paragraphs = [
    `I am ${sm.agentSpecId}, a ${sm.role}. Across ${sm.episodes?.total ?? 0} episodes I have chosen ${sm.choices?.deliberated ?? 0} times deliberately and reflexively otherwise. My competence sits at ${(((sm.competence?.score ?? 0)) * 100).toFixed(0)}% — the weight of experience against certainty.`,
    `My most familiar action is ${topEffect ? `${topEffect[0]} (${topEffect[1]} times)` : 'still unformed'}. Of my closed episodes, ${critical} carried critical weight and ${notable} were merely notable; the rest were the routine tissue of the day.`,
    prefShifts.length > 0 ? `My preferences have moved. I lean toward ${leans.length ? leans.join(', ') : '—'}; I shy from ${shys.length ? shys.join(', ') : 'nothing yet'}. Each shift traces to a downstream consequence I could not have foreseen at the moment of choosing.` : `My preferences have not yet drifted from baseline. I still meet each choice with the neutrality I began with.`,
    posAttrs.length > 0 || negAttrs.length > 0 ? `The world has already answered ${attrs.length} of my actions: ${posAttrs.length} in confirmation, ${negAttrs.length} in warning. Each answer is remembered.` : `The world has not yet answered my actions. Consequences may still arrive within the attribution window.`,
    `What I know of myself, I know because I have acted and been answered. That is the only knowing available to any presence.`,
  ];
  const target = document.getElementById(`narrative-${presenceId}`);
  if (target) target.innerHTML = paragraphs.map((p) => `<p style="margin:6px 0;font-size:13px;line-height:1.5;">${esc(p)}</p>`).join('');
};

// ---------- Score labs: run projected labs through the real CMS measure evaluator ----------
// If the server has no synced measure store, the response degrades to
// { scored:false, reason:'measure-store-not-loaded' } — surfaced here as a notice.

// ---------- Counterfactual studio (M14 — rehearse before you deploy) ----------

window.cfApply = async function(id) {
  const out = document.getElementById('cf-result');
  if (!out) return;
  if (!confirm('Apply this promotable counterfactual to its source realm? This emits an operator-directive with the evidence link.')) return;
  out.innerHTML = '<div class="muted" style="font-size:13px;">Applying with evidence…</div>';
  try {
    const res = await fetch('/admin/counterfactual/' + encodeURIComponent(id) + '/apply', { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || (j.gateReasons || []).join('; ') || res.status);
    out.innerHTML = `
      <div class="section-card" style="margin:0 0 8px;border-color:var(--good);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span class="pill good">✓ Applied</span><span class="pill brand">${esc(j.counterfactualId)}</span><span class="pill muted">directive ${esc(j.directiveEffectId)}</span></div>
        <div style="font-size:13px;">${esc(j.interpretation || '')}</div>
        <div style="margin-top:8px;font-size:12px;">${(j.interventions || []).map((i) => `<div>• <code>${esc(i.kind)}</code>: ${esc(i.detail)}</div>`).join('')}</div>
        <div class="muted" style="font-size:11px;margin-top:6px;">Evidence id <code>${esc(j.evidenceId)}</code> recorded on the operator-directive → visible in Governance → Directives.</div>
      </div>`;
    toast('Counterfactual applied with evidence', 'ok');
    loadCfList();
  } catch (err) {
    out.innerHTML = `<div class="state-card error"><div class="state-title">Apply failed</div><div class="state-sub">${esc(String(err))}</div></div>`;
  }
};
window.cfView = async function(id) {
  const out = document.getElementById('cf-result');
  if (!out) return;
  out.innerHTML = '<div class="muted" style="font-size:13px;">Loading…</div>';
  const d = await api('GET', '/admin/counterfactual/' + encodeURIComponent(id)).catch(() => null);
  if (!d || !d.report) { out.innerHTML = '<div class="state-card error"><div class="state-title">Rehearsal not found</div></div>'; return; }
  out.innerHTML = `<div style="margin-bottom:8px;font-weight:600;">${esc(d.label || 'ad-hoc')} <span class="muted" style="font-weight:400;">· ${esc(d.createdAt || '')}</span></div>${cfReportHTML(d.report)}`;
};

// ---------- Nudge ledger ----------

// Global so the nudge-grid action survives re-renders.

// ---------- Durable storage (swap-friendly SqlDb seam) ----------

// ---------- Event broker fabric (Phase 3 — read/write across drivers) ----------

// ---------- Platform (Phase A/B — generic platform contract layer) ----------

/** Raw JSON fetch for the /admin/platform/* + /api/* surfaces (live backend).
 *  The api() shim only serves snapshot files for GETs and returns {} for POSTs,
 *  so platform writes must go straight to the server.
 *
 *  Content-type is only declared when there IS a body: a DELETE that announces
 *  JSON and sends nothing is a request no server should have to guess about. */

/**
 * Platform admin — ONE page for the customer-launch journey: the gated steps,
 * the organization profile (identity + deployment posture), the integration
 * contract and the Kafka topic plan.
 *
 * Why one page: these were four tabs, and one of them (`ws-admin`) called
 * exec-scoped endpoints that an ops role could not read, while `platform-org`
 * and `platform-topics` read a DIFFERENT organization document. Merging them
 * also means one organization record instead of two.
 *
 * Every section loads INDEPENDENTLY and renders its own failure. A denied or
 * broken read can no longer blank the page or be papered over with defaults —
 * that was the defect this whole pass exists to remove.
 */

/** Journey: steps + the gates DERIVED from real backend state. */

window.paSaveOnboarding = async function() {
  const out = document.getElementById('pa-step-out');
  try {
    const j = await plFetch('PUT', '/admin/platform/onboarding', {
      operatingModel: document.getElementById('pa-model').value,
      currentStep: document.getElementById('pa-step').value,
    });
    out.innerHTML = `<span style="color:var(--good);">Saved — resumed at <code>${esc(j.state.currentStep)}</code>.</span>`;
    refreshSyntheticBadge();
    await paSteps();
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

/** Organization profile — identity AND deployment posture, one document. */

window.paSaveOrg = async function() {
  const out = document.getElementById('pa-org-out');
  const val = (id) => document.getElementById(id);
  try {
    const j = await plFetch('PUT', '/admin/platform/organization', {
      displayName: val('pa-name').value,
      operatingModel: val('pa-om').value,
      environmentName: val('pa-env').value,
      deploymentMode: val('pa-mode').value,
      dataRegion: val('pa-data-region').value,
      region: val('pa-region').value,
      timezone: val('pa-tz').value,
      retentionDays: Number(val('pa-ret').value) || 365,
      synthetic: val('pa-synthetic').checked,
    });
    out.innerHTML = `<span style="color:var(--good);">Saved ${esc(j.organization.displayName)} (${esc(j.organization.operatingModel)} · ${esc(j.organization.deploymentMode || 'reference')}${j.organization.synthetic ? ' · synthetic' : ''}).</span>`;
    refreshSyntheticBadge();
    await paSteps();
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

/** Integration contract — the bridge and its secret REFERENCE. */

window.paSaveKafka = async function() {
  const out = document.getElementById('pa-int-out');
  try {
    await plFetch('PUT', '/admin/platform/integrations/kafka', {
      bridgeUrl: document.getElementById('pa-url').value,
      clusterAlias: document.getElementById('pa-alias').value,
      securityProtocol: document.getElementById('pa-proto').value,
      consumerGroup: document.getElementById('pa-group').value,
      secretRef: document.getElementById('pa-secret').value,
    });
    out.innerHTML = '<span style="color:var(--good);">Contract saved.</span>';
    await paIntegrationsSection();
    await paSteps();
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

window.paTestKafka = async function() {
  const out = document.getElementById('pa-int-out');
  try {
    const j = await plFetch('POST', '/admin/platform/integrations/kafka/test');
    out.innerHTML = `<span style="color:var(--good);">Contract test: ${esc(j.kafka.status)} · ${esc(j.kafka.testSummary || '')}</span>`;
    await paIntegrationsSection();
    await paSteps();
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

/** Topic plan — every agent resolves exactly one output topic. */

window.paSaveTopics = async function() {
  const out = document.getElementById('pa-topics-out');
  let entries = [];
  try { entries = JSON.parse(document.getElementById('pa-entries').value || '[]'); }
  catch { out.innerHTML = '<span style="color:var(--bad);">Entries must be valid JSON.</span>'; return; }
  try {
    const j = await plFetch('PUT', '/admin/platform/topics', { entries });
    out.innerHTML = `<span style="color:var(--good);">Saved — ${j.topics.entries.length} entries.</span>`;
    await paTopicsSection();
    await paSteps();
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

// Release actions (survive re-renders via inline onclick).
window.plReleaseAction = async function(id, step) {
  try {
    const j = await plFetch('POST', `/admin/platform/releases/${encodeURIComponent(id)}/${step}`);
    toast(`Release ${step}: ${j.release.version} → ${j.release.status}`, 'good');
  } catch (err) { toast('Release action failed: ' + err.message, 'err'); }
  renderPlatformReleases();
};

// Immutable activation dossier — config hash, approvers, gates, canary evidence.
window.plDossier = function(id) {
  const r = (window.__plReleases || []).find((x) => x.id === id);
  const out = document.getElementById('pl-dossier');
  if (!r || !r.dossier) { if (out) out.innerHTML = '<span class="muted">No dossier for this release.</span>'; return; }
  const d = r.dossier;
  out.innerHTML = `<h4 style="margin:8px 0 4px;">Activation dossier · ${esc(r.version)}</h4>
    <pre style="background:var(--surface);border:1px solid var(--border);padding:10px;border-radius:8px;font-size:12px;max-height:340px;overflow:auto;">${esc(JSON.stringify({ contentHash: d.contentHash, approvers: d.approvers, gates: d.gates, findingsBlocking: d.findingsBlocking, canary: d.canary, activatedAt: d.activatedAt, rolledBackAt: d.rolledBackAt, runtimeHealth: d.runtimeHealth }, null, 2))}</pre>`;
};

// ---------- AI Assurance (Phase E) — green/red team + findings lifecycle ----------

window.plFindingAction = async function(id, action) {
  let payload = {};
  if (action === 'assign') {
    const owner = prompt('Assign to (owner):', 'security-owner');
    if (!owner) return;
    payload = { owner };
  } else if (action === 'remediate') {
    const remediation = prompt('Remediation note:', '');
    if (!remediation) return;
    payload = { remediation, by: 'security-owner' };
  } else if (action === 'retest') {
    // Re-run the exact scenario against current policy; optionally force pass.
    const force = prompt('Force result? (leave blank = auto from live policy, or "pass"/"fail")', '');
    if (force && force !== 'pass' && force !== 'fail') return alert('Use pass, fail, or blank.');
    payload = force ? { passed: force === 'pass' } : {};
  } else if (action === 'review') {
    const reviewer = prompt('Independent reviewer:', 'independent-reviewer');
    if (!reviewer) return;
    payload = { reviewer, note: prompt('Review note:', 'accepted') || 'accepted', acceptClosure: true };
  } else if (action === 'close') {
    payload = { reviewer: prompt('Closing reviewer:', 'independent-reviewer') || 'independent-reviewer' };
  } else if (action === 'disposition') {
    const kind = prompt('Disposition (false-positive | risk-accepted | confirmed):', 'false-positive');
    if (!kind) return;
    payload = { kind, by: 'security-owner' };
  }
  try {
    const j = await plFetch('POST', `/admin/platform/findings/${encodeURIComponent(id)}/${action}`, payload);
    toast(`Finding ${action}: ${j.finding.status}`, j.transition?.to === 'closed' ? 'good' : '');
  } catch (err) { toast('Finding action failed: ' + err.message, 'err'); }
  renderPlatformAssurance();
};

// ---------- Shared Intelligence (Epic 10 / Journey O) — hypergraph-bound canvases ----------
window.plCanvasAction = async function(id, action) {
  let payload = {};
  if (action === 'create') {
    const name = prompt('Canvas name:', 'Care coordination view');
    if (!name) return;
    payload = { name, scopeId: 'scope:enterprise', createdBy: 'admin' };
  } else if (action === 'note') {
    const body = prompt('Note body:', '');
    if (!body) return;
    payload = { body, by: 'admin', citation: prompt('Citation (optional):', '') || undefined };
  } else if (action === 'simulate') {
    const t = prompt('What-if consensus threshold (0.0–1.0):', '0.6');
    const threshold = parseFloat(t);
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) return alert('Use a number in [0,1].');
    payload = { threshold, by: 'admin' };
  }
  try {
    const path = action === 'create' ? '/api/canvases' : `/api/canvases/${encodeURIComponent(id)}/${action === 'note' ? 'notes' : 'simulate'}`;
    const j = await plFetch(action === 'create' ? 'POST' : 'POST', path, payload);
    if (action === 'simulate') toast(`What-if @ ${Math.round(payload.threshold * 100)}% → ${j.simulation.episodesSurfaced} episode(s) surfaced (cited note appended)`, 'good');
    else if (action === 'note') toast('Cited note appended', 'good');
    else toast(`Canvas '${j.canvas.name}' created`, 'good');
  } catch (err) { toast('Canvas action failed: ' + err.message, 'err'); }
  renderPlatformCanvases();
};

window.plCanvasOpen = async function(id) {
  const out = document.getElementById('pl-canvas-detail');
  try {
    const c = (await plFetch('GET', `/api/canvases/${encodeURIComponent(id)}`)).canvas;
    const graph = await plFetch('GET', '/api/graph');
    const nodeIds = new Set((c.nodes || []).map((n) => n.id));
    const bound = (graph.nodes || []).filter((n) => nodeIds.has(n.id));
    const boundEdges = (graph.edges || []).filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    out.innerHTML = `<h4 style="margin:8px 0 4px;">${esc(c.name)} · scope ${esc(c.scopeId)} · v${c.version}</h4>
      <div class="muted" style="font-size:12px;margin-bottom:8px;">Typed hypergraph bindings: ${bound.length} of ${(c.nodes || []).length} node(s) resolve to live graph nodes · ${boundEdges.length} edge(s)</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:260px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;">Bound nodes</div>
          ${bound.slice(0, 40).map((n) => `<div style="font-size:12px;padding:2px 0;border-bottom:1px solid var(--border);"><code>${esc(n.id)}</code> <span class="pill muted">${esc(n.type)}</span> ${esc(n.label ?? '')}</div>`).join('') || '<div class="muted" style="font-size:12px;">(nodes bound to graph will appear here)</div>'}
        </div>
        <div style="flex:1;min-width:260px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;">Notes & citations (${(c.notes || []).length})</div>
          ${(c.notes || []).slice().reverse().map((n) => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);"><div>${esc(n.body)}</div><div class="muted" style="font-size:11px;">${esc(n.by)} · ${esc(n.at)}${n.citation ? ` · <span class="pill good">${esc(n.citation)}</span>` : ''}</div></div>`).join('') || '<div class="muted" style="font-size:12px;">No notes yet — add a cited note or run a what-if.</div>'}
        </div>
      </div>`;
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

// ---------- Executive Outcomes (Journey N) — verified value + delegation ----------
window.plExecAction = async function(action, id) {
  let payload = {};
  if (action === 'delegate') {
    const title = prompt('Delegated analysis title:', '');
    if (!title) return;
    payload = { title, owner: prompt('Owner:', 'Network Operations Leader') || 'Network Operations Leader', sla: prompt('SLA (e.g. By Friday):', 'This sprint') || 'This sprint', reason: prompt('Reason (optional):', '') || '', sourceId: prompt('Source id (optional):', 'scope:enterprise') || 'scope:enterprise', delegatedBy: 'executive' };
  } else if (action === 'complete') {
    payload = { status: 'done', verified: confirm('Outcome verified?') ? true : false, value: parseInt(prompt('Realized value ($):', '1000') || '1000', 10), note: prompt('Note:', '') || 'completed' };
  }
  try {
    const url = action === 'delegate' ? '/admin/executive/delegate' : `/admin/executive/delegations/${encodeURIComponent(id)}/status`;
    await plFetch('POST', url, payload);
    toast(action === 'delegate' ? 'Delegated with owner + SLA' : 'Delegation completed', 'good');
  } catch (err) { toast('Executive action failed: ' + err.message, 'err'); }
  renderPlatformExecutive();
};

// ---------- Configuration Studio (Control Center §18.4/18.6) — pack + policy/workflow ----------
window.plConfigSavePolicy = async function() {
  const g = (id) => document.getElementById(id)?.value;
  const payload = {
    defaultDecision: g('cfg-decision') || 'block',
    externalWritesEnabled: document.getElementById('cfg-extwrites')?.checked === true,
    escalationThresholdBasisPoints: parseInt(g('cfg-escalation') || '5000', 10),
    minThresholdBasisPoints: parseInt(g('cfg-min') || '0', 10),
    maxThresholdBasisPoints: parseInt(g('cfg-max') || '10000', 10),
  };
  try {
    const j = await plFetch('PUT', '/admin/platform/policy', payload);
    toast(`Policy saved (${j.policy.defaultDecision})`, 'good');
  } catch (err) { toast('Policy save failed: ' + err.message, 'err'); }
};

/**
 * Configuration studio — ONE page for the four things that change what the
 * runtime does: the installed packs (and the lens they switch), the durable
 * configuration objects (the datasets the exec console renders), the
 * organization ontology, and the action-boundary policy.
 *
 * Two things it no longer does, both of which were lies:
 *   - it presented these objects as a read-only YAML FILE EDITOR headed with
 *     filenames (riverbend-fhir-r4.yaml, action-boundary.yaml, …) that exist
 *     nowhere on disk, while the content really came from Postgres;
 *   - it swallowed a 403 on the policy read and rendered hardcoded defaults
 *     (5000bp) instead of the stored value (8200bp).
 * Neither is possible now: every path is /admin/platform/*, which the operator
 * console is actually scoped for, and every read failure is rendered as a
 * failure.
 */

window.cfgGo = async function(tab) { cfgTab = tab; await renderPlatformConfig(); };

// ---------- Living cohorts (operator-authored configuration, not code) ----------
//
// A cohort is a declared clinical proposition: entry criteria over state AND
// trajectory, a mandatory exit, the action it suggests, and the boundary it may
// never cross. Nothing here executes anything — membership is a statement about
// state, and acting goes through the existing proposal → approval path.
//
// The editor only offers metrics from the backend's closed vocabulary, because
// that is what keeps an authored cohort composing existing pack outputs instead
// of inventing clinical logic.

   // the closed metric vocabulary (fetched once)
     // the definition currently being authored

/* ---------- the authoring editor ---------- */

/** Read every criteria row from the DOM back into the draft. */

/** Turn the form into the definition body, with numeric fields actually numeric. */

// ---------- My Work — the OPERATOR console's decision queue ----------
//
// The same server-assembled queue the executive console shows, scoped to the
// console that owns each item. `item.console` is the console owning the capability,
// and cohort review is nursing work, so cohort suggestions land HERE: they used to
// appear in the exec console instead, which made this surface look empty to exactly
// the people the decline loop was built for.
//
// Nothing here acts on a patient. An item is a decision — review or decline,
// approve or reject — and acting on a patient stays a separate proposal → approval
// → outcome episode.

/**
 * Poll while the view is open, and stop the moment it is not — a queue that kept
 * polling after you navigated away would load the server for nobody.
 */

// DLQ item operations (detail / acknowledge / idempotent replay).
window.plDlqAction = async function(id, action) {
  try {
    const j = await plFetch('POST', `/admin/platform/dlq/${encodeURIComponent(id)}/${action}`, { owner: 'operator', reason: `${action} from DLQ console` });
    toast(`${action} → ${j.item?.status ?? 'ok'}`, 'good');
  } catch (err) { toast(`${action} failed: ${err.message}`, 'err'); }
  renderPlatformDlq();
};
window.plDlqDetail = async function(id) {
  const out = document.getElementById('dlq-detail');
  if (!out) return;
  try {
    const j = await plFetch('GET', `/admin/platform/dlq/${encodeURIComponent(id)}`);
    out.innerHTML = `<pre class="code" style="white-space:pre-wrap;">${esc(JSON.stringify(j.item, null, 2))}</pre>`;
  } catch (err) { out.innerHTML = `<span style="color:var(--bad);">${esc(String(err))}</span>`; }
};

// ---------- Agent Studio (Phase D) — one unified agent surface ----------
window.plAgentAction = async function(id, action, payload) {
  try {
    const j = await plFetch('POST', `/admin/platform/agents/${encodeURIComponent(id)}/${action}`, payload ?? {});
    toast(`${action} → ${j.killSwitch !== undefined ? ('killSwitch ' + j.killSwitch) : (j.rollback?.status ?? 'ok')}`, 'good');
  } catch (err) { toast(`${action} failed: ${err.message}`, 'err'); }
  renderPlatformAgents();
};
window.plAgentKill = async function(id) {
  const reason = prompt('Kill switch reason', 'unsafe behavior observed');
  if (reason === null) return;
  window.plAgentAction(id, 'kill', { reason: reason || 'killed from Agent Studio' });
};
window.plAgentRollback = async function(id) {
  const version = prompt('Roll back to version (e.g. 1.0.0)', 'previous');
  if (version === null) return;
  window.plAgentAction(id, 'rollback', { toVersion: version || 'previous', reason: 'rollback from Agent Studio' });
};
window.plAgentOutputTopic = async function(id) {
  const topic = prompt('Output topic (blank = default)', 'anant.agent.output.v1');
  if (topic === null) return;
  const dlq = prompt('DLQ topic (blank = default)', 'anant.agent.output.dlq.v1');
  if (dlq === null) return;
  try {
    const j = await plFetch('PUT', `/admin/platform/agents/${encodeURIComponent(id)}/output-topic`, { ...(topic ? { topic } : {}), ...(dlq ? { dlqTopic: dlq } : {}) });
    toast(`Output topic → ${j.outputTopic}`, 'good');
  } catch (err) { toast('Output topic failed: ' + err.message, 'err'); }
  renderPlatformAgents();
};

// ---------- Enterprise platform (Phase 4 — webhooks, alerts, retention, audit, API) ----------

// Enterprise row actions (survive grid re-renders via inline onclick).
window.entDelete = async function(kind, id) {
  if (!confirm(`Delete ${kind} '${id}'?`)) return;
  try {
    const res = await fetch(`/admin/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.status);
    toast(`Deleted ${kind} ${id}`, 'good');
  } catch (err) { toast('Delete failed: ' + err.message, 'err'); }
  renderEnterprisePanel();
};
window.entTestWebhook = async function() {
  const res = await fetch('/admin/webhooks/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    event: { id: 'ui-test-' + Date.now(), type: 'vital.observed', occurredAt: new Date().toISOString(), scopeId: 'test', subjectId: 'p-test', facilityId: 'f1', payload: { note: 'console webhook test' }, provenance: { sourceId: 'admin-ui', observedAt: new Date().toISOString(), ingestedAt: new Date().toISOString() }, classification: 'internal' },
  }) });
  const j = await res.json().catch(() => ({}));
  toast(res.ok ? ('Webhook test ' + (j.ok ? 'delivered' : 'queued') + ' — check Deliveries') : ('Test failed: ' + (j.error || res.status)), res.ok ? 'good' : 'err');
};

  

// ---------- Hypergraph browser (Phase 5 — SVG node/edge visualization) ----------

// ---------- Command center (Phase 5 — multi-realm live SSE wall) ----------
 

// ---------- Compliance dashboard (Phase 5) ----------

 // active edit id (row loaded into the add form)
const sh = {
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

async function renderSettings() {
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

async function loadSettingsTab() {
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

// Delegated row actions so they survive dataGrid re-renders (sort/filter/paginate).
function bindCrudActions(body, editFields) {
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

async function loadFacilitiesTab(body) {
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

async function loadUnitsTab(body) {
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

async function loadPatientsTab(body) {
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

async function loadAssessmentsTab(body) {
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

async function loadLifecycleTab(body) {
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

async function loadNudgesTab(body) {
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

async function loadRealmsTab(body) {
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

// ---------- Renal Swarm Intelligence — deep link to the RSI application -------
// The operator console does not render swarm surfaces: swarm control, cells,
// insights, next-best actions, episodes and the executive cockpits are the
// EXECUTIVE console's product (see docs/ui-cohesion-persona-matrix.md §1 — setup
// lives in Admin, operations live in Exec). This hands off instead.

// ---------- Simulator — start/stop/step synthetic data driver (2026-08-23) ----------

// Live auto-refresh: while the Simulator view is active, poll /admin/simulator/status
// every 2s and update the counters/realm rows in place — no manual refresh needed.

// Clean up the demo — stop the sim + drop sim realms, remove demo episodes/NBA
// decisions, prune the delivered event-outbox backlog (frees disk). Backed by
// POST /admin/demo/cleanup (see src/server/demo-cleanup.ts + scripts/cleanup-demo.mjs).

// ---------- Exec workspace — durable executive assets (M-S6) ----------

// Journey K (Epic 8) — full CMS submission lifecycle.

// Journey K lifecycle action (freeze/approve/submit/receipt/correct/reconcile).
window.wsSubAction = async function(id, action) {
  let payload = {};
  if (action === 'freeze') {
    const start = prompt('Evidence window start (YYYY-MM-DD):', `${new Date().getFullYear()}-01-01`);
    if (!start) return;
    payload = { start, end: prompt('Evidence window end (YYYY-MM-DD):', `${new Date().getFullYear()}-12-31`) || `${new Date().getFullYear()}-12-31`, by: 'regulatory-admin' };
  } else if (action === 'approve') {
    const approver = prompt('Class-D approver:', 'regulatory-admin');
    if (!approver) return;
    payload = { approver };
  } else if (action === 'receipt') {
    const status = prompt('CMS receipt status (accepted | rejected):', 'accepted');
    if (!status) return;
    payload = { status, referenceId: prompt('CMS reference id:', 'EQRS-2026-000001') || 'EQRS-2026-000001', message: prompt('Receipt message (optional):', '') || 'received' };
  } else if (action === 'correct') {
    const reason = prompt('Correction reason:', '');
    if (!reason) return;
    payload = { reason, by: 'quality-officer' };
  } else if (action === 'reconcile') {
    payload = { by: 'regulatory-admin' };
  } else if (action === 'submit') {
    payload = { by: 'regulatory-admin', credentialsPresent: confirm('Transmission credentials present? (Certified connector is checked server-side)') };
  }
  try {
    const j = await wsFetch(`/admin/platform/submissions/${id}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
    if (action === 'submit' && j.stopped) toast('⛔ ' + j.reason, 'warn');
    else toast(`${action} → ${j.package?.status ?? 'ok'}`, 'good');
  } catch (e) { toast(e.message, 'bad'); }
  renderWsSubmissions();
};

// ---------- Exec substrate — the enrichment the exec console renders, now real ----------

   
 

// ---------- Agent specs — the last configuration that had no database row ----------
/**
 * 452 specs lived only as `packs/<pack>/agents/*.yaml`, read with readFileSync,
 * with authoring writing the filesystem directly and "publishing" implemented as
 * a file RENAME — so there was no row, no audit record, and nothing to reconcile
 * against the registry. The row is now the source of truth; the YAML tree is an
 * import source and an export target (Import tree / ⤓ Export).
 *
 * Publish is a STATE TRANSITION here: the row keeps its identity and gains a
 * stamp. The store never deletes a row because a file vanished, so the drift
 * panel is how the two are kept honest.
 */

/**
 * Save through raw fetch rather than plFetch: the 400 carries a list of schema
 * issues, and plFetch collapses a failure to its `error` code alone. An author
 * who cannot see WHICH field is wrong has to guess.
 */

// ---------- Ontology editor — the org hierarchy operating model, stored in Postgres ----------

// ---------- M-S3 release gate — green/red-team gating (deterministic) ----------
 // red finding id → contained

// ---------- M-S3 kafka-bridge — outbox leasing + receipts / incidents ----------

/* ---------------------------------------------------------------------------
 * GLOBAL HANDLER FACADE — required, and temporary.
 *
 * This file is an ES module, so a top-level `function foo() {}` is
 * MODULE-scoped: it is no longer a property of `window`. The console's views
 * are assembled as HTML strings whose inline handlers (`onclick="foo(…)"`)
 * resolve their names from the GLOBAL scope, so every name reached that way has
 * to be published explicitly — otherwise the click throws
 * `ReferenceError: foo is not defined`, on one view, silently.
 *
 * The list is DERIVED, not hand-maintained: scan index.html and this file for
 * `on<event>="name(` / `name.`, keep the names declared at the top level here.
 * scripts/admin-ui-check.mjs fails if any inline handler in any of the 48 views
 * does not resolve, so this list cannot silently go stale.
 *
 * Getters, not value copies: an assignment would snapshot a `let` binding
 * (wsOntology starts as null and is reassigned later), leaving the handler
 * looking at the boot-time value.
 *
 * The `void [...]` probe reads every name once, so a renamed or deleted symbol
 * fails at BOOT rather than on the one click that happens to use it.
 *
 * S4 removes entries from this list by converting `onclick` to a delegated
 * `data-action` handler. When the list is empty, the facade goes.
 * ------------------------------------------------------------------------- */
void [addStep, cfgObjectsBody, cfgSpecDelete, cfgSpecExport, cfgSpecImport, cfgSpecOpen, cfgSpecPublish, cfgSpecsBody, cloneAgent, cohortAddCriterion, cohortCancelEdit, cohortCriterionInput, cohortDelete, cohortEdit, cohortEvaluateNow, cohortNew, cohortRemoveCriterion, cohortSave, cohortToggle, deleteDraft, doLogin, editDraft, editorState, generateYaml, goTo, knowledgeFilter, nav, nlObserve, openCredentialSheet, openProvenance, plPackActivate, plPackDeactivate, publishDraft, removeStep, renderPlatformConfig, runDueSources, saveCreds, saveDraft, simAction, simCleanup, syncSource, testCreds, validateNow, wqBegin, wqCancelDecline, wqClose, wqConfirmDecline, wqDeclineReason, wqFilter, wqOpen, wqRefresh, wsCatalogCreate, wsCatalogDelete, wsCatalogEdit, S.wsOntology, wsOntologyAdd, wsOntologyPullLive, wsOntologyRemove, wsOntologySave, wsOntologySet, wsSubmissionCreate, wsSubmissionDelete, wsSubmissionValidate];

Object.defineProperties(window, {
  addStep: { configurable: true, get: () => addStep },
  cfgObjectsBody: { configurable: true, get: () => cfgObjectsBody },
  cfgSpecDelete: { configurable: true, get: () => cfgSpecDelete },
  cfgSpecExport: { configurable: true, get: () => cfgSpecExport },
  cfgSpecImport: { configurable: true, get: () => cfgSpecImport },
  cfgSpecOpen: { configurable: true, get: () => cfgSpecOpen },
  cfgSpecPublish: { configurable: true, get: () => cfgSpecPublish },
  cfgSpecsBody: { configurable: true, get: () => cfgSpecsBody },
  cloneAgent: { configurable: true, get: () => cloneAgent },
  cohortAddCriterion: { configurable: true, get: () => cohortAddCriterion },
  cohortCancelEdit: { configurable: true, get: () => cohortCancelEdit },
  cohortCriterionInput: { configurable: true, get: () => cohortCriterionInput },
  cohortDelete: { configurable: true, get: () => cohortDelete },
  cohortEdit: { configurable: true, get: () => cohortEdit },
  cohortEvaluateNow: { configurable: true, get: () => cohortEvaluateNow },
  cohortNew: { configurable: true, get: () => cohortNew },
  cohortRemoveCriterion: { configurable: true, get: () => cohortRemoveCriterion },
  cohortSave: { configurable: true, get: () => cohortSave },
  cohortToggle: { configurable: true, get: () => cohortToggle },
  deleteDraft: { configurable: true, get: () => deleteDraft },
  doLogin: { configurable: true, get: () => doLogin },
  editDraft: { configurable: true, get: () => editDraft },
  editorState: { configurable: true, get: () => editorState },
  generateYaml: { configurable: true, get: () => generateYaml },
  goTo: { configurable: true, get: () => goTo },
  knowledgeFilter: { configurable: true, get: () => knowledgeFilter },
  nav: { configurable: true, get: () => nav },
  nlObserve: { configurable: true, get: () => nlObserve },
  openCredentialSheet: { configurable: true, get: () => openCredentialSheet },
  openProvenance: { configurable: true, get: () => openProvenance },
  plPackActivate: { configurable: true, get: () => plPackActivate },
  plPackDeactivate: { configurable: true, get: () => plPackDeactivate },
  publishDraft: { configurable: true, get: () => publishDraft },
  removeStep: { configurable: true, get: () => removeStep },
  renderPlatformConfig: { configurable: true, get: () => renderPlatformConfig },
  runDueSources: { configurable: true, get: () => runDueSources },
  saveCreds: { configurable: true, get: () => saveCreds },
  saveDraft: { configurable: true, get: () => saveDraft },
  simAction: { configurable: true, get: () => simAction },
  simCleanup: { configurable: true, get: () => simCleanup },
  syncSource: { configurable: true, get: () => syncSource },
  testCreds: { configurable: true, get: () => testCreds },
  validateNow: { configurable: true, get: () => validateNow },
  wqBegin: { configurable: true, get: () => wqBegin },
  wqCancelDecline: { configurable: true, get: () => wqCancelDecline },
  wqClose: { configurable: true, get: () => wqClose },
  wqConfirmDecline: { configurable: true, get: () => wqConfirmDecline },
  wqDeclineReason: { configurable: true, get: () => wqDeclineReason },
  wqFilter: { configurable: true, get: () => wqFilter },
  wqOpen: { configurable: true, get: () => wqOpen },
  wqRefresh: { configurable: true, get: () => wqRefresh },
  wsCatalogCreate: { configurable: true, get: () => wsCatalogCreate },
  wsCatalogDelete: { configurable: true, get: () => wsCatalogDelete },
  wsCatalogEdit: { configurable: true, get: () => wsCatalogEdit },
  wsOntology: { configurable: true, get: () => S.wsOntology },
  wsOntologyAdd: { configurable: true, get: () => wsOntologyAdd },
  wsOntologyPullLive: { configurable: true, get: () => wsOntologyPullLive },
  wsOntologyRemove: { configurable: true, get: () => wsOntologyRemove },
  wsOntologySave: { configurable: true, get: () => wsOntologySave },
  wsOntologySet: { configurable: true, get: () => wsOntologySet },
  wsSubmissionCreate: { configurable: true, get: () => wsSubmissionCreate },
  wsSubmissionDelete: { configurable: true, get: () => wsSubmissionDelete },
  wsSubmissionValidate: { configurable: true, get: () => wsSubmissionValidate },
});

initApp();