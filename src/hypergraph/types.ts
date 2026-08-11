// Typed hypergraph substrate.
//
// A hypergraph here is a set of typed nodes and typed hyperedges. Each edge
// connects an unordered multiset of nodes via named roles (so an edge like
// `treatment-episode` can bind {patient, facility, nephrologist, chair}
// distinctly). Every entity is schema-checked at insert time.
//
// Design notes:
//   • Types are first-class. Every node has a `type` string that must be
//     registered in the schema. Same for edges. Unknown types are rejected.
//   • Node ids are opaque strings assigned by the caller (usually a URN).
//   • Roles inside an edge are named; the schema declares which node types
//     may occupy each role and whether the role is required.
//   • Attributes on nodes and edges are JSON values validated by a
//     lightweight per-attribute predicate registered in the schema.

export type Json =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: Json }
  | readonly Json[];

export type NodeId = string;
export type EdgeId = string;
export type NodeType = string;
export type EdgeType = string;

export interface HyperNode {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly attributes: Readonly<Record<string, Json>>;
}

export interface HyperEdge {
  readonly id: EdgeId;
  readonly type: EdgeType;
  /** Named roles → participating node ids. A role may bind multiple nodes. */
  readonly roles: Readonly<Record<string, readonly NodeId[]>>;
  readonly attributes: Readonly<Record<string, Json>>;
}

export interface AttributeSpec {
  readonly required?: boolean;
  readonly validate?: (value: Json) => boolean;
}

export interface NodeSchema {
  readonly type: NodeType;
  readonly attributes: Readonly<Record<string, AttributeSpec>>;
}

export interface EdgeRoleSpec {
  readonly required: boolean;
  readonly nodeTypes: readonly NodeType[];
  /** If true, the role may bind more than one node id. */
  readonly multi?: boolean;
}

export interface EdgeSchema {
  readonly type: EdgeType;
  readonly roles: Readonly<Record<string, EdgeRoleSpec>>;
  readonly attributes: Readonly<Record<string, AttributeSpec>>;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export class HypergraphSchema {
  private readonly nodes = new Map<NodeType, NodeSchema>();
  private readonly edges = new Map<EdgeType, EdgeSchema>();

  registerNode(schema: NodeSchema): void {
    if (this.nodes.has(schema.type)) throw new SchemaError(`node type already registered: ${schema.type}`);
    this.nodes.set(schema.type, schema);
  }
  registerEdge(schema: EdgeSchema): void {
    if (this.edges.has(schema.type)) throw new SchemaError(`edge type already registered: ${schema.type}`);
    this.edges.set(schema.type, schema);
  }
  nodeSchema(type: NodeType): NodeSchema | undefined { return this.nodes.get(type); }
  edgeSchema(type: EdgeType): EdgeSchema | undefined { return this.edges.get(type); }

  validateNode(node: HyperNode): void {
    const schema = this.nodes.get(node.type);
    if (!schema) throw new SchemaError(`unknown node type: ${node.type}`);
    for (const [name, spec] of Object.entries(schema.attributes)) {
      const value = node.attributes[name];
      if (value === undefined) {
        if (spec.required) throw new SchemaError(`node ${node.id} missing required attribute ${name}`);
        continue;
      }
      if (spec.validate && !spec.validate(value)) {
        throw new SchemaError(`node ${node.id} attribute ${name} failed validation`);
      }
    }
  }

  validateEdge(edge: HyperEdge, nodeType: (id: NodeId) => NodeType | undefined): void {
    const schema = this.edges.get(edge.type);
    if (!schema) throw new SchemaError(`unknown edge type: ${edge.type}`);
    // Reject roles the schema does not declare.
    for (const roleName of Object.keys(edge.roles)) {
      if (!(roleName in schema.roles)) {
        throw new SchemaError(`edge ${edge.id} declares unknown role ${roleName}`);
      }
    }
    for (const [roleName, spec] of Object.entries(schema.roles)) {
      const bound = edge.roles[roleName] ?? [];
      if (spec.required && bound.length === 0) {
        throw new SchemaError(`edge ${edge.id} missing required role ${roleName}`);
      }
      if (!spec.multi && bound.length > 1) {
        throw new SchemaError(`edge ${edge.id} role ${roleName} does not permit multiple bindings`);
      }
      for (const nid of bound) {
        const nt = nodeType(nid);
        if (nt === undefined) throw new SchemaError(`edge ${edge.id} role ${roleName} references unknown node ${nid}`);
        if (!spec.nodeTypes.includes(nt)) {
          throw new SchemaError(`edge ${edge.id} role ${roleName} rejects node type ${nt}`);
        }
      }
    }
    for (const [name, spec] of Object.entries(schema.attributes)) {
      const value = edge.attributes[name];
      if (value === undefined) {
        if (spec.required) throw new SchemaError(`edge ${edge.id} missing required attribute ${name}`);
        continue;
      }
      if (spec.validate && !spec.validate(value)) {
        throw new SchemaError(`edge ${edge.id} attribute ${name} failed validation`);
      }
    }
  }
}
