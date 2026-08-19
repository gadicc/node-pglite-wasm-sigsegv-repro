#!/usr/bin/env node

// Deterministic plans and durable, resumable commit units for exact-pinning
// diagnostic protocols. This module never changes CPU settings. Child launch
// is injectable; the production default is the read-only-boundary runner in
// pinned-runner.mjs.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_CPU_ID,
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  DEFAULT_STDERR_BYTES,
  PINNED_RUNNER_VERSION,
  PINNED_RUNNER_V2_VERSION,
  buildBalancedGroupOrders,
  buildConcurrentLaunchOrders,
  buildIsolatedOrders,
  compressCpuList,
  expandCpuList,
  runPinnedChild,
} from "./pinned-runner.mjs";
import {
  PINNED_CONCURRENT_PLAN_HEADER,
  PINNED_CONCURRENT_RESULTS_HEADER,
  PINNED_CONCURRENT_V2_RESULTS_HEADER,
  pinnedConcurrentFileBinding,
  serializePinnedConcurrentGroups,
  serializePinnedConcurrentPlan,
  serializePinnedConcurrentResults,
} from "./pinned-concurrent-evidence.mjs";

export const PINNED_PROTOCOL_STATE_VERSION = 1;
export const PINNED_PROTOCOL_STATE_V2_VERSION = 2;
export const ISOLATED_PLAN_HEADER = "ordinal\tround\tposition\tcpu";
export const ISOLATED_V2_RESULTS_HEADER =
  "ordinal\tround\tposition\tcpu\toutcome\texit_code\tsignal\telapsed_sec\tstderr_sha256\tstderr_bytes";
export const DEFAULT_STATE_FILE_MAX_BYTES = 256 * 1024;
export const MAX_WAVE_STATE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BOUNDARIES_BYTES = 512 * 1024 * 1024;
export const MAX_STATE_DIRECTORY_ENTRIES = MAX_SCHEDULE_ENTRIES + 16_384;

const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const GROUP_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const ISOLATED_V2_OUTCOMES = new Set(["pass", "sigsegv", "other-workload-failure"]);
const MAX_PATH_BYTES = 4_096;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_CONTEXTS = 256;
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const EXACT_CPU_STATE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const SCHEMA3_BUNDLE_STATE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const BASELINE_PHASE_STATE_FILE_MAX_BYTES = 1024 * 1024;
const BASELINE_WAVE_STATE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const GROUP_PHASE_STATE_FILE_MAX_BYTES = 8 * 1024 * 1024;
const GROUP_WAVE_STATE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const PROTOCOL_MARKER = Symbol("pinnedProtocolPlan");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class PinnedProtocolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedProtocolInputError";
  }
}

export class PinnedProtocolStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedProtocolStateError";
  }
}

function validateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PinnedProtocolInputError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validateString(value, label, maxBytes = MAX_STRING_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > maxBytes) {
    throw new PinnedProtocolInputError(`${label} must be a non-empty bounded NUL-free string`);
  }
  return value;
}

function validateGeneration(value) {
  if (typeof value !== "string" || !GENERATION_RE.test(value)) {
    throw new PinnedProtocolInputError("generation must be exactly 32 lowercase hexadecimal characters");
  }
  return value;
}

function validateAbsolutePath(value, label) {
  validateString(value, label, MAX_PATH_BYTES);
  if (!path.isAbsolute(value)) throw new PinnedProtocolInputError(`${label} must be absolute`);
  return path.normalize(value);
}

function exactBytes(value, label = "content") {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new PinnedProtocolInputError(`${label} must be a string, Buffer, or Uint8Array`);
}

export function sha256ProtocolBytes(value) {
  return createHash("sha256").update(exactBytes(value)).digest("hex");
}

export function protocolFileBinding(value, rowCount) {
  const bytes = exactBytes(value);
  validateInteger(rowCount, "row count", 0, MAX_SCHEDULE_ENTRIES);
  return Object.freeze({
    sha256: sha256ProtocolBytes(bytes),
    bytes: bytes.length,
    rowCount,
  });
}

function canonicalize(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (depth > 32) throw new PinnedProtocolInputError("canonical JSON nesting exceeds 32 levels");
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEDULE_ENTRIES * 16) {
    throw new PinnedProtocolInputError("canonical JSON exceeds the node-count limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > MAX_WAVE_STATE_FILE_BYTES) {
      throw new PinnedProtocolInputError("canonical JSON exceeds the string-byte limit");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PinnedProtocolInputError("canonical JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SCHEDULE_ENTRIES) {
      throw new PinnedProtocolInputError("canonical JSON array exceeds the entry limit");
    }
    return value.map((entry) => canonicalize(entry, depth + 1, budget));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new PinnedProtocolInputError("canonical JSON contains a non-JSON value");
      }
      result[key] = canonicalize(entry, depth + 1, budget);
    }
    return result;
  }
  throw new PinnedProtocolInputError("canonical JSON contains a non-plain value");
}

export function canonicalProtocolJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalProtocolJsonLine(value) {
  return Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
}

function freezeRecords(records) {
  for (const record of records) Object.freeze(record);
  return Object.freeze(records);
}

function validateCanonicalCpuArray(cpus, label = "CPUs") {
  if (!Array.isArray(cpus) || cpus.length === 0 || cpus.length > MAX_CPU_ID + 1) {
    throw new PinnedProtocolInputError(`${label} must be a non-empty canonical CPU array`);
  }
  const copy = cpus.map((cpu, index) => validateInteger(cpu, `${label}[${index}]`, 0, MAX_CPU_ID));
  for (let index = 1; index < copy.length; index += 1) {
    if (copy[index] <= copy[index - 1]) {
      throw new PinnedProtocolInputError(`${label} must be strictly increasing with no duplicates`);
    }
  }
  return copy;
}

function validateRoundsAndSeed(rounds, seed) {
  validateInteger(rounds, "rounds", 1, MAX_SCHEDULE_ENTRIES);
  validateInteger(seed, "seed", 0, MAX_SEED);
}

function makePlan(protocol, records, tsv, extra = {}) {
  const binding = protocolFileBinding(tsv, records.length);
  const plan = {
    protocol,
    records: freezeRecords(records),
    tsv,
    planSha: binding.sha256,
    binding,
    ...extra,
  };
  Object.defineProperty(plan, PROTOCOL_MARKER, { value: true });
  return Object.freeze(plan);
}

function isolatedTsv(records) {
  return `${ISOLATED_PLAN_HEADER}\n${records.map((record) =>
    `${record.ordinal}\t${record.round}\t${record.position}\t${record.cpu}`).join("\n")}\n`;
}

export function buildIsolatedPlan({ cpus, rounds, seed }) {
  const canonicalCpus = validateCanonicalCpuArray(cpus);
  validateRoundsAndSeed(rounds, seed);
  if (canonicalCpus.length * rounds > MAX_SCHEDULE_ENTRIES) {
    throw new PinnedProtocolInputError(`isolated plan exceeds ${MAX_SCHEDULE_ENTRIES} records`);
  }
  const orders = buildIsolatedOrders(canonicalCpus, rounds, seed);
  let ordinal = 0;
  const records = orders.flatMap((order, roundIndex) => order.map((cpu, positionIndex) => ({
    ordinal: ++ordinal,
    round: roundIndex + 1,
    position: positionIndex + 1,
    cpu,
  })));
  return makePlan("isolated", records, isolatedTsv(records), {
    cpus: Object.freeze(canonicalCpus),
    rounds,
    seed,
  });
}

function canonicalCluster(value) {
  const cluster = Number.isSafeInteger(value) && value >= 0 && value <= MAX_CPU_ID
    ? String(value)
    : value;
  validateString(cluster, "context cluster", 1024);
  if (cluster === "-" || cluster === "unknown" || /^(0|[1-9][0-9]*)$/.test(cluster)) {
    if (/^[0-9]+$/.test(cluster) && Number(cluster) > MAX_CPU_ID) {
      throw new PinnedProtocolInputError("numeric context cluster is out of range");
    }
    return cluster;
  }
  if (cluster.startsWith("l2:")) {
    const cpus = expandCpuList(cluster.slice(3));
    if (compressCpuList(cpus) === cluster.slice(3)) return cluster;
  }
  if (/^topo:(?:unknown|0|[1-9][0-9]*):(?:unknown|0|[1-9][0-9]*)$/.test(cluster)) {
    const [, packageId, clusterId] = cluster.split(":");
    if ((packageId === "unknown" || Number(packageId) <= MAX_CPU_ID) &&
        (clusterId === "unknown" || Number(clusterId) <= MAX_CPU_ID)) return cluster;
  }
  throw new PinnedProtocolInputError("context cluster is not canonical");
}

function normalizeContexts(contexts) {
  if (!Array.isArray(contexts) || contexts.length === 0 || contexts.length > MAX_CONTEXTS) {
    throw new PinnedProtocolInputError(`contexts must contain 1-${MAX_CONTEXTS} entries`);
  }
  const names = new Set();
  return contexts.map((context, index) => {
    if (context === null || typeof context !== "object" || Array.isArray(context)) {
      throw new PinnedProtocolInputError(`contexts[${index}] must be an object`);
    }
    const keys = Object.keys(context).sort();
    const expected = ["cluster", "controllerCpu", "cpus", "group", "kind"];
    if (keys.join("\n") !== expected.join("\n")) {
      throw new PinnedProtocolInputError(`contexts[${index}] must contain exactly group, kind, cpus, cluster, controllerCpu`);
    }
    const group = validateString(context.group, `contexts[${index}].group`, 64);
    const kind = validateString(context.kind, `contexts[${index}].kind`, 32);
    if (!GROUP_RE.test(group)) throw new PinnedProtocolInputError(`contexts[${index}].group is invalid`);
    if (!KIND_RE.test(kind)) throw new PinnedProtocolInputError(`contexts[${index}].kind is invalid`);
    if (names.has(group)) throw new PinnedProtocolInputError(`duplicate context group: ${group}`);
    names.add(group);
    const selectedCpus = validateCanonicalCpuArray(context.cpus, `contexts[${index}].cpus`);
    const controllerCpu = validateInteger(
      context.controllerCpu,
      `contexts[${index}].controllerCpu`,
      0,
      MAX_CPU_ID,
    );
    if (selectedCpus.includes(controllerCpu)) {
      throw new PinnedProtocolInputError(`context ${group} places its controller inside the active CPU set`);
    }
    return Object.freeze({
      group,
      kind,
      cpus: Object.freeze(selectedCpus),
      cluster: canonicalCluster(context.cluster),
      controllerCpu,
    });
  });
}

