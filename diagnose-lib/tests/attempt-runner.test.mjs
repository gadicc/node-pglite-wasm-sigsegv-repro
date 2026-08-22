import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAttemptRunner,
  readLinuxProcessIdentity,
  runManagedWorkload,
  runWorkloadAttempt,
  selectAttemptDeadlineCandidate,
} from "../attempt-runner.mjs";
import { buildAttemptEvidence } from "../attempt-evidence.mjs";
import {
  resolveWorkloadSpec,
  workloadLaunchEnvironment,
  workloadLaunchProvenance,
} from "../workload-spec.mjs";
import { expandCpuList, compressCpuList } from "../pinned-runner.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/attempt-workload-fixture.mjs", import.meta.url));
const SUPERVISOR = fileURLToPath(new URL("../attempt-supervisor.mjs", import.meta.url));
const directories = [];
const supervisorIdentities = [];

afterEach(() => {
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
});

function launcher({ missingInterpreter = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "attempt-runner-"));
  directories.push(directory);
  const executable = path.join(directory, "workload.mjs");
  const interpreter = missingInterpreter ? "/definitely/missing/node" : process.execPath;
  writeFileSync(executable, `#!${interpreter}\nimport ${JSON.stringify(FIXTURE)};\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { directory, executable };
}

function workload(files, args, {
  mode = "exit",
  timeoutMs = 2_000,
  termGraceMs = 100,
  killGraceMs = 1_000,
  environment = { ONLY_VALUE: "literal secret" },
} = {}) {
  return resolveWorkloadSpec({
    version: 1,
    id: "attempt-fixture",
    label: "Attempt fixture",
    description: "Harmless process-lifecycle fixture for the internal attempt runner.",
    risk: "standard",
    command: {
      executable: files.executable,
      args,
      cwd: files.directory,
    },
    environment: { set: environment },
    attempt: { mode, timeoutMs, termGraceMs, killGraceMs },
    outcomes: {
      targetSignals: ["SIGUSR2"],
      mappedExits: [
        { code: 42, category: "target-fault", label: "handled-test-fault" },
      ],
    },
    capabilities: {},
    provenance: { completeness: "complete", files: [FIXTURE] },
  });
}

function track(result) {
  if (result.process.supervisor !== null) supervisorIdentities.push(result.process.supervisor);
  return result;
}

function text(output) {
  return Buffer.from(output.excerptBase64, "base64").toString("utf8");
}

function jsonLines(output) {
  return text(output).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertIdentityGone(identity) {
  let current = null;
  try {
    const line = readFileSync(`/proc/${identity.pid}/stat`, "utf8").trimEnd();
    const close = line.lastIndexOf(") ");
    if (close >= 0) {
      const fields = line.slice(close + 2).split(/\s+/);
      current = {
        state: fields[0],
        processGroupId: Number(fields[2]),
        startTicks: fields[19],
        live: new Set(["R", "S", "D", "T", "t", "I", "W"]).has(fields[0]),
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
  }
  assert.ok(current === null || !current.live || current.startTicks !== identity.startTicks,
    `process ${identity.pid} remained live`);
}

test("deadline selection gives recorded natural status precedence", () => {
  const workloadIdentity = {
    pid: 123,
    startTicks: "456",
    processGroupId: 100,
    sessionId: 100,
  };
  const liveIdentity = { ...workloadIdentity, live: true };
  assert.deepEqual(selectAttemptDeadlineCandidate({
    workloadStatus: { exitCode: null, signal: "SIGUSR2", observedMonotonicNs: 199n },
    executionDeadlineNs: 200n,
    launchSent: true,
    workloadIdentity,
    currentIdentity: liveIdentity,
  }), {
    kind: "natural-exit",
    workloadStatus: { exitCode: null, signal: "SIGUSR2" },
  });
  assert.deepEqual(selectAttemptDeadlineCandidate({
    workloadStatus: { exitCode: 0, signal: null, observedMonotonicNs: 201n },
    executionDeadlineNs: 200n,
    launchSent: true,
    workloadIdentity,
    currentIdentity: liveIdentity,
  }), { kind: "terminal-race-pending" });
  assert.deepEqual(selectAttemptDeadlineCandidate({
    workloadStatus: null,
    executionDeadlineNs: 200n,
    launchSent: true,
    workloadIdentity,
    currentIdentity: liveIdentity,
  }), { kind: "observation-window-elapsed" });
  assert.deepEqual(selectAttemptDeadlineCandidate({
    workloadStatus: null,
    executionDeadlineNs: 200n,
    launchSent: true,
    workloadIdentity,
    currentIdentity: { ...liveIdentity, live: false },
  }), { kind: "terminal-race-pending" });
  assert.deepEqual(selectAttemptDeadlineCandidate({
    workloadStatus: null,
    executionDeadlineNs: 200n,
    launchSent: false,
    workloadIdentity: null,
    currentIdentity: null,
  }), { kind: "launch-timeout" });
});

test("launch is shell-free and preserves exact argv, cwd, and environment", { timeout: 5_000 }, async () => {
  const files = launcher();
  const args = ["exact", "argument with spaces", "", "$(not-a-shell)", "semi;colon"];
  const result = track(await runWorkloadAttempt(workload(files, args)));
  const record = jsonLines(result.output.stdout).find((entry) => entry.type === "exact");

  assert.equal(result.outcome.category, "pass", JSON.stringify(result.cleanup));
  assert.equal(result.outcome.evidenceKind, "normal-exit");
  assert.deepEqual(record.args, args.slice(1));
  assert.equal(record.cwd, files.directory);
  assert.deepEqual(record.environment, { ONLY_VALUE: "literal secret" });
  assert.equal(record.identity.processGroupId, result.process.supervisor.processGroupId);
  assert.equal(record.identity.sessionId, result.process.supervisor.sessionId);
  assert.equal(result.cleanup.groupDrained, true);
  assert.equal(result.cleanup.outputDrained, true);
});

test("a canonical CPU mask is inherited and witnessed by supervisor and workload", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const allowed = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof allowed, "string");
  const cpus = expandCpuList(allowed).slice(0, 2).sort((left, right) => left - right);
  const expected = compressCpuList(cpus);
  const result = track(await runWorkloadAttempt(workload(files, ["exact"]), {
    cpuAffinity: { cpus, tasksetPath: "/usr/bin/taskset" },
  }));

  assert.equal(result.outcome.category, "pass", JSON.stringify(result.cleanup));
  assert.deepEqual(result.execution.cpuAffinity, {
    requestedCpuList: expected,
    supervisorAllowedCpuList: expected,
    workloadAllowedCpuList: expected,
  });
  await assert.rejects(runWorkloadAttempt(workload(files, ["exact"]), {
    cpuAffinity: { cpus: [cpus[0], cpus[0]], tasksetPath: "/usr/bin/taskset" },
  }), /strictly increasing/);
});

test("natural mapped exits retain exact output and typed evidence", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["exit", "42", "stdout", "stderr"])));

  assert.equal(result.observation.exitCode, 42);
  assert.equal(result.observation.signal, null);
  assert.equal(result.outcome.category, "target-fault");
  assert.equal(result.outcome.evidenceKind, "mapped-exit");
  assert.equal(text(result.output.stdout), "stdout");
  assert.equal(text(result.output.stderr), "stderr");
  assert.equal(result.cleanup.term.attempted, false);
  assert.equal(result.cleanup.kill.attempted, false);
});

test("a fast successful workload remains valid after its /proc entry is reaped", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const runner = createAttemptRunner({
    readIdentity(pid) {
      const identity = readLinuxProcessIdentity(pid);
      return identity !== null && identity.processGroupId !== identity.pid ? null : identity;
    },
  });
  const result = track(await runner(workload(files, ["exit", "0", "fast", ""]), {
    stdoutExcerptBytes: 16,
  }));

  assert.equal(result.outcome.category, "pass", JSON.stringify(result.cleanup));
  assert.equal(result.observation.exitCode, 0);
  assert.equal(text(result.output.stdout), "fast");
  assert.equal(result.cleanup.groupDrained, true);
});

test("a fast successful workload remains valid inside its zombie reaping window", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  // Deterministically simulate the zombie window: every non-leader identity
  // read sees the workload as a just-exited, not-yet-reaped group member.
  const runner = createAttemptRunner({
    readIdentity(pid) {
      const identity = readLinuxProcessIdentity(pid);
      if (identity !== null && identity.processGroupId !== identity.pid) {
        return { ...identity, state: "Z", live: false };
      }
      return identity;
    },
  });
  const result = track(await runner(workload(files, ["exit", "0", "zombie", ""]), {
    stdoutExcerptBytes: 16,
  }));

  assert.equal(result.outcome.category, "pass", JSON.stringify(result.cleanup));
  assert.equal(result.observation.exitCode, 0);
  assert.equal(text(result.output.stdout), "zombie");
  assert.equal(result.observation.cleanupComplete, true);
  assert.equal(result.cleanup.failureReason, null);
});

test("natural signals remain direct signal evidence", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["self-signal", "SIGUSR2"])));

  assert.equal(result.observation.exitCode, null);
  assert.equal(result.observation.signal, "SIGUSR2");
  assert.equal(result.outcome.category, "target-fault");
  assert.equal(result.outcome.evidenceKind, "direct-signal");
  assert.equal(result.cleanup.postTerminalStatus, null);
});

test("survive-window records planned termination only as cleanup", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["hold"], {
    mode: "survive-window",
    timeoutMs: 100,
  })));

  assert.equal(result.observation.terminalReason, "observation-window-elapsed");
  assert.equal(result.observation.exitCode, null);
  assert.equal(result.observation.signal, null);
  assert.equal(result.outcome.category, "pass");
  assert.equal(result.outcome.evidenceKind, "survived-window");
  assert.equal(result.cleanup.term.attempted, true);
  assert.equal(result.cleanup.term.delivered, true);
  assert.equal(result.cleanup.kill.attempted, false);
  assert.equal(result.cleanup.postTerminalStatus.signal, "SIGTERM");
});

test("exit-mode observation deadlines are operationally invalid", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["hold"], {
    timeoutMs: 100,
  })));

  assert.equal(result.observation.terminalReason, "observation-window-elapsed");
  assert.equal(result.outcome.category, "operational-invalid");
  assert.equal(result.outcome.invalidReason, "observation-window-before-exit",
    JSON.stringify(result.cleanup));
  assert.equal(result.cleanup.postTerminalStatus.signal, "SIGTERM");
});

test("TERM-resistant trees escalate to KILL and leave no recorded process", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["tree"], {
    mode: "survive-window",
    timeoutMs: 100,
    termGraceMs: 50,
  })));
  const ready = jsonLines(result.output.stdout).find((entry) => entry.type === "tree-ready");

  assert.equal(result.outcome.category, "pass");
  assert.equal(result.cleanup.term.delivered, true);
  assert.equal(result.cleanup.kill.attempted, true);
  assert.equal(result.cleanup.kill.delivered, true);
  assert.ok(
    BigInt(result.cleanup.kill.monotonicNs) - BigInt(result.cleanup.term.monotonicNs) >=
      50_000_000n,
    "KILL must not precede the configured TERM grace period",
  );
  assert.equal(result.cleanup.groupDrained, true);
  assert.equal(result.cleanup.outputDrained, true);
  assertIdentityGone(ready.identity);
  assertIdentityGone(ready.descendant);
});

test("an exited leader cannot leave a TERM-resistant descriptor holder", { timeout: 5_000 }, async () => {
  const files = launcher();
  const result = track(await runWorkloadAttempt(workload(files, ["leader-exits-with-holder"], {
    termGraceMs: 50,
  })));
  const ready = jsonLines(result.output.stdout).find((entry) => entry.type === "leader-exits");

  assert.equal(result.observation.terminalReason, "natural-exit");
  assert.equal(result.observation.exitCode, 0);
  assert.equal(result.outcome.category, "pass");
  assert.equal(result.cleanup.term.attempted, true);
  assert.equal(result.cleanup.kill.attempted, true);
  assert.equal(result.cleanup.groupDrained, true);
  assert.equal(result.cleanup.outputDrained, true);
  assertIdentityGone(ready.descendant);
});

test("output excerpts remain bounded while hashes cover all observed bytes", { timeout: 5_000 }, async () => {
  const files = launcher();
  const byteCount = 32 * 1024;
  const result = track(await runWorkloadAttempt(
    workload(files, ["flood", String(byteCount)]),
    { stdoutExcerptBytes: 17, stderrExcerptBytes: 19 },
  ));

  assert.equal(result.outcome.category, "pass");
  assert.equal(result.output.stdout.bytes, String(byteCount));
  assert.equal(result.output.stderr.bytes, String(byteCount));
  assert.equal(result.output.stdout.excerptBytes, 17);
  assert.equal(result.output.stderr.excerptBytes, 19);
  assert.equal(result.output.stdout.truncated, true);
  assert.equal(result.output.stderr.truncated, true);
  assert.equal(result.output.stdout.sha256,
    createHash("sha256").update(Buffer.alloc(byteCount, 0x61)).digest("hex"));
  assert.equal(result.output.stderr.sha256,
    createHash("sha256").update(Buffer.alloc(byteCount, 0x62)).digest("hex"));
});

test("external AbortSignal cancellation remains operational evidence", { timeout: 5_000 }, async () => {
  const files = launcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = track(await runWorkloadAttempt(
    workload(files, ["hold"], { timeoutMs: 2_000 }),
    { signal: controller.signal },
  ));
  clearTimeout(timer);

  assert.equal(result.observation.terminalReason, "external-cancel");
  assert.equal(result.outcome.category, "operational-invalid");
  assert.equal(result.outcome.invalidReason, "external-cancel");
  assert.equal(result.cleanup.groupDrained, true);
});

test("managed workloads expose bound readiness and discard auxiliary output", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const allowed = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof allowed, "string");
  const cpu = expandCpuList(allowed)[0];
  const controller = new AbortController();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const running = runManagedWorkload(workload(files, ["flood-hold", String(64 * 1024)], {
    timeoutMs: 2_000,
  }), {
    signal: controller.signal,
    cpuAffinity: { cpu, tasksetPath: "/usr/bin/taskset" },
    onStarted(witness) {
      resolveStarted(witness);
    },
  });

  const witness = await started;
  assert.equal(Object.isFrozen(witness), true);
  assert.equal(witness.supervisor.allowedCpuList, String(cpu));
  assert.equal(witness.workload.allowedCpuList, String(cpu));
  assert.equal(witness.supervisor.processGroupId, witness.supervisor.pid);
  assert.match(witness.supervisor.startTicks, /^[0-9]+$/);
  assert.match(witness.workload.startTicks, /^[0-9]+$/);
  controller.abort();

  const managed = await running;
  track(managed);
  assert.deepEqual(Object.keys(managed).sort(), [
    "boundary",
    "cleanup",
    "execution",
    "observation",
    "outcome",
    "outputMode",
    "process",
    "readiness",
    "version",
    "workloadDigest",
  ]);
  assert.equal(managed.version, 1);
  assert.equal(managed.outputMode, "discard");
  assert.deepEqual(managed.readiness, { reported: true, errorCode: null });
  assert.equal("output" in managed, false);
  assert.equal("result" in managed, false);
  assert.equal(managed.observation.terminalReason, "external-cancel");
  assert.equal(managed.cleanup.groupDrained, true);
  assert.equal(managed.cleanup.outputDrained, true);
  assert.throws(() => buildAttemptEvidence(workload(files, ["exit", "0"]), managed),
    /attempt runner result must contain exactly/);
  assert.deepEqual(managed.execution.cpuAffinity, {
    requestedCpu: cpu,
    supervisorAllowedCpuList: String(cpu),
    workloadAllowedCpuList: String(cpu),
  });
});

test("managed readiness observers are synchronous and isolated from canonical attempts", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const resolved = workload(files, ["hold"], { timeoutMs: 2_000, termGraceMs: 20 });
  await assert.rejects(runWorkloadAttempt(resolved, {
    onStarted() {},
  }), /unknown field 'onStarted'/);
  await assert.rejects(runManagedWorkload(resolved),
    /managed attempt options\.onStarted must be a synchronous function/);

  const controller = new AbortController();
  controller.abort();
  let starts = 0;
  const cancelled = await runManagedWorkload(resolved, {
    signal: controller.signal,
    onStarted() { starts += 1; },
  });
  assert.equal(starts, 0);
  assert.equal(cancelled.process.supervisor, null);
  assert.equal(cancelled.process.workload, null);
  assert.equal(cancelled.observation.terminalReason, "external-cancel");
  assert.deepEqual(cancelled.readiness, { reported: false, errorCode: null });

  const managed = await runManagedWorkload(resolved, {
    onStarted: async () => {},
  });
  track(managed);
  assert.equal(managed.observation.terminalReason, "external-cancel");
  assert.equal(managed.observation.cleanupComplete, true);
  assert.equal(managed.cleanup.failureReason, null);
  assert.deepEqual(managed.readiness, {
    reported: false,
    errorCode: "MANAGED_START_OBSERVER_ASYNC",
  });
  assert.equal(managed.cleanup.groupDrained, true);
});

test("an unavailable group observation fails closed without claiming drain", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const runner = createAttemptRunner({
    listGroupMembers() {
      throw Object.assign(new Error("simulated process observation failure"), { code: "EIO" });
    },
  });
  const result = track(await runner(workload(files, ["hold"], {
    mode: "survive-window",
    timeoutMs: 100,
    termGraceMs: 20,
    killGraceMs: 200,
  })));

  assert.equal(result.observation.cleanupComplete, false);
  assert.equal(result.outcome.category, "operational-invalid");
  assert.equal(result.cleanup.groupDrained, false);
  assert.equal(result.cleanup.failureReason, "EIO");
  assert.equal(result.cleanup.term.attempted, true);
  assert.equal(result.cleanup.kill.attempted, true);
});

test("an already-aborted signal performs no launch", async () => {
  const files = launcher();
  const controller = new AbortController();
  controller.abort();
  const result = await runWorkloadAttempt(workload(files, ["hold"]), {
    signal: controller.signal,
  });

  assert.equal(result.process.supervisor, null);
  assert.equal(result.process.workload, null);
  assert.equal(result.observation.terminalReason, "external-cancel");
  assert.equal(result.cleanup.groupDrained, true);
});

test("runtime spawn failures are bounded launch-error evidence", { timeout: 5_000 }, async () => {
  const files = launcher({ missingInterpreter: true });
  const result = track(await runWorkloadAttempt(workload(files, [])));

  assert.equal(result.observation.terminalReason, "launch-error");
  assert.equal(result.observation.launchErrorCode, "ENOENT");
  assert.equal(result.outcome.category, "operational-invalid");
  assert.equal(result.outcome.invalidReason, "launch-error");
  assert.equal(result.cleanup.groupDrained, true);
  assert.equal(result.cleanup.outputDrained, true);
});

test("the supervisor revalidates provenance immediately before launch", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const resolved = workload(files, ["exact"]);
  const provenance = workloadLaunchProvenance(resolved);
  writeFileSync(files.executable,
    `#!${process.execPath}\n// changed after resolution\nimport ${JSON.stringify(FIXTURE)};\n`,
    { mode: 0o700 });

  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: "/",
    env: {},
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.resume();
  child.stderr.resume();

  let launchErrorCode = null;
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    child.on("message", (message) => {
      if (message.type === "supervisor-ready") {
        supervisorIdentities.push({
          pid: message.pid,
          processGroupId: message.processGroupId,
          sessionId: message.sessionId,
          startTicks: message.startTicks,
        });
        child.send({
          version: 4,
          type: "launch",
          executable: resolved.command.executable.path,
          args: [...resolved.command.args],
          cwd: resolved.command.cwd,
          environment: workloadLaunchEnvironment(resolved),
          termGraceMs: resolved.attempt.termGraceMs,
          cpuAffinity: null,
          provenance,
        });
      } else if (message.type === "workload-launch-error") {
        launchErrorCode = message.errorCode;
        child.send({ version: 4, type: "shutdown" });
      } else if (message.type === "workload-started" || message.type === "fatal") {
        reject(new Error(`unexpected supervisor event: ${message.type}`));
      }
    });
  });

  assert.equal(launchErrorCode, "WORKLOAD_PROVENANCE_CHANGED");
  assert.deepEqual(status, { exitCode: 0, signal: null });
});

