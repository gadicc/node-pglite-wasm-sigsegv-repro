// report.mjs - render results.json into report.md.
//
// Usage: node report.mjs <out-dir> [results-input output-path]
//
// Every conclusion is derived from the counts in results.json at render
// time. Nothing about the repository's previously documented findings is
// assumed: if a run does not reproduce, localize, or match the known
// signature, the report says so.

import { existsSync, lstatSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  wilson,
  zeroFailureUpperBound,
  fisherExactGreater,
} from "./stats.mjs";

function pct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtSec(s) {
  if (s === null || s === undefined) return "—";
  if (s < 120) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function fmtMHz(x) {
  if (x === null || x === undefined) return "—";
  return x >= 1000 ? `${(x / 1000).toFixed(2)} GHz` : `${Math.round(x)} MHz`;
}

function fmtNanoseconds(value) {
  const raw = typeof value === "bigint"
    ? value.toString()
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : typeof value === "string" && /^(0|[1-9][0-9]{0,31})$/.test(value)
        ? value
        : null;
  if (raw === null) return "unavailable";
  const nanoseconds = BigInt(raw);
  const [divisor, unit] = nanoseconds >= 1_000_000_000n
    ? [1_000_000_000n, "s"]
    : nanoseconds >= 1_000_000n
      ? [1_000_000n, "ms"]
      : nanoseconds >= 1_000n
        ? [1_000n, "µs"]
        : [1n, "ns"];
  const thousandths = (nanoseconds * 1000n + divisor / 2n) / divisor;
  const whole = thousandths / 1000n;
  const fraction = String(thousandths % 1000n).padStart(3, "0");
  return `${whole}.${fraction} ${unit}`;
}

function descriptiveRateCell(failures, n) {
  if (!validBinomialCounts(failures, n)) return `${failures}/${n} (invalid count)`;
  return `${failures}/${n} = ${pct(failures / n)}`;
}

function frequencyCell(frequency, separator = ", ") {
  if (!frequency || frequency.available === false || frequency.samples === 0) {
    const reason = frequency?.note ??
      (frequency?.samples === 0 ? "0 valid samples; sampler output unavailable" : "not collected");
    return `unavailable (${reason})`;
  }
  return `avg ${fmtMHz(frequency.avgMHz)}${separator}max ${fmtMHz(frequency.maxMHz)}`;
}

function validBinomialCounts(failures, n) {
  return Number.isSafeInteger(failures) && Number.isSafeInteger(n) &&
    n > 0 && failures >= 0 && failures <= n;
}

function validReproCounts(result) {
  if (!result || !Object.hasOwn(result, "sigsegvCount")) return false;
  const counts = [
    result.sigsegvCount,
    result?.otherFailureCount ?? 0,
    result?.unclassifiedFailureCount ?? 0,
  ];
  const n = result?.totalChildInvocations;
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isSafeInteger(n) || n < 0) return false;
  const failures = counts.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(failures) && failures <= n;
}

function reproFailureCount(result) {
  if (!validReproCounts(result)) return null;
  return result.sigsegvCount +
    (result.otherFailureCount ?? 0) +
    (result.unclassifiedFailureCount ?? 0);
}

function validReproWaveCounts(result) {
  if (!validReproCounts(result)) return false;
  const fields = [
    result?.processedWaves,
    result?.fullyPassedWaves,
    result?.failedWaves,
    result?.sigsegvWaveCount,
    result?.sigsegvResolvedWaveCount,
    result?.sigsegvUnresolvedWaveCount,
    result?.otherFailureWaveCount,
    result?.unclassifiedFailureWaveCount,
  ];
  if (!fields.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  const [processed, clean, failed, sigsegv, resolved, unresolved, other, unclassified] = fields;
  const sigsegvChildren = result.sigsegvCount;
  const otherChildren = result.otherFailureCount ?? 0;
  const unclassifiedChildren = result.unclassifiedFailureCount ?? 0;
  const childFailures = sigsegvChildren + otherChildren + unclassifiedChildren;
  return clean + failed === processed &&
    sigsegv <= failed &&
    sigsegv <= sigsegvChildren &&
    (sigsegv === 0) === (sigsegvChildren === 0) &&
    resolved === sigsegv + clean &&
    resolved + unresolved === processed &&
    other <= failed &&
    other <= otherChildren &&
    (other === 0) === (otherChildren === 0) &&
    unclassified <= failed &&
    unclassified <= unclassifiedChildren &&
    (unclassified === 0) === (unclassifiedChildren === 0) &&
    childFailures >= failed &&
    unresolved <= other + unclassified;
}

function hasCompleteReproWaveCoverage(result) {
  if (!validReproWaveCounts(result)) return false;
  const requested = result.requestedWaves ?? result.wavesRequested;
  return Number.isSafeInteger(requested) && requested > 0 &&
    Number.isSafeInteger(result.completedWaves) && result.completedWaves >= 0 &&
    result.processedWaves === result.completedWaves &&
    result.completedWaves === requested;
}

function canSupportCleanReproConclusion(result) {
  return hasCompleteReproWaveCoverage(result) &&
    (result.envelopeStatus ?? "complete") === "complete" &&
    reproCompletionStatus(result) === "complete" &&
    result.sigsegvUnresolvedWaveCount === 0;
}

function validIndividualCounts(result) {
  return Number.isSafeInteger(result?.runs) && result.runs > 0 &&
    Number.isSafeInteger(result?.failures) && result.failures >= 0 &&
    Number.isSafeInteger(result?.sigsegv) && result.sigsegv >= 0 &&
    result.failures === result.sigsegv && result.failures <= result.runs;
}

function validIndividualV6Counts(result) {
  return Number.isSafeInteger(result?.observations) && result.observations > 0 &&
    Number.isSafeInteger(result?.runs) && result.runs >= 0 &&
    Number.isSafeInteger(result?.passes) && result.passes >= 0 &&
    Number.isSafeInteger(result?.failures) && result.failures >= 0 &&
    Number.isSafeInteger(result?.sigsegv) && result.sigsegv >= 0 &&
    Number.isSafeInteger(result?.otherWorkloadFailures) && result.otherWorkloadFailures >= 0 &&
    result.failures === result.sigsegv && result.runs === result.passes + result.sigsegv &&
    result.observations === result.runs + result.otherWorkloadFailures;
}

function validIndividualCountsForStatus(status, result) {
  return status?.metadataVersion === "6"
    ? validIndividualV6Counts(result)
    : validIndividualCounts(result);
}

function validIndividualPrimaryCountsForStatus(status, result) {
  return validIndividualCountsForStatus(status, result) && result.runs > 0;
}

function validPinnedGroupCounts(result) {
  return Number.isSafeInteger(result?.waves) && result.waves > 0 &&
    Number.isSafeInteger(result?.failedWaves) && result.failedWaves >= 0 &&
    result.failedWaves <= result.waves &&
    Number.isSafeInteger(result?.childRuns) && result.childRuns >= result.waves &&
    Number.isSafeInteger(result?.sigsegv) && result.sigsegv >= 0 &&
    result.sigsegv <= result.childRuns && result.sigsegv >= result.failedWaves &&
    (result.sigsegv === 0) === (result.failedWaves === 0);
}

function safeCountSum(rows, field) {
  let total = 0;
  for (const row of rows) {
    const value = row?.[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) return null;
    total += value;
  }
  return total;
}

function validPinnedSummary(summary) {
  const perGroup = Array.isArray(summary?.perGroup) ? summary.perGroup : [];
  const perCpu = Array.isArray(summary?.perCpu) ? summary.perCpu : [];
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  if (perGroup.length === 0 || perCpu.length === 0 ||
      groups.length !== perGroup.length ||
      !perGroup.every(validPinnedGroupCounts) || !perCpu.every(validIndividualCounts)) return false;
  if (!Number.isSafeInteger(summary?.totalWaves) || summary.totalWaves <= 0 ||
      summary.waves !== summary.totalWaves) return false;
  const groupNames = new Set(groups.map((group) => group?.group));
  if (groupNames.size !== groups.length ||
      perGroup.some((record) => !groupNames.has(record.group))) return false;
  for (const group of groups) {
    const outcomes = perGroup.find((record) => record.group === group.group);
    if (!Number.isSafeInteger(group?.rounds) || group.rounds <= 0 ||
        outcomes?.waves !== group.rounds) return false;
  }
  const totals = {
    waves: safeCountSum(perGroup, "waves"),
    failedWaves: safeCountSum(perGroup, "failedWaves"),
    groupChildRuns: safeCountSum(perGroup, "childRuns"),
    groupSigsegv: safeCountSum(perGroup, "sigsegv"),
    cpuRuns: safeCountSum(perCpu, "runs"),
    cpuSigsegv: safeCountSum(perCpu, "sigsegv"),
  };
  return Object.values(totals).every((value) => value !== null) &&
    totals.waves === summary.waves && totals.failedWaves === summary.failedWaves &&
    totals.groupChildRuns === summary.childRuns && totals.cpuRuns === summary.childRuns &&
    totals.groupSigsegv === summary.sigsegv && totals.cpuSigsegv === summary.sigsegv;
}

function validCapturedGdb(result) {
  return result?.status === "captured" && result?.countsAvailable === true &&
    Number.isSafeInteger(result.attemptedRuns) && result.attemptedRuns > 0 &&
    Number.isSafeInteger(result.cleanRuns) && result.cleanRuns >= 0 &&
    Number.isSafeInteger(result.capturedRuns) && result.capturedRuns > 0 &&
    Number.isSafeInteger(result.errorRuns) && result.errorRuns >= 0 &&
    result.capturedRuns <= result.attemptedRuns &&
    result.errorRuns <= result.attemptedRuns - result.capturedRuns &&
    result.cleanRuns === result.attemptedRuns - result.capturedRuns - result.errorRuns &&
    Array.isArray(result.captures) && result.captures.length > 0 &&
    result.captures.length <= result.capturedRuns;
}

function validNoFaultGdb(result) {
  return result?.status === "no-fault" && result?.countsAvailable === true &&
    Number.isSafeInteger(result.attemptedRuns) && result.attemptedRuns > 0 &&
    Number.isSafeInteger(result.cleanRuns) && result.cleanRuns >= 0 &&
    Number.isSafeInteger(result.capturedRuns) && result.capturedRuns === 0 &&
    Number.isSafeInteger(result.errorRuns) && result.errorRuns >= 0 &&
    result.errorRuns <= result.attemptedRuns &&
    result.cleanRuns === result.attemptedRuns - result.errorRuns;
}

function pinnedEvidenceIsAuthoritative(r) {
  return r.pinnedConcurrentStatus?.status === "complete" &&
    r.pinnedConcurrentStatus?.authoritative === true &&
    r.pinnedConcurrent?.authoritative === true && validPinnedSummary(r.pinnedConcurrent);
}

function individualUsesInterleavedProtocol(status) {
  return status?.status === "complete" &&
    (status?.metadataVersion === "5" || status?.metadataVersion === "6") &&
    status?.targetPolicy === "all-usable-cpus" &&
    (status?.protocol === "isolated-interleaved-v1" || status?.protocol === "isolated-outcomes-v2") &&
    status?.scheduleAlgorithm === "balanced-cyclic-v1" &&
    Number.isSafeInteger(status?.scheduleSeed) && status.scheduleSeed >= 0;
}

function protocolRateCell(failures, runs, authoritative) {
  if (!validBinomialCounts(failures, runs)) return "invalid/inconsistent counts; no interval";
  if (!authoritative) return `${descriptiveRateCell(failures, runs)} (descriptive only; no interval)`;
  return statsCell(failures, runs);
}

const POINTWISE_INTERVAL_NOTE = "Nominal pointwise 95% intervals and zero-failure bounds use an independence/stationarity working assumption. Temporal, thermal, and within-machine dependence can make them too narrow; CPU localization remains descriptive.";

function noTurboDisplay(value) {
  if (value === 0 || value === 1 || value === "0" || value === "1") return String(value);
  if (value && typeof value === "object") {
    const state = value.state ?? value.status ?? "unavailable";
    const reason = value.reason ?? value.errorCode;
    return reason ? `${state} (${reason})` : String(state);
  }
  return "unavailable";
}

function metricRange(entries, unit) {
  if (!Array.isArray(entries) || entries.length === 0) return "unavailable";
  let count = 0;
  let unavailable = 0;
  let transient = 0;
  let minimum = null;
  let maximum = null;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry?.count) || entry.count < 0 ||
        !Number.isSafeInteger(entry?.unavailable) || entry.unavailable < 0 ||
        !Number.isSafeInteger(entry?.transient) || entry.transient < 0) continue;
    count += entry.count;
    unavailable += entry.unavailable;
    transient += entry.transient;
    if (entry.count > 0 && Number.isFinite(entry.min) && Number.isFinite(entry.max) &&
        entry.min <= entry.max) {
      minimum = minimum === null ? entry.min : Math.min(minimum, entry.min);
      maximum = maximum === null ? entry.max : Math.max(maximum, entry.max);
    }
  }
  if (minimum === null || maximum === null || count === 0) {
    const missing = unavailable + transient;
    return missing > 0 ? `unavailable (${missing} unavailable/transient values)` : "unavailable";
  }
  const format = unit === "frequency"
    ? (value) => fmtMHz(value / 1000)
    : (value) => `${(value / 1000).toFixed(1)} °C`;
  const suffix = unavailable + transient > 0
    ? `; ${unavailable} unavailable, ${transient} transient`
    : "";
  return `${format(minimum)}–${format(maximum)} (${count} values${suffix})`;
}

