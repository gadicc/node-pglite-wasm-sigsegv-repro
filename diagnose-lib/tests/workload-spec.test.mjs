import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  WorkloadSpecError,
  canonicalWorkloadJson,
  classifyWorkloadAttempt,
  resolveWorkloadSpec,
  verifyWorkloadLaunchProvenance,
  verifyWorkloadProvenance,
  workloadLaunchEnvironment,
  workloadLaunchProvenance,
} from "../workload-spec.mjs";

const fixtureDirectories = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "workload-spec-"));
  fixtureDirectories.push(directory);
  const executable = path.join(directory, "trigger");
  const artifact = path.join(directory, "source.txt");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(artifact, "source\n", { mode: 0o600 });
  return { directory, executable, artifact };
}

function spec(files, overrides = {}) {
  return {
    version: 1,
    id: "test-trigger",
    label: "Test trigger",
    description: "Finite trigger used by the workload contract tests.",
    risk: "standard",
    command: {
      executable: files.executable,
      args: ["argument with spaces", ""],
      cwd: files.directory,
    },
    environment: {
      pass: ["TEST_AMBIENT"],
      set: { TEST_FIXED: "fixed-value" },
    },
    attempt: {
      mode: "exit",
      timeoutMs: 10_000,
      termGraceMs: 500,
      killGraceMs: 500,
    },
    outcomes: {
      targetSignals: ["SIGSEGV"],
      mappedExits: [
        { code: 42, category: "target-fault", label: "handled-sigsegv" },
        { code: 43, category: "corruption", label: "data-mismatch" },
      ],
    },
    capabilities: {
      baseline: true,
      groups: true,
      isolated: true,
      pinnedConcurrent: true,
      gdb: false,
      frequency: false,
    },
    provenance: {
      completeness: "complete",
      files: [files.artifact],
    },
    ...overrides,
  };
}

function resolve(value, options = {}) {
  return resolveWorkloadSpec(value, {
    environment: { TEST_AMBIENT: "ambient-secret", IGNORED_SECRET: "not selected" },
    ...options,
  });
}

function observe(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    terminalReason: "natural-exit",
    cleanupComplete: true,
    launchErrorCode: null,
    ...overrides,
  };
}

