# Platform admin & Configuration studio — ownership analysis

**Question asked:** exec has *Platform admin* and *Configuration studio*; those
belong in `admin/ui`, there are overlaps, and configuration appears to read YAML
rather than Postgres. How do we move/enhance them?

**Short answer:** the move is already the documented design — exec has simply
drifted from it. But it is *not* a UI move. The API is scoped by **which console a
prefix belongs to**, not by domain, so the same domain is exposed under two
prefixes with two different role scopes. That is why the ops console already
contains pages that cannot work for ops roles. Moving the pages without
re-homing the APIs would move the problem.

---

## 0. This is drift, not a new decision

`docs/ui-cohesion-persona-matrix.md` already states the charter:

| Console | Job | Not for |
|---|---|---|
| Admin / setup (`/admin/ui/`) | Configure the world: organization, realms, facilities, measure packs, agent manifests, releases, topics, red-team scenarios, submissions | Day-to-day clinical/operational review |
| Exec / business (`/exec/`) | Operate on live state with the role-scoped decision queue | **Raw configuration CRUD (kept in admin console)** |

> Rule: **setup lives in Admin; operations live in Exec.**
> — §1

And §4 rule 5 says, verbatim:

> Exec "Platform admin" nav banner points to `/admin/ui/`.

So the intended shape of exec's Platform admin was **a banner**, not a second
implementation. `docs/design-tokens.md`-style drift happened instead: exec shipped
full local implementations of both pages, and the ops console grew its own copies.

---

## 1. What exists today

### exec (`/exec/`, React SPA)

| Nav | Component | Reaches the API via |
|---|---|---|
| Govern → **Platform admin** (`admin`) | `admin-console.tsx` | `fetchAdminConsole` / `mutateAdminConsole` → `/admin/swarm/admin/*`, `/admin/swarm/config/releases*`, plus a **client-side** agent override map |
| Govern → **Configuration studio** (`configuration`) | `configuration-studio.tsx` | `configurationAction` → `/admin/swarm/config/releases*`; everything else is derived from the catalog |

### admin-ui (`/admin/ui/`) — already ships both pages, twice

**Platform** (12 tabs): onboarding, organization, topic plan, **Configuration
Studio**, living cohorts, Observer studio, AI Assurance, Shared Intelligence ↗,
Executive Outcomes ↗, Release center, Dead-letter queue, Context API.

**Exec assets** (8 tabs): Config releases, Red team, CMS submissions, **Platform
admin**, Evidence reviews, Facility simulations, Knowledge notes, Substrate.

So there is already a page with each exec page's *name* in the ops console:

| exec page | admin-ui counterpart | Verdict |
|---|---|---|
| Platform admin (8-step wizard) | `ws-admin` (3 sections) | **subset**, and it calls exec-scoped APIs |
| Platform admin (same wizard) | `platform-onboarding` | **already the same 8-step journey**, gates derived from `/admin/platform/bootstrap` |
| Configuration studio | `platform-config` | same name, different content — see §2 |
| *(not in exec)* | `platform-releases` | Release center **with canary + rollback + immutable dossier** — exec lacks these |
| *(not in exec)* | `ws-releases` | a **second** release tab over the same store |

### Overlap beyond the two you named

Three more surfaces are duplicated the same way:

- **Release lifecycle** — admin-ui has Release center *and* Config releases (two
  tabs, one store). exec reaches a third view of it from Platform admin.
- **AI assurance** — exec `assurance` ↔ admin-ui `platform-assurance` + `ws-redteam`.
- **Agent configuration** — exec Platform admin edits agents; admin-ui has the real
  Agent Studio (173 rows, test/kill/rollback). exec's version is a dead write (§3).

---

## 2. The two pages, compared honestly

### Configuration studio

| | admin-ui `platform-config` | exec `configuration` |
|---|---|---|
| Pack registry + activate/deactivate (flips the exec lens) | ✅ real (`/admin/platform/packs`) | — |
| Policy & workflow (PUT) | ✅ real | read-only lines in a tab |
| Config objects | — | **7 read-only pseudo-YAML tabs** |
| Adapter / source mapping table | — | ✅ (from the `source-mapping` catalog) |
| Promotion gates | — | **invented 5-gate model** (§3e) |
| Catalog cards | — | **hardcoded numbers** (§3e) |
| Release lifecycle | separate tabs (canary, rollback, dossier) | create/validate/approve only |

