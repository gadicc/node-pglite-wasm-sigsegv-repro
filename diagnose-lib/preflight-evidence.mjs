// Strict validation for the fixed preflight environment snapshot.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export const PREFLIGHT_FILES = [
  "cmdline.txt",
  "cpuinfo-extra.txt",
  "cpufreq.txt",
  "cctk.txt",
  "date.txt",
  "dependencies.txt",
  "dmi.txt",
  "kernel-warnings.txt",
  "lscpu.txt",
  "node.txt",
  "online.txt",
  "os-release.txt",
  "power.txt",
  "summary.env",
  "topology.tsv",
  "uname.txt",
  "undervolt.txt",
];

export const PREFLIGHT_SUMMARY_KEYS = [
  "DISTRO",
  "KERNEL",
  "CMDLINE",
  "NODE_VERSION",
  "V8_VERSION",
  "PGLITE_VERSION",
  "CPU_MODEL",
  "CPU_STEPPING",
  "CPU_MICROCODE",
  "CPU_ADDRESS_SIZES",
  "CPU_LOGICAL",
  "ONLINE_CPUS",
  "KERNEL_ONLINE_CPUS",
  "ALLOWED_CPUS",
  "P_CORES",
  "E_CORES",
  "DMI_PRODUCT",
  "DMI_BOARD",
  "BIOS_VERSION",
  "BIOS_DATE",
  "CPUFREQ_DRIVER",
  "GOVERNOR",
  "EPP",
  "NO_TURBO",
  "TME_STATE",
  "POWER_SOURCE",
  "UNDERVOLT_STATE",
  "CCTK_STATE",
  "MISSING_OPTIONAL",
];

const META_KEYS = [
  "VERSION",
  "GENERATION",
  "COLLECTED_EPOCH",
  "INVENTORY_SHA256",
  "COMPLETED",
];
const META_FILE = "results/preflight.meta";
const MANIFEST_FILE = "env/preflight.manifest";
const MARKER_FILE = "state/phase-preflight.done";
const CONTROL_LIMIT = 16 * 1024;
const SUMMARY_LIMIT = 64 * 1024;
const ORDINARY_LIMIT = 1024 * 1024;
const LARGE_LIMIT = 16 * 1024 * 1024;
const LARGE_FILES = new Set(["kernel-warnings.txt", "lscpu.txt", "topology.tsv"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectPath(root, relative, finalType = "file") {
  const components = relative.split("/");
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "missing", file: current };
      return { state: "unsafe", file: current, reason: `${relative} could not be inspected` };
    }
    if (stat.isSymbolicLink()) {
      return {
        state: "unsafe",
        file: current,
        reason: `${components.slice(0, index + 1).join("/")} is a symbolic link`,
      };
    }
    const final = index === components.length - 1;
    if (!final && !stat.isDirectory()) {
      return {
        state: "unsafe",
        file: current,
        reason: `${components.slice(0, index + 1).join("/")} is not a directory`,
      };
    }
    if (final) {
      const valid = finalType === "directory" ? stat.isDirectory() : stat.isFile();
      if (!valid) {
        return {
          state: "unsafe",
          file: current,
          reason: `${relative} is not a regular ${finalType}`,
        };
      }
      return { state: "regular", file: current, stat };
    }
  }
  return { state: "missing", file: path.join(root, relative) };
}

