import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BundleExecutionLeaseError,
  withBundleExecutionLease,
} from "../bundle-execution-lease.mjs";
import { buildBaselinePhaseManifest } from "../baseline-phase.mjs";
import { buildExactCpuPhaseManifest } from "../exact-cpu-phase.mjs";
import { readLinuxProcessIdentity, runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  SCHEMA3_BUNDLE_FILE,
  SCHEMA3_BASELINE_STATE_DIRECTORY,
  SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
  buildSchema3BundleManifest,
  buildSchema3BundleManifestV2,
  canonicalSchema3BundleManifestLine,
  initializeSchema3Bundle,
  readSchema3Bundle,
  runOneSchema3BaselineWave,
  runOneSchema3ExactCpuAttempt,
} from "../schema3-bundle.mjs";
import { createFileStateAdapter } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";
import {
  leaseRetentionWorkloadSpec,
} from "./fixtures/schema3-lease-retention-workload.mjs";

const LEASE_RETENTION_OWNER = fileURLToPath(new URL(
  "./fixtures/schema3-lease-retention-workload.mjs",
  import.meta.url,
));

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

function allowedCpu() {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = status.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m);
  assert.notEqual(match, null);
  const first = match[1].split(",")[0].split("-")[0];
  return Number(first);
}

function workload({
  args = ["-e", ""],
  id = "schema3-fixture",
  capabilities = { isolated: true },
} = {}) {
  const cwd = temporaryDirectory("schema3-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id,
    label: "Schema 3 fixture",
    description: "Harmless finite process used to validate schema-3 bundle ownership.",
    risk: "standard",
    command: { executable: process.execPath, args, cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities,
    provenance: { completeness: "complete", files: [] },
  });
}

function baselineWorkload(options = {}) {
  return workload({ ...options, capabilities: { baseline: true, isolated: true } });
}

function baselineManifest(resolved, { childrenPerWave = 2, waves = 1 } = {}) {
  return buildBaselinePhaseManifest(resolved, {
    generation: "fedcba9876543210fedcba9876543210",
    childrenPerWave,
    waves,
  });
}

function exactCpuManifest(resolved, { rounds = 1 } = {}) {
  return buildExactCpuPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpus: [allowedCpu()],
    rounds,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
  });
}

function bundleManifest(resolved, options = {}) {
  return buildSchema3BundleManifest(resolved, {
    bundleGeneration: "abcdef0123456789abcdef0123456789",
    exactCpuManifest: exactCpuManifest(resolved, options),
  });
}

function bundleManifestV2(resolved, options = {}) {
  return buildSchema3BundleManifestV2(resolved, {
    bundleGeneration: "abcdef0123456789abcdef0123456789",
    baselineManifest: baselineManifest(resolved, options),
    exactCpuManifest: exactCpuManifest(resolved, options),
  });
}

