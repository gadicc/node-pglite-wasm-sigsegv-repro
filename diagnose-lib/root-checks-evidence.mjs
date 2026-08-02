// Strict validation for the optional, out-of-band privileged-read snapshot.

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

export const ROOT_CHECK_PAYLOADS = [
  "kernel-warnings.txt",
  "intel-undervolt.txt",
  "cctk.txt",
  "turbostat.txt",
];

export const ROOT_CHECK_META_KEYS = [
  "VERSION",
  "GENERATION",
  "COLLECTED_AT",
  "KERNEL_WARNINGS_SHA256",
  "INTEL_UNDERVOLT_SHA256",
  "CCTK_SHA256",
  "TURBOSTAT_SHA256",
  "COMPLETED",
];

export const ROOT_CHECK_META_FILE = "root-checks.meta";
export const ROOT_CHECK_MARKER_FILE = "root-checks.done";

const META_LIMIT = 16 * 1024;
const PAYLOAD_LIMIT = 16 * 1024 * 1024;
const DIGEST_KEYS = {
  "kernel-warnings.txt": "KERNEL_WARNINGS_SHA256",
  "intel-undervolt.txt": "INTEL_UNDERVOLT_SHA256",
  "cctk.txt": "CCTK_SHA256",
  "turbostat.txt": "TURBOSTAT_SHA256",
};

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
      return { state: "unsafe", reason: `${relative} is not a regular file` };
    }
    if (stat.dev !== inspection.stat.dev || stat.ino !== inspection.stat.ino) {
      return { state: "unsafe", reason: `${relative} changed before it was opened` };
    }
    if (stat.size > limit) {
      return { state: "unsafe", reason: `${relative} exceeds ${limit} bytes` };
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > limit) {
        return { state: "unsafe", reason: `${relative} exceeds ${limit} bytes` };
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (total !== stat.size) {
      return { state: "unsafe", reason: `${relative} changed while being read` };
    }
    const bytes = Buffer.concat(chunks, total);
    return { state: "regular", stat, bytes, text: bytes.toString("utf8") };
  } catch {
    return { state: "unsafe", reason: `${relative} could not be read safely` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseMetadata(text) {
  const values = {};
  const reasons = [];
  if (!text.endsWith("\n")) reasons.push("root-checks metadata is not newline-terminated");
  if (text.includes("\0") || text.includes("\r")) {
    reasons.push("root-checks metadata contains forbidden control bytes");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) {
      reasons.push("root-checks metadata contains a malformed record");
      continue;
    }
    const [, key, value] = match;
    if (seen.has(key)) reasons.push(`root-checks metadata contains duplicate ${key}`);
    seen.add(key);
    if (ROOT_CHECK_META_KEYS[index] !== key) {
      reasons.push(`root-checks metadata record ${index + 1} must be ${ROOT_CHECK_META_KEYS[index] ?? "absent"}`);
    }
    if (/\p{Cc}/u.test(value)) reasons.push(`root-checks metadata field ${key} contains a control character`);
    if (!Object.hasOwn(values, key)) values[key] = value;
  }
  if (lines.length !== ROOT_CHECK_META_KEYS.length) {
    reasons.push(`root-checks metadata must contain exactly ${ROOT_CHECK_META_KEYS.length} records`);
  }
  for (const key of ROOT_CHECK_META_KEYS) {
    if (!seen.has(key)) reasons.push(`root-checks metadata is missing ${key}`);
  }
  if (values.VERSION !== "1") reasons.push("root-checks metadata VERSION must be 1");
  if (!/^[0-9a-f]{32}$/.test(values.GENERATION ?? "")) {
    reasons.push("root-checks metadata GENERATION must be 32 lowercase hexadecimal characters");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(values.COLLECTED_AT ?? "") ||
      !Number.isFinite(Date.parse(values.COLLECTED_AT))) {
    reasons.push("root-checks metadata COLLECTED_AT must be an ISO-8601 timestamp with a timezone");
  }
  for (const key of Object.values(DIGEST_KEYS)) {
    if (!/^[0-9a-f]{64}$/.test(values[key] ?? "")) {
      reasons.push(`root-checks metadata ${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (values.COMPLETED !== "1") reasons.push("root-checks metadata COMPLETED must be 1");
  return { values, reasons: [...new Set(reasons)] };
}

function assessDirectory(directory, markerMode) {
  const reasons = [];
  let invalid = false;
  const allowed = new Set([ROOT_CHECK_META_FILE, ...ROOT_CHECK_PAYLOADS]);
  if (markerMode === "required") allowed.add(ROOT_CHECK_MARKER_FILE);

  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return { status: "invalid", reasons: ["root-checks evidence directory could not be read"], generation: null };
  }
  for (const name of names) {
    if (!allowed.has(name)) {
      reasons.push(`root-checks evidence contains unexpected entry ${name}`);
      invalid = true;
    }
  }

  const reads = new Map();
  for (const name of [ROOT_CHECK_META_FILE, ...ROOT_CHECK_PAYLOADS]) {
    const state = readBounded(directory, name, name === ROOT_CHECK_META_FILE ? META_LIMIT : PAYLOAD_LIMIT);
    reads.set(name, state);
    if (state.state === "missing") reasons.push(`env/root/${name} is missing`);
    if (state.state === "unsafe") {
      reasons.push(state.reason);
      invalid = true;
    }
  }

  let metadata = {};
  const metaRead = reads.get(ROOT_CHECK_META_FILE);
  if (metaRead.state === "regular") {
    const parsed = parseMetadata(metaRead.text);
    metadata = parsed.values;
    if (parsed.reasons.length > 0) {
      reasons.push(...parsed.reasons);
      invalid = true;
    }
  }

  const rootChecks = {};
  for (const name of ROOT_CHECK_PAYLOADS) {
    const state = reads.get(name);
    if (state.state !== "regular") continue;
    const digestKey = DIGEST_KEYS[name];
    if (metadata[digestKey] && sha256(state.bytes) !== metadata[digestKey]) {
      reasons.push(`root-checks digest mismatch for ${name}`);
      invalid = true;
    }
    rootChecks[name] = state.text.trim();
  }

  let markerPresent = false;
  if (markerMode === "required") {
    // This final no-follow read is the completion linearization point.
    const markerRead = readBounded(directory, ROOT_CHECK_MARKER_FILE, 0);
    markerPresent = markerRead.state === "regular";
    if (markerRead.state === "missing") reasons.push("root-checks completion marker is missing");
    if (markerRead.state === "unsafe") {
      reasons.push(
        markerRead.reason?.includes("exceeds 0 bytes")
          ? "root-checks completion marker must be zero bytes"
          : markerRead.reason,
      );
      invalid = true;
    }
  }

  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  const payloadsPresent = [ROOT_CHECK_META_FILE, ...ROOT_CHECK_PAYLOADS]
    .every((name) => reads.get(name).state === "regular");
  const complete = !invalid && uniqueReasons.length === 0 && payloadsPresent &&
    (markerMode !== "required" || markerPresent);
  return {
    status: complete ? "complete" : invalid ? "invalid" : "incomplete",
    reasons: uniqueReasons,
    generation: /^[0-9a-f]{32}$/.test(metadata.GENERATION ?? "") ? metadata.GENERATION : null,
    collectedAt: metadata.COLLECTED_AT ?? null,
    ...(complete ? { rootChecks } : {}),
  };
}

export function assessRootChecksEvidence(outDir, options = {}) {
  const markerMode = options.requireMarker === false ? "forbidden" : "required";
  const bundle = path.resolve(outDir);
  const bundleInspection = inspectPath(path.dirname(bundle), path.basename(bundle), "directory");
  if (bundleInspection.state !== "regular") {
    return { status: "invalid", reasons: [bundleInspection.reason ?? "bundle root is unavailable"], generation: null };
  }
  const rootInspection = inspectPath(bundle, "env/root", "directory");
  if (rootInspection.state === "missing") return { status: "not-run", reasons: [], generation: null };
  if (rootInspection.state !== "regular") {
    return { status: "invalid", reasons: [rootInspection.reason], generation: null };
  }
  return assessDirectory(rootInspection.file, markerMode);
}

export function assessRootChecksStage(stageDir) {
  const stage = path.resolve(stageDir);
  const inspection = inspectPath(path.dirname(stage), path.basename(stage), "directory");
  if (inspection.state === "missing") return { status: "incomplete", reasons: ["root-checks staging directory is missing"], generation: null };
  if (inspection.state !== "regular") {
    return { status: "invalid", reasons: [inspection.reason], generation: null };
  }
  return assessDirectory(inspection.file, "forbidden");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [flag, target] = process.argv.slice(2);
  let assessment;
  if (flag === "--validate-stage" && target) {
    assessment = assessRootChecksStage(target);
  } else if (flag === "--validate-before-marker" && target) {
    assessment = assessRootChecksEvidence(target, { requireMarker: false });
  } else if (flag === "--validate-complete" && target) {
    assessment = assessRootChecksEvidence(target);
  } else {
    console.error("usage: node root-checks-evidence.mjs <--validate-stage|--validate-before-marker|--validate-complete> <path>");
    process.exit(2);
  }
  if (assessment.status !== "complete") {
    for (const reason of assessment.reasons) console.error(reason);
    process.exit(1);
  }
}
