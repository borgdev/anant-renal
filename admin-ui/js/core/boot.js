import { S } from '../state.js';
import { api } from './api.js';
import { checkAuth, rawJson, renderTopbarUser } from './auth.js';
import { initSidebar } from './nav.js';
import { goTo, render } from './router.js';
import { toggleShortcuts } from './shortcuts.js';
import { esc, initTheme, toast } from './theme.js';
import { refreshSyntheticBadge } from '../views/editor.js';

export async function initApp() {
  initTheme();
  const user = await checkAuth();
  if (user) { S.sessionUser = user; await enterConsole(); }
  else { await renderLogin(); }
}

export async function enterConsole() {
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

export function renderLogin(msg) {
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

export async function doLogin(ev) {
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

export async function runGlobalSearch(q, ctx) {
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

export function initGlobalSearch() {
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

export function initShortcuts() {
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
