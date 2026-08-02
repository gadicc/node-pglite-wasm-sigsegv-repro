import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../collect.mjs";
import {
  assessGroupsEvidence,
  checkFreshGroupsTargets,
  deriveIndividualTargetPolicy,
  groupsPlanDigest,
} from "../groups-evidence.mjs";
import { renderReport } from "../report.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const l2Cluster = "l2:4-7";
const l2Name = `ecluster-l2-${createHash("sha256").update(l2Cluster).digest("hex").slice(0, 12)}`;
const plan = [
  ["pcores", "pcore", "0-3", "-", "4", "5", "logs/groups/pcores.log", "group-pcores"],
  [l2Name, "ecluster", "4-7", l2Cluster, "4", "5", `logs/groups/${l2Name}.log`, `group-${l2Name}`],
];

function rowsText(rows = plan.map((row, index) => [...row, index === 0 ? "0" : "1"])) {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

function metaText(overrides = {}) {
  const values = {
    VERSION: "1",
    EXPECTED_ROWS: "2",
    GROUP_WAVES: "5",
    PLAN_DIGEST: groupsPlanDigest(plan),
    COMPLETED: "1",
    ...overrides,
  };
  return `VERSION=${values.VERSION}\nEXPECTED_ROWS=${values.EXPECTED_ROWS}\nGROUP_WAVES=${values.GROUP_WAVES}\nPLAN_DIGEST=${values.PLAN_DIGEST}\nCOMPLETED=${values.COMPLETED}\n`;
}

function bundle({ meta = metaText(), rows = rowsText(), marker = true, logs = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "groups-evidence-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "results"));
  mkdirSync(path.join(dir, "logs", "groups"), { recursive: true });
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "freq"));
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    "MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\nINDIVIDUAL_RUNS=2\nGDB_MAX_RUNS=2\nSKIP_GDB=1\nCPU_TARGET=auto\n",
  );
  if (meta !== null) writeFileSync(path.join(dir, "results", "groups.meta"), meta);
  if (rows !== null) writeFileSync(path.join(dir, "results", "groups.tsv"), rows);
  if (marker) writeFileSync(path.join(dir, "state", "phase-groups.done"), "");
  if (logs) {
    copyFileSync(path.join(fixtures, "repro-clean-4x5.log"), path.join(dir, "logs", "groups", "pcores.log"));
    copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(dir, "logs", "groups", `${l2Name}.log`));
  }
  return dir;
}

const expectations = { expectedGroupWaves: 5, expectedPlanRows: plan };

test("groups envelope accepts one ordered plan generation and retains l2 cluster identity", () => {
  const dir = bundle();
  const result = assessGroupsEvidence(dir, expectations);
  assert.equal(result.status, "complete");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].clusterId, l2Cluster);
  const collected = collect(dir);
  assert.equal(collected.groupsStatus.status, "complete");
  assert.equal(collected.groups[1].clusterId, l2Cluster);
  assert.equal(collected.groups[1].sigsegvCount, 2);
});

test("individual targets come from validated failed waves, including summary-only failures", () => {
  const dir = bundle();
  writeFileSync(path.join(dir, "logs", "groups", `${l2Name}.log`), [
    "node=v25.2.1 v8=test platform=linux arch=x64 children=4 waves=5",
    "wave=1 passed=3/4",
    "wave=2 passed=4/4",
    "wave=3 passed=4/4",
    "wave=4 passed=4/4",
    "wave=5 passed=4/4",
    "failedWaves=1 completedWaves=5 requestedWaves=5",
    "",
  ].join("\n"));
  const result = assessGroupsEvidence(dir, expectations);
  assert.equal(result.status, "complete");
  assert.equal(result.entries[1].parsed.failedWaves, 1);
  assert.equal(result.entries[1].parsed.failures.length, 0);
  assert.deepEqual(deriveIndividualTargetPolicy(result, "quick"), {
    targetPolicy: "failed-groups",
    targetCpus: "4-7",
    groupPlanDigest: groupsPlanDigest(plan),
    skipped: false,
  });

  copyFileSync(path.join(fixtures, "repro-clean-4x5.log"), path.join(dir, "logs", "groups", `${l2Name}.log`));
  writeFileSync(path.join(dir, "results", "groups.tsv"), rowsText(plan.map((row) => [...row, "0"])));
  const clean = assessGroupsEvidence(dir, expectations);
  assert.equal(clean.status, "complete");
  assert.deepEqual(deriveIndividualTargetPolicy(clean, "quick"), {
    targetPolicy: "quick-skip",
    targetCpus: "",
    groupPlanDigest: groupsPlanDigest(plan),
    skipped: true,
  });
  assert.equal(deriveIndividualTargetPolicy(clean, "default").targetCpus, "0-7");
});

