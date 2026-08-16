import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

export const PINNED_RUNNER_VERSION = 1;
export const PINNED_RUNNER_V2_VERSION = 2;
export const MAX_CPU_ID = 65_535;
export const MAX_COUNT = 1_000_000;
export const MAX_SCHEDULE_ENTRIES = 1_000_000;
export const MAX_SEED = 0xffff_ffff;
export const DEFAULT_STDERR_BYTES = 16 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;
export const DEFAULT_CANCEL_GRACE_MS = 1_000;
export const MAX_CANCEL_GRACE_MS = 60_000;
export const DEFAULT_NO_TURBO_PATH = "/sys/devices/system/cpu/intel_pstate/no_turbo";

const UINT32_RANGE = 0x1_0000_0000;
const DOMAIN_ISOLATED = 0x4953_4f4c;
const DOMAIN_GROUPS = 0x4752_4f55;
const DOMAIN_CONCURRENT = 0x434f_4e43;
const MAX_ERROR_TEXT = 4_096;
const MAX_LAUNCH_PROTOCOL_BYTES = 64 * 1024;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const PINNED_LAUNCH_WORKER = fileURLToPath(new URL("./pinned-launch-worker.mjs", import.meta.url));

const SYSTEM_CLOCK = Object.freeze({
  epochMilliseconds: () => Date.now(),
  monotonicNanoseconds: () => process.hrtime.bigint(),
});

function validateInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validateCpu(cpu, label = "CPU") {
  return validateInteger(cpu, label, 0, MAX_CPU_ID);
}

function validateCount(count, label) {
  return validateInteger(count, label, 1, MAX_COUNT);
}

function validateSeed(seed) {
  return validateInteger(seed, "seed", 0, MAX_SEED);
}

function validateString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new TypeError(`${label} must be a ${allowEmpty ? "NUL-free" : "non-empty NUL-free"} string`);
  }
  return value;
}

function validateCpuArray(cpus, label = "CPUs") {
  if (!Array.isArray(cpus) || cpus.length === 0 || cpus.length > MAX_CPU_ID + 1) {
    throw new TypeError(`${label} must be a non-empty CPU array with at most ${MAX_CPU_ID + 1} entries`);
  }
  const copy = cpus.map((cpu, index) => validateCpu(cpu, `${label}[${index}]`));
  if (new Set(copy).size !== copy.length) throw new TypeError(`${label} contains a duplicate CPU`);
  return copy;
}

function validateScheduleSize(itemCount, roundCount) {
  if (itemCount * roundCount > MAX_SCHEDULE_ENTRIES) {
    throw new RangeError(`schedule exceeds the ${MAX_SCHEDULE_ENTRIES}-entry limit`);
  }
}

