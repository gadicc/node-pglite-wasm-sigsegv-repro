import {
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGdbAttemptArgs,
  publishGdbAttempt,
} from "../gdb-attempt-io.mjs";

const GENERATION = "a".repeat(32);
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gdb-attempt-io-test-"));
  roots.push(root);
  const output = path.join(root, "gdb");
  mkdirSync(output);
  return { root, output };
}

function values(overrides = {}) {
  const values = {
    generation: GENERATION,
    cpu: "7",
    maxRuns: "3",
    maxCaptures: "2",
    run: "1",
    ...overrides,
  };
  return {
    generation: values.generation,
    cpu: Number(values.cpu),
    maxRuns: Number(values.maxRuns),
    maxCaptures: Number(values.maxCaptures),
    run: Number(values.run),
  };
}

async function run(output, input, overrides = {}) {
  return publishGdbAttempt(output, values(overrides), [Buffer.from(input)]);
}

function transcript(output, runId = 1) {
  return readFileSync(path.join(output, `cpu7-run${runId}.txt`), "utf8");
}

test("captured and error output publish exact private provenance envelopes", async () => {
  const captured = fixture();
  const captureResult = await run(captured.output, "raw\nreceived signal SIGSEGV\nbacktrace\n");
  assert.equal(captureResult, "captured");
  assert.equal(statSync(path.join(captured.output, "cpu7-run1.txt")).mode & 0o777, 0o600);
  assert.match(
    transcript(captured.output),
    new RegExp(
      `^GDB_TRANSCRIPT\\tVERSION\\t1\\tGENERATION\\t${GENERATION}` +
      "\\tCPU\\t7\\tMAX_RUNS\\t3\\tMAX_CAPTURES\\t2\\tRUN\\t1\\tOUTCOME\\tcaptured\\n",
    ),
  );
  assert.match(
    transcript(captured.output),
    new RegExp(
      `GDB_TRANSCRIPT_END\\tGENERATION\\t${GENERATION}` +
      "\\tCPU\\t7\\tRUN\\t1\\tOUTCOME\\tcaptured\\n$",
    ),
  );
  assert.deepEqual(readdirSync(captured.output), ["cpu7-run1.txt"]);

  const errored = fixture();
  const errorResult = await run(errored.output, "gdb could not start");
  assert.equal(errorResult, "error");
  assert.match(transcript(errored.output), /gdb could not start\nGDB_TRANSCRIPT_END/);
  assert.doesNotMatch(transcript(errored.output), /OUTCOME\tcaptured/);
  assert.deepEqual(readdirSync(errored.output), ["cpu7-run1.txt"]);
});

test("clean output is classified without retaining its private spool", async () => {
  const clean = fixture();
  const result = await run(clean.output, "inferior exited normally\n");
  assert.equal(result, "clean");
  assert.deepEqual(readdirSync(clean.output), []);
});

test("capture classification takes precedence when both terminal phrases appear", async () => {
  const mixed = fixture();
  const result = await run(mixed.output, "received signal SIGSEGV\nexited normally\n");
  assert.equal(result, "captured");
  assert.match(transcript(mixed.output), /OUTCOME\tcaptured/);
});

test("preexisting destinations and unsafe output directories fail without overwrite", async () => {
  const occupied = fixture();
  const destination = path.join(occupied.output, "cpu7-run1.txt");
  writeFileSync(destination, "user data\n");
  await assert.rejects(run(occupied.output, "received signal SIGSEGV\n"));
  assert.equal(readFileSync(destination, "utf8"), "user data\n");
  assert.deepEqual(readdirSync(occupied.output), ["cpu7-run1.txt"]);

  const linked = fixture();
  const real = path.join(linked.root, "real-gdb");
  mkdirSync(real);
  rmSync(linked.output, { recursive: true });
  symlinkSync(real, linked.output);
  await assert.rejects(run(linked.output, "received signal SIGSEGV\n"));
  assert.deepEqual(readdirSync(real), []);
});

test("canonical bounded arguments are required", () => {
  for (const overrides of [
    { generation: "A".repeat(32) },
    { cpu: "01" },
    { maxRuns: "0" },
    { maxCaptures: "0" },
    { run: "4" },
  ]) {
    const args = [
      "/tmp/gdb",
      overrides.generation ?? GENERATION,
      overrides.cpu ?? "7",
      overrides.maxRuns ?? "3",
      overrides.maxCaptures ?? "2",
      overrides.run ?? "1",
    ];
    assert.equal(parseGdbAttemptArgs(args), null, JSON.stringify(overrides));
  }
});

test("argument parsing accepts a capture limit above the run limit", () => {
  for (const maxRuns of [1, 2]) {
    assert.deepEqual(
      parseGdbAttemptArgs(["/tmp/gdb", GENERATION, "7", String(maxRuns), "3", String(maxRuns)]),
      {
        directory: "/tmp/gdb",
        generation: GENERATION,
        cpu: 7,
        maxRuns,
        maxCaptures: 3,
        run: maxRuns,
      },
    );
  }
});

function openDescriptorCount() {
  return readdirSync("/proc/self/fd").length;
}

