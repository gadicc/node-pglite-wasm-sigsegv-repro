import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { readLinuxAllowedCpuList } from "../diagnose-lib/attempt-runner.mjs";
import {
  buildBaselinePhaseManifest,
  MAX_BASELINE_CHILDREN,
  MAX_BASELINE_WAVES,
} from "../diagnose-lib/baseline-phase.mjs";
import { buildControlledLoadSessionManifest } from "../diagnose-lib/controlled-load-session.mjs";
import { buildExactCpuPhaseManifest } from "../diagnose-lib/exact-cpu-phase.mjs";
import { buildGroupPhaseManifest } from "../diagnose-lib/group-phase.mjs";
import { buildPinnedConcurrentPhaseManifest } from "../diagnose-lib/pinned-concurrent-phase.mjs";
import {
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  compressCpuList,
  expandCpuList,
} from "../diagnose-lib/pinned-runner.mjs";
import {
  buildSchema3BundleManifest,
  buildSchema3BundleManifestV2,
  buildSchema3BundleManifestV3,
  buildSchema3BundleManifestV4,
  buildSchema3BundleManifestV5,
  initializeSchema3Bundle,
  newSchema3BundleGeneration,
  readSchema3Bundle,
  runOneSchema3BaselineWave,
  runOneSchema3ControlledLoadSession,
  runOneSchema3ExactCpuAttempt,
  runOneSchema3GroupWave,
} from "../diagnose-lib/schema3-bundle.mjs";
import {
  listBuiltInWorkloads,
  resolveWorkloadSelection,
} from "../workloads/catalog.mjs";
import { readControlledLoadPlanFile } from "./controlled-load-plan.mjs";
import { readGroupPlanFile } from "./group-plan.mjs";
import { readPinnedPlanFile } from "./pinned-plan.mjs";
import { runPinnedWaveProcess } from "./pinned-wave-client.mjs";

const DEFAULT_TASKSET_PATH = "/usr/bin/taskset";
const ZERO_GENERATION = "0".repeat(32);
const MAX_PATH_BYTES = 16 * 1024;

const HELP = `Fault Affinity: bounded, resumable workload diagnostics

Usage:
  fault-affinity workloads [--json]
  fault-affinity inspect (--workload ID | --workload-file FILE) [--json]
  fault-affinity baseline (--workload ID | --workload-file FILE) \\
    --children N --waves N --exact-cpus LIST [--exact-rounds N] \\
    [--exact-seed N] --out-dir DIR (--dry-run | --yes)
  fault-affinity baseline --resume DIR (--workload ID | --workload-file FILE) --yes
  fault-affinity groups (--workload ID | --workload-file FILE) \\
    --plan-file FILE --out-dir DIR (--dry-run | --yes)
  fault-affinity groups --resume DIR (--workload ID | --workload-file FILE) --yes
  fault-affinity pinned (--workload ID | --workload-file FILE) \\
    --plan-file FILE --out-dir DIR (--dry-run | --yes)
  fault-affinity pinned --resume DIR (--workload ID | --workload-file FILE) --yes
  fault-affinity controlled-load (--workload ID | --workload-file FILE) \\
    --condition-workload-file FILE --plan-file FILE --out-dir DIR \\
    (--dry-run | --yes)
  fault-affinity controlled-load --resume DIR \\
    (--workload ID | --workload-file FILE) --condition-workload-file FILE --yes
  fault-affinity exact (--workload ID | --workload-file FILE) \\
    --cpus LIST [--rounds N] [--seed N] --out-dir DIR (--dry-run | --yes)
  fault-affinity exact --resume DIR (--workload ID | --workload-file FILE) \\
    [--condition-workload-file FILE] --yes

The baseline command creates schema-3 v2 bundles. The groups command creates
v3 bundles from a bounded plan file. The pinned command creates v4 bundles that
also bind controller-aware pinned-concurrent schedules. The controlled-load
command creates the v5 A/B/A variant with separate measured and condition
workloads. Phase commands can advance their matching state in later compatible
bundle versions. The exact command also creates exact-only v1 bundles. Listing,
inspection, and dry runs never execute a workload or create an evidence bundle.
Every live run requires explicit workload selection and --yes.
`;

export class FaultAffinityCliError extends Error {
  constructor(message, code = "INVALID_FAULT_AFFINITY_ARGUMENTS") {
    super(message);
    this.name = "FaultAffinityCliError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new FaultAffinityCliError(message, code);
}

function takeOption(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return value;
}

function setOnce(target, key, value, option) {
  if (Object.hasOwn(target, key)) fail(`${option} may be supplied only once`);
  target[key] = value;
}

function parseOptions(argv, allowedValueOptions, allowedFlags) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const key = allowedValueOptions.get(option);
    if (key !== undefined) {
      setOnce(result, key, takeOption(argv, index, option), option);
      index += 1;
      continue;
    }
    const flagKey = allowedFlags.get(option);
    if (flagKey !== undefined) {
      setOnce(result, flagKey, true, option);
      continue;
    }
    fail(`unknown option '${option}'`);
  }
  return result;
}

function selectionFrom(options) {
  if ((options.workload === undefined) === (options.workloadFile === undefined)) {
    fail("select exactly one --workload ID or --workload-file FILE");
  }
  return {
    ...(options.workload === undefined ? {} : { workload: options.workload }),
    ...(options.workloadFile === undefined ? {} : { workloadFile: options.workloadFile }),
  };
}

