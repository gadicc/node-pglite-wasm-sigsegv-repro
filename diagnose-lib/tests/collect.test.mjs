import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessIndividual,
  collect,
  collectFreqAb,
  collectIndividual,
  reconcileIndividualWithGroups,
  resolveExpectedCpu,
  selectWorstIndividualCpu,
  summarizeFreqSamples,
} from "../collect.mjs";
import {
  GDB_TRANSCRIPT_MAX_BYTES,
  buildGdbManifestCandidate,
  newGdbGeneration,
  validateGdbEvidence,
} from "../gdb-evidence.mjs";

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
function writeFixedCpuConfig(dir, cpu = 19) {
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    `MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\n` +
      `INDIVIDUAL_RUNS=1\nGDB_MAX_RUNS=6\nSKIP_GDB=0\nCPU_TARGET=${cpu}\n`,
  );
}

function writeAutoCpuConfig(dir) {
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    `MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\n` +
      `INDIVIDUAL_RUNS=1\nGDB_MAX_RUNS=6\nSKIP_GDB=0\nCPU_TARGET=auto\n`,
  );
}

const GDB_FIXTURE_BODY =
  "Program received signal SIGSEGV, Segmentation fault.\n0x0000000000401234 in ?? ()\n";

// Node mirror of the shell write_gdb_run_fixture: a complete, valid,
// marked-done GDB evidence envelope (runner.log, provenance transcripts for
// retained attempts, the 7-line gdb.meta, and the authoritative manifest
// built, renamed, marker-created, and re-validated).
function writeGdbRunFixture(dir, { cpu = 19, maxRuns = 6, maxCaptures = 3, outcomes, capturedBody } = {}) {
  outcomes ??= Array.from({ length: maxRuns }, (_, index) => (index === 0 ? "captured" : "clean"));
  const generation = newGdbGeneration();
  for (const relative of ["results", "state", "gdb", "logs/gdb"]) {
    mkdirSync(path.join(dir, relative), { recursive: true });
  }
  const counts = { clean: 0, captured: 0, error: 0 };
  const runner = [];
  outcomes.forEach((outcome, index) => {
    const run = index + 1;
    counts[outcome] += 1;
    runner.push(
      `ATTEMPT\tGENERATION\t${generation}\tCPU\t${cpu}\tMAX_RUNS\t${maxRuns}` +
      `\tMAX_CAPTURES\t${maxCaptures}\tRUN\t${run}\tOUTCOME\t${outcome}`,
    );
    if (outcome !== "clean") {
      writeFileSync(
        path.join(dir, "gdb", `cpu${cpu}-run${run}.txt`),
        `GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t${generation}\tCPU\t${cpu}` +
          `\tMAX_RUNS\t${maxRuns}\tMAX_CAPTURES\t${maxCaptures}\tRUN\t${run}\tOUTCOME\t${outcome}\n` +
          (outcome === "captured" ? (capturedBody ?? GDB_FIXTURE_BODY) : "synthetic runner error\n") +
          `GDB_TRANSCRIPT_END\tGENERATION\t${generation}\tCPU\t${cpu}\tRUN\t${run}\tOUTCOME\t${outcome}\n`,
      );
    }
  });
  const exitCode = counts.captured > 0 ? 0 : 3;
  runner.push(
    `COUNTS\tGENERATION\t${generation}\tCPU\t${cpu}\tMAX_RUNS\t${maxRuns}` +
    `\tMAX_CAPTURES\t${maxCaptures}\tATTEMPTED\t${outcomes.length}` +
    `\tCLEAN\t${counts.clean}\tCAPTURED\t${counts.captured}\tERRORS\t${counts.error}` +
    `\tEXIT_CODE\t${exitCode}`,
  );
  writeFileSync(path.join(dir, "logs", "gdb", "runner.log"), `${runner.join("\n")}\n`);
  writeFileSync(
    path.join(dir, "results", "gdb.meta"),
    `CPU=${cpu}\nMAX_RUNS=${maxRuns}\nEXIT_CODE=${exitCode}\nATTEMPTED_RUNS=${outcomes.length}\n` +
      `CLEAN_RUNS=${counts.clean}\nCAPTURED_RUNS=${counts.captured}\nERROR_RUNS=${counts.error}\n`,
  );
  const candidate = path.join(dir, "results", `.gdb.manifest.${generation}`);
  const built = buildGdbManifestCandidate(dir, candidate, {
    generation,
    expectedCpu: cpu,
    expectedMaxRuns: maxRuns,
    expectedMaxCaptures: maxCaptures,
  });
  assert.equal(built.ok, true, built.reasons.join("; "));
  renameSync(candidate, path.join(dir, "results", "gdb.manifest"));
  writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
  const validated = validateGdbEvidence(dir, {
    markerMode: "complete",
    expectedCpu: cpu,
    expectedMaxRuns: maxRuns,
    expectedMaxCaptures: maxCaptures,
  });
  assert.equal(validated.ok, true, validated.reasons.join("; "));
  return { generation, cpu, maxRuns, maxCaptures, outcomes, counts, exitCode };
}

