#!/usr/bin/env node
// Controlled external-load experiments for the CPU-localized PGlite SIGSEGV.
// The target remains one sequential child pinned to one CPU. Three modes share
// the same verified induced load (one worker per load CPU):
//   load-state: A1(no induced load) -> B(induced load) -> A2(recovered)
//   gdb:        bounded GDB capture under one constant induced load
//   node-aba:   A1(Node A) -> B(Node B) -> A2(Node A) under one constant load

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  accessSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTelemetryRecorder,
  parseCpuList,
} from "./diagnose-lib/telemetry-sampler.mjs";
import {
  buildGdbManifestCandidate,
  GDB_MAX_CAPTURES_LIMIT,
  GDB_MAX_RUNS_LIMIT,
  newGdbGeneration,
  validateGdbEvidence,
} from "./diagnose-lib/gdb-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.dirname(SCRIPT_PATH);
const CHILD = path.join(REPO, "child.mjs");
const LAUNCHER = path.join(REPO, "diagnose-lib", "run-pinned-child.sh");
const CAPTURE_SCRIPT = path.join(REPO, "capture-fault.sh");
const GDB_HELPER = path.join(REPO, "diagnose-lib", "gdb-attempt-io.mjs");
const GDB_EVIDENCE = path.join(REPO, "diagnose-lib", "gdb-evidence.mjs");
const LOAD_PROGRAM = "/usr/bin/yes";
const NO_TURBO = "/sys/devices/system/cpu/intel_pstate/no_turbo";
const MAX_STDERR = 16 * 1024;
const CONTROLLER_ENV = "PGLITE_LOAD_ABA_CONTROLLER";
const OUTPUT_ENV = "PGLITE_LOAD_ABA_OUT_DIR";
const ALLOWED_ENV = "PGLITE_LOAD_ABA_ALLOWED_CPUS";

const MODES = ["load-state", "gdb", "node-aba"];

const PHASES = [
  ["A1", "no induced load"],
  ["B", "induced load"],
  ["A2", "no induced load after recovery"],
];

const NODE_ABA_PHASES = [
  ["A1", "Node A under the constant induced load"],
  ["B", "Node B under the constant induced load"],
  ["A2", "Node A again under the same constant induced load"],
];

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(`usage: node load-state-aba.mjs [options]

Controlled-load experiments for the CPU-localized PGlite SIGSEGV. The induced
load is one /usr/bin/yes worker per load CPU, each individually pinned through
taskset and verified through /proc. The script never changes firmware,
frequency, affinity of unrelated processes, or any sysfs setting.

Modes:
  --mode load-state       A1(no induced load) -> B(induced load) -> A2
                          (recovered), one Node executable throughout (default)
  --mode gdb              bounded GDB capture under one constant induced load
  --mode node-aba         A1(Node A) -> B(Node B) -> A2(Node A) under one
                          constant induced load that never stops between legs

Options:
  --target-cpu N          target logical CPU (default: 19)
  --load-cpus LIST        induced-load CPUs (default: 0-7)
  --controller-cpu N|auto controller CPU, outside target/load sets (default: auto)
  --runs N                child runs per leg (default: 20; load-state/node-aba)
  --node-bin PATH         exact Node binary for child.mjs (default: this Node);
                          the Node A default in node-aba, the debug target in gdb
  --node-a PATH           exact Node A executable (only --mode node-aba)
  --node-b PATH           exact Node B executable (required by --mode node-aba)
  --gdb-max-runs N        bounded GDB attempts, 1-${GDB_MAX_RUNS_LIMIT} (default: 10; only --mode gdb)
  --gdb-max-captures N    stop after this many captures, 1-${GDB_MAX_CAPTURES_LIMIT} (default: 1; only --mode gdb)
  --settle-seconds N      settling before the first phase (default: 15)
  --load-warmup-seconds N delay after verified load starts (default: 0 for
                          load-state, 5 for gdb and node-aba)
  --interval-ms N         telemetry interval, 50-60000 (default: 100)
  --out-dir DIR           new output directory (default: diagnostics/load-*)
  --yes                   run the live workload
  --dry-run               print the resolved plan only (the default)

Examples:
  node load-state-aba.mjs
  node load-state-aba.mjs --yes
  node load-state-aba.mjs --load-cpus 16-18 --runs 30 --yes
  node load-state-aba.mjs --mode gdb \\
    --node-bin /home/dragon/.nvm/versions/node/v25.2.1/bin/node --yes
  node load-state-aba.mjs --mode node-aba \\
    --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \\
    --node-b /usr/bin/node --yes`);
  return message ? 2 : 0;
}

