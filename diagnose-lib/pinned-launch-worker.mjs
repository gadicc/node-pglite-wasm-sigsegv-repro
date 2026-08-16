#!/usr/bin/env node

// Secure launch/affinity witness for pinned-runner V2. Isolated runs retain the
// original inherited-affinity mode. Concurrent runs keep this Node witness on
// the wave's controller CPU, stop a tiny shell after taskset has applied the
// target affinity, verify that exact mask through /proc, then resume the shell
// to exec the workload. Only this witness writes the bounded result protocol;
// the workload never inherits its stdout.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const WORKER_PROTOCOL_VERSION = 1;
const MAX_CPU_ID = 65_535;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_ERROR_TEXT = 4_096;
const AFFINITY_VERIFICATION_TIMEOUT_MS = 5_000;
const AFFINITY_POLL_INTERVAL_MS = 2;
const SIGNAL_RE = /^SIG[A-Z0-9]+$/;

function fail(message) {
  throw new TypeError(message);
}

function parseInteger(value, label, minimum, maximum) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(`${label} is invalid`);
  return parsed;
}

function errorRecord(error, fallback) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : fallback;
  const message = typeof error?.message === "string" ? error.message : String(error);
  return { code, message: message.slice(0, MAX_ERROR_TEXT) };
}

function emptyStderr() {
  return {
    sha256: createHash("sha256").digest("hex"),
    bytes: "0",
    excerptBase64: "",
    excerptBytes: 0,
    truncated: false,
  };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function affinityIsExact(cpu) {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = status.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m);
  return match !== null && match[1] === String(cpu);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function processStatus(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return {
    state: status.match(/^State:\s*(\S+)/m)?.[1] ?? null,
    cpus: status.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1] ?? null,
  };
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyStoppedChildAffinity(child, cpu, isCanceled) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw codedError("MISSING_CHILD_PID", "affinity gate did not expose a child PID");
  }
  const deadline = Date.now() + AFFINITY_VERIFICATION_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (isCanceled()) {
      throw codedError("CANCELED_BEFORE_LAUNCH", "launch was canceled before affinity verification completed");
    }
    let status = null;
    try {
      status = processStatus(child.pid);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
    if (status?.state === "T" || status?.state === "t") {
      if (status.cpus === null) {
        throw codedError("AFFINITY_STATUS_INVALID", "stopped launch gate had no readable CPU affinity");
      }
      if (status.cpus !== String(cpu)) {
        throw codedError("AFFINITY_MISMATCH", "stopped launch gate did not have the requested singleton CPU affinity");
      }
      return;
    }
    if (childHasExited(child)) {
      throw codedError("LAUNCH_GATE_EXITED", "affinity gate exited before it could be verified");
    }
    await pause(AFFINITY_POLL_INTERVAL_MS);
  }
  throw codedError("AFFINITY_VERIFICATION_TIMEOUT", "affinity gate did not stop for verification in time");
}

function parseWorkerArguments(argv) {
  if (argv[0] !== "--controller") {
    if (argv.length < 3) fail("worker requires CPU, stderr limit, and command");
    return {
      mode: "inherited",
      witnessCpu: parseInteger(argv[0], "CPU", 0, MAX_CPU_ID),
      cpu: parseInteger(argv[0], "CPU", 0, MAX_CPU_ID),
      stderrLimit: parseInteger(argv[1], "stderr limit", 0, MAX_STDERR_BYTES),
      command: argv[2],
      args: argv.slice(3),
      tasksetPath: null,
      shellPath: null,
    };
  }
  if (argv.length < 7) {
    fail("controller worker requires witness CPU, target CPU, stderr limit, taskset, shell, and command");
  }
  const witnessCpu = parseInteger(argv[1], "witness CPU", 0, MAX_CPU_ID);
  const cpu = parseInteger(argv[2], "target CPU", 0, MAX_CPU_ID);
  if (witnessCpu === cpu) fail("witness CPU must differ from target CPU");
  return {
    mode: "controller",
    witnessCpu,
    cpu,
    stderrLimit: parseInteger(argv[3], "stderr limit", 0, MAX_STDERR_BYTES),
    tasksetPath: argv[4],
    shellPath: argv[5],
    command: argv[6],
    args: argv.slice(7),
  };
}

function testHarnessForbids(command, args) {
  if (process.env.DIAG_TEST_FORBID_WORKLOAD !== "1") return false;
  return [command, ...args].some((value) => /(?:^|\/)(?:repro|child)\.mjs$/.test(value));
}

