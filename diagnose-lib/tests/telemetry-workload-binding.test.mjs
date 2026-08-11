import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import {
  TELEMETRY_GROUP_LOG_MAX_BYTES,
  TELEMETRY_WORKLOAD_BINDING_FORMAT,
  TELEMETRY_WORKLOAD_FILE_MAX_BYTES,
  TelemetryWorkloadBindingError,
  computeTelemetryWorkloadBinding,
  runTelemetryWorkloadBindingCli,
  serializeTelemetryWorkloadBindingPreimage,
} from "../telemetry-workload-binding.mjs";

const GENERATION = "0123456789abcdef0123456789abcdef";
const BOUNDARIES_SHA256 = "ab".repeat(32);
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = "telemetry-workload-binding-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixture(phase) {
  const root = temporaryDirectory();
  mkdirSync(path.join(root, "results"));
  if (phase === "baseline") {
    mkdirSync(path.join(root, "logs", "baseline"), { recursive: true });
    writeFileSync(
      path.join(root, "results", "baseline.meta"),
      "CHILDREN=4\nWAVES=5\nLOG=logs/baseline/run1.log\nEXIT_CODE=1\n",
    );
    writeFileSync(path.join(root, "logs", "baseline", "run1.log"), "wave 1 failed\n");
  } else if (phase === "groups") {
    mkdirSync(path.join(root, "logs", "groups"), { recursive: true });
    writeFileSync(
      path.join(root, "results", "groups.meta"),
      `VERSION=2\nGENERATION=${GENERATION}\nEXPECTED_ROWS=1\n` +
        `GROUP_WAVES=5\nPLAN_DIGEST=${"cd".repeat(32)}\nCOMPLETED=1\n`,
    );
    writeFileSync(
      path.join(root, "results", "groups.tsv"),
      "all-cpus\tuniform\t0-3\t-\t4\t5\tlogs/groups/all-cpus.log\tgroup-all-cpus\t1\n",
    );
    writeFileSync(path.join(root, "logs", "groups", "all-cpus.log"), "wave 1 failed\n");
  } else if (phase === "individual") {
    writeFileSync(
      path.join(root, "results", "individual.meta"),
      `VERSION=5\nGENERATION=${GENERATION}\nBOUNDARIES_SHA256=${BOUNDARIES_SHA256}\n` +
        "BOUNDARY_ROW_COUNT=12\nCOMPLETED=1\n",
    );
  } else if (phase === "pinned-concurrent") {
    writeFileSync(
      path.join(root, "results", "pinned-concurrent.meta"),
      `VERSION=1\nGENERATION=${GENERATION}\nBOUNDARIES_SHA256=${BOUNDARIES_SHA256}\n` +
        "BOUNDARY_ROW_COUNT=24\nCOMPLETED=1\n",
    );
  } else if (phase === "gdb") {
    writeFileSync(
      path.join(root, "results", "gdb.manifest"),
      `VERSION\t1\nGENERATION\t${GENERATION}\nSTATUS\tSKIPPED\n`,
    );
  } else {
    throw new Error(`unsupported fixture phase: ${phase}`);
  }
  return root;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replace(file, expression, replacement) {
  const before = readFileSync(file, "utf8");
  if (typeof expression === "string") assert.ok(before.includes(expression));
  else assert.match(before, expression);
  writeFileSync(file, before.replace(expression, replacement));
}

