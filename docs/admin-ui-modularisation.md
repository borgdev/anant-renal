# Modularising the operator console

`admin-ui/index.html` is a single 7,628-line file. This document records what it
actually is (measured, not estimated), why it ended up that way, what it costs,
and the slice plan to split it without a build step.

Status: **not started.** Landed as an analysis so the split happens as its own
reviewable slice rather than underneath an unrelated change.

## 1. What it is, measured

| | |
|---|---|
| `admin-ui/index.html` | **7,628 lines / 525,240 bytes** |
| of which JavaScript | **7,097 lines (93%)** in two inline `<script>` blocks — 2,975 and 3,715 lines |
| CSS | 454 lines (one `<style id="shell-base">`) |
| markup | 532 lines |
| top-level function declarations | **248** |
| top-level `let`/`const` | **82** — all in one global scope |
| inline `onclick` attributes in generated HTML strings | **146** |
| inline `oninput`/`onchange` | **21** |
| distinct functions called from an inline handler | **81** |
| explicit `window.x =` exports | **28** |
| `// ----------` comment banners standing in for module boundaries | **50** |

Two blocks are 94% of the script: line 572 (2,975 lines) and line 3910
(3,715 lines). The 50 section banners — `Router + views`, `Realm management`,
`Living cohorts`, `Agent Studio`, … — are the module boundaries that exist in
intent but not in code.

## 2. How it got that way

Not a design decision. Growth per commit touching the file:

```
  120  M6   admin API + UI shell
  670  M7   agent authoring workflow
  804  M8   Realm
  999  M9+M10
 1093  M11
 1252  M20  knowledge browser, learn hub, corpus
 6216  <- 3dd7c1c  "feat: AnantHealth platform — full implementation"
 6960
 7082
 ...
 7946  cab8ed0  light-mode defect sweep
 7397  dd11354  slices 0-2 (pruned ~550 lines of unreachable code)
 7628  9f5d5cd  slices 3/4/5 (+ agent-spec authoring)
```

Six milestones grew it honestly (120 → 1,252 lines). Then **one commit took it
from 1,252 to 6,216**. A whole platform landed in a single commit and the console
rode along inside it. Nobody ever chose this shape; nobody ever went back.

## 3. What it costs

- **No module boundaries.** Everything is a window global, so nothing — no
  bundler, no linter, no type checker — can tell you what is dead. The AST pruner
  written in slice 0-2 had to exist *because* of this; it found ~40 unreachable
  declarations (an entire unreachable Renal Swarm section, 66 KB).
- **No types across 248 functions.** Renaming a symbol is a text search. Slice 3
  deleted two views and left 14 broken call sites to find by hand.
- **The file is the review unit.** The slice 0-2 commit was 550 interleaved line
  deletions inside one file. The slice 3/4/5 commit had to be a single commit
  because `admin-ui/index.html` alone carried changes from three different
  slices — there is no way to stage a 525 KB single file hunk-by-hunk and be
  confident.
- **525 KB parsed on every cold load**, unminified, unbundled, and not
  cached-per-module.

## 4. The one thing that is genuinely right about it

**There is no build step.** `admin-routes.ts` does
`fastifyStatic({ root: resolve(cwd, 'admin-ui') })` at `/admin/ui/`, so *any*
file added under `admin-ui/` is served. That means this does not require adopting
Vite, and a module split does not forfeit the property.

It is also worth stating the counterweight honestly: `exec-app/` *is* the
Vite + React + TS shape, and it has its own tax — `exec-app/dist` is gitignored,
so every browser verification needs a rebuild first, and a page loaded before the
rebuild keeps serving the old bundle. That has cost real time in this repo.

## 5. The target

```
admin-ui/
  index.html          markup + <style> + one <script type="module" src="./js/app.js">
  js/
    app.js            imports, boots, registers the handler facade
    nav.js            NAV model, sidebar, dock/collapse/pin
    router.js         goTo / render / viewAllowed / page tabs
    theme.js          palette, theme bootstrap, hydrateIcons
    api.js            plFetch, api() shim, auth/console session
    components.js     dataGrid, states, modals, toast, esc, formatters
    views/
      agents.js  catalog.js  cohorts.js  realm.js  platform-config.js
      platform-releases.js  platform-assurance.js  platform-agents.js
      platform-cohorts.js  my-work.js  fhir.js  enterprise.js  users.js …
```

Native ES modules. No bundler, no transpile, no `dist`. `node
scripts/check-admin-ui-syntax.mjs` extends to walk `admin-ui/js/**` instead of
extracting inline blocks.

