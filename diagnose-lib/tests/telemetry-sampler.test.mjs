import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INTERVAL_MS,
  MAX_RECORD_BYTES,
  MAX_SYSFS_VALUE_BYTES,
  canonicalTelemetryLine,
  captureTelemetryTimestamp,
  createTelemetryRecorder,
  discoverTelemetry,
  parseCpuList,
  runTelemetryCli,
  sampleTelemetry,
} from "../telemetry-sampler.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const samplerScript = path.join(testDir, "..", "telemetry-sampler.mjs");
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "telemetry-sampler-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeAttribute(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`);
}

function writeCpu(cpuRoot, cpu, { packageId, die, core, frequency }) {
  const root = path.join(cpuRoot, `cpu${cpu}`);
  writeAttribute(path.join(root, "topology", "physical_package_id"), packageId);
  if (die !== undefined) writeAttribute(path.join(root, "topology", "die_id"), die);
  writeAttribute(path.join(root, "topology", "core_id"), core);
  if (frequency !== undefined) {
    writeAttribute(path.join(root, "cpufreq", "scaling_cur_freq"), frequency);
  }
}

function writeHwmon(hwmonRoot, number, name, channels = []) {
  const root = path.join(hwmonRoot, `hwmon${number}`);
  writeAttribute(path.join(root, "name"), name);
  for (const channel of channels) {
    writeAttribute(path.join(root, `temp${channel.number}_label`), channel.label);
    if (channel.input !== undefined) {
      writeAttribute(path.join(root, `temp${channel.number}_input`), channel.input);
    }
  }
  return root;
}

function populatedFixture() {
  const root = tempDir();
  const cpuRoot = path.join(root, "cpu");
  const hwmonRoot = path.join(root, "hwmon");
  const noTurboPath = path.join(root, "intel_pstate", "no_turbo");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(hwmonRoot, { recursive: true });
  writeCpu(cpuRoot, 0, { packageId: 0, die: 0, core: 0, frequency: 4_800_000 });
  writeCpu(cpuRoot, 1, { packageId: 0, die: 0, core: 0, frequency: 4_700_000 });
  writeCpu(cpuRoot, 8, { packageId: 0, die: 1, core: 4, frequency: 3_900_000 });
  writeCpu(cpuRoot, 9, { packageId: 0, die: 1, core: 4 });
  writeHwmon(hwmonRoot, 2, "acpitz", [
    { number: 1, label: "board", input: 31_000 },
  ]);
  const coretemp = writeHwmon(hwmonRoot, 37, "coretemp", [
    { number: 1, label: "Package id 0", input: 52_000 },
    { number: 2, label: "Core 0", input: 47_000 },
    { number: 5, label: "Core 4", input: 49_000 },
    { number: 9, label: "Mystery sensor", input: 45_000 },
  ]);
  writeAttribute(noTurboPath, 1);
  return { root, cpuRoot, hwmonRoot, noTurboPath, coretemp };
}

function fixtureDiscovery(fixture = populatedFixture()) {
  return {
    fixture,
    discovery: discoverTelemetry({
      cpuRoot: fixture.cpuRoot,
      hwmonRoot: fixture.hwmonRoot,
      noTurboPath: fixture.noTurboPath,
      cpus: [9, 1, 8, 0],
    }),
  };
}

function deterministicClock(startNs = 10_000n, unixMs = 1_786_000_000_123) {
  let monotonic = startNs;
  return {
    monotonicNs() {
      const result = monotonic;
      monotonic += 10n;
      return result;
    },
    unixMs() { return unixMs; },
  };
}

