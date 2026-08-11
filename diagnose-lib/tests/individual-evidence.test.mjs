import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  INDIVIDUAL_META_MAX_BYTES,
  INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT,
  INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES,
  INDIVIDUAL_V6_ROW_MAX_BYTES,
  INDIVIDUAL_V6_STDERR_EXCERPT_MAX_BYTES,
  assessIndividualEvidence,
  inspectIndividualV5Artifacts,
  inspectIndividualV6Artifacts,
  inspectIndividualEvidence,
  readStableRegularFile,
  renderIndividualPlan,
} from "../individual-evidence.mjs";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "individual-evidence-test-"));
  tmpDirs.push(dir);
  return dir;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeBundle(rows = "19\t1\t139\t2\n", metadata = {}) {
  const dir = tempDir();
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  writeFileSync(path.join(dir, "results", "individual.tsv"), rows);
  const bytes = Buffer.from(rows);
  writeFileSync(
    path.join(dir, "results", "individual.meta"),
    `VERSION=${metadata.version ?? "4"}\nGENERATION=${metadata.generation ?? "a".repeat(32)}\nTARGET_CPUS=19\nRUNS_PER_CPU=1\n` +
      `TARGET_POLICY=failed-groups\nGROUP_PLAN_DIGEST=${"b".repeat(64)}\n` +
      (metadata.version === "3" ? "" : `GROUP_GENERATION=${metadata.groupGeneration ?? "c".repeat(32)}\n`) +
      `SKIPPED=0\nCOMPLETED=1\nROWS_SHA256=${sha256(bytes)}\n` +
      `ROWS_BYTES=${bytes.length}\nROW_COUNT=1\n${metadata.extra ?? ""}`,
  );
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  return dir;
}

function boundaryLine(planRow, ordinal) {
  const [, roundText, positionText, cpuText] = planRow.split("\t");
  const startUnixMs = 1_800_000_000_000 + ordinal * 1_000;
  const startMonotonicNs = 5_000_000_000n + BigInt(ordinal) * 1_000_000_000n;
  const durationNs = ordinal % 2 === 0 ? 250_000_123n : 1_000_000_000n;
  const noTurboEnd = ordinal % 3 === 0
    ? { status: "unavailable", errorCode: "ENOENT" }
    : ordinal % 3 === 1
      ? { status: "invalid", errorCode: "UNEXPECTED_VALUE" }
      : 0;
  return JSON.stringify({
    ordinal,
    round: Number(roundText),
    position: Number(positionText),
    cpu: Number(cpuText),
    startUnixMs,
    endUnixMs: startUnixMs + Number(durationNs / 1_000_000n),
    startMonotonicNs: startMonotonicNs.toString(),
    endMonotonicNs: (startMonotonicNs + durationNs).toString(),
    durationNs: durationNs.toString(),
    durationMs: Number(durationNs) / 1_000_000,
    noTurboStart: 1,
    noTurboEnd,
  });
}

function replaceMetaField(metaPath, key, value) {
  const before = readFileSync(metaPath, "utf8");
  const expression = new RegExp(`^${key}=.*$`, "m");
  assert.match(before, expression);
  writeFileSync(metaPath, before.replace(expression, `${key}=${value}`));
}

function writeV5Bundle(options = {}) {
  const dir = tempDir();
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  const cpus = [8, 9, 10];
  const runs = 2;
  const seed = options.seed ?? 20260809;
  const plan = renderIndividualPlan(cpus, runs, seed);
  const planRows = plan.trimEnd().split("\n").slice(1);
  const resultCount = options.resultCount ?? planRows.length;
  const boundaryCount = options.boundaryCount ?? resultCount;
  const rows = planRows.slice(0, resultCount).map((row, index) => {
    const [, round, , cpu] = row.split("\t");
    return `${cpu}\t${round}\t${index === 1 ? 139 : 0}\t${index + 1}\n`;
  }).join("");
  const boundaries = planRows.slice(0, boundaryCount)
    .map((row, index) => `${boundaryLine(row, index + 1)}\n`).join("");
  const results = path.join(dir, "results");
  const planPath = path.join(results, "individual.plan.tsv");
  const rowsPath = path.join(results, "individual.tsv");
  const boundariesPath = path.join(results, "individual.boundaries.ndjson");
  const metaPath = path.join(results, "individual.meta");
  writeFileSync(planPath, plan);
  writeFileSync(rowsPath, rows);
  writeFileSync(boundariesPath, boundaries);
  const completed = options.completed ?? true;
  const terminal = completed
    ? `ROWS_SHA256=${sha256(Buffer.from(rows))}\nROWS_BYTES=${Buffer.byteLength(rows)}\nROW_COUNT=${resultCount}\n` +
      `BOUNDARIES_SHA256=${sha256(Buffer.from(boundaries))}\n` +
      `BOUNDARIES_BYTES=${Buffer.byteLength(boundaries)}\nBOUNDARY_ROW_COUNT=${boundaryCount}\n`
    : "";
  writeFileSync(
    metaPath,
    `VERSION=5\nGENERATION=${"a".repeat(32)}\nTARGET_CPUS=8-10\nRUNS_PER_CPU=${runs}\n` +
      `TARGET_POLICY=all-usable-cpus\nGROUP_PLAN_DIGEST=${"b".repeat(64)}\n` +
      `GROUP_GENERATION=${"c".repeat(32)}\nPROTOCOL=isolated-interleaved-v1\n` +
      `SCHEDULE_SEED=${seed}\nSCHEDULE_ALGORITHM=balanced-cyclic-v1\n` +
      `PLAN_SHA256=${sha256(Buffer.from(plan))}\nPLAN_BYTES=${Buffer.byteLength(plan)}\n` +
      `PLAN_ROW_COUNT=${planRows.length}\nSKIPPED=0\nCOMPLETED=${completed ? 1 : 0}\n` + terminal +
      (options.extraMeta ?? ""),
  );
  if (completed) writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  return { dir, plan, planRows, rows, boundaries, planPath, rowsPath, boundariesPath, metaPath };
}

const V6_HEADER =
  "ordinal\tround\tposition\tcpu\toutcome\texit_code\tsignal\telapsed_sec\tstderr_sha256\tstderr_bytes";

