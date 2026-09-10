// Alert burden — what a pack costs the people who have to read it.
//
// Every protocol can be tuned until it never misses a case. The bill arrives as
// alert fatigue: a unit that sees 14 alerts per patient-week stops reading them,
// and the 15th — the real one — is dismissed with the rest. This module turns
// that into a measurement: alerts per patient-week, the actionable rate, the
// dismissal rate, duplication, and a false-positive rate over the subset of
// alerts that actually carries a validation label.
//
// Two honest limits:
//
//   * The false-positive rate is computed only over LABELLED alerts. A pack with
//     no labels reports `unlabelled`, not 0% — an unmeasured rate is not a good
//     one.
//   * A window with no alerts reports `not-measurable`, not `ok`. Silence can be
//     a silent-mode pack, a broken pack, or an easy month; none of those is a
//     clean bill of health.

import type { ProtocolId } from './rule-packs.js';
import { RULE_PROTOCOLS } from './rule-packs.js';

export interface AlertEvent {
  id: string;
  protocol: ProtocolId;
  patientId: string;
  /** ISO timestamp the alert was raised. */
  at: string;
  /** what the alert was about (e.g. 'esa-dose-escalation'). */
  kind: string;
  /** was there a concrete action a clinician could take? */
  actionable: boolean;
  /** the clinician acted on it. */
  accepted?: boolean;
  /** the clinician dismissed it. */
  dismissed?: boolean;
  /** set when a validation review confirmed this alert was wrong. */
  falsePositive?: boolean;
  /** set when this alert duplicates another alert id. */
  duplicateOf?: string;
  severity?: 'info' | 'warn' | 'critical';
}

/**
 * The cost model. These are review-time minutes, not currency: a facility can
 * price them locally. Both numbers are explicit so a reviewer can disagree with
 * them in one place.
 */
export const BURDEN_REFERENCE = {
  /** default measurement window */
  windowWeeks: 4,
  /** minutes to read and disposition one alert */
  minutesPerAlert: 4.5,
  /** additional minutes to carry out the action when the alert is actionable */
  minutesPerActionable: 12,
  /** alerts per patient-week above which the pack is generating noise */
  maxAlertsPerPatientWeek: 2,
  /** dismissal share above which clinicians are ignoring the pack */
  maxDismissalRate: 0.5,
  /** duplicate share above which the pack is repeating itself */
  maxDuplicateRate: 0.2,
  /** a repeat of the same kind for the same patient inside this window counts as duplicative */
  repeatWindowHours: 72,
  /** minimum labelled alerts before a false-positive rate is reported */
  minLabelledForFpRate: 10,
} as const;

export type BurdenVerdict = 'ok' | 'watch' | 'breach' | 'not-measurable';

export interface ProtocolBurden {
  protocol: ProtocolId;
  alerts: number;
  patients: number;
  alertsPerPatientWeek: number;
  actionableRate: number;
  acceptedRate: number;
  dismissedRate: number;
  /** explicit duplicates + same-kind repeats inside the repeat window */
  duplicateRate: number;
  /** over labelled alerts only; undefined when the labelled set is too small */
  falsePositiveRate?: number | undefined;
  labelled: number;
  minutes: number;
  /** share of the whole facility's alert minutes */
  minuteShare: number;
  verdict: BurdenVerdict;
  findings: string[];
}

