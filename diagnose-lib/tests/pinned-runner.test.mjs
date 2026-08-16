import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_COUNT,
  MAX_CPU_ID,
  MAX_SEED,
  buildBalancedGroupOrders,
  buildConcurrentLaunchOrders,
  buildIsolatedOrders,
  classifyChildOutcome,
  classifyIndividualChildOutcomeV2,
  compressCpuList,
  defaultPinnedLauncher,
  defaultPinnedLauncherV2,
  expandCpuList,
  flattenCpuOrders,
  flattenGroupOrders,
  readNoTurbo,
  runPinnedChild,
} from "../pinned-runner.mjs";

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "pinned-runner-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function assertPositionBalanced(orders) {
  const cpus = [...orders[0]].sort((left, right) => left - right);
  const counts = new Map(cpus.map((cpu) => [cpu, Array(cpus.length).fill(0)]));
  for (const order of orders) {
    assert.deepEqual([...order].sort((left, right) => left - right), cpus);
    order.forEach((cpu, position) => { counts.get(cpu)[position] += 1; });
  }
  for (const perPosition of counts.values()) {
    assert.ok(Math.max(...perPosition) - Math.min(...perPosition) <= 1, perPosition.join(","));
  }
}

test("CPU list expansion and compression are strict and round-trip ordered sets", () => {
  for (const spec of ["0", "8-11,19,21", "2,0-1,5-6,4"]) {
    assert.equal(compressCpuList(expandCpuList(spec)), spec);
  }
  assert.deepEqual(expandCpuList(`0,${MAX_CPU_ID}`), [0, MAX_CPU_ID]);
  for (const invalid of ["", "01", "1-", "1--2", "2-1", "1,1", "0-2,2", "1, 2", String(MAX_CPU_ID + 1)]) {
    assert.throws(() => expandCpuList(invalid));
  }
  assert.throws(() => compressCpuList([]), /non-empty CPU array/);
  assert.throws(() => compressCpuList([1, 1]), /duplicate/);
  assert.throws(() => compressCpuList(["1"]), /integer/);
});

test("isolated orders are seeded, deterministic, cyclic, and position-balanced", () => {
  const cpus = [10, 11, 18, 19, 21];
  const first = buildIsolatedOrders(cpus, 17, 20260808);
  const second = buildIsolatedOrders(cpus, 17, 20260808);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, buildIsolatedOrders(cpus, 17, 20260809));
  assertPositionBalanced(first);

  for (let blockStart = 0; blockStart + cpus.length <= first.length; blockStart += cpus.length) {
    const block = first.slice(blockStart, blockStart + cpus.length);
    for (const cpu of cpus) {
      const positions = block.map((order) => order.indexOf(cpu)).sort((left, right) => left - right);
      assert.deepEqual(positions, [0, 1, 2, 3, 4]);
    }
  }

  assert.deepEqual(buildIsolatedOrders([8, 9, 10, 11], 6, 7), [
    [10, 9, 11, 8],
    [8, 10, 9, 11],
    [11, 8, 10, 9],
    [9, 11, 8, 10],
    [9, 10, 8, 11],
    [10, 8, 11, 9],
  ]);
});

test("group and concurrent launch helpers independently balance their positions", () => {
  const groups = buildBalancedGroupOrders(3, 8, 99);
  const launches = buildConcurrentLaunchOrders([8, 9, 10, 11], 11, 99);
  assert.deepEqual(groups, buildBalancedGroupOrders(3, 8, 99));
  assert.deepEqual(launches, buildConcurrentLaunchOrders([8, 9, 10, 11], 11, 99));
  assertPositionBalanced(groups);
  assertPositionBalanced(launches);
  assert.notDeepEqual(launches, buildIsolatedOrders([8, 9, 10, 11], 11, 99));
});

test("flattened plans preserve exact one-based round and position", () => {
  assert.deepEqual(flattenCpuOrders([[9, 8], [8, 9]]), [
    { round: 1, position: 1, cpu: 9 },
    { round: 1, position: 2, cpu: 8 },
    { round: 2, position: 1, cpu: 8 },
    { round: 2, position: 2, cpu: 9 },
  ]);
  assert.deepEqual(flattenGroupOrders([[1, 0], [0, 1]]), [
    { round: 1, position: 1, groupIndex: 1 },
    { round: 1, position: 2, groupIndex: 0 },
    { round: 2, position: 1, groupIndex: 0 },
    { round: 2, position: 2, groupIndex: 1 },
  ]);
  assert.throws(() => flattenCpuOrders([[1, 2], [1, 3]]), /same CPU set/);
  assert.throws(() => flattenGroupOrders([[0, 0]]), /each group index/);
});

