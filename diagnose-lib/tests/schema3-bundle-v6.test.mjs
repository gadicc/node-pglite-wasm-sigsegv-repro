import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BundleExecutionLeaseError,
} from "../bundle-execution-lease.mjs";
import {
  buildDebuggerPhaseManifest,
} from "../debugger-phase.mjs";
import {
  buildExactCpuPhaseManifest,
} from "../exact-cpu-phase.mjs";
import {
  SCHEMA3_BUNDLE_MANIFEST_V6_VERSION,
  Schema3BundleError,
  buildSchema3BundleManifestV6,
  canonicalSchema3BundleManifestLine,
  initializeSchema3Bundle,
  parseSchema3BundleManifest,
  readSchema3Bundle,
  runOneSchema3DebuggerAttempt,
  runOneSchema3ExactCpuAttempt,
} from "../schema3-bundle.mjs";
import { buildSchema3BundleSummary } from "../../src/fault-affinity/schema3-summary.mjs";
import { createFileStateAdapter } from "../pinned-protocol.mjs";
import {
  customWorkloadEnvironmentBindingKey,
  resolveCustomWorkloadFile,
} from "../../workloads/catalog.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const FAKE_DEBUGGER = fileURLToPath(
  new URL("./fixtures/fake-debugger-fixture.mjs", import.meta.url),
);
const GENERATION = "0123456789abcdef0123456789abcdef";
const BUNDLE_GENERATION = "abcdef0123456789abcdef0123456789";

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
  return Number(status.match(/^Cpus_allowed_list:\s*(\S+)/m)[1].split(/[,-]/)[0]);
}

function fixture({ mode = "exited", maxRuns = 4, maxCaptures = 2, gdb = true } = {}) {
  const directory = temporaryDirectory("schema3-v6-");
  const debuggerPath = path.join(directory, "fake-debugger");
  writeFileSync(debuggerPath,
    `#!${process.execPath}\nimport ${JSON.stringify(FAKE_DEBUGGER)};\n`,
    { mode: 0o700 });
  const targetPath = path.join(directory, "target-fixture");
  writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "schema3-v6-fixture",
    label: "Schema-3 v6 fixture",
    description: "Harmless finite process standing in for a debugger target.",
    risk: "standard",
    command: { executable: targetPath, args: [], cwd: directory },
    environment: { set: { FAKE_DEBUGGER_MODE: mode } },
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true, gdb },
    provenance: { completeness: "complete", files: [] },
  });
  const cpu = allowedCpu();
  const debuggerManifest = buildDebuggerPhaseManifest(resolved, {
    generation: GENERATION,
    cpu,
    maxRuns,
    maxCaptures,
    debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 30_000,
    termGraceMs: 500,
    killGraceMs: 1_000,
  });
  const exactCpuManifest = buildExactCpuPhaseManifest(resolved, {
    generation: "00112233445566778899aabbccddeeff",
    cpus: [cpu],
    rounds: 1,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
  });
  const manifest = buildSchema3BundleManifestV6(resolved, {
    bundleGeneration: BUNDLE_GENERATION,
    debuggerManifest,
    exactCpuManifest,
  });
  return { directory, debuggerPath, targetPath, resolved, manifest, cpu };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("a v6 manifest builds, binds, and round-trips canonically", () => {
  const files = fixture();
  const manifest = files.manifest;

  assert.equal(manifest.version, SCHEMA3_BUNDLE_MANIFEST_V6_VERSION);
  assert.equal(manifest.bundleGeneration, BUNDLE_GENERATION);
  assert.equal(manifest.workload.id, files.resolved.id);
  assert.equal(manifest.phaseControls.gdb, "supported");
  assert.equal(manifest.phaseControls.isolated, "supported");
  assert.equal(manifest.phaseControls.baseline, "unsupported");
  assert.equal(manifest.debugger.protocol, "gdb-capture-v1");
  assert.equal(manifest.debugger.stateDirectory, "state/debugger");
  assert.equal(manifest.debugger.manifest.schedule.cpu, files.cpu);
  assert.equal(manifest.exactCpu.protocol, "isolated-exact-cpu-v1");
  assert.equal(Object.hasOwn(manifest, "controlledLoad"), false);
  assert.equal(Object.hasOwn(manifest, "auxiliaryWorkload"), false);
  assert.equal(Object.hasOwn(manifest, "auxiliaryWorkloadBinding"), false);

  const line = canonicalSchema3BundleManifestLine(files.resolved, manifest);
  assert.equal(line.at(-1), 0x0a);
  assert.deepEqual(parseSchema3BundleManifest(files.resolved,
    JSON.parse(line.toString("utf8"))), manifest);
  assert.equal(Object.isFrozen(manifest.debugger.manifest), true);
});

