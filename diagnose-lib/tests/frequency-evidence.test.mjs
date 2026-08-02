import { createHash } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../collect.mjs";
import { inspectFrequencyEvidence } from "../frequency-evidence.mjs";
import { renderReport } from "../report.mjs";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const digest = (text) => createHash("sha256").update(text).digest("hex");

function writeFixture({ cap = false, generation = "0123456789abcdef0123456789abcdef" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "frequency-evidence-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "freq"));
  mkdirSync(path.join(dir, "state"));
  writeFileSync(path.join(dir, "state", "phase-frequency.done"), "");
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    "MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\n" +
      "INDIVIDUAL_RUNS=1\nGDB_MAX_RUNS=1\nSKIP_GDB=1\nCPU_TARGET=19\n",
  );

  const rows = "A1\t1\t139\t2\nB\t1\t0\t3\nA2\t1\t0\t2\n";
  const method = "scaling_cur_freq\n";
  const samples = {
    A1: "1753950000 19 4700000\n",
    B: "1753950000 19 2100000\n",
    A2: "1753950000 19 4700000\n",
  };
  writeFileSync(path.join(dir, "results", "frequency-ab.tsv"), rows);
  for (const leg of ["A1", "B", "A2"]) {
    writeFileSync(path.join(dir, "freq", `freq-ab-${leg}.samples`), samples[leg]);
    writeFileSync(path.join(dir, "freq", `freq-ab-${leg}.method`), method);
  }
  const abMeta = [
    `GENERATION=${generation}`,
    "CPU=19",
    "RUNS_PER_LEG=1",
    "SAVED_NO_TURBO=0",
    `CAP_REQUESTED=${cap ? 1 : 0}`,
    `REQUESTED_CAP_KHZ=${cap ? 4200000 : "-"}`,
    "LEG_A1_NO_TURBO=0",
    "LEG_A1_SCALING_MAX_KHZ=5500000",
    "LEG_B_NO_TURBO=1",
    "LEG_B_SCALING_MAX_KHZ=5500000",
    "LEG_A2_NO_TURBO=0",
    "LEG_A2_SCALING_MAX_KHZ=5500000",
    "RESTORED=1",
    `ROWS_SHA256=${digest(rows)}`,
    `LEG_A1_SAMPLES_SHA256=${digest(samples.A1)}`,
    `LEG_A1_METHOD_SHA256=${digest(method)}`,
    `LEG_B_SAMPLES_SHA256=${digest(samples.B)}`,
    `LEG_B_METHOD_SHA256=${digest(method)}`,
    `LEG_A2_SAMPLES_SHA256=${digest(samples.A2)}`,
    `LEG_A2_METHOD_SHA256=${digest(method)}`,
    `CAP_COMPLETED=${cap ? 1 : 0}`,
    "COMPLETED=1",
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "results", "frequency-ab.meta"), abMeta);

  if (cap) {
    const capRows = "cap\t1\t0\t2\n";
    const capSamples = "1753950000 19 4100000\n";
    writeFileSync(path.join(dir, "results", "frequency-cap.tsv"), capRows);
    writeFileSync(path.join(dir, "freq", "freq-ab-cap.samples"), capSamples);
    writeFileSync(path.join(dir, "freq", "freq-ab-cap.method"), method);
    writeFileSync(path.join(dir, "results", "frequency-cap.meta"), [
      `GENERATION=${generation}`,
      "CPU=19",
      "CAP_KHZ=4200000",
      "SAVED_SCALING_MAX_KHZ=5500000",
      "RUNS_PER_LEG=1",
      "RESTORED=1",
      `ROWS_SHA256=${digest(capRows)}`,
      `SAMPLES_SHA256=${digest(capSamples)}`,
      `METHOD_SHA256=${digest(method)}`,
      "COMPLETED=1",
      "",
    ].join("\n"));
  }
  return dir;
}