function parseCanonicalInteger(value, label, minimum, maximum) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} must be a canonical decimal integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function parseCanonicalCpuList(value, label = "--cpus") {
  let cpus;
  try {
    cpus = expandCpuList(value);
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
  const ascending = [...cpus].sort((left, right) => left - right);
  if (ascending.some((cpu, index) => cpu !== cpus[index]) || compressCpuList(cpus) !== value) {
    fail(`${label} must be a canonical ascending CPU list such as 0-3,8`);
  }
  return cpus;
}

export function parseFaultAffinityArgs(argv) {
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) {
    fail("arguments must be an array of strings");
  }
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h"].includes(argv[0]))) {
    return Object.freeze({ command: "help" });
  }
  const [command, ...rest] = argv;
  if (command === "workloads") {
    const options = parseOptions(rest, new Map(), new Map([
      ["--json", "json"], ["--help", "help"], ["-h", "help"],
    ]));
    return Object.freeze({ command, ...options });
  }
  if (command === "inspect") {
    const options = parseOptions(rest, new Map([
      ["--workload", "workload"],
      ["--workload-file", "workloadFile"],
    ]), new Map([
      ["--json", "json"], ["--help", "help"], ["-h", "help"],
    ]));
    if (!options.help) selectionFrom(options);
    return Object.freeze({ command, ...options });
  }
  if (command === "exact") {
    const options = parseOptions(rest, new Map([
      ["--workload", "workload"],
      ["--workload-file", "workloadFile"],
      ["--condition-workload-file", "conditionWorkloadFile"],
      ["--cpus", "cpuSpec"],
      ["--rounds", "roundsText"],
      ["--seed", "seedText"],
      ["--out-dir", "outDir"],
      ["--resume", "resumeDir"],
      ["--taskset", "tasksetPath"],
    ]), new Map([
      ["--dry-run", "dryRun"], ["--yes", "yes"],
      ["--help", "help"], ["-h", "help"],
    ]));
    if (options.help) return Object.freeze({ command, help: true });
    const selection = selectionFrom(options);
    if (options.resumeDir !== undefined) {
      const fresh = ["cpuSpec", "roundsText", "seedText", "outDir", "tasksetPath"]
        .filter((key) => options[key] !== undefined);
      if (fresh.length > 0) fail("--resume cannot be combined with fresh schedule options");
      if (!options.yes || options.dryRun) fail("an exact resume requires --yes");
      return Object.freeze({ command, mode: "resume", ...selection,
        resumeDir: options.resumeDir,
        ...(options.conditionWorkloadFile === undefined ? {} : {
          conditionWorkloadFile: options.conditionWorkloadFile,
        }) });
    }
    if (options.conditionWorkloadFile !== undefined) {
      fail("--condition-workload-file is supported only when resuming a controlled-load bundle");
    }
    if (options.cpuSpec === undefined || options.outDir === undefined) {
      fail("a fresh exact run requires --cpus LIST and --out-dir DIR");
    }
    if (Boolean(options.dryRun) === Boolean(options.yes)) {
      fail("choose exactly one --dry-run or --yes for a fresh exact run");
    }
    return Object.freeze({
      command,
      mode: options.dryRun ? "dry-run" : "fresh",
      ...selection,
      cpus: parseCanonicalCpuList(options.cpuSpec),
      cpuSpec: options.cpuSpec,
      rounds: parseCanonicalInteger(options.roundsText ?? "1", "--rounds", 1,
        MAX_SCHEDULE_ENTRIES),
      seed: parseCanonicalInteger(options.seedText ?? "0", "--seed", 0, MAX_SEED),
      outDir: options.outDir,
      tasksetPath: options.tasksetPath ?? DEFAULT_TASKSET_PATH,
    });
  }
  if (command === "baseline") {
    const options = parseOptions(rest, new Map([
      ["--workload", "workload"],
      ["--workload-file", "workloadFile"],
      ["--children", "childrenText"],
      ["--waves", "wavesText"],
      ["--exact-cpus", "exactCpuSpec"],
      ["--exact-rounds", "exactRoundsText"],
      ["--exact-seed", "exactSeedText"],
      ["--out-dir", "outDir"],
      ["--resume", "resumeDir"],
      ["--taskset", "tasksetPath"],
    ]), new Map([
      ["--dry-run", "dryRun"], ["--yes", "yes"],
      ["--help", "help"], ["-h", "help"],
    ]));
    if (options.help) return Object.freeze({ command, help: true });
    const selection = selectionFrom(options);
    if (options.resumeDir !== undefined) {
      const fresh = [
        "childrenText", "wavesText", "exactCpuSpec", "exactRoundsText",
        "exactSeedText", "outDir", "tasksetPath",
      ].filter((key) => options[key] !== undefined);
      if (fresh.length > 0) fail("--resume cannot be combined with fresh schedule options");
      if (!options.yes || options.dryRun) fail("a baseline resume requires --yes");
      return Object.freeze({ command, mode: "resume", ...selection,
        resumeDir: options.resumeDir });
    }
    if (options.childrenText === undefined || options.wavesText === undefined ||
        options.exactCpuSpec === undefined || options.outDir === undefined) {
      fail("a fresh baseline run requires --children N, --waves N, --exact-cpus LIST, and --out-dir DIR");
    }
    if (Boolean(options.dryRun) === Boolean(options.yes)) {
      fail("choose exactly one --dry-run or --yes for a fresh baseline run");
    }
    const children = parseCanonicalInteger(options.childrenText, "--children", 1,
      MAX_BASELINE_CHILDREN);
    const waves = parseCanonicalInteger(options.wavesText, "--waves", 1,
      MAX_BASELINE_WAVES);
    if (children * waves > MAX_SCHEDULE_ENTRIES) {
      fail(`baseline schedule exceeds ${MAX_SCHEDULE_ENTRIES} attempts`);
    }
    return Object.freeze({
      command,
      mode: options.dryRun ? "dry-run" : "fresh",
      ...selection,
      children,
      waves,
      exactCpus: parseCanonicalCpuList(options.exactCpuSpec, "--exact-cpus"),
      exactCpuSpec: options.exactCpuSpec,
      exactRounds: parseCanonicalInteger(options.exactRoundsText ?? "1", "--exact-rounds",
        1, MAX_SCHEDULE_ENTRIES),
      exactSeed: parseCanonicalInteger(options.exactSeedText ?? "0", "--exact-seed",
        0, MAX_SEED),
      outDir: options.outDir,
      tasksetPath: options.tasksetPath ?? DEFAULT_TASKSET_PATH,
    });
  }
  if (command === "controlled-load") {
    const options = parseOptions(rest, new Map([
      ["--workload", "workload"],
      ["--workload-file", "workloadFile"],
      ["--condition-workload-file", "conditionWorkloadFile"],
      ["--plan-file", "planFile"],
      ["--out-dir", "outDir"],
      ["--resume", "resumeDir"],
      ["--taskset", "tasksetPath"],
    ]), new Map([
      ["--dry-run", "dryRun"], ["--yes", "yes"],
      ["--help", "help"], ["-h", "help"],
    ]));
    if (options.help) return Object.freeze({ command, help: true });
    const selection = selectionFrom(options);
    if (options.conditionWorkloadFile === undefined) {
      fail("controlled-load requires --condition-workload-file FILE");
    }
    if (options.resumeDir !== undefined) {
      const fresh = ["planFile", "outDir", "tasksetPath"]
        .filter((key) => options[key] !== undefined);
      if (fresh.length > 0) {
        fail("--resume cannot be combined with fresh controlled-load options");
      }
      if (!options.yes || options.dryRun) fail("a controlled-load resume requires --yes");
      return Object.freeze({
        command,
        mode: "resume",
        ...selection,
        conditionWorkloadFile: options.conditionWorkloadFile,
        resumeDir: options.resumeDir,
      });
    }
    if (options.planFile === undefined || options.outDir === undefined) {
      fail("a fresh controlled-load run requires --plan-file FILE and --out-dir DIR");
    }
    if (Boolean(options.dryRun) === Boolean(options.yes)) {
      fail("choose exactly one --dry-run or --yes for a fresh controlled-load run");
    }
    return Object.freeze({
      command,
      mode: options.dryRun ? "dry-run" : "fresh",
      ...selection,
      conditionWorkloadFile: options.conditionWorkloadFile,
      planFile: options.planFile,
      outDir: options.outDir,
      tasksetPath: options.tasksetPath ?? DEFAULT_TASKSET_PATH,
    });
  }
  if (command === "groups" || command === "pinned") {
    const planLabel = command === "groups" ? "group" : "pinned";
    const options = parseOptions(rest, new Map([
      ["--workload", "workload"],
      ["--workload-file", "workloadFile"],
      ["--plan-file", "planFile"],
      ["--out-dir", "outDir"],
      ["--resume", "resumeDir"],
      ["--taskset", "tasksetPath"],
    ]), new Map([
      ["--dry-run", "dryRun"], ["--yes", "yes"],
      ["--help", "help"], ["-h", "help"],
    ]));
    if (options.help) return Object.freeze({ command, help: true });
    const selection = selectionFrom(options);
    if (options.resumeDir !== undefined) {
      const fresh = ["planFile", "outDir", "tasksetPath"]
        .filter((key) => options[key] !== undefined);
      if (fresh.length > 0) {
        fail(`--resume cannot be combined with fresh ${planLabel} options`);
      }
      if (!options.yes || options.dryRun) fail(`a ${command} resume requires --yes`);
      return Object.freeze({ command, mode: "resume", ...selection,
        resumeDir: options.resumeDir });
    }
    if (options.planFile === undefined || options.outDir === undefined) {
      fail(`a fresh ${command} run requires --plan-file FILE and --out-dir DIR`);
    }
    if (Boolean(options.dryRun) === Boolean(options.yes)) {
      fail(`choose exactly one --dry-run or --yes for a fresh ${command} run`);
    }
    return Object.freeze({
      command,
      mode: options.dryRun ? "dry-run" : "fresh",
      ...selection,
      planFile: options.planFile,
      outDir: options.outDir,
      tasksetPath: options.tasksetPath ?? DEFAULT_TASKSET_PATH,
    });
  }
  fail(`unknown command '${command}'`);
}

function boundedPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > MAX_PATH_BYTES) {
    fail(`${label} must be a bounded nonempty NUL-free path`);
  }
  return path.resolve(value);
}

function resolveExecutablePath(value, label) {
  const requested = boundedPath(value, label);
  let canonical;
  let stat;
  try {
    canonical = realpathSync(requested);
    stat = statSync(canonical);
    accessSync(canonical, constants.X_OK);
  } catch (error) {
    fail(`${label} must resolve to an executable regular file: ${error?.code ?? "unavailable"}`);
  }
  if (!stat.isFile()) fail(`${label} must resolve to an executable regular file`);
  return canonical;
}

function resolveExistingBundleDirectory(value) {
  const requested = boundedPath(value, "--resume");
  let canonical;
  try {
    canonical = realpathSync(requested);
  } catch (error) {
    fail(`--resume directory is unavailable: ${error?.code ?? "unknown error"}`);
  }
  return canonical;
}

function createPrivateBundleDirectory(value) {
  const requested = boundedPath(value, "--out-dir");
  const parent = path.dirname(requested);
  let canonicalParent;
  try {
    canonicalParent = realpathSync(parent);
  } catch (error) {
    fail(`--out-dir parent is unavailable: ${error?.code ?? "unknown error"}`);
  }
  if (canonicalParent !== parent) {
    fail("--out-dir parent must use its canonical path without symbolic links");
  }
  try {
    lstatSync(requested);
    fail("--out-dir already exists; use --resume for an existing bundle");
  } catch (error) {
    if (error instanceof FaultAffinityCliError) throw error;
    if (error?.code !== "ENOENT") {
      fail(`--out-dir could not be inspected: ${error?.code ?? "unknown error"}`);
    }
  }
  try {
    mkdirSync(requested, { mode: 0o700 });
  } catch (error) {
    fail(`--out-dir could not be created: ${error?.code ?? "unknown error"}`);
  }
  return realpathSync(requested);
}

function ensureAllowedCpus(cpus) {
  let allowedSpec;
  try {
    allowedSpec = readLinuxAllowedCpuList(process.pid, { strict: true });
  } catch (error) {
    fail(`could not read the invoking process CPU allowance: ${error?.code ?? error.message}`,
      "FAULT_AFFINITY_PREFLIGHT_FAILED");
  }
  if (allowedSpec === null) {
    fail("could not read the invoking process CPU allowance",
      "FAULT_AFFINITY_PREFLIGHT_FAILED");
  }
  const allowed = new Set(expandCpuList(allowedSpec));
  const unavailable = cpus.filter((cpu) => !allowed.has(cpu));
  if (unavailable.length > 0) {
    fail(`requested CPUs are outside the invoking process allowance: ${unavailable.join(",")}`,
      "FAULT_AFFINITY_PREFLIGHT_FAILED");
  }
  return allowedSpec;
}

function workloadSummary(selection) {
  const { resolved, metadata } = selection;
  return {
    source: selection.source,
    id: resolved.id,
    label: resolved.label,
    description: resolved.description,
    role: metadata.role,
    recommended: metadata.recommended,
    risk: resolved.risk,
    liveWarning: metadata.liveWarning,
    digest: resolved.digest,
    command: {
      executable: resolved.command.executable.path,
      args: [...resolved.command.args],
      cwd: resolved.command.cwd,
    },
    attempt: resolved.attempt,
    capabilities: resolved.capabilities,
    provenance: resolved.provenance,
    ...(metadata.file === undefined ? {} : { definitionFile: metadata.file }),
  };
}

function renderWorkload(selection) {
  const summary = workloadSummary(selection);
  return [
    `${summary.id}: ${summary.label}`,
    `source: ${summary.source}`,
    `role: ${summary.role}`,
    `risk: ${summary.risk}`,
    `attempt: ${summary.attempt.mode}, ${summary.attempt.timeoutMs} ms deadline`,
    `baseline capability: ${summary.capabilities.baseline ? "supported" : "unsupported"}`,
    `CPU-group capability: ${summary.capabilities.groups ? "supported" : "unsupported"}`,
    `pinned-concurrent capability: ${summary.capabilities.pinnedConcurrent ? "supported" : "unsupported"}`,
    `exact-CPU capability: ${summary.capabilities.isolated ? "supported" : "unsupported"}`,
    `workload digest: ${summary.digest}`,
    `warning: ${summary.liveWarning}`,
  ].join("\n");
}

