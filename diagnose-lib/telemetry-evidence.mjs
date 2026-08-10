// Strict evidence envelope for read-only CPU telemetry.
//
// Telemetry is deliberately independent of workload authority. This module
// validates and describes sampler/boundary evidence, but it never promotes or
// demotes the owning workload phase. Complete sampler-relative clocks are
// joined to absolute workload boundaries only through monotonic_origin_ns.

import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import { readStableRegularFile } from "./individual-evidence.mjs";
import {
  MAX_CPUS,
  MAX_INTERVAL_MS,
  MAX_RECORD_BYTES,
  MAX_SAMPLES,
  MAX_TEMP_CHANNELS,
  MIN_INTERVAL_MS,
  canonicalTelemetryLine,
} from "./telemetry-sampler.mjs";

export const TELEMETRY_EVIDENCE_VERSION = 2;
export const TELEMETRY_PHASES = Object.freeze([
  "baseline",
  "groups",
  "individual",
  "pinned-concurrent",
  "gdb",
]);
export const TELEMETRY_INDEX_HEADER =
  "segment\ttag\tlog\tboundary\tlog_sha256\tlog_bytes\tboundary_sha256\tboundary_bytes\tsamples\tstatus";
export const TELEMETRY_META_MAX_BYTES = 256 * 1024;
export const TELEMETRY_INDEX_MAX_BYTES = 64 * 1024 * 1024;
export const TELEMETRY_LOG_MAX_BYTES = 1024 * 1024 * 1024;
export const TELEMETRY_BOUNDARY_MAX_BYTES = 64 * 1024;
export const TELEMETRY_MAX_SEGMENTS = 100_000;

const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const REASON_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SENSOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PRODUCTION_TELEMETRY_ROOTS = Object.freeze({
  cpu: "/sys/devices/system/cpu",
  hwmon: "/sys/class/hwmon",
  no_turbo: "/sys/devices/system/cpu/intel_pstate/no_turbo",
});
// The recorder deliberately skips missed deadlines instead of trying to catch
// up.  Four requested intervals is a conservative evidence threshold: it
// tolerates ordinary scheduler and sysfs-read jitter, while ensuring a long
// observation hole cannot masquerade as nominal 250 ms telemetry.
export const TELEMETRY_MAX_CADENCE_INTERVALS = 4;
const META_KEYS_V1 = [
  "VERSION",
  "GENERATION",
  "PHASE",
  "INTERVAL_MS",
  "EXPECTED_SEGMENTS",
  "STATUS",
  "ROWS_SHA256",
  "ROWS_BYTES",
  "ROW_COUNT",
];
const META_KEYS_V2 = [
  "VERSION",
  "GENERATION",
  "PHASE",
  "INTERVAL_MS",
  "EXPECTED_SEGMENTS",
  "WORKLOAD_GENERATION",
  "WORKLOAD_BINDING_SHA256",
  "WORKLOAD_BOUNDARIES_SHA256",
  "WORKLOAD_BOUNDARY_ROW_COUNT",
  "STATUS",
  "ROWS_SHA256",
  "ROWS_BYTES",
  "ROW_COUNT",
];
const META_KEYS_V1_WITH_REASON = [...META_KEYS_V1, "REASON"];
const META_KEYS_V2_WITH_REASON = [...META_KEYS_V2, "REASON"];
const KNOWN_META_KEYS = new Set([...META_KEYS_V2_WITH_REASON]);
const BOUNDARY_KEYS = ["version", "phase", "tag", "generation", "segment", "start", "end"];
const BOUNDARY_POINT_KEYS = ["unixMs", "monotonicNs", "noTurbo"];
const METADATA_KEYS = [
  "type",
  "version",
  "started_unix_ms",
  "monotonic_origin",
  "monotonic_origin_ns",
  "interval_ms",
  "roots",
  "method",
  "discovery",
];
const SAMPLE_KEYS = [
  "type",
  "seq",
  "unix_ms",
  "monotonic_ns",
  "read_duration_ns",
  "scaling_cur_freq_khz",
  "package_temperature_millicelsius",
  "core_temperature_millicelsius",
  "unmapped_temperature_millicelsius",
  "no_turbo",
];
const END_KEYS = ["type", "reason", "samples", "unix_ms", "monotonic_ns", "bytes_before_end"];

