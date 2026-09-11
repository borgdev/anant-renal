#!/usr/bin/env node
/**
 * Operator-console (admin-ui) health harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * `admin-ui/index.html` is a 7,600-line single-file console whose modules are
 * `// ----------` comment banners standing in for real ones, and whose views
 * reach into each other through the GLOBAL scope: 146 inline `onclick`
 * attributes in generated HTML call ~81 top-level functions by bare name. That
 * works only because a top-level `function foo() {}` in a classic script becomes
 * a window property. Nothing checked that, and `scripts/ui-console-check.mjs` is
 * exec-only (`page.goto('/exec/')`), so the operator console has never had an
 * automated page walk.
 *
 * That is exactly the invariant a module split breaks: the moment `foo` is
 * module-scoped instead of global, `onclick="foo()"` throws
 * `ReferenceError: foo is not defined` — at CLICK time, on one view, silently.
 * So this harness reports, per view:
 *
 *   1. console errors + uncaught page errors
 *   2. every inline handler name that does NOT resolve  <- the split gate
 *   3. the view actually rendered (not stuck on "Loading…")
 *   4. horizontal overflow
 *
 * Login is API-side with the cookie injected, so the harness never fights the
 * login form.
 *
 * Usage:
 *   node scripts/admin-ui-check.mjs [--base http://127.0.0.1:3000]
 *                                   [--user admin] [--pass admin123]
 *                                   [--views catalog,platform-config]
 *                                   [--quiet]
 * Exit code 0 = clean, 1 = at least one check failed.
 *
 * Requires playwright (not in package.json — install on demand):
 *   npm i --no-save playwright && npx playwright install chromium
 */

import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
};
const flag = (name) => process.argv.includes(name);

const BASE = arg('--base', 'http://127.0.0.1:3000');
const USER = arg('--user', 'admin');
const PASS = arg('--pass', 'admin123');
const QUIET = flag('--quiet');
const ONLY = arg('--views', '');

/**
 * Enumerate the views to walk. Prefer the live sidebar model (which is the thing
 * the operator can actually reach); fall back to the render dispatch in the
 * served source so the harness still works if the global changes shape.
 */
async function discoverViews(page) {
  const fromNav = await page.evaluate(() => {
    try {
      if (typeof NAV === 'undefined') return [];
      return NAV.flatMap((g) => (g.items ?? []).map((i) => i.view)).filter(Boolean);
    } catch { return []; }
  });
  if (fromNav.length) return { views: fromNav, source: 'NAV' };

  const html = await (await page.request.get(`${BASE}/admin/ui/`)).text();
  const fromDispatch = [...html.matchAll(/view === '([a-z0-9-]+)'/g)].map((m) => m[1]);
  return { views: [...new Set(fromDispatch)], source: 'render-dispatch' };
}

/**
 * The split gate. Extract the leading identifier from every inline handler in
 * the rendered view and check it resolves in the GLOBAL scope — the same scope a
 * browser uses when the attribute fires. `new Function` is deliberate: it
 * resolves global lexical bindings (top-level `const`/`function`) exactly as an
 * inline handler does, so this reports what a click would actually do.
 */
async function unresolvedHandlers(page) {
  return page.evaluate(() => {
    const ATTRS = ['onclick', 'oninput', 'onchange', 'onsubmit', 'onkeydown'];
    const names = new Set();
    for (const el of document.querySelectorAll('main [onclick], main [oninput], main [onchange], main [onsubmit], main [onkeydown]')) {
      for (const attr of ATTRS) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const m = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(v);
        if (m && m[1] !== 'this') names.add(m[1]);
      }
    }
    const missing = [];
    for (const n of names) {
      let t;
      try { t = new Function(`return typeof ${n}`)(); } catch { t = 'unresolvable'; }
      if (t !== 'function') missing.push(`${n}:${t}`);
    }
    return { checked: names.size, missing };
  });
}

