export type DocumentAuthority = 'CMS' | 'CDC' | 'FDA' | 'payer' | 'provider-org' | 'facility' | 'professional-society';
export interface PolicyDocument { id: string; title: string; authority: DocumentAuthority; scopeId: string; sourceUri: string; contentHash: string; effectiveFrom?: string; effectiveTo?: string; classification: 'public' | 'internal' | 'confidential' | 'phi'; }
export interface RuleCandidate { id: string; documentId: string; excerpt: string; statement: string; authority: DocumentAuthority; status: 'proposed' | 'approved' | 'rejected' | 'superseded'; }
export interface SourceRecord { sourceId: string; batchId: string; observedAt: string; ingestedAt: string; lineage: string[]; classification: 'public' | 'internal' | 'confidential' | 'phi'; }
export interface DataQualityFinding { ruleId: string; severity: 'info' | 'warning' | 'error' | 'critical'; entityId?: string; message: string; evidence: Record<string, unknown>; }
export interface DataQualityRule { id: string; description: string; evaluate(input: unknown): DataQualityFinding[]; }
export interface QualityMeasure { id: string; authority: string; version: string; evaluate(dataset: unknown): { score?: number; numerator?: number; denominator?: number; evidenceIds: string[]; calculatedAt: string }; }
export interface QapiCase { id: string; facilityId: string; status: 'identified' | 'investigating' | 'intervening' | 'monitoring' | 'closed'; measureIds: string[]; evidenceIds: string[]; ownerId: string; }
export interface SimulationRun { id: string; packId: string; packVersion: string; sourceWindow: { from: string; to: string }; startedAt: string; completedAt?: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; metrics: Record<string, number>; }
