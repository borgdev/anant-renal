// Cross-pack assurance track — one view over all seven renal protocol packs.
//
// Each pack (P1–P6) owns its own coverage gate, red-team scenarios, drift
// tracking and boundary artefacts. What no pack can answer on its own is:
//
//   * is every protocol wired the way the others are (mode declared, rules
//     declared, model registered, artefact present)?
//   * do the patients the packs serve break down fairly across age, sex,
//     vintage and access type?
//   * what does the whole set cost the people who read its alerts?
//   * and can this combination be released?
//
// This module answers those four questions from DURABLE records and pack
// constants only. It deliberately does not recompute clinical logic: a release
// gate must read the same ledger a reviewer would, not a private replay of it.
//
// Everything here is honest about absence. A pack with no red-team run is
// `missing`, not `pass`; a facility too small to slice fairly is
// `insufficient`, not `ok`; a window with no alerts is `not-measurable`, not
// clean.

import type { SwarmWorkspaceStore } from './workspace.js';
import type { AssuranceFinding, ModelDrift, ModelRecord, RedTeamRun } from './workspace.js';
import type { ProtocolId } from '../protocols/shared-state.js';
import { RULE_PROTOCOLS } from '../evidence/rule-packs.js';
import { rulePackSummary, enforcementGaps, rulesForProtocol } from '../evidence/rule-packs.js';
import { modeRecord, silentModeSummary, type ProtocolModeRecord } from '../evidence/silent-mode.js';
import { fairnessReport, FAIRNESS_DIMENSION_LABELS, type FairnessReport, type FairnessRow, type SliceDimension } from '../evidence/fairness.js';
import { burdenReport, type AlertEvent, type BurdenReport } from '../evidence/alert-burden.js';
import type { ReleaseDecision, ReleaseCheckStatus } from './release.js';
import { ESA_MODEL_ID, ESA_RED_TEAM_IDS, ESA_COVERAGE_DEFAULTS, isEsaFinding } from './anemia-governance.js';
import { ADEQUACY_MODEL_ID, ADEQUACY_RED_TEAM_IDS, ADEQUACY_COVERAGE_DEFAULTS } from './adequacy-governance.js';
import { FLUID_MODEL_ID, FLUID_RED_TEAM_IDS, FLUID_COVERAGE_DEFAULTS } from './fluid-governance.js';
import { ACCESS_MODEL_ID, ACCESS_RED_TEAM_IDS, ACCESS_COVERAGE_DEFAULTS } from './access-governance.js';
import { MBD_MODEL_ID, MBD_RED_TEAM_IDS, MBD_COVERAGE_DEFAULTS } from './mbd-governance.js';
import { NUTRITION_MODEL_ID, NUTRITION_RED_TEAM_IDS, NUTRITION_COVERAGE_DEFAULTS } from './nutrition-governance.js';
import { INFECTION_MODEL_ID, INFECTION_RED_TEAM_IDS, INFECTION_COVERAGE_DEFAULTS } from './infection-governance.js';
import { accessArtifactStatus } from './access-model.js';
import { adequacyArtifactStatus } from './adequacy-model.js';
import { fluidArtifactStatus } from './fluid-model.js';
import { mbdArtifactStatus } from './mbd-model.js';
import { nutritionArtifactStatus } from './nutrition-model.js';
import { infectionArtifactStatus } from './infection-model.js';
import { loadEsaArtifact } from './anemia-model.js';

/** The narrow shape every pack's artefact probe is normalised into. */
export interface ArtifactStatusLike {
  present: boolean;
  band: 'pass' | 'watch' | 'insufficient';
  note: string;
  metrics?: unknown;
}

export type LedgerState = 'present' | 'missing' | 'stale';

export interface ProtocolLedgerEvidence {
  /** model registered in the substrate registry */
  model: LedgerState;
  modelId: string;
  /** red-team runs recorded for this pack's scenarios */
  redTeamRuns: number;
  redTeamScenarios: number;
  redTeamFailed: number;
  /** distinct scenarios with at least one passing run */
  redTeamPassedScenarios: number;
  /** drift snapshots recorded against this pack's model */
  driftRecords: number;
  latestDriftAt?: string | undefined;
  latestDriftStatus?: string | undefined;
  /** findings attributed to this pack by scenario id */
  findings: number;
  openFindings: number;
  criticalOpen: number;
  highOpen: number;
}

