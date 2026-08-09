// collect.mjs - merge raw phase outputs beneath a diagnostics directory
// into a single machine-readable results.json.
//
// Usage: node collect.mjs <out-dir> [output-path]
//
// Reads (all optional; missing pieces are simply absent from the output):
//   results/meta.env           run configuration
//   results/baseline.meta      baseline parameters (KEY=VALUE)
//   results/groups.tsv         one group per line
//   results/individual.tsv     cpu, run, rc, elapsed
//   results/individual.meta    target CPUs, runs per CPU, skip/completion state
//   results/frequency-ab.tsv   leg, run, rc, elapsed
//   results/frequency-ab.meta  leg configuration + restore status
//   results/gdb.manifest     authoritative gdb evidence envelope
//   results/gdb.meta         gdb phase parameters (legacy, descriptive only)
//   env/summary.env          sanitized environment headline fields
//   logs/...                 repro output logs (epoch-prefixed)
//   gdb/*.txt                capture transcripts
//   freq/<tag>.samples       "epoch cpu khz" lines (or raw turbostat)

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseReproLog } from "./parse-repro-log.mjs";
import { parseGdbCapture } from "./parse-gdb.mjs";
import { assessBaselineEvidence } from "./baseline-evidence.mjs";
import { assessGroupsEvidence, deriveIndividualTargetPolicy } from "./groups-evidence.mjs";
import { inspectFrequencyEvidence, readBoundFrequencyArtifact } from "./frequency-evidence.mjs";
import {
  GDB_META_MAX_BYTES,
  GDB_RESULTS_ENTRY_LIMIT,
  GDB_TRANSCRIPT_MAX_BYTES,
  inspectGdbManifestConfig,
  validateGdbEvidence,
} from "./gdb-evidence.mjs";
import {
  assessIndividual as assessIndividualEnvelopeRows,
  inspectIndividualEvidence,
} from "./individual-evidence.mjs";
import { assessPreflightEvidence } from "./preflight-evidence.mjs";
import { assessRootChecksEvidence } from "./root-checks-evidence.mjs";

const RUN_CONFIG_KEYS = new Set([
  "MODE", "BASELINE_CHILDREN", "BASELINE_WAVES", "GROUP_WAVES",
  "INDIVIDUAL_RUNS", "GDB_MAX_RUNS", "SKIP_GDB", "CPU_TARGET",
]);

function storedCpuTargetConfig(values, duplicateConfig) {
  if (duplicateConfig.has("CPU_TARGET")) {
    return { status: "invalid", policy: null, cpu: null, reason: "stored CPU_TARGET is duplicated" };
  }
  const value = values.CPU_TARGET;
  if (value === undefined || value === "auto") {
    return { status: "complete", policy: "auto", cpu: null, legacyDefault: value === undefined, reason: null };
  }
  const cpu = canonicalUint(value);
  if (cpu === null || cpu > 65535) {
    return { status: "invalid", policy: null, cpu: null, reason: "stored CPU_TARGET is not auto or a canonical CPU in 0..65535" };
  }
  return { status: "complete", policy: "fixed", cpu, legacyDefault: false, reason: null };
}

function readStoredRunMetadata(outDir) {
  const values = {};
  const reasons = [];
  const root = path.resolve(outDir);
  let bundleRootSafe = true;
  let resultsDirSafe = true;
  const inspect = (file, type, label) => {
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      reasons.push(`${label} could not be inspected`);
      return "unsafe";
    }
    if (stat.isSymbolicLink() || (type === "directory" ? !stat.isDirectory() : !stat.isFile())) {
      reasons.push(`${label} must be a real non-symlink ${type}`);
      return "unsafe";
    }
    return "regular";
  };
  if (inspect(root, "directory", "bundle root") !== "regular") {
    bundleRootSafe = false;
    resultsDirSafe = false;
  }
  const resultsState = resultsDirSafe
    ? inspect(path.join(root, "results"), "directory", "results directory")
    : "unsafe";
  if (resultsState !== "regular") resultsDirSafe = false;
  const metaFile = path.join(root, "results", "meta.env");
  const metaState = resultsDirSafe ? inspect(metaFile, "file", "stored run metadata") : "unsafe";
  if (metaState === "missing") {
    return { values, status: "incomplete", reasons: ["stored run metadata is missing"], bundleRootSafe, resultsDirSafe };
  }
  if (metaState !== "regular") {
    return { values, status: "invalid", reasons: [...new Set(reasons)], bundleRootSafe, resultsDirSafe };
  }
  let text;
  try {
    text = readFileSync(metaFile, "utf8");
  } catch {
    return { values, status: "invalid", reasons: ["stored run metadata could not be read"], bundleRootSafe, resultsDirSafe };
  }
  const seenConfig = new Set();
  const duplicateConfig = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      reasons.push("stored run metadata contains a malformed line");
      continue;
    }
    const [, key, value] = match;
    if (RUN_CONFIG_KEYS.has(key)) {
      if (seenConfig.has(key)) {
        reasons.push(`stored run metadata contains duplicate ${key} rows`);
        duplicateConfig.add(key);
        continue;
      }
      seenConfig.add(key);
    }
    if (!Object.hasOwn(values, key)) values[key] = value;
  }
  const children = canonicalUint(values.BASELINE_CHILDREN);
  const waves = canonicalUint(values.BASELINE_WAVES);
  const groupWaves = duplicateConfig.has("GROUP_WAVES") ? null : canonicalUint(values.GROUP_WAVES);
  const cpuTargetConfig = storedCpuTargetConfig(values, duplicateConfig);
  if (children === null || children < 1) {
    reasons.push("stored BASELINE_CHILDREN is missing or not a canonical safe positive integer");
  }
  if (waves === null || waves < 1) {
    reasons.push("stored BASELINE_WAVES is missing or not a canonical safe positive integer");
  }
  if (groupWaves === null || groupWaves < 1) {
    reasons.push("stored GROUP_WAVES is missing or not a canonical safe positive integer");
  }
  if (cpuTargetConfig.status !== "complete") reasons.push(cpuTargetConfig.reason);
  return {
    values,
    baselineChildren: children !== null && children > 0 ? children : null,
    baselineWaves: waves !== null && waves > 0 ? waves : null,
    groupWaves: groupWaves !== null && groupWaves > 0 ? groupWaves : null,
    cpuTargetConfig,
    status: reasons.length > 0 ? "invalid" : "complete",
    reasons: [...new Set(reasons)],
    bundleRootSafe,
    resultsDirSafe,
  };
}

