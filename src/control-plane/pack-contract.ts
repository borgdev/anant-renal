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
// The specialty pack contract (platform Phase 0).
//
// This module is the *written* boundary between the shared platform and a
// specialty. It exists because the alternative — a product that is really the
// renal product wearing a platform costume — is invisible until the second
// specialty is attempted, at which point the coupling is expensive to unwind.
//
// The contract is deliberately two-sided:
//
//   PLATFORM_BOUNDARY   what the platform owns and a pack may assume. These are
//                       generic by construction: identity, organization,
//                       events, policy, releases, audit. A pack must NOT
//                       re-implement them, and `validateSpecialtyPack` FAILS a
//                       pack that claims one as its own capability.
//
//   PACK_SECTIONS       what a specialty must supply. Only three are hard
//                       requirements (identity, substrate dependency, org
//                       scope); the clinical sections are *declared* rather
//                       than enforced, because a pack legitimately arrives
//                       before its measures do — but an undeclared section is
//                       reported as `partial` rather than silently accepted.
//
// The report is data, not an exception: a pack is `usable` or not, with the
// exact check that decided it. `conformanceMatrix` runs the whole set so the
// Pack Studio can show which installed packs are actually first-class
// platform citizens instead of only which ones loaded.
// ─────────────────────────────────────────────────────────────────────────────

import type { DomainPack } from './pack-registry.js';

/** Bumped when a pack must change to stay conformant. */
export const SPECIALTY_CONTRACT_VERSION = '1.0.0';

/** The pack every specialty extends. It is the substrate, not a specialty. */
export const SUBSTRATE_PACK_ID = 'healthcare-core';

export type BoundaryOwner = 'platform' | 'pack';

export interface BoundaryItem {
  readonly id: string;
  readonly label: string;
  readonly owner: BoundaryOwner;
  /** One line on why it lives where it does. */
  readonly detail: string;
}

/**
 * The platform surface. A specialty pack depends on every item here and
 * supplies none of them.
 */
export const PLATFORM_RESPONSIBILITIES: readonly BoundaryItem[] = Object.freeze([
  { id: 'identity-and-access', label: 'Identity, roles and access', owner: 'platform', detail: 'Users, roles, clearance, purpose of use and console gating are resolved once, server-side.' },
  { id: 'organization-and-scope', label: 'Organization and scope model', owner: 'platform', detail: 'Provider/payer/hybrid hierarchy, data boundaries and scope containment.' },
  { id: 'event-plane', label: 'Event plane', owner: 'platform', detail: 'Broker drivers, topics, partitions, outbox, idempotency, retry, DLQ and audited replay.' },
  { id: 'integration-registry', label: 'Integration registry', owner: 'platform', detail: 'Kafka, FHIR/EMR, CMS and identity connections, with secret *bindings* and contract tests.' },
  { id: 'canonical-data-plane', label: 'Canonical data plane', owner: 'platform', detail: 'FHIR-aligned records, provenance, content hashes, valid time and recorded time.' },
  { id: 'policy-and-approval', label: 'Policy and human approval', owner: 'platform', detail: 'Deny-by-default action policy, approval classes and arbitration.' },
  { id: 'release-and-config', label: 'Release and configuration', owner: 'platform', detail: 'Versioned configuration objects, release manifests, gates, canary and rollback.' },
  { id: 'audit-and-observability', label: 'Audit and observability', owner: 'platform', detail: 'Hash-chained audit, trace correlation and the operational surfaces over both.' },
  { id: 'pack-registry', label: 'Pack registry and activation', owner: 'platform', detail: 'Dependency resolution, version ranges, durable activation and the lens switch.' },
]);

/**
 * What a specialty supplies. Only the first three are enforced; the rest are
 * declared so that "this pack has no measures yet" is a visible fact rather
 * than an invisible gap.
 */
export const PACK_RESPONSIBILITIES: readonly BoundaryItem[] = Object.freeze([
  { id: 'identity', label: 'Pack identity and version', owner: 'pack', detail: 'A stable id and a semver version the registry can resolve against.' },
  { id: 'substrate-dependency', label: 'Declared dependency on the substrate', owner: 'pack', detail: `The pack extends ${SUBSTRATE_PACK_ID} rather than assuming the platform implicitly.` },
  { id: 'organization-scope', label: 'Applicable organization kinds', owner: 'pack', detail: 'Which organization kinds the pack is meaningful for.' },
  { id: 'capabilities', label: 'Declared capabilities', owner: 'pack', detail: 'The bounded responsibilities the pack adds to the platform.' },
  { id: 'ontology', label: 'Domain ontology', owner: 'pack', detail: 'The specialty vocabulary the platform does not know about.' },
  { id: 'event-contracts', label: 'Event contracts', owner: 'pack', detail: 'The specialty event shapes the canonical plane will carry.' },
  { id: 'workflows', label: 'Workflows and reducers', owner: 'pack', detail: 'Specialty state machines and the reducers that fold events through them.' },
  { id: 'measures', label: 'Measures and quality logic', owner: 'pack', detail: 'Quality/regulatory logic, bound to the CMS universe where applicable.' },
  { id: 'ui-lens', label: 'Experience lens', owner: 'pack', detail: 'Specialty navigation, terminology and dashboards rendered in the shared shell.' },
  { id: 'required-controls', label: 'Required controls', owner: 'pack', detail: 'The controls the platform asserts over this pack before it may run.' },
]);

