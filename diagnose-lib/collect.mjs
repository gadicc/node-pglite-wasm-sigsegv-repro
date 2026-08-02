// collect.mjs - merge raw phase outputs beneath a diagnostics directory
// into a single machine-readable results.json.
//
// Usage: node collect.mjs <out-dir>
//
// Reads (all optional; missing pieces are simply absent from the output):
//   results/meta.env           run configuration
//   results/baseline.meta      baseline parameters (KEY=VALUE)
//   results/groups.tsv         one group per line
//   results/individual.tsv     cpu, run, rc, elapsed
//   results/individual.meta    target CPUs, runs per CPU, skip/completion state
//   results/frequency-ab.tsv   leg, run, rc, elapsed
//   results/frequency-ab.meta  leg configuration + restore status
//   results/gdb.meta           gdb phase parameters
//   env/summary.env            sanitized environment headline fields
//   logs/...                   repro output logs (epoch-prefixed)
//   gdb/*.txt                  capture transcripts
//   freq/<tag>.samples         "epoch cpu khz" lines (or raw turbostat)

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseReproLog } from "./parse-repro-log.mjs";
import { parseGdbCapture } from "./parse-gdb.mjs";
import { assessBaselineEvidence } from "./baseline-evidence.mjs";
import { assessGroupsEvidence, deriveIndividualTargetPolicy } from "./groups-evidence.mjs";
import { inspectFrequencyEvidence, readBoundFrequencyArtifact } from "./frequency-evidence.mjs";
import { assessPreflightEvidence } from "./preflight-evidence.mjs";

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

function readExactTsv(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

function readIndividualMeta(file) {
  if (!existsSync(file)) return { present: false, values: {}, errors: [] };
  const values = {};
  const errors = [];
  const allowed = new Set([
    "VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED",
    "SKIP_REASON", "TARGET_POLICY", "GROUP_PLAN_DIGEST",
  ]);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) {
      errors.push("individual metadata contains a malformed, duplicate, or unknown field");
      continue;
    }
    values[match[1]] = match[2];
  }
  return { present: true, values, errors };
}