function writeV6Bundle(options = {}) {
  const dir = tempDir();
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  const cpus = [8, 9, 10];
  const runs = 2;
  const seed = options.seed ?? 20260809;
  const plan = renderIndividualPlan(cpus, runs, seed);
  const planRows = plan.trimEnd().split("\n").slice(1);
  const outcomes = options.outcomes ?? [
    { outcome: "pass", exitCode: 0, signal: null, stderr: "" },
    { outcome: "sigsegv", exitCode: null, signal: "SIGSEGV", stderr: "segv\n" },
    { outcome: "other-workload-failure", exitCode: 1, signal: null, stderr: "exit one\n" },
    { outcome: "other-workload-failure", exitCode: null, signal: "SIGABRT", stderr: "abort\n" },
    { outcome: "pass", exitCode: 0, signal: null, stderr: "" },
    { outcome: "pass", exitCode: 0, signal: null, stderr: "" },
  ];
  const resultCount = options.resultCount ?? planRows.length;
  const boundaryCount = options.boundaryCount ?? resultCount;
  const records = planRows.map((row, index) => {
    const [ordinalText, roundText, positionText, cpuText] = row.split("\t");
    const configured = outcomes[index];
    const stderr = Buffer.from(configured.stderr, "utf8");
    const durationNs = 125_000_000n + BigInt(index);
    const startMonotonicNs = 5_000_000_000n + BigInt(index) * 1_000_000_000n;
    const startUnixMs = 1_800_000_000_000 + index * 1_000;
    const common = {
      ordinal: Number(ordinalText),
      round: Number(roundText),
      position: Number(positionText),
      cpu: Number(cpuText),
      outcome: configured.outcome,
      exitCode: configured.exitCode,
      signal: configured.signal,
      stderrSha256: sha256(stderr),
      stderrBytes: String(stderr.length),
    };
    return {
      common,
      elapsedSec: 0,
      boundary: {
        ...common,
        stderrExcerptBase64: stderr.toString("base64"),
        stderrExcerptBytes: stderr.length,
        stderrTruncated: false,
        startUnixMs,
        endUnixMs: startUnixMs + Number(durationNs / 1_000_000n),
        startMonotonicNs: startMonotonicNs.toString(),
        endMonotonicNs: (startMonotonicNs + durationNs).toString(),
        durationNs: durationNs.toString(),
        durationMs: Number(durationNs) / 1_000_000,
        noTurboStart: 0,
        noTurboEnd: 0,
      },
    };
  });
  const rows = `${V6_HEADER}\n${records.slice(0, resultCount).map(({ common, elapsedSec }) => [
    common.ordinal,
    common.round,
    common.position,
    common.cpu,
    common.outcome,
    common.exitCode ?? "-",
    common.signal ?? "-",
    elapsedSec,
    common.stderrSha256,
    common.stderrBytes,
  ].join("\t")).join("\n")}\n`;
  const boundaries = records.slice(0, boundaryCount)
    .map(({ boundary }) => `${JSON.stringify(boundary)}\n`).join("");
  const results = path.join(dir, "results");
  const planPath = path.join(results, "individual.plan.tsv");
  const rowsPath = path.join(results, "individual.tsv");
  const boundariesPath = path.join(results, "individual.boundaries.ndjson");
  const metaPath = path.join(results, "individual.meta");
  writeFileSync(planPath, plan);
  writeFileSync(rowsPath, rows);
  writeFileSync(boundariesPath, boundaries);
  const completed = options.completed ?? true;
  const terminal = completed
    ? `ROWS_SHA256=${sha256(Buffer.from(rows))}\nROWS_BYTES=${Buffer.byteLength(rows)}\nROW_COUNT=${resultCount}\n` +
      `BOUNDARIES_SHA256=${sha256(Buffer.from(boundaries))}\n` +
      `BOUNDARIES_BYTES=${Buffer.byteLength(boundaries)}\nBOUNDARY_ROW_COUNT=${boundaryCount}\n`
    : "";
  writeFileSync(
    metaPath,
    `VERSION=6\nGENERATION=${"a".repeat(32)}\nTARGET_CPUS=8-10\nRUNS_PER_CPU=${runs}\n` +
      `TARGET_POLICY=all-usable-cpus\nGROUP_PLAN_DIGEST=${"b".repeat(64)}\n` +
      `GROUP_GENERATION=${"c".repeat(32)}\nPROTOCOL=isolated-outcomes-v2\n` +
      `SCHEDULE_SEED=${seed}\nSCHEDULE_ALGORITHM=balanced-cyclic-v1\n` +
      `PLAN_SHA256=${sha256(Buffer.from(plan))}\nPLAN_BYTES=${Buffer.byteLength(plan)}\n` +
      `PLAN_ROW_COUNT=${planRows.length}\nSKIPPED=0\nCOMPLETED=${completed ? 1 : 0}\n${terminal}` +
      (options.extraMeta ?? ""),
  );
  if (completed) writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  return { dir, plan, planRows, rows, boundaries, records, planPath, rowsPath, boundariesPath, metaPath };
}

test("individual evidence accepts a stable V4 envelope with exact row bindings", () => {
  const dir = writeBundle();
  const { assessment } = assessIndividualEvidence(dir);
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  assert.equal(assessment.generation, "a".repeat(32));
  assert.equal(assessment.groupGeneration, "c".repeat(32));
  assert.deepEqual(assessment.acceptedRows, []);
  assert.deepEqual(assessment.acceptedSummaries, [{
    cpu: 19,
    runs: 1,
    failures: 1,
    sigsegv: 1,
    otherFailures: 0,
    invalidRuns: [],
    failedRuns: [{ run: 1, rc: 139, signal: "SIGSEGV", elapsedSec: 2 }],
  }]);
});

test("version 5 accepts a complete digest-bound interleaved plan and boundaries", () => {
  const fixture = writeV5Bundle();
  const { evidence, assessment } = assessIndividualEvidence(fixture.dir);
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  assert.equal(assessment.metadataVersion, "5");
  assert.equal(assessment.protocol, "isolated-interleaved-v1");
  assert.equal(assessment.scheduleSeed, 20260809);
  assert.equal(assessment.scheduleAlgorithm, "balanced-cyclic-v1");
  assert.equal(assessment.planRowCount, 6);
  assert.equal(assessment.boundaryRowCount, 6);
  assert.equal(assessment.commonPrefixRowCount, 6);
  assert.equal(assessment.acceptedSummaries.reduce((total, row) => total + row.runs, 0), 6);
  assert.equal(assessment.acceptedSummaries.reduce((total, row) => total + row.sigsegv, 0), 1);
  assert.equal(evidence.planState.sha256, sha256(Buffer.from(fixture.plan)));
  assert.equal(evidence.boundariesState.sha256, sha256(Buffer.from(fixture.boundaries)));

  const standalone = inspectIndividualV5Artifacts({
    planFile: fixture.planPath,
    rowsFile: fixture.rowsPath,
    boundariesFile: fixture.boundariesPath,
    targetCpus: "8-10",
    runsPerCpu: "2",
    scheduleSeed: "20260809",
    requireComplete: true,
  });
  assert.equal(standalone.valid, true, standalone.errors.join("; "));
  assert.equal(standalone.commonPrefixRowCount, 6);
});

