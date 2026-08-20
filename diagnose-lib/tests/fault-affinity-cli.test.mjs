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
import { expandCpuList } from "../pinned-runner.mjs";
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

function allowedCpus(count = 1) {
  const spec = readLinuxAllowedCpuList(process.pid, { strict: true });
  const cpus = expandCpuList(spec);
  assert.ok(cpus.length >= count, `test requires at least ${count} allowed CPUs`);
  return cpus.slice(0, count);
}

function allowedCpu() {
  return allowedCpus()[0];
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
    capabilities: {
      baseline: true,
      groups: true,
      pinnedConcurrent: true,
      isolated: true,
    },
    provenance: { completeness: "complete", files: [] },
    ...overrides,
  };
  writeFileSync(definition, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return definition;
}

function conditionWorkload(directory, overrides = {}) {
  const definition = path.join(directory, "condition-workload.json");
  const value = {
    version: 1,
    id: "cli-condition",
    label: "CLI waiting fixture",
    description: "Harmless waiting process for controlled-load CLI integration tests.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ".",
    },
    environment: {},
    attempt: {
      mode: "survive-window",
      timeoutMs: 5_000,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {
      baseline: false,
      groups: false,
      pinnedConcurrent: false,
      isolated: false,
    },
    provenance: { completeness: "complete", files: [] },
    ...overrides,
  };
  writeFileSync(definition, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return definition;
}

function controlledLoadPlan(directory, overrides = {}) {
  const [targetCpu, workerCpu] = allowedCpus(2);
  const filename = path.join(directory, "controlled-load-plan.json");
  const value = {
    version: 1,
    controlledLoad: {
      targetCpu,
      workerCpus: String(workerCpu),
      attemptsPerLeg: 1,
      warmupMs: 0,
      recoveryMs: 0,
    },
    exact: { cpus: String(targetCpu), rounds: 1, seed: 17 },
    ...overrides,
  };
  writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filename;
}

function groupPlan(directory, overrides = {}) {
  const cpu = allowedCpu();
  const filename = path.join(directory, "group-plan.json");
  const value = {
    version: 1,
    baseline: { children: 1, waves: 1 },
    groups: {
      cpuUniverse: String(cpu),
      contexts: [{ id: "all", kind: "uniform", cpus: String(cpu), children: 1 }],
      rounds: 1,
      seed: 7,
    },
    exact: { cpus: String(cpu), rounds: 1, seed: 7 },
    ...overrides,
  };
  writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filename;
}

function pinnedPlan(directory, overrides = {}) {
  const [controller, active] = allowedCpus(2);
  const filename = path.join(directory, "pinned-plan.json");
  const value = {
    version: 1,
    baseline: { children: 1, waves: 1 },
    groups: {
      cpuUniverse: String(active),
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: String(active),
        children: 1,
      }],
      rounds: 1,
      seed: 7,
    },
    pinnedConcurrent: {
      contexts: [{
        id: "active",
        kind: "subset",
        cpus: String(active),
        cluster: `l2:${active}`,
        controllerCpu: controller,
      }],
      rounds: 1,
      seed: 11,
    },
    exact: { cpus: String(active), rounds: 1, seed: 13 },
    ...overrides,
  };
  writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filename;
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
  assert.deepEqual(parseFaultAffinityArgs([
    "summarize", "--bundle-dir", "bundle", "--workload-file", "measured.json",
    "--condition-workload-file", "condition.json", "--json",
  ]), {
    command: "summarize",
    workloadFile: "measured.json",
    bundleDir: "bundle",
    conditionWorkloadFile: "condition.json",
    json: true,
  });
  assert.throws(() => parseFaultAffinityArgs([
    "summarize", "--workload", "wasm-churn",
  ]), /requires --bundle-dir/);
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
  assert.throws(() => parseFaultAffinityArgs([
    "baseline", "--workload", "wasm-churn", "--children", "2", "--waves", "1",
    "--exact-cpus", "0", "--out-dir", "bundle",
  ]), /exactly one --dry-run or --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "baseline", "--resume", "bundle", "--workload", "wasm-churn", "--dry-run",
  ]), /baseline resume requires --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "baseline", "--workload", "wasm-churn", "--children", "64", "--waves", "65536",
    "--exact-cpus", "0", "--out-dir", "bundle", "--dry-run",
  ]), /baseline schedule exceeds/);
  assert.throws(() => parseFaultAffinityArgs([
    "baseline", "--workload", "wasm-churn", "--children", "1", "--waves", "1",
    "--exact-cpus", "1,0", "--out-dir", "bundle", "--dry-run",
  ]), /--exact-cpus must be a canonical ascending CPU list/);
  assert.throws(() => parseFaultAffinityArgs([
    "groups", "--workload", "wasm-churn-suite", "--plan-file", "plan.json",
    "--out-dir", "bundle",
  ]), /exactly one --dry-run or --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "groups", "--resume", "bundle", "--workload", "wasm-churn-suite", "--dry-run",
  ]), /groups resume requires --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "groups", "--resume", "bundle", "--workload", "wasm-churn-suite",
    "--plan-file", "plan.json", "--yes",
  ]), /fresh group options/);
  assert.deepEqual(parseFaultAffinityArgs([
    "pinned", "--workload", "wasm-churn-suite", "--plan-file", "plan.json",
    "--out-dir", "bundle", "--dry-run",
  ]), {
    command: "pinned",
    mode: "dry-run",
    workload: "wasm-churn-suite",
    planFile: "plan.json",
    outDir: "bundle",
    tasksetPath: "/usr/bin/taskset",
  });
  assert.deepEqual(parseFaultAffinityArgs([
    "pinned", "--resume", "bundle", "--workload", "wasm-churn-suite", "--yes",
  ]), {
    command: "pinned",
    mode: "resume",
    workload: "wasm-churn-suite",
    resumeDir: "bundle",
  });
  assert.throws(() => parseFaultAffinityArgs([
    "pinned", "--resume", "bundle", "--workload", "wasm-churn-suite", "--dry-run",
  ]), /pinned resume requires --yes/);
  assert.deepEqual(parseFaultAffinityArgs([
    "controlled-load", "--workload-file", "measured.json",
    "--condition-workload-file", "condition.json", "--plan-file", "plan.json",
    "--out-dir", "bundle", "--dry-run",
  ]), {
    command: "controlled-load",
    mode: "dry-run",
    workloadFile: "measured.json",
    conditionWorkloadFile: "condition.json",
    planFile: "plan.json",
    outDir: "bundle",
    tasksetPath: "/usr/bin/taskset",
  });
  assert.deepEqual(parseFaultAffinityArgs([
    "exact", "--resume", "bundle", "--workload-file", "measured.json",
    "--condition-workload-file", "condition.json", "--yes",
  ]), {
    command: "exact",
    mode: "resume",
    workloadFile: "measured.json",
    conditionWorkloadFile: "condition.json",
    resumeDir: "bundle",
  });
  assert.throws(() => parseFaultAffinityArgs([
    "controlled-load", "--resume", "bundle", "--workload-file", "measured.json",
    "--condition-workload-file", "condition.json", "--dry-run",
  ]), /controlled-load resume requires --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "controlled-load", "--workload-file", "measured.json", "--plan-file", "plan.json",
    "--out-dir", "bundle", "--dry-run",
  ]), /requires --condition-workload-file/);
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
  assert.equal(summary.capabilities.baseline, false);
  assert.equal(summary.capabilities.isolated, true);
  assert.deepEqual(readdirSync(directory), []);
});