function captureCli(argv) {
  let stdout = "";
  let stderr = "";
  const status = runTelemetryWorkloadBindingCli(argv, {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { status, stdout, stderr };
}

test("all workload phases produce canonical, phase-separated bindings", () => {
  const expected = {
    baseline: { generation: "-", files: ["results/baseline.meta", "logs/baseline/run1.log"] },
    groups: {
      generation: GENERATION,
      files: ["results/groups.meta", "results/groups.tsv", "logs/groups/all-cpus.log"],
    },
    individual: { generation: GENERATION, files: ["results/individual.meta"], rows: 12 },
    "pinned-concurrent": {
      generation: GENERATION,
      files: ["results/pinned-concurrent.meta"],
      rows: 24,
    },
    gdb: { generation: GENERATION, files: ["results/gdb.manifest"] },
  };

  for (const [phase, phaseExpected] of Object.entries(expected)) {
    const root = writeFixture(phase);
    const result = computeTelemetryWorkloadBinding(phase, root);
    assert.equal(result.version, 1);
    assert.equal(result.format, TELEMETRY_WORKLOAD_BINDING_FORMAT);
    assert.equal(result.phase, phase);
    assert.equal(result.workloadGeneration, phaseExpected.generation);
    assert.deepEqual(result.files.map((file) => file.path), phaseExpected.files);
    for (const file of result.files) {
      const bytes = readFileSync(path.join(root, ...file.path.split("/")));
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, sha256(bytes));
    }
    const preimage = serializeTelemetryWorkloadBindingPreimage(phase, result.files);
    assert.equal(result.workloadBindingSha256, sha256(Buffer.from(preimage, "utf8")));
    if (phaseExpected.rows !== undefined) {
      assert.equal(result.workloadBoundariesSha256, BOUNDARIES_SHA256);
      assert.equal(result.workloadBoundaryRowCount, phaseExpected.rows);
    } else {
      assert.equal(Object.hasOwn(result, "workloadBoundariesSha256"), false);
      assert.equal(Object.hasOwn(result, "workloadBoundaryRowCount"), false);
    }
  }
});

test("the documented preimage binds the version, phase, path, byte count, and digest", () => {
  const root = writeFixture("individual");
  const result = computeTelemetryWorkloadBinding("individual", root);
  assert.equal(
    serializeTelemetryWorkloadBindingPreimage("individual", result.files),
    `${TELEMETRY_WORKLOAD_BINDING_FORMAT}\n` +
      "PHASE\tindividual\n" +
      `FILE\tresults/individual.meta\t${result.files[0].bytes}\t${result.files[0].sha256}\n`,
  );

  const before = result.workloadBindingSha256;
  const meta = path.join(root, "results", "individual.meta");
  replace(meta, /COMPLETED=1/, "COMPLETED=0");
  const after = computeTelemetryWorkloadBinding("individual", root);
  assert.notEqual(after.workloadBindingSha256, before);
  assert.equal(after.workloadGeneration, result.workloadGeneration);
});

test("groups bindings cover outcome-bearing logs in canonical path order", () => {
  const root = writeFixture("groups");
  writeFileSync(
    path.join(root, "results", "groups.tsv"),
    "z-group\tuniform\t0-3\t-\t4\t5\tlogs/groups/z-group.log\tgroup-z-group\t1\n" +
      "a-group\tuniform\t0-3\t-\t4\t5\tlogs/groups/a-group.log\tgroup-a-group\t1\n",
  );
  writeFileSync(path.join(root, "logs", "groups", "z-group.log"), "all waves passed\n");
  writeFileSync(path.join(root, "logs", "groups", "a-group.log"), "one SIGSEGV\n");

  const before = computeTelemetryWorkloadBinding("groups", root);
  assert.deepEqual(before.files.map(({ path: filePath }) => filePath), [
    "results/groups.meta",
    "results/groups.tsv",
    "logs/groups/a-group.log",
    "logs/groups/z-group.log",
  ]);

  writeFileSync(path.join(root, "logs", "groups", "a-group.log"), "all waves passed\n");
  const after = computeTelemetryWorkloadBinding("groups", root);
  assert.notEqual(after.workloadBindingSha256, before.workloadBindingSha256);
  assert.equal(after.workloadGeneration, before.workloadGeneration);

  const reversed = [...after.files.slice(0, 2), ...after.files.slice(2).toReversed()];
  assert.throws(
    () => serializeTelemetryWorkloadBindingPreimage("groups", reversed),
    /canonical lexical order/,
  );
});

test("groups TSV can name only unique canonical owning logs", () => {
  const traversal = writeFixture("groups");
  replace(
    path.join(traversal, "results", "groups.tsv"),
    "logs/groups/all-cpus.log",
    "logs/groups/../all-cpus.log",
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", traversal),
    /noncanonical group log path/,
  );

  const duplicate = writeFixture("groups");
  const row = readFileSync(path.join(duplicate, "results", "groups.tsv"), "utf8");
  writeFileSync(path.join(duplicate, "results", "groups.tsv"), `${row}${row}`);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", duplicate),
    /duplicates a group name or log path/,
  );
});