const EXPECTED_METHOD = Object.freeze({
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
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalUint(value, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || text.length > 16 || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function canonicalPositiveUint(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = canonicalUint(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function canonicalDecimal(value, maximumDigits = 30) {
  if (typeof value !== "string" || value.length > maximumDigits || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function exactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError("evidence content must be a string, Buffer, or Uint8Array");
}

function decodeUtf8(value, label, reasons) {
  try {
    return UTF8_DECODER.decode(exactBytes(value));
  } catch {
    reasons.push(`${label} is not canonical UTF-8 text`);
    return "";
  }
}

export function sha256TelemetryBytes(value) {
  return createHash("sha256").update(exactBytes(value)).digest("hex");
}

export function telemetryFileBinding(value, rowCount = undefined) {
  const bytes = exactBytes(value);
  const binding = { sha256: sha256TelemetryBytes(bytes), bytes: bytes.length };
  if (rowCount !== undefined) {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new TypeError("rowCount must be a non-negative safe integer");
    binding.rowCount = rowCount;
  }
  return binding;
}

function validatePhase(phase) {
  return typeof phase === "string" && TELEMETRY_PHASES.includes(phase);
}

function validateAbsoluteCanonicalPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0") && path.isAbsolute(value) && path.normalize(value) === value;
}

function canonicalRecord(value) {
  return canonicalTelemetryLine(value);
}

function canonicalObjectEqual(left, right) {
  try {
    return canonicalRecord(left) === canonicalRecord(right);
  } catch {
    return false;
  }
}

function exactInteger(value, maximum = 65_535) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function exactPositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = exactInteger(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function strictlyIncreasingIntegers(value, maximum = 65_535, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_CPUS) return false;
  return value.every((entry, index) => exactInteger(entry, maximum) !== null &&
    (index === 0 || entry > value[index - 1]));
}

function unavailableState(reason) {
  return { state: "unavailable", reason };
}

function availableState(extra = {}) {
  return { state: "available", ...extra };
}

function topologyInteger(value) {
  return exactInteger(value);
}

function compareNullableIntegers(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function coreTopologyKey(packageId, die, core) {
  return `${packageId}:${die === null ? "null" : die}:${core}`;
}

function packageCoreKey(packageId, core) {
  return `${packageId}:${core}`;
}

function validateState(value, allowedStates, extras = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.state !== "string" || !allowedStates.includes(value.state)) return false;
  if (value.state === "unavailable" || value.state === "transient" || value.state === "invalid") {
    return hasExactKeys(value, ["state", "reason"]) && REASON_RE.test(value.reason ?? "");
  }
  const allowedExtra = extras[value.state] ?? [];
  if (!hasExactKeys(value, ["state", ...allowedExtra])) return false;
  return allowedExtra.every((key) => {
    if (key === "count" || key === "device_count") return canonicalUint(value[key], 1_000_000) !== null;
    if (key === "target") return value[key] === "package" || value[key] === "core";
    return false;
  });
}

function validateMetric(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ||
    validateState(value, ["unavailable", "transient"]);
}

function validateBoundaryNoTurbo(value) {
  return value === 0 || value === 1 || validateState(value, ["unavailable", "invalid"]);
}

function validateSampleNoTurbo(value) {
  return value === 0 || value === 1 || validateState(value, ["unavailable", "transient"]);
}

function boundedJsonValue(value, budget = { nodes: 0, strings: 0 }, depth = 0) {
  if (depth > 24) return false;
  budget.nodes += 1;
  if (budget.nodes > 200_000) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    budget.strings += Buffer.byteLength(value);
    return budget.strings <= MAX_RECORD_BYTES && !value.includes("\0");
  }
  if (Array.isArray(value)) {
    return value.length <= 100_000 && value.every((entry) => boundedJsonValue(entry, budget, depth + 1));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    return keys.length <= 256 && keys.every((key) => key.length <= 128 &&
      boundedJsonValue(value[key], budget, depth + 1));
  }
  return false;
}

function validateDiscovery(discovery, reasons) {
  const keys = [
    "cpu_discovery", "cpus", "coretemp", "coretemp_issues", "temperature_sensors",
    "temperature_targets", "no_turbo",
  ];
  if (!hasExactKeys(discovery, keys)) {
    reasons.push("telemetry metadata discovery has a noncanonical shape");
    return null;
  }
  if (!boundedJsonValue(discovery)) reasons.push("telemetry metadata discovery exceeds structural bounds");
  if (!validateState(discovery.cpu_discovery, ["available", "unavailable"], { available: ["count"] })) {
    reasons.push("telemetry metadata CPU discovery state is invalid");
  }
  if (!validateState(discovery.coretemp, ["available", "unavailable"], { available: ["device_count"] })) {
    reasons.push("telemetry metadata coretemp state is invalid");
  }
  if (!validateState(discovery.no_turbo, ["available", "unavailable"])) {
    reasons.push("telemetry metadata no_turbo discovery state is invalid");
  }
  if (!Array.isArray(discovery.cpus) || discovery.cpus.length > MAX_CPUS) {
    reasons.push("telemetry metadata CPUs are missing or exceed bounds");
    return null;
  }
  const cpuEntries = [];
  const cpus = [];
  for (let index = 0; index < discovery.cpus.length; index += 1) {
    const cpu = discovery.cpus[index];
    const cpuKeys = ["cpu", "package", "die", "core", "scaling_cur_freq"];
    if (!hasExactKeys(cpu, cpuKeys) || exactInteger(cpu.cpu) === null ||
        ![cpu.package, cpu.die, cpu.core].every((entry) => exactInteger(entry) !== null ||
          validateState(entry, ["unavailable"])) ||
        !validateState(cpu.scaling_cur_freq, ["available", "unavailable"])) {
      reasons.push(`telemetry metadata CPU entry ${index + 1} is invalid`);
      continue;
    }
    if (cpus.length > 0 && cpu.cpu <= cpus.at(-1)) reasons.push("telemetry metadata CPUs are not strictly increasing");
    cpus.push(cpu.cpu);
    cpuEntries.push(cpu);
  }
  if (discovery.cpu_discovery.state === "available") {
    if (exactPositiveInteger(discovery.cpu_discovery.count, MAX_CPUS) === null ||
        discovery.cpu_discovery.count !== cpus.length) {
      reasons.push("telemetry metadata CPU discovery count does not reconcile");
    }
  } else if (discovery.cpu_discovery.state === "unavailable" && cpus.length !== 0) {
    reasons.push("unavailable telemetry CPU discovery must not claim discovered CPUs");
  }
  if (!Array.isArray(discovery.coretemp_issues) || discovery.coretemp_issues.length > MAX_TEMP_CHANNELS ||
      !boundedJsonValue(discovery.coretemp_issues)) {
    reasons.push("telemetry metadata coretemp issues exceed bounds");
  }
  const cpuSet = new Set(cpus);
  const sensors = [];
  const sensorIds = new Set();
  const sensorSources = new Set();
  if (!Array.isArray(discovery.temperature_sensors) || discovery.temperature_sensors.length > MAX_TEMP_CHANNELS) {
    reasons.push("telemetry metadata temperature sensors exceed bounds");
  } else {
    for (let index = 0; index < discovery.temperature_sensors.length; index += 1) {
      const sensor = discovery.temperature_sensors[index];
      const sensorKeys = [
        "id", "hwmon", "channel", "label", "kind", "package", "die", "core",
        "logical_cpus", "mapping", "input", "source",
      ];
      const structural = hasExactKeys(sensor, sensorKeys) && SENSOR_ID_RE.test(sensor.id ?? "") &&
        /^hwmon(0|[1-9][0-9]*)$/.test(sensor.hwmon ?? "") &&
        exactPositiveInteger(sensor.channel, MAX_TEMP_CHANNELS) !== null &&
        typeof sensor.label === "string" && Buffer.byteLength(sensor.label) <= 256 &&
        ["package", "core", "unmapped"].includes(sensor.kind) &&
        [sensor.package, sensor.die, sensor.core].every((entry) => entry === null || exactInteger(entry) !== null) &&
        strictlyIncreasingIntegers(sensor.logical_cpus) &&
        sensor.logical_cpus.every((cpu) => cpuSet.has(cpu)) &&
        validateState(sensor.mapping, ["available", "unavailable"], { available: ["target"] }) &&
        validateState(sensor.input, ["available", "unavailable"]) &&
        typeof sensor.source === "string" && /^hwmon(0|[1-9][0-9]*)\/temp[1-9][0-9]*_input$/.test(sensor.source) &&
        sensor.source === `${sensor.hwmon}/temp${sensor.channel}_input` &&
        !sensorIds.has(sensor.id) && !sensorSources.has(sensor.source);
      if (!structural) {
        reasons.push(`telemetry metadata temperature sensor ${index + 1} is invalid`);
        continue;
      }
      const kindShapeValid = sensor.kind === "package"
        ? sensor.package !== null && sensor.die === null && sensor.core === null
        : sensor.kind === "core"
          ? sensor.core !== null
          : sensor.package === null && sensor.die === null && sensor.core === null;
      if (!kindShapeValid) reasons.push(`telemetry metadata temperature sensor ${sensor.id} contradicts its kind`);
      if (sensor.mapping.state === "available" &&
          (sensor.kind === "unmapped" || sensor.mapping.target !== sensor.kind || sensor.logical_cpus.length === 0)) {
        reasons.push(`telemetry metadata temperature sensor ${sensor.id} has an invalid available mapping`);
      }
      if (sensor.mapping.state === "unavailable" && sensor.logical_cpus.length !== 0) {
        reasons.push(`unavailable telemetry sensor ${sensor.id} must not claim logical CPUs`);
      }
      sensorIds.add(sensor.id);
      sensorSources.add(sensor.source);
      sensors.push(sensor);
    }
  }
  if (discovery.coretemp.state === "unavailable" && sensors.length !== 0) {
    reasons.push("unavailable coretemp discovery must not claim temperature sensors");
  } else if (discovery.coretemp.state === "available") {
    const distinctDevices = new Set(sensors.map(({ hwmon }) => hwmon)).size;
    if (exactPositiveInteger(discovery.coretemp.device_count, 1_000_000) === null ||
        discovery.coretemp.device_count < distinctDevices) {
      reasons.push("telemetry metadata coretemp device count does not reconcile");
    }
  }

  const targets = discovery.temperature_targets;
  if (!hasExactKeys(targets, ["packages", "cores"]) || !Array.isArray(targets.packages) ||
      !Array.isArray(targets.cores) || targets.packages.length > MAX_CPUS || targets.cores.length > MAX_CPUS ||
      !boundedJsonValue(targets)) {
    reasons.push("telemetry metadata temperature targets are invalid or exceed bounds");
    return { cpus, packageTargets: [], coreTargets: [], unmappedSensors: sensors.map(({ id }) => id) };
  }

  const sensorById = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  const expectedMappings = new Map(sensors.map((sensor) => [sensor.id, {
    mapping: sensor.kind === "unmapped"
      ? unavailableState("unsupported_label")
      : sensor.package === null
        ? unavailableState("package_unresolved")
        : unavailableState("no_requested_topology"),
    logicalCpus: [],
    die: null,
  }]));
  const usedSensors = new Set();
  const actualTargetSensors = new Set();
  const claimTargetSensor = (sensor, label) => {
    if (typeof sensor !== "string") return;
    if (actualTargetSensors.has(sensor)) reasons.push(`telemetry metadata reuses temperature sensor ${sensor} across targets`);
    actualTargetSensors.add(sensor);
    if (!sensorById.has(sensor)) reasons.push(`${label} names an unknown temperature sensor`);
  };

  const packageTargets = [...new Set(cpuEntries
    .map(({ package: packageId }) => topologyInteger(packageId))
    .filter((packageId) => packageId !== null))].sort((left, right) => left - right);
  if (targets.packages.length !== packageTargets.length) {
    reasons.push("telemetry package temperature targets do not exactly cover discovered topology");
  }
  for (let index = 0; index < packageTargets.length; index += 1) {
    const packageId = packageTargets[index];
    const candidates = sensors.filter((sensor) => sensor.kind === "package" && sensor.package === packageId);
    const expectedSensor = candidates.length === 0
      ? unavailableState("no_sensor")
      : candidates.length === 1
        ? candidates[0].id
        : unavailableState("ambiguous_sensor");
    const target = targets.packages[index];
    claimTargetSensor(target?.sensor, `telemetry package target ${packageId}`);
    if (!hasExactKeys(target, ["package", "sensor"]) || target.package !== packageId ||
        !canonicalObjectEqual(target.sensor, expectedSensor)) {
      reasons.push(`telemetry package temperature target ${packageId} does not reconcile with topology and sensors`);
    }
    if (candidates.length === 1) {
      const logicalCpus = cpuEntries.filter((cpu) => cpu.package === packageId).map(({ cpu }) => cpu);
      usedSensors.add(candidates[0].id);
      expectedMappings.set(candidates[0].id, {
        mapping: availableState({ target: "package" }), logicalCpus, die: null,
      });
    } else if (candidates.length > 1) {
      for (const candidate of candidates) {
        expectedMappings.set(candidate.id, {
          mapping: unavailableState("ambiguous_sensor"), logicalCpus: [], die: null,
        });
      }
    }
  }

  const groups = new Map();
  for (const cpu of cpuEntries) {
    const packageId = topologyInteger(cpu.package);
    const die = topologyInteger(cpu.die);
    const core = topologyInteger(cpu.core);
    if (packageId === null || core === null) continue;
    const key = coreTopologyKey(packageId, die, core);
    const group = groups.get(key) ?? {
      package: packageId,
      die,
      dieState: die === null ? cpu.die : availableState(),
      core,
      logicalCpus: [],
    };
    group.logicalCpus.push(cpu.cpu);
    groups.set(key, group);
  }
  const coreGroups = [...groups.values()].sort((left, right) =>
    left.package - right.package || compareNullableIntegers(left.die, right.die) || left.core - right.core);
  const groupCounts = new Map();
  for (const group of coreGroups) {
    const key = packageCoreKey(group.package, group.core);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  if (targets.cores.length !== coreGroups.length) {
    reasons.push("telemetry core temperature targets do not exactly cover discovered topology");
  }
  for (let index = 0; index < coreGroups.length; index += 1) {
    const group = coreGroups[index];
    const candidates = sensors.filter((sensor) => sensor.kind === "core" &&
      sensor.package === group.package && sensor.core === group.core);
    let expectedSensor;
    if (groupCounts.get(packageCoreKey(group.package, group.core)) !== 1) {
      expectedSensor = unavailableState("ambiguous_topology");
      for (const candidate of candidates) {
        expectedMappings.set(candidate.id, {
          mapping: unavailableState("ambiguous_topology"), logicalCpus: [], die: null,
        });
      }
    } else if (candidates.length === 0) expectedSensor = unavailableState("no_sensor");
    else if (candidates.length > 1) {
      expectedSensor = unavailableState("ambiguous_sensor");
      for (const candidate of candidates) {
        expectedMappings.set(candidate.id, {
          mapping: unavailableState("ambiguous_sensor"), logicalCpus: [], die: null,
        });
      }
    } else {
      expectedSensor = candidates[0].id;
      usedSensors.add(candidates[0].id);
      expectedMappings.set(candidates[0].id, {
        mapping: availableState({ target: "core" }),
        logicalCpus: [...group.logicalCpus],
        die: group.die,
      });
    }
    const target = targets.cores[index];
    claimTargetSensor(target?.sensor,
      `telemetry core target ${coreTopologyKey(group.package, group.die, group.core)}`);
    const exactTarget = hasExactKeys(target, ["package", "die", "die_state", "core", "logical_cpus", "sensor"]) &&
      target.package === group.package && target.die === group.die && target.core === group.core &&
      canonicalObjectEqual(target.die_state, group.dieState) &&
      canonicalObjectEqual(target.logical_cpus, group.logicalCpus) &&
      canonicalObjectEqual(target.sensor, expectedSensor);
    if (!exactTarget) {
      reasons.push(`telemetry core temperature target ${coreTopologyKey(group.package, group.die, group.core)} does not reconcile with topology and sensors`);
    }
  }
  for (const extra of targets.packages.slice(packageTargets.length)) {
    claimTargetSensor(extra?.sensor, "extra telemetry package target");
  }
  for (const extra of targets.cores.slice(coreGroups.length)) {
    claimTargetSensor(extra?.sensor, "extra telemetry core target");
  }
  for (const sensor of sensors) {
    const expected = expectedMappings.get(sensor.id);
    if (!canonicalObjectEqual(sensor.mapping, expected.mapping) ||
        !canonicalObjectEqual(sensor.logical_cpus, expected.logicalCpus) || sensor.die !== expected.die) {
      reasons.push(`telemetry sensor ${sensor.id} mapping does not reconcile with topology targets`);
    }
  }
  return {
    cpus,
    packageTargets,
    coreTargets: coreGroups.map((group) => coreTopologyKey(group.package, group.die, group.core)),
    unmappedSensors: sensors.map(({ id }) => id).filter((id) => !usedSensors.has(id)),
  };
}

function validateMetadata(record, expectations, reasons) {
  if (!hasExactKeys(record, METADATA_KEYS) || record.type !== "telemetry_metadata" || record.version !== 1) {
    reasons.push("telemetry metadata record has a noncanonical shape or version");
    return null;
  }
  const started = canonicalUint(record.started_unix_ms);
  const origin = canonicalDecimal(record.monotonic_origin_ns);
  const interval = canonicalPositiveUint(record.interval_ms, MAX_INTERVAL_MS);
  if (started === null) reasons.push("telemetry metadata started_unix_ms is invalid");
  if (record.monotonic_origin !== "recorder_start" || origin === null) {
    reasons.push("telemetry metadata monotonic origin is invalid");
  }
  if (interval === null || interval < MIN_INTERVAL_MS) reasons.push("telemetry metadata interval is invalid");
  if (expectations.intervalMs !== undefined && interval !== expectations.intervalMs) {
    reasons.push("telemetry metadata interval disagrees with its envelope");
  }
  if (!hasExactKeys(record.roots, ["cpu", "hwmon", "no_turbo"]) ||
      !Object.values(record.roots).every(validateAbsoluteCanonicalPath)) {
    reasons.push("telemetry metadata roots are noncanonical");
  } else if (expectations.requireProductionRoots === true &&
      !canonicalObjectEqual(record.roots, PRODUCTION_TELEMETRY_ROOTS)) {
    reasons.push("telemetry metadata roots are not the required production sysfs roots");
  }
  if (!canonicalObjectEqual(record.method, EXPECTED_METHOD)) reasons.push("telemetry metadata method is not the supported read-only method");
  const discovery = validateDiscovery(record.discovery, reasons);
  return { started, origin, interval, discovery };
}

function updateMetric(map, key, identity, value) {
  const record = map.get(key) ?? {
    ...identity,
    count: 0,
    unavailable: 0,
    transient: 0,
    sum: 0,
    min: null,
    max: null,
  };
  if (typeof value === "number") {
    record.count += 1;
    record.sum += value;
    record.min = record.min === null ? value : Math.min(record.min, value);
    record.max = record.max === null ? value : Math.max(record.max, value);
  } else if (value?.state === "transient") record.transient += 1;
  else record.unavailable += 1;
  map.set(key, record);
}

function finishMetricMap(map) {
  return [...map.values()].map(({ sum, ...record }) => ({
    ...record,
    mean: record.count > 0 ? sum / record.count : null,
  }));
}

function validateMetricRows(rows, width, metricIndex, minimum, maximum, label, reasons, callback) {
  if (!Array.isArray(rows) || rows.length > Math.max(MAX_CPUS, MAX_TEMP_CHANNELS)) {
    reasons.push(`${label} rows are missing or exceed bounds`);
    return;
  }
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row) || row.length !== width || !validateMetric(row[metricIndex], minimum, maximum)) {
      reasons.push(`${label} row ${index + 1} is invalid`);
      continue;
    }
    const key = row.slice(0, metricIndex).map((entry) => String(entry)).join(":");
    if (seen.has(key)) reasons.push(`${label} repeats target ${key}`);
    seen.add(key);
    callback(row, key);
  }
}

function validateSample(record, expectedSeq, context, reasons) {
  if (!hasExactKeys(record, SAMPLE_KEYS) || record.type !== "telemetry_sample" || record.seq !== expectedSeq) {
    reasons.push(`telemetry sample ${expectedSeq} has a noncanonical shape or sequence`);
    return null;
  }
  const unix = canonicalUint(record.unix_ms);
  const monotonic = canonicalDecimal(record.monotonic_ns);
  const duration = canonicalDecimal(record.read_duration_ns);
  if (unix === null || monotonic === null || duration === null) {
    reasons.push(`telemetry sample ${expectedSeq} has an invalid clock`);
  }
  if (!validateSampleNoTurbo(record.no_turbo)) reasons.push(`telemetry sample ${expectedSeq} has invalid no_turbo`);
  const cpus = [];
  validateMetricRows(record.scaling_cur_freq_khz, 2, 1, 0, 100_000_000,
    `telemetry sample ${expectedSeq} frequency`, reasons, (row) => {
      const cpu = canonicalUint(row[0], 65_535);
      if (cpu === null) reasons.push(`telemetry sample ${expectedSeq} frequency has an invalid CPU`);
      else cpus.push(cpu);
      updateMetric(context.frequency, String(cpu), { cpu }, row[1]);
    });
  if (context.discovery !== null && cpus.join(",") !== context.discovery.cpus.join(",")) {
    reasons.push(`telemetry sample ${expectedSeq} frequency targets disagree with discovery`);
  }
  const packages = [];
  validateMetricRows(record.package_temperature_millicelsius, 2, 1, -100_000, 250_000,
    `telemetry sample ${expectedSeq} package temperature`, reasons, (row, key) => {
      const packageId = canonicalUint(row[0], 65_535);
      if (packageId === null) reasons.push(`telemetry sample ${expectedSeq} package temperature has an invalid package`);
      packages.push(packageId);
      updateMetric(context.packageTemperature, key, { package: packageId }, row[1]);
    });
  if (context.discovery !== null && packages.join(",") !== context.discovery.packageTargets.join(",")) {
    reasons.push(`telemetry sample ${expectedSeq} package temperature targets disagree with discovery`);
  }
  const cores = [];
  validateMetricRows(record.core_temperature_millicelsius, 4, 3, -100_000, 250_000,
    `telemetry sample ${expectedSeq} core temperature`, reasons, (row, key) => {
      const packageId = canonicalUint(row[0], 65_535);
      const die = row[1] === null ? null : canonicalUint(row[1], 65_535);
      const core = canonicalUint(row[2], 65_535);
      if (packageId === null || (row[1] !== null && die === null) || core === null) {
        reasons.push(`telemetry sample ${expectedSeq} core temperature has invalid topology`);
      }
      cores.push(`${packageId}:${die === null ? "null" : die}:${core}`);
      updateMetric(context.coreTemperature, key, { package: packageId, die, core }, row[3]);
    });
  if (context.discovery !== null && cores.join(",") !== context.discovery.coreTargets.join(",")) {
    reasons.push(`telemetry sample ${expectedSeq} core temperature targets disagree with discovery`);
  }
  const unmapped = [];
  validateMetricRows(record.unmapped_temperature_millicelsius, 2, 1, -100_000, 250_000,
    `telemetry sample ${expectedSeq} unmapped temperature`, reasons, (row, key) => {
      if (!SENSOR_ID_RE.test(row[0] ?? "")) reasons.push(`telemetry sample ${expectedSeq} has an invalid unmapped sensor`);
      unmapped.push(row[0]);
      updateMetric(context.unmappedTemperature, key, { sensor: row[0] }, row[1]);
    });
  if (context.discovery !== null && unmapped.join(",") !== context.discovery.unmappedSensors.join(",")) {
    reasons.push(`telemetry sample ${expectedSeq} unmapped temperature targets disagree with discovery`);
  }
  if (record.no_turbo === 0 || record.no_turbo === 1) {
    context.noTurbo.observed += 1;
    context.noTurbo.values.add(record.no_turbo);
  } else if (record.no_turbo?.state === "transient") context.noTurbo.transient += 1;
  else context.noTurbo.unavailable += 1;
  return { unix, monotonic, duration };
}

function validateEnd(record, sampleCount, bytesBeforeEnd, reasons) {
  if (!hasExactKeys(record, END_KEYS) || record.type !== "telemetry_end") {
    reasons.push("telemetry terminal record has a noncanonical shape");
    return null;
  }
  const unix = canonicalUint(record.unix_ms);
  const monotonic = canonicalDecimal(record.monotonic_ns);
  const samples = canonicalPositiveUint(record.samples, MAX_SAMPLES);
  const bytes = canonicalPositiveUint(record.bytes_before_end, TELEMETRY_LOG_MAX_BYTES);
  if (!TOKEN_RE.test(record.reason ?? "")) reasons.push("telemetry terminal reason is invalid");
  if (unix === null || monotonic === null) reasons.push("telemetry terminal clock is invalid");
  if (samples !== sampleCount) reasons.push("telemetry terminal sample count does not reconcile");
  if (bytes !== bytesBeforeEnd) reasons.push("telemetry terminal bytes_before_end does not reconcile");
  return { unix, monotonic };
}

function emptySampleSummary() {
  return {
    frequency: new Map(),
    packageTemperature: new Map(),
    coreTemperature: new Map(),
    unmappedTemperature: new Map(),
    noTurbo: { observed: 0, unavailable: 0, transient: 0, values: new Set() },
  };
}

function finishSampleSummary(context, samples) {
  return {
    samples,
    noTurbo: {
      totalSamples: samples,
      validSamples: context.noTurbo.observed,
      unavailableSamples: context.noTurbo.unavailable,
      transientSamples: context.noTurbo.transient,
      sampledValues: [...context.noTurbo.values].sort().map(String),
      changed: context.noTurbo.values.size > 1,
    },
    frequencyKHz: finishMetricMap(context.frequency).sort((a, b) => a.cpu - b.cpu),
    packageTemperatureMillicelsius: finishMetricMap(context.packageTemperature)
      .sort((a, b) => a.package - b.package),
    coreTemperatureMillicelsius: finishMetricMap(context.coreTemperature)
      .sort((a, b) => a.package - b.package || (a.die ?? -1) - (b.die ?? -1) || a.core - b.core),
    unmappedTemperatureMillicelsius: finishMetricMap(context.unmappedTemperature)
      .sort((a, b) => a.sensor.localeCompare(b.sensor)),
  };
}

export function parseTelemetryNdjson(value, expectations = {}) {
  const bytes = exactBytes(value);
  const reasons = [];
  if (bytes.length > TELEMETRY_LOG_MAX_BYTES) {
    return { status: "invalid", reasons: ["telemetry log exceeds the validation size limit"], samples: [], summary: null };
  }
  const text = decodeUtf8(bytes, "telemetry log", reasons);
  if (!text.endsWith("\n")) reasons.push("telemetry log must end with a newline");
  if (text.includes("\r") || text.includes("\0")) reasons.push("telemetry log contains a forbidden control byte");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 2 || lines.length > MAX_SAMPLES + 2) reasons.push("telemetry log has an invalid record count");
  const records = [];
  const offsets = [];
  let offset = 0;
  const limit = Math.min(lines.length, MAX_SAMPLES + 3);
  for (let index = 0; index < limit; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index]) + 1;
    offsets.push(offset);
    offset += lineBytes;
    if (lineBytes > MAX_RECORD_BYTES) {
      reasons.push(`telemetry record ${index + 1} exceeds the record size limit`);
      records.push(null);
      continue;
    }
    try {
      const record = JSON.parse(lines[index]);
      if (`${lines[index]}\n` !== canonicalRecord(record)) reasons.push(`telemetry record ${index + 1} is not canonical JSON`);
      records.push(record);
    } catch {
      reasons.push(`telemetry record ${index + 1} is not valid bounded JSON`);
      records.push(null);
    }
  }
  const metadataRecord = records[0];
  const metadataReasons = [];
  const metadata = metadataRecord === null ? null : validateMetadata(metadataRecord, expectations, metadataReasons);
  reasons.push(...metadataReasons);
  const terminalIndices = [];
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.type === "telemetry_end") terminalIndices.push(index);
  }
  if (terminalIndices.length > 1 || terminalIndices.some((index) => index !== records.length - 1)) {
    reasons.push("telemetry log must contain at most one terminal record, last");
  }
  const hasTerminal = terminalIndices.length === 1 && terminalIndices[0] === records.length - 1;
  const sampleEnd = hasTerminal ? records.length - 1 : records.length;
  const samples = [];
  const context = { ...emptySampleSummary(), discovery: metadata?.discovery ?? null };
  let previous = null;
  for (let index = 1; index < sampleEnd; index += 1) {
    const record = records[index];
    if (record?.type !== "telemetry_sample") {
      reasons.push(`telemetry record ${index + 1} is not a sample in canonical order`);
      continue;
    }
    const clock = validateSample(record, index - 1, context, reasons);
    if (clock !== null) {
      if (metadata?.started !== null && clock.unix !== null && clock.unix < metadata.started) {
        reasons.push(`telemetry sample ${index - 1} predates recorder metadata`);
      }
      if (previous !== null && clock.monotonic !== null && previous.monotonic !== null &&
          clock.monotonic < previous.monotonic + previous.duration) {
        reasons.push(`telemetry sample ${index - 1} regresses or overlaps the prior monotonic read`);
      }
      if (previous !== null && clock.unix !== null && previous.unix !== null && clock.unix < previous.unix) {
        reasons.push(`telemetry sample ${index - 1} regresses in Unix time`);
      }
      previous = clock;
    }
    samples.push(record);
  }
  if (samples.length < 1) reasons.push("telemetry log must contain at least one contiguous sample");
  let end = null;
  if (hasTerminal) {
    end = validateEnd(records.at(-1), samples.length, offsets.at(-1), reasons);
    if (end !== null && previous !== null && end.monotonic !== null && previous.monotonic !== null &&
        end.monotonic < previous.monotonic + previous.duration) {
      reasons.push("telemetry terminal monotonic clock precedes the final sample read");
    }
    if (end !== null && previous !== null && end.unix !== null && previous.unix !== null && end.unix < previous.unix) {
      reasons.push("telemetry terminal Unix clock precedes the final sample");
    }
  }
  const invalid = reasons.length > 0;
  const status = invalid ? "invalid" : hasTerminal ? "complete" : "incomplete";
  const resultReasons = [...reasons];
  if (!invalid && !hasTerminal) resultReasons.push("telemetry terminal record is missing");
  return {
    status,
    reasons: unique(resultReasons),
    metadata: metadataRecord,
    samples,
    end: hasTerminal ? records.at(-1) : null,
    clocks: metadata === null ? null : {
      startedUnixMs: metadata.started,
      monotonicOriginNs: metadata.origin,
      firstSampleMonotonicNs: samples.length > 0 ? canonicalDecimal(samples[0].monotonic_ns) : null,
      firstSampleReadDurationNs: samples.length > 0 ? canonicalDecimal(samples[0].read_duration_ns) : null,
      endUnixMs: end?.unix ?? null,
      endMonotonicNs: end?.monotonic ?? null,
    },
    intervalMs: metadata?.interval ?? null,
    summary: invalid ? null : finishSampleSummary(context, samples.length),
  };
}

