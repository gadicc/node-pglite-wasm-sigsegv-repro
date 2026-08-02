// Strict validation for the CPU-group phase evidence envelope. The plan is
// ordered and its digest covers every non-outcome TSV field, so a row cannot
// be omitted, invented, reordered, or reused from another topology/config
// generation without invalidating the envelope.

import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReproLog } from "./parse-repro-log.mjs";

const REQUIRED_META_KEYS = ["VERSION", "EXPECTED_ROWS", "GROUP_WAVES", "PLAN_DIGEST", "COMPLETED"];
const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

function canonicalUint(value, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

function canonicalPositiveUint(value, max = Number.MAX_SAFE_INTEGER) {
  const parsed = canonicalUint(value, max);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseCanonicalCpuList(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return null;
  const parts = value.split(",");
  if (parts.length > 65536) return null;
  let previous = -2;
  let count = 0;
  const ranges = [];
  for (const part of parts) {
    const match = part.match(/^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/);
    if (!match) return null;
    const first = canonicalUint(match[1], 65535);
    const last = match[2] === undefined ? first : canonicalUint(match[2], 65535);
    if (first === null || last === null || first > last ||
        (match[2] !== undefined && first === last) || first <= previous + 1) return null;
    count += last - first + 1;
    if (!Number.isSafeInteger(count) || count > 65536) return null;
    ranges.push([first, last]);
    previous = last;
  }
  return { count, ranges };
}

function compressCpuRanges(ranges) {
  const sorted = ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const parts = [];
  for (const [first, last] of sorted) {
    const previous = parts.at(-1);
    if (previous && first <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], last);
    } else {
      parts.push([first, last]);
    }
  }
  return parts.map(([first, last]) => first === last ? `${first}` : `${first}-${last}`).join(",");
}

function validCluster(value) {
  if (value === "-") return true;
  if (value === "unknown") return true;
  if (canonicalUint(value, 65535) !== null) return true;
  if (typeof value !== "string" || !value.startsWith("l2:") || value.length > 1027) return false;
  return parseCanonicalCpuList(value.slice(3)) !== null;
}

function inspectPath(root, components, finalType, maxBytes = null) {
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "missing", file: current };
      return { state: "unsafe", file: current, reason: `cannot inspect ${components.join("/")}` };
    }
    if (stat.isSymbolicLink()) {
      return { state: "unsafe", file: current, reason: `${components.slice(0, index + 1).join("/")} is a symbolic link` };
    }
    const isFinal = index === components.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      return { state: "unsafe", file: current, reason: `${components.slice(0, index + 1).join("/")} is not a directory` };
    }
    if (isFinal) {
      const valid = finalType === "file" ? stat.isFile() : stat.isDirectory();
      if (!valid) {
        return { state: "unsafe", file: current, reason: `${components.join("/")} is not a regular ${finalType}` };
      }
      if (maxBytes !== null && stat.size > maxBytes) {
        return { state: "unsafe", file: current, reason: `${components.join("/")} exceeds the safe size limit` };
      }
    }
  }
  return { state: "regular", file: current };
}

function readBoundedText(inspection) {
  try {
    return readFileSync(inspection.file, "utf8");
  } catch {
    return null;
  }
}

function parseMeta(text) {
  const values = {};
  const reasons = [];
  const lines = text.split("\n");
  if (text !== "" && !text.endsWith("\n")) reasons.push("groups metadata must end with a newline");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) {
      reasons.push("groups metadata contains a malformed line");
      continue;
    }
    const [, key, value] = match;
    if (!REQUIRED_META_KEYS.includes(key)) {
      reasons.push(`groups metadata contains unknown field ${key}`);
    } else if (Object.hasOwn(values, key)) {
      reasons.push(`groups metadata contains duplicate field ${key}`);
    } else {
      values[key] = value;
    }
  }
  for (const key of REQUIRED_META_KEYS) {
    if (!Object.hasOwn(values, key)) reasons.push(`groups metadata is missing field ${key}`);
  }
  if (lines.length !== REQUIRED_META_KEYS.length) {
    reasons.push(`groups metadata must contain exactly ${REQUIRED_META_KEYS.length} records`);
  }
  return { values, reasons: [...new Set(reasons)] };
}

