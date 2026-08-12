// M12 — Intent → Plan → Choice → Effect
//
// Two-tier planner:
//   Tier 1: deterministic TEMPLATE planner covering common intent shapes.
//   Tier 2: pluggable LLM planner interface for open-ended intents.
// Templates match on intentKind + subject shape; if none match and an LLM
// adapter is configured, the LLM produces a PlanGraph.

import type { EntityGraph } from './entity-graph.js';
import type { WorldEffect } from './types.js';

export interface Intent {
  intentId: string;
  intentKind: string; // e.g. 'discharge-patient-safely', 'resolve-safety-event', 'process-claim', 'fix-station'
  subjectRef?: string | undefined; // opaque reference, typically an entity id
  description: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  submittedAt: string;
  submittedBy: string;
}

export interface PlanStep {
  id: string;
  label: string;
  ownerRole: string; // role responsible for executing this step
  effectHint?: { kind: WorldEffect['kind']; params?: Record<string, unknown> };
  dependsOn?: string[]; // ids of prior steps that must complete first
  status: 'pending' | 'started' | 'completed' | 'blocked' | 'aborted';
}

export interface PlanGraph {
  planId: string;
  intentId: string;
  producedBy: 'template' | 'llm';
  templateId?: string;
  steps: PlanStep[];
  createdAt: string;
}

// A template — deterministic; runs synchronously against the graph + intent.
export interface PlanTemplate {
  id: string;
  matches(intent: Intent, g: EntityGraph): boolean;
  build(intent: Intent, g: EntityGraph): PlanStep[];
}

/** Simple LLM planner adapter (pluggable). Contract: given intent + world summary, return steps. */
export interface LLMPlannerAdapter {
  id: string;
  plan(intent: Intent, worldSummary: string): Promise<PlanStep[]>;
}

export class Planner {
  private templates: PlanTemplate[] = [];
  private llm?: LLMPlannerAdapter | undefined;

  constructor(templates: PlanTemplate[] = DEFAULT_TEMPLATES, llm?: LLMPlannerAdapter) {
    this.templates = templates;
    if (llm) this.llm = llm;
  }

  register(template: PlanTemplate): void { this.templates.push(template); }
  setLLM(a: LLMPlannerAdapter | undefined): void { this.llm = a; }

  /** Try tier-1 templates first; return undefined if no template matches. */
  planTemplate(intent: Intent, g: EntityGraph): PlanGraph | undefined {
    for (const t of this.templates) {
      if (t.matches(intent, g)) {
        return {
          planId: `plan-${intent.intentId}`,
          intentId: intent.intentId,
          producedBy: 'template',
          templateId: t.id,
          steps: t.build(intent, g),
          createdAt: new Date().toISOString(),
        };
      }
    }
    return undefined;
  }

  /** Full plan: template if available, else LLM if configured, else throw. */
  async plan(intent: Intent, g: EntityGraph, worldSummary?: string): Promise<PlanGraph> {
    const tpl = this.planTemplate(intent, g);
    if (tpl) return tpl;
    if (!this.llm) throw new Error(`planner-no-match: no template for intentKind '${intent.intentKind}' and no LLM adapter configured`);
    const steps = await this.llm.plan(intent, worldSummary ?? '');
    return {
      planId: `plan-${intent.intentId}`,
      intentId: intent.intentId,
      producedBy: 'llm',
      steps,
      createdAt: new Date().toISOString(),
    };
  }
}

// ---- Default templates (deterministic, testable) ----

const DISCHARGE_PATIENT_SAFELY: PlanTemplate = {
  id: 'template.discharge-patient-safely',
  matches: (i) => i.intentKind === 'discharge-patient-safely' && !!i.subjectRef,
  build: (i) => [
    { id: 's1', label: 'Review latest vitals + labs', ownerRole: 'md', status: 'pending' },
    { id: 's2', label: 'Update care plan', ownerRole: 'md', effectHint: { kind: 'update-care-plan', params: { patientId: i.subjectRef } }, dependsOn: ['s1'], status: 'pending' },
    { id: 's3', label: 'Schedule followup', ownerRole: 'md', effectHint: { kind: 'schedule-followup', params: { patientId: i.subjectRef, followupKind: 'nephro-clinic' } }, dependsOn: ['s2'], status: 'pending' },
    { id: 's4', label: 'Discharge patient', ownerRole: 'md', effectHint: { kind: 'discharge-patient', params: { patientId: i.subjectRef, disposition: 'home' } }, dependsOn: ['s3'], status: 'pending' },
  ],
};

const RESOLVE_SAFETY_EVENT: PlanTemplate = {
  id: 'template.resolve-safety-event',
  matches: (i) => i.intentKind === 'resolve-safety-event',
  build: (i) => [
    { id: 's1', label: 'Assess patient', ownerRole: 'nurse', effectHint: { kind: 'record-vitals', params: { patientId: i.subjectRef } }, status: 'pending' },
    { id: 's2', label: 'Notify MD', ownerRole: 'nurse', effectHint: { kind: 'notify-staff', params: { targetRole: 'md', priority: 'high' } }, dependsOn: ['s1'], status: 'pending' },
    { id: 's3', label: 'Physician review + orders', ownerRole: 'md', dependsOn: ['s2'], status: 'pending' },
    { id: 's4', label: 'Document + close', ownerRole: 'nurse', effectHint: { kind: 'record-assessment', params: { patientId: i.subjectRef, assessmentId: 'safety-event-close' } }, dependsOn: ['s3'], status: 'pending' },
  ],
};

const PROCESS_CLAIM: PlanTemplate = {
  id: 'template.process-claim',
  matches: (i) => i.intentKind === 'process-claim' && !!i.subjectRef,
  build: (i) => [
    { id: 's1', label: 'Code encounter', ownerRole: 'coder', status: 'pending' },
    { id: 's2', label: 'Submit claim', ownerRole: 'ops', effectHint: { kind: 'submit-claim', params: { encounterId: i.subjectRef } }, dependsOn: ['s1'], status: 'pending' },
    { id: 's3', label: 'Schedule payer follow-up', ownerRole: 'ops', effectHint: { kind: 'schedule-followup', params: { followupKind: 'payer-followup' } }, dependsOn: ['s2'], status: 'pending' },
  ],
};

const FIX_STATION: PlanTemplate = {
  id: 'template.fix-station',
  matches: (i) => i.intentKind === 'fix-station' && !!i.subjectRef,
  build: (i) => [
    { id: 's1', label: 'Mark station down', ownerRole: 'tech', effectHint: { kind: 'mark-object-state', params: { objectId: i.subjectRef, newState: 'down' } }, status: 'pending' },
    { id: 's2', label: 'Open helpdesk ticket', ownerRole: 'tech', effectHint: { kind: 'open-ticket', params: { ticketKind: 'facilities', subjectRef: i.subjectRef, assigneeRole: 'facilities-tech', priority: 'high', summary: 'Station requires service' } }, dependsOn: ['s1'], status: 'pending' },
    { id: 's3', label: 'Perform service', ownerRole: 'tech', status: 'pending' },
    { id: 's4', label: 'Mark station idle', ownerRole: 'tech', effectHint: { kind: 'mark-object-state', params: { objectId: i.subjectRef, newState: 'idle' } }, dependsOn: ['s3'], status: 'pending' },
  ],
};

export const DEFAULT_TEMPLATES: PlanTemplate[] = [
  DISCHARGE_PATIENT_SAFELY,
  RESOLVE_SAFETY_EVENT,
  PROCESS_CLAIM,
  FIX_STATION,
];