test("discovers non-hardcoded coretemp hwmon labels and maps shared logical cores", () => {
  const { discovery } = fixtureDiscovery();
  assert.deepEqual(discovery.metadata.cpus.map((entry) => entry.cpu), [0, 1, 8, 9]);
  assert.deepEqual(
    discovery.metadata.cpus.map(({ cpu, package: packageId, die, core }) =>
      [cpu, packageId, die, core]),
    [
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [8, 0, 1, 4],
      [9, 0, 1, 4],
    ],
  );
  assert.equal(discovery.metadata.coretemp.state, "available");
  assert.deepEqual(
    discovery.metadata.temperature_sensors.map(({ id, hwmon, label }) => [id, hwmon, label]),
    [
      ["ct0:t1", "hwmon37", "Package id 0"],
      ["ct0:t2", "hwmon37", "Core 0"],
      ["ct0:t5", "hwmon37", "Core 4"],
      ["ct0:t9", "hwmon37", "Mystery sensor"],
    ],
  );
  assert.deepEqual(discovery.metadata.temperature_targets.packages, [
    { package: 0, sensor: "ct0:t1" },
  ]);
  assert.deepEqual(
    discovery.metadata.temperature_targets.cores.map((target) => ({
      package: target.package,
      die: target.die,
      core: target.core,
      logical_cpus: target.logical_cpus,
      sensor: target.sensor,
    })),
    [
      { package: 0, die: 0, core: 0, logical_cpus: [0, 1], sensor: "ct0:t2" },
      { package: 0, die: 1, core: 4, logical_cpus: [8, 9], sensor: "ct0:t5" },
    ],
  );
  const coreZero = discovery.metadata.temperature_sensors.find((sensor) => sensor.id === "ct0:t2");
  assert.deepEqual(coreZero.logical_cpus, [0, 1]);
  assert.equal(coreZero.die, 0);
  assert.deepEqual(coreZero.mapping, { state: "available", target: "core" });
});

test("snapshot records bounded values and distinguishes unavailable from transient reads", () => {
  const { fixture, discovery } = fixtureDiscovery();
  const first = sampleTelemetry(discovery, {
    seq: 0,
    clock: deterministicClock(),
    startMonotonicNs: 10_000n,
  });
  assert.equal(first.unix_ms, 1_786_000_000_123);
  assert.equal(first.monotonic_ns, "0");
  assert.equal(first.read_duration_ns, "10");
  assert.deepEqual(first.scaling_cur_freq_khz, [
    [0, 4_800_000],
    [1, 4_700_000],
    [8, 3_900_000],
    [9, { state: "unavailable", reason: "missing" }],
  ]);
  assert.deepEqual(first.package_temperature_millicelsius, [[0, 52_000]]);
  assert.deepEqual(first.core_temperature_millicelsius, [
    [0, 0, 0, 47_000],
    [0, 1, 4, 49_000],
  ]);
  assert.deepEqual(first.unmapped_temperature_millicelsius, [["ct0:t9", 45_000]]);
  assert.equal(first.no_turbo, 1);

  rmSync(path.join(fixture.cpuRoot, "cpu1", "cpufreq", "scaling_cur_freq"));
  writeAttribute(path.join(fixture.cpuRoot, "cpu9", "cpufreq", "scaling_cur_freq"), 3_800_000);
  writeAttribute(path.join(fixture.coretemp, "temp5_input"), "not-an-integer");
  rmSync(fixture.noTurboPath);
  const second = sampleTelemetry(discovery, {
    seq: 1,
    clock: deterministicClock(20_000n),
    startMonotonicNs: 20_000n,
  });
  assert.deepEqual(second.scaling_cur_freq_khz, [
    [0, 4_800_000],
    [1, { state: "transient", reason: "missing" }],
    [8, 3_900_000],
    [9, 3_800_000],
  ]);
  assert.deepEqual(second.core_temperature_millicelsius[1][3], {
    state: "transient",
    reason: "invalid_value",
  });
  assert.deepEqual(second.no_turbo, { state: "transient", reason: "missing" });
});

test("snapshot reads no_turbo before capturing its ending timestamp", () => {
  const { fixture, discovery } = fixtureDiscovery();
  writeAttribute(fixture.noTurboPath, 1);
  let monotonicCalls = 0;
  const clock = {
    monotonicNs() {
      monotonicCalls += 1;
      if (monotonicCalls === 1) return 50_000n;
      // The second monotonic read closes the sample interval. Changing the
      // fixture here distinguishes a no_turbo read inside that interval from
      // the old ordering, which read it only after the interval had ended.
      writeAttribute(fixture.noTurboPath, 0);
      return 50_025n;
    },
    unixMs() { return 1_786_000_000_456; },
  };

  const sample = sampleTelemetry(discovery, {
    clock,
    startMonotonicNs: 50_000n,
  });

  assert.equal(monotonicCalls, 2);
  assert.equal(sample.read_duration_ns, "25");
  assert.equal(sample.no_turbo, 1);
  assert.equal(readFileSync(fixture.noTurboPath, "utf8"), "0\n");
});

