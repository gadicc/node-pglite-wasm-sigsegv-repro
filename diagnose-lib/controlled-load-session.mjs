import { createHash } from "node:crypto";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { runWorkloadAttempt } from "./attempt-runner.mjs";
import {
  canonicalControlledLoadWorkerSetBoundaryLine,
  canonicalControlledLoadWorkerSetStartLine,
  canonicalControlledLoadWorkerSetStopLine,
  CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS,
  parseControlledLoadWorkerSetBoundaryEvidence,
  parseControlledLoadWorkerSetStartEvidence,
  parseControlledLoadWorkerSetStopEvidence,
  startControlledLoadWorkerSet,
} from "./controlled-load-workers.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import { MAX_SCHEDULE_ENTRIES } from "./pinned-runner.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const CONTROLLED_LOAD_SESSION_MANIFEST_VERSION = 1;
export const CONTROLLED_LOAD_SESSION_SCHEDULE_VERSION = 1;
export const CONTROLLED_LOAD_SESSION_ENVELOPE_VERSION = 1;
export const MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG = Math.floor(MAX_SCHEDULE_ENTRIES / 3);

const PHASE = "controlled-load-aba";
const SCHEDULE_ALGORITHM = "fixed-single-workload-aba-v1";
const TARGET_AFFINITY_MODE = "inherited-singleton-v1";
const LEGS = Object.freeze([
  Object.freeze({ leg: "a1", condition: "without-load" }),
  Object.freeze({ leg: "b", condition: "with-load" }),
  Object.freeze({ leg: "a2", condition: "after-recovery" }),
]);
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_CPU = 65_535;
const MAX_INTERVAL_MS = 3_600_000;

