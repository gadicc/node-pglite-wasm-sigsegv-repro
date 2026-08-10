import { execFileSync, spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES,
  PINNED_CONCURRENT_GROUPS_HEADER,
  PINNED_CONCURRENT_GROUPS_MAX_BYTES,
  PINNED_CONCURRENT_RESULTS_HEADER,
  assessPinnedConcurrentEvidence,
  buildPinnedConcurrentMeta,
  parsePinnedConcurrentCpuList,
  parsePinnedConcurrentBoundaries,
  parsePinnedConcurrentGroups,
  parsePinnedConcurrentMeta,
  pinnedConcurrentFileBinding,
  serializePinnedConcurrentBoundaries,
  serializePinnedConcurrentGroups,
  serializePinnedConcurrentMeta,
  serializePinnedConcurrentPlan,
  serializePinnedConcurrentResults,
  validateFreshPinnedConcurrentTargets,
} from "../pinned-concurrent-evidence.mjs";

const GENERATION = "0123456789abcdef0123456789abcdef";
const SOURCE_GENERATION = "fedcba9876543210fedcba9876543210";
const SOURCE_PLAN_DIGEST = "a".repeat(64);
const MODULE_FILE = fileURLToPath(new URL("../pinned-concurrent-evidence.mjs", import.meta.url));
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = "pinned-concurrent-evidence-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const groups = [
  { group: "pcores", kind: "pcore", cpus: "0-1", cluster: "-", controller_cpu: 8, rounds: 2 },
  { group: "ecluster-0", kind: "ecluster", cpus: "2-3", cluster: "0", controller_cpu: 8, rounds: 2 },
];

const plan = [
  { ordinal: 1, round: 1, group_position: 1, group: "pcores", controller_cpu: 8, launch_position: 1, cpu: 0 },
  { ordinal: 2, round: 1, group_position: 1, group: "pcores", controller_cpu: 8, launch_position: 2, cpu: 1 },
  { ordinal: 3, round: 1, group_position: 2, group: "ecluster-0", controller_cpu: 8, launch_position: 1, cpu: 2 },
  { ordinal: 4, round: 1, group_position: 2, group: "ecluster-0", controller_cpu: 8, launch_position: 2, cpu: 3 },
  { ordinal: 5, round: 2, group_position: 1, group: "ecluster-0", controller_cpu: 8, launch_position: 1, cpu: 3 },
  { ordinal: 6, round: 2, group_position: 1, group: "ecluster-0", controller_cpu: 8, launch_position: 2, cpu: 2 },
  { ordinal: 7, round: 2, group_position: 2, group: "pcores", controller_cpu: 8, launch_position: 1, cpu: 1 },
  { ordinal: 8, round: 2, group_position: 2, group: "pcores", controller_cpu: 8, launch_position: 2, cpu: 0 },
];

const results = plan.map(({ round, group, cpu, launch_position }, index) => ({
  round,
  group,
  cpu,
  launch_position,
  rc: index === 4 ? 139 : 0,
  elapsed_ms: 900 + index,
}));

const boundaries = plan.map((row, index) => {
  const durationMs = results[index].elapsed_ms;
  const startMonotonicNs = 5_000_000_000n + BigInt(index) * 2_000_000_000n;
  const durationNs = BigInt(durationMs) * 1_000_000n;
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
    noTurboStart: index === 2 ? { status: "unavailable", errorCode: "ENOENT" } : 0,
    noTurboEnd: index === 3 ? { status: "invalid", errorCode: "UNEXPECTED_VALUE" } : 0,
  };
});

