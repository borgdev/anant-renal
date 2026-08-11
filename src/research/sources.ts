// Public clinical-research and pharma data-source catalog. Each source is
// declared with its canonical URL, licensing/attribution requirements, and
// the shape of the records it emits so callers can bind it to workflows
// (trial matching, formulary updates, adverse-event surveillance, evidence
// synthesis for guidelines, etc.).

export type ResearchSourceId =
  | 'clinicaltrials-gov'          // NLM registry of clinical studies
  | 'dailymed'                    // NLM structured drug labels (SPL)
  | 'orange-book'                 // FDA Approved Drug Products with Therapeutic Equivalence Evaluations
  | 'purple-book'                 // FDA Licensed Biological Products
  | 'drugs-at-fda'                // FDA drug approvals + review documents
  | 'pubmed'                      // NLM biomedical literature
  | 'pmc'                         // PubMed Central full text
  | 'faers'                       // FDA Adverse Event Reporting System
  | 'vaers'                       // Vaccine Adverse Event Reporting System
  | 'openfda'                     // openFDA APIs (drug, device, food, animal)
  | 'nih-reporter'                // NIH grant + funded-research reporter
  | 'medlineplus'                 // NLM patient-facing drug/condition info
  | 'rxnav'                       // NLM RxNorm APIs (RxTerms, ATC, interactions)
  | 'aers-med-effects'            // Pharmacovigilance sentinel signals
  | 'usp-national-formulary'      // USP-NF (compounding standards)
  | 'sentinel-cdrh'               // FDA CDRH device Sentinel initiative
  | 'euro-clinicaltrials'         // EU CTIS Clinical Trials Information System
  | 'who-ictrp'                   // WHO International Clinical Trials Registry Platform
  | 'cochrane'                    // Cochrane systematic reviews
  | 'uspstf'                      // U.S. Preventive Services Task Force
  | 'nice-guidelines';            // UK National Institute for Health and Care Excellence

export type ResearchSourceCategory =
  | 'trial-registry'
  | 'drug-label'
  | 'drug-approval'
  | 'literature'
  | 'pharmacovigilance'
  | 'guidelines'
  | 'grants'
  | 'patient-education';

export interface ResearchSource {
  readonly id: ResearchSourceId;
  readonly title: string;
  readonly category: ResearchSourceCategory;
  readonly authority: 'NLM' | 'FDA' | 'NIH' | 'WHO' | 'EMA' | 'USPSTF' | 'NICE' | 'Cochrane' | 'USP';
  readonly baseUrl: string;
  readonly apiKind: 'REST-JSON' | 'REST-XML' | 'FHIR' | 'bulk-download' | 'HTTP-scrape';
  readonly rateLimitPerMinute?: number;
  readonly attributionRequired: boolean;
  readonly attributionText?: string;
  readonly licenseNotes?: string;
}