export class ControlledLoadSessionError extends Error {
  constructor(message, code = "INVALID_CONTROLLED_LOAD_SESSION") {
    super(message);
    this.name = "ControlledLoadSessionError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ControlledLoadSessionError(message, code);
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

function allowedKeys(value, allowed, label) {
  plainObject(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  requireCondition(unexpected.length === 0,
    `${label} contains unknown field '${unexpected.sort()[0]}'`);
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

function decimal(value, label) {
  requireCondition(typeof value === "string" && /^(0|[1-9][0-9]{0,31})$/.test(value),
    `${label} must be a canonical bounded decimal string`);
  return BigInt(value);
}

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "controlled-load generation must be exactly 32 lowercase hexadecimal characters");
  return value;
}

function validateTasksetPath(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  "controlled-load taskset path must be a bounded absolute NUL-free path");
  return value;
}

function validateCpuList(value) {
  requireCondition(Array.isArray(value) && value.length >= 1 &&
    value.length <= CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS,
  `controlled-load worker CPUs must contain 1 through ${CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS} entries`);
  return value.map((cpu, index) => {
    canonicalInteger(cpu, `controlled-load worker CPUs[${index}]`, 0, MAX_CPU);
    requireCondition(index === 0 || cpu > value[index - 1],
      "controlled-load worker CPUs must be strictly increasing");
    return cpu;
  });
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  return Object.freeze({
    contractVersion: resolved.version,
    id: resolved.id,
    digest: resolved.digest,
  });
}

function validateWorkloadBinding(resolved, value, label) {
  exactKeys(value, ["contractVersion", "id", "digest"], label);
  const expected = workloadBinding(resolved);
  requireCondition(value.contractVersion === expected.contractVersion &&
    value.id === expected.id && value.digest === expected.digest,
  `${label} does not match its resolved workload`);
  return expected;
}

function scheduleIdentity(options) {
  canonicalInteger(options.attemptsPerLeg, "controlled-load attempts per leg", 1,
    MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG);
  canonicalInteger(options.warmupMs, "controlled-load warm-up interval", 0, MAX_INTERVAL_MS);
  canonicalInteger(options.recoveryMs, "controlled-load recovery interval", 0, MAX_INTERVAL_MS);
  return {
    version: CONTROLLED_LOAD_SESSION_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    legs: LEGS.map(({ leg, condition }) => ({ leg, condition })),
    attemptsPerLeg: options.attemptsPerLeg,
    attemptCount: options.attemptsPerLeg * LEGS.length,
    warmupMs: options.warmupMs,
    recoveryMs: options.recoveryMs,
  };
}

function scheduleDigest(identity) {
  return createHash("sha256").update(canonicalLine(identity)).digest("hex");
}

function validateSchedule(value) {
  exactKeys(value, [
    "version", "algorithm", "legs", "attemptsPerLeg", "attemptCount",
    "warmupMs", "recoveryMs", "digest",
  ], "controlled-load schedule");
  requireCondition(value.version === CONTROLLED_LOAD_SESSION_SCHEDULE_VERSION &&
    value.algorithm === SCHEDULE_ALGORITHM,
  "controlled-load schedule version or algorithm is unsupported");
  requireCondition(typeof value.digest === "string" && DIGEST_RE.test(value.digest),
    "controlled-load schedule digest is invalid");
  const identity = scheduleIdentity(value);
  const { digest, ...actual } = value;
  requireCondition(canonicalProtocolJson(actual) === canonicalProtocolJson(identity),
    "controlled-load schedule does not match its fixed A/B/A identity");
  requireCondition(digest === scheduleDigest(identity),
    "controlled-load schedule digest does not match its identity");
  return identity;
}

function validateExecution(value) {
  exactKeys(value, [
    "targetCpu", "targetAffinityMode", "workerCpus", "tasksetPath", "workerOutputMode",
  ], "controlled-load execution context");
  canonicalInteger(value.targetCpu, "controlled-load target CPU", 0, MAX_CPU);
  requireCondition(value.targetAffinityMode === TARGET_AFFINITY_MODE,
    "controlled-load target affinity mode is unsupported");
  const workerCpus = validateCpuList(value.workerCpus);
  requireCondition(!workerCpus.includes(value.targetCpu),
    "controlled-load target CPU must be outside the worker CPU set");
  validateTasksetPath(value.tasksetPath);
  requireCondition(value.workerOutputMode === "discard",
    "controlled-load worker output mode is unsupported");
}

function parseManifestContext(measured, auxiliary, value) {
  exactKeys(value, [
    "version", "phase", "generation", "measuredWorkload", "auxiliaryWorkload",
    "execution", "schedule",
  ], "controlled-load session manifest");
  requireCondition(value.version === CONTROLLED_LOAD_SESSION_MANIFEST_VERSION,
    `controlled-load manifest version must be ${CONTROLLED_LOAD_SESSION_MANIFEST_VERSION}`);
  requireCondition(value.phase === PHASE, "controlled-load phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(measured, value.measuredWorkload,
    "controlled-load measured workload binding");
  validateWorkloadBinding(auxiliary, value.auxiliaryWorkload,
    "controlled-load auxiliary workload binding");
  requireCondition(auxiliary.attempt.mode === "survive-window",
    "controlled-load auxiliary workload requires survive-window lifecycle semantics");
  validateExecution(value.execution);
  const schedule = validateSchedule(value.schedule);
  return { manifest: canonicalClone(value), schedule };
}

export function buildControlledLoadSessionManifest(measured, auxiliary, options) {
  exactKeys(options, [
    "generation", "attemptsPerLeg", "targetCpu", "workerCpus", "tasksetPath",
    "warmupMs", "recoveryMs",
  ], "controlled-load manifest options");
  validateGeneration(options.generation);
  const identity = scheduleIdentity(options);
  return parseControlledLoadSessionManifest(measured, auxiliary, {
    version: CONTROLLED_LOAD_SESSION_MANIFEST_VERSION,
    phase: PHASE,
    generation: options.generation,
    measuredWorkload: workloadBinding(measured),
    auxiliaryWorkload: workloadBinding(auxiliary),
    execution: {
      targetCpu: options.targetCpu,
      targetAffinityMode: TARGET_AFFINITY_MODE,
      workerCpus: options.workerCpus,
      tasksetPath: options.tasksetPath,
      workerOutputMode: "discard",
    },
    schedule: { ...identity, digest: scheduleDigest(identity) },
  });
}

export function parseControlledLoadSessionManifest(measured, auxiliary, value) {
  return parseManifestContext(measured, auxiliary, value).manifest;
}

export function canonicalControlledLoadSessionManifestLine(measured, auxiliary, value) {
  return canonicalLine(parseControlledLoadSessionManifest(measured, auxiliary, value));
}

export function controlledLoadSessionManifestBinding(measured, auxiliary, value) {
  return bindingForBytes(canonicalControlledLoadSessionManifestLine(measured, auxiliary, value));
}

function validateBinding(value, expected, label) {
  exactKeys(value, ["sha256", "bytes"], label);
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  `${label} does not match its canonical record`);
}

