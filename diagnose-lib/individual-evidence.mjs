#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  buildIsolatedOrders,
} from "./pinned-runner.mjs";

export const INDIVIDUAL_META_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_TSV_FALLBACK_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_ROW_MAX_BYTES = 44n;
export const INDIVIDUAL_V6_ROW_MAX_BYTES = 256n;
export const INDIVIDUAL_PLAN_FALLBACK_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_PLAN_ROW_MAX_BYTES = 64n;
export const INDIVIDUAL_BOUNDARIES_FALLBACK_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_BOUNDARY_ROW_MAX_BYTES = 512n;
export const INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES = 32n * 1024n;
export const INDIVIDUAL_V6_STDERR_EXCERPT_MAX_BYTES = 16 * 1024;
// Preserve the first 65,536 exact failed-run details across an ordinary
// practical bundle without allowing an all-SIGSEGV input to turn collector
// output back into an O(row count) allocation. Per-CPU counts remain exact
// within canonical RUNS_PER_CPU, and omitted details are reported explicitly.
export const INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT = 65536;

const BUFFER_BYTES = 64 * 1024;
const ALLOWED_META_KEYS = new Set([
  "VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED",
  "SKIP_REASON", "TARGET_POLICY", "GROUP_PLAN_DIGEST", "GROUP_GENERATION",
  "GENERATION", "ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT",
  "PROTOCOL", "SCHEDULE_SEED", "SCHEDULE_ALGORITHM",
  "PLAN_SHA256", "PLAN_BYTES", "PLAN_ROW_COUNT",
  "BOUNDARIES_SHA256", "BOUNDARIES_BYTES", "BOUNDARY_ROW_COUNT",
]);

const V5_ONLY_META_KEYS = [
  "PROTOCOL", "SCHEDULE_SEED", "SCHEDULE_ALGORITHM",
  "PLAN_SHA256", "PLAN_BYTES", "PLAN_ROW_COUNT",
  "BOUNDARIES_SHA256", "BOUNDARIES_BYTES", "BOUNDARY_ROW_COUNT",
];
const PLAN_HEADER = "ordinal\tround\tposition\tcpu";
const V6_RESULTS_HEADER =
  "ordinal\tround\tposition\tcpu\toutcome\texit_code\tsignal\telapsed_sec\tstderr_sha256\tstderr_bytes";
const V5_PROTOCOL = "isolated-interleaved-v1";
const V6_PROTOCOL = "isolated-outcomes-v2";
const V5_SCHEDULE_ALGORITHM = "balanced-cyclic-v1";
const V6_OUTCOMES = new Set(["pass", "sigsegv", "other-workload-failure"]);
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableRegularStat(before, after) {
  return after.isFile() &&
    sameIdentity(before, after) &&
    before.size === after.size &&
    before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs;
}

function stableDirectoryStat(before, after) {
  return after.isDirectory() &&
    sameIdentity(before, after) &&
    before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Validation is already complete or failed; there is no recovery action
    // for a descriptor the kernel rejects closing.
  }
}

function missingAtPath(file) {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function openStablePath(file, maxBytes, label, requiredOwner = null) {
  const max = BigInt(maxBytes);
  let pathBefore;
  try {
    pathBefore = lstatSync(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { present: false, file, label, errors: [], fd: undefined, stat: undefined };
    }
    return {
      present: true,
      file,
      label,
      errors: [`${label} could not be inspected`],
      fd: undefined,
      stat: undefined,
    };
  }
  if (!pathBefore.isFile() || pathBefore.nlink !== 1n) {
    return {
      present: true,
      file,
      label,
      errors: [`${label} must be a real single-link regular file`],
      fd: undefined,
      stat: undefined,
    };
  }
  if (requiredOwner !== null && pathBefore.uid !== BigInt(requiredOwner)) {
    return {
      present: true,
      file,
      label,
      errors: [`${label} must be owned by the current user`],
      fd: undefined,
      stat: undefined,
    };
  }
  if (pathBefore.size > max) {
    return {
      present: true,
      file,
      label,
      errors: [`${label} exceeds the validation size limit`],
      fd: undefined,
      stat: undefined,
    };
  }

  let fd;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd, { bigint: true });
    const pathAfterOpen = lstatSync(file, { bigint: true });
    if (!stableRegularStat(pathBefore, opened) ||
      !stableRegularStat(opened, pathAfterOpen) || opened.nlink !== 1n ||
      (requiredOwner !== null && opened.uid !== BigInt(requiredOwner))) {
      throw new Error(`${label} changed while being opened`);
    }
    return { present: true, file, label, errors: [], fd, stat: opened, requiredOwner };
  } catch (error) {
    closeQuietly(fd);
    return {
      present: true,
      file,
      label,
      errors: [error?.message === `${label} changed while being opened`
        ? error.message
        : `${label} could not be opened safely`],
      fd: undefined,
      stat: undefined,
    };
  }
}

function readOpenedPath(opened, maxBytes) {
  const max = BigInt(maxBytes);
  if (opened.fd === undefined || opened.errors.length > 0) return Buffer.alloc(0);
  const chunks = [];
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  let total = 0n;
  try {
    while (true) {
      const remaining = max - total + 1n;
      const requested = Number(remaining < BigInt(BUFFER_BYTES) ? remaining : BigInt(BUFFER_BYTES));
      const count = readSync(opened.fd, buffer, 0, requested, null);
      if (count === 0) break;
      total += BigInt(count);
      if (total > max) {
        opened.errors.push(`${opened.label} exceeds the validation size limit`);
        return Buffer.alloc(0);
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } catch {
    opened.errors.push(`${opened.label} could not be read safely`);
    return Buffer.alloc(0);
  }
  return Buffer.concat(chunks, Number(total));
}

function verifyOpenedPath(opened, actualSize, completeRead = true) {
  if (!opened.present) {
    if (!missingAtPath(opened.file)) opened.errors.push(`${opened.label} appeared while being read`);
    return;
  }
  if (opened.fd === undefined || opened.stat === undefined) return;
  try {
    const after = fstatSync(opened.fd, { bigint: true });
    const pathAfterRead = lstatSync(opened.file, { bigint: true });
    if (!stableRegularStat(opened.stat, after) ||
      !stableRegularStat(after, pathAfterRead) ||
      after.nlink !== 1n ||
      (opened.requiredOwner !== null && after.uid !== BigInt(opened.requiredOwner)) ||
      (completeRead && BigInt(actualSize) !== opened.stat.size)) {
      opened.errors.push(`${opened.label} changed while being read`);
    }
  } catch {
    opened.errors.push(`${opened.label} changed while being read`);
  }
}

export function readStableRegularFile(file, maxBytes, label, options = {}) {
  const opened = openStablePath(file, maxBytes, label, options.requiredOwner ?? null);
  let bytes = Buffer.alloc(0);
  try {
    bytes = readOpenedPath(opened, maxBytes);
    options.afterRead?.();
    verifyOpenedPath(opened, bytes.length);
    return {
      present: opened.present,
      bytes: opened.errors.length === 0 ? bytes : null,
      errors: [...new Set(opened.errors)],
    };
  } finally {
    closeQuietly(opened.fd);
  }
}

function openStableDirectory(dir, label, required) {
  let before;
  try {
    before = lstatSync(dir, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" && !required) {
      return { present: false, dir, label, errors: [], fd: undefined, stat: undefined };
    }
    return {
      present: false,
      dir,
      label,
      errors: [`${label} is missing or could not be inspected`],
      fd: undefined,
      stat: undefined,
    };
  }
  if (!before.isDirectory()) {
    return {
      present: true,
      dir,
      label,
      errors: [`${label} must be a real directory`],
      fd: undefined,
      stat: undefined,
    };
  }
  let fd;
  try {
    fd = openSync(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(dir, { bigint: true });
    if (!stableDirectoryStat(before, opened) || !stableDirectoryStat(opened, afterOpen)) {
      throw new Error(`${label} changed while being opened`);
    }
    return { present: true, dir, label, errors: [], fd, stat: opened };
  } catch (error) {
    closeQuietly(fd);
    return {
      present: true,
      dir,
      label,
      errors: [error?.message === `${label} changed while being opened`
        ? error.message
        : `${label} could not be opened safely`],
      fd: undefined,
      stat: undefined,
    };
  }
}

function verifyStableDirectory(opened) {
  if (!opened.present) {
    if (!missingAtPath(opened.dir)) opened.errors.push(`${opened.label} appeared while being read`);
    return;
  }
  if (opened.fd === undefined || opened.stat === undefined) return;
  try {
    const after = fstatSync(opened.fd, { bigint: true });
    const pathAfterRead = lstatSync(opened.dir, { bigint: true });
    if (!stableDirectoryStat(opened.stat, after) ||
      !stableDirectoryStat(after, pathAfterRead)) {
      opened.errors.push(`${opened.label} changed while being read`);
    }
  } catch {
    opened.errors.push(`${opened.label} changed while being read`);
  }
}

function fdChildPath(directory, child) {
  if (directory.fd === undefined || directory.errors.length > 0) return null;
  return `/proc/self/fd/${directory.fd}/${child}`;
}

function parseIndividualMeta(inspected) {
  const values = {};
  const errors = [...inspected.errors];
  if (!inspected.present || inspected.bytes === null) {
    return { present: inspected.present, values, errors };
  }
  const lines = inspected.bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !ALLOWED_META_KEYS.has(match[1]) || Object.hasOwn(values, match[1])) {
      errors.push("individual metadata contains a malformed, duplicate, or unknown field");
      continue;
    }
    values[match[1]] = match[2];
  }
  return { present: true, values, errors: [...new Set(errors)] };
}

function parseCanonicalCpuList(list) {
  if (typeof list !== "string" || list === "") return null;
  const set = new Set();
  let previous = -1;
  let firstPart = true;
  for (const part of list.split(",")) {
    const match = part.match(/^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/);
    if (!match) return null;
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > 65535 || last > 65535 ||
        first > last || (match[2] !== undefined && first === last) || (!firstPart && first <= previous + 1)) return null;
    for (let cpu = first; cpu <= last; cpu += 1) set.add(cpu);
    previous = last;
    firstPart = false;
  }
  return set;
}