async function main(argv) {
  const config = parseWorkerArguments(argv);
  const { cpu, command, args, stderrLimit } = config;
  const launchStrings = [command, ...args, config.tasksetPath, config.shellPath]
    .filter((value) => value !== null);
  if (launchStrings.some((value) => value.length === 0 || value.includes("\0"))) {
    fail("worker command is invalid");
  }

  if (!affinityIsExact(config.witnessCpu)) {
    writeResult({
      version: WORKER_PROTOCOL_VERSION,
      cpu,
      launchState: "affinity-failure",
      exitCode: null,
      signal: null,
      canceled: false,
      launchError: {
        code: "AFFINITY_MISMATCH",
        message: config.mode === "controller"
          ? "witness CPU affinity is not the requested singleton controller CPU"
          : "inherited CPU affinity is not the requested singleton CPU",
      },
      stderr: emptyStderr(),
    });
    return;
  }
  if (testHarnessForbids(command, args)) {
    writeResult({
      version: WORKER_PROTOCOL_VERSION,
      cpu,
      launchState: "launch-failure",
      exitCode: null,
      signal: null,
      canceled: false,
      launchError: { code: "TEST_HARNESS_REFUSAL", message: "offline test harness refused a workload entrypoint" },
      stderr: emptyStderr(),
    });
    return;
  }

  let child;
  try {
    const launchCommand = config.mode === "controller" ? config.tasksetPath : command;
    const launchArgs = config.mode === "controller"
      ? [
        "-c",
        String(cpu),
        config.shellPath,
        "-c",
        "kill -STOP \"$$\"; exec \"$@\"",
        "pinned-workload-v2",
        command,
        ...args,
      ]
      : args;
    child = spawn(launchCommand, launchArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    writeResult({
      version: WORKER_PROTOCOL_VERSION,
      cpu,
      launchState: "launch-failure",
      exitCode: null,
      signal: null,
      canceled: false,
      launchError: errorRecord(error, "SPAWN_ERROR"),
      stderr: emptyStderr(),
    });
    return;
  }

  const hash = createHash("sha256");
  const excerpt = [];
  let excerptBytes = 0;
  let totalBytes = 0n;
  let canceled = false;
  let launchError = null;
  let launchVerified = config.mode === "inherited";
  let killTimer = null;

  child.stderr?.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    totalBytes += BigInt(bytes.length);
    const remaining = stderrLimit - excerptBytes;
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      excerpt.push(retained);
      excerptBytes += retained.length;
    }
  });
  child.stderr?.resume?.();
  child.once("error", (error) => { launchError ??= error; });

  let closedResult = null;
  const closedPromise = new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      closedResult = { exitCode, signal };
      resolve(closedResult);
    });
  });

  const cancel = () => {
    canceled = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(launchVerified ? "SIGTERM" : "SIGKILL"); } catch { /* close will reconcile */ }
    if (!launchVerified) return;
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    }, 1_000);
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);

  if (config.mode === "controller") {
    try {
      await verifyStoppedChildAffinity(child, cpu, () => canceled);
      if (launchError !== null) throw launchError;
      launchVerified = true;
      if (!child.kill("SIGCONT")) {
        throw codedError("LAUNCH_GATE_RESUME_FAILED", "verified affinity gate could not be resumed");
      }
    } catch (error) {
      launchError ??= error;
      if (!childHasExited(child)) {
        try { child.kill("SIGKILL"); } catch { /* close will reconcile */ }
      }
    }
  }

  const closed = closedResult ?? await closedPromise;
  if (killTimer !== null) clearTimeout(killTimer);
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  const excerptBuffer = Buffer.concat(excerpt, excerptBytes);
  writeResult({
    version: WORKER_PROTOCOL_VERSION,
    cpu,
    launchState: launchVerified && launchError === null ? "launched" : "launch-failure",
    exitCode: launchVerified && launchError === null && Number.isInteger(closed.exitCode) ? closed.exitCode : null,
    signal: launchVerified && launchError === null && typeof closed.signal === "string" && SIGNAL_RE.test(closed.signal)
      ? closed.signal
      : null,
    canceled,
    launchError: launchError === null ? null : errorRecord(launchError, "SPAWN_ERROR"),
    stderr: {
      sha256: hash.digest("hex"),
      bytes: totalBytes.toString(),
      excerptBase64: excerptBuffer.toString("base64"),
      excerptBytes,
      truncated: totalBytes > BigInt(excerptBytes),
    },
  });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  writeResult({
    version: WORKER_PROTOCOL_VERSION,
    cpu: null,
    launchState: "launch-failure",
    exitCode: null,
    signal: null,
    canceled: false,
    launchError: errorRecord(error, "WORKER_ERROR"),
    stderr: emptyStderr(),
  });
}