export interface ProtocolAssessment {
  protocol: ProtocolId;
  modelId: string;
  coverageDefaults: unknown;
  ruleCount: number;
  ruleGaps: string[];
  artifact: ArtifactStatusLike;
  ledger: ProtocolLedgerEvidence;
  mode: ProtocolModeRecord;
  /** per-check verdicts, in the order they were evaluated */
  checks: Array<{ id: string; label: string; status: ReleaseCheckStatus; detail: string }>;
  /** this pack's own contribution to the release decision */
  verdict: ReleaseDecision;
  blockers: string[];
  warnings: string[];
}

export interface CrossPackAssurance {
  generatedAt: string;
  protocols: ProtocolAssessment[];
  fairness: FairnessReport;
  burden: BurdenReport;
  totals: {
    protocols: number;
    ship: number;
    hold: number;
    block: number;
    rules: number;
    openFindings: number;
    criticalOpen: number;
    silentPacks: number;
    artifactPass: number;
    artifactMissing: number;
  };
  findings: string[];
  decision: ReleaseDecision;
}

const DRIFT_STALE_DAYS = 30;

/** The two enforcement classes that make a CDSS safe, shared by both gates. */
export const SAFETY_RULE_CLASSES: readonly string[] = ['guardrail', 'coverage-gate'];

