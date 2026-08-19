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
  GroupPlanError,
  parseGroupPlan,
  readGroupPlanFile,
} from "../../fault-affinity-lib/group-plan.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-group-plan-"));
  directories.push(directory);
  return directory;
}

function fixture(overrides = {}) {
  return {
    version: 1,
    baseline: { children: 2, waves: 3 },
    groups: {
      cpuUniverse: "0-2",
      contexts: [
        { id: "all", kind: "uniform", cpus: "0-2", children: 2 },
        { id: "first", kind: "subset", cpus: "0", children: 1 },
      ],
      rounds: 2,
      seed: 7,
    },
    exact: { cpus: "0-2", rounds: 2, seed: 11 },
    ...overrides,
  };
}

test("group plans normalize canonical CPU lists and public field names", () => {
  const plan = parseGroupPlan(fixture());
  assert.deepEqual(plan.baseline, { childrenPerWave: 2, waves: 3 });
  assert.deepEqual(plan.groups.cpuUniverse, [0, 1, 2]);
  assert.deepEqual(plan.groups.contexts[0], {
    id: "all",
    kind: "uniform",
    cpus: [0, 1, 2],
    childrenPerWave: 2,
  });
  assert.deepEqual(plan.exact, { cpus: [0, 1, 2], rounds: 2, seed: 11 });
  assert.equal(Object.isFrozen(plan.groups.contexts[0].cpus), true);
});

test("group plans reject ambiguous shapes, CPU lists, and product limits", () => {
  assert.throws(() => parseGroupPlan({ ...fixture(), extra: true }),
    (error) => error instanceof GroupPlanError && /contain exactly/.test(error.message));
  assert.throws(() => parseGroupPlan(fixture({
    exact: { cpus: "1,0", rounds: 1, seed: 0 },
  })), /canonical ascending CPU list/);
  assert.throws(() => parseGroupPlan(fixture({
    baseline: { children: 64, waves: 65_536 },
  })), /baseline schedule exceeds/);
  assert.throws(() => parseGroupPlan(fixture({
    exact: { cpus: "0-65535", rounds: 16, seed: 0 },
  })), /exact schedule exceeds/);
});

test("group plan files are bounded stable single-link UTF-8 JSON inputs", () => {
  const directory = temporaryDirectory();
  const filename = path.join(directory, "plan.json");
  writeFileSync(filename, `${JSON.stringify(fixture())}\n`, { mode: 0o600 });
  assert.deepEqual(readGroupPlanFile(filename), parseGroupPlan(fixture()));

  const symlink = path.join(directory, "plan-link.json");
  symlinkSync(filename, symlink);
  assert.throws(() => readGroupPlanFile(symlink), /singly-linked regular file/);

  const hardlink = path.join(directory, "plan-hardlink.json");
  linkSync(filename, hardlink);
  assert.throws(() => readGroupPlanFile(filename), /singly-linked regular file/);
});

test("group plan files reject malformed JSON and forbidden control bytes", () => {
  const directory = temporaryDirectory();
  const malformed = path.join(directory, "malformed.json");
  writeFileSync(malformed, "{\n", { mode: 0o600 });
  assert.throws(() => readGroupPlanFile(malformed), /valid JSON/);

  const carriageReturn = path.join(directory, "carriage-return.json");
  writeFileSync(carriageReturn, "{}\r\n", { mode: 0o600 });
  assert.throws(() => readGroupPlanFile(carriageReturn), /forbidden control byte/);
});
