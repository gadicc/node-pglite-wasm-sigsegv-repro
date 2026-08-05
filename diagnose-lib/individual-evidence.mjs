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
import path from "node:path";
import { pathToFileURL } from "node:url";

export const INDIVIDUAL_META_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_TSV_FALLBACK_MAX_BYTES = 1024 * 1024;
export const INDIVIDUAL_ROW_MAX_BYTES = 44n;
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
]);

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

function createRowAccumulator(targets, expected, batch = null) {
  const counts = new Map(targets ? [...targets].map((cpu) => [cpu, 0]) : []);
  const sigsegv = new Map(targets ? [...targets].map((cpu) => [cpu, 0]) : []);
  const byCpu = new Map();
  const ambiguousCpus = new Set();
  let invalidRows = false;
  let batchRows = 0;
  let batchSigsegv = 0;
  let retainedFailureDetails = 0;

  const reject = (cpu = null, ambiguous = false) => {
    invalidRows = true;
    if (ambiguous && cpu !== null && targets?.has(cpu)) ambiguousCpus.add(cpu);
  };
  const acceptFields = (fields) => {
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
    return {
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
  };
  return { acceptFields, reject, finish };
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
    summary: createRowAccumulator(targets, expected, options.batch).finish(),
  };
  if (!opened.present || opened.fd === undefined || opened.errors.length > 0) return base;

  const accumulator = createRowAccumulator(targets, expected, options.batch);
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
    accumulator.acceptFields(lineBuffer.subarray(0, lineLength).toString("utf8").split("\t"));
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
  if (meta.VERSION !== "1" && meta.VERSION !== "2" && meta.VERSION !== "3" && meta.VERSION !== "4") {
    reasons.push("individual metadata version is missing or unsupported");
    invalid = true;
  }
  const provenanceRequired = meta.VERSION === "2" || meta.VERSION === "3" || meta.VERSION === "4";
  if (provenanceRequired) {
    if (!Object.hasOwn(meta, "TARGET_POLICY") || !Object.hasOwn(meta, "GROUP_PLAN_DIGEST")) {
      reasons.push("individual metadata is missing target provenance fields");
      invalid = true;
    }
    if (!["failed-groups", "all-group-cpus", "quick-skip"].includes(meta.TARGET_POLICY) ||
        !/^[a-f0-9]{64}$/.test(meta.GROUP_PLAN_DIGEST ?? "")) {
      reasons.push("individual target provenance is malformed");
      invalid = true;
    }
  } else if (Object.hasOwn(meta, "TARGET_POLICY") || Object.hasOwn(meta, "GROUP_PLAN_DIGEST") ||
    Object.hasOwn(meta, "GROUP_GENERATION") || Object.hasOwn(meta, "GENERATION") ||
    Object.hasOwn(meta, "ROWS_SHA256") || Object.hasOwn(meta, "ROWS_BYTES") ||
    Object.hasOwn(meta, "ROW_COUNT")) {
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
  let metaState;
  let expectedRows = null;
  try {
    markerBytes = readOpenedPath(markerOpened, 0);
    metaBytes = readOpenedPath(metaOpened, INDIVIDUAL_META_MAX_BYTES);
    metaState = parseIndividualMeta({
      present: metaOpened.present,
      bytes: metaOpened.errors.length === 0 ? metaBytes : null,
      errors: metaOpened.errors,
    });
    const targets = parseCanonicalCpuList(metaState.values.TARGET_CPUS);
    const runs = canonicalUint(metaState.values.RUNS_PER_CPU);
    if (metaState.values.SKIPPED === "1" && metaState.values.TARGET_CPUS === "" && runs !== null && runs > 0) {
      expectedRows = 0n;
    } else if (metaState.values.SKIPPED === "0" && targets && runs !== null && runs > 0) {
      expectedRows = BigInt(targets.size) * BigInt(runs);
    }
    const rowMaxBytes = expectedRows === null
      ? BigInt(INDIVIDUAL_TSV_FALLBACK_MAX_BYTES)
      : expectedRows * INDIVIDUAL_ROW_MAX_BYTES;
    rowsOpened = resultsSafe
      ? openStablePath(anchoredRows, rowMaxBytes, "individual results", requiredOwner)
      : unavailable(path.join(publicResultsDir, "individual.tsv"), "individual results", "individual results cannot be trusted through an unsafe results directory");
    rowsState = inspectOpenedRows(rowsOpened, expectedRows, targets, runs);
    options.beforeFinalVerify?.();
    verifyOpenedPath(rowsOpened, rowsState.inspectedBytes, rowsState.completeRead);
    verifyOpenedPath(metaOpened, metaBytes.length);
    verifyOpenedPath(markerOpened, markerBytes.length);
    options.beforeDirectoryVerify?.();
    for (const directory of directories) verifyStableDirectory(directory);
  } finally {
    closeQuietly(rowsOpened?.fd);
    closeQuietly(metaOpened.fd);
    closeQuietly(markerOpened.fd);
    for (const directory of directories) closeQuietly(directory.fd);
  }

  rowsState.errors = [...new Set([...rowsState.errors, ...rowsOpened.errors])];
  const markerErrors = [...markerOpened.errors];
  if (markerOpened.present && markerBytes.length !== 0) {
    markerErrors.push("individual completion marker must be empty");
  }
  const finalLayoutErrors = directories.flatMap((entry) => entry.errors);
  if (rowsOpened.errors.length > 0 || metaOpened.errors.length > 0 ||
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
    ...metaState.errors,
    ...metaOpened.errors,
    ...markerErrors,
  ])];
  metaState.enforceBinding = true;
  metaState.rowsSha256 = rowsState.sha256;
  metaState.rowsBytes = rowsState.bytes;
  metaState.rowCount = rowsState.rowCount;
  metaState.rowSummary = rowsState.summary;
  return {
    rows: [],
    rowsState,
    metaState,
    phaseDone: markerOpened.present && markerErrors.length === 0,
  };
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
  const assessment = assessIndividual([], metaState.values, false, metaState);
  const onlyExpectedIncompleteReasons = new Set([
    "individual results do not contain every expected per-CPU run",
    "phase completion marker is missing",
    "individual metadata is not marked complete",
  ]);
  return assessment.status !== "invalid" &&
    assessment.reasons.every((reason) => onlyExpectedIncompleteReasons.has(reason));
}

function printShellMeta(values) {
  for (const key of [
    "VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED",
    "TARGET_POLICY", "GROUP_PLAN_DIGEST", "GROUP_GENERATION", "GENERATION",
    "ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT",
  ]) {
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
  console.error("usage: individual-evidence.mjs <meta|rows|binding|empty-binding|count|batch|bundle> ...");
  process.exitCode = 2;
}

function main(argv) {
  const [command, ...args] = argv;
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
