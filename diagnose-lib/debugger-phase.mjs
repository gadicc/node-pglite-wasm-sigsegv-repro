import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import { MAX_CPU_ID } from "./pinned-runner.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const DEBUGGER_PHASE_MANIFEST_VERSION = 1;
export const DEBUGGER_SCHEDULE_VERSION = 1;
export const DEBUGGER_COMMAND_PROFILE_VERSION = 1;
export const DEBUGGER_TRANSCRIPT_VERSION = 1;
export const DEBUGGER_MAX_RUNS = 4_096;
export const DEBUGGER_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

const PHASE = "gdb-capture";
const SCHEDULE_ALGORITHM = "single-cpu-sequential-v1";
const AFFINITY_MODE = "inherited-singleton-v1";
const COMMAND_PROFILE_ID = "fault-affinity-gdb-batch-v1";
const CAPTURE_SECTIONS = Object.freeze([
  "stop",
  "backtrace",
  "registers",
  "instructions",
  "threads",
  "mappings",
]);
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]{0,15})$/;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_RUN_TIMEOUT_MS = 3_600_000;
const MAX_GRACE_MS = 60_000;
const HASH_BUFFER_BYTES = 64 * 1024;

export class DebuggerPhaseError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_PHASE") {
    super(message);
    this.name = "DebuggerPhaseError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerPhaseError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function plainObject(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]),
  `${label} must contain exactly: ${wanted.join(", ")}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  return deepFreeze(JSON.parse(canonicalProtocolJson(value)));
}

function canonicalLine(value) {
  return Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
}

function bindingForBytes(bytes) {
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

function canonicalInteger(value, label, minimum, maximum) {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "debugger phase generation must be exactly 32 lowercase hexadecimal characters");
  return value;
}

function validateBoundedAbsolutePath(value, label) {
  requireCondition(typeof value === "string" && path.isAbsolute(value) &&
    !value.includes("\0") && Buffer.byteLength(value) <= MAX_PATH_BYTES,
  `${label} must be a bounded absolute NUL-free path`);
  return value;
}

function executableIdentity(filename) {
  validateBoundedAbsolutePath(filename, "debugger executable path");
  let canonical;
  let fd;
  try {
    canonical = realpathSync(filename);
    validateBoundedAbsolutePath(canonical, "canonical debugger executable path");
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    requireCondition(before.isFile(), "debugger executable must be a regular file");
    requireCondition(before.size > 0n && before.size <= BigInt(MAX_EXECUTABLE_BYTES),
      `debugger executable must contain 1 through ${MAX_EXECUTABLE_BYTES} bytes`);
    const mode = Number(before.mode & 0o777n);
    requireCondition((mode & 0o111) !== 0, "debugger executable must have an execute bit");

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0n;
    while (offset < before.size) {
      const remaining = before.size - offset;
      const length = Number(remaining < BigInt(buffer.length)
        ? remaining : BigInt(buffer.length));
      const bytes = readSync(fd, buffer, 0, length, Number(offset));
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += BigInt(bytes);
    }

    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(canonical, { bigint: true });
    requireCondition(before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs && before.mode === after.mode &&
      before.dev === named.dev && before.ino === named.ino &&
      before.size === named.size && before.mtimeNs === named.mtimeNs &&
      before.ctimeNs === named.ctimeNs && before.mode === named.mode &&
      offset === before.size,
    "debugger executable changed while it was hashed", "DEBUGGER_PROVENANCE_CHANGED");
    return Object.freeze({
      path: canonical,
      sha256: hash.digest("hex"),
      bytes: before.size.toString(),
      mode,
    });
  } catch (error) {
    if (error instanceof DebuggerPhaseError) throw error;
    fail(`debugger executable cannot be resolved safely: ${error?.code ?? "unknown error"}`,
      "DEBUGGER_PATH_ERROR");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  requireCondition(resolved.capabilities?.gdb === true,
    "workload does not declare debugger support");
  requireCondition(Array.isArray(resolved.outcomes?.targetSignals) &&
    resolved.outcomes.targetSignals.length >= 1,
  "debugger-capable workload must declare at least one target signal");
  return Object.freeze({
    contractVersion: resolved.version,
    id: resolved.id,
    digest: resolved.digest,
  });
}

function validateWorkloadBinding(resolved, value) {
  exactKeys(value, ["contractVersion", "id", "digest"], "debugger workload binding");
  const expected = workloadBinding(resolved);
  requireCondition(value.contractVersion === expected.contractVersion &&
    value.id === expected.id && value.digest === expected.digest,
  "debugger workload binding does not match the resolved workload");
  return expected;
}

function commandProfile(resolved) {
  return {
    version: DEBUGGER_COMMAND_PROFILE_VERSION,
    id: COMMAND_PROFILE_ID,
    targetSignals: [...resolved.outcomes.targetSignals],
    captureSections: [...CAPTURE_SECTIONS],
    transcript: {
      version: DEBUGGER_TRANSCRIPT_VERSION,
      maxBytes: DEBUGGER_TRANSCRIPT_MAX_BYTES,
    },
  };
}

function debuggerIdentity(resolved, executable) {
  const identity = {
    kind: "gnu-gdb",
    executable,
    commandProfile: commandProfile(resolved),
  };
  return {
    ...identity,
    digest: createHash("sha256").update(canonicalLine(identity)).digest("hex"),
  };
}

function validateExecutable(value) {
  exactKeys(value, ["path", "sha256", "bytes", "mode"], "debugger executable identity");
  validateBoundedAbsolutePath(value.path, "debugger executable identity path");
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256),
    "debugger executable identity digest is invalid");
  requireCondition(typeof value.bytes === "string" && CANONICAL_DECIMAL_RE.test(value.bytes) &&
    BigInt(value.bytes) >= 1n && BigInt(value.bytes) <= BigInt(MAX_EXECUTABLE_BYTES),
  "debugger executable identity size is invalid");
  canonicalInteger(value.mode, "debugger executable identity mode", 0, 0o777);
  requireCondition((value.mode & 0o111) !== 0,
    "debugger executable identity must record an execute bit");
}

function validateCommandProfile(resolved, value) {
  exactKeys(value, ["version", "id", "targetSignals", "captureSections", "transcript"],
    "debugger command profile");
  const expected = commandProfile(resolved);
  requireCondition(value.version === expected.version && value.id === expected.id &&
    canonicalProtocolJson(value.targetSignals) ===
      canonicalProtocolJson(expected.targetSignals) &&
    canonicalProtocolJson(value.captureSections) ===
      canonicalProtocolJson(expected.captureSections),
  "debugger command profile does not match the supported profile");
  exactKeys(value.transcript, ["version", "maxBytes"], "debugger transcript profile");
  requireCondition(value.transcript.version === DEBUGGER_TRANSCRIPT_VERSION &&
    value.transcript.maxBytes === DEBUGGER_TRANSCRIPT_MAX_BYTES,
  "debugger transcript profile is unsupported");
}

function validateDebugger(resolved, value) {
  exactKeys(value, ["kind", "executable", "commandProfile", "digest"],
    "debugger identity");
  requireCondition(value.kind === "gnu-gdb", "debugger kind is unsupported");
  validateExecutable(value.executable);
  validateCommandProfile(resolved, value.commandProfile);
  requireCondition(typeof value.digest === "string" && DIGEST_RE.test(value.digest),
    "debugger identity digest is invalid");
  const { digest, ...identity } = value;
  requireCondition(digest === createHash("sha256").update(canonicalLine(identity)).digest("hex"),
    "debugger identity digest does not match its identity");
}

function scheduleIdentity(options) {
  const cpu = canonicalInteger(options.cpu, "debugger target CPU", 0, MAX_CPU_ID);
  const maxRuns = canonicalInteger(options.maxRuns, "debugger maximum runs", 1,
    DEBUGGER_MAX_RUNS);
  const maxCaptures = canonicalInteger(options.maxCaptures,
    "debugger maximum captures", 1, DEBUGGER_MAX_RUNS);
  requireCondition(maxCaptures <= maxRuns,
    "debugger maximum captures cannot exceed maximum runs");
  return {
    version: DEBUGGER_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    cpu,
    maxRuns,
    maxCaptures,
  };
}

function scheduleDigest(identity) {
  return createHash("sha256").update(canonicalLine(identity)).digest("hex");
}

function validateSchedule(value) {
  exactKeys(value, ["version", "algorithm", "cpu", "maxRuns", "maxCaptures", "digest"],
    "debugger schedule");
  requireCondition(value.version === DEBUGGER_SCHEDULE_VERSION &&
    value.algorithm === SCHEDULE_ALGORITHM,
  "debugger schedule version or algorithm is unsupported");
  requireCondition(typeof value.digest === "string" && DIGEST_RE.test(value.digest),
    "debugger schedule digest is invalid");
  const identity = scheduleIdentity(value);
  const { digest, ...actual } = value;
  requireCondition(canonicalProtocolJson(actual) === canonicalProtocolJson(identity),
    "debugger schedule does not match its identity");
  requireCondition(digest === scheduleDigest(identity),
    "debugger schedule digest does not match its identity");
  return identity;
}

function validateExecution(value) {
  exactKeys(value, [
    "affinityMode", "tasksetPath", "runTimeoutMs", "termGraceMs", "killGraceMs",
  ], "debugger execution context");
  requireCondition(value.affinityMode === AFFINITY_MODE,
    "debugger affinity mode is unsupported");
  validateBoundedAbsolutePath(value.tasksetPath, "debugger taskset path");
  canonicalInteger(value.runTimeoutMs, "debugger run timeout", 1, MAX_RUN_TIMEOUT_MS);
  canonicalInteger(value.termGraceMs, "debugger TERM grace", 0, MAX_GRACE_MS);
  canonicalInteger(value.killGraceMs, "debugger KILL grace", 0, MAX_GRACE_MS);
}

function validateManifest(resolved, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "debugger", "execution", "schedule",
  ], "debugger phase manifest");
  requireCondition(value.version === DEBUGGER_PHASE_MANIFEST_VERSION,
    `debugger phase manifest version must be ${DEBUGGER_PHASE_MANIFEST_VERSION}`);
  requireCondition(value.phase === PHASE, "debugger phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(resolved, value.workload);
  validateDebugger(resolved, value.debugger);
  validateExecution(value.execution);
  return validateSchedule(value.schedule);
}

export function buildDebuggerPhaseManifest(resolved, options) {
  exactKeys(options, [
    "generation", "cpu", "maxRuns", "maxCaptures", "debuggerPath", "tasksetPath",
    "runTimeoutMs", "termGraceMs", "killGraceMs",
  ], "debugger phase options");
  validateGeneration(options.generation);
  const workload = workloadBinding(resolved);
  const executable = executableIdentity(options.debuggerPath);
  validateBoundedAbsolutePath(options.tasksetPath, "debugger taskset path");
  const schedule = scheduleIdentity(options);
  validateExecution({
    affinityMode: AFFINITY_MODE,
    tasksetPath: options.tasksetPath,
    runTimeoutMs: options.runTimeoutMs,
    termGraceMs: options.termGraceMs,
    killGraceMs: options.killGraceMs,
  });
  return parseDebuggerPhaseManifest(resolved, {
    version: DEBUGGER_PHASE_MANIFEST_VERSION,
    phase: PHASE,
    generation: options.generation,
    workload,
    debugger: debuggerIdentity(resolved, executable),
    execution: {
      affinityMode: AFFINITY_MODE,
      tasksetPath: options.tasksetPath,
      runTimeoutMs: options.runTimeoutMs,
      termGraceMs: options.termGraceMs,
      killGraceMs: options.killGraceMs,
    },
    schedule: { ...schedule, digest: scheduleDigest(schedule) },
  });
}

export function parseDebuggerPhaseManifest(resolved, value) {
  validateManifest(resolved, value);
  return canonicalClone(value);
}

export function canonicalDebuggerPhaseManifestLine(resolved, value) {
  return canonicalLine(parseDebuggerPhaseManifest(resolved, value));
}

export function debuggerPhaseManifestBinding(resolved, value) {
  return bindingForBytes(canonicalDebuggerPhaseManifestLine(resolved, value));
}

export function verifyDebuggerPhaseLaunchProvenance(resolved, value) {
  const manifest = parseDebuggerPhaseManifest(resolved, value);
  let current;
  try {
    current = executableIdentity(manifest.debugger.executable.path);
  } catch (error) {
    fail(`debugger executable provenance could not be revalidated: ${error.message}`,
      "DEBUGGER_PROVENANCE_CHANGED");
  }
  requireCondition(canonicalProtocolJson(current) ===
    canonicalProtocolJson(manifest.debugger.executable),
  "debugger executable provenance changed after manifest construction",
  "DEBUGGER_PROVENANCE_CHANGED");
  return true;
}
