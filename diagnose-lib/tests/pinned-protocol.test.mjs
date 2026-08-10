import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";

import {
  ISOLATED_PLAN_HEADER,
  PinnedProtocolStateError,
  buildIsolatedPlan,
  buildPinnedConcurrentPlan,
  canonicalProtocolJsonLine,
  createFileStateAdapter,
  finalizeConcurrentProtocol,
  finalizeIsolatedProtocol,
  protocolFileBinding,
  readConcurrentProgress,
  readIsolatedProgress,
  runConcurrentWave,
  runIsolatedAttempt,
  runPinnedProtocolCli,
  sha256ProtocolBytes,
} from "../pinned-protocol.mjs";
import {
  PINNED_CONCURRENT_PLAN_HEADER,
  PINNED_CONCURRENT_RESULTS_HEADER,
} from "../pinned-concurrent-evidence.mjs";

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "pinned-protocol-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function memoryAdapter(initial = new Map()) {
  const files = new Map([...initial].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const commits = [];
  return {
    files,
    commits,
    list() { return [...files.keys()]; },
    read(name) {
      if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(files.get(name));
    },
    commit(name, bytes) {
      if (files.has(name)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      const retained = Buffer.from(bytes);
      files.set(name, retained);
      commits.push({ name, bytes: retained });
    },
  };
}

function cloneMemoryAdapter(adapter) {
  return memoryAdapter(adapter.files);
}

function noTurbo(value = 0) {
  return { status: "observed", value, errorCode: null };
}

function unavailableNoTurbo(code = "ENOENT") {
  return { status: "unavailable", value: null, errorCode: code };
}

function childResult(cpu, options = {}) {
  const startEpochMs = options.startEpochMs ?? 1_800_000_000_000;
  const startMonotonicNs = BigInt(options.startMonotonicNs ?? 5_000_000_000n);
  const durationNs = BigInt(options.durationNs ?? 2_250_000_000n);
  const sigsegv = options.sigsegv ?? false;
  return {
    version: 1,
    cpu,
    timing: {
      startEpochMs,
      endEpochMs: startEpochMs + Number(durationNs / 1_000_000n),
      startMonotonicNs: startMonotonicNs.toString(),
      endMonotonicNs: (startMonotonicNs + durationNs).toString(),
      durationNs: durationNs.toString(),
      durationMs: Number(durationNs) / 1_000_000,
      elapsedSec: Number(durationNs / 1_000_000_000n),
    },
    noTurbo: {
      path: "/mock/no_turbo",
      start: options.noTurboStart ?? noTurbo(0),
      end: options.noTurboEnd ?? noTurbo(0),
    },
    exitCode: sigsegv ? 139 : 0,
    signal: null,
    outcome: sigsegv ? "sigsegv" : "pass",
    validOutcome: true,
    invalidReason: null,
    canceled: false,
    launchError: null,
  };
}

function invalidChildResult(cpu) {
  return {
    ...childResult(cpu),
    exitCode: 2,
    outcome: "invalid",
    validOutcome: false,
    invalidReason: "unexpected-exit",
  };
}

function sequentialRunner(sequence = []) {
  const calls = [];
  let index = 0;
  const runChild = async (request) => {
    calls.push(request);
    const configured = sequence[index] ?? {};
    const result = typeof configured === "function"
      ? await configured(request, index)
      : childResult(request.cpu, {
        startEpochMs: 1_800_000_000_000 + index * 10_000,
        startMonotonicNs: 5_000_000_000n + BigInt(index) * 10_000_000_000n,
        ...configured,
      });
    index += 1;
    return result;
  };
  return { runChild, calls };
}

function assertPositionBalanced(records, itemKey, positionKey, width) {
  const counts = new Map();
  for (const record of records) {
    const item = record[itemKey];
    const positions = counts.get(item) ?? Array(width).fill(0);
    positions[record[positionKey] - 1] += 1;
    counts.set(item, positions);
  }
  for (const positions of counts.values()) {
    assert.ok(Math.max(...positions) - Math.min(...positions) <= 1, positions.join(","));
  }
}

const GENERATION = "0123456789abcdef0123456789abcdef";
const CONTEXTS = [
  { group: "l2_a", kind: "l2-cluster", cpus: [8, 9, 10], cluster: "l2:8-10", controllerCpu: 0 },
  { group: "l2_b", kind: "l2-cluster", cpus: [10, 11, 12], cluster: "l2:10-12", controllerCpu: 1 },
  { group: "ecore", kind: "core-kind", cpus: [16, 17], cluster: "unknown", controllerCpu: 2 },
];

test("isolated plans are canonical, deterministic, and position-balanced", () => {
  const first = buildIsolatedPlan({ cpus: [8, 9, 10, 11, 12], rounds: 17, seed: 20260809 });
  const second = buildIsolatedPlan({ cpus: [8, 9, 10, 11, 12], rounds: 17, seed: 20260809 });
  const changed = buildIsolatedPlan({ cpus: [8, 9, 10, 11, 12], rounds: 17, seed: 20260810 });
  assert.deepEqual(first.records, second.records);
  assert.equal(first.tsv, second.tsv);
  assert.equal(first.planSha, second.planSha);
  assert.notDeepEqual(first.records, changed.records);
  assert.equal(first.tsv.split("\n")[0], ISOLATED_PLAN_HEADER);
  assert.deepEqual(first.records.map((record) => record.ordinal),
    Array.from({ length: 85 }, (_, index) => index + 1));
  assertPositionBalanced(first.records, "cpu", "position", 5);
  for (let round = 1; round <= 17; round += 1) {
    assert.deepEqual(
      first.records.filter((record) => record.round === round).map((record) => record.cpu).sort((a, b) => a - b),
      [8, 9, 10, 11, 12],
    );
  }
  for (const cpus of [[9, 8], [8, 8], [], [8, "9"]]) {
    assert.throws(() => buildIsolatedPlan({ cpus, rounds: 1, seed: 0 }));
  }
});

test("concurrent plans retain overlapping contexts and independently balance both positions", () => {
  const first = buildPinnedConcurrentPlan({ contexts: CONTEXTS, rounds: 11, seed: 99 });
  const second = buildPinnedConcurrentPlan({ contexts: CONTEXTS, rounds: 11, seed: 99 });
  assert.deepEqual(first.records, second.records);
  assert.equal(first.planSha, second.planSha);
  assert.equal(first.tsv.split("\n")[0], PINNED_CONCURRENT_PLAN_HEADER);
  assert.match(first.groupsTsv, /^group\tkind\tcpus\tcluster\tcontroller_cpu\trounds\n/);
  assert.ok(first.records.some((record) => record.group === "l2_a" && record.cpu === 10));
  assert.ok(first.records.some((record) => record.group === "l2_b" && record.cpu === 10));
  assertPositionBalanced(
    first.records.filter((record) => record.launchPosition === 1),
    "group",
    "groupPosition",
    CONTEXTS.length,
  );
  for (const context of CONTEXTS) {
    assertPositionBalanced(
      first.records.filter((record) => record.group === context.group),
      "cpu",
      "launchPosition",
      context.cpus.length,
    );
  }
  for (let round = 1; round <= 11; round += 1) {
    const groups = new Set(first.records
      .filter((record) => record.round === round)
      .map((record) => record.group));
    assert.deepEqual([...groups].sort(), CONTEXTS.map((context) => context.group).sort());
  }
});

test("concurrent contexts strictly exclude controllers and reject noncanonical identities", () => {
  const base = { contexts: CONTEXTS, rounds: 1, seed: 0 };
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], controllerCpu: 8 }],
  }), /controller/);
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], cpus: [9, 8] }],
  }), /strictly increasing/);
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], group: "Bad Group" }],
  }), /group is invalid/);
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [CONTEXTS[0], { ...CONTEXTS[1], group: CONTEXTS[0].group }],
  }), /duplicate context/);
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], unexpected: true }],
  }), /exactly/);

  const topologyPlan = buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], cluster: "topo:0:2" }],
  });
  assert.equal(topologyPlan.groupsRows[0].cluster, "topo:0:2");
  assert.throws(() => buildPinnedConcurrentPlan({
    ...base,
    contexts: [{ ...CONTEXTS[0], cluster: "topo:65536:2" }],
  }), /cluster is not canonical/);
});