function validateBoundaryPoint(point, label, reasons) {
  if (!hasExactKeys(point, BOUNDARY_POINT_KEYS)) {
    reasons.push(`telemetry boundary ${label} has a noncanonical shape`);
    return null;
  }
  const unix = canonicalUint(point.unixMs);
  const monotonic = canonicalDecimal(point.monotonicNs);
  if (unix === null || monotonic === null) reasons.push(`telemetry boundary ${label} clock is invalid`);
  if (!validateBoundaryNoTurbo(point.noTurbo)) reasons.push(`telemetry boundary ${label} noTurbo state is invalid`);
  return { unix, monotonic, noTurbo: point.noTurbo };
}

export function parseTelemetryBoundary(value, expectations = {}) {
  const bytes = exactBytes(value);
  const reasons = [];
  if (bytes.length > TELEMETRY_BOUNDARY_MAX_BYTES) {
    return { status: "invalid", reasons: ["telemetry boundary exceeds the validation size limit"], boundary: null };
  }
  const text = decodeUtf8(bytes, "telemetry boundary", reasons);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.includes("\0")) {
    reasons.push("telemetry boundary must be exactly one canonical JSON line");
  }
  let boundary = null;
  try {
    boundary = JSON.parse(text.trimEnd());
    if (canonicalRecord(boundary) !== text) reasons.push("telemetry boundary is not canonical JSON");
  } catch {
    reasons.push("telemetry boundary is not valid bounded JSON");
  }
  if (!hasExactKeys(boundary, BOUNDARY_KEYS) || boundary?.version !== 1 || !validatePhase(boundary?.phase) ||
      !TAG_RE.test(boundary?.tag ?? "") || !GENERATION_RE.test(boundary?.generation ?? "") ||
      canonicalPositiveUint(boundary?.segment, TELEMETRY_MAX_SEGMENTS) === null) {
    reasons.push("telemetry boundary has invalid identity fields");
  }
  const start = boundary === null ? null : validateBoundaryPoint(boundary.start, "start", reasons);
  const end = boundary === null ? null : validateBoundaryPoint(boundary.end, "end", reasons);
  if (start !== null && end !== null) {
    if (start.unix !== null && end.unix !== null && start.unix > end.unix) reasons.push("telemetry boundary Unix clock regresses");
    if (start.monotonic !== null && end.monotonic !== null && start.monotonic > end.monotonic) {
      reasons.push("telemetry boundary monotonic clock regresses");
    }
  }
  for (const [key, expected] of [
    ["phase", expectations.phase], ["tag", expectations.tag], ["generation", expectations.generation],
    ["segment", expectations.segment],
  ]) {
    if (expected !== undefined && boundary?.[key] !== expected) reasons.push(`telemetry boundary ${key} disagrees with its index`);
  }
  return {
    status: reasons.length === 0 ? "complete" : "invalid",
    reasons: unique(reasons),
    boundary,
    start,
    end,
  };
}

