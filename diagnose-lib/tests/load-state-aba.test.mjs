import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPhasePlan,
  chooseController,
  executePhasePlan,
  parseArgs,
  planLines,
  runGdbCapture,
  summarize,
} from "../../load-state-aba.mjs";
import { validateGdbEvidence } from "../gdb-evidence.mjs";

test("load A/B/A arguments resolve safe defaults", () => {
  const options = parseArgs([]);
  assert.equal(options.mode, "load-state");
  assert.equal(options.targetCpu, 19);
  assert.deepEqual(options.loadCpus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(options.runs, 20);
  assert.equal(options.loadWarmupSeconds, 0);
  assert.equal(options.gdbMaxRuns, 10);
  assert.equal(options.gdbMaxCaptures, 1);
  assert.equal(options.nodeA, null);
  assert.equal(options.nodeB, null);
  assert.equal(options.yes, false);
});

test("load A/B/A rejects overlap and conflicting execution flags", () => {
  assert.throws(
    () => parseArgs(["--target-cpu", "19", "--load-cpus", "18-20"]),
    /must not be in --load-cpus/,
  );
  assert.throws(
    () => parseArgs(["--yes", "--dry-run"]),
    /choose --yes or --dry-run/,
  );
});

test("mode selection is validated", () => {
  assert.equal(parseArgs(["--mode", "gdb"]).mode, "gdb");
  assert.throws(() => parseArgs(["--mode", "bogus"]), /--mode must be one of/);
  assert.throws(() => parseArgs(["--mode"]), /--mode requires a value/);
});

test("node-aba requires Node B and defaults Node A to --node-bin", () => {
  assert.throws(
    () => parseArgs(["--mode", "node-aba"]),
    /--mode node-aba requires --node-b PATH/,
  );
  const withDefaultA = parseArgs(["--mode", "node-aba", "--node-b", "/usr/bin/node"]);
  assert.equal(withDefaultA.nodeA, process.execPath);
  assert.equal(withDefaultA.nodeB, "/usr/bin/node");
  const withBinA = parseArgs([
    "--mode", "node-aba", "--node-bin", "/opt/node-a", "--node-b", "/opt/node-b",
  ]);
  assert.equal(withBinA.nodeA, "/opt/node-a");
  const withExplicitA = parseArgs([
    "--mode", "node-aba", "--node-a", "/opt/explicit-a", "--node-bin", "/opt/node-a",
    "--node-b", "/opt/node-b",
  ]);
  assert.equal(withExplicitA.nodeA, "/opt/explicit-a");
});

test("mode-specific options are rejected outside their mode", () => {
  assert.throws(
    () => parseArgs(["--gdb-max-runs", "3"]),
    /--gdb-max-runs is only valid with --mode gdb/,
  );
  assert.throws(
    () => parseArgs(["--gdb-max-captures", "2"]),
    /--gdb-max-captures is only valid with --mode gdb/,
  );
  assert.throws(
    () => parseArgs(["--node-b", "/usr/bin/node"]),
    /--node-b is only valid with --mode node-aba/,
  );
  assert.throws(
    () => parseArgs(["--node-a", "/usr/bin/node"]),
    /--node-a is only valid with --mode node-aba/,
  );
  assert.throws(
    () => parseArgs(["--mode", "gdb", "--runs", "5"]),
    /--runs is only valid with --mode load-state or --mode node-aba/,
  );
});

test("GDB bounds are canonical and limited", () => {
  const options = parseArgs(["--mode", "gdb", "--gdb-max-runs", "40", "--gdb-max-captures", "3"]);
  assert.equal(options.gdbMaxRuns, 40);
  assert.equal(options.gdbMaxCaptures, 3);
  for (const value of ["0", "4097", "01", "-1", "x"]) {
    assert.throws(() => parseArgs(["--mode", "gdb", "--gdb-max-runs", value]), /--gdb-max-runs/);
    assert.throws(
      () => parseArgs(["--mode", "gdb", "--gdb-max-captures", value]),
      /--gdb-max-captures/,
    );
  }
  const atLimit = parseArgs([
    "--mode", "gdb", "--gdb-max-runs", "4096", "--gdb-max-captures", "4096",
  ]);
  assert.equal(atLimit.gdbMaxRuns, 4096);
  assert.equal(atLimit.gdbMaxCaptures, 4096);
});

test("load warmup defaults differ per mode and stay overridable", () => {
  assert.equal(parseArgs([]).loadWarmupSeconds, 0);
  assert.equal(parseArgs(["--mode", "gdb"]).loadWarmupSeconds, 5);
  assert.equal(
    parseArgs(["--mode", "node-aba", "--node-b", "/usr/bin/node"]).loadWarmupSeconds,
    5,
  );
  assert.equal(parseArgs(["--load-warmup-seconds", "9"]).loadWarmupSeconds, 9);
  assert.equal(parseArgs(["--mode", "gdb", "--load-warmup-seconds", "0"]).loadWarmupSeconds, 0);
});

test("controller selection excludes target and load CPUs", () => {
  assert.equal(chooseController("auto", 19, [0, 1, 2], [0, 1, 2, 8, 19]), 8);
  assert.throws(
    () => chooseController(2, 19, [0, 1, 2], [0, 1, 2, 8, 19]),
    /outside target\/load sets/,
  );
});

test("summary keeps the three controlled legs separate", () => {
  const summary = summarize([
    { phase: "A1", outcome: "pass" },
    { phase: "B", outcome: "sigsegv" },
    { phase: "B", outcome: "pass" },
    { phase: "A2", outcome: "other_failure" },
  ]);
  assert.deepEqual(summary.map((item) => [
    item.phase,
    item.attempted,
    item.sigsegv,
    item.otherFailure,
  ]), [
    ["A1", 1, 0, 0],
    ["B", 2, 1, 0],
    ["A2", 1, 0, 1],
  ]);
});

test("summary carries mode-specific phase descriptions", () => {
  const summary = summarize(
    [{ phase: "B", outcome: "sigsegv" }],
    [["A1", "Node A first"], ["B", "Node B middle"], ["A2", "Node A repeat"]],
  );
  assert.deepEqual(
    summary.map((item) => [item.phase, item.description, item.attempted, item.sigsegv]),
    [["A1", "Node A first", 0, 0], ["B", "Node B middle", 1, 1], ["A2", "Node A repeat", 0, 0]],
  );
});

test("phase plans match each mode's experimental design", () => {
  const loadState = buildPhasePlan(parseArgs([])).map((step) => step.type);
  assert.deepEqual(loadState, [
    "settle", "leg", "load-start", "load-warmup", "leg", "load-stop", "settle", "leg",
  ]);
  const gdb = buildPhasePlan(parseArgs(["--mode", "gdb"])).map((step) => step.type);
  assert.deepEqual(gdb, ["settle", "load-start", "load-warmup", "gdb", "load-stop"]);
  const nodeAba = buildPhasePlan(
    parseArgs(["--mode", "node-aba", "--node-b", "/usr/bin/node"]),
  );
  assert.deepEqual(
    nodeAba.map((step) => [step.type, step.phase ?? null, step.nodeLabel ?? null]),
    [
      ["settle", null, null],
      ["load-start", null, null],
      ["load-warmup", null, null],
      ["leg", "A1", "A"],
      ["leg", "B", "B"],
      ["leg", "A2", "A"],
      ["load-stop", null, null],
    ],
  );
  // Exactly one load bracket surrounds every node-aba leg.
  assert.equal(nodeAba.filter((step) => step.type === "load-start").length, 1);
  assert.equal(nodeAba.filter((step) => step.type === "load-stop").length, 1);
});

function recordingHooks(calls, { interruptAfter = Number.POSITIVE_INFINITY } = {}) {
  return {
    isInterrupted: () => calls.length >= interruptAfter,
    settle: async (step) => { calls.push(`settle:${step.seconds}`); },
    startLoad: async () => { calls.push("load-start"); },
    warmup: async (step) => { calls.push(`warmup:${step.seconds}`); },
    runLeg: async (step) => {
      calls.push(`leg:${step.phase}:${step.nodeLabel}`);
      return [{ phase: step.phase, outcome: "pass" }];
    },
    stopLoad: async () => { calls.push("load-stop"); },
    gdbCapture: async () => {
      calls.push("gdb");
      return { outcome: "captured" };
    },
  };
}

test("load-state execution preserves the A1/load/A2 ordering", async () => {
  const calls = [];
  const { rows, gdbResult } = await executePhasePlan(
    buildPhasePlan(parseArgs([])),
    recordingHooks(calls),
  );
  assert.deepEqual(calls, [
    "settle:15", "leg:A1:target", "load-start", "warmup:0",
    "leg:B:target", "load-stop", "settle:15", "leg:A2:target",
  ]);
  assert.equal(rows.length, 3);
  assert.equal(gdbResult, null);
});

test("constant-load node A/B/A never stops or restarts workers between legs", async () => {
  const calls = [];
  const { rows, gdbResult } = await executePhasePlan(
    buildPhasePlan(parseArgs(["--mode", "node-aba", "--node-b", "/usr/bin/node"])),
    recordingHooks(calls),
  );
  assert.deepEqual(calls, [
    "settle:15", "load-start", "warmup:5",
    "leg:A1:A", "leg:B:B", "leg:A2:A", "load-stop",
  ]);
  // The load stops exactly once, strictly after the final leg.
  assert.ok(calls.indexOf("load-stop") > calls.lastIndexOf("leg:A2:A"));
  assert.equal(calls.filter((call) => call === "load-start").length, 1);
  assert.equal(calls.filter((call) => call === "load-stop").length, 1);
  assert.equal(rows.length, 3);
  assert.equal(gdbResult, null);
});

test("gdb execution captures once inside the constant-load bracket", async () => {
  const calls = [];
  const { rows, gdbResult } = await executePhasePlan(
    buildPhasePlan(parseArgs(["--mode", "gdb"])),
    recordingHooks(calls),
  );
  assert.deepEqual(calls, ["settle:15", "load-start", "warmup:5", "gdb", "load-stop"]);
  assert.equal(rows.length, 0);
  assert.deepEqual(gdbResult, { outcome: "captured" });
});

test("an interruption skips every remaining phase", async () => {
  const calls = [];
  const { rows } = await executePhasePlan(
    buildPhasePlan(parseArgs([])),
    recordingHooks(calls, { interruptAfter: 4 }),
  );
  assert.deepEqual(calls, ["settle:15", "leg:A1:target", "load-start", "warmup:0"]);
  assert.equal(rows.length, 1);
});

test("dry-run plan lines cover all three modes", () => {
  const node = { node: "v25.2.1", v8: "14.1.146.11-node.14" };
  const loadState = planLines(parseArgs([]), 8, "/tmp/out", { node });
  assert.ok(loadState.includes("mode                 load-state"));
  assert.ok(loadState.includes("sequence             A1(no induced load) -> B(load) -> A2(recovered)"));
  assert.ok(loadState.includes("settle seconds       15 before A1 and A2"));
  assert.ok(loadState.includes("load warmup seconds  0"));
  assert.ok(loadState.includes("runs per leg         20"));

  const gdb = planLines(parseArgs(["--mode", "gdb"]), 8, "/tmp/out", {
    node,
    gdbVersion: "GNU gdb (GDB) 17.2",
  });
  assert.ok(gdb.includes("mode                 gdb"));
  assert.ok(gdb.includes("gdb max runs         10"));
  assert.ok(gdb.includes("gdb max captures     1"));
  assert.ok(gdb.includes("gdb version          GNU gdb (GDB) 17.2"));
  assert.ok(gdb.includes("load warmup seconds  5"));
  assert.ok(gdb.some((line) => line.includes("bounded GDB capture")));

  const nodeAba = planLines(
    parseArgs([
      "--mode", "node-aba",
      "--node-a", "/opt/node-a",
      "--node-b", "/opt/node-b",
    ]),
    8,
    "/tmp/out",
    {
      node,
      nodeA: { node: "v25.2.1", v8: "14.1" },
      nodeB: { node: "v26.7.0", v8: "14.6" },
    },
  );
  assert.ok(nodeAba.includes("mode                 node-aba"));
  assert.ok(
    nodeAba.includes("sequence             one constant load: A1(Node A) -> B(Node B) -> A2(Node A)"),
  );
  assert.ok(nodeAba.includes("node A               v25.2.1 V8 14.1 (/opt/node-a)"));
  assert.ok(nodeAba.includes("node B               v26.7.0 V8 14.6 (/opt/node-b)"));
  assert.ok(nodeAba.includes("load warmup seconds  5"));
});

const FAKE_CAPTURE_SCRIPT = `#!/usr/bin/env bash
set -u
cpu="$1"; max_runs="$2"; max_captures="$3"; out_dir="$4"; generation="$5"; node_bin="\${6:-}"
printf '%s\\n' "$*" > "$FAKE_CAPTURE_ARGS"
mode="\${FAKE_CAPTURE_MODE:-captured}"
case "$mode" in
  captured)
    {
      printf 'GDB_TRANSCRIPT\\tVERSION\\t1\\tGENERATION\\t%s\\tCPU\\t%s\\tMAX_RUNS\\t%s\\tMAX_CAPTURES\\t%s\\tRUN\\t1\\tOUTCOME\\tcaptured\\n' \\
        "$generation" "$cpu" "$max_runs" "$max_captures"
      printf 'Program received signal SIGSEGV, Segmentation fault.\\n'
      printf 'GDB_TRANSCRIPT_END\\tGENERATION\\t%s\\tCPU\\t%s\\tRUN\\t1\\tOUTCOME\\tcaptured\\n' \\
        "$generation" "$cpu"
    } > "$out_dir/cpu\${cpu}-run1.txt"
    printf 'ATTEMPT\\tGENERATION\\t%s\\tCPU\\t%s\\tMAX_RUNS\\t%s\\tMAX_CAPTURES\\t%s\\tRUN\\t1\\tOUTCOME\\tcaptured\\n' \\
      "$generation" "$cpu" "$max_runs" "$max_captures"
    printf 'COUNTS\\tGENERATION\\t%s\\tCPU\\t%s\\tMAX_RUNS\\t%s\\tMAX_CAPTURES\\t%s\\tATTEMPTED\\t1\\tCLEAN\\t0\\tCAPTURED\\t1\\tERRORS\\t0\\tEXIT_CODE\\t0\\n' \\
      "$generation" "$cpu" "$max_runs" "$max_captures"
    exit 0
    ;;
  no-fault)
    run=1
    while ((run <= max_runs)); do
      printf 'ATTEMPT\\tGENERATION\\t%s\\tCPU\\t%s\\tMAX_RUNS\\t%s\\tMAX_CAPTURES\\t%s\\tRUN\\t%s\\tOUTCOME\\tclean\\n' \\
        "$generation" "$cpu" "$max_runs" "$max_captures" "$run"
      run=$((run + 1))
    done
    printf 'COUNTS\\tGENERATION\\t%s\\tCPU\\t%s\\tMAX_RUNS\\t%s\\tMAX_CAPTURES\\t%s\\tATTEMPTED\\t%s\\tCLEAN\\t%s\\tCAPTURED\\t0\\tERRORS\\t0\\tEXIT_CODE\\t3\\n' \\
      "$generation" "$cpu" "$max_runs" "$max_captures" "$max_runs" "$max_runs"
    exit 3
    ;;
  failure)
    exit 5
    ;;
esac
exit 90
`;

function gdbCaptureFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "load-gdb-capture-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const script = path.join(root, "fake-capture.sh");
  writeFileSync(script, FAKE_CAPTURE_SCRIPT, { mode: 0o600 });
  chmodSync(script, 0o700);
  const outDir = path.join(root, "bundle");
  const eventsPath = path.join(root, "events.jsonl");
  const argsPath = path.join(root, "capture.args");
  const options = {
    targetCpu: 3,
    gdbMaxRuns: 2,
    gdbMaxCaptures: 1,
    nodeBin: "/exact/node-under-test",
  };
  return { root, script, outDir, eventsPath, argsPath, options };
}

