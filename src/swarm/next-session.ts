// The next-session lens — chair-side, not chart-side.
//
// A dietitian or a nephrologist doing a round needs a different question answered
// than the pack pages answer. The pack page asks "what does this patient's window
// say?" for one patient at a time. The lens asks, for the whole unit at once:
//
//     Who is going to crash NEXT session, and what exactly do I change?
//
// So it ranks by the risk of the *upcoming* treatment under the prescription on
// record, and — for every patient it flags — carries the specific change the pack
// proposes together with what that change does to the risk. That second series is
// the whole point: "reduce the UF rate" is advice, "reduce 900 → 700 mL/h and the
// 60-minute IDH risk falls 41% → 22%" is a decision a clinician can take at a chair.
//
// ON THE COUNTERFACTUAL. `fluidRecommend` computes the expected series from
// `recommendedRate ?? ufRateMlH`. For a hold, a temperature/sodium profile, an
// adherence-first block or a guardrail block the two rates are the SAME, so the
// "expected" series is just the current one. Presenting that as a counterfactual
// would be the worst kind of lie — a number that looks like evidence of benefit and
// is actually an absence of change. So the counterfactual is emitted only when the
// recommended rate actually differs, and its absence carries a reason.
import type { FluidAction, FluidRecommendation } from './fluid.js';

/** Peak IDH probability at or above this is worth a chair-side decision. */
export const NEXT_SESSION_HIGH_RISK = 0.35;
/** Below high but at or above this is worth a second look before the session. */
export const NEXT_SESSION_WATCH_RISK = 0.15;
/** A drop smaller than this is not a reason to change a prescription. */
export const NEXT_SESSION_MEANINGFUL_DROP_PP = 5;

export type NextSessionBand = 'high' | 'watch' | 'low';

/** The guardrail flags that mean the window was never assessable at all. */
export const NEXT_SESSION_DATA_FLAGS = [
  'no-intra-session-telemetry',
  'dry-weight-not-reassessed',
] as const;

export interface NextSessionClock {
  /** Minutes into the session. */
  minute: number;
  beforePct: number;
  /** Absent when there is no prescription change to model. */
  afterPct?: number;
}

export interface NextSessionChange {
  action: FluidAction;
  /** The pack's own words — never re-worded here. */
  label: string;
  ufRateMlH?: number;
  extraMinutes?: number;
  ufVolumeCapL?: number;
}

export interface NextSessionRisk {
  patientId: string;
  facilityId?: string;
  band: NextSessionBand;
  /** Peak IDH probability next session under the CURRENT prescription. */
  peakPct: number;
  peakMinute: number;
  clocks: NextSessionClock[];
  current: {
    ufRateMlH?: number;
    ufRatePerKg?: number;
    ufVolumeL?: number;
    deliveredMinutes?: number;
    idwgKg?: number;
    nadirSbp?: number;
    dryWeightSource: 'last-session-close' | 'unavailable' | 'unknown';
  };
  /** What the pack proposes, or null when the prescription stands. */
  change: NextSessionChange | null;
  /** What the change does to the risk, per clock. Null when there is no change. */
  counterfactual: {
    peakPct: number;
    peakMinute: number;
    peakDropPp: number;
    /** Share of the current peak risk removed, 0..1. */
    riskReducedBy: number;
    meaningful: boolean;
  } | null;
  /** Why there is no counterfactual, when there is none. */
  noCounterfactualReason?: string;
  /** The pack's own note for this patient. */
  note: string;  /** The guardrail flags this window carried, so the reader can see what stopped it. */
  flags: string[];
  /**
   * True when the window could not be assessed at all (no telemetry, or a target
   * weight nobody has re-checked). An unknown risk is NOT a low one.
   */
  unassessable: boolean;}

const pct = (v: number | undefined): number | undefined =>
  v === undefined ? undefined : Math.round(v * 1000) / 10;

const bandOf = (peak: number): NextSessionBand =>
  peak >= NEXT_SESSION_HIGH_RISK ? 'high' : peak >= NEXT_SESSION_WATCH_RISK ? 'watch' : 'low';

/** Peak and its clock across the protocol's own horizons (15/30/60 min by default). */
function peakOf(series: Record<number, number> | undefined): { peak: number; minute: number } {
  let peak = 0;
  let minute = 0;
  for (const [k, v] of Object.entries(series ?? {})) {
    if (typeof v !== 'number') continue;
    if (v > peak) {
      peak = v;
      minute = Number(k);
    }
  }
  return { peak, minute };
}

