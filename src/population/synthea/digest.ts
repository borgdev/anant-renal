/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// Two digests, because there are two different questions (S2).
//
// This file exists because a SINGLE digest could not honestly answer both, and
// the first design tried to. What follows was MEASURED by running the reference
// generator twice with the same `--seed` and `--reference-date` and diffing the
// output — not taken from documentation, which does not discuss it:
//
//   patient identity (name + UUID)           reproducible
//   patient clinical content (resources,
//     references, dates, codes)              reproducible
//   provider display names                   NOT reproducible
//   practitioner roster (UUIDs and names)    NOT reproducible
//   hospitalInformation content              reproducible (its FILENAME carries
//                                            a wall-clock epoch)
//
// Concretely: two runs produced byte-identical patient bundles in 1 of 17 cases.
// Every other difference was a `.display` naming a clinician (`Dr. Eldridge510
// Roob72` in one run, `Dr. Victoria535 Roob72` in the next), and the practitioner
// roster is regenerated from a source `-s` does not reach — 122 entries in both
// runs with different UUIDs AND different names.
//
// The consequence: a byte digest over a directory is NEVER equal across two
// legitimate regenerations, so using one to ask "is this the same population?"
// answers NO every time, forever. That is not a strict check, it is a broken one,
// and it would have been discovered much later as "the cache never hits".
//
// So:
//
//   `outputDigestOf`  raw bytes, as produced    -> "has this directory been
//                                                    touched since we made it?"
//   `patientDigestOf` normalised patient layer  -> "is this the same population?"
//
// The second is the one that can be compared across regenerations, and it still
// fails loudly on a real change: a different seed, an age-range change, a Synthea
// upgrade, or a module-set change all alter it. It deliberately does not cover
// the provider layer, because that layer is not reproducible and a digest that
// includes it can only ever say "different".

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from './manifest.js';

/**
 * Replace the human name of a referenced ENTITY with a constant.
 *
 * The rule is structural, not a path list: a `display` that sits beside a
 * `reference` or an `identifier` names an *entity* ("who did it"), and those names
 * are the volatile ones. A `display` standing on its own is a CodeableConcept
 * *code* display (`"Hemoglobin"`, `"Married"`), which is clinical content and must
 * be preserved — stripping those would make the digest blind to a coding change,
 * which is the opposite of the point.
 */
export function normalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const namesAnEntity = 'reference' in source || 'identifier' in source;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      out[key] = key === 'display' && namesAnEntity ? '<entity>' : normalizeForDigest(child);
    }
    return out;
  }
  return value;
}

/**
 * Whether a parsed FHIR payload is a patient bundle.
 *
 * Decided by CONTENT, not by filename. `practitionerInformation` and
 * `hospitalInformation` are Bundles too, but they contain Organization and
 * Practitioner resources and no Patient, so they fall out on their own — which is
 * correct, because neither is reproducible.
 */
export function isPatientBundle(value: unknown): boolean {
  const entries = (value as { entry?: unknown } | null)?.entry;
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => {
    const type = (e as { resource?: { resourceType?: unknown } } | null)?.resource?.resourceType;
    return type === 'Patient';
  });
}

export interface PatientDigest {
  readonly digest: string;
  /** How many patient bundles the digest covered. Zero means it proves nothing. */
  readonly patientCount: number;
  /** Files that could not be parsed. Non-empty means the digest is not trustworthy. */
  readonly unreadable: readonly string[];
}

/**
 * A digest over the reproducible part of a population.
 *
 * Each bundle is normalised, then hashed with its filename, and the per-file
 * hashes are SORTED before folding. Sorting is what makes the result independent
 * of directory order, and hashing the filename alongside the content is what makes
 * a rename visible even when the contents are identical.
 *
 * `patientCount` is returned rather than implied: a digest over zero files is a
 * constant, and a caller that treats that constant as evidence has been misled by
 * an empty directory rather than by a changed population.
 */
export function patientDigestOf(dir: string): PatientDigest {
  if (!existsSync(dir)) return { digest: 'empty', patientCount: 0, unreadable: [] };
  const perFile: string[] = [];
  const unreadable: string[] = [];
  let patientCount = 0;

  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      unreadable.push(name);
      continue;
    }
    if (!isPatientBundle(parsed)) continue;
    patientCount++;
    perFile.push(
      createHash('sha256').update(name).update('\0').update(canonical(normalizeForDigest(parsed))).digest('hex'),
    );
  }

  if (unreadable.length > 0) {
    // Refuse to return a digest computed over an incomplete read: it would differ
    // from a good run for a reason that has nothing to do with the population.
    return { digest: 'incomplete', patientCount, unreadable };
  }
  if (patientCount === 0) return { digest: 'empty', patientCount, unreadable };

  perFile.sort();
  const digest = createHash('sha256').update(perFile.join('\n')).digest('hex').slice(0, 16);
  return { digest, patientCount, unreadable };
}

/**
 * The layers this generator does NOT reproduce, recorded in the manifest.
 *
 * Stated as data rather than prose so that a specialty author reading a manifest
 * — or a future verification step — does not have to re-derive it by experiment,
 * which is how it was learned.
 */
export const NON_REPRODUCIBLE_LAYERS: readonly string[] = [
  'practitioner-roster',
  'provider-display-names',
];
