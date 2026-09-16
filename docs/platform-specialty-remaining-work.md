# Platform-first specialty implementation — remaining work

**Analysis date:** 2026-09-15
**Branch:** `platform` @ `e85f1ba`
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

### At a glance

| Gap | In one line | Blocks | Size | Status |
| --- | --- | --- | --- | --- |
| **G1** | A pack cannot contribute routes | Phase 3 exit criterion, Phase 4, Phase 5 | M–L (11 modules) | phase 1 done (`payer`) |
| **G2** | Only one pack can be active at a time | Phase 6 deliverable 1 | M | **done** (the activation document was the last singular part) |
| **G3** | Cross-pack workflows are dead code | Phase 4, Phase 6 | M | not started |
| **G4** | "Cross-pack" assurance enumerates renal packs in code | Phase 6 | S | **done** (both halves) |
| **G5** | A pack cannot contribute a screen | Phase 5, Phase 6 | M | **contract + registry done**; renal views deliberately not migrated |
| **G6** | A specialty applies everywhere it is installed | the "all customers want all specialities" requirement | M | **implemented** (slice 1) |

Dependency order: **G1 → (G4, G5)**; **G2 ↔ G6** (they are the same subsystem seen twice — G2 is the symptom, G6 is the resolved model); **G2 → G3**. G1 is the only gap that must go first.

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

#### G1 implementation

The interface, as shipped (`src/control-plane/pack-contributions.ts`):

```ts
type PackRouteScope = 'exec' | 'ops';
const SCOPE_NAMESPACES = { exec: '/admin/swarm/', ops: '/admin/platform/' };

interface PackRouteContribution {
  readonly id: string;
  readonly scope: PackRouteScope;
  readonly prefixes: readonly string[];   // declared, then asserted against the namespace
  register(app: FastifyInstance, deps: PackRouteDeps): Promise<void> | void;
}
interface PackRouteDeps {
  readonly workspace: () => SwarmWorkspaceStore;          // lazy: the runtime is rebuilt
  readonly coordinator: () => PersistentOutcomeCoordinator;
}
type PackWithContributions = DomainPack & { readonly routes?: readonly PackRouteContribution[] };
```

Blocking validation issues: `duplicate-contribution-id`, `duplicate-prefix`,
`missing-prefix`, `invalid-prefix`, `prefix-outside-scope-namespace`.

**The interface as it stands is NOT sufficient for the burn-down, and this is the
first thing phase 2 must settle.** Ten of the eleven modules are registered with
`{ patients: renalPatients }` — see `app.ts:513–590` — and `renalPatients` is:

```ts
const renalPatients = deps.renalPatients ?? (() => renalPatientInputs(RealmRegistry.list()));   // app.ts:418
```

So a pack needs the patient population, and `PackRouteDeps` does not carry it.
The answer that matches the reasoning the interface already uses for `workspace`:

- **The platform owns who exists and what happened; the pack owns what that
  means clinically.** A pack must NOT call `RealmRegistry` — it is the platform's
  singleton, and a pack holding it across a runtime rebuild holds a store the
  platform has already replaced. That is the stated reason deps are injected.
- Therefore `PackRouteDeps` gains `patients: () => PatientProjection[]` and
  `events: () => EventProjection[]`, supplied by the platform.
- Concrete symptom this exposes: the projection already exists and lives in
  `src/swarm/renal-cohort.ts` as `renalPatientInputs`. **The platform's patient
  projection is a renal module.** Relocating/renaming it is part of phase 2, not
  a tidy-up — it is the same defect class as G4.

#### SHIPPED: the interface (Stage 1) and the first migration (`renal`)

The interface is settled and one of eleven modules has moved. What follows
records the decisions, including two corrections to the analysis above.

`PackRouteDeps` now carries:

```ts
readonly patients: () => readonly PackPatient[];
readonly extra: PackRouteExtra;   // the pack's own bag, typed by the pack
```

**Correction 1 — `events` is not a platform projection.** The line above asserting
`events: () => EventProjection[]` was wrong, and measurement said so: the four
modules carrying an `events` seam carry *different shapes* (`MbdTwinEventInput`,
`NutritionTwinEventInput`, `InfectionTwinEventInput`, and anemia's inline
projection), they are all **optional overrides for tests**, and with no override
the module derives its own events from the ledger. So there is no single
platform-owned event projection to hand over. A pack-specific dependency is
declared by the *pack* (it knows what it needs) and filled by the *platform*,
which is what `extra` is for. It is a separate field rather than an index
signature specifically so a pack cannot shadow `workspace`, `coordinator` or
`patients` by declaring a key with the same name.

**`registerPackRoutes` resolves deps PER PACK**, not once for all:
`depsFor: (packId: string) => PackRouteDeps`. A single shared object would have to
grow a field per pack until it was the union of everything anyone needed.

**`PackPatient.state` is deliberately mutable.** The stricter
`Readonly<Record<string, unknown>>` reads better and makes the type unassignable to
every existing consumer, because a readonly index signature blocks assignability
to a mutable one. `tests/dialysis-provider-routes.test.ts` pins mutual
assignability with the platform's own projection in both directions at compile
time, so the two cannot drift silently. `buildRenalCohort` was widened to accept
`readonly RenalPatientInput[]` — it only reads, so it always should have.

**Correction 2 — relocation must FOLLOW migration, not accompany it.** The note
above says relocating `renalPatientInputs` is part of phase 2. It is, but the
order matters and I had it backwards. `src/swarm/renal-cohort.ts` is imported by
**31 files** and `RenalPatientInput` appears **42 times**; eight route modules call
`renalPatientInputs(RealmRegistry.list())` directly. After migration those eight
call sites are gone — the platform calls the projection **once**, in
`platform-projections.ts`, to build `deps.patients`. Migrating first shrank the
rename from 31 files to about one.

