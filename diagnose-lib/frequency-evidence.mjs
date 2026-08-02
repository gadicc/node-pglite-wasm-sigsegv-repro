import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GENERATION_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const POSITIVE_RE = /^[1-9][0-9]*$/;
const META_MAX_BYTES = 64 * 1024;
const TSV_MAX_BYTES = 16 * 1024 * 1024;
const SAMPLE_MAX_BYTES = 64 * 1024 * 1024;

const AB_KEYS = new Set([
  "GENERATION", "CPU", "RUNS_PER_LEG", "SAVED_NO_TURBO", "CAP_REQUESTED", "REQUESTED_CAP_KHZ",
  "LEG_A1_NO_TURBO", "LEG_A1_SCALING_MAX_KHZ",
  "LEG_B_NO_TURBO", "LEG_B_SCALING_MAX_KHZ",
  "LEG_A2_NO_TURBO", "LEG_A2_SCALING_MAX_KHZ",
  "RESTORED", "ROWS_SHA256",
  "LEG_A1_SAMPLES_SHA256", "LEG_A1_METHOD_SHA256",
  "LEG_B_SAMPLES_SHA256", "LEG_B_METHOD_SHA256",
  "LEG_A2_SAMPLES_SHA256", "LEG_A2_METHOD_SHA256",
  "CAP_COMPLETED", "COMPLETED",
]);
const CAP_KEYS = new Set([
  "GENERATION", "CPU", "CAP_KHZ", "SAVED_SCALING_MAX_KHZ", "RUNS_PER_LEG",
  "RESTORED", "ROWS_SHA256", "SAMPLES_SHA256", "METHOD_SHA256", "COMPLETED",
]);

function inspectRegularFile(file, maxBytes, label, retainContent = true) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, errors: [], content: null, digest: null };
    return { present: true, errors: [`${label} could not be inspected`], content: null, digest: null };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { present: true, errors: [`${label} must be a real regular file`], content: null, digest: null };
  }
  if (stat.size > maxBytes) {
    return { present: true, errors: [`${label} exceeds the validation size limit`], content: null, digest: null };
  }
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("not regular");
    const hash = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        return { present: true, errors: [`${label} exceeds the validation size limit`], content: null, digest: null };
      }
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (retainContent) chunks.push(Buffer.from(chunk));
    }
    return {
      present: true,
      errors: [],
      content: retainContent ? Buffer.concat(chunks, total) : null,
      digest: hash.digest("hex"),
    };
  } catch {
    return { present: true, errors: [`${label} could not be read`], content: null, digest: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inspectDirectory(dir, label, required = false) {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { safe: false, present: true, reason: `${label} must be a real directory` };
    return { safe: true, present: true, reason: null };
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return { safe: true, present: false, reason: null };
    return { safe: false, present: false, reason: `${label} is missing or could not be inspected` };
  }
}

function unavailableFile(reason) {
  return { present: true, errors: [reason], content: null, digest: null };
}

function readStrictMeta(file, allowed, label) {
  const inspected = inspectRegularFile(file, META_MAX_BYTES, label);
  const values = {};
  const errors = [...inspected.errors];
  if (!inspected.present || inspected.content === null) return { ...inspected, values, errors };
  const text = inspected.content.toString("utf8");
  if (!text.endsWith("\n")) errors.push(`${label} must end with a newline`);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(`${label} contains a malformed line`);
      continue;
    }
    const [, key, value] = match;
    if (!allowed.has(key)) errors.push(`${label} contains unknown key ${key}`);
    if (seen.has(key)) errors.push(`${label} contains duplicate key ${key}`);
    seen.add(key);
    values[key] = value;
  }
  return { ...inspected, values, errors: [...new Set(errors)] };
}

function readExactRows(file, label) {
  const inspected = inspectRegularFile(file, TSV_MAX_BYTES, label);
  if (!inspected.present || inspected.content === null) return { ...inspected, rows: [] };
  const text = inspected.content.toString("utf8");
  const errors = [...inspected.errors];
  if (text !== "" && !text.endsWith("\n")) errors.push(`${label} must end with a newline`);
  const lines = text === "" ? [] : text.slice(0, text.endsWith("\n") ? -1 : undefined).split("\n");
  return { ...inspected, errors, rows: lines.map((line) => line.split("\t")) };
}

