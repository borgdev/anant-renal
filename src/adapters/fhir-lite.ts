// FHIR-lite adapter. It intentionally covers only the fields the harness cares
// about — patient identifier, encounter class, and observation payload — and
// maps them into canonical events. Real FHIR clients plug into the same
// interface (`mapFhirBundle`) without changing downstream code.

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface FhirResource {
  resourceType: string;
  id: string;
  [key: string]: unknown;
}

export interface FhirBundle {
  resourceType: 'Bundle';
  entry: readonly { resource: FhirResource }[];
  meta?: { source?: string; lastUpdated?: string };
}

export interface FhirMappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

export function mapFhirBundle(bundle: FhirBundle, opts: FhirMappingOptions): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  for (const entry of bundle.entry) {
    const r = entry.resource;
    if (r.resourceType === 'Encounter') {
      const status = (r['status'] as string | undefined) ?? 'unknown';
      const type = mapEncounterStatus(status);
      if (!type) continue;
      events.push({
        id: `event:fhir:${r.id}`,
        type,
        occurredAt: (r['period'] as { start?: string } | undefined)?.start ?? opts.ingestedAt,
        scopeId: opts.scopeId,
        subjectId: (r['subject'] as { reference?: string } | undefined)?.reference ?? 'unknown',
        facilityId: opts.facilityId,
        payload: { fhir: r },
        provenance: { sourceId: opts.sourceId, observedAt: (r['period'] as { start?: string } | undefined)?.start ?? opts.ingestedAt, ingestedAt: opts.ingestedAt },
        classification: 'phi',
      });
    }
    if (r.resourceType === 'Observation') {
      events.push({
        id: `event:fhir:${r.id}`,
        type: 'lab.result-arrived',
        occurredAt: (r['effectiveDateTime'] as string | undefined) ?? opts.ingestedAt,
        scopeId: opts.scopeId,
        subjectId: (r['subject'] as { reference?: string } | undefined)?.reference ?? 'unknown',
        facilityId: opts.facilityId,
        payload: { fhir: r },
        provenance: { sourceId: opts.sourceId, observedAt: (r['effectiveDateTime'] as string | undefined) ?? opts.ingestedAt, ingestedAt: opts.ingestedAt },
        classification: 'phi',
      });
    }
  }
  return events;
}

function mapEncounterStatus(status: string): CanonicalEventType | null {
  switch (status) {
    case 'finished':
      return 'treatment.completed';
    case 'cancelled':
      return 'treatment.cancelled';
    case 'in-progress':
    case 'planned':
      return 'treatment.scheduled';
    default:
      return null;
  }
}
