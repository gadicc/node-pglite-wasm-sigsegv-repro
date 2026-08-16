import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";

import {
  ISOLATED_PLAN_HEADER,
  ISOLATED_V2_RESULTS_HEADER,
  PINNED_PROTOCOL_STATE_V2_VERSION,
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
  PINNED_CONCURRENT_V2_RESULTS_HEADER,
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

function childResultV2(cpu, options = {}) {
  const base = childResult(cpu, options);
  const exitCode = Object.hasOwn(options, "exitCode") ? options.exitCode : 0;
  const signal = Object.hasOwn(options, "signal") ? options.signal : null;
  const outcome = options.outcome ?? (signal === "SIGSEGV"
    ? "sigsegv"
    : exitCode === 0
      ? "pass"
      : "other-workload-failure");
  const excerpt = Buffer.from(options.stderr ?? "", "utf8");
  return {
    ...base,
    version: 2,
    exitCode,
    signal,
    outcome,
    validOutcome: options.validOutcome ?? true,
    invalidReason: options.invalidReason ?? null,
    canceled: options.canceled ?? false,
    launchError: options.launchError ?? null,
    launchState: options.launchState ?? "launched",
    stderrEvidence: {
      sha256: sha256ProtocolBytes(excerpt),
      bytes: String(excerpt.length),
      excerptBase64: excerpt.toString("base64"),
      excerptBytes: excerpt.length,
      truncated: false,
    },
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

test("isolated V2 commits unexpected exits and non-SIGSEGV signals as descriptive outcomes", async () => {
  const plan = buildIsolatedPlan({ cpus: [8, 9], rounds: 1, seed: 7 });
  const adapter = memoryAdapter();
  const outcomes = [
    { exitCode: 1, signal: null, outcome: "other-workload-failure", stderr: "exit one\n" },
    { exitCode: null, signal: "SIGILL", outcome: "other-workload-failure", stderr: "illegal\n" },
  ];
  let index = 0;
  for (const configured of outcomes) {
    const result = await runIsolatedAttempt({
      plan,
      generation: GENERATION,
      stateAdapter: adapter,
      stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
      runChild: async (request) => childResultV2(request.cpu, configured),
    });
    assert.equal(result.committed, true);
    assert.equal(result.state.outcome, "other-workload-failure");
    assert.equal(result.state.record.ordinal, ++index);
  }
  const progress = await readIsolatedProgress({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  assert.equal(progress.complete, true);
  assert.equal(progress.committedRecords, 2);
  assert.deepEqual(progress.states.map(({ exitCode, signal }) => ({ exitCode, signal })), [
    { exitCode: 1, signal: null },
    { exitCode: null, signal: "SIGILL" },
  ]);
});

test("isolated V2 operational failures remain uncommitted, bounded, and retryable", async () => {
  const plan = buildIsolatedPlan({ cpus: [8], rounds: 1, seed: 0 });
  const cases = [
    childResultV2(8, {
      exitCode: null,
      signal: null,
      outcome: "operational-invalid",
      validOutcome: false,
      invalidReason: "launch-error",
      launchState: "failed",
      launchError: { code: "ENOENT", message: "missing launcher" },
    }),
    childResultV2(8, {
      exitCode: null,
      signal: "SIGTERM",
      outcome: "operational-invalid",
      validOutcome: false,
      invalidReason: "canceled",
      canceled: true,
    }),
    childResultV2(8, { noTurboStart: unavailableNoTurbo() }),
    { version: 2, cpu: 8, outcome: "other-workload-failure" },
  ];
  for (const child of cases) {
    const adapter = memoryAdapter();
    const rejected = await runIsolatedAttempt({
      plan,
      generation: GENERATION,
      stateAdapter: adapter,
      stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
      runChild: async () => child,
    });
    assert.equal(rejected.committed, false);
    assert.equal(rejected.reason, "operational-invalid");
    assert.equal(rejected.attempt.classification, "operational-invalid");
    assert.equal(rejected.attempt.record.ordinal, 1);
    assert.equal(adapter.files.size, 0);
  }

  const thrownAdapter = memoryAdapter();
  const thrown = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: thrownAdapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async () => { throw Object.assign(new Error("runner broke"), { code: "EIO" }); },
  });
  assert.equal(thrown.committed, false);
  assert.equal(thrown.reason, "operational-invalid");
  assert.equal(thrown.attempt.errorCode, "EIO");
  assert.equal(thrownAdapter.files.size, 0);

  const retried = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: thrownAdapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async (request) => childResultV2(request.cpu),
  });
  assert.equal(retried.committed, true);
  assert.equal(retried.state.record.ordinal, 1);
});

test("the active V5 schedule frontier advances under V2 after canonical exit 1 evidence", async () => {
  const plan = buildIsolatedPlan({
    cpus: Array.from({ length: 24 }, (_, cpu) => cpu),
    rounds: 400,
    seed: 131738620,
  });
  assert.deepEqual(plan.records[0], { ordinal: 1, round: 1, position: 1, cpu: 12 });
  assert.equal(plan.records[1].cpu, 22);
  const adapter = memoryAdapter();
  const result = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async (request) => childResultV2(request.cpu, {
      exitCode: 1,
      outcome: "other-workload-failure",
      stderr: "canonical unexpected failure\n",
    }),
  });
  assert.equal(result.committed, true);
  const resumed = await readIsolatedProgress({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  assert.equal(resumed.committedRecords, 1);
  assert.deepEqual(resumed.nextRecord, plan.records[1]);
});

test("isolated V2 resume rejects outcome, exact status, and stderr tampering", async () => {
  const plan = buildIsolatedPlan({ cpus: [8], rounds: 1, seed: 0 });
  const adapter = memoryAdapter();
  await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async (request) => childResultV2(request.cpu, {
      exitCode: 1,
      outcome: "other-workload-failure",
      stderr: "retained stderr",
    }),
  });
  const [name, bytes] = [...adapter.files][0];
  for (const mutate of [
    (state) => { state.outcome = "pass"; },
    (state) => { state.signal = "SIGABRT"; },
    (state) => { state.exitCode = null; state.signal = "SIGBANANA"; },
    (state) => { state.stderr.bytes = "999"; },
    (state) => {
      state.noTurbo.start = { status: "unavailable", value: null, errorCode: "ENOENT" };
    },
  ]) {
    const tampered = cloneMemoryAdapter(adapter);
    const state = JSON.parse(bytes.toString("utf8"));
    mutate(state);
    tampered.files.set(name, canonicalProtocolJsonLine(state));
    await assert.rejects(readIsolatedProgress({
      plan,
      generation: GENERATION,
      stateAdapter: tampered,
      stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    }), PinnedProtocolStateError);
  }
});

