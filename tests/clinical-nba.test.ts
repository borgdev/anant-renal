import { describe, it, expect } from 'vitest';

import {
  clinicalNbaState,
  clinicalActionsPayload,
  clinicalSubject,
  CLINICAL_ACTION_MAPS,
  type ClinicalFinding,
} from '../src/swarm/clinical-nba.js';
import { ADEQUACY_CELLS } from '../src/swarm/adequacy.js';
import { FLUID_CELLS } from '../src/swarm/fluid.js';
import { ACCESS_CELLS } from '../src/swarm/access.js';
import { ESA_CELLS } from '../src/swarm/anemia.js';
import { MBD_CELLS } from '../src/swarm/mbd.js';
import { NUTRITION_CELLS } from '../src/swarm/nutrition.js';
import { INFECTION_CELLS } from '../src/swarm/infection.js';
import { cellAllowlist } from '../src/swarm/cells.js';
import type { CellManifest } from '../src/swarm/cells.js';
import type { WorldEffectKind } from '../src/swarm/types.js';

/**
 * The bridge is the ONLY place clinical vocabulary becomes governed action. Its
 * two invariants are what these tests defend:
 *
 *   1. An NBA names one action, and only a cell whose manifest allows that action
 *      kind may propose it. (Otherwise a protocol could "recommend" something the
 *      cell is not permitted to do — a governance bypass, not a bug.)
 *   2. A value claim carries its unit. No clinical action is denominated in
 *      dollars; the previous `expectedOutcome * 1000` invented ~$13.8M from an
 *      effect count and that must never come back.
 */

const PROTOCOLS: Array<{ protocol: keyof typeof CLINICAL_ACTION_MAPS; cells: CellManifest[] }> = [
  { protocol: 'adequacy', cells: ADEQUACY_CELLS },
  { protocol: 'fluid', cells: FLUID_CELLS },
  { protocol: 'access', cells: ACCESS_CELLS },
  { protocol: 'anemia', cells: ESA_CELLS },
  { protocol: 'mbd', cells: MBD_CELLS },
  { protocol: 'nutrition', cells: NUTRITION_CELLS },
  { protocol: 'infection', cells: INFECTION_CELLS },
];

describe('clinical action maps — governance invariant per protocol', () => {
  it.each(PROTOCOLS)('$protocol: every action is owned and allowed by its cell', ({ protocol, cells }) => {
    const map = CLINICAL_ACTION_MAPS[protocol];
    expect(Object.keys(map).length).toBeGreaterThan(0);
    for (const [token, spec] of Object.entries(map)) {
      if (spec === null) continue; // deliberate no-op (in band / blocked) — no owner needed
      const cell = cells.find((c) => c.id === spec.cellId);
      expect(cell, `${protocol}.${token} references unknown cell ${spec.cellId}`).toBeDefined();
      expect(
        cell!.allowedActions,
        `${protocol}.${token} emits ${spec.kind} but ${spec.cellId} only allows ${cell!.allowedActions.join(', ')}`,
      ).toContain(spec.kind);
    }
  });

  it.each(PROTOCOLS)('$protocol: every actionable token carries a non-empty label and horizon', ({ protocol }) => {
    const map = CLINICAL_ACTION_MAPS[protocol];
    for (const [token, spec] of Object.entries(map)) {
      if (spec === null) continue;
      expect(spec.label.length, `${protocol}.${token} has no label`).toBeGreaterThan(0);
      expect(spec.horizon, `${protocol}.${token} has a non-positive horizon`).toBeGreaterThan(0);
      expect(spec.urgency).toBeGreaterThanOrEqual(0);
      expect(spec.urgency).toBeLessThanOrEqual(1);
    }
  });

  it('no clinical action is denominated in dollars', () => {
    for (const { protocol } of PROTOCOLS) {
      for (const [token, spec] of Object.entries(CLINICAL_ACTION_MAPS[protocol])) {
        if (spec === null) continue;
        expect(spec.valueUnit, `${protocol}.${token} claims a dollar value`).not.toBe('dollars');
      }
    }
  });

  it('anemia dose titration is denominated in doses, not dollars', () => {
    const anemia = CLINICAL_ACTION_MAPS.anemia;
    // A titration IS an action, so it must carry a real unit.
    for (const token of ['increase', 'reduce', 'suspend']) {
      expect(anemia[token], `anemia.${token} missing`).not.toBeNull();
      expect(anemia[token]!.valueUnit).toBe('doses');
    }
    // 'hold' means the dose does NOT change (in-band, or already off ESA) and
    // 'blocked' is a guardrail verdict — both are real no-ops, so both map to
    // null rather than to a fabricated action. Null is silent, not a gap.
    expect(anemia.hold).toBeNull();
    expect(anemia.blocked).toBeNull();
  });
});

