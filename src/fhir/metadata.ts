/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// Our own CapabilityStatement (F0.4).
//
// A vendor cannot register us as anything — a Bulk Data source, a CDS service, a
// SMART app — without being able to read what we are. Before this we published
// nothing, so `GET /fhir/metadata` 404'd.
//
// THE IMPORTANT PROPERTY HERE IS HONESTY. Our FHIR surface is not a per-resource
// REST API: reads are REALM-SCOPED (`/api/v1/fhir/{realmId}/{kind}/{id}`),
// ingestion is a bundle POST, and export is per-realm. A CapabilityStatement that
// claimed `Patient: read, search, create` at the root would be a lie that a
// vendor's conformance check would catch — and a lie we would then have to
// maintain.
//
// So this declares exactly what exists: `read` for the resource types we can
// actually serialise, at the realm-scoped path spelled out in `documentation`,
// and nothing else. As real per-resource routes arrive (F5/F6/F9/F10) they are
// added here in the same commit that adds the route.

import type { CapabilityStatement, CapabilityStatementResource } from './capability.js';
import { RESOURCE_TO_KIND } from './mapping.js';

/** FHIR R4 (4.0.1) is the version this bridge speaks. */
export const FHIR_VERSION = '4.0.1';

export interface CapabilityStatementOptions {
  /** Absolute base URL of our FHIR surface, e.g. `https://host/fhir`. */
  readonly baseUrl?: string;
  /** When the statement was generated (ISO). */
  readonly generatedAt: string;
  /** Product version, for `software.version`. */
  readonly softwareVersion?: string;
  /**
   * Operations currently mounted. Callers turn these on as the routes land, so
   * the statement cannot drift ahead of the implementation by accident — it is
   * built from the same facts the router is.
   */
  readonly operations?: readonly ('export' | 'validate' | 'everything')[];
}

const SOFTWARE_NAME = 'AnantHealth';

/**
 * The resource types we can serialise, with the interactions we truly support.
 *
 * `read` is genuine: `GET /api/v1/fhir/{realmId}/{kind}/{id}` returns the
 * entity's R4 resource(s). There is deliberately no `search` or `create` — a
 * caller that wants the whole realm uses the export operation, and a caller that
 * wants to send us data POSTs a bundle.
 */
export function bridgedResourceTypes(): readonly string[] {
  return Object.keys(RESOURCE_TO_KIND).filter((type) => Boolean(RESOURCE_TO_KIND[type])).sort();
}

function resourceEntry(type: string): CapabilityStatementResource {
  const kind = RESOURCE_TO_KIND[type];
  const profile = 'http://hl7.org/fhir/StructureDefinition/' + type;
  return {
    type,
    ...(kind ? { profile } : {}),
    interaction: [{ code: 'read' }],
    // We hold no resource history, and every write we make is a proposal.
    versioning: 'no-version',
    readHistory: false,
    updateCreate: false,
  };
}

export function buildCapabilityStatement(opts: CapabilityStatementOptions): CapabilityStatement {
  const operations = opts.operations ?? ['export'];
  const documentation = [
    'AnantHealth FHIR bridge (R4).',
    '',
    'This is NOT a per-resource REST API and does not claim to be. Specifically:',
    '  • `read` is available for the resource types listed below, at the',
    '    realm-scoped path `GET {base}/api/v1/fhir/{realmId}/{kind}/{id}`, which',
    '    returns the entity as its R4 resource(s). There is no root-level',
    '    `GET /Patient/{id}`.',
    '  • `search` is not exposed per resource type. Population access is via the',
    '    realm export operation.',
    '  • Ingest is a Bundle POST accepting transaction / batch / collection /',
    '    message semantics with atomic rollback.',
    '  • Every clinical resource this bridge publishes is a PROPOSAL',
    "    (`intent: 'proposal'`, `status: 'draft'`). This system does not place orders.",
    '',
    'Reads are masked by the caller\'s PHI clearance and scoped to a realm.',
  ].join('\n');

  const rest: CapabilityStatement['rest'] = [
    {
      mode: 'server',
      documentation,
      security: {
        cors: true,
        description:
          'OAuth2 bearer / SMART Backend Services for machine access; console session for operator access. Reads are additionally gated by PHI clearance and realm scope.',
        service: [{ coding: [{ code: 'SMART-on-FHIR', display: 'SMART on FHIR' }] }],
      },
      ...(operations.length > 0
        ? {
            operation: operations.map((name) => ({
              name,
              definition:
                name === 'export'
                  ? 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export'
                  : `http://hl7.org/fhir/OperationDefinition/Resource-${name}`,
            })),
          }
        : {}),
      interaction: [],
      resource: bridgedResourceTypes().map(resourceEntry),
    },
  ];

  return {
    resourceType: 'CapabilityStatement',
    ...(opts.baseUrl ? { url: `${opts.baseUrl.replace(/\/+$/, '')}/metadata` } : {}),
    name: 'AnantHealthFHIRBridge',
    title: 'AnantHealth · FHIR bridge',
    status: 'active',
    date: opts.generatedAt,
    kind: 'instance',
    fhirVersion: FHIR_VERSION,
    format: ['json', 'application/fhir+json'],
    software: {
      name: SOFTWARE_NAME,
      ...(opts.softwareVersion ? { version: opts.softwareVersion } : {}),
    },
    implementation: {
      description: 'Governed renal care coordination bridge. Reads broadly, proposes narrowly.',
      ...(opts.baseUrl ? { url: opts.baseUrl.replace(/\/+$/, '') } : {}),
    },
    rest,
  };
}

/**
 * Guard against the statement drifting ahead of the router: a route we do not
 * mount must not be claimed.
 */
export function assertNoUnmountedClaims(
  statement: CapabilityStatement,
  mountedOperations: readonly string[],
): void {
  const claimed = statement.rest?.flatMap((r) => (r.operation ?? []).map((o) => o.name ?? '')) ?? [];
  const extra = claimed.filter((name) => name && !mountedOperations.includes(name));
  if (extra.length > 0) {
    throw new Error(
      `capability-statement-overstates-operations: claims ${extra.join(', ')} but only ${mountedOperations.join(', ') || 'none'} are mounted`,
    );
  }
}
