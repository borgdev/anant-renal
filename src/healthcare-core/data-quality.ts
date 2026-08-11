// Data-quality findings are the harness's honesty layer. Nothing generated,
// audited, or replayed is trustworthy if the source data violates the
// invariants a workflow depends on, so DQ runs BEFORE simulation and BEFORE
// workflow execution — findings gate downstream behavior.

export type DqSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface DataQualityFinding {
  ruleId: string;
  severity: DqSeverity;
  entityId?: string;
  message: string;
  evidence: Readonly<Record<string, unknown>>;
}

export interface DataQualityRule<Input = unknown> {
  id: string;
  description: string;
  evaluate(input: Input): DataQualityFinding[];
}

const SEVERITY_RANK: Record<DqSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export class DataQualityEngine<Input = unknown> {
  private readonly rules: Array<DataQualityRule<Input>> = [];

  register(rule: DataQualityRule<Input>): void {
    if (this.rules.some((r) => r.id === rule.id)) throw new Error(`DQ rule already registered: ${rule.id}`);
    this.rules.push(rule);
  }

  evaluate(input: Input): DataQualityFinding[] {
    return this.rules.flatMap((r) => r.evaluate(input));
  }

  /** Highest severity across findings, or `null` if the input is clean. */
  worst(findings: readonly DataQualityFinding[]): DqSeverity | null {
    if (findings.length === 0) return null;
    return findings.reduce<DqSeverity>((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'info');
  }

  /** Whether the input is safe for downstream execution. */
  gateExecution(findings: readonly DataQualityFinding[]): { proceed: boolean; reason: string } {
    const worst = this.worst(findings);
    if (worst === null || worst === 'info' || worst === 'warning') return { proceed: true, reason: worst ?? 'clean' };
    return { proceed: false, reason: `data quality ${worst}` };
  }
}
