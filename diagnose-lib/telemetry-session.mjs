#!/usr/bin/env node

// Shell-facing lifecycle helpers for read-only telemetry evidence.
//
// This module records only telemetry bookkeeping. It never launches a
// workload, changes no_turbo, or gives telemetry authority over workload
// results. A start file is an immutable recovery point: after an interruption,
// a later process can finish the same boundary because Linux CLOCK_MONOTONIC
// (process.hrtime.bigint()) is system-wide and survives process exit.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  TELEMETRY_BOUNDARY_MAX_BYTES,
  TELEMETRY_INDEX_MAX_BYTES,
  TELEMETRY_MAX_SEGMENTS,
  TELEMETRY_META_MAX_BYTES,
  TELEMETRY_PHASES,
  buildTelemetryEnvelope,
  parseTelemetryBoundary,
  serializeTelemetryBoundary,
} from "./telemetry-evidence.mjs";
import {
  DEFAULT_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  canonicalTelemetryLine,
} from "./telemetry-sampler.mjs";

export const TELEMETRY_SESSION_STATE_VERSION = 1;
export const TELEMETRY_SESSION_STATE_MAX_BYTES = 16 * 1024;
export const TELEMETRY_SEGMENTS_JSON_MAX_BYTES = 16 * 1024 * 1024;

const MAX_PATH_BYTES = 4_096;
const MAX_NO_TURBO_BYTES = 4_096;
const DEFAULT_NO_TURBO_PATH = "/sys/devices/system/cpu/intel_pstate/no_turbo";
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const START_KEYS = ["version", "phase", "tag", "generation", "segment", "start"];
const POINT_KEYS = ["unixMs", "monotonicNs", "noTurbo"];
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class TelemetrySessionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetrySessionInputError";
  }
}

export class TelemetrySessionStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetrySessionStateError";
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TelemetrySessionInputError(`${label} must be text or bytes`);
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > MAX_PATH_BYTES || !path.isAbsolute(value) ||
      path.normalize(value) !== value) {
    throw new TelemetrySessionInputError(`${label} must be a canonical absolute path`);
  }
  return value;
}

function validateIdentity(options) {
  const phase = options?.phase;
  const tag = options?.tag;
  const generation = options?.generation;
  const segment = options?.segment;
  if (!TELEMETRY_PHASES.includes(phase)) {
    throw new TelemetrySessionInputError("phase is invalid");
  }
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    throw new TelemetrySessionInputError("tag is invalid");
  }
  if (typeof generation !== "string" || !GENERATION_RE.test(generation)) {
    throw new TelemetrySessionInputError("generation must be exactly 32 lowercase hexadecimal characters");
  }
  if (!Number.isSafeInteger(segment) || segment < 1 || segment > TELEMETRY_MAX_SEGMENTS) {
    throw new TelemetrySessionInputError(`segment must be an integer from 1 through ${TELEMETRY_MAX_SEGMENTS}`);
  }
  return { phase, tag, generation, segment };
}

function validateInterval(value) {
  if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    throw new TelemetrySessionInputError(
      `intervalMs must be an integer from ${MIN_INTERVAL_MS} through ${MAX_INTERVAL_MS}`,
    );
  }
  return value;
}

function stableIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink;
}

function stableArtifact(left, right) {
  return stableIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inspectOwnedDirectory(directory, label) {
  const validated = validateAbsolutePath(directory, label);
  let before;
  let fd;
  try {
    before = lstatSync(validated, { bigint: true });
    if (!before.isDirectory() || (currentUid() !== null && before.uid !== currentUid())) {
      throw new TelemetrySessionStateError(`${label} must be a real directory owned by the current user`);
    }
    fd = openSync(
      validated,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd, { bigint: true });
    const after = lstatSync(validated, { bigint: true });
    if (!opened.isDirectory() || !stableIdentity(before, opened) || !stableIdentity(opened, after)) {
      throw new TelemetrySessionStateError(`${label} changed while it was inspected`);
    }
    return { directory: validated, fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain the primary error */ }
    }
    if (error instanceof TelemetrySessionInputError || error instanceof TelemetrySessionStateError) throw error;
    throw new TelemetrySessionStateError(`${label} is missing or could not be inspected safely`);
  }
}