export function serializeTelemetryBoundary(boundary) {
  const text = canonicalRecord(boundary);
  const parsed = parseTelemetryBoundary(text);
  if (parsed.status !== "complete") throw new TypeError(parsed.reasons.join("; "));
  return Buffer.from(text);
}

function telemetryTimingAssociation(log) {
  const origin = log?.clocks?.monotonicOriginNs;
  if (origin === null || origin === undefined || !Array.isArray(log?.samples)) return null;
  const samples = [];
  for (const sample of log.samples) {
    const relativeStart = canonicalDecimal(sample?.monotonic_ns);
    const duration = canonicalDecimal(sample?.read_duration_ns);
    const unixMs = canonicalUint(sample?.unix_ms);
    if (relativeStart === null || duration === null || unixMs === null ||
        exactInteger(sample?.seq, MAX_SAMPLES) === null) return null;
    const start = origin + relativeStart;
    const end = start + duration;
    samples.push({
      seq: sample.seq,
      unixMs,
      monotonicStartNs: start.toString(),
      monotonicEndNs: end.toString(),
      readDurationNs: duration.toString(),
    });
  }
  return {
    metadata: {
      startedUnixMs: log.clocks.startedUnixMs,
      monotonicOriginNs: origin.toString(),
      intervalMs: log.intervalMs,
      roots: log.metadata?.roots ?? null,
      discovery: log.metadata?.discovery ?? null,
    },
    // This payload is for in-memory evidence association only. Callers must
    // consume it for joins and omit it from durable summaries/results.
    samples: samples.map((timing, index) => ({
      ...timing,
      scalingCurFreqKHz: log.samples[index].scaling_cur_freq_khz,
      packageTemperatureMillicelsius: log.samples[index].package_temperature_millicelsius,
      coreTemperatureMillicelsius: log.samples[index].core_temperature_millicelsius,
      unmappedTemperatureMillicelsius: log.samples[index].unmapped_temperature_millicelsius,
      noTurbo: log.samples[index].no_turbo,
    })),
  };
}