function canonicalUint(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function newCpuSummary(cpu) {
  return {
    cpu,
    runs: 0,
    failures: 0,
    sigsegv: 0,
    otherFailures: 0,
    invalidRuns: [],
    failedRuns: [],
  };
}

function createRowAccumulator(targets, expected, batch = null, options = {}) {
  const counts = new Map(targets ? [...targets].map((cpu) => [cpu, 0]) : []);
  const sigsegv = new Map(targets ? [...targets].map((cpu) => [cpu, 0]) : []);
  const byCpu = new Map();
  const ambiguousCpus = new Set();
  let invalidRows = false;
  let batchRows = 0;
  let batchSigsegv = 0;
  let retainedFailureDetails = 0;
  const planOrders = options.planOrders ?? null;
  const authorityRowLimit = options.authorityRowLimit ?? Number.MAX_SAFE_INTEGER;
  const onAcceptedRow = typeof options.onAcceptedRow === "function"
    ? options.onAcceptedRow
    : null;
  let exactPlanPrefix = true;
  let validatedPlanPrefixRows = 0;

  const reject = (cpu = null, ambiguous = false) => {
    invalidRows = true;
    if (planOrders !== null) exactPlanPrefix = false;
    else if (ambiguous && cpu !== null && targets?.has(cpu)) ambiguousCpus.add(cpu);
  };
  const acceptFields = (fields, ordinal = null) => {
    if (planOrders !== null && !exactPlanPrefix) {
      invalidRows = true;
      return;
    }
    if (fields.length !== 4) {
      const cpu = canonicalUint(fields[0]);
      reject(cpu, true);
      return;
    }
    const [cpuText, runText, rcText, elapsedText] = fields;
    const cpu = canonicalUint(cpuText);
    const run = canonicalUint(runText);
    const rc = canonicalUint(rcText);
    const elapsed = canonicalUint(elapsedText);
    if (cpu === null || !targets?.has(cpu)) {
      reject();
      return;
    }
    if (run === null || rc === null || elapsed === null || run < 1 ||
      (expected !== null && run > expected)) {
      reject(cpu, true);
      return;
    }
    if (planOrders !== null) {
      const cpuCount = planOrders[0]?.length ?? 0;
      const planIndex = ordinal === null ? -1 : ordinal - 1;
      const roundIndex = cpuCount === 0 ? -1 : Math.floor(planIndex / cpuCount);
      const positionIndex = cpuCount === 0 ? -1 : planIndex % cpuCount;
      if (planIndex < 0 || roundIndex >= planOrders.length ||
          cpu !== planOrders[roundIndex][positionIndex] || run !== roundIndex + 1) {
        reject(cpu, true);
        return;
      }
    }
    const next = (counts.get(cpu) ?? 0) + 1;
    if (run !== next) {
      reject(cpu, true);
      return;
    }
    counts.set(cpu, next);
    if (rc !== 0 && rc !== 139) {
      reject();
      return;
    }

    if (planOrders !== null) validatedPlanPrefixRows += 1;
    if (ordinal !== null && ordinal > authorityRowLimit) return;

    onAcceptedRow?.({ ordinal, cpu, run, rc, elapsedSec: elapsed });

    let record = byCpu.get(cpu);
    if (!record) {
      record = newCpuSummary(cpu);
      byCpu.set(cpu, record);
    }
    record.runs += 1;
    if (rc === 139) {
      record.failures += 1;
      record.sigsegv += 1;
      sigsegv.set(cpu, (sigsegv.get(cpu) ?? 0) + 1);
      if (retainedFailureDetails < INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT) {
        record.failedRuns.push({ run, rc, signal: "SIGSEGV", elapsedSec: elapsed });
        retainedFailureDetails += 1;
      }
    }
    if (batch && cpu === batch.cpu && run > batch.before) {
      batchRows += 1;
      if (rc === 139) batchSigsegv += 1;
    }
  };
  const finish = () => {
    const summaries = [...byCpu.values()]
      .filter((record) => !ambiguousCpus.has(record.cpu))
      .sort((left, right) => left.cpu - right.cpu)
      .map((record) => {
        const omitted = record.failedRuns.length < record.failures
          ? record.failures - record.failedRuns.length
          : 0;
        return omitted > 0 ? { ...record, failedRunsOmitted: omitted } : record;
      });
    const omittedDetails = summaries.reduce(
      (total, record) => total + BigInt(record.failedRunsOmitted ?? 0),
      0n,
    );
    const result = {
      counts,
      sigsegv,
      summaries,
      ambiguousCpus,
      invalidRows,
      batchRows,
      batchSigsegv,
      failedRunDetailsOmitted: omittedDetails <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(omittedDetails)
        : omittedDetails.toString(),
      failedRunDetailsOmittedIsDecimalString: omittedDetails > BigInt(Number.MAX_SAFE_INTEGER),
    };
    if (planOrders !== null) result.validatedPlanPrefixRows = validatedPlanPrefixRows;
    return result;
  };
  return { acceptFields, reject, finish };
}

function validateV6OutcomeStatus(outcome, exitCode, signal) {
  if (!V6_OUTCOMES.has(outcome)) return false;
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) return false;
  if (signal !== null && (typeof signal !== "string" || !KNOWN_SIGNALS.has(signal))) return false;
  if ((exitCode === null) === (signal === null)) return false;
  if (outcome === "pass") return exitCode === 0 && signal === null;
  if (outcome === "sigsegv") return exitCode === null && signal === "SIGSEGV";
  return exitCode !== 0 && signal !== "SIGSEGV";
}

function createV6RowAccumulator(schedule, options = {}) {
  const counts = new Map([...schedule.targets].map((cpu) => [cpu, 0]));
  const byCpu = new Map();
  const boundaries = options.boundaries ?? [];
  const authorityRowLimit = options.authorityRowLimit ?? 0;
  const onAcceptedRow = typeof options.onAcceptedRow === "function" ? options.onAcceptedRow : null;
  let invalidRows = false;
  let retainedFailureDetails = 0;
  let validatedPlanPrefixRows = 0;

  const acceptLine = (line, ordinal, errors) => {
    const fields = line.split("\t");
    if (fields.length !== 10 || schedule.orders === null) {
      invalidRows = true;
      errors.push("individual V6 results contain a malformed row");
      return;
    }
    const [ordinalText, roundText, positionText, cpuText, outcome,
      exitCodeText, signalText, elapsedText, stderrSha256, stderrBytes] = fields;
    const rowOrdinal = canonicalUint(ordinalText);
    const round = canonicalUint(roundText);
    const position = canonicalUint(positionText);
    const cpu = canonicalUint(cpuText);
    const elapsedSec = canonicalUint(elapsedText);
    const exitCode = exitCodeText === "-" ? null : canonicalUint(exitCodeText);
    const signal = signalText === "-" ? null : signalText;
    const cpuCount = schedule.orders[0].length;
    const expectedRound = Math.floor((ordinal - 1) / cpuCount) + 1;
    const expectedPosition = ((ordinal - 1) % cpuCount) + 1;
    const expectedCpu = schedule.orders[expectedRound - 1]?.[expectedPosition - 1];
    if (rowOrdinal !== ordinal || round !== expectedRound || position !== expectedPosition || cpu !== expectedCpu ||
        elapsedSec === null || !validateV6OutcomeStatus(outcome, exitCode, signal) ||
        !/^[a-f0-9]{64}$/.test(stderrSha256) || canonicalDecimalBigInt(stderrBytes) === null) {
      invalidRows = true;
      errors.push("individual V6 results contain a malformed or out-of-order row");
      return;
    }
    const next = (counts.get(cpu) ?? 0) + 1;
    if (next !== round) {
      invalidRows = true;
      errors.push("individual V6 results contain a non-contiguous per-CPU round");
      return;
    }
    counts.set(cpu, next);
    validatedPlanPrefixRows += 1;
    if (ordinal > authorityRowLimit) return;
    const boundary = boundaries[ordinal - 1];
    if (boundary === undefined || boundary.ordinal !== ordinal || boundary.cpu !== cpu ||
        boundary.outcome !== outcome || boundary.exitCode !== exitCode || boundary.signal !== signal ||
        boundary.stderrSha256 !== stderrSha256 || boundary.stderrBytes !== stderrBytes ||
        BigInt(boundary.durationNs) / 1_000_000_000n !== BigInt(elapsedSec)) {
      invalidRows = true;
      errors.push("individual V6 result does not reconcile with its exact boundary");
      return;
    }
    onAcceptedRow?.({
      ordinal, round, position, cpu, outcome, exitCode, signal, elapsedSec, stderrSha256, stderrBytes,
    });
    let record = byCpu.get(cpu);
    if (!record) {
      record = {
        ...newCpuSummary(cpu),
        observations: 0,
        passes: 0,
        otherWorkloadFailures: 0,
        otherWorkloadFailureDetails: [],
      };
      byCpu.set(cpu, record);
    }
    record.observations += 1;
    if (outcome === "pass") {
      record.runs += 1;
      record.passes += 1;
    } else if (outcome === "sigsegv") {
      record.runs += 1;
      record.failures += 1;
      record.sigsegv += 1;
      if (retainedFailureDetails < INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT) {
        record.failedRuns.push({
          run: round, position, outcome, exitCode, signal: signal ?? "SIGSEGV", elapsedSec,
          stderrSha256, stderrBytes,
        });
        retainedFailureDetails += 1;
      }
    } else {
      record.otherFailures += 1;
      record.otherWorkloadFailures += 1;
      if (retainedFailureDetails < INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT) {
        record.otherWorkloadFailureDetails.push({
          run: round, position, outcome, exitCode, signal, elapsedSec, stderrSha256, stderrBytes,
        });
        retainedFailureDetails += 1;
      }
    }
  };
  const finish = () => {
    const summaries = [...byCpu.values()].sort((left, right) => left.cpu - right.cpu).map((record) => {
      const retained = record.failedRuns.length + record.otherWorkloadFailureDetails.length;
      const totalFailures = record.sigsegv + record.otherWorkloadFailures;
      return retained < totalFailures
        ? { ...record, failedRunsOmitted: totalFailures - retained }
        : record;
    });
    const omittedDetails = summaries.reduce(
      (total, record) => total + BigInt(record.failedRunsOmitted ?? 0),
      0n,
    );
    return {
      counts,
      sigsegv: new Map(summaries.map((record) => [record.cpu, record.sigsegv])),
      summaries,
      ambiguousCpus: new Set(),
      invalidRows,
      batchRows: 0,
      batchSigsegv: 0,
      validatedPlanPrefixRows,
      failedRunDetailsOmitted: omittedDetails <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(omittedDetails)
        : omittedDetails.toString(),
      failedRunDetailsOmittedIsDecimalString: omittedDetails > BigInt(Number.MAX_SAFE_INTEGER),
    };
  };
  return { acceptLine, finish };
}