test("CLI emits one fixed, shell-safe key=value record per field", () => {
  const root = writeFixture("individual");
  const expected = computeTelemetryWorkloadBinding("individual", root);
  const invocation = captureCli(["individual", root]);
  assert.equal(invocation.status, 0);
  assert.equal(
    invocation.stdout,
    `VERSION=1\nFORMAT=${TELEMETRY_WORKLOAD_BINDING_FORMAT}\nPHASE=individual\n` +
      `WORKLOAD_GENERATION=${GENERATION}\n` +
      `WORKLOAD_BINDING_SHA256=${expected.workloadBindingSha256}\n` +
      `WORKLOAD_BOUNDARIES_SHA256=${BOUNDARIES_SHA256}\nWORKLOAD_BOUNDARY_ROW_COUNT=12\n`,
  );

  const baseline = writeFixture("baseline");
  const baselineInvocation = captureCli(["baseline", baseline]);
  assert.equal(baselineInvocation.status, 0);
  assert.match(baselineInvocation.stdout, /^WORKLOAD_GENERATION=-$/m);
  assert.match(baselineInvocation.stdout, /^WORKLOAD_BOUNDARIES_SHA256=-$/m);
  assert.match(baselineInvocation.stdout, /^WORKLOAD_BOUNDARY_ROW_COUNT=-$/m);

  const bad = captureCli(["unknown", root]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /phase must be one of/);
});

test("generation fields must be unique, lowercase hex32, and correctly delimited", () => {
  const duplicate = writeFixture("groups");
  const duplicateMeta = path.join(duplicate, "results", "groups.meta");
  writeFileSync(duplicateMeta, `${readFileSync(duplicateMeta, "utf8")}GENERATION=${"f".repeat(32)}\n`);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", duplicate),
    /duplicates field GENERATION/,
  );

  const uppercase = writeFixture("groups");
  replace(path.join(uppercase, "results", "groups.meta"), GENERATION, GENERATION.toUpperCase());
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", uppercase),
    /field GENERATION is malformed/,
  );

  const duplicateGdb = writeFixture("gdb");
  const manifest = path.join(duplicateGdb, "results", "gdb.manifest");
  writeFileSync(manifest, `${readFileSync(manifest, "utf8")}GENERATION\t${"f".repeat(32)}\n`);
  assert.throws(
    () => computeTelemetryWorkloadBinding("gdb", duplicateGdb),
    /exactly one GENERATION record/,
  );

  const malformedGdb = writeFixture("gdb");
  replace(
    path.join(malformedGdb, "results", "gdb.manifest"),
    new RegExp(`GENERATION\\t${GENERATION}`),
    `GENERATION\t${GENERATION.toUpperCase()}`,
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("gdb", malformedGdb),
    /GENERATION record is malformed/,
  );
});

test("exact protocols require their version and unique canonical boundary identity", () => {
  const version6 = writeFixture("individual");
  replace(path.join(version6, "results", "individual.meta"), /VERSION=5/, "VERSION=6");
  assert.doesNotThrow(() => computeTelemetryWorkloadBinding("individual", version6));

  const legacy = writeFixture("individual");
  replace(path.join(legacy, "results", "individual.meta"), /VERSION=5/, "VERSION=4");
  assert.throws(
    () => computeTelemetryWorkloadBinding("individual", legacy),
    /VERSION must be one of 5, 6/,
  );

  const duplicate = writeFixture("individual");
  const duplicateMeta = path.join(duplicate, "results", "individual.meta");
  writeFileSync(
    duplicateMeta,
    `${readFileSync(duplicateMeta, "utf8")}BOUNDARIES_SHA256=${"cd".repeat(32)}\n`,
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("individual", duplicate),
    /duplicates field BOUNDARIES_SHA256/,
  );

  const malformedDigest = writeFixture("pinned-concurrent");
  replace(
    path.join(malformedDigest, "results", "pinned-concurrent.meta"),
    BOUNDARIES_SHA256,
    BOUNDARIES_SHA256.toUpperCase(),
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("pinned-concurrent", malformedDigest),
    /BOUNDARIES_SHA256 is malformed/,
  );

  for (const rowCount of ["0", "01", "20000001", "9007199254740992"]) {
    const malformedCount = writeFixture("individual");
    replace(
      path.join(malformedCount, "results", "individual.meta"),
      /BOUNDARY_ROW_COUNT=12/,
      `BOUNDARY_ROW_COUNT=${rowCount}`,
    );
    assert.throws(
      () => computeTelemetryWorkloadBinding("individual", malformedCount),
      /BOUNDARY_ROW_COUNT/,
    );
  }
});

