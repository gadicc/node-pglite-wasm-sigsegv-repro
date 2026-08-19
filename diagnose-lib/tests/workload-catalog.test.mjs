import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  WorkloadCatalogError,
  listBuiltInWorkloads,
  resolveBuiltInWorkload,
  resolveCustomWorkloadFile,
  resolveWorkloadSelection,
} from "../../workloads/catalog.mjs";
import {
  verifyWorkloadProvenance,
  workloadLaunchEnvironment,
} from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixtureDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-catalog-"));
  directories.push(directory);
  return directory;
}

function customFixture(overrides = {}) {
  const directory = fixtureDirectory();
  const executable = path.join(directory, "finite-trigger");
  const source = path.join(directory, "source.txt");
  const definition = path.join(directory, "workload.json");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  writeFileSync(source, "finite fixture\n", { mode: 0o600 });
  const spec = {
    version: 1,
    id: "finite-fixture",
    label: "Finite fixture",
    description: "Harmless finite process used by catalog tests.",
    risk: "standard",
    command: { executable: "./finite-trigger", args: [], cwd: "." },
    environment: { set: { FIXTURE_VALUE: "bound-value" } },
    attempt: {
      mode: "exit",
      timeoutMs: 5_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: ["./source.txt"] },
    ...overrides,
  };
  writeFileSync(definition, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  return { directory, definition, executable, source };
}

test("the built-in catalog is descriptive and resolves without executing a workload", () => {
  const listed = listBuiltInWorkloads();
  assert.deepEqual(listed.map(({ id }) => id), [
    "wasm-churn",
    "wasm-churn-suite",
    "node-pglite",
    "node-pglite-suite",
  ]);
  assert.equal(listed[0].recommended, true);
  assert.equal(listed[2].risk, "high-memory");

  const selected = resolveBuiltInWorkload("wasm-churn");
  assert.equal(selected.source, "built-in");
  assert.equal(selected.resolved.id, "wasm-churn");
  assert.equal(selected.resolved.capabilities.baseline, false);
  assert.equal(selected.resolved.capabilities.isolated, true);
  assert.equal(selected.resolved.attempt.mode, "survive-window");
  assert.match(selected.resolved.digest, /^[a-f0-9]{64}$/);

  const suite = resolveBuiltInWorkload("wasm-churn-suite");
  assert.equal(suite.resolved.capabilities.baseline, true);
  assert.equal(suite.resolved.capabilities.groups, true);
  assert.equal(suite.resolved.capabilities.isolated, true);
  assert.equal(suite.resolved.capabilities.pinnedConcurrent, true);
  assert.notEqual(suite.resolved.digest, selected.resolved.digest);
});

test("custom files resolve relative paths and bind definition, environment, and provenance", () => {
  const files = customFixture();
  const selected = resolveCustomWorkloadFile(files.definition);

  assert.equal(selected.source, "custom-file");
  assert.equal(selected.metadata.file, files.definition);
  assert.equal(selected.resolved.command.executable.path, files.executable);
  assert.equal(selected.resolved.command.cwd, files.directory);
  assert.deepEqual(workloadLaunchEnvironment(selected.resolved), {
    FIXTURE_VALUE: "bound-value",
  });
  assert.equal(selected.resolved.environment.bindingMode, "hmac-sha256");
  assert.deepEqual(selected.resolved.provenance.files.map(({ path: filename }) => filename), [
    files.source,
    files.definition,
  ].sort());
  assert.equal(verifyWorkloadProvenance(selected.resolved), true);
  assert.doesNotMatch(JSON.stringify(selected.resolved), /bound-value/);

  writeFileSync(files.source, "changed after selection\n", { mode: 0o600 });
  assert.throws(() => verifyWorkloadProvenance(selected.resolved), /recorded identity/);
});

test("an explicit definition alias is not added as duplicate provenance", () => {
  const files = customFixture();
  const alias = path.join(files.directory, "definition-alias.json");
  symlinkSync(files.definition, alias);
  const raw = JSON.parse(readFileSync(files.definition, "utf8"));
  raw.provenance.files.push("./definition-alias.json");
  writeFileSync(files.definition, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  const selected = resolveCustomWorkloadFile(files.definition);
  assert.equal(selected.resolved.provenance.files.filter(
    ({ path: filename }) => filename === files.definition,
  ).length, 1);
});

test("custom workload selection rejects ambient pass-through and malformed UTF-8", () => {
  const ambient = customFixture({ environment: { pass: ["HOME"] } });
  assert.throws(() => resolveCustomWorkloadFile(ambient.definition),
    /environment\.pass is not supported/);

  const directory = fixtureDirectory();
  const malformed = path.join(directory, "malformed.json");
  writeFileSync(malformed, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  assert.throws(() => resolveCustomWorkloadFile(malformed),
    /valid UTF-8 JSON/);
});

test("selection is exclusive and unknown built-ins fail with a typed error", () => {
  const files = customFixture({ environment: {} });
  assert.throws(() => resolveWorkloadSelection({}), WorkloadCatalogError);
  assert.throws(() => resolveWorkloadSelection({
    workload: "wasm-churn",
    workloadFile: files.definition,
  }), /select exactly one/);
  assert.throws(() => resolveBuiltInWorkload("missing"), /unknown built-in workload/);
});
