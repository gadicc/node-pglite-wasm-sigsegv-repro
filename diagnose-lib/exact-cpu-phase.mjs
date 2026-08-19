import { createHash } from "node:crypto";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { runWorkloadAttempt } from "./attempt-runner.mjs";
import {
  buildIsolatedPlan,
  canonicalProtocolJson,
} from "./pinned-protocol.mjs";
import { MAX_SCHEDULE_ENTRIES } from "./pinned-runner.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const EXACT_CPU_PHASE_VERSION = 1;
export const EXACT_CPU_SCHEDULE_VERSION = 1;
export const EXACT_CPU_ATTEMPT_ENVELOPE_VERSION = 1;

const PHASE = "isolated-exact-cpu";
const SCHEDULE_ALGORITHM = "balanced-cyclic-v1";
const AFFINITY_MODE = "inherited-singleton-v1";
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export class ExactCpuPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExactCpuPhaseError";
    this.code = "INVALID_EXACT_CPU_PHASE";
  }
}

function fail(message) {
  throw new ExactCpuPhaseError(message);
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

function workloadBinding(resolved) {
  // This exported accessor also proves that `resolved` came from the workload
  // resolver rather than merely resembling its public JSON representation.
  workloadLaunchProvenance(resolved);
  requireCondition(resolved.capabilities?.isolated === true,
    "workload does not declare isolated exact-CPU support");
  return Object.freeze({
    contractVersion: resolved.version,
    id: resolved.id,
    digest: resolved.digest,
  });
}

function sameWorkload(left, right) {
  return left.contractVersion === right.contractVersion && left.id === right.id &&
    left.digest === right.digest;
}

function validateWorkloadBinding(resolved, value, label) {
  exactKeys(value, ["contractVersion", "id", "digest"], label);
  const expected = workloadBinding(resolved);
  requireCondition(sameWorkload(value, expected), `${label} does not match the resolved workload`);
  return expected;
}

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "phase generation must be exactly 32 lowercase hexadecimal characters");
  return value;
}

function validateTasksetPath(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  "affinity taskset path must be a bounded absolute NUL-free path");
  return value;
}

function scheduleIdentity(plan) {
  return {
    version: EXACT_CPU_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    seed: plan.seed,
    cpus: [...plan.cpus],
    rounds: plan.rounds,
    attemptCount: plan.records.length,
    plan: {
      sha256: plan.binding.sha256,
      bytes: plan.binding.bytes,
      recordCount: plan.binding.rowCount,
    },
  };
}

function scheduleDigest(identity) {
  return createHash("sha256").update(canonicalLine(identity)).digest("hex");
}

function validateSchedule(value) {
  exactKeys(value, [
    "version", "algorithm", "seed", "cpus", "rounds", "attemptCount", "plan", "digest",
  ], "exact-CPU schedule");
  requireCondition(value.version === EXACT_CPU_SCHEDULE_VERSION,
    `exact-CPU schedule version must be ${EXACT_CPU_SCHEDULE_VERSION}`);
  requireCondition(value.algorithm === SCHEDULE_ALGORITHM,
    "exact-CPU schedule algorithm is unsupported");
  requireCondition(typeof value.digest === "string" && DIGEST_RE.test(value.digest),
    "exact-CPU schedule digest is invalid");
  let plan;
  try {
    plan = buildIsolatedPlan({ cpus: value.cpus, rounds: value.rounds, seed: value.seed });
  } catch (error) {
    fail(`exact-CPU schedule parameters are invalid: ${error.message}`);
  }
  const identity = scheduleIdentity(plan);
  exactKeys(value.plan, ["sha256", "bytes", "recordCount"], "exact-CPU plan binding");
  const { digest, ...actualIdentity } = value;
  requireCondition(canonicalProtocolJson(actualIdentity) ===
    canonicalProtocolJson(identity), "exact-CPU schedule does not match its deterministic plan");
  requireCondition(digest === scheduleDigest(identity),
    "exact-CPU schedule digest does not match its identity");
  return plan;
}

function validateExecution(value) {
  exactKeys(value, ["affinityMode", "tasksetPath"], "exact-CPU execution context");
  requireCondition(value.affinityMode === AFFINITY_MODE,
    "exact-CPU affinity mode is unsupported");
  validateTasksetPath(value.tasksetPath);
}

function validateManifest(resolved, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "execution", "schedule",
  ], "exact-CPU phase manifest");
  requireCondition(value.version === EXACT_CPU_PHASE_VERSION,
    `exact-CPU phase version must be ${EXACT_CPU_PHASE_VERSION}`);
  requireCondition(value.phase === PHASE, "exact-CPU phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(resolved, value.workload, "exact-CPU phase workload binding");
  validateExecution(value.execution);
  return validateSchedule(value.schedule);
}

