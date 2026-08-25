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
 * Except as expressly permitted by a written license agreement,
 * no person or organization may copy, modify, distribute, or use this file.
 *
 ******************************************************************************/

// Production entrypoint.
//
// Runs the AnantHealth server against real Postgres + Redis (see bootstrap.ts).
// Executed as `node dist/src/server/prod.js` inside the Docker image (or via
// `npm run start:prod` after `npm run build`).

import { main } from './bootstrap.js';

main().catch((err: unknown) => {
  console.error('[anant-health] fatal bootstrap error', err);
  process.exit(1);
});