test("CPU, count, schedule-size, and seed bounds fail closed", () => {
  for (const cpus of [[-1], [MAX_CPU_ID + 1], [1.5], ["1"], [1, 1]]) {
    assert.throws(() => buildIsolatedOrders(cpus, 1, 0));
    assert.throws(() => buildConcurrentLaunchOrders(cpus, 1, 0));
  }
  for (const rounds of [0, -1, 1.5, "1", MAX_COUNT + 1]) {
    assert.throws(() => buildIsolatedOrders([0], rounds, 0));
  }
  for (const seed of [-1, 1.5, "1", MAX_SEED + 1]) {
    assert.throws(() => buildIsolatedOrders([0], 1, seed));
  }
  assert.throws(() => buildIsolatedOrders([0, 1], 500_001, 0), /schedule exceeds/);
  assert.throws(() => buildBalancedGroupOrders(2, 500_001, 0), /schedule exceeds/);
  assert.throws(() => buildBalancedGroupOrders(0, 1, 0), /group count/);
});

test("outcome classification accepts only clean exit and SIGSEGV forms", () => {
  assert.deepEqual(classifyChildOutcome({ exitCode: 0, signal: null }), {
    outcome: "pass", validOutcome: true, invalidReason: null,
  });
  for (const status of [
    { exitCode: 139, signal: null },
    { exitCode: null, signal: "SIGSEGV" },
  ]) {
    assert.deepEqual(classifyChildOutcome(status), {
      outcome: "sigsegv", validOutcome: true, invalidReason: null,
    });
  }
  for (const status of [
    { exitCode: 1, signal: null },
    { exitCode: null, signal: "SIGTERM" },
    { exitCode: 139, signal: "SIGTERM" },
    { exitCode: 0, signal: "SIGSEGV" },
    { exitCode: null, signal: null },
    { exitCode: 0, signal: null, launchError: new Error("failed") },
    { exitCode: 0, signal: null, canceled: true },
  ]) {
    assert.equal(classifyChildOutcome(status).validOutcome, false, JSON.stringify(status));
    assert.equal(classifyChildOutcome(status).outcome, "invalid", JSON.stringify(status));
  }
});

test("no_turbo observations are direct read-only and distinguish invalid/unavailable", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "no_turbo");
  writeFileSync(file, "1\n", { mode: 0o400 });
  assert.deepEqual(readNoTurbo(file), { status: "observed", value: 1, errorCode: null });
  assert.equal(readFileSync(file, "utf8"), "1\n");

  chmodSync(file, 0o600);
  writeFileSync(file, "unknown\n", { mode: 0o600 });
  assert.deepEqual(readNoTurbo(file), { status: "invalid", value: null, errorCode: "UNEXPECTED_VALUE" });
  assert.deepEqual(readNoTurbo(path.join(directory, "missing")), {
    status: "unavailable", value: null, errorCode: "ENOENT",
  });
});

test("default launcher stays in the outer supervisor group and signals only its direct child", () => {
  const child = { pid: 42_424 };
  const spawnCalls = [];
  const killCalls = [];
  const descriptor = defaultPinnedLauncher({
    cpu: 19,
    command: "/mock/node",
    args: ["/mock/child.mjs", "argument with spaces"],
    cwd: "/mock/repo",
    env: { MOCKED: "1" },
    tasksetPath: "/mock/taskset",
    shellPath: "/mock/bash",
  }, {
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    },
    killProcess(pid, signal) {
      killCalls.push([pid, signal]);
    },
  });

  assert.equal(descriptor.child, child);
  assert.deepEqual(spawnCalls, [{
    file: "/mock/bash",
    args: [
      "-c",
      "ulimit -c 0; exec \"$@\"",
      "pinned-runner",
      "/mock/taskset",
      "-c",
      "19",
      "/mock/node",
      "/mock/child.mjs",
      "argument with spaces",
    ],
    options: {
      cwd: "/mock/repo",
      env: { MOCKED: "1" },
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  }]);
  assert.equal(descriptor.cancel("SIGTERM"), true);
  assert.equal(descriptor.cancel("SIGKILL"), true);
  assert.deepEqual(killCalls, [[42_424, "SIGTERM"], [42_424, "SIGKILL"]]);
  assert.ok(killCalls.every(([pid]) => pid > 0), "must never address a process group with a negative PID");
});

