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

// Vendor certification (Phase 2) — what we may claim about a vendor, and what
// we may not.
//
// The distinction this module exists to enforce:
//
//   A run against our own CONFORMANCE DOUBLE proves our client. It proves the
//   auth flow signs correctly, the negotiator reconciles a profile against a
//   real CapabilityStatement, and the degradation ladder engages when a vendor
//   refuses a write. It proves NOTHING about the vendor, because we wrote both
//   sides of the conversation.
//
//   Only a run against a real sandbox certifies a vendor.
//
// That is why `verdict` has four values rather than two, and why
// `sandboxCertifiedVendors` deliberately excludes a double run. The platform's
// fail-closed write check consumes that list, so conflating the two would let a
// `bound` write path — a path that writes to a patient's chart — go live on the
// strength of our own test double.
//
// The judgement here is pure: the route performs the probe, this decides what
// the probe means. That keeps the meaning testable without a sandbox account.

import type { CapabilityReport, FlowAssessment } from './capability.js';
import type { VendorId } from './vendor-profile.js';

/** How the result was obtained. `double` is our server, never the vendor's. */
export type CertificationMode = 'sandbox' | 'double' | 'not-run';

/**
 * What we are entitled to claim.
 *
 *  certified         — a real sandbox run with every essential flow available
 *  harness-verified  — our client is correct; the VENDOR remains unproven
 *  failed            — a probe ran and an essential flow is unavailable
 *  not-run           — nothing was probed, or nothing could be
 */
export type CertificationVerdict = 'certified' | 'harness-verified' | 'failed' | 'not-run';

/** One step of the probe, kept verbatim so the evidence is inspectable. */
export interface CertificationStep {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly detail: string;
}

export interface VendorCertification {
  readonly vendor: VendorId;
  readonly mode: CertificationMode;
  readonly verdict: CertificationVerdict;
  readonly ranAt: string;
  /** One line an operator can act on. */
  readonly headline: string;
  /** Essential flows the server did not offer. Empty means nothing blocked. */
  readonly essentialBlocked: readonly string[];
  /** Proposal flows that had to descend the ladder. Expected, not a failure. */
  readonly degraded: readonly string[];
  readonly flows: readonly FlowAssessment[];
  readonly steps: readonly CertificationStep[];
  /** Present whenever the verdict is not a certification. */
  readonly blockedReason?: string;
  readonly server: {
    readonly softwareName?: string;
    readonly fhirVersion?: string;
    readonly resourceTypes: number;
  };
  readonly requestCount: number;
  /** True when the vendor profile claimed support the server did not have. */
  readonly profileOverstates: boolean;
}

export interface CertificationInput {
  readonly vendor: VendorId;
  readonly mode: CertificationMode;
  readonly ranAt: string;
  /** Absent when no probe ran, which forces a `not-run` verdict. */
  readonly report?: CapabilityReport;
  readonly steps?: readonly CertificationStep[];
  readonly requestCount?: number;
  /** False when the probe itself failed, even if a report was produced. */
  readonly contractOk?: boolean;
  /** Why no probe ran. Required to explain a `not-run` verdict. */
  readonly blockedReason?: string;
}

const NO_SERVER = { resourceTypes: 0 } as const;

/**
 * Turn a probe into the claim we are entitled to make.
 *
 * A missing report is not a pass and not a failure — it is an absence of
 * evidence, and it says so.
 */
