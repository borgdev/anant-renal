// CDA-lite adapter (C-CDA XML subset → canonical events).

import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';

export interface CDADocument {
  readonly title: string;
  readonly effectiveTime: string;
  readonly patientId: string;
  readonly sections: readonly CDASection[];
  readonly raw: string;
}

export interface CDASection {
  readonly code: string;
  readonly title: string;
  readonly text: string;
}

export interface CDAMappingOptions {
  facilityId: string;
  scopeId: string;
  sourceId: string;
  ingestedAt: string;
}

const sectionRe = /<section>[\s\S]*?<code\s+code="([^"]+)"[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<\/section>/g;
const patientIdRe = /<patient>[\s\S]*?<id\s+extension="([^"]+)"/;
const titleRe = /<title>([^<]+)<\/title>/;
const effectiveRe = /<effectiveTime\s+value="([^"]+)"/;

export function parseCDA(xml: string): CDADocument {
  const patientMatch = patientIdRe.exec(xml);
  const titleMatch = titleRe.exec(xml);
  const effMatch = effectiveRe.exec(xml);
  const sections: CDASection[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(xml)) !== null) {
    sections.push({ code: m[1] ?? '', title: m[2] ?? '', text: (m[3] ?? '').trim() });
  }
  return {
    title: titleMatch?.[1] ?? 'Unknown',
    effectiveTime: effMatch?.[1] ?? '',
    patientId: patientMatch?.[1] ?? 'unknown',
    sections,
    raw: xml,
  };
}

const sectionMap: Record<string, CanonicalEventType> = {
  '11450-4': 'condition.recorded',
  '10160-0': 'medication.ordered',
  '30954-2': 'lab.result-arrived',
  '47519-4': 'procedure.performed',
  '46240-8': 'encounter.summary',
};

export function cdaToEvents(doc: CDADocument, opts: CDAMappingOptions): CanonicalEvent[] {
  return doc.sections.flatMap<CanonicalEvent>((s) => {
    const type = sectionMap[s.code];
    if (!type) return [];
    return [{
      id: `event:cda:${doc.patientId}:${s.code}:${doc.effectiveTime}`,
      type,
      occurredAt: doc.effectiveTime || opts.ingestedAt,
      scopeId: opts.scopeId,
      subjectId: doc.patientId,
      facilityId: opts.facilityId,
      payload: { sectionCode: s.code, sectionTitle: s.title, narrative: s.text.slice(0, 512) },
      provenance: { sourceId: opts.sourceId, observedAt: doc.effectiveTime || opts.ingestedAt, ingestedAt: opts.ingestedAt },
      classification: 'phi',
    }];
  });
}
