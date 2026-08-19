import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  ExactCpuPhaseError,
  assessExactCpuPhasePrefix,
  buildExactCpuAttemptEnvelope,
  buildExactCpuPhaseManifest,
  canonicalExactCpuAttemptEnvelopeLine,
  canonicalExactCpuPhaseManifestLine,
  exactCpuAttemptEnvelopeBinding,
  exactCpuPhaseManifestBinding,
  parseExactCpuAttemptEnvelope,
  parseExactCpuPhaseManifest,
  runNextExactCpuPhaseAttempt,
} from "../exact-cpu-phase.mjs";
import { buildAttemptEvidence } from "../attempt-evidence.mjs";
import { runWorkloadAttempt } from "../attempt-runner.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];
const TASKSET = "/usr/bin/taskset";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolvedWorkload(source = "") {
  const directory = mkdtempSync(path.join(tmpdir(), "exact-cpu-phase-"));
  directories.push(directory);
  return resolveWorkloadSpec({
    version: 1,
    id: "exact-cpu-phase-fixture",
    label: "Exact CPU phase fixture",
    description: "Harmless Node process used to validate exact-CPU phase evidence.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", source],
      cwd: directory,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, overrides = {}) {
  return buildExactCpuPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpus: [8, 9],
    rounds: 2,
    seed: 20260819,
    tasksetPath: TASKSET,
    ...overrides,
  });
}

async function validEvidence(resolved) {
  return buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));
}

function affinity(slot) {
  return {
    mode: "inherited-singleton-v1",
    requestedCpu: slot.cpu,
    supervisorAllowedCpuList: String(slot.cpu),
    workloadAllowedCpuList: String(slot.cpu),
  };
}

test("phase manifests bind workload, deterministic schedule, execution context, and canonical bytes", () => {
  const resolved = resolvedWorkload();
  const first = manifest(resolved);
  const second = manifest(resolved);
  const changed = manifest(resolved, { seed: 20260820 });
  const line = canonicalExactCpuPhaseManifestLine(resolved, first);
  const binding = exactCpuPhaseManifestBinding(resolved, first);

  assert.deepEqual(first, second);
  assert.notEqual(first.schedule.digest, changed.schedule.digest);
  assert.equal(first.schedule.attemptCount, 4);
  assert.equal(first.schedule.plan.recordCount, 4);
  assert.equal(first.execution.affinityMode, "inherited-singleton-v1");
  assert.equal(line.at(-1), 0x0a);
  assert.equal(binding.bytes, line.length);
  assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first.schedule.cpus), true);
});

test("phase manifests reject workload, generation, schedule, plan, and execution tampering", () => {
  const resolved = resolvedWorkload();
  const original = manifest(resolved);
  const cases = [
    ["workload", (value) => { value.workload.digest = "0".repeat(64); }],
    ["generation", (value) => { value.generation = "A".repeat(32); }],
    ["seed", (value) => { value.schedule.seed += 1; }],
    ["plan", (value) => { value.schedule.plan.sha256 = "0".repeat(64); }],
    ["digest", (value) => { value.schedule.digest = "0".repeat(64); }],
    ["affinity", (value) => { value.execution.affinityMode = "unknown"; }],
    ["taskset", (value) => { value.execution.tasksetPath = "taskset"; }],
    ["unknown field", (value) => { value.unknown = true; }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(original);
    mutate(value);
    assert.throws(() => parseExactCpuPhaseManifest(resolved, value), ExactCpuPhaseError, label);
  }
});

test("attempt envelopes bind one valid attempt to its exact scheduled slot", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const evidence = await validEvidence(resolved);
  const slot = { ordinal: 1, round: 1, position: 1, cpu: 8 };
  const envelope = buildExactCpuAttemptEnvelope(resolved, phase, slot, evidence, affinity(slot));
  const line = canonicalExactCpuAttemptEnvelopeLine(resolved, phase, envelope);
  const binding = exactCpuAttemptEnvelopeBinding(resolved, phase, envelope);

  assert.equal(envelope.slot.ordinal, 1);
  assert.equal(envelope.scheduleDigest, phase.schedule.digest);
  assert.equal(envelope.attempt.evidence.outcome.category, "pass");
  assert.equal(binding.bytes, line.length);
  assert.doesNotThrow(() => parseExactCpuAttemptEnvelope(resolved, phase, clone(envelope)));

  const cases = [
    ["slot", (value) => { value.slot.cpu = 9; }],
    ["schedule", (value) => { value.scheduleDigest = "0".repeat(64); }],
    ["binding", (value) => { value.attempt.binding.sha256 = "0".repeat(64); }],
    ["evidence", (value) => { value.attempt.evidence.output.stdout.sha256 = "0".repeat(64); }],
    ["affinity", (value) => { value.affinity.workloadAllowedCpuList = "9"; }],
    ["generation", (value) => { value.generation = "f".repeat(32); }],
  ];
  for (const [label, mutate] of cases) {
    const value = clone(envelope);
    mutate(value);
    assert.throws(() => parseExactCpuAttemptEnvelope(resolved, phase, value),
      ExactCpuPhaseError, label);
  }
});