function closeDirectory(inspection) {
  try { closeSync(inspection.fd); } catch { /* a completed operation remains the primary result */ }
}

function anchoredDirectoryEntry(inspection, name, label) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." ||
      name.includes("/") || name.includes("\0")) {
    throw new TelemetrySessionInputError(`${label} must name one file inside its parent directory`);
  }
  return `/proc/self/fd/${inspection.fd}/${name}`;
}

function revalidatePublishedDirectory(inspection, label) {
  try {
    const descriptor = fstatSync(inspection.fd, { bigint: true });
    const published = lstatSync(inspection.directory, { bigint: true });
    if (!descriptor.isDirectory() || !published.isDirectory() ||
        !stableIdentity(inspection.stat, descriptor) ||
        !stableIdentity(descriptor, published) ||
        (currentUid() !== null && descriptor.uid !== currentUid())) {
      throw new TelemetrySessionStateError(`${label} changed while telemetry output was published`);
    }
  } catch (error) {
    if (error instanceof TelemetrySessionStateError) throw error;
    throw new TelemetrySessionStateError(`${label} changed while telemetry output was published`);
  }
}

function readOwnedArtifact(file, maximum, label, { privateMode = false, optional = false } = {}) {
  const validated = validateAbsolutePath(file, label);
  let before;
  let fd;
  try {
    before = lstatSync(validated, { bigint: true });
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new TelemetrySessionStateError(`${label} is missing or could not be inspected safely`);
  }
  try {
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n ||
        before.size > BigInt(maximum) ||
        (currentUid() !== null && before.uid !== currentUid()) ||
        (privateMode && (before.mode & 0o077n) !== 0n)) {
      throw new TelemetrySessionStateError(
        `${label} must be a single-link, bounded${privateMode ? ", private" : ""} regular file owned by the current user`,
      );
    }
    fd = openSync(validated, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!stableArtifact(before, opened) || opened.nlink !== 1n) {
      throw new TelemetrySessionStateError(`${label} changed while it was opened`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new TelemetrySessionStateError(`${label} was not read completely`);
    const afterFd = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(validated, { bigint: true });
    if (!stableArtifact(opened, afterFd) || !stableArtifact(afterFd, afterPath) || afterFd.nlink !== 1n) {
      throw new TelemetrySessionStateError(`${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof TelemetrySessionInputError || error instanceof TelemetrySessionStateError) throw error;
    throw new TelemetrySessionStateError(`${label} could not be read safely`);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain the primary error */ }
    }
  }
}

function reasonForReadError(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission_denied";
  if (error?.code === "ELOOP") return "symlink_rejected";
  return "read_error";
}

/** Read no_turbo without changing it. Failures become valid descriptive state. */
export function readNoTurboBoundaryState(noTurboPath = DEFAULT_NO_TURBO_PATH) {
  const file = validateAbsolutePath(noTurboPath, "no_turbo path");
  let before;
  let fd;
  try {
    before = lstatSync(file, { bigint: true });
    if (before.isSymbolicLink()) return { state: "unavailable", reason: "symlink_rejected" };
    if (!before.isFile()) return { state: "unavailable", reason: "not_regular_file" };
    if (before.nlink !== 1n) return { state: "unavailable", reason: "unsafe_link_count" };
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !stableIdentity(before, opened)) {
      return { state: "unavailable", reason: "changed_while_reading" };
    }
    const buffer = Buffer.allocUnsafe(MAX_NO_TURBO_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_NO_TURBO_BYTES) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_NO_TURBO_BYTES) return { state: "unavailable", reason: "value_too_large" };
    const afterFd = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(file, { bigint: true });
    if (!stableIdentity(opened, afterFd) || !stableIdentity(afterFd, afterPath) || afterFd.nlink !== 1n) {
      return { state: "unavailable", reason: "changed_while_reading" };
    }
    const value = buffer.subarray(0, offset).toString("utf8").trim();
    if (value === "0") return 0;
    if (value === "1") return 1;
    return { state: "unavailable", reason: value.length === 0 ? "empty_value" : "invalid_value" };
  } catch (error) {
    return { state: "unavailable", reason: reasonForReadError(error) };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the sample already has a result */ }
    }
  }
}

function validateClock(clock) {
  const candidate = clock ?? {
    unixMs: () => Date.now(),
    monotonicNs: () => process.hrtime.bigint(),
  };
  if (typeof candidate.unixMs !== "function" || typeof candidate.monotonicNs !== "function") {
    throw new TelemetrySessionInputError("clock must provide unixMs() and monotonicNs()");
  }
  return candidate;
}

/** Capture an absolute, cross-process workload boundary point. */
export function captureTelemetryBoundaryPoint(options = {}) {
  const noTurbo = readNoTurboBoundaryState(options.noTurboPath ?? DEFAULT_NO_TURBO_PATH);
  const clock = validateClock(options.clock);
  const unixMs = clock.unixMs();
  const monotonicNs = clock.monotonicNs();
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || typeof monotonicNs !== "bigint" || monotonicNs < 0n) {
    throw new TelemetrySessionStateError("clock returned an invalid boundary timestamp");
  }
  return { unixMs, monotonicNs: monotonicNs.toString(), noTurbo };
}

function serializeStartState(state) {
  if (!hasExactKeys(state, START_KEYS) || !hasExactKeys(state.start, POINT_KEYS)) {
    throw new TelemetrySessionInputError("telemetry start state has a noncanonical shape");
  }
  const identity = validateIdentity(state);
  const boundary = { version: 1, ...identity, start: state.start, end: state.start };
  const parsed = parseTelemetryBoundary(canonicalTelemetryLine(boundary), identity);
  if (state.version !== TELEMETRY_SESSION_STATE_VERSION || parsed.status !== "complete") {
    throw new TelemetrySessionInputError(
      ["telemetry start state is invalid", ...parsed.reasons].join("; "),
    );
  }
  return Buffer.from(canonicalTelemetryLine(state));
}

function parseStartState(value) {
  const bytes = exactBytes(value, "telemetry start state");
  if (bytes.length < 1 || bytes.length > TELEMETRY_SESSION_STATE_MAX_BYTES) {
    throw new TelemetrySessionStateError("telemetry start state exceeds its size limit");
  }
  let text;
  let state;
  try {
    text = UTF8_DECODER.decode(bytes);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.includes("\0")) {
      throw new Error("not one canonical line");
    }
    state = JSON.parse(text.slice(0, -1));
    const canonical = serializeStartState(state);
    if (!canonical.equals(bytes)) throw new Error("not canonical JSON");
  } catch (error) {
    if (error instanceof TelemetrySessionInputError) {
      throw new TelemetrySessionStateError(error.message);
    }
    throw new TelemetrySessionStateError("telemetry start state is not canonical JSON");
  }
  return state;
}

function ensureExpectedIdentity(actual, expected) {
  for (const key of ["phase", "tag", "generation", "segment"]) {
    if (actual[key] !== expected[key]) {
      throw new TelemetrySessionStateError(`telemetry start state ${key} disagrees with the requested identity`);
    }
  }
}

function safeUnlinkCreated(created) {
  if (created.stat === null) return;
  try {
    const atPath = lstatSync(created.anchored, { bigint: true });
    if (atPath.isFile() && atPath.dev === created.stat.dev && atPath.ino === created.stat.ino &&
        atPath.nlink === 1n && (currentUid() === null || atPath.uid === currentUid())) {
      unlinkSync(created.anchored);
    }
  } catch {
    // Rollback is best-effort; a suspicious replacement is deliberately kept.
  }
}

function publishExclusiveFiles(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new TelemetrySessionInputError("at least one output is required");
  }
  const afterDirectoriesInspected = options?.afterDirectoriesInspected ?? null;
  if (afterDirectoriesInspected !== null && typeof afterDirectoriesInspected !== "function") {
    throw new TelemetrySessionInputError("afterDirectoriesInspected must be a function when supplied");
  }
  const normalized = entries.map((entry) => {
    const file = validateAbsolutePath(entry.file, entry.label);
    const name = path.basename(file);
    if (name.length === 0 || name === "." || name === "..") {
      throw new TelemetrySessionInputError(`${entry.label} must name a file inside its parent directory`);
    }
    const bytes = exactBytes(entry.bytes, entry.label);
    if (bytes.length < 1 || bytes.length > entry.maximum) {
      throw new TelemetrySessionInputError(`${entry.label} exceeds its output size limit`);
    }
    return { ...entry, file, name, parent: path.dirname(file), bytes };
  });
  if (new Set(normalized.map(({ file }) => file)).size !== normalized.length) {
    throw new TelemetrySessionInputError("output paths must be distinct");
  }

  const directories = new Map();
  const created = [];
  try {
    for (const entry of normalized) {
      if (!directories.has(entry.parent)) {
        directories.set(
          entry.parent,
          inspectOwnedDirectory(entry.parent, `${entry.label} parent directory`),
        );
      }
    }
    afterDirectoriesInspected?.();

    for (const entry of normalized) {
      const parentInspection = directories.get(entry.parent);
      const anchored = anchoredDirectoryEntry(parentInspection, entry.name, entry.label);
      let fd;
      try {
        fd = openSync(
          anchored,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new TelemetrySessionStateError(`${entry.label} already exists; telemetry artifacts never overwrite`);
        }
        throw error;
      }
      const output = { ...entry, anchored, parentInspection, fd, stat: null };
      created.push(output);
      output.stat = fstatSync(fd, { bigint: true });
    }

    for (const output of created) {
      let offset = 0;
      while (offset < output.bytes.length) {
        const count = writeSync(output.fd, output.bytes, offset, output.bytes.length - offset);
        if (count < 1) throw new TelemetrySessionStateError(`${output.label} could not be written completely`);
        offset += count;
      }
      fchmodSync(output.fd, 0o600);
      fsyncSync(output.fd);
      const afterFd = fstatSync(output.fd, { bigint: true });
      const afterPath = lstatSync(output.anchored, { bigint: true });
      if (!afterFd.isFile() || afterFd.nlink !== 1n || afterFd.size !== BigInt(output.bytes.length) ||
          (afterFd.mode & 0o077n) !== 0n ||
          (currentUid() !== null && afterFd.uid !== currentUid()) ||
          !stableArtifact(afterFd, afterPath)) {
        throw new TelemetrySessionStateError(`${output.label} changed while it was published`);
      }
      output.stat = afterFd;
    }
    for (const output of created) {
      closeSync(output.fd);
      output.fd = undefined;
    }
    for (const [directory, inspection] of directories) {
      fsyncSync(inspection.fd);
      revalidatePublishedDirectory(inspection, `${directory} parent directory`);
    }
  } catch (error) {
    for (const output of created) {
      if (output.fd !== undefined) {
        try { closeSync(output.fd); } catch { /* retain the primary error */ }
      }
    }
    for (const output of created.reverse()) safeUnlinkCreated(output);
    for (const inspection of directories.values()) {
      try { fsyncSync(inspection.fd); } catch { /* retain the primary error */ }
    }
    if (error instanceof TelemetrySessionInputError || error instanceof TelemetrySessionStateError) throw error;
    throw new TelemetrySessionStateError("telemetry output could not be published safely");
  } finally {
    for (const inspection of directories.values()) closeDirectory(inspection);
  }
}

export function readTelemetryBoundaryStart(statePath) {
  const bytes = readOwnedArtifact(
    statePath,
    TELEMETRY_SESSION_STATE_MAX_BYTES,
    "telemetry start state",
    { privateMode: true },
  );
  return parseStartState(bytes);
}

function recoverStartState(statePath, identity) {
  const state = readTelemetryBoundaryStart(statePath);
  ensureExpectedIdentity(state, identity);
  return { state, bytes: serializeStartState(state), statePath, recovered: true };
}

/** Exclusively persist an immutable workload-start recovery point. */
export function captureTelemetryBoundaryStart(options = {}) {
  const identity = validateIdentity(options);
  const statePath = validateAbsolutePath(options.statePath, "state path");
  if (options.recover === true) {
    try {
      const existing = readOwnedArtifact(
        statePath,
        TELEMETRY_SESSION_STATE_MAX_BYTES,
        "telemetry start state",
        { privateMode: true, optional: true },
      );
      if (existing !== null) {
        const state = parseStartState(existing);
        ensureExpectedIdentity(state, identity);
        return { state, bytes: existing, statePath, recovered: true };
      }
    } catch (error) {
      if (!(error instanceof TelemetrySessionStateError)) throw error;
      throw error;
    }
  }
  const state = {
    version: TELEMETRY_SESSION_STATE_VERSION,
    ...identity,
    start: captureTelemetryBoundaryPoint(options),
  };
  const bytes = serializeStartState(state);
  try {
    publishExclusiveFiles([{
      file: statePath,
      bytes,
      maximum: TELEMETRY_SESSION_STATE_MAX_BYTES,
      label: "telemetry start state",
    }], options);
  } catch (error) {
    if (options.recover === true && error instanceof TelemetrySessionStateError &&
        error.message.includes("already exists")) {
      return recoverStartState(statePath, identity);
    }
    throw error;
  }
  return { state, bytes, statePath, recovered: false };
}

function recoverBoundary(outputPath, state) {
  const bytes = readOwnedArtifact(
    outputPath,
    TELEMETRY_BOUNDARY_MAX_BYTES,
    "telemetry boundary output",
    { privateMode: true },
  );
  const expected = validateIdentity(state);
  const parsed = parseTelemetryBoundary(bytes, expected);
  if (parsed.status !== "complete" ||
      canonicalTelemetryLine(parsed.boundary.start) !== canonicalTelemetryLine(state.start)) {
    throw new TelemetrySessionStateError(
      ["existing telemetry boundary does not reconcile with its start state", ...parsed.reasons].join("; "),
    );
  }
  return { boundary: parsed.boundary, bytes, outputPath, state, recovered: true };
}

/** Finish a saved start point and exclusively publish its exact boundary. */
export function finishTelemetryBoundary(options = {}) {
  const statePath = validateAbsolutePath(options.statePath, "state path");
  const outputPath = validateAbsolutePath(options.outputPath, "boundary output path");
  if (statePath === outputPath) {
    throw new TelemetrySessionInputError("state and boundary output paths must differ");
  }
  const state = readTelemetryBoundaryStart(statePath);
  if (options.recover === true) {
    const existing = readOwnedArtifact(
      outputPath,
      TELEMETRY_BOUNDARY_MAX_BYTES,
      "telemetry boundary output",
      { privateMode: true, optional: true },
    );
    if (existing !== null) return recoverBoundary(outputPath, state);
  }
  const boundary = {
    version: 1,
    phase: state.phase,
    tag: state.tag,
    generation: state.generation,
    segment: state.segment,
    start: state.start,
    end: captureTelemetryBoundaryPoint(options),
  };
  let bytes;
  try {
    bytes = serializeTelemetryBoundary(boundary);
  } catch (error) {
    throw new TelemetrySessionStateError(`telemetry boundary could not be completed: ${error.message}`);
  }
  try {
    publishExclusiveFiles([{
      file: outputPath,
      bytes,
      maximum: TELEMETRY_BOUNDARY_MAX_BYTES,
      label: "telemetry boundary output",
    }], options);
  } catch (error) {
    if (options.recover === true && error instanceof TelemetrySessionStateError &&
        error.message.includes("already exists")) {
      return recoverBoundary(outputPath, state);
    }
    throw error;
  }
  return { boundary, bytes, outputPath, state, recovered: false };
}

/** Mint an unpredictable 128-bit evidence-generation token. */
export function mintTelemetryGeneration(options = {}) {
  const source = options.randomBytes ?? randomBytes;
  if (typeof source !== "function") throw new TelemetrySessionInputError("randomBytes must be a function");
  const bytes = source(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new TelemetrySessionStateError("random source did not return exactly 16 bytes");
  }
  const generation = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
  if (!GENERATION_RE.test(generation)) throw new TelemetrySessionStateError("generation could not be encoded canonically");
  return generation;
}

export function normalizeTelemetrySegments(segments) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > TELEMETRY_MAX_SEGMENTS) {
    throw new TelemetrySessionInputError(`segments must contain 1-${TELEMETRY_MAX_SEGMENTS} entries`);
  }
  const ids = new Set();
  const tags = new Set();
  let previous = 0;
  return segments.map((entry, index) => {
    if (!hasExactKeys(entry, ["segment", "tag"]) || !Number.isSafeInteger(entry.segment) ||
        entry.segment < 1 || entry.segment > TELEMETRY_MAX_SEGMENTS ||
        typeof entry.tag !== "string" || !TAG_RE.test(entry.tag)) {
      throw new TelemetrySessionInputError(`segment ${index + 1} has a noncanonical identity`);
    }
    if (entry.segment <= previous) {
      throw new TelemetrySessionInputError("segments must be strictly increasing");
    }
    if (ids.has(entry.segment) || tags.has(entry.tag)) {
      throw new TelemetrySessionInputError("segment IDs and tags must be unique");
    }
    previous = entry.segment;
    ids.add(entry.segment);
    tags.add(entry.tag);
    return { segment: entry.segment, tag: entry.tag };
  });
}

export function parseTelemetrySegmentsJson(value) {
  const bytes = exactBytes(value, "segments JSON");
  if (bytes.length < 1 || bytes.length > TELEMETRY_SEGMENTS_JSON_MAX_BYTES) {
    throw new TelemetrySessionInputError("segments JSON exceeds its size limit");
  }
  let text;
  let parsed;
  try {
    text = UTF8_DECODER.decode(bytes);
    if (text.includes("\r") || text.includes("\0") ||
        (text.endsWith("\n") ? text.slice(0, -1).includes("\n") : text.includes("\n"))) {
      throw new Error("segments JSON must occupy one line");
    }
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    parsed = normalizeTelemetrySegments(JSON.parse(body));
    if (JSON.stringify(parsed) !== body) throw new Error("segments JSON is not canonical");
  } catch (error) {
    if (error instanceof TelemetrySessionInputError) throw error;
    throw new TelemetrySessionInputError("segments JSON must be one canonical JSON list");
  }
  return parsed;
}

function validateBundleDirectories(bundleDir, phase) {
  const root = validateAbsolutePath(bundleDir, "bundle directory");
  const inspections = [];
  try {
    for (const [directory, label] of [
      [root, "bundle directory"],
      [path.join(root, "results"), "results directory"],
      [path.join(root, "telemetry"), "telemetry directory"],
      [path.join(root, "telemetry", phase), "telemetry phase directory"],
    ]) inspections.push(inspectOwnedDirectory(directory, label));
  } finally {
    for (const inspection of inspections) closeDirectory(inspection);
  }
  return root;
}

/** Build the exact index/meta staging buffers without publishing either one. */
export function buildTelemetryEnvelopeStaging(bundleDir, options = {}) {
  const identity = validateIdentity({ ...options, tag: "envelope", segment: 1 });
  const intervalMs = validateInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const segments = normalizeTelemetrySegments(options.segments);
  const root = validateBundleDirectories(bundleDir, identity.phase);
  return buildTelemetryEnvelope(root, {
    phase: identity.phase,
    generation: identity.generation,
    intervalMs,
    segments,
    workloadBinding: options.workloadBinding,
  });
}

/** Publish already-built index/meta staging buffers as an exclusive pair. */
export function publishTelemetryEnvelopeStaging(staging, options = {}) {
  if (staging === null || typeof staging !== "object" ||
      !Buffer.isBuffer(staging.rowsBuffer) || !Buffer.isBuffer(staging.metaBuffer)) {
    throw new TelemetrySessionInputError("staging must be buildTelemetryEnvelopeStaging output");
  }
  const indexOutput = validateAbsolutePath(options.indexOutput, "index output path");
  const metaOutput = validateAbsolutePath(options.metaOutput, "metadata output path");
  publishExclusiveFiles([
    {
      file: indexOutput,
      bytes: staging.rowsBuffer,
      maximum: TELEMETRY_INDEX_MAX_BYTES,
      label: "telemetry index output",
    },
    {
      file: metaOutput,
      bytes: staging.metaBuffer,
      maximum: TELEMETRY_META_MAX_BYTES,
      label: "telemetry metadata output",
    },
  ], options);
  return { ...staging, indexOutput, metaOutput };
}

/** Build and no-clobber-publish a telemetry phase envelope. */
export function publishTelemetryEnvelope(bundleDir, options = {}) {
  const staging = buildTelemetryEnvelopeStaging(bundleDir, options);
  return publishTelemetryEnvelopeStaging(staging, options);
}

function parseCanonicalPositiveInteger(value, label, maximum) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TelemetrySessionInputError(`${label} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new TelemetrySessionInputError(`${label} exceeds its supported range`);
  }
  return parsed;
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length < 1) throw new TelemetrySessionInputError("a command is required");
  const command = argv[0];
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--recover") {
      if (flags.has(arg)) throw new TelemetrySessionInputError(`${arg} may be supplied only once`);
      flags.add(arg);
      continue;
    }
    if (!arg.startsWith("--") || index + 1 >= argv.length) {
      throw new TelemetrySessionInputError(`invalid or valueless option: ${arg}`);
    }
    if (values.has(arg)) throw new TelemetrySessionInputError(`${arg} may be supplied only once`);
    values.set(arg, argv[++index]);
  }
  return { command, values, flags };
}