function bundleDirectory() {
  return temporaryDirectory("schema3-bundle-");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForJsonFile(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filename)) {
      try { return JSON.parse(readFileSync(filename, "utf8")); } catch { /* retry partial write */ }
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for fixture file: ${filename}`);
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function validPinnedResult(resolved, manifest) {
  const cpu = manifest.schedule.cpus[0];
  return runWorkloadAttempt(resolved, {
    cpuAffinity: { cpu, tasksetPath: manifest.execution.tasksetPath },
  });
}

test("schema-3 initialization binds one workload and recovers a manifest-only restart", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const manifest = bundleManifest(resolved);
  const bundleDir = bundleDirectory();

  // This is the only durable point before state-directory creation. A retry
  // must finish initialization from the already-published canonical manifest.
  await createFileStateAdapter(bundleDir).commit(
    SCHEMA3_BUNDLE_FILE,
    canonicalSchema3BundleManifestLine(resolved, manifest),
  );
  const initialized = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.equal(initialized.manifest.version, 1);
  assert.equal("baseline" in initialized, false);
  assert.equal("baseline" in initialized.manifest, false);
  assert.equal(initialized.manifest.bundleFormatVersion, 3);
  assert.equal(initialized.manifest.runSchemaVersion, 3);
  assert.equal(initialized.manifest.workloadBinding.digest, resolved.digest);
  assert.equal(initialized.manifest.phaseControls.isolated, "supported");
  assert.equal(initialized.exactCpu.progress.status, "empty");
  assert.match(initialized.lease.owner.startTicks, /^[0-9]+$/);
  assert.equal(statSync(path.join(bundleDir, SCHEMA3_BUNDLE_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(bundleDir, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(bundleDir, SCHEMA3_EXACT_CPU_STATE_DIRECTORY)).mode & 0o777,
    0o700);

  const reopened = await readSchema3Bundle({ resolved, bundleDir });
  assert.deepEqual(reopened.manifest, initialized.manifest);
  assert.deepEqual(reopened.exactCpu, initialized.exactCpu);
  const retried = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.deepEqual(retried.manifest, initialized.manifest);
  assert.deepEqual(retried.exactCpu, initialized.exactCpu);

  const different = workload({ args: ["-e", " "], id: "schema3-changed" });
  await assert.rejects(readSchema3Bundle({ resolved: different, bundleDir }),
    /does not match the resolved workload/);
});

test("schema-3 manifest v2 binds baseline and exact-CPU state without changing v1", {
  timeout: 10_000,
}, async () => {
  const resolved = baselineWorkload();
  const manifest = bundleManifestV2(resolved);
  const bundleDir = bundleDirectory();

  await createFileStateAdapter(bundleDir).commit(
    SCHEMA3_BUNDLE_FILE,
    canonicalSchema3BundleManifestLine(resolved, manifest),
  );
  const initialized = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.equal(initialized.manifest.version, 2);
  assert.equal(initialized.manifest.phaseControls.baseline, "supported");
  assert.equal(initialized.manifest.phaseControls.isolated, "supported");
  assert.equal(initialized.baseline.progress.status, "empty");
  assert.equal(initialized.exactCpu.progress.status, "empty");
  assert.equal(statSync(path.join(bundleDir, SCHEMA3_BASELINE_STATE_DIRECTORY)).mode & 0o777,
    0o700);
  assert.equal(statSync(path.join(bundleDir, SCHEMA3_EXACT_CPU_STATE_DIRECTORY)).mode & 0o777,
    0o700);

  const reopened = await readSchema3Bundle({ resolved, bundleDir });
  assert.deepEqual(reopened.manifest, initialized.manifest);
  assert.deepEqual(reopened.baseline, initialized.baseline);
  assert.deepEqual(reopened.exactCpu, initialized.exactCpu);
  const retried = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.deepEqual(retried.manifest, initialized.manifest);
  assert.deepEqual(retried.baseline, initialized.baseline);

  const changedSchedule = bundleManifestV2(resolved, { childrenPerWave: 3 });
  await assert.rejects(initializeSchema3Bundle({
    resolved,
    manifest: changedSchedule,
    bundleDir,
  }), /different manifest/);
});

test("schema-3 manifest v1 remains readable for a workload with baseline capability", {
  timeout: 10_000,
}, async () => {
  const resolved = baselineWorkload();
  const manifest = bundleManifest(resolved);
  const bundleDir = bundleDirectory();

  assert.equal(manifest.version, 1);
  assert.equal(manifest.phaseControls.baseline, "unavailable");
  assert.equal("baseline" in manifest, false);
  const initialized = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.equal("baseline" in initialized, false);
  assert.equal(initialized.exactCpu.progress.status, "empty");

  const completed = await runOneSchema3ExactCpuAttempt({ resolved, bundleDir });
  assert.equal(completed.result.reason, "committed");
  assert.equal(completed.bundle.exactCpu.progress.status, "complete");
  await assert.rejects(runOneSchema3BaselineWave({ resolved, bundleDir }),
    /does not bind a baseline phase/);
});

test("the execution lease makes selecting, running, and committing one slot indivisible", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const exactManifest = exactCpuManifest(resolved);
  const manifest = buildSchema3BundleManifest(resolved, {
    bundleGeneration: "abcdef0123456789abcdef0123456789",
    exactCpuManifest: exactManifest,
  });
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  const resultFixture = await validPinnedResult(resolved, exactManifest);
  const started = deferred();
  const release = deferred();
  let launches = 0;
  const runAttempt = async (_resolved, options) => {
    launches += 1;
    assert.equal(fstatSync(options.retainedDirectory.fd, { bigint: true }).ino.toString(),
      options.retainedDirectory.inode);
    started.resolve();
    await release.promise;
    return resultFixture;
  };

  const first = runOneSchema3ExactCpuAttempt({
    resolved,
    bundleDir,
    runAttempt,
  });
  await started.promise;
  await assert.rejects(runOneSchema3ExactCpuAttempt({
    resolved,
    bundleDir,
    runAttempt,
  }), (error) => error instanceof BundleExecutionLeaseError &&
    error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  await assert.rejects(readSchema3Bundle({ resolved, bundleDir }),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  assert.equal(launches, 1);
  release.resolve();
  const completed = await first;
  assert.equal(completed.result.reason, "committed");
  assert.equal(completed.bundle.exactCpu.progress.status, "complete");

  const noOp = await runOneSchema3ExactCpuAttempt({ resolved, bundleDir, runAttempt });
  assert.equal(noOp.result.reason, "complete");
  assert.equal(launches, 1);
});

test("the schema-3 v2 lease makes a complete baseline wave one transaction", {
  timeout: 10_000,
}, async () => {
  const resolved = baselineWorkload();
  const manifest = bundleManifestV2(resolved);
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  const resultFixture = await runWorkloadAttempt(resolved);
  const started = deferred();
  const release = deferred();
  let launches = 0;
  const runAttempt = async (_resolved, options) => {
    launches += 1;
    assert.equal(fstatSync(options.retainedDirectory.fd, { bigint: true }).ino.toString(),
      options.retainedDirectory.inode);
    if (launches === 2) started.resolve();
    await release.promise;
    return resultFixture;
  };

  const first = runOneSchema3BaselineWave({ resolved, bundleDir, runAttempt });
  await started.promise;
  await assert.rejects(runOneSchema3BaselineWave({ resolved, bundleDir, runAttempt }),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  await assert.rejects(runOneSchema3ExactCpuAttempt({ resolved, bundleDir }),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  await assert.rejects(readSchema3Bundle({ resolved, bundleDir }),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  assert.equal(launches, 2);
  release.resolve();

  const completed = await first;
  assert.equal(completed.result.reason, "committed");
  assert.equal(completed.bundle.baseline.progress.status, "complete");
  assert.equal(completed.bundle.baseline.progress.committedWaves, 1);

  const noOp = await runOneSchema3BaselineWave({ resolved, bundleDir, runAttempt });
  assert.equal(noOp.result.reason, "complete");
  assert.equal(launches, 2);
});

test("an invalid schema-3 v2 baseline wave leaves the complete wave available", {
  timeout: 10_000,
}, async () => {
  const resolved = baselineWorkload();
  const manifest = bundleManifestV2(resolved);
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });

  const invalid = await runOneSchema3BaselineWave({
    resolved,
    bundleDir,
    runAttempt: async () => {
      throw Object.assign(new Error("fixture runner unavailable"), {
        code: "FIXTURE_UNAVAILABLE",
      });
    },
  });
  assert.equal(invalid.result.reason, "runner-error");
  assert.equal(invalid.bundle.baseline.progress.committedWaves, 0);

  const retried = await runOneSchema3BaselineWave({ resolved, bundleDir });
  assert.equal(retried.result.reason, "committed");
  assert.equal(retried.bundle.baseline.progress.status, "complete");
});

test("operationally invalid execution leaves the slot available for a retained production attempt", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const manifest = bundleManifest(resolved);
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });

  const invalid = await runOneSchema3ExactCpuAttempt({
    resolved,
    bundleDir,
    runAttempt: async () => {
      throw Object.assign(new Error("fixture runner unavailable"), { code: "FIXTURE_UNAVAILABLE" });
    },
  });
  assert.equal(invalid.result.reason, "runner-error");
  assert.equal(invalid.bundle.exactCpu.progress.committedAttempts, 0);

  // This harmless finite command uses the real supervisor. Its successful
  // protocol handshake proves the supervisor retained and validated the
  // bundle directory descriptor until its cleanup completed.
  const retried = await runOneSchema3ExactCpuAttempt({ resolved, bundleDir });
  assert.equal(retried.result.reason, "committed");
  assert.equal(retried.bundle.exactCpu.progress.status, "complete");
});

test("bundle readers fail closed on foreign root/state entries and live commit remnants", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const manifest = bundleManifest(resolved);

  const foreignRoot = bundleDirectory();
  writeFileSync(path.join(foreignRoot, "foreign.txt"), "unexpected\n", { mode: 0o600 });
  await assert.rejects(initializeSchema3Bundle({
    resolved,
    manifest,
    bundleDir: foreignRoot,
  }), /must be empty|unknown entry/);

  const foreignState = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir: foreignState });
  mkdirSync(path.join(foreignState, "state", "foreign"), { mode: 0o700 });
  await assert.rejects(readSchema3Bundle({ resolved, bundleDir: foreignState }),
    /state directory contains an unknown entry/);

  const v2Resolved = baselineWorkload();
  const v2Manifest = bundleManifestV2(v2Resolved);
  const missingV2State = bundleDirectory();
  await initializeSchema3Bundle({
    resolved: v2Resolved,
    manifest: v2Manifest,
    bundleDir: missingV2State,
  });
  rmSync(path.join(missingV2State, SCHEMA3_BASELINE_STATE_DIRECTORY), {
    recursive: true,
  });
  await assert.rejects(readSchema3Bundle({
    resolved: v2Resolved,
    bundleDir: missingV2State,
  }), /phase state directory is missing/);

  const liveTemporary = bundleDirectory();
  const liveName =
    `.fault-affinity-bundle.json.${process.pid}.0123456789abcdef.writing.tmp`;
  writeFileSync(path.join(liveTemporary, liveName), "incomplete", { mode: 0o600 });
  await assert.rejects(initializeSchema3Bundle({
    resolved,
    manifest,
    bundleDir: liveTemporary,
  }), /live writer/);
  assert.equal(existsSync(path.join(liveTemporary, liveName)), true);
});

test("a known dead-writer bundle temporary is reconciled before initialization", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const manifest = bundleManifest(resolved);
  const bundleDir = bundleDirectory();
  const orphan = path.join(bundleDir,
    ".fault-affinity-bundle.json.99999998.abcdef0123456789.writing.tmp");
  writeFileSync(orphan, "incomplete", { mode: 0o600 });

  const initialized = await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  assert.equal(initialized.exactCpu.progress.status, "empty");
  assert.equal(existsSync(orphan), false);
});

test("the supervisor retains bundle ownership while an interrupted owner cleans up", {
  timeout: 15_000,
}, async () => {
  const cwd = temporaryDirectory("schema3-retention-workload-");
  const readyFile = path.join(cwd, "ready.json");
  const resolved = resolveWorkloadSpec(leaseRetentionWorkloadSpec({ cwd, readyFile }));
  const manifest = bundleManifest(resolved);
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });

  const owner = spawn(process.execPath, [
    LEASE_RETENTION_OWNER,
    bundleDir,
    cwd,
    readyFile,
    "exact",
  ], {
    cwd: "/",
    env: {},
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const ownerExit = waitForChildExit(owner);
  let supervisorPid = null;
  try {
    const ready = await waitForJsonFile(readyFile);
    assert.equal(ready.pid > 1, true);
    assert.equal(ready.parentPid > 1, true);
    assert.equal(ready.inheritedBundleDirectory, false);
    supervisorPid = ready.parentPid;
    const supervisor = readLinuxProcessIdentity(supervisorPid);
    assert.equal(supervisor?.live, true);
    assert.equal(supervisor.processGroupId, supervisorPid);

    assert.equal(owner.kill("SIGTERM"), true);
    const ownerStatus = await ownerExit;
    assert.equal(ownerStatus.signal, "SIGTERM");

    await assert.rejects(
      withBundleExecutionLease({ bundleDir }, async () => "must-not-run"),
      (error) => error instanceof BundleExecutionLeaseError &&
        error.code === "BUNDLE_EXECUTION_LEASE_BUSY",
    );
    assert.equal(await withBundleExecutionLease({ bundleDir, waitMs: 3_000 },
      async () => "recovered"), "recovered");

    const reopened = await readSchema3Bundle({ resolved, bundleDir });
    assert.equal(reopened.exactCpu.progress.committedAttempts, 0);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
    if (supervisorPid !== null) {
      const current = readLinuxProcessIdentity(supervisorPid);
      if (current?.live && current.processGroupId === supervisorPid) {
        try { process.kill(-supervisorPid, "SIGKILL"); } catch { /* already complete */ }
      }
    }
  }
});

test("a v2 baseline supervisor retains bundle ownership during interrupted-owner cleanup", {
  timeout: 15_000,
}, async () => {
  const cwd = temporaryDirectory("schema3-baseline-retention-workload-");
  const readyFile = path.join(cwd, "ready.json");
  const resolved = resolveWorkloadSpec(leaseRetentionWorkloadSpec({ cwd, readyFile }));
  const manifest = bundleManifestV2(resolved);
  const bundleDir = bundleDirectory();
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });

  const owner = spawn(process.execPath, [
    LEASE_RETENTION_OWNER,
    bundleDir,
    cwd,
    readyFile,
    "baseline",
  ], {
    cwd: "/",
    env: {},
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const ownerExit = waitForChildExit(owner);
  let supervisorPid = null;
  try {
    const ready = await waitForJsonFile(readyFile);
    assert.equal(ready.pid > 1, true);
    assert.equal(ready.parentPid > 1, true);
    assert.equal(ready.inheritedBundleDirectory, false);
    supervisorPid = ready.parentPid;
    const supervisor = readLinuxProcessIdentity(supervisorPid);
    assert.equal(supervisor?.live, true);
    assert.equal(supervisor.processGroupId, supervisorPid);

    assert.equal(owner.kill("SIGTERM"), true);
    const ownerStatus = await ownerExit;
    assert.equal(ownerStatus.signal, "SIGTERM");

    await assert.rejects(
      withBundleExecutionLease({ bundleDir }, async () => "must-not-run"),
      (error) => error instanceof BundleExecutionLeaseError &&
        error.code === "BUNDLE_EXECUTION_LEASE_BUSY",
    );
    assert.equal(await withBundleExecutionLease({ bundleDir, waitMs: 3_000 },
      async () => "recovered"), "recovered");

    const reopened = await readSchema3Bundle({ resolved, bundleDir });
    assert.equal(reopened.baseline.progress.committedWaves, 0);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
    if (supervisorPid !== null) {
      const current = readLinuxProcessIdentity(supervisorPid);
      if (current?.live && current.processGroupId === supervisorPid) {
        try { process.kill(-supervisorPid, "SIGKILL"); } catch { /* already complete */ }
      }
    }
  }
});
