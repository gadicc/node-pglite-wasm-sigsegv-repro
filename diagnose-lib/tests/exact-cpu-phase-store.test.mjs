import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  buildExactCpuAttemptEnvelope,
  buildExactCpuPhaseManifest,
} from "../exact-cpu-phase.mjs";
import {
  EXACT_CPU_PHASE_FILE,
  ExactCpuPhaseStoreError,
  commitExactCpuPhaseAttempt,
  initializeExactCpuPhaseStore,
  readExactCpuPhaseStore,
} from "../exact-cpu-phase-store.mjs";
import { buildAttemptEvidence } from "../attempt-evidence.mjs";
import { runWorkloadAttempt } from "../attempt-runner.mjs";
import { createFileStateAdapter } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix = "exact-cpu-store-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function resolvedWorkload() {
  const cwd = temporaryDirectory("exact-cpu-store-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id: "exact-cpu-store-fixture",
    label: "Exact CPU store fixture",
    description: "Harmless finite process used to validate durable phase state.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function phaseManifest(resolved, overrides = {}) {
  return buildExactCpuPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpus: [8, 9],
    rounds: 1,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
    ...overrides,
  });
}

function affinity(slot) {
  return {
    mode: "inherited-singleton-v1",
    requestedCpu: slot.cpu,
    supervisorAllowedCpuList: String(slot.cpu),
    workloadAllowedCpuList: String(slot.cpu),
  };
}

async function phaseFixture() {
  const resolved = resolvedWorkload();
  const manifest = phaseManifest(resolved);
  const evidence = buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));
  const firstSlot = { ordinal: 1, round: 1, position: 1, cpu: 8 };
  const secondSlot = { ordinal: 2, round: 1, position: 2, cpu: 9 };
  return {
    resolved,
    manifest,
    first: buildExactCpuAttemptEnvelope(
      resolved,
      manifest,
      firstSlot,
      evidence,
      affinity(firstSlot),
    ),
    second: buildExactCpuAttemptEnvelope(
      resolved,
      manifest,
      secondSlot,
      evidence,
      affinity(secondSlot),
    ),
  };
}

function stateDirectory() {
  const directory = path.join(temporaryDirectory(), "state");
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

test("the filesystem store publishes a private manifest and exact resumable prefix", {
  timeout: 5_000,
}, async () => {
  const fixture = await phaseFixture();
  const stateDir = stateDirectory();
  let store = await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir,
  });

  assert.equal(store.progress.status, "empty");
  assert.deepEqual(store.envelopes, []);
  const manifestFile = path.join(stateDir, EXACT_CPU_PHASE_FILE);
  assert.equal(statSync(manifestFile).mode & 0o777, 0o600);
  assert.equal(statSync(manifestFile).nlink, 1);

  store = await commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.first,
    stateDir,
  });
  assert.equal(store.progress.status, "incomplete");
  assert.equal(store.progress.committedAttempts, 1);
  assert.equal(store.progress.nextSlot.ordinal, 2);
  assert.equal(statSync(path.join(stateDir, "exact-cpu-attempt-000000001.json")).mode & 0o777,
    0o600);

  const reopened = await readExactCpuPhaseStore({ resolved: fixture.resolved, stateDir });
  assert.deepEqual(reopened, store);
  assert.deepEqual(await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir,
  }), store);

  const complete = await commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.second,
    stateDir,
  });
  assert.equal(complete.progress.status, "complete");
  assert.equal(complete.progress.committedAttempts, 2);
});

test("initialization and commits never relabel, reorder, or overwrite phase state", {
  timeout: 5_000,
}, async () => {
  const fixture = await phaseFixture();
  const stateDir = stateDirectory();
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir,
  });

  await assert.rejects(commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.second,
    stateDir,
  }), /exact next phase slot/);

  await commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.first,
    stateDir,
  });
  await assert.rejects(commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.first,
    stateDir,
  }), /exact next phase slot/);

  const changed = phaseManifest(fixture.resolved, { seed: 20260820 });
  await assert.rejects(initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: changed,
    stateDir,
  }), /different manifest/);
});