// Skip-envelope variant of writeGdbRunFixture (CPU-independent).
function writeGdbSkipFixture(dir, kind = "--skip-gdb", { maxRuns = 6, maxCaptures = 3 } = {}) {
  const generation = newGdbGeneration();
  for (const relative of ["results", "state", "gdb", "logs/gdb"]) {
    mkdirSync(path.join(dir, relative), { recursive: true });
  }
  writeFileSync(path.join(dir, "results", "gdb.meta"), `SKIPPED=1\nSKIP_REASON=${kind}\n`);
  const candidate = path.join(dir, "results", `.gdb.manifest.${generation}`);
  const built = buildGdbManifestCandidate(dir, candidate, {
    generation,
    expectedCpu: null,
    expectedMaxRuns: maxRuns,
    expectedMaxCaptures: maxCaptures,
  });
  assert.equal(built.ok, true, built.reasons.join("; "));
  renameSync(candidate, path.join(dir, "results", "gdb.manifest"));
  writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
  const validated = validateGdbEvidence(dir, {
    markerMode: "complete",
    expectedCpu: null,
    expectedMaxRuns: maxRuns,
    expectedMaxCaptures: maxCaptures,
  });
  assert.equal(validated.ok, true, validated.reasons.join("; "));
  return { generation, kind, maxRuns, maxCaptures };
}

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

test("selectWorstIndividualCpu compares near-safe-integer rates exactly", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const half = Math.floor(maximum / 2);
  assert.equal(selectWorstIndividualCpu([
    { cpu: 3, runs: maximum, sigsegv: half },
    { cpu: 4, runs: maximum - 4, sigsegv: half - 1 },
  ]), 4);
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
  writeFixedCpuConfig(noFaultDir);
  writeFileSync(path.join(noFaultDir, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\n");
  writeFileSync(path.join(noFaultDir, "state", "phase-gdb.done"), "");
  const noFault = collect(noFaultDir);
  // Without a validated manifest the would-be no-fault result is descriptive.
  assert.equal(noFault.gdb.status, "incomplete");
  assert.match(noFault.gdb.reason, /no validated manifest/);
  assert.equal(noFault.gdb.generation, null);
  assert.equal(noFault.gdb.countsAvailable, false);
  assert.equal(noFault.gdb.cleanRuns, null);

  const failedDir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(failedDir);
  mkdirSync(path.join(failedDir, "results"));
  writeFixedCpuConfig(failedDir);
  writeFileSync(path.join(failedDir, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=6\nEXIT_CODE=5\n");
  const failed = collect(failedDir);
  assert.equal(failed.gdb.status, "failed");
  assert.equal(failed.gdb.generation, null);
});

test("collect: GDB no-fault accounting excludes runner errors from the denominator", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "gdb"));
  writeFixedCpuConfig(dir);
  writeFileSync(
    path.join(dir, "results", "gdb.meta"),
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\nATTEMPTED_RUNS=6\nCLEAN_RUNS=1\nCAPTURED_RUNS=0\nERROR_RUNS=5\n",
  );
  for (let run = 2; run <= 6; run += 1) {
    writeFileSync(path.join(dir, "gdb", `cpu19-run${run}.txt`), "synthetic runner error\n");
  }
  writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
  const result = collect(dir);
  // The accounting stays visible descriptively but cannot authorize no-fault.
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /descriptive only/);
  assert.equal(result.gdb.generation, null);
  assert.equal(result.gdb.attemptedRuns, 6);
  assert.equal(result.gdb.cleanRuns, 1);
  assert.equal(result.gdb.capturedRuns, 0);
  assert.equal(result.gdb.errorRuns, 5);
  assert.equal(result.gdb.countsAvailable, true);
});

