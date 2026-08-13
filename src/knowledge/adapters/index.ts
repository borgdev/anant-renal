// Adapter registry factory — wires every seeded source to an adapter and returns a ready registry.

import type { KnowledgeSourceSpec } from '../types.js';
import { AdapterRegistry } from '../adapter-registry.js';
import { openFdaLabelAdapter, openFdaEventAdapter, openFdaEnforcementAdapter } from './openfda.js';
import { rxnormAdapter, rxnavInteractionAdapter } from './rxnav.js';
import { dailymedAdapter } from './dailymed.js';
import { pubmedAdapter } from './pubmed.js';
import { medlinePlusAdapter } from './medlineplus.js';
import { clinicalTrialsAdapter } from './clinicaltrials.js';
import { cqframeworkAdapter } from './cqframework.js';
import { htmlAdapter } from './html.js';
import { pdfAdapter } from './pdf.js';
import { vsacAdapter } from './vsac.js';
import { umlsAdapter } from './umls.js';
import { loincAdapter } from './loinc.js';

/**
 * Deterministic map from source id → adapter kind.
 * Kept in this single file so audits are cheap.
 */
export function buildAdapterRegistry(sources: KnowledgeSourceSpec[]): AdapterRegistry {
  const reg = new AdapterRegistry();
  // Register every adapter implementation once
  for (const a of [
    openFdaLabelAdapter, openFdaEventAdapter, openFdaEnforcementAdapter,
    rxnormAdapter, rxnavInteractionAdapter,
    dailymedAdapter, pubmedAdapter, medlinePlusAdapter, clinicalTrialsAdapter,
    cqframeworkAdapter, htmlAdapter, pdfAdapter,
    vsacAdapter, umlsAdapter, loincAdapter,
  ]) {
    reg.registerAdapter(a);
  }
  for (const src of sources) {
    const kind = resolveAdapterKind(src.id);
    if (kind) reg.bind(src.id, kind);
  }
  return reg;
}

function resolveAdapterKind(id: string): string | undefined {
  switch (id) {
    // Public APIs
    case 'openfda.drug.label': return 'openfda-label';
    case 'openfda.drug.event': return 'openfda-event';
    case 'openfda.drug.enforcement': return 'openfda-enforcement';
    case 'nlm.rxnorm': return 'rxnav-rxnorm';
    case 'nlm.rxnav.interaction': return 'rxnav-interaction';
    case 'nlm.dailymed.spl': return 'dailymed-spl';
    case 'nlm.pubmed': return 'pubmed-eutils';
    case 'nlm.medlineplus': return 'medlineplus';
    case 'clinicaltrials.v2': return 'clinicaltrials-v2';
    case 'cms.ecqm.qicore.2025': return 'cqframework-gh';
    // Tier-2
    case 'nlm.vsac': return 'vsac';
    case 'nlm.umls': return 'umls';
    case 'loinc.fhir': return 'loinc-fhir';
    // PDF
    case 'cdc.nhsn.psc.manual':
    case 'aap.bright.futures':
      return 'pdf-doc';
    // Everything else HTML by default (CDC pages, society pages, IHE, openEHR, CMS IOMs, data.cms.gov landing)
    default: return 'html-page';
  }
}