function resolveSelection(parsed, cwd) {
  return resolveWorkloadSelection({
    ...(parsed.workload === undefined ? {} : { workload: parsed.workload }),
    ...(parsed.workloadFile === undefined ? {} : {
      workloadFile: path.resolve(cwd, parsed.workloadFile),
    }),
  });
}

function resolveConditionSelection(parsed, cwd) {
  return resolveWorkloadSelection({
    workloadFile: path.resolve(cwd, parsed.conditionWorkloadFile),
  });
}

function assertControlledLoadCondition(selection) {
  if (selection.resolved.attempt.mode !== "survive-window") {
    fail(`condition workload '${selection.resolved.id}' must use survive-window lifecycle semantics`);
  }
}

function assertExactCapability(selection) {
  if (selection.resolved.capabilities.isolated !== true) {
    fail(`workload '${selection.resolved.id}' does not declare exact-CPU capability`);
  }
}

function assertBaselineCapabilities(selection) {
  if (selection.resolved.capabilities.baseline !== true) {
    fail(`workload '${selection.resolved.id}' does not declare baseline capability`);
  }
  if (selection.resolved.capabilities.isolated !== true) {
    fail(`workload '${selection.resolved.id}' does not declare exact-CPU capability required by schema-3 v2`);
  }
}

function assertGroupCapabilities(selection) {
  const required = ["baseline", "groups", "isolated"];
  const missing = required.filter((capability) =>
    selection.resolved.capabilities[capability] !== true);
  if (missing.length > 0) {
    fail(`workload '${selection.resolved.id}' does not declare required group-suite ` +
      `capabilities: ${missing.join(", ")}`);
  }
}

function assertPinnedCapabilities(selection) {
  const required = ["baseline", "groups", "pinnedConcurrent", "isolated"];
  const missing = required.filter((capability) =>
    selection.resolved.capabilities[capability] !== true);
  if (missing.length > 0) {
    fail(`workload '${selection.resolved.id}' does not declare required pinned-suite ` +
      `capabilities: ${missing.join(", ")}`);
  }
}

function assertAutomationBoundary(selection) {
  if (process.env.DIAG_TEST_FORBID_WORKLOAD === "1" && selection.source === "built-in") {
    fail("the automated test boundary refuses live built-in workloads",
      "FAULT_AFFINITY_TEST_BOUNDARY");
  }
}

function generation() {
  return randomBytes(16).toString("hex");
}

function buildFreshManifest(resolved, parsed, tasksetPath, dryRun) {
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpus: parsed.cpus,
    rounds: parsed.rounds,
    seed: parsed.seed,
    tasksetPath,
  });
  return buildSchema3BundleManifest(resolved, {
    bundleGeneration: dryRun ? ZERO_GENERATION : newSchema3BundleGeneration(),
    exactCpuManifest,
  });
}

function buildFreshBaselineManifest(resolved, parsed, tasksetPath, dryRun) {
  const baselineManifest = buildBaselinePhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    childrenPerWave: parsed.children,
    waves: parsed.waves,
  });
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpus: parsed.exactCpus,
    rounds: parsed.exactRounds,
    seed: parsed.exactSeed,
    tasksetPath,
  });
  return buildSchema3BundleManifestV2(resolved, {
    bundleGeneration: dryRun ? ZERO_GENERATION : newSchema3BundleGeneration(),
    baselineManifest,
    exactCpuManifest,
  });
}

function buildFreshGroupManifest(resolved, plan, tasksetPath, dryRun) {
  const baselineManifest = buildBaselinePhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    childrenPerWave: plan.baseline.childrenPerWave,
    waves: plan.baseline.waves,
  });
  const groupManifest = buildGroupPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpuUniverse: plan.groups.cpuUniverse,
    contexts: plan.groups.contexts,
    rounds: plan.groups.rounds,
    seed: plan.groups.seed,
    tasksetPath,
  });
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpus: plan.exact.cpus,
    rounds: plan.exact.rounds,
    seed: plan.exact.seed,
    tasksetPath,
  });
  return buildSchema3BundleManifestV3(resolved, {
    bundleGeneration: dryRun ? ZERO_GENERATION : newSchema3BundleGeneration(),
    baselineManifest,
    groupManifest,
    exactCpuManifest,
  });
}

function buildFreshPinnedManifest(resolved, plan, tasksetPath, dryRun) {
  const baselineManifest = buildBaselinePhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    childrenPerWave: plan.baseline.childrenPerWave,
    waves: plan.baseline.waves,
  });
  const groupManifest = buildGroupPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpuUniverse: plan.groups.cpuUniverse,
    contexts: plan.groups.contexts,
    rounds: plan.groups.rounds,
    seed: plan.groups.seed,
    tasksetPath,
  });
  const pinnedConcurrentManifest = buildPinnedConcurrentPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    contexts: plan.pinnedConcurrent.contexts,
    rounds: plan.pinnedConcurrent.rounds,
    seed: plan.pinnedConcurrent.seed,
    tasksetPath,
  });
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpus: plan.exact.cpus,
    rounds: plan.exact.rounds,
    seed: plan.exact.seed,
    tasksetPath,
  });
  return buildSchema3BundleManifestV4(resolved, {
    bundleGeneration: dryRun ? ZERO_GENERATION : newSchema3BundleGeneration(),
    baselineManifest,
    groupManifest,
    pinnedConcurrentManifest,
    exactCpuManifest,
  });
}

function buildFreshControlledLoadManifest(
  resolved,
  auxiliary,
  plan,
  tasksetPath,
  dryRun,
) {
  const controlledLoadManifest = buildControlledLoadSessionManifest(resolved, auxiliary, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    attemptsPerLeg: plan.controlledLoad.attemptsPerLeg,
    targetCpu: plan.controlledLoad.targetCpu,
    workerCpus: plan.controlledLoad.workerCpus,
    tasksetPath,
    warmupMs: plan.controlledLoad.warmupMs,
    recoveryMs: plan.controlledLoad.recoveryMs,
  });
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: dryRun ? ZERO_GENERATION : generation(),
    cpus: plan.exact.cpus,
    rounds: plan.exact.rounds,
    seed: plan.exact.seed,
    tasksetPath,
  });
  return buildSchema3BundleManifestV5(resolved, auxiliary, {
    bundleGeneration: dryRun ? ZERO_GENERATION : newSchema3BundleGeneration(),
    controlledLoadManifest,
    exactCpuManifest,
  });
}

