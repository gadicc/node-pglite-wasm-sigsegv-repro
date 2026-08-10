import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReport } from "../report.mjs";

function associationMetric(value, runsWithValue = 1, observations = 2) {
  return { runsWithValue, observations, min: value, max: value, meanOfRunMeans: value };
}

function base(overrides = {}) {
  return {
    collectedAt: "2026-08-09T12:00:00.000Z",
    config: { mode: "default" },
    configStatus: { status: "complete", reasons: [] },
    preflightStatus: { status: "complete", reasons: [] },
    environment: {
      DMI_PRODUCT: "Dell Test System",
      BIOS_VERSION: "3.1.1",
      BIOS_DATE: "06/16/2026",
      CPU_MODEL: "Intel Test CPU",
      CPU_STEPPING: "2",
      CPU_MICROCODE: "0x122",
    },
    baselineStatus: { status: "not-run", reasons: [] },
    groupsStatus: { status: "not-run", reasons: [] },
    individualStatus: {
      status: "complete",
      reasons: [],
      metadataVersion: "5",
      targetPolicy: "all-usable-cpus",
      protocol: "isolated-interleaved-v1",
      scheduleAlgorithm: "balanced-cyclic-v1",
      scheduleSeed: 42,
    },
    individual: [
      { cpu: 19, runs: 200, failures: 8, sigsegv: 8, invalidRuns: [], failedRuns: [] },
      { cpu: 21, runs: 200, failures: 0, sigsegv: 0, invalidRuns: [], failedRuns: [] },
    ],
    worstCpu: 19,
    pinnedConcurrentStatus: { status: "complete", reasons: [], authoritative: true },
    pinnedConcurrent: {
      authoritative: true,
      scheduleAlgorithm: "balanced-cyclic-v1",
      scheduleSeed: 42,
      groups: [
        { group: "ecluster-64", kind: "ecluster", cpus: "19", cluster: "topo:0:64", controllerCpu: 0, rounds: 200 },
        { group: "ecores", kind: "ecores", cpus: "21", cluster: "-", controllerCpu: 0, rounds: 200 },
      ],
      waves: 400,
      totalWaves: 400,
      failedWaves: 4,
      childRuns: 400,
      sigsegv: 4,
      perGroup: [
        { group: "ecluster-64", waves: 200, failedWaves: 3, childRuns: 200, sigsegv: 3 },
        { group: "ecores", waves: 200, failedWaves: 1, childRuns: 200, sigsegv: 1 },
      ],
      perCpu: [
        { context: "ecluster-64", cpu: 19, runs: 200, failures: 3, sigsegv: 3, invalidRuns: [], failedRuns: [] },
        { context: "ecores", cpu: 21, runs: 200, failures: 1, sigsegv: 1, invalidRuns: [], failedRuns: [] },
      ],
    },
    noTurboCondition: {
      status: "complete",
      phases: [
        { phase: "individual", status: "complete", startNoTurbo: "0", endNoTurbo: "0", sampledValues: ["0"], boundaryValues: ["0"], validSamples: 1200, totalSamples: 1200, unavailableSamples: 0, transientSamples: 0, validBoundaries: 2, totalBoundaries: 2, workloadBindingReconciled: true, workloadAssociationComplete: true, workloadAssociationJoinedRuns: 400, workloadAssociationTotalRuns: 400, workloadAssociationRecentPreRuns: 400, workloadAssociationDuringCoveredRuns: 400, workloadBoundaryValues: ["0"], validWorkloadBoundaryObservations: 800, totalWorkloadBoundaryObservations: 800, unavailableWorkloadBoundaryObservations: 0, changed: false },
        { phase: "pinned-concurrent", status: "complete", startNoTurbo: "0", endNoTurbo: "0", sampledValues: ["0"], boundaryValues: ["0"], validSamples: 800, totalSamples: 800, unavailableSamples: 0, transientSamples: 0, validBoundaries: 2, totalBoundaries: 2, workloadBindingReconciled: true, workloadAssociationComplete: true, workloadAssociationJoinedRuns: 400, workloadAssociationTotalRuns: 400, workloadAssociationRecentPreRuns: 400, workloadAssociationDuringCoveredRuns: 400, workloadBoundaryValues: ["0"], validWorkloadBoundaryObservations: 800, totalWorkloadBoundaryObservations: 800, unavailableWorkloadBoundaryObservations: 0, changed: false },
        { phase: "gdb", status: "complete", startNoTurbo: "0", endNoTurbo: "0", sampledValues: ["0"], boundaryValues: ["0"], validSamples: 20, totalSamples: 20, unavailableSamples: 0, transientSamples: 0, validBoundaries: 2, totalBoundaries: 2, workloadBindingReconciled: true, workloadAssociationComplete: true, workloadAssociationJoinedRuns: 0, workloadAssociationTotalRuns: 0, workloadAssociationRecentPreRuns: 0, workloadAssociationDuringCoveredRuns: 0, workloadBoundaryValues: [], validWorkloadBoundaryObservations: 0, totalWorkloadBoundaryObservations: 0, unavailableWorkloadBoundaryObservations: 0, changed: false },
      ],
    },
    gdb: {
      status: "captured",
      cpu: 19,
      attemptedRuns: 1,
      cleanRuns: 0,
      capturedRuns: 1,
      errorRuns: 0,
      countsAvailable: true,
      captures: [{
        file: "gdb/cpu19-run1.txt",
        classification: "known-signature",
        diffBits: [42],
      }],
    },
    ...overrides,
  };
}