test("missing sources and missing topology remain explicit instead of being omitted", () => {
  const root = tempDir();
  const cpuRoot = path.join(root, "cpu");
  const hwmonRoot = path.join(root, "hwmon");
  const noTurboPath = path.join(root, "intel_pstate", "no_turbo");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(hwmonRoot, { recursive: true });
  writeCpu(cpuRoot, 3, { packageId: 1, core: 7 });
  writeHwmon(hwmonRoot, 99, "acpitz");
  writeAttribute(noTurboPath, "invalid");
  const discovery = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [3] });
  assert.deepEqual(discovery.metadata.cpus[0].die, {
    state: "unavailable",
    reason: "missing",
  });
  assert.deepEqual(discovery.metadata.coretemp, {
    state: "unavailable",
    reason: "not_found",
  });
  assert.deepEqual(discovery.metadata.temperature_targets.packages, [{
    package: 1,
    sensor: { state: "unavailable", reason: "no_sensor" },
  }]);
  const sample = sampleTelemetry(discovery, {
    clock: deterministicClock(),
    startMonotonicNs: 10_000n,
  });
  assert.deepEqual(sample.package_temperature_millicelsius, [[
    1,
    { state: "unavailable", reason: "no_sensor" },
  ]]);
  assert.deepEqual(sample.core_temperature_millicelsius, [[
    1,
    null,
    7,
    { state: "unavailable", reason: "no_sensor" },
  ]]);
  assert.deepEqual(sample.no_turbo, { state: "unavailable", reason: "invalid_value" });
});

test("a repeated core_id on different dies is reported as ambiguous", () => {
  const root = tempDir();
  const cpuRoot = path.join(root, "cpu");
  const hwmonRoot = path.join(root, "hwmon");
  const noTurboPath = path.join(root, "no_turbo");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(hwmonRoot, { recursive: true });
  writeCpu(cpuRoot, 0, { packageId: 0, die: 0, core: 0, frequency: 4_000_000 });
  writeCpu(cpuRoot, 1, { packageId: 0, die: 1, core: 0, frequency: 4_000_000 });
  writeHwmon(hwmonRoot, 17, "coretemp", [
    { number: 1, label: "Package id 0", input: 50_000 },
    { number: 2, label: "Core 0", input: 48_000 },
  ]);
  writeAttribute(noTurboPath, 0);
  const discovery = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [0, 1] });
  assert.deepEqual(
    discovery.metadata.temperature_targets.cores.map((target) => target.sensor),
    [
      { state: "unavailable", reason: "ambiguous_topology" },
      { state: "unavailable", reason: "ambiguous_topology" },
    ],
  );
  const coreSensor = discovery.metadata.temperature_sensors.find((sensor) => sensor.kind === "core");
  assert.deepEqual(coreSensor.mapping, {
    state: "unavailable",
    reason: "ambiguous_topology",
  });
  const sample = sampleTelemetry(discovery, {
    clock: deterministicClock(),
    startMonotonicNs: 10_000n,
  });
  assert.deepEqual(sample.unmapped_temperature_millicelsius, [["ct0:t2", 48_000]]);
});

test("sysfs value and symlink bounds fail closed", () => {
  const root = tempDir();
  const cpuRoot = path.join(root, "cpu");
  const hwmonRoot = path.join(root, "hwmon");
  const noTurboPath = path.join(root, "no_turbo");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(hwmonRoot, { recursive: true });
  writeCpu(cpuRoot, 0, { packageId: 0, die: 0, core: 0 });
  const oversized = path.join(root, "oversized");
  writeFileSync(oversized, Buffer.alloc(MAX_SYSFS_VALUE_BYTES + 1, 0x31));
  const frequency = path.join(cpuRoot, "cpu0", "cpufreq", "scaling_cur_freq");
  mkdirSync(path.dirname(frequency), { recursive: true });
  symlinkSync(oversized, frequency);
  writeAttribute(noTurboPath, 0);
  const symlinked = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [0] });
  assert.deepEqual(symlinked.metadata.cpus[0].scaling_cur_freq, {
    state: "unavailable",
    reason: "symlink_rejected",
  });
  rmSync(frequency);
  writeFileSync(frequency, Buffer.alloc(MAX_SYSFS_VALUE_BYTES + 1, 0x31));
  const tooLarge = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [0] });
  assert.deepEqual(tooLarge.metadata.cpus[0].scaling_cur_freq, {
    state: "unavailable",
    reason: "value_too_large",
  });
});