function installSignalForwarding(signalSource) {
  const controller = new AbortController();
  let received = null;
  const handlers = new Map([
    ["SIGINT", () => { received ??= "SIGINT"; controller.abort(); }],
    ["SIGTERM", () => { received ??= "SIGTERM"; controller.abort(); }],
  ]);
  for (const [signal, handler] of handlers) signalSource.once(signal, handler);
  return {
    signal: controller.signal,
    received: () => received,
    remove() {
      for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
    },
  };
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

async function runExactBundle({
  resolved,
  auxiliary,
  bundleDir,
  signalSource,
  writeOut,
  writeErr,
}) {
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, auxiliary, bundleDir });
    while (!bundle.exactCpu.progress.complete) {
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      const { nextSlot, committedAttempts, totalAttempts } = bundle.exactCpu.progress;
      writeOut(`attempt ${committedAttempts + 1}/${totalAttempts} cpu=${nextSlot.cpu}\n`);
      const execution = await runOneSchema3ExactCpuAttempt({
        resolved,
        auxiliary,
        bundleDir,
        attemptOptions: { signal: forwarding.signal },
      });
      bundle = execution.bundle;
      if (execution.result.committed) {
        const outcome = execution.result.envelope.attempt.evidence.outcome;
        writeOut(`committed cpu=${execution.result.slot.cpu} outcome=${outcome.category}` +
          ` label=${outcome.label}\n`);
        continue;
      }
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      if (execution.result.reason === "complete") break;
      writeErr(`attempt was not committed: ${execution.result.reason}` +
        `${execution.result.errorCode ? ` (${execution.result.errorCode})` : ""}\n`);
      return 1;
    }
    writeOut(`complete: ${bundle.exactCpu.progress.committedAttempts}/` +
      `${bundle.exactCpu.progress.totalAttempts} exact-CPU attempts in ${bundleDir}\n`);
    return 0;
  } finally {
    forwarding.remove();
  }
}

function controlledLegOutcomeSummary(leg) {
  const counts = new Map();
  for (const entry of leg.attempts) {
    const category = entry.evidence.outcome.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([category, count]) => `${category}:${count}`)
    .join(",");
}

async function runControlledLoadBundle({
  resolved,
  auxiliary,
  bundleDir,
  signalSource,
  writeOut,
  writeErr,
}) {
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, auxiliary, bundleDir });
    if (bundle.controlledLoad === undefined) {
      fail("schema-3 bundle does not bind a controlled-load phase");
    }
    if (!bundle.controlledLoad.progress.complete) {
      writeOut("session 1/1 protocol=A1/B/A2\n");
      const execution = await runOneSchema3ControlledLoadSession({
        resolved,
        auxiliary,
        bundleDir,
        attemptOptions: { signal: forwarding.signal },
      });
      bundle = execution.bundle;
      if (execution.result.committed) {
        const summaries = execution.result.envelope.legs
          .map((leg) => `${leg.leg}:${controlledLegOutcomeSummary(leg)}`)
          .join(" ");
        writeOut(`committed controlled-load session ${summaries}\n`);
      } else if (forwarding.signal.aborted) {
        return signalExitCode(forwarding.received());
      } else if (execution.result.reason !== "complete") {
        writeErr(`controlled-load session was not committed: ${execution.result.reason}` +
          ` stage=${execution.result.stage}` +
          `${execution.result.errorCode ? ` (${execution.result.errorCode})` : ""}\n`);
        return 1;
      }
    }
    writeOut(`complete: ${bundle.controlledLoad.progress.committedSessions}/` +
      `${bundle.controlledLoad.progress.totalSessions} controlled-load sessions in ` +
      `${bundleDir}\n`);
    return 0;
  } finally {
    forwarding.remove();
  }
}

function outcomeSummary(envelope) {
  const counts = new Map();
  for (const entry of envelope.attempts) {
    const category = entry.attempt.evidence.outcome.category;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([category, count]) => `${category}:${count}`)
    .join(",");
}

async function runBaselineBundle({ resolved, bundleDir, signalSource, writeOut, writeErr }) {
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, bundleDir });
    if (bundle.baseline === undefined) {
      fail("schema-3 bundle does not bind a baseline phase");
    }
    while (!bundle.baseline.progress.complete) {
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      const { nextWave, committedWaves, totalWaves } = bundle.baseline.progress;
      writeOut(`wave ${committedWaves + 1}/${totalWaves} children=${nextWave.childCount}\n`);
      const execution = await runOneSchema3BaselineWave({
        resolved,
        bundleDir,
        attemptOptions: { signal: forwarding.signal },
      });
      bundle = execution.bundle;
      if (execution.result.committed) {
        writeOut(`committed wave=${execution.result.wave.ordinal} outcomes=` +
          `${outcomeSummary(execution.result.envelope)}\n`);
        continue;
      }
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      if (execution.result.reason === "complete") break;
      writeErr(`baseline wave was not committed: ${execution.result.reason}` +
        `${execution.result.errorCode ? ` (${execution.result.errorCode})` : ""}\n`);
      return 1;
    }
    const { committedWaves, totalWaves, committedAttempts, totalAttempts } =
      bundle.baseline.progress;
    writeOut(`complete: ${committedWaves}/${totalWaves} baseline waves ` +
      `(${committedAttempts}/${totalAttempts} attempts) in ${bundleDir}\n`);
    return 0;
  } finally {
    forwarding.remove();
  }
}

async function runGroupBundle({ resolved, bundleDir, signalSource, writeOut, writeErr }) {
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, bundleDir });
    if (bundle.groups === undefined) {
      fail("schema-3 bundle does not bind a CPU-group phase");
    }
    while (!bundle.groups.progress.complete) {
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      const { nextWave, committedWaves, totalWaves } = bundle.groups.progress;
      writeOut(`group wave ${committedWaves + 1}/${totalWaves} ` +
        `context=${nextWave.contextId} children=${nextWave.childCount}\n`);
      const execution = await runOneSchema3GroupWave({
        resolved,
        bundleDir,
        attemptOptions: { signal: forwarding.signal },
      });
      bundle = execution.bundle;
      if (execution.result.committed) {
        writeOut(`committed group-wave=${execution.result.wave.ordinal} ` +
          `context=${execution.result.wave.contextId} ` +
          `outcomes=${outcomeSummary(execution.result.envelope)}\n`);
        continue;
      }
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      if (execution.result.reason === "complete") break;
      writeErr(`group wave was not committed: ${execution.result.reason}` +
        `${execution.result.errorCode ? ` (${execution.result.errorCode})` : ""}\n`);
      return 1;
    }
    const { committedWaves, totalWaves, committedAttempts, totalAttempts } =
      bundle.groups.progress;
    writeOut(`complete: ${committedWaves}/${totalWaves} CPU-group waves ` +
      `(${committedAttempts}/${totalAttempts} attempts) in ${bundleDir}\n`);
    return 0;
  } finally {
    forwarding.remove();
  }
}

