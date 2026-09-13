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
