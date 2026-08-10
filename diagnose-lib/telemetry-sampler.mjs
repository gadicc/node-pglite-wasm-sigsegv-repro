#!/usr/bin/env node

// Read-only CPU telemetry discovery, sampling, and recording.
//
// The on-disk format is canonical, newline-delimited JSON. A recorder emits one
// telemetry_metadata record, zero or more telemetry_sample records, and one
// telemetry_end record. Numeric readings are deliberately limited to what the
// kernel attributes actually expose: scaling_cur_freq is a cpufreq point-in-
// time value, not an effective-frequency measurement.

import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TELEMETRY_FORMAT_VERSION = 1;
export const DEFAULT_INTERVAL_MS = 250;
export const MIN_INTERVAL_MS = 50;
export const MAX_INTERVAL_MS = 60_000;
export const MAX_CPU_ID = 65_535;
export const MAX_CPUS = 4_096;
export const MAX_HWMON_DEVICES = 256;
export const MAX_TEMP_CHANNELS = 1_024;
export const MAX_SYSFS_VALUE_BYTES = 4_096;
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_SAMPLES = 2_000_000;
export const MAX_SAMPLES = 10_000_000;
export const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

const DEFAULT_CPU_ROOT = "/sys/devices/system/cpu";
const DEFAULT_HWMON_ROOT = "/sys/class/hwmon";
const DEFAULT_NO_TURBO_PATH =
  "/sys/devices/system/cpu/intel_pstate/no_turbo";
const MAX_PATH_BYTES = 4_096;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_LABEL_BYTES = 256;
const END_RECORD_RESERVE_BYTES = 4_096;
const DISCOVERY_MARKER = Symbol("telemetryDiscovery");

class TelemetryInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetryInputError";
  }
}

class OutputLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputLimitError";
  }
}

function available(extra = {}) {
  return { state: "available", ...extra };
}

function unavailable(reason) {
  return { state: "unavailable", reason };
}

function transient(reason) {
  return { state: "transient", reason };
}

function safeInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TelemetryInputError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseCanonicalPositiveInteger(value, label, max) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TelemetryInputError(`${label} must be a canonical positive integer`);
  }
  return safeInteger(Number(value), label, 1, max);
}

