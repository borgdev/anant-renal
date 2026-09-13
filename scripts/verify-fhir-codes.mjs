#!/usr/bin/env node
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

// Re-verify every `verified` entry in src/fhir/code-registry.ts against the
// authority that owns the code system. This is how the registry stays true:
// run it after adding or changing an entry.
//
//   node --import tsx scripts/verify-fhir-codes.mjs
//   node --import tsx scripts/verify-fhir-codes.mjs --rxnorm-only
//
// NOT part of CI — it needs the network. The unit tests run offline against the
// seeded table; this script is the periodic truth check.
//
// Why it exists: transcription is where terminology goes wrong. Running this
// against the seed tables in src/ontology/seeds.ts and
// src/healthcare-core/terminology.ts found that five of their entries were
// MISLABELLED (e.g. RxNorm 104375 is lisinopril, not epoetin alfa; LOINC
// 18262-6 is LDL cholesterol, not spKt/V). A wrong code that looks
// authoritative is worse than a slug, because nothing downstream complains.

import { CODE_SEEDS } from '../src/fhir/code-registry.ts';

const TX = 'https://tx.fhir.org/r4';
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s]+/g, ' ').replace(/[.,;:]$/, '').trim();

async function txLookup(system, code) {
  try {
    const res = await fetch(`${TX}/CodeSystem/$lookup?system=${encodeURIComponent(system)}&code=${encodeURIComponent(code)}`, {
      headers: { accept: 'application/fhir+json' },
    });
    if (!res.ok) return { error: `${res.status}` };
    const d = await res.json();
    const p = (n) => (d.parameter ?? []).find((x) => x.name === n)?.valueString;
    return { display: p('display'), version: p('version') };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

async function rxnavLookup(code) {
  try {
    const res = await fetch(`${RXNAV}/rxcui/${encodeURIComponent(code)}/property.json?propName=RxNorm%20Name`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `${res.status}` };
    const d = await res.json();
    const name = d.propConceptGroup?.propConcept?.[0]?.propValue;
    // RxNav also carries a version header we can cite.
    const version = res.headers.get('x-rxnav-version') ?? undefined;
    return name ? { display: name, version } : { error: 'no-name' };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

const SYSTEMS_WITHOUT_A_SERVER = new Set([
  // Published FHIR/HL7 spec codes — verified by citation, not by a lookup.
]);

const rows = CODE_SEEDS.filter((e) => e.fidelity === 'verified');
const rxnormOnly = process.argv.includes('--rxnorm-only');
const targets = rxnormOnly ? rows.filter((e) => e.system.includes('rxnorm')) : rows;

console.log(`Verifying ${targets.length} verified entries against their authorities…\n`);

const results = { exact: [], normalised: [], mismatch: [], unavailable: [], skipped: [] };

for (const entry of targets) {
  const isRx = entry.system.includes('rxnorm');
  const isLookupable = entry.system === 'http://loinc.org' || entry.system === 'http://snomed.info/sct' || entry.system === 'http://hl7.org/fhir/sid/cvx' || isRx;

  if (!isLookupable || SYSTEMS_WITHOUT_A_SERVER.has(entry.system)) {
    results.skipped.push(entry);
    continue;
  }

  const got = isRx ? await rxnavLookup(entry.code) : await txLookup(entry.system, entry.code);
  await sleep(140);

  if (got.error) {
    // A 404 on a licensed system (SNOMED / RxNorm subsets) is not proof the code
    // is wrong — record it as unavailable rather than a failure.
    results.unavailable.push({ entry, error: got.error });
    continue;
  }

  const ours = norm(entry.display);
  const theirs = norm(got.display);
  if (ours === theirs) results.exact.push({ entry, got });
  else if (theirs.includes(ours) || ours.includes(theirs)) results.normalised.push({ entry, got });
  else results.mismatch.push({ entry, got });
}

const show = (label, list, fmt) => {
  if (!list.length) return;
  console.log(`\n### ${label} (${list.length})`);
  for (const item of list) console.log('  ' + fmt(item));
};

show('EXACT match', results.exact, (r) => `${r.entry.domain}:${r.entry.slug} → ${r.entry.code}  "${r.got.display}"`);
show('Near match (wording differs, same concept)', results.normalised, (r) => `${r.entry.domain}:${r.entry.slug} → ${r.entry.code}\n      ours:   "${r.entry.display}"\n      theirs: "${r.got.display}"`);
show('MISMATCH — the code means something else', results.mismatch, (r) => `${r.entry.domain}:${r.entry.slug} → ${r.entry.code}\n      ours:   "${r.entry.display}"\n      theirs: "${r.got.display}"`);
show('Not verifiable on a public server', results.unavailable, (r) => `${r.entry.domain}:${r.entry.slug} → ${r.entry.code} (${r.error})`);
show('Skipped (spec-published codes)', results.skipped, (e) => `${e.domain}:${e.slug} → ${e.code} (${e.system.split('/').pop()})`);

console.log(
  `\nSummary: exact ${results.exact.length}, near ${results.normalised.length}, ` +
    `MISMATCH ${results.mismatch.length}, unavailable ${results.unavailable.length}, skipped ${results.skipped.length}`,
);

if (results.mismatch.length > 0) {
  console.error('\nFAIL — a code in the registry means something other than its display. Fix the entry.');
  process.exit(1);
}
console.log('\nNo mismatches.');
