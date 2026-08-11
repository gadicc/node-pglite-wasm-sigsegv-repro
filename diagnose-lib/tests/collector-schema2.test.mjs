import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildExpectedPinnedConcurrentPlanRows,
  collect,
  reconcileIndividualWithGroups,
  summarizeNoTurboCondition,
  validatePinnedConcurrentContexts,
} from "../collect.mjs";
import {
  buildPinnedConcurrentMeta,
  serializePinnedConcurrentBoundaries,
  serializePinnedConcurrentGroups,
  serializePinnedConcurrentMeta,
  serializePinnedConcurrentPlan,
  serializePinnedConcurrentResults,
} from "../pinned-concurrent-evidence.mjs";
import {
  buildTelemetryEnvelope,
  serializeTelemetryBoundary,
} from "../telemetry-evidence.mjs";
import {
  createTelemetryRecorder,
  canonicalTelemetryLine,
  discoverTelemetry,
} from "../telemetry-sampler.mjs";
import { computeTelemetryWorkloadBinding } from "../telemetry-workload-binding.mjs";
import { buildPinnedConcurrentPlan } from "../pinned-protocol.mjs";
import { groupsPlanDigest } from "../groups-evidence.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(testDirectory, "fixtures");
const roots = [];
const GROUP_GENERATION = "00112233445566778899aabbccddeeff";
const GROUP_PLAN_DIGEST = "b".repeat(64);
const TELEMETRY_GENERATION = "0123456789abcdef0123456789abcdef";

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function schema2Meta(overrides = {}) {
  return {
    MODE: "default",
    RUN_SCHEMA_VERSION: "2",
    BASELINE_CHILDREN: "4",
    BASELINE_WAVES: "5",
    GROUP_WAVES: "5",
    INDIVIDUAL_RUNS: "2",
    PINNED_CONCURRENT_ROUNDS: "2",
    PROTOCOL_SEED: "42",
    SKIP_PINNED_CONCURRENT: "0",
    TELEMETRY_INTERVAL_MS: "250",
    GDB_MAX_RUNS: "6",
    SKIP_GDB: "1",
    CPU_TARGET: "auto",
    ...overrides,
  };
}

function serializeConfig(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function bundle(config = schema2Meta()) {
  const root = mkdtempSync(path.join(tmpdir(), "collector-schema2-"));
  roots.push(root);
  mkdirSync(path.join(root, "results"));
  mkdirSync(path.join(root, "state"));
  writeFileSync(path.join(root, "results", "meta.env"), serializeConfig(config));
  return root;
}

const unavailableGroupPlan = [
  ["pcores", "pcore", "0-3", "-", "4", "5", "logs/groups/pcores.log", "group-pcores"],
];

function writeCompleteSourceGroups(root) {
  const digest = groupsPlanDigest(unavailableGroupPlan);
  mkdirSync(path.join(root, "logs", "groups"), { recursive: true });
  copyFileSync(
    path.join(fixtures, "repro-clean-4x5.log"),
    path.join(root, "logs", "groups", "pcores.log"),
  );
  writeFileSync(
    path.join(root, "results", "groups.tsv"),
    `${[...unavailableGroupPlan[0], "0"].join("\t")}\n`,
  );
  writeFileSync(path.join(root, "results", "groups.meta"), [
    "VERSION=2",
    `GENERATION=${GROUP_GENERATION}`,
    "EXPECTED_ROWS=1",
    "GROUP_WAVES=5",
    `PLAN_DIGEST=${digest}`,
    "COMPLETED=1",
    "",
  ].join("\n"));
  writeFileSync(path.join(root, "state", "phase-groups.done"), "");
  return digest;
}

function unavailableMeta(planDigest) {
  return [
    "VERSION=1",
    `SOURCE_GROUP_GENERATION=${GROUP_GENERATION}`,
    `SOURCE_GROUP_PLAN_DIGEST=${planDigest}`,
    "REASON=no-safe-topology-context",
    "",
  ].join("\n");
}

function writeUnavailableEnvelope(root, planDigest) {
  writeFileSync(
    path.join(root, "results", "pinned-concurrent.unavailable.meta"),
    unavailableMeta(planDigest),
  );
  writeFileSync(path.join(root, "state", "phase-pinned-concurrent-unavailable.done"), "");
}

test("schema-2 run configuration is parsed exactly and an explicit concurrent skip stays non-authoritative", () => {
  const root = bundle(schema2Meta({ SKIP_PINNED_CONCURRENT: "1" }));
  const result = collect(root);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.configStatus.status, "complete", result.configStatus.reasons.join("; "));
  assert.deepEqual(
    {
      runSchemaVersion: result.config.runSchemaVersion,
      pinnedConcurrentRounds: result.config.pinnedConcurrentRounds,
      protocolSeed: result.config.protocolSeed,
      skipPinnedConcurrent: result.config.skipPinnedConcurrent,
      telemetryIntervalMs: result.config.telemetryIntervalMs,
    },
    {
      runSchemaVersion: 2,
      pinnedConcurrentRounds: 2,
      protocolSeed: 42,
      skipPinnedConcurrent: true,
      telemetryIntervalMs: 250,
    },
  );
  assert.equal(result.pinnedConcurrentStatus.status, "skipped");
  assert.equal(result.pinnedConcurrentStatus.authoritative, false);
  assert.equal(result.pinnedConcurrent, undefined);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.telemetryStatus).map(([phase, state]) => [phase, state.status])),
    { baseline: "not-run", groups: "not-run", individual: "not-run", "pinned-concurrent": "not-run", gdb: "not-run" },
  );
  assert.deepEqual(result.noTurboCondition, { status: "not-run", phases: [] });
});

