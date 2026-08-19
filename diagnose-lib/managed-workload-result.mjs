import { createHash } from "node:crypto";

import { buildAttemptEvidence } from "./attempt-evidence.mjs";
import {
  ATTEMPT_RESULT_VERSION,
  MANAGED_WORKLOAD_RESULT_VERSION,
} from "./attempt-runner.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class ManagedWorkloadResultError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedWorkloadResultError";
    this.code = "INVALID_MANAGED_WORKLOAD_RESULT";
  }
}

function fail(message) {
  throw new ManagedWorkloadResultError(message);
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

function emptyOutput() {
  return {
    bytes: "0",
    sha256: createHash("sha256").digest("hex"),
    excerptBase64: "",
    excerptBytes: 0,
    truncated: false,
    complete: true,
    errorCode: null,
  };
}

function validateReadiness(value, result) {
  exactKeys(value, ["reported", "errorCode"], "managed workload readiness");
  requireCondition(typeof value.reported === "boolean" &&
    (value.errorCode === null ||
      (typeof value.errorCode === "string" && ERROR_CODE_RE.test(value.errorCode))),
  "managed workload readiness is invalid");
  requireCondition(!value.reported || value.errorCode === null,
    "reported managed readiness cannot contain an error");
  if (value.reported) {
    requireCondition(result.process.supervisor !== null && result.process.workload !== null &&
      result.boundary.workloadStartedMonotonicNs !== null,
    "reported managed readiness requires bound process identities");
  }
  if (value.errorCode !== null) {
    requireCondition(result.observation.terminalReason === "external-cancel",
      "managed readiness errors must cancel the workload");
  }
}

export function parseManagedWorkloadResult(resolved, value) {
  exactKeys(value, [
    "version", "workloadDigest", "outputMode", "readiness", "execution",
    "boundary", "process", "observation", "outcome", "cleanup",
  ], "managed workload result");
  requireCondition(value.version === MANAGED_WORKLOAD_RESULT_VERSION,
    `managed workload result version must be ${MANAGED_WORKLOAD_RESULT_VERSION}`);
  requireCondition(value.workloadDigest === resolved.digest,
    "managed workload result belongs to a different workload");
  requireCondition(value.outputMode === "discard",
    "managed workload output mode is unsupported");
  try {
    buildAttemptEvidence(resolved, {
      version: ATTEMPT_RESULT_VERSION,
      workloadDigest: value.workloadDigest,
      execution: value.execution,
      boundary: value.boundary,
      process: value.process,
      observation: value.observation,
      outcome: value.outcome,
      cleanup: value.cleanup,
      output: { stdout: emptyOutput(), stderr: emptyOutput() },
    });
  } catch (error) {
    fail(`managed workload lifecycle is invalid: ${error.message}`);
  }
  validateReadiness(value.readiness, value);
  return canonicalClone(value);
}

export function canonicalManagedWorkloadResultLine(resolved, value) {
  return Buffer.from(`${canonicalProtocolJson(parseManagedWorkloadResult(resolved, value))}\n`,
    "utf8");
}

export function managedWorkloadResultBinding(resolved, value) {
  const bytes = canonicalManagedWorkloadResultLine(resolved, value);
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
