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
//   results/pinned-concurrent.* exact-CPU concurrent plan and outcomes
//   results/telemetry-*.{tsv,meta} digest-bound read-only telemetry segments
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
import {
  PINNED_CONCURRENT_SCHEDULE_ALGORITHM,
  assessPinnedConcurrentEvidence,
  parsePinnedConcurrentCpuList,
} from "./pinned-concurrent-evidence.mjs";
import { assessPreflightEvidence } from "./preflight-evidence.mjs";
import { assessRootChecksEvidence } from "./root-checks-evidence.mjs";
import { TELEMETRY_PHASES, assessTelemetryEvidence } from "./telemetry-evidence.mjs";
import { associateTelemetryRuns } from "./telemetry-association.mjs";
import { computeTelemetryWorkloadBinding } from "./telemetry-workload-binding.mjs";
import {
  buildBalancedGroupOrders,
  buildConcurrentLaunchOrders,
} from "./pinned-runner.mjs";

const RUN_CONFIG_KEYS = new Set([
  "MODE", "RUN_SCHEMA_VERSION", "BASELINE_CHILDREN", "BASELINE_WAVES", "GROUP_WAVES",
  "INDIVIDUAL_RUNS", "PINNED_CONCURRENT_ROUNDS", "PROTOCOL_SEED",
  "SKIP_PINNED_CONCURRENT", "TELEMETRY_INTERVAL_MS", "GDB_MAX_RUNS", "SKIP_GDB", "CPU_TARGET",
]);

const SCHEMA_2_CONFIG_KEYS = [
  "RUN_SCHEMA_VERSION",
  "PINNED_CONCURRENT_ROUNDS",
  "PROTOCOL_SEED",
  "SKIP_PINNED_CONCURRENT",
  "TELEMETRY_INTERVAL_MS",
];

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
  const runSchemaVersion = Object.hasOwn(values, "RUN_SCHEMA_VERSION")
    ? canonicalUint(values.RUN_SCHEMA_VERSION)
    : 1;
  let pinnedConcurrentRounds = null;
  let protocolSeed = null;
  let skipPinnedConcurrent = null;
  let telemetryIntervalMs = null;
  if (runSchemaVersion !== 1 && runSchemaVersion !== 2) {
    reasons.push("stored RUN_SCHEMA_VERSION is not 1 or 2");
  } else if (runSchemaVersion === 2) {
    for (const key of SCHEMA_2_CONFIG_KEYS) {
      if (!Object.hasOwn(values, key)) reasons.push(`schema 2 stored run metadata is missing ${key}`);
    }
    pinnedConcurrentRounds = canonicalUint(values.PINNED_CONCURRENT_ROUNDS);
    protocolSeed = canonicalUint(values.PROTOCOL_SEED);
    skipPinnedConcurrent = values.SKIP_PINNED_CONCURRENT === "0"
      ? false
      : values.SKIP_PINNED_CONCURRENT === "1"
        ? true
        : null;
    telemetryIntervalMs = canonicalUint(values.TELEMETRY_INTERVAL_MS);
    if (pinnedConcurrentRounds === null || pinnedConcurrentRounds < 1) {
      reasons.push("stored PINNED_CONCURRENT_ROUNDS is missing or not a canonical safe positive integer");
    }
    if (protocolSeed === null || protocolSeed > 0xffff_ffff) {
      reasons.push("stored PROTOCOL_SEED is missing or not a canonical uint32");
    }
    if (skipPinnedConcurrent === null) {
      reasons.push("stored SKIP_PINNED_CONCURRENT is missing or not 0 or 1");
    }
    if (telemetryIntervalMs === null || telemetryIntervalMs < 50 || telemetryIntervalMs > 60_000) {
      reasons.push("stored TELEMETRY_INTERVAL_MS is missing or outside 50..60000");
    }
  } else {
    for (const key of SCHEMA_2_CONFIG_KEYS.slice(1)) {
      if (Object.hasOwn(values, key)) reasons.push(`legacy stored run metadata unexpectedly contains ${key}`);
    }
  }
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
    runSchemaVersion: runSchemaVersion === 1 || runSchemaVersion === 2 ? runSchemaVersion : null,
    pinnedConcurrentRounds:
      pinnedConcurrentRounds !== null && pinnedConcurrentRounds > 0 ? pinnedConcurrentRounds : null,
    protocolSeed: protocolSeed !== null && protocolSeed <= 0xffff_ffff ? protocolSeed : null,
    skipPinnedConcurrent,
    telemetryIntervalMs:
      telemetryIntervalMs !== null && telemetryIntervalMs >= 50 && telemetryIntervalMs <= 60_000
        ? telemetryIntervalMs
        : null,
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