test("version 5 exposes exact validated result and boundary rows to a bounded collector", () => {
  const fixture = writeV5Bundle();
  const results = [];
  const boundaries = [];
  const evidence = inspectIndividualEvidence(fixture.dir, {
    onV5Result: (row) => results.push(row),
    onV5Boundary: (row) => boundaries.push(row),
  });
  const assessment = assessIndividualEvidence(fixture.dir).assessment;
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  assert.equal(evidence.metaState.errors.length, 0, evidence.metaState.errors.join("; "));
  assert.equal(results.length, 6);
  assert.equal(boundaries.length, 6);
  assert.deepEqual(results[1], {
    ordinal: 2,
    cpu: Number(fixture.planRows[1].split("\t")[3]),
    run: 1,
    rc: 139,
    elapsedSec: 2,
  });
  assert.equal(boundaries[1].ordinal, results[1].ordinal);
  assert.equal(boundaries[1].cpu, results[1].cpu);
  assert.equal(boundaries[1].round, results[1].run);
});

test("version 5 incomplete evidence exposes only its exact mid-round common prefix", () => {
  const fixture = writeV5Bundle({ completed: false, resultCount: 4, boundaryCount: 4 });
  const { assessment } = assessIndividualEvidence(fixture.dir);
  assert.equal(assessment.status, "incomplete", assessment.reasons.join("; "));
  assert.equal(assessment.commonPrefixRowCount, 4);
  assert.equal(assessment.acceptedSummaries.reduce((total, row) => total + row.runs, 0), 4);
  assert.match(assessment.reasons.join("; "), /not marked complete/);
  assert.doesNotMatch(assessment.reasons.join("; "), /different validated prefix lengths/);

  const uneven = writeV5Bundle({ completed: false, resultCount: 4, boundaryCount: 3 });
  const unevenAssessment = assessIndividualEvidence(uneven.dir).assessment;
  assert.equal(unevenAssessment.status, "incomplete", unevenAssessment.reasons.join("; "));
  assert.equal(unevenAssessment.commonPrefixRowCount, 3);
  assert.equal(unevenAssessment.acceptedSummaries.reduce((total, row) => total + row.runs, 0), 3);
  assert.match(unevenAssessment.reasons.join("; "), /different validated prefix lengths/);
});

test("version 5 rejects schedule seed, plan order, row order, and boundary tampering", () => {
  const seed = writeV5Bundle();
  replaceMetaField(seed.metaPath, "SCHEDULE_SEED", "20260810");
  assert.equal(assessIndividualEvidence(seed.dir).assessment.status, "invalid");

  const plan = writeV5Bundle();
  const planLines = plan.plan.trimEnd().split("\n");
  [planLines[1], planLines[2]] = [planLines[2], planLines[1]];
  const reorderedPlan = `${planLines.join("\n")}\n`;
  writeFileSync(plan.planPath, reorderedPlan);
  replaceMetaField(plan.metaPath, "PLAN_SHA256", sha256(Buffer.from(reorderedPlan)));
  replaceMetaField(plan.metaPath, "PLAN_BYTES", String(Buffer.byteLength(reorderedPlan)));
  const planAssessment = assessIndividualEvidence(plan.dir).assessment;
  assert.equal(planAssessment.status, "invalid");
  assert.match(planAssessment.reasons.join("; "), /plan.*out-of-order/);

  const rows = writeV5Bundle();
  const rowLines = rows.rows.trimEnd().split("\n");
  [rowLines[0], rowLines[1]] = [rowLines[1], rowLines[0]];
  const reorderedRows = `${rowLines.join("\n")}\n`;
  writeFileSync(rows.rowsPath, reorderedRows);
  replaceMetaField(rows.metaPath, "ROWS_SHA256", sha256(Buffer.from(reorderedRows)));
  replaceMetaField(rows.metaPath, "ROWS_BYTES", String(Buffer.byteLength(reorderedRows)));
  const rowsAssessment = assessIndividualEvidence(rows.dir).assessment;
  assert.equal(rowsAssessment.status, "invalid");
  assert.equal(rowsAssessment.commonPrefixRowCount, 0);
  assert.equal(rowsAssessment.acceptedSummaries.reduce((total, row) => total + row.runs, 0), 0);

  const boundaries = writeV5Bundle();
  const boundaryLines = boundaries.boundaries.trimEnd().split("\n");
  const changed = JSON.parse(boundaryLines[0]);
  changed.ordinal = 2;
  boundaryLines[0] = JSON.stringify(changed);
  const reorderedBoundaries = `${boundaryLines.join("\n")}\n`;
  writeFileSync(boundaries.boundariesPath, reorderedBoundaries);
  replaceMetaField(boundaries.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(reorderedBoundaries)));
  replaceMetaField(boundaries.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(reorderedBoundaries)));
  const boundaryAssessment = assessIndividualEvidence(boundaries.dir).assessment;
  assert.equal(boundaryAssessment.status, "invalid");
  assert.match(boundaryAssessment.reasons.join("; "), /noncanonical JSON/);
});

test("version 5 rejects noncanonical boundary JSON, binding tamper, and unknown metadata", () => {
  const noncanonical = writeV5Bundle();
  const boundaryLines = noncanonical.boundaries.trimEnd().split("\n");
  const first = JSON.parse(boundaryLines[0]);
  boundaryLines[0] = JSON.stringify({ cpu: first.cpu, ...first });
  const bytes = `${boundaryLines.join("\n")}\n`;
  writeFileSync(noncanonical.boundariesPath, bytes);
  replaceMetaField(noncanonical.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(bytes)));
  replaceMetaField(noncanonical.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(bytes)));
  assert.equal(assessIndividualEvidence(noncanonical.dir).assessment.status, "invalid");

  const binding = writeV5Bundle();
  replaceMetaField(binding.metaPath, "PLAN_SHA256", "d".repeat(64));
  assert.match(
    assessIndividualEvidence(binding.dir).assessment.reasons.join("; "),
    /plan does not match its recorded binding/,
  );

  const unknown = writeV5Bundle({ extraMeta: "UNEXPECTED_FIELD=1\n" });
  const unknownAssessment = assessIndividualEvidence(unknown.dir).assessment;
  assert.equal(unknownAssessment.status, "invalid");
  assert.match(unknownAssessment.reasons.join("; "), /unknown field/);
});