test("isolated executor runs exactly the next record and never commits an invalid child", async () => {
  const plan = buildIsolatedPlan({ cpus: [8, 9], rounds: 2, seed: 7 });
  const adapter = memoryAdapter();
  const invalidRunner = sequentialRunner([
    (request) => invalidChildResult(request.cpu),
  ]);
  const rejected = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    runChild: invalidRunner.runChild,
  });
  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, "invalid-child-result");
  assert.deepEqual(invalidRunner.calls.map((call) => call.cpu), [plan.records[0].cpu]);
  assert.equal(adapter.files.size, 0);

  const validRunner = sequentialRunner();
  const committed = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    runChild: validRunner.runChild,
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.state.record.ordinal, 1);
  assert.equal(adapter.files.size, 1);
  const progress = await readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: adapter });
  assert.equal(progress.committedRecords, 1);
  assert.deepEqual(progress.nextRecord, plan.records[1]);
});

test("concurrent executor shares one abort signal and commits only a complete valid wave", async () => {
  const plan = buildPinnedConcurrentPlan({ contexts: CONTEXTS.slice(0, 2), rounds: 1, seed: 3 });
  const firstWave = plan.records.filter((record) =>
    record.round === plan.records[0].round && record.group === plan.records[0].group);
  const adapter = memoryAdapter();
  const runner = sequentialRunner(firstWave.map((_, index) => ({ sigsegv: index === 1 })));
  const committed = await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    runChild: runner.runChild,
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.committedRecords, firstWave.length);
  assert.deepEqual(runner.calls.map((call) => call.cpu), firstWave.map((record) => record.cpu));
  assert.equal(new Set(runner.calls.map((call) => call.signal)).size, 1);
  assert.equal(adapter.files.size, 1);
  const progress = await readConcurrentProgress({ plan, generation: GENERATION, stateAdapter: adapter });
  assert.equal(progress.committedRecords, firstWave.length);
  assert.equal(progress.committedWaves, 1);

  const [waveName, waveBytes] = [...adapter.files][0];
  const shortened = cloneMemoryAdapter(adapter);
  const shortenedState = JSON.parse(waveBytes.toString("utf8"));
  shortenedState.observations.pop();
  shortened.files.set(waveName, canonicalProtocolJsonLine(shortenedState));
  await assert.rejects(
    readConcurrentProgress({ plan, generation: GENERATION, stateAdapter: shortened }),
    /whole planned wave/,
  );
  const renamed = memoryAdapter(new Map([[
    waveName.replace(/^concurrent-[0-9]{9}-/, "concurrent-000000002-"),
    waveBytes,
  ]]));
  await assert.rejects(
    readConcurrentProgress({ plan, generation: GENERATION, stateAdapter: renamed }),
    /whole-wave plan prefix/,
  );

  const invalidAdapter = memoryAdapter();
  const invalidRunner = sequentialRunner(firstWave.map((_, index) =>
    index === 0 ? (request) => invalidChildResult(request.cpu) : {}));
  const invalid = await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateAdapter: invalidAdapter,
    runChild: invalidRunner.runChild,
  });
  assert.equal(invalid.committed, false);
  assert.equal(invalidAdapter.files.size, 0);
  assert.equal(invalidRunner.calls.length, firstWave.length);
  assert.equal(new Set(invalidRunner.calls.map((call) => call.signal)).size, 1);
});