function maximumBigInt(values) {
  let maximum = null;
  for (const value of values) maximum = maximum === null || value > maximum ? value : maximum;
  return maximum;
}

function bigintString(value) {
  return value === null ? null : value.toString();
}

function sampleSweepCounts(samples, workloadStart, workloadEnd) {
  const counts = {
    before: 0,
    fullyContained: 0,
    overlapsStart: 0,
    overlapsEnd: 0,
    spansWorkload: 0,
    after: 0,
  };
  for (const sample of samples) {
    if (sample.end <= workloadStart) counts.before += 1;
    else if (sample.start >= workloadEnd) counts.after += 1;
    else if (sample.start >= workloadStart && sample.end <= workloadEnd) counts.fullyContained += 1;
    else if (sample.start < workloadStart && sample.end > workloadEnd) counts.spansWorkload += 1;
    else if (sample.start < workloadStart) counts.overlapsStart += 1;
    else counts.overlapsEnd += 1;
  }
  return counts;
}

function workloadObservationGaps(samples, workloadStart, workloadEnd) {
  if (workloadEnd <= workloadStart) return [];
  const observations = samples
    .filter((sample) => sample.end > workloadStart && sample.start < workloadEnd)
    .map((sample) => ({
      start: sample.start < workloadStart ? workloadStart : sample.start,
      end: sample.end > workloadEnd ? workloadEnd : sample.end,
    }));
  const gaps = [];
  let cursor = workloadStart;
  for (const observation of observations) {
    if (observation.start > cursor) gaps.push(observation.start - cursor);
    if (observation.end > cursor) cursor = observation.end;
  }
  if (cursor < workloadEnd) gaps.push(workloadEnd - cursor);
  return gaps;
}

function workloadSampleStartGaps(samples, workloadStart, workloadEnd) {
  if (workloadEnd <= workloadStart) return [];
  const starts = samples
    .map((sample) => sample.start)
    .filter((start) => start >= workloadStart && start <= workloadEnd);
  if (starts.length === 0) return [workloadEnd - workloadStart];
  const gaps = [starts[0] - workloadStart];
  for (let index = 1; index < starts.length; index += 1) gaps.push(starts[index] - starts[index - 1]);
  gaps.push(workloadEnd - starts.at(-1));
  return gaps;
}

export function assessTelemetryBoundaryCoverage(log, parsedBoundary) {
  const reasons = [];
  if (log?.status !== "complete") reasons.push("sampler terminal coverage is unavailable");
  if (parsedBoundary?.status !== "complete") reasons.push("workload boundary is invalid");
  const clocks = log?.clocks;
  const start = parsedBoundary?.start;
  const end = parsedBoundary?.end;
  const association = telemetryTimingAssociation(log);
  const endpointCoverage = {
    start: { status: "unavailable", completedSamplesAtOrBefore: 0, unixCovered: false },
    end: { status: "unavailable", terminalMonotonicCovered: false, unixCovered: false },
  };
  const workloadSamples = {
    before: 0,
    fullyContained: 0,
    overlapsStart: 0,
    overlapsEnd: 0,
    spansWorkload: 0,
    after: 0,
    qualifyingDuring: 0,
  };
  const cadence = {
    intervalMs: log?.intervalMs ?? null,
    maximumAllowedUnobservedIntervals: TELEMETRY_MAX_CADENCE_INTERVALS,
    maximumAllowedSampleStartGapNs: null,
    evaluatedSampleGaps: 0,
    maxStartToStartGapNs: null,
    maxReadEndToNextStartGapNs: null,
    maxWorkloadUnobservedGapNs: null,
    maxWorkloadSampleStartGapNs: null,
    latePollCount: 0,
    missedPollIntervals: "0",
    cadenceViolationCount: 0,
  };
  if (clocks && start && end && clocks.monotonicOriginNs !== null) {
    const samples = (association?.samples ?? []).map((sample) => ({
      start: BigInt(sample.monotonicStartNs),
      end: BigInt(sample.monotonicEndNs),
    }));
    if (start.monotonic !== null) {
      endpointCoverage.start.completedSamplesAtOrBefore = samples
        .filter((sample) => sample.end <= start.monotonic).length;
      endpointCoverage.start.unixCovered = start.unix !== null && clocks.startedUnixMs !== null &&
        start.unix >= clocks.startedUnixMs;
      endpointCoverage.start.status = endpointCoverage.start.completedSamplesAtOrBefore > 0 &&
        endpointCoverage.start.unixCovered ? "covered" : "uncovered";
      if (endpointCoverage.start.completedSamplesAtOrBefore === 0) {
        reasons.push("workload starts before any telemetry sample completed");
      }
      if (!endpointCoverage.start.unixCovered) reasons.push("workload starts before sampler Unix coverage");
    }
    if (end.monotonic !== null) {
      endpointCoverage.end.terminalMonotonicCovered = log.status === "complete" &&
        clocks.endMonotonicNs !== null && end.monotonic <= clocks.monotonicOriginNs + clocks.endMonotonicNs;
      endpointCoverage.end.unixCovered = log.status === "complete" && end.unix !== null &&
        clocks.endUnixMs !== null && end.unix <= clocks.endUnixMs;
      endpointCoverage.end.status = endpointCoverage.end.terminalMonotonicCovered &&
        endpointCoverage.end.unixCovered ? "covered" : "uncovered";
      if (!endpointCoverage.end.terminalMonotonicCovered) reasons.push("workload ends after sampler terminal coverage");
      if (!endpointCoverage.end.unixCovered) reasons.push("workload ends after sampler Unix coverage");
    }
    if (start.monotonic !== null && end.monotonic !== null) {
      Object.assign(workloadSamples, sampleSweepCounts(samples, start.monotonic, end.monotonic));
      // A reading is attributed to the workload only when its entire sysfs
      // sweep is inside the boundary. Boundary-straddling sweeps stay visible
      // in the overlap counts, but are not mislabeled as workload samples.
      workloadSamples.qualifyingDuring = workloadSamples.fullyContained;
      if (workloadSamples.qualifyingDuring === 0) {
        reasons.push("workload contains no fully-contained telemetry sample sweep");
      }

      const startGaps = [];
      const readEndGaps = [];
      for (let index = 1; index < samples.length; index += 1) {
        startGaps.push(samples[index].start - samples[index - 1].start);
        readEndGaps.push(samples[index].start - samples[index - 1].end);
      }
      cadence.evaluatedSampleGaps = startGaps.length;
      cadence.maxStartToStartGapNs = bigintString(maximumBigInt(startGaps));
      cadence.maxReadEndToNextStartGapNs = bigintString(maximumBigInt(readEndGaps));
      if (Number.isSafeInteger(log.intervalMs) && log.intervalMs > 0) {
        const intervalNs = BigInt(log.intervalMs) * 1_000_000n;
        const allowedGap = intervalNs * BigInt(TELEMETRY_MAX_CADENCE_INTERVALS);
        cadence.maximumAllowedSampleStartGapNs = allowedGap.toString();
        const observationGaps = workloadObservationGaps(samples, start.monotonic, end.monotonic);
        const startCadenceGaps = workloadSampleStartGaps(samples, start.monotonic, end.monotonic);
        cadence.maxWorkloadUnobservedGapNs = bigintString(maximumBigInt(observationGaps));
        cadence.maxWorkloadSampleStartGapNs = bigintString(maximumBigInt(startCadenceGaps));
        cadence.latePollCount = startCadenceGaps.filter((gap) => gap > intervalNs * 2n).length;
        cadence.missedPollIntervals = startCadenceGaps.reduce((total, gap) => {
          const intervals = gap / intervalNs;
          return total + (intervals > 1n ? intervals - 1n : 0n);
        }, 0n).toString();
        cadence.cadenceViolationCount = startCadenceGaps.filter((gap) => gap > allowedGap).length;
        if (cadence.cadenceViolationCount > 0) {
          reasons.push(`workload telemetry has a sample-start cadence gap exceeding ${TELEMETRY_MAX_CADENCE_INTERVALS} requested intervals`);
        }
      } else {
        reasons.push("telemetry cadence interval is unavailable");
      }
    }
  } else {
    reasons.push("telemetry monotonic association is unavailable");
  }
  return {
    status: reasons.length === 0 ? "complete" : "incomplete",
    reasons: unique(reasons),
    endpointCoverage,
    workloadSamples,
    cadence,
  };
}

function indexPath(phase) {
  return ["results", `telemetry-${phase}.tsv`];
}

function metaPath(phase) {
  return ["results", `telemetry-${phase}.meta`];
}

function logRelative(phase, generation, segment) {
  return `telemetry/${phase}/${generation}-${segment}.ndjson`;
}

function boundaryRelative(phase, generation, segment) {
  return `telemetry/${phase}/${generation}-${segment}.boundary.json`;
}

