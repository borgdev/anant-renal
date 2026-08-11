// Scheduling sub-pack: chair/shift allocation with conflict detection and a
// "recovery plan" primitive that lets the missed-treatment workflow book a
// makeup slot without threading through global schedule state.

import type { DialysisChair, DialysisShift, DialysisTreatmentSession } from '../ontology.js';

export interface ScheduleConflict {
  reason: 'chair-double-booked' | 'chair-out-of-service' | 'shift-mismatch' | 'no-chair';
  sessionId: string;
  chairId?: string;
  shiftId?: string;
}

export function detectConflicts(
  sessions: readonly DialysisTreatmentSession[],
  chairs: readonly DialysisChair[],
  shifts: readonly DialysisShift[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const byChair = new Map<string, DialysisTreatmentSession[]>();
  const chairById = new Map(chairs.map((c) => [c.id, c] as const));
  const shiftById = new Map(shifts.map((s) => [s.id, s] as const));

  for (const s of sessions) {
    if (!s.chairId) {
      conflicts.push({ reason: 'no-chair', sessionId: s.id });
      continue;
    }
    const chair = chairById.get(s.chairId);
    if (chair && chair.status === 'out-of-service') {
      conflicts.push({ reason: 'chair-out-of-service', sessionId: s.id, chairId: s.chairId });
    }
    if (s.shiftId) {
      const shift = shiftById.get(s.shiftId);
      if (shift && !shift.chairIds.includes(s.chairId)) {
        conflicts.push({ reason: 'shift-mismatch', sessionId: s.id, chairId: s.chairId, shiftId: s.shiftId });
      }
    }
    const bucket = byChair.get(s.chairId) ?? [];
    bucket.push(s);
    byChair.set(s.chairId, bucket);
  }

  for (const [chairId, list] of byChair) {
    const scheduled = list.filter((s) => s.status !== 'cancelled' && s.status !== 'missed');
    if (scheduled.length <= 1) continue;
    scheduled.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    for (let i = 1; i < scheduled.length; i += 1) {
      const prev = scheduled[i - 1]!;
      const curr = scheduled[i]!;
      if (prev.scheduledAt === curr.scheduledAt) {
        conflicts.push({ reason: 'chair-double-booked', sessionId: curr.id, chairId });
      }
    }
  }
  return conflicts;
}

export interface RecoverySlotProposal {
  patientId: string;
  facilityId: string;
  proposedAt: string;
  chairId: string;
  shiftId: string;
  reason: string;
}

/**
 * Naive recovery-slot proposer: given a set of shifts and a "must be scheduled
 * before" deadline, pick the earliest shift with a free chair. Real deployments
 * plug in the facility's scheduling engine; this proves the interface.
 */
export function proposeRecoverySlot(input: {
  patientId: string;
  facilityId: string;
  mustScheduleBefore: string;
  shifts: readonly DialysisShift[];
  existingSessions: readonly DialysisTreatmentSession[];
  chairs: readonly DialysisChair[];
}): RecoverySlotProposal | null {
  const usableShifts = input.shifts
    .filter((s) => s.startsAtIso <= input.mustScheduleBefore)
    .sort((a, b) => a.startsAtIso.localeCompare(b.startsAtIso));
  for (const shift of usableShifts) {
    for (const chairId of shift.chairIds) {
      const chair = input.chairs.find((c) => c.id === chairId);
      if (!chair || chair.status === 'out-of-service') continue;
      const occupied = input.existingSessions.some(
        (s) => s.chairId === chairId && s.shiftId === shift.id && s.status !== 'cancelled' && s.status !== 'missed',
      );
      if (!occupied) {
        return {
          patientId: input.patientId,
          facilityId: input.facilityId,
          proposedAt: shift.startsAtIso,
          chairId,
          shiftId: shift.id,
          reason: 'earliest available chair before deadline',
        };
      }
    }
  }
  return null;
}