test("schema-2-only keys cannot be smuggled into a legacy configuration", () => {
  const root = bundle({
    MODE: "default",
    BASELINE_CHILDREN: "4",
    BASELINE_WAVES: "5",
    GROUP_WAVES: "5",
    INDIVIDUAL_RUNS: "2",
    PINNED_CONCURRENT_ROUNDS: "2",
    GDB_MAX_RUNS: "6",
    SKIP_GDB: "1",
    CPU_TARGET: "auto",
  });
  const result = collect(root);
  assert.equal(result.config.runSchemaVersion, 1);
  assert.equal(result.configStatus.status, "invalid");
  assert.match(result.configStatus.reasons.join("; "), /legacy stored run metadata unexpectedly contains PINNED_CONCURRENT_ROUNDS/);
});

test("V5 and V6 isolated evidence reconcile only with the all-usable CPU policy and stored seed", () => {
  const assessment = {
    status: "complete",
    reasons: [],
    acceptedRows: [["0", "1", "0", "1"], ["1", "1", "139", "1"]],
    acceptedSummaries: [],
  };
  const meta = {
    VERSION: "5",
    TARGET_CPUS: "0-1",
    RUNS_PER_CPU: "1",
    TARGET_POLICY: "all-usable-cpus",
    GROUP_PLAN_DIGEST,
    GROUP_GENERATION,
    SCHEDULE_SEED: "42",
    SKIPPED: "0",
  };
  const groups = {
    status: "complete",
    meta: { GENERATION: GROUP_GENERATION, PLAN_DIGEST: GROUP_PLAN_DIGEST },
    entries: [{ name: "all-cpus", cpus: "0-1", parsed: { failedWaves: 0 } }],
  };
  for (const version of ["5", "6"]) {
    const candidate = { ...meta, VERSION: version };
    const reconciled = reconcileIndividualWithGroups(assessment, candidate, groups, "schema2", "1", 42);
    assert.equal(reconciled.status, "complete", `${version}: ${reconciled.reasons.join("; ")}`);
    const staleSeed = reconcileIndividualWithGroups(assessment, candidate, groups, "schema2", "1", 43);
    assert.equal(staleSeed.status, "invalid");
    assert.match(staleSeed.reasons.join("; "), /target policy does not match/);
  }
});

