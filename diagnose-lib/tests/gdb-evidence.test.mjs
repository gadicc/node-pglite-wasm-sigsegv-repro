import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  GDB_TRANSCRIPT_MAX_BYTES,
  GDB_ERROR_LIMIT,
  GDB_MAX_RUNS_LIMIT,
  GDB_RESULTS_ENTRY_LIMIT,
  buildGdbManifestCandidate,
  inspectGdbManifestConfig,
  newGdbGeneration,
  validateGdbEvidence,
} from "../gdb-evidence.mjs";

const GENERATION = "a".repeat(32);
const tmpDirs = [];

after(() => {
  for (const directory of tmpDirs) rmSync(directory, { recursive: true, force: true });
});

function tempBundle() {
  const root = mkdtempSync(path.join(tmpdir(), "gdb-evidence-test-"));
  tmpDirs.push(root);
  for (const relative of ["results", "state", "gdb", "logs", "logs/gdb"]) {
    mkdirSync(path.join(root, relative));
  }
  return root;
}

function transcriptText({ generation, cpu, maxRuns, maxCaptures, run, outcome }) {
  return `GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t${generation}\tCPU\t${cpu}` +
    `\tMAX_RUNS\t${maxRuns}\tMAX_CAPTURES\t${maxCaptures}\tRUN\t${run}\tOUTCOME\t${outcome}\n` +
    `raw gdb output for run ${run}\n` +
    `GDB_TRANSCRIPT_END\tGENERATION\t${generation}\tCPU\t${cpu}\tRUN\t${run}\tOUTCOME\t${outcome}\n`;
}

function writeRun({
  outcomes = ["captured", "clean", "error"],
  maxRuns = outcomes.length,
  maxCaptures = 2,
  cpu = 7,
  generation = GENERATION,
  exitCode = null,
} = {}) {
  const root = tempBundle();
  const counts = { clean: 0, captured: 0, error: 0 };
  const runner = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const run = index + 1;
    const outcome = outcomes[index];
    counts[outcome] += 1;
    runner.push(
      `ATTEMPT\tGENERATION\t${generation}\tCPU\t${cpu}\tMAX_RUNS\t${maxRuns}` +
      `\tMAX_CAPTURES\t${maxCaptures}\tRUN\t${run}\tOUTCOME\t${outcome}`,
    );
    if (outcome !== "clean") {
      writeFileSync(
        path.join(root, "gdb", `cpu${cpu}-run${run}.txt`),
        transcriptText({ generation, cpu, maxRuns, maxCaptures, run, outcome }),
      );
    }
  }
  const rc = exitCode ?? (counts.captured > 0 ? 0 : 3);
  runner.push(
    `COUNTS\tGENERATION\t${generation}\tCPU\t${cpu}\tMAX_RUNS\t${maxRuns}` +
    `\tMAX_CAPTURES\t${maxCaptures}\tATTEMPTED\t${outcomes.length}` +
    `\tCLEAN\t${counts.clean}\tCAPTURED\t${counts.captured}\tERRORS\t${counts.error}` +
    `\tEXIT_CODE\t${rc}`,
  );
  writeFileSync(path.join(root, "logs/gdb/runner.log"), `${runner.join("\n")}\n`);
  writeFileSync(
    path.join(root, "results/gdb.meta"),
    `CPU=${cpu}\nMAX_RUNS=${maxRuns}\nEXIT_CODE=${rc}\nATTEMPTED_RUNS=${outcomes.length}\n` +
      `CLEAN_RUNS=${counts.clean}\nCAPTURED_RUNS=${counts.captured}\nERROR_RUNS=${counts.error}\n`,
  );
  return { root, cpu, maxRuns, maxCaptures, generation, outcomes };
}

function writeSkip(kind = "--skip-gdb") {
  const root = tempBundle();
  writeFileSync(path.join(root, "results/gdb.meta"), `SKIPPED=1\nSKIP_REASON=${kind}\n`);
  return { root, cpu: null, maxRuns: 6, maxCaptures: 3, generation: GENERATION };
}

function candidatePath(fixture, suffix = "candidate") {
  return path.join(fixture.root, "results", `.gdb.manifest.${suffix}`);
}

