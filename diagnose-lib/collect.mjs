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
//   results/frequency-ab.tsv   leg, run, rc, elapsed
//   results/frequency-ab.meta  leg configuration + restore status
//   results/gdb.meta           gdb phase parameters
//   env/summary.env            sanitized environment headline fields
//   logs/...                   repro output logs (epoch-prefixed)
//   gdb/*.txt                  capture transcripts
//   freq/<tag>.samples         "epoch cpu khz" lines (or raw turbostat)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseReproLog } from "./parse-repro-log.mjs";
import { parseGdbCapture } from "./parse-gdb.mjs";

function readKeyValues(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readTsv(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split("\t"));
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
export function summarizeFreqSamples(outDir, tag, cpuFilter = null) {
  const file = path.join(outDir, "freq", `${tag}.samples`);
  const methodFile = path.join(outDir, "freq", `${tag}.method`);
  const method = existsSync(methodFile)
    ? readFileSync(methodFile, "utf8").trim()
    : null;
  const summary = { tag, method, file: path.relative(outDir, file) };
  if (!existsSync(file)) {
    summary.available = false;
    return summary;
  }
  summary.available = true;
  const text = readFileSync(file, "utf8");
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
      const mhz = [];
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+(?:\.\d+)?)\s/);
        if (m) mhz.push(Number(m[1]));
      }
      summary.note =
        "turbostat --Summary capture; Avg_MHz is a whole-system summary average (includes idle time), not the pinned CPU";
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
        ? summarizeFreqSamples(outDir, `freq-ab-${leg.leg}`, cpu !== null ? new Set([cpu]) : null)
        : null,
    })),
  };
  return result;
}

export function assessFrequencyAb(rows, meta, phaseDone) {
  const hasArtifacts = rows.length > 0 || Object.keys(meta).length > 0 || phaseDone;
  if (!hasArtifacts) return { status: "not-run", reasons: [] };

  const reasons = [];
  if (!phaseDone) reasons.push("phase completion marker is missing");
  if (meta.COMPLETED !== "1") reasons.push("frequency metadata is not marked complete");
  if (meta.RESTORED !== "1") reasons.push("frequency settings are not verified as restored");
  if (
    meta.LEG_A1_NO_TURBO !== "0" ||
    meta.LEG_B_NO_TURBO !== "1" ||
    meta.LEG_A2_NO_TURBO !== "0"
  ) {
    reasons.push("A1/B/A2 frequency modes are missing or inconsistent");
  }

  const runs = Number(meta.RUNS_PER_LEG);
  if (!/^\d+$/.test(meta.RUNS_PER_LEG ?? "") || !Number.isSafeInteger(runs) || runs < 1) {
    reasons.push("RUNS_PER_LEG is missing or invalid");
  } else {
    const counts = { A1: 0, B: 0, A2: 0 };
    const seen = new Set();
    let invalidRow = false;
    for (const row of rows) {
      const [leg, runS, rcS, elapsedS] = row;
      const run = Number(runS);
      const elapsed = Number(elapsedS);
      const valid =
        row.length === 4 &&
        Object.hasOwn(counts, leg) &&
        /^\d+$/.test(runS) &&
        Number.isSafeInteger(run) &&
        run >= 1 &&
        run <= runs &&
        (rcS === "0" || rcS === "139") &&
        /^\d+$/.test(elapsedS) &&
        Number.isSafeInteger(elapsed);
      const key = `${leg}:${runS}`;
      if (!valid || seen.has(key)) {
        invalidRow = true;
        continue;
      }
      seen.add(key);
      counts[leg] += 1;
    }
    if (invalidRow) reasons.push("frequency results contain an invalid or duplicate row");
    if (Object.values(counts).some((count) => count !== runs)) {
      reasons.push("frequency results do not contain every expected A1/B/A2 run");
    }
  }

  return reasons.length > 0 ? { status: "incomplete", reasons } : { status: "complete", reasons: [] };
}

export function assessGdb(meta, phaseDone, captures, transcriptCount) {
  const hasMeta = Object.keys(meta).length > 0;
  if (!hasMeta && !phaseDone && transcriptCount === 0) {
    return { status: "not-run", reason: null };
  }
  if (meta.SKIPPED === "1") {
    if (!phaseDone) return { status: "incomplete", reason: "skip metadata has no phase completion marker" };
    if (captures.length > 0) return { status: "incomplete", reason: "skip metadata conflicts with captured faults" };
    return { status: "skipped", reason: meta.SKIP_REASON ?? null };
  }

  const exitCode = num(meta.EXIT_CODE);
  if (exitCode !== null && exitCode !== 0 && exitCode !== 3) {
    return { status: "failed", reason: `capture runner exited with code ${exitCode}` };
  }
  if (!phaseDone) {
    return { status: "incomplete", reason: "phase completion marker is missing" };
  }
  if (exitCode === 0 && captures.length > 0) return { status: "captured", reason: null };
  if (exitCode === 0) {
    return { status: "incomplete", reason: "runner reported a capture but no fault transcript was parsed" };
  }
  if (exitCode === 3 && captures.length === 0) return { status: "no-fault", reason: null };
  if (exitCode === 3) {
    return { status: "incomplete", reason: "no-fault exit code conflicts with captured faults" };
  }
  return { status: "incomplete", reason: "GDB metadata has no terminal exit code" };
}

