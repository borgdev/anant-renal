import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("public authority registry contains only labeled real HTTPS sources", async () => {
  const sources = await json("config/public-sources.json");
  const allowedAuthorities = ["cms.gov", "data.cms.gov", "eqrs.cms.gov", "cdc.gov", "niddk.nih.gov", "healthit.gov"];
  assert.ok(sources.length >= 8);
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  for (const source of sources) {
    assert.equal(source.synthetic, false, `${source.id} must be labeled as a real public source`);
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.ok(allowedAuthorities.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)), `${source.id} must use an approved public authority domain`);
    assert.match(source.effectiveFrom, /^20\d{2}-\d{2}-\d{2}$/);
    assert.ok(source.refresh);
  }
});

test("every measure pack resolves authority sources and separates proposed logic", async () => {
  const [sources, packs] = await Promise.all([json("config/public-sources.json"), json("config/measure-packs.json")]);
  const sourceIds = new Set(sources.map((source) => source.id));
  assert.ok(packs.length >= 7);
  for (const pack of packs) {
    assert.ok(pack.version && pack.owner && pack.inputEvents.length > 0);
    assert.ok(pack.sourceIds.every((sourceId) => sourceIds.has(sourceId)), `${pack.id} references an unknown authority source`);
    if (pack.status.includes("proposed")) assert.match(pack.version, /proposed/i);
    if (pack.status.startsWith("active")) assert.ok(!pack.status.includes("proposed"));
  }
});

test("bounded cells have action allowlists, evaluation gates and kill switches", async () => {
  const cells = await json("config/agent-manifests.json");
  assert.ok(cells.length >= 12);
  for (const cell of cells) {
    assert.ok(cell.inputs.length && cell.outputs.length && cell.allowedActions.length);
    assert.ok(["A", "B", "C", "D"].includes(cell.approvalClass));
    assert.ok(cell.evalGate >= 0.9 && cell.evalGate <= 1);
    assert.equal(cell.killSwitch, true);
    assert.ok(cell.allowedActions.every((action) => !/(prescribe|diagnose|submit-live|change-order)/i.test(action)));
  }
});

test("enterprise hierarchy, role cockpits and ecosystem domains are configuration-driven", async () => {
  const [model, cells, demo] = await Promise.all([
    json("config/enterprise-operating-model.json"),
    json("config/agent-manifests.json"),
    json("config/ecosystem-demo.json"),
  ]);
  assert.equal(model.synthetic, true);
  assert.deepEqual(model.scopePath.map((scope) => scope.level), ["enterprise", "division", "region", "market", "facility"]);
  const roleIds = new Set(model.roles.map((role) => role.id));
  for (const requiredRole of ["evp", "dvp", "rod", "fa", "medical", "quality", "finance", "biomed"]) assert.ok(roleIds.has(requiredRole));
  const cellIds = new Set(cells.map((cell) => cell.id));
  for (const domain of model.domains) {
    assert.ok(domain.ownerRoles.every((role) => roleIds.has(role)), `${domain.id} references an unknown role`);
    assert.ok(domain.agentIds.every((cell) => cellIds.has(cell)), `${domain.id} references an unknown cell`);
  }
  assert.equal(demo.synthetic, true);
  assert.ok(demo.nextBestActions.length >= 7);
  assert.ok(demo.messages.length >= 10);
  assert.ok(demo.swarmInsights.every((insight) => insight.agentIds.length >= 2));
  for (const action of demo.nextBestActions) assert.ok(action.agentIds.every((cell) => cellIds.has(cell)), `${action.id} references an unknown cell`);
});

test("red-team suite covers event, isolation, model and regulatory failures", async () => {
  const scenarios = await json("config/red-team-scenarios.json");
  assert.ok(scenarios.length >= 8);
  const corpus = scenarios.map((scenario) => `${scenario.name} ${scenario.attack} ${scenario.control}`).join(" ").toLowerCase();
  for (const required of ["prompt injection", "cross-patient", "duplicate kafka", "late correction", "stale cms", "unsafe clinical", "measure logic drift", "model provider outage"]) {
    assert.ok(corpus.includes(required), `missing adversarial coverage: ${required}`);
  }
});

test("durable assurance ledger is declared and migrated", async () => {
  const hosting = await json(".openai/hosting.json");
  assert.equal(hosting.d1, "DB");
  const schema = await readFile(new URL("db/schema.ts", root), "utf8");
  const migration = await readFile(new URL("drizzle/0000_productive_mandroid.sql", root), "utf8");
  for (const table of ["audit_events", "evaluation_runs", "configuration_releases", "authority_snapshots"]) {
    assert.match(schema, new RegExp(table));
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``));
  }
});

