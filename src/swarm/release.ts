/******************************************************************************
 * M-S3 — release gate: green/red-team gating for shipping a change to the
 * governed swarm (contracts, idempotency, isolation, gold-set parity, trace,
 * approvals). Deterministic: identical input → identical verdict.
 ******************************************************************************/

export type ReleasePlane = 'contracts' | 'idempotency' | 'isolation' | 'goldset' | 'trace' | 'approval';
export type ReleaseCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ReleaseCheck {
  id: string;
  plane: ReleasePlane;
  check: string;
  status: ReleaseCheckStatus;
  evidence: string;
}

export interface RedFinding {
  id: string;
  scenario: string;
  detail: string;
  contained: boolean;
}

export interface ReleaseChange {
  id: string;
  summary: string;
  changeType: 'config' | 'policy' | 'model' | 'workflow';
  cellIds: string[];
  author: string;
}

export interface ReleaseInput {
  change: ReleaseChange;
  /** Green-team checks — every `fail` blocks the release. */
  green: ReleaseCheck[];
  /** Red-team findings — every uncontained finding blocks the release. */
  red: RedFinding[];
  /** Source parity — the change must be built on current sources. */
  sources: { current: number; required: number };
  /** Approval classes granted toward the required count. */
  approvals: { required: number; granted: string[] };
}

export type ReleaseDecision = 'ship' | 'hold' | 'block';

export interface ReleaseVerdict {
  changeId: string;
  decision: ReleaseDecision;
  score: number;
  greenScore: number;
  redOpen: number;
  redContained: number;
  sourcesCurrent: boolean;
  approvalsMet: boolean;
  blocks: string[];
  reasons: string[];
  gates: ReleaseCheck[];
  red: RedFinding[];
  evaluatedAt: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function evaluateRelease(input: ReleaseInput, now = new Date().toISOString()): ReleaseVerdict {
  const greenTotal = input.green.length;
  const greenPass = input.green.filter((g) => g.status === 'pass').length;
  const greenScore = greenTotal === 0 ? 0 : round2(greenPass / greenTotal);
  const redContained = input.red.filter((r) => r.contained).length;
  const redOpen = input.red.length - redContained;
  const redRate = input.red.length === 0 ? 1 : round2(redContained / input.red.length);
  const sourcesCurrent = input.sources.current >= input.sources.required;
  const approvalsMet = input.approvals.granted.length >= input.approvals.required;
  const score = round2(greenScore * 0.6 + redRate * 0.3 + (sourcesCurrent ? 0.05 : 0) + (approvalsMet ? 0.05 : 0));

  const blocks: string[] = [];
  const reasons: string[] = [];
  for (const g of input.green) {
    if (g.status === 'fail') blocks.push(`green:${g.id}`);
    else if (g.status === 'warn') reasons.push(`warn:${g.id}`);
    else if (g.status === 'skip') reasons.push(`skip:${g.id}`);
  }
  for (const r of input.red) {
    if (!r.contained) blocks.push(`red:${r.id}`);
  }
  if (!sourcesCurrent) blocks.push('sources-stale');
  if (!approvalsMet) reasons.push(`approvals (${input.approvals.granted.length}/${input.approvals.required})`);

  const decision: ReleaseDecision = blocks.length > 0 ? 'block' : reasons.length > 0 ? 'hold' : 'ship';

  return {
    changeId: input.change.id,
    decision,
    score,
    greenScore,
    redOpen,
    redContained,
    sourcesCurrent,
    approvalsMet,
    blocks: [...blocks].sort(),
    reasons: [...reasons].sort(),
    gates: input.green,
    red: input.red,
    evaluatedAt: now,
  };
}

/** Apply containment overrides from the cockpit (toggle a finding's `contained`). */
export function applyRedOverrides(red: RedFinding[], overrides: Array<{ id: string; contained: boolean }>): RedFinding[] {
  return red.map((r) => {
    const o = overrides.find((x) => x.id === r.id);
    return o ? { ...r, contained: o.contained } : r;
  });
}

/** Baseline release candidate for the demo — ships green; the cockpit can toggle. */
export function demoReleaseInput(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    change: {
      id: 'change:clean-claim-policy-v2',
      summary: 'Promote outbound clean-claim mapping v2 to production',
      changeType: 'policy',
      cellIds: ['revenue-cycle', 'treatment-continuity'],
      author: 'user:operator',
    },
    green: [
      { id: 'contracts/schema-valid', plane: 'contracts', status: 'pass', check: 'Canonical event schema valid under v1.2', evidence: '232/232 events conform' },
      { id: 'contracts/effect-allowed', plane: 'contracts', status: 'pass', check: 'All emitted effects within cell allowlists', evidence: 'revenue-cycle → submit-claim allowed' },
      { id: 'idempotency/keyed', plane: 'idempotency', status: 'pass', check: 'Publish keyed by event id', evidence: 'idempotency registry 100% hit' },
      { id: 'isolation/whatif-sandboxed', plane: 'isolation', status: 'pass', check: 'Policy replay runs in an isolated sandbox', evidence: 'no side effects observed' },
      { id: 'goldset/parity', plane: 'goldset', status: 'pass', check: 'Measure parity vs gold set', evidence: 'ecqm:M21Basic matches 1.0000' },
      { id: 'trace/dossier', plane: 'trace', status: 'pass', check: 'Outcome-episode dossier hash stable', evidence: 'sha256 verified' },
    ],
    red: [
      { id: 'red/injection', scenario: 'Malformed claim event with extra PHI payload', detail: 'Rejected at integrity validation; no cross-tenant leak', contained: true },
      { id: 'red/approval-bypass', scenario: 'Effect dispatched without approval', detail: 'Cell gate blocked; HITL held', contained: true },
      { id: 'red/stale-rule', scenario: 'Weekend coverage rule older than 90d', detail: 'Flagged by policy-expiry scanner — re-approval pending', contained: true },
    ],
    sources: { current: 14, required: 14 },
    approvals: { required: 2, granted: ['user:operator', 'user:medical-director'] },
    ...overrides,
  };
}
