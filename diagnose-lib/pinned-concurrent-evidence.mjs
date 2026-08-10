// Strict, bounded evidence envelope for the pinned-concurrent phase.
//
// The immutable groups and plan files are always byte-for-byte digest-bound by
// metadata. During an interrupted run, results may be an exact prefix of the
// plan, but the resumable frontier advances only after a whole (round, group)
// wave. A partial wave is retained descriptively and must be rerun; it never
// enters an outcome denominator.

import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readStableRegularFile } from "./individual-evidence.mjs";

export const PINNED_CONCURRENT_VERSION = 1;
export const PINNED_CONCURRENT_SCHEDULE_ALGORITHM = "balanced-cyclic-v1";
export const PINNED_CONCURRENT_GROUPS_HEADER = "group\tkind\tcpus\tcluster\tcontroller_cpu\trounds";
export const PINNED_CONCURRENT_PLAN_HEADER = "ordinal\tround\tgroup_position\tgroup\tcontroller_cpu\tlaunch_position\tcpu";
export const PINNED_CONCURRENT_RESULTS_HEADER = "round\tgroup\tcpu\tlaunch_position\trc\telapsed_ms";

export const PINNED_CONCURRENT_META_MAX_BYTES = 256 * 1024;
export const PINNED_CONCURRENT_GROUPS_MAX_BYTES = 256 * 1024;
export const PINNED_CONCURRENT_GROUPS_MAX_ROWS = 256;
export const PINNED_CONCURRENT_PLAN_MAX_BYTES = 512 * 1024 * 1024;
export const PINNED_CONCURRENT_RESULTS_MAX_BYTES = 512 * 1024 * 1024;
export const PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES = 512 * 1024 * 1024;
export const PINNED_CONCURRENT_PLAN_MAX_ROWS = 20_000_000;
export const PINNED_CONCURRENT_RESULTS_MAX_ROWS = 20_000_000;
export const PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS = PINNED_CONCURRENT_RESULTS_MAX_ROWS;
export const PINNED_CONCURRENT_BOUNDARY_ROW_MAX_BYTES = 4096;
export const PINNED_CONCURRENT_MARKER_MAX_BYTES = 4096;
export const PINNED_CONCURRENT_MAX_CPU = 65_535;

const GROUP_FIELDS = ["group", "kind", "cpus", "cluster", "controller_cpu", "rounds"];
const PLAN_FIELDS = [
  "ordinal", "round", "group_position", "group", "controller_cpu", "launch_position", "cpu",
];
const RESULT_FIELDS = ["round", "group", "cpu", "launch_position", "rc", "elapsed_ms"];
const BOUNDARY_FIELDS = [
  "ordinal",
  "round",
  "groupPosition",
  "group",
  "controllerCpu",
  "launchPosition",
  "cpu",
  "startUnixMs",
  "endUnixMs",
  "startMonotonicNs",
  "endMonotonicNs",
  "durationNs",
  "durationMs",
  "noTurboStart",
  "noTurboEnd",
];
const BASE_META_KEYS = [
  "VERSION",
  "GENERATION",
  "SOURCE_GROUP_GENERATION",
  "SOURCE_GROUP_PLAN_DIGEST",
  "ROUNDS_PER_CONTEXT",
  "SCHEDULE_SEED",
  "SCHEDULE_ALGORITHM",
  "GROUPS_SHA256",
  "GROUPS_BYTES",
  "GROUPS_ROW_COUNT",
  "PLAN_SHA256",
  "PLAN_BYTES",
  "PLAN_ROW_COUNT",
  "COMPLETED",
];
const ROW_BINDING_KEYS = ["ROWS_SHA256", "ROWS_BYTES", "ROW_COUNT"];
const BOUNDARY_BINDING_KEYS = ["BOUNDARIES_SHA256", "BOUNDARIES_BYTES", "BOUNDARY_ROW_COUNT"];
const TERMINAL_BINDING_KEYS = [...ROW_BINDING_KEYS, ...BOUNDARY_BINDING_KEYS];
const KNOWN_META_KEYS = new Set([...BASE_META_KEYS, ...TERMINAL_BINDING_KEYS]);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const GENERATION_RE = /^[a-f0-9]{32}$/;
const GROUP_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const TARGETS = Object.freeze({
  meta: ["results", "pinned-concurrent.meta"],
  groups: ["results", "pinned-concurrent.groups.tsv"],
  plan: ["results", "pinned-concurrent.plan.tsv"],
  results: ["results", "pinned-concurrent.tsv"],
  boundaries: ["results", "pinned-concurrent.boundaries.ndjson"],
  marker: ["state", "phase-pinned-concurrent.done"],
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalUint(value, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || text.length > 16 || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function canonicalPositiveUint(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = canonicalUint(value, maximum);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function exactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError("evidence content must be a string, Buffer, or Uint8Array");
}

function decodeUtf8(value, label, reasons) {
  try {
    return UTF8_DECODER.decode(exactBytes(value));
  } catch {
    reasons.push(`${label} is not canonical UTF-8 text`);
    return "";
  }
}

export function sha256PinnedConcurrentBytes(value) {
  return createHash("sha256").update(exactBytes(value)).digest("hex");
}

export function pinnedConcurrentFileBinding(value, rowCount) {
  const bytes = exactBytes(value);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new TypeError("rowCount must be a non-negative safe integer");
  }
  return { sha256: sha256PinnedConcurrentBytes(bytes), bytes: bytes.length, rowCount };
}

// CPU lists are compressed, increasing sets. Adjacent ranges must be merged,
// so strings such as "0-1,2" are rejected as noncanonical.
export function parsePinnedConcurrentCpuList(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return null;
  const cpus = [];
  let previous = -2;
  for (const token of value.split(",")) {
    const match = token.match(/^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/);
    if (!match) return null;
    const first = canonicalUint(match[1], PINNED_CONCURRENT_MAX_CPU);
    const last = match[2] === undefined ? first : canonicalUint(match[2], PINNED_CONCURRENT_MAX_CPU);
    if (first === null || last === null || first > last ||
        (match[2] !== undefined && first === last) || first <= previous + 1) return null;
    if (cpus.length + last - first + 1 > PINNED_CONCURRENT_MAX_CPU + 1) return null;
    for (let cpu = first; cpu <= last; cpu += 1) cpus.push(cpu);
    previous = last;
  }
  return cpus;
}

function validCluster(value) {
  if (value === "-" || value === "unknown") return true;
  if (canonicalUint(value, PINNED_CONCURRENT_MAX_CPU) !== null) return true;
  if (typeof value === "string" && /^topo:(unknown|0|[1-9][0-9]*):(unknown|0|[1-9][0-9]*)$/.test(value)) {
    const [, packageId, clusterId] = value.split(":");
    return (packageId === "unknown" || canonicalUint(packageId, PINNED_CONCURRENT_MAX_CPU) !== null) &&
      (clusterId === "unknown" || canonicalUint(clusterId, PINNED_CONCURRENT_MAX_CPU) !== null);
  }
  return typeof value === "string" && value.startsWith("l2:") &&
    parsePinnedConcurrentCpuList(value.slice(3)) !== null;
}

function fieldsFromRow(row, names) {
  const values = Array.isArray(row) ? row : names.map((name) => row?.[name]);
  if (values.length !== names.length) return null;
  return values.map((value) => typeof value === "number" ? String(value) : value);
}

function serializeRows(header, rows, names, parser, options) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const fields = rows.map((row) => fieldsFromRow(row, names));
  if (fields.some((row) => row === null || row.some((value) => typeof value !== "string"))) {
    throw new TypeError("every row must contain every canonical field");
  }
  const text = `${header}\n${fields.map((row) => row.join("\t")).join("\n")}${fields.length > 0 ? "\n" : ""}`;
  const parsed = parser(text, options);
  if (parsed.reasons.length > 0) throw new TypeError(parsed.reasons.join("; "));
  return text;
}

function parseTsv(value, header, fieldCount, maxRows, label) {
  const reasons = [];
  const text = decodeUtf8(value, label, reasons);
  if (text.includes("\r") || text.includes("\0")) reasons.push(`${label} contains a forbidden control byte`);
  if (!text.endsWith("\n")) reasons.push(`${label} must end with a newline`);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== header) reasons.push(`${label} has a noncanonical header`);
  if (lines.length > maxRows) reasons.push(`${label} exceeds the ${maxRows}-row limit`);
  const rows = [];
  const limit = Math.min(lines.length, maxRows + 1);
  for (let index = 0; index < limit; index += 1) {
    const fields = lines[index].split("\t");
    if (lines[index] === "" || fields.length !== fieldCount) {
      reasons.push(`${label} row ${index + 1} must contain exactly ${fieldCount} nonblank fields`);
      continue;
    }
    rows.push(fields);
  }
  return { rows, reasons };
}