test("resume accepts an interrupted prefix but rejects gaps, partials, duplicates, and tampering", async () => {
  const plan = buildIsolatedPlan({ cpus: [8, 9], rounds: 2, seed: 1 });
  const adapter = memoryAdapter();
  await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    runChild: sequentialRunner().runChild,
  });
  const interrupted = await readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: adapter });
  assert.equal(interrupted.complete, false);
  assert.equal(interrupted.committedRecords, 1);
  assert.equal(interrupted.nextRecord.ordinal, 2);

  const [name, bytes] = [...adapter.files][0];
  const gap = memoryAdapter(new Map([["isolated-000000002.json", bytes]]));
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: gap }),
    /contiguous plan prefix/,
  );
  const partial = cloneMemoryAdapter(adapter);
  partial.files.set(`.${name}.deadbeef.tmp`, Buffer.from("partial"));
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: partial }),
    /partial temporary/,
  );
  const duplicate = cloneMemoryAdapter(adapter);
  duplicate.list = () => [name, name];
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: duplicate }),
    /duplicate/,
  );
  const tampered = cloneMemoryAdapter(adapter);
  const state = JSON.parse(bytes.toString("utf8"));
  state.planSha = "f".repeat(64);
  tampered.files.set(name, canonicalProtocolJsonLine(state));
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: tampered }),
    /generation and plan digest/,
  );
  const noncanonical = cloneMemoryAdapter(adapter);
  noncanonical.files.set(name, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateAdapter: noncanonical }),
    /not canonical JSON/,
  );
});

