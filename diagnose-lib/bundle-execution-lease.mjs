import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

export const BUNDLE_EXECUTION_LEASE_VERSION = 1;
export const BUNDLE_EXECUTION_LEASE_BUSY_EXIT = 75;

const MAX_WAIT_MS = 30_000;
const FLOCK_COMPLETION_GRACE_MS = 5_000;
const MAX_FLOCK_STDERR_BYTES = 64 * 1024;
const START_TICKS_RE = /^(0|[1-9][0-9]*)$/;
const LEASES = new WeakMap();

export class BundleExecutionLeaseError extends Error {
  constructor(message, code = "INVALID_BUNDLE_EXECUTION_LEASE") {
    super(message);
    this.name = "BundleExecutionLeaseError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new BundleExecutionLeaseError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function boundedAbsolutePath(value, label) {
  requireCondition(typeof value === "string" && path.isAbsolute(value) &&
    !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024,
  `${label} must be a bounded absolute NUL-free path`);
  return path.normalize(value);
}

function currentStartTicks() {
  try {
    const line = readFileSync(`/proc/${process.pid}/stat`, "utf8").trimEnd();
    const close = line.lastIndexOf(") ");
    if (close < 0) return null;
    const fields = line.slice(close + 2).split(/\s+/);
    return fields.length >= 20 && START_TICKS_RE.test(fields[19]) ? fields[19] : null;
  } catch {
    return null;
  }
}

function stableDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev &&
    left.ino === right.ino && left.uid === right.uid;
}

function validatePrivateDirectoryStat(stat, label) {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  requireCondition(stat.isDirectory() && (uid === null || stat.uid === uid) &&
    (stat.mode & 0o077n) === 0n,
  `${label} must be a real private directory owned by the current user`);
}

function inspectPrivateDirectory(directory) {
  const normalized = boundedAbsolutePath(directory, "bundle directory");
  let canonical;
  let before;
  try {
    canonical = realpathSync(normalized);
    before = lstatSync(normalized, { bigint: true });
  } catch {
    fail("bundle directory is missing or could not be inspected");
  }
  requireCondition(canonical === normalized,
    "bundle directory must use its canonical path without symbolic links");
  validatePrivateDirectoryStat(before, "bundle directory");
  return { directory: canonical, stat: before };
}

function resolveFlockExecutable(value) {
  const requested = boundedAbsolutePath(value, "flock path");
  let resolved;
  let stat;
  try {
    resolved = realpathSync(requested);
    stat = statSync(resolved, { bigint: true });
  } catch {
    fail("flock executable is missing or could not be inspected",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }
  requireCondition(stat.isFile() && (stat.mode & 0o111n) !== 0n,
    "flock path must resolve to an executable regular file",
    "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  return resolved;
}

function validateOptions(options) {
  const value = options ?? {};
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  "bundle execution lease options must be a plain object");
  const allowed = new Set(["bundleDir", "flockPath", "waitMs"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `bundle execution lease options contain unknown field '${unknown.sort()[0]}'`);
  requireCondition(Number.isSafeInteger(value.waitMs ?? 0) && (value.waitMs ?? 0) >= 0 &&
    (value.waitMs ?? 0) <= MAX_WAIT_MS,
  `bundle execution lease waitMs must be an integer from 0 through ${MAX_WAIT_MS}`);
  return {
    bundleDir: value.bundleDir,
    flockPath: value.flockPath ?? "/usr/bin/flock",
    waitMs: value.waitMs ?? 0,
  };
}

function appendBounded(state, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const available = MAX_FLOCK_STDERR_BYTES - state.bytes;
  if (available > 0) {
    state.bytes += Math.min(bytes.length, available);
  }
  if (bytes.length > Math.max(0, available)) state.overflow = true;
}

async function lockDescriptor({ fd, flockPath, waitMs }) {
  const arguments_ = [
    "--exclusive",
    "--conflict-exit-code",
    String(BUNDLE_EXECUTION_LEASE_BUSY_EXIT),
    ...(waitMs === 0
      ? ["--nonblock"]
      : ["--timeout", (waitMs / 1_000).toFixed(3)]),
    "3",
  ];
  const stderrState = { bytes: 0, overflow: false, error: false };
  let child;
  try {
    child = spawn(flockPath, arguments_, {
      cwd: "/",
      env: {},
      shell: false,
      stdio: ["ignore", "ignore", "pipe", fd],
      windowsHide: true,
    });
  } catch {
    fail("could not start flock for the bundle execution lease",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }
  child.stderr.on("data", (chunk) => appendBounded(stderrState, chunk));
  child.stderr.once("error", () => { stderrState.error = true; });

  const status = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* exit/error will settle */ }
      finish(reject, new BundleExecutionLeaseError(
        "flock did not finish bundle lease acquisition within its bounded window",
        "BUNDLE_EXECUTION_LEASE_ACQUIRE_TIMEOUT",
      ));
    }, waitMs + FLOCK_COMPLETION_GRACE_MS);
    child.once("error", () => finish(reject, new BundleExecutionLeaseError(
      "flock could not acquire the bundle execution lease",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR",
    )));
    child.once("close", (exitCode, signal) => finish(resolve, { exitCode, signal }));
  });

  if (stderrState.overflow || stderrState.error) {
    fail("flock diagnostics could not be collected within the bundle lease limits",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }
  if (status.exitCode === BUNDLE_EXECUTION_LEASE_BUSY_EXIT && status.signal === null) {
    fail("another writer already owns this bundle's execution lease",
      "BUNDLE_EXECUTION_LEASE_BUSY");
  }
  if (status.exitCode !== 0 || status.signal !== null) {
    fail("flock could not acquire the bundle execution lease",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }
}

function validateLeaseRecord(record) {
  requireCondition(record !== undefined && record.released === false,
    "bundle execution lease is not active");
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(record.fd, { bigint: true });
    pathStat = lstatSync(record.bundleDir, { bigint: true });
  } catch {
    fail("bundle execution lease descriptor or directory is unavailable",
      "BUNDLE_EXECUTION_LEASE_LOST");
  }
  requireCondition(stableDirectoryIdentity(record.stat, descriptorStat) &&
    stableDirectoryIdentity(descriptorStat, pathStat),
  "bundle execution lease no longer names its original directory",
  "BUNDLE_EXECUTION_LEASE_LOST");
  validatePrivateDirectoryStat(pathStat, "bundle directory");
  return record;
}