// Frequency evidence retains every tracked child outcome. Only a clean exit
// or SIGSEGV resolves the primary endpoint; other statuses remain explicit
// descriptive observations and are never counted as clean runs.
function addFrequencyRunOutcome(rec, runS, rcS, elapsedS) {
  const rc = Number(rcS);
  const detail = {
    run: Number(runS),
    rc,
    signal: signalFromRc(rc) ?? `exit ${rc}`,
    elapsedSec: num(elapsedS),
  };
  rec.observations += 1;
  if (rc !== 0 && rc !== 139) {
    rec.otherFailures += 1;
    rec.otherWorkloadFailureDetails.push(detail);
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

export function reconcileIndividualWithGroups(
  assessment,
  meta,
  groupsAssessment,
  mode,
  configuredRuns,
  configuredProtocolSeed = null,
) {
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
      canonicalUint(configuredRuns) === null || meta.RUNS_PER_CPU !== configuredRuns ||
      ((meta.VERSION === "5" || meta.VERSION === "6") &&
        (canonicalUint(String(configuredProtocolSeed ?? "")) === null ||
          meta.SCHEDULE_SEED !== String(configuredProtocolSeed)));
    const provenanceMismatch = meta.VERSION === "5" || meta.VERSION === "6" || meta.VERSION === "4" ||
      meta.VERSION === "3" || meta.VERSION === "2"
      ? meta.TARGET_POLICY !== expected?.targetPolicy ||
        meta.GROUP_PLAN_DIGEST !== expected?.groupPlanDigest
      : meta.VERSION !== "1";
    // Versions 4 through 6 bind the exact validated groups generation: a
    // reproducible plan digest alone no longer authorizes redone evidence.
    const generationMismatch = (meta.VERSION === "4" || meta.VERSION === "5" || meta.VERSION === "6") &&
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
    if (!legs.has(leg)) {
      legs.set(leg, {
        leg,
        observations: 0,
        runs: 0,
        failures: 0,
        sigsegv: 0,
        otherFailures: 0,
        invalidRuns: [],
        failedRuns: [],
        otherWorkloadFailureDetails: [],
      });
    }
    addFrequencyRunOutcome(legs.get(leg), runS, rcS, elapsedS);
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

const PINNED_CONCURRENT_UNAVAILABLE_META_MAX_BYTES = 512;
const PINNED_CONCURRENT_UNAVAILABLE_REASON = "no-safe-topology-context";

function readOwnedSingleLinkArtifact(file, maxBytes, label) {
  let pathStat;
  try {
    pathStat = lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, buffer: null, reasons: [] };
    return { present: true, buffer: null, reasons: [`${label} could not be inspected`] };
  }
  const reasons = [];
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  let parentStat;
  try {
    parentStat = lstatSync(path.dirname(file));
  } catch {
    parentStat = null;
  }
  if (parentStat === null || !parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      (expectedUid !== null && parentStat.uid !== expectedUid)) {
    reasons.push(`${label} parent must be an owned real directory`);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 ||
      (expectedUid !== null && pathStat.uid !== expectedUid)) {
    reasons.push(`${label} must be an owned single-link regular file`);
  }
  if (!Number.isSafeInteger(pathStat.size) || pathStat.size < 0 || pathStat.size > maxBytes) {
    reasons.push(`${label} exceeds its evidence size limit`);
  }
  if (reasons.length > 0) return { present: true, buffer: null, reasons };

  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== pathStat.size ||
        before.dev !== pathStat.dev || before.ino !== pathStat.ino ||
        (expectedUid !== null && before.uid !== expectedUid)) {
      return { present: true, buffer: null, reasons: [`${label} changed before it could be read safely`] };
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) {
        return { present: true, buffer: null, reasons: [`${label} ended before its validated size`] };
      }
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      return { present: true, buffer: null, reasons: [`${label} grew while it was being read`] };
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      return { present: true, buffer: null, reasons: [`${label} changed while it was being read`] };
    }
    return { present: true, buffer, reasons: [] };
  } catch {
    return { present: true, buffer: null, reasons: [`${label} could not be read safely`] };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read result is already fail-closed.
      }
    }
  }
}

function inspectPinnedConcurrentUnavailableEnvelope(outDir) {
  const root = path.resolve(outDir);
  const metaRead = readOwnedSingleLinkArtifact(
    path.join(root, "results", "pinned-concurrent.unavailable.meta"),
    PINNED_CONCURRENT_UNAVAILABLE_META_MAX_BYTES,
    "pinned-concurrent unavailable metadata",
  );
  const markerRead = readOwnedSingleLinkArtifact(
    path.join(root, "state", "phase-pinned-concurrent-unavailable.done"),
    0,
    "pinned-concurrent unavailable completion marker",
  );
  const present = metaRead.present || markerRead.present;
  if (!present) return { present: false, status: "not-run", reasons: [], meta: null };

  const reasons = [...metaRead.reasons, ...markerRead.reasons];
  if (!metaRead.present) reasons.push("pinned-concurrent unavailable metadata is missing");
  if (!markerRead.present) reasons.push("pinned-concurrent unavailable completion marker is missing");
  if (markerRead.buffer !== null && markerRead.buffer.length !== 0) {
    reasons.push("pinned-concurrent unavailable completion marker must be empty");
  }

  let meta = null;
  if (metaRead.buffer !== null) {
    const match = metaRead.buffer.toString("utf8").match(
      /^VERSION=1\nSOURCE_GROUP_GENERATION=([a-f0-9]{32})\nSOURCE_GROUP_PLAN_DIGEST=([a-f0-9]{64})\nREASON=no-safe-topology-context\n$/,
    );
    if (match === null) {
      reasons.push("pinned-concurrent unavailable metadata is not the exact canonical envelope");
    } else {
      meta = {
        VERSION: "1",
        SOURCE_GROUP_GENERATION: match[1],
        SOURCE_GROUP_PLAN_DIGEST: match[2],
        REASON: PINNED_CONCURRENT_UNAVAILABLE_REASON,
      };
    }
  }
  return {
    present: true,
    status: reasons.length === 0 ? "complete" : "invalid",
    reasons: [...new Set(reasons)],
    meta,
  };
}

