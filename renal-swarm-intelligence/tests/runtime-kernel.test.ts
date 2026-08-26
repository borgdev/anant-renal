import assert from "node:assert/strict";
import test from "node:test";
import agentManifests from "../config/agent-manifests.json";
import { runRuntimeRedTeam } from "../lib/runtime/evals";
import { runtimeReplayEvents } from "../lib/runtime/fixtures";
import { authorizedForAction, derivePortfolio, evaluateEligibleCells, simulateFacilityPlan, simulatePolicyReplay, validateCanonicalEvent } from "../lib/runtime/kernel";
import type { CanonicalEvent } from "../lib/runtime/types";

const events = runtimeReplayEvents.map((event) => ({ ...event, integrity: { algorithm: "sha256" as const, contentHash: "0".repeat(64) } } as CanonicalEvent));

test("canonical replay covers every bounded cell with valid envelopes", () => {
  const cells = new Set<string>();
  for (const event of events) {
    const validation = validateCanonicalEvent(event);
    assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.join(", "));
    for (const proposal of evaluateEligibleCells(event)) cells.add(proposal.agentId);
  }
  assert.deepEqual([...cells].sort(), ["access-cell", "assessment-cell", "asset-cell", "capacity-cell", "cms-cell", "continuity-cell", "demand-cell", "experience-cell", "quality-cell", "revenue-cell", "transition-cell", "workforce-cell"]);
});

test("active manifests hot-gate agent eligibility without changing code", () => {
  const manifests = agentManifests.map((manifest) => ({
    ...manifest,
    approvalClass: manifest.approvalClass as "A" | "B" | "C" | "D",
    enabled: manifest.id !== "assessment-cell",
  }));
  const assessment = events.find((event) => event.eventType === "assessment.response.v1");
  assert.ok(assessment);
  const proposals = evaluateEligibleCells(assessment, manifests);
  assert.equal(proposals.some((proposal) => proposal.agentId === "assessment-cell"), false);
  assert.equal(proposals.some((proposal) => proposal.agentId === "experience-cell"), true);
});

test("swarm portfolio derives converged insights, ranked actions and an explicit conflict", () => {
  const portfolio = derivePortfolio(events);
  assert.equal(portfolio.insights.length, 5);
  assert.equal(portfolio.nbas.length, 4);
  assert.equal(portfolio.conflicts.length, 1);
  assert.equal(portfolio.nbas[0].id, "NBA-RUNTIME-2201");
  assert.ok(portfolio.insights.some((insight) => insight.agentIds.length >= 3));
});

test("policy simulation is bounded, deterministic and changes surfaced actions", () => {
  const baseline = simulatePolicyReplay(events, 8200);
  const strict = simulatePolicyReplay(events, 9500);
  assert.deepEqual(simulatePolicyReplay(events, 8200), baseline);
  assert.equal(baseline.episodesSurfaced, 4);
  assert.equal(strict.episodesSurfaced, 3);
  assert.equal(strict.blockedActions, 1);
  assert.equal(simulatePolicyReplay(events, 10000).thresholdBasisPoints, 9500);
});

test("facility twin simulation resolves persisted capacity and patient preference evidence", () => {
  const result = simulateFacilityPlan(events, { facilityId: "facility-franklin", station: 4, proposedAt: "2026-08-21T19:30:00.000Z" });
  assert.equal(result.feasible, true);
  assert.equal(result.runtimeEffect, false);
  assert.ok(result.checks.every((check) => check.passed));
  assert.ok(result.checks.find((check) => check.id === "patient-constraint")?.evidenceEventIds.includes("evt-demo-assessment-011"));
});

test("action classes deny unsafe role escalation", () => {
  assert.equal(authorizedForAction("fa", "D", "medical").allowed, false);
  assert.equal(authorizedForAction("dvp", "B", "fa").allowed, true);
  assert.equal(authorizedForAction("medical", "C", "medical").allowed, true);
});

test("all configured red-team scenarios execute passing control assertions", async () => {
  for (let index = 1; index <= 8; index += 1) {
    const result = await runRuntimeRedTeam(`rt-${String(index).padStart(3, "0")}`);
    assert.equal(result.passed, true, `${result.scenarioId}: ${result.checks.filter((check) => !check.passed).map((check) => check.name).join(", ")}`);
    assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
  }
});
