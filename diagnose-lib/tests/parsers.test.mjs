import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReproLog } from "../parse-repro-log.mjs";
import { parseGdbCapture } from "../parse-gdb.mjs";
import { renderReport } from "../report.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => readFileSync(path.join(fixtures, name), "utf8");

function assertFailureSlots(r) {
  const summaryFailures = r.waves.reduce((sum, wave) => sum + wave.of - wave.passed, 0);
  assert.equal(
    r.sigsegvCount + r.otherFailureCount + r.unclassifiedFailureCount,
    summaryFailures,
  );
  assert.ok(summaryFailures <= r.totalChildInvocations);
  assert.equal(
    new Set(r.failures.map((failure) => `${failure.wave}:${failure.child}`)).size,
    r.failures.length,
  );
}

test("parseReproLog: epoch-prefixed log with failures", () => {
  const r = parseReproLog(readFixture("repro-fail.log"));
  assert.equal(r.node, "v25.2.1");
  assert.equal(r.v8, "14.1.146.11-node.14");
  assert.equal(r.children, 4);
  assert.equal(r.requestedWaves, 5);
  assert.equal(r.processedWaves, 5);
  assert.equal(r.completedWaves, 5);
  assert.equal(r.fullyPassedWaves, 3);
  assert.equal(r.failedWaves, 2);
  assert.equal(r.totalChildInvocations, 20);
  assert.equal(r.sigsegvCount, 2);
  assert.equal(r.otherFailureCount, 1);
  assert.equal(r.sigsegvWaveCount, 2);
  assert.equal(r.sigsegvResolvedWaveCount, 5);
  assert.equal(r.sigsegvUnresolvedWaveCount, 0);
  assert.equal(r.otherFailureWaveCount, 1);
  assert.equal(r.unclassifiedFailureWaveCount, 0);
  assert.equal(r.failures.length, 3);
  assert.equal(r.failures[0].child, 3);
  assert.equal(r.failures[0].signal, "SIGSEGV");
  assert.equal(r.failures[2].code, 13);
  assert.equal(r.failures[2].signal, null);
  assert.equal(r.firstFailureAfterSec, 12);
  assert.equal(r.durationSec, 30);
  assert.equal(r.waves.length, 5);
  assert.equal(r.waves[3].passed, 2);
  assert.equal(r.completionStatus, "complete");
  assert.deepEqual(r.footer, {
    failedWaves: 2,
    completedWaves: 5,
    requestedWaves: 5,
    line: 10,
  });
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

test("parseReproLog: truncated log recovers wave counts from wave rows", () => {
  const r = parseReproLog(readFixture("repro-truncated.log"));
  assert.equal(r.partial, true);
  assert.equal(r.finalLine, null);
  assert.equal(r.children, 2);
  assert.equal(r.requestedWaves, 5);
  assert.equal(r.processedWaves, 2);
  assert.equal(r.completedWaves, 2);
  assert.equal(r.fullyPassedWaves, 1);
  assert.equal(r.failedWaves, 1);
  // Both printed waves forked all of their children, failed ones included,
  // so the SIGSEGV can never be reported over zero invocations.
  assert.equal(r.totalChildInvocations, 4);
  assert.equal(r.sigsegvCount, 1);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 0);
  assert.equal(r.sigsegvWaveCount, 1);
  assert.equal(r.sigsegvResolvedWaveCount, 2);
  assert.equal(r.sigsegvUnresolvedWaveCount, 0);
  assert.equal(r.firstFailureAfterSec, 12);
  assert.equal(r.durationSec, 12);
  assert.equal(r.completionStatus, "partial");
});

test("parseReproLog: footer-present logs are not partial", () => {
  assert.equal(parseReproLog(readFixture("repro-fail.log")).partial, false);
  assert.equal(parseReproLog(readFixture("repro-clean.log")).partial, false);
});

test("parseReproLog: duplicate wave rows are not double-counted", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=2 waves=5",
    "wave=1 passed=2/2",
    "wave=1 passed=1/2", // duplicate row: first occurrence wins
    "wave=2 passed=1/2",
  ].join("\n"));
  assert.equal(r.partial, false);
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.completedWaves, 2);
  assert.equal(r.failedWaves, 1);
  assert.equal(r.totalChildInvocations, 4);
  assert.ok(r.notes.some((n) => n.includes("duplicate wave=1")));
});

test("parseReproLog: truncated failed wave accounts for missing child details", () => {
  const r = parseReproLog([
    "1753950000\tnode=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=5",
    "1753950012\twave=1 passed=0/4",
  ].join("\n"));
  assert.equal(r.partial, true);
  assert.equal(r.processedWaves, 1);
  assert.equal(r.failedWaves, 1);
  assert.equal(r.totalChildInvocations, 4);
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 4);
  assert.equal(r.sigsegvWaveCount, 0);
  assert.equal(r.sigsegvResolvedWaveCount, 0);
  assert.equal(r.sigsegvUnresolvedWaveCount, 1);
  assert.equal(r.unclassifiedFailureWaveCount, 1);
  assert.equal(r.firstFailureAfterSec, 12);
  assert.ok(r.notes.some((note) => note.includes("only 0 child detail")));
});

