/******************************************************************************
 * Phase 3.2 — the next-session lens.
 *
 * The lens exists to answer one question at a chair: who is going to crash next
 * session, and what exactly do I change? Two properties carry it:
 *
 *   1. The counterfactual is shown ONLY when the prescription's UF rate actually
 *      changes. `fluidRecommend` fills `expectedIdhRiskByMinute` from
 *      `recommendedRate ?? ufRateMlH`, so for a hold / a sodium profile / an
 *      adherence block the "expected" series IS the current one. Rendering that as
 *      a counterfactual would be a number that looks like evidence of benefit and
 *      is really an absence of change.
 *   2. An unassessable window is not a low-risk window.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  NEXT_SESSION_HIGH_RISK,
  NEXT_SESSION_MEANINGFUL_DROP_PP,
  nextSessionDigest,
  nextSessionRisk,
  rankNextSession,
} from '../src/swarm/next-session.js';
import { fluidRecommend, type FluidPatientWindow } from '../src/swarm/fluid.js';

/** A hypotensive-prone window: previous-session IDH + a nadir under the floor. */
const hypotensive: FluidPatientWindow = {
  patientId: 'p-idh-1',
  sessionCount: 24,
  telemetryPoints: 12,
  ufRateMlH: 900,
  postWeightKg: 70,
  nadirSbp: 92,
  nadirSbpPrev: 88,
  idwgKg: 3.4,
  plannedMinutes: 240,
  deliveredMinutes: 240,
  ufVolumeL: 3.4,
  asOf: '2026-09-12T09:00:00.000Z',
  dryWeightAssessedAt: '2026-09-11T09:00:00.000Z',
};

/** A stable window: no IDH history, a comfortable nadir, volume within tolerance. */
const stable: FluidPatientWindow = {
  patientId: 'p-idh-2',
  sessionCount: 30,
  telemetryPoints: 18,
  ufRateMlH: 600,
  postWeightKg: 80,
  nadirSbp: 128,
  nadirSbpPrev: 124,
  idwgKg: 1.2,
  plannedMinutes: 240,
  deliveredMinutes: 240,
  ufVolumeL: 1.2,
  asOf: '2026-09-12T09:00:00.000Z',
  dryWeightAssessedAt: '2026-09-11T09:00:00.000Z',
};