function parseRows(text, expectedFields) {
  if (text === "") return { rows: [], reasons: [] };
  const lines = text.split("\n");
  const reasons = [];
  if (!text.endsWith("\n")) reasons.push("groups results must end with a newline");
  if (lines.at(-1) === "") lines.pop();
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fields = lines[index].split("\t");
    if (fields.length !== expectedFields) {
      reasons.push(`groups row ${index + 1} must contain exactly ${expectedFields} fields`);
      continue;
    }
    rows.push(fields);
  }
  return { rows, reasons };
}

function validatePlanRow(row, rowNumber, wavesExpected) {
  const reasons = [];
  const [name, kind, cpus, cluster, childrenS, wavesS, log, freqTag] = row;
  const cpuState = parseCanonicalCpuList(cpus);
  const children = canonicalPositiveUint(childrenS, 16);
  const waves = canonicalPositiveUint(wavesS);
  if (!NAME_RE.test(name)) reasons.push(`groups row ${rowNumber} has an unsafe or overlong name`);
  if (!KIND_RE.test(kind)) reasons.push(`groups row ${rowNumber} has an unsafe or overlong kind`);
  if (!cpuState) reasons.push(`groups row ${rowNumber} has a noncanonical or out-of-range CPU list`);
  if (!validCluster(cluster)) reasons.push(`groups row ${rowNumber} has an invalid cluster token`);
  if (children === null || (cpuState && children !== Math.min(cpuState.count, 16))) {
    reasons.push(`groups row ${rowNumber} has an invalid children count`);
  }
  if (waves === null || (wavesExpected !== null && waves !== wavesExpected)) {
    reasons.push(`groups row ${rowNumber} has an invalid or mismatched wave count`);
  }
  if (NAME_RE.test(name)) {
    if (log !== `logs/groups/${name}.log`) reasons.push(`groups row ${rowNumber} has a noncanonical log path`);
    if (freqTag !== `group-${name}`) reasons.push(`groups row ${rowNumber} has a noncanonical frequency tag`);
  }
  if (kind === "pcore" && (name !== "pcores" || cluster !== "-")) {
    reasons.push(`groups row ${rowNumber} has inconsistent pcore identity fields`);
  } else if (kind === "ecore" && (name !== "ecores" || cluster !== "-")) {
    reasons.push(`groups row ${rowNumber} has inconsistent ecore identity fields`);
  } else if (kind === "uniform" && (name !== "all-cpus" || cluster !== "-")) {
    reasons.push(`groups row ${rowNumber} has inconsistent uniform identity fields`);
  } else if (kind === "ecluster") {
    const expectedName = cluster.startsWith("l2:")
      ? `ecluster-l2-${createHash("sha256").update(cluster).digest("hex").slice(0, 12)}`
      : `ecluster-${cluster}`;
    if (name !== expectedName || cluster === "-") {
      reasons.push(`groups row ${rowNumber} has inconsistent ecluster identity fields`);
    }
  } else if (!["pcore", "ecore", "uniform", "ecluster"].includes(kind)) {
    reasons.push(`groups row ${rowNumber} has an unsupported group kind`);
  }
  return reasons;
}

function validatePlanRows(rows, wavesExpected) {
  const reasons = [];
  const names = new Set();
  const logs = new Set();
  const tags = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    reasons.push(...validatePlanRow(rows[index], index + 1, wavesExpected));
    const [name, , , , , , log, tag] = rows[index];
    if (names.has(name)) reasons.push(`groups plan row ${index + 1} duplicates a name`);
    if (logs.has(log)) reasons.push(`groups plan row ${index + 1} duplicates a log path`);
    if (tags.has(tag)) reasons.push(`groups plan row ${index + 1} duplicates a frequency tag`);
    names.add(name);
    logs.add(log);
    tags.add(tag);
  }
  return reasons;
}

export function groupsPlanDigest(planRows) {
  const canonical = planRows.map((row) => row.join("\t")).join("\n") + (planRows.length > 0 ? "\n" : "");
  return createHash("sha256").update(canonical).digest("hex");
}

