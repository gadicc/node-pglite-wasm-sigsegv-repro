#!/usr/bin/env node

import { createHash } from "node:crypto";
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

const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;
const BUFFER_BYTES = 64 * 1024;
const BUFFER_BYTES_BIGINT = BigInt(BUFFER_BYTES);
const DESTINATION_MODE = 0o600n;
const PERMISSION_MASK = 0o7777n;
const CONTROL_BYTES = 70n;
const JOURNAL_BYTES = 16_384n;
const SHA256_RE = "[0-9a-f]{64}";
const TRANSACTION_RE = "(?:[0-9a-f]{32}|legacy-[0-9a-f]{64})";
const PATH_STATE_RE = `(?:A|[FL]:${SHA256_RE})`;
const COMMAND_BASE_RE = `(?:A|F:${SHA256_RE})`;
const ARTIFACTS = new Set([
  "results/frequency-ab.tsv",
  "results/frequency-ab.meta",
  "results/frequency-cap.tsv",
  "results/frequency-cap.meta",
  "freq/freq-ab-A1.samples",
  "freq/freq-ab-A1.method",
  "freq/freq-ab-B.samples",
  "freq/freq-ab-B.method",
  "freq/freq-ab-A2.samples",
  "freq/freq-ab-A2.method",
  "freq/freq-ab-cap.samples",
  "freq/freq-ab-cap.method",
]);
const CAP_ARTIFACTS = new Set([
  "results/frequency-cap.tsv",
  "results/frequency-cap.meta",
  "freq/freq-ab-cap.samples",
  "freq/freq-ab-cap.method",
]);

function fail(message) {
  throw new Error(message);
}

export function parsePositiveMax(value) {
  if (!POSITIVE_DECIMAL_RE.test(value ?? "")) {
    fail("max-bytes must be a canonical positive decimal integer");
  }
  return BigInt(value);
}

function sourceStatIsStable(before, after) {
  return after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function destinationStatIsSafe(stat, expectedSize) {
  return stat.isFile() &&
    (stat.mode & PERMISSION_MASK) === DESTINATION_MODE &&
    stat.nlink === 1n &&
    stat.size === expectedSize;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // A completed fsync is the durability boundary. There is no safer recovery
    // action for a descriptor that the kernel has already rejected closing.
  }
}

function removeOwnPartial(destination, destinationFd) {
  if (destinationFd === undefined) return;
  try {
    const opened = fstatSync(destinationFd, { bigint: true });
    const current = lstatSync(destination, { bigint: true });
    if (!opened.isFile() || !current.isFile() || !sameIdentity(opened, current)) return;
    unlinkSync(destination);
  } catch {
    // Cleanup is deliberately best-effort. In particular, never unlink a path
    // that cannot still be bound to the descriptor created by this process.
  }
}

function openStableSource(source, maxBytes) {
  const pathBefore = lstatSync(source, { bigint: true });
  if (!pathBefore.isFile()) fail("source must be a regular file");
  const fd = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    const pathAfterOpen = lstatSync(source, { bigint: true });
    if (!sourceStatIsStable(pathBefore, stat) ||
      !sourceStatIsStable(stat, pathAfterOpen)) {
      fail("source changed while being opened");
    }
    if (stat.size > maxBytes) fail("source exceeds max-bytes");
    return { fd, stat };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function streamAndHash(sourceFd, maxBytes, destinationFd, retainBytes = false) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  const chunks = retainBytes ? [] : undefined;
  let total = 0n;

  while (true) {
    const remainingWithSentinel = maxBytes - total + 1n;
    const requested = Number(
      remainingWithSentinel < BUFFER_BYTES_BIGINT
        ? remainingWithSentinel
        : BUFFER_BYTES_BIGINT,
    );
    const count = readSync(sourceFd, buffer, 0, requested, null);
    if (count === 0) break;

    total += BigInt(count);
    if (total > maxBytes) fail("source exceeds max-bytes");

    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    if (chunks) chunks.push(Buffer.from(chunk));
    if (destinationFd !== undefined) {
      let written = 0;
      while (written < count) {
        const result = writeSync(
          destinationFd,
          chunk,
          written,
          count - written,
          null,
        );
        if (result === 0) fail("destination write made no progress");
        written += result;
      }
    }
  }

  const result = { size: total, sha256: hash.digest("hex") };
  if (chunks) result.bytes = Buffer.concat(chunks);
  return result;
}

function verifyStableSource(source, sourceFd, before, actualSize) {
  const after = fstatSync(sourceFd, { bigint: true });
  const pathAfterRead = lstatSync(source, { bigint: true });
  if (!sourceStatIsStable(before, after) ||
    !sourceStatIsStable(after, pathAfterRead) ||
    actualSize !== before.size) {
    fail("source changed while being read");
  }
}

export function hashFile(source, maxBytes) {
  const opened = openStableSource(source, maxBytes);
  try {
    const result = streamAndHash(opened.fd, maxBytes);
    verifyStableSource(source, opened.fd, opened.stat, result.size);
    return result;
  } finally {
    closeQuietly(opened.fd);
  }
}