export function resolveExpectedCpu(runMetaState, individualStatus, worstCpu) {
  if (runMetaState.status !== "complete" || runMetaState.cpuTargetConfig?.status !== "complete") {
    return {
      status: "invalid",
      policy: null,
      cpu: null,
      reason: "stored run configuration cannot authorize a CPU target",
    };
  }
  const target = runMetaState.cpuTargetConfig;
  if (target.policy === "fixed") {
    return { status: "resolved", policy: "fixed", cpu: target.cpu, reason: null };
  }
  if (individualStatus.status === "skipped") {
    return { status: "none", policy: "auto", cpu: null, reason: "automatic CPU selection has no target because individual isolation was skipped" };
  }
  if (individualStatus.status !== "complete") {
    return { status: "unavailable", policy: "auto", cpu: null, reason: "automatic CPU selection requires complete provenance-valid individual evidence" };
  }
  const cpu = Number.isSafeInteger(worstCpu) && worstCpu >= 0 && worstCpu <= 65535 ? worstCpu : null;
  if (cpu === null) {
    return { status: "none", policy: "auto", cpu: null, reason: "automatic CPU selection found no failing individual CPU" };
  }
  return { status: "resolved", policy: "auto", cpu, reason: null };
}

function readTsv(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split("\t"));
}

// results/gdb.meta is legacy descriptive evidence: bounded reads only, and
// it can never authorize a conclusion without a validated manifest.
function readGdbMeta(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, values: {}, errors: [] };
    return { present: true, values: {}, errors: ["GDB metadata could not be inspected"] };
  }
  if (!stat.isFile()) {
    return {
      present: true,
      values: {},
      errors: ["GDB metadata must be a real non-symlink regular file"],
    };
  }
  if (stat.size > GDB_META_MAX_BYTES) {
    return { present: true, values: {}, errors: ["GDB metadata exceeds the evidence size limit"] };
  }
  const values = {};
  const errors = [];
  const allowed = new Set([
    "CPU", "MAX_RUNS", "EXIT_CODE", "ATTEMPTED_RUNS", "CLEAN_RUNS",
    "CAPTURED_RUNS", "ERROR_RUNS", "SKIPPED", "SKIP_REASON",
  ]);
  let text;
  try {
    const buffer = readFileSync(file);
    if (buffer.length > GDB_META_MAX_BYTES) {
      return { present: true, values: {}, errors: ["GDB metadata exceeds the evidence size limit"] };
    }
    text = buffer.toString("utf8");
  } catch {
    return { present: true, values: {}, errors: ["GDB metadata could not be read"] };
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) {
      errors.push("GDB metadata contains a malformed, duplicate, or unknown field");
      continue;
    }
    values[match[1]] = match[2];
  }
  return { present: true, values, errors };
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Parse per-CPU turbostat output (default rows, i.e. no --Summary): find the
// header ("Core CPU Avg_MHz Busy% Bzy_MHz ..."), then read Bzy_MHz -- the
// average clock while the CPU was busy -- from each per-CPU row. Headers
// repeat every interval and are re-detected; rows with a non-numeric CPU id
// (the "-" whole-system row) or a non-numeric Bzy_MHz ("-" for offline CPUs)
// are skipped. Only CPUs in cpuFilter (Set of numbers) count when the filter
// is provided. Returns null when no per-CPU header is present (e.g. an old
// `turbostat --Summary` capture).
function summarizeTurbostatPerCpu(text, cpuFilter) {
  const mhz = [];
  let sawHeader = false;
  let cpuCol = -1;
  let bzyCol = -1;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split(/\s+/);
    const cpuIdx = cells.indexOf("CPU");
    const bzyIdx = cells.indexOf("Bzy_MHz");
    if (cpuIdx !== -1 && bzyIdx !== -1) {
      sawHeader = true;
      cpuCol = cpuIdx;
      bzyCol = bzyIdx;
      continue;
    }
    if (!sawHeader) continue;
    if (cells.length <= Math.max(cpuCol, bzyCol)) continue;
    const cpu = Number(cells[cpuCol]);
    if (!Number.isInteger(cpu)) continue; // "-" whole-system summary row
    if (cpuFilter && !cpuFilter.has(cpu)) continue;
    const busy = Number(cells[bzyCol]);
    if (!Number.isFinite(busy)) continue; // "-" for offline CPUs
    mhz.push(busy);
  }
  if (!sawHeader) return null;
  const out = { note: "turbostat per-CPU Bzy_MHz (busy-only average clock)", samples: mhz.length };
  if (mhz.length > 0) {
    out.avgMHz = Math.round((mhz.reduce((a, b) => a + b, 0) / mhz.length) * 100) / 100;
    out.maxMHz = Math.max(...mhz);
  }
  return out;
}

