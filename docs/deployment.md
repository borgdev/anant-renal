# AnantHealth — Docker deployment

Ships the AnantHealth operator console + API as a single container backed by
**Postgres** (event store) and **Redis** (BullMQ job bus), plus a persisted
`.harness` volume for the local SQLite store, knowledge base and measure store.

```
docker-compose.yml
Dockerfile
.dockerignore
.env.docker.example        → copy to .env
docs/deployment.md
```

## Services

| Container                | Image              | Purpose                                                        |
|--------------------------|--------------------|----------------------------------------------------------------|
| `anant-health-postgres`  | `postgres:16-alpine`| Event store — events, ledger, audit, FHIR mirror, idempotency  |
| `anant-health-redis`     | `redis:7-alpine`    | BullMQ job bus + outbox/broker durability                      |
| `anant-health-app`       | `anant-health/app`  | The server — public `/api/v1`, `/admin/*`, console at `/admin/ui/`, `/docs` |
| `anant-health-kafka`     | `bitnamilegacy/kafka:3.7` | **Optional** — alternate `kafka` broker/job-bus driver (profile). `bitnami/kafka:3.7` was removed upstream; `bitnamilegacy` is the same bitnami lineage so the `KAFKA_CFG_*` env and healthcheck are unchanged |

## Quick start

```bash
cp .env.docker.example .env   # then edit ANANT_DB_PASSWORD / ANANT_SIGNING_SECRET
docker compose up -d --build
```

Then:

- Console + API: <http://localhost:8080/admin/ui/>  (sign in with `admin` / `admin123` or a user you create)
- OpenAPI docs: <http://localhost:8080/docs>
- Health: <http://localhost:8080/health>

Stop / logs / rebuild:

```bash
docker compose down              # keep data (volumes persist)
docker compose logs -f anant-health-app
docker compose up -d --build     # rebuild after code changes
```

## Configuration (`.env`)

All `ANANT_*` variables are documented in `.env.docker.example`. Key ones:

| Variable | Default | Notes |
|----------|---------|-------|
| `ANANT_HTTP_PORT` | `8080` | Host port the console/API is published on |
| `ANANT_DB_USER/PASSWORD/NAME` | `anant` / … / `anant_health` | Postgres credentials (also used to build `HH_DATABASE_URL`) |
| `ANANT_DB_SCHEMA` | `harness` | Event-store schema |
| `ANANT_SIGNING_SECRET` | `change-me-in-production` | **Set a strong secret in production** |
| `ANANT_JOBBUS_DRIVER` | `bullmq` | `bullmq` (Redis) · `kafka` · `inprocess` |
| `ANANT_EVENTBROKER_DRIVER` | `inprocess` | `inprocess` · `kafka` · `redis-streams` · `bullmq` · `rabbitmq` · `nats` · `sqs-sns` · `pubsub` · `event-hubs` |
| `ANANT_STORAGE` | `sqlite` | Local SqlStore backend: `sqlite` (on `.harness` volume) or `postgres` |
| `ANANT_CORS_ORIGINS` | *(empty)* | Comma-separated CORS allowlist for the public API |

## Storage

- **Postgres** — `anant-health-pgdata` volume (event store, ledger, audit).
- **Redis** — `anant-health-redisdata` volume (AOF).
- **`.harness`** — `anant-health-harness` volume mounted at `/app/.harness`:
  SQLite SqlStore (`data/harness.db`), the knowledge store (`knowledge/`), the
  synced eCQM measure store (`measures/`), and realm snapshots. This is what
  keeps worlds, agents' local corpus, and measures across restarts.

To move the local SqlStore into Postgres, set `ANANT_STORAGE=postgres` (its
tables land in the connection's default schema, separate from the event-store
`schema`).

## Optional Kafka

```bash
docker compose --profile kafka up -d --build
```

Then in `.env`:

```dotenv
ANANT_JOBBUS_DRIVER=kafka
ANANT_EVENTBROKER_DRIVER=kafka
ANANT_KAFKA_BROKERS=anant-health-kafka:9092
```

> Other broker drivers (rabbitmq, nats, AWS SNS/SQS, GCP Pub/Sub, Azure Event
> Hubs) aren't shipped as compose services — point `HH_*` at your managed
> infrastructure instead.

## Build + run outside compose

```bash
npm ci
npm run build                 # tsc -p tsconfig.build.json → dist/
npm run start:prod            # node dist/src/server/prod.js
```

Requires env: `HH_DATABASE_URL`, `HH_REDIS_URL`, `HH_SIGNING_SECRET`
(see the existing `.env.example` for the full server env reference).

## Notes

- The image is multi-stage; the runtime stage has only production
  dependencies and runs as the `node` user.
- `admin-ui/`, `packs/*/agents/*.yaml` and `src/liquid/wasm/` are copied into
  the image because the server resolves them relative to the working directory.
- eCQM measures are **not** bundled — pull them from the console (Measures →
  *Sync eCQM store*) or mount a pre-seeded `/app/.harness/measures`.
- Default console users are seeded on boot: `admin/admin123`, `nurse/nurse123`,
  `auditor/audit123` — rotate them for real deployments.
