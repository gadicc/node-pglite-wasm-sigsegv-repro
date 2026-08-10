import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  TELEMETRY_BOUNDARY_MAX_BYTES,
  TELEMETRY_INDEX_HEADER,
  TELEMETRY_LOG_MAX_BYTES,
  assessTelemetryEvidence,
  buildTelemetryEnvelope,
  parseTelemetryBoundary,
  parseTelemetryMeta,
  parseTelemetryNdjson,
  serializeTelemetryBoundary,
  serializeTelemetryIndex,
  serializeTelemetryMeta,
  telemetryFileBinding,
  validateFreshTelemetryTargets,
} from "../telemetry-evidence.mjs";
import {
  canonicalTelemetryLine,
  createTelemetryRecorder,
  discoverTelemetry,
} from "../telemetry-sampler.mjs";

const PHASE = "baseline";
const GENERATION = "0123456789abcdef0123456789abcdef";
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = "telemetry-evidence-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAttribute(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`);
}

function createBundle() {
  const bundle = temporaryDirectory();
  mkdirSync(path.join(bundle, "results"));
  mkdirSync(path.join(bundle, "state"));
  mkdirSync(path.join(bundle, "telemetry", PHASE), { recursive: true });
  return bundle;
}

function deterministicClock(origin, unixMs) {
  let current = origin;
  return {
    monotonicNs() {
      const value = current;
      current += 10n;
      return value;
    },
    unixMs() { return unixMs; },
  };
}

function writeTelemetryRecords(file, records) {
  const prefix = records.slice(0, -1).map(canonicalTelemetryLine).join("");
  records.at(-1).bytes_before_end = Buffer.byteLength(prefix);
  writeFileSync(file, `${prefix}${canonicalTelemetryLine(records.at(-1))}`);
}

function telemetryRecordsBuffer(records) {
  const copy = structuredClone(records);
  const prefix = copy.slice(0, -1).map(canonicalTelemetryLine).join("");
  copy.at(-1).bytes_before_end = Buffer.byteLength(prefix);
  return Buffer.from(`${prefix}${canonicalTelemetryLine(copy.at(-1))}`);
}

function replaceBoundary(segment, boundaryObject) {
  segment.boundaryObject = boundaryObject;
  writeFileSync(segment.boundary, serializeTelemetryBoundary(boundaryObject));
}

function samplerFixture({ noTurbo = 0, sensors = true, ambiguousPackages = false } = {}) {
  const root = temporaryDirectory("telemetry-evidence-sysfs-");
  const cpuRoot = path.join(root, "cpu");
  const hwmonRoot = path.join(root, "hwmon");
  const noTurboPath = path.join(root, "intel_pstate", "no_turbo");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(hwmonRoot, { recursive: true });
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "physical_package_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "die_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "core_id"), 0);
  if (sensors) {
    writeAttribute(path.join(cpuRoot, "cpu0", "cpufreq", "scaling_cur_freq"), 4_500_000);
    writeAttribute(path.join(hwmonRoot, "hwmon37", "name"), "coretemp");
    writeAttribute(path.join(hwmonRoot, "hwmon37", "temp1_label"), "Package id 0");
    writeAttribute(path.join(hwmonRoot, "hwmon37", "temp1_input"), 52_000);
    writeAttribute(path.join(hwmonRoot, "hwmon37", "temp2_label"), "Core 0");
    writeAttribute(path.join(hwmonRoot, "hwmon37", "temp2_input"), 48_000);
    if (ambiguousPackages) {
      writeAttribute(path.join(hwmonRoot, "hwmon38", "name"), "coretemp");
      writeAttribute(path.join(hwmonRoot, "hwmon38", "temp1_label"), "Package id 0");
      writeAttribute(path.join(hwmonRoot, "hwmon38", "temp1_input"), 53_000);
    }
  }
  writeAttribute(noTurboPath, noTurbo);
  return { cpuRoot, hwmonRoot, noTurboPath };
}