test("a dry run validates baseline and bound exact schedules without creating output", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const output = path.join(directory, "planned-baseline-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "baseline", "--workload-file", path.basename(definition),
    "--children", "2", "--waves", "3", "--exact-cpus", String(allowedCpu()),
    "--exact-rounds", "2", "--exact-seed", "7",
    "--out-dir", path.basename(output), "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /baseline 2 child\(ren\) x 3 wave\(s\); 6 attempt\(s\)/);
  assert.match(captured.stdout(), /bound exact plan:.*2 attempt\(s\); seed 7/);
  assert.match(captured.stdout(), /no workload executed and no bundle created/);
});

test("a dry run validates all v3 schedules without creating output", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const plan = groupPlan(directory);
  const output = path.join(directory, "planned-group-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "groups", "--workload-file", path.basename(definition),
    "--plan-file", path.basename(plan), "--out-dir", path.basename(output),
    "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /bound baseline: 1 child\(ren\) x 1 wave\(s\)/);
  assert.match(captured.stdout(), /groups: 1 context\(s\); 1 wave\(s\); 1 attempt\(s\)/);
  assert.match(captured.stdout(), /bound exact: CPUs .*1 attempt\(s\); seed 7/);
  assert.match(captured.stdout(), /no workload executed and no bundle created/);
});