Neither is a superset. The union is the real page, and the admin-ui half is the
half that is backend-backed.

### Platform admin

exec's is a wizard; admin-ui `ws-admin` is a flat 3-section form. But admin-ui
**already has the wizard** — `platform-onboarding` renders the same 8 steps
(organization → identity → integrations → topics → packs → agents → release →
activate) from `/admin/platform/bootstrap`, with every gate **derived from real
backend state**.

So exec's Platform admin contributes: a topic-mappings textarea, and an agent
configuration step that does not persist. That is the whole delta.

---

## 3. Defects the analysis surfaced (all measured, not inferred)

### (a) The ops console asks for exec-scoped data, and gets a wrong number

`api-auth.ts` scopes by URL prefix:

```
/admin/swarm/*  → exec roles  (admin | md | safety)
/admin/platform/* and everything else /admin/* → ops roles (admin + nurse/pharmacist/coder/auditor/facilities-tech)
```

Measured live, auditor (ops-only) vs admin:

| Endpoint | auditor | admin |
|---|---|---|
| `/admin/swarm/admin/policy` | **403** | 200 |
| `/admin/swarm/admin/tenant` | **403** | 200 |
| `/admin/swarm/config/releases` | **403** | 200 |
| `/admin/swarm/red-team/scenarios` | **403** | 200 |
| `/admin/platform/packs` | 200 | 200 |
| `/admin/platform/assurance` | 200 | 200 |
| `/admin/platform/bootstrap` | 200 | 200 |

Consequences **today**:

- **7 of the 8 "Exec assets" tabs** call `/admin/swarm/*`. For any ops role other
  than `admin` they are 403 — most render an error card, which is at least honest.
- `renderPlatformConfig` does **not** render an error. It swallows the 403
  (`catch { /* ignore */ }`, `admin-ui/index.html:4875`) and renders its hardcoded
  defaults instead:

  | | escalation | min | max |
  |---|---|---|---|
  | real policy (`/admin/swarm/admin/policy`) | **8200** bp | **7000** | **9500** |
  | shown to a non-admin by `platform-config` | **5000** | **0** | **10000** |

  A governance console displaying a *plausible wrong threshold* as fact is a
  serious defect **in kind**. There are **9** of these silent
  `catch { /* ignore */ }` fallbacks in admin-ui's platform/exec-asset pages.

  **Correction (measured after the first three slices shipped).** It was a
  *latent* defect, not a live one, and the earlier draft of this document
  overstated it as "the most serious finding". `ROLE_NAV`
  (`admin-ui/index.html:893`) grants the **Platform** and **Exec assets** sections
  to no non-admin role, and `goTo` enforces that (`viewAllowed`, `:1967`) — an
  auditor calling `goTo('platform-config')` is redirected to the dashboard
  (verified). So the only role that could open the page was `admin`, which reads
  `/admin/swarm/admin/policy` successfully, and the fallback never rendered for
  anyone. It was fixed anyway because it would fire the instant a non-admin were
  granted the section, and because it disguised the real scope mismatch instead
  of surfacing it.

  The genuinely **live** defects are the ones visible to exec users today: the
  fabricated filenames and hero numbers (§3b, §3e), the invented gate model
  (§3e) and the dead agent-configuration write (§3c).

### (b) The configuration "YAML" does not exist; the real YAML is invisible

`configuration-studio.tsx` renders a read-only file editor whose header is
`{tab}/{filenames[tab]}` (line 65–72):

```
adapters/riverbend-fhir-r4.yaml      events/hospital.transition.v2.yaml
cells/continuity-cell.yaml           measures/ktv-comprehensive.yaml
policies/action-boundary.yaml        domains/domain-packs.json
```

