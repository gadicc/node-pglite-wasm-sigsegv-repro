import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../collect.mjs";
import {
  assessRootChecksEvidence,
  assessRootChecksStage,
  ROOT_CHECK_MARKER_FILE,
  ROOT_CHECK_PAYLOADS,
} from "../root-checks-evidence.mjs";

const GENERATION = "abcdef0123456789abcdef0123456789";
const COLLECTED_AT = "2026-08-02T20:00:00+00:00";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function seal(directory, marker = true) {
  const hashes = Object.fromEntries(ROOT_CHECK_PAYLOADS.map((name) => [
    name,
    digest(readFileSync(path.join(directory, name))),
  ]));
  writeFileSync(path.join(directory, "root-checks.meta"), [
    "VERSION=1",
    `GENERATION=${GENERATION}`,
    `COLLECTED_AT=${COLLECTED_AT}`,
    `KERNEL_WARNINGS_SHA256=${hashes["kernel-warnings.txt"]}`,
    `INTEL_UNDERVOLT_SHA256=${hashes["intel-undervolt.txt"]}`,
    `CCTK_SHA256=${hashes["cctk.txt"]}`,
    `TURBOSTAT_SHA256=${hashes["turbostat.txt"]}`,
    "COMPLETED=1",
    "",
  ].join("\n"));
  if (marker) writeFileSync(path.join(directory, ROOT_CHECK_MARKER_FILE), "");
}

function newBundle(marker = true) {
  const bundle = mkdtempSync(path.join(tmpdir(), "root-check-evidence-"));
  const root = path.join(bundle, "env", "root");
  mkdirSync(root, { recursive: true });
  for (const name of ROOT_CHECK_PAYLOADS) writeFileSync(path.join(root, name), `payload ${name}\n`);
  seal(root, marker);
  return { bundle, root };
}

test("root-checks envelope: accepts an exact complete generation and collector exposes it", () => {
  const { bundle, root } = newBundle();
  const assessment = assessRootChecksEvidence(bundle);
  assert.equal(assessment.status, "complete");
  assert.equal(assessment.generation, GENERATION);
  assert.equal(assessment.collectedAt, COLLECTED_AT);
  assert.match(assessment.rootChecks["cctk.txt"], /payload cctk/);

  const result = collect(bundle);
  assert.equal(result.rootChecksStatus.status, "complete");
  assert.equal(result.rootChecksStatus.generation, GENERATION);
  assert.match(result.rootChecks["intel-undervolt.txt"], /payload intel-undervolt/);

  unlinkSync(path.join(root, ROOT_CHECK_MARKER_FILE));
  assert.equal(assessRootChecksStage(root).status, "complete");
});

test("root-checks envelope: missing, extra, and hash-mismatched evidence fails closed", () => {
  const missing = newBundle();
  unlinkSync(path.join(missing.root, "turbostat.txt"));
  const missingResult = collect(missing.bundle);
  assert.equal(missingResult.rootChecksStatus.status, "incomplete");
  assert.equal(Object.hasOwn(missingResult, "rootChecks"), false);

  const extra = newBundle();
  writeFileSync(path.join(extra.root, "unexpected.txt"), "unexpected\n");
  const extraAssessment = assessRootChecksEvidence(extra.bundle);
  assert.equal(extraAssessment.status, "invalid");
  assert.match(extraAssessment.reasons.join(" "), /unexpected entry/);

  const changed = newBundle();
  appendFileSync(path.join(changed.root, "cctk.txt"), "changed\n");
  const changedResult = collect(changed.bundle);
  assert.equal(changedResult.rootChecksStatus.status, "invalid");
  assert.equal(Object.hasOwn(changedResult, "rootChecks"), false);
  assert.match(changedResult.rootChecksStatus.reasons.join(" "), /digest mismatch/);
});

test("root-checks envelope: symlinked and oversized payloads are invalid", () => {
  const linked = newBundle();
  const outside = path.join(linked.bundle, "outside-root-payload");
  writeFileSync(outside, "outside\n");
  unlinkSync(path.join(linked.root, "kernel-warnings.txt"));
  symlinkSync(outside, path.join(linked.root, "kernel-warnings.txt"));
  const linkedAssessment = assessRootChecksEvidence(linked.bundle);
  assert.equal(linkedAssessment.status, "invalid");
  assert.match(linkedAssessment.reasons.join(" "), /symbolic link/);

  const oversized = newBundle();
  truncateSync(path.join(oversized.root, "turbostat.txt"), 16 * 1024 * 1024 + 1);
  const oversizedAssessment = assessRootChecksEvidence(oversized.bundle);
  assert.equal(oversizedAssessment.status, "invalid");
  assert.match(oversizedAssessment.reasons.join(" "), /exceeds 16777216 bytes/);
});

test("root-checks envelope: malformed metadata and markers cannot authorize payloads", () => {
  const duplicate = newBundle();
  appendFileSync(path.join(duplicate.root, "root-checks.meta"), "COMPLETED=1\n");
  const duplicateAssessment = assessRootChecksEvidence(duplicate.bundle);
  assert.equal(duplicateAssessment.status, "invalid");
  assert.match(duplicateAssessment.reasons.join(" "), /duplicate COMPLETED|exactly 8 records/);

  const unterminated = newBundle();
  const metadata = readFileSync(path.join(unterminated.root, "root-checks.meta"), "utf8");
  writeFileSync(path.join(unterminated.root, "root-checks.meta"), metadata.slice(0, -1));
  const unterminatedAssessment = assessRootChecksEvidence(unterminated.bundle);
  assert.equal(unterminatedAssessment.status, "invalid");
  assert.match(unterminatedAssessment.reasons.join(" "), /not newline-terminated/);

  const marker = newBundle();
  writeFileSync(path.join(marker.root, ROOT_CHECK_MARKER_FILE), "not empty\n");
  const markerAssessment = assessRootChecksEvidence(marker.bundle);
  assert.equal(markerAssessment.status, "invalid");
  assert.match(markerAssessment.reasons.join(" "), /zero bytes/);
});
