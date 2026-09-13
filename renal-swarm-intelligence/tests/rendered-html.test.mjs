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
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("deployable bundle contains product and social metadata", async () => {
  const serverBundle = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(serverBundle, /Renal Swarm Intelligence/);
  assert.match(serverBundle, /renal-swarm-intelligence\.bayyagari\.chatgpt\.site/);
  assert.match(serverBundle, /A governed business outcome harness for dialysis/);
  assert.match(serverBundle, /\/og\.png/);
  await access(new URL("../dist/client/og.png", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0000_productive_mandroid.sql", import.meta.url));
});
