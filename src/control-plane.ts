import type { Id, ScopeKind } from './kernel.js';

export type AccessAction = 'read' | 'write' | 'export' | 'execute' | 'publish' | 'approve' | 'admin';
export type AccessDecision = 'allow' | 'deny' | 'step-up-required';

export interface AccessSubject { id: Id<'person'> | Id<'org'>; roles: string[]; attributes: Record<string, unknown>; }
export interface AccessResource { id: string; type: string; scopeKind: ScopeKind; classification: 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi'; attributes: Record<string, unknown>; }
export interface AccessRequest { subject: AccessSubject; resource: AccessResource; action: AccessAction; environment: { purposeOfUse: string; managedDevice: boolean; sessionAgeMinutes: number; emergency?: boolean; now: string }; }
export interface AbacRule { id: string; effect: AccessDecision; reason: string; matches(request: AccessRequest): boolean; }
export interface RoleGrant { role: string; actions: AccessAction[]; resourceTypes: string[]; }

export class AccessEvaluator {
  constructor(private readonly grants: RoleGrant[], private readonly rules: AbacRule[]) {}
  evaluate(request: AccessRequest): { decision: AccessDecision; reasons: string[] } {
    if (request.resource.classification.includes('phi') && !request.environment.managedDevice) return { decision: 'deny', reasons: ['PHI requires a managed device'] };
    const granted = request.subject.roles.some((role) => this.grants.some((grant) => grant.role === role && grant.actions.includes(request.action) && grant.resourceTypes.includes(request.resource.type)));
    if (!granted) return { decision: 'deny', reasons: ['No RBAC grant'] };
    const rules = this.rules.filter((rule) => rule.matches(request));
    const denial = rules.find((rule) => rule.effect === 'deny');
    if (denial) return { decision: 'deny', reasons: [denial.reason] };
    const stepUp = rules.find((rule) => rule.effect === 'step-up-required');
    return stepUp ? { decision: 'step-up-required', reasons: [stepUp.reason] } : { decision: 'allow', reasons: rules.map((rule) => rule.reason) };
  }
}

export interface AuditEvent { id: string; occurredAt: string; actorId: string; scopeId: string; action: string; traceId: string; resourceId?: string; decision?: AccessDecision; policyVersion?: string; payload: Record<string, unknown>; }
export class AuditLedger { private readonly events: AuditEvent[] = []; append(event: AuditEvent): void { this.events.push(Object.freeze(structuredClone(event))); } all(): readonly AuditEvent[] { return this.events; } }

export interface ToolCall { name: string; input: Record<string, unknown>; }
export interface HarnessTurn { scopeId: string; actorId: string; input: string; context: Record<string, unknown>; }
export interface AgentHarness { id: string; plan(turn: HarnessTurn): Promise<{ output: string; toolCalls: ToolCall[]; traceId: string }>; executeTool(call: ToolCall, turn: HarnessTurn): Promise<{ ok: boolean; output: unknown }>; }

export type WorkflowState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'quarantined' | 'compensated';
export interface WorkflowInstance { id: string; definitionId: string; idempotencyKey: string; state: WorkflowState; attempts: number; maxAttempts: number; traceId: string; exception?: { code: string; retryable: boolean; message: string; evidence: Record<string, unknown> }; }
export interface MetricPoint { name: string; value: number; at: string; labels: Record<string, string>; }
export interface TraceSpan { traceId: string; spanId: string; name: string; startedAt: string; endedAt?: string; status: 'ok' | 'error'; attributes: Record<string, unknown>; }

export interface DomainPack { id: string; version: string; extends: Array<{ id: string; versionRange: string }>; appliesTo: { organizationKinds: string[]; facilityKinds?: string[] }; capabilities: string[]; cmsUniverse: Array<{ id: string; title: string; authority: 'CMS' | 'CDC' | 'FDA' | 'local-policy'; effectiveFrom?: string }>; requiredControls: Array<'access-policy' | 'audit-provenance' | 'data-quality' | 'simulation-suite' | 'observability-dashboard'>; }
export class PackRegistry { private readonly packs = new Map<string, DomainPack>(); register(pack: DomainPack): void { if (this.packs.has(pack.id)) throw new Error(`Pack ${pack.id} already registered`); this.packs.set(pack.id, structuredClone(pack)); } resolve(id: string): DomainPack { const pack = this.packs.get(id); if (!pack) throw new Error(`Unknown pack ${id}`); for (const dependency of pack.extends) if (!this.packs.has(dependency.id)) throw new Error(`Unresolved dependency ${dependency.id}`); return pack; } }
