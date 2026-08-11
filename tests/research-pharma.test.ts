import { describe, expect, it } from 'vitest';
import {
  ClinicalTrialsGovClient,
  DailyMedClient,
  OpenFDAClient,
  PubMedClient,
  RxNavClient,
  TrialMatchingService,
  NewMedicationDiscoveryService,
  PharmacovigilanceSignalDetector,
  RESEARCH_SOURCES,
} from '../src/research/index.js';
import type { HttpFetcher } from '../src/research/clients.js';

class StubFetcher implements HttpFetcher {
  constructor(public readonly responses: Map<string, unknown>) {}
  async fetchJson<T = unknown>(url: string): Promise<T> {
    for (const [needle, resp] of this.responses.entries()) if (url.includes(needle)) return resp as T;
    throw new Error(`No stub for ${url}`);
  }
  async fetchText(url: string): Promise<string> { throw new Error(`No stub for ${url}`); }
}

describe('Research + pharma pipeline (M4)', () => {
  it('catalogs 21 public data sources', () => {
    expect(RESEARCH_SOURCES.length).toBe(21);
    const ids = new Set(RESEARCH_SOURCES.map((s) => s.id));
    for (const id of ['clinicaltrials-gov', 'dailymed', 'openfda', 'faers', 'pubmed', 'rxnav'] as const) expect(ids.has(id)).toBe(true);
  });

  it('ClinicalTrialsGovClient parses v2 study envelopes', async () => {
    const stub = new StubFetcher(new Map([
      ['/studies?', {
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT01234567', briefTitle: 'Study of Foo in CKD' },
            statusModule: { overallStatus: 'RECRUITING', startDateStruct: { date: '2024-01-01' } },
            designModule: { phases: ['PHASE3'] },
            conditionsModule: { conditions: ['Chronic Kidney Disease'] },
            armsInterventionsModule: { interventions: [{ name: 'Foo 10mg' }] },
            sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme Pharma' } },
            contactsLocationsModule: { locations: [{ city: 'Nashville', state: 'Tennessee', country: 'United States', status: 'RECRUITING' }] },
          },
        }],
      }],
    ]));
    const ct = new ClinicalTrialsGovClient(stub);
    const studies = await ct.searchStudies({ condition: 'CKD' });
    expect(studies).toHaveLength(1);
    expect(studies[0]!.nctId).toBe('NCT01234567');
    expect(studies[0]!.phase).toBe('PHASE3');
    expect(studies[0]!.conditions).toContain('Chronic Kidney Disease');
  });

  it('TrialMatchingService scores condition + intervention + location', async () => {
    const stub = new StubFetcher(new Map([
      ['/studies?', {
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT9999999', briefTitle: 'Foo Trial' },
            statusModule: { overallStatus: 'RECRUITING' },
            conditionsModule: { conditions: ['Chronic Kidney Disease'] },
            armsInterventionsModule: { interventions: [{ name: 'Sevelamer' }] },
            sponsorCollaboratorsModule: { leadSponsor: { name: 'X' } },
            contactsLocationsModule: { locations: [{ city: 'Nashville', country: 'United States' }] },
          },
        }],
      }],
    ]));
    const ct = new ClinicalTrialsGovClient(stub);
    const svc = new TrialMatchingService(ct);
    const matches = await svc.findMatches({ conditions: ['Chronic Kidney Disease'], medications: ['Sevelamer'], location: 'Nashville' });
    expect(matches.length).toBe(1);
    expect(matches[0]!.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(matches[0]!.matchReasons.some((r) => r.includes('Condition'))).toBe(true);
    expect(matches[0]!.matchReasons.some((r) => r.includes('Intervention'))).toBe(true);
    expect(matches[0]!.matchReasons.some((r) => r.includes('Location'))).toBe(true);
  });

  it('PharmacovigilanceSignalDetector flags high serious-reaction proportion', async () => {
    const stub = new StubFetcher(new Map([
      ['/drug/event.json?search=patient.drug.medicinalproduct:%22atorvastatin%22', {
        results: [
          { serious: '1', patient: { reaction: [{ reactionmeddrapt: 'RHABDOMYOLYSIS' }] } },
          { serious: '1', patient: { reaction: [{ reactionmeddrapt: 'MYOPATHY' }] } },
          { serious: '1', patient: { reaction: [{ reactionmeddrapt: 'HEPATOTOXICITY' }] } },
          { serious: '0', patient: { reaction: [{ reactionmeddrapt: 'RASH' }] } },
          { serious: '1', patient: { reaction: [{ reactionmeddrapt: 'MYOPATHY' }] } },
        ],
      }],
    ]));
    const openfda = new OpenFDAClient(stub);
    const det = new PharmacovigilanceSignalDetector(openfda, 0.4);
    const signals = await det.scan(['atorvastatin']);
    expect(signals.length).toBe(1);
    expect(signals[0]!.seriousProportion).toBeGreaterThanOrEqual(0.4);
    expect(signals[0]!.topReactions).toContain('MYOPATHY');
  });

  it('NewMedicationDiscoveryService composes RxNav + DailyMed + FAERS + PubMed', async () => {
    const stub = new StubFetcher(new Map([
      ['/REST/rxcui.json', { idGroup: { rxnormId: ['12345'] } }],
      ['/rxcuis/12345/spls.json', { data: [{ setid: 'abc-def', title: 'Foo Label', published_date: '2025-01-15' }] }],
      ['/drug/event.json?search=patient.drug.medicinalproduct:%22foo%22', { results: [{ serious: '1', patient: { reaction: [{ reactionmeddrapt: 'HEADACHE' }] } }] }],
      ['/esearch.fcgi?db=pubmed', { esearchresult: { idlist: ['77777'] } }],
      ['/esummary.fcgi?db=pubmed', { result: { uids: ['77777'], '77777': { title: 'Foo Efficacy in Adults', fulljournalname: 'NEJM', pubdate: '2024', authors: [{ name: 'Smith J' }] } } }],
    ]));
    const svc = new NewMedicationDiscoveryService(new DailyMedClient(stub), new OpenFDAClient(stub), new PubMedClient(stub), new RxNavClient(stub));
    const cand = await svc.surveyByGenericName('foo');
    expect(cand).toBeDefined();
    expect(cand!.rxcui).toBe('12345');
    expect(cand!.labelUrl).toContain('setid=abc-def');
    expect(cand!.evidenceLinks.length).toBe(1);
    expect(cand!.signalSummary?.seriousReactions).toBe(1);
    expect(cand!.attributions.length).toBeGreaterThan(0);
  });
});
