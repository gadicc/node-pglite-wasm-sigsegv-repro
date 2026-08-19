import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

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

export const GROUP_PLAN_FILE_VERSION = 1;
export const GROUP_PLAN_FILE_MAX_BYTES = 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

function stablePlanBytes(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || filename.includes("\0") ||
      Buffer.byteLength(filename) > 16 * 1024) {
    fail("--plan-file must be a bounded absolute NUL-free path", "GROUP_PLAN_FILE_ERROR");
  }
  let fd;
  try {
    const before = lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.size <= 0n ||
        before.size > BigInt(GROUP_PLAN_FILE_MAX_BYTES) || before.nlink !== 1n) {
      fail(`--plan-file must be a nonempty singly-linked regular file no larger than ${GROUP_PLAN_FILE_MAX_BYTES} bytes`,
        "GROUP_PLAN_FILE_ERROR");
    }
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino ||
        before.size !== opened.size || before.mtimeNs !== opened.mtimeNs ||
        before.ctimeNs !== opened.ctimeNs || opened.nlink !== 1n) {
      fail("--plan-file changed while it was opened", "GROUP_PLAN_FILE_CHANGED");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (opened.dev !== after.dev || opened.ino !== after.ino ||
        opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs || bytes.length !== Number(opened.size)) {
      fail("--plan-file changed while it was read", "GROUP_PLAN_FILE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof GroupPlanError) throw error;
    fail(`--plan-file could not be read safely: ${error?.code ?? "unknown error"}`,
      "GROUP_PLAN_FILE_ERROR");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  const bytes = stablePlanBytes(filename);
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail("--plan-file must contain valid UTF-8", "GROUP_PLAN_FILE_ERROR");
  }
  if (text.includes("\0") || text.includes("\r")) {
    fail("--plan-file contains a forbidden control byte", "GROUP_PLAN_FILE_ERROR");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("--plan-file must contain valid JSON", "GROUP_PLAN_FILE_ERROR");
  }
  return parseGroupPlan(value);
}