test("a dry run validates all v4 schedules without creating output", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const plan = pinnedPlan(directory);
  const output = path.join(directory, "planned-pinned-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "pinned", "--workload-file", path.basename(definition),
    "--plan-file", path.basename(plan), "--out-dir", path.basename(output),
    "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /bound baseline: 1 child\(ren\) x 1 wave\(s\)/);
  assert.match(captured.stdout(), /bound groups: 1 context\(s\); 1 wave\(s\)/);
  assert.match(captured.stdout(), /pinned-concurrent: 1 context\(s\); 1 wave\(s\); 1 attempt\(s\)/);
  assert.match(captured.stdout(), /bound exact: CPUs .*1 attempt\(s\); seed 13/);
  assert.match(captured.stdout(), /no workload executed and no bundle created/);
});

test("a dry run validates the v5 A/B/A and bound exact schedules", async () => {
  const directory = temporaryDirectory();
  const measured = customWorkload(directory);
  const condition = conditionWorkload(directory);
  const plan = controlledLoadPlan(directory);
  const output = path.join(directory, "planned-controlled-load-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "controlled-load", "--workload-file", path.basename(measured),
    "--condition-workload-file", path.basename(condition),
    "--plan-file", path.basename(plan), "--out-dir", path.basename(output),
    "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /measured workload:\ncli-finite:/);
  assert.match(captured.stdout(), /condition workload:\ncli-condition:/);
  assert.match(captured.stdout(),
    /controlled load: target CPU .*1 attempt\(s\) per A1\/B\/A2 leg; 3 attempt\(s\) total/);
  assert.match(captured.stdout(), /bound exact: CPUs .*1 attempt\(s\); seed 17/);
  assert.match(captured.stdout(), /no workload executed and no bundle created/);
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

  const summarized = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "summarize", "--bundle-dir", path.basename(bundleDir), ...selection, "--json",
  ], summarized.io), 0, summarized.stderr());
  const summary = JSON.parse(summarized.stdout());
  assert.equal(summary.bundle.manifestVersion, 1);
  assert.equal(summary.phases.exactCpu.status, "complete");
  assert.equal(summary.phases.exactCpu.cpus[0].committedAttempts, 1);
  assert.equal(summary.phases.baseline.status, "not-bound");

  const condition = conditionWorkload(directory);
  const extraCondition = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "summarize", "--bundle-dir", path.basename(bundleDir), ...selection,
    "--condition-workload-file", path.basename(condition),
  ], extraCondition.io), 2);
  assert.match(extraCondition.stderr(), /applies only to schema-3 manifest-v5 bundles/);
});

test("the public baseline command completes schema-3 v2 and exact resumes that bundle", {
  timeout: 20_000,
}, async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const bundleDir = path.join(directory, "baseline-bundle");
  const selection = ["--workload-file", path.basename(definition)];
  const baseline = capture(directory);
  const rc = await runFaultAffinityCli([
    "baseline", ...selection, "--children", "2", "--waves", "2",
    "--exact-cpus", String(allowedCpu()), "--exact-rounds", "1",
    "--out-dir", path.basename(bundleDir), "--yes",
  ], baseline.io);
  assert.equal(rc, 0, baseline.stderr());
  assert.match(baseline.stdout(), /committed wave=1 outcomes=pass:2/);
  assert.match(baseline.stdout(), /complete: 2\/2 baseline waves \(4\/4 attempts\)/);

  const resolved = resolveCustomWorkloadFile(definition).resolved;
  let bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.manifest.version, 2);
  assert.equal(bundle.baseline.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, false);

  const resumedBaseline = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "baseline", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], resumedBaseline.io), 0, resumedBaseline.stderr());
  assert.match(resumedBaseline.stdout(), /resuming baseline workload=cli-finite/);
  assert.match(resumedBaseline.stdout(), /complete: 2\/2 baseline waves/);

  const exact = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], exact.io), 0, exact.stderr());
  assert.match(exact.stdout(), /complete: 1\/1 exact-CPU attempts/);
  bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.baseline.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, true);
});

