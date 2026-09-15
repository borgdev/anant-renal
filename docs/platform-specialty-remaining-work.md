# Platform-first specialty implementation — remaining work

**Analysis date:** 2026-09-15
**Branch:** `platform` @ `d7abd7d` + this slice
**Plan analysed:** `docs/platform-specialty-implementation-plan.md`

This is a gap analysis of the implementation plan against the code. Each finding
names the evidence, whether it blocks the plan's own exit criteria, and the size
of the fix. Where a phase is marked *complete* in the plan but does not meet its
own exit criteria, that is stated as such — a phase that is complete on
deliverables but not on criteria is not complete.

---

## 1. Where the plan actually stands

| Phase | Plan status | Actual status | Blocking gap |
| --- | --- | --- | --- |
| 0 — baseline and contracts | complete | complete | none |
| 1 — platform hardening | complete | complete | none |
| 2 — EMR certification | harness complete | harness complete | vendor sandbox access (external) |
| 3 — specialty pack contract | complete | **metadata + lens complete; routes not** | packs cannot contribute routes |
| 4 — Renal pack v1 | planned | **substantially not started as a pack** | renal routes are registered by the platform |
| 5 — second specialty | planned | **partially done, unvalidated** | payer is a pack, but not a second *product* |
| 6 — multi-specialty scale | planned | **not started, and one design decision blocks it** | single-active-pack activation model |

The single most important line in this table is Phase 3's exit criterion:

> **Renal is no longer a special-case code path in the platform shell**

It is not met. `src/server/app.ts` makes **36 route-registration calls**, and
**11 of them register renal-specialty modules by name** (lines 465–571):

```
registerAnemiaRoutes, registerRenalRoutes, registerProtocolRoutes,
registerAdequacyRoutes, registerFluidRoutes, registerRoundRoutes,
registerAccessRoutes, registerMbdRoutes, registerNutritionRoutes,
registerInfectionRoutes, registerCrossPackAssuranceRoutes
```

The last one is worth noting because it is the shape of the problem: it is
`assurance-track-routes.ts` imported *as* `registerCrossPackAssuranceRoutes` to
avoid colliding with the platform's own `registerAssuranceRoutes`. A reader
grepping for `AssuranceTrackRoutes` finds nothing, and a reader grepping for
`registerAssuranceRoutes` finds the platform's Phase E module instead.

Counts are reproducible: `grep -cE "^\s*await register" src/server/app.ts` → 36.
Beware the looser `grep -c register.*Routes`, which returns **68** because it
also counts the 32 import lines — an easy way to overstate this gap by 2×.

A new specialty still means editing the platform's boot file. The metadata side
of the contract is real and enforced; the **behavioural** side is not. That is
the gap between Phase 3 and Phase 4, and it is the reason Phase 4 says "Renal
works as a pack, not as a product-specific code branch".

---

## 2. The structural gaps, in dependency order

### G1 — A pack cannot contribute routes (Phase 3 criterion, Phase 4 exit criterion)

**Evidence.** `app.ts` makes 36 route-registration calls, **11 of them renal
protocol modules by name** (see §1 for the list and the grep). Every pack under
`packs/` exports data and pure functions; none exports a route contribution.

**Why it blocks.** Phase 3's exit criterion ("introduced through pack
registration only") and Phase 4's ("Renal works as a pack, not a
product-specific code branch") are the same requirement seen from two sides.
Phase 5's "adding a second specialty requires pack package work, not core
architecture changes" also cannot be satisfied: adding oncology means editing
`app.ts`, which is core architecture.

**Fix shape.** A `PackRouteContribution` on the pack contract
(`{ id, register(app, deps) }`), collected from the installed pack set and
registered in a loop. The platform keeps ownership of the *seams* it must own —
`api-auth` role scoping, the FHIR error handler, the workspace store — and the
pack owns only its own endpoints.

**Size.** Medium-large. The interface is small; the migration is 11 modules.
Do it one pack at a time: define the contribution, migrate the *smallest* pack
(`ckd-navigation` or `payer`) as proof, keep the rest registered the old way
behind a documented list, and track the burn-down. Do not attempt all 11 at once.

**Risk if skipped.** Every future specialty copies the current shape, and
"platform" becomes a word the code does not honour. This is the highest-value
remaining item in the plan.

**Progress.** Phase 1 **done**, using `payer` as the proof pack (not a fixture):
`src/control-plane/pack-contributions.ts` defines `PackRouteContribution` with a
`scope` that maps onto the existing `api-auth` URL-prefix authority, validates
`duplicate-contribution-id` / `duplicate-prefix` / `missing-prefix` /
`invalid-prefix` / `prefix-outside-scope-namespace`, and `app.ts` now registers
contributions from the installed pack set. `src/server/payer-routes.ts` is
deleted and `packs/payer/routes.ts` serves it.