export function validatePinnedConcurrentGroupsRows(rows, expectations = {}) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > PINNED_CONCURRENT_GROUPS_MAX_ROWS) {
    return [`pinned-concurrent groups must contain 1-${PINNED_CONCURRENT_GROUPS_MAX_ROWS} rows`];
  }
  const names = new Set();
  let rounds = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const group = row.group;
    const cpuList = parsePinnedConcurrentCpuList(row.cpus);
    if (!GROUP_RE.test(group ?? "")) reasons.push(`pinned-concurrent groups row ${index + 1} has an invalid group`);
    if (!KIND_RE.test(row.kind ?? "")) reasons.push(`pinned-concurrent groups row ${index + 1} has an invalid kind`);
    if (!cpuList) reasons.push(`pinned-concurrent groups row ${index + 1} has a noncanonical CPU list`);
    if (!validCluster(row.cluster)) reasons.push(`pinned-concurrent groups row ${index + 1} has an invalid cluster`);
    const controller = canonicalUint(row.controller_cpu, PINNED_CONCURRENT_MAX_CPU);
    if (controller === null) reasons.push(`pinned-concurrent groups row ${index + 1} has an invalid controller CPU`);
    else if (cpuList?.includes(controller)) {
      reasons.push(`pinned-concurrent groups row ${index + 1} places its controller inside the active CPU set`);
    }
    const rowRounds = canonicalPositiveUint(row.rounds, PINNED_CONCURRENT_PLAN_MAX_ROWS);
    if (rowRounds === null) reasons.push(`pinned-concurrent groups row ${index + 1} has invalid rounds`);
    else if (rounds === null) rounds = rowRounds;
    else if (rowRounds !== rounds) reasons.push("pinned-concurrent groups disagree on rounds");
    if (names.has(group)) reasons.push(`pinned-concurrent groups row ${index + 1} duplicates group ${group}`);
    names.add(group);
  }
  if (expectations.roundsPerContext !== undefined) {
    const expected = canonicalPositiveUint(expectations.roundsPerContext, PINNED_CONCURRENT_PLAN_MAX_ROWS);
    if (expected === null) reasons.push("expected rounds-per-context is invalid");
    else if (rounds !== null && rounds !== expected) reasons.push("pinned-concurrent groups disagree with expected rounds-per-context");
  }
  return unique(reasons);
}

export function parsePinnedConcurrentGroups(value, expectations = {}) {
  const parsed = parseTsv(
    value,
    PINNED_CONCURRENT_GROUPS_HEADER,
    GROUP_FIELDS.length,
    PINNED_CONCURRENT_GROUPS_MAX_ROWS,
    "pinned-concurrent groups",
  );
  const rows = parsed.rows.map(([group, kind, cpus, cluster, controller_cpu, rounds]) => ({
    group,
    kind,
    cpus,
    cluster,
    controller_cpu: canonicalUint(controller_cpu, PINNED_CONCURRENT_MAX_CPU) ?? controller_cpu,
    rounds: canonicalPositiveUint(rounds, PINNED_CONCURRENT_PLAN_MAX_ROWS) ?? rounds,
  }));
  parsed.reasons.push(...validatePinnedConcurrentGroupsRows(rows, expectations));
  return { rows, reasons: unique(parsed.reasons) };
}

export function serializePinnedConcurrentGroups(rows, expectations = {}) {
  return serializeRows(
    PINNED_CONCURRENT_GROUPS_HEADER,
    rows,
    GROUP_FIELDS,
    parsePinnedConcurrentGroups,
    expectations,
  );
}

function validatePlanFieldGrammar(rows) {
  const reasons = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (canonicalPositiveUint(row.ordinal, PINNED_CONCURRENT_PLAN_MAX_ROWS) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid ordinal`);
    }
    if (canonicalPositiveUint(row.round, PINNED_CONCURRENT_PLAN_MAX_ROWS) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid round`);
    }
    if (canonicalPositiveUint(row.group_position, PINNED_CONCURRENT_GROUPS_MAX_ROWS) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid group position`);
    }
    if (!GROUP_RE.test(row.group ?? "")) reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid group`);
    if (canonicalUint(row.controller_cpu, PINNED_CONCURRENT_MAX_CPU) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid controller CPU`);
    }
    if (canonicalPositiveUint(row.launch_position, PINNED_CONCURRENT_MAX_CPU + 1) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid launch position`);
    }
    if (canonicalUint(row.cpu, PINNED_CONCURRENT_MAX_CPU) === null) {
      reasons.push(`pinned-concurrent plan row ${index + 1} has an invalid CPU`);
    }
  }
  return reasons;
}

// Returns the exclusive row offsets that end complete group waves.
function validatePlanStructure(rows, groupsRows, roundsPerContext) {
  const reasons = [];
  const waveBoundaries = [];
  const groups = new Map(groupsRows.map((row) => {
    const cpuList = parsePinnedConcurrentCpuList(row.cpus);
    return [row.group, {
      ...row,
      controller: canonicalUint(row.controller_cpu, PINNED_CONCURRENT_MAX_CPU),
      cpuList,
      cpuSet: cpuList === null ? null : new Set(cpuList),
    }];
  }));
  const rounds = canonicalPositiveUint(roundsPerContext, PINNED_CONCURRENT_PLAN_MAX_ROWS);
  if (rounds === null || groups.size !== groupsRows.length || groupsRows.length === 0 ||
      [...groups.values()].some(({ cpuList, controller }) => !cpuList || controller === null)) {
    return { reasons: ["pinned-concurrent plan cannot be checked against invalid groups or rounds"], waveBoundaries };
  }
  const groupPositionCounts = new Map(groupsRows.map(({ group }) => [group, Array(groupsRows.length).fill(0)]));
  const launchPositionCounts = new Map(groupsRows.map(({ group }) => [
    group,
    new Map(groups.get(group).cpuList.map((cpu) => [
      cpu,
      Array(groups.get(group).cpuList.length).fill(0),
    ])),
  ]));
  let cursor = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const seenGroups = new Set();
    for (let groupPosition = 1; groupPosition <= groupsRows.length; groupPosition += 1) {
      const first = rows[cursor];
      if (!first) {
        reasons.push(`pinned-concurrent plan ends before round ${round}, group position ${groupPosition}`);
        return { reasons: unique(reasons), waveBoundaries };
      }
      const group = groups.get(first.group);
      if (!group) {
        reasons.push(`pinned-concurrent plan row ${cursor + 1} names an unknown group`);
        return { reasons: unique(reasons), waveBoundaries };
      }
      if (seenGroups.has(first.group)) {
        reasons.push(`pinned-concurrent plan round ${round} repeats group ${first.group}`);
        return { reasons: unique(reasons), waveBoundaries };
      }
      seenGroups.add(first.group);
      groupPositionCounts.get(first.group)[groupPosition - 1] += 1;
      const seenCpus = new Set();
      for (let launchPosition = 1; launchPosition <= group.cpuList.length; launchPosition += 1) {
        const row = rows[cursor];
        if (!row) {
          reasons.push(`pinned-concurrent plan ends inside round ${round}, group ${first.group}`);
          return { reasons: unique(reasons), waveBoundaries };
        }
        const expectedOrdinal = cursor + 1;
        if (row.ordinal !== expectedOrdinal || row.round !== round || row.group_position !== groupPosition ||
            row.group !== first.group || row.controller_cpu !== group.controller ||
            row.launch_position !== launchPosition) {
          reasons.push(`pinned-concurrent plan row ${cursor + 1} is out of canonical schedule order`);
        }
        if (!group.cpuSet.has(row.cpu)) {
          reasons.push(`pinned-concurrent plan row ${cursor + 1} uses a CPU outside group ${first.group}`);
        } else if (seenCpus.has(row.cpu)) {
          reasons.push(`pinned-concurrent plan wave at row ${cursor + 1} repeats CPU ${row.cpu}`);
        } else {
          seenCpus.add(row.cpu);
          launchPositionCounts.get(first.group).get(row.cpu)[launchPosition - 1] += 1;
        }
        cursor += 1;
      }
      if (seenCpus.size !== group.cpuList.length) {
        reasons.push(`pinned-concurrent plan round ${round}, group ${first.group} does not contain every active CPU exactly once`);
      }
      waveBoundaries.push(cursor);
    }
    if (seenGroups.size !== groupsRows.length) {
      reasons.push(`pinned-concurrent plan round ${round} does not contain every group exactly once`);
    }
  }
  if (cursor !== rows.length) reasons.push(`pinned-concurrent plan has ${rows.length - cursor} unexpected trailing row(s)`);
  const unbalanced = (counts) => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const count of counts) {
      minimum = Math.min(minimum, count);
      maximum = Math.max(maximum, count);
    }
    return maximum - minimum > 1;
  };
  for (const [group, counts] of groupPositionCounts) {
    if (unbalanced(counts)) {
      reasons.push(`pinned-concurrent plan does not position-balance group ${group}`);
    }
  }
  for (const [group, cpuCounts] of launchPositionCounts) {
    for (const [cpu, counts] of cpuCounts) {
      if (unbalanced(counts)) {
        reasons.push(`pinned-concurrent plan does not launch-position-balance CPU ${cpu} in group ${group}`);
      }
    }
  }
  return { reasons: unique(reasons), waveBoundaries };
}