**Whether a pack that is installed but not `applied` should answer.** It should,
scope-limited ("no patients in scope"), not 404. The pack IS installed and its
endpoints exist; `show` is what the console reads, and `applied` is enforced at
the `patients` seam. 404 stays reserved for genuinely absent packs, which is the
property `tests/dialysis-provider-routes.test.ts` pins.

#### SHIPPED: all eleven modules migrated — Phase 3's exit criterion is met

`src/server/` contains **no specialty route module at all**. Every one of the
eleven lives in `packs/dialysis-provider/` and is registered by the platform's
loop from the pack's own declaration. `tests/pack-contributions.test.ts` asserts
**zero** matches for `await register<Specialty>Routes` in `app.ts`, which is
Phase 3's exit criterion ("Renal is no longer a special-case code path in the
platform shell") written as a test rather than as a claim.

Twelve declared prefixes: `access`, `adequacy`, `anemia`, `assurance`, `fluid`,
`infection`, `mbd`, `next-session`, `nutrition`, `protocols`, `renal`, `rounds`.
Registration order is preserved because `rounds` reads the same windows `fluid`
publishes.

**Correction 3 — `events` IS a platform projection, and correction 1 was too
strong.** The first slice argued the four modules with an `events` seam carried
"four different shapes", so `events` could not be a platform projection. Measuring
it settled the question the other way: all seven twin event types
(`EsaTwinEventInput`, `AdequacyTwinEventInput`, `FluidTwinEventInput`,
`AccessTwinEventInput`, `MbdTwinEventInput`, `NutritionTwinEventInput`,
`InfectionTwinEventInput`) are **identical** apart from optional
`realmId`/`eventId`. Seven names, one type — which is exactly why seven
byte-identical `ledgerEvents()` loops went unnoticed, six of them inside the very
modules being migrated.

So `PackRouteDeps.events: () => ProjectedEvent[]` is now a real projection, those
six copies are **deleted rather than relocated**, and `extra` is correctly scoped
to what is genuinely per-module: the two anemia fixture seams whose shapes differ.

**`extra` is keyed by CONTRIBUTION, not pack.** All nine protocol modules live in
one pack, so `packId` cannot tell them apart — keyed on the pack, every module
would receive the same fixture. `registerPackRoutes` therefore passes the
contribution to the deps factory.

**A bug the tests caught rather than review:** two object spreads under the same
key in `app.ts` (`{'dialysis.anemia': {events}}` then `…: {patients}`) silently
**replace** instead of merge. The events fixture vanished, the ESA twin fell back
to patient state, and `provenance.derivedFrom` came back `patient-state` where the
test required `ledger`. One merged entry now.

**New: `src/server/platform-projections.ts`** — `patientProjection()` and
`eventProjection()`, the platform's single answer to "who exists" and "what
happened". Eleven modules previously answered those themselves, which is why the
platform could not scope, filter or replace the population it handed over, and
why `applied` on a specialty binding had nothing to enforce.

**§4.6 FIXED — the assurance namespace.** `assurance-track-routes.ts` registered
eleven routes under `/admin/assurance/*`, which is in **neither** scope namespace,
so `api-auth.ts` fell through to its ops bucket and the exec-only clinical roles
got 403 on the exec console's own *Assurance track* page. Moved to
`/admin/swarm/assurance/*` (4 files, 54 references) and migrated with the others.

Measured live, before → after, on the running server:

| Role | `/admin/swarm/assurance/overview` | `/admin/swarm/cells` (control) |
| --- | --- | --- |
| admin | 200 | 200 |
| **md** | **403 → 200** | 200 |
| **safety** | **403 → 200** | 200 |
| nurse / auditor | 403 | 403 |

The old prefix 404s, and `POST /admin/swarm/assurance/red-team/run-all` returns
`ran 7, failed 0` — independent evidence that the seven migrated packs' own
red-team routes resolve through the pack registrations.

**Sixteen test harnesses had to install the pack**, which is the migration working
as intended: they were reading specialty endpoints the platform no longer
registers. `tests/renal-data-model.test.ts` was the first; the rest followed.

**Also hardened:** `tests/auth.test.ts`'s session-expiry test used a **1 ms** TTL,
so under a loaded full-suite run the session expired between `create` and `get` —
it passed alone and failed roughly one full run in ten. It now uses a realistic
TTL, and a second test asserts `prune()` with a mocked clock. Verified
pre-existing and not caused by this work (it passed on both trees in isolation).

Burn-down map (measured — module, file, prefix, extra deps):

| Module | File | Prefix | Extra deps |
| --- | --- | --- | --- |
| ~~anemia~~ `anemia-routes.ts` **MIGRATED** | pack | `/admin/swarm/anemia` | `events`, `patients` (fixtures) |
| ~~renal~~ `renal-routes.ts` **MIGRATED** | pack | `/admin/swarm/renal` | — |
| ~~protocol~~ `protocol-routes.ts` **MIGRATED** | pack | `/admin/swarm/protocols` | — |
| ~~adequacy~~ `adequacy-routes.ts` **MIGRATED** | pack | `/admin/swarm/adequacy` | — |
| ~~fluid~~ `fluid-routes.ts` **MIGRATED** | pack | `/admin/swarm/fluid` | — |
| ~~round~~ `round-routes.ts` **MIGRATED** | pack | `/admin/swarm/next-session`, `/admin/swarm/rounds` | — |
| ~~access~~ `access-routes.ts` **MIGRATED** | pack | `/admin/swarm/access` | — |
| ~~mbd~~ `mbd-routes.ts` **MIGRATED** | pack | `/admin/swarm/mbd` | `events` (fixture) |
| nutrition | `nutrition-routes.ts` | `/admin/swarm/nutrition` | `events` |
| infection | `infection-routes.ts` | `/admin/swarm/infection` | `events` |
| cross-pack-assurance | `assurance-track-routes.ts` | **`/admin/assurance/…` — in NEITHER scope namespace** | — |

The last row is a blocker, not a detail. Migrating it forces the namespace
decision in §4 defect 6; do not migrate it with the others.

Per-module steps (following the `payer` proof):