function parseMeasuredEvidence(measured, value) {
  try {
    return parseAttemptEvidence(measured, value);
  } catch (error) {
    fail(`controlled-load attempt evidence is invalid: ${error.message}`);
  }
}

function validateMeasuredAffinity(affinity, manifest) {
  exactKeys(affinity, [
    "mode", "requestedCpu", "supervisorAllowedCpuList", "workloadAllowedCpuList",
  ], "controlled-load measured affinity witness");
  const expected = String(manifest.execution.targetCpu);
  requireCondition(affinity.mode === manifest.execution.targetAffinityMode &&
    affinity.requestedCpu === manifest.execution.targetCpu &&
    affinity.supervisorAllowedCpuList === expected &&
    affinity.workloadAllowedCpuList === expected,
  "controlled-load measured attempt does not match the target singleton CPU");
}

function measuredAffinityWitness(manifest, execution) {
  const affinity = execution?.cpuAffinity;
  requireCondition(affinity !== null && typeof affinity === "object" &&
    !Array.isArray(affinity),
  "controlled-load measured attempt is missing its target affinity witness");
  const witness = {
    mode: manifest.execution.targetAffinityMode,
    requestedCpu: affinity.requestedCpu,
    supervisorAllowedCpuList: affinity.supervisorAllowedCpuList,
    workloadAllowedCpuList: affinity.workloadAllowedCpuList,
  };
  validateMeasuredAffinity(witness, manifest);
  return witness;
}

function expectedSlot(attemptsPerLeg, legIndex, position) {
  return {
    ordinal: legIndex * attemptsPerLeg + position,
    leg: LEGS[legIndex].leg,
    position,
  };
}

function parseLeg(measured, manifest, value, legIndex) {
  exactKeys(value, ["leg", "condition", "attempts"], "controlled-load leg envelope");
  const expectedLeg = LEGS[legIndex];
  requireCondition(value.leg === expectedLeg.leg && value.condition === expectedLeg.condition,
    "controlled-load leg identity or order is invalid");
  const count = manifest.schedule.attemptsPerLeg;
  requireCondition(Array.isArray(value.attempts) && value.attempts.length === count,
    "controlled-load leg must contain every scheduled attempt");
  let previousCleanup = null;
  const attempts = value.attempts.map((bound, index) => {
    exactKeys(bound, ["slot", "affinity", "binding", "evidence"],
      "controlled-load bound attempt");
    exactKeys(bound.slot, ["ordinal", "leg", "position"], "controlled-load attempt slot");
    const slot = expectedSlot(count, legIndex, index + 1);
    requireCondition(bound.slot.ordinal === slot.ordinal && bound.slot.leg === slot.leg &&
      bound.slot.position === slot.position,
    "controlled-load attempt slot does not match the fixed schedule");
    const evidence = parseMeasuredEvidence(measured, bound.evidence);
    requireCondition(evidence.outcome.validOutcome === true,
      "operationally invalid evidence cannot occupy a controlled-load attempt slot");
    validateMeasuredAffinity(bound.affinity, manifest);
    validateBinding(bound.binding, attemptEvidenceBinding(measured, evidence),
      "controlled-load attempt binding");
    const started = decimal(evidence.boundary.attemptStartedMonotonicNs,
      "controlled-load attempt start");
    const cleanup = decimal(evidence.boundary.cleanupFinishedMonotonicNs,
      "controlled-load attempt cleanup");
    if (previousCleanup !== null) {
      requireCondition(previousCleanup <= started,
        "controlled-load attempts are not sequential within their leg");
    }
    previousCleanup = cleanup;
    return { slot, binding: bound.binding, evidence, started, cleanup };
  });
  return { attempts, first: attempts[0].started, last: attempts.at(-1).cleanup };
}