test("isolated finalization is byte-stable and emits the exact V5 boundary field order", async () => {
  const plan = buildIsolatedPlan({ cpus: [8, 9], rounds: 1, seed: 4 });
  const adapter = memoryAdapter();
  const runner = sequentialRunner([
    { noTurboStart: noTurbo(0), noTurboEnd: unavailableNoTurbo(), sigsegv: false },
    { noTurboStart: noTurbo(0), noTurboEnd: noTurbo(0), sigsegv: true },
  ]);
  for (let index = 0; index < plan.records.length; index += 1) {
    const result = await runIsolatedAttempt({
      plan,
      generation: GENERATION,
      stateAdapter: adapter,
      runChild: runner.runChild,
    });
    assert.equal(result.committed, true);
  }
  const first = await finalizeIsolatedProtocol({ plan, generation: GENERATION, stateAdapter: adapter });
  const second = await finalizeIsolatedProtocol({ plan, generation: GENERATION, stateAdapter: adapter });
  assert.ok(first.results.equals(second.results));
  assert.ok(first.boundaries.equals(second.boundaries));
  assert.equal(first.results.toString("utf8"), plan.records.map((record, index) =>
    `${record.cpu}\t${record.round}\t${index === 1 ? 139 : 0}\t2\n`).join(""));
  const firstRecord = plan.records[0];
  assert.equal(first.boundaries.toString("utf8").split("\n")[0],
    `{"ordinal":1,"round":1,"position":${firstRecord.position},"cpu":${firstRecord.cpu},` +
    `"startUnixMs":1800000000000,"endUnixMs":1800000002250,` +
    `"startMonotonicNs":"5000000000","endMonotonicNs":"7250000000",` +
    `"durationNs":"2250000000","durationMs":2250,"noTurboStart":0,` +
    `"noTurboEnd":{"status":"unavailable","errorCode":"ENOENT"}}`);
  assert.equal(first.bindings.results.sha256, sha256ProtocolBytes(first.results));
  assert.deepEqual(first.bindings.boundaries,
    protocolFileBinding(first.boundaries, plan.records.length));
});