test("parseReproLog: wave rows disagreeing with the header are not counted", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=2 waves=5",
    "wave=1 passed=2/2",
    "wave=2 passed=3/3", // of=3 disagrees with header children=2
  ].join("\n"));
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.completedWaves, 1);
  assert.equal(r.failedWaves, 0);
  assert.equal(r.totalChildInvocations, 2);
  assert.ok(r.notes.some((n) => n.includes("wave=2") && n.includes("disagrees")));
});

test("parseReproLog: wave rows outside the requested range are not counted", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=2 waves=2",
    "wave=1 passed=2/2",
    "wave=3 passed=1/2", // outside requested waves 1..2
  ].join("\n"));
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.completedWaves, 1);
  assert.equal(r.failedWaves, 0);
  assert.equal(r.totalChildInvocations, 2);
  assert.ok(r.notes.some((n) => n.includes("wave=3") && n.includes("outside requested waves")));
});

test("parseReproLog: completion needs rows, not merely a plausible footer", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=3",
    "failedWaves=0 completedWaves=3 requestedWaves=3",
  ].join("\n"), { expectedChildren: 2, expectedWaves: 3, exitCode: 0 });
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.totalChildInvocations, 0);
  assert.equal(r.completedWaves, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /footer-row-count-mismatch/);
});

test("parseReproLog: external metadata and exit status are reconciled", () => {
  const log = readFixture("repro-clean.log");
  assert.equal(parseReproLog(log, {
    expectedChildren: 2,
    expectedWaves: 3,
    exitCode: 0,
  }).completionStatus, "complete");

  const mismatch = parseReproLog(log, {
    expectedChildren: 3,
    expectedWaves: 4,
    exitCode: 1,
  });
  assert.equal(mismatch.completionStatus, "inconsistent");
  assert.match(
    mismatch.issues.map(({ code }) => code).join(" "),
    /expected-children-mismatch.*expected-waves-mismatch.*incomplete-footer.*exit-code-mismatch/,
  );
});

test("parseReproLog: header/footer disagreement and impossible footer are inconsistent", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=2",
    "wave=1 passed=2/2",
    "failedWaves=2 completedWaves=1 requestedWaves=3",
  ].join("\n"));
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.totalChildInvocations, 2);
  assert.match(r.issues.map(({ code }) => code).join(" "), /footer-header-mismatch.*impossible-footer/);
});

test("parseReproLog: duplicate, gap, malformed, and multiple structural records are inconsistent", () => {
  const cases = [
    ["duplicate header", [
      "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
      "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
      "wave=1 passed=1/1",
      "failedWaves=0 completedWaves=1 requestedWaves=1",
    ]],
    ["gap", [
      "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=2",
      "wave=2 passed=1/1",
    ]],
    ["malformed", [
      "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
      "wave=01 passed=1/1",
    ]],
    ["multiple footer", [
      "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
      "wave=1 passed=1/1",
      "failedWaves=0 completedWaves=1 requestedWaves=1",
      "failedWaves=0 completedWaves=1 requestedWaves=1",
    ]],
  ];
  for (const [label, lines] of cases) {
    assert.equal(parseReproLog(lines.join("\n")).completionStatus, "inconsistent", label);
  }
});

test("parseReproLog: child detail attached to a duplicate row cannot migrate", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=2",
    "wave=1 passed=2/2",
    "wave=1 passed=1/2",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "wave=2 passed=2/2",
    "failedWaves=0 completedWaves=2 requestedWaves=2",
  ].join("\n"));
  assert.equal(r.completionStatus, "inconsistent");
  assert.equal(r.totalChildInvocations, 4);
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 0);
  assert.equal(r.failures.length, 0);
  assertFailureSlots(r);
  assert.ok(r.notes.some((note) => note.includes("rejected wave=1")));
});

test("parseReproLog: exact duplicate child detail does not inflate a failure slot", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=1/2",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 1);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 0);
  assert.equal(r.failures.length, 1);
  assert.match(r.issues.map(({ code }) => code).join(" "), /duplicate-child-detail/);
  assertFailureSlots(r);
});

test("parseReproLog: conflicting duplicate makes its failure slot unclassified", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=1/2",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "child=1 code=13 signal=null elapsedMs=5",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.failures.length, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /conflicting-child-detail/);
  assertFailureSlots(r);
});

test("parseReproLog: elapsed-only duplicate disagreement retains the unambiguous outcome", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=1/2",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "child=1 code=null signal=SIGSEGV elapsedMs=5",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 1);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 0);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].elapsedMs, null);
  assert.match(r.issues.map(({ code }) => code).join(" "), /duplicate-child-metadata/);
  assertFailureSlots(r);
});

test("parseReproLog: overfull unique child detail classifies none", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=3 waves=1",
    "wave=1 passed=2/3",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "child=2 code=13 signal=null elapsedMs=5",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.failures.length, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /overfull-child-details/);
  assertFailureSlots(r);
});