function build(fixture, suffix = "candidate") {
  const candidate = candidatePath(fixture, suffix);
  const result = buildGdbManifestCandidate(fixture.root, candidate, {
    generation: fixture.generation,
    expectedCpu: fixture.cpu,
    expectedMaxRuns: fixture.maxRuns,
    expectedMaxCaptures: fixture.maxCaptures,
  });
  return { candidate, result };
}

function complete(fixture) {
  const built = build(fixture);
  assert.equal(built.result.ok, true, built.result.reasons?.join("; "));
  renameSync(built.candidate, path.join(fixture.root, "results/gdb.manifest"));
  writeFileSync(path.join(fixture.root, "state/phase-gdb.done"), "");
  return validate(fixture);
}

function validate(fixture, options = {}) {
  return validateGdbEvidence(fixture.root, {
    markerMode: "complete",
    expectedCpu: fixture.cpu,
    expectedMaxRuns: fixture.maxRuns,
    expectedMaxCaptures: fixture.maxCaptures,
    ...options,
  });
}

function replaceLine(root, from, to) {
  const file = path.join(root, "results/gdb.manifest");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(from), `missing manifest text: ${from}`);
  writeFileSync(file, text.replace(from, to));
}

test("candidate builder and complete validator accept captured, no-fault, error-bearing, and skipped evidence", () => {
  const captured = writeRun({ outcomes: ["captured", "error", "captured"], maxRuns: 8, maxCaptures: 2 });
  const built = build(captured);
  assert.equal(built.result.status, "ready", built.result.reasons.join("; "));
  assert.match(built.result.probe, /^GDB_EVIDENCE\tVERSION\t1\tSTATUS\tREADY\t/);
  renameSync(built.candidate, path.join(captured.root, "results/gdb.manifest"));
  writeFileSync(path.join(captured.root, "state/phase-gdb.done"), "");
  assert.equal(validate(captured).outcome, "captured");

  const noFault = writeRun({ outcomes: ["clean", "error", "clean"] });
  assert.equal(complete(noFault).outcome, "no-fault");

  const fullRunCapture = writeRun({ outcomes: ["error", "captured", "clean"], maxCaptures: 2 });
  assert.equal(complete(fullRunCapture).outcome, "captured");

  const skipped = writeSkip("gdb not installed");
  assert.equal(complete(skipped).outcome, "skipped");
});

