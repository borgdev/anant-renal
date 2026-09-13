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

import { describe, it, expect } from 'vitest';
import {
  VENDOR_PROFILES, vendorProfile, isVendorId, supportsInteraction, interactionsFor,
  routeProposal, rungRank, PROPOSAL_LADDER, supportsCdsHooks, describeProfile,
  type VendorProfile,
} from '../src/fhir/vendor-profile.js';
import {
  parseCapabilityStatement, summarizeCapabilities, negotiateCapabilities,
  compareProfileToDiscovery, claimedInteractionsMissing, CapabilityStatementError,
  type CapabilityStatement,
} from '../src/fhir/capability.js';
import { buildCapabilityStatement, bridgedResourceTypes, assertNoUnmountedClaims } from '../src/fhir/metadata.js';
import { RESOURCE_TO_KIND } from '../src/fhir/mapping.js';

const AT = '2026-09-12T00:00:00.000Z';

/** A server CapabilityStatement exposing `types` with per-type interactions. */
function statement(types: Record<string, string[]>, opts: { clientBlock?: boolean } = {}): CapabilityStatement {
  const resource = Object.entries(types).map(([type, codes]) => ({
    type,
    interaction: codes.map((code) => ({ code })),
  }));
  return {
    resourceType: 'CapabilityStatement',
    fhirVersion: '4.0.1',
    software: { name: 'TestServer', version: '9.9' },
    format: ['json', 'application/fhir+json'],
    rest: [
      ...(opts.clientBlock ? [{ mode: 'client' as const, resource: [{ type: 'ClientOnlyThing', interaction: [{ code: 'read' }] }] }] : []),
      {
        mode: 'server',
        security: { cors: true, service: [{ coding: [{ code: 'SMART-on-FHIR' }] }] },
        operation: [{ name: 'export' }],
        resource,
      },
    ],
  };
}

const ALL_TYPES = Object.fromEntries(
  ['Patient', 'Encounter', 'EpisodeOfCare', 'Observation', 'Procedure', 'ServiceRequest', 'MedicationRequest', 'Task', 'CommunicationRequest', 'Provenance']
    .map((t) => [t, ['read', 'search', 'create', 'update']]),
);

describe('vendor profiles (F1.1)', () => {
  it('registers the three target vendors plus a neutral profile', () => {
    expect(Object.keys(VENDOR_PROFILES).sort()).toEqual(['athena', 'cerner', 'epic', 'generic']);
    expect(isVendorId('epic')).toBe(true);
    expect(isVendorId('meditech')).toBe(false);
    // An unknown vendor must not throw — it degrades to the neutral profile.
    expect(vendorProfile('unknown-vendor').id).toBe('generic');
  });

  it('uses the vendor-appropriate auth mode (D2)', () => {
    expect(vendorProfile('epic').authMode).toBe('smart-backend-services');
    expect(vendorProfile('cerner').authMode).toBe('smart-backend-services');
    // Athena has NO Backend Services flow — this is a different auth path, not a
    // parameter change, so the profile must say so.
    expect(vendorProfile('athena').authMode).toBe('oauth2-delegated');
    expect(vendorProfile('generic').authMode).toBe('none');
  });

  it('declares Athena cannot accept a proposal and cannot report conversion', () => {
    const athena = vendorProfile('athena');
    expect(athena.supported.proposalIntent).toBe(false);
    expect(athena.supported.conversionObservable).toBe('none');
    expect(athena.confidence).toBe('assumed');
  });

  it('every profile is internally coherent', () => {
    for (const profile of Object.values(VENDOR_PROFILES)) {
      expect(profile.fhirVersion).toBe('R4');
      expect(profile.supported.maxPageSize).toBeGreaterThan(0);
      expect(profile.rateLimit.requestsPerMinute).toBeGreaterThan(0);
      expect(profile.rateLimit.burst).toBeGreaterThan(0);
      expect(profile.scopes.read.length).toBeGreaterThan(0);
      expect(['verified', 'vendor-documented', 'assumed']).toContain(profile.confidence);
      // Every profile must declare CDS Hooks explicitly rather than leave it to
      // an inference — it is the load-bearing fallback rung under D1.
      expect(typeof profile.supported.cdsHooks).toBe('boolean');
      expect(describeProfile(profile)).toContain(profile.label);
    }
  });

  it('Epic requires its non-standard client-id header; the others do not', () => {
    expect(vendorProfile('epic').requiredHeaders).toContain('Epic-Client-ID');
    expect(vendorProfile('cerner').requiredHeaders).toEqual([]);
  });
});

