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

// ─────────────────────────────────────────────────────────────────────────────
// Platform hardening report (platform Phase 1).
//
// Phase 1's exit criterion is "platform health can be managed without
// specialty knowledge". That is only true if an operator can answer one
// question — *is this platform safe to run and safe to extend?* — without
// knowing renal, oncology, or any other domain.
//
// So this module is deliberately domain-blind. Every check reads platform
// state: secret hygiene, the two integration contracts, pack conformance,
// release gating, the write policy, DLQ depth and identity. None of them read
// a clinical concept.
//
// It is pure: the route gathers state, this decides. That keeps the judgement
// testable without a running server, and keeps the reasons legible.
//
// Severity is chosen so that the *fail* set is the set of things that would
// actually hurt: a literal secret in stored config, a pack that breaks the
// contract, an uncertified write path marked live, an open DLQ incident.
// Missing-but-expected state is a `warn`, never a silent pass.
// ─────────────────────────────────────────────────────────────────────────────

import type { DomainPack } from './pack-registry.js';
import {
  conformanceMatrix, SPECIALTY_CONTRACT_VERSION,
  type PackConformanceReport, type SpecialtySections,
} from './pack-contract.js';

export type HardeningStatus = 'pass' | 'warn' | 'fail';

export interface HardeningCheck {
  readonly id: string;
  readonly label: string;
  /** The platform area the check belongs to — never a specialty. */
  readonly area: string;
  readonly status: HardeningStatus;
  readonly detail: string;
  /** What the operator does about it, when there is something to do. */
  readonly remediation?: string;
}

export interface HardeningReport {
  readonly contractVersion: string;
  readonly generatedAt: string;
  readonly status: 'ready' | 'attention' | 'blocked';
  readonly byStatus: Record<HardeningStatus, number>;
  readonly checks: readonly HardeningCheck[];
}

/** Live write policies. `bound` means a real EMR is written to. */
export type WritePolicy = Record<string, string>;

export interface PlatformHardeningInput {
  /** Kafka connection config: status plus the stored secret *reference*. */
  readonly kafka?: { status?: string; secretRef?: string } | null;
  /** FHIR/EMR connection config: status, per-kind write policy, and every
   *  field that must hold a binding rather than a value. */
  readonly fhir?: {
    status?: string;
    writePolicy?: WritePolicy;
    secretRefs?: Readonly<Record<string, string | undefined>>;
  } | null;
  /** Installed packs, for the contract matrix. */
  readonly packs?: readonly (DomainPack & SpecialtySections)[];
  /** Release dossiers, for gate convergence. */
  readonly releases?: readonly {
    status?: string;
    checks?: readonly { name?: string; passed?: boolean }[];
  }[];
  /** Open broker/bridge incidents that have not been remediated. */
  readonly openIncidents?: number;
  /** Dead outbox rows awaiting replay or abandonment. */
  readonly deadOutbox?: number;
  /** Configured users — identity must exist before anyone can be governed. */
  readonly userCount?: number;
  /** Secret binding names the provider holds. Values are never read. */
  readonly secretNames?: readonly string[];
  /**
   * Vendors whose sandbox certification is recorded. A `bound` write policy
   * for an uncertified vendor is the one failure this report treats as
   * unambiguously unsafe, because it writes to a chart.
   */
  readonly certifiedVendors?: readonly string[];
}

/**
 * The same literal-secret shape the FHIR routes reject on write. Duplicated
 * deliberately: the guard on the way in and the audit of what is already
 * stored must not be able to drift, so both are asserted by test.
 */
const LITERAL_SECRET = /^[A-Za-z0-9_+/=]{24,}$/;

/** Fields that must hold a `binding:NAME` reference. */
const SECRET_REF_FIELDS = [
  'secretRef', 'tokenRef', 'passwordRef', 'privateKeyRef', 'clientSecretRef', 'refreshTokenRef',
] as const;

function isBinding(value: string): boolean {
  return value.startsWith('binding:') && value.length > 'binding:'.length;
}