function createBundle({
  resultRows = results,
  boundaryRows = boundaries,
  completed = true,
  marker = completed,
  includeBoundaries = completed,
} = {}) {
  const bundle = temporaryDirectory();
  mkdirSync(path.join(bundle, "results"));
  mkdirSync(path.join(bundle, "state"));
  const groupsText = serializePinnedConcurrentGroups(groups, { roundsPerContext: 2 });
  const planText = serializePinnedConcurrentPlan(plan, groups, { roundsPerContext: 2 });
  const resultsText = serializePinnedConcurrentResults(resultRows, plan);
  const boundariesText = serializePinnedConcurrentBoundaries(boundaryRows, {
    planRows: plan,
    resultRows: results,
  });
  const meta = buildPinnedConcurrentMeta({
    generation: GENERATION,
    sourceGroupGeneration: SOURCE_GENERATION,
    sourceGroupPlanDigest: SOURCE_PLAN_DIGEST,
    roundsPerContext: 2,
    scheduleSeed: 42,
    groupsBytes: groupsText,
    groupsRowCount: groups.length,
    planBytes: planText,
    planRowCount: plan.length,
    resultsBytes: completed ? resultsText : null,
    resultsRowCount: completed ? resultRows.length : null,
    boundariesBytes: completed ? boundariesText : null,
    boundariesRowCount: completed ? boundaryRows.length : null,
    completed,
  });
  writeFileSync(path.join(bundle, "results", "pinned-concurrent.groups.tsv"), groupsText);
  writeFileSync(path.join(bundle, "results", "pinned-concurrent.plan.tsv"), planText);
  writeFileSync(path.join(bundle, "results", "pinned-concurrent.tsv"), resultsText);
  if (includeBoundaries) {
    writeFileSync(path.join(bundle, "results", "pinned-concurrent.boundaries.ndjson"), boundariesText);
  }
  writeFileSync(path.join(bundle, "results", "pinned-concurrent.meta"), serializePinnedConcurrentMeta(meta));
  if (marker) writeFileSync(path.join(bundle, "state", "phase-pinned-concurrent.done"), "");
  return { bundle, groupsText, planText, resultsText, boundariesText, meta };
}

function publishBoundaries(bundleRecord, text, rowCount = text.trimEnd().split("\n").length) {
  const binding = pinnedConcurrentFileBinding(text, rowCount);
  bundleRecord.meta.BOUNDARIES_SHA256 = binding.sha256;
  bundleRecord.meta.BOUNDARIES_BYTES = String(binding.bytes);
  bundleRecord.meta.BOUNDARY_ROW_COUNT = String(binding.rowCount);
  writeFileSync(path.join(bundleRecord.bundle, "results", "pinned-concurrent.boundaries.ndjson"), text);
  writeFileSync(
    path.join(bundleRecord.bundle, "results", "pinned-concurrent.meta"),
    serializePinnedConcurrentMeta(bundleRecord.meta),
  );
}

function publishResults(bundleRecord, text, rowCount = text.trimEnd().split("\n").length - 1) {
  const binding = pinnedConcurrentFileBinding(text, rowCount);
  bundleRecord.meta.ROWS_SHA256 = binding.sha256;
  bundleRecord.meta.ROWS_BYTES = String(binding.bytes);
  bundleRecord.meta.ROW_COUNT = String(binding.rowCount);
  writeFileSync(path.join(bundleRecord.bundle, "results", "pinned-concurrent.tsv"), text);
  writeFileSync(
    path.join(bundleRecord.bundle, "results", "pinned-concurrent.meta"),
    serializePinnedConcurrentMeta(bundleRecord.meta),
  );
}