describe('proposal degradation ladder (D1 / D2)', () => {
  it('orders the rungs strongest to weakest', () => {
    expect(PROPOSAL_LADDER[0]).toBe('direct');
    expect(rungRank('direct')).toBeLessThan(rungRank('task'));
    expect(rungRank('task')).toBeLessThan(rungRank('cds-card'));
    expect(rungRank('cds-card')).toBeLessThan(rungRank('communication'));
    expect(rungRank('communication')).toBeLessThan(rungRank('harness-only'));
  });

  it('routes a proposal directly when the vendor honours intent:proposal', () => {
    const routed = routeProposal(vendorProfile('epic'), 'MedicationRequest');
    expect(routed.rung).toBe('direct');
    expect(routed.reason).toBe('');
    expect(routed.reachesEmr).toBe(true);
  });

  it('degrades Athena to a CDS card with the reason recorded', () => {
    const routed = routeProposal(vendorProfile('athena'), 'MedicationRequest');
    expect(routed.rung).toBe('cds-card');
    expect(routed.reachesEmr).toBe(true);
    // The operator must be able to see WHY it is not a first-class proposal.
    expect(routed.reason).toContain("intent:'proposal'");
    expect(routed.reason).toContain('CDS Hooks');
  });

  it('falls to harness-only when the vendor has neither a write surface nor a card channel', () => {
    const bare: VendorProfile = {
      ...vendorProfile('generic'),
      id: 'generic',
      supported: {
        ...vendorProfile('generic').supported,
        proposalIntent: false,
        cdsHooks: false,
        interactions: { Patient: ['read'] },
      },
    };
    const routed = routeProposal(bare, 'MedicationRequest');
    expect(routed.rung).toBe('harness-only');
    expect(routed.reachesEmr).toBe(false);
    expect(routed.reason).toContain('harness queue');
  });

  it('honours a kill-switched set of interactions rather than assuming writes', () => {
    expect(supportsInteraction(vendorProfile('athena'), 'MedicationRequest', 'create')).toBe(false);
    expect(interactionsFor(vendorProfile('athena'), 'MedicationRequest')).not.toContain('create');
    expect(supportsCdsHooks(vendorProfile('athena'))).toBe(true);
  });
});

describe('CapabilityStatement parsing and discovery (F0.3)', () => {
  it('rejects anything that is not a CapabilityStatement', () => {
    expect(() => parseCapabilityStatement({ resourceType: 'OperationOutcome' })).toThrow(CapabilityStatementError);
    expect(() => parseCapabilityStatement(null)).toThrow(CapabilityStatementError);
  });

  it('reads the SERVER rest block, not the client block', () => {
    const summary = summarizeCapabilities(
      statement({ Patient: ['read', 'search'] }, { clientBlock: true }),
      AT,
    );
    expect(summary.resourceTypes).toEqual(['Patient']);
    // A client block describes what the server may CALL — the opposite of what
    // we are asking, so it must not contribute resource types.
    expect(summary.resourceTypes).not.toContain('ClientOnlyThing');
  });

  it('collects interactions, export support, cors and security services', () => {
    const summary = summarizeCapabilities(statement(ALL_TYPES), AT);
    expect(summary.interactions.Patient).toEqual(['read', 'search', 'create', 'update']);
    expect(summary.supportsBulkExport).toBe(true);
    expect(summary.cors).toBe(true);
    expect(summary.securityServices).toContain('SMART-on-FHIR');
    expect(summary.softwareName).toBe('TestServer');
    expect(summary.fhirVersion).toBe('4.0.1');
    expect(summary.readAt).toBe(AT);
  });

  it('reports a missing discovery rather than inventing one', () => {
    const summary = summarizeCapabilities(statement({ Patient: ['read'] }), AT);
    expect(summary.bulkExportTypes).toEqual([]);
  });
});

