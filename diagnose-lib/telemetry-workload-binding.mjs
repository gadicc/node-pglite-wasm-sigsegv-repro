#!/usr/bin/env node

// Immutable workload identity for descriptive telemetry.
//
// The SHA-256 preimage is UTF-8 text with this exact grammar (and a final LF):
//
//   node-pglite-diagnostics/telemetry-workload-binding/v1
//   PHASE\t<phase>
//   FILE\t<canonical-relative-path>\t<exact-decimal-bytes>\t<lowerhex64-sha256>
//   ...
//
// FILE records occur in the fixed order declared below, followed (for the
// groups phase) by the canonical group log paths in bytewise lexical order.
// The domain/version, phase, relative paths, byte counts, and content digests
// are therefore all covered by the composite digest.  Workload evidence
// remains authoritative; this helper only gives telemetry an immutable
// reference to that evidence.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TELEMETRY_WORKLOAD_BINDING_VERSION = 1;
export const TELEMETRY_WORKLOAD_BINDING_FORMAT =
  "node-pglite-diagnostics/telemetry-workload-binding/v1";

export const TELEMETRY_WORKLOAD_FILE_MAX_BYTES = Object.freeze({
  "results/baseline.meta": 64 * 1024,
  "logs/baseline/run1.log": 64 * 1024 * 1024,
  "results/groups.meta": 1024 * 1024,
  "results/groups.tsv": 1024 * 1024,
  "results/individual.meta": 1024 * 1024,
  "results/pinned-concurrent.meta": 256 * 1024,
  // GDB permits at most 4,096 attempts, eight fixed records, and 512 bytes
  // of content plus LF per record.
  "results/gdb.manifest": (4_096 + 8) * (512 + 1),
});
export const TELEMETRY_GROUP_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const TELEMETRY_GROUP_LOG_TOTAL_MAX_BYTES = 512 * 1024 * 1024;

const MAX_PATH_BYTES = 4_096;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_BOUNDARY_ROWS = 20_000_000;
const MAX_GROUP_ROWS = 65_536;
const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const GROUP_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const GROUP_LOG_PATH_RE = /^logs\/groups\/([a-z][a-z0-9_-]{0,63})\.log$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const PHASE_SPECS = Object.freeze({
  baseline: Object.freeze({
    generation: "-",
    files: Object.freeze([
      Object.freeze({ path: "results/baseline.meta", control: "key-value" }),
      Object.freeze({ path: "logs/baseline/run1.log", control: null }),
    ]),
  }),
  groups: Object.freeze({
    outcomeLogsFrom: "results/groups.tsv",
    files: Object.freeze([
      Object.freeze({ path: "results/groups.meta", control: "key-value" }),
      Object.freeze({ path: "results/groups.tsv", control: "groups-tsv" }),
    ]),
  }),
  individual: Object.freeze({
    versions: Object.freeze(["5", "6"]),
    boundaries: true,
    files: Object.freeze([
      Object.freeze({ path: "results/individual.meta", control: "key-value" }),
    ]),
  }),
  "pinned-concurrent": Object.freeze({
    version: "1",
    boundaries: true,
    files: Object.freeze([
      Object.freeze({ path: "results/pinned-concurrent.meta", control: "key-value" }),
    ]),
  }),
  gdb: Object.freeze({
    files: Object.freeze([
      Object.freeze({ path: "results/gdb.manifest", control: "gdb-manifest" }),
    ]),
  }),
});

export const TELEMETRY_WORKLOAD_PHASES = Object.freeze(Object.keys(PHASE_SPECS));

export class TelemetryWorkloadBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelemetryWorkloadBindingError";
  }
}

function fail(message) {
  throw new TelemetryWorkloadBindingError(message);
}

function currentUid() {
  const getter = typeof process.geteuid === "function"
    ? process.geteuid
    : typeof process.getuid === "function"
      ? process.getuid
      : null;
  if (getter === null) fail("the current user identity is unavailable");
  return BigInt(getter.call(process));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink;
}

function stableDirectory(left, right) {
  return right.isDirectory() && sameIdentity(left, right) &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function stableFile(left, right) {
  return right.isFile() && sameIdentity(left, right) &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // The binding has already either succeeded or failed closed.
  }
}