describe('next a session, the lens — the counterfactual is real or absent', () => {
  it('a rate reduction carries what it does to the risk, at every clock', () => {
    const rec = fluidRecommend(hypotensive);
    expect(rec.action === 'reduce-uf-rate' || rec.action === 'extend-time-for-uf').toBe(true);
    const risk = nextSessionRisk(rec, { facilityId: 'f1', dryWeightSource: 'last-session-close' });

    expect(risk.change).not.toBeNull();
    expect(risk.change!.ufRateMlH).toBe(rec.recommended.ufRateMlH);
    expect(risk.counterfactual).not.toBeNull();
    // The modelled peak must be lower, and the drop must be the difference.
    expect(risk.counterfactual!.peakPct).toBeLessThan(risk.peakPct);
    expect(risk.counterfactual!.peakDropPp).toBeCloseTo(risk.peakPct - risk.counterfactual!.peakPct, 5);
    // Every clock carries both sides of the comparison, so a chart can be drawn
    // without the console doing arithmetic on the numbers.
    expect(risk.clocks.length).toBeGreaterThan(0);
    for (const clock of risk.clocks) {
      expect(typeof clock.beforePct).toBe('number');
      expect(typeof clock.afterPct).toBe('number');
      expect(clock.afterPct!).toBeLessThanOrEqual(clock.beforePct);
    }
    expect(risk.noCounterfactualReason).toBeUndefined();
    expect(risk.current.dryWeightSource).toBe('last-session-close');
  });

  it('a hold reports NO counterfactual, and says why', () => {
    const rec = fluidRecommend(stable);
    expect(rec.action).toBe('hold');
    const risk = nextSessionRisk(rec);
    // `fluidRecommend` still fills the expected series — with the SAME rate — so the
    // danger here is real: an unwary lens would show a drop of 0 as a modelled plan.
    expect(rec.recommended.expectedIdhRiskByMinute).toBeDefined();
    expect(risk.change).toBeNull();
    expect(risk.counterfactual).toBeNull();
    expect(risk.noCounterfactualReason).toMatch(/prescription stands/i);
    expect(risk.clocks.every((c) => c.afterPct === undefined)).toBe(true);
  });

  it('a profile/sodium proposal gets no rate counterfactual either', () => {
    // Below the safe ceiling with a comfortable nadir: the pack profiles rather
    // than changing the rate, so any benefit comes from a mechanism the lens cannot
    // put a number on.
    const rec = fluidRecommend({ ...stable, idwgKg: 3.2, nadirSbp: 130, ufRateMlH: 500, postWeightKg: 80, ufVolumeL: 3.2, deliveredMinutes: 240 });
    expect(rec.action).toBe('profile-temperature-sodium');
    const risk = nextSessionRisk(rec);
    expect(risk.change).toBeNull();
    expect(risk.counterfactual).toBeNull();
    expect(risk.noCounterfactualReason).toMatch(/does not change the UF rate/i);
  });

  it('a blocked window is reported as unassessable, not as low risk', () => {
    const rec = fluidRecommend({ ...hypotensive, telemetryPoints: 0 });
    expect(rec.guardrails.blocked).toBe(true);
    const risk = nextSessionRisk(rec);
    expect(risk.unassessable).toBe(true);
    expect(risk.flags).toContain('no-intra-session-telemetry');
    expect(risk.counterfactual).toBeNull();
    expect(risk.noCounterfactualReason).toMatch(/intra-session telemetry/i);
    // …and it must not double the guardrail's own punctuation.
    expect(risk.noCounterfactualReason).not.toMatch(/\.\./);
  });

  it('a blocked-for-data patient is never counted in a risk band', () => {
    const rows = [
      nextSessionRisk(fluidRecommend(hypotensive)),
      nextSessionRisk(fluidRecommend(stable)),
      nextSessionRisk(fluidRecommend({ ...hypotensive, telemetryPoints: 0 })),
    ];
    const digest = nextSessionDigest(rows);
    expect(digest.totals.screened).toBe(3);
    expect(digest.totals.unassessable).toBe(1);
    // high + watch + low covers only the patients that COULD be assessed.
    expect(digest.totals.high + digest.totals.watch + digest.totals.low).toBe(2);
    expect(digest.reading.some((r) => /unknown risk, not a low one/.test(r))).toBe(true);
  });
});

describe('next session — ranking is worst-risk-first, then most fixable', () => {
  it('orders by peak risk, breaking ties toward the larger modelled drop', () => {
    const worst = nextSessionRisk(fluidRecommend(hypotensive));
    const calm = nextSessionRisk(fluidRecommend(stable));
    const ranked = rankNextSession([calm, worst]);
    expect(ranked[0]!.patientId).toBe('p-idh-1');
  });

  it('the high band reflects the protocol threshold, not a magic string', () => {
    const risk = nextSessionRisk(fluidRecommend(hypotensive));
    expect(risk.band).toBe(risk.peakPct >= NEXT_SESSION_HIGH_RISK * 100 ? 'high' : risk.band);
  });

  it('a drop below the meaningful floor is not advertised as actionable', () => {
    const risk = nextSessionRisk(fluidRecommend(hypotensive));
    const digest = nextSessionDigest([risk]);
    if (risk.counterfactual && !risk.counterfactual.meaningful) {
      expect(digest.totals.actionable).toBe(0);
      expect(risk.counterfactual.peakDropPp).toBeLessThan(NEXT_SESSION_MEANINGFUL_DROP_PP);
    } else {
      expect(digest.totals.actionable).toBe(risk.band === 'low' ? 0 : 1);
    }
  });

  it('never reports a negative reduction', () => {
    for (const w of [hypotensive, stable]) {
      const risk = nextSessionRisk(fluidRecommend(w));
      if (risk.counterfactual) {
        expect(risk.counterfactual.riskReducedBy).toBeGreaterThanOrEqual(0);
        expect(risk.counterfactual.peakDropPp).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('an empty fleet says so rather than reporting calm', () => {
    const digest = nextSessionDigest([]);
    expect(digest.rows).toEqual([]);
    expect(digest.reading[0]).toMatch(/nothing to screen/i);
  });
});