1. List the module's prefixes: `grep -oE "'/admin/(swarm|platform)/[a-z-]+" src/server/<m>-routes.ts`.
2. Create `packs/<id>/routes.ts` exporting `readonly PackRouteContribution[]`, and
   move the route module under the pack (payer's shape) rather than leaving it in
   `src/server/`.
3. Declare `routes: xRoutes` in `packs/<id>/index.ts`.
4. Delete the `await registerXRoutes(app, …)` call **and its import** from
   `app.ts`. The import is the easy half to leave behind; `noUnusedLocals` catches
   it, the test suite does not.
5. Map the module's options onto `PackRouteDeps` — `patients: deps.patients`, and
   any test seam through `deps.extra`. Add a dependency to the interface *before*
   adding it to a pack.
6. Add a route test pinning **absent pack → 404, not 403**, the property phase 1
   established (the route does not exist; it is not a permission an operator
   could be granted).

Two things this list did not anticipate, both learned from doing `renal`:

- **Any test that boots the app without the pack will start failing.** It was
  relying on the platform registering the specialty's endpoints unconditionally.
  The fix is to install the pack in the test — not to make the platform register
  it again — and the failure is the migration working.
- **`renal` is the easy one and it still touched four files.** Expected shape per
  module: the module itself, the pack's `routes.ts`, `app.ts` (import + call), and
  one test harness. Modules with an `extra` seam additionally touch the
deps factory in `app.ts`.

Tests: `tests/pack-contributions.test.ts` already covers the validator. The
burn-down needs one `tests/<pack>-routes.test.ts` per migrated pack asserting
(a) the routes answer when the pack is installed and (b) 404 when it is not.

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

#### G2 implementation

Today, exactly one line encodes the limit (`src/swarm/workspace.ts:2416`):

```ts
async activePack(): Promise<PackActivation | undefined> {
  return (await this.list<PackActivation>('pack-activation'))[0];
}
```

`activatePack` overwrites that one document, so activating oncology deactivates
renal. **G2 is not fixed by making the list plural — see G6.** Making activation
a list without first separating *applied* from *shown* produces the worst state:
several specialties computing simultaneously while the console shows one, which
is silent clinical computation with no surface. G6 is the design; G2 is the
mechanism, and the order between them is: decide the binding model, then make it
a list.

Fan-out to check when it happens (each is a place "the active pack" is read):
`/api/context` (`platform-routes.ts:1056`, `:1072`, `:1489`), the release/config
gates that resolve a pack, the measure registry, and route registration itself
(which is G1).

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

#### G3 implementation

Three frozen workflows name four packs:

| Workflow id | Trigger | Actions |
| --- | --- | --- |
| `x:hospitalization->payer-auth` | `hospitalization.admitted` from `dialysis-provider` | audit → notify `payer` → open case `care-management` |
| `x:denied-auth->reschedule+appeal` | `prior-auth.denied` from `payer` | audit → notify `dialysis-provider` → open case `payer` |
| `x:oncology-plan->prior-auth` | `oncology.plan-approved` from `oncology-provider` | audit → notify `payer` |

Steps:

1. **Move the declarations onto the manifests first.** `pack-resources.ts` already
   checks "a workflow id declared by two packs" as the cross-pack invariant, but
   no manifest declares any of these three ids — so the check passes because its
   input set is empty. Until they are declared, the invariant is enforcing a rule
   over a set disjoint from the set the router actually serves.
2. Construct `CrossPackRouter(seedFromManifests)` at registration, not from
   `seedCrossPackWorkflows` — the installed set is the seed.
3. Subscribe the router to the realm/broker event path so a declared trigger
   fires. The canonical event already exists (`effectToCanonicalEvent`); the
   router is a consumer of the same stream the outbox publishes to.
4. Make the actions real: `open-case` must open a durable episode through
   `OutcomeEpisodeCoordinator`; `notify-pack` must enqueue the target pack's
   workflow, not just record intent.
5. Pin it with a test that fires a hospitalization and asserts the payer episode
   exists — the current test only asserts the router can be constructed.

Note the third row names `oncology-provider`, a pack that **ships no manifest**.
A cross-pack workflow pointing at an undeclared pack is exactly what step 1 makes
visible.

### G4 — "Cross-pack" assurance enumerates renal packs in code (same root as G1)

> **SHIPPED 2026-09-16.** `ProtocolPackDescriptor` moved to
> `src/swarm/assurance-packs.ts` as a CONTRACT; the seven declarations moved to
> `packs/dialysis-provider/assurance-packs.ts`; the pack declares them via
> `assurance:` on its descriptor; `app.ts` collects them from the installed set;
> `AssuranceInputs.packs` is a REQUIRED parameter (a default was the defect).
>
> `normaliseArtifactStatus()` was preserved and moved to the contract module —
> the artifact shapes genuinely differ and that difference is information.
>
> **The test asserts the property that changed**: a synthetic oncology pack IS
> reviewed, and a pack that declares nothing does NOT drag the renal seven in.
> Asserting the seven still appear would pass before and after.
>
> **A REAL FINDING, and the reason G4 is only half-achieved:**
> `ProtocolPackDescriptor.protocol` is typed `ProtocolId`, a CLOSED union of the
> seven renal protocols in `src/protocols/shared-state.ts`. So the platform no
> longer names the specialties, but the CONTRACT still does — a genuinely new
> specialty cannot declare an assurance contribution without editing that union.
> The synthetic test in `tests/assurance-track.test.ts` only type-checks behind a
> cast, and a sibling test asserts that limitation so it stays visible. **Same
> defect class as G5**, and the next thing to fix here.
>
> **A second fix that came with it:** with no packs the track reduced to
> `ship` — every check vacuously satisfied, so reviewing nothing announced that
> nothing was wrong. An empty set now reports "nothing was reviewed, which is not
> the same as nothing being wrong" and holds.
>
> **SECOND HALF — CLOSED 2026-09-16.** `ProtocolPackDescriptor.protocol` is now
> `string`, so a genuinely new specialty declares an assurance contribution with
> no cast and no platform edit. What replaced the closed union is
> `assuranceContributionIssues()`: `duplicate-protocol`, `empty-protocol`,
> `empty-model-id`. That is a strictly BETTER check, not a weaker one —
> `packFor()` resolves the FIRST match, so a duplicate silently shadows a pack,
> and the closed union never caught that either; it only caught spellings neither
> pack had reason to use.
>
> Four narrowing points had to be found rather than assumed: `modeRecord()`,
> `modeFor()`, `isSilent()` and `rulesForProtocol()` were all typed with the renal
> union while *already* handling an unknown protocol honestly (default silent,
> empty rule set). The ones that genuinely need the union —
> `evaluateProtocolForPatient` and the renal registry — were left closed, and
> `tests/assurance-track.test.ts` now narrows through `isProtocolId()` explicitly
> and **asserts the two vocabularies agree**, a coherence check that did not exist
> while both sides happened to be typed the same.
>
> **The third case.** The rules check had two outcomes and needed three. A
> protocol the platform ships no rule pack for cannot be assessed against the
> platform's rules: failing it blocks every release containing a non-renal pack
> forever, on the grounds that it is not renal, which trains operators to ignore
> the gate. It warns, naming what is missing. A protocol the platform DOES cover,
> missing a guardrail, is still a hard fail. The gate now reads the per-pack check
> instead of recomputing it, so the two cannot disagree about one pack.
>
> **A live silent-wrong-answer fixed:**
> `GET /admin/swarm/assurance/fairness?protocol=mbd` returned
> `protocol: 'anemia'`. A supplied-but-unrecognised protocol is refused now; only
> an ABSENT one keeps the default, which `fairnessReport` owns and states back.
> Pinned in the routes test — where `?protocol=mbd` returning 400 also makes the
> `ckd-mbd` / `mbd` vocabulary split visible in a test rather than in a grep.


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

#### G4 implementation

`PROTOCOL_PACKS` is seven frozen literals, each carrying a surprising amount of
the pack's identity:

```ts
{ protocol: 'anemia', slice: 'P1', modelId: ESA_MODEL_ID, redTeamIds: ESA_RED_TEAM_IDS,
  coverageDefaults: ESA_COVERAGE_DEFAULTS, artifactProbe: esaArtifactStatus,
  routes: '/admin/swarm/anemia', mdrKind: 'esa-mdr-file' }
```

Steps:

1. Add a pack-side assurance contribution (`PackAssuranceContribution`) carrying
   exactly those fields, and declare it from the pack.
2. Replace `PROTOCOL_PACKS` with a loop over the installed set. Keep `packFor()`
   as the lookup, reading the collected contributions.
3. **Preserve `normaliseArtifactStatus()`.** The artifact shapes are NOT uniform —
   fluid exposes flags but no `band`, adequacy exposes neither band nor note,
   anemia is a regression artifact (MAE vs baseline), and
   infection/mbd/nutrition/access declare `band` + `note`. The normaliser derives
   a band from the pack's own acceptance flags and never invents one. Moving
   probes into packs must not tempt anyone into forcing one shape.
4. Pin the honest empty state: with no pack declaring an assurance contribution,
   the track reports that, rather than rendering an empty table that reads as
   "nothing is wrong".
5. Test with a **second** specialty's contribution registered (a synthetic one is
   fine) — the whole point of G4 is that the track sees a pack it was not written
   against. Asserting the seven renal packs still appear proves nothing.

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

