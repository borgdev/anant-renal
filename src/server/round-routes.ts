// The two round-level lenses: chair-side risk for the next session, and the diff
// since the last one. They live in one module because they answer the two halves of
// the same question — "before I sit down, who needs me?" and "since I last sat
// down, what moved?" — and because both must read the SAME patient windows and the
// SAME severity rules the pack pages read.
//
// Both are READ-ONLY over the clinical state except for closing a round, which
// writes one durable snapshot and nothing else.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RealmRegistry } from '../realm/registry.js';
import { buildRenalCohort, renalPatientInputs, type RenalPatientInput } from '../swarm/renal-cohort.js';
import { liveFluidWindows } from './fluid-routes.js';
import { fluidRecommend, type FluidPatientWindow } from '../swarm/fluid.js';
import { nextSessionDigest, nextSessionRisk, type NextSessionDigest } from '../swarm/next-session.js';
import { diffRounds, snapshotRound, type RoundDigest, type RoundSnapshot } from '../swarm/round-digest.js';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface RoundRouteOptions {
  /** Patient source, injectable so tests can drive a fixed cohort. */
  patients?: (() => RenalPatientInput[]) | undefined;
  /** Fluid windows, injectable so tests do not need a live realm. */
  windows?: (() => Array<FluidPatientWindow & { facilityId?: string | undefined; dryWeightSource?: string }>) | undefined;
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/** Cap the response so a large fleet cannot turn the lens into a wall of rows. */
const LENS_LIMIT = 60;

export async function registerRoundRoutes(app: FastifyInstance, opts: RoundRouteOptions = {}): Promise<void> {
  const patientSource = opts.patients ?? (() => renalPatientInputs(RealmRegistry.list()));
  const windowSource = opts.windows ?? (() => liveFluidWindows(patientSource()));
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  /* ---------------- 3.2 · the next session, chair-side ---------------- */

  const buildLens = (limit: number): NextSessionDigest => {
    const rows = windowSource().map((w) => nextSessionRisk(fluidRecommend(w), {
      ...(w.facilityId !== undefined ? { facilityId: w.facilityId } : {}),
      ...(w.dryWeightSource !== undefined ? { dryWeightSource: w.dryWeightSource } : {}),
    }));
    return nextSessionDigest(rows, { limit });
  };

  app.get('/admin/swarm/next-session', async () => {
    const digest = buildLens(LENS_LIMIT);
    return {
      generatedAt: NOW(),
      horizon: 'next session',
      ...digest,
    };
  });

  /**
   * One patient's lens detail. Deliberately rebuilt from the same window the list
   * used — reading it from a cached row would let the detail and the row disagree
   * after the fleet moved on.
   */
  app.get<{ Params: { patientId: string } }>('/admin/swarm/next-session/:patientId', async (request, reply) => {
    const w = windowSource().find((x) => x.patientId === request.params.patientId);
    if (!w) return error(reply, 404, 'patient-window-not-found');
    const risk = nextSessionRisk(fluidRecommend(w), {
      ...(w.facilityId !== undefined ? { facilityId: w.facilityId } : {}),
      ...(w.dryWeightSource !== undefined ? { dryWeightSource: w.dryWeightSource } : {}),
    });
    return { generatedAt: NOW(), risk };
  });

  /* ---------------- 3.3 · since your last round ---------------- */

  const currentSnapshot = (takenBy: string): RoundSnapshot => {
    const { patients } = buildRenalCohort(patientSource());
    return snapshotRound(patients, { takenBy, takenAt: NOW() });
  };

  /** What the digest WOULD say right now, without recording a round. */
  app.get('/admin/swarm/rounds/current', async () => {
    const snapshot = currentSnapshot('unrecorded');
    return { generatedAt: NOW(), takenAt: snapshot.takenAt, patients: snapshot.patients.length, snapshot };
  });

  app.get('/admin/swarm/rounds', async () => {
    const rounds = await ws().listRoundSnapshots();
    return {
      count: rounds.length,
      rounds: rounds.map((r) => ({
        id: r.id,
        takenAt: r.takenAt,
        takenBy: r.takenBy,
        patients: r.snapshot.patients.length,
        worstStatus: r.snapshot.patients.filter((p) => p.worstStatus === 'red').length,
      })),
    };
  });

  /**
   * Close the round: record the fleet exactly as it stands, as the baseline the
   * NEXT digest will be measured against. `takenBy` scopes the baseline, so a
   * clinician comparing against their own last round is not diffed against a
   * colleague's.
   */
  app.post<{ Body: { takenBy?: string } }>('/admin/swarm/rounds/close', async (request, reply) => {
    const takenBy = (request.body ?? {}).takenBy?.trim() || 'operator';
    const snapshot = currentSnapshot(takenBy);
    const saved = await ws().saveRoundSnapshot({ takenAt: snapshot.takenAt, takenBy, snapshot });
    return {
      round: { id: saved.id, takenAt: saved.takenAt, takenBy: saved.takenBy, patients: saved.snapshot.patients.length },
    };
  });

  /**
   * The digest. `?by=` scopes the baseline to one clinician's last round; omitting
   * it compares against the most recent round by anyone. With no baseline at all it
   * returns `baseline: null` and says so — never an empty diff that reads as calm.
   */
  app.get<{ Querystring: { by?: string; limit?: string } }>('/admin/swarm/rounds/digest', async (request) => {
    const by = request.query?.by?.trim();
    const limit = Math.max(1, Math.min(500, Number(request.query?.limit ?? 60) || 60));
    const store = ws();
    const previous = await store.latestRoundSnapshot(by && by.length > 0 ? by : undefined);
    const { patients } = buildRenalCohort(patientSource());
    const after = snapshotRound(patients, { takenBy: by ?? 'unrecorded', takenAt: NOW() });
    const digest: RoundDigest = diffRounds(previous?.snapshot ?? null, after, patients, { limit });
    return {
      generatedAt: NOW(),
      baseline: previous ? { id: previous.id, takenAt: previous.takenAt, takenBy: previous.takenBy } : null,
      scopedTo: by ?? null,
      ...digest,
      movements: digest.movements.slice(0, limit),
    };
  });
}
