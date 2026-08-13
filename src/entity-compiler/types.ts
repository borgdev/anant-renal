// Canonical entity + compile report types for the M19 entity-pack compiler.

export type EntityKind = 'data' | 'workflow' | 'concept';
export type Confidence = 'high' | 'medium' | 'low';

export interface FieldSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'unknown';
  required?: boolean;
  primaryKey?: boolean;
  phi?: boolean;
  description?: string;
}

export interface RelationshipSpec {
  fromField: string;
  toEntity: string;
  toField: string;
  cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  role?: string;
  requiresHitl?: boolean;
}

export interface EntityHints {
  phi?: boolean;
  purposeOfUse?: Array<'treatment' | 'operations' | 'compliance' | 'research'>;
  hitl?: boolean;
  facilityKind?: string;
}

export interface SourceRef {
  file: string;
  span?: string;   // e.g. "L14-L28" or "row 42" or "table encounter, col patient_id"
  contentHash?: string;
}

export interface CanonicalEntity {
  id: string;
  name: string;
  kind: EntityKind;
  description?: string;
  fields: FieldSpec[];
  relationships: RelationshipSpec[];
  workflow?: WorkflowStep[];
  hints: EntityHints;
  sourceRefs: SourceRef[];
  confidence: Confidence;
}

export type Archetype =
  | 'record-steward'      // data + PHI
  | 'catalog-manager'     // data + reference/no PHI
  | 'procedure-runner'    // workflow
  | 'assessor'            // concept with measurable
  | 'reference-only';     // concept without execution (rejected as agent)

export interface EmittedAgentPreview {
  entityId: string;
  archetype: Archetype;
  agentIds: string[];
  reasons: string[];
}

export interface RejectedEntity {
  entityId: string;
  reasons: string[];
}

export interface CompileReport {
  compiledAt: string;
  inputPath: string;
  packId: string;
  ownerOrg: string;
  entitiesLoaded: number;
  entitiesEmitted: number;
  entitiesRejected: number;
  agentsGenerated: number;
  perEntity: EmittedAgentPreview[];
  rejected: RejectedEntity[];
  warnings: string[];
}
