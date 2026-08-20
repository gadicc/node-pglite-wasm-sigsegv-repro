import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  DEBUGGER_ATTEMPT_IO_VERSION,
  DebuggerAttemptIoError,
  captureDebuggerAttemptIo,
} from "../debugger-attempt-io.mjs";
import { DEBUGGER_CONTROL_MAX_BYTES } from "../debugger-control.mjs";
import {
  DEBUGGER_TRANSCRIPT_MAX_BYTES,
  buildDebuggerPhaseManifest,
  debuggerPhaseManifestBinding,
} from "../debugger-phase.mjs";
import { canonicalProtocolJson } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const roots = [];
const captures = new Set();
const NONCE = "fedcba9876543210fedcba9876543210";

afterEach(() => {
  for (const capture of captures) capture.dispose();
  captures.clear();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-attempt-io-test-"));
  roots.push(directory);
  const debuggerPath = path.join(directory, "gdb-fixture");
  writeFileSync(debuggerPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "debugger-attempt-io-fixture",
    label: "Debugger attempt I/O fixture",
    description: "Finite local contract used to validate debugger attempt byte handling.",
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
    outcomes: { targetSignals: ["SIGSEGV"], mappedExits: [] },
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

function controlBytes(files, terminal = frame(files, "inferior-exited", 3, { exitCode: 0 })) {
  const records = [
    frame(files, "profile-ready", 1, {
      profileId: files.manifest.debugger.commandProfile.id,
    }),
    frame(files, "inferior-started", 2, {
      pid: 4321,
      startTicks: "987654",
      allowedCpuList: "8",
    }),
    terminal,
    frame(files, "profile-complete", 4),
  ];
  return Buffer.from(`${records.map((record) => canonicalProtocolJson(record)).join("\n")}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function capture(files, inputs, context = files.context) {
  const value = await captureDebuggerAttemptIo(
    files.resolved,
    files.manifest,
    context,
    inputs,
  );
  captures.add(value);
  return value;
}

test("exact transcript and canonical control bytes remain separately bound", async () => {
  const files = fixture();
  const transcript = Buffer.from("debugger output\nworkload output\n");
  const control = controlBytes(files);
  const result = await capture(files, {
    transcript: [transcript.subarray(0, 7), transcript.subarray(7)],
    control: [control.subarray(0, 13), control.subarray(13)],
  });

  assert.equal(result.evidence.version, DEBUGGER_ATTEMPT_IO_VERSION);
  assert.deepEqual(result.evidence.context, {
    generation: files.manifest.generation,
    manifestSha256: files.manifestSha256,
    run: 1,
    nonce: NONCE,
  });
  assert.deepEqual(result.evidence.transcript, {
    version: 1,
    limitBytes: DEBUGGER_TRANSCRIPT_MAX_BYTES,
    status: "complete",
    errorCode: null,
    observed: { bytes: String(transcript.length), sha256: sha256(transcript) },
    retainedBytes: transcript.length,
    overflowed: false,
  });
  assert.equal(result.evidence.control.status, "complete");
  assert.deepEqual(result.evidence.control.observed, {
    bytes: String(control.length),
    sha256: sha256(control),
  });
  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.control.terminal, { kind: "exited", exitCode: 0 });
  assert.equal(result.control.binding.sha256, result.evidence.control.observed.sha256);
  assert.deepEqual(Buffer.concat([...result.transcriptChunks(7)]), transcript);
  assert.deepEqual(result.controlTranscriptBytes(), control);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
});

test("a valid profile error remains complete debugger I/O", async () => {
  const files = fixture();
  const records = [
    frame(files, "profile-ready", 1, {
      profileId: files.manifest.debugger.commandProfile.id,
    }),
    frame(files, "profile-error", 2, {
      stage: "launch",
      code: "GDB_START_FAILED",
    }),
    frame(files, "profile-complete", 3),
  ];
  const control = Buffer.from(
    `${records.map((record) => canonicalProtocolJson(record)).join("\n")}\n`,
  );
  const result = await capture(files, {
    transcript: ["debugger could not start\n"],
    control: [control],
  });

  assert.equal(result.evidence.complete, true);
  assert.deepEqual(result.control.error, { stage: "launch", code: "GDB_START_FAILED" });
  assert.equal(result.control.terminal, null);
});

test("invalid control stays separate from an exactly retained transcript", async () => {
  const files = fixture();
  const transcript = Buffer.from("presentation text that resembles no control record\n");
  const result = await capture(files, {
    transcript: [transcript],
    control: [Buffer.from("{}\n")],
  });

  assert.equal(result.evidence.transcript.status, "complete");
  assert.equal(result.evidence.control.status, "invalid");
  assert.equal(result.evidence.control.errorCode, "INVALID_DEBUGGER_CONTROL");
  assert.equal(result.evidence.complete, false);
  assert.equal(result.control, null);
  assert.deepEqual(Buffer.concat([...result.transcriptChunks()]), transcript);
});

test("control overflow is bounded while the complete input is drained", async () => {
  const files = fixture();
  let yielded = 0;
  async function* overflowingControl() {
    yielded += 1;
    yield Buffer.alloc(DEBUGGER_CONTROL_MAX_BYTES, 0x78);
    yielded += 1;
    yield Buffer.from("tail");
  }
  const result = await capture(files, {
    transcript: ["finite transcript\n"],
    control: overflowingControl(),
  });

  assert.equal(yielded, 2);
  assert.equal(result.evidence.control.status, "overflow");
  assert.equal(result.evidence.control.errorCode, "DEBUGGER_CONTROL_OVERFLOW");
  assert.equal(result.evidence.control.retainedBytes, DEBUGGER_CONTROL_MAX_BYTES);
  assert.equal(result.evidence.control.observed.bytes, String(DEBUGGER_CONTROL_MAX_BYTES + 4));
  assert.equal(result.evidence.control.overflowed, true);
  assert.equal(result.control, null);
  assert.equal(result.evidence.complete, false);
});

test("transcript overflow retains the exact bound and continues draining", async () => {
  const files = fixture();
  const chunkBytes = 1024 * 1024;
  const chunks = DEBUGGER_TRANSCRIPT_MAX_BYTES / chunkBytes + 1;
  let yielded = 0;
  async function* overflowingTranscript() {
    for (let index = 0; index < chunks; index += 1) {
      yielded += 1;
      yield Buffer.alloc(chunkBytes, index & 0xff);
    }
  }
  const result = await capture(files, {
    transcript: overflowingTranscript(),
    control: [controlBytes(files)],
  });

  assert.equal(yielded, chunks);
  assert.equal(result.evidence.transcript.status, "overflow");
  assert.equal(result.evidence.transcript.errorCode, "DEBUGGER_TRANSCRIPT_OVERFLOW");
  assert.equal(result.evidence.transcript.retainedBytes, DEBUGGER_TRANSCRIPT_MAX_BYTES);
  assert.equal(
    result.evidence.transcript.observed.bytes,
    String(DEBUGGER_TRANSCRIPT_MAX_BYTES + chunkBytes),
  );
  assert.equal(result.evidence.transcript.overflowed, true);
  assert.equal(result.evidence.control.status, "complete");
  assert.equal(result.evidence.complete, false);
  const first = result.transcriptChunks(chunkBytes).next();
  assert.equal(first.done, false);
  assert.equal(first.value.length, chunkBytes);
});

test("one input error does not prevent the sibling channel from draining", async () => {
  const files = fixture();
  let controlFinished = false;
  async function* failingTranscript() {
    yield Buffer.from("prefix\n");
    throw Object.assign(new Error("fixture stream ended early"), {
      code: "FIXTURE_STREAM_ERROR",
    });
  }
  async function* finiteControl() {
    yield controlBytes(files);
    controlFinished = true;
  }
  const result = await capture(files, {
    transcript: failingTranscript(),
    control: finiteControl(),
  });

  assert.equal(controlFinished, true);
  assert.equal(result.evidence.transcript.status, "stream-error");
  assert.equal(result.evidence.transcript.errorCode, "FIXTURE_STREAM_ERROR");
  assert.equal(result.evidence.control.status, "complete");
  assert.deepEqual(result.control.terminal, { kind: "exited", exitCode: 0 });
  assert.equal(result.evidence.complete, false);
});

test("invalid chunks are recorded without accepting a partial channel", async () => {
  const files = fixture();
  const result = await capture(files, {
    transcript: [Buffer.from("before\n"), { not: "bytes" }, Buffer.from("after\n")],
    control: [controlBytes(files)],
  });

  assert.equal(result.evidence.transcript.status, "stream-error");
  assert.equal(result.evidence.transcript.errorCode, "DEBUGGER_IO_CHUNK_INVALID");
  assert.equal(result.evidence.transcript.observed.bytes, String(Buffer.byteLength("before\nafter\n")));
  assert.deepEqual(Buffer.concat([...result.transcriptChunks()]), Buffer.from("before\nafter\n"));
});

test("context and input shape are rejected before capture", async () => {
  const files = fixture();
  await assert.rejects(
    captureDebuggerAttemptIo(files.resolved, files.manifest, {
      run: 13,
      nonce: NONCE,
    }, {
      transcript: [],
      control: [],
    }),
    DebuggerAttemptIoError,
  );
  await assert.rejects(
    captureDebuggerAttemptIo(files.resolved, files.manifest, files.context, {
      transcript: [],
      control: [],
      extra: [],
    }),
    /must contain exactly/,
  );
  await assert.rejects(
    captureDebuggerAttemptIo(files.resolved, files.manifest, files.context, {
      transcript: null,
      control: [],
    }),
    /must be an iterable/,
  );
  const shared = [];
  await assert.rejects(
    captureDebuggerAttemptIo(files.resolved, files.manifest, files.context, {
      transcript: shared,
      control: shared,
    }),
    /must be distinct channels/,
  );
});

test("disposing is idempotent and prevents later byte access", async () => {
  const files = fixture();
  const result = await capture(files, {
    transcript: ["finite\n"],
    control: [controlBytes(files)],
  });
  const returnedControl = result.controlTranscriptBytes();
  returnedControl.fill(0);
  assert.notDeepEqual(result.controlTranscriptBytes(), returnedControl);

  result.dispose();
  result.dispose();
  assert.equal(result.disposed, true);
  assert.throws(() => result.controlTranscriptBytes(), /has been disposed/);
  assert.throws(() => result.transcriptChunks().next(), /has been disposed/);
});