function readStableBytes(source, maxBytes) {
  const opened = openStableSource(source, maxBytes);
  try {
    const result = streamAndHash(opened.fd, maxBytes, undefined, true);
    verifyStableSource(source, opened.fd, opened.stat, result.size);
    if (BigInt(result.bytes.length) !== result.size) {
      fail("retained source size mismatch");
    }
    return result;
  } finally {
    closeQuietly(opened.fd);
  }
}

function canonicalAsciiText(bytes, label) {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    fail(`${label} must be nonempty and newline-terminated`);
  }
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && (byte < 0x20 || byte > 0x7e)) {
      fail(`${label} contains a noncanonical byte`);
    }
  }
  return bytes.toString("ascii");
}

export function parseControlFile(source) {
  const result = readStableBytes(source, CONTROL_BYTES);
  if (result.size !== CONTROL_BYTES) fail("control has a noncanonical size");
  const text = canonicalAsciiText(result.bytes, "control");
  const lines = text.split("\n");
  if (lines.length !== 4 || lines[0] !== "VERSION=1" || lines[3] !== "") {
    fail("control has a noncanonical structure");
  }
  const generation = /^GENERATION=([0-9a-f]{32})$/.exec(lines[1]);
  const capRequested = /^CAP_REQUESTED=([01])$/.exec(lines[2]);
  if (!generation || !capRequested) fail("control has malformed fields");
  return {
    ...result,
    generation: generation[1],
    capRequested: capRequested[1],
  };
}

export function parseJournalFile(source) {
  const result = readStableBytes(source, JOURNAL_BYTES);
  const text = canonicalAsciiText(result.bytes, "journal");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 6 || lines.length > 32 || lines[0] !== "VERSION\t1") {
    fail("journal has a noncanonical structure");
  }
  if (!/^STATE\t(?:PREPARED|COMMITTED)$/.test(lines[1]) ||
    !(new RegExp(`^TRANSACTION\\t${TRANSACTION_RE}$`)).test(lines[2]) ||
    !/^BUNDLE_ID\t[0-9]+:[0-9]+$/.test(lines[3]) ||
    !/^CAP_CLEANUP\t[01]$/.test(lines[4]) ||
    !(new RegExp(`^COMMAND\\t${SHA256_RE}\\t${COMMAND_BASE_RE}\\t${SHA256_RE}$`)).test(lines[5])) {
    fail("journal has malformed fixed fields");
  }
  const artifactPattern = new RegExp(
    `^ARTIFACT\\t([^\\t]+)\\t${SHA256_RE}\\t${PATH_STATE_RE}$`,
  );
  const deletePattern = new RegExp(`^DELETE\\t([^\\t]+)\\t${PATH_STATE_RE}$`);
  for (const line of lines.slice(6)) {
    const artifact = artifactPattern.exec(line);
    if (artifact) {
      if (!ARTIFACTS.has(artifact[1])) fail("journal has an unknown artifact");
      continue;
    }
    const deletion = deletePattern.exec(line);
    if (!deletion || !CAP_ARTIFACTS.has(deletion[1])) {
      fail("journal has a malformed mutation record");
    }
  }
  return { ...result, text };
}

export function copyFile(source, destination, maxBytes) {
  const openedSource = openStableSource(source, maxBytes);
  let destinationFd;
  let destinationCreated = false;

  try {
    destinationFd = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      Number(DESTINATION_MODE),
    );
    destinationCreated = true;
    fchmodSync(destinationFd, Number(DESTINATION_MODE));

    const result = streamAndHash(openedSource.fd, maxBytes, destinationFd);
    fsyncSync(destinationFd);
    verifyStableSource(source, openedSource.fd, openedSource.stat, result.size);

    const destinationStat = fstatSync(destinationFd, { bigint: true });
    const pathStat = lstatSync(destination, { bigint: true });
    if (!destinationStatIsSafe(destinationStat, result.size) ||
      !destinationStatIsSafe(pathStat, result.size) ||
      !sameIdentity(destinationStat, pathStat)) {
      fail("destination changed or is unsafe");
    }

    return result;
  } catch (error) {
    if (destinationCreated) removeOwnPartial(destination, destinationFd);
    throw error;
  } finally {
    closeQuietly(destinationFd);
    closeQuietly(openedSource.fd);
  }
}

function formatResult(result) {
  return `${result.size}\t${result.sha256}\n`;
}

function formatControl(result) {
  return `CONTROL\t${result.size}\t${result.sha256}\t${result.generation}\t${result.capRequested}\n`;
}

function formatJournal(result) {
  return `JOURNAL\t${result.size}\t${result.sha256}\n${result.text}`;
}

export function runCli(argv) {
  const [operation, ...args] = argv;
  if (operation === "hash" && args.length === 2) {
    const [source, maxValue] = args;
    return formatResult(hashFile(source, parsePositiveMax(maxValue)));
  }
  if (operation === "copy" && args.length === 3) {
    const [source, destination, maxValue] = args;
    return formatResult(copyFile(source, destination, parsePositiveMax(maxValue)));
  }
  if (operation === "control" && args.length === 1) {
    return formatControl(parseControlFile(args[0]));
  }
  if (operation === "journal" && args.length === 1) {
    return formatJournal(parseJournalFile(args[0]));
  }
  fail("usage: publish-frequency-io.mjs hash <path> <max-bytes> | copy <source> <exclusive-destination> <max-bytes> | control <path> | journal <path>");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
