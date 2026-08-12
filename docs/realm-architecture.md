# The Realm — a world for agents to inhabit

## Motivation

Today's "agentic" systems are request/response plumbing. An agent runs, returns
a result, disappears. There is no place, no time between turns, no shared
reality that other agents can feel. This is not agency — it is stateless
function invocation with prose.

A **Realm** is a persistent, tickable world where agents *materialize
existence*. State exists whether or not any agent is watching. Actions
propagate causally. Time advances continuously. Agents perceive only what
their position and clearance allow. What one agent does becomes part of the
world every other agent then perceives.

The harness already had the engine parts — canonical events, mutation ledger,
audit chain, scoped persistence, event-triggered agents. M8 binds them into
an inhabited realm.

## Core primitives

### Realm

```
class Realm {
  id: RealmId
  mode: 'sim' | 'twin'
  clock: Clock
  entities: EntityGraph
  effects: EffectLedger
  ambient: AmbientProcessRegistry
  presences: PresenceRegistry     // where each agent "is"
  perception: PerceptionRouter    // filters world → each presence
}
```

A Realm is a single running world. It has an ID, a mode, a clock, an entity
graph, an effect ledger (append-only), a set of ambient processes ticking
between agent turns, and a map of every agent's presence.

Multiple realms can run concurrently in one server (e.g. a production twin
of a dialysis clinic plus 40 sim realms running agent evaluations in
parallel).

### Clock

Two implementations behind one interface:

- **WallClock** — 1s wall = 1s realm. Used in twin mode.
- **AcceleratedClock** — configurable rate (e.g. 1 tick = 1 hour of realm
  time, ticked every 100ms wall). Used in sim/eval mode. Deterministic.

Ambient processes and agent triggers both fire off clock events. The clock
is authoritative — nothing in the realm advances without a tick.

### EntityGraph

Every meaningful thing in healthcare is an entity node with typed state,
relations to other entities, and a per-attribute history.

Entity kinds (v1):

- `Facility` — dialysis clinic, hospital, urgent care, primary care office
- `Unit` — ICH-6, Bay-3, ED, OR-2, station-42
- `Patient` — demographics, problem list, allergies, presence
- `Encounter` — a specific visit / stay
- `Order` — lab, medication, procedure, referral
- `Result` — lab result, imaging report, note
- `Medication` — administered or prescribed drug
- `Staff` — RN, MD, PA, tech (agents are staff-shaped)
- `Equipment` — dialysis chair, IV pump, monitor
- `Insurance` — payer, plan, authorization, claim
- `AgentRun` — a materialized run of an agent (persisted as an entity in
  the world so other agents can perceive that it happened)

Entities are addressed by URN (`urn:realm:<realmId>:patient:<id>`). Every
mutation is recorded on the ledger.

### EffectLedger

Agents do not return data. They emit `WorldEffect`s. An effect is a typed,
governance-annotated intent to mutate the world:

```
type WorldEffect =
  | { kind: 'admit-patient', patientId, facilityId, unitId }
  | { kind: 'order-lab', patientId, code, priority }
  | { kind: 'result-lab', orderId, code, value, unit }
  | { kind: 'administer-med', patientId, code, dose, route }
  | { kind: 'titrate-dose', medRef, delta }
  | { kind: 'discharge-patient', patientId, disposition }
  | { kind: 'schedule-followup', patientId, when, resource }
  | { kind: 'notify-staff', target, message, priority }
  | { kind: 'submit-claim', encounterId, payerId, cptCodes }
  | { kind: 'record-assessment', patientId, assessmentId, score }
  | { kind: 'update-carePlan', patientId, patch }
  | { kind: 'flag-safety-event', patientId, kind, severity }
  ...
```

An effect goes through the `EffectReducer` which:

1. Verifies the emitting agent's presence has authority to emit this effect
   (RBAC + governance clearance)
2. Applies the entity mutations transactionally
3. Appends the effect + resulting mutations to the ledger with content hash
4. Emits canonical events for perceptual radiation
5. Optionally triggers ambient consequences (e.g. `admit-patient` starts
   the encounter clock; `order-lab` schedules a `mature-lab` ambient job
   that will emit `result-lab` after the specimen turnaround interval).

### AmbientProcesses

The world runs between agent turns. Registered ambient processes:

- **Lab maturation** — an ordered lab, after its realistic turnaround (STAT
  30min, routine 4h, send-out 24h), automatically produces a result. In sim
  mode the value is drawn from a physiological model tied to the patient's
  trajectory. In twin mode the ambient process is a *placeholder* until the
  real HL7 result arrives.
- **Medication metabolism** — dosed meds have concentration/effect curves
  that tick over realm time.
- **Patient trajectory** — each patient has an underlying physiological
  trajectory (e.g. worsening anemia, improving BP under GDMT titration).
  Vitals, labs, symptoms drift along the trajectory unless an intervention
  changes it.
- **Insurance clocks** — prior-auth deadlines, timely-filing windows, and
  claim adjudication SLAs tick down and emit events at thresholds.
- **Staffing shifts** — RN/MD availability cycles by shift; agents can
  perceive who is on the floor.
- **Environmental** — census, wait times, chair utilization.

Ambient processes are the reason the world feels alive. They convert time
into events without agent involvement.

### Presence

An `AgentPresence` is the agent's "body" in the realm.

