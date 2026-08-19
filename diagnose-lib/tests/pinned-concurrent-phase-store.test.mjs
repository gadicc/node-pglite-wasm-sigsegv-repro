import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  buildPinnedConcurrentPhaseManifest,
  canonicalPinnedConcurrentWaveEnvelopeLine,
  runNextPinnedConcurrentPhaseWave,
} from "../pinned-concurrent-phase.mjs";
import {
  PINNED_CONCURRENT_PHASE_FILE,
  PinnedConcurrentPhaseStoreError,
  commitPinnedConcurrentPhaseWave,
  initializePinnedConcurrentPhaseStore,
  readPinnedConcurrentPhaseStore,
} from "../pinned-concurrent-phase-store.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function allowedCpus() {
  const value = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof value, "string");
  const cpus = expandCpuList(value).slice(0, 2).sort((left, right) => left - right);
  assert.equal(cpus.length, 2);
  return cpus;
}

function workload() {
  const cwd = temporaryDirectory("pinned-concurrent-store-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id: "pinned-concurrent-store-fixture",
    label: "Pinned-concurrent store fixture",
    description: "Harmless finite process used to validate pinned-concurrent storage.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { pinnedConcurrent: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, overrides = {}) {
  const cpus = allowedCpus();
  return buildPinnedConcurrentPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    contexts: [{
      group: "active",
      kind: "uniform",
      cpus: [cpus[1]],
      cluster: "-",
      controllerCpu: cpus[0],
    }],
    rounds: 2,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
    ...overrides,
  });
}

async function envelopes(resolved, phase) {
  const controllerCpu = phase.topology.contexts[0].controllerCpu;
  const first = await runNextPinnedConcurrentPhaseWave({
    resolved,
    manifest: phase,
    readControllerCpuList: () => String(controllerCpu),
  });
  const second = await runNextPinnedConcurrentPhaseWave({
    resolved,
    manifest: phase,
    envelopes: [first.envelope],
    readControllerCpuList: () => String(controllerCpu),
  });
  return [first.envelope, second.envelope];
}

test("the pinned-concurrent store commits and resumes an exact whole-wave prefix", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const phase = manifest(resolved);
  const stateDir = temporaryDirectory("pinned-concurrent-store-");
  const [first, second] = await envelopes(resolved, phase);

  const initialized = await initializePinnedConcurrentPhaseStore({
    resolved,
    manifest: phase,
    stateDir,
  });
  assert.equal(initialized.progress.status, "empty");
  assert.equal(statSync(path.join(stateDir, PINNED_CONCURRENT_PHASE_FILE)).mode & 0o777,
    0o600);
  const afterFirst = await commitPinnedConcurrentPhaseWave({
    resolved,
    envelope: first,
    stateDir,
  });
  assert.equal(afterFirst.progress.status, "incomplete");
  await assert.rejects(commitPinnedConcurrentPhaseWave({
    resolved,
    envelope: first,
    stateDir,
  }), /not the exact next phase wave/);
  const afterSecond = await commitPinnedConcurrentPhaseWave({
    resolved,
    envelope: second,
    stateDir,
  });
  assert.equal(afterSecond.progress.status, "complete");
  assert.deepEqual((await readPinnedConcurrentPhaseStore({ resolved, stateDir })).envelopes,
    [first, second]);
});

test("the pinned-concurrent store rejects manifest drift, gaps, and foreign files", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const phase = manifest(resolved);
  const [, second] = await envelopes(resolved, phase);
  const changedDir = temporaryDirectory("pinned-concurrent-store-changed-");
  await initializePinnedConcurrentPhaseStore({ resolved, manifest: phase, stateDir: changedDir });
  await assert.rejects(initializePinnedConcurrentPhaseStore({
    resolved,
    manifest: manifest(resolved, { rounds: 3 }),
    stateDir: changedDir,
  }), /different manifest/);

  const gapDir = temporaryDirectory("pinned-concurrent-store-gap-");
  await initializePinnedConcurrentPhaseStore({ resolved, manifest: phase, stateDir: gapDir });
  writeFileSync(path.join(gapDir, "pinned-concurrent-wave-000000002.json"),
    canonicalPinnedConcurrentWaveEnvelopeLine(resolved, phase, second), { mode: 0o600 });
  await assert.rejects(readPinnedConcurrentPhaseStore({ resolved, stateDir: gapDir }),
    /exact contiguous wave-file prefix/);

  const foreignDir = temporaryDirectory("pinned-concurrent-store-foreign-");
  writeFileSync(path.join(foreignDir, "foreign.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(initializePinnedConcurrentPhaseStore({
    resolved,
    manifest: phase,
    stateDir: foreignDir,
  }), /unknown file|manifest is missing/);
});

test("known pinned-concurrent writer remnants recover while live writers are retained", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const phase = manifest(resolved);
  const deadDir = temporaryDirectory("pinned-concurrent-store-dead-");
  const deadName =
    ".pinned-concurrent-phase.json.99999998.abcdef0123456789.writing.tmp";
  writeFileSync(path.join(deadDir, deadName), "incomplete", { mode: 0o600 });
  const recovered = await initializePinnedConcurrentPhaseStore({
    resolved,
    manifest: phase,
    stateDir: deadDir,
  });
  assert.equal(recovered.progress.status, "empty");
  assert.equal(existsSync(path.join(deadDir, deadName)), false);

  const liveDir = temporaryDirectory("pinned-concurrent-store-live-");
  const liveName =
    `.pinned-concurrent-phase.json.${process.pid}.0123456789abcdef.writing.tmp`;
  writeFileSync(path.join(liveDir, liveName), "incomplete", { mode: 0o600 });
  await assert.rejects(initializePinnedConcurrentPhaseStore({
    resolved,
    manifest: phase,
    stateDir: liveDir,
  }), (error) => error instanceof PinnedConcurrentPhaseStoreError &&
    /live writer/.test(error.message));
  assert.equal(existsSync(path.join(liveDir, liveName)), true);
  assert.equal(readFileSync(path.join(liveDir, liveName), "utf8"), "incomplete");
});