export function validatePinnedConcurrentPlanRows(rows, groupsRows = null, expectations = {}) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > PINNED_CONCURRENT_PLAN_MAX_ROWS) {
    return { reasons: [`pinned-concurrent plan must contain 1-${PINNED_CONCURRENT_PLAN_MAX_ROWS} rows`], waveBoundaries: [] };
  }
  reasons.push(...validatePlanFieldGrammar(rows));
  if (groupsRows !== null) {
    const groupReasons = validatePinnedConcurrentGroupsRows(groupsRows, expectations);
    reasons.push(...groupReasons);
    if (groupReasons.length === 0 && reasons.length === 0) {
      const rounds = expectations.roundsPerContext ?? groupsRows[0]?.rounds;
      const structural = validatePlanStructure(rows, groupsRows, rounds);
      reasons.push(...structural.reasons);
      return { reasons: unique(reasons), waveBoundaries: structural.waveBoundaries };
    }
  }
  return { reasons: unique(reasons), waveBoundaries: [] };
}

export function parsePinnedConcurrentPlan(value, options = {}) {
  const parsed = parseTsv(
    value,
    PINNED_CONCURRENT_PLAN_HEADER,
    PLAN_FIELDS.length,
    PINNED_CONCURRENT_PLAN_MAX_ROWS,
    "pinned-concurrent plan",
  );
  const rows = parsed.rows.map(([ordinal, round, group_position, group, controller_cpu, launch_position, cpu]) => ({
    ordinal: canonicalPositiveUint(ordinal, PINNED_CONCURRENT_PLAN_MAX_ROWS) ?? ordinal,
    round: canonicalPositiveUint(round, PINNED_CONCURRENT_PLAN_MAX_ROWS) ?? round,
    group_position: canonicalPositiveUint(group_position, PINNED_CONCURRENT_GROUPS_MAX_ROWS) ?? group_position,
    group,
    controller_cpu: canonicalUint(controller_cpu, PINNED_CONCURRENT_MAX_CPU) ?? controller_cpu,
    launch_position: canonicalPositiveUint(launch_position, PINNED_CONCURRENT_MAX_CPU + 1) ?? launch_position,
    cpu: canonicalUint(cpu, PINNED_CONCURRENT_MAX_CPU) ?? cpu,
  }));
  const validation = validatePinnedConcurrentPlanRows(rows, options.groupsRows ?? null, options);
  parsed.reasons.push(...validation.reasons);
  return { rows, reasons: unique(parsed.reasons), waveBoundaries: validation.waveBoundaries };
}

export function serializePinnedConcurrentPlan(rows, groupsRows = null, expectations = {}) {
  return serializeRows(
    PINNED_CONCURRENT_PLAN_HEADER,
    rows,
    PLAN_FIELDS,
    parsePinnedConcurrentPlan,
    { ...expectations, groupsRows },
  );
}

function validateResultFieldGrammar(rows) {
  const reasons = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (canonicalPositiveUint(row.round, PINNED_CONCURRENT_PLAN_MAX_ROWS) === null) {
      reasons.push(`pinned-concurrent results row ${index + 1} has an invalid round`);
    }
    if (!GROUP_RE.test(row.group ?? "")) reasons.push(`pinned-concurrent results row ${index + 1} has an invalid group`);
    if (canonicalUint(row.cpu, PINNED_CONCURRENT_MAX_CPU) === null) {
      reasons.push(`pinned-concurrent results row ${index + 1} has an invalid CPU`);
    }
    if (canonicalPositiveUint(row.launch_position, PINNED_CONCURRENT_MAX_CPU + 1) === null) {
      reasons.push(`pinned-concurrent results row ${index + 1} has an invalid launch position`);
    }
    if (row.rc !== 0 && row.rc !== 139 && row.rc !== "0" && row.rc !== "139") {
      reasons.push(`pinned-concurrent results row ${index + 1} has operational/invalid rc ${row.rc}`);
    }
    if (canonicalUint(row.elapsed_ms) === null) {
      reasons.push(`pinned-concurrent results row ${index + 1} has an invalid elapsed_ms`);
    }
  }
  return reasons;
}

export function validatePinnedConcurrentResultRows(rows, planRows = null) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length > PINNED_CONCURRENT_RESULTS_MAX_ROWS) {
    return [`pinned-concurrent results exceed the ${PINNED_CONCURRENT_RESULTS_MAX_ROWS}-row limit`];
  }
  reasons.push(...validateResultFieldGrammar(rows));
  if (planRows !== null) {
    if (!Array.isArray(planRows) || rows.length > planRows.length) {
      reasons.push("pinned-concurrent results are longer than their plan");
    } else {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const planned = planRows[index];
        if (row.round !== planned.round || row.group !== planned.group || row.cpu !== planned.cpu ||
            row.launch_position !== planned.launch_position) {
          reasons.push(`pinned-concurrent results row ${index + 1} is not the exact projected plan prefix`);
          break;
        }
      }
    }
  }
  return unique(reasons);
}

export function parsePinnedConcurrentResults(value, options = {}) {
  const parsed = parseTsv(
    value,
    PINNED_CONCURRENT_RESULTS_HEADER,
    RESULT_FIELDS.length,
    PINNED_CONCURRENT_RESULTS_MAX_ROWS,
    "pinned-concurrent results",
  );
  const rows = parsed.rows.map(([round, group, cpu, launch_position, rc, elapsed_ms]) => ({
    round: canonicalPositiveUint(round, PINNED_CONCURRENT_PLAN_MAX_ROWS) ?? round,
    group,
    cpu: canonicalUint(cpu, PINNED_CONCURRENT_MAX_CPU) ?? cpu,
    launch_position: canonicalPositiveUint(launch_position, PINNED_CONCURRENT_MAX_CPU + 1) ?? launch_position,
    rc: canonicalUint(rc) ?? rc,
    elapsed_ms: canonicalUint(elapsed_ms) ?? elapsed_ms,
  }));
  parsed.reasons.push(...validatePinnedConcurrentResultRows(rows, options.planRows ?? null));
  return { rows, reasons: unique(parsed.reasons) };
}

export function serializePinnedConcurrentResults(rows, planRows = null) {
  return serializeRows(
    PINNED_CONCURRENT_RESULTS_HEADER,
    rows,
    RESULT_FIELDS,
    parsePinnedConcurrentResults,
    { planRows },
  );
}

