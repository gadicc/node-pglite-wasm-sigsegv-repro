import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEBUGGER_CONTROL_MAX_BYTES,
  DEBUGGER_CONTROL_VERSION,
  DebuggerControlError,
  parseDebuggerControlTranscript,
} from "./debugger-control.mjs";
import {
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";

export const DEBUGGER_ATTEMPT_IO_VERSION = 1;

const NONCE_RE = /^[a-f0-9]{32}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const COPY_BUFFER_BYTES = 64 * 1024;

export class DebuggerAttemptIoError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_ATTEMPT_IO") {
    super(message);
    this.name = "DebuggerAttemptIoError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerAttemptIoError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function exactKeys(value, expected, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]),
  `${label} must contain exactly: ${wanted.join(", ")}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeErrorCode(error, fallback) {
  return typeof error?.code === "string" && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // The descriptor has already been closed or was never usable.
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function createAnonymousTranscriptSpool() {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-debugger-"));
  let directoryFd;
  let transcriptFd;
  let transcriptCreated = false;
  try {
    const owner = BigInt(process.geteuid?.() ?? process.getuid());
    const before = lstatSync(directory, { bigint: true });
    requireCondition(before.isDirectory() && before.uid === owner &&
      (before.mode & 0o777n) === 0o700n,
    "debugger scratch directory is not a private current-user-owned directory",
    "DEBUGGER_SPOOL_CREATE_ERROR");
    directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedDirectory = fstatSync(directoryFd, { bigint: true });
    requireCondition(openedDirectory.isDirectory() && openedDirectory.uid === owner &&
      sameIdentity(before, openedDirectory),
    "debugger scratch directory changed while it was opened",
    "DEBUGGER_SPOOL_CREATE_ERROR");

    const anchored = `/proc/self/fd/${directoryFd}/transcript`;
    transcriptFd = openSync(
      anchored,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    transcriptCreated = true;
    fchmodSync(transcriptFd, 0o600);
    const named = lstatSync(anchored, { bigint: true });
    const openedTranscript = fstatSync(transcriptFd, { bigint: true });
    requireCondition(openedTranscript.isFile() && openedTranscript.uid === owner &&
      openedTranscript.nlink === 1n && (openedTranscript.mode & 0o777n) === 0o600n &&
      sameIdentity(openedTranscript, named),
    "debugger transcript spool is not a private stable regular file",
    "DEBUGGER_SPOOL_CREATE_ERROR");

    unlinkSync(anchored);
    transcriptCreated = false;
    fsyncSync(directoryFd);
    const anonymous = fstatSync(transcriptFd, { bigint: true });
    requireCondition(anonymous.nlink === 0n && sameIdentity(openedTranscript, anonymous),
      "debugger transcript spool did not become anonymous",
      "DEBUGGER_SPOOL_CREATE_ERROR");
    rmdirSync(directory);
    closeSync(directoryFd);
    directoryFd = undefined;
    return {
      fd: transcriptFd,
      identity: anonymous,
      owner,
    };
  } catch (error) {
    if (transcriptCreated && directoryFd !== undefined) {
      try {
        unlinkSync(`/proc/self/fd/${directoryFd}/transcript`);
      } catch {
        // Only the exclusively created scratch name is eligible for cleanup.
      }
    }
    closeQuietly(transcriptFd);
    closeQuietly(directoryFd);
    try {
      rmdirSync(directory);
    } catch {
      // Preserve the original creation failure.
    }
    if (error instanceof DebuggerAttemptIoError) throw error;
    fail(`debugger transcript spool could not be created: ${error?.code ?? "unknown error"}`,
      "DEBUGGER_SPOOL_CREATE_ERROR");
  }
}

function bytesFromChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw Object.assign(new TypeError("debugger I/O chunks must contain exact bytes"), {
    code: "DEBUGGER_IO_CHUNK_INVALID",
  });
}

function asyncBytes(value, label) {
  requireCondition(value !== null && value !== undefined &&
    (typeof value[Symbol.asyncIterator] === "function" ||
      typeof value[Symbol.iterator] === "function"),
  `${label} must be an iterable or async iterable of byte chunks`);
  return value;
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) {
      throw Object.assign(new Error("debugger transcript spool made no write progress"), {
        code: "DEBUGGER_TRANSCRIPT_STORAGE_ERROR",
      });
    }
    offset += written;
  }
}

function createChannel(limitBytes, retain) {
  return {
    limitBytes,
    retain,
    hash: createHash("sha256"),
    observedBytes: 0n,
    retainedBytes: 0,
    chunks: [],
    overflowed: false,
    streamComplete: false,
    streamErrorCode: null,
    storageErrorCode: null,
  };
}

async function collectChannel(input, channel, transcriptSpool) {
  try {
    for await (const value of input) {
      let bytes;
      try {
        bytes = bytesFromChunk(value);
      } catch (error) {
        channel.streamErrorCode ??= normalizeErrorCode(error, "DEBUGGER_IO_CHUNK_INVALID");
        continue;
      }
      channel.observedBytes += BigInt(bytes.length);
      channel.hash.update(bytes);
      const available = channel.limitBytes - channel.retainedBytes;
      const retained = available > 0 ? bytes.subarray(0, available) : Buffer.alloc(0);
      if (retained.length > 0 && channel.storageErrorCode === null) {
        try {
          if (channel.retain === "spool") writeAll(transcriptSpool.fd, retained);
          else channel.chunks.push(Buffer.from(retained));
          channel.retainedBytes += retained.length;
        } catch (error) {
          channel.storageErrorCode = normalizeErrorCode(
            error,
            channel.retain === "spool"
              ? "DEBUGGER_TRANSCRIPT_STORAGE_ERROR"
              : "DEBUGGER_CONTROL_STORAGE_ERROR",
          );
        }
      }
      if (retained.length < bytes.length || channel.observedBytes > BigInt(channel.limitBytes)) {
        channel.overflowed = true;
      }
    }
    channel.streamComplete = true;
  } catch (error) {
    channel.streamErrorCode ??= normalizeErrorCode(error, "DEBUGGER_IO_STREAM_ERROR");
  }
}

function channelStatus(channel, prefix) {
  // An incompletely drained stream invalidates the observed-byte accounting
  // itself, so it is reported even when storage also failed. The storage-error
  // status is reserved for fully drained streams whose retained bytes are
  // suspect; it must never hide an incomplete drain.
  if (!channel.streamComplete || channel.streamErrorCode !== null) {
    return {
      status: "stream-error",
      errorCode: channel.streamErrorCode ?? `${prefix}_STREAM_INCOMPLETE`,
    };
  }
  if (channel.storageErrorCode !== null) {
    return { status: "storage-error", errorCode: channel.storageErrorCode };
  }
  if (channel.overflowed) {
    return { status: "overflow", errorCode: `${prefix}_OVERFLOW` };
  }
  return { status: "complete", errorCode: null };
}

function channelEvidence(channel, version, status) {
  return {
    version,
    limitBytes: channel.limitBytes,
    status: status.status,
    errorCode: status.errorCode,
    observed: {
      bytes: channel.observedBytes.toString(),
      sha256: channel.hash.digest("hex"),
    },
    retainedBytes: channel.retainedBytes,
    overflowed: channel.overflowed,
  };
}

function verifyTranscriptSpool(spool, retainedBytes) {
  const current = fstatSync(spool.fd, { bigint: true });
  requireCondition(current.isFile() && current.uid === spool.owner && current.nlink === 0n &&
    (current.mode & 0o777n) === 0o600n && sameIdentity(spool.identity, current) &&
    current.size === BigInt(retainedBytes),
  "debugger transcript spool changed during capture",
  "DEBUGGER_TRANSCRIPT_STORAGE_ERROR");
}

function validateContext(manifest, value) {
  exactKeys(value, ["run", "nonce"], "debugger attempt I/O context");
  requireCondition(Number.isSafeInteger(value.run) && value.run >= 1 &&
    value.run <= manifest.schedule.maxRuns,
  `debugger attempt I/O run must be an integer from 1 through ${manifest.schedule.maxRuns}`);
  requireCondition(typeof value.nonce === "string" && NONCE_RE.test(value.nonce),
    "debugger attempt I/O nonce must be exactly 32 lowercase hexadecimal characters");
  return { run: value.run, nonce: value.nonce };
}

export async function captureDebuggerAttemptIo(
  resolved,
  manifestValue,
  contextValue,
  inputsValue,
) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const context = validateContext(manifest, contextValue);
  exactKeys(inputsValue, ["transcript", "control"], "debugger attempt I/O inputs");
  const transcriptInput = asyncBytes(inputsValue.transcript, "debugger transcript input");
  const controlInput = asyncBytes(inputsValue.control, "debugger control input");
  requireCondition(transcriptInput !== controlInput,
    "debugger transcript and control inputs must be distinct channels");
  const manifestBinding = debuggerPhaseManifestBinding(resolved, manifest);
  const transcriptLimit = manifest.debugger.commandProfile.transcript.maxBytes;
  const transcript = createChannel(transcriptLimit, "spool");
  const control = createChannel(DEBUGGER_CONTROL_MAX_BYTES, "memory");
  const spool = createAnonymousTranscriptSpool();

  await Promise.all([
    collectChannel(transcriptInput, transcript, spool),
    collectChannel(controlInput, control, spool),
  ]);

  try {
    verifyTranscriptSpool(spool, transcript.retainedBytes);
  } catch (error) {
    transcript.storageErrorCode ??= normalizeErrorCode(
      error,
      "DEBUGGER_TRANSCRIPT_STORAGE_ERROR",
    );
  }

  const controlBytes = Buffer.concat(control.chunks, control.retainedBytes);
  const transcriptStatus = channelStatus(transcript, "DEBUGGER_TRANSCRIPT");
  let controlStatus = channelStatus(control, "DEBUGGER_CONTROL");
  let parsedControl = null;
  if (controlStatus.status === "complete") {
    try {
      parsedControl = parseDebuggerControlTranscript(
        resolved,
        manifest,
        context,
        controlBytes,
      );
    } catch (error) {
      controlStatus = {
        status: "invalid",
        errorCode: error instanceof DebuggerControlError
          ? error.code
          : "INVALID_DEBUGGER_CONTROL",
      };
    }
  }

  const transcriptEvidence = channelEvidence(
    transcript,
    manifest.debugger.commandProfile.transcript.version,
    transcriptStatus,
  );
  const controlEvidence = channelEvidence(control, DEBUGGER_CONTROL_VERSION, controlStatus);
  const evidence = deepFreeze({
    version: DEBUGGER_ATTEMPT_IO_VERSION,
    context: {
      generation: manifest.generation,
      manifestSha256: manifestBinding.sha256,
      run: context.run,
      nonce: context.nonce,
    },
    transcript: transcriptEvidence,
    control: controlEvidence,
    complete: transcriptStatus.status === "complete" && controlStatus.status === "complete",
  });

  let disposed = false;
  function requireOpen() {
    if (disposed) fail("debugger attempt I/O capture has been disposed",
      "DEBUGGER_ATTEMPT_IO_DISPOSED");
  }
  function* transcriptChunks(chunkBytes = COPY_BUFFER_BYTES) {
    requireOpen();
    requireCondition(Number.isSafeInteger(chunkBytes) && chunkBytes >= 1 &&
      chunkBytes <= 1024 * 1024,
    "debugger transcript read size must be an integer from 1 through 1048576");
    let offset = 0;
    while (offset < transcript.retainedBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, transcript.retainedBytes - offset));
      const bytes = readSync(spool.fd, buffer, 0, buffer.length, offset);
      requireCondition(bytes > 0, "debugger transcript spool ended unexpectedly",
        "DEBUGGER_TRANSCRIPT_STORAGE_ERROR");
      offset += bytes;
      yield buffer.subarray(0, bytes);
    }
  }
  function controlTranscriptBytes() {
    requireOpen();
    return Buffer.from(controlBytes);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    closeQuietly(spool.fd);
  }

  return Object.freeze({
    evidence,
    control: parsedControl,
    transcriptChunks,
    controlTranscriptBytes,
    dispose,
    get disposed() {
      return disposed;
    },
    [Symbol.dispose]: dispose,
  });
}
