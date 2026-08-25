/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

export * from './types.js';
export * from './clock.js';
export * from './entity-graph.js';
export * from './effect-ledger.js';
export * from './presence.js';
export * from './perception.js';
export * from './effect-reducer.js';
export * from './ambient.js';
export * from './realm.js';
export * from './sim-populator.js';
export * from './registry.js';
export * from './episode.js';
export * from './self-model.js';
export * from './choice.js';
export * from './rules.js';
export * from './agent-runtime.js';
export * from './attribution.js';
export * from './narrative.js';
export * from './replay.js';
export * from './org-graph.js';
export * from './planner.js';
export * from './hitl.js';
export * from './cost-ledger.js';
export * from './operator-seat.js';
export { PlanRunner, type PlanRunOutcome, type PlanRunnerHooks } from './plan-runner.js';
export { Federation, type ProviderOrg } from './federation.js';
export { PolicyRuntime, type Candidate, type RankedOption } from './policy.js';
export { OllamaPlannerAdapter, OllamaOperatorAdapter, type OllamaConfig } from './llm-ollama.js';
export { runCounterfactual, type CounterfactualInput, type CounterfactualReport, type TimelineEntry, type Intervention } from './counterfactual.js';
export { invoicePreview, usageCsv, DEFAULT_BILLING_PLAN, type BillingPlan, type UsageReport, type MeterLineItem, type EpisodeLineItem, type UsagePeriod } from './billing.js';

// ---- M14 module exports ----
export { type PlanRunLogEntry } from './plan-runner.js';
export { listDirectives, listPlanAdvances, directivesByTarget, attachEvidence, type DirectiveEntry, type PlanAdvanceEntry, type GovernanceQueryFilter } from './governance.js';
export { NotificationBus, NotificationHub, attachBus, type Notification, type Subscription, type NotificationSink } from './notifications.js';
export { LLMRegistry, type RegisteredAdapter, type AdapterRole, type AdapterHealth } from './llm-registry.js';
export { CounterfactualStore, type CounterfactualRecord } from './counterfactual-store.js';
export { captureSnapshot, restoreSnapshot, SnapshotRegistry, SNAPSHOT_VERSION, type RealmSnapshotV1, type RestoreOptions } from './realm-snapshot.js';

// ---- M25 module exports ----
export { NudgeLedger, InAppNudgeChannel, StubNudgeChannel, sqliteNudgePersistence, type NudgeSpec, type NudgeRecord, type NudgeChannel, type NudgeChannelAdapter, type NudgeStatus } from './nudges.js';
