#!/usr/bin/env node
/**
 * U#8/R4 — exec console health harness.
 *
 * Drives the exec SPA in headless Chromium and reports, per page:
 *   1. console errors + uncaught page errors
 *   2. keyboard reachability (Tab moves focus)
 *   3. responsive overflow at desktop + tablet widths
 *   4. a lightweight text-contrast probe (AA 4.5:1) over visible headings/text
 *
 * Login is done via the API (POST /auth/login) and the session cookie is
 * injected, so the harness never fights the UI login form.
 *
 * Requires playwright (browsers not auto-downloaded here):
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/ui-console-check.mjs [--base http://127.0.0.1:3000] [--pages my-work,swarm-control]
 *
 * Exit code 0 = clean; 1 = at least one check failed.
 */

import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? fallback : fallback;
};

const BASE = arg('--base', 'http://127.0.0.1:3000');
const USER = arg('--user', 'admin');
const PASS = arg('--pass', 'admin123');
const ALL_PAGES = ['my-work', 'ecosystem', 'agents', 'command', 'patient', 'anemia', 'facility', 'assessments', 'intelligence', 'executive', 'cms', 'assurance', 'configuration'];
const PAGES = arg('--pages', 'all') === 'all' ? ALL_PAGES : arg('--pages', '').split(',');
const VIEWPORTS = [{ label: 'desktop', width: 1440, height: 900 }, { label: 'tablet', width: 760, height: 900 }];

const results = [];
let failed = 0;
function record(page, viewport, check, ok, detail = '') {
  const line = { page, viewport, check, ok, detail };
  results.push(line);
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${page} / ${viewport} / ${check}${detail ? ` — ${detail}` : ''}`);
}

/** Probe visible text contrast (AA 4.5:1) — runs fully in the browser page. */
async function probeContrast(page) {
  return page.evaluate(() => {
    const parseColor = (str) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(str ?? '');
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1] : null;
    };
    const luminance = ([r, g, b]) => {
      const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => {
      const la = luminance(a); const lb = luminance(b);
      const hi = la > lb ? la : lb; const lo = la > lb ? lb : la;
      return (hi + 0.05) / (lo + 0.05);
    };
    // Composited background: walk ancestors bottom-up, blending any alpha
    // (chips/panels use translucent overlays; gradients are skipped).
    const compositedBackground = (el) => {
      const chain = [];
      let node = el;
      while (node && node !== document.documentElement) { chain.push(node); node = node.parentElement; }
      chain.reverse();
      let acc = null;
      for (const nd of chain) {
        const c = parseColor(getComputedStyle(nd).backgroundColor);
        if (!c) continue;
        const a = c[3];
        if (acc === null) { acc = [c[0], c[1], c[2]]; continue; }
        acc = [c[0] * a + acc[0] * (1 - a), c[1] * a + acc[1] * (1 - a), c[2] * a + acc[2] * (1 - a)];
      }
      return acc ?? parseColor(getComputedStyle(document.body).backgroundColor) ?? [10, 16, 24];
    };
    const isActuallyVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.left > window.innerWidth || rect.right < 0) return false; // offscreen drawer
      let node = el;
      while (node) {
        if (node.nodeType !== 1) break;
        const s = getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
        node = node.parentElement;
      }
      return true;
    };
    const lows = [];
    const els = Array.from(document.querySelectorAll('h1, h2, h3, strong, .eyebrow, .nav-item span, p'));
    for (const el of els.slice(0, 400)) {
      if (!el.textContent?.trim()) continue;
      if (!isActuallyVisible(el)) continue; // ignore closed/offscreen drawers
      const style = getComputedStyle(el);
      if (style.color.includes('rgba(0, 0, 0, 0)') || style.color === 'transparent') continue;
      const fg = parseColor(style.color);
      if (!fg) continue;
      const ratio = contrast([fg[0], fg[1], fg[2]], compositedBackground(el));
      if (ratio < 4.5) lows.push({ ratio: Math.round(ratio * 100) / 100, text: el.textContent.trim().slice(0, 40), tag: el.tagName });
    }
    return lows.slice(0, 8);
  });
}

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  // API login → inject the session cookie (deterministic, UI-agnostic).
  const login = await context.request.post(`${BASE}/auth/login`, { data: { username: USER, password: PASS } });
  if (login.status() !== 200) {
    console.error(`Login failed (${login.status()}) — cannot run the harness.`);
    await browser.close();
    process.exit(2);
  }
  const setCookie = login.headers()['set-cookie'] ?? '';
  const m = /hh_session=([^;]+)/.exec(setCookie);
  if (m?.[1]) {
    await context.addCookies([{ name: 'hh_session', value: m[1], url: BASE }]);
  }

  for (const viewport of VIEWPORTS) {
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(`${BASE}/exec/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar, .nav-item', { timeout: 20000 }).catch(() => {});

    for (const navId of PAGES) {
      const btn = page.locator(`.nav-item`).filter({ hasText: navId === 'my-work' ? 'My Work' : navId }).first();
      if (navId !== ALL_PAGES[0]) {
        await btn.click({ timeout: 8000 }).catch(() => {});
      }
      await page.waitForTimeout(2500); // allow polls + fetches to settle

      const overflow = await page.evaluate(() => ({ body: document.body.scrollWidth, inner: window.innerWidth }));
      record(navId, viewport.label, 'console-clean', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
      record(navId, viewport.label, 'no-page-error', pageErrors.length === 0, pageErrors.slice(0, 1).join(' | '));
      record(navId, viewport.label, 'no-h-overflow', overflow.body <= overflow.inner + 1, `scrollW=${overflow.body} viewport=${overflow.inner}`);

      // Keyboard: a Tab from the page body must move focus somewhere usable.
      const before = await page.evaluate(() => document.activeElement?.tagName ?? '');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(50);
      const after = await page.evaluate(() => document.activeElement?.tagName ?? '');
      record(navId, viewport.label, 'keyboard-tab', before !== after || after !== 'BODY', `active: ${before} → ${after}`);

      const lows = await probeContrast(page);
      record(navId, viewport.label, 'contrast-aa', lows.length === 0, lows.map((l) => `${l.tag} ${l.ratio}:1 "${l.text}"`).join(' | '));

      // Drain per-page error buffers after recording (errors are attributed per page visit).
      consoleErrors.length = 0;
      pageErrors.length = 0;
    }
    await page.close();
  }

  await browser.close();
  console.log(`\n${failed === 0 ? '✔' : '✘'} ${results.length} checks · ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(2); });
