import { test } from "node:test";
import assert from "node:assert/strict";

import { associateTelemetryRuns } from "../telemetry-association.mjs";

const generation = "a".repeat(32);
const digest = "b".repeat(64);

function metadata() {
  return {
    monotonic_origin_ns: "1000000000",
    discovery: {
      cpus: [{ cpu: 8, package: 0, die: 0, core: 4, scaling_cur_freq: "/sys/cpu8/freq" }],
      temperature_targets: {
        packages: [{ package: 0, sensor: "coretemp:0:package:0" }],
        cores: [{ package: 0, die: 0, die_state: "known", core: 4, logical_cpus: [8], sensor: "coretemp:0:core:4" }],
      },
    },
  };
}

function sample(monotonic, frequency, core, packageTemperature) {
  return {
    monotonic_ns: String(monotonic),
    read_duration_ns: "1000000",
    scaling_cur_freq_khz: [[8, frequency]],
    core_temperature_millicelsius: [[0, 0, 4, core]],
    package_temperature_millicelsius: [[0, packageTemperature]],
  };
}

function assessment() {
  return {
    status: "complete",
    meta: { GENERATION: "c".repeat(32), INTERVAL_MS: "250" },
    segments: [{
      segment: 1,
      intervalMs: 250,
      coverage: { status: "complete", maximumAllowedGapNs: "1000000000" },
      boundary: {
        start: { monotonicNs: "1000000000", unixMs: 1_000 },
        end: { monotonicNs: "5000000000", unixMs: 5_000 },
      },
      metadata: metadata(),
      samples: [
        sample(100_000_000, 4_000_000, 70_000, 72_000),
        sample(350_000_000, 4_500_000, 75_000, 77_000),
        sample(600_000_000, 5_000_000, 80_000, 82_000),
        sample(850_000_000, 4_800_000, 78_000, 80_000),
      ],
    }],
  };
}

test("joins sweep intervals to pass/failure outcomes without duration weighting", () => {
  const joined = associateTelemetryRuns({
    telemetryAssessment: assessment(),
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 2,
    workloadBindingReconciled: true,
    runs: [
      { ordinal: 1, cpu: 8, outcome: "sigsegv", startUnixMs: 1_200, endUnixMs: 1_500, startMonotonicNs: "1200000000", endMonotonicNs: "1500000000" },
      { ordinal: 2, cpu: 8, outcome: "pass", startUnixMs: 1_600, endUnixMs: 2_000, startMonotonicNs: "1600000000", endMonotonicNs: "2000000000" },
    ],
  });
  assert.equal(joined.status, "complete", joined.reasons.join("; "));
  assert.equal(joined.joinedRuns, 2);
  assert.equal(joined.recentPreRuns, 2);
  assert.equal(joined.duringCoveredRuns, 2);
  const failed = joined.byContextOutcome.find(({ outcome }) => outcome === "sigsegv");
  const passed = joined.byContextOutcome.find(({ outcome }) => outcome === "pass");
  assert.equal(failed.context, "isolated");
  assert.equal(failed.pre.targetFrequencyKHz.meanOfRunMeans, 4_000_000);
  assert.equal(failed.during.targetFrequencyKHz.meanOfRunMeans, 4_500_000);
  assert.equal(passed.pre.targetFrequencyKHz.meanOfRunMeans, 4_500_000);
  assert.equal(passed.during.targetFrequencyKHz.observations, 2);
  assert.equal(passed.during.targetFrequencyKHz.meanOfRunMeans, 4_900_000);
  assert.deepEqual(joined.topology[0], {
    segment: 1,
    cpu: 8,
    package: 0,
    die: 0,
    core: 4,
    logicalCpus: [8],
    scalingCurFreqSource: "/sys/cpu8/freq",
    coreTemperatureSensor: "coretemp:0:core:4",
    coreTemperatureState: null,
    packageTemperatureSensor: "coretemp:0:package:0",
    packageTemperatureState: null,
  });
});