function canonicalDecimalBigInt(value) {
  if (typeof value !== "string" || value.length > 32 || !DECIMAL_RE.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizeBoundaryNoTurbo(value) {
  if (value === 0 || value === 1) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join("\n") !== "status\nerrorCode" ||
      (value.status !== "unavailable" && value.status !== "invalid") ||
      typeof value.errorCode !== "string" || !ERROR_CODE_RE.test(value.errorCode)) return null;
  return { status: value.status, errorCode: value.errorCode };
}

function normalizePinnedConcurrentBoundaryRow(value, index, planRow, resultRow, reasons) {
  const rowNumber = index + 1;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).join("\n") !== BOUNDARY_FIELDS.join("\n")) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} does not contain exactly the canonical fields in order`);
    return null;
  }
  const ordinal = canonicalPositiveUint(value.ordinal, PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS);
  const round = canonicalPositiveUint(value.round, PINNED_CONCURRENT_PLAN_MAX_ROWS);
  const groupPosition = canonicalPositiveUint(value.groupPosition, PINNED_CONCURRENT_GROUPS_MAX_ROWS);
  const controllerCpu = canonicalUint(value.controllerCpu, PINNED_CONCURRENT_MAX_CPU);
  const launchPosition = canonicalPositiveUint(value.launchPosition, PINNED_CONCURRENT_MAX_CPU + 1);
  const cpu = canonicalUint(value.cpu, PINNED_CONCURRENT_MAX_CPU);
  if (ordinal !== rowNumber || round === null || groupPosition === null ||
      !GROUP_RE.test(value.group ?? "") || controllerCpu === null || launchPosition === null || cpu === null) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} has invalid schedule fields`);
    return null;
  }
  if (planRow !== undefined &&
      (ordinal !== planRow.ordinal || round !== planRow.round || groupPosition !== planRow.group_position ||
       value.group !== planRow.group || controllerCpu !== planRow.controller_cpu ||
       launchPosition !== planRow.launch_position || cpu !== planRow.cpu)) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} is not the exact projected plan row`);
    return null;
  }
  if (resultRow !== undefined &&
      (round !== resultRow.round || value.group !== resultRow.group || cpu !== resultRow.cpu ||
       launchPosition !== resultRow.launch_position)) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} is not in exact result order`);
    return null;
  }
  const startUnixMs = canonicalUint(value.startUnixMs);
  const endUnixMs = canonicalUint(value.endUnixMs);
  const startMonotonicNs = canonicalDecimalBigInt(value.startMonotonicNs);
  const endMonotonicNs = canonicalDecimalBigInt(value.endMonotonicNs);
  const durationNs = canonicalDecimalBigInt(value.durationNs);
  if (startUnixMs === null || endUnixMs === null || endUnixMs < startUnixMs ||
      startMonotonicNs === null || endMonotonicNs === null || durationNs === null ||
      endMonotonicNs < startMonotonicNs || endMonotonicNs - startMonotonicNs !== durationNs ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      value.durationMs !== Number(durationNs) / 1_000_000) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} has invalid or unreconciled timing`);
    return null;
  }
  if (resultRow !== undefined && Number(durationNs / 1_000_000n) !== resultRow.elapsed_ms) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} duration disagrees with result elapsed_ms`);
    return null;
  }
  const noTurboStart = normalizeBoundaryNoTurbo(value.noTurboStart);
  const noTurboEnd = normalizeBoundaryNoTurbo(value.noTurboEnd);
  if (noTurboStart === null || noTurboEnd === null) {
    reasons.push(`pinned-concurrent boundary row ${rowNumber} has invalid no_turbo observations`);
    return null;
  }
  return {
    ordinal,
    round,
    groupPosition,
    group: value.group,
    controllerCpu,
    launchPosition,
    cpu,
    startUnixMs,
    endUnixMs,
    startMonotonicNs: value.startMonotonicNs,
    endMonotonicNs: value.endMonotonicNs,
    durationNs: value.durationNs,
    durationMs: value.durationMs,
    noTurboStart,
    noTurboEnd,
  };
}

export function validatePinnedConcurrentBoundaryRows(rows, options = {}) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length > PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS) {
    return [`pinned-concurrent boundaries exceed the ${PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS}-row limit`];
  }
  const planRows = options.planRows ?? null;
  const resultRows = options.resultRows ?? null;
  if (planRows !== null && (!Array.isArray(planRows) || rows.length > planRows.length)) {
    reasons.push("pinned-concurrent boundaries are longer than their plan");
  }
  if (resultRows !== null && (!Array.isArray(resultRows) || rows.length > resultRows.length)) {
    reasons.push("pinned-concurrent boundaries are longer than their results");
  }
  for (let index = 0; index < rows.length; index += 1) {
    normalizePinnedConcurrentBoundaryRow(
      rows[index],
      index,
      Array.isArray(planRows) ? planRows[index] : undefined,
      Array.isArray(resultRows) ? resultRows[index] : undefined,
      reasons,
    );
  }
  return unique(reasons);
}

export function parsePinnedConcurrentBoundaries(value, options = {}) {
  const reasons = [];
  let bytes;
  try {
    bytes = exactBytes(value);
  } catch {
    return { rows: [], reasons: ["pinned-concurrent boundaries are not byte content"] };
  }
  if (bytes.length > PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES) {
    return { rows: [], reasons: [`pinned-concurrent boundaries exceed the ${PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES}-byte limit`] };
  }
  const text = decodeUtf8(bytes, "pinned-concurrent boundaries", reasons);
  if (text.includes("\r") || text.includes("\0")) {
    reasons.push("pinned-concurrent boundaries contain a forbidden control byte");
  }
  if (!text.endsWith("\n")) reasons.push("pinned-concurrent boundaries must end with a newline");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS) {
    reasons.push(`pinned-concurrent boundaries exceed the ${PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS}-row limit`);
  }
  const rows = [];
  const limit = Math.min(lines.length, PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS + 1);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index];
    if (line === "" || Buffer.byteLength(line) > PINNED_CONCURRENT_BOUNDARY_ROW_MAX_BYTES) {
      reasons.push(`pinned-concurrent boundary row ${index + 1} is blank or exceeds its byte limit`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      reasons.push(`pinned-concurrent boundary row ${index + 1} is malformed JSON`);
      continue;
    }
    const normalized = normalizePinnedConcurrentBoundaryRow(
      parsed,
      index,
      Array.isArray(options.planRows) ? options.planRows[index] : undefined,
      Array.isArray(options.resultRows) ? options.resultRows[index] : undefined,
      reasons,
    );
    if (normalized !== null) {
      rows.push(normalized);
      if (JSON.stringify(normalized) !== line) {
        reasons.push(`pinned-concurrent boundary row ${index + 1} is not canonical JSON`);
      }
    }
  }
  return { rows, reasons: unique(reasons) };
}

export function serializePinnedConcurrentBoundaries(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError("boundary rows must be an array");
  const reasons = validatePinnedConcurrentBoundaryRows(rows, options);
  const normalized = rows.map((row, index) => normalizePinnedConcurrentBoundaryRow(
    row,
    index,
    Array.isArray(options.planRows) ? options.planRows[index] : undefined,
    Array.isArray(options.resultRows) ? options.resultRows[index] : undefined,
    reasons,
  ));
  if (reasons.length > 0 || normalized.some((row) => row === null)) {
    throw new TypeError(unique(reasons).join("; "));
  }
  const text = `${normalized.map((row) => JSON.stringify(row)).join("\n")}${normalized.length > 0 ? "\n" : ""}`;
  const parsed = parsePinnedConcurrentBoundaries(text, options);
  if (parsed.reasons.length > 0) throw new TypeError(parsed.reasons.join("; "));
  return text;
}

function parseMetaValueGrammar(meta, reasons) {
  if (meta.VERSION !== String(PINNED_CONCURRENT_VERSION)) reasons.push("pinned-concurrent metadata VERSION is unsupported");
  if (!GENERATION_RE.test(meta.GENERATION ?? "")) reasons.push("pinned-concurrent metadata GENERATION is malformed");
  if (!GENERATION_RE.test(meta.SOURCE_GROUP_GENERATION ?? "")) {
    reasons.push("pinned-concurrent metadata SOURCE_GROUP_GENERATION is malformed");
  }
  if (!DIGEST_RE.test(meta.SOURCE_GROUP_PLAN_DIGEST ?? "")) {
    reasons.push("pinned-concurrent metadata SOURCE_GROUP_PLAN_DIGEST is malformed");
  }
  if (canonicalPositiveUint(meta.ROUNDS_PER_CONTEXT, PINNED_CONCURRENT_PLAN_MAX_ROWS) === null) {
    reasons.push("pinned-concurrent metadata ROUNDS_PER_CONTEXT is invalid");
  }
  if (canonicalUint(meta.SCHEDULE_SEED) === null) reasons.push("pinned-concurrent metadata SCHEDULE_SEED is invalid");
  if (meta.SCHEDULE_ALGORITHM !== PINNED_CONCURRENT_SCHEDULE_ALGORITHM) {
    reasons.push("pinned-concurrent metadata SCHEDULE_ALGORITHM is unsupported");
  }
  for (const [prefix, maxBytes, maxRows] of [
    ["GROUPS", PINNED_CONCURRENT_GROUPS_MAX_BYTES, PINNED_CONCURRENT_GROUPS_MAX_ROWS],
    ["PLAN", PINNED_CONCURRENT_PLAN_MAX_BYTES, PINNED_CONCURRENT_PLAN_MAX_ROWS],
  ]) {
    if (!DIGEST_RE.test(meta[`${prefix}_SHA256`] ?? "")) reasons.push(`pinned-concurrent metadata ${prefix}_SHA256 is malformed`);
    if (canonicalPositiveUint(meta[`${prefix}_BYTES`], maxBytes) === null) reasons.push(`pinned-concurrent metadata ${prefix}_BYTES is invalid`);
    if (canonicalPositiveUint(meta[`${prefix}_ROW_COUNT`], maxRows) === null) {
      reasons.push(`pinned-concurrent metadata ${prefix}_ROW_COUNT is invalid`);
    }
  }
  if (meta.COMPLETED !== "0" && meta.COMPLETED !== "1") reasons.push("pinned-concurrent metadata COMPLETED is invalid");
  if (meta.COMPLETED === "1") {
    if (!DIGEST_RE.test(meta.ROWS_SHA256 ?? "")) reasons.push("pinned-concurrent metadata ROWS_SHA256 is malformed");
    if (canonicalPositiveUint(meta.ROWS_BYTES, PINNED_CONCURRENT_RESULTS_MAX_BYTES) === null) {
      reasons.push("pinned-concurrent metadata ROWS_BYTES is invalid");
    }
    if (canonicalPositiveUint(meta.ROW_COUNT, PINNED_CONCURRENT_RESULTS_MAX_ROWS) === null) {
      reasons.push("pinned-concurrent metadata ROW_COUNT is invalid");
    }
    if (!DIGEST_RE.test(meta.BOUNDARIES_SHA256 ?? "")) {
      reasons.push("pinned-concurrent metadata BOUNDARIES_SHA256 is malformed");
    }
    if (canonicalPositiveUint(meta.BOUNDARIES_BYTES, PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES) === null) {
      reasons.push("pinned-concurrent metadata BOUNDARIES_BYTES is invalid");
    }
    if (canonicalPositiveUint(meta.BOUNDARY_ROW_COUNT, PINNED_CONCURRENT_BOUNDARIES_MAX_ROWS) === null) {
      reasons.push("pinned-concurrent metadata BOUNDARY_ROW_COUNT is invalid");
    }
  } else if (TERMINAL_BINDING_KEYS.some((key) => Object.hasOwn(meta, key))) {
    reasons.push("incomplete pinned-concurrent metadata contains terminal bindings");
  }
}