#### G5 implementation

The two closed vocabularies today:

- `PLATFORM_LENS_VIEWS` (11 ids) in `pack-contract.ts` — what a lens may declare.
- `switch (activeNav)` in `exec-app/src/app.tsx:401` — ~22 hardcoded component
  cases. A view id only means something because a `case` exists for it.

Target shape: a view is `{ id, label, kind, source }`, and the shell holds a
**renderer registry keyed by `kind`** instead of a switch keyed by id.

Candidate kinds, and the honest mapping of the existing 11 renal views:

| Renal view | Nearest kind | Fits? |
| --- | --- | --- |
| anemia, adequacy, fluid, vascular-access, mbd, nutrition, infection | `ranked-actions` | **yes — 7 views, one kind.** This is the strongest evidence the vocabulary is real: the ranked-actions panel already renders `Lead[]` from any endpoint. |
| protocols (Cockpit) | `board` | yes, as a hub of per-pack sections |
| protocol-assurance | `report` | **strains** — it is a multi-tab composition (rules, gate, fairness, burden, modes). Either a new `report` kind or an honest composite. |
| next-session | `detail` + `timeline` | yes, as a composition |
| round-digest | `timeline` + `diff table` | yes |

Seven of eleven collapsing onto one kind is the finding. The two that strain
(`protocol-assurance`, and the cockpit hub) are where the real decision is: a new
kind, or a composite of existing ones.

Steps:

1. Add the renderer registry alongside the existing switch, and make the switch
   the *fallback* — nothing breaks while views migrate.
2. Replace `unknown-lens-view` with `unknown-view-kind` in the contract, and keep
   the old check while any view still declares an id.
3. Migrate the 11 renal declarations onto kinds, in the order that fails fastest
   (assurance first — it is the one expected to strain).
4. Delete the migrated `case` arms and the corresponding `NavigationId` entries.

**The discipline:** a kind is justified when a **second** specialty needs it.
Kinds are promoted from real packs, never designed up front — the same rule as
`undefined` (map gap) vs `null` (deliberate no-action) in the action map, and "a
declared bound beats a percentile" in cohort calibration.

#### G5 implementation — the contract and the registry SHIPPED (2026-09-16)

`SpecialtyLensView` gained optional `kind` and `source`; `PLATFORM_VIEW_KINDS`
names the renderers the shell actually has (it starts with ONE: `ranked-actions`);
`pack-resources.ts` checks a kind-declaring view against the renderer set
(`unknown-view-kind`) and refuses a kind with no source
(`view-kind-without-source`); the shell has `VIEW_RENDERERS` consulted BEFORE the
`case` switch, which stays as the fallback — so nothing had to migrate for this to
land and both vocabularies are live at once.