export interface BurdenReport {
  window: { weeks: number; from?: string | undefined; to?: string | undefined };
  patients: number;
  totals: {
    alerts: number;
    actionable: number;
    dismissed: number;
    duplicates: number;
    labelled: number;
    minutes: number;
    alertsPerPatientWeek: number;
    actionableRate: number;
    dismissedRate: number;
    duplicateRate: number;
    falsePositiveRate?: number | undefined;
    costUnits: number;
  };
  byProtocol: ProtocolBurden[];
  /** patients generating the most alerts, with their share of the total */
  hotspots: Array<{ patientId: string; alerts: number; share: number }>;
  verdict: BurdenVerdict;
  findings: string[];
  reference: typeof BURDEN_REFERENCE;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function rate(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function ms(at: string): number {
  return new Date(at).getTime();
}

/** Same kind, same patient, same protocol, inside the repeat window. */
function repeatIds(alerts: readonly AlertEvent[]): Set<string> {
  const byKey = new Map<string, AlertEvent[]>();
  for (const a of alerts) {
    const key = `${a.protocol}|${a.patientId}|${a.kind}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(a);
    else byKey.set(key, [a]);
  }
  const repeats = new Set<string>();
  const windowMs = BURDEN_REFERENCE.repeatWindowHours * 3_600_000;
  for (const bucket of byKey.values()) {
    const sorted = [...bucket].sort((a, b) => ms(a.at) - ms(b.at));
    let previous: AlertEvent | undefined;
    for (const alert of sorted) {
      if (previous && ms(alert.at) - ms(previous.at) <= windowMs) repeats.add(alert.id);
      previous = alert;
    }
  }
  return repeats;
}

export function burdenCostMinutes(alerts: readonly AlertEvent[]): number {
  const actionable = alerts.filter((a) => a.actionable).length;
  return round4(alerts.length * BURDEN_REFERENCE.minutesPerAlert + actionable * BURDEN_REFERENCE.minutesPerActionable);
}

function verdictOf(args: {
  alerts: number;
  alertsPerPatientWeek: number;
  dismissedRate: number;
  duplicateRate: number;
}): BurdenVerdict {
  if (args.alerts === 0) return 'not-measurable';
  const ref = BURDEN_REFERENCE;
  if (
    args.alertsPerPatientWeek > ref.maxAlertsPerPatientWeek * 2 ||
    args.dismissedRate > ref.maxDismissalRate * 1.5
  ) return 'breach';
  if (
    args.alertsPerPatientWeek > ref.maxAlertsPerPatientWeek ||
    args.dismissedRate > ref.maxDismissalRate ||
    args.duplicateRate > ref.maxDuplicateRate
  ) return 'watch';
  return 'ok';
}

function protocolBurdenOf(
  protocol: ProtocolId,
  alerts: readonly AlertEvent[],
  patients: number,
  weeks: number,
  totalMinutes: number,
): ProtocolBurden {
  const repeats = repeatIds(alerts);
  const duplicates = alerts.filter((a) => a.duplicateOf !== undefined || repeats.has(a.id)).length;
  const dismissed = alerts.filter((a) => a.dismissed).length;
  const actionable = alerts.filter((a) => a.actionable).length;
  const accepted = alerts.filter((a) => a.accepted).length;
  const labelledAlerts = alerts.filter((a) => a.falsePositive !== undefined);
  const falsePositives = labelledAlerts.filter((a) => a.falsePositive).length;
  const perPatientWeek = patients === 0 ? 0 : round4(alerts.length / patients / weeks);
  const minutes = burdenCostMinutes(alerts);

  const entry: ProtocolBurden = {
    protocol,
    alerts: alerts.length,
    patients: new Set(alerts.map((a) => a.patientId)).size,
    alertsPerPatientWeek: perPatientWeek,
    actionableRate: round4(rate(actionable, alerts.length)),
    acceptedRate: round4(rate(accepted, alerts.length)),
    dismissedRate: round4(rate(dismissed, alerts.length)),
    duplicateRate: round4(rate(duplicates, alerts.length)),
    labelled: labelledAlerts.length,
    minutes,
    minuteShare: totalMinutes === 0 ? 0 : round4(minutes / totalMinutes),
    verdict: 'ok',
    findings: [],
  };
  if (labelledAlerts.length >= BURDEN_REFERENCE.minLabelledForFpRate) {
    entry.falsePositiveRate = round4(rate(falsePositives, labelledAlerts.length));
  }
  entry.verdict = verdictOf({
    alerts: alerts.length,
    alertsPerPatientWeek: perPatientWeek,
    dismissedRate: entry.dismissedRate,
    duplicateRate: entry.duplicateRate,
  });
  if (entry.verdict === 'not-measurable') {
    entry.findings.push('no alerts in the window — burden cannot be measured from silence');
  }
  if (perPatientWeek > BURDEN_REFERENCE.maxAlertsPerPatientWeek) {
    entry.findings.push(
      `${perPatientWeek} alerts per patient-week exceeds the ${BURDEN_REFERENCE.maxAlertsPerPatientWeek} ceiling`,
    );
  }
  if (entry.dismissedRate > BURDEN_REFERENCE.maxDismissalRate) {
    entry.findings.push(`${entry.dismissedRate} of alerts are dismissed — clinicians are not reading them`);
  }
  if (entry.duplicateRate > BURDEN_REFERENCE.maxDuplicateRate) {
    entry.findings.push(`${entry.duplicateRate} of alerts repeat a recent alert for the same patient and kind`);
  }
  if (entry.falsePositiveRate === undefined) {
    entry.findings.push(
      labelledAlerts.length === 0
        ? 'false-positive rate unresolved — no validation labels on any alert'
        : `false-positive rate unresolved — only ${labelledAlerts.length} labelled alerts (need ${BURDEN_REFERENCE.minLabelledForFpRate})`,
    );
  } else if (entry.falsePositiveRate > BURDEN_REFERENCE.maxDuplicateRate) {
    entry.findings.push(`${entry.falsePositiveRate} of labelled alerts were confirmed false positives`);
  }
  return entry;
}

export function burdenReport(
  alerts: readonly AlertEvent[],
  opts: { weeks?: number; patients: number; protocols?: readonly ProtocolId[] },
): BurdenReport {
  const weeks = opts.weeks ?? BURDEN_REFERENCE.windowWeeks;
  const protocols = opts.protocols ?? RULE_PROTOCOLS;
  const totalMinutes = burdenCostMinutes(alerts);
  const byProtocol = protocols.map((p) =>
    protocolBurdenOf(p, alerts.filter((a) => a.protocol === p), opts.patients, weeks, totalMinutes),
  );

  const repeats = repeatIds(alerts);
  const duplicates = alerts.filter((a) => a.duplicateOf !== undefined || repeats.has(a.id)).length;
  const actionable = alerts.filter((a) => a.actionable).length;
  const dismissed = alerts.filter((a) => a.dismissed).length;
  const labelledAlerts = alerts.filter((a) => a.falsePositive !== undefined);
  const perPatientWeek = opts.patients === 0 ? 0 : round4(alerts.length / opts.patients / weeks);

  const totals: BurdenReport['totals'] = {
    alerts: alerts.length,
    actionable,
    dismissed,
    duplicates,
    labelled: labelledAlerts.length,
    minutes: totalMinutes,
    alertsPerPatientWeek: perPatientWeek,
    actionableRate: round4(rate(actionable, alerts.length)),
    dismissedRate: round4(rate(dismissed, alerts.length)),
    duplicateRate: round4(rate(duplicates, alerts.length)),
    costUnits: round4(totalMinutes / 60),
  };
  if (labelledAlerts.length >= BURDEN_REFERENCE.minLabelledForFpRate) {
    totals.falsePositiveRate = round4(rate(labelledAlerts.filter((a) => a.falsePositive).length, labelledAlerts.length));
  }

  const sorted = [...alerts].sort((a, b) => ms(a.at) - ms(b.at));
  const window: BurdenReport['window'] = { weeks };
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first) window.from = first.at;
  if (last) window.to = last.at;

  const perPatient = new Map<string, number>();
  for (const a of alerts) perPatient.set(a.patientId, (perPatient.get(a.patientId) ?? 0) + 1);
  const hotspots = [...perPatient.entries()]
    .map(([patientId, count]) => ({ patientId, alerts: count, share: round4(rate(count, alerts.length)) }))
    .sort((a, b) => b.alerts - a.alerts || a.patientId.localeCompare(b.patientId))
    .slice(0, 5);

  const findings: string[] = [];
  for (const p of byProtocol) for (const f of p.findings) findings.push(`${p.protocol}: ${f}`);
  const top = hotspots[0];
  if (top && top.share > 0.25) {
    findings.push(`${top.patientId} accounts for ${top.share} of all alerts — check for a single-patient loop`);
  }

  return {
    window,
    patients: opts.patients,
    totals,
    byProtocol,
    hotspots,
    verdict: verdictOf({
      alerts: alerts.length,
      alertsPerPatientWeek: perPatientWeek,
      dismissedRate: totals.dismissedRate,
      duplicateRate: totals.duplicateRate,
    }),
    findings,
    reference: BURDEN_REFERENCE,
  };
}

/** Deterministic signature for drift tracking and tests. */
export function burdenSignature(report: BurdenReport): string {
  return [
    report.verdict,
    `n${report.totals.alerts}`,
    `ppw${report.totals.alertsPerPatientWeek}`,
    `dup${report.totals.duplicateRate}`,
    `min${report.totals.minutes}`,
    ...report.byProtocol.map((p) => `${p.protocol}:${p.alerts}/${p.verdict}`),
  ].join('|');
}
