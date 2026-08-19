import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { buildAttemptEvidence } from "../attempt-evidence.mjs";
import { runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  BaselinePhaseError,
  assessBaselinePhasePrefix,
  baselinePhaseManifestBinding,
  baselineWaveEnvelopeBinding,
  buildBaselinePhaseManifest,
  buildBaselineWaveEnvelope,
  canonicalBaselinePhaseManifestLine,
  canonicalBaselineWaveEnvelopeLine,
  parseBaselinePhaseManifest,
  parseBaselineWaveEnvelope,
  runNextBaselinePhaseWave,
} from "../baseline-phase.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function resolvedWorkload({ baseline = true, source = "" } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "baseline-phase-"));
  directories.push(cwd);
  return resolveWorkloadSpec({
    version: 1,
    id: baseline ? "baseline-phase-fixture" : "baseline-disabled-fixture",
    label: "Baseline phase fixture",
    description: "Harmless finite process used to validate concurrent-wave evidence.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", source], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGUSR2"], mappedExits: [] },
    capabilities: { baseline },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, overrides = {}) {
  return buildBaselinePhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    childrenPerWave: 3,
    waves: 2,
    ...overrides,
  });
}

async function validEvidence(resolved) {
  return buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));
}

test("baseline manifests bind one workload and a deterministic concurrent-wave schedule", () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const line = canonicalBaselinePhaseManifestLine(resolved, phase);
  const binding = baselinePhaseManifestBinding(resolved, phase);

  assert.equal(phase.phase, "baseline-concurrent");
  assert.equal(phase.schedule.childrenPerWave, 3);
  assert.equal(phase.schedule.waves, 2);
  assert.equal(phase.schedule.attemptCount, 6);
  assert.equal(phase.execution.concurrencyMode, "independent-supervisors-v1");
  assert.equal(line.at(-1), 0x0a);
  assert.equal(binding.bytes, line.length);
  assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(phase, manifest(resolved));
  assert.notEqual(phase.schedule.digest,
    manifest(resolved, { childrenPerWave: 2 }).schedule.digest);

  const disabled = resolvedWorkload({ baseline: false });
  assert.throws(() => manifest(disabled), /does not declare baseline/);
});

test("baseline manifests reject identity, generation, schedule, and execution tampering", () => {
  const resolved = resolvedWorkload();
  const original = manifest(resolved);
  const cases = [
    ["workload", (value) => { value.workload.digest = "0".repeat(64); }],
    ["generation", (value) => { value.generation = "A".repeat(32); }],
    ["children", (value) => { value.schedule.childrenPerWave += 1; }],
    ["attempt count", (value) => { value.schedule.attemptCount += 1; }],
    ["digest", (value) => { value.schedule.digest = "0".repeat(64); }],
    ["execution", (value) => { value.execution.concurrencyMode = "unknown"; }],
    ["unknown", (value) => { value.unknown = true; }],
  ];
  for (const [label, mutate] of cases) {
    const value = clone(original);
    mutate(value);
    assert.throws(() => parseBaselinePhaseManifest(resolved, value), BaselinePhaseError, label);
  }
});

test("one wave envelope binds every valid attempt to an exact child slot", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const evidence = await validEvidence(resolved);
  const envelope = buildBaselineWaveEnvelope(
    resolved,
    phase,
    1,
    [evidence, evidence, evidence],
  );
  const line = canonicalBaselineWaveEnvelopeLine(resolved, phase, envelope);
  const binding = baselineWaveEnvelopeBinding(resolved, phase, envelope);

  assert.deepEqual(envelope.attempts.map(({ slot }) => slot), [
    { ordinal: 1, wave: 1, position: 1 },
    { ordinal: 2, wave: 1, position: 2 },
    { ordinal: 3, wave: 1, position: 3 },
  ]);
  assert.equal(binding.bytes, line.length);
  assert.doesNotThrow(() => parseBaselineWaveEnvelope(resolved, phase, clone(envelope)));

  const cases = [
    ["slot", (value) => { value.attempts[0].slot.position = 2; }],
    ["binding", (value) => { value.attempts[1].attempt.binding.sha256 = "0".repeat(64); }],
    ["evidence", (value) => {
      value.attempts[2].attempt.evidence.output.stdout.sha256 = "0".repeat(64);
    }],
    ["schedule", (value) => { value.scheduleDigest = "0".repeat(64); }],
    ["generation", (value) => { value.generation = "f".repeat(32); }],
  ];
  for (const [label, mutate] of cases) {
    const value = clone(envelope);
    mutate(value);
    assert.throws(() => parseBaselineWaveEnvelope(resolved, phase, value),
      BaselinePhaseError, label);
  }
});