test("parseReproLog: child ids outside 1..of never contribute", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=0/2",
    "child=0 code=null signal=SIGSEGV elapsedMs=4",
    "child=3 code=13 signal=null elapsedMs=5",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 2);
  assert.equal(r.failures.length, 0);
  assert.equal(r.issues.filter(({ code }) => code === "child-out-of-range").length, 2);
  assertFailureSlots(r);
});

test("parseReproLog: impossible child outcomes remain unclassified", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=4 waves=1",
    "wave=1 passed=0/4",
    "child=1 code=0 signal=null elapsedMs=4",
    "child=2 code=null signal=null elapsedMs=5",
    "child=3 code=13 signal=SIGSEGV elapsedMs=6",
    "child=4 code=0 signal=SIGSEGV elapsedMs=7",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 4);
  assert.equal(r.failures.length, 0);
  assert.equal(r.issues.filter(({ code }) => code === "invalid-child-outcome").length, 4);
  assertFailureSlots(r);
});

test("parseReproLog: invented signal names never become failure evidence", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
    "wave=1 passed=0/1",
    "child=1 code=null signal=SIGBANANA elapsedMs=4",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.failures.length, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /invalid-child-outcome/);
  assertFailureSlots(r);
});

test("parseReproLog: exit status outside the producer's byte range is impossible", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
    "wave=1 passed=0/1",
    "child=1 code=256 signal=null elapsedMs=4",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.failures.length, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /invalid-child-outcome/);
  assertFailureSlots(r);
});

test("parseReproLog: summed child invocation denominator must stay a safe integer", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const r = parseReproLog([
    `node=v25.2.1 v8=14.1 platform=linux arch=x64 children=${max} waves=2`,
    `wave=1 passed=0/${max}`,
    `wave=2 passed=0/${max}`,
    "failedWaves=2 completedWaves=2 requestedWaves=2",
  ].join("\n"));
  assert.equal(r.totalChildInvocations, max);
  assert.equal(r.unclassifiedFailureCount, max);
  assert.equal(r.completedWaves, 1);
  assert.equal(r.completionStatus, "inconsistent");
  assert.match(r.issues.map(({ code }) => code).join(" "), /invocation-count-overflow/);
  assertFailureSlots(r);
});

test("parseReproLog: malformed trailing numeric detail never contributes", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
    "wave=1 passed=0/1",
    "child=1 code=13 signal=null elapsedMs=4x",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 0);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.failures.length, 0);
  assert.match(r.issues.map(({ code }) => code).join(" "), /malformed-record/);
  assertFailureSlots(r);
});

test("parseReproLog: malformed child row does not detach later canonical detail", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=0/2",
    "child=1 code=13 signal=null elapsedMs=4x",
    "child=2 code=null signal=SIGSEGV elapsedMs=5",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 1);
  assert.equal(r.otherFailureCount, 0);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.deepEqual(r.failures.map(({ wave, child }) => [wave, child]), [[1, 2]]);
  assert.match(r.issues.map(({ code }) => code).join(" "), /malformed-record/);
  assertFailureSlots(r);
});

test("parseReproLog: structural record order and timestamp provenance are strict", () => {
  const footerFirst = parseReproLog([
    "failedWaves=0 completedWaves=1 requestedWaves=1",
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
    "wave=1 passed=1/1",
  ].join("\n"));
  assert.equal(footerFirst.completionStatus, "inconsistent");
  assert.match(footerFirst.issues.map(({ code }) => code).join(" "), /header-order.*footer-order/);

  const mixed = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=1 waves=1",
    "1753950010\twave=1 passed=1/1",
    "1753950009\tfailedWaves=0 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(mixed.completionStatus, "inconsistent");
  assert.equal(mixed.durationSec, null);
  assert.match(mixed.issues.map(({ code }) => code).join(" "), /mixed-timestamps.*decreasing-timestamp/);
});

test("parseReproLog: other-only waves are unresolved for the SIGSEGV endpoint", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=2",
    "wave=1 passed=1/2",
    "child=1 code=13 signal=null elapsedMs=4",
    "wave=2 passed=0/2",
    "failedWaves=2 completedWaves=2 requestedWaves=2",
  ].join("\n"));
  assert.equal(r.otherFailureWaveCount, 1);
  assert.equal(r.unclassifiedFailureWaveCount, 1);
  assert.equal(r.sigsegvWaveCount, 0);
  assert.equal(r.sigsegvResolvedWaveCount, 0);
  assert.equal(r.sigsegvUnresolvedWaveCount, 2);
});

test("parseReproLog: a mixed SIGSEGV and unclassified wave is one resolved positive", () => {
  const r = parseReproLog([
    "node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=1",
    "wave=1 passed=0/2",
    "child=1 code=null signal=SIGSEGV elapsedMs=4",
    "failedWaves=1 completedWaves=1 requestedWaves=1",
  ].join("\n"));
  assert.equal(r.sigsegvCount, 1);
  assert.equal(r.unclassifiedFailureCount, 1);
  assert.equal(r.sigsegvWaveCount, 1);
  assert.equal(r.sigsegvResolvedWaveCount, 1);
  assert.equal(r.sigsegvUnresolvedWaveCount, 0);
  assert.equal(r.unclassifiedFailureWaveCount, 1);
});