async function recordSegment(bundle, {
  segment = 1,
  tag = `segment-${segment}`,
  noTurbo = 0,
  sensors = true,
  ambiguousPackages = false,
  origin = 1_000_000n + BigInt(segment) * 10_000n,
  unixMs = 1_800_000_000_000 + segment,
} = {}) {
  const fixture = samplerFixture({ noTurbo, sensors, ambiguousPackages });
  const discovery = discoverTelemetry({
    cpuRoot: fixture.cpuRoot,
    hwmonRoot: fixture.hwmonRoot,
    noTurboPath: fixture.noTurboPath,
    cpus: [0],
  });
  const log = path.join(bundle, "telemetry", PHASE, `${GENERATION}-${segment}.ndjson`);
  const recorder = createTelemetryRecorder({
    discovery,
    outputPath: log,
    intervalMs: 250,
    maxSamples: 1,
    clock: deterministicClock(origin, unixMs),
  });
  await recorder.start();
  await recorder.done;
  let records = readFileSync(log, "utf8").trimEnd().split("\n").map(JSON.parse);
  const first = records[1];
  const second = {
    ...structuredClone(first),
    seq: 1,
    unix_ms: first.unix_ms + 250,
    monotonic_ns: (BigInt(first.monotonic_ns) + 250_000_000n).toString(),
  };
  const terminal = {
    ...records.at(-1),
    samples: 2,
    unix_ms: first.unix_ms + 500,
    monotonic_ns: (BigInt(first.monotonic_ns) + 500_000_000n).toString(),
  };
  records = [records[0], first, second, terminal];
  writeTelemetryRecords(log, records);
  const metadata = records[0];
  const sample = records[1];
  const end = records.at(-1);
  const observed = sample.no_turbo === 0 || sample.no_turbo === 1
    ? sample.no_turbo
    : { state: "unavailable", reason: sample.no_turbo.reason };
  const boundaryObject = {
    version: 1,
    phase: PHASE,
    tag,
    generation: GENERATION,
    segment,
    start: {
      unixMs: sample.unix_ms,
      monotonicNs: (BigInt(metadata.monotonic_origin_ns) + BigInt(sample.monotonic_ns) +
        BigInt(sample.read_duration_ns)).toString(),
      noTurbo: observed,
    },
    end: {
      unixMs: end.unix_ms,
      monotonicNs: (BigInt(metadata.monotonic_origin_ns) + BigInt(end.monotonic_ns)).toString(),
      noTurbo: observed,
    },
  };
  const boundary = path.join(bundle, "telemetry", PHASE, `${GENERATION}-${segment}.boundary.json`);
  writeFileSync(boundary, serializeTelemetryBoundary(boundaryObject));
  return { segment, tag, log, boundary, records, boundaryObject };
}

function publish(bundle, segments, { marker = true } = {}) {
  const built = buildTelemetryEnvelope(bundle, {
    phase: PHASE,
    generation: GENERATION,
    intervalMs: 250,
    segments: segments.map(({ segment, tag }) => ({ segment, tag })),
  });
  writeFileSync(path.join(bundle, "results", `telemetry-${PHASE}.tsv`), built.rowsBuffer);
  writeFileSync(path.join(bundle, "results", `telemetry-${PHASE}.meta`), built.metaBuffer);
  if (marker) writeFileSync(path.join(bundle, "state", `phase-${PHASE}.done`), "");
  return built;
}

test("sampler fixture builds a complete exact envelope with descriptive summaries", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "baseline-run", noTurbo: 0 });
  const built = publish(bundle, [segment]);
  assert.equal(built.status, "complete", built.reasons.join("\n"));
  assert.ok(Buffer.isBuffer(built.metaBuffer));
  assert.ok(Buffer.isBuffer(built.rowsBuffer));
  assert.equal(built.rows[0].log, `telemetry/${PHASE}/${GENERATION}-1.ndjson`);
  assert.equal(built.noTurbo.status, "complete");
  assert.deepEqual(built.noTurbo.sampledValues, ["0"]);

  const assessment = assessTelemetryEvidence(bundle, {
    phase: PHASE,
    generation: GENERATION,
    intervalMs: 250,
  });
  assert.equal(assessment.status, "complete", assessment.reasons.join("\n"));
  assert.equal(assessment.authoritative, false, "telemetry never owns workload authority");
  assert.equal(assessment.boundaryCoverage.status, "complete");
  assert.equal(assessment.segments[0].coverage.endpointCoverage.start.status, "covered");
  assert.equal(assessment.segments[0].coverage.endpointCoverage.end.status, "covered");
  assert.equal(assessment.segments[0].coverage.workloadSamples.fullyContained, 1);
  assert.equal(assessment.segments[0].coverage.cadence.cadenceViolationCount, 0);
  assert.deepEqual(assessment.noTurbo.sampledValues, ["0"]);
  assert.equal(assessment.noTurbo.validSamples, 2);
  assert.deepEqual(assessment.segments[0].summary.frequencyKHz[0], {
    cpu: 0, count: 2, unavailable: 0, transient: 0, min: 4_500_000, max: 4_500_000, mean: 4_500_000,
  });
  assert.equal(assessment.segments[0].summary.packageTemperatureMillicelsius[0].mean, 52_000);
  assert.equal(assessment.segments[0].summary.coreTemperatureMillicelsius[0].mean, 48_000);
  assert.equal(assessment.segments[0].association.metadata.monotonicOriginNs,
    segment.records[0].monotonic_origin_ns);
  assert.equal(assessment.segments[0].association.metadata.discovery.cpus[0].cpu, 0);
  assert.equal(assessment.segments[0].association.samples.length, 2);
  assert.equal(assessment.segments[0].association.samples[1].scalingCurFreqKHz[0][1], 4_500_000);
  assert.equal(Object.hasOwn(assessment.segments[0].association.samples[0], "type"), false,
    "association payload contains validated join fields, not raw records");
});