async function runPinnedBundle({
  selection,
  bundleDir,
  signalSource,
  writeOut,
  writeErr,
}) {
  const { resolved } = selection;
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, bundleDir });
    if (bundle.pinnedConcurrent === undefined) {
      fail("schema-3 bundle does not bind a pinned-concurrent phase");
    }
    const tasksetPath = bundle.manifest.pinnedConcurrent.manifest.execution.tasksetPath;
    while (!bundle.pinnedConcurrent.progress.complete) {
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      const { nextWave, committedWaves, totalWaves } =
        bundle.pinnedConcurrent.progress;
      writeOut(`pinned wave ${committedWaves + 1}/${totalWaves} ` +
        `context=${nextWave.contextId} controller=${nextWave.controllerCpu} ` +
        `children=${nextWave.childCount}\n`);
      let execution;
      try {
        execution = await runPinnedWaveProcess({
          selection,
          bundleDir,
          controllerCpu: nextWave.controllerCpu,
          tasksetPath,
          signal: forwarding.signal,
        });
      } catch (error) {
        if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
        throw error;
      }
      bundle = await readSchema3Bundle({ resolved, bundleDir });
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      if (execution.record.committed) {
        const ordinal = execution.record.wave?.ordinal;
        const envelope = bundle.pinnedConcurrent.envelopes.find(
          (candidate) => candidate.wave.ordinal === ordinal,
        );
        if (envelope === undefined) {
          fail("pinned wave owner reported a commit absent from the authoritative bundle",
            "PINNED_WAVE_COMMIT_MISSING");
        }
        writeOut(`committed pinned-wave=${envelope.wave.ordinal} ` +
          `context=${envelope.wave.contextId} controller=${envelope.wave.controllerCpu} ` +
          `outcomes=${outcomeSummary(envelope)}\n`);
        continue;
      }
      if (execution.record.reason === "complete" &&
          bundle.pinnedConcurrent.progress.complete) break;
      const errorCode = execution.record.errorCode;
      if (execution.stderr.length > 0) writeErr(execution.stderr);
      writeErr(`pinned-concurrent wave was not committed: ${execution.record.reason}` +
        `${errorCode === null ? "" : ` (${errorCode})`}\n`);
      return errorCode === "BUNDLE_EXECUTION_LEASE_BUSY" ? 75 : 1;
    }
    const { committedWaves, totalWaves, committedAttempts, totalAttempts } =
      bundle.pinnedConcurrent.progress;
    writeOut(`complete: ${committedWaves}/${totalWaves} pinned-concurrent waves ` +
      `(${committedAttempts}/${totalAttempts} attempts) in ${bundleDir}\n`);
    return 0;
  } finally {
    forwarding.remove();
  }
}