function resolveBundlePath(bundle) {
  if (typeof bundle !== "string" || bundle.length === 0 || bundle.includes("\0") ||
      Buffer.byteLength(bundle) > MAX_PATH_BYTES) {
    fail("bundle must be a non-empty path within the path-size limit");
  }
  const resolved = path.resolve(bundle);
  if (Buffer.byteLength(resolved) > MAX_PATH_BYTES) {
    fail("resolved bundle path exceeds the path-size limit");
  }
  return resolved;
}

class StableHierarchy {
  constructor(bundle) {
    this.root = resolveBundlePath(bundle);
    this.uid = currentUid();
    this.directories = new Map();
    this.closed = false;
    this.#openRoot();
  }

  #openRoot() {
    let fd;
    try {
      const before = lstatSync(this.root, { bigint: true });
      if (!before.isDirectory() || before.uid !== this.uid) {
        fail("bundle root must be a real directory owned by the current user");
      }
      fd = openSync(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(fd, { bigint: true });
      const after = lstatSync(this.root, { bigint: true });
      if (!stableDirectory(before, opened) || !stableDirectory(opened, after) ||
          opened.uid !== this.uid) {
        fail("bundle root changed while it was opened");
      }
      this.directories.set(".", {
        fd,
        stat: opened,
        relative: ".",
        absolute: this.root,
        parent: null,
        name: null,
      });
    } catch (error) {
      if (!this.directories.has(".")) closeQuietly(fd);
      if (error instanceof TelemetryWorkloadBindingError) throw error;
      fail("bundle root is missing or could not be opened safely");
    }
  }

  openDirectory(relative) {
    if (relative === "." || relative === "") return this.directories.get(".");
    if (this.directories.has(relative)) return this.directories.get(relative);
    const components = relative.split("/");
    if (components.some((component) => !/^[a-z0-9-]+$/.test(component))) {
      fail("internal workload binding directory is noncanonical");
    }
    const name = components.pop();
    const parentRelative = components.length === 0 ? "." : components.join("/");
    const parent = this.openDirectory(parentRelative);
    const anchored = `/proc/self/fd/${parent.fd}/${name}`;
    let fd;
    try {
      const before = lstatSync(anchored, { bigint: true });
      if (!before.isDirectory() || before.uid !== this.uid) {
        fail(`${relative} must be a real directory owned by the current user`);
      }
      fd = openSync(
        anchored,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(fd, { bigint: true });
      const after = lstatSync(anchored, { bigint: true });
      if (!stableDirectory(before, opened) || !stableDirectory(opened, after) ||
          opened.uid !== this.uid) {
        fail(`${relative} changed while it was opened`);
      }
      const record = {
        fd,
        stat: opened,
        relative,
        absolute: path.join(this.root, ...relative.split("/")),
        parent,
        name,
      };
      this.directories.set(relative, record);
      return record;
    } catch (error) {
      if (!this.directories.has(relative)) closeQuietly(fd);
      if (error instanceof TelemetryWorkloadBindingError) throw error;
      fail(`${relative} is missing or could not be opened safely`);
    }
  }

  readFile(relativePath, maximumBytes, afterFileRead, fileIndex, captureContent) {
    const components = relativePath.split("/");
    const name = components.pop();
    const parent = this.openDirectory(components.join("/"));
    const anchored = `/proc/self/fd/${parent.fd}/${name}`;
    let fd;
    try {
      const before = lstatSync(anchored, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== this.uid ||
          before.size < 1n || before.size > BigInt(maximumBytes)) {
        fail(
          `${relativePath} must be a non-empty, current-owner, single-link regular file ` +
          `no larger than ${maximumBytes} bytes`,
        );
      }
      fd = openSync(
        anchored,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(fd, { bigint: true });
      const afterOpen = lstatSync(anchored, { bigint: true });
      if (!stableFile(before, opened) || !stableFile(opened, afterOpen) ||
          opened.nlink !== 1n || opened.uid !== this.uid) {
        fail(`${relativePath} changed while it was opened`);
      }

      const expectedBytes = Number(opened.size);
      const chunks = [];
      const hash = createHash("sha256");
      let total = 0;
      while (total < expectedBytes) {
        const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, expectedBytes - total));
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        const chunk = count === buffer.length ? buffer : buffer.subarray(0, count);
        if (captureContent) chunks.push(chunk);
        hash.update(chunk);
        total += count;
      }
      if (total !== expectedBytes) fail(`${relativePath} was not read completely`);

      if (afterFileRead !== null) {
        afterFileRead(Object.freeze({ relativePath, fileIndex }));
      }

      const afterFd = fstatSync(fd, { bigint: true });
      const afterPath = lstatSync(anchored, { bigint: true });
      if (!stableFile(opened, afterFd) || !stableFile(afterFd, afterPath) ||
          afterFd.nlink !== 1n || afterFd.uid !== this.uid) {
        fail(`${relativePath} changed while it was read`);
      }
      return {
        path: relativePath,
        bytes: expectedBytes,
        sha256: hash.digest("hex"),
        content: captureContent ? Buffer.concat(chunks, expectedBytes) : null,
      };
    } catch (error) {
      if (error instanceof TelemetryWorkloadBindingError) throw error;
      fail(`${relativePath} is missing or could not be read safely`);
    } finally {
      closeQuietly(fd);
    }
  }

