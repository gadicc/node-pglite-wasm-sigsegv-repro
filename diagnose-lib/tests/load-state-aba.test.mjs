import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseController,
  parseArgs,
  summarize,
} from "../../load-state-aba.mjs";

test("load A/B/A arguments resolve safe defaults", () => {
  const options = parseArgs([]);
  assert.equal(options.targetCpu, 19);
  assert.deepEqual(options.loadCpus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(options.runs, 20);
  assert.equal(options.yes, false);
});

test("load A/B/A rejects overlap and conflicting execution flags", () => {
  assert.throws(
    () => parseArgs(["--target-cpu", "19", "--load-cpus", "18-20"]),
    /must not be in --load-cpus/,
  );
  assert.throws(
    () => parseArgs(["--yes", "--dry-run"]),
    /choose --yes or --dry-run/,
  );
});

test("controller selection excludes target and load CPUs", () => {
  assert.equal(chooseController("auto", 19, [0, 1, 2], [0, 1, 2, 8, 19]), 8);
  assert.throws(
    () => chooseController(2, 19, [0, 1, 2], [0, 1, 2, 8, 19]),
    /outside target\/load sets/,
  );
});

test("summary keeps the three controlled legs separate", () => {
  const summary = summarize([
    { phase: "A1", outcome: "pass" },
    { phase: "B", outcome: "sigsegv" },
    { phase: "B", outcome: "pass" },
    { phase: "A2", outcome: "other_failure" },
  ]);
  assert.deepEqual(summary.map((item) => [
    item.phase,
    item.attempted,
    item.sigsegv,
    item.otherFailure,
  ]), [
    ["A1", 1, 0, 0],
    ["B", 2, 1, 0],
    ["A2", 1, 0, 1],
  ]);
});