test("outcome summaries remain stratified when pinned contexts overlap", () => {
  const joined = associateTelemetryRuns({
    telemetryAssessment: assessment(),
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 2,
    workloadBindingReconciled: true,
    runs: [
      { ordinal: 1, context: "ecores-a", cpu: 8, outcome: "pass", startUnixMs: 1_200, endUnixMs: 1_500, startMonotonicNs: "1200000000", endMonotonicNs: "1500000000" },
      { ordinal: 2, context: "ecores-b", cpu: 8, outcome: "pass", startUnixMs: 1_600, endUnixMs: 2_000, startMonotonicNs: "1600000000", endMonotonicNs: "2000000000" },
    ],
  });
  assert.equal(joined.status, "complete", joined.reasons.join("; "));
  assert.equal(Object.hasOwn(joined, "byOutcome"), false);
  assert.deepEqual(
    joined.byContextOutcome.map(({ context, outcome, runs }) => ({ context, outcome, runs })),
    [
      { context: "ecores-a", outcome: "pass", runs: 1 },
      { context: "ecores-b", outcome: "pass", runs: 1 },
    ],
  );
});

test("other workload failures retain their own telemetry stratum", () => {
  const joined = associateTelemetryRuns({
    telemetryAssessment: assessment(),
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 3,
    workloadBindingReconciled: true,
    runs: [
      { ordinal: 1, cpu: 8, outcome: "pass", startUnixMs: 1_200, endUnixMs: 1_360, startMonotonicNs: "1200000000", endMonotonicNs: "1360000000" },
      { ordinal: 2, cpu: 8, outcome: "other-workload-failure", startUnixMs: 1_500, endUnixMs: 1_700, startMonotonicNs: "1500000000", endMonotonicNs: "1700000000" },
      { ordinal: 3, cpu: 8, outcome: "sigsegv", startUnixMs: 1_750, endUnixMs: 1_900, startMonotonicNs: "1750000000", endMonotonicNs: "1900000000" },
    ],
  });
  assert.equal(joined.status, "complete", joined.reasons.join("; "));
  assert.deepEqual(joined.byContextOutcome.map(({ outcome, runs }) => ({ outcome, runs })), [
    { outcome: "pass", runs: 1 },
    { outcome: "other-workload-failure", runs: 1 },
    { outcome: "sigsegv", runs: 1 },
  ]);
  assert.equal(joined.byCpu.filter((row) => row.outcome === "other-workload-failure").length, 1);
  assert.equal(Object.hasOwn(joined, "byOutcome"), false);
});

test("missing binding, stale pre-sweep, and no during sweep degrade telemetry only", () => {
  const joined = associateTelemetryRuns({
    telemetryAssessment: assessment(),
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 1,
    workloadBindingReconciled: false,
    runs: [{
      ordinal: 1,
      cpu: 8,
      outcome: "pass",
      startUnixMs: 3_000,
      endUnixMs: 3_100,
      startMonotonicNs: "3000000000",
      endMonotonicNs: "3100000000",
    }],
  });
  assert.equal(joined.status, "degraded");
  assert.equal(joined.totalRuns, 1);
  assert.equal(joined.recentPreRuns, 0);
  assert.equal(joined.duringCoveredRuns, 0);
  assert.match(joined.reasons.join("; "), /not bound|pre-run|during-run/);
});

test("rejects a workload boundary binding that does not match the exact row count", () => {
  const joined = associateTelemetryRuns({
    telemetryAssessment: assessment(),
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 2,
    workloadBindingReconciled: true,
    runs: [{ ordinal: 1, cpu: 8, outcome: "pass", startUnixMs: 1_200, endUnixMs: 1_500, startMonotonicNs: "1200000000", endMonotonicNs: "1500000000" }],
  });
  assert.equal(joined.status, "invalid");
  assert.match(joined.reasons.join("; "), /does not reconcile/);
});

test("Unix containment disambiguates overlapping monotonic ranges across boots", () => {
  const telemetry = assessment();
  telemetry.segments.push({
    ...structuredClone(telemetry.segments[0]),
    segment: 2,
    boundary: {
      start: { monotonicNs: "1000000000", unixMs: 20_000 },
      end: { monotonicNs: "5000000000", unixMs: 25_000 },
    },
  });
  const joined = associateTelemetryRuns({
    telemetryAssessment: telemetry,
    workloadGeneration: generation,
    workloadBoundariesSha256: digest,
    workloadBoundaryRowCount: 1,
    workloadBindingReconciled: true,
    runs: [{
      ordinal: 1,
      cpu: 8,
      outcome: "pass",
      startUnixMs: 21_600,
      endUnixMs: 22_000,
      startMonotonicNs: "1600000000",
      endMonotonicNs: "2000000000",
    }],
  });
  assert.equal(joined.status, "complete", joined.reasons.join("; "));
  assert.equal(joined.topology[0].segment, 2);
});