describe('clinical bridge — dispatch and diagnostics', () => {
  const MBD_CLINICAL_ACTIONS_CELL = 'mbd-therapy-advisor';
  expect(MBD_CELLS.some((c) => c.id === MBD_CLINICAL_ACTIONS_CELL)).toBe(true);

  const finding = (patientId: string, action: string): ClinicalFinding => ({
    patientId,
    facilityId: 'rb-knoxville-a',
    realmId: 'knoxville-a',
    action,
    observed: 6.1,
    recommendation: 'Clinical action under test',
    evidence: [{ sourceId: `mbd:${patientId}`, contentType: 'fact' }],
  });

  const state = (findings: ClinicalFinding[]) =>
    clinicalNbaState({
      protocol: 'mbd',
      insightKind: 'mbd.therapy.proposal',
      cells: MBD_CELLS,
      consumedBy: { 'mbd.therapy.proposal': ['mbd-therapy-advisor'] },
      actionMap: CLINICAL_ACTION_MAPS.mbd,
      findings,
    });

  it('an actionable finding becomes one NBA naming its governed action', () => {
    const s = state([finding('pt-real-1', 'increase-binder')]);
    expect(s.unmapped).toEqual([]);
    expect(s.diagnostics.rejected).toEqual([]);
    expect(s.nbas).toHaveLength(1);
    const nba = s.nbas[0]!;
    expect(nba.subject).toBe(clinicalSubject('pt-real-1'));
    expect(nba.actionKind).toBe('update-care-plan');
    expect(nba.valueLabel).toContain('doses');
    expect(nba.valueLabel).not.toContain('$');
    expect(nba.scopeType).toBe('patient');
    expect(s.considered).toBe(1);
    expect(s.actionable).toBe(1);
    expect(s.suppressed).toBe(0);
  });

  it('a null-mapped token is suppressed silently, not reported as a coverage gap', () => {
    const s = state([finding('pt-real-2', 'hold')]);
    expect(s.nbas).toEqual([]);
    expect(s.unmapped).toEqual([]);
    expect(s.suppressed).toBe(1);
    expect(s.actionable).toBe(0);
  });

  it('an unknown token is reported as a coverage gap and never dispatched', () => {
    const s = state([finding('pt-real-3', 'some-unmapped-verdict')]);
    expect(s.nbas).toEqual([]);
    expect(s.unmapped).toEqual(['some-unmapped-verdict']);
    expect(s.suppressed).toBe(1);
  });

  it('a cell that does not allow the action kind REJECTS the candidate', () => {
    const starved: CellManifest[] = MBD_CELLS.map((c) =>
      c.id === MBD_CLINICAL_ACTIONS_CELL ? { ...c, allowedActions: ['open-ticket'] as WorldEffectKind[] } : c,
    );
    const s = clinicalNbaState({
      protocol: 'mbd',
      insightKind: 'mbd.therapy.proposal',
      cells: starved,
      consumedBy: { 'mbd.therapy.proposal': ['mbd-therapy-advisor'] },
      actionMap: CLINICAL_ACTION_MAPS.mbd,
      findings: [finding('pt-real-4', 'increase-binder')],
    });
    expect(s.nbas).toEqual([]);
    expect(s.diagnostics.rejected).toHaveLength(1);
    expect(s.diagnostics.rejected[0]!.actionKind).toBe('update-care-plan');
    expect(s.diagnostics.rejected[0]!.cells).toContain(MBD_CLINICAL_ACTIONS_CELL);
    // `actionable` counts findings that named a real action BEFORE the allowlist
    // runs — the rejection is what removes it from the ranked set.
    expect(s.actionable).toBe(1);
  });

  it('published payload carries the diagnostics the operator needs to see', () => {
    const payload = clinicalActionsPayload(state([finding('pt-real-5', 'nope'), finding('pt-real-6', 'hold')]));
    expect(payload.nbas).toEqual([]);
    expect(payload.unmapped).toEqual(['nope']);
    expect(payload.suppressed).toBe(2);
    expect(payload.rejected).toEqual([]);
    expect(Array.isArray(payload.kinds)).toBe(true);
  });

  it('ranks deterministically and never returns a dollars value label', () => {
    const s = state([finding('pt-a', 'increase-binder'), finding('pt-b', 'safety-review'), finding('pt-c', 'dialysis-dose-review')]);
    const ids = s.nbas.map((n) => n.nbaId);
    expect(new Set(ids).size).toBe(ids.length); // identity-based ids, no collisions
    for (const nba of s.nbas) {
      expect(nba.valueUnit).not.toBe('dollars');
      expect(nba.valueLabel).not.toContain('$');
    }
  });
});