test("version 5 boundary timing/sensor invariants and completion marker are strict", () => {
  const timing = writeV5Bundle();
  const timingLines = timing.boundaries.trimEnd().split("\n");
  const changedTiming = JSON.parse(timingLines[0]);
  changedTiming.durationMs += 1;
  timingLines[0] = JSON.stringify(changedTiming);
  const timingBytes = `${timingLines.join("\n")}\n`;
  writeFileSync(timing.boundariesPath, timingBytes);
  replaceMetaField(timing.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(timingBytes)));
  replaceMetaField(timing.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(timingBytes)));
  assert.equal(assessIndividualEvidence(timing.dir).assessment.status, "invalid");

  const sensor = writeV5Bundle();
  const sensorLines = sensor.boundaries.trimEnd().split("\n");
  const changedSensor = JSON.parse(sensorLines[0]);
  changedSensor.noTurboEnd = { status: "unavailable", errorCode: "lowercase" };
  sensorLines[0] = JSON.stringify(changedSensor);
  const sensorBytes = `${sensorLines.join("\n")}\n`;
  writeFileSync(sensor.boundariesPath, sensorBytes);
  replaceMetaField(sensor.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(sensorBytes)));
  replaceMetaField(sensor.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(sensorBytes)));
  assert.equal(assessIndividualEvidence(sensor.dir).assessment.status, "invalid");

  const missingMarker = writeV5Bundle();
  rmSync(path.join(missingMarker.dir, "state", "phase-individual.done"));
  assert.equal(assessIndividualEvidence(missingMarker.dir).assessment.status, "invalid");

  const prematureMarker = writeV5Bundle({ completed: false, resultCount: 1, boundaryCount: 1 });
  writeFileSync(path.join(prematureMarker.dir, "state", "phase-individual.done"), "");
  assert.equal(assessIndividualEvidence(prematureMarker.dir).assessment.status, "invalid");
});

test("version 5 rejects unsafe plan and boundary files and foreign ownership", () => {
  for (const property of ["planPath", "boundariesPath"]) {
    const symlink = writeV5Bundle();
    const file = symlink[property];
    renameSync(file, `${file}.real`);
    symlinkSync(`${file}.real`, file);
    assert.equal(assessIndividualEvidence(symlink.dir).assessment.status, "invalid", `symlink ${property}`);

    const hardlink = writeV5Bundle();
    linkSync(hardlink[property], `${hardlink[property]}.second-link`);
    assert.equal(assessIndividualEvidence(hardlink.dir).assessment.status, "invalid", `hardlink ${property}`);
  }

  const owner = writeV5Bundle();
  const wrongOwner = (process.geteuid?.() ?? process.getuid()) + 1;
  const ownerAssessment = assessIndividualEvidence(owner.dir, { requiredOwner: wrongOwner }).assessment;
  assert.equal(ownerAssessment.status, "invalid");
  assert.match(ownerAssessment.reasons.join("; "), /owned by the current user/);
});

test("version 5 rejects huge plan/boundary artifacts and terminal fields on an incomplete run", () => {
  const hugePlan = writeV5Bundle();
  writeFileSync(hugePlan.planPath, Buffer.alloc(412, 0x31));
  assert.match(assessIndividualEvidence(hugePlan.dir).assessment.reasons.join("; "), /plan exceeds.*size limit/);

  const hugeBoundaries = writeV5Bundle();
  writeFileSync(hugeBoundaries.boundariesPath, Buffer.alloc(6 * 512 + 1, 0x31));
  assert.match(assessIndividualEvidence(hugeBoundaries.dir).assessment.reasons.join("; "), /boundaries exceeds.*size limit/);

  const incomplete = writeV5Bundle({ completed: false, resultCount: 1, boundaryCount: 1 });
  writeFileSync(
    incomplete.metaPath,
    `${readFileSync(incomplete.metaPath, "utf8")}ROWS_SHA256=${sha256(Buffer.from(incomplete.rows))}\n` +
      `ROWS_BYTES=${Buffer.byteLength(incomplete.rows)}\nROW_COUNT=1\n`,
  );
  const incompleteAssessment = assessIndividualEvidence(incomplete.dir).assessment;
  assert.equal(incompleteAssessment.status, "invalid");
  assert.match(incompleteAssessment.reasons.join("; "), /terminal row or boundary bindings|partially present/);
});

test("version 5 shell commands generate plans and validate complete bindings", () => {
  const fixture = writeV5Bundle();
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "individual-evidence.mjs");
  const generated = spawnSync(process.execPath, [script, "v5-plan", "8-10", "2", "20260809"]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  assert.equal(generated.stdout.toString(), fixture.plan);

  const binding = spawnSync(process.execPath, [
    script, "v5-binding", fixture.planPath, fixture.rowsPath, fixture.boundariesPath,
    "8-10", "2", "20260809", "1",
  ]);
  assert.equal(binding.status, 0, binding.stderr.toString());
  assert.match(binding.stdout.toString(), new RegExp(`^PLAN_SHA256=${sha256(Buffer.from(fixture.plan))}$`, "m"));
  assert.match(binding.stdout.toString(), /^ROW_COUNT=6$/m);
  assert.match(binding.stdout.toString(), /^BOUNDARY_ROW_COUNT=6$/m);

  const bundle = spawnSync(process.execPath, [script, "v5-bundle", fixture.dir]);
  assert.equal(bundle.status, 0, bundle.stderr.toString());
  assert.match(bundle.stdout.toString(), /^STATUS=complete$/m);
  assert.match(bundle.stdout.toString(), /^COMMON_PREFIX_ROW_COUNT=6$/m);
});

