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

// Terminology service surface (F4.6).
//
// A partner EMR can ask US what a code in one of our messages means, and can
// validate a code before using it. This matters because we emit `local` code
// systems for concepts we could not authoritatively verify — a receiver has no
// other way to learn what `urn:ananthealth:codesystem:safety-flag|access-risk`
// means, and guessing is how terminology mismatches become clinical incidents.
//
//   GET /fhir/CodeSystem/$lookup?system=&code=   → Parameters (name/version/display)
//   GET /fhir/ValueSet/$validate-code?system=&code=  → Parameters (result)
//   GET /fhir/CodeSystem                        → Bundle of the systems we use
//   GET /fhir/ValueSet                          → Bundle of the harness's value sets
//   GET /fhir/terminology/report                → coverage + what needs sign-off
//
// Registered on the FHIR scope so these share its OperationOutcome discipline.

import type { FastifyInstance } from 'fastify';
import { codeRegistry, terminologyReport, localCodeSystem, type CodeDomain } from '../fhir/code-registry.js';
import { FHIR_VERSION } from '../fhir/metadata.js';
import { operationOutcome, httpStatusForIssue } from '../fhir/operation-outcome.js';
import { seedValueSets } from '../healthcare-core/terminology.js';

interface FhirParameter {
  name: string;
  valueString?: string;
  valueBoolean?: boolean;
  valueUri?: string;
}

const parameters = (params: FhirParameter[]): { resourceType: 'Parameters'; parameter: FhirParameter[] } => ({
  resourceType: 'Parameters',
  parameter: params,
});