export const RESEARCH_SOURCES: readonly ResearchSource[] = Object.freeze([
  {
    id: 'clinicaltrials-gov',
    title: 'ClinicalTrials.gov',
    category: 'trial-registry',
    authority: 'NLM',
    baseUrl: 'https://clinicaltrials.gov/api/v2',
    apiKind: 'REST-JSON',
    rateLimitPerMinute: 300,
    attributionRequired: true,
    attributionText: 'Data courtesy of the U.S. National Library of Medicine.',
  },
  {
    id: 'dailymed',
    title: 'DailyMed',
    category: 'drug-label',
    authority: 'NLM',
    baseUrl: 'https://dailymed.nlm.nih.gov/dailymed/services/v2',
    apiKind: 'REST-JSON',
    rateLimitPerMinute: 120,
    attributionRequired: true,
    attributionText: 'DailyMed content provided by U.S. National Library of Medicine.',
  },
  {
    id: 'orange-book',
    title: 'FDA Orange Book (Approved Drug Products with Therapeutic Equivalence Evaluations)',
    category: 'drug-approval',
    authority: 'FDA',
    baseUrl: 'https://api.fda.gov/drug/ndc.json',
    apiKind: 'REST-JSON',
    attributionRequired: false,
    licenseNotes: 'openFDA data is public domain.',
  },
  {
    id: 'purple-book',
    title: 'FDA Purple Book (Licensed Biological Products)',
    category: 'drug-approval',
    authority: 'FDA',
    baseUrl: 'https://purplebooksearch.fda.gov',
    apiKind: 'HTTP-scrape',
    attributionRequired: false,
  },
  {
    id: 'drugs-at-fda',
    title: 'Drugs@FDA',
    category: 'drug-approval',
    authority: 'FDA',
    baseUrl: 'https://api.fda.gov/drug/drugsfda.json',
    apiKind: 'REST-JSON',
    attributionRequired: false,
  },
  {
    id: 'pubmed',
    title: 'PubMed E-Utilities',
    category: 'literature',
    authority: 'NLM',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    apiKind: 'REST-XML',
    rateLimitPerMinute: 180,
    attributionRequired: true,
    attributionText: 'Data from NCBI/NLM E-utilities.',
  },
  {
    id: 'pmc',
    title: 'PubMed Central',
    category: 'literature',
    authority: 'NLM',
    baseUrl: 'https://www.ncbi.nlm.nih.gov/pmc/utils',
    apiKind: 'REST-XML',
    attributionRequired: true,
  },
  {
    id: 'faers',
    title: 'FAERS (FDA Adverse Event Reporting System)',
    category: 'pharmacovigilance',
    authority: 'FDA',
    baseUrl: 'https://api.fda.gov/drug/event.json',
    apiKind: 'REST-JSON',
    attributionRequired: false,
  },
  {
    id: 'vaers',
    title: 'VAERS (Vaccine Adverse Event Reporting System)',
    category: 'pharmacovigilance',
    authority: 'FDA',
    baseUrl: 'https://wonder.cdc.gov/vaers.html',
    apiKind: 'bulk-download',
    attributionRequired: true,
    attributionText: 'VAERS data from CDC/FDA. Interpretation subject to VAERS limitations.',
  },
  {
    id: 'openfda',
    title: 'openFDA',
    category: 'drug-approval',
    authority: 'FDA',
    baseUrl: 'https://api.fda.gov',
    apiKind: 'REST-JSON',
    rateLimitPerMinute: 240,
    attributionRequired: false,
  },
  {
    id: 'nih-reporter',
    title: 'NIH RePORTER',
    category: 'grants',
    authority: 'NIH',
    baseUrl: 'https://api.reporter.nih.gov/v2',
    apiKind: 'REST-JSON',
    attributionRequired: false,
  },
  {
    id: 'medlineplus',
    title: 'MedlinePlus Connect',
    category: 'patient-education',
    authority: 'NLM',
    baseUrl: 'https://connect.medlineplus.gov/service',
    apiKind: 'REST-JSON',
    attributionRequired: true,
    attributionText: 'Content courtesy of MedlinePlus, National Library of Medicine.',
  },
  {
    id: 'rxnav',
    title: 'RxNav (RxNorm / Interaction APIs)',
    category: 'drug-label',
    authority: 'NLM',
    baseUrl: 'https://rxnav.nlm.nih.gov/REST',
    apiKind: 'REST-JSON',
    attributionRequired: true,
    attributionText: 'RxNorm and interaction data from U.S. National Library of Medicine.',
  },
  {
    id: 'aers-med-effects',
    title: 'Pharmacovigilance signal-detection (composite)',
    category: 'pharmacovigilance',
    authority: 'FDA',
    baseUrl: 'https://api.fda.gov/drug/event.json',
    apiKind: 'REST-JSON',
    attributionRequired: false,
  },
  {
    id: 'usp-national-formulary',
    title: 'USP National Formulary',
    category: 'drug-label',
    authority: 'USP',
    baseUrl: 'https://online.uspnf.com',
    apiKind: 'HTTP-scrape',
    attributionRequired: true,
    licenseNotes: 'USP-NF full text requires subscription; metadata public.',
  },
  {
    id: 'sentinel-cdrh',
    title: 'FDA Sentinel (CDRH)',
    category: 'pharmacovigilance',
    authority: 'FDA',
    baseUrl: 'https://www.sentinelinitiative.org',
    apiKind: 'HTTP-scrape',
    attributionRequired: true,
  },
  {
    id: 'euro-clinicaltrials',
    title: 'EU Clinical Trials Information System (CTIS)',
    category: 'trial-registry',
    authority: 'EMA',
    baseUrl: 'https://euclinicaltrials.eu/ctis-public-api',
    apiKind: 'REST-JSON',
    attributionRequired: true,
  },
  {
    id: 'who-ictrp',
    title: 'WHO International Clinical Trials Registry Platform',
    category: 'trial-registry',
    authority: 'WHO',
    baseUrl: 'https://trialsearch.who.int',
    apiKind: 'REST-XML',
    attributionRequired: true,
  },
  {
    id: 'cochrane',
    title: 'Cochrane Library',
    category: 'guidelines',
    authority: 'Cochrane',
    baseUrl: 'https://www.cochranelibrary.com',
    apiKind: 'HTTP-scrape',
    attributionRequired: true,
    licenseNotes: 'Full-text requires subscription; abstracts open.',
  },
  {
    id: 'uspstf',
    title: 'U.S. Preventive Services Task Force',
    category: 'guidelines',
    authority: 'USPSTF',
    baseUrl: 'https://www.uspreventiveservicestaskforce.org',
    apiKind: 'REST-JSON',
    attributionRequired: true,
  },
  {
    id: 'nice-guidelines',
    title: 'NICE Guidelines',
    category: 'guidelines',
    authority: 'NICE',
    baseUrl: 'https://www.nice.org.uk',
    apiKind: 'HTTP-scrape',
    attributionRequired: true,
  },
]);