/**
 * The labels a clinician reads, in the pack's vocabulary. Kept here rather than
 * re-derived from the action string so the lens and the packet page agree.
 */
export const NEXT_SESSION_ACTION_LABEL: Record<FluidAction, string> = {
  'reduce-uf-rate': 'Reduce UF rate',
  'extend-time-for-uf': 'Reduce UF rate and extend the session',
  'review-dry-weight': 'Review target weight',
  'profile-temperature-sodium': 'Profile temperature and sodium',
  'adherence-first': 'Address between-session adherence first',
  hold: 'No prescription change',
  blocked: 'No recommendation — the window is blocked',
};

/**
 * Fold one patient's fluid recommendation into a next-session risk row.
 *
 * `dryWeightSource` is carried through because the risk is computed against a
 * target weight, and a lens that hides which weight it used invites a decision on
 * a stale number.
 */
export function nextSessionRisk(
  rec: FluidRecommendation,
  info: { facilityId?: string | undefined; dryWeightSource?: string | undefined } = {},
): NextSessionRisk {
  const before = peakOf(rec.current.idhRiskByMinute);
  const after = peakOf(rec.recommended.expectedIdhRiskByMinute);
  const recommendedRate = rec.recommended.ufRateMlH;
  const currentRate = rec.current.ufRateMlH;

  // The counterfactual exists only when the RATE actually changes. A hold, a
  // sodium profile, an adherence-first block or a guardrail block leave the rate
  // alone, and their "expected" series is the current one.
  const rateChanges = recommendedRate !== undefined && recommendedRate !== currentRate;
  const change: NextSessionChange | null = rateChanges
    ? {
      action: rec.action,
      label: NEXT_SESSION_ACTION_LABEL[rec.action],
      ufRateMlH: recommendedRate,
      ...(rec.recommended.extraMinutes !== undefined ? { extraMinutes: rec.recommended.extraMinutes } : {}),
      ...(rec.recommended.ufVolumeCapL !== undefined ? { ufVolumeCapL: rec.recommended.ufVolumeCapL } : {}),
    }
    : null;

  const clocks: NextSessionClock[] = Object.keys(rec.current.idhRiskByMinute ?? {})
    .map(Number)
    .sort((a, b) => a - b)
    .map((minute) => ({
      minute,
      beforePct: pct(rec.current.idhRiskByMinute?.[minute]) ?? 0,
      ...(rateChanges && rec.recommended.expectedIdhRiskByMinute?.[minute] !== undefined
        ? { afterPct: pct(rec.recommended.expectedIdhRiskByMinute[minute]) ?? 0 }
        : {}),
    }));

  const peakDropPp = rateChanges ? Math.round((before.peak - after.peak) * 1000) / 10 : 0;

  return {
    patientId: rec.patientId,
    ...(info.facilityId !== undefined ? { facilityId: info.facilityId } : {}),
    band: bandOf(before.peak),
    peakPct: pct(before.peak) ?? 0,
    peakMinute: before.minute,
    clocks,
    current: {
      ...(currentRate !== undefined ? { ufRateMlH: currentRate } : {}),
      ...(rec.current.ufRatePerKg !== undefined ? { ufRatePerKg: rec.current.ufRatePerKg } : {}),
      ...(rec.current.ufVolumeL !== undefined ? { ufVolumeL: rec.current.ufVolumeL } : {}),
      ...(rec.current.deliveredMinutes !== undefined ? { deliveredMinutes: rec.current.deliveredMinutes } : {}),
      ...(rec.current.idwgKg !== undefined ? { idwgKg: rec.current.idwgKg } : {}),
      ...(rec.current.nadirSbp !== undefined ? { nadirSbp: rec.current.nadirSbp } : {}),
      dryWeightSource: info.dryWeightSource === 'last-session-close' ? 'last-session-close'
        : info.dryWeightSource === 'unavailable' ? 'unavailable' : 'unknown',
    },
    change,
    counterfactual: rateChanges
      ? {
        peakPct: pct(after.peak) ?? 0,
        peakMinute: after.minute,
        peakDropPp,
        // Guard the divide: a zero peak has no share to reduce.
        riskReducedBy: before.peak > 0 ? Math.round((Math.max(0, before.peak - after.peak) / before.peak) * 1000) / 1000 : 0,
        meaningful: peakDropPp >= NEXT_SESSION_MEANINGFUL_DROP_PP,
      }
      : null,
    ...(rateChanges
      ? {}
      : {
        noCounterfactualReason:
          rec.action === 'hold'
            ? 'The prescription stands, so there is nothing to compare against — this is the risk the current plan already carries.'
            : rec.action === 'blocked'
              // The guardrail's own words, not a paraphrase — and no second period
              // if it already ends in one.
              ? `No change to model: ${(rec.guardrails.blockReason ?? 'the window is blocked by a guardrail').replace(/\.?$/, '.')}`
              : `The pack proposes "${NEXT_SESSION_ACTION_LABEL[rec.action]}" and does not change the UF rate, so there is no rate counterfactual to show. Any benefit comes through a mechanism this lens cannot put a number on.`,
      }),
    note: rec.note,
    flags: [...rec.guardrails.flags],
    unassessable: rec.guardrails.flags.some((f) => (NEXT_SESSION_DATA_FLAGS as readonly string[]).includes(f)),
  };
}

