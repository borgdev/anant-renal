import type { OrganizationId, PersonId, ScopeId } from './ids.js';

// The organization/person/scope trio is the essence of the harness identity model.
// Every hypergraph node, every workflow, every access check ultimately anchors
// to a scope inside some organization. We keep it intentionally small.

export type OrganizationKind = 'provider' | 'payer' | 'health-system' | 'practice';

export type ScopeKind =
  | 'organization'
  | 'region'
  | 'facility'
  | 'team'
  | 'room'
  | 'project'
  | 'person'
  | 'service';

export interface Organization {
  id: OrganizationId;
  kind: OrganizationKind;
  name: string;
  parentId?: OrganizationId;
  attributes: Readonly<Record<string, unknown>>;
}

export interface Person {
  id: PersonId;
  organizationId: OrganizationId;
  displayName: string;
  roles: readonly string[];
  attributes: Readonly<Record<string, unknown>>;
}

export interface Scope {
  id: ScopeId;
  kind: ScopeKind;
  organizationId: OrganizationId;
  parentScopeId?: ScopeId;
  memberIds: readonly PersonId[];
  attributes: Readonly<Record<string, unknown>>;
}

/**
 * A small in-memory directory over organizations, persons, and scopes. It is
 * intentionally deterministic — no hidden clocks, no I/O. Persistence is a
 * concern for adapters, not the kernel.
 */
export class OrganizationDirectory {
  private readonly organizations = new Map<OrganizationId, Organization>();
  private readonly persons = new Map<PersonId, Person>();
  private readonly scopes = new Map<ScopeId, Scope>();

  registerOrganization(org: Organization): void {
    if (this.organizations.has(org.id)) throw new Error(`Organization already registered: ${org.id}`);
    if (org.parentId && !this.organizations.has(org.parentId)) {
      throw new Error(`Unknown parent organization: ${org.parentId}`);
    }
    this.organizations.set(org.id, Object.freeze({ ...org, attributes: Object.freeze({ ...org.attributes }) }));
  }

  registerPerson(person: Person): void {
    if (!this.organizations.has(person.organizationId)) {
      throw new Error(`Unknown organization: ${person.organizationId}`);
    }
    this.persons.set(person.id, Object.freeze({
      ...person,
      roles: Object.freeze([...person.roles]) as readonly string[],
      attributes: Object.freeze({ ...person.attributes }),
    }));
  }

  registerScope(scope: Scope): void {
    if (!this.organizations.has(scope.organizationId)) {
      throw new Error(`Unknown organization: ${scope.organizationId}`);
    }
    if (scope.parentScopeId && !this.scopes.has(scope.parentScopeId)) {
      throw new Error(`Unknown parent scope: ${scope.parentScopeId}`);
    }
    for (const memberId of scope.memberIds) {
      if (!this.persons.has(memberId)) throw new Error(`Unknown scope member: ${memberId}`);
    }
    this.scopes.set(scope.id, Object.freeze({
      ...scope,
      memberIds: Object.freeze([...scope.memberIds]) as readonly PersonId[],
      attributes: Object.freeze({ ...scope.attributes }),
    }));
  }

  organization(id: OrganizationId): Organization {
    const org = this.organizations.get(id);
    if (!org) throw new Error(`Unknown organization: ${id}`);
    return org;
  }

  person(id: PersonId): Person {
    const p = this.persons.get(id);
    if (!p) throw new Error(`Unknown person: ${id}`);
    return p;
  }

  scope(id: ScopeId): Scope {
    const s = this.scopes.get(id);
    if (!s) throw new Error(`Unknown scope: ${id}`);
    return s;
  }

  /** Walks the scope hierarchy from `id` up to its root. */
  scopeAncestry(id: ScopeId): Scope[] {
    const chain: Scope[] = [];
    let cursor: Scope | undefined = this.scopes.get(id);
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parentScopeId ? this.scopes.get(cursor.parentScopeId) : undefined;
    }
    return chain;
  }

  hasScopeAncestor(id: ScopeId, ancestor: ScopeId): boolean {
    return this.scopeAncestry(id).some((s) => s.id === ancestor);
  }
}