test("workload resolution canonicalizes paths and omits environment verifiers by default", () => {
  const files = fixture();
  const executableLink = path.join(files.directory, "trigger-link");
  symlinkSync(files.executable, executableLink);
  const resolved = resolve(spec({ ...files, executable: executableLink }));

  assert.equal(resolved.command.executable.path, files.executable);
  assert.match(resolved.command.executable.sha256, /^[a-f0-9]{64}$/);
  assert.equal(resolved.provenance.completeness, "complete");
  assert.equal(resolved.provenance.files[0].path, files.artifact);
  assert.match(resolved.provenance.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(resolved.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(workloadLaunchEnvironment(resolved), {
    TEST_AMBIENT: "ambient-secret",
    TEST_FIXED: "fixed-value",
  });
  const serialized = JSON.stringify(resolved);
  assert.doesNotMatch(serialized, /ambient-secret|fixed-value|IGNORED_SECRET/);
  assert.equal(resolved.environment.bindingMode, "unrecorded");
  assert.equal(resolved.environment.provenanceComplete, false);
  assert.doesNotMatch(serialized, /value(?:Sha|Hmac)/);
  assert.equal(canonicalWorkloadJson(resolved), canonicalWorkloadJson(JSON.parse(serialized)));
});

test("a keyed workload digest binds executable, argv, environment values, and provenance", () => {
  const files = fixture();
  const environmentBindingKey = Buffer.alloc(32, 0x41);
  const options = { environmentBindingKey };
  const original = resolve(spec(files), options);
  const changedArg = resolve(spec(files, {
    command: { ...spec(files).command, args: ["changed"] },
  }), options);
  const changedEnvironment = resolveWorkloadSpec(spec(files), {
    environment: { TEST_AMBIENT: "different" },
    environmentBindingKey,
  });
  writeFileSync(files.executable, "#!/bin/sh\nexit 7\n");
  const changedExecutable = resolve(spec(files), options);
  writeFileSync(files.executable, "#!/bin/sh\nexit 0\n");
  writeFileSync(files.artifact, "changed source\n");
  const changedArtifact = resolve(spec(files), options);

  assert.notEqual(changedArg.digest, original.digest);
  assert.notEqual(changedEnvironment.digest, original.digest);
  assert.notEqual(changedExecutable.digest, original.digest);
  assert.notEqual(changedArtifact.digest, original.digest);
  assert.equal(original.environment.bindingMode, "hmac-sha256");
  assert.equal(original.environment.provenanceComplete, true);
  assert.match(original.environment.bindings[0].valueHmacSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(original), /ambient-secret|fixed-value|41414141/);
});

test("unrecorded environment changes are disclosed as provenance-incomplete", () => {
  const files = fixture();
  const original = resolve(spec(files));
  const changed = resolveWorkloadSpec(spec(files), {
    environment: { TEST_AMBIENT: "different" },
  });

  assert.equal(changed.digest, original.digest);
  assert.equal(changed.environment.provenanceComplete, false);
});

test("provenance revalidation detects drift after resolution", () => {
  const files = fixture();
  const resolved = resolve(spec(files));
  assert.equal(verifyWorkloadProvenance(resolved), true);
  assert.equal(verifyWorkloadLaunchProvenance(workloadLaunchProvenance(resolved)), true);
  writeFileSync(files.artifact, "changed after resolution\n");
  assert.throws(() => verifyWorkloadProvenance(resolved), /recorded identity/);
});

test("launch provenance rejects malformed or duplicated records", () => {
  const resolved = resolve(spec(fixture()));
  const snapshot = workloadLaunchProvenance(resolved);
  assert.throws(() => verifyWorkloadLaunchProvenance({
    ...snapshot,
    executable: { ...snapshot.executable, bytes: "9".repeat(64) },
  }), /malformed provenance/);
  assert.throws(() => verifyWorkloadLaunchProvenance({
    ...snapshot,
    files: [snapshot.files[0], snapshot.files[0]],
  }), /duplicated/);
});

test("workload resolution rejects ambiguous or unsafe command contracts", () => {
  const files = fixture();
  assert.throws(() => resolve(spec(files, { id: "Bad_ID" })), WorkloadSpecError);
  assert.throws(() => resolve(spec(files, {
    command: { ...spec(files).command, executable: "relative-trigger" },
  })), /absolute bounded path/);
  chmodSync(files.executable, 0o600);
  assert.throws(() => resolve(spec(files)), /must be executable/);
  chmodSync(files.executable, 0o700);
  assert.throws(() => resolve(spec(files, {
    environment: { pass: ["TEST_AMBIENT"], set: { TEST_AMBIENT: "duplicate" } },
  })), /duplicated/);
  assert.throws(() => resolve(spec(files, {
    outcomes: {
      targetSignals: ["SIGSEGV"],
      mappedExits: [
        { code: 42, category: "target-fault", label: "one" },
        { code: 42, category: "corruption", label: "two" },
      ],
    },
  })), /duplicated/);
  assert.throws(() => resolve({ ...spec(files), unknown: true }), /unknown field/);
  assert.throws(() => resolve(spec(files, {
    provenance: { completeness: "unknown", files: [] },
  })), /provenance\.completeness/);
  assert.throws(() => resolve(spec(files), {
    environmentBindingKey: Buffer.alloc(16),
  }), /at least 32 bytes/);
  assert.throws(() => resolve(spec(files), {
    environmentBindingKeey: Buffer.alloc(32),
  }), /unknown field/);
});

test("typed outcome evidence keeps direct signals and mapped exits distinct", () => {
  const resolved = resolve(spec(fixture()));
  assert.deepEqual(
    classifyWorkloadAttempt(resolved, observe({ exitCode: null, signal: "SIGSEGV" })),
    {
      category: "target-fault",
      evidenceKind: "direct-signal",
      label: "sigsegv",
      validOutcome: true,
      invalidReason: null,
      raw: {
        exitCode: null,
        signal: "SIGSEGV",
        terminalReason: "natural-exit",
        cleanupComplete: true,
        launchErrorCode: null,
      },
    },
  );
  assert.equal(classifyWorkloadAttempt(resolved, observe({ exitCode: 139 })).category,
    "other-workload-failure");
  assert.equal(classifyWorkloadAttempt(resolved, observe({ exitCode: 139 })).evidenceKind,
    "unmapped-exit");
  assert.equal(classifyWorkloadAttempt(resolved, observe({ exitCode: 42 })).category,
    "target-fault");
  assert.equal(classifyWorkloadAttempt(resolved, observe({ exitCode: 42 })).evidenceKind,
    "mapped-exit");
  assert.equal(classifyWorkloadAttempt(resolved, observe({ exitCode: 43 })).category,
    "corruption");
});

test("survival deadlines are pass evidence only for survive-window attempts", () => {
  const files = fixture();
  const finite = resolve(spec(files));
  const continuous = resolve(spec(files, {
    attempt: { ...spec(files).attempt, mode: "survive-window" },
  }));
  const deadline = observe({
    exitCode: null,
    terminalReason: "observation-window-elapsed",
  });

  assert.equal(classifyWorkloadAttempt(finite, deadline).category, "operational-invalid");
  assert.equal(classifyWorkloadAttempt(finite, deadline).invalidReason,
    "observation-window-before-exit");
  assert.deepEqual(classifyWorkloadAttempt(continuous, deadline), {
    category: "pass",
    evidenceKind: "survived-window",
    label: "no-target-fault-within-window",
    validOutcome: true,
    invalidReason: null,
    raw: {
      exitCode: null,
      signal: null,
      terminalReason: "observation-window-elapsed",
      cleanupComplete: true,
      launchErrorCode: null,
    },
  });
});

test("deadline races never hide a workload status", () => {
  const files = fixture();
  const continuous = resolve(spec(files, {
    attempt: { ...spec(files).attempt, mode: "survive-window" },
  }));
  const racedFault = observe({
    exitCode: null,
    signal: "SIGSEGV",
    terminalReason: "observation-window-elapsed",
  });

  assert.equal(classifyWorkloadAttempt(continuous, racedFault).category, "operational-invalid");
  assert.equal(classifyWorkloadAttempt(continuous, racedFault).invalidReason,
    "ambiguous-terminal-event");
});

test("an unresolved deadline race is always operationally invalid", () => {
  const files = fixture();
  const continuous = resolve(spec(files, {
    attempt: { ...spec(files).attempt, mode: "survive-window" },
  }));
  const result = classifyWorkloadAttempt(continuous, observe({
    exitCode: null,
    terminalReason: "terminal-race-unresolved",
  }));

  assert.equal(result.category, "operational-invalid");
  assert.equal(result.invalidReason, "terminal-race-unresolved");
});

test("a natural early exit keeps its raw outcome in survive-window mode", () => {
  const files = fixture();
  const continuous = resolve(spec(files, {
    attempt: { ...spec(files).attempt, mode: "survive-window" },
  }));
  const result = classifyWorkloadAttempt(continuous, observe());

  assert.equal(result.category, "pass");
  assert.equal(result.evidenceKind, "normal-exit");
  assert.equal(result.label, "exit-zero");
});

test("external cancellation, launch errors, and incomplete cleanup are invalid evidence", () => {
  const resolved = resolve(spec(fixture()));
  assert.equal(classifyWorkloadAttempt(resolved, observe({
    exitCode: null,
    terminalReason: "external-cancel",
  })).invalidReason, "external-cancel");
  assert.equal(classifyWorkloadAttempt(resolved, observe({
    exitCode: null,
    terminalReason: "launch-error",
    launchErrorCode: "ENOENT",
  })).invalidReason, "launch-error");
  assert.equal(classifyWorkloadAttempt(resolved, observe({
    cleanupComplete: false,
  })).invalidReason, "cleanup-incomplete");
});

test("classifiers reject forged resolutions and redact malformed launch errors", () => {
  assert.throws(() => classifyWorkloadAttempt({ digest: "0".repeat(64) }, observe()),
    /resolved workload is invalid/);

  const resolved = resolve(spec(fixture()));
  const result = classifyWorkloadAttempt(resolved, observe({
    exitCode: null,
    terminalReason: "launch-error",
    launchErrorCode: { secret: "do-not-serialize" },
  }));
  assert.equal(result.invalidReason, "malformed-launch-error-code");
  assert.equal(result.raw.launchErrorCode, null);
  assert.doesNotMatch(JSON.stringify(result), /do-not-serialize/);
});