test("topology-derived temperature targets and sensor mappings reconcile exactly", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "exact-topology" });
  const exact = parseTelemetryNdjson(readFileSync(segment.log), { intervalMs: 250 });
  assert.equal(exact.status, "complete", exact.reasons.join("\n"));

  const mutations = [
    (discovery) => { discovery.temperature_sensors[0].logical_cpus = []; },
    (discovery) => { discovery.temperature_targets.cores[0].logical_cpus = []; },
    (discovery) => {
      discovery.temperature_targets.cores[0].sensor = discovery.temperature_targets.packages[0].sensor;
    },
    (discovery) => { discovery.temperature_sensors[0].kind = "core"; },
    (discovery) => { discovery.cpu_discovery.count = 2; },
  ];
  for (const mutate of mutations) {
    const records = structuredClone(segment.records);
    mutate(records[0].discovery);
    const parsed = parseTelemetryNdjson(telemetryRecordsBuffer(records), { intervalMs: 250 });
    assert.equal(parsed.status, "invalid", parsed.reasons.join("\n"));
    assert.match(parsed.reasons.join("\n"), /reconcile|reuses|contradicts|invalid/);
  }

  const ambiguousBundle = createBundle();
  const ambiguous = await recordSegment(ambiguousBundle, {
    tag: "ambiguous-package",
    ambiguousPackages: true,
  });
  const parsedAmbiguous = parseTelemetryNdjson(readFileSync(ambiguous.log), { intervalMs: 250 });
  assert.equal(parsedAmbiguous.status, "complete", parsedAmbiguous.reasons.join("\n"));
  assert.deepEqual(parsedAmbiguous.metadata.discovery.temperature_targets.packages[0].sensor, {
    state: "unavailable", reason: "ambiguous_sensor",
  });
  assert.equal(parsedAmbiguous.metadata.discovery.temperature_sensors
    .filter((sensor) => sensor.kind === "package")
    .every((sensor) => sensor.mapping.state === "unavailable" &&
      sensor.mapping.reason === "ambiguous_sensor"), true);

  const unavailableRoot = temporaryDirectory("telemetry-evidence-no-cpus-");
  const cpuRoot = path.join(unavailableRoot, "cpu");
  const hwmonRoot = path.join(unavailableRoot, "hwmon");
  const noTurboPath = path.join(unavailableRoot, "intel_pstate", "no_turbo");
  mkdirSync(cpuRoot);
  mkdirSync(hwmonRoot);
  writeAttribute(noTurboPath, 0);
  const unavailableDiscovery = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath });
  const unavailableLog = path.join(unavailableRoot, "unavailable.ndjson");
  const recorder = createTelemetryRecorder({
    discovery: unavailableDiscovery,
    outputPath: unavailableLog,
    intervalMs: 250,
    maxSamples: 1,
    clock: deterministicClock(9_000_000n, 1_800_000_000_999),
  });
  await recorder.start();
  await recorder.done;
  const unavailableParsed = parseTelemetryNdjson(readFileSync(unavailableLog), { intervalMs: 250 });
  assert.equal(unavailableParsed.status, "complete", unavailableParsed.reasons.join("\n"));
  assert.deepEqual(unavailableParsed.metadata.discovery.cpu_discovery, {
    state: "unavailable", reason: "not_found",
  });
  assert.deepEqual(unavailableParsed.metadata.discovery.cpus, []);
});