function writeAutoEvidence(dir, state) {
  const failed = state === "failed" || state === "incomplete" || state === "invalid";
  const skipped = state === "skipped";
  const mode = skipped ? "quick" : "default";
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    `MODE=${mode}\nBASELINE_CHILDREN=1\nBASELINE_WAVES=1\nGROUP_WAVES=1\n` +
      "INDIVIDUAL_RUNS=1\nGDB_MAX_RUNS=1\nSKIP_GDB=0\nCPU_TARGET=auto\n",
  );
  mkdirSync(path.join(dir, "logs", "groups"), { recursive: true });
  const plan = "all-cpus\tuniform\t19\t-\t1\t1\tlogs/groups/all-cpus.log\tgroup-all-cpus";
  const planDigest = digest(`${plan}\n`);
  const log = failed
    ? "node=v25.2.1 v8=test platform=linux arch=x64 children=1 waves=1\n" +
      "wave=1 passed=0/1\nchild=1 code=null signal=SIGSEGV elapsedMs=2\n" +
      "failedWaves=1 completedWaves=1 requestedWaves=1\n"
    : "node=v25.2.1 v8=test platform=linux arch=x64 children=1 waves=1\n" +
      "wave=1 passed=1/1\nfailedWaves=0 completedWaves=1 requestedWaves=1\n";
  writeFileSync(path.join(dir, "logs", "groups", "all-cpus.log"), log);
  writeFileSync(path.join(dir, "results", "groups.tsv"), `${plan}\t${failed ? 1 : 0}\n`);
  writeFileSync(path.join(dir, "results", "groups.meta"),
    `VERSION=1\nEXPECTED_ROWS=1\nGROUP_WAVES=1\nPLAN_DIGEST=${planDigest}\nCOMPLETED=1\n`);
  writeFileSync(path.join(dir, "state", "phase-groups.done"), "");

  if (skipped) {
    writeFileSync(path.join(dir, "results", "individual.tsv"), "");
    writeFileSync(path.join(dir, "results", "individual.meta"),
      `VERSION=2\nTARGET_CPUS=\nRUNS_PER_CPU=1\nTARGET_POLICY=quick-skip\n` +
      `GROUP_PLAN_DIGEST=${planDigest}\nSKIPPED=1\nCOMPLETED=1\n` +
      "SKIP_REASON=no-failing-group-in-quick-mode\n");
  } else {
    writeFileSync(path.join(dir, "results", "individual.tsv"), `19\t1\t${failed ? 139 : 0}\t2\n`);
    writeFileSync(path.join(dir, "results", "individual.meta"),
      `VERSION=2\nTARGET_CPUS=19\nRUNS_PER_CPU=1\n` +
      `TARGET_POLICY=${failed ? "failed-groups" : "all-group-cpus"}\n` +
      `GROUP_PLAN_DIGEST=${planDigest}\nSKIPPED=0\nCOMPLETED=${state === "incomplete" ? 0 : 1}\n`);
  }
  if (state !== "incomplete") writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  if (state === "invalid") {
    writeFileSync(path.join(dir, "results", "individual.tsv"), "19\t01\t139\t2\n");
  }
}

test("frequency envelope accepts a complete generation and marks cap not requested", () => {
  const dir = writeFixture();
  const inspected = inspectFrequencyEvidence(dir);
  assert.deepEqual(inspected.frequencyAbStatus, { status: "complete", reasons: [] });
  assert.equal(inspected.frequencyCapStatus.status, "not-requested");
  const result = collect(dir);
  assert.equal(result.frequencyAb.cpu, 19);
  assert.equal(result.frequencyCap, undefined);
});

test("frequency expected-CPU state distinguishes unchecked, resolved, and unavailable", () => {
  const dir = writeFixture({ cap: true });
  assert.equal(inspectFrequencyEvidence(dir).frequencyAbStatus.status, "complete");
  assert.equal(inspectFrequencyEvidence(dir, {
    expectedCpuState: { status: "resolved", cpu: 19 },
  }).frequencyAbStatus.status, "complete");

  const mismatch = inspectFrequencyEvidence(dir, {
    expectedCpuState: { status: "resolved", cpu: 18 },
  });
  assert.equal(mismatch.frequencyAbStatus.status, "incomplete");
  assert.match(mismatch.frequencyAbStatus.reasons.join("; "), /does not match/);
  assert.equal(mismatch.frequencyCapStatus.status, "incomplete");

  const unavailable = inspectFrequencyEvidence(dir, {
    expectedCpuState: { status: "unavailable", reason: "validated individual CPU is unavailable" },
  });
  assert.equal(unavailable.frequencyAbStatus.status, "incomplete");
  assert.match(unavailable.frequencyAbStatus.reasons.join("; "), /validated individual CPU is unavailable/);
  assert.equal(unavailable.frequencyCapStatus.status, "incomplete");

  const malformed = inspectFrequencyEvidence(dir, { expectedCpu: "019" });
  assert.equal(malformed.frequencyAbStatus.status, "incomplete");
  assert.match(malformed.frequencyAbStatus.reasons.join("; "), /expected CPU target is malformed/);
});