// Summarize a frequency sample file: "epoch cpu khz" lines (sysfs sampler)
// or raw turbostat output (parsed per method). Only CPUs in cpuFilter (Set
// of numbers) count when the filter is provided; null spans all CPUs.
export function summarizeFreqSamples(outDir, tag, cpuFilter = null, binding = null) {
  const file = path.join(outDir, "freq", `${tag}.samples`);
  const methodFile = path.join(outDir, "freq", `${tag}.method`);
  let method;
  let text;
  if (binding) {
    const methodContent = readBoundFrequencyArtifact(
      outDir, `freq/${tag}.method`, binding.methodSha256, 64 * 1024,
    );
    const sampleContent = readBoundFrequencyArtifact(
      outDir, `freq/${tag}.samples`, binding.samplesSha256, 64 * 1024 * 1024,
    );
    if (methodContent === null || sampleContent === null) {
      return { tag, method: null, file: path.relative(outDir, file), available: false,
        note: "frequency samples changed after envelope validation and were excluded" };
    }
    method = methodContent.toString("utf8").trim();
    text = sampleContent.toString("utf8");
  } else {
    method = existsSync(methodFile) ? readFileSync(methodFile, "utf8").trim() : null;
    text = existsSync(file) ? readFileSync(file, "utf8") : null;
  }
  const summary = { tag, method, file: path.relative(outDir, file) };
  if (text === null) {
    summary.available = false;
    return summary;
  }
  summary.available = true;
  if (method === "scaling_cur_freq") {
    const perCpu = new Map();
    for (const line of text.split("\n")) {
      const m = line.match(/^(\d{9,}) (\d+) (\d+)$/);
      if (!m) continue;
      const cpu = Number(m[2]);
      if (cpuFilter && !cpuFilter.has(cpu)) continue;
      const khz = Number(m[3]);
      if (!perCpu.has(cpu)) perCpu.set(cpu, []);
      perCpu.get(cpu).push(khz);
    }
    let all = [];
    for (const v of perCpu.values()) all = all.concat(v);
    if (all.length > 0) {
      summary.samples = all.length;
      summary.avgMHz = Math.round(all.reduce((a, b) => a + b, 0) / all.length / 10) / 100;
      summary.maxMHz = Math.round(Math.max(...all) / 10) / 100;
      summary.minMHz = Math.round(Math.min(...all) / 10) / 100;
    } else {
      summary.samples = 0;
    }
  } else if (method === "turbostat") {
    const perCpu = summarizeTurbostatPerCpu(text, cpuFilter);
    if (perCpu) {
      Object.assign(summary, perCpu);
    } else {
      // Legacy capture from `turbostat --Summary`: no per-CPU header, so all
      // that is available is the first-column whole-system Avg_MHz, which
      // averages every CPU over the interval including idle time.
      if (cpuFilter) {
        summary.available = false;
        summary.samples = 0;
        summary.note =
          "legacy turbostat --Summary capture cannot represent the requested CPU selection; frequency values omitted";
        return summary;
      }
      const mhz = [];
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+(?:\.\d+)?)\s/);
        if (m) mhz.push(Number(m[1]));
      }
      summary.note =
        "legacy turbostat --Summary capture; Avg_MHz is a whole-system summary average including idle time";
      if (mhz.length > 0) {
        summary.avgMHz = Math.round((mhz.reduce((a, b) => a + b, 0) / mhz.length) * 100) / 100;
        summary.maxMHz = Math.max(...mhz);
        summary.samples = mhz.length;
      }
    }
  }
  if (summary.samples === 0) {
    summary.available = false;
    summary.note = summary.note
      ? `${summary.note}; no valid frequency samples were captured`
      : "no valid frequency samples were captured";
  }
  return summary;
}

function cpuSetFromList(list) {
  const set = new Set();
  if (!list) return set;
  for (const part of list.split(",")) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i += 1) set.add(i);
    } else if (/^\d+$/.test(part)) {
      set.add(Number(part));
    }
  }
  return set;
}