/** Find any stored field that looks like a pasted secret rather than a binding. */
export function findLiteralSecrets(
  fhir: PlatformHardeningInput['fhir'],
  kafka: PlatformHardeningInput['kafka'],
): string[] {
  const offenders: string[] = [];
  const inspect = (scope: string, value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (isBinding(value)) return;
    if (LITERAL_SECRET.test(value)) offenders.push(`${scope}="${value.slice(0, 4)}…"`);
  };

  for (const field of SECRET_REF_FIELDS) {
    inspect(`fhir.${field}`, fhir?.secretRefs?.[field]);
  }
  inspect('kafka.secretRef', kafka?.secretRef);
  return offenders;
}

/** Every write policy that is live (`bound`). */
export function boundWriteKinds(policy: WritePolicy | undefined): string[] {
  if (!policy) return [];
  return Object.entries(policy)
    .filter(([, value]) => value === 'bound')
    .map(([kind]) => kind)
    .sort();
}

/** Release gate convergence: how many dossier checks passed, if any ran. */
export function releaseGateSummary(releases: PlatformHardeningInput['releases']): {
  total: number; active: number; failing: number; gateChecks: number; gatePassed: number;
} {
  const list = releases ?? [];
  const allChecks = list.flatMap((r) => r.checks ?? []);
  return {
    total: list.length,
    active: list.filter((r) => r.status === 'active').length,
    failing: list.filter((r) => r.status === 'failed').length,
    gateChecks: allChecks.length,
    gatePassed: allChecks.filter((c) => c.passed).length,
  };
}

/**
 * Build the hardening report. Pure: same input, same output.
 */
