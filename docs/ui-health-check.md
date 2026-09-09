# Exec console UI health check & cohesion sweep (phase U #8)

Method + live observations for the `exec-app/` console (React 19 + Vite build served at `/exec/`). The goal is not pixel-perfection — it is that **no page ever crashes, hides state behind a raw error, or breaks the Bel/Pl/K / role / synthetic rules** from `docs/ui-cohesion-persona-matrix.md`.

---

## 1. Method

Run a dev server (`npm run dev`, `HH_DEMO_SIM=1`), rebuild the console (`cd exec-app && npm run build`), then:

1. **Session** — sign in as `admin/admin123`; every page must render without a login redirect.
2. **Console-error scan** — watch the browser console across a nav pass; zero `[error]` from app code (a single expected `401` only while a session is being cleared).
3. **Keyboard** — Tab reaches filters/rows/buttons; Enter/Space activate; `:focus-visible` ring visible.
4. **Contrast (spot)** — body/label text vs surface ≥ AA 4.5:1 in both themes.
5. **Responsive** — 1280, 1024, 800 and 640 px widths: no horizontal scroll on `.content-shell`, grid columns collapse, topbar controls not clipped.
6. **State discipline** — each page shows loading (orbit) → empty (next action) → error (inline, refreshable); never a blank/white region.
7. **Cohesion rules** — U#6 rules 1–7 (Bel/Pl/K tone, session banner, synthetic labels, live vs replay, red-for-risk).

---

## 2. Live observations (2026-09-09, branch `ux/coherent-journey-role-aware`)

| Check | Result | Notes |
|---|---|---|
| Login → shell | ✅ | Admin sign-in resolves to My Work; role/scope server-enforced. |
| My Work (empty) | ✅ | Empty view with next action + Refresh; no crash. |
| My Work (populated) | ✅ (prior) | Episode rows render `evidence <posture> · Bel · Pl · K`; posture tones unified in U#7. |
| Anemia & ESA | ✅ | Advisor, D-S suggestion readout, Class-C banner intact. |
| Session-expiry | ✅ (code) | One global sticky banner added in U#7; triggers from any 401 via shared fetch wrapper. (Live E2E note: banner fires on the next poll after a session is cleared — the My Work page only polls the public `/api/work`, so the banner is best observed on a gated page such as Swarm control / Anemia.) |
| Console errors | ✅ | No app-code `[error]` during nav pass. |
| Lens/brand | ⚠️ | In this dev instance the org operating-model lens is currently `payer`, so the shell brands "Anant Payer / Member intelligence" while renal content is shown. Not a UI defect — the shell correctly adapts to `/api/context`; for renal demos set the org lens back to `provider` (Configuration → operating model). |
| D-S posture tone | ✅ | `corroborated` mint · `weak` amber · `contested` violet across My Work, ESA, early-warning; red reserved for alert/risk (U#7). |

---

## 3. Checklist (sweep tracker)

- [x] **Session-expiry** — one console banner; every fetch wrapper tags 401 (`U#7`).
- [x] **Bel/Pl/K tone rule** — shared `EvidenceTag`/`evidenceTone` in `ui.tsx`; used by My Work + ESA (`U#7`). Remaining: point the early-warning watch + NBA row readouts at the same primitives (they already follow the tones; formal component reuse is cosmetic).
- [ ] **Keyboard pass** — full Tab order audit across all 14 pages (spot-checked My Work).
- [ ] **Contrast audit** — full token pass both themes (already AA on the admin console; exec tokens share the `#98aec0` family).
- [ ] **Responsive pass** — full widths across all pages (spot-checked desktop).
- [ ] **Empty/loading/error discipline** — audit remaining pages for blank-state gaps (Patient intelligence, Swarm control already have module-level loading/empty).
- [ ] **Terminology** — sweep copy for synonyms listed in U#6 glossary (e.g. "agent" vs "cell" in prose).

**Suggested rhythm:** fix keyboard/contrast/responsive findings as small per-page slices during R1–R4 execution rather than a dedicated blocking pass — every R slice already lands with live verification.

---

## 4. Auto-check (lightweight, CI-able)

The most valuable automatable checks are already in the backend test suite:

- `tests/live-event-feed.test.ts` — live wall tail + filters + SSE (`?once`) shape.
- `tests/early-warning.test.ts` — D-S watch posture/gates.
- `tests/dst-work.test.ts` + `tests/anemia-dst.test.ts` — Bel/Pl/K readouts.

A full Puppeteer/Playwright console-error harness for the exec SPA is a future R4 (demo hardening) item; until then the manual checklist above is the gate.
