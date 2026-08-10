import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTelemetryBoundary,
  parseTelemetryMeta,
} from "../telemetry-evidence.mjs";
import {
  createTelemetryRecorder,
  discoverTelemetry,
} from "../telemetry-sampler.mjs";
import {
  TelemetrySessionInputError,
  TelemetrySessionStateError,
  buildTelemetryEnvelopeStaging,
  captureTelemetryBoundaryPoint,
  captureTelemetryBoundaryStart,
  finishTelemetryBoundary,
  mintTelemetryGeneration,
  normalizeTelemetrySegments,
  parseTelemetrySegmentsJson,
  publishTelemetryEnvelope,
  publishTelemetryEnvelopeStaging,
  readTelemetryBoundaryStart,
  runTelemetrySessionCli,
} from "../telemetry-session.mjs";

const testDir = path.dirname(new URL(import.meta.url).pathname);
const sessionScript = path.join(testDir, "..", "telemetry-session.mjs");
const GENERATION = "0123456789abcdef0123456789abcdef";
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = "telemetry-session-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAttribute(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`);
}

function fixedClock(unixMs, monotonicNs) {
  return {
    unixMs: () => unixMs,
    monotonicNs: () => monotonicNs,
  };
}

function fixtureNoTurbo(value = 0) {
  const root = temporaryDirectory("telemetry-session-no-turbo-");
  const file = path.join(root, "no_turbo");
  writeAttribute(file, value);
  return file;
}

test("generation minting is exactly 128 bits of lowercase hexadecimal", () => {
  assert.equal(
    mintTelemetryGeneration({ randomBytes: () => Buffer.alloc(16, 0xab) }),
    "abababababababababababababababab",
  );
  assert.match(mintTelemetryGeneration(), /^[a-f0-9]{32}$/);
  assert.throws(
    () => mintTelemetryGeneration({ randomBytes: () => Buffer.alloc(15) }),
    TelemetrySessionStateError,
  );
});

test("start and finish create private exact boundaries without changing no_turbo", () => {
  const root = temporaryDirectory();
  const noTurboPath = fixtureNoTurbo(0);
  const statePath = path.join(root, "start.json");
  const outputPath = path.join(root, "boundary.json");
  const start = captureTelemetryBoundaryStart({
    statePath,
    phase: "individual",
    tag: "isolated-protocol",
    generation: GENERATION,
    segment: 1,
    noTurboPath,
    clock: fixedClock(1_800_000_000_000, 10_000n),
  });
  assert.equal(start.recovered, false);
  assert.deepEqual(start.state.start, {
    unixMs: 1_800_000_000_000,
    monotonicNs: "10000",
    noTurbo: 0,
  });
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(statSync(statePath).nlink, 1);

  writeAttribute(noTurboPath, 1);
  const finished = finishTelemetryBoundary({
    statePath,
    outputPath,
    noTurboPath,
    clock: fixedClock(1_800_000_000_100, 20_000n),
  });
  assert.equal(finished.recovered, false);
  const parsed = parseTelemetryBoundary(readFileSync(outputPath), {
    phase: "individual",
    tag: "isolated-protocol",
    generation: GENERATION,
    segment: 1,
  });
  assert.equal(parsed.status, "complete");
  assert.equal(parsed.boundary.start.noTurbo, 0);
  assert.equal(parsed.boundary.end.noTurbo, 1);
  assert.equal(parsed.boundary.end.monotonicNs, "20000");
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(noTurboPath, "utf8"), "1\n", "the helper only reads no_turbo");
});

test("single-file publication stays anchored when its public parent is replaced", () => {
  const root = temporaryDirectory();
  const parent = path.join(root, "state");
  const retainedParent = path.join(root, "retained-state");
  const divertedParent = path.join(root, "diverted-state");
  mkdirSync(parent);
  mkdirSync(divertedParent);
  const statePath = path.join(parent, "start.json");
  assert.throws(
    () => captureTelemetryBoundaryStart({
      statePath,
      phase: "individual",
      tag: "isolated-protocol",
      generation: GENERATION,
      segment: 1,
      noTurboPath: fixtureNoTurbo(0),
      clock: fixedClock(1_800_000_000_000, 10_000n),
      afterDirectoriesInspected() {
        renameSync(parent, retainedParent);
        symlinkSync(divertedParent, parent);
      },
    }),
    /parent directory changed while telemetry output was published/,
  );
  assert.equal(existsSync(path.join(retainedParent, "start.json")), false);
  assert.equal(existsSync(path.join(divertedParent, "start.json")), false);
});

