#!/usr/bin/env node

// A strict envelope for the GDB phase. Paths in the manifest are labels, not
// authority: every artifact is opened relative to an already-open bundle
// directory without following links. Fixed control artifacts remain
// descriptor-bound; variable transcript sets are streamed in constant space
// and re-read before validation completes.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GDB_MANIFEST_VERSION = 1;
export const GDB_META_MAX_BYTES = 4 * 1024;
export const GDB_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const GDB_CONTROL_LINE_MAX_BYTES = 512;
export const GDB_MAX_RUNS_LIMIT = 4096;
export const GDB_MAX_CAPTURES_LIMIT = 4096;
export const GDB_RESULTS_ENTRY_LIMIT = 256;
export const GDB_ERROR_LIMIT = 64;

const READ_BUFFER_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GENERATION_RE = /^[0-9a-f]{32}$/;
const CANDIDATE_RE = /^\.gdb\.manifest\.[A-Za-z0-9._-]+$/;
const RESERVED_CANDIDATE_PREFIX = ".gdb.manifest";
const EFFECTIVE_UID = BigInt(process.geteuid());
const SKIP_KINDS = new Set([
  "--skip-gdb",
  "gdb not installed",
  "no failing CPU identified",
]);

function canonicalUint(value, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number > max || (positive && number === 0)) return null;
  return number;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(left, right) {
  return right.isFile() && sameIdentity(left, right) &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function stableDirectory(left, right) {
  return right.isDirectory() && sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function ownedByEffectiveUser(stat) {
  return stat.uid === EFFECTIVE_UID;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // The validation result is already determined.
  }
}

function fixedProbe(status, generation = null, outcome = null) {
  return `GDB_EVIDENCE\tVERSION\t1\tSTATUS\t${status}\tGENERATION\t${generation ?? "-"}\tOUTCOME\t${outcome ?? "-"}`;
}

function invalid(reasons, generation = null) {
  return {
    ok: false,
    status: "invalid",
    generation,
    outcome: null,
    reasons: [...new Set(reasons.length > 0 ? reasons : ["GDB evidence is invalid"])],
    probe: fixedProbe("INVALID", generation),
  };
}

class BoundedErrors extends Array {
  push(...values) {
    for (const value of values) {
      if (this.length < GDB_ERROR_LIMIT) super.push(value);
      else if (this.length === GDB_ERROR_LIMIT) super.push("additional GDB validation errors omitted");
    }
    return this.length;
  }
}

class AnchoredHierarchy {
  constructor(root) {
    this.rootPath = path.resolve(root);
    this.directories = new Map();
    this.files = [];
    this.missing = [];
    this.errors = new BoundedErrors();
    this.#openRoot();
    if (this.errors.length === 0) {
      this.#openChild("results", "root", "results");
      this.#openChild("state", "root", "state");
      this.#openChild("gdb", "root", "gdb");
      this.#openChild("logs", "root", "logs");
      this.#openChild("logs/gdb", "logs", "gdb");
    }
  }

  #openRoot() {
    let before;
    let fd;
    try {
      before = lstatSync(this.rootPath, { bigint: true });
      if (!before.isDirectory() || !ownedByEffectiveUser(before)) {
        throw new Error("bundle root must be a real directory owned by the effective user");
      }
      fd = openSync(
        this.rootPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(fd, { bigint: true });
      const after = lstatSync(this.rootPath, { bigint: true });
      if (!opened.isDirectory() || !ownedByEffectiveUser(opened) || !ownedByEffectiveUser(after) ||
          !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
        throw new Error("bundle root changed while being opened");
      }
      this.directories.set("root", { fd, stat: opened, absolute: this.rootPath, label: "bundle root" });
    } catch (error) {
      closeQuietly(fd);
      this.errors.push(error?.message?.startsWith("bundle root")
        ? error.message
        : "bundle root could not be opened safely");
    }
  }

  #openChild(key, parentKey, name) {
    const parent = this.directories.get(parentKey);
    if (!parent) return;
    const anchored = `/proc/self/fd/${parent.fd}/${name}`;
    const absolute = path.join(parent.absolute, name);
    let fd;
    try {
      const before = lstatSync(anchored, { bigint: true });
      if (!before.isDirectory() || !ownedByEffectiveUser(before)) {
        throw new Error(`${key} must be a real directory owned by the effective user`);
      }
      fd = openSync(
        anchored,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(fd, { bigint: true });
      const after = lstatSync(anchored, { bigint: true });
      if (!opened.isDirectory() || !ownedByEffectiveUser(opened) || !ownedByEffectiveUser(after) ||
          !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
        throw new Error(`${key} changed while being opened`);
      }
      this.directories.set(key, { fd, stat: opened, absolute, label: key });
    } catch (error) {
      closeQuietly(fd);
      this.errors.push(error?.message?.startsWith(key)
        ? error.message
        : `${key} is missing or could not be opened safely`);
    }
  }

  anchoredPath(directoryKey, name) {
    const directory = this.directories.get(directoryKey);
    if (!directory || name.includes("/") || name === "." || name === "..") return null;
    return `/proc/self/fd/${directory.fd}/${name}`;
  }

  inspectMissing(directoryKey, name, label) {
    const file = this.anchoredPath(directoryKey, name);
    if (file === null) {
      this.errors.push(`${label} parent directory is unavailable`);
      return false;
    }
    try {
      lstatSync(file);
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.missing.push({ directoryKey, name, label });
        return true;
      }
      this.errors.push(`${label} could not be inspected safely`);
      return false;
    }
  }

  openFile(
    directoryKey,
    name,
    maxBytes,
    label,
    { required = true, requiredMode = null, hold = true } = {},
  ) {
    const file = this.anchoredPath(directoryKey, name);
    if (file === null) {
      this.errors.push(`${label} parent directory is unavailable`);
      return null;
    }
    let before;
    let fd;
    try {
      before = lstatSync(file, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (required) this.errors.push(`${label} is missing`);
        return null;
      }
      this.errors.push(`${label} could not be inspected safely`);
      return null;
    }
    try {
      if (!before.isFile() || before.nlink !== 1n || !ownedByEffectiveUser(before)) {
        throw new Error(`${label} must be a real single-link regular file owned by the effective user`);
      }
      if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds the validation size limit`);
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd, { bigint: true });
      const after = lstatSync(file, { bigint: true });
      if (!stableFile(before, opened) || !stableFile(opened, after) || opened.nlink !== 1n ||
          !ownedByEffectiveUser(opened) || !ownedByEffectiveUser(after)) {
        throw new Error(`${label} changed while being opened`);
      }
      if (requiredMode !== null && (opened.mode & 0o777n) !== BigInt(requiredMode)) {
        throw new Error(`${label} must have mode ${requiredMode.toString(8)}`);
      }
      const state = { fd, stat: opened, directoryKey, name, label, bytesRead: null };
      if (hold) this.files.push(state);
      return state;
    } catch (error) {
      closeQuietly(fd);
      this.errors.push(error?.message?.startsWith(label)
        ? error.message
        : `${label} could not be opened safely`);
      return null;
    }
  }

  inventory(directoryKey, label, { maxEntries, onName = null }) {
    const directory = this.directories.get(directoryKey);
    if (!directory) return null;
    let opened;
    try {
      const before = fstatSync(directory.fd, { bigint: true });
      opened = opendirSync(`/proc/self/fd/${directory.fd}`);
      let count = 0;
      while (true) {
        const entry = opened.readSync();
        if (entry === null) break;
        count += 1;
        if (count > maxEntries) throw new Error("directory contains too many entries");
        onName?.(entry.name);
      }
      opened.closeSync();
      opened = undefined;
      const after = fstatSync(directory.fd, { bigint: true });
      if (!stableDirectory(before, after)) {
        throw new Error("directory changed");
      }
      return count;
    } catch {
      this.errors.push(`${label} inventory could not be read safely`);
      return null;
    } finally {
      try {
        opened?.closeSync();
      } catch {
        // The inventory is already invalid.
      }
    }
  }

  verifyFile(file) {
    const anchored = this.anchoredPath(file.directoryKey, file.name);
    try {
      const descriptor = fstatSync(file.fd, { bigint: true });
      const pathname = lstatSync(anchored, { bigint: true });
      if (!stableFile(file.stat, descriptor) || !stableFile(descriptor, pathname) ||
          descriptor.nlink !== 1n || !ownedByEffectiveUser(descriptor) ||
          !ownedByEffectiveUser(pathname) ||
          (file.bytesRead !== null && BigInt(file.bytesRead) !== descriptor.size)) {
        this.errors.push(`${file.label} changed during validation`);
        return false;
      }
      return true;
    } catch {
      this.errors.push(`${file.label} changed during validation`);
      return false;
    }
  }

  finishFile(file) {
    if (!file || file.fd === undefined) return;
    this.verifyFile(file);
    closeQuietly(file.fd);
    file.fd = undefined;
  }

  verify() {
    for (const [key, directory] of this.directories) {
      try {
        const descriptor = fstatSync(directory.fd, { bigint: true });
        const pathname = lstatSync(directory.absolute, { bigint: true });
        if (!stableDirectory(directory.stat, descriptor) || !stableDirectory(descriptor, pathname) ||
            !ownedByEffectiveUser(descriptor) || !ownedByEffectiveUser(pathname)) {
          this.errors.push(`${directory.label} changed during validation`);
        }
      } catch {
        this.errors.push(`${directory.label} changed during validation`);
      }
      if (key === "root") continue;
    }
    for (const file of this.files) {
      this.verifyFile(file);
    }
    for (const missing of this.missing) {
      const anchored = this.anchoredPath(missing.directoryKey, missing.name);
      try {
        lstatSync(anchored);
        this.errors.push(`${missing.label} appeared during validation`);
      } catch (error) {
        if (error?.code !== "ENOENT") this.errors.push(`${missing.label} could not be rechecked safely`);
      }
    }
    return this.errors.length === 0;
  }

  close() {
    for (const file of this.files.reverse()) closeQuietly(file.fd);
    for (const directory of [...this.directories.values()].reverse()) closeQuietly(directory.fd);
  }
}

function streamFile(opened, maxBytes, onChunk) {
  if (opened === null) return null;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const max = BigInt(maxBytes);
  let total = 0n;
  let position = 0;
  try {
    while (true) {
      const remaining = max - total + 1n;
      const requested = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const count = readSync(opened.fd, buffer, 0, requested, position);
      if (count === 0) break;
      position += count;
      total += BigInt(count);
      if (total > max) throw new Error(`${opened.label} exceeds the validation size limit`);
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      onChunk?.(chunk);
    }
    opened.bytesRead = total;
    return { bytes: total, sha256: hash.digest("hex") };
  } catch (error) {
    throw new Error(error?.message?.startsWith(opened.label)
      ? error.message
      : `${opened.label} could not be read safely`);
  }
}

function scanControlLines(opened, maxBytes, { maxLines, onLine }) {
  let pending = Buffer.alloc(0);
  let lineCount = 0;
  let endedWithLf = false;
  const result = streamFile(opened, maxBytes, (chunk) => {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const line = pending.toString("ascii");
        pending = Buffer.alloc(0);
        endedWithLf = true;
        lineCount += 1;
        if (lineCount > maxLines) throw new Error(`${opened.label} contains too many records`);
        onLine(line, lineCount - 1);
        continue;
      }
      endedWithLf = false;
      if (byte === 0 || byte === 0x0d || (byte < 0x20 && byte !== 0x09) || byte > 0x7e) {
        throw new Error(`${opened.label} contains non-canonical text`);
      }
      if (pending.length >= GDB_CONTROL_LINE_MAX_BYTES) {
        throw new Error(`${opened.label} contains an overlong record`);
      }
      pending = Buffer.concat([pending, Buffer.from([byte])]);
    }
  });
  if (!endedWithLf || pending.length !== 0) throw new Error(`${opened.label} must end with LF`);
  return { ...result, lineCount };
}

function readMeta(hierarchy) {
  const opened = hierarchy.openFile("results", "gdb.meta", GDB_META_MAX_BYTES, "results/gdb.meta");
  if (!opened) return null;
  const lines = [];
  let file;
  try {
    file = scanControlLines(opened, GDB_META_MAX_BYTES, {
      maxLines: 7,
      onLine(line) { lines.push(line); },
    });
  } catch (error) {
    hierarchy.errors.push(error.message);
    return null;
  }
  const skipMatch = lines.length === 2 && lines[0] === "SKIPPED=1" &&
    /^SKIP_REASON=(.*)$/.exec(lines[1]);
  if (skipMatch) {
    const kind = skipMatch[1];
    if (!SKIP_KINDS.has(kind)) hierarchy.errors.push("GDB skip kind is not canonical");
    return { status: "SKIPPED", kind, file };
  }
  const names = ["CPU", "MAX_RUNS", "EXIT_CODE", "ATTEMPTED_RUNS", "CLEAN_RUNS", "CAPTURED_RUNS", "ERROR_RUNS"];
  if (lines.length !== names.length) {
    hierarchy.errors.push("GDB run metadata must contain exactly seven ordered records");
    return null;
  }
  const values = {};
  for (let index = 0; index < names.length; index += 1) {
    const match = new RegExp(`^${names[index]}=(0|[1-9][0-9]*)$`).exec(lines[index]);
    if (!match) hierarchy.errors.push(`GDB run metadata has an invalid ${names[index]} record`);
    else values[names[index]] = canonicalUint(match[1]);
  }
  if (Object.values(values).some((value) => value === null)) return null;
  return {
    status: "RUN",
    cpu: values.CPU,
    maxRuns: values.MAX_RUNS,
    exitCode: values.EXIT_CODE,
    attempted: values.ATTEMPTED_RUNS,
    clean: values.CLEAN_RUNS,
    captured: values.CAPTURED_RUNS,
    errors: values.ERROR_RUNS,
    file,
  };
}

function transcriptBoundaryState() {
  return {
    sawFirst: false,
    first: null,
    firstOverflow: false,
    current: [],
    currentOverflow: false,
    last: null,
    lastOverflow: false,
    sawLf: false,
  };
}

function scanTranscript(hierarchy, name, expected) {
  const opened = hierarchy.openFile(
    "gdb",
    name,
    GDB_TRANSCRIPT_MAX_BYTES,
    `gdb/${name}`,
    { hold: false },
  );
  if (!opened) return null;
  const boundary = transcriptBoundaryState();
  let file;
  try {
    file = streamFile(opened, GDB_TRANSCRIPT_MAX_BYTES, (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          const line = boundary.currentOverflow ? null : Buffer.from(boundary.current).toString("utf8");
          if (!boundary.sawFirst) {
            boundary.sawFirst = true;
            boundary.first = line;
            boundary.firstOverflow = boundary.currentOverflow;
          }
          boundary.last = line;
          boundary.lastOverflow = boundary.currentOverflow;
          boundary.current = [];
          boundary.currentOverflow = false;
          boundary.sawLf = true;
        } else {
          boundary.sawLf = false;
          if (boundary.current.length < GDB_CONTROL_LINE_MAX_BYTES) boundary.current.push(byte);
          else boundary.currentOverflow = true;
        }
      }
    });
  } catch (error) {
    hierarchy.errors.push(error.message);
    return null;
  } finally {
    hierarchy.finishFile(opened);
  }
  if (!boundary.sawLf || boundary.current.length !== 0 || boundary.currentOverflow) {
    hierarchy.errors.push(`gdb/${name} must end with LF`);
  }
  const header = `GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t${expected.generation}` +
    `\tCPU\t${expected.cpu}\tMAX_RUNS\t${expected.maxRuns}\tMAX_CAPTURES\t${expected.maxCaptures}` +
    `\tRUN\t${expected.run}\tOUTCOME\t${expected.outcome}`;
  const footer = `GDB_TRANSCRIPT_END\tGENERATION\t${expected.generation}` +
    `\tCPU\t${expected.cpu}\tRUN\t${expected.run}\tOUTCOME\t${expected.outcome}`;
  if (!boundary.sawFirst || boundary.firstOverflow || boundary.first !== header) {
    hierarchy.errors.push(`gdb/${name} has an invalid provenance header`);
  }
  if (boundary.lastOverflow || boundary.last !== footer) {
    hierarchy.errors.push(`gdb/${name} has an invalid provenance footer`);
  }
  return file;
}

function recordDigestUpdate(hash, id, outcome, relative, bytes, sha256) {
  hash.update(`${id}\t${outcome}\t${relative}\t${bytes}\t${sha256}\n`);
}

function scanRunner(hierarchy, expected, onAttempt = null, { hold = false } = {}) {
  const runnerMax = (BigInt(expected.maxRuns) + 1n) * BigInt(GDB_CONTROL_LINE_MAX_BYTES + 1);
  const opened = hierarchy.openFile(
    "logs/gdb",
    "runner.log",
    runnerMax,
    "logs/gdb/runner.log",
    { hold },
  );
  if (!opened) return null;
  const digest = createHash("sha256");
  let retainedCount = 0;
  let attempted = 0;
  let clean = 0;
  let captured = 0;
  let errors = 0;
  let captureCapRun = null;
  let terminal = null;
  let file;
  try {
    file = scanControlLines(opened, runnerMax, {
      maxLines: expected.maxRuns + 1,
      onLine(line) {
        if (terminal !== null) throw new Error("runner log has records after its terminal record");
        if (line.startsWith("ATTEMPT\t")) {
          if (captureCapRun !== null) {
            throw new Error("runner log has attempts after reaching the capture limit");
          }
          const fields = line.split("\t");
          const id = attempted + 1;
          const wanted = [
            "ATTEMPT", "GENERATION", expected.generation, "CPU", String(expected.cpu),
            "MAX_RUNS", String(expected.maxRuns), "MAX_CAPTURES", String(expected.maxCaptures),
            "RUN", String(id), "OUTCOME",
          ];
          if (fields.length !== 13 || !wanted.every((value, index) => fields[index] === value) ||
              !["clean", "captured", "error"].includes(fields[12])) {
            throw new Error("runner log has a malformed or non-contiguous attempt record");
          }
          const outcome = fields[12];
          attempted = id;
          if (outcome === "clean") clean += 1;
          else if (outcome === "captured") {
            captured += 1;
            if (captured === expected.maxCaptures) captureCapRun = id;
          }
          else errors += 1;
          let relative = "-";
          let bytes = "-";
          let sha256 = "-";
          if (outcome !== "clean") {
            const name = `cpu${expected.cpu}-run${id}.txt`;
            relative = `gdb/${name}`;
            retainedCount += 1;
            const transcript = scanTranscript(hierarchy, name, {
              ...expected,
              run: id,
              outcome,
            });
            if (transcript !== null) {
              bytes = transcript.bytes.toString();
              sha256 = transcript.sha256;
            }
          }
          recordDigestUpdate(digest, id, outcome, relative, bytes, sha256);
          onAttempt?.({ id, outcome, relative, bytes, sha256 });
          return;
        }
        if (line.startsWith("COUNTS\t")) {
          const fields = line.split("\t");
          const wanted = [
            "COUNTS", "GENERATION", expected.generation, "CPU", String(expected.cpu),
            "MAX_RUNS", String(expected.maxRuns), "MAX_CAPTURES", String(expected.maxCaptures),
            "ATTEMPTED", String(attempted), "CLEAN", String(clean), "CAPTURED", String(captured),
            "ERRORS", String(errors), "EXIT_CODE",
          ];
          if (fields.length !== 19 || !wanted.every((value, index) => fields[index] === value) ||
              !["0", "3"].includes(fields[18])) {
            throw new Error("runner log has a malformed terminal count record");
          }
          terminal = Number(fields[18]);
          return;
        }
        throw new Error("runner log contains an unknown record");
      },
    });
  } catch (error) {
    hierarchy.errors.push(error.message);
    return null;
  } finally {
    if (!hold) hierarchy.finishFile(opened);
  }
  if (terminal === null) hierarchy.errors.push("runner log is missing its terminal count record");
  checkTranscriptInventory(hierarchy, expected, attempted, retainedCount);
  return {
    file,
    attempted,
    clean,
    captured,
    errors,
    exitCode: terminal,
    recordsSha256: digest.digest("hex"),
    retainedCount,
  };
}

function checkTerminalRules(hierarchy, meta, runner, expected) {
  if (!runner) return;
  if (meta.cpu !== expected.cpu || meta.maxRuns !== expected.maxRuns) {
    hierarchy.errors.push("GDB metadata conflicts with the expected CPU or run limit");
  }
  for (const key of ["attempted", "clean", "captured", "errors", "exitCode"]) {
    if (meta[key] !== runner[key]) hierarchy.errors.push(`GDB metadata conflicts with runner ${key}`);
  }
  if (runner.attempted < 1 || runner.attempted > expected.maxRuns ||
      runner.attempted !== runner.clean + runner.captured + runner.errors) {
    hierarchy.errors.push("GDB terminal counts are inconsistent");
  }
  if (runner.exitCode === 0) {
    if (runner.captured < 1 || runner.captured > expected.maxCaptures ||
        (runner.attempted !== expected.maxRuns && runner.captured !== expected.maxCaptures)) {
      hierarchy.errors.push("captured GDB result violates full-run or max-captures termination rules");
    }
  } else if (runner.exitCode === 3) {
    if (runner.attempted !== expected.maxRuns || runner.captured !== 0 || runner.clean < 1) {
      hierarchy.errors.push("no-fault GDB result violates terminal run-count rules");
    }
  } else {
    hierarchy.errors.push("GDB runner has no valid terminal exit code");
  }
}

function checkTranscriptInventory(hierarchy, expected, attempted, retainedCount) {
  let invalidName = false;
  const count = hierarchy.inventory("gdb", "gdb", {
    maxEntries: expected.maxRuns + 1,
    onName(name) {
      const match = /^cpu(0|[1-9][0-9]*)-run(0|[1-9][0-9]*)\.txt$/.exec(name);
      const cpu = match ? canonicalUint(match[1], { max: 65535 }) : null;
      const run = match ? canonicalUint(match[2], { positive: true, max: expected.maxRuns }) : null;
      if (cpu !== expected.cpu || run === null || run > attempted) invalidName = true;
    },
  });
  if (count !== null && (count !== retainedCount || invalidName)) {
    hierarchy.errors.push("gdb transcript inventory does not exactly match the runner records");
  }
}

function checkCandidateNamespace(hierarchy, allowedName = null) {
  let conflict = false;
  hierarchy.inventory("results", "results", {
    maxEntries: GDB_RESULTS_ENTRY_LIMIT,
    onName(name) {
      if (name.startsWith(RESERVED_CANDIDATE_PREFIX) && name !== allowedName) conflict = true;
    },
  });
  if (conflict) hierarchy.errors.push("results contains a competing or stale GDB manifest candidate");
}

function exactInventory(hierarchy, status, expected) {
  let invalidLog = false;
  const wantedLogCount = status === "RUN" ? 1 : 0;
  const logs = hierarchy.inventory("logs/gdb", "logs/gdb", {
    maxEntries: wantedLogCount + 1,
    onName(name) {
      if (name !== "runner.log") invalidLog = true;
    },
  });
  if (logs !== null && (logs !== wantedLogCount || invalidLog)) {
    hierarchy.errors.push("logs/gdb inventory is not canonical for this GDB result");
  }
  if (status === "SKIPPED") {
    const transcripts = hierarchy.inventory("gdb", "gdb", { maxEntries: 1 });
    if (transcripts !== null && transcripts !== 0) {
      hierarchy.errors.push("skipped GDB evidence must not retain transcripts");
    }
  }
}

function normalizeExpectations(options) {
  const maxRuns = canonicalUint(options.expectedMaxRuns, { positive: true, max: GDB_MAX_RUNS_LIMIT });
  const maxCaptures = canonicalUint(options.expectedMaxCaptures, {
    positive: true,
    max: GDB_MAX_CAPTURES_LIMIT,
  });
  const cpu = options.expectedCpu === null || options.expectedCpu === undefined || options.expectedCpu === "-"
    ? null
    : canonicalUint(options.expectedCpu, { max: 65535 });
  const reasons = [];
  if (maxRuns === null) {
    reasons.push(`expected MAX_RUNS must be a canonical positive integer at most ${GDB_MAX_RUNS_LIMIT}`);
  }
  if (maxCaptures === null) {
    reasons.push(`expected MAX_CAPTURES must be a canonical positive integer at most ${GDB_MAX_CAPTURES_LIMIT}`);
  }
  if (options.expectedCpu !== null && options.expectedCpu !== undefined &&
      options.expectedCpu !== "-" && cpu === null) {
    reasons.push("expected CPU is not a canonical CPU id");
  }
  return { cpu, maxRuns, maxCaptures, reasons };
}

function parseManifest(hierarchy, manifestName, expected) {
  const maxBytes = (BigInt(expected.maxRuns) + 8n) * BigInt(GDB_CONTROL_LINE_MAX_BYTES + 1);
  const opened = hierarchy.openFile(
    "results",
    manifestName,
    maxBytes,
    `results/${manifestName}`,
    { requiredMode: 0o600 },
  );
  if (!opened) return null;
  const manifest = {
    generation: null,
    status: null,
    maxRuns: null,
    maxCaptures: null,
    cpu: null,
    skipKind: null,
    metaBytes: null,
    metaSha256: null,
    runnerBytes: null,
    runnerSha256: null,
    attempted: 0,
    recordsSha256: null,
    file: null,
  };
  const recordsHash = createHash("sha256");
  let fixedCount = null;
  try {
    manifest.file = scanControlLines(opened, maxBytes, {
      maxLines: expected.maxRuns + 8,
      onLine(line, index) {
        const fields = line.split("\t");
        if (index === 0) {
          if (fields.length !== 2 || fields[0] !== "VERSION" || fields[1] !== "1") {
            throw new Error("GDB manifest has an invalid VERSION record");
          }
        } else if (index === 1) {
          if (fields.length !== 2 || fields[0] !== "GENERATION" || !GENERATION_RE.test(fields[1])) {
            throw new Error("GDB manifest has an invalid GENERATION record");
          }
          manifest.generation = fields[1];
        } else if (index === 2) {
          if (fields.length !== 2 || fields[0] !== "STATUS" || !["RUN", "SKIPPED"].includes(fields[1])) {
            throw new Error("GDB manifest has an invalid STATUS record");
          }
          manifest.status = fields[1];
          fixedCount = manifest.status === "RUN" ? 8 : 7;
        } else if (index === 3 || index === 4) {
          const key = index === 3 ? "MAX_RUNS" : "MAX_CAPTURES";
          const value = canonicalUint(fields[2], { positive: true });
          if (fields.length !== 3 || fields[0] !== "CONFIG" || fields[1] !== key || value === null) {
            throw new Error(`GDB manifest has an invalid CONFIG ${key} record`);
          }
          if (index === 3) manifest.maxRuns = value;
          else manifest.maxCaptures = value;
        } else if (manifest.status === "RUN" && index === 5) {
          const cpu = canonicalUint(fields[2], { max: 65535 });
          if (fields.length !== 3 || fields[0] !== "CONFIG" || fields[1] !== "CPU" || cpu === null) {
            throw new Error("GDB manifest has an invalid CONFIG CPU record");
          }
          manifest.cpu = cpu;
        } else if (manifest.status === "SKIPPED" && index === 5) {
          if (fields.length !== 2 || fields[0] !== "SKIP" || !SKIP_KINDS.has(fields[1])) {
            throw new Error("GDB manifest has an invalid SKIP record");
          }
          manifest.skipKind = fields[1];
        } else if ((manifest.status === "RUN" && index === 6) ||
                   (manifest.status === "SKIPPED" && index === 6)) {
          const size = canonicalUint(fields[2]);
          if (fields.length !== 4 || fields[0] !== "META" || fields[1] !== "results/gdb.meta" ||
              size === null || !SHA256_RE.test(fields[3])) {
            throw new Error("GDB manifest has an invalid META record");
          }
          manifest.metaBytes = size;
          manifest.metaSha256 = fields[3];
        } else if (manifest.status === "RUN" && index === 7) {
          const size = canonicalUint(fields[2]);
          if (fields.length !== 4 || fields[0] !== "RUNNER" || fields[1] !== "logs/gdb/runner.log" ||
              size === null || !SHA256_RE.test(fields[3])) {
            throw new Error("GDB manifest has an invalid RUNNER record");
          }
          manifest.runnerBytes = size;
          manifest.runnerSha256 = fields[3];
        } else if (manifest.status === "RUN" && index >= 8) {
          const id = manifest.attempted + 1;
          const outcome = fields[2];
          if (fields.length !== 6 || fields[0] !== "ATTEMPT" || fields[1] !== String(id) ||
              !["clean", "captured", "error"].includes(outcome)) {
            throw new Error("GDB manifest has a malformed or non-contiguous ATTEMPT record");
          }
          const expectedPath = outcome === "clean" ? "-" : `gdb/cpu${manifest.cpu}-run${id}.txt`;
          if (fields[3] !== expectedPath ||
              (outcome === "clean"
                ? fields[4] !== "-" || fields[5] !== "-"
                : canonicalUint(fields[4]) === null || !SHA256_RE.test(fields[5]))) {
            throw new Error("GDB manifest ATTEMPT artifact binding is invalid");
          }
          manifest.attempted = id;
          recordDigestUpdate(recordsHash, id, outcome, fields[3], fields[4], fields[5]);
        } else {
          throw new Error("GDB manifest contains an out-of-order or extra record");
        }
      },
    });
  } catch (error) {
    hierarchy.errors.push(error.message);
    return null;
  }
  if (fixedCount === null || manifest.file.lineCount < fixedCount ||
      (manifest.status === "SKIPPED" && manifest.file.lineCount !== fixedCount)) {
    hierarchy.errors.push("GDB manifest is missing required ordered records");
  }
  manifest.recordsSha256 = recordsHash.digest("hex");
  return manifest;
}

function checkManifestRunnerBinding(hierarchy, manifest, runner) {
  if (runner === null) return;
  if (manifest.runnerBytes !== Number(runner.file.bytes) || manifest.runnerSha256 !== runner.file.sha256) {
    hierarchy.errors.push("GDB manifest RUNNER digest or size does not match runner.log");
  }
  if (manifest.attempted !== runner.attempted || manifest.recordsSha256 !== runner.recordsSha256) {
    hierarchy.errors.push("GDB manifest ATTEMPT records conflict with validated runner artifacts");
  }
}

function sameRunnerEvidence(left, right) {
  if (left === null || right === null) return false;
  return left.file.bytes === right.file.bytes && left.file.sha256 === right.file.sha256 &&
    left.attempted === right.attempted && left.clean === right.clean &&
    left.captured === right.captured && left.errors === right.errors &&
    left.exitCode === right.exitCode && left.recordsSha256 === right.recordsSha256 &&
    left.retainedCount === right.retainedCount;
}

function validateInHierarchy(hierarchy, options) {
  const expected = normalizeExpectations(options);
  hierarchy.errors.push(...expected.reasons);
  if (hierarchy.errors.length > 0) return invalid(hierarchy.errors);
  const markerMode = options.markerMode;
  if (markerMode !== "before" && markerMode !== "complete") {
    return invalid(["marker mode must be before or complete"]);
  }
  let manifestName;
  let allowedCandidateName = null;
  if (markerMode === "complete") {
    if ((options.manifestName !== undefined && options.manifestName !== "gdb.manifest") ||
        options.manifestPath !== undefined) {
      return invalid(["complete validation requires the authoritative results/gdb.manifest"]);
    }
    manifestName = "gdb.manifest";
  } else {
    if (typeof options.manifestPath !== "string") {
      return invalid(["before-publication validation requires the full GDB manifest path"]);
    }
    const candidatePath = path.resolve(options.manifestPath);
    const resultsPath = path.resolve(hierarchy.rootPath, "results");
    manifestName = path.basename(candidatePath);
    if (path.dirname(candidatePath) !== resultsPath ||
        (manifestName !== "gdb.manifest" && !CANDIDATE_RE.test(manifestName))) {
      return invalid(["before-publication manifest must be a safe GDB file directly inside results"]);
    }
    if (manifestName !== "gdb.manifest") allowedCandidateName = manifestName;
  }
  let marker = null;
  if (markerMode === "complete") {
    marker = hierarchy.openFile("state", "phase-gdb.done", 0, "state/phase-gdb.done");
  } else if (!hierarchy.inspectMissing("state", "phase-gdb.done", "state/phase-gdb.done")) {
    hierarchy.errors.push("phase completion marker must be absent before publication");
  }
  if (markerMode === "before" && allowedCandidateName !== null &&
      !hierarchy.inspectMissing("results", "gdb.manifest", "results/gdb.manifest")) {
    hierarchy.errors.push("authoritative GDB manifest must be absent before publication");
  }
  if (markerMode === "complete" && marker === null) {
    hierarchy.errors.push("phase completion marker is missing or invalid");
  }
  checkCandidateNamespace(hierarchy, allowedCandidateName);
  const manifest = parseManifest(hierarchy, manifestName, expected);
  const meta = readMeta(hierarchy);
  if (!manifest || !meta) return invalid(hierarchy.errors, manifest?.generation ?? null);
  if (manifest.maxRuns !== expected.maxRuns || manifest.maxCaptures !== expected.maxCaptures) {
    hierarchy.errors.push("GDB manifest configuration conflicts with expected limits");
  }
  if (manifest.status !== meta.status) hierarchy.errors.push("GDB manifest status conflicts with metadata");
  if (manifest.metaBytes !== Number(meta.file.bytes) || manifest.metaSha256 !== meta.file.sha256) {
    hierarchy.errors.push("GDB manifest META digest or size does not match results/gdb.meta");
  }
  exactInventory(hierarchy, manifest.status, expected);
  let runner = null;
  if (manifest.status === "SKIPPED") {
    if (manifest.skipKind !== meta.kind) hierarchy.errors.push("GDB manifest skip kind conflicts with metadata");
    if (expected.cpu !== null) {
      // Skip evidence is intentionally CPU-independent; an expected target is
      // accepted but never written into or inferred from the skip envelope.
    }
  } else {
    if (expected.cpu === null) hierarchy.errors.push("run GDB evidence requires an expected CPU");
    if (manifest.cpu !== expected.cpu) hierarchy.errors.push("GDB manifest CPU conflicts with the expected CPU");
    if (GENERATION_RE.test(manifest.generation ?? "") && expected.cpu !== null) {
      runner = scanRunner(hierarchy, { ...expected, generation: manifest.generation });
      checkTerminalRules(hierarchy, meta, runner, expected);
    }
    checkManifestRunnerBinding(hierarchy, manifest, runner);
  }
  options.afterArtifactScan?.();
  if (manifest.status === "RUN" && runner !== null && expected.cpu !== null &&
      GENERATION_RE.test(manifest.generation ?? "")) {
    const repeated = scanRunner(
      hierarchy,
      { ...expected, generation: manifest.generation },
      null,
      { hold: true },
    );
    checkTerminalRules(hierarchy, meta, repeated, expected);
    checkManifestRunnerBinding(hierarchy, manifest, repeated);
    if (!sameRunnerEvidence(runner, repeated)) {
      hierarchy.errors.push("GDB artifacts changed between validation passes");
    }
    if (repeated !== null) runner = repeated;
  }
  exactInventory(hierarchy, manifest.status, expected);
  checkCandidateNamespace(hierarchy, allowedCandidateName);
  hierarchy.verify();
  if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, manifest.generation);
  const outcome = manifest.status === "SKIPPED"
    ? "SKIPPED"
    : runner.exitCode === 0 ? "CAPTURED" : "NO_FAULT";
  const status = markerMode === "complete" ? "complete" : "ready";
  return {
    ok: true,
    status,
    generation: manifest.generation,
    outcome: outcome.toLowerCase().replace("_", "-"),
    reasons: [],
    meta,
    manifest,
    probe: fixedProbe(status.toUpperCase(), manifest.generation, outcome),
  };
}

export function validateGdbEvidence(outDir, options = {}) {
  const hierarchy = new AnchoredHierarchy(outDir);
  try {
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors);
    return validateInHierarchy(hierarchy, options);
  } finally {
    hierarchy.close();
  }
}

export function newGdbGeneration() {
  return randomBytes(16).toString("hex");
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function removeCreatedCandidate(hierarchy, name, identity) {
  const anchored = hierarchy.anchoredPath("results", name);
  if (!anchored) return;
  try {
    const current = lstatSync(anchored, { bigint: true });
    if (sameIdentity(current, identity)) {
      unlinkSync(anchored);
      fsyncSync(hierarchy.directories.get("results").fd);
    }
  } catch {
    // Never remove a path unless it is still the file created by this call.
  }
}

export function buildGdbManifestCandidate(outDir, candidatePath, options = {}) {
  const generation = options.generation;
  if (!GENERATION_RE.test(generation ?? "")) return invalid(["candidate generation must be lowerhex32"]);
  const expected = normalizeExpectations(options);
  if (expected.reasons.length > 0) return invalid(expected.reasons, generation);
  const resolvedCandidate = path.resolve(candidatePath);
  const resultsPath = path.resolve(outDir, "results");
  const candidateName = path.basename(resolvedCandidate);
  if (path.dirname(resolvedCandidate) !== resultsPath || !CANDIDATE_RE.test(candidateName)) {
    return invalid(["candidate must be a safe hidden filename directly inside results"], generation);
  }

  let hierarchy = new AnchoredHierarchy(outDir);
  let candidateFd;
  let candidateStat;
  let created = false;
  try {
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, generation);
    if (!hierarchy.inspectMissing("state", "phase-gdb.done", "state/phase-gdb.done")) {
      hierarchy.errors.push("phase completion marker must be absent before candidate construction");
    }
    if (!hierarchy.inspectMissing("results", "gdb.manifest", "results/gdb.manifest")) {
      hierarchy.errors.push("authoritative GDB manifest must be absent before candidate construction");
    }
    checkCandidateNamespace(hierarchy);
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, generation);
    let anchored = hierarchy.anchoredPath("results", candidateName);
    try {
      candidateFd = openSync(
        anchored,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      fchmodSync(candidateFd, 0o600);
      candidateStat = fstatSync(candidateFd, { bigint: true });
      const candidatePathStat = lstatSync(anchored, { bigint: true });
      if (!candidateStat.isFile() || candidateStat.nlink !== 1n ||
          !ownedByEffectiveUser(candidateStat) || !ownedByEffectiveUser(candidatePathStat) ||
          (candidateStat.mode & 0o777n) !== 0o600n) {
        throw new Error("candidate is not a private single-link regular file");
      }
      if (!stableFile(candidateStat, candidatePathStat)) throw new Error("candidate changed while being created");
    } catch (error) {
      hierarchy.errors.push(error?.code === "EEXIST"
        ? "candidate already exists"
        : error?.message ?? "candidate could not be created exclusively");
      return invalid(hierarchy.errors, generation);
    }
    // Re-open the hierarchy after the one intentional directory-entry
    // mutation. From this point onward every directory timestamp is stable
    // from its initial snapshot through final verification.
    hierarchy.close();
    hierarchy = new AnchoredHierarchy(outDir);
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, generation);
    if (!hierarchy.inspectMissing("state", "phase-gdb.done", "state/phase-gdb.done")) {
      hierarchy.errors.push("phase completion marker must be absent before candidate construction");
    }
    if (!hierarchy.inspectMissing("results", "gdb.manifest", "results/gdb.manifest")) {
      hierarchy.errors.push("authoritative GDB manifest must be absent before candidate construction");
    }
    anchored = hierarchy.anchoredPath("results", candidateName);
    checkCandidateNamespace(hierarchy, candidateName);

    const meta = readMeta(hierarchy);
    if (!meta) return invalid(hierarchy.errors, generation);
    exactInventory(hierarchy, meta.status, expected);
    let runner = null;
    const runExpected = { ...expected, generation };
    if (meta.status === "RUN") {
      if (expected.cpu === null) hierarchy.errors.push("run GDB evidence requires an expected CPU");
      else {
        runner = scanRunner(hierarchy, runExpected);
        checkTerminalRules(hierarchy, meta, runner, expected);
      }
    }
    if (hierarchy.errors.length > 0 || (meta.status === "RUN" && runner === null)) {
      return invalid(hierarchy.errors, generation);
    }

    const writeLine = (line) => writeAll(candidateFd, Buffer.from(`${line}\n`, "ascii"));
    writeLine("VERSION\t1");
    writeLine(`GENERATION\t${generation}`);
    writeLine(`STATUS\t${meta.status}`);
    writeLine(`CONFIG\tMAX_RUNS\t${expected.maxRuns}`);
    writeLine(`CONFIG\tMAX_CAPTURES\t${expected.maxCaptures}`);
    if (meta.status === "SKIPPED") {
      writeLine(`SKIP\t${meta.kind}`);
      writeLine(`META\tresults/gdb.meta\t${meta.file.bytes}\t${meta.file.sha256}`);
    } else {
      writeLine(`CONFIG\tCPU\t${expected.cpu}`);
      writeLine(`META\tresults/gdb.meta\t${meta.file.bytes}\t${meta.file.sha256}`);
      writeLine(`RUNNER\tlogs/gdb/runner.log\t${runner.file.bytes}\t${runner.file.sha256}`);
      const repeated = scanRunner(
        hierarchy,
        runExpected,
        ({ id, outcome, relative, bytes, sha256 }) => {
          writeLine(`ATTEMPT\t${id}\t${outcome}\t${relative}\t${bytes}\t${sha256}`);
        },
        { hold: true },
      );
      checkTerminalRules(hierarchy, meta, repeated, expected);
      if (repeated === null || repeated.recordsSha256 !== runner.recordsSha256 ||
          repeated.file.sha256 !== runner.file.sha256 || repeated.file.bytes !== runner.file.bytes) {
        hierarchy.errors.push("GDB artifacts changed between candidate construction passes");
      }
    }
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, generation);
    fsyncSync(candidateFd);
    const finalCandidateStat = fstatSync(candidateFd, { bigint: true });
    const finalCandidatePathStat = lstatSync(anchored, { bigint: true });
    if (!stableFile(finalCandidateStat, finalCandidatePathStat) || finalCandidateStat.nlink !== 1n ||
        !ownedByEffectiveUser(finalCandidateStat) || !ownedByEffectiveUser(finalCandidatePathStat) ||
        (finalCandidateStat.mode & 0o777n) !== 0o600n) {
      throw new Error("candidate changed while being written");
    }
    closeSync(candidateFd);
    candidateFd = undefined;
    fsyncSync(hierarchy.directories.get("results").fd);
    exactInventory(hierarchy, meta.status, expected);
    checkCandidateNamespace(hierarchy, candidateName);
    hierarchy.verify();
    if (hierarchy.errors.length > 0) return invalid(hierarchy.errors, generation);
  } catch (error) {
    hierarchy.errors.push(error?.message ?? "candidate construction failed");
    return invalid(hierarchy.errors, generation);
  } finally {
    closeQuietly(candidateFd);
    if (hierarchy.errors.length > 0 && created && candidateStat) {
      removeCreatedCandidate(hierarchy, candidateName, candidateStat);
    }
    hierarchy.close();
  }

  const validated = validateGdbEvidence(outDir, {
    markerMode: "before",
    manifestPath: resolvedCandidate,
    expectedCpu: expected.cpu,
    expectedMaxRuns: expected.maxRuns,
    expectedMaxCaptures: expected.maxCaptures,
  });
  if (!validated.ok) {
    const cleanup = new AnchoredHierarchy(outDir);
    try {
      if (cleanup.errors.length === 0 && candidateStat) removeCreatedCandidate(cleanup, candidateName, candidateStat);
    } finally {
      cleanup.close();
    }
    return validated;
  }
  return validated;
}

function cliCpu(value) {
  return value === "-" ? null : value;
}

function usage() {
  process.stderr.write(
    "usage: gdb-evidence.mjs new-generation | " +
    "build BUNDLE CANDIDATE GENERATION CPU|- MAX_RUNS MAX_CAPTURES | " +
    "validate-before BUNDLE MANIFEST CPU|- MAX_RUNS MAX_CAPTURES | " +
    "validate-complete BUNDLE CPU|- MAX_RUNS MAX_CAPTURES\n",
  );
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "new-generation" && args.length === 0) {
    process.stdout.write(`${newGdbGeneration()}\n`);
    return 0;
  }
  let result;
  if (command === "build" && args.length === 6) {
    result = buildGdbManifestCandidate(args[0], args[1], {
      generation: args[2],
      expectedCpu: cliCpu(args[3]),
      expectedMaxRuns: args[4],
      expectedMaxCaptures: args[5],
    });
  } else if (command === "validate-before" && args.length === 5) {
    const bundle = path.resolve(args[0]);
    const candidate = path.resolve(args[1]);
    if (path.dirname(candidate) !== path.join(bundle, "results")) {
      result = invalid(["candidate must be directly inside the selected bundle results directory"]);
    } else {
      result = validateGdbEvidence(bundle, {
        markerMode: "before",
        manifestPath: candidate,
        expectedCpu: cliCpu(args[2]),
        expectedMaxRuns: args[3],
        expectedMaxCaptures: args[4],
      });
    }
  } else if (command === "validate-complete" && args.length === 4) {
    result = validateGdbEvidence(args[0], {
      markerMode: "complete",
      expectedCpu: cliCpu(args[1]),
      expectedMaxRuns: args[2],
      expectedMaxCaptures: args[3],
    });
  } else {
    usage();
    return 2;
  }
  process.stdout.write(`${result.probe}\n`);
  if (!result.ok) process.stderr.write(`gdb evidence invalid: ${result.reasons[0]}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