test("V2 isolated launcher pins the verifier worker to the target CPU", () => {
  const child = { pid: 42_425, stdout: new PassThrough() };
  const spawnCalls = [];
  const descriptor = defaultPinnedLauncherV2({
    cpu: 12,
    command: "/mock/node",
    args: ["/mock/child.mjs"],
    cwd: "/mock/repo",
    env: { DIAG_TEST_FORBID_WORKLOAD: "1" },
    stderrBytes: 16_384,
    tasksetPath: "/mock/taskset",
    shellPath: "/mock/bash",
  }, {
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    },
    killProcess() {},
  });
  assert.equal(descriptor.launchProtocol, child.stdout);
  assert.equal(spawnCalls[0].file, "/mock/bash");
  assert.deepEqual(spawnCalls[0].args.slice(0, 7), [
    "-c", "ulimit -c 0; exec \"$@\"", "pinned-runner-v2",
    "/mock/taskset", "-c", "12", process.execPath,
  ]);
  assert.match(spawnCalls[0].args[7], /pinned-launch-worker\.mjs$/);
  assert.deepEqual(spawnCalls[0].args.slice(8), [
    "12", "16384", "/mock/node", "/mock/child.mjs",
  ]);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnCalls[0].options.detached, false);
});

test("V2 concurrent launcher keeps its verifier on the controller CPU", () => {
  const child = { pid: 42_426, stdout: new PassThrough() };
  const spawnCalls = [];
  const descriptor = defaultPinnedLauncherV2({
    cpu: 12,
    witnessCpu: 3,
    command: "/mock/node",
    args: ["/mock/child.mjs", "argument with spaces"],
    cwd: "/mock/repo",
    env: { MOCKED: "1" },
    stderrBytes: 16_384,
    tasksetPath: "/mock/taskset",
    shellPath: "/mock/bash",
  }, {
    spawnProcess(file, args, options) {
      spawnCalls.push({ file, args, options });
      return child;
    },
    killProcess() {},
  });
  assert.equal(descriptor.launchProtocol, child.stdout);
  assert.equal(spawnCalls[0].file, "/mock/bash");
  assert.deepEqual(spawnCalls[0].args.slice(0, 7), [
    "-c", "ulimit -c 0; exec \"$@\"", "pinned-runner-v2",
    "/mock/taskset", "-c", "3", process.execPath,
  ]);
  assert.match(spawnCalls[0].args[7], /pinned-launch-worker\.mjs$/);
  assert.deepEqual(spawnCalls[0].args.slice(8), [
    "--controller", "3", "12", "16384", "/mock/taskset", "/mock/bash",
    "/mock/node", "/mock/child.mjs", "argument with spaces",
  ]);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnCalls[0].options.detached, false);
});

test("default launcher cancellation escalates TERM to bounded direct-child KILL without spawning", async () => {
  const child = new EventEmitter();
  child.pid = 51_515;
  child.stderr = new PassThrough();
  const spawnOptions = [];
  const killCalls = [];
  let closed = false;
  const finish = (signal) => {
    if (closed) return;
    closed = true;
    child.stderr.end();
    child.emit("exit", null, signal);
    child.emit("close", null, signal);
  };
  const launcher = (request) => defaultPinnedLauncher(request, {
    spawnProcess(_file, _args, options) {
      spawnOptions.push(options);
      return child;
    },
    killProcess(pid, signal) {
      killCalls.push([pid, signal]);
      if (signal === "SIGKILL") queueMicrotask(() => finish(signal));
    },
  });
  const controller = new AbortController();
  const promise = runPinnedChild({
    cpu: 11,
    command: "/mock/child",
    launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
    signal: controller.signal,
    cancelGraceMs: 0,
  });
  controller.abort();
  const result = await promise;

  assert.equal(spawnOptions.length, 1);
  assert.equal(spawnOptions[0].detached, false);
  assert.deepEqual(killCalls, [[51_515, "SIGTERM"], [51_515, "SIGKILL"]]);
  assert.equal(result.canceled, true);
  assert.equal(result.invalidReason, "canceled");
  assert.equal(result.signal, "SIGKILL");
});

