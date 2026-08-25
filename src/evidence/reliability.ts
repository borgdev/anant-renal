/******************************************************************************
 * Source reliability — the P3 discounting dial.
 *
 * Every evidence source maps to a reliability α ∈ [0,1] used to discount its
 * DST mass: α·m stays on the focal elements, (1−α) is pushed onto ignorance Θ.
 * This is the "synthetic vs real" honesty knob — sim/reference/synthetic
 * sources and rejected evidence reviews carry low α (their mass mostly becomes
 * ignorance), while realm-ledger / CMS-real sources carry high α.
 ******************************************************************************/

export type ReviewStatus = 'confirmed' | 'rejected' | 'unreviewed';

export const REJECTED_REVIEW_RELIABILITY = 0.2;
export const CONFIRMED_REVIEW_RELIABILITY = 0.98;
export const REALM_LEDGER_RELIABILITY = 0.95;
export const SYNTHETIC_RELIABILITY = 0.3;
export const DEFAULT_RELIABILITY = 0.7;

/** Mark a source id as realm-ledger (real events) for the reliability dial. */
export const REALM_LEDGER_PREFIX = 'realm-ledger:';

/** Deterministic reliability for an evidence source given its review status. */
export function reliabilityBySource(sourceId: string | undefined, reviewStatus?: ReviewStatus): number {
  if (reviewStatus === 'rejected') return REJECTED_REVIEW_RELIABILITY;
  if (reviewStatus === 'confirmed') return CONFIRMED_REVIEW_RELIABILITY;
  if (typeof sourceId !== 'string' || sourceId.length === 0) return DEFAULT_RELIABILITY;
  const s = sourceId.toLowerCase();
  if (s.includes('realm-ledger') || s.startsWith('realm:')) return REALM_LEDGER_RELIABILITY;
  if (s.includes('sim:') || s.includes('synthetic') || s.includes('reference:') || s.includes('catalog:')) return SYNTHETIC_RELIABILITY;
  return DEFAULT_RELIABILITY;
}
