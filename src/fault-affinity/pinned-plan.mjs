import {
  MAX_CPU_ID,
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  compressCpuList,
  expandCpuList,
} from "../../diagnose-lib/pinned-runner.mjs";
import { buildPinnedConcurrentPlan } from "../../diagnose-lib/pinned-protocol.mjs";
import { parseGroupPlan } from "./group-plan.mjs";
import { readPlanJsonFile } from "./plan-file.mjs";

export const PINNED_PLAN_FILE_VERSION = 1;

const MAX_PINNED_CONTEXTS = 256;

export class PinnedPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedPlanError";
    this.code = "INVALID_PINNED_PLAN";
  }
}

function fail(message) {
  throw new PinnedPlanError(message);
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

function boundedString(value, label, maximum = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > maximum) {
    fail(`${label} must be a bounded nonempty NUL-free string`);
  }
  return value;
}

function cpuList(value, label) {
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
  return cpus;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parsePinnedPlan(value) {
  exactKeys(value, ["version", "baseline", "groups", "pinnedConcurrent", "exact"],
    "pinned plan");
  if (value.version !== PINNED_PLAN_FILE_VERSION) {
    fail(`pinned plan version must be ${PINNED_PLAN_FILE_VERSION}`);
  }
  let base;
  try {
    base = parseGroupPlan({
      version: 1,
      baseline: value.baseline,
      groups: value.groups,
      exact: value.exact,
    });
  } catch (error) {
    fail(`pinned plan sibling schedule is invalid: ${error.message}`);
  }

  exactKeys(value.pinnedConcurrent, ["contexts", "rounds", "seed"],
    "pinned plan pinnedConcurrent");
  if (!Array.isArray(value.pinnedConcurrent.contexts) ||
      value.pinnedConcurrent.contexts.length < 1 ||
      value.pinnedConcurrent.contexts.length > MAX_PINNED_CONTEXTS) {
    fail(`pinned contexts must contain 1 through ${MAX_PINNED_CONTEXTS} entries`);
  }
  let attemptsPerRound = 0;
  const contexts = value.pinnedConcurrent.contexts.map((context, index) => {
    exactKeys(context, ["id", "kind", "cpus", "cluster", "controllerCpu"],
      `pinned context ${index + 1}`);
    const cpus = cpuList(context.cpus, `pinned context ${index + 1} CPUs`);
    attemptsPerRound += cpus.length;
    return {
      group: boundedString(context.id, `pinned context ${index + 1} id`, 64),
      kind: boundedString(context.kind, `pinned context ${index + 1} kind`, 32),
      cpus,
      cluster: boundedString(context.cluster, `pinned context ${index + 1} cluster`),
      controllerCpu: integer(context.controllerCpu,
        `pinned context ${index + 1} controllerCpu`, 0, MAX_CPU_ID),
    };
  });
  const rounds = integer(value.pinnedConcurrent.rounds, "pinned rounds", 1,
    MAX_SCHEDULE_ENTRIES);
  if (attemptsPerRound * rounds > MAX_SCHEDULE_ENTRIES) {
    fail(`pinned schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
  }
  const pinnedConcurrent = {
    contexts,
    rounds,
    seed: integer(value.pinnedConcurrent.seed, "pinned seed", 0, MAX_SEED),
  };
  try {
    buildPinnedConcurrentPlan(pinnedConcurrent);
  } catch (error) {
    fail(`pinned contexts are invalid: ${error.message}`);
  }

  return deepFreeze({
    version: PINNED_PLAN_FILE_VERSION,
    baseline: base.baseline,
    groups: base.groups,
    pinnedConcurrent,
    exact: base.exact,
  });
}

export function readPinnedPlanFile(filename) {
  return parsePinnedPlan(readPlanJsonFile(filename));
}