test("serializers produce canonical, exactly digestible files", () => {
  const groupsText = serializePinnedConcurrentGroups(groups, { roundsPerContext: 2 });
  const planText = serializePinnedConcurrentPlan(plan, groups, { roundsPerContext: 2 });
  const resultsText = serializePinnedConcurrentResults(results, plan);
  const boundariesText = serializePinnedConcurrentBoundaries(boundaries, { planRows: plan, resultRows: results });
  assert.ok(groupsText.startsWith(`${PINNED_CONCURRENT_GROUPS_HEADER}\n`));
  assert.ok(resultsText.startsWith(`${PINNED_CONCURRENT_RESULTS_HEADER}\n`));
  assert.deepEqual(pinnedConcurrentFileBinding(groupsText, 2), {
    sha256: "124a4edf6dbb09285a7d21c6e57c01856a348794fde62a2090cac2d016bf1cc3",
    bytes: Buffer.byteLength(groupsText),
    rowCount: 2,
  });
  assert.equal(serializePinnedConcurrentPlan(plan, groups, { roundsPerContext: 2 }), planText);
  assert.equal(serializePinnedConcurrentResults(results, plan), resultsText);
  assert.equal(serializePinnedConcurrentBoundaries(boundaries, { planRows: plan, resultRows: results }), boundariesText);
  assert.deepEqual(
    Object.keys(JSON.parse(boundariesText.split("\n")[0])),
    [
      "ordinal", "round", "groupPosition", "group", "controllerCpu", "launchPosition", "cpu",
      "startUnixMs", "endUnixMs", "startMonotonicNs", "endMonotonicNs", "durationNs",
      "durationMs", "noTurboStart", "noTurboEnd",
    ],
  );
});

test("a complete envelope authorizes exact child and whole-wave outcomes", () => {
  const { bundle } = createBundle();
  const assessment = assessPinnedConcurrentEvidence(bundle, {
    generation: GENERATION,
    sourceGroupGeneration: SOURCE_GENERATION,
    sourceGroupPlanDigest: SOURCE_PLAN_DIGEST,
    roundsPerContext: 2,
    scheduleSeed: 42,
    scheduleAlgorithm: "balanced-cyclic-v1",
    expectedGroupsRows: groups,
    expectedPlanRows: plan,
  });
  assert.equal(assessment.status, "complete", assessment.reasons.join("\n"));
  assert.equal(assessment.authoritative, true);
  assert.equal(assessment.authoritativeRows.length, 8);
  assert.equal(assessment.authoritativeBoundaries.length, 8);
  assert.equal(assessment.completedWaveCount, 4);
  assert.deepEqual(
    {
      waves: assessment.descriptiveOutcomes.waves,
      failedWaves: assessment.descriptiveOutcomes.failedWaves,
      childRuns: assessment.descriptiveOutcomes.childRuns,
      sigsegv: assessment.descriptiveOutcomes.sigsegv,
      authoritative: assessment.descriptiveOutcomes.authoritative,
    },
    { waves: 4, failedWaves: 1, childRuns: 8, sigsegv: 1, authoritative: true },
  );
  assert.deepEqual(assessment.descriptiveOutcomes.perCpu.find(({ group, cpu }) => group === "ecluster-0" && cpu === 3), {
    group: "ecluster-0", cpu: 3, runs: 2, sigsegv: 1,
  });
  assert.deepEqual(assessment.noTurboCoverage, {
    boundaryRows: 8,
    observationCount: 16,
    observedCount: 14,
    unavailableCount: 1,
    invalidCount: 1,
    value0Count: 14,
    value1Count: 0,
    fullyObservedRows: 6,
    observedValues: [0],
    allObserved: false,
    uniformObservedValue: 0,
    completeAndUniformValue: null,
    authoritative: true,
  });
  assert.equal(assessment.boundarySummary.totalDurationNs, "7228000000");
  assert.equal(assessment.boundarySummary.authoritative, true);
  assert.equal(assessment.authoritativeBoundarySummary.rowCount, 8);
});