test("missing or malformed no_turbo is retained as canonical unavailable state", () => {
  const root = temporaryDirectory();
  const missing = path.join(root, "missing-no-turbo");
  assert.deepEqual(
    captureTelemetryBoundaryPoint({
      noTurboPath: missing,
      clock: fixedClock(1, 2n),
    }),
    {
      unixMs: 1,
      monotonicNs: "2",
      noTurbo: { state: "unavailable", reason: "missing" },
    },
  );
  const malformed = path.join(root, "no_turbo");
  writeAttribute(malformed, "turbo-ish");
  assert.deepEqual(
    captureTelemetryBoundaryPoint({
      noTurboPath: malformed,
      clock: fixedClock(3, 4n),
    }).noTurbo,
    { state: "unavailable", reason: "invalid_value" },
  );
});

test("recovery reuses only matching immutable start and boundary artifacts", () => {
  const root = temporaryDirectory();
  const noTurboPath = fixtureNoTurbo(0);
  const statePath = path.join(root, "start.json");
  const outputPath = path.join(root, "boundary.json");
  const identity = {
    statePath,
    phase: "baseline",
    tag: "baseline-run",
    generation: GENERATION,
    segment: 1,
    noTurboPath,
  };
  const first = captureTelemetryBoundaryStart({ ...identity, clock: fixedClock(100, 1_000n) });
  assert.throws(
    () => captureTelemetryBoundaryStart({ ...identity, clock: fixedClock(200, 2_000n) }),
    /never overwrite/,
  );
  const recoveredStart = captureTelemetryBoundaryStart({
    ...identity,
    recover: true,
    clock: { unixMs: () => { throw new Error("must not recapture"); }, monotonicNs: () => 0n },
  });
  assert.equal(recoveredStart.recovered, true);
  assert.deepEqual(recoveredStart.state.start, first.state.start);
  assert.throws(
    () => captureTelemetryBoundaryStart({ ...identity, tag: "wrong-tag", recover: true }),
    /tag disagrees/,
  );

  const completed = finishTelemetryBoundary({
    statePath,
    outputPath,
    noTurboPath,
    clock: fixedClock(200, 2_000n),
  });
  const recoveredFinish = finishTelemetryBoundary({
    statePath,
    outputPath,
    noTurboPath,
    recover: true,
    clock: { unixMs: () => { throw new Error("must not recapture"); }, monotonicNs: () => 0n },
  });
  assert.equal(recoveredFinish.recovered, true);
  assert.deepEqual(recoveredFinish.boundary, completed.boundary);
});

test("unsafe state and a regressed post-reboot clock are refused", () => {
  const root = temporaryDirectory();
  const noTurboPath = fixtureNoTurbo(0);
  const statePath = path.join(root, "start.json");
  const outputPath = path.join(root, "boundary.json");
  captureTelemetryBoundaryStart({
    statePath,
    phase: "gdb",
    tag: "gdb-run",
    generation: GENERATION,
    segment: 1,
    noTurboPath,
    clock: fixedClock(200, 2_000n),
  });
  chmodSync(statePath, 0o644);
  assert.throws(
    () => readTelemetryBoundaryStart(statePath),
    /private/,
  );
  chmodSync(statePath, 0o600);
  const alias = path.join(root, "start-hardlink.json");
  linkSync(statePath, alias);
  assert.throws(
    () => readTelemetryBoundaryStart(statePath),
    /single-link/,
  );
  rmSync(alias);
  assert.throws(
    () => finishTelemetryBoundary({
      statePath,
      outputPath,
      noTurboPath,
      clock: fixedClock(300, 1_000n),
    }),
    /could not be completed/,
  );
  assert.equal(existsSync(outputPath), false);
});