test("generations are fresh lowerhex32 values", () => {
  const first = newGdbGeneration();
  const second = newGdbGeneration();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test("manifest records are ordered, contiguous, and exact-field canonical", () => {
  const cases = [
    ["VERSION\t1\nGENERATION", `GENERATION\t${GENERATION}\nVERSION\t1\nGENERATION`],
    ["CONFIG\tMAX_RUNS\t3", "CONFIG\tMAX_RUNS\t03"],
    ["CONFIG\tMAX_CAPTURES\t2", "CONFIG\tMAX_CAPTURES\t1"],
    ["ATTEMPT\t1\t", "ATTEMPT\t2\t"],
    ["\tclean\t-\t-\t-", "\tclean\t-\t0\t-"],
  ];
  for (const [from, to] of cases) {
    const fixture = writeRun();
    complete(fixture);
    replaceLine(fixture.root, from, to);
    assert.equal(validate(fixture).ok, false, `${from} -> ${to}`);
  }

  const extra = writeRun();
  complete(extra);
  writeFileSync(
    path.join(extra.root, "results/gdb.manifest"),
    `${readFileSync(path.join(extra.root, "results/gdb.manifest"), "utf8")}EXTRA\tx\n`,
  );
  assert.equal(validate(extra).ok, false);

  const noLf = writeRun();
  complete(noLf);
  const manifest = path.join(noLf.root, "results/gdb.manifest");
  writeFileSync(manifest, readFileSync(manifest, "utf8").slice(0, -1));
  assert.match(validate(noLf).reasons.join("; "), /end with LF/);
});

test("manifest artifact names, digests, and sizes are authoritative", () => {
  for (const [pattern, replacement] of [
    [/gdb\/cpu7-run1\.txt/, "gdb/cpu7-run9.txt"],
    [/META\tresults\/gdb\.meta\t([0-9]+)/, "META\tresults/gdb.meta\t999"],
    [/META\tresults\/gdb\.meta\t([0-9]+)\t[0-9a-f]{64}/, `META\tresults/gdb.meta\t$1\t${"f".repeat(64)}`],
    [/RUNNER\tlogs\/gdb\/runner\.log\t([0-9]+)/, "RUNNER\tlogs/gdb/runner.log\t999"],
    [/RUNNER\tlogs\/gdb\/runner\.log\t([0-9]+)\t[0-9a-f]{64}/,
      `RUNNER\tlogs/gdb/runner.log\t$1\t${"e".repeat(64)}`],
    [/ATTEMPT\t1\tcaptured\tgdb\/cpu7-run1\.txt\t([0-9]+)/,
      "ATTEMPT\t1\tcaptured\tgdb/cpu7-run1.txt\t999"],
    [/ATTEMPT\t1\tcaptured\tgdb\/cpu7-run1\.txt\t([0-9]+)\t[0-9a-f]{64}/,
      `ATTEMPT\t1\tcaptured\tgdb/cpu7-run1.txt\t$1\t${"d".repeat(64)}`],
  ]) {
    const fixture = writeRun();
    complete(fixture);
    const file = path.join(fixture.root, "results/gdb.manifest");
    writeFileSync(file, readFileSync(file, "utf8").replace(pattern, replacement));
    assert.equal(validate(fixture).ok, false, String(pattern));
  }
});

test("manifest text rejects CR, NUL, non-ASCII, and missing final LF", () => {
  for (const byte of [Buffer.from("\r"), Buffer.from([0]), Buffer.from([0x80])]) {
    const fixture = writeRun();
    complete(fixture);
    const manifest = path.join(fixture.root, "results/gdb.manifest");
    const contents = readFileSync(manifest);
    writeFileSync(manifest, Buffer.concat([contents.subarray(0, 5), byte, contents.subarray(5)]));
    assert.match(validate(fixture).reasons.join("; "), /non-canonical/);
  }
});

test("runner generation, configuration, outcome, sequence, and counts bind every attempt", () => {
  const mutations = [
    [`GENERATION\t${GENERATION}`, `GENERATION\t${"b".repeat(32)}`],
    ["MAX_RUNS\t3", "MAX_RUNS\t4"],
    ["RUN\t1\tOUTCOME\tcaptured", "RUN\t1\tOUTCOME\terror"],
    ["RUN\t2\tOUTCOME\tclean", "RUN\t3\tOUTCOME\tclean"],
    ["ATTEMPTED\t3", "ATTEMPTED\t2"],
  ];
  for (const [from, to] of mutations) {
    const fixture = writeRun();
    const log = path.join(fixture.root, "logs/gdb/runner.log");
    writeFileSync(log, readFileSync(log, "utf8").replace(from, to));
    assert.equal(build(fixture).result.ok, false, `${from} -> ${to}`);
  }
});

test("transcript filename, header, footer, generation, run, and outcome are exact", () => {
  const mutations = [
    ["GDB_TRANSCRIPT\tVERSION\t1", "GDB_TRANSCRIPT\tVERSION\t2"],
    [`GENERATION\t${GENERATION}`, `GENERATION\t${"c".repeat(32)}`],
    ["RUN\t1\tOUTCOME\tcaptured", "RUN\t2\tOUTCOME\tcaptured"],
    ["OUTCOME\tcaptured", "OUTCOME\terror"],
    ["GDB_TRANSCRIPT_END", "GDB_TRANSCRIPT_STOP"],
  ];
  for (const [from, to] of mutations) {
    const fixture = writeRun();
    const file = path.join(fixture.root, "gdb/cpu7-run1.txt");
    writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
    assert.equal(build(fixture).result.ok, false, `${from} -> ${to}`);
  }
  const renamed = writeRun();
  renameSync(path.join(renamed.root, "gdb/cpu7-run1.txt"), path.join(renamed.root, "gdb/cpu7-run9.txt"));
  assert.equal(build(renamed).result.ok, false);

  const overlongPrefix = writeRun();
  const prefixed = path.join(overlongPrefix.root, "gdb/cpu7-run1.txt");
  writeFileSync(prefixed, `${"x".repeat(513)}\n${readFileSync(prefixed, "utf8")}`);
  assert.match(build(overlongPrefix).result.reasons.join("; "), /provenance header/);
});

test("extra and missing runner or transcript files invalidate exact inventories", () => {
  const extraTranscript = writeRun();
  writeFileSync(path.join(extraTranscript.root, "gdb/extra.txt"), "extra\n");
  assert.match(build(extraTranscript).result.reasons.join("; "), /inventory/);

  const missingTranscript = writeRun();
  rmSync(path.join(missingTranscript.root, "gdb/cpu7-run1.txt"));
  assert.equal(build(missingTranscript).result.ok, false);

  const extraLog = writeRun();
  writeFileSync(path.join(extraLog.root, "logs/gdb/extra.log"), "extra\n");
  assert.match(build(extraLog).result.reasons.join("; "), /inventory/);

  const skipped = writeSkip();
  writeFileSync(path.join(skipped.root, "gdb/cpu7-run1.txt"), "stale\n");
  writeFileSync(path.join(skipped.root, "logs/gdb/runner.log"), "stale\n");
  assert.equal(build(skipped).result.ok, false);
});

test("legacy run and skip metadata schemas are exact and canonical", () => {
  const badRun = writeRun();
  const meta = path.join(badRun.root, "results/gdb.meta");
  writeFileSync(meta, readFileSync(meta, "utf8").replace("CPU=7\nMAX_RUNS=3", "MAX_RUNS=3\nCPU=7"));
  assert.equal(build(badRun).result.ok, false);

  for (const metadata of [
    "SKIPPED=01\nSKIP_REASON=--skip-gdb\n",
    "SKIP_REASON=--skip-gdb\nSKIPPED=1\n",
    "SKIPPED=1\nSKIP_REASON=crafted\n",
    "SKIPPED=1\nSKIP_REASON=--skip-gdb\nCPU=7\n",
  ]) {
    const skipped = writeSkip();
    writeFileSync(path.join(skipped.root, "results/gdb.meta"), metadata);
    assert.equal(build(skipped).result.ok, false, metadata);
  }
});

test("terminal rules require full no-fault runs or captured early-stop/full-run completion", () => {
  const earlyWithoutCap = writeRun({ outcomes: ["captured"], maxRuns: 3, maxCaptures: 2 });
  assert.match(build(earlyWithoutCap).result.reasons.join("; "), /termination rules/);

  const properEarly = writeRun({ outcomes: ["captured", "captured"], maxRuns: 8, maxCaptures: 2 });
  assert.equal(build(properEarly).result.ok, true);

  const beyondCaptureCap = writeRun({ outcomes: ["captured", "captured", "captured"], maxCaptures: 2 });
  assert.equal(build(beyondCaptureCap).result.ok, false);

  const continuedAfterEarlyCap = writeRun({
    outcomes: ["captured", "clean", "clean"],
    maxRuns: 3,
    maxCaptures: 1,
  });
  assert.equal(build(continuedAfterEarlyCap).result.ok, false);

  const capReachedOnFinalRun = writeRun({
    outcomes: ["clean", "error", "captured"],
    maxRuns: 3,
    maxCaptures: 1,
  });
  assert.equal(build(capReachedOnFinalRun).result.ok, true);

  const shortNoFault = writeRun({ outcomes: ["clean"], maxRuns: 3, exitCode: 3 });
  assert.match(build(shortNoFault).result.reasons.join("; "), /no-fault/);

  const allErrors = writeRun({ outcomes: ["error", "error", "error"], exitCode: 3 });
  assert.match(build(allErrors).result.reasons.join("; "), /no-fault/);
});

test("marker-before and marker-complete modes are distinct and marker is validated", () => {
  const fixture = writeRun();
  const built = build(fixture);
  assert.equal(built.result.status, "ready");
  assert.equal(validate(fixture).ok, false);

  renameSync(built.candidate, path.join(fixture.root, "results/gdb.manifest"));
  writeFileSync(path.join(fixture.root, "state/phase-gdb.done"), "x");
  assert.equal(validate(fixture).ok, false, "marker is bounded to exactly zero bytes");
  writeFileSync(path.join(fixture.root, "state/phase-gdb.done"), "");
  assert.equal(validate(fixture).status, "complete");

  const beforeWithMarker = writeRun();
  writeFileSync(path.join(beforeWithMarker.root, "state/phase-gdb.done"), "");
  assert.equal(build(beforeWithMarker).result.ok, false);
});

test("validation modes bind the authoritative manifest name and full candidate path", () => {
  const hiddenComplete = writeSkip();
  const hidden = build(hiddenComplete);
  assert.equal(hidden.result.ok, true);
  writeFileSync(path.join(hiddenComplete.root, "state/phase-gdb.done"), "");
  const hiddenResult = validate(hiddenComplete, { manifestName: path.basename(hidden.candidate) });
  assert.match(hiddenResult.reasons.join("; "), /authoritative results\/gdb\.manifest/);

  const finalBeforeMarker = writeSkip();
  const final = build(finalBeforeMarker);
  renameSync(final.candidate, path.join(finalBeforeMarker.root, "results/gdb.manifest"));
  const finalResult = validateGdbEvidence(finalBeforeMarker.root, {
    markerMode: "before",
    manifestPath: path.join(finalBeforeMarker.root, "results/gdb.manifest"),
    expectedCpu: null,
    expectedMaxRuns: finalBeforeMarker.maxRuns,
    expectedMaxCaptures: finalBeforeMarker.maxCaptures,
  });
  assert.equal(finalResult.status, "ready", finalResult.reasons.join("; "));

  const cliFixture = writeSkip();
  const cliBuilt = build(cliFixture);
  assert.equal(cliBuilt.result.ok, true);
  const outside = path.join(tmpdir(), path.basename(cliBuilt.candidate));
  const outsideResult = validateGdbEvidence(cliFixture.root, {
    markerMode: "before",
    manifestPath: outside,
    expectedCpu: null,
    expectedMaxRuns: cliFixture.maxRuns,
    expectedMaxCaptures: cliFixture.maxCaptures,
  });
  assert.match(outsideResult.reasons.join("; "), /directly inside results/);
  assert.match(outsideResult.probe, /^GDB_EVIDENCE\tVERSION\t1\tSTATUS\tINVALID\tGENERATION\t-\tOUTCOME\t-$/);

  const arbitraryResult = validateGdbEvidence(cliFixture.root, {
    markerMode: "before",
    manifestPath: path.join(cliFixture.root, "results/gdb.meta"),
    expectedCpu: null,
    expectedMaxRuns: cliFixture.maxRuns,
    expectedMaxCaptures: cliFixture.maxCaptures,
  });
  assert.match(arbitraryResult.reasons.join("; "), /safe GDB file/);
});

test("symlink, FIFO, hardlink, and oversized artifacts fail closed", () => {
  const symlink = writeRun();
  const meta = path.join(symlink.root, "results/gdb.meta");
  renameSync(meta, `${meta}.real`);
  symlinkSync(`${meta}.real`, meta);
  assert.match(build(symlink).result.reasons.join("; "), /single-link/);

  const fifo = writeRun();
  const runner = path.join(fifo.root, "logs/gdb/runner.log");
  rmSync(runner);
  assert.equal(spawnSync("mkfifo", [runner]).status, 0);
  assert.match(build(fifo).result.reasons.join("; "), /single-link/);

  const hardlink = writeRun();
  linkSync(path.join(hardlink.root, "gdb/cpu7-run1.txt"), path.join(hardlink.root, "gdb/second-link"));
  assert.match(build(hardlink).result.reasons.join("; "), /single-link|inventory/);

  const oversized = writeRun();
  truncateSync(path.join(oversized.root, "gdb/cpu7-run1.txt"), GDB_TRANSCRIPT_MAX_BYTES + 1);
  assert.match(build(oversized).result.reasons.join("; "), /size limit/);

  const oversizedMeta = writeRun();
  truncateSync(path.join(oversizedMeta.root, "results/gdb.meta"), 4097);
  assert.match(build(oversizedMeta).result.reasons.join("; "), /size limit/);

  const oversizedRunner = writeRun();
  truncateSync(path.join(oversizedRunner.root, "logs/gdb/runner.log"), (oversizedRunner.maxRuns + 1) * 513 + 1);
  assert.match(build(oversizedRunner).result.reasons.join("; "), /size limit/);
});

test("file and directory replacement during complete validation are detected", () => {
  const fileFixture = writeRun();
  complete(fileFixture);
  const meta = path.join(fileFixture.root, "results/gdb.meta");
  const fileResult = validate(fileFixture, {
    afterArtifactScan() {
      renameSync(meta, `${meta}.old`);
      writeFileSync(meta, readFileSync(`${meta}.old`));
    },
  });
  assert.match(fileResult.reasons.join("; "), /changed during validation/);

  const directoryFixture = writeRun();
  complete(directoryFixture);
  const gdb = path.join(directoryFixture.root, "gdb");
  const directoryResult = validate(directoryFixture, {
    afterArtifactScan() {
      renameSync(gdb, `${gdb}.old`);
      mkdirSync(gdb);
    },
  });
  assert.match(directoryResult.reasons.join("; "), /changed during validation/);

  const rootFixture = writeSkip();
  complete(rootFixture);
  const movedRoot = `${rootFixture.root}.moved`;
  const rootResult = validate(rootFixture, {
    afterArtifactScan() {
      renameSync(rootFixture.root, movedRoot);
      renameSync(movedRoot, rootFixture.root);
    },
  });
  assert.match(rootResult.reasons.join("; "), /bundle root changed during validation/);

  const resultsFixture = writeSkip();
  complete(resultsFixture);
  const transient = path.join(resultsFixture.root, "results/transient");
  const resultsResult = validate(resultsFixture, {
    afterArtifactScan() {
      writeFileSync(transient, "transient\n");
      rmSync(transient);
    },
  });
  assert.match(resultsResult.reasons.join("; "), /results changed during validation/);
});

test("exclusive candidate creation preserves an existing destination", () => {
  const fixture = writeRun();
  const candidate = candidatePath(fixture, "occupied");
  writeFileSync(candidate, "user data\n", { mode: 0o644 });
  const result = buildGdbManifestCandidate(fixture.root, candidate, {
    generation: fixture.generation,
    expectedCpu: fixture.cpu,
    expectedMaxRuns: fixture.maxRuns,
    expectedMaxCaptures: fixture.maxCaptures,
  });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(candidate, "utf8"), "user data\n");
});

test("stale or competing hidden GDB candidates are rejected", () => {
  const duringBuild = writeRun();
  writeFileSync(candidatePath(duringBuild, "stale"), "stale\n", { mode: 0o600 });
  const rejectedBuild = build(duringBuild, "new");
  assert.match(rejectedBuild.result.reasons.join("; "), /competing or stale/);

  const duringComplete = writeSkip();
  complete(duringComplete);
  writeFileSync(candidatePath(duringComplete, "stale"), "stale\n", { mode: 0o600 });
  assert.match(validate(duringComplete).reasons.join("; "), /competing or stale/);
});

test("candidate is private and an oversized or non-private manifest is rejected", () => {
  const fixture = writeRun();
  const built = build(fixture);
  assert.equal(built.result.ok, true);
  assert.equal(statSync(built.candidate).mode & 0o777, 0o600);
  assert.equal(statSync(built.candidate).uid, process.geteuid());
  renameSync(built.candidate, path.join(fixture.root, "results/gdb.manifest"));
  writeFileSync(path.join(fixture.root, "state/phase-gdb.done"), "");
  const manifest = path.join(fixture.root, "results/gdb.manifest");
  truncateSync(manifest, (fixture.maxRuns + 8) * 513 + 1);
  assert.match(validate(fixture).reasons.join("; "), /size limit/);

  const publicFixture = writeRun();
  complete(publicFixture);
  const publicManifest = path.join(publicFixture.root, "results/gdb.manifest");
  const text = readFileSync(publicManifest);
  rmSync(publicManifest);
  writeFileSync(publicManifest, text, { mode: 0o644 });
  assert.match(validate(publicFixture).reasons.join("; "), /mode 600/);
});

test("foreign-owned evidence is rejected", { skip: process.geteuid() !== 0 }, () => {
  const fixture = writeSkip();
  chownSync(path.join(fixture.root, "results/gdb.meta"), 65534, 65534);
  assert.match(build(fixture).result.reasons.join("; "), /owned by the effective user/);
});

test("anchored directories, manifest, and held completion marker reject unsafe path types", () => {
  const directoryFixture = writeRun();
  const gdb = path.join(directoryFixture.root, "gdb");
  renameSync(gdb, `${gdb}.real`);
  symlinkSync(`${gdb}.real`, gdb);
  assert.equal(build(directoryFixture).result.ok, false);

  const hardlinkedManifest = writeRun();
  complete(hardlinkedManifest);
  const manifest = path.join(hardlinkedManifest.root, "results/gdb.manifest");
  linkSync(manifest, `${manifest}.second-link`);
  assert.match(validate(hardlinkedManifest).reasons.join("; "), /single-link/);

  const fifoManifest = writeRun();
  complete(fifoManifest);
  const fifoPath = path.join(fifoManifest.root, "results/gdb.manifest");
  rmSync(fifoPath);
  assert.equal(spawnSync("mkfifo", [fifoPath]).status, 0);
  assert.match(validate(fifoManifest).reasons.join("; "), /single-link/);

  const markerFixture = writeRun();
  complete(markerFixture);
  const marker = path.join(markerFixture.root, "state/phase-gdb.done");
  renameSync(marker, `${marker}.real`);
  symlinkSync(`${marker}.real`, marker);
  assert.match(validate(markerFixture).reasons.join("; "), /single-link/);
});

test("post-read transcript mutation is detected without retaining every transcript descriptor", () => {
  const fixture = writeRun();
  complete(fixture);
  const transcript = path.join(fixture.root, "gdb/cpu7-run1.txt");
  const result = validate(fixture, {
    afterArtifactScan() {
      writeFileSync(transcript, readFileSync(transcript, "utf8").replace("raw gdb output", "changed output"));
    },
  });
  assert.match(result.reasons.join("; "), /digest|changed between validation passes/);
});

test("run, results-entry, and descriptor use stay structurally bounded", () => {
  const excessiveRuns = tempBundle();
  const excessive = validateGdbEvidence(excessiveRuns, {
    markerMode: "complete",
    expectedCpu: 7,
    expectedMaxRuns: GDB_MAX_RUNS_LIMIT + 1,
    expectedMaxCaptures: 2,
  });
  assert.match(excessive.reasons.join("; "), new RegExp(`MAX_RUNS.*${GDB_MAX_RUNS_LIMIT}`));

  const crowded = writeSkip();
  for (let index = 0; index < GDB_RESULTS_ENTRY_LIMIT; index += 1) {
    writeFileSync(path.join(crowded.root, "results", `unrelated-${index}`), "");
  }
  assert.match(build(crowded).result.reasons.join("; "), /inventory/);

  const manyMissingOutcomes = [...Array(GDB_ERROR_LIMIT + 8).fill("error"), "clean"];
  const manyMissing = writeRun({ outcomes: manyMissingOutcomes, maxRuns: manyMissingOutcomes.length });
  for (let run = 1; run < manyMissingOutcomes.length; run += 1) {
    rmSync(path.join(manyMissing.root, "gdb", `cpu${manyMissing.cpu}-run${run}.txt`));
  }
  const boundedErrors = build(manyMissing).result;
  assert.equal(boundedErrors.ok, false);
  assert.ok(boundedErrors.reasons.length <= GDB_ERROR_LIMIT + 1);

  const outcomes = [...Array(40).fill("error"), "clean"];
  const many = writeRun({ outcomes, maxRuns: outcomes.length });
  const built = build(many);
  assert.equal(built.result.ok, true, built.result.reasons.join("; "));
  renameSync(built.candidate, path.join(many.root, "results/gdb.manifest"));
  writeFileSync(path.join(many.root, "state/phase-gdb.done"), "");
  const baselineFds = readdirSync("/proc/self/fd").length;
  let observedFds = null;
  const checked = validate(many, {
    afterArtifactScan() {
      observedFds = readdirSync("/proc/self/fd").length;
    },
  });
  assert.equal(checked.ok, true, checked.reasons.join("; "));
  assert.ok(observedFds <= baselineFds + 20, `descriptor growth was ${observedFds - baselineFds}`);
});

test("missing evidence exposes one fixed-shape non-success probe for Bash", () => {
  const root = tempBundle();
  const result = validateGdbEvidence(root, {
    markerMode: "complete",
    expectedCpu: 7,
    expectedMaxRuns: 3,
    expectedMaxCaptures: 2,
  });
  assert.equal(result.ok, false);
  assert.match(result.probe, /^GDB_EVIDENCE\tVERSION\t1\tSTATUS\tINVALID\tGENERATION\t-\tOUTCOME\t-$/);
});

test("collectAttempts receives exactly the final-pass attempt bindings", () => {
  const fixture = writeRun({ outcomes: ["captured", "clean", "error"], maxCaptures: 2 });
  complete(fixture);
  const attempts = [{ stale: true }];
  const result = validate(fixture, { collectAttempts: attempts });
  assert.equal(result.ok, true, result.reasons.join("; "));
  assert.equal(attempts.length, 3, "bindings come from one final pass, never duplicated");
  assert.deepEqual(attempts.map((attempt) => attempt.id), [1, 2, 3]);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["captured", "clean", "error"]);
  const [captured, clean, error] = attempts;
  assert.equal(clean.relative, "-");
  assert.equal(clean.bytes, "-");
  assert.equal(clean.sha256, "-");
  for (const [bound, run] of [[captured, 1], [error, 3]]) {
    assert.equal(bound.relative, `gdb/cpu7-run${run}.txt`);
    assert.match(bound.sha256, /^[0-9a-f]{64}$/);
    assert.equal(bound.bytes, String(statSync(path.join(fixture.root, bound.relative)).size));
  }

  const skipped = writeSkip();
  complete(skipped);
  const skippedAttempts = [];
  assert.equal(validate(skipped, { collectAttempts: skippedAttempts }).ok, true);
  assert.deepEqual(skippedAttempts, [], "skip envelopes bind no attempts");

  const tampered = writeRun();
  complete(tampered);
  writeFileSync(path.join(tampered.root, "gdb/cpu7-run1.txt"), "tampered\n");
  const stale = [{ stale: true }];
  const failed = validate(tampered, { collectAttempts: stale });
  assert.equal(failed.ok, false);
  assert.deepEqual(stale, [], "invalid validation leaves the array empty");
});