test("pinned-concurrent contexts must be exact source groups or complete a/b partitions", () => {
  const sources = [
    { name: "pcores", kind: "pcore", cpus: "0-1", clusterId: null },
    { name: "ecores", kind: "ecore", cpus: "2-3", clusterId: null },
  ];
  const exact = [
    { group: "pcores", kind: "pcore", cpus: "0-1", cluster: "-", controller_cpu: 2 },
    { group: "ecores", kind: "ecore", cpus: "2-3", cluster: "-", controller_cpu: 0 },
  ];
  assert.deepEqual(validatePinnedConcurrentContexts(exact, sources), []);
  assert.match(
    validatePinnedConcurrentContexts([{ ...exact[0], controller_cpu: 8 }, exact[1]], sources).join("; "),
    /controller outside the source usable CPU set/,
  );

  const uniform = [{ name: "all-cpus", kind: "uniform", cpus: "0-3", clusterId: null }];
  const partition = [
    { group: "all-cpus-a", kind: "uniform-partition", cpus: "0-1", cluster: "-", controller_cpu: 2 },
    { group: "all-cpus-b", kind: "uniform-partition", cpus: "2-3", cluster: "-", controller_cpu: 0 },
  ];
  assert.deepEqual(validatePinnedConcurrentContexts(partition, uniform), []);
  assert.match(
    validatePinnedConcurrentContexts([{ ...partition[0], cpus: "0-2" }, partition[1]], uniform).join("; "),
    /not an exact source-group partition/,
  );
});

test("collector regenerates the exact protocol-defined seeded concurrent plan", () => {
  const built = buildPinnedConcurrentPlan({
    contexts: [
      { group: "pcores", kind: "pcore", cpus: [0, 1], cluster: "-", controllerCpu: 2 },
      { group: "ecores", kind: "ecore", cpus: [2, 3], cluster: "-", controllerCpu: 0 },
    ],
    rounds: 3,
    seed: 42,
  });
  const protocolRows = built.records.map((record) => ({
    ordinal: record.ordinal,
    round: record.round,
    group_position: record.groupPosition,
    group: record.group,
    controller_cpu: record.controllerCpu,
    launch_position: record.launchPosition,
    cpu: record.cpu,
  }));
  assert.deepEqual(buildExpectedPinnedConcurrentPlanRows(built.groupsRows, 3, 42), protocolRows);
});

test("a canonical source-bound unavailable envelope is terminal but never authoritative", () => {
  const root = bundle();
  const planDigest = writeCompleteSourceGroups(root);
  writeUnavailableEnvelope(root, planDigest);

  const result = collect(root);
  assert.equal(result.groupsStatus.status, "complete", result.groupsStatus.reasons.join("; "));
  assert.deepEqual(result.pinnedConcurrentStatus, {
    status: "unavailable",
    reasons: [
      "no safe controller CPU outside an active topology context was available; the pinned-concurrent workload was not launched",
    ],
    authoritative: false,
    unavailableReason: "no-safe-topology-context",
    completedWaveCount: 0,
    totalWaveCount: 0,
    discardedTailRowCount: 0,
  });
  assert.equal(result.pinnedConcurrent, undefined);
});

test("empty owned preparation directories do not contradict terminal unavailability", () => {
  const root = bundle();
  const planDigest = writeCompleteSourceGroups(root);
  writeUnavailableEnvelope(root, planDigest);
  for (const relative of [
    "logs/pinned-concurrent",
    "state/pinned-concurrent-waves",
    "state/pinned-concurrent-finalize",
    "telemetry/pinned-concurrent",
    "state/telemetry-pinned-concurrent",
  ]) {
    mkdirSync(path.join(root, relative), { recursive: true });
  }

  const result = collect(root);
  assert.equal(result.pinnedConcurrentStatus.status, "unavailable");
  assert.equal(result.pinnedConcurrentStatus.authoritative, false);
});