function parseBoundWorkerStart(auxiliary, value) {
  exactKeys(value, ["binding", "evidence"], "controlled-load bound worker start");
  const evidence = parseControlledLoadWorkerSetStartEvidence(auxiliary, value.evidence);
  validateBinding(value.binding,
    bindingForBytes(canonicalControlledLoadWorkerSetStartLine(auxiliary, evidence)),
    "controlled-load worker start binding");
  return evidence;
}

function parseBoundWorkerBoundary(auxiliary, start, value, expectedName) {
  exactKeys(value, ["binding", "evidence"], "controlled-load bound worker boundary");
  const evidence = parseControlledLoadWorkerSetBoundaryEvidence(auxiliary, start, value.evidence);
  requireCondition(evidence.boundary === expectedName,
    `controlled-load worker boundary must be ${expectedName}`);
  validateBinding(value.binding,
    bindingForBytes(canonicalControlledLoadWorkerSetBoundaryLine(auxiliary, start, evidence)),
    "controlled-load worker boundary binding");
  return evidence;
}

function parseBoundWorkerStop(auxiliary, start, value) {
  exactKeys(value, ["binding", "evidence"], "controlled-load bound worker stop");
  const evidence = parseControlledLoadWorkerSetStopEvidence(auxiliary, start, value.evidence);
  requireCondition(evidence.reason === "complete" && evidence.valid === true &&
    evidence.failureCode === null,
  "controlled-load worker stop is not a valid planned completion");
  validateBinding(value.binding,
    bindingForBytes(canonicalControlledLoadWorkerSetStopLine(auxiliary, start, evidence)),
    "controlled-load worker stop binding");
  return evidence;
}

function boundAttempt(measured, manifest, slot, attemptValue) {
  exactKeys(attemptValue, ["evidence", "affinity"], "controlled-load attempt input");
  const evidence = parseMeasuredEvidence(measured, attemptValue.evidence);
  validateMeasuredAffinity(attemptValue.affinity, manifest);
  return {
    slot,
    affinity: attemptValue.affinity,
    binding: attemptEvidenceBinding(measured, evidence),
    evidence,
  };
}

function boundWorker(bytes, evidence) {
  return { binding: bindingForBytes(bytes), evidence };
}

