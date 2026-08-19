import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  assertBundleExecutionLeaseHeld,
  bundleExecutionLeaseAttemptRetention,
  bundleExecutionLeaseEvidence,
  withBundleExecutionLease,
} from "./bundle-execution-lease.mjs";
import {
  exactCpuPhaseManifestBinding,
  parseExactCpuPhaseManifest,
  runNextExactCpuPhaseAttempt,
} from "./exact-cpu-phase.mjs";
import {
  commitExactCpuPhaseAttempt,
  initializeExactCpuPhaseStore,
  readExactCpuPhaseStore,
} from "./exact-cpu-phase-store.mjs";
import {
  PinnedProtocolStateError,
  canonicalProtocolJson,
  createFileStateAdapter,
} from "./pinned-protocol.mjs";
import {
  WORKLOAD_CAPABILITIES,
  canonicalWorkloadJson,
  workloadLaunchProvenance,
} from "./workload-spec.mjs";

export const SCHEMA3_BUNDLE_FORMAT_VERSION = 3;
export const SCHEMA3_BUNDLE_MANIFEST_VERSION = 1;
export const SCHEMA3_RUN_SCHEMA_VERSION = 3;
export const SCHEMA3_BUNDLE_FILE = "fault-affinity-bundle.json";
export const SCHEMA3_BUNDLE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const SCHEMA3_EXACT_CPU_STATE_DIRECTORY = "state/exact-cpu";

const GENERATION_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PHASE_CONTROLS = new Set([
  "supported",
  "unsupported",
  "explicitly-skipped",
  "unavailable",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class Schema3BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "Schema3BundleError";
    this.code = "INVALID_SCHEMA3_BUNDLE";
  }
}

