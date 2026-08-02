import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../collect.mjs";
import {
  assessPreflightEvidence,
  PREFLIGHT_FILES,
  PREFLIGHT_SUMMARY_KEYS,
} from "../preflight-evidence.mjs";

const GENERATION = "0123456789abcdef0123456789abcdef";
const EPOCH = "1785686400";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function summaryText(overrides = {}) {
  const values = {
    DISTRO: "TestOS",
    KERNEL: "Linux 6.0-test",
    CMDLINE: "tme=off",
    NODE_VERSION: "v25.2.1",
    V8_VERSION: "14.1-test",
    PGLITE_VERSION: "0.3.0",
    CPU_MODEL: "Test CPU",
    CPU_STEPPING: "1",
    CPU_MICROCODE: "0x123",
    CPU_ADDRESS_SIZES: "46 bits physical, 48 bits virtual",
    CPU_LOGICAL: "2",
    ONLINE_CPUS: "0-1",
    KERNEL_ONLINE_CPUS: "0-1",
    ALLOWED_CPUS: "0-1",
    P_CORES: "0",
    E_CORES: "1",
    DMI_PRODUCT: "Test Product",
    DMI_BOARD: "Test Board",
    BIOS_VERSION: "1.0",
    BIOS_DATE: "01/01/2026",
    CPUFREQ_DRIVER: "intel_pstate",
    GOVERNOR: "powersave",
    EPP: "balance_performance",
    NO_TURBO: "0",
    TME_STATE: "disabled (tme=off on kernel command line)",
    POWER_SOURCE: "AC",
    UNDERVOLT_STATE: "not installed",
    CCTK_STATE: "not installed",
    MISSING_OPTIONAL: "none",
    ...overrides,
  };
  return `${PREFLIGHT_SUMMARY_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

function newBundle() {
  const dir = mkdtempSync(path.join(tmpdir(), "preflight-evidence-"));
  mkdirSync(path.join(dir, "env"));
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "state"));
  for (const name of PREFLIGHT_FILES) {
    let text = `${name}\n`;
    if (name === "date.txt") text = `start_iso=2026-08-02T00:00:00+00:00\nstart_epoch=${EPOCH}\n`;
    if (name === "summary.env") text = summaryText();
    writeFileSync(path.join(dir, "env", name), text);
  }
  writeFileSync(path.join(dir, "results", "meta.env"), [
    "MODE=quick",
    "BASELINE_CHILDREN=8",
    "BASELINE_WAVES=10",
    "GROUP_WAVES=10",
    "INDIVIDUAL_RUNS=5",
    "GDB_MAX_RUNS=6",
    "SKIP_GDB=0",
    "CPU_TARGET=auto",
    "COMPLETED_PHASES=preflight",
    "",
  ].join("\n"));
  seal(dir);
  return dir;
}

function seal(dir) {
  const manifest = PREFLIGHT_FILES.map((name) => {
    const bytes = readFileSync(path.join(dir, "env", name));
    return `${digest(bytes)}\t${name}`;
  }).join("\n") + "\n";
  writeFileSync(path.join(dir, "env", "preflight.manifest"), manifest);
  writeFileSync(path.join(dir, "results", "preflight.meta"), [
    "VERSION=1",
    `GENERATION=${GENERATION}`,
    `COLLECTED_EPOCH=${EPOCH}`,
    `INVENTORY_SHA256=${digest(Buffer.from(manifest))}`,
    "COMPLETED=1",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "state", "phase-preflight.done"), "");
}

test("preflight envelope: accepts one exact generation and collector exposes it", () => {
  const dir = newBundle();
  const assessment = assessPreflightEvidence(dir);
  assert.equal(assessment.status, "complete");
  assert.equal(assessment.generation, GENERATION);
  assert.equal(assessment.environment.CPU_MODEL, "Test CPU");

  const result = collect(dir);
  assert.equal(result.preflightStatus.status, "complete");
  assert.equal(result.preflightStatus.generation, GENERATION);
  assert.equal(result.environment.TME_STATE, "disabled (tme=off on kernel command line)");
});

test("preflight envelope: missing and tampered files fail closed", () => {
  const missing = newBundle();
  unlinkSync(path.join(missing, "env", "power.txt"));
  assert.equal(assessPreflightEvidence(missing).status, "incomplete");
  const missingResult = collect(missing);
  assert.equal(missingResult.preflightStatus.status, "incomplete");
  assert.equal(Object.hasOwn(missingResult, "environment"), false);

  const tampered = newBundle();
  appendFileSync(path.join(tampered, "env", "cpufreq.txt"), "tampered\n");
  assert.equal(assessPreflightEvidence(tampered).status, "invalid");
  const tamperedResult = collect(tampered);
  assert.equal(tamperedResult.preflightStatus.status, "invalid");
  assert.equal(Object.hasOwn(tamperedResult, "environment"), false);
});

test("preflight envelope: symlinks, missing markers, and nonempty markers fail closed", () => {
  const linked = newBundle();
  const outside = path.join(linked, "outside-summary.env");
  writeFileSync(outside, summaryText({ CPU_MODEL: "outside" }));
  unlinkSync(path.join(linked, "env", "summary.env"));
  symlinkSync(outside, path.join(linked, "env", "summary.env"));
  const linkedAssessment = assessPreflightEvidence(linked);
  assert.equal(linkedAssessment.status, "invalid");
  assert.match(linkedAssessment.reasons.join(" "), /symbolic link/);

  const marker = newBundle();
  writeFileSync(path.join(marker, "state", "phase-preflight.done"), "not empty\n");
  const markerAssessment = assessPreflightEvidence(marker);
  assert.equal(markerAssessment.status, "invalid");
  assert.match(markerAssessment.reasons.join(" "), /zero bytes/);

  const missingMarker = newBundle();
  unlinkSync(path.join(missingMarker, "state", "phase-preflight.done"));
  const missingResult = collect(missingMarker);
  assert.equal(missingResult.preflightStatus.status, "incomplete");
  assert.equal(Object.hasOwn(missingResult, "environment"), false);

  const linkedMarker = newBundle();
  const outsideMarker = path.join(linkedMarker, "outside-marker");
  writeFileSync(outsideMarker, "");
  unlinkSync(path.join(linkedMarker, "state", "phase-preflight.done"));
  symlinkSync(outsideMarker, path.join(linkedMarker, "state", "phase-preflight.done"));
  const linkedMarkerResult = collect(linkedMarker);
  assert.equal(linkedMarkerResult.preflightStatus.status, "invalid");
  assert.equal(Object.hasOwn(linkedMarkerResult, "environment"), false);
  assert.match(linkedMarkerResult.preflightStatus.reasons.join(" "), /symbolic link/);
});

test("preflight envelope: duplicate and unterminated summary schemas fail despite matching digests", () => {
  const duplicate = newBundle();
  appendFileSync(path.join(duplicate, "env", "summary.env"), "POWER_SOURCE=battery\n");
  seal(duplicate);
  const duplicateAssessment = assessPreflightEvidence(duplicate);
  assert.equal(duplicateAssessment.status, "invalid");
  assert.match(duplicateAssessment.reasons.join(" "), /duplicate POWER_SOURCE|exactly 29 records/);

  const unterminated = newBundle();
  const summary = readFileSync(path.join(unterminated, "env", "summary.env"), "utf8");
  writeFileSync(path.join(unterminated, "env", "summary.env"), summary.slice(0, -1));
  seal(unterminated);
  const unterminatedAssessment = assessPreflightEvidence(unterminated);
  assert.equal(unterminatedAssessment.status, "invalid");
  assert.match(unterminatedAssessment.reasons.join(" "), /not newline-terminated/);
});

test("preflight envelope: duplicate and unterminated control records fail closed", () => {
  const duplicateManifest = newBundle();
  appendFileSync(
    path.join(duplicateManifest, "env", "preflight.manifest"),
    `${"0".repeat(64)}\tcmdline.txt\n`,
  );
  const manifestAssessment = assessPreflightEvidence(duplicateManifest);
  assert.equal(manifestAssessment.status, "invalid");
  assert.match(manifestAssessment.reasons.join(" "), /duplicate cmdline.txt|exactly 17 records/);

  const unterminatedMeta = newBundle();
  const metaFile = path.join(unterminatedMeta, "results", "preflight.meta");
  const meta = readFileSync(metaFile, "utf8");
  writeFileSync(metaFile, meta.slice(0, -1));
  const metaAssessment = assessPreflightEvidence(unterminatedMeta);
  assert.equal(metaAssessment.status, "invalid");
  assert.match(metaAssessment.reasons.join(" "), /metadata is not newline-terminated/);
});

test("preflight envelope: noncanonical CPU lists and oversized files are invalid", () => {
  for (const value of ["00", "3-1", "0-2,2-3", "0,1"]) {
    const dir = newBundle();
    writeFileSync(path.join(dir, "env", "summary.env"), summaryText({ ONLINE_CPUS: value }));
    seal(dir);
    const assessment = assessPreflightEvidence(dir);
    assert.equal(assessment.status, "invalid", value);
    assert.match(assessment.reasons.join(" "), /ONLINE_CPUS must be a canonical CPU list/);
  }

  const oversized = newBundle();
  writeFileSync(path.join(oversized, "env", "cpufreq.txt"), Buffer.alloc(1024 * 1024 + 1, 0x78));
  seal(oversized);
  const oversizedAssessment = assessPreflightEvidence(oversized);
  assert.equal(oversizedAssessment.status, "invalid");
  assert.match(oversizedAssessment.reasons.join(" "), /cpufreq\.txt exceeds/);
});

test("preflight envelope: stranded publication temporaries prevent authority", () => {
  const dir = newBundle();
  writeFileSync(path.join(dir, "env", ".preflight.manifest.stranded"), "partial\n");
  const assessment = assessPreflightEvidence(dir);
  assert.equal(assessment.status, "incomplete");
  assert.match(assessment.reasons.join(" "), /stale preflight temporary artifacts/);
});
