/******************************************************************************
 * Request parsing — what the API does with the bodies clients actually send.
 *
 * Fastify rejects `content-type: application/json` with a zero-length body as
 * FST_ERR_CTP_EMPTY_JSON_BODY (400). That is the default behaviour of a large
 * share of HTTP clients for a bodyless DELETE, so `DELETE /admin/cohorts/:id`
 * answered 400 to a well-formed request. It went unnoticed because the operator
 * console had never called that endpoint.
 *
 * The tolerance is narrow on purpose, and these tests pin both halves of it:
 * an empty body is `{}`, but a MALFORMED body is still the client's error and
 * must be a 400 rather than the 500 an unmarked parser error produces.
 ******************************************************************************/

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('request body parsing', () => {
  let app: App;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp({
      store: {
        async applyMigrations() { /* noop */ },
        async appendEvent() { /* noop */ },
        async queryEvents() { return []; },
        async ledgerAppend() { /* noop */ },
        async ledgerQuery() { return []; },
        async appendAudit() { /* noop */ },
        async queryAudit() { return []; },
        async recordFhirResource() { /* noop */ },
        async listFhirResources() { return []; },
      } as never,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => ({
        actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi',
        purposeOfUse: 'operations',
      }) as never,
      checkHealth: async () => ({ db: true, redis: true }),
      adminApiAuth: true,
      renalPatients: () => [],
    });
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    const raw = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
    cookie = `hh_session=${/hh_session=([^;]+)/.exec(raw)?.[1]}`;
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it('accepts a bodyless DELETE that declares a JSON content-type', async () => {
    // The client is not wrong here — this is what fetch/axios wrappers send.
    // The request must REACH the route: an unknown id is a 404, not a 400.
    const res = await app.inject({
      method: 'DELETE', url: '/admin/cohorts/no-such-cohort',
      headers: { cookie, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'cohort-not-found: no-such-cohort' });
  });

  it('still rejects a body a route requires, with the ROUTE\u2019s own error', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/cohorts',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '',
    });
    // the parser must not be the thing that answers — the route's validation is
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'id-required' });
  });

  it('reports malformed JSON as the client error it is', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/cohorts',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{"label": oops}',
    });
    // 500 would send an engineer to the logs for a typo in a request
    expect(res.statusCode).toBe(400);
  });

  it('parses a real body normally', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/cohorts',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { label: 'parsed' },
    });
    expect(res.statusCode).toBe(400);
    // got past parsing, failed on the missing id — which proves the body arrived
    expect(res.json()).toMatchObject({ error: 'id-required' });
  });
});
