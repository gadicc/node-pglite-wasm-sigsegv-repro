import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ControlledLoadWorkerSetError,
  parseControlledLoadWorkerSetBoundaryEvidence,
  parseControlledLoadWorkerSetStartEvidence,
  parseControlledLoadWorkerSetStopEvidence,
  startControlledLoadWorkerSet,
} from "../controlled-load-workers.mjs";
import {
  BundleExecutionLeaseError,
  withBundleExecutionLease,
} from "../bundle-execution-lease.mjs";
import { readLinuxProcessIdentity } from "../attempt-runner.mjs";
import {
  managedWorkloadResultBinding,
  parseManagedWorkloadResult,
} from "../managed-workload-result.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/attempt-workload-fixture.mjs", import.meta.url));
const RETENTION_OWNER = fileURLToPath(new URL(
  "./fixtures/controlled-load-worker-set-owner.mjs",
  import.meta.url,
));
const directories = [];
const handles = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    if (handle.state !== "stopped") await handle.stop("test-cleanup");
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function launcher() {
  const directory = mkdtempSync(path.join(tmpdir(), "controlled-load-worker-"));
  directories.push(directory);
  const executable = path.join(directory, "worker");
  writeFileSync(executable,
    `#!${process.execPath}\nimport ${JSON.stringify(FIXTURE)};\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { directory, executable };
}

function workload(args = ["hold"]) {
  const files = launcher();
  return resolveWorkloadSpec({
    version: 1,
    id: "controlled-load-worker-fixture",
    label: "Controlled-load worker fixture",
    description: "Harmless waiting process for managed worker-set lifecycle tests.",
    risk: "standard",
    command: { executable: files.executable, args, cwd: files.directory },
    environment: {},
    attempt: {
      mode: "survive-window",
      timeoutMs: 5_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {},
    provenance: { completeness: "complete", files: [FIXTURE] },
  });
}

function allowedCpu() {
  const value = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof value, "string");
  return expandCpuList(value)[0];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForJson(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(filename, "utf8")); } catch { /* retry */ }
    await delay(10);
  }
  throw new Error(`timed out waiting for fixture file: ${filename}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function waitForState(handle, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.state === expected) return;
    await delay(10);
  }
  assert.equal(handle.state, expected);
}

test("a managed worker set verifies singleton readiness, boundaries, and complete stop", {
  timeout: 10_000,
}, async () => {
  const resolved = workload(["flood-hold", String(64 * 1024)]);
  const cpu = allowedCpu();
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [cpu],
    tasksetPath: "/usr/bin/taskset",
  });
  handles.push(handle);

  assert.equal(handle.state, "running");
  assert.equal(handle.failureCode, null);
  assert.equal(handle.startEvidence.execution.outputMode, "discard");
  assert.equal(handle.startEvidence.workers[0].cpu, cpu);
  assert.equal(handle.startEvidence.workers[0].supervisor.allowedCpuList, String(cpu));
  assert.equal(handle.startEvidence.workers[0].workload.allowedCpuList, String(cpu));
  assert.deepEqual(parseControlledLoadWorkerSetStartEvidence(
    resolved,
    handle.startEvidence,
  ), handle.startEvidence);

  const before = handle.verify("before-b");
  const after = handle.verify("after-b");
  assert.deepEqual(parseControlledLoadWorkerSetBoundaryEvidence(
    resolved,
    handle.startEvidence,
    before,
  ), before);
  assert.equal(before.workers[0].workload.pid, after.workers[0].workload.pid);
  assert.equal(before.workers[0].workload.startTicks, after.workers[0].workload.startTicks);

  const stopped = await handle.stop("complete");
  assert.equal(stopped.valid, true);
  assert.equal(stopped.failureCode, null);
  assert.equal(handle.state, "stopped");
  assert.deepEqual(await handle.stop("ignored-after-first-stop"), stopped);
  assert.deepEqual(parseControlledLoadWorkerSetStopEvidence(
    resolved,
    handle.startEvidence,
    stopped,
  ), stopped);
  const result = stopped.workers[0].result;
  assert.equal(result.observation.terminalReason, "external-cancel");
  assert.equal(result.observation.cleanupComplete, true);
  assert.deepEqual(parseManagedWorkloadResult(resolved, result), result);
  assert.match(managedWorkloadResultBinding(resolved, result).sha256, /^[a-f0-9]{64}$/);
  const changedBoundary = JSON.parse(JSON.stringify(before));
  changedBoundary.workers[0].workload.startTicks = "0";
  assert.throws(() => parseControlledLoadWorkerSetBoundaryEvidence(
    resolved,
    handle.startEvidence,
    changedBoundary,
  ), /does not match its ready identity/);
  const current = readLinuxProcessIdentity(result.process.workload.pid);
  assert.ok(current === null || !current.live ||
    current.startTicks !== result.process.workload.startTicks);
});

test("boundary drift invalidates the set and cancels the original worker", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [allowedCpu()],
    tasksetPath: "/usr/bin/taskset",
    readAllowedCpuList: () => "65535",
  });
  handles.push(handle);

  assert.throws(() => handle.verify("before-b"), (error) =>
    error instanceof ControlledLoadWorkerSetError &&
    error.code === "CONTROLLED_LOAD_WORKER_AFFINITY_MISMATCH");
  assert.equal(handle.state, "invalid");
  const stopped = await handle.stop("boundary-invalid");
  assert.equal(stopped.valid, false);
  assert.equal(stopped.failureCode, "CONTROLLED_LOAD_WORKER_AFFINITY_MISMATCH");
  assert.equal(stopped.workers[0].result.cleanup.groupDrained, true);
});

