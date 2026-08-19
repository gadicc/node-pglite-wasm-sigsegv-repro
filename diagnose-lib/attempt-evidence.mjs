import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";

import { ATTEMPT_RESULT_VERSION } from "./attempt-runner.mjs";
import {
  ATTEMPT_TERMINAL_REASONS,
  WORKLOAD_SPEC_VERSION,
  classifyWorkloadAttempt,
  workloadLaunchProvenance,
} from "./workload-spec.mjs";

export const ATTEMPT_EVIDENCE_VERSION = 1;
export const ATTEMPT_EVIDENCE_MAX_EXCERPT_BYTES = 1024 * 1024;

const DIGEST_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const START_TICKS_RE = /^(0|[1-9][0-9]*)$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,31})$/;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const TERMINAL_CAUSES = new Set([
  "natural-exit",
  "observation-window",
  "external-cancel",
  "launch-error",
  "terminal-race",
]);
const DELIVERY_MODES = new Set(["process-group", "identity-bound-members"]);
const MAX_CANONICAL_NODES = 512;
const MAX_CANONICAL_STRING_BYTES = 4 * 1024 * 1024;

export class AttemptEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "AttemptEvidenceError";
    this.code = "INVALID_ATTEMPT_EVIDENCE";
  }
}

function fail(message) {
  throw new AttemptEvidenceError(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
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

function canonicalize(value, budget = { nodes: 0, stringBytes: 0 }, depth = 0) {
  requireCondition(depth <= 24, "attempt evidence exceeds the canonical depth limit");
  budget.nodes += 1;
  requireCondition(budget.nodes <= MAX_CANONICAL_NODES,
    "attempt evidence exceeds the canonical node limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireCondition(Number.isSafeInteger(value),
      "attempt evidence contains a non-integer number");
    return value;
  }
  if (typeof value === "string") {
    requireCondition(!value.includes("\0"), "attempt evidence contains a NUL byte");
    budget.stringBytes += Buffer.byteLength(value);
    requireCondition(budget.stringBytes <= MAX_CANONICAL_STRING_BYTES,
      "attempt evidence exceeds the canonical string limit");
    return value;
  }
  if (Array.isArray(value)) {
    requireCondition(value.length <= 256, "attempt evidence contains an oversized array");
    return value.map((entry) => canonicalize(entry, budget, depth + 1));
  }
  plainObject(value, "attempt evidence value");
  const keys = Object.keys(value).sort();
  requireCondition(keys.length <= 64, "attempt evidence object has too many fields");
  return Object.fromEntries(keys.map((key) => {
    requireCondition(key.length <= 128 && !key.includes("\0"),
      "attempt evidence contains an invalid field name");
    return [key, canonicalize(value[key], budget, depth + 1)];
  }));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalDecimal(value, label) {
  requireCondition(typeof value === "string" && DECIMAL_RE.test(value),
    `${label} must be a canonical bounded decimal string`);
  return BigInt(value);
}

function optionalErrorCode(value, label) {
  requireCondition(value === null ||
    (typeof value === "string" && ERROR_CODE_RE.test(value)),
  `${label} must be null or a canonical error code`);
}

function validStatus(exitCode, signal, label) {
  const exitValid = exitCode === null ||
    (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  const signalValid = signal === null ||
    (typeof signal === "string" && KNOWN_SIGNALS.has(signal));
  requireCondition(exitValid && signalValid && ((exitCode === null) !== (signal === null)),
    `${label} must contain exactly one canonical exit code or signal`);
}

function validateBoundary(boundary) {
  exactKeys(boundary, [
    "attemptStartedMonotonicNs",
    "workloadStartedMonotonicNs",
    "terminalChosenMonotonicNs",
    "cleanupFinishedMonotonicNs",
  ], "attempt boundary");
  const attemptStarted = canonicalDecimal(
    boundary.attemptStartedMonotonicNs,
    "attempt boundary start",
  );
  const workloadStarted = boundary.workloadStartedMonotonicNs === null
    ? null
    : canonicalDecimal(boundary.workloadStartedMonotonicNs, "workload boundary start");
  const terminalChosen = canonicalDecimal(
    boundary.terminalChosenMonotonicNs,
    "attempt terminal boundary",
  );
  const cleanupFinished = canonicalDecimal(
    boundary.cleanupFinishedMonotonicNs,
    "attempt cleanup boundary",
  );
  requireCondition(attemptStarted <= terminalChosen && terminalChosen <= cleanupFinished,
    "attempt boundaries are not monotonic");
  requireCondition(workloadStarted === null ||
    (attemptStarted <= workloadStarted && workloadStarted <= cleanupFinished),
  "workload start lies outside the attempt boundaries");
  return { attemptStarted, workloadStarted, terminalChosen, cleanupFinished };
}

function validateSupervisorIdentity(value) {
  if (value === null) return;
  exactKeys(value, ["pid", "processGroupId", "sessionId", "startTicks"],
    "attempt supervisor identity");
  requireCondition(Number.isSafeInteger(value.pid) && value.pid > 1 &&
    value.processGroupId === value.pid && value.sessionId === value.pid &&
    typeof value.startTicks === "string" && START_TICKS_RE.test(value.startTicks),
  "attempt supervisor identity is not canonical");
}

function validateWorkloadIdentity(value) {
  if (value === null) return;
  exactKeys(value, ["pid", "startTicks"], "attempt workload identity");
  requireCondition(Number.isSafeInteger(value.pid) && value.pid > 1 &&
    (value.startTicks === null ||
      (typeof value.startTicks === "string" && START_TICKS_RE.test(value.startTicks))),
  "attempt workload identity is not canonical");
}

function validateProcess(processRecord, boundary) {
  exactKeys(processRecord, ["supervisor", "workload"], "attempt process record");
  validateSupervisorIdentity(processRecord.supervisor);
  validateWorkloadIdentity(processRecord.workload);
  requireCondition((boundary.workloadStarted === null) === (processRecord.workload === null),
    "workload identity and workload start boundary disagree");
}

function validateObservation(resolved, observation) {
  exactKeys(observation, [
    "exitCode",
    "signal",
    "terminalReason",
    "cleanupComplete",
    "launchErrorCode",
  ], "attempt observation");
  requireCondition(observation.exitCode === null ||
    (Number.isSafeInteger(observation.exitCode) &&
      observation.exitCode >= 0 && observation.exitCode <= 255),
  "attempt observation exit code is not canonical");
  requireCondition(observation.signal === null ||
    (typeof observation.signal === "string" && KNOWN_SIGNALS.has(observation.signal)),
  "attempt observation signal is not canonical");
  requireCondition(!(observation.exitCode !== null && observation.signal !== null),
    "attempt observation contains an ambiguous process status");
  requireCondition(ATTEMPT_TERMINAL_REASONS.includes(observation.terminalReason),
    "attempt observation terminal reason is unknown");
  requireCondition(typeof observation.cleanupComplete === "boolean",
    "attempt observation cleanup flag is not boolean");
  optionalErrorCode(observation.launchErrorCode, "attempt observation launch error");
  return classifyWorkloadAttempt(resolved, observation);
}

function validateSignalAction(action, label, boundary) {
  exactKeys(action, [
    "attempted",
    "delivered",
    "deliveryMode",
    "errorCode",
    "monotonicNs",
  ], label);
  requireCondition(typeof action.attempted === "boolean" &&
    typeof action.delivered === "boolean", `${label} flags must be boolean`);
  optionalErrorCode(action.errorCode, `${label} error`);
  if (!action.attempted) {
    requireCondition(!action.delivered && action.deliveryMode === null &&
      action.errorCode === null && action.monotonicNs === null,
    `${label} contains evidence for an action that was not attempted`);
    return null;
  }
  requireCondition(action.deliveryMode === null || DELIVERY_MODES.has(action.deliveryMode),
    `${label} delivery mode is unknown`);
  requireCondition(!action.delivered || action.deliveryMode !== null,
    `${label} delivered without a delivery mode`);
  const monotonicNs = canonicalDecimal(action.monotonicNs, `${label} timestamp`);
  requireCondition(boundary.terminalChosen <= monotonicNs &&
    monotonicNs <= boundary.cleanupFinished,
  `${label} timestamp lies outside cleanup`);
  return monotonicNs;
}

function validateCleanupStatus(value, label) {
  if (value === null) return;
  exactKeys(value, ["exitCode", "signal"], label);
  validStatus(value.exitCode, value.signal, label);
}

function validateCleanup(resolved, cleanup, observation, boundary, processRecord) {
  exactKeys(cleanup, [
    "cause",
    "term",
    "kill",
    "shutdownRequested",
    "groupDrained",
    "outputDrained",
    "failureReason",
    "postTerminalStatus",
    "supervisorStatus",
  ], "attempt cleanup");
  requireCondition(TERMINAL_CAUSES.has(cleanup.cause),
    "attempt cleanup cause is unknown");
  requireCondition(typeof cleanup.shutdownRequested === "boolean" &&
    typeof cleanup.groupDrained === "boolean" &&
    typeof cleanup.outputDrained === "boolean",
  "attempt cleanup flags must be boolean");
  optionalErrorCode(cleanup.failureReason, "attempt cleanup failure reason");
  const termNs = validateSignalAction(cleanup.term, "attempt TERM action", boundary);
  const killNs = validateSignalAction(cleanup.kill, "attempt KILL action", boundary);
  if (termNs !== null && killNs !== null) {
    requireCondition(killNs - termNs >= BigInt(resolved.attempt.termGraceMs) * 1_000_000n,
      "attempt KILL action precedes the configured TERM grace period");
  }
  validateCleanupStatus(cleanup.postTerminalStatus, "attempt post-terminal status");
  validateCleanupStatus(cleanup.supervisorStatus, "attempt supervisor status");
  requireCondition(processRecord.supervisor !== null || cleanup.supervisorStatus === null,
    "attempt without a supervisor contains supervisor status");
  requireCondition(observation.cleanupComplete
    ? cleanup.groupDrained && cleanup.outputDrained && cleanup.failureReason === null
    : cleanup.failureReason !== null,
  "attempt cleanup summary disagrees with the observation");

  const reasonForCause = {
    "natural-exit": "natural-exit",
    "observation-window": "observation-window-elapsed",
    "external-cancel": "external-cancel",
    "launch-error": "launch-error",
    "terminal-race": "terminal-race-unresolved",
  }[cleanup.cause];
  requireCondition(observation.terminalReason === reasonForCause,
    "attempt cleanup cause disagrees with the terminal reason");
  if (cleanup.cause === "natural-exit") {
    validStatus(observation.exitCode, observation.signal, "natural attempt observation");
    requireCondition(observation.launchErrorCode === null &&
      cleanup.postTerminalStatus === null,
    "natural attempt contains launch or post-terminal cleanup status");
  } else if (cleanup.cause === "launch-error") {
    requireCondition(observation.exitCode === null && observation.signal === null &&
      observation.launchErrorCode !== null,
    "launch-error attempt contains an invalid raw status");
  } else {
    requireCondition(observation.exitCode === null && observation.signal === null &&
      observation.launchErrorCode === null,
    "non-natural attempt contains an authoritative workload status");
  }

  if (observation.cleanupComplete && processRecord.supervisor !== null) {
    requireCondition(cleanup.supervisorStatus !== null,
      "complete cleanup is missing supervisor completion status");
    if (cleanup.kill.delivered) {
      requireCondition(cleanup.supervisorStatus.exitCode === null &&
        cleanup.supervisorStatus.signal === "SIGKILL",
      "KILL cleanup has inconsistent supervisor completion status");
    } else {
      requireCondition(cleanup.shutdownRequested && cleanup.supervisorStatus.exitCode === 0 &&
        cleanup.supervisorStatus.signal === null,
      "orderly cleanup has inconsistent supervisor completion status");
    }
  }
}

function canonicalBase64(value, label) {
  requireCondition(typeof value === "string" &&
    value.length <= Math.ceil(ATTEMPT_EVIDENCE_MAX_EXCERPT_BYTES / 3) * 4 &&
    (value === "" || (value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value))),
  `${label} is not bounded canonical base64`);
  const bytes = Buffer.from(value, "base64");
  requireCondition(bytes.length <= ATTEMPT_EVIDENCE_MAX_EXCERPT_BYTES &&
    bytes.toString("base64") === value, `${label} is not canonical base64`);
  return bytes;
}

function validateOutputStream(output, label) {
  exactKeys(output, [
    "bytes",
    "sha256",
    "excerptBase64",
    "excerptBytes",
    "truncated",
    "complete",
    "errorCode",
  ], label);
  const totalBytes = canonicalDecimal(output.bytes, `${label} byte count`);
  requireCondition(typeof output.sha256 === "string" && DIGEST_RE.test(output.sha256),
    `${label} digest is not canonical`);
  const excerpt = canonicalBase64(output.excerptBase64, `${label} excerpt`);
  requireCondition(Number.isSafeInteger(output.excerptBytes) &&
    output.excerptBytes === excerpt.length,
  `${label} excerpt byte count is inconsistent`);
  requireCondition(typeof output.truncated === "boolean" &&
    typeof output.complete === "boolean", `${label} flags must be boolean`);
  optionalErrorCode(output.errorCode, `${label} error`);
  requireCondition(totalBytes >= BigInt(excerpt.length) &&
    output.truncated === (totalBytes > BigInt(excerpt.length)),
  `${label} truncation state is inconsistent`);
  if (!output.truncated) {
    requireCondition(createHash("sha256").update(excerpt).digest("hex") === output.sha256,
      `${label} full-content digest does not match its excerpt`);
  }
  requireCondition(!output.complete || output.errorCode === null,
    `${label} cannot be complete with a stream error`);
}

function validateOutput(output, cleanup) {
  exactKeys(output, ["stdout", "stderr"], "attempt output");
  validateOutputStream(output.stdout, "attempt stdout");
  validateOutputStream(output.stderr, "attempt stderr");
  requireCondition(cleanup.outputDrained ===
    (output.stdout.complete && output.stderr.complete),
  "attempt output completion disagrees with cleanup");
}

function validateRecord(resolved, value) {
  workloadLaunchProvenance(resolved);
  exactKeys(value, [
    "version",
    "workload",
    "boundary",
    "process",
    "observation",
    "outcome",
    "cleanup",
    "output",
  ], "attempt evidence");
  requireCondition(value.version === ATTEMPT_EVIDENCE_VERSION,
    `attempt evidence version must be ${ATTEMPT_EVIDENCE_VERSION}`);
  exactKeys(value.workload, ["contractVersion", "id", "digest"],
    "attempt workload binding");
  requireCondition(value.workload.contractVersion === WORKLOAD_SPEC_VERSION &&
    value.workload.contractVersion === resolved.version &&
    value.workload.id === resolved.id && value.workload.digest === resolved.digest &&
    DIGEST_RE.test(value.workload.digest),
  "attempt workload binding does not match the resolved workload");
  const boundary = validateBoundary(value.boundary);
  validateProcess(value.process, boundary);
  const expectedOutcome = validateObservation(resolved, value.observation);
  requireCondition(canonicalJson(value.outcome) === canonicalJson(expectedOutcome),
    "attempt normalized outcome does not match its raw observation");
  validateCleanup(resolved, value.cleanup, value.observation, boundary, value.process);
  validateOutput(value.output, value.cleanup);
}

function validateRunnerExecution(value) {
  exactKeys(value, ["cpuAffinity"], "attempt runner execution context");
  if (value.cpuAffinity === null) return;
  exactKeys(value.cpuAffinity, [
    "requestedCpu", "supervisorAllowedCpuList", "workloadAllowedCpuList",
  ], "attempt runner CPU-affinity context");
  requireCondition(Number.isSafeInteger(value.cpuAffinity.requestedCpu) &&
    value.cpuAffinity.requestedCpu >= 0 && value.cpuAffinity.requestedCpu <= 65_535,
  "attempt runner requested CPU is invalid");
  for (const key of ["supervisorAllowedCpuList", "workloadAllowedCpuList"]) {
    requireCondition(value.cpuAffinity[key] === null ||
      (typeof value.cpuAffinity[key] === "string" && /^[0-9,-]+$/.test(value.cpuAffinity[key])),
    `attempt runner ${key} is invalid`);
  }
}

export function parseAttemptEvidence(resolved, value) {
  validateRecord(resolved, value);
  return deepFreeze(canonicalize(value));
}

export function buildAttemptEvidence(resolved, result) {
  exactKeys(result, [
    "version",
    "workloadDigest",
    "execution",
    "boundary",
    "process",
    "observation",
    "outcome",
    "cleanup",
    "output",
  ], "attempt runner result");
  requireCondition(result.version === ATTEMPT_RESULT_VERSION,
    `attempt runner result version must be ${ATTEMPT_RESULT_VERSION}`);
  requireCondition(result.workloadDigest === resolved.digest,
    "attempt runner result belongs to a different workload");
  validateRunnerExecution(result.execution);
  return parseAttemptEvidence(resolved, {
    version: ATTEMPT_EVIDENCE_VERSION,
    workload: {
      contractVersion: resolved.version,
      id: resolved.id,
      digest: resolved.digest,
    },
    boundary: result.boundary,
    process: result.process,
    observation: result.observation,
    outcome: result.outcome,
    cleanup: result.cleanup,
    output: result.output,
  });
}

export function canonicalAttemptEvidenceJson(resolved, value) {
  return canonicalJson(parseAttemptEvidence(resolved, value));
}

export function canonicalAttemptEvidenceLine(resolved, value) {
  return Buffer.from(`${canonicalAttemptEvidenceJson(resolved, value)}\n`, "utf8");
}

export function attemptEvidenceBinding(resolved, value) {
  const bytes = canonicalAttemptEvidenceLine(resolved, value);
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
