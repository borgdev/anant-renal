// Concrete public-data clients. Each client hits a real endpoint with the
// documented request shape, so the harness can perform trial matching,
// formulary lookups, and pharmacovigilance signal detection today without
// vendor-supplied wrappers.
//
// All clients are dependency-injected an HttpFetcher so tests can pin the
// on-wire request/response without touching the network. Real deployments
// pass a rate-limited, cached, retrying fetcher.

export interface HttpFetcher {
  fetchJson<T = unknown>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T>;
  fetchText(url: string, init?: { method?: string; headers?: Record<string, string> }): Promise<string>;
}

/** ClinicalTrials.gov v2 — modern JSON API. */
export interface CTGovStudy {
  readonly nctId: string;
  readonly title: string;
  readonly status: string;
  readonly phase?: string;
  readonly conditions: readonly string[];
  readonly interventions: readonly string[];
  readonly sponsor: string;
  readonly locations: readonly { city: string; state?: string; country: string; status?: string }[];
  readonly startDate?: string;
  readonly primaryCompletionDate?: string;
  readonly url: string;
}

export class ClinicalTrialsGovClient {
  constructor(private readonly http: HttpFetcher, private readonly base = 'https://clinicaltrials.gov/api/v2') {}

  async searchStudies(params: { condition?: string; intervention?: string; location?: string; status?: string; pageSize?: number }): Promise<readonly CTGovStudy[]> {
    const usp = new URLSearchParams();
    if (params.condition) usp.set('query.cond', params.condition);
    if (params.intervention) usp.set('query.intr', params.intervention);
    if (params.location) usp.set('query.locn', params.location);
    if (params.status) usp.set('filter.overallStatus', params.status);
    usp.set('pageSize', String(params.pageSize ?? 20));
    usp.set('format', 'json');
    const url = `${this.base}/studies?${usp.toString()}`;
    const raw = await this.http.fetchJson<{ studies?: Array<{ protocolSection?: Record<string, unknown> }> }>(url);
    const studies = raw.studies ?? [];
    return studies.map((s) => this.mapStudy(s));
  }

  private mapStudy(s: { protocolSection?: Record<string, unknown> }): CTGovStudy {
    const p = (s.protocolSection ?? {}) as Record<string, Record<string, unknown>>;
    const id = ((p.identificationModule as Record<string, unknown>)?.nctId as string) ?? '';
    const title = ((p.identificationModule as Record<string, unknown>)?.briefTitle as string) ?? '';
    const status = ((p.statusModule as Record<string, unknown>)?.overallStatus as string) ?? '';
    const design = p.designModule as Record<string, unknown> | undefined;
    const phase = (design?.phases as string[] | undefined)?.[0];
    const cond = ((p.conditionsModule as Record<string, unknown>)?.conditions as string[]) ?? [];
    const intr = ((p.armsInterventionsModule as Record<string, unknown>)?.interventions as Array<{ name: string }>) ?? [];
    const sponsor = (((p.sponsorCollaboratorsModule as Record<string, unknown>)?.leadSponsor as Record<string, unknown>)?.name as string) ?? '';
    const locs = (((p.contactsLocationsModule as Record<string, unknown>)?.locations as Array<{ city?: string; state?: string; country?: string; status?: string }>) ?? []).map((l) => ({ city: l.city ?? '', ...(l.state ? { state: l.state } : {}), country: l.country ?? '', ...(l.status ? { status: l.status } : {}) }));
    const startDate = (((p.statusModule as Record<string, unknown>)?.startDateStruct as Record<string, unknown>)?.date as string) ?? undefined;
    const pcd = (((p.statusModule as Record<string, unknown>)?.primaryCompletionDateStruct as Record<string, unknown>)?.date as string) ?? undefined;
    return {
      nctId: id,
      title,
      status,
      ...(phase ? { phase } : {}),
      conditions: cond,
      interventions: intr.map((i) => i.name),
      sponsor,
      locations: locs,
      ...(startDate ? { startDate } : {}),
      ...(pcd ? { primaryCompletionDate: pcd } : {}),
      url: `https://clinicaltrials.gov/study/${id}`,
    };
  }
}

/** DailyMed — structured product labels for FDA-approved drugs. */
export interface DailyMedLabelSummary {
  readonly setId: string;
  readonly title: string;
  readonly publishedDate: string;
  readonly url: string;
}