// Derive phase-4 selection exclusively from a completed, validated groups
// envelope. In particular, parsed failed-wave counts include accepted failures
// that have no child detail row, while the no-failure fallback retains the CPU
// universe recorded by the group plan rather than consulting live topology.
export function deriveIndividualTargetPolicy(groupsAssessment, mode) {
  if (groupsAssessment?.status !== "complete" || !["quick", "default", "full"].includes(mode)) return null;
  const failingEntries = groupsAssessment.entries.filter(({ parsed }) => parsed?.failedWaves > 0);
  const targetEntries = failingEntries.length > 0
    ? failingEntries
    : mode === "quick" ? [] : groupsAssessment.entries;
  const ranges = [];
  for (const entry of targetEntries) {
    const parsed = parseCanonicalCpuList(entry.cpus);
    if (!parsed || ranges.length + parsed.ranges.length > 65536) return null;
    ranges.push(...parsed.ranges);
  }
  const skipped = failingEntries.length === 0 && mode === "quick";
  if (!skipped && ranges.length === 0) return null;
  return {
    targetPolicy: failingEntries.length > 0 ? "failed-groups" : skipped ? "quick-skip" : "all-group-cpus",
    targetCpus: compressCpuRanges(ranges),
    groupPlanDigest: groupsAssessment.meta.PLAN_DIGEST,
    skipped,
  };
}

export function readGroupsPlanFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return { rows: [], reasons: ["expected groups plan is missing"] };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_BYTES) {
    return { rows: [], reasons: ["expected groups plan must be a bounded regular non-symlink file"] };
  }
  try {
    return parseRows(readFileSync(file, "utf8"), 8);
  } catch {
    return { rows: [], reasons: ["expected groups plan could not be read"] };
  }
}

function boundedDirectoryHas(root, components, predicate = () => true) {
  const inspection = inspectPath(root, components, "directory");
  if (inspection.state !== "regular") return { state: inspection.state, reason: inspection.reason, found: false };
  let directory;
  try {
    directory = opendirSync(inspection.file);
    for (let count = 0; count <= 4096; count += 1) {
      const entry = directory.readSync();
      if (entry === null) return { state: "regular", found: false };
      if (predicate(entry.name)) return { state: "regular", found: true };
      if (count === 4096) return { state: "unsafe", reason: `${components.join("/")} has too many entries`, found: true };
    }
  } catch {
    return { state: "unsafe", reason: `${components.join("/")} could not be inspected`, found: true };
  } finally {
    try { directory?.closeSync(); } catch { /* best effort */ }
  }
  return { state: "unsafe", reason: `${components.join("/")} could not be inspected`, found: true };
}

function groupArtifactsPresent(root, metaInspection, tsvInspection, markerInspection) {
  if ([metaInspection, tsvInspection, markerInspection].some(({ state }) => state !== "missing")) return true;
  const logs = boundedDirectoryHas(root, ["logs", "groups"]);
  const freq = boundedDirectoryHas(root, ["freq"], (name) => name.startsWith("group-"));
  return logs.found || freq.found || logs.state === "unsafe" || freq.state === "unsafe";
}