function pinnedConcurrentWorkloadArtifactsPresent(outDir) {
  const root = path.resolve(outDir);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const relative of [
    "results/pinned-concurrent.meta",
    "results/pinned-concurrent.groups.tsv",
    "results/pinned-concurrent.plan.tsv",
    "results/pinned-concurrent.tsv",
    "results/pinned-concurrent.boundaries.ndjson",
    "state/phase-pinned-concurrent.done",
    "logs/pinned-concurrent",
    "state/pinned-concurrent-waves",
    "state/pinned-concurrent-finalize",
    "results/telemetry-pinned-concurrent.tsv",
    "results/telemetry-pinned-concurrent.meta",
    "telemetry/pinned-concurrent",
    "state/telemetry-pinned-concurrent",
  ]) {
    const artifact = path.join(root, relative);
    try {
      const artifactStat = lstatSync(artifact);
      if (artifactStat.isDirectory() && !artifactStat.isSymbolicLink()) {
        const parentStat = lstatSync(path.dirname(artifact));
        const ownedRealParents = parentStat.isDirectory() && !parentStat.isSymbolicLink() &&
          (expectedUid === null || (parentStat.uid === expectedUid && artifactStat.uid === expectedUid));
        if (ownedRealParents && readdirSync(artifact).length === 0) continue;
      }
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return true;
    }
  }
  return false;
}

function pinnedConcurrentSummary(assessment, authoritative) {
  const outcomes = assessment.descriptiveOutcomes;
  if (outcomes === null || outcomes === undefined) return null;
  const v2 = assessment.meta?.VERSION === "2";
  return {
    ...(v2 ? {
      metadataVersion: "2",
      protocol: assessment.meta.PROTOCOL,
      legacyWaveCount: assessment.legacyWaveCount ?? 0,
      legacyRowCount: assessment.legacyRowCount ?? 0,
    } : {}),
    generation: assessment.meta?.GENERATION ?? null,
    sourceGroupGeneration: assessment.meta?.SOURCE_GROUP_GENERATION ?? null,
    sourceGroupPlanDigest: assessment.meta?.SOURCE_GROUP_PLAN_DIGEST ?? null,
    roundsPerContext: num(assessment.meta?.ROUNDS_PER_CONTEXT),
    scheduleSeed: num(assessment.meta?.SCHEDULE_SEED),
    scheduleAlgorithm: assessment.meta?.SCHEDULE_ALGORITHM ?? null,
    groups: assessment.groups.map((group) => ({
      group: group.group,
      kind: group.kind,
      cpus: group.cpus,
      cluster: group.cluster,
      controllerCpu: group.controller_cpu,
      rounds: group.rounds,
    })),
    ...(v2 ? {
      observedWaves: outcomes.observedWaves,
      otherFailureWaves: outcomes.otherFailureWaves,
      observations: outcomes.observations,
      otherWorkloadFailures: outcomes.otherWorkloadFailures,
    } : {}),
    waves: outcomes.waves,
    totalWaves: assessment.totalWaveCount,
    failedWaves: outcomes.failedWaves,
    childRuns: outcomes.childRuns,
    sigsegv: outcomes.sigsegv,
    perGroup: outcomes.perGroup,
    perCpu: outcomes.perCpu.map((record) => ({
      context: record.group,
      group: record.group,
      cpu: record.cpu,
      ...(v2 ? {
        observations: record.observations,
        passes: record.passes,
        otherWorkloadFailures: record.otherWorkloadFailures,
      } : {}),
      runs: record.runs,
      failures: record.sigsegv,
      sigsegv: record.sigsegv,
    })),
    authoritative,
  };
}

function sameCpuSet(left, right) {
  return left.length === right.length && left.every((cpu, index) => cpu === right[index]);
}

export function validatePinnedConcurrentContexts(groups, sourceEntries) {
  if (!Array.isArray(groups) || !Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    return ["pinned-concurrent contexts cannot be reconciled without source group rows"];
  }
  const reasons = [];
  const byName = new Map(groups.map((group) => [group.group, group]));
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const used = new Set();
  const usable = new Set();
  for (const source of sourceEntries) {
    for (const cpu of parsePinnedConcurrentCpuList(source.cpus) ?? []) usable.add(cpu);
  }
  const checkController = (context) => {
    if (!usable.has(context.controller_cpu)) {
      reasons.push(`pinned-concurrent context ${context.group} has a controller outside the source usable CPU set`);
    }
  };
  for (const source of sourceEntries) {
    const sourceCpus = parsePinnedConcurrentCpuList(source.cpus);
    const sourceCluster = source.clusterId ?? "-";
    const exact = byName.get(source.name);
    const left = byName.get(`${source.name}-a`);
    const right = byName.get(`${source.name}-b`);
    if (exact !== undefined) {
      used.add(exact.group);
      checkController(exact);
      if (left !== undefined || right !== undefined) {
        reasons.push(`pinned-concurrent source group ${source.name} has both exact and partitioned contexts`);
      }
      if (exact.kind !== source.kind || exact.cpus !== source.cpus || exact.cluster !== sourceCluster) {
        reasons.push(`pinned-concurrent context ${source.name} disagrees with its source group identity`);
      }
      continue;
    }
    if (left === undefined || right === undefined) {
      reasons.push(`pinned-concurrent source group ${source.name} has no exact context or complete a/b partition`);
      continue;
    }
    used.add(left.group);
    used.add(right.group);
    checkController(left);
    checkController(right);
    const leftCpus = parsePinnedConcurrentCpuList(left.cpus) ?? [];
    const rightCpus = parsePinnedConcurrentCpuList(right.cpus) ?? [];
    const union = [...new Set([...leftCpus, ...rightCpus])].sort((a, b) => a - b);
    const overlap = leftCpus.some((cpu) => rightCpus.includes(cpu));
    const expectedKind = `${source.kind}-partition`;
    if (left.kind !== expectedKind || right.kind !== expectedKind ||
        left.cluster !== "-" || right.cluster !== "-" || overlap ||
        sourceCpus === null || !sameCpuSet(union, sourceCpus)) {
      reasons.push(`pinned-concurrent a/b contexts for ${source.name} are not an exact source-group partition`);
    }
  }
  for (const group of groups) {
    if (!used.has(group.group) && !sourceNames.has(group.group)) {
      reasons.push(`pinned-concurrent context ${group.group} has no source group`);
    }
  }
  return [...new Set(reasons)];
}