test("segment lists require exact canonical, increasing identities", () => {
  const segments = [{ segment: 1, tag: "first" }, { segment: 2, tag: "second" }];
  assert.deepEqual(normalizeTelemetrySegments(segments), segments);
  assert.deepEqual(parseTelemetrySegmentsJson(JSON.stringify(segments)), segments);
  assert.throws(
    () => parseTelemetrySegmentsJson(` ${JSON.stringify(segments)}`),
    TelemetrySessionInputError,
  );
  assert.throws(
    () => normalizeTelemetrySegments([segments[1], segments[0]]),
    /strictly increasing/,
  );
  assert.throws(
    () => normalizeTelemetrySegments([{ segment: 1, tag: "same" }, { segment: 2, tag: "same" }]),
    /unique/,
  );
});

function createSamplerFixture(bundle) {
  const sysfs = temporaryDirectory("telemetry-session-sysfs-");
  const cpuRoot = path.join(sysfs, "cpu");
  const hwmonRoot = path.join(sysfs, "hwmon");
  const noTurboPath = path.join(sysfs, "intel_pstate", "no_turbo");
  mkdirSync(hwmonRoot, { recursive: true });
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "physical_package_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "die_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "core_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "cpufreq", "scaling_cur_freq"), 4_500_000);
  writeAttribute(noTurboPath, 0);
  const discovery = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [0] });
  const log = path.join(bundle, "telemetry", "baseline", `${GENERATION}-1.ndjson`);
  return { discovery, log, noTurboPath };
}

async function createCompleteSegmentBundle() {
  const bundle = temporaryDirectory("telemetry-session-bundle-");
  mkdirSync(path.join(bundle, "results"));
  mkdirSync(path.join(bundle, "state"));
  mkdirSync(path.join(bundle, "telemetry", "baseline"), { recursive: true });
  const fixture = createSamplerFixture(bundle);
  const recorder = createTelemetryRecorder({
    discovery: fixture.discovery,
    outputPath: fixture.log,
    intervalMs: 50,
  });
  await recorder.start();
  const statePath = path.join(bundle, "state", "telemetry-baseline-start.json");
  const boundary = path.join(bundle, "telemetry", "baseline", `${GENERATION}-1.boundary.json`);
  captureTelemetryBoundaryStart({
    statePath,
    phase: "baseline",
    tag: "baseline-run",
    generation: GENERATION,
    segment: 1,
    noTurboPath: fixture.noTurboPath,
  });
  await new Promise((resolve) => setTimeout(resolve, 130));
  finishTelemetryBoundary({
    statePath,
    outputPath: boundary,
    noTurboPath: fixture.noTurboPath,
  });
  await recorder.stop("requested");
  return { bundle, fixture };
}

test("envelope staging and paired publication bind complete sampler evidence", async () => {
  const { bundle } = await createCompleteSegmentBundle();
  const options = {
    phase: "baseline",
    generation: GENERATION,
    intervalMs: 50,
    segments: [{ segment: 1, tag: "baseline-run" }],
    indexOutput: path.join(bundle, "results", "telemetry-baseline.tsv"),
    metaOutput: path.join(bundle, "results", "telemetry-baseline.meta"),
  };
  const staging = buildTelemetryEnvelopeStaging(bundle, options);
  assert.equal(staging.status, "complete");
  assert.equal(staging.rows.length, 1);
  const published = publishTelemetryEnvelopeStaging(staging, options);
  assert.equal(published.indexOutput, options.indexOutput);
  assert.equal(parseTelemetryMeta(readFileSync(options.metaOutput)).reasons.length, 0);
  assert.equal(statSync(options.indexOutput).mode & 0o777, 0o600);
  assert.equal(statSync(options.metaOutput).mode & 0o777, 0o600);

  assert.throws(() => publishTelemetryEnvelope(bundle, options), /never overwrite/);

  const rollbackIndex = path.join(bundle, "results", "rollback.tsv");
  const occupiedMeta = path.join(bundle, "results", "occupied.meta");
  writeFileSync(occupiedMeta, "occupied\n", { mode: 0o600 });
  assert.throws(
    () => publishTelemetryEnvelopeStaging(staging, {
      indexOutput: rollbackIndex,
      metaOutput: occupiedMeta,
    }),
    /never overwrite/,
  );
  assert.equal(existsSync(rollbackIndex), false, "paired publication rolls back its first new file");
  assert.equal(readFileSync(occupiedMeta, "utf8"), "occupied\n");

  const cliIndex = path.join(bundle, "results", "cli.tsv");
  const cliMeta = path.join(bundle, "results", "cli.meta");
  let cliStdout = "";
  let cliStderr = "";
  const cliCode = runTelemetrySessionCli([
    "envelope",
    "--bundle-dir", bundle,
    "--phase", "baseline",
    "--generation", GENERATION,
    "--interval-ms", "50",
    "--workload-generation", "-",
    "--workload-binding-sha256", "a".repeat(64),
    "--workload-boundaries-sha256", "-",
    "--workload-boundary-row-count", "-",
    "--segments-json", '[{"segment":1,"tag":"baseline-run"}]',
    "--index-output", cliIndex,
    "--meta-output", cliMeta,
  ], {
    stdout: { write: (chunk) => { cliStdout += chunk; } },
    stderr: { write: (chunk) => { cliStderr += chunk; } },
  });
  assert.equal(cliCode, 0, cliStderr);
  assert.equal(parseTelemetryMeta(readFileSync(cliMeta)).meta.VERSION, "2");
  assert.deepEqual(JSON.parse(cliStdout), {
    index: cliIndex,
    meta: cliMeta,
    rows: 1,
    status: "complete",
  });
});