function canonicalSafeInteger(value, positive = false) {
  if (!(positive ? POSITIVE_RE : UINT_RE).test(value ?? "")) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function requireDigest(meta, key, artifact, label, reasons) {
  if (!SHA256_RE.test(meta[key] ?? "")) {
    reasons.push(`${key} is missing or invalid`);
    return;
  }
  reasons.push(...artifact.errors);
  if (!artifact.present) reasons.push(`${label} is missing`);
  else if (artifact.digest !== meta[key]) reasons.push(`${label} does not match its recorded generation digest`);
}

function validateRows(rowsState, expectedLegs, runs, label, reasons) {
  reasons.push(...rowsState.errors);
  if (!rowsState.present) reasons.push(`${label} is missing`);
  if (runs === null) return;
  const counts = Object.fromEntries(expectedLegs.map((leg) => [leg, 0]));
  const seen = new Set();
  let invalid = false;
  for (const row of rowsState.rows) {
    const [leg, runText, rcText, elapsedText] = row;
    const run = canonicalSafeInteger(runText, true);
    const elapsed = canonicalSafeInteger(elapsedText);
    const key = `${leg}:${runText}`;
    if (
      row.length !== 4 || !Object.hasOwn(counts, leg) || run === null || run > runs ||
      (rcText !== "0" && rcText !== "139") || elapsed === null || seen.has(key)
    ) {
      invalid = true;
      continue;
    }
    seen.add(key);
    counts[leg] += 1;
  }
  if (invalid) reasons.push(`${label} contains an invalid or duplicate row`);
  if (Object.values(counts).some((count) => count !== runs)) {
    reasons.push(`${label} does not contain every expected run`);
  }
}

function normalizeExpectedCpuState(options) {
  if (Object.hasOwn(options, "expectedCpuState")) {
    const state = options.expectedCpuState;
    if (state?.status === "resolved") {
      const cpu = canonicalSafeInteger(String(state.cpu));
      if (cpu !== null && cpu <= 65535) return { status: "resolved", cpu, reason: null };
      return { status: "invalid", cpu: null, reason: "the expected CPU target is malformed" };
    }
    if (["none", "unavailable", "invalid"].includes(state?.status)) {
      return {
        status: state.status,
        cpu: null,
        reason: typeof state.reason === "string" && state.reason !== ""
          ? state.reason
          : "no validated CPU target authorizes this frequency evidence",
      };
    }
    return { status: "invalid", cpu: null, reason: "the expected CPU target state is malformed" };
  }
  if (Object.hasOwn(options, "expectedCpu")) {
    const cpu = canonicalSafeInteger(String(options.expectedCpu));
    return cpu !== null && cpu <= 65535
      ? { status: "resolved", cpu, reason: null }
      : { status: "invalid", cpu: null, reason: "the expected CPU target is malformed" };
  }
  return { status: "unchecked", cpu: null, reason: null };
}

function validateAb(metaState, rowsState, artifacts, phaseDone, expectedCpuState, layoutErrors) {
  const meta = metaState.values;
  const hasArtifacts = metaState.present || rowsState.present || artifacts.some((entry) => entry.present) || phaseDone;
  if (!hasArtifacts) return { status: "not-run", reasons: [] };
  const reasons = [...layoutErrors, ...metaState.errors];
  if (!metaState.present) reasons.push("frequency A/B/A metadata is missing");
  if (!phaseDone) reasons.push("phase completion marker is missing");
  if (!GENERATION_RE.test(meta.GENERATION ?? "")) reasons.push("GENERATION is missing or invalid");
  const cpu = canonicalSafeInteger(meta.CPU);
  if (cpu === null || cpu > 65535) reasons.push("CPU is missing or invalid");
  if (expectedCpuState.status === "resolved" && cpu !== expectedCpuState.cpu) {
    reasons.push("frequency CPU does not match the expected target");
  } else if (expectedCpuState.status !== "resolved" && expectedCpuState.status !== "unchecked") {
    reasons.push(expectedCpuState.reason);
  }
  const runs = canonicalSafeInteger(meta.RUNS_PER_LEG, true);
  if (runs === null) reasons.push("RUNS_PER_LEG is missing or invalid");
  if (meta.SAVED_NO_TURBO !== "0") reasons.push("SAVED_NO_TURBO must be 0");
  if (meta.RESTORED !== "1") reasons.push("frequency settings are not verified as restored");
  if (meta.COMPLETED !== "1") reasons.push("frequency metadata is not marked complete");
  if (meta.CAP_REQUESTED !== "0" && meta.CAP_REQUESTED !== "1") reasons.push("CAP_REQUESTED is missing or invalid");
  if (meta.CAP_COMPLETED !== meta.CAP_REQUESTED) reasons.push("CAP_COMPLETED does not match CAP_REQUESTED");
  if (meta.CAP_REQUESTED === "0" && meta.REQUESTED_CAP_KHZ !== "-") reasons.push("REQUESTED_CAP_KHZ must be - when no cap was requested");
  if (meta.CAP_REQUESTED === "1" && (canonicalSafeInteger(meta.REQUESTED_CAP_KHZ, true) ?? 0) < 100000) {
    reasons.push("REQUESTED_CAP_KHZ is missing or invalid");
  }
  if (meta.LEG_A1_NO_TURBO !== "0" || meta.LEG_B_NO_TURBO !== "1" || meta.LEG_A2_NO_TURBO !== "0") {
    reasons.push("A1/B/A2 frequency modes are missing or inconsistent");
  }
  for (const leg of ["A1", "B", "A2"]) {
    const scaling = meta[`LEG_${leg}_SCALING_MAX_KHZ`];
    if (scaling !== "-" && canonicalSafeInteger(scaling, true) === null) {
      reasons.push(`LEG_${leg}_SCALING_MAX_KHZ is missing or invalid`);
    }
  }
  requireDigest(meta, "ROWS_SHA256", rowsState, "frequency A/B/A rows", reasons);
  for (let i = 0; i < artifacts.length; i += 2) {
    const leg = ["A1", "B", "A2"][i / 2];
    requireDigest(meta, `LEG_${leg}_SAMPLES_SHA256`, artifacts[i], `${leg} frequency samples`, reasons);
    requireDigest(meta, `LEG_${leg}_METHOD_SHA256`, artifacts[i + 1], `${leg} frequency method`, reasons);
  }
  validateRows(rowsState, ["A1", "B", "A2"], runs, "frequency A/B/A rows", reasons);
  return reasons.length === 0 ? { status: "complete", reasons: [] } : { status: "incomplete", reasons: [...new Set(reasons)] };
}

function validateCap(abMeta, abStatus, metaState, rowsState, artifacts) {
  const meta = metaState.values;
  const hasArtifacts = metaState.present || rowsState.present || artifacts.some((entry) => entry.present);
  if (abStatus.status === "not-run") {
    return hasArtifacts
      ? { status: "incomplete", reasons: ["frequency-cap artifacts have no current parent A/B/A generation"] }
      : { status: "not-run", reasons: [] };
  }
  if (abMeta.CAP_REQUESTED === "0" && abStatus.status === "complete") {
    const reasons = hasArtifacts ? ["cap artifacts are not authoritative for the current A/B/A generation"] : [];
    return { status: "not-requested", reasons };
  }
  if (abMeta.CAP_REQUESTED !== "1") {
    const reasons = ["the parent A/B/A envelope is incomplete or has invalid CAP_REQUESTED metadata"];
    if (hasArtifacts) reasons.push("frequency-cap artifacts have no valid requesting parent generation");
    return { status: "incomplete", reasons };
  }
  const reasons = [...metaState.errors];
  if (abStatus.status !== "complete") reasons.push("the parent frequency A/B/A envelope is incomplete");
  if (abMeta.CAP_COMPLETED !== "1") reasons.push("the parent metadata does not mark the cap experiment complete");
  if (!metaState.present) reasons.push("frequency-cap metadata is missing");
  if (!GENERATION_RE.test(meta.GENERATION ?? "")) reasons.push("cap GENERATION is missing or invalid");
  if (meta.GENERATION !== abMeta.GENERATION) reasons.push("cap generation does not match A/B/A generation");
  const cpu = canonicalSafeInteger(meta.CPU);
  const runs = canonicalSafeInteger(meta.RUNS_PER_LEG, true);
  const cap = canonicalSafeInteger(meta.CAP_KHZ, true);
  const saved = canonicalSafeInteger(meta.SAVED_SCALING_MAX_KHZ, true);
  if (cpu === null || cpu > 65535 || meta.CPU !== abMeta.CPU) reasons.push("cap CPU is missing, invalid, or does not match A/B/A");
  if (runs === null || meta.RUNS_PER_LEG !== abMeta.RUNS_PER_LEG) reasons.push("cap run count is missing, invalid, or does not match A/B/A");
  if (cap === null || cap < 100000 || meta.CAP_KHZ !== abMeta.REQUESTED_CAP_KHZ) {
    reasons.push("CAP_KHZ is missing, invalid, or does not match the requested cap");
  }
  if (saved === null) reasons.push("SAVED_SCALING_MAX_KHZ is missing or invalid");
  if (meta.RESTORED !== "1") reasons.push("frequency-cap setting is not verified as restored");
  if (meta.COMPLETED !== "1") reasons.push("frequency-cap metadata is not marked complete");
  requireDigest(meta, "ROWS_SHA256", rowsState, "frequency-cap rows", reasons);
  requireDigest(meta, "SAMPLES_SHA256", artifacts[0], "frequency-cap samples", reasons);
  requireDigest(meta, "METHOD_SHA256", artifacts[1], "frequency-cap method", reasons);
  if (artifacts[1].content !== null && !/^(scaling_cur_freq|turbostat)\n$/.test(artifacts[1].content.toString("utf8"))) {
    reasons.push("frequency-cap method is invalid");
  }
  validateRows(rowsState, ["cap"], runs, "frequency-cap rows", reasons);
  return reasons.length === 0 ? { status: "complete", reasons: [] } : { status: "incomplete", reasons: [...new Set(reasons)] };
}

export function inspectFrequencyEvidence(outDir, options = {}) {
  const root = path.resolve(outDir);
  const layoutErrors = [];
  const rootState = inspectDirectory(root, "bundle root", true);
  if (!rootState.safe) layoutErrors.push(rootState.reason);
  const resultsState = rootState.safe ? inspectDirectory(path.join(root, "results"), "results directory") : { safe: false };
  const freqState = rootState.safe ? inspectDirectory(path.join(root, "freq"), "frequency sample directory") : { safe: false };
  const stateState = rootState.safe ? inspectDirectory(path.join(root, "state"), "state directory") : { safe: false };
  if (resultsState.reason) layoutErrors.push(resultsState.reason);
  if (freqState.reason) layoutErrors.push(freqState.reason);
  if (stateState.reason) layoutErrors.push(stateState.reason);
  let marker = { present: false, errors: [] };
  if (stateState.safe && stateState.present) {
    marker = inspectRegularFile(path.join(root, "state", "phase-frequency.done"), META_MAX_BYTES, "frequency completion marker");
    layoutErrors.push(...marker.errors);
  }
  const phaseDone = options.ignorePhaseMarker === true
    ? marker.errors.length === 0
    : marker.present && marker.errors.length === 0;
  const expectedCpuState = normalizeExpectedCpuState(options);
  const blockedResults = !rootState.safe || !resultsState.safe;
  const blockedFreq = !rootState.safe || !freqState.safe;
  const abMetaState = blockedResults
    ? { ...unavailableFile("frequency A/B/A metadata parent is unsafe"), values: {} }
    : readStrictMeta(path.join(root, "results", "frequency-ab.meta"), AB_KEYS, "frequency A/B/A metadata");
  const abRowsState = blockedResults
    ? { ...unavailableFile("frequency A/B/A rows parent is unsafe"), rows: [] }
    : readExactRows(path.join(root, "results", "frequency-ab.tsv"), "frequency A/B/A rows");
  const abArtifacts = ["A1", "B", "A2"].flatMap((leg) => [
    blockedFreq ? unavailableFile(`${leg} frequency samples parent is unsafe`) :
      inspectRegularFile(path.join(root, "freq", `freq-ab-${leg}.samples`), SAMPLE_MAX_BYTES, `${leg} frequency samples`, false),
    blockedFreq ? unavailableFile(`${leg} frequency method parent is unsafe`) :
      inspectRegularFile(path.join(root, "freq", `freq-ab-${leg}.method`), META_MAX_BYTES, `${leg} frequency method`),
  ]);
  for (let i = 1; i < abArtifacts.length; i += 2) {
    if (abArtifacts[i].content !== null && !/^(scaling_cur_freq|turbostat)\n$/.test(abArtifacts[i].content.toString("utf8"))) {
      abArtifacts[i].errors.push(`${["A1", "B", "A2"][(i - 1) / 2]} frequency method is invalid`);
    }
  }
  const frequencyAbStatus = validateAb(abMetaState, abRowsState, abArtifacts, phaseDone, expectedCpuState, layoutErrors);

  const capMetaState = blockedResults
    ? { ...unavailableFile("frequency-cap metadata parent is unsafe"), values: {} }
    : readStrictMeta(path.join(root, "results", "frequency-cap.meta"), CAP_KEYS, "frequency-cap metadata");
  const capRowsState = blockedResults
    ? { ...unavailableFile("frequency-cap rows parent is unsafe"), rows: [] }
    : readExactRows(path.join(root, "results", "frequency-cap.tsv"), "frequency-cap rows");
  const capArtifacts = [
    blockedFreq ? unavailableFile("frequency-cap samples parent is unsafe") :
      inspectRegularFile(path.join(root, "freq", "freq-ab-cap.samples"), SAMPLE_MAX_BYTES, "frequency-cap samples", false),
    blockedFreq ? unavailableFile("frequency-cap method parent is unsafe") :
      inspectRegularFile(path.join(root, "freq", "freq-ab-cap.method"), META_MAX_BYTES, "frequency-cap method"),
  ];
  const frequencyCapStatus = validateCap(
    abMetaState.values,
    frequencyAbStatus,
    capMetaState,
    capRowsState,
    capArtifacts,
  );
  return {
    frequencyAbStatus,
    frequencyCapStatus,
    frequencyAbRows: abRowsState.rows,
    frequencyAbMeta: abMetaState.values,
    frequencyCapRows: capRowsState.rows,
    frequencyCapMeta: capMetaState.values,
  };
}

export function readBoundFrequencyArtifact(outDir, relativePath, expectedDigest, maxBytes) {
  if (!/^freq\/freq-ab-(A1|B|A2|cap)\.(samples|method)$/.test(relativePath) ||
      !SHA256_RE.test(expectedDigest ?? "")) return null;
  const root = path.resolve(outDir);
  const rootState = inspectDirectory(root, "bundle root", true);
  const freqState = rootState.safe ? inspectDirectory(path.join(root, "freq"), "frequency sample directory", true) : { safe: false };
  if (!rootState.safe || !freqState.safe) return null;
  const artifact = inspectRegularFile(path.join(root, relativePath), maxBytes, relativePath, true);
  if (artifact.errors.length > 0 || artifact.digest !== expectedDigest) return null;
  return artifact.content;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, outDir, expectedCpuText] = process.argv.slice(2);
  if ((mode !== "--ready" && mode !== "--complete") || !outDir || canonicalSafeInteger(expectedCpuText) === null) process.exit(2);
  const result = inspectFrequencyEvidence(outDir, {
    ignorePhaseMarker: mode === "--ready",
    expectedCpu: expectedCpuText,
  });
  const ready = result.frequencyAbStatus.status === "complete" &&
    (result.frequencyCapStatus.status === "complete" || result.frequencyCapStatus.status === "not-requested");
  if (!ready) {
    for (const reason of [...result.frequencyAbStatus.reasons, ...result.frequencyCapStatus.reasons]) {
      process.stderr.write(`frequency evidence: ${reason}\n`);
    }
    process.exit(1);
  }
}