function readGdbMeta(file) {
  if (!existsSync(file)) return { present: false, values: {}, errors: [] };
  const values = {};
  const errors = [];
  const allowed = new Set([
    "CPU", "MAX_RUNS", "EXIT_CODE", "ATTEMPTED_RUNS", "CLEAN_RUNS",
    "CAPTURED_RUNS", "ERROR_RUNS", "SKIPPED", "SKIP_REASON",
  ]);
  const lines = readFileSync(file, "utf8").split("\n");
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

export function assessIndividual(rows, meta, phaseDone, metaState = {}) {
  const present = metaState.present ?? Object.keys(meta).length > 0;
  const reasons = [...(metaState.errors ?? [])];
  let invalid = reasons.length > 0;
  const hasArtifacts = rows.length > 0 || present || phaseDone;
  if (!hasArtifacts) return { status: "not-run", reasons: [], targetCpus: [], runsPerCpu: null, acceptedRows: [] };

  const required = ["VERSION", "TARGET_CPUS", "RUNS_PER_CPU", "SKIPPED", "COMPLETED"];
  if (!present || required.some((key) => !Object.hasOwn(meta, key))) {
    reasons.push("individual metadata is missing required fields");
    invalid = true;
  }
  if (meta.VERSION !== "1" && meta.VERSION !== "2") {
    reasons.push("individual metadata version is missing or unsupported");
    invalid = true;
  }
  const provenanceRequired = meta.VERSION === "2";
  if (provenanceRequired) {
    if (!Object.hasOwn(meta, "TARGET_POLICY") ||
        !Object.hasOwn(meta, "GROUP_PLAN_DIGEST")) {
      reasons.push("individual metadata is missing target provenance fields");
      invalid = true;
    }
    if (!["failed-groups", "all-group-cpus", "quick-skip"].includes(meta.TARGET_POLICY) ||
        !/^[a-f0-9]{64}$/.test(meta.GROUP_PLAN_DIGEST ?? "")) {
      reasons.push("individual target provenance is malformed");
      invalid = true;
    }
  } else if (Object.hasOwn(meta, "TARGET_POLICY") || Object.hasOwn(meta, "GROUP_PLAN_DIGEST")) {
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
  const ambiguousCpus = new Set();
  const nextRun = new Map();
  let invalidRows = false;
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
  if (invalidRows) {
    reasons.push("individual results contain a malformed, non-target, non-SIGSEGV, duplicate, or non-contiguous row");
    invalid = true;
  }

  if (skipped === true) {
    if (rows.length > 0) {
      reasons.push("skipped individual phase contains result rows");
      invalid = true;
    }
  } else if (targetSet && runsPerCpu !== null) {
    const missing = [...targetSet].some((cpu) => (nextRun.get(cpu) ?? 1) !== runsPerCpu + 1);
    if (missing) reasons.push("individual results do not contain every expected per-CPU run");
  }
  if (!phaseDone) reasons.push("phase completion marker is missing");
  if (completed === false) reasons.push("individual metadata is not marked complete");

  let status = "incomplete";
  if (invalid) status = "invalid";
  else if (skipped === true && phaseDone && completed === true && rows.length === 0) status = "skipped";
  else if (skipped === false && phaseDone && completed === true && reasons.length === 0) status = "complete";
  const unambiguousRows = acceptedRows.filter((row) => !ambiguousCpus.has(Number(row[0])));
  return {
    status,
    reasons: [...new Set(reasons)],
    targetCpus: targetSet ? [...targetSet] : [],
    runsPerCpu,
    acceptedRows: unambiguousRows,
    skipReason: meta.SKIP_REASON ?? null,
    metadataVersion: meta.VERSION ?? null,
    targetPolicy: meta.TARGET_POLICY ?? null,
    groupPlanDigest: meta.GROUP_PLAN_DIGEST ?? null,
  };
}

export function reconcileIndividualWithGroups(assessment, meta, groupsAssessment, mode, configuredRuns) {
  if (assessment.status === "not-run") return assessment;
  const reasons = [...assessment.reasons];
  let status = assessment.status;
  let acceptedRows = assessment.acceptedRows;
  if (groupsAssessment.status !== "complete") {
    reasons.push("validated group evidence is unavailable for individual target provenance");
    if (status !== "invalid") status = "incomplete";
    acceptedRows = [];
  } else {
    const expected = deriveIndividualTargetPolicy(groupsAssessment, mode);
    const mismatch = !expected || meta.VERSION !== "2" ||
      meta.TARGET_POLICY !== expected.targetPolicy ||
      meta.GROUP_PLAN_DIGEST !== expected.groupPlanDigest ||
      meta.TARGET_CPUS !== expected.targetCpus ||
      meta.SKIPPED !== (expected.skipped ? "1" : "0") ||
      canonicalUint(configuredRuns) === null || meta.RUNS_PER_CPU !== configuredRuns;
    if (mismatch) {
      reasons.push("individual target policy does not match the validated group evidence generation");
      status = "invalid";
      acceptedRows = [];
    }
  }
  return { ...assessment, status, reasons: [...new Set(reasons)], acceptedRows };
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

export function collect(outDir) {
  const runMetaState = readStoredRunMetadata(outDir);
  const meta = runMetaState.values;
  const preflightAssessment = runMetaState.bundleRootSafe
    ? assessPreflightEvidence(outDir)
    : { status: "invalid", reasons: ["bundle root cannot authorize preflight evidence"], generation: null };
  const resultsDir = path.join(outDir, "results");

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
  };
  if (preflightAssessment.status === "complete") {
    results.environment = preflightAssessment.environment;
  }

  // Optional privileged reads produced by a manual `sudo ./root-checks.sh
  // <bundle>` run (kept separate from diagnose.sh, which never elevates).
  const rootDir = path.join(outDir, "env", "root");
  if (runMetaState.bundleRootSafe && existsSync(rootDir)) {
    const rootReads = {};
    for (const f of readdirSync(rootDir).sort()) {
      if (f.endsWith(".txt") || f.endsWith(".meta")) {
        rootReads[f] = readFileSync(path.join(rootDir, f), "utf8").trim();
      }
    }
    if (Object.keys(rootReads).length > 0) results.rootChecks = rootReads;
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
      writeFileSync(
        path.join(outDir, "results.json"),
        `${JSON.stringify(results, null, 2)}\n`,
      );
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
  const individualRows = readExactTsv(path.join(resultsDir, "individual.tsv"));
  const individualMetaState = readIndividualMeta(path.join(resultsDir, "individual.meta"));
  const individualAssessment = reconcileIndividualWithGroups(assessIndividual(
    individualRows,
    individualMetaState.values,
    existsSync(path.join(outDir, "state", "phase-individual.done")),
    individualMetaState,
  ), individualMetaState.values, groupsAssessment, meta.MODE, meta.INDIVIDUAL_RUNS);
  const { acceptedRows, ...individualStatus } = individualAssessment;
  results.individualStatus = individualStatus;
  if (acceptedRows.length > 0) results.individual = collectIndividual(acceptedRows);
  if (individualStatus.status === "complete") {
    const worst = (results.individual ?? [])
      .filter((row) => row.sigsegv > 0)
      .sort((a, b) => b.sigsegv / b.runs - a.sigsegv / a.runs || b.sigsegv - a.sigsegv || a.cpu - b.cpu)[0];
    results.worstCpu = worst ? worst.cpu : null;
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
  const gdbMetaState = readGdbMeta(path.join(resultsDir, "gdb.meta"));
  const gdbMeta = gdbMetaState.values;
  const gdbDir = path.join(outDir, "gdb");
  const captures = [];
  let transcriptCount = 0;
  if (existsSync(gdbDir)) {
    for (const f of readdirSync(gdbDir).sort()) {
      if (!f.endsWith(".txt")) continue;
      transcriptCount += 1;
      const rel = path.join("gdb", f);
      const parsed = parseGdbCapture(readFileSync(path.join(outDir, rel), "utf8"));
      if (!parsed.captured) continue; // clean-run transcripts carry no signature
      // Full mappings stay in the raw transcript; keep the JSON compact.
      parsed.mappings = undefined;
      parsed.file = rel;
      captures.push(parsed);
    }
  }
  const gdbStatus = assessGdb(
    gdbMeta,
    existsSync(path.join(outDir, "state", "phase-gdb.done")),
    captures,
    transcriptCount,
    gdbMetaState,
    expectedCpuState,
  );
  if (gdbStatus.status !== "not-run") {
    const identical =
      captures.length > 1 &&
      captures.every(
        (c) =>
          c.instruction === captures[0].instruction &&
          c.siAddr === captures[0].siAddr &&
          c.intendedAddr === captures[0].intendedAddr &&
          JSON.stringify(c.diffBits) === JSON.stringify(captures[0].diffBits),
      );
    results.gdb = {
      ...gdbStatus,
      cpu: num(gdbMeta.CPU),
      maxRuns: num(gdbMeta.MAX_RUNS),
      exitCode: num(gdbMeta.EXIT_CODE),
      captures,
      capturesIdentical: captures.length > 1 ? identical : null,
    };
  }

  writeFileSync(
    path.join(outDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node collect.mjs <out-dir>");
    process.exit(2);
  }
  collect(outDir);
  console.log("wrote results.json");
}