async function run() {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error('Could not launch Chromium — install it first:');
    console.error('  npm i --no-save playwright && npx playwright install chromium');
    console.error(String(err).split('\n')[0]);
    process.exit(2);
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(`${BASE}/auth/login`, { data: { username: USER, password: PASS } });
  if (login.status() !== 200) {
    console.error(`Login failed (${login.status()}) — cannot walk the console.`);
    await browser.close();
    process.exit(2);
  }
  const cookie = /hh_session=([^;]+)/.exec(login.headers()['set-cookie'] ?? '');
  if (cookie?.[1]) await context.addCookies([{ name: 'hh_session', value: cookie[1], url: BASE }]);

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String(err).split('\n')[0]));

  await page.goto(`${BASE}/admin/ui/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.nav-item').length > 0, { timeout: 20000 })
    .catch(() => {});

  const { views: discovered, source } = await discoverViews(page);
  let views = ONLY ? ONLY.split(',').map((v) => v.trim()).filter(Boolean) : discovered;
  if (!views.length) {
    console.error('Could not discover any views — the console did not boot (check for a page error).');
    console.error(pageErrors.slice(0, 3).join('\n') || '(no page errors captured)');
    await browser.close();
    process.exit(1);
  }
  // An unknown view id does not throw: render() falls through to its default and
  // the operator sees the dashboard. A walk over such an id would report "clean"
  // while testing a different page 40 times, so reject it up front.
  const unknown = views.filter((v) => !discovered.includes(v));
  if (unknown.length) {
    console.error(`Unknown view id(s) not present in ${source}: ${unknown.join(', ')}`);
    console.error(`Known ids (${discovered.length}): ${discovered.join(', ')}`);
    await browser.close();
    process.exit(2);
  }

  console.log(`Walking ${views.length} views (discovered from ${source}) at ${BASE}\n`);
  const failures = [];

  // The two DEFERRED module blocks publish globals the views read behind a
  // fallback (`window.__dataGrid ?? fallbackGrid()`, `window.__liquidForecast`),
  // so a module that fails to load degrades SILENTLY: every view still renders,
  // the grid is just a plain table and the forecast is missing. Assert them once
  // up front — this is the check that would have caught a broken module position.
  await page.waitForTimeout(2500);
  const deferred = await page.evaluate(() => ({
    dataGrid: typeof window.__dataGrid,
    liquidForecast: typeof window.__liquidForecast,
  }));
  for (const [name, t] of Object.entries(deferred)) {
    if (t !== 'function') {
      failures.push({ view: '(boot)', problems: [`deferred module global ${name} is ${t}, expected function`] });
      console.log(`FAIL  ${'(boot)'.padEnd(24)} deferred module global ${name} is ${t}, expected function`);
    }
  }

  for (const view of views) {
    const c0 = consoleErrors.length;
    const p0 = pageErrors.length;

    await page.evaluate((v) => { if (typeof window.goTo === 'function') window.goTo(v); }, view);
    await page.waitForTimeout(1200);
    // Let the view's own fetches settle without hanging on a poll that never ends.
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});

    const cErr = consoleErrors.slice(c0);
    const pErr = pageErrors.slice(p0);
    const handlers = await unresolvedHandlers(page);
    // The view must actually become current. If goTo() declined it (unknown id,
    // or a role guard redirect via viewAllowed) we would otherwise be measuring
    // the view it redirected TO and calling it clean.
    const active = await page.evaluate(() => (typeof currentView === 'string' ? currentView : null));
    const body = await page.evaluate(() => {
      const main = document.querySelector('main');
      const text = (main?.innerText ?? '').trim();
      return {
        len: text.length,
        loading: /^Loading…?$/.test(text) || text === '',
        scrollW: document.body.scrollWidth,
        inner: window.innerWidth,
        h1: (main?.querySelector('.page-title, h1')?.textContent ?? '').trim().slice(0, 40),
      };
    });
    const overflow = body.scrollW > body.inner + 1;

    const problems = [];
    if (active !== view) problems.push(`view did not activate (currentView=${active})`);
    if (pErr.length) problems.push(`page-error: ${pErr[0]}`);
    if (cErr.length) problems.push(`${cErr.length} console error(s): ${cErr[0].slice(0, 90)}`);
    if (handlers.missing.length) problems.push(`unresolved handler(s): ${handlers.missing.join(', ')}`);
    if (body.loading) problems.push('view did not render (empty or stuck on Loading…)');
    if (overflow) problems.push(`h-overflow scrollW=${body.scrollW} viewport=${body.inner}`);

    if (problems.length) {
      failures.push({ view, problems });
      console.log(`FAIL  ${view.padEnd(24)} ${problems.join(' | ')}`);
    } else if (!QUIET) {
      console.log(`ok    ${view.padEnd(24)} handlers=${handlers.checked} ${body.h1 ? `“${body.h1}”` : ''}`);
    }
  }

  await browser.close();

  console.log(`\n${views.length - failures.length}/${views.length} views clean`);
  if (failures.length) {
    console.log(`\n${failures.length} view(s) with problems — see FAIL lines above.`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