/** The concrete sections a specialty pack descriptor may carry. */
export interface SpecialtyOntologySection {
  readonly id: string;
  readonly version: string;
  /** Domain concept count is the cheapest honest signal that it is not a stub. */
  readonly conceptCount?: number;
}

export interface SpecialtyLensSection {
  readonly id: string;
  readonly label: string;
  /** Nav entries the shell will render for this lens. */
  readonly nav?: readonly string[];
}

export interface SpecialtySections {
  readonly ontology?: SpecialtyOntologySection;
  readonly eventContracts?: readonly string[];
  readonly workflows?: readonly string[];
  readonly measures?: readonly string[];
  readonly uiLens?: SpecialtyLensSection;
}

/**
 * A pack descriptor with the specialty sections. `DomainPack` stays minimal so
 * the existing packs keep compiling; this is the enriched shape a pack adopts
 * to be first-class.
 */
export type SpecialtyPackDescriptor = DomainPack & SpecialtySections;

export type ContractCheckStatus = 'pass' | 'warn' | 'fail';

export interface ContractCheck {
  readonly id: string;
  readonly label: string;
  readonly status: ContractCheckStatus;
  readonly detail: string;
}

export type ConformanceLevel = 'substrate' | 'conformant' | 'partial' | 'nonconformant';

export interface PackConformanceReport {
  readonly packId: string;
  readonly version: string;
  readonly contractVersion: string;
  readonly level: ConformanceLevel;
  /** No failing check → the platform will install and activate it. */
  readonly usable: boolean;
  readonly checks: readonly ContractCheck[];
  readonly declaredSections: readonly string[];
  readonly missingSections: readonly string[];
}

/** The sections a specialty is expected to declare, in report order. */
const EXPECTED_SECTIONS = ['ontology', 'eventContracts', 'workflows', 'measures', 'uiLens'] as const;

/** Controls every pack must declare, because the platform asserts them. */
const MANDATORY_CONTROLS = ['access-policy', 'audit-provenance'] as const;

const SEMVER = /^\d+\.\d+\.\d+$/;

const platformCapabilityIds = new Set(PLATFORM_RESPONSIBILITIES.map((r) => r.id));