export async function runFaultAffinityCli(argv, io = {}) {
  const writeOut = io.stdout ?? ((value) => process.stdout.write(value));
  const writeErr = io.stderr ?? ((value) => process.stderr.write(value));
  const cwd = io.cwd ?? process.cwd();
  const signalSource = io.signalSource ?? process;
  try {
    const parsed = parseFaultAffinityArgs(argv);
    if (parsed.command === "help" || parsed.help) {
      writeOut(HELP);
      return 0;
    }
    if (parsed.command === "workloads") {
      const workloads = listBuiltInWorkloads();
      if (parsed.json) writeOut(`${JSON.stringify(workloads, null, 2)}\n`);
      else {
        for (const workload of workloads) {
          writeOut(`${workload.id}${workload.recommended ? " (recommended)" : ""}` +
            `\n  ${workload.role}\n  risk: ${workload.risk}\n`);
        }
      }
      return 0;
    }
    const selection = resolveSelection(parsed, cwd);
    if (parsed.command === "inspect") {
      if (parsed.json) writeOut(`${JSON.stringify(workloadSummary(selection), null, 2)}\n`);
      else writeOut(`${renderWorkload(selection)}\n`);
      return 0;
    }
    if (parsed.command === "baseline") {
      assertBaselineCapabilities(selection);
      if (parsed.mode !== "dry-run") assertAutomationBoundary(selection);
      if (parsed.mode === "resume") {
        const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
        writeOut(`resuming baseline workload=${selection.resolved.id} bundle=${bundleDir}\n`);
        writeOut(`warning: ${selection.metadata.liveWarning}\n`);
        return await runBaselineBundle({
          resolved: selection.resolved,
          bundleDir,
          signalSource,
          writeOut,
          writeErr,
        });
      }
      const tasksetPath = resolveExecutablePath(parsed.tasksetPath, "--taskset");
      const allowedCpuSpec = ensureAllowedCpus(parsed.exactCpus);
      const manifest = buildFreshBaselineManifest(
        selection.resolved,
        parsed,
        tasksetPath,
        parsed.mode === "dry-run",
      );
      const baselineAttempts = manifest.baseline.manifest.schedule.attemptCount;
      const exactAttempts = manifest.exactCpu.manifest.schedule.attemptCount;
      if (parsed.mode === "dry-run") {
        writeOut(`${renderWorkload(selection)}\n`);
        writeOut(`plan: baseline ${parsed.children} child(ren) x ${parsed.waves} wave(s); ` +
          `${baselineAttempts} attempt(s)\n`);
        writeOut(`bound exact plan: CPUs ${parsed.exactCpuSpec}; ${parsed.exactRounds} ` +
          `round(s); ${exactAttempts} attempt(s); seed ${parsed.exactSeed}\n`);
        writeOut(`host allowance: ${allowedCpuSpec}\n`);
        writeOut(`planned bundle: ${path.resolve(cwd, parsed.outDir)}\n`);
        writeOut("dry run: no workload executed and no bundle created\n");
        return 0;
      }
      const bundleDir = createPrivateBundleDirectory(path.resolve(cwd, parsed.outDir));
      await initializeSchema3Bundle({
        resolved: selection.resolved,
        manifest,
        bundleDir,
      });
      writeOut(`starting baseline workload=${selection.resolved.id} ` +
        `risk=${selection.resolved.risk} waves=${parsed.waves} ` +
        `children=${parsed.children} bundle=${bundleDir}\n`);
      writeOut(`warning: ${selection.metadata.liveWarning}\n`);
      return await runBaselineBundle({
        resolved: selection.resolved,
        bundleDir,
        signalSource,
        writeOut,
        writeErr,
      });
    }
    if (parsed.command === "controlled-load") {
      assertExactCapability(selection);
      const conditionSelection = resolveConditionSelection(parsed, cwd);
      assertControlledLoadCondition(conditionSelection);
      if (parsed.mode !== "dry-run") {
        assertAutomationBoundary(selection);
        assertAutomationBoundary(conditionSelection);
      }
      if (parsed.mode === "resume") {
        const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
        writeOut(`resuming controlled-load measured=${selection.resolved.id} ` +
          `condition=${conditionSelection.resolved.id} bundle=${bundleDir}\n`);
        writeOut(`measured warning: ${selection.metadata.liveWarning}\n`);
        writeOut(`condition warning: ${conditionSelection.metadata.liveWarning}\n`);
        return await runControlledLoadBundle({
          resolved: selection.resolved,
          auxiliary: conditionSelection.resolved,
          bundleDir,
          signalSource,
          writeOut,
          writeErr,
        });
      }
      const planPath = path.resolve(cwd, parsed.planFile);
      const plan = readControlledLoadPlanFile(planPath);
      const tasksetPath = resolveExecutablePath(parsed.tasksetPath, "--taskset");
      const scheduledCpus = [...new Set([
        plan.controlledLoad.targetCpu,
        ...plan.controlledLoad.workerCpus,
        ...plan.exact.cpus,
      ])].sort((left, right) => left - right);
      const allowedCpuSpec = ensureAllowedCpus(scheduledCpus);
      const manifest = buildFreshControlledLoadManifest(
        selection.resolved,
        conditionSelection.resolved,
        plan,
        tasksetPath,
        parsed.mode === "dry-run",
      );
      const controlledSchedule = manifest.controlledLoad.manifest.schedule;
      const controlledExecution = manifest.controlledLoad.manifest.execution;
      const exactSchedule = manifest.exactCpu.manifest.schedule;
      if (parsed.mode === "dry-run") {
        writeOut("measured workload:\n");
        writeOut(`${renderWorkload(selection)}\n`);
        writeOut("condition workload:\n");
        writeOut(`${renderWorkload(conditionSelection)}\n`);
        writeOut(`plan file: ${planPath}\n`);
        writeOut(`controlled load: target CPU ${controlledExecution.targetCpu}; workers ` +
          `${compressCpuList(controlledExecution.workerCpus)}; ` +
          `${controlledSchedule.attemptsPerLeg} attempt(s) per A1/B/A2 leg; ` +
          `${controlledSchedule.attemptCount} attempt(s) total\n`);
        writeOut(`timing: warmup ${controlledSchedule.warmupMs} ms; ` +
          `recovery ${controlledSchedule.recoveryMs} ms\n`);
        writeOut(`bound exact: CPUs ${compressCpuList(plan.exact.cpus)}; ` +
          `${exactSchedule.rounds} round(s); ${exactSchedule.attemptCount} attempt(s); ` +
          `seed ${exactSchedule.seed}\n`);
        writeOut(`host allowance: ${allowedCpuSpec}\n`);
        writeOut(`planned bundle: ${path.resolve(cwd, parsed.outDir)}\n`);
        writeOut("dry run: no workload executed and no bundle created\n");
        return 0;
      }
      const bundleDir = createPrivateBundleDirectory(path.resolve(cwd, parsed.outDir));
      await initializeSchema3Bundle({
        resolved: selection.resolved,
        auxiliary: conditionSelection.resolved,
        manifest,
        bundleDir,
      });
      writeOut(`starting controlled-load measured=${selection.resolved.id} ` +
        `condition=${conditionSelection.resolved.id} target=${controlledExecution.targetCpu} ` +
        `workers=${compressCpuList(controlledExecution.workerCpus)} bundle=${bundleDir}\n`);
      writeOut(`measured warning: ${selection.metadata.liveWarning}\n`);
      writeOut(`condition warning: ${conditionSelection.metadata.liveWarning}\n`);
      return await runControlledLoadBundle({
        resolved: selection.resolved,
        auxiliary: conditionSelection.resolved,
        bundleDir,
        signalSource,
        writeOut,
        writeErr,
      });
    }
    if (parsed.command === "groups") {
      assertGroupCapabilities(selection);
      if (parsed.mode !== "dry-run") assertAutomationBoundary(selection);
      if (parsed.mode === "resume") {
        const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
        writeOut(`resuming groups workload=${selection.resolved.id} bundle=${bundleDir}\n`);
        writeOut(`warning: ${selection.metadata.liveWarning}\n`);
        return await runGroupBundle({
          resolved: selection.resolved,
          bundleDir,
          signalSource,
          writeOut,
          writeErr,
        });
      }
      const planPath = path.resolve(cwd, parsed.planFile);
      const plan = readGroupPlanFile(planPath);
      const tasksetPath = resolveExecutablePath(parsed.tasksetPath, "--taskset");
      const scheduledCpus = [...new Set([
        ...plan.groups.cpuUniverse,
        ...plan.exact.cpus,
      ])].sort((left, right) => left - right);
      const allowedCpuSpec = ensureAllowedCpus(scheduledCpus);
      const manifest = buildFreshGroupManifest(
        selection.resolved,
        plan,
        tasksetPath,
        parsed.mode === "dry-run",
      );
      const baselineAttempts = manifest.baseline.manifest.schedule.attemptCount;
      const groupSchedule = manifest.groups.manifest.schedule;
      const exactSchedule = manifest.exactCpu.manifest.schedule;
      if (parsed.mode === "dry-run") {
        writeOut(`${renderWorkload(selection)}\n`);
        writeOut(`plan file: ${planPath}\n`);
        writeOut(`bound baseline: ${plan.baseline.childrenPerWave} child(ren) x ` +
          `${plan.baseline.waves} wave(s); ${baselineAttempts} attempt(s)\n`);
        writeOut(`groups: ${groupSchedule.contextCount} context(s); ` +
          `${groupSchedule.waveCount} wave(s); ${groupSchedule.attemptCount} attempt(s); ` +
          `seed ${groupSchedule.seed}\n`);
        writeOut(`bound exact: CPUs ${compressCpuList(plan.exact.cpus)}; ` +
          `${exactSchedule.rounds} round(s); ${exactSchedule.attemptCount} attempt(s); ` +
          `seed ${exactSchedule.seed}\n`);
        writeOut(`host allowance: ${allowedCpuSpec}\n`);
        writeOut(`planned bundle: ${path.resolve(cwd, parsed.outDir)}\n`);
        writeOut("dry run: no workload executed and no bundle created\n");
        return 0;
      }
      const bundleDir = createPrivateBundleDirectory(path.resolve(cwd, parsed.outDir));
      await initializeSchema3Bundle({
        resolved: selection.resolved,
        manifest,
        bundleDir,
      });
      writeOut(`starting groups workload=${selection.resolved.id} ` +
        `risk=${selection.resolved.risk} contexts=${groupSchedule.contextCount} ` +
        `waves=${groupSchedule.waveCount} bundle=${bundleDir}\n`);
      writeOut(`warning: ${selection.metadata.liveWarning}\n`);
      return await runGroupBundle({
        resolved: selection.resolved,
        bundleDir,
        signalSource,
        writeOut,
        writeErr,
      });
    }
    if (parsed.command === "pinned") {
      assertPinnedCapabilities(selection);
      if (parsed.mode !== "dry-run") assertAutomationBoundary(selection);
      if (parsed.mode === "resume") {
        const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
        writeOut(`resuming pinned workload=${selection.resolved.id} bundle=${bundleDir}\n`);
        writeOut(`warning: ${selection.metadata.liveWarning}\n`);
        return await runPinnedBundle({
          selection,
          bundleDir,
          signalSource,
          writeOut,
          writeErr,
        });
      }
      const planPath = path.resolve(cwd, parsed.planFile);
      const plan = readPinnedPlanFile(planPath);
      const tasksetPath = resolveExecutablePath(parsed.tasksetPath, "--taskset");
      const scheduledCpus = [...new Set([
        ...plan.groups.cpuUniverse,
        ...plan.exact.cpus,
        ...plan.pinnedConcurrent.contexts.flatMap((context) => [
          ...context.cpus,
          context.controllerCpu,
        ]),
      ])].sort((left, right) => left - right);
      const allowedCpuSpec = ensureAllowedCpus(scheduledCpus);
      const manifest = buildFreshPinnedManifest(
        selection.resolved,
        plan,
        tasksetPath,
        parsed.mode === "dry-run",
      );
      const baselineAttempts = manifest.baseline.manifest.schedule.attemptCount;
      const groupSchedule = manifest.groups.manifest.schedule;
      const pinnedSchedule = manifest.pinnedConcurrent.manifest.schedule;
      const exactSchedule = manifest.exactCpu.manifest.schedule;
      if (parsed.mode === "dry-run") {
        writeOut(`${renderWorkload(selection)}\n`);
        writeOut(`plan file: ${planPath}\n`);
        writeOut(`bound baseline: ${plan.baseline.childrenPerWave} child(ren) x ` +
          `${plan.baseline.waves} wave(s); ${baselineAttempts} attempt(s)\n`);
        writeOut(`bound groups: ${groupSchedule.contextCount} context(s); ` +
          `${groupSchedule.waveCount} wave(s); ${groupSchedule.attemptCount} attempt(s); ` +
          `seed ${groupSchedule.seed}\n`);
        writeOut(`pinned-concurrent: ${pinnedSchedule.contextCount} context(s); ` +
          `${pinnedSchedule.waveCount} wave(s); ${pinnedSchedule.attemptCount} ` +
          `attempt(s); seed ${pinnedSchedule.seed}\n`);
        writeOut(`bound exact: CPUs ${compressCpuList(plan.exact.cpus)}; ` +
          `${exactSchedule.rounds} round(s); ${exactSchedule.attemptCount} attempt(s); ` +
          `seed ${exactSchedule.seed}\n`);
        writeOut(`host allowance: ${allowedCpuSpec}\n`);
        writeOut(`planned bundle: ${path.resolve(cwd, parsed.outDir)}\n`);
        writeOut("dry run: no workload executed and no bundle created\n");
        return 0;
      }
      const bundleDir = createPrivateBundleDirectory(path.resolve(cwd, parsed.outDir));
      await initializeSchema3Bundle({
        resolved: selection.resolved,
        manifest,
        bundleDir,
      });
      writeOut(`starting pinned workload=${selection.resolved.id} ` +
        `risk=${selection.resolved.risk} contexts=${pinnedSchedule.contextCount} ` +
        `waves=${pinnedSchedule.waveCount} bundle=${bundleDir}\n`);
      writeOut(`warning: ${selection.metadata.liveWarning}\n`);
      return await runPinnedBundle({
        selection,
        bundleDir,
        signalSource,
        writeOut,
        writeErr,
      });
    }
    assertExactCapability(selection);
    const conditionSelection = parsed.conditionWorkloadFile === undefined
      ? undefined
      : resolveConditionSelection(parsed, cwd);
    if (conditionSelection !== undefined) assertControlledLoadCondition(conditionSelection);
    if (parsed.mode !== "dry-run") assertAutomationBoundary(selection);
    if (parsed.mode !== "dry-run" && conditionSelection !== undefined) {
      assertAutomationBoundary(conditionSelection);
    }
    if (parsed.mode === "resume") {
      const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
      writeOut(`resuming workload=${selection.resolved.id} bundle=${bundleDir}\n`);
      writeOut(`warning: ${selection.metadata.liveWarning}\n`);
      return await runExactBundle({
        resolved: selection.resolved,
        auxiliary: conditionSelection?.resolved,
        bundleDir,
        signalSource,
        writeOut,
        writeErr,
      });
    }
    const tasksetPath = resolveExecutablePath(parsed.tasksetPath, "--taskset");
    const allowedCpuSpec = ensureAllowedCpus(parsed.cpus);
    const manifest = buildFreshManifest(
      selection.resolved,
      parsed,
      tasksetPath,
      parsed.mode === "dry-run",
    );
    const attemptCount = manifest.exactCpu.manifest.schedule.attemptCount;
    if (parsed.mode === "dry-run") {
      writeOut(`${renderWorkload(selection)}\n`);
      writeOut(`plan: exact CPUs ${parsed.cpuSpec}; ${parsed.rounds} round(s); ` +
        `${attemptCount} attempt(s); seed ${parsed.seed}\n`);
      writeOut(`host allowance: ${allowedCpuSpec}\n`);
      writeOut(`planned bundle: ${path.resolve(cwd, parsed.outDir)}\n`);
      writeOut("dry run: no workload executed and no bundle created\n");
      return 0;
    }
    const bundleDir = createPrivateBundleDirectory(path.resolve(cwd, parsed.outDir));
    await initializeSchema3Bundle({
      resolved: selection.resolved,
      manifest,
      bundleDir,
    });
    writeOut(`starting workload=${selection.resolved.id} risk=${selection.resolved.risk}` +
      ` attempts=${attemptCount} bundle=${bundleDir}\n`);
    writeOut(`warning: ${selection.metadata.liveWarning}\n`);
    return await runExactBundle({
      resolved: selection.resolved,
      bundleDir,
      signalSource,
      writeOut,
      writeErr,
    });
  } catch (error) {
    writeErr(`fault-affinity: ${error?.message ?? "unknown error"}\n`);
    return error?.code === "BUNDLE_EXECUTION_LEASE_BUSY" ? 75 : 2;
  }
}