function associationMetric(metric, kind) {
  if (!metric || !Number.isSafeInteger(metric.runsWithValue) || metric.runsWithValue === 0 ||
      !Number.isFinite(metric.meanOfRunMeans)) return "unavailable";
  const display = (value) => kind === "frequency"
    ? fmtMHz(value / 1000)
    : `${(value / 1000).toFixed(1)} °C`;
  return `${metric.runsWithValue} run(s), ${metric.observations} sweep value(s); mean of per-run means ${display(metric.meanOfRunMeans)}, range ${display(metric.min)}–${display(metric.max)}`;
}

function renderTelemetryAssociation(phase, association) {
  const L = [`### ${phase} exact-run telemetry association`, ""];
  const binding = association?.workloadBinding;
  L.push(`Association status: **${esc(association?.status ?? "not-run")}**; ${association?.joinedRuns ?? 0}/${association?.totalRuns ?? 0} exact child interval(s) joined, ${association?.recentPreRuns ?? 0} with a recent fully completed pre-run sweep, and ${association?.duringCoveredRuns ?? 0} with at least one fully contained during-run sweep.`);
  if (binding) {
    L.push(`Owning workload reconciliation: ${binding.reconciled === true ? "complete" : "not complete"}; generation \`${esc(binding.generation)}\`, boundary rows ${esc(binding.boundaryRowCount)}, boundary SHA-256 \`${esc(binding.boundariesSha256)}\`.`);
  }
  for (const reason of association?.reasons ?? []) L.push(`- ${esc(reason)}`);
  L.push("");

  const topology = Array.isArray(association?.topology) ? association.topology : [];
  if (topology.length > 0) {
    L.push("CPU-to-sensor mapping used for the join:", "", "| Segment | Logical CPU | Package / die / physical core | Logical CPUs sharing target | Core sensor | Package sensor |", "| ---: | ---: | --- | --- | --- | --- |");
    for (const entry of topology) {
      const coreSensor = entry.coreTemperatureSensor ?? noTurboDisplay(entry.coreTemperatureState);
      const packageSensor = entry.packageTemperatureSensor ?? noTurboDisplay(entry.packageTemperatureState);
      L.push(`| ${esc(entry.segment)} | ${esc(entry.cpu)} | ${esc(entry.package)} / ${esc(entry.die)} / ${esc(entry.core)} | ${esc((entry.logicalCpus ?? []).join(","))} | ${esc(coreSensor)} | ${esc(packageSensor)} |`);
    }
    L.push("");
  }

  const outcomes = Array.isArray(association?.byContextOutcome)
    ? association.byContextOutcome
    : [];
  if (outcomes.length > 0) {
    L.push("Context-stratified pass/failure summaries use one pre-run value per covered run and, for during-run comparisons, the mean within each covered run before averaging across runs. This prevents longer successful attempts from receiving more weight merely because they contain more polls. Execution contexts are never pooled. Context-level outcome rows can still differ in CPU composition; the per-CPU rows below are the finer comparison.", "");
    L.push("| Context | Outcome | Runs / joined | Recent pre / during-covered runs | Pre target `scaling_cur_freq` | During target `scaling_cur_freq` | Pre physical-core temp | During physical-core temp | Pre package temp | During package temp |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of outcomes) {
      L.push(`| ${esc(row.context)} | ${esc(row.outcome)} | ${esc(row.runs)} / ${esc(row.joinedRuns)} | ${esc(row.recentPreRuns)} / ${esc(row.duringCoveredRuns)} | ${associationMetric(row.pre?.targetFrequencyKHz, "frequency")} | ${associationMetric(row.during?.targetFrequencyKHz, "frequency")} | ${associationMetric(row.pre?.physicalCoreTemperatureMillicelsius, "temperature")} | ${associationMetric(row.during?.physicalCoreTemperatureMillicelsius, "temperature")} | ${associationMetric(row.pre?.packageTemperatureMillicelsius, "temperature")} | ${associationMetric(row.during?.packageTemperatureMillicelsius, "temperature")} |`);
    }
    L.push("");
  }

  const perCpu = Array.isArray(association?.byCpu) ? association.byCpu : [];
  if (perCpu.length > 0) {
    L.push("Coverage and run-mean telemetry by exact CPU/context and outcome:", "", "| Context | CPU | Outcome | Runs / joined | Pre / during coverage | Pre frequency mean | During frequency mean | Pre core temp mean | During core temp mean |", "| --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of perCpu) {
      const compact = (metric, kind) => !metric || metric.runsWithValue === 0
        ? "unavailable"
        : kind === "frequency"
          ? fmtMHz(metric.meanOfRunMeans / 1000)
          : `${(metric.meanOfRunMeans / 1000).toFixed(1)} °C`;
      L.push(`| ${esc(row.context)} | ${esc(row.cpu)} | ${esc(row.outcome)} | ${esc(row.runs)} / ${esc(row.joinedRuns)} | ${esc(row.recentPreRuns)} / ${esc(row.duringCoveredRuns)} | ${compact(row.pre?.targetFrequencyKHz, "frequency")} | ${compact(row.during?.targetFrequencyKHz, "frequency")} | ${compact(row.pre?.physicalCoreTemperatureMillicelsius, "temperature")} | ${compact(row.during?.physicalCoreTemperatureMillicelsius, "temperature")} |`);
    }
    L.push("");
  }
  L.push("Each telemetry record is a sequential sysfs sweep over its recorded `read_duration_ns`, not an instantaneous simultaneous measurement. Only sweeps fully completed before launch are called pre-run, and only sweeps wholly inside a child lifetime are called during-run. Failures usually end earlier, so they have fewer chances to record peaks; these associations are descriptive and do not establish cause.", "");
  return L;
}

const TELEMETRY_PHASE_ORDER = ["baseline", "groups", "individual", "pinned-concurrent", "gdb"];

function telemetryEntries(r) {
  const telemetry = r.telemetry && typeof r.telemetry === "object" ? r.telemetry : {};
  const statuses = r.telemetryStatus && typeof r.telemetryStatus === "object" ? r.telemetryStatus : {};
  return TELEMETRY_PHASE_ORDER
    .filter((phase) => Object.hasOwn(telemetry, phase) || Object.hasOwn(statuses, phase))
    .map((phase) => ({
      phase,
      evidence: telemetry[phase] ?? null,
      status: statuses[phase] ?? { status: telemetry[phase]?.status ?? "not-run", reasons: [] },
    }));
}

function ci(failures, n) {
  if (!validBinomialCounts(failures, n)) return "interval unavailable";
  const w = wilson(failures, n);
  return `[${pct(w.low)}, ${pct(w.high)}]`;
}

function zeroBound(n) {
  if (!n) return "—";
  return `< ${pct(zeroFailureUpperBound(n))}`;
}

function esc(s) {
  return String(s ?? "—");
}

function statsCell(failures, n) {
  if (failures === 0 && n === 0) return "no valid runs";
  if (!validBinomialCounts(failures, n)) return `${failures}/${n} (invalid count; no interval)`;
  if (failures === 0) return `0/${n} (95% upper ${zeroBound(n)})`;
  return `${failures}/${n} = ${pct(failures / n)} ${ci(failures, n)}`;
}

function reproCompletionStatus(result) {
  if (result?.completionStatus) return result.completionStatus;
  return result?.partial ? "partial" : "complete";
}

function reproWaveStatsCell(result) {
  if (!validReproWaveCounts(result)) {
    return "interval unavailable (legacy or invalid wave counts)";
  }
  const failures = result.sigsegvWaveCount;
  const n = result.sigsegvResolvedWaveCount;
  const unresolved = result.sigsegvUnresolvedWaveCount;
  const status = reproCompletionStatus(result);
  const envelopeStatus = result.envelopeStatus ?? "complete";
  if (n === 0) return `0/0 resolved waves (${unresolved} unresolved; no interval)`;
  if (envelopeStatus !== "complete") {
    return `${failures}/${n} = ${pct(failures / n)} (descriptive only; ${envelopeStatus} evidence envelope)`;
  }
  if (status !== "complete") {
    return `${failures}/${n} = ${pct(failures / n)} (descriptive only; ${status} structure)`;
  }
  if (!hasCompleteReproWaveCoverage(result)) {
    return "interval unavailable (incomplete or invalid wave coverage)";
  }
  if (failures === 0 && unresolved > 0) {
    return `0/${n} (no upper bound; ${unresolved} unresolved wave(s))`;
  }
  return statsCell(failures, n);
}

function analyzeFrequencyAb(fa) {
  if (!Array.isArray(fa?.legs) || fa.legs.length !== 3) {
    return { valid: false, issues: ["expected exactly one A1, B, and A2 leg"] };
  }
  const byName = new Map();
  for (const leg of fa.legs) {
    if (!["A1", "B", "A2"].includes(leg?.leg) || byName.has(leg.leg)) {
      return { valid: false, issues: ["expected exactly one A1, B, and A2 leg"] };
    }
    byName.set(leg.leg, leg);
  }
  const a1 = byName.get("A1");
  const b = byName.get("B");
  const a2 = byName.get("A2");
  if (!a1 || !b || !a2) {
    return { valid: false, issues: ["expected exactly one A1, B, and A2 leg"] };
  }
  const issues = [];
  for (const leg of [a1, b, a2]) {
    if (!Number.isSafeInteger(leg.runs) || leg.runs <= 0 ||
        !Number.isSafeInteger(leg.failures) || !Number.isSafeInteger(leg.sigsegv) ||
        leg.failures < 0 || leg.failures > leg.runs || leg.sigsegv !== leg.failures) {
      issues.push(`${leg.leg} has invalid or inconsistent run/SIGSEGV counts`);
    }
    if (!Array.isArray(leg.invalidRuns) || leg.invalidRuns.length > 0) {
      issues.push(`${leg.leg} contains invalid or unverified runs`);
    }
  }
  if (issues.length > 0) return { valid: false, issues };
  if (!Number.isSafeInteger(a1.runs + b.runs) || !Number.isSafeInteger(a2.runs + b.runs)) {
    return { valid: false, issues: ["frequency comparison totals exceed the safe integer range"] };
  }
  const a1F = a1.sigsegv;
  const a2F = a2.sigsegv;
  const bF = b.sigsegv;
  const bN = b.runs;
  const pA1GreaterB = fisherExactGreater(a1F, a1.runs - a1F, bF, bN - bF);
  const pA2GreaterB = fisherExactGreater(a2F, a2.runs - a2F, bF, bN - bF);
  const a1Directional = a1F / a1.runs > bF / bN;
  const a2Directional = a2F / a2.runs > bF / bN;
  const replicatedP = Math.max(pA1GreaterB, pA2GreaterB);
  const replicatedReduction = a1Directional && a2Directional &&
    pA1GreaterB < 0.05 && pA2GreaterB < 0.05;
  return {
    valid: true,
    issues: [],
    a1,
    b,
    a2,
    a1F,
    a2F,
    bF,
    bN,
    pA1GreaterB,
    pA2GreaterB,
    replicatedP,
    a1Directional,
    a2Directional,
    replicatedReduction,
  };
}

function validatedReproductionEvidence(r) {
  const evidence = [];
  if (r.baselineStatus?.status === "complete" && validReproCounts(r.baseline) &&
      hasCompleteReproWaveCoverage(r.baseline) &&
      r.baseline.sigsegvCount > 0) {
    evidence.push({ protocol: "baseline concurrent", failures: r.baseline.sigsegvCount });
  }
  if (r.groupsStatus?.status === "complete") {
    for (const group of r.groups ?? []) {
      if (validReproCounts(group) && hasCompleteReproWaveCoverage(group) &&
          group.sigsegvCount > 0) {
        evidence.push({ protocol: `shared-mask group ${group.name}`, failures: group.sigsegvCount });
      }
    }
  }
  if (r.individualStatus?.status === "complete") {
    for (const cpu of r.individual ?? []) {
      if (validIndividualPrimaryCountsForStatus(r.individualStatus, cpu) && cpu.sigsegv > 0) {
        evidence.push({ protocol: `isolated pinned CPU ${cpu.cpu}`, failures: cpu.sigsegv });
      }
    }
  }
  if (pinnedEvidenceIsAuthoritative(r)) {
    for (const cpu of r.pinnedConcurrent?.perCpu ?? []) {
      if (validIndividualCounts(cpu) && cpu.sigsegv > 0) {
        evidence.push({ protocol: `pinned-concurrent CPU ${cpu.cpu}`, failures: cpu.sigsegv });
      }
    }
  }
  if (validCapturedGdb(r.gdb)) {
    evidence.push({ protocol: "GDB pinned capture", failures: r.gdb.capturedRuns });
  }
  return evidence;
}

function requiredNoTurboPhases(r) {
  const phases = [];
  if (r.baselineStatus?.status === "complete") phases.push("baseline");
  if (r.groupsStatus?.status === "complete") phases.push("groups");
  if (r.individualStatus?.status === "complete") phases.push("individual");
  if (r.pinnedConcurrentStatus?.status === "complete") phases.push("pinned-concurrent");
  if (r.gdb?.status === "captured" || r.gdb?.status === "no-fault") phases.push("gdb");
  return phases;
}