test("an exact partial prefix resumes only at a complete group-wave boundary", () => {
  const { bundle } = createBundle({ resultRows: results.slice(0, 5), completed: false });
  const assessment = assessPinnedConcurrentEvidence(bundle);
  assert.equal(assessment.status, "incomplete", assessment.reasons.join("\n"));
  assert.equal(assessment.authoritative, false);
  assert.equal(assessment.resumableRowCount, 4);
  assert.equal(assessment.discardedTailRowCount, 1);
  assert.equal(assessment.committedRows.length, 4);
  assert.equal(assessment.authoritativeRows.length, 0);
  assert.equal(assessment.authoritativeBoundaries.length, 0);
  assert.equal(assessment.boundarySummary, null);
  assert.equal(assessment.descriptiveOutcomes.waves, 2);
  assert.equal(assessment.descriptiveOutcomes.childRuns, 4);
  assert.equal(assessment.descriptiveOutcomes.sigsegv, 0, "the partial failing wave must not enter a denominator");
  assert.match(assessment.reasons.join("\n"), /tail row\(s\) must be rerun/);
});

test("an incomplete envelope exactly at a wave boundary preserves that resume frontier", () => {
  const { bundle } = createBundle({ resultRows: results.slice(0, 6), completed: false });
  const assessment = assessPinnedConcurrentEvidence(bundle);
  assert.equal(assessment.status, "incomplete", assessment.reasons.join("\n"));
  assert.equal(assessment.resumableRowCount, 6);
  assert.equal(assessment.discardedTailRowCount, 0);
  assert.equal(assessment.descriptiveOutcomes.waves, 3);
  assert.equal(assessment.descriptiveOutcomes.failedWaves, 1);
});

test("operational exit codes and non-prefix outcomes are invalid and excluded", () => {
  for (const mutate of [
    (rows) => { rows[1].rc = 1; },
    (rows) => { [rows[0].cpu, rows[1].cpu] = [rows[1].cpu, rows[0].cpu]; },
  ]) {
    const { bundle, resultsText } = createBundle({ resultRows: [], completed: false });
    const rowCopies = results.map((row) => ({ ...row }));
    mutate(rowCopies);
    const raw = `${PINNED_CONCURRENT_RESULTS_HEADER}\n${rowCopies.map((row) => [
      row.round, row.group, row.cpu, row.launch_position, row.rc, row.elapsed_ms,
    ].join("\t")).join("\n")}\n`;
    assert.notEqual(raw, resultsText);
    writeFileSync(path.join(bundle, "results", "pinned-concurrent.tsv"), raw);
    const assessment = assessPinnedConcurrentEvidence(bundle);
    assert.equal(assessment.status, "invalid", assessment.reasons.join("\n"));
    assert.equal(assessment.authoritativeRows.length, 0);
    assert.equal(assessment.committedRows.length, 0);
    assert.equal(assessment.descriptiveOutcomes, null);
  }
});

test("metadata bindings and the completion marker fail closed", () => {
  const tampered = createBundle();
  writeFileSync(
    path.join(tampered.bundle, "results", "pinned-concurrent.groups.tsv"),
    tampered.groupsText.replace("\tpcore\t", "\tperformance\t"),
  );
  const changed = assessPinnedConcurrentEvidence(tampered.bundle);
  assert.equal(changed.status, "invalid");
  assert.match(changed.reasons.join("\n"), /exact metadata binding/);

  const unmarked = createBundle({ marker: false });
  const incomplete = assessPinnedConcurrentEvidence(unmarked.bundle);
  assert.equal(incomplete.status, "incomplete", incomplete.reasons.join("\n"));
  assert.equal(incomplete.authoritative, false);
  assert.equal(incomplete.publicationReady, true);
  assert.match(incomplete.reasons.join("\n"), /completion marker is missing/);

  const premature = createBundle({ resultRows: results.slice(0, 4), completed: false, marker: true });
  const invalid = assessPinnedConcurrentEvidence(premature.bundle);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.publicationReady, false);
  assert.match(invalid.reasons.join("\n"), /has a completion marker/);
});