test("version 6 keeps other workload failures outside the clean/SIGSEGV denominator", () => {
  const fixture = writeV6Bundle();
  const exactResults = [];
  const exactBoundaries = [];
  const { evidence, assessment } = assessIndividualEvidence(fixture.dir, {
    onV6Result: (row) => exactResults.push(row),
    onV6Boundary: (row) => exactBoundaries.push(row),
  });
  assert.equal(assessment.status, "complete", assessment.reasons.join("; "));
  assert.equal(assessment.metadataVersion, "6");
  assert.equal(assessment.protocol, "isolated-outcomes-v2");
  assert.equal(assessment.commonPrefixRowCount, 6);
  assert.equal(assessment.otherWorkloadFailures, 2);
  assert.equal(assessment.primaryEligibleRuns, 4);
  assert.equal(assessment.acceptedSummaries.reduce((sum, row) => sum + row.observations, 0), 6);
  assert.equal(assessment.acceptedSummaries.reduce((sum, row) => sum + row.runs, 0), 4);
  assert.equal(assessment.acceptedSummaries.reduce((sum, row) => sum + row.passes, 0), 3);
  assert.equal(assessment.acceptedSummaries.reduce((sum, row) => sum + row.sigsegv, 0), 1);
  assert.equal(assessment.acceptedSummaries.reduce(
    (sum, row) => sum + row.otherWorkloadFailures, 0,
  ), 2);
  assert.deepEqual(exactResults.map((row) => row.outcome), [
    "pass", "sigsegv", "other-workload-failure", "other-workload-failure", "pass", "pass",
  ]);
  assert.equal(exactResults[2].exitCode, 1);
  assert.equal(exactResults[3].signal, "SIGABRT");
  assert.equal(exactBoundaries[2].stderrExcerptBase64, Buffer.from("exit one\n").toString("base64"));
  assert.equal(evidence.rowsState.sha256, sha256(Buffer.from(fixture.rows)));
  assert.equal(evidence.boundariesState.sha256, sha256(Buffer.from(fixture.boundaries)));

  const literal139 = writeV6Bundle({
    outcomes: [
      { outcome: "other-workload-failure", exitCode: 139, signal: null, stderr: "literal 139\n" },
      ...Array.from({ length: 5 }, () => ({
        outcome: "pass", exitCode: 0, signal: null, stderr: "",
      })),
    ],
  });
  const literal139Assessment = assessIndividualEvidence(literal139.dir).assessment;
  assert.equal(literal139Assessment.status, "complete");
  assert.equal(literal139Assessment.otherWorkloadFailures, 1);
  assert.equal(literal139Assessment.primaryEligibleRuns, 5);
  assert.equal(literal139Assessment.acceptedSummaries.reduce(
    (sum, record) => sum + record.sigsegv, 0,
  ), 0);

  const standalone = inspectIndividualV6Artifacts({
    planFile: fixture.planPath,
    rowsFile: fixture.rowsPath,
    boundariesFile: fixture.boundariesPath,
    targetCpus: "8-10",
    runsPerCpu: "2",
    scheduleSeed: "20260809",
    requireComplete: true,
  });
  assert.equal(standalone.valid, true, standalone.errors.join("; "));
  assert.equal(standalone.commonPrefixRowCount, 6);
});

test("version 6 incomplete prefixes advance across an other workload failure", () => {
  const fixture = writeV6Bundle({ completed: false, resultCount: 1, boundaryCount: 1 });
  const { assessment } = assessIndividualEvidence(fixture.dir);
  assert.equal(assessment.status, "incomplete", assessment.reasons.join("; "));
  assert.equal(assessment.commonPrefixRowCount, 1);
  assert.equal(assessment.acceptedSummaries.reduce((sum, row) => sum + row.observations, 0), 1);

  const otherFirst = writeV6Bundle({
    completed: false,
    resultCount: 1,
    boundaryCount: 1,
    outcomes: [
      { outcome: "other-workload-failure", exitCode: 1, signal: null, stderr: "first failed\n" },
      ...Array.from({ length: 5 }, () => ({ outcome: "pass", exitCode: 0, signal: null, stderr: "" })),
    ],
  });
  const advanced = assessIndividualEvidence(otherFirst.dir).assessment;
  assert.equal(advanced.status, "incomplete", advanced.reasons.join("; "));
  assert.equal(advanced.commonPrefixRowCount, 1);
  assert.equal(advanced.otherWorkloadFailures, 1);
  assert.equal(advanced.primaryEligibleRuns, 0);
  assert.equal(advanced.acceptedSummaries[0].observations, 1);
  assert.equal(advanced.acceptedSummaries[0].runs, 0);
});

test("version 6 rejects operational outcomes and exact status or stderr tampering", () => {
  for (const mutateRows of [
    (fields) => { fields[4] = "operational-invalid"; },
    (fields) => { fields[4] = "pass"; },
    (fields) => { fields[7] = "1"; },
    (fields) => { fields[9] = "999"; },
    (fields) => { fields[5] = "-"; fields[6] = "SIGBANANA"; },
  ]) {
    const fixture = writeV6Bundle();
    const lines = fixture.rows.trimEnd().split("\n");
    const fields = lines[3].split("\t");
    mutateRows(fields);
    lines[3] = fields.join("\t");
    const bytes = `${lines.join("\n")}\n`;
    writeFileSync(fixture.rowsPath, bytes);
    replaceMetaField(fixture.metaPath, "ROWS_SHA256", sha256(Buffer.from(bytes)));
    replaceMetaField(fixture.metaPath, "ROWS_BYTES", String(Buffer.byteLength(bytes)));
    assert.equal(assessIndividualEvidence(fixture.dir).assessment.status, "invalid");
  }

  const boundary = writeV6Bundle();
  const lines = boundary.boundaries.trimEnd().split("\n");
  const changed = JSON.parse(lines[2]);
  changed.stderrExcerptBase64 = Buffer.from("different").toString("base64");
  changed.stderrExcerptBytes = 9;
  lines[2] = JSON.stringify(changed);
  const bytes = `${lines.join("\n")}\n`;
  writeFileSync(boundary.boundariesPath, bytes);
  replaceMetaField(boundary.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(bytes)));
  replaceMetaField(boundary.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(bytes)));
  assert.equal(assessIndividualEvidence(boundary.dir).assessment.status, "invalid");

  const unsafeBoundary = writeV6Bundle();
  const unsafeLines = unsafeBoundary.boundaries.trimEnd().split("\n");
  const unsafe = JSON.parse(unsafeLines[0]);
  unsafe.noTurboStart = { status: "unavailable", errorCode: "ENOENT" };
  unsafeLines[0] = JSON.stringify(unsafe);
  const unsafeBytes = `${unsafeLines.join("\n")}\n`;
  writeFileSync(unsafeBoundary.boundariesPath, unsafeBytes);
  replaceMetaField(unsafeBoundary.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(unsafeBytes)));
  replaceMetaField(unsafeBoundary.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(unsafeBytes)));
  assert.equal(assessIndividualEvidence(unsafeBoundary.dir).assessment.status, "invalid");

  const oversizedStderr = writeV6Bundle();
  const oversizedLines = oversizedStderr.boundaries.trimEnd().split("\n");
  const oversized = JSON.parse(oversizedLines[0]);
  const oversizedExcerpt = Buffer.alloc(INDIVIDUAL_V6_STDERR_EXCERPT_MAX_BYTES + 1, 0x78);
  oversized.stderrSha256 = sha256(oversizedExcerpt);
  oversized.stderrBytes = String(oversizedExcerpt.length);
  oversized.stderrExcerptBase64 = oversizedExcerpt.toString("base64");
  oversized.stderrExcerptBytes = oversizedExcerpt.length;
  oversized.stderrTruncated = false;
  oversizedLines[0] = JSON.stringify(oversized);
  const oversizedBytes = `${oversizedLines.join("\n")}\n`;
  writeFileSync(oversizedStderr.boundariesPath, oversizedBytes);
  replaceMetaField(oversizedStderr.metaPath, "BOUNDARIES_SHA256", sha256(Buffer.from(oversizedBytes)));
  replaceMetaField(oversizedStderr.metaPath, "BOUNDARIES_BYTES", String(Buffer.byteLength(oversizedBytes)));
  assert.equal(assessIndividualEvidence(oversizedStderr.dir).assessment.status, "invalid");
});

