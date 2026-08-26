import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const snapshot = JSON.parse(await readFile(new URL("../config/public-benchmarks.json", import.meta.url), "utf8"));
const response = await fetch(snapshot.datasetUrl, { headers: { accept: "application/json" } });
assert.equal(response.ok, true, `CMS Provider Data returned ${response.status}`);
const rows = await response.json();

for (const benchmark of snapshot.benchmarks) {
  const row = rows.find((item) => item.CCN === snapshot.ccn && item.year === snapshot.period && item.Measure_ID === benchmark.measureId);
  assert.ok(row, `CMS row missing for ${benchmark.measureId}`);
  assert.equal(row.Provider_Name, snapshot.facility, `Facility name drift for ${benchmark.measureId}`);
  assert.ok(Math.abs(Number(row.Measure_Score) - benchmark.rawValue) < 1e-10, `Measure value drift for ${benchmark.measureId}`);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const hash = createHash("sha256").update(`${stable(snapshot.benchmarks)}\n`).digest("hex");
assert.equal(hash, snapshot.rowSetSha256, "Stored public benchmark snapshot hash does not match its rows");
console.log(`Verified ${snapshot.benchmarks.length} CMS rows for CCN ${snapshot.ccn} (${snapshot.period}); snapshot ${hash}.`);
