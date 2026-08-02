import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessFrequencyAb,
  collect,
  collectFreqAb,
  collectIndividual,
  summarizeFreqSamples,
} from "../collect.mjs";

// Representative capture from `turbostat --quiet --interval 1` (no --Summary):
// the header repeats every interval, the "- -" row is the whole-system
// summary, CPU 1 is offline ("-" cells), and the busy CPU 2 runs at a higher
// Bzy_MHz than the mostly-idle CPU 0. Note Avg_MHz for CPU 2 (2600/2700)
// differs from its Bzy_MHz (3000), so tests can tell the columns apart.
const PER_CPU_SAMPLES = `Core CPU Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ
- - 1133 37.78 2873 2900 520
0 0 250 10.00 2500 2900 100
0 1 - - - 2900 0
0 2 2600 86.67 3000 2900 420
Core CPU Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ
- - 1200 40.00 2901 2900 560
0 0 300 12.00 2500 2900 120
0 1 - - - 2900 0
0 2 2700 90.00 3000 2900 450
`;

// Capture from the old `turbostat --Summary --quiet --interval 1` sampler:
// one whole-system row per interval and no CPU column (CPU%c1 is a different
// column name and must not be mistaken for it).
const LEGACY_SUMMARY_SAMPLES = `Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ CPU%c1
1133 37.78 2873 2900 520 20.00
1200 40.00 2901 2900 560 18.50
`;

const tmpDirs = [];
function writeCapture(samples, method = "turbostat") {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "freq"));
  writeFileSync(path.join(dir, "freq", "exp.samples"), samples);
  writeFileSync(path.join(dir, "freq", "exp.method"), `${method}\n`);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("summarizeFreqSamples: turbostat per-CPU Bzy_MHz honors cpuFilter", () => {
  const dir = writeCapture(PER_CPU_SAMPLES);
  const pinned = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(pinned.method, "turbostat");
  assert.equal(pinned.samples, 2);
  // Bzy_MHz only: Avg_MHz (2600/2700) would average to 2650.
  assert.equal(pinned.avgMHz, 3000);
  assert.equal(pinned.maxMHz, 3000);
  assert.match(pinned.note, /per-CPU Bzy_MHz/);

  const idle = summarizeFreqSamples(dir, "exp", new Set([0]));
  assert.equal(idle.samples, 2);
  assert.equal(idle.avgMHz, 2500);
  assert.equal(idle.maxMHz, 2500);
});

test("summarizeFreqSamples: turbostat per-CPU aggregates all CPUs without a filter", () => {
  const dir = writeCapture(PER_CPU_SAMPLES);
  const all = summarizeFreqSamples(dir, "exp");
  // CPU 0 and CPU 2 rows only: the "- -" summary rows and the offline
  // CPU 1 rows are skipped.
  assert.equal(all.samples, 4);
  assert.equal(all.avgMHz, 2750);
  assert.equal(all.maxMHz, 3000);
});

test("summarizeFreqSamples: legacy summary is unavailable for a pinned CPU", () => {
  const dir = writeCapture(LEGACY_SUMMARY_SAMPLES);
  const legacy = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(legacy.available, false);
  assert.equal(legacy.samples, 0);
  assert.equal(legacy.avgMHz, undefined);
  assert.equal(legacy.maxMHz, undefined);
  assert.match(legacy.note, /cannot represent the requested CPU selection/);
  assert.match(legacy.note, /omitted/);
});

test("summarizeFreqSamples: legacy summary remains available without a CPU filter", () => {
  const dir = writeCapture(LEGACY_SUMMARY_SAMPLES);
  const legacy = summarizeFreqSamples(dir, "exp");
  assert.equal(legacy.available, true);
  assert.equal(legacy.samples, 2);
  assert.equal(legacy.avgMHz, 1166.5);
  assert.equal(legacy.maxMHz, 1200);
  assert.match(legacy.note, /whole-system summary/);
  assert.match(legacy.note, /including idle time/);
});

test("summarizeFreqSamples: missing samples file is reported unavailable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  const missing = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(missing.available, false);
  assert.equal(missing.samples, undefined);
});

test("collectIndividual: only SIGSEGV is a failure; other nonzero exits are invalid runs", () => {
  const rows = [
    ["7", "1", "0", "2"],
    ["7", "2", "139", "2"],
    ["7", "3", "1", "2"],
    ["7", "4", "126", "0"],
    ["7", "5", "127", "0"],
  ];
  const [rec] = collectIndividual(rows);
  assert.equal(rec.runs, 2); // clean + SIGSEGV only
  assert.equal(rec.failures, 1);
  assert.equal(rec.sigsegv, 1);
  assert.equal(rec.otherFailures, 0); // zero by construction
  assert.deepEqual(rec.failedRuns.map((f) => f.rc), [139]);
  assert.equal(rec.failedRuns[0].signal, "SIGSEGV");
  assert.deepEqual(rec.invalidRuns.map((f) => f.rc), [1, 126, 127]);
  assert.deepEqual(rec.invalidRuns.map((f) => f.signal), ["exit 1", "exit 126", "exit 127"]);
  assert.deepEqual(rec.invalidRuns.map((f) => f.run), [3, 4, 5]);
});

