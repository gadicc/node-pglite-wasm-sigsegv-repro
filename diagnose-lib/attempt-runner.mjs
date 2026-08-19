import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

import {
  classifyWorkloadAttempt,
  verifyWorkloadProvenance,
  workloadLaunchEnvironment,
  workloadLaunchProvenance,
} from "./workload-spec.mjs";

export const ATTEMPT_RESULT_VERSION = 1;

const SUPERVISOR_PROTOCOL_VERSION = 1;
const ATTEMPT_SUPERVISOR = fileURLToPath(new URL("./attempt-supervisor.mjs", import.meta.url));
const LIVE_STATES = new Set(["R", "S", "D", "T", "t", "I", "W"]);
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MONOTONIC_NS_RE = /^(0|[1-9][0-9]{0,31})$/;
const START_TICKS_RE = /^(0|[1-9][0-9]*)$/;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const DEFAULT_EXCERPT_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 1024 * 1024;
const GROUP_POLL_MS = 10;

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${label} contains unknown field '${unexpected.sort()[0]}'`);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function excerptLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EXCERPT_BYTES) {
    fail(`${label} must be an integer from 0 through ${MAX_EXCERPT_BYTES}`);
  }
  return value;
}

function normalizeErrorCode(error, fallback) {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  return ERROR_CODE_RE.test(candidate) ? candidate : fallback;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function readLinuxProcessIdentity(pid, { strict = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8").trimEnd();
    const close = line.lastIndexOf(") ");
    if (close < 0) {
      if (strict) throw Object.assign(new Error("malformed /proc stat"), {
        code: "PROCESS_IDENTITY_PARSE_ERROR",
      });
      return null;
    }
    const fields = line.slice(close + 2).split(/\s+/);
    if (fields.length < 20) {
      if (strict) throw Object.assign(new Error("short /proc stat"), {
        code: "PROCESS_IDENTITY_PARSE_ERROR",
      });
      return null;
    }
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const startTicks = fields[19];
    if (!Number.isSafeInteger(parentPid) || parentPid < 0 ||
        !Number.isSafeInteger(processGroupId) || processGroupId < 0 ||
        !Number.isSafeInteger(sessionId) || sessionId < 0 ||
        !START_TICKS_RE.test(startTicks)) {
      if (strict) throw Object.assign(new Error("invalid /proc stat fields"), {
        code: "PROCESS_IDENTITY_PARSE_ERROR",
      });
      return null;
    }
    return {
      pid,
      state: fields[0],
      parentPid,
      processGroupId,
      sessionId,
      startTicks,
      live: LIVE_STATES.has(fields[0]),
    };
  } catch (error) {
    if (strict && error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    return null;
  }
}

export function listLiveProcessGroupMembers(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) return [];
  const members = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    const identity = readLinuxProcessIdentity(Number(name), { strict: true });
    if (identity?.live && identity.processGroupId === processGroupId) members.push(identity);
  }
  members.sort((left, right) => left.pid - right.pid);
  return members;
}

function identityMatches(expected, actual) {
  return expected !== null && actual !== null && expected.pid === actual.pid &&
    expected.startTicks === actual.startTicks &&
    expected.processGroupId === actual.processGroupId &&
    expected.sessionId === actual.sessionId;
}

export function selectAttemptDeadlineCandidate({
  workloadStatus,
  executionDeadlineNs,
  launchSent,
  workloadIdentity,
  currentIdentity,
}) {
  if (workloadStatus !== null) {
    if (typeof workloadStatus.observedMonotonicNs === "bigint" &&
        typeof executionDeadlineNs === "bigint" &&
        workloadStatus.observedMonotonicNs <= executionDeadlineNs) {
      return Object.freeze({
        kind: "natural-exit",
        workloadStatus: Object.freeze({
          exitCode: workloadStatus.exitCode,
          signal: workloadStatus.signal,
        }),
      });
    }
    return Object.freeze({ kind: "terminal-race-pending" });
  }
  if (!launchSent || workloadIdentity === null) return Object.freeze({ kind: "launch-timeout" });
  if (identityMatches(workloadIdentity, currentIdentity) && currentIdentity.live) {
    return Object.freeze({ kind: "observation-window-elapsed" });
  }
  return Object.freeze({ kind: "terminal-race-pending" });
}

class OutputAccumulator {
  constructor(stream, limit) {
    this.stream = stream;
    this.limit = limit;
    this.hash = createHash("sha256");
    this.bytes = 0n;
    this.excerpt = [];
    this.excerptBytes = 0;
    this.ended = stream === null;
    this.errorCode = null;
    this.finalized = false;
    this.onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.bytes += BigInt(bytes.length);
      this.hash.update(bytes);
      const available = this.limit - this.excerptBytes;
      if (available > 0) {
        const retained = Buffer.from(bytes.subarray(0, available));
        this.excerpt.push(retained);
        this.excerptBytes += retained.length;
      }
    };
    this.onEnd = () => {
      this.ended = true;
    };
    this.onError = (error) => {
      this.errorCode = normalizeErrorCode(error, "OUTPUT_STREAM_ERROR");
    };
    if (stream !== null) {
      stream.on("data", this.onData);
      stream.once("end", this.onEnd);
      stream.once("error", this.onError);
    }
  }

  get complete() {
    return this.ended && this.errorCode === null;
  }

  finish() {
    if (this.finalized) throw new Error("output accumulator already finalized");
    this.finalized = true;
    if (this.stream !== null) {
      this.stream.off("data", this.onData);
      this.stream.off("end", this.onEnd);
      this.stream.off("error", this.onError);
      if (!this.ended) this.stream.destroy();
    }
    const excerpt = Buffer.concat(this.excerpt, this.excerptBytes);
    return Object.freeze({
      bytes: this.bytes.toString(),
      sha256: this.hash.digest("hex"),
      excerptBase64: excerpt.toString("base64"),
      excerptBytes: excerpt.length,
      truncated: this.bytes > BigInt(excerpt.length),
      complete: this.complete,
      errorCode: this.errorCode,
    });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(deadlineNs, predicate, nowNs) {
  for (;;) {
    if (predicate()) return true;
    const remainingNs = deadlineNs - nowNs();
    if (remainingNs <= 0n) return predicate();
    const remainingMs = Number(remainingNs / 1_000_000n);
    await delay(Math.max(1, Math.min(GROUP_POLL_MS, remainingMs)));
  }
}

function emptyOutput() {
  return Object.freeze({
    bytes: "0",
    sha256: createHash("sha256").digest("hex"),
    excerptBase64: "",
    excerptBytes: 0,
    truncated: false,
    complete: true,
    errorCode: null,
  });
}

function noSignalAction() {
  return {
    attempted: false,
    delivered: false,
    deliveryMode: null,
    errorCode: null,
    monotonicNs: null,
  };
}

function cancelledBeforeLaunch(resolved, nowNs) {
  const now = nowNs().toString();
  const observation = Object.freeze({
    exitCode: null,
    signal: null,
    terminalReason: "external-cancel",
    cleanupComplete: true,
    launchErrorCode: null,
  });
  return deepFreeze({
    version: ATTEMPT_RESULT_VERSION,
    workloadDigest: resolved.digest,
    boundary: {
      attemptStartedMonotonicNs: now,
      workloadStartedMonotonicNs: null,
      terminalChosenMonotonicNs: now,
      cleanupFinishedMonotonicNs: now,
    },
    process: { supervisor: null, workload: null },
    observation,
    outcome: classifyWorkloadAttempt(resolved, observation),
    cleanup: {
      cause: "external-cancel",
      term: noSignalAction(),
      kill: noSignalAction(),
      shutdownRequested: false,
      groupDrained: true,
      outputDrained: true,
      failureReason: null,
      postTerminalStatus: null,
      supervisorStatus: null,
    },
    output: { stdout: emptyOutput(), stderr: emptyOutput() },
  });
}

function validateOptions(options) {
  const value = plainObject(options, "attempt options");
  exactKeys(value, ["signal", "stdoutExcerptBytes", "stderrExcerptBytes"], "attempt options");
  const signal = value.signal;
  if (signal !== undefined &&
      (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
       typeof signal.addEventListener !== "function" ||
       typeof signal.removeEventListener !== "function")) {
    fail("attempt options.signal must be an AbortSignal");
  }
  return {
    signal,
    stdoutExcerptBytes: excerptLimit(
      value.stdoutExcerptBytes ?? DEFAULT_EXCERPT_BYTES,
      "attempt options.stdoutExcerptBytes",
    ),
    stderrExcerptBytes: excerptLimit(
      value.stderrExcerptBytes ?? DEFAULT_EXCERPT_BYTES,
      "attempt options.stderrExcerptBytes",
    ),
  };
}

function createTerminalChoice(nowNs) {
  let choice = null;
  let resolveChoice;
  const promise = new Promise((resolve) => {
    resolveChoice = resolve;
  });
  return {
    get value() {
      return choice;
    },
    promise,
    choose(candidate) {
      if (choice !== null) return false;
      choice = Object.freeze({ ...candidate, chosenNs: nowNs() });
      resolveChoice(choice);
      return true;
    },
  };
}

function parseEventTimestamp(value) {
  return typeof value === "string" && MONOTONIC_NS_RE.test(value) ? BigInt(value) : null;
}

function validExitStatus(exitCode, signal) {
  const exitCodeValid = exitCode === null ||
    (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  const signalValid = signal === null || (typeof signal === "string" && KNOWN_SIGNALS.has(signal));
  return exitCodeValid && signalValid && ((exitCode === null) !== (signal === null));
}

function validMemberIdentity(member, processGroupId) {
  return member !== null && typeof member === "object" &&
    Number.isSafeInteger(member.pid) && member.pid > 1 && member.live === true &&
    member.processGroupId === processGroupId &&
    Number.isSafeInteger(member.sessionId) && member.sessionId > 1 &&
    typeof member.startTicks === "string" && START_TICKS_RE.test(member.startTicks);
}

function signalCleanupTarget({
  expectedSupervisor,
  processGroupId,
  signal,
  probe,
  readIdentity,
  killProcess,
  nowNs,
}) {
  const action = {
    attempted: true,
    delivered: false,
    deliveryMode: null,
    errorCode: null,
    monotonicNs: nowNs().toString(),
  };

  let anchor = null;
  if (expectedSupervisor === null) {
    action.errorCode = "SUPERVISOR_IDENTITY_MISSING";
    return action;
  }
  try {
    anchor = readIdentity(expectedSupervisor.pid);
  } catch (error) {
    action.errorCode = normalizeErrorCode(error, "PROCESS_IDENTITY_ERROR");
    return action;
  }

  if (identityMatches(expectedSupervisor, anchor) && anchor.live) {
    action.deliveryMode = "process-group";
    try {
      killProcess(-processGroupId, signal);
      action.delivered = true;
    } catch (error) {
      if (error?.code !== "ESRCH") action.errorCode = normalizeErrorCode(error, "SIGNAL_ERROR");
    }
    return action;
  }

  if (!probe.known) {
    action.errorCode = "GROUP_STATE_UNKNOWN";
    return action;
  }

  if (probe.members.some((member) => member.sessionId !== expectedSupervisor.sessionId)) {
    action.errorCode = "GROUP_IDENTITY_CHANGED";
    return action;
  }

  action.deliveryMode = "identity-bound-members";
  for (const member of probe.members) {
    let current;
    try {
      current = readIdentity(member.pid);
    } catch (error) {
      action.errorCode ??= normalizeErrorCode(error, "PROCESS_IDENTITY_ERROR");
      continue;
    }
    if (!identityMatches(member, current) || !current.live) {
      action.errorCode ??= "MEMBER_IDENTITY_CHANGED";
      continue;
    }
    try {
      killProcess(member.pid, signal);
      action.delivered = true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        action.errorCode ??= normalizeErrorCode(error, "SIGNAL_ERROR");
      }
    }
  }
  return action;
}

function supervisorCompletionValid({
  supervisor,
  supervisorSpawned,
  supervisorSpawnErrorCode,
  supervisorIdentity,
  supervisorStatus,
  shutdownRequested,
  shutdownSendSettled,
  shutdownError,
  kill,
}) {
  if (supervisor === null) return supervisorSpawnErrorCode !== null;
  if (!supervisorSpawned && supervisorSpawnErrorCode !== null && supervisorIdentity === null) {
    return true;
  }
  if (supervisorStatus === null) return false;
  if (kill.attempted && kill.delivered) {
    return supervisorStatus.exitCode === null && supervisorStatus.signal === "SIGKILL";
  }
  return shutdownRequested && shutdownSendSettled && shutdownError === null &&
    supervisorStatus.exitCode === 0 && supervisorStatus.signal === null;
}

export function createAttemptRunner({
  spawnProcess = spawn,
  readIdentity = readLinuxProcessIdentity,
  listGroupMembers = listLiveProcessGroupMembers,
  killProcess = process.kill.bind(process),
  nowNs = process.hrtime.bigint.bind(process.hrtime),
  supervisorPath = ATTEMPT_SUPERVISOR,
} = {}) {
  if (typeof spawnProcess !== "function" || typeof readIdentity !== "function" ||
      typeof listGroupMembers !== "function" || typeof killProcess !== "function" ||
      typeof nowNs !== "function" || typeof supervisorPath !== "string" ||
      !supervisorPath.startsWith("/")) {
    fail("attempt runner dependencies are invalid");
  }

  return async function runAttempt(resolved, rawOptions = {}) {
    const options = validateOptions(rawOptions);
    const launchEnvironment = workloadLaunchEnvironment(resolved);
    if (options.signal?.aborted) return cancelledBeforeLaunch(resolved, nowNs);

    verifyWorkloadProvenance(resolved);
    const launchProvenance = workloadLaunchProvenance(resolved);

    const attemptStartedNs = nowNs();
    const executionDeadlineNs = attemptStartedNs + BigInt(resolved.attempt.timeoutMs) * 1_000_000n;
    const terminal = createTerminalChoice(nowNs);
    let executionTimer = null;
    let abortListener = null;
    let supervisor = null;
    let supervisorIdentity = null;
    let supervisorStatus = null;
    let supervisorSpawned = false;
    let supervisorSpawnErrorCode = null;
    let supervisorUnexpectedExit = false;
    let supervisorFatalError = null;
    let protocolError = null;
    let identityProbeError = null;
    let protocolState = "awaiting-ready";
    let lastSupervisorEventNs = null;
    let launchSent = false;
    let shutdownRequested = false;
    let shutdownSendSettled = false;
    let shutdownError = null;
    let killExpected = false;
    let workloadIdentity = null;
    let workloadStartedNs = null;
    let workloadStatus = null;
    let stdout = null;
    let stderr = null;

    const chooseLaunchError = (errorCode) => terminal.choose({
      cause: "launch-error",
      terminalReason: "launch-error",
      exitCode: null,
      signal: null,
      launchErrorCode: ERROR_CODE_RE.test(errorCode) ? errorCode : "LAUNCH_ERROR",
    });
    const chooseTerminalRace = () => terminal.choose({
      cause: "terminal-race",
      terminalReason: "terminal-race-unresolved",
      exitCode: null,
      signal: null,
      launchErrorCode: null,
    });
    const chooseNatural = (status) => terminal.choose({
      cause: "natural-exit",
      terminalReason: "natural-exit",
      exitCode: status.exitCode,
      signal: status.signal,
      launchErrorCode: null,
    });
    const protocolViolation = () => {
      protocolError ??= "SUPERVISOR_PROTOCOL_ERROR";
      if (workloadIdentity === null) chooseLaunchError(protocolError);
      else chooseTerminalRace();
    };
    const safeReadIdentity = (pid) => {
      try {
        return readIdentity(pid);
      } catch (error) {
        identityProbeError ??= normalizeErrorCode(error, "PROCESS_IDENTITY_ERROR");
        return null;
      }
    };

    const handleDeadline = async () => {
      if (terminal.value !== null) return;
      const remainingNs = executionDeadlineNs - nowNs();
      if (remainingNs > 0n) {
        executionTimer = setTimeout(
          () => void handleDeadline(),
          Math.max(1, Number(remainingNs / 1_000_000n)),
        );
        return;
      }
      const inspect = () => {
        const current = workloadIdentity?.startTicks == null
          ? null
          : safeReadIdentity(workloadIdentity.pid);
        return selectAttemptDeadlineCandidate({
          workloadStatus,
          executionDeadlineNs,
          launchSent,
          workloadIdentity,
          currentIdentity: current,
        });
      };
      let candidate = inspect();
      if (candidate.kind === "terminal-race-pending") {
        await new Promise((resolve) => setImmediate(resolve));
        if (terminal.value !== null) return;
        candidate = inspect();
      }
      if (candidate.kind === "natural-exit") chooseNatural(candidate.workloadStatus);
      else if (candidate.kind === "launch-timeout") chooseLaunchError("LAUNCH_TIMEOUT");
      else if (candidate.kind === "observation-window-elapsed") {
        terminal.choose({
          cause: "observation-window",
          terminalReason: "observation-window-elapsed",
          exitCode: null,
          signal: null,
          launchErrorCode: null,
        });
      } else chooseTerminalRace();
    };

    const onAbort = () => terminal.choose({
      cause: "external-cancel",
      terminalReason: "external-cancel",
      exitCode: null,
      signal: null,
      launchErrorCode: null,
    });

    try {
      supervisor = spawnProcess(process.execPath, [supervisorPath], {
        cwd: "/",
        env: {},
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      stdout = new OutputAccumulator(supervisor.stdout, options.stdoutExcerptBytes);
      stderr = new OutputAccumulator(supervisor.stderr, options.stderrExcerptBytes);
    } catch (error) {
      supervisorSpawnErrorCode = normalizeErrorCode(error, "SUPERVISOR_SPAWN_THROW");
      chooseLaunchError(supervisorSpawnErrorCode);
    }

    if (supervisor !== null) {
      supervisor.once("spawn", () => {
        supervisorSpawned = true;
        const identity = safeReadIdentity(supervisor.pid);
        if (identity !== null && identity.processGroupId === supervisor.pid &&
            identity.sessionId === supervisor.pid) supervisorIdentity = identity;
      });
      supervisor.once("error", (error) => {
        supervisorSpawnErrorCode = normalizeErrorCode(error, "SUPERVISOR_SPAWN_ERROR");
        chooseLaunchError(supervisorSpawnErrorCode);
      });
      supervisor.on("message", (message) => {
        if (message === null || typeof message !== "object" || Array.isArray(message) ||
            message.version !== SUPERVISOR_PROTOCOL_VERSION || typeof message.type !== "string") {
          protocolViolation();
          return;
        }
        const eventNs = parseEventTimestamp(message.monotonicNs);
        const receivedNs = nowNs();
        if (eventNs === null || eventNs > receivedNs ||
            (lastSupervisorEventNs !== null && eventNs < lastSupervisorEventNs)) {
          protocolViolation();
          return;
        }
        lastSupervisorEventNs = eventNs;

        if (message.type === "supervisor-ready") {
          if (!hasExactKeys(message, [
            "version", "type", "pid", "startTicks", "processGroupId", "sessionId", "monotonicNs",
          ]) || protocolState !== "awaiting-ready" ||
              !Number.isSafeInteger(message.pid) || message.pid <= 1 ||
              typeof message.startTicks !== "string" || !START_TICKS_RE.test(message.startTicks) ||
              message.processGroupId !== message.pid || message.sessionId !== message.pid ||
              message.pid !== supervisor.pid) {
            protocolViolation();
            return;
          }
          const candidate = {
            pid: message.pid,
            state: "S",
            parentPid: process.pid,
            processGroupId: message.processGroupId,
            sessionId: message.sessionId,
            startTicks: message.startTicks,
            live: true,
          };
          const actual = safeReadIdentity(message.pid);
          if (!identityMatches(candidate, actual) || !actual.live ||
              actual.processGroupId !== actual.pid || actual.sessionId !== actual.pid) {
            chooseLaunchError("SUPERVISOR_IDENTITY_ERROR");
            return;
          }
          supervisorIdentity = actual;
          protocolState = "supervisor-ready";
          if (terminal.value !== null || eventNs > executionDeadlineNs || nowNs() >= executionDeadlineNs) {
            chooseLaunchError("LAUNCH_TIMEOUT");
            return;
          }
          launchSent = true;
          protocolState = "launch-sent";
          try {
            supervisor.send({
              version: SUPERVISOR_PROTOCOL_VERSION,
              type: "launch",
              executable: resolved.command.executable.path,
              args: [...resolved.command.args],
              cwd: resolved.command.cwd,
              environment: launchEnvironment,
              termGraceMs: resolved.attempt.termGraceMs,
              provenance: launchProvenance,
            }, (error) => {
              if (error) chooseLaunchError(normalizeErrorCode(error, "SUPERVISOR_SEND_ERROR"));
            });
          } catch (error) {
            chooseLaunchError(normalizeErrorCode(error, "SUPERVISOR_SEND_THROW"));
          }
          return;
        }

        if (message.type === "workload-started") {
          if (!hasExactKeys(message, [
            "version", "type", "pid", "startTicks", "identityBound", "monotonicNs",
          ]) || protocolState !== "launch-sent" ||
              !Number.isSafeInteger(message.pid) || message.pid <= 1 ||
              typeof message.identityBound !== "boolean" ||
              (message.identityBound
                ? typeof message.startTicks !== "string" || !START_TICKS_RE.test(message.startTicks)
                : message.startTicks !== null)) {
            protocolViolation();
            return;
          }
          const actual = safeReadIdentity(message.pid);
          if (actual !== null && (actual.processGroupId !== supervisor.pid ||
              actual.sessionId !== supervisor.pid || !actual.live)) {
            chooseLaunchError("WORKLOAD_IDENTITY_ERROR");
            return;
          }
          const boundStartTicks = message.startTicks ?? actual?.startTicks ?? null;
          workloadIdentity = {
            pid: message.pid,
            state: actual?.state ?? null,
            parentPid: actual?.parentPid ?? supervisor.pid,
            processGroupId: supervisor.pid,
            sessionId: supervisor.pid,
            startTicks: boundStartTicks,
            live: actual?.live ?? false,
          };
          if (message.identityBound && actual !== null && !identityMatches(workloadIdentity, actual)) {
            chooseLaunchError("WORKLOAD_IDENTITY_ERROR");
            return;
          }
          workloadStartedNs = eventNs;
          protocolState = "workload-started";
          if (eventNs > executionDeadlineNs) chooseTerminalRace();
          return;
        }

        if (message.type === "workload-exit") {
          if (!hasExactKeys(message, [
            "version", "type", "exitCode", "signal", "monotonicNs",
          ]) || protocolState !== "workload-started" ||
              !validExitStatus(message.exitCode, message.signal)) {
            protocolViolation();
            return;
          }
          workloadStatus = {
            exitCode: message.exitCode,
            signal: message.signal,
            observedMonotonicNs: eventNs,
          };
          protocolState = "workload-terminal";
          if (eventNs <= executionDeadlineNs) chooseNatural(workloadStatus);
          else chooseTerminalRace();
          return;
        }

        if (message.type === "workload-launch-error") {
          if (!hasExactKeys(message, [
            "version", "type", "errorCode", "monotonicNs",
          ]) || protocolState !== "launch-sent" ||
              typeof message.errorCode !== "string" || !ERROR_CODE_RE.test(message.errorCode)) {
            protocolViolation();
            return;
          }
          protocolState = "workload-terminal";
          chooseLaunchError(eventNs <= executionDeadlineNs ? message.errorCode : "LAUNCH_TIMEOUT");
          return;
        }

        if (message.type === "fatal") {
          if (!hasExactKeys(message, [
            "version", "type", "errorCode", "monotonicNs",
          ]) || supervisorFatalError !== null ||
              typeof message.errorCode !== "string" || !ERROR_CODE_RE.test(message.errorCode)) {
            protocolViolation();
            return;
          }
          supervisorFatalError = message.errorCode;
          if (workloadIdentity === null) chooseLaunchError(message.errorCode);
          else chooseTerminalRace();
          return;
        }

        protocolViolation();
      });
      supervisor.once("exit", (exitCode, signal) => {
        supervisorStatus = { exitCode, signal };
        if (!shutdownRequested && !killExpected) supervisorUnexpectedExit = true;
        if (terminal.value === null) {
          if (workloadStatus !== null &&
              workloadStatus.observedMonotonicNs <= executionDeadlineNs) {
            chooseNatural(workloadStatus);
          } else if (workloadIdentity === null) {
            chooseLaunchError("SUPERVISOR_EXIT");
          } else {
            chooseTerminalRace();
          }
        }
      });
    }

    if (options.signal !== undefined) {
      abortListener = onAbort;
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
    if (terminal.value === null) {
      const remainingNs = executionDeadlineNs - nowNs();
      const initialDelayMs = Math.max(1, Number(remainingNs > 0n ? remainingNs / 1_000_000n : 0n));
      executionTimer = setTimeout(() => void handleDeadline(), initialDelayMs);
    }

    const terminalResult = await terminal.promise;
    if (executionTimer !== null) clearTimeout(executionTimer);
    if (abortListener !== null) options.signal.removeEventListener("abort", abortListener);

    let term = noSignalAction();
    let kill = noSignalAction();
    let groupProbeError = null;
    const processGroupId = supervisorIdentity?.processGroupId ??
      (supervisorSpawned && Number.isSafeInteger(supervisor?.pid) ? supervisor.pid : null);
    const groupProbe = () => {
      if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
        if (supervisor === null || (!supervisorSpawned && supervisorSpawnErrorCode !== null)) {
          return { known: true, members: [], errorCode: null };
        }
        groupProbeError ??= "SUPERVISOR_IDENTITY_MISSING";
        return { known: false, members: [], errorCode: groupProbeError };
      }
      try {
        const members = listGroupMembers(processGroupId);
        if (!Array.isArray(members) ||
            !members.every((member) => validMemberIdentity(member, processGroupId))) {
          throw Object.assign(new Error("invalid process-group probe"), {
            code: "GROUP_PROBE_INVALID",
          });
        }
        return { known: true, members, errorCode: null };
      } catch (error) {
        groupProbeError ??= normalizeErrorCode(error, "GROUP_PROBE_ERROR");
        return { known: false, members: [], errorCode: groupProbeError };
      }
    };
    const residualMembers = (probe) => probe.members.filter((member) => member.pid !== supervisor?.pid);
    const streamsComplete = () => (stdout?.complete ?? true) && (stderr?.complete ?? true);
    const completionObserved = () => supervisor === null || supervisorStatus !== null ||
      (!supervisorSpawned && supervisorSpawnErrorCode !== null);
    const workloadSettledForShutdown = () => protocolState === "awaiting-ready" ||
      protocolState === "supervisor-ready" || protocolState === "workload-terminal";
    const requestShutdown = () => {
      if (supervisor === null || supervisorStatus !== null || shutdownRequested) return;
      shutdownRequested = true;
      if (!supervisor.connected) {
        shutdownSendSettled = true;
        shutdownError = "SHUTDOWN_CHANNEL_CLOSED";
        return;
      }
      try {
        supervisor.send({ version: SUPERVISOR_PROTOCOL_VERSION, type: "shutdown" }, (error) => {
          shutdownSendSettled = true;
          if (error) shutdownError = normalizeErrorCode(error, "SHUTDOWN_SEND_ERROR");
        });
      } catch (error) {
        shutdownSendSettled = true;
        shutdownError = normalizeErrorCode(error, "SHUTDOWN_SEND_THROW");
      }
    };
    const sendSignal = (signal, probe) => signalCleanupTarget({
      expectedSupervisor: supervisorIdentity,
      processGroupId,
      signal,
      probe,
      readIdentity,
      killProcess,
      nowNs,
    });

    let currentProbe = groupProbe();
    let residual = residualMembers(currentProbe);
    if (!currentProbe.known || residual.length > 0) {
      term = sendSignal("SIGTERM", currentProbe);
      const termDeadlineNs = nowNs() + BigInt(resolved.attempt.termGraceMs) * 1_000_000n;
      await waitUntil(termDeadlineNs, () => {
        currentProbe = groupProbe();
        return currentProbe.known && residualMembers(currentProbe).length === 0 &&
          workloadSettledForShutdown();
      }, nowNs);
      currentProbe = groupProbe();
      residual = residualMembers(currentProbe);
    }

    if (!currentProbe.known || residual.length > 0 || !workloadSettledForShutdown()) {
      killExpected = true;
      kill = sendSignal("SIGKILL", currentProbe);
    } else {
      requestShutdown();
    }

    const cleanupDeadlineNs = nowNs() + BigInt(resolved.attempt.killGraceMs) * 1_000_000n;
    await waitUntil(cleanupDeadlineNs, () => {
      currentProbe = groupProbe();
      return currentProbe.known && currentProbe.members.length === 0 &&
        streamsComplete() && completionObserved() &&
        (!shutdownRequested || shutdownSendSettled);
    }, nowNs);

    currentProbe = groupProbe();
    if ((!currentProbe.known || currentProbe.members.length > 0) && !kill.attempted) {
      killExpected = true;
      kill = sendSignal("SIGKILL", currentProbe);
      await new Promise((resolve) => setImmediate(resolve));
      currentProbe = groupProbe();
    } else if (!completionObserved() || (shutdownRequested && !shutdownSendSettled)) {
      await new Promise((resolve) => setImmediate(resolve));
      currentProbe = groupProbe();
    }

    const groupDrained = currentProbe.known && currentProbe.members.length === 0;
    const outputDrained = streamsComplete();
    if (!outputDrained) {
      supervisor?.stdout?.destroy();
      supervisor?.stderr?.destroy();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const stdoutResult = stdout?.finish() ?? emptyOutput();
    const stderrResult = stderr?.finish() ?? emptyOutput();
    const completionValid = supervisorCompletionValid({
      supervisor,
      supervisorSpawned,
      supervisorSpawnErrorCode,
      supervisorIdentity,
      supervisorStatus,
      shutdownRequested,
      shutdownSendSettled,
      shutdownError,
      kill,
    });
    const cleanupFinishedNs = nowNs();
    const cleanupComplete = groupDrained && outputDrained && groupProbeError === null &&
      identityProbeError === null && term.errorCode === null && kill.errorCode === null &&
      shutdownError === null && protocolError === null && supervisorFatalError === null &&
      !supervisorUnexpectedExit && completionValid;
    let failureReason = null;
    if (protocolError !== null) failureReason = protocolError;
    else if (supervisorFatalError !== null) failureReason = supervisorFatalError;
    else if (identityProbeError !== null) failureReason = identityProbeError;
    else if (groupProbeError !== null) failureReason = groupProbeError;
    else if (term.errorCode !== null) failureReason = term.errorCode;
    else if (kill.errorCode !== null) failureReason = kill.errorCode;
    else if (shutdownError !== null) failureReason = shutdownError;
    else if (supervisorUnexpectedExit) failureReason = "SUPERVISOR_UNEXPECTED_EXIT";
    else if (!groupDrained) failureReason = "GROUP_NOT_DRAINED";
    else if (!outputDrained) failureReason = "OUTPUT_NOT_DRAINED";
    else if (!completionValid) failureReason = "SUPERVISOR_COMPLETION_INVALID";

    const observation = Object.freeze({
      exitCode: terminalResult.exitCode,
      signal: terminalResult.signal,
      terminalReason: terminalResult.terminalReason,
      cleanupComplete,
      launchErrorCode: terminalResult.launchErrorCode,
    });
    const postTerminalStatus = terminalResult.cause === "natural-exit" || workloadStatus === null
      ? null
      : { exitCode: workloadStatus.exitCode, signal: workloadStatus.signal };
    const result = deepFreeze({
      version: ATTEMPT_RESULT_VERSION,
      workloadDigest: resolved.digest,
      boundary: {
        attemptStartedMonotonicNs: attemptStartedNs.toString(),
        workloadStartedMonotonicNs: workloadStartedNs?.toString() ?? null,
        terminalChosenMonotonicNs: terminalResult.chosenNs.toString(),
        cleanupFinishedMonotonicNs: cleanupFinishedNs.toString(),
      },
      process: {
        supervisor: supervisorIdentity === null ? null : {
          pid: supervisorIdentity.pid,
          processGroupId: supervisorIdentity.processGroupId,
          sessionId: supervisorIdentity.sessionId,
          startTicks: supervisorIdentity.startTicks,
        },
        workload: workloadIdentity === null ? null : {
          pid: workloadIdentity.pid,
          startTicks: workloadIdentity.startTicks,
        },
      },
      observation,
      outcome: classifyWorkloadAttempt(resolved, observation),
      cleanup: {
        cause: terminalResult.cause,
        term,
        kill,
        shutdownRequested,
        groupDrained,
        outputDrained,
        failureReason,
        postTerminalStatus,
        supervisorStatus,
      },
      output: { stdout: stdoutResult, stderr: stderrResult },
    });

    supervisor?.removeAllListeners("message");
    if (supervisor?.connected) supervisor.disconnect();
    return result;
  };
}

export const runWorkloadAttempt = createAttemptRunner();
