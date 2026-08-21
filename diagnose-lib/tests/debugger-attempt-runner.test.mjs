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

import { readLinuxProcessIdentity, runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  DEBUGGER_ADAPTER_MODULES,
  DEBUGGER_ADAPTER_PATH,
  DEBUGGER_ATTEMPT_RUNNER_VERSION,
  runDebuggerAttempt,
} from "../debugger-attempt-runner.mjs";
import { buildDebuggerCommandProfile } from "../debugger-command-profile.mjs";
import {
  buildDebuggerPhaseManifest,
  debuggerPhaseManifestBinding,
} from "../debugger-phase.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const FAKE_DEBUGGER = fileURLToPath(
  new URL("./fixtures/fake-debugger-fixture.mjs", import.meta.url),
);
const ATTEMPT_FIXTURE = fileURLToPath(
  new URL("./fixtures/attempt-workload-fixture.mjs", import.meta.url),
);
const NONCE = "fedcba9876543210fedcba9876543210";
const GENERATION = "0123456789abcdef0123456789abcdef";
const PASS_VALUE = "pass-sentinel-42";

const directories = [];
const captures = new Set();
const supervisorIdentities = [];

afterEach(() => {
  for (const capture of captures) capture.dispose();
  captures.clear();
  for (const identity of supervisorIdentities.splice(0)) {
    const current = readLinuxProcessIdentity(identity.pid);
    if (current?.live && current.startTicks === identity.startTicks &&
        current.processGroupId === identity.processGroupId) {
      try {
        process.kill(-identity.processGroupId, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  delete process.env.FAKE_DEBUGGER_PASS_VALUE;
});

function firstAllowedCpu() {
  const status = readFileSync("/proc/self/status", "utf8");
  return Number(status.match(/^Cpus_allowed_list:\s*(\S+)/m)[1].split(/[,-]/)[0]);
}

function fixture({ mode = "exited", pass = false, targetArgs = [] } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-attempt-runner-"));
  directories.push(directory);
  const debuggerPath = path.join(directory, "fake-debugger");
  writeFileSync(debuggerPath,
    `#!${process.execPath}\nimport ${JSON.stringify(FAKE_DEBUGGER)};\n`,
    { mode: 0o700 });
  const targetPath = path.join(directory, "target-fixture");
  writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  if (pass) process.env.FAKE_DEBUGGER_PASS_VALUE = PASS_VALUE;
  const environment = { set: { FAKE_DEBUGGER_MODE: mode } };
  if (pass) environment.pass = ["FAKE_DEBUGGER_PASS_VALUE"];
  const spec = {
    version: 1,
    id: "debugger-runner-fixture",
    label: "Debugger runner fixture",
    description: "Finite inert process standing in for a debugger target.",
    risk: "standard",
    command: { executable: targetPath, args: targetArgs, cwd: directory },
    environment,
    attempt: {
      mode: "exit",
      timeoutMs: 5_000,
      termGraceMs: 100,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { gdb: true },
    provenance: { completeness: "complete", files: [] },
  };
  const resolved = resolveWorkloadSpec(spec);
  const cpu = firstAllowedCpu();
  const manifest = buildDebuggerPhaseManifest(resolved, {
    generation: GENERATION,
    cpu,
    maxRuns: 4,
    maxCaptures: 2,
    debuggerPath,
    tasksetPath: "/usr/bin/taskset",
    runTimeoutMs: 30_000,
    termGraceMs: 500,
    killGraceMs: 1_000,
  });
  const context = { run: 1, nonce: NONCE };
  const manifestSha256 = debuggerPhaseManifestBinding(resolved, manifest).sha256;
  return {
    directory,
    debuggerPath,
    targetPath,
    spec,
    resolved,
    manifest,
    context,
    manifestSha256,
    cpu,
  };
}

async function run(files) {
  const result = await runDebuggerAttempt(
    files.resolved,
    files.spec,
    files.manifest,
    files.context,
  );
  if (result.io !== null) captures.add(result.io);
  if (result.adapter.process.supervisor !== null) {
    supervisorIdentities.push(result.adapter.process.supervisor);
  }
  return result;
}

function transcriptOf(result) {
  return Buffer.concat([...result.io.transcriptChunks()]).toString("utf8");
}

test("a clean attempt routes channels, preserves argv, and keeps lifecycles distinct", async () => {
  const files = fixture({
    mode: "exited",
    pass: true,
    targetArgs: ["a b", "", "-nx", "$(rm -rf /)"],
  });
  const result = await run(files);

  assert.equal(result.version, DEBUGGER_ATTEMPT_RUNNER_VERSION);
  assert.deepEqual(result.descriptor,
    buildDebuggerCommandProfile(files.resolved, files.manifest, files.context));
  assert.equal(Object.isFrozen(result), true);

  assert.deepEqual(result.adapter.observation, {
    exitCode: 0,
    signal: null,
    terminalReason: "natural-exit",
    cleanupComplete: true,
    launchErrorCode: null,
  });
  assert.equal(result.adapter.cleanup.failureReason, null);
  assert.ok(result.adapter.process.supervisor !== null &&
    result.adapter.process.workload !== null);
  assert.equal(result.adapter.execution.cpuAffinity.requestedCpu, files.cpu);
  assert.equal(result.adapter.execution.cpuAffinity.workloadAllowedCpuList,
    String(files.cpu));

  assert.equal(result.io.evidence.complete, true);
  assert.deepEqual(result.io.control.terminal, { kind: "exited", exitCode: 0 });
  assert.equal(result.io.control.context.manifestSha256, files.manifestSha256);
  assert.equal(result.io.evidence.transcript.status, "complete");

  const transcript = transcriptOf(result);
  assert.ok(transcript.includes("FAKE_DEBUGGER_STDOUT\texited\n"));
  assert.ok(transcript.includes("FAKE_DEBUGGER_STDERR\texited\n"));
  assert.ok(transcript.includes(`FAKE_DEBUGGER_TARGET_ARGV\t${
    JSON.stringify([files.resolved.command.executable.path, "a b", "", "-nx", "$(rm -rf /)"])
  }\n`));
  assert.ok(transcript.includes(`FAKE_DEBUGGER_ENV\t${PASS_VALUE}\n`));

  const controlBytes = result.io.controlTranscriptBytes();
  assert.equal(result.io.evidence.control.observed.sha256,
    createHash("sha256").update(controlBytes).digest("hex"));
});

test("a stopped attempt captures the manifest's fixed section list", async () => {
  const files = fixture({ mode: "stopped" });
  const result = await run(files);

  assert.equal(result.io.evidence.complete, true);
  assert.deepEqual(result.io.control.terminal, { kind: "stopped", signal: "SIGSEGV" });
  assert.deepEqual(result.io.control.capture, {
    sections: ["stop", "backtrace", "registers", "instructions", "threads", "mappings"],
  });
  assert.equal(result.adapter.observation.exitCode, 0);
});

test("a signaled attempt records the direct signal", async () => {
  const files = fixture({ mode: "signaled" });
  const result = await run(files);

  assert.equal(result.io.evidence.complete, true);
  assert.deepEqual(result.io.control.terminal, { kind: "signaled", signal: "SIGUSR2" });
});

test("a profile launch error remains complete, valid control evidence", async () => {
  const files = fixture({ mode: "launch-error" });
  const result = await run(files);

  assert.equal(result.io.evidence.complete, true);
  assert.deepEqual(result.io.control.error, { stage: "launch", code: "GDB_LAUNCH_ERROR" });
  assert.equal(result.io.control.terminal, null);
  assert.equal(result.adapter.observation.exitCode, 0);
});

test("a silent debugger leaves the control channel invalid without faking completion", async () => {
  const files = fixture({ mode: "silent" });
  const result = await run(files);

  assert.equal(result.adapter.observation.exitCode, 0);
  assert.equal(result.io.evidence.control.status, "invalid");
  assert.equal(result.io.evidence.transcript.status, "complete");
  assert.equal(result.io.evidence.complete, false);
  assert.equal(result.io.control, null);
  assert.ok(transcriptOf(result).includes("FAKE_DEBUGGER_STDOUT\tsilent\n"));
});

test("garbage control bytes are invalid evidence, not a parse", async () => {
  const files = fixture({ mode: "garbage-control" });
  const result = await run(files);

  assert.equal(result.io.evidence.control.status, "invalid");
  assert.equal(result.io.evidence.complete, false);
  assert.equal(result.io.control, null);
});

test("debugger provenance drift stops the adapter before launch", async () => {
  const files = fixture({ mode: "exited" });
  writeFileSync(files.debuggerPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const result = await run(files);

  assert.equal(result.adapter.observation.exitCode, 1);
  assert.equal(result.adapter.observation.cleanupComplete, true);
  assert.equal(result.io.evidence.complete, false);
  assert.equal(result.io.control, null);
  const transcript = transcriptOf(result);
  assert.ok(transcript.includes(
    "DEBUGGER_ADAPTER_ERROR\tDEBUGGER_PROVENANCE_CHANGED\t",
  ), transcript);
  assert.ok(!transcript.includes("FAKE_DEBUGGER_STDOUT"));
});

test("target workload drift stops the adapter before launch", async () => {
  const files = fixture({ mode: "exited" });
  writeFileSync(files.targetPath, "#!/bin/sh\nexit 42\n", { mode: 0o700 });
  const result = await run(files);

  assert.equal(result.adapter.observation.exitCode, 1);
  assert.equal(result.io.evidence.complete, false);
  assert.equal(result.io.control, null);
  assert.ok(!transcriptOf(result).includes("FAKE_DEBUGGER_STDOUT"));
});

test("adapter launch provenance covers every module the adapter loads", () => {
  const closure = new Set([DEBUGGER_ADAPTER_PATH]);
  const pending = [DEBUGGER_ADAPTER_PATH];
  const importRe = /from\s+"(\.\/[a-z0-9-]+\.mjs)"/g;
  while (pending.length > 0) {
    const current = pending.pop();
    const source = readFileSync(current, "utf8");
    for (const match of source.matchAll(importRe)) {
      const resolvedPath = path.join(path.dirname(current), match[1]);
      if (!closure.has(resolvedPath)) {
        closure.add(resolvedPath);
        pending.push(resolvedPath);
      }
    }
  }
  assert.deepEqual([...closure].sort(), [...DEBUGGER_ADAPTER_MODULES].sort());
  for (const modulePath of DEBUGGER_ADAPTER_MODULES) {
    assert.ok(readFileSync(modulePath, "utf8").length > 0, modulePath);
  }
});

test("the supervisor delivers a bounded stdin payload to the workload", async () => {
  const files = fixture();
  const payload = JSON.stringify({ marker: "stdin-payload", nonce: NONCE });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "stdin-payload-fixture",
    label: "Stdin payload fixture",
    description: "Echoes its standard input as JSON.",
    risk: "standard",
    command: {
      executable: (() => {
        const echoPath = path.join(files.directory, "stdin-fixture");
        writeFileSync(echoPath,
          `#!${process.execPath}\nimport ${JSON.stringify(ATTEMPT_FIXTURE)};\n`,
          { mode: 0o700 });
        return echoPath;
      })(),
      args: ["stdin"],
      cwd: files.directory,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: {},
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
  const result = await runWorkloadAttempt(resolved, { stdinPayload: payload });
  if (result.process.supervisor !== null) {
    supervisorIdentities.push(result.process.supervisor);
  }

  assert.equal(result.observation.exitCode, 0);
  assert.equal(result.observation.cleanupComplete, true);
  const echoed = JSON.parse(
    Buffer.from(result.output.stdout.excerptBase64, "base64").toString("utf8"),
  );
  assert.deepEqual(echoed, { type: "stdin", text: payload });

  await assert.rejects(
    runWorkloadAttempt(resolved, { stdinPayload: "x".repeat(2 * 1024 * 1024 + 1) }),
    /stdinPayload must be a string of at most/,
  );
  await assert.rejects(
    runWorkloadAttempt(resolved, { streamForward: "not-a-function" }),
    /streamForward must be a function/,
  );
});

test("the runner validates manifest and context before any process launches", async () => {
  const files = fixture();
  const tampered = JSON.parse(JSON.stringify(files.manifest));
  tampered.schedule.maxRuns += 1;
  await assert.rejects(
    runDebuggerAttempt(files.resolved, files.spec, tampered, files.context),
    /schedule digest does not match|does not match its identity/,
  );
  await assert.rejects(
    runDebuggerAttempt(files.resolved, files.spec, files.manifest, {
      run: 99,
      nonce: NONCE,
    }),
    /run must be an integer from 1 through 4/,
  );
  await assert.rejects(
    runDebuggerAttempt(files.resolved, files.spec, files.manifest, {
      run: 1,
      nonce: "0".repeat(31),
    }),
    /nonce must be exactly/,
  );
});