test("version 6 shell commands validate final bindings and the complete bundle", () => {
  const fixture = writeV6Bundle();
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "individual-evidence.mjs");
  const binding = spawnSync(process.execPath, [
    script, "v6-binding", fixture.planPath, fixture.rowsPath, fixture.boundariesPath,
    "8-10", "2", "20260809", "1",
  ]);
  assert.equal(binding.status, 0, binding.stderr.toString());
  assert.match(binding.stdout.toString(), /^ROW_COUNT=6$/m);
  assert.match(binding.stdout.toString(), /^BOUNDARY_ROW_COUNT=6$/m);

  const bundle = spawnSync(process.execPath, [script, "v6-bundle", fixture.dir]);
  assert.equal(bundle.status, 0, bundle.stderr.toString());
  assert.match(bundle.stdout.toString(), /^STATUS=complete$/m);
  assert.match(bundle.stdout.toString(), /^COMMON_PREFIX_ROW_COUNT=6$/m);
});

test("version 6 preserves no-follow, single-link, and artifact-size protections", () => {
  for (const relative of [
    "results/individual.plan.tsv",
    "results/individual.tsv",
    "results/individual.boundaries.ndjson",
  ]) {
    const symlinked = writeV6Bundle();
    const symlinkFile = path.join(symlinked.dir, relative);
    renameSync(symlinkFile, `${symlinkFile}.real`);
    symlinkSync(`${symlinkFile}.real`, symlinkFile);
    assert.equal(
      assessIndividualEvidence(symlinked.dir).assessment.status,
      "invalid",
      `V6 symlink ${relative}`,
    );

    const hardlinked = writeV6Bundle();
    const hardlinkFile = path.join(hardlinked.dir, relative);
    linkSync(hardlinkFile, `${hardlinkFile}.second-link`);
    assert.equal(
      assessIndividualEvidence(hardlinked.dir).assessment.status,
      "invalid",
      `V6 hardlink ${relative}`,
    );
  }

  const hugeRows = writeV6Bundle();
  writeFileSync(hugeRows.rowsPath, Buffer.alloc(Number(6n * INDIVIDUAL_V6_ROW_MAX_BYTES + 1n), 0x31));
  assert.match(
    assessIndividualEvidence(hugeRows.dir).assessment.reasons.join("; "),
    /size limit/,
  );

  const hugeBoundaries = writeV6Bundle();
  writeFileSync(
    hugeBoundaries.boundariesPath,
    Buffer.alloc(Number(6n * INDIVIDUAL_V6_BOUNDARY_ROW_MAX_BYTES + 1n), 0x31),
  );
  assert.match(
    assessIndividualEvidence(hugeBoundaries.dir).assessment.reasons.join("; "),
    /size limit/,
  );
});

test("version 4 individual evidence requires the exact validated groups generation", () => {
  const missing = writeBundle("19\t1\t139\t2\n", { groupGeneration: undefined, extra: "" });
  writeFileSync(
    path.join(missing, "results", "individual.meta"),
    readFileSync(path.join(missing, "results", "individual.meta"), "utf8")
      .replace(`GROUP_GENERATION=${"c".repeat(32)}\n`, ""),
  );
  const missingResult = assessIndividualEvidence(missing);
  assert.equal(missingResult.assessment.status, "invalid");
  assert.match(missingResult.assessment.reasons.join("; "), /group generation is missing or invalid/);

  for (const groupGeneration of ["C".repeat(32), "c".repeat(31), "c".repeat(64), "../outside"]) {
    const dir = writeBundle("19\t1\t139\t2\n", { groupGeneration });
    const { assessment } = assessIndividualEvidence(dir);
    assert.equal(assessment.status, "invalid", groupGeneration);
    assert.match(assessment.reasons.join("; "), /group generation is missing or invalid/);
  }
});

