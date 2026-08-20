import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  ControlledLoadPlanError,
  parseControlledLoadPlan,
  readControlledLoadPlanFile,
} from "../../src/fault-affinity/controlled-load-plan.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-controlled-plan-"));
  directories.push(directory);
  return directory;
}

function fixture(overrides = {}) {
  return {
    version: 1,
    controlledLoad: {
      targetCpu: 0,
      workerCpus: "1-2",
      attemptsPerLeg: 2,
      warmupMs: 25,
      recoveryMs: 50,
    },
    exact: { cpus: "0-2", rounds: 2, seed: 11 },
    ...overrides,
  };
}

test("controlled-load plans normalize both bounded schedules", () => {
  const plan = parseControlledLoadPlan(fixture());
  assert.deepEqual(plan.controlledLoad, {
    targetCpu: 0,
    workerCpus: [1, 2],
    attemptsPerLeg: 2,
    warmupMs: 25,
    recoveryMs: 50,
  });
  assert.deepEqual(plan.exact, { cpus: [0, 1, 2], rounds: 2, seed: 11 });
  assert.equal(Object.isFrozen(plan.controlledLoad.workerCpus), true);
});

test("controlled-load plans reject ambiguous, overlapping, and unbounded inputs", () => {
  assert.throws(() => parseControlledLoadPlan({ ...fixture(), extra: true }),
    (error) => error instanceof ControlledLoadPlanError && /contain exactly/.test(error.message));
  assert.throws(() => parseControlledLoadPlan(fixture({
    controlledLoad: {
      targetCpu: 1,
      workerCpus: "1-2",
      attemptsPerLeg: 1,
      warmupMs: 0,
      recoveryMs: 0,
    },
  })), /targetCpu must be outside workerCpus/);
  assert.throws(() => parseControlledLoadPlan(fixture({
    controlledLoad: {
      targetCpu: 0,
      workerCpus: "2,1",
      attemptsPerLeg: 1,
      warmupMs: 0,
      recoveryMs: 0,
    },
  })), /canonical ascending CPU list/);
  assert.throws(() => parseControlledLoadPlan(fixture({
    exact: { cpus: "0-65535", rounds: 16, seed: 0 },
  })), /exact schedule exceeds/);
});

test("controlled-load plan files use the shared stable JSON boundary", () => {
  const directory = temporaryDirectory();
  const filename = path.join(directory, "plan.json");
  writeFileSync(filename, `${JSON.stringify(fixture())}\n`, { mode: 0o600 });
  assert.deepEqual(readControlledLoadPlanFile(filename), parseControlledLoadPlan(fixture()));

  const symlink = path.join(directory, "plan-link.json");
  symlinkSync(filename, symlink);
  assert.throws(() => readControlledLoadPlanFile(symlink),
    (error) => error instanceof ControlledLoadPlanError &&
      error.code === "CONTROLLED_LOAD_PLAN_FILE_ERROR" &&
      /singly-linked regular file/.test(error.message));

  const hardlink = path.join(directory, "plan-hardlink.json");
  linkSync(filename, hardlink);
  assert.throws(() => readControlledLoadPlanFile(filename), /singly-linked regular file/);
});