export function parsePinnedConcurrentMeta(value) {
  const reasons = [];
  const text = decodeUtf8(value, "pinned-concurrent metadata", reasons);
  if (text.includes("\r") || text.includes("\0")) reasons.push("pinned-concurrent metadata contains a forbidden control byte");
  if (!text.endsWith("\n")) reasons.push("pinned-concurrent metadata must end with a newline");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const meta = {};
  const observedKeys = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) {
      reasons.push("pinned-concurrent metadata contains a malformed record");
      continue;
    }
    const [, key, valueText] = match;
    observedKeys.push(key);
    if (!KNOWN_META_KEYS.has(key)) reasons.push(`pinned-concurrent metadata contains unknown field ${key}`);
    else if (Object.hasOwn(meta, key)) reasons.push(`pinned-concurrent metadata duplicates field ${key}`);
    else meta[key] = valueText;
  }
  const expectedKeys = meta.COMPLETED === "1" ? [...BASE_META_KEYS, ...TERMINAL_BINDING_KEYS] : BASE_META_KEYS;
  if (observedKeys.join("\n") !== expectedKeys.join("\n")) {
    reasons.push(`pinned-concurrent metadata must contain exactly the canonical ${expectedKeys.length} records in order`);
  }
  parseMetaValueGrammar(meta, reasons);
  return { meta, reasons: unique(reasons) };
}

export function serializePinnedConcurrentMeta(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("metadata must be an object");
  const keys = meta.COMPLETED === "1" || meta.COMPLETED === 1
    ? [...BASE_META_KEYS, ...TERMINAL_BINDING_KEYS]
    : BASE_META_KEYS;
  const text = `${keys.map((key) => `${key}=${meta[key]}`).join("\n")}\n`;
  const parsed = parsePinnedConcurrentMeta(text);
  const suppliedKeys = Object.keys(meta);
  if (parsed.reasons.length > 0 || suppliedKeys.length !== keys.length || suppliedKeys.some((key) => !keys.includes(key))) {
    const reasons = [...parsed.reasons];
    if (suppliedKeys.length !== keys.length || suppliedKeys.some((key) => !keys.includes(key))) {
      reasons.push("metadata object must contain exactly the canonical fields");
    }
    throw new TypeError(unique(reasons).join("; "));
  }
  return text;
}

export function buildPinnedConcurrentMeta({
  generation,
  sourceGroupGeneration,
  sourceGroupPlanDigest,
  roundsPerContext,
  scheduleSeed,
  groupsBytes,
  groupsRowCount,
  planBytes,
  planRowCount,
  resultsBytes = null,
  resultsRowCount = null,
  boundariesBytes = null,
  boundariesRowCount = null,
  completed = false,
}) {
  const groupsBinding = pinnedConcurrentFileBinding(groupsBytes, groupsRowCount);
  const planBinding = pinnedConcurrentFileBinding(planBytes, planRowCount);
  const meta = {
    VERSION: String(PINNED_CONCURRENT_VERSION),
    GENERATION: generation,
    SOURCE_GROUP_GENERATION: sourceGroupGeneration,
    SOURCE_GROUP_PLAN_DIGEST: sourceGroupPlanDigest,
    ROUNDS_PER_CONTEXT: String(roundsPerContext),
    SCHEDULE_SEED: String(scheduleSeed),
    SCHEDULE_ALGORITHM: PINNED_CONCURRENT_SCHEDULE_ALGORITHM,
    GROUPS_SHA256: groupsBinding.sha256,
    GROUPS_BYTES: String(groupsBinding.bytes),
    GROUPS_ROW_COUNT: String(groupsBinding.rowCount),
    PLAN_SHA256: planBinding.sha256,
    PLAN_BYTES: String(planBinding.bytes),
    PLAN_ROW_COUNT: String(planBinding.rowCount),
    COMPLETED: completed ? "1" : "0",
  };
  if (completed) {
    if (resultsBytes === null || resultsRowCount === null ||
        boundariesBytes === null || boundariesRowCount === null) {
      throw new TypeError("completed metadata requires result and boundary bytes and row counts");
    }
    const rowsBinding = pinnedConcurrentFileBinding(resultsBytes, resultsRowCount);
    const boundariesBinding = pinnedConcurrentFileBinding(boundariesBytes, boundariesRowCount);
    meta.ROWS_SHA256 = rowsBinding.sha256;
    meta.ROWS_BYTES = String(rowsBinding.bytes);
    meta.ROW_COUNT = String(rowsBinding.rowCount);
    meta.BOUNDARIES_SHA256 = boundariesBinding.sha256;
    meta.BOUNDARIES_BYTES = String(boundariesBinding.bytes);
    meta.BOUNDARY_ROW_COUNT = String(boundariesBinding.rowCount);
  } else if (resultsBytes !== null || resultsRowCount !== null ||
      boundariesBytes !== null || boundariesRowCount !== null) {
    throw new TypeError("incomplete metadata forbids terminal result or boundary binding inputs");
  }
  // This also validates every caller-supplied scalar.
  serializePinnedConcurrentMeta(meta);
  return meta;
}

function statDirectory(directory, label, required) {
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) return { state: "unsafe", reason: `${label} must be a real directory` };
    return { state: "regular", stat };
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return { state: "missing" };
    return { state: "unsafe", reason: `${label} is missing or could not be inspected` };
  }
}

