// Strict validation for the baseline phase evidence envelope. The log path is
// fixed by the schema: metadata is data, never path authority.

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReproLog } from "./parse-repro-log.mjs";

const BASELINE_LOG = "logs/baseline/run1.log";
const REQUIRED_KEYS = ["CHILDREN", "WAVES", "LOG", "EXIT_CODE"];

function canonicalPositiveUint(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function inspectPath(root, components, finalType) {
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
    }
  }
  return { state: "regular", file: current };
}

function readBaselineMeta(file) {
  const values = {};
  const reasons = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { values, reasons: ["baseline metadata could not be read"] };
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) {
      reasons.push("baseline metadata contains a malformed line");
      continue;
    }
    const [, key, value] = match;
    if (!REQUIRED_KEYS.includes(key)) {
      reasons.push(`baseline metadata contains unknown field ${key}`);
      continue;
    }
    if (Object.hasOwn(values, key)) {
      reasons.push(`baseline metadata contains duplicate field ${key}`);
      continue;
    }
    values[key] = value;
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(values, key)) reasons.push(`baseline metadata is missing field ${key}`);
  }
  if (lines.length !== REQUIRED_KEYS.length) {
    reasons.push(`baseline metadata must contain exactly ${REQUIRED_KEYS.length} records`);
  }
  return { values, reasons: [...new Set(reasons)] };
}

function configuredPositiveUint(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readStoredBaselineConfig(root) {
  const inspection = inspectPath(root, ["results", "meta.env"], "file");
  if (inspection.state !== "regular") {
    return {
      children: null,
      waves: null,
      reasons: [inspection.reason ?? "stored run metadata is missing"],
    };
  }
  let text;
  try {
    text = readFileSync(inspection.file, "utf8");
  } catch {
    return { children: null, waves: null, reasons: ["stored run metadata could not be read"] };
  }
  const found = { BASELINE_CHILDREN: [], BASELINE_WAVES: [] };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    if (Object.hasOwn(found, match[1])) found[match[1]].push(match[2]);
  }
  const reasons = [];
  for (const key of Object.keys(found)) {
    if (found[key].length !== 1) {
      reasons.push(`stored run metadata must contain exactly one ${key} field`);
    }
  }
  const children = found.BASELINE_CHILDREN.length === 1
    ? canonicalPositiveUint(found.BASELINE_CHILDREN[0])
    : null;
  const waves = found.BASELINE_WAVES.length === 1
    ? canonicalPositiveUint(found.BASELINE_WAVES[0])
    : null;
  if (found.BASELINE_CHILDREN.length === 1 && children === null) {
    reasons.push("stored BASELINE_CHILDREN is not a canonical safe positive integer");
  }
  if (found.BASELINE_WAVES.length === 1 && waves === null) {
    reasons.push("stored BASELINE_WAVES is not a canonical safe positive integer");
  }
  return { children, waves, reasons };
}