function fail(message) {
  throw new Schema3BundleError(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function plainObject(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]),
  `${label} must contain exactly: ${wanted.join(", ")}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  return deepFreeze(JSON.parse(canonicalProtocolJson(value)));
}

function canonicalLine(value) {
  return Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
}

function bindingForBytes(bytes) {
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

function resolvedWorkloadJson(resolved) {
  workloadLaunchProvenance(resolved);
  return JSON.parse(canonicalWorkloadJson(resolved));
}

function workloadBinding(resolved) {
  workloadLaunchProvenance(resolved);
  return {
    contractVersion: resolved.version,
    id: resolved.id,
    digest: resolved.digest,
  };
}

function expectedPhaseControls(resolved) {
  requireCondition(resolved.capabilities.isolated === true,
    "schema-3 exact-CPU bundles require isolated workload capability");
  return Object.fromEntries(WORKLOAD_CAPABILITIES.map((capability) => [
    capability,
    capability === "isolated"
      ? "supported"
      : resolved.capabilities[capability] === true ? "unavailable" : "unsupported",
  ]));
}

function validateBinding(value, expected, label) {
  exactKeys(value, ["sha256", "bytes"], label);
  requireCondition(typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.sha256 === expected.sha256 && value.bytes === expected.bytes,
  `${label} does not match its canonical content`);
}

function validateWorkloadBinding(value, expected) {
  exactKeys(value, ["contractVersion", "id", "digest"], "bundle workload binding");
  requireCondition(value.contractVersion === expected.contractVersion &&
    value.id === expected.id && value.digest === expected.digest,
  "bundle workload binding does not match the resolved workload");
}

function validatePhaseControls(value, expected) {
  exactKeys(value, WORKLOAD_CAPABILITIES, "bundle phase controls");
  for (const capability of WORKLOAD_CAPABILITIES) {
    requireCondition(PHASE_CONTROLS.has(value[capability]) &&
      value[capability] === expected[capability],
    `bundle phase control '${capability}' does not match this internal implementation`);
  }
}

function parseManifestContext(resolved, value) {
  exactKeys(value, [
    "version",
    "bundleFormatVersion",
    "runSchemaVersion",
    "bundleGeneration",
    "workload",
    "workloadBinding",
    "phaseControls",
    "exactCpu",
  ], "schema-3 bundle manifest");
  requireCondition(value.version === SCHEMA3_BUNDLE_MANIFEST_VERSION,
    `schema-3 bundle manifest version must be ${SCHEMA3_BUNDLE_MANIFEST_VERSION}`);
  requireCondition(value.bundleFormatVersion === SCHEMA3_BUNDLE_FORMAT_VERSION,
    `bundle format version must be ${SCHEMA3_BUNDLE_FORMAT_VERSION}`);
  requireCondition(value.runSchemaVersion === SCHEMA3_RUN_SCHEMA_VERSION,
    `run schema version must be ${SCHEMA3_RUN_SCHEMA_VERSION}`);
  requireCondition(typeof value.bundleGeneration === "string" &&
    GENERATION_RE.test(value.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");

  const expectedWorkload = resolvedWorkloadJson(resolved);
  requireCondition(canonicalWorkloadJson(value.workload) ===
    canonicalWorkloadJson(expectedWorkload),
  "bundle workload does not match the resolved workload identity");
  validateWorkloadBinding(value.workloadBinding, workloadBinding(resolved));
  validatePhaseControls(value.phaseControls, expectedPhaseControls(resolved));

  exactKeys(value.exactCpu, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle exact-CPU phase");
  requireCondition(value.exactCpu.protocol === "isolated-exact-cpu-v1",
    "bundle exact-CPU protocol is unsupported");
  requireCondition(value.exactCpu.stateDirectory === SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
    "bundle exact-CPU state directory is invalid");
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, value.exactCpu.manifest);
  const expectedExactCpuBinding = exactCpuPhaseManifestBinding(resolved, exactCpuManifest);
  validateBinding(value.exactCpu.manifestBinding, expectedExactCpuBinding,
    "bundle exact-CPU manifest binding");
  return { exactCpuManifest };
}

export function newSchema3BundleGeneration() {
  return randomBytes(16).toString("hex");
}

export function buildSchema3BundleManifest(resolved, options) {
  exactKeys(options, ["bundleGeneration", "exactCpuManifest"],
    "schema-3 bundle options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, options.exactCpuManifest);
  return parseSchema3BundleManifest(resolved, {
    version: SCHEMA3_BUNDLE_MANIFEST_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(resolved),
    workloadBinding: workloadBinding(resolved),
    phaseControls: expectedPhaseControls(resolved),
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function parseSchema3BundleManifest(resolved, value) {
  parseManifestContext(resolved, value);
  return canonicalClone(value);
}

export function canonicalSchema3BundleManifestLine(resolved, value) {
  return canonicalLine(parseSchema3BundleManifest(resolved, value));
}

export function schema3BundleManifestBinding(resolved, value) {
  return bindingForBytes(canonicalSchema3BundleManifestLine(resolved, value));
}

function validatePrivateDirectory(directory, label) {
  requireCondition(typeof directory === "string" && path.isAbsolute(directory) &&
    !directory.includes("\0") && Buffer.byteLength(directory) <= 16 * 1024,
  `${label} must be a bounded absolute NUL-free path`);
  const normalized = path.normalize(directory);
  let canonical;
  let stat;
  try {
    canonical = realpathSync(normalized);
    stat = lstatSync(normalized, { bigint: true });
  } catch {
    fail(`${label} is missing or could not be inspected`);
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  requireCondition(canonical === normalized && stat.isDirectory() &&
    (uid === null || stat.uid === uid) && (stat.mode & 0o077n) === 0n,
  `${label} must be a canonical real private directory owned by the current user`);
  return normalized;
}

function fsyncDirectory(directory) {
  const fd = openSync(directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateSubdirectory(parent, name, label) {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== "EEXIST") fail(`${label} could not be created durably`);
  }
  return validatePrivateDirectory(directory, label);
}

async function listRoot(adapter) {
  let names;
  try {
    names = await adapter.list();
  } catch (error) {
    if (error instanceof PinnedProtocolStateError) {
      fail(`schema-3 bundle inventory is invalid: ${error.message}`);
    }
    throw error;
  }
  requireCondition(Array.isArray(names) && names.length <= 2 &&
    names.every((name) => typeof name === "string"),
  "schema-3 bundle root inventory is invalid or oversized");
  const seen = new Set(names);
  requireCondition(seen.size === names.length &&
    names.every((name) => name === SCHEMA3_BUNDLE_FILE || name === "state"),
  "schema-3 bundle root contains an unknown entry");
  return seen;
}

async function validateStateRootInventory(stateRoot, { allowEmpty = false } = {}) {
  const names = await createFileStateAdapter(stateRoot).list();
  requireCondition(Array.isArray(names) && names.length <= 1 &&
    names.every((name) => name === "exact-cpu"),
  "schema-3 bundle state directory contains an unknown entry");
  requireCondition(allowEmpty || names.length === 1,
    "schema-3 exact-CPU state directory is missing");
  return names.length === 1;
}

function decodeJsonLine(bytes, label) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  requireCondition(text.endsWith("\n") && !text.slice(0, -1).includes("\n") &&
    !text.includes("\r") && !text.includes("\0"),
  `${label} is not one canonical JSON line`);
  try {
    return JSON.parse(text.slice(0, -1));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

async function readManifest(resolved, adapter) {
  let bytes;
  try {
    bytes = await adapter.read(SCHEMA3_BUNDLE_FILE, SCHEMA3_BUNDLE_FILE_MAX_BYTES);
  } catch (error) {
    if (error instanceof PinnedProtocolStateError) {
      fail(`schema-3 bundle manifest could not be read safely: ${error.message}`);
    }
    throw error;
  }
  requireCondition(Buffer.isBuffer(bytes) && bytes.length > 0 &&
    bytes.length <= SCHEMA3_BUNDLE_FILE_MAX_BYTES,
  "schema-3 bundle manifest is empty or oversized");
  const manifest = parseSchema3BundleManifest(
    resolved,
    decodeJsonLine(bytes, "schema-3 bundle manifest"),
  );
  requireCondition(bytes.equals(canonicalSchema3BundleManifestLine(resolved, manifest)),
    "schema-3 bundle manifest is not canonical");
  return manifest;
}

async function readBundleState(resolved, bundleDir) {
  const root = validatePrivateDirectory(bundleDir, "schema-3 bundle directory");
  const adapter = createFileStateAdapter(root);
  const names = await listRoot(adapter);
  requireCondition(names.has(SCHEMA3_BUNDLE_FILE), "schema-3 bundle manifest is missing");
  requireCondition(names.has("state"), "schema-3 bundle state directory is missing");
  const manifest = await readManifest(resolved, adapter);
  const stateRoot = validatePrivateDirectory(path.join(root, "state"),
    "schema-3 bundle state directory");
  await validateStateRootInventory(stateRoot);
  const exactCpuStateDir = validatePrivateDirectory(path.join(stateRoot, "exact-cpu"),
    "schema-3 exact-CPU state directory");
  const exactCpu = await readExactCpuPhaseStore({ resolved, stateDir: exactCpuStateDir });
  requireCondition(canonicalProtocolJson(exactCpu.manifest) ===
    canonicalProtocolJson(manifest.exactCpu.manifest),
  "schema-3 exact-CPU state belongs to a different phase manifest");
  return deepFreeze({
    manifest,
    manifestBinding: schema3BundleManifestBinding(resolved, manifest),
    exactCpu,
  });
}

function validateAttemptOptions(value) {
  const options = value ?? {};
  plainObject(options, "schema-3 exact-CPU attempt options");
  const allowed = new Set(["signal", "stdoutExcerptBytes", "stderrExcerptBytes"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `schema-3 exact-CPU attempt options contain unknown field '${unknown.sort()[0]}'`);
  return options;
}

export async function initializeSchema3Bundle({
  resolved,
  manifest: manifestValue,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
}) {
  const manifest = parseSchema3BundleManifest(resolved, manifestValue);
  const expectedBytes = canonicalSchema3BundleManifestLine(resolved, manifest);
  requireCondition(expectedBytes.length <= SCHEMA3_BUNDLE_FILE_MAX_BYTES,
    "schema-3 bundle manifest exceeds its byte limit");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    const root = validatePrivateDirectory(bundleDir, "schema-3 bundle directory");
    const adapter = createFileStateAdapter(root);
    let names = await listRoot(adapter);
    if (!names.has(SCHEMA3_BUNDLE_FILE)) {
      requireCondition(names.size === 0,
        "an uninitialized schema-3 bundle directory must be empty");
      try {
        await adapter.commit(SCHEMA3_BUNDLE_FILE, expectedBytes);
      } catch (error) {
        if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
      }
      names = await listRoot(adapter);
    }
    const storedManifest = await readManifest(resolved, adapter);
    requireCondition(expectedBytes.equals(canonicalSchema3BundleManifestLine(
      resolved,
      storedManifest,
    )), "existing schema-3 bundle belongs to a different manifest");

    if (!names.has("state")) ensurePrivateSubdirectory(root, "state",
      "schema-3 bundle state directory");
    const stateRoot = validatePrivateDirectory(path.join(root, "state"),
      "schema-3 bundle state directory");
    const exactCpuPresent = await validateStateRootInventory(stateRoot, { allowEmpty: true });
    if (!exactCpuPresent) ensurePrivateSubdirectory(stateRoot, "exact-cpu",
      "schema-3 exact-CPU state directory");
    const exactCpuStateDir = path.join(stateRoot, "exact-cpu");
    await initializeExactCpuPhaseStore({
      resolved,
      manifest: storedManifest.exactCpu.manifest,
      stateDir: exactCpuStateDir,
    });
    assertBundleExecutionLeaseHeld(lease);
    const bundle = await readBundleState(resolved, root);
    return deepFreeze({ ...bundle, lease: bundleExecutionLeaseEvidence(lease) });
  });
}

export async function readSchema3Bundle({
  resolved,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
}) {
  return withBundleExecutionLease(
    { bundleDir, flockPath, waitMs: leaseWaitMs },
    async (lease) => {
      const bundle = await readBundleState(resolved, bundleDir);
      assertBundleExecutionLeaseHeld(lease);
      return bundle;
    },
  );
}

export async function runOneSchema3ExactCpuAttempt({
  resolved,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions);
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, bundleDir);
    assertBundleExecutionLeaseHeld(lease);
    const result = await runNextExactCpuPhaseAttempt({
      resolved,
      manifest: bundle.manifest.exactCpu.manifest,
      envelopes: bundle.exactCpu.envelopes,
      ...(runAttempt === undefined ? {} : { runAttempt }),
      attemptOptions: {
        ...options,
        retainedDirectory: bundleExecutionLeaseAttemptRetention(lease),
      },
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      await commitExactCpuPhaseAttempt({
        resolved,
        envelope: result.envelope,
        stateDir: path.join(bundleDir, SCHEMA3_EXACT_CPU_STATE_DIRECTORY),
      });
      bundle = await readBundleState(resolved, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}