  assertStable() {
    const records = [...this.directories.values()].reverse();
    for (const record of records) {
      try {
        const descriptor = fstatSync(record.fd, { bigint: true });
        const current = record.parent === null
          ? lstatSync(record.absolute, { bigint: true })
          : lstatSync(`/proc/self/fd/${record.parent.fd}/${record.name}`, { bigint: true });
        if (!stableDirectory(record.stat, descriptor) ||
            !stableDirectory(descriptor, current) || descriptor.uid !== this.uid) {
          fail(`${record.relative === "." ? "bundle root" : record.relative} changed while evidence was read`);
        }
      } catch (error) {
        if (error instanceof TelemetryWorkloadBindingError) throw error;
        fail(`${record.relative === "." ? "bundle root" : record.relative} changed while evidence was read`);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.directories.values()].reverse()) closeQuietly(record.fd);
  }
}

function decodeControlFile(bytes, label) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  if (text.includes("\0") || text.includes("\r")) {
    fail(`${label} contains a forbidden control byte`);
  }
  if (!text.endsWith("\n")) fail(`${label} must end with LF`);
  return text.slice(0, -1).split("\n");
}

function parseKeyValueControl(bytes, label) {
  const values = new Map();
  const lines = decodeControlFile(bytes, label);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    fail(`${label} is empty`);
  }
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=([^\n]*)$/);
    if (!match) fail(`${label} contains a malformed record`);
    if (values.has(match[1])) fail(`${label} duplicates field ${match[1]}`);
    values.set(match[1], match[2]);
  }
  return values;
}

function requireValue(values, key, expression, label) {
  if (!values.has(key)) fail(`${label} is missing field ${key}`);
  const value = values.get(key);
  if (!expression.test(value)) fail(`${label} field ${key} is malformed`);
  return value;
}

function canonicalPositiveInteger(value, maximum) {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 16) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function extractGdbGeneration(bytes) {
  const label = "results/gdb.manifest";
  const lines = decodeControlFile(bytes, label);
  const records = lines.filter((line) => line.startsWith("GENERATION"));
  if (records.length !== 1) fail(`${label} must contain exactly one GENERATION record`);
  const match = records[0].match(/^GENERATION\t([a-f0-9]{32})$/);
  if (!match) fail(`${label} GENERATION record is malformed`);
  return match[1];
}

