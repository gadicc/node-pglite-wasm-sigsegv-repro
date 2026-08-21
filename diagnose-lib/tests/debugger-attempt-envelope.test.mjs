import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEBUGGER_ATTEMPT_ENVELOPE_VERSION,
  DebuggerAttemptEnvelopeError,
  buildDebuggerAttemptEnvelope,
  canonicalDebuggerAttemptEnvelopeLine,
  debuggerAttemptEnvelopeBinding,
  parseDebuggerAttemptEnvelope,
} from "../debugger-attempt-envelope.mjs";
import {
  DEBUGGER_PHASE_FILE,
  DebuggerAttemptStoreError,
  assessDebuggerAttemptProgress,
  commitDebuggerPhaseAttempt,
  initializeDebuggerPhaseStore,
  readDebuggerPhaseStore,
} from "../debugger-attempt-store.mjs";
import { runDebuggerAttempt } from "../debugger-attempt-runner.mjs";
import {
  buildDebuggerPhaseManifest,
  debuggerPhaseManifestBinding,
} from "../debugger-phase.mjs";
import { createFileStateAdapter } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const FAKE_DEBUGGER = fileURLToPath(
  new URL("./fixtures/fake-debugger-fixture.mjs", import.meta.url),
);
const NONCE = "fedcba9876543210fedcba9876543210";
const GENERATION = "0123456789abcdef0123456789abcdef";

const directories = [];
const captures = new Set();