test("inspectGdbManifestConfig discovers expectations without validating evidence", () => {
  const run = writeRun({ outcomes: ["captured", "clean", "error"], maxCaptures: 2 });
  complete(run);
  assert.deepEqual(inspectGdbManifestConfig(run.root), {
    ok: true,
    generation: GENERATION,
    status: "RUN",
    maxRuns: 3,
    maxCaptures: 2,
    cpu: 7,
    skipKind: null,
    reasons: [],
  });

  const skipped = writeSkip("no failing CPU identified");
  complete(skipped);
  assert.deepEqual(inspectGdbManifestConfig(skipped.root), {
    ok: true,
    generation: GENERATION,
    status: "SKIPPED",
    maxRuns: 6,
    maxCaptures: 3,
    cpu: null,
    skipKind: "no failing CPU identified",
    reasons: [],
  });

  // A semantically retuned prefix is still discovered verbatim: only the full
  // validator proves the configuration against the bound artifacts.
  const retuned = writeRun();
  complete(retuned);
  replaceLine(retuned.root, "CONFIG\tMAX_RUNS\t3", "CONFIG\tMAX_RUNS\t9");
  const discovered = inspectGdbManifestConfig(retuned.root);
  assert.equal(discovered.ok, true, discovered.reasons?.join("; "));
  assert.equal(discovered.maxRuns, 9);
  assert.equal(validate(retuned).ok, false);
});