function extractGroupLogPaths(bytes) {
  const label = "results/groups.tsv";
  const lines = decodeControlFile(bytes, label);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    fail(`${label} is empty`);
  }
  if (lines.length > MAX_GROUP_ROWS) {
    fail(`${label} exceeds the supported row-count limit`);
  }
  const names = new Set();
  const paths = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const fields = lines[index].split("\t");
    if (fields.length !== 9) {
      fail(`${label} row ${index + 1} must contain exactly 9 fields`);
    }
    const name = fields[0];
    const logPath = fields[6];
    const match = logPath.match(GROUP_LOG_PATH_RE);
    if (!GROUP_NAME_RE.test(name) || match === null || match[1] !== name) {
      fail(`${label} row ${index + 1} has a noncanonical group log path`);
    }
    if (names.has(name) || paths.has(logPath)) {
      fail(`${label} row ${index + 1} duplicates a group name or log path`);
    }
    names.add(name);
    paths.add(logPath);
  }
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function validatePhase(phase) {
  if (typeof phase !== "string" || !Object.hasOwn(PHASE_SPECS, phase)) {
    fail(`phase must be one of: ${TELEMETRY_WORKLOAD_PHASES.join(", ")}`);
  }
  return PHASE_SPECS[phase];
}

export function serializeTelemetryWorkloadBindingPreimage(phase, fileBindings) {
  const spec = validatePhase(phase);
  const dynamicGroupFiles = phase === "groups";
  if (!Array.isArray(fileBindings) ||
      (!dynamicGroupFiles && fileBindings.length !== spec.files.length) ||
      (dynamicGroupFiles && fileBindings.length <= spec.files.length)) {
    fail("workload file bindings do not match the fixed phase schema");
  }
  const lines = [TELEMETRY_WORKLOAD_BINDING_FORMAT, `PHASE\t${phase}`];
  let groupLogBytes = 0;
  let previousGroupLogPath = null;
  for (let index = 0; index < fileBindings.length; index += 1) {
    const expectedPath = index < spec.files.length ? spec.files[index].path : null;
    const binding = fileBindings[index];
    const bindingPath = binding?.path;
    const maximumBytes = expectedPath === null && dynamicGroupFiles &&
        typeof bindingPath === "string" && GROUP_LOG_PATH_RE.test(bindingPath)
      ? TELEMETRY_GROUP_LOG_MAX_BYTES
      : TELEMETRY_WORKLOAD_FILE_MAX_BYTES[expectedPath];
    if (binding === null || typeof binding !== "object" ||
        (expectedPath !== null ? bindingPath !== expectedPath : maximumBytes === undefined) ||
        !Number.isSafeInteger(binding.bytes) || binding.bytes < 1 ||
        binding.bytes > maximumBytes ||
        typeof binding.sha256 !== "string" || !DIGEST_RE.test(binding.sha256)) {
      fail(`workload file binding for ${expectedPath ?? bindingPath ?? "dynamic group log"} is malformed`);
    }
    if (expectedPath === null) {
      if (previousGroupLogPath !== null && bindingPath <= previousGroupLogPath) {
        fail("group log workload file bindings are not in canonical lexical order");
      }
      previousGroupLogPath = bindingPath;
      groupLogBytes += binding.bytes;
      if (!Number.isSafeInteger(groupLogBytes) ||
          groupLogBytes > TELEMETRY_GROUP_LOG_TOTAL_MAX_BYTES) {
        fail("group log workload file bindings exceed the aggregate size limit");
      }
    }
    lines.push(`FILE\t${bindingPath}\t${binding.bytes}\t${binding.sha256}`);
  }
  return `${lines.join("\n")}\n`;
}

