# UI cohesion & persona matrix (phase U)

The platform has **two consoles with one identity model**. Cohesion means a
persona who is an *administrator* and an *executive reviewer* should never feel
they crossed a product boundary — the terms, the state colours, the "who may act
where" rules and the Bel/Pl/K language are identical everywhere.

This document is the single source of truth for the U phase:

1.  **Console charter** — what each console is for (so no page is duplicated).
2.  **Persona × page matrix** — which page is primary/read/review for each role.
3.  **Terminology glossary** — one name per concept across both consoles.
4.  **Shared interaction & state rules** — to be applied during the cohesion sweep.

---

## 1. Console charter

| Console | Route | Audience | Job | Not for |
|---|---|---|---|---|
| **Admin / setup console** | `/admin/ui/` | Console Administrator, Ops | Configure the world: organization, realms, facilities, measure packs, agent manifests, releases, topics, red-team scenarios, submissions. | Day-to-day clinical/operational review. |
| **Exec / business console** | `/exec/` | Executive (admin), Medical Director, Safety, Nurse, Ops (read) | Operate on live state: My Work, swarm control (live wall), outcome command, patient intelligence (+ early-warning watch), anemia & ESA CDSS, facility ops, CMS, assurance, configuration. | Raw configuration CRUD (kept in admin console). |

Rule: **setup lives in Admin; operations live in Exec.** A cross-console deep link
always lands on the *review* surface in Exec (e.g. open an outcome episode from
Admin's scenario results → Exec Outcome Command), never the other way.

---

## 2. Persona × page matrix

Roles are enforced server-side (consoles + capabilities via `/api/context`; the
server assembles My Work and never trusts the browser). This matrix is the *design*
contract that the server mirrors.

Legend: **P** primary · **R** review/read · **A** act/approve · **—** out of scope.

### Exec — Operate group

| Page (nav id) | Admin (executive) | Medical Director (md) | Safety | Ops/Operator | Nurse |
|---|---|---|---|---|---|
| My Work (`my-work`) | P · A | P · A | R | R | R |
| Swarm control / live wall (`ecosystem`) | P · A | R | R | P · A | R |
| Agent operations (`agents`) | R | R | R | P | — |
| Outcome command (`command`) | P · A | P · A | A (escalations) | R | R |
| Patient intelligence (`patient`) + early-warning watch | R | P · A | R | R | P |
| Anemia & ESA CDSS (`anemia`) | R | P · A (Class C) | R | — | R |
| Facility operations (`facility`) | R | R | R | P · A | — |
| Assessment intelligence (`assessments`) | R | P | R | R | R |

### Exec — Understand + Govern

| Page | Admin (executive) | Medical Director | Safety | Ops | Nurse |
|---|---|---|---|---|---|
| Shared intelligence (`intelligence`) | P | R | R | R | — |
| Executive outcomes (`executive`) | P | R | R | R | — |
| CMS operations (`cms`) | R | R | R | P · A | — |
| AI assurance (`assurance`) | P · A | R | P · A | — | — |
| Platform admin (`admin` — banner to /admin/ui/) | P | — | — | R | — |
| Configuration studio (`configuration`) | A (release approve) | — | A (red-team) | A (validate) | — |

**Cross-role rule:** a Class C (ESA/anemia) or Class B (episode) action is
*always* visible in My Work with its D-S readout; the role that can act sees the
action buttons; everyone else sees the item read-only.

---

## 3. Terminology glossary (one name, everywhere)

| Canonical term | Synonyms to remove | Meaning | Where surfaced |
|---|---|---|---|
| **Outcome episode** | loop, workflow, task | A governed state machine (Observed → … → Resolved) over evidence | Outcome command, My Work, ledger |
| **Cell** | agent, bot (in exec copy) | Bounded specialist with eval gate + kill switch, Class A–D | Swarm control, Agent ops, Configuration |
| **Next-best action (NBA)** | action card | Ranked, role-scoped proposal | Swarm control, My Work |
| **My Work** | queue, inbox | Server-assembled role-scoped decisions | Exec primary nav |
| **Bel / Pl / K** | confidence %, score | Dempster–Shafer readout: commitment / plausibility / conflict | My Work rows, ESA suggestion, early-warning watch, NBA rows |
| **Evidence posture** | status | corroborated · weak · contested (→ held for human) | All D-S readouts |
| **Deterioration watch** | alert list | Multi-signal early-warning (vitals+labs+missed-Tx+ESA) | Patient intelligence |
| **Realm / Facility / Twin** | world, site | Realm = simulation/tenant scope; facility = operating unit; twin = projected state | Ontology, Swarm control, Facility ops |
| **Action class A/B/C/D** | — | Autonomy class; C/D always human-in-the-loop | Cells, My Work, anemia |
| **Synthetic** | fake, mock, demo-only | Explicit honesty label (synthetic patient data) | Every data-bearing page |
| **Coverage / lab density** | — | Advisor's in-domain support gate (ESA) | Anemia & ESA |
| **Source reliability α** | weight | Reliability dial (realm-ledger 0.95 → synthetic 0.3) | Evidence chips, tooltips |

---

## 4. Shared interaction & state rules (applied in the U sweep)

1. **Bel/Pl/K presentation** — always the triplet with a posture tone
   (`corroborated` mint / `weak` amber / `contested` violet or red). Auto-flags
   require high Bel **and** low K; contested never auto-flags. Do not show a bare
   percentage where the triplet belongs.
2. **Session-expiry handling** — every Exec data page must tag 401s and render the
   shared "Session expired — sign in again" banner (the anemia panel already does;
   generalize to all pages in U#7) instead of a raw network error.
3. **Empty / loading / error** — loading uses the orbit module state; empty uses
   the shared `EmptyView` with a next action; errors are inline notices with a
   refresh/reconnect affordance. Never a frozen screen or a JS crash box.
4. **Synthetic labels** — any number derived from sim/catalog/reference data is
   labelled synthetic in the page header; no silent mixing of synthetic and real.
5. **Cross-console deep links** — Admin results → Exec review surface, never a
   detached page. Exec "Platform admin" nav banner points to `/admin/ui/`.
6. **Live vs replay** — a live wall shows `LIVE · <driver>` (redis-streams /
   in-process) with retained count; replay controls are clearly "replay", never
   confused with live telemetry.
7. **Tone tokens** — shared `#98aec0`-family tokens; red is reserved for risk /
   escalation / contested-harm, amber for watch, mint for verified/reassured.

---

## 5. Phase U work items

- **U#6 (this doc)** — persona×page matrix + glossary + interaction rules.
- **U#7** — generalize the session-expiry/state handling to every Exec page;
  sweep Bel/Pl/K presentation to the shared rule.
- **U#8** — UI health check (page-error/console scan, keyboard tab, contrast AA,
  responsive, no clipping) + visual cohesion sweep against section 4 rules.

See `docs/renal-enterprise-roadmap.md` for the delivery order and done-definitions.