test("production-root authorization is opt-in and rejects fixture roots", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "fixture-roots" });
  assert.equal(parseTelemetryNdjson(readFileSync(segment.log)).status, "complete");
  const productionOnly = parseTelemetryNdjson(readFileSync(segment.log), {
    intervalMs: 250,
    requireProductionRoots: true,
  });
  assert.equal(productionOnly.status, "invalid");
  assert.match(productionOnly.reasons.join("\n"), /required production sysfs roots/);

  publish(bundle, [segment]);
  const assessment = assessTelemetryEvidence(bundle, {
    phase: PHASE,
    requireProductionRoots: true,
  });
  assert.equal(assessment.status, "invalid");
  assert.match(assessment.reasons.join("\n"), /required production sysfs roots/);
});

test("a minute-long interior sampling gap is incomplete at a nominal 250 ms cadence", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "long-gap" });
  const records = structuredClone(segment.records);
  const firstStart = BigInt(records[1].monotonic_ns);
  records[2].unix_ms = records[1].unix_ms + 60_000;
  records[2].monotonic_ns = (firstStart + 60_000_000_000n).toString();
  records.at(-1).unix_ms = records[1].unix_ms + 60_250;
  records.at(-1).monotonic_ns = (firstStart + 60_250_000_000n).toString();
  writeTelemetryRecords(segment.log, records);
  segment.records = records;
  const boundary = structuredClone(segment.boundaryObject);
  boundary.end.unixMs = records.at(-1).unix_ms;
  boundary.end.monotonicNs = (BigInt(records[0].monotonic_origin_ns) +
    BigInt(records.at(-1).monotonic_ns)).toString();
  replaceBoundary(segment, boundary);

  const built = publish(bundle, [segment]);
  assert.equal(built.status, "incomplete");
  const coverage = built.segments[0].coverage;
  assert.equal(coverage.workloadSamples.fullyContained, 1);
  assert.ok(BigInt(coverage.cadence.maxStartToStartGapNs) > 59_000_000_000n);
  assert.ok(BigInt(coverage.cadence.maxWorkloadSampleStartGapNs) > 59_000_000_000n);
  assert.ok(BigInt(coverage.cadence.missedPollIntervals) > 200n);
  assert.ok(coverage.cadence.cadenceViolationCount > 0);
  assert.match(coverage.reasons.join("\n"), /sample-start cadence gap/);
});

test("terminal coverage without a during-workload sample sweep is incomplete", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "no-during-sample" });
  const records = segment.records;
  const origin = BigInt(records[0].monotonic_origin_ns);
  const firstStart = BigInt(records[1].monotonic_ns);
  const boundary = structuredClone(segment.boundaryObject);
  boundary.start.unixMs = records[1].unix_ms + 300;
  boundary.start.monotonicNs = (origin + firstStart + 300_000_000n).toString();
  boundary.end.unixMs = records[1].unix_ms + 400;
  boundary.end.monotonicNs = (origin + firstStart + 400_000_000n).toString();
  replaceBoundary(segment, boundary);

  const built = publish(bundle, [segment]);
  assert.equal(built.status, "incomplete");
  const coverage = built.segments[0].coverage;
  assert.equal(coverage.endpointCoverage.start.status, "covered");
  assert.equal(coverage.endpointCoverage.end.status, "covered");
  assert.equal(coverage.workloadSamples.qualifyingDuring, 0);
  assert.equal(coverage.cadence.cadenceViolationCount, 0);
  assert.match(coverage.reasons.join("\n"), /no fully-contained telemetry sample sweep/);
});

