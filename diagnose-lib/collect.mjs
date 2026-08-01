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

// Summarize a frequency sample file written by the sysfs sampler
// ("epoch cpu khz" lines). Returns null when the file is missing or uses
// a different method. Only CPUs in cpuFilter (Set of numbers) count when
// the filter is provided.
function summarizeFreqSamples(outDir, tag, cpuFilter = null) {
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
    // Best effort: average the Avg_MHz column of turbostat --Summary rows.
    const mhz = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\d+(?:\.\d+)?)\s/);
      if (m) mhz.push(Number(m[1]));
    }
    summary.note = "turbostat raw output retained; Avg_MHz parsed best-effort";
    if (mhz.length > 0) {
      summary.avgMHz = Math.round((mhz.reduce((a, b) => a + b, 0) / mhz.length) * 100) / 100;
      summary.maxMHz = Math.max(...mhz);
      summary.samples = mhz.length;
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

function collectIndividual(rows) {
  const byCpu = new Map();
  for (const row of rows) {
    const [cpuS, runS, rcS, elapsedS] = row;
    const cpu = Number(cpuS);
    const rc = Number(rcS);
    if (!byCpu.has(cpu)) {
      byCpu.set(cpu, { cpu, runs: 0, failures: 0, sigsegv: 0, otherFailures: 0, launchErrors: 0, failedRuns: [] });
    }
    const rec = byCpu.get(cpu);
    rec.runs += 1;
    if (rc === 0) continue;
    // 126/127 = launch failure of taskset/node itself, not a workload failure.
    if (rc === 126 || rc === 127) {
      rec.launchErrors += 1;
      rec.runs -= 1; // not a valid observation
      continue;
    }
    rec.failures += 1;
    const sig = signalFromRc(rc);
    if (sig === "SIGSEGV") rec.sigsegv += 1;
    else rec.otherFailures += 1;
    rec.failedRuns.push({ run: Number(runS), rc, signal: sig ?? `exit ${rc}`, elapsedSec: num(elapsedS) });
  }
  return [...byCpu.values()].sort((a, b) => a.cpu - b.cpu);
}

function collectFreqAb(outDir, rows, meta) {
  const legs = new Map();
  for (const row of rows) {
    const [leg, runS, rcS, elapsedS] = row;
    if (!legs.has(leg)) legs.set(leg, { leg, runs: 0, failures: 0, sigsegv: 0, otherFailures: 0, failedRuns: [] });
    const rec = legs.get(leg);
    const rc = Number(rcS);
    if (rc === 126 || rc === 127) continue;
    rec.runs += 1;
    if (rc !== 0) {
      rec.failures += 1;
      const sig = signalFromRc(rc);
      if (sig === "SIGSEGV") rec.sigsegv += 1;
      else rec.otherFailures += 1;
      rec.failedRuns.push({ run: Number(runS), rc, signal: sig ?? `exit ${rc}`, elapsedSec: num(elapsedS) });
    }
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

export function collect(outDir) {
  const meta = readKeyValues(path.join(outDir, "results", "meta.env"));
  const envSummary = readKeyValues(path.join(outDir, "env", "summary.env"));
  const resultsDir = path.join(outDir, "results");

  const results = {
    schemaVersion: 1,
    outDir,
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
          completedWaves: parsed.completedWaves,
          failedWaves: parsed.failedWaves,
          totalChildInvocations: parsed.totalChildInvocations,
          sigsegvCount: parsed.sigsegvCount,
          otherFailureCount: parsed.otherFailureCount,
          firstFailureAfterSec: parsed.firstFailureAfterSec,
          durationSec: parsed.durationSec,
          failures: parsed.failures,
        });
      }
      results.groups.push(entry);
    }
  }

  // --- individual ---
  const individualRows = readTsv(path.join(resultsDir, "individual.tsv"));
  if (individualRows.length > 0) {
    results.individual = collectIndividual(individualRows);
    const worst = results.individual
      .filter((r) => r.runs > 0)
      .sort((a, b) => b.failures / b.runs - a.failures / a.runs || b.failures - a.failures || a.cpu - b.cpu)[0];
    results.worstCpu = worst ? worst.cpu : null;
  } else {
    results.worstCpu = null;
  }

  // --- frequency A/B/A ---
  const freqAbRows = readTsv(path.join(resultsDir, "frequency-ab.tsv"));
  const freqAbMeta = readKeyValues(path.join(resultsDir, "frequency-ab.meta"));
  if (freqAbRows.length > 0) {
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
  if (gdbMeta.CPU !== undefined || existsSync(gdbDir)) {
    const captures = [];
    if (existsSync(gdbDir)) {
      for (const f of readdirSync(gdbDir).sort()) {
        if (!f.endsWith(".txt")) continue;
        const rel = path.join("gdb", f);
        const parsed = parseGdbCapture(readFileSync(path.join(outDir, rel), "utf8"));
        if (!parsed.captured) continue; // clean-run transcripts carry no signature
        // Full mappings stay in the raw transcript; keep the JSON compact.
        parsed.mappings = undefined;
        parsed.file = rel;
        captures.push(parsed);
      }
    }
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
      cpu: num(gdbMeta.CPU),
      maxRuns: num(gdbMeta.MAX_RUNS),
      exitCode: num(gdbMeta.EXIT_CODE),
      skipped: gdbMeta.SKIPPED === "1",
      skipReason: gdbMeta.SKIP_REASON ?? null,
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
  console.log(`wrote ${path.join(outDir, "results.json")}`);
}