## 6. The hard part (and why this is a slice, not an afternoon)

With ES modules, a top-level `function foo() {}` is **module-scoped, not
global**. Generated HTML strings contain **146 inline `onclick="foo(…)"`
handlers calling 81 distinct functions**. Every one of those becomes
`ReferenceError: foo is not defined` the moment `foo` stops being a global.

Only 28 `window.x =` assignments exist today, so the globals are *implicit* —
which is exactly the trap.

Two ways through:

- **(A) Explicit facade — recommended first.** Each module exports what it owns;
  `app.js` does one deliberate `Object.assign(window, { … })` for the set of
  names the generated HTML calls. Mechanical, reviewable, keeps every template
  working, and turns 81 *implicit* globals into 81 *declared* ones. It does not
  fix the coupling — it makes it visible, which is the precondition for fixing it.
- **(B) Event delegation — the real fix, incremental.** Convert
  `onclick="foo(1)"` to `data-action="foo" data-arg="1"` plus one delegated
  listener on `main`. Right end state, but it is a rewrite of 167 attribute sites
  embedded in template literals, and it should happen per-view after the split,
  not before.

Do (A) mechanically to split the file, then (B) view by view. Doing (B) first
means editing 167 call sites inside one 7,628-line file before there is any way
to test a single one of them in isolation.

## 7. Slice plan

| # | Slice | Touches | Risk |
|---|---|---|---|
| S1 | Shell + facade: `index.html` keeps markup/CSS, moves the two script blocks verbatim into `js/app.js` behind one `<script type="module">`, facade `Object.assign(window, …)` for the 81 handler names | 1 file → 2; no behaviour change | **Low** — the file is moved, not rewritten. Fails loudly (every handler breaks at once) rather than subtly |
| S2 | Extract the leaves: `esc`/`toast`/`downloadBlob`/`format*`/`dataGrid`/state cards/modals → `components.js`; `plFetch`/`api()`/session → `api.js`; theme/icons → `theme.js` | ~3 modules, ~600 lines moved | Low — leaf modules with no view dependencies |
| S3 | Extract views along the existing 50 banners, one commit per 2-3 views, in dependency order (leaves before dependents: `catalog` before `platform-config`) | ~15 view modules, the bulk of the 7,097 lines | **Medium** — this is where a missed facade name surfaces, view by view |
| S4 | Convert `onclick` → delegated `data-action` per view; shrink the facade until it is empty | 167 attribute sites, incremental | Medium — but now testable one view at a time |

## 8. How to prove each slice did not break the console

The backstops already exist and should gate every slice:

1. `node scripts/check-admin-ui-syntax.mjs` — currently "ALL 5 inline script
   blocks OK"; S1 changes it to walking `admin-ui/js/**`. A syntax error in a
   classic script kills the *whole* boot (`initApp is not defined`), which is why
   this gate exists.
2. `/tmp/check-handlers.mjs` — finds `onclick="fn("` with no definition. Currently
   **0 of 81 unresolved**. This is the primary S1/S3 regression detector: it is
   the difference between "the file moved" and "a handler is now undefined".
3. `npx tsc --noEmit` — unchanged; `admin-ui/` is not typechecked, so this only
   covers the server.
4. The full suite: `KNOWLEDGE_STORE_DIR=/tmp/x npx vitest run --no-file-parallelism`
   (currently **1186 passed / 3 skipped**) — it does not exercise the console, so
   it is a regression gate for the server, not for the split.
5. **A browser walk of every view** is the actual acceptance test, and it must be
   scripted rather than eyeballed: load the console, call each `window.render*`
   (or `goTo(view)`) for every entry in `NAV`, and fail on any console error or
   page error. **No such gate exists today.** `scripts/ui-console-check.mjs` is
   exec-only — `page.goto('/exec/')` and its `ALL_PAGES` list is the 13 exec nav
   ids — so the admin-ui console has never had an automated page walk. Writing
   that script is the missing piece and it should be written **before** S1, so
   the split has a real gate rather than a claim. Without it, "the split works"
   is 81 handlers someone clicked by hand.

## 9. What this is not

- Not a rewrite to React/Next. 7,000 lines of working, verified UI would be
  rewritten to change its file layout.
- Not a bundler introduction. Minification and tree-shaking are not the problem
  here; module boundaries are.
- Not urgent in the sense of a defect. Everything in it works. It is the reason
  the next feature in that file is harder than it should be, and the reason
  slice 3/4/5 could not be three commits.
