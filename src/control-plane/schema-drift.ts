// Schema drift detection. Compare an observed field-set against a declared
// baseline; classify as additive-only (safe), field-removed (breaking), or
// field-type-changed (breaking).

export interface SchemaBaseline {
  readonly id: string;
  readonly eventType: string;
  readonly version: string;
  readonly fields: readonly { readonly name: string; readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array'; readonly required: boolean }[];
}

export type DriftKind = 'added-field' | 'removed-field' | 'type-changed' | 'required-changed' | 'stable';

export interface DriftFinding {
  readonly baselineId: string;
  readonly kind: DriftKind;
  readonly field?: string;
  readonly note: string;
  readonly breaking: boolean;
}

export function detectDrift(
  baseline: SchemaBaseline,
  observed: readonly { readonly name: string; readonly type: SchemaBaseline['fields'][number]['type']; readonly required: boolean }[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const byNameBase = new Map(baseline.fields.map((f) => [f.name, f]));
  const byNameObs = new Map(observed.map((f) => [f.name, f]));
  for (const [name, obs] of byNameObs) {
    const base = byNameBase.get(name);
    if (!base) { findings.push({ baselineId: baseline.id, kind: 'added-field', field: name, note: 'new field observed', breaking: false }); continue; }
    if (base.type !== obs.type) findings.push({ baselineId: baseline.id, kind: 'type-changed', field: name, note: `${base.type} → ${obs.type}`, breaking: true });
    if (base.required !== obs.required) findings.push({ baselineId: baseline.id, kind: 'required-changed', field: name, note: `${base.required} → ${obs.required}`, breaking: !obs.required && base.required });
  }
  for (const [name] of byNameBase) {
    if (!byNameObs.has(name)) findings.push({ baselineId: baseline.id, kind: 'removed-field', field: name, note: 'baseline field missing', breaking: true });
  }
  if (findings.length === 0) findings.push({ baselineId: baseline.id, kind: 'stable', note: 'no drift', breaking: false });
  return findings;
}