test("legacy V1/V2/V3 individual envelopes reject a smuggled group generation", () => {
  const version3 = writeBundle("19\t1\t139\t2\n", { version: "3" });
  const legacy = assessIndividualEvidence(version3);
  assert.equal(legacy.assessment.status, "complete", legacy.assessment.reasons.join("; "));
  assert.equal(legacy.assessment.metadataVersion, "3");
  assert.equal(legacy.assessment.groupGeneration, null);

  const smuggled3 = writeBundle("19\t1\t139\t2\n", {
    version: "3",
    extra: `GROUP_GENERATION=${"c".repeat(32)}\n`,
  });
  const smuggled3Result = assessIndividualEvidence(smuggled3);
  assert.equal(smuggled3Result.assessment.status, "invalid");
  assert.match(smuggled3Result.assessment.reasons.join("; "), /unsupported group generation field/);

  const version2 = tempDir();
  mkdirSync(path.join(version2, "results"));
  mkdirSync(path.join(version2, "state"));
  writeFileSync(path.join(version2, "results", "individual.tsv"), "19\t1\t139\t2\n");
  writeFileSync(
    path.join(version2, "results", "individual.meta"),
    `VERSION=2\nTARGET_CPUS=19\nRUNS_PER_CPU=1\nTARGET_POLICY=failed-groups\n` +
      `GROUP_PLAN_DIGEST=${"b".repeat(64)}\nGROUP_GENERATION=${"c".repeat(32)}\nSKIPPED=0\nCOMPLETED=0\n`,
  );
  const version2Result = assessIndividualEvidence(version2);
  assert.equal(version2Result.assessment.status, "invalid");
  assert.match(version2Result.assessment.reasons.join("; "), /unsupported row binding fields/);

  const version1 = tempDir();
  mkdirSync(path.join(version1, "results"));
  mkdirSync(path.join(version1, "state"));
  writeFileSync(path.join(version1, "results", "individual.tsv"), "19\t1\t139\t2\n");
  writeFileSync(
    path.join(version1, "results", "individual.meta"),
    `VERSION=1\nTARGET_CPUS=19\nRUNS_PER_CPU=1\nGROUP_GENERATION=${"c".repeat(32)}\nSKIPPED=0\nCOMPLETED=1\n`,
  );
  const version1Result = assessIndividualEvidence(version1);
  assert.equal(version1Result.assessment.status, "invalid");
  assert.match(version1Result.assessment.reasons.join("; "), /unsupported provenance fields/);
});

test("shell-facing meta and bundle outputs carry the group generation", () => {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "individual-evidence.mjs");
  const dir = writeBundle();
  const meta = spawnSync(process.execPath, [script, "meta", path.join(dir, "results", "individual.meta")]);
  assert.equal(meta.status, 0, meta.stderr.toString());
  assert.match(meta.stdout.toString(), new RegExp(`^GROUP_GENERATION=${"c".repeat(32)}$`, "m"));

  const bundle = spawnSync(process.execPath, [script, "bundle", dir]);
  assert.equal(bundle.status, 0, bundle.stderr.toString());
  assert.match(bundle.stdout.toString(), /^STATUS=complete$/m);
  assert.match(bundle.stdout.toString(), new RegExp(`^GROUP_GENERATION=${"c".repeat(32)}$`, "m"));

  const legacy = writeBundle("19\t1\t139\t2\n", { version: "3" });
  const legacyMeta = spawnSync(process.execPath, [script, "meta", path.join(legacy, "results", "individual.meta")]);
  assert.equal(legacyMeta.status, 0, legacyMeta.stderr.toString());
  assert.match(legacyMeta.stdout.toString(), /^VERSION=3$/m);
  assert.match(legacyMeta.stdout.toString(), /^GROUP_GENERATION=$/m);
});

test("individual evidence rejects symlinked and multiply-linked artifacts", () => {
  for (const relative of [
    "results/individual.tsv",
    "results/individual.meta",
    "state/phase-individual.done",
  ]) {
    const symlinkDir = writeBundle();
    const file = path.join(symlinkDir, relative);
    renameSync(file, `${file}.real`);
    symlinkSync(`${file}.real`, file);
    assert.equal(assessIndividualEvidence(symlinkDir).assessment.status, "invalid", `symlink ${relative}`);

    const hardlinkDir = writeBundle();
    const hardlinkFile = path.join(hardlinkDir, relative);
    linkSync(hardlinkFile, `${hardlinkFile}.second-link`);
    assert.equal(assessIndividualEvidence(hardlinkDir).assessment.status, "invalid", `hardlink ${relative}`);
  }
});

test("individual evidence enforces metadata and semantic TSV byte caps", () => {
  const metaDir = writeBundle();
  writeFileSync(
    path.join(metaDir, "results", "individual.meta"),
    Buffer.alloc(INDIVIDUAL_META_MAX_BYTES + 1, 0x41),
  );
  assert.match(
    assessIndividualEvidence(metaDir).assessment.reasons.join("; "),
    /size limit/,
  );

  const rowsDir = writeBundle();
  writeFileSync(path.join(rowsDir, "results", "individual.tsv"), Buffer.alloc(45, 0x31));
  assert.match(
    assessIndividualEvidence(rowsDir).assessment.reasons.join("; "),
    /size limit/,
  );
});

test("individual evidence rejects row amplification within the byte cap", () => {
  const dir = writeBundle();
  writeFileSync(path.join(dir, "results", "individual.tsv"), "\n".repeat(44));
  assert.match(
    assessIndividualEvidence(dir).assessment.reasons.join("; "),
    /row limit/,
  );
});

test("streaming rows enforce the 44-byte logical-line and row-sentinel boundaries", () => {
  const withinLine = writeBundle();
  writeFileSync(path.join(withinLine, "results", "individual.tsv"), "x".repeat(44));
  const within = inspectIndividualEvidence(withinLine);
  assert.doesNotMatch(within.rowsState.errors.join("; "), /line exceeding/);

  const overlong = writeBundle();
  writeFileSync(path.join(overlong, "results", "individual.tsv"), "x".repeat(45));
  writeFileSync(
    path.join(overlong, "results", "individual.meta"),
    `VERSION=2\nTARGET_CPUS=19\nRUNS_PER_CPU=2\nTARGET_POLICY=failed-groups\n` +
      `GROUP_PLAN_DIGEST=${"b".repeat(64)}\nSKIPPED=0\nCOMPLETED=0\n`,
  );
  const tooLong = inspectIndividualEvidence(overlong);
  assert.match(tooLong.rowsState.errors.join("; "), /line exceeding 44 bytes/);
  assert.deepEqual(tooLong.rowsState.summary.summaries, []);

  const sentinel = writeBundle();
  writeFileSync(path.join(sentinel, "results", "individual.tsv"), "19\t1\t0\t1\n19\t1\t0\t1\n");
  const beyond = inspectIndividualEvidence(sentinel);
  assert.match(beyond.rowsState.errors.join("; "), /row limit/);
  assert.equal(beyond.rowsState.rowCount, 2);
  assert.deepEqual(beyond.rowsState.summary.summaries, []);
});