function hasContent<T>(value: readonly T[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Validate one pack against the contract.
 *
 * Ordering matters for the reader: the hard requirements come first (so the
 * first `fail` is the one that matters), then the declared sections.
 */
export function validateSpecialtyPack(pack: DomainPack & SpecialtySections): PackConformanceReport {
  const checks: ContractCheck[] = [];
  const isSubstrate = pack.id === SUBSTRATE_PACK_ID;

  // 1 — identity
  const identityOk = Boolean(pack.id?.trim()) && SEMVER.test(pack.version ?? '');
  checks.push({
    id: 'identity',
    label: 'Pack identity and version',
    status: identityOk ? 'pass' : 'fail',
    detail: identityOk ? `${pack.id}@${pack.version}` : `id or semver version invalid (id="${pack.id ?? ''}", version="${pack.version ?? ''}")`,
  });

  // 2 — substrate dependency. The substrate itself is exempt.
  const extendsSubstrate = (pack.extends ?? []).some((d) => d.id === SUBSTRATE_PACK_ID);
  if (isSubstrate) {
    checks.push({
      id: 'substrate-dependency',
      label: 'Declared dependency on the substrate',
      status: 'pass',
      detail: 'this pack IS the substrate',
    });
  } else {
    checks.push({
      id: 'substrate-dependency',
      label: 'Declared dependency on the substrate',
      status: extendsSubstrate ? 'pass' : 'fail',
      detail: extendsSubstrate
        ? `extends ${SUBSTRATE_PACK_ID}`
        : `must declare extends: [{ id: '${SUBSTRATE_PACK_ID}', versionRange }]`,
    });
  }

  // 3 — organization scope
  const kinds = pack.appliesTo?.organizationKinds ?? [];
  checks.push({
    id: 'organization-scope',
    label: 'Applicable organization kinds',
    status: hasContent(kinds) ? 'pass' : 'fail',
    detail: hasContent(kinds) ? kinds.join(', ') : 'appliesTo.organizationKinds is empty — the platform cannot scope the pack',
  });

  // 4 — declared capabilities
  const caps = pack.capabilities ?? [];
  checks.push({
    id: 'capabilities',
    label: 'Declared capabilities',
    status: hasContent(caps) ? 'pass' : 'fail',
    detail: hasContent(caps) ? `${caps.length} declared` : 'no capabilities declared — the pack contributes nothing the platform can route',
  });

  // 5 — no platform overreach. A pack claiming a platform-owned capability is
  // the exact conflation this contract exists to prevent.
  const overreach = caps.filter((c) => platformCapabilityIds.has(c));
  checks.push({
    id: 'platform-boundary',
    label: 'Respects the platform boundary',
    status: overreach.length === 0 ? 'pass' : 'fail',
    detail: overreach.length === 0
      ? 'no platform-owned capability claimed'
      : `claims platform-owned capability/capabilities: ${overreach.join(', ')}`,
  });

  // 6 — required controls
  const controls = pack.requiredControls ?? [];
  const missingControls = MANDATORY_CONTROLS.filter((c) => !controls.includes(c));
  checks.push({
    id: 'required-controls',
    label: 'Required controls',
    status: missingControls.length === 0 ? 'pass' : 'warn',
    detail: missingControls.length === 0
      ? `asserts ${controls.length} control(s)`
      : `does not assert: ${missingControls.join(', ')}`,
  });

  // 7 — declared specialty sections
  const sections = pack as unknown as Record<string, unknown>;
  const declaredSections: string[] = [];
  const missingSections: string[] = [];
  for (const key of EXPECTED_SECTIONS) {
    const value = sections[key];
    const present = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (present) declaredSections.push(key);
    else missingSections.push(key);
  }

  if (isSubstrate) {
    // The substrate supplies no specialty sections by definition.
    checks.push({
      id: 'specialty-sections',
      label: 'Specialty sections',
      status: 'pass',
      detail: 'not applicable to the substrate pack',
    });
  } else {
    checks.push({
      id: 'specialty-sections',
      label: 'Specialty sections',
      status: missingSections.length === 0 ? 'pass' : 'warn',
      detail: missingSections.length === 0
        ? `declares ${declaredSections.join(', ')}`
        : `declares ${declaredSections.length}/${EXPECTED_SECTIONS.length} — missing ${missingSections.join(', ')}`,
    });
  }

  const failed = checks.some((c) => c.status === 'fail');
  const warned = checks.some((c) => c.status === 'warn');
  const level: ConformanceLevel = isSubstrate
    ? 'substrate'
    : failed
      ? 'nonconformant'
      : warned
        ? 'partial'
        : 'conformant';

  return {
    packId: pack.id,
    version: pack.version,
    contractVersion: SPECIALTY_CONTRACT_VERSION,
    level,
    usable: !failed,
    checks,
    declaredSections,
    missingSections,
  };
}

export interface ConformanceMatrix {
  readonly contractVersion: string;
  readonly total: number;
  readonly byLevel: Record<ConformanceLevel, number>;
  readonly packs: readonly PackConformanceReport[];
}

/** Run the contract over the whole installed set, in a stable order. */
export function conformanceMatrix(packs: readonly (DomainPack & SpecialtySections)[]): ConformanceMatrix {
  const reports = [...packs]
    .map((p) => validateSpecialtyPack(p))
    .sort((a, b) => a.packId.localeCompare(b.packId));

  const byLevel: Record<ConformanceLevel, number> = { substrate: 0, conformant: 0, partial: 0, nonconformant: 0 };
  for (const r of reports) byLevel[r.level] += 1;

  return { contractVersion: SPECIALTY_CONTRACT_VERSION, total: reports.length, byLevel, packs: reports };
}

export interface PlatformBoundary {
  readonly contractVersion: string;
  readonly substratePackId: string;
  readonly platform: readonly BoundaryItem[];
  readonly pack: readonly BoundaryItem[];
}

/** The boundary as data, so the console renders the contract, not a copy of it. */
export function platformBoundary(): PlatformBoundary {
  return {
    contractVersion: SPECIALTY_CONTRACT_VERSION,
    substratePackId: SUBSTRATE_PACK_ID,
    platform: PLATFORM_RESPONSIBILITIES,
    pack: PACK_RESPONSIBILITIES,
  };
}

/** True when an installed pack may be activated (no failing contract check). */
export function packUsable(pack: DomainPack & SpecialtySections): boolean {
  return validateSpecialtyPack(pack).usable;
}
