import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  DEBUGGER_CONTROL_MAX_BYTES,
  DebuggerControlError,
  parseDebuggerControlTranscript,
} from "../debugger-control.mjs";
import {
  buildDebuggerPhaseManifest,
  debuggerPhaseManifestBinding,
} from "../debugger-phase.mjs";
import { canonicalProtocolJson } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];
const NONCE = "fedcba9876543210fedcba9876543210";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-control-"));
  directories.push(directory);
  const debuggerPath = path.join(directory, "gdb-fixture");
  writeFileSync(debuggerPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "debugger-control-fixture",
    label: "Debugger control fixture",
    description: "Finite local process used to validate debugger control records.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
    },
    environment: {},
    attempt: {
      mode: "exit",
      timeoutMs: 2_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true, gdb: true },
    provenance: { completeness: "complete", files: [] },
  });
  const manifest = buildDebuggerPhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    cpu: 8,
    maxRuns: 12,
    maxCaptures: 2,
    debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 180_000,
    termGraceMs: 1_000,
    killGraceMs: 2_000,
  });
  const context = { run: 1, nonce: NONCE };
  const manifestSha256 = debuggerPhaseManifestBinding(resolved, manifest).sha256;
  return { resolved, manifest, context, manifestSha256 };
}

function frame(files, type, sequence, extra = {}) {
  return {
    version: 1,
    type,
    generation: files.manifest.generation,
    manifestSha256: files.manifestSha256,
    run: files.context.run,
    nonce: files.context.nonce,
    sequence,
    ...extra,
  };
}

function ready(files, sequence = 1) {
  return frame(files, "profile-ready", sequence, {
    profileId: files.manifest.debugger.commandProfile.id,
  });
}

function started(files, sequence = 2) {
  return frame(files, "inferior-started", sequence, {
    pid: 4321,
    startTicks: "987654",
    allowedCpuList: "8",
  });
}

function complete(files, sequence) {
  return frame(files, "profile-complete", sequence);
}

function encode(records) {
  return Buffer.from(`${records.map((record) => canonicalProtocolJson(record)).join("\n")}\n`);
}