test("renderReport: partial baseline and group data are marked as truncated", () => {
  const baseline = {
    children: 2,
    requestedWaves: 5,
    processedWaves: 2,
    completedWaves: 2,
    failedWaves: 1,
    totalChildInvocations: 4,
    sigsegvCount: 1,
    otherFailureCount: 0,
    firstFailureAfterSec: 12,
    durationSec: 12,
    partial: true,
    log: "logs/baseline/run1.log",
  };
  const group = {
    name: "pcores",
    cpus: "0-7",
    children: 2,
    wavesRequested: 5,
    processedWaves: 2,
    completedWaves: 2,
    failedWaves: 1,
    totalChildInvocations: 4,
    sigsegvCount: 1,
    otherFailureCount: 0,
    partial: true,
  };
  const results = {
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline,
    groups: [group],
  };
  const md = renderReport(results);
  assert.ok(md.includes("| Waves | 2/5 processed, 1 failed (log truncated; partial data) |"));
  assert.ok(md.includes("| pcores | 0-7 | 2 | 2/5 processed (1 failed) (log truncated; partial data) |"));

  // The same counts from a completed run carry no truncation marker.
  const complete = renderReport({
    ...results,
    baseline: { ...baseline, partial: false },
    groups: [{ ...group, partial: false }],
  });
  assert.ok(!complete.includes("log truncated"));
});

test("renderReport: unclassified truncated failures are never called clean", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 4,
      requestedWaves: 5,
      processedWaves: 1,
      completedWaves: 1,
      failedWaves: 1,
      totalChildInvocations: 4,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 4,
      partial: true,
      log: "logs/baseline/run1.log",
    },
  });
  assert.match(md, /Unclassified failures \(summary only\) \| 4/);
  assert.match(md, /Workload failures occurred/);
  assert.doesNotMatch(md, /No failure reproduced/);
});

test("renderReport: inconsistent clean-looking repro rows stay descriptive", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 2,
      processedWaves: 2,
      completedWaves: 2,
      failedWaves: 0,
      fullyPassedWaves: 2,
      totalChildInvocations: 4,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 2,
      sigsegvUnresolvedWaveCount: 0,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 0,
      completionStatus: "inconsistent",
      issues: [{ code: "footer-row-count-mismatch", message: "footer disagrees with rows" }],
      log: "logs/baseline/run1.log",
    },
    groups: [{
      name: "pcores",
      cpus: "0-1",
      children: 2,
      wavesRequested: 2,
      processedWaves: 2,
      failedWaves: 0,
      fullyPassedWaves: 2,
      totalChildInvocations: 4,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 2,
      sigsegvUnresolvedWaveCount: 0,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 0,
      completionStatus: "inconsistent",
    }],
  });
  assert.match(md, /structurally inconsistent/);
  assert.match(md, /descriptive only; inconsistent structure/);
  assert.match(md, /prevents a clean non-reproduction conclusion or rate bound/);
  assert.doesNotMatch(md, /\*\*No failure reproduced\*\*/);
  assert.doesNotMatch(md, /clean group\(s\): pcores/);
  assert.doesNotMatch(md, /0\/4 \(95% upper/);
});

test("renderReport: impossible failure counts never throw or get an interval", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 1,
      processedWaves: 1,
      completedWaves: 1,
      failedWaves: 1,
      totalChildInvocations: 0,
      sigsegvCount: 3,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      completionStatus: "complete",
      log: "logs/baseline/run1.log",
    },
    groups: [{
      name: "bad-counts",
      cpus: "0-1",
      children: 2,
      wavesRequested: 1,
      processedWaves: 1,
      failedWaves: 1,
      totalChildInvocations: 2,
      sigsegvCount: 4,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      completionStatus: "inconsistent",
    }, {
      name: "zero-denominator",
      cpus: "2",
      children: 1,
      wavesRequested: 1,
      processedWaves: 0,
      failedWaves: 1,
      totalChildInvocations: 0,
      sigsegvCount: 1,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      completionStatus: "inconsistent",
    }],
    individualStatus: { status: "complete", reasons: [] },
    individual: [{
      cpu: 3,
      runs: 1,
      failures: 0,
      sigsegv: 1,
      invalidRuns: [],
      failedRuns: [],
    }],
  });
  assert.match(md, /SIGSEGV \| 3/);
  assert.match(md, /Child failures \(descriptive only\) \| invalid\/missing/);
  assert.match(md, /bad-counts.*invalid\/2.*interval unavailable/);
  assert.match(md, /zero-denominator.*invalid\/0.*interval unavailable/);
  assert.match(md, /invalid\/inconsistent counts; no interval/);
  assert.match(md, /inconsistent failure counts; excluded from conclusions/);
  assert.match(md, /impossible failure-count evidence was excluded/);
  assert.doesNotMatch(md, /\*\*The problem reproduced\*\*/);
  assert.doesNotMatch(md, /\*\*Group isolation\*\*/);

  const missingPrimary = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 1,
      requestedWaves: 1,
      processedWaves: 1,
      completedWaves: 1,
      failedWaves: 0,
      totalChildInvocations: 1,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      completionStatus: "complete",
      log: "logs/baseline/run1.log",
    },
  });
  assert.match(missingPrimary, /SIGSEGV \| invalid\/missing/);
  assert.match(missingPrimary, /Child failures \(descriptive only\) \| invalid\/missing/);
  assert.match(missingPrimary, /impossible failure-count evidence was excluded/);
  assert.doesNotMatch(missingPrimary, /NaN\/1/);
  assert.doesNotMatch(missingPrimary, /\*\*No failure reproduced\*\*/);
});

