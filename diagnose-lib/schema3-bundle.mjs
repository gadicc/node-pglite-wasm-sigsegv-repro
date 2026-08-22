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
  baselinePhaseManifestBinding,
  parseBaselinePhaseManifest,
  runNextBaselinePhaseWave,
} from "./baseline-phase.mjs";
import {
  commitBaselinePhaseWave,
  initializeBaselinePhaseStore,
  readBaselinePhaseStore,
} from "./baseline-phase-store.mjs";
import {
  groupPhaseManifestBinding,
  parseGroupPhaseManifest,
  runNextGroupPhaseWave,
} from "./group-phase.mjs";
import {
  commitGroupPhaseWave,
  initializeGroupPhaseStore,
  readGroupPhaseStore,
} from "./group-phase-store.mjs";
import {
  parsePinnedConcurrentPhaseManifest,
  pinnedConcurrentPhaseManifestBinding,
  runNextPinnedConcurrentPhaseWave,
} from "./pinned-concurrent-phase.mjs";
import {
  commitPinnedConcurrentPhaseWave,
  initializePinnedConcurrentPhaseStore,
  readPinnedConcurrentPhaseStore,
} from "./pinned-concurrent-phase-store.mjs";
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
  controlledLoadSessionManifestBinding,
  parseControlledLoadSessionManifest,
  runControlledLoadSession,
} from "./controlled-load-session.mjs";
import {
  commitControlledLoadSession,
  initializeControlledLoadPhaseStore,
  readControlledLoadPhaseStore,
} from "./controlled-load-phase-store.mjs";
import {
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";
import {
  commitDebuggerPhaseAttempt,
  initializeDebuggerPhaseStore,
  readDebuggerPhaseStore,
  runNextDebuggerPhaseAttempt,
} from "./debugger-attempt-store.mjs";
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
export const SCHEMA3_BUNDLE_MANIFEST_V2_VERSION = 2;
export const SCHEMA3_BUNDLE_MANIFEST_V3_VERSION = 3;
export const SCHEMA3_BUNDLE_MANIFEST_V4_VERSION = 4;
export const SCHEMA3_BUNDLE_MANIFEST_V5_VERSION = 5;
export const SCHEMA3_BUNDLE_MANIFEST_V6_VERSION = 6;
export const SCHEMA3_RUN_SCHEMA_VERSION = 3;
export const SCHEMA3_BUNDLE_FILE = "fault-affinity-bundle.json";
export const SCHEMA3_BUNDLE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const SCHEMA3_BASELINE_STATE_DIRECTORY = "state/baseline";
export const SCHEMA3_GROUP_STATE_DIRECTORY = "state/groups";
export const SCHEMA3_PINNED_CONCURRENT_STATE_DIRECTORY = "state/pinned-concurrent";
export const SCHEMA3_CONTROLLED_LOAD_STATE_DIRECTORY = "state/controlled-load";
export const SCHEMA3_DEBUGGER_STATE_DIRECTORY = "state/debugger";
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

function expectedPhaseControls(resolved, supportedCapabilities, { controlledLoad = false } = {}) {
  requireCondition(resolved.capabilities.isolated === true,
    "schema-3 exact-CPU bundles require isolated workload capability");
  for (const capability of supportedCapabilities) {
    requireCondition(resolved.capabilities[capability] === true,
      `schema-3 bundle implementation requires '${capability}' workload capability`);
  }
  const controls = Object.fromEntries(WORKLOAD_CAPABILITIES.map((capability) => [
    capability,
    supportedCapabilities.has(capability)
      ? "supported"
      : resolved.capabilities[capability] === true ? "unavailable" : "unsupported",
  ]));
  return controlledLoad ? { ...controls, controlledLoad: "supported" } : controls;
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
  const capabilities = Object.keys(expected);
  exactKeys(value, capabilities, "bundle phase controls");
  for (const capability of capabilities) {
    requireCondition(PHASE_CONTROLS.has(value[capability]) &&
      value[capability] === expected[capability],
    `bundle phase control '${capability}' does not match this internal implementation`);
  }
}

function parseControlledLoadPhaseContext(measured, auxiliary, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle controlled-load phase");
  requireCondition(value.protocol === "controlled-load-aba-v1",
    "bundle controlled-load protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_CONTROLLED_LOAD_STATE_DIRECTORY,
    "bundle controlled-load state directory is invalid");
  const manifest = parseControlledLoadSessionManifest(measured, auxiliary, value.manifest);
  validateBinding(value.manifestBinding,
    controlledLoadSessionManifestBinding(measured, auxiliary, manifest),
    "bundle controlled-load manifest binding");
  return manifest;
}

function parseBaselinePhaseContext(resolved, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle baseline phase");
  requireCondition(value.protocol === "baseline-concurrent-v1",
    "bundle baseline protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_BASELINE_STATE_DIRECTORY,
    "bundle baseline state directory is invalid");
  const manifest = parseBaselinePhaseManifest(resolved, value.manifest);
  validateBinding(value.manifestBinding, baselinePhaseManifestBinding(resolved, manifest),
    "bundle baseline manifest binding");
  return manifest;
}

function parseExactCpuPhaseContext(resolved, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle exact-CPU phase");
  requireCondition(value.protocol === "isolated-exact-cpu-v1",
    "bundle exact-CPU protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
    "bundle exact-CPU state directory is invalid");
  const manifest = parseExactCpuPhaseManifest(resolved, value.manifest);
  validateBinding(value.manifestBinding, exactCpuPhaseManifestBinding(resolved, manifest),
    "bundle exact-CPU manifest binding");
  return manifest;
}

function parseGroupPhaseContext(resolved, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle group phase");
  requireCondition(value.protocol === "cpu-groups-v1",
    "bundle group protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_GROUP_STATE_DIRECTORY,
    "bundle group state directory is invalid");
  const manifest = parseGroupPhaseManifest(resolved, value.manifest);
  validateBinding(value.manifestBinding, groupPhaseManifestBinding(resolved, manifest),
    "bundle group manifest binding");
  return manifest;
}

function parsePinnedConcurrentPhaseContext(resolved, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle pinned-concurrent phase");
  requireCondition(value.protocol === "pinned-concurrent-v1",
    "bundle pinned-concurrent protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_PINNED_CONCURRENT_STATE_DIRECTORY,
    "bundle pinned-concurrent state directory is invalid");
  const manifest = parsePinnedConcurrentPhaseManifest(resolved, value.manifest);
  validateBinding(value.manifestBinding,
    pinnedConcurrentPhaseManifestBinding(resolved, manifest),
    "bundle pinned-concurrent manifest binding");
  return manifest;
}

function parseDebuggerPhaseContext(resolved, value) {
  exactKeys(value, [
    "protocol",
    "stateDirectory",
    "manifestBinding",
    "manifest",
  ], "bundle debugger phase");
  requireCondition(value.protocol === "gdb-capture-v1",
    "bundle debugger protocol is unsupported");
  requireCondition(value.stateDirectory === SCHEMA3_DEBUGGER_STATE_DIRECTORY,
    "bundle debugger state directory is invalid");
  const manifest = parseDebuggerPhaseManifest(resolved, value.manifest);
  validateBinding(value.manifestBinding, debuggerPhaseManifestBinding(resolved, manifest),
    "bundle debugger manifest binding");
  return manifest;
}

function parseManifestContext(resolved, value, auxiliary) {
  plainObject(value, "schema-3 bundle manifest");
  requireCondition(value.version === SCHEMA3_BUNDLE_MANIFEST_VERSION ||
    value.version === SCHEMA3_BUNDLE_MANIFEST_V2_VERSION ||
    value.version === SCHEMA3_BUNDLE_MANIFEST_V3_VERSION ||
    value.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION ||
    value.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION ||
    value.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION,
  `schema-3 bundle manifest version must be ${SCHEMA3_BUNDLE_MANIFEST_VERSION}, ` +
    `${SCHEMA3_BUNDLE_MANIFEST_V2_VERSION}, ${SCHEMA3_BUNDLE_MANIFEST_V3_VERSION}, ` +
    `${SCHEMA3_BUNDLE_MANIFEST_V4_VERSION}, ${SCHEMA3_BUNDLE_MANIFEST_V5_VERSION}, or ` +
    `${SCHEMA3_BUNDLE_MANIFEST_V6_VERSION}`);
  const hasBaseline = [
    SCHEMA3_BUNDLE_MANIFEST_V2_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
  ].includes(value.version);
  const hasGroups = [
    SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
  ].includes(value.version);
  const hasPinnedConcurrent = value.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION;
  const hasControlledLoad = value.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION;
  const hasDebugger = value.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION;
  exactKeys(value, [
    "version",
    "bundleFormatVersion",
    "runSchemaVersion",
    "bundleGeneration",
    "workload",
    "workloadBinding",
    ...(hasControlledLoad ? ["auxiliaryWorkload", "auxiliaryWorkloadBinding"] : []),
    "phaseControls",
    ...(hasBaseline ? ["baseline"] : []),
    ...(hasGroups ? ["groups"] : []),
    ...(hasPinnedConcurrent ? ["pinnedConcurrent"] : []),
    ...(hasControlledLoad ? ["controlledLoad"] : []),
    ...(hasDebugger ? ["debugger"] : []),
    "exactCpu",
  ], "schema-3 bundle manifest");
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
  if (hasControlledLoad) {
    requireCondition(auxiliary !== undefined,
      "schema-3 controlled-load manifests require the resolved auxiliary workload");
    const expectedAuxiliary = resolvedWorkloadJson(auxiliary);
    requireCondition(canonicalWorkloadJson(value.auxiliaryWorkload) ===
      canonicalWorkloadJson(expectedAuxiliary),
    "bundle auxiliary workload does not match the resolved auxiliary identity");
    validateWorkloadBinding(value.auxiliaryWorkloadBinding, workloadBinding(auxiliary));
  }
  const supported = new Set(hasPinnedConcurrent
    ? ["baseline", "groups", "isolated", "pinnedConcurrent"]
    : hasGroups ? ["baseline", "groups", "isolated"]
    : hasDebugger ? ["isolated", "gdb"]
    : hasBaseline ? ["baseline", "isolated"] : ["isolated"]);
  validatePhaseControls(value.phaseControls, expectedPhaseControls(resolved, supported, {
    controlledLoad: hasControlledLoad,
  }));

  const baselineManifest = hasBaseline ? parseBaselinePhaseContext(resolved, value.baseline) : null;
  const groupManifest = hasGroups ? parseGroupPhaseContext(resolved, value.groups) : null;
  const pinnedConcurrentManifest = hasPinnedConcurrent
    ? parsePinnedConcurrentPhaseContext(resolved, value.pinnedConcurrent)
    : null;
  const controlledLoadManifest = hasControlledLoad
    ? parseControlledLoadPhaseContext(resolved, auxiliary, value.controlledLoad)
    : null;
  const debuggerManifest = hasDebugger
    ? parseDebuggerPhaseContext(resolved, value.debugger)
    : null;
  const exactCpuManifest = parseExactCpuPhaseContext(resolved, value.exactCpu);
  return {
    version: value.version,
    baselineManifest,
    groupManifest,
    pinnedConcurrentManifest,
    controlledLoadManifest,
    debuggerManifest,
    exactCpuManifest,
  };
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
    phaseControls: expectedPhaseControls(resolved, new Set(["isolated"])),
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function buildSchema3BundleManifestV2(resolved, options) {
  exactKeys(options, ["bundleGeneration", "baselineManifest", "exactCpuManifest"],
    "schema-3 bundle v2 options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const baselineManifest = parseBaselinePhaseManifest(resolved, options.baselineManifest);
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, options.exactCpuManifest);
  return parseSchema3BundleManifest(resolved, {
    version: SCHEMA3_BUNDLE_MANIFEST_V2_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(resolved),
    workloadBinding: workloadBinding(resolved),
    phaseControls: expectedPhaseControls(resolved, new Set(["baseline", "isolated"])),
    baseline: {
      protocol: "baseline-concurrent-v1",
      stateDirectory: SCHEMA3_BASELINE_STATE_DIRECTORY,
      manifestBinding: baselinePhaseManifestBinding(resolved, baselineManifest),
      manifest: baselineManifest,
    },
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function buildSchema3BundleManifestV3(resolved, options) {
  exactKeys(options, [
    "bundleGeneration", "baselineManifest", "groupManifest", "exactCpuManifest",
  ], "schema-3 bundle v3 options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const baselineManifest = parseBaselinePhaseManifest(resolved, options.baselineManifest);
  const groupManifest = parseGroupPhaseManifest(resolved, options.groupManifest);
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, options.exactCpuManifest);
  return parseSchema3BundleManifest(resolved, {
    version: SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(resolved),
    workloadBinding: workloadBinding(resolved),
    phaseControls: expectedPhaseControls(resolved, new Set(["baseline", "groups", "isolated"])),
    baseline: {
      protocol: "baseline-concurrent-v1",
      stateDirectory: SCHEMA3_BASELINE_STATE_DIRECTORY,
      manifestBinding: baselinePhaseManifestBinding(resolved, baselineManifest),
      manifest: baselineManifest,
    },
    groups: {
      protocol: "cpu-groups-v1",
      stateDirectory: SCHEMA3_GROUP_STATE_DIRECTORY,
      manifestBinding: groupPhaseManifestBinding(resolved, groupManifest),
      manifest: groupManifest,
    },
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function buildSchema3BundleManifestV4(resolved, options) {
  exactKeys(options, [
    "bundleGeneration", "baselineManifest", "groupManifest",
    "pinnedConcurrentManifest", "exactCpuManifest",
  ], "schema-3 bundle v4 options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const baselineManifest = parseBaselinePhaseManifest(resolved, options.baselineManifest);
  const groupManifest = parseGroupPhaseManifest(resolved, options.groupManifest);
  const pinnedConcurrentManifest = parsePinnedConcurrentPhaseManifest(
    resolved,
    options.pinnedConcurrentManifest,
  );
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, options.exactCpuManifest);
  return parseSchema3BundleManifest(resolved, {
    version: SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(resolved),
    workloadBinding: workloadBinding(resolved),
    phaseControls: expectedPhaseControls(resolved,
      new Set(["baseline", "groups", "isolated", "pinnedConcurrent"])),
    baseline: {
      protocol: "baseline-concurrent-v1",
      stateDirectory: SCHEMA3_BASELINE_STATE_DIRECTORY,
      manifestBinding: baselinePhaseManifestBinding(resolved, baselineManifest),
      manifest: baselineManifest,
    },
    groups: {
      protocol: "cpu-groups-v1",
      stateDirectory: SCHEMA3_GROUP_STATE_DIRECTORY,
      manifestBinding: groupPhaseManifestBinding(resolved, groupManifest),
      manifest: groupManifest,
    },
    pinnedConcurrent: {
      protocol: "pinned-concurrent-v1",
      stateDirectory: SCHEMA3_PINNED_CONCURRENT_STATE_DIRECTORY,
      manifestBinding: pinnedConcurrentPhaseManifestBinding(resolved,
        pinnedConcurrentManifest),
      manifest: pinnedConcurrentManifest,
    },
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function buildSchema3BundleManifestV5(measured, auxiliary, options) {
  exactKeys(options, [
    "bundleGeneration", "controlledLoadManifest", "exactCpuManifest",
  ], "schema-3 bundle v5 options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const controlledLoadManifest = parseControlledLoadSessionManifest(
    measured,
    auxiliary,
    options.controlledLoadManifest,
  );
  const exactCpuManifest = parseExactCpuPhaseManifest(measured, options.exactCpuManifest);
  return parseSchema3BundleManifest(measured, {
    version: SCHEMA3_BUNDLE_MANIFEST_V5_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(measured),
    workloadBinding: workloadBinding(measured),
    auxiliaryWorkload: resolvedWorkloadJson(auxiliary),
    auxiliaryWorkloadBinding: workloadBinding(auxiliary),
    phaseControls: expectedPhaseControls(measured, new Set(["isolated"]), {
      controlledLoad: true,
    }),
    controlledLoad: {
      protocol: "controlled-load-aba-v1",
      stateDirectory: SCHEMA3_CONTROLLED_LOAD_STATE_DIRECTORY,
      manifestBinding: controlledLoadSessionManifestBinding(
        measured,
        auxiliary,
        controlledLoadManifest,
      ),
      manifest: controlledLoadManifest,
    },
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(measured, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  }, auxiliary);
}

export function buildSchema3BundleManifestV6(resolved, options) {
  exactKeys(options, [
    "bundleGeneration", "debuggerManifest", "exactCpuManifest",
  ], "schema-3 bundle v6 options");
  requireCondition(typeof options.bundleGeneration === "string" &&
    GENERATION_RE.test(options.bundleGeneration),
  "bundle generation must be exactly 32 lowercase hexadecimal characters");
  const debuggerManifest = parseDebuggerPhaseManifest(resolved, options.debuggerManifest);
  const exactCpuManifest = parseExactCpuPhaseManifest(resolved, options.exactCpuManifest);
  return parseSchema3BundleManifest(resolved, {
    version: SCHEMA3_BUNDLE_MANIFEST_V6_VERSION,
    bundleFormatVersion: SCHEMA3_BUNDLE_FORMAT_VERSION,
    runSchemaVersion: SCHEMA3_RUN_SCHEMA_VERSION,
    bundleGeneration: options.bundleGeneration,
    workload: resolvedWorkloadJson(resolved),
    workloadBinding: workloadBinding(resolved),
    phaseControls: expectedPhaseControls(resolved, new Set(["isolated", "gdb"])),
    debugger: {
      protocol: "gdb-capture-v1",
      stateDirectory: SCHEMA3_DEBUGGER_STATE_DIRECTORY,
      manifestBinding: debuggerPhaseManifestBinding(resolved, debuggerManifest),
      manifest: debuggerManifest,
    },
    exactCpu: {
      protocol: "isolated-exact-cpu-v1",
      stateDirectory: SCHEMA3_EXACT_CPU_STATE_DIRECTORY,
      manifestBinding: exactCpuPhaseManifestBinding(resolved, exactCpuManifest),
      manifest: exactCpuManifest,
    },
  });
}

export function parseSchema3BundleManifest(resolved, value, auxiliary) {
  parseManifestContext(resolved, value, auxiliary);
  return canonicalClone(value);
}

export function canonicalSchema3BundleManifestLine(resolved, value, auxiliary) {
  return canonicalLine(parseSchema3BundleManifest(resolved, value, auxiliary));
}

export function schema3BundleManifestBinding(resolved, value, auxiliary) {
  return bindingForBytes(canonicalSchema3BundleManifestLine(resolved, value, auxiliary));
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

function expectedStateDirectories(manifest) {
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION) {
    return ["debugger", "exact-cpu"];
  }
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION) {
    return ["controlled-load", "exact-cpu"];
  }
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION) {
    return ["baseline", "exact-cpu", "groups", "pinned-concurrent"];
  }
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V3_VERSION) {
    return ["baseline", "exact-cpu", "groups"];
  }
  return manifest.version === SCHEMA3_BUNDLE_MANIFEST_V2_VERSION
    ? ["baseline", "exact-cpu"] : ["exact-cpu"];
}

async function validateStateRootInventory(
  stateRoot,
  manifest,
  { allowMissing = false } = {},
) {
  const names = await createFileStateAdapter(stateRoot).list();
  const expected = expectedStateDirectories(manifest);
  requireCondition(Array.isArray(names) && names.length <= expected.length &&
    names.every((name) => expected.includes(name)),
  "schema-3 bundle state directory contains an unknown entry");
  const seen = new Set(names);
  requireCondition(allowMissing || expected.every((name) => seen.has(name)),
    "schema-3 bundle phase state directory is missing");
  return seen;
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

async function readManifest(resolved, auxiliary, adapter) {
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
    auxiliary,
  );
  requireCondition(bytes.equals(canonicalSchema3BundleManifestLine(
    resolved,
    manifest,
    auxiliary,
  )),
    "schema-3 bundle manifest is not canonical");
  return manifest;
}

async function readBundleState(resolved, auxiliary, bundleDir) {
  const root = validatePrivateDirectory(bundleDir, "schema-3 bundle directory");
  const adapter = createFileStateAdapter(root);
  const names = await listRoot(adapter);
  requireCondition(names.has(SCHEMA3_BUNDLE_FILE), "schema-3 bundle manifest is missing");
  requireCondition(names.has("state"), "schema-3 bundle state directory is missing");
  const manifest = await readManifest(resolved, auxiliary, adapter);
  const stateRoot = validatePrivateDirectory(path.join(root, "state"),
    "schema-3 bundle state directory");
  await validateStateRootInventory(stateRoot, manifest);
  let baseline;
  if ([
    SCHEMA3_BUNDLE_MANIFEST_V2_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
  ].includes(manifest.version)) {
    const baselineStateDir = validatePrivateDirectory(path.join(stateRoot, "baseline"),
      "schema-3 baseline state directory");
    baseline = await readBaselinePhaseStore({ resolved, stateDir: baselineStateDir });
    requireCondition(canonicalProtocolJson(baseline.manifest) ===
      canonicalProtocolJson(manifest.baseline.manifest),
    "schema-3 baseline state belongs to a different phase manifest");
  }
  let groups;
  if ([
    SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
    SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
  ].includes(manifest.version)) {
    const groupStateDir = validatePrivateDirectory(path.join(stateRoot, "groups"),
      "schema-3 group state directory");
    groups = await readGroupPhaseStore({ resolved, stateDir: groupStateDir });
    requireCondition(canonicalProtocolJson(groups.manifest) ===
      canonicalProtocolJson(manifest.groups.manifest),
    "schema-3 group state belongs to a different phase manifest");
  }
  let pinnedConcurrent;
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION) {
    const pinnedConcurrentStateDir = validatePrivateDirectory(
      path.join(stateRoot, "pinned-concurrent"),
      "schema-3 pinned-concurrent state directory",
    );
    pinnedConcurrent = await readPinnedConcurrentPhaseStore({
      resolved,
      stateDir: pinnedConcurrentStateDir,
    });
    requireCondition(canonicalProtocolJson(pinnedConcurrent.manifest) ===
      canonicalProtocolJson(manifest.pinnedConcurrent.manifest),
    "schema-3 pinned-concurrent state belongs to a different phase manifest");
  }
  let controlledLoad;
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION) {
    const controlledLoadStateDir = validatePrivateDirectory(
      path.join(stateRoot, "controlled-load"),
      "schema-3 controlled-load state directory",
    );
    controlledLoad = await readControlledLoadPhaseStore({
      measured: resolved,
      auxiliary,
      stateDir: controlledLoadStateDir,
    });
    requireCondition(canonicalProtocolJson(controlledLoad.manifest) ===
      canonicalProtocolJson(manifest.controlledLoad.manifest),
    "schema-3 controlled-load state belongs to a different phase manifest");
  }
  let debuggerPhase;
  if (manifest.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION) {
    const debuggerStateDir = validatePrivateDirectory(
      path.join(stateRoot, "debugger"),
      "schema-3 debugger state directory",
    );
    debuggerPhase = await readDebuggerPhaseStore({
      resolved,
      stateDir: debuggerStateDir,
    });
    requireCondition(canonicalProtocolJson(debuggerPhase.manifest) ===
      canonicalProtocolJson(manifest.debugger.manifest),
    "schema-3 debugger state belongs to a different phase manifest");
  }
  const exactCpuStateDir = validatePrivateDirectory(path.join(stateRoot, "exact-cpu"),
    "schema-3 exact-CPU state directory");
  const exactCpu = await readExactCpuPhaseStore({ resolved, stateDir: exactCpuStateDir });
  requireCondition(canonicalProtocolJson(exactCpu.manifest) ===
    canonicalProtocolJson(manifest.exactCpu.manifest),
  "schema-3 exact-CPU state belongs to a different phase manifest");
  return deepFreeze({
    manifest,
    manifestBinding: schema3BundleManifestBinding(resolved, manifest, auxiliary),
    ...(baseline === undefined ? {} : { baseline }),
    ...(groups === undefined ? {} : { groups }),
    ...(pinnedConcurrent === undefined ? {} : { pinnedConcurrent }),
    ...(controlledLoad === undefined ? {} : { controlledLoad }),
    ...(debuggerPhase === undefined ? {} : { debugger: debuggerPhase }),
    exactCpu,
  });
}

function validateAttemptOptions(value, label) {
  const options = value ?? {};
  plainObject(options, label);
  const allowed = new Set(["signal", "stdoutExcerptBytes", "stderrExcerptBytes"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  requireCondition(unknown.length === 0,
    `${label} contains unknown field '${unknown.sort()[0]}'`);
  return options;
}

export async function initializeSchema3Bundle({
  resolved,
  auxiliary,
  manifest: manifestValue,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
}) {
  const manifest = parseSchema3BundleManifest(resolved, manifestValue, auxiliary);
  const expectedBytes = canonicalSchema3BundleManifestLine(resolved, manifest, auxiliary);
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
    const storedManifest = await readManifest(resolved, auxiliary, adapter);
    requireCondition(expectedBytes.equals(canonicalSchema3BundleManifestLine(
      resolved,
      storedManifest,
      auxiliary,
    )), "existing schema-3 bundle belongs to a different manifest");

    if (!names.has("state")) ensurePrivateSubdirectory(root, "state",
      "schema-3 bundle state directory");
    const stateRoot = validatePrivateDirectory(path.join(root, "state"),
      "schema-3 bundle state directory");
    const present = await validateStateRootInventory(stateRoot, storedManifest,
      { allowMissing: true });
    for (const name of expectedStateDirectories(storedManifest)) {
      if (!present.has(name)) ensurePrivateSubdirectory(stateRoot, name,
        `schema-3 ${name} state directory`);
    }
    if ([
      SCHEMA3_BUNDLE_MANIFEST_V2_VERSION,
      SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
      SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
    ].includes(storedManifest.version)) {
      await initializeBaselinePhaseStore({
        resolved,
        manifest: storedManifest.baseline.manifest,
        stateDir: path.join(stateRoot, "baseline"),
      });
    }
    if ([
      SCHEMA3_BUNDLE_MANIFEST_V3_VERSION,
      SCHEMA3_BUNDLE_MANIFEST_V4_VERSION,
    ].includes(storedManifest.version)) {
      await initializeGroupPhaseStore({
        resolved,
        manifest: storedManifest.groups.manifest,
        stateDir: path.join(stateRoot, "groups"),
      });
    }
    if (storedManifest.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION) {
      await initializePinnedConcurrentPhaseStore({
        resolved,
        manifest: storedManifest.pinnedConcurrent.manifest,
        stateDir: path.join(stateRoot, "pinned-concurrent"),
      });
    }
    if (storedManifest.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION) {
      await initializeControlledLoadPhaseStore({
        measured: resolved,
        auxiliary,
        manifest: storedManifest.controlledLoad.manifest,
        stateDir: path.join(stateRoot, "controlled-load"),
      });
    }
    if (storedManifest.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION) {
      await initializeDebuggerPhaseStore({
        resolved,
        manifest: storedManifest.debugger.manifest,
        stateDir: path.join(stateRoot, "debugger"),
      });
    }
    const exactCpuStateDir = path.join(stateRoot, "exact-cpu");
    await initializeExactCpuPhaseStore({
      resolved,
      manifest: storedManifest.exactCpu.manifest,
      stateDir: exactCpuStateDir,
    });
    assertBundleExecutionLeaseHeld(lease);
    const bundle = await readBundleState(resolved, auxiliary, root);
    return deepFreeze({ ...bundle, lease: bundleExecutionLeaseEvidence(lease) });
  });
}

export async function readSchema3Bundle({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
}) {
  return withBundleExecutionLease(
    { bundleDir, flockPath, waitMs: leaseWaitMs },
    async (lease) => {
      const bundle = await readBundleState(resolved, auxiliary, bundleDir);
      assertBundleExecutionLeaseHeld(lease);
      return bundle;
    },
  );
}

export async function runOneSchema3ExactCpuAttempt({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 exact-CPU attempt options");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
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
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}

export async function runOneSchema3BaselineWave({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 baseline attempt options");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
    requireCondition(bundle.baseline !== undefined,
    "schema-3 bundle manifest does not bind a baseline phase");
    assertBundleExecutionLeaseHeld(lease);
    const result = await runNextBaselinePhaseWave({
      resolved,
      manifest: bundle.manifest.baseline.manifest,
      envelopes: bundle.baseline.envelopes,
      ...(runAttempt === undefined ? {} : { runAttempt }),
      attemptOptions: {
        ...options,
        retainedDirectory: bundleExecutionLeaseAttemptRetention(lease),
      },
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      await commitBaselinePhaseWave({
        resolved,
        envelope: result.envelope,
        stateDir: path.join(bundleDir, SCHEMA3_BASELINE_STATE_DIRECTORY),
      });
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}

export async function runOneSchema3GroupWave({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 group attempt options");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
    requireCondition(bundle.groups !== undefined,
    "schema-3 bundle manifest does not bind a group phase");
    assertBundleExecutionLeaseHeld(lease);
    const result = await runNextGroupPhaseWave({
      resolved,
      manifest: bundle.manifest.groups.manifest,
      envelopes: bundle.groups.envelopes,
      ...(runAttempt === undefined ? {} : { runAttempt }),
      attemptOptions: {
        ...options,
        retainedDirectory: bundleExecutionLeaseAttemptRetention(lease),
      },
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      await commitGroupPhaseWave({
        resolved,
        envelope: result.envelope,
        stateDir: path.join(bundleDir, SCHEMA3_GROUP_STATE_DIRECTORY),
      });
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}

export async function runOneSchema3PinnedConcurrentWave({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  readControllerCpuList,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 pinned-concurrent attempt options");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  requireCondition(readControllerCpuList === undefined ||
    typeof readControllerCpuList === "function",
  "schema-3 readControllerCpuList must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
    requireCondition(bundle.manifest.version === SCHEMA3_BUNDLE_MANIFEST_V4_VERSION &&
      bundle.pinnedConcurrent !== undefined,
    "schema-3 bundle manifest does not bind a pinned-concurrent phase");
    assertBundleExecutionLeaseHeld(lease);
    const result = await runNextPinnedConcurrentPhaseWave({
      resolved,
      manifest: bundle.manifest.pinnedConcurrent.manifest,
      envelopes: bundle.pinnedConcurrent.envelopes,
      ...(runAttempt === undefined ? {} : { runAttempt }),
      ...(readControllerCpuList === undefined ? {} : { readControllerCpuList }),
      attemptOptions: {
        ...options,
        retainedDirectory: bundleExecutionLeaseAttemptRetention(lease),
      },
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      await commitPinnedConcurrentPhaseWave({
        resolved,
        envelope: result.envelope,
        stateDir: path.join(bundleDir, SCHEMA3_PINNED_CONCURRENT_STATE_DIRECTORY),
      });
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}

export async function runOneSchema3ControlledLoadSession({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  runAttempt,
  startWorkerSet,
  waitInterval,
  attemptOptions,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 controlled-load attempt options");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  requireCondition(startWorkerSet === undefined || typeof startWorkerSet === "function",
    "schema-3 startWorkerSet must be a function");
  requireCondition(waitInterval === undefined || typeof waitInterval === "function",
    "schema-3 waitInterval must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
    requireCondition(bundle.manifest.version === SCHEMA3_BUNDLE_MANIFEST_V5_VERSION &&
      bundle.controlledLoad !== undefined,
    "schema-3 bundle manifest does not bind a controlled-load phase");
    assertBundleExecutionLeaseHeld(lease);
    if (bundle.controlledLoad.progress.complete) {
      return deepFreeze({
        result: {
          committed: false,
          reason: "complete",
          stage: "complete",
          errorCode: null,
          envelope: null,
          attempts: null,
          condition: null,
        },
        bundle,
        lease: bundleExecutionLeaseEvidence(lease),
      });
    }
    const { signal, ...excerptOptions } = options;
    const result = await runControlledLoadSession({
      measured: resolved,
      auxiliary,
      manifest: bundle.manifest.controlledLoad.manifest,
      ...(signal === undefined ? {} : { signal }),
      retainedDirectory: bundleExecutionLeaseAttemptRetention(lease),
      attemptOptions: excerptOptions,
      ...(runAttempt === undefined ? {} : { runAttempt }),
      ...(startWorkerSet === undefined ? {} : { startWorkerSet }),
      ...(waitInterval === undefined ? {} : { waitInterval }),
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      await commitControlledLoadSession({
        measured: resolved,
        auxiliary,
        envelope: result.envelope,
        stateDir: path.join(bundleDir, SCHEMA3_CONTROLLED_LOAD_STATE_DIRECTORY),
      });
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}

export async function runOneSchema3DebuggerAttempt({
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
  leaseWaitMs = 0,
  environmentBindingKey,
  attemptOptions,
  runAttempt,
}) {
  const options = validateAttemptOptions(attemptOptions,
    "schema-3 debugger attempt options");
  requireCondition(environmentBindingKey === undefined ||
    Buffer.isBuffer(environmentBindingKey),
  "schema-3 environmentBindingKey must be a Buffer");
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "schema-3 runAttempt must be a function");
  return withBundleExecutionLease({ bundleDir, flockPath, waitMs: leaseWaitMs }, async (lease) => {
    let bundle = await readBundleState(resolved, auxiliary, bundleDir);
    requireCondition(bundle.manifest.version === SCHEMA3_BUNDLE_MANIFEST_V6_VERSION &&
      bundle.debugger !== undefined,
    "schema-3 bundle manifest does not bind a debugger phase");
    assertBundleExecutionLeaseHeld(lease);
    if (bundle.debugger.progress.complete) {
      return deepFreeze({
        result: {
          committed: false,
          reason: "complete",
          run: null,
          outcome: null,
          envelope: null,
          attempt: null,
        },
        bundle,
        lease: bundleExecutionLeaseEvidence(lease),
      });
    }
    const result = await runNextDebuggerPhaseAttempt({
      resolved,
      manifest: bundle.manifest.debugger.manifest,
      attempts: bundle.debugger.attempts,
      ...(environmentBindingKey === undefined ? {} : { environmentBindingKey }),
      ...(runAttempt === undefined ? {} : { runAttempt }),
      attemptOptions: options,
    });
    assertBundleExecutionLeaseHeld(lease);
    if (result.committed) {
      try {
        await commitDebuggerPhaseAttempt({
          resolved,
          manifest: bundle.manifest.debugger.manifest,
          envelope: result.envelope,
          io: result.attempt.io,
          stateDir: path.join(bundleDir, SCHEMA3_DEBUGGER_STATE_DIRECTORY),
        });
      } finally {
        // The commit path disposes the handle after a successful publication;
        // a failed publication must never leak the process-local handle.
        if (result.attempt.io.disposed === false) result.attempt.io.dispose();
      }
      bundle = await readBundleState(resolved, auxiliary, bundleDir);
    }
    assertBundleExecutionLeaseHeld(lease);
    return deepFreeze({
      result,
      bundle,
      lease: bundleExecutionLeaseEvidence(lease),
    });
  });
}
