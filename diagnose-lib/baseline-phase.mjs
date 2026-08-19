import { createHash } from "node:crypto";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { runWorkloadAttempt } from "./attempt-runner.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import { MAX_SCHEDULE_ENTRIES } from "./pinned-runner.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const BASELINE_PHASE_VERSION = 1;
export const BASELINE_SCHEDULE_VERSION = 1;
export const BASELINE_WAVE_ENVELOPE_VERSION = 1;
export const MAX_BASELINE_CHILDREN = 64;
export const MAX_BASELINE_WAVES = 65_536;

const PHASE = "baseline-concurrent";
const SCHEDULE_ALGORITHM = "fixed-concurrent-waves-v1";
const CONCURRENCY_MODE = "independent-supervisors-v1";
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class BaselinePhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaselinePhaseError";
    this.code = "INVALID_BASELINE_PHASE";
  }
}

function fail(message) {
  throw new BaselinePhaseError(message);
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

function canonicalLine(value) {
  return Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
}

function bindingForBytes(bytes) {
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

function canonicalInteger(value, label, maximum) {
  requireCondition(Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    `${label} must be an integer from 1 through ${maximum}`);
  return value;
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  requireCondition(resolved.capabilities?.baseline === true,
    "workload does not declare baseline concurrent-wave support");
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
  `${label} does not match the resolved workload`);
  return expected;
}

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "baseline phase generation must be exactly 32 lowercase hexadecimal characters");
  return value;
}