describe('capability negotiation (F1.3)', () => {
  it('falls back to the profile when there is no discovery, and says so', () => {
    const report = negotiateCapabilities(vendorProfile('epic'), undefined, AT);
    const patient = report.flows.find((f) => f.flow.id === 'patient-read');
    expect(patient?.verdict).toBe('available');
    expect(patient?.reason).toContain('no discovery available to confirm');
    // Without a discovery we cannot claim the essential discovery flow works.
    expect(report.essentialBlocked).toContain('capability');
  });

  it('lets DISCOVERY win over the profile when they disagree', () => {
    // The Athena profile conservatively claims no FHIR writes; a sandbox that
    // DOES accept a MedicationRequest create must correct that.
    const summary = summarizeCapabilities(statement(ALL_TYPES), AT);
    const report = negotiateCapabilities(vendorProfile('athena'), summary, AT);
    const meds = report.flows.find((f) => f.flow.id === 'proposal-medication-request');
    // Discovery says create is available, so the flow is available...
    expect(meds?.verdict).toBe('degraded');
    // ...but Athena still honours no intent:'proposal', so the RUNG is unchanged.
    expect(meds?.rung).toBe('cds-card');
  });

  it('marks a flow unavailable when the server does not declare it', () => {
    const summary = summarizeCapabilities(statement({ Patient: ['read', 'search'] }), AT);
    const report = negotiateCapabilities(vendorProfile('epic'), summary, AT);
    const meds = report.flows.find((f) => f.flow.id === 'proposal-medication-request');
    expect(meds?.verdict).toBe('unavailable');
    expect(report.essentialBlocked).toContain('proposal-medication-request');
    expect(report.headline).toContain('essential flow(s) unavailable');
  });

  it('reports a fully-available server with the degraded proposal count', () => {
    const summary = summarizeCapabilities(statement(ALL_TYPES), AT);
    const report = negotiateCapabilities(vendorProfile('epic'), summary, AT);
    expect(report.essentialBlocked).toEqual([]);
    expect(report.headline).toMatch(/All (required|essential) flows available/);
  });

  it('detects a profile that overstates what the server supports', () => {
    const summary = summarizeCapabilities(statement({ Patient: ['read'] }), AT);
    const accuracy = compareProfileToDiscovery(vendorProfile('epic'), summary);
    expect(accuracy.profileOverstates).toBe(true);
    expect(accuracy.overstated).toContain('MedicationRequest');
    // And the reverse: the server has types the profile never claimed.
    expect(accuracy.understated).toEqual([]);
  });

  it('names the interactions a profile claims but discovery denies', () => {
    const summary = summarizeCapabilities(statement({ ServiceRequest: ['read'] }), AT);
    const missing = claimedInteractionsMissing(vendorProfile('epic'), summary, 'ServiceRequest');
    expect(missing).toContain('create');
    expect(missing).not.toContain('read');
  });

  it('requires the essential flows to be declared, not assumed', () => {
    // Every essential flow must be one we genuinely cannot ship without.
    const report = negotiateCapabilities(vendorProfile('generic'), undefined, AT);
    const essential = report.flows.filter((f) => f.flow.essential).map((f) => f.flow.id);
    expect(essential).toContain('patient-search');
    expect(essential).toContain('observation-read');
    expect(essential).toContain('proposal-service-request');
    // A session Procedure write is NOT essential — the vendor profile may force
    // us to hold the session locally and emit at end-session.
    expect(essential).not.toContain('procedure-write');
  });
});

describe('our own CapabilityStatement (F0.4)', () => {
  it('lists exactly the resource types we can serialise', () => {
    const bridged = bridgedResourceTypes();
    const mapped = Object.keys(RESOURCE_TO_KIND).filter((t) => Boolean(RESOURCE_TO_KIND[t])).sort();
    expect(bridged).toEqual(mapped);
    expect(bridged).toContain('Patient');
  });

  it('claims ONLY read — never a search or a write we do not serve', () => {
    const statement = buildCapabilityStatement({ generatedAt: AT });
    const resources = statement.rest?.[0]?.resource ?? [];
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource.interaction?.map((i) => i.code)).toEqual(['read']);
    }
    // No root-level search surface exists, so none may be advertised.
    const claimed = new Set(resources.flatMap((r) => (r.interaction ?? []).map((i) => i.code)));
    expect(claimed.has('search')).toBe(false);
    expect(claimed.has('create')).toBe(false);
    expect(claimed.has('update')).toBe(false);
  });

  it('states in its own documentation that reads are realm-scoped and writes are proposals', () => {
    const statement = buildCapabilityStatement({ generatedAt: AT });
    const doc = statement.rest?.[0]?.documentation ?? '';
    expect(doc).toContain('realm-scoped');
    expect(doc).toContain('PROPOSAL');
    expect(doc).toContain('does not place orders');
  });

  it('declares no versioning, because we hold no resource history', () => {
    const statement = buildCapabilityStatement({ generatedAt: AT });
    for (const resource of statement.rest?.[0]?.resource ?? []) {
      expect(resource.versioning).toBe('no-version');
      expect(resource.readHistory).toBe(false);
    }
  });

  it('refuses to claim an operation that is not mounted', () => {
    const statement = buildCapabilityStatement({ generatedAt: AT, operations: ['export'] });
    expect(() => assertNoUnmountedClaims(statement, ['export'])).not.toThrow();
    expect(() => assertNoUnmountedClaims(statement, [])).toThrow(/overstates-operations/);
  });
});