function createUint32Rng(seed, domain) {
  let state = (seed ^ domain) >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

// Rejection sampling avoids modulo bias while keeping the schedule stable
// across supported Node versions.
function randomBelow(nextUint32, upperExclusive) {
  const acceptedRange = Math.floor(UINT32_RANGE / upperExclusive) * upperExclusive;
  let value;
  do value = nextUint32(); while (value >= acceptedRange);
  return value % upperExclusive;
}

function shuffle(values, nextUint32) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomBelow(nextUint32, index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function buildCyclicOrders(items, roundCount, seed, domain) {
  validateCount(roundCount, "round count");
  validateSeed(seed);
  validateScheduleSize(items.length, roundCount);

  const nextUint32 = createUint32Rng(seed, domain);
  const orders = [];
  for (let blockStart = 0; blockStart < roundCount; blockStart += items.length) {
    const base = shuffle(items, nextUint32);
    const firstOffset = randomBelow(nextUint32, items.length);
    const direction = (nextUint32() & 1) === 0 ? 1 : -1;
    const blockLength = Math.min(items.length, roundCount - blockStart);
    for (let blockRound = 0; blockRound < blockLength; blockRound += 1) {
      const offset = (firstOffset + direction * blockRound + items.length) % items.length;
      orders.push(Array.from(
        { length: items.length },
        (_, position) => base[(offset + position) % items.length],
      ));
    }
  }
  return orders;
}

export function expandCpuList(spec) {
  validateString(spec, "CPU list");
  if (spec.length > MAX_COUNT) throw new RangeError(`CPU list exceeds ${MAX_COUNT} characters`);

  const cpus = [];
  const seen = new Set();
  for (const token of spec.split(",")) {
    const range = token.match(/^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/);
    let first;
    let last;
    if (range) {
      first = validateCpu(Number(range[1]));
      last = validateCpu(Number(range[2]));
      if (last < first) throw new TypeError(`descending CPU range: ${token}`);
    } else if (/^(0|[1-9][0-9]*)$/.test(token)) {
      first = validateCpu(Number(token));
      last = first;
    } else {
      throw new TypeError(`invalid CPU token: ${token}`);
    }

    for (let cpu = first; cpu <= last; cpu += 1) {
      if (seen.has(cpu)) throw new TypeError(`duplicate CPU: ${cpu}`);
      seen.add(cpu);
      cpus.push(cpu);
    }
  }
  return validateCpuArray(cpus);
}

export function compressCpuList(cpus) {
  const values = validateCpuArray(cpus);
  const tokens = [];
  for (let first = 0; first < values.length;) {
    let last = first;
    while (last + 1 < values.length && values[last + 1] === values[last] + 1) last += 1;
    tokens.push(last === first ? String(values[first]) : `${values[first]}-${values[last]}`);
    first = last + 1;
  }
  return tokens.join(",");
}

// Every CPU appears exactly once per round. Within each randomized block of N
// rounds, cyclic rotation puts every CPU in every position exactly once. A
// partial final block adds at most one visit to any CPU/position pair.
export function buildIsolatedOrders(cpus, roundCount, seed) {
  return buildCyclicOrders(validateCpuArray(cpus), roundCount, seed, DOMAIN_ISOLATED);
}

// Group schedules use stable zero-based group indices. Keeping topology data
// outside this primitive makes the resulting plan straightforward to persist
// and digest without relying on object identity.
export function buildBalancedGroupOrders(groupCount, roundCount, seed) {
  validateCount(groupCount, "group count");
  validateCount(roundCount, "round count");
  validateSeed(seed);
  validateScheduleSize(groupCount, roundCount);
  return buildCyclicOrders(
    Array.from({ length: groupCount }, (_, index) => index),
    roundCount,
    seed,
    DOMAIN_GROUPS,
  );
}

// Promise.all still invokes launch functions in array order. This separately
// balanced order prevents a CPU from always occupying an early/late launch
// slot even though the children then execute concurrently.
export function buildConcurrentLaunchOrders(cpus, roundCount, seed) {
  return buildCyclicOrders(validateCpuArray(cpus), roundCount, seed, DOMAIN_CONCURRENT);
}

function validateCpuOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new TypeError("orders must be a non-empty array of rounds");
  }
  validateCount(orders.length, "order round count");
  const first = validateCpuArray(orders[0], "orders[0]");
  validateScheduleSize(first.length, orders.length);
  const expected = [...first].sort((left, right) => left - right).join(",");
  return orders.map((order, index) => {
    const copy = validateCpuArray(order, `orders[${index}]`);
    if (copy.length !== first.length || [...copy].sort((left, right) => left - right).join(",") !== expected) {
      throw new TypeError("every CPU order must contain the same CPU set exactly once");
    }
    return copy;
  });
}

export function flattenCpuOrders(orders) {
  return validateCpuOrders(orders).flatMap((order, round) => order.map((cpu, position) => ({
    round: round + 1,
    position: position + 1,
    cpu,
  })));
}

export function flattenGroupOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new TypeError("orders must be a non-empty array of rounds");
  }
  validateCount(orders.length, "order round count");
  if (!Array.isArray(orders[0]) || orders[0].length === 0) {
    throw new TypeError("group orders must contain at least one group");
  }
  const groupCount = orders[0].length;
  validateCount(groupCount, "group count");
  validateScheduleSize(groupCount, orders.length);
  const expected = Array.from({ length: groupCount }, (_, index) => index).join(",");
  const validated = orders.map((order, round) => {
    if (!Array.isArray(order) || order.length !== groupCount) {
      throw new TypeError(`orders[${round}] has the wrong group count`);
    }
    const copy = order.map((groupIndex, position) => validateInteger(
      groupIndex,
      `orders[${round}][${position}]`,
      0,
      groupCount - 1,
    ));
    if ([...copy].sort((left, right) => left - right).join(",") !== expected) {
      throw new TypeError("every group order must contain each group index exactly once");
    }
    return copy;
  });
  return validated.flatMap((order, round) => order.map((groupIndex, position) => ({
    round: round + 1,
    position: position + 1,
    groupIndex,
  })));
}