function validateEnvelope(measured, auxiliary, manifest, value) {
  exactKeys(value, [
    "version", "phase", "generation", "measuredWorkload", "auxiliaryWorkload",
    "scheduleDigest", "legs", "condition",
  ], "controlled-load session envelope");
  requireCondition(value.version === CONTROLLED_LOAD_SESSION_ENVELOPE_VERSION,
    `controlled-load envelope version must be ${CONTROLLED_LOAD_SESSION_ENVELOPE_VERSION}`);
  requireCondition(value.phase === PHASE && value.generation === manifest.generation,
    "controlled-load envelope belongs to a different phase generation");
  validateWorkloadBinding(measured, value.measuredWorkload,
    "controlled-load envelope measured workload binding");
  validateWorkloadBinding(auxiliary, value.auxiliaryWorkload,
    "controlled-load envelope auxiliary workload binding");
  requireCondition(value.scheduleDigest === manifest.schedule.digest,
    "controlled-load envelope belongs to a different schedule");
  requireCondition(Array.isArray(value.legs) && value.legs.length === LEGS.length,
    "controlled-load envelope must contain A1, B, and A2 exactly once");
  const legs = value.legs.map((leg, index) => parseLeg(measured, manifest, leg, index));

  exactKeys(value.condition, ["workerSetStart", "beforeB", "afterB", "workerSetStop"],
    "controlled-load condition evidence");
  const start = parseBoundWorkerStart(auxiliary, value.condition.workerSetStart);
  requireCondition(start.execution.tasksetPath === manifest.execution.tasksetPath &&
    canonicalProtocolJson(start.cpus) === canonicalProtocolJson(manifest.execution.workerCpus),
  "controlled-load worker set does not match the session execution context");
  const before = parseBoundWorkerBoundary(auxiliary, start, value.condition.beforeB, "before-b");
  const after = parseBoundWorkerBoundary(auxiliary, start, value.condition.afterB, "after-b");
  const stop = parseBoundWorkerStop(auxiliary, start, value.condition.workerSetStop);

  const readyNs = decimal(start.readyMonotonicNs, "controlled-load complete readiness");
  const beforeNs = decimal(before.monotonicNs, "controlled-load before-B boundary");
  const afterNs = decimal(after.monotonicNs, "controlled-load after-B boundary");
  const stoppedNs = decimal(stop.stoppedMonotonicNs, "controlled-load stopped boundary");
  const warmupNs = BigInt(manifest.schedule.warmupMs) * 1_000_000n;
  const recoveryNs = BigInt(manifest.schedule.recoveryMs) * 1_000_000n;
  requireCondition(legs[0].last <= readyNs,
    "controlled-load workers became ready before A1 completed");
  requireCondition(readyNs + warmupNs <= beforeNs && beforeNs <= legs[1].first,
    "controlled-load before-B boundary does not bracket B");
  requireCondition(legs[1].last <= afterNs && afterNs <= stoppedNs,
    "controlled-load after-B boundary does not bracket B cleanup and worker stop");
  requireCondition(stoppedNs + recoveryNs <= legs[2].first,
    "controlled-load A2 began before the worker set completely stopped");
}

export function buildControlledLoadSessionEnvelope(
  measured,
  auxiliary,
  manifestValue,
  { legs, workerSetStart, beforeB, afterB, workerSetStop },
) {
  const { manifest } = parseManifestContext(measured, auxiliary, manifestValue);
  requireCondition(Array.isArray(legs) && legs.length === LEGS.length,
    "controlled-load envelope input must contain three leg attempt arrays");
  const envelope = {
    version: CONTROLLED_LOAD_SESSION_ENVELOPE_VERSION,
    phase: PHASE,
    generation: manifest.generation,
    measuredWorkload: workloadBinding(measured),
    auxiliaryWorkload: workloadBinding(auxiliary),
    scheduleDigest: manifest.schedule.digest,
    legs: legs.map((attempts, legIndex) => ({
      leg: LEGS[legIndex].leg,
      condition: LEGS[legIndex].condition,
      attempts: attempts.map((evidence, index) => boundAttempt(
        measured,
        manifest,
        expectedSlot(manifest.schedule.attemptsPerLeg, legIndex, index + 1),
        evidence,
      )),
    })),
    condition: {
      workerSetStart: boundWorker(
        canonicalControlledLoadWorkerSetStartLine(auxiliary, workerSetStart),
        parseControlledLoadWorkerSetStartEvidence(auxiliary, workerSetStart),
      ),
      beforeB: boundWorker(
        canonicalControlledLoadWorkerSetBoundaryLine(auxiliary, workerSetStart, beforeB),
        parseControlledLoadWorkerSetBoundaryEvidence(auxiliary, workerSetStart, beforeB),
      ),
      afterB: boundWorker(
        canonicalControlledLoadWorkerSetBoundaryLine(auxiliary, workerSetStart, afterB),
        parseControlledLoadWorkerSetBoundaryEvidence(auxiliary, workerSetStart, afterB),
      ),
      workerSetStop: boundWorker(
        canonicalControlledLoadWorkerSetStopLine(auxiliary, workerSetStart, workerSetStop),
        parseControlledLoadWorkerSetStopEvidence(auxiliary, workerSetStart, workerSetStop),
      ),
    },
  };
  validateEnvelope(measured, auxiliary, manifest, envelope);
  return canonicalClone(envelope);
}