export function deriveConcurrentContextSeed(seed, context) {
  validateInteger(seed, "seed", 0, MAX_SEED);
  const [normalized] = normalizeContexts([context]);
  const identity = [
    "pinned-concurrent-launch-v1",
    String(seed),
    normalized.group,
    normalized.kind,
    normalized.cpus.join(","),
    normalized.cluster,
    String(normalized.controllerCpu),
  ].join("\0");
  return createHash("sha256").update(identity).digest().readUInt32BE(0);
}

function concurrentEvidenceRows(records) {
  return records.map((record) => ({
    ordinal: record.ordinal,
    round: record.round,
    group_position: record.groupPosition,
    group: record.group,
    controller_cpu: record.controllerCpu,
    launch_position: record.launchPosition,
    cpu: record.cpu,
  }));
}

export function buildPinnedConcurrentPlan({ contexts, rounds, seed }) {
  const normalizedContexts = normalizeContexts(contexts);
  validateRoundsAndSeed(rounds, seed);
  const recordsPerRound = normalizedContexts.reduce((sum, context) => sum + context.cpus.length, 0);
  if (recordsPerRound * rounds > MAX_SCHEDULE_ENTRIES) {
    throw new PinnedProtocolInputError(`pinned-concurrent plan exceeds ${MAX_SCHEDULE_ENTRIES} records`);
  }
  const groupOrders = buildBalancedGroupOrders(normalizedContexts.length, rounds, seed);
  const launchOrders = new Map(normalizedContexts.map((context) => [
    context.group,
    buildConcurrentLaunchOrders(
      context.cpus,
      rounds,
      deriveConcurrentContextSeed(seed, context),
    ),
  ]));
  const records = [];
  let ordinal = 0;
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    for (let groupIndex = 0; groupIndex < groupOrders[roundIndex].length; groupIndex += 1) {
      const context = normalizedContexts[groupOrders[roundIndex][groupIndex]];
      const launches = launchOrders.get(context.group)[roundIndex];
      for (let launchIndex = 0; launchIndex < launches.length; launchIndex += 1) {
        records.push({
          ordinal: ++ordinal,
          round: roundIndex + 1,
          groupPosition: groupIndex + 1,
          group: context.group,
          controllerCpu: context.controllerCpu,
          launchPosition: launchIndex + 1,
          cpu: launches[launchIndex],
        });
      }
    }
  }
  const groupsRows = normalizedContexts.map((context) => Object.freeze({
    group: context.group,
    kind: context.kind,
    cpus: compressCpuList(context.cpus),
    cluster: context.cluster,
    controller_cpu: context.controllerCpu,
    rounds,
  }));
  const groupsTsv = serializePinnedConcurrentGroups(groupsRows, { roundsPerContext: rounds });
  const tsv = serializePinnedConcurrentPlan(
    concurrentEvidenceRows(records),
    groupsRows,
    { roundsPerContext: rounds },
  );
  if (!tsv.startsWith(`${PINNED_CONCURRENT_PLAN_HEADER}\n`)) {
    throw new Error("pinned-concurrent evidence serializer returned an unexpected header");
  }
  const groupsBinding = pinnedConcurrentFileBinding(groupsTsv, groupsRows.length);
  return makePlan("concurrent", records, tsv, {
    contexts: Object.freeze(normalizedContexts),
    groupsRows: Object.freeze(groupsRows),
    groupsTsv,
    groupsBinding: Object.freeze(groupsBinding),
    rounds,
    seed,
  });
}

function assertPlan(plan, protocol) {
  if (plan?.[PROTOCOL_MARKER] !== true || plan.protocol !== protocol ||
      !Array.isArray(plan.records) || typeof plan.tsv !== "string" ||
      !DIGEST_RE.test(plan.planSha ?? "") || sha256ProtocolBytes(plan.tsv) !== plan.planSha) {
    throw new PinnedProtocolInputError(`${protocol} plan must come from its canonical builder`);
  }
  return plan;
}

function validateStateFileName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255 ||
      name.includes("\0") || name.includes("/") || name === "." || name === "..") {
    throw new PinnedProtocolStateError("state adapter returned an unsafe file name");
  }
  return name;
}

function stableStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

function validateStateDirectory(directory) {
  const stat = lstatSync(directory, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
    throw new PinnedProtocolStateError("state directory must be a real directory owned by the current user");
  }
  return stat;
}

function listStableDirectory(directory) {
  const before = validateStateDirectory(directory);
  const names = [];
  let opened;
  try {
    opened = opendirSync(directory);
    while (true) {
      const entry = opened.readSync();
      if (entry === null) break;
      if (names.length >= MAX_STATE_DIRECTORY_ENTRIES) {
        throw new PinnedProtocolStateError("state directory exceeds the entry-count limit");
      }
      names.push(validateStateFileName(entry.name));
    }
  } finally {
    opened?.closeSync();
  }
  const after = lstatSync(directory, { bigint: true });
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
      before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) {
    throw new PinnedProtocolStateError("state directory changed while it was listed");
  }
  return names;
}

function readStableStateFile(directory, name, maxBytes) {
  validateStateFileName(name);
  const file = path.join(directory, name);
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  let before;
  let fd;
  try {
    before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) ||
        (uid !== null && before.uid !== uid) || (before.mode & 0o077n) !== 0n) {
      throw new PinnedProtocolStateError(`${name} is not a safe bounded private state file`);
    }
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!stableStat(before, opened) || opened.nlink !== 1n) {
      throw new PinnedProtocolStateError(`${name} changed while it was opened`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new PinnedProtocolStateError(`${name} was not read completely`);
    const afterFd = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(file, { bigint: true });
    if (!stableStat(opened, afterFd) || !stableStat(afterFd, afterPath) || afterFd.nlink !== 1n) {
      throw new PinnedProtocolStateError(`${name} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof PinnedProtocolStateError) throw error;
    throw new PinnedProtocolStateError(`${name} could not be read safely`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// The exact-CPU store reuses this proven no-clobber adapter in its own private
// directory; legacy protocol readers still select only their own final names.
const STATE_COMMIT_TEMP_RE =
  /^\.(isolated-[0-9]{9}\.json|concurrent-[0-9]{9}-[a-z][a-z0-9_-]{0,63}\.json|exact-cpu-phase\.json|exact-cpu-attempt-[0-9]{9}\.json|baseline-phase\.json|baseline-wave-[0-9]{9}\.json|group-phase\.json|group-wave-[0-9]{9}\.json|fault-affinity-bundle\.json)\.([1-9][0-9]*)\.([a-f0-9]{16})\.(writing|ready)\.tmp$/;

function processIsLive(pidText) {
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new PinnedProtocolStateError("state commit temporary file has an invalid writer PID");
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw new PinnedProtocolStateError("state commit writer identity could not be checked");
  }
}

function recoverInterruptedStateCommits(directory) {
  const names = listStableDirectory(directory);
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  const actions = [];
  const finalNames = new Set();

  for (const name of names) {
    if (!name.startsWith(".isolated-") && !name.startsWith(".concurrent-") &&
        !name.startsWith(".exact-cpu-") &&
        !name.startsWith(".baseline-") &&
        !name.startsWith(".group-") &&
        !name.startsWith(".fault-affinity-bundle.json.")) continue;
    const match = name.match(STATE_COMMIT_TEMP_RE);
    if (match === null) continue;
    const [, finalName, pid, , stage] = match;
    if (finalNames.has(finalName)) {
      throw new PinnedProtocolStateError("state contains multiple commit temporary files for one record");
    }
    finalNames.add(finalName);
    if (processIsLive(pid)) {
      throw new PinnedProtocolStateError("state contains a commit temporary file owned by a live writer");
    }

    const temporaryPath = path.join(directory, name);
    const finalPath = path.join(directory, finalName);
    const maximumBytes = finalName.startsWith("concurrent-")
      ? MAX_WAVE_STATE_FILE_BYTES
      : finalName.startsWith("exact-cpu-")
        ? EXACT_CPU_STATE_FILE_MAX_BYTES
        : finalName === "baseline-phase.json"
          ? BASELINE_PHASE_STATE_FILE_MAX_BYTES
          : finalName.startsWith("baseline-wave-")
            ? BASELINE_WAVE_STATE_FILE_MAX_BYTES
            : finalName === "group-phase.json"
              ? GROUP_PHASE_STATE_FILE_MAX_BYTES
              : finalName.startsWith("group-wave-")
                ? GROUP_WAVE_STATE_FILE_MAX_BYTES
                : finalName === "fault-affinity-bundle.json"
                  ? SCHEMA3_BUNDLE_STATE_FILE_MAX_BYTES
                  : DEFAULT_STATE_FILE_MAX_BYTES;
    let temporaryStat;
    try {
      temporaryStat = lstatSync(temporaryPath, { bigint: true });
    } catch {
      throw new PinnedProtocolStateError("state commit temporary file changed during recovery");
    }
    if (!temporaryStat.isFile() ||
        (temporaryStat.nlink !== 1n && temporaryStat.nlink !== 2n) ||
        temporaryStat.size > BigInt(maximumBytes) ||
        (uid !== null && temporaryStat.uid !== uid) ||
        (temporaryStat.mode & 0o077n) !== 0n) {
      throw new PinnedProtocolStateError("state commit temporary file is not safe and private");
    }

    let finalStat = null;
    try {
      finalStat = lstatSync(finalPath, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new PinnedProtocolStateError("state commit destination could not be inspected");
      }
    }
    if (finalStat === null) {
      if (temporaryStat.nlink !== 1n) {
        throw new PinnedProtocolStateError("unpublished state commit temporary file has extra links");
      }
    } else if (stage !== "ready" || !finalStat.isFile() ||
        temporaryStat.nlink !== 2n || finalStat.nlink !== 2n ||
        !stableStat(temporaryStat, finalStat) ||
        (uid !== null && finalStat.uid !== uid) ||
        (finalStat.mode & 0o077n) !== 0n) {
      throw new PinnedProtocolStateError("published state commit temporary file is inconsistent");
    }
    actions.push(temporaryPath);
  }

  if (actions.length === 0) return;
  try {
    for (const temporaryPath of actions) unlinkSync(temporaryPath);
    fsyncDirectory(directory);
  } catch {
    throw new PinnedProtocolStateError("interrupted state commit could not be reconciled durably");
  }
}

function commitStateFile(directory, name, content) {
  validateStateDirectory(directory);
  validateStateFileName(name);
  const bytes = exactBytes(content, "state content");
  const finalPath = path.join(directory, name);
  const temporaryStem = `.${name}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const writingPath = path.join(directory, `${temporaryStem}.writing.tmp`);
  const readyPath = path.join(directory, `${temporaryStem}.ready.tmp`);
  let fd;
  let linked = false;
  let renamed = false;
  try {
    fd = openSync(
      writingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(writingPath, readyPath);
    renamed = true;
    // Node does not expose renameat2(RENAME_NOREPLACE). A same-directory hard
    // link gives an atomic no-clobber publication point; unlinking the private
    // temp afterward leaves the committed file single-linked. If the writer
    // crashes in this window, the next exclusive reader verifies the exact
    // hard-link relationship before retaining the commit and removing temp.
    linkSync(readyPath, finalPath);
    linked = true;
    unlinkSync(readyPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain primary error */ }
    }
    if (!linked) {
      try { unlinkSync(renamed ? readyPath : writingPath); } catch { /* absent or unsafe */ }
    }
    if (error?.code === "EEXIST") {
      throw new PinnedProtocolStateError(`${name} already exists; state commits never overwrite`);
    }
    if (error instanceof PinnedProtocolStateError) throw error;
    throw new PinnedProtocolStateError(`${name} could not be committed durably`);
  }
}

export function createFileStateAdapter(stateDirectory) {
  const directory = validateAbsolutePath(stateDirectory, "state directory");
  validateStateDirectory(directory);
  return Object.freeze({
    list: () => {
      recoverInterruptedStateCommits(directory);
      return listStableDirectory(directory);
    },
    read: (name, maxBytes) => readStableStateFile(directory, name, maxBytes),
    commit: (name, bytes) => commitStateFile(directory, name, bytes),
  });
}

function resolveStateAdapter(options) {
  if (options.stateAdapter !== undefined && options.stateDir !== undefined) {
    throw new PinnedProtocolInputError("choose stateAdapter or stateDir, not both");
  }
  const adapter = options.stateAdapter ??
    (options.stateDir === undefined ? null : createFileStateAdapter(options.stateDir));
  if (adapter === null || typeof adapter !== "object" ||
      typeof adapter.list !== "function" || typeof adapter.read !== "function" ||
      typeof adapter.commit !== "function") {
    throw new PinnedProtocolInputError("a stateAdapter or stateDir is required");
  }
  return adapter;
}

async function adapterList(adapter) {
  const names = await adapter.list();
  if (!Array.isArray(names) || names.length > MAX_STATE_DIRECTORY_ENTRIES) {
    throw new PinnedProtocolStateError("state adapter returned an invalid or oversized listing");
  }
  return names.map(validateStateFileName);
}

async function adapterRead(adapter, name, maxBytes) {
  const bytes = exactBytes(await adapter.read(name, maxBytes), `${name} content`);
  if (bytes.length > maxBytes) throw new PinnedProtocolStateError(`${name} exceeds its byte limit`);
  return bytes;
}

async function adapterCommit(adapter, name, bytes) {
  await adapter.commit(name, exactBytes(bytes));
}

function decodeCanonicalState(bytes, maxBytes, label) {
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new PinnedProtocolStateError(`${label} is empty or exceeds its byte limit`);
  }
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new PinnedProtocolStateError(`${label} is not valid UTF-8`);
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    throw new PinnedProtocolStateError(`${label} is not canonical newline-delimited JSON`);
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    throw new PinnedProtocolStateError(`${label} is not valid JSON`);
  }
  let canonical;
  try {
    canonical = canonicalProtocolJsonLine(value);
  } catch {
    throw new PinnedProtocolStateError(`${label} exceeds canonical JSON bounds`);
  }
  if (!bytes.equals(canonical)) throw new PinnedProtocolStateError(`${label} is not canonical JSON`);
  return value;
}

function exactObjectKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new PinnedProtocolStateError(`${label} does not contain exactly the canonical fields`);
  }
  return value;
}