function scriptedClock({ startEpochMs = 1_800_000_000_000, endEpochMs = 1_800_000_002_250,
  startMonotonicNs = 5_000_000_000n, endMonotonicNs = 7_250_000_123n } = {}) {
  const epochs = [startEpochMs, endEpochMs];
  const monotonic = [startMonotonicNs, endMonotonicNs];
  return {
    epochMilliseconds() {
      assert.ok(epochs.length > 0, "unexpected epoch clock read");
      return epochs.shift();
    },
    monotonicNanoseconds() {
      assert.ok(monotonic.length > 0, "unexpected monotonic clock read");
      return monotonic.shift();
    },
  };
}

function scriptedNoTurbo(values = [1, 1]) {
  return () => {
    assert.ok(values.length > 0, "unexpected no_turbo read");
    return { status: "observed", value: values.shift(), errorCode: null };
  };
}

function scriptedLauncher(script = {}) {
  const requests = [];
  const cancelSignals = [];
  const launcher = (request) => {
    requests.push(request);
    if (script.throwError) throw script.throwError;
    const child = new EventEmitter();
    child.pid = 42_424;
    child.stderr = new PassThrough();
    let closed = false;
    const finish = (code, signal) => {
      if (closed) return;
      closed = true;
      if (script.stderr !== undefined) child.stderr.write(script.stderr);
      child.stderr.end();
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    };
    if (!script.neverExit) {
      setImmediate(() => {
        if (script.launchError) child.emit("error", script.launchError);
        finish(Object.hasOwn(script, "exitCode") ? script.exitCode : 0, script.signal ?? null);
      });
    }
    return {
      child,
      ...(script.secureLaunch ? { secureLaunch: true } : {}),
      cancel(signal) {
        cancelSignals.push(signal);
        if (script.closeOnCancel !== false) queueMicrotask(() => finish(null, signal));
        else if (signal === "SIGKILL") queueMicrotask(() => finish(null, signal));
        return true;
      },
    };
  };
  return { launcher, requests, cancelSignals };
}

