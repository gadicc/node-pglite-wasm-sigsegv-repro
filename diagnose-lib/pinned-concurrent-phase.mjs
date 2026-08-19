import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { runWorkloadAttempt } from "./attempt-runner.mjs";
import {
  buildPinnedConcurrentPlan,
  canonicalProtocolJson,
} from "./pinned-protocol.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const PINNED_CONCURRENT_PHASE_VERSION = 1;
export const PINNED_CONCURRENT_PHASE_SCHEDULE_VERSION = 1;
export const PINNED_CONCURRENT_WAVE_ENVELOPE_VERSION = 1;

const PHASE = "pinned-concurrent";
const CONTROLLER_MODE = "coordinator-singleton-v1";
const CHILD_MODE = "supervisor-singleton-v1";
const SCHEDULE_ALGORITHM = "balanced-context-and-launch-cyclic-v1";
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class PinnedConcurrentPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedConcurrentPhaseError";
    this.code = "INVALID_PINNED_CONCURRENT_PHASE";
  }
}

function fail(message) {
  throw new PinnedConcurrentPhaseError(message);
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

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "pinned-concurrent generation must be exactly 32 lowercase hexadecimal characters");
}

function validateTasksetPath(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  "pinned-concurrent taskset path must be a bounded absolute NUL-free path");
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  requireCondition(resolved.capabilities?.pinnedConcurrent === true,
    "workload does not declare pinned-concurrent support");
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
}

function buildPlan(contexts, rounds, seed) {
  try {
    return buildPinnedConcurrentPlan({ contexts, rounds, seed });
  } catch (error) {
    fail(`pinned-concurrent plan is invalid: ${error.message}`);
  }
}

function topologyFromPlan(plan) {
  return {
    contexts: plan.contexts.map(({ group, kind, cpus, cluster, controllerCpu }) => ({
      id: group,
      kind,
      cpus: [...cpus],
      cluster,
      controllerCpu,
    })),
  };
}

function wavesFromPlan(plan) {
  const waves = [];
  for (const record of plan.records) {
    const previous = waves.at(-1);
    if (previous === undefined || previous.round !== record.round ||
        previous.contextId !== record.group || previous.position !== record.groupPosition) {
      waves.push({
        ordinal: waves.length + 1,
        round: record.round,
        position: record.groupPosition,
        contextId: record.group,
        controllerCpu: record.controllerCpu,
        firstAttemptOrdinal: record.ordinal,
        childCount: 1,
      });
    } else {
      previous.childCount += 1;
    }
  }
  return waves;
}

function scheduleIdentity(plan, topology) {
  const topologyBytes = canonicalLine(topology);
  return {
    version: PINNED_CONCURRENT_PHASE_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    seed: plan.seed,
    rounds: plan.rounds,
    topologyBinding: bindingForBytes(topologyBytes),
    contextCount: plan.contexts.length,
    waveCount: plan.contexts.length * plan.rounds,
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

function validateBinding(value, expected, keys, label) {
  exactKeys(value, keys, label);
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  `${label} does not match its canonical content`);
  if (keys.includes("recordCount")) {
    requireCondition(Number.isSafeInteger(value.recordCount) && value.recordCount >= 1 &&
      value.recordCount === expected.recordCount,
    `${label} record count does not match its canonical content`);
  }
}

function validateManifest(resolved, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "execution", "topology", "schedule",
  ], "pinned-concurrent phase manifest");
  requireCondition(value.version === PINNED_CONCURRENT_PHASE_VERSION,
    `pinned-concurrent phase version must be ${PINNED_CONCURRENT_PHASE_VERSION}`);
  requireCondition(value.phase === PHASE, "pinned-concurrent phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(resolved, value.workload,
    "pinned-concurrent workload binding");
  exactKeys(value.execution, ["controllerMode", "childMode", "tasksetPath"],
    "pinned-concurrent execution context");
  requireCondition(value.execution.controllerMode === CONTROLLER_MODE &&
    value.execution.childMode === CHILD_MODE,
  "pinned-concurrent execution mode is unsupported");
  validateTasksetPath(value.execution.tasksetPath);
  exactKeys(value.topology, ["contexts"], "pinned-concurrent topology");
  requireCondition(Array.isArray(value.topology.contexts),
    "pinned-concurrent topology contexts must be an array");
  exactKeys(value.schedule, [
    "version", "algorithm", "seed", "rounds", "topologyBinding", "contextCount",
    "waveCount", "attemptCount", "plan", "digest",
  ], "pinned-concurrent schedule");
  const inputContexts = value.topology.contexts.map((context) => {
    exactKeys(context, ["id", "kind", "cpus", "cluster", "controllerCpu"],
      "pinned-concurrent topology context");
    return {
      group: context.id,
      kind: context.kind,
      cpus: context.cpus,
      cluster: context.cluster,
      controllerCpu: context.controllerCpu,
    };
  });
  const plan = buildPlan(inputContexts, value.schedule.rounds, value.schedule.seed);
  const topology = topologyFromPlan(plan);
  requireCondition(canonicalProtocolJson(value.topology) === canonicalProtocolJson(topology),
    "pinned-concurrent topology is not canonical");
  const identity = scheduleIdentity(plan, topology);
  validateBinding(value.schedule.topologyBinding, identity.topologyBinding,
    ["sha256", "bytes"], "pinned-concurrent topology binding");
  validateBinding(value.schedule.plan, identity.plan,
    ["sha256", "bytes", "recordCount"], "pinned-concurrent plan binding");
  const { digest, ...actualIdentity } = value.schedule;
  requireCondition(canonicalProtocolJson(actualIdentity) === canonicalProtocolJson(identity),
    "pinned-concurrent schedule does not match its deterministic plan");
  requireCondition(typeof digest === "string" && DIGEST_RE.test(digest) &&
    digest === scheduleDigest(identity),
  "pinned-concurrent schedule digest does not match its identity");
  return { plan, topology, waves: wavesFromPlan(plan) };
}

