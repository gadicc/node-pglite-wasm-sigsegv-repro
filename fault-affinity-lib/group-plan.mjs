import {
  MAX_BASELINE_CHILDREN,
  MAX_BASELINE_WAVES,
} from "../diagnose-lib/baseline-phase.mjs";
import {
  MAX_GROUP_CHILDREN,
  MAX_GROUP_CONTEXTS,
} from "../diagnose-lib/group-phase.mjs";
import {
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

export const GROUP_PLAN_FILE_VERSION = 1;
export const GROUP_PLAN_FILE_MAX_BYTES = PLAN_FILE_MAX_BYTES;

export class GroupPlanError extends Error {
  constructor(message, code = "INVALID_GROUP_PLAN") {
    super(message);
    this.name = "GroupPlanError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new GroupPlanError(message, code);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
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

function boundedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > 1024) {
    fail(`${label} must be a bounded nonempty NUL-free string`);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseGroupPlan(value) {
  exactKeys(value, ["version", "baseline", "groups", "exact"], "group plan");
  if (value.version !== GROUP_PLAN_FILE_VERSION) {
    fail(`group plan version must be ${GROUP_PLAN_FILE_VERSION}`);
  }

  exactKeys(value.baseline, ["children", "waves"], "group plan baseline");
  const baseline = {
    childrenPerWave: integer(value.baseline.children, "baseline children", 1,
      MAX_BASELINE_CHILDREN),
    waves: integer(value.baseline.waves, "baseline waves", 1, MAX_BASELINE_WAVES),
  };
  if (baseline.childrenPerWave * baseline.waves > MAX_SCHEDULE_ENTRIES) {
    fail(`baseline schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
  }

  exactKeys(value.groups, ["cpuUniverse", "contexts", "rounds", "seed"],
    "group plan groups");
  if (!Array.isArray(value.groups.contexts) || value.groups.contexts.length < 1 ||
      value.groups.contexts.length > MAX_GROUP_CONTEXTS) {
    fail(`group contexts must contain 1 through ${MAX_GROUP_CONTEXTS} entries`);
  }
  const contexts = value.groups.contexts.map((context, index) => {
    exactKeys(context, ["id", "kind", "cpus", "children"],
      `group context ${index + 1}`);
    return {
      id: boundedString(context.id, `group context ${index + 1} id`),
      kind: boundedString(context.kind, `group context ${index + 1} kind`),
      cpus: cpuList(context.cpus, `group context ${index + 1} CPUs`),
      childrenPerWave: integer(context.children,
        `group context ${index + 1} children`, 1, MAX_GROUP_CHILDREN),
    };
  });
  const groups = {
    cpuUniverse: cpuList(value.groups.cpuUniverse, "group CPU universe"),
    contexts,
    rounds: integer(value.groups.rounds, "group rounds", 1, MAX_SCHEDULE_ENTRIES),
    seed: integer(value.groups.seed, "group seed", 0, MAX_SEED),
  };

  exactKeys(value.exact, ["cpus", "rounds", "seed"], "group plan exact");
  const exact = {
    cpus: cpuList(value.exact.cpus, "exact CPUs"),
    rounds: integer(value.exact.rounds, "exact rounds", 1, MAX_SCHEDULE_ENTRIES),
    seed: integer(value.exact.seed, "exact seed", 0, MAX_SEED),
  };
  if (exact.cpus.length * exact.rounds > MAX_SCHEDULE_ENTRIES) {
    fail(`exact schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
  }

  return deepFreeze({ version: GROUP_PLAN_FILE_VERSION, baseline, groups, exact });
}

export function readGroupPlanFile(filename) {
  try {
    return parseGroupPlan(readPlanJsonFile(filename));
  } catch (error) {
    if (!(error instanceof PlanFileError)) throw error;
    throw new GroupPlanError(error.message,
      error.code === "PLAN_FILE_CHANGED"
        ? "GROUP_PLAN_FILE_CHANGED"
        : error.code === "PLAN_FILE_CONTENT_ERROR"
          ? "INVALID_GROUP_PLAN"
          : "GROUP_PLAN_FILE_ERROR");
  }
}