afterEach(() => {
  for (const capture of captures) capture.dispose();
  captures.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstAllowedCpu() {
  const status = readFileSync("/proc/self/status", "utf8");
  return Number(status.match(/^Cpus_allowed_list:\s*(\S+)/m)[1].split(/[,-]/)[0]);
}

function fixture({ mode = "exited", maxRuns = 4, maxCaptures = 2 } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-envelope-"));
  directories.push(directory);
  const debuggerPath = path.join(directory, "fake-debugger");
  writeFileSync(debuggerPath,
    `#!${process.execPath}\nimport ${JSON.stringify(FAKE_DEBUGGER)};\n`,
    { mode: 0o700 });
  const targetPath = path.join(directory, "target-fixture");
  writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "debugger-envelope-fixture",
    label: "Debugger envelope fixture",
    description: "Finite inert process standing in for a debugger target.",
    risk: "standard",
    command: { executable: targetPath, args: [], cwd: directory },
    environment: { set: { FAKE_DEBUGGER_MODE: mode } },
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { gdb: true },
    provenance: { completeness: "complete", files: [] },
  });
  const cpu = firstAllowedCpu();
  const manifest = buildDebuggerPhaseManifest(resolved, {
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
  const stateDir = mkdtempSync(path.join(tmpdir(), "debugger-envelope-store-"));
  directories.push(stateDir);
  return { directory, debuggerPath, resolved, manifest, stateDir, cpu };
}

function context(run) {
  return { run, nonce: NONCE };
}

async function attempt(files, run) {
  const result = await runDebuggerAttempt(files.resolved, files.manifest, context(run));
  if (result.io !== null) captures.add(result.io);
  return result;
}

async function envelopeFor(files, run) {
  const result = await attempt(files, run);
  const envelope = buildDebuggerAttemptEnvelope(
    files.resolved,
    files.manifest,
    context(run),
    result,
  );
  return { envelope, result };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("a clean attempt produces a complete bound envelope", async () => {
  const files = fixture({ mode: "exited" });
  const { envelope } = await envelopeFor(files, 1);
  const manifestSha256 = debuggerPhaseManifestBinding(files.resolved, files.manifest).sha256;

  assert.equal(envelope.version, DEBUGGER_ATTEMPT_ENVELOPE_VERSION);
  assert.equal(envelope.phase, "gdb-capture");
  assert.equal(envelope.generation, GENERATION);
  assert.deepEqual(envelope.workload, {
    contractVersion: 1,
    id: files.resolved.id,
    digest: files.resolved.digest,
  });
  assert.equal(envelope.manifestSha256, manifestSha256);
  assert.equal(envelope.run, 1);
  assert.equal(envelope.nonce, NONCE);
  assert.match(envelope.descriptor.sha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.adapter.workload.id, "debugger-adapter");
  assert.equal(envelope.adapter.evidence.observation.exitCode, 0);
  assert.equal(envelope.io.complete, true);
  assert.deepEqual(envelope.control.terminal, { kind: "exited", exitCode: 0 });
  assert.deepEqual(envelope.outcome, { kind: "clean" });
  assertDeepFrozen(envelope);

  const line = canonicalDebuggerAttemptEnvelopeLine(files.resolved, files.manifest, envelope);
  const binding = debuggerAttemptEnvelopeBinding(files.resolved, files.manifest, envelope);
  assert.equal(line.at(-1), 0x0a);
  assert.equal(binding.bytes, line.length);
  assert.equal(binding.sha256, createHash("sha256").update(line).digest("hex"));
  assert.deepEqual(
    parseDebuggerAttemptEnvelope(
      files.resolved,
      files.manifest,
      JSON.parse(line.toString("utf8")),
    ),
    envelope,
  );
});

test("stopped, signaled, and error attempts classify distinct typed outcomes", async () => {
  const stoppedFiles = fixture({ mode: "stopped" });
  const stopped = (await envelopeFor(stoppedFiles, 1)).envelope;
  assert.deepEqual(stopped.outcome, {
    kind: "captured",
    signal: "SIGSEGV",
    target: true,
    sections: ["stop", "backtrace", "registers", "instructions", "threads", "mappings"],
  });

  const signaledFiles = fixture({ mode: "signaled" });
  const signaled = (await envelopeFor(signaledFiles, 1)).envelope;
  assert.deepEqual(signaled.outcome, { kind: "signaled", signal: "SIGUSR2", target: true });

  const errorFiles = fixture({ mode: "launch-error" });
  const launchError = (await envelopeFor(errorFiles, 1)).envelope;
  assert.deepEqual(launchError.outcome, {
    kind: "error",
    stage: "launch",
    code: "GDB_LAUNCH_ERROR",
  });
  assert.equal(launchError.control.terminal, null);
});

test("incomplete attempts are refused an envelope", async () => {
  const silentFiles = fixture({ mode: "silent" });
  const silent = await attempt(silentFiles, 1);
  assert.throws(
    () => buildDebuggerAttemptEnvelope(
      silentFiles.resolved,
      silentFiles.manifest,
      context(1),
      silent,
    ),
    (error) => error instanceof DebuggerAttemptEnvelopeError &&
      error.code === "INCOMPLETE_DEBUGGER_ATTEMPT",
  );

  const nonzeroFiles = fixture({ mode: "nonzero" });
  const nonzero = await attempt(nonzeroFiles, 1);
  assert.throws(
    () => buildDebuggerAttemptEnvelope(
      nonzeroFiles.resolved,
      nonzeroFiles.manifest,
      context(1),
      nonzero,
    ),
    /adapter lifecycle is not operationally successful/,
  );

  const cleanFiles = fixture({ mode: "exited" });
  const clean = await attempt(cleanFiles, 1);
  const corrupted = clone(clean);
  corrupted.io.evidence.complete = false;
  assert.throws(
    () => buildDebuggerAttemptEnvelope(
      cleanFiles.resolved,
      cleanFiles.manifest,
      context(1),
      corrupted,
    ),
    /does not reconcile|not complete/,
  );
});

test("envelope parsing rejects tampering across every bound section", async () => {
  const files = fixture({ mode: "stopped" });
  const { envelope } = await envelopeFor(files, 1);
  const cases = [
    (value) => { value.version = 2; },
    (value) => { value.run = 2; },
    (value) => { value.nonce = "0".repeat(32); },
    (value) => { value.manifestSha256 = "0".repeat(64); },
    (value) => { value.workload.digest = "0".repeat(64); },
    (value) => { value.descriptor.sha256 = "0".repeat(64); },
    (value) => { value.adapter.workload.digest = "0".repeat(64); },
    (value) => { value.adapter.evidence.observation.exitCode = 1; },
    (value) => { value.adapter.binding.sha256 = "0".repeat(64); },
    (value) => { value.io.complete = false; },
    (value) => { value.io.transcript.status = "overflow"; },
    (value) => { value.control.terminal.signal = "SIGUSR2"; },
    (value) => { value.control.error = { stage: "capture", code: "GDB_CAPTURE_ERROR" }; },
    (value) => { value.outcome.kind = "clean"; },
    (value) => { value.unknown = true; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const tampered = clone(envelope);
    mutate(tampered);
    assert.throws(
      () => parseDebuggerAttemptEnvelope(files.resolved, files.manifest, tampered),
      (error) => error instanceof DebuggerAttemptEnvelopeError ||
        /does not match|must|invalid|unknown/i.test(error.message),
      `case ${index}`,
    );
  }
});

test("complete channels reconcile observed, retained, limit, and control binding", async () => {
  const files = fixture({ mode: "stopped" });
  const { envelope, result } = await envelopeFor(files, 1);
  const transcriptObserved = Number(envelope.io.transcript.observed.bytes);
  const controlBindingBytes = envelope.control.binding.bytes;

  const cases = [
    ["transcript observed bytes incremented", (value) => {
      value.io.transcript.observed.bytes = String(transcriptObserved + 1);
    }],
    ["transcript retained bytes reduced", (value) => {
      value.io.transcript.retainedBytes -= 1;
    }],
    ["control observed bytes differ from its binding", (value) => {
      value.io.control.observed.bytes = String(controlBindingBytes + 1);
    }],
    ["control retained bytes differ from its binding", (value) => {
      value.io.control.retainedBytes = controlBindingBytes - 1;
    }],
    ["control observed digest differs from its binding", (value) => {
      value.io.control.observed.sha256 = "0".repeat(64);
    }],
    ["complete channel with overflowed true", (value) => {
      value.io.control.overflowed = true;
    }],
  ];
  for (const [label, mutate] of cases) {
    const tampered = clone(envelope);
    mutate(tampered);
    assert.throws(
      () => parseDebuggerAttemptEnvelope(files.resolved, files.manifest, tampered),
      DebuggerAttemptEnvelopeError,
      label,
    );
  }

  const buildCorruptions = [
    (value) => {
      value.io.evidence.control.observed.bytes = String(controlBindingBytes + 1);
    },
    (value) => {
      value.io.evidence.transcript.overflowed = true;
    },
    (value) => {
      value.io.evidence.transcript.observed.bytes = String(transcriptObserved + 1);
    },
  ];
  for (const [index, mutate] of buildCorruptions.entries()) {
    const corrupted = clone(result);
    mutate(corrupted);
    assert.throws(
      () => buildDebuggerAttemptEnvelope(
        files.resolved,
        files.manifest,
        context(1),
        corrupted,
      ),
      DebuggerAttemptEnvelopeError,
      `build case ${index}`,
    );
  }
});

test("progress tracks the contiguous run prefix and completion policy", async () => {
  const files = fixture({ mode: "stopped", maxRuns: 3, maxCaptures: 2 });
  const first = (await envelopeFor(files, 1)).envelope;
  const second = (await envelopeFor(files, 2)).envelope;

  const empty = assessDebuggerAttemptProgress(files.resolved, files.manifest, []);
  assert.deepEqual(empty, {
    status: "empty",
    committedRuns: 0,
    capturedRuns: 0,
    maxRuns: 3,
    maxCaptures: 2,
    complete: false,
    nextRun: 1,
  });
  const partial = assessDebuggerAttemptProgress(files.resolved, files.manifest,
    [{ run: 1, envelope: first }]);
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.nextRun, 2);
  const complete = assessDebuggerAttemptProgress(files.resolved, files.manifest,
    [{ run: 1, envelope: first }, { run: 2, envelope: second }]);
  assert.equal(complete.status, "complete");
  assert.equal(complete.capturedRuns, 2);
  assert.equal(complete.nextRun, null);
  assert.throws(
    () => assessDebuggerAttemptProgress(files.resolved, files.manifest,
      [{ run: 2, envelope: second }]),
    /contiguous one-based prefix/,
  );
});

test("the store initializes idempotently and rejects a different manifest", async () => {
  const files = fixture();
  const options = { resolved: files.resolved, manifest: files.manifest, stateDir: files.stateDir };
  const initialized = await initializeDebuggerPhaseStore(options);
  assert.equal(initialized.progress.status, "empty");
  const again = await initializeDebuggerPhaseStore(options);
  assert.equal(again.progress.status, "empty");

  const otherManifest = buildDebuggerPhaseManifest(files.resolved, {
    generation: "ffffffffffffffffffffffffffffffff",
    cpu: files.cpu,
    maxRuns: 4,
    maxCaptures: 2,
    debuggerPath: files.debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 30_000,
    termGraceMs: 500,
    killGraceMs: 1_000,
  });
  await assert.rejects(
    initializeDebuggerPhaseStore({
      resolved: files.resolved,
      manifest: otherManifest,
      stateDir: files.stateDir,
    }),
    /different manifest/,
  );
});

test("commits publish bound triples, advance the prefix, and complete at the capture cap", async () => {
  const files = fixture({ mode: "stopped", maxRuns: 3, maxCaptures: 2 });
  const options = { resolved: files.resolved, manifest: files.manifest, stateDir: files.stateDir };
  await initializeDebuggerPhaseStore(options);

  const first = await envelopeFor(files, 1);
  captures.delete(first.result.io);
  const afterFirst = await commitDebuggerPhaseAttempt({
    ...options,
    envelope: first.envelope,
    io: first.result.io,
  });
  assert.equal(first.result.io.disposed, true);
  assert.equal(afterFirst.progress.status, "incomplete");
  assert.equal(afterFirst.progress.capturedRuns, 1);
  assert.equal(afterFirst.orphans.length, 0);

  const second = await envelopeFor(files, 2);
  captures.delete(second.result.io);
  const afterSecond = await commitDebuggerPhaseAttempt({
    ...options,
    envelope: second.envelope,
    io: second.result.io,
  });
  assert.equal(afterSecond.progress.status, "complete");
  assert.equal(afterSecond.progress.capturedRuns, 2);

  const readBack = await readDebuggerPhaseStore(options);
  assert.equal(readBack.attempts.length, 2);
  assert.deepEqual(readBack.attempts[0].envelope, first.envelope);
  assert.deepEqual(readBack.attempts[1].envelope, second.envelope);
  const adapter = createFileStateAdapter(files.stateDir);
  const names = await adapter.list();
  assert.ok(names.includes(DEBUGGER_PHASE_FILE));
  for (const run of [1, 2]) {
    const stem = `debugger-attempt-${String(run).padStart(9, "0")}`;
    assert.ok(names.includes(`${stem}-envelope.json`));
    assert.ok(names.includes(`${stem}-transcript`));
    assert.ok(names.includes(`${stem}-control`));
  }

  const third = await envelopeFor(files, 3);
  await assert.rejects(
    commitDebuggerPhaseAttempt({ ...options, envelope: third.envelope, io: third.result.io }),
    /already complete/,
  );
});

test("out-of-order commits and foreign or tampered artifacts are refused", async () => {
  const files = fixture({ mode: "exited" });
  const options = { resolved: files.resolved, manifest: files.manifest, stateDir: files.stateDir };
  await initializeDebuggerPhaseStore(options);

  const second = await envelopeFor(files, 2);
  await assert.rejects(
    commitDebuggerPhaseAttempt({ ...options, envelope: second.envelope, io: second.result.io }),
    /not the exact next run/,
  );

  const first = await envelopeFor(files, 1);
  captures.delete(first.result.io);
  await commitDebuggerPhaseAttempt({ ...options, envelope: first.envelope, io: first.result.io });

  writeFileSync(path.join(files.stateDir, "foreign.txt"), "junk\n");
  await assert.rejects(readDebuggerPhaseStore(options), /foreign debugger attempt store file/);
  rmSync(path.join(files.stateDir, "foreign.txt"));

  const transcriptName = "debugger-attempt-000000001-transcript";
  writeFileSync(path.join(files.stateDir, transcriptName), "tampered\n");
  await assert.rejects(readDebuggerPhaseStore(options),
    /transcript bytes do not match/);
});

test("a crashed earlier attempt leaves only cleaned bounded orphans", async () => {
  const files = fixture({ mode: "exited" });
  const options = { resolved: files.resolved, manifest: files.manifest, stateDir: files.stateDir };
  await initializeDebuggerPhaseStore(options);
  const adapter = createFileStateAdapter(files.stateDir);
  await adapter.commit("debugger-attempt-000000001-transcript", Buffer.from("partial\n"));

  const withOrphan = await readDebuggerPhaseStore(options);
  assert.deepEqual(withOrphan.orphans, ["debugger-attempt-000000001-transcript"]);
  assert.equal(withOrphan.progress.nextRun, 1);

  const first = await envelopeFor(files, 1);
  captures.delete(first.result.io);
  const committed = await commitDebuggerPhaseAttempt({
    ...options,
    envelope: first.envelope,
    io: first.result.io,
  });
  assert.equal(committed.orphans.length, 0);
  assert.equal(committed.progress.committedRuns, 1);
  await assert.rejects(
    commitDebuggerPhaseAttempt({
      ...options,
      envelope: first.envelope,
      io: first.result.io,
    }),
    /not the exact next run/,
  );
});
