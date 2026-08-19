import { createHash } from "node:crypto";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { runWorkloadAttempt } from "./attempt-runner.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import {
  MAX_CPU_ID,
  MAX_SCHEDULE_ENTRIES,
  buildBalancedGroupOrders,
  compressCpuList,
  flattenGroupOrders,
} from "./pinned-runner.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const GROUP_PHASE_VERSION = 1;
export const GROUP_SCHEDULE_VERSION = 1;
export const GROUP_WAVE_ENVELOPE_VERSION = 1;
export const MAX_GROUP_CONTEXTS = 256;
export const MAX_GROUP_CHILDREN = 64;

const PHASE = "cpu-groups";
const SCHEDULE_ALGORITHM = "balanced-cyclic-v1";
const AFFINITY_MODE = "inherited-cpu-mask-v1";
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class GroupPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "GroupPhaseError";
    this.code = "INVALID_GROUP_PHASE";
  }
}

function fail(message) {
  throw new GroupPhaseError(message);
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

function canonicalInteger(value, label, minimum, maximum) {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function validateGeneration(value) {
  requireCondition(typeof value === "string" && GENERATION_RE.test(value),
    "group phase generation must be exactly 32 lowercase hexadecimal characters");
}

function validateTasksetPath(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  "group affinity taskset path must be a bounded absolute NUL-free path");
}

function validateCpuArray(value, label) {
  requireCondition(Array.isArray(value) && value.length >= 1 &&
    value.length <= MAX_CPU_ID + 1, `${label} must be a non-empty bounded CPU array`);
  return value.map((cpu, index) => {
    canonicalInteger(cpu, `${label}[${index}]`, 0, MAX_CPU_ID);
    requireCondition(index === 0 || cpu > value[index - 1],
      `${label} must be strictly increasing`);
    return cpu;
  });
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  requireCondition(resolved.capabilities?.groups === true,
    "workload does not declare CPU-group support");
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

function normalizeTopology(cpuUniverseValue, contextValues) {
  const cpuUniverse = validateCpuArray(cpuUniverseValue, "group CPU universe");
  requireCondition(Array.isArray(contextValues) && contextValues.length >= 1 &&
    contextValues.length <= MAX_GROUP_CONTEXTS,
  `group contexts must contain 1 through ${MAX_GROUP_CONTEXTS} entries`);
  const universe = new Set(cpuUniverse);
  const covered = new Set();
  const ids = new Set();
  const contexts = contextValues.map((value, index) => {
    exactKeys(value, ["id", "kind", "cpus", "childrenPerWave"],
      `group context ${index + 1}`);
    requireCondition(typeof value.id === "string" && ID_RE.test(value.id),
      `group context ${index + 1} id is invalid`);
    requireCondition(!ids.has(value.id), `group context id '${value.id}' is duplicated`);
    ids.add(value.id);
    requireCondition(typeof value.kind === "string" && KIND_RE.test(value.kind),
      `group context '${value.id}' kind is invalid`);
    const cpus = validateCpuArray(value.cpus, `group context '${value.id}' CPUs`);
    requireCondition(cpus.every((cpu) => universe.has(cpu)),
      `group context '${value.id}' contains a CPU outside the declared universe`);
    for (const cpu of cpus) covered.add(cpu);
    const childrenPerWave = canonicalInteger(value.childrenPerWave,
      `group context '${value.id}' children per wave`, 1, MAX_GROUP_CHILDREN);
    return { id: value.id, kind: value.kind, cpus, childrenPerWave };
  });
  requireCondition(covered.size === cpuUniverse.length,
    "group contexts do not cover the declared CPU universe");
  return { cpuUniverse, contexts };
}

function topologyDigest(topology) {
  return createHash("sha256").update(canonicalLine(topology)).digest("hex");
}

function buildPlan(topology, rounds, seed) {
  canonicalInteger(rounds, "group round count", 1, MAX_SCHEDULE_ENTRIES);
  canonicalInteger(seed, "group schedule seed", 0, 0xffff_ffff);
  let flattened;
  try {
    flattened = flattenGroupOrders(buildBalancedGroupOrders(
      topology.contexts.length,
      rounds,
      seed,
    ));
  } catch (error) {
    fail(`group schedule parameters are invalid: ${error.message}`);
  }
  let attemptCount = 0;
  const plan = flattened.map((entry, index) => {
    const context = topology.contexts[entry.groupIndex];
    attemptCount += context.childrenPerWave;
    requireCondition(attemptCount <= MAX_SCHEDULE_ENTRIES,
      `group schedule exceeds ${MAX_SCHEDULE_ENTRIES} child attempts`);
    return {
      ordinal: index + 1,
      round: entry.round,
      position: entry.position,
      contextIndex: entry.groupIndex,
      contextId: context.id,
      childCount: context.childrenPerWave,
    };
  });
  return { plan, attemptCount };
}

function planBinding(plan) {
  const bytes = canonicalLine(plan);
  return { ...bindingForBytes(bytes), recordCount: plan.length };
}

function scheduleIdentity(topology, rounds, seed, plan, attemptCount) {
  return {
    version: GROUP_SCHEDULE_VERSION,
    algorithm: SCHEDULE_ALGORITHM,
    seed,
    rounds,
    topologyDigest: topologyDigest(topology),
    contextCount: topology.contexts.length,
    waveCount: plan.length,
    attemptCount,
    plan: planBinding(plan),
  };
}

function scheduleDigest(identity) {
  return createHash("sha256").update(canonicalLine(identity)).digest("hex");
}

function validateBinding(value, expected, label) {
  exactKeys(value, ["sha256", "bytes", "recordCount"], label);
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    Number.isSafeInteger(value.recordCount) && value.recordCount >= 1 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes &&
    value.recordCount === expected.recordCount,
  `${label} does not match its canonical content`);
}

function validateManifest(resolved, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "execution", "topology", "schedule",
  ], "group phase manifest");
  requireCondition(value.version === GROUP_PHASE_VERSION,
    `group phase version must be ${GROUP_PHASE_VERSION}`);
  requireCondition(value.phase === PHASE, "group phase name is invalid");
  validateGeneration(value.generation);
  validateWorkloadBinding(resolved, value.workload, "group phase workload binding");
  exactKeys(value.execution, ["affinityMode", "tasksetPath"], "group execution context");
  requireCondition(value.execution.affinityMode === AFFINITY_MODE,
    "group affinity mode is unsupported");
  validateTasksetPath(value.execution.tasksetPath);
  exactKeys(value.topology, ["cpuUniverse", "contexts"], "group topology");
  const topology = normalizeTopology(value.topology.cpuUniverse, value.topology.contexts);
  exactKeys(value.schedule, [
    "version", "algorithm", "seed", "rounds", "topologyDigest", "contextCount",
    "waveCount", "attemptCount", "plan", "digest",
  ], "group schedule");
  requireCondition(value.schedule.version === GROUP_SCHEDULE_VERSION &&
    value.schedule.algorithm === SCHEDULE_ALGORITHM,
  "group schedule version or algorithm is unsupported");
  requireCondition(typeof value.schedule.digest === "string" && DIGEST_RE.test(value.schedule.digest),
    "group schedule digest is invalid");
  const { plan, attemptCount } = buildPlan(topology, value.schedule.rounds, value.schedule.seed);
  const identity = scheduleIdentity(topology, value.schedule.rounds, value.schedule.seed,
    plan, attemptCount);
  validateBinding(value.schedule.plan, identity.plan, "group plan binding");
  const { digest, ...actualIdentity } = value.schedule;
  requireCondition(canonicalProtocolJson(actualIdentity) === canonicalProtocolJson(identity),
    "group schedule does not match its deterministic plan");
  requireCondition(digest === scheduleDigest(identity),
    "group schedule digest does not match its identity");
  return { topology, plan };
}