test("gdb capture publishes a validated generation-bound envelope", async (t) => {
  const { script, outDir, eventsPath, argsPath, options } = gdbCaptureFixture(t);
  process.env.FAKE_CAPTURE_ARGS = argsPath;
  process.env.FAKE_CAPTURE_MODE = "captured";
  t.after(() => {
    delete process.env.FAKE_CAPTURE_ARGS;
    delete process.env.FAKE_CAPTURE_MODE;
  });
  const result = await runGdbCapture(options, outDir, eventsPath, null, script);
  assert.equal(result.interrupted, false);
  assert.equal(result.outcome, "captured");
  assert.match(result.generation, /^[0-9a-f]{32}$/);
  assert.deepEqual(
    {
      exitCode: result.exitCode,
      attempted: result.attempted,
      clean: result.clean,
      captured: result.captured,
      errors: result.errors,
      maxRuns: result.maxRuns,
      maxCaptures: result.maxCaptures,
    },
    { exitCode: 0, attempted: 1, clean: 0, captured: 1, errors: 0, maxRuns: 2, maxCaptures: 1 },
  );
  // The exact runner arguments reached the capture script, including the
  // explicit target Node as the sixth argument.
  assert.equal(
    readFileSync(argsPath, "utf8").trim(),
    `3 2 1 ${path.join(outDir, "gdb")} ${result.generation} /exact/node-under-test`,
  );
  // Runner accounting stays canonical and generation-bound.
  const runnerLog = readFileSync(path.join(outDir, "logs", "gdb", "runner.log"), "utf8");
  assert.match(
    runnerLog,
    new RegExp(
      `^ATTEMPT\\tGENERATION\\t${result.generation}\\tCPU\\t3\\tMAX_RUNS\\t2\\tMAX_CAPTURES\\t1\\tRUN\\t1\\tOUTCOME\\tcaptured\\n` +
        `COUNTS\\tGENERATION\\t${result.generation}\\tCPU\\t3\\tMAX_RUNS\\t2\\tMAX_CAPTURES\\t1\\tATTEMPTED\\t1\\tCLEAN\\t0\\tCAPTURED\\t1\\tERRORS\\t0\\tEXIT_CODE\\t0\\n$`,
    ),
  );
  // The retained transcript is hashed into the result and the envelope.
  assert.equal(result.transcripts.length, 1);
  const transcriptPath = path.join(outDir, "gdb", "cpu3-run1.txt");
  const transcriptSha = createHash("sha256").update(readFileSync(transcriptPath)).digest("hex");
  assert.equal(result.transcripts[0].path, "gdb/cpu3-run1.txt");
  assert.equal(result.transcripts[0].sha256, transcriptSha);
  assert.equal(result.transcripts[0].outcome, "captured");
  // The evidence envelope is complete and validates against the expectations.
  assert.equal(
    readFileSync(path.join(outDir, "results", "gdb.meta"), "utf8"),
    "CPU=3\nMAX_RUNS=2\nEXIT_CODE=0\nATTEMPTED_RUNS=1\nCLEAN_RUNS=0\nCAPTURED_RUNS=1\nERROR_RUNS=0\n",
  );
  assert.ok(statSync(path.join(outDir, "results", "gdb.manifest")).isFile());
  assert.equal(statSync(path.join(outDir, "state", "phase-gdb.done")).size, 0);
  const validated = validateGdbEvidence(outDir, {
    markerMode: "complete",
    expectedCpu: 3,
    expectedMaxRuns: 2,
    expectedMaxCaptures: 1,
  });
  assert.equal(validated.ok, true, validated.reasons?.join("; "));
  assert.equal(validated.outcome, "captured");
  assert.equal(validated.probe, result.probe);
  // Capture boundaries are recorded as events.
  const events = readFileSync(eventsPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line).type);
  assert.deepEqual(events, ["gdb_capture_started", "gdb_capture_finished"]);
});