function rejectUnexpected(parsed, allowedValues, allowRecover = false) {
  for (const key of parsed.values.keys()) {
    if (!allowedValues.has(key)) throw new TelemetrySessionInputError(`unknown option: ${key}`);
  }
  if (!allowRecover && parsed.flags.has("--recover")) {
    throw new TelemetrySessionInputError("--recover is not valid for this command");
  }
}

function required(parsed, name) {
  if (!parsed.values.has(name)) throw new TelemetrySessionInputError(`${name} is required`);
  return parsed.values.get(name);
}

function cliIdentity(parsed) {
  return validateIdentity({
    phase: required(parsed, "--phase"),
    tag: required(parsed, "--tag"),
    generation: required(parsed, "--generation"),
    segment: parseCanonicalPositiveInteger(
      required(parsed, "--segment"),
      "--segment",
      TELEMETRY_MAX_SEGMENTS,
    ),
  });
}

function cliWorkloadBinding(parsed, phase) {
  const workloadGeneration = required(parsed, "--workload-generation");
  const workloadBindingSha256 = required(parsed, "--workload-binding-sha256");
  const workloadBoundariesSha256 = required(parsed, "--workload-boundaries-sha256");
  const workloadBoundaryRowCountText = required(parsed, "--workload-boundary-row-count");
  if ((phase === "baseline" ? workloadGeneration !== "-" : !GENERATION_RE.test(workloadGeneration)) ||
      !DIGEST_RE.test(workloadBindingSha256)) {
    throw new TelemetrySessionInputError("workload binding generation or digest is invalid");
  }
  const exactBoundaryPhase = phase === "individual" || phase === "pinned-concurrent";
  if (exactBoundaryPhase) {
    if (!DIGEST_RE.test(workloadBoundariesSha256)) {
      throw new TelemetrySessionInputError("exact-CPU workload boundary digest is invalid");
    }
    return {
      phase,
      workloadGeneration,
      workloadBindingSha256,
      workloadBoundariesSha256,
      workloadBoundaryRowCount: parseCanonicalPositiveInteger(
        workloadBoundaryRowCountText,
        "--workload-boundary-row-count",
        20_000_000,
      ),
    };
  }
  if (workloadBoundariesSha256 !== "-" || workloadBoundaryRowCountText !== "-") {
    throw new TelemetrySessionInputError(
      "non-exact workload boundary fields must both be canonical dashes",
    );
  }
  return {
    phase,
    workloadGeneration,
    workloadBindingSha256,
    workloadBoundariesSha256: "-",
    workloadBoundaryRowCount: "-",
  };
}

