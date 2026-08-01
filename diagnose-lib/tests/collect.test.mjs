import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeFreqSamples } from "../collect.mjs";

// Representative capture from `turbostat --quiet --interval 1` (no --Summary):
// the header repeats every interval, the "- -" row is the whole-system
// summary, CPU 1 is offline ("-" cells), and the busy CPU 2 runs at a higher
// Bzy_MHz than the mostly-idle CPU 0. Note Avg_MHz for CPU 2 (2600/2700)
// differs from its Bzy_MHz (3000), so tests can tell the columns apart.
const PER_CPU_SAMPLES = `Core CPU Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ
- - 1133 37.78 2873 2900 520
0 0 250 10.00 2500 2900 100
0 1 - - - 2900 0
0 2 2600 86.67 3000 2900 420
Core CPU Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ
- - 1200 40.00 2901 2900 560
0 0 300 12.00 2500 2900 120
0 1 - - - 2900 0
0 2 2700 90.00 3000 2900 450
`;

// Capture from the old `turbostat --Summary --quiet --interval 1` sampler:
// one whole-system row per interval and no CPU column (CPU%c1 is a different
// column name and must not be mistaken for it).
const LEGACY_SUMMARY_SAMPLES = `Avg_MHz Busy% Bzy_MHz TSC_MHz IRQ CPU%c1
1133 37.78 2873 2900 520 20.00
1200 40.00 2901 2900 560 18.50
`;

const tmpDirs = [];
function writeCapture(samples, method = "turbostat") {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "freq"));
  writeFileSync(path.join(dir, "freq", "exp.samples"), samples);
  writeFileSync(path.join(dir, "freq", "exp.method"), `${method}\n`);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("summarizeFreqSamples: turbostat per-CPU Bzy_MHz honors cpuFilter", () => {
  const dir = writeCapture(PER_CPU_SAMPLES);
  const pinned = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(pinned.method, "turbostat");
  assert.equal(pinned.samples, 2);
  // Bzy_MHz only: Avg_MHz (2600/2700) would average to 2650.
  assert.equal(pinned.avgMHz, 3000);
  assert.equal(pinned.maxMHz, 3000);
  assert.match(pinned.note, /per-CPU Bzy_MHz/);

  const idle = summarizeFreqSamples(dir, "exp", new Set([0]));
  assert.equal(idle.samples, 2);
  assert.equal(idle.avgMHz, 2500);
  assert.equal(idle.maxMHz, 2500);
});

test("summarizeFreqSamples: turbostat per-CPU aggregates all CPUs without a filter", () => {
  const dir = writeCapture(PER_CPU_SAMPLES);
  const all = summarizeFreqSamples(dir, "exp");
  // CPU 0 and CPU 2 rows only: the "- -" summary rows and the offline
  // CPU 1 rows are skipped.
  assert.equal(all.samples, 4);
  assert.equal(all.avgMHz, 2750);
  assert.equal(all.maxMHz, 3000);
});

test("summarizeFreqSamples: legacy turbostat --Summary capture falls back with whole-system note", () => {
  const dir = writeCapture(LEGACY_SUMMARY_SAMPLES);
  const legacy = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(legacy.samples, 2);
  assert.equal(legacy.avgMHz, 1166.5);
  assert.equal(legacy.maxMHz, 1200);
  assert.match(legacy.note, /whole-system summary/);
  assert.match(legacy.note, /not the pinned CPU/);
});

test("summarizeFreqSamples: missing samples file is reported unavailable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-test-"));
  tmpDirs.push(dir);
  const missing = summarizeFreqSamples(dir, "exp", new Set([2]));
  assert.equal(missing.available, false);
  assert.equal(missing.samples, undefined);
});