export function buildHardeningReport(
  input: PlatformHardeningInput,
  now: string = new Date().toISOString(),
): HardeningReport {
  const checks: HardeningCheck[] = [];

  /* ---------- secret hygiene ---------- */
  const literalSecrets = findLiteralSecrets(input.fhir, input.kafka);
  checks.push({
    id: 'secret-hygiene',
    label: 'No secret values in stored configuration',
    area: 'secrets',
    status: literalSecrets.length === 0 ? 'pass' : 'fail',
    detail: literalSecrets.length === 0
      ? `all stored credential fields are binding references · ${input.secretNames?.length ?? 0} binding(s) held by the provider`
      : `literal value(s) found in ${literalSecrets.join(', ')}`,
    ...(literalSecrets.length === 0 ? {} : {
      remediation: 'Move the value into the secrets provider and store only its binding:NAME reference, then rotate the exposed credential.',
    }),
  });

  /* ---------- broker contract ---------- */
  const kafkaStatus = input.kafka?.status ?? 'not-configured';
  checks.push({
    id: 'broker-contract',
    label: 'Broker contract verified',
    area: 'integrations',
    status: kafkaStatus === 'contract-verified' ? 'pass' : kafkaStatus === 'not-configured' ? 'warn' : 'warn',
    detail: `kafka status: ${kafkaStatus}`,
    ...(kafkaStatus === 'contract-verified' ? {} : {
      remediation: 'Run the integration contract test from Platform admin → Integration contract.',
    }),
  });

  /* ---------- EMR contract ---------- */
  const fhirStatus = input.fhir?.status ?? 'not-configured';
  checks.push({
    id: 'emr-contract',
    label: 'EMR connection contract verified',
    area: 'integrations',
    status: fhirStatus === 'contract-verified' ? 'pass' : 'warn',
    detail: `fhir status: ${fhirStatus}`,
  });

  /* ---------- write safety: the only clinical-shaped check, and it is
       phrased in platform terms on purpose. ---------- */
  const bound = boundWriteKinds(input.fhir?.writePolicy);
  const certified = new Set(input.certifiedVendors ?? []);
  const uncertifiedBound = bound.length > 0 && certified.size === 0;
  checks.push({
    id: 'write-policy-safety',
    label: 'Live write paths are certified',
    area: 'governance',
    status: bound.length === 0 ? 'pass' : uncertifiedBound ? 'fail' : 'warn',
    detail: bound.length === 0
      ? 'no effect kind is bound — everything is shadow or off'
      : `${bound.length} kind(s) bound to a real EMR (${bound.join(', ')}); certified vendors: ${certified.size === 0 ? 'none recorded' : [...certified].join(', ')}`,
    ...(uncertifiedBound ? {
      remediation: 'A bound kind writes to a chart. Record vendor sandbox certification before leaving shadow mode.',
    } : {}),
  });

  /* ---------- pack conformance ---------- */
  const matrix = conformanceMatrix(input.packs ?? []);
  const nonconformant = matrix.packs.filter((p: PackConformanceReport) => p.level === 'nonconformant');
  checks.push({
    id: 'pack-conformance',
    label: 'Installed packs satisfy the specialty contract',
    area: 'extensibility',
    status: nonconformant.length === 0
      ? (matrix.byLevel.partial > 0 ? 'warn' : 'pass')
      : 'fail',
    detail: matrix.total === 0
      ? 'no packs installed'
      : `${matrix.total} installed · ${matrix.byLevel.conformant} conformant · ${matrix.byLevel.partial} partial · ${matrix.byLevel.nonconformant} nonconformant`,
    ...(nonconformant.length === 0 ? {} : {
      remediation: `Fix or uninstall: ${nonconformant.map((p) => p.packId).join(', ')}.`,
    }),
  });

  /* ---------- two specialties prove generality ---------- */
  const specialtyCount = matrix.total - (matrix.byLevel.substrate > 0 ? 1 : 0);
  checks.push({
    id: 'platform-generality',
    label: 'Platform carries more than one specialty',
    area: 'extensibility',
    status: specialtyCount >= 2 ? 'pass' : 'warn',
    detail: specialtyCount >= 2
      ? `${specialtyCount} specialty packs installed — the core is demonstrably not single-domain`
      : `${specialtyCount} specialty pack(s) installed — generality is unproven until a second pack lands`,
  });

  /* ---------- release gate ---------- */
  const gate = releaseGateSummary(input.releases);
  checks.push({
    id: 'release-gate',
    label: 'Release gating is healthy',
    area: 'release',
    status: gate.failing > 0 ? 'fail' : gate.active > 0 ? 'pass' : 'warn',
    detail: gate.total === 0
      ? 'no release dossiers yet'
      : `${gate.total} dossier(s) · ${gate.active} active · ${gate.failing} failed · gate checks ${gate.gatePassed}/${gate.gateChecks}`,
    ...(gate.failing > 0 ? { remediation: 'A failed dossier is blocking activation; inspect it in the Release center.' } : {}),
  });

  /* ---------- configuration versioning ---------- */
  checks.push({
    id: 'config-versioning',
    label: 'Configuration is versioned',
    area: 'release',
    status: gate.total > 0 ? 'pass' : 'warn',
    detail: gate.total > 0
      ? `${gate.total} immutable manifest(s) recorded`
      : 'configuration has not been captured in a release manifest yet',
  });

  /* ---------- DLQ ---------- */
  const incidents = input.openIncidents ?? 0;
  const dead = input.deadOutbox ?? 0;
  checks.push({
    id: 'dlq-clear',
    label: 'No unremediated delivery failures',
    area: 'integration-health',
    status: incidents === 0 && dead === 0 ? 'pass' : incidents > 0 ? 'fail' : 'warn',
    detail: `${incidents} open bridge incident(s) · ${dead} dead outbox row(s)`,
    ...(incidents === 0 && dead === 0 ? {} : {
      remediation: 'Remediate through the DLQ journey — acknowledge or replay — so recovery is recorded, not just observed.',
    }),
  });

  /* ---------- identity ---------- */
  const users = input.userCount ?? 0;
  checks.push({
    id: 'identity-populated',
    label: 'Identity and decision rights exist',
    area: 'identity',
    status: users > 0 ? 'pass' : 'warn',
    detail: `${users} configured user(s)`,
  });

  const byStatus: Record<HardeningStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) byStatus[c.status] += 1;

  return {
    contractVersion: SPECIALTY_CONTRACT_VERSION,
    generatedAt: now,
    status: byStatus.fail > 0 ? 'blocked' : byStatus.warn > 0 ? 'attention' : 'ready',
    byStatus,
    checks,
  };
}