function sameRecord(left, right) {
  return canonicalProtocolJson(left) === canonicalProtocolJson(right);
}

function isolatedStateName(ordinal) {
  return `isolated-${String(ordinal).padStart(9, "0")}.json`;
}

function concurrentStateName(ordinal, group) {
  return `concurrent-${String(ordinal).padStart(9, "0")}-${group}.json`;
}

function validateDecimal(value, label) {
  if (typeof value !== "string" || value.length > 32 || !DECIMAL_RE.test(value)) {
    throw new PinnedProtocolStateError(`${label} must be a bounded canonical decimal string`);
  }
  return BigInt(value);
}

function validateStateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PinnedProtocolStateError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizeTiming(value) {
  exactObjectKeys(value, [
    "startEpochMs",
    "endEpochMs",
    "startMonotonicNs",
    "endMonotonicNs",
    "durationNs",
    "durationMs",
    "elapsedSec",
  ], "child timing");
  validateStateInteger(value.startEpochMs, "timing.startEpochMs", 0, Number.MAX_SAFE_INTEGER);
  validateStateInteger(value.endEpochMs, "timing.endEpochMs", 0, Number.MAX_SAFE_INTEGER);
  const start = validateDecimal(value.startMonotonicNs, "timing.startMonotonicNs");
  const end = validateDecimal(value.endMonotonicNs, "timing.endMonotonicNs");
  const duration = validateDecimal(value.durationNs, "timing.durationNs");
  if (end < start || end - start !== duration) {
    throw new PinnedProtocolStateError("child monotonic timing does not reconcile");
  }
  const expectedDurationMs = Number(duration) / 1_000_000;
  if (!Number.isFinite(value.durationMs) || value.durationMs !== expectedDurationMs) {
    throw new PinnedProtocolStateError("child durationMs does not reconcile");
  }
  const elapsedSec = Number(duration / 1_000_000_000n);
  if (!Number.isSafeInteger(elapsedSec) || value.elapsedSec !== elapsedSec) {
    throw new PinnedProtocolStateError("child elapsedSec does not reconcile");
  }
  return Object.freeze({
    startEpochMs: value.startEpochMs,
    endEpochMs: value.endEpochMs,
    startMonotonicNs: value.startMonotonicNs,
    endMonotonicNs: value.endMonotonicNs,
    durationNs: value.durationNs,
    durationMs: value.durationMs,
    elapsedSec: value.elapsedSec,
  });
}

function normalizeNoTurboObservation(value, label) {
  exactObjectKeys(value, ["status", "value", "errorCode"], label);
  if (value.status === "observed" && (value.value === 0 || value.value === 1) &&
      value.errorCode === null) {
    return Object.freeze({ status: value.status, value: value.value, errorCode: null });
  }
  if ((value.status === "invalid" || value.status === "unavailable") &&
      value.value === null && typeof value.errorCode === "string" &&
      ERROR_CODE_RE.test(value.errorCode)) {
    return Object.freeze({ status: value.status, value: null, errorCode: value.errorCode });
  }
  throw new PinnedProtocolStateError(`${label} is not a canonical no_turbo observation`);
}

function normalizeNoTurbo(value) {
  exactObjectKeys(value, ["path", "start", "end"], "child noTurbo");
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\0") ||
      Buffer.byteLength(value.path) > MAX_PATH_BYTES) {
    throw new PinnedProtocolStateError("noTurbo.path must be a bounded NUL-free string");
  }
  return Object.freeze({
    path: value.path,
    start: normalizeNoTurboObservation(value.start, "noTurbo.start"),
    end: normalizeNoTurboObservation(value.end, "noTurbo.end"),
  });
}

function validateIsolatedRecord(value, label = "isolated record") {
  exactObjectKeys(value, ["ordinal", "round", "position", "cpu"], label);
  validateStateInteger(value.ordinal, `${label}.ordinal`, 1, MAX_SCHEDULE_ENTRIES);
  validateStateInteger(value.round, `${label}.round`, 1, MAX_SCHEDULE_ENTRIES);
  validateStateInteger(value.position, `${label}.position`, 1, MAX_CPU_ID + 1);
  validateStateInteger(value.cpu, `${label}.cpu`, 0, MAX_CPU_ID);
  return value;
}

function validateConcurrentRecord(value, label = "concurrent record") {
  exactObjectKeys(value, [
    "ordinal",
    "round",
    "groupPosition",
    "group",
    "controllerCpu",
    "launchPosition",
    "cpu",
  ], label);
  validateStateInteger(value.ordinal, `${label}.ordinal`, 1, MAX_SCHEDULE_ENTRIES);
  validateStateInteger(value.round, `${label}.round`, 1, MAX_SCHEDULE_ENTRIES);
  validateStateInteger(value.groupPosition, `${label}.groupPosition`, 1, MAX_CONTEXTS);
  if (typeof value.group !== "string" || !GROUP_RE.test(value.group)) {
    throw new PinnedProtocolStateError(`${label}.group is invalid`);
  }
  validateStateInteger(value.controllerCpu, `${label}.controllerCpu`, 0, MAX_CPU_ID);
  validateStateInteger(value.launchPosition, `${label}.launchPosition`, 1, MAX_CPU_ID + 1);
  validateStateInteger(value.cpu, `${label}.cpu`, 0, MAX_CPU_ID);
  if (value.cpu === value.controllerCpu) {
    throw new PinnedProtocolStateError(`${label} uses its controller as an active CPU`);
  }
  return value;
}