**None of those files exist.** `domain-packs.json` exists only inside the
unadopted `renal-swarm-intelligence/` prototype directory. The tab bodies are
generated at render time by `configCodeFor()` from three catalog documents
(`operatingModel`, `domainPacks`, `runtimePolicy`) which **are** in Postgres
(`swarm_workspace`).

So the *content* is durable and the *labelling* is fiction. That is the entire
"configuration reads from YAML" impression — and it is a labelling bug, not a
storage bug.

Meanwhile the one genuinely file-based configuration in the product is **not in
this studio at all**:

- **452 agent specs** at `packs/*/agents/*.yaml` + `packs/*/drafts/*.yaml`, read by
  `AgentAuthoringService` with `readdirSync`/`readFileSync` (`src/server/agent-authoring.ts:87,112`)
- "publishing" a draft **renames a file** onto `agents/<id>.yaml` (`:144–181`)
- no Postgres row, no audit row beyond a JSONL append, not reachable from either
  console's config surface

And there are **two competing "agent" concepts**: those 452 specs, and the
`agent-manifest` catalog (12 swarm cells) which *is* in Postgres and *is* editable
in the ops console. Whichever one an operator thinks "the agents" are, the other
one is somewhere else.

### (c) exec's agent configuration is a dead write

`harness.ts:1346` declares `const agentOverrides = new Map<...>()`. `save-agent`
writes it (`:1369`) and **nothing ever reads it** — `adminSnapshot()` (`:1241`)
builds agents from the cell list. The UI reports success and discards the edit.

### (d) Two release APIs over one store

`/admin/swarm/config/releases` (swarm-routes) and `/admin/platform/releases`
(platform-routes) both call the same `ws().createReleaseDraft/validateRelease/
approveRelease/activateRelease` on the same `config-release` workspace kind. The
platform family adds `canary/rollback`; the swarm family adds `DELETE`. exec uses
the first, the ops console uses both — so the same dossier renders two ways and
"which buttons exist" depends on which tab you opened.

### (e) An invented gate model, and hero numbers that are literals

`configuration-studio.tsx` presents a "five enforced gates" promotion contract
(Schema → Replay → Evaluate → Approve → Release, lines 127).

The real gate models are:

- `validateRelease` → gates **Schema / Green / Red / Integration / Promotion**
  (durable, per-release, surfaced in admin-ui Release center)
- `evaluateRelease` (`src/swarm/release.ts`) → verdict `ship|hold|block` scored
  from green pass rate, red containment, source currency and approvals **with
  per-check evidence**, served at `GET /admin/swarm/release-gate`

The studio's five gates are a third, unbacked rendering whose step states are
driven only by "does a release object exist".

Hardcoded hero numbers in the same file: `126 tests passed` (:105),
`Active versions 18` (:146), `Replay fixtures 64` (:147), `Rollback coverage 100%`
(:148), and `renal-harness-2026.08.5` as the "packaged baseline" in **5 places**
(:99, :103, :120, :127). None of these come from the backend.

---

## 4. Root cause

**The API prefix encodes *which console*, not *which domain*.** The same domain is
therefore exposed twice with two different role scopes:

| Domain | exec-scoped prefix | ops-scoped prefix |
|---|---|---|
| Release lifecycle | `/admin/swarm/config/releases` | `/admin/platform/releases` (+ canary) |
| Red team / assurance | `/admin/swarm/red-team/*` | `/admin/platform/assurance`, `/admin/platform/red-team/run-suite` |
| Action policy | `/admin/swarm/admin/policy` | — *(nothing — this is the hole)* |
| Tenant / Kafka | `/admin/swarm/admin/*` | — *(nothing)* |

Pages were then placed into a console **by name**, and each page calls whichever
prefix it happened to be written against. A page is usable only when its console
and its prefix agree, and today that is true only for `admin` (the one role in
both consoles) — which is exactly why the breakage has gone unnoticed.

---

## 5. Target model

**One page per concern. The console is chosen by the role scope of the data, and
the API prefix follows the domain.**