test("CPU-list, interval, timestamp, and record bounds are enforced", () => {
  assert.deepEqual(parseCpuList("8-10,0,3"), [0, 3, 8, 9, 10]);
  for (const invalid of ["", "01", "1-0", "0,0", "65536", "0-4096", "0,"]) {
    assert.throws(() => parseCpuList(invalid), undefined, invalid);
  }
  assert.throws(
    () => captureTelemetryTimestamp({
      startMonotonicNs: 2n,
      clock: { monotonicNs: () => 1n, unixMs: () => 1 },
    }),
    /regressing/,
  );
  assert.throws(
    () => canonicalTelemetryLine({ payload: "x".repeat(MAX_RECORD_BYTES) }),
    /record exceeds/,
  );
  const { discovery } = fixtureDiscovery();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  assert.throws(
    () => createTelemetryRecorder({ discovery, output, intervalMs: 49 }),
    /intervalMs/,
  );
  assert.throws(
    () => createTelemetryRecorder({ discovery, output, maxOutputBytes: 1024 }),
    /maxOutputBytes/,
  );
});

test("recorder emits canonical metadata, an immediate sample, and a bounded end record", async () => {
  const { discovery } = fixtureDiscovery();
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const recorder = createTelemetryRecorder({
    discovery,
    output,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxSamples: 1,
    clock: deterministicClock(1_000_000n, 1_786_000_001_000),
  });
  const metadata = await recorder.start();
  const result = await recorder.done;
  assert.equal(recorder.state, "stopped");
  assert.equal(result.reason, "sample_limit");
  assert.equal(result.samples, 1);
  const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), [
    "telemetry_metadata",
    "telemetry_sample",
    "telemetry_end",
  ]);
  assert.equal(records[0].interval_ms, DEFAULT_INTERVAL_MS);
  assert.equal(records[0].monotonic_origin_ns, "1000000");
  assert.match(records[0].method.scaling_cur_freq.note, /not effective frequency/);
  assert.equal(records[2].reason, "sample_limit");
  assert.equal(metadata.type, "telemetry_metadata");
  for (let index = 0; index < records.length; index += 1) {
    assert.equal(`${lines[index]}\n`, canonicalTelemetryLine(records[index]));
  }
});

test("recorder stop interrupts its timer and exposes matching boundary timestamps", async () => {
  const { discovery } = fixtureDiscovery();
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const recorder = createTelemetryRecorder({
    discovery,
    output,
    intervalMs: 60_000,
    maxSamples: 10,
  });
  assert.throws(() => recorder.timestamp(), /has not started/);
  await recorder.start();
  const boundary = recorder.timestamp();
  assert.ok(Number.isSafeInteger(boundary.unix_ms));
  assert.match(boundary.monotonic_ns, /^(0|[1-9][0-9]*)$/);
  const result = await recorder.stop("requested");
  assert.equal(result.reason, "requested");
  assert.equal(result.samples, 1);
  const records = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(records.at(-1).type, "telemetry_end");
  assert.equal(records.at(-1).reason, "requested");
});

test("shell CLI records only fixture telemetry and refuses to overwrite output", async () => {
  const fixture = populatedFixture();
  const output = path.join(fixture.root, "telemetry.ndjson");
  const args = [
    samplerScript,
    "--once",
    "--cpus", "0-1",
    "--cpu-root", fixture.cpuRoot,
    "--hwmon-root", fixture.hwmonRoot,
    "--no-turbo-path", fixture.noTurboPath,
    "--output", output,
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const records = readFileSync(output, "utf8").trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((record) => record.type), [
    "telemetry_metadata",
    "telemetry_sample",
    "telemetry_end",
  ]);
  assert.equal(records[0].interval_ms, 250);
  assert.equal(records[1].no_turbo, 1);

  let stderrText = "";
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrText += chunk.toString();
      callback();
    },
  });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const signalSource = new EventEmitter();
  const overwrite = await runTelemetryCli(args.slice(1), {
    stdout: sink,
    stderr,
    signalSource,
  });
  assert.equal(overwrite, 1);
  assert.match(stderrText, /EEXIST/);

  stderrText = "";
  const invalid = await runTelemetryCli([
    "--once",
    "--interval-ms", "49",
    "--cpu-root", fixture.cpuRoot,
    "--hwmon-root", fixture.hwmonRoot,
    "--no-turbo-path", fixture.noTurboPath,
  ], { stdout: sink, stderr, signalSource });
  assert.equal(invalid, 2);
  assert.match(stderrText, /intervalMs/);
});