export function parseTelemetryIndex(value) {
  const reasons = [];
  const text = decodeUtf8(value, "telemetry index", reasons);
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) reasons.push("telemetry index must be canonical LF-terminated text");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== TELEMETRY_INDEX_HEADER) reasons.push("telemetry index has a noncanonical header");
  if (lines.length > TELEMETRY_MAX_SEGMENTS) reasons.push("telemetry index exceeds the segment limit");
  const rows = [];
  const segments = new Set();
  const tags = new Set();
  for (let index = 0; index < Math.min(lines.length, TELEMETRY_MAX_SEGMENTS + 1); index += 1) {
    const fields = lines[index].split("\t");
    if (fields.length !== 10) {
      reasons.push(`telemetry index row ${index + 1} must contain exactly 10 fields`);
      continue;
    }
    const [segmentText, tag, log, boundary, logSha256, logBytesText, boundarySha256,
      boundaryBytesText, samplesText, status] = fields;
    const segment = canonicalPositiveUint(segmentText, TELEMETRY_MAX_SEGMENTS);
    const logBytes = canonicalPositiveUint(logBytesText, TELEMETRY_LOG_MAX_BYTES);
    const boundaryBytes = canonicalPositiveUint(boundaryBytesText, TELEMETRY_BOUNDARY_MAX_BYTES);
    const samples = canonicalPositiveUint(samplesText, MAX_SAMPLES);
    if (segment === null || !TAG_RE.test(tag) || !DIGEST_RE.test(logSha256) || logBytes === null ||
        !DIGEST_RE.test(boundarySha256) || boundaryBytes === null || samples === null ||
        !["complete", "incomplete"].includes(status)) {
      reasons.push(`telemetry index row ${index + 1} contains a malformed field`);
    }
    if (segment !== null && segments.has(segment)) reasons.push(`telemetry index row ${index + 1} duplicates segment ${segment}`);
    if (tags.has(tag)) reasons.push(`telemetry index row ${index + 1} duplicates tag ${tag}`);
    if (rows.length > 0 && segment !== null && segment <= rows.at(-1).segment) {
      reasons.push("telemetry index segments are not strictly increasing");
    }
    segments.add(segment);
    tags.add(tag);
    rows.push({
      segment, tag, log, boundary, logSha256, logBytes, boundarySha256, boundaryBytes, samples, status,
    });
  }
  return { rows, reasons: unique(reasons) };
}

export function serializeTelemetryIndex(rows) {
  if (!Array.isArray(rows)) throw new TypeError("telemetry index rows must be an array");
  const text = `${TELEMETRY_INDEX_HEADER}\n${rows.map((row) => [
    row.segment, row.tag, row.log, row.boundary, row.logSha256, row.logBytes,
    row.boundarySha256, row.boundaryBytes, row.samples, row.status,
  ].join("\t")).join("\n")}${rows.length > 0 ? "\n" : ""}`;
  const parsed = parseTelemetryIndex(text);
  if (parsed.reasons.length > 0) throw new TypeError(parsed.reasons.join("; "));
  return Buffer.from(text);
}

function telemetryMetaKeys(meta) {
  const base = meta?.VERSION === "2" ? META_KEYS_V2 : META_KEYS_V1;
  return meta?.STATUS === "incomplete" && Object.hasOwn(meta ?? {}, "REASON")
    ? [...base, "REASON"]
    : base;
}

function validateTelemetryWorkloadBindingMeta(meta, reasons) {
  if (meta.VERSION !== "2") return;
  const exactBoundaryPhase = meta.PHASE === "individual" || meta.PHASE === "pinned-concurrent";
  const expectedGeneration = meta.PHASE === "baseline"
    ? meta.WORKLOAD_GENERATION === "-"
    : GENERATION_RE.test(meta.WORKLOAD_GENERATION ?? "");
  if (!expectedGeneration || !DIGEST_RE.test(meta.WORKLOAD_BINDING_SHA256 ?? "")) {
    reasons.push("telemetry workload binding identity is invalid");
  }
  if (exactBoundaryPhase) {
    if (!DIGEST_RE.test(meta.WORKLOAD_BOUNDARIES_SHA256 ?? "") ||
        canonicalPositiveUint(meta.WORKLOAD_BOUNDARY_ROW_COUNT, 20_000_000) === null) {
      reasons.push("exact-CPU telemetry workload boundary binding is invalid");
    }
  } else if (meta.WORKLOAD_BOUNDARIES_SHA256 !== "-" ||
      meta.WORKLOAD_BOUNDARY_ROW_COUNT !== "-") {
    reasons.push("non-exact telemetry workload boundary binding must use canonical dashes");
  }
}

export function parseTelemetryMeta(value) {
  const reasons = [];
  const text = decodeUtf8(value, "telemetry metadata envelope", reasons);
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    reasons.push("telemetry metadata envelope must be canonical LF-terminated text");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const meta = {};
  const keys = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) {
      reasons.push("telemetry metadata envelope contains a malformed record");
      continue;
    }
    const [, key, valueText] = match;
    keys.push(key);
    if (!KNOWN_META_KEYS.has(key)) reasons.push(`telemetry metadata envelope contains unknown field ${key}`);
    else if (Object.hasOwn(meta, key)) reasons.push(`telemetry metadata envelope duplicates field ${key}`);
    else meta[key] = valueText;
  }
  const expectedKeys = telemetryMetaKeys(meta);
  if (keys.join("\n") !== expectedKeys.join("\n")) {
    reasons.push(`telemetry metadata envelope must contain exactly the canonical ${expectedKeys.length} records in order`);
  }
  if (!["1", "2"].includes(meta.VERSION) || !GENERATION_RE.test(meta.GENERATION ?? "") || !validatePhase(meta.PHASE) ||
      canonicalPositiveUint(meta.INTERVAL_MS, MAX_INTERVAL_MS) === null || Number(meta.INTERVAL_MS) < MIN_INTERVAL_MS ||
      canonicalPositiveUint(meta.EXPECTED_SEGMENTS, TELEMETRY_MAX_SEGMENTS) === null ||
      !["complete", "incomplete"].includes(meta.STATUS) || !DIGEST_RE.test(meta.ROWS_SHA256 ?? "") ||
      canonicalPositiveUint(meta.ROWS_BYTES, TELEMETRY_INDEX_MAX_BYTES) === null ||
      canonicalUint(meta.ROW_COUNT, TELEMETRY_MAX_SEGMENTS) === null) {
    reasons.push("telemetry metadata envelope contains an invalid required value");
  }
  validateTelemetryWorkloadBindingMeta(meta, reasons);
  if (meta.STATUS === "complete" && Object.hasOwn(meta, "REASON")) reasons.push("complete telemetry metadata must not contain REASON");
  if (Object.hasOwn(meta, "REASON") && !REASON_RE.test(meta.REASON)) reasons.push("telemetry metadata REASON is invalid");
  return { meta, reasons: unique(reasons) };
}

export function serializeTelemetryMeta(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("telemetry metadata must be an object");
  const keys = telemetryMetaKeys(meta);
  const supplied = Object.keys(meta);
  const text = `${keys.map((key) => `${key}=${meta[key]}`).join("\n")}\n`;
  const parsed = parseTelemetryMeta(text);
  if (parsed.reasons.length > 0 || supplied.length !== keys.length || supplied.some((key) => !keys.includes(key))) {
    throw new TypeError(unique([
      ...parsed.reasons,
      supplied.length !== keys.length || supplied.some((key) => !keys.includes(key))
        ? "telemetry metadata object has noncanonical fields"
        : null,
    ]).join("; "));
  }
  return Buffer.from(text);
}

function readTarget(root, components, maximum, label) {
  const file = path.join(root, ...components);
  const read = readStableRegularFile(file, maximum, label, {
    requiredOwner: typeof process.getuid === "function" ? process.getuid() : null,
  });
  return {
    file,
    state: !read.present ? "missing" : read.errors.length > 0 || read.bytes === null ? "unsafe" : "regular",
    bytes: read.bytes,
    reasons: read.errors,
  };
}

function inspectDirectory(directory, label, required = true) {
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) return { state: "unsafe", reason: `${label} must be a real directory` };
    return { state: "regular", stat };
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return { state: "missing" };
    return { state: "unsafe", reason: `${label} is missing or could not be inspected` };
  }
}

function targetExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function scanPhaseDirectory(directory, allowedNames = null) {
  const reasons = [];
  const names = [];
  let handle;
  try {
    handle = opendirSync(directory);
    for (let count = 0; count <= TELEMETRY_MAX_SEGMENTS * 2; count += 1) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (count === TELEMETRY_MAX_SEGMENTS * 2) {
        reasons.push("telemetry phase directory exceeds the entry limit");
        break;
      }
      names.push(entry.name);
      const file = path.join(directory, entry.name);
      const stat = lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) reasons.push(`telemetry phase entry ${entry.name} is not a single-link regular file`);
      if (allowedNames !== null && !allowedNames.has(entry.name)) reasons.push(`telemetry phase directory contains unknown file ${entry.name}`);
    }
  } catch {
    reasons.push("telemetry phase directory could not be inspected safely");
  } finally {
    try { handle?.closeSync(); } catch { /* best effort */ }
  }
  return { names, reasons: unique(reasons) };
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > TELEMETRY_MAX_SEGMENTS) {
    throw new TypeError(`segments must contain 1-${TELEMETRY_MAX_SEGMENTS} entries`);
  }
  const ids = new Set();
  const tags = new Set();
  const normalized = segments.map((entry, index) => {
    const segment = canonicalPositiveUint(entry?.segment, TELEMETRY_MAX_SEGMENTS);
    const tag = entry?.tag;
    if (segment === null || !TAG_RE.test(tag ?? "")) throw new TypeError(`segment ${index + 1} has invalid identity`);
    if (ids.has(segment) || tags.has(tag)) throw new TypeError("segment IDs and tags must be unique");
    ids.add(segment);
    tags.add(tag);
    return { segment, tag };
  }).sort((left, right) => left.segment - right.segment);
  return normalized;
}