export function buildExactCpuPhaseManifest(resolved, options) {
  plainObject(options, "exact-CPU phase options");
  exactKeys(options, ["generation", "cpus", "rounds", "seed", "tasksetPath"],
    "exact-CPU phase options");
  validateGeneration(options.generation);
  validateTasksetPath(options.tasksetPath);
  let plan;
  try {
    plan = buildIsolatedPlan({
      cpus: options.cpus,
      rounds: options.rounds,
      seed: options.seed,
    });
  } catch (error) {
    fail(`exact-CPU schedule parameters are invalid: ${error.message}`);
  }
  const identity = scheduleIdentity(plan);
  return parseExactCpuPhaseManifest(resolved, {
    version: EXACT_CPU_PHASE_VERSION,
    phase: PHASE,
    generation: options.generation,
    workload: workloadBinding(resolved),
    execution: {
      affinityMode: AFFINITY_MODE,
      tasksetPath: options.tasksetPath,
    },
    schedule: { ...identity, digest: scheduleDigest(identity) },
  });
}

export function parseExactCpuPhaseManifest(resolved, value) {
  return parseManifestContext(resolved, value).manifest;
}

function parseManifestContext(resolved, value) {
  const plan = validateManifest(resolved, value);
  return { manifest: canonicalClone(value), plan };
}

export function canonicalExactCpuPhaseManifestLine(resolved, value) {
  return canonicalLine(parseExactCpuPhaseManifest(resolved, value));
}

export function exactCpuPhaseManifestBinding(resolved, value) {
  return bindingForBytes(canonicalExactCpuPhaseManifestLine(resolved, value));
}

function validateSlot(value, expected = null) {
  exactKeys(value, ["ordinal", "round", "position", "cpu"], "exact-CPU attempt slot");
  for (const key of ["ordinal", "round", "position", "cpu"]) {
    requireCondition(Number.isSafeInteger(value[key]) && value[key] >= (key === "cpu" ? 0 : 1),
      `exact-CPU attempt slot ${key} is invalid`);
  }
  if (expected !== null) {
    requireCondition(["ordinal", "round", "position", "cpu"].every((key) =>
      value[key] === expected[key]), "exact-CPU attempt slot does not match the schedule");
  }
}

function validateAttemptBinding(value, expected) {
  exactKeys(value, ["sha256", "bytes"], "attempt evidence binding");
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  "attempt evidence binding does not match its canonical record");
}

function parseBoundAttemptEvidence(resolved, value) {
  try {
    return parseAttemptEvidence(resolved, value);
  } catch (error) {
    fail(`attempt evidence is invalid: ${error.message}`);
  }
}

function validateAttemptEnvelope(resolved, manifest, plan, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "scheduleDigest", "slot", "affinity",
    "attempt",
  ], "exact-CPU attempt envelope");
  requireCondition(value.version === EXACT_CPU_ATTEMPT_ENVELOPE_VERSION,
    `exact-CPU attempt envelope version must be ${EXACT_CPU_ATTEMPT_ENVELOPE_VERSION}`);
  requireCondition(value.phase === PHASE && value.generation === manifest.generation,
    "exact-CPU attempt envelope belongs to a different phase generation");
  validateWorkloadBinding(resolved, value.workload, "exact-CPU attempt workload binding");
  requireCondition(value.scheduleDigest === manifest.schedule.digest,
    "exact-CPU attempt envelope belongs to a different schedule");
  requireCondition(Number.isSafeInteger(value.slot?.ordinal) && value.slot.ordinal >= 1 &&
    value.slot.ordinal <= plan.records.length, "exact-CPU attempt ordinal is out of range");
  const expectedSlot = plan.records[value.slot.ordinal - 1];
  validateSlot(value.slot, expectedSlot);
  validateAffinityWitness(value.affinity, manifest, expectedSlot);
  exactKeys(value.attempt, ["binding", "evidence"], "exact-CPU bound attempt evidence");
  const evidence = parseBoundAttemptEvidence(resolved, value.attempt.evidence);
  requireCondition(evidence.outcome.validOutcome === true,
    "operationally invalid attempt evidence cannot occupy a schedule slot");
  validateAttemptBinding(value.attempt.binding, attemptEvidenceBinding(resolved, evidence));
}

function validateAffinityWitness(value, manifest, slot) {
  exactKeys(value, [
    "mode", "requestedCpu", "supervisorAllowedCpuList", "workloadAllowedCpuList",
  ], "exact-CPU affinity witness");
  const expectedCpu = String(slot.cpu);
  requireCondition(value.mode === manifest.execution.affinityMode &&
    value.requestedCpu === slot.cpu && value.supervisorAllowedCpuList === expectedCpu &&
    value.workloadAllowedCpuList === expectedCpu,
  "exact-CPU affinity witness does not match the scheduled singleton CPU");
}

function affinityWitness(manifest, slot, execution) {
  const value = execution?.cpuAffinity;
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "attempt result is missing its CPU-affinity witness");
  return {
    mode: manifest.execution.affinityMode,
    requestedCpu: value.requestedCpu,
    supervisorAllowedCpuList: value.supervisorAllowedCpuList,
    workloadAllowedCpuList: value.workloadAllowedCpuList,
  };
}