test("v6 requires the isolated and gdb capabilities and rejects manifest tampering", () => {
  const files = fixture();
  const noGdb = resolveWorkloadSpec({
    version: 1,
    id: "schema3-v6-no-gdb",
    label: "No-GDB fixture",
    description: "Workload without debugger support.",
    risk: "standard",
    command: {
      executable: files.targetPath,
      args: [],
      cwd: files.directory,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV"], mappedExits: [] },
    capabilities: { isolated: true, gdb: false },
    provenance: { completeness: "complete", files: [] },
  });
  assert.throws(() => buildDebuggerPhaseManifest(noGdb, {
    generation: GENERATION,
    cpu: files.cpu,
    maxRuns: 4,
    maxCaptures: 2,
    debuggerPath: files.debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 30_000,
    termGraceMs: 500,
    killGraceMs: 1_000,
  }), /does not declare debugger support/);
  const noIsolated = resolveWorkloadSpec({
    version: 1,
    id: "schema3-v6-no-isolated",
    label: "No-isolated fixture",
    description: "Workload without isolated exact-CPU support.",
    risk: "standard",
    command: {
      executable: files.targetPath,
      args: [],
      cwd: files.directory,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV"], mappedExits: [] },
    capabilities: { isolated: false, gdb: true },
    provenance: { completeness: "complete", files: [] },
  });
  assert.throws(() => buildExactCpuPhaseManifest(noIsolated, {
    generation: "00112233445566778899aabbccddeeff",
    cpus: [files.cpu],
    rounds: 1,
    seed: 20260819,
    tasksetPath: "/usr/bin/taskset",
  }), /does not declare isolated exact-CPU support/);

  const cases = [
    (value) => { value.version = 5; },
    (value) => { value.version = 7; },
    (value) => { value.bundleGeneration = "A".repeat(32); },
    (value) => { value.workload.digest = "0".repeat(64); },
    (value) => { value.workloadBinding.digest = "0".repeat(64); },
    (value) => { value.phaseControls.gdb = "unavailable"; },
    (value) => { value.debugger.protocol = "other"; },
    (value) => { value.debugger.stateDirectory = "state/other"; },
    (value) => { value.debugger.manifestBinding.sha256 = "0".repeat(64); },
    (value) => { value.debugger.manifest.schedule.maxRuns += 1; },
    (value) => { value.exactCpu.manifestBinding.sha256 = "0".repeat(64); },
    (value) => { value.auxiliaryWorkload = { invented: true }; },
    (value) => { value.controlledLoad = { invented: true }; },
    (value) => { delete value.debugger; },
    (value) => { delete value.exactCpu; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const tampered = clone(files.manifest);
    mutate(tampered);
    assert.throws(() => parseSchema3BundleManifest(files.resolved, tampered),
      (error) => error instanceof Schema3BundleError ||
        error?.name === "DebuggerPhaseError",
      `case ${index}`);
  }
});

test("initialization creates exactly the v6 state directories and rereads idempotently", async () => {
  const files = fixture();
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  const initialized = await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  assert.equal(initialized.manifest.version, 6);
  assert.deepEqual(readdirSync(path.join(bundleDir, "state")).sort(),
    ["debugger", "exact-cpu"]);
  assert.equal(initialized.debugger.progress.status, "empty");
  assert.equal(initialized.exactCpu.progress.status, "empty");

  const reopened = await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  assert.equal(reopened.manifest.version, 6);

  writeFileSync(path.join(bundleDir, "state", "foreign"), "x");
  await assert.rejects(readSchema3Bundle({ resolved: files.resolved, bundleDir }),
    /unknown entry/);
  rmSync(path.join(bundleDir, "state", "foreign"));

  const summary = buildSchema3BundleSummary(
    await readSchema3Bundle({ resolved: files.resolved, bundleDir }),
  );
  assert.equal(summary.bundle.manifestVersion, 6);
  assert.deepEqual(summary.phases.debugger, {
    status: "empty",
    complete: false,
    committed: 0,
    scheduled: 4,
    captured: 0,
    maxCaptures: 2,
  });
});

test("clean and captured attempts commit through the lease to the capture cap", async () => {
  const files = fixture({ mode: "stopped", maxRuns: 3, maxCaptures: 2 });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });

  const first = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(first.result.reason, "committed", JSON.stringify(first.result));
  assert.deepEqual(first.result.outcome, {
    kind: "captured",
    signal: "SIGSEGV",
    target: true,
    sections: ["stop", "backtrace", "registers", "instructions", "threads", "mappings"],
  });
  assert.equal(first.bundle.debugger.progress.committedRuns, 1);

  const second = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(second.result.reason, "committed");
  assert.equal(second.bundle.debugger.progress.status, "complete");
  assert.equal(second.bundle.debugger.progress.capturedRuns, 2);

  const noOp = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(noOp.result.reason, "complete");
  assert.equal(noOp.bundle.debugger.progress.committedRuns, 2);
});

test("completion at the run cap stops without a capture", async () => {
  const files = fixture({ mode: "exited", maxRuns: 1, maxCaptures: 1 });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  const first = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(first.result.reason, "committed");
  assert.deepEqual(first.result.outcome, { kind: "clean" });
  assert.equal(first.bundle.debugger.progress.status, "complete");
  const noOp = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(noOp.result.reason, "complete");
});

test("an incomplete attempt publishes nothing and retries with a fresh nonce", async () => {
  const files = fixture({ mode: "silent" });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  const incomplete = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(incomplete.result.reason, "operational-invalid");
  assert.equal(incomplete.result.envelope, null);
  assert.equal(incomplete.bundle.debugger.progress.committedRuns, 0);
  assert.equal(incomplete.result.attempt.io.disposed, true);
  const names = readdirSync(path.join(bundleDir, "state", "debugger"));
  assert.deepEqual(names, ["debugger-phase.json"]);

  // A same-bundle retry gets a fresh nonce and the same operational outcome;
  // the durable prefix still does not advance.
  const retried = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(retried.result.reason, "operational-invalid");
  assert.equal(retried.bundle.debugger.progress.committedRuns, 0);
  const firstNonce = incomplete.result.attempt.io.evidence.context.nonce;
  const secondNonce = retried.result.attempt.io.evidence.context.nonce;
  assert.match(firstNonce, /^[a-f0-9]{32}$/);
  assert.match(secondNonce, /^[a-f0-9]{32}$/);
  assert.notEqual(firstNonce, secondNonce);
});

test("orphan parts are cleaned only for the recommitted run under the lease", async () => {
  const files = fixture({ mode: "exited" });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  const adapter = createFileStateAdapter(path.join(bundleDir, "state", "debugger"));
  await adapter.commit("debugger-attempt-000000002-transcript", Buffer.from("partial\n"));

  const first = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(first.result.reason, "committed");
  const afterFirst = await readSchema3Bundle({ resolved: files.resolved, bundleDir });
  assert.deepEqual(afterFirst.debugger.orphans,
    ["debugger-attempt-000000002-transcript"]);

  const second = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(second.result.reason, "committed");
  assert.equal(second.result.run, 2);
  const afterSecond = await readSchema3Bundle({ resolved: files.resolved, bundleDir });
  assert.deepEqual(afterSecond.debugger.orphans, []);
});

test("a second writer cannot race an in-progress debugger attempt", async () => {
  const files = fixture({ mode: "exited" });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let launches = 0;
  const runAttempt = async (resolved, manifest, context, options) => {
    launches += 1;
    started();
    await gate;
    const { runDebuggerAttempt } = await import("../debugger-attempt-runner.mjs");
    return runDebuggerAttempt(resolved, manifest, context, options);
  };

  const first = runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
    runAttempt,
  });
  await startedPromise;
  await assert.rejects(readSchema3Bundle({ resolved: files.resolved, bundleDir }),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  await assert.rejects(runOneSchema3ExactCpuAttempt({
    resolved: files.resolved,
    bundleDir,
  }), (error) => error instanceof BundleExecutionLeaseError &&
    error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  release();

  const completed = await first;
  assert.equal(completed.result.reason, "committed", JSON.stringify(completed.result));
  assert.equal(launches, 1);
  assert.equal(completed.bundle.debugger.progress.committedRuns, 1);
});

test("an interrupted commit remnant recovers on the next read", async () => {
  const files = fixture({ mode: "exited" });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  const stateDir = path.join(bundleDir, "state", "debugger");
  const remnant = ".debugger-attempt-000000001-transcript.99999999.0123456789abcdef.writing.tmp";
  writeFileSync(path.join(stateDir, remnant), "partial\n", { mode: 0o600 });

  const bundle = await readSchema3Bundle({ resolved: files.resolved, bundleDir });
  assert.equal(bundle.debugger.progress.status, "empty");
  assert.equal(readdirSync(stateDir).includes(remnant), false);
});

test("an HMAC-bound custom workload runs without persisting private values", async () => {
  const files = fixture({ mode: "exited" });
  const secret = "custom-secret-value-9f8e7d6c";
  const customPath = path.join(files.directory, "custom-workload.json");
  writeFileSync(customPath, JSON.stringify({
    version: 1,
    id: "schema3-v6-custom",
    label: "Custom v6 fixture",
    description: "HMAC-bound custom workload for the schema-3 v6 path.",
    risk: "standard",
    command: { executable: files.targetPath, args: [], cwd: files.directory },
    environment: {
      set: { FAKE_DEBUGGER_MODE: "exited", CUSTOM_SECRET_VALUE: secret },
    },
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true, gdb: true },
    provenance: { completeness: "complete", files: [] },
  }));
  const custom = resolveCustomWorkloadFile(customPath);
  assert.equal(custom.resolved.environment.bindingMode, "hmac-sha256");
  const bindingKey = customWorkloadEnvironmentBindingKey(readFileSync(customPath));
  const manifest = buildSchema3BundleManifestV6(custom.resolved, {
    bundleGeneration: BUNDLE_GENERATION,
    debuggerManifest: buildDebuggerPhaseManifest(custom.resolved, {
      generation: GENERATION,
      cpu: files.cpu,
      maxRuns: 2,
      maxCaptures: 1,
      debuggerPath: files.debuggerPath,
      tasksetPath: "/usr/bin/taskset",
      runTimeoutMs: 30_000,
      termGraceMs: 500,
      killGraceMs: 1_000,
    }),
    exactCpuManifest: buildExactCpuPhaseManifest(custom.resolved, {
      generation: "00112233445566778899aabbccddeeff",
      cpus: [files.cpu],
      rounds: 1,
      seed: 20260819,
      tasksetPath: "/usr/bin/taskset",
    }),
  });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: custom.resolved,
    manifest,
    bundleDir,
  });
  const result = await runOneSchema3DebuggerAttempt({
    resolved: custom.resolved,
    bundleDir,
    environmentBindingKey: bindingKey,
  });
  assert.equal(result.result.reason, "committed", JSON.stringify(result.result));

  // The private value and the binding key never persist into bundle state.
  const keyHex = bindingKey.toString("hex");
  const keyBase64 = bindingKey.toString("base64");
  const walk = (directory) => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : [path.join(directory, entry.name)]);
  for (const file of walk(bundleDir)) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes(secret), file);
    assert.ok(!content.includes(keyHex), file);
    assert.ok(!content.includes(keyBase64), file);
  }
});

test("the sibling exact-CPU phase stays valid and resumable beside debugger runs", async () => {
  const files = fixture({ mode: "exited" });
  const bundleDir = temporaryDirectory("schema3-v6-bundle-");
  await initializeSchema3Bundle({
    resolved: files.resolved,
    manifest: files.manifest,
    bundleDir,
  });
  const debuggerRun = await runOneSchema3DebuggerAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(debuggerRun.result.reason, "committed");

  const exactRun = await runOneSchema3ExactCpuAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(exactRun.result.reason, "committed", JSON.stringify(exactRun.result));
  assert.equal(exactRun.bundle.exactCpu.progress.complete, true);
  assert.equal(exactRun.bundle.debugger.progress.committedRuns, 1);

  const exactAgain = await runOneSchema3ExactCpuAttempt({
    resolved: files.resolved,
    bundleDir,
  });
  assert.equal(exactAgain.result.reason, "complete");
  const reread = await readSchema3Bundle({ resolved: files.resolved, bundleDir });
  assert.equal(reread.manifest.version, 6);
  assert.equal(reread.debugger.progress.committedRuns, 1);
  assert.equal(reread.exactCpu.progress.complete, true);
});
