import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  DEBUGGER_TRANSCRIPT_MAX_BYTES,
  DebuggerPhaseError,
  buildDebuggerPhaseManifest,
  canonicalDebuggerPhaseManifestLine,
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
  verifyDebuggerPhaseLaunchProvenance,
} from "../debugger-phase.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-phase-"));
  directories.push(directory);
  const debuggerPath = path.join(directory, "gdb-fixture");
  writeFileSync(debuggerPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, debuggerPath };
}

function workload(files, {
  gdb = true,
  targetSignals = ["SIGSEGV", "SIGUSR2"],
} = {}) {
  return resolveWorkloadSpec({
    version: 1,
    id: "debugger-phase-fixture",
    label: "Debugger phase fixture",
    description: "Finite local process used to validate debugger phase manifests.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: files.directory,
    },
    environment: {},
    attempt: {
      mode: "exit",
      timeoutMs: 2_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals, mappedExits: [] },
    capabilities: { isolated: true, gdb },
    provenance: { completeness: "complete", files: [] },
  });
}

function options(files, overrides = {}) {
  return {
    generation: "0123456789abcdef0123456789abcdef",
    cpu: 8,
    maxRuns: 12,
    maxCaptures: 2,
    debuggerPath: files.debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 180_000,
    termGraceMs: 1_000,
    killGraceMs: 2_000,
    ...overrides,
  };
}

test("debugger manifests bind workload, executable, profile, schedule, and canonical bytes", () => {
  const files = fixture();
  const debuggerLink = path.join(files.directory, "gdb-link");
  symlinkSync(files.debuggerPath, debuggerLink);
  const resolved = workload(files);
  const manifest = buildDebuggerPhaseManifest(resolved,
    options(files, { debuggerPath: debuggerLink }));
  const line = canonicalDebuggerPhaseManifestLine(resolved, manifest);
  const binding = debuggerPhaseManifestBinding(resolved, manifest);

  assert.equal(manifest.phase, "gdb-capture");
  assert.equal(manifest.debugger.executable.path, files.debuggerPath);
  assert.match(manifest.debugger.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.debugger.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.debugger.commandProfile.targetSignals,
    ["SIGSEGV", "SIGUSR2"]);
  assert.deepEqual(manifest.debugger.commandProfile.captureSections, [
    "stop", "backtrace", "registers", "instructions", "threads", "mappings",
  ]);
  assert.equal(manifest.debugger.commandProfile.transcript.maxBytes,
    DEBUGGER_TRANSCRIPT_MAX_BYTES);
  assert.equal(manifest.schedule.cpu, 8);
  assert.equal(manifest.schedule.maxRuns, 12);
  assert.equal(manifest.schedule.maxCaptures, 2);
  assert.equal(line.at(-1), 0x0a);
  assert.equal(binding.bytes, line.length);
  assert.match(binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(manifest.debugger.commandProfile.captureSections), true);
  assert.equal(verifyDebuggerPhaseLaunchProvenance(resolved, manifest), true);
});

test("debugger manifests reject workload, profile, schedule, and execution tampering", () => {
  const files = fixture();
  const resolved = workload(files);
  const original = buildDebuggerPhaseManifest(resolved, options(files));
  const cases = [
    ["workload", (value) => { value.workload.digest = "0".repeat(64); }],
    ["generation", (value) => { value.generation = "A".repeat(32); }],
    ["kind", (value) => { value.debugger.kind = "other"; }],
    ["executable", (value) => { value.debugger.executable.sha256 = "0".repeat(64); }],
    ["debugger digest", (value) => { value.debugger.digest = "0".repeat(64); }],
    ["profile", (value) => { value.debugger.commandProfile.id = "other"; }],
    ["signals", (value) => { value.debugger.commandProfile.targetSignals = ["SIGSEGV"]; }],
    ["transcript", (value) => { value.debugger.commandProfile.transcript.maxBytes -= 1; }],
    ["CPU", (value) => { value.schedule.cpu = 9; }],
    ["runs", (value) => { value.schedule.maxRuns += 1; }],
    ["schedule digest", (value) => { value.schedule.digest = "0".repeat(64); }],
    ["affinity", (value) => { value.execution.affinityMode = "other"; }],
    ["taskset", (value) => { value.execution.tasksetPath = "taskset"; }],
    ["timeout", (value) => { value.execution.runTimeoutMs = 0; }],
    ["unknown field", (value) => { value.unknown = true; }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(original);
    mutate(value);
    assert.throws(() => parseDebuggerPhaseManifest(resolved, value),
      DebuggerPhaseError, label);
  }
});

test("debugger manifests require an advertised target-signal capability and bounded schedule", () => {
  const files = fixture();
  assert.throws(() => buildDebuggerPhaseManifest(workload(files, { gdb: false }),
    options(files)), /does not declare debugger support/);
  assert.throws(() => buildDebuggerPhaseManifest(workload(files, { targetSignals: [] }),
    options(files)), /at least one target signal/);

  const resolved = workload(files);
  for (const [label, overrides] of [
    ["CPU", { cpu: -1 }],
    ["runs", { maxRuns: 0 }],
    ["captures", { maxCaptures: 13 }],
    ["run timeout", { runTimeoutMs: 3_600_001 }],
    ["TERM grace", { termGraceMs: 60_001 }],
    ["KILL grace", { killGraceMs: -1 }],
  ]) {
    assert.throws(() => buildDebuggerPhaseManifest(resolved, options(files, overrides)),
      DebuggerPhaseError, label);
  }
});

test("stored manifests remain parseable while launch provenance detects executable drift", () => {
  const files = fixture();
  const resolved = workload(files);
  const manifest = buildDebuggerPhaseManifest(resolved, options(files));

  writeFileSync(files.debuggerPath, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  assert.doesNotThrow(() => parseDebuggerPhaseManifest(resolved, clone(manifest)));
  assert.throws(() => verifyDebuggerPhaseLaunchProvenance(resolved, manifest),
    (error) => error instanceof DebuggerPhaseError &&
      error.code === "DEBUGGER_PROVENANCE_CHANGED");
});

test("debugger executable provenance requires a nonempty executable regular file", () => {
  const files = fixture();
  const resolved = workload(files);
  chmodSync(files.debuggerPath, 0o600);
  assert.throws(() => buildDebuggerPhaseManifest(resolved, options(files)),
    /must have an execute bit/);
  chmodSync(files.debuggerPath, 0o700);
  writeFileSync(files.debuggerPath, "", { mode: 0o700 });
  assert.throws(() => buildDebuggerPhaseManifest(resolved, options(files)),
    /must contain 1 through/);
});
