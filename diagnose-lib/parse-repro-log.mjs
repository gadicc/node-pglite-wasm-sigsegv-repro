// parse-repro-log.mjs - parse repro.mjs output into a JSON summary.
//
// Understands both plain repro output and lines prefixed with
// "<epoch>\t" by the diagnose.sh timestamping filter. Usage:
//   node parse-repro-log.mjs <log-file>
// or import { parseReproLog } from this module.

import { readFileSync } from "node:fs";

export function parseReproLog(text) {
  const lines = text.split("\n");
  const out = {
    node: null,
    v8: null,
    children: null,
    requestedWaves: null,
    completedWaves: 0,
    failedWaves: 0,
    waves: [], // { wave, passed, of }
    failures: [], // { wave, child, code, signal, elapsedMs }
    totalChildInvocations: 0,
    sigsegvCount: 0,
    otherFailureCount: 0,
    firstFailureAfterSec: null, // requires epoch-prefixed log
    durationSec: null, // requires epoch-prefixed log
    finalLine: null,
  };

  let currentWave = 0;
  let firstEpoch = null;
  let lastEpoch = null;
  let firstFailureEpoch = null;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    let epoch = null;
    let line = rawLine;
    const tsMatch = rawLine.match(/^(\d{9,})\t(.*)$/);
    if (tsMatch) {
      epoch = Number(tsMatch[1]);
      line = tsMatch[2];
      if (firstEpoch === null) firstEpoch = epoch;
      lastEpoch = epoch;
    }

    let m = line.match(
      /^node=(\S+) v8=(\S+) platform=\S+ arch=\S+ children=(\d+) waves=(\d+)/,
    );
    if (m) {
      out.node = m[1];
      out.v8 = m[2];
      out.children = Number(m[3]);
      out.requestedWaves = Number(m[4]);
      continue;
    }

    m = line.match(/^wave=(\d+) passed=(\d+)\/(\d+)/);
    if (m) {
      currentWave = Number(m[1]);
      out.waves.push({
        wave: currentWave,
        passed: Number(m[2]),
        of: Number(m[3]),
      });
      continue;
    }

    m = line.match(
      /^child=(\d+) code=(\S+) signal=(\S+) elapsedMs=(\d+)/,
    );
    if (m) {
      const failure = {
        wave: currentWave,
        child: Number(m[1]),
        code: m[2] === "null" ? null : Number(m[2]),
        signal: m[3] === "null" ? null : m[3],
        elapsedMs: Number(m[4]),
      };
      out.failures.push(failure);
      if (failure.signal === "SIGSEGV") {
        out.sigsegvCount += 1;
      } else {
        out.otherFailureCount += 1;
      }
      if (epoch !== null && firstFailureEpoch === null) {
        firstFailureEpoch = epoch;
      }
      continue;
    }

    m = line.match(
      /^failedWaves=(\d+) completedWaves=(\d+) requestedWaves=(\d+)/,
    );
    if (m) {
      out.finalLine = line;
      out.failedWaves = Number(m[1]);
      out.completedWaves = Number(m[2]);
      out.requestedWaves = Number(m[3]);
      continue;
    }
  }

  if (out.children !== null) {
    out.totalChildInvocations = out.completedWaves * out.children;
  }
  if (firstEpoch !== null && lastEpoch !== null) {
    out.durationSec = lastEpoch - firstEpoch;
  }
  if (firstEpoch !== null && firstFailureEpoch !== null) {
    out.firstFailureAfterSec = firstFailureEpoch - firstEpoch;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node parse-repro-log.mjs <log-file>");
    process.exit(2);
  }
  console.log(JSON.stringify(parseReproLog(readFileSync(file, "utf8")), null, 2));
}
