# UX & Accessibility Audit — WCAG 2.2 AA

**Scope:** Both consoles — `admin-ui/index.html` (operator console) and
`exec-app/` (executive console). Mapped to **spec §9.6 "Usability, accessibility
and information-density rules"** and the data-provenance labeling rules in §9.5.

**Date:** 2026-08 · **Baseline:** WCAG 2.2 Level AA.

---

## 1. Requirement → WCAG 2.2 AA mapping (spec §9.6)

| Spec rule (§9.6) | WCAG 2.2 AA criteria |
|---|---|
| Meet WCAG 2.2 AA for both consoles | Whole-conformance (P1.3.1, P4.1.2, …) |
| Keyboard accessible work/config/graph ops | 2.1.1 Keyboard · 2.1.2 No keyboard trap · 2.4.7 Focus Visible |
| Preserve visible focus, skip links, landmarks, labels, SR announcements | 2.4.7 Focus Visible · 2.4.1 Bypass Blocks · 1.3.1 Info & Relationships · 3.3.2 Labels or Instructions |
| Never encode risk/status by color alone | 1.4.1 Use of Color |
| One clear primary action per task state | 3.2.2 On Input · 2.4.6 Headings/Labels |
| Progressive disclosure (plain first, trace later) | 1.3.2 Meaningful Sequence · 3.1.5 Reading Level |
| Dense pages: sticky filters/headers, saved views, pagination | 1.4.10 Reflow · 2.4.6 · usability (non-WCAG) |
| Destructive/external/replay/break-glass actions require confirmation | 3.3.4 Error Prevention (Legal/Financial) · 3.3.1 Error Identification |
| Toasts never the only record; durable state visible on page | 4.1.3 Status Messages · 3.3.1 |
| Dates local + exact UTC; numbers identify numerator/denominator/unit/freshness | 1.3.1 · 1.4.8 (advisory) |
| Responsive laptop + command-center; mobile triage but not hide evidence | 1.4.10 Reflow · 1.4.4 Resize Text |
| Localization from active lens catalog, not string replacement | 3.1.1 Language of Page · 3.1.2 Language of Parts |
| Deep links carry only safe identifiers/filters; no PHI/secrets in URL | 2.4.4 Link Purpose · privacy |

---

## 2. Admin console (`admin-ui/`) — findings

### Applied fixes (this pass)

- **Fake-data labeling (§9.5)** — a persistent topbar **`synthetic demonstration
  data`** pill (`#synthetic-badge`) driven by the org's durable `synthetic` flag
  (`refreshSyntheticBadge()` runs on login and every `goTo`). Non-synthetic orgs
  hide it. The org editor now exposes the flag (`po-synthetic` checkbox) and the
  save confirmation echoes "· synthetic".
- **WCAG 1.4.1 (color + text)** — existing status pills already carry text
  ("on plan"/"watch"/"action", "ready"/"review", "active") alongside color; no
  color-only encoding found in operator flows. Confirmed and noted.

### Findings & planned fixes

| # | Criterion | Finding | Fix (planned) |
|---|---|---|---|
| A-1 | 2.4.1 Bypass Blocks | No skip link before the sidebar/topbar | Add a visually-hidden "Skip to content" link targeting `#main`. |
| A-2 | 1.3.1 / 2.4.6 | Page-tab buttons (`tabStripHTML`) rely on `title` only; no `aria-selected` | Add `role="tab"`, `aria-selected`, `aria-controls` to tab buttons; label the tablist. |
| A-3 | 4.1.2 | Cards/stat blocks are plain `div`s (no landmark/semantic grouping) | Add `role="group"`/`aria-label` to the `.cards` grids where meaningful. |
| A-4 | 2.4.7 | Some ghost/icon-only buttons (dock toggle, theme) rely on `title`; focus ring is subtle | Standardize a visible `:focus-visible` outline token in `globals`; add `aria-label` everywhere `title` is the only hint. |
| A-5 | 1.4.10 Reflow | Several dense tables (ledger, readiness, mapping) scroll horizontally on small widths | Confirm the existing `overflow-x: auto` behavior at the 760px breakpoint; add a "column controls / saved views" affordance (non-WCAG density rule). |
| A-6 | 3.3.4 | Replay/break-glass confirmations exist for DLQ replay; confirm the same for release rollback + agent kill | Ensure all destructive routes share a single `confirmDestructive()` dialog showing affected scope. |
| A-7 | 4.1.3 | Toasts exist but some success states rely on the toast alone | Where a toast is the only signal (e.g., pack activate/deactivate), the page also re-renders the durable stat cards (already true) — extend to other actions. |