test("collect: malformed or contradictory GDB run counts are incomplete", () => {
  for (const [exitCode, counts, reason] of [
    ["3", "ATTEMPTED_RUNS=6\nCLEAN_RUNS=1\nCAPTURED_RUNS=0\nERROR_RUNS=4\n", /run counts/],
    ["3", "ATTEMPTED_RUNS=06\nCLEAN_RUNS=6\nCAPTURED_RUNS=0\nERROR_RUNS=0\n", /run counts/],
    ["3", "ATTEMPTED_RUNS=6\nCLEAN_RUNS=6\nCAPTURED_RUNS=0\n", /run counts/],
    ["3e0", "ATTEMPTED_RUNS=6\nCLEAN_RUNS=6\nCAPTURED_RUNS=0\nERROR_RUNS=0\n", /exit code/],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
    tmpDirs.push(dir);
    mkdirSync(path.join(dir, "results"));
    mkdirSync(path.join(dir, "state"));
    writeFixedCpuConfig(dir);
    writeFileSync(path.join(dir, "results", "gdb.meta"), `CPU=19\nMAX_RUNS=6\nEXIT_CODE=${exitCode}\n${counts}`);
    writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
    const result = collect(dir);
    assert.equal(result.gdb.status, "incomplete");
    assert.match(result.gdb.reason, reason);
  }
});

test("resolveExpectedCpu distinguishes fixed, automatic, absent, and invalid targets", () => {
  const fixed = {
    status: "complete",
    cpuTargetConfig: { status: "complete", policy: "fixed", cpu: 19 },
  };
  assert.deepEqual(resolveExpectedCpu(fixed, { status: "invalid" }, null), {
    status: "resolved", policy: "fixed", cpu: 19, reason: null,
  });

  const automatic = {
    status: "complete",
    cpuTargetConfig: { status: "complete", policy: "auto", cpu: null, legacyDefault: true },
  };
  assert.deepEqual(resolveExpectedCpu(automatic, { status: "complete" }, 7), {
    status: "resolved", policy: "auto", cpu: 7, reason: null,
  });
  assert.equal(resolveExpectedCpu(automatic, { status: "complete" }, null).status, "none");
  assert.equal(resolveExpectedCpu(automatic, { status: "skipped" }, null).status, "none");
  assert.equal(resolveExpectedCpu(automatic, { status: "incomplete" }, 7).status, "unavailable");
  assert.equal(resolveExpectedCpu(automatic, { status: "invalid" }, 7).status, "unavailable");
  assert.equal(resolveExpectedCpu({ ...automatic, status: "invalid" }, { status: "complete" }, 7).status, "invalid");
});

test("collector binds non-skipped GDB evidence while strict skips remain policy-independent", () => {
  const mismatch = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(mismatch);
  mkdirSync(path.join(mismatch, "results"));
  mkdirSync(path.join(mismatch, "state"));
  writeFixedCpuConfig(mismatch, 18);
  writeFileSync(path.join(mismatch, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\n");
  writeFileSync(path.join(mismatch, "state", "phase-gdb.done"), "");
  let result = collect(mismatch);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /does not match/);

  const skipped = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(skipped);
  mkdirSync(path.join(skipped, "results"));
  mkdirSync(path.join(skipped, "state"));
  writeFileSync(path.join(skipped, "results", "meta.env"), "malformed config\n");
  writeFileSync(path.join(skipped, "results", "gdb.meta"), "SKIPPED=1\nSKIP_REASON=--skip-gdb\n");
  writeFileSync(path.join(skipped, "state", "phase-gdb.done"), "");
  result = collect(skipped);
  assert.equal(result.gdb.status, "skipped");

  writeFileSync(path.join(skipped, "results", "gdb.meta"), "CPU=19\nSKIPPED=1\nSKIP_REASON=crafted\n");
  result = collect(skipped);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /non-skip evidence/);

  for (const metadata of [
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\nSKIPPED=0\nSKIP_REASON=crafted\n",
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\nSKIPPED=garbage\n",
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\nSKIP_REASON=crafted\n",
  ]) {
    writeFileSync(path.join(skipped, "results", "gdb.meta"), metadata);
    result = collect(skipped);
    assert.equal(result.gdb.status, "incomplete", metadata);
    assert.match(result.gdb.reason, /skip metadata is malformed/, metadata);
  }

  writeFileSync(path.join(skipped, "results", "gdb.meta"), "SKIPPED=1\nSKIP_REASON=--skip-gdb\n");
  mkdirSync(path.join(skipped, "gdb"));
  writeFileSync(path.join(skipped, "gdb", "leftover.txt"), "clean transcript\n");
  result = collect(skipped);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /retained GDB transcripts/);
});