function errorCode(error, fallback) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : fallback;
  return code.slice(0, 64);
}

// This is intentionally a direct read on every call. Callers can therefore
// record phase/run boundaries without inheriting a stale cached observation.
export function readNoTurbo(noTurboPath = DEFAULT_NO_TURBO_PATH) {
  validateString(noTurboPath, "no_turbo path");
  try {
    const raw = readFileSync(noTurboPath, "utf8").trim();
    if (raw === "0" || raw === "1") {
      return { status: "observed", value: Number(raw), errorCode: null };
    }
    return { status: "invalid", value: null, errorCode: "UNEXPECTED_VALUE" };
  } catch (error) {
    return { status: "unavailable", value: null, errorCode: errorCode(error, "READ_ERROR") };
  }
}

function normalizeNoTurboObservation(observation) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    return { status: "unavailable", value: null, errorCode: "INVALID_READER_RESULT" };
  }
  if (observation.status === "observed" && (observation.value === 0 || observation.value === 1)) {
    return { status: "observed", value: observation.value, errorCode: null };
  }
  if (observation.status === "invalid" && observation.value === null) {
    return { status: "invalid", value: null, errorCode: errorCode({ code: observation.errorCode }, "UNEXPECTED_VALUE") };
  }
  if (observation.status === "unavailable" && observation.value === null) {
    return { status: "unavailable", value: null, errorCode: errorCode({ code: observation.errorCode }, "READ_ERROR") };
  }
  return { status: "unavailable", value: null, errorCode: "INVALID_READER_RESULT" };
}

function observeNoTurbo(reader, noTurboPath) {
  try {
    return normalizeNoTurboObservation(reader(noTurboPath));
  } catch (error) {
    return { status: "unavailable", value: null, errorCode: errorCode(error, "READER_ERROR") };
  }
}

export function classifyChildOutcome({ exitCode, signal, launchError = null, canceled = false }) {
  if (canceled) return { outcome: "invalid", validOutcome: false, invalidReason: "canceled" };
  if (launchError !== null) return { outcome: "invalid", validOutcome: false, invalidReason: "launch-error" };
  if (signal === null && exitCode === 0) {
    return { outcome: "pass", validOutcome: true, invalidReason: null };
  }
  if ((signal === "SIGSEGV" && exitCode === null) || (signal === null && exitCode === 139)) {
    return { outcome: "sigsegv", validOutcome: true, invalidReason: null };
  }
  if (signal !== null) return { outcome: "invalid", validOutcome: false, invalidReason: "unexpected-signal" };
  if (Number.isInteger(exitCode)) return { outcome: "invalid", validOutcome: false, invalidReason: "unexpected-exit" };
  return { outcome: "invalid", validOutcome: false, invalidReason: "missing-exit-status" };
}

export function classifyIndividualChildOutcomeV2({
  exitCode,
  signal,
  launchError = null,
  canceled = false,
  secureLaunch = false,
}) {
  if (canceled) {
    return { outcome: "operational-invalid", validOutcome: false, invalidReason: "canceled" };
  }
  if (launchError !== null || secureLaunch !== true) {
    return {
      outcome: "operational-invalid",
      validOutcome: false,
      invalidReason: launchError !== null ? "launch-error" : "unverified-launch",
    };
  }
  const canonicalCode = exitCode === null ||
    (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255);
  const canonicalSignal = signal === null ||
    (typeof signal === "string" && KNOWN_SIGNALS.has(signal));
  if (!canonicalCode || !canonicalSignal || (exitCode !== null && signal !== null) ||
      (exitCode === null && signal === null)) {
    return { outcome: "operational-invalid", validOutcome: false, invalidReason: "malformed-exit-status" };
  }
  if (exitCode === 0 && signal === null) {
    return { outcome: "pass", validOutcome: true, invalidReason: null };
  }
  // The V2 worker launches the workload directly, so Node preserves a fatal
  // signal as `signal` with a null exit code. A literal exit(139) is exact
  // nonzero-exit evidence, not proof of SIGSEGV.
  if (exitCode === null && signal === "SIGSEGV") {
    return { outcome: "sigsegv", validOutcome: true, invalidReason: null };
  }
  return { outcome: "other-workload-failure", validOutcome: true, invalidReason: null };
}

