import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessBaselineEvidence } from "../baseline-evidence.mjs";
import { collect } from "../collect.mjs";
import { renderReport } from "../report.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function bundle({ meta = null, log = null, marker = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "baseline-evidence-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "logs", "baseline"), { recursive: true });
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "freq"));
  if (meta !== null) writeFileSync(path.join(dir, "results", "baseline.meta"), meta);
  if (log !== null) copyFileSync(path.join(fixtures, log), path.join(dir, "logs", "baseline", "run1.log"));
  if (marker) writeFileSync(path.join(dir, "state", "phase-baseline.done"), "");
  return dir;
}

const validMeta = `CHILDREN=4
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=1
`;
const expectations = { expectedChildren: 4, expectedWaves: 5 };

test("baseline envelope accepts the exact current schema and completed evidence", () => {
  const dir = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  const result = assessBaselineEvidence(dir, expectations);
  assert.equal(result.status, "complete");
  assert.equal(result.reasons.length, 0);
  assert.equal(result.parsed.completionStatus, "complete");
});

test("baseline envelope distinguishes not-run, incomplete artifacts, and pre-mark validation", () => {
  assert.equal(assessBaselineEvidence(bundle(), expectations).status, "not-run");
  assert.equal(assessBaselineEvidence(bundle({ marker: true }), expectations).status, "incomplete");
  assert.equal(assessBaselineEvidence(bundle({ meta: validMeta, marker: true }), expectations).status, "incomplete");
  assert.equal(assessBaselineEvidence(bundle({ log: "repro-fail.log", marker: true }), expectations).status, "incomplete");

  const ready = bundle({ meta: validMeta, log: "repro-fail.log" });
  assert.equal(assessBaselineEvidence(ready, expectations).status, "incomplete");
  assert.equal(
    assessBaselineEvidence(ready, { ...expectations, requireMarker: false }).status,
    "complete",
  );
});

test("baseline metadata rejects malformed, duplicate, unknown, noncanonical, unsafe, and mismatched fields", () => {
  const cases = [
    validMeta.replace("WAVES=5", "not-a-record"),
    validMeta.replace("WAVES=5", "WAVES=5\nWAVES=5"),
    validMeta.replace("WAVES=5", "EXTRA=5"),
    validMeta.replace("CHILDREN=4", "CHILDREN=04"),
    validMeta.replace("CHILDREN=4", "CHILDREN=4e0"),
    validMeta.replace("CHILDREN=4", "CHILDREN=9007199254740992"),
    validMeta.replace("EXIT_CODE=1", "EXIT_CODE=139"),
    validMeta.replace("LOG=logs/baseline/run1.log", "LOG=../../outside.log"),
    validMeta.replace("CHILDREN=4", "CHILDREN=5"),
  ];
  for (const meta of cases) {
    const result = assessBaselineEvidence(
      bundle({ meta, log: "repro-fail.log", marker: true }),
      expectations,
    );
    assert.equal(result.status, "invalid", meta);
  }
});

