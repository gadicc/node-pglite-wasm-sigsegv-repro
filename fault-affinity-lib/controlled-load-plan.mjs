import {
  MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG,
} from "../diagnose-lib/controlled-load-session.mjs";
import {
  CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS,
} from "../diagnose-lib/controlled-load-workers.mjs";
import {
  MAX_CPU_ID,
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  compressCpuList,
  expandCpuList,
} from "../diagnose-lib/pinned-runner.mjs";
import {
  PLAN_FILE_MAX_BYTES,
  PlanFileError,
  readPlanJsonFile,
} from "./plan-file.mjs";

export const CONTROLLED_LOAD_PLAN_FILE_VERSION = 1;
export const CONTROLLED_LOAD_PLAN_FILE_MAX_BYTES = PLAN_FILE_MAX_BYTES;

const MAX_INTERVAL_MS = 3_600_000;

export class ControlledLoadPlanError extends Error {
  constructor(message, code = "INVALID_CONTROLLED_LOAD_PLAN") {
    super(message);
    this.name = "ControlledLoadPlanError";
    this.code = code;
  }
}

function fail(message) {
  throw new ControlledLoadPlanError(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function cpuList(value, label, maximum = MAX_SCHEDULE_ENTRIES) {
  if (typeof value !== "string") fail(`${label} must be a CPU-list string`);
  let cpus;
  try {
    cpus = expandCpuList(value);
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
  const ascending = [...cpus].sort((left, right) => left - right);
  if (ascending.some((cpu, index) => cpu !== cpus[index]) ||
      compressCpuList(cpus) !== value) {
    fail(`${label} must be a canonical ascending CPU list such as 0-3,8`);
  }
  if (cpus.length > maximum) fail(`${label} may contain at most ${maximum} CPUs`);
  return cpus;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseControlledLoadPlan(value) {
  exactKeys(value, ["version", "controlledLoad", "exact"], "controlled-load plan");
  if (value.version !== CONTROLLED_LOAD_PLAN_FILE_VERSION) {
    fail(`controlled-load plan version must be ${CONTROLLED_LOAD_PLAN_FILE_VERSION}`);
  }

  exactKeys(value.controlledLoad, [
    "targetCpu", "workerCpus", "attemptsPerLeg", "warmupMs", "recoveryMs",
  ], "controlled-load plan controlledLoad");
  const targetCpu = integer(value.controlledLoad.targetCpu,
    "controlled-load targetCpu", 0, MAX_CPU_ID);
  const workerCpus = cpuList(value.controlledLoad.workerCpus,
    "controlled-load workerCpus", CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS);
  if (workerCpus.includes(targetCpu)) {
    fail("controlled-load targetCpu must be outside workerCpus");
  }
  const controlledLoad = {
    targetCpu,
    workerCpus,
    attemptsPerLeg: integer(value.controlledLoad.attemptsPerLeg,
      "controlled-load attemptsPerLeg", 1, MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG),
    warmupMs: integer(value.controlledLoad.warmupMs,
      "controlled-load warmupMs", 0, MAX_INTERVAL_MS),
    recoveryMs: integer(value.controlledLoad.recoveryMs,
      "controlled-load recoveryMs", 0, MAX_INTERVAL_MS),
  };

  exactKeys(value.exact, ["cpus", "rounds", "seed"], "controlled-load plan exact");
  const exact = {
    cpus: cpuList(value.exact.cpus, "exact CPUs"),
    rounds: integer(value.exact.rounds, "exact rounds", 1, MAX_SCHEDULE_ENTRIES),
    seed: integer(value.exact.seed, "exact seed", 0, MAX_SEED),
  };
  if (exact.cpus.length * exact.rounds > MAX_SCHEDULE_ENTRIES) {
    fail(`exact schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
  }

  return deepFreeze({ version: CONTROLLED_LOAD_PLAN_FILE_VERSION, controlledLoad, exact });
}

export function readControlledLoadPlanFile(filename) {
  try {
    return parseControlledLoadPlan(readPlanJsonFile(filename));
  } catch (error) {
    if (!(error instanceof PlanFileError)) throw error;
    throw new ControlledLoadPlanError(error.message,
      error.code === "PLAN_FILE_CHANGED"
        ? "CONTROLLED_LOAD_PLAN_FILE_CHANGED"
        : error.code === "PLAN_FILE_CONTENT_ERROR"
          ? "INVALID_CONTROLLED_LOAD_PLAN"
          : "CONTROLLED_LOAD_PLAN_FILE_ERROR");
  }
}
