import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const groupsGeneration = "0123456789abcdef0123456789abcdef";
const plan = [
  ["pcores", "pcore", "0-3", "-", "4", "5", "logs/groups/pcores.log", "group-pcores"],
  [l2Name, "ecluster", "4-7", l2Cluster, "4", "5", `logs/groups/${l2Name}.log`, `group-${l2Name}`],
];

function rowsText(rows = plan.map((row, index) => [...row, index === 0 ? "0" : "1"])) {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

function metaText(overrides = {}) {
  const values = {
    VERSION: "2",
    GENERATION: groupsGeneration,
    EXPECTED_ROWS: "2",
    GROUP_WAVES: "5",
    PLAN_DIGEST: groupsPlanDigest(plan),
    COMPLETED: "1",
    ...overrides,
  };
  return `VERSION=${values.VERSION}\nGENERATION=${values.GENERATION}\nEXPECTED_ROWS=${values.EXPECTED_ROWS}\nGROUP_WAVES=${values.GROUP_WAVES}\nPLAN_DIGEST=${values.PLAN_DIGEST}\nCOMPLETED=${values.COMPLETED}\n`;
}

function metaTextV1(overrides = {}) {
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
  assert.equal(result.meta.GENERATION, groupsGeneration);
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
  assert.deepEqual(deriveIndividualTargetPolicy(result, "default"), {
    targetPolicy: "failed-groups",
    targetCpus: "4-7",
    groupPlanDigest: groupsPlanDigest(plan),
    groupGeneration: groupsGeneration,
    skipped: false,
  });
  assert.deepEqual(deriveIndividualTargetPolicy(result, "quick"), {
    targetPolicy: "failed-groups",
    targetCpus: "4-7",
    groupPlanDigest: groupsPlanDigest(plan),
    groupGeneration: groupsGeneration,
    skipped: false,
  });
  assert.deepEqual(deriveIndividualTargetPolicy(result, "full"), {
    targetPolicy: "all-group-cpus",
    targetCpus: "0-7",
    groupPlanDigest: groupsPlanDigest(plan),
    groupGeneration: groupsGeneration,
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
    groupGeneration: groupsGeneration,
    skipped: true,
  });
  assert.equal(deriveIndividualTargetPolicy(clean, "default").targetCpus, "0-7");
  assert.deepEqual(deriveIndividualTargetPolicy(clean, "full"), {
    targetPolicy: "all-group-cpus",
    targetCpus: "0-7",
    groupPlanDigest: groupsPlanDigest(plan),
    groupGeneration: groupsGeneration,
    skipped: false,
  });
});