test("partial, unsafe, mismatched, malformed, and contradictory unavailable envelopes fail closed", async (t) => {
  const cases = [
    ["partial", (root, digest) => {
      writeFileSync(path.join(root, "results", "pinned-concurrent.unavailable.meta"), unavailableMeta(digest));
    }],
    ["unsafe symlink marker", (root, digest) => {
      writeFileSync(path.join(root, "marker-target"), "");
      writeFileSync(path.join(root, "results", "pinned-concurrent.unavailable.meta"), unavailableMeta(digest));
      symlinkSync("../marker-target", path.join(root, "state", "phase-pinned-concurrent-unavailable.done"));
    }],
    ["hard-linked metadata", (root, digest) => {
      const source = path.join(root, "unavailable-source");
      writeFileSync(source, unavailableMeta(digest));
      linkSync(source, path.join(root, "results", "pinned-concurrent.unavailable.meta"));
      writeFileSync(path.join(root, "state", "phase-pinned-concurrent-unavailable.done"), "");
    }],
    ["source mismatch", (root) => {
      writeUnavailableEnvelope(root, "f".repeat(64));
    }],
    ["noncanonical extra field", (root, digest) => {
      writeFileSync(
        path.join(root, "results", "pinned-concurrent.unavailable.meta"),
        `${unavailableMeta(digest)}EXTRA=1\n`,
      );
      writeFileSync(path.join(root, "state", "phase-pinned-concurrent-unavailable.done"), "");
    }],
    ["contradictory workload artifact", (root, digest) => {
      writeUnavailableEnvelope(root, digest);
      writeFileSync(path.join(root, "results", "pinned-concurrent.tsv"), "contradiction\n");
    }],
  ];

  for (const [label, arrange] of cases) {
    await t.test(label, () => {
      const root = bundle();
      const planDigest = writeCompleteSourceGroups(root);
      arrange(root, planDigest);
      const result = collect(root);
      assert.equal(result.pinnedConcurrentStatus.status, "invalid");
      assert.equal(result.pinnedConcurrentStatus.authoritative, false);
      assert.equal(result.pinnedConcurrent, undefined);
      assert.ok(result.pinnedConcurrentStatus.reasons.length > 0);
    });
  }
});

function buildConcurrentBoundaries(planRows, resultRows) {
  return planRows.map((row, index) => {
    const durationMs = resultRows[index].elapsed_ms;
    const durationNs = BigInt(durationMs) * 1_000_000n;
    const startMonotonicNs = 5_000_000_000n + BigInt(index) * 2_000_000_000n;
    return {
      ordinal: row.ordinal,
      round: row.round,
      groupPosition: row.group_position,
      group: row.group,
      controllerCpu: row.controller_cpu,
      launchPosition: row.launch_position,
      cpu: row.cpu,
      startUnixMs: 1_800_000_000_000 + index * 2_000,
      endUnixMs: 1_800_000_000_000 + index * 2_000 + durationMs,
      startMonotonicNs: startMonotonicNs.toString(),
      endMonotonicNs: (startMonotonicNs + durationNs).toString(),
      durationNs: durationNs.toString(),
      durationMs,
      noTurboStart: 0,
      noTurboEnd: 0,
    };
  });
}