Two things phase 1 settled that the *burn-down* inherits. First, `payer` was
chosen because it was **absent from the test suite's pack set and still served
unconditionally** — migrating it exposed that the platform was serving a
specialty's endpoints in a deployment that had not installed it. An absent pack
is now **404, not 403**: the route does not exist, it is not a permission an
operator could be granted. Second, the surface a pack must contribute is
**plural** — routes today, and `assurance-track.ts`'s hand-written renal list
tomorrow (G4), and its screens after that (G5).

**Remaining burn-down (11 modules, `app.ts` lines ~465–571):**
`anemia`, `renal`, `protocol`, `adequacy`, `fluid`, `round`, `access`, `mbd`,
`nutrition`, `infection`, `cross-pack-assurance`. One at a time, each proving a
new shape the interface must support rather than a repetition of the last.

### G2 — Only one pack can be active at a time (Phase 6, and a Phase 5 correctness issue)

**Evidence.** `SwarmWorkspaceStore.activatePack` is single-document
(`pack-activation`, `list()[0]`). `/api/context` resolves one `pack`. Activating
`payer` today means renal is no longer active.

**Why it blocks.** Phase 6's deliverable is "multi-pack runtime model is proven".
A real customer is not one specialty: a dialysis organisation with a CKD
navigation programme and a payer contract needs three packs live at once. The
current model forces a choice that no customer faces.

**Fix shape.** Make activation a set — an ordered list of active packs with a
primary (for the lens) and the rest contributing routes, measures and events.
`/api/context` reports the set plus the primary lens.

**Size.** Medium. The store change is small; the fan-out (context, lens choice,
route registration from G1, measure registry) is where the work is.

**Dependency.** G2 is much easier *after* G1, because a multi-pack runtime
without pack-contributed routes has nothing to compose.

**Also worth stating plainly:** the plan's Phase 5 can be satisfied while G2 is
open — one *lens* at a time is survivable for two specialties if they are not
sold together. It stops being survivable at three, which is Phase 6.

### G3 — Cross-pack workflows are dead code (Phase 4, Phase 6)

**Evidence.** `src/control-plane/cross-pack-workflows.ts` defines
`HOSPITALIZATION_TO_PAYER_AUTH`, `DENIED_AUTH_TO_RESCHEDULE_AND_APPEAL` and
`ONCOLOGY_PLAN_TO_PRIOR_AUTH` with a `CrossPackRouter`. The only reference
anywhere in `src/` is its own definition — `CrossPackRouter` is constructed in a
test (`tests/new-modules.test.ts:323`) and **nowhere in production**.

**Why it blocks.** The renal→payer handoff (a hospitalization that opens a prior
authorization) is the concrete thing that makes a multi-specialty platform worth
more than two separate products. It exists as a data structure and never runs.

**Fix shape.** Wire the router into the realm/broker event path so a declared
cross-pack trigger fires, and have the manifest's `workflows[].cross_pack_with`
(the invariant added in this slice) *be* the declaration the router reads.

**Size.** Medium. The pieces exist; the wiring does not. G2 is a partial
prerequisite — a cross-pack workflow needs both packs loaded, though not
necessarily both "active" if the router reads the installed set.

### G4 — "Cross-pack" assurance enumerates renal packs in code (same root as G1)

**Evidence.** `src/swarm/assurance-track.ts` holds a **hand-written list of the
seven renal packs** with their coverage defaults and artifact probes (ESA,
adequacy, fluid, access, MBD, nutrition, infection), each wiring a specific
`artifactProbe` function.

**Why it matters.** The view it feeds is called *Cross-pack assurance* and its
whole claim is that it reads the installed pack set. It reads seven names typed
into a platform module. A new specialty is invisible to it until someone edits
this file — the same defect as G1, in a second place, and the reason "just add a
route" understates the work: **contribution surfaces are plural.** The audit for
G1 must sweep for every place the platform enumerates specialties by name, not
only route registration.

**Size.** Small once the contribution interface exists: the probe becomes part of
the pack contribution, and the list becomes a loop over installed packs.

### G5 — A specialty cannot add a *view* without an exec-app change (same root as G1, one layer up)

**Evidence.** `PLATFORM_NAV_IDS` and the `unknown-lens-view` invariant let a lens
name only a view the shell already knows how to draw. Turning the renal
protocol strip into a per-lens menu *did* remove the hardcoded eleven tabs from
the shell — but it replaced them with a **fixed vocabulary of view ids** the
shell must be able to render. Declaring `views: [{id: 'oncology-regimen', …}]`
is refused as a blocking issue.