**THE FINDING, and it is the one the plan predicted.** The table above claims
seven of the eleven renal views collapse onto `ranked-actions`, and that seven of
eleven is "the strongest evidence the vocabulary is real". Attempting the
migration says otherwise: those pages are **compositions**, not boards. The anemia
page is a KPI header, a trajectory panel, a ranked board and a governance table;
the ranked board is one panel inside it. A KIND describes a PANEL. A page is a
composition of kinds, and there is no honest way to render a page as its own
innermost panel.

So the eleven renal declarations were **not** migrated, and that is a decision
rather than an omission: migrating them would have deleted seven working pages to
make a table look tidier — the same mistake as weakening a manifest to match a
stale descriptor. The id vocabulary is still the live one for them, the
compatibility path is exercised by them, and `tests/view-kinds.test.ts` asserts
both vocabularies stay live so a future migration cannot quietly retire one.

**What the exit criterion therefore needs**, restated now that the cheap version
has been ruled out: a second specialty composes `kind`-declared views against its
own endpoints. The contract accepts that today — the fixture in
`tests/view-kinds.test.ts` is a non-renal pack declaring
`{ kind: 'ranked-actions', source: '/admin/swarm/oncology/state' }` and it resolves
with no issue — but proving it against a REAL second specialty needs a pack with
an action board, which is Phase 5 product work rather than a platform gap.

**And the guard that came out of it:** `PLATFORM_VIEW_KINDS` (platform) and
`VIEW_RENDERER_KINDS` (shell) are two lists in two projects with nothing but a
human reading both files to keep them equal. `tests/view-kinds.test.ts` compares
them in both directions and checks the shipped manifests against them — the same
guard `tests/workspace-kinds.test.ts` became necessary for after the same pair of
lists diverged twice by hand.

### G6 — A specialty applies everywhere it is installed (the "all customers want all specialities" requirement)

**Evidence.** There is no notion of a specialty being *applicable* to a scope.
Protocols evaluate cohort-wide: every installed pack's engine runs over every
patient, and per-patient gating happens by **data** (window constructability +
coverage gate), not by enrolment. Nothing protocol-related is stored on a patient
entity. Operational controls are per-protocol and **fleet-wide**:
`silent-mode.ts` keeps `Map<ProtocolId, ProtocolModeRecord>`, so you cannot take
one pack dark for one facility.

Separately, installation is the only switch: `PackActivation` is a single
`{ packId, by }` document, so "installed" and "in use" are the same fact.

**Why it matters.** This is the gap under the product requirement. "All customers
want all specialities" cannot be served by a per-customer build; it needs *one
artifact and N configurations*. And it cannot be served by a display switch
alone, because a specialty that is installed but not shown **still computes**:
hide oncology and leave it applied, and oncology NBAs appear on dialysis
patients in My Work. That is a clinical safety problem, not UI noise.

**Three questions the configuration must answer separately.** Conflating them is
the trap — if one field answers all three, a display change silently changes
clinical behaviour:

| Question | Today | Answer it must have |
| --- | --- | --- |
| **Applied** | every installed pack, every patient, fleet-wide | does this pack evaluate this population, at this scope? |
| **Shown** | one active pack (`activePack() = list()[0]`) | which lens/views does this console render? |
| **Entitled** | absent | is this customer licensed for it? |

**Precedent already in the codebase.** `src/evidence/silent-mode.ts` deliberately
separates *computing* from *surfacing*: silent suppresses surfacing only, leaving
silent requires a stated reason, and `assertSilentStillComputes` is the invariant
probe. **Hidden ≠ not running**, and the config must say which one it means.
Hence `applied` and `show` are separate fields, not one.

**Fix shape.** A durable `specialty-binding` **list** kind:

```yaml
specialty-binding:
  - scope: facility:rb-franklin
    pack: dialysis-provider
    applied: true      # evaluate this population
    show: true         # render this lens
    entitled: true     # licensed
  - scope: facility:rb-nashville
    pack: oncology-provider
    applied: true
    show: true
```

Scope resolution is already available: the actor carries `scopeIds` with a
`scope:*` wildcard (`ActorContext`), which is what `canReadPhi`/scope checks
already read. `pack-activation` survives as the fallback when no binding matches,
so migration does not break the current console.

**Dependency and interaction.** G6 is the resolved design for **G2** — G2 is the
symptom (one active pack), G6 is the model (scoped bindings with three separate
questions). Making activation a list *before* deciding G6 produces the worst
state. G6 also makes **G1 mandatory rather than merely valuable**: install-all
means every installed pack must register its own routes, or `app.ts` becomes the
list of specialties the configuration is supposed to own.

**Open decision to settle before implementing.** When a pack is installed but not
`applied` at a scope, what does its endpoint return? The rule established in G1
phase 1 is *absent pack → 404, not 403* (the route does not exist). Once every
pack is installed the route exists, so "not applied here" needs its own honest
signal. The leaning is: the endpoint exists and returns a scope-limited answer
("no patients in scope"), because the pack *is* installed — and `show` handles
the console.

#### G6 implementation — slice 1 SHIPPED (the model, the wire, the console)

What exists now:

- **`src/control-plane/specialty-bindings.ts`** (NEW, pure — no I/O, no store, no
  swarm import, so it runs at boot, in a route and in a test). Exports
  `SpecialtyBindingLike`, `resolveSpecialtyBindings`, `bindingMatchesViewer`,
  `shownSpecialties`, `bindingIssues`, `hasBlockingBindingIssue`, and the one
  `specialtyBindingId` / `parseSpecialtyBindingId` pair.
- **Durable kind `specialty-binding`** (a LIST) + `listSpecialtyBindings` /
  `saveSpecialtyBinding` / `removeSpecialtyBinding`. The id is **derived from
  (scope, packId)**, so "one binding per scope per pack" is structural rather
  than something a validator must catch afterwards.