test("paired publication stays anchored and rolls back when its public parent is replaced", async () => {
  const { bundle } = await createCompleteSegmentBundle();
  const parent = path.join(bundle, "results");
  const retainedParent = path.join(bundle, "retained-results");
  const divertedParent = path.join(bundle, "diverted-results");
  mkdirSync(divertedParent);
  const options = {
    phase: "baseline",
    generation: GENERATION,
    intervalMs: 50,
    segments: [{ segment: 1, tag: "baseline-run" }],
    indexOutput: path.join(parent, "telemetry-baseline.tsv"),
    metaOutput: path.join(parent, "telemetry-baseline.meta"),
  };
  const staging = buildTelemetryEnvelopeStaging(bundle, options);
  assert.throws(
    () => publishTelemetryEnvelopeStaging(staging, {
      ...options,
      afterDirectoriesInspected() {
        renameSync(parent, retainedParent);
        symlinkSync(divertedParent, parent);
      },
    }),
    /parent directory changed while telemetry output was published/,
  );
  for (const name of ["telemetry-baseline.tsv", "telemetry-baseline.meta"]) {
    assert.equal(existsSync(path.join(retainedParent, name)), false);
    assert.equal(existsSync(path.join(divertedParent, name)), false);
  }
});

test("CLI is concise, absolute-path-only, recoverable, and read-only", () => {
  const root = temporaryDirectory();
  const noTurboPath = fixtureNoTurbo(0);
  const statePath = path.join(root, "start.json");
  const boundaryPath = path.join(root, "boundary.json");
  const minted = execFileSync(process.execPath, [sessionScript, "mint-generation"], { encoding: "utf8" }).trim();
  assert.match(minted, /^[a-f0-9]{32}$/);
  const started = JSON.parse(execFileSync(process.execPath, [
    sessionScript,
    "start",
    "--state-file", statePath,
    "--phase", "groups",
    "--tag", "groups-run",
    "--generation", GENERATION,
    "--segment", "1",
    "--no-turbo-path", noTurboPath,
  ], { encoding: "utf8" }));
  assert.equal(started.recovered, false);
  const finished = JSON.parse(execFileSync(process.execPath, [
    sessionScript,
    "finish",
    "--state-file", statePath,
    "--boundary-output", boundaryPath,
    "--no-turbo-path", noTurboPath,
  ], { encoding: "utf8" }));
  assert.equal(finished.boundary, boundaryPath);
  const recovered = JSON.parse(execFileSync(process.execPath, [
    sessionScript,
    "finish",
    "--state-file", statePath,
    "--boundary-output", boundaryPath,
    "--no-turbo-path", noTurboPath,
    "--recover",
  ], { encoding: "utf8" }));
  assert.equal(recovered.recovered, true);
  assert.equal(readFileSync(noTurboPath, "utf8"), "0\n");

  const relative = spawnSync(process.execPath, [
    sessionScript,
    "finish",
    "--state-file", "relative.json",
    "--boundary-output", boundaryPath,
  ], { encoding: "utf8" });
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /canonical absolute path/);
});