function validatedNoTurboCondition(r) {
  const state = r.noTurboCondition;
  const phases = Array.isArray(state?.phases) ? state.phases : [];
  const requiredPhases = requiredNoTurboPhases(r);
  const suppliedPhaseNames = phases.map((phase) => phase?.phase);
  const suppliedPhaseSet = new Set(suppliedPhaseNames);
  const exactPhaseCoverage = requiredPhases.length > 0 &&
    phases.length === requiredPhases.length && suppliedPhaseSet.size === phases.length &&
    requiredPhases.every((phase) => suppliedPhaseSet.has(phase));
  const complete = state?.status === "complete" && exactPhaseCoverage && phases.every((phase) => {
    const exactPhase = phase?.phase === "individual" || phase?.phase === "pinned-concurrent";
    const sampledValues = Array.isArray(phase?.sampledValues)
      ? phase.sampledValues.map(String)
      : [];
    const boundaryValues = Array.isArray(phase?.boundaryValues)
      ? phase.boundaryValues.map(String)
      : [];
    const boundaryCountsComplete =
      Number.isSafeInteger(phase.validBoundaries) && Number.isSafeInteger(phase.totalBoundaries) &&
      phase.validBoundaries > 0 && phase.validBoundaries === phase.totalBoundaries;
    const sampleCountsComplete = Number.isSafeInteger(phase.validSamples) &&
      Number.isSafeInteger(phase.totalSamples) && phase.validSamples > 0 &&
      phase.validSamples === phase.totalSamples &&
      Number.isSafeInteger(phase.unavailableSamples) && phase.unavailableSamples === 0 &&
      Number.isSafeInteger(phase.transientSamples) && phase.transientSamples === 0;
    const workloadBoundaryCountsComplete = exactPhase
      ? (Number.isSafeInteger(phase.validWorkloadBoundaryObservations) &&
       Number.isSafeInteger(phase.totalWorkloadBoundaryObservations) &&
       phase.totalWorkloadBoundaryObservations > 0 &&
       phase.validWorkloadBoundaryObservations === phase.totalWorkloadBoundaryObservations &&
       Number.isSafeInteger(phase.unavailableWorkloadBoundaryObservations) &&
       phase.unavailableWorkloadBoundaryObservations === 0 &&
       Array.isArray(phase.workloadBoundaryValues) &&
       phase.workloadBoundaryValues.length === 1 &&
       String(phase.workloadBoundaryValues[0]) === "0")
      : phase.totalWorkloadBoundaryObservations === 0 &&
        phase.validWorkloadBoundaryObservations === 0 &&
        phase.unavailableWorkloadBoundaryObservations === 0 &&
        Array.isArray(phase.workloadBoundaryValues) && phase.workloadBoundaryValues.length === 0;
    const basicAssociationCounts = Number.isSafeInteger(phase.workloadAssociationJoinedRuns) &&
      Number.isSafeInteger(phase.workloadAssociationTotalRuns) &&
      phase.workloadAssociationJoinedRuns >= 0 && phase.workloadAssociationTotalRuns >= 0 &&
      phase.workloadAssociationJoinedRuns === phase.workloadAssociationTotalRuns;
    const workloadAssociationCountsComplete = basicAssociationCounts && (exactPhase
      ? phase.workloadAssociationTotalRuns > 0 &&
        Number.isSafeInteger(phase.workloadAssociationRecentPreRuns) &&
        Number.isSafeInteger(phase.workloadAssociationDuringCoveredRuns) &&
        phase.workloadAssociationRecentPreRuns === phase.workloadAssociationTotalRuns &&
        phase.workloadAssociationDuringCoveredRuns === phase.workloadAssociationTotalRuns &&
        phase.workloadAssociationTotalRuns <= Math.floor(Number.MAX_SAFE_INTEGER / 2) &&
        phase.totalWorkloadBoundaryObservations === phase.workloadAssociationTotalRuns * 2
      : phase.workloadAssociationTotalRuns === 0 && phase.workloadAssociationJoinedRuns === 0);
    const startIsZero = phase.startNoTurbo === 0 || phase.startNoTurbo === "0";
    const endIsZero = phase.endNoTurbo === 0 || phase.endNoTurbo === "0";
    return phase?.status === "complete" && startIsZero && endIsZero && sampledValues.length === 1 &&
      sampledValues[0] === "0" && boundaryValues.length === 1 && boundaryValues[0] === "0" &&
      sampleCountsComplete && phase.changed === false && boundaryCountsComplete &&
      phase.workloadBindingReconciled === true && phase.workloadAssociationComplete === true &&
      workloadAssociationCountsComplete && workloadBoundaryCountsComplete;
  });
  return { complete, phases, status: state?.status ?? "not-run" };
}

function executiveRate(record) {
  if (!validIndividualCounts(record)) return "unavailable";
  if (record.sigsegv === 0) {
    return `no failures observed (0/${record.runs}; 95% upper ${zeroBound(record.runs)})`;
  }
  return `${record.sigsegv}/${record.runs} = ${pct(record.sigsegv / record.runs)} ${ci(record.sigsegv, record.runs)}`;
}

function renderExecutiveSummary(r, env) {
  const L = ["## Executive Summary", ""];
  const reproduced = validatedReproductionEvidence(r).length > 0;
  const condition = validatedNoTurboCondition(r);
  if (reproduced && condition.complete) {
    L.push("**Result — fault reproduced with turbo permitted.** Complete, validated workload evidence recorded confirmed SIGSEGVs while `intel_pstate/no_turbo` was 0 at every relevant phase boundary, every exact-child boundary where available, and every sample in the validated coverage envelope; no change was observed.");
  } else if (reproduced) {
    L.push("**Result — fault reproduced, but the turbo condition was not fully verified.** Complete, validated workload evidence recorded confirmed SIGSEGVs. The available `intel_pstate/no_turbo` boundary or sampled-envelope evidence is incomplete, unavailable, changed, or not reconciled to every exact child interval, so this report does not overstate the operating condition.");
  } else {
    L.push("**Result — no confirmed SIGSEGV appears in complete, validated workload evidence.** This is not proof that the system is stable; incomplete, invalid, and zero-failure samples cannot rule out an intermittent defect.");
  }
  L.push("");

  const identity = [
    env.DMI_PRODUCT ? `system ${esc(env.DMI_PRODUCT)}` : null,
    env.BIOS_VERSION ? `BIOS ${esc(env.BIOS_VERSION)}${env.BIOS_DATE ? ` (${esc(env.BIOS_DATE)})` : ""}` : null,
    env.CPU_MODEL ? `CPU ${esc(env.CPU_MODEL)}` : null,
    env.CPU_STEPPING ? `stepping ${esc(env.CPU_STEPPING)}` : null,
    env.CPU_MICROCODE ? `microcode ${esc(env.CPU_MICROCODE)}` : null,
  ].filter(Boolean);
  if (identity.length > 0) L.push(`System identity: ${identity.join("; ")}.`, "");

  if (condition.phases.length > 0) {
    L.push("Linux `intel_pstate` semantics: `no_turbo=0` means turbo is permitted; `no_turbo=1` means turbo is disabled. Permission does not prove that boost frequency was continuously used.", "");
    L.push("| Relevant phase | First boundary `no_turbo` | Last boundary `no_turbo` | Session boundary values | Exact child-boundary values | Validated sampled values | Workload binding / validation |", "| --- | ---: | ---: | --- | --- | --- | --- |");
    for (const phase of condition.phases) {
      const values = Array.isArray(phase.sampledValues) && phase.sampledValues.length > 0
        ? phase.sampledValues.join(", ")
        : "unavailable";
      const boundaryValues = Array.isArray(phase.boundaryValues) && phase.boundaryValues.length > 0
        ? phase.boundaryValues.join(", ")
        : [...new Set([phase.startNoTurbo, phase.endNoTurbo].filter((value) => value !== undefined))].join(", ") || "unavailable";
      const coverage = Number.isSafeInteger(phase.validSamples) && Number.isSafeInteger(phase.totalSamples)
        ? `${values} (${phase.validSamples}/${phase.totalSamples} valid samples)`
        : values;
      const workloadBoundaryValues = Array.isArray(phase.workloadBoundaryValues) &&
        phase.workloadBoundaryValues.length > 0
        ? `${phase.workloadBoundaryValues.join(", ")} (${phase.validWorkloadBoundaryObservations ?? 0}/${phase.totalWorkloadBoundaryObservations ?? 0} valid observations)`
        : "not applicable";
      const association = (phase.workloadAssociationTotalRuns ?? 0) > 0
        ? `; exact child joins ${phase.workloadAssociationJoinedRuns ?? 0}/${phase.workloadAssociationTotalRuns}`
        : "";
      L.push(`| ${esc(phase.phase)} | ${esc(phase.startNoTurbo)} | ${esc(phase.endNoTurbo)} | ${boundaryValues} | ${workloadBoundaryValues} | ${coverage} | ${phase.workloadBindingReconciled === true && phase.workloadAssociationComplete === true ? `${esc(phase.status)}${association}` : "unbound / degraded"} |`);
    }
    L.push("");
  } else {
    L.push("`intel_pstate/no_turbo` was not verified throughout the relevant workload by a validated sampled telemetry envelope.", "");
  }

  const isolated = r.individualStatus?.status === "complete"
    ? (r.individual ?? []).filter((record) =>
      validIndividualPrimaryCountsForStatus(r.individualStatus, record))
    : [];
  const concurrent = pinnedEvidenceIsAuthoritative(r)
    ? (r.pinnedConcurrent?.perCpu ?? []).filter(validIndividualCounts)
    : [];
  const gdbKnownCpu = r.gdb?.status === "captured" && Number.isSafeInteger(r.gdb?.cpu) &&
    (r.gdb.captures ?? []).some((capture) => capture.classification === "known-signature")
    ? r.gdb.cpu
    : null;
  const failingCpuIds = [...new Set([
    ...isolated.filter((cpu) => cpu.sigsegv > 0).map((cpu) => cpu.cpu),
    ...concurrent.filter((cpu) => cpu.sigsegv > 0).map((cpu) => cpu.cpu),
    ...(gdbKnownCpu === null ? [] : [gdbKnownCpu]),
  ])].sort((a, b) => a - b);
  if (failingCpuIds.length > 0) {
    L.push("Confirmed failing logical CPUs from exact-pinning protocols:", "", "| CPU | Isolated pinned | Pinned-concurrent contexts | GDB exact-CPU capture |", "| ---: | --- | --- | --- |");
    for (const cpuId of failingCpuIds) {
      const isolatedRecord = isolated.find((record) => record.cpu === cpuId);
      const contexts = concurrent.filter((record) => record.cpu === cpuId);
      let concurrentCell = "not collected";
      if (contexts.length > 0) {
        concurrentCell = contexts
          .map((record) => `${esc(record.context ?? record.group ?? "context")}: ${executiveRate(record)}`)
          .join("; ");
      }
      const gdbCell = cpuId === gdbKnownCpu
        ? "validated intended-address + 2^42 fault captured"
        : "not captured";
      L.push(`| ${cpuId} | ${isolatedRecord ? executiveRate(isolatedRecord) : "not collected"} | ${concurrentCell} | ${gdbCell} |`);
    }
    L.push("", POINTWISE_INTERVAL_NOTE, "");
  }

  const failingGroups = r.groupsStatus?.status === "complete"
    ? (r.groups ?? []).filter((group) => validReproCounts(group) && group.sigsegvCount > 0)
    : [];
  if (failingGroups.length > 0) {
    L.push("Shared-mask group exposure (not exact CPU attribution):");
    for (const group of failingGroups) {
      const waveCell = validReproWaveCounts(group)
        ? `${group.sigsegvWaveCount}/${group.sigsegvResolvedWaveCount} SIGSEGV-positive resolved waves`
        : "wave denominator unavailable";
      L.push(`- ${esc(group.name)} (${esc(group.cpus)}): ${waveCell}; ${group.sigsegvCount}/${group.totalChildInvocations} child SIGSEGVs (descriptive child rate).`);
    }
    L.push("");
  }

  if (r.pinnedConcurrentStatus?.status === "unavailable") {
    L.push("Pinned-concurrent: unavailable because the validated topology had no safe controller CPU outside an active context. No pinned-concurrent workload ran, so this contributes neither reproduction nor no-failure evidence.", "");
  }

  if (r.gdb?.status === "captured") {
    const known = r.gdb.captures?.filter((capture) => capture.classification === "known-signature").length ?? 0;
    const total = r.gdb.captures?.length ?? 0;
    const cpuText = Number.isSafeInteger(r.gdb?.cpu) ? ` on logical CPU ${r.gdb.cpu}` : "";
    L.push(known > 0
      ? `GDB: confirmed the documented intended-address + 2^42 signature in ${known}/${total} validated capture(s)${cpuText}.`
      : `GDB: ${total} validated fault capture(s), but none confirmed every prerequisite of the documented +2^42 signature.`);
    L.push("");
  }

  if (reproduced) {
    const conditionText = condition.complete ? "tested ordinary turbo-permitted condition" : "tested condition";
    L.push(`Conclusion: the complete validated experiment reproduces the SIGSEGV on this system under the ${conditionText}. This supports hardware service/RMA investigation, but it does not by itself establish whether the mechanism is silicon, motherboard, firmware, power delivery, memory, or software.`);
  } else {
    L.push("Conclusion: the validated evidence in this bundle is insufficient for a positive RMA reproduction claim.");
  }
  L.push("");
  return L;
}

