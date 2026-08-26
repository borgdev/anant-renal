import { desc, eq } from "drizzle-orm";
import agentManifests from "../../../config/agent-manifests.json";
import domainPacks from "../../../config/domain-packs.json";
import measurePacks from "../../../config/measure-packs.json";
import operatingModel from "../../../config/enterprise-operating-model.json";
import publicSources from "../../../config/public-sources.json";
import runtimePolicy from "../../../config/runtime-policy.json";
import { getDb } from "../../../db";
import { configurationReleases, evaluationRuns } from "../../../db/schema";
import { requireAdapterOrOperator } from "../../../lib/runtime/authorization";
import { hashJson } from "../../../lib/runtime/crypto";
import { runRuntimeRedTeam } from "../../../lib/runtime/evals";
import { actorFromRequest, RUNTIME_CONFIGURATION } from "../../../lib/runtime/engine";

function statusFor(error: unknown) {
  const message = error instanceof Error ? error.message : "CONFIGURATION_ERROR";
  if (message === "AUTHENTICATION_REQUIRED") return 401;
  if (message.includes("AUTHORIZATION")) return 403;
  if (message.endsWith("_NOT_FOUND")) return 404;
  if (message.includes("no such table")) return 503;
  return 500;
}

export async function GET(request: Request) {
  try {
    const actor = actorFromRequest(request);
    requireAdapterOrOperator(actor, "simulate");
    const releases = await getDb().select().from(configurationReleases).orderBy(desc(configurationReleases.createdAt)).limit(20);
    return Response.json({ activeRuntimeConfiguration: RUNTIME_CONFIGURATION, releases });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Configuration query failed" }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const actor = actorFromRequest(request, typeof payload.roleId === "string" ? payload.roleId : undefined);
    requireAdapterOrOperator(actor, "knowledge");
    const action = typeof payload.action === "string" ? payload.action : "";
    const db = getDb();

    if (action === "create-draft") {
      const changeSetId = `CHG-${crypto.randomUUID()}`;
      const version = `renal-harness-2026.08.5-draft-${changeSetId.slice(-8)}`;
      const dossierHash = await configurationDossierHash({ state: "draft", changeSetId, createdBy: actor.email });
      const [release] = await db.insert(configurationReleases).values({ version, status: "draft", changeSetId, createdBy: actor.email, approvedBy: null, effectiveFrom: null, rollbackVersion: RUNTIME_CONFIGURATION, dossierHash }).returning();
      return Response.json({ release }, { status: 201 });
    }

    const version = typeof payload.version === "string" ? payload.version : "";
    const [release] = await db.select().from(configurationReleases).where(eq(configurationReleases.version, version)).limit(1);
    if (!release) throw new Error("CONFIGURATION_RELEASE_NOT_FOUND");

    if (action === "validate") {
      const results = [];
      for (let index = 1; index <= 8; index += 1) results.push(await runRuntimeRedTeam(`rt-${String(index).padStart(3, "0")}`));
      const passed = results.every((result) => result.passed);
      const dossierHash = await configurationDossierHash({ state: "validated", version, redTeamEvidence: results.map((result) => result.evidenceHash) });
      await db.update(configurationReleases).set({ status: passed ? "validated" : "draft", dossierHash }).where(eq(configurationReleases.version, version));
      await db.insert(evaluationRuns).values({ runId: `EVAL-${crypto.randomUUID()}`, suite: "contract", targetType: "configuration-release", targetVersion: version, scenarioId: null, status: passed ? "passed" : "failed", scoreBasisPoints: passed ? 10000 : 0, evidenceHash: dossierHash, configurationVersion: RUNTIME_CONFIGURATION });
      return Response.json({ release: { ...release, status: passed ? "validated" : "draft", dossierHash }, checks: results.flatMap((result) => result.checks), passed });
    }

    if (action === "request-approval") {
      if (!actor.syntheticDelegation || !["evp", "dvp"].includes(actor.role)) throw new Error("AUTHORIZATION_DENIED: DVP or EVP synthetic delegation is required in the reference environment");
      if (release.status !== "validated") throw new Error("AUTHORIZATION_DENIED: release must be validated before approval");
      await db.update(configurationReleases).set({ status: "approved", approvedBy: actor.email }).where(eq(configurationReleases.version, version));
      return Response.json({ release: { ...release, status: "approved", approvedBy: actor.email }, runtimeEffect: false, nextStep: "Organization promotion and canary workflow" });
    }

    return Response.json({ error: "Unsupported configuration action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Configuration action failed" }, { status: statusFor(error) });
  }
}

async function configurationDossierHash(extra: Record<string, unknown>) {
  return hashJson({ operatingModel, domainPacks, agentManifests, measurePacks, publicSources, runtimePolicy, extra });
}