test("renderReport: CPU localization never prints an unsafe pooled clean denominator", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    individualStatus: { status: "complete", reasons: [] },
    individual: [
      { cpu: 1, runs: 1, failures: 1, sigsegv: 1, invalidRuns: [], failedRuns: [] },
      { cpu: 2, runs: Number.MAX_SAFE_INTEGER, failures: 0, sigsegv: 0, invalidRuns: [], failedRuns: [] },
      { cpu: 3, runs: 1, failures: 0, sigsegv: 0, invalidRuns: [], failedRuns: [] },
    ],
  });
  assert.match(md, /pooled run count exceeds the safe integer range/);
  assert.doesNotMatch(md, /0\/9007199254740992/);
});

test("renderReport: clean heterogeneous phases do not get a pooled rate bound", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 5,
      processedWaves: 5,
      completedWaves: 5,
      failedWaves: 0,
      fullyPassedWaves: 5,
      totalChildInvocations: 10,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 5,
      sigsegvUnresolvedWaveCount: 0,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 0,
      partial: false,
      log: "logs/baseline/run1.log",
    },
    groups: [{
      name: "pcores",
      cpus: "0-7",
      children: 2,
      wavesRequested: 10,
      processedWaves: 10,
      completedWaves: 10,
      failedWaves: 0,
      fullyPassedWaves: 10,
      totalChildInvocations: 20,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 10,
      sigsegvUnresolvedWaveCount: 0,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 0,
    }],
    individual: [{ cpu: 0, runs: 30, failures: 0, sigsegv: 0, invalidRuns: [], failedRuns: [] }],
    individualStatus: { status: "complete", reasons: [] },
  });
  assert.match(md, /No pooled rate bound is valid/);
  assert.match(md, /phase-, group-, and CPU-specific bounds/);
  assert.match(md, /SIGSEGV wave rate \/ 95% CI \| 0\/5 \(95% upper < 45\.1%\)/);
  assert.doesNotMatch(md, /pooled per-run rate/);
});

test("renderReport: identical child SIGSEGV counts have different clustered wave intervals", () => {
  const common = {
    children: 4,
    requestedWaves: 10,
    wavesRequested: 10,
    processedWaves: 10,
    completedWaves: 10,
    totalChildInvocations: 40,
    sigsegvCount: 4,
    otherFailureCount: 0,
    unclassifiedFailureCount: 0,
    sigsegvResolvedWaveCount: 10,
    sigsegvUnresolvedWaveCount: 0,
    otherFailureWaveCount: 0,
    unclassifiedFailureWaveCount: 0,
    completionStatus: "complete",
  };
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      ...common,
      failedWaves: 1,
      fullyPassedWaves: 9,
      sigsegvWaveCount: 1,
      log: "logs/baseline/run1.log",
    },
    groups: [{
      ...common,
      name: "spread",
      cpus: "0-3",
      failedWaves: 4,
      fullyPassedWaves: 6,
      sigsegvWaveCount: 4,
    }],
  });
  assert.match(md, /SIGSEGV wave rate \/ 95% CI \| 1\/10 = 10\.0% \[1\.8%, 40\.4%\]/);
  assert.match(md, /spread.*4\/10 = 40\.0% \[16\.8%, 68\.7%\]/);
  assert.match(md, /Concurrent children within a wave are correlated/);
  assert.match(md, /different children-per-wave are not\s+directly comparable/);
});

test("renderReport: legacy or impossible wave fields never fall back to child intervals", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 5,
      processedWaves: 5,
      completedWaves: 5,
      failedWaves: 0,
      totalChildInvocations: 10,
      sigsegvCount: 0,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      completionStatus: "complete",
      log: "logs/baseline/run1.log",
    },
    groups: [{
      name: "forged",
      cpus: "0-1",
      children: 2,
      wavesRequested: 1,
      processedWaves: 1,
      completedWaves: 1,
      failedWaves: 1,
      fullyPassedWaves: 0,
      totalChildInvocations: 2,
      sigsegvCount: 1,
      otherFailureCount: 0,
      unclassifiedFailureCount: 0,
      // Forged cross-layer evidence: a child SIGSEGV cannot coexist with
      // zero positive waves, nor can an unresolved wave lack other or
      // unclassified evidence.
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 0,
      sigsegvUnresolvedWaveCount: 1,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 0,
      completionStatus: "complete",
    }],
  });
  assert.equal((md.match(/interval unavailable \(legacy or invalid wave counts\)/g) ?? []).length, 2);
  assert.doesNotMatch(md, /0\/10 \(95% upper/);
  assert.doesNotMatch(md, /\*\*No failure reproduced\*\*/);
});