test("semantically huge sparse rows stop after constant read amplification", () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  const rows = path.join(dir, "results", "individual.tsv");
  writeFileSync(rows, "x");
  truncateSync(rows, 1024 * 1024 * 1024);
  writeFileSync(
    path.join(dir, "results", "individual.meta"),
    `VERSION=2\nTARGET_CPUS=19\nRUNS_PER_CPU=${Number.MAX_SAFE_INTEGER}\n` +
      `TARGET_POLICY=failed-groups\nGROUP_PLAN_DIGEST=${"b".repeat(64)}\n` +
      "SKIPPED=0\nCOMPLETED=0\n",
  );
  const evidence = inspectIndividualEvidence(dir);
  assert.equal(evidence.rowsState.completeRead, false);
  assert.ok(evidence.rowsState.inspectedBytes <= 64 * 1024);
  assert.ok(evidence.rowsState.inspectedBytes < evidence.rowsState.bytes);
  assert.match(evidence.rowsState.errors.join("; "), /line exceeding 44 bytes/);
  assert.deepEqual(evidence.rowsState.summary.summaries, []);
});

test("failed-run presentation details have a global bound with explicit omission", () => {
  const count = INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT + 1;
  const rows = Array.from({ length: count }, (_, index) => `19\t${index + 1}\t139\t1\n`).join("");
  const dir = writeBundle(rows);
  const bytes = Buffer.from(rows);
  writeFileSync(
    path.join(dir, "results", "individual.meta"),
    `VERSION=4\nGENERATION=${"a".repeat(32)}\nTARGET_CPUS=19\nRUNS_PER_CPU=${count}\n` +
      `TARGET_POLICY=failed-groups\nGROUP_PLAN_DIGEST=${"b".repeat(64)}\n` +
      `GROUP_GENERATION=${"c".repeat(32)}\n` +
      `SKIPPED=0\nCOMPLETED=1\nROWS_SHA256=${sha256(bytes)}\n` +
      `ROWS_BYTES=${bytes.length}\nROW_COUNT=${count}\n`,
  );
  const { assessment } = assessIndividualEvidence(dir);
  assert.equal(assessment.status, "complete");
  assert.equal(assessment.acceptedSummaries[0].failures, count);
  assert.equal(assessment.acceptedSummaries[0].failedRuns.length, INDIVIDUAL_FAILED_RUN_DETAIL_LIMIT);
  assert.equal(assessment.acceptedSummaries[0].failedRunsOmitted, 1);
  assert.equal(assessment.failedRunDetailsTruncated, true);
  assert.equal(assessment.failedRunDetailsOmitted, 1);
});

test("batch validation considers only the newly appended tail", () => {
  const dir = tempDir();
  const rows = path.join(dir, "individual.tsv");
  writeFileSync(rows, "19\t1\t139\t1\n19\t2\t0\t1\n");
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "individual-evidence.mjs");
  const result = spawnSync(process.execPath, [script, "batch", rows, "19", "2", "19", "1", "1"]);
  assert.equal(result.status, 1);
});

test("stable file reads reject pathname replacement and in-place mutation", () => {
  const replacementDir = tempDir();
  const replacementFile = path.join(replacementDir, "artifact");
  writeFileSync(replacementFile, "original\n");
  const replacement = readStableRegularFile(replacementFile, 64, "artifact", {
    afterRead() {
      renameSync(replacementFile, `${replacementFile}.old`);
      writeFileSync(replacementFile, "replaced\n");
    },
  });
  assert.equal(replacement.bytes, null);
  assert.match(replacement.errors.join("; "), /changed while being read/);

  const mutationDir = tempDir();
  const mutationFile = path.join(mutationDir, "artifact");
  writeFileSync(mutationFile, "before!!\n");
  const mutation = readStableRegularFile(mutationFile, 64, "artifact", {
    afterRead() {
      writeFileSync(mutationFile, "after!!!\n");
    },
  });
  assert.equal(mutation.bytes, null);
  assert.match(mutation.errors.join("; "), /changed while being read/);
});

test("one envelope read detects post-read marker, metadata, and TSV mutation", () => {
  const markerDir = writeBundle();
  const marker = path.join(markerDir, "state", "phase-individual.done");
  const markerEvidence = inspectIndividualEvidence(markerDir, {
    beforeFinalVerify() {
      renameSync(marker, `${marker}.old`);
      writeFileSync(marker, "");
    },
  });
  assert.equal(markerEvidence.phaseDone, false);
  assert.match(markerEvidence.metaState.errors.join("; "), /changed while being read/);

  const rowsDir = writeBundle();
  const rows = path.join(rowsDir, "results", "individual.tsv");
  const rowsEvidence = inspectIndividualEvidence(rowsDir, {
    beforeFinalVerify() {
      renameSync(rows, `${rows}.old`);
      writeFileSync(rows, "19\t1\t0\t002\n");
    },
  });
  assert.match(rowsEvidence.metaState.errors.join("; "), /changed while being read/);
  assert.deepEqual(rowsEvidence.rowsState.summary.summaries, []);

  const metaDir = writeBundle();
  const meta = path.join(metaDir, "results", "individual.meta");
  const metaResult = assessIndividualEvidence(metaDir, {
    beforeFinalVerify() {
      writeFileSync(meta, "replacement metadata\n");
    },
  });
  assert.equal(metaResult.assessment.status, "invalid");
  assert.match(metaResult.assessment.reasons.join("; "), /metadata changed while being read/);
  assert.deepEqual(metaResult.assessment.acceptedSummaries, []);
});

test("held parent descriptors defeat a restored bundle-root ABA splice", () => {
  const original = writeBundle("19\t1\t0\t2\n");
  const foreign = writeBundle("19\t1\t139\t2\n", { generation: "c".repeat(32) });
  const heldOriginal = `${original}.held-for-aba`;
  tmpDirs.push(heldOriginal);
  let swapped = false;
  const { assessment } = assessIndividualEvidence(original, {
    afterDirectoriesOpened() {
      renameSync(original, heldOriginal);
      renameSync(foreign, original);
      swapped = true;
    },
    beforeDirectoryVerify() {
      assert.equal(swapped, true);
      renameSync(original, foreign);
      renameSync(heldOriginal, original);
      swapped = false;
    },
  });
  assert.equal(swapped, false);
  assert.equal(assessment.status, "invalid");
  assert.match(assessment.reasons.join("; "), /bundle root changed while being read/);
  // The root rename itself invalidates the public bundle binding. Even before
  // that fail-closed result, anchored child lookups inspected A (generation a),
  // never the temporarily mapped foreign envelope (generation c).
  assert.equal(assessment.generation, "a".repeat(32));
  assert.deepEqual(assessment.acceptedSummaries, []);
});