test("collect: a validated captured GDB envelope authorizes the captured conclusion", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  const fixture = writeGdbRunFixture(dir, { outcomes: ["captured", "captured", "captured"] });
  const result = collect(dir);
  assert.equal(result.gdb.status, "captured");
  assert.equal(result.gdb.reason, null);
  assert.equal(result.gdb.generation, fixture.generation);
  assert.equal(result.gdb.attemptedRuns, 3);
  assert.equal(result.gdb.cleanRuns, 0);
  assert.equal(result.gdb.capturedRuns, 3);
  assert.equal(result.gdb.errorRuns, 0);
  assert.equal(result.gdb.countsAvailable, true);
  assert.equal(result.gdb.cpu, 19);
  assert.equal(result.gdb.maxRuns, 6);
  assert.equal(result.gdb.exitCode, 0);
  assert.equal(result.gdb.captures.length, 3);
  assert.equal(result.gdb.captures[0].captured, true);
  assert.equal(result.gdb.captures[0].mappings, undefined);
  assert.equal(result.gdb.captures[0].file, "gdb/cpu19-run1.txt");
  assert.equal(result.gdb.capturesIdentical, true);
});

test("collect: a validated no-fault GDB envelope authorizes the no-fault conclusion", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  const fixture = writeGdbRunFixture(dir, {
    outcomes: ["clean", "clean", "clean", "clean", "clean", "clean"],
  });
  const result = collect(dir);
  assert.equal(result.gdb.status, "no-fault");
  assert.equal(result.gdb.generation, fixture.generation);
  assert.equal(result.gdb.attemptedRuns, 6);
  assert.equal(result.gdb.cleanRuns, 6);
  assert.equal(result.gdb.capturedRuns, 0);
  assert.equal(result.gdb.errorRuns, 0);
  assert.equal(result.gdb.countsAvailable, true);
  assert.equal(result.gdb.cpu, 19);
  assert.equal(result.gdb.exitCode, 3);
  assert.deepEqual(result.gdb.captures, []);
  assert.equal(result.gdb.capturesIdentical, null);
});

test("collect: a validated skip GDB envelope stays skipped and CPU-independent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  const fixture = writeGdbSkipFixture(dir, "no failing CPU identified");
  const result = collect(dir);
  assert.equal(result.gdb.status, "skipped");
  assert.equal(result.gdb.reason, "no failing CPU identified");
  assert.equal(result.gdb.generation, fixture.generation);
  assert.deepEqual(result.gdb.captures, []);
});