test("renderReport: partial positive wave evidence reproduces but gets no interval", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 5,
      processedWaves: 1,
      completedWaves: 1,
      failedWaves: 1,
      fullyPassedWaves: 0,
      totalChildInvocations: 2,
      sigsegvCount: 1,
      otherFailureCount: 0,
      unclassifiedFailureCount: 1,
      sigsegvWaveCount: 1,
      sigsegvResolvedWaveCount: 1,
      sigsegvUnresolvedWaveCount: 0,
      otherFailureWaveCount: 0,
      unclassifiedFailureWaveCount: 1,
      completionStatus: "partial",
      partial: true,
      log: "logs/baseline/run1.log",
    },
  });
  assert.match(md, /1\/1 = 100\.0% \(descriptive only; partial structure\)/);
  assert.match(md, /\*\*The problem reproduced\*\*/);
  assert.doesNotMatch(md, /1\/1 = 100\.0% \[/);
});

test("renderReport: unresolved waves preclude a clean claim and zero bound", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    baseline: {
      children: 2,
      requestedWaves: 2,
      processedWaves: 2,
      completedWaves: 2,
      failedWaves: 1,
      fullyPassedWaves: 1,
      totalChildInvocations: 4,
      sigsegvCount: 0,
      otherFailureCount: 1,
      unclassifiedFailureCount: 0,
      sigsegvWaveCount: 0,
      sigsegvResolvedWaveCount: 1,
      sigsegvUnresolvedWaveCount: 1,
      otherFailureWaveCount: 1,
      unclassifiedFailureWaveCount: 0,
      completionStatus: "complete",
      log: "logs/baseline/run1.log",
    },
  });
  assert.match(md, /0\/1 \(no upper bound; 1 unresolved wave\(s\)\)/);
  assert.match(md, /Workload failures occurred/);
  assert.doesNotMatch(md, /0\/1 \(95% upper/);
  assert.doesNotMatch(md, /\*\*No failure reproduced\*\*/);
});

test("renderReport: incomplete individual prefixes are descriptive but cannot localize", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    worstCpu: null,
    individualStatus: {
      status: "incomplete",
      reasons: ["phase completion marker is missing"],
    },
    individual: [
      { cpu: 3, runs: 1, failures: 0, sigsegv: 0, invalidRuns: [], failedRuns: [] },
      { cpu: 4, runs: 1, failures: 1, sigsegv: 1, invalidRuns: [], failedRuns: [{ run: 1, signal: "SIGSEGV" }] },
    ],
  });
  assert.match(md, /Individual-phase status: incomplete/);
  assert.match(md, /Only unambiguous/);
  assert.match(md, /excluded\s+from worst-CPU selection and CPU-localization conclusions/);
  assert.match(md, /\| 4 \| 1 \| 1 \|/);
  assert.doesNotMatch(md, /\*\*CPU localization\*\*: failures observed/);
  assert.doesNotMatch(md, /highest observed rate/);
});

test("renderReport: incomplete frequency artifacts are excluded from conclusions", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    frequencyAbStatus: {
      status: "incomplete",
      reasons: ["frequency settings are not verified as restored"],
    },
  });
  assert.match(md, /artifacts were preserved but excluded/);
  assert.match(md, /Frequency dependence was not analyzed/);
  assert.doesNotMatch(md, /Frequency dependence was not tested \(requires/);
});

test("renderReport: discordant A legs cannot support a pooled suppression claim", () => {
  const leg = (name, failures, noTurbo) => ({
    leg: name,
    runs: 20,
    failures,
    sigsegv: failures,
    invalidRuns: [],
    noTurbo,
  });
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    frequencyAb: {
      cpu: 19,
      restored: true,
      legs: [leg("A1", 20, 0), leg("B", 0, 1), leg("A2", 0, 0)],
    },
  });
  assert.match(md, /turbo-on legs disagree/);
  assert.match(md, /reversal failed/);
  assert.match(md, /no pooled suppression inference/);
  assert.doesNotMatch(md, /Lower frequency suppressed/);
  assert.doesNotMatch(md, /Fisher exact test on their pooled/);
});

test("renderReport: GDB failure is not described as a clean bounded run", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    gdb: { status: "failed", reason: "capture runner exited with code 5", captures: [] },
  });
  assert.match(md, /capture runner failed/);
  assert.match(md, /neither a no-fault bound nor a signature conclusion/);
  assert.doesNotMatch(md, /captured no fault within the run limit/);
});