test("full-mode target union deduplicates overlapping stored group ranges", () => {
  const dir = bundle();
  const overlappingPlan = [
    plan[0],
    ["ecores", "ecore", "4-7", "-", "4", "5", "logs/groups/ecores.log", "group-ecores"],
    plan[1],
  ];
  writeFileSync(path.join(dir, "results", "groups.tsv"), rowsText([
    [...overlappingPlan[0], "0"],
    [...overlappingPlan[1], "1"],
    [...overlappingPlan[2], "1"],
  ]));
  writeFileSync(path.join(dir, "results", "groups.meta"), [
    "VERSION=2",
    `GENERATION=${groupsGeneration}`,
    "EXPECTED_ROWS=3",
    "GROUP_WAVES=5",
    `PLAN_DIGEST=${groupsPlanDigest(overlappingPlan)}`,
    "COMPLETED=1",
    "",
  ].join("\n"));
  copyFileSync(path.join(fixtures, "repro-fail.log"), path.join(dir, "logs", "groups", "ecores.log"));
  const result = assessGroupsEvidence(dir, {
    expectedGroupWaves: 5,
    expectedPlanRows: overlappingPlan,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(deriveIndividualTargetPolicy(result, "full"), {
    targetPolicy: "all-group-cpus",
    targetCpus: "0-7",
    groupPlanDigest: groupsPlanDigest(overlappingPlan),
    groupGeneration: groupsGeneration,
    skipped: false,
  });
  assert.equal(deriveIndividualTargetPolicy(result, "default").targetCpus, "4-7");
});

test("collector binds full-mode individual evidence to every stored group-plan CPU", () => {
  const dir = bundle();
  writeFileSync(
    path.join(dir, "results", "meta.env"),
    "MODE=full\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\nINDIVIDUAL_RUNS=2\nGDB_MAX_RUNS=2\nSKIP_GDB=1\nCPU_TARGET=auto\n",
  );
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  const individualRows = (cpus) => `${cpus.flatMap((cpu) => [
    `${cpu}\t1\t0\t1`,
    `${cpu}\t2\t${cpu === 7 ? 139 : 0}\t1`,
  ]).join("\n")}\n`;
  const individualMeta = (targets, policy, rows, groupGeneration = groupsGeneration) => [
    "VERSION=4",
    `GENERATION=${"a".repeat(32)}`,
    `TARGET_CPUS=${targets}`,
    "RUNS_PER_CPU=2",
    `TARGET_POLICY=${policy}`,
    `GROUP_PLAN_DIGEST=${groupsPlanDigest(plan)}`,
    `GROUP_GENERATION=${groupGeneration}`,
    "SKIPPED=0",
    "COMPLETED=1",
    `ROWS_SHA256=${createHash("sha256").update(rows).digest("hex")}`,
    `ROWS_BYTES=${Buffer.byteLength(rows)}`,
    `ROW_COUNT=${rows.trimEnd().split("\n").length}`,
    "",
  ].join("\n");

  const completeRows = individualRows([0, 1, 2, 3, 4, 5, 6, 7]);
  writeFileSync(path.join(dir, "results", "individual.tsv"), completeRows);
  writeFileSync(path.join(dir, "results", "individual.meta"), individualMeta("0-7", "all-group-cpus", completeRows));
  const complete = collect(dir);
  assert.equal(complete.groupsStatus.status, "complete");
  assert.equal(complete.individualStatus.status, "complete");
  assert.deepEqual(complete.individual.map(({ cpu }) => cpu), [0, 1, 2, 3, 4, 5, 6, 7]);

  const staleRows = individualRows([4, 5, 6, 7]);
  writeFileSync(path.join(dir, "results", "individual.tsv"), staleRows);
  writeFileSync(path.join(dir, "results", "individual.meta"), individualMeta("4-7", "failed-groups", staleRows));
  const stale = collect(dir);
  assert.equal(stale.individualStatus.status, "invalid");
  assert.match(stale.individualStatus.reasons.join("; "), /does not match/);
  assert.equal(stale.individual, undefined);
  assert.equal(stale.worstCpu, null);

  // A redone groups phase mints a new generation for the same topology plan.
  // Individual evidence bound only to the reproducible plan digest (a stale
  // GROUP_GENERATION) must lose authority even though every row still parses.
  writeFileSync(path.join(dir, "results", "individual.tsv"), completeRows);
  writeFileSync(path.join(dir, "results", "individual.meta"),
    individualMeta("0-7", "all-group-cpus", completeRows, "b".repeat(32)));
  const staleGeneration = collect(dir);
  assert.equal(staleGeneration.groupsStatus.status, "complete");
  assert.equal(staleGeneration.individualStatus.status, "invalid");
  assert.match(staleGeneration.individualStatus.reasons.join("; "),
    /not bound to the validated groups generation/);
  assert.equal(staleGeneration.individual, undefined);
  assert.equal(staleGeneration.worstCpu, null);
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

test("collector preserves matching V1/V2/V3 individual evidence descriptively without authorization", () => {
  const dir = bundle();
  writeFileSync(path.join(dir, "state", "phase-individual.done"), "");
  const rows = [4, 5, 6, 7].flatMap((cpu) => [
    `${cpu}\t1\t${cpu === 4 ? 139 : 0}\t1`,
    `${cpu}\t2\t0\t1`,
  ]).join("\n") + "\n";
  writeFileSync(path.join(dir, "results", "individual.tsv"), rows);

  writeFileSync(path.join(dir, "results", "individual.meta"), [
    "VERSION=3",
    `GENERATION=${"a".repeat(32)}`,
    "TARGET_CPUS=4-7",
    "RUNS_PER_CPU=2",
    "TARGET_POLICY=failed-groups",
    `GROUP_PLAN_DIGEST=${groupsPlanDigest(plan)}`,
    "SKIPPED=0",
    "COMPLETED=1",
    `ROWS_SHA256=${createHash("sha256").update(rows).digest("hex")}`,
    `ROWS_BYTES=${Buffer.byteLength(rows)}`,
    `ROW_COUNT=${rows.trimEnd().split("\n").length}`,
    "",
  ].join("\n"));
  const version3 = collect(dir);
  assert.equal(version3.groupsStatus.status, "complete");
  assert.equal(version3.individualStatus.status, "incomplete");
  assert.match(version3.individualStatus.reasons.join("; "), /version 3.*descriptive only/);
  assert.match(version3.individualStatus.reasons.join("; "), /not bound to the exact validated groups generation/);
  assert.deepEqual(version3.individual.map(({ cpu }) => cpu), [4, 5, 6, 7]);
  assert.equal(version3.individual[0].sigsegv, 1);
  assert.equal(version3.worstCpu, null);
  assert.equal(version3.cpuSelectionStatus.status, "unavailable");

  writeFileSync(path.join(dir, "results", "individual.meta"), [
    "VERSION=2",
    "TARGET_CPUS=4-7",
    "RUNS_PER_CPU=2",
    "TARGET_POLICY=failed-groups",
    `GROUP_PLAN_DIGEST=${groupsPlanDigest(plan)}`,
    "SKIPPED=0",
    "COMPLETED=1",
    "",
  ].join("\n"));
  const version2 = collect(dir);
  assert.equal(version2.individualStatus.status, "incomplete");
  assert.match(version2.individualStatus.reasons.join("; "), /version 2.*descriptive only/);
  assert.deepEqual(version2.individual.map(({ cpu }) => cpu), [4, 5, 6, 7]);
  assert.equal(version2.individual[0].sigsegv, 1);
  assert.equal(version2.worstCpu, null);
  assert.equal(version2.cpuSelectionStatus.status, "unavailable");

  writeFileSync(path.join(dir, "results", "individual.meta"), [
    "VERSION=1",
    "TARGET_CPUS=4-7",
    "RUNS_PER_CPU=2",
    "SKIPPED=0",
    "COMPLETED=1",
    "",
  ].join("\n"));
  const version1 = collect(dir);
  assert.equal(version1.individualStatus.status, "incomplete");
  assert.match(version1.individualStatus.reasons.join("; "), /version 1.*descriptive only/);
  assert.deepEqual(version1.individual.map(({ cpu }) => cpu), [4, 5, 6, 7]);
  assert.equal(version1.individual[0].sigsegv, 1);
  assert.equal(version1.worstCpu, null);
  assert.equal(version1.cpuSelectionStatus.status, "unavailable");
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
    metaText().replace("VERSION=2", "VERSION=02"),
    metaText().replace("EXPECTED_ROWS=2", "EXPECTED_ROWS=02"),
    metaText().replace("GROUP_WAVES=5", "GROUP_WAVES=5e0"),
    metaText().replace(/PLAN_DIGEST=.*/, "PLAN_DIGEST=../outside"),
    metaText().replace("COMPLETED=1", "COMPLETED=true"),
    metaText().replace("VERSION=2", "VERSION=2\nVERSION=2"),
  ]) {
    assert.equal(assessGroupsEvidence(bundle({ meta }), expectations).status, "invalid", meta);
  }
  assert.equal(assessGroupsEvidence(bundle(), { ...expectations, expectedGroupWaves: 6 }).status, "invalid");
});

test("version 2 groups envelopes require exactly one well-formed generation", () => {
  for (const meta of [
    metaText().replace(`GENERATION=${groupsGeneration}\n`, ""),
    metaText().replace(`GENERATION=${groupsGeneration}`, "GENERATION=0123456789abcdef0123456789abcde"),
    metaText().replace(`GENERATION=${groupsGeneration}`, `GENERATION=${groupsGeneration.toUpperCase()}`),
    metaText().replace(`GENERATION=${groupsGeneration}`, "GENERATION=../outside"),
    metaText().replace(`GENERATION=${groupsGeneration}`, `GENERATION=${groupsGeneration}\nGENERATION=${groupsGeneration}`),
  ]) {
    assert.equal(assessGroupsEvidence(bundle({ meta }), expectations).status, "invalid", meta);
  }
});

test("legacy version 1 groups evidence stays parseable but cannot authorize conclusions", () => {
  const legacy = assessGroupsEvidence(bundle({ meta: metaTextV1() }), expectations);
  assert.equal(legacy.status, "incomplete");
  assert.match(legacy.reasons.join("; "), /legacy groups metadata has no generation/);
  assert.match(legacy.reasons.join("; "), /cannot authorize conclusions/);
  assert.equal(deriveIndividualTargetPolicy(legacy, "quick"), null);
  assert.equal(deriveIndividualTargetPolicy(legacy, "full"), null);
  const collected = collect(bundle({ meta: metaTextV1() }));
  assert.equal(collected.groupsStatus.status, "incomplete");
  assert.equal(collected.groups, undefined);

  // A version 1 envelope must not smuggle a generation into its grammar.
  const smuggled = assessGroupsEvidence(
    bundle({ meta: metaTextV1().replace("VERSION=1", `VERSION=1\nGENERATION=${groupsGeneration}`) }),
    expectations,
  );
  assert.equal(smuggled.status, "invalid");
});

test("--individual-targets prints the exact validated groups generation", () => {
  const dir = bundle();
  const planFile = path.join(dir, "plan.tsv");
  writeFileSync(planFile, `${plan.map((row) => row.join("\t")).join("\n")}\n`);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "groups-evidence.mjs");
  const result = spawnSync(process.execPath, [script, "--individual-targets", dir, planFile, "5", "default"]);
  assert.equal(result.status, 0, result.stderr.toString());
  const output = result.stdout.toString();
  assert.match(output, new RegExp(`^GROUP_PLAN_DIGEST=${groupsPlanDigest(plan)}$`, "m"));
  assert.match(output, new RegExp(`^GROUP_GENERATION=${groupsGeneration}$`, "m"));
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
