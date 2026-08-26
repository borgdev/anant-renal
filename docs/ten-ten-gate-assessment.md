# 10/10 Product Gate — Self-Assessment (spec §36)

> A cross-functional product jury scores each dimension from **executable
> evidence, not presentation**. Any score below 10 creates a product finding
> with owner, acceptance test and retest. This is the honest current state —
> scores, the evidence behind them, and the remaining findings.
>
> Status legend: **10** met · **9** met with minor polish · **8** partial ·
> **7** meaningful gap. Last updated 2026-08-26 (full suite **601+ passing**).

| # | Dimension | Score | Evidence | Remaining finding (owner) |
|---|---|---|---|---|
| 1 | Product clarity | 8 | Exec (Outcome Workspace) + admin (Control Center) with lens-aware terminology (Anant Payer / Member intelligence); exec `app.tsx` + `my-work.tsx` default landing | One-session new-user scripted test (Product) |
| 2 | First-use journey | 8 | My Work is the default exec landing; 8-step onboarding gate (`platform-onboarding`); role-scoped queues | Some drill-down surfaces still terse (Product/UX) |
| 3 | Two-UI unity | 9 | Shared identity/session, `/api/context`, console switcher both directions; one backend truth; no duplicated auth | Cross-console handoff polish (Product) |
| 4 | Closed-loop integrity | 9 | Provider (`outcome-episode.ts`) + payer (`payer.ts` network.access full loop) closed loops → Resolved; e2e `tests/e2e-closed-loop.test.ts`; reopen via late-correction | Reopen e2e for every journey (Product) |
| 5 | Evidence/trust | 8 | SHA-256 hashes, provenance, versioned releases/dossiers, `/api/graph`, canvas citations (`addCanvasNote`) | Analytical marts + first-class bitemporal (Data) |
| 6 | Human authority | 9 | A/B/C/D action classes, approval classes on episodes, dual Class-D CMS approval, policy default-deny, role guard (`api-auth.ts`) | Class-D routing table surfaced in exec (Product) |
| 7 | Pack configurability | 9 | Renal + payer proof on the SAME runtime/coordinator/workspace; lens flips terms; no redeploy | Pack Studio lifecycle UX (Product) |
| 8 | Agent operability | 9 | Agent Studio (173 agents): author/test/kill/rollback/output-topic; run stats; DLQ | Single/multi-topic trigger authoring UX polish (Product) |
| 9 | Failure recovery | 8 | DLQ detail/acknowledge/idempotent-replay; retention purge; webhook retry→DLQ; broker health | Hosted Kafka-bridge deployable (Infra) |
| 10 | Regulatory completeness | 9 | Journey K: source→measure→package→freeze→dual Class-D→reference-mode gate→receipt→reconcile; retained evidence+receipt | Live-transmission (certified) path is demo-gated by design (Product) |
| 11 | Assurance | **10** | Unsafe release cannot validate/activate; findings remediated→retested→independently reviewed→closed; provider/payer adversarial journeys (rt-009..012) | — |
| 12 | UX/accessibility | 7 | Consistent design system, universal detail, no dead-end cards by contract | WCAG AA audit + fake-data labeling sweep (UX) |
| 13 | Reliability/security | 8 | Idempotency (outbox/broker/work actions), `tests/security-isolation.test.ts`, break-glass rt-002/011, role/scope guard | Real-broker conformance (testcontainers) + load/chaos drills (Eng) |
| 14 | Outcome value | 7 | Episodes verify with measure result; payer kpis; exec outcomes view | Verified-value + burden/cost rollups (Journey N) (Product/Data) |
| 15 | Team handoff | 8 | ARCHITECTURE.md, deployment.md, enterprise-implementation.md, this runbook (`phase-f-demo-runbook.md`) | Restore/incident runbooks + operator training (Eng) |

## Priority findings to close before 10/10

1. **P0 — Outcome value (#14):** verified-value rollups (not activity counts) + delegation with owner/SLA → Journey N.
2. **P1 — UX/accessibility (#12):** WCAG AA audit; every card clickable with a universal detail.
3. **P1 — Pack Studio (#7):** solution-pack lifecycle UX (install/configure/release/rollback without redeploy).
4. **P1 — Reliability (#13):** real-broker conformance + load/chaos/restore drills.
5. **P2 — Evidence (#5):** analytical marts + first-class bitemporal projections.
6. **P2 — Infra (#9):** hosted Kafka-bridge deployable.

> **Assurance (#11) already meets 10/10** — the port plan Phase E exit is
> demonstrably met: an unsafe release is blocked, findings are remediated,
> retested and independently closed, and provider/payer adversarial journeys
> are part of the required suite.