export function registerTerminologySurface(app: FastifyInstance): void {
  const entries = () => codeRegistry.entries();

  /* ------------------------------------------------------------- $lookup */

  app.get<{ Querystring: { system?: string; code?: string; version?: string } }>(
    '/fhir/CodeSystem/$lookup',
    async (req, reply) => {
      const { system, code } = req.query;
      const missing = [
        ...(system ? [] : ['system']),
        ...(code ? [] : ['code']),
      ];
      if (missing.length > 0) {
        const outcome = operationOutcome('required', `Missing required parameter(s): ${missing.join(', ')}.`, {
          expression: missing,
        });
        return reply.code(httpStatusForIssue('required')).send(outcome);
      }

      const entry = entries().find((e) => e.system === system && e.code === code);
      if (!entry) {
        const outcome = operationOutcome(
          'not-found',
          `No concept ${system}|${code} in this server's code systems. ` +
            `Lookup resolves the codes the harness itself can emit; see /fhir/CodeSystem for the systems served.`,
        );
        return reply.code(httpStatusForIssue('not-found')).send(outcome);
      }

      reply.header('content-type', 'application/fhir+json');
      return parameters([
        { name: 'name', valueString: displayNameFor(entry.system) },
        { name: 'version', valueString: entry.version },
        { name: 'display', valueString: entry.display },
        { name: 'system', valueString: entry.system },
        { name: 'code', valueString: entry.code },
        // Our own extension-style parameters, so a receiver can tell a verified
        // mapping from a locally-declared one.
        { name: 'fidelity', valueString: entry.fidelity },
        { name: 'source', valueString: entry.source },
        { name: 'domain', valueString: entry.domain },
      ]);
    },
  );

  /* ------------------------------------------------------ $validate-code */

  app.get<{ Querystring: { system?: string; code?: string; display?: string; url?: string } }>(
    '/fhir/ValueSet/$validate-code',
    async (req, reply) => {
      const { system, code } = req.query;
      if (!system || !code) {
        const outcome = operationOutcome('required', 'Both `system` and `code` are required.');
        return reply.code(httpStatusForIssue('required')).send(outcome);
      }

      const entry = entries().find((e) => e.system === system && e.code === code);
      reply.header('content-type', 'application/fhir+json');
      return parameters([
        { name: 'result', valueBoolean: Boolean(entry) },
        ...(entry ? [{ name: 'display', valueString: entry.display }] : []),
        {
          name: 'message',
          valueString: entry
            ? `Valid: ${entry.domain} '${entry.slug}' (${entry.fidelity}).`
            : `Unknown code ${system}|${code} — the harness cannot emit it, so a receiver should not expect it.`,
        },
      ]);
    },
  );

  /* -------------------------------------------------- serve our systems */

  app.get('/fhir/CodeSystem', async (_req, reply) => {
    const systems = new Map<string, { system: string; version: string; codes: number }>();
    for (const entry of entries()) {
      const existing = systems.get(entry.system);
      if (existing) existing.codes += 1;
      else systems.set(entry.system, { system: entry.system, version: entry.version, codes: 1 });
    }
    reply.header('content-type', 'application/fhir+json');
    return {
      resourceType: 'Bundle',
      type: 'collection',
      total: systems.size,
      entry: [...systems.values()].map((s) => ({
        resource: {
          resourceType: 'CodeSystem',
          url: s.system,
          version: s.version,
          // The LOCAL systems are the ones a receiver cannot look up elsewhere.
          content: s.system.startsWith('urn:ananthealth:codesystem:') ? 'complete' : 'not-present',
          title: displayNameFor(s.system),
          count: s.codes,
        },
      })),
    };
  });

  app.get('/fhir/ValueSet', async (_req, reply) => {
    reply.header('content-type', 'application/fhir+json');
    return {
      resourceType: 'Bundle',
      type: 'collection',
      total: seedValueSets.length + localCodeSystems().length,
      entry: [
        ...seedValueSets.map((vs) => ({
          resource: {
            resourceType: 'ValueSet',
            id: vs.id,
            url: vs.url ?? `urn:ananthealth:valueset:${vs.id}`,
            name: vs.name,
            version: vs.version,
            ...(vs.steward ? { publisher: vs.steward } : {}),
            compose: { include: [{ concept: vs.codes.map((c) => ({ system: c.system, code: c.code, ...(c.display ? { display: c.display } : {}) })) }] },
          },
        })),
        // Every local code system is also published as a value set, because a
        // receiver must be able to enumerate what we might send it.
        ...localCodeSystems().map((domain) => ({
          resource: {
            resourceType: 'ValueSet',
            id: `vs:local.${domain}`,
            url: `urn:ananthealth:valueset:local.${domain}`,
            name: `AnantHealth local codes — ${domain}`,
            version: '1.0.0',
            compose: { include: [{ system: localCodeSystem(domain) }] },
          },
        })),
      ],
    };
  });

  /* --------------------------------------------------- coverage report */

  app.get('/fhir/terminology/report', async (_req, reply) => {
    reply.header('content-type', 'application/fhir+json');
    const report = terminologyReport();
    return {
      resourceType: 'Parameters',
      parameter: [
        { name: 'fhirVersion', valueString: FHIR_VERSION },
        { name: 'total', valueString: String(report.total) },
        { name: 'verified', valueString: String(report.verified) },
        { name: 'local', valueString: String(report.local) },
        { name: 'needsSignOff', valueString: String(report.needsSignOff.length) },
      ],
      // The detail a terminology reviewer works from: what is unverified and why.
      coverage: report.byDomain,
      needsSignOff: report.needsSignOff,
    };
  });
}

/** Local code systems we declare for concepts we could not verify. */
function localCodeSystems(): CodeDomain[] {
  const domains = new Set<CodeDomain>();
  for (const entry of codeRegistry.entries()) {
    if (entry.fidelity === 'local') domains.add(entry.domain);
  }
  return [...domains].sort();
}

function displayNameFor(system: string): string {
  if (system.startsWith('urn:ananthealth:codesystem:')) return `AnantHealth local code system`;
  const known: Record<string, string> = {
    'http://loinc.org': 'LOINC',
    'http://snomed.info/sct': 'SNOMED CT',
    'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm',
    'http://hl7.org/fhir/sid/cvx': 'CVX',
    'http://hl7.org/fhir/sid/icd-10-cm': 'ICD-10-CM',
    'http://www.ama-assn.org/go/cpt': 'CPT',
  };
  return known[system] ?? system;
}
