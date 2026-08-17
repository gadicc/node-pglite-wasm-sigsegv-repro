#!/usr/bin/env node
// Controlled external-load A/B/A experiment for the CPU-localized PGlite
// SIGSEGV. The target remains one sequential child pinned to one CPU. Leg B
// adds deterministic workers pinned to other CPUs; A1/A2 add no load.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  accessSync,
  constants,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.dirname(SCRIPT_PATH);
const CHILD = path.join(REPO, "child.mjs");
const LAUNCHER = path.join(REPO, "diagnose-lib", "run-pinned-child.sh");
const LOAD_PROGRAM = "/usr/bin/yes";
const NO_TURBO = "/sys/devices/system/cpu/intel_pstate/no_turbo";
const MAX_STDERR = 16 * 1024;
const CONTROLLER_ENV = "PGLITE_LOAD_ABA_CONTROLLER";
const OUTPUT_ENV = "PGLITE_LOAD_ABA_OUT_DIR";
const ALLOWED_ENV = "PGLITE_LOAD_ABA_ALLOWED_CPUS";

const PHASES = [
  ["A1", "no induced load"],
  ["B", "induced load"],
  ["A2", "no induced load after recovery"],
];

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(`usage: node load-state-aba.mjs [options]

Controlled A/B/A test: sequential PGlite children remain pinned to the target
CPU; only leg B starts one deterministic worker on each separately pinned load
CPU. The script never changes firmware, frequency, or sysfs settings.

Options:
  --target-cpu N          target logical CPU (default: 19)
  --load-cpus LIST        induced-load CPUs (default: 0-7)
  --controller-cpu N|auto controller CPU, outside target/load sets (default: auto)
  --runs N                child runs per leg (default: 20)
  --node-bin PATH         exact Node binary for child.mjs (default: this Node)
  --settle-seconds N      no-load settling before A1 and A2 (default: 15)
  --load-warmup-seconds N delay after verified load starts (default: 0)
  --interval-ms N         telemetry interval, 50-60000 (default: 100)
  --out-dir DIR           new output directory (default: diagnostics/load-aba-*)
  --yes                   run the live workload
  --dry-run               print the resolved plan only (the default)

Examples:
  node load-state-aba.mjs
  node load-state-aba.mjs --yes
  node load-state-aba.mjs --load-cpus 16-18 --runs 30 --yes
  node load-state-aba.mjs --node-bin /usr/bin/node --dry-run`);
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
    help: false,
    intervalMs: 100,
    loadCpuSpec: "0-7",
    loadWarmupSeconds: 0,
    nodeBin: process.execPath,
    outDir: null,
    runs: 20,
    settleSeconds: 15,
    targetCpu: 19,
    yes: false,
  };
  const valueOptions = new Set([
    "--target-cpu",
    "--load-cpus",
    "--controller-cpu",
    "--runs",
    "--node-bin",
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
      if (arg === "--target-cpu") {
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

function defaultOutDir() {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(REPO, "diagnostics", `load-aba-${stamp}`);
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

async function startLoadWorkers(cpus, eventsPath, recorder) {
  const workers = [];
  try {
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
      workers.push({ child, closed, cpu });
    }
    await delay(250, () => interruptedBy !== null);
    if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
    for (const worker of workers) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error(`load worker on CPU ${worker.cpu} exited during startup`);
      }
      const affinity = processAffinity(worker.child.pid);
      if (affinity !== String(worker.cpu)) {
        throw new Error(
          `load worker PID ${worker.child.pid} affinity is ${affinity}, expected ${worker.cpu}`,
        );
      }
      appendJsonLine(eventsPath, {
        type: "load_worker_started",
        cpu: worker.cpu,
        pid: worker.child.pid,
        affinity,
        executable: processExe(worker.child.pid),
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
  appendJsonLine(eventsPath, {
    type: "load_workers_stopped",
    count: workers.length,
    ...now(recorder),
  });
}

function runPinnedChild(options, phase, run) {
  return new Promise((resolve) => {
    const startedUnixMs = Date.now();
    const startedMonotonicNs = process.hrtime.bigint();
    let stderr = "";
    let launchError = null;
    const child = spawn("/bin/bash", [
      LAUNCHER,
      String(options.targetCpu),
      options.nodeBin,
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

async function runLeg(options, phase, description, resultsPath, eventsPath, recorder) {
  appendJsonLine(eventsPath, {
    type: "phase_started",
    phase,
    description,
    ...now(recorder),
  });
  const rows = [];
  for (let run = 1; run <= options.runs && interruptedBy === null; run += 1) {
    const row = await runPinnedChild(options, phase, run);
    rows.push(row);
    appendJsonLine(resultsPath, row);
    console.log(
      `phase=${phase} run=${run}/${options.runs} outcome=${row.outcome} elapsedMs=${row.elapsedMs}`,
    );
  }
  appendJsonLine(eventsPath, {
    type: "phase_ended",
    phase,
    description,
    completedRuns: rows.length,
    ...now(recorder),
  });
  return rows;
}

export function summarize(rows) {
  return PHASES.map(([phase, description]) => {
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

function percent(count, total) {
  return total > 0 ? `${count}/${total} (${(100 * count / total).toFixed(1)}%)` : "0/0";
}

function renderReport(metadata, rows) {
  const summary = summarize(rows);
  const lines = [
    "# External-load A/B/A",
    "",
    `- Status: ${metadata.status}`,
    `- Target: CPU ${metadata.config.targetCpu}`,
    `- Load CPUs: ${metadata.config.loadCpus.join(", ")}`,
    `- Controller: CPU ${metadata.config.controllerCpu}`,
    `- Runs per leg: ${metadata.config.runs}`,
    `- Target Node: ${metadata.node.node}; V8 ${metadata.node.v8}`,
    `- Target executable: \`${metadata.node.path}\``,
    `- Target executable SHA-256: \`${metadata.node.sha256}\``,
    `- BIOS: ${metadata.machine.biosVersion} (${metadata.machine.biosDate})`,
    `- Kernel: ${metadata.machine.kernel}`,
    `- intel_pstate/no_turbo: ${metadata.machine.noTurboStart} at start; ${metadata.machine.noTurboEnd} at end`,
    "",
    "| Leg | Controlled condition | Attempted | Passed | SIGSEGV | Other | Interrupted |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of summary) {
    lines.push(
      `| ${item.phase} | ${item.description} | ${item.attempted} | ${item.pass} | ${percent(item.sigsegv, item.attempted)} | ${item.otherFailure} | ${item.interrupted} |`,
    );
  }
  lines.push(
    "",
    "## Interpretation boundary",
    "",
    "The script controls only its own induced workers. A1 and A2 mean *no",
    "script-induced load*, not proof that the rest of the machine was idle.",
    "Workers in B were individually pinned away from the target CPU and their",
    "affinities were verified through `/proc`. The sequential A/B/A order can",
    "still be affected by temperature, time, and carryover; repeat the complete",
    "experiment rather than pooling arbitrary legs from different sessions.",
    "",
    "`scaling_cur_freq` in `telemetry.ndjson` is a point-in-time kernel value,",
    "not an effective-frequency measurement. Temperature availability depends",
    "on exposed `coretemp` hwmon sensors.",
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

function describePlan(options, controller, outDir, nodeInfo) {
  console.log(`target CPU          ${options.targetCpu}`);
  console.log(`load CPUs           ${options.loadCpus.join(",")}`);
  console.log(`controller CPU       ${controller}`);
  console.log(`runs per leg         ${options.runs}`);
  console.log(`sequence             A1(no induced load) -> B(load) -> A2(recovered)`);
  console.log(`settle seconds       ${options.settleSeconds} before A1 and A2`);
  console.log(`load warmup seconds  ${options.loadWarmupSeconds}`);
  console.log(`telemetry interval   ${options.intervalMs} ms`);
  console.log(`target Node          ${nodeInfo.node} V8 ${nodeInfo.v8}`);
  console.log(`target executable    ${options.nodeBin}`);
  console.log(`load program         ${LOAD_PROGRAM} (one worker per load CPU)`);
  console.log(`output               ${outDir}`);
  console.log("writes/settings      output files only; no root or sysfs writes");
}

async function buildMetadata(options, controller, allowed, argv) {
  const nodeInfo = await inspectNode(options.nodeBin);
  return {
    formatVersion: 1,
    status: "planned",
    config: {
      targetCpu: options.targetCpu,
      loadCpus: options.loadCpus,
      controllerCpu: controller,
      runs: options.runs,
      settleSeconds: options.settleSeconds,
      loadWarmupSeconds: options.loadWarmupSeconds,
      telemetryIntervalMs: options.intervalMs,
      sequence: PHASES.map(([phase]) => phase),
      originalAllowedCpus: allowed,
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
  const rows = [];
  let workers = [];
  let operationalError = null;
  try {
    await recorder.start();
    appendJsonLine(eventsPath, { type: "experiment_started", ...now(recorder) });
    console.log(`settling ${options.settleSeconds}s before A1...`);
    await delay(options.settleSeconds * 1000, () => interruptedBy !== null);
    if (!interruptedBy) {
      rows.push(...await runLeg(
        options,
        "A1",
        "no induced load",
        resultsPath,
        eventsPath,
        recorder,
      ));
    }
    if (!interruptedBy) {
      workers = await startLoadWorkers(options.loadCpus, eventsPath, recorder);
      if (options.loadWarmupSeconds > 0) {
        console.log(`warming induced load for ${options.loadWarmupSeconds}s...`);
        await delay(options.loadWarmupSeconds * 1000, () => interruptedBy !== null);
      }
    }
    if (!interruptedBy) {
      rows.push(...await runLeg(
        options,
        "B",
        "induced load",
        resultsPath,
        eventsPath,
        recorder,
      ));
    }
    await stopLoadWorkers(workers, eventsPath, recorder);
    workers = [];
    if (!interruptedBy) {
      console.log(`settling ${options.settleSeconds}s before A2...`);
      await delay(options.settleSeconds * 1000, () => interruptedBy !== null);
    }
    if (!interruptedBy) {
      rows.push(...await runLeg(
        options,
        "A2",
        "no induced load after recovery",
        resultsPath,
        eventsPath,
        recorder,
      ));
    }
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
  metadata.recordCount = rows.length;
  metadata.summary = summarize(rows);
  metadata.machine.noTurboEnd = readText(NO_TURBO);
  if (operationalError) metadata.operationalError = operationalError.message;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(reportPath, renderReport(metadata, rows), { flag: "wx", mode: 0o600 });
  console.log(`report               ${reportPath}`);
  if (operationalError) throw operationalError;
  if (interruptedBy) return interruptedBy === "SIGINT" ? 130 : 143;
  return rows.some((row) => row.outcome === "other_failure") ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) return usage();
    for (const required of [CHILD, LAUNCHER, LOAD_PROGRAM, options.nodeBin]) {
      if (!statSync(required).isFile()) throw new Error(`missing required file: ${required}`);
    }
    options.nodeBin = realpathSync(options.nodeBin);
    accessSync(options.nodeBin, constants.X_OK);
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
    const outDir = process.env[OUTPUT_ENV] ?? options.outDir ?? defaultOutDir();
    if (!options.yes) {
      const nodeInfo = await inspectNode(options.nodeBin);
      describePlan(options, controller, outDir, nodeInfo);
      console.log("mode                 dry-run (pass --yes to run)");
      return 0;
    }
    if (process.env[CONTROLLER_ENV] !== String(controller)) {
      return await new Promise((resolve, reject) => {
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
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          if (signal) resolve(signal === "SIGINT" ? 130 : 125);
          else resolve(exitCode ?? 125);
        });
      });
    }
    const currentAllowed = allowedCpus();
    if (currentAllowed.length !== 1 || currentAllowed[0] !== controller) {
      throw new Error(
        `controller affinity is ${currentAllowed.join(",")}, expected ${controller}`,
      );
    }
    const metadata = await buildMetadata(options, controller, allowed, argv);
    describePlan(options, controller, outDir, metadata.node);
    installSignalHandlers();
    return await runExperiment(options, controller, outDir, metadata);
  } catch (error) {
    return usage(error.message);
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  process.exitCode = await main();
}