**Why it matters.** This is G1's defect one layer up. G1 was "a pack cannot
contribute a route"; G5 is "a pack cannot contribute a screen". Both mean a new
specialty needs a platform change, and the second is easy to miss because the
grouped submenu *looks* data-driven — it reads the installed pack set and
renders whatever the pack declares, up to the point where the pack asks for a
kind of screen the shell has never heard of.

**The fix — a view is a `kind` plus a data source, not an id.** Give the
platform a small vocabulary of generic renderers (`ranked-actions`, `queue`,
`table`, `timeline`, `detail`, `board`) and let a view declare
`{ id, label, kind, source }`. Renal's *Anemia & ESA* becomes
`kind: ranked-actions, source: /admin/swarm/anemia/state`; an oncology pack
composes unlisted generic views against its own endpoints.

The ranked-actions panel is *already* such a generic renderer — it renders
`Lead[]` from any endpoint — so this is a matter of naming a pattern the code
already has, not building one. `unknown-lens-view` then becomes
`unknown-view-kind` and the shell no longer needs to know a specialty exists in
order to draw it.

**Size.** Medium. Parser + contract change is small; the work is enumerating the
existing renal views onto generic kinds honestly (some will not fit and will
expose real coupling, which is the point of doing it).

---

## 3. Phase-by-phase deliverable audit

### Phase 2 — EMR certification (blocked externally, one item internal)

- [ ] Epic / Cerner / Athena sandbox runs — **blocked on vendor credentials**
      (marketplace enrolment, app registration, endpoint provisioning). No local
      work substitutes.
- [ ] EMR runbook approved by ops + clinical safety — **internal, not started.**
- **Open product decision:** Athena cannot be certified for the episode-Encounter
  write (`essentialBlocked: ['episode-encounter-write']`). Either declare that
  flow non-essential for read-only vendors, or scope Athena to a narrower
  offering. Until this is decided, Athena cannot be sold as a full integration.

### Phase 3 — specialty pack contract

Closed in this slice:

- [x] The lens surfaces only the views it declares (a payer console no longer
      renders the dialysis protocol strip — a real defect, not a hypothetical).
- [x] The manifest is the **source** of a pack's metadata where one exists,
      rather than a file that is merely compared to one.
- [x] A lens may only declare a view the shell can draw, enforced as a blocking
      invariant (`unknown-lens-view`) rather than rendering an empty tab.

Still open:

- [ ] **G1** — a pack cannot contribute routes.
- [ ] **9 of 23 pack directories ship no `manifest.yaml`**: `care-management`,
      `dialysis-deep`, `flagship-agents`, `infusion-provider`,
      `oncology-provider`, `policy-templates`, `primary-care-deep`,
      `research-pharma`, `urgent-care-deep`. The platform reports
      `manifest.present: false`, so it is visible rather than silent — but a pack
      without a manifest has no declared surface at all.
- [ ] **13 of 16 installed packs declare no specialty surface.** They load as
      dependencies, not as specialties. `dialysis-provider` and `payer` declare
      all five sections; `ckd-navigation` declares four.
- [ ] **11 of 12 renal packs have no manifest or declare nothing** at all. The
      renal *protocols* (anemia, adequacy, fluid, access, mbd, nutrition,
      infection) are not packs — they are `src/swarm/*.ts` modules with routes,
      and none of them declares an ontology, event contract or measure through
      the contract. This is the true content of Phase 4.

### Phase 4 — Renal pack v1 as the first pack

Substantially **not started as a pack**, though the functionality exists:
the seven protocol packs are implemented as platform-layer modules. What remains:

