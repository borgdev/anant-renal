/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

// Composite services layered over the source clients. These are what
// agents invoke, not the raw clients — so the pipeline can enforce
// attribution, licensing, and provenance metadata for every result.

import type { ClinicalTrialsGovClient, CTGovStudy, DailyMedClient, OpenFDAClient, PubMedClient, PubMedArticleSummary, RxNavClient } from './clients.js';

export interface TrialMatch {
  readonly study: CTGovStudy;
  readonly matchScore: number;
  readonly matchReasons: readonly string[];
  readonly attribution: string;
}

/**
 * TrialMatchingService. Given a lightweight patient snapshot
 * (conditions + medications + zip/location), returns candidate
 * open trials from ClinicalTrials.gov with a matchScore in [0..1].
 *
 * We keep scoring transparent: overlap-based on conditions + interventions
 * and a location bonus. Real deployments layer in eligibility parsing.
 */
export class TrialMatchingService {
  constructor(private readonly ct: ClinicalTrialsGovClient) {}

  async findMatches(snapshot: { conditions: readonly string[]; medications: readonly string[]; location?: string }): Promise<readonly TrialMatch[]> {
    const results: TrialMatch[] = [];
    for (const cond of snapshot.conditions) {
      const studies = await this.ct.searchStudies({ condition: cond, status: 'RECRUITING', pageSize: 25 });
      for (const s of studies) {
        const reasons: string[] = [];
        let score = 0;
        if (s.conditions.some((c) => c.toLowerCase().includes(cond.toLowerCase()))) { score += 0.5; reasons.push(`Condition match: ${cond}`); }
        for (const med of snapshot.medications) {
          if (s.interventions.some((i) => i.toLowerCase().includes(med.toLowerCase()))) { score += 0.3; reasons.push(`Intervention match: ${med}`); }
        }
        if (snapshot.location && s.locations.some((l) => l.country?.toLowerCase().includes(snapshot.location!.toLowerCase()) || l.state?.toLowerCase().includes(snapshot.location!.toLowerCase()) || l.city?.toLowerCase().includes(snapshot.location!.toLowerCase()))) {
          score += 0.2;
          reasons.push(`Location match: ${snapshot.location}`);
        }
        if (score > 0) results.push({ study: s, matchScore: Math.min(score, 1), matchReasons: reasons, attribution: 'Data courtesy of the U.S. National Library of Medicine.' });
      }
    }
    results.sort((a, b) => b.matchScore - a.matchScore);
    return results;
  }
}

/**
 * NewMedicationDiscoveryService. Watches openFDA / DailyMed / PubMed for
 * newly approved / newly labeled meds relevant to the formulary. Emits
 * candidate meds with evidence (label URL, first-in-class flag, adverse
 * event snapshot).
 */
export interface NewMedCandidate {
  readonly rxcui?: string;
  readonly brandName?: string;
  readonly genericName?: string;
  readonly newness: 'newly-approved' | 'new-label' | 'new-indication' | 'safety-update';
  readonly labelUrl?: string;
  readonly evidenceLinks: readonly { citation: string; url: string }[];
  readonly signalSummary?: { seriousReactions: number; sampleReactions: readonly string[] };
  readonly attributions: readonly string[];
}

export class NewMedicationDiscoveryService {
  constructor(
    private readonly dailyMed: DailyMedClient,
    private readonly openfda: OpenFDAClient,
    private readonly pubmed: PubMedClient,
    private readonly rxnav: RxNavClient,
  ) {}

  async surveyByGenericName(name: string): Promise<NewMedCandidate | undefined> {
    const rxcui = await this.rxnav.findRxcuiByName(name);
    let labelUrl: string | undefined;
    if (rxcui) {
      const labels = await this.dailyMed.searchByRxCUI(rxcui);
      labelUrl = labels[0]?.url;
    }
    const faers = await this.openfda.searchFaers({ drug: name, limit: 100 });
    const serious = faers.filter((r) => r.seriousness === 'serious').length;
    const sample = Array.from(new Set(faers.flatMap((r) => r.reactions))).slice(0, 8);
    const pmids = await this.pubmed.searchPmids(`${name}[Title] AND (efficacy OR adverse OR pharmacokinetics)`, { retmax: 5 });
    const articles: readonly PubMedArticleSummary[] = pmids.length ? await this.pubmed.summarize(pmids) : [];
    return {
      ...(rxcui ? { rxcui } : {}),
      genericName: name,
      newness: 'new-label',
      ...(labelUrl ? { labelUrl } : {}),
      evidenceLinks: articles.map((a) => ({ citation: `${a.authors.slice(0, 3).join(', ')}. ${a.title}. ${a.journal ?? ''}`, url: a.url })),
      ...(faers.length > 0 ? { signalSummary: { seriousReactions: serious, sampleReactions: sample } } : {}),
      attributions: [
        'RxNorm and interaction data from U.S. National Library of Medicine.',
        'DailyMed content provided by U.S. National Library of Medicine.',
        'Data from NCBI/NLM E-utilities.',
        'openFDA data (FDA/FAERS) is public domain.',
      ],
    };
  }
}

/**
 * PharmacovigilanceSignalDetector — batches FAERS lookups for a formulary
 * and returns drugs where the recent serious-reaction proportion exceeds
 * a threshold. Callers (agents) route positive signals into pharmacy +
 * medical-safety-committee workflows.
 */
export interface PvSignal {
  readonly drug: string;
  readonly totalReports: number;
  readonly seriousProportion: number;
  readonly topReactions: readonly string[];
}

export class PharmacovigilanceSignalDetector {
  constructor(private readonly openfda: OpenFDAClient, private readonly seriousThreshold = 0.4) {}

  async scan(drugs: readonly string[], perDrugLimit = 100): Promise<readonly PvSignal[]> {
    const signals: PvSignal[] = [];
    for (const d of drugs) {
      const events = await this.openfda.searchFaers({ drug: d, limit: perDrugLimit });
      const total = events.length;
      if (total === 0) continue;
      const serious = events.filter((r) => r.seriousness === 'serious').length;
      const proportion = serious / total;
      const reactionCounts = new Map<string, number>();
      for (const r of events) for (const rx of r.reactions) reactionCounts.set(rx, (reactionCounts.get(rx) ?? 0) + 1);
      const top = [...reactionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
      if (proportion >= this.seriousThreshold) signals.push({ drug: d, totalReports: total, seriousProportion: proportion, topReactions: top });
    }
    return signals;
  }
}