function pinnedConcurrentContextSeed(seed, context, cpus) {
  const identity = [
    "pinned-concurrent-launch-v1",
    String(seed),
    context.group,
    context.kind,
    cpus.join(","),
    context.cluster,
    String(context.controller_cpu),
  ].join("\0");
  return createHash("sha256").update(identity).digest().readUInt32BE(0);
}

export function buildExpectedPinnedConcurrentPlanRows(groups, rounds, seed) {
  const contexts = groups.map((group) => {
    const cpus = parsePinnedConcurrentCpuList(group.cpus);
    if (cpus === null) throw new TypeError(`pinned-concurrent context ${group.group} has invalid CPUs`);
    return { ...group, cpus };
  });
  const groupOrders = buildBalancedGroupOrders(contexts.length, rounds, seed);
  const launchOrders = new Map(contexts.map((context) => [
    context.group,
    buildConcurrentLaunchOrders(
      context.cpus,
      rounds,
      pinnedConcurrentContextSeed(seed, context, context.cpus),
    ),
  ]));
  const rows = [];
  let ordinal = 0;
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    for (let groupIndex = 0; groupIndex < groupOrders[roundIndex].length; groupIndex += 1) {
      const context = contexts[groupOrders[roundIndex][groupIndex]];
      const launches = launchOrders.get(context.group)[roundIndex];
      for (let launchIndex = 0; launchIndex < launches.length; launchIndex += 1) {
        rows.push({
          ordinal: ++ordinal,
          round: roundIndex + 1,
          group_position: groupIndex + 1,
          group: context.group,
          controller_cpu: context.controller_cpu,
          launch_position: launchIndex + 1,
          cpu: launches[launchIndex],
        });
      }
    }
  }
  return rows;
}