- **Routes**: `GET/PUT/DELETE /admin/platform/specialty-bindings`. Blocking
  problems (`pack-not-installed`, `invalid-scope`, `duplicate-scope-and-pack`)
  are refused with 400 and their reasons; soft ones (`show-without-applied`,
  `applied-without-entitled`) are **recorded and returned**, because refusing to
  store a trial licence would push an operator to claim one they do not have.
- **`/api/context`** now returns `packs: ResolvedSpecialty[]` (applied,
  appliedScopes, show, entitled, primary, reason, decisions) and derives
  `viewGroups` and the leading lens from the resolution. `pack` and `viewGroups`
  keep their existing shapes, so **no exec-app change was needed**.
- **admin-ui** → Platform → **Specialty bindings**: the three flags as three
  separate controls, the resolved view *for the caller* (because the same config
  resolves differently for a different operator), and a red **`computes, hidden`**
  pill on the one combination that is dangerous rather than merely off.

Four decisions that are load-bearing:

1. **Bindings are OVERRIDES, not a switch to opt-in.** A pack with no binding
   keeps the pre-G6 behaviour (installed ⇒ applied and shown, legacy activation
   leads). Read the other way, adding one binding for one pack would dark every
   other specialty in the deployment.
2. **`scope:*` means two different things on the two sides** — as a BINDING it
   means "for everyone" (matches any viewer); as a VIEWER's scope it means
   "unscoped" (matches any binding). The first draft implemented only the second,
   so a global rule resolved for super-admins alone: correct in a test written
   from the super-admin seat, wrong for every other operator.
3. **The resolver does not invent a leader.** With several packs shown and none
   claiming `primary`, it returns none. "First in installed order" looks harmless
   and elects `healthcare-core` — the substrate, which is not a specialty — at
   exactly the moment the deployment has expressed no preference. It promotes only
   a *sole* shown pack; otherwise the caller's own fallback (the organization's
   operating model) decides.
4. **`applied` is enforced where the platform hands patients to a pack** — the
   `PackRouteDeps.patients` seam in G1 phase 2. The platform owns that projection,
   so it owns the filtering; until that lands, `applied` is reported and scoped
   but not yet enforced. This is the explicit hand-off between G6 and G1.

**Still open in G6:** `entitled` is recorded but not enforced, because there is no
licensing source to enforce against yet; and a facility- or region-level binding
only resolves for actors whose `scopeIds` carry that scope — today
`LocalUserStore` defaults to `['scope:*']`, so a deployment wanting per-site
specialty configuration must provision those scope ids first. That is a
prerequisite, not a detail.

#### G6 implementation — `applied` is ENFORCED (closed 2026-09-16)

`applied` was reported and scoped but not enforced, which is the dangerous
direction rather than merely an incomplete one: a specialty that is installed but
not applied still COMPUTES. Its recommendations reach the work queue and its twin
runs over real patients, with no console surface on which anyone could notice.
`silent-mode`'s precedent is that computing and surfacing are different claims,
and a display-only switch is exactly what that precedent forbids.

`src/server/specialty-apply.ts` closes it. Two facts have to meet SYNCHRONOUSLY
inside `PackRouteDeps.patients`:

- **Who is asking.** Every specialty module calls `deps.patients()` with no
  arguments, and requiring eleven modules to thread a viewer through would be the
  platform asking a pack to know something the platform already knows. So the
  viewer travels out-of-band, in an `AsyncLocalStorage` scope established once per
  request.
- **What the configuration says.** A durable read, which cannot happen inside a
  synchronous projection, so the binding set is SNAPSHOTTED — primed lazily on the
  first request that needs it and re-primed by every binding write. A write that
  did not re-prime would take effect at the next restart, which is the shape of
  bug where the console says one thing and the runtime does another.

**The mechanism is one line and it is load-bearing.** The scope is established in
a SYNCHRONOUS `onRequest` hook that wraps the continuation:
`viewerScope.run(scopes, () => done())`. An async hook cannot do this — an async
function body gets its own async context, so `enterWith()` there would set the
store for the hook and not for the handler, and the gate would resolve every pack
as "no viewer in scope" and enforce NOTHING while reporting success. A gate that
cannot fail is worse than no gate, so `tests/specialty-apply.test.ts` asserts
`viewerKnown === true` through a real Fastify request rather than trusting the
reasoning.

Two decisions worth stating:

- **An empty snapshot applies every pack.** That is the behaviour that shipped
  before bindings existed, so arming the gate changes nothing until an operator
  writes a binding — the same reasoning as `no-binding` in the resolver. A
  configuration feature that defaults to off is the only kind an operator will try.
- **`viewerKnown` is a separate field from `applied`.** "Nobody asked" and "asked
  and the answer is yes" are different facts, and a caller that conflated them
  would report an unenforced gate as a permitted one.

**What is still NOT enforced, and said so rather than implied:** the gate answers
"is this pack applied AT ALL for this caller". It does not narrow the population
to the applied SCOPES, so a pack applied at `facility:a` and `facility:b` hands
the same population to a viewer at either. Narrowing needs the patient projection
to carry a facility, which it does not yet — `PackPatient` carries `realmId`, and
mapping `facility:` scopes onto patients is the next step, not a detail.

---

## 2a. The sweep: everywhere the platform names a specialty

"Just add a route" understating the work only matters if someone knows what the
rest of the work is. This is the inventory, taken before G1 phase 2 so the
migration does not have to be repeated for sites it did not know about.