function usage() {
  return `usage: node telemetry-session.mjs COMMAND [options]

Read-only telemetry session bookkeeping; this program never launches a
workload or changes no_turbo.

  mint-generation

  start --state-file ABS --phase PHASE --tag TAG --generation HEX32 --segment N
        [--no-turbo-path ABS] [--recover]

  finish --state-file ABS --boundary-output ABS
         [--no-turbo-path ABS] [--recover]

  envelope --bundle-dir ABS --phase PHASE --generation HEX32 --interval-ms N
           (--segments-json JSON | --segments-file ABS)
           --workload-generation HEX32_OR_DASH --workload-binding-sha256 HEX64
           --workload-boundaries-sha256 HEX64_OR_DASH
           --workload-boundary-row-count N_OR_DASH
           --index-output ABS --meta-output ABS

start and finish outputs are exclusive mode 0600. --recover reuses only an
existing canonical artifact that reconciles with the immutable start state.
envelope creates its index and metadata staging files as a no-clobber pair.`;
}

function writeCliJson(stream, value) {
  stream.write(canonicalTelemetryLine(value));
}

export function runTelemetrySessionCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const parsed = parseCli(argv);
    if (parsed.command === "mint-generation") {
      rejectUnexpected(parsed, new Set());
      stdout.write(`${mintTelemetryGeneration()}\n`);
      return 0;
    }
    if (parsed.command === "start") {
      rejectUnexpected(parsed, new Set([
        "--state-file", "--phase", "--tag", "--generation", "--segment", "--no-turbo-path",
      ]), true);
      const result = captureTelemetryBoundaryStart({
        ...cliIdentity(parsed),
        statePath: validateAbsolutePath(required(parsed, "--state-file"), "--state-file"),
        noTurboPath: parsed.values.has("--no-turbo-path")
          ? validateAbsolutePath(parsed.values.get("--no-turbo-path"), "--no-turbo-path")
          : DEFAULT_NO_TURBO_PATH,
        recover: parsed.flags.has("--recover"),
      });
      writeCliJson(stdout, {
        phase: result.state.phase,
        tag: result.state.tag,
        generation: result.state.generation,
        segment: result.state.segment,
        state: result.statePath,
        recovered: result.recovered,
      });
      return 0;
    }
    if (parsed.command === "finish") {
      rejectUnexpected(parsed, new Set(["--state-file", "--boundary-output", "--no-turbo-path"]), true);
      const result = finishTelemetryBoundary({
        statePath: validateAbsolutePath(required(parsed, "--state-file"), "--state-file"),
        outputPath: validateAbsolutePath(required(parsed, "--boundary-output"), "--boundary-output"),
        noTurboPath: parsed.values.has("--no-turbo-path")
          ? validateAbsolutePath(parsed.values.get("--no-turbo-path"), "--no-turbo-path")
          : DEFAULT_NO_TURBO_PATH,
        recover: parsed.flags.has("--recover"),
      });
      writeCliJson(stdout, {
        phase: result.boundary.phase,
        tag: result.boundary.tag,
        generation: result.boundary.generation,
        segment: result.boundary.segment,
        boundary: result.outputPath,
        recovered: result.recovered,
      });
      return 0;
    }
    if (parsed.command === "envelope") {
      rejectUnexpected(parsed, new Set([
        "--bundle-dir", "--phase", "--generation", "--interval-ms", "--segments-json",
        "--segments-file", "--workload-generation", "--workload-binding-sha256",
        "--workload-boundaries-sha256", "--workload-boundary-row-count",
        "--index-output", "--meta-output",
      ]));
      const hasJson = parsed.values.has("--segments-json");
      const hasFile = parsed.values.has("--segments-file");
      if (hasJson === hasFile) {
        throw new TelemetrySessionInputError("supply exactly one of --segments-json or --segments-file");
      }
      const segments = hasJson
        ? parseTelemetrySegmentsJson(parsed.values.get("--segments-json"))
        : parseTelemetrySegmentsJson(readOwnedArtifact(
          validateAbsolutePath(parsed.values.get("--segments-file"), "--segments-file"),
          TELEMETRY_SEGMENTS_JSON_MAX_BYTES,
          "segments JSON file",
        ));
      const phase = required(parsed, "--phase");
      const result = publishTelemetryEnvelope(
        validateAbsolutePath(required(parsed, "--bundle-dir"), "--bundle-dir"),
        {
          phase,
          generation: required(parsed, "--generation"),
          intervalMs: parseCanonicalPositiveInteger(
            required(parsed, "--interval-ms"),
            "--interval-ms",
            MAX_INTERVAL_MS,
          ),
          segments,
          workloadBinding: cliWorkloadBinding(parsed, phase),
          indexOutput: validateAbsolutePath(required(parsed, "--index-output"), "--index-output"),
          metaOutput: validateAbsolutePath(required(parsed, "--meta-output"), "--meta-output"),
        },
      );
      writeCliJson(stdout, {
        status: result.status,
        rows: result.rows.length,
        index: result.indexOutput,
        meta: result.metaOutput,
      });
      return 0;
    }
    throw new TelemetrySessionInputError(`unknown command: ${parsed.command}`);
  } catch (error) {
    stderr.write(`error: ${error?.message ?? String(error)}\n`);
    return error instanceof TelemetrySessionInputError ? 2 : 1;
  }
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.exitCode = runTelemetrySessionCli(process.argv.slice(2));
}