test("renderReport: GDB no-fault bound uses only clean attempts", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    gdb: {
      status: "no-fault", cpu: 19, maxRuns: 6, exitCode: 3, captures: [],
      countsAvailable: true, attemptedRuns: 6, cleanRuns: 1, capturedRuns: 0, errorRuns: 5,
    },
  });
  assert.match(md, /6 pinned attempt/);
  assert.match(md, /1 clean and 5 runner error/);
  assert.match(md, /95% upper bound per attempt is 95\.0%/);
  assert.match(md, /n=1/);
  assert.doesNotMatch(md, /39\.3%/);
});

test("renderReport: legacy GDB no-fault result has no numerical bound", () => {
  const md = renderReport({
    collectedAt: "2026-08-02T00:00:00.000Z",
    config: {},
    environment: {},
    gdb: {
      status: "no-fault", cpu: 19, maxRuns: 6, exitCode: 3, captures: [],
      countsAvailable: false, attemptedRuns: null, cleanRuns: null, capturedRuns: null, errorRuns: null,
    },
  });
  assert.match(md, /legacy GDB result/);
  assert.match(md, /denominator unavailable, so no bound/);
  assert.doesNotMatch(md, /95% upper bound \d/);
});

test("parseGdbCapture: known +2^42 signature (real transcript)", () => {
  const r = parseGdbCapture(readFixture("gdb-known.txt"));
  assert.equal(r.captured, true);
  assert.equal(r.instruction, "addl $0x1,0x1c0(%r13)");
  assert.equal(r.knownInstruction, true);
  assert.equal(r.registers.r13, "0x6720080");
  assert.equal(r.rip, "0x00007fffd7dcfc74");
  assert.equal(r.siAddr, "0x40006720240");
  assert.equal(r.siAddrSource, "explicit");
  assert.equal(r.intendedAddr, "0x6720240");
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.intendedMappingFile, "[heap]");
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.siAddrMapped, false);
  assert.equal(r.addrDiffHex, "0x40000000000");
  assert.deepEqual(r.diffBits, [42]);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, true);
  assert.equal(r.classification, "known-signature");
  assert.equal(r.threadCount, 11);
  assert.equal(r.processId, 2689857);
  assert.ok(r.mappings.length > 100);
});

test("parseGdbCapture: accepts GDB's lowercase objfile mapping header", () => {
  const text = readFixture("gdb-known.txt").replace("Perms File ", "Perms objfile ");
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.siAddrMapped, false);
  assert.equal(r.matchesKnownSignature, true);
  assert.equal(r.classification, "known-signature");
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
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.siAddrMapped, false);
  assert.ok(r.notes.some((n) => n.includes("manual classification")));
  assert.equal(r.threadCount, 2);
});

test("parseGdbCapture: bit-flip arithmetic without mapping data is unverified", () => {
  // Same transcript as gdb-known.txt but with the mappings section removed.
  const text = readFixture("gdb-known.txt").split("Mapped address spaces:")[0];
  const r = parseGdbCapture(text);
  assert.equal(r.captured, true);
  assert.equal(r.knownInstruction, true);
  assert.equal(r.intendedAddr, "0x6720240");
  assert.equal(r.mappings.length, 0);
  assert.equal(r.intendedMapped, null);
  assert.equal(r.intendedWritable, null);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.addrDiffHex, "0x40000000000");
  assert.deepEqual(r.diffBits, [42]);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("no complete mapping data in transcript")));
  assert.ok(r.notes.some((n) => n.includes("mapping preconditions are not verified")));
});

test("parseGdbCapture: complete-looking legacy mappings without a marker cannot confirm absence", () => {
  const text = readFixture("gdb-known.txt").replace("MAPPINGS_COMPLETE=1\n", "");
  const r = parseGdbCapture(text);
  assert.equal(r.mappings.length > 100, true);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("mapping table did not complete")));
});

test("parseGdbCapture: truncated mappings retain positive membership but not absence", () => {
  const lines = readFixture("gdb-known.txt").split("\n");
  const heapRow = lines.findIndex((line) => line.endsWith("rw-p  [heap] "));
  assert.notEqual(heapRow, -1);
  const r = parseGdbCapture(`${lines.slice(0, heapRow + 1).join("\n")}\n`);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
});

test("parseGdbCapture: an unrecognized marked mapping row fails closed", () => {
  const text = readFixture("gdb-known.txt").replace(
    "MAPPINGS_COMPLETE=1",
    "0x0000040006700000 0x0000040006800000 rw-p [shifted alternate format]\nMAPPINGS_COMPLETE=1",
  );
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("unrecognized nonblank row")));
});

test("parseGdbCapture: impossible mapping permissions fail closed", () => {
  const text = readFixture("gdb-known.txt").replace("rw-p  [heap]", "wwwp  [heap]");
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.intendedMapped, null);
  assert.equal(r.intendedWritable, null);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
});