function canonicalUint(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const SIGNAL_NAMES = {
  4: "SIGILL",
  6: "SIGABRT",
  7: "SIGBUS",
  9: "SIGKILL",
  11: "SIGSEGV",
  15: "SIGTERM",
};

function signalFromRc(rc) {
  if (rc > 128) return SIGNAL_NAMES[rc - 128] ?? `SIG${rc - 128}`;
  return null;
}

// The primary endpoint of every run-based phase is SIGSEGV (rc 139): a run
// is either clean (rc 0) or a failure (rc 139). Any other exit — launcher
// failure of taskset/node itself (126/127), wrapper error, another signal —
// is not a valid workload observation: it is recorded in invalidRuns and
// excluded from `runs`, so `failures` == `sigsegv` and `otherFailures` stays
// 0 by construction (the field is kept for schema stability).
function addRunOutcome(rec, runS, rcS, elapsedS) {
  const rc = Number(rcS);
  const detail = {
    run: Number(runS),
    rc,
    signal: signalFromRc(rc) ?? `exit ${rc}`,
    elapsedSec: num(elapsedS),
  };
  if (rc !== 0 && rc !== 139) {
    rec.invalidRuns.push(detail);
    return;
  }
  rec.runs += 1;
  if (rc === 139) {
    rec.failures += 1;
    rec.sigsegv += 1;
    rec.failedRuns.push(detail);
  }
}

export function collectIndividual(rows) {
  const byCpu = new Map();
  for (const row of rows) {
    const [cpuS, runS, rcS, elapsedS] = row;
    const cpu = Number(cpuS);
    if (!byCpu.has(cpu)) {
      byCpu.set(cpu, { cpu, runs: 0, failures: 0, sigsegv: 0, otherFailures: 0, invalidRuns: [], failedRuns: [] });
    }
    addRunOutcome(byCpu.get(cpu), runS, rcS, elapsedS);
  }
  return [...byCpu.values()].sort((a, b) => a.cpu - b.cpu);
}

export function selectWorstIndividualCpu(records) {
  return records
    .filter((record) => record.sigsegv > 0 && record.runs > 0)
    .sort((left, right) => {
      const leftProduct = BigInt(left.sigsegv) * BigInt(right.runs);
      const rightProduct = BigInt(right.sigsegv) * BigInt(left.runs);
      if (leftProduct !== rightProduct) return leftProduct > rightProduct ? -1 : 1;
      return right.sigsegv - left.sigsegv || left.cpu - right.cpu;
    })[0]?.cpu ?? null;
}

export { assessIndividualEnvelopeRows as assessIndividual };

export function reconcileIndividualWithGroups(assessment, meta, groupsAssessment, mode, configuredRuns) {
  if (assessment.status === "not-run") return assessment;
  const reasons = [...assessment.reasons];
  let status = assessment.status;
  let acceptedRows = assessment.acceptedRows;
  let acceptedSummaries = assessment.acceptedSummaries;
  if (groupsAssessment.status !== "complete") {
    reasons.push("validated group evidence is unavailable for individual target provenance");
    if (status !== "invalid") status = "incomplete";
    acceptedRows = [];
    acceptedSummaries = [];
  } else {
    const expected = deriveIndividualTargetPolicy(groupsAssessment, mode);
    const commonMismatch = !expected ||
      meta.TARGET_CPUS !== expected.targetCpus ||
      meta.SKIPPED !== (expected.skipped ? "1" : "0") ||
      canonicalUint(configuredRuns) === null || meta.RUNS_PER_CPU !== configuredRuns;
    const provenanceMismatch = meta.VERSION === "4" || meta.VERSION === "3" || meta.VERSION === "2"
      ? meta.TARGET_POLICY !== expected?.targetPolicy ||
        meta.GROUP_PLAN_DIGEST !== expected?.groupPlanDigest
      : meta.VERSION !== "1";
    // Version 4 envelopes bind the exact validated groups generation: a
    // reproducible plan digest alone no longer authorizes redone evidence.
    const generationMismatch = meta.VERSION === "4" &&
      meta.GROUP_GENERATION !== expected?.groupGeneration;
    if (commonMismatch || provenanceMismatch) {
      reasons.push("individual target policy does not match the validated group evidence generation");
      status = "invalid";
      acceptedRows = [];
      acceptedSummaries = [];
    } else if (generationMismatch) {
      reasons.push("individual evidence is not bound to the validated groups generation");
      status = "invalid";
      acceptedRows = [];
      acceptedSummaries = [];
    } else if (meta.VERSION === "1" || meta.VERSION === "2" || meta.VERSION === "3") {
      reasons.push(
        meta.VERSION === "3"
          ? "version 3 individual evidence is descriptive only because it is not bound to the exact validated groups generation"
          : meta.VERSION === "2"
            ? "version 2 individual evidence is descriptive only because its rows are not bound to a current evidence generation"
            : "version 1 individual evidence is descriptive only because it lacks current target provenance and row-generation binding");
      if (status !== "invalid") status = "incomplete";
    }
  }
  return {
    ...assessment,
    status,
    reasons: [...new Set(reasons)],
    acceptedRows,
    acceptedSummaries,
  };
}

export function collectFreqAb(outDir, rows, meta) {
  const legs = new Map();
  for (const row of rows) {
    const [leg, runS, rcS, elapsedS] = row;
    if (!legs.has(leg)) legs.set(leg, { leg, runs: 0, failures: 0, sigsegv: 0, otherFailures: 0, invalidRuns: [], failedRuns: [] });
    addRunOutcome(legs.get(leg), runS, rcS, elapsedS);
  }
  const cpu = num(meta.CPU);
  const result = {
    cpu,
    runsPerLeg: num(meta.RUNS_PER_LEG),
    savedNoTurbo: num(meta.SAVED_NO_TURBO),
    restored: meta.RESTORED === "1",
    legs: [...legs.values()].map((leg) => ({
      ...leg,
      noTurbo: num(meta[`LEG_${leg.leg}_NO_TURBO`]),
      scalingMaxKhz: num(meta[`LEG_${leg.leg}_SCALING_MAX_KHZ`]),
      frequency: leg.leg
        ? summarizeFreqSamples(
          outDir,
          `freq-ab-${leg.leg}`,
          cpu !== null ? new Set([cpu]) : null,
          leg.leg === "cap"
            ? { samplesSha256: meta.SAMPLES_SHA256, methodSha256: meta.METHOD_SHA256 }
            : {
              samplesSha256: meta[`LEG_${leg.leg}_SAMPLES_SHA256`],
              methodSha256: meta[`LEG_${leg.leg}_METHOD_SHA256`],
            },
        )
        : null,
    })),
  };
  return result;
}

export function assessGdb(
  meta,
  phaseDone,
  captures,
  transcriptCount,
  metaState = { errors: [] },
  expectedCpuState = undefined,
) {
  const hasMeta = Object.keys(meta).length > 0;
  if (!hasMeta && !metaState.present && !phaseDone && transcriptCount === 0) {
    return { status: "not-run", reason: null };
  }
  if (metaState.errors?.length > 0) {
    return { status: "incomplete", reason: metaState.errors.join("; ") };
  }
  const hasSkipFlag = Object.hasOwn(meta, "SKIPPED");
  const hasSkipReason = Object.hasOwn(meta, "SKIP_REASON");
  if (hasSkipFlag || hasSkipReason) {
    if (meta.SKIPPED !== "1" || !meta.SKIP_REASON ||
        Object.keys(meta).some((key) => key !== "SKIPPED" && key !== "SKIP_REASON")) {
      return { status: "incomplete", reason: "GDB skip metadata is malformed or contains non-skip evidence" };
    }
    if (!phaseDone) return { status: "incomplete", reason: "skip metadata has no phase completion marker" };
    if (transcriptCount > 0) return { status: "incomplete", reason: "skip metadata conflicts with retained GDB transcripts" };
    return { status: "skipped", reason: meta.SKIP_REASON ?? null };
  }

  const cpu = canonicalUint(meta.CPU);
  if (cpu === null || cpu > 65535) {
    return { status: "incomplete", reason: "GDB CPU is missing or invalid" };
  }
  if (expectedCpuState !== undefined) {
    if (expectedCpuState.status !== "resolved") {
      return {
        status: "incomplete",
        reason: expectedCpuState.reason ?? "no validated CPU target authorizes this GDB evidence",
      };
    }
    if (cpu !== expectedCpuState.cpu) {
      return { status: "incomplete", reason: "GDB CPU does not match the expected target" };
    }
  }

  const countKeys = ["ATTEMPTED_RUNS", "CLEAN_RUNS", "CAPTURED_RUNS", "ERROR_RUNS"];
  const countFieldsPresent = countKeys.filter((key) => meta[key] !== undefined).length;
  let counts = {
    attemptedRuns: null,
    cleanRuns: null,
    capturedRuns: null,
    errorRuns: null,
    countsAvailable: false,
  };
  if (countFieldsPresent > 0) {
    const canonicalUint = (value) => {
      if (!/^(0|[1-9][0-9]*)$/.test(value ?? "")) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const maxRuns = canonicalUint(meta.MAX_RUNS);
    const attemptedRuns = canonicalUint(meta.ATTEMPTED_RUNS);
    const cleanRuns = canonicalUint(meta.CLEAN_RUNS);
    const capturedRuns = canonicalUint(meta.CAPTURED_RUNS);
    const errorRuns = canonicalUint(meta.ERROR_RUNS);
    if (
      countFieldsPresent !== countKeys.length ||
      maxRuns === null || maxRuns < 1 ||
      attemptedRuns === null || cleanRuns === null || capturedRuns === null || errorRuns === null ||
      attemptedRuns !== cleanRuns + capturedRuns + errorRuns ||
      attemptedRuns > maxRuns
    ) {
      return { status: "incomplete", reason: "GDB run counts are missing, malformed, or inconsistent" };
    }
    counts = { attemptedRuns, cleanRuns, capturedRuns, errorRuns, countsAvailable: true };
  }

  let exitCode = null;
  if (meta.EXIT_CODE !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(meta.EXIT_CODE)) {
      return { status: "incomplete", reason: "GDB exit code is malformed" };
    }
    exitCode = Number(meta.EXIT_CODE);
    if (!Number.isSafeInteger(exitCode)) {
      return { status: "incomplete", reason: "GDB exit code is malformed" };
    }
  }
  if (exitCode !== null && exitCode !== 0 && exitCode !== 3) {
    return { status: "failed", reason: `capture runner exited with code ${exitCode}`, ...counts };
  }
  if (!phaseDone) {
    return { status: "incomplete", reason: "phase completion marker is missing" };
  }
  if (counts.countsAvailable && transcriptCount !== counts.capturedRuns + counts.errorRuns) {
    return { status: "incomplete", reason: "GDB run counts conflict with retained transcripts" };
  }
  if (
    exitCode === 0 && counts.countsAvailable &&
    (counts.capturedRuns < 1 || counts.capturedRuns !== captures.length)
  ) {
    return { status: "incomplete", reason: "captured exit code conflicts with GDB run counts" };
  }
  if (
    exitCode === 3 && counts.countsAvailable &&
    (counts.attemptedRuns !== Number(meta.MAX_RUNS) || counts.capturedRuns !== 0 || counts.cleanRuns < 1)
  ) {
    return { status: "incomplete", reason: "no-fault exit code conflicts with GDB run counts" };
  }
  if (exitCode === 0 && captures.length > 0) return { status: "captured", reason: null, ...counts };
  if (exitCode === 0) {
    return { status: "incomplete", reason: "runner reported a capture but no fault transcript was parsed" };
  }
  if (exitCode === 3 && captures.length === 0) return { status: "no-fault", reason: null, ...counts };
  if (exitCode === 3) {
    return { status: "incomplete", reason: "no-fault exit code conflicts with captured faults" };
  }
  return { status: "incomplete", reason: "GDB metadata has no terminal exit code" };
}

function identicalGdbCaptures(captures) {
  if (captures.length < 2) return null;
  return captures.every(
    (c) =>
      c.instruction === captures[0].instruction &&
      c.siAddr === captures[0].siAddr &&
      c.intendedAddr === captures[0].intendedAddr &&
      JSON.stringify(c.diffBits) === JSON.stringify(captures[0].diffBits),
  );
}

// Inventory the legacy gdb/ directory in bounded form: the listing is capped
// at the entry limit, and only regular files are transcript candidates
// (symlinks and other types are skipped, never followed). Any anomaly is an
// error so the entry degrades to incomplete instead of crashing.
function listGdbTranscripts(outDir) {
  const gdbDir = path.join(outDir, "gdb");
  let stat;
  try {
    stat = lstatSync(gdbDir);
  } catch (error) {
    if (error?.code === "ENOENT") return { names: [], errors: [] };
    return { names: [], errors: ["GDB transcript directory could not be inspected"] };
  }
  if (!stat.isDirectory()) {
    return { names: [], errors: ["GDB transcript path is not a real directory"] };
  }
  let entries;
  try {
    entries = readdirSync(gdbDir);
  } catch {
    return { names: [], errors: ["GDB transcript directory could not be listed"] };
  }
  if (entries.length > GDB_RESULTS_ENTRY_LIMIT) {
    return { names: [], errors: ["GDB transcript directory exceeds the entry limit"] };
  }
  const names = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".txt")) continue;
    try {
      if (!lstatSync(path.join(gdbDir, name)).isFile()) continue;
    } catch {
      continue; // vanished mid-listing: the bounded read re-checks the path
    }
    names.push(name);
  }
  return { names, errors: [] };
}