// Stream an individual.tsv through a fixed read buffer and a single bounded
// line buffer. Valid files are hashed byte-for-byte as they are read. Once a
// line exceeds the grammar ceiling or expectedRows + 1 is observed, there is
// no useful authority left to derive, so inspection stops without reading the
// rest of a potentially sparse or adversarial file.
function inspectOpenedRows(opened, expectedRows, targets, expected, options = {}) {
  const base = {
    present: opened.present,
    errors: [...opened.errors],
    bytes: 0,
    sha256: null,
    rowCount: 0,
    inspectedBytes: 0,
    completeRead: false,
    summary: createRowAccumulator(targets, expected, options.batch, options).finish(),
  };
  if (!opened.present || opened.fd === undefined || opened.errors.length > 0) return base;

  const accumulator = createRowAccumulator(targets, expected, options.batch, options);
  const hash = createHash("sha256");
  const readBuffer = Buffer.allocUnsafe(BUFFER_BYTES);
  // A logical row may be at most 44 bytes including its newline. Canonical
  // field maxima consume 43 payload bytes; an unterminated malformed row can
  // still occupy the complete bounded buffer before grammar rejection.
  const lineBuffer = Buffer.alloc(Number(INDIVIDUAL_ROW_MAX_BYTES));
  let lineLength = 0;
  let rowCount = 0n;
  let inspectedBytes = 0n;
  let stopped = false;
  let reachedEof = false;
  let structuralFailure = false;

  const acceptLine = () => {
    rowCount += 1n;
    if (expectedRows !== null && rowCount > expectedRows) {
      base.errors.push("individual results exceed the expected row limit");
      accumulator.reject();
      structuralFailure = true;
      stopped = true;
      return;
    }
    accumulator.acceptFields(
      lineBuffer.subarray(0, lineLength).toString("utf8").split("\t"),
      rowCount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rowCount) : null,
    );
    lineLength = 0;
  };

  try {
    while (!stopped) {
      const count = readSync(opened.fd, readBuffer, 0, readBuffer.length, null);
      if (count === 0) {
        reachedEof = true;
        break;
      }
      inspectedBytes += BigInt(count);
      hash.update(readBuffer.subarray(0, count));
      for (let index = 0; index < count; index += 1) {
        const byte = readBuffer[index];
        if (byte === 0x0a) {
          if (lineLength === lineBuffer.length) {
            base.errors.push("individual results contain a line exceeding 44 bytes");
            accumulator.reject();
            structuralFailure = true;
            stopped = true;
          } else {
            acceptLine();
          }
          if (stopped) break;
        } else if (lineLength === lineBuffer.length) {
          base.errors.push("individual results contain a line exceeding 44 bytes");
          accumulator.reject();
          structuralFailure = true;
          stopped = true;
          break;
        } else {
          lineBuffer[lineLength] = byte;
          lineLength += 1;
        }
      }
    }
    if (reachedEof && lineLength > 0) acceptLine();
  } catch {
    base.errors.push("individual results could not be read safely");
    structuralFailure = true;
  }

  const completeRead = reachedEof && !stopped;
  base.completeRead = completeRead;
  base.inspectedBytes = Number(inspectedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
    ? inspectedBytes
    : BigInt(Number.MAX_SAFE_INTEGER));
  base.bytes = opened.stat.size <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(opened.stat.size)
    : null;
  base.rowCount = rowCount <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(rowCount)
    : null;
  if (completeRead && base.errors.length === 0) base.sha256 = hash.digest("hex");
  base.summary = accumulator.finish();
  if (structuralFailure) {
    base.summary = {
      ...base.summary,
      summaries: [],
      failedRunDetailsOmitted: 0,
      failedRunDetailsOmittedIsDecimalString: false,
    };
  }
  if (base.summary.invalidRows && !base.errors.includes(
    "individual results contain a malformed, non-target, non-SIGSEGV, duplicate, or non-contiguous row"
  )) {
    base.errors.push("individual results contain a malformed, non-target, non-SIGSEGV, duplicate, or non-contiguous row");
  }
  return base;
}

function normalizePlanCpus(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) {
    throw new TypeError("target CPUs must be a non-empty array");
  }
  let previous = -1;
  return cpus.map((cpu) => {
    if (!Number.isSafeInteger(cpu) || cpu < 0 || cpu > 65535 || cpu <= previous) {
      throw new TypeError("target CPUs must be unique, strictly increasing integers from 0 through 65535");
    }
    previous = cpu;
    return cpu;
  });
}