function parseManifestContext(resolved, value) {
  const context = validateManifest(resolved, value);
  return { manifest: canonicalClone(value), ...context };
}

export function buildGroupPhaseManifest(resolved, options) {
  exactKeys(options, [
    "generation", "cpuUniverse", "contexts", "rounds", "seed", "tasksetPath",
  ], "group phase options");
  validateGeneration(options.generation);
  validateTasksetPath(options.tasksetPath);
  const topology = normalizeTopology(options.cpuUniverse, options.contexts);
  const { plan, attemptCount } = buildPlan(topology, options.rounds, options.seed);
  const identity = scheduleIdentity(topology, options.rounds, options.seed, plan, attemptCount);
  return parseGroupPhaseManifest(resolved, {
    version: GROUP_PHASE_VERSION,
    phase: PHASE,
    generation: options.generation,
    workload: workloadBinding(resolved),
    execution: { affinityMode: AFFINITY_MODE, tasksetPath: options.tasksetPath },
    topology,
    schedule: { ...identity, digest: scheduleDigest(identity) },
  });
}

export function parseGroupPhaseManifest(resolved, value) {
  return parseManifestContext(resolved, value).manifest;
}

export function canonicalGroupPhaseManifestLine(resolved, value) {
  return canonicalLine(parseGroupPhaseManifest(resolved, value));
}

export function groupPhaseManifestBinding(resolved, value) {
  return bindingForBytes(canonicalGroupPhaseManifestLine(resolved, value));
}

function validateAttemptBinding(value, expected) {
  exactKeys(value, ["sha256", "bytes"], "group attempt evidence binding");
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  "group attempt evidence binding does not match its canonical record");
}