test("a regular sampler prefix missing only its terminal record is digest-bound as incomplete", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "interrupted" });
  const lines = readFileSync(segment.log, "utf8").trimEnd().split("\n");
  writeFileSync(segment.log, `${lines.slice(0, 2).join("\n")}\n`);
  const parsed = parseTelemetryNdjson(readFileSync(segment.log));
  assert.equal(parsed.status, "incomplete", parsed.reasons.join("\n"));
  assert.match(parsed.reasons.join("\n"), /terminal record is missing/);

  const built = publish(bundle, [segment]);
  assert.equal(built.status, "incomplete");
  assert.equal(built.rows[0].status, "incomplete");
  assert.equal(built.rows[0].logSha256, telemetryFileBinding(readFileSync(segment.log)).sha256);
  const assessment = assessTelemetryEvidence(bundle, { phase: PHASE });
  assert.equal(assessment.status, "incomplete", assessment.reasons.join("\n"));
  assert.equal(assessment.segments[0].summary.samples, 1);
  assert.equal(assessment.boundaryCoverage.status, "incomplete");
});

test("sequence, monotonic clock, terminal count, and byte-offset tampering fail grammar", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle);
  const originals = segment.records;
  const mutations = [
    (records) => { records[1].seq = 1; },
    (records) => { records[2].monotonic_ns = "0"; },
    (records) => { records.at(-1).samples = 3; },
    (records) => { records.at(-1).bytes_before_end += 1; },
  ];
  for (const mutate of mutations) {
    const records = structuredClone(originals);
    mutate(records);
    const raw = Buffer.from(records.map(canonicalTelemetryLine).join(""));
    const parsed = parseTelemetryNdjson(raw, { intervalMs: 250 });
    assert.equal(parsed.status, "invalid", parsed.reasons.join("\n"));
    assert.equal(parsed.summary, null);
  }
});

test("changed no_turbo is explicit across segments without pooling workload trials", async () => {
  const bundle = createBundle();
  const first = await recordSegment(bundle, { segment: 1, tag: "turbo-allowed", noTurbo: 0 });
  const second = await recordSegment(bundle, { segment: 2, tag: "turbo-disabled", noTurbo: 1 });
  publish(bundle, [first, second]);
  const assessment = assessTelemetryEvidence(bundle, { phase: PHASE });
  assert.equal(assessment.status, "complete", assessment.reasons.join("\n"));
  assert.deepEqual(assessment.noTurbo.sampledValues, ["0", "1"]);
  assert.deepEqual(assessment.noTurbo.boundaryValues, ["0", "1"]);
  assert.equal(assessment.noTurbo.changed, true);
  assert.equal(assessment.segments.length, 2);
  assert.equal(Object.hasOwn(assessment.noTurbo, "trials"), false);
});

test("unavailable frequency, temperature, and no_turbo remain valid descriptive telemetry", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, {
    tag: "unavailable-sensors",
    noTurbo: "invalid",
    sensors: false,
  });
  publish(bundle, [segment]);
  const assessment = assessTelemetryEvidence(bundle, { phase: PHASE });
  assert.equal(assessment.status, "complete", assessment.reasons.join("\n"));
  assert.equal(assessment.noTurbo.status, "incomplete");
  assert.equal(assessment.noTurbo.unavailableSamples, 2);
  assert.equal(assessment.segments[0].summary.frequencyKHz[0].count, 0);
  assert.equal(assessment.segments[0].summary.frequencyKHz[0].unavailable, 2);
  assert.equal(assessment.segments[0].summary.packageTemperatureMillicelsius[0].mean, null);
});

test("boundary identity and coverage mismatches cannot become complete", async () => {
  const directBundle = createBundle();
  const direct = await recordSegment(directBundle, { tag: "identity" });
  const wrongIdentity = structuredClone(direct.boundaryObject);
  wrongIdentity.tag = "wrong-tag";
  const identity = parseTelemetryBoundary(serializeTelemetryBoundary(wrongIdentity), {
    phase: PHASE,
    generation: GENERATION,
    segment: 1,
    tag: "identity",
  });
  assert.equal(identity.status, "invalid");
  assert.match(identity.reasons.join("\n"), /tag disagrees/);

  const coverageBundle = createBundle();
  const coverage = await recordSegment(coverageBundle, { tag: "late-end" });
  const late = structuredClone(coverage.boundaryObject);
  late.end.monotonicNs = (BigInt(late.end.monotonicNs) + 1n).toString();
  writeFileSync(coverage.boundary, serializeTelemetryBoundary(late));
  const built = publish(coverageBundle, [coverage]);
  assert.equal(built.status, "incomplete");
  assert.match(built.segments[0].coverage.reasons.join("\n"), /after sampler terminal coverage/);
});

