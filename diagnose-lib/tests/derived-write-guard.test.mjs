import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collect } from "../collect.mjs";
import { writeReport } from "../report.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function readyBundle() {
  const root = mkdtempSync(path.join(tmpdir(), "derived-write-guard-"));
  roots.push(root);
  mkdirSync(path.join(root, "results"));
  writeFileSync(path.join(root, "results.json"), "{\"sentinel\":true}\n");
  writeFileSync(path.join(root, "report.md"), "sentinel report\n");
  writeFileSync(path.join(root, "manifest.txt"), "stale readiness token\n");
  return root;
}

test("standalone collection cannot invalidate a manifested bundle", () => {
  const root = readyBundle();
  assert.throws(
    () => collect(root),
    /refusing to overwrite results\.json in a manifested bundle/,
  );
  assert.equal(readFileSync(path.join(root, "results.json"), "utf8"), "{\"sentinel\":true}\n");

  const explicit = path.join(root, ".results.json.candidate");
  assert.doesNotThrow(() => collect(root, { outputFile: explicit, exclusiveOutput: true }));
  assert.match(readFileSync(explicit, "utf8"), /"schemaVersion": 1/);
});

test("standalone report generation cannot invalidate a manifested bundle", () => {
  const root = readyBundle();
  writeFileSync(path.join(root, "results-input.json"), JSON.stringify({
    collectedAt: "2026-08-09T00:00:00.000Z",
    config: {},
  }));
  assert.throws(
    () => writeReport(root),
    /refusing to overwrite report\.md in a manifested bundle/,
  );
  assert.equal(readFileSync(path.join(root, "report.md"), "utf8"), "sentinel report\n");

  const explicit = path.join(root, ".report.md.candidate");
  assert.doesNotThrow(() => writeReport(root, {
    resultsFile: path.join(root, "results-input.json"),
    outputFile: explicit,
    exclusiveOutput: true,
  }));
  assert.match(readFileSync(explicit, "utf8"), /^# Diagnostic report:/);
});