test("collector rejects individual evidence from a different group target policy", () => {
  const dir = bundle();
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  writeFileSync(path.join(dir, "results", "individual.tsv"),
    "0\t1\t139\t1\n0\t2\t0\t1\n");
  writeFileSync(path.join(dir, "results", "individual.meta"), [
    "VERSION=2",
    "TARGET_CPUS=0",
    "RUNS_PER_CPU=2",
    "TARGET_POLICY=failed-groups",
    `GROUP_PLAN_DIGEST=${groupsPlanDigest(plan)}`,
    "SKIPPED=0",
    "COMPLETED=1",
    "",
  ].join("\n"));
  const result = collect(dir);
  assert.equal(result.groupsStatus.status, "complete");
  assert.equal(result.individualStatus.status, "invalid");
  assert.match(result.individualStatus.reasons.join("; "), /does not match/);
  assert.equal(result.individual, undefined);
  assert.equal(result.worstCpu, null);
});

test("groups envelope distinguishes absent, marker-only, missing, and exact interrupted prefixes", () => {
  const absent = bundle({ meta: null, rows: null, marker: false, logs: false });
  assert.equal(assessGroupsEvidence(absent, expectations).status, "not-run");
  assert.equal(assessGroupsEvidence(bundle({ meta: null, rows: null, logs: false }), expectations).status, "incomplete");
  assert.equal(assessGroupsEvidence(bundle({ meta: metaText(), rows: null }), expectations).status, "incomplete");

  const prefix = bundle({
    meta: metaText({ COMPLETED: "0" }),
    rows: rowsText([[...plan[0], "0"]]),
    marker: false,
    logs: false,
  });
  copyFileSync(path.join(fixtures, "repro-clean-4x5.log"), path.join(prefix, "logs", "groups", "pcores.log"));
  const result = assessGroupsEvidence(prefix, { ...expectations, requireMarker: false });
  assert.equal(result.status, "incomplete");
  assert.doesNotMatch(result.reasons.join("; "), /not an exact prefix|generation digest/);
});

test("groups TSV rejects short, extra, noncanonical, huge, unsafe, and inconsistent fields", () => {
  const variants = [
    rowsText([[...plan[0].slice(0, 7), "0"]]),
    rowsText([[...plan[0], "0", "extra"]]),
    rowsText([[...plan[0].slice(0, 4), "04", ...plan[0].slice(5), "0"]]),
    rowsText([[...plan[0].slice(0, 5), "5e0", ...plan[0].slice(6), "0"]]),
    rowsText([[...plan[0].slice(0, 2), "0-9999999999999999", ...plan[0].slice(3), "0"]]),
    rowsText([["../outside", ...plan[0].slice(1), "0"]]),
    rowsText([[...plan[0].slice(0, 3), "l2:0-3", ...plan[0].slice(4), "0"]]),
    rowsText([[...plan[0].slice(0, 8), "139"]]),
    rowsText([[...plan[0].slice(0, 2), "0,0", ...plan[0].slice(3), "0"]]),
    rowsText([[...plan[0].slice(0, 2), "3-4,2", ...plan[0].slice(3), "0"]]),
    rowsText([[...plan[0].slice(0, 2), "0-2,3-4", ...plan[0].slice(3), "0"]]),
    rowsText([[...plan[0].slice(0, 1), "wrong-kind", ...plan[0].slice(2), "0"]]),
  ];
  for (const rows of variants) {
    const result = assessGroupsEvidence(bundle({ rows }), expectations);
    assert.equal(result.status, "invalid", rows);
    assert.doesNotThrow(() => collect(bundle({ rows })));
  }
});

test("fresh-target inspection short-circuits before unsafe plan paths are resolved", () => {
  const dir = bundle({ meta: null, rows: null, marker: false, logs: false });
  const unsafe = [[
    "../../../outside", "pcore", "0-3", "-", "4", "5",
    "logs/groups/../../../outside.log", "group-../../../outside",
  ]];
  const reasons = checkFreshGroupsTargets(dir, unsafe);
  assert.match(reasons.join("; "), /unsafe|inconsistent|noncanonical/);
  assert.equal(reasons.some((reason) => reason.includes("already exists")), false);
});

test("groups metadata rejects malformed generations and config mismatches", () => {
  for (const meta of [
    metaText().replace("VERSION=1", "VERSION=01"),
    metaText().replace("EXPECTED_ROWS=2", "EXPECTED_ROWS=02"),
    metaText().replace("GROUP_WAVES=5", "GROUP_WAVES=5e0"),
    metaText().replace(/PLAN_DIGEST=.*/, "PLAN_DIGEST=../outside"),
    metaText().replace("COMPLETED=1", "COMPLETED=true"),
    metaText().replace("VERSION=1", "VERSION=1\nVERSION=1"),
  ]) {
    assert.equal(assessGroupsEvidence(bundle({ meta }), expectations).status, "invalid", meta);
  }
  assert.equal(assessGroupsEvidence(bundle(), { ...expectations, expectedGroupWaves: 6 }).status, "invalid");
});