test("baseline resume accepts only the exact contiguous whole-wave prefix", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const evidence = await validEvidence(resolved);
  const first = buildBaselineWaveEnvelope(resolved, phase, 1,
    [evidence, evidence, evidence]);
  const second = buildBaselineWaveEnvelope(resolved, phase, 2,
    [evidence, evidence, evidence]);

  assert.deepEqual(assessBaselinePhasePrefix(resolved, phase, []), {
    status: "empty",
    complete: false,
    committedWaves: 0,
    totalWaves: 2,
    committedAttempts: 0,
    totalAttempts: 6,
    nextWave: { ordinal: 1, firstAttemptOrdinal: 1, childCount: 3 },
  });
  assert.deepEqual(assessBaselinePhasePrefix(resolved, phase, [first]), {
    status: "incomplete",
    complete: false,
    committedWaves: 1,
    totalWaves: 2,
    committedAttempts: 3,
    totalAttempts: 6,
    nextWave: { ordinal: 2, firstAttemptOrdinal: 4, childCount: 3 },
  });
  assert.equal(assessBaselinePhasePrefix(resolved, phase, [first, second]).status,
    "complete");
  assert.throws(() => assessBaselinePhasePrefix(resolved, phase, [second]),
    /exact contiguous wave prefix/);
});

test("the wave adapter starts every child before awaiting completion and binds positions", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const resultFixture = await runWorkloadAttempt(resolved);
  const allStarted = deferred();
  const release = deferred();
  let starts = 0;
  const calls = [];
  const runAttempt = async (_workload, options) => {
    calls.push(options);
    starts += 1;
    if (starts === 3) allStarted.resolve();
    await release.promise;
    return resultFixture;
  };

  const pending = runNextBaselinePhaseWave({ resolved, manifest: phase, runAttempt });
  await allStarted.promise;
  assert.equal(starts, 3);
  release.resolve();
  const result = await pending;
  assert.equal(result.committed, true);
  assert.deepEqual(result.envelope.attempts.map(({ slot }) => slot.position), [1, 2, 3]);
  assert.equal(calls.every(({ signal }) => signal instanceof AbortSignal), true);
});

test("an operationally invalid child prevents the whole wave from occupying a slot", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const controller = new AbortController();
  controller.abort();
  const invalidResult = await runWorkloadAttempt(resolved, { signal: controller.signal });
  const rejected = await runNextBaselinePhaseWave({
    resolved,
    manifest: phase,
    runAttempt: async () => invalidResult,
  });

  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, "operational-invalid");
  assert.equal(rejected.envelope, null);
  assert.equal(rejected.attempts.length, 3);
  assert.equal(rejected.attempts.every(({ status }) => status === "operational-invalid"), true);
  const invalidEvidence = buildAttemptEvidence(resolved, invalidResult);
  assert.throws(() => buildBaselineWaveEnvelope(resolved, phase, 1,
    [invalidEvidence, invalidEvidence, invalidEvidence]),
  /operationally invalid/);

  let call = 0;
  let canceledPeers = 0;
  const runnerError = await runNextBaselinePhaseWave({
    resolved,
    manifest: phase,
    runAttempt: async (_workload, options) => {
      call += 1;
      if (call === 1) throw Object.assign(new Error("fixture"), { code: "FIXTURE" });
      if (!options.signal.aborted) {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve,
          { once: true }));
      }
      canceledPeers += 1;
      return invalidResult;
    },
  });
  assert.equal(runnerError.reason, "runner-error");
  assert.equal(runnerError.errorCode, "FIXTURE");
  assert.equal(canceledPeers, 2);
});

test("the production runner completes a harmless two-child wave", {
  timeout: 8_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved, { childrenPerWave: 2, waves: 1 });
  const result = await runNextBaselinePhaseWave({ resolved, manifest: phase });

  assert.equal(result.committed, true, JSON.stringify(result));
  assert.equal(result.envelope.attempts.length, 2);
  assert.equal(result.envelope.attempts.every(({ attempt }) =>
    attempt.evidence.outcome.category === "pass"), true);
});