test("an unresolved target leaves an untouched frequency phase not-run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frequency-evidence-empty-target-"));
  tmpDirs.push(dir);
  const result = inspectFrequencyEvidence(dir, {
    expectedCpuState: { status: "none", reason: "no failing individual CPU" },
  });
  assert.equal(result.frequencyAbStatus.status, "not-run");
  assert.equal(result.frequencyCapStatus.status, "not-run");
});

test("collector binds fixed frequency evidence to strict stored CPU_TARGET", () => {
  for (const [stored, accepted] of [
    ["19", true], ["18", false], ["auto", false], ["01", false],
    ["-1", false], ["1.0", false], ["70000", false], [null, false],
  ]) {
    const dir = writeFixture({ cap: true });
    const file = path.join(dir, "results", "meta.env");
    let text = readFileSync(file, "utf8").replace(/^CPU_TARGET=.*\n/m, "");
    if (stored !== null) text += `CPU_TARGET=${stored}\n`;
    writeFileSync(file, text);
    const result = collect(dir);
    assert.equal(result.frequencyAbStatus.status, accepted ? "complete" : "incomplete", String(stored));
    assert.equal(Boolean(result.frequencyAb), accepted, String(stored));
    assert.equal(Boolean(result.frequencyCap), accepted, String(stored));
  }

  const duplicate = writeFixture();
  writeFileSync(
    path.join(duplicate, "results", "meta.env"),
    `${readFileSync(path.join(duplicate, "results", "meta.env"), "utf8")}CPU_TARGET=19\n`,
  );
  const result = collect(duplicate);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.equal(result.frequencyAb, undefined);
  assert.equal(result.config.cpuTargetPolicy, "invalid");
});

test("collector resolves automatic frequency and GDB CPUs only from authoritative individual evidence", () => {
  const matching = writeFixture();
  writeAutoEvidence(matching, "failed");
  writeFileSync(path.join(matching, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=1\nEXIT_CODE=3\n");
  writeFileSync(path.join(matching, "state", "phase-gdb.done"), "");
  let result = collect(matching);
  assert.equal(result.cpuSelectionStatus.status, "resolved");
  assert.equal(result.cpuSelectionStatus.cpu, 19);
  assert.equal(result.frequencyAbStatus.status, "complete");
  assert.equal(result.gdb.status, "no-fault");

  writeFileSync(
    path.join(matching, "results", "frequency-ab.meta"),
    readFileSync(path.join(matching, "results", "frequency-ab.meta"), "utf8").replace("CPU=19", "CPU=18"),
  );
  writeFileSync(path.join(matching, "results", "gdb.meta"), "CPU=18\nMAX_RUNS=1\nEXIT_CODE=3\n");
  result = collect(matching);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.equal(result.frequencyAb, undefined);
  assert.equal(result.gdb.status, "incomplete");
  assert.match(result.gdb.reason, /does not match/);

  for (const state of ["clean", "skipped", "incomplete", "invalid"]) {
    const dir = writeFixture({ cap: true });
    writeAutoEvidence(dir, state);
    writeFileSync(path.join(dir, "results", "gdb.meta"), "CPU=19\nMAX_RUNS=1\nEXIT_CODE=3\n");
    writeFileSync(path.join(dir, "state", "phase-gdb.done"), "");
    const unresolved = collect(dir);
    assert.notEqual(unresolved.cpuSelectionStatus.status, "resolved", state);
    assert.equal(unresolved.frequencyAbStatus.status, "incomplete", state);
    assert.equal(unresolved.frequencyAb, undefined, state);
    assert.equal(unresolved.frequencyCap, undefined, state);
    assert.equal(unresolved.gdb.status, "incomplete", state);
    assert.match(unresolved.gdb.reason, /automatic CPU selection/, state);
  }
});

test("fixed-target reports describe the stored policy rather than a post-selected worst CPU", () => {
  const dir = writeFixture();
  const result = collect(dir);
  const report = renderReport(result);
  assert.match(report, /fixed by the stored CPU selection policy/);
  assert.doesNotMatch(report, /Test CPU: 19 \(highest observed failure rate\)/);
});

test("frequency cap status is not-run for an untouched bundle", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frequency-evidence-empty-"));
  tmpDirs.push(dir);
  const result = inspectFrequencyEvidence(dir);
  assert.equal(result.frequencyAbStatus.status, "not-run");
  assert.deepEqual(result.frequencyCapStatus, { status: "not-run", reasons: [] });
});

test("frequency cap status rejects orphan artifacts without a parent generation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frequency-evidence-orphan-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  writeFileSync(path.join(dir, "results", "frequency-cap.tsv"), "cap\t1\t0\t1\n");
  const result = inspectFrequencyEvidence(dir);
  assert.equal(result.frequencyAbStatus.status, "not-run");
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /no current parent/);
});

