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
  assessIndividualEvidence,
  inspectIndividualEvidence,
  readStableRegularFile,
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