function renderTelemetrySection(r) {
  const L = ["## Read-only telemetry coverage", ""];
  const entries = telemetryEntries(r);
  L.push("Telemetry is descriptive operating context only. It never makes an incomplete or invalid workload phase authoritative, and a telemetry failure does not erase separately validated workload outcomes.");
  L.push("`scaling_cur_freq` is a kernel cpufreq point sample, not effective busy frequency or proof that a requested turbo ratio was delivered.");
  L.push("");
  if (entries.length === 0) {
    L.push("No validated sampled telemetry envelope is present. This is expected for legacy bundles; preflight and per-phase frequency snapshots do not establish the state throughout a workload.", "");
    return L;
  }

  L.push("| Workload phase | Telemetry envelope | Sampling interval | Segments covered | Workload-boundary coverage | Exact `no_turbo` observations |", "| --- | --- | ---: | ---: | --- | --- |");
  for (const { phase, evidence, status } of entries) {
    const segments = Array.isArray(evidence?.segments) ? evidence.segments : [];
    const completeSegments = segments.filter((segment) => segment?.status === "complete").length;
    const boundary = evidence?.boundaryCoverage;
    const boundaryCell = boundary && Number.isSafeInteger(boundary.coveredSegments) &&
      Number.isSafeInteger(boundary.totalSegments)
      ? `${boundary.status}: ${boundary.coveredSegments}/${boundary.totalSegments} segment(s)`
      : "unavailable";
    const nt = evidence?.noTurbo;
    const sampled = Array.isArray(nt?.sampledValues) && nt.sampledValues.length > 0
      ? nt.sampledValues.map(String).join(", ")
      : "unavailable";
    const boundaryValues = Array.isArray(nt?.boundaryValues) && nt.boundaryValues.length > 0
      ? nt.boundaryValues.map(String).join(", ")
      : "unavailable";
    const noTurboCell = nt
      ? `samples ${sampled} (${nt.validSamples ?? "?"}/${nt.totalSamples ?? "?"} valid); boundaries ${boundaryValues} (${nt.validBoundaries ?? "?"}/${nt.totalBoundaries ?? "?"} valid)${nt.changed ? "; changed" : ""}`
      : "unavailable";
    L.push(`| ${phase} | ${esc(status?.status ?? "not-run")} | ${evidence?.intervalMs ?? "—"}${Number.isSafeInteger(evidence?.intervalMs) ? " ms" : ""} | ${completeSegments}/${segments.length} | ${boundaryCell} | ${noTurboCell} |`);
  }
  L.push("");

  for (const { phase, evidence, status } of entries) {
    const segments = Array.isArray(evidence?.segments) ? evidence.segments : [];
    if (status?.status !== "complete") {
      L.push(`**${phase} telemetry status: ${esc(status?.status ?? "not-run")}.** Any safely parsed segment summaries below are descriptive only.`);
      for (const reason of status?.reasons ?? []) L.push(`- ${esc(reason)}`);
      L.push("");
    }
    if (segments.length === 0) continue;
    L.push(`### ${phase} telemetry segments`, "");
    L.push("| Segment / tag | Validation and boundary coverage | Samples | Exact `no_turbo` boundary → boundary; samples | `scaling_cur_freq` recorded range | Package temperature range | Core temperature range |", "| --- | --- | ---: | --- | --- | --- | --- |");
    for (const segment of segments) {
      const summary = segment?.summary;
      const nt = summary?.noTurbo;
      const start = noTurboDisplay(segment?.boundary?.start?.noTurbo);
      const end = noTurboDisplay(segment?.boundary?.end?.noTurbo);
      const sampled = Array.isArray(nt?.sampledValues) && nt.sampledValues.length > 0
        ? nt.sampledValues.map(String).join(", ")
        : "unavailable";
      const noTurboCell = `${start} → ${end}; ${sampled} (${nt?.validSamples ?? 0}/${nt?.totalSamples ?? summary?.samples ?? 0} valid${(nt?.unavailableSamples ?? 0) > 0 ? `, ${nt.unavailableSamples} unavailable` : ""}${(nt?.transientSamples ?? 0) > 0 ? `, ${nt.transientSamples} transient` : ""})`;
      const coverage = segment?.coverage?.status ?? "unavailable";
      L.push(`| ${esc(segment?.segment)} / ${esc(segment?.tag)} | ${esc(segment?.status ?? "unknown")}; boundary ${esc(coverage)} | ${summary?.samples ?? "—"} | ${noTurboCell} | ${metricRange(summary?.frequencyKHz, "frequency")} | ${metricRange(summary?.packageTemperatureMillicelsius, "temperature")} | ${metricRange(summary?.coreTemperatureMillicelsius, "temperature")} |`);
    }
    L.push("");

    const cadenceSegments = segments.filter((segment) => segment?.coverage?.cadence);
    if (cadenceSegments.length > 0) {
      L.push("Sampling cadence audit:", "");
      L.push("A poll is counted as late after more than two requested intervals. A workload sample-start gap above the recorded maximum allowed gap makes coverage incomplete; the missed-poll count is an estimate from those gaps.", "");
      L.push("| Segment / tag | Requested interval | Maximum allowed sample-start gap | Maximum observed workload sample-start gap | Late polls | Estimated missed polls | Cadence violations |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const segment of cadenceSegments) {
        const cadence = segment.coverage.cadence;
        const interval = Number.isSafeInteger(cadence.intervalMs)
          ? `${cadence.intervalMs} ms`
          : Number.isSafeInteger(evidence?.intervalMs)
            ? `${evidence.intervalMs} ms`
            : "unavailable";
        L.push(`| ${esc(segment?.segment)} / ${esc(segment?.tag)} | ${interval} | ${fmtNanoseconds(cadence.maximumAllowedSampleStartGapNs)} | ${fmtNanoseconds(cadence.maxWorkloadSampleStartGapNs)} | ${esc(cadence.latePollCount)} | ${esc(cadence.missedPollIntervals)} | ${esc(cadence.cadenceViolationCount)} |`);
      }
      L.push("");
    }
  }
  for (const phase of ["individual", "pinned-concurrent"]) {
    const association = r.telemetryAssociations?.[phase];
    if (association) L.push(...renderTelemetryAssociation(phase, association));
  }
  L.push("Temperature and frequency ranges summarize point samples and can miss short peaks between polls. They are not used to infer cause or to reclassify workload evidence.", "");
  return L;
}