test("identity drift invalidates the set before a measured boundary", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [allowedCpu()],
    tasksetPath: "/usr/bin/taskset",
    readIdentity: () => null,
  });
  handles.push(handle);
  assert.throws(() => handle.verify("before-b"), (error) =>
    error instanceof ControlledLoadWorkerSetError &&
    error.code === "CONTROLLED_LOAD_WORKER_IDENTITY_MISMATCH");
  const stopped = await handle.stop("identity-invalid");
  assert.equal(stopped.valid, false);
  assert.equal(stopped.failureCode, "CONTROLLED_LOAD_WORKER_IDENTITY_MISMATCH");
});

test("a worker that fails before readiness cancels starting peers", async () => {
  const resolved = workload();
  let peerCancelled = false;
  await assert.rejects(startControlledLoadWorkerSet({
    resolved,
    cpus: [1, 2],
    tasksetPath: "/usr/bin/taskset",
    runManaged: async (_worker, options) => {
      if (options.cpuAffinity.cpu === 1) {
        throw Object.assign(new Error("fixture start failure"), {
          code: "FIXTURE_START_FAILURE",
        });
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
  }), (error) => error instanceof ControlledLoadWorkerSetError &&
    error.code === "FIXTURE_START_FAILURE");
  assert.equal(peerCancelled, true);
});

test("early worker termination cancels peers and produces invalid stop evidence", {
  timeout: 10_000,
}, async () => {
  const resolved = workload(["exit-after", "500", "0"]);
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [allowedCpu()],
    tasksetPath: "/usr/bin/taskset",
  });
  handles.push(handle);
  await waitForState(handle, "invalid");
  assert.equal(handle.failureCode, "CONTROLLED_LOAD_WORKER_EARLY_TERMINAL");
  const stopped = await handle.stop("early-terminal");
  assert.equal(stopped.valid, false);
  assert.equal(stopped.failureCode, "CONTROLLED_LOAD_WORKER_EARLY_TERMINAL");
  assert.equal(stopped.workers[0].result.observation.terminalReason, "natural-exit");
  const relabelled = JSON.parse(JSON.stringify(stopped));
  relabelled.workers[0].errorCode = null;
  assert.throws(() => parseControlledLoadWorkerSetStopEvidence(
    resolved,
    handle.startEvidence,
    relabelled,
  ), /status disagrees with its lifecycle record/);
});

test("external cancellation and managed-result drift remain operationally invalid", {
  timeout: 10_000,
}, async () => {
  const resolved = workload();
  const controller = new AbortController();
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [allowedCpu()],
    tasksetPath: "/usr/bin/taskset",
    signal: controller.signal,
  });
  handles.push(handle);
  controller.abort();
  await waitForState(handle, "invalid");
  const stopped = await handle.stop("operator-cancel");
  assert.equal(stopped.failureCode, "CONTROLLED_LOAD_EXTERNAL_CANCEL");
  const changed = JSON.parse(JSON.stringify(stopped.workers[0].result));
  changed.outputMode = "capture";
  assert.throws(() => parseManagedWorkloadResult(resolved, changed),
    /output mode is unsupported/);
  changed.outputMode = "discard";
  changed.readiness.errorCode = "TEST_READINESS_ERROR";
  assert.throws(() => parseManagedWorkloadResult(resolved, changed),
    /reported managed readiness/);
});

test("an interrupted owner keeps the lease until managed worker cleanup finishes", {
  timeout: 15_000,
}, async () => {
  const bundleDir = mkdtempSync(path.join(tmpdir(), "controlled-load-retained-bundle-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "controlled-load-retained-workload-"));
  directories.push(bundleDir, cwd);
  const ownerReadyFile = path.join(cwd, "owner-ready.json");
  const workerReadyFile = path.join(cwd, "worker-ready.json");
  const owner = spawn(process.execPath, [
    RETENTION_OWNER,
    bundleDir,
    cwd,
    ownerReadyFile,
    workerReadyFile,
    String(allowedCpu()),
  ], {
    cwd: "/",
    env: {},
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const ownerExit = waitForExit(owner);
  let supervisor = null;
  try {
    const [ownerReady, workerReady] = await Promise.all([
      waitForJson(ownerReadyFile),
      waitForJson(workerReadyFile),
    ]);
    supervisor = ownerReady.supervisor;
    assert.equal(workerReady.inheritedBundleDirectory, false);
    assert.equal(readLinuxProcessIdentity(supervisor.pid)?.live, true);

    assert.equal(owner.kill("SIGTERM"), true);
    assert.equal((await ownerExit).signal, "SIGTERM");
    await assert.rejects(withBundleExecutionLease({ bundleDir }, async () => "must-not-run"),
      (error) => error instanceof BundleExecutionLeaseError &&
        error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
    assert.equal(await withBundleExecutionLease({ bundleDir, waitMs: 3_000 },
      async () => "recovered"), "recovered");
    const current = readLinuxProcessIdentity(supervisor.pid);
    assert.ok(current === null || !current.live || current.startTicks !== supervisor.startTicks);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
    if (supervisor !== null) {
      const current = readLinuxProcessIdentity(supervisor.pid);
      if (current?.live && current.startTicks === supervisor.startTicks &&
          current.processGroupId === supervisor.pid) {
        try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* already complete */ }
      }
    }
  }
});