function parseManifestContext(resolved, value) {
  const context = validateManifest(resolved, value);
  return { manifest: canonicalClone(value), ...context };
}

export function buildPinnedConcurrentPhaseManifest(resolved, options) {
  exactKeys(options, ["generation", "contexts", "rounds", "seed", "tasksetPath"],
    "pinned-concurrent phase options");
  validateGeneration(options.generation);
  validateTasksetPath(options.tasksetPath);
  const plan = buildPlan(options.contexts, options.rounds, options.seed);
  const topology = topologyFromPlan(plan);
  const identity = scheduleIdentity(plan, topology);
  return parsePinnedConcurrentPhaseManifest(resolved, {
    version: PINNED_CONCURRENT_PHASE_VERSION,
    phase: PHASE,
    generation: options.generation,
    workload: workloadBinding(resolved),
    execution: {
      controllerMode: CONTROLLER_MODE,
      childMode: CHILD_MODE,
      tasksetPath: options.tasksetPath,
    },
    topology,
    schedule: { ...identity, digest: scheduleDigest(identity) },
  });
}

export function parsePinnedConcurrentPhaseManifest(resolved, value) {
  return parseManifestContext(resolved, value).manifest;
}

export function canonicalPinnedConcurrentPhaseManifestLine(resolved, value) {
  return canonicalLine(parsePinnedConcurrentPhaseManifest(resolved, value));
}

export function pinnedConcurrentPhaseManifestBinding(resolved, value) {
  return bindingForBytes(canonicalPinnedConcurrentPhaseManifestLine(resolved, value));
}

function waveRecords(plan, wave) {
  return plan.records.slice(
    wave.firstAttemptOrdinal - 1,
    wave.firstAttemptOrdinal - 1 + wave.childCount,
  );
}

function contextForWave(topology, wave) {
  const context = topology.contexts.find(({ id }) => id === wave.contextId);
  requireCondition(context !== undefined, "pinned-concurrent wave context is missing");
  return context;
}

function parseBoundAttemptEvidence(resolved, value) {
  try {
    return parseAttemptEvidence(resolved, value);
  } catch (error) {
    fail(`pinned-concurrent attempt evidence is invalid: ${error.message}`);
  }
}

function validateAttemptBinding(value, expected) {
  validateBinding(value, expected, ["sha256", "bytes"],
    "pinned-concurrent attempt binding");
}

function validateControllerWitness(value, manifest, wave) {
  exactKeys(value, ["mode", "requestedCpu", "allowedCpuList"],
    "pinned-concurrent controller witness");
  requireCondition(value.mode === manifest.execution.controllerMode &&
    value.requestedCpu === wave.controllerCpu &&
    value.allowedCpuList === String(wave.controllerCpu),
  "pinned-concurrent controller witness does not match the scheduled controller CPU");
}

function childAffinityWitness(manifest, record, execution) {
  const value = execution?.cpuAffinity;
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "attempt result is missing its singleton CPU witness");
  const witness = {
    mode: manifest.execution.childMode,
    requestedCpu: value.requestedCpu,
    supervisorAllowedCpuList: value.supervisorAllowedCpuList,
    workloadAllowedCpuList: value.workloadAllowedCpuList,
  };
  validateChildWitness(witness, manifest, record);
  return witness;
}