test("resume accepts only the exact contiguous schedule prefix", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const evidence = await validEvidence(resolved);
  const firstSlot = { ordinal: 1, round: 1, position: 1, cpu: 8 };
  const secondSlot = { ordinal: 2, round: 1, position: 2, cpu: 9 };
  const first = buildExactCpuAttemptEnvelope(resolved, phase,
    firstSlot, evidence, affinity(firstSlot));
  const second = buildExactCpuAttemptEnvelope(resolved, phase,
    secondSlot, evidence, affinity(secondSlot));

  assert.deepEqual(assessExactCpuPhasePrefix(resolved, phase, []), {
    status: "empty",
    complete: false,
    committedAttempts: 0,
    totalAttempts: 4,
    nextSlot: { ordinal: 1, round: 1, position: 1, cpu: 8 },
  });
  assert.deepEqual(assessExactCpuPhasePrefix(resolved, phase, [first, second]), {
    status: "incomplete",
    complete: false,
    committedAttempts: 2,
    totalAttempts: 4,
    nextSlot: { ordinal: 3, round: 2, position: 1, cpu: 9 },
  });
  assert.throws(() => assessExactCpuPhasePrefix(resolved, phase, [second]),
    /exact contiguous schedule prefix/);
  const thirdSlot = { ordinal: 3, round: 2, position: 1, cpu: 9 };
  const fourthSlot = { ordinal: 4, round: 2, position: 2, cpu: 8 };
  assert.deepEqual(assessExactCpuPhasePrefix(resolved, phase, [first, second,
    buildExactCpuAttemptEnvelope(resolved, phase,
      thirdSlot, evidence, affinity(thirdSlot)),
    buildExactCpuAttemptEnvelope(resolved, phase,
      fourthSlot, evidence, affinity(fourthSlot)),
  ]).status, "complete");
});

test("the phase adapter advances only valid outcomes and supplies the scheduled CPU", {
  timeout: 5_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const calls = [];
  const adapter = async (workload, options) => {
    calls.push(options);
    const { cpuAffinity: _cpuAffinity, ...ordinaryOptions } = options;
    const result = clone(await runWorkloadAttempt(workload, ordinaryOptions));
    result.execution = {
      cpuAffinity: {
        requestedCpu: options.cpuAffinity.cpu,
        supervisorAllowedCpuList: String(options.cpuAffinity.cpu),
        workloadAllowedCpuList: String(options.cpuAffinity.cpu),
      },
    };
    return result;
  };
  const first = await runNextExactCpuPhaseAttempt({ resolved, manifest: phase, runAttempt: adapter });
  const second = await runNextExactCpuPhaseAttempt({
    resolved,
    manifest: phase,
    envelopes: [first.envelope],
    runAttempt: adapter,
  });

  assert.equal(first.committed, true);
  assert.equal(second.committed, true);
  assert.deepEqual(calls.map((call) => call.cpuAffinity), [
    { cpu: 8, tasksetPath: TASKSET },
    { cpu: 9, tasksetPath: TASKSET },
  ]);

  const controller = new AbortController();
  controller.abort();
  const invalidResult = await runWorkloadAttempt(resolved, { signal: controller.signal });
  const rejected = await runNextExactCpuPhaseAttempt({
    resolved,
    manifest: phase,
    runAttempt: async () => invalidResult,
  });
  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, "operational-invalid");
  assert.equal(rejected.envelope, null);
  assert.throws(() => buildExactCpuAttemptEnvelope(resolved, phase,
    { ordinal: 1, round: 1, position: 1, cpu: 8 }, rejected.evidence,
    affinity({ cpu: 8 })),
  /operationally invalid/);
});

test("the bounded runner applies and witnesses singleton CPU affinity for a harmless process", {
  timeout: 8_000,
}, async () => {
  const allowed = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.ok(allowed, "test process must expose Cpus_allowed_list");
  const cpu = expandCpuList(allowed)[0];
  const resolved = resolvedWorkload(
    "const s=require('node:fs').readFileSync('/proc/self/status','utf8');" +
    "require('node:fs').writeSync(1,s.match(/^Cpus_allowed_list:\\s*(\\S+)\\s*$/m)[1])",
  );
  const phase = manifest(resolved, { cpus: [cpu], rounds: 1, seed: 0 });
  const result = await runNextExactCpuPhaseAttempt({ resolved, manifest: phase });

  assert.equal(result.committed, true, JSON.stringify(result.evidence ?? result));
  assert.equal(result.envelope.slot.cpu, cpu);
  assert.deepEqual(result.envelope.affinity, {
    mode: "inherited-singleton-v1",
    requestedCpu: cpu,
    supervisorAllowedCpuList: String(cpu),
    workloadAllowedCpuList: String(cpu),
  });
  assert.equal(Buffer.from(
    result.envelope.attempt.evidence.output.stdout.excerptBase64,
    "base64",
  ).toString(), String(cpu));
  assert.equal(result.envelope.attempt.evidence.outcome.category, "pass");
});
