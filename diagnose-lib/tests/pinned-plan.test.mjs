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
  PinnedPlanError,
  parsePinnedPlan,
  readPinnedPlanFile,
} from "../../fault-affinity-lib/pinned-plan.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(overrides = {}) {
  return {
    version: 1,
    baseline: { children: 1, waves: 2 },
    groups: {
      cpuUniverse: "0-2",
      contexts: [{ id: "all", kind: "uniform", cpus: "0-2", children: 1 }],
      rounds: 1,
      seed: 7,
    },
    pinnedConcurrent: {
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: "1-2",
        cluster: "l2:1-2",
        controllerCpu: 0,
      }],
      rounds: 2,
      seed: 11,
    },
    exact: { cpus: "0-2", rounds: 1, seed: 13 },
    ...overrides,
  };
}

test("pinned plans normalize all four bounded schedules", () => {
  const plan = parsePinnedPlan(fixture());
  assert.deepEqual(plan.baseline, { childrenPerWave: 1, waves: 2 });
  assert.deepEqual(plan.pinnedConcurrent.contexts[0], {
    group: "active",
    kind: "subset",
    cpus: [1, 2],
    cluster: "l2:1-2",
    controllerCpu: 0,
  });
  assert.deepEqual(plan.pinnedConcurrent, {
    contexts: [plan.pinnedConcurrent.contexts[0]],
    rounds: 2,
    seed: 11,
  });
  assert.equal(Object.isFrozen(plan.pinnedConcurrent.contexts[0].cpus), true);
});

test("pinned plans reject ambiguous or noncanonical public fields", () => {
  assert.throws(() => parsePinnedPlan({ ...fixture(), extra: true }),
    (error) => error instanceof PinnedPlanError && /contain exactly/.test(error.message));
  assert.throws(() => parsePinnedPlan(fixture({
    pinnedConcurrent: {
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: "2,1",
        cluster: "l2:1-2",
        controllerCpu: 0,
      }],
      rounds: 1,
      seed: 0,
    },
  })), /canonical ascending CPU list/);
  assert.throws(() => parsePinnedPlan(fixture({
    pinnedConcurrent: {
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: "1-2",
        cluster: "not canonical",
        controllerCpu: 0,
      }],
      rounds: 1,
      seed: 0,
    },
  })), /cluster is not canonical/);
});

test("pinned plans reject unsafe controller placement and duplicate identities", () => {
  assert.throws(() => parsePinnedPlan(fixture({
    pinnedConcurrent: {
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: "1-2",
        cluster: "l2:1-2",
        controllerCpu: 1,
      }],
      rounds: 1,
      seed: 0,
    },
  })), /controller inside the active CPU set/);
  const repeated = {
    id: "active",
    kind: "subset",
    cpus: "1",
    cluster: "l2:1",
    controllerCpu: 0,
  };
  assert.throws(() => parsePinnedPlan(fixture({
    pinnedConcurrent: { contexts: [repeated, repeated], rounds: 1, seed: 0 },
  })), /duplicate context group/);
});

test("pinned plan files use the shared stable JSON boundary", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-pinned-plan-"));
  directories.push(directory);
  const filename = path.join(directory, "plan.json");
  writeFileSync(filename, `${JSON.stringify(fixture())}\n`, { mode: 0o600 });
  assert.deepEqual(readPinnedPlanFile(filename), parsePinnedPlan(fixture()));
});
