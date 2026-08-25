/******************************************************************************
 * CMS routes — real public CMS QIP / Dialysis Facility Compare readiness,
 * parsed from the `cms-data/` CSV datasets (no hardcoded percentages).
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import { loadQipReadiness } from '../cms/qip.js';

export async function registerCmsRoutes(app: FastifyInstance): Promise<void> {
  // Per-measure submission readiness (scored/eligible facilities) + national
  // averages from the real CMS datasets. Falls back to reference values (with
  // source:'reference') when cms-data/ is absent.
  app.get('/admin/cms/readiness', async () => ({ readiness: loadQipReadiness() }));
}