| Site | What it names | Kind | Correct home |
| --- | --- | --- | --- |
| `src/server/app.ts` (11 calls) | renal protocol modules | route registration | **G1** — pack contribution |
| `src/swarm/assurance-track.ts` `PROTOCOL_PACKS` | 7 renal protocols + probes + MDR kinds | coverage/assurance surface | **G4** — pack contribution |
| `src/knowledge/pack-subscriptions.ts` | ~12 packs, ~50 subscriptions (source, code filters, workflows, agents, measures, criticality, freshness) | knowledge-plane data | **manifest** — each pack declares what it consumes |
| `src/healthcare-core/cms-source-registry.ts` | `consumedByPacks: ['dialysis-provider']` ×4 | provenance metadata | manifest, or derived from subscriptions |
| `src/control-plane/cross-pack-workflows.ts` | dialysis-provider, payer, care-management, oncology-provider | orchestration | **G3** — pack-declared, and invisible to the contract today |
| `src/fhir/mapping.ts` (~1379) | "F7 renal wire model" | wire format | pack-owned mapping registered as a contribution |
| `src/server/bootstrap.ts`, `dev.ts` | the installed pack list | composition root | **correct as-is** — this *is* the install list |

Two findings the sweep produced beyond the inventory:

1. **The cross-pack workflows in `cross-pack-workflows.ts` are outside the
   contract.** `pack-resources.ts` checks for a workflow id declared by two packs
   (which is what makes it cross-pack), but no manifest declares
   `x:hospitalization->payer-auth`, `x:denied-auth->reschedule+appeal` or
   `x:oncology-plan->prior-auth`. The platform therefore enforces an invariant
   over a set of workflows that is disjoint from the set it actually routes. The
   check passes because the registry is empty of them, not because they are
   consistent. G3's fix must move these onto the manifests, which is also what
   makes the existing check meaningful for them.

2. **A live defect, fixed in this slice: agent discovery was a six-name list.**
   `admin-routes.ts` held `PACK_ROOTS`, a hand-written array of six pack
   directories, and `loadAllAgents()` read `packs/<id>/agents` from disk for
   those six — **fifteen packs ship agents**, so nine packs (264 specs:
   `oncology-deep` 40, `home-health` 35, `long-term-care` 35, `behavioral-health`
   30, `revenue-cycle` 30, `ed-throughput` 25, `hospital-at-home` 25, `radiology`
   20, `mixed-sample-clinic` 24) were invisible to the Agent Studio.

   It also read them *unconditionally*: a deployment that never installed
   `research-pharma` still loaded its agent specs. Agents act, so this is worse
   than a missing screen — it is the payer-route defect (absent pack still
   served, now 404) in the one place where the consequence is an agent running
   rather than an endpoint answering.

   `loadAllAgents()` now reads through `scanSpecTree()` in
   `agent-spec-store.ts`, which already discovered the tree correctly and is what
   the durable spec registry imports from. The console's count and the registry's
   count can no longer disagree. `tests/admin-routes.test.ts` pins it: ≥15 packs,
   >400 specs, and specifically four packs that were invisible before.

   Worth noting *how* this was found. The defect was already documented in the
   header comment of `agent-spec-store.ts` — the registry's author found the
   disagreement and wrote it down, but the read path was left alone. It surfaced
   here only because G4's lesson was taken literally: this sweep grepped for pack
   names across `src/` instead of reading the two files the analysis already
   knew about.

---

## 2b. The plugin boundary — options considered

These are not alternatives to each other in one important respect: **A, B and D
answer "how does the code arrive?"; the capability vocabulary (G5) answers "what
can it say once it is here?"** Choosing a loader without the vocabulary produces
a plugin that loads and cannot render.

| Option | The boundary | Cost | Buys | Costs |
| --- | --- | --- | --- | --- |
| **A. In-tree contribution interfaces** (current) | a pack folder + an interface; one import line in the composition root | already paid | typechecked, one deploy, simplest | adding a specialty still edits a platform file |
| **B. Manifest-driven loader** | scan `packs/*/manifest.yaml` → dynamic-import the declared entry → validate → register; delete the 16-entry import list | S–M | the platform stops naming specialties; a specialty is a folder | needs a failure-isolation rule (one bad pack must not stop boot), and B is only useful *with* G5 |
| **C. Capability vocabulary** (= G5) | a view/compute `kind` + data source | M | a specialty composes generic screens and generic compute | the real product work; a `kind` is justified only when a second specialty needs it |
| **D. Isolated plugins** | out-of-process (sidecar HTTP) or wasm module | L | sandboxing, independent release cadence, third-party-safe | needs a wire contract for evidence/effects/approvals |

**Decisions taken:**

1. **D is deferred, not rejected.** It is the right boundary for third-party
   packs and premature for first-party specialties we control. It is a real path,
   not a hypothetical one — the repo already builds wasm (`native/liquid-wasm`),
   and the wire contract it would need is the shape the FHIR proposal ladder
   already has.
2. **B is one deliverable with G5**, never before it.
3. **A is not replaced by B.** A is what a pack *is*; B is how it is *found*.
   B's loader registers A's contributions. Nothing about A changes.
4. **The 16-entry static import list is correct as an install list but wrong as
   the specialty list.** `bootstrap.ts`/`dev.ts` naming the installed packs is
   the composition root doing its job. What is wrong is that this is *also* the
   only place a specialty can come from, with no configuration above it — which
   is G6.

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
6. **The exec console's *Assurance track* page is 403 for the two clinical exec
   roles. VERIFIED by measurement, not by reading.** `assurance-track-routes.ts`
   registers **11 routes under `/admin/assurance/…`**, which is in *neither*
   scope namespace (`/admin/swarm/` = exec, `/admin/platform/` = ops). `api-auth.ts`
   falls through to its default bucket at line 175 (`!roleAllowsConsole(role,
   'ops')` → 403). Measured against a live app:

   ```
   /admin/assurance/overview   admin=200  md=403  safety=403
   /admin/assurance/gate       admin=200  md=403  safety=403
   /admin/assurance/modes      admin=200  md=403  safety=403
   /admin/swarm/cells  (control)          md=200
   ```

   So `md` and `safety` — the exec-only clinical roles, who cannot enter the ops
   console at all — are refused every call behind a page the exec console
   renders. The page is a view in the exec protocol strip (`protocol-assurance`),
   and all 13 of its calls in `exec-app/src/lib/assurance.ts` target
   `/admin/assurance/*`.

   This is the *same* defect as the payer-route finding (a specialty's endpoints
   reachable outside the authority that should own them) except in the opposite
   direction: not a specialization served too widely, but a specialization's
   authority never classified. It is also **why G1 phase 2 must not migrate this
   module with the others** — declaring a `scope` forces the namespace decision,
   and the namespace is wrong today.

   Not yet fixed. Blast radius is small and mechanical: **4 files, 49
   references** — `assurance-track-routes.ts` (11 routes),
   `exec-app/src/lib/assurance.ts` (13 calls), `tests/assurance-track.test.ts`,
   plus a rebuilt exec-app dist. The fix is to move the routes to
   `/admin/swarm/assurance/*` (exec-scoped), which matches the namespace rule
   rather than adding an exception to it — the page *is* an exec surface.
