// Dialysis-specific cyclic temporality: MWF, TTS, and custom cadences with
// expected inter-treatment gaps. The harness relies on these to detect
// drifting / broken rhythm at replay time without special-casing dates in
// workflow code.

export interface DialysisTreatmentCycle {
  id: string;
  patientId: string;
  facilityId: string;
  cadence: 'MWF' | 'TTS' | 'custom';
  expectedIntervalsHours: readonly number[];
  timezone: string;
  phase: 'pre-treatment' | 'treatment-due' | 'post-treatment' | 'recovery';
}

const CADENCE_INTERVALS: Record<'MWF' | 'TTS', readonly number[]> = {
  MWF: [48, 48, 72], // Mon->Wed 48h, Wed->Fri 48h, Fri->Mon 72h
  TTS: [48, 48, 72], // Tue->Thu 48h, Thu->Sat 48h, Sat->Tue 72h
};

export function intervalsForCadence(cadence: 'MWF' | 'TTS' | 'custom', custom?: readonly number[]): readonly number[] {
  if (cadence === 'custom') return custom ?? [];
  return CADENCE_INTERVALS[cadence];
}

export function expectedGapHours(cycle: DialysisTreatmentCycle, treatmentIndex: number): number {
  const intervals = cycle.expectedIntervalsHours;
  if (intervals.length === 0) return 0;
  return intervals[treatmentIndex % intervals.length] ?? 0;
}

export function hasCycleBreak(expectedAt: Date, completedAt: Date | undefined, toleranceMinutes: number, now = new Date()): boolean {
  if (!completedAt) return now.getTime() > expectedAt.getTime() + toleranceMinutes * 60_000;
  return Math.abs(completedAt.getTime() - expectedAt.getTime()) > toleranceMinutes * 60_000;
}