```
type Presence = {
  agentId: AgentSpecId
  runId: RunId
  realmId: RealmId
  location: { facilityId, unitId?, patientRef? }
  role: 'nurse' | 'md' | 'pharmacist' | 'coder' | 'ops' | 'auditor' | ...
  clearance: 'internal' | 'phi' | 'restricted-phi' | ...
  perceptualRange: { units: string[], patients: string[], eventTypes: string[] }
  attention: 'active' | 'idle' | 'paused'
  spawnedAt, lastPerceivedAt
}
```

Presence determines *what the agent can see and what it can do*. Two nurse
agents in different units perceive different patients. A pharmacist agent
sees all orders across the facility but not admission dispositions. Moving
presence (e.g. `presence.move(unitId: 'ICH-6')`) changes the perceptual
field.

Presences are first-class entities in the graph — other agents can perceive
"there is an agent covering ICH-6 right now."

### PerceptionRouter

The perception router takes the raw event stream + entity mutations and
filters them per presence:

```
router.subscribe(presenceId, callback)
  → callback receives only events / mutations that pass:
    1. governance filter (clearance ≥ required, purpose-of-use match)
    2. locality filter (entity is in presence.perceptualRange)
    3. subscription filter (agent explicitly subscribed to this event type)
```

This is what enforces that "the agent lives in the world" rather than
having omniscient DB access. Perception is the primary invariant.

### Materialization

When an agent completes a plan, the outcome is not just returned — it is
materialized as entities and effects in the world. The agent's run itself
is an entity (`AgentRun`). The effects it emitted are entities (`Effect`).
Other agents can then perceive "this Kt/V outreach was performed at
09:42 by dialysis-primary-nurse-agent, and it resulted in the following
titration order which the RN acknowledged at 09:55."

Materialization is what makes the world durable and what makes agents
inhabit rather than transact.

## Sim mode vs Twin mode

Same substrate, two run modes.

### Sim mode

- Realm is bootstrapped from a synthetic population generator (parameterized
  by facility kind, census, comorbidities, SES distribution).
- Ambient processes drive patient physiology from stochastic trajectories.
- No external I/O; all effects apply only to the realm.
- Agents run against the sim to be *evaluated* — did the sepsis agent catch
  the septic patient before the ambient trajectory decompensated? Did the
  Kt/V outreach agent recover URR before the next month's ESRD-QIP window?
- Deterministic on seed; runs are replayable.

### Twin mode

- Realm is hydrated from live feeds (HL7 ADT/ORM/ORU, FHIR subscriptions,
  EHR APIs, CMS eligibility, X12 remits). Ambient processes still tick,
  but real events override the sim projections.
- Effects that mutate the twin can be `shadow` (dry run — log the intended
  effect, do not touch external systems) or `bound` (emit outbound orders,
  claims, notifications through the connected system connectors).
- The shadow → bound cutover is per-effect-kind and gated by human
  approval (uses the M7 draft/publish workflow — an effect kind becomes
  "bound" only when an operator publishes a binding).

### Migration between modes

A twin can be *forked* into a sim (snapshot the entity graph + clock,
switch clock to accelerated, disable outbound bindings). This is how you
evaluate "what would happen next week if we did nothing" or "how would
this new policy behave against yesterday's real caseload."

## How this changes the harness

- **AgentSpec** gains a `realm` block: which presences the agent claims,
  which effect kinds it may emit, which perceptual subscriptions it needs.
- **AgentRuntime** no longer just executes a plan — it acquires a Presence,
  perceives, plans, emits effects, and yields back to the realm loop.
- **AdminUI** gains a **Realm** view: map of facilities/units, patients in
  each unit, agents currently present, live effect log, sim controls
  (pause/tick/rewind/fork).
- **Governance** gains "effect kind bindings" — the human decides which
  effects are shadow vs bound per environment.

## Invariants (must never break)

1. **No agent may perceive or mutate an entity outside its presence's
   perceptual range and effect authority.** Enforced by the router + reducer.
2. **Time is authoritative.** Nothing in the world advances except through
   a clock tick. Agents may not directly write past-dated events.
3. **Effects are immutable once ledgered.** Reversal requires a compensating
   effect (`revoke-order`, `refund-claim`, `correct-result`), not a rewrite.
4. **Perception ≠ Query.** Agents cannot bypass the router to read the
   entity graph directly. Even the runtime holds only the router handle.
5. **Presence is disclosed.** Other agents (with permission) can perceive
   who else is present. This is what allows coordination.
6. **Realm state is replayable.** Given the seed + effect ledger, the
   entire realm can be reconstructed. This makes sim eval scientific and
   twin audit legally durable.

## What "materialize existence" means, concretely

Before M8: `agent.run() → { verdict: 'k+ elevated', recommendation: 'hold_ace' }`

After M8: agent acquires presence in `facility-dvc-nash / unit-ICH-6`, perceives
`Result(K=6.1)` arriving on `Patient-1024`, emits
`Effect(hold-medication, patient=1024, code=lisinopril, reason=hyperkalemia)`.
The reducer verifies the pharmacist agent has hold authority, records the
effect on the ledger, updates `Patient-1024`'s active-medications entity,
and radiates the mutation. The rounding-MD agent (also present on ICH-6)
perceives the hold within its next perception cycle and drafts an alternate
regimen. The MAR-generation ambient process reflects the hold in tonight's
med pass. The pharmacy-billing agent, present at facility level, perceives
the hold as a claim-relevant event. The world has changed. The agent
existed in the world.