function requireBuildDirectory(root, phase) {
  for (const [directory, label] of [
    [root, "bundle root"],
    [path.join(root, "results"), "results directory"],
    [path.join(root, "telemetry"), "telemetry directory"],
    [path.join(root, "telemetry", phase), "telemetry phase directory"],
  ]) {
    const state = inspectDirectory(directory, label);
    if (state.state !== "regular") throw new Error(state.reason);
  }
}

function boundaryValues(parsed) {
  return [parsed.start?.noTurbo, parsed.end?.noTurbo];
}

function phaseNoTurboSummary(segments) {
  const sampledValues = new Set();
  const boundaryObservedValues = new Set();
  let validSamples = 0;
  let totalSamples = 0;
  let unavailableSamples = 0;
  let transientSamples = 0;
  let validBoundaries = 0;
  let totalBoundaries = 0;
  for (const segment of segments) {
    const summary = segment.summary?.noTurbo;
    if (summary) {
      totalSamples += summary.totalSamples;
      validSamples += summary.validSamples;
      unavailableSamples += summary.unavailableSamples;
      transientSamples += summary.transientSamples;
      for (const value of summary.sampledValues) sampledValues.add(value);
    }
    for (const value of boundaryValues(segment.boundaryParsed ?? {})) {
      totalBoundaries += 1;
      if (value === 0 || value === 1) {
        validBoundaries += 1;
        boundaryObservedValues.add(String(value));
      }
    }
  }
  const allValues = new Set([...sampledValues, ...boundaryObservedValues]);
  const complete = totalSamples > 0 && validSamples === totalSamples &&
    totalBoundaries > 0 && validBoundaries === totalBoundaries;
  return {
    status: complete ? "complete" : "incomplete",
    sampledValues: [...sampledValues].sort(),
    boundaryValues: [...boundaryObservedValues].sort(),
    validSamples,
    totalSamples,
    unavailableSamples,
    transientSamples,
    validBoundaries,
    totalBoundaries,
    changed: allValues.size > 1,
  };
}

function normalizeTelemetryWorkloadBinding(phase, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workloadBinding must be an object");
  }
  if (value.phase !== undefined && value.phase !== phase) {
    throw new TypeError("workloadBinding phase disagrees with the telemetry phase");
  }
  const generation = value.workloadGeneration;
  if ((phase === "baseline" ? generation !== "-" : !GENERATION_RE.test(generation ?? "")) ||
      !DIGEST_RE.test(value.workloadBindingSha256 ?? "")) {
    throw new TypeError("workloadBinding has an invalid generation or digest");
  }
  const exactBoundaryPhase = phase === "individual" || phase === "pinned-concurrent";
  if (exactBoundaryPhase) {
    const rowCount = canonicalPositiveUint(value.workloadBoundaryRowCount, 20_000_000);
    if (!DIGEST_RE.test(value.workloadBoundariesSha256 ?? "") || rowCount === null) {
      throw new TypeError("exact-CPU workloadBinding requires a boundary digest and positive row count");
    }
    return {
      workloadGeneration: generation,
      workloadBindingSha256: value.workloadBindingSha256,
      workloadBoundariesSha256: value.workloadBoundariesSha256,
      workloadBoundaryRowCount: String(rowCount),
    };
  }
  if (![undefined, null, "-"].includes(value.workloadBoundariesSha256) ||
      ![undefined, null, "-"].includes(value.workloadBoundaryRowCount)) {
    throw new TypeError("non-exact workloadBinding must not supply boundary identity");
  }
  return {
    workloadGeneration: generation,
    workloadBindingSha256: value.workloadBindingSha256,
    workloadBoundariesSha256: "-",
    workloadBoundaryRowCount: "-",
  };
}

export function buildTelemetryEnvelope(bundleDir, options = {}) {
  const phase = options.phase;
  const generation = options.generation;
  const intervalMs = canonicalPositiveUint(options.intervalMs, MAX_INTERVAL_MS);
  if (!validatePhase(phase) || !GENERATION_RE.test(generation ?? "") || intervalMs === null || intervalMs < MIN_INTERVAL_MS) {
    throw new TypeError("phase, generation, or intervalMs is invalid");
  }
  const segments = normalizeSegments(options.segments);
  const workloadBinding = normalizeTelemetryWorkloadBinding(phase, options.workloadBinding);
  const root = path.resolve(bundleDir);
  requireBuildDirectory(root, phase);
  const expectedNames = new Set(segments.flatMap(({ segment }) => [
    `${generation}-${segment}.ndjson`, `${generation}-${segment}.boundary.json`,
  ]));
  const scan = scanPhaseDirectory(path.join(root, "telemetry", phase), expectedNames);
  if (scan.reasons.length > 0) throw new Error(scan.reasons.join("; "));
  const rows = [];
  const summaries = [];
  let incomplete = false;
  for (const { segment, tag } of segments) {
    const logRel = logRelative(phase, generation, segment);
    const boundaryRel = boundaryRelative(phase, generation, segment);
    const log = readTarget(root, logRel.split("/"), TELEMETRY_LOG_MAX_BYTES, `telemetry segment ${segment} log`);
    const boundary = readTarget(root, boundaryRel.split("/"), TELEMETRY_BOUNDARY_MAX_BYTES, `telemetry segment ${segment} boundary`);
    if (log.state !== "regular" || boundary.state !== "regular") {
      throw new Error(`telemetry segment ${segment} is missing or unsafe`);
    }
    const parsedLog = parseTelemetryNdjson(log.bytes, { intervalMs });
    if (parsedLog.status === "invalid") throw new Error(parsedLog.reasons.join("; "));
    const parsedBoundary = parseTelemetryBoundary(boundary.bytes, { phase, tag, generation, segment });
    if (parsedBoundary.status !== "complete") throw new Error(parsedBoundary.reasons.join("; "));
    const coverage = assessTelemetryBoundaryCoverage(parsedLog, parsedBoundary);
    const segmentStatus = parsedLog.status === "complete" && coverage.status === "complete"
      ? "complete"
      : "incomplete";
    if (segmentStatus === "incomplete") incomplete = true;
    const logBinding = telemetryFileBinding(log.bytes);
    const boundaryBinding = telemetryFileBinding(boundary.bytes);
    rows.push({
      segment,
      tag,
      log: logRel,
      boundary: boundaryRel,
      logSha256: logBinding.sha256,
      logBytes: logBinding.bytes,
      boundarySha256: boundaryBinding.sha256,
      boundaryBytes: boundaryBinding.bytes,
      samples: parsedLog.samples.length,
      status: segmentStatus,
    });
    summaries.push({
      segment,
      tag,
      status: segmentStatus,
      logStatus: parsedLog.status,
      coverage,
      association: telemetryTimingAssociation(parsedLog),
      summary: parsedLog.summary,
      boundary: parsedBoundary.boundary,
      boundaryParsed: parsedBoundary,
    });
  }
  const rowsBuffer = serializeTelemetryIndex(rows);
  const binding = telemetryFileBinding(rowsBuffer, rows.length);
  const status = incomplete ? "incomplete" : "complete";
  const metaValues = {
    VERSION: workloadBinding === null ? "1" : "2",
    GENERATION: generation,
    PHASE: phase,
    INTERVAL_MS: String(intervalMs),
    EXPECTED_SEGMENTS: String(segments.length),
    ...(workloadBinding === null ? {} : {
      WORKLOAD_GENERATION: workloadBinding.workloadGeneration,
      WORKLOAD_BINDING_SHA256: workloadBinding.workloadBindingSha256,
      WORKLOAD_BOUNDARIES_SHA256: workloadBinding.workloadBoundariesSha256,
      WORKLOAD_BOUNDARY_ROW_COUNT: workloadBinding.workloadBoundaryRowCount,
    }),
    STATUS: status,
    ROWS_SHA256: binding.sha256,
    ROWS_BYTES: String(binding.bytes),
    ROW_COUNT: String(binding.rowCount),
    ...(incomplete ? { REASON: "segment_incomplete" } : {}),
  };
  const metaBuffer = serializeTelemetryMeta(metaValues);
  return {
    status,
    reasons: incomplete ? ["one or more telemetry segments are incomplete"] : [],
    metaBuffer,
    rowsBuffer,
    metaValues,
    rows,
    segments: summaries,
    noTurbo: phaseNoTurboSummary(summaries),
    workloadBinding,
  };
}

function bindingMatches(row, prefix, bytes) {
  const binding = telemetryFileBinding(bytes);
  return row[`${prefix}Sha256`] === binding.sha256 && row[`${prefix}Bytes`] === binding.bytes;
}

function indexBindingMatches(meta, bytes, rows) {
  const binding = telemetryFileBinding(bytes, rows.length);
  return meta.ROWS_SHA256 === binding.sha256 && canonicalUint(meta.ROWS_BYTES) === binding.bytes &&
    canonicalUint(meta.ROW_COUNT) === binding.rowCount;
}

function rawArtifactsPresent(root, phase) {
  const directory = path.join(root, "telemetry", phase);
  const state = inspectDirectory(directory, "telemetry phase directory", false);
  if (state.state !== "regular") return state.state === "unsafe";
  const scan = scanPhaseDirectory(directory);
  return scan.names.length > 0 || scan.reasons.length > 0;
}