function parseBoundAttemptEvidence(resolved, value) {
  try {
    return parseAttemptEvidence(resolved, value);
  } catch (error) {
    fail(`group attempt evidence is invalid: ${error.message}`);
  }
}

function validateAffinityWitness(value, manifest, context) {
  exactKeys(value, [
    "mode", "requestedCpuList", "supervisorAllowedCpuList", "workloadAllowedCpuList",
  ], "group affinity witness");
  const expected = compressCpuList(context.cpus);
  requireCondition(value.mode === manifest.execution.affinityMode &&
    value.requestedCpuList === expected && value.supervisorAllowedCpuList === expected &&
    value.workloadAllowedCpuList === expected,
  "group affinity witness does not match the scheduled CPU mask");
}

function affinityWitness(manifest, context, execution) {
  const value = execution?.cpuAffinity;
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "attempt result is missing its group CPU-mask witness");
  const witness = {
    mode: manifest.execution.affinityMode,
    requestedCpuList: value.requestedCpuList,
    supervisorAllowedCpuList: value.supervisorAllowedCpuList,
    workloadAllowedCpuList: value.workloadAllowedCpuList,
  };
  validateAffinityWitness(witness, manifest, context);
  return witness;
}

function validateWaveEnvelope(resolved, manifest, topology, plan, value) {
  exactKeys(value, [
    "version", "phase", "generation", "workload", "scheduleDigest", "wave", "attempts",
  ], "group wave envelope");
  requireCondition(value.version === GROUP_WAVE_ENVELOPE_VERSION,
    `group wave envelope version must be ${GROUP_WAVE_ENVELOPE_VERSION}`);
  requireCondition(value.phase === PHASE && value.generation === manifest.generation,
    "group wave envelope belongs to a different phase generation");
  validateWorkloadBinding(resolved, value.workload, "group wave workload binding");
  requireCondition(value.scheduleDigest === manifest.schedule.digest,
    "group wave envelope belongs to a different schedule");
  exactKeys(value.wave, [
    "ordinal", "round", "position", "contextIndex", "contextId", "childCount",
  ], "group wave identity");
  canonicalInteger(value.wave.ordinal, "group wave ordinal", 1, plan.length);
  const expected = plan[value.wave.ordinal - 1];
  requireCondition(Object.keys(expected).every((key) => value.wave[key] === expected[key]),
    "group wave identity does not match the deterministic schedule");
  const context = topology.contexts[expected.contextIndex];
  requireCondition(Array.isArray(value.attempts) && value.attempts.length === expected.childCount,
    "group wave must contain exactly one attempt for every child position");
  for (const [index, bound] of value.attempts.entries()) {
    exactKeys(bound, ["position", "affinity", "attempt"], "group bound attempt");
    requireCondition(bound.position === index + 1,
      "group child position does not match the deterministic wave order");
    validateAffinityWitness(bound.affinity, manifest, context);
    exactKeys(bound.attempt, ["binding", "evidence"], "group bound attempt evidence");
    const evidence = parseBoundAttemptEvidence(resolved, bound.attempt.evidence);
    requireCondition(evidence.outcome.validOutcome === true,
      "operationally invalid attempt evidence cannot occupy a group wave");
    validateAttemptBinding(bound.attempt.binding, attemptEvidenceBinding(resolved, evidence));
  }
}

export function buildGroupWaveEnvelope(resolved, manifestValue, waveOrdinal, entries) {
  const { manifest, topology, plan } = parseManifestContext(resolved, manifestValue);
  canonicalInteger(waveOrdinal, "group wave ordinal", 1, plan.length);
  const wave = plan[waveOrdinal - 1];
  const context = topology.contexts[wave.contextIndex];
  requireCondition(Array.isArray(entries) && entries.length === wave.childCount,
    "group wave entries must contain exactly one record per child");
  const attempts = entries.map((entry, index) => {
    exactKeys(entry, ["evidence", "affinity"], "group wave entry");
    const evidence = parseBoundAttemptEvidence(resolved, entry.evidence);
    validateAffinityWitness(entry.affinity, manifest, context);
    return {
      position: index + 1,
      affinity: entry.affinity,
      attempt: { binding: attemptEvidenceBinding(resolved, evidence), evidence },
    };
  });
  const envelope = {
    version: GROUP_WAVE_ENVELOPE_VERSION,
    phase: PHASE,
    generation: manifest.generation,
    workload: workloadBinding(resolved),
    scheduleDigest: manifest.schedule.digest,
    wave,
    attempts,
  };
  validateWaveEnvelope(resolved, manifest, topology, plan, envelope);
  return canonicalClone(envelope);
}