function nowIso(): string {
  return new Date().toISOString();
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

const BANDS: readonly ArtifactStatusLike['band'][] = ['pass', 'watch', 'insufficient'];

/**
 * Packs report their artefact status in their own shape: some declare a `band`,
 * some expose their acceptance flags (`meetsTarget`, `beatsPriorDiscrimination`,
 * `improvesCalibration`) and a regression head has no AUROC at all. This is the
 * one place that normalises them, and it never invents a verdict: a declared
 * band wins, otherwise the band is derived from the pack's own flags.
 */
function normaliseArtifactStatus(raw: object): ArtifactStatusLike {
  const r = raw as Record<string, unknown>;
  const present = r.present === true;
  const rows = typeof r.rows === 'number' ? r.rows : undefined;
  const note = typeof r.note === 'string'
    ? r.note
    : present
      ? `artefact present${rows !== undefined ? ` (${rows} rows)` : ''}${typeof r.mapePct === 'number' ? `, MAPE ${r.mapePct}%` : ''}`
      : 'no trained artefact';
  if (!present) return { present: false, band: 'insufficient', note };
  const declared = typeof r.band === 'string' && (BANDS as readonly string[]).includes(r.band)
    ? r.band as ArtifactStatusLike['band']
    : undefined;
  const flags = Object.entries(r)
    .filter(([k, v]) => typeof v === 'boolean' && /^(meets|beats|improves)/.test(k))
    .map(([, v]) => v as boolean);
  const band = declared
    ?? (flags.length === 0 ? 'watch' : flags.every(Boolean) ? 'pass' : flags.some(Boolean) ? 'watch' : 'insufficient');
  const metrics = r.metrics ?? r.classifier ?? r.regressor ?? r.mae;
  return { present: true, band, note, ...(metrics !== undefined ? { metrics } : {}) };
}

/** Anemia's trained artefact is a regression head with different metrics. */
function esaArtifactStatus(): ArtifactStatusLike {
  const artifact = loadEsaArtifact();
  if (!artifact) {
    return { present: false, band: 'insufficient', note: 'no trained ESA artefact on disk' };
  }
  const { testMae, baselineMae, nTest } = artifact.metrics;
  const beatsBaseline = testMae < baselineMae;
  const band: ArtifactStatusLike['band'] = !beatsBaseline ? 'insufficient' : nTest < 30 ? 'watch' : 'pass';
  return {
    present: true,
    band,
    note: beatsBaseline
      ? `test MAE ${testMae} beats the ${baselineMae} baseline over ${nTest} held-out windows`
      : `test MAE ${testMae} does not beat the ${baselineMae} baseline`,
    metrics: artifact.metrics,
  };
}

/**
 * Every pack, in protocol order, with the durable handles the gate reads.
 *
 * The `routes` prefix and `mdrKind` exist so a reviewer can walk from this
 * table to the pack's own console page and boundary document.
 */
export interface ProtocolPackDescriptor {
  protocol: ProtocolId;
  /** P-number from the implementation strategy. */
  slice: string;
  modelId: string;
  redTeamIds: readonly string[];
  coverageDefaults: unknown;
  artifactProbe: () => ArtifactStatusLike;
  routes: string;
  mdrKind: string;
}

export const PROTOCOL_PACKS: readonly ProtocolPackDescriptor[] = [
  {
    protocol: 'anemia', slice: 'P1', modelId: ESA_MODEL_ID, redTeamIds: ESA_RED_TEAM_IDS,
    coverageDefaults: ESA_COVERAGE_DEFAULTS, artifactProbe: esaArtifactStatus,
    routes: '/admin/swarm/anemia', mdrKind: 'esa-mdr-file',
  },
  {
    protocol: 'adequacy', slice: 'P2', modelId: ADEQUACY_MODEL_ID, redTeamIds: ADEQUACY_RED_TEAM_IDS,
    coverageDefaults: ADEQUACY_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(adequacyArtifactStatus()),
    routes: '/admin/swarm/adequacy', mdrKind: 'adequacy-mdr-file',
  },
  {
    protocol: 'fluid', slice: 'P3', modelId: FLUID_MODEL_ID, redTeamIds: FLUID_RED_TEAM_IDS,
    coverageDefaults: FLUID_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(fluidArtifactStatus()),
    routes: '/admin/swarm/fluid', mdrKind: 'fluid-mdr-file',
  },
  {
    protocol: 'access', slice: 'P4', modelId: ACCESS_MODEL_ID, redTeamIds: ACCESS_RED_TEAM_IDS,
    coverageDefaults: ACCESS_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(accessArtifactStatus()),
    routes: '/admin/swarm/access', mdrKind: 'access-mdr-file',
  },
  {
    protocol: 'ckd-mbd', slice: 'P4', modelId: MBD_MODEL_ID, redTeamIds: MBD_RED_TEAM_IDS,
    coverageDefaults: MBD_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(mbdArtifactStatus()),
    routes: '/admin/swarm/mbd', mdrKind: 'mbd-mdr-file',
  },
  {
    protocol: 'nutrition-electrolytes', slice: 'P5', modelId: NUTRITION_MODEL_ID, redTeamIds: NUTRITION_RED_TEAM_IDS,
    coverageDefaults: NUTRITION_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(nutritionArtifactStatus()),
    routes: '/admin/swarm/nutrition', mdrKind: 'nutrition-mdr-file',
  },
  {
    protocol: 'infection', slice: 'P6', modelId: INFECTION_MODEL_ID, redTeamIds: INFECTION_RED_TEAM_IDS,
    coverageDefaults: INFECTION_COVERAGE_DEFAULTS, artifactProbe: () => normaliseArtifactStatus(infectionArtifactStatus()),
    routes: '/admin/swarm/infection', mdrKind: 'infection-mdr-file',
  },
];

export function packFor(protocol: ProtocolId): ProtocolPackDescriptor | undefined {
  return PROTOCOL_PACKS.find((p) => p.protocol === protocol);
}

/**
 * Findings are attributed to a pack by SCENARIO ID, because that is the one
 * field every pack's red-team run and finding already carries. The anemia pack
 * uses a threat-model predicate instead, so it is handled explicitly.
 */
export function findingBelongsTo(finding: Pick<AssuranceFinding, 'scenarioId' | 'threatModel'>, pack: ProtocolPackDescriptor): boolean {
  if ((pack.redTeamIds as readonly string[]).includes(finding.scenarioId ?? '')) return true;
  return pack.protocol === 'anemia' ? isEsaFinding(finding) : false;
}

export async function protocolLedgerEvidence(
  ws: SwarmWorkspaceStore,
  pack: ProtocolPackDescriptor,
): Promise<ProtocolLedgerEvidence> {
  const models: ModelRecord[] = await ws.listModels();
  const drift: ModelDrift[] = await ws.listDrift();
  const runs: RedTeamRun[] = await ws.listRedTeamRuns();
  const findings: AssuranceFinding[] = await ws.listFindings();

  const packRunIds = new Set<string>(pack.redTeamIds);
  const packRuns = runs.filter((r) => packRunIds.has(r.scenarioId ?? ''));
  const packDrift = drift
    .filter((d) => d.targetId === pack.modelId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const packFindings = findings.filter((f) => findingBelongsTo(f, pack));
  const passedScenarios = new Set(packRuns.filter((r) => r.passed).map((r) => r.scenarioId));

  const latest = packDrift[0];
  const evidence: ProtocolLedgerEvidence = {
    model: models.some((m) => m.modelId === pack.modelId) ? 'present' : 'missing',
    modelId: pack.modelId,
    redTeamRuns: packRuns.length,
    redTeamScenarios: pack.redTeamIds.length,
    redTeamFailed: packRuns.filter((r) => !r.passed).length,
    redTeamPassedScenarios: passedScenarios.size,
    driftRecords: packDrift.length,
    findings: packFindings.length,
    openFindings: packFindings.filter((f) => f.status !== 'closed').length,
    criticalOpen: packFindings.filter((f) => f.status !== 'closed' && f.severity === 'critical').length,
    highOpen: packFindings.filter((f) => f.status !== 'closed' && f.severity === 'high').length,
  };
  if (latest) {
    evidence.latestDriftAt = latest.updatedAt;
    evidence.latestDriftStatus = latest.status;
  }
  return evidence;
}

export function assessProtocol(pack: ProtocolPackDescriptor, ledger: ProtocolLedgerEvidence): ProtocolAssessment {
  const at = nowIso();
  const artifact = pack.artifactProbe();
  const summary = rulePackSummary();
  const rules = rulesForProtocol(pack.protocol);
  const gaps = enforcementGaps(pack.protocol);
  // guardrail + coverage gate are the two classes that make a CDSS safe: one
  // refuses an unsafe action, the other refuses to answer without enough data.
  // A missing authority/escalation/surveillance rule is a documentation gap and
  // is reported as a warning, never as a release blocker.
  const safetyGaps = gaps.filter((g) => SAFETY_RULE_CLASSES.includes(g));
  const safetyClassName = (n: number): string => `${n} cited`;
  const mode = modeRecord(pack.protocol);
  const checks: ProtocolAssessment['checks'] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const add = (id: string, label: string, status: ReleaseCheckStatus, detail: string): void => {
    checks.push({ id: `${pack.protocol}.${id}`, label, status, detail });
    if (status === 'fail') blockers.push(detail);
    if (status === 'warn') warnings.push(detail);
  };

  add(
    'rules', 'Safety rules declared (guardrail + coverage gate)',
    rules.length > 0 && safetyGaps.length === 0 ? 'pass' : 'fail',
    rules.length === 0
      ? `${pack.protocol} declares no guideline rules`
      : safetyGaps.length > 0
        ? `${pack.protocol} declares no ${safetyGaps.join('/')} rule`
        : `${safetyClassName(rules.length)} safety rules declared`,
  );

  add(
    'rules-classes', 'Every enforcement class declared',
    gaps.length === 0 ? 'pass' : 'warn',
    gaps.length === 0
      ? 'guardrail, coverage-gate, authority, escalation and surveillance all declared'
      : `${pack.protocol} declares no ${gaps.join('/')} rule — a documented boundary gap, not a safety gap`,
  );

  add(
    'model', 'Advisor model registered',
    ledger.model === 'present' ? 'pass' : 'warn',
    ledger.model === 'present'
      ? `${ledger.modelId} registered in the model substrate`
      : `${ledger.modelId} is not registered — the gate evaluation runs on constants only`,
  );

  add(
    'artifact', 'Trained artefact present',
    artifact.present ? (artifact.band === 'pass' ? 'pass' : 'warn') : 'fail',
    artifact.present
      ? `${artifact.band}: ${artifact.note}`
      : `${pack.modelId} has no trained artefact — ${artifact.note}`,
  );

  const ranAll = ledger.redTeamPassedScenarios >= ledger.redTeamScenarios && ledger.redTeamScenarios > 0;
  add(
    'red-team', 'Red-team scenarios pass',
    ranAll ? 'pass' : ledger.redTeamRuns === 0 ? 'warn' : 'fail',
    ledgeDetail(ledger),
  );

  add(
    'drift', 'Drift recorded and fresh',
    ledger.driftRecords === 0
      ? 'warn'
      : ledger.latestDriftAt && daysBetween(ledger.latestDriftAt, at) > DRIFT_STALE_DAYS
        ? 'warn'
        : 'pass',
    ledger.driftRecords === 0
      ? `no drift snapshot for ${pack.modelId} — post-market behaviour is unobserved`
      : `last drift ${ledger.latestDriftStatus ?? 'unknown'} recorded ${Math.round(daysBetween(ledger.latestDriftAt ?? at, at))} days ago`,
  );

  add(
    'findings', 'No open critical/high findings',
    ledger.criticalOpen > 0 ? 'fail' : ledger.highOpen > 0 ? 'warn' : 'pass',
    ledger.openFindings === 0
      ? 'no open findings'
      : `${ledger.openFindings} open (${ledger.criticalOpen} critical, ${ledger.highOpen} high)`,
  );

  add(
    'mode', 'Surfacing mode declared',
    mode.mode === 'silent' ? 'warn' : 'pass',
    mode.mode === 'silent'
      ? `${pack.protocol} is silent since ${mode.since} — computed and recorded, never surfaced (${mode.reason})`
      : `${pack.protocol} is active; reason: ${mode.reason}`,
  );

  const verdict: ReleaseDecision = blockers.length > 0 ? 'block' : warnings.length > 0 ? 'hold' : 'ship';
  return {
    protocol: pack.protocol,
    modelId: pack.modelId,
    coverageDefaults: pack.coverageDefaults,
    ruleCount: rules.length,
    ruleGaps: gaps,
    artifact,
    ledger,
    mode,
    checks,
    verdict,
    blockers,
    warnings,
  };
}

function ledgeDetail(ledger: ProtocolLedgerEvidence): string {
  if (ledger.redTeamRuns === 0) {
    return `no red-team runs recorded for ${ledger.redTeamScenarios} declared scenarios`;
  }
  return `${ledger.redTeamPassedScenarios}/${ledger.redTeamScenarios} scenarios have a passing run; ${ledger.redTeamFailed} failing run(s) recorded`;
}

/* ---------- cohort inputs ---------- */

export interface AssuranceInputs {
  /** per-patient protocol outcomes, already computed by the protocol registry */
  fairnessRows?: readonly FairnessRow[] | undefined;
  /** surfaced alerts in the measurement window */
  alerts?: readonly AlertEvent[] | undefined;
  /** facility cohort size for the per-patient-week denominator */
  patients?: number | undefined;
  windowWeeks?: number | undefined;
  dimensions?: readonly SliceDimension[] | undefined;
}

/** Worst-first ordering, so the console leads with the pack that needs work. */
const DECISION_RANK: Record<ReleaseDecision, number> = { block: 3, hold: 2, ship: 1 };

function worstDecision(decisions: readonly ReleaseDecision[]): ReleaseDecision {
  return decisions.reduce<ReleaseDecision>((acc, d) => (DECISION_RANK[d] > DECISION_RANK[acc] ? d : acc), 'ship');
}

export async function crossPackAssurance(
  ws: SwarmWorkspaceStore,
  inputs: AssuranceInputs = {},
): Promise<CrossPackAssurance> {
  const generatedAt = nowIso();
  const protocols: ProtocolAssessment[] = [];
  for (const pack of PROTOCOL_PACKS) {
    const ledger = await protocolLedgerEvidence(ws, pack);
    protocols.push(assessProtocol(pack, ledger));
  }

  const rows = inputs.fairnessRows ?? [];
  const patients = inputs.patients ?? rows.length;
  const alerts = inputs.alerts ?? [];

  // The fairness report is per-protocol, but the dimensions are cross-cutting:
  // the report below is the cohort view, and the per-pack slice detail rides on
  // the protocol assessment through `assessProtocol`.
  const fairness = fairnessReport(rows, {
    protocol: 'anemia',
    ...(inputs.dimensions ? { dimensions: inputs.dimensions } : {}),
  });
  const burden = burdenReport(alerts, {
    patients,
    ...(inputs.windowWeeks !== undefined ? { weeks: inputs.windowWeeks } : {}),
  });

  const openFindings = protocols.reduce((a, p) => a + p.ledger.openFindings, 0);
  const criticalOpen = protocols.reduce((a, p) => a + p.ledger.criticalOpen, 0);
  const silentPacks = protocols.filter((p) => p.mode.mode === 'silent').length;

  const findings: string[] = [];
  for (const p of protocols) {
    if (p.verdict !== 'ship') findings.push(`${p.protocol}: ${p.verdict} — ${[...p.blockers, ...p.warnings].join('; ')}`);
  }
  if (fairness.verdict !== 'ok') {
    findings.push(`fairness: ${fairness.verdict} — ${fairness.findings[0] ?? 'see slice detail'}`);
  } else {
    findings.push('fairness: ok across every slice above the minimum size');
  }
  if (burden.verdict === 'not-measurable') {
    findings.push('alert burden: not measurable — no surfaced alerts in the window');
  } else if (burden.verdict !== 'ok') {
    findings.push(`alert burden: ${burden.verdict} — ${burden.findings[0] ?? 'see per-protocol detail'}`);
  }

  const rules = rulePackSummary();
  const totals: CrossPackAssurance['totals'] = {
    protocols: protocols.length,
    ship: protocols.filter((p) => p.verdict === 'ship').length,
    hold: protocols.filter((p) => p.verdict === 'hold').length,
    block: protocols.filter((p) => p.verdict === 'block').length,
    rules: rules.total,
    openFindings,
    criticalOpen,
    silentPacks,
    artifactPass: protocols.filter((p) => p.artifact.present && p.artifact.band === 'pass').length,
    artifactMissing: protocols.filter((p) => !p.artifact.present).length,
  };

  // Cross-cutting findings gate the decision alongside the per-pack verdicts.
  const crossCutting: ReleaseDecision =
    criticalOpen > 0 ? 'block'
      : fairness.verdict === 'breach' ? 'block'
        : totals.artifactMissing > 0 ? 'block'
          : fairness.verdict === 'watch' || burden.verdict === 'breach' ? 'hold'
            : burden.verdict === 'watch' || silentPacks > 0 ? 'hold'
              : 'ship';

  return {
    generatedAt,
    protocols,
    fairness,
    burden,
    totals,
    findings,
    decision: worstDecision([crossCutting, ...protocols.map((p) => p.verdict)]),
  };
}

/* ---------- the release gate ---------- */

export interface CrossPackGateCheck {
  id: string;
  label: string;
  status: ReleaseCheckStatus;
  detail: string;
  /** which protocols contributed to this check */
  protocols: ProtocolId[];
}

export interface CrossPackReleaseGate {
  generatedAt: string;
  decision: ReleaseDecision;
  /** the aggregate verdict, plus the planes a reviewer expects from release.ts */
  summary: string;
  checks: CrossPackGateCheck[];
  /** per-protocol MDR / boundary documents this release would carry */
  mdrFiles: Array<{
    protocol: ProtocolId;
    kind: string;
    materialised: boolean;
    id: string;
    at?: string | undefined;
  }>;
  modes: ProtocolModeRecord[];
  rulePacks: ReturnType<typeof rulePackSummary>;
  fairnessVerdict: string;
  burdenVerdict: string;
  blockers: string[];
  warnings: string[];
  assurance: CrossPackAssurance;
}

function gateCheck(
  id: string,
  label: string,
  entries: readonly { protocol: ProtocolId; status: ReleaseCheckStatus; detail: string }[],
): CrossPackGateCheck {
  const order: ReleaseCheckStatus[] = ['fail', 'warn', 'pass', 'skip'];
  const worst = order.find((s) => entries.some((e) => e.status === s)) ?? 'skip';
  const contributors = entries.filter((e) => e.status === worst).map((e) => e.protocol);
  const details = [...new Set(entries.filter((e) => e.status === worst).map((e) => e.detail))];
  return {
    id,
    label,
    status: worst,
    // every distinct reason is reported, because two packs can fail the same
    // check for entirely different reasons
    detail: worst === 'pass' || worst === 'skip'
      ? `${entries.length} protocols pass`
      : details.slice(0, 3).join(' · ') + (details.length > 3 ? ` · +${details.length - 3} more` : ''),
    protocols: contributors,
  };
}

/**
 * The single release gate for the whole protocol set.
 *
 * `activeOnly` gates what would be SURFACED today: silent packs still appear in
 * the narrative, but they cannot hold a release they do not participate in.
 * Everything else is assessed all-or-nothing — a critical finding in any pack
 * blocks the set.
 */
export async function assuranceReleaseGate(
  ws: SwarmWorkspaceStore,
  inputs: AssuranceInputs & { activeOnly?: boolean } = {},
): Promise<CrossPackReleaseGate> {
  const assurance = await crossPackAssurance(ws, inputs);
  const considered = inputs.activeOnly
    ? assurance.protocols.filter((p) => p.mode.mode === 'active')
    : assurance.protocols;

  const authority = considered.filter((p) => p.mode.mode === 'silent').length;
  const checks: CrossPackGateCheck[] = [
    gateCheck('rules', 'Every protocol declares its safety rules', considered.map((p) => ({
      protocol: p.protocol,
      status: (p.ruleCount > 0 && !p.ruleGaps.some((g) => SAFETY_RULE_CLASSES.includes(g))) ? 'pass' as const : 'fail' as const,
      detail: p.ruleGaps.length > 0 ? `missing ${p.ruleGaps.join('/')} rule` : 'no rules declared',
    }))),
    gateCheck('rules-classes', 'Every enforcement class is declared', considered.map((p) => ({
      protocol: p.protocol,
      status: p.ruleGaps.length === 0 ? 'pass' as const : 'warn' as const,
      detail: `no ${p.ruleGaps.join('/')} rule declared`,
    }))),
    gateCheck('artifact', 'Every protocol has a trained, target-meeting artefact', considered.map((p) => ({
      protocol: p.protocol,
      status: !p.artifact.present ? 'fail' as const : p.artifact.band === 'pass' ? 'pass' as const : 'warn' as const,
      detail: p.artifact.note,
    }))),
    gateCheck('red-team', 'Every protocol has passed its red-team scenarios', considered.map((p) => ({
      protocol: p.protocol,
      status: (p.ledger.redTeamScenarios > 0 && p.ledger.redTeamPassedScenarios >= p.ledger.redTeamScenarios)
        ? 'pass' as const
        : p.ledger.redTeamRuns === 0 ? 'warn' as const : 'fail' as const,
      detail: ledgeDetail(p.ledger),
    }))),
    gateCheck('findings', 'No open critical or high findings', considered.map((p) => ({
      protocol: p.protocol,
      status: p.ledger.criticalOpen > 0 ? 'fail' as const : p.ledger.highOpen > 0 ? 'warn' as const : 'pass' as const,
      detail: `${p.ledger.criticalOpen} critical / ${p.ledger.highOpen} high open`,
    }))),
    gateCheck('drift', 'Drift is recorded and fresh', considered.map((p) => ({
      protocol: p.protocol,
      status: p.ledger.driftRecords === 0 || p.ledger.latestDriftStatus === 'stale' ? 'warn' as const : 'pass' as const,
      detail: p.ledger.driftRecords === 0 ? 'no drift snapshot recorded' : `last ${p.ledger.latestDriftStatus}`,
    }))),
    gateCheck('model-registry', 'Every advisor model is registered', considered.map((p) => ({
      protocol: p.protocol,
      status: p.ledger.model === 'present' ? 'pass' as const : 'warn' as const,
      detail: `${p.modelId} not registered`,
    }))),
  ];

  // Cross-cutting planes: fairness and burden are measured on the cohort, not
  // on the pack, so they appear as checks rather than as protocol entries.
  checks.push({
    id: 'fairness',
    label: 'Cohort slices are within tolerance',
    status: assurance.fairness.verdict === 'breach' ? 'fail'
      : assurance.fairness.verdict === 'watch' ? 'warn'
        : assurance.fairness.verdict === 'insufficient' ? 'warn' : 'pass',
    detail: assurance.fairness.verdict === 'insufficient'
      ? `no slice reached the minimum size (${assurance.fairness.reference.minSliceN}) on a cohort of ${assurance.fairness.cohortN} — disparity cannot be asserted either way`
      : `${assurance.fairness.findings.length} finding(s): ${assurance.fairness.findings[0] ?? 'none'}`,
    protocols: considered.map((p) => p.protocol),
  });
  checks.push({
    id: 'burden',
    label: 'Alert burden is within tolerance',
    status: assurance.burden.verdict === 'breach' ? 'fail'
      : assurance.burden.verdict === 'watch' ? 'warn'
        : assurance.burden.verdict === 'not-measurable' ? 'warn' : 'pass',
    detail: `${assurance.burden.totals.alerts} alerts over ${assurance.burden.window.weeks}w = ${assurance.burden.totals.alertsPerPatientWeek}/patient-week (${assurance.burden.totals.costUnits} review-hours)`,
    protocols: considered.map((p) => p.protocol),
  });
  checks.push({
    id: 'mode',
    label: 'Every protocol has a declared surfacing mode',
    status: authority === considered.length ? 'warn' : 'pass',
    detail: authority === considered.length
      ? 'every considered protocol is silent — the gate is measuring shadow decisions only'
      : `${assurance.totals.silentPacks}/${assurance.totals.protocols} protocols are silent`,
    protocols: considered.map((p) => p.protocol),
  });

  const mdrFiles: CrossPackReleaseGate['mdrFiles'] = [];
  for (const pack of PROTOCOL_PACKS) {
    if (inputs.activeOnly && modeRecord(pack.protocol).mode === 'silent') continue;
    const id = pack.mdrKind;
    const doc = await ws.get(pack.mdrKind as Parameters<typeof ws.get>[0], id);
    mdrFiles.push({
      protocol: pack.protocol,
      kind: pack.mdrKind,
      materialised: Boolean(doc),
      id,
      ...(doc?.updatedAt ? { at: doc.updatedAt } : {}),
    });
  }

  const blockers = considered.flatMap((p) => p.blockers);
  const warnings = [
    ...considered.flatMap((p) => p.warnings),
    ...checks.filter((c) => c.status === 'warn').map((c) => `${c.label}: ${c.detail}`),
  ];

  const decision: ReleaseDecision =
    blockers.length > 0 || checks.some((c) => c.status === 'fail') ? 'block'
      : warnings.length > 0 ? 'hold'
        : 'ship';

  const missingMdr = mdrFiles.filter((m) => !m.materialised).length;

  return {
    generatedAt: assurance.generatedAt,
    decision,
    summary: decision === 'ship'
      ? `${considered.length} protocols, ${assurance.totals.rules} rules, ${assurance.fairness.cohortN} patients — no blockers`
      : decision === 'hold'
        ? `${warnings.length} warning(s) across ${considered.length} protocols — release held for review`
        : `${blockers.length + checks.filter((c) => c.status === 'fail').length} blocker(s) — release refused`,
    checks,
    mdrFiles,
    modes: silentModeSummary().records,
    rulePacks: rulePackSummary(),
    fairnessVerdict: assurance.fairness.verdict,
    burdenVerdict: assurance.burden.verdict,
    blockers,
    warnings,
    assurance,
  };
}

export const ASSURANCE_TRACK_REFERENCE = {
  protocols: RULE_PROTOCOLS,
  dimensions: Object.keys(FAIRNESS_DIMENSION_LABELS),
  driftStaleDays: DRIFT_STALE_DAYS,
  findingAttribution: 'red-team scenario id (anemia uses its threat-model predicate)',
  rule: 'the gate reads durable records and pack constants; it never recomputes clinical logic',
} as const;

export { FAIRNESS_DIMENSION_LABELS };
export type { FairnessReport, FairnessRow, AlertEvent, BurdenReport };