// Bounded legacy transcript read: regular files within the evidence size
// limit only; anything else returns null so the entry degrades to incomplete.
function readLegacyTranscript(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > GDB_TRANSCRIPT_MAX_BYTES) return null;
    const buffer = readFileSync(file);
    if (buffer.length > GDB_TRANSCRIPT_MAX_BYTES) return null;
    return buffer;
  } catch {
    return null;
  }
}

// Re-read a validated capture transcript TOCTOU-safely: open without
// following links, stream bounded, and require the exact validated size and
// digest. Any mismatch means the artifact changed after validation.
function readBoundGdbTranscript(file, binding) {
  const expectedBytes = Number(binding.bytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > GDB_TRANSCRIPT_MAX_BYTES) return null;
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expectedBytes) return null;
    const hash = createHash("sha256");
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > GDB_TRANSCRIPT_MAX_BYTES) return null;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    if (total !== expectedBytes || hash.digest("hex") !== binding.sha256) return null;
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read result is already determined.
      }
    }
  }
}

function parseGdbCaptureFile(rel, buffer) {
  const parsed = parseGdbCapture(buffer.toString("utf8"));
  // Full mappings stay in the raw transcript; keep the JSON compact.
  parsed.mappings = undefined;
  parsed.file = rel;
  return parsed;
}

