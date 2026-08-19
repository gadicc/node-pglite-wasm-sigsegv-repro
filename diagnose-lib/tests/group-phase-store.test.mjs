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
  buildGroupPhaseManifest,
  canonicalGroupWaveEnvelopeLine,
  runNextGroupPhaseWave,
} from "../group-phase.mjs";
import {
  GROUP_PHASE_FILE,
  GroupPhaseStoreError,
  commitGroupPhaseWave,
  initializeGroupPhaseStore,
  readGroupPhaseStore,
} from "../group-phase-store.mjs";
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
  return expandCpuList(value).slice(0, 2).sort((left, right) => left - right);
}

function resolvedWorkload() {
  const cwd = temporaryDirectory("group-store-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id: "group-store-fixture",
    label: "Group store fixture",
    description: "Harmless finite process used to validate group phase storage.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { groups: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, overrides = {}) {
  const cpus = allowedCpus();
  return buildGroupPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpuUniverse: cpus,
    contexts: [{ id: "all", kind: "uniform", cpus, childrenPerWave: 2 }],
    rounds: 2,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
    ...overrides,
  });
}

async function envelopes(resolved, phase) {
  const first = await runNextGroupPhaseWave({ resolved, manifest: phase });
  const second = await runNextGroupPhaseWave({
    resolved,
    manifest: phase,
    envelopes: [first.envelope],
  });
  return [first.envelope, second.envelope];
}

test("the group store initializes, resumes, and commits an exact whole-wave prefix", {
  timeout: 10_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const stateDir = temporaryDirectory("group-store-");
  const [first, second] = await envelopes(resolved, phase);

  const initialized = await initializeGroupPhaseStore({ resolved, manifest: phase, stateDir });
  assert.equal(initialized.progress.status, "empty");
  assert.equal(statSync(path.join(stateDir, GROUP_PHASE_FILE)).mode & 0o777, 0o600);
  assert.deepEqual((await initializeGroupPhaseStore({
    resolved,
    manifest: phase,
    stateDir,
  })).manifest, phase);

  const afterFirst = await commitGroupPhaseWave({ resolved, envelope: first, stateDir });
  assert.equal(afterFirst.progress.status, "incomplete");
  assert.equal(afterFirst.progress.committedWaves, 1);
  await assert.rejects(commitGroupPhaseWave({ resolved, envelope: first, stateDir }),
    /not the exact next phase wave/);
  const afterSecond = await commitGroupPhaseWave({ resolved, envelope: second, stateDir });
  assert.equal(afterSecond.progress.status, "complete");
  assert.equal(afterSecond.progress.committedAttempts, 4);
  assert.deepEqual((await readGroupPhaseStore({ resolved, stateDir })).envelopes,
    [first, second]);
  await assert.rejects(commitGroupPhaseWave({ resolved, envelope: second, stateDir }),
    /already complete/);
});

test("the group store rejects a changed manifest, gaps, and foreign files", {
  timeout: 10_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const [, second] = await envelopes(resolved, phase);

  const changedDir = temporaryDirectory("group-store-changed-");
  await initializeGroupPhaseStore({ resolved, manifest: phase, stateDir: changedDir });
  await assert.rejects(initializeGroupPhaseStore({
    resolved,
    manifest: manifest(resolved, { rounds: 3 }),
    stateDir: changedDir,
  }), /different manifest/);

  const gapDir = temporaryDirectory("group-store-gap-");
  await initializeGroupPhaseStore({ resolved, manifest: phase, stateDir: gapDir });
  writeFileSync(path.join(gapDir, "group-wave-000000002.json"),
    canonicalGroupWaveEnvelopeLine(resolved, phase, second), { mode: 0o600 });
  await assert.rejects(readGroupPhaseStore({ resolved, stateDir: gapDir }),
    /exact contiguous wave-file prefix/);

  const foreignDir = temporaryDirectory("group-store-foreign-");
  writeFileSync(path.join(foreignDir, "foreign.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(initializeGroupPhaseStore({
    resolved,
    manifest: phase,
    stateDir: foreignDir,
  }), /unknown file|manifest is missing/);
});

test("known group-store writer remnants recover while live writers are retained", {
  timeout: 10_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);

  const deadDir = temporaryDirectory("group-store-dead-");
  const deadName = ".group-phase.json.99999998.abcdef0123456789.writing.tmp";
  writeFileSync(path.join(deadDir, deadName), "incomplete", { mode: 0o600 });
  const recovered = await initializeGroupPhaseStore({
    resolved,
    manifest: phase,
    stateDir: deadDir,
  });
  assert.equal(recovered.progress.status, "empty");
  assert.equal(existsSync(path.join(deadDir, deadName)), false);

  const liveDir = temporaryDirectory("group-store-live-");
  const liveName = `.group-phase.json.${process.pid}.0123456789abcdef.writing.tmp`;
  writeFileSync(path.join(liveDir, liveName), "incomplete", { mode: 0o600 });
  await assert.rejects(initializeGroupPhaseStore({
    resolved,
    manifest: phase,
    stateDir: liveDir,
  }), (error) => error instanceof GroupPhaseStoreError && /live writer/.test(error.message));
  assert.equal(existsSync(path.join(liveDir, liveName)), true);
  assert.equal(readFileSync(path.join(liveDir, liveName), "utf8"), "incomplete");
});