export function renderReport(results) {
  const r = results;
  const L = [];
  const suppliedEnv = r.environment ?? {};
  const preflightStatus = r.preflightStatus?.status ?? "not-run";
  const env = preflightStatus === "complete" ? suppliedEnv : {};
  const durationSec =
    r.config?.endEpoch && r.config?.startEpoch
      ? r.config.endEpoch - r.config.startEpoch
      : null;

  L.push("# Diagnostic report: concurrent PGlite SIGSEGV reproduction");
  L.push("");
  L.push(...renderExecutiveSummary(r, env));
  L.push("## Run record");
  L.push("");
  L.push(`- Generated: ${r.collectedAt}`);
  L.push(`- Run started: ${esc(r.config?.startedAt)}`);
  L.push(`- Test duration: ${durationSec !== null ? fmtSec(durationSec) : "unknown"}`);
  if (r.config?.interrupted) {
    L.push("- **This run was interrupted; results are partial.**");
  }
  L.push(`- Mode: ${esc(r.config?.mode)}`);
  L.push("");
  L.push("All conclusions below are derived from the measurements in");
  L.push("`results.json` produced by *this* run, not from prior reports.");
  L.push("A zero in this report means no failure was observed in this batch; it");
  L.push("does not supersede a failure captured in an earlier diagnostic session.");
  L.push("");

  L.push("## Sharing this evidence bundle");
  L.push("");
  L.push("This report is only one part of the evidence. Before sending it to Dell support:");
  L.push("");
  L.push("1. From inside the completed bundle, run `sha256sum -c manifest.txt`. A missing manifest or any failed checksum means the bundle is not a completed, authoritative generation.");
  L.push("2. Review `privacy-review.txt` and every raw file it flags for local paths or unexpected identifiers.");
  L.push("3. Send the entire completed bundle, not `report.md` alone, so the results, raw evidence, telemetry, and validation manifests remain reviewable together.");
  L.push("");
  L.push("Service tags and serial numbers are deliberately excluded. Provide the service tag separately through the secure Dell support case or another Dell-approved secure channel; do not add it to this bundle.");
  L.push("");

  // ------------------------------------------------------------------
  L.push("## Environment (sanitized)");
  L.push("");
  if (preflightStatus !== "complete") {
    const reasons = r.preflightStatus?.reasons ?? [];
    L.push(`**Preflight snapshot ${preflightStatus === "not-run" ? "was not collected" : "was excluded as invalid or incomplete"}.**`);
    if (reasons.length > 0) L.push(`Validation: ${reasons.map(esc).join("; ")}.`);
    L.push("");
  }
  L.push("Preflight intentionally excludes service tags, serial numbers, UUIDs,");
  L.push("and MAC addresses. Raw GDB and third-party tool output can still contain");
  L.push("local paths or unexpected identifiers; review `privacy-review.txt` and");
  L.push("the raw files before sharing the bundle.");
  L.push("These values are point snapshots collected during preflight. They are");
  L.push("descriptive context only: they do not establish that the same state held");
  L.push("during later workload phases and are not used for automatic causal rule-outs.");
  L.push("");
  L.push("| Field | Value |");
  L.push("| --- | --- |");
  const envRows = [
    ["Distribution", env.DISTRO],
    ["Kernel", env.KERNEL],
    ["Kernel command line", env.CMDLINE ? `\`${env.CMDLINE.replaceAll("|", " ")}\`` : null],
    ["Node", env.NODE_VERSION],
    ["V8", env.V8_VERSION],
    ["PGlite", env.PGLITE_VERSION],
    ["CPU model", env.CPU_MODEL],
    ["CPU stepping", env.CPU_STEPPING],
    ["Microcode", env.CPU_MICROCODE],
    ["Address sizes", env.CPU_ADDRESS_SIZES],
    ["Logical CPUs", env.CPU_LOGICAL],
    ["Online CPUs", env.ONLINE_CPUS],
    ["P-core CPUs", env.P_CORES],
    ["E-core CPUs", env.E_CORES],
    ["DMI product", env.DMI_PRODUCT],
    ["Motherboard", env.DMI_BOARD],
    ["BIOS", env.BIOS_VERSION && env.BIOS_DATE ? `${env.BIOS_VERSION} (${env.BIOS_DATE})` : env.BIOS_VERSION],
    ["cpufreq driver", env.CPUFREQ_DRIVER],
    ["Governor / EPP", env.GOVERNOR && env.EPP ? `${env.GOVERNOR} / ${env.EPP}` : env.GOVERNOR],
    ["intel_pstate no_turbo (at preflight)", env.NO_TURBO],
    ["TME state at preflight (best effort)", env.TME_STATE],
    ["Power source at preflight", env.POWER_SOURCE],
    ["intel-undervolt tool/service at preflight (not voltage offsets)", env.UNDERVOLT_STATE],
    ["Missing optional tools", env.MISSING_OPTIONAL],
  ];
  for (const [k, v] of envRows) {
    if (v !== undefined && v !== null && v !== "") L.push(`| ${k} | ${esc(v)} |`);
  }
  L.push("");

  // Optional privileged reads (manual root-checks.sh output).
  const rootChecksStatus = r.rootChecksStatus?.status ?? "not-run";
  if (rootChecksStatus === "complete" && r.rootChecks) {
    L.push("### Privileged reads: out-of-band supplemental snapshot");
    L.push("");
    L.push("Collected separately and read-only by a user-reviewed `root-checks.sh`");
    L.push("sudo run; `diagnose.sh` itself never elevates privileges. This is a");
    L.push("supplemental point snapshot only and is never used for causal claims.");
    if (r.rootChecksStatus?.collectedAt) {
      L.push(`Snapshot collected: ${esc(r.rootChecksStatus.collectedAt)}.`);
    }
    L.push("");
    const caps = { "kernel-warnings.txt": 40, "cctk.txt": 30, "intel-undervolt.txt": 30, "turbostat.txt": 20 };
    for (const file of ["kernel-warnings.txt", "intel-undervolt.txt", "cctk.txt", "turbostat.txt"]) {
      const text = r.rootChecks[file];
      if (typeof text !== "string") continue;
      L.push(`\`env/root/${file}\`:`);
      L.push("");
      L.push("```");
      const cap = caps[file] ?? 20;
      const lines = text.split("\n");
      L.push(...lines.slice(0, cap));
      if (lines.length > cap) L.push(`... (${lines.length - cap} more lines in the file)`);
      L.push("```");
      L.push("");
    }
  } else if (rootChecksStatus !== "not-run") {
    L.push("### Privileged reads: out-of-band supplemental snapshot");
    L.push("");
    L.push(`**Root-checks evidence was excluded as ${rootChecksStatus}.**`);
    for (const reason of r.rootChecksStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
    L.push("No privileged-read payload is displayed or used for conclusions.");
    L.push("");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 2: baseline reproduction");
  L.push("");
  if (r.baseline) {
    const b = r.baseline;
    const envelopeStatus = r.baselineStatus?.status ?? "legacy-unvalidated";
    const failureCount = reproFailureCount(b);
    const completionStatus = reproCompletionStatus(b);
    L.push(`${b.children} concurrent children per wave, STOP_ON_FAILURE=0.`);
    L.push("");
    if (envelopeStatus !== "complete") {
      L.push(`**The baseline evidence envelope is ${envelopeStatus}. Its safely parsed`);
      L.push("wave rows are shown descriptively but are excluded from reproduction and zero-failure rate conclusions.**");
      for (const reason of r.baselineStatus?.reasons ?? []) L.push(`- ${reason}`);
      L.push("");
    }
    if (completionStatus === "partial") {
      L.push("**The baseline log has no completion footer (the run was");
      L.push("interrupted); wave counts below were recovered from per-wave");
      L.push("rows and are partial data, not a completed run.**");
      L.push("");
    } else if (completionStatus === "inconsistent") {
      L.push("**The baseline log is structurally inconsistent. Counts below come");
      L.push("only from unambiguous, unique wave rows and are descriptive; they");
      L.push("cannot support a no-failure conclusion or a rate bound.**");
      for (const entry of b.issues ?? []) L.push(`- ${entry.message}`);
      L.push("");
    }
    L.push("| Metric | Value |");
    L.push("| --- | --- |");
    const statusNote = completionStatus === "partial"
      ? " (log truncated; partial data)"
      : completionStatus === "inconsistent" ? " (structurally inconsistent; descriptive only)" : "";
    L.push(`| Waves | ${b.processedWaves ?? b.completedWaves}/${b.requestedWaves} processed, ${b.failedWaves} failed${statusNote} |`);
    L.push(`| Child invocations | ${b.totalChildInvocations} |`);
    L.push(`| Confirmed child SIGSEGVs / measured rate (descriptive) | ${validReproCounts(b) ? descriptiveRateCell(b.sigsegvCount, b.totalChildInvocations) : "invalid/missing"} |`);
    L.push(`| Other failures | ${b.otherFailureCount} |`);
    if ((b.unclassifiedFailureCount ?? 0) > 0) L.push(`| Unclassified failures (summary only) | ${b.unclassifiedFailureCount} |`);
    L.push(`| All child failures / measured rate (descriptive) | ${failureCount === null ? "invalid/missing" : descriptiveRateCell(failureCount, b.totalChildInvocations)} |`);
    L.push(`| SIGSEGV-positive waves | ${validReproWaveCounts(b) ? b.sigsegvWaveCount : "invalid/missing"} |`);
    L.push(`| Unresolved SIGSEGV endpoint waves | ${validReproWaveCounts(b) ? b.sigsegvUnresolvedWaveCount : "invalid/missing"} |`);
    const baselineWaveRate = envelopeStatus === "complete"
      ? reproWaveStatsCell(b)
      : validReproWaveCounts(b) && b.sigsegvResolvedWaveCount > 0
        ? `${descriptiveRateCell(b.sigsegvWaveCount, b.sigsegvResolvedWaveCount)} (descriptive only; no interval${b.sigsegvUnresolvedWaveCount > 0 ? `; ${b.sigsegvUnresolvedWaveCount} unresolved` : ""})`
        : "interval unavailable (legacy or invalid wave counts)";
    L.push(`| SIGSEGV wave rate / 95% CI | ${baselineWaveRate} |`);
    L.push(`| Time to first failure | ${fmtSec(b.firstFailureAfterSec)} |`);
    L.push(`| Duration | ${fmtSec(b.durationSec)} |`);
    L.push(`| Frequency (${b.frequency?.method ?? "n/a"}) | ${frequencyCell(b.frequency)} |`);
    L.push("");
    L.push(`Raw log: \`${b.log}\`. Concurrent children within a wave are correlated,`);
    L.push("so child-process counts are descriptive. Only a complete validated envelope");
    L.push("receives a resolved-wave interval; it treats sequential waves as trials and");
    L.push("assumes those waves are independent and stationary.");
    L.push("");
  } else {
    const status = r.baselineStatus?.status ?? "not-run";
    if (status === "not-run") {
      L.push("Not run (or no data collected).\n");
    } else {
      L.push(`Baseline evidence envelope: **${status}**. No baseline log was safe to parse.`);
      for (const reason of r.baselineStatus?.reasons ?? []) L.push(`- ${reason}`);
      L.push("");
    }
  }

  // ------------------------------------------------------------------
  L.push("## Phase 3: CPU-group isolation");
  L.push("");
  const groupsStatus = r.groupsStatus?.status ?? (r.groups?.length ? "legacy-unvalidated" : "not-run");
  if (groupsStatus !== "complete" && groupsStatus !== "not-run") {
    L.push(`**CPU-group evidence envelope: ${groupsStatus}.** Its rows and logs are`);
    L.push("excluded from aggregate reproduction and group-localization conclusions.");
    for (const reason of r.groupsStatus?.reasons ?? []) L.push(`- ${reason}`);
    L.push("");
  }
  if (r.groups?.length) {
    L.push(groupsStatus === "complete"
      ? "The validated groups were discovered from sysfs topology, not hardcoded."
      : "Stored legacy/unvalidated group rows are shown only as descriptive payload; their topology provenance and completion are not authorized.");
    L.push("Each row uses one shared CPU affinity mask for the controller and all");
    L.push("children. Children may migrate anywhere inside that mask; child index");
    L.push("is not CPU identity, and a group failure cannot identify which CPU faulted.");
    L.push("");
    L.push("| Group | CPU affinity mask | Children/wave | Processed waves (any-failure waves) | Waves with ≥1 SIGSEGV / rate (95% CI) | Child SIGSEGVs / measured rate (descriptive) | Other child failures | Unresolved waves | Recorded frequency sample |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const g of r.groups) {
      const n = g.totalChildInvocations ?? 0;
      const completionStatus = reproCompletionStatus(g);
      const statusNote = completionStatus === "partial"
        ? " (log truncated; partial data)"
        : completionStatus === "inconsistent" ? " (structurally inconsistent; descriptive only)" : "";
      const waveCountsValid = validReproWaveCounts(g);
      const waveRate = groupsStatus === "complete"
        ? reproWaveStatsCell(g)
        : waveCountsValid && g.sigsegvResolvedWaveCount > 0
          ? `${descriptiveRateCell(g.sigsegvWaveCount, g.sigsegvResolvedWaveCount)} (descriptive only; no interval${g.sigsegvUnresolvedWaveCount > 0 ? `; ${g.sigsegvUnresolvedWaveCount} unresolved` : ""})`
          : "interval unavailable (legacy or invalid wave counts)";
      L.push(
        `| ${g.name} | ${g.cpus} | ${g.children} | ${g.processedWaves ?? g.completedWaves ?? "?"}/${g.wavesRequested} (${g.failedWaves ?? "?"} any-failure)${statusNote} | ${waveRate} | ${validReproCounts(g) ? descriptiveRateCell(g.sigsegvCount, n) : "invalid"} | ${validReproCounts(g) ? (g.otherFailureCount ?? 0) : "invalid"}${(g.unclassifiedFailureCount ?? 0) > 0 ? ` (+${g.unclassifiedFailureCount} unclassified)` : ""} | ${waveCountsValid ? g.sigsegvUnresolvedWaveCount : "invalid/missing"} | ${frequencyCell(g.frequency, " / ")} |`,
      );
    }
    L.push("");
    L.push(groupsStatus === "complete"
      ? "Resolved-wave intervals assume sequential waves are independent and stationary."
      : "No interval or zero-failure bound is reported for these legacy/unvalidated rows.");
    L.push("Rates from groups with different children-per-wave are not");
    L.push("directly comparable because the chance of at least one SIGSEGV changes");
    L.push("with the number of concurrent children.");
    L.push("The child percentage is the observed fraction of child processes that");
    L.push("SIGSEGVed. It is descriptive only: children in one wave share load and");
    L.push("an affinity mask, so they are correlated and receive no child-level CI.");
    L.push("Excluding unresolved waves can also bias a resolved-wave interval; their");
    L.push("count is shown rather than silently treating them as negative trials.");
    L.push("");
  } else if (groupsStatus === "not-run") {
    L.push("Not run (or no data collected).\n");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 4: individual CPU isolation");
  L.push("");
  const individualStatus = r.individualStatus?.status ?? "not-run";
  const individualComplete = individualStatus === "complete";
  if (individualStatus === "skipped") {
    L.push(`Skipped${r.individualStatus?.skipReason ? `: ${r.individualStatus.skipReason}.` : "."}`);
    L.push("");
  } else if (r.individual?.length) {
    if (!individualComplete) {
      L.push(`**Individual-phase status: ${individualStatus}.** Only unambiguous`);
      L.push("canonical prefix rows are shown descriptively below. They are excluded");
      L.push("from worst-CPU selection and CPU-localization conclusions.");
      for (const reason of r.individualStatus?.reasons ?? []) L.push(`- ${reason}`);
      L.push("");
    }
    L.push("This is a **different workload protocol** from the group phase: one direct");
    L.push("`node child.mjs` process is pinned to exactly one logical CPU per attempt,");
    L.push("with no concurrent PGlite siblings. It does not retest the shared-mask");
    L.push("cluster condition above.");
    if (individualUsesInterleavedProtocol(r.individualStatus)) {
      L.push(`Schema-2/V${esc(r.individualStatus.metadataVersion)} used a precommitted seeded, position-balanced interleaving (${esc(r.individualStatus.scheduleAlgorithm)}, seed ${r.individualStatus.scheduleSeed}): every round visits every usable CPU once, with rotated positions rather than CPU-major batches.`);
      L.push("This reduces systematic position bias but does not remove time, temperature, warm-up, or workload-drift confounding; per-CPU comparisons remain descriptive.");
      if (r.individualStatus.metadataVersion === "6") {
        L.push("V6 classifies securely launched nonzero exits and non-SIGSEGV signals as `other-workload-failure`. Those observations advance the immutable schedule but are reported separately and excluded from the pass/SIGSEGV primary denominator.");
      }
    } else if (r.individualStatus?.metadataVersion &&
        r.individualStatus.metadataVersion !== "5" && r.individualStatus.metadataVersion !== "6") {
      L.push("This is a legacy CPU-major protocol whose per-CPU batches ran sequentially. CPU identity is therefore confounded with time, temperature, and workload drift; localization remains descriptive.");
    } else {
      L.push("A complete validated interleaved schedule identity is unavailable, so the report does not claim randomized or position-balanced ordering. Per-CPU localization remains descriptive.");
    }
    L.push("A CPU with zero failures is **not** proven failure-free; its nominal 95% upper");
    L.push("bound quantifies the sample under an independence/stationarity working assumption. It means only");
    L.push("that this protocol did not reproduce on that CPU in this run; it does not");
    L.push("erase failures observed in prior sessions.");
    L.push("");
    const individualV6 = r.individualStatus?.metadataVersion === "6";
    L.push(individualV6
      ? "| CPU | Committed observations | Primary eligible (pass + SIGSEGV) | SIGSEGV | Other workload failures | Nominal SIGSEGV rate / pointwise 95% interval or bound | Notes |"
      : "| CPU | Runs | Failures | Nominal rate / pointwise 95% interval or bound | Notes |");
    L.push(individualV6
      ? "| --- | ---: | ---: | ---: | ---: | --- | --- |"
      : "| --- | --- | --- | --- | --- |");
    for (const c of r.individual) {
      const notes = [];
      const countsValid = individualV6 ? validIndividualV6Counts(c) : validIndividualCounts(c);
      if (!countsValid) notes.push("inconsistent failure counts; excluded from conclusions");
      if (countsValid && c.runs > 0 && individualComplete && c.cpu === r.worstCpu && c.failures > 0) notes.push("highest observed rate");
      if (c.invalidRuns?.length > 0) notes.push(`${c.invalidRuns.length} invalid run(s) excluded (non-SIGSEGV exits)`);
      if (c.failedRuns?.length) {
        const shown = c.failedRuns.slice(0, 20);
        const failureLabel = individualV6 ? "SIGSEGV runs" : "failed runs";
        notes.push(`${failureLabel}: ${shown.map((f) => `#${f.run} (${f.signal})`).join(", ")}${c.failedRuns.length > shown.length ? `; ${c.failedRuns.length - shown.length} more retained detail(s) not rendered` : ""}`);
      }
      if (c.otherWorkloadFailureDetails?.length) {
        const shown = c.otherWorkloadFailureDetails.slice(0, 20);
        notes.push(`other workload failures: ${shown.map((f) =>
          `#${f.run} (${f.signal ?? `exit ${f.exitCode}`}, stderr ${String(f.stderrSha256).slice(0, 12)}…)`).join(", ")}${c.otherWorkloadFailureDetails.length > shown.length ? `; ${c.otherWorkloadFailureDetails.length - shown.length} more retained detail(s) not rendered` : ""}`);
      }
      if ((c.failedRunsOmitted ?? 0) > 0) {
        notes.push(`${c.failedRuns?.length ?? 0} failed-run detail(s) retained; ${c.failedRunsOmitted} omitted by the bounded collector`);
      }
      L.push(individualV6
        ? `| ${c.cpu} | ${c.observations ?? "—"} | ${c.runs} | ${c.sigsegv} | ${c.otherWorkloadFailures ?? c.otherFailures ?? 0} | ${countsValid && c.runs > 0 ? protocolRateCell(c.failures, c.runs, individualComplete) : countsValid ? "no primary-eligible observations; no interval" : "invalid/inconsistent counts; no interval"} | ${notes.join("; ") || "—"} |`
        : `| ${c.cpu} | ${c.runs} | ${c.failures} | ${countsValid ? protocolRateCell(c.failures, c.runs, individualComplete) : "invalid/inconsistent counts; no interval"} | ${notes.join("; ") || "—"} |`);
    }
    L.push("", POINTWISE_INTERVAL_NOTE, "");
  } else if (individualStatus === "invalid" || individualStatus === "incomplete") {
    L.push(`**Individual-phase status: ${individualStatus}.** No unambiguous result`);
    L.push("prefix was available; evidence is excluded from statistics, worst-CPU");
    L.push("selection, and CPU-localization conclusions.");
    for (const reason of r.individualStatus?.reasons ?? []) L.push(`- ${reason}`);
    L.push("");
  } else {
    L.push("Not run (or no data collected).\n");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 5: exact-CPU pinned-concurrent contexts");
  L.push("");
  const pinnedStatus = r.pinnedConcurrentStatus?.status ?? "not-run";
  const pinned = r.pinnedConcurrent;
  const pinnedComplete = pinnedEvidenceIsAuthoritative(r);
  if (pinnedStatus === "unavailable") {
    L.push("**Unavailable: no safe pinned-concurrent controller/topology context.** The validated source topology did not provide a controller CPU outside an active context, so no pinned-concurrent workload was launched.");
    L.push("This terminal availability result is non-authoritative workload evidence: it supports no reproduction, zero-failure, rate-bound, or exact-CPU localization conclusion.");
    for (const reason of r.pinnedConcurrentStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
    L.push("");
  } else if (pinnedStatus === "skipped") {
    L.push(`Skipped${r.pinnedConcurrentStatus?.skipReason ? `: ${r.pinnedConcurrentStatus.skipReason}.` : "."}`);
    for (const reason of r.pinnedConcurrentStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
    L.push("");
  } else if (pinned) {
    if (!pinnedComplete) {
      L.push(`**Pinned-concurrent phase status: ${pinnedStatus}.** Complete group-wave prefixes may be shown descriptively, but they are excluded from reproduction, rate-bound, and exact-CPU localization conclusions.`);
      for (const reason of r.pinnedConcurrentStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
      if (pinnedStatus === "complete") L.push("- The evidence is not explicitly authoritative or its collected summaries do not reconcile exactly; it is excluded.");
      const discarded = r.pinnedConcurrentStatus?.discardedTailRowCount;
      if (Number.isSafeInteger(discarded) && discarded > 0) {
        L.push(`- ${discarded} child row(s) ended inside a wave and were excluded; that whole wave must be rerun.`);
      }
      L.push("");
    }
    L.push("Each context launches one child pinned to each active logical CPU at the same time, while the controller is pinned outside that active set. Unlike the shared-mask group phase, every child has an exact CPU identity.");
    L.push("Wave outcomes and child outcomes are reported separately: a wave is one correlated concurrent trial; child counts identify which pinned process faulted but do not form independent concurrent trials.");
    if (pinned.scheduleAlgorithm || Number.isSafeInteger(pinned.scheduleSeed)) {
      L.push(`The stored launch/context schedule is ${esc(pinned.scheduleAlgorithm)}${Number.isSafeInteger(pinned.scheduleSeed) ? ` with seed ${pinned.scheduleSeed}` : ""}. Contexts are separate strata and are never pooled.`);
    }
    L.push("");

    const groupByName = new Map((pinned.groups ?? []).map((group) => [group.group, group]));
    if (Array.isArray(pinned.perGroup) && pinned.perGroup.length > 0) {
      L.push("### Per-context wave outcomes", "");
      L.push("| Context | Kind / active CPUs | Controller CPU | Completed waves | SIGSEGV-positive waves / nominal pointwise interval | Child runs | Pinned-child SIGSEGVs / measured rate |", "| --- | --- | ---: | ---: | --- | ---: | --- |");
      for (const group of pinned.perGroup) {
        const topology = groupByName.get(group.group) ?? {};
        const valid = validPinnedGroupCounts(group);
        const waveRate = valid
          ? protocolRateCell(group.failedWaves, group.waves, pinnedComplete)
          : "invalid/inconsistent counts; no interval";
        const childRate = validBinomialCounts(group.sigsegv, group.childRuns)
          ? `${descriptiveRateCell(group.sigsegv, group.childRuns)} (descriptive; correlated children, no child-level interval)`
          : "invalid/inconsistent counts";
        L.push(`| ${esc(group.group)} | ${esc(topology.kind)} / ${esc(topology.cpus)} | ${esc(topology.controllerCpu)} | ${esc(group.waves)} | ${waveRate} | ${esc(group.childRuns)} | ${childRate} |`);
      }
      L.push("");
    }

    if (Array.isArray(pinned.perCpu) && pinned.perCpu.length > 0) {
      L.push("### Exact pinned-child outcomes by context and CPU", "");
      L.push("| Context | CPU | Concurrent attempts | SIGSEGVs | Nominal per-attempt rate / pointwise 95% interval or bound |", "| --- | ---: | ---: | ---: | --- |");
      for (const cpu of pinned.perCpu) {
        const context = cpu.context ?? cpu.group;
        const valid = validIndividualCounts(cpu);
        L.push(`| ${esc(context)} | ${esc(cpu.cpu)} | ${esc(cpu.runs)} | ${esc(cpu.sigsegv)} | ${valid ? protocolRateCell(cpu.sigsegv, cpu.runs, pinnedComplete) : "invalid/inconsistent counts; no interval"} |`);
      }
      L.push("");
      L.push("A logical CPU can appear in more than one topology context. Its rows remain context-specific because sibling load, active-set size, and thermal history differ; no cross-context rate is calculated.", POINTWISE_INTERVAL_NOTE, "");
    }
  } else if (pinnedStatus === "invalid" || pinnedStatus === "incomplete") {
    L.push(`**Pinned-concurrent phase status: ${pinnedStatus}.** No safe whole-wave prefix was available for display, and no pinned-concurrent conclusion is drawn.`);
    for (const reason of r.pinnedConcurrentStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
    L.push("");
  } else {
    L.push("Not run. Legacy bundles do not acquire this phase implicitly, and shared-mask group results cannot substitute for exact-CPU concurrent evidence.\n");
  }

  // ------------------------------------------------------------------
  L.push(...renderTelemetrySection(r));

  // ------------------------------------------------------------------
  L.push("## Phase 6: controlled frequency A/B/A");
  L.push("");
  if (r.frequencyAb) {
    const fa = r.frequencyAb;
    const frequencyComplete = r.frequencyAbStatus?.status === "complete";
    if (!frequencyComplete) {
      L.push(`**Frequency A/B/A status: ${esc(r.frequencyAbStatus?.status ?? "legacy-unvalidated")}.** Stored leg rows are descriptive only; they cannot support a reduction, suppression, or causal conclusion.`);
      for (const reason of r.frequencyAbStatus?.reasons ?? []) L.push(`- ${esc(reason)}`);
      L.push("");
    }
    const selectionNote = r.cpuSelectionStatus?.policy === "fixed"
      ? "fixed by the stored CPU selection policy"
      : "highest observed individual failure rate";
    L.push(`Test CPU: ${fa.cpu} (${selectionNote}). Original`);
    L.push(`settings saved first; restored after the phase: ${fa.restored ? "yes" : "**NO — check intel_pstate/no_turbo and scaling_max_freq**"}.`);
    L.push("");
    L.push("Failures are SIGSEGV (exit 139) only; any other nonzero exit is an");
    L.push("invalid run, excluded from the run counts below.");
    L.push("");
    L.push("| Leg | no_turbo | scaling_max_freq | Valid runs | SIGSEGV | Rate / bound | Recorded frequency sample (avg/max) |");
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const leg of fa.legs) {
      const inv = leg.invalidRuns?.length ?? 0;
      L.push(
        `| ${leg.leg} | ${leg.noTurbo ?? "—"} | ${leg.scalingMaxKhz ? `${Math.round(leg.scalingMaxKhz / 1000)} MHz` : "—"} | ${leg.runs} | ${leg.failures}${inv > 0 ? ` (+${inv} invalid excluded)` : ""} | ${statsCell(leg.failures, leg.runs)} | ${frequencyCell(leg.frequency, " / ")} |`,
      );
    }
    L.push("");
    const fx = analyzeFrequencyAb(fa);
    if (!frequencyComplete) {
      L.push("No inferential comparison is reported because an explicit complete validated A/B/A envelope is unavailable.");
    } else if (!fx.valid) {
      L.push(`Frequency inference is unavailable: ${fx.issues.join("; ")}. The leg rows remain descriptive, but no reduction or suppression claim is made.`);
    } else {
      L.push(`Prespecified directional Fisher exact tests (turbo-on failure rate > turbo-off): A1 vs B p = ${fx.pA1GreaterB.toExponential(2)}; A2 vs B p = ${fx.pA2GreaterB.toExponential(2)}. Replicated gate p = max(p1, p2) = ${fx.replicatedP.toExponential(2)} (both comparisons must be directional and strictly p < 0.05).`);
      if (fx.replicatedReduction && fx.bF === 0) {
        L.push(`Both directional comparisons pass and the sampled turbo-off leg had zero observed failures (0/${fx.bN}). This does not prove a zero failure rate.`);
        L.push("The sequential, non-randomized A/B/A result supports an association under this session's conditions; it does not by itself establish frequency as the cause or exclude time/order confounding.");
      } else if (fx.replicatedReduction) {
        L.push(`Both directional comparisons pass, supporting a replicated observed reduction in the turbo-off leg (${fx.bF}/${fx.bN}); failures were not completely suppressed.`);
        L.push("The sequential, non-randomized A/B/A result supports an association under this session's conditions; it does not by itself establish frequency as the cause or exclude time/order confounding.");
      } else if (!fx.a1Directional || !fx.a2Directional) {
        L.push("The prespecified direction was not observed in both comparisons, so the reversal gate failed and no reduction or suppression claim is made.");
      } else {
        L.push("Both point estimates were in the prespecified direction, but at least one exact comparison did not pass p < 0.05; the replicated gate failed and no reduction or suppression claim is made.");
      }
    }
    L.push("");
  } else if (r.frequencyAbStatus?.status === "incomplete") {
    L.push("Incomplete manual A/B/A artifacts were preserved but excluded from");
    L.push("all statistics and conclusions:");
    for (const reason of r.frequencyAbStatus.reasons ?? []) L.push(`- ${reason}`);
    L.push("");
    L.push("Finish or redo the manual experiment, then run");
    L.push("`./diagnose.sh --resume <this bundle> --yes` to regenerate this report.");
    L.push("");
  } else {
    L.push("Not run automatically. This experiment changes `intel_pstate`");
    L.push("settings, so it is only ever performed manually as root:");
    L.push("`sudo ./frequency-ab.sh <cpu> <runs-per-leg> <this bundle>`, then");
    L.push("`./diagnose.sh --resume <this bundle> --yes` to regenerate this report.");
    L.push("");
  }
  if (r.frequencyCap) {
    const fc = r.frequencyCap;
    L.push(`### Per-CPU frequency-cap experiment (CPU ${fc.cpu}, requested cap ${fc.requestedCapKhz / 1000} MHz)`);
    L.push("");
    L.push(`${fc.note}.`);
    L.push("");
    for (const leg of fc.legs ?? []) {
      L.push(`- ${leg.leg}: ${statsCell(leg.failures, leg.runs)}, frequency ${frequencyCell(leg.frequency)}`);
    }
    L.push("");
  } else if (r.frequencyCapStatus?.status === "incomplete") {
    L.push("### Per-CPU frequency-cap experiment");
    L.push("");
    L.push("Incomplete or stale cap artifacts were excluded from the report:");
    for (const reason of r.frequencyCapStatus.reasons ?? []) L.push(`- ${reason}`);
    L.push("");
  } else if ((r.frequencyCapStatus?.reasons?.length ?? 0) > 0) {
    L.push("### Per-CPU frequency-cap experiment");
    L.push("");
    L.push("Stale cap artifacts were excluded because the current A/B/A generation did not request a cap:");
    for (const reason of r.frequencyCapStatus.reasons) L.push(`- ${reason}`);
    L.push("");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 7: GDB fault signature");
  L.push("");
  if (r.gdb?.status === "captured") {
    const g = r.gdb;
    L.push(`Fault captured on CPU ${g.cpu} (pinned by taskset, so the faulting CPU is known by construction).`);
    if (g.countsAvailable) {
      L.push(`Attempt accounting: ${g.attemptedRuns} attempted, ${g.cleanRuns} completed without a captured fault, ${g.capturedRuns} captured, and ${g.errorRuns} runner error(s).`);
    }
    L.push("");
    L.push("| Capture | Instruction | Intended addr | si_addr (source) | Diff | Differing bits | Intended mapped/writable | si_addr mapped | Classification |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of g.captures) {
      L.push(
        `| \`${c.file}\` | \`${c.instruction ?? "?"}\` | ${c.intendedAddr ?? "—"} | ${c.siAddr ?? "—"} (${c.siAddrSource ?? "unknown"}) | ${c.addrDiffHex ?? "—"} | ${c.diffBits?.length ? c.diffBits.join(",") : "—"} | ${c.intendedMapped === null ? "—" : `${c.intendedMapped}/${c.intendedWritable}`} | ${c.siAddrMapped === null ? "—" : c.siAddrMapped} | ${c.classification} |`,
      );
    }
    L.push("");
    if (g.captures.length > 1) {
      L.push(`Multiple-capture comparison: material fields (instruction, intended address, si_addr, differing bits) are ${g.capturesIdentical ? "**identical** across captures" : "**NOT identical** across captures"}.`);
      L.push("");
    }
  } else if (r.gdb?.status === "no-fault") {
    if (r.gdb.countsAvailable) {
      L.push(`Ran ${r.gdb.attemptedRuns} pinned attempt(s) on CPU ${r.gdb.cpu ?? "—"}: ${r.gdb.cleanRuns} completed without a captured fault and ${r.gdb.errorRuns} runner error(s).`);
      L.push(`Using only those ${r.gdb.cleanRuns} completed no-fault attempt(s), the zero-failure 95% upper bound per attempt is ${pct(zeroFailureUpperBound(r.gdb.cleanRuns))}; this does not disprove the defect.`);
    } else {
      L.push(`The legacy GDB result reports no captured fault on CPU ${r.gdb.cpu ?? "—"}, but per-attempt no-fault/error accounting is unavailable.`);
      L.push("No zero-failure bound is calculated because the number of successfully executed no-fault attempts is unknown.");
    }
    L.push("");
  } else if (r.gdb?.status === "failed") {
    L.push(`The capture runner failed before producing valid completed evidence${r.gdb.reason ? `: ${r.gdb.reason}` : "."}`);
    L.push("No no-fault bound or signature conclusion is drawn.");
    L.push("");
  } else if (r.gdb?.status === "incomplete") {
    L.push(`Incomplete GDB artifacts were preserved but excluded from conclusions${r.gdb.reason ? `: ${r.gdb.reason}` : "."}`);
    L.push("");
  } else if (r.gdb?.status === "skipped") {
    L.push(`Skipped${r.gdb.reason ? `: ${r.gdb.reason}` : "."}`);
    L.push("");
  } else {
    L.push("Not run.");
    L.push("");
  }

  // ------------------------------------------------------------------
  L.push("## Conclusions (derived from this run)");
  L.push("");
  L.push(...renderConclusions(r));
  L.push("");

  // ------------------------------------------------------------------
  L.push("## Limitations");
  L.push("");
  L.push("- No failures observed never proves a zero failure rate. The reported");
  L.push("  pointwise 95% upper bound (1 - 0.05^(1/n); approximately 3/n for");
  L.push("  large n) is nominal under an independence/stationarity working assumption.");
  L.push("  Temporal or thermal dependence can make it too narrow.");
  L.push("- Observed failure rates can drift between batches; comparisons use");
  L.push("  exact tests on paired batches where possible, but small samples");
  L.push("  remain weak evidence.");
  if (individualUsesInterleavedProtocol(r.individualStatus)) {
    L.push(`- The isolated V${esc(r.individualStatus.metadataVersion)} schedule is seeded and position-balanced, which reduces`);
    L.push("  systematic order bias. It does not remove time, temperature, warm-up,");
    L.push("  or workload-drift confounding, so localization remains descriptive and");
    L.push("  receives no exchangeability-based p-value.");
  } else {
    L.push("- A complete validated isolated interleaved schedule identity is unavailable.");
    L.push("  Legacy CPU-major batches confound CPU identity with time, temperature,");
    L.push("  and workload drift; no randomized/interleaved ordering is inferred.");
  }
  L.push("- Attempt rates use attempts, not wall-clock exposure. A SIGSEGV can end an");
  L.push("  attempt earlier than a successful completion, so failure-duration bias");
  L.push("  makes elapsed-time or hazard comparisons inappropriate without a separate");
  L.push("  time-to-event design.");
  L.push("- `scaling_cur_freq` is a kernel-reported scaling-frequency snapshot,");
  L.push("  not a true effective busy-frequency measurement; it may differ materially");
  L.push("  on intel_pstate/HWP systems. The method is recorded per measurement.");
  L.push("- Telemetry is sampled rather than continuous in the analog sense: short");
  L.push("  frequency or temperature peaks can occur between polls. A recorded");
  L.push("  `no_turbo=0` means turbo was permitted, not that turbo was continuously used.");
  L.push("  Telemetry never upgrades incomplete workload evidence or identifies cause.");
  L.push("- This workload is an unusually effective trigger, not a proof of");
  L.push("  root cause. Absence of reproduction here does not clear hardware.");
  L.push("");
  return `${L.join("\n")}\n`;
}

function renderConclusions(r) {
  const C = [];

  // 1. Did it reproduce at all?
  let totalSig = 0;
  let totalOther = 0;
  let totalUnclassified = 0;
  let totalRuns = 0;
  let hasIncompleteReproEvidence = false;
  let hasInvalidCountEvidence = false;
  let hasInvalidBaselineEnvelope = false;
  const baselineEvidenceStatus = r.baselineStatus?.status ?? (r.baseline ? "legacy-unvalidated" : "not-run");
  const groupsEvidenceStatus = r.groupsStatus?.status ?? (r.groups?.length ? "legacy-unvalidated" : "not-run");
  const pinnedEvidenceStatus = r.pinnedConcurrentStatus?.status ?? (r.pinnedConcurrent ? "legacy-unvalidated" : "not-run");
  const addAggregate = (sigsegv, other, unclassified, runs) => {
    if (sigsegv > Number.MAX_SAFE_INTEGER - totalSig ||
        other > Number.MAX_SAFE_INTEGER - totalOther ||
        unclassified > Number.MAX_SAFE_INTEGER - totalUnclassified ||
        runs > Number.MAX_SAFE_INTEGER - totalRuns) return false;
    totalSig += sigsegv;
    totalOther += other;
    totalUnclassified += unclassified;
    totalRuns += runs;
    return true;
  };
  if (r.baseline) {
    if (baselineEvidenceStatus !== "complete") {
      hasIncompleteReproEvidence = true;
      hasInvalidBaselineEnvelope = baselineEvidenceStatus === "invalid";
    } else if (validReproCounts(r.baseline) && hasCompleteReproWaveCoverage(r.baseline)) {
      const added = addAggregate(
        r.baseline.sigsegvCount,
        r.baseline.otherFailureCount ?? 0,
        r.baseline.unclassifiedFailureCount ?? 0,
        r.baseline.totalChildInvocations,
      );
      if (!added) hasInvalidCountEvidence = true;
      if (added && !canSupportCleanReproConclusion(r.baseline)) hasIncompleteReproEvidence = true;
    } else if (validReproCounts(r.baseline)) {
      hasIncompleteReproEvidence = true;
    } else {
      hasInvalidCountEvidence = true;
    }
  } else if (r.baselineStatus?.status === "invalid") {
    hasInvalidBaselineEnvelope = true;
    hasIncompleteReproEvidence = true;
  }
  if (groupsEvidenceStatus !== "complete" && groupsEvidenceStatus !== "not-run") {
    hasIncompleteReproEvidence = true;
  }
  for (const g of groupsEvidenceStatus === "complete" ? (r.groups ?? []) : []) {
    if (validReproCounts(g) && hasCompleteReproWaveCoverage(g)) {
      const added = addAggregate(
        g.sigsegvCount ?? 0,
        g.otherFailureCount ?? 0,
        g.unclassifiedFailureCount ?? 0,
        g.totalChildInvocations,
      );
      if (!added) hasInvalidCountEvidence = true;
      if (added && !canSupportCleanReproConclusion(g)) hasIncompleteReproEvidence = true;
    } else if (validReproCounts(g)) {
      hasIncompleteReproEvidence = true;
    } else {
      hasInvalidCountEvidence = true;
    }
  }
  for (const c of r.individualStatus?.status === "complete" ? (r.individual ?? []) : []) {
    if (validIndividualCountsForStatus(r.individualStatus, c)) {
      const v6 = r.individualStatus?.metadataVersion === "6";
      if (!addAggregate(
        c.sigsegv,
        v6 ? c.otherWorkloadFailures : 0,
        0,
        v6 ? c.observations : c.runs,
      )) hasInvalidCountEvidence = true;
    } else {
      hasInvalidCountEvidence = true;
    }
  }
  if ((r.individual?.length ?? 0) > 0 && r.individualStatus?.status !== "complete") {
    hasIncompleteReproEvidence = true;
  }
  if (pinnedEvidenceIsAuthoritative(r)) {
    for (const c of r.pinnedConcurrent.perCpu) {
      if (!addAggregate(c.sigsegv, 0, 0, c.runs)) hasInvalidCountEvidence = true;
    }
  } else if (pinnedEvidenceStatus === "complete") {
    if (!validPinnedSummary(r.pinnedConcurrent)) hasInvalidCountEvidence = true;
    hasIncompleteReproEvidence = true;
  } else if (r.pinnedConcurrent) {
    hasIncompleteReproEvidence = true;
  }
  if (validCapturedGdb(r.gdb)) {
    if (!addAggregate(r.gdb.capturedRuns, 0, 0, r.gdb.cleanRuns + r.gdb.capturedRuns)) {
      hasInvalidCountEvidence = true;
    }
  } else if (validNoFaultGdb(r.gdb) && r.gdb.cleanRuns > 0) {
    if (!addAggregate(0, 0, 0, r.gdb.cleanRuns)) hasInvalidCountEvidence = true;
  } else if (r.gdb?.status === "captured" || r.gdb?.status === "no-fault") {
    hasIncompleteReproEvidence = true;
  }
  if (totalSig > 0) {
    const unresolved = totalUnclassified > 0 ? ` Another ${totalUnclassified} failure(s) were visible only in wave summaries and could not be classified.` : "";
    const other = totalOther > 0
      ? ` Another ${totalOther} non-SIGSEGV workload failure(s) are reported separately and do not count toward that endpoint.`
      : "";
    C.push(`- **The problem reproduced**: ${totalSig} SIGSEGV(s) across ${totalRuns} child-process runs in this diagnostic session.${other}${unresolved}`);
  } else if (totalOther > 0 || totalUnclassified > 0) {
    C.push(`- Workload failures occurred across ${totalRuns} child-process runs, but none were confirmed as SIGSEGV (${totalOther} classified other failure(s), ${totalUnclassified} unclassified summary-only failure(s)).`);
  } else if (totalRuns > 0 && !hasIncompleteReproEvidence) {
    C.push(`- **No failure reproduced** across ${totalRuns} child-process observations spanning different phases/configurations. No pooled rate bound is valid across these heterogeneous strata; use the phase-, group-, and CPU-specific bounds above. This does not rule out the defect; see Limitations.`);
  } else if (totalRuns > 0) {
    C.push(`- No failure was observed in ${totalRuns} accepted child-process observations, but partial, structurally inconsistent, unresolved, or legacy repro evidence prevents a no-failure conclusion or rate bound.`);
  } else if (hasInvalidCountEvidence) {
    C.push("- No trustworthy workload reproduction conclusion is available because impossible failure-count evidence was excluded.");
  } else if (hasIncompleteReproEvidence) {
    C.push("- No complete validated workload result is available. Preserved incomplete, structurally inconsistent, or legacy rows are descriptive only and cannot support a reproduction or no-failure conclusion.");
  } else {
    C.push("- No workload results were collected.");
  }
  if (hasInvalidCountEvidence && totalRuns > 0) {
    C.push("- **Invalid failure-count evidence was excluded** from aggregate reproduction and localization conclusions.");
  }
  if (hasInvalidBaselineEnvelope) {
    C.push("- **Invalid baseline evidence was excluded** from reproduction, zero-failure rate, and configuration conclusions; see phase 2 for the preserved descriptive evidence and validation reasons.");
  } else if (baselineEvidenceStatus !== "complete" && baselineEvidenceStatus !== "not-run") {
    C.push("- **Incomplete or legacy baseline evidence was excluded** from reproduction and zero-failure rate conclusions; see phase 2 for its descriptive rows.");
  }
  if (groupsEvidenceStatus !== "complete" && groupsEvidenceStatus !== "not-run") {
    C.push("- **Incomplete or invalid CPU-group evidence was excluded** from reproduction and group-localization conclusions; see phase 3 for validation reasons.");
  }
  if (pinnedEvidenceStatus === "unavailable") {
    C.push("- **Pinned-concurrent was unavailable** because the validated topology had no safe controller CPU outside an active context. No workload ran in phase 5, so this status is not reproduction or no-failure evidence.");
  } else if (pinnedEvidenceStatus !== "complete" && pinnedEvidenceStatus !== "not-run") {
    C.push("- **Incomplete, invalid, or legacy pinned-concurrent evidence was excluded** from reproduction and exact-CPU concurrent-localization conclusions; see phase 5 for validation reasons.");
  } else if (pinnedEvidenceStatus === "complete" && !pinnedEvidenceIsAuthoritative(r)) {
    C.push("- **Unauthoritative or inconsistent pinned-concurrent summary evidence was excluded** from reproduction, rate-bound, and localization conclusions; see phase 5.");
  }

  // 2. Localization to CPUs / groups. Even the position-balanced schedule
  // does not make CPU labels exchangeable with temporal or thermal state.
  // Keep these contrasts descriptive; do not attach a localization p-value.
  const testedCpus = r.individualStatus?.status === "complete"
    ? (r.individual ?? []).filter((c) =>
      validIndividualPrimaryCountsForStatus(r.individualStatus, c))
    : [];
  const failingCpus = testedCpus.filter((c) => c.sigsegv > 0);
  const cleanCpus = testedCpus.filter((c) => c.sigsegv === 0);
  if (failingCpus.length > 0) {
    let line = `- **Single-process per-CPU screen (this run only)**: failures observed on CPU(s) ${failingCpus.map((c) => `${c.cpu} at ${c.sigsegv}/${c.runs}`).join(", ")}`;
    if (cleanCpus.length > 0) {
      let cleanN = 0;
      let cleanNSafe = true;
      for (const cpu of cleanCpus) {
        if (cpu.runs > Number.MAX_SAFE_INTEGER - cleanN) {
          cleanNSafe = false;
          break;
        }
        cleanN += cpu.runs;
      }
      line += cleanNSafe
        ? `; zero on the other ${cleanCpus.length} tested CPU(s) at 0/${cleanN}`
        : `; zero on the other ${cleanCpus.length} tested CPU(s), whose pooled run count exceeds the safe integer range (use the per-CPU table)`;
    } else if (testedCpus.length > 1) {
      line += "; every other tested CPU also observed at least one failure";
    }
    line += testedCpus.length > 1
      ? individualUsesInterleavedProtocol(r.individualStatus)
        ? ". These zeros do not supersede prior sessions or explain shared-mask group failures. The seeded position-balanced interleaving reduces order bias but does not remove temporal or thermal confounding, so localization is descriptive"
        : ". These zeros do not supersede prior sessions or explain shared-mask group failures. A validated interleaving identity is unavailable, so localization is descriptive and no order-balance claim is made"
      : ". Only one CPU was tested, so no cross-CPU comparison is possible";
    C.push(`${line}.`);
  } else if (testedCpus.length > 0) {
    C.push(`- Single-process per-CPU screen (this run only): no SIGSEGVs observed on any tested CPU. These zeros do not supersede prior sessions or explain shared-mask group results; ${individualUsesInterleavedProtocol(r.individualStatus) ? "the position-balanced schedule reduces order bias but does not remove temporal or thermal confounding" : "a complete validated interleaved ordering identity is unavailable"}, so per-CPU results remain descriptive.`);
  }
  const conclusionGroups = groupsEvidenceStatus === "complete" ? (r.groups ?? []) : [];
  const failingGroups = conclusionGroups.filter(
    (g) => validReproCounts(g) && (g.sigsegvCount ?? 0) > 0,
  );
  const cleanGroups = conclusionGroups.filter(
    (g) =>
      validReproCounts(g) &&
      canSupportCleanReproConclusion(g) &&
      (g.sigsegvCount ?? 0) === 0 &&
      (g.otherFailureCount ?? 0) === 0 &&
      (g.unclassifiedFailureCount ?? 0) === 0 &&
      (g.totalChildInvocations ?? 0) > 0,
  );
  const unresolvedGroups = conclusionGroups.filter(
    (g) => validReproCounts(g) && (g.sigsegvCount ?? 0) === 0 &&
      (!canSupportCleanReproConclusion(g) ||
        (g.otherFailureCount ?? 0) > 0 || (g.unclassifiedFailureCount ?? 0) > 0),
  );
  if (failingGroups.length > 0) {
    C.push(`- **Shared-affinity group exposure**: SIGSEGV in group(s) ${failingGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}; no failures observed in group(s): ${cleanGroups.length > 0 ? cleanGroups.map((g) => `${g.name} (${g.cpus})`).join(", ") : "none"}${unresolvedGroups.length > 0 ? `; no zero-failure conclusion for: ${unresolvedGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}` : ""}. Group rows do not identify the faulting CPU because children may migrate within each mask.`);
  }

  const pinnedSummaryValid = pinnedEvidenceIsAuthoritative(r);
  const pinnedCpus = pinnedSummaryValid ? r.pinnedConcurrent.perCpu : [];
  const failingPinnedCpus = pinnedCpus.filter((cpu) => cpu.sigsegv > 0);
  if (failingPinnedCpus.length > 0) {
    C.push(`- **Exact-CPU pinned-concurrent exposure**: SIGSEGV on ${failingPinnedCpus.map((cpu) => `${cpu.context ?? cpu.group}/CPU ${cpu.cpu} at ${cpu.sigsegv}/${cpu.runs}`).join(", ")}. These are exact child-to-CPU attributions within their named contexts; shared-mask group rows above are not.`);
  } else if (pinnedCpus.length > 0) {
    C.push("- Exact-CPU pinned-concurrent screen: no SIGSEGV was observed in any validated context/CPU stratum. Use the separate per-context bounds above; contexts and CPUs are not pooled, and this does not rule out intermittent failure.");
  }

  // 3. Frequency effect: each turbo-on leg must independently pass the
  // prespecified directional comparison against turbo-off. Pooling cannot
  // rescue a failed reversal, and any invalid run disables inference.
  if (r.frequencyAbStatus?.status === "complete" && r.frequencyAb) {
    const fa = r.frequencyAb;
    const fx = analyzeFrequencyAb(fa);
    if (!fx.valid) {
      C.push(`- Frequency A/B/A inference is unavailable because ${fx.issues.join("; ")}; leg counts are descriptive only and support no reduction or suppression claim.`);
    } else if (fx.replicatedReduction && fx.bF === 0) {
      C.push(`- **Frequency-associated zero observed failures during turbo-off**: A1 ${fx.a1F}/${fx.a1.runs}, B 0/${fx.bN}, A2 ${fx.a2F}/${fx.a2.runs}; replicated directional Fisher gate p = ${fx.replicatedP.toExponential(2)}. This means no failures were observed in the sampled B leg, not that its true rate is zero. The sequential, non-randomized design supports an association in this session but does not by itself establish frequency as causal or exclude time/order confounding.`);
    } else if (fx.replicatedReduction) {
      C.push(`- **Frequency-associated replicated reduction**: A1 ${fx.a1F}/${fx.a1.runs}, B ${fx.bF}/${fx.bN}, A2 ${fx.a2F}/${fx.a2.runs}; replicated directional Fisher gate p = ${fx.replicatedP.toExponential(2)}. Failures persisted in B, so this is not complete suppression. The sequential, non-randomized design supports an association in this session but does not by itself establish frequency as causal or exclude time/order confounding.`);
    } else if (!fx.a1Directional || !fx.a2Directional) {
      C.push(`- Frequency A/B/A: the prespecified reduction direction was not observed in both A-vs-B comparisons (one-sided p1=${fx.pA1GreaterB.toExponential(2)}, p2=${fx.pA2GreaterB.toExponential(2)}); the reversal gate failed and no reduction or suppression claim is made.`);
    } else {
      C.push(`- Frequency A/B/A: both point estimates favored fewer failures in B, but the replicated directional Fisher gate did not pass (p1=${fx.pA1GreaterB.toExponential(2)}, p2=${fx.pA2GreaterB.toExponential(2)}, max=${fx.replicatedP.toExponential(2)}; each must be <0.05). No reduction or suppression claim is made.`);
    }
  } else if (r.frequencyAb || r.frequencyAbStatus?.status === "incomplete" ||
      r.frequencyAbStatus?.status === "invalid") {
    C.push("- Frequency dependence was not analyzed because the manual A/B/A artifacts are incomplete or restoration was not verified.");
  } else {
    C.push("- Frequency dependence was not tested (requires the manual `sudo ./frequency-ab.sh` step).");
  }

  // 4. GDB signature
  if (r.gdb?.status === "captured") {
    // Only "known-signature" captures are verified: the +2^42 arithmetic
    // matched, the intended address was mapped+writable, and si_addr was
    // explicitly absent from the parsed mappings.
    const known = r.gdb.captures.filter((c) => c.classification === "known-signature");
    const unverified = r.gdb.captures.filter((c) => c.classification === "bit-flip-unverified");
    const manual = r.gdb.captures.filter(
      (c) => c.classification !== "known-signature" && c.classification !== "bit-flip-unverified",
    );
    if (known.length === r.gdb.captures.length) {
      C.push(`- **Fault signature matches the documented pattern**: ${known.length} capture(s), each with a mapped/writable intended address and an unmapped fault address at intended + 2^42 (single differing bit 42).`);
    } else {
      const parts = [];
      if (known.length > 0) {
        parts.push(`${known.length} capture(s) match the documented pattern: mapped/writable intended address plus an unmapped fault address at intended + 2^42`);
      }
      if (unverified.length > 0) {
        parts.push(`${unverified.length} capture(s) match the +2^42 arithmetic but do not verify every signature precondition (explicit si_addr provenance, intended mapped/writable, and shifted address unmapped; see phase 7), so they are NOT confirmed signature matches`);
      }
      if (manual.length > 0) {
        parts.push(`${manual.length} capture(s) need manual classification (see phase 7)`);
      }
      if (known.length > 0) {
        C.push(`- Fault signature: ${parts.join("; ")}.`);
      } else if (unverified.length > 0) {
        C.push(`- **Fault signature NOT confirmed**: ${parts.join("; ")}. Matching bit-flip arithmetic without both mapping checks is not the documented signature; do not assume the previously reported root cause.`);
      } else {
        C.push(`- **Fault signature does NOT match** the documented +2^42 pattern; ${manual.length} capture(s) preserved for manual classification. Do not assume the previously reported root cause.`);
      }
    }
  } else if (r.gdb?.status === "no-fault") {
    const bound = r.gdb.countsAvailable
      ? ` (95% upper bound ${pct(zeroFailureUpperBound(r.gdb.cleanRuns))} per completed no-fault attempt; n=${r.gdb.cleanRuns})`
      : " (legacy result: no-fault-attempt denominator unavailable, so no bound)";
    C.push(`- GDB capture ran to its limit without observing a fault${bound}; no fresh signature was obtained.`);
  } else if (r.gdb?.status === "failed") {
    C.push("- GDB capture failed operationally; it provides neither a no-fault bound nor a signature conclusion.");
  } else if (r.gdb?.status === "incomplete") {
    C.push("- GDB artifacts are incomplete and were excluded from signature conclusions.");
  }

  // 5. What remains uncertain. Preflight environment values are deliberately
  // absent from conclusions: they are point snapshots, not proof of the state
  // during later workload phases.
  const uncertain = [];
  if (cleanCpus.length > 0) {
    const weakest = cleanCpus.reduce((m, c) => Math.min(m, c.runs), Number.POSITIVE_INFINITY);
    uncertain.push(`zero-failure CPU samples are statistical only (smallest sample ${weakest} runs has a nominal pointwise 95% upper bound of ${pct(zeroFailureUpperBound(weakest))} under an independence/stationarity working assumption)`);
  }
  if (!r.frequencyAb) uncertain.push("frequency dependence untested (manual: sudo ./frequency-ab.sh)");
  if (r.gdb?.status !== "captured") uncertain.push("no fresh GDB signature captured");
  if (uncertain.length > 0) {
    C.push(`- Remaining uncertainty: ${uncertain.join("; ")}.`);
  }

  if (C.length === 0) C.push("- Insufficient data for any conclusion.");
  return C;
}

export function writeReport(outDir, options = {}) {
  const resultsFile = options.resultsFile ?? path.join(outDir, "results.json");
  const outputFile = options.outputFile ?? path.join(outDir, "report.md");
  const exclusiveOutput = options.exclusiveOutput === true;
  let readinessPathPresent = false;
  if (options.outputFile === undefined) {
    try {
      lstatSync(path.join(outDir, "manifest.txt"));
      readinessPathPresent = true;
    } catch (error) {
      readinessPathPresent = error?.code !== "ENOENT";
    }
  }
  if (readinessPathPresent) {
    throw new Error(
      "refusing to overwrite report.md in a manifested bundle; " +
      "resume with diagnose.sh so readiness is revoked and republished, or use explicit input/output paths",
    );
  }
  if (!existsSync(resultsFile)) {
    throw new Error(`${resultsFile} not found; run collect.mjs first`);
  }
  const results = JSON.parse(readFileSync(resultsFile, "utf8"));
  const md = renderReport(results);
  writeFileSync(
    outputFile,
    md,
    exclusiveOutput ? { flag: "wx", mode: 0o600 } : undefined,
  );
  return md;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  const resultsFile = process.argv[3];
  const outputFile = process.argv[4];
  const hasExplicitPaths = process.argv.length === 5;
  if (!outDir || (process.argv.length !== 3 && !hasExplicitPaths) ||
    (hasExplicitPaths && (!resultsFile || !outputFile))) {
    console.error("usage: node report.mjs <out-dir> [results-input output-path]");
    process.exit(2);
  }
  writeReport(outDir, hasExplicitPaths
    ? { resultsFile, outputFile, exclusiveOutput: true }
    : undefined);
  console.log(`wrote ${hasExplicitPaths ? "explicit report output" : "report.md"}`);
}
