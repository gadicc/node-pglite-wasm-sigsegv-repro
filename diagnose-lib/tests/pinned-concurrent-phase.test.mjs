import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  PinnedConcurrentPhaseError,
  assessPinnedConcurrentPhasePrefix,
  buildPinnedConcurrentPhaseManifest,
  canonicalPinnedConcurrentPhaseManifestLine,
  parsePinnedConcurrentPhaseManifest,
  parsePinnedConcurrentWaveEnvelope,
  runNextPinnedConcurrentPhaseWave,
} from "../pinned-concurrent-phase.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function allowedCpus() {
  const value = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof value, "string");
  const cpus = expandCpuList(value).slice(0, 3).sort((left, right) => left - right);
  assert.ok(cpus.length >= 2, "pinned-concurrent tests require two allowed CPUs");
  return cpus;
}

function workload() {
  const cwd = mkdtempSync(path.join(tmpdir(), "pinned-concurrent-phase-"));
  directories.push(cwd);
  return resolveWorkloadSpec({
    version: 1,
    id: "pinned-concurrent-phase-fixture",
    label: "Pinned-concurrent phase fixture",
    description: "Harmless finite workload for pinned-concurrent phase tests.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { pinnedConcurrent: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function contexts(cpus = allowedCpus()) {
  return [{
    group: "active",
    kind: "uniform",
    cpus: cpus.slice(1),
    cluster: "-",
    controllerCpu: cpus[0],
  }];
}

function manifest(resolved, options = {}) {
  return buildPinnedConcurrentPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    contexts: options.contexts ?? contexts(),
    rounds: options.rounds ?? 2,
    seed: options.seed ?? 20260819,
    tasksetPath: "/usr/bin/taskset",
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("pinned-concurrent manifests bind controller placement and deterministic launches", () => {
  const resolved = workload();
  const value = manifest(resolved);
  const progress = assessPinnedConcurrentPhasePrefix(resolved, value);

  assert.deepEqual(parsePinnedConcurrentPhaseManifest(resolved, clone(value)), value);
  assert.equal(value.phase, "pinned-concurrent");
  assert.equal(value.schedule.waveCount, 2);
  assert.equal(value.schedule.attemptCount,
    value.topology.contexts[0].cpus.length * 2);
  assert.equal(progress.status, "empty");
  assert.equal(progress.nextWave.controllerCpu,
    value.topology.contexts[0].controllerCpu);
  assert.equal(canonicalPinnedConcurrentPhaseManifestLine(resolved, value).at(-1), 10);
  assert.deepEqual(manifest(resolved), value);
});

test("pinned-concurrent manifests reject controller, topology, schedule, and workload drift", () => {
  const resolved = workload();
  const value = manifest(resolved);
  const cases = [
    ["controller", (copy) => {
      copy.topology.contexts[0].controllerCpu = copy.topology.contexts[0].cpus[0];
    }],
    ["CPU order", (copy) => { copy.topology.contexts[0].cpus.reverse(); }],
    ["rounds", (copy) => { copy.schedule.rounds += 1; }],
    ["plan", (copy) => { copy.schedule.plan.sha256 = "0".repeat(64); }],
    ["digest", (copy) => { copy.schedule.digest = "0".repeat(64); }],
    ["workload", (copy) => { copy.workload.digest = "0".repeat(64); }],
    ["contexts type", (copy) => { copy.topology.contexts = {}; }],
  ];
  for (const [label, mutate] of cases) {
    const changed = clone(value);
    mutate(changed);
    assert.throws(() => parsePinnedConcurrentPhaseManifest(resolved, changed),
      PinnedConcurrentPhaseError, label);
  }
});

test("controller and singleton-child witnesses bind one complete resumable wave", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const value = manifest(resolved, { rounds: 1 });
  const next = assessPinnedConcurrentPhasePrefix(resolved, value).nextWave;
  let wrongControllerLaunches = 0;
  const wrongController = await runNextPinnedConcurrentPhaseWave({
    resolved,
    manifest: value,
    readControllerCpuList: () => "65535",
    runAttempt: async () => { wrongControllerLaunches += 1; },
  });
  assert.equal(wrongController.reason, "controller-invalid");
  assert.equal(wrongControllerLaunches, 0);

  const launched = [];
  const result = await runNextPinnedConcurrentPhaseWave({
    resolved,
    manifest: value,
    readControllerCpuList: () => String(next.controllerCpu),
    runAttempt: async (childWorkload, options) => {
      launched.push(options.cpuAffinity.cpu);
      const { runWorkloadAttempt } = await import("../attempt-runner.mjs");
      return runWorkloadAttempt(childWorkload, options);
    },
  });
  assert.equal(result.reason, "committed");
  assert.deepEqual(launched, result.envelope.attempts.map(({ slot }) => slot.cpu));
  assert.equal(result.envelope.controller.allowedCpuList, String(next.controllerCpu));
  assert.doesNotThrow(() => parsePinnedConcurrentWaveEnvelope(
    resolved,
    value,
    clone(result.envelope),
  ));
  assert.equal(assessPinnedConcurrentPhasePrefix(resolved, value, [result.envelope]).complete,
    true);

  const tampered = clone(result.envelope);
  tampered.attempts[0].affinity.requestedCpu = next.controllerCpu;
  assert.throws(() => parsePinnedConcurrentWaveEnvelope(resolved, value, tampered),
    /child affinity witness/);
});

test("an invalid pinned child cancels its peers and consumes no wave", async () => {
  const resolved = workload();
  const value = manifest(resolved, { rounds: 1 });
  const next = assessPinnedConcurrentPhasePrefix(resolved, value).nextWave;
  let launches = 0;
  let peerCancelled = false;
  const result = await runNextPinnedConcurrentPhaseWave({
    resolved,
    manifest: value,
    readControllerCpuList: () => String(next.controllerCpu),
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
  assert.equal(result.reason, "runner-error");
  assert.equal(result.envelope, null);
  assert.equal(peerCancelled, value.schedule.attemptCount > 1);
  assert.equal(assessPinnedConcurrentPhasePrefix(resolved, value).committedWaves, 0);
});