test("concurrent finalization emits evidence-schema rows and deterministic boundaries", async () => {
  const plan = buildPinnedConcurrentPlan({ contexts: CONTEXTS.slice(0, 2), rounds: 2, seed: 11 });
  const adapter = memoryAdapter();
  const runner = sequentialRunner(plan.records.map((_, index) => ({ sigsegv: index % 3 === 1 })));
  while (!(await readConcurrentProgress({ plan, generation: GENERATION, stateAdapter: adapter })).complete) {
    const result = await runConcurrentWave({
      plan,
      generation: GENERATION,
      stateAdapter: adapter,
      runChild: runner.runChild,
    });
    assert.equal(result.committed, true);
  }
  const first = await finalizeConcurrentProtocol({ plan, generation: GENERATION, stateAdapter: adapter });
  const second = await finalizeConcurrentProtocol({ plan, generation: GENERATION, stateAdapter: adapter });
  assert.ok(first.results.equals(second.results));
  assert.ok(first.boundaries.equals(second.boundaries));
  assert.equal(first.results.toString("utf8").split("\n")[0], PINNED_CONCURRENT_RESULTS_HEADER);
  assert.equal(first.results.toString("utf8").trimEnd().split("\n").length, plan.records.length + 1);
  const boundary = JSON.parse(first.boundaries.toString("utf8").split("\n")[0]);
  assert.deepEqual(Object.keys(boundary), [
    "ordinal", "round", "groupPosition", "group", "controllerCpu", "launchPosition", "cpu",
    "startUnixMs", "endUnixMs", "startMonotonicNs", "endMonotonicNs", "durationNs",
    "durationMs", "noTurboStart", "noTurboEnd",
  ]);
  assert.equal(first.bindings.results.sha256, sha256ProtocolBytes(first.results));
  assert.equal(first.bindings.plan.sha256, plan.planSha);
});

test("filesystem state adapter publishes private single-link files and never clobbers", async () => {
  const stateDir = path.join(temporaryDirectory(), "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const plan = buildIsolatedPlan({ cpus: [8], rounds: 1, seed: 0 });
  const result = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateDir,
    runChild: sequentialRunner().runChild,
  });
  assert.equal(result.committed, true);
  const file = path.join(stateDir, result.stateName);
  const stat = statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  const adapter = createFileStateAdapter(stateDir);
  const original = readFileSync(file, "utf8");
  await assert.rejects(
    Promise.resolve().then(() => adapter.commit(result.stateName, Buffer.from("replacement"))),
    /never overwrite/,
  );
  const extraLink = path.join(stateDir, "retained-second-link");
  linkSync(file, extraLink);
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateDir }),
    /safe bounded private state file/,
  );
  assert.equal(readFileSync(file, "utf8"), original);
});

test("CLI plan and mocked single-attempt commands are strict and workload-free", async () => {
  let stdoutText = "";
  let stderrText = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) { stdoutText += chunk.toString(); callback(); },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) { stderrText += chunk.toString(); callback(); },
  });
  const signalSource = new EventEmitter();
  const planned = await runPinnedProtocolCli([
    "plan-isolated", "--cpus", "8-9", "--rounds", "2", "--seed", "4",
  ], { stdout, stderr, signalSource });
  assert.equal(planned, 0, stderrText);
  assert.match(stdoutText, new RegExp(`^${ISOLATED_PLAN_HEADER}\\n`));

  stdoutText = "";
  stderrText = "";
  const stateDir = path.join(temporaryDirectory(), "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const calls = [];
  const attempted = await runPinnedProtocolCli([
    "attempt-isolated", "--cpus", "8-9", "--rounds", "2", "--seed", "4",
    "--generation", GENERATION, "--state-dir", stateDir,
    "--command", "/mock/node", "--arg", "/mock/child.mjs",
  ], {
    stdout,
    stderr,
    signalSource,
    runChild: async (request) => {
      calls.push(request);
      return childResult(request.cpu);
    },
  });
  assert.equal(attempted, 0, stderrText);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/mock/node");
  assert.deepEqual(calls[0].args, ["/mock/child.mjs"]);
  assert.equal(JSON.parse(stdoutText).committed, true);

  stdoutText = "";
  stderrText = "";
  const invalid = await runPinnedProtocolCli([
    "plan-isolated", "--cpus", "9,8", "--rounds", "1", "--seed", "0",
  ], { stdout, stderr, signalSource });
  assert.equal(invalid, 2);
  assert.match(stderrText, /strictly increasing/);
});