| Concern | Owner console | API | Change needed |
|---|---|---|---|
| Organization / tenant profile, environment, region | ops | `/admin/platform/organization` | re-home from `/admin/swarm/admin/tenant` |
| Kafka / integration contract + test | ops | `/admin/platform/integrations` | already exists |
| Topic plan | ops | `/admin/platform/topics` | exists |
| Action-boundary policy | ops | `/admin/platform/policy` | **new** (only in swarm today) |
| Pack registry + lens activation | ops | `/admin/platform/packs` | exists |
| Configuration objects (ontology, policy, catalogs) | ops | `/admin/platform/config-objects` | **new**, over existing `swarm_workspace` kinds |
| Release lifecycle incl. canary/rollback/dossier | ops | `/admin/platform/releases` | retire the swarm twin |
| Release gate evidence | ops (read in exec) | `/admin/platform/release-gate` | re-home from `/admin/swarm/release-gate` |
| AI assurance: findings, green/red runs | ops | `/admin/platform/assurance` | exists; retire `ws-redteam`'s swarm twin |
| Agent spec lifecycle (the YAML) | ops | `/admin/platform/agents` | exists; **make it durable** (§6 slice 4) |
| Swarm cells, insights, NBAs, episodes | exec | `/admin/swarm/*` | **unchanged** — exec scope is correct here |

Exec keeps what is genuinely a decision: My Work, swarm control, outcome command,
patient/protocol intelligence, facility ops, CMS operations — plus a **read-only**
gate/assurance view and a `↗ Open in operator console` link, which is the pattern
the charter and admin-ui's `↗` rsi-* links already use.

### The one thing to decide first

`md` and `safety` are exec-only roles and currently *can* reach Platform admin and
Configuration studio. Moving the pages to the ops console removes that. Three
options:

