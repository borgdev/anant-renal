# Living cohorts

A cohort is **not a saved filter**. It is a declared clinical proposition:

- **entry** criteria over state *and* trajectory,
- a **mandatory exit** (a cohort that can only grow is an inbox),
- the **action** it suggests when a patient qualifies,
- the **boundary** it may never cross (`mayNever`), and the **guards** that apply
  before acting.

Membership is **always a suggestion**. `evaluatePatient` says whether a patient
currently satisfies the proposition; it never acts. Acting goes through the
existing proposal → approval → episode path, and a qualifying patient appears in
the **one** work queue (`kind: 'cohort'`) rather than opening a second inbox.
Suggestions are reached through **My Work** — see
[Where cohorts surface](#where-cohorts-surface--authoring-is-not-deciding) for
which console owns them.

Three rules make this a system rather than 25 alert streams:

1. **Cohorts are data.** A definition is plain serialisable JSON. An operator can
   add, edit or retire one at runtime — no code, no deploy.
2. **A criterion may only reference a metric.** The vocabulary is closed and every
   metric names the module that computes it, so an authored cohort *composes*
   existing pack outputs instead of inventing clinical logic that could disagree
   with the protocol it belongs to.
3. **Unresolved is a third state.** A metric that cannot be resolved is never read
   as "not a member". Otherwise a missing lab becomes a clean bill of health.

## `0 members` is four different facts

This is the single most important thing to understand about the catalog, and the
reason `coverage` exists. A bare `members: 0` cannot distinguish:

| diagnosis | what it means | what to do |
|---|---|---|
| `data-gap` | nobody has the measurement. The cohort is decorative | fix the data source, or retire the cohort. **This zero is not evidence that nobody is at risk** |
| `criteria-too-strict` | the measure resolves, and nobody reaches the threshold | recalibrate against the reported observed range |
| `no-joint-overlap` | every criterion is individually satisfiable, but no patient satisfies them **together** | check both branches: the criteria may be mutually exclusive, or this population may simply contain no such patient — the counts do not distinguish the two |
| `insufficient-coverage` | nothing was evaluated | check the patient source |

Each diagnosis carries a `verdict` sentence naming the metric, the observed
population range, and the source module. For example, on the reference fleet:

```
idh-next-session      criteria-too-strict
  the data resolved 'idh.nextSessionProbability' for 54 patients and none met
  idh.nextSessionProbability gte 0.6 (observed range 0.03–0.04). The criterion is
  decidable and the threshold sits outside the observed population.

inadequate-clearance  no-joint-overlap
  every entry criterion is individually satisfiable, but no patient satisfies them
  together. The binding criterion is 'protocol.severity.adequacy', satisfied by
  only 4 of 58 patients; 'sessions.count' holds for 54. As written this cohort
  cannot admit anyone.
```

That second case is the trap: an adequacy flag that only fires for patients who
have **no** sessions, paired with a criterion requiring a session, can never admit
anyone — and nothing is missing and nothing is mis-thresholded. Reading it as a
coverage problem would send an operator hunting for data that is not the issue.

`coverage.criteria[]` carries per-criterion `met` / `notMet` / `unresolved`,
`metPct`, `resolvedPct` and the observed numeric range, so thresholds can be
calibrated from evidence rather than from intuition.

## Authoring

**Console:** Admin UI → Platform → **Living cohorts**. The editor only offers
metrics from the closed vocabulary, shows each metric's unit and the module that
computes it, and validates before the request leaves the browser.

**API:**

| method | path | purpose |
|---|---|---|
| `GET` | `/admin/cohorts` | the catalog |
| `GET` | `/admin/cohorts/metrics` | the closed vocabulary |
| `GET` | `/admin/cohorts/:id` | one definition |
| `POST` | `/admin/cohorts` | create |
| `PUT` | `/admin/cohorts/:id` | edit |
| `DELETE` | `/admin/cohorts/:id` | retire |
| `POST` | `/admin/cohorts/evaluate` | evaluate every enabled cohort |
| `GET` | `/admin/cohorts/state` | cohort state, coverage and membership history |
| `GET` | `/admin/cohorts/suggestions` | the suggested queue |
| `GET` | `/admin/cohorts/declines` | decline analysis |
| `GET` | `/admin/cohorts/patients/:patientId` | why is this patient in a cohort? |

Authoring is validated server-side and the server is the gate: an unknown metric,
a bad comparator, a missing numeric value, a missing `exit`, `mayNever` or
`guard` are all rejected with a named error.

## Where cohorts surface — authoring is not deciding

There are two surfaces and one rule: **each console renders the items it owns.**
The queue is one endpoint (`GET /api/work`); every item carries the `console` that
owns it, and a console shows only its own.

| surface | console | what it is for |
|---|---|---|
| Platform → **Living cohorts** (admin-ui) | operator | authoring definitions, coverage verdicts, decline analysis |
| **My Work** (admin-ui) | operator | deciding the `console: 'ops'` items — cohort suggestions and release validation |
| **My Work** (exec-app) | executive | deciding the `console: 'exec'` items — release approval/activation, outcome episodes |

A cohort suggestion is **operator-owned**: phrasing a criterion and evaluating it
is a nursing, quality or coding activity, and the critiquing thread (a decline and
its reason) is only meaningful next to the definition that produced it, which
lives in the admin console. Declining from the executive console worked, but it
detached the reason from the surface where the criterion is edited.

The executive console therefore stays honest about the split rather than hiding
it: when the queue it reads contains operator items, My Work says so and offers a
link.

```
[ 69 item(s) in this queue belong to the Operator console and are worked there. ]  [ Open operator console → ]
```

### Who reaches which console

`src/server/console-gate.ts` is the single source for this, and `cohort.review`
is deliberately granted to **both** consoles — the separation is about where the
work is done, not about who is permitted.

| role | consoles | cohort suggestions land in |
|---|---|---|
| `admin` | both | admin-ui **My Work** (uses its operator console) |
| `nurse`, `pharmacist`, `coder`, `auditor`, `facilities-tech` | operator | admin-ui **My Work** |
| `md`, `safety` | executive | exec **My Work** — the fallback, as they cannot enter the operator console |

For `md` and `safety` the executive queue is the only reachable surface, so exec
My Work is *not* filtered down to nothing: it renders its own items and discloses
the operator count. Roles that can reach both should review cohorts in the admin
console, because that is where the definition, the coverage verdict and the
declines are.

### The queue requires a session

`GET /api/work`, `GET /api/work/:id` and `POST /api/work/:id/actions` all answer
**401 `not-authenticated`** without a valid session cookie. This was not always
true, and it mattered: the queue returned patient ids, the clinical reason and the
owner role to any caller, and "role-scoped" means nothing when there is no
principal to scope to. The detail route is gated for the same reason as the
action route — it explains a named patient's membership.

`GET /api/context` answers anonymously, because a login screen has to be able to
ask "who am I?" — but it reports `consoles: []`, `capabilities: []` and
`navigation: []` for an unauthenticated caller. Advertising both consoles to an
unknown caller was a role claim that no session backed, and it is the same list
the console switcher reads.

## Versioning and declines

Membership is attributed to the `criterionVersion` it was evaluated under, so
editing a criterion cannot silently rewrite why a patient was enrolled last week.
**Bump `criterionVersion` whenever a criterion changes.**

A decline is the only signal in the system that a clinician disagreed with a
criterion. It is retained with a reason and the version it was made against, and
it **suppresses the suggestion until the criteria change** — declining again today
would change nothing, because the same criterion would produce the same
suggestion.

`GET /admin/cohorts/declines` reports, per cohort:

- `declines` / `acceptances` / `declineRate` — **current version only**; a verdict
  an older criterion earned is never carried forward;
- `reasons[]` grouped, and `clustered` when ≥2 declines concentrate on one reason;
- `byVersion[]` with `stale` flags, so the history stays visible without
  contaminating the judgement;
- `recommendation` — evidence for a human, and **never an automatic edit**;
- `retireCandidate` — every suggestion declined and none accepted, over the
  sample floor (`DECLINE_SAMPLE_FLOOR = 3`).

Below the sample floor the signal is reported as an **observation with its sample
size** ("2 of 2 declines share one reason…; 3 decisions are the floor before that
is worth acting on") rather than withheld or dressed up as a recommendation.

## Identity: a patient id is only unique within a realm

Membership and decision records are keyed by **(cohort, realm, patient)** —
`cohortId::realmId::patientId`. The realm is part of the key because a local
patient identifier is only unique inside one facility, and the reference fleet
demonstrates why: `f1-pt-0001` exists in **both** `realm:b3` and `realm:c2`.

Keying on `cohortId::patientId` merged those two patients into **one**
explainability record — one facility's reason, `enteredAt` and history silently
overwrote the other's. Because the two rows then differed on every pass, the
record was rewritten on every poll forever, and the history accumulated churn that
never happened. Measured on the live fleet:

| | before | after |
|---|---|---|
| membership rows persisted | 456 (8 lost to collisions) | **464** (= 8 cohorts × 58 patients) |
| changed rows on every repeat poll | 8, indefinitely | **0** |
| entry/exit events for 25 members | 36 entered / 11 exited | **25 entered / 0 exited** |

The same key scopes **declines**. Without the realm, a decline recorded for
`f1-pt-0001` in one facility suppressed the suggestion for the same local
identifier in another facility, where nobody had judged anything.

`/api/work` item ids encode all three parts (`cohort:<realm>:<cohort>:<patient>`,
each percent-encoded) so a drawer can never resolve the wrong facility's patient.

## Calibration — thresholds come from the pack, checked against the fleet

A shipped cohort whose criteria can never be satisfied is worse than no cohort: it
reports `0 members` and reads as "nobody is at risk". Four of the eight shipped
cohorts were in that state, and one metric could not discriminate at all.

Every threshold here is a **boundary the pack already declares** (its target band,
its floor, its risk tier) — never a percentile invented from the observed data.
A percentile cut looks precise and is quietly fleet-dependent: it selects a
different clinical population after any data change, which is exactly the silent
disagreement with the protocol this layer exists to prevent.

### What the pack declares, measured over 58 patients

| metric | observed |
|---|---|
| `hgb.slopePerWeek` | −0.12 … 0.31 g/dL/wk |
| `hgb.forecast4w` | 10.65 … 13.16 g/dL |
| `phosphate.current` | 3.5 … 6.6 mg/dL (pack ceiling 5.5 → 3 patients) |
| `phosphate.slopePerWeek` | −0.31 … 0.33 mg/dL/wk (rising → 25 patients) |
| `urr.current` | 67 … 85 % (pack floor 60 → 0 patients) |
| `protocol.severity.fluid` | tiers {0, 0.35, 0.5, 0.6}; ≥0.6 → 25 patients |
| `protocol.severity.access` | tiers {0, 0.25, 0.5, 0.6, 0.7}; ≥0.6 → 18 patients |
| `idh.nextSessionProbability` | 0.029 … 0.088 (after the fix below) |

### What changed

| cohort | was | now | why |
|---|---|---|---|
| `idh-next-session` | `idh.nextSessionProbability >= 0.6` | `protocol.severity.fluid >= 0.6` | the threshold was **above the metric's own ceiling** |
| `hgb-deviation-4w` | slope ≤ −0.15 **and** forecast < 10 | slope ≤ −0.05 **and** forecast < 11 | both thresholds sat outside the observed range |
| `inadequate-clearance` | adequacy severity ≥ 0.5 **and** sessions ≥ 1 | URR < 60 **or** Kt/V < 1.2 | the two criteria were **mutually exclusive by construction** |
| `access-deterioration` | observations ≥ 3 **and** severity ≥ 0.5 | `protocol.severity.access >= 0.6` | the precondition excluded every patient the cohort existed to find |
| `mbd-worsening` | *(unchanged)* | *(unchanged)* | **legitimately empty** — see below |

Live result: `idh-next-session` 0 → 25 members, `hgb-deviation-4w` 0 → 5,
`access-deterioration` 0 → 18, and `inadequate-clearance` reports
`criteria-too-strict` naming URR with the observed range — i.e. "clearance is
measured and everybody is above the pack floor", which is a fact, not a gap.

**`inadequate-clearance` is the instructive one.** Its adequacy-severity branch
rose to 0.5 *only for patients with no sessions on record* — severity was
responding to missing data, not to inadequate clearance — and the cohort then
required a session. Composing the advisor's severity was wrong: absence of a
measurement is coverage, not a clinical finding.

**`mbd-worsening` was left alone on purpose.** Phosphate above the pack's 5.5
ceiling *and still rising* is a genuine clinical proposition ("not responding to
current therapy" — distinct from a single high value, since a patient above target
whose trend is falling is responding). On this fleet the 3 above-target patients
are all falling, so the cohort is empty because nobody qualifies — which is what a
working cohort looks like. `coverage.diagnosis = no-joint-overlap` now says so,
and the verdict deliberately does **not** claim the definition is broken, because
the counts cannot distinguish "mutually exclusive" from "no such patient here".

Its rationale previously claimed a PTH criterion that did not exist. A cross-analyte
cohort is also not expressible: the vocabulary supports a flat AND or a flat OR,
not groups. The coupled picture is available as the single metric
`protocol.severity.ckd-mbd`, which is the pack's own coupled output.

### The metric that could not discriminate

`idh.nextSessionProbability` claimed to be "the fluid advisor's mechanistic prior"
but was resolved with a systolic reading and **nothing else**. The prior is driven
by the UF rate above all else, then nadir BP, IDWG, age and cardiac history — so
supplying one term collapses it to `0.055 × (110 − sbp)`, a near-constant
0.029–0.04 across an entire fleet. An operator could author a threshold on it and
the cohort would never fire, silently, forever. It now receives every input the
facts layer carries, which widens the range to 0.029–0.088.

**Residual limitation, stated in the metric's own `source` field:** the facts carry
UF volume and delivered minutes but no body weight, so `ufRatePerKg` cannot be
computed and the prior falls back to its 8 mL/kg/h default. It therefore
under-weights its dominant term and tops out near 0.55 rather than the ~0.74 a
fully-specified patient reaches. A *trained* fluid head (AUROC 0.913) is not
exposed as a cohort metric.

## Superseded seeds are upgraded — but never over an operator's edit

Seeding is idempotent per cohort id and never overwrites an operator's edit, which
is right. It also means a **corrected** shipped definition would never reach a
deployment that already stored the broken one — the catalog would keep criteria
that cannot fire, forever, and the correction would only ever appear on a fresh
store.

So the four definitions as previously shipped are kept (with the reason they were
replaced), and `seedUpgradeFor` applies the correction **only** when the stored
definition is still, byte for byte, the clinical logic we shipped:

- an operator who changed a threshold, reordered criteria or disabled the cohort
  keeps their definition;
- notes are ignored when matching (they cannot change who is admitted, and Postgres
  JSONB does not preserve key order, so comparing raw objects would be wrong);
- the upgrade is logged with its reason and bumps `criterionVersion`, which also
  legitimately re-opens any decline recorded against the old criteria.

## Performance

Evaluation used to perform **one full realm-ledger scan per lab-series lookup**.
On the reference fleet (11 realms, 49,901 ledger effects, 58 patients) one
8-cohort evaluation did **465 scans** and took **42s** to produce a 13ms answer.

| | before | after |
|---|---|---|
| ledger scans per evaluation | 465 | **1** |
| `POST /admin/cohorts/evaluate` (live) | 42.1 s | **0.20 s** |
| `GET /admin/cohorts/state` (live) | 42.6 s | **0.10 s** |

Two further properties matter for a queue that is polled:

- **Membership rows are written only when their recorded content changes.** An
  unchanged row is byte-identical to what is already durable, so rewriting it adds
  latency and no information. `lastEvaluatedAt` therefore means *the last
  evaluation that changed this record*, not the last poll; the run instant is
  reported by the evaluation itself.
- **Entry/exit history is stable under repeated polling.** A membership row
  records `entered` → `exited` → `entered`, once each.

## Not built yet

Honest scope, so nobody reads the catalog as more than it is:

- **No cross-cohort arbitration.** When several cohorts suggest conflicting
  actions for one patient, nothing resolves the conflict;
- **No automatic criterion tuning.** Declines are reported, never applied;
- **No criterion groups.** The vocabulary supports a flat AND (`entryMode: 'all'`)
  or a flat OR (`'any'`), not `(A AND B) OR C`, so a cross-analyte proposition has
  to be served by a pack's coupled severity metric instead;
- **No cohort rule packs** in the AI-assurance registry;
- **No phenotype discovery or target-trial causal estimation.**

Two things to read alongside the catalogue rather than as defects:

- **Prevalence is inherited from the packs.** `idh-next-session` covers 43% of the
  reference fleet and `access-deterioration` 31%, because those are the sizes of
  the fluid and access packs' own red tiers on this synthetic population. Because
  the cohorts compose the packs, tightening a pack tightens every cohort that
  depends on it — in one place. A broad cohort is visible in `prevalence`, and a
  cohort below `minN` reports `insufficient` rather than a number.
- **A shipped definition that was corrected is logged, not silently swapped.**
  Watch for `[cohorts] upgraded shipped cohort '<id>' from vX to vY: <reason>`.

Also note that `/api/work` evaluates cohorts, so it shares the evaluation cost
above — which is why the scan count is asserted in
`tests/cohort-coverage.test.ts` rather than left to a timing observation.