test("collector exposes only whole-wave concurrent summaries and withholds authority without source groups", () => {
  const root = bundle();
  const groups = [
    { group: "pcores", kind: "pcore", cpus: "0-1", cluster: "-", controller_cpu: 8, rounds: 2 },
  ];
  const plan = buildExpectedPinnedConcurrentPlanRows(groups, 2, 42);
  const rows = plan.map(({ round, group, cpu, launch_position }, index) => ({
    round,
    group,
    cpu,
    launch_position,
    rc: index === 2 ? 139 : 0,
    elapsed_ms: 900 + index,
  }));
  const groupsText = serializePinnedConcurrentGroups(groups, { roundsPerContext: 2 });
  const planText = serializePinnedConcurrentPlan(plan, groups, { roundsPerContext: 2 });
  const rowsText = serializePinnedConcurrentResults(rows, plan);
  const boundaries = buildConcurrentBoundaries(plan, rows);
  const boundariesText = serializePinnedConcurrentBoundaries(boundaries, {
    planRows: plan,
    resultRows: rows,
  });
  const meta = buildPinnedConcurrentMeta({
    generation: TELEMETRY_GENERATION,
    sourceGroupGeneration: GROUP_GENERATION,
    sourceGroupPlanDigest: GROUP_PLAN_DIGEST,
    roundsPerContext: 2,
    scheduleSeed: 42,
    groupsBytes: groupsText,
    groupsRowCount: groups.length,
    planBytes: planText,
    planRowCount: plan.length,
    resultsBytes: rowsText,
    resultsRowCount: rows.length,
    boundariesBytes: boundariesText,
    boundariesRowCount: boundaries.length,
    completed: true,
  });
  writeFileSync(path.join(root, "results", "pinned-concurrent.groups.tsv"), groupsText);
  writeFileSync(path.join(root, "results", "pinned-concurrent.plan.tsv"), planText);
  writeFileSync(path.join(root, "results", "pinned-concurrent.tsv"), rowsText);
  writeFileSync(path.join(root, "results", "pinned-concurrent.boundaries.ndjson"), boundariesText);
  writeFileSync(path.join(root, "results", "pinned-concurrent.meta"), serializePinnedConcurrentMeta(meta));
  writeFileSync(path.join(root, "state", "phase-pinned-concurrent.done"), "");

  const result = collect(root);
  assert.equal(result.pinnedConcurrentStatus.status, "incomplete");
  assert.equal(result.pinnedConcurrentStatus.authoritative, false);
  assert.match(result.pinnedConcurrentStatus.reasons.join("; "), /group evidence is unavailable/);
  assert.equal(result.pinnedConcurrent.waves, 2);
  assert.equal(result.pinnedConcurrent.childRuns, 4);
  assert.deepEqual(result.pinnedConcurrent.perCpu.find(({ cpu }) => cpu === rows[2].cpu), {
    context: "pcores",
    group: "pcores",
    cpu: rows[2].cpu,
    runs: 2,
    failures: 1,
    sigsegv: 1,
  });

  // A different balanced schedule remains internally well-formed and is
  // rebound honestly, but it cannot claim the stored seed 42.
  const alternatePlan = plan.map((record, index) => ({
    ...record,
    cpu: plan[index % 2 === 0 ? index + 1 : index - 1].cpu,
  }));
  const alternateRows = alternatePlan.map(({ round, group, cpu, launch_position }, index) => ({
    round,
    group,
    cpu,
    launch_position,
    rc: index === 2 ? 139 : 0,
    elapsed_ms: 950 + index,
  }));
  const alternatePlanText = serializePinnedConcurrentPlan(alternatePlan, groups, { roundsPerContext: 2 });
  const alternateRowsText = serializePinnedConcurrentResults(alternateRows, alternatePlan);
  const alternateBoundaries = buildConcurrentBoundaries(alternatePlan, alternateRows);
  const alternateBoundariesText = serializePinnedConcurrentBoundaries(alternateBoundaries, {
    planRows: alternatePlan,
    resultRows: alternateRows,
  });
  const alternateMeta = buildPinnedConcurrentMeta({
    generation: TELEMETRY_GENERATION,
    sourceGroupGeneration: GROUP_GENERATION,
    sourceGroupPlanDigest: GROUP_PLAN_DIGEST,
    roundsPerContext: 2,
    scheduleSeed: 42,
    groupsBytes: groupsText,
    groupsRowCount: groups.length,
    planBytes: alternatePlanText,
    planRowCount: alternatePlan.length,
    resultsBytes: alternateRowsText,
    resultsRowCount: alternateRows.length,
    boundariesBytes: alternateBoundariesText,
    boundariesRowCount: alternateBoundaries.length,
    completed: true,
  });
  writeFileSync(path.join(root, "results", "pinned-concurrent.plan.tsv"), alternatePlanText);
  writeFileSync(path.join(root, "results", "pinned-concurrent.tsv"), alternateRowsText);
  writeFileSync(
    path.join(root, "results", "pinned-concurrent.boundaries.ndjson"),
    alternateBoundariesText,
  );
  writeFileSync(path.join(root, "results", "pinned-concurrent.meta"), serializePinnedConcurrentMeta(alternateMeta));
  const alternate = collect(root, {
    outputFile: path.join(root, "alternate-results.json"),
    exclusiveOutput: true,
  });
  assert.equal(alternate.pinnedConcurrentStatus.status, "invalid");
  assert.match(alternate.pinnedConcurrentStatus.reasons.join("; "), /expected seeded schedule/);
  assert.equal(alternate.pinnedConcurrent, undefined);
});