// Strict path: an authoritative manifest is present, so only a fully
// validated generation-bound envelope may authorize a conclusion. Every
// failure is a descriptive incomplete (fail closed).
function assessGdbStrict(outDir, runMetaState, expectedCpuState) {
  const incomplete = (reason, generation = null) => ({
    status: "incomplete",
    reason,
    cpu: null,
    maxRuns: null,
    exitCode: null,
    captures: [],
    capturesIdentical: null,
    generation,
  });
  const inspected = inspectGdbManifestConfig(outDir);
  if (!inspected.ok) {
    return incomplete(
      `GDB manifest configuration could not be inspected: ${inspected.reasons.join("; ")}`,
    );
  }
  // Every authoritative conclusion anchors to complete stored run metadata;
  // an invalid one cannot supply expectations even for a skip envelope.
  if (runMetaState.status !== "complete") {
    return incomplete(
      "stored run configuration cannot authorize GDB evidence expectations",
      inspected.generation,
    );
  }
  const expectedMaxRuns = canonicalUint(runMetaState.values.GDB_MAX_RUNS);
  if (expectedMaxRuns === null || expectedMaxRuns < 1) {
    return incomplete(
      "stored run configuration cannot authorize the expected GDB run limit",
      inspected.generation,
    );
  }
  let expectedCpu = "-";
  if (inspected.status === "RUN") {
    if (expectedCpuState.status !== "resolved") {
      return incomplete(
        expectedCpuState.reason ?? "no validated CPU target authorizes this GDB evidence",
        inspected.generation,
      );
    }
    expectedCpu = expectedCpuState.cpu;
  }
  const attempts = [];
  const validated = validateGdbEvidence(outDir, {
    markerMode: "complete",
    expectedCpu,
    expectedMaxRuns,
    expectedMaxCaptures: inspected.maxCaptures,
    collectAttempts: attempts,
  });
  if (!validated.ok) {
    return incomplete(
      `GDB evidence failed validation: ${validated.reasons.join("; ")}`,
      validated.generation ?? inspected.generation,
    );
  }
  if (validated.outcome === "skipped") {
    return {
      status: "skipped",
      reason: validated.meta.kind,
      cpu: null,
      maxRuns: null,
      exitCode: null,
      captures: [],
      capturesIdentical: null,
      generation: validated.generation,
    };
  }
  const captures = [];
  for (const binding of attempts) {
    if (binding.outcome !== "captured") continue; // error transcripts are never parsed
    const buffer = readBoundGdbTranscript(path.join(outDir, binding.relative), binding);
    if (buffer === null) {
      return incomplete(
        `GDB transcript ${binding.relative} changed after validation`,
        validated.generation,
      );
    }
    const parsed = parseGdbCaptureFile(binding.relative, buffer);
    if (!parsed.captured) {
      return incomplete(
        `captured GDB transcript ${binding.relative} contains no fault stop`,
        validated.generation,
      );
    }
    captures.push(parsed);
  }
  return {
    status: validated.outcome,
    reason: null,
    attemptedRuns: validated.meta.attempted,
    cleanRuns: validated.meta.clean,
    capturedRuns: validated.meta.captured,
    errorRuns: validated.meta.errors,
    countsAvailable: true,
    cpu: validated.meta.cpu,
    maxRuns: validated.meta.maxRuns,
    exitCode: validated.meta.exitCode,
    captures,
    capturesIdentical: identicalGdbCaptures(captures),
    generation: validated.generation,
  };
}

// Legacy path: without an authoritative manifest the gdb.meta + transcript
// inventory stays descriptive. Would-be captured/no-fault conclusions are
// downgraded to incomplete; structural problems keep their own reasons.
function assessGdbLegacy(outDir, resultsDir, expectedCpuState) {
  const gdbMetaState = readGdbMeta(path.join(resultsDir, "gdb.meta"));
  const gdbMeta = gdbMetaState.values;
  const listing = listGdbTranscripts(outDir);
  const phaseDone = existsSync(path.join(outDir, "state", "phase-gdb.done"));
  const captures = [];
  const transcriptErrors = [...listing.errors];
  for (const name of listing.names) {
    const rel = path.join("gdb", name);
    const buffer = readLegacyTranscript(path.join(outDir, rel));
    if (buffer === null) {
      transcriptErrors.push(`GDB transcript ${rel} could not be read within the evidence size limit`);
      continue;
    }
    const parsed = parseGdbCaptureFile(rel, buffer);
    if (!parsed.captured) continue; // clean-run transcripts carry no signature
    captures.push(parsed);
  }
  const assessed = assessGdb(
    gdbMeta,
    phaseDone,
    captures,
    listing.names.length,
    gdbMetaState,
    expectedCpuState,
  );
  if (assessed.status === "not-run" && transcriptErrors.length === 0) return null;
  let conclusion = assessed;
  if (transcriptErrors.length > 0) {
    conclusion = { ...conclusion, status: "incomplete", reason: transcriptErrors.join("; ") };
  } else if (conclusion.status === "captured" || conclusion.status === "no-fault") {
    conclusion = {
      ...conclusion,
      status: "incomplete",
      reason: "legacy GDB evidence has no validated manifest and is descriptive only; " +
        "it cannot authorize captured, no-fault, or signature conclusions",
    };
  }
  return {
    ...conclusion,
    cpu: num(gdbMeta.CPU),
    maxRuns: num(gdbMeta.MAX_RUNS),
    exitCode: num(gdbMeta.EXIT_CODE),
    captures,
    capturesIdentical: identicalGdbCaptures(captures),
    generation: null,
  };
}