function stableDirectory(before, directory) {
  if (before.state === "missing") {
    try {
      lstatSync(directory);
      return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }
  if (before.state !== "regular") return false;
  try {
    const after = lstatSync(directory, { bigint: true });
    return after.isDirectory() && before.stat.dev === after.dev && before.stat.ino === after.ino &&
      before.stat.ctimeNs === after.ctimeNs && before.stat.mtimeNs === after.mtimeNs;
  } catch {
    return false;
  }
}

function targetExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function readTarget(root, components, maxBytes, label) {
  const file = path.join(root, ...components);
  const result = readStableRegularFile(file, maxBytes, label, {
    requiredOwner: typeof process.getuid === "function" ? process.getuid() : null,
  });
  return {
    file,
    state: !result.present ? "missing" : result.errors.length > 0 || result.bytes === null ? "unsafe" : "regular",
    bytes: result.bytes,
    reasons: result.errors,
  };
}

function exactBinding(meta, prefix, bytes, rowCount, reasons) {
  if (!bytes) return;
  const binding = pinnedConcurrentFileBinding(bytes, rowCount);
  const rowCountKey = prefix === "ROWS"
    ? "ROW_COUNT"
    : prefix === "BOUNDARIES" ? "BOUNDARY_ROW_COUNT" : `${prefix}_ROW_COUNT`;
  if (meta[`${prefix}_SHA256`] !== binding.sha256 ||
      canonicalUint(meta[`${prefix}_BYTES`]) !== binding.bytes ||
      canonicalUint(meta[rowCountKey]) !== binding.rowCount) {
    reasons.push(`pinned-concurrent ${prefix.toLowerCase()} file does not match its exact metadata binding`);
  }
}

function compareExpectation(meta, key, expected, reasons) {
  if (expected === undefined) return;
  if (meta[key] !== String(expected)) reasons.push(`pinned-concurrent metadata ${key} disagrees with its stored expectation`);
}

function summarizeOutcomes(rows, waveBoundaries) {
  const perCpuMap = new Map();
  const perGroupMap = new Map();
  let waveStart = 0;
  let failedWaves = 0;
  for (const boundary of waveBoundaries) {
    const waveRows = rows.slice(waveStart, boundary);
    const failed = waveRows.some(({ rc }) => rc === 139);
    if (failed) failedWaves += 1;
    const group = waveRows[0]?.group;
    if (group !== undefined) {
      const record = perGroupMap.get(group) ?? { group, waves: 0, failedWaves: 0, childRuns: 0, sigsegv: 0 };
      record.waves += 1;
      record.failedWaves += failed ? 1 : 0;
      record.childRuns += waveRows.length;
      record.sigsegv += waveRows.filter(({ rc }) => rc === 139).length;
      perGroupMap.set(group, record);
    }
    for (const row of waveRows) {
      const key = `${row.group}\0${row.cpu}`;
      const record = perCpuMap.get(key) ?? { group: row.group, cpu: row.cpu, runs: 0, sigsegv: 0 };
      record.runs += 1;
      record.sigsegv += row.rc === 139 ? 1 : 0;
      perCpuMap.set(key, record);
    }
    waveStart = boundary;
  }
  return {
    waves: waveBoundaries.length,
    failedWaves,
    childRuns: rows.length,
    sigsegv: rows.filter(({ rc }) => rc === 139).length,
    perGroup: [...perGroupMap.values()].sort((left, right) => left.group.localeCompare(right.group)),
    perCpu: [...perCpuMap.values()].sort((left, right) => left.group.localeCompare(right.group) || left.cpu - right.cpu),
  };
}

function summarizeNoTurbo(boundaries) {
  const summary = {
    boundaryRows: boundaries.length,
    observationCount: boundaries.length * 2,
    observedCount: 0,
    unavailableCount: 0,
    invalidCount: 0,
    value0Count: 0,
    value1Count: 0,
    fullyObservedRows: 0,
  };
  const observedValues = new Set();
  for (const boundary of boundaries) {
    const observations = [boundary.noTurboStart, boundary.noTurboEnd];
    if (observations.every((observation) => observation === 0 || observation === 1)) {
      summary.fullyObservedRows += 1;
    }
    for (const observation of observations) {
      if (observation === 0 || observation === 1) {
        summary.observedCount += 1;
        summary[`value${observation}Count`] += 1;
        observedValues.add(observation);
      } else {
        summary[`${observation.status}Count`] += 1;
      }
    }
  }
  const values = [...observedValues].sort((left, right) => left - right);
  return {
    ...summary,
    observedValues: values,
    allObserved: summary.observedCount === summary.observationCount,
    uniformObservedValue: values.length === 1 ? values[0] : null,
    completeAndUniformValue: summary.observedCount === summary.observationCount && values.length === 1
      ? values[0]
      : null,
  };
}

function summarizeBoundaries(boundaries) {
  if (boundaries.length === 0) return null;
  let totalDurationNs = 0n;
  let earliestStartUnixMs = Number.MAX_SAFE_INTEGER;
  let latestEndUnixMs = 0;
  for (const boundary of boundaries) {
    totalDurationNs += BigInt(boundary.durationNs);
    earliestStartUnixMs = Math.min(earliestStartUnixMs, boundary.startUnixMs);
    latestEndUnixMs = Math.max(latestEndUnixMs, boundary.endUnixMs);
  }
  return {
    rowCount: boundaries.length,
    earliestStartUnixMs,
    latestEndUnixMs,
    totalDurationNs: totalDurationNs.toString(),
    noTurboCoverage: summarizeNoTurbo(boundaries),
  };
}

export function assessPinnedConcurrentEvidence(bundleDir, expectations = {}) {
  if (typeof bundleDir !== "string" || bundleDir.length === 0 || bundleDir.includes("\0")) {
    return { status: "invalid", reasons: ["bundle path is invalid"], authoritative: false };
  }
  const root = path.resolve(bundleDir);
  const rootState = statDirectory(root, "bundle root", true);
  if (rootState.state !== "regular") {
    return { status: "invalid", reasons: [rootState.reason], authoritative: false };
  }
  const resultsDir = path.join(root, "results");
  const stateDir = path.join(root, "state");
  const resultsState = statDirectory(resultsDir, "results directory", false);
  const stateState = statDirectory(stateDir, "state directory", false);
  const targetPaths = Object.values(TARGETS).map((components) => path.join(root, ...components));
  const anyArtifact = targetPaths.some(targetExists);
  if (!anyArtifact && resultsState.state !== "unsafe" && stateState.state !== "unsafe") {
    return {
      status: "not-run",
      reasons: [],
      authoritative: false,
      groups: [],
      plan: [],
      rows: [],
      boundaries: [],
      committedRows: [],
      authoritativeRows: [],
      authoritativeBoundaries: [],
      authoritativeBoundarySummary: null,
      boundarySummary: null,
      noTurboCoverage: null,
    };
  }

  const reasons = [];
  let invalid = false;
  for (const directory of [resultsState, stateState]) {
    if (directory.state === "unsafe") {
      reasons.push(directory.reason);
      invalid = true;
    } else if (directory.state === "missing") {
      reasons.push(`${directory === resultsState ? "results" : "state"} directory is missing`);
    }
  }
  const reads = {
    meta: readTarget(root, TARGETS.meta, PINNED_CONCURRENT_META_MAX_BYTES, "pinned-concurrent metadata"),
    groups: readTarget(root, TARGETS.groups, PINNED_CONCURRENT_GROUPS_MAX_BYTES, "pinned-concurrent groups"),
    plan: readTarget(root, TARGETS.plan, PINNED_CONCURRENT_PLAN_MAX_BYTES, "pinned-concurrent plan"),
    results: readTarget(root, TARGETS.results, PINNED_CONCURRENT_RESULTS_MAX_BYTES, "pinned-concurrent results"),
    boundaries: readTarget(
      root,
      TARGETS.boundaries,
      PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES,
      "pinned-concurrent boundaries",
    ),
    marker: readTarget(root, TARGETS.marker, PINNED_CONCURRENT_MARKER_MAX_BYTES, "pinned-concurrent marker"),
  };
  for (const [name, read] of Object.entries(reads)) {
    if (read.state === "unsafe") {
      reasons.push(...read.reasons);
      invalid = true;
    } else if (read.state === "missing" && name !== "marker" && name !== "boundaries") {
      reasons.push(`pinned-concurrent ${name} file is missing`);
    }
  }
  if (!stableDirectory(rootState, root) || !stableDirectory(resultsState, resultsDir) || !stableDirectory(stateState, stateDir)) {
    reasons.push("pinned-concurrent evidence directories changed while being inspected");
    invalid = true;
  }
  if (reads.marker.state === "regular" && reads.marker.bytes.length !== 0) {
    reasons.push("pinned-concurrent completion marker must be empty");
    invalid = true;
  }

  let meta = {};
  if (reads.meta.state === "regular") {
    const parsed = parsePinnedConcurrentMeta(reads.meta.bytes);
    meta = parsed.meta;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }
  const roundsPerContext = canonicalPositiveUint(meta.ROUNDS_PER_CONTEXT, PINNED_CONCURRENT_PLAN_MAX_ROWS);
  let groups = [];
  if (reads.groups.state === "regular") {
    const parsed = parsePinnedConcurrentGroups(reads.groups.bytes, { roundsPerContext });
    groups = parsed.rows;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }
  let plan = [];
  let allWaveBoundaries = [];
  if (reads.plan.state === "regular") {
    const parsed = parsePinnedConcurrentPlan(reads.plan.bytes, { groupsRows: groups, roundsPerContext });
    plan = parsed.rows;
    allWaveBoundaries = parsed.waveBoundaries;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }
  let rows = [];
  if (reads.results.state === "regular") {
    const parsed = parsePinnedConcurrentResults(reads.results.bytes, { planRows: plan });
    rows = parsed.rows;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }
  let boundaries = [];
  let boundariesValid = false;
  if (reads.boundaries.state === "regular") {
    const parsed = parsePinnedConcurrentBoundaries(reads.boundaries.bytes, {
      planRows: plan,
      resultRows: rows,
    });
    boundaries = parsed.rows;
    boundariesValid = parsed.reasons.length === 0;
    if (!boundariesValid) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }

  if (reads.groups.state === "regular") exactBinding(meta, "GROUPS", reads.groups.bytes, groups.length, reasons);
  if (reads.plan.state === "regular") exactBinding(meta, "PLAN", reads.plan.bytes, plan.length, reasons);
  if (meta.COMPLETED === "1" && reads.results.state === "regular") {
    exactBinding(meta, "ROWS", reads.results.bytes, rows.length, reasons);
  }
  if (meta.COMPLETED === "1" && reads.boundaries.state === "regular") {
    exactBinding(meta, "BOUNDARIES", reads.boundaries.bytes, boundaries.length, reasons);
  }
  if (reasons.some((reason) => reason.includes("exact metadata binding"))) invalid = true;

  compareExpectation(meta, "GENERATION", expectations.generation, reasons);
  compareExpectation(meta, "SOURCE_GROUP_GENERATION", expectations.sourceGroupGeneration, reasons);
  compareExpectation(meta, "SOURCE_GROUP_PLAN_DIGEST", expectations.sourceGroupPlanDigest, reasons);
  compareExpectation(meta, "ROUNDS_PER_CONTEXT", expectations.roundsPerContext, reasons);
  compareExpectation(meta, "SCHEDULE_SEED", expectations.scheduleSeed, reasons);
  compareExpectation(meta, "SCHEDULE_ALGORITHM", expectations.scheduleAlgorithm, reasons);
  if (Object.values({
    generation: expectations.generation,
    sourceGroupGeneration: expectations.sourceGroupGeneration,
    sourceGroupPlanDigest: expectations.sourceGroupPlanDigest,
    roundsPerContext: expectations.roundsPerContext,
    scheduleSeed: expectations.scheduleSeed,
    scheduleAlgorithm: expectations.scheduleAlgorithm,
  }).some((value) => value !== undefined) && reasons.some((reason) => reason.includes("stored expectation"))) invalid = true;

  if (expectations.expectedGroupsRows !== undefined && reads.groups.state === "regular") {
    try {
      const expected = serializePinnedConcurrentGroups(expectations.expectedGroupsRows, { roundsPerContext });
      if (!reads.groups.bytes.equals(Buffer.from(expected))) {
        reasons.push("pinned-concurrent groups disagree with the expected topology contexts");
        invalid = true;
      }
    } catch {
      reasons.push("expected pinned-concurrent groups are invalid");
      invalid = true;
    }
  }
  if (expectations.expectedPlanRows !== undefined && reads.plan.state === "regular") {
    try {
      const expected = serializePinnedConcurrentPlan(expectations.expectedPlanRows, groups, { roundsPerContext });
      if (!reads.plan.bytes.equals(Buffer.from(expected))) {
        reasons.push("pinned-concurrent plan disagrees with the expected seeded schedule");
        invalid = true;
      }
    } catch {
      reasons.push("expected pinned-concurrent plan is invalid");
      invalid = true;
    }
  }

  const completeBoundaries = allWaveBoundaries.filter((boundary) => boundary <= rows.length);
  const resumableRowCount = completeBoundaries.at(-1) ?? 0;
  const discardedTailRowCount = rows.length - resumableRowCount;
  if (discardedTailRowCount > 0 && !invalid) {
    reasons.push(`pinned-concurrent results end inside a group wave; ${discardedTailRowCount} tail row(s) must be rerun`);
  }

  const claimedComplete = meta.COMPLETED === "1";
  if (claimedComplete) {
    if (rows.length !== plan.length || discardedTailRowCount !== 0) {
      reasons.push("completed pinned-concurrent evidence does not contain the exact full plan");
      invalid = true;
    }
    if (reads.boundaries.state !== "regular") {
      reasons.push("completed pinned-concurrent evidence is missing its terminal boundary sidecar");
      invalid = true;
    } else if (boundaries.length !== plan.length || boundaries.length !== rows.length) {
      reasons.push("completed pinned-concurrent evidence does not contain one boundary for every result and plan row");
      invalid = true;
    }
    if (reads.marker.state === "missing") reasons.push("pinned-concurrent completion marker is missing");
  } else if (meta.COMPLETED === "0") {
    reasons.push("pinned-concurrent evidence is not marked complete");
    if (reads.boundaries.state === "regular") {
      reasons.push("incomplete pinned-concurrent evidence contains a terminal boundary sidecar");
      invalid = true;
    }
    if (reads.marker.state === "regular") {
      reasons.push("incomplete pinned-concurrent evidence has a completion marker");
      invalid = true;
    }
  }

  const safePrefix = !invalid && reads.meta.state === "regular" && reads.groups.state === "regular" &&
    reads.plan.state === "regular" && reads.results.state === "regular";
  const committedRows = safePrefix ? rows.slice(0, resumableRowCount) : [];
  const committedWaveBoundaries = safePrefix ? completeBoundaries : [];
  const descriptiveOutcomes = safePrefix ? summarizeOutcomes(committedRows, committedWaveBoundaries) : null;
  const boundarySummary = boundariesValid ? summarizeBoundaries(boundaries) : null;
  const complete = !invalid && claimedComplete && reasons.length === 0 &&
    reads.marker.state === "regular" && rows.length === plan.length && boundaries.length === plan.length;
  const publicationReady = !invalid && claimedComplete && reads.marker.state === "missing" &&
    resultsState.state === "regular" && stateState.state === "regular" && rows.length === plan.length &&
    boundaries.length === plan.length &&
    unique(reasons).length === 1 && reasons[0] === "pinned-concurrent completion marker is missing";
  const status = complete ? "complete" : invalid ? "invalid" : "incomplete";
  const reportedBoundarySummary = boundarySummary === null
    ? null
    : { ...boundarySummary, authoritative: complete };
  const reportedNoTurboCoverage = boundarySummary === null
    ? null
    : { ...boundarySummary.noTurboCoverage, authoritative: complete };
  return {
    status,
    reasons: unique(reasons),
    authoritative: complete,
    publicationReady,
    meta,
    groups,
    plan,
    rows,
    boundaries,
    resumableRowCount: safePrefix ? resumableRowCount : 0,
    discardedTailRowCount: safePrefix ? discardedTailRowCount : rows.length,
    committedRows,
    authoritativeRows: complete ? rows : [],
    authoritativeBoundaries: complete ? boundaries : [],
    authoritativeBoundarySummary: complete ? boundarySummary : null,
    boundarySummary: reportedBoundarySummary,
    noTurboCoverage: reportedNoTurboCoverage,
    descriptiveOutcomes: descriptiveOutcomes === null ? null : { ...descriptiveOutcomes, authoritative: complete },
    totalWaveCount: allWaveBoundaries.length,
    completedWaveCount: safePrefix ? completeBoundaries.length : 0,
  };
}

export function validateFreshPinnedConcurrentTargets(bundleDir, options = {}) {
  const reasons = [];
  if (typeof bundleDir !== "string" || bundleDir.length === 0 || bundleDir.includes("\0")) return ["bundle path is invalid"];
  const root = path.resolve(bundleDir);
  for (const [directory, label] of [
    [root, "bundle root"],
    [path.join(root, "results"), "results directory"],
    [path.join(root, "state"), "state directory"],
  ]) {
    const state = statDirectory(directory, label, true);
    if (state.state !== "regular") reasons.push(state.reason);
  }
  for (const components of Object.values(TARGETS)) {
    const file = path.join(root, ...components);
    if (targetExists(file)) reasons.push(`${components.join("/")} already exists or is unsafe`);
  }
  if (options.groupsRows !== undefined) {
    const groupReasons = validatePinnedConcurrentGroupsRows(options.groupsRows, options);
    reasons.push(...groupReasons.map((reason) => `fresh target groups: ${reason}`));
    if (groupReasons.length === 0 && options.planRows !== undefined) {
      const plan = validatePinnedConcurrentPlanRows(options.planRows, options.groupsRows, options);
      reasons.push(...plan.reasons.map((reason) => `fresh target plan: ${reason}`));
    }
  } else if (options.planRows !== undefined) {
    reasons.push("fresh target plan requires groupsRows");
  }
  return unique(reasons);
}

export const checkFreshPinnedConcurrentTargets = validateFreshPinnedConcurrentTargets;

function cliUsage() {
  return [
    "usage:",
    "  pinned-concurrent-evidence.mjs validate-before BUNDLE [GENERATION SOURCE_GROUP_GENERATION SOURCE_DIGEST ROUNDS SEED]",
    "  pinned-concurrent-evidence.mjs validate-complete BUNDLE [GENERATION SOURCE_GROUP_GENERATION SOURCE_DIGEST ROUNDS SEED]",
    "  pinned-concurrent-evidence.mjs build-meta --generation HEX32 --source-group-generation HEX32",
    "    --source-group-plan-digest HEX64 --rounds N --seed N --groups FILE --plan FILE",
    "    --completed 0|1 [--results FILE --boundaries FILE] [--output FILE]",
  ].join("\n");
}

function cliExpectations(args) {
  if (args.length === 0) return {};
  if (args.length !== 5) throw new TypeError("validation expectations must be omitted or contain exactly five values");
  const [generation, sourceGroupGeneration, sourceGroupPlanDigest, roundsText, seedText] = args;
  const roundsPerContext = canonicalPositiveUint(roundsText, PINNED_CONCURRENT_PLAN_MAX_ROWS);
  const scheduleSeed = canonicalUint(seedText);
  if (!GENERATION_RE.test(generation) || !GENERATION_RE.test(sourceGroupGeneration) ||
      !DIGEST_RE.test(sourceGroupPlanDigest) || roundsPerContext === null || scheduleSeed === null) {
    throw new TypeError("validation expectations are malformed");
  }
  return {
    generation,
    sourceGroupGeneration,
    sourceGroupPlanDigest,
    roundsPerContext,
    scheduleSeed,
    scheduleAlgorithm: PINNED_CONCURRENT_SCHEDULE_ALGORITHM,
  };
}

function printCliAssessment(assessment) {
  console.log(`STATUS=${assessment.status}`);
  console.log(`AUTHORITATIVE=${assessment.authoritative ? 1 : 0}`);
  console.log(`PUBLICATION_READY=${assessment.publicationReady ? 1 : 0}`);
  console.log(`RESUMABLE_ROW_COUNT=${assessment.resumableRowCount ?? 0}`);
  console.log(`BOUNDARY_ROW_COUNT=${assessment.boundaries?.length ?? 0}`);
  for (const reason of assessment.reasons ?? []) console.error(reason);
}

function validateBeforeForCli(assessment) {
  const permittedReason = (reason) => reason === "pinned-concurrent evidence is not marked complete" ||
    /^pinned-concurrent results end inside a group wave; [0-9]+ tail row\(s\) must be rerun$/.test(reason);
  return assessment.status === "incomplete" && assessment.meta?.COMPLETED === "0" &&
    Array.isArray(assessment.groups) && assessment.groups.length > 0 &&
    Array.isArray(assessment.plan) && assessment.plan.length > 0 &&
    Array.isArray(assessment.rows) && Array.isArray(assessment.boundaries) && assessment.boundaries.length === 0 &&
    assessment.reasons.every(permittedReason);
}

function parseBuildMetaCliOptions(args) {
  const allowed = new Set([
    "--generation",
    "--source-group-generation",
    "--source-group-plan-digest",
    "--rounds",
    "--seed",
    "--groups",
    "--plan",
    "--results",
    "--boundaries",
    "--completed",
    "--output",
  ]);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || value === undefined || options.has(flag)) {
      throw new TypeError(`invalid or duplicate build-meta option: ${flag ?? ""}`);
    }
    options.set(flag, value);
  }
  for (const required of [
    "--generation",
    "--source-group-generation",
    "--source-group-plan-digest",
    "--rounds",
    "--seed",
    "--groups",
    "--plan",
    "--completed",
  ]) {
    if (!options.has(required)) throw new TypeError(`build-meta requires ${required}`);
  }
  return options;
}