test("inspectGdbManifestConfig rejects missing, malformed, non-private, and oversized manifests", () => {
  const missing = tempBundle();
  assert.equal(inspectGdbManifestConfig(missing).ok, false);

  const malformed = writeRun();
  complete(malformed);
  replaceLine(malformed.root, "CONFIG\tMAX_RUNS\t3", "CONFIG\tMAX_RUNS\t03");
  const bad = inspectGdbManifestConfig(malformed.root);
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.length > 0);

  const truncated = writeRun();
  complete(truncated);
  const file = path.join(truncated.root, "results/gdb.manifest");
  writeFileSync(file, readFileSync(file, "utf8").slice(0, -1));
  assert.match(inspectGdbManifestConfig(truncated.root).reasons.join("; "), /end with LF/);

  const publicFixture = writeRun();
  complete(publicFixture);
  chmodSync(path.join(publicFixture.root, "results/gdb.manifest"), 0o644);
  assert.match(inspectGdbManifestConfig(publicFixture.root).reasons.join("; "), /mode 600/);

  const oversized = writeRun();
  complete(oversized);
  truncateSync(
    path.join(oversized.root, "results/gdb.manifest"),
    (GDB_MAX_RUNS_LIMIT + 8) * 513 + 1,
  );
  assert.match(inspectGdbManifestConfig(oversized.root).reasons.join("; "), /size limit/);
});
