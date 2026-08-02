// report.mjs - render results.json into report.md.
//
// Usage: node report.mjs <out-dir>
//
// Every conclusion is derived from the counts in results.json at render
// time. Nothing about the repository's previously documented findings is
// assumed: if a run does not reproduce, localize, or match the known
// signature, the report says so.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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
  if (r.rootChecks) {
    L.push("### Privileged reads (manual `root-checks.sh`)");
    L.push("");
    L.push("Collected separately and read-only by a user-reviewed sudo run;");
    L.push("diagnose.sh itself never elevates privileges.");
    L.push("");
    const caps = { "kernel-warnings.txt": 40, "cctk.txt": 30, "intel-undervolt.txt": 30, "turbostat.txt": 20 };
    for (const [file, text] of Object.entries(r.rootChecks)) {
      if (file.endsWith(".meta")) continue;
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
  }

  // ------------------------------------------------------------------
  L.push("## Phase 2: baseline reproduction");
  L.push("");
  if (r.baseline) {
    const b = r.baseline;
    const envelopeStatus = r.baselineStatus?.status ?? b.envelopeStatus ?? "complete";
    const failureCount = reproFailureCount(b);
    const completionStatus = reproCompletionStatus(b);
    L.push(`${b.children} concurrent children per wave, STOP_ON_FAILURE=0.`);
    L.push("");
    if (envelopeStatus !== "complete") {
      L.push(`**The baseline evidence envelope is ${envelopeStatus}. Its safely parsed`);
      L.push("wave rows are shown descriptively but are excluded from reproduction and clean-rate conclusions.**");
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
      L.push("cannot support a clean conclusion or a rate bound.**");
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
    L.push(`| SIGSEGV | ${b.sigsegvCount ?? "invalid/missing"} |`);
    L.push(`| Other failures | ${b.otherFailureCount} |`);
    if ((b.unclassifiedFailureCount ?? 0) > 0) L.push(`| Unclassified failures (summary only) | ${b.unclassifiedFailureCount} |`);
    L.push(`| Child failures (descriptive only) | ${failureCount === null ? "invalid/missing" : `${failureCount}/${b.totalChildInvocations}`} |`);
    L.push(`| SIGSEGV-positive waves | ${validReproWaveCounts(b) ? b.sigsegvWaveCount : "invalid/missing"} |`);
    L.push(`| Unresolved SIGSEGV endpoint waves | ${validReproWaveCounts(b) ? b.sigsegvUnresolvedWaveCount : "invalid/missing"} |`);
    L.push(`| SIGSEGV wave rate / 95% CI | ${reproWaveStatsCell(b)} |`);
    L.push(`| Time to first failure | ${fmtSec(b.firstFailureAfterSec)} |`);
    L.push(`| Duration | ${fmtSec(b.durationSec)} |`);
    L.push(`| Frequency (${b.frequency?.method ?? "n/a"}) | avg ${fmtMHz(b.frequency?.avgMHz)}, max ${fmtMHz(b.frequency?.maxMHz)} |`);
    L.push("");
    L.push(`Raw log: \`${b.log}\`. Concurrent children within a wave are correlated,`);
    L.push("so child-process counts are descriptive and the interval treats resolved");
    L.push("sequential waves as the trials. That interval assumes those waves are");
    L.push("independent and stationary.");
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
  const groupsStatus = r.groupsStatus?.status ?? (r.groups?.length ? "complete" : "not-run");
  if (groupsStatus !== "complete" && groupsStatus !== "not-run") {
    L.push(`**CPU-group evidence envelope: ${groupsStatus}.** Its rows and logs are`);
    L.push("excluded from aggregate reproduction and group-localization conclusions.");
    for (const reason of r.groupsStatus?.reasons ?? []) L.push(`- ${reason}`);
    L.push("");
  }
  if (groupsStatus === "complete" && r.groups?.length) {
    L.push("Groups were discovered from sysfs topology, not hardcoded.");
    L.push("");
    L.push("| Group | CPUs | Children | Waves | Child failures (descriptive) | SIGSEGV waves / resolved-wave rate (95% CI) | Unresolved waves | Eff. freq (avg/max) |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const g of r.groups) {
      const f = reproFailureCount(g);
      const n = g.totalChildInvocations ?? 0;
      const completionStatus = reproCompletionStatus(g);
      const statusNote = completionStatus === "partial"
        ? " (log truncated; partial data)"
        : completionStatus === "inconsistent" ? " (structurally inconsistent; descriptive only)" : "";
      const waveCountsValid = validReproWaveCounts(g);
      L.push(
        `| ${g.name} | ${g.cpus} | ${g.children} | ${g.processedWaves ?? g.completedWaves ?? "?"}/${g.wavesRequested} processed (${g.failedWaves ?? "?"} failed)${statusNote} | ${f ?? "invalid"}/${n}${(g.unclassifiedFailureCount ?? 0) > 0 ? ` (${g.unclassifiedFailureCount} unclassified)` : ""} | ${reproWaveStatsCell(g)} | ${waveCountsValid ? g.sigsegvUnresolvedWaveCount : "invalid/missing"} | ${fmtMHz(g.frequency?.avgMHz)} / ${fmtMHz(g.frequency?.maxMHz)} |`,
      );
    }
    L.push("");
    L.push("Resolved-wave intervals assume sequential waves are independent and");
    L.push("stationary. Rates from groups with different children-per-wave are not");
    L.push("directly comparable because the chance of at least one SIGSEGV changes");
    L.push("with the number of concurrent children.");
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
    L.push("One child process pinned to one logical CPU per run. CPU batches");
    L.push("run sequentially, so localization is descriptive/exploratory and");
    L.push("may be confounded by time or thermal drift.");
    L.push("A CPU with zero failures is **not** proven good; the 95% upper");
    L.push("bound shows which per-run failure rates its sample excludes.");
    L.push("");
    L.push("| CPU | Runs | Failures | Rate / bound | Notes |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const c of r.individual) {
      const notes = [];
      const countsValid = validIndividualCounts(c);
      if (!countsValid) notes.push("inconsistent failure counts; excluded from conclusions");
      if (countsValid && individualComplete && c.cpu === r.worstCpu && c.failures > 0) notes.push("highest observed rate");
      if (c.invalidRuns?.length > 0) notes.push(`${c.invalidRuns.length} invalid run(s) excluded (non-SIGSEGV exits)`);
      if (c.failedRuns?.length) {
        notes.push(`failed runs: ${c.failedRuns.map((f) => `#${f.run} (${f.signal})`).join(", ")}`);
      }
      L.push(
        `| ${c.cpu} | ${c.runs} | ${c.failures} | ${countsValid ? statsCell(c.failures, c.runs) : "invalid/inconsistent counts; no interval"} | ${notes.join("; ") || "—"} |`,
      );
    }
    L.push("");
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
  L.push("## Phase 5: controlled frequency A/B/A");
  L.push("");
  if (r.frequencyAb) {
    const fa = r.frequencyAb;
    const selectionNote = r.cpuSelectionStatus?.policy === "fixed"
      ? "fixed by the stored CPU selection policy"
      : "highest observed individual failure rate";
    L.push(`Test CPU: ${fa.cpu} (${selectionNote}). Original`);
    L.push(`settings saved first; restored after the phase: ${fa.restored ? "yes" : "**NO — check intel_pstate/no_turbo and scaling_max_freq**"}.`);
    L.push("");
    L.push("Failures are SIGSEGV (exit 139) only; any other nonzero exit is an");
    L.push("invalid run, excluded from the run counts below.");
    L.push("");
    L.push("| Leg | no_turbo | scaling_max_freq | Valid runs | SIGSEGV | Rate / bound | Eff. freq (avg/max) |");
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const leg of fa.legs) {
      const inv = leg.invalidRuns?.length ?? 0;
      L.push(
        `| ${leg.leg} | ${leg.noTurbo ?? "—"} | ${leg.scalingMaxKhz ? `${Math.round(leg.scalingMaxKhz / 1000)} MHz` : "—"} | ${leg.runs} | ${leg.failures}${inv > 0 ? ` (+${inv} invalid excluded)` : ""} | ${statsCell(leg.failures, leg.runs)} | ${fmtMHz(leg.frequency?.avgMHz)} / ${fmtMHz(leg.frequency?.maxMHz)} |`,
      );
    }
    L.push("");
    const fx = analyzeFrequencyAb(fa);
    if (!fx.valid) {
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
      L.push(`- ${leg.leg}: ${statsCell(leg.failures, leg.runs)}, measured avg ${fmtMHz(leg.frequency?.avgMHz)}, max ${fmtMHz(leg.frequency?.maxMHz)}`);
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
  L.push("## Phase 6: GDB fault signature");
  L.push("");
  if (r.gdb?.status === "captured") {
    const g = r.gdb;
    L.push(`Fault captured on CPU ${g.cpu} (pinned by taskset, so the faulting CPU is known by construction).`);
    if (g.countsAvailable) {
      L.push(`Attempt accounting: ${g.attemptedRuns} attempted, ${g.cleanRuns} clean, ${g.capturedRuns} captured, and ${g.errorRuns} runner error(s).`);
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
      L.push(`Ran ${r.gdb.attemptedRuns} pinned attempt(s) on CPU ${r.gdb.cpu ?? "—"}: ${r.gdb.cleanRuns} clean and ${r.gdb.errorRuns} runner error(s), with no captured fault.`);
      L.push(`Using only the ${r.gdb.cleanRuns} clean attempt(s), the zero-failure 95% upper bound per attempt is ${pct(zeroFailureUpperBound(r.gdb.cleanRuns))}; this does not disprove the defect.`);
    } else {
      L.push(`The legacy GDB result reports no captured fault on CPU ${r.gdb.cpu ?? "—"}, but per-attempt clean/error accounting is unavailable.`);
      L.push("No zero-failure bound is calculated because the number of successfully executed clean attempts is unknown.");
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
  L.push("- Zero observed failures never prove a zero failure rate. A clean");
  L.push("  CPU or resolved-wave sample only excludes rates above its 95% upper bound");
  L.push("  (1 - 0.05^(1/n); approximately 3/n for large n).");
  L.push("- Observed failure rates can drift between batches; comparisons use");
  L.push("  exact tests on paired batches where possible, but small samples");
  L.push("  remain weak evidence.");
  L.push("- Per-CPU batches run sequentially in CPU-number order. CPU identity");
  L.push("  is therefore confounded with time, temperature, and workload drift;");
  L.push("  localization is descriptive and no exchangeability-based p-value is");
  L.push("  reported. Confirm candidates with a randomized/interleaved design.");
  L.push("- `scaling_cur_freq` under reports effective clocks on some");
  L.push("  intel_pstate/HWP systems; when available, turbostat samples are");
  L.push("  preferred and the method is recorded per measurement.");
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
  const groupsEvidenceStatus = r.groupsStatus?.status ?? (r.groups?.length ? "complete" : "not-run");
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
    const envelopeStatus = r.baselineStatus?.status ?? r.baseline.envelopeStatus ?? "complete";
    if (envelopeStatus !== "complete") {
      hasIncompleteReproEvidence = true;
      hasInvalidBaselineEnvelope = envelopeStatus === "invalid";
    } else if (validReproCounts(r.baseline)) {
      const added = addAggregate(
        r.baseline.sigsegvCount,
        r.baseline.otherFailureCount ?? 0,
        r.baseline.unclassifiedFailureCount ?? 0,
        r.baseline.totalChildInvocations,
      );
      if (!added) hasInvalidCountEvidence = true;
      if (added && !canSupportCleanReproConclusion(r.baseline)) hasIncompleteReproEvidence = true;
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
    if (validReproCounts(g)) {
      const added = addAggregate(
        g.sigsegvCount ?? 0,
        g.otherFailureCount ?? 0,
        g.unclassifiedFailureCount ?? 0,
        g.totalChildInvocations,
      );
      if (!added) hasInvalidCountEvidence = true;
      if (added && !canSupportCleanReproConclusion(g)) hasIncompleteReproEvidence = true;
    } else {
      hasInvalidCountEvidence = true;
    }
  }
  for (const c of r.individual ?? []) {
    if (validIndividualCounts(c)) {
      if (!addAggregate(c.sigsegv, 0, 0, c.runs)) hasInvalidCountEvidence = true;
    } else {
      hasInvalidCountEvidence = true;
    }
  }
  if ((r.individual?.length ?? 0) > 0 && r.individualStatus?.status !== "complete") {
    hasIncompleteReproEvidence = true;
  }
  if (totalSig > 0) {
    const unresolved = totalUnclassified > 0 ? ` Another ${totalUnclassified} failure(s) were visible only in wave summaries and could not be classified.` : "";
    C.push(`- **The problem reproduced**: ${totalSig} SIGSEGV(s) across ${totalRuns} child-process runs in this diagnostic session.${unresolved}`);
  } else if (totalOther > 0 || totalUnclassified > 0) {
    C.push(`- Workload failures occurred across ${totalRuns} child-process runs, but none were confirmed as SIGSEGV (${totalOther} classified other failure(s), ${totalUnclassified} unclassified summary-only failure(s)).`);
  } else if (totalRuns > 0 && !hasIncompleteReproEvidence) {
    C.push(`- **No failure reproduced** across ${totalRuns} child-process observations spanning different phases/configurations. No pooled rate bound is valid across these heterogeneous strata; use the phase-, group-, and CPU-specific bounds above. This does not rule out the defect; see Limitations.`);
  } else if (totalRuns > 0) {
    C.push(`- No failure was observed in ${totalRuns} accepted child-process observations, but partial, structurally inconsistent, unresolved, or legacy repro evidence prevents a clean non-reproduction conclusion or rate bound.`);
  } else if (hasInvalidCountEvidence) {
    C.push("- No trustworthy workload reproduction conclusion is available because impossible failure-count evidence was excluded.");
  } else {
    C.push("- No workload results were collected.");
  }
  if (hasInvalidCountEvidence && totalRuns > 0) {
    C.push("- **Invalid failure-count evidence was excluded** from aggregate reproduction and localization conclusions.");
  }
  if (hasInvalidBaselineEnvelope) {
    C.push("- **Invalid baseline evidence was excluded** from reproduction, clean-rate, and configuration conclusions; see phase 2 for the preserved descriptive evidence and validation reasons.");
  }
  if (groupsEvidenceStatus !== "complete" && groupsEvidenceStatus !== "not-run") {
    C.push("- **Incomplete or invalid CPU-group evidence was excluded** from reproduction and group-localization conclusions; see phase 3 for validation reasons.");
  }

  // 2. Localization to CPUs / groups. Individual CPU batches run in fixed,
  // sequential order, so CPU labels are not exchangeable with respect to
  // temporal/thermal drift. Keep this descriptive; do not attach a p-value.
  const testedCpus = r.individualStatus?.status === "complete"
    ? (r.individual ?? []).filter((c) => validIndividualCounts(c))
    : [];
  const failingCpus = testedCpus.filter((c) => c.sigsegv > 0);
  const cleanCpus = testedCpus.filter((c) => c.sigsegv === 0);
  if (failingCpus.length > 0) {
    let line = `- **CPU localization**: failures observed on CPU(s) ${failingCpus.map((c) => `${c.cpu} at ${c.sigsegv}/${c.runs}`).join(", ")}`;
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
      ? ". This is exploratory localization only because CPU batches were sequential, not randomized or interleaved"
      : ". Only one CPU was tested, so no cross-CPU comparison is possible";
    C.push(`${line}.`);
  } else if (testedCpus.length > 0) {
    C.push("- CPU localization: no failures observed on any tested CPU; sequential per-CPU results remain descriptive only.");
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
    C.push(`- **Group isolation**: SIGSEGV in group(s) ${failingGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}; clean group(s): ${cleanGroups.length > 0 ? cleanGroups.map((g) => `${g.name} (${g.cpus})`).join(", ") : "none"}${unresolvedGroups.length > 0 ? `; no clean group conclusion for: ${unresolvedGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}` : ""}.`);
  }

  // 3. Frequency effect: each turbo-on leg must independently pass the
  // prespecified directional comparison against turbo-off. Pooling cannot
  // rescue a failed reversal, and any invalid run disables inference.
  if (r.frequencyAb) {
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
  } else if (r.frequencyAbStatus?.status === "incomplete") {
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
        parts.push(`${unverified.length} capture(s) match the +2^42 arithmetic but do not verify every signature precondition (explicit si_addr provenance, intended mapped/writable, and shifted address unmapped; see phase 6), so they are NOT confirmed signature matches`);
      }
      if (manual.length > 0) {
        parts.push(`${manual.length} capture(s) need manual classification (see phase 6)`);
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
      ? ` (95% upper bound ${pct(zeroFailureUpperBound(r.gdb.cleanRuns))} per clean attempt; n=${r.gdb.cleanRuns})`
      : " (legacy result: clean-attempt denominator unavailable, so no bound)";
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
    uncertain.push(`clean CPU verdicts are statistical only (smallest sample ${weakest} runs excludes rates above ${pct(zeroFailureUpperBound(weakest))})`);
  }
  if (!r.frequencyAb) uncertain.push("frequency dependence untested (manual: sudo ./frequency-ab.sh)");
  if (r.gdb?.status !== "captured") uncertain.push("no fresh GDB signature captured");
  if (uncertain.length > 0) {
    C.push(`- Remaining uncertainty: ${uncertain.join("; ")}.`);
  }

  if (C.length === 0) C.push("- Insufficient data for any conclusion.");
  return C;
}

export function writeReport(outDir) {
  const resultsFile = path.join(outDir, "results.json");
  if (!existsSync(resultsFile)) {
    throw new Error(`${resultsFile} not found; run collect.mjs first`);
  }
  const results = JSON.parse(readFileSync(resultsFile, "utf8"));
  const md = renderReport(results);
  writeFileSync(path.join(outDir, "report.md"), md);
  return md;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: node report.mjs <out-dir>");
    process.exit(2);
  }
  writeReport(outDir);
  console.log("wrote report.md");
}