test("runtime ledger, evidence review and leased Kafka outbox are migrated", async () => {
  const schema = await readFile(new URL("db/schema.ts", root), "utf8");
  const runtimeMigration = await readFile(new URL("drizzle/0001_aberrant_satana.sql", root), "utf8");
  const reviewMigration = await readFile(new URL("drizzle/0002_polite_black_widow.sql", root), "utf8");
  const leaseMigration = await readFile(new URL("drizzle/0003_curly_madame_web.sql", root), "utf8");
  const authorityIndexMigration = await readFile(new URL("drizzle/0004_ambiguous_black_tom.sql", root), "utf8");
  for (const table of ["event_envelopes", "evidence_objects", "temporal_states", "topology_nodes", "topology_edges", "outcome_episodes", "agent_executions", "agent_proposals", "swarm_insights", "next_best_actions", "policy_evaluations", "commands", "acknowledgements", "event_outbox", "trace_spans", "measure_results", "submission_packages", "model_registry", "drift_snapshots", "incidents", "role_assignments", "knowledge_notes", "knowledge_note_versions", "knowledge_comments"]) {
    assert.match(schema, new RegExp(table));
    assert.ok(runtimeMigration.includes(`CREATE TABLE \`${table}\``), `${table} must be created in the runtime migration`);
  }
  assert.ok(reviewMigration.includes("CREATE TABLE `evidence_reviews`"));
  assert.match(leaseMigration, /locked_by/);
  assert.match(leaseMigration, /locked_until/);
  assert.match(authorityIndexMigration, /authority_snapshot_source_effective_idx/);
});

test("ecosystem domain packs are disabled until activated through configuration gates", async () => {
  const domainPacks = await json("config/domain-packs.json");
  assert.ok(domainPacks.packs.length >= 11);
  assert.equal(domainPacks.defaultState, "disabled");
  assert.equal(domainPacks.packs.filter((pack) => pack.state === "reference-active").length, 1);
  for (const pack of domainPacks.packs) {
    assert.ok(pack.outcomes.length > 0);
    assert.ok(pack.events.every((event) => /\.v\d+$/.test(event)));
  }
});

test("Kafka bridge uses authenticated ingress, idempotent production and leased outbox receipts", async () => {
  const bridge = await readFile(new URL("services/kafka-bridge/src/index.mjs", root), "utf8");
  assert.match(bridge, /RUNTIME_ADAPTER_TOKEN/);
  assert.match(bridge, /idempotent: true/);
  assert.match(bridge, /allowAutoTopicCreation: false/);
  assert.match(bridge, /x-bridge-id/);
  assert.match(bridge, /\/api\/runtime\/outbox/);
});

test("demo copy states the synthetic operating-data boundary", async () => {
  const data = await readFile(new URL("lib/demo-data.ts", root), "utf8");
  assert.match(data, /All patient, treatment, staffing and operational records are synthetic/);
  assert.match(data, /Regulatory sources and labeled public benchmarks are authoritative public data snapshots/);
});

test("public benchmark snapshot is traceable and value-preserving", async () => {
  const snapshot = await json("config/public-benchmarks.json");
  assert.equal(snapshot.sourceId, "cms-provider-data");
  assert.equal(snapshot.verificationStatus, "verified-live");
  assert.match(snapshot.rowSetSha256, /^[a-f0-9]{64}$/);
  assert.ok(snapshot.benchmarks.length >= 6);
  for (const benchmark of snapshot.benchmarks) {
    assert.ok(benchmark.measureId && Number.isFinite(benchmark.rawValue));
    assert.ok(benchmark.value && benchmark.label);
  }
});

test("versioned integration and outcome schemas are present", async () => {
  for (const file of ["canonical-event.schema.json", "assessment-evidence.schema.json", "outcome-episode.schema.json", "agent-manifest.schema.json", "enterprise-operating-model.schema.json", "next-best-action.schema.json", "swarm-insight.schema.json"]) {
    const schema = await json(`contracts/${file}`);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /\/1\.0\.0$/);
    assert.ok(schema.required.length > 0);
    assert.equal(schema.additionalProperties, false);
  }
  const asyncapi = await readFile(new URL("contracts/asyncapi.yaml", root), "utf8");
  assert.match(asyncapi, /asyncapi: 3\.0\.0/);
  assert.match(asyncapi, /assessment\.response\.v1/);
  assert.match(asyncapi, /coordinator\.task\.requested\.v1/);
  assert.match(asyncapi, /policy\.blocked\.v1/);
  assert.match(asyncapi, /staffing\.coverage\.changed\.v1/);
  assert.match(asyncapi, /facility\.capacity\.changed\.v2/);
  assert.match(asyncapi, /swarm\.insight\.published\.v1/);
  assert.match(asyncapi, /nba\.review\.requested\.v1/);
});

test("cockpit interactions resolve into a shared work-item detail and durable human handoff", async () => {
  const cockpitFiles = [
    "swarm-control.tsx",
    "command-cockpit.tsx",
    "patient-intelligence.tsx",
    "assessment-intelligence.tsx",
    "intelligence-workspace.tsx",
    "facility-twin.tsx",
    "cms-control.tsx",
    "executive-outcomes.tsx",
    "assurance-center.tsx",
    "configuration-studio.tsx",
  ];
  for (const file of cockpitFiles) {
    const source = await readFile(new URL(`app/components/${file}`, root), "utf8");
    assert.match(source, /onOpenDetail/, `${file} must expose the shared drill-down contract`);
  }
  const drawer = await readFile(new URL("app/components/workflow-detail-drawer.tsx", root), "utf8");
  for (const section of ["Overview", "Evidence", "Activity", "Closed-loop state"]) assert.ok(drawer.includes(section));
  const runtimeApi = await readFile(new URL("app/api/runtime/route.ts", root), "utf8");
  const runtimeEngine = await readFile(new URL("lib/runtime/engine.ts", root), "utf8");
  assert.match(runtimeApi, /request-review/);
  assert.match(runtimeEngine, /requestRuntimeReview/);
  assert.match(runtimeEngine, /request-human-review/);
});
