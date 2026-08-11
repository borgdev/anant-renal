// Reducer that turns canonical events into a running dialysis operational
// state. The replay engine calls this at each step; the outputs feed the
// missed-treatment queue and the QAPI board.

import type { CanonicalEvent } from '../../src/healthcare-core/events.js';
import type { WorkflowReducer } from '../../src/healthcare-core/replay.js';
import type { DialysisTreatmentSession } from './ontology.js';
import { createMissedTreatmentCase, advance, type MissedTreatmentCase } from './missed-treatment/state-machine.js';

export interface DialysisOperationalState {
  treatments: Record<string, DialysisTreatmentSession>;
  hospitalizedPatientIds: Set<string>;
  transportIssuePatientIds: Set<string>;
  cases: Record<string, MissedTreatmentCase>;
}

export const dialysisReplayReducer: WorkflowReducer<DialysisOperationalState> = {
  initial(): DialysisOperationalState {
    return { treatments: {}, hospitalizedPatientIds: new Set(), transportIssuePatientIds: new Set(), cases: {} };
  },

  reduce(state, event: CanonicalEvent) {
    const nextTreatments = { ...state.treatments };
    const nextCases = { ...state.cases };
    const nextHospitalized = new Set(state.hospitalizedPatientIds);
    const nextTransport = new Set(state.transportIssuePatientIds);
    const emitted: unknown[] = [];

    switch (event.type) {
      case 'treatment.scheduled': {
        const t = event.payload as unknown as DialysisTreatmentSession;
        nextTreatments[t.id] = t;
        break;
      }
      case 'treatment.completed': {
        const t = event.payload as unknown as DialysisTreatmentSession;
        nextTreatments[t.id] = t;
        break;
      }
      case 'treatment.missed': {
        const t = event.payload as unknown as DialysisTreatmentSession;
        nextTreatments[t.id] = t;
        const signal = {
          treatment: t,
          hospitalizationConfirmed: nextHospitalized.has(t.patientId),
          transportIssue: nextTransport.has(t.patientId),
          unresolvedContact: false,
          now: event.occurredAt,
        };
        const c = createMissedTreatmentCase(signal);
        if (c) {
          nextCases[c.id] = c;
          emitted.push({ kind: 'missed-treatment-case:opened', case: c });
        }
        break;
      }
      case 'hospitalization.admitted': {
        nextHospitalized.add(event.subjectId);
        break;
      }
      case 'hospitalization.discharged': {
        nextHospitalized.delete(event.subjectId);
        break;
      }
      case 'transport.issue': {
        nextTransport.add(event.subjectId);
        break;
      }
      case 'contact.failed': {
        // Advance any open case for this patient toward outreach.
        for (const [id, c] of Object.entries(state.cases)) {
          if (c.patientId !== event.subjectId) continue;
          if (c.status === 'verifying') {
            nextCases[id] = advance(c, 'outreach', event.occurredAt);
            emitted.push({ kind: 'missed-treatment-case:advanced', from: 'verifying', to: 'outreach', caseId: id });
          }
        }
        break;
      }
      default:
        break;
    }

    return {
      state: { treatments: nextTreatments, hospitalizedPatientIds: nextHospitalized, transportIssuePatientIds: nextTransport, cases: nextCases },
      emitted,
    };
  },
};
