import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  GroupPhaseError,
  assessGroupPhasePrefix,
  buildGroupPhaseManifest,
  canonicalGroupPhaseManifestLine,
  parseGroupPhaseManifest,
  parseGroupWaveEnvelope,
  runNextGroupPhaseWave,
} from "../group-phase.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function allowedCpus() {
  const text = readFileSync("/proc/self/status", "utf8");
  const value = text.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof value, "string");
  return expandCpuList(value).slice(0, 2).sort((left, right) => left - right);
}

function workload({ args = ["-e", ""] } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "group-phase-"));
  directories.push(cwd);
  return resolveWorkloadSpec({
    version: 1,
    id: "group-phase-fixture",
    label: "Group phase fixture",
    description: "Harmless finite workload for CPU-mask group phase tests.",
    risk: "standard",
    command: { executable: process.execPath, args, cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { groups: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, options = {}) {
  const cpus = options.cpus ?? allowedCpus();
  const contexts = options.contexts ?? [
    { id: "all", kind: "uniform", cpus, childrenPerWave: 2 },
    { id: "first", kind: "subset", cpus: [cpus[0]], childrenPerWave: 1 },
  ];
  return buildGroupPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpuUniverse: cpus,
    contexts,
    rounds: options.rounds ?? 2,
    seed: options.seed ?? 20260819,
    tasksetPath: "/usr/bin/taskset",
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("group manifests bind overlapping topology contexts and a deterministic schedule", () => {
  const resolved = workload();
  const value = manifest(resolved);
  const reparsed = parseGroupPhaseManifest(resolved, clone(value));
  const progress = assessGroupPhasePrefix(resolved, value);

  assert.deepEqual(reparsed, value);
  assert.equal(value.phase, "cpu-groups");
  assert.equal(value.topology.contexts.length, 2);
  assert.equal(value.schedule.contextCount, 2);
  assert.equal(value.schedule.waveCount, 4);
  assert.equal(value.schedule.attemptCount, 6);
  assert.equal(progress.status, "empty");
  assert.equal(progress.totalWaves, 4);
  assert.equal(canonicalGroupPhaseManifestLine(resolved, value).at(-1), 10);
  assert.deepEqual(manifest(resolved), value);
});

test("group manifests reject topology, capability, schedule, and binding drift", () => {
  const resolved = workload();
  const value = manifest(resolved);
  const cases = [
    ["universe", (copy) => { copy.topology.cpuUniverse.push(65_535); }],
    ["context mask", (copy) => { copy.topology.contexts[0].cpus = [65_535]; }],
    ["context id", (copy) => { copy.topology.contexts[1].id = "all"; }],
    ["schedule", (copy) => { copy.schedule.rounds += 1; }],
    ["plan binding", (copy) => { copy.schedule.plan.sha256 = "0".repeat(64); }],
    ["digest", (copy) => { copy.schedule.digest = "0".repeat(64); }],
    ["workload", (copy) => { copy.workload.digest = "0".repeat(64); }],
  ];
  for (const [label, mutate] of cases) {
    const changed = clone(value);
    mutate(changed);
    assert.throws(() => parseGroupPhaseManifest(resolved, changed), GroupPhaseError, label);
  }

  const unsupported = resolveWorkloadSpec({
    ...JSON.parse(JSON.stringify({
      version: 1,
      id: "unsupported-group-fixture",
      label: "Unsupported fixture",
      description: "Finite fixture without group support.",
      risk: "standard",
      command: { executable: process.execPath, args: ["-e", ""], cwd: directories[0] },
      environment: {},
      attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
      outcomes: { targetSignals: [], mappedExits: [] },
      capabilities: {},
      provenance: { completeness: "complete", files: [] },
    })),
  });
  assert.throws(() => manifest(unsupported), /does not declare CPU-group support/);
});

test("one complete group wave advances an exact resumable prefix", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const value = manifest(resolved, { rounds: 1 });
  const first = assessGroupPhasePrefix(resolved, value).nextWave;
  const context = value.topology.contexts[first.contextIndex];
  const resultFixture = await runWorkloadAttempt(resolved, {
    cpuAffinity: { cpus: context.cpus, tasksetPath: value.execution.tasksetPath },
  });

  let launches = 0;
  const result = await runNextGroupPhaseWave({
    resolved,
    manifest: value,
    runAttempt: async (_resolved, options) => {
      launches += 1;
      assert.deepEqual(options.cpuAffinity.cpus, context.cpus);
      return resultFixture;
    },
  });
  assert.equal(result.reason, "committed");
  assert.equal(launches, context.childrenPerWave);
  assert.equal(result.envelope.wave.contextId, context.id);
  assert.equal(result.envelope.attempts.length, context.childrenPerWave);
  assert.doesNotThrow(() => parseGroupWaveEnvelope(resolved, value, clone(result.envelope)));

  const progress = assessGroupPhasePrefix(resolved, value, [result.envelope]);
  assert.equal(progress.committedWaves, 1);
  assert.equal(progress.committedAttempts, context.childrenPerWave);
  assert.equal(progress.nextWave.ordinal, 2);

  const tampered = clone(result.envelope);
  tampered.attempts[0].affinity.requestedCpuList = "65535";
  assert.throws(() => parseGroupWaveEnvelope(resolved, value, tampered),
    /affinity witness/);
});

test("an invalid child cancels peers and leaves the complete group wave available", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const cpus = allowedCpus();
  const value = manifest(resolved, {
    cpus,
    contexts: [{ id: "all", kind: "uniform", cpus, childrenPerWave: 2 }],
    rounds: 1,
  });
  let launches = 0;
  let peerCancelled = false;
  const invalid = await runNextGroupPhaseWave({
    resolved,
    manifest: value,
    runAttempt: async (_resolved, options) => {
      launches += 1;
      if (launches === 1) {
        throw Object.assign(new Error("fixture unavailable"), { code: "FIXTURE_UNAVAILABLE" });
      }
      await new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          peerCancelled = true;
          resolve();
        }, { once: true });
        if (options.signal.aborted) {
          peerCancelled = true;
          resolve();
        }
      });
      throw Object.assign(new Error("cancelled peer"), { code: "PEER_CANCELLED" });
    },
  });
  assert.equal(invalid.reason, "runner-error");
  assert.equal(invalid.envelope, null);
  assert.equal(peerCancelled, true);
  assert.equal(assessGroupPhasePrefix(resolved, value).committedWaves, 0);

  const retried = await runNextGroupPhaseWave({ resolved, manifest: value });
  assert.equal(retried.reason, "committed");
  assert.equal(assessGroupPhasePrefix(resolved, value, [retried.envelope]).complete, true);
});