export function assessTelemetryEvidence(bundleDir, options = {}) {
  const phase = options.phase;
  if (!validatePhase(phase)) return { status: "invalid", reasons: ["telemetry phase is invalid"], segments: [], noTurbo: null };
  const root = path.resolve(bundleDir);
  const rootState = inspectDirectory(root, "bundle root");
  if (rootState.state !== "regular") return { status: "invalid", reasons: [rootState.reason], segments: [], noTurbo: null };
  const indexComponents = indexPath(phase);
  const metaComponents = metaPath(phase);
  const indexFile = path.join(root, ...indexComponents);
  const metaFile = path.join(root, ...metaComponents);
  const anyArtifact = targetExists(indexFile) || targetExists(metaFile) || rawArtifactsPresent(root, phase);
  if (!anyArtifact) return { status: "not-run", reasons: [], segments: [], noTurbo: null, boundaryCoverage: null };

  const reasons = [];
  let invalid = false;
  for (const [directory, label] of [
    [path.join(root, "results"), "results directory"],
    [path.join(root, "state"), "state directory"],
    [path.join(root, "telemetry"), "telemetry directory"],
    [path.join(root, "telemetry", phase), "telemetry phase directory"],
  ]) {
    const state = inspectDirectory(directory, label, false);
    if (state.state === "unsafe") {
      reasons.push(state.reason);
      invalid = true;
    } else if (state.state === "missing") reasons.push(`${label} is missing`);
  }
  const metaRead = readTarget(root, metaComponents, TELEMETRY_META_MAX_BYTES, `telemetry ${phase} metadata`);
  const indexRead = readTarget(root, indexComponents, TELEMETRY_INDEX_MAX_BYTES, `telemetry ${phase} index`);
  for (const [name, read] of [["metadata", metaRead], ["index", indexRead]]) {
    if (read.state === "unsafe") {
      reasons.push(...read.reasons);
      invalid = true;
    } else if (read.state === "missing") reasons.push(`telemetry ${name} is missing`);
  }
  let meta = {};
  if (metaRead.state === "regular") {
    const parsed = parseTelemetryMeta(metaRead.bytes);
    meta = parsed.meta;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }
  let rows = [];
  if (indexRead.state === "regular") {
    const parsed = parseTelemetryIndex(indexRead.bytes);
    rows = parsed.rows;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
    if (!indexBindingMatches(meta, indexRead.bytes, rows)) {
      reasons.push("telemetry index does not match its exact metadata binding");
      invalid = true;
    }
  }
  if (meta.PHASE !== phase) {
    reasons.push("telemetry metadata phase disagrees with the requested phase");
    invalid = true;
  }
  for (const [key, expected] of [["GENERATION", options.generation], ["INTERVAL_MS", options.intervalMs]]) {
    if (expected !== undefined && meta[key] !== String(expected)) {
      reasons.push(`telemetry metadata ${key} disagrees with its stored expectation`);
      invalid = true;
    }
  }
  const generation = meta.GENERATION;
  const intervalMs = canonicalPositiveUint(meta.INTERVAL_MS, MAX_INTERVAL_MS);
  const expectedSegments = canonicalPositiveUint(meta.EXPECTED_SEGMENTS, TELEMETRY_MAX_SEGMENTS);
  if (expectedSegments !== null && rows.length !== expectedSegments) {
    reasons.push(`telemetry index contains ${rows.length} row(s), expected ${expectedSegments}`);
    if (meta.STATUS === "complete" || rows.length > expectedSegments) invalid = true;
  }

  const allowedNames = new Set();
  const segments = [];
  for (const row of rows) {
    const expectedLog = GENERATION_RE.test(generation ?? "") && row.segment !== null
      ? logRelative(phase, generation, row.segment)
      : null;
    const expectedBoundary = GENERATION_RE.test(generation ?? "") && row.segment !== null
      ? boundaryRelative(phase, generation, row.segment)
      : null;
    if (row.log !== expectedLog || row.boundary !== expectedBoundary) {
      reasons.push(`telemetry segment ${row.segment} contains a noncanonical or traversing path`);
      invalid = true;
      continue;
    }
    allowedNames.add(path.basename(expectedLog));
    allowedNames.add(path.basename(expectedBoundary));
    const log = readTarget(root, expectedLog.split("/"), TELEMETRY_LOG_MAX_BYTES, `telemetry segment ${row.segment} log`);
    const boundary = readTarget(root, expectedBoundary.split("/"), TELEMETRY_BOUNDARY_MAX_BYTES, `telemetry segment ${row.segment} boundary`);
    if (log.state === "unsafe" || boundary.state === "unsafe") {
      reasons.push(...log.reasons, ...boundary.reasons);
      invalid = true;
      continue;
    }
    if (log.state === "missing" || boundary.state === "missing") {
      reasons.push(`telemetry segment ${row.segment} file or boundary is missing`);
      continue;
    }
    if (!bindingMatches(row, "log", log.bytes) || !bindingMatches(row, "boundary", boundary.bytes)) {
      reasons.push(`telemetry segment ${row.segment} does not match its exact index binding`);
      invalid = true;
      continue;
    }
    const parsedLog = parseTelemetryNdjson(log.bytes, {
      intervalMs,
      requireProductionRoots: options.requireProductionRoots === true,
    });
    const parsedBoundary = parseTelemetryBoundary(boundary.bytes, {
      phase, generation, segment: row.segment, tag: row.tag,
    });
    if (parsedLog.status === "invalid" || parsedBoundary.status === "invalid") {
      reasons.push(...parsedLog.reasons, ...parsedBoundary.reasons);
      invalid = true;
      continue;
    }
    const coverage = assessTelemetryBoundaryCoverage(parsedLog, parsedBoundary);
    const actualStatus = parsedLog.status === "complete" && coverage.status === "complete" ? "complete" : "incomplete";
    if (row.samples !== parsedLog.samples.length || row.status !== actualStatus) {
      reasons.push(`telemetry segment ${row.segment} status or sample count disagrees with its index`);
      invalid = true;
      continue;
    }
    segments.push({
      segment: row.segment,
      tag: row.tag,
      status: actualStatus,
      logStatus: parsedLog.status,
      coverage,
      association: telemetryTimingAssociation(parsedLog),
      summary: parsedLog.summary,
      boundary: parsedBoundary.boundary,
      boundaryParsed: parsedBoundary,
    });
  }

  const phaseDir = path.join(root, "telemetry", phase);
  if (inspectDirectory(phaseDir, "telemetry phase directory", false).state === "regular") {
    const scan = scanPhaseDirectory(phaseDir, allowedNames);
    if (scan.reasons.length > 0) {
      reasons.push(...scan.reasons);
      invalid = true;
    }
  }
  const markerRequired = options.requireParentMarker !== false;
  const marker = readTarget(root, ["state", `phase-${phase}.done`], TELEMETRY_META_MAX_BYTES, `parent ${phase} phase marker`);
  if (marker.state === "unsafe") {
    reasons.push(...marker.reasons);
    invalid = true;
  } else if (marker.state === "regular" && marker.bytes.length !== 0) {
    reasons.push(`parent ${phase} phase marker must be empty`);
    invalid = true;
  } else if (markerRequired && marker.state === "missing") reasons.push(`parent ${phase} phase marker is missing`);

  const allSegmentsComplete = expectedSegments !== null && segments.length === expectedSegments &&
    segments.every(({ status }) => status === "complete");
  if (meta.STATUS === "complete" && !allSegmentsComplete) {
    reasons.push("complete telemetry metadata is inconsistent with segment evidence");
    if (segments.length === rows.length) invalid = true;
  }
  if (meta.STATUS === "incomplete") {
    reasons.push("telemetry metadata is marked incomplete");
    if (allSegmentsComplete) {
      reasons.push("incomplete telemetry metadata is inconsistent with complete segments");
      invalid = true;
    }
  }
  const complete = !invalid && meta.STATUS === "complete" && allSegmentsComplete &&
    (!markerRequired || marker.state === "regular") && reasons.length === 0;
  const boundaryComplete = segments.length > 0 && segments.every(({ coverage }) => coverage.status === "complete");
  return {
    status: complete ? "complete" : invalid ? "invalid" : "incomplete",
    reasons: unique(reasons),
    authoritative: false,
    meta,
    rows,
    segments,
    noTurbo: phaseNoTurboSummary(segments),
    boundaryCoverage: {
      status: boundaryComplete ? "complete" : "incomplete",
      coveredSegments: segments.filter(({ coverage }) => coverage.status === "complete").length,
      totalSegments: expectedSegments,
    },
  };
}

export function validateFreshTelemetryTargets(bundleDir, options = {}) {
  const phase = options.phase;
  const reasons = [];
  if (!validatePhase(phase)) return ["telemetry phase is invalid"];
  const root = path.resolve(bundleDir);
  for (const [directory, label, required] of [
    [root, "bundle root", true],
    [path.join(root, "results"), "results directory", true],
    [path.join(root, "state"), "state directory", true],
    [path.join(root, "telemetry"), "telemetry directory", false],
  ]) {
    const state = inspectDirectory(directory, label, required);
    if (state.state === "unsafe") reasons.push(state.reason);
  }
  for (const components of [indexPath(phase), metaPath(phase)]) {
    if (targetExists(path.join(root, ...components))) reasons.push(`${components.join("/")} already exists or is unsafe`);
  }
  const phaseDir = path.join(root, "telemetry", phase);
  const phaseState = inspectDirectory(phaseDir, "telemetry phase directory", false);
  if (phaseState.state === "unsafe") reasons.push(phaseState.reason);
  else if (phaseState.state === "regular") {
    const scan = scanPhaseDirectory(phaseDir, new Set());
    if (scan.names.length > 0) reasons.push("telemetry phase directory contains existing evidence");
    reasons.push(...scan.reasons);
  }
  if (options.segments !== undefined) {
    try { normalizeSegments(options.segments); } catch (error) { reasons.push(error.message); }
  }
  if (options.generation !== undefined && !GENERATION_RE.test(options.generation)) reasons.push("telemetry generation is invalid");
  if (options.intervalMs !== undefined) {
    const interval = canonicalPositiveUint(options.intervalMs, MAX_INTERVAL_MS);
    if (interval === null || interval < MIN_INTERVAL_MS) reasons.push("telemetry interval is invalid");
  }
  return unique(reasons);
}

export const checkFreshTelemetryTargets = validateFreshTelemetryTargets;