export function parseControlledLoadSessionEnvelope(measured, auxiliary, manifestValue, value) {
  const { manifest } = parseManifestContext(measured, auxiliary, manifestValue);
  validateEnvelope(measured, auxiliary, manifest, value);
  return canonicalClone(value);
}

export function canonicalControlledLoadSessionEnvelopeLine(
  measured,
  auxiliary,
  manifest,
  value,
) {
  return canonicalLine(parseControlledLoadSessionEnvelope(measured, auxiliary, manifest, value));
}

export function controlledLoadSessionEnvelopeBinding(measured, auxiliary, manifest, value) {
  return bindingForBytes(canonicalControlledLoadSessionEnvelopeLine(
    measured,
    auxiliary,
    manifest,
    value,
  ));
}

function validateSignal(value) {
  if (value === undefined) return null;
  requireCondition(value !== null && typeof value === "object" &&
    typeof value.aborted === "boolean" && typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function",
  "controlled-load session signal must be an AbortSignal");
  return value;
}

function validateAttemptOptions(value) {
  const options = value ?? {};
  allowedKeys(options, ["stdoutExcerptBytes", "stderrExcerptBytes"],
    "controlled-load attempt options");
  return options;
}

function normalizedErrorCode(error, fallback) {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

function waitForInterval(milliseconds, signal) {
  if (signal?.aborted || milliseconds === 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    let timer;
    const finish = (completed) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function failedSession(reason, stage, errorCode, attempts, condition) {
  return deepFreeze({
    committed: false,
    reason,
    stage,
    errorCode,
    envelope: null,
    attempts,
    condition,
  });
}

export async function runControlledLoadSession(rawOptions) {
  const options = plainObject(rawOptions, "controlled-load session runner options");
  allowedKeys(options, [
    "measured", "auxiliary", "manifest", "signal", "retainedDirectory",
    "attemptOptions", "runAttempt", "startWorkerSet", "waitInterval",
  ], "controlled-load session runner options");
  requireCondition(Object.hasOwn(options, "measured") &&
    Object.hasOwn(options, "auxiliary") && Object.hasOwn(options, "manifest"),
  "controlled-load session runner requires measured, auxiliary, and manifest");
  const { manifest } = parseManifestContext(
    options.measured,
    options.auxiliary,
    options.manifest,
  );
  const signal = validateSignal(options.signal);
  const attemptOptions = validateAttemptOptions(options.attemptOptions);
  const runAttempt = options.runAttempt ?? runWorkloadAttempt;
  const startWorkerSet = options.startWorkerSet ?? startControlledLoadWorkerSet;
  const waitInterval = options.waitInterval ?? waitForInterval;
  requireCondition(typeof runAttempt === "function" && typeof startWorkerSet === "function" &&
    typeof waitInterval === "function",
  "controlled-load session dependencies must be functions");

  const attempts = { a1: [], b: [], a2: [] };
  const condition = {
    workerSetStart: null,
    beforeB: null,
    afterB: null,
    workerSetStop: null,
  };
  const runLeg = async (leg) => {
    for (let position = 1; position <= manifest.schedule.attemptsPerLeg; position += 1) {
      if (signal?.aborted) {
        return { ok: false, reason: "external-cancel", errorCode: "CONTROLLED_LOAD_EXTERNAL_CANCEL" };
      }
      let result;
      try {
        result = await runAttempt(options.measured, {
          ...attemptOptions,
          ...(signal === null ? {} : { signal }),
          ...(options.retainedDirectory === undefined
            ? {} : { retainedDirectory: options.retainedDirectory }),
          cpuAffinity: {
            cpu: manifest.execution.targetCpu,
            tasksetPath: manifest.execution.tasksetPath,
          },
        });
      } catch (error) {
        return {
          ok: false,
          reason: "runner-error",
          errorCode: normalizedErrorCode(error, "CONTROLLED_LOAD_ATTEMPT_RUNNER_ERROR"),
        };
      }
      let evidence;
      try {
        evidence = buildAttemptEvidence(options.measured, result);
      } catch (error) {
        return {
          ok: false,
          reason: "evidence-invalid",
          errorCode: normalizedErrorCode(error, "CONTROLLED_LOAD_ATTEMPT_EVIDENCE_INVALID"),
        };
      }
      if (evidence.outcome.validOutcome !== true) {
        attempts[leg].push({ evidence, affinity: null });
        return { ok: false, reason: "operational-invalid", errorCode: null };
      }
      let affinity;
      try {
        affinity = measuredAffinityWitness(manifest, result.execution);
      } catch (error) {
        attempts[leg].push({ evidence, affinity: null });
        return {
          ok: false,
          reason: "evidence-invalid",
          errorCode: normalizedErrorCode(error, "CONTROLLED_LOAD_ATTEMPT_EVIDENCE_INVALID"),
        };
      }
      attempts[leg].push({ evidence, affinity });
    }
    return { ok: true };
  };

  const a1 = await runLeg("a1");
  if (!a1.ok) return failedSession(a1.reason, "a1", a1.errorCode, attempts, condition);

  let handle = null;
  try {
    handle = await startWorkerSet({
      resolved: options.auxiliary,
      cpus: manifest.execution.workerCpus,
      tasksetPath: manifest.execution.tasksetPath,
      ...(signal === null ? {} : { signal }),
      ...(options.retainedDirectory === undefined
        ? {} : { retainedDirectory: options.retainedDirectory }),
    });
    condition.workerSetStart = handle.startEvidence;
    const warmed = await waitInterval(manifest.schedule.warmupMs, signal);
    if (warmed === false || signal?.aborted) {
      condition.workerSetStop = await handle.stop("session-invalid");
      return failedSession("external-cancel", "warmup",
        "CONTROLLED_LOAD_EXTERNAL_CANCEL", attempts, condition);
    }
    condition.beforeB = handle.verify("before-b");
    const b = await runLeg("b");
    if (!b.ok) {
      condition.workerSetStop = await handle.stop("session-invalid");
      return failedSession(b.reason, "b", b.errorCode, attempts, condition);
    }
    condition.afterB = handle.verify("after-b");
    condition.workerSetStop = await handle.stop("complete");
    handle = null;
    if (condition.workerSetStop.valid !== true) {
      return failedSession("condition-invalid", "worker-stop",
        condition.workerSetStop.failureCode ?? "CONTROLLED_LOAD_WORKER_STOP_INVALID",
        attempts, condition);
    }
  } catch (error) {
    if (handle !== null) {
      try { condition.workerSetStop = await handle.stop("session-invalid"); } catch { /* bounded owner cleanup */ }
    }
    return failedSession("condition-invalid", "condition",
      normalizedErrorCode(error, "CONTROLLED_LOAD_CONDITION_INVALID"), attempts, condition);
  }

  const recovered = await waitInterval(manifest.schedule.recoveryMs, signal);
  if (recovered === false || signal?.aborted) {
    return failedSession("external-cancel", "recovery",
      "CONTROLLED_LOAD_EXTERNAL_CANCEL", attempts, condition);
  }
  const a2 = await runLeg("a2");
  if (!a2.ok) return failedSession(a2.reason, "a2", a2.errorCode, attempts, condition);

  let envelope;
  try {
    envelope = buildControlledLoadSessionEnvelope(
      options.measured,
      options.auxiliary,
      manifest,
      {
        legs: [attempts.a1, attempts.b, attempts.a2],
        workerSetStart: condition.workerSetStart,
        beforeB: condition.beforeB,
        afterB: condition.afterB,
        workerSetStop: condition.workerSetStop,
      },
    );
  } catch (error) {
    return failedSession("envelope-invalid", "envelope",
      normalizedErrorCode(error, "CONTROLLED_LOAD_ENVELOPE_INVALID"), attempts, condition);
  }
  return deepFreeze({
    committed: true,
    reason: "committed",
    stage: "complete",
    errorCode: null,
    envelope,
    attempts,
    condition,
  });
}