test("missing, symlinked, hardlinked, nonregular, and oversized files fail closed", () => {
  const missing = writeFixture("groups");
  rmSync(path.join(missing, "results", "groups.tsv"));
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", missing),
    TelemetryWorkloadBindingError,
  );

  const symbolic = writeFixture("groups");
  const symbolicMeta = path.join(symbolic, "results", "groups.meta");
  renameSync(symbolicMeta, `${symbolicMeta}.real`);
  symlinkSync("groups.meta.real", symbolicMeta);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", symbolic),
    /single-link regular file/,
  );

  const hardlinked = writeFixture("groups");
  linkSync(
    path.join(hardlinked, "results", "groups.meta"),
    path.join(hardlinked, "results", "groups.meta.alias"),
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", hardlinked),
    /single-link regular file/,
  );

  const fifo = writeFixture("groups");
  const fifoTsv = path.join(fifo, "results", "groups.tsv");
  rmSync(fifoTsv);
  mkdirSync(fifoTsv);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", fifo),
    /single-link regular file/,
  );

  const oversized = writeFixture("groups");
  truncateSync(
    path.join(oversized, "results", "groups.meta"),
    TELEMETRY_WORKLOAD_FILE_MAX_BYTES["results/groups.meta"] + 1,
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", oversized),
    /no larger than/,
  );

  const symbolicLog = writeFixture("groups");
  const groupLog = path.join(symbolicLog, "logs", "groups", "all-cpus.log");
  renameSync(groupLog, `${groupLog}.real`);
  symlinkSync("all-cpus.log.real", groupLog);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", symbolicLog),
    /single-link regular file/,
  );

  const oversizedLog = writeFixture("groups");
  truncateSync(
    path.join(oversizedLog, "logs", "groups", "all-cpus.log"),
    TELEMETRY_GROUP_LOG_MAX_BYTES + 1,
  );
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", oversizedLog),
    /no larger than/,
  );
});

test("real current-owner parent directories are required", () => {
  const symbolicParent = writeFixture("groups");
  const results = path.join(symbolicParent, "results");
  renameSync(results, path.join(symbolicParent, "real-results"));
  symlinkSync("real-results", results);
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", symbolicParent),
    /results must be a real directory owned by the current user/,
  );

  const fileParent = writeFixture("baseline");
  rmSync(path.join(fileParent, "logs", "baseline"), { recursive: true });
  writeFileSync(path.join(fileParent, "logs", "baseline"), "not a directory\n");
  assert.throws(
    () => computeTelemetryWorkloadBinding("baseline", fileParent),
    /logs\/baseline must be a real directory owned by the current user/,
  );
});

test("file and parent-directory races are rejected after bytes are read", () => {
  const changedFile = writeFixture("groups");
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", changedFile, {
      afterFileRead({ fileIndex }) {
        if (fileIndex === 0) {
          const meta = path.join(changedFile, "results", "groups.meta");
          const bytes = readFileSync(meta);
          bytes[0] = bytes[0] === 0x56 ? 0x58 : 0x56;
          writeFileSync(meta, bytes);
        }
      },
    }),
    /changed while it was read/,
  );

  const changedParent = writeFixture("individual");
  assert.throws(
    () => computeTelemetryWorkloadBinding("individual", changedParent, {
      afterFileRead({ fileIndex }) {
        if (fileIndex === 0) {
          renameSync(path.join(changedParent, "results"), path.join(changedParent, "old-results"));
          mkdirSync(path.join(changedParent, "results"));
          writeFileSync(path.join(changedParent, "results", "individual.meta"), "replacement\n");
        }
      },
    }),
    /results changed while evidence was read/,
  );

  const changedGroupLog = writeFixture("groups");
  assert.throws(
    () => computeTelemetryWorkloadBinding("groups", changedGroupLog, {
      afterFileRead({ fileIndex }) {
        if (fileIndex === 2) {
          writeFileSync(
            path.join(changedGroupLog, "logs", "groups", "all-cpus.log"),
            "replacement evidence\n",
          );
        }
      },
    }),
    /changed while it was read/,
  );
});

test("malformed control text and invalid API inputs are rejected", () => {
  const noLf = writeFixture("groups");
  const meta = path.join(noLf, "results", "groups.meta");
  writeFileSync(meta, readFileSync(meta, "utf8").slice(0, -1));
  assert.throws(() => computeTelemetryWorkloadBinding("groups", noLf), /must end with LF/);

  const invalidUtf8 = writeFixture("groups");
  writeFileSync(path.join(invalidUtf8, "results", "groups.meta"), Buffer.from([0xff, 0x0a]));
  assert.throws(() => computeTelemetryWorkloadBinding("groups", invalidUtf8), /not valid UTF-8/);

  assert.throws(
    () => computeTelemetryWorkloadBinding("not-a-phase", noLf),
    TelemetryWorkloadBindingError,
  );
  assert.throws(
    () => serializeTelemetryWorkloadBindingPreimage("groups", []),
    /fixed phase schema/,
  );
});