test("the stable supervisor cleans its group when the parent IPC channel disappears", {
  timeout: 5_000,
}, async () => {
  const files = launcher();
  const resolved = workload(files, ["hold"], { termGraceMs: 50 });
  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: "/",
    env: {},
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.resume();
  child.stderr.resume();

  const identities = await new Promise((resolve, reject) => {
    let supervisorIdentity = null;
    child.once("error", reject);
    child.on("message", (message) => {
      if (message.type === "supervisor-ready") {
        supervisorIdentity = {
          pid: message.pid,
          processGroupId: message.processGroupId,
          sessionId: message.sessionId,
          startTicks: message.startTicks,
        };
        supervisorIdentities.push(supervisorIdentity);
        child.send({
          version: 4,
          type: "launch",
          executable: resolved.command.executable.path,
          args: [...resolved.command.args],
          cwd: resolved.command.cwd,
          environment: workloadLaunchEnvironment(resolved),
          termGraceMs: 50,
          cpuAffinity: null,
          provenance: workloadLaunchProvenance(resolved),
        });
      } else if (message.type === "workload-started") {
        resolve({
          supervisor: supervisorIdentity,
          workload: { pid: message.pid, startTicks: message.startTicks },
        });
      }
    });
  });

  const exited = new Promise((resolve) => child.once("exit", (exitCode, signal) =>
    resolve({ exitCode, signal })));
  child.disconnect();
  const status = await exited;

  assert.equal(status.exitCode, null);
  assert.equal(status.signal, "SIGKILL");
  assertIdentityGone(identities.supervisor);
  assertIdentityGone(identities.workload);
});
