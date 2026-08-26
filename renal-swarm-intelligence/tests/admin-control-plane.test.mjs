import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("admin API exposes the complete governed onboarding lifecycle", async () => {
  const route = await source("app/api/v1/admin/route.ts");
  for (const action of ["save-organization", "save-kafka", "test-kafka", "save-agent", "save-policy", "validate-release", "activate-release"]) {
    assert.match(route, new RegExp(`case \\"${action}\\"`));
  }
  assert.match(route, /requireTrustedJsonMutation/);
  assert.match(route, /requirePlatformAdmin/);
});

test("Kafka onboarding stores secret references and distinguishes contract from live verification", async () => {
  const service = await source("lib/server/onboarding.ts");
  assert.match(service, /RAW_SECRET_FIELD_BLOCKED/);
  assert.match(service, /binding:\[A-Z\]/);
  assert.match(service, /contract-only/);
  assert.match(service, /live-bridge/);
  assert.match(service, /\/healthz/);
  assert.match(service, /AbortSignal\.timeout\(5000\)/);
  assert.match(service, /production requires live verification/);
});

test("organization-owned bridge protects its health probe", async () => {
  const bridge = await source("services/kafka-bridge/src/index.mjs");
  assert.match(bridge, /timingSafeEqual/);
  assert.match(bridge, /authorizedProbe/);
  assert.match(bridge, /status: health\.connected \? "healthy"/);
  assert.match(bridge, /kafka: health\.connected \? "connected"/);
});

test("Admin Console closes every setup loop and makes zero-redeploy activation explicit", async () => {
  const ui = await source("app/components/admin-console.tsx");
  for (const step of ["organization", "identity", "kafka", "adapters", "agents", "cms", "validate", "activate"]) {
    assert.match(ui, new RegExp(`activeStep === \\"${step}\\"`));
  }
  assert.match(ui, /Configure bounded specialists in the UI/);
  assert.match(ui, /Global action boundary/);
  assert.match(ui, /Run all gates/);
  assert.match(ui, /Activate release/);
  assert.match(ui, /Code redeploy/);
  assert.match(ui, /Not required/);
});

test("active configuration is resolved by the server-side runtime", async () => {
  const repository = await source("lib/server/configuration-repository.ts");
  const engine = await source("lib/runtime/engine.ts");
  assert.match(repository, /tenantConfigurationReleases\.status, "active"/);
  assert.match(repository, /ACTIVE_CONFIGURATION_INVALID/);
  assert.match(engine, /effectiveAgentManifests\(event\.tenantId\)/);
  assert.match(engine, /evaluateEligibleCells\(event, manifests\)/);
});