1. **Accept it.** Setup is an admin/ops activity; clinical roles never needed it.
   (Cheapest, and consistent with the charter's "Not for" column.)
2. **Read-only mirror in exec.** exec's Configuration studio becomes a *release
   and gate review* page — real data, no writers — with an `↗` link to edit.
   (Keeps the exec page meaningful and is what §3(e)'s real gate model supports.)
3. **Re-scope the APIs** to `admin ∪ exec` by adding an `exec` allow-list for the
   config prefixes. (Widest blast radius; I'd avoid it.)

The charter's Configuration-studio row already describes option 2's spirit: exec
roles' entries there are *approve / red-team / validate* — approvals, not CRUD.

---

## 6. Migration plan

Ordered so that no slice leaves a console broken. Each slice is independently
shippable.

### Status

| # | Slice | State |
|---|---|---|
| 0 | Stop lying | **Partly done** — admin-ui rewritten with explicit failure states and the fabricated content removed from the ops side; the exec-side items (fabricated filenames, invented gates, dead agent write) still stand: they are §6a below |
| 1 | Re-home the API by domain | **Done** — `src/server/ops-config-routes.ts` serves the setup surface under `/admin/platform/*` over the same workspace documents; the swarm twins still exist for exec |
| 2 | Consolidate the ops console | **Done** — Platform admin and Configuration studio merged; the `Exec assets` section removed; 33k+33k+6k bytes of unreachable exec-scoped code deleted |
| 3 | Reduce exec to banner + review | Not started (needs Decision A's remaining half — see below) |
| 4 | Agent specs durable | Not started (independent) |
| 5 | One release lifecycle | Not started |

Measured outcome of 1+2: admin-ui went from **20 "platform" tabs across two
sections** to **10 tabs in one section**, and from **31 distinct
`/admin/swarm/*` call sites** to **zero**. Every page the operator console still
serves is now ops-scoped, so the 403 class of bug is structurally gone rather than
hidden.

**Decision A, remaining half.** "Accept it" settles that clinical roles do not
need setup pages, but `ROLE_NAV` grants **Platform to no non-admin role at all**,
so today "setup lives in Admin" means "setup lives with `admin`". And the console
has no read-only mode: granting Platform to `auditor` would hand over the Save
and Activate buttons along with the read. How to resolve it is a policy call, not
a refactor:

1. leave Platform admin-only (current behaviour, nothing more to build);
2. add a read-only rendering mode and grant that to `auditor`;
3. grant Platform to specific ops roles and accept that they can write.

### Slice ledger

Sizing measured against the tree, not estimated. "Sites" = every reference in
`src/`, `exec-app/src/`, `admin-ui/index.html`, `tests/` and `scripts/`.

| # | Slice | Touches | Size | Depends on | Risk |
|---|---|---|---|---|---|
| 0 | Stop lying (defects in place) | `admin-ui/index.html` (9 catches, 2 pages), `configuration-studio.tsx`, `harness.ts` | ~9 + 3 edit sites; no API, no nav, no tests | — | **Low** — but it changes what a non-admin sees on those pages, from fake data to an error |
| 1 | Re-home the API by domain | new `/admin/platform/{organization,policy,release-gate}`; 75 call sites (`swarm/admin/` 39, `config/releases` 22, `release-gate` 14); 5 test files | ~6 route definitions + 75 sites | 0 | Medium — a missed site is a silent 403 |
| 2 | Consolidate the ops console | 19 render fns (~700 lines) in one 7,946-line file; NAV 20 tabs → 10 | largest UI change | 1 (a page can't call a prefix that doesn't exist yet) | Medium–high **for verification** — admin-ui has no build step |
| 3 | Reduce exec to banner + review | delete 2 components (546 lines), 3 harness fns, 2 nav ids, 2 `NavigationId`s, 1 `demoSteps` entry, 2 render cases | 546 lines deleted, ~60 added | 2 + **Decision A** | Medium — the guided demo dies if nav/union/dispatch disagree |
| 4 | Agent specs durable (the real YAML→Postgres) | new `agent-spec` kind; rewrite `AgentAuthoringService`; importer for 452 files; exporter; ops Agent Studio | biggest functional change | **none** (independent) | **High** — it is the agent runtime's source of truth |
| 5 | One release lifecycle, one gate model | delete `/admin/swarm/config/releases*` (22 sites), add `DELETE` to the platform family, converge gate rendering | ~22 sites | 1 + 3 | Medium |

Tests that move with Slices 1/5: `assurance.test.ts`,
`swarm-workspace-routes.test.ts`, `swarm-release.test.ts`,
`security-isolation.test.ts`, `anemia-governance.test.ts`.

### Decision gates (each blocks a slice)

- **A — do `md`/`safety` keep a page?** Blocks Slice 3. `admin` is in both
  consoles; `md`/`safety` are exec-only, so removing the pages removes their
  access. Options: accept / read-only mirror (recommended) / re-scope the APIs.
- **B — alias or hard cutover?** Shapes Slices 1 and 5. Keeping the swarm paths as
  deprecated aliases makes the migration reversible but leaves two spellings for
  one endpoint during the window.
- **C — are agent specs the source of truth, or the export?** Shapes Slice 4. If
  YAML stays authoritative, the DB holds an index and the console is a viewer; if
  the DB becomes authoritative, publishing stops being a file rename and the
  `packs/` tree becomes an artifact. The second is the one that fixes the gap, but
  it is a real change of contract for the agent runtime.

### Slice 0 — fix the four defects in place (no moves)

1. Replace every silent `catch { /* ignore */ }` in the platform/exec-asset pages
   with the existing explicit error state (`state-card` + `err`), so a denied read
   is never rendered as a default. **This is the highest-value change in the whole
   plan and it is small.**
2. Delete the dead `agentOverrides` write, or wire it — do not leave a save button
   that discards.
3. Remove the fabricated filenames, the invented five-gate strip and the five
   hardcoded hero numbers from exec's studio (§3b, §3e).
4. Replace the studio's promotion block with the **real** `validateRelease` gates
   and `evaluateRelease` verdict, read from the backend.

*Done when:* as `auditor`, Configuration Studio shows the real 8200 bp — or an
explicit "not permitted" — never 5000.

### Slice 1 — re-home the API by domain

Add `/admin/platform/{organization,policy,release-gate}` (ops-scoped) over the
same workspace documents. Keep the swarm paths as deprecated aliases for one
release, then delete. Update both consoles to the platform family.

*Done when:* every page in either console lists exactly one prefix family, and
`tests/api-security.test.ts` asserts scope per endpoint (extend it — the guard is
prefix-based, so a re-home without a test is a silent 403 waiting to happen).

### Slice 2 — consolidate the ops console

- Merge `ws-admin` + `platform-onboarding` + `platform-org` + `platform-topics`
  into **one Platform admin page** (the wizard, with derived gates + the org/kafka
  forms the wizard already collects).
- Merge `platform-config` + `ws-releases` + `platform-releases` into **one
  Configuration studio** with tabs: Packs · Policy · Config objects · Release
  lifecycle · Gate evidence · Adapter mappings.
- Delete the `Exec assets` section (8 tabs), redistributing them: Red team → AI
  Assurance; Substrate/Ontology/Catalogs → Configuration objects; CMS submissions
  → the CMS area; Evidence reviews → Living cohorts / My Work; Facility
  simulations → Facility operations.

Net: **20 tabs → 10 pages** (plus the existing `↗` links to Shared Intelligence and
Executive Outcomes), one release lifecycle, one gate model.

*Done when:* the ops console has exactly one page per concern and no tab is a
subset of another.

### Slice 3 — reduce exec to a banner + review

Delete the `admin` and `configuration` nav ids and components. Replace with
`↗ Open in operator console` plus a read-only gate/release review panel (option 2
above). **Remember the guided demo**: `demoSteps` step 6 targets `configuration`
(`app.tsx`), so remove/repoint it and the `NavigationId` union member, or demo mode
navigates to a dead view.

*Done when:* exec has no writer for tenant/Kafka/policy/pack/release config, and
`/exec/` has no broken nav.

### Slice 4 — the real YAML→Postgres work: agent specs

Add an `agent-spec` workspace kind and make `AgentAuthoringService` write to it:

- draft/published rows in Postgres with content hash, author, timestamps
- publish = a state transition, **not a file rename**
- the `packs/*/agents/*.yaml` tree becomes an **export** (`Materialize to packs/`)
  driven from the DB, plus an importer for the existing 452 files
- audit through the existing audit chain; killed/rolled-back state already lives in
  `agent-kill-switch` / `agent-rollback` kinds
- surface it on the ops console Agent Studio (create/edit/validate/publish/delete),
  which today reports on files it cannot author

*Done when:* an operator can create, edit, validate and publish an agent entirely
through the console, restart the server, and the change is still there — with no
hand-edited YAML on the path.

### Slice 5 — one release lifecycle, one gate model

Delete `/admin/swarm/config/releases*`, point everything at
`/admin/platform/releases`, and make the studio's promotion view render
`validateRelease` gates + `evaluateRelease` evidence. Add `DELETE` to the platform
family so nothing is lost.

---

## 7. Risks and traps

- **Prefix-based authorization.** Moving a page without moving its API yields a
  silent 403; the guard lives in `src/server/api-auth.ts` and matches on
  `url.startsWith('/admin/swarm/')`. Always change guard + both consoles in one
  commit, and assert scope in a test.
- **`md`/`safety` lose setup** unless you take the option-2 mirror (§5).
- **`/exec` serves `exec-app/dist`** — rebuild before verifying; admin-ui is served
  from disk with no build step but the browser keeps its loaded document.
- **The workspace singleton is process-global** in a vitest worker, so page-merge
  tests can be poisoned by an earlier file's admin policy (known trap: reset the
  policy to `block` and close findings).
- **Deleting nav ids is not just a nav edit** — `NavigationId`, `navGroups`,
  `demoSteps`, and the render dispatch must all agree, or the guided demo targets a
  view that no longer exists.
- **Two release APIs over one store** must be collapsed in the same slice as the
  page merge, or the console will keep showing two dossiers for one release.

---

## 8. Recommended first step

Slice 0 item 1 — replace the silent fallbacks. It is small, it is a real defect
today (a governance console showing 5000 bp when the policy is 8200), and it makes
every later slice easier to verify because a denied read will announce itself
instead of masquerading as data.

Then decide §5's `md`/`safety` question, because it determines whether exec keeps a
page or keeps only a link.