function scheduleIdentity({ childrenPerWave, waves }) {
  canonicalInteger(childrenPerWave, "baseline children per wave", MAX_BASELINE_CHILDREN);
  canonicalInteger(waves, "baseline wave count", MAX_BASELINE_WAVES);
  const attemptCount = childrenPerWave * waves;
  requireCondition(attemptCount <= MAX_SCHEDULE_ENTRIES,
    `baseline schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
  return {
    version: BASELINE_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    childrenPerWave,
    waves,
    attemptCount,
  };
}

function scheduleDigest(identity) {
  return createHash("sha256").update(canonicalLine(identity)).digest("hex");
}

function validateSchedule(value) {
  exactKeys(value, [
    "version", "algorithm", "childrenPerWave", "waves", "attemptCount", "digest",
  ], "baseline schedule");
  requireCondition(value.version === BASELINE_SCHEDULE_VERSION,
    `baseline schedule version must be ${BASELINE_SCHEDULE_VERSION}`);
  requireCondition(value.algorithm === SCHEDULE_ALGORITHM,
    "baseline schedule algorithm is unsupported");
  requireCondition(typeof value.digest === "string" && DIGEST_RE.test(value.digest),
    "baseline schedule digest is invalid");
  const identity = scheduleIdentity(value);
  const { digest, ...actualIdentity } = value;
  requireCondition(canonicalProtocolJson(actualIdentity) === canonicalProtocolJson(identity),
    "baseline schedule does not match its canonical identity");
  requireCondition(digest === scheduleDigest(identity),
    "baseline schedule digest does not match its identity");
  return identity;
}

function validateExecution(value) {
  exactKeys(value, ["concurrencyMode"], "baseline execution context");
  requireCondition(value.concurrencyMode === CONCURRENCY_MODE,
    "baseline concurrency mode is unsupported");
}

function validateManifest(resolved, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "execution", "schedule",
  ], "baseline phase manifest");
  requireCondition(value.version === BASELINE_PHASE_VERSION,
    `baseline phase version must be ${BASELINE_PHASE_VERSION}`);
  requireCondition(value.phase === PHASE, "baseline phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(resolved, value.workload, "baseline phase workload binding");
  validateExecution(value.execution);
  return validateSchedule(value.schedule);
}

export function buildBaselinePhaseManifest(resolved, options) {
  exactKeys(options, ["generation", "childrenPerWave", "waves"],
    "baseline phase options");
  validateGeneration(options.generation);
  const identity = scheduleIdentity(options);
  return parseBaselinePhaseManifest(resolved, {
    version: BASELINE_PHASE_VERSION,
    phase: PHASE,
    generation: options.generation,
    workload: workloadBinding(resolved),
    execution: { concurrencyMode: CONCURRENCY_MODE },
    schedule: { ...identity, digest: scheduleDigest(identity) },
  });
}

function parseManifestContext(resolved, value) {
  const schedule = validateManifest(resolved, value);
  return { manifest: canonicalClone(value), schedule };
}

export function parseBaselinePhaseManifest(resolved, value) {
  return parseManifestContext(resolved, value).manifest;
}

export function canonicalBaselinePhaseManifestLine(resolved, value) {
  return canonicalLine(parseBaselinePhaseManifest(resolved, value));
}

export function baselinePhaseManifestBinding(resolved, value) {
  return bindingForBytes(canonicalBaselinePhaseManifestLine(resolved, value));
}

function expectedSlot(schedule, waveOrdinal, position) {
  return {
    ordinal: (waveOrdinal - 1) * schedule.childrenPerWave + position,
    wave: waveOrdinal,
    position,
  };
}

function validateSlot(value, expected) {
  exactKeys(value, ["ordinal", "wave", "position"], "baseline attempt slot");
  requireCondition(value.ordinal === expected.ordinal && value.wave === expected.wave &&
    value.position === expected.position,
  "baseline attempt slot does not match the deterministic wave schedule");
}

function validateAttemptBinding(value, expected) {
  exactKeys(value, ["sha256", "bytes"], "baseline attempt evidence binding");
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  "baseline attempt evidence binding does not match its canonical record");
}

function parseBoundAttemptEvidence(resolved, value) {
  try {
    return parseAttemptEvidence(resolved, value);
  } catch (error) {
    fail(`baseline attempt evidence is invalid: ${error.message}`);
  }
}

function validateWaveEnvelope(resolved, manifest, schedule, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "scheduleDigest", "wave", "attempts",
  ], "baseline wave envelope");
  requireCondition(value.version === BASELINE_WAVE_ENVELOPE_VERSION,
    `baseline wave envelope version must be ${BASELINE_WAVE_ENVELOPE_VERSION}`);
  requireCondition(value.phase === PHASE && value.generation === manifest.generation,
    "baseline wave envelope belongs to a different phase generation");
  validateWorkloadBinding(resolved, value.workload, "baseline wave workload binding");
  requireCondition(value.scheduleDigest === manifest.schedule.digest,
    "baseline wave envelope belongs to a different schedule");
  exactKeys(value.wave, ["ordinal", "childCount"], "baseline wave identity");
  canonicalInteger(value.wave.ordinal, "baseline wave ordinal", schedule.waves);
  requireCondition(value.wave.childCount === schedule.childrenPerWave,
    "baseline wave child count does not match the schedule");
  requireCondition(Array.isArray(value.attempts) &&
    value.attempts.length === schedule.childrenPerWave,
  "baseline wave must contain exactly one attempt for every child position");
  for (const [index, boundAttempt] of value.attempts.entries()) {
    exactKeys(boundAttempt, ["slot", "attempt"], "baseline bound attempt");
    validateSlot(boundAttempt.slot, expectedSlot(schedule, value.wave.ordinal, index + 1));
    exactKeys(boundAttempt.attempt, ["binding", "evidence"],
      "baseline bound attempt evidence");
    const evidence = parseBoundAttemptEvidence(resolved, boundAttempt.attempt.evidence);
    requireCondition(evidence.outcome.validOutcome === true,
      "operationally invalid attempt evidence cannot occupy a baseline wave");
    validateAttemptBinding(boundAttempt.attempt.binding,
      attemptEvidenceBinding(resolved, evidence));
  }
}

export function buildBaselineWaveEnvelope(
  resolved,
  manifestValue,
  waveOrdinal,
  evidenceValues,
) {
  const { manifest, schedule } = parseManifestContext(resolved, manifestValue);
  canonicalInteger(waveOrdinal, "baseline wave ordinal", schedule.waves);
  requireCondition(Array.isArray(evidenceValues) &&
    evidenceValues.length === schedule.childrenPerWave,
  "baseline wave evidence must contain exactly one record per child");
  const attempts = evidenceValues.map((evidenceValue, index) => {
    const evidence = parseBoundAttemptEvidence(resolved, evidenceValue);
    return {
      slot: expectedSlot(schedule, waveOrdinal, index + 1),
      attempt: {
        binding: attemptEvidenceBinding(resolved, evidence),
        evidence,
      },
    };
  });
  const envelope = {
    version: BASELINE_WAVE_ENVELOPE_VERSION,
    phase: PHASE,
    generation: manifest.generation,
    workload: workloadBinding(resolved),
    scheduleDigest: manifest.schedule.digest,
    wave: { ordinal: waveOrdinal, childCount: schedule.childrenPerWave },
    attempts,
  };
  validateWaveEnvelope(resolved, manifest, schedule, envelope);
  return canonicalClone(envelope);
}

export function parseBaselineWaveEnvelope(resolved, manifestValue, value) {
  const { manifest, schedule } = parseManifestContext(resolved, manifestValue);
  validateWaveEnvelope(resolved, manifest, schedule, value);
  return canonicalClone(value);
}

export function canonicalBaselineWaveEnvelopeLine(resolved, manifest, value) {
  return canonicalLine(parseBaselineWaveEnvelope(resolved, manifest, value));
}

export function baselineWaveEnvelopeBinding(resolved, manifest, value) {
  return bindingForBytes(canonicalBaselineWaveEnvelopeLine(resolved, manifest, value));
}

function assessPrefixWithContext(resolved, { manifest, schedule }, envelopeValues) {
  requireCondition(Array.isArray(envelopeValues) && envelopeValues.length <= schedule.waves,
    "baseline phase prefix is longer than its schedule");
  for (const [index, value] of envelopeValues.entries()) {
    validateWaveEnvelope(resolved, manifest, schedule, value);
    requireCondition(value.wave.ordinal === index + 1,
      "baseline phase state is not an exact contiguous wave prefix");
  }
  const committedWaves = envelopeValues.length;
  const committedAttempts = committedWaves * schedule.childrenPerWave;
  const complete = committedWaves === schedule.waves;
  return deepFreeze({
    status: complete ? "complete" : committedWaves === 0 ? "empty" : "incomplete",
    complete,
    committedWaves,
    totalWaves: schedule.waves,
    committedAttempts,
    totalAttempts: schedule.attemptCount,
    nextWave: complete ? null : {
      ordinal: committedWaves + 1,
      firstAttemptOrdinal: committedAttempts + 1,
      childCount: schedule.childrenPerWave,
    },
  });
}

export function assessBaselinePhasePrefix(resolved, manifestValue, envelopeValues = []) {
  return assessPrefixWithContext(resolved, parseManifestContext(resolved, manifestValue),
    envelopeValues);
}

function validateAttemptOptions(value) {
  const options = value ?? {};
  plainObject(options, "baseline wave attempt options");
  const allowed = new Set([
    "signal", "stdoutExcerptBytes", "stderrExcerptBytes", "retainedDirectory",
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `baseline wave attempt options contain unknown field '${unknown.sort()[0]}'`);
  return options;
}

function normalizedErrorCode(error, fallback = "RUNNER_ERROR") {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

export async function runNextBaselinePhaseWave({
  resolved,
  manifest: manifestValue,
  envelopes = [],
  runAttempt = runWorkloadAttempt,
  attemptOptions = {},
}) {
  requireCondition(typeof runAttempt === "function", "runAttempt must be a function");
  const context = parseManifestContext(resolved, manifestValue);
  const { manifest, schedule } = context;
  const progress = assessPrefixWithContext(resolved, context, envelopes);
  if (progress.complete) {
    return deepFreeze({ committed: false, reason: "complete", wave: null, envelope: null });
  }
  const options = validateAttemptOptions(attemptOptions);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.signal !== undefined) {
    requireCondition(options.signal !== null && typeof options.signal === "object" &&
      typeof options.signal.aborted === "boolean" &&
      typeof options.signal.addEventListener === "function" &&
      typeof options.signal.removeEventListener === "function",
    "baseline wave attempt options.signal must be an AbortSignal");
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }
  const { signal: _externalSignal, ...runnerOptions } = options;
  const wave = progress.nextWave;
  let firstFailure = null;
  const recordFailure = (failure) => {
    if (firstFailure === null) firstFailure = failure;
    controller.abort();
  };
  let attempts;
  try {
    attempts = await Promise.all(Array.from(
      { length: schedule.childrenPerWave },
      async (_, index) => {
        const slot = expectedSlot(schedule, wave.ordinal, index + 1);
        let result;
        try {
          result = await runAttempt(resolved, {
            ...runnerOptions,
            signal: controller.signal,
          });
        } catch (error) {
          const failure = {
            status: "runner-error",
            slot,
            errorCode: normalizedErrorCode(error),
          };
          recordFailure(failure);
          return failure;
        }
        let evidence;
        try {
          evidence = buildAttemptEvidence(resolved, result);
        } catch (error) {
          const failure = {
            status: "runner-error",
            slot,
            errorCode: normalizedErrorCode(error, "INVALID_ATTEMPT_RESULT"),
          };
          recordFailure(failure);
          return failure;
        }
        if (evidence.outcome.validOutcome !== true) {
          const failure = { status: "operational-invalid", slot, evidence };
          recordFailure(failure);
          return failure;
        }
        return { status: "valid", slot, evidence };
      },
    ));
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
  if (firstFailure !== null) {
    return deepFreeze({
      committed: false,
      reason: firstFailure.status,
      errorCode: firstFailure.errorCode ?? null,
      wave,
      envelope: null,
      attempts,
    });
  }
  const envelope = buildBaselineWaveEnvelope(
    resolved,
    manifest,
    wave.ordinal,
    attempts.map(({ evidence }) => evidence),
  );
  return deepFreeze({
    committed: true,
    reason: "committed",
    wave,
    envelope,
  });
}