test("isolated V2 finalization preserves classifications and exact bounded evidence", async () => {
  const plan = buildIsolatedPlan({ cpus: [8, 9, 10], rounds: 1, seed: 4 });
  const adapter = memoryAdapter();
  const configured = [
    { exitCode: 0, signal: null, outcome: "pass" },
    { exitCode: null, signal: "SIGSEGV", outcome: "sigsegv" },
    { exitCode: null, signal: "SIGABRT", outcome: "other-workload-failure", stderr: "aborted\n" },
  ];
  for (const outcome of configured) {
    await runIsolatedAttempt({
      plan,
      generation: GENERATION,
      stateAdapter: adapter,
      stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
      runChild: async (request) => childResultV2(request.cpu, outcome),
    });
  }
  const first = await finalizeIsolatedProtocol({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  const second = await finalizeIsolatedProtocol({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  assert.ok(first.results.equals(second.results));
  assert.ok(first.boundaries.equals(second.boundaries));
  const lines = first.results.toString("utf8").trimEnd().split("\n");
  assert.equal(lines[0], ISOLATED_V2_RESULTS_HEADER);
  assert.deepEqual(lines.slice(1).map((line) => line.split("\t")[4]), [
    "pass", "sigsegv", "other-workload-failure",
  ]);
  assert.equal(lines[3].split("\t")[6], "SIGABRT");
  const boundary = JSON.parse(first.boundaries.toString("utf8").trimEnd().split("\n")[2]);
  assert.equal(boundary.outcome, "other-workload-failure");
  assert.equal(boundary.signal, "SIGABRT");
  assert.equal(Buffer.from(boundary.stderrExcerptBase64, "base64").toString(), "aborted\n");
  assert.equal(boundary.stderrSha256, sha256ProtocolBytes("aborted\n"));
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
  assert.equal(committed.complete, false);
  assert.equal(committed.nextControllerCpu, plan.records[firstWave.length].controllerCpu);
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

test("concurrent V2 resumes a V1 wave prefix and commits exact other workload outcomes", async () => {
  const plan = buildPinnedConcurrentPlan({ contexts: CONTEXTS.slice(0, 2), rounds: 1, seed: 3 });
  const adapter = memoryAdapter();
  const firstWave = plan.records.filter((record) => record.group === plan.records[0].group);
  const legacy = await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    runChild: sequentialRunner(firstWave.map((_, index) => ({ sigsegv: index === 1 }))).runChild,
  });
  assert.equal(legacy.committed, true);

  const migrated = await readConcurrentProgress({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  assert.equal(migrated.legacyWaves, 1);
  assert.equal(migrated.legacyRecords, firstWave.length);
  assert.equal(migrated.committedWaves, 1);

  let childIndex = 0;
  const exactRequests = [];
  const exact = await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async (request) => {
      exactRequests.push(request);
      const index = childIndex++;
      return childResultV2(request.cpu, index === 0
        ? { exitCode: 1, outcome: "other-workload-failure", stderr: "exit one\n" }
        : { exitCode: 0, outcome: "pass" });
    },
  });
  assert.equal(exact.committed, true);
  assert.equal(exact.state.version, PINNED_PROTOCOL_STATE_V2_VERSION);
  assert.equal(exact.complete, true);
  assert.equal(exact.nextControllerCpu, null);
  assert.ok(exactRequests.length > 0);
  assert.ok(exactRequests.every((request) => request.witnessCpu === exact.state.wave.controllerCpu));
  assert.ok(exactRequests.every((request) => request.witnessCpu !== request.cpu));
  assert.equal(exact.state.observations[0].outcome, "other-workload-failure");
  assert.equal(exact.state.observations[0].exitCode, 1);

  const finalized = await finalizeConcurrentProtocol({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  });
  assert.equal(finalized.legacyWaveCount, 1);
  assert.equal(finalized.legacyRowCount, firstWave.length);
  const rows = finalized.results.toString("utf8").trimEnd().split("\n");
  assert.equal(rows[0], PINNED_CONCURRENT_V2_RESULTS_HEADER);
  assert.equal(rows[1].split("\t")[7], "0");
  assert.equal(rows[firstWave.length + 1].split("\t")[4], "other-workload-failure");
  assert.equal(rows[firstWave.length + 1].split("\t")[5], "1");
  assert.equal(rows[firstWave.length + 1].split("\t")[7], "-");
  const boundaries = finalized.boundaries.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  assert.equal(boundaries[0].legacyRc, 0);
  assert.equal(boundaries[0].stderrSha256, null);
  assert.equal(boundaries[firstWave.length].outcome, "other-workload-failure");
  assert.equal(Buffer.from(boundaries[firstWave.length].stderrExcerptBase64, "base64").toString(), "exit one\n");

  const [v2Name, v2Bytes] = [...adapter.files].find(([, bytes]) =>
    JSON.parse(bytes.toString("utf8")).version === PINNED_PROTOCOL_STATE_V2_VERSION);
  const tampered = cloneMemoryAdapter(adapter);
  const state = JSON.parse(v2Bytes.toString("utf8"));
  state.observations[0].stderr.bytes = "999";
  tampered.files.set(v2Name, canonicalProtocolJsonLine(state));
  await assert.rejects(readConcurrentProgress({
    plan,
    generation: GENERATION,
    stateAdapter: tampered,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
  }), PinnedProtocolStateError);
});

test("concurrent V2 operational failures remain whole-wave uncommitted", async () => {
  const plan = buildPinnedConcurrentPlan({ contexts: CONTEXTS.slice(0, 1), rounds: 1, seed: 3 });
  const adapter = memoryAdapter();
  const rejected = await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateAdapter: adapter,
    stateVersion: PINNED_PROTOCOL_STATE_V2_VERSION,
    runChild: async (request) => childResultV2(request.cpu, {
      exitCode: null,
      signal: null,
      outcome: "operational-invalid",
      validOutcome: false,
      invalidReason: "launch-error",
      launchState: "failed",
      launchError: { code: "ENOENT", message: "missing launcher" },
    }),
  });
  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, "operational-invalid");
  assert.ok(rejected.attempts.length > 0);
  assert.equal(adapter.files.size, 0);
});

test("next-concurrent-v2 CLI exposes the migrated legacy frontier", async () => {
  const root = temporaryDirectory();
  const stateDir = path.join(root, "state");
  const contextsFile = path.join(root, "contexts.json");
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(contextsFile, `${JSON.stringify(CONTEXTS.slice(0, 2))}\n`, { mode: 0o600 });
  const plan = buildPinnedConcurrentPlan({ contexts: CONTEXTS.slice(0, 2), rounds: 1, seed: 3 });
  const firstWave = plan.records.filter((record) => record.group === plan.records[0].group);
  await runConcurrentWave({
    plan,
    generation: GENERATION,
    stateDir,
    runChild: sequentialRunner(firstWave.map(() => ({}))).runChild,
  });
  let stdoutText = "";
  let stderrText = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) { stdoutText += chunk.toString(); callback(); },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) { stderrText += chunk.toString(); callback(); },
  });
  const code = await runPinnedProtocolCli([
    "next-concurrent-v2",
    "--contexts-file", contextsFile,
    "--rounds", "1",
    "--seed", "3",
    "--generation", GENERATION,
    "--state-dir", stateDir,
  ], { stdout, stderr, signalSource: new EventEmitter() });
  assert.equal(code, 0, stderrText);
  const progress = JSON.parse(stdoutText);
  assert.equal(progress.legacyWaves, 1);
  assert.equal(progress.legacyRecords, firstWave.length);
  assert.equal(progress.committedWaves, 1);
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

