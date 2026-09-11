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

| # | Slice | State |
|---|---|---|
| **S1** | **Move the classic script blocks into `js/app.js`** as an external **classic** script (`<script src="./js/app.js">` at the end of `<body>`) — no modules yet, so no facade is needed and nothing enters strict mode. A pure move: the same code, in the same order, from a different file | **DONE** — `index.html` 7,629 → 942 lines; `js/app.js` 6,723 lines (6,691 moved + banner). Byte-identical blocks asserted by the split script |
| **S2** | **Convert `js/app.js` to `type="module"` and publish the handler facade** — 63 names, derived from the source, published as live getters, with a `void [...]` probe so a renamed symbol fails at boot | **DONE** — 61 of the 91 handler references were already `window.x =` assignments; the 63 that were top-level declarations are now published explicitly |
| S3 | Extract views and leaves into real modules (`views/*.js`, `components.js`, `api.js`), now that `import` is available; shrink the facade by moving its entries into the module they belong to | Not started |
| S4 | Convert `onclick` → delegated `data-action` per view; shrink the facade until it is empty and delete it | Not started |

**Why S1 was a classic script, not a module.** A module would have forced three
simultaneous changes: the facade (63 new globals), strict mode (a real behaviour
change — an accidental undeclared assignment that silently creates a global today
would throw), and the deferral of the whole console's boot. Each is testable, but
bundling them means a failure does not tell you which one caused it. S1 changed
one thing — where the code lives — and kept the gate green, which is what made
S2's failures attributable. S2 then made exactly one change (module + facade) and
had exactly one failure mode to look for, which is how the facade list was proven
complete in a single pass.

### What S2 broke in the GATE (worth remembering)

The harness was built on three globals that module scope removed, and each one
failed in a way that looked like an application bug:

- `typeof NAV` → `undefined` ⇒ *"the console did not boot"* against a console
  that had booted perfectly. `NAV` is a top-level `const`, so it lives in the
  module's scope, not on `window`.
- `currentView` likewise. The activation check now reads the UI: the page tab
  strip's active `button.tab[data-view]`, falling back to the sidebar item for a
  non-tabbed view. Note the console uses `active` for page tabs and `is-active`
  for the config studio's inner tabs — CSS class selectors are token-exact, so
  the two cannot be confused.
- Discovery via the rendered DOM is not sufficient either: a tabbed sidebar
  section renders ONE element with a `data-view`, so the DOM exposes 11 of the 48
  views. Discovery now reads the render dispatch from the served source.

**Handler counts are NOT a fingerprint.** They are data-dependent (a row only
carries handlers once it renders), so they change across a server restart even
when the code is untouched. S1's counts matched the pre-move baseline exactly
because the server state was identical; do not repeat that as a general claim.
The invariant that matters, and the one the harness enforces, is **0 unresolved
handlers** on every view.

What deliberately did **not** move in S1: the theme bootstrap in `<head>` (it
exists to run before first paint), the `tailwind.config` block (must run
immediately after the CDN tag), and the two `type="module"` blocks (WASM
what-if, TanStack grid) — modules are deferred, so leaving them in place
preserves the relative order exactly: `app.js` runs after js-yaml has loaded and
before the deferred modules execute, which is the order the console had before.

### The 48 views

`NAV` and the `render()` dispatch agree exactly: 48 ids, one render case each.
That invariant is now checkable, and asserting it is how a nav item pointing at a
non-existent view (which renders the dashboard) would be caught.

## 8. How each slice is verified

The backstops exist and run in this order:

1. **`node scripts/admin-ui-check.mjs`** — the page walk this document asked for,
   now written. It boots the console, discovers the view list from the live `NAV`,
   and per view fails on: a page error, a console error, **an inline handler name
   that does not resolve**, a view that did not actually activate, an empty/
   `Loading…` main, or horizontal overflow. Plus two boot-level assertions: the
   deferred-module globals (`__dataGrid`, `__liquidForecast`) must be functions,
   because every consumer of those falls back silently and a broken module would
   otherwise degrade the whole console without a single error.
   - It **rejects unknown view ids**. `render()` falls through to a default, so
     `goTo('catalog')` (not a view) renders the dashboard: a walk over ids like
     that reports "clean" while testing a different page 48 times. It also asserts
     `currentView === view` after each transition for the same reason.
   - Baseline (and the S1 result): **48/48 clean**. S2: 48/48 across consecutive
     runs with **0 unresolved handlers**, which is the evidence that the facade
     list is complete — derived from the source rather than guessed, and then
     proven at runtime.
   - **It found a real, pre-existing defect**: one intermittent
     `TypeError: Cannot read properties of null (reading 'addEventListener')` on
     a view. The mechanism is a render that `await`s a fetch and then wires the
     DOM: if a navigation replaces `main.innerHTML` during that await, the
     deferred `getElementById(...)` returns null. There are **42** unguarded
     `getElementById(...).addEventListener` sites in the console. Only observed
     once in ~6 runs and not reproduced since, so it is recorded rather than
     fixed here — but it is the class of bug a page walk exists to surface.
2. **`node scripts/check-admin-ui-syntax.mjs`** — extended in S1 to cover both the
   remaining inline blocks **and every locally-referenced external script**, so
   the code that moved into `js/app.js` is still syntax-checked. A syntax error in
   the console's main script does not degrade the page, it kills the boot.
3. **`npx tsc --noEmit`** — unaffected by console changes (`admin-ui/` is not
   typechecked); it gates the server only.
4. **The full suite** (`KNOWLEDGE_STORE_DIR=/tmp/x npx vitest run --no-file-parallelism`,
   currently 1186 passed / 3 skipped) — likewise a server regression gate, not a
   console one.

What the walk does **not** cover: interactions that only happen on a click. It
checks that the handler *resolves* and that the view renders without errors; it
does not click every button. Deeper coverage means driving real actions per view,
which is worth doing but is a bigger instrument than the split needs.

## 9. What this is not

- Not a rewrite to React/Next. 7,000 lines of working, verified UI would be
  rewritten to change its file layout.
- Not a bundler introduction. Minification and tree-shaking are not the problem
  here; module boundaries are.
- Not urgent in the sense of a defect. Everything in it works. It is the reason
  the next feature in that file is harder than it should be, and the reason
  slice 3/4/5 could not be three commits.