test("digest tampering, traversal, unknown files, and a missing parent marker fail closed", async () => {
  const tamperedBundle = createBundle();
  const tamperedSegment = await recordSegment(tamperedBundle);
  publish(tamperedBundle, [tamperedSegment]);
  const original = readFileSync(tamperedSegment.log, "utf8");
  writeFileSync(tamperedSegment.log, original.replace("\"seq\":0", "\"seq\":1"));
  const tampered = assessTelemetryEvidence(tamperedBundle, { phase: PHASE });
  assert.equal(tampered.status, "invalid");
  assert.match(tampered.reasons.join("\n"), /exact index binding/);

  const traversalBundle = createBundle();
  const traversalSegment = await recordSegment(traversalBundle);
  const built = publish(traversalBundle, [traversalSegment]);
  const row = { ...built.rows[0], log: `telemetry/${PHASE}/../${GENERATION}-1.ndjson` };
  const rowsBuffer = serializeTelemetryIndex([row]);
  const binding = telemetryFileBinding(rowsBuffer, 1);
  const meta = {
    ...built.metaValues,
    ROWS_SHA256: binding.sha256,
    ROWS_BYTES: String(binding.bytes),
    ROW_COUNT: "1",
  };
  writeFileSync(path.join(traversalBundle, "results", `telemetry-${PHASE}.tsv`), rowsBuffer);
  writeFileSync(path.join(traversalBundle, "results", `telemetry-${PHASE}.meta`), serializeTelemetryMeta(meta));
  const traversal = assessTelemetryEvidence(traversalBundle, { phase: PHASE });
  assert.equal(traversal.status, "invalid");
  assert.match(traversal.reasons.join("\n"), /traversing path/);

  const unknownBundle = createBundle();
  const unknownSegment = await recordSegment(unknownBundle);
  publish(unknownBundle, [unknownSegment]);
  writeFileSync(path.join(unknownBundle, "telemetry", PHASE, "unexpected"), "x");
  const unknown = assessTelemetryEvidence(unknownBundle, { phase: PHASE });
  assert.equal(unknown.status, "invalid");
  assert.match(unknown.reasons.join("\n"), /unknown file/);

  const unmarkedBundle = createBundle();
  const unmarkedSegment = await recordSegment(unmarkedBundle);
  publish(unmarkedBundle, [unmarkedSegment], { marker: false });
  const unmarked = assessTelemetryEvidence(unmarkedBundle, { phase: PHASE });
  assert.equal(unmarked.status, "incomplete", unmarked.reasons.join("\n"));
  assert.match(unmarked.reasons.join("\n"), /parent baseline phase marker is missing/);
  assert.equal(assessTelemetryEvidence(unmarkedBundle, {
    phase: PHASE, requireParentMarker: false,
  }).status, "complete");
});

test("symlinks, hardlinks, FIFOs, directories, and oversized files are rejected safely", async () => {
  const bundles = [];

  const symbolicBundle = createBundle();
  const symbolic = await recordSegment(symbolicBundle);
  publish(symbolicBundle, [symbolic]);
  unlinkSync(symbolic.log);
  symlinkSync(path.basename(symbolic.boundary), symbolic.log);
  bundles.push(symbolicBundle);

  const hardlinkBundle = createBundle();
  const hardlinked = await recordSegment(hardlinkBundle);
  publish(hardlinkBundle, [hardlinked]);
  linkSync(hardlinked.log, `${hardlinked.log}.link`);
  bundles.push(hardlinkBundle);

  const directoryBundle = createBundle();
  const directorySegment = await recordSegment(directoryBundle);
  publish(directoryBundle, [directorySegment]);
  unlinkSync(directorySegment.boundary);
  mkdirSync(directorySegment.boundary);
  bundles.push(directoryBundle);

  const oversizedBoundaryBundle = createBundle();
  const oversizedBoundary = await recordSegment(oversizedBoundaryBundle);
  publish(oversizedBoundaryBundle, [oversizedBoundary]);
  truncateSync(oversizedBoundary.boundary, TELEMETRY_BOUNDARY_MAX_BYTES + 1);
  bundles.push(oversizedBoundaryBundle);

  // Keep the sparse-log case bounded in test runtime: the validator rejects
  // from lstat size before reading the 1 GiB sparse extent.
  const oversizedLogBundle = createBundle();
  const oversizedLog = await recordSegment(oversizedLogBundle);
  publish(oversizedLogBundle, [oversizedLog]);
  truncateSync(oversizedLog.log, TELEMETRY_LOG_MAX_BYTES + 1);
  bundles.push(oversizedLogBundle);

  const fifoBundle = createBundle();
  const fifo = await recordSegment(fifoBundle);
  publish(fifoBundle, [fifo]);
  unlinkSync(fifo.log);
  try {
    execFileSync("mkfifo", [fifo.log]);
    bundles.push(fifoBundle);
  } catch (error) {
    assert.equal(error?.code, "EPERM");
  }

  for (const bundle of bundles) {
    const assessment = assessTelemetryEvidence(bundle, { phase: PHASE });
    assert.equal(assessment.status, "invalid", `${bundle}: ${assessment.reasons.join("\n")}`);
  }
});