function validateChildWitness(value, manifest, record) {
  exactKeys(value, [
    "mode", "requestedCpu", "supervisorAllowedCpuList", "workloadAllowedCpuList",
  ], "pinned-concurrent child affinity witness");
  const expected = String(record.cpu);
  requireCondition(value.mode === manifest.execution.childMode &&
    value.requestedCpu === record.cpu && value.supervisorAllowedCpuList === expected &&
    value.workloadAllowedCpuList === expected,
  "pinned-concurrent child affinity witness does not match its schedule slot");
}

function validateWaveEnvelope(resolved, manifest, plan, waves, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "scheduleDigest", "wave",
    "controller", "attempts",
  ], "pinned-concurrent wave envelope");
  requireCondition(value.version === PINNED_CONCURRENT_WAVE_ENVELOPE_VERSION &&
    value.phase === PHASE && value.generation === manifest.generation,
  "pinned-concurrent wave envelope version or generation is invalid");
  validateWorkloadBinding(resolved, value.workload,
    "pinned-concurrent wave workload binding");
  requireCondition(value.scheduleDigest === manifest.schedule.digest,
    "pinned-concurrent wave belongs to a different schedule");
  exactKeys(value.wave, [
    "ordinal", "round", "position", "contextId", "controllerCpu",
    "firstAttemptOrdinal", "childCount",
  ], "pinned-concurrent wave identity");
  const expectedWave = waves[value.wave.ordinal - 1];
  requireCondition(expectedWave !== undefined &&
    Object.keys(expectedWave).every((key) => value.wave[key] === expectedWave[key]),
  "pinned-concurrent wave identity does not match the deterministic schedule");
  validateControllerWitness(value.controller, manifest, expectedWave);
  const records = waveRecords(plan, expectedWave);
  requireCondition(Array.isArray(value.attempts) && value.attempts.length === records.length,
    "pinned-concurrent wave must contain every scheduled child");
  for (const [index, bound] of value.attempts.entries()) {
    const record = records[index];
    exactKeys(bound, ["slot", "affinity", "attempt"],
      "pinned-concurrent bound attempt");
    exactKeys(bound.slot, ["ordinal", "launchPosition", "cpu"],
      "pinned-concurrent child slot");
    requireCondition(bound.slot.ordinal === record.ordinal &&
      bound.slot.launchPosition === record.launchPosition && bound.slot.cpu === record.cpu,
    "pinned-concurrent child slot does not match the deterministic schedule");
    validateChildWitness(bound.affinity, manifest, record);
    exactKeys(bound.attempt, ["binding", "evidence"],
      "pinned-concurrent bound attempt evidence");
    const evidence = parseBoundAttemptEvidence(resolved, bound.attempt.evidence);
    requireCondition(evidence.outcome.validOutcome === true,
      "operationally invalid evidence cannot occupy a pinned-concurrent wave");
    validateAttemptBinding(bound.attempt.binding, attemptEvidenceBinding(resolved, evidence));
  }
}

export function parsePinnedConcurrentWaveEnvelope(resolved, manifestValue, value) {
  const { manifest, plan, waves } = parseManifestContext(resolved, manifestValue);
  validateWaveEnvelope(resolved, manifest, plan, waves, value);
  return canonicalClone(value);
}

export function canonicalPinnedConcurrentWaveEnvelopeLine(resolved, manifest, value) {
  return canonicalLine(parsePinnedConcurrentWaveEnvelope(resolved, manifest, value));
}

function assessPrefixWithContext(resolved, context, envelopeValues) {
  const { manifest, plan, waves } = context;
  requireCondition(Array.isArray(envelopeValues) && envelopeValues.length <= waves.length,
    "pinned-concurrent prefix is longer than its schedule");
  let committedAttempts = 0;
  for (const [index, value] of envelopeValues.entries()) {
    validateWaveEnvelope(resolved, manifest, plan, waves, value);
    requireCondition(value.wave.ordinal === index + 1,
      "pinned-concurrent state is not an exact contiguous wave prefix");
    committedAttempts += value.wave.childCount;
  }
  const complete = envelopeValues.length === waves.length;
  return deepFreeze({
    status: complete ? "complete" : envelopeValues.length === 0 ? "empty" : "incomplete",
    complete,
    committedWaves: envelopeValues.length,
    totalWaves: waves.length,
    committedAttempts,
    totalAttempts: manifest.schedule.attemptCount,
    nextWave: complete ? null : { ...waves[envelopeValues.length] },
  });
}

export function assessPinnedConcurrentPhasePrefix(resolved, manifestValue, envelopeValues = []) {
  return assessPrefixWithContext(resolved, parseManifestContext(resolved, manifestValue),
    envelopeValues);
}

function defaultControllerCpuList() {
  return readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1] ?? null;
}