test("collectFreqAb: legs count only clean/SIGSEGV rows as valid runs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  const rows = [
    ["A1", "1", "139", "2"],
    ["A1", "2", "0", "2"],
    ["A1", "3", "1", "2"],
    ["A1", "4", "126", "0"],
    ["B", "1", "0", "3"],
    ["B", "2", "134", "3"], // SIGABRT: another signal, still not the endpoint
  ];
  const res = collectFreqAb(dir, rows, { CPU: "19", LEG_A1_NO_TURBO: "0", LEG_B_NO_TURBO: "1" });
  const [a1, b] = res.legs;
  assert.equal(a1.runs, 2);
  assert.equal(a1.failures, 1);
  assert.equal(a1.sigsegv, 1);
  assert.equal(a1.otherFailures, 0);
  assert.deepEqual(a1.invalidRuns.map((f) => f.rc), [1, 126]);
  assert.equal(b.runs, 1);
  assert.equal(b.failures, 0);
  assert.deepEqual(b.invalidRuns.map((f) => f.signal), ["SIGABRT"]);
});

test("assessFrequencyAb: requires completion, restoration, marker, and exact rows", () => {
  const partial = assessFrequencyAb(
    [["A1", "1", "139", "2"]],
    { RUNS_PER_LEG: "1", RESTORED: "0", COMPLETED: "0" },
    false,
  );
  assert.equal(partial.status, "incomplete");
  assert.match(partial.reasons.join("; "), /completion marker/);
  assert.match(partial.reasons.join("; "), /not marked complete/);
  assert.match(partial.reasons.join("; "), /not verified as restored/);
  assert.match(partial.reasons.join("; "), /frequency modes/);
  assert.match(partial.reasons.join("; "), /every expected/);

  const complete = assessFrequencyAb(
    [
      ["A1", "1", "139", "2"],
      ["B", "1", "0", "3"],
      ["A2", "1", "0", "2"],
    ],
    {
      RUNS_PER_LEG: "1",
      RESTORED: "1",
      COMPLETED: "1",
      LEG_A1_NO_TURBO: "0",
      LEG_B_NO_TURBO: "1",
      LEG_A2_NO_TURBO: "0",
    },
    true,
  );
  assert.deepEqual(complete, { status: "complete", reasons: [] });
});

test("collect: incomplete frequency artifacts are preserved as status, not evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFileSync(path.join(dir, "results", "frequency-ab.tsv"), "A1\t1\t139\t2\n");
  writeFileSync(
    path.join(dir, "results", "frequency-ab.meta"),
    "RUNS_PER_LEG=1\nRESTORED=0\nCOMPLETED=0\n",
  );

  const r = collect(dir);
  assert.equal(r.frequencyAb, undefined);
  assert.equal(r.frequencyAbStatus.status, "incomplete");
});

test("collect: a precreated empty GDB directory is not evidence that GDB ran", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "gdb"));
  const r = collect(dir);
  assert.equal(r.gdb, undefined);
});

test("collect: terminal GDB metadata distinguishes no-fault from failure", () => {
  const noFaultDir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(noFaultDir);
  mkdirSync(path.join(noFaultDir, "results"));
  mkdirSync(path.join(noFaultDir, "state"));
  writeFileSync(path.join(noFaultDir, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\n");
  writeFileSync(path.join(noFaultDir, "state", "phase-gdb.done"), "");
  const noFault = collect(noFaultDir);
  assert.equal(noFault.gdb.status, "no-fault");

  const failedDir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(failedDir);
  mkdirSync(path.join(failedDir, "results"));
  writeFileSync(path.join(failedDir, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=6\nEXIT_CODE=5\n");
  const failed = collect(failedDir);
  assert.equal(failed.gdb.status, "failed");
});

test("collect: worstCpu ranks by SIGSEGV, ignoring non-SIGSEGV exits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  // CPU 3 "fails" every run with a launcher-style exit 1; CPU 4 has one real
  // SIGSEGV. Only CPU 4 may be ranked worst.
  writeFileSync(
    path.join(dir, "results", "individual.tsv"),
    "3\t1\t1\t2\n3\t2\t1\t2\n3\t3\t1\t2\n3\t4\t1\t2\n" +
      "4\t1\t139\t2\n4\t2\t0\t2\n4\t3\t0\t2\n4\t4\t0\t2\n",
  );
  const r = collect(dir);
  assert.equal(r.worstCpu, 4);
  const cpu3 = r.individual.find((c) => c.cpu === 3);
  assert.equal(cpu3.runs, 0);
  assert.equal(cpu3.failures, 0);
  assert.equal(cpu3.invalidRuns.length, 4);
  const cpu4 = r.individual.find((c) => c.cpu === 4);
  assert.equal(cpu4.runs, 4);
  assert.equal(cpu4.sigsegv, 1);
});