export class DailyMedClient {
  constructor(private readonly http: HttpFetcher, private readonly base = 'https://dailymed.nlm.nih.gov/dailymed/services/v2') {}
  async searchByRxCUI(rxcui: string): Promise<readonly DailyMedLabelSummary[]> {
    const url = `${this.base}/rxcuis/${encodeURIComponent(rxcui)}/spls.json`;
    const raw = await this.http.fetchJson<{ data?: Array<{ setid: string; title: string; published_date: string }> }>(url);
    return (raw.data ?? []).map((d) => ({ setId: d.setid, title: d.title, publishedDate: d.published_date, url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${d.setid}` }));
  }
}

/** openFDA drug endpoints. Covers Orange Book (via NDC directory), Drugs@FDA, and FAERS. */
export interface OpenFDADrugRecord {
  readonly productNdc?: string;
  readonly brandName?: string;
  readonly genericName?: string;
  readonly labelerName?: string;
  readonly marketingCategory?: string;
  readonly dosageForm?: string;
  readonly routes?: readonly string[];
}

export class OpenFDAClient {
  constructor(private readonly http: HttpFetcher, private readonly base = 'https://api.fda.gov') {}

  async lookupNdc(ndc: string): Promise<OpenFDADrugRecord | undefined> {
    const url = `${this.base}/drug/ndc.json?search=product_ndc:%22${encodeURIComponent(ndc)}%22&limit=1`;
    const raw = await this.http.fetchJson<{ results?: Array<Record<string, unknown>> }>(url);
    const r = raw.results?.[0];
    if (!r) return undefined;
    return {
      productNdc: r.product_ndc as string,
      brandName: r.brand_name as string,
      genericName: r.generic_name as string,
      labelerName: r.labeler_name as string,
      marketingCategory: r.marketing_category as string,
      dosageForm: r.dosage_form as string,
      routes: r.route as string[],
    };
  }

  async searchFaers(params: { drug: string; reaction?: string; limit?: number }): Promise<readonly { report: string; reactions: string[]; seriousness?: string; receivedate?: string }[]> {
    const clauses = [`patient.drug.medicinalproduct:%22${encodeURIComponent(params.drug)}%22`];
    if (params.reaction) clauses.push(`patient.reaction.reactionmeddrapt:%22${encodeURIComponent(params.reaction)}%22`);
    const url = `${this.base}/drug/event.json?search=${clauses.join('+AND+')}&limit=${params.limit ?? 25}`;
    const raw = await this.http.fetchJson<{ results?: Array<Record<string, unknown>> }>(url);
    return (raw.results ?? []).map((r) => {
      const patient = (r.patient ?? {}) as { reaction?: Array<{ reactionmeddrapt?: string }> };
      const reactions = (patient.reaction ?? []).map((x) => x.reactionmeddrapt ?? '');
      const seriousness = ((r.serious ?? '') as string) === '1' ? 'serious' : 'non-serious';
      return { report: (r.safetyreportid ?? '') as string, reactions, seriousness, receivedate: r.receivedate as string };
    });
  }
}

/** PubMed E-Utilities — search + fetch abstracts. */
export interface PubMedArticleSummary {
  readonly pmid: string;
  readonly title: string;
  readonly journal?: string;
  readonly pubDate?: string;
  readonly authors: readonly string[];
  readonly url: string;
}

export class PubMedClient {
  constructor(private readonly http: HttpFetcher, private readonly base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils') {}
  async searchPmids(query: string, opts: { retmax?: number } = {}): Promise<readonly string[]> {
    const url = `${this.base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${opts.retmax ?? 25}&term=${encodeURIComponent(query)}`;
    const raw = await this.http.fetchJson<{ esearchresult?: { idlist?: string[] } }>(url);
    return raw.esearchresult?.idlist ?? [];
  }
  async summarize(pmids: readonly string[]): Promise<readonly PubMedArticleSummary[]> {
    if (pmids.length === 0) return [];
    const url = `${this.base}/esummary.fcgi?db=pubmed&retmode=json&id=${pmids.join(',')}`;
    const raw = await this.http.fetchJson<{ result?: Record<string, unknown> }>(url);
    const result = raw.result ?? {};
    const uids = (result.uids as string[]) ?? [];
    return uids.map((id) => {
      const rec = result[id] as Record<string, unknown> | undefined;
      const authors = ((rec?.authors as Array<{ name: string }> | undefined) ?? []).map((a) => a.name);
      const journal = rec?.fulljournalname as string | undefined;
      const pubDate = rec?.pubdate as string | undefined;
      return {
        pmid: id,
        title: (rec?.title as string) ?? '',
        ...(journal ? { journal } : {}),
        ...(pubDate ? { pubDate } : {}),
        authors,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    });
  }
}

/** RxNav — RxNorm APIs (normalization + interactions). */
export class RxNavClient {
  constructor(private readonly http: HttpFetcher, private readonly base = 'https://rxnav.nlm.nih.gov/REST') {}
  async findRxcuiByName(name: string): Promise<string | undefined> {
    const url = `${this.base}/rxcui.json?name=${encodeURIComponent(name)}`;
    const raw = await this.http.fetchJson<{ idGroup?: { rxnormId?: string[] } }>(url);
    return raw.idGroup?.rxnormId?.[0];
  }
  async getInteractionsForList(rxcuis: readonly string[]): Promise<readonly { severity: string; description: string; drugs: readonly string[] }[]> {
    const url = `${this.base}/interaction/list.json?rxcuis=${rxcuis.join('+')}`;
    const raw = await this.http.fetchJson<{ fullInteractionTypeGroup?: Array<{ fullInteractionType?: Array<{ interactionPair?: Array<{ severity?: string; description?: string; interactionConcept?: Array<{ minConceptItem?: { name?: string } }> }> }> }> }>(url);
    const out: { severity: string; description: string; drugs: string[] }[] = [];
    for (const g of raw.fullInteractionTypeGroup ?? []) {
      for (const t of g.fullInteractionType ?? []) {
        for (const p of t.interactionPair ?? []) {
          out.push({
            severity: p.severity ?? 'unknown',
            description: p.description ?? '',
            drugs: (p.interactionConcept ?? []).map((c) => c.minConceptItem?.name ?? ''),
          });
        }
      }
    }
    return out;
  }
}