export function assessBaselineEvidence(outDir, expectations = {}) {
  const requireMarker = expectations.requireMarker !== false;
  const root = path.resolve(outDir);
  const rootInspection = inspectPath(path.dirname(root), [path.basename(root)], "directory");
  if (rootInspection.state !== "regular") {
    return { status: "invalid", reasons: [rootInspection.reason ?? "bundle root is unavailable"], meta: {}, parsed: null, log: BASELINE_LOG };
  }

  const metaInspection = inspectPath(root, ["results", "baseline.meta"], "file");
  const logInspection = inspectPath(root, ["logs", "baseline", "run1.log"], "file");
  const markerInspection = inspectPath(root, ["state", "phase-baseline.done"], "file");
  const samplesInspection = inspectPath(root, ["freq", "baseline.samples"], "file");
  const methodInspection = inspectPath(root, ["freq", "baseline.method"], "file");
  const inspections = [metaInspection, logInspection, markerInspection, samplesInspection, methodInspection];
  if (inspections.every(({ state }) => state === "missing")) {
    return { status: "not-run", reasons: [], meta: {}, parsed: null, log: BASELINE_LOG };
  }

  const reasons = [];
  let invalid = false;
  for (const inspection of inspections) {
    if (inspection.state === "unsafe") {
      reasons.push(inspection.reason);
      invalid = true;
    }
  }
  if (metaInspection.state === "missing") reasons.push("baseline metadata is missing");
  if (logInspection.state === "missing") reasons.push("baseline log is missing");
  if (requireMarker && markerInspection.state === "missing") reasons.push("phase completion marker is missing");

  let meta = {};
  let metaChildren = null;
  let metaWaves = null;
  let exitCode = null;
  if (metaInspection.state === "regular") {
    const state = readBaselineMeta(metaInspection.file);
    meta = state.values;
    if (state.reasons.length > 0) {
      reasons.push(...state.reasons);
      invalid = true;
    }
    metaChildren = canonicalPositiveUint(meta.CHILDREN);
    metaWaves = canonicalPositiveUint(meta.WAVES);
    if (metaChildren === null) {
      reasons.push("baseline CHILDREN is not a canonical safe positive integer");
      invalid = true;
    }
    if (metaWaves === null) {
      reasons.push("baseline WAVES is not a canonical safe positive integer");
      invalid = true;
    }
    if (meta.LOG !== BASELINE_LOG) {
      reasons.push(`baseline LOG must be exactly ${BASELINE_LOG}`);
      invalid = true;
    }
    if (meta.EXIT_CODE === "0" || meta.EXIT_CODE === "1") exitCode = Number(meta.EXIT_CODE);
    else {
      reasons.push("baseline EXIT_CODE must be exactly 0 or 1");
      invalid = true;
    }
  }

  let expectedChildren = configuredPositiveUint(expectations.expectedChildren);
  let expectedWaves = configuredPositiveUint(expectations.expectedWaves);
  if (expectations.validateStoredConfig === true) {
    const stored = readStoredBaselineConfig(root);
    if (stored.reasons.length > 0) {
      reasons.push(...stored.reasons);
      invalid = true;
    }
    if (expectedChildren !== null && stored.children !== null && expectedChildren !== stored.children) {
      reasons.push("runtime baseline children disagree with stored run metadata");
      invalid = true;
    }
    if (expectedWaves !== null && stored.waves !== null && expectedWaves !== stored.waves) {
      reasons.push("runtime baseline waves disagree with stored run metadata");
      invalid = true;
    }
    expectedChildren = stored.children;
    expectedWaves = stored.waves;
  }
  if (expectedChildren === null || expectedWaves === null) {
    reasons.push("stored baseline configuration is missing or invalid");
    invalid = true;
  } else {
    if (metaChildren !== null && metaChildren !== expectedChildren) {
      reasons.push(`baseline CHILDREN=${metaChildren} disagrees with stored configuration ${expectedChildren}`);
      invalid = true;
    }
    if (metaWaves !== null && metaWaves !== expectedWaves) {
      reasons.push(`baseline WAVES=${metaWaves} disagrees with stored configuration ${expectedWaves}`);
      invalid = true;
    }
  }

  let parsed = null;
  if (logInspection.state === "regular") {
    try {
      const parserExpectations = {};
      if (expectedChildren !== null) parserExpectations.expectedChildren = expectedChildren;
      if (expectedWaves !== null) parserExpectations.expectedWaves = expectedWaves;
      if (exitCode !== null) parserExpectations.exitCode = exitCode;
      parsed = parseReproLog(readFileSync(logInspection.file, "utf8"), parserExpectations);
      if (parsed.completionStatus === "inconsistent") {
        reasons.push("baseline log is structurally inconsistent with its evidence envelope");
        invalid = true;
      } else if (parsed.completionStatus !== "complete") {
        reasons.push("baseline log is incomplete");
      }
    } catch {
      reasons.push("baseline log could not be read or parsed");
      invalid = true;
    }
  }

  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  const complete = !invalid && uniqueReasons.length === 0 &&
    metaInspection.state === "regular" && logInspection.state === "regular" &&
    (!requireMarker || markerInspection.state === "regular") && parsed?.completionStatus === "complete";
  return {
    status: complete ? "complete" : invalid ? "invalid" : "incomplete",
    reasons: uniqueReasons,
    meta,
    parsed,
    log: BASELINE_LOG,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [flag, outDir, childrenS, wavesS] = process.argv.slice(2);
  if ((flag !== "--validate-complete" && flag !== "--validate-before-mark") ||
      !outDir || childrenS === undefined || wavesS === undefined) {
    console.error("usage: node baseline-evidence.mjs --validate-{complete,before-mark} <bundle> <children> <waves>");
    process.exit(2);
  }
  const children = canonicalPositiveUint(childrenS);
  const waves = canonicalPositiveUint(wavesS);
  const result = assessBaselineEvidence(outDir, {
    expectedChildren: children,
    expectedWaves: waves,
    requireMarker: flag === "--validate-complete",
    validateStoredConfig: true,
  });
  if (result.status !== "complete") {
    for (const reason of result.reasons) console.error(reason);
    process.exit(1);
  }
}