test("Executive Summary is first and states only validated turbo-permitted evidence", () => {
  const report = renderReport(base());
  assert.match(report, /^# Diagnostic report:[^\n]*\n\n## Executive Summary\n/);
  assert.match(report, /\*\*Result — fault reproduced with turbo permitted\.\*\*/);
  assert.match(report, /\| 19 \|.*8\/200.*ecluster-64: 3\/200/s);
  assert.match(report, /\| 21 \|.*no failures observed.*ecores: 1\/200/s);
  assert.match(report, /confirmed the documented intended-address \+ 2\^42 signature in 1\/1/);
  assert.match(report, /supports hardware service\/RMA investigation/);
  assert.match(report, /`no_turbo=0` means turbo is permitted; `no_turbo=1` means turbo is disabled/);
  assert.match(report, /sha256sum -c manifest\.txt/);
  assert.match(report, /Send the entire completed bundle, not `report\.md` alone/);
  assert.match(report, /service tag separately through the secure Dell support case/);
  assert.match(report, /Nominal pointwise 95% intervals and zero-failure bounds use an independence\/stationarity working assumption/);
  assert.doesNotMatch(report, /\b(?:good|healthy|cleared|clean)\b/i);
});

test("Executive Summary retains zero-failure contexts beside a failing context", () => {
  const value = base();
  value.pinnedConcurrent.groups.push({
    group: "all-ecores",
    kind: "ecores",
    cpus: "19",
    cluster: "-",
    controllerCpu: 0,
    rounds: 200,
  });
  value.pinnedConcurrent.perGroup.push({
    group: "all-ecores",
    waves: 200,
    failedWaves: 0,
    childRuns: 200,
    sigsegv: 0,
  });
  value.pinnedConcurrent.perCpu.push({
    context: "all-ecores",
    cpu: 19,
    runs: 200,
    failures: 0,
    sigsegv: 0,
    invalidRuns: [],
    failedRuns: [],
  });
  value.pinnedConcurrent.waves = 600;
  value.pinnedConcurrent.totalWaves = 600;
  value.pinnedConcurrent.childRuns = 600;

  const report = renderReport(value);
  assert.match(report, /ecluster-64: 3\/200 = 1\.5%.*all-ecores: no failures observed \(0\/200; 95% upper < 1\.5%\)/s);
});

test("a validated GDB-only signature names its exact logical CPU", () => {
  const report = renderReport(base({
    individualStatus: { status: "not-run", reasons: [] },
    individual: undefined,
    worstCpu: null,
    pinnedConcurrentStatus: { status: "not-run", reasons: [] },
    pinnedConcurrent: undefined,
  }));
  assert.match(report, /\| 19 \| not collected \| not collected \| validated intended-address \+ 2\^42 fault captured \|/);
  assert.match(report, /GDB: confirmed .* on logical CPU 19\./);
});

test("changed or incomplete no_turbo evidence cannot authorize the turbo claim", () => {
  const report = renderReport(base({
    noTurboCondition: {
      status: "degraded",
      phases: [{
        phase: "isolated pinned",
        status: "degraded",
        startNoTurbo: "0",
        endNoTurbo: "1",
        sampledValues: ["0", "1"],
        validSamples: 9,
        totalSamples: 10,
      }],
    },
  }));
  assert.match(report, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(report, /fault reproduced with turbo permitted/);
});

test("omitted or duplicate relevant phases cannot authorize the turbo claim", () => {
  const omitted = base();
  omitted.noTurboCondition.phases = omitted.noTurboCondition.phases
    .filter(({ phase }) => phase !== "gdb");
  const omittedReport = renderReport(omitted);
  assert.match(omittedReport, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(omittedReport, /fault reproduced with turbo permitted/);

  const duplicate = base();
  duplicate.noTurboCondition.phases[2] = structuredClone(
    duplicate.noTurboCondition.phases[0],
  );
  const duplicateReport = renderReport(duplicate);
  assert.match(duplicateReport, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(duplicateReport, /fault reproduced with turbo permitted/);
});

test("a complete label cannot replace exact no_turbo boundary evidence", () => {
  const report = renderReport(base({
    noTurboCondition: {
      status: "complete",
      phases: [{
        phase: "individual",
        status: "complete",
        startNoTurbo: "0",
        endNoTurbo: "0",
        sampledValues: ["0"],
        boundaryValues: [],
        validSamples: 10,
        totalSamples: 10,
        validBoundaries: 0,
        totalBoundaries: 0,
        unavailableSamples: 0,
        transientSamples: 0,
        changed: false,
      }],
    },
  }));
  assert.match(report, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(report, /fault reproduced with turbo permitted/);
});

test("unjoined exact child intervals cannot authorize the turbo claim", () => {
  const value = base();
  value.noTurboCondition.phases[0].workloadAssociationComplete = false;
  value.noTurboCondition.phases[0].workloadAssociationJoinedRuns = 399;
  const report = renderReport(value);
  assert.match(report, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(report, /fault reproduced with turbo permitted/);
});

test("zero-of-zero exact association cannot authorize the turbo claim", () => {
  const value = base();
  const phase = value.noTurboCondition.phases[0];
  phase.workloadAssociationJoinedRuns = 0;
  phase.workloadAssociationTotalRuns = 0;
  phase.workloadAssociationRecentPreRuns = 0;
  phase.workloadAssociationDuringCoveredRuns = 0;
  phase.workloadBoundaryValues = [];
  phase.validWorkloadBoundaryObservations = 0;
  phase.totalWorkloadBoundaryObservations = 0;
  const report = renderReport(value);
  assert.match(report, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(report, /fault reproduced with turbo permitted/);
});

test("an exact-boundary denominator that is not two observations per run cannot authorize turbo", () => {
  const value = base();
  const phase = value.noTurboCondition.phases[0];
  phase.validWorkloadBoundaryObservations = 798;
  phase.totalWorkloadBoundaryObservations = 798;
  const report = renderReport(value);
  assert.match(report, /fault reproduced, but the turbo condition was not fully verified/);
  assert.doesNotMatch(report, /fault reproduced with turbo permitted/);
});

test("incomplete positive individual rows cannot enter the Executive Summary", () => {
  const report = renderReport(base({
    individualStatus: { status: "incomplete", reasons: ["marker missing"] },
    pinnedConcurrentStatus: { status: "not-run", reasons: [] },
    pinnedConcurrent: undefined,
    gdb: undefined,
  }));
  assert.match(report, /no confirmed SIGSEGV appears in complete, validated workload evidence/);
  assert.doesNotMatch(report, /\*\*Result — fault reproduced/);
  assert.doesNotMatch(report, /Confirmed failing logical CPUs/);
});

test("schema-2 details separate concurrent waves, pinned children, and telemetry context", () => {
  const report = renderReport(base({
    telemetryStatus: {
      individual: { status: "complete", reasons: [], authoritative: false, noTurboStatus: "complete" },
    },
    telemetry: {
      individual: {
        generation: "a".repeat(32),
        intervalMs: 250,
        authoritative: false,
        boundaryCoverage: { status: "complete", coveredSegments: 1, totalSegments: 1 },
        noTurbo: {
          status: "complete",
          sampledValues: ["0"],
          boundaryValues: ["0"],
          validSamples: 2,
          totalSamples: 2,
          unavailableSamples: 0,
          transientSamples: 0,
          validBoundaries: 2,
          totalBoundaries: 2,
          changed: false,
        },
        segments: [{
          segment: 1,
          tag: "individual",
          status: "complete",
          logStatus: "complete",
          coverage: {
            status: "complete",
            reasons: [],
            cadence: {
              intervalMs: 250,
              maximumAllowedSampleStartGapNs: "1000000000",
              maxWorkloadSampleStartGapNs: "500000000",
              latePollCount: 1,
              missedPollIntervals: "2",
              cadenceViolationCount: 0,
            },
          },
          boundary: {
            start: { unixMs: 1, monotonicNs: "1", noTurbo: 0 },
            end: { unixMs: 2, monotonicNs: "2", noTurbo: 0 },
          },
          summary: {
            samples: 2,
            noTurbo: {
              totalSamples: 2,
              validSamples: 2,
              unavailableSamples: 0,
              transientSamples: 0,
              sampledValues: ["0"],
              changed: false,
            },
            frequencyKHz: [{ cpu: 19, count: 2, unavailable: 0, transient: 0, min: 3_900_000, max: 5_200_000, mean: 4_550_000 }],
            packageTemperatureMillicelsius: [{ package: 0, count: 2, unavailable: 0, transient: 0, min: 81_000, max: 87_000, mean: 84_000 }],
            coreTemperatureMillicelsius: [{ package: 0, die: 0, core: 19, count: 2, unavailable: 0, transient: 0, min: 79_000, max: 86_000, mean: 82_500 }],
          },
        }],
      },
    },
    telemetryAssociations: {
      individual: {
        status: "complete",
        reasons: [],
        totalRuns: 400,
        joinedRuns: 400,
        recentPreRuns: 400,
        duringCoveredRuns: 400,
        workloadBinding: {
          reconciled: true,
          generation: "b".repeat(32),
          boundariesSha256: "c".repeat(64),
          boundaryRowCount: 400,
        },
        topology: [{
          segment: 1,
          cpu: 19,
          package: 0,
          die: 0,
          core: 11,
          logicalCpus: [19],
          coreTemperatureSensor: "coretemp:0:core:11",
          packageTemperatureSensor: "coretemp:0:package:0",
        }],
        byContextOutcome: [{
          context: "isolated",
          outcome: "sigsegv",
          runs: 8,
          joinedRuns: 8,
          recentPreRuns: 8,
          duringCoveredRuns: 8,
          pre: {
            targetFrequencyKHz: associationMetric(4_100_000, 8, 8),
            physicalCoreTemperatureMillicelsius: associationMetric(79_000, 8, 8),
            packageTemperatureMillicelsius: associationMetric(81_000, 8, 8),
          },
          during: {
            targetFrequencyKHz: associationMetric(5_000_000, 8, 24),
            physicalCoreTemperatureMillicelsius: associationMetric(86_000, 8, 24),
            packageTemperatureMillicelsius: associationMetric(87_000, 8, 24),
          },
        }],
        byCpu: [{
          context: "isolated",
          cpu: 19,
          outcome: "sigsegv",
          runs: 8,
          joinedRuns: 8,
          recentPreRuns: 8,
          duringCoveredRuns: 8,
          pre: {
            targetFrequencyKHz: associationMetric(4_100_000, 8, 8),
            physicalCoreTemperatureMillicelsius: associationMetric(79_000, 8, 8),
          },
          during: {
            targetFrequencyKHz: associationMetric(5_000_000, 8, 24),
            physicalCoreTemperatureMillicelsius: associationMetric(86_000, 8, 24),
          },
        }],
      },
    },
  }));

  assert.match(report, /Schema-2\/V5 used a precommitted seeded, position-balanced interleaving/);
  assert.match(report, /Per-context wave outcomes/);
  assert.match(report, /ecluster-64.*3\/200 = 1\.5% \[0\.5%, 4\.3%\].*3\/200 = 1\.5% \(descriptive; correlated children/s);
  assert.match(report, /Exact pinned-child outcomes by context and CPU/);
  assert.match(report, /individual \| complete \| 250 ms \| 1\/1 \| complete: 1\/1 segment\(s\)/);
  assert.match(report, /0 → 0; 0 \(2\/2 valid\)/);
  assert.match(report, /3\.90 GHz–5\.20 GHz \(2 values\)/);
  assert.match(report, /81\.0 °C–87\.0 °C \(2 values\)/);
  assert.match(report, /Sampling cadence audit/);
  assert.match(report, /individual \| 250 ms \| 1\.000 s \| 500\.000 ms \| 1 \| 2 \| 0 \|/);
  assert.match(report, /Telemetry is descriptive operating context only/);
  assert.match(report, /individual exact-run telemetry association/);
  assert.match(report, /Context-stratified pass\/failure summaries/);
  assert.match(report, /Execution contexts are never pooled/);
  assert.match(report, /\| Context \| Outcome \| Runs \/ joined \|/);
  assert.match(report, /CPU-to-sensor mapping used for the join/);
  assert.match(report, /sigsegv.*8 \/ 8.*5\.00 GHz/s);
  assert.match(report, /mean of per-run means/);
  assert.match(report, /failure-duration bias/);
});

test("an incomplete pinned-concurrent prefix is descriptive and cannot reproduce", () => {
  const report = renderReport(base({
    individualStatus: { status: "not-run", reasons: [] },
    individual: undefined,
    worstCpu: null,
    pinnedConcurrentStatus: {
      status: "incomplete",
      reasons: ["completion marker is missing"],
      discardedTailRowCount: 1,
    },
    noTurboCondition: { status: "not-run", phases: [] },
    gdb: undefined,
  }));

  assert.match(report, /no confirmed SIGSEGV appears in complete, validated workload evidence/);
  assert.match(report, /Complete group-wave prefixes may be shown descriptively/);
  assert.match(report, /3\/200 = 1\.5% \(descriptive only; no interval\)/);
  assert.match(report, /1 child row\(s\) ended inside a wave and were excluded/);
  assert.match(report, /Incomplete, invalid, or legacy pinned-concurrent evidence was excluded/);
  assert.doesNotMatch(report, /\*\*The problem reproduced\*\*/);
  assert.doesNotMatch(report, /3\/200 = 1\.5% \[/);
});

test("terminal topology unavailability is explicit and contributes no reproduction evidence", () => {
  const report = renderReport(base({
    groupsStatus: { status: "complete", reasons: [] },
    individualStatus: { status: "not-run", reasons: [] },
    individual: undefined,
    worstCpu: null,
    pinnedConcurrentStatus: {
      status: "unavailable",
      reasons: [
        "no safe controller CPU outside an active topology context was available; the pinned-concurrent workload was not launched",
      ],
      authoritative: false,
      unavailableReason: "no-safe-topology-context",
    },
    pinnedConcurrent: undefined,
    noTurboCondition: { status: "not-run", phases: [] },
    gdb: undefined,
  }));

  assert.match(report, /Pinned-concurrent: unavailable because the validated topology had no safe controller CPU outside an active context/);
  assert.match(report, /Unavailable: no safe pinned-concurrent controller\/topology context/);
  assert.match(report, /No pinned-concurrent workload ran, so this contributes neither reproduction nor no-failure evidence/);
  assert.match(report, /Pinned-concurrent was unavailable.*No workload ran in phase 5/s);
  assert.doesNotMatch(report, /\*\*The problem reproduced\*\*/);
  assert.doesNotMatch(report, /Incomplete, invalid, or legacy pinned-concurrent evidence was excluded/);
});
