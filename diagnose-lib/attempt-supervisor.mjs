#!/usr/bin/env node
// Internal process-group leader for one workload attempt.
//
// The parent sends the workload over the private Node IPC channel so literal
// environment values never enter this supervisor's command line. The workload
// is spawned directly with an exact argv and environment. This process stays
// alive as the session/process-group identity until the parent confirms that
// cleanup is complete.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import { verifyWorkloadLaunchProvenance } from "./workload-spec.mjs";

const PROTOCOL_VERSION = 1;
const SUPERVISOR_ERROR_EXIT = 125;
const LIVE_STATES = new Set(["R", "S", "D", "T", "t", "I", "W"]);
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

let workload = null;
let workloadStarted = false;
let workloadExited = false;
let launchReceived = false;
let intentionalShutdown = false;
let emergencyCleanupStarted = false;
let termGraceMs = 1_000;

function readIdentity(pid) {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8").trimEnd();
    const close = line.lastIndexOf(") ");
    if (close < 0) return null;
    const fields = line.slice(close + 2).split(/\s+/);
    if (fields.length < 20) return null;
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const startTicks = fields[19];
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 ||
        !Number.isSafeInteger(sessionId) || sessionId <= 0 ||
        !/^[0-9]+$/.test(startTicks)) return null;
    return {
      pid,
      state: fields[0],
      processGroupId,
      sessionId,
      startTicks,
      live: LIVE_STATES.has(fields[0]),
    };
  } catch {
    return null;
  }
}

function normalizeErrorCode(error, fallback) {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

function send(message) {
  if (typeof process.send !== "function" || !process.connected) return false;
  try {
    process.send({
      version: PROTOCOL_VERSION,
      ...message,
      monotonicNs: process.hrtime.bigint().toString(),
    });
    return true;
  } catch {
    return false;
  }
}

function signalOwnGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  return true;
}

function emergencyCleanup(exitCode = SUPERVISOR_ERROR_EXIT) {
  if (emergencyCleanupStarted) return;
  emergencyCleanupStarted = true;
  signalOwnGroup("SIGTERM");
  const timer = setTimeout(() => signalOwnGroup("SIGKILL"), termGraceMs);
  timer.unref?.();
  // Keep the supervisor alive until the escalation timer fires even when the
  // workload already exited and the IPC channel is gone.
  setTimeout(() => process.exit(exitCode), termGraceMs + 1_000);
}

function validString(value) {
  return typeof value === "string" && !value.includes("\0") &&
    Buffer.byteLength(value) <= 16 * 1024;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateLaunch(message) {
  if (!hasExactKeys(message, [
    "version",
    "type",
    "executable",
    "args",
    "cwd",
    "environment",
    "termGraceMs",
    "provenance",
  ]) ||
      message.version !== PROTOCOL_VERSION || message.type !== "launch" ||
      !validString(message.executable) || !message.executable.startsWith("/") ||
      !Array.isArray(message.args) || message.args.length > 4_096 ||
      !message.args.every(validString) ||
      !validString(message.cwd) || !message.cwd.startsWith("/") ||
      message.environment === null || typeof message.environment !== "object" ||
      Array.isArray(message.environment) ||
      Object.keys(message.environment).length > 256 ||
      !Object.entries(message.environment).every(([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && validString(value)) ||
      !Number.isSafeInteger(message.termGraceMs) || message.termGraceMs < 0 ||
      message.termGraceMs > 60_000 || message.provenance === null ||
      typeof message.provenance !== "object" || Array.isArray(message.provenance) ||
      message.provenance.executable?.path !== message.executable ||
      message.provenance.cwd !== message.cwd) {
    return false;
  }
  return true;
}

function launch(message) {
  if (launchReceived || !validateLaunch(message)) {
    send({ type: "fatal", errorCode: "INVALID_LAUNCH_MESSAGE" });
    emergencyCleanup();
    return;
  }
  launchReceived = true;
  termGraceMs = message.termGraceMs;

  try {
    verifyWorkloadLaunchProvenance(message.provenance);
  } catch (error) {
    send({
      type: "workload-launch-error",
      errorCode: normalizeErrorCode(error, "WORKLOAD_PROVENANCE_ERROR"),
    });
    return;
  }

  try {
    workload = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: message.environment,
      detached: false,
      shell: false,
      // Forward the supervisor's inherited descriptors, not its JavaScript
      // Stream wrappers. Pipe-backed process.stdout/process.stderr objects are
      // not portable child stdio handles across Node invocation modes.
      stdio: ["ignore", 1, 2],
      windowsHide: true,
    });
  } catch (error) {
    send({
      type: "workload-launch-error",
      errorCode: normalizeErrorCode(error, "SPAWN_THROW"),
    });
    return;
  }

  workload.once("spawn", () => {
    workloadStarted = true;
    const identity = readIdentity(workload.pid);
    if (identity !== null && identity.processGroupId !== process.pid) {
      send({ type: "fatal", errorCode: "WORKLOAD_GROUP_MISMATCH" });
      emergencyCleanup();
      return;
    }
    send({
      type: "workload-started",
      pid: workload.pid,
      startTicks: identity?.startTicks ?? null,
      identityBound: identity !== null,
    });
  });

  workload.once("error", (error) => {
    if (!workloadStarted) {
      send({
        type: "workload-launch-error",
        errorCode: normalizeErrorCode(error, "SPAWN_ERROR"),
      });
      return;
    }
    send({ type: "fatal", errorCode: normalizeErrorCode(error, "WORKLOAD_ERROR") });
  });

  workload.once("exit", (exitCode, signal) => {
    workloadExited = true;
    send({ type: "workload-exit", exitCode, signal });
  });
}

function shutdown() {
  if (intentionalShutdown) return;
  intentionalShutdown = true;
  if (workloadStarted && !workloadExited) {
    send({ type: "fatal", errorCode: "SHUTDOWN_WITH_LIVE_WORKLOAD" });
    intentionalShutdown = false;
    emergencyCleanup();
    return;
  }
  process.disconnect?.();
  setImmediate(() => process.exit(0));
}

// The supervisor intentionally survives group-directed TERM while the
// workload and its descendants receive it. KILL remains uncatchable.
process.on("SIGTERM", () => {});

process.on("message", (message) => {
  if (message?.type === "launch") launch(message);
  else if (hasExactKeys(message, ["version", "type"]) &&
      message.version === PROTOCOL_VERSION && message.type === "shutdown") shutdown();
  else {
    send({ type: "fatal", errorCode: "UNKNOWN_CONTROL_MESSAGE" });
    emergencyCleanup();
  }
});

process.on("disconnect", () => {
  if (!intentionalShutdown) emergencyCleanup();
});

process.on("uncaughtException", () => {
  send({ type: "fatal", errorCode: "SUPERVISOR_EXCEPTION" });
  emergencyCleanup();
});

process.on("unhandledRejection", () => {
  send({ type: "fatal", errorCode: "SUPERVISOR_REJECTION" });
  emergencyCleanup();
});

const self = readIdentity(process.pid);
if (typeof process.send !== "function" || self === null || !self.live ||
    self.processGroupId !== process.pid || self.sessionId !== process.pid) {
  process.exit(SUPERVISOR_ERROR_EXIT);
}

send({
  type: "supervisor-ready",
  pid: process.pid,
  startTicks: self.startTicks,
  processGroupId: self.processGroupId,
  sessionId: self.sessionId,
});