export function parseGroupWaveEnvelope(resolved, manifestValue, value) {
  const { manifest, topology, plan } = parseManifestContext(resolved, manifestValue);
  validateWaveEnvelope(resolved, manifest, topology, plan, value);
  return canonicalClone(value);
}

export function canonicalGroupWaveEnvelopeLine(resolved, manifest, value) {
  return canonicalLine(parseGroupWaveEnvelope(resolved, manifest, value));
}

function assessPrefixWithContext(resolved, context, envelopeValues) {
  const { manifest, topology, plan } = context;
  requireCondition(Array.isArray(envelopeValues) && envelopeValues.length <= plan.length,
    "group phase prefix is longer than its schedule");
  let committedAttempts = 0;
  for (const [index, value] of envelopeValues.entries()) {
    validateWaveEnvelope(resolved, manifest, topology, plan, value);
    requireCondition(value.wave.ordinal === index + 1,
      "group phase state is not an exact contiguous wave prefix");
    committedAttempts += value.wave.childCount;
  }
  const committedWaves = envelopeValues.length;
  const complete = committedWaves === plan.length;
  return deepFreeze({
    status: complete ? "complete" : committedWaves === 0 ? "empty" : "incomplete",
    complete,
    committedWaves,
    totalWaves: plan.length,
    committedAttempts,
    totalAttempts: manifest.schedule.attemptCount,
    nextWave: complete ? null : { ...plan[committedWaves] },
  });
}

export function assessGroupPhasePrefix(resolved, manifestValue, envelopeValues = []) {
  return assessPrefixWithContext(resolved, parseManifestContext(resolved, manifestValue),
    envelopeValues);
}

function validateAttemptOptions(value) {
  const options = value ?? {};
  plainObject(options, "group wave attempt options");
  const allowed = new Set([
    "signal", "stdoutExcerptBytes", "stderrExcerptBytes", "retainedDirectory",
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `group wave attempt options contain unknown field '${unknown.sort()[0]}'`);
  return options;
}

function normalizedErrorCode(error, fallback = "RUNNER_ERROR") {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

export async function runNextGroupPhaseWave({
  resolved,
  manifest: manifestValue,
  envelopes = [],
  runAttempt = runWorkloadAttempt,
  attemptOptions = {},
}) {
  requireCondition(typeof runAttempt === "function", "runAttempt must be a function");
  const context = parseManifestContext(resolved, manifestValue);
  const { manifest, topology, plan } = context;
  const progress = assessPrefixWithContext(resolved, context, envelopes);
  if (progress.complete) {
    return deepFreeze({ committed: false, reason: "complete", wave: null, envelope: null });
  }
  const options = validateAttemptOptions(attemptOptions);
  const wave = plan[progress.committedWaves];
  const groupContext = topology.contexts[wave.contextIndex];
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.signal !== undefined) {
    requireCondition(options.signal !== null && typeof options.signal === "object" &&
      typeof options.signal.aborted === "boolean" &&
      typeof options.signal.addEventListener === "function" &&
      typeof options.signal.removeEventListener === "function",
    "group wave attempt options.signal must be an AbortSignal");
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal.aborted) controller.abort();
  }
  const { signal: _externalSignal, ...runnerOptions } = options;
  let firstFailure = null;
  const recordFailure = (failure) => {
    if (firstFailure === null) firstFailure = failure;
    controller.abort();
  };
  let attempts;
  try {
    attempts = await Promise.all(Array.from({ length: wave.childCount }, async (_, index) => {
      const position = index + 1;
      let result;
      try {
        result = await runAttempt(resolved, {
          ...runnerOptions,
          signal: controller.signal,
          cpuAffinity: {
            cpus: groupContext.cpus,
            tasksetPath: manifest.execution.tasksetPath,
          },
        });
      } catch (error) {
        const failure = {
          status: "runner-error",
          position,
          errorCode: normalizedErrorCode(error),
        };
        recordFailure(failure);
        return failure;
      }
      let evidence;
      let affinity;
      try {
        evidence = buildAttemptEvidence(resolved, result);
        affinity = affinityWitness(manifest, groupContext, result.execution);
      } catch (error) {
        const failure = {
          status: "runner-error",
          position,
          errorCode: normalizedErrorCode(error, "INVALID_ATTEMPT_RESULT"),
        };
        recordFailure(failure);
        return failure;
      }
      if (evidence.outcome.validOutcome !== true) {
        const failure = { status: "operational-invalid", position, evidence, affinity };
        recordFailure(failure);
        return failure;
      }
      return { status: "valid", position, evidence, affinity };
    }));
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
  const envelope = buildGroupWaveEnvelope(
    resolved,
    manifest,
    wave.ordinal,
    attempts.map(({ evidence, affinity }) => ({ evidence, affinity })),
  );
  return deepFreeze({ committed: true, reason: "committed", wave, envelope });
}
