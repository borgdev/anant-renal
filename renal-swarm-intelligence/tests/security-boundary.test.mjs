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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("client bundles cannot import server, database or authorization modules", async () => {
  const clientFiles = [
    "app/product-shell.tsx",
    "app/components/agent-operations.tsx",
    "app/components/workflow-detail-drawer.tsx",
    "lib/control-plane/client.ts",
  ];
  for (const file of clientFiles) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.equal(/from ["'][^"']*(?:lib\/server|db\/|runtime\/engine|runtime\/authorization)/.test(source), false, file + " crossed the trust boundary");
  }
});

test("work-item details are resolved server-side and the UI fails closed", async () => {
  const [shell, route, resolver] = await Promise.all([
    readFile(new URL("app/product-shell.tsx", root), "utf8"),
    readFile(new URL("app/api/v1/work-items/route.ts", root), "utf8"),
    readFile(new URL("lib/server/work-item-context.ts", root), "utf8"),
  ]);
  assert.match(shell, /fetchWorkItemContext/);
  assert.match(shell, /No client fallback/);
  assert.match(route, /actorFromRequest/);
  assert.match(route, /requireAdapterOrOperator/);
  assert.match(resolver, /authorizedForScope/);
  assert.match(resolver, /Exact patient-authored text withheld/);
  assert.match(resolver, /serverAssembled: true/);
});

test("agent mutations enforce JSON, origin and same-site boundaries", async () => {
  const [route, security] = await Promise.all([
    readFile(new URL("app/api/v1/agents/route.ts", root), "utf8"),
    readFile(new URL("lib/server/request-security.ts", root), "utf8"),
  ]);
  assert.match(route, /requireTrustedJsonMutation/);
  assert.match(security, /CROSS_SITE_MUTATION_BLOCKED/);
  assert.match(security, /ORIGIN_MISMATCH/);
  assert.match(security, /REQUEST_TOO_LARGE/);
  assert.match(security, /private, no-store/);
});