function parseCanonicalNonnegativeInteger(value, label, max) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TelemetryInputError(`${label} must be a canonical non-negative integer`);
  }
  return safeInteger(Number(value), label, 0, max);
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TelemetryInputError(`${label} must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(value) || Buffer.byteLength(value) > MAX_PATH_BYTES) {
    throw new TelemetryInputError(`${label} must be an absolute path within the path-size limit`);
  }
  return path.normalize(value);
}

function compareIntegers(left, right) {
  return left - right;
}

function compareNullableIntegers(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function stateReasonForCode(code) {
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "ELOOP") return "symlink_rejected";
  return "read_error";
}

function readBoundedText(file, maxBytes = MAX_SYSFS_VALUE_BYTES) {
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { ok: false, reason: "not_regular_file" };
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const count = readSync(fd, buffer, offset, maxBytes + 1 - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) return { ok: false, reason: "value_too_large" };
    const value = buffer.subarray(0, offset).toString("utf8").trim();
    if (value.length === 0) return { ok: false, reason: "empty_value" };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: stateReasonForCode(error?.code) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot make a completed, read-only sample more useful.
      }
    }
  }
}

function listDirectory(root, maxEntries, match) {
  let directory;
  const matches = [];
  let count = 0;
  try {
    directory = opendirSync(root);
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      count += 1;
      if (count > maxEntries) {
        return { ok: false, reason: "directory_entry_limit" };
      }
      if (match(entry.name)) matches.push(entry.name);
    }
    return { ok: true, names: matches };
  } catch (error) {
    return { ok: false, reason: stateReasonForCode(error?.code) };
  } finally {
    if (directory !== undefined) {
      try {
        directory.closeSync();
      } catch {
        // Discovery will already be unavailable if directory traversal failed.
      }
    }
  }
}

function parseMetricText(text, min, max) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(text)) {
    return { ok: false, reason: "invalid_value" };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, reason: "out_of_range" };
  }
  return { ok: true, value };
}

function readMetric(file, min, max) {
  const text = readBoundedText(file);
  if (!text.ok) return text;
  return parseMetricText(text.value, min, max);
}

function probeMetric(file, min, max) {
  const result = readMetric(file, min, max);
  return result.ok ? available() : unavailable(result.reason);
}

function sampleMetric(source) {
  const result = readMetric(source.path, source.min, source.max);
  if (result.ok) return result.value;
  return source.availableAtDiscovery
    ? transient(result.reason)
    : unavailable(result.reason);
}

function topologyValue(file) {
  const result = readMetric(file, 0, MAX_CPU_ID);
  return result.ok ? result.value : unavailable(result.reason);
}

function topologyInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function normalizeCpuArray(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0 || cpus.length > MAX_CPUS) {
    throw new TelemetryInputError(`CPU selection must contain 1 to ${MAX_CPUS} CPUs`);
  }
  const normalized = cpus.map((cpu) => safeInteger(cpu, "CPU", 0, MAX_CPU_ID));
  normalized.sort(compareIntegers);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new TelemetryInputError(`duplicate CPU: ${normalized[index]}`);
    }
  }
  return normalized;
}

export function parseCpuList(spec) {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 65_536) {
    throw new TelemetryInputError("CPU list must be a non-empty bounded string");
  }
  const cpus = [];
  for (const token of spec.split(",")) {
    const range = token.match(/^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/);
    if (range) {
      const first = parseCanonicalNonnegativeInteger(range[1], "CPU", MAX_CPU_ID);
      const last = parseCanonicalNonnegativeInteger(range[2], "CPU", MAX_CPU_ID);
      if (last < first) throw new TelemetryInputError(`descending CPU range: ${token}`);
      if (cpus.length + last - first + 1 > MAX_CPUS) {
        throw new TelemetryInputError(`CPU list exceeds ${MAX_CPUS} entries`);
      }
      for (let cpu = first; cpu <= last; cpu += 1) cpus.push(cpu);
      continue;
    }
    cpus.push(parseCanonicalNonnegativeInteger(token, "CPU", MAX_CPU_ID));
    if (cpus.length > MAX_CPUS) {
      throw new TelemetryInputError(`CPU list exceeds ${MAX_CPUS} entries`);
    }
  }
  return normalizeCpuArray(cpus);
}

function discoverCpuIds(cpuRoot) {
  const listed = listDirectory(
    cpuRoot,
    MAX_DIRECTORY_ENTRIES,
    (name) => /^cpu(0|[1-9][0-9]*)$/.test(name),
  );
  if (!listed.ok) return { cpus: [], state: unavailable(listed.reason) };
  const cpus = listed.names.map((name) => Number(name.slice(3)))
    .filter((cpu) => Number.isSafeInteger(cpu) && cpu <= MAX_CPU_ID)
    .sort(compareIntegers);
  if (cpus.length > MAX_CPUS) {
    return { cpus: [], state: unavailable("cpu_limit") };
  }
  if (cpus.length === 0) return { cpus, state: unavailable("not_found") };
  return { cpus, state: available({ count: cpus.length }) };
}

function numericSuffixSort(prefix) {
  return (left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length));
}

function parseTemperatureLabel(label) {
  let match = label.match(/^(?:Package|Physical) id (0|[1-9][0-9]*)$/i);
  if (match) {
    const packageId = Number(match[1]);
    if (packageId <= MAX_CPU_ID) return { kind: "package", package: packageId };
  }
  match = label.match(/^Core (0|[1-9][0-9]*)$/i);
  if (match) {
    const core = Number(match[1]);
    if (core <= MAX_CPU_ID) return { kind: "core", core };
  }
  return { kind: "unmapped" };
}

function coreGroupKey(packageId, die, core) {
  return `${packageId}:${die === null ? "?" : die}:${core}`;
}

function packageCoreKey(packageId, core) {
  return `${packageId}:${core}`;
}

function discoverCoretemp(hwmonRoot, topology) {
  const listed = listDirectory(
    hwmonRoot,
    MAX_HWMON_DEVICES + 1,
    (name) => /^hwmon(0|[1-9][0-9]*)$/.test(name),
  );
  if (!listed.ok) {
    return { sensors: [], state: unavailable(listed.reason), issues: [] };
  }
  const hwmons = listed.names.sort(numericSuffixSort("hwmon"));
  if (hwmons.length > MAX_HWMON_DEVICES) {
    return { sensors: [], state: unavailable("hwmon_limit"), issues: [] };
  }

  const devices = [];
  const issues = [];
  for (const hwmon of hwmons) {
    const dir = path.join(hwmonRoot, hwmon);
    const name = readBoundedText(path.join(dir, "name"), MAX_LABEL_BYTES);
    if (!name.ok) {
      issues.push({ hwmon, attribute: "name", state: unavailable(name.reason) });
      continue;
    }
    if (name.value !== "coretemp") continue;
    const attrs = listDirectory(
      dir,
      MAX_DIRECTORY_ENTRIES,
      (entry) => /^temp[1-9][0-9]*_label$/.test(entry),
    );
    if (!attrs.ok) {
      issues.push({ hwmon, state: unavailable(attrs.reason) });
      continue;
    }
    const labels = attrs.names
      .map((entry) => ({ entry, channel: Number(entry.slice(4, -6)) }))
      .filter(({ channel }) => Number.isSafeInteger(channel) && channel <= MAX_TEMP_CHANNELS)
      .sort((left, right) => left.channel - right.channel);
    if (labels.length > MAX_TEMP_CHANNELS) {
      issues.push({ hwmon, state: unavailable("temperature_channel_limit") });
      continue;
    }
    const channels = [];
    for (const { entry, channel } of labels) {
      const labelResult = readBoundedText(path.join(dir, entry), MAX_LABEL_BYTES);
      if (!labelResult.ok) {
        issues.push({ hwmon, channel, state: unavailable(labelResult.reason) });
        continue;
      }
      channels.push({
        channel,
        label: labelResult.value,
        parsed: parseTemperatureLabel(labelResult.value),
        inputPath: path.join(dir, `temp${channel}_input`),
      });
    }
    devices.push({ hwmon, channels });
  }

  if (devices.length === 0) {
    return {
      sensors: [],
      state: unavailable(issues.length > 0 ? "discovery_error" : "not_found"),
      issues,
    };
  }

  const sensors = [];
  for (let deviceIndex = 0; deviceIndex < devices.length; deviceIndex += 1) {
    const device = devices[deviceIndex];
    const labelledPackages = [...new Set(
      device.channels
        .filter((channel) => channel.parsed.kind === "package")
        .map((channel) => channel.parsed.package),
    )];
    // A Core N label alone does not identify a package. Only associate it
    // when this same coretemp device contains exactly one explicit package
    // label; selected CPU topology is not sufficient evidence for inference.
    const inferredPackage = labelledPackages.length === 1 ? labelledPackages[0] : null;
    for (const channel of device.channels) {
      const packageId = channel.parsed.kind === "package"
        ? channel.parsed.package
        : channel.parsed.kind === "core"
          ? inferredPackage
          : null;
      const input = probeMetric(channel.inputPath, -100_000, 250_000);
      sensors.push({
        id: `ct${deviceIndex}:t${channel.channel}`,
        hwmon: device.hwmon,
        channel: channel.channel,
        label: channel.label,
        kind: channel.parsed.kind,
        package: packageId,
        die: null,
        core: channel.parsed.kind === "core" ? channel.parsed.core : null,
        logical_cpus: [],
        mapping: channel.parsed.kind === "unmapped"
          ? unavailable("unsupported_label")
          : packageId === null
            ? unavailable("package_unresolved")
            : unavailable("no_requested_topology"),
        input,
        source: path.join(device.hwmon, `temp${channel.channel}_input`),
        _source: {
          path: channel.inputPath,
          min: -100_000,
          max: 250_000,
          availableAtDiscovery: input.state === "available",
        },
      });
    }
  }
  return { sensors, state: available({ device_count: devices.length }), issues };
}

function buildTemperatureTargets(topology, sensors) {
  const packages = [...new Set(
    topology.map((entry) => topologyInteger(entry.package)).filter((value) => value !== null),
  )].sort(compareIntegers);
  const packageTargets = packages.map((packageId) => {
    const candidates = sensors.filter(
      (sensor) => sensor.kind === "package" && sensor.package === packageId,
    );
    const sensor = candidates.length === 1
      ? candidates[0].id
      : unavailable(candidates.length === 0 ? "no_sensor" : "ambiguous_sensor");
    if (typeof sensor === "string") {
      const mapped = candidates[0];
      mapped.mapping = available({ target: "package" });
      mapped.logical_cpus = topology
        .filter((entry) => topologyInteger(entry.package) === packageId)
        .map((entry) => entry.cpu);
    } else if (candidates.length > 1) {
      for (const candidate of candidates) {
        candidate.mapping = unavailable("ambiguous_sensor");
      }
    }
    return { package: packageId, sensor };
  });

  const groups = new Map();
  for (const entry of topology) {
    const packageId = topologyInteger(entry.package);
    const die = topologyInteger(entry.die);
    const core = topologyInteger(entry.core);
    if (packageId === null || core === null) continue;
    const key = coreGroupKey(packageId, die, core);
    const group = groups.get(key) ?? {
      package: packageId,
      die,
      die_state: die === null ? entry.die : available(),
      core,
      logical_cpus: [],
    };
    group.logical_cpus.push(entry.cpu);
    groups.set(key, group);
  }
  const coreGroups = [...groups.values()].sort((left, right) =>
    left.package - right.package ||
    compareNullableIntegers(left.die, right.die) ||
    left.core - right.core);
  const groupCounts = new Map();
  for (const group of coreGroups) {
    const key = packageCoreKey(group.package, group.core);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const coreTargets = coreGroups.map((group) => {
    const key = packageCoreKey(group.package, group.core);
    const candidates = sensors.filter((sensor) =>
      sensor.kind === "core" &&
      sensor.package === group.package &&
      sensor.core === group.core);
    let sensor;
    if (groupCounts.get(key) !== 1) {
      sensor = unavailable("ambiguous_topology");
      for (const candidate of candidates) {
        candidate.mapping = unavailable("ambiguous_topology");
      }
    }
    else if (candidates.length === 0) sensor = unavailable("no_sensor");
    else if (candidates.length > 1) {
      sensor = unavailable("ambiguous_sensor");
      for (const candidate of candidates) {
        candidate.mapping = unavailable("ambiguous_sensor");
      }
    }
    else {
      sensor = candidates[0].id;
      const mapped = candidates[0];
      mapped.mapping = available({ target: "core" });
      mapped.die = group.die;
      mapped.logical_cpus = [...group.logical_cpus];
    }
    return { ...group, sensor };
  });
  return { packages: packageTargets, cores: coreTargets };
}

function metadataSensor(sensor) {
  const {
    _source,
    ...metadata
  } = sensor;
  return metadata;
}

/**
 * Discover logical-CPU topology and coretemp mappings without changing any
 * system setting. The returned object can be reused for repeated samples.
 */
export function discoverTelemetry(options = {}) {
  const cpuRoot = validateAbsolutePath(options.cpuRoot ?? DEFAULT_CPU_ROOT, "CPU root");
  const hwmonRoot = validateAbsolutePath(options.hwmonRoot ?? DEFAULT_HWMON_ROOT, "hwmon root");
  const noTurboPath = validateAbsolutePath(
    options.noTurboPath ?? DEFAULT_NO_TURBO_PATH,
    "no_turbo path",
  );
  const selected = options.cpus === undefined
    ? discoverCpuIds(cpuRoot)
    : { cpus: normalizeCpuArray(options.cpus), state: available({ count: options.cpus.length }) };

  const topology = selected.cpus.map((cpu) => {
    const cpuDir = path.join(cpuRoot, `cpu${cpu}`);
    const frequencyPath = path.join(cpuDir, "cpufreq", "scaling_cur_freq");
    const frequency = probeMetric(frequencyPath, 0, 100_000_000);
    return {
      cpu,
      package: topologyValue(path.join(cpuDir, "topology", "physical_package_id")),
      die: topologyValue(path.join(cpuDir, "topology", "die_id")),
      core: topologyValue(path.join(cpuDir, "topology", "core_id")),
      scaling_cur_freq: frequency,
      _frequencySource: {
        path: frequencyPath,
        min: 0,
        max: 100_000_000,
        availableAtDiscovery: frequency.state === "available",
      },
    };
  });
  const coretemp = discoverCoretemp(hwmonRoot, topology);
  const targets = buildTemperatureTargets(topology, coretemp.sensors);
  const noTurboAvailability = probeMetric(noTurboPath, 0, 1);

  const metadata = {
    cpu_discovery: selected.state,
    cpus: topology.map(({ _frequencySource, ...entry }) => entry),
    coretemp: coretemp.state,
    coretemp_issues: coretemp.issues,
    temperature_sensors: coretemp.sensors.map(metadataSensor),
    temperature_targets: targets,
    no_turbo: noTurboAvailability,
  };
  const discovery = {
    metadata,
    sources: {
      frequencies: topology.map((entry) => ({
        cpu: entry.cpu,
        ...entry._frequencySource,
      })),
      temperatures: coretemp.sensors.map((sensor) => ({
        id: sensor.id,
        ...sensor._source,
      })),
      noTurbo: {
        path: noTurboPath,
        min: 0,
        max: 1,
        availableAtDiscovery: noTurboAvailability.state === "available",
      },
      packageTargets: targets.packages,
      coreTargets: targets.cores,
    },
    roots: { cpu: cpuRoot, hwmon: hwmonRoot, no_turbo: noTurboPath },
  };
  Object.defineProperty(discovery, DISCOVERY_MARKER, { value: true });
  return discovery;
}

function validateClock(clock) {
  if (clock === undefined) {
    return { unixMs: Date.now, monotonicNs: process.hrtime.bigint };
  }
  if (typeof clock?.unixMs !== "function" || typeof clock?.monotonicNs !== "function") {
    throw new TelemetryInputError("clock must provide unixMs() and monotonicNs()");
  }
  return clock;
}

function readTimestamp(clock, startMonotonicNs) {
  const monotonic = clock.monotonicNs();
  const unixMs = clock.unixMs();
  if (typeof monotonic !== "bigint" || monotonic < startMonotonicNs) {
    throw new Error("monotonic clock returned an invalid or regressing value");
  }
  if (!Number.isSafeInteger(unixMs) || unixMs < 0) {
    throw new Error("absolute clock returned an invalid value");
  }
  return {
    unix_ms: unixMs,
    monotonic_ns: (monotonic - startMonotonicNs).toString(),
    _monotonic: monotonic,
  };
}

/** Capture a boundary timestamp in the same clock domains used by samples. */
export function captureTelemetryTimestamp(options = {}) {
  const clock = validateClock(options.clock);
  const start = options.startMonotonicNs ?? 0n;
  if (typeof start !== "bigint" || start < 0n) {
    throw new TelemetryInputError("startMonotonicNs must be a non-negative bigint");
  }
  const { _monotonic, ...timestamp } = readTimestamp(clock, start);
  return timestamp;
}

/** Take one compact, canonical-shape snapshot from a prior discovery. */
export function sampleTelemetry(discovery, options = {}) {
  if (discovery?.[DISCOVERY_MARKER] !== true) {
    throw new TelemetryInputError("sampleTelemetry requires discoverTelemetry output");
  }
  const seq = safeInteger(options.seq ?? 0, "sample sequence", 0, MAX_SAMPLES);
  const clock = validateClock(options.clock);
  const startMonotonicNs = options.startMonotonicNs ?? clock.monotonicNs();
  if (typeof startMonotonicNs !== "bigint" || startMonotonicNs < 0n) {
    throw new TelemetryInputError("startMonotonicNs must be a non-negative bigint");
  }
  const started = readTimestamp(clock, startMonotonicNs);
  const frequencies = discovery.sources.frequencies.map((source) => [
    source.cpu,
    sampleMetric(source),
  ]);
  const temperatureValues = new Map(discovery.sources.temperatures.map((source) => [
    source.id,
    sampleMetric(source),
  ]));
  const packageTemperatures = discovery.sources.packageTargets.map((target) => [
    target.package,
    typeof target.sensor === "string"
      ? temperatureValues.get(target.sensor)
      : target.sensor,
  ]);
  const coreTemperatures = discovery.sources.coreTargets.map((target) => [
    target.package,
    target.die,
    target.core,
    typeof target.sensor === "string"
      ? temperatureValues.get(target.sensor)
      : target.sensor,
  ]);
  const usedSensors = new Set([
    ...discovery.sources.packageTargets.map((target) => target.sensor),
    ...discovery.sources.coreTargets.map((target) => target.sensor),
  ].filter((sensor) => typeof sensor === "string"));
  const unmappedTemperatures = discovery.sources.temperatures
    .filter((source) => !usedSensors.has(source.id))
    .map((source) => [source.id, temperatureValues.get(source.id)]);
  // Keep every sysfs observation, including no_turbo, inside the interval
  // described by read_duration_ns.  Coverage validation uses that duration to
  // determine when the first complete sample was available before a workload
  // boundary, so taking no_turbo after `ended` would understate the read.
  const noTurbo = sampleMetric(discovery.sources.noTurbo);
  const ended = clock.monotonicNs();
  if (typeof ended !== "bigint" || ended < started._monotonic) {
    throw new Error("monotonic clock regressed while taking a sample");
  }
  return {
    type: "telemetry_sample",
    seq,
    unix_ms: started.unix_ms,
    monotonic_ns: started.monotonic_ns,
    read_duration_ns: (ended - started._monotonic).toString(),
    scaling_cur_freq_khz: frequencies,
    package_temperature_millicelsius: packageTemperatures,
    core_temperature_millicelsius: coreTemperatures,
    unmapped_temperature_millicelsius: unmappedTemperatures,
    no_turbo: noTurbo,
  };
}

function canonicalize(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (depth > 32) throw new TelemetryInputError("record nesting exceeds the canonicalization limit");
  budget.nodes += 1;
  if (budget.nodes > 1_000_000) {
    throw new OutputLimitError("telemetry record exceeds the traversal limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > MAX_RECORD_BYTES) {
      throw new OutputLimitError(`telemetry record exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TelemetryInputError("record contains a non-finite number");
    budget.bytes += 16;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000_000) {
      throw new OutputLimitError("telemetry record exceeds the array-entry limit");
    }
    return value.map((entry) => canonicalize(entry, depth + 1, budget));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      budget.bytes += Buffer.byteLength(key);
      if (budget.bytes > MAX_RECORD_BYTES) {
        throw new OutputLimitError(`telemetry record exceeds ${MAX_RECORD_BYTES} bytes`);
      }
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new TelemetryInputError("record contains a non-JSON value");
      }
      result[key] = canonicalize(entry, depth + 1, budget);
    }
    return result;
  }
  throw new TelemetryInputError("record contains a non-canonical value");
}

