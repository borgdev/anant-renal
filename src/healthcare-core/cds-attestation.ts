// FDA non-device CDS + ONC decision-support attestations. Any recommendation
// the harness surfaces to a clinician must ride with:
//   - transparency of inputs
//   - transparency of logic / basis
//   - explicit "independent-review-preserved" flag (FDA non-device CDS)
//   - ONC DSI (Predictive DSI or Evidence-Based DSI) source metadata when the
//     recommendation is generated from a decision-support intervention

export type FDACDSCategoryHint =
  | 'non-device-cds' // 21st Century Cures Act CDS carveout
  | 'device-cds-clearance-required'
  | 'not-cds';

export type ONCDSIKind = 'evidence-based-dsi' | 'predictive-dsi' | 'not-dsi';

export interface CDSAttestation {
  readonly recommendationId: string;
  readonly issuedAt: string;
  readonly issuedBy: string; // agent / rule / model id
  readonly fdaCategoryHint: FDACDSCategoryHint;
  readonly nonDeviceCdsCriteria: {
    readonly notMakingSpecificRecommendation: boolean; // no specific dx/tx decision
    readonly clinicianCanIndependentlyReview: boolean;
    readonly disclosesSourceData: boolean;
    readonly disclosesLogicOrBasis: boolean;
    readonly disclosesLimitations: boolean;
  };
  readonly oncDsi: {
    readonly kind: ONCDSIKind;
    readonly sourceAttributes?: {
      readonly developerName: string;
      readonly fundingSource: string;
      readonly developmentStudyDesign: string;
      readonly inputVariables: readonly string[];
      readonly outputMetric: string;
      readonly validationDataset: string;
      readonly performanceMetrics: readonly { readonly name: string; readonly value: number }[];
      readonly biasFairnessAssessment: string;
      readonly ongoingMaintenance: string;
    };
  };
  readonly inputRefs: readonly string[]; // event ids used
  readonly rationaleText: string;
  readonly warnings: readonly string[];
}

/** Validate an attestation meets the FDA non-device-CDS four-criteria test. */
export function isNonDeviceCDSCompliant(a: CDSAttestation): boolean {
  const c = a.nonDeviceCdsCriteria;
  return (
    c.notMakingSpecificRecommendation === false && // may make recommendations
    c.clinicianCanIndependentlyReview &&
    c.disclosesSourceData &&
    c.disclosesLogicOrBasis
  );
}

export function requiresONCTransparency(a: CDSAttestation): boolean {
  return a.oncDsi.kind !== 'not-dsi';
}
