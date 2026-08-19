import {
  readLinuxAllowedCpuList,
  readLinuxProcessIdentity,
  runManagedWorkload,
} from "./attempt-runner.mjs";
import { parseManagedWorkloadResult } from "./managed-workload-result.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const CONTROLLED_LOAD_WORKER_SET_VERSION = 1;
export const CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS = 256;

const CPU_MAX = 65_535;
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,31})$/;

export class ControlledLoadWorkerSetError extends Error {
  constructor(message, code = "INVALID_CONTROLLED_LOAD_WORKER_SET") {
    super(message);
    this.name = "ControlledLoadWorkerSetError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ControlledLoadWorkerSetError(message, code);
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
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function normalizedErrorCode(error, fallback) {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

function validateCpuList(value) {
  requireCondition(Array.isArray(value) && value.length >= 1 &&
    value.length <= CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS,
  `controlled-load CPUs must contain 1 through ${CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS} entries`);
  return value.map((cpu, index) => {
    requireCondition(Number.isSafeInteger(cpu) && cpu >= 0 && cpu <= CPU_MAX,
      `controlled-load CPUs[${index}] is invalid`);
    requireCondition(index === 0 || cpu > value[index - 1],
      "controlled-load CPUs must be strictly increasing");
    return cpu;
  });
}

function validateTasksetPath(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  "controlled-load taskset path must be a bounded absolute NUL-free path");
  return value;
}

function validateSignal(value) {
  if (value === undefined) return null;
  requireCondition(value !== null && typeof value === "object" &&
    typeof value.aborted === "boolean" && typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function",
  "controlled-load signal must be an AbortSignal");
  return value;
}

function validateWitness(value, cpu) {
  exactKeys(value, ["monotonicNs", "supervisor", "workload"],
    "controlled-load readiness witness");
  requireCondition(typeof value.monotonicNs === "string" &&
    /^(0|[1-9][0-9]{0,31})$/.test(value.monotonicNs),
  "controlled-load readiness timestamp is invalid");
  exactKeys(value.supervisor, [
    "pid", "processGroupId", "sessionId", "startTicks", "allowedCpuList",
  ], "controlled-load supervisor witness");
  exactKeys(value.workload, ["pid", "startTicks", "allowedCpuList"],
    "controlled-load workload witness");
  requireCondition(Number.isSafeInteger(value.supervisor.pid) && value.supervisor.pid > 1 &&
    value.supervisor.processGroupId === value.supervisor.pid &&
    value.supervisor.sessionId === value.supervisor.pid &&
    typeof value.supervisor.startTicks === "string" &&
    /^[0-9]+$/.test(value.supervisor.startTicks) &&
    Number.isSafeInteger(value.workload.pid) && value.workload.pid > 1 &&
    typeof value.workload.startTicks === "string" &&
    /^[0-9]+$/.test(value.workload.startTicks) &&
    value.supervisor.allowedCpuList === String(cpu) &&
    value.workload.allowedCpuList === String(cpu),
  "controlled-load readiness witness does not match its singleton CPU");
  return value;
}

function identityMatches(actual, expected, { supervisor }) {
  return actual !== null && actual.live === true && actual.pid === expected.pid &&
    actual.startTicks === expected.startTicks &&
    actual.processGroupId === (supervisor ? expected.pid : expected.processGroupId) &&
    actual.sessionId === expected.sessionId;
}

function currentWorkerWitness(worker, readIdentity, readAllowedCpuList) {
  const expectedSupervisor = worker.readiness.supervisor;
  const expectedWorkload = {
    ...worker.readiness.workload,
    processGroupId: expectedSupervisor.pid,
    sessionId: expectedSupervisor.pid,
  };
  const supervisor = readIdentity(expectedSupervisor.pid);
  const workload = readIdentity(expectedWorkload.pid);
  requireCondition(identityMatches(supervisor, expectedSupervisor, { supervisor: true }) &&
    identityMatches(workload, expectedWorkload, { supervisor: false }),
  `controlled-load worker on CPU ${worker.cpu} no longer has its bound process identities`,
  "CONTROLLED_LOAD_WORKER_IDENTITY_MISMATCH");
  const supervisorAllowedCpuList = readAllowedCpuList(expectedSupervisor.pid);
  const workloadAllowedCpuList = readAllowedCpuList(expectedWorkload.pid);
  requireCondition(supervisorAllowedCpuList === String(worker.cpu) &&
    workloadAllowedCpuList === String(worker.cpu),
  `controlled-load worker on CPU ${worker.cpu} no longer has singleton affinity`,
  "CONTROLLED_LOAD_WORKER_AFFINITY_MISMATCH");
  return {
    cpu: worker.cpu,
    supervisor: {
      pid: expectedSupervisor.pid,
      startTicks: expectedSupervisor.startTicks,
      allowedCpuList: supervisorAllowedCpuList,
    },
    workload: {
      pid: expectedWorkload.pid,
      startTicks: expectedWorkload.startTicks,
      allowedCpuList: workloadAllowedCpuList,
    },
  };
}

function validateBoundaryId(value, label) {
  requireCondition(typeof value === "string" && ID_RE.test(value),
    `${label} must use lowercase letters, digits, and internal hyphens`);
  return value;
}

function decimal(value, label) {
  requireCondition(typeof value === "string" && DECIMAL_RE.test(value),
    `${label} must be a canonical bounded decimal string`);
  return BigInt(value);
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  return {
    contractVersion: resolved.version,
    id: resolved.id,
    digest: resolved.digest,
  };
}

function validateWorkloadBinding(resolved, value) {
  exactKeys(value, ["contractVersion", "id", "digest"],
    "controlled-load worker-set workload binding");
  const expected = workloadBinding(resolved);
  requireCondition(value.contractVersion === expected.contractVersion &&
    value.id === expected.id && value.digest === expected.digest,
  "controlled-load worker set belongs to a different workload");
}

export function parseControlledLoadWorkerSetStartEvidence(resolved, value) {
  exactKeys(value, [
    "version", "workload", "execution", "cpus", "readyMonotonicNs", "workers",
  ], "controlled-load worker-set start evidence");
  requireCondition(value.version === CONTROLLED_LOAD_WORKER_SET_VERSION,
    `controlled-load worker-set version must be ${CONTROLLED_LOAD_WORKER_SET_VERSION}`);
  validateWorkloadBinding(resolved, value.workload);
  exactKeys(value.execution, ["tasksetPath", "outputMode"],
    "controlled-load worker-set execution context");
  validateTasksetPath(value.execution.tasksetPath);
  requireCondition(value.execution.outputMode === "discard",
    "controlled-load worker-set output mode is unsupported");
  const cpus = validateCpuList(value.cpus);
  const ready = decimal(value.readyMonotonicNs, "controlled-load ready boundary");
  requireCondition(Array.isArray(value.workers) && value.workers.length === cpus.length,
    "controlled-load start evidence must contain every worker");
  for (const [index, worker] of value.workers.entries()) {
    exactKeys(worker, ["cpu", "monotonicNs", "supervisor", "workload"],
      "controlled-load start worker");
    requireCondition(worker.cpu === cpus[index],
      "controlled-load start workers do not match the canonical CPU order");
    validateWitness({
      monotonicNs: worker.monotonicNs,
      supervisor: worker.supervisor,
      workload: worker.workload,
    }, worker.cpu);
    requireCondition(decimal(worker.monotonicNs,
      "controlled-load worker ready boundary") <= ready,
    "controlled-load worker readiness occurs after the set ready boundary");
  }
  return canonicalClone(value);
}

export function parseControlledLoadWorkerSetBoundaryEvidence(resolved, startValue, value) {
  exactKeys(value, ["version", "boundary", "monotonicNs", "workers"],
    "controlled-load worker-set boundary evidence");
  requireCondition(value.version === CONTROLLED_LOAD_WORKER_SET_VERSION,
    `controlled-load worker-set version must be ${CONTROLLED_LOAD_WORKER_SET_VERSION}`);
  const start = parseControlledLoadWorkerSetStartEvidence(resolved, startValue);
  validateBoundaryId(value.boundary, "controlled-load boundary");
  requireCondition(decimal(value.monotonicNs, "controlled-load boundary time") >=
    decimal(start.readyMonotonicNs, "controlled-load ready boundary"),
  "controlled-load verification precedes complete readiness");
  requireCondition(Array.isArray(value.workers) &&
    value.workers.length === start.workers.length,
  "controlled-load boundary must contain every started worker");
  for (const [index, worker] of value.workers.entries()) {
    exactKeys(worker, ["cpu", "supervisor", "workload"],
      "controlled-load boundary worker");
    const expected = start.workers[index];
    requireCondition(worker.cpu === expected.cpu,
      "controlled-load boundary workers do not match the start order");
    for (const kind of ["supervisor", "workload"]) {
      exactKeys(worker[kind], ["pid", "startTicks", "allowedCpuList"],
        `controlled-load boundary ${kind}`);
      requireCondition(worker[kind].pid === expected[kind].pid &&
        worker[kind].startTicks === expected[kind].startTicks &&
        worker[kind].allowedCpuList === String(worker.cpu),
      `controlled-load boundary ${kind} does not match its ready identity`);
    }
  }
  return canonicalClone(value);
}

export function parseControlledLoadWorkerSetStopEvidence(resolved, startValue, value) {
  const start = parseControlledLoadWorkerSetStartEvidence(resolved, startValue);
  exactKeys(value, [
    "version", "reason", "valid", "failureCode", "stoppedMonotonicNs", "workers",
  ], "controlled-load worker-set stop evidence");
  requireCondition(value.version === CONTROLLED_LOAD_WORKER_SET_VERSION,
    `controlled-load worker-set version must be ${CONTROLLED_LOAD_WORKER_SET_VERSION}`);
  validateBoundaryId(value.reason, "controlled-load stop reason");
  requireCondition(typeof value.valid === "boolean" &&
    (value.failureCode === null ||
      (typeof value.failureCode === "string" && ERROR_CODE_RE.test(value.failureCode))),
  "controlled-load stop status is invalid");
  requireCondition(decimal(value.stoppedMonotonicNs, "controlled-load stop boundary") >=
    decimal(start.readyMonotonicNs, "controlled-load ready boundary"),
  "controlled-load stop precedes complete readiness");
  requireCondition(Array.isArray(value.workers) && value.workers.length === start.workers.length,
    "controlled-load stop evidence must contain every worker");
  let recordFailure = false;
  const normalizedWorkers = value.workers.map((worker, index) => {
    exactKeys(worker, ["cpu", "errorCode", "result"], "controlled-load stopped worker");
    const expected = start.workers[index];
    requireCondition(worker.cpu === expected.cpu &&
      (worker.errorCode === null ||
        (typeof worker.errorCode === "string" && ERROR_CODE_RE.test(worker.errorCode))),
    "controlled-load stopped worker identity or status is invalid");
    if (worker.errorCode !== null) recordFailure = true;
    if (worker.result === null) {
      requireCondition(worker.errorCode !== null,
        "missing controlled-load worker result requires an error code");
      return worker;
    }
    const result = parseManagedWorkloadResult(resolved, worker.result);
    const affinity = result.execution.cpuAffinity;
    requireCondition(affinity !== null && affinity.requestedCpu === worker.cpu &&
      affinity.supervisorAllowedCpuList === String(worker.cpu) &&
      affinity.workloadAllowedCpuList === String(worker.cpu),
    "controlled-load stopped worker affinity does not match its CPU");
    requireCondition(result.process.supervisor?.pid === expected.supervisor.pid &&
      result.process.supervisor?.startTicks === expected.supervisor.startTicks &&
      result.process.workload?.pid === expected.workload.pid &&
      result.process.workload?.startTicks === expected.workload.startTicks &&
      result.boundary.workloadStartedMonotonicNs === expected.monotonicNs,
    "controlled-load stopped worker does not match its ready process identities");
    const validStop = result.readiness.reported === true &&
      result.readiness.errorCode === null &&
      result.observation.terminalReason === "external-cancel" &&
      result.observation.cleanupComplete === true &&
      result.cleanup.groupDrained === true && result.cleanup.outputDrained === true;
    requireCondition(validStop ? worker.errorCode === null : worker.errorCode !== null,
      "controlled-load stopped worker status disagrees with its lifecycle record");
    return { ...worker, result };
  });
  requireCondition(value.valid
    ? value.failureCode === null && !recordFailure
    : value.failureCode !== null,
  "controlled-load stop summary disagrees with its worker records");
  return canonicalClone({ ...value, workers: normalizedWorkers });
}

export function canonicalControlledLoadWorkerSetStartLine(resolved, value) {
  return Buffer.from(`${canonicalProtocolJson(
    parseControlledLoadWorkerSetStartEvidence(resolved, value),
  )}\n`, "utf8");
}

export function canonicalControlledLoadWorkerSetBoundaryLine(resolved, start, value) {
  return Buffer.from(`${canonicalProtocolJson(
    parseControlledLoadWorkerSetBoundaryEvidence(resolved, start, value),
  )}\n`, "utf8");
}

export function canonicalControlledLoadWorkerSetStopLine(resolved, start, value) {
  return Buffer.from(`${canonicalProtocolJson(
    parseControlledLoadWorkerSetStopEvidence(resolved, start, value),
  )}\n`, "utf8");
}

export async function startControlledLoadWorkerSet(rawOptions) {
  const options = plainObject(rawOptions, "controlled-load worker-set options");
  allowedKeys(options, [
    "resolved", "cpus", "tasksetPath", "retainedDirectory", "signal",
    "runManaged", "readIdentity", "readAllowedCpuList", "nowNs",
  ], "controlled-load worker-set options");
  requireCondition(Object.hasOwn(options, "resolved") && Object.hasOwn(options, "cpus") &&
    Object.hasOwn(options, "tasksetPath"),
  "controlled-load worker-set options require resolved, cpus, and tasksetPath");
  const resolved = options.resolved;
  const binding = workloadBinding(resolved);
  requireCondition(resolved.attempt.mode === "survive-window",
    "controlled-load workers require survive-window lifecycle semantics");
  const cpus = validateCpuList(options.cpus);
  const tasksetPath = validateTasksetPath(options.tasksetPath);
  const signal = validateSignal(options.signal);
  const runManaged = options.runManaged ?? runManagedWorkload;
  const readIdentity = options.readIdentity ?? readLinuxProcessIdentity;
  const readAllowedCpuList = options.readAllowedCpuList ?? readLinuxAllowedCpuList;
  const nowNs = options.nowNs ?? process.hrtime.bigint.bind(process.hrtime);
  requireCondition(typeof runManaged === "function" && typeof readIdentity === "function" &&
    typeof readAllowedCpuList === "function" && typeof nowNs === "function",
  "controlled-load worker-set dependencies must be functions");

  let state = "starting";
  let failureCode = null;
  let stopRequested = false;
  let stopPromise = null;
  let stopEvidence = null;
  const workers = [];
  const abortAll = () => {
    for (const worker of workers) worker.controller.abort();
  };
  const invalidate = (code) => {
    if (failureCode === null) failureCode = code;
    if (state !== "stopping" && state !== "stopped") state = "invalid";
    abortAll();
  };
  const onExternalAbort = () => invalidate("CONTROLLED_LOAD_EXTERNAL_CANCEL");
  if (signal !== null) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const removeExternalAbort = () => {
    signal?.removeEventListener("abort", onExternalAbort);
  };

  for (const cpu of cpus) {
    const controller = new AbortController();
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const worker = { cpu, controller, readiness: null, completion: null };
    workers.push(worker);
    worker.completion = Promise.resolve().then(() => runManaged(resolved, {
      signal: controller.signal,
      cpuAffinity: { cpu, tasksetPath },
      ...(options.retainedDirectory === undefined
        ? {} : { retainedDirectory: options.retainedDirectory }),
      onStarted(witness) {
        worker.readiness = validateWitness(witness, cpu);
        resolveReady({ kind: "ready", witness: worker.readiness });
      },
    })).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
    worker.first = Promise.race([
      ready,
      worker.completion.then((completion) => completion.ok
        ? { kind: "finished", result: completion.result }
        : { kind: "error", error: completion.error }),
    ]);
    worker.completion.then((completion) => {
      if (!stopRequested && (state === "starting" || state === "running")) {
        invalidate(completion.ok
          ? "CONTROLLED_LOAD_WORKER_EARLY_TERMINAL"
          : normalizedErrorCode(completion.error, "CONTROLLED_LOAD_WORKER_RUNNER_ERROR"));
      }
    });
  }
  if (signal?.aborted) onExternalAbort();

  const first = await Promise.all(workers.map((worker) => worker.first));
  const incomplete = first.find((entry) => entry.kind !== "ready");
  if (incomplete !== undefined || state === "invalid") {
    invalidate(failureCode ?? (incomplete?.kind === "error"
      ? normalizedErrorCode(incomplete.error, "CONTROLLED_LOAD_WORKER_RUNNER_ERROR")
      : "CONTROLLED_LOAD_WORKER_START_FAILED"));
    stopRequested = true;
    await Promise.all(workers.map((worker) => worker.completion));
    removeExternalAbort();
    fail("controlled-load worker set did not reach complete readiness", failureCode);
  }

  state = "running";
  const startEvidence = parseControlledLoadWorkerSetStartEvidence(resolved, {
    version: CONTROLLED_LOAD_WORKER_SET_VERSION,
    workload: binding,
    execution: { tasksetPath, outputMode: "discard" },
    cpus,
    readyMonotonicNs: nowNs().toString(),
    workers: workers.map((worker) => ({ cpu: worker.cpu, ...worker.readiness })),
  });

  const allCompleted = Promise.all(workers.map((worker) => worker.completion));
  allCompleted.then(() => {
    if (state === "invalid") removeExternalAbort();
  });

  const verify = (boundary) => {
    validateBoundaryId(boundary, "controlled-load boundary");
    requireCondition(state === "running",
      "controlled-load worker set is not running",
      failureCode ?? "CONTROLLED_LOAD_WORKER_SET_NOT_RUNNING");
    try {
      const snapshot = parseControlledLoadWorkerSetBoundaryEvidence(resolved, startEvidence, {
        version: CONTROLLED_LOAD_WORKER_SET_VERSION,
        boundary,
        monotonicNs: nowNs().toString(),
        workers: workers.map((worker) => currentWorkerWitness(
          worker,
          readIdentity,
          readAllowedCpuList,
        )),
      });
      return snapshot;
    } catch (error) {
      invalidate(normalizedErrorCode(error, "CONTROLLED_LOAD_WORKER_BOUNDARY_INVALID"));
      throw error;
    }
  };

  const stop = (reason = "complete") => {
    validateBoundaryId(reason, "controlled-load stop reason");
    if (stopPromise !== null) return stopPromise;
    stopRequested = true;
    if (state !== "invalid") state = "stopping";
    abortAll();
    stopPromise = allCompleted.then((completions) => {
      removeExternalAbort();
      const records = completions.map((completion, index) => {
        if (!completion.ok) {
          return {
            cpu: workers[index].cpu,
            errorCode: normalizedErrorCode(
              completion.error,
              "CONTROLLED_LOAD_WORKER_RUNNER_ERROR",
            ),
            result: null,
          };
        }
        let result;
        try {
          result = parseManagedWorkloadResult(resolved, completion.result);
        } catch (error) {
          return {
            cpu: workers[index].cpu,
            errorCode: normalizedErrorCode(
              error,
              "CONTROLLED_LOAD_WORKER_RESULT_INVALID",
            ),
            result: null,
          };
        }
        const validStop = result.readiness.reported === true &&
          result.readiness.errorCode === null &&
          result.observation.terminalReason === "external-cancel" &&
          result.observation.cleanupComplete === true &&
          result.cleanup.groupDrained === true && result.cleanup.outputDrained === true;
        return {
          cpu: workers[index].cpu,
          errorCode: validStop ? null : "CONTROLLED_LOAD_WORKER_STOP_INVALID",
          result,
        };
      });
      const recordFailure = records.find((record) => record.errorCode !== null)?.errorCode ?? null;
      const finalFailure = failureCode ?? recordFailure;
      stopEvidence = parseControlledLoadWorkerSetStopEvidence(resolved, startEvidence, {
        version: CONTROLLED_LOAD_WORKER_SET_VERSION,
        reason,
        valid: finalFailure === null,
        failureCode: finalFailure,
        stoppedMonotonicNs: nowNs().toString(),
        workers: records,
      });
      state = "stopped";
      return stopEvidence;
    });
    return stopPromise;
  };

  return Object.freeze({
    version: CONTROLLED_LOAD_WORKER_SET_VERSION,
    startEvidence,
    verify,
    stop,
    get state() { return state; },
    get failureCode() { return failureCode; },
    get stopEvidence() { return stopEvidence; },
  });
}
