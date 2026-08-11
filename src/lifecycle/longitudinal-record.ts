// LongitudinalRecord — the patient timeline backing every setting.
//
// Every fact about a patient (dx, med, lab, encounter, assessment, transition,
// consent, transplant event, hospice election) is a timestamped node bound to
// coding-system triples and to an actor + purpose-of-use. Facts are immutable;
// updates append new nodes. Retrieval supports time-slicing ("record as of
// 2026-05-01"), setting filtering ("only dialysis-facility entries"), and
// evidence citation (each fact links to a source event or artifact).

import type { CodingSystemId } from '../ontology/systems.js';

export type LongitudinalNodeKind =
  | 'problem'
  | 'medication'
  | 'allergy'
  | 'immunization'
  | 'observation'
  | 'assessment-result'
  | 'encounter'
  | 'procedure'
  | 'lab-result'
  | 'imaging-study'
  | 'care-plan'
  | 'goal'
  | 'consent'
  | 'advance-directive'
  | 'referral'
  | 'transition'
  | 'transplant-event'
  | 'hospice-event'
  | 'social-driver'
  | 'device'
  | 'family-history'
  | 'note';

export interface LongitudinalNode {
  readonly nodeId: string;
  readonly patientId: string;
  readonly kind: LongitudinalNodeKind;
  readonly recordedAt: string;             // ISO
  readonly effectiveFrom: string;          // when this fact became true
  readonly effectiveTo?: string;
  readonly setting: 'primary-care' | 'urgent-care' | 'specialty' | 'ed' | 'inpatient' | 'dialysis' | 'home-health' | 'hospice' | 'ltc' | 'pharmacy' | 'transplant-center' | 'external' | 'patient-reported';
  readonly coding: readonly { readonly system: CodingSystemId; readonly code: string; readonly display?: string }[];
  readonly value?: string | number | boolean | Readonly<Record<string, unknown>>;
  readonly unit?: string;                  // UCUM
  readonly authorRef: string;              // clinician / device / agent
  readonly encounterRef?: string;
  readonly evidenceRef?: string;           // source event or artifact URI
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly supersededBy?: string;
}

export interface LongitudinalQuery {
  readonly patientId: string;
  readonly kinds?: readonly LongitudinalNodeKind[];
  readonly settings?: readonly LongitudinalNode['setting'][];
  readonly since?: string;
  readonly until?: string;
  readonly asOf?: string;                  // time-slice
  readonly codings?: readonly { readonly system: CodingSystemId; readonly code: string }[];
}

export class LongitudinalRecord {
  private readonly byPatient = new Map<string, LongitudinalNode[]>();

  append(node: LongitudinalNode): void {
    const arr = this.byPatient.get(node.patientId) ?? [];
    arr.push(node);
    this.byPatient.set(node.patientId, arr);
  }
  appendMany(nodes: readonly LongitudinalNode[]): void { for (const n of nodes) this.append(n); }

  query(q: LongitudinalQuery): readonly LongitudinalNode[] {
    const rows = this.byPatient.get(q.patientId) ?? [];
    return rows.filter((n) => {
      if (q.asOf) {
        if (n.effectiveFrom > q.asOf) return false;
        if (n.effectiveTo && n.effectiveTo <= q.asOf) return false;
      }
      if (q.since && n.effectiveFrom < q.since) return false;
      if (q.until && n.effectiveFrom > q.until) return false;
      if (q.kinds && !q.kinds.includes(n.kind)) return false;
      if (q.settings && !q.settings.includes(n.setting)) return false;
      if (q.codings && q.codings.length > 0) {
        const has = n.coding.some((c) => q.codings!.some((qc) => qc.system === c.system && qc.code === c.code));
        if (!has) return false;
      }
      return true;
    });
  }

  supersede(patientId: string, oldId: string, newNode: LongitudinalNode): void {
    const arr = this.byPatient.get(patientId);
    if (!arr) return;
    const idx = arr.findIndex((n) => n.nodeId === oldId);
    if (idx >= 0) {
      const old = arr[idx]!;
      arr[idx] = { ...old, supersededBy: newNode.nodeId, effectiveTo: newNode.effectiveFrom };
    }
    this.append(newNode);
  }

  timeline(patientId: string): readonly LongitudinalNode[] {
    const arr = this.byPatient.get(patientId) ?? [];
    return [...arr].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }

  currentProblemList(patientId: string, asOf?: string): readonly LongitudinalNode[] {
    return this.query({ patientId, kinds: ['problem'], ...(asOf ? { asOf } : {}) }).filter((n) => !n.effectiveTo);
  }
  currentMedicationList(patientId: string, asOf?: string): readonly LongitudinalNode[] {
    return this.query({ patientId, kinds: ['medication'], ...(asOf ? { asOf } : {}) }).filter((n) => !n.effectiveTo);
  }
  currentAllergyList(patientId: string): readonly LongitudinalNode[] {
    return this.query({ patientId, kinds: ['allergy'] }).filter((n) => !n.effectiveTo);
  }
}