export function computeTelemetryWorkloadBinding(phase, bundle, options = {}) {
  const spec = validatePhase(phase);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("options must be an object");
  }
  const afterFileRead = options.afterFileRead ?? null;
  if (afterFileRead !== null && typeof afterFileRead !== "function") {
    fail("afterFileRead must be a function when supplied");
  }

  let hierarchy;
  try {
    hierarchy = new StableHierarchy(bundle);
    const artifacts = spec.files.map((file, index) => hierarchy.readFile(
      file.path,
      TELEMETRY_WORKLOAD_FILE_MAX_BYTES[file.path],
      afterFileRead,
      index,
      file.control !== null,
    ));

    let workloadGeneration = spec.generation ?? null;
    let workloadBoundariesSha256;
    let workloadBoundaryRowCount;
    const control = artifacts[0];
    if (phase === "gdb") {
      workloadGeneration = extractGdbGeneration(control.content);
    } else if (control.path.endsWith(".meta")) {
      const values = parseKeyValueControl(control.content, control.path);
      if (phase !== "baseline") {
        workloadGeneration = requireValue(values, "GENERATION", GENERATION_RE, control.path);
      }
      if (spec.version !== undefined || spec.versions !== undefined) {
        const version = requireValue(values, "VERSION", /^(?:0|[1-9][0-9]*)$/, control.path);
        if (spec.version !== undefined && version !== spec.version) {
          fail(`${control.path} VERSION must be exactly ${spec.version}`);
        }
        if (spec.versions !== undefined && !spec.versions.includes(version)) {
          fail(`${control.path} VERSION must be one of ${spec.versions.join(", ")}`);
        }
      }
      if (spec.boundaries === true) {
        workloadBoundariesSha256 = requireValue(
          values,
          "BOUNDARIES_SHA256",
          DIGEST_RE,
          control.path,
        );
        const countText = requireValue(
          values,
          "BOUNDARY_ROW_COUNT",
          /^[1-9][0-9]*$/,
          control.path,
        );
        workloadBoundaryRowCount = canonicalPositiveInteger(countText, MAX_BOUNDARY_ROWS);
        if (workloadBoundaryRowCount === null) {
          fail(`${control.path} field BOUNDARY_ROW_COUNT is outside the supported range`);
        }
      }
    }
    if (workloadGeneration === null) fail(`${phase} workload generation is unavailable`);

    if (phase === "groups") {
      const groupsTsv = artifacts.find(({ path: artifactPath }) =>
        artifactPath === spec.outcomeLogsFrom);
      const groupLogPaths = extractGroupLogPaths(groupsTsv?.content);
      let remainingLogBytes = TELEMETRY_GROUP_LOG_TOTAL_MAX_BYTES;
      for (const groupLogPath of groupLogPaths) {
        const artifact = hierarchy.readFile(
          groupLogPath,
          Math.min(TELEMETRY_GROUP_LOG_MAX_BYTES, remainingLogBytes),
          afterFileRead,
          artifacts.length,
          false,
        );
        artifacts.push(artifact);
        remainingLogBytes -= artifact.bytes;
      }
    }

    hierarchy.assertStable();
    const files = artifacts.map(({ path: filePath, bytes, sha256 }) =>
      Object.freeze({ path: filePath, bytes, sha256 }));
    const preimage = serializeTelemetryWorkloadBindingPreimage(phase, files);
    const result = {
      version: TELEMETRY_WORKLOAD_BINDING_VERSION,
      format: TELEMETRY_WORKLOAD_BINDING_FORMAT,
      phase,
      workloadGeneration,
      workloadBindingSha256: createHash("sha256").update(preimage, "utf8").digest("hex"),
      files: Object.freeze(files),
    };
    if (spec.boundaries === true) {
      result.workloadBoundariesSha256 = workloadBoundariesSha256;
      result.workloadBoundaryRowCount = workloadBoundaryRowCount;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof TelemetryWorkloadBindingError) throw error;
    throw new TelemetryWorkloadBindingError(
      `telemetry workload binding could not be computed: ${error?.message ?? String(error)}`,
    );
  } finally {
    hierarchy?.close();
  }
}

export function runTelemetryWorkloadBindingCli(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    if (!Array.isArray(argv) || argv.length !== 2) {
      fail("usage: telemetry-workload-binding.mjs PHASE BUNDLE");
    }
    const binding = computeTelemetryWorkloadBinding(argv[0], argv[1]);
    const lines = [
      `VERSION=${binding.version}`,
      `FORMAT=${binding.format}`,
      `PHASE=${binding.phase}`,
      `WORKLOAD_GENERATION=${binding.workloadGeneration}`,
      `WORKLOAD_BINDING_SHA256=${binding.workloadBindingSha256}`,
      `WORKLOAD_BOUNDARIES_SHA256=${binding.workloadBoundariesSha256 ?? "-"}`,
      `WORKLOAD_BOUNDARY_ROW_COUNT=${binding.workloadBoundaryRowCount ?? "-"}`,
    ];
    stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    stderr.write(`error: ${error?.message ?? String(error)}\n`);
    return error instanceof TelemetryWorkloadBindingError ? 2 : 1;
  }
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.exitCode = runTelemetryWorkloadBindingCli(process.argv.slice(2));
}
