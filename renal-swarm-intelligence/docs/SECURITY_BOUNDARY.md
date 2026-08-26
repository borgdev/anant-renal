# Frontend, backend and configuration security boundary

## Decision

Renal Swarm Intelligence is decoupled into an untrusted operator UI, a same-origin BFF, server-only control-plane services, a durable runtime ledger and an organization-owned Kafka bridge. The browser is a renderer and intent collector; it is never an authority, evidence assembler, policy engine or Kafka client.

This boundary increases security because identity, role/scope checks, patient-evidence redaction, active configuration resolution, policy decisions, commands and secret access stay on the server. It also keeps the frontend replaceable: the public OpenAPI and event contracts can support another web client, mobile client or separately deployed control plane without moving decision logic into the browser.

## Trust zones

| Zone | May do | Must never do |
|---|---|---|
| Operator UI | Send identifiers, edits and intended actions; render safe projections | Assert authority, assemble patient evidence, hold secrets, issue Kafka commands |
| Same-origin BFF | Enforce request shape, size, origin and no-store responses | Trust client-supplied roles or patient facts as authoritative |
| Control plane | Resolve identity, role, scope, purpose, configuration, redaction and release gates | Bypass organization approvals or expose binding values |
| Runtime ledger | Persist canonical events, evidence, executions, policy, commands, acknowledgements and audit | Accept unversioned/unscoped events or mutable provenance |
| Kafka bridge | Consume canonical topics, publish leased commands, report receipts and authenticated health | Approve actions, invent roles, auto-create topics, log credentials |

## Request controls

- Mutations require `application/json`, same-site/origin context and bounded request size.
- Operator identity comes from the hosted workspace boundary. Synthetic role delegation is labeled and restricted to the reference operating model.
- Platform administration requires DVP or EVP authority. Adapter identities cannot administer releases.
- Work-item drill-downs send only an identifier, entity kind and intended target. The server reconstructs the permitted context.
- Patient-authored exact text is removed for roles without patient evidence-review authority.
- Failed authorization or context assembly returns a blocked state; the UI does not fall back to client-assembled evidence.
- Responses use private no-store caching, MIME sniffing protection and no-referrer policy.

## Secret handling

Platform Admin accepts a binding reference such as `binding:KAFKA_BRIDGE_TOKEN`. It recursively rejects fields named like passwords, tokens, secrets, API keys or private keys. A live bridge probe resolves the referenced binding only inside the server runtime and sends it over HTTPS. Neither the secret value nor an authorization header is returned to the UI or persisted in D1.

The bridge protects `/healthz` with a constant-time bearer-token comparison. A healthy result requires both the bridge process and Kafka connection. Reserved `.example` URLs produce an explicitly labeled contract-only result and never claim broker connectivity.

## Configuration activation

Draft objects are immutable-by-release and content addressed. Schema, green, red, integration and promotion suites persist their checks, score and evidence hash against the release. Only a validated release can become active. New event executions resolve active agent manifests and the action-boundary policy from the server database; no code or frontend bundle is redeployed. The prior active release is retained as the rollback target.

Production mode additionally requires live Kafka bridge verification. External writes remain disabled in the reference runtime even after configuration activation.

## Data portability

The hosted demo uses D1/SQLite through Drizzle. `db/control-plane.portable.sql` uses the common SQLite/PostgreSQL subset: text business keys, explicit timestamps, integer basis points/flags and validated JSON serialized as text. This keeps identifiers, lifecycles and API contracts stable when moving the control plane to PostgreSQL. Engine-specific operational tuning—JSONB indexes, row-level security, partitioning and managed key services—can be added during production deployment without changing the logical model.

## Remaining production gates

This reference boundary is not authorization to process PHI. Real deployment still requires organization IAM/HR role mapping, patient relationship and purpose-of-use policy, private network routes, secret rotation, encryption/key ownership, audit export, retention and legal-hold controls, BAA/vendor review, clinical safety validation, connector certification, performance/chaos evidence, incident response and rollback drills.