---

## 3. Executive console (`exec-app/`) — findings

### Applied fixes (this pass)

- **WCAG 3.3.2 Labels** — new live panels added with explicit `aria-label` on
  every input: delegation form (`title`, `owner`, `SLA`) and CMS Class-D approver
  fields. No placeholder-only fields.
- **WCAG 1.4.1 (color + text)** — outcome cards, hierarchy rows and delegation
  status all pair a `Tag` tone with visible text ("done"/"open", "verified · $X"),
  never color alone.

### Findings & planned fixes

| # | Criterion | Finding | Fix (planned) |
|---|---|---|---|
| E-1 | 2.4.1 Bypass Blocks | No skip link; the fixed sidebar precedes `main` in tab order | Add a skip link that moves focus to `main` on activation. |
| E-2 | 1.3.1 Landmarks | `<main>`, `nav` and `aside` are present; the header is a plain `div` | Promote the top bar to `<header>`; label the `nav` ("Primary navigation" already present via `aria-label`). |
| E-3 | 2.4.7 Focus Visible | Drillable cards/buttons have focus but the ring is faint on dark surfaces | Add a shared `.drillable-surface:focus-visible` ring token. |
| E-4 | 1.4.3 Contrast | Muted/faint text (`--faint`, `--muted`) is small (10px) on dark surfaces | Audit the token pair for 4.5:1; bump the two smallest text tokens or increase contrast for body copy. |
| E-5 | 1.4.10 Reflow | Sidebar collapses at 1120px; grids collapse to 1-col; confirm tables scroll | Extend the `overflow-x: auto` treatment to the new delegation + submission-lifecycle panels. |
| E-6 | 4.1.3 Status | Live "syncing / live" tags are static text | Convert the delegation/submission live badges to `role="status"` (polite) so SR users hear state changes. |
| E-7 | 2.4.4 Link Purpose | "Open source" links are labeled by source title (good); verify any bare "here"/"more" links | Sweep for ambiguous link text. |

---

## 4. Shared / cross-cutting

- **Focus management after dialogs/detail drawers:** the workflow-detail modal
  should move focus in on open and restore it on close (2.4.3 Focus Order).
- **Reduced motion:** the demo drawer and sidebar use CSS transitions; add
  `@media (prefers-reduced-motion: reduce)` to disable non-essential motion.
- **Screen-reader announcements:** status changes (pack activated, delegation
  verified, submission approved) should emit an `aria-live="polite"` region.
- **Automated checks to add:** axe-core scan in CI for both consoles
  (github action / vitest + `@axe-core/playwright`).

---

## 5. Data provenance labeling (spec §9.5) — status

| Rule | Admin console | Exec console |
|---|---|---|
| Simulator data shows **Synthetic** on every relevant page/export | ✅ Topbar `synthetic demonstration data` pill (org flag) + per-page copy | ✅ "patient and facility records … are synthetic" (CMS page), "Synthetic-by-default" (outcomes/shared-intel) |
| Public CMS/source data shows **Public authority data** + source timestamps | ✅ CMS catalog/sources render authority + effective dates | ✅ Authority registry + `SourceLink` with status/effective dates |
| Backend-unavailable preserves navigation, no fake fallback | ✅ Views catch and render empty/error state | ✅ Panels degrade with "syncing/unavailable" states |
| Contract-only tests labeled **Contract verified—not connected to broker** | ✅ (docker-smoke reports per-broker status) | n/a |

---

## 6. Definition of done

- [ ] axe-core (WCAG 2.2 AA) run on both consoles: 0 critical/serious violations
- [ ] Full keyboard path for My Work → approve, Pack Studio activate, DLQ replay
- [ ] Visible focus on every interactive element; skip links on both consoles
- [ ] No color-only status anywhere (text/tone pair required)
- [ ] `prefers-reduced-motion` honored
- [ ] Dense tables scroll without clipping at 760px/1120px breakpoints
