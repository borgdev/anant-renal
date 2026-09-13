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

// OperationOutcome discipline (F0.5).
//
// Before this, every FHIR route answered a failure with an ad-hoc
// `{ error: 'some-string' }`. A client that speaks FHIR — which is every client
// we are building this for — cannot do anything with that: it cannot tell a
// validation problem from a permission problem, and it has no issue code to
// branch on.
//
// This module is the single place that decides what a FHIR failure LOOKS like,
// including the HTTP status, so the mapping is consistent across ingest, export,
// entity reads and the integration routes.

export type IssueSeverity = 'fatal' | 'error' | 'warning' | 'information';

/** The R4 `issue-type` codes we actually emit. */
export type IssueCode =
  | 'invalid'
  | 'structure'
  | 'required'
  | 'value'
  | 'invariant'
  | 'not-found'
  | 'not-supported'
  | 'conflict'
  | 'duplicate'
  | 'forbidden'
  | 'login'
  | 'not-allowed'
  | 'business-rule'
  | 'too-costly'
  | 'throttled'
  | 'timeout'
  | 'transient'
  | 'processing';

export interface OperationOutcomeIssue {
  severity: IssueSeverity;
  code: IssueCode;
  diagnostics?: string;
  expression?: string[];
  details?: { text?: string };
}

export interface OperationOutcome {
  resourceType: 'OperationOutcome';
  id?: string;
  issue: OperationOutcomeIssue[];
}

export interface IssueOptions {
  readonly severity?: IssueSeverity;
  readonly expression?: readonly string[];
  readonly id?: string;
  readonly text?: string;
}

/** Build an OperationOutcome with exactly one issue. */
export function operationOutcome(
  code: IssueCode,
  diagnostics?: string,
  opts: IssueOptions = {},
): OperationOutcome {
  const issue: OperationOutcomeIssue = {
    severity: opts.severity ?? (code === 'not-found' || code === 'forbidden' || code === 'login' ? 'error' : 'error'),
    code,
    ...(diagnostics ? { diagnostics } : {}),
    ...(opts.expression && opts.expression.length > 0 ? { expression: [...opts.expression] } : {}),
    ...(opts.text ? { details: { text: opts.text } } : {}),
  };
  return {
    resourceType: 'OperationOutcome',
    ...(opts.id ? { id: opts.id } : {}),
    issue: [issue],
  };
}

export function operationOutcomeFrom(issues: readonly OperationOutcomeIssue[], id?: string): OperationOutcome {
  return {
    resourceType: 'OperationOutcome',
    ...(id ? { id } : {}),
    issue: issues.length > 0 ? [...issues] : [{ severity: 'information', code: 'processing', diagnostics: 'No issues' }],
  };
}

/**
 * The R4 issue code → HTTP status mapping.
 *
 * A `login` issue is a 401 and a `forbidden` issue is a 403 — conflating them,
 * which an ad-hoc `{ error }` shape forces, tells a client to re-authenticate
 * when re-authenticating cannot possibly help.
 */
export function httpStatusForIssue(code: IssueCode): number {
  switch (code) {
    case 'invalid':
    case 'structure':
    case 'required':
    case 'value':
    case 'invariant':
      return 400;
    case 'login':
      return 401;
    case 'forbidden':
      return 403;
    case 'not-found':
      return 404;
    case 'not-supported':
      return 404;
    case 'not-allowed':
      return 405;
    case 'conflict':
    case 'duplicate':
      return 409;
    case 'business-rule':
      return 422;
    case 'too-costly':
    case 'throttled':
      return 429;
    case 'timeout':
    case 'transient':
      return 503;
    case 'processing':
    default:
      return 500;
  }
}

/**
 * An error that carries a FHIR-shaped failure. Throwing one of these from a
 * route means the handler does not have to remember the mapping.
 */
export class FhirOperationError extends Error {
  readonly outcome: OperationOutcome;
  readonly status: number;

  constructor(
    code: IssueCode,
    diagnostics: string,
    opts: IssueOptions & { readonly status?: number } = {},
  ) {
    super(diagnostics);
    this.name = 'FhirOperationError';
    this.outcome = operationOutcome(code, diagnostics, opts);
    this.status = opts.status ?? httpStatusForIssue(code);
  }
}

export function isFhirOperationError(err: unknown): err is FhirOperationError {
  return err instanceof FhirOperationError;
}

/**
 * Convert any thrown value into an `{ status, outcome }` pair.
 *
 * An unrecognised error becomes a 500 with the message, which is the honest
 * answer: we do not know what went wrong, and pretending it was the caller's
 * fault (a 400) sends them looking in the wrong place.
 */
export function errorToFhirReply(err: unknown): { status: number; outcome: OperationOutcome } {
  if (isFhirOperationError(err)) {
    return { status: err.status, outcome: err.outcome };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, outcome: operationOutcome('processing', message) };
}

/**
 * Extract the issues from a response body we received from another server, so a
 * downstream `OperationOutcome` can be surfaced rather than flattened to a
 * status code.
 */
export function issuesFromBody(body: unknown): readonly OperationOutcomeIssue[] {
  if (!body || typeof body !== 'object') return [];
  const oo = body as { resourceType?: unknown; issue?: unknown };
  if (oo.resourceType !== 'OperationOutcome' || !Array.isArray(oo.issue)) return [];
  return oo.issue
    .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
    .map((i) => {
      const severity = typeof i.severity === 'string' ? (i.severity as IssueSeverity) : 'error';
      const code = typeof i.code === 'string' ? (i.code as IssueCode) : 'processing';
      return {
        severity,
        code,
        ...(typeof i.diagnostics === 'string' ? { diagnostics: i.diagnostics } : {}),
      } satisfies OperationOutcomeIssue;
    });
}

/** A one-line summary of an outcome, for logs. Never includes PHI by construction. */
export function summarizeOutcome(outcome: OperationOutcome): string {
  const first = outcome.issue[0];
  if (!first) return 'no-issues';
  return `${first.severity}/${first.code}${first.diagnostics ? `: ${first.diagnostics}` : ''}`;
}