async function acquireLease(rawOptions) {
  const options = validateOptions(rawOptions);
  const inspected = inspectPrivateDirectory(options.bundleDir);
  const flockPath = resolveFlockExecutable(options.flockPath);
  let fd;
  try {
    fd = openSync(
      inspected.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd, { bigint: true });
    requireCondition(stableDirectoryIdentity(inspected.stat, opened),
      "bundle directory changed while its execution lease descriptor was opened",
      "BUNDLE_EXECUTION_LEASE_LOST");
    await lockDescriptor({ fd, flockPath, waitMs: options.waitMs });
    const afterPath = lstatSync(inspected.directory, { bigint: true });
    const afterFd = fstatSync(fd, { bigint: true });
    requireCondition(stableDirectoryIdentity(inspected.stat, afterPath) &&
      stableDirectoryIdentity(afterPath, afterFd),
    "bundle directory changed while its execution lease was acquired",
    "BUNDLE_EXECUTION_LEASE_LOST");
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the acquisition error */ }
    }
    if (error instanceof BundleExecutionLeaseError) throw error;
    fail("bundle execution lease could not be acquired safely",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }

  const ownerStartTicks = currentStartTicks();
  if (ownerStartTicks === null) {
    try { closeSync(fd); } catch { /* report the identity failure */ }
    fail("bundle execution lease owner identity could not be established",
      "BUNDLE_EXECUTION_LEASE_OPERATIONAL_ERROR");
  }
  const record = {
    bundleDir: inspected.directory,
    fd,
    stat: fstatSync(fd, { bigint: true }),
    released: false,
    evidence: Object.freeze({
      version: BUNDLE_EXECUTION_LEASE_VERSION,
      generation: randomBytes(16).toString("hex"),
      owner: Object.freeze({ pid: process.pid, startTicks: ownerStartTicks }),
      directory: Object.freeze({
        device: inspected.stat.dev.toString(),
        inode: inspected.stat.ino.toString(),
      }),
      acquiredMonotonicNs: process.hrtime.bigint().toString(),
    }),
  };
  const lease = Object.freeze({ version: BUNDLE_EXECUTION_LEASE_VERSION });
  LEASES.set(lease, record);
  return lease;
}

function releaseLease(lease) {
  const record = LEASES.get(lease);
  if (record === undefined || record.released) return;
  record.released = true;
  try {
    closeSync(record.fd);
  } catch {
    fail("bundle execution lease descriptor could not be released",
      "BUNDLE_EXECUTION_LEASE_RELEASE_ERROR");
  }
}

export function assertBundleExecutionLeaseHeld(lease) {
  validateLeaseRecord(LEASES.get(lease));
  return true;
}

export function bundleExecutionLeaseEvidence(lease) {
  return validateLeaseRecord(LEASES.get(lease)).evidence;
}

export function bundleExecutionLeaseAttemptRetention(lease) {
  const record = validateLeaseRecord(LEASES.get(lease));
  return Object.freeze({
    fd: record.fd,
    device: record.stat.dev.toString(),
    inode: record.stat.ino.toString(),
  });
}

export async function withBundleExecutionLease(options, operation) {
  requireCondition(typeof operation === "function",
    "bundle execution lease operation must be a function");
  const lease = await acquireLease(options);
  try {
    return await operation(lease);
  } finally {
    releaseLease(lease);
  }
}