// The GDB section fails closed: only the strict generation-bound manifest
// envelope can authorize captured/no-fault/skipped conclusions. Legacy
// evidence remains descriptive and never authorizes them.
function assessGdbPhase(outDir, runMetaState, expectedCpuState) {
  const resultsDir = path.join(outDir, "results");
  let manifestPresent = true;
  try {
    lstatSync(path.join(resultsDir, "gdb.manifest"));
  } catch (error) {
    // An uninspectable manifest path still counts as present (fail closed).
    manifestPresent = error?.code !== "ENOENT";
  }
  if (manifestPresent) return assessGdbStrict(outDir, runMetaState, expectedCpuState);
  return assessGdbLegacy(outDir, resultsDir, expectedCpuState);
}

function writeCollectedResults(outputFile, results, exclusiveOutput) {
  writeFileSync(
    outputFile,
    `${JSON.stringify(results, null, 2)}\n`,
    exclusiveOutput ? { flag: "wx", mode: 0o600 } : undefined,
  );
}

function bundleReadinessTokenExists(outDir) {
  try {
    lstatSync(path.join(path.resolve(outDir), "manifest.txt"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    // An uninspectable readiness path is still authority that this standalone
    // writer must not risk invalidating.
    return true;
  }
}

export function collect(outDir, options = {}) {
  const outputFile = options.outputFile ?? path.join(outDir, "results.json");
  const exclusiveOutput = options.exclusiveOutput === true;
  if (options.outputFile === undefined && bundleReadinessTokenExists(outDir)) {
    throw new Error(
      "refusing to overwrite results.json in a manifested bundle; " +
      "resume with diagnose.sh so readiness is revoked and republished, or use an explicit output path",
    );
  }
  const runMetaState = readStoredRunMetadata(outDir);
  const meta = runMetaState.values;
  const preflightAssessment = runMetaState.bundleRootSafe
    ? assessPreflightEvidence(outDir)
    : { status: "invalid", reasons: ["bundle root cannot authorize preflight evidence"], generation: null };
  const rootChecksAssessment = runMetaState.bundleRootSafe
    ? assessRootChecksEvidence(outDir)
    : { status: "invalid", reasons: ["bundle root cannot authorize root-checks evidence"], generation: null };

  const results = {
    schemaVersion: 1,
    outDir: ".",
    collectedAt: new Date().toISOString(),
    config: {
      mode: meta.MODE ?? null,
      startedAt: meta.START_ISO ?? null,
      startEpoch: num(meta.START_EPOCH),
      endEpoch: num(meta.END_EPOCH),
      baselineChildren: runMetaState.baselineChildren ?? null,
      baselineWaves: runMetaState.baselineWaves ?? null,
      groupWaves: runMetaState.groupWaves ?? null,
      individualRuns: num(meta.INDIVIDUAL_RUNS),
      gdbMaxRuns: num(meta.GDB_MAX_RUNS),
      cpuTarget: runMetaState.cpuTargetConfig?.status === "complete"
        ? runMetaState.cpuTargetConfig.cpu
        : null,
      cpuTargetPolicy: runMetaState.cpuTargetConfig?.status === "complete"
        ? runMetaState.cpuTargetConfig.policy
        : "invalid",
      frequencyAb: meta.FREQUENCY_AB === "1",
      skipGdb: meta.SKIP_GDB === "1",
      completedPhases: (meta.COMPLETED_PHASES ?? "").split(",").filter(Boolean),
      interrupted: meta.INTERRUPTED === "1",
    },
    configStatus: {
      status: runMetaState.status,
      reasons: runMetaState.reasons,
    },
    preflightStatus: {
      status: preflightAssessment.status,
      reasons: preflightAssessment.reasons,
      generation: preflightAssessment.generation,
    },
    rootChecksStatus: {
      status: rootChecksAssessment.status,
      reasons: rootChecksAssessment.reasons,
      generation: rootChecksAssessment.generation,
      collectedAt: rootChecksAssessment.collectedAt ?? null,
    },
  };
  if (preflightAssessment.status === "complete") {
    results.environment = preflightAssessment.environment;
  }

  // Optional privileged reads remain out-of-band and are exposed only after
  // their exact fixed envelope and completion marker validate.
  if (rootChecksAssessment.status === "complete") {
    results.rootChecks = rootChecksAssessment.rootChecks;
  }

  // --- baseline ---
  const baselineAssessment = assessBaselineEvidence(outDir, {
    expectedChildren: runMetaState.baselineChildren,
    expectedWaves: runMetaState.baselineWaves,
    validateStoredConfig: true,
  });
  results.baselineStatus = {
    status: baselineAssessment.status,
    reasons: baselineAssessment.reasons,
  };
  if (baselineAssessment.parsed) {
    results.baseline = {
      ...baselineAssessment.parsed,
      waves: undefined, // per-wave detail stays in the raw log
      log: baselineAssessment.log,
      exitCode:
        baselineAssessment.meta.EXIT_CODE === "0" || baselineAssessment.meta.EXIT_CODE === "1"
          ? Number(baselineAssessment.meta.EXIT_CODE)
          : null,
      envelopeStatus: baselineAssessment.status,
      frequency:
        baselineAssessment.status === "complete"
          ? summarizeFreqSamples(outDir, "baseline")
          : { available: false, note: "baseline evidence envelope is not complete" },
    };
  }
  if (!runMetaState.resultsDirSafe) {
    if (runMetaState.bundleRootSafe) {
      writeCollectedResults(outputFile, results, exclusiveOutput);
    }
    return results;
  }

  // --- groups ---
  const groupsAssessment = assessGroupsEvidence(outDir, {
    expectedGroupWaves: runMetaState.status === "complete" ? runMetaState.groupWaves : null,
    requireMarker: true,
  });
  results.groupsStatus = {
    status: groupsAssessment.status,
    reasons: groupsAssessment.reasons,
  };
  if (groupsAssessment.status === "complete") {
    results.groups = groupsAssessment.entries.map(({ parsed, freqTag, ...entry }) => ({
      ...entry,
      processedWaves: parsed.processedWaves,
      completedWaves: parsed.completedWaves,
      fullyPassedWaves: parsed.fullyPassedWaves,
      failedWaves: parsed.failedWaves,
      totalChildInvocations: parsed.totalChildInvocations,
      sigsegvCount: parsed.sigsegvCount,
      otherFailureCount: parsed.otherFailureCount,
      unclassifiedFailureCount: parsed.unclassifiedFailureCount,
      sigsegvWaveCount: parsed.sigsegvWaveCount,
      sigsegvResolvedWaveCount: parsed.sigsegvResolvedWaveCount,
      sigsegvUnresolvedWaveCount: parsed.sigsegvUnresolvedWaveCount,
      otherFailureWaveCount: parsed.otherFailureWaveCount,
      unclassifiedFailureWaveCount: parsed.unclassifiedFailureWaveCount,
      firstFailureAfterSec: parsed.firstFailureAfterSec,
      durationSec: parsed.durationSec,
      failures: parsed.failures,
      footer: parsed.footer,
      completionStatus: parsed.completionStatus,
      issues: parsed.issues,
      notes: parsed.notes,
      partial: parsed.partial,
      envelopeStatus: groupsAssessment.status,
      frequency: summarizeFreqSamples(outDir, freqTag, cpuSetFromList(entry.cpus)),
    }));
  }

  // --- individual ---
  const individualEvidence = inspectIndividualEvidence(outDir);
  const individualRows = individualEvidence.rows;
  const individualMetaState = individualEvidence.metaState;
  const individualAssessment = reconcileIndividualWithGroups(assessIndividualEnvelopeRows(
    individualRows,
    individualMetaState.values,
    individualEvidence.phaseDone,
    individualMetaState,
  ), individualMetaState.values, groupsAssessment, meta.MODE, meta.INDIVIDUAL_RUNS);
  const { acceptedRows, acceptedSummaries, ...individualStatus } = individualAssessment;
  results.individualStatus = individualStatus;
  if (acceptedSummaries?.length > 0) results.individual = acceptedSummaries;
  else if (acceptedRows.length > 0) results.individual = collectIndividual(acceptedRows);
  if (individualStatus.status === "complete") {
    results.worstCpu = selectWorstIndividualCpu(results.individual ?? []);
  } else results.worstCpu = null;
  const expectedCpuState = resolveExpectedCpu(runMetaState, individualStatus, results.worstCpu);
  results.cpuSelectionStatus = expectedCpuState;

  // --- frequency A/B/A ---
  const frequencyEvidence = inspectFrequencyEvidence(outDir, { expectedCpuState });
  const freqAbRows = frequencyEvidence.frequencyAbRows;
  const freqAbMeta = frequencyEvidence.frequencyAbMeta;
  results.frequencyAbStatus = frequencyEvidence.frequencyAbStatus;
  if (results.frequencyAbStatus.status === "complete") {
    results.frequencyAb = collectFreqAb(outDir, freqAbRows, freqAbMeta);
  }

  // --- optional per-CPU frequency cap experiment ---
  const capRows = frequencyEvidence.frequencyCapRows;
  const capMeta = frequencyEvidence.frequencyCapMeta;
  results.frequencyCapStatus = frequencyEvidence.frequencyCapStatus;
  if (results.frequencyCapStatus.status === "complete") {
    results.frequencyCap = {
      cpu: num(capMeta.CPU),
      requestedCapKhz: num(capMeta.CAP_KHZ),
      savedScalingMaxKhz: num(capMeta.SAVED_SCALING_MAX_KHZ),
      restored: capMeta.RESTORED === "1",
      note: "intel_pstate/HWP does not guarantee scaling_max_freq strictly clamps the effective clock; compare with measured samples",
      ...collectFreqAb(outDir, capRows, capMeta),
    };
  }

  // --- gdb ---
  const gdbAssessment = assessGdbPhase(outDir, runMetaState, expectedCpuState);
  if (gdbAssessment !== null) results.gdb = gdbAssessment;

  writeCollectedResults(outputFile, results, exclusiveOutput);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  const explicitOutput = process.argv[3];
  const hasExplicitOutput = process.argv.length === 4;
  if (!outDir || (process.argv.length !== 3 && !hasExplicitOutput) ||
    (hasExplicitOutput && !explicitOutput)) {
    console.error("usage: node collect.mjs <out-dir> [output-path]");
    process.exit(2);
  }
  collect(outDir, hasExplicitOutput
    ? { outputFile: explicitOutput, exclusiveOutput: true }
    : undefined);
  console.log(`wrote ${hasExplicitOutput ? "explicit results output" : "results.json"}`);
}