function readBounded(root, relative, limit) {
  const inspection = inspectPath(root, relative, "file");
  if (inspection.state !== "regular") return inspection;
  let fd;
  try {
    fd = openSync(inspection.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { state: "unsafe", file: inspection.file, reason: `${relative} is not a regular file` };
    }
    if (stat.dev !== inspection.stat.dev || stat.ino !== inspection.stat.ino) {
      return { state: "unsafe", file: inspection.file, reason: `${relative} changed before it was opened` };
    }
    if (stat.size > limit) {
      return { state: "unsafe", file: inspection.file, reason: `${relative} exceeds ${limit} bytes` };
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > limit) {
        return { state: "unsafe", file: inspection.file, reason: `${relative} exceeds ${limit} bytes` };
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (total !== stat.size) {
      return { state: "unsafe", file: inspection.file, reason: `${relative} changed while being read` };
    }
    const bytes = Buffer.concat(chunks, total);
    return { state: "regular", file: inspection.file, stat, bytes, text: bytes.toString("utf8") };
  } catch {
    return { state: "unsafe", file: inspection.file, reason: `${relative} could not be read safely` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseExactKeyValues(text, expectedKeys, label) {
  const values = {};
  const reasons = [];
  if (!text.endsWith("\n")) reasons.push(`${label} is not newline-terminated`);
  if (text.includes("\0") || text.includes("\r")) reasons.push(`${label} contains forbidden control bytes`);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) {
      reasons.push(`${label} contains a malformed record`);
      continue;
    }
    const [, key, value] = match;
    if (seen.has(key)) reasons.push(`${label} contains duplicate ${key}`);
    seen.add(key);
    if (expectedKeys[index] !== key) {
      reasons.push(`${label} record ${index + 1} must be ${expectedKeys[index] ?? "absent"}`);
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      reasons.push(`${label} field ${key} contains a control character`);
    }
    if (!Object.hasOwn(values, key)) values[key] = value;
  }
  if (lines.length !== expectedKeys.length) {
    reasons.push(`${label} must contain exactly ${expectedKeys.length} records`);
  }
  for (const key of expectedKeys) {
    if (!seen.has(key)) reasons.push(`${label} is missing ${key}`);
  }
  return { values, reasons: [...new Set(reasons)] };
}

function canonicalPositiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isCanonicalCpuList(value) {
  if (typeof value !== "string" || value === "") return false;
  let previousEnd = -2;
  const canonical = [];
  for (const part of value.split(",")) {
    const match = part.match(/^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return false;
    if (start <= previousEnd + 1) return false;
    canonical.push(start === end ? `${start}` : `${start}-${end}`);
    previousEnd = end;
  }
  return canonical.join(",") === value;
}

function validateSummary(text) {
  const parsed = parseExactKeyValues(text, PREFLIGHT_SUMMARY_KEYS, "preflight summary");
  const { values, reasons } = parsed;
  if (canonicalPositiveInteger(values.CPU_LOGICAL) === null) {
    reasons.push("preflight summary CPU_LOGICAL must be a canonical safe positive integer");
  }
  for (const key of ["ONLINE_CPUS", "KERNEL_ONLINE_CPUS", "ALLOWED_CPUS"]) {
    if (!isCanonicalCpuList(values[key])) {
      reasons.push(`preflight summary ${key} must be a canonical CPU list`);
    }
  }
  for (const key of ["P_CORES", "E_CORES"]) {
    if (values[key] !== "none-detected" && !isCanonicalCpuList(values[key])) {
      reasons.push(`preflight summary ${key} must be a canonical CPU list or none-detected`);
    }
  }
  if (!["0", "1", "n/a"].includes(values.NO_TURBO)) {
    reasons.push("preflight summary NO_TURBO must be 0, 1, or n/a");
  }
  if (!["AC", "battery", "unknown"].includes(values.POWER_SOURCE)) {
    reasons.push("preflight summary POWER_SOURCE must be AC, battery, or unknown");
  }
  if (values.MISSING_OPTIONAL !== "none" &&
      !/^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/.test(values.MISSING_OPTIONAL ?? "")) {
    reasons.push("preflight summary MISSING_OPTIONAL must be none or a space-separated command list");
  }
  return { values, reasons: [...new Set(reasons)] };
}

function validateDate(text) {
  const reasons = [];
  if (!text.endsWith("\n")) reasons.push("preflight date is not newline-terminated");
  if (text.includes("\0") || text.includes("\r")) reasons.push("preflight date contains forbidden control bytes");
  const match = text.match(/^start_iso=([^\n]*)\nstart_epoch=([^\n]*)\n$/);
  if (!match) return { epoch: null, reasons: [...new Set([...reasons, "preflight date has an invalid schema"])] };
  const epoch = canonicalPositiveInteger(match[2]);
  if (epoch === null) reasons.push("preflight date start_epoch must be a canonical safe positive integer");
  return { epoch, reasons };
}

function validateManifest(text) {
  const reasons = [];
  const digests = {};
  if (!text.endsWith("\n")) reasons.push("preflight manifest is not newline-terminated");
  if (text.includes("\0") || text.includes("\r")) reasons.push("preflight manifest contains forbidden control bytes");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([0-9a-f]{64})\t([A-Za-z0-9.-]+)$/);
    if (!match) {
      reasons.push("preflight manifest contains a malformed record");
      continue;
    }
    const [, digest, name] = match;
    if (seen.has(name)) reasons.push(`preflight manifest contains duplicate ${name}`);
    seen.add(name);
    if (PREFLIGHT_FILES[index] !== name) {
      reasons.push(`preflight manifest record ${index + 1} must be ${PREFLIGHT_FILES[index] ?? "absent"}`);
    }
    if (!digests[name]) digests[name] = digest;
  }
  if (lines.length !== PREFLIGHT_FILES.length) {
    reasons.push(`preflight manifest must contain exactly ${PREFLIGHT_FILES.length} records`);
  }
  for (const name of PREFLIGHT_FILES) {
    if (!seen.has(name)) reasons.push(`preflight manifest is missing ${name}`);
  }
  return { digests, reasons: [...new Set(reasons)] };
}

function validateStoredCompletion(root) {
  const state = readBounded(root, "results/meta.env", 256 * 1024);
  if (state.state !== "regular") {
    return [state.reason ?? "stored run metadata is missing"];
  }
  if (!state.text.endsWith("\n")) return ["stored run metadata is not newline-terminated"];
  const rows = state.text.split("\n").filter((line) => line.startsWith("COMPLETED_PHASES="));
  if (rows.length !== 1) return ["stored run metadata must contain exactly one COMPLETED_PHASES record"];
  const phases = rows[0].slice("COMPLETED_PHASES=".length).split(",").filter(Boolean);
  if (phases.filter((phase) => phase === "preflight").length !== 1) {
    return ["stored COMPLETED_PHASES must contain preflight exactly once"];
  }
  return [];
}

function preflightTemporaryArtifacts(root) {
  const found = [];
  for (const [relative, prefix] of [
    ["env", ".preflight.manifest."],
    ["results", ".preflight.meta."],
  ]) {
    const inspection = inspectPath(root, relative, "directory");
    if (inspection.state !== "regular") continue;
    try {
      for (const name of readdirSync(inspection.file)) {
        if (name.startsWith(prefix)) found.push(`${relative}/${name}`);
      }
    } catch {
      found.push(`${relative}/${prefix}<unreadable>`);
    }
  }
  return found;
}

export function assessPreflightEvidence(outDir, options = {}) {
  const requireMarker = options.requireMarker !== false;
  const validateCompletion = options.validateStoredCompletion !== false && requireMarker;
  const root = path.resolve(outDir);
  const rootInspection = inspectPath(path.dirname(root), path.basename(root), "directory");
  if (rootInspection.state !== "regular") {
    return { status: "invalid", reasons: [rootInspection.reason ?? "bundle root is unavailable"], generation: null };
  }

  const relativeFiles = PREFLIGHT_FILES.map((name) => `env/${name}`);
  const allPaths = [META_FILE, MANIFEST_FILE, ...relativeFiles, MARKER_FILE];
  const inspections = new Map(allPaths.map((relative) => [relative, inspectPath(root, relative, "file")]));
  const temporaryArtifacts = preflightTemporaryArtifacts(root);
  if ([...inspections.values()].every(({ state }) => state === "missing") && temporaryArtifacts.length === 0) {
    return { status: "not-run", reasons: [], generation: null };
  }

  const reasons = [];
  let invalid = false;
  if (temporaryArtifacts.length > 0) {
    reasons.push(`stale preflight temporary artifacts are present: ${temporaryArtifacts.join(", ")}`);
  }
  for (const [relative, inspection] of inspections) {
    if (inspection.state === "unsafe") {
      reasons.push(inspection.reason ?? `${relative} is unsafe`);
      invalid = true;
    }
  }
  const rootReads = inspectPath(root, "env/root", "directory");
  if (rootReads.state === "unsafe") {
    reasons.push(rootReads.reason);
    invalid = true;
  }
  for (const relative of [META_FILE, MANIFEST_FILE, ...relativeFiles]) {
    if (inspections.get(relative).state === "missing") reasons.push(`${relative} is missing`);
  }
  let meta = {};
  const metaRead = readBounded(root, META_FILE, CONTROL_LIMIT);
  if (metaRead.state === "unsafe") {
    reasons.push(metaRead.reason);
    invalid = true;
  } else if (metaRead.state === "regular") {
    const parsed = parseExactKeyValues(metaRead.text, META_KEYS, "preflight metadata");
    meta = parsed.values;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
    if (meta.VERSION !== "1") reasons.push("preflight metadata VERSION must be 1"), invalid = true;
    if (!/^[0-9a-f]{32}$/.test(meta.GENERATION ?? "")) {
      reasons.push("preflight metadata GENERATION must be 32 lowercase hexadecimal characters");
      invalid = true;
    }
    if (canonicalPositiveInteger(meta.COLLECTED_EPOCH) === null) {
      reasons.push("preflight metadata COLLECTED_EPOCH must be a canonical safe positive integer");
      invalid = true;
    }
    if (!/^[0-9a-f]{64}$/.test(meta.INVENTORY_SHA256 ?? "")) {
      reasons.push("preflight metadata INVENTORY_SHA256 must be a lowercase SHA-256 digest");
      invalid = true;
    }
    if (meta.COMPLETED !== "1") reasons.push("preflight metadata COMPLETED must be 1"), invalid = true;
  }

  let manifest = { digests: {}, reasons: [] };
  const manifestRead = readBounded(root, MANIFEST_FILE, CONTROL_LIMIT);
  if (manifestRead.state === "unsafe") {
    reasons.push(manifestRead.reason);
    invalid = true;
  } else if (manifestRead.state === "regular") {
    manifest = validateManifest(manifestRead.text);
    if (manifest.reasons.length > 0) {
      reasons.push(...manifest.reasons);
      invalid = true;
    }
    if (meta.INVENTORY_SHA256 && sha256(manifestRead.bytes) !== meta.INVENTORY_SHA256) {
      reasons.push("preflight manifest digest does not match metadata");
      invalid = true;
    }
  }

  let summary = null;
  let collectedEpoch = null;
  for (const name of PREFLIGHT_FILES) {
    const limit = name === "summary.env" ? SUMMARY_LIMIT : LARGE_FILES.has(name) ? LARGE_LIMIT : ORDINARY_LIMIT;
    const state = readBounded(root, `env/${name}`, limit);
    if (state.state === "unsafe") {
      reasons.push(state.reason);
      invalid = true;
      continue;
    }
    if (state.state !== "regular") continue;
    if (manifest.digests[name] && sha256(state.bytes) !== manifest.digests[name]) {
      reasons.push(`preflight digest mismatch for ${name}`);
      invalid = true;
    }
    if (name === "summary.env") {
      const parsed = validateSummary(state.text);
      summary = parsed.values;
      if (parsed.reasons.length > 0) {
        reasons.push(...parsed.reasons);
        invalid = true;
      }
    } else if (name === "date.txt") {
      const parsed = validateDate(state.text);
      collectedEpoch = parsed.epoch;
      if (parsed.reasons.length > 0) {
        reasons.push(...parsed.reasons);
        invalid = true;
      }
    }
  }
  if (collectedEpoch !== null && canonicalPositiveInteger(meta.COLLECTED_EPOCH) !== collectedEpoch) {
    reasons.push("preflight metadata COLLECTED_EPOCH does not match env/date.txt");
    invalid = true;
  }
  if (validateCompletion) {
    const completionReasons = validateStoredCompletion(root);
    if (completionReasons.length > 0) {
      reasons.push(...completionReasons);
      invalid = true;
    }
  }

  // Treat this final no-follow open/read as the completion linearization
  // point. In particular, do not authorize the bundle from the marker's
  // earlier lstat: redo may remove or replace it while the envelope is read.
  const markerRead = readBounded(root, MARKER_FILE, 0);
  if (markerRead.state === "unsafe") {
    reasons.push(
      markerRead.reason?.includes("exceeds 0 bytes")
        ? "preflight phase completion marker must be zero bytes"
        : markerRead.reason,
    );
    invalid = true;
  } else if (requireMarker && markerRead.state === "missing") {
    reasons.push("preflight phase completion marker is missing");
  }

  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  const requiredPresent = [META_FILE, MANIFEST_FILE, ...relativeFiles].every(
    (relative) => inspections.get(relative).state === "regular",
  );
  const markerPresent = markerRead.state === "regular";
  const complete = !invalid && uniqueReasons.length === 0 && requiredPresent &&
    (!requireMarker || markerPresent) && summary !== null;
  return {
    status: complete ? "complete" : invalid ? "invalid" : "incomplete",
    reasons: uniqueReasons,
    generation: /^[0-9a-f]{32}$/.test(meta.GENERATION ?? "") ? meta.GENERATION : null,
    ...(complete ? { environment: summary } : {}),
  };
}

function checkFresh(outDir) {
  const assessment = assessPreflightEvidence(outDir, {
    requireMarker: false,
    validateStoredCompletion: false,
  });
  const root = path.resolve(outDir);
  const rootReads = inspectPath(root, "env/root", "directory");
  if (assessment.status === "not-run" && rootReads.state === "missing") return assessment;
  const reasons = [...assessment.reasons];
  if (rootReads.state !== "missing") reasons.push("env/root must be archived before a fresh preflight");
  if (assessment.status === "not-run") reasons.push("preflight output targets are not fresh");
  return { status: assessment.status === "invalid" ? "invalid" : "incomplete", reasons: [...new Set(reasons)] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [flag, outDir] = process.argv.slice(2);
  if (!["--check-fresh", "--validate-before-mark", "--validate-complete"].includes(flag) || !outDir) {
    console.error("usage: node preflight-evidence.mjs <--check-fresh|--validate-before-mark|--validate-complete> <out-dir>");
    process.exit(2);
  }
  const assessment = flag === "--check-fresh"
    ? checkFresh(outDir)
    : assessPreflightEvidence(outDir, {
      requireMarker: flag === "--validate-complete",
      validateStoredCompletion: flag === "--validate-complete",
    });
  if (flag === "--check-fresh" ? assessment.status !== "not-run" : assessment.status !== "complete") {
    for (const reason of assessment.reasons) console.error(reason);
    process.exit(1);
  }
}