export function buildExactCpuAttemptEnvelope(
  resolved,
  manifestValue,
  slot,
  evidenceValue,
  affinityValue,
) {
  const { manifest, plan } = parseManifestContext(resolved, manifestValue);
  const evidence = parseBoundAttemptEvidence(resolved, evidenceValue);
  const envelope = {
    version: EXACT_CPU_ATTEMPT_ENVELOPE_VERSION,
    phase: PHASE,
    generation: manifest.generation,
    workload: workloadBinding(resolved),
    scheduleDigest: manifest.schedule.digest,
    slot,
    affinity: affinityValue,
    attempt: {
      binding: attemptEvidenceBinding(resolved, evidence),
      evidence,
    },
  };
  validateAttemptEnvelope(resolved, manifest, plan, envelope);
  return canonicalClone(envelope);
}

export function parseExactCpuAttemptEnvelope(resolved, manifestValue, value) {
  const { manifest, plan } = parseManifestContext(resolved, manifestValue);
  validateAttemptEnvelope(resolved, manifest, plan, value);
  return canonicalClone(value);
}

export function canonicalExactCpuAttemptEnvelopeLine(resolved, manifest, value) {
  return canonicalLine(parseExactCpuAttemptEnvelope(resolved, manifest, value));
}

export function exactCpuAttemptEnvelopeBinding(resolved, manifest, value) {
  return bindingForBytes(canonicalExactCpuAttemptEnvelopeLine(resolved, manifest, value));
}

export function assessExactCpuPhasePrefix(resolved, manifestValue, envelopeValues = []) {
  const context = parseManifestContext(resolved, manifestValue);
  return assessPrefixWithContext(resolved, context, envelopeValues);
}

function assessPrefixWithContext(resolved, { manifest, plan }, envelopeValues) {
  requireCondition(Array.isArray(envelopeValues) && envelopeValues.length <= MAX_SCHEDULE_ENTRIES,
    `exact-CPU phase prefix must contain at most ${MAX_SCHEDULE_ENTRIES} envelopes`);
  requireCondition(envelopeValues.length <= plan.records.length,
    "exact-CPU phase prefix is longer than its schedule");
  for (const [index, value] of envelopeValues.entries()) {
    validateAttemptEnvelope(resolved, manifest, plan, value);
    requireCondition(value.slot.ordinal === index + 1,
      "exact-CPU phase state is not an exact contiguous schedule prefix");
  }
  const committedAttempts = envelopeValues.length;
  const complete = committedAttempts === plan.records.length;
  return deepFreeze({
    status: complete ? "complete" : committedAttempts === 0 ? "empty" : "incomplete",
    complete,
    committedAttempts,
    totalAttempts: plan.records.length,
    nextSlot: complete ? null : { ...plan.records[committedAttempts] },
  });
}

function validateAttemptOptions(value) {
  const options = value ?? {};
  plainObject(options, "exact-CPU attempt runner options");
  const allowed = [
    "signal",
    "stdoutExcerptBytes",
    "stderrExcerptBytes",
    "retainedDirectory",
  ];
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  requireCondition(unknown.length === 0,
    `exact-CPU attempt runner options contain unknown field '${unknown.sort()[0]}'`);
  return options;
}

export async function runNextExactCpuPhaseAttempt({
  resolved,
  manifest: manifestValue,
  envelopes = [],
  runAttempt = runWorkloadAttempt,
  attemptOptions = {},
}) {
  requireCondition(typeof runAttempt === "function", "runAttempt must be a function");
  const context = parseManifestContext(resolved, manifestValue);
  const { manifest } = context;
  const progress = assessPrefixWithContext(resolved, context, envelopes);
  if (progress.complete) {
    return Object.freeze({ committed: false, reason: "complete", slot: null, envelope: null });
  }
  const options = validateAttemptOptions(attemptOptions);
  const slot = progress.nextSlot;
  let result;
  try {
    result = await runAttempt(resolved, {
      ...options,
      cpuAffinity: {
        cpu: slot.cpu,
        tasksetPath: manifest.execution.tasksetPath,
      },
    });
  } catch (error) {
    return deepFreeze({
      committed: false,
      reason: "runner-error",
      errorCode: typeof error?.code === "string" ? error.code.slice(0, 64) : "RUNNER_ERROR",
      slot: { ...slot },
      envelope: null,
    });
  }
  const evidence = buildAttemptEvidence(resolved, result);
  if (evidence.outcome.validOutcome !== true) {
    return deepFreeze({
      committed: false,
      reason: "operational-invalid",
      slot: { ...slot },
      envelope: null,
      evidence,
    });
  }
  const envelope = buildExactCpuAttemptEnvelope(
    resolved,
    manifest,
    slot,
    evidence,
    affinityWitness(manifest, slot, result.execution),
  );
  return deepFreeze({
    committed: true,
    reason: "committed",
    slot: { ...slot },
    envelope,
  });
}