export function collect(outDir) {
  const meta = readKeyValues(path.join(outDir, "results", "meta.env"));
  const envSummary = readKeyValues(path.join(outDir, "env", "summary.env"));
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
      baselineChildren: num(meta.BASELINE_CHILDREN),
      baselineWaves: num(meta.BASELINE_WAVES),
      groupWaves: num(meta.GROUP_WAVES),
      individualRuns: num(meta.INDIVIDUAL_RUNS),
      gdbMaxRuns: num(meta.GDB_MAX_RUNS),
      frequencyAb: meta.FREQUENCY_AB === "1",
      skipGdb: meta.SKIP_GDB === "1",
      completedPhases: (meta.COMPLETED_PHASES ?? "").split(",").filter(Boolean),
      interrupted: meta.INTERRUPTED === "1",
    },
    environment: envSummary,
  };

  // Optional privileged reads produced by a manual `sudo ./root-checks.sh
  // <bundle>` run (kept separate from diagnose.sh, which never elevates).
  const rootDir = path.join(outDir, "env", "root");
  if (existsSync(rootDir)) {
    const rootReads = {};
    for (const f of readdirSync(rootDir).sort()) {
      if (f.endsWith(".txt") || f.endsWith(".meta")) {
        rootReads[f] = readFileSync(path.join(rootDir, f), "utf8").trim();
      }
    }
    if (Object.keys(rootReads).length > 0) results.rootChecks = rootReads;
  }

  // --- baseline ---
  const baselineMeta = readKeyValues(path.join(resultsDir, "baseline.meta"));
  if (baselineMeta.LOG) {
    const logPath = path.join(outDir, baselineMeta.LOG);
    if (existsSync(logPath)) {
      const parsed = parseReproLog(readFileSync(logPath, "utf8"));
      results.baseline = {
        ...parsed,
        waves: undefined, // per-wave detail stays in the raw log
        log: baselineMeta.LOG,
        exitCode: num(baselineMeta.EXIT_CODE),
        frequency: summarizeFreqSamples(outDir, "baseline"),
      };
    }
  }

  // --- groups ---
  const groupRows = readTsv(path.join(resultsDir, "groups.tsv"));
  if (groupRows.length > 0) {
    results.groups = [];
    for (const row of groupRows) {
      const [name, kind, cpus, clusterId, childrenS, wavesS, logRel, freqTag, exitCodeS] = row;
      const entry = {
        name,
        kind,
        cpus,
        clusterId: clusterId === "-" ? null : num(clusterId),
        children: num(childrenS),
        wavesRequested: num(wavesS),
        log: logRel,
        exitCode: num(exitCodeS),
        frequency: summarizeFreqSamples(outDir, freqTag, cpuSetFromList(cpus)),
      };
      const logPath = path.join(outDir, logRel);
      if (existsSync(logPath)) {
        const parsed = parseReproLog(readFileSync(logPath, "utf8"));
        Object.assign(entry, {
          processedWaves: parsed.processedWaves,
          completedWaves: parsed.completedWaves,
          fullyPassedWaves: parsed.fullyPassedWaves,
          failedWaves: parsed.failedWaves,
          totalChildInvocations: parsed.totalChildInvocations,
          sigsegvCount: parsed.sigsegvCount,
          otherFailureCount: parsed.otherFailureCount,
          unclassifiedFailureCount: parsed.unclassifiedFailureCount,
          firstFailureAfterSec: parsed.firstFailureAfterSec,
          durationSec: parsed.durationSec,
          failures: parsed.failures,
          partial: parsed.partial,
        });
      }
      results.groups.push(entry);
    }
  }

  // --- individual ---
  const individualRows = readTsv(path.join(resultsDir, "individual.tsv"));
  if (individualRows.length > 0) {
    results.individual = collectIndividual(individualRows);
    // Rank by the SIGSEGV endpoint over valid runs (ties: more SIGSEGVs,
    // then lower CPU number); invalid runs are already excluded from `runs`.
    const worst = results.individual
      .filter((r) => r.runs > 0)
      .sort((a, b) => b.sigsegv / b.runs - a.sigsegv / a.runs || b.sigsegv - a.sigsegv || a.cpu - b.cpu)[0];
    results.worstCpu = worst ? worst.cpu : null;
  } else {
    results.worstCpu = null;
  }

  // --- frequency A/B/A ---
  const freqAbRows = readTsv(path.join(resultsDir, "frequency-ab.tsv"));
  const freqAbMeta = readKeyValues(path.join(resultsDir, "frequency-ab.meta"));
  results.frequencyAbStatus = assessFrequencyAb(
    freqAbRows,
    freqAbMeta,
    existsSync(path.join(outDir, "state", "phase-frequency.done")),
  );
  if (results.frequencyAbStatus.status === "complete") {
    results.frequencyAb = collectFreqAb(outDir, freqAbRows, freqAbMeta);
  }

  // --- optional per-CPU frequency cap experiment ---
  const capRows = readTsv(path.join(resultsDir, "frequency-cap.tsv"));
  const capMeta = readKeyValues(path.join(resultsDir, "frequency-cap.meta"));
  if (capRows.length > 0) {
    results.frequencyCap = {
      cpu: num(capMeta.CPU),
      requestedCapKhz: num(capMeta.CAP_KHZ),
      restored: capMeta.RESTORED === "1",
      note: "intel_pstate/HWP does not guarantee scaling_max_freq strictly clamps the effective clock; compare with measured samples",
      ...collectFreqAb(outDir, capRows, capMeta),
    };
  }

  // --- gdb ---
  const gdbMeta = readKeyValues(path.join(resultsDir, "gdb.meta"));
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