test("store reads reject gaps, unknown files, and canonical-content tampering", {
  timeout: 5_000,
}, async () => {
  const fixture = await phaseFixture();

  const gapDir = stateDirectory();
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir: gapDir,
  });
  const adapter = createFileStateAdapter(gapDir);
  await adapter.commit(
    "exact-cpu-attempt-000000002.json",
    Buffer.from(`${JSON.stringify(fixture.second)}\n`),
  );
  await assert.rejects(readExactCpuPhaseStore({ resolved: fixture.resolved, stateDir: gapDir }),
    /contiguous attempt-file prefix/);

  const unknownDir = stateDirectory();
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir: unknownDir,
  });
  writeFileSync(path.join(unknownDir, "foreign.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(readExactCpuPhaseStore({
    resolved: fixture.resolved,
    stateDir: unknownDir,
  }), /unknown file/);

  const tamperDir = stateDirectory();
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir: tamperDir,
  });
  const tampered = JSON.parse(JSON.stringify(fixture.first));
  tampered.affinity.workloadAllowedCpuList = "9";
  writeFileSync(
    path.join(tamperDir, "exact-cpu-attempt-000000001.json"),
    `${JSON.stringify(tampered)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(readExactCpuPhaseStore({
    resolved: fixture.resolved,
    stateDir: tamperDir,
  }), /affinity witness/);
});

test("dead commit temporaries recover while a live writer blocks readers", {
  timeout: 5_000,
}, async () => {
  const fixture = await phaseFixture();
  const stateDir = stateDirectory();
  const orphan = path.join(
    stateDir,
    ".exact-cpu-attempt-000000001.json.99999998.0123456789abcdef.writing.tmp",
  );
  writeFileSync(orphan, "incomplete", { mode: 0o600 });
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir,
  });
  assert.equal(existsSync(orphan), false);

  await commitExactCpuPhaseAttempt({
    resolved: fixture.resolved,
    envelope: fixture.first,
    stateDir,
  });
  const committed = path.join(stateDir, "exact-cpu-attempt-000000001.json");
  const linkedReady = path.join(
    stateDir,
    ".exact-cpu-attempt-000000001.json.99999997.abcdef0123456789.ready.tmp",
  );
  linkSync(committed, linkedReady);
  assert.equal(statSync(committed).nlink, 2);
  await readExactCpuPhaseStore({ resolved: fixture.resolved, stateDir });
  assert.equal(existsSync(linkedReady), false);
  assert.equal(statSync(committed).nlink, 1);

  const live = path.join(
    stateDir,
    `.exact-cpu-attempt-000000002.json.${process.pid}.fedcba9876543210.writing.tmp`,
  );
  writeFileSync(live, "active", { mode: 0o600 });
  await assert.rejects(readExactCpuPhaseStore({ resolved: fixture.resolved, stateDir }),
    /live writer/);
  assert.equal(existsSync(live), true);
});

test("a private store refuses unsafe directories and concurrent duplicate publication", {
  timeout: 5_000,
}, async () => {
  const fixture = await phaseFixture();
  const unsafeDir = stateDirectory();
  chmodSync(unsafeDir, 0o755);
  await assert.rejects(initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir: unsafeDir,
  }), ExactCpuPhaseStoreError);

  const stateDir = stateDirectory();
  await initializeExactCpuPhaseStore({
    resolved: fixture.resolved,
    manifest: fixture.manifest,
    stateDir,
  });
  const results = await Promise.allSettled([
    commitExactCpuPhaseAttempt({
      resolved: fixture.resolved,
      envelope: fixture.first,
      stateDir,
    }),
    commitExactCpuPhaseAttempt({
      resolved: fixture.resolved,
      envelope: fixture.first,
      stateDir,
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(readFileSync(
    path.join(stateDir, "exact-cpu-attempt-000000001.json"),
    "utf8",
  ).endsWith("\n"), true);
  assert.equal((await readExactCpuPhaseStore({ resolved: fixture.resolved, stateDir }))
    .progress.committedAttempts, 1);
});

test("oversized schedules are rejected before the manifest is published", {
  timeout: 10_000,
}, async () => {
  const resolved = resolvedWorkload();
  const manifest = phaseManifest(resolved, {
    cpus: Array.from({ length: 32_769 }, (_, cpu) => cpu),
    rounds: 2,
    seed: 0,
  });
  const stateDir = stateDirectory();
  await assert.rejects(initializeExactCpuPhaseStore({ resolved, manifest, stateDir }),
    /65536-attempt store limit/);
  assert.deepEqual(readdirSync(stateDir), []);
});