export function renderIndividualPlan(targetCpus, roundCount, seed) {
  const cpus = normalizePlanCpus(targetCpus);
  if (!Number.isSafeInteger(roundCount) || roundCount < 1) {
    throw new TypeError("round count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new TypeError(`schedule seed must be an integer from 0 through ${MAX_SEED}`);
  }
  const orders = buildIsolatedOrders(cpus, roundCount, seed);
  const lines = [PLAN_HEADER];
  let ordinal = 0;
  for (let round = 0; round < orders.length; round += 1) {
    for (let position = 0; position < orders[round].length; position += 1) {
      ordinal += 1;
      lines.push(`${ordinal}\t${round + 1}\t${position + 1}\t${orders[round][position]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function v5Schedule(meta) {
  const targets = parseCanonicalCpuList(meta.TARGET_CPUS);
  const rounds = canonicalUint(meta.RUNS_PER_CPU);
  const seed = canonicalUint(meta.SCHEDULE_SEED);
  if (!targets || targets.size === 0 || rounds === null || rounds < 1 ||
      seed === null || seed > MAX_SEED || BigInt(targets.size) * BigInt(rounds) > BigInt(MAX_SCHEDULE_ENTRIES)) {
    return { targets, rounds, seed, orders: null, expectedRows: null };
  }
  try {
    const orders = buildIsolatedOrders([...targets], rounds, seed);
    return { targets, rounds, seed, orders, expectedRows: targets.size * rounds };
  } catch {
    return { targets, rounds, seed, orders: null, expectedRows: null };
  }
}

function inspectOpenedLineArtifact(opened, options) {
  const base = {
    present: opened.present,
    errors: [...opened.errors],
    bytes: opened.stat?.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(opened.stat.size) : null,
    sha256: null,
    rowCount: 0,
    inspectedBytes: 0,
    completeRead: false,
  };
  if (!opened.present) {
    base.errors.push(`${options.label} is missing`);
    return base;
  }
  if (opened.fd === undefined || opened.errors.length > 0) return base;

  const hash = createHash("sha256");
  const readBuffer = Buffer.allocUnsafe(BUFFER_BYTES);
  const lineBuffer = Buffer.alloc(options.maxLineBytes);
  const maximumRows = BigInt(options.maximumRows);
  let lineLength = 0;
  let physicalLine = 0;
  let inspectedBytes = 0n;
  let stopped = false;
  let reachedEof = false;

  const acceptLine = () => {
    const line = lineBuffer.subarray(0, lineLength).toString("utf8");
    lineLength = 0;
    physicalLine += 1;
    if (options.header !== null && physicalLine === 1) {
      if (line !== options.header) base.errors.push(`${options.label} has a malformed header`);
      return;
    }
    const row = options.header === null ? physicalLine : physicalLine - 1;
    if (BigInt(row) > maximumRows) {
      base.errors.push(`${options.label} exceeds the expected row limit`);
      stopped = true;
      return;
    }
    base.rowCount = row;
    options.acceptLine(line, row, base.errors);
  };

  try {
    while (!stopped) {
      const count = readSync(opened.fd, readBuffer, 0, readBuffer.length, null);
      if (count === 0) {
        reachedEof = true;
        break;
      }
      inspectedBytes += BigInt(count);
      hash.update(readBuffer.subarray(0, count));
      for (let index = 0; index < count; index += 1) {
        const byte = readBuffer[index];
        if (byte === 0x0a) {
          acceptLine();
          if (stopped) break;
        } else if (lineLength === lineBuffer.length) {
          base.errors.push(`${options.label} contains an overlong line`);
          stopped = true;
          break;
        } else {
          lineBuffer[lineLength] = byte;
          lineLength += 1;
        }
      }
    }
    if (reachedEof && lineLength > 0) {
      base.errors.push(`${options.label} must end with a newline`);
    }
  } catch {
    base.errors.push(`${options.label} could not be read safely`);
  }

  base.completeRead = reachedEof && !stopped;
  base.inspectedBytes = Number(inspectedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
    ? inspectedBytes
    : BigInt(Number.MAX_SAFE_INTEGER));
  if (options.header !== null && physicalLine === 0) {
    base.errors.push(`${options.label} is missing its header`);
  }
  base.errors = [...new Set(base.errors)];
  if (base.completeRead && base.errors.length === 0) base.sha256 = hash.digest("hex");
  return base;
}

function inspectOpenedV6Rows(opened, schedule, options = {}) {
  const accumulator = createV6RowAccumulator(schedule, options);
  const state = inspectOpenedLineArtifact(opened, {
    label: "individual V6 results",
    header: V6_RESULTS_HEADER,
    maxLineBytes: Number(INDIVIDUAL_V6_ROW_MAX_BYTES),
    maximumRows: schedule.expectedRows ?? 0,
    acceptLine: accumulator.acceptLine,
  });
  state.summary = accumulator.finish();
  if (state.rowCount !== schedule.expectedRows && options.requireComplete === true) {
    state.errors.push("individual V6 results do not contain every expected row");
  }
  if (state.summary.invalidRows) state.sha256 = null;
  state.errors = [...new Set(state.errors)];
  return state;
}

function inspectOpenedPlan(opened, schedule) {
  const expectedRows = schedule.expectedRows ?? 0;
  const state = inspectOpenedLineArtifact(opened, {
    label: "individual plan",
    header: PLAN_HEADER,
    maxLineBytes: Number(INDIVIDUAL_PLAN_ROW_MAX_BYTES),
    maximumRows: expectedRows,
    acceptLine(line, ordinal, errors) {
      if (schedule.orders === null) {
        errors.push("individual plan cannot be validated against an invalid schedule");
        return;
      }
      const cpuCount = schedule.orders[0].length;
      const round = Math.floor((ordinal - 1) / cpuCount) + 1;
      const position = ((ordinal - 1) % cpuCount) + 1;
      const expected = `${ordinal}\t${round}\t${position}\t${schedule.orders[round - 1][position - 1]}`;
      if (line !== expected) errors.push("individual plan contains a malformed or out-of-order row");
    },
  });
  if (state.rowCount !== expectedRows) {
    state.errors.push("individual plan does not contain every expected row");
    state.sha256 = null;
  }
  state.errors = [...new Set(state.errors)];
  return state;
}

function canonicalDecimalBigInt(value) {
  if (typeof value !== "string" || value.length > 32 || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizeBoundaryNoTurbo(value) {
  if (value === 0 || value === 1) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!new Set(["unavailable", "invalid"]).has(value.status) ||
      typeof value.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode)) return null;
  return { status: value.status, errorCode: value.errorCode };
}

function normalizeBoundaryRecord(value, ordinal, schedule) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || schedule.orders === null) return null;
  const cpuCount = schedule.orders[0].length;
  const round = Math.floor((ordinal - 1) / cpuCount) + 1;
  const position = ((ordinal - 1) % cpuCount) + 1;
  const cpu = schedule.orders[round - 1]?.[position - 1];
  if (value.ordinal !== ordinal || value.round !== round || value.position !== position || value.cpu !== cpu ||
      !Number.isSafeInteger(value.startUnixMs) || value.startUnixMs < 0 ||
      !Number.isSafeInteger(value.endUnixMs) || value.endUnixMs < value.startUnixMs) return null;
  const startMonotonicNs = canonicalDecimalBigInt(value.startMonotonicNs);
  const endMonotonicNs = canonicalDecimalBigInt(value.endMonotonicNs);
  const durationNs = canonicalDecimalBigInt(value.durationNs);
  if (startMonotonicNs === null || endMonotonicNs === null || durationNs === null ||
      endMonotonicNs < startMonotonicNs || durationNs !== endMonotonicNs - startMonotonicNs ||
      durationNs > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 || value.durationMs !== Number(durationNs) / 1_000_000) return null;
  const noTurboStart = normalizeBoundaryNoTurbo(value.noTurboStart);
  const noTurboEnd = normalizeBoundaryNoTurbo(value.noTurboEnd);
  if (noTurboStart === null || noTurboEnd === null) return null;
  return {
    ordinal,
    round,
    position,
    cpu,
    startUnixMs: value.startUnixMs,
    endUnixMs: value.endUnixMs,
    startMonotonicNs: value.startMonotonicNs,
    endMonotonicNs: value.endMonotonicNs,
    durationNs: value.durationNs,
    durationMs: value.durationMs,
    noTurboStart,
    noTurboEnd,
  };
}

function normalizeBoundaryRecordV6(value, ordinal, schedule) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || schedule.orders === null) return null;
  const cpuCount = schedule.orders[0].length;
  const round = Math.floor((ordinal - 1) / cpuCount) + 1;
  const position = ((ordinal - 1) % cpuCount) + 1;
  const cpu = schedule.orders[round - 1]?.[position - 1];
  if (value.ordinal !== ordinal || value.round !== round || value.position !== position || value.cpu !== cpu ||
      !validateV6OutcomeStatus(value.outcome, value.exitCode, value.signal) ||
      typeof value.stderrSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.stderrSha256) ||
      canonicalDecimalBigInt(value.stderrBytes) === null ||
      typeof value.stderrExcerptBase64 !== "string" ||
      !Number.isSafeInteger(value.stderrExcerptBytes) || value.stderrExcerptBytes < 0 ||
      value.stderrExcerptBytes > INDIVIDUAL_V6_STDERR_EXCERPT_MAX_BYTES ||
      typeof value.stderrTruncated !== "boolean" ||
      !Number.isSafeInteger(value.startUnixMs) || value.startUnixMs < 0 ||
      !Number.isSafeInteger(value.endUnixMs) || value.endUnixMs < value.startUnixMs) return null;
  let excerpt;
  try {
    excerpt = Buffer.from(value.stderrExcerptBase64, "base64");
  } catch {
    return null;
  }
  const stderrBytes = canonicalDecimalBigInt(value.stderrBytes);
  if (excerpt.toString("base64") !== value.stderrExcerptBase64 ||
      excerpt.length !== value.stderrExcerptBytes || stderrBytes < BigInt(excerpt.length) ||
      value.stderrTruncated !== (stderrBytes > BigInt(excerpt.length)) ||
      (!value.stderrTruncated && createHash("sha256").update(excerpt).digest("hex") !== value.stderrSha256)) {
    return null;
  }
  const startMonotonicNs = canonicalDecimalBigInt(value.startMonotonicNs);
  const endMonotonicNs = canonicalDecimalBigInt(value.endMonotonicNs);
  const durationNs = canonicalDecimalBigInt(value.durationNs);
  if (startMonotonicNs === null || endMonotonicNs === null || durationNs === null ||
      endMonotonicNs < startMonotonicNs || durationNs !== endMonotonicNs - startMonotonicNs ||
      durationNs > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 || value.durationMs !== Number(durationNs) / 1_000_000) return null;
  const noTurboStart = normalizeBoundaryNoTurbo(value.noTurboStart);
  const noTurboEnd = normalizeBoundaryNoTurbo(value.noTurboEnd);
  // Unlike V5, V6 commits only operationally valid attempts. A missing or
  // malformed no_turbo read is therefore not merely descriptive boundary
  // data: it proves this row could not have been emitted by the V2 protocol.
  if ((noTurboStart !== 0 && noTurboStart !== 1) ||
      (noTurboEnd !== 0 && noTurboEnd !== 1)) return null;
  return {
    ordinal,
    round,
    position,
    cpu,
    outcome: value.outcome,
    exitCode: value.exitCode,
    signal: value.signal,
    stderrSha256: value.stderrSha256,
    stderrBytes: value.stderrBytes,
    stderrExcerptBase64: value.stderrExcerptBase64,
    stderrExcerptBytes: value.stderrExcerptBytes,
    stderrTruncated: value.stderrTruncated,
    startUnixMs: value.startUnixMs,
    endUnixMs: value.endUnixMs,
    startMonotonicNs: value.startMonotonicNs,
    endMonotonicNs: value.endMonotonicNs,
    durationNs: value.durationNs,
    durationMs: value.durationMs,
    noTurboStart,
    noTurboEnd,
  };
}

function inspectOpenedBoundaries(opened, schedule, options = {}) {
  return inspectOpenedLineArtifact(opened, {
    label: "individual boundaries",
    header: null,
    maxLineBytes: Number(INDIVIDUAL_BOUNDARY_ROW_MAX_BYTES),
    maximumRows: schedule.expectedRows ?? 0,
    acceptLine(line, ordinal, errors) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push("individual boundaries contain malformed or noncanonical JSON");
        return;
      }
      const normalized = normalizeBoundaryRecord(parsed, ordinal, schedule);
      if (normalized === null || JSON.stringify(normalized) !== line) {
        errors.push("individual boundaries contain malformed or noncanonical JSON");
        return;
      }
      options.onAcceptedBoundary?.(normalized);
    },
  });
}

function inspectOpenedBoundariesV6(opened, schedule, options = {}) {
  return inspectOpenedLineArtifact(opened, {
    label: "individual V6 boundaries",
    header: null,
    maxLineBytes: Number(INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES),
    maximumRows: schedule.expectedRows ?? 0,
    acceptLine(line, ordinal, errors) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push("individual V6 boundaries contain malformed or noncanonical JSON");
        return;
      }
      const normalized = normalizeBoundaryRecordV6(parsed, ordinal, schedule);
      if (normalized === null || JSON.stringify(normalized) !== line) {
        errors.push("individual V6 boundaries contain malformed or noncanonical JSON");
        return;
      }
      options.onAcceptedBoundary?.(normalized);
    },
  });
}

export function assessIndividual(rows, meta, phaseDone, metaState = {}) {
  const present = metaState.present ?? Object.keys(meta).length > 0;
  const reasons = [...(metaState.errors ?? [])];
  let invalid = reasons.length > 0;
  const streamedRows = metaState.rowSummary ?? null;
  const observedRowCount = streamedRows ? (metaState.rowCount ?? 0) : rows.length;
  const hasArtifacts = observedRowCount > 0 || present || phaseDone;
  if (!hasArtifacts) return { status: "not-run", reasons: [], targetCpus: [], runsPerCpu: null, acceptedRows: [] };

  const required = ["VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED"];
  if (!present || required.some((key) => !Object.hasOwn(meta, key))) {
    reasons.push("individual metadata is missing required fields");
    invalid = true;
  }
  if (meta.VERSION !== "1" && meta.VERSION !== "2" && meta.VERSION !== "3" &&
      meta.VERSION !== "4" && meta.VERSION !== "5" && meta.VERSION !== "6") {
    reasons.push("individual metadata version is missing or unsupported");
    invalid = true;
  }
  const isV5 = meta.VERSION === "5";
  const isV6 = meta.VERSION === "6";
  const isInterleaved = isV5 || isV6;
  const provenanceRequired = meta.VERSION === "2" || meta.VERSION === "3" || meta.VERSION === "4" ||
    isInterleaved;
  if (provenanceRequired) {
    if (!Object.hasOwn(meta, "TARGET_POLICY") || !Object.hasOwn(meta, "GROUP_PLAN_DIGEST")) {
      reasons.push("individual metadata is missing target provenance fields");
      invalid = true;
    }
    const validPolicy = isInterleaved
      ? meta.TARGET_POLICY === "all-usable-cpus"
      : ["failed-groups", "all-group-cpus", "quick-skip"].includes(meta.TARGET_POLICY);
    if (!validPolicy ||
        !/^[a-f0-9]{64}$/.test(meta.GROUP_PLAN_DIGEST ?? "")) {
      reasons.push("individual target provenance is malformed");
      invalid = true;
    }
  } else if (Object.hasOwn(meta, "TARGET_POLICY") || Object.hasOwn(meta, "GROUP_PLAN_DIGEST") ||
    Object.hasOwn(meta, "GROUP_GENERATION") || Object.hasOwn(meta, "GENERATION") ||
    Object.hasOwn(meta, "ROWS_SHA256") || Object.hasOwn(meta, "ROWS_BYTES") ||
    Object.hasOwn(meta, "ROW_COUNT") || V5_ONLY_META_KEYS.some((key) => Object.hasOwn(meta, key))) {
    reasons.push("legacy individual metadata contains unsupported provenance fields");
    invalid = true;
  }
  const runsPerCpu = canonicalUint(meta.RUNS_PER_CPU);
  if (runsPerCpu === null || runsPerCpu < 1) {
    reasons.push("RUNS_PER_CPU is missing or invalid");
    invalid = true;
  }
  const skipped = meta.SKIPPED === "1" ? true : meta.SKIPPED === "0" ? false : null;
  const completed = meta.COMPLETED === "1" ? true : meta.COMPLETED === "0" ? false : null;
  if (skipped === null || completed === null) {
    reasons.push("individual skip/completion flags are missing or invalid");
    invalid = true;
  }

  if (meta.VERSION === "2" && (Object.hasOwn(meta, "GENERATION") ||
    Object.hasOwn(meta, "GROUP_GENERATION") || Object.hasOwn(meta, "ROWS_SHA256") ||
    Object.hasOwn(meta, "ROWS_BYTES") || Object.hasOwn(meta, "ROW_COUNT"))) {
    reasons.push("version 2 individual metadata contains unsupported row binding fields");
    invalid = true;
  }
  if (meta.VERSION === "3" && Object.hasOwn(meta, "GROUP_GENERATION")) {
    reasons.push("version 3 individual metadata contains an unsupported group generation field");
    invalid = true;
  }
  if (meta.VERSION === "4" && !/^[a-f0-9]{32}$/.test(meta.GROUP_GENERATION ?? "")) {
    reasons.push("individual group generation is missing or invalid");
    invalid = true;
  }
  if (meta.VERSION === "3" || meta.VERSION === "4") {
    if (!/^[a-f0-9]{32}$/.test(meta.GENERATION ?? "")) {
      reasons.push("individual evidence generation is missing or invalid");
      invalid = true;
    }
    const bindingPresent = ["ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT"]
      .every((key) => Object.hasOwn(meta, key));
    if (completed === true && !bindingPresent) {
      reasons.push("completed individual metadata is missing row binding fields");
      invalid = true;
    }
    if (completed === false && ["ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT"]
      .some((key) => Object.hasOwn(meta, key))) {
      reasons.push("incomplete individual metadata contains terminal row binding fields");
      invalid = true;
    }
    if (bindingPresent) {
      const rowsBytes = canonicalUint(meta.ROWS_BYTES);
      const rowCount = canonicalUint(meta.ROW_COUNT);
      if (!/^[a-f0-9]{64}$/.test(meta.ROWS_SHA256 ?? "") || rowsBytes === null || rowCount === null) {
        reasons.push("individual row binding fields are malformed");
        invalid = true;
      } else if (metaState.enforceBinding === true &&
        (meta.ROWS_SHA256 !== metaState.rowsSha256 ||
          rowsBytes !== metaState.rowsBytes || rowCount !== metaState.rowCount)) {
        reasons.push("individual results do not match their recorded row binding");
        invalid = true;
      }
    }
  }
  if (!isInterleaved && V5_ONLY_META_KEYS.some((key) => Object.hasOwn(meta, key))) {
    reasons.push("pre-V5 individual metadata contains unsupported interleaved protocol fields");
    invalid = true;
  }
  if (isInterleaved) {
    const versionLabel = isV6 ? "version 6" : "version 5";
    const requiredV5 = [
      "GENERATION", "GROUP_GENERATION", "PROTOCOL", "SCHEDULE_SEED", "SCHEDULE_ALGORITHM",
      "PLAN_SHA256", "PLAN_BYTES", "PLAN_ROW_COUNT",
    ];
    if (requiredV5.some((key) => !Object.hasOwn(meta, key))) {
      reasons.push(`${versionLabel} individual metadata is missing required protocol or plan fields`);
      invalid = true;
    }
    if (!/^[a-f0-9]{32}$/.test(meta.GENERATION ?? "")) {
      reasons.push("individual evidence generation is missing or invalid");
      invalid = true;
    }
    if (!/^[a-f0-9]{32}$/.test(meta.GROUP_GENERATION ?? "")) {
      reasons.push("individual group generation is missing or invalid");
      invalid = true;
    }
    const schedule = v5Schedule(meta);
    const expectedProtocol = isV6 ? V6_PROTOCOL : V5_PROTOCOL;
    if (meta.PROTOCOL !== expectedProtocol || meta.SCHEDULE_ALGORITHM !== V5_SCHEDULE_ALGORITHM ||
        schedule.orders === null) {
      reasons.push(`${versionLabel} individual schedule metadata is malformed or unsupported`);
      invalid = true;
    }
    const planBytes = canonicalUint(meta.PLAN_BYTES);
    const planRowCount = canonicalUint(meta.PLAN_ROW_COUNT);
    if (!/^[a-f0-9]{64}$/.test(meta.PLAN_SHA256 ?? "") || planBytes === null || planRowCount === null ||
        (schedule.expectedRows !== null && planRowCount !== schedule.expectedRows)) {
      reasons.push("individual plan binding fields are malformed");
      invalid = true;
    } else if (metaState.enforceBinding === true &&
      (meta.PLAN_SHA256 !== metaState.planSha256 || planBytes !== metaState.planBytes ||
        planRowCount !== metaState.planRowCount)) {
      reasons.push("individual plan does not match its recorded binding");
      invalid = true;
    }

    const rowBindingKeys = ["ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT"];
    const boundaryBindingKeys = ["BOUNDARIES_SHA256", "BOUNDARIES_BYTES", "BOUNDARY_ROW_COUNT"];
    const rowBindingPresent = rowBindingKeys.every((key) => Object.hasOwn(meta, key));
    const boundaryBindingPresent = boundaryBindingKeys.every((key) => Object.hasOwn(meta, key));
    const anyTerminalBinding = [...rowBindingKeys, ...boundaryBindingKeys]
      .some((key) => Object.hasOwn(meta, key));
    if (completed === true && (!rowBindingPresent || !boundaryBindingPresent)) {
      reasons.push(`completed ${versionLabel} metadata is missing terminal row or boundary bindings`);
      invalid = true;
    }
    if (completed === false && anyTerminalBinding) {
      reasons.push(`incomplete ${versionLabel} metadata contains terminal row or boundary bindings`);
      invalid = true;
    }
    if (anyTerminalBinding && (!rowBindingPresent || !boundaryBindingPresent)) {
      reasons.push(`${versionLabel} terminal bindings are only partially present`);
      invalid = true;
    }
    if (rowBindingPresent) {
      const rowsBytes = canonicalUint(meta.ROWS_BYTES);
      const rowCount = canonicalUint(meta.ROW_COUNT);
      if (!/^[a-f0-9]{64}$/.test(meta.ROWS_SHA256 ?? "") || rowsBytes === null || rowCount === null) {
        reasons.push("individual row binding fields are malformed");
        invalid = true;
      } else if (metaState.enforceBinding === true &&
        (meta.ROWS_SHA256 !== metaState.rowsSha256 || rowsBytes !== metaState.rowsBytes ||
          rowCount !== metaState.rowCount)) {
        reasons.push("individual results do not match their recorded row binding");
        invalid = true;
      }
    }
    if (boundaryBindingPresent) {
      const boundariesBytes = canonicalUint(meta.BOUNDARIES_BYTES);
      const boundaryRowCount = canonicalUint(meta.BOUNDARY_ROW_COUNT);
      if (!/^[a-f0-9]{64}$/.test(meta.BOUNDARIES_SHA256 ?? "") ||
          boundariesBytes === null || boundaryRowCount === null) {
        reasons.push("individual boundary binding fields are malformed");
        invalid = true;
      } else if (metaState.enforceBinding === true &&
        (meta.BOUNDARIES_SHA256 !== metaState.boundariesSha256 ||
          boundariesBytes !== metaState.boundariesBytes ||
          boundaryRowCount !== metaState.boundaryRowCount)) {
        reasons.push("individual boundaries do not match their recorded binding");
        invalid = true;
      }
    }
  }

  const targetSet = parseCanonicalCpuList(meta.TARGET_CPUS);
  if (skipped === true) {
    if (meta.TARGET_CPUS !== "" || completed !== true || !meta.SKIP_REASON) {
      reasons.push("skipped individual metadata is inconsistent");
      invalid = true;
    }
    if (provenanceRequired && meta.TARGET_POLICY !== "quick-skip") {
      reasons.push("skipped individual metadata has an inconsistent target policy");
      invalid = true;
    }
  } else if (!targetSet || targetSet.size === 0 || meta.SKIP_REASON !== undefined) {
    reasons.push("individual target CPU metadata is missing or invalid");
    invalid = true;
  } else if (provenanceRequired && meta.TARGET_POLICY === "quick-skip") {
    reasons.push("non-skipped individual metadata has an inconsistent target policy");
    invalid = true;
  }

  const acceptedRows = [];
  const ambiguousCpus = streamedRows?.ambiguousCpus ?? new Set();
  const nextRun = new Map();
  let invalidRows = streamedRows?.invalidRows ?? false;
  if (!streamedRows) {
    for (const row of rows) {
      if (row.length !== 4) {
        const rowCpu = canonicalUint(row[0]);
        if (rowCpu !== null && (!targetSet || targetSet.has(rowCpu))) ambiguousCpus.add(rowCpu);
        invalidRows = true;
        continue;
      }
      const [cpuS, runS, rcS, elapsedS] = row;
      const cpu = canonicalUint(cpuS);
      const run = canonicalUint(runS);
      const rc = canonicalUint(rcS);
      const elapsed = canonicalUint(elapsedS);
      if (cpu === null || (targetSet && !targetSet.has(cpu))) {
        invalidRows = true;
        continue;
      }
      if (run === null || rc === null || elapsed === null || run < 1 ||
          (runsPerCpu !== null && run > runsPerCpu)) {
        ambiguousCpus.add(cpu);
        invalidRows = true;
        continue;
      }
      const expectedRun = nextRun.get(cpu) ?? 1;
      if (run !== expectedRun) {
        ambiguousCpus.add(cpu);
        invalidRows = true;
        continue;
      }
      nextRun.set(cpu, expectedRun + 1);
      if (rc !== 0 && rc !== 139) {
        invalidRows = true;
        continue;
      }
      acceptedRows.push(row);
    }
  }
  if (invalidRows) {
    reasons.push("individual results contain a malformed, non-target, non-SIGSEGV, duplicate, or non-contiguous row");
    invalid = true;
  }

  if (skipped === true) {
    if (observedRowCount > 0) {
      reasons.push("skipped individual phase contains result rows");
      invalid = true;
    }
  } else if (targetSet && runsPerCpu !== null) {
    const missing = streamedRows
      ? [...targetSet].some((cpu) => (streamedRows.counts.get(cpu) ?? 0) !== runsPerCpu)
      : [...targetSet].some((cpu) => (nextRun.get(cpu) ?? 1) !== runsPerCpu + 1);
    if (missing) reasons.push("individual results do not contain every expected per-CPU run");
  }
  const observedBoundaryCount = metaState.boundaryRowCount ?? 0;
  const commonPrefixRowCount = isInterleaved
    ? Math.min(streamedRows?.validatedPlanPrefixRows ?? observedRowCount, observedBoundaryCount)
    : null;
  if (isInterleaved && metaState.metadataOnly !== true) {
    const expectedV5Rows = v5Schedule(meta).expectedRows;
    if (observedRowCount !== observedBoundaryCount) {
      reasons.push("individual results and boundaries have different validated prefix lengths");
    }
    if (completed === true && expectedV5Rows !== null &&
        (observedRowCount !== expectedV5Rows || observedBoundaryCount !== expectedV5Rows)) {
      reasons.push(`completed version ${meta.VERSION} evidence does not contain every planned result and boundary`);
      invalid = true;
    }
    if (completed === true && !phaseDone) {
      reasons.push(`completed version ${meta.VERSION} evidence is missing its completion marker`);
      invalid = true;
    }
    if (completed === false && phaseDone) {
      reasons.push(`incomplete version ${meta.VERSION} evidence has a completion marker`);
      invalid = true;
    }
  }
  if (!phaseDone) reasons.push("phase completion marker is missing");
  if (completed === false) reasons.push("individual metadata is not marked complete");

  let status = "incomplete";
  if (invalid) status = "invalid";
  else if (skipped === true && phaseDone && completed === true && observedRowCount === 0) status = "skipped";
  else if (skipped === false && phaseDone && completed === true && reasons.length === 0) status = "complete";
  const unambiguousRows = acceptedRows.filter((row) => !ambiguousCpus.has(Number(row[0])));
  const result = {
    status,
    reasons: [...new Set(reasons)],
    targetCpus: targetSet ? [...targetSet] : [],
    runsPerCpu,
    acceptedRows: unambiguousRows,
    acceptedSummaries: streamedRows?.summaries ?? null,
    skipReason: meta.SKIP_REASON ?? null,
    metadataVersion: meta.VERSION ?? null,
    generation: meta.GENERATION ?? null,
    targetPolicy: meta.TARGET_POLICY ?? null,
    groupPlanDigest: meta.GROUP_PLAN_DIGEST ?? null,
    groupGeneration: meta.GROUP_GENERATION ?? null,
  };
  if (isInterleaved) Object.assign(result, {
    protocol: meta.PROTOCOL ?? null,
    scheduleSeed: canonicalUint(meta.SCHEDULE_SEED),
    scheduleAlgorithm: meta.SCHEDULE_ALGORITHM ?? null,
    commonPrefixRowCount,
    boundaryRowCount: observedBoundaryCount,
    planRowCount: metaState.planRowCount ?? null,
  });
  if (isV6) {
    const summaries = streamedRows?.summaries ?? [];
    result.otherWorkloadFailures = summaries.reduce(
      (total, record) => total + (record.otherWorkloadFailures ?? 0),
      0,
    );
    result.primaryEligibleRuns = summaries.reduce((total, record) => total + (record.runs ?? 0), 0);
  }
  const omittedDetails = streamedRows?.failedRunDetailsOmitted ?? 0;
  if (omittedDetails !== 0 && omittedDetails !== "0") {
    result.failedRunDetailsTruncated = true;
    result.failedRunDetailLimit = INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT;
    result.failedRunDetailsOmitted = omittedDetails;
    if (streamedRows.failedRunDetailsOmittedIsDecimalString) {
      result.failedRunDetailsOmittedIsDecimalString = true;
    }
  }
  return result;
}

export function inspectIndividualEvidence(outDir, options = {}) {
  const root = path.resolve(outDir);
  const publicResultsDir = path.join(root, "results");
  const publicStateDir = path.join(root, "state");
  const rootDirectory = openStableDirectory(root, "bundle root", true);
  const unavailableDirectory = (dir, label) => ({
    present: false,
    dir,
    label,
    errors: [`${label} cannot be trusted through an unsafe bundle root`],
    fd: undefined,
    stat: undefined,
  });
  const anchoredResultsDir = fdChildPath(rootDirectory, "results");
  const anchoredStateDir = fdChildPath(rootDirectory, "state");
  const resultsDirectory = anchoredResultsDir === null
    ? unavailableDirectory(publicResultsDir, "results directory")
    : openStableDirectory(anchoredResultsDir, "results directory", false);
  const stateDirectory = anchoredStateDir === null
    ? unavailableDirectory(publicStateDir, "state directory")
    : openStableDirectory(anchoredStateDir, "state directory", false);
  const directories = [rootDirectory, resultsDirectory, stateDirectory];
  const resultsSafe = directories[0].errors.length === 0 &&
    directories[1].present && directories[1].errors.length === 0;
  const stateSafe = directories[0].errors.length === 0 &&
    directories[2].present && directories[2].errors.length === 0;
  const requiredOwner = options.requiredOwner ?? null;
  const unavailable = (file, label, reason) => ({
    present: true,
    file,
    label,
    errors: [reason],
    fd: undefined,
    stat: undefined,
  });
  options.afterDirectoriesOpened?.();
  const anchoredMarker = fdChildPath(stateDirectory, "phase-individual.done");
  const anchoredMeta = fdChildPath(resultsDirectory, "individual.meta");
  const anchoredRows = fdChildPath(resultsDirectory, "individual.tsv");
  const anchoredPlan = fdChildPath(resultsDirectory, "individual.plan.tsv");
  const anchoredBoundaries = fdChildPath(resultsDirectory, "individual.boundaries.ndjson");
  // A completion marker is an authority input, so hold its descriptor from
  // before metadata inspection until after the bound rows are verified.
  const markerOpened = stateSafe
    ? openStablePath(anchoredMarker, 0, "individual completion marker", requiredOwner)
    : directories[2].present
      ? unavailable(publicStateDir, "individual completion marker", "individual completion marker cannot be trusted through an unsafe state directory")
      : { present: false, file: path.join(publicStateDir, "phase-individual.done"), label: "individual completion marker", errors: [], fd: undefined, stat: undefined };
  const metaOpened = resultsSafe
    ? openStablePath(anchoredMeta, INDIVIDUAL_META_MAX_BYTES, "individual metadata", requiredOwner)
    : unavailable(path.join(publicResultsDir, "individual.meta"), "individual metadata", "individual metadata cannot be trusted through an unsafe results directory");

  let metaBytes = Buffer.alloc(0);
  let markerBytes = Buffer.alloc(0);
  let rowsOpened;
  let rowsState;
  let planOpened;
  let planState = null;
  let boundariesOpened;
  let boundariesState = null;
  let metaState;
  let expectedRows = null;
  let isV5 = false;
  let isV6 = false;
  const v6Boundaries = [];
  try {
    markerBytes = readOpenedPath(markerOpened, 0);
    metaBytes = readOpenedPath(metaOpened, INDIVIDUAL_META_MAX_BYTES);
    metaState = parseIndividualMeta({
      present: metaOpened.present,
      bytes: metaOpened.errors.length === 0 ? metaBytes : null,
      errors: metaOpened.errors,
    });
    isV5 = metaState.values.VERSION === "5";
    isV6 = metaState.values.VERSION === "6";
    const isInterleaved = isV5 || isV6;
    const schedule = isInterleaved ? v5Schedule(metaState.values) : null;
    const v5RequiredOwner = isInterleaved
      ? (requiredOwner ?? process.geteuid?.() ?? process.getuid())
      : requiredOwner;
    if (isInterleaved && v5RequiredOwner !== null) {
      for (const opened of [metaOpened, markerOpened]) {
        if (opened.present && opened.stat !== undefined && opened.stat.uid !== BigInt(v5RequiredOwner)) {
          opened.errors.push(`${opened.label} must be owned by the current user`);
        }
      }
    }
    const targets = parseCanonicalCpuList(metaState.values.TARGET_CPUS);
    const runs = canonicalUint(metaState.values.RUNS_PER_CPU);
    if (metaState.values.SKIPPED === "1" && metaState.values.TARGET_CPUS === "" && runs !== null && runs > 0) {
      expectedRows = 0n;
    } else if (metaState.values.SKIPPED === "0" && targets && runs !== null && runs > 0) {
      expectedRows = BigInt(targets.size) * BigInt(runs);
    }
    if (isInterleaved && schedule.expectedRows !== null) expectedRows = BigInt(schedule.expectedRows);
    const rowMaxBytes = expectedRows === null
      ? BigInt(INDIVIDUAL_TSV_FALLBACK_MAX_BYTES)
      : expectedRows * (isV6 ? INDIVIDUAL_V6_ROW_MAX_BYTES : INDIVIDUAL_ROW_MAX_BYTES);
    rowsOpened = resultsSafe
      ? openStablePath(anchoredRows, rowMaxBytes, "individual results", v5RequiredOwner)
      : unavailable(path.join(publicResultsDir, "individual.tsv"), "individual results", "individual results cannot be trusted through an unsafe results directory");
    if (isInterleaved) {
      const planMaxBytes = expectedRows === null
        ? BigInt(INDIVIDUAL_PLAN_FALLBACK_MAX_BYTES)
        : BigInt(Buffer.byteLength(`${PLAN_HEADER}\n`)) + expectedRows * INDIVIDUAL_PLAN_ROW_MAX_BYTES;
      const boundariesMaxBytes = expectedRows === null
        ? BigInt(INDIVIDUAL_BOUNDARIES_FALLBACK_MAX_BYTES)
        : expectedRows * (isV6 ? INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES : INDIVIDUAL_BOUNDARY_ROW_MAX_BYTES);
      planOpened = resultsSafe
        ? openStablePath(anchoredPlan, planMaxBytes, "individual plan", v5RequiredOwner)
        : unavailable(path.join(publicResultsDir, "individual.plan.tsv"), "individual plan", "individual plan cannot be trusted through an unsafe results directory");
      boundariesOpened = resultsSafe
        ? openStablePath(anchoredBoundaries, boundariesMaxBytes, "individual boundaries", v5RequiredOwner)
        : unavailable(path.join(publicResultsDir, "individual.boundaries.ndjson"), "individual boundaries", "individual boundaries cannot be trusted through an unsafe results directory");
      planState = inspectOpenedPlan(planOpened, schedule);
      boundariesState = isV6
        ? inspectOpenedBoundariesV6(boundariesOpened, schedule, {
          onAcceptedBoundary: (row) => {
            v6Boundaries.push(row);
            options.onV6Boundary?.(row);
          },
        })
        : inspectOpenedBoundaries(boundariesOpened, schedule, {
          onAcceptedBoundary: typeof options.onV5Boundary === "function"
            ? options.onV5Boundary
            : undefined,
        });
    }
    rowsState = isV6
      ? inspectOpenedV6Rows(rowsOpened, schedule, {
        boundaries: v6Boundaries,
        authorityRowLimit: boundariesState?.rowCount ?? 0,
        requireComplete: metaState.values.COMPLETED === "1",
        onAcceptedRow: typeof options.onV6Result === "function" ? options.onV6Result : undefined,
      })
      : inspectOpenedRows(rowsOpened, expectedRows, targets, runs, isV5 ? {
        planOrders: schedule.orders,
        authorityRowLimit: boundariesState?.rowCount ?? 0,
        onAcceptedRow: typeof options.onV5Result === "function"
          ? options.onV5Result
          : undefined,
      } : {});
    if (isInterleaved && !rowsState.present) rowsState.errors.push("individual results are missing");
    options.beforeFinalVerify?.();
    verifyOpenedPath(rowsOpened, rowsState.inspectedBytes, rowsState.completeRead);
    if (isInterleaved) {
      verifyOpenedPath(planOpened, planState.inspectedBytes, planState.completeRead);
      verifyOpenedPath(boundariesOpened, boundariesState.inspectedBytes, boundariesState.completeRead);
    }
    verifyOpenedPath(metaOpened, metaBytes.length);
    verifyOpenedPath(markerOpened, markerBytes.length);
    options.beforeDirectoryVerify?.();
    for (const directory of directories) verifyStableDirectory(directory);
  } finally {
    closeQuietly(rowsOpened?.fd);
    closeQuietly(planOpened?.fd);
    closeQuietly(boundariesOpened?.fd);
    closeQuietly(metaOpened.fd);
    closeQuietly(markerOpened.fd);
    for (const directory of directories) closeQuietly(directory.fd);
  }

  rowsState.errors = [...new Set([...rowsState.errors, ...rowsOpened.errors])];
  if (planState !== null) planState.errors = [...new Set([...planState.errors, ...planOpened.errors])];
  if (boundariesState !== null) {
    boundariesState.errors = [...new Set([...boundariesState.errors, ...boundariesOpened.errors])];
  }
  const markerErrors = [...markerOpened.errors];
  if (markerOpened.present && markerBytes.length !== 0) {
    markerErrors.push("individual completion marker must be empty");
  }
  const finalLayoutErrors = directories.flatMap((entry) => entry.errors);
  if (rowsOpened.errors.length > 0 || (planState?.errors.length ?? 0) > 0 ||
    (boundariesState?.errors.length ?? 0) > 0 || (planOpened?.errors.length ?? 0) > 0 ||
    (boundariesOpened?.errors.length ?? 0) > 0 || metaOpened.errors.length > 0 ||
    markerOpened.errors.length > 0 || finalLayoutErrors.length > 0) {
    // A pathname/descriptor or directory stability failure means even a
    // descriptive aggregate cannot be attributed to the inspected bundle.
    rowsState.summary = {
      ...rowsState.summary,
      summaries: [],
      failedRunDetailsOmitted: 0,
      failedRunDetailsOmittedIsDecimalString: false,
    };
  }
  metaState.errors = [...new Set([
    ...finalLayoutErrors,
    ...rowsState.errors,
    ...(planState?.errors ?? []),
    ...(boundariesState?.errors ?? []),
    ...metaState.errors,
    ...metaOpened.errors,
    ...markerErrors,
  ])];
  metaState.enforceBinding = true;
  metaState.rowsSha256 = rowsState.sha256;
  metaState.rowsBytes = rowsState.bytes;
  metaState.rowCount = rowsState.rowCount;
  metaState.rowSummary = rowsState.summary;
  if (isV5 || isV6) Object.assign(metaState, {
    planSha256: planState?.sha256 ?? null,
    planBytes: planState?.bytes ?? null,
    planRowCount: planState?.rowCount ?? null,
    boundariesSha256: boundariesState?.sha256 ?? null,
    boundariesBytes: boundariesState?.bytes ?? null,
    boundaryRowCount: boundariesState?.rowCount ?? null,
  });
  const evidence = {
    rows: [],
    rowsState,
    metaState,
    phaseDone: markerOpened.present && markerErrors.length === 0,
  };
  if (isV5 || isV6) Object.assign(evidence, { planState, boundariesState });
  return evidence;
}

export function assessIndividualEvidence(outDir, options = {}) {
  const evidence = inspectIndividualEvidence(outDir, options);
  return {
    evidence,
    assessment: assessIndividual(
      evidence.rows,
      evidence.metaState.values,
      evidence.phaseDone,
      evidence.metaState,
    ),
  };
}

export function inspectIndividualV5Artifacts(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("V5 artifact options must be an object");
  }
  const targets = parseCanonicalCpuList(options.targetCpus);
  const rounds = canonicalUint(options.runsPerCpu);
  const seed = canonicalUint(options.scheduleSeed);
  const requireComplete = options.requireComplete === true
    ? true
    : options.requireComplete === false
      ? false
      : null;
  const errors = [];
  if (!targets || rounds === null || rounds < 1 || seed === null || seed > MAX_SEED ||
      requireComplete === null || BigInt(targets?.size ?? 0) * BigInt(rounds ?? 0) > BigInt(MAX_SCHEDULE_ENTRIES)) {
    return { valid: false, errors: ["version 5 artifact bounds are invalid"] };
  }
  const schedule = v5Schedule({
    TARGET_CPUS: options.targetCpus,
    RUNS_PER_CPU: options.runsPerCpu,
    SCHEDULE_SEED: options.scheduleSeed,
  });
  if (schedule.orders === null) return { valid: false, errors: ["version 5 artifact schedule is invalid"] };
  const owner = options.requiredOwner ?? process.geteuid?.() ?? process.getuid();
  const expectedRows = BigInt(schedule.expectedRows);
  const planOpened = openStablePath(
    options.planFile,
    BigInt(Buffer.byteLength(`${PLAN_HEADER}\n`)) + expectedRows * INDIVIDUAL_PLAN_ROW_MAX_BYTES,
    "individual plan",
    owner,
  );
  const boundariesOpened = openStablePath(
    options.boundariesFile,
    expectedRows * INDIVIDUAL_BOUNDARY_ROW_MAX_BYTES,
    "individual boundaries",
    owner,
  );
  const rowsOpened = openStablePath(
    options.rowsFile,
    expectedRows * INDIVIDUAL_ROW_MAX_BYTES,
    "individual results",
    owner,
  );
  let planState;
  let boundariesState;
  let rowsState;
  try {
    planState = inspectOpenedPlan(planOpened, schedule);
    boundariesState = inspectOpenedBoundaries(boundariesOpened, schedule);
    rowsState = inspectOpenedRows(rowsOpened, expectedRows, targets, rounds, {
      planOrders: schedule.orders,
      authorityRowLimit: boundariesState.rowCount,
    });
    if (!rowsState.present) rowsState.errors.push("individual results are missing");
    verifyOpenedPath(planOpened, planState.inspectedBytes, planState.completeRead);
    verifyOpenedPath(boundariesOpened, boundariesState.inspectedBytes, boundariesState.completeRead);
    verifyOpenedPath(rowsOpened, rowsState.inspectedBytes, rowsState.completeRead);
  } finally {
    closeQuietly(planOpened.fd);
    closeQuietly(boundariesOpened.fd);
    closeQuietly(rowsOpened.fd);
  }
  planState.errors = [...new Set([...planState.errors, ...planOpened.errors])];
  boundariesState.errors = [...new Set([...boundariesState.errors, ...boundariesOpened.errors])];
  rowsState.errors = [...new Set([...rowsState.errors, ...rowsOpened.errors])];
  errors.push(...planState.errors, ...boundariesState.errors, ...rowsState.errors);
  if (requireComplete &&
      (rowsState.rowCount !== schedule.expectedRows || boundariesState.rowCount !== schedule.expectedRows)) {
    errors.push("version 5 artifacts are not complete");
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    expectedRowCount: schedule.expectedRows,
    commonPrefixRowCount: Math.min(
      rowsState.summary.validatedPlanPrefixRows ?? rowsState.rowCount,
      boundariesState.rowCount,
    ),
    planState,
    rowsState,
    boundariesState,
  };
}

export function inspectIndividualV6Artifacts(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("V6 artifact options must be an object");
  }
  const targets = parseCanonicalCpuList(options.targetCpus);
  const rounds = canonicalUint(options.runsPerCpu);
  const seed = canonicalUint(options.scheduleSeed);
  const requireComplete = options.requireComplete === true
    ? true
    : options.requireComplete === false
      ? false
      : null;
  const errors = [];
  if (!targets || rounds === null || rounds < 1 || seed === null || seed > MAX_SEED ||
      requireComplete === null ||
      BigInt(targets?.size ?? 0) * BigInt(rounds ?? 0) > BigInt(MAX_SCHEDULE_ENTRIES)) {
    return { valid: false, errors: ["version 6 artifact bounds are invalid"] };
  }
  const schedule = v5Schedule({
    TARGET_CPUS: options.targetCpus,
    RUNS_PER_CPU: options.runsPerCpu,
    SCHEDULE_SEED: options.scheduleSeed,
  });
  if (schedule.orders === null) return { valid: false, errors: ["version 6 artifact schedule is invalid"] };
  const owner = options.requiredOwner ?? process.geteuid?.() ?? process.getuid();
  const expectedRows = BigInt(schedule.expectedRows);
  const planOpened = openStablePath(
    options.planFile,
    BigInt(Buffer.byteLength(`${PLAN_HEADER}\n`)) + expectedRows * INDIVIDUAL_PLAN_ROW_MAX_BYTES,
    "individual plan",
    owner,
  );
  const boundariesOpened = openStablePath(
    options.boundariesFile,
    expectedRows * INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES,
    "individual V6 boundaries",
    owner,
  );
  const rowsOpened = openStablePath(
    options.rowsFile,
    expectedRows * INDIVIDUAL_V6_ROW_MAX_BYTES,
    "individual V6 results",
    owner,
  );
  let planState;
  let boundariesState;
  let rowsState;
  const boundaries = [];
  try {
    planState = inspectOpenedPlan(planOpened, schedule);
    boundariesState = inspectOpenedBoundariesV6(boundariesOpened, schedule, {
      onAcceptedBoundary: (row) => boundaries.push(row),
    });
    rowsState = inspectOpenedV6Rows(rowsOpened, schedule, {
      boundaries,
      authorityRowLimit: boundariesState.rowCount,
      requireComplete,
    });
    if (!rowsState.present) rowsState.errors.push("individual results are missing");
    verifyOpenedPath(planOpened, planState.inspectedBytes, planState.completeRead);
    verifyOpenedPath(boundariesOpened, boundariesState.inspectedBytes, boundariesState.completeRead);
    verifyOpenedPath(rowsOpened, rowsState.inspectedBytes, rowsState.completeRead);
  } finally {
    closeQuietly(planOpened.fd);
    closeQuietly(boundariesOpened.fd);
    closeQuietly(rowsOpened.fd);
  }
  planState.errors = [...new Set([...planState.errors, ...planOpened.errors])];
  boundariesState.errors = [...new Set([...boundariesState.errors, ...boundariesOpened.errors])];
  rowsState.errors = [...new Set([...rowsState.errors, ...rowsOpened.errors])];
  errors.push(...planState.errors, ...boundariesState.errors, ...rowsState.errors);
  if (requireComplete &&
      (rowsState.rowCount !== schedule.expectedRows || boundariesState.rowCount !== schedule.expectedRows)) {
    errors.push("version 6 artifacts are not complete");
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    expectedRowCount: schedule.expectedRows,
    commonPrefixRowCount: Math.min(
      rowsState.summary.validatedPlanPrefixRows ?? rowsState.rowCount,
      boundariesState.rowCount,
    ),
    planState,
    rowsState,
    boundariesState,
  };
}

function validateRowsPrefix(state, targetsText, expectedText, requireCompleteText) {
  const targets = parseCanonicalCpuList(targetsText);
  const expected = canonicalUint(expectedText);
  const requireComplete = requireCompleteText === "1" ? true : requireCompleteText === "0" ? false : null;
  if (!targets || expected === null || expected < 1 || requireComplete === null ||
    !state.present || state.errors.length > 0 || state.summary.invalidRows || !state.completeRead) return null;
  if (requireComplete && [...state.summary.counts.values()].some((count) => count !== expected)) return null;
  return { ...state.summary, expected };
}

function inspectRowsFile(file, targetsText, expectedText, options = {}) {
  const targets = parseCanonicalCpuList(targetsText);
  const expected = canonicalUint(expectedText);
  if (!targets || expected === null || expected < 1) {
    return { present: true, errors: ["individual row bounds are invalid"] };
  }
  const maxRows = BigInt(targets.size) * BigInt(expected);
  const opened = openStablePath(
    file,
    maxRows * INDIVIDUAL_ROW_MAX_BYTES,
    "individual results",
    process.geteuid?.() ?? process.getuid(),
  );
  let state;
  try {
    state = inspectOpenedRows(opened, maxRows, targets, expected, options);
    verifyOpenedPath(opened, state.inspectedBytes, state.completeRead);
    state.errors = [...new Set([...state.errors, ...opened.errors])];
    return state;
  } finally {
    closeQuietly(opened.fd);
  }
}

function validateMetaForShell(metaState) {
  const assessment = assessIndividual([], metaState.values, false, { ...metaState, metadataOnly: true });
  const onlyExpectedIncompleteReasons = new Set([
    "individual results do not contain every expected per-CPU run",
    "phase completion marker is missing",
    "individual metadata is not marked complete",
  ]);
  return assessment.status !== "invalid" &&
    assessment.reasons.every((reason) => onlyExpectedIncompleteReasons.has(reason));
}

function printShellMeta(values) {
  const keys = [
    "VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED",
    "TARGET_POLICY", "GROUP_PLAN_DIGEST", "GROUP_GENERATION", "GENERATION",
    "ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT",
  ];
  if (values.VERSION === "5" || values.VERSION === "6") keys.push(
    "PROTOCOL", "SCHEDULE_SEED", "SCHEDULE_ALGORITHM",
    "PLAN_SHA256", "PLAN_BYTES", "PLAN_ROW_COUNT",
    "BOUNDARIES_SHA256", "BOUNDARIES_BYTES", "BOUNDARY_ROW_COUNT",
  );
  for (const key of keys) {
    console.log(`${key}=${values[key] ?? ""}`);
  }
  console.log(`SKIP_REASON_PRESENT=${Object.hasOwn(values, "SKIP_REASON") ? 1 : 0}`);
}

function worstCpu(rows) {
  const counts = new Map();
  const failures = new Map();
  for (const [cpuText, , rcText] of rows) {
    const cpu = Number(cpuText);
    counts.set(cpu, (counts.get(cpu) ?? 0) + 1);
    if (rcText === "139") failures.set(cpu, (failures.get(cpu) ?? 0) + 1);
  }
  return [...counts]
    .filter(([cpu]) => (failures.get(cpu) ?? 0) > 0)
    .sort(([cpuA, countA], [cpuB, countB]) =>
      (failures.get(cpuB) / countB) - (failures.get(cpuA) / countA) ||
      failures.get(cpuB) - failures.get(cpuA) || cpuA - cpuB)[0]?.[0] ?? null;
}

function worstCpuFromSummaries(summaries) {
  return summaries
    .filter((record) => record.sigsegv > 0 && record.runs > 0)
    .sort((left, right) => {
      const leftProduct = BigInt(left.sigsegv) * BigInt(right.runs);
      const rightProduct = BigInt(right.sigsegv) * BigInt(left.runs);
      if (leftProduct !== rightProduct) return leftProduct > rightProduct ? -1 : 1;
      return right.sigsegv - left.sigsegv || left.cpu - right.cpu;
    })[0]?.cpu ?? null;
}

function usage() {
  console.error("usage: individual-evidence.mjs <meta|rows|binding|empty-binding|count|batch|bundle|v5-plan|v5-binding|v5-bundle|v6-binding|v6-bundle> ...");
  process.exitCode = 2;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "v5-plan" && args.length === 3) {
    const targets = parseCanonicalCpuList(args[0]);
    const rounds = canonicalUint(args[1]);
    const seed = canonicalUint(args[2]);
    if (!targets || rounds === null || rounds < 1 || seed === null || seed > MAX_SEED) {
      process.exitCode = 1;
    } else {
      try {
        process.stdout.write(renderIndividualPlan([...targets], rounds, seed));
      } catch {
        process.exitCode = 1;
      }
    }
    return;
  }
  if (command === "v5-binding" && args.length === 7) {
    const requireComplete = args[6] === "1" ? true : args[6] === "0" ? false : null;
    const inspected = inspectIndividualV5Artifacts({
      planFile: args[0],
      rowsFile: args[1],
      boundariesFile: args[2],
      targetCpus: args[3],
      runsPerCpu: args[4],
      scheduleSeed: args[5],
      requireComplete,
    });
    if (!inspected.valid) {
      process.exitCode = 1;
    } else {
      console.log(`PLAN_SHA256=${inspected.planState.sha256}`);
      console.log(`PLAN_BYTES=${inspected.planState.bytes}`);
      console.log(`PLAN_ROW_COUNT=${inspected.planState.rowCount}`);
      console.log(`RESULT_PREFIX_ROW_COUNT=${inspected.rowsState.rowCount}`);
      console.log(`BOUNDARY_PREFIX_ROW_COUNT=${inspected.boundariesState.rowCount}`);
      console.log(`COMMON_PREFIX_ROW_COUNT=${inspected.commonPrefixRowCount}`);
      if (requireComplete) {
        console.log(`ROWS_SHA256=${inspected.rowsState.sha256}`);
        console.log(`ROWS_BYTES=${inspected.rowsState.bytes}`);
        console.log(`ROW_COUNT=${inspected.rowsState.rowCount}`);
        console.log(`BOUNDARIES_SHA256=${inspected.boundariesState.sha256}`);
        console.log(`BOUNDARIES_BYTES=${inspected.boundariesState.bytes}`);
        console.log(`BOUNDARY_ROW_COUNT=${inspected.boundariesState.rowCount}`);
      }
    }
    return;
  }
  if (command === "v6-binding" && args.length === 7) {
    const requireComplete = args[6] === "1" ? true : args[6] === "0" ? false : null;
    const inspected = inspectIndividualV6Artifacts({
      planFile: args[0],
      rowsFile: args[1],
      boundariesFile: args[2],
      targetCpus: args[3],
      runsPerCpu: args[4],
      scheduleSeed: args[5],
      requireComplete,
    });
    if (!inspected.valid) {
      process.exitCode = 1;
    } else {
      console.log(`PLAN_SHA256=${inspected.planState.sha256}`);
      console.log(`PLAN_BYTES=${inspected.planState.bytes}`);
      console.log(`PLAN_ROW_COUNT=${inspected.planState.rowCount}`);
      console.log(`RESULT_PREFIX_ROW_COUNT=${inspected.rowsState.rowCount}`);
      console.log(`BOUNDARY_PREFIX_ROW_COUNT=${inspected.boundariesState.rowCount}`);
      console.log(`COMMON_PREFIX_ROW_COUNT=${inspected.commonPrefixRowCount}`);
      if (requireComplete) {
        console.log(`ROWS_SHA256=${inspected.rowsState.sha256}`);
        console.log(`ROWS_BYTES=${inspected.rowsState.bytes}`);
        console.log(`ROW_COUNT=${inspected.rowsState.rowCount}`);
        console.log(`BOUNDARIES_SHA256=${inspected.boundariesState.sha256}`);
        console.log(`BOUNDARIES_BYTES=${inspected.boundariesState.bytes}`);
        console.log(`BOUNDARY_ROW_COUNT=${inspected.boundariesState.rowCount}`);
      }
    }
    return;
  }
  if (command === "v5-bundle" && args.length === 1) {
    const { evidence, assessment } = assessIndividualEvidence(args[0], {
      requiredOwner: process.geteuid?.() ?? process.getuid(),
    });
    console.log(`STATUS=${assessment.status}`);
    printShellMeta(evidence.metaState.values);
    console.log(`COMMON_PREFIX_ROW_COUNT=${assessment.commonPrefixRowCount ?? ""}`);
    if (assessment.metadataVersion !== "5" || assessment.status === "invalid") process.exitCode = 1;
    return;
  }
  if (command === "v6-bundle" && args.length === 1) {
    const { evidence, assessment } = assessIndividualEvidence(args[0], {
      requiredOwner: process.geteuid?.() ?? process.getuid(),
    });
    console.log(`STATUS=${assessment.status}`);
    printShellMeta(evidence.metaState.values);
    console.log(`COMMON_PREFIX_ROW_COUNT=${assessment.commonPrefixRowCount ?? ""}`);
    if (assessment.metadataVersion !== "6" || assessment.status === "invalid") process.exitCode = 1;
    return;
  }
  if (command === "meta" && args.length === 1) {
    const state = parseIndividualMeta(readStableRegularFile(
      args[0], INDIVIDUAL_META_MAX_BYTES, "individual metadata",
      { requiredOwner: process.geteuid?.() ?? process.getuid() },
    ));
    if (!state.present || !validateMetaForShell(state)) process.exitCode = 1;
    else printShellMeta(state.values);
    return;
  }
  if (command === "rows" && args.length === 4) {
    const state = inspectRowsFile(args[0], args[1], args[2]);
    if (!state.present || state.errors.length > 0 ||
      !validateRowsPrefix(state, args[1], args[2], args[3])) process.exitCode = 1;
    return;
  }
  if (command === "binding" && args.length === 4) {
    const state = inspectRowsFile(args[0], args[1], args[2]);
    const summary = state.present && state.errors.length === 0
      ? validateRowsPrefix(state, args[1], args[2], args[3])
      : null;
    if (!summary || state.sha256 === null) process.exitCode = 1;
    else {
      console.log(`ROWS_SHA256=${state.sha256}`);
      console.log(`ROWS_BYTES=${state.bytes}`);
      console.log(`ROW_COUNT=${state.rowCount}`);
    }
    return;
  }
  if (command === "empty-binding" && args.length === 1) {
    const inspected = readStableRegularFile(args[0], 0, "individual results", {
      requiredOwner: process.geteuid?.() ?? process.getuid(),
    });
    if (!inspected.present || inspected.errors.length > 0 || inspected.bytes?.length !== 0) {
      process.exitCode = 1;
    } else {
      console.log(`ROWS_SHA256=${createHash("sha256").update(inspected.bytes).digest("hex")}`);
      console.log("ROWS_BYTES=0");
      console.log("ROW_COUNT=0");
    }
    return;
  }
  if (command === "count" && args.length === 4) {
    const state = inspectRowsFile(args[0], args[1], args[2]);
    const summary = state.present && state.errors.length === 0
      ? validateRowsPrefix(state, args[1], args[2], "0")
      : null;
    const cpu = canonicalUint(args[3]);
    if (!summary || cpu === null || !summary.counts.has(cpu)) process.exitCode = 1;
    else console.log(summary.counts.get(cpu));
    return;
  }
  if (command === "batch" && args.length === 6) {
    const cpu = canonicalUint(args[3]);
    const before = canonicalUint(args[4]);
    const wrapper = args[5] === "0" || args[5] === "1" ? Number(args[5]) : null;
    const state = inspectRowsFile(args[0], args[1], args[2], {
      batch: cpu !== null && before !== null ? { cpu, before } : null,
    });
    const summary = state.present && state.errors.length === 0
      ? validateRowsPrefix(state, args[1], args[2], "0")
      : null;
    if (!summary || cpu === null || before === null || wrapper === null || !summary.counts.has(cpu)) {
      process.exitCode = 1;
      return;
    }
    const wrapperMatches = (wrapper === 0 && summary.batchSigsegv === 0) ||
      (wrapper === 1 && summary.batchSigsegv > 0);
    if (summary.batchRows !== summary.expected - before || !wrapperMatches) process.exitCode = 1;
    return;
  }
  if (command === "bundle" && args.length === 1) {
    const { evidence, assessment } = assessIndividualEvidence(args[0], {
      requiredOwner: process.geteuid?.() ?? process.getuid(),
    });
    console.log(`STATUS=${assessment.status}`);
    printShellMeta(evidence.metaState.values);
    const worst = assessment.status === "complete"
      ? assessment.acceptedSummaries
        ? worstCpuFromSummaries(assessment.acceptedSummaries)
        : worstCpu(assessment.acceptedRows)
      : null;
    console.log(`WORST_CPU=${worst ?? ""}`);
    return;
  }
  usage();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
