// Transport-barrier sub-pack. Missed treatments frequently trace back to
// transportation gaps — the harness models transport as a first-class
// hyperedge so missed-treatment recovery workflows can act on the transport
// case, not just the patient case.

export type TransportMode = 'private-vehicle' | 'family-member' | 'ride-share' | 'paratransit' | 'ambulance' | 'facility-van' | 'medicaid-nemt';

export interface TransportArrangement {
  readonly patientId: string;
  readonly mode: TransportMode;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly providerRef?: string;
  readonly authorizedByPayerFlag: boolean;
  readonly copayAmount?: number;
}

export type TransportBarrier =
  | 'no-arrangement'
  | 'vehicle-mechanical'
  | 'driver-unavailable'
  | 'nemt-denial'
  | 'weather'
  | 'financial-hardship'
  | 'housing-instability'
  | 'no-show-recurring';

export interface TransportIncident {
  readonly incidentId: string;
  readonly patientId: string;
  readonly occurredAt: string;
  readonly barrier: TransportBarrier;
  readonly resultedInMissedTreatment: boolean;
  readonly rescheduleAttempted: boolean;
  readonly resolvedAt?: string;
  readonly resolution?: string;
}

/** Recurrence detector — 2+ transport-related misses in 30 days trips escalation. */
export function detectRecurrence(incidents: readonly TransportIncident[], windowDays = 30, threshold = 2): boolean {
  const now = Date.now();
  const windowMs = windowDays * 86400000;
  const recent = incidents.filter((i) => i.resultedInMissedTreatment && now - Date.parse(i.occurredAt) <= windowMs);
  return recent.length >= threshold;
}
