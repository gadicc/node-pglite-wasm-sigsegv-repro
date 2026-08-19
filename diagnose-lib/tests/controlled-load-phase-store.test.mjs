import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  CONTROLLED_LOAD_PHASE_FILE,
  ControlledLoadPhaseStoreError,
  commitControlledLoadSession,
  initializeControlledLoadPhaseStore,
  readControlledLoadPhaseStore,
} from "../controlled-load-phase-store.mjs";
import {
  buildControlledLoadSessionManifest,
  runControlledLoadSession,
} from "../controlled-load-session.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

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

function workload({ id, mode, source }) {
  const cwd = temporaryDirectory("controlled-load-store-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id,
    label: `${id} fixture`,
    description: "Harmless process used to validate complete-session storage.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", source], cwd },
    environment: {},
    attempt: { mode, timeoutMs: 5_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
}

function fixtures() {
  const allowed = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof allowed, "string");
  const cpus = expandCpuList(allowed).slice(0, 2);
  assert.equal(cpus.length, 2);
  const measured = workload({
    id: "controlled-load-store-measured",
    mode: "exit",
    source: "process.exit(0)",
  });
  const auxiliary = workload({
    id: "controlled-load-store-auxiliary",
    mode: "survive-window",
    source: "setInterval(() => {}, 1000)",
  });
  const manifest = buildControlledLoadSessionManifest(measured, auxiliary, {
    generation: "0123456789abcdef0123456789abcdef",
    attemptsPerLeg: 1,
    targetCpu: cpus[0],
    workerCpus: [cpus[1]],
    tasksetPath: "/usr/bin/taskset",
    warmupMs: 0,
    recoveryMs: 0,
  });
  return { measured, auxiliary, manifest };
}

async function session(measured, auxiliary, manifest) {
  const result = await runControlledLoadSession({ measured, auxiliary, manifest });
  assert.equal(result.committed, true, JSON.stringify(result));
  return result.envelope;
}

test("the phase store publishes one complete session and never a partial prefix", {
  timeout: 15_000,
}, async () => {
  const { measured, auxiliary, manifest } = fixtures();
  const stateDir = temporaryDirectory("controlled-load-store-");
  const initialized = await initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest,
    stateDir,
  });
  assert.deepEqual(initialized.progress, {
    status: "empty",
    complete: false,
    committedSessions: 0,
    totalSessions: 1,
  });
  assert.equal(initialized.envelope, null);
  assert.equal(statSync(path.join(stateDir, CONTROLLED_LOAD_PHASE_FILE)).mode & 0o777, 0o600);

  const envelope = await session(measured, auxiliary, manifest);
  const committed = await commitControlledLoadSession({
    measured,
    auxiliary,
    envelope,
    stateDir,
  });
  assert.equal(committed.progress.status, "complete");
  assert.deepEqual(committed.envelope, envelope);
  assert.deepEqual((await readControlledLoadPhaseStore({
    measured,
    auxiliary,
    stateDir,
  })).envelope, envelope);
  await assert.rejects(commitControlledLoadSession({
    measured,
    auxiliary,
    envelope,
    stateDir,
  }), /already contains a complete session/);
});

test("the phase store rejects manifest drift, foreign files, and envelope drift", {
  timeout: 15_000,
}, async () => {
  const { measured, auxiliary, manifest } = fixtures();
  const stateDir = temporaryDirectory("controlled-load-store-drift-");
  await initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest,
    stateDir,
  });
  const changed = buildControlledLoadSessionManifest(measured, auxiliary, {
    generation: manifest.generation,
    attemptsPerLeg: 1,
    targetCpu: manifest.execution.targetCpu,
    workerCpus: manifest.execution.workerCpus,
    tasksetPath: manifest.execution.tasksetPath,
    warmupMs: 0,
    recoveryMs: 1,
  });
  await assert.rejects(initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest: changed,
    stateDir,
  }), /different manifest/);

  const envelope = await session(measured, auxiliary, manifest);
  const drift = JSON.parse(JSON.stringify(envelope));
  drift.generation = "f".repeat(32);
  await assert.rejects(commitControlledLoadSession({
    measured,
    auxiliary,
    envelope: drift,
    stateDir,
  }), /different phase generation/);

  const foreignDir = temporaryDirectory("controlled-load-store-foreign-");
  writeFileSync(path.join(foreignDir, "foreign.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest,
    stateDir: foreignDir,
  }), /unknown file/);
});

test("known dead-writer remnants recover while live writers remain fenced", async () => {
  const { measured, auxiliary, manifest } = fixtures();
  const deadDir = temporaryDirectory("controlled-load-store-dead-");
  const deadName =
    ".controlled-load-phase.json.99999998.abcdef0123456789.writing.tmp";
  writeFileSync(path.join(deadDir, deadName), "incomplete", { mode: 0o600 });
  const recovered = await initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest,
    stateDir: deadDir,
  });
  assert.equal(recovered.progress.status, "empty");
  assert.equal(existsSync(path.join(deadDir, deadName)), false);

  const liveDir = temporaryDirectory("controlled-load-store-live-");
  const liveName =
    `.controlled-load-phase.json.${process.pid}.0123456789abcdef.writing.tmp`;
  writeFileSync(path.join(liveDir, liveName), "incomplete", { mode: 0o600 });
  await assert.rejects(initializeControlledLoadPhaseStore({
    measured,
    auxiliary,
    manifest,
    stateDir: liveDir,
  }), (error) => error instanceof ControlledLoadPhaseStoreError &&
    /live writer/.test(error.message));
  assert.equal(existsSync(path.join(liveDir, liveName)), true);
});