test("terminal boundaries are required only for completion and are digest-bound", () => {
  const missing = createBundle({ includeBoundaries: false });
  const missingAssessment = assessPinnedConcurrentEvidence(missing.bundle);
  assert.equal(missingAssessment.status, "invalid");
  assert.match(missingAssessment.reasons.join("\n"), /missing its terminal boundary sidecar/);

  const resumable = createBundle({ resultRows: results.slice(0, 4), completed: false });
  const resumableAssessment = assessPinnedConcurrentEvidence(resumable.bundle);
  assert.equal(resumableAssessment.status, "incomplete", resumableAssessment.reasons.join("\n"));
  assert.equal(resumableAssessment.boundaries.length, 0);

  const premature = createBundle({ resultRows: results.slice(0, 4), completed: false });
  writeFileSync(
    path.join(premature.bundle, "results", "pinned-concurrent.boundaries.ndjson"),
    premature.boundariesText,
  );
  const prematureAssessment = assessPinnedConcurrentEvidence(premature.bundle);
  assert.equal(prematureAssessment.status, "invalid");
  assert.match(prematureAssessment.reasons.join("\n"), /incomplete.*terminal boundary sidecar/);

  const tampered = createBundle();
  writeFileSync(
    path.join(tampered.bundle, "results", "pinned-concurrent.boundaries.ndjson"),
    tampered.boundariesText.replace("\"noTurboStart\":0", "\"noTurboStart\":1"),
  );
  const tamperedAssessment = assessPinnedConcurrentEvidence(tampered.bundle);
  assert.equal(tamperedAssessment.status, "invalid");
  assert.match(tamperedAssessment.reasons.join("\n"), /exact metadata binding/);
});

test("boundary semantics fail closed even when a changed sidecar is rebound", () => {
  const reordered = createBundle();
  const reorderedLines = reordered.boundariesText.trimEnd().split("\n");
  [reorderedLines[0], reorderedLines[1]] = [reorderedLines[1], reorderedLines[0]];
  publishBoundaries(reordered, `${reorderedLines.join("\n")}\n`);
  const reorderedAssessment = assessPinnedConcurrentEvidence(reordered.bundle);
  assert.equal(reorderedAssessment.status, "invalid");
  assert.match(reorderedAssessment.reasons.join("\n"), /exact projected plan row|schedule fields/);

  const noncanonical = createBundle();
  const lines = noncanonical.boundariesText.trimEnd().split("\n");
  const first = JSON.parse(lines[0]);
  const { round, ordinal, ...rest } = first;
  lines[0] = JSON.stringify({ round, ordinal, ...rest });
  publishBoundaries(noncanonical, `${lines.join("\n")}\n`);
  const noncanonicalAssessment = assessPinnedConcurrentEvidence(noncanonical.bundle);
  assert.equal(noncanonicalAssessment.status, "invalid");
  assert.match(noncanonicalAssessment.reasons.join("\n"), /canonical fields in order/);

  const elapsedMismatch = createBundle();
  const changedResults = results.map((row, index) => ({ ...row, elapsed_ms: row.elapsed_ms + (index === 0 ? 1 : 0) }));
  publishResults(elapsedMismatch, serializePinnedConcurrentResults(changedResults, plan));
  const elapsedAssessment = assessPinnedConcurrentEvidence(elapsedMismatch.bundle);
  assert.equal(elapsedAssessment.status, "invalid");
  assert.match(elapsedAssessment.reasons.join("\n"), /duration disagrees with result elapsed_ms/);

  const malformedNoTurbo = createBundle();
  const noTurboLines = malformedNoTurbo.boundariesText.trimEnd().split("\n");
  noTurboLines[0] = noTurboLines[0].replace(
    "\"noTurboStart\":0",
    "\"noTurboStart\":{\"status\":\"unavailable\",\"errorCode\":\"bad code\"}",
  );
  publishBoundaries(malformedNoTurbo, `${noTurboLines.join("\n")}\n`);
  const noTurboAssessment = assessPinnedConcurrentEvidence(malformedNoTurbo.bundle);
  assert.equal(noTurboAssessment.status, "invalid");
  assert.match(noTurboAssessment.reasons.join("\n"), /invalid no_turbo observations/);
});

