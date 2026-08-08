#!/usr/bin/env node
// Follow-up CPU attribution experiments for the PGlite crash.
//
// one-to-one: one PGlite process per listed CPU, launched concurrently each
// round. Unlike the main group screen, every failed child has a known CPU.
// interleaved: one process at a time, with every CPU tested once per round in
// a deterministic randomized order. This balances time/order across CPUs.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.dirname(SCRIPT_PATH);
const CHILD = path.join(REPO, "child.mjs");
const LAUNCHER = path.join(REPO, "diagnose-lib", "run-pinned-child.sh");
const NO_TURBO = "/sys/devices/system/cpu/intel_pstate/no_turbo";
const MAX_STDERR = 16 * 1024;

function usage(message = null) {
  if (message) console.error(`error: ${message}`);
  console.error(`usage: node targeted-cpu-test.mjs --mode one-to-one|interleaved \\
  --cpus LIST --rounds N [--controller-cpu N|auto] [--seed N] \\
  [--out-dir DIR] [--dry-run | --yes]

Examples:
  node targeted-cpu-test.mjs --mode one-to-one --cpus 8-11 --rounds 50 --dry-run
  node targeted-cpu-test.mjs --mode interleaved --cpus 10,11,18,19,21,22 \\
    --rounds 50 --seed 20260808 --dry-run`);
  return 2;
}

function safePositive(value, label) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) throw new Error(`${label} must be a positive integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} is too large`);
  return n;
}

function safeCpu(value, label = "CPU") {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) throw new Error(`${label} must be a canonical non-negative integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 65535) throw new Error(`${label} is out of range`);
  return n;
}

function safeUint32(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) throw new Error(`${label} must be a canonical non-negative integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > 0xffff_ffff) throw new Error(`${label} must fit in 32 bits`);
  return n;
}

export function expandCpuList(spec) {
  if (typeof spec !== "string" || spec.length === 0) throw new Error("--cpus is required");
  const cpus = [];
  const seen = new Set();
  for (const token of spec.split(",")) {
    const range = token.match(/^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/);
    if (range) {
      const first = safeCpu(range[1]);
      const last = safeCpu(range[2]);
      if (last < first) throw new Error(`descending CPU range: ${token}`);
      for (let cpu = first; cpu <= last; cpu += 1) {
        if (seen.has(cpu)) throw new Error(`duplicate CPU: ${cpu}`);
        seen.add(cpu);
        cpus.push(cpu);
      }
      continue;
    }
    const cpu = safeCpu(token);
    if (seen.has(cpu)) throw new Error(`duplicate CPU: ${cpu}`);
    seen.add(cpu);
    cpus.push(cpu);
  }
  return cpus;
}

function makeRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function buildRoundOrders(mode, cpus, rounds, seed) {
  if (!new Set(["one-to-one", "interleaved"]).has(mode)) throw new Error(`unknown mode: ${mode}`);
  const rng = makeRng(seed);
  return Array.from({ length: rounds }, () => {
    const order = [...cpus];
    if (mode === "interleaved") {
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    return order;
  });
}

function parseArgs(argv) {
  const options = {
    controller: "auto",
    dryRun: false,
    mode: null,
    outDir: null,
    rounds: null,
    seed: 20260808,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (["--mode", "--cpus", "--rounds", "--controller-cpu", "--seed", "--out-dir"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[++i];
      if (arg === "--mode") options.mode = value;
      else if (arg === "--cpus") options.cpuSpec = value;
      else if (arg === "--rounds") options.rounds = safePositive(value, "--rounds");
      else if (arg === "--controller-cpu") options.controller = value === "auto" ? value : safeCpu(value, "controller CPU");
      else if (arg === "--seed") options.seed = safeUint32(value, "--seed");
      else options.outDir = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!new Set(["one-to-one", "interleaved"]).has(options.mode)) throw new Error("--mode must be one-to-one or interleaved");
  options.cpus = expandCpuList(options.cpuSpec);
  if (options.rounds === null) throw new Error("--rounds is required");
  return options;
}

function allowedCpus() {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = status.match(/^Cpus_allowed_list:\s*(\S+)$/m);
  if (!match) throw new Error("cannot read Cpus_allowed_list from /proc/self/status");
  return expandCpuList(match[1]);
}

function chooseController(requested, targets, allowed) {
  const controller = requested === "auto"
    ? allowed.find((cpu) => !targets.includes(cpu))
    : requested;
  if (controller === undefined) throw new Error("no allowed controller CPU exists outside the target list");
  if (!allowed.includes(controller)) throw new Error(`controller CPU ${controller} is not allowed to this process`);
  if (targets.includes(controller)) throw new Error(`controller CPU ${controller} must be outside the target list`);
  return controller;
}

function readNoTurbo() {
  try {
    return readFileSync(NO_TURBO, "utf8").trim();
  } catch {
    return "unavailable";
  }
}

function defaultOutDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(REPO, "diagnostics", `targeted-${stamp}`);
}

function describePlan(options, controller, outDir) {
  console.log(`mode               ${options.mode}`);
  console.log(`target CPUs        ${options.cpus.join(",")}`);
  console.log(`rounds             ${options.rounds}`);
  console.log(`controller CPU     ${controller} (outside target set)`);
  console.log(`seed               ${options.seed}${options.mode === "one-to-one" ? " (unused in this mode)" : ""}`);
  console.log(`output             ${outDir}`);
  console.log(options.mode === "one-to-one"
    ? `protocol           ${options.cpus.length} simultaneous children per round, one pinned to each CPU`
    : "protocol           one child at a time; every CPU once per randomized round");
  console.log("turbo setting      observed and recorded only; this script never changes it");
}

const active = new Map();
let interruptedBy = null;
let signalCount = 0;

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      signalCount += 1;
      interruptedBy = signal;
      for (const child of active.values()) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      }
      if (signalCount > 1) process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function runPinned(cpu, round, order) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stderr = "";
    let launchError = null;
    const child = spawn("/bin/bash", [LAUNCHER, String(cpu), process.execPath, CHILD], {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    active.set(child.pid, child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    });
    child.once("error", (error) => { launchError = error.message; });
    child.once("close", (exitCode, signal) => {
      active.delete(child.pid);
      let outcome = "pass";
      if (interruptedBy) outcome = "interrupted";
      else if (signal === "SIGSEGV" || exitCode === 139) outcome = "sigsegv";
      else if (signal !== null || exitCode !== 0) outcome = "other-failure";
      resolve({
        cpu,
        elapsedMs: Math.round(performance.now() - started),
        exitCode,
        launchError,
        order,
        outcome,
        round,
        signal,
        stderr: stderr.trim(),
      });
    });
  });
}

function summarize(rows, cpus) {
  return cpus.map((cpu) => {
    const selected = rows.filter((row) => row.cpu === cpu);
    return {
      cpu,
      attempted: selected.length,
      pass: selected.filter((row) => row.outcome === "pass").length,
      sigsegv: selected.filter((row) => row.outcome === "sigsegv").length,
      otherFailure: selected.filter((row) => row.outcome === "other-failure").length,
      interrupted: selected.filter((row) => row.outcome === "interrupted").length,
    };
  });
}

function measuredRate(count, total) {
  return total > 0 ? `${count}/${total} = ${(100 * count / total).toFixed(1)}%` : "unavailable";
}

function renderReport(metadata, rows) {
  const perCpu = summarize(rows, metadata.cpus);
  const lines = [
    "# Targeted CPU follow-up",
    "",
    `- Status: ${metadata.status}`,
    `- Protocol: ${metadata.mode}`,
    `- Target CPUs: ${metadata.cpus.join(", ")}`,
    `- Controller CPU: ${metadata.controllerCpu}`,
    `- Requested rounds: ${metadata.rounds}`,
    `- intel_pstate/no_turbo: ${metadata.noTurboStart} at start; ${metadata.noTurboEnd} at end`,
    "",
  ];
  if (metadata.mode === "one-to-one") {
    lines.push("Each round launched one child per target CPU concurrently. Every child was", "pinned separately, so a failure row identifies its CPU by construction.", "");
  } else {
    lines.push("Each round tested every target CPU once, one child at a time, in a", "deterministically randomized order. Every CPU therefore has balanced coverage", "over time and uses the same launcher.", "");
  }
  lines.push("Child percentages below are measured descriptive rates, not proof of a stable", "hardware failure probability.", "", "| CPU | Attempted | Passed | SIGSEGV / measured rate | Other failures | Interrupted |", "| --- | --- | --- | --- | --- | --- |");
  for (const cpu of perCpu) {
    const valid = cpu.pass + cpu.sigsegv + cpu.otherFailure;
    lines.push(`| ${cpu.cpu} | ${cpu.attempted} | ${cpu.pass} | ${measuredRate(cpu.sigsegv, valid)} | ${cpu.otherFailure} | ${cpu.interrupted} |`);
  }
  if (metadata.mode === "one-to-one") {
    const completedRounds = new Set(rows.filter((row) => row.outcome !== "interrupted").map((row) => row.round)).size;
    const positiveRounds = new Set(rows.filter((row) => row.outcome === "sigsegv").map((row) => row.round)).size;
    lines.push("", `Completed rounds with at least one SIGSEGV: ${positiveRounds}/${completedRounds}.`);
  }
  if (metadata.noTurboStart !== metadata.noTurboEnd) {
    lines.push("", "**Warning:** no_turbo changed externally during the experiment; do not treat", "the CPU rates as one stable frequency condition.");
  }
  lines.push("", "Raw per-child records: `results.jsonl`.", "");
  return lines.join("\n");
}