function canonicalInteger(value, label, min, max) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) {
    throw new Error(`${label} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be from ${min} to ${max}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    controller: "auto",
    dryRun: false,
    gdbMaxCaptures: 1,
    gdbMaxRuns: 10,
    help: false,
    intervalMs: 100,
    loadCpuSpec: "0-7",
    loadWarmupSeconds: 0,
    mode: "load-state",
    nodeA: null,
    nodeB: null,
    nodeBin: process.execPath,
    outDir: null,
    runs: 20,
    settleSeconds: 15,
    targetCpu: 19,
    yes: false,
  };
  const seen = new Set();
  const valueOptions = new Set([
    "--mode",
    "--target-cpu",
    "--load-cpus",
    "--controller-cpu",
    "--runs",
    "--node-bin",
    "--node-a",
    "--node-b",
    "--gdb-max-runs",
    "--gdb-max-captures",
    "--settle-seconds",
    "--load-warmup-seconds",
    "--interval-ms",
    "--out-dir",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valueOptions.has(arg)) {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[++index];
      seen.add(arg);
      if (arg === "--mode") {
        if (!MODES.includes(value)) {
          throw new Error(`--mode must be one of ${MODES.join(", ")}`);
        }
        options.mode = value;
      } else if (arg === "--target-cpu") {
        options.targetCpu = canonicalInteger(value, arg, 0, 65_535);
      } else if (arg === "--load-cpus") {
        options.loadCpuSpec = value;
      } else if (arg === "--controller-cpu") {
        options.controller = value === "auto"
          ? value
          : canonicalInteger(value, arg, 0, 65_535);
      } else if (arg === "--runs") {
        options.runs = canonicalInteger(value, arg, 1, 100_000);
      } else if (arg === "--node-bin") {
        options.nodeBin = path.resolve(value);
      } else if (arg === "--node-a") {
        options.nodeA = path.resolve(value);
      } else if (arg === "--node-b") {
        options.nodeB = path.resolve(value);
      } else if (arg === "--gdb-max-runs") {
        options.gdbMaxRuns = canonicalInteger(value, arg, 1, GDB_MAX_RUNS_LIMIT);
      } else if (arg === "--gdb-max-captures") {
        options.gdbMaxCaptures = canonicalInteger(value, arg, 1, GDB_MAX_CAPTURES_LIMIT);
      } else if (arg === "--settle-seconds") {
        options.settleSeconds = canonicalInteger(value, arg, 0, 3600);
      } else if (arg === "--load-warmup-seconds") {
        options.loadWarmupSeconds = canonicalInteger(value, arg, 0, 3600);
      } else if (arg === "--interval-ms") {
        options.intervalMs = canonicalInteger(value, arg, 50, 60_000);
      } else {
        options.outDir = path.resolve(value);
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.yes && options.dryRun) {
    throw new Error("choose --yes or --dry-run, not both");
  }
  if (options.mode !== "gdb") {
    for (const arg of ["--gdb-max-runs", "--gdb-max-captures"]) {
      if (seen.has(arg)) throw new Error(`${arg} is only valid with --mode gdb`);
    }
  }
  if (options.mode !== "node-aba") {
    for (const arg of ["--node-a", "--node-b"]) {
      if (seen.has(arg)) throw new Error(`${arg} is only valid with --mode node-aba`);
    }
  }
  if (options.mode === "gdb" && seen.has("--runs")) {
    throw new Error("--runs is only valid with --mode load-state or --mode node-aba");
  }
  if (options.mode === "node-aba") {
    if (!seen.has("--node-b")) {
      throw new Error("--mode node-aba requires --node-b PATH");
    }
    // --node-bin remains supported as the Node A/default executable.
    options.nodeA ??= options.nodeBin;
  }
  if (!seen.has("--load-warmup-seconds") && options.mode !== "load-state") {
    options.loadWarmupSeconds = 5;
  }
  options.loadCpus = parseCpuList(options.loadCpuSpec);
  if (options.loadCpus.includes(options.targetCpu)) {
    throw new Error(`target CPU ${options.targetCpu} must not be in --load-cpus`);
  }
  return options;
}

function allowedCpus() {
  const text = readFileSync("/proc/self/status", "utf8");
  const match = text.match(/^Cpus_allowed_list:\s*(\S+)$/m);
  if (!match) throw new Error("cannot read Cpus_allowed_list from /proc/self/status");
  return parseCpuList(match[1]);
}

export function chooseController(requested, targetCpu, loadCpus, allowed) {
  const excluded = new Set([targetCpu, ...loadCpus]);
  const controller = requested === "auto"
    ? allowed.find((cpu) => !excluded.has(cpu))
    : requested;
  if (controller === undefined) {
    throw new Error("no allowed controller CPU exists outside target/load sets");
  }
  if (!allowed.includes(controller)) {
    throw new Error(`controller CPU ${controller} is not allowed to this process`);
  }
  if (excluded.has(controller)) {
    throw new Error(`controller CPU ${controller} must be outside target/load sets`);
  }
  return controller;
}

// The experiment as a data-only step list, so the exact ordering — including
// the single load start/stop bracketing every node-aba leg — is testable
// without a live machine. Explicit load-verify steps bind worker identity and
// affinity to both sides of each measured leg/capture.
export function buildPhasePlan(options) {
  if (options.mode === "gdb") {
    return [
      { type: "settle", seconds: options.settleSeconds, before: "the induced load starts" },
      { type: "load-start" },
      { type: "load-warmup", seconds: options.loadWarmupSeconds },
      { type: "load-verify", boundary: "before GDB capture" },
      { type: "gdb", description: "bounded GDB capture under the constant induced load" },
      { type: "load-verify", boundary: "after GDB capture" },
      { type: "load-stop" },
    ];
  }
  if (options.mode === "node-aba") {
    return [
      { type: "settle", seconds: options.settleSeconds, before: "the induced load starts" },
      { type: "load-start" },
      { type: "load-warmup", seconds: options.loadWarmupSeconds },
      { type: "load-verify", boundary: "before A1" },
      { type: "leg", phase: "A1", description: NODE_ABA_PHASES[0][1], nodeLabel: "A" },
      { type: "load-verify", boundary: "after A1" },
      { type: "leg", phase: "B", description: NODE_ABA_PHASES[1][1], nodeLabel: "B" },
      { type: "load-verify", boundary: "after B" },
      { type: "leg", phase: "A2", description: NODE_ABA_PHASES[2][1], nodeLabel: "A" },
      { type: "load-verify", boundary: "after A2" },
      { type: "load-stop" },
    ];
  }
  return [
    { type: "settle", seconds: options.settleSeconds, before: "A1" },
    { type: "leg", phase: "A1", description: "no induced load", nodeLabel: "target" },
    { type: "load-start" },
    { type: "load-warmup", seconds: options.loadWarmupSeconds },
    { type: "load-verify", boundary: "before B" },
    { type: "leg", phase: "B", description: "induced load", nodeLabel: "target" },
    { type: "load-verify", boundary: "after B" },
    { type: "load-stop" },
    { type: "settle", seconds: options.settleSeconds, before: "A2" },
    { type: "leg", phase: "A2", description: "no induced load after recovery", nodeLabel: "target" },
  ];
}

// Walk a phase plan through caller-supplied hooks. Nothing here spawns or
// stops anything by itself; the hooks own all side effects, which keeps this
// sequencing directly testable with fakes.
export async function executePhasePlan(
  plan,
  hooks,
  result = { rows: [], gdbResult: null },
) {
  for (const step of plan) {
    if (hooks.isInterrupted?.() === true) break;
    if (step.type === "settle") await hooks.settle(step);
    else if (step.type === "load-start") await hooks.startLoad();
    else if (step.type === "load-warmup") await hooks.warmup(step);
    else if (step.type === "load-verify") await hooks.verifyLoad(step);
    else if (step.type === "leg") result.rows.push(...await hooks.runLeg(step));
    else if (step.type === "gdb") result.gdbResult = await hooks.gdbCapture(step);
    else if (step.type === "load-stop") await hooks.stopLoad();
    else throw new Error(`unknown phase-plan step: ${step.type}`);
  }
  return result;
}

function defaultOutDir(mode) {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const prefix = mode === "gdb" ? "load-gdb" : mode === "node-aba" ? "node-aba" : "load-aba";
  return path.join(REPO, "diagnostics", `${prefix}-${stamp}`);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "unavailable";
  }
}

function cpuTopology(cpu) {
  const root = `/sys/devices/system/cpu/cpu${cpu}`;
  return {
    cpu,
    core: readText(`${root}/topology/core_id`),
    cluster: readText(`${root}/topology/cluster_id`),
    die: readText(`${root}/topology/die_id`),
    package: readText(`${root}/topology/physical_package_id`),
    scalingDriver: readText(`${root}/cpufreq/scaling_driver`),
    scalingGovernor: readText(`${root}/cpufreq/scaling_governor`),
    energyPreference: readText(`${root}/cpufreq/energy_performance_preference`),
    scalingMinKHz: readText(`${root}/cpufreq/scaling_min_freq`),
    scalingMaxKHz: readText(`${root}/cpufreq/scaling_max_freq`),
  };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function inspectNode(nodeBin) {
  if (realpathSync(nodeBin) === realpathSync(process.execPath)) {
    return Promise.resolve({
      execPath: process.execPath,
      node: process.version,
      v8: process.versions.v8,
      modules: process.versions.modules,
    });
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(nodeBin, [
      "-p",
      "JSON.stringify({execPath:process.execPath,node:process.version,v8:process.versions.v8,modules:process.versions.modules})",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal !== null) {
        reject(new Error(
          `target Node inspection failed: code=${exitCode} signal=${signal} ${stderr.trim()}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("target Node inspection returned malformed JSON"));
      }
    });
  });
}