test("collect: a transcript tampered after publication fails closed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  writeGdbRunFixture(dir, { outcomes: ["captured", "captured", "captured"] });
  appendFileSync(path.join(dir, "gdb", "cpu19-run1.txt"), "tampered\n");
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /GDB evidence failed validation/);
});

test("collect: a tampered GDB manifest fails closed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  const fixture = writeGdbRunFixture(dir, { outcomes: ["captured", "captured", "captured"] });
  const manifest = path.join(dir, "results", "gdb.manifest");
  const flipped = fixture.generation.startsWith("a") ? "b" : "a";
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      `GENERATION\t${fixture.generation}`,
      `GENERATION\t${flipped}${fixture.generation.slice(1)}`,
    ),
  );
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /GDB evidence failed validation/);
});

test("collect: run GDB evidence without a resolvable CPU target is incomplete", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  // CPU_TARGET=auto with no individual evidence: nothing authorizes CPU 19.
  writeAutoCpuConfig(dir);
  writeGdbRunFixture(dir, { outcomes: ["clean", "clean", "clean", "clean", "clean", "clean"] });
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /automatic CPU selection requires/);
});

test("collect: legacy captured GDB evidence without a manifest cannot authorize conclusions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "gdb"));
  writeFixedCpuConfig(dir, 19);
  writeFileSync(
    path.join(dir, "results", "gdb.meta"),
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=0\nATTEMPTED_RUNS=1\nCLEAN_RUNS=0\nCAPTURED_RUNS=1\nERROR_RUNS=0\n",
  );
  writeFileSync(path.join(dir, "gdb", "cpu19-run1.txt"), GDB_FIXTURE_BODY);
  writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.notEqual(result.gdb.status, "captured");
  assert.match(result.gdb.reason, /no validated manifest/);
  assert.match(result.gdb.reason, /descriptive only/);
  assert.match(result.gdb.reason, /cannot authorize/);
  assert.equal(result.gdb.generation, null);
  // The parsed capture stays available as descriptive detail only.
  assert.equal(result.gdb.captures.length, 1);
  assert.equal(result.gdb.captures[0].captured, true);
});

test("collect: oversized legacy GDB metadata is bounded and incomplete", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFileSync(
    path.join(dir, "results", "gdb.meta"),
    `CPU=19\nMAX_RUNS=6\nEXIT_CODE=3\n${"x".repeat(8192)}\n`,
  );
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /size limit/);
});

test("collect: oversized legacy GDB transcripts are bounded and incomplete", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "gdb"));
  writeFixedCpuConfig(dir, 19);
  writeFileSync(
    path.join(dir, "results", "gdb.meta"),
    "CPU=19\nMAX_RUNS=6\nEXIT_CODE=0\nATTEMPTED_RUNS=1\nCLEAN_RUNS=0\nCAPTURED_RUNS=1\nERROR_RUNS=0\n",
  );
  const transcript = path.join(dir, "gdb", "cpu19-run1.txt");
  writeFileSync(transcript, "\n");
  truncateSync(transcript, GDB_TRANSCRIPT_MAX_BYTES + 1);
  writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /size limit/);
});

test("collect: an over-limit GDB directory listing is bounded and incomplete", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "gdb"));
  for (let index = 0; index <= 256; index += 1) {
    writeFileSync(path.join(dir, "gdb", `run${index}.txt`), "x\n");
  }
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /entry limit/);
});