function stateObservation(record, child) {
  try {
    if (child === null || typeof child !== "object" || Array.isArray(child) ||
        child.version !== PINNED_RUNNER_VERSION || child.cpu !== record.cpu ||
        child.validOutcome !== true || child.invalidReason !== null || child.canceled !== false ||
        child.launchError !== null) {
      return { valid: false, reason: "invalid-child-result" };
    }
    let rc;
    if (child.outcome === "pass" && child.exitCode === 0 && child.signal === null) rc = 0;
    else if (child.outcome === "sigsegv" &&
        ((child.exitCode === 139 && child.signal === null) ||
         (child.exitCode === null && child.signal === "SIGSEGV"))) rc = 139;
    else return { valid: false, reason: "inconsistent-child-outcome" };
    return {
      valid: true,
      observation: Object.freeze({
        record,
        rc,
        timing: normalizeTiming(child.timing),
        noTurbo: normalizeNoTurbo(child.noTurbo),
      }),
    };
  } catch {
    return { valid: false, reason: "invalid-child-boundary" };
  }
}

function normalizeStderrEvidence(value, label = "child stderr evidence") {
  exactObjectKeys(value, [
    "sha256", "bytes", "excerptBase64", "excerptBytes", "truncated",
  ], label);
  if (typeof value.sha256 !== "string" || !DIGEST_RE.test(value.sha256)) {
    throw new PinnedProtocolStateError(`${label}.sha256 is invalid`);
  }
  const totalBytes = validateDecimal(value.bytes, `${label}.bytes`);
  validateStateInteger(value.excerptBytes, `${label}.excerptBytes`, 0, DEFAULT_STDERR_BYTES);
  if (typeof value.excerptBase64 !== "string" || typeof value.truncated !== "boolean") {
    throw new PinnedProtocolStateError(`${label} excerpt fields are invalid`);
  }
  let excerpt;
  try {
    excerpt = Buffer.from(value.excerptBase64, "base64");
  } catch {
    throw new PinnedProtocolStateError(`${label}.excerptBase64 is invalid`);
  }
  if (excerpt.toString("base64") !== value.excerptBase64 || excerpt.length !== value.excerptBytes ||
      totalBytes < BigInt(excerpt.length) || value.truncated !== (totalBytes > BigInt(excerpt.length)) ||
      (!value.truncated && sha256ProtocolBytes(excerpt) !== value.sha256)) {
    throw new PinnedProtocolStateError(`${label} does not reconcile`);
  }
  return Object.freeze({
    sha256: value.sha256,
    bytes: value.bytes,
    excerptBase64: value.excerptBase64,
    excerptBytes: value.excerptBytes,
    truncated: value.truncated,
  });
}

function validateV2ExitStatus(outcome, exitCode, signal, label) {
  const codeValid = exitCode === null ||
    (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  const signalValid = signal === null ||
    (typeof signal === "string" && KNOWN_SIGNALS.has(signal));
  if (!codeValid || !signalValid || (exitCode !== null && signal !== null) ||
      (exitCode === null && signal === null)) {
    throw new PinnedProtocolStateError(`${label} exit status is malformed`);
  }
  if (outcome === "pass" && !(exitCode === 0 && signal === null)) {
    throw new PinnedProtocolStateError(`${label} pass status is inconsistent`);
  }
  if (outcome === "sigsegv" &&
      !(exitCode === null && signal === "SIGSEGV")) {
    throw new PinnedProtocolStateError(`${label} SIGSEGV status is inconsistent`);
  }
  if (outcome === "other-workload-failure" &&
      (exitCode === 0 || signal === "SIGSEGV")) {
    throw new PinnedProtocolStateError(`${label} other-workload-failure status is inconsistent`);
  }
}

function stateObservationV2(record, child) {
  try {
    if (child === null || typeof child !== "object" || Array.isArray(child) ||
        child.version !== PINNED_RUNNER_V2_VERSION || child.cpu !== record.cpu ||
        child.validOutcome !== true || child.invalidReason !== null || child.canceled !== false ||
        child.launchError !== null || child.launchState !== "launched" ||
        !ISOLATED_V2_OUTCOMES.has(child.outcome)) {
      return { valid: false, reason: "operational-invalid" };
    }
    validateV2ExitStatus(child.outcome, child.exitCode, child.signal, "child");
    const noTurbo = normalizeNoTurbo(child.noTurbo);
    if (noTurbo.start.status !== "observed" || noTurbo.end.status !== "observed") {
      return { valid: false, reason: "operational-invalid" };
    }
    return {
      valid: true,
      observation: Object.freeze({
        record,
        outcome: child.outcome,
        exitCode: child.exitCode,
        signal: child.signal,
        stderr: normalizeStderrEvidence(child.stderrEvidence),
        timing: normalizeTiming(child.timing),
        noTurbo,
      }),
    };
  } catch {
    return { valid: false, reason: "operational-invalid" };
  }
}

function validateStoredObservation(value, recordValidator, label) {
  exactObjectKeys(value, ["record", "rc", "timing", "noTurbo"], label);
  recordValidator(value.record, `${label}.record`);
  if (value.rc !== 0 && value.rc !== 139) {
    throw new PinnedProtocolStateError(`${label}.rc is not a valid workload outcome`);
  }
  normalizeTiming(value.timing);
  normalizeNoTurbo(value.noTurbo);
  return value;
}

function validateStoredObservationV2(value, recordValidator, label) {
  exactObjectKeys(value, [
    "record", "outcome", "exitCode", "signal", "stderr", "timing", "noTurbo",
  ], label);
  recordValidator(value.record, `${label}.record`);
  if (!ISOLATED_V2_OUTCOMES.has(value.outcome)) {
    throw new PinnedProtocolStateError(`${label}.outcome is invalid`);
  }
  validateV2ExitStatus(value.outcome, value.exitCode, value.signal, label);
  normalizeStderrEvidence(value.stderr, `${label}.stderr`);
  normalizeTiming(value.timing);
  const noTurbo = normalizeNoTurbo(value.noTurbo);
  if (noTurbo.start.status !== "observed" || noTurbo.end.status !== "observed") {
    throw new PinnedProtocolStateError(`${label} has an unsafe no_turbo boundary`);
  }
  return value;
}

function validateIsolatedState(value, expectedPlan, generation, expectedRecord, label, stateVersion) {
  if (stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION) {
    exactObjectKeys(value, [
      "version", "protocol", "generation", "planSha", "record", "outcome", "exitCode",
      "signal", "stderr", "timing", "noTurbo",
    ], label);
    if (value.version !== PINNED_PROTOCOL_STATE_V2_VERSION || value.protocol !== "isolated-v2") {
      throw new PinnedProtocolStateError(`${label} has an unsupported state version or protocol`);
    }
    if (value.generation !== generation || value.planSha !== expectedPlan.planSha) {
      throw new PinnedProtocolStateError(`${label} does not match its generation and plan digest`);
    }
    validateStoredObservationV2({
      record: value.record,
      outcome: value.outcome,
      exitCode: value.exitCode,
      signal: value.signal,
      stderr: value.stderr,
      timing: value.timing,
      noTurbo: value.noTurbo,
    }, validateIsolatedRecord, label);
    if (!sameRecord(value.record, expectedRecord)) {
      throw new PinnedProtocolStateError(`${label} is not the exact next isolated plan record`);
    }
    return value;
  }
  exactObjectKeys(value, [
    "version", "protocol", "generation", "planSha", "record", "rc", "timing", "noTurbo",
  ], label);
  if (value.version !== PINNED_PROTOCOL_STATE_VERSION || value.protocol !== "isolated") {
    throw new PinnedProtocolStateError(`${label} has an unsupported state version or protocol`);
  }
  if (value.generation !== generation || value.planSha !== expectedPlan.planSha) {
    throw new PinnedProtocolStateError(`${label} does not match its generation and plan digest`);
  }
  validateStoredObservation({
    record: value.record,
    rc: value.rc,
    timing: value.timing,
    noTurbo: value.noTurbo,
  }, validateIsolatedRecord, label);
  if (!sameRecord(value.record, expectedRecord)) {
    throw new PinnedProtocolStateError(`${label} is not the exact next isolated plan record`);
  }
  return value;
}

function isolatedStateVersion(options) {
  const version = options?.stateVersion ?? PINNED_PROTOCOL_STATE_VERSION;
  if (version !== PINNED_PROTOCOL_STATE_VERSION && version !== PINNED_PROTOCOL_STATE_V2_VERSION) {
    throw new PinnedProtocolInputError("isolated state version must be 1 or 2");
  }
  return version;
}

function expectedConcurrentWave(plan, cursor) {
  const first = plan.records[cursor];
  if (first === undefined) return [];
  const rows = [];
  for (let index = cursor; index < plan.records.length; index += 1) {
    const record = plan.records[index];
    if (record.round !== first.round || record.group !== first.group) break;
    if (record.groupPosition !== first.groupPosition ||
        record.controllerCpu !== first.controllerCpu ||
        record.launchPosition !== rows.length + 1) {
      throw new PinnedProtocolStateError("concurrent plan contains a malformed wave");
    }
    rows.push(record);
  }
  return rows;
}

function validateConcurrentState(value, expectedPlan, generation, expectedRows, label) {
  exactObjectKeys(value, [
    "version", "protocol", "generation", "planSha", "wave", "observations",
  ], label);
  if (value.version !== PINNED_PROTOCOL_STATE_VERSION || value.protocol !== "concurrent") {
    throw new PinnedProtocolStateError(`${label} has an unsupported state version or protocol`);
  }
  if (value.generation !== generation || value.planSha !== expectedPlan.planSha) {
    throw new PinnedProtocolStateError(`${label} does not match its generation and plan digest`);
  }
  exactObjectKeys(value.wave, ["round", "group", "groupPosition", "controllerCpu"], `${label}.wave`);
  const first = expectedRows[0];
  if (value.wave.round !== first.round || value.wave.group !== first.group ||
      value.wave.groupPosition !== first.groupPosition ||
      value.wave.controllerCpu !== first.controllerCpu) {
    throw new PinnedProtocolStateError(`${label} wave identity does not match the plan`);
  }
  if (!Array.isArray(value.observations) || value.observations.length !== expectedRows.length) {
    throw new PinnedProtocolStateError(`${label} does not contain the whole planned wave`);
  }
  for (let index = 0; index < value.observations.length; index += 1) {
    const observation = validateStoredObservation(
      value.observations[index],
      validateConcurrentRecord,
      `${label}.observations[${index}]`,
    );
    if (!sameRecord(observation.record, expectedRows[index])) {
      throw new PinnedProtocolStateError(`${label} observation ${index + 1} is not the exact plan record`);
    }
  }
  return value;
}

function validateConcurrentStateV2(value, expectedPlan, generation, expectedRows, label) {
  exactObjectKeys(value, [
    "version", "protocol", "generation", "planSha", "wave", "observations",
  ], label);
  if (value.version !== PINNED_PROTOCOL_STATE_V2_VERSION || value.protocol !== "concurrent-v2") {
    throw new PinnedProtocolStateError(`${label} has an unsupported state version or protocol`);
  }
  if (value.generation !== generation || value.planSha !== expectedPlan.planSha) {
    throw new PinnedProtocolStateError(`${label} does not match its generation and plan digest`);
  }
  exactObjectKeys(value.wave, ["round", "group", "groupPosition", "controllerCpu"], `${label}.wave`);
  const first = expectedRows[0];
  if (value.wave.round !== first.round || value.wave.group !== first.group ||
      value.wave.groupPosition !== first.groupPosition ||
      value.wave.controllerCpu !== first.controllerCpu) {
    throw new PinnedProtocolStateError(`${label} wave identity does not match the plan`);
  }
  if (!Array.isArray(value.observations) || value.observations.length !== expectedRows.length) {
    throw new PinnedProtocolStateError(`${label} does not contain the whole planned wave`);
  }
  for (let index = 0; index < value.observations.length; index += 1) {
    const observation = validateStoredObservationV2(
      value.observations[index],
      validateConcurrentRecord,
      `${label}.observations[${index}]`,
    );
    if (!sameRecord(observation.record, expectedRows[index])) {
      throw new PinnedProtocolStateError(`${label} observation ${index + 1} is not the exact plan record`);
    }
  }
  return value;
}

function relevantStateNames(names, protocol) {
  const prefix = protocol === "isolated" ? "isolated-" : "concurrent-";
  const partialPrefix = `.${prefix}`;
  const pattern = protocol === "isolated"
    ? /^isolated-([0-9]{9})\.json$/
    : /^concurrent-([0-9]{9})-([a-z][a-z0-9_-]{0,63})\.json$/;
  const observed = new Set();
  const records = [];
  for (const name of names) {
    if (name.startsWith(partialPrefix)) {
      throw new PinnedProtocolStateError(`${protocol} state contains a partial temporary file`);
    }
    if (!name.startsWith(prefix)) continue;
    const match = name.match(pattern);
    if (!match) throw new PinnedProtocolStateError(`${protocol} state contains a malformed state file name`);
    if (observed.has(name)) throw new PinnedProtocolStateError(`${protocol} state listing contains a duplicate file`);
    observed.add(name);
    records.push({ name, ordinal: Number(match[1]), group: match[2] ?? null });
  }
  records.sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name));
  return records;
}