test("post-open failures close their new descriptors", async () => {
  const forcedFstat = fixture();
  const beforeFstat = openDescriptorCount();
  let fstatCalls = 0;
  await assert.rejects(
    publishGdbAttempt(forcedFstat.output, values(), [Buffer.from("x\n")], {
      fstatSync(fd, options) {
        fstatCalls += 1;
        if (fstatCalls === 1) throw new Error("forced fstat failure");
        return fstatSync(fd, options);
      },
    }),
    /forced fstat failure/,
  );
  assert.equal(openDescriptorCount(), beforeFstat);

  const forcedLstat = fixture();
  const beforeLstat = openDescriptorCount();
  let lstatCalls = 0;
  await assert.rejects(
    publishGdbAttempt(forcedLstat.output, values(), [Buffer.from("x\n")], {
      lstatSync(anchor, options) {
        lstatCalls += 1;
        if (lstatCalls === 2) throw new Error("forced lstat failure");
        return lstatSync(anchor, options);
      },
    }),
    /forced lstat failure/,
  );
  assert.equal(openDescriptorCount(), beforeLstat);

  const forcedChmod = fixture();
  const beforeChmod = openDescriptorCount();
  let chmodCalls = 0;
  await assert.rejects(
    publishGdbAttempt(forcedChmod.output, values(), [Buffer.from("x\n")], {
      fchmodSync(fd, mode) {
        chmodCalls += 1;
        if (chmodCalls === 1) throw new Error("forced chmod failure");
        return fchmodSync(fd, mode);
      },
    }),
    /forced chmod failure/,
  );
  assert.equal(openDescriptorCount(), beforeChmod);
  assert.deepEqual(readdirSync(forcedChmod.output), [`.gdb-attempt.${GENERATION}.1.tmp`]);
});

test("overflow stops the input and publishes a bounded truncated error transcript", async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  const total = 66;

  const counted = fixture();
  let yielded = 0;
  let returned = false;
  const countedInput = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          yielded += 1;
          if (yielded > total) return Promise.resolve({ done: true });
          const value = yielded === 1
            ? Buffer.concat([Buffer.from("received signal SIGSEGV\n"), chunk])
              .subarray(0, chunk.length)
            : chunk;
          return Promise.resolve({ done: false, value });
        },
        return() {
          returned = true;
          return Promise.resolve({ done: true });
        },
      };
    },
  };
  const countedResult = await publishGdbAttempt(counted.output, values(), countedInput);
  assert.equal(countedResult, "overflow");
  assert.ok(returned, "the input iterator is closed at the first overflow");
  assert.ok(yielded < total, `input is not drained to completion (${yielded} of ${total} chunks)`);
  const text = transcript(counted.output);
  assert.match(text, /\tOUTCOME\terror\n/);
  assert.doesNotMatch(text, /OUTCOME\tcaptured/);
  assert.match(text, /\[gdb output truncated at the evidence size limit\]\nGDB_TRANSCRIPT_END/);
  assert.ok(statSync(path.join(counted.output, "cpu7-run1.txt")).size <= 64 * 1024 * 1024);
  assert.deepEqual(readdirSync(counted.output), ["cpu7-run1.txt"]);

  const streamed = fixture();
  const stream = Readable.from((async function* () {
    while (true) yield chunk;
  })());
  const streamedResult = await publishGdbAttempt(streamed.output, values(), stream);
  assert.equal(streamedResult, "overflow");
  assert.ok(stream.destroyed, "a stream input is destroyed at the first overflow");
});

test("spool replacement before cleanup fails the attempt and preserves the impostor", async () => {
  const { output } = fixture();
  const spoolName = `.gdb-attempt.${GENERATION}.1.tmp`;
  const spoolPath = path.join(output, spoolName);
  let swapped = false;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (swapped) return Promise.resolve({ done: true });
          swapped = true;
          rmSync(spoolPath);
          writeFileSync(spoolPath, "impostor\n");
          return Promise.resolve({ done: false, value: Buffer.from("inferior exited normally\n") });
        },
      };
    },
  };
  await assert.rejects(publishGdbAttempt(output, values(), input), /changed before its removal/);
  assert.equal(readFileSync(spoolPath, "utf8"), "impostor\n");
  assert.deepEqual(readdirSync(output), [spoolName]);
});

test("spool unlink failure turns a would-be captured success into a failure", async () => {
  const { output } = fixture();
  const spoolName = `.gdb-attempt.${GENERATION}.1.tmp`;
  let unlinks = 0;
  await assert.rejects(
    publishGdbAttempt(output, values(), [Buffer.from("received signal SIGSEGV\n")], {
      unlinkSync(anchor) {
        unlinks += 1;
        throw new Error("forced unlink failure");
      },
    }),
    /forced unlink failure/,
  );
  assert.ok(unlinks >= 1);
  assert.deepEqual(readdirSync(output).sort(), ["cpu7-run1.txt", spoolName].sort());
});

test("successful spool cleanup fsyncs the directory and verifies absence", async () => {
  const { output } = fixture();
  const spoolName = `.gdb-attempt.${GENERATION}.1.tmp`;
  const events = [];
  const result = await publishGdbAttempt(output, values(), [Buffer.from("exited normally\n")], {
    lstatSync(anchor, options) {
      if (String(anchor).endsWith(spoolName)) events.push("lstat");
      return lstatSync(anchor, options);
    },
    unlinkSync(anchor) {
      if (String(anchor).endsWith(spoolName)) events.push("unlink");
      return unlinkSync(anchor);
    },
    fsyncSync(fd) {
      events.push("fsync");
      return fsyncSync(fd);
    },
  });
  assert.equal(result, "clean");
  assert.deepEqual(readdirSync(output), []);
  assert.deepEqual(events.slice(-3), ["unlink", "fsync", "lstat"]);
  assert.equal(events.filter((event) => event === "fsync").length, 1);
});
