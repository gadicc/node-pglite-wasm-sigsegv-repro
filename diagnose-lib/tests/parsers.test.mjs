import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReproLog } from "../parse-repro-log.mjs";
import { parseGdbCapture } from "../parse-gdb.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => readFileSync(path.join(fixtures, name), "utf8");

test("parseReproLog: epoch-prefixed log with failures", () => {
  const r = parseReproLog(readFixture("repro-fail.log"));
  assert.equal(r.node, "v25.2.1");
  assert.equal(r.v8, "14.1.146.11-node.14");
  assert.equal(r.children, 4);
  assert.equal(r.requestedWaves, 5);
  assert.equal(r.completedWaves, 5);
  assert.equal(r.failedWaves, 2);
  assert.equal(r.totalChildInvocations, 20);
  assert.equal(r.sigsegvCount, 2);
  assert.equal(r.otherFailureCount, 1);
  assert.equal(r.failures.length, 3);
  assert.equal(r.failures[0].child, 3);
  assert.equal(r.failures[0].signal, "SIGSEGV");
  assert.equal(r.failures[2].code, 13);
  assert.equal(r.failures[2].signal, null);
  assert.equal(r.firstFailureAfterSec, 12);
  assert.equal(r.durationSec, 30);
  assert.equal(r.waves.length, 5);
  assert.equal(r.waves[3].passed, 2);
});

test("parseReproLog: clean log without timestamps", () => {
  const r = parseReproLog(readFixture("repro-clean.log"));
  assert.equal(r.completedWaves, 3);
  assert.equal(r.failedWaves, 0);
  assert.equal(r.totalChildInvocations, 6);
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.firstFailureAfterSec, null);
  assert.equal(r.durationSec, null);
});

test("parseGdbCapture: known +2^42 signature (real transcript)", () => {
  const r = parseGdbCapture(readFixture("gdb-known.txt"));
  assert.equal(r.captured, true);
  assert.equal(r.instruction, "addl $0x1,0x1c0(%r13)");
  assert.equal(r.knownInstruction, true);
  assert.equal(r.registers.r13, "0x6720080");
  assert.equal(r.rip, "0x00007fffd7dcfc74");
  assert.equal(r.siAddr, "0x40006720240");
  assert.equal(r.intendedAddr, "0x6720240");
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.intendedMappingFile, "[heap]");
  assert.equal(r.siAddrMapped, false);
  assert.equal(r.addrDiffHex, "0x40000000000");
  assert.deepEqual(r.diffBits, [42]);
  assert.equal(r.matchesKnownSignature, true);
  assert.equal(r.classification, "known-signature");
  assert.equal(r.threadCount, 11);
  assert.equal(r.processId, 2689857);
  assert.ok(r.mappings.length > 100);
});

test("parseGdbCapture: unknown instruction is preserved for manual review", () => {
  const r = parseGdbCapture(readFixture("gdb-unknown.txt"));
  assert.equal(r.captured, true);
  assert.equal(r.knownInstruction, false);
  assert.equal(r.classification, "manual");
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.instruction, "mov %rax,0x10(%rbx)");
  assert.equal(r.siAddr, "0x1000010");
  assert.equal(r.intendedAddr, null);
  assert.equal(r.siAddrMapped, false);
  assert.ok(r.notes.some((n) => n.includes("manual classification")));
  assert.equal(r.threadCount, 2);
});

test("parseGdbCapture: clean exit transcript has no fault", () => {
  const r = parseGdbCapture(readFixture("gdb-clean.txt"));
  assert.equal(r.captured, false);
  assert.equal(r.classification, "no-fault");
  assert.equal(r.siAddr, null);
});
