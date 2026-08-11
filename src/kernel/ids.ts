// Branded IDs give us cheap type safety across the kernel without runtime cost.
// Every ID literal follows `<prefix>:<opaque>` where the prefix is the entity kind.

export type Id<T extends string> = `${T}:${string}`;

export type OrganizationId = Id<'org'>;
export type PersonId = Id<'person'>;
export type ScopeId = Id<'scope'>;
export type HyperNodeId = `node:${string}`;
export type HyperedgeId = `edge:${string}`;
export type EventId = `event:${string}`;
export type CaseId = `case:${string}`;
export type WorkflowId = `wf:${string}`;
export type TraceId = `trace:${string}`;
export type AuditId = `audit:${string}`;

let counter = 0;
/**
 * Deterministic-ish local id generator. Callers can (and should) pass an
 * explicit id when reproducibility matters — this is only for tests and demos.
 */
export function mintId<Prefix extends string>(prefix: Prefix, seed?: string): Id<Prefix> {
  counter += 1;
  const suffix = seed ?? `${Date.now().toString(36)}-${counter.toString(36)}`;
  return `${prefix}:${suffix}` as Id<Prefix>;
}

/** Test-only: reset the counter so ids are stable across runs. */
export function __resetIdCounterForTests(): void {
  counter = 0;
}