export async function readIsolatedProgress(options) {
  const plan = assertPlan(options?.plan, "isolated");
  const stateVersion = isolatedStateVersion(options);
  const generation = validateGeneration(options.generation);
  const adapter = resolveStateAdapter(options);
  const names = relevantStateNames(await adapterList(adapter), "isolated");
  const states = [];
  for (let cursor = 0; cursor < names.length; cursor += 1) {
    const expected = plan.records[cursor];
    if (expected === undefined || names[cursor].ordinal !== expected.ordinal ||
        names[cursor].name !== isolatedStateName(expected.ordinal)) {
      throw new PinnedProtocolStateError("isolated state is not an exact contiguous plan prefix");
    }
    const bytes = await adapterRead(adapter, names[cursor].name, DEFAULT_STATE_FILE_MAX_BYTES);
    const state = decodeCanonicalState(bytes, DEFAULT_STATE_FILE_MAX_BYTES, names[cursor].name);
    states.push(validateIsolatedState(
      state, plan, generation, expected, names[cursor].name, stateVersion,
    ));
  }
  return Object.freeze({
    protocol: "isolated",
    generation,
    planSha: plan.planSha,
    stateVersion,
    states: Object.freeze(states),
    committedRecords: states.length,
    nextRecord: plan.records[states.length] ?? null,
    complete: states.length === plan.records.length,
    _adapter: adapter,
  });
}

export async function readConcurrentProgress(options) {
  const plan = assertPlan(options?.plan, "concurrent");
  const stateVersion = isolatedStateVersion(options);
  const generation = validateGeneration(options.generation);
  const adapter = resolveStateAdapter(options);
  const names = relevantStateNames(await adapterList(adapter), "concurrent");
  const states = [];
  let cursor = 0;
  let legacyWaves = 0;
  let legacyRecords = 0;
  let observedV2 = false;
  for (const entry of names) {
    const expectedRows = expectedConcurrentWave(plan, cursor);
    const first = expectedRows[0];
    if (first === undefined || entry.ordinal !== first.ordinal || entry.group !== first.group ||
        entry.name !== concurrentStateName(first.ordinal, first.group)) {
      throw new PinnedProtocolStateError("concurrent state is not an exact contiguous whole-wave plan prefix");
    }
    const bytes = await adapterRead(adapter, entry.name, MAX_WAVE_STATE_FILE_BYTES);
    const state = decodeCanonicalState(bytes, MAX_WAVE_STATE_FILE_BYTES, entry.name);
    if (stateVersion === PINNED_PROTOCOL_STATE_VERSION) {
      states.push(validateConcurrentState(state, plan, generation, expectedRows, entry.name));
    } else if (state.version === PINNED_PROTOCOL_STATE_VERSION) {
      if (observedV2) {
        throw new PinnedProtocolStateError("concurrent V1 state may appear only as a contiguous legacy prefix");
      }
      states.push(validateConcurrentState(state, plan, generation, expectedRows, entry.name));
      legacyWaves += 1;
      legacyRecords += expectedRows.length;
    } else {
      observedV2 = true;
      states.push(validateConcurrentStateV2(state, plan, generation, expectedRows, entry.name));
    }
    cursor += expectedRows.length;
  }
  return Object.freeze({
    protocol: "concurrent",
    generation,
    planSha: plan.planSha,
    stateVersion,
    states: Object.freeze(states),
    committedWaves: states.length,
    committedRecords: cursor,
    legacyWaves,
    legacyRecords,
    nextWave: Object.freeze(expectedConcurrentWave(plan, cursor)),
    complete: cursor === plan.records.length,
    _adapter: adapter,
  });
}

function runnerErrorCode(error) {
  return typeof error?.code === "string" && ERROR_CODE_RE.test(error.code)
    ? error.code
    : "RUNNER_ERROR";
}

function validateRunner(runChild) {
  const runner = runChild ?? runPinnedChild;
  if (typeof runner !== "function") throw new PinnedProtocolInputError("runChild must be a function");
  return runner;
}

function validateAbortSignal(signal) {
  if (signal === undefined) return undefined;
  if (signal === null || typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" ||
      typeof signal.aborted !== "boolean") {
    throw new PinnedProtocolInputError("signal must be an AbortSignal");
  }
  return signal;
}

function childOptions(
  options,
  cpu,
  signal,
  runnerVersion = PINNED_RUNNER_VERSION,
  witnessCpu = undefined,
) {
  const supplied = options.childOptions ?? {};
  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new PinnedProtocolInputError("childOptions must be an object");
  }
  return {
    ...supplied,
    cpu,
    signal,
    runnerVersion,
    ...(runnerVersion === PINNED_RUNNER_V2_VERSION
      ? { stderrBytes: DEFAULT_STDERR_BYTES, ...(witnessCpu === undefined ? {} : { witnessCpu }) }
      : {}),
  };
}

function isolatedState(generation, plan, observation) {
  return {
    version: PINNED_PROTOCOL_STATE_VERSION,
    protocol: "isolated",
    generation,
    planSha: plan.planSha,
    record: observation.record,
    rc: observation.rc,
    timing: observation.timing,
    noTurbo: observation.noTurbo,
  };
}

function isolatedStateV2(generation, plan, observation) {
  return {
    version: PINNED_PROTOCOL_STATE_V2_VERSION,
    protocol: "isolated-v2",
    generation,
    planSha: plan.planSha,
    record: observation.record,
    outcome: observation.outcome,
    exitCode: observation.exitCode,
    signal: observation.signal,
    stderr: observation.stderr,
    timing: observation.timing,
    noTurbo: observation.noTurbo,
  };
}

function boundedOperationalAttempt(record, child, reason) {
  const attempt = {
    record,
    classification: "operational-invalid",
    reason,
    runnerVersion: Number.isSafeInteger(child?.version) ? child.version : null,
    outcome: typeof child?.outcome === "string" && child.outcome.length <= 64 ? child.outcome : null,
    exitCode: Number.isSafeInteger(child?.exitCode) ? child.exitCode : null,
    signal: typeof child?.signal === "string" && child.signal.length <= 64 ? child.signal : null,
    canceled: child?.canceled === true,
    launchState: typeof child?.launchState === "string" && child.launchState.length <= 64
      ? child.launchState
      : null,
    invalidReason: typeof child?.invalidReason === "string" && child.invalidReason.length <= 64
      ? child.invalidReason
      : null,
  };
  try { attempt.timing = normalizeTiming(child?.timing); } catch { attempt.timing = null; }
  try { attempt.noTurbo = normalizeNoTurbo(child?.noTurbo); } catch { attempt.noTurbo = null; }
  try {
    const stderr = normalizeStderrEvidence(child?.stderrEvidence);
    attempt.stderr = {
      sha256: stderr.sha256,
      bytes: stderr.bytes,
      excerptBytes: stderr.excerptBytes,
      truncated: stderr.truncated,
    };
  } catch {
    attempt.stderr = null;
  }
  if (child?.launchError !== null && typeof child?.launchError === "object") {
    const code = typeof child.launchError.code === "string" && ERROR_CODE_RE.test(child.launchError.code)
      ? child.launchError.code
      : "LAUNCH_ERROR";
    const message = typeof child.launchError.message === "string"
      ? child.launchError.message.slice(0, 4_096)
      : "launch error";
    attempt.launchError = { code, message };
  } else {
    attempt.launchError = null;
  }
  return Object.freeze(attempt);
}