- [ ] Renal ontology declared through the contract (currently only
      `dialysis-provider`'s 12 concepts).
- [ ] Each protocol's measures bound to a declared CMS authority through the
      manifest (`mbd`, `nutrition`, `infection`, `adequacy`, `fluid`, `access`
      each own measures in code with no manifest declaration).
- [ ] **G1** — renal routes registered by the pack, not by `app.ts`.
- [ ] Renal dashboards as lens-declared views (partially done: the 11 views are
      now declared, but they point at shell components rather than
      pack-contributed ones).
- [ ] Renal can be enabled/disabled without affecting other domains — blocked by
      **G2** (single active pack).

### Phase 5 — second specialty expansion

Payer is the strongest candidate and is **further along than the plan assumes**:
it has a manifest with ontology (6 concepts), 10 event contracts, 4 workflows, 1
manifest-declared measure, a lens with terminology and an (empty) view set, its
own durable episodes (`payer.ts`), and a demo/state/reset route surface.

What is missing to call it done:

- [ ] Payer routes registered by the pack (**G1**) — today `payer-routes.ts` is
      registered by `app.ts`.
- [ ] Payer declared in the plan as the chosen second specialty (it is de facto,
      not by decision).
- [ ] "no core platform changes were required" — cannot be asserted while G1 is
      open, because adding any specialty changes `app.ts`.
- [ ] A written acceptance record: symptom → pack → measure → outcome on payer
      data, the way `docs/clinician-workflow-phases.md` does for renal.

### Phase 6 — platform maturity and multi-specialty scale

- [ ] Multi-pack runtime (**G2**).
- [ ] Cross-specialty events and measure sharing (**G3**) — the manifest
      invariant exists; nothing fires.
- [ ] Domain-specific policy composition — the action policy is a single global
      document; there is no per-specialty policy overlay.
- [ ] Cost and performance budgets — no budget exists per pack. The fleet
      governor (`src/simulator/governor.ts`) is fleet-wide, not per-specialty.
- [ ] Governance and enterprise rollout roadmap — not started.
- [ ] Audit and assurance across multiple packs — `assurance-track` exists and
      reads durable state per pack; it has never been exercised with two
      specialties live simultaneously (blocked by G2).

---

## 4. Defects found while writing this analysis

These were found by measurement, not by reading the plan. Each is small and
fixed or tracked.

1. **The shell rendered renal protocol tabs in every lens.** `PROTOCOL_VIEWS` was
   an 11-entry hardcoded array in `exec-app/src/app.tsx`, and the strip rendered
   whenever the active view was one of them — so a payer console showed Anemia &
   ESA, CKD-MBD, Infection and six more. **Fixed**: the strip is the **lens's**
   declared view set, and a lens may only surface a view the shell can actually
   draw (a new blocking invariant). Verified live: renal renders its 11 declared
   tabs, payer renders none.
2. **`views: []` was collapsed into "nothing declared"**, so the payer lens fell
   back to the built-in renal strip — the gap reproduced inside the fix for it.
   An empty declaration and an omitted key are different claims, and the parser
   now distinguishes them by the key's PRESENCE rather than the array's length.
   Found by running it, and pinned by a regression test that asserts both shapes.
3. **`CrossPackRouter` was constructed only in a test** (G3 above).
4. **`assurance-track.ts` names the seven renal packs in code** (G4 above) — the
   module behind the *Cross-pack assurance* view enumerates specialties rather
   than reading them, so a new pack is invisible to the assurance gate.
5. **A manifest that could not be parsed had gone unnoticed**
   (`packs/revenue-cycle`, fixed in the previous slice) — recorded here because
   it is evidence for the class of defect, not a one-off: nothing read these
   files.

---

## 5. Recommended order

| # | Item | Why now | Size |
| --- | --- | --- | --- |
| 1 | ~~**G1 phase 1** — define the route contribution, migrate one pack~~ **DONE** (`payer`) | Unblocked Phase 3's exit criterion and Phase 4's | S–M |
| 2 | **Sweep for every name-enumerated specialty** (G4 and its siblings) | "Just add a route" understates it; the contribution surfaces are plural | S |
| 3 | **G1 phase 2** — migrate the remaining renal protocol packs | Turns Phase 4 from "implemented" into "a pack" | M–L |
| 4 | **Declare the renal protocol packs' surfaces** (ontology, measures, event contracts) | Makes the conformance matrix honest about 7 of the 12 partial packs | M |
| 5 | **G2** — multi-pack activation | Required before a three-specialty customer exists; Phase 6 deliverable 1 | M |
| 6 | **G3** — wire cross-pack workflows | The multi-specialty value proposition, currently dead code | M |
| 7 | **G5** — a view becomes a `kind` + data source | Removes the last per-specialty shell edit; do it before onboarding a specialty that is not renal or payer | M |
| 8 | Manifests for the 9 packs that ship none | Cheap; closes a visible gap in the Pack Studio | S |
| 9 | Phase 6 governance, budgets, rollout | Needs 1–6 settled first | L |
| 10 | Phase 2 sandbox runs | Blocked externally; start the access requests now | external |

**Do not start Phase 6 before G1 and G2.** Multi-specialty governance of a
runtime that can only host one specialty at a time, and only with hand-written
route registration, would codify the current shape into policy.

---

## 6. What this analysis is not claiming

- It does **not** claim Phase 4's functionality is missing. The seven renal
  protocol packs work, are tested (1,703 tests pass), and are wired to real
  ledger data. What is missing is that they are platform-layer code rather than a
  pack.
- It does **not** claim the platform is un-extensible. A specialty's *metadata,
  lens, terminology, views, ontology, events, workflows, measures and release
  gates* are contract-enforced today. Its *routes* are not (G1), and a view it
  declares must still be one the shell already knows how to draw (G5). Those are
  two layers of the same gap, not two unrelated ones.
- It does **not** treat a green test suite as evidence of architectural
  progress. The suite is green at every step of this analysis; that is exactly
  why these gaps are found by reading the registration and the wiring.