7. **`pack-activation` was in the `WorkspaceKind` union but missing from the
   runtime `WORKSPACE_KINDS` array — so the Pack Studio's activation was written
   durably and never loaded back.** `hydrate()` walks that array and it is the
   only thing that populates the in-memory maps, while `list()`/`get()` read the
   maps — so `activePack()` returned `undefined` after every restart and the
   console silently forgot which lens was active. **Fixed**, and this is the
   SECOND occurrence (`cohort-decision` was the first, whose declines were
   forgotten). `tests/workspace-kinds.test.ts` (NEW) now parses both lists out of
   the source and fails if they ever disagree — the union is a type and has no
   runtime representation to compare against, which is why this was found by hand
   twice and is now found by a machine.
8. **The Catalog kind selector in the exec-substrate console was inert, and
   threw.** Found by a new inline-handler checker while validating G6's own panel.
   `onchange="wsCatKind=this.value;wsCatalogBody()"` had two faults, both the
   module-split failure mode: `wsCatalogBody` **is not defined anywhere** (the
   renderer is `cfgObjectsBody`), and a bare `wsCatKind = this.value` assigns a
   GLOBAL — the real binding is `export let wsCatKind` in the module, so the
   selection would not have taken effect even with the right function name.
   **Fixed** via a `window.wsCatalogKind(value)` handler that sets the module
   binding and re-renders.

---

## 5. Recommended order

| # | Item | Why now | Size |
| --- | --- | --- | --- |
| 1 | ~~**G1 phase 1** — define the route contribution, migrate one pack~~ **DONE** (`payer`) | Unblocked Phase 3's exit criterion and Phase 4's | S–M |
| 2 | ~~**Sweep for every name-enumerated specialty**~~ **DONE** (§2a; found a live defect and fixed it) | "Just add a route" understates it; the contribution surfaces are plural | S |
| 3 | ~~**G6** — the specialty binding model (`applied` / `show` / `entitled`, resolved by scope)~~ **DONE** (slice 1 — model, wire, console). Remaining: enforcement at the patient seam, below | This was the product requirement ("all customers want all specialities", one artifact and N configs), and it reframes G2 | M |
| 4 | **G1 phase 2** — migrate the remaining specialty route modules | Now **mandatory**, not merely valuable: G6's install-all makes hand-written registration the thing the config is supposed to own. First settle `PackRouteDeps.patients` (which is also where G6's `applied` gets enforced), relocate `renalPatientInputs` out of `renal-cohort.ts`, and fix the assurance namespace (§4.6) | M–L |
| 5 | ~~**G4** — assurance loops over installed packs~~ **DONE** (both halves: the declaration is pack-owned and the protocol vocabulary is open) | Follows G1 directly; makes the *Cross-pack assurance* claim true | S |
| 6 | **G2** — activation becomes the list G6 requires | Subsumed by 3+4; the mechanism, not the design | S–M |
| 7 | **G5 + B** — view kinds and the manifest loader (one deliverable) | Removes the last per-specialty shell edit and the last place the platform names specialties | M |
| 8 | **G3** — cross-pack workflows onto the manifests, then wired | The multi-specialty value proposition, currently dead code | M |
| 9 | **Declare the renal protocol packs' surfaces** (ontology, measures, event contracts) | Makes the conformance matrix honest about 7 of the 12 partial packs; this is the real content of Phase 4 | M |
| 10 | Manifests for the 9 packs that ship none | Cheap; closes a visible gap in the Pack Studio. Note one of them, `oncology-provider`, is already referenced by a cross-pack workflow (G3) | S |
| 11 | Phase 6 governance, budgets, rollout | Needs 1–10 settled first | L |
| 12 | Phase 2 sandbox runs | Blocked externally; start the access requests now | external |

**Do not start Phase 6 before G1 and G6.** Multi-specialty governance of a
runtime that can host one specialty at a time, applies every installed pack
fleet-wide, and registers routes by hand would codify the current shape into
policy.

---

## 6. What this analysis is not claiming

- It does **not** claim Phase 4's functionality is missing. The seven renal
  protocol packs work, are tested (1,720 tests pass), and are wired to real
  ledger data. What is missing is that they are platform-layer code rather than a
  pack.
- It does **not** claim the platform is un-extensible. A specialty's *metadata,
  lens, terminology, views, ontology, events, workflows, measures and release
  gates* are contract-enforced today. What is not: its *routes* (G1), the
  *screens* it may declare (G5), the *assurance* it must appear in (G4), the
  *scope* it applies to (G6), and the *orchestrations* that cross between
  specialties (G3). These are one gap in five places — a specialty is fully
  describable and only partly ownable.
- It does **not** claim the evaluation side is the hard part. Each specialty's
  computation already varies freely: features, thresholds, model artifact,
  guardrails, cells, action map and governance are all pack-owned today, and the
  protocol-pack template (engine → governance → artifact → what-if → twin →
  validation → routes → page) already exists. The unsolved variability is on the
  **surface** and **install** boundaries, not the clinical one.
- It does **not** treat a green test suite as evidence of architectural
  progress. The suite is green at every step of this analysis; that is exactly
  why these gaps are found by reading the registration and the wiring — including
  the 403 in §4.6, which every test passes through.