export function assessGroupsEvidence(outDir, expectations = {}) {
  const requireMarker = expectations.requireMarker !== false;
  const root = path.resolve(outDir);
  const rootInspection = inspectPath(path.dirname(root), [path.basename(root)], "directory");
  if (rootInspection.state !== "regular") {
    return { status: "invalid", reasons: [rootInspection.reason ?? "bundle root is unavailable"], rows: [], entries: [], meta: {} };
  }

  const metaInspection = inspectPath(root, ["results", "groups.meta"], "file", MAX_CONTROL_BYTES);
  const tsvInspection = inspectPath(root, ["results", "groups.tsv"], "file", MAX_CONTROL_BYTES);
  const markerInspection = inspectPath(root, ["state", "phase-groups.done"], "file", MAX_CONTROL_BYTES);
  if (!groupArtifactsPresent(root, metaInspection, tsvInspection, markerInspection)) {
    return { status: "not-run", reasons: [], rows: [], entries: [], meta: {} };
  }

  const reasons = [];
  let invalid = false;
  for (const inspection of [metaInspection, tsvInspection, markerInspection]) {
    if (inspection.state === "unsafe") {
      reasons.push(inspection.reason);
      invalid = true;
    }
  }
  if (metaInspection.state === "missing") reasons.push("groups metadata is missing");
  if (tsvInspection.state === "missing") reasons.push("groups results are missing");
  if (requireMarker && markerInspection.state === "missing") reasons.push("phase completion marker is missing");
  for (const directoryState of [
    boundedDirectoryHas(root, ["logs", "groups"]),
    boundedDirectoryHas(root, ["freq"], (name) => name.startsWith("group-")),
  ]) {
    if (directoryState.state === "unsafe") {
      reasons.push(directoryState.reason);
      invalid = true;
    }
  }

  let meta = {};
  let expectedRows = null;
  let metaWaves = null;
  let completed = null;
  if (metaInspection.state === "regular") {
    const text = readBoundedText(metaInspection);
    if (text === null) {
      reasons.push("groups metadata could not be read");
      invalid = true;
    } else {
      const parsed = parseMeta(text);
      meta = parsed.values;
      if (parsed.reasons.length > 0) {
        reasons.push(...parsed.reasons);
        invalid = true;
      }
      if (meta.VERSION !== "1") {
        reasons.push("groups metadata version is missing or unsupported");
        invalid = true;
      }
      expectedRows = canonicalPositiveUint(meta.EXPECTED_ROWS, 65536);
      if (expectedRows === null) {
        reasons.push("groups EXPECTED_ROWS is not a canonical bounded positive integer");
        invalid = true;
      }
      metaWaves = canonicalPositiveUint(meta.GROUP_WAVES);
      if (metaWaves === null) {
        reasons.push("groups GROUP_WAVES is not a canonical safe positive integer");
        invalid = true;
      }
      if (!DIGEST_RE.test(meta.PLAN_DIGEST ?? "")) {
        reasons.push("groups PLAN_DIGEST is malformed");
        invalid = true;
      }
      completed = meta.COMPLETED === "1" ? true : meta.COMPLETED === "0" ? false : null;
      if (completed === null) {
        reasons.push("groups COMPLETED flag is malformed");
        invalid = true;
      } else if (!completed) {
        reasons.push("groups evidence is not marked complete");
      }
    }
  }

  const configuredWaves = Number.isSafeInteger(expectations.expectedGroupWaves) && expectations.expectedGroupWaves > 0
    ? expectations.expectedGroupWaves
    : null;
  if (configuredWaves === null) {
    reasons.push("stored group-wave configuration is missing or invalid");
    invalid = true;
  } else if (metaWaves !== null && metaWaves !== configuredWaves) {
    reasons.push(`groups GROUP_WAVES=${metaWaves} disagrees with stored configuration ${configuredWaves}`);
    invalid = true;
  }

  let rows = [];
  if (tsvInspection.state === "regular") {
    const text = readBoundedText(tsvInspection);
    if (text === null) {
      reasons.push("groups results could not be read");
      invalid = true;
    } else {
      const parsed = parseRows(text, 9);
      rows = parsed.rows;
      if (parsed.reasons.length > 0) {
        reasons.push(...parsed.reasons);
        invalid = true;
      }
    }
  }

  const names = new Set();
  const logs = new Set();
  const freqTags = new Set();
  const planRows = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowReasons = validatePlanRow(row.slice(0, 8), index + 1, metaWaves ?? configuredWaves);
    const rc = row[8];
    if (rc !== "0" && rc !== "1") rowReasons.push(`groups row ${index + 1} has an invalid exit code`);
    const [name, , , , , , log, freqTag] = row;
    if (names.has(name)) rowReasons.push(`groups row ${index + 1} duplicates a group name`);
    if (logs.has(log)) rowReasons.push(`groups row ${index + 1} duplicates a log path`);
    if (freqTags.has(freqTag)) rowReasons.push(`groups row ${index + 1} duplicates a frequency tag`);
    names.add(name);
    logs.add(log);
    freqTags.add(freqTag);
    if (rowReasons.length > 0) {
      reasons.push(...rowReasons);
      invalid = true;
    }
    planRows.push(row.slice(0, 8));
  }
  if (expectedRows !== null && rows.length !== expectedRows) {
    reasons.push(`groups results contain ${rows.length} row(s), expected ${expectedRows}`);
  }
  if (DIGEST_RE.test(meta.PLAN_DIGEST ?? "") && expectedRows !== null &&
      planRows.length === expectedRows && groupsPlanDigest(planRows) !== meta.PLAN_DIGEST) {
    reasons.push("groups row plan does not match its recorded generation digest");
    invalid = true;
  }

  if (expectations.expectedPlanRows) {
    const expectedPlanRows = expectations.expectedPlanRows;
    const expectedPlanReasons = validatePlanRows(expectedPlanRows, configuredWaves);
    if (expectedPlanReasons.length > 0) {
      reasons.push("rediscovered groups plan is invalid", ...expectedPlanReasons);
      invalid = true;
    } else {
      const expectedDigest = groupsPlanDigest(expectedPlanRows);
      if (metaInspection.state === "regular" && DIGEST_RE.test(meta.PLAN_DIGEST ?? "") &&
          meta.PLAN_DIGEST !== expectedDigest) {
        reasons.push("groups evidence disagrees with the rediscovered topology plan");
        invalid = true;
      }
      if (expectedRows !== null && expectedRows !== expectedPlanRows.length) {
        reasons.push("groups row count disagrees with the rediscovered topology plan");
        invalid = true;
      }
      if (planRows.some((row, index) => index >= expectedPlanRows.length ||
          row.join("\t") !== expectedPlanRows[index].join("\t"))) {
        reasons.push("groups rows are not an exact prefix of the rediscovered topology plan");
        invalid = true;
      }
    }
  }

  const entries = [];
  const parsedLogs = new Map();
  if (!invalid) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const [name, kind, cpus, clusterId, childrenS, wavesS, logRel, freqTag, exitCodeS] = row;
      const logInspection = inspectPath(root, ["logs", "groups", `${name}.log`], "file", MAX_LOG_BYTES);
      if (logInspection.state === "missing") {
        reasons.push(`group ${name} log is missing`);
        continue;
      }
      if (logInspection.state !== "regular") {
        reasons.push(logInspection.reason);
        invalid = true;
        continue;
      }
      for (const suffix of ["samples", "method"]) {
        const frequencyInspection = inspectPath(root, ["freq", `${freqTag}.${suffix}`], "file", MAX_CONTROL_BYTES * 16);
        if (frequencyInspection.state === "unsafe") {
          reasons.push(frequencyInspection.reason);
          invalid = true;
        }
      }
      let parsed = parsedLogs.get(logRel);
      if (!parsed) {
        try {
          parsed = parseReproLog(readFileSync(logInspection.file, "utf8"), {
            expectedChildren: Number(childrenS),
            expectedWaves: Number(wavesS),
            exitCode: Number(exitCodeS),
          });
          parsedLogs.set(logRel, parsed);
        } catch {
          reasons.push(`group ${name} log could not be read or parsed`);
          invalid = true;
          continue;
        }
      }
      if (parsed.completionStatus === "inconsistent") {
        reasons.push(`group ${name} log is structurally inconsistent with its row`);
        invalid = true;
      } else if (parsed.completionStatus !== "complete") {
        reasons.push(`group ${name} log is incomplete`);
      }
      entries.push({
        name,
        kind,
        cpus,
        clusterId: clusterId === "-" ? null : clusterId,
        children: Number(childrenS),
        wavesRequested: Number(wavesS),
        log: logRel,
        freqTag,
        exitCode: Number(exitCodeS),
        parsed,
      });
    }
  }

  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  const complete = !invalid && uniqueReasons.length === 0 && completed === true &&
    metaInspection.state === "regular" && tsvInspection.state === "regular" &&
    (!requireMarker || markerInspection.state === "regular") && expectedRows !== null &&
    rows.length === expectedRows && entries.length === rows.length &&
    entries.every(({ parsed }) => parsed?.completionStatus === "complete");
  return {
    status: complete ? "complete" : invalid ? "invalid" : "incomplete",
    reasons: uniqueReasons,
    rows,
    entries,
    meta,
  };
}

