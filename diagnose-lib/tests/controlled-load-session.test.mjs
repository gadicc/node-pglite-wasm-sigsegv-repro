import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  buildControlledLoadSessionManifest,
  canonicalControlledLoadSessionEnvelopeLine,
  canonicalControlledLoadSessionManifestLine,
  controlledLoadSessionEnvelopeBinding,
  controlledLoadSessionManifestBinding,
  ControlledLoadSessionError,
  parseControlledLoadSessionEnvelope,
  parseControlledLoadSessionManifest,
  runControlledLoadSession,
} from "../controlled-load-session.mjs";
import {
  canonicalControlledLoadWorkerSetBoundaryLine,
  startControlledLoadWorkerSet,
} from "../controlled-load-workers.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];
const TASKSET = "/usr/bin/taskset";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function workload({ id, mode, source }) {
  const cwd = mkdtempSync(path.join(tmpdir(), "controlled-load-session-"));
  directories.push(cwd);
  return resolveWorkloadSpec({
    version: 1,
    id,
    label: `${id} fixture`,
    description: "Harmless finite or waiting process for controlled-load session tests.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", source], cwd },
    environment: {},
    attempt: { mode, timeoutMs: 5_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGUSR2"], mappedExits: [] },
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
}

function fixtures() {
  return {
    measured: workload({
      id: "controlled-load-measured-fixture",
      mode: "exit",
      source: "process.exit(0)",
    }),
    auxiliary: workload({
      id: "controlled-load-auxiliary-fixture",
      mode: "survive-window",
      source: "setInterval(() => {}, 1000)",
    }),
  };
}

function allowedCpus() {
  const text = readFileSync("/proc/self/status", "utf8");
  const list = text.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof list, "string");
  return expandCpuList(list);
}

function manifest(measured, auxiliary, overrides = {}) {
  return buildControlledLoadSessionManifest(measured, auxiliary, {
    generation: "0123456789abcdef0123456789abcdef",
    attemptsPerLeg: 1,
    targetCpu: 8,
    workerCpus: [9],
    tasksetPath: TASKSET,
    warmupMs: 0,
    recoveryMs: 0,
    ...overrides,
  });
}

