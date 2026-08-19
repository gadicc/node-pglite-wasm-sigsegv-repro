import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  AttemptEvidenceError,
  attemptEvidenceBinding,
  buildAttemptEvidence,
  canonicalAttemptEvidenceJson,
  canonicalAttemptEvidenceLine,
  parseAttemptEvidence,
} from "../attempt-evidence.mjs";
import { createAttemptRunner, runWorkloadAttempt } from "../attempt-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function resolvedWorkload(args, {
  mode = "exit",
  timeoutMs = 2_000,
  termGraceMs = 50,
  killGraceMs = 500,
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "attempt-evidence-"));
  directories.push(directory);
  return resolveWorkloadSpec({
    version: 1,
    id: "attempt-evidence-fixture",
    label: "Attempt evidence fixture",
    description: "Harmless Node process used to validate internal attempt records.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args,
      cwd: directory,
    },
    environment: {},
    attempt: { mode, timeoutMs, termGraceMs, killGraceMs },
    outcomes: {
      targetSignals: ["SIGUSR2"],
      mappedExits: [
        { code: 42, category: "target-fault", label: "handled-test-fault" },
      ],
    },
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("a runner result becomes canonical workload-bound attempt evidence", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload([
    "-e",
    "require('node:fs').writeSync(1, 'complete')",
  ]);
  const result = await runWorkloadAttempt(resolved, { stdoutExcerptBytes: 64 });
  const record = buildAttemptEvidence(resolved, result);
  const json = canonicalAttemptEvidenceJson(resolved, record);
  const line = canonicalAttemptEvidenceLine(resolved, record);
  const binding = attemptEvidenceBinding(resolved, record);
  const reparsed = parseAttemptEvidence(resolved, JSON.parse(json));

  assert.equal(record.version, 1);
  assert.deepEqual(record.workload, {
    contractVersion: 1,
    digest: resolved.digest,
    id: resolved.id,
  });
  assert.equal(record.outcome.category, "pass");
  assert.equal(record.output.stdout.bytes, "8");
  assert.equal(Buffer.from(record.output.stdout.excerptBase64, "base64").toString(), "complete");
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(reparsed, record);
  assert.equal(line.toString(), `${json}\n`);
  assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(binding.bytes, line.length);
});

test("attempt evidence rejects workload, outcome, boundary, cleanup, and output tampering", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload(["-e", ""]);
  const record = buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));
  const cases = [
    ["version", (value) => { value.version = 2; }],
    ["workload digest", (value) => { value.workload.digest = "0".repeat(64); }],
    ["unknown field", (value) => { value.unknown = true; }],
    ["outcome", (value) => { value.outcome.label = "invented"; }],
    ["boundary", (value) => {
      value.boundary.cleanupFinishedMonotonicNs = "0";
    }],
    ["cleanup", (value) => { value.cleanup.failureReason = "EIO"; }],
    ["output digest", (value) => { value.output.stdout.sha256 = "0".repeat(64); }],
    ["output excerpt", (value) => { value.output.stdout.excerptBase64 = "not base64"; }],
  ];

  for (const [label, mutate] of cases) {
    const tampered = clone(record);
    mutate(tampered);
    assert.throws(() => parseAttemptEvidence(resolved, tampered), AttemptEvidenceError, label);
  }

  const other = resolvedWorkload(["-e", ""]);
  assert.throws(() => parseAttemptEvidence(other, clone(record)), /workload binding/);
});

test("planned termination remains cleanup evidence in a survival-window record", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload(["-e", "setInterval(() => {}, 1000)"], {
    mode: "survive-window",
    timeoutMs: 1_000,
  });
  const record = buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));

  assert.equal(record.observation.terminalReason, "observation-window-elapsed");
  assert.equal(record.observation.exitCode, null);
  assert.equal(record.observation.signal, null);
  assert.equal(record.outcome.category, "pass");
  assert.equal(record.cleanup.term.delivered, true);
  assert.equal(record.cleanup.postTerminalStatus.signal, "SIGTERM");
  assert.doesNotThrow(() => parseAttemptEvidence(resolved, clone(record)));
});

test("operationally incomplete cleanup remains validly structured evidence", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload(["-e", "setInterval(() => {}, 1000)"], {
    mode: "survive-window",
    timeoutMs: 1_000,
    termGraceMs: 20,
    killGraceMs: 200,
  });
  const runner = createAttemptRunner({
    listGroupMembers() {
      throw Object.assign(new Error("simulated observation failure"), { code: "EIO" });
    },
  });
  const record = buildAttemptEvidence(resolved, await runner(resolved));

  assert.equal(record.observation.cleanupComplete, false);
  assert.equal(record.outcome.category, "operational-invalid");
  assert.equal(record.cleanup.groupDrained, false);
  assert.equal(record.cleanup.failureReason, "EIO");
  assert.doesNotThrow(() => parseAttemptEvidence(resolved, clone(record)));
});

test("pre-launch cancellation produces a complete no-process attempt record", async () => {
  const resolved = resolvedWorkload(["-e", "setInterval(() => {}, 1000)"]);
  const controller = new AbortController();
  controller.abort();
  const result = await runWorkloadAttempt(resolved, { signal: controller.signal });
  const record = buildAttemptEvidence(resolved, result);

  assert.equal(record.process.supervisor, null);
  assert.equal(record.process.workload, null);
  assert.equal(record.cleanup.failureReason, null);
  assert.equal(record.observation.terminalReason, "external-cancel");
  assert.equal(record.outcome.category, "operational-invalid");
});