test("collector cannot authorize groups with duplicate stored GROUP_WAVES configuration", () => {
  const dir = bundle();
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    "BASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\nGROUP_WAVES=5\n",
  );
  const result = collect(dir);
  assert.equal(result.configStatus.status, "invalid");
  assert.equal(result.config.groupWaves, null);
  assert.equal(result.groupsStatus.status, "invalid");
  assert.equal(result.groups, undefined);
});

test("groups plan binding detects missing, invented, reordered, and duplicate rows", () => {
  const missing = assessGroupsEvidence(bundle({ rows: rowsText([[...plan[0], "0"]]) }), expectations);
  assert.equal(missing.status, "incomplete");

  const inventedPlan = [...plan[0]];
  inventedPlan[2] = "8-11";
  const invented = assessGroupsEvidence(bundle({ rows: rowsText([[...inventedPlan, "0"], [...plan[1], "1"]]) }), expectations);
  assert.equal(invented.status, "invalid");

  const reordered = assessGroupsEvidence(bundle({ rows: rowsText([[...plan[1], "1"], [...plan[0], "0"]]) }), expectations);
  assert.equal(reordered.status, "invalid");

  const duplicate = assessGroupsEvidence(bundle({ rows: rowsText([[...plan[0], "0"], [...plan[0], "0"]]) }), expectations);
  assert.equal(duplicate.status, "invalid");
});

test("groups logs must be fixed regular in-bundle files and parse against their row", () => {
  const outside = bundle();
  const linked = bundle({ logs: false });
  symlinkSync(path.join(outside, "logs", "groups", "pcores.log"), path.join(linked, "logs", "groups", "pcores.log"));
  copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(linked, "logs", "groups", `${l2Name}.log`));
  assert.equal(assessGroupsEvidence(linked, expectations).status, "invalid");
  assert.equal(collect(linked).groups, undefined);

  const directory = bundle({ logs: false });
  mkdirSync(path.join(directory, "logs", "groups", "pcores.log"));
  copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(directory, "logs", "groups", `${l2Name}.log`));
  assert.equal(assessGroupsEvidence(directory, expectations).status, "invalid");

  const mismatch = bundle();
  copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(mismatch, "logs", "groups", "pcores.log"));
  assert.equal(assessGroupsEvidence(mismatch, expectations).status, "invalid");

  const parentLink = bundle({ logs: false });
  rmSync(path.join(parentLink, "logs", "groups"), { recursive: true });
  symlinkSync(path.join(outside, "logs", "groups"), path.join(parentLink, "logs", "groups"));
  assert.equal(assessGroupsEvidence(parentLink, expectations).status, "invalid");
});

test("collector does not follow traversal or frequency symlinks and gates the report", () => {
  const outside = bundle();
  writeFileSync(path.join(outside, "outside.samples"), "1 0 999999\n");
  const dir = bundle();
  symlinkSync(path.join(outside, "outside.samples"), path.join(dir, "freq", "group-pcores.samples"));
  const result = collect(dir);
  assert.equal(result.groupsStatus.status, "invalid");
  assert.equal(result.groups, undefined);
  const report = renderReport(result);
  assert.match(report, /CPU-group evidence envelope: invalid/);
  assert.match(report, /Invalid CPU-group evidence was excluded|invalid CPU-group evidence was excluded/i);
  assert.doesNotMatch(report, /Group isolation.*pcores/);
});

test("groups control files reject symlinks, directories, oversized input, CRLF, NUL, and unterminated ambiguity", () => {
  const outside = bundle();
  const cases = [];

  const linkedTsv = bundle({ rows: null });
  symlinkSync(path.join(outside, "results", "groups.tsv"), path.join(linkedTsv, "results", "groups.tsv"));
  cases.push(linkedTsv);

  const markerLink = bundle({ marker: false });
  symlinkSync(path.join(outside, "state", "phase-groups.done"), path.join(markerLink, "state", "phase-groups.done"));
  cases.push(markerLink);

  const directoryTsv = bundle({ rows: null });
  mkdirSync(path.join(directoryTsv, "results", "groups.tsv"));
  cases.push(directoryTsv);

  const oversized = bundle({ rows: `${rowsText()}${"#".repeat(1024 * 1024)}` });
  cases.push(oversized);

  const crlf = bundle({ rows: rowsText().replaceAll("\n", "\r\n") });
  cases.push(crlf);

  const nul = bundle({ rows: rowsText().replace("pcores", "pcores\0evil") });
  cases.push(nul);

  const unterminated = bundle({ rows: rowsText().trimEnd() });
  cases.push(unterminated);

  for (const dir of cases) {
    assert.doesNotThrow(() => assessGroupsEvidence(dir, expectations));
    assert.notEqual(assessGroupsEvidence(dir, expectations).status, "complete");
    assert.doesNotThrow(() => collect(dir));
  }
});