async function run(options, controller, outDir) {
  if (existsSync(outDir)) throw new Error(`output path already exists: ${outDir}`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const resultsPath = path.join(outDir, "results.jsonl");
  const metadataPath = path.join(outDir, "metadata.json");
  const reportPath = path.join(outDir, "report.md");
  const startedAt = new Date().toISOString();
  const noTurboStart = readNoTurbo();
  const metadata = {
    status: "running",
    mode: options.mode,
    cpus: options.cpus,
    controllerCpu: controller,
    rounds: options.rounds,
    seed: options.seed,
    launcher: "diagnose-lib/run-pinned-child.sh",
    node: process.version,
    noTurboStart,
    startedAt,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(resultsPath, "", { flag: "wx", mode: 0o600 });
  const rows = [];
  const orders = buildRoundOrders(options.mode, options.cpus, options.rounds, options.seed);
  for (let round = 1; round <= options.rounds && !interruptedBy; round += 1) {
    const order = orders[round - 1];
    const batch = options.mode === "one-to-one"
      ? await Promise.all(order.map((cpu, index) => runPinned(cpu, round, index + 1)))
      : [];
    if (options.mode === "interleaved") {
      for (let index = 0; index < order.length && !interruptedBy; index += 1) {
        batch.push(await runPinned(order[index], round, index + 1));
      }
    }
    for (const row of batch) {
      rows.push(row);
      appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
    }
    const segv = batch.filter((row) => row.outcome === "sigsegv").length;
    console.log(`round=${round}/${options.rounds} completed=${batch.length}/${options.cpus.length} sigsegv=${segv}`);
  }
  metadata.status = interruptedBy ? `interrupted by ${interruptedBy}` : "complete";
  metadata.noTurboEnd = readNoTurbo();
  metadata.finishedAt = new Date().toISOString();
  metadata.recordCount = rows.length;
  metadata.summary = summarize(rows, options.cpus);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(reportPath, renderReport(metadata, rows), { flag: "wx", mode: 0o600 });
  console.log(`report             ${reportPath}`);
  if (interruptedBy) return interruptedBy === "SIGINT" ? 130 : 143;
  return rows.some((row) => row.outcome !== "pass") ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    for (const required of [CHILD, LAUNCHER]) {
      if (!statSync(required).isFile()) throw new Error(`missing required file: ${required}`);
    }
    const allowed = allowedCpus();
    for (const cpu of options.cpus) {
      if (!allowed.includes(cpu)) throw new Error(`target CPU ${cpu} is not allowed to this process`);
    }
    const controller = chooseController(options.controller, options.cpus, allowed);
    const outDir = options.outDir ?? defaultOutDir();
    describePlan(options, controller, outDir);
    if (options.dryRun) return 0;
    if (!options.yes) return usage("--yes is required for a live workload run");
    if (process.env.PGLITE_TARGETED_CONTROLLER !== String(controller)) {
      const child = spawnSync("taskset", ["-c", String(controller), process.execPath, SCRIPT_PATH, ...argv], {
        env: { ...process.env, PGLITE_TARGETED_CONTROLLER: String(controller) },
        stdio: "inherit",
      });
      if (child.error) throw child.error;
      if (child.signal) return child.signal === "SIGINT" ? 130 : 125;
      return child.status ?? 125;
    }
    const currentAllowed = allowedCpus();
    if (currentAllowed.length !== 1 || currentAllowed[0] !== controller) {
      throw new Error(`controller re-exec affinity is ${currentAllowed.join(",")}, expected ${controller}`);
    }
    installSignalHandlers();
    return await run(options, controller, outDir);
  } catch (error) {
    return usage(error.message);
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  process.exitCode = await main();
}