test("boundary parser enforces canonical timing and exact result order", () => {
  const valid = serializePinnedConcurrentBoundaries(boundaries, { planRows: plan, resultRows: results });
  assert.equal(parsePinnedConcurrentBoundaries(valid, { planRows: plan, resultRows: results }).reasons.length, 0);

  const lines = valid.trimEnd().split("\n");
  const timing = JSON.parse(lines[0]);
  timing.endMonotonicNs = String(BigInt(timing.endMonotonicNs) + 1n);
  lines[0] = JSON.stringify(timing);
  assert.match(
    parsePinnedConcurrentBoundaries(`${lines.join("\n")}\n`, { planRows: plan, resultRows: results }).reasons.join("\n"),
    /unreconciled timing/,
  );
});

test("strict metadata and topology grammar reject noncanonical records", () => {
  assert.deepEqual(parsePinnedConcurrentCpuList("0-1,3,8-9"), [0, 1, 3, 8, 9]);
  for (const invalid of ["", "01", "0-0", "0,1", "2-1", "1,1", "65536", "1, 2"]) {
    assert.equal(parsePinnedConcurrentCpuList(invalid), null, invalid);
  }
  const controllerInside = `${PINNED_CONCURRENT_GROUPS_HEADER}\npcores\tpcore\t0-1\t-\t1\t2\n`;
  assert.match(parsePinnedConcurrentGroups(controllerInside, { roundsPerContext: 2 }).reasons.join("\n"), /controller inside/);

  const { meta } = createBundle();
  const malformed = `${serializePinnedConcurrentMeta(meta)}EXTRA=1\n`;
  assert.match(parsePinnedConcurrentMeta(malformed).reasons.join("\n"), /unknown field EXTRA/);
});

test("symlinks, hardlinks, FIFOs, directories, and oversized sparse files are rejected without blocking", () => {
  const cases = [];

  const symbolic = createBundle();
  rmSync(path.join(symbolic.bundle, "results", "pinned-concurrent.meta"));
  symlinkSync("pinned-concurrent.groups.tsv", path.join(symbolic.bundle, "results", "pinned-concurrent.meta"));
  cases.push(symbolic.bundle);

  const hardlinked = createBundle();
  const originalMeta = path.join(hardlinked.bundle, "results", "pinned-concurrent.meta");
  linkSync(originalMeta, path.join(hardlinked.bundle, "results", "pinned-concurrent.meta.link"));
  cases.push(hardlinked.bundle);

  const fifo = createBundle();
  rmSync(path.join(fifo.bundle, "results", "pinned-concurrent.tsv"));
  try {
    execFileSync("mkfifo", [path.join(fifo.bundle, "results", "pinned-concurrent.tsv")]);
    cases.push(fifo.bundle);
  } catch (error) {
    // Some CI/sandbox profiles forbid creating FIFOs. The production check is
    // the same isFile()/single-link gate exercised by the directory case.
    assert.equal(error?.code, "EPERM");
  }

  const directory = createBundle();
  rmSync(path.join(directory.bundle, "results", "pinned-concurrent.plan.tsv"));
  mkdirSync(path.join(directory.bundle, "results", "pinned-concurrent.plan.tsv"));
  cases.push(directory.bundle);

  const oversized = createBundle();
  truncateSync(
    path.join(oversized.bundle, "results", "pinned-concurrent.groups.tsv"),
    PINNED_CONCURRENT_GROUPS_MAX_BYTES + 1,
  );
  cases.push(oversized.bundle);

  const oversizedBoundaries = createBundle();
  truncateSync(
    path.join(oversizedBoundaries.bundle, "results", "pinned-concurrent.boundaries.ndjson"),
    PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES + 1,
  );
  cases.push(oversizedBoundaries.bundle);

  for (const bundle of cases) {
    const assessment = assessPinnedConcurrentEvidence(bundle);
    assert.equal(assessment.status, "invalid", `${bundle}: ${assessment.reasons.join("\n")}`);
    assert.equal(assessment.authoritative, false);
  }
});