test("frequency cap status is incomplete when CAP_REQUESTED belongs to a malformed parent", () => {
  const dir = writeFixture();
  const metaFile = path.join(dir, "results", "frequency-ab.meta");
  writeFileSync(metaFile, `${readFileSync(metaFile, "utf8")}UNKNOWN=1\n`);
  const result = inspectFrequencyEvidence(dir);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /parent A\/B\/A envelope is incomplete/);
});

test("frequency envelope exposes only a complete cap from the current generation", () => {
  const dir = writeFixture({ cap: true });
  const result = collect(dir);
  assert.equal(result.frequencyCapStatus.status, "complete");
  assert.equal(result.frequencyCap.requestedCapKhz, 4200000);
  assert.equal(result.frequencyCap.legs[0].leg, "cap");
});

test("frequency envelope excludes stale cap metadata with a different generation", () => {
  const dir = writeFixture({ cap: true });
  const file = path.join(dir, "results", "frequency-cap.meta");
  const text = readFileSync(file, "utf8").replace(
    "GENERATION=0123456789abcdef0123456789abcdef",
    "GENERATION=fedcba9876543210fedcba9876543210",
  );
  writeFileSync(file, text);
  const result = collect(dir);
  assert.equal(result.frequencyCap, undefined);
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /generation does not match/);
});

test("frequency envelope rejects changed rows and stale sampler content", () => {
  const dir = writeFixture({ cap: true });
  writeFileSync(path.join(dir, "results", "frequency-cap.tsv"), "cap\t01\t0\t2\n");
  writeFileSync(path.join(dir, "freq", "freq-ab-cap.samples"), "1753950000 19 1000000\n");
  const result = collect(dir);
  assert.equal(result.frequencyCap, undefined);
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /generation digest|invalid or duplicate row/);
});

test("frequency envelope binds same-shape A/B/A rows and sampler bytes", () => {
  const dir = writeFixture();
  writeFileSync(path.join(dir, "results", "frequency-ab.tsv"), "A1\t1\t0\t2\nB\t1\t0\t3\nA2\t1\t0\t2\n");
  writeFileSync(path.join(dir, "freq", "freq-ab-A1.samples"), "1753950000 19 1000000\n");
  const result = collect(dir);
  assert.equal(result.frequencyAb, undefined);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.match(result.frequencyAbStatus.reasons.join("; "), /generation digest/);
});

test("frequency envelope rejects unknown or duplicate metadata and an absent marker", () => {
  const dir = writeFixture({ cap: true });
  const metaFile = path.join(dir, "results", "frequency-cap.meta");
  writeFileSync(metaFile, `${readFileSync(metaFile, "utf8")}CPU=19\nUNKNOWN=1\n`);
  unlinkSync(path.join(dir, "state", "phase-frequency.done"));
  const result = inspectFrequencyEvidence(dir);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.match(result.frequencyAbStatus.reasons.join("; "), /completion marker/);
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /duplicate key CPU|unknown key UNKNOWN/);
});

