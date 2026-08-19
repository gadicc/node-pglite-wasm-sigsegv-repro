#!/usr/bin/env node

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
import { fileURLToPath } from "node:url";

import { readLinuxAllowedCpuList } from "./diagnose-lib/attempt-runner.mjs";
import { buildExactCpuPhaseManifest } from "./diagnose-lib/exact-cpu-phase.mjs";
import {
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  compressCpuList,
  expandCpuList,
} from "./diagnose-lib/pinned-runner.mjs";
import {
  buildSchema3BundleManifest,
  initializeSchema3Bundle,
  newSchema3BundleGeneration,
  readSchema3Bundle,
  runOneSchema3ExactCpuAttempt,
} from "./diagnose-lib/schema3-bundle.mjs";
import {
  listBuiltInWorkloads,
  resolveWorkloadSelection,
} from "./workloads/catalog.mjs";

const DEFAULT_TASKSET_PATH = "/usr/bin/taskset";
const ZERO_GENERATION = "0".repeat(32);
const MAX_PATH_BYTES = 16 * 1024;

const HELP = `Fault Affinity: bounded, resumable exact-CPU workload diagnostics

Usage:
  fault-affinity workloads [--json]
  fault-affinity inspect (--workload ID | --workload-file FILE) [--json]
  fault-affinity exact (--workload ID | --workload-file FILE) \\
    --cpus LIST [--rounds N] [--seed N] --out-dir DIR (--dry-run | --yes)
  fault-affinity exact --resume DIR (--workload ID | --workload-file FILE) --yes

The initial public command owns only exact-CPU schema-3 bundles. Listing,
inspection, and dry runs never execute a workload or create an evidence bundle.
Every live run requires an explicit workload selection and --yes.
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

function parseCanonicalCpuList(value) {
  let cpus;
  try {
    cpus = expandCpuList(value);
  } catch (error) {
    fail(`--cpus is invalid: ${error.message}`);
  }
  const ascending = [...cpus].sort((left, right) => left - right);
  if (ascending.some((cpu, index) => cpu !== cpus[index]) || compressCpuList(cpus) !== value) {
    fail("--cpus must be a canonical ascending CPU list such as 0-3,8");
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
        resumeDir: options.resumeDir });
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

function assertExactCapability(selection) {
  if (selection.resolved.capabilities.isolated !== true) {
    fail(`workload '${selection.resolved.id}' does not declare exact-CPU capability`);
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

async function runExactBundle({ resolved, bundleDir, signalSource, writeOut, writeErr }) {
  const forwarding = installSignalForwarding(signalSource);
  try {
    let bundle = await readSchema3Bundle({ resolved, bundleDir });
    while (!bundle.exactCpu.progress.complete) {
      if (forwarding.signal.aborted) return signalExitCode(forwarding.received());
      const { nextSlot, committedAttempts, totalAttempts } = bundle.exactCpu.progress;
      writeOut(`attempt ${committedAttempts + 1}/${totalAttempts} cpu=${nextSlot.cpu}\n`);
      const execution = await runOneSchema3ExactCpuAttempt({
        resolved,
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
    assertExactCapability(selection);
    if (parsed.mode !== "dry-run") assertAutomationBoundary(selection);
    if (parsed.mode === "resume") {
      const bundleDir = resolveExistingBundleDirectory(path.resolve(cwd, parsed.resumeDir));
      writeOut(`resuming workload=${selection.resolved.id} bundle=${bundleDir}\n`);
      writeOut(`warning: ${selection.metadata.liveWarning}\n`);
      return await runExactBundle({
        resolved: selection.resolved,
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

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runFaultAffinityCli(process.argv.slice(2));
}
