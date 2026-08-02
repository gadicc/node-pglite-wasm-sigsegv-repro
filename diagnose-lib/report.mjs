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
  fisherExact2x2,
  binomZeroProbability,
  permutationCpuTest,
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

function ci(failures, n) {
  if (!n) return "—";
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
  if (!n) return "no valid runs";
  if (failures === 0) return `0/${n} (95% upper ${zeroBound(n)})`;
  return `${failures}/${n} = ${pct(failures / n)} ${ci(failures, n)}`;
}

export function renderReport(results) {
  const r = results;
  const L = [];
  const env = r.environment ?? {};
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
  L.push("Service tags, serial numbers, UUIDs, and MAC addresses were");
  L.push("deliberately not collected. See `env/` for the raw sanitized files.");
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
    ["TME state (best effort)", env.TME_STATE],
    ["Power source at preflight", env.POWER_SOURCE],
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
    L.push(`${b.children} concurrent children per wave, STOP_ON_FAILURE=0.`);
    L.push("");
    if (b.partial) {
      L.push("**The baseline log has no completion footer (the run was");
      L.push("interrupted); wave counts below were recovered from per-wave");
      L.push("rows and are partial data, not a completed run.**");
      L.push("");
    }
    L.push("| Metric | Value |");
    L.push("| --- | --- |");
    L.push(`| Waves | ${b.processedWaves ?? b.completedWaves}/${b.requestedWaves} processed, ${b.failedWaves} failed${b.partial ? " (log truncated; partial data)" : ""} |`);
    L.push(`| Child invocations | ${b.totalChildInvocations} |`);
    L.push(`| SIGSEGV | ${b.sigsegvCount} |`);
    L.push(`| Other failures | ${b.otherFailureCount} |`);
    if ((b.unclassifiedFailureCount ?? 0) > 0) L.push(`| Unclassified failures (summary only) | ${b.unclassifiedFailureCount} |`);
    L.push(`| Child failure rate | ${statsCell(b.sigsegvCount + b.otherFailureCount + (b.unclassifiedFailureCount ?? 0), b.totalChildInvocations)} |`);
    L.push(`| Time to first failure | ${fmtSec(b.firstFailureAfterSec)} |`);
    L.push(`| Duration | ${fmtSec(b.durationSec)} |`);
    L.push(`| Frequency (${b.frequency?.method ?? "n/a"}) | avg ${fmtMHz(b.frequency?.avgMHz)}, max ${fmtMHz(b.frequency?.maxMHz)} |`);
    L.push("");
    L.push(`Raw log: \`${b.log}\`. Wave-level failures are kept distinct from`);
    L.push("individual child-process failures throughout this report.");
    L.push("");
  } else {
    L.push("Not run (or no data collected).\n");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 3: CPU-group isolation");
  L.push("");
  if (r.groups?.length) {
    L.push("Groups were discovered from sysfs topology, not hardcoded.");
    L.push("");
    L.push("| Group | CPUs | Children | Waves | Child failures | Rate / 95% CI | Eff. freq (avg/max) |");
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const g of r.groups) {
      const f = g.sigsegvCount + (g.otherFailureCount ?? 0) + (g.unclassifiedFailureCount ?? 0);
      const n = g.totalChildInvocations ?? 0;
      L.push(
        `| ${g.name} | ${g.cpus} | ${g.children} | ${g.processedWaves ?? g.completedWaves ?? "?"}/${g.wavesRequested} processed (${g.failedWaves ?? "?"} failed)${g.partial ? " (log truncated; partial data)" : ""} | ${f}/${n}${(g.unclassifiedFailureCount ?? 0) > 0 ? ` (${g.unclassifiedFailureCount} unclassified)` : ""} | ${n ? `${pct(f / n)} ${ci(f, n)}` : "—"} | ${fmtMHz(g.frequency?.avgMHz)} / ${fmtMHz(g.frequency?.maxMHz)} |`,
      );
    }
    L.push("");
  } else {
    L.push("Not run (or no data collected).\n");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 4: individual CPU isolation");
  L.push("");
  if (r.individual?.length) {
    L.push("One child process pinned to one logical CPU per run.");
    L.push("A CPU with zero failures is **not** proven good; the 95% upper");
    L.push("bound shows which per-run failure rates its sample excludes.");
    L.push("");
    L.push("| CPU | Runs | Failures | Rate / bound | Notes |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const c of r.individual) {
      const notes = [];
      if (c.cpu === r.worstCpu && c.failures > 0) notes.push("highest observed rate");
      if (c.invalidRuns?.length > 0) notes.push(`${c.invalidRuns.length} invalid run(s) excluded (non-SIGSEGV exits)`);
      if (c.failedRuns?.length) {
        notes.push(`failed runs: ${c.failedRuns.map((f) => `#${f.run} (${f.signal})`).join(", ")}`);
      }
      L.push(
        `| ${c.cpu} | ${c.runs} | ${c.failures} | ${statsCell(c.failures, c.runs)} | ${notes.join("; ") || "—"} |`,
      );
    }
    L.push("");
  } else {
    L.push("Not run (or no data collected).\n");
  }

  // ------------------------------------------------------------------
  L.push("## Phase 5: controlled frequency A/B/A");
  L.push("");
  if (r.frequencyAb) {
    const fa = r.frequencyAb;
    L.push(`Test CPU: ${fa.cpu} (highest observed failure rate). Original`);
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
    const aLegs = fa.legs.filter((l) => l.noTurbo === 0);
    const bLegs = fa.legs.filter((l) => l.noTurbo === 1);
    const aF = aLegs.reduce((s, l) => s + l.sigsegv, 0);
    const aN = aLegs.reduce((s, l) => s + l.runs, 0);
    const bF = bLegs.reduce((s, l) => s + l.sigsegv, 0);
    const bN = bLegs.reduce((s, l) => s + l.runs, 0);
    const invalid = fa.legs.reduce((s, l) => s + (l.invalidRuns?.length ?? 0), 0);
    if (aN > 0 && bN > 0) {
      const p = fisherExact2x2(aF, aN - aF, bF, bN - bF);
      L.push(`Fisher exact test on SIGSEGV counts over valid runs, turbo-on legs (${aF}/${aN}) vs turbo-off leg (${bF}/${bN}): two-sided p = ${p.toExponential(2)}.${invalid > 0 ? ` ${invalid} invalid run(s) excluded (non-SIGSEGV exits).` : ""}`);
      if (bF === 0 && aF > 0) {
        const assumed = aF / aN;
        L.push(``);
        L.push(`Separately, *assuming a fixed per-run baseline rate equal to the pooled turbo-on rate* (${pct(assumed)}), the probability of observing 0/${bN} under turbo-off is ${binomZeroProbability(bN, assumed).toExponential(2)} (binomial, assumption stated, not a confidence statement).`);
      }
      L.push("");
    }
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
  }

  // ------------------------------------------------------------------
  L.push("## Phase 6: GDB fault signature");
  L.push("");
  if (r.gdb?.status === "captured") {
    const g = r.gdb;
    L.push(`Fault captured on CPU ${g.cpu} (pinned by taskset, so the faulting CPU is known by construction).`);
    L.push("");
    L.push("| Capture | Instruction | Intended addr | si_addr | Diff | Differing bits | Intended mapped/writable | Classification |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const c of g.captures) {
      L.push(
        `| \`${c.file}\` | \`${c.instruction ?? "?"}\` | ${c.intendedAddr ?? "—"} | ${c.siAddr ?? "—"} | ${c.addrDiffHex ?? "—"} | ${c.diffBits?.length ? c.diffBits.join(",") : "—"} | ${c.intendedMapped === null ? "—" : `${c.intendedMapped}/${c.intendedWritable}`} | ${c.classification} |`,
      );
    }
    L.push("");
    if (g.captures.length > 1) {
      L.push(`Multiple-capture comparison: material fields (instruction, intended address, si_addr, differing bits) are ${g.capturesIdentical ? "**identical** across captures" : "**NOT identical** across captures"}.`);
      L.push("");
    }
  } else if (r.gdb?.status === "no-fault") {
    L.push(`Ran ${r.gdb.maxRuns ?? "the configured number of"} pinned attempt(s) on CPU ${r.gdb.cpu ?? "—"} without capturing a fault.`);
    if (r.gdb.maxRuns > 0) L.push(`The zero-failure 95% upper bound per attempt is ${pct(zeroFailureUpperBound(r.gdb.maxRuns))}; this does not disprove the defect.`);
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
  L.push("  CPU/group only excludes rates above its 95% upper bound");
  L.push("  (1 - 0.05^(1/n); approximately 3/n for large n).");
  L.push("- Observed failure rates can drift between batches; comparisons use");
  L.push("  exact tests on paired batches where possible, but small samples");
  L.push("  remain weak evidence.");
  L.push("- The clean-CPU contrast behind CPU localization is a permutation");
  L.push("  test across all tested CPUs (chi-square statistic, fixed seed), not");
  L.push("  a Fisher test on a post-hoc failing-vs-clean grouping — that");
  L.push("  grouping is defined by the outcomes, so testing it would separate");
  L.push("  by construction.");
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
  if (r.baseline) {
    totalSig += r.baseline.sigsegvCount;
    totalOther += r.baseline.otherFailureCount ?? 0;
    totalUnclassified += r.baseline.unclassifiedFailureCount ?? 0;
    totalRuns += r.baseline.totalChildInvocations;
  }
  for (const g of r.groups ?? []) {
    totalSig += g.sigsegvCount ?? 0;
    totalOther += g.otherFailureCount ?? 0;
    totalUnclassified += g.unclassifiedFailureCount ?? 0;
    totalRuns += g.totalChildInvocations ?? 0;
  }
  for (const c of r.individual ?? []) {
    totalSig += c.sigsegv;
    totalRuns += c.runs;
  }
  if (totalSig > 0) {
    const unresolved = totalUnclassified > 0 ? ` Another ${totalUnclassified} failure(s) were visible only in wave summaries and could not be classified.` : "";
    C.push(`- **The problem reproduced**: ${totalSig} SIGSEGV(s) across ${totalRuns} child-process runs in this diagnostic session.${unresolved}`);
  } else if (totalOther > 0 || totalUnclassified > 0) {
    C.push(`- Workload failures occurred across ${totalRuns} child-process runs, but none were confirmed as SIGSEGV (${totalOther} classified other failure(s), ${totalUnclassified} unclassified summary-only failure(s)).`);
  } else if (totalRuns > 0) {
    C.push(`- **No failure reproduced** in ${totalRuns} child-process runs (95% upper bound on the pooled per-run rate: ${pct(zeroFailureUpperBound(totalRuns))}). This does not rule out the defect; see Limitations.`);
  } else {
    C.push("- No workload results were collected.");
  }

  // 2. Localization to CPUs / groups. The statistical claim is an omnibus
  // permutation test across ALL tested CPUs — never a Fisher test on a
  // failing-vs-clean partition defined after seeing the outcomes, which
  // would separate by construction and ignore the CPU search multiplicity.
  const testedCpus = (r.individual ?? []).filter((c) => c.runs > 0);
  const failingCpus = testedCpus.filter((c) => c.sigsegv > 0);
  const cleanCpus = testedCpus.filter((c) => c.sigsegv === 0);
  if (failingCpus.length > 0) {
    let line = `- **CPU localization**: failures observed on CPU(s) ${failingCpus.map((c) => `${c.cpu} at ${c.sigsegv}/${c.runs}`).join(", ")}`;
    if (cleanCpus.length > 0) {
      const cleanN = cleanCpus.reduce((s, c) => s + c.runs, 0);
      line += `; zero on the other ${cleanCpus.length} tested CPU(s) at 0/${cleanN}`;
    } else if (testedCpus.length > 1) {
      line += "; every other tested CPU also observed at least one failure";
    }
    if (testedCpus.length > 1) {
      const perm = permutationCpuTest(testedCpus.map((c) => ({ failures: c.sigsegv, runs: c.runs })));
      line += `. Permutation test across all ${testedCpus.length} tested CPUs (chi-square statistic, ${perm.iterations} seeded shuffles): p = ${perm.p.toExponential(2)}`;
    } else {
      line += ". Only one CPU was tested, so no cross-CPU concentration test is possible";
    }
    C.push(`${line}.`);
  } else if (testedCpus.length > 0) {
    C.push("- CPU localization: no failures observed on any tested CPU; the cross-CPU concentration test is not applicable (zero total failures).");
  }
  const failingGroups = (r.groups ?? []).filter((g) => (g.sigsegvCount ?? 0) > 0);
  const cleanGroups = (r.groups ?? []).filter(
    (g) =>
      (g.sigsegvCount ?? 0) === 0 &&
      (g.otherFailureCount ?? 0) === 0 &&
      (g.unclassifiedFailureCount ?? 0) === 0 &&
      (g.totalChildInvocations ?? 0) > 0,
  );
  const unresolvedGroups = (r.groups ?? []).filter(
    (g) => (g.sigsegvCount ?? 0) === 0 && ((g.otherFailureCount ?? 0) > 0 || (g.unclassifiedFailureCount ?? 0) > 0),
  );
  if (failingGroups.length > 0) {
    C.push(`- **Group isolation**: SIGSEGV in group(s) ${failingGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}; clean group(s): ${cleanGroups.length > 0 ? cleanGroups.map((g) => `${g.name} (${g.cpus})`).join(", ") : "none"}${unresolvedGroups.length > 0 ? `; unresolved non-SIGSEGV/unclassified failures in: ${unresolvedGroups.map((g) => `${g.name} (${g.cpus})`).join(", ")}` : ""}.`);
  }

  // 3. Frequency effect: the prespecified two-group contrast (turbo-on vs
  // turbo-off) uses SIGSEGV counts over valid runs only; non-SIGSEGV exits
  // are invalid runs and never enter the test.
  if (r.frequencyAb) {
    const fa = r.frequencyAb;
    const aLegs = fa.legs.filter((l) => l.noTurbo === 0);
    const bLegs = fa.legs.filter((l) => l.noTurbo === 1);
    const aF = aLegs.reduce((s, l) => s + l.sigsegv, 0);
    const aN = aLegs.reduce((s, l) => s + l.runs, 0);
    const bF = bLegs.reduce((s, l) => s + l.sigsegv, 0);
    const bN = bLegs.reduce((s, l) => s + l.runs, 0);
    const invalid = fa.legs.reduce((s, l) => s + (l.invalidRuns?.length ?? 0), 0);
    const invalidNote = invalid > 0 ? ` ${invalid} invalid run(s) excluded (non-SIGSEGV exits).` : "";
    if (aN > 0 && bN > 0) {
      const p = fisherExact2x2(aF, aN - aF, bF, bN - bF);
      if (aF > 0 && bF === 0 && p < 0.05) {
        C.push(`- **Frequency dependence**: turbo-on legs produced SIGSEGV in ${aF}/${aN} valid runs while the turbo-off leg was clean (0/${bN}); Fisher exact p = ${p.toExponential(2)}. Lower frequency suppressed the failure in this session, consistent with a frequency/voltage margin rather than hard logic.${invalidNote}`);
      } else if (aF === 0 && bF === 0) {
        C.push(`- Frequency A/B/A: no failures in any leg; the test is uninformative for frequency dependence (the defect did not reproduce at baseline during the legs).${invalidNote}`);
      } else if (bF > 0) {
        C.push(`- Frequency A/B/A: SIGSEGV occurred even with turbo disabled (${bF}/${bN} vs ${aF}/${aN} valid runs with turbo on; Fisher exact p = ${p.toExponential(2)}). Downclocking alone did not suppress the failure in this session.${invalidNote}`);
      } else {
        C.push(`- Frequency A/B/A: turbo-on ${aF}/${aN}, turbo-off ${bF}/${bN} (SIGSEGV over valid runs); Fisher exact p = ${p.toExponential(2)} — inconclusive at this sample size.${invalidNote}`);
      }
    }
  } else if (r.frequencyAbStatus?.status === "incomplete") {
    C.push("- Frequency dependence was not analyzed because the manual A/B/A artifacts are incomplete or restoration was not verified.");
  } else {
    C.push("- Frequency dependence was not tested (requires the manual `sudo ./frequency-ab.sh` step).");
  }

  // 4. GDB signature
  if (r.gdb?.status === "captured") {
    // Only "known-signature" captures are verified: the +2^42 arithmetic
    // matched AND the intended address was evidenced as mapped+writable.
    const known = r.gdb.captures.filter((c) => c.classification === "known-signature");
    const unverified = r.gdb.captures.filter((c) => c.classification === "bit-flip-unverified");
    const manual = r.gdb.captures.filter(
      (c) => c.classification !== "known-signature" && c.classification !== "bit-flip-unverified",
    );
    if (known.length === r.gdb.captures.length) {
      C.push(`- **Fault signature matches the documented pattern**: ${known.length} capture(s), each an intended valid address reported by the kernel as intended + 2^42 (single differing bit 42).`);
    } else {
      const parts = [];
      if (known.length > 0) {
        parts.push(`${known.length} capture(s) match the documented pattern: an intended valid (mapped and writable) address reported by the kernel as intended + 2^42`);
      }
      if (unverified.length > 0) {
        parts.push(`${unverified.length} capture(s) match the +2^42 arithmetic but their intended addresses could not be verified as mapped and writable (see phase 6), so they are NOT confirmed signature matches`);
      }
      if (manual.length > 0) {
        parts.push(`${manual.length} capture(s) need manual classification (see phase 6)`);
      }
      if (known.length > 0) {
        C.push(`- Fault signature: ${parts.join("; ")}.`);
      } else if (unverified.length > 0) {
        C.push(`- **Fault signature NOT confirmed**: ${parts.join("; ")}. Matching bit-flip arithmetic without address-validity evidence is not the documented signature; do not assume the previously reported root cause.`);
      } else {
        C.push(`- **Fault signature does NOT match** the documented +2^42 pattern; ${manual.length} capture(s) preserved for manual classification. Do not assume the previously reported root cause.`);
      }
    }
  } else if (r.gdb?.status === "no-fault") {
    const bound = r.gdb.maxRuns > 0 ? ` (95% upper bound ${pct(zeroFailureUpperBound(r.gdb.maxRuns))} per attempt)` : "";
    C.push(`- GDB capture ran to its limit without observing a fault${bound}; no fresh signature was obtained.`);
  } else if (r.gdb?.status === "failed") {
    C.push("- GDB capture failed operationally; it provides neither a no-fault bound nor a signature conclusion.");
  } else if (r.gdb?.status === "incomplete") {
    C.push("- GDB artifacts are incomplete and were excluded from signature conclusions.");
  }

  // 5. Configuration-based rule-outs
  const env = r.environment ?? {};
  const reproduced = totalSig > 0;
  if (reproduced && /disabled/i.test(env.TME_STATE ?? "")) {
    C.push(`- TME/MKTME is not required for the failure: TME state is \"${env.TME_STATE}\" and the problem still reproduced.`);
  }
  if (reproduced && /battery/i.test(env.POWER_SOURCE ?? "")) {
    C.push("- External power delivery is not required: the problem reproduced while running on battery.");
  }
  if (reproduced && env.NO_TURBO === "1") {
    C.push("- The failure reproduced even though intel_pstate/no_turbo was already 1 at preflight time.");
  }
  if (reproduced && env.UNDERVOLT_STATE && !/unavailable|not installed/i.test(env.UNDERVOLT_STATE)) {
    C.push(`- Undervolting state: ${env.UNDERVOLT_STATE}.`);
  }

  // 6. What remains uncertain
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
  console.log(`wrote ${path.join(outDir, "report.md")}`);
}