test("gdb no-fault within the bound is a valid experimental result", async (t) => {
  const { script, outDir, eventsPath, argsPath, options } = gdbCaptureFixture(t);
  process.env.FAKE_CAPTURE_ARGS = argsPath;
  process.env.FAKE_CAPTURE_MODE = "no-fault";
  t.after(() => {
    delete process.env.FAKE_CAPTURE_ARGS;
    delete process.env.FAKE_CAPTURE_MODE;
  });
  const result = await runGdbCapture(options, outDir, eventsPath, null, script);
  assert.equal(result.interrupted, false);
  assert.equal(result.outcome, "no-fault");
  assert.equal(result.exitCode, 3);
  assert.equal(result.attempted, 2);
  assert.equal(result.clean, 2);
  assert.equal(result.captured, 0);
  assert.deepEqual(result.transcripts, []);
  const validated = validateGdbEvidence(outDir, {
    markerMode: "complete",
    expectedCpu: 3,
    expectedMaxRuns: 2,
    expectedMaxCaptures: 1,
  });
  assert.equal(validated.ok, true, validated.reasons?.join("; "));
  assert.equal(validated.outcome, "no-fault");
});

test("gdb runner failure is an operational failure, never a result", async (t) => {
  const { script, outDir, eventsPath, argsPath, options } = gdbCaptureFixture(t);
  process.env.FAKE_CAPTURE_ARGS = argsPath;
  process.env.FAKE_CAPTURE_MODE = "failure";
  t.after(() => {
    delete process.env.FAKE_CAPTURE_ARGS;
    delete process.env.FAKE_CAPTURE_MODE;
  });
  await assert.rejects(
    () => runGdbCapture(options, outDir, eventsPath, null, script),
    /GDB capture runner failed operationally with exit code 5/,
  );
  assert.throws(() => statSync(path.join(outDir, "results", "gdb.manifest")), /ENOENT/);
});