export function buildVendorCertification(input: CertificationInput): VendorCertification {
  const steps = input.steps ?? [];
  const requestCount = input.requestCount ?? 0;
  const report = input.report;

  if (!report) {
    return {
      vendor: input.vendor,
      mode: input.mode === 'sandbox' ? 'sandbox' : input.mode,
      verdict: 'not-run',
      ranAt: input.ranAt,
      headline: `not run — ${input.blockedReason ?? 'no probe was performed'}`,
      essentialBlocked: [],
      degraded: [],
      flows: [],
      steps,
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      server: NO_SERVER,
      requestCount,
      profileOverstates: false,
    };
  }

  const essentialBlocked = report.essentialBlocked;
  const degraded = report.flows.filter((f) => f.verdict === 'degraded').map((f) => f.flow.id);
  const contractOk = input.contractOk ?? true;
  const failed = essentialBlocked.length > 0 || !contractOk;

  // A double run can reach 'harness-verified' and no further. Reaching for
  // 'certified' here would be the whole defect this module exists to prevent.
  const verdict: CertificationVerdict = failed
    ? 'failed'
    : input.mode === 'sandbox'
      ? 'certified'
      : 'harness-verified';

  const headline = verdict === 'certified'
    ? `certified against the real sandbox — all essential flows available${degraded.length > 0 ? ` (${degraded.length} proposal flow(s) degrade)` : ''}`
    : verdict === 'harness-verified'
      ? `client verified against our own conformance double — the VENDOR is NOT certified`
      : essentialBlocked.length > 0
        ? `${essentialBlocked.length} essential flow(s) unavailable: ${essentialBlocked.join(', ')}`
        : 'the probe did not complete';

  const blockedReason = verdict === 'harness-verified'
    ? 'a double run proves our client, not the vendor. Point this at a real sandbox to certify.'
    : verdict === 'failed'
      ? (essentialBlocked.length > 0
        ? `essential flows unavailable: ${essentialBlocked.join(', ')}`
        : 'the probe did not complete')
      : undefined;

  return {
    vendor: input.vendor,
    mode: input.mode,
    verdict,
    ranAt: input.ranAt,
    headline,
    essentialBlocked,
    degraded,
    flows: report.flows,
    steps,
    ...(blockedReason ? { blockedReason } : {}),
    server: {
      ...(report.server.softwareName ? { softwareName: report.server.softwareName } : {}),
      ...(report.server.fhirVersion ? { fhirVersion: report.server.fhirVersion } : {}),
      resourceTypes: report.accuracy.discoveredCount,
    },
    requestCount,
    profileOverstates: report.accuracy.profileOverstates,
  };
}

/** Vendors we expect a position on, whether or not a probe has run. */
export const CERTIFIABLE_VENDORS: readonly VendorId[] = ['epic', 'cerner', 'athena', 'generic'];

/**
 * The vendors whose SANDBOX certification is recorded.
 *
 * A `harness-verified` record is deliberately excluded. This list feeds the
 * platform's fail-closed write check, so admitting a double run here would let a
 * live write path be enabled by our own test double.
 */
export function sandboxCertifiedVendors(records: readonly VendorCertification[]): string[] {
  return records.filter((r) => r.verdict === 'certified').map((r) => r.vendor);
}

export interface CertificationMatrix {
  readonly total: number;
  readonly certified: number;
  readonly harnessVerified: number;
  readonly failed: number;
  readonly notRun: number;
  /** One row per certifiable vendor, so an absence is visible rather than implied. */
  readonly vendors: readonly VendorCertification[];
  readonly sandboxCertified: readonly string[];
  /** Ready to leave shadow mode: at least one vendor is genuinely certified. */
  readonly anyCertified: boolean;
  readonly headline: string;
}

/** A row for a vendor nobody has probed. Silence must not read as success. */
function notRunRow(vendor: VendorId, ranAt: string): VendorCertification {
  return {
    vendor,
    mode: 'not-run',
    verdict: 'not-run',
    ranAt,
    headline: 'not run — no certification has been recorded for this vendor',
    essentialBlocked: [],
    degraded: [],
    flows: [],
    steps: [],
    blockedReason: 'no certification has been recorded for this vendor',
    server: NO_SERVER,
    requestCount: 0,
    profileOverstates: false,
  };
}

/**
 * Roll records up per vendor.
 *
 * Every certifiable vendor gets a row even with no record, because a matrix that
 * simply omits the untested vendors is the one an operator misreads as complete.
 */
export function certificationMatrix(
  records: readonly VendorCertification[],
  ranAt: string,
): CertificationMatrix {
  const latest = new Map<VendorId, VendorCertification>();
  for (const r of records) {
    const prior = latest.get(r.vendor);
    if (!prior || r.ranAt >= prior.ranAt) latest.set(r.vendor, r);
  }
  const vendors = CERTIFIABLE_VENDORS.map((v) => latest.get(v) ?? notRunRow(v, ranAt));

  const certified = vendors.filter((v) => v.verdict === 'certified').length;
  const harnessVerified = vendors.filter((v) => v.verdict === 'harness-verified').length;
  const failed = vendors.filter((v) => v.verdict === 'failed').length;
  const notRun = vendors.filter((v) => v.verdict === 'not-run').length;

  const headline = certified > 0
    ? `${certified} vendor(s) sandbox-certified`
    : harnessVerified > 0
      ? `no vendor is sandbox-certified — ${harnessVerified} verified against our own double only`
      : failed > 0
        ? `${failed} vendor(s) failed certification`
        : 'no vendor has been certified';

  return {
    total: vendors.length,
    certified,
    harnessVerified,
    failed,
    notRun,
    vendors,
    sandboxCertified: vendors.filter((v) => v.verdict === 'certified').map((v) => v.vendor),
    anyCertified: certified > 0,
    headline,
  };
}