test("fresh-target validation requires safe parents and refuses any existing target type", () => {
  const bundle = temporaryDirectory();
  mkdirSync(path.join(bundle, "results"));
  mkdirSync(path.join(bundle, "state"));
  assert.deepEqual(validateFreshPinnedConcurrentTargets(bundle, {
    groupsRows: groups,
    planRows: plan,
    roundsPerContext: 2,
  }), []);
  writeFileSync(path.join(bundle, "results", "pinned-concurrent.tsv"), "reserved");
  assert.match(validateFreshPinnedConcurrentTargets(bundle).join("\n"), /already exists or is unsafe/);

  const boundaryReserved = temporaryDirectory();
  mkdirSync(path.join(boundaryReserved, "results"));
  mkdirSync(path.join(boundaryReserved, "state"));
  writeFileSync(path.join(boundaryReserved, "results", "pinned-concurrent.boundaries.ndjson"), "reserved");
  assert.match(
    validateFreshPinnedConcurrentTargets(boundaryReserved).join("\n"),
    /pinned-concurrent\.boundaries\.ndjson already exists or is unsafe/,
  );

  const unsafe = temporaryDirectory();
  mkdirSync(path.join(unsafe, "real-results"));
  mkdirSync(path.join(unsafe, "state"));
  symlinkSync("real-results", path.join(unsafe, "results"));
  assert.match(validateFreshPinnedConcurrentTargets(unsafe).join("\n"), /results directory must be a real directory/);
});

test("shell CLI builds canonical metadata and validates pre-run and terminal envelopes", () => {
  const incomplete = createBundle({ resultRows: results.slice(0, 4), completed: false });
  const expectationArgs = [GENERATION, SOURCE_GENERATION, SOURCE_PLAN_DIGEST, "2", "42"];
  const before = spawnSync(
    process.execPath,
    [MODULE_FILE, "validate-before", incomplete.bundle, ...expectationArgs],
    { encoding: "utf8" },
  );
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /^STATUS=incomplete$/m);
  assert.match(before.stdout, /^RESUMABLE_ROW_COUNT=4$/m);

  const complete = createBundle({ marker: false });
  const terminal = spawnSync(
    process.execPath,
    [MODULE_FILE, "validate-complete", complete.bundle, ...expectationArgs],
    { encoding: "utf8" },
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.match(terminal.stdout, /^PUBLICATION_READY=1$/m);

  const built = execFileSync(process.execPath, [
    MODULE_FILE,
    "build-meta",
    "--generation", GENERATION,
    "--source-group-generation", SOURCE_GENERATION,
    "--source-group-plan-digest", SOURCE_PLAN_DIGEST,
    "--rounds", "2",
    "--seed", "42",
    "--groups", path.join(complete.bundle, "results", "pinned-concurrent.groups.tsv"),
    "--plan", path.join(complete.bundle, "results", "pinned-concurrent.plan.tsv"),
    "--results", path.join(complete.bundle, "results", "pinned-concurrent.tsv"),
    "--boundaries", path.join(complete.bundle, "results", "pinned-concurrent.boundaries.ndjson"),
    "--completed", "1",
  ], { encoding: "utf8" });
  assert.equal(
    built,
    readFileSync(path.join(complete.bundle, "results", "pinned-concurrent.meta"), "utf8"),
  );

  const invalid = createBundle();
  writeFileSync(
    path.join(invalid.bundle, "results", "pinned-concurrent.boundaries.ndjson"),
    invalid.boundariesText.replace("\"durationMs\":900", "\"durationMs\":901"),
  );
  const refused = spawnSync(process.execPath, [MODULE_FILE, "validate-complete", invalid.bundle], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^STATUS=invalid$/m);
});