test("assessIndividual: exact completion and partial prefixes have explicit status", () => {
  const meta = { VERSION: "1", TARGET_CPUS: "3-4", RUNS_PER_CPU: "2", SKIPPED: "0", COMPLETED: "1" };
  const complete = assessIndividual([
    ["3", "1", "0", "2"], ["3", "2", "0", "2"],
    ["4", "1", "139", "2"], ["4", "2", "0", "2"],
  ], meta, true);
  assert.equal(complete.status, "complete");
  assert.equal(complete.acceptedRows.length, 4);

  const partial = assessIndividual(
    [["3", "1", "0", "2"], ["4", "1", "139", "2"]],
    { ...meta, COMPLETED: "0" },
    false,
  );
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.acceptedRows.length, 2);
  assert.match(partial.reasons.join("; "), /every expected/);

  const skipped = assessIndividual([], {
    VERSION: "1", TARGET_CPUS: "", RUNS_PER_CPU: "5", SKIPPED: "1", COMPLETED: "1",
    SKIP_REASON: "no-failing-group-in-quick-mode",
  }, true);
  assert.equal(skipped.status, "skipped");
});

test("assessIndividual: malformed, foreign, and non-contiguous rows are invalid", () => {
  const result = assessIndividual([
    ["3", "1", "0", "2"],
    ["3", "3", "139", "2"],
    ["5", "1", "0", "2"],
    ["4", "01", "0", "2"],
    ["4", "1", "126", "0"],
  ], { VERSION: "1", TARGET_CPUS: "3-4", RUNS_PER_CPU: "2", SKIPPED: "0", COMPLETED: "1" }, true);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.acceptedRows, []);
  assert.match(result.reasons.join("; "), /malformed, non-target, non-SIGSEGV, duplicate, or non-contiguous/);
});

test("collect: invalid individual evidence cannot select worstCpu", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  // CPU 3 "fails" every run with a launcher-style exit 1; CPU 4 has one real
  // SIGSEGV. Only CPU 4 may be ranked worst.
  writeFileSync(
    path.join(dir, "results", "individual.tsv"),
    "3\t1\t1\t2\n3\t2\t1\t2\n3\t3\t1\t2\n3\t4\t1\t2\n" +
      "4\t1\t139\t2\n4\t2\t0\t2\n4\t3\t0\t2\n4\t4\t0\t2\n",
  );
  writeFileSync(
    path.join(dir, "results", "individual.meta"),
    "VERSION=1\nTARGET_CPUS=3-4\nRUNS_PER_CPU=4\nSKIPPED=0\nCOMPLETED=1\n",
  );
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  const r = collect(dir);
  assert.equal(r.individualStatus.status, "invalid");
  assert.equal(r.worstCpu, null);
  assert.equal(r.individual, undefined);
  assert.match(r.individualStatus.reasons.join("; "), /group evidence is unavailable/);
});

test("collect: self-consistent individual evidence is non-authoritative without groups", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  writeFileSync(path.join(dir, "results", "individual.tsv"),
    "3\t1\t0\t2\n3\t2\t0\t2\n4\t1\t139\t2\n4\t2\t0\t2\n");
  writeFileSync(path.join(dir, "results", "individual.meta"),
    "VERSION=1\nTARGET_CPUS=3-4\nRUNS_PER_CPU=2\nSKIPPED=0\nCOMPLETED=1\n");
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  const r = collect(dir);
  assert.equal(r.individualStatus.status, "incomplete");
  assert.equal(r.individual, undefined);
  assert.equal(r.worstCpu, null);
  assert.match(r.individualStatus.reasons.join("; "), /group evidence is unavailable/);
});

// Shared groups-envelope generation for reconcile fixtures: version 4
// individual evidence must bind this exact validated groups generation.
const GROUPS_TEST_GENERATION = "00112233445566778899aabbccddeeff";

function groupsAssessmentFor({ generation = GROUPS_TEST_GENERATION } = {}) {
  return {
    status: "complete",
    meta: { GENERATION: generation, PLAN_DIGEST: "b".repeat(64) },
    entries: [{ name: "ecluster-64", cpus: "4-7", parsed: { failedWaves: 1 } }],
  };
}

