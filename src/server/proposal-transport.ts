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

/**
 * F9.2 — which wire a proposal actually travels down.
 *
 * This exists because the first cut of F9 published to an in-process emulator
 * unconditionally, which meant a "bound" proposal never touched the configured
 * EMR. The emulator is the right target for a DEMO and a test double; it is the
 * wrong target for a connection an operator configured.
 *
 * Resolution order, and the reason for it:
 *
 * 1. **A configured connection wins.** If an operator has configured an EMR and
 *    set a kind to `bound`, that is an explicit instruction to write to it.
 * 2. **Our own emulator endpoint**, when the configured base URL is `/fhir-mock`
 *    — i.e. the operator deliberately pointed the connection at the test double.
 * 3. **Nothing configured ⇒ no transport.** Resolution returns `none` and the
 *    publisher refuses. Fail closed: "we could not find anywhere to send it" must
 *    never be quietly satisfied by sending it somewhere else.
 */
import { FhirClient, FhirClientError } from '../fhir/client.js';
import { authConfigForConnection, createAuthProvider } from '../fhir/auth.js';
import type { AuthProviderContext } from '../fhir/auth.js';
import type { ProposalTransport } from '../fhir/proposal.js';
import type { FhirResource } from '../fhir/types.js';
import type { FhirIntegration } from '../swarm/workspace.js';
import type { FhirEmulator } from '../fhir/emulator.js';
import type { FetchLike } from '../fhir/http.js';

/** A status we may retry: the request was refused for a reason that can pass. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // transport failure — the server never answered
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The path an emulator-backed connection points at (see the `GET /fhir-mock/:type` route). */
export const EMULATOR_PATH_MARKER = '/fhir-mock';

export function isEmulatorConnection(baseUrl: string): boolean {
  return baseUrl.includes(EMULATOR_PATH_MARKER);
}

/**
 * A transport over the in-process emulator. No HTTP: the emulator is a data
 * structure, and `add()` upserts on (type, id) — which is exactly what makes the
 * deterministic resource id pay off.
 */
export function emulatorProposalTransport(emulator: FhirEmulator): ProposalTransport {
  return {
    async send({ resource, resourceId }) {
      emulator.add({ ...resource, id: (resource as { id?: string }).id ?? resourceId });
      return { ok: true, status: 200 };
    },
  };
}

/** A transport over a real FHIR server, authenticated per the connection's authMode. */
export function clientProposalTransport(input: {
  connection: FhirIntegration;
  authCtx: AuthProviderContext;
  fetch?: FetchLike;
}): ProposalTransport {
  const { connection, authCtx } = input;
  const client = new FhirClient({
    baseUrl: connection.baseUrl,
    ...(connection.authMode !== 'none'
      ? { auth: createAuthProvider(authConfigForConnection(connection), authCtx) }
      : {}),
    ...(connection.vendorHeaders ? { headers: connection.vendorHeaders } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });

  return {
    async send({ resource, resourceId }) {
      const payload = { ...resource, id: (resource as { id?: string }).id ?? resourceId } as FhirResource;
      try {
        // PUT on the deterministic id, so a retry UPDATES rather than creating a
        // second draft. `if-none-exist` is the belt-and-braces version for a
        // server that treats the id as advisory.
        await client.push(payload, { ifNoneExist: `${payload.resourceType}?identifier=${resourceId}` });
        return { ok: true, status: 200 };
      } catch (err) {
        if (err instanceof FhirClientError) {
          return {
            ok: false,
            ...(err.status !== undefined ? { status: err.status } : {}),
            error: err.message,
            retryable: isRetryableStatus(err.status),
          };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
      }
    },
  };
}

export type TransportResolution =
  | { kind: 'configured'; connectionId: string; label: string; baseUrl: string; transport: ProposalTransport }
  | { kind: 'emulator'; connectionId: string; label: string; baseUrl: string; transport: ProposalTransport }
  | { kind: 'none'; reason: string };

/**
 * Resolve the wire for a connection.
 *
 * `connection` is the stored connection, when one exists. `emulator` must be the
 * SAME emulator instance the `/fhir-mock` route serves from, or a "bound"
 * proposal would land in a data structure nobody can read back.
 */
export function resolveProposalTransport(input: {
  connection?: FhirIntegration | null;
  emulator?: FhirEmulator;
  authCtx?: AuthProviderContext;
  fetch?: FetchLike;
}): TransportResolution {
  const connection = input.connection;
  if (!connection || !connection.baseUrl) {
    return {
      kind: 'none',
      reason:
        'no EMR connection is configured, so there is nowhere to publish. ' +
        'Configure one at Platform → Integrations (F0); until then only `shadow` proposals are possible.',
    };
  }
  const label = connection.label || connection.baseUrl;

  if (isEmulatorConnection(connection.baseUrl)) {
    if (!input.emulator) {
      return { kind: 'none', reason: `connection "${label}" points at the emulator, but no emulator instance was supplied` };
    }
    return {
      kind: 'emulator',
      connectionId: connection.id,
      label,
      baseUrl: connection.baseUrl,
      transport: emulatorProposalTransport(input.emulator),
    };
  }

  if (!input.authCtx) {
    return { kind: 'none', reason: `connection "${label}" needs a credential context, which was not supplied` };
  }

  return {
    kind: 'configured',
    connectionId: connection.id,
    label,
    baseUrl: connection.baseUrl,
    transport: clientProposalTransport({
      connection,
      authCtx: input.authCtx,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
  };
}

/**
 * `writePolicy` for an effect kind, defaulting to `shadow`.
 *
 * Defaulting to `shadow` rather than `off` is deliberate: a newly configured
 * connection should immediately produce the proposals it *would* send, so the
 * clinical team can review them before anything is let out of the building.
 * An operator who has not made a decision has not authorised a write, and
 * `shadow` is the state that says exactly that.
 */
export function writePolicyFor(connection: FhirIntegration | undefined | null, effectKind: string): 'off' | 'shadow' | 'bound' {
  return connection?.writePolicy?.[effectKind] ?? 'shadow';
}

/**
 * The connection's authentication config — the SAME definition the contract test
 * uses, so the publish path cannot authenticate differently from the test that
 * declared the connection healthy.
 */
function authConfigFor(integration: FhirIntegration) {
  return authConfigForConnection(integration);
}
