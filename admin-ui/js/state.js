/*
 * Shared mutable state for the operator console (S3).
 *
 * These were top-level `let` declarations in app.js. They cannot simply be exported
 * and reused: ESM gives an importer a read-only view of a live binding, so a view
 * writing `currentView = x` would throw. One mutable singleton keeps reads and
 * writes legal from every module, and the names are explicit here rather than being
 * implicit globals.
 */
import { FALLBACK_DOMAIN } from './core/api.js';

export const S = {
  PACKS: ['flagship-agents','dialysis-deep','primary-care-deep','urgent-care-deep','research-pharma','dialysis-provider'],
  currentView: 'summary',
  dom: FALLBACK_DOMAIN,
  fhirBundleText: '',
  fhirResult: null,
  fhirSel: '',
  realmDeepLink: '',
  realmSel: '',
  sessionUser: null,
  settingsEdit: '',
  settingsTab: 'facilities',
  wiDeepLink: null,
  wsOntology: null,
  wsOntologyRealized: null,
};