function microcodeVersion() {
  const text = readText("/proc/cpuinfo");
  const match = text.match(/^microcode\s*:\s*(\S+)/m);
  return match?.[1] ?? "unavailable";
}

function appendJsonLine(file, value) {
  appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

function now(recorder) {
  return {
    unixMs: Date.now(),
    monotonicNs: process.hrtime.bigint().toString(),
    telemetry: recorder?.timestamp() ?? null,
  };
}

function delay(milliseconds, isInterrupted = () => false) {
  if (milliseconds <= 0 || isInterrupted()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const poll = setInterval(() => {
      if (isInterrupted()) finish();
    }, Math.min(250, milliseconds));
  });
}

function processAffinity(pid) {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = text.match(/^Cpus_allowed_list:\s*(\S+)$/m);
  if (!match) throw new Error(`cannot read affinity for PID ${pid}`);
  return match[1];
}

function processExe(pid) {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "unavailable";
  }
}

function killGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const activeGroups = new Map();
let interruptedBy = null;

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (interruptedBy === null) interruptedBy = signal;
      for (const pid of activeGroups.keys()) killGroup(pid, "SIGTERM");
    });
  }
}

// The first process exists only to re-exec the harness on the controller CPU.
// Forward targeted signals to that controller so its installed handler can
// stop and reap every process group before this wrapper returns.
export function superviseController(child, signalSource = process) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") finish(reject, error);
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const onError = (error) => finish(reject, error);
    const onClose = (exitCode, signal) => {
      const status = signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : signal === null
            ? (exitCode ?? 125)
            : 125;
      finish(resolve, status);
    };
    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function trackProcess(child, kind) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error(`failed to obtain ${kind} PID`);
  }
  const closed = new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      activeGroups.delete(child.pid);
      resolve({ exitCode, signal });
    });
  });
  activeGroups.set(child.pid, { child, closed, kind });
  return closed;
}

function inspectLoadWorker(worker) {
  const exitCode = worker.closeResult?.exitCode ?? worker.child.exitCode;
  const signal = worker.closeResult?.signal ?? worker.child.signalCode;
  if (worker.closeResult !== undefined || exitCode !== null || signal !== null) {
    return {
      alive: false,
      exitCode,
      signal,
      affinity: null,
      executable: null,
      detail: `exited with code=${exitCode} signal=${signal}`,
    };
  }
  try {
    return {
      alive: true,
      exitCode: null,
      signal: null,
      affinity: processAffinity(worker.child.pid),
      executable: processExe(worker.child.pid),
      detail: null,
    };
  } catch (error) {
    return {
      alive: false,
      exitCode,
      signal,
      affinity: null,
      executable: null,
      detail: `cannot inspect PID ${worker.child.pid}: ${error.message}`,
    };
  }
}

function loadWorkerProblem(worker, snapshot) {
  if (!snapshot.alive) return snapshot.detail ?? "is not running";
  if (snapshot.affinity !== String(worker.cpu)) {
    return `affinity is ${snapshot.affinity}, expected ${worker.cpu}`;
  }
  if (snapshot.executable !== worker.expectedExecutable) {
    return `executable is ${snapshot.executable}, expected ${worker.expectedExecutable}`;
  }
  return null;
}

// Bind every measured phase/capture to the original worker PIDs, executable,
// and one-CPU affinities. Tests can provide an inspection function so this
// behavior is exercised without starting the live workload.
export function verifyLoadWorkers(
  workers,
  boundary,
  eventsPath,
  recorder,
  inspect = inspectLoadWorker,
) {
  const snapshots = workers.map((worker) => ({
    cpu: worker.cpu,
    pid: worker.child.pid,
    ...inspect(worker),
  }));
  const failedIndex = snapshots.findIndex((snapshot, index) => (
    loadWorkerProblem(workers[index], snapshot) !== null
  ));
  if (failedIndex !== -1) {
    const problem = loadWorkerProblem(workers[failedIndex], snapshots[failedIndex]);
    appendJsonLine(eventsPath, {
      type: "load_workers_check_failed",
      boundary,
      problem: `load worker CPU ${workers[failedIndex].cpu} ${problem}`,
      workers: snapshots,
      ...now(recorder),
    });
    throw new Error(`load worker check failed at ${boundary}: CPU ${workers[failedIndex].cpu} ${problem}`);
  }
  appendJsonLine(eventsPath, {
    type: "load_workers_verified",
    boundary,
    workers: snapshots,
    ...now(recorder),
  });
  return snapshots;
}

async function startLoadWorkers(cpus, eventsPath, recorder) {
  const workers = [];
  try {
    const expectedExecutable = realpathSync(LOAD_PROGRAM);
    for (const cpu of cpus) {
      const child = spawn("/usr/bin/taskset", [
        "-c",
        String(cpu),
        LOAD_PROGRAM,
      ], {
        detached: true,
        stdio: "ignore",
      });
      const closed = trackProcess(child, `load worker CPU ${cpu}`);
      const worker = {
        child,
        closed,
        closeResult: undefined,
        cpu,
        expectedExecutable,
      };
      closed.then((result) => { worker.closeResult = result; });
      workers.push(worker);
    }
    await delay(250, () => interruptedBy !== null);
    if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
    for (const worker of workers) {
      const snapshot = inspectLoadWorker(worker);
      const problem = loadWorkerProblem(worker, snapshot);
      if (problem !== null) throw new Error(`load worker on CPU ${worker.cpu} ${problem}`);
      appendJsonLine(eventsPath, {
        type: "load_worker_started",
        cpu: worker.cpu,
        pid: worker.child.pid,
        affinity: snapshot.affinity,
        executable: snapshot.executable,
        ...now(recorder),
      });
    }
    return workers;
  } catch (error) {
    await stopLoadWorkers(workers, eventsPath, recorder);
    throw error;
  }
}

async function stopLoadWorkers(workers, eventsPath, recorder) {
  for (const worker of workers) killGroup(worker.child.pid, "SIGTERM");
  await Promise.race([
    Promise.all(workers.map((worker) => worker.closed)),
    delay(1000),
  ]);
  for (const worker of workers) {
    if (activeGroups.has(worker.child.pid)) killGroup(worker.child.pid, "SIGKILL");
  }
  await Promise.race([
    Promise.all(workers.map((worker) => worker.closed)),
    delay(1000),
  ]);
  const remaining = workers.filter((worker) => activeGroups.has(worker.child.pid));
  if (remaining.length > 0) {
    throw new Error(
      `load worker groups did not stop: ${remaining.map((worker) => worker.child.pid).join(",")}`,
    );
  }
  appendJsonLine(eventsPath, {
    type: "load_workers_stopped",
    count: workers.length,
    workers: workers.map((worker) => ({
      cpu: worker.cpu,
      pid: worker.child.pid,
      exitCode: worker.closeResult?.exitCode ?? worker.child.exitCode,
      signal: worker.closeResult?.signal ?? worker.child.signalCode,
    })),
    ...now(recorder),
  });
}

