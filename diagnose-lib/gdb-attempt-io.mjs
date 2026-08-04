#!/usr/bin/env node

// Convert one bounded stream of GDB output into a private, provenance-bound
// transcript. A hidden spool is used because the outcome is part of the first
// line but is not known until the input stream ends. Clean spools are removed;
// captured and error transcripts are published with O_EXCL.
//
// Input is cut off at the evidence size limit: reading stops at the first
// overflowing chunk (a stream input is destroyed, so its producer may die with
// SIGPIPE) and a bounded truncated transcript is still published with OUTCOME
// error. The attempt result is then the distinct status "overflow" rather than
// "clean"/"captured"/"error", so the pipe coordinator records an error attempt
// and attributes any producer SIGPIPE to this helper instead of treating the
// producer's termination as a separate successful capture.

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
import { GDB_TRANSCRIPT_MAX_BYTES } from "./gdb-evidence.mjs";

const GENERATION_RE = /^[0-9a-f]{32}$/;
const BUFFER_BYTES = 64 * 1024;
const CAPTURED_PATTERN = Buffer.from("received signal SIGSEGV");
const CLEAN_PATTERN = Buffer.from("exited normally");
const TRUNCATED_LINE = Buffer.from("[gdb output truncated at the evidence size limit]\n");

function canonicalUint(value, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max || (positive && parsed === 0)) return null;
  return parsed;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(left, right) {
  return right.isFile() && sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // The operation has already succeeded or failed.
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

// The publication filesystem operations, bundled so tests can force individual
// failures. Production always runs with the real bindings.
const REAL_FS_OPS = { fchmodSync, fstatSync, fsyncSync, lstatSync, unlinkSync };

// Successful cleanups are mandatory: the created file must still have its
// recorded identity, the unlink must succeed, the directory must be synced,
// and the name must be gone afterwards. Rollback cleanups stay best-effort.
function removeCreated(directoryFd, name, identity, { required = false, ops = REAL_FS_OPS } = {}) {
  if (!identity) return;
  const anchored = `/proc/self/fd/${directoryFd}/${name}`;
  try {
    const current = ops.lstatSync(anchored, { bigint: true });
    if (!sameIdentity(current, identity)) {
      throw new Error("created GDB transcript file changed before its removal");
    }
    ops.unlinkSync(anchored);
    if (!required) return;
    ops.fsyncSync(directoryFd);
    try {
      ops.lstatSync(anchored);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    throw new Error("created GDB transcript file remains after its removal");
  } catch (error) {
    if (required) throw error;
    // Never remove a path that cannot still be proved to be ours.
  }
}

function openOwnedDirectory(directory, ops) {
  const absolute = path.resolve(directory);
  const owner = BigInt(process.geteuid?.() ?? process.getuid());
  const before = ops.lstatSync(absolute, { bigint: true });
  if (!before.isDirectory() || before.uid !== owner) {
    throw new Error("GDB transcript directory must be a real current-user-owned directory");
  }
  const fd = openSync(
    absolute,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = ops.fstatSync(fd, { bigint: true });
    const after = ops.lstatSync(absolute, { bigint: true });
    if (!opened.isDirectory() || opened.uid !== owner || !sameIdentity(before, opened) ||
        !sameIdentity(opened, after) || before.mtimeNs !== opened.mtimeNs ||
        before.ctimeNs !== opened.ctimeNs || opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs) {
      throw new Error("GDB transcript directory changed while being opened");
    }
    return { absolute, fd, stat: opened, owner };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function createPrivate(directory, name, ops) {
  const anchored = `/proc/self/fd/${directory.fd}/${name}`;
  const fd = openSync(
    anchored,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    ops.fchmodSync(fd, 0o600);
    const opened = ops.fstatSync(fd, { bigint: true });
    const named = ops.lstatSync(anchored, { bigint: true });
    if (!opened.isFile() || opened.uid !== directory.owner || opened.nlink !== 1n ||
        (opened.mode & 0o777n) !== 0o600n || !stableFile(opened, named)) {
      throw new Error("new GDB transcript file is not a private stable regular file");
    }
    return { fd, stat: opened, anchored };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function verifyDirectory(directory, allowMutation) {
  const descriptor = fstatSync(directory.fd, { bigint: true });
  const pathname = lstatSync(directory.absolute, { bigint: true });
  if (!descriptor.isDirectory() || descriptor.uid !== directory.owner ||
      !sameIdentity(directory.stat, descriptor) || !sameIdentity(descriptor, pathname)) {
    throw new Error("GDB transcript directory changed during publication");
  }
  if (!allowMutation && (directory.stat.mtimeNs !== descriptor.mtimeNs ||
      directory.stat.ctimeNs !== descriptor.ctimeNs)) {
    throw new Error("GDB transcript directory changed unexpectedly during publication");
  }
}

function provenanceHeader(values, outcome) {
  return Buffer.from(
    `GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t${values.generation}` +
      `\tCPU\t${values.cpu}\tMAX_RUNS\t${values.maxRuns}` +
      `\tMAX_CAPTURES\t${values.maxCaptures}\tRUN\t${values.run}` +
      `\tOUTCOME\t${outcome}\n`,
    "ascii",
  );
}

function provenanceFooter(values, outcome) {
  return Buffer.from(
    `GDB_TRANSCRIPT_END\tGENERATION\t${values.generation}` +
      `\tCPU\t${values.cpu}\tRUN\t${values.run}\tOUTCOME\t${outcome}\n`,
    "ascii",
  );
}

function includesPattern(tail, chunk, pattern) {
  return Buffer.concat([tail, chunk]).includes(pattern);
}

function nextTail(tail, chunk) {
  const keep = Math.max(CAPTURED_PATTERN.length, CLEAN_PATTERN.length) - 1;
  const joined = Buffer.concat([tail, chunk]);
  return joined.subarray(Math.max(0, joined.length - keep));
}

export async function publishGdbAttempt(directoryPath, values, input = process.stdin, fsOps = {}) {
  const ops = { ...REAL_FS_OPS, ...fsOps };
  const directory = openOwnedDirectory(directoryPath, ops);
  const spoolName = `.gdb-attempt.${values.generation}.${values.run}.tmp`;
  const finalName = `cpu${values.cpu}-run${values.run}.txt`;
  let spool;
  let final;
  let directoryMutated = false;
  try {
    spool = createPrivate(directory, spoolName, ops);
    directoryMutated = true;

    const largestHeader = provenanceHeader(values, "captured");
    const largestFooter = provenanceFooter(values, "captured");
    const bodyLimit = GDB_TRANSCRIPT_MAX_BYTES - largestHeader.length - largestFooter.length -
      TRUNCATED_LINE.length - 1;
    if (bodyLimit < 0) throw new Error("GDB transcript configuration leaves no body capacity");

    let stored = 0;
    let lastStoredByte = null;
    let overflow = false;
    let captured = false;
    let clean = false;
    let tail = Buffer.alloc(0);
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (!captured && includesPattern(tail, chunk, CAPTURED_PATTERN)) captured = true;
      if (!clean && includesPattern(tail, chunk, CLEAN_PATTERN)) clean = true;
      tail = nextTail(tail, chunk);
      if (stored < bodyLimit) {
        const count = Math.min(chunk.length, bodyLimit - stored);
        if (count > 0) {
          const part = chunk.subarray(0, count);
          writeAll(spool.fd, part);
          stored += count;
          lastStoredByte = part.at(-1);
        }
        if (count !== chunk.length) overflow = true;
      } else if (chunk.length > 0) {
        overflow = true;
      }
      // Cut the producer off at the limit instead of draining unbounded input.
      if (overflow) break;
    }

    let outcome = captured ? "captured" : clean ? "clean" : "error";
    if (overflow) outcome = "error";
    if (outcome === "clean") {
      closeSync(spool.fd);
      spool.fd = undefined;
      removeCreated(directory.fd, spoolName, spool.stat, { required: true, ops });
      verifyDirectory(directory, true);
      return "clean";
    }

    if (lastStoredByte !== null && lastStoredByte !== 0x0a) writeAll(spool.fd, Buffer.from("\n"));
    if (overflow) writeAll(spool.fd, TRUNCATED_LINE);
    fsyncSync(spool.fd);

    final = createPrivate(directory, finalName, ops);
    const header = provenanceHeader(values, outcome);
    const footer = provenanceFooter(values, outcome);
    writeAll(final.fd, header);
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let offset = 0;
    while (true) {
      const count = readSync(spool.fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      writeAll(final.fd, buffer.subarray(0, count));
      offset += count;
    }
    if (header.length + offset + footer.length > GDB_TRANSCRIPT_MAX_BYTES) {
      throw new Error("GDB transcript exceeds its publication limit");
    }
    writeAll(final.fd, footer);
    fsyncSync(final.fd);
    const published = fstatSync(final.fd, { bigint: true });
    const named = lstatSync(final.anchored, { bigint: true });
    if (!stableFile(published, named) || published.uid !== directory.owner ||
        published.nlink !== 1n || (published.mode & 0o777n) !== 0o600n) {
      throw new Error("published GDB transcript changed during publication");
    }
    closeSync(final.fd);
    final.fd = undefined;
    closeSync(spool.fd);
    spool.fd = undefined;
    removeCreated(directory.fd, spoolName, spool.stat, { required: true, ops });
    verifyDirectory(directory, true);
    return overflow ? "overflow" : outcome;
  } catch (error) {
    closeQuietly(final?.fd);
    closeQuietly(spool?.fd);
    removeCreated(directory.fd, finalName, final?.stat, { ops });
    removeCreated(directory.fd, spoolName, spool?.stat, { ops });
    if (directoryMutated) {
      try { ops.fsyncSync(directory.fd); } catch { /* best-effort rollback sync */ }
    }
    throw error;
  } finally {
    closeQuietly(directory.fd);
  }
}

export function parseGdbAttemptArgs(args) {
  if (args.length !== 6 || !GENERATION_RE.test(args[1])) return null;
  const cpu = canonicalUint(args[2], { max: 65535 });
  const maxRuns = canonicalUint(args[3], { positive: true });
  const maxCaptures = canonicalUint(args[4], { positive: true });
  const run = canonicalUint(args[5], { positive: true });
  if (cpu === null || maxRuns === null || maxCaptures === null || run === null ||
      run > maxRuns) return null;
  return { directory: args[0], generation: args[1], cpu, maxRuns, maxCaptures, run };
}

async function main(args) {
  const parsed = parseGdbAttemptArgs(args);
  if (!parsed) {
    process.stderr.write(
      "usage: gdb-attempt-io.mjs OUT_DIR GENERATION CPU MAX_RUNS MAX_CAPTURES RUN\n",
    );
    return 2;
  }
  const { directory, ...values } = parsed;
  try {
    const outcome = await publishGdbAttempt(directory, values);
    process.stdout.write(`${outcome}\n`);
    return 0;
  } catch {
    process.stderr.write("gdb transcript publication failed\n");
    return 5;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