function signalDirectChild(child, signal, killProcess) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  try {
    killProcess(child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

export function defaultPinnedLauncher({
  cpu,
  command,
  args,
  cwd,
  env,
  tasksetPath = "taskset",
  shellPath = "/bin/bash",
}, {
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
} = {}) {
  if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess must be a function");
  if (typeof killProcess !== "function") throw new TypeError("killProcess must be a function");
  // Positional "$@" expansion avoids shell interpolation of caller values.
  // The shell is used only to disable core files before exec'ing taskset.
  const child = spawnProcess(shellPath, [
    "-c",
    "ulimit -c 0; exec \"$@\"",
    "pinned-runner",
    tasksetPath,
    "-c",
    String(cpu),
    command,
    ...args,
  ], {
    cwd,
    env,
    // Stay in the outer diagnose.sh supervisor group. If that supervisor is
    // interrupted it can terminate this runner and every pinned descendant;
    // local AbortSignal cancellation below still targets only our direct
    // child and can never signal the supervisor's entire process group.
    detached: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  return {
    child,
    cancel(signal) {
      return signalDirectChild(child, signal, killProcess);
    },
  };
}

export function defaultPinnedLauncherV2({
  cpu,
  witnessCpu,
  command,
  args,
  cwd,
  env,
  stderrBytes,
  tasksetPath = "taskset",
  shellPath = "/bin/bash",
}, {
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
} = {}) {
  if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess must be a function");
  if (typeof killProcess !== "function") throw new TypeError("killProcess must be a function");
  const workerArguments = witnessCpu === undefined
    ? [String(cpu), String(stderrBytes), command, ...args]
    : [
      "--controller",
      String(witnessCpu),
      String(cpu),
      String(stderrBytes),
      tasksetPath,
      shellPath,
      command,
      ...args,
    ];
  const child = spawnProcess(shellPath, [
    "-c",
    "ulimit -c 0; exec \"$@\"",
    "pinned-runner-v2",
    tasksetPath,
    "-c",
    String(witnessCpu ?? cpu),
    process.execPath,
    PINNED_LAUNCH_WORKER,
    ...workerArguments,
  ], {
    cwd,
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    child,
    launchProtocol: child.stdout,
    cancel(signal) {
      return signalDirectChild(child, signal, killProcess);
    },
  };
}

function validateClock(clock) {
  if (clock === null || typeof clock !== "object" ||
      typeof clock.epochMilliseconds !== "function" ||
      typeof clock.monotonicNanoseconds !== "function") {
    throw new TypeError("clock must provide epochMilliseconds() and monotonicNanoseconds()");
  }
  return clock;
}

function readEpochMilliseconds(clock) {
  return validateInteger(clock.epochMilliseconds(), "clock epoch milliseconds", 0, Number.MAX_SAFE_INTEGER);
}

function readMonotonicNanoseconds(clock) {
  const value = clock.monotonicNanoseconds();
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("clock monotonic nanoseconds must be a non-negative bigint");
  }
  return value;
}

function launchErrorRecord(error) {
  if (error === null) return null;
  const message = typeof error?.message === "string" ? error.message : String(error);
  return {
    code: errorCode(error, "LAUNCH_ERROR"),
    message: message.slice(0, MAX_ERROR_TEXT),
  };
}

function validateRunOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("runPinnedChild options must be an object");
  }
  const cpu = validateCpu(options.cpu);
  const command = validateString(options.command, "command");
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_COUNT) {
    throw new TypeError(`args must be an array with at most ${MAX_COUNT} entries`);
  }
  const validatedArgs = args.map((arg, index) => validateString(arg, `args[${index}]`, { allowEmpty: true }));
  const stderrBytes = validateInteger(
    options.stderrBytes ?? DEFAULT_STDERR_BYTES,
    "stderr byte limit",
    0,
    MAX_STDERR_BYTES,
  );
  const cancelGraceMs = validateInteger(
    options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    "cancel grace milliseconds",
    0,
    MAX_CANCEL_GRACE_MS,
  );
  const noTurboPath = validateString(options.noTurboPath ?? DEFAULT_NO_TURBO_PATH, "no_turbo path");
  const runnerVersion = validateInteger(
    options.runnerVersion ?? PINNED_RUNNER_VERSION,
    "runner version",
    PINNED_RUNNER_VERSION,
    PINNED_RUNNER_V2_VERSION,
  );
  const witnessCpu = options.witnessCpu === undefined
    ? undefined
    : validateCpu(options.witnessCpu, "witness CPU");
  if (witnessCpu !== undefined && witnessCpu === cpu) {
    throw new TypeError("witness CPU must differ from the workload CPU");
  }
  if (witnessCpu !== undefined && runnerVersion !== PINNED_RUNNER_V2_VERSION) {
    throw new TypeError("witness CPU is supported only by runner V2");
  }
  const launcher = options.launcher === undefined
    ? (runnerVersion === PINNED_RUNNER_V2_VERSION ? defaultPinnedLauncherV2 : defaultPinnedLauncher)
    : options.launcher;
  if (typeof launcher !== "function") throw new TypeError("launcher must be a function");
  const noTurboReader = options.noTurboReader === undefined ? readNoTurbo : options.noTurboReader;
  if (typeof noTurboReader !== "function") throw new TypeError("noTurboReader must be a function");
  const clock = validateClock(options.clock === undefined ? SYSTEM_CLOCK : options.clock);
  if (options.signal !== undefined &&
      (options.signal === null || typeof options.signal !== "object" ||
       typeof options.signal.addEventListener !== "function" ||
       typeof options.signal.removeEventListener !== "function" ||
       typeof options.signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  if (options.cwd !== undefined) validateString(options.cwd, "cwd");
  if (options.tasksetPath !== undefined) validateString(options.tasksetPath, "taskset path");
  if (options.shellPath !== undefined) validateString(options.shellPath, "shell path");
  return {
    cpu,
    command,
    args: validatedArgs,
    cwd: options.cwd,
    env: options.env,
    stderrBytes,
    cancelGraceMs,
    noTurboPath,
    launcher,
    noTurboReader,
    clock,
    signal: options.signal,
    tasksetPath: options.tasksetPath,
    shellPath: options.shellPath,
    runnerVersion,
    witnessCpu,
  };
}

function normalizeLaunchDescriptor(descriptor, runnerVersion) {
  if (descriptor === null || typeof descriptor !== "object" ||
      descriptor.child === null || typeof descriptor.child !== "object" ||
      typeof descriptor.child.once !== "function" ||
      typeof descriptor.cancel !== "function") {
    throw new TypeError("launcher must return { child, cancel(signal) }");
  }
  if (runnerVersion === PINNED_RUNNER_V2_VERSION && descriptor.secureLaunch !== true &&
      (descriptor.launchProtocol === null || typeof descriptor.launchProtocol?.on !== "function")) {
    throw new TypeError("V2 launcher must provide a launch protocol stream or secureLaunch=true");
  }
  return descriptor;
}

function normalizeWorkerStderr(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.bytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.bytes) ||
      typeof value.excerptBase64 !== "string" ||
      !Number.isSafeInteger(value.excerptBytes) || value.excerptBytes < 0 ||
      typeof value.truncated !== "boolean") return null;
  let excerpt;
  try {
    excerpt = Buffer.from(value.excerptBase64, "base64");
  } catch {
    return null;
  }
  if (excerpt.toString("base64") !== value.excerptBase64 || excerpt.length !== value.excerptBytes ||
      excerpt.length > MAX_STDERR_BYTES || BigInt(value.bytes) < BigInt(excerpt.length) ||
      value.truncated !== (BigInt(value.bytes) > BigInt(excerpt.length)) ||
      (!value.truncated && createHash("sha256").update(excerpt).digest("hex") !== value.sha256)) {
    return null;
  }
  return {
    sha256: value.sha256,
    bytes: value.bytes,
    excerptBase64: value.excerptBase64,
    excerptBytes: value.excerptBytes,
    truncated: value.truncated,
  };
}

function parseLaunchProtocol(bytes, cpu) {
  if (bytes.length === 0 || bytes.length > MAX_LAUNCH_PROTOCOL_BYTES || bytes.at(-1) !== 0x0a) return null;
  let value;
  try {
    value = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
  } catch {
    return null;
  }
  const keys = [
    "version", "cpu", "launchState", "exitCode", "signal", "canceled", "launchError", "stderr",
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== keys.sort().join("\n") || value.version !== 1 ||
      value.cpu !== cpu || !["launched", "launch-failure", "affinity-failure"].includes(value.launchState) ||
      (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) ||
      (value.signal !== null && (typeof value.signal !== "string" || !KNOWN_SIGNALS.has(value.signal))) ||
      typeof value.canceled !== "boolean") return null;
  const launchError = value.launchError === null
    ? null
    : launchErrorRecord(value.launchError);
  if ((value.launchState === "launched") !== (launchError === null) ||
      (value.launchState !== "launched" && (value.exitCode !== null || value.signal !== null)) ||
      (value.exitCode !== null && value.signal !== null)) return null;
  const stderr = normalizeWorkerStderr(value.stderr);
  if (stderr === null) return null;
  return { ...value, launchError, stderr };
}

function buildTiming(startEpochMs, startMonotonicNs, endEpochMs, endMonotonicNs) {
  if (endMonotonicNs < startMonotonicNs) {
    throw new Error("monotonic clock moved backwards");
  }
  const durationNs = endMonotonicNs - startMonotonicNs;
  return {
    startEpochMs,
    endEpochMs,
    startMonotonicNs: startMonotonicNs.toString(),
    endMonotonicNs: endMonotonicNs.toString(),
    durationNs: durationNs.toString(),
    durationMs: Number(durationNs) / 1_000_000,
    elapsedSec: Number(durationNs / 1_000_000_000n),
  };
}

export async function runPinnedChild(options) {
  const config = validateRunOptions(options);
  const noTurboStart = observeNoTurbo(config.noTurboReader, config.noTurboPath);
  const startEpochMs = readEpochMilliseconds(config.clock);
  const startMonotonicNs = readMonotonicNanoseconds(config.clock);

  let descriptor = null;
  let child = null;
  let canceled = config.signal?.aborted ?? false;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let launchError = null;
  let stderrBytesSeen = 0;
  let stderrTruncated = false;
  const stderrChunks = [];
  let forceKillTimer = null;
  let endEpochMs = null;
  let endMonotonicNs = null;
  let noTurboEnd = null;
  let boundaryError = null;
  let secureLaunch = false;
  let launchProtocol = null;
  let launchProtocolOverflow = false;
  const launchProtocolChunks = [];
  let launchProtocolBytes = 0;
  const stderrHash = createHash("sha256");
  let stderrTotalBytes = 0n;

  const captureEndBoundary = () => {
    if (endMonotonicNs !== null || boundaryError !== null) return;
    try {
      endMonotonicNs = readMonotonicNanoseconds(config.clock);
      endEpochMs = readEpochMilliseconds(config.clock);
      noTurboEnd = observeNoTurbo(config.noTurboReader, config.noTurboPath);
    } catch (error) {
      boundaryError = error;
    }
  };

  const cancelChild = () => {
    if (exited) return;
    if (canceled && child === null) return;
    canceled = true;
    if (descriptor === null || exited) return;
    try {
      descriptor.cancel("SIGTERM");
    } catch {
      // A cancellation failure is reflected by the eventual child status. The
      // SIGKILL attempt below remains armed while the child is still active.
    }
    if (!exited) {
      forceKillTimer = setTimeout(() => {
        if (!exited) {
          try { descriptor.cancel("SIGKILL"); } catch { /* already gone */ }
        }
      }, config.cancelGraceMs);
      forceKillTimer.unref?.();
    }
  };

  if (config.signal !== undefined) config.signal.addEventListener("abort", cancelChild, { once: true });

  const finalize = () => {
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    if (config.signal !== undefined) config.signal.removeEventListener("abort", cancelChild);
    captureEndBoundary();
    if (boundaryError !== null) throw boundaryError;
    const timing = buildTiming(startEpochMs, startMonotonicNs, endEpochMs, endMonotonicNs);
    let error = launchErrorRecord(launchError);
    let stderrEvidence = {
      sha256: stderrHash.digest("hex"),
      bytes: stderrTotalBytes.toString(),
      excerptBase64: Buffer.concat(stderrChunks).toString("base64"),
      excerptBytes: stderrBytesSeen,
      truncated: stderrTruncated,
    };
    if (config.runnerVersion === PINNED_RUNNER_V2_VERSION && descriptor?.launchProtocol !== undefined) {
      const parsed = launchProtocolOverflow
        ? null
        : parseLaunchProtocol(Buffer.concat(launchProtocolChunks, launchProtocolBytes), config.cpu);
      if (parsed === null) {
        error ??= { code: "INVALID_LAUNCH_PROTOCOL", message: "secure launcher result was missing or malformed" };
      } else {
        launchProtocol = parsed;
        secureLaunch = parsed.launchState === "launched";
        exitCode = parsed.exitCode;
        exitSignal = parsed.signal;
        canceled ||= parsed.canceled;
        error = parsed.launchError;
        stderrEvidence = parsed.stderr;
      }
    } else if (config.runnerVersion === PINNED_RUNNER_V2_VERSION) {
      secureLaunch = descriptor?.secureLaunch === true;
    }
    let classification = config.runnerVersion === PINNED_RUNNER_V2_VERSION
      ? classifyIndividualChildOutcomeV2({
        exitCode,
        signal: exitSignal,
        launchError: error,
        canceled,
        secureLaunch,
      })
      : classifyChildOutcome({ exitCode, signal: exitSignal, launchError: error, canceled });
    if (config.runnerVersion === PINNED_RUNNER_V2_VERSION &&
        (noTurboStart.status !== "observed" || noTurboEnd.status !== "observed")) {
      classification = {
        outcome: "operational-invalid",
        validOutcome: false,
        invalidReason: "unsafe-boundary",
      };
    }
    const result = {
      version: config.runnerVersion,
      cpu: config.cpu,
      timing,
      noTurbo: {
        path: config.noTurboPath,
        start: noTurboStart,
        end: noTurboEnd,
      },
      exitCode,
      signal: exitSignal,
      ...classification,
      canceled,
      launchError: error,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stderrTruncated,
    };
    if (config.runnerVersion === PINNED_RUNNER_V2_VERSION) {
      result.launchState = launchProtocol?.launchState ?? (secureLaunch ? "launched" : "unverified");
      result.stderrEvidence = stderrEvidence;
    }
    return result;
  };

  if (canceled) return finalize();

  try {
    descriptor = normalizeLaunchDescriptor(config.launcher({
      cpu: config.cpu,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      tasksetPath: config.tasksetPath,
      shellPath: config.shellPath,
      ...(config.runnerVersion === PINNED_RUNNER_V2_VERSION
        ? { stderrBytes: config.stderrBytes, witnessCpu: config.witnessCpu }
        : {}),
    }), config.runnerVersion);
    child = descriptor.child;
  } catch (error) {
    launchError = error;
    return finalize();
  }

  if (child.stderr !== null && child.stderr !== undefined && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrHash.update(bytes);
      stderrTotalBytes += BigInt(bytes.length);
      const remaining = config.stderrBytes - stderrBytesSeen;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        stderrChunks.push(retained);
        stderrBytesSeen += retained.length;
      }
      if (bytes.length > Math.max(remaining, 0)) stderrTruncated = true;
    });
    // Continue draining even when the retained evidence reaches its cap.
    child.stderr.resume?.();
  }

  if (descriptor.launchProtocol !== undefined) {
    descriptor.launchProtocol.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (launchProtocolOverflow) return;
      if (launchProtocolBytes + bytes.length > MAX_LAUNCH_PROTOCOL_BYTES) {
        launchProtocolOverflow = true;
        launchProtocolChunks.length = 0;
        return;
      }
      launchProtocolChunks.push(bytes);
      launchProtocolBytes += bytes.length;
    });
    descriptor.launchProtocol.resume?.();
  }

  return await new Promise((resolve, reject) => {
    child.once("error", (error) => { launchError = error; });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = Number.isInteger(code) ? code : null;
      exitSignal = typeof signal === "string" ? signal : null;
      captureEndBoundary();
    });
    child.once("close", (code, signal) => {
      exited = true;
      if (endMonotonicNs === null) {
        exitCode = Number.isInteger(code) ? code : null;
        exitSignal = typeof signal === "string" ? signal : null;
      }
      try {
        resolve(finalize());
      } catch (error) {
        reject(error);
      }
    });
    if (config.signal?.aborted) cancelChild();
  });
}