export function canonicalTelemetryLine(record) {
  const line = `${JSON.stringify(canonicalize(record))}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_RECORD_BYTES) {
    throw new OutputLimitError(`telemetry record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return line;
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

class BoundedWriter {
  constructor(stream, maxBytes, ownsStream) {
    this.stream = stream;
    this.maxBytes = maxBytes;
    this.ownsStream = ownsStream;
    this.bytes = 0;
    this.streamError = null;
    this.onError = (error) => { this.streamError = error; };
    stream.on("error", this.onError);
  }

  async write(record, terminal = false) {
    if (this.streamError) throw this.streamError;
    const line = canonicalTelemetryLine(record);
    const bytes = Buffer.byteLength(line);
    const limit = terminal ? this.maxBytes : this.maxBytes - END_RECORD_RESERVE_BYTES;
    if (this.bytes + bytes > limit) {
      throw new OutputLimitError("telemetry output byte limit reached");
    }
    if (!this.stream.write(line, "utf8")) await waitForDrain(this.stream);
    if (this.streamError) throw this.streamError;
    this.bytes += bytes;
  }

  async close() {
    if (!this.ownsStream) {
      this.stream.off("error", this.onError);
      return;
    }
    if (!this.stream.writableEnded) {
      const completed = Promise.race([
        once(this.stream, "finish"),
        once(this.stream, "error").then(([error]) => Promise.reject(error)),
      ]);
      this.stream.end();
      await completed;
    }
    this.stream.off("error", this.onError);
    if (this.streamError) throw this.streamError;
  }
}

function openExclusiveOutput(outputPath) {
  const validated = validateAbsolutePath(outputPath, "output path");
  const fd = openSync(
    validated,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  return createWriteStream(validated, { fd, autoClose: true });
}

function validateWritable(output) {
  if (output === null || typeof output?.write !== "function" || typeof output?.on !== "function") {
    throw new TelemetryInputError("output must be a Node writable stream");
  }
  return output;
}

function delay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function recorderMetadata(discovery, intervalMs, started) {
  return {
    type: "telemetry_metadata",
    version: TELEMETRY_FORMAT_VERSION,
    started_unix_ms: started.unix_ms,
    monotonic_origin: "recorder_start",
    // Linux CLOCK_MONOTONIC (used by process.hrtime.bigint()) is shared
    // across processes. Persisting the absolute origin lets a separately
    // supervised workload boundary be joined to these relative sample times
    // without pretending wall-clock timestamps are monotonic.
    monotonic_origin_ns: started.monotonic_origin_ns,
    interval_ms: intervalMs,
    roots: discovery.roots,
    method: {
      absolute_clock: "Date.now milliseconds since Unix epoch at poll start",
      monotonic_clock: "process.hrtime.bigint nanoseconds since recorder start",
      scaling_cur_freq: {
        source: "per-logical-CPU cpufreq/scaling_cur_freq",
        unit: "kHz",
        note: "scaling_cur_freq is a kernel cpufreq point-in-time value; it is not effective frequency or a measurement of cycles delivered during the interval",
      },
      temperature: {
        source: "dynamically discovered coretemp hwmon name and temp*_label attributes",
        unit: "millidegrees Celsius",
      },
      no_turbo: {
        source: "intel_pstate/no_turbo",
        values: "0 means turbo allowed; 1 means turbo disabled",
      },
    },
    discovery: discovery.metadata,
  };
}

function validateStopReason(reason) {
  if (typeof reason !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(reason)) {
    throw new TelemetryInputError("stop reason must be a bounded canonical token");
  }
  return reason;
}

/**
 * Create a recorder suitable for Node callers that need start/stop control
 * around a workload. `start()` completes after the metadata and first sample
 * have been written. `stop()` never changes a sysfs value.
 */
export function createTelemetryRecorder(options = {}) {
  const intervalMs = safeInteger(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    "intervalMs",
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
  );
  const maxSamples = safeInteger(
    options.maxSamples ?? DEFAULT_MAX_SAMPLES,
    "maxSamples",
    1,
    MAX_SAMPLES,
  );
  const maxOutputBytes = safeInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
    64 * 1024,
    MAX_OUTPUT_BYTES,
  );
  const durationMs = options.durationMs === undefined
    ? null
    : safeInteger(options.durationMs, "durationMs", 1, MAX_DURATION_MS);
  const clock = validateClock(options.clock);
  const discovery = options.discovery ?? discoverTelemetry(options);
  if (discovery?.[DISCOVERY_MARKER] !== true) {
    throw new TelemetryInputError("discovery must be discoverTelemetry output");
  }
  if (options.output !== undefined && options.outputPath !== undefined) {
    throw new TelemetryInputError("choose output or outputPath, not both");
  }
  if (options.output === undefined && options.outputPath === undefined) {
    throw new TelemetryInputError("output or outputPath is required");
  }
  if (options.outputPath !== undefined) {
    validateAbsolutePath(options.outputPath, "output path");
  } else {
    validateWritable(options.output);
  }
  if (options.signal !== undefined &&
    (typeof options.signal?.addEventListener !== "function" ||
      typeof options.signal?.removeEventListener !== "function")) {
    throw new TelemetryInputError("signal must be an AbortSignal");
  }

  let state = "idle";
  let stopReason = null;
  let startMonotonicNs = null;
  let startedUnixMs = null;
  let samples = 0;
  let writer = null;
  let finishPromise = null;
  const internalAbort = new AbortController();

  const requestStop = (reason = "requested") => {
    const normalized = validateStopReason(reason);
    if (stopReason === null) stopReason = normalized;
    internalAbort.abort();
  };
  const onExternalAbort = () => requestStop("aborted");

  async function finishRecording() {
    let reason = stopReason;
    try {
      let nextDue = startMonotonicNs + BigInt(intervalMs) * 1_000_000n;
      const deadline = durationMs === null
        ? null
        : startMonotonicNs + BigInt(durationMs) * 1_000_000n;
      while (reason === null && samples < maxSamples) {
        const now = clock.monotonicNs();
        if (typeof now !== "bigint" || now < startMonotonicNs) {
          throw new Error("monotonic clock returned an invalid or regressing value");
        }
        if (deadline !== null && now >= deadline) {
          reason = "duration";
          break;
        }
        const wakeAt = deadline !== null && deadline < nextDue ? deadline : nextDue;
        const remainingNs = wakeAt - now;
        const waitMs = remainingNs <= 0n ? 0 : Number((remainingNs + 999_999n) / 1_000_000n);
        const elapsed = await delay(waitMs, internalAbort.signal);
        if (!elapsed) {
          reason = stopReason ?? "aborted";
          break;
        }
        const afterWait = clock.monotonicNs();
        if (deadline !== null && afterWait >= deadline) {
          reason = "duration";
          break;
        }
        try {
          const snapshot = sampleTelemetry(discovery, {
            seq: samples,
            clock,
            startMonotonicNs,
          });
          await writer.write(snapshot);
          samples += 1;
        } catch (error) {
          if (error instanceof OutputLimitError) {
            reason = "output_limit";
            break;
          }
          throw error;
        }
        const sampledAt = clock.monotonicNs();
        nextDue += BigInt(intervalMs) * 1_000_000n;
        if (nextDue <= sampledAt) nextDue = sampledAt + BigInt(intervalMs) * 1_000_000n;
      }
      if (reason === null) reason = samples >= maxSamples ? "sample_limit" : "requested";
      const ended = readTimestamp(clock, startMonotonicNs);
      await writer.write({
        type: "telemetry_end",
        reason,
        samples,
        unix_ms: ended.unix_ms,
        monotonic_ns: ended.monotonic_ns,
        bytes_before_end: writer.bytes,
      }, true);
      await writer.close();
      state = "stopped";
      return {
        reason,
        samples,
        bytes: writer.bytes,
        startedUnixMs,
        endedUnixMs: ended.unix_ms,
      };
    } catch (error) {
      state = "failed";
      try {
        await writer?.close();
      } catch {
        // Preserve the primary sampling/output failure.
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async function start() {
    if (state !== "idle") throw new Error(`recorder cannot start from state ${state}`);
    state = "starting";
    const output = options.outputPath !== undefined
      ? openExclusiveOutput(options.outputPath)
      : options.output;
    writer = new BoundedWriter(output, maxOutputBytes, options.outputPath !== undefined);
    startMonotonicNs = clock.monotonicNs();
    startedUnixMs = clock.unixMs();
    if (typeof startMonotonicNs !== "bigint" || startMonotonicNs < 0n ||
      !Number.isSafeInteger(startedUnixMs) || startedUnixMs < 0) {
      state = "failed";
      await writer.close();
      throw new Error("clock returned an invalid recorder start time");
    }
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) requestStop("aborted");
    const startTimestamp = {
      unix_ms: startedUnixMs,
      monotonic_ns: "0",
      monotonic_origin_ns: startMonotonicNs.toString(),
    };
    try {
      await writer.write(recorderMetadata(discovery, intervalMs, startTimestamp));
      if (stopReason === null && samples < maxSamples) {
        try {
          await writer.write(sampleTelemetry(discovery, {
            seq: samples,
            clock,
            startMonotonicNs,
          }));
          samples += 1;
        } catch (error) {
          if (error instanceof OutputLimitError) stopReason = "output_limit";
          else throw error;
        }
      }
      state = "running";
      finishPromise = finishRecording();
      // Avoid an unhandled-rejection warning if a caller is briefly busy with
      // its workload before awaiting recorder.done.
      finishPromise.catch(() => {});
      return recorderMetadata(discovery, intervalMs, startTimestamp);
    } catch (error) {
      state = "failed";
      options.signal?.removeEventListener("abort", onExternalAbort);
      try {
        await writer.close();
      } catch {
        // Preserve the primary startup failure.
      }
      throw error;
    }
  }

  async function stop(reason = "requested") {
    requestStop(reason);
    if (finishPromise !== null) return finishPromise;
    if (state === "idle") return null;
    while (finishPromise === null && state !== "failed") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return finishPromise;
  }

  function timestamp() {
    if (startMonotonicNs === null) {
      throw new Error("recorder has not started");
    }
    return captureTelemetryTimestamp({ clock, startMonotonicNs });
  }

  return {
    discovery,
    start,
    stop,
    timestamp,
    get done() { return finishPromise; },
    get state() { return state; },
    get startMonotonicNs() { return startMonotonicNs; },
  };
}

export async function recordTelemetry(options = {}) {
  const recorder = createTelemetryRecorder(options);
  await recorder.start();
  return recorder.done;
}

function usage() {
  return `usage: node telemetry-sampler.mjs [options]

Read-only canonical NDJSON CPU telemetry recorder.

  --output FILE             create FILE exclusively (default: stdout)
  --cpus LIST               logical CPUs, e.g. 0-3,8 (default: discovered)
  --interval-ms N           sampling interval (${DEFAULT_INTERVAL_MS} default)
  --duration-ms N           stop after this monotonic duration
  --max-samples N           hard sample-count bound
  --max-output-bytes N      hard serialized-output bound
  --once                    emit one sample and stop
  --cpu-root DIR            alternate CPU sysfs root (fixtures/testing)
  --hwmon-root DIR          alternate hwmon root (fixtures/testing)
  --no-turbo-path FILE      alternate read-only no_turbo attribute
  --help                    show this help

This program only reads attributes. It never changes no_turbo or any other
sysfs setting. scaling_cur_freq is not an effective-frequency measurement.`;
}

function parseCliArgs(argv) {
  const options = {};
  let help = false;
  let onceOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") help = true;
    else if (arg === "--once") onceOnly = true;
    else if ([
      "--output",
      "--cpus",
      "--interval-ms",
      "--duration-ms",
      "--max-samples",
      "--max-output-bytes",
      "--cpu-root",
      "--hwmon-root",
      "--no-turbo-path",
    ].includes(arg)) {
      if (index + 1 >= argv.length) throw new TelemetryInputError(`${arg} requires a value`);
      const value = argv[++index];
      if (arg === "--output") options.outputPath = path.resolve(value);
      else if (arg === "--cpus") options.cpus = parseCpuList(value);
      else if (arg === "--interval-ms") {
        options.intervalMs = parseCanonicalPositiveInteger(value, arg, MAX_INTERVAL_MS);
      } else if (arg === "--duration-ms") {
        options.durationMs = parseCanonicalPositiveInteger(value, arg, MAX_DURATION_MS);
      } else if (arg === "--max-samples") {
        options.maxSamples = parseCanonicalPositiveInteger(value, arg, MAX_SAMPLES);
      } else if (arg === "--max-output-bytes") {
        options.maxOutputBytes = parseCanonicalPositiveInteger(value, arg, MAX_OUTPUT_BYTES);
      } else if (arg === "--cpu-root") options.cpuRoot = value;
      else if (arg === "--hwmon-root") options.hwmonRoot = value;
      else options.noTurboPath = value;
    } else {
      throw new TelemetryInputError(`unknown argument: ${arg}`);
    }
  }
  if (help && argv.length !== 1) throw new TelemetryInputError("--help cannot be combined with options");
  if (onceOnly && options.durationMs !== undefined) {
    throw new TelemetryInputError("--once cannot be combined with --duration-ms");
  }
  if (onceOnly && options.maxSamples !== undefined) {
    throw new TelemetryInputError("--once cannot be combined with --max-samples");
  }
  if (onceOnly) options.maxSamples = 1;
  return { help, options };
}

export async function runTelemetryCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const signalSource = io.signalSource ?? process;
  let recorder;
  const handlers = new Map();
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.options.outputPath === undefined) parsed.options.output = stdout;
    recorder = createTelemetryRecorder(parsed.options);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        recorder.stop(`signal_${signal.toLowerCase()}`).catch(() => {});
      };
      handlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
    await recorder.start();
    const result = await recorder.done;
    if (result.reason === "output_limit") {
      stderr.write("error: telemetry output limit reached\n");
      return 1;
    }
    return 0;
  } catch (error) {
    stderr.write(`error: ${error?.message ?? String(error)}\n`);
    return error instanceof TelemetryInputError ? 2 : 1;
  } finally {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  }
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const code = await runTelemetryCli(process.argv.slice(2));
  process.exitCode = code;
}
