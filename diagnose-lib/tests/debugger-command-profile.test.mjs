import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  DEBUGGER_COMMAND_DESCRIPTOR_VERSION,
  DEBUGGER_COMMAND_MAX_BYTES,
  DebuggerCommandProfileError,
  buildDebuggerCommandProfile,
  debuggerCommandProfileEmbedded,
} from "../debugger-command-profile.mjs";
import { parseDebuggerControlTranscript } from "../debugger-control.mjs";
import {
  DebuggerPhaseError,
  buildDebuggerPhaseManifest,
  debuggerPhaseManifestBinding,
} from "../debugger-phase.mjs";
import { canonicalProtocolJsonLine } from "../pinned-protocol.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];
const NONCE = "fedcba9876543210fedcba9876543210";
const GENERATION = "0123456789abcdef0123456789abcdef";
const PYTHON_DRIVER_MARKER = "# GDB driver:";
const PYTHON3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const EXPECTED_CAPTURE_SECTIONS = [
  "stop",
  "backtrace",
  "registers",
  "instructions",
  "threads",
  "mappings",
];
const EXPECTED_CAPTURE_COMMANDS = {
  stop: "info program",
  backtrace: "thread apply all backtrace full",
  registers: "info registers",
  instructions: "x/16i $pc",
  threads: "info threads",
  mappings: "info proc mappings",
};
const EXPECTED_FIXED_ARGS = [
  "--quiet",
  "--nx",
  "--nh",
  "--batch",
  "--init-eval-command=set auto-load off",
  "--init-eval-command=set debuginfod enabled off",
  "--eval-command=set pagination off",
  "--eval-command=set confirm off",
  "--eval-command=set print thread-events off",
  "--eval-command=set startup-with-shell off",
];
const EXPECTED_EXECUTE_FORMS = new Set([
  '"handle %s stop print nopass" % signal_name',
  '"starti"',
  '"continue"',
  'CONFIG["captureCommands"][section]',
  '"kill"',
]);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture({ targetArgs = [], environment } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-command-profile-"));
  directories.push(directory);
  const debuggerPath = path.join(directory, "gdb-fixture");
  writeFileSync(debuggerPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const targetPath = path.join(directory, "target-fixture");
  writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const resolved = resolveWorkloadSpec({
    version: 1,
    id: "debugger-command-fixture",
    label: "Debugger command fixture",
    description: "Finite local process used to validate debugger command descriptors.",
    risk: "standard",
    command: { executable: targetPath, args: targetArgs, cwd: directory },
    environment: environment ?? {},
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
    generation: GENERATION,
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
  return { directory, debuggerPath, resolved, manifest, context, manifestSha256 };
}

function build(files, context = files.context) {
  return buildDebuggerCommandProfile(files.resolved, files.manifest, context);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function targetArgv(descriptor) {
  const split = descriptor.command.args.indexOf("--args");
  assert.notEqual(split, -1);
  assert.equal(descriptor.command.args.lastIndexOf("--args"), split);
  return descriptor.command.args.slice(split + 1);
}

function runControlPrelude(files, source, emission) {
  const marker = source.indexOf(PYTHON_DRIVER_MARKER);
  assert.notEqual(marker, -1);
  const harnessPath = path.join(files.directory, "control-prelude-harness.py");
  writeFileSync(harnessPath, `${source.slice(0, marker)}\n${emission}\n`);
  const result = spawnSync("python3", [harnessPath], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.output[3];
}

test("the descriptor binds manifest, workload, schedule, capture, and command " +
  "deterministically", () => {
  const files = fixture({ targetArgs: ["-e", "process.exit(0)"] });
  const first = build(files);
  const second = build(files);

  assert.deepEqual(second, first);
  assert.equal(first.version, DEBUGGER_COMMAND_DESCRIPTOR_VERSION);
  assert.equal(first.profileId, "fault-affinity-gdb-batch-v1");
  assert.deepEqual(first.context, {
    generation: GENERATION,
    manifestSha256: files.manifestSha256,
    run: 1,
    nonce: NONCE,
  });
  assert.deepEqual(first.workload, {
    id: files.resolved.id,
    digest: files.resolved.digest,
  });
  assert.deepEqual(first.schedule, { cpu: 8, allowedCpuList: "8" });
  assert.deepEqual(first.targetSignals, ["SIGSEGV", "SIGUSR2"]);
  assert.deepEqual(first.capture, {
    sections: EXPECTED_CAPTURE_SECTIONS,
    commands: EXPECTED_CAPTURE_COMMANDS,
  });
  assert.equal(first.command.executable, files.manifest.debugger.executable.path);
  assert.equal(first.command.cwd, files.resolved.command.cwd);
  assert.deepEqual(
    first.command.args.slice(0, EXPECTED_FIXED_ARGS.length),
    EXPECTED_FIXED_ARGS,
  );
  assert.match(first.command.args[EXPECTED_FIXED_ARGS.length],
    /^--eval-command=python exec\("/);
  assert.match(first.binding.sha256, /^[a-f0-9]{64}$/);
  assert.ok(first.binding.bytes > 0 && first.binding.bytes <= DEBUGGER_COMMAND_MAX_BYTES);
});

test("the identity hash and byte count cover the canonical identity line", () => {
  const files = fixture();
  const descriptor = build(files);
  const { binding, ...identity } = descriptor;
  const identityBytes = canonicalProtocolJsonLine(identity);

  assert.equal(binding.bytes, identityBytes.length);
  assert.equal(binding.sha256, createHash("sha256").update(identityBytes).digest("hex"));
});

test("the descriptor is frozen recursively", () => {
  const files = fixture({ targetArgs: ["alpha"] });
  const descriptor = build(files);
  assertDeepFrozen(descriptor);
  assert.throws(() => {
    descriptor.command.args[0] = "--batch=false";
  }, TypeError);
  assert.throws(() => {
    descriptor.capture.sections.push("other");
  }, TypeError);
});

test("target argv is preserved exactly after --args", () => {
  const targetArgs = [
    "",
    "with space",
    "-nx",
    "--batch",
    "$(printf pwned)",
    "`id`",
    "a;b",
    "line\nbreak",
    "star*glob?",
  ];
  const files = fixture({ targetArgs });
  const descriptor = build(files);

  assert.deepEqual(targetArgv(descriptor), [
    files.resolved.command.executable.path,
    ...targetArgs,
  ]);
  const roundTripped = JSON.parse(JSON.stringify(descriptor));
  assert.deepEqual(targetArgv(roundTripped), [
    files.resolved.command.executable.path,
    ...targetArgs,
  ]);
});

test("the embedded Python source and config extract and reconcile with the descriptor", () => {
  const files = fixture();
  const descriptor = build(files);
  const embedded = debuggerCommandProfileEmbedded(descriptor);

  assert.deepEqual(embedded.config, {
    generation: GENERATION,
    manifestSha256: files.manifestSha256,
    run: 1,
    nonce: NONCE,
    profileId: "fault-affinity-gdb-batch-v1",
    allowedCpuList: "8",
    targetSignals: ["SIGSEGV", "SIGUSR2"],
    captureSections: EXPECTED_CAPTURE_SECTIONS,
    captureCommands: EXPECTED_CAPTURE_COMMANDS,
    targetId: files.resolved.id,
    targetDigest: files.resolved.digest,
    knownSignals: Object.keys(osConstants.signals).sort(),
  });
  const expectedArgument = `--eval-command=python exec(${JSON.stringify(embedded.source)})`;
  assert.equal(descriptor.command.args.filter((argument) => argument === expectedArgument)
    .length, 1);
  assert.equal(Object.isFrozen(embedded), true);
  assertDeepFrozen(embedded.config);

  const tampered = clone(descriptor);
  tampered.schedule.allowedCpuList = "9";
  assert.throws(() => debuggerCommandProfileEmbedded(tampered),
    /does not match the descriptor bindings/);
  const missing = clone(descriptor);
  missing.command.args = missing.command.args.filter((argument) =>
    !argument.startsWith("--eval-command=python exec("));
  assert.throws(() => debuggerCommandProfileEmbedded(missing),
    /exactly one Python profile/);
});

test("the embedded profile keeps the control fd private and canonical", () => {
  const files = fixture();
  const { source } = debuggerCommandProfileEmbedded(build(files));

  assert.ok(source.includes("CONTROL_FD = 3"));
  const inheritable = source.indexOf("os.set_inheritable(CONTROL_FD, False)");
  const ready = source.indexOf('emit("profile-ready"');
  const starti = source.indexOf('gdb.execute("starti"');
  assert.ok(inheritable !== -1 && ready !== -1 && starti !== -1);
  assert.ok(inheritable < ready && ready < starti,
    "fd 3 must be non-inheritable before ready and inferior start");

  assert.equal(source.split("os.write(").length - 1, 1);
  assert.ok(source.includes("os.write(CONTROL_FD, data[offset:])"));
  assert.ok(!source.includes("sys.stdout") && !source.includes("print("));
  assert.ok(source.includes('separators=(",", ":")') && source.includes("sort_keys=True"));
  assert.ok(source.includes('+ "\\n").encode("ascii")'));
  assert.ok(source.includes("SEQUENCE += 1"));
});

test("the embedded profile emits only fixed commands and protocol records", () => {
  const files = fixture();
  const { source, config } = debuggerCommandProfileEmbedded(build(files));

  for (const type of [
    "profile-ready",
    "inferior-started",
    "inferior-stopped",
    "inferior-exited",
    "inferior-signaled",
    "capture-complete",
    "profile-error",
    "profile-complete",
  ]) {
    assert.ok(source.includes(`"${type}"`), `missing record type ${type}`);
  }
  assert.deepEqual(config.captureCommands, EXPECTED_CAPTURE_COMMANDS);

  const executeForms = new Set(
    [...source.matchAll(/gdb\.execute\(([^\n]*?), to_string=False\)/g)]
      .map((match) => match[1]),
  );
  assert.deepEqual(executeForms, EXPECTED_EXECUTE_FORMS);

  assert.equal(source.split('emit("profile-complete")').length - 1, 1);
  const finallyIndex = source.indexOf("    finally:");
  const killIndex = source.indexOf('gdb.execute("kill"', finallyIndex);
  assert.ok(finallyIndex !== -1 && killIndex > finallyIndex);
  assert.ok(source.indexOf('emit("profile-complete")') > killIndex,
    "profile-complete must close the post-ready finally after the kill attempt");
  assert.ok(!source.includes("gdb.execute(command") && !source.includes("gdb.execute(cmd"));
});

test("the generated profile compiles under python3 without GDB", { skip: !PYTHON3 }, () => {
  const files = fixture();
  const { source } = debuggerCommandProfileEmbedded(build(files));
  const sourcePath = path.join(files.directory, "generated-profile.py");
  writeFileSync(sourcePath, source);
  const compiled = spawnSync("python3", ["-m", "py_compile", sourcePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  assert.equal(compiled.status, 0, compiled.stderr?.toString());
});

test("the emission prelude produces parser-valid canonical control records",
  { skip: !PYTHON3 }, () => {
  const files = fixture();
  const { source } = debuggerCommandProfileEmbedded(build(files));
  const parse = (bytes) => parseDebuggerControlTranscript(
    files.resolved,
    files.manifest,
    files.context,
    bytes,
  );

  const launchError = parse(runControlPrelude(files, source, `
emit("profile-ready", profileId=CONFIG["profileId"])
emit("profile-error", stage="launch", code="GDB_LAUNCH_ERROR")
emit("profile-complete")
`));
  assert.deepEqual(launchError.error, { stage: "launch", code: "GDB_LAUNCH_ERROR" });
  assert.equal(launchError.terminal, null);
  assert.equal(launchError.binding.recordCount, 3);

  const stopped = parse(runControlPrelude(files, source, `
emit("profile-ready", profileId=CONFIG["profileId"])
emit("inferior-started", pid=4321, startTicks="987654", allowedCpuList=CONFIG["allowedCpuList"])
emit("inferior-stopped", signal="SIGSEGV")
emit("capture-complete", sections=CONFIG["captureSections"])
emit("profile-complete")
`));
  assert.deepEqual(stopped.inferior, { pid: 4321, startTicks: "987654", allowedCpuList: "8" });
  assert.deepEqual(stopped.terminal, { kind: "stopped", signal: "SIGSEGV" });
  assert.deepEqual(stopped.capture, { sections: EXPECTED_CAPTURE_SECTIONS });
  assert.equal(stopped.error, null);

  const exited = parse(runControlPrelude(files, source, `
emit("profile-ready", profileId=CONFIG["profileId"])
emit("inferior-started", pid=4321, startTicks="987654", allowedCpuList=CONFIG["allowedCpuList"])
emit("inferior-exited", exitCode=0)
emit("profile-complete")
`));
  assert.deepEqual(exited.terminal, { kind: "exited", exitCode: 0 });

  const signaled = parse(runControlPrelude(files, source, `
emit("profile-ready", profileId=CONFIG["profileId"])
emit("inferior-started", pid=4321, startTicks="987654", allowedCpuList=CONFIG["allowedCpuList"])
emit("inferior-signaled", signal="SIGUSR2")
emit("profile-complete")
`));
  assert.deepEqual(signaled.terminal, { kind: "signaled", signal: "SIGUSR2" });
});

test("run and nonce context validation is strict", () => {
  const files = fixture();
  for (const run of [0, 13, 1.5, "1", null]) {
    assert.throws(() => build(files, { run, nonce: NONCE }),
      /run must be an integer from 1 through 12/);
  }
  for (const nonce of ["", "A".repeat(32), "f".repeat(31), "g".repeat(32), 42]) {
    assert.throws(() => build(files, { run: 1, nonce }),
      /nonce must be exactly 32 lowercase hexadecimal characters/);
  }
  assert.throws(() => build(files, { run: 1, nonce: NONCE, extra: true }),
    /must contain exactly: nonce, run/);
  assert.throws(() => build(files, null), /must be a plain object/);
  for (const invalid of [0, 13]) {
    assert.throws(() => build(files, { run: invalid, nonce: NONCE }),
      DebuggerCommandProfileError);
  }
});

test("manifest tampering is rejected before any command materializes", () => {
  const files = fixture();
  const cases = [
    (value) => { value.version = 2; },
    (value) => { value.phase = "other"; },
    (value) => { value.workload.digest = "0".repeat(64); },
    (value) => { value.debugger.executable.sha256 = "0".repeat(64); },
    (value) => { value.debugger.commandProfile.targetSignals = ["SIGSEGV"]; },
    (value) => { value.schedule.cpu = 9; },
    (value) => { value.schedule.maxRuns += 1; },
    (value) => { value.execution.affinityMode = "other"; },
  ];
  for (const mutate of cases) {
    const manifest = clone(files.manifest);
    mutate(manifest);
    assert.throws(
      () => buildDebuggerCommandProfile(files.resolved, manifest, files.context),
      DebuggerPhaseError,
    );
  }
});

test("a manifest built for another workload is rejected", () => {
  const files = fixture();
  const other = resolveWorkloadSpec({
    version: 1,
    id: "debugger-command-other",
    label: "Other fixture",
    description: "A distinct workload identity sharing the fixture files.",
    risk: "standard",
    command: {
      executable: files.resolved.command.executable.path,
      args: [],
      cwd: files.directory,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true, gdb: true },
    provenance: { completeness: "complete", files: [] },
  });
  assert.throws(
    () => buildDebuggerCommandProfile(other, files.manifest, files.context),
    /workload binding does not match/,
  );
});

test("oversized descriptors fail with a stable typed error", () => {
  const files = fixture({ targetArgs: Array.from({ length: 70 }, () => "a".repeat(16_384)) });
  assert.throws(
    () => build(files),
    (error) => error instanceof DebuggerCommandProfileError &&
      error.code === "DEBUGGER_COMMAND_TOO_LARGE" &&
      /at most 1048576 bytes/.test(error.message),
  );
});

test("target environment values never appear in the descriptor", () => {
  const sentinel = "sentinel-secret-value-0123456789abcdef";
  const files = fixture({
    environment: { set: { FAULT_AFFINITY_SENTINEL: sentinel } },
  });
  const descriptor = build(files);
  const serialized = JSON.stringify(descriptor);
  assert.ok(!serialized.includes(sentinel));
  assert.ok(!serialized.includes("FAULT_AFFINITY_SENTINEL"));
});

test("no shell-based launch construction reaches the descriptor", () => {
  const files = fixture({ targetArgs: ["; rm -rf / #"] });
  const descriptor = build(files);
  const { source } = debuggerCommandProfileEmbedded(descriptor);
  const fixed = descriptor.command.args.slice(0, descriptor.command.args.indexOf("--args"));

  assert.equal(descriptor.command.executable, files.manifest.debugger.executable.path);
  for (const argument of fixed) assert.ok(argument.startsWith("--"));
  assert.ok(fixed.includes("--eval-command=set startup-with-shell off"));
  for (const argument of descriptor.command.args) {
    assert.ok(!argument.includes("sh -c") && !argument.includes("/bin/sh") &&
      !argument.includes("bash") && !argument.includes("taskset"));
  }
  for (const forbidden of [
    "os.system",
    "subprocess",
    "Popen",
    "shell=True",
    'gdb.execute("shell',
    "/bin/sh",
    "/bin/bash",
  ]) {
    assert.ok(!source.includes(forbidden), `profile must not contain ${forbidden}`);
  }
});
