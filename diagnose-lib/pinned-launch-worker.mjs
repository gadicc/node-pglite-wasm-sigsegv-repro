#!/usr/bin/env node

// Secure launch/affinity witness for pinned-runner V2. This process is itself
// started under taskset, verifies that its inherited mask is exactly the
// requested CPU, then launches the workload with that mask. Only this witness
// writes the bounded result protocol; the workload never inherits its stdout.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const WORKER_PROTOCOL_VERSION = 1;
const MAX_CPU_ID = 65_535;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_ERROR_TEXT = 4_096;
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

function testHarnessForbids(command, args) {
  if (process.env.DIAG_TEST_FORBID_WORKLOAD !== "1") return false;
  return [command, ...args].some((value) => /(?:^|\/)(?:repro|child)\.mjs$/.test(value));
}

async function main(argv) {
  if (argv.length < 3) fail("worker requires CPU, stderr limit, and command");
  const cpu = parseInteger(argv[0], "CPU", 0, MAX_CPU_ID);
  const stderrLimit = parseInteger(argv[1], "stderr limit", 0, MAX_STDERR_BYTES);
  const command = argv[2];
  const args = argv.slice(3);
  if (command.length === 0 || command.includes("\0") || args.some((arg) => arg.includes("\0"))) {
    fail("worker command is invalid");
  }

  if (!affinityIsExact(cpu)) {
    writeResult({
      version: WORKER_PROTOCOL_VERSION,
      cpu,
      launchState: "affinity-failure",
      exitCode: null,
      signal: null,
      canceled: false,
      launchError: { code: "AFFINITY_MISMATCH", message: "inherited CPU affinity is not the requested singleton CPU" },
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
    child = spawn(command, args, {
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
  child.once("error", (error) => { launchError = error; });

  const cancel = () => {
    canceled = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* close will reconcile */ }
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    }, 1_000);
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);

  const closed = await new Promise((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (killTimer !== null) clearTimeout(killTimer);
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  const excerptBuffer = Buffer.concat(excerpt, excerptBytes);
  writeResult({
    version: WORKER_PROTOCOL_VERSION,
    cpu,
    launchState: launchError === null ? "launched" : "launch-failure",
    exitCode: launchError === null && Number.isInteger(closed.exitCode) ? closed.exitCode : null,
    signal: launchError === null && typeof closed.signal === "string" && SIGNAL_RE.test(closed.signal)
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