function collectPinnedConcurrent(outDir, runMetaState, groupsAssessment) {
  const schema2 = runMetaState.runSchemaVersion === 2;
  const trustedConfig = schema2 && runMetaState.status === "complete";
  const expectations = trustedConfig
    ? {
        roundsPerContext: runMetaState.pinnedConcurrentRounds,
        scheduleSeed: runMetaState.protocolSeed,
        scheduleAlgorithm: PINNED_CONCURRENT_SCHEDULE_ALGORITHM,
        ...(groupsAssessment.status === "complete"
          ? {
              sourceGroupGeneration: groupsAssessment.meta.GENERATION,
              sourceGroupPlanDigest: groupsAssessment.meta.PLAN_DIGEST,
            }
          : {}),
      }
    : {};
  const unavailable = inspectPinnedConcurrentUnavailableEnvelope(outDir);
  if (unavailable.present) {
    const reasons = [...unavailable.reasons];
    if (pinnedConcurrentWorkloadArtifactsPresent(outDir)) {
      reasons.push("pinned-concurrent unavailable evidence contradicts workload or telemetry artifacts");
    }
    if (!trustedConfig) {
      reasons.push("pinned-concurrent unavailable evidence requires a complete schema-2 run configuration");
    } else if (runMetaState.skipPinnedConcurrent) {
      reasons.push("pinned-concurrent unavailable evidence contradicts the configured explicit skip");
    }
    if (groupsAssessment.status !== "complete") {
      reasons.push("pinned-concurrent unavailable evidence requires complete validated source groups");
    } else if (unavailable.meta !== null &&
        (unavailable.meta.SOURCE_GROUP_GENERATION !== groupsAssessment.meta.GENERATION ||
         unavailable.meta.SOURCE_GROUP_PLAN_DIGEST !== groupsAssessment.meta.PLAN_DIGEST)) {
      reasons.push("pinned-concurrent unavailable evidence does not match the validated source group generation and plan digest");
    }
    if (unavailable.status === "complete" && reasons.length === 0) {
      return {
        status: {
          status: "unavailable",
          reasons: [
            "no safe controller CPU outside an active topology context was available; the pinned-concurrent workload was not launched",
          ],
          authoritative: false,
          unavailableReason: PINNED_CONCURRENT_UNAVAILABLE_REASON,
          completedWaveCount: 0,
          totalWaveCount: 0,
          discardedTailRowCount: 0,
        },
        summary: null,
        assessment: null,
      };
    }
    return {
      status: {
        status: "invalid",
        reasons: [...new Set(reasons.length > 0
          ? reasons
          : ["pinned-concurrent unavailable evidence is invalid"])],
        authoritative: false,
        completedWaveCount: 0,
        totalWaveCount: 0,
        discardedTailRowCount: 0,
      },
      summary: null,
      assessment: null,
    };
  }
  let assessment = assessPinnedConcurrentEvidence(outDir, expectations);
  let scheduleReason = null;
  if (trustedConfig && !runMetaState.skipPinnedConcurrent &&
      assessment.status !== "not-run" && assessment.status !== "invalid" &&
      Array.isArray(assessment.groups) && assessment.groups.length > 0) {
    try {
      const expectedPlanRows = buildExpectedPinnedConcurrentPlanRows(
        assessment.groups,
        runMetaState.pinnedConcurrentRounds,
        runMetaState.protocolSeed,
      );
      assessment = assessPinnedConcurrentEvidence(outDir, {
        ...expectations,
        expectedGroupsRows: assessment.groups,
        expectedPlanRows,
      });
    } catch {
      scheduleReason = "pinned-concurrent seeded schedule could not be regenerated safely";
    }
  }

  if (trustedConfig && runMetaState.skipPinnedConcurrent) {
    const contradictory = pinnedConcurrentWorkloadArtifactsPresent(outDir);
    return {
      status: {
        status: contradictory ? "invalid" : "skipped",
        reasons: contradictory
          ? ["stored configuration skips pinned-concurrent work but workload evidence artifacts are present"]
          : ["stored schema-2 configuration explicitly skips the pinned-concurrent phase"],
        authoritative: false,
        completedWaveCount: 0,
        totalWaveCount: 0,
        discardedTailRowCount: 0,
      },
      summary: null,
      assessment,
    };
  }

  let status = assessment.status;
  const reasons = [...assessment.reasons];
  if (scheduleReason !== null) {
    status = "invalid";
    reasons.push(scheduleReason);
  } else if (!schema2 && status !== "not-run") {
    status = "invalid";
    reasons.push("legacy run metadata cannot authorize schema-2 pinned-concurrent evidence");
  } else if (schema2 && !trustedConfig && status !== "not-run") {
    status = "invalid";
    reasons.push("stored schema-2 run configuration cannot authorize pinned-concurrent expectations");
  } else if (trustedConfig && !runMetaState.skipPinnedConcurrent &&
      groupsAssessment.status !== "complete" && status !== "not-run") {
    if (status === "complete") status = "incomplete";
    reasons.push("validated group evidence is unavailable for pinned-concurrent source provenance");
  } else if (trustedConfig && groupsAssessment.status === "complete" && status !== "not-run") {
    const contextReasons = validatePinnedConcurrentContexts(assessment.groups, groupsAssessment.entries);
    if (contextReasons.length > 0) {
      status = "invalid";
      reasons.push(...contextReasons);
    }
  }
  const authoritative = status === "complete" && assessment.authoritative === true;
  return {
    status: {
      status,
      reasons: [...new Set(reasons)],
      authoritative,
      ...(assessment.meta?.VERSION === "2" ? { metadataVersion: "2" } : {}),
      completedWaveCount: assessment.completedWaveCount ?? 0,
      totalWaveCount: assessment.totalWaveCount ?? 0,
      discardedTailRowCount: assessment.discardedTailRowCount ?? 0,
    },
    summary: pinnedConcurrentSummary(assessment, authoritative),
    assessment,
  };
}

function noTurboPointValue(point) {
  return point?.noTurbo === 0 || point?.noTurbo === 1
    ? String(point.noTurbo)
    : "unavailable";
}

function telemetrySummary(assessment) {
  return {
    generation: assessment.meta?.GENERATION ?? null,
    intervalMs: num(assessment.meta?.INTERVAL_MS),
    boundaryCoverage: assessment.boundaryCoverage ?? null,
    noTurbo: assessment.noTurbo ?? null,
    workloadBinding: assessment.workloadBinding ?? null,
    segments: (assessment.segments ?? []).map((segment) => ({
      segment: segment.segment,
      tag: segment.tag,
      status: segment.status,
      logStatus: segment.logStatus,
      coverage: segment.coverage,
      summary: segment.summary,
      boundary: segment.boundary,
    })),
    authoritative: false,
  };
}

function telemetryBindingExpectation(outDir, phase) {
  try {
    return { binding: computeTelemetryWorkloadBinding(phase, outDir), reason: null };
  } catch (error) {
    return {
      binding: null,
      reason: `owning ${phase} workload binding is unavailable: ${error?.message ?? String(error)}`,
    };
  }
}

function reconcileTelemetryWorkloadBinding(meta, expected) {
  if (expected === null) return false;
  const expectedBoundarySha = expected.workloadBoundariesSha256 ?? "-";
  const expectedBoundaryRows = expected.workloadBoundaryRowCount === undefined
    ? "-"
    : String(expected.workloadBoundaryRowCount);
  return meta?.VERSION === "2" &&
    meta.WORKLOAD_GENERATION === expected.workloadGeneration &&
    meta.WORKLOAD_BINDING_SHA256 === expected.workloadBindingSha256 &&
    meta.WORKLOAD_BOUNDARIES_SHA256 === expectedBoundarySha &&
    meta.WORKLOAD_BOUNDARY_ROW_COUNT === expectedBoundaryRows;
}