function normalizedErrorCode(error, fallback = "RUNNER_ERROR") {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

export async function runNextPinnedConcurrentPhaseWave({
  resolved,
  manifest: manifestValue,
  envelopes = [],
  runAttempt = runWorkloadAttempt,
  attemptOptions = {},
  readControllerCpuList = defaultControllerCpuList,
}) {
  requireCondition(typeof runAttempt === "function" && typeof readControllerCpuList === "function",
    "pinned-concurrent runners must be functions");
  plainObject(attemptOptions, "pinned-concurrent attempt options");
  const allowed = new Set([
    "signal", "stdoutExcerptBytes", "stderrExcerptBytes", "retainedDirectory",
  ]);
  const unknown = Object.keys(attemptOptions).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `pinned-concurrent attempt options contain unknown field '${unknown.sort()[0]}'`);
  const context = parseManifestContext(resolved, manifestValue);
  const { manifest, plan, topology, waves } = context;
  const progress = assessPrefixWithContext(resolved, context, envelopes);
  if (progress.complete) {
    return deepFreeze({ committed: false, reason: "complete", wave: null, envelope: null });
  }
  const wave = waves[progress.committedWaves];
  let controllerCpuList;
  try {
    controllerCpuList = readControllerCpuList();
  } catch (error) {
    return deepFreeze({
      committed: false,
      reason: "controller-invalid",
      errorCode: normalizedErrorCode(error, "CONTROLLER_OBSERVATION_ERROR"),
      wave,
      envelope: null,
    });
  }
  if (controllerCpuList !== String(wave.controllerCpu)) {
    return deepFreeze({
      committed: false,
      reason: "controller-invalid",
      errorCode: "CONTROLLER_AFFINITY_MISMATCH",
      wave,
      envelope: null,
    });
  }
  const controllerWitness = {
    mode: manifest.execution.controllerMode,
    requestedCpu: wave.controllerCpu,
    allowedCpuList: controllerCpuList,
  };
  const records = waveRecords(plan, wave);
  contextForWave(topology, wave);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (attemptOptions.signal !== undefined) {
    const signal = attemptOptions.signal;
    requireCondition(signal !== null && typeof signal === "object" &&
      typeof signal.aborted === "boolean" &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function",
    "pinned-concurrent attempt options.signal must be an AbortSignal");
    signal.addEventListener("abort", onExternalAbort, { once: true });
    if (signal.aborted) controller.abort();
  }
  const { signal: _externalSignal, ...runnerOptions } = attemptOptions;
  let firstFailure = null;
  const failAttempt = (failure) => {
    if (firstFailure === null) firstFailure = failure;
    controller.abort();
  };
  let attempts;
  try {
    attempts = await Promise.all(records.map(async (record) => {
      let result;
      try {
        result = await runAttempt(resolved, {
          ...runnerOptions,
          signal: controller.signal,
          cpuAffinity: { cpu: record.cpu, tasksetPath: manifest.execution.tasksetPath },
        });
      } catch (error) {
        const failure = {
          status: "runner-error",
          record,
          errorCode: normalizedErrorCode(error),
        };
        failAttempt(failure);
        return failure;
      }
      let evidence;
      let affinity;
      try {
        evidence = buildAttemptEvidence(resolved, result);
        affinity = childAffinityWitness(manifest, record, result.execution);
      } catch (error) {
        const failure = {
          status: "runner-error",
          record,
          errorCode: normalizedErrorCode(error, "INVALID_ATTEMPT_RESULT"),
        };
        failAttempt(failure);
        return failure;
      }
      if (evidence.outcome.validOutcome !== true) {
        const failure = { status: "operational-invalid", record, evidence, affinity };
        failAttempt(failure);
        return failure;
      }
      return { status: "valid", record, evidence, affinity };
    }));
  } finally {
    attemptOptions.signal?.removeEventListener("abort", onExternalAbort);
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
  const envelope = {
    version: PINNED_CONCURRENT_WAVE_ENVELOPE_VERSION,
    phase: PHASE,
    generation: manifest.generation,
    workload: workloadBinding(resolved),
    scheduleDigest: manifest.schedule.digest,
    wave,
    controller: controllerWitness,
    attempts: attempts.map(({ record, evidence, affinity }) => ({
      slot: {
        ordinal: record.ordinal,
        launchPosition: record.launchPosition,
        cpu: record.cpu,
      },
      affinity,
      attempt: { binding: attemptEvidenceBinding(resolved, evidence), evidence },
    })),
  };
  validateWaveEnvelope(resolved, manifest, plan, waves, envelope);
  return deepFreeze({
    committed: true,
    reason: "committed",
    wave,
    envelope: canonicalClone(envelope),
  });
}