test("baseline envelope rejects parser/config mismatches and incomplete logs", () => {
  const mismatch = bundle({
    meta: validMeta.replace("CHILDREN=4", "CHILDREN=2").replace("WAVES=5", "WAVES=3").replace("EXIT_CODE=1", "EXIT_CODE=0"),
    log: "repro-clean.log",
    marker: true,
  });
  assert.equal(assessBaselineEvidence(mismatch, expectations).status, "invalid");

  const partial = bundle({
    meta: validMeta.replace("CHILDREN=4", "CHILDREN=2"),
    log: "repro-truncated.log",
    marker: true,
  });
  const result = assessBaselineEvidence(partial, { expectedChildren: 2, expectedWaves: 5 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.parsed.completionStatus, "partial");
});

test("baseline envelope rejects ambiguous or noncanonical stored configuration", () => {
  for (const stored of [
    "BASELINE_CHILDREN=4\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\n",
    "BASELINE_CHILDREN=04\nBASELINE_WAVES=5\n",
    "BASELINE_CHILDREN=4\nBASELINE_WAVES=5e0\n",
    "BASELINE_CHILDREN=4\n",
  ]) {
    const dir = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
    writeFileSync(path.join(dir, "results", "meta.env"), stored);
    const result = assessBaselineEvidence(dir, { ...expectations, validateStoredConfig: true });
    assert.equal(result.status, "invalid", stored);
  }
});

test("baseline envelope never follows symlink, directory, or sampler destinations", () => {
  const outside = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  const targets = [
    ["results/baseline.meta", path.join(outside, "results", "baseline.meta")],
    ["logs/baseline/run1.log", path.join(outside, "logs", "baseline", "run1.log")],
    ["state/phase-baseline.done", path.join(outside, "state", "phase-baseline.done")],
    ["freq/baseline.samples", path.join(outside, "logs", "baseline", "run1.log")],
    ["freq/baseline.method", path.join(outside, "logs", "baseline", "run1.log")],
  ];
  for (const [relative, target] of targets) {
    const dir = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
    const file = path.join(dir, relative);
    rmSync(file, { force: true });
    symlinkSync(target, file);
    const result = assessBaselineEvidence(dir, expectations);
    assert.equal(result.status, "invalid", relative);
    if (relative === "logs/baseline/run1.log") assert.equal(result.parsed, null);
  }

  const directoryLog = bundle({ meta: validMeta, marker: true });
  mkdirSync(path.join(directoryLog, "logs", "baseline", "run1.log"));
  assert.equal(assessBaselineEvidence(directoryLog, expectations).status, "invalid");

  const linkedParent = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  rmSync(path.join(linkedParent, "logs", "baseline"), { recursive: true });
  symlinkSync(path.join(outside, "logs", "baseline"), path.join(linkedParent, "logs", "baseline"));
  const result = assessBaselineEvidence(linkedParent, expectations);
  assert.equal(result.status, "invalid");
  assert.equal(result.parsed, null);
});

test("collector exposes invalid baseline status without reading outside or drawing conclusions", () => {
  const outside = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  const dir = bundle({ meta: validMeta, marker: true });
  writeFileSync(path.join(dir, "results", "meta.env"), "BASELINE_CHILDREN=4\nBASELINE_WAVES=5\n");
  symlinkSync(
    path.join(outside, "logs", "baseline", "run1.log"),
    path.join(dir, "logs", "baseline", "run1.log"),
  );
  const result = collect(dir);
  assert.equal(result.baselineStatus.status, "invalid");
  assert.equal(result.baseline, undefined);
  const report = renderReport(result);
  assert.match(report, /Baseline evidence envelope: \*\*invalid\*\*/);
  assert.match(report, /Invalid baseline evidence was excluded/);
  assert.doesNotMatch(report, /The problem reproduced|No failure reproduced/);
});

test("collector never follows stored-config or results-directory symlinks", () => {
  const outside = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  writeFileSync(
    path.join(outside, "results", "meta.env"),
    "BASELINE_CHILDREN=4\nBASELINE_WAVES=5\n",
  );

  const metaLink = bundle({ meta: validMeta, log: "repro-fail.log", marker: true });
  const metaFile = path.join(metaLink, "results", "meta.env");
  symlinkSync(path.join(outside, "results", "meta.env"), metaFile);
  const metaResult = collect(metaLink);
  assert.equal(metaResult.configStatus.status, "invalid");
  assert.equal(metaResult.config.baselineChildren, null);
  assert.equal(metaResult.baselineStatus.status, "invalid");

  const resultsLink = mkdtempSync(path.join(tmpdir(), "baseline-results-link-"));
  tmpDirs.push(resultsLink);
  symlinkSync(path.join(outside, "results"), path.join(resultsLink, "results"));
  const resultsResult = collect(resultsLink);
  assert.equal(resultsResult.configStatus.status, "invalid");
  assert.equal(resultsResult.baselineStatus.status, "invalid");
  assert.equal(resultsResult.groups, undefined);
});