function collectTelemetry(outDir, runMetaState, options = {}) {
  const statuses = {};
  const summaries = {};
  const assessments = {};
  const schema2 = runMetaState.runSchemaVersion === 2;
  const trustedConfig = schema2 && runMetaState.status === "complete";
  for (const phase of TELEMETRY_PHASES) {
    const expected = telemetryBindingExpectation(outDir, phase);
    const native = assessTelemetryEvidence(outDir, {
      phase,
      ...(trustedConfig ? { intervalMs: runMetaState.telemetryIntervalMs } : {}),
      requireProductionRoots: options.requireProductionRoots !== false,
    });
    let status = native.status;
    const reasons = [...native.reasons];
    const bindingReconciled = reconcileTelemetryWorkloadBinding(native.meta, expected.binding);
    if (!schema2 && status !== "not-run") {
      status = "invalid";
      reasons.push("legacy run metadata cannot authorize schema-2 telemetry evidence");
    } else if (schema2 && !trustedConfig && status !== "not-run") {
      status = "invalid";
      reasons.push("stored schema-2 run configuration cannot authorize telemetry expectations");
    } else if (status !== "not-run" && !bindingReconciled) {
      status = "invalid";
      reasons.push(expected.reason ?? "telemetry metadata does not bind the exact owning workload evidence");
    }
    const assessment = {
      ...native,
      status,
      reasons: [...new Set(reasons)],
      workloadBinding: expected.binding === null ? null : {
        workloadGeneration: expected.binding.workloadGeneration,
        workloadBindingSha256: expected.binding.workloadBindingSha256,
        workloadBoundariesSha256: expected.binding.workloadBoundariesSha256 ?? null,
        workloadBoundaryRowCount: expected.binding.workloadBoundaryRowCount ?? null,
        reconciled: bindingReconciled,
      },
    };
    assessments[phase] = assessment;
    statuses[phase] = {
      status,
      reasons: assessment.reasons,
      authoritative: false,
      noTurboStatus: assessment.noTurbo?.status ?? "not-run",
      workloadBindingReconciled: bindingReconciled,
    };
    if (native.status !== "not-run") summaries[phase] = telemetrySummary(assessment);
  }
  return { statuses, summaries, assessments };
}

function completeWorkloadPhases(results) {
  const phases = [];
  if (results.baselineStatus?.status === "complete") phases.push("baseline");
  if (results.groupsStatus?.status === "complete") phases.push("groups");
  if (results.individualStatus?.status === "complete") phases.push("individual");
  if (results.pinnedConcurrentStatus?.status === "complete") phases.push("pinned-concurrent");
  if (results.gdb?.status === "captured" || results.gdb?.status === "no-fault") phases.push("gdb");
  return phases;
}

function summarizeExactBoundaryNoTurbo(boundaries) {
  if (!Array.isArray(boundaries) || boundaries.length === 0) return null;
  const observations = boundaries.flatMap((boundary) => [boundary.noTurboStart, boundary.noTurboEnd]);
  const values = observations
    .filter((value) => value === 0 || value === 1)
    .map(String);
  const distinct = [...new Set(values)].sort();
  return {
    status: values.length === observations.length && distinct.length === 1 ? "complete" : "degraded",
    observedValues: distinct,
    validObservations: values.length,
    totalObservations: observations.length,
    unavailableObservations: observations.length - values.length,
    changed: distinct.length > 1,
  };
}

function unavailableAssociation(phase, telemetry, runs, workloadBinding) {
  return {
    status: telemetry?.status === "not-run" ? "not-run" : "degraded",
    reasons: telemetry?.status === "not-run"
      ? ["telemetry was not collected for the exact-CPU workload"]
      : [...new Set(telemetry?.reasons ?? ["telemetry is not valid for exact-run association"])],
    phase,
    totalRuns: runs.length,
    joinedRuns: 0,
    recentPreRuns: 0,
    duringCoveredRuns: 0,
    workloadBinding,
    topology: [],
    byContextOutcome: [],
    byCpu: [],
  };
}

function collectExactTelemetryAssociation(phase, telemetry, runs, binding) {
  const workloadBinding = {
    generation: binding.generation,
    boundariesSha256: binding.boundariesSha256,
    boundaryRowCount: binding.boundaryRowCount,
    reconciled: telemetry?.workloadBinding?.reconciled === true,
  };
  if (telemetry?.status !== "complete" || workloadBinding.reconciled !== true) {
    return unavailableAssociation(phase, telemetry, runs, workloadBinding);
  }
  return {
    phase,
    ...associateTelemetryRuns({
      telemetryAssessment: telemetry,
      runs,
      workloadGeneration: binding.generation,
      workloadBoundariesSha256: binding.boundariesSha256,
      workloadBoundaryRowCount: binding.boundaryRowCount,
      workloadBindingReconciled: true,
    }),
  };
}

function exactIndividualRuns(results, boundaries) {
  if (!Array.isArray(results) || !Array.isArray(boundaries) || results.length !== boundaries.length) return null;
  const runs = boundaries.map((boundary, index) => {
    const result = results[index];
    if (result.ordinal !== boundary.ordinal || result.cpu !== boundary.cpu ||
        (result.run ?? result.round) !== boundary.round ||
        (result.outcome !== undefined && result.outcome !== boundary.outcome)) return null;
    return {
      ...boundary,
      context: "isolated",
      outcome: result.outcome ?? (result.rc === 139 ? "sigsegv" : "pass"),
    };
  });
  return runs.some((run) => run === null) ? null : runs;
}

