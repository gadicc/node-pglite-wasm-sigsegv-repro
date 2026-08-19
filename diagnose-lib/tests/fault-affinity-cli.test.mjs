import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  parseFaultAffinityArgs,
  runFaultAffinityCli,
} from "../../fault-affinity.mjs";
import { readLinuxAllowedCpuList } from "../attempt-runner.mjs";
import { readSchema3Bundle } from "../schema3-bundle.mjs";
import { resolveCustomWorkloadFile } from "../../workloads/catalog.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "fault-affinity-cli-"));
  directories.push(directory);
  return directory;
}

function allowedCpu() {
  const spec = readLinuxAllowedCpuList(process.pid, { strict: true });
  const token = spec.split(",")[0];
  return Number(token.split("-")[0]);
}

function customWorkload(directory, overrides = {}) {
  const definition = path.join(directory, "finite-workload.json");
  const value = {
    version: 1,
    id: "cli-finite",
    label: "CLI finite fixture",
    description: "Harmless finite process for public CLI integration tests.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd: "." },
    environment: {},
    attempt: {
      mode: "exit",
      timeoutMs: 5_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
    ...overrides,
  };
  writeFileSync(definition, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return definition;
}

function capture(cwd) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("argument parsing keeps live selection and confirmation explicit", () => {
  assert.deepEqual(parseFaultAffinityArgs(["workloads"]), { command: "workloads" });
  assert.throws(() => parseFaultAffinityArgs([
    "exact", "--workload", "wasm-churn", "--cpus", "0", "--out-dir", "bundle",
  ]), /exactly one --dry-run or --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "exact", "--workload", "wasm-churn", "--workload-file", "other.json",
    "--cpus", "0", "--out-dir", "bundle", "--dry-run",
  ]), /select exactly one/);
  assert.throws(() => parseFaultAffinityArgs([
    "exact", "--resume", "bundle", "--workload", "wasm-churn", "--dry-run",
  ]), /resume requires --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "exact", "--workload", "wasm-churn", "--cpus", "1,0", "--out-dir", "bundle",
    "--dry-run",
  ]), /canonical ascending CPU list/);
});

test("listing and inspection describe built-ins without creating files", async () => {
  const directory = temporaryDirectory();
  const listed = capture(directory);
  assert.equal(await runFaultAffinityCli(["workloads"], listed.io), 0);
  assert.match(listed.stdout(), /wasm-churn \(recommended\)/);
  assert.match(listed.stdout(), /node-pglite/);
  assert.equal(listed.stderr(), "");

  const inspected = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "inspect", "--workload", "wasm-churn", "--json",
  ], inspected.io), 0);
  const summary = JSON.parse(inspected.stdout());
  assert.equal(summary.id, "wasm-churn");
  assert.equal(summary.attempt.mode, "survive-window");
  assert.equal(summary.capabilities.isolated, true);
  assert.deepEqual(readdirSync(directory), []);
});

test("a dry run validates a custom exact plan without creating its output directory", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const output = path.join(directory, "planned-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "exact", "--workload-file", path.basename(definition),
    "--cpus", String(allowedCpu()), "--rounds", "2", "--seed", "7",
    "--out-dir", path.basename(output), "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /2 attempt\(s\)/);
  assert.match(captured.stdout(), /no workload executed and no bundle created/);
});

test("the public exact command creates, completes, and resumes its own schema-3 bundle", {
  timeout: 20_000,
}, async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const bundleDir = path.join(directory, "bundle");
  const first = capture(directory);
  const selection = ["--workload-file", path.basename(definition)];
  const rc = await runFaultAffinityCli([
    "exact", ...selection, "--cpus", String(allowedCpu()), "--rounds", "1",
    "--out-dir", path.basename(bundleDir), "--yes",
  ], first.io);
  assert.equal(rc, 0, first.stderr());
  assert.match(first.stdout(), /committed .*outcome=pass label=exit-zero/);
  assert.match(first.stdout(), /complete: 1\/1/);

  const resolved = resolveCustomWorkloadFile(definition).resolved;
  const bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.manifest.version, 1);
  assert.equal(bundle.exactCpu.progress.complete, true);
  assert.equal(bundle.exactCpu.envelopes.length, 1);

  const resumed = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], resumed.io), 0, resumed.stderr());
  assert.match(resumed.stdout(), /resuming workload=cli-finite/);
  assert.match(resumed.stdout(), /complete: 1\/1/);
});

test("custom ambient pass-through is rejected before planning", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory, { environment: { pass: ["HOME"] } });
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "inspect", "--workload-file", path.basename(definition),
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /environment\.pass is not supported/);
});