function readCliEvidenceFile(file, maxBytes, label) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
    throw new TypeError(`${label} path is invalid`);
  }
  const read = readStableRegularFile(path.resolve(file), maxBytes, label, {
    requiredOwner: typeof process.getuid === "function" ? process.getuid() : null,
  });
  if (!read.present || read.bytes === null || read.errors.length > 0) {
    throw new TypeError(`${label} could not be read as an owned, stable, bounded regular file`);
  }
  return read.bytes;
}

function buildMetaForCli(args) {
  const options = parseBuildMetaCliOptions(args);
  const roundsPerContext = canonicalPositiveUint(options.get("--rounds"), PINNED_CONCURRENT_PLAN_MAX_ROWS);
  const scheduleSeed = canonicalUint(options.get("--seed"));
  const completedText = options.get("--completed");
  const completed = completedText === "1" ? true : completedText === "0" ? false : null;
  if (roundsPerContext === null || scheduleSeed === null || completed === null) {
    throw new TypeError("build-meta rounds, seed, or completed value is invalid");
  }
  const groupsBytes = readCliEvidenceFile(
    options.get("--groups"),
    PINNED_CONCURRENT_GROUPS_MAX_BYTES,
    "pinned-concurrent groups",
  );
  const groupsParsed = parsePinnedConcurrentGroups(groupsBytes, { roundsPerContext });
  if (groupsParsed.reasons.length > 0) throw new TypeError(groupsParsed.reasons.join("; "));
  const planBytes = readCliEvidenceFile(
    options.get("--plan"),
    PINNED_CONCURRENT_PLAN_MAX_BYTES,
    "pinned-concurrent plan",
  );
  const planParsed = parsePinnedConcurrentPlan(planBytes, {
    groupsRows: groupsParsed.rows,
    roundsPerContext,
  });
  if (planParsed.reasons.length > 0) throw new TypeError(planParsed.reasons.join("; "));

  let resultsBytes = null;
  let resultsRows = [];
  if (options.has("--results")) {
    resultsBytes = readCliEvidenceFile(
      options.get("--results"),
      PINNED_CONCURRENT_RESULTS_MAX_BYTES,
      "pinned-concurrent results",
    );
    const parsed = parsePinnedConcurrentResults(resultsBytes, { planRows: planParsed.rows });
    if (parsed.reasons.length > 0) throw new TypeError(parsed.reasons.join("; "));
    resultsRows = parsed.rows;
  }
  let boundariesBytes = null;
  let boundaryRows = [];
  if (options.has("--boundaries")) {
    boundariesBytes = readCliEvidenceFile(
      options.get("--boundaries"),
      PINNED_CONCURRENT_BOUNDARIES_MAX_BYTES,
      "pinned-concurrent boundaries",
    );
    const parsed = parsePinnedConcurrentBoundaries(boundariesBytes, {
      planRows: planParsed.rows,
      resultRows: resultsRows,
    });
    if (parsed.reasons.length > 0) throw new TypeError(parsed.reasons.join("; "));
    boundaryRows = parsed.rows;
  }
  if (completed && (!options.has("--results") || !options.has("--boundaries") ||
      resultsRows.length !== planParsed.rows.length || boundaryRows.length !== planParsed.rows.length)) {
    throw new TypeError("completed build-meta requires exact full-plan result and boundary files");
  }
  if (!completed && options.has("--boundaries")) {
    throw new TypeError("incomplete build-meta forbids a terminal boundary file");
  }
  const meta = buildPinnedConcurrentMeta({
    generation: options.get("--generation"),
    sourceGroupGeneration: options.get("--source-group-generation"),
    sourceGroupPlanDigest: options.get("--source-group-plan-digest"),
    roundsPerContext,
    scheduleSeed,
    groupsBytes,
    groupsRowCount: groupsParsed.rows.length,
    planBytes,
    planRowCount: planParsed.rows.length,
    resultsBytes: completed ? resultsBytes : null,
    resultsRowCount: completed ? resultsRows.length : null,
    boundariesBytes: completed ? boundariesBytes : null,
    boundariesRowCount: completed ? boundaryRows.length : null,
    completed,
  });
  const text = serializePinnedConcurrentMeta(meta);
  if (options.has("--output")) {
    const output = options.get("--output");
    if (output.length === 0 || output.includes("\0")) throw new TypeError("output path is invalid");
    writeFileSync(path.resolve(output), text, { flag: "wx", mode: 0o600 });
  } else {
    process.stdout.write(text);
  }
}

function main(argv) {
  const [command, ...args] = argv;
  if ((command === "validate-before" || command === "validate-complete") &&
      (args.length === 1 || args.length === 6)) {
    const [bundle, ...expectationArgs] = args;
    const assessment = assessPinnedConcurrentEvidence(bundle, cliExpectations(expectationArgs));
    printCliAssessment(assessment);
    const valid = command === "validate-before"
      ? validateBeforeForCli(assessment)
      : assessment.status === "complete" || assessment.publicationReady === true;
    if (!valid) process.exitCode = 1;
    return;
  }
  if (command === "build-meta") {
    buildMetaForCli(args);
    return;
  }
  console.error(cliUsage());
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