test("frequency envelope rejects invalid cap bounds, binding, and terminal flags", () => {
  const dir = writeFixture({ cap: true });
  const metaFile = path.join(dir, "results", "frequency-cap.meta");
  let text = readFileSync(metaFile, "utf8")
    .replace("CAP_KHZ=4200000", "CAP_KHZ=99999")
    .replace("RESTORED=1", "RESTORED=0")
    .replace("COMPLETED=1", "COMPLETED=0");
  writeFileSync(metaFile, text);
  const result = collect(dir);
  assert.equal(result.frequencyCap, undefined);
  assert.match(result.frequencyCapStatus.reasons.join("; "), /requested cap|not verified as restored|not marked complete/);
});

test("frequency envelope rejects invalid CPU and method semantics even with matching hashes", () => {
  const dir = writeFixture({ cap: true });
  const abMetaFile = path.join(dir, "results", "frequency-ab.meta");
  writeFileSync(abMetaFile, readFileSync(abMetaFile, "utf8").replace("CPU=19", "CPU=70000"));
  const methodFile = path.join(dir, "freq", "freq-ab-cap.method");
  const capMetaFile = path.join(dir, "results", "frequency-cap.meta");
  writeFileSync(methodFile, "garbage\n");
  writeFileSync(
    capMetaFile,
    readFileSync(capMetaFile, "utf8").replace(/^METHOD_SHA256=.*$/m, `METHOD_SHA256=${digest("garbage\n")}`),
  );
  const result = collect(dir);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.match(result.frequencyAbStatus.reasons.join("; "), /CPU is missing or invalid/);
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /method is invalid/);
});

test("frequency envelope ignores lingering cap files when the current generation requested none", () => {
  const dir = writeFixture();
  writeFileSync(path.join(dir, "results", "frequency-cap.tsv"), "cap\t1\t0\t1\n");
  writeFileSync(path.join(dir, "results", "frequency-cap.meta"), "GENERATION=fedcba9876543210fedcba9876543210\n");
  const result = collect(dir);
  assert.equal(result.frequencyAbStatus.status, "complete");
  assert.equal(result.frequencyCap, undefined);
  assert.equal(result.frequencyCapStatus.status, "not-requested");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /not authoritative/);
});

test("frequency envelope rejects a symlinked results parent", () => {
  const target = writeFixture();
  const dir = mkdtempSync(path.join(tmpdir(), "frequency-evidence-link-"));
  tmpDirs.push(dir);
  symlinkSync(path.join(target, "results"), path.join(dir, "results"));
  mkdirSync(path.join(dir, "freq"));
  mkdirSync(path.join(dir, "state"));
  const result = inspectFrequencyEvidence(dir, { ignorePhaseMarker: true });
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.match(result.frequencyAbStatus.reasons.join("; "), /results directory must be a real directory/);
});

test("frequency envelope rejects dangling final links and symlinked freq/state parents", () => {
  const dangling = writeFixture({ cap: true });
  const capRows = path.join(dangling, "results", "frequency-cap.tsv");
  unlinkSync(capRows);
  symlinkSync(path.join(dangling, "missing-cap.tsv"), capRows);
  let result = inspectFrequencyEvidence(dangling);
  assert.equal(result.frequencyCapStatus.status, "incomplete");
  assert.match(result.frequencyCapStatus.reasons.join("; "), /must be a real regular file/);

  const target = writeFixture();
  const linked = mkdtempSync(path.join(tmpdir(), "frequency-evidence-parent-links-"));
  tmpDirs.push(linked);
  mkdirSync(path.join(linked, "results"));
  symlinkSync(path.join(target, "freq"), path.join(linked, "freq"));
  symlinkSync(path.join(target, "state"), path.join(linked, "state"));
  result = inspectFrequencyEvidence(linked);
  assert.equal(result.frequencyAbStatus.status, "incomplete");
  assert.match(result.frequencyAbStatus.reasons.join("; "), /frequency sample directory must be a real directory|state directory must be a real directory/);
});

test("frequency envelope rejects over-limit sampler artifacts", () => {
  const dir = writeFixture({ cap: true });
  truncateSync(path.join(dir, "freq", "freq-ab-cap.samples"), 64 * 1024 * 1024 + 1);
  const result = collect(dir);
  assert.equal(result.frequencyCap, undefined);
  assert.match(result.frequencyCapStatus.reasons.join("; "), /size limit/);
});