test("the public groups command completes v3 and sibling phase commands resume it", {
  timeout: 20_000,
}, async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const plan = groupPlan(directory);
  const bundleDir = path.join(directory, "group-bundle");
  const selection = ["--workload-file", path.basename(definition)];
  const groups = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "groups", ...selection, "--plan-file", path.basename(plan),
    "--out-dir", path.basename(bundleDir), "--yes",
  ], groups.io), 0, groups.stderr());
  assert.match(groups.stdout(), /committed group-wave=1 context=all outcomes=pass:1/);
  assert.match(groups.stdout(), /complete: 1\/1 CPU-group waves \(1\/1 attempts\)/);

  const resolved = resolveCustomWorkloadFile(definition).resolved;
  let bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.manifest.version, 3);
  assert.equal(bundle.groups.progress.complete, true);
  assert.equal(bundle.baseline.progress.complete, false);
  assert.equal(bundle.exactCpu.progress.complete, false);

  const resumedGroups = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "groups", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], resumedGroups.io), 0, resumedGroups.stderr());
  assert.match(resumedGroups.stdout(), /resuming groups workload=cli-finite/);
  assert.match(resumedGroups.stdout(), /complete: 1\/1 CPU-group waves/);

  const baseline = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "baseline", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], baseline.io), 0, baseline.stderr());
  const exact = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], exact.io), 0, exact.stderr());
  bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.baseline.progress.complete, true);
  assert.equal(bundle.groups.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, true);
});

test("the public pinned command completes v4 under its scheduled controller", {
  timeout: 30_000,
}, async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory);
  const plan = pinnedPlan(directory);
  const bundleDir = path.join(directory, "pinned-bundle");
  const selection = ["--workload-file", path.basename(definition)];
  const pinned = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "pinned", ...selection, "--plan-file", path.basename(plan),
    "--out-dir", path.basename(bundleDir), "--yes",
  ], pinned.io), 0, pinned.stderr());
  assert.match(pinned.stdout(), /pinned wave 1\/1 context=active controller=/);
  assert.match(pinned.stdout(),
    /committed pinned-wave=1 context=active controller=.*outcomes=pass:1/);
  assert.match(pinned.stdout(),
    /complete: 1\/1 pinned-concurrent waves \(1\/1 attempts\)/);

  const resolved = resolveCustomWorkloadFile(definition).resolved;
  let bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.manifest.version, 4);
  assert.equal(bundle.pinnedConcurrent.progress.complete, true);
  assert.equal(bundle.pinnedConcurrent.envelopes.length, 1);
  assert.equal(bundle.baseline.progress.complete, false);
  assert.equal(bundle.groups.progress.complete, false);
  assert.equal(bundle.exactCpu.progress.complete, false);

  const resumedPinned = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "pinned", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], resumedPinned.io), 0, resumedPinned.stderr());
  assert.match(resumedPinned.stdout(), /resuming pinned workload=cli-finite/);
  assert.match(resumedPinned.stdout(), /complete: 1\/1 pinned-concurrent waves/);

  const baseline = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "baseline", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], baseline.io), 0, baseline.stderr());
  const groups = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "groups", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], groups.io), 0, groups.stderr());
  const exact = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir), ...selection, "--yes",
  ], exact.io), 0, exact.stderr());
  bundle = await readSchema3Bundle({ resolved, bundleDir });
  assert.equal(bundle.baseline.progress.complete, true);
  assert.equal(bundle.groups.progress.complete, true);
  assert.equal(bundle.pinnedConcurrent.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, true);
});