export async function runIsolatedAttempt(options) {
  const plan = assertPlan(options?.plan, "isolated");
  const stateVersion = isolatedStateVersion(options);
  const runner = validateRunner(options.runChild);
  validateAbortSignal(options.signal);
  const progress = await readIsolatedProgress(options);
  if (progress.complete) {
    return Object.freeze({ committed: false, reason: "complete", record: null });
  }
  const record = progress.nextRecord;
  let child;
  try {
    child = await runner(childOptions(
      options,
      record.cpu,
      options.signal,
      stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
        ? PINNED_RUNNER_V2_VERSION
        : PINNED_RUNNER_VERSION,
    ));
  } catch (error) {
    const rejected = {
      committed: false,
      reason: stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
        ? "operational-invalid"
        : "runner-error",
      errorCode: runnerErrorCode(error),
      record,
    };
    if (stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION) {
      rejected.attempt = Object.freeze({
        record,
        classification: "operational-invalid",
        reason: "runner-error",
        errorCode: runnerErrorCode(error),
      });
    }
    return Object.freeze(rejected);
  }
  const normalized = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? stateObservationV2(record, child)
    : stateObservation(record, child);
  if (!normalized.valid) {
    const rejected = {
      committed: false,
      reason: normalized.reason,
      record,
    };
    if (stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION) {
      rejected.attempt = boundedOperationalAttempt(record, child, normalized.reason);
    }
    return Object.freeze(rejected);
  }
  const state = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? isolatedStateV2(progress.generation, plan, normalized.observation)
    : isolatedState(progress.generation, plan, normalized.observation);
  const bytes = canonicalProtocolJsonLine(state);
  if (bytes.length > DEFAULT_STATE_FILE_MAX_BYTES) {
    throw new PinnedProtocolStateError("isolated state exceeds its byte limit");
  }
  const stateName = isolatedStateName(record.ordinal);
  await adapterCommit(progress._adapter, stateName, bytes);
  return Object.freeze({
    committed: true,
    reason: "committed",
    stateName,
    state: Object.freeze(state),
    nextOrdinal: record.ordinal + 1,
  });
}

function concurrentState(generation, plan, observations) {
  const first = observations[0].record;
  return {
    version: PINNED_PROTOCOL_STATE_VERSION,
    protocol: "concurrent",
    generation,
    planSha: plan.planSha,
    wave: {
      round: first.round,
      group: first.group,
      groupPosition: first.groupPosition,
      controllerCpu: first.controllerCpu,
    },
    observations,
  };
}

function concurrentStateV2(generation, plan, observations) {
  const first = observations[0].record;
  return {
    version: PINNED_PROTOCOL_STATE_V2_VERSION,
    protocol: "concurrent-v2",
    generation,
    planSha: plan.planSha,
    wave: {
      round: first.round,
      group: first.group,
      groupPosition: first.groupPosition,
      controllerCpu: first.controllerCpu,
    },
    observations,
  };
}