test("filesystem state adapter reconciles interrupted private commit publications", async () => {
  const stateDir = path.join(temporaryDirectory(), "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const plan = buildIsolatedPlan({ cpus: [8, 9], rounds: 1, seed: 0 });
  const result = await runIsolatedAttempt({
    plan,
    generation: GENERATION,
    stateDir,
    runChild: sequentialRunner().runChild,
  });
  const firstFile = path.join(stateDir, result.stateName);
  const deadPid = "99999999";
  const linkedReady = path.join(
    stateDir,
    `.${result.stateName}.${deadPid}.0123456789abcdef.ready.tmp`,
  );
  linkSync(firstFile, linkedReady);
  assert.equal(statSync(firstFile).nlink, 2);

  let progress = await readIsolatedProgress({
    plan,
    generation: GENERATION,
    stateDir,
  });
  assert.equal(progress.committedRecords, 1);
  assert.equal(statSync(firstFile).nlink, 1);
  assert.equal(existsSync(linkedReady), false);

  const orphanWriting = path.join(
    stateDir,
    ".isolated-000000002.json.99999998.fedcba9876543210.writing.tmp",
  );
  writeFileSync(orphanWriting, "incomplete commit", { mode: 0o600 });
  progress = await readIsolatedProgress({
    plan,
    generation: GENERATION,
    stateDir,
  });
  assert.equal(progress.committedRecords, 1);
  assert.equal(existsSync(orphanWriting), false);
  assert.deepEqual(progress.nextRecord, plan.records[1]);

  const liveWriter = path.join(
    stateDir,
    `.isolated-000000002.json.${process.pid}.0011223344556677.writing.tmp`,
  );
  writeFileSync(liveWriter, "active commit", { mode: 0o600 });
  await assert.rejects(
    readIsolatedProgress({ plan, generation: GENERATION, stateDir }),
    /live writer/,
  );
  assert.equal(existsSync(liveWriter), true);
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