function writeAttribute(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`);
}

function deterministicClock(origin, unixMs) {
  let current = origin;
  return {
    monotonicNs() {
      const value = current;
      current += 10n;
      return value;
    },
    unixMs() { return unixMs; },
  };
}

async function writeBaselineTelemetry(root) {
  const fake = mkdtempSync(path.join(tmpdir(), "collector-telemetry-sysfs-"));
  roots.push(fake);
  const cpuRoot = path.join(fake, "cpu");
  const hwmonRoot = path.join(fake, "hwmon");
  const noTurboPath = path.join(fake, "intel_pstate", "no_turbo");
  mkdirSync(hwmonRoot, { recursive: true });
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "physical_package_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "die_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "topology", "core_id"), 0);
  writeAttribute(path.join(cpuRoot, "cpu0", "cpufreq", "scaling_cur_freq"), 4_500_000);
  writeAttribute(noTurboPath, 0);
  const discovery = discoverTelemetry({ cpuRoot, hwmonRoot, noTurboPath, cpus: [0] });
  mkdirSync(path.join(root, "telemetry", "baseline"), { recursive: true });
  const log = path.join(root, "telemetry", "baseline", `${TELEMETRY_GENERATION}-1.ndjson`);
  const recorder = createTelemetryRecorder({
    discovery,
    outputPath: log,
    intervalMs: 250,
    maxSamples: 1,
    clock: deterministicClock(1_000_000n, 1_800_000_000_000),
  });
  await recorder.start();
  await recorder.done;
  let records = readFileSync(log, "utf8").trimEnd().split("\n").map(JSON.parse);
  const metadata = records[0];
  const sample = records[1];
  const second = {
    ...structuredClone(sample),
    seq: 1,
    unix_ms: sample.unix_ms + 250,
    monotonic_ns: (BigInt(sample.monotonic_ns) + 250_000_000n).toString(),
  };
  const end = {
    ...records[2],
    samples: 2,
    unix_ms: sample.unix_ms + 500,
    monotonic_ns: (BigInt(sample.monotonic_ns) + 500_000_000n).toString(),
  };
  const prefix = [metadata, sample, second].map(canonicalTelemetryLine).join("");
  end.bytes_before_end = Buffer.byteLength(prefix);
  records = [metadata, sample, second, end];
  writeFileSync(log, `${prefix}${canonicalTelemetryLine(end)}`);
  const boundary = {
    version: 1,
    phase: "baseline",
    tag: "baseline-run",
    generation: TELEMETRY_GENERATION,
    segment: 1,
    start: {
      unixMs: sample.unix_ms,
      monotonicNs: (BigInt(metadata.monotonic_origin_ns) + BigInt(sample.monotonic_ns) +
        BigInt(sample.read_duration_ns)).toString(),
      noTurbo: sample.no_turbo,
    },
    end: {
      unixMs: end.unix_ms,
      monotonicNs: (BigInt(metadata.monotonic_origin_ns) + BigInt(end.monotonic_ns)).toString(),
      noTurbo: sample.no_turbo,
    },
  };
  writeFileSync(
    path.join(root, "telemetry", "baseline", `${TELEMETRY_GENERATION}-1.boundary.json`),
    serializeTelemetryBoundary(boundary),
  );
  const envelope = buildTelemetryEnvelope(root, {
    phase: "baseline",
    generation: TELEMETRY_GENERATION,
    intervalMs: 250,
    segments: [{ segment: 1, tag: "baseline-run" }],
    workloadBinding: computeTelemetryWorkloadBinding("baseline", root),
  });
  writeFileSync(path.join(root, "results", "telemetry-baseline.tsv"), envelope.rowsBuffer);
  writeFileSync(path.join(root, "results", "telemetry-baseline.meta"), envelope.metaBuffer);
}

test("validated telemetry qualifies a complete workload condition without owning workload authority", async () => {
  const root = bundle(schema2Meta({ SKIP_PINNED_CONCURRENT: "1" }));
  mkdirSync(path.join(root, "logs", "baseline"), { recursive: true });
  copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(root, "logs", "baseline", "run1.log"));
  writeFileSync(
    path.join(root, "results", "baseline.meta"),
    "CHILDREN=4\nWAVES=5\nLOG=logs/baseline/run1.log\nEXIT_CODE=1\n",
  );
  writeFileSync(path.join(root, "state", "phase-baseline.done"), "");
  await writeBaselineTelemetry(root);

  const result = collect(root, { requireProductionTelemetryRoots: false });
  assert.equal(result.baselineStatus.status, "complete");
  assert.equal(result.telemetryStatus.baseline.status, "complete");
  assert.equal(result.telemetryStatus.baseline.authoritative, false);
  assert.equal(result.telemetry.baseline.segments.length, 1);
  assert.equal(result.noTurboCondition.status, "complete");
  assert.equal(result.noTurboCondition.phases.length, 1);
  assert.deepEqual(result.noTurboCondition.phases[0], {
    phase: "baseline",
    status: "complete",
    startNoTurbo: "0",
    endNoTurbo: "0",
    sampledValues: ["0"],
    boundaryValues: ["0"],
    validSamples: 2,
    totalSamples: 2,
    validBoundaries: 2,
    totalBoundaries: 2,
    unavailableSamples: 0,
    transientSamples: 0,
    workloadBindingReconciled: true,
    workloadAssociationComplete: true,
    workloadAssociationJoinedRuns: 0,
    workloadAssociationTotalRuns: 0,
    workloadAssociationRecentPreRuns: 0,
    workloadAssociationDuringCoveredRuns: 0,
    workloadBoundaryValues: [],
    validWorkloadBoundaryObservations: 0,
    totalWorkloadBoundaryObservations: 0,
    unavailableWorkloadBoundaryObservations: 0,
    changed: false,
  });

  const log = path.join(root, "telemetry", "baseline", `${TELEMETRY_GENERATION}-1.ndjson`);
  writeFileSync(log, readFileSync(log, "utf8").replace("4500000", "4500001"));
  const tampered = collect(root, {
    outputFile: path.join(root, "tampered-telemetry-results.json"),
    exclusiveOutput: true,
    requireProductionTelemetryRoots: false,
  });
  assert.equal(tampered.baselineStatus.status, "complete", "telemetry cannot invalidate workload evidence");
  assert.equal(tampered.telemetryStatus.baseline.status, "invalid");
  assert.equal(tampered.noTurboCondition.status, "degraded");
});

test("exact-CPU no_turbo authorization fails closed without boundary and interval joins", () => {
  const assessment = {
    status: "complete",
    workloadBinding: { reconciled: true },
    noTurbo: {
      status: "complete",
      sampledValues: ["0"],
      boundaryValues: ["0"],
      validSamples: 4,
      totalSamples: 4,
      validBoundaries: 2,
      totalBoundaries: 2,
      unavailableSamples: 0,
      transientSamples: 0,
      changed: false,
    },
    segments: [{
      segment: 1,
      boundary: { start: { noTurbo: 0 }, end: { noTurbo: 0 } },
    }],
  };
  const result = summarizeNoTurboCondition({ individual: assessment }, ["individual"]);
  assert.equal(result.status, "degraded");
  assert.equal(result.phases[0].workloadAssociationComplete, false);
  assert.equal(result.phases[0].status, "degraded");

  const boundary = {
    status: "complete",
    observedValues: ["0"],
    validObservations: 2,
    totalObservations: 2,
    unavailableObservations: 0,
    changed: false,
  };
  const association = {
    status: "complete",
    totalRuns: 1,
    joinedRuns: 1,
    recentPreRuns: 1,
    duringCoveredRuns: 1,
  };
  const complete = summarizeNoTurboCondition(
    { individual: assessment },
    ["individual"],
    { individual: boundary },
    { individual: association },
  );
  assert.equal(complete.status, "complete");

  const mismatched = summarizeNoTurboCondition(
    { individual: assessment },
    ["individual"],
    { individual: { ...boundary, validObservations: 4, totalObservations: 4 } },
    { individual: association },
  );
  assert.equal(mismatched.status, "degraded");
  assert.equal(mismatched.phases[0].status, "degraded");
});
