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
| `no-joint-overlap` | every criterion is individually satisfiable, but no patient satisfies them **together** | the cohort is unsatisfiable as written — fix the criteria |
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
- **No cohort rule packs** in the AI-assurance registry;
- **No phenotype discovery or target-trial causal estimation.**

Also note that `/api/work` evaluates cohorts, so it shares the evaluation cost
above — which is why the scan count is asserted in
`tests/cohort-coverage.test.ts` rather than left to a timing observation.