function parse(files, recordsOrBytes, context = files.context) {
  return parseDebuggerControlTranscript(
    files.resolved,
    files.manifest,
    context,
    Buffer.isBuffer(recordsOrBytes) ? recordsOrBytes : encode(recordsOrBytes),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("canonical control records bind a clean exit to one manifest, run, and nonce", () => {
  const files = fixture();
  const records = [
    ready(files),
    started(files),
    frame(files, "inferior-exited", 3, { exitCode: 0 }),
    complete(files, 4),
  ];
  const bytes = encode(records);
  const result = parse(files, bytes);

  assert.deepEqual(result.context, {
    generation: files.manifest.generation,
    manifestSha256: files.manifestSha256,
    run: 1,
    nonce: NONCE,
  });
  assert.deepEqual(result.inferior, {
    pid: 4321,
    startTicks: "987654",
    allowedCpuList: "8",
  });
  assert.deepEqual(result.terminal, { kind: "exited", exitCode: 0 });
  assert.equal(result.capture, null);
  assert.equal(result.error, null);
  assert.deepEqual(result.binding, {
    sha256: result.binding.sha256,
    bytes: bytes.length,
    recordCount: 4,
  });
  assert.match(result.binding.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.records), true);
  assert.equal(Object.isFrozen(result.records[0]), true);
});

test("a stopped inferior requires the manifest's complete capture profile", () => {
  const files = fixture();
  const records = [
    ready(files),
    started(files),
    frame(files, "inferior-stopped", 3, { signal: "SIGSEGV" }),
    frame(files, "capture-complete", 4, {
      sections: [...files.manifest.debugger.commandProfile.captureSections],
    }),
    complete(files, 5),
  ];
  const result = parse(files, records);

  assert.deepEqual(result.terminal, { kind: "stopped", signal: "SIGSEGV" });
  assert.deepEqual(result.capture, {
    sections: ["stop", "backtrace", "registers", "instructions", "threads", "mappings"],
  });
  assert.equal(result.error, null);

  const changedSections = clone(records);
  changedSections[3].sections.pop();
  assert.throws(() => parse(files, changedSections),
    /capture sections do not match/);
  assert.throws(() => parse(files, records.slice(0, 3)),
    /transcript is incomplete/);
});

test("direct signals and staged operational errors remain distinct observations", () => {
  const files = fixture();
  const signaled = parse(files, [
    ready(files),
    started(files),
    frame(files, "inferior-signaled", 3, { signal: "SIGTERM" }),
    complete(files, 4),
  ]);
  assert.deepEqual(signaled.terminal, { kind: "signaled", signal: "SIGTERM" });
  assert.equal(signaled.error, null);

  const launchError = parse(files, [
    ready(files),
    frame(files, "profile-error", 2, { stage: "launch", code: "GDB_START_FAILED" }),
    complete(files, 3),
  ]);
  assert.equal(launchError.inferior, null);
  assert.equal(launchError.terminal, null);
  assert.deepEqual(launchError.error, { stage: "launch", code: "GDB_START_FAILED" });

  const captureError = parse(files, [
    ready(files),
    started(files),
    frame(files, "inferior-stopped", 3, { signal: "SIGUSR2" }),
    frame(files, "profile-error", 4, { stage: "capture", code: "GDB_CAPTURE_FAILED" }),
    complete(files, 5),
  ]);
  assert.deepEqual(captureError.terminal, { kind: "stopped", signal: "SIGUSR2" });
  assert.equal(captureError.capture, null);
  assert.deepEqual(captureError.error, { stage: "capture", code: "GDB_CAPTURE_FAILED" });
});

test("control records reject binding, identity, affinity, and field tampering", () => {
  const files = fixture();
  const original = [
    ready(files),
    started(files),
    frame(files, "inferior-exited", 3, { exitCode: 7 }),
    complete(files, 4),
  ];
  const cases = [
    ["version", (value) => { value[0].version = 2; }],
    ["type", (value) => { value[0].type = "unknown"; }],
    ["generation", (value) => { value[0].generation = "0".repeat(32); }],
    ["manifest", (value) => { value[0].manifestSha256 = "0".repeat(64); }],
    ["run", (value) => { value[1].run = 2; }],
    ["nonce", (value) => { value[2].nonce = "0".repeat(32); }],
    ["sequence", (value) => { value[2].sequence = 4; }],
    ["profile", (value) => { value[0].profileId = "other"; }],
    ["PID", (value) => { value[1].pid = 1; }],
    ["start ticks", (value) => { value[1].startTicks = "01"; }],
    ["CPU", (value) => { value[1].allowedCpuList = "8-9"; }],
    ["exit", (value) => { value[2].exitCode = 256; }],
    ["unknown field", (value) => { value[3].unknown = true; }],
  ];
  for (const [label, mutate] of cases) {
    const records = clone(original);
    mutate(records);
    assert.throws(() => parse(files, records), DebuggerControlError, label);
  }
  assert.throws(() => parse(files, original, { run: 13, nonce: NONCE }),
    /run must be an integer/);
  assert.throws(() => parse(files, original, { run: 1, nonce: "A".repeat(32) }),
    /nonce must be exactly/);
});

test("the control state machine rejects missing, reordered, duplicate, and misplaced records", () => {
  const files = fixture();
  const cases = [
    ["missing ready", [started(files, 1), complete(files, 2)]],
    ["complete before launch", [ready(files), complete(files, 2)]],
    ["capture before terminal", [
      ready(files), started(files),
      frame(files, "capture-complete", 3, {
        sections: [...files.manifest.debugger.commandProfile.captureSections],
      }),
      complete(files, 4),
    ]],
    ["wrong error stage", [
      ready(files),
      frame(files, "profile-error", 2, { stage: "observe", code: "GDB_START_FAILED" }),
      complete(files, 3),
    ]],
    ["missing complete", [
      ready(files), started(files),
      frame(files, "inferior-exited", 3, { exitCode: 0 }),
    ]],
    ["extra terminal", [
      ready(files), started(files),
      frame(files, "inferior-exited", 3, { exitCode: 0 }),
      frame(files, "inferior-signaled", 4, { signal: "SIGTERM" }),
      complete(files, 5),
    ]],
    ["after complete", [
      ready(files),
      frame(files, "profile-error", 2, { stage: "launch", code: "GDB_START_FAILED" }),
      complete(files, 3), complete(files, 4),
    ]],
  ];
  for (const [label, records] of cases) {
    assert.throws(() => parse(files, records), DebuggerControlError, label);
  }
});

test("control decoding is bounded, canonical, newline-terminated UTF-8", () => {
  const files = fixture();
  const records = [
    ready(files),
    frame(files, "profile-error", 2, { stage: "launch", code: "GDB_START_FAILED" }),
    complete(files, 3),
  ];
  const canonical = encode(records);

  assert.throws(() => parse(files, canonical.subarray(0, -1)), /must end/);
  assert.throws(() => parse(files, Buffer.concat([canonical.subarray(0, -1), Buffer.from("\r\n")])),
    /forbidden control byte/);
  assert.throws(() => parse(files, Buffer.from([0xff, 0x0a])), /not valid UTF-8/);
  assert.throws(() => parse(files, Buffer.alloc(DEBUGGER_CONTROL_MAX_BYTES + 1, 0x0a)),
    /must contain 1 through/);
  assert.throws(() => parse(files, Buffer.concat([canonical, Buffer.from("\n")])),
    /must be non-empty/);

  const nonCanonical = Buffer.from(`${JSON.stringify(records[0])}\n` +
    `${records.slice(1).map((record) => canonicalProtocolJson(record)).join("\n")}\n`);
  assert.notEqual(JSON.stringify(records[0]), canonicalProtocolJson(records[0]));
  assert.throws(() => parse(files, nonCanonical), /not canonical JSON/);
});