test("the public controlled-load command completes v5 and exact resumes its sibling phase", {
  timeout: 30_000,
}, async () => {
  const directory = temporaryDirectory();
  const measuredFile = customWorkload(directory);
  const conditionFile = conditionWorkload(directory);
  const plan = controlledLoadPlan(directory);
  const bundleDir = path.join(directory, "controlled-load-bundle");
  const measuredArgs = ["--workload-file", path.basename(measuredFile)];
  const conditionArgs = ["--condition-workload-file", path.basename(conditionFile)];
  const controlled = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "controlled-load", ...measuredArgs, ...conditionArgs,
    "--plan-file", path.basename(plan), "--out-dir", path.basename(bundleDir), "--yes",
  ], controlled.io), 0, controlled.stderr());
  assert.match(controlled.stdout(), /session 1\/1 protocol=A1\/B\/A2/);
  assert.match(controlled.stdout(),
    /committed controlled-load session a1:pass:1 b:pass:1 a2:pass:1/);
  assert.match(controlled.stdout(), /complete: 1\/1 controlled-load sessions/);

  const resolved = resolveCustomWorkloadFile(measuredFile).resolved;
  const auxiliary = resolveCustomWorkloadFile(conditionFile).resolved;
  let bundle = await readSchema3Bundle({ resolved, auxiliary, bundleDir });
  assert.equal(bundle.manifest.version, 5);
  assert.equal(bundle.controlledLoad.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, false);

  const resumed = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "controlled-load", "--resume", path.basename(bundleDir),
    ...measuredArgs, ...conditionArgs, "--yes",
  ], resumed.io), 0, resumed.stderr());
  assert.match(resumed.stdout(), /resuming controlled-load measured=cli-finite condition=cli-condition/);
  assert.match(resumed.stdout(), /complete: 1\/1 controlled-load sessions/);

  const missingCondition = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir), ...measuredArgs, "--yes",
  ], missingCondition.io), 2);
  assert.match(missingCondition.stderr(), /require the resolved auxiliary workload/);

  const exact = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "exact", "--resume", path.basename(bundleDir),
    ...measuredArgs, ...conditionArgs, "--yes",
  ], exact.io), 0, exact.stderr());
  assert.match(exact.stdout(), /complete: 1\/1 exact-CPU attempts/);
  bundle = await readSchema3Bundle({ resolved, auxiliary, bundleDir });
  assert.equal(bundle.controlledLoad.progress.complete, true);
  assert.equal(bundle.exactCpu.progress.complete, true);

  const summarized = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "summarize", "--bundle-dir", path.basename(bundleDir),
    ...measuredArgs, ...conditionArgs,
  ], summarized.io), 0, summarized.stderr());
  assert.match(summarized.stdout(), /condition workload: cli-condition/);
  assert.match(summarized.stdout(), /controlled-load: complete; 1\/1 sessions/);
  assert.match(summarized.stdout(), /leg b condition=with-load attempts=1/);
  assert.match(summarized.stdout(), /exact-CPU: complete; 1\/1 attempts/);
});

test("controlled-load rejects a finite condition workload before creating output", async () => {
  const directory = temporaryDirectory();
  const measured = customWorkload(directory);
  const condition = conditionWorkload(directory, {
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 50, killGraceMs: 500 },
  });
  const plan = controlledLoadPlan(directory);
  const output = path.join(directory, "bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "controlled-load", "--workload-file", path.basename(measured),
    "--condition-workload-file", path.basename(condition),
    "--plan-file", path.basename(plan), "--out-dir", path.basename(output), "--yes",
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /must use survive-window lifecycle semantics/);
  assert.equal(existsSync(output), false);
});

test("baseline planning requires both baseline and exact capabilities", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory, { capabilities: { isolated: true } });
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "baseline", "--workload-file", path.basename(definition),
    "--children", "1", "--waves", "1", "--exact-cpus", String(allowedCpu()),
    "--out-dir", "bundle", "--dry-run",
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /does not declare baseline capability/);
});

test("group planning requires baseline, group, and exact capabilities", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory, {
    capabilities: { baseline: true, isolated: true },
  });
  const plan = groupPlan(directory);
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "groups", "--workload-file", path.basename(definition),
    "--plan-file", path.basename(plan), "--out-dir", "bundle", "--dry-run",
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /required group-suite capabilities: groups/);
});

test("pinned planning requires all four v4 capabilities", async () => {
  const directory = temporaryDirectory();
  const definition = customWorkload(directory, {
    capabilities: { baseline: true, groups: true, isolated: true },
  });
  const plan = pinnedPlan(directory);
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "pinned", "--workload-file", path.basename(definition),
    "--plan-file", path.basename(plan), "--out-dir", "bundle", "--dry-run",
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /required pinned-suite capabilities: pinnedConcurrent/);
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