test("runPinnedChild V2 accepts a canonical private worker result frame", async () => {
  const child = new EventEmitter();
  child.pid = 42_426;
  child.stderr = new PassThrough();
  const launchProtocol = new PassThrough();
  const workerResult = {
    version: 1,
    cpu: 12,
    launchState: "launched",
    exitCode: 0,
    signal: null,
    canceled: false,
    launchError: null,
    stderr: {
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: "0",
      excerptBase64: "",
      excerptBytes: 0,
      truncated: false,
    },
  };
  let launchRequest = null;
  const launcher = (request) => {
    launchRequest = request;
    setImmediate(() => {
      launchProtocol.end(`${JSON.stringify(workerResult)}\n`);
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return {
      child,
      launchProtocol,
      cancel() { return true; },
    };
  };

  const result = await runPinnedChild({
    runnerVersion: 2,
    cpu: 12,
    witnessCpu: 3,
    command: "/mock/node",
    launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo([0, 0]),
  });

  assert.equal(result.outcome, "pass");
  assert.equal(result.validOutcome, true);
  assert.equal(result.launchState, "launched");
  assert.equal(result.launchError, null);
  assert.deepEqual(result.stderrEvidence, workerResult.stderr);
  assert.equal(launchRequest.witnessCpu, 3);
});

test("runPinnedChild emits canonical JSON-safe boundaries and bounded stderr", async () => {
  const fake = scriptedLauncher({ exitCode: 0, stderr: "abcdefgh" });
  const result = await runPinnedChild({
    cpu: 19,
    command: "/mock/node",
    args: ["/mock/child.mjs"],
    cwd: "/mock/repo",
    launcher: fake.launcher,
    clock: scriptedClock(),
    noTurboPath: "/mock/no_turbo",
    noTurboReader: scriptedNoTurbo([1, 0]),
    stderrBytes: 5,
  });

  assert.deepEqual(fake.requests, [{
    cpu: 19,
    command: "/mock/node",
    args: ["/mock/child.mjs"],
    cwd: "/mock/repo",
    env: undefined,
    tasksetPath: undefined,
    shellPath: undefined,
  }]);
  assert.deepEqual(result.timing, {
    startEpochMs: 1_800_000_000_000,
    endEpochMs: 1_800_000_002_250,
    startMonotonicNs: "5000000000",
    endMonotonicNs: "7250000123",
    durationNs: "2250000123",
    durationMs: 2250.000123,
    elapsedSec: 2,
  });
  assert.deepEqual(result.noTurbo, {
    path: "/mock/no_turbo",
    start: { status: "observed", value: 1, errorCode: null },
    end: { status: "observed", value: 0, errorCode: null },
  });
  assert.equal(result.outcome, "pass");
  assert.equal(result.validOutcome, true);
  assert.equal(result.stderr, "abcde");
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.launchError, null);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("V2 classifies securely launched workload failures without changing V1 semantics", () => {
  for (const status of [
    { exitCode: 1, signal: null },
    { exitCode: null, signal: "SIGILL" },
    { exitCode: null, signal: "SIGABRT" },
  ]) {
    assert.deepEqual(classifyIndividualChildOutcomeV2({ ...status, secureLaunch: true }), {
      outcome: "other-workload-failure", validOutcome: true, invalidReason: null,
    });
    assert.equal(classifyChildOutcome(status).validOutcome, false);
  }
  assert.deepEqual(
    classifyIndividualChildOutcomeV2({ exitCode: 139, signal: null, secureLaunch: true }),
    { outcome: "other-workload-failure", validOutcome: true, invalidReason: null },
  );
  assert.deepEqual(classifyChildOutcome({ exitCode: 139, signal: null }), {
    outcome: "sigsegv", validOutcome: true, invalidReason: null,
  });
  for (const status of [
    { exitCode: 1, signal: null, secureLaunch: false },
    { exitCode: 1, signal: null, secureLaunch: true, canceled: true },
    { exitCode: 0, signal: null, secureLaunch: true, launchError: new Error("launch") },
    { exitCode: 1, signal: "SIGILL", secureLaunch: true },
    { exitCode: null, signal: "SIGBANANA", secureLaunch: true },
  ]) {
    assert.equal(classifyIndividualChildOutcomeV2(status).outcome, "operational-invalid");
    assert.equal(classifyIndividualChildOutcomeV2(status).validOutcome, false);
  }
});

test("runPinnedChild V2 retains exact status and bounded stderr evidence", async () => {
  for (const script of [
    { exitCode: 1, signal: null, stderr: "exit one", expectedSignal: null },
    { exitCode: null, signal: "SIGILL", stderr: "illegal", expectedSignal: "SIGILL" },
    { exitCode: null, signal: "SIGABRT", stderr: "abort", expectedSignal: "SIGABRT" },
  ]) {
    const fake = scriptedLauncher({ ...script, secureLaunch: true });
    const result = await runPinnedChild({
      runnerVersion: 2,
      cpu: 19,
      command: "/mock/node",
      launcher: fake.launcher,
      clock: scriptedClock(),
      noTurboReader: scriptedNoTurbo([0, 0]),
      stderrBytes: 4,
    });
    assert.equal(result.outcome, "other-workload-failure");
    assert.equal(result.validOutcome, true);
    assert.equal(result.exitCode, script.exitCode);
    assert.equal(result.signal, script.expectedSignal);
    assert.equal(result.launchState, "launched");
    assert.equal(result.stderrEvidence.excerptBytes, 4);
    assert.equal(result.stderrEvidence.bytes, String(Buffer.byteLength(script.stderr)));
    assert.equal(result.stderrEvidence.truncated, Buffer.byteLength(script.stderr) > 4);
    assert.match(result.stderrEvidence.sha256, /^[a-f0-9]{64}$/);
  }
});

test("runPinnedChild V2 makes unverified launch and cancellation operational-invalid", async () => {
  const unverified = await runPinnedChild({
    runnerVersion: 2,
    cpu: 19,
    command: "/mock/node",
    launcher: scriptedLauncher({ exitCode: 1 }).launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo([0, 0]),
  });
  assert.equal(unverified.outcome, "operational-invalid");
  assert.equal(unverified.invalidReason, "launch-error");

  const controller = new AbortController();
  controller.abort();
  const canceled = await runPinnedChild({
    runnerVersion: 2,
    cpu: 19,
    command: "/mock/node",
    launcher: scriptedLauncher({ secureLaunch: true }).launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo([0, 0]),
    signal: controller.signal,
  });
  assert.equal(canceled.outcome, "operational-invalid");
  assert.equal(canceled.invalidReason, "canceled");

  const unsafeBoundary = await runPinnedChild({
    runnerVersion: 2,
    cpu: 19,
    command: "/mock/node",
    launcher: scriptedLauncher({ secureLaunch: true }).launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo([
      { status: "unavailable", value: null, errorCode: "ENOENT" },
      { status: "observed", value: 0, errorCode: null },
    ]),
  });
  assert.equal(unsafeBoundary.outcome, "operational-invalid");
  assert.equal(unsafeBoundary.validOutcome, false);
  assert.equal(unsafeBoundary.invalidReason, "unsafe-boundary");
});

test("runPinnedChild keeps exit 139 valid but rejects launcher and other exits", async () => {
  const run = async (script) => runPinnedChild({
    cpu: 0,
    command: "/mock/child",
    launcher: scriptedLauncher(script).launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
  });
  assert.deepEqual(
    (({ outcome, validOutcome }) => ({ outcome, validOutcome }))(await run({ exitCode: 139 })),
    { outcome: "sigsegv", validOutcome: true },
  );
  assert.deepEqual(
    (({ outcome, validOutcome, invalidReason }) => ({ outcome, validOutcome, invalidReason }))(
      await run({ exitCode: 2 }),
    ),
    { outcome: "invalid", validOutcome: false, invalidReason: "unexpected-exit" },
  );
  const failedLaunch = await run({ throwError: Object.assign(new Error("mock launch failed"), { code: "ENOENT" }) });
  assert.equal(failedLaunch.outcome, "invalid");
  assert.equal(failedLaunch.invalidReason, "launch-error");
  assert.deepEqual(failedLaunch.launchError, { code: "ENOENT", message: "mock launch failed" });
});

test("runPinnedChild cancels the child as a signal-safe invalid observation", async () => {
  const controller = new AbortController();
  const fake = scriptedLauncher({ closeOnCancel: true });
  const promise = runPinnedChild({
    cpu: 11,
    command: "/mock/child",
    launcher: fake.launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
    signal: controller.signal,
    cancelGraceMs: 0,
  });
  controller.abort();
  const result = await promise;
  assert.deepEqual(fake.cancelSignals, ["SIGTERM"]);
  assert.equal(result.canceled, true);
  assert.equal(result.outcome, "invalid");
  assert.equal(result.validOutcome, false);
  assert.equal(result.invalidReason, "canceled");
  assert.equal(result.signal, "SIGTERM");
});

test("runPinnedChild escalates ignored cancellation and does not launch an already-aborted run", async () => {
  const controller = new AbortController();
  const fake = scriptedLauncher({ closeOnCancel: false, neverExit: true });
  const promise = runPinnedChild({
    cpu: 11,
    command: "/mock/child",
    launcher: fake.launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
    signal: controller.signal,
    cancelGraceMs: 0,
  });
  controller.abort();
  const result = await promise;
  assert.deepEqual(fake.cancelSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.invalidReason, "canceled");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const never = scriptedLauncher();
  const skipped = await runPinnedChild({
    cpu: 11,
    command: "/mock/child",
    launcher: never.launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
    signal: alreadyAborted.signal,
  });
  assert.equal(never.requests.length, 0);
  assert.equal(skipped.invalidReason, "canceled");
});

test("runPinnedChild strictly validates execution inputs before launching", async () => {
  const fake = scriptedLauncher();
  const base = {
    cpu: 0,
    command: "/mock/child",
    launcher: fake.launcher,
    clock: scriptedClock(),
    noTurboReader: scriptedNoTurbo(),
  };
  for (const override of [
    { cpu: -1 },
    { cpu: MAX_CPU_ID + 1 },
    { cpu: "0" },
    { command: "" },
    { command: "bad\0command" },
    { args: [1] },
    { stderrBytes: -1 },
    { runnerVersion: 2, witnessCpu: -1 },
    { runnerVersion: 2, witnessCpu: 0 },
    { runnerVersion: 1, witnessCpu: 1 },
    { cancelGraceMs: 60_001 },
    { launcher: null },
    { noTurboReader: null },
    { clock: {} },
  ]) {
    await assert.rejects(runPinnedChild({ ...base, ...override }));
  }
  assert.equal(fake.requests.length, 0);
});