export function checkFreshGroupsTargets(outDir, expectedPlanRows) {
  const planReasons = validatePlanRows(expectedPlanRows, null);
  if (planReasons.length > 0) return planReasons;
  const root = path.resolve(outDir);
  const reasons = [];
  for (const components of [["results"], ["logs"], ["freq"], ["state"]]) {
    const inspection = inspectPath(root, components, "directory");
    if (inspection.state !== "regular") reasons.push(inspection.reason ?? `${components[0]} directory is missing`);
  }
  for (const components of [
    ["results", "groups.meta"], ["results", "groups.tsv"], ["state", "phase-groups.done"],
  ]) {
    const inspection = inspectPath(root, components, "file");
    if (inspection.state !== "missing") reasons.push(`${components.join("/")} already exists or is unsafe`);
  }
  const logsDir = inspectPath(root, ["logs", "groups"], "directory");
  if (logsDir.state === "unsafe") reasons.push(logsDir.reason);
  const existingLogs = boundedDirectoryHas(root, ["logs", "groups"]);
  if (existingLogs.state === "unsafe") reasons.push(existingLogs.reason);
  else if (existingLogs.found) reasons.push("logs/groups contains existing evidence");
  const existingFreq = boundedDirectoryHas(root, ["freq"], (name) => name.startsWith("group-"));
  if (existingFreq.state === "unsafe") reasons.push(existingFreq.reason);
  else if (existingFreq.found) reasons.push("freq contains existing CPU-group evidence");
  for (const row of expectedPlanRows) {
    const name = row[0];
    const freqTag = row[7];
    for (const components of [
      ["logs", "groups", `${name}.log`],
      ["freq", `${freqTag}.samples`],
      ["freq", `${freqTag}.method`],
    ]) {
      const inspection = inspectPath(root, components, "file");
      if (inspection.state !== "missing") reasons.push(`${components.join("/")} already exists or is unsafe`);
    }
  }
  return [...new Set(reasons.filter(Boolean))];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [flag, outDirOrPlan, planFile, wavesS] = process.argv.slice(2);
  if (flag === "--plan-digest" && outDirOrPlan) {
    const plan = readGroupsPlanFile(outDirOrPlan);
    if (plan.reasons.length > 0) {
      for (const reason of plan.reasons) console.error(reason);
      process.exit(1);
    }
    const reasons = validatePlanRows(plan.rows, null);
    if (reasons.length > 0) {
      for (const reason of reasons) console.error(reason);
      process.exit(1);
    }
    console.log(groupsPlanDigest(plan.rows));
  } else if (["--check-fresh", "--validate-complete", "--validate-before-mark", "--individual-targets"].includes(flag) &&
      outDirOrPlan && planFile && wavesS !== undefined) {
    const plan = readGroupsPlanFile(planFile);
    const waves = canonicalPositiveUint(wavesS);
    if (plan.reasons.length > 0 || waves === null) {
      for (const reason of plan.reasons) console.error(reason);
      if (waves === null) console.error("expected group waves are invalid");
      process.exit(1);
    }
    if (flag === "--check-fresh") {
      const reasons = validatePlanRows(plan.rows, waves);
      if (reasons.length === 0) reasons.push(...checkFreshGroupsTargets(outDirOrPlan, plan.rows));
      if (reasons.length > 0) {
        for (const reason of reasons) console.error(reason);
        process.exit(1);
      }
    } else {
      const result = assessGroupsEvidence(outDirOrPlan, {
        expectedGroupWaves: waves,
        expectedPlanRows: plan.rows,
        requireMarker: flag !== "--validate-before-mark",
      });
      if (result.status !== "complete") {
        for (const reason of result.reasons) console.error(reason);
        process.exit(1);
      }
      if (flag === "--individual-targets") {
        const mode = process.argv[6];
        const target = deriveIndividualTargetPolicy(result, mode);
        if (!target) {
          console.error("cannot derive individual targets from groups evidence and mode");
          process.exit(1);
        }
        console.log(`TARGET_POLICY=${target.targetPolicy}`);
        console.log(`TARGET_CPUS=${target.targetCpus}`);
        console.log(`GROUP_PLAN_DIGEST=${target.groupPlanDigest}`);
      }
    }
  } else {
    console.error("usage: node groups-evidence.mjs --plan-digest <plan> | --{check-fresh,validate-complete,validate-before-mark} <bundle> <plan> <waves> | --individual-targets <bundle> <plan> <waves> <mode>");
    process.exit(2);
  }
}