const RECONCILE_ROWS = [
  ["4", "1", "0", "1"], ["4", "2", "0", "1"],
  ["5", "1", "139", "1"], ["5", "2", "0", "1"],
  ["6", "1", "0", "1"], ["6", "2", "0", "1"],
  ["7", "1", "0", "1"], ["7", "2", "0", "1"],
];

function reconcileMetaV4(groupGeneration, overrides = {}) {
  return {
    VERSION: "4",
    GENERATION: "a".repeat(32),
    TARGET_CPUS: "4-7",
    RUNS_PER_CPU: "2",
    TARGET_POLICY: "failed-groups",
    GROUP_PLAN_DIGEST: "b".repeat(64),
    GROUP_GENERATION: groupGeneration,
    SKIPPED: "0",
    COMPLETED: "1",
    ROWS_SHA256: "e".repeat(64),
    ROWS_BYTES: "64",
    ROW_COUNT: "8",
    ...overrides,
  };
}

test("reconcile: v4 individual evidence bound to the exact groups generation is authorized", () => {
  const meta = reconcileMetaV4(GROUPS_TEST_GENERATION);
  const assessment = assessIndividual(RECONCILE_ROWS, meta, true);
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  const reconciled = reconcileIndividualWithGroups(assessment, meta, groupsAssessmentFor(), "quick", "2");
  assert.equal(reconciled.status, "complete", reconciled.reasons.join("; "));
  assert.equal(reconciled.acceptedRows.length, 8);
});

test("reconcile: a stale groups generation defeats v4 evidence despite a matching plan digest", () => {
  const meta = reconcileMetaV4("d".repeat(32));
  const assessment = assessIndividual(RECONCILE_ROWS, meta, true);
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  const reconciled = reconcileIndividualWithGroups(assessment, meta, groupsAssessmentFor(), "quick", "2");
  assert.equal(reconciled.status, "invalid");
  assert.match(reconciled.reasons.join("; "), /not bound to the validated groups generation/);
  assert.deepEqual(reconciled.acceptedRows, []);
  assert.deepEqual(reconciled.acceptedSummaries, []);
});

test("reconcile: v3 individual evidence beside validated v2 groups stays descriptive only", () => {
  const meta = {
    VERSION: "3",
    GENERATION: "a".repeat(32),
    TARGET_CPUS: "4-7",
    RUNS_PER_CPU: "2",
    TARGET_POLICY: "failed-groups",
    GROUP_PLAN_DIGEST: "b".repeat(64),
    SKIPPED: "0",
    COMPLETED: "1",
    ROWS_SHA256: "e".repeat(64),
    ROWS_BYTES: "40",
    ROW_COUNT: "8",
  };
  const assessment = assessIndividual(RECONCILE_ROWS, meta, true);
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  const reconciled = reconcileIndividualWithGroups(assessment, meta, groupsAssessmentFor(), "quick", "2");
  assert.equal(reconciled.status, "incomplete");
  assert.match(reconciled.reasons.join("; "),
    /version 3 individual evidence is descriptive only because it is not bound to the exact validated groups generation/);
  assert.equal(reconciled.acceptedRows.length, 8);
});

test("collect: a validated skip envelope still anchors to complete stored run metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  // Duplicate GDB_MAX_RUNS rows make the stored run configuration invalid.
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    `MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\n` +
      `INDIVIDUAL_RUNS=1\nGDB_MAX_RUNS=6\nGDB_MAX_RUNS=6\nSKIP_GDB=0\nCPU_TARGET=19\n`,
  );
  writeGdbSkipFixture(dir, "--skip-gdb");
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /stored run configuration cannot authorize/);
});

test("collect: a captured binding whose transcript has no fault stop fails closed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFixedCpuConfig(dir, 19);
  // The provenance envelope is fully valid, but the captured body never
  // stopped at SIGSEGV, so no capture conclusion may stand.
  writeGdbRunFixture(dir, {
    outcomes: ["captured", "clean", "clean", "clean", "clean", "clean"],
    capturedBody: "Program exited normally.\n",
  });
  const result = collect(dir);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /contains no fault stop/);
});