test("metadata and fresh-target grammar are canonical and bounded", async () => {
  const bundle = createBundle();
  assert.deepEqual(validateFreshTelemetryTargets(bundle, {
    phase: PHASE,
    generation: GENERATION,
    intervalMs: 250,
    segments: [{ segment: 1, tag: "fresh" }],
  }), []);
  const segment = await recordSegment(bundle);
  const built = publish(bundle, [segment]);
  assert.ok(built.rowsBuffer.toString().startsWith(`${TELEMETRY_INDEX_HEADER}\n`));
  assert.deepEqual(validateFreshTelemetryTargets(bundle, { phase: PHASE }).some((reason) =>
    reason.includes("already exists") || reason.includes("existing evidence")), true);

  const completeWithReason = Buffer.concat([
    built.metaBuffer,
    Buffer.from("REASON=forbidden\n"),
  ]);
  assert.match(parseTelemetryMeta(completeWithReason).reasons.join("\n"), /canonical|must not contain REASON/);
  const reordered = built.metaBuffer.toString().split("\n").filter(Boolean).toReversed().join("\n") + "\n";
  assert.match(parseTelemetryMeta(reordered).reasons.join("\n"), /canonical/);

  const workloadDigest = "a".repeat(64);
  const boundMeta = serializeTelemetryMeta({
    ...built.metaValues,
    VERSION: "2",
    WORKLOAD_GENERATION: "-",
    WORKLOAD_BINDING_SHA256: workloadDigest,
    WORKLOAD_BOUNDARIES_SHA256: "-",
    WORKLOAD_BOUNDARY_ROW_COUNT: "-",
  });
  const parsedBoundMeta = parseTelemetryMeta(boundMeta);
  assert.equal(parsedBoundMeta.reasons.length, 0);
  assert.equal(parsedBoundMeta.meta.VERSION, "2");
  assert.equal(parsedBoundMeta.meta.WORKLOAD_BINDING_SHA256, workloadDigest);
  assert.throws(() => serializeTelemetryMeta({
    ...parsedBoundMeta.meta,
    WORKLOAD_BOUNDARIES_SHA256: workloadDigest,
  }), /canonical dashes/);
});

test("builder emits V2 only when it binds the exact owning workload", async () => {
  const bundle = createBundle();
  const segment = await recordSegment(bundle, { tag: "bound-baseline" });
  const built = buildTelemetryEnvelope(bundle, {
    phase: PHASE,
    generation: GENERATION,
    intervalMs: 250,
    segments: [{ segment: 1, tag: "bound-baseline" }],
    workloadBinding: {
      phase: PHASE,
      workloadGeneration: "-",
      workloadBindingSha256: "b".repeat(64),
    },
  });
  assert.equal(built.metaValues.VERSION, "2");
  assert.equal(built.metaValues.WORKLOAD_GENERATION, "-");
  assert.equal(built.metaValues.WORKLOAD_BOUNDARIES_SHA256, "-");
  assert.equal(parseTelemetryMeta(built.metaBuffer).reasons.length, 0);
  assert.throws(() => buildTelemetryEnvelope(bundle, {
    phase: PHASE,
    generation: GENERATION,
    intervalMs: 250,
    segments: [{ segment: 1, tag: "bound-baseline" }],
    workloadBinding: {
      phase: PHASE,
      workloadGeneration: GENERATION,
      workloadBindingSha256: "b".repeat(64),
    },
  }), /generation or digest/);
});
