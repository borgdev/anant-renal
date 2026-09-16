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

// The dialysis-provider pack's route surface, aggregated.
//
// One entry per module, and every entry is declared HERE, by the pack. The
// platform learns that this specialty serves /admin/swarm/renal,
// /admin/swarm/adequacy, /admin/swarm/mbd and the rest by reading the pack — not
// by naming the modules — which is what makes installing the pack the whole act
// of installing the endpoints, and what makes an uninstalled pack's endpoints
// 404 rather than 403. (404 is the honest answer: the route genuinely does not
// exist. A 403 would claim the caller lacks authority over a surface nobody
// registered.)
//
// REGISTRATION ORDER IS PRESERVED. `rounds` publishes the two round-level lenses
// and reads the SAME windows the fluid pack produces, so fluid is declared before
// it. Reordering this array changes behaviour, which is why the order is written
// the way the platform used to register them rather than alphabetically.

import type { PackRouteContribution } from '../../src/control-plane/pack-contributions.js';
import { renalRoutes } from './renal-routes.js';
import { protocolsRoutes } from './protocol-routes.js';
import { adequacyRoutes } from './adequacy-routes.js';
import { fluidRoutes } from './fluid-routes.js';
import { roundsRoutes } from './round-routes.js';
import { accessRoutes } from './access-routes.js';
import { mbdRoutes } from './mbd-routes.js';
import { nutritionRoutes } from './nutrition-routes.js';
import { infectionRoutes } from './infection-routes.js';
import { anemiaRoutes } from './anemia-routes.js';

/** Every route this pack contributes, in registration order. */
export const dialysisProviderRoutes: readonly PackRouteContribution[] = Object.freeze([
  ...renalRoutes,
  ...protocolsRoutes,
  ...adequacyRoutes,
  ...fluidRoutes,
  ...roundsRoutes,
  ...accessRoutes,
  ...mbdRoutes,
  ...nutritionRoutes,
  ...infectionRoutes,
  ...anemiaRoutes,
]);