function binding(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

async function invalidAttempt(resolved, options) {
  const controller = new AbortController();
  controller.abort();
  return runWorkloadAttempt(resolved, { ...options, signal: controller.signal });
}

test("manifests bind both workloads, target placement, worker CPUs, and the fixed schedule", () => {
  const { measured, auxiliary } = fixtures();
  const value = manifest(measured, auxiliary, {
    attemptsPerLeg: 2,
    warmupMs: 50,
    recoveryMs: 75,
  });
  const line = canonicalControlledLoadSessionManifestLine(measured, auxiliary, value);
  const recordBinding = controlledLoadSessionManifestBinding(measured, auxiliary, value);

  assert.equal(value.phase, "controlled-load-aba");
  assert.equal(value.schedule.attemptCount, 6);
  assert.deepEqual(value.schedule.legs.map(({ leg }) => leg), ["a1", "b", "a2"]);
  assert.equal(value.execution.targetCpu, 8);
  assert.deepEqual(value.execution.workerCpus, [9]);
  assert.equal(recordBinding.bytes, line.length);
  assert.match(recordBinding.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseControlledLoadSessionManifest(measured, auxiliary, clone(value)), value);

  const cases = [
    (changed) => { changed.measuredWorkload.digest = "0".repeat(64); },
    (changed) => { changed.auxiliaryWorkload.digest = "0".repeat(64); },
    (changed) => { changed.execution.targetCpu = 9; },
    (changed) => { changed.execution.workerCpus = [10, 9]; },
    (changed) => { changed.schedule.warmupMs += 1; },
    (changed) => { changed.schedule.digest = "0".repeat(64); },
    (changed) => { changed.unknown = true; },
  ];
  for (const mutate of cases) {
    const changed = clone(value);
    mutate(changed);
    assert.throws(() => parseControlledLoadSessionManifest(measured, auxiliary, changed),
      ControlledLoadSessionError);
  }
});

test("the production adapter publishes one fully bracketed harmless A1/B/A2 session", {
  timeout: 20_000,
}, async (context) => {
  const cpus = allowedCpus();
  if (cpus.length < 2) {
    context.skip("requires two allowed CPUs");
    return;
  }
  const { measured, auxiliary } = fixtures();
  const phase = manifest(measured, auxiliary, {
    targetCpu: cpus[0],
    workerCpus: [cpus[1]],
    warmupMs: 10,
    recoveryMs: 10,
  });
  const result = await runControlledLoadSession({ measured, auxiliary, manifest: phase });

  assert.equal(result.committed, true, JSON.stringify(result));
  assert.deepEqual(result.envelope.legs.map(({ leg }) => leg), ["a1", "b", "a2"]);
  assert.equal(result.envelope.legs.every(({ attempts }) =>
    attempts.length === 1 && attempts[0].evidence.outcome.validOutcome), true);
  assert.equal(result.envelope.condition.beforeB.evidence.boundary, "before-b");
  assert.equal(result.envelope.condition.afterB.evidence.boundary, "after-b");
  assert.equal(result.envelope.condition.workerSetStop.evidence.valid, true);
  assert.equal(result.envelope.condition.workerSetStop.evidence.reason, "complete");
  const readyNs = BigInt(
    result.envelope.condition.workerSetStart.evidence.readyMonotonicNs,
  );
  const beforeNs = BigInt(result.envelope.condition.beforeB.evidence.monotonicNs);
  const stoppedNs = BigInt(
    result.envelope.condition.workerSetStop.evidence.stoppedMonotonicNs,
  );
  const a2StartedNs = BigInt(
    result.envelope.legs[2].attempts[0].evidence.boundary.attemptStartedMonotonicNs,
  );
  assert.ok(beforeNs - readyNs >= 10_000_000n);
  assert.ok(a2StartedNs - stoppedNs >= 10_000_000n);
  assert.deepEqual(parseControlledLoadSessionEnvelope(
    measured,
    auxiliary,
    phase,
    clone(result.envelope),
  ), result.envelope);
  const line = canonicalControlledLoadSessionEnvelopeLine(
    measured,
    auxiliary,
    phase,
    result.envelope,
  );
  assert.equal(controlledLoadSessionEnvelopeBinding(
    measured,
    auxiliary,
    phase,
    result.envelope,
  ).bytes, line.length);

  const rebound = clone(result.envelope);
  const bCleanup = rebound.legs[1].attempts[0].evidence.boundary.cleanupFinishedMonotonicNs;
  rebound.condition.beforeB.evidence.monotonicNs = (BigInt(bCleanup) + 1n).toString();
  rebound.condition.beforeB.binding = binding(canonicalControlledLoadWorkerSetBoundaryLine(
    auxiliary,
    rebound.condition.workerSetStart.evidence,
    rebound.condition.beforeB.evidence,
  ));
  assert.throws(() => parseControlledLoadSessionEnvelope(
    measured,
    auxiliary,
    phase,
    rebound,
  ), /before-B boundary does not bracket B/);

  const attemptDrift = clone(result.envelope);
  attemptDrift.legs[2].attempts[0].evidence.output.stdout.sha256 = "0".repeat(64);
  assert.throws(() => parseControlledLoadSessionEnvelope(
    measured,
    auxiliary,
    phase,
    attemptDrift,
  ), /attempt evidence is invalid/);

  const affinityDrift = clone(result.envelope);
  affinityDrift.legs[0].attempts[0].affinity.workloadAllowedCpuList = String(cpus[1]);
  assert.throws(() => parseControlledLoadSessionEnvelope(
    measured,
    auxiliary,
    phase,
    affinityDrift,
  ), /does not match the target singleton CPU/);
});

test("an invalid A1 attempt prevents the condition workers from starting", async () => {
  const { measured, auxiliary } = fixtures();
  const phase = manifest(measured, auxiliary);
  let starts = 0;
  const result = await runControlledLoadSession({
    measured,
    auxiliary,
    manifest: phase,
    runAttempt: invalidAttempt,
    startWorkerSet: async () => { starts += 1; throw new Error("must not start"); },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "operational-invalid");
  assert.equal(result.stage, "a1");
  assert.equal(starts, 0);
  assert.equal(result.condition.workerSetStart, null);
});

test("an invalid B attempt stops the complete worker set and publishes no session", {
  timeout: 15_000,
}, async (context) => {
  const cpus = allowedCpus();
  if (cpus.length < 2) {
    context.skip("requires two allowed CPUs");
    return;
  }
  const { measured, auxiliary } = fixtures();
  const phase = manifest(measured, auxiliary, {
    targetCpu: cpus[0],
    workerCpus: [cpus[1]],
  });
  let call = 0;
  const result = await runControlledLoadSession({
    measured,
    auxiliary,
    manifest: phase,
    runAttempt: async (resolved, options) => {
      call += 1;
      return call === 2
        ? invalidAttempt(resolved, options)
        : runWorkloadAttempt(resolved, options);
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "operational-invalid");
  assert.equal(result.stage, "b");
  assert.equal(call, 2);
  assert.equal(result.condition.workerSetStart.cpus[0], cpus[1]);
  assert.equal(result.condition.workerSetStop.valid, true);
  assert.equal(result.condition.workerSetStop.workers[0].result.cleanup.groupDrained, true);
});

test("a failed after-B identity boundary stops workers and prevents A2", {
  timeout: 15_000,
}, async (context) => {
  const cpus = allowedCpus();
  if (cpus.length < 2) {
    context.skip("requires two allowed CPUs");
    return;
  }
  const { measured, auxiliary } = fixtures();
  const phase = manifest(measured, auxiliary, {
    targetCpu: cpus[0],
    workerCpus: [cpus[1]],
  });
  let calls = 0;
  const result = await runControlledLoadSession({
    measured,
    auxiliary,
    manifest: phase,
    runAttempt: async (resolved, options) => {
      calls += 1;
      return runWorkloadAttempt(resolved, options);
    },
    startWorkerSet: async (options) => {
      const handle = await startControlledLoadWorkerSet(options);
      return {
        startEvidence: handle.startEvidence,
        verify(boundary) {
          if (boundary === "after-b") {
            throw Object.assign(new Error("fixture boundary refusal"), {
              code: "FIXTURE_BOUNDARY_REFUSAL",
            });
          }
          return handle.verify(boundary);
        },
        stop: handle.stop,
      };
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "condition-invalid");
  assert.equal(result.errorCode, "FIXTURE_BOUNDARY_REFUSAL");
  assert.equal(calls, 2);
  assert.equal(result.condition.workerSetStop.workers[0].result.cleanup.groupDrained, true);
});

test("an invalid A2 attempt cannot relabel an otherwise complete B condition", {
  timeout: 15_000,
}, async (context) => {
  const cpus = allowedCpus();
  if (cpus.length < 2) {
    context.skip("requires two allowed CPUs");
    return;
  }
  const { measured, auxiliary } = fixtures();
  const phase = manifest(measured, auxiliary, {
    targetCpu: cpus[0],
    workerCpus: [cpus[1]],
  });
  let call = 0;
  const result = await runControlledLoadSession({
    measured,
    auxiliary,
    manifest: phase,
    runAttempt: async (resolved, options) => {
      call += 1;
      return call === 3
        ? invalidAttempt(resolved, options)
        : runWorkloadAttempt(resolved, options);
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "operational-invalid");
  assert.equal(result.stage, "a2");
  assert.equal(result.envelope, null);
  assert.equal(result.condition.workerSetStop.valid, true);
});