function exactPinnedConcurrentRuns(assessment) {
  const rows = assessment?.authoritativeRows;
  const boundaries = assessment?.authoritativeBoundaries;
  if (!Array.isArray(rows) || !Array.isArray(boundaries) || rows.length !== boundaries.length) return null;
  const runs = boundaries.map((boundary, index) => {
    const row = rows[index];
    if (boundary.ordinal !== index + 1 || row.cpu !== boundary.cpu || row.group !== boundary.group ||
        row.round !== boundary.round || row.launch_position !== boundary.launchPosition ||
        (row.outcome !== undefined && row.outcome !== boundary.outcome)) return null;
    return {
      ...boundary,
      context: boundary.group,
      outcome: row.outcome ?? (row.rc === 139 ? "sigsegv" : "pass"),
    };
  });
  return runs.some((run) => run === null) ? null : runs;
}

export function summarizeNoTurboCondition(
  telemetryAssessments,
  relevantPhases,
  exactBoundaries = {},
  exactAssociations = {},
) {
  if (relevantPhases.length === 0) return { status: "not-run", phases: [] };
  const phases = relevantPhases.map((phase) => {
    const assessment = telemetryAssessments[phase];
    const segments = [...(assessment?.segments ?? [])].sort((left, right) => left.segment - right.segment);
    const first = segments[0]?.boundary?.start;
    const last = segments.at(-1)?.boundary?.end;
    const noTurbo = assessment?.noTurbo;
    const workloadBoundary = exactBoundaries[phase] ?? null;
    const workloadAssociation = exactAssociations[phase] ?? null;
    const exactPhase = phase === "individual" || phase === "pinned-concurrent";
    const bindingReconciled = assessment?.workloadBinding?.reconciled === true;
    const associatedRunCount = workloadAssociation?.totalRuns;
    const exactBoundaryComplete = exactPhase
      ? workloadBoundary?.status === "complete" && workloadBoundary.totalObservations > 0 &&
        workloadBoundary.validObservations === workloadBoundary.totalObservations &&
        workloadBoundary.unavailableObservations === 0 &&
        Array.isArray(workloadBoundary.observedValues) &&
        workloadBoundary.observedValues.length === 1 &&
        Number.isSafeInteger(associatedRunCount) && associatedRunCount > 0 &&
        associatedRunCount <= Math.floor(Number.MAX_SAFE_INTEGER / 2) &&
        workloadBoundary.totalObservations === associatedRunCount * 2
      : workloadBoundary === null;
    const workloadAssociationComplete = exactPhase
      ? workloadAssociation?.status === "complete" && workloadAssociation.totalRuns > 0 &&
        workloadAssociation.joinedRuns === workloadAssociation.totalRuns &&
        workloadAssociation.recentPreRuns === workloadAssociation.totalRuns &&
        workloadAssociation.duringCoveredRuns === workloadAssociation.totalRuns
      : workloadAssociation === null;
    const complete = assessment?.status === "complete" && noTurbo?.status === "complete" &&
      noTurbo.changed === false && bindingReconciled && exactBoundaryComplete && workloadAssociationComplete &&
      workloadBoundary?.changed !== true;
    return {
      phase,
      status: complete
        ? "complete"
        : assessment?.status === "complete"
          ? "degraded"
          : assessment?.status ?? "not-run",
      startNoTurbo: noTurboPointValue({ noTurbo: first?.noTurbo }),
      endNoTurbo: noTurboPointValue({ noTurbo: last?.noTurbo }),
      sampledValues: noTurbo?.sampledValues ?? [],
      boundaryValues: noTurbo?.boundaryValues ?? [],
      validSamples: noTurbo?.validSamples ?? 0,
      totalSamples: noTurbo?.totalSamples ?? 0,
      validBoundaries: noTurbo?.validBoundaries ?? 0,
      totalBoundaries: noTurbo?.totalBoundaries ?? 0,
      unavailableSamples: noTurbo?.unavailableSamples ?? 0,
      transientSamples: noTurbo?.transientSamples ?? 0,
      workloadBindingReconciled: bindingReconciled,
      workloadAssociationComplete,
      workloadAssociationJoinedRuns: workloadAssociation?.joinedRuns ?? 0,
      workloadAssociationTotalRuns: workloadAssociation?.totalRuns ?? 0,
      workloadAssociationRecentPreRuns: workloadAssociation?.recentPreRuns ?? 0,
      workloadAssociationDuringCoveredRuns: workloadAssociation?.duringCoveredRuns ?? 0,
      workloadBoundaryValues: workloadBoundary?.observedValues ?? [],
      validWorkloadBoundaryObservations: workloadBoundary?.validObservations ?? 0,
      totalWorkloadBoundaryObservations: workloadBoundary?.totalObservations ?? 0,
      unavailableWorkloadBoundaryObservations: workloadBoundary?.unavailableObservations ?? 0,
      changed: noTurbo?.changed === true || workloadBoundary?.changed === true,
    };
  });
  return {
    status: phases.every(({ status }) => status === "complete") ? "complete" : "degraded",
    phases,
  };
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
    schemaVersion: 2,
    outDir: ".",
    collectedAt: new Date().toISOString(),
    config: {
      mode: meta.MODE ?? null,
      runSchemaVersion: runMetaState.runSchemaVersion ?? null,
      startedAt: meta.START_ISO ?? null,
      startEpoch: num(meta.START_EPOCH),
      endEpoch: num(meta.END_EPOCH),
      baselineChildren: runMetaState.baselineChildren ?? null,
      baselineWaves: runMetaState.baselineWaves ?? null,
      groupWaves: runMetaState.groupWaves ?? null,
      individualRuns: num(meta.INDIVIDUAL_RUNS),
      pinnedConcurrentRounds: runMetaState.pinnedConcurrentRounds ?? null,
      protocolSeed: runMetaState.protocolSeed ?? null,
      skipPinnedConcurrent: runMetaState.skipPinnedConcurrent ?? null,
      telemetryIntervalMs: runMetaState.telemetryIntervalMs ?? null,
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
  const individualExactResults = [];
  const individualExactBoundaries = [];
  const individualEvidence = inspectIndividualEvidence(outDir, {
    onV5Result: (row) => individualExactResults.push(row),
    onV5Boundary: (row) => individualExactBoundaries.push(row),
    onV6Result: (row) => individualExactResults.push(row),
    onV6Boundary: (row) => individualExactBoundaries.push(row),
  });
  const individualRows = individualEvidence.rows;
  const individualMetaState = individualEvidence.metaState;
  const individualAssessment = reconcileIndividualWithGroups(assessIndividualEnvelopeRows(
    individualRows,
    individualMetaState.values,
    individualEvidence.phaseDone,
    individualMetaState,
  ), individualMetaState.values, groupsAssessment,
  runMetaState.runSchemaVersion === 2 ? "schema2" : meta.MODE,
  meta.INDIVIDUAL_RUNS,
  runMetaState.protocolSeed);
  const { acceptedRows, acceptedSummaries, ...individualStatus } = individualAssessment;
  results.individualStatus = individualStatus;
  if (acceptedSummaries?.length > 0) results.individual = acceptedSummaries;
  else if (acceptedRows.length > 0) results.individual = collectIndividual(acceptedRows);
  if (individualStatus.status === "complete") {
    results.worstCpu = selectWorstIndividualCpu(results.individual ?? []);
  } else results.worstCpu = null;
  const expectedCpuState = resolveExpectedCpu(runMetaState, individualStatus, results.worstCpu);
  results.cpuSelectionStatus = expectedCpuState;

  // --- exact-CPU pinned-concurrent topology contexts ---
  const pinnedConcurrent = collectPinnedConcurrent(outDir, runMetaState, groupsAssessment);
  results.pinnedConcurrentStatus = pinnedConcurrent.status;
  if (pinnedConcurrent.summary !== null) results.pinnedConcurrent = pinnedConcurrent.summary;

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

  // --- sampled read-only telemetry ---
  // Telemetry deliberately does not feed back into any workload phase status.
  // It qualifies only the independently reported operating condition.
  const telemetry = collectTelemetry(outDir, runMetaState, {
    requireProductionRoots: options.requireProductionTelemetryRoots !== false,
  });
  results.telemetryStatus = telemetry.statuses;
  results.telemetry = telemetry.summaries;
  results.telemetryAssociations = {};
  const exactBoundaryConditions = {};
  if (individualStatus.status === "complete" &&
      (individualStatus.metadataVersion === "5" || individualStatus.metadataVersion === "6")) {
    const exactRuns = exactIndividualRuns(individualExactResults, individualExactBoundaries);
    const binding = {
      generation: individualMetaState.values.GENERATION,
      boundariesSha256: individualMetaState.values.BOUNDARIES_SHA256,
      boundaryRowCount: num(individualMetaState.values.BOUNDARY_ROW_COUNT),
    };
    if (exactRuns !== null) {
      results.telemetryAssociations.individual = collectExactTelemetryAssociation(
        "individual",
        telemetry.assessments.individual,
        exactRuns,
        binding,
      );
      exactBoundaryConditions.individual = summarizeExactBoundaryNoTurbo(individualExactBoundaries);
    }
  }
  if (pinnedConcurrent.status.status === "complete" &&
      pinnedConcurrent.status.authoritative === true) {
    const exactRuns = exactPinnedConcurrentRuns(pinnedConcurrent.assessment);
    const metaValues = pinnedConcurrent.assessment?.meta ?? {};
    const binding = {
      generation: metaValues.GENERATION,
      boundariesSha256: metaValues.BOUNDARIES_SHA256,
      boundaryRowCount: num(metaValues.BOUNDARY_ROW_COUNT),
    };
    if (exactRuns !== null) {
      results.telemetryAssociations["pinned-concurrent"] = collectExactTelemetryAssociation(
        "pinned-concurrent",
        telemetry.assessments["pinned-concurrent"],
        exactRuns,
        binding,
      );
      exactBoundaryConditions["pinned-concurrent"] = summarizeExactBoundaryNoTurbo(
        pinnedConcurrent.assessment.authoritativeBoundaries,
      );
    }
  }
  results.noTurboCondition = summarizeNoTurboCondition(
    telemetry.assessments,
    completeWorkloadPhases(results),
    exactBoundaryConditions,
    results.telemetryAssociations,
  );

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
