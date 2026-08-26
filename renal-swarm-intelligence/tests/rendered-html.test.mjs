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