/**
 * Rank the unit: worst risk first, then the biggest change that would fix it.
 *
 * Ties on risk break toward the larger drop, because two patients at the same risk
 * are not equally workable — the one whose prescription can be changed is the one
 * to walk to first.
 */
export function rankNextSession(rows: readonly NextSessionRisk[]): NextSessionRisk[] {
  return [...rows].sort(
    (a, b) =>
      b.peakPct - a.peakPct
      || (b.counterfactual?.peakDropPp ?? 0) - (a.counterfactual?.peakDropPp ?? 0)
      || a.patientId.localeCompare(b.patientId),
  );
}

export interface NextSessionDigest {
  rows: NextSessionRisk[];
  totals: { screened: number; high: number; watch: number; low: number; actionable: number; unassessable: number };
  /** What the reader should take from this, in words. */
  reading: string[];
}

/**
 * Summarise the unit's next session.
 *
 * `unmeasured` is called out separately and never folded into `low`: a patient with
 * no telemetry has an UNKNOWN risk next session, which is a different fact from a
 * patient whose risk was measured and is low.
 */
export function nextSessionDigest(rows: readonly NextSessionRisk[], opts: { limit?: number } = {}): NextSessionDigest {
  const ranked = rankNextSession(rows);
  const unassessable = ranked.filter((r) => r.unassessable);
  // A patient whose window cannot be assessed is counted in `unassessable` and NOT
  // in a band: the risk was never measured, so calling it low would invent a fact.
  const assessed = ranked.filter((r) => !r.unassessable);
  const high = assessed.filter((r) => r.band === 'high');
  const watch = assessed.filter((r) => r.band === 'watch');
  const actionable = assessed.filter((r) => r.band !== 'low' && r.counterfactual?.meaningful === true);

  const reading: string[] = [];
  if (ranked.length === 0) {
    reading.push('No patient windows are available, so there is nothing to screen for the next session.');
  } else {
    reading.push(
      `${high.length} patient(s) carry a high IDH risk (≥${Math.round(NEXT_SESSION_HIGH_RISK * 100)}%) for the next session and ${watch.length} are on watch.`,
    );
    if (actionable.length > 0) {
      const biggest = actionable[0]!;
      reading.push(
        `A rate change is modelled for ${actionable.length} of them; the largest single reduction is ${biggest.patientId} (${biggest.counterfactual!.peakDropPp} points, ${biggest.peakPct}% → ${biggest.counterfactual!.peakPct}%).`,
      );
    }
    const noCf = assessed.filter((r) => r.band !== 'low' && r.counterfactual === null);
    if (noCf.length > 0) {
      reading.push(
        `${noCf.length} flagged patient(s) have no rate counterfactual — the pack's proposal does not change the UF rate, so the risk shown is what the current plan carries.`,
      );
    }
  }
  if (unassessable.length > 0) {
    reading.push(
      `${unassessable.length} patient(s) could not be assessed for the next session (${unassessable[0]!.flags.join(', ')}), which is an unknown risk, not a low one.`,
    );
  }

  return {
    rows: ranked.slice(0, opts.limit ?? ranked.length),
    totals: {
      screened: ranked.length,
      high: high.length,
      watch: watch.length,
      low: assessed.filter((r) => r.band === 'low').length,
      actionable: actionable.length,
      unassessable: unassessable.length,
    },
    reading,
  };
}