export async function runConcurrentWave(options) {
  const plan = assertPlan(options?.plan, "concurrent");
  const stateVersion = isolatedStateVersion(options);
  const runner = validateRunner(options.runChild);
  const progress = await readConcurrentProgress(options);
  if (progress.complete) {
    return Object.freeze({ committed: false, reason: "complete", wave: null });
  }
  const rows = progress.nextWave;
  const first = rows[0];
  if (rows.length === 0 || rows.some((row, index) =>
    row.round !== first.round || row.group !== first.group ||
    row.groupPosition !== first.groupPosition || row.controllerCpu !== first.controllerCpu ||
    row.launchPosition !== index + 1 || row.cpu === first.controllerCpu)) {
    throw new PinnedProtocolStateError("next concurrent wave has inconsistent controller or plan fields");
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.signal !== undefined) {
    validateAbortSignal(options.signal);
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }
  let outcomes;
  try {
    // Array.map invokes every runner in canonical launch order. Each promise
    // sees the same signal; an operational failure cancels its still-running
    // peers, while Promise.all retains plan order for whole-wave validation.
    outcomes = await Promise.all(rows.map(async (record) => {
      try {
        const child = await runner(childOptions(
          options,
          record.cpu,
          controller.signal,
          stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
            ? PINNED_RUNNER_V2_VERSION
            : PINNED_RUNNER_VERSION,
          stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
            ? first.controllerCpu
            : undefined,
        ));
        const normalized = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
          ? stateObservationV2(record, child)
          : stateObservation(record, child);
        if (!normalized.valid) controller.abort();
        return normalized.valid || stateVersion === PINNED_PROTOCOL_STATE_VERSION
          ? normalized
          : { ...normalized, attempt: boundedOperationalAttempt(record, child, normalized.reason) };
      } catch (error) {
        controller.abort();
        const rejected = {
          valid: false,
          reason: stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
            ? "operational-invalid"
            : "runner-error",
          errorCode: runnerErrorCode(error),
        };
        if (stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION) {
          rejected.attempt = Object.freeze({
            record,
            classification: "operational-invalid",
            reason: "runner-error",
            errorCode: runnerErrorCode(error),
          });
        }
        return rejected;
      }
    }));
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
  const invalid = outcomes.find((outcome) => !outcome.valid);
  if (invalid !== undefined) {
    const rejected = {
      committed: false,
      reason: invalid.reason,
      errorCode: invalid.errorCode ?? null,
      wave: Object.freeze({
        round: first.round,
        group: first.group,
        groupPosition: first.groupPosition,
        controllerCpu: first.controllerCpu,
      }),
    };
    if (stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION) {
      rejected.attempts = Object.freeze(outcomes
        .filter((outcome) => !outcome.valid && outcome.attempt !== undefined)
        .map((outcome) => outcome.attempt));
    }
    return Object.freeze(rejected);
  }
  const observations = outcomes.map((outcome) => outcome.observation);
  const state = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? concurrentStateV2(progress.generation, plan, observations)
    : concurrentState(progress.generation, plan, observations);
  const bytes = canonicalProtocolJsonLine(state);
  if (bytes.length > MAX_WAVE_STATE_FILE_BYTES) {
    throw new PinnedProtocolStateError("concurrent wave state exceeds its byte limit");
  }
  const stateName = concurrentStateName(first.ordinal, first.group);
  await adapterCommit(progress._adapter, stateName, bytes);
  const nextOrdinal = first.ordinal + observations.length;
  const complete = nextOrdinal > plan.records.length;
  return Object.freeze({
    committed: true,
    reason: "committed",
    stateName,
    state: Object.freeze(state),
    committedRecords: observations.length,
    nextOrdinal,
    complete,
    nextControllerCpu: complete ? null : plan.records[nextOrdinal - 1].controllerCpu,
  });
}

function boundaryNoTurbo(observation) {
  return observation.status === "observed"
    ? observation.value
    : { status: observation.status, errorCode: observation.errorCode };
}

function isolatedBoundary(observation) {
  const { record, timing, noTurbo } = observation;
  // Property insertion order is the V5 evidence schema and intentionally is
  // not the alphabetic order used by immutable state JSON.
  return {
    ordinal: record.ordinal,
    round: record.round,
    position: record.position,
    cpu: record.cpu,
    startUnixMs: timing.startEpochMs,
    endUnixMs: timing.endEpochMs,
    startMonotonicNs: timing.startMonotonicNs,
    endMonotonicNs: timing.endMonotonicNs,
    durationNs: timing.durationNs,
    durationMs: timing.durationMs,
    noTurboStart: boundaryNoTurbo(noTurbo.start),
    noTurboEnd: boundaryNoTurbo(noTurbo.end),
  };
}

function isolatedBoundaryV2(observation) {
  const { record, timing, noTurbo, stderr } = observation;
  return {
    ordinal: record.ordinal,
    round: record.round,
    position: record.position,
    cpu: record.cpu,
    outcome: observation.outcome,
    exitCode: observation.exitCode,
    signal: observation.signal,
    stderrSha256: stderr.sha256,
    stderrBytes: stderr.bytes,
    stderrExcerptBase64: stderr.excerptBase64,
    stderrExcerptBytes: stderr.excerptBytes,
    stderrTruncated: stderr.truncated,
    startUnixMs: timing.startEpochMs,
    endUnixMs: timing.endEpochMs,
    startMonotonicNs: timing.startMonotonicNs,
    endMonotonicNs: timing.endMonotonicNs,
    durationNs: timing.durationNs,
    durationMs: timing.durationMs,
    noTurboStart: boundaryNoTurbo(noTurbo.start),
    noTurboEnd: boundaryNoTurbo(noTurbo.end),
  };
}

function concurrentBoundary(observation) {
  const { record, timing, noTurbo } = observation;
  return {
    ordinal: record.ordinal,
    round: record.round,
    groupPosition: record.groupPosition,
    group: record.group,
    controllerCpu: record.controllerCpu,
    launchPosition: record.launchPosition,
    cpu: record.cpu,
    startUnixMs: timing.startEpochMs,
    endUnixMs: timing.endEpochMs,
    startMonotonicNs: timing.startMonotonicNs,
    endMonotonicNs: timing.endMonotonicNs,
    durationNs: timing.durationNs,
    durationMs: timing.durationMs,
    noTurboStart: boundaryNoTurbo(noTurbo.start),
    noTurboEnd: boundaryNoTurbo(noTurbo.end),
  };
}

function concurrentBoundaryV2(observation) {
  const { record, timing, noTurbo, stderr } = observation;
  const legacy = observation.legacyRc !== null;
  return {
    ordinal: record.ordinal,
    round: record.round,
    groupPosition: record.groupPosition,
    group: record.group,
    controllerCpu: record.controllerCpu,
    launchPosition: record.launchPosition,
    cpu: record.cpu,
    outcome: observation.outcome,
    exitCode: observation.exitCode,
    signal: observation.signal,
    legacyRc: observation.legacyRc,
    stderrSha256: legacy ? null : stderr.sha256,
    stderrBytes: legacy ? null : stderr.bytes,
    stderrExcerptBase64: legacy ? null : stderr.excerptBase64,
    stderrExcerptBytes: legacy ? null : stderr.excerptBytes,
    stderrTruncated: legacy ? null : stderr.truncated,
    startUnixMs: timing.startEpochMs,
    endUnixMs: timing.endEpochMs,
    startMonotonicNs: timing.startMonotonicNs,
    endMonotonicNs: timing.endMonotonicNs,
    durationNs: timing.durationNs,
    durationMs: timing.durationMs,
    noTurboStart: boundaryNoTurbo(noTurbo.start),
    noTurboEnd: boundaryNoTurbo(noTurbo.end),
  };
}

function renderBoundaries(observations, mapper) {
  const buffer = Buffer.from(
    observations.map((observation) => JSON.stringify(mapper(observation))).join("\n") +
      (observations.length > 0 ? "\n" : ""),
    "utf8",
  );
  if (buffer.length > MAX_BOUNDARIES_BYTES) {
    throw new PinnedProtocolStateError("final boundary output exceeds its byte limit");
  }
  return buffer;
}

function isolatedObservations(progress) {
  return progress.states.map((state) => progress.stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? {
      record: state.record,
      outcome: state.outcome,
      exitCode: state.exitCode,
      signal: state.signal,
      stderr: state.stderr,
      timing: state.timing,
      noTurbo: state.noTurbo,
    }
    : {
      record: state.record,
      rc: state.rc,
      timing: state.timing,
      noTurbo: state.noTurbo,
    });
}

function concurrentObservations(progress) {
  return progress.states.flatMap((state) => state.observations.map((observation) =>
    state.version === PINNED_PROTOCOL_STATE_VERSION
      ? {
          record: observation.record,
          outcome: observation.rc === 139 ? "sigsegv" : "pass",
          exitCode: null,
          signal: null,
          legacyRc: observation.rc,
          stderr: null,
          timing: observation.timing,
          noTurbo: observation.noTurbo,
        }
      : {
          record: observation.record,
          outcome: observation.outcome,
          exitCode: observation.exitCode,
          signal: observation.signal,
          legacyRc: null,
          stderr: observation.stderr,
          timing: observation.timing,
          noTurbo: observation.noTurbo,
        }));
}

export async function finalizeIsolatedProtocol(options) {
  const plan = assertPlan(options?.plan, "isolated");
  const stateVersion = isolatedStateVersion(options);
  const progress = await readIsolatedProgress(options);
  if (!progress.complete) {
    throw new PinnedProtocolStateError(
      `isolated protocol is incomplete at ${progress.committedRecords}/${plan.records.length} records`,
    );
  }
  const observations = isolatedObservations(progress);
  const results = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? Buffer.from(`${ISOLATED_V2_RESULTS_HEADER}\n${observations.map((observation) => [
      observation.record.ordinal,
      observation.record.round,
      observation.record.position,
      observation.record.cpu,
      observation.outcome,
      observation.exitCode ?? "-",
      observation.signal ?? "-",
      observation.timing.elapsedSec,
      observation.stderr.sha256,
      observation.stderr.bytes,
    ].join("\t")).join("\n")}\n`, "utf8")
    : Buffer.from(observations.map((observation) =>
      `${observation.record.cpu}\t${observation.record.round}\t${observation.rc}\t${observation.timing.elapsedSec}\n`,
    ).join(""), "utf8");
  const boundaries = renderBoundaries(
    observations,
    stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION ? isolatedBoundaryV2 : isolatedBoundary,
  );
  const bindings = Object.freeze({
    plan: plan.binding,
    results: protocolFileBinding(results, observations.length),
    boundaries: protocolFileBinding(boundaries, observations.length),
  });
  return Object.freeze({
    protocol: "isolated",
    stateVersion,
    generation: progress.generation,
    planSha: plan.planSha,
    individualTsv: results,
    individualBoundariesNdjson: boundaries,
    results,
    boundaries,
    bindings,
  });
}

export async function finalizeConcurrentProtocol(options) {
  const plan = assertPlan(options?.plan, "concurrent");
  const stateVersion = isolatedStateVersion(options);
  const progress = await readConcurrentProgress(options);
  if (!progress.complete) {
    throw new PinnedProtocolStateError(
      `concurrent protocol is incomplete at ${progress.committedRecords}/${plan.records.length} records`,
    );
  }
  const observations = concurrentObservations(progress);
  const resultRows = observations.map((observation) => stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? {
        round: observation.record.round,
        group: observation.record.group,
        cpu: observation.record.cpu,
        launch_position: observation.record.launchPosition,
        outcome: observation.outcome,
        exit_code: observation.exitCode ?? "-",
        signal: observation.signal ?? "-",
        legacy_rc: observation.legacyRc ?? "-",
        elapsed_ms: Number(BigInt(observation.timing.durationNs) / 1_000_000n),
        stderr_sha256: observation.stderr?.sha256 ?? "-",
        stderr_bytes: observation.stderr?.bytes ?? "-",
      }
    : {
        round: observation.record.round,
        group: observation.record.group,
        cpu: observation.record.cpu,
        launch_position: observation.record.launchPosition,
        rc: observation.legacyRc,
        elapsed_ms: Number(BigInt(observation.timing.durationNs) / 1_000_000n),
      });
  const resultText = serializePinnedConcurrentResults(
    resultRows,
    concurrentEvidenceRows(plan.records),
    { version: stateVersion },
  );
  const expectedHeader = stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION
    ? PINNED_CONCURRENT_V2_RESULTS_HEADER
    : PINNED_CONCURRENT_RESULTS_HEADER;
  if (!resultText.startsWith(`${expectedHeader}\n`)) {
    throw new Error("pinned-concurrent result serializer returned an unexpected header");
  }
  const results = Buffer.from(resultText, "utf8");
  const boundaries = renderBoundaries(
    observations,
    stateVersion === PINNED_PROTOCOL_STATE_V2_VERSION ? concurrentBoundaryV2 : concurrentBoundary,
  );
  const bindings = Object.freeze({
    groups: plan.groupsBinding,
    plan: plan.binding,
    results: protocolFileBinding(results, observations.length),
    boundaries: protocolFileBinding(boundaries, observations.length),
  });
  return Object.freeze({
    protocol: "concurrent",
    stateVersion,
    generation: progress.generation,
    planSha: plan.planSha,
    legacyWaveCount: progress.legacyWaves,
    legacyRowCount: progress.legacyRecords,
    pinnedConcurrentTsv: results,
    pinnedConcurrentBoundariesNdjson: boundaries,
    results,
    boundaries,
    bindings,
  });
}

function readStableInputFile(file, maxBytes, label) {
  const resolved = validateAbsolutePath(file, label);
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  let before;
  let fd;
  try {
    before = lstatSync(resolved, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) ||
        (uid !== null && before.uid !== uid)) {
      throw new PinnedProtocolInputError(`${label} must be an owned single-link bounded regular file`);
    }
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!stableStat(before, opened) || opened.nlink !== 1n) {
      throw new PinnedProtocolInputError(`${label} changed while it was opened`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const afterFd = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(resolved, { bigint: true });
    if (offset !== bytes.length || !stableStat(opened, afterFd) ||
        !stableStat(afterFd, afterPath) || afterFd.nlink !== 1n) {
      throw new PinnedProtocolInputError(`${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof PinnedProtocolInputError) throw error;
    throw new PinnedProtocolInputError(`${label} could not be read safely`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readContextsFile(file) {
  const bytes = readStableInputFile(file, MAX_CONTEXT_FILE_BYTES, "contexts file");
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new PinnedProtocolInputError("contexts file is not valid UTF-8");
  }
  if (text.includes("\0") || text.includes("\r")) {
    throw new PinnedProtocolInputError("contexts file contains a forbidden control byte");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PinnedProtocolInputError("contexts file is not valid JSON");
  }
}

function publishStagingFile(file, bytes, label) {
  const resolved = validateAbsolutePath(file, label);
  commitStateFile(path.dirname(resolved), path.basename(resolved), bytes);
}

function parseCliInteger(value, label, maximum, { positive = false } = {}) {
  const pattern = positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PinnedProtocolInputError(`${label} must be a canonical ${positive ? "positive" : "non-negative"} integer`);
  }
  return validateInteger(Number(value), label, positive ? 1 : 0, maximum);
}

function parseCliOptions(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new PinnedProtocolInputError("a pinned-protocol command is required");
  }
  const command = argv[0];
  if (command === "--help" || command === "help") return { command: "help", values: new Map(), args: [] };
  const values = new Map();
  const args = [];
  const valueFlags = new Set([
    "--cpus", "--rounds", "--seed", "--contexts-file", "--generation", "--state-dir",
    "--command", "--arg", "--cwd", "--no-turbo-path", "--plan-output", "--groups-output",
    "--results-output", "--boundaries-output",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag)) throw new PinnedProtocolInputError(`unknown option: ${flag}`);
    if (index + 1 >= argv.length) throw new PinnedProtocolInputError(`${flag} requires a value`);
    const value = argv[++index];
    if (flag === "--arg") args.push(value);
    else {
      if (values.has(flag)) throw new PinnedProtocolInputError(`${flag} may be supplied only once`);
      values.set(flag, value);
    }
  }
  return { command, values, args };
}

function requireCliValue(parsed, flag) {
  const value = parsed.values.get(flag);
  if (value === undefined) throw new PinnedProtocolInputError(`${flag} is required`);
  return value;
}

function rejectUnexpectedCliOptions(parsed, allowed) {
  for (const flag of parsed.values.keys()) {
    if (!allowed.has(flag)) throw new PinnedProtocolInputError(`${flag} is not valid for ${parsed.command}`);
  }
  if (parsed.args.length > 0 && !allowed.has("--arg")) {
    throw new PinnedProtocolInputError(`--arg is not valid for ${parsed.command}`);
  }
}

function cliPlan(parsed, protocol) {
  const rounds = parseCliInteger(requireCliValue(parsed, "--rounds"), "--rounds", MAX_SCHEDULE_ENTRIES, {
    positive: true,
  });
  const seed = parseCliInteger(requireCliValue(parsed, "--seed"), "--seed", MAX_SEED);
  if (protocol === "isolated") {
    const spec = requireCliValue(parsed, "--cpus");
    const cpus = expandCpuList(spec);
    if (compressCpuList(cpus) !== spec) {
      throw new PinnedProtocolInputError("--cpus must be a compressed increasing canonical CPU list");
    }
    return buildIsolatedPlan({ cpus, rounds, seed });
  }
  const contexts = readContextsFile(requireCliValue(parsed, "--contexts-file"));
  return buildPinnedConcurrentPlan({ contexts, rounds, seed });
}

function cliExecutionOptions(parsed, plan, signal, runChild, stateVersion = PINNED_PROTOCOL_STATE_VERSION) {
  return {
    plan,
    generation: requireCliValue(parsed, "--generation"),
    stateDir: validateAbsolutePath(requireCliValue(parsed, "--state-dir"), "--state-dir"),
    signal,
    runChild,
    stateVersion,
    childOptions: {
      command: requireCliValue(parsed, "--command"),
      args: parsed.args,
      cwd: parsed.values.has("--cwd")
        ? validateAbsolutePath(parsed.values.get("--cwd"), "--cwd")
        : undefined,
      noTurboPath: parsed.values.has("--no-turbo-path")
        ? validateAbsolutePath(parsed.values.get("--no-turbo-path"), "--no-turbo-path")
        : undefined,
    },
  };
}

function writeCliJson(stream, value) {
  stream.write(`${canonicalProtocolJson(value)}\n`);
}

function cliUsage() {
  return `usage: node diagnose-lib/pinned-protocol.mjs COMMAND [options]

Pure deterministic plan commands:
  plan-isolated --cpus LIST --rounds N --seed N [--plan-output FILE]
  plan-concurrent --contexts-file FILE --rounds N --seed N
                  --plan-output FILE --groups-output FILE

Resume-frontier validation (prints canonical JSON):
  next-isolated --cpus LIST --rounds N --seed N --generation HEX32
                --state-dir DIR
  next-isolated-v2 --cpus LIST --rounds N --seed N --generation HEX32
                   --state-dir DIR
  next-concurrent --contexts-file FILE --rounds N --seed N --generation HEX32
                  --state-dir DIR
  next-concurrent-v2 --contexts-file FILE --rounds N --seed N --generation HEX32
                     --state-dir DIR

Execute exactly one commit unit:
  attempt-isolated --cpus LIST --rounds N --seed N --generation HEX32
                   --state-dir DIR --command FILE [--arg VALUE ...]
                   [--cwd DIR] [--no-turbo-path FILE]
  attempt-isolated-v2 --cpus LIST --rounds N --seed N --generation HEX32
                      --state-dir DIR --command FILE [--arg VALUE ...]
                      [--cwd DIR] [--no-turbo-path FILE]
  wave-concurrent --contexts-file FILE --rounds N --seed N --generation HEX32
                  --state-dir DIR --command FILE [--arg VALUE ...]
                  [--cwd DIR] [--no-turbo-path FILE]
  wave-concurrent-v2 --contexts-file FILE --rounds N --seed N --generation HEX32
                     --state-dir DIR --command FILE [--arg VALUE ...]
                     [--cwd DIR] [--no-turbo-path FILE]

Finalize a complete immutable state prefix into caller-chosen staging files:
  finalize-isolated --cpus LIST --rounds N --seed N --generation HEX32
                    --state-dir DIR --results-output FILE
                    --boundaries-output FILE
  finalize-isolated-v2 --cpus LIST --rounds N --seed N --generation HEX32
                       --state-dir DIR --results-output FILE
                       --boundaries-output FILE
  finalize-concurrent --contexts-file FILE --rounds N --seed N --generation HEX32
                      --state-dir DIR --results-output FILE
                      --boundaries-output FILE
  finalize-concurrent-v2 --contexts-file FILE --rounds N --seed N --generation HEX32
                         --state-dir DIR --results-output FILE
                         --boundaries-output FILE

contexts-file is a JSON array of exact objects:
  {"group":"l2_0","kind":"l2-cluster","cpus":[8,9,10,11],
   "cluster":"l2:8-11","controllerCpu":0}

All output and state files are exclusive-create mode 0600. Finalize writes only
the supplied staging paths and prints their digest/byte/row bindings; bundle
publication remains the caller's atomic transaction. Child execution is exact
pinning through pinned-runner and never changes no_turbo or other sysfs state.`;
}

async function withCliAbort(signalSource, callback) {
  const controller = new AbortController();
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => controller.abort();
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  try {
    return await callback(controller.signal);
  } finally {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  }
}

export async function runPinnedProtocolCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const signalSource = io.signalSource ?? process;
  try {
    const parsed = parseCliOptions(argv);
    if (parsed.command === "help") {
      stdout.write(`${cliUsage()}\n`);
      return 0;
    }
    const isolatedCommands = new Set([
      "plan-isolated", "next-isolated", "attempt-isolated", "finalize-isolated",
      "next-isolated-v2", "attempt-isolated-v2", "finalize-isolated-v2",
    ]);
    const concurrentCommands = new Set([
      "plan-concurrent", "next-concurrent", "wave-concurrent", "finalize-concurrent",
      "next-concurrent-v2", "wave-concurrent-v2", "finalize-concurrent-v2",
    ]);
    const isolated = isolatedCommands.has(parsed.command);
    const concurrent = concurrentCommands.has(parsed.command);
    if (!isolated && !concurrent) throw new PinnedProtocolInputError(`unknown command: ${parsed.command}`);
    const protocol = isolated ? "isolated" : "concurrent";
    const stateVersion = parsed.command.endsWith("-isolated-v2") ||
        parsed.command.endsWith("-concurrent-v2")
      ? PINNED_PROTOCOL_STATE_V2_VERSION
      : PINNED_PROTOCOL_STATE_VERSION;
    const planFlags = protocol === "isolated"
      ? new Set(["--cpus", "--rounds", "--seed"])
      : new Set(["--contexts-file", "--rounds", "--seed"]);

    if (parsed.command.startsWith("plan-")) {
      const allowed = new Set([...planFlags, "--plan-output"]);
      if (protocol === "concurrent") allowed.add("--groups-output");
      rejectUnexpectedCliOptions(parsed, allowed);
      const plan = cliPlan(parsed, protocol);
      if (protocol === "isolated" && !parsed.values.has("--plan-output")) stdout.write(plan.tsv);
      else {
        const planOutput = validateAbsolutePath(requireCliValue(parsed, "--plan-output"), "--plan-output");
        if (protocol === "concurrent") {
          const groupsOutput = validateAbsolutePath(requireCliValue(parsed, "--groups-output"), "--groups-output");
          if (groupsOutput === planOutput) throw new PinnedProtocolInputError("plan and groups outputs must differ");
          publishStagingFile(groupsOutput, plan.groupsTsv, "--groups-output");
        }
        publishStagingFile(planOutput, plan.tsv, "--plan-output");
        writeCliJson(stdout, protocol === "concurrent"
          ? { groups: plan.groupsBinding, plan: plan.binding }
          : { plan: plan.binding });
      }
      return 0;
    }

    const stateFlags = new Set([...planFlags, "--generation", "--state-dir"]);
    if (parsed.command.startsWith("next-")) {
      rejectUnexpectedCliOptions(parsed, stateFlags);
      const plan = cliPlan(parsed, protocol);
      const progress = protocol === "isolated"
        ? await readIsolatedProgress({
          plan,
          generation: requireCliValue(parsed, "--generation"),
          stateDir: validateAbsolutePath(requireCliValue(parsed, "--state-dir"), "--state-dir"),
          stateVersion,
        })
        : await readConcurrentProgress({
          plan,
          generation: requireCliValue(parsed, "--generation"),
          stateDir: validateAbsolutePath(requireCliValue(parsed, "--state-dir"), "--state-dir"),
          stateVersion,
        });
      writeCliJson(stdout, protocol === "isolated"
        ? {
          protocol,
          planSha: plan.planSha,
          committedRecords: progress.committedRecords,
          complete: progress.complete,
          nextRecord: progress.nextRecord,
        }
        : {
          protocol,
          planSha: plan.planSha,
          committedRecords: progress.committedRecords,
          committedWaves: progress.committedWaves,
          legacyRecords: progress.legacyRecords,
          legacyWaves: progress.legacyWaves,
          complete: progress.complete,
          nextWave: progress.nextWave,
        });
      return 0;
    }

    if (parsed.command === "attempt-isolated" || parsed.command === "attempt-isolated-v2" ||
        parsed.command === "wave-concurrent" || parsed.command === "wave-concurrent-v2") {
      const allowed = new Set([
        ...stateFlags,
        "--command", "--arg", "--cwd", "--no-turbo-path",
      ]);
      rejectUnexpectedCliOptions(parsed, allowed);
      const plan = cliPlan(parsed, protocol);
      const result = await withCliAbort(signalSource, (signal) => {
        const options = cliExecutionOptions(parsed, plan, signal, io.runChild, stateVersion);
        return protocol === "isolated"
          ? runIsolatedAttempt(options)
          : runConcurrentWave(options);
      });
      writeCliJson(stdout, result);
      return result.committed || result.reason === "complete" ? 0 : 3;
    }

    if (parsed.command.startsWith("finalize-")) {
      const allowed = new Set([...stateFlags, "--results-output", "--boundaries-output"]);
      rejectUnexpectedCliOptions(parsed, allowed);
      const plan = cliPlan(parsed, protocol);
      const base = {
        plan,
        generation: requireCliValue(parsed, "--generation"),
        stateDir: validateAbsolutePath(requireCliValue(parsed, "--state-dir"), "--state-dir"),
        stateVersion,
      };
      const finalized = protocol === "isolated"
        ? await finalizeIsolatedProtocol(base)
        : await finalizeConcurrentProtocol(base);
      const resultsOutput = validateAbsolutePath(
        requireCliValue(parsed, "--results-output"),
        "--results-output",
      );
      const boundariesOutput = validateAbsolutePath(
        requireCliValue(parsed, "--boundaries-output"),
        "--boundaries-output",
      );
      if (resultsOutput === boundariesOutput) {
        throw new PinnedProtocolInputError("results and boundaries outputs must differ");
      }
      publishStagingFile(resultsOutput, finalized.results, "--results-output");
      publishStagingFile(boundariesOutput, finalized.boundaries, "--boundaries-output");
      writeCliJson(stdout, finalized.bindings);
      return 0;
    }
    throw new PinnedProtocolInputError(`unsupported command: ${parsed.command}`);
  } catch (error) {
    stderr.write(`error: ${error?.message ?? String(error)}\n`);
    return error instanceof PinnedProtocolInputError ? 2 : 1;
  }
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const code = await runPinnedProtocolCli(process.argv.slice(2));
  process.exitCode = code;
}