test("parseGdbCapture: a hidden row before the mapping header fails closed", () => {
  const header = "Start Addr         End Addr           Size               Offset             Perms File ";
  const text = readFixture("gdb-known.txt").replace(
    header,
    `0x0000040006700000 0x0000040006800000 0x100000           0x0                rw-p  [pre-header shifted]\n${header}`,
  );
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, false);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.siAddrMapped, null);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("before its expected header")));
});

test("parseGdbCapture: rows after the completion marker are not mapping evidence", () => {
  const text = `${readFixture("gdb-known.txt")}0x0000040006700000 0x0000040006800000 0x100000           0x0                rw-p  [late shifted]\n`;
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.siAddrMapped, false);
  assert.equal(r.matchesKnownSignature, true);
  assert.equal(r.mappings.some((mapping) => mapping.file === "[late shifted]"), false);
});

test("parseGdbCapture: explicit nil SI_ADDR cannot be overwritten by CR2-like values", () => {
  const text = readFixture("gdb-known.txt").replace(
    "SI_ADDR=0x40006720240",
    "SI_ADDR=(nil)\n$1 = 0x40006720240\nCR2=0x40006720240",
  );
  const r = parseGdbCapture(text);
  assert.equal(r.siAddr, null);
  assert.equal(r.siAddrSource, "explicit-nil");
  assert.equal(r.cr2, "0x40006720240");
  assert.equal(r.cr2Source, "explicit");
  assert.equal(r.matchesKnownArithmetic, false);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "manual");
  assert.ok(r.notes.some((note) => note.includes("explicitly reported as nil")));
});

test("parseGdbCapture: legacy $1 fallback is retained but cannot confirm signature", () => {
  const text = readFixture("gdb-known.txt").replace("SI_ADDR=", "$1 = ");
  const r = parseGdbCapture(text);
  assert.equal(r.siAddr, "0x40006720240");
  assert.equal(r.siAddrSource, "legacy-convenience");
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((note) => note.includes("ambiguous legacy GDB convenience variable")));
});

test("parseGdbCapture: unrelated convenience variables are not SI_ADDR fallback", () => {
  const text = readFixture("gdb-known.txt").replace("SI_ADDR=0x40006720240", "$2 = 0x40006720240");
  const r = parseGdbCapture(text);
  assert.equal(r.siAddr, null);
  assert.equal(r.siAddrSource, null);
  assert.equal(r.matchesKnownArithmetic, false);
  assert.equal(r.matchesKnownSignature, false);
});

test("parseGdbCapture: bit-flip into a non-writable mapping is unverified", () => {
  const text = readFixture("gdb-known.txt").replace("rw-p  [heap]", "r--p  [heap]");
  const r = parseGdbCapture(text);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, false);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("intended mapping is not writable")));
});

test("parseGdbCapture: bit-flip with intended address unmapped is unverified", () => {
  const base = readFixture("gdb-known.txt").split("Mapped address spaces:")[0];
  const text = `${base}Mapped address spaces:\n\nStart Addr         End Addr           Size               Offset             Perms File \n0x0000000000400000 0x000000000078f000 0x38f000           0x0                r--p  /usr/bin/node \n0x00007ffffffde000 0x00007ffffffff000 0x21000            0x0                rw-p  [stack] \nMAPPINGS_COMPLETE=1\n`;
  const r = parseGdbCapture(text);
  assert.equal(r.mappings.length, 2);
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.intendedMapped, false);
  assert.equal(r.intendedWritable, false);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("intended address not found in process mappings")));
});

test("parseGdbCapture: mapped shifted address is not a confirmed signature", () => {
  const text = readFixture("gdb-known.txt").replace(
    "0x000004d1f3e00000",
    "0x0000040006700000 0x0000040006800000 0x100000           0x0                rw-p  [shifted]\n0x000004d1f3e00000",
  );
  const r = parseGdbCapture(text);
  assert.equal(r.mappingsComplete, true);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.siAddrMapped, true);
  assert.equal(r.matchesKnownArithmetic, true);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "bit-flip-unverified");
  assert.ok(r.notes.some((n) => n.includes("shifted fault address is itself mapped")));
});

test("parseGdbCapture: arithmetic mismatch stays manual", () => {
  // si_addr = intended + 0x100 (single differing bit 8, not the signature).
  const text = readFixture("gdb-known.txt").replace("SI_ADDR=0x40006720240", "SI_ADDR=0x6720340");
  const r = parseGdbCapture(text);
  assert.equal(r.knownInstruction, true);
  assert.equal(r.intendedMapped, true);
  assert.equal(r.intendedWritable, true);
  assert.equal(r.addrDiffHex, "0x100");
  assert.deepEqual(r.diffBits, [8]);
  assert.equal(r.matchesKnownSignature, false);
  assert.equal(r.classification, "manual");
  assert.ok(r.notes.some((n) => n.includes("not the documented +2^42 signature")));
});

test("parseGdbCapture: clean exit transcript has no fault", () => {
  const r = parseGdbCapture(readFixture("gdb-clean.txt"));
  assert.equal(r.captured, false);
  assert.equal(r.classification, "no-fault");
  assert.equal(r.siAddr, null);
});