function gdbVersion() {
  const result = spawnSync("gdb", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error("gdb is required for --mode gdb but could not be executed");
  }
  return (result.stdout.split("\n")[0] ?? "").trim() || "unavailable";
}

function probeGdbVersion() {
  try {
    return gdbVersion();
  } catch {
    return null;
  }
}

// Read the terminal COUNTS record of a capture-fault.sh runner log. This is a
// light pre-parse for metadata publication only; the GDB evidence envelope
// (buildGdbManifestCandidate/validateGdbEvidence) remains the authority on
// record grammar, contiguity, and transcript binding.
function parseRunnerCounts(runnerLogPath, generation) {
  const lines = readFileSync(runnerLogPath, "utf8").trimEnd().split("\n");
  const fields = (lines.at(-1) ?? "").split("\t");
  if (fields.length !== 19 || fields[0] !== "COUNTS" || fields[2] !== generation) {
    throw new Error("GDB runner log is missing its terminal COUNTS record");
  }
  return {
    maxRuns: Number(fields[6]),
    maxCaptures: Number(fields[8]),
    attempted: Number(fields[10]),
    clean: Number(fields[12]),
    captured: Number(fields[14]),
    errors: Number(fields[16]),
    exitCode: Number(fields[18]),
  };
}

// Run one bounded GDB capture while the induced load is already active, then
// publish the generation-bound evidence envelope inside the output bundle.
// capture-fault.sh exit code 3 (no fault within the run limit) is a valid
// experimental result here, exactly like a capture; every other non-zero
// status is an operational failure. The fifth parameter exists so tests can
// substitute a fake runner; production always uses capture-fault.sh.
export async function runGdbCapture(
  options,
  outDir,
  eventsPath,
  recorder,
  captureScript = CAPTURE_SCRIPT,
) {
  const gdbDir = path.join(outDir, "gdb");
  const logsGdbDir = path.join(outDir, "logs", "gdb");
  const resultsDir = path.join(outDir, "results");
  const stateDir = path.join(outDir, "state");
  for (const directory of [gdbDir, logsGdbDir, resultsDir, stateDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const generation = newGdbGeneration();
  const runnerLogPath = path.join(logsGdbDir, "runner.log");
  appendJsonLine(eventsPath, {
    type: "gdb_capture_started",
    generation,
    targetCpu: options.targetCpu,
    maxRuns: options.gdbMaxRuns,
    maxCaptures: options.gdbMaxCaptures,
    nodeBin: options.nodeBin,
    ...now(recorder),
  });
  const runnerFd = openSync(
    runnerLogPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  try {
    await new Promise((resolve) => {
      const child = spawn("/bin/bash", [
        captureScript,
        String(options.targetCpu),
        String(options.gdbMaxRuns),
        String(options.gdbMaxCaptures),
        gdbDir,
        generation,
        options.nodeBin,
      ], {
        cwd: REPO,
        detached: true,
        stdio: ["ignore", runnerFd, "inherit"],
      });
      const closed = trackProcess(child, "gdb capture");
      child.once("error", (error) => { spawnError = error; });
      closed.then((result) => {
        exitCode = result.exitCode;
        signal = result.signal;
        resolve();
      });
    });
  } finally {
    closeSync(runnerFd);
  }
  if (spawnError) {
    throw new Error(`cannot start the GDB capture runner: ${spawnError.message}`);
  }
  if (interruptedBy !== null) {
    return { generation, interrupted: true, exitCode, signal };
  }
  if (signal !== null) {
    throw new Error(`GDB capture runner was killed by ${signal}`);
  }
  if (exitCode !== 0 && exitCode !== 3) {
    throw new Error(`GDB capture runner failed operationally with exit code ${exitCode}`);
  }
  const counts = parseRunnerCounts(runnerLogPath, generation);
  if (counts.exitCode !== exitCode) {
    throw new Error(
      `GDB capture runner exit status ${exitCode} conflicts with terminal accounting ${counts.exitCode}`,
    );
  }
  writeFileSync(
    path.join(resultsDir, "gdb.meta"),
    `CPU=${options.targetCpu}\nMAX_RUNS=${options.gdbMaxRuns}\n` +
      `EXIT_CODE=${counts.exitCode}\nATTEMPTED_RUNS=${counts.attempted}\n` +
      `CLEAN_RUNS=${counts.clean}\nCAPTURED_RUNS=${counts.captured}\n` +
      `ERROR_RUNS=${counts.errors}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const candidatePath = path.join(resultsDir, `.gdb.manifest.${generation}`);
  const built = buildGdbManifestCandidate(outDir, candidatePath, {
    generation,
    expectedCpu: options.targetCpu,
    expectedMaxRuns: options.gdbMaxRuns,
    expectedMaxCaptures: options.gdbMaxCaptures,
  });
  if (!built.ok) throw new Error(`GDB evidence build failed: ${built.reasons[0]}`);
  renameSync(candidatePath, path.join(resultsDir, "gdb.manifest"));
  writeFileSync(path.join(stateDir, "phase-gdb.done"), "", { flag: "wx", mode: 0o600 });
  const attempts = [];
  const validated = validateGdbEvidence(outDir, {
    markerMode: "complete",
    expectedCpu: options.targetCpu,
    expectedMaxRuns: options.gdbMaxRuns,
    expectedMaxCaptures: options.gdbMaxCaptures,
    collectAttempts: attempts,
  });
  if (!validated.ok) {
    throw new Error(`GDB evidence validation failed: ${validated.reasons[0]}`);
  }
  const result = {
    generation,
    interrupted: false,
    outcome: validated.outcome,
    probe: validated.probe,
    ...counts,
    transcripts: attempts
      .filter((attempt) => attempt.relative !== "-")
      .map((attempt) => ({
        run: attempt.id,
        outcome: attempt.outcome,
        path: attempt.relative,
        bytes: attempt.bytes,
        sha256: attempt.sha256,
      })),
  };
  appendJsonLine(eventsPath, {
    type: "gdb_capture_finished",
    generation,
    outcome: result.outcome,
    exitCode: counts.exitCode,
    attempted: counts.attempted,
    clean: counts.clean,
    captured: counts.captured,
    errors: counts.errors,
    ...now(recorder),
  });
  console.log(
    `gdb outcome=${result.outcome} attempted=${counts.attempted} ` +
      `clean=${counts.clean} captured=${counts.captured} ` +
      `errors=${counts.errors} exitCode=${counts.exitCode}`,
  );
  return result;
}

function runPinnedChild(options, phase, run, nodeBin, nodeLabel) {
  return new Promise((resolve) => {
    const startedUnixMs = Date.now();
    const startedMonotonicNs = process.hrtime.bigint();
    let stderr = "";
    let launchError = null;
    const child = spawn("/bin/bash", [
      LAUNCHER,
      String(options.targetCpu),
      nodeBin,
      CHILD,
    ], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = trackProcess(child, `target child ${phase}/${run}`);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) {
        stderr += chunk.slice(0, MAX_STDERR - stderr.length);
      }
    });
    child.once("error", (error) => { launchError = error.message; });
    closed.then(({ exitCode, signal }) => {
      let outcome = "pass";
      if (interruptedBy !== null) outcome = "interrupted";
      else if (signal === "SIGSEGV" || exitCode === 139) outcome = "sigsegv";
      else if (signal !== null || exitCode !== 0 || launchError !== null) {
        outcome = "other_failure";
      }
      resolve({
        type: "child_result",
        phase,
        run,
        targetCpu: options.targetCpu,
        nodePath: nodeBin,
        ...(nodeLabel ? { nodeLabel } : {}),
        outcome,
        exitCode,
        signal,
        launchError,
        stderr: stderr.trim(),
        startedUnixMs,
        endedUnixMs: Date.now(),
        startedMonotonicNs: startedMonotonicNs.toString(),
        endedMonotonicNs: process.hrtime.bigint().toString(),
        elapsedMs: Math.round(Number(process.hrtime.bigint() - startedMonotonicNs) / 1e6),
      });
    });
  });
}

export async function runLeg(
  options,
  phase,
  description,
  nodeBin,
  nodeLabel,
  resultsPath,
  eventsPath,
  recorder,
  runChild = runPinnedChild,
) {
  appendJsonLine(eventsPath, {
    type: "phase_started",
    phase,
    description,
    nodePath: nodeBin,
    ...(nodeLabel ? { nodeLabel } : {}),
    ...now(recorder),
  });
  const rows = [];
  for (let run = 1; run <= options.runs && interruptedBy === null; run += 1) {
    const row = await runChild(options, phase, run, nodeBin, nodeLabel);
    rows.push(row);
    appendJsonLine(resultsPath, row);
    const label = nodeLabel ? ` node=${nodeLabel}` : "";
    console.log(
      `phase=${phase} run=${run}/${options.runs}${label} outcome=${row.outcome} elapsedMs=${row.elapsedMs}`,
    );
  }
  appendJsonLine(eventsPath, {
    type: "phase_ended",
    phase,
    description,
    completedRuns: rows.length,
    nodePath: nodeBin,
    ...(nodeLabel ? { nodeLabel } : {}),
    ...now(recorder),
  });
  return rows;
}

export function summarize(rows, phases = PHASES) {
  return phases.map(([phase, description]) => {
    const selected = rows.filter((row) => row.phase === phase);
    return {
      phase,
      description,
      attempted: selected.length,
      pass: selected.filter((row) => row.outcome === "pass").length,
      sigsegv: selected.filter((row) => row.outcome === "sigsegv").length,
      otherFailure: selected.filter((row) => row.outcome === "other_failure").length,
      interrupted: selected.filter((row) => row.outcome === "interrupted").length,
    };
  });
}

function phasesForMode(mode) {
  return mode === "node-aba" ? NODE_ABA_PHASES : PHASES;
}

function percent(count, total) {
  return total > 0 ? `${count}/${total} (${(100 * count / total).toFixed(1)}%)` : "0/0";
}

function machineLines(metadata) {
  return [
    `- BIOS: ${metadata.machine.biosVersion} (${metadata.machine.biosDate})`,
    `- Kernel: ${metadata.machine.kernel}`,
    `- intel_pstate/no_turbo: ${metadata.machine.noTurboStart} at start; ${metadata.machine.noTurboEnd} at end`,
  ];
}

function telemetryNoteLines() {
  return [
    "`scaling_cur_freq` in `telemetry.ndjson` is a point-in-time kernel value,",
    "not an effective-frequency measurement. Temperature availability depends",
    "on exposed `coretemp` hwmon sensors.",
  ];
}

function renderLoadStateReport(metadata, rows) {
  const summary = summarize(rows, phasesForMode(metadata.config.mode));
  const lines = [
    "# External-load A/B/A",
    "",
    `- Status: ${metadata.status}`,
    `- Mode: ${metadata.config.mode}`,
    `- Target: CPU ${metadata.config.targetCpu}`,
    `- Load CPUs: ${metadata.config.loadCpus.join(", ")}`,
    `- Controller: CPU ${metadata.config.controllerCpu}`,
    `- Runs per leg: ${metadata.config.runs}`,
    `- Target Node: ${metadata.node.node}; V8 ${metadata.node.v8}`,
    `- Target executable: \`${metadata.node.path}\``,
    `- Target executable SHA-256: \`${metadata.node.sha256}\``,
    ...machineLines(metadata),
    "",
    "| Leg | Controlled condition | Attempted | Passed | SIGSEGV | Other | Interrupted |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of summary) {
    lines.push(
      `| ${item.phase} | ${item.description} | ${item.attempted} | ${item.pass} | ${percent(item.sigsegv, item.attempted)} | ${item.otherFailure} | ${item.interrupted} |`,
    );
  }
  lines.push("", "## Interpretation boundary", "");
  if (metadata.status === "complete") {
    lines.push(
      "The script controls only its own induced workers. A1 and A2 mean *no",
      "script-induced load*, not proof that the rest of the machine was idle.",
      "Workers in B were individually pinned away from the target CPU and their",
      "identities and affinities were rechecked around the measured B leg. The",
      "sequential A/B/A order can still be affected by temperature, time, and",
      "carryover; repeat the complete experiment rather than pooling arbitrary",
      "legs from different sessions.",
      "",
    );
  } else {
    lines.push(
      "This experiment did not complete all load-worker checks. Retained rows",
      "are descriptive partial output only and must not be used as an A/B/A",
      "comparison. See `metadata.json` and `events.jsonl` for the stopping point.",
      "",
    );
  }
  lines.push(
    ...telemetryNoteLines(),
    "",
    "## Files",
    "",
    "- `metadata.json`: configuration, platform, topology, and binary identity",
    "- `results.jsonl`: one exact child outcome per row",
    "- `events.jsonl`: phase and verified load-worker boundaries",
    "- `telemetry.ndjson`: read-only frequency/temperature/no_turbo samples",
    "",
  );
  return lines.join("\n");
}

function renderNodeAbaReport(metadata, rows) {
  const summary = summarize(rows, phasesForMode(metadata.config.mode));
  const nodeOf = (phase) => phase === "B" ? metadata.nodes.B : metadata.nodes.A;
  const lines = [
    "# Node executable A/B/A under constant external load",
    "",
    `- Status: ${metadata.status}`,
    `- Mode: ${metadata.config.mode}`,
    `- Target: CPU ${metadata.config.targetCpu}`,
    `- Load CPUs: ${metadata.config.loadCpus.join(", ")}`,
    `- Controller: CPU ${metadata.config.controllerCpu}`,
    `- Runs per leg: ${metadata.config.runs}`,
    `- Load warmup: ${metadata.config.loadWarmupSeconds}s after verified load start`,
    `- Node A: ${metadata.nodes.A.node}; V8 ${metadata.nodes.A.v8}; modules ${metadata.nodes.A.modules}`,
    `- Node A executable: \`${metadata.nodes.A.path}\``,
    `- Node A executable SHA-256: \`${metadata.nodes.A.sha256}\``,
    `- Node B: ${metadata.nodes.B.node}; V8 ${metadata.nodes.B.v8}; modules ${metadata.nodes.B.modules}`,
    `- Node B executable: \`${metadata.nodes.B.path}\``,
    `- Node B executable SHA-256: \`${metadata.nodes.B.sha256}\``,
    ...machineLines(metadata),
    "",
    "| Leg | Node | Controlled condition | Attempted | Passed | SIGSEGV | Other | Interrupted |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of summary) {
    const node = nodeOf(item.phase);
    lines.push(
      `| ${item.phase} | ${node.node} | ${item.description} | ${item.attempted} | ${item.pass} | ${percent(item.sigsegv, item.attempted)} | ${item.otherFailure} | ${item.interrupted} |`,
    );
  }
  lines.push("", "## Interpretation boundary", "");
  if (metadata.status === "complete") {
    lines.push(
      "The induced load — one verified, pinned `/usr/bin/yes` worker per load",
      "CPU — started once before A1 and stopped only after A2. The original",
      "worker PIDs, executables, and affinities were rechecked around every leg,",
      "so the intended changed variable is the Node executable alone.",
      "",
      "The legs still ran in the fixed order A1, B, A2, so time and thermal",
      "drift remain possible confounders even with a constant load. Prefer",
      "repeating complete sessions over reading a single session, and never pool",
      "legs across different sessions or different loads.",
      "",
    );
  } else {
    lines.push(
      "This experiment did not complete all constant-load checks. Retained rows",
      "are descriptive partial output only and must not be used to compare Node",
      "executables. See `metadata.json` and `events.jsonl` for the stopping point.",
      "",
    );
  }
  lines.push(
    ...telemetryNoteLines(),
    "",
    "## Files",
    "",
    "- `metadata.json`: configuration, platform, topology, and both Node identities",
    "- `results.jsonl`: one exact child outcome per row, each with its Node label/path",
    "- `events.jsonl`: phase and verified load-worker boundaries",
    "- `telemetry.ndjson`: read-only frequency/temperature/no_turbo samples",
    "",
  );
  return lines.join("\n");
}

function renderGdbReport(metadata, gdbResult) {
  const lines = [
    "# Bounded GDB capture under constant external load",
    "",
    `- Status: ${metadata.status}`,
    `- Mode: ${metadata.config.mode}`,
    `- Target: CPU ${metadata.config.targetCpu}`,
    `- Load CPUs: ${metadata.config.loadCpus.join(", ")}`,
    `- Controller: CPU ${metadata.config.controllerCpu}`,
    `- Load warmup: ${metadata.config.loadWarmupSeconds}s after verified load start`,
    `- Target Node: ${metadata.node.node}; V8 ${metadata.node.v8}`,
    `- Target executable: \`${metadata.node.path}\``,
    `- Target executable SHA-256: \`${metadata.node.sha256}\``,
    `- GDB: ${metadata.gdb.gdbVersion}`,
    `- Capture runner: \`${metadata.gdb.captureScript}\` (SHA-256 \`${metadata.gdb.captureScriptSha256}\`)`,
    ...machineLines(metadata),
    "",
  ];
  if (metadata.status !== "complete") {
    lines.push(
      "The experiment did not complete every load-worker check. Any retained",
      "runner output is descriptive partial material only and must not be treated",
      "as a controlled GDB-under-load result. See `metadata.json` and",
      "`events.jsonl` for the stopping point.",
      "",
    );
  } else if (gdbResult === null || gdbResult.interrupted) {
    lines.push(
      "The capture did not complete its terminal runner accounting, so no",
      "evidence envelope was published. Partial artifacts, when present, are",
      "forensic only and authorize no conclusion.",
      "",
    );
  } else {
    lines.push(
      "## Capture outcome",
      "",
      `- Generation: \`${gdbResult.generation}\``,
      `- Bounds: at most ${gdbResult.maxRuns} attempt(s), stop after ${gdbResult.maxCaptures} capture(s)`,
      `- Outcome: **${gdbResult.outcome}** (runner exit code ${gdbResult.exitCode})`,
      `- Runner accounting: attempted ${gdbResult.attempted}, clean ${gdbResult.clean}, captured ${gdbResult.captured}, errors ${gdbResult.errors}`,
      `- Evidence probe: \`${gdbResult.probe}\``,
      "",
      "| Transcript | Attempt outcome | Bytes | SHA-256 |",
      "| --- | --- | ---: | --- |",
    );
    for (const transcript of gdbResult.transcripts) {
      lines.push(
        `| \`${transcript.path}\` | ${transcript.outcome} | ${transcript.bytes} | \`${transcript.sha256}\` |`,
      );
    }
    if (gdbResult.transcripts.length === 0) {
      lines.push("| *(none retained — clean attempts publish no transcript)* | | | |");
    }
    lines.push(
      "",
      "A `no-fault` outcome means every bounded attempt ran the workload without",
      "a SIGSEGV. That is an experimental result, not an operational failure:",
      "capture-fault.sh's exit-code-3 convention is preserved in the runner log,",
      "`results/gdb.meta`, and the manifest, while the harness itself reports a",
      "completed experiment. A `captured` transcript should be compared with the",
      "previously published fault signature (faulting instruction, `SI_ADDR`,",
      "registers, and backtrace) before treating the load trigger as the same",
      "fault.",
      "",
    );
  }
  lines.push("## Interpretation boundary", "");
  if (metadata.status === "complete") {
    lines.push(
      "The original pinned `/usr/bin/yes` worker PIDs, executables, and",
      "affinities were verified immediately before and after the capture window.",
      "The script controls only its own workers, not the rest of the machine.",
      "",
    );
  } else {
    lines.push(
      "Because the controlled-load checks did not complete, this bundle makes no",
      "claim that the induced load remained constant across the capture window.",
      "",
    );
  }
  lines.push(
    ...telemetryNoteLines(),
    "",
    "## Files",
    "",
    "- `metadata.json`: configuration, platform, topology, and binary identity",
    "- `events.jsonl`: load-worker and capture boundaries",
    "- `telemetry.ndjson`: read-only frequency/temperature/no_turbo samples",
    "- `logs/gdb/runner.log`: canonical ATTEMPT/COUNTS runner accounting",
    "- `gdb/cpu<N>-run<M>.txt`: bounded (64 MiB) provenance-bound transcripts",
    "- `results/gdb.meta`, `results/gdb.manifest`: validated evidence envelope",
    "",
  );
  return lines.join("\n");
}

function renderReport(metadata, rows, gdbResult) {
  if (metadata.config.mode === "gdb") return renderGdbReport(metadata, gdbResult);
  if (metadata.config.mode === "node-aba") return renderNodeAbaReport(metadata, rows);
  return renderLoadStateReport(metadata, rows);
}

export function planLines(options, controller, outDir, info) {
  const lines = [
    `mode                 ${options.mode}`,
    `target CPU           ${options.targetCpu}`,
    `load CPUs            ${options.loadCpus.join(",")}`,
    `controller CPU       ${controller}`,
  ];
  if (options.mode === "gdb") {
    lines.push(
      "sequence             settle -> verified load -> warmup -> bounded GDB capture -> stop load",
      `gdb max runs         ${options.gdbMaxRuns}`,
      `gdb max captures     ${options.gdbMaxCaptures}`,
      `gdb version          ${info.gdbVersion ?? "not found (required at run time)"}`,
      "capture runner       capture-fault.sh (64 MiB bounded generation-bound transcripts)",
      `settle seconds       ${options.settleSeconds} before starting the induced load`,
    );
  } else {
    lines.push(`runs per leg         ${options.runs}`);
    if (options.mode === "node-aba") {
      lines.push(
        "sequence             one constant load: A1(Node A) -> B(Node B) -> A2(Node A)",
        `node A               ${info.nodeA.node} V8 ${info.nodeA.v8} (${options.nodeA})`,
        `node B               ${info.nodeB.node} V8 ${info.nodeB.v8} (${options.nodeB})`,
        `settle seconds       ${options.settleSeconds} before starting the induced load`,
      );
    } else {
      lines.push(
        "sequence             A1(no induced load) -> B(load) -> A2(recovered)",
        `settle seconds       ${options.settleSeconds} before A1 and A2`,
      );
    }
  }
  lines.push(
    `load warmup seconds  ${options.loadWarmupSeconds}`,
    `telemetry interval   ${options.intervalMs} ms`,
    `target Node          ${info.node.node} V8 ${info.node.v8}`,
    `target executable    ${options.nodeBin}`,
    `load program         ${LOAD_PROGRAM} (one verified pinned worker per load CPU)`,
    "load checks          original PID/executable/affinity around every loaded phase",
    `output               ${outDir}`,
    "writes/settings      output files only; no root or sysfs writes",
  );
  return lines;
}

function describePlan(options, controller, outDir, info) {
  for (const line of planLines(options, controller, outDir, info)) console.log(line);
}

async function buildPlanInfo(options) {
  const info = { node: await inspectNode(options.nodeBin) };
  if (options.mode === "node-aba") {
    info.nodeA = realpathSync(options.nodeA) === realpathSync(options.nodeBin)
      ? info.node
      : await inspectNode(options.nodeA);
    info.nodeB = realpathSync(options.nodeB) === realpathSync(options.nodeBin)
      ? info.node
      : await inspectNode(options.nodeB);
  }
  if (options.mode === "gdb") {
    info.gdbVersion = probeGdbVersion();
  }
  return info;
}

async function buildMetadata(options, controller, allowed, argv) {
  const nodeInfo = await inspectNode(options.nodeBin);
  const metadata = {
    formatVersion: 1,
    status: "planned",
    config: {
      mode: options.mode,
      targetCpu: options.targetCpu,
      loadCpus: options.loadCpus,
      controllerCpu: controller,
      settleSeconds: options.settleSeconds,
      loadWarmupSeconds: options.loadWarmupSeconds,
      telemetryIntervalMs: options.intervalMs,
      sequence: buildPhasePlan(options)
        .filter((step) => step.type === "leg" || step.type === "gdb")
        .map((step) => step.phase ?? step.type),
      originalAllowedCpus: allowed,
      ...(options.mode === "gdb"
        ? { gdbMaxRuns: options.gdbMaxRuns, gdbMaxCaptures: options.gdbMaxCaptures }
        : { runs: options.runs }),
    },
    invocation: {
      arguments: argv,
      workingDirectory: process.cwd(),
      orchestratorNode: process.version,
      orchestratorV8: process.versions.v8,
      orchestratorExecutable: process.execPath,
    },
    node: {
      ...nodeInfo,
      path: options.nodeBin,
      sha256: await sha256(options.nodeBin),
    },
    workload: {
      child: CHILD,
      childSha256: await sha256(CHILD),
      launcher: LAUNCHER,
      launcherSha256: await sha256(LAUNCHER),
      runner: SCRIPT_PATH,
      runnerSha256: await sha256(SCRIPT_PATH),
      packageLockSha256: await sha256(path.join(REPO, "package-lock.json")),
      pgliteVersion: JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"))
        .dependencies["@electric-sql/pglite"],
    },
    load: {
      program: LOAD_PROGRAM,
      programSha256: await sha256(LOAD_PROGRAM),
      workers: options.loadCpus.length,
    },
    machine: {
      biosVendor: readText("/sys/class/dmi/id/bios_vendor"),
      biosVersion: readText("/sys/class/dmi/id/bios_version"),
      biosDate: readText("/sys/class/dmi/id/bios_date"),
      product: readText("/sys/class/dmi/id/product_name"),
      kernel: os.release(),
      architecture: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? "unavailable",
      microcode: microcodeVersion(),
      noTurboStart: readText(NO_TURBO),
      targetTopology: cpuTopology(options.targetCpu),
      loadTopology: options.loadCpus.map(cpuTopology),
      controllerTopology: cpuTopology(controller),
    },
  };
  if (options.mode === "node-aba") {
    const [infoA, infoB] = await Promise.all([
      realpathSync(options.nodeA) === realpathSync(options.nodeBin)
        ? Promise.resolve(nodeInfo)
        : inspectNode(options.nodeA),
      realpathSync(options.nodeB) === realpathSync(options.nodeBin)
        ? Promise.resolve(nodeInfo)
        : inspectNode(options.nodeB),
    ]);
    metadata.nodes = {
      A: { ...infoA, path: options.nodeA, sha256: await sha256(options.nodeA) },
      B: { ...infoB, path: options.nodeB, sha256: await sha256(options.nodeB) },
    };
  }
  if (options.mode === "gdb") {
    // Preflight the optional debugger dependency before any load starts, and
    // record the exact evidence toolchain identities.
    metadata.gdb = {
      maxRuns: options.gdbMaxRuns,
      maxCaptures: options.gdbMaxCaptures,
      gdbVersion: gdbVersion(),
      captureScript: CAPTURE_SCRIPT,
      captureScriptSha256: await sha256(CAPTURE_SCRIPT),
      attemptHelper: GDB_HELPER,
      attemptHelperSha256: await sha256(GDB_HELPER),
      evidenceModule: GDB_EVIDENCE,
      evidenceModuleSha256: await sha256(GDB_EVIDENCE),
    };
  }
  return metadata;
}

async function runExperiment(options, controller, outDir, metadata) {
  if (existsSync(outDir)) throw new Error(`output path already exists: ${outDir}`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const metadataPath = path.join(outDir, "metadata.json");
  const resultsPath = path.join(outDir, "results.jsonl");
  const eventsPath = path.join(outDir, "events.jsonl");
  const telemetryPath = path.join(outDir, "telemetry.ndjson");
  const reportPath = path.join(outDir, "report.md");
  writeFileSync(resultsPath, "", { flag: "wx", mode: 0o600 });
  writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
  metadata.status = "running";
  metadata.startedAt = new Date().toISOString();
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  const recorder = createTelemetryRecorder({
    outputPath: telemetryPath,
    cpus: [...new Set([options.targetCpu, ...options.loadCpus, controller])],
    intervalMs: options.intervalMs,
  });
  const execution = { rows: [], gdbResult: null };
  let workers = [];
  let operationalError = null;
  const nodeForLabel = (label) => {
    if (label === "A") return options.nodeA;
    if (label === "B") return options.nodeB;
    return options.nodeBin;
  };
  const hooks = {
    isInterrupted: () => interruptedBy !== null,
    settle: async (step) => {
      console.log(`settling ${step.seconds}s before ${step.before}...`);
      await delay(step.seconds * 1000, () => interruptedBy !== null);
    },
    warmup: async (step) => {
      if (step.seconds > 0) {
        console.log(`warming induced load for ${step.seconds}s...`);
        await delay(step.seconds * 1000, () => interruptedBy !== null);
      }
    },
    startLoad: async () => {
      workers = await startLoadWorkers(options.loadCpus, eventsPath, recorder);
    },
    verifyLoad: async (step) => {
      verifyLoadWorkers(workers, step.boundary, eventsPath, recorder);
    },
    stopLoad: async () => {
      if (interruptedBy === null) {
        verifyLoadWorkers(workers, "before planned load stop", eventsPath, recorder);
      }
      await stopLoadWorkers(workers, eventsPath, recorder);
      workers = [];
    },
    runLeg: (step) => runLeg(
      options,
      step.phase,
      step.description,
      nodeForLabel(step.nodeLabel),
      step.nodeLabel === "target" ? null : step.nodeLabel,
      resultsPath,
      eventsPath,
      recorder,
    ),
    gdbCapture: () => runGdbCapture(options, outDir, eventsPath, recorder),
  };
  try {
    await recorder.start();
    appendJsonLine(eventsPath, { type: "experiment_started", ...now(recorder) });
    await executePhasePlan(buildPhasePlan(options), hooks, execution);
  } catch (error) {
    operationalError = error;
  } finally {
    if (workers.length > 0) {
      try {
        await stopLoadWorkers(workers, eventsPath, recorder);
      } catch (cleanupError) {
        operationalError ??= cleanupError;
      }
    }
    for (const pid of activeGroups.keys()) killGroup(pid, "SIGTERM");
    try {
      await recorder.stop(interruptedBy ? "interrupted" : operationalError ? "error" : "complete");
    } catch (telemetryError) {
      operationalError ??= telemetryError;
    }
  }

  metadata.status = interruptedBy
    ? `interrupted by ${interruptedBy}`
    : operationalError
      ? "operational failure"
      : "complete";
  metadata.finishedAt = new Date().toISOString();
  metadata.recordCount = execution.rows.length;
  metadata.summary = summarize(execution.rows, phasesForMode(options.mode));
  if (options.mode === "gdb") metadata.gdb.result = execution.gdbResult;
  metadata.machine.noTurboEnd = readText(NO_TURBO);
  if (operationalError) metadata.operationalError = operationalError.message;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    reportPath,
    renderReport(metadata, execution.rows, execution.gdbResult),
    { flag: "wx", mode: 0o600 },
  );
  console.log(`report               ${reportPath}`);
  if (operationalError) throw operationalError;
  if (interruptedBy) return interruptedBy === "SIGINT" ? 130 : 143;
  return execution.rows.some((row) => row.outcome === "other_failure") ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) return usage();
    const requiredFiles = [CHILD, LAUNCHER, LOAD_PROGRAM, options.nodeBin];
    if (options.mode === "node-aba") requiredFiles.push(options.nodeA, options.nodeB);
    if (options.mode === "gdb") requiredFiles.push(CAPTURE_SCRIPT, GDB_HELPER, GDB_EVIDENCE);
    for (const required of requiredFiles) {
      if (!statSync(required).isFile()) throw new Error(`missing required file: ${required}`);
    }
    // Every executable that can reach a child is resolved to an exact canonical
    // path before the plan is fixed; no bare PATH lookup chooses a target Node.
    options.nodeBin = realpathSync(options.nodeBin);
    accessSync(options.nodeBin, constants.X_OK);
    if (options.mode === "node-aba") {
      options.nodeA = realpathSync(options.nodeA);
      options.nodeB = realpathSync(options.nodeB);
      accessSync(options.nodeA, constants.X_OK);
      accessSync(options.nodeB, constants.X_OK);
    }
    const inheritedAllowed = process.env[CONTROLLER_ENV] === undefined
      ? null
      : process.env[ALLOWED_ENV];
    if (process.env[CONTROLLER_ENV] !== undefined && !inheritedAllowed) {
      throw new Error("controller re-exec is missing its original allowed-CPU set");
    }
    const allowed = inheritedAllowed === null
      ? allowedCpus()
      : parseCpuList(inheritedAllowed);
    for (const cpu of [options.targetCpu, ...options.loadCpus]) {
      if (!allowed.includes(cpu)) throw new Error(`CPU ${cpu} is not allowed to this process`);
    }
    const controller = chooseController(
      options.controller,
      options.targetCpu,
      options.loadCpus,
      allowed,
    );
    const outDir = process.env[OUTPUT_ENV] ?? options.outDir ?? defaultOutDir(options.mode);
    if (!options.yes) {
      describePlan(options, controller, outDir, await buildPlanInfo(options));
      console.log("execution            dry-run (pass --yes to run)");
      return 0;
    }
    if (process.env[CONTROLLER_ENV] !== String(controller)) {
      const child = spawn("/usr/bin/taskset", [
        "-c",
        String(controller),
        process.execPath,
        SCRIPT_PATH,
        ...argv,
      ], {
        env: {
          ...process.env,
          [CONTROLLER_ENV]: String(controller),
          [OUTPUT_ENV]: outDir,
          [ALLOWED_ENV]: allowed.join(","),
        },
        stdio: "inherit",
      });
      return await superviseController(child);
    }
    const currentAllowed = allowedCpus();
    if (currentAllowed.length !== 1 || currentAllowed[0] !== controller) {
      throw new Error(
        `controller affinity is ${currentAllowed.join(",")}, expected ${controller}`,
      );
    }
    const metadata = await buildMetadata(options, controller, allowed, argv);
    describePlan(options, controller, outDir, {
      node: metadata.node,
      nodeA: metadata.nodes?.A,
      nodeB: metadata.nodes?.B,
      gdbVersion: metadata.gdb?.gdbVersion ?? null,
    });
    installSignalHandlers();
    return await runExperiment(options, controller, outDir, metadata);
  } catch (error) {
    return usage(error.message);
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  process.exitCode = await main();
}
