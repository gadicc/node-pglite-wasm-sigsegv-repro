// Draft, process-local workload validation. This module does not execute a
// workload or parse persisted evidence. The eventual runner must revalidate
// provenance immediately before a shell-free launch.
import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { constants as osConstants } from "node:os";

export const WORKLOAD_SPEC_VERSION = 1;
export const WORKLOAD_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const WORKLOAD_RISKS = Object.freeze([
  "standard",
  "high-memory",
  "disruptive",
]);
export const WORKLOAD_ATTEMPT_MODES = Object.freeze([
  "exit",
  "survive-window",
]);
export const WORKLOAD_CAPABILITIES = Object.freeze([
  "baseline",
  "groups",
  "isolated",
  "pinnedConcurrent",
  "gdb",
  "frequency",
]);
export const WORKLOAD_OUTCOME_CATEGORIES = Object.freeze([
  "target-fault",
  "corruption",
]);
export const ATTEMPT_TERMINAL_REASONS = Object.freeze([
  "natural-exit",
  "observation-window-elapsed",
  "external-cancel",
  "launch-error",
  "cleanup-failure",
]);

const WORKLOAD_ENVIRONMENT = Symbol("workloadEnvironment");
const RESOLVED_WORKLOADS = new WeakSet();
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LAUNCH_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_PATH_BYTES = 4_096;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_ARGUMENTS = 4_096;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_GRACE_MS = 60_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const ENVIRONMENT_BINDING_KEY_BYTES = 32;

export class WorkloadSpecError extends Error {
  constructor(message, code = "INVALID_WORKLOAD_SPEC") {
    super(message);
    this.name = "WorkloadSpecError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new WorkloadSpecError(message, code);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail(`${label} contains unknown field '${unexpected.sort()[0]}'`);
  }
}

function boundedString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) ||
      value.includes("\0") || Buffer.byteLength(value) > MAX_STRING_BYTES) {
    fail(`${label} must be a bounded ${allowEmpty ? "" : "non-empty "}NUL-free string`);
  }
  return value;
}

function canonicalInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPath(value, label, expectedType) {
  boundedString(value, label);
  if (!path.isAbsolute(value) || Buffer.byteLength(value) > MAX_PATH_BYTES) {
    fail(`${label} must be an absolute bounded path`);
  }
  let resolved;
  let stats;
  try {
    resolved = realpathSync(value);
    stats = statSync(resolved);
  } catch (error) {
    fail(`${label} cannot be resolved: ${error?.code ?? "unknown error"}`, "WORKLOAD_PATH_ERROR");
  }
  if (Buffer.byteLength(resolved) > MAX_PATH_BYTES) fail(`${label} resolves to an oversized path`);
  if (expectedType === "directory" && !stats.isDirectory()) fail(`${label} must resolve to a directory`);
  if (expectedType === "file" && !stats.isFile()) fail(`${label} must resolve to a regular file`);
  return resolved;
}

function fileDigest(file, label) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(`${label} cannot be opened safely: ${error?.code ?? "unknown error"}`, "WORKLOAD_PATH_ERROR");
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (before.size < 0n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      fail(`${label} exceeds the ${MAX_ARTIFACT_BYTES}-byte provenance limit`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0n;
    while (offset < before.size) {
      const remaining = before.size - offset;
      const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const bytes = readSync(fd, buffer, 0, length, Number(offset));
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += BigInt(bytes);
    }
    const after = fstatSync(fd, { bigint: true });
    let pathAfter;
    try {
      pathAfter = statSync(file, { bigint: true });
    } catch (error) {
      fail(`${label} changed while it was hashed: ${error?.code ?? "unknown error"}`,
        "WORKLOAD_PROVENANCE_CHANGED");
    }
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || before.mode !== after.mode ||
        offset !== before.size || before.dev !== pathAfter.dev ||
        before.ino !== pathAfter.ino || before.size !== pathAfter.size ||
        before.mtimeNs !== pathAfter.mtimeNs || before.ctimeNs !== pathAfter.ctimeNs ||
        before.mode !== pathAfter.mode) {
      fail(`${label} changed while it was hashed`, "WORKLOAD_PROVENANCE_CHANGED");
    }
    return Object.freeze({
      sha256: hash.digest("hex"),
      bytes: before.size.toString(),
      mode: Number(before.mode & 0o777n),
    });
  } finally {
    closeSync(fd);
  }
}

function resolveExecutable(value) {
  const executable = canonicalPath(value, "command.executable", "file");
  const digest = fileDigest(executable, "command.executable");
  if ((digest.mode & 0o111) === 0) fail("command.executable must be executable");
  return Object.freeze({ path: executable, ...digest });
}

function resolveArguments(value) {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    fail(`command.args must be an array with at most ${MAX_ARGUMENTS} entries`);
  }
  return Object.freeze(value.map((entry, index) =>
    boundedString(entry, `command.args[${index}]`, { allowEmpty: true })));
}

function resolveEnvironment(value, ambientEnvironment, bindingKey) {
  const environment = plainObject(value ?? {}, "environment");
  exactKeys(environment, ["pass", "set"], "environment");
  const pass = environment.pass ?? [];
  const set = environment.set ?? {};
  if (!Array.isArray(pass) || pass.length > MAX_ENVIRONMENT_ENTRIES) {
    fail(`environment.pass must contain at most ${MAX_ENVIRONMENT_ENTRIES} names`);
  }
  plainObject(set, "environment.set");
  if (Object.keys(set).length > MAX_ENVIRONMENT_ENTRIES) {
    fail(`environment.set must contain at most ${MAX_ENVIRONMENT_ENTRIES} entries`);
  }
  const names = new Set();
  const execution = Object.create(null);
  const bindings = [];
  const bindingMode = bindingKey === undefined ? "unrecorded" : "hmac-sha256";
  if (bindingKey !== undefined &&
      (!Buffer.isBuffer(bindingKey) || bindingKey.length < ENVIRONMENT_BINDING_KEY_BYTES)) {
    fail(`options.environmentBindingKey must be a Buffer of at least ${ENVIRONMENT_BINDING_KEY_BYTES} bytes`);
  }
  const binding = (name, source, environmentValue) => Object.freeze({
    name,
    source,
    ...(bindingKey === undefined ? {} : {
      valueHmacSha256: createHmac("sha256", bindingKey)
        .update(source).update("\0").update(name).update("\0").update(environmentValue)
        .digest("hex"),
    }),
  });
  for (const [index, rawName] of pass.entries()) {
    const name = boundedString(rawName, `environment.pass[${index}]`);
    if (!ENVIRONMENT_NAME_RE.test(name)) fail(`environment name '${name}' is invalid`);
    if (names.has(name)) fail(`environment name '${name}' is duplicated`);
    names.add(name);
    if (!Object.hasOwn(ambientEnvironment, name)) {
      fail(`environment variable '${name}' is unavailable`, "WORKLOAD_ENVIRONMENT_MISSING");
    }
    const environmentValue = boundedString(
      ambientEnvironment[name],
      `environment variable '${name}'`,
      { allowEmpty: true },
    );
    execution[name] = environmentValue;
    bindings.push(binding(name, "ambient", environmentValue));
  }
  for (const name of Object.keys(set).sort()) {
    if (!ENVIRONMENT_NAME_RE.test(name)) fail(`environment name '${name}' is invalid`);
    if (names.has(name)) fail(`environment name '${name}' is duplicated`);
    names.add(name);
    const environmentValue = boundedString(
      set[name],
      `environment.set.${name}`,
      { allowEmpty: true },
    );
    execution[name] = environmentValue;
    bindings.push(binding(name, "set", environmentValue));
  }
  bindings.sort((left, right) => compareCodeUnits(left.name, right.name));
  return {
    bindingMode: bindings.length === 0 ? "none" : bindingMode,
    bindings: Object.freeze(bindings),
    execution: Object.freeze(execution),
  };
}

function resolveAttempt(value) {
  const attempt = plainObject(value, "attempt");
  exactKeys(attempt, ["mode", "timeoutMs", "termGraceMs", "killGraceMs"], "attempt");
  if (!WORKLOAD_ATTEMPT_MODES.includes(attempt.mode)) {
    fail(`attempt.mode must be one of: ${WORKLOAD_ATTEMPT_MODES.join(", ")}`);
  }
  return Object.freeze({
    mode: attempt.mode,
    timeoutMs: canonicalInteger(attempt.timeoutMs, "attempt.timeoutMs", 1, MAX_TIMEOUT_MS),
    termGraceMs: canonicalInteger(attempt.termGraceMs ?? 1_000, "attempt.termGraceMs", 0, MAX_GRACE_MS),
    killGraceMs: canonicalInteger(attempt.killGraceMs ?? 1_000, "attempt.killGraceMs", 0, MAX_GRACE_MS),
  });
}

function resolveOutcomes(value) {
  const outcomes = plainObject(value ?? {}, "outcomes");
  exactKeys(outcomes, ["targetSignals", "mappedExits"], "outcomes");
  const targetSignals = outcomes.targetSignals ?? ["SIGSEGV"];
  const mappedExits = outcomes.mappedExits ?? [];
  if (!Array.isArray(targetSignals) || targetSignals.length > 64) {
    fail("outcomes.targetSignals must be a bounded array");
  }
  if (!Array.isArray(mappedExits) || mappedExits.length > 256) {
    fail("outcomes.mappedExits must be a bounded array");
  }
  const signalSet = new Set();
  const signals = targetSignals.map((signal, index) => {
    boundedString(signal, `outcomes.targetSignals[${index}]`);
    if (!KNOWN_SIGNALS.has(signal)) fail(`outcomes target signal '${signal}' is unknown`);
    if (signalSet.has(signal)) fail(`outcomes target signal '${signal}' is duplicated`);
    signalSet.add(signal);
    return signal;
  }).sort();
  const codeSet = new Set();
  const exits = mappedExits.map((entry, index) => {
    plainObject(entry, `outcomes.mappedExits[${index}]`);
    exactKeys(entry, ["code", "category", "label"], `outcomes.mappedExits[${index}]`);
    const code = canonicalInteger(entry.code, `outcomes.mappedExits[${index}].code`, 1, 255);
    if (codeSet.has(code)) fail(`mapped exit ${code} is duplicated`);
    codeSet.add(code);
    if (!WORKLOAD_OUTCOME_CATEGORIES.includes(entry.category)) {
      fail(`mapped exit ${code} category must be one of: ${WORKLOAD_OUTCOME_CATEGORIES.join(", ")}`);
    }
    return Object.freeze({
      code,
      category: entry.category,
      label: boundedString(entry.label, `outcomes.mappedExits[${index}].label`),
    });
  }).sort((left, right) => left.code - right.code);
  return Object.freeze({
    targetSignals: Object.freeze(signals),
    mappedExits: Object.freeze(exits),
  });
}

function resolveCapabilities(value) {
  const capabilities = plainObject(value ?? {}, "capabilities");
  exactKeys(capabilities, WORKLOAD_CAPABILITIES, "capabilities");
  return Object.freeze(Object.fromEntries(WORKLOAD_CAPABILITIES.map((name) => {
    const enabled = capabilities[name] ?? false;
    if (typeof enabled !== "boolean") fail(`capabilities.${name} must be boolean`);
    return [name, enabled];
  })));
}

function resolveArtifacts(value) {
  const provenance = plainObject(value, "provenance");
  exactKeys(provenance, ["completeness", "files"], "provenance");
  if (!["complete", "partial"].includes(provenance.completeness)) {
    fail("provenance.completeness must be complete or partial");
  }
  const artifacts = provenance.files;
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) {
    fail(`provenance.files must be an array with at most ${MAX_ARTIFACTS} entries`);
  }
  const seen = new Set();
  const resolved = artifacts.map((artifact, index) => {
    const canonical = canonicalPath(artifact, `provenance.files[${index}]`, "file");
    if (seen.has(canonical)) fail(`provenance path '${canonical}' is duplicated`);
    seen.add(canonical);
    return Object.freeze({
      path: canonical,
      ...fileDigest(canonical, `provenance.files[${index}]`),
    });
  });
  resolved.sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze({
    completeness: provenance.completeness,
    files: Object.freeze(resolved),
  });
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical workload data contains a non-integer number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  fail("canonical workload data contains a non-JSON value");
}

export function canonicalWorkloadJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function resolveWorkloadSpec(spec, options = {}) {
  plainObject(options, "resolver options");
  exactKeys(options, ["environment", "environmentBindingKey"], "resolver options");
  const input = plainObject(spec, "workload");
  exactKeys(input, [
    "version",
    "id",
    "label",
    "description",
    "risk",
    "command",
    "environment",
    "attempt",
    "outcomes",
    "capabilities",
    "provenance",
  ], "workload");
  if (input.version !== WORKLOAD_SPEC_VERSION) {
    fail(`workload.version must be ${WORKLOAD_SPEC_VERSION}`);
  }
  if (typeof input.id !== "string" || !WORKLOAD_ID_RE.test(input.id)) {
    fail("workload.id must use lowercase letters, digits, and internal hyphens");
  }
  const risk = input.risk ?? "standard";
  if (!WORKLOAD_RISKS.includes(risk)) fail(`workload.risk must be one of: ${WORKLOAD_RISKS.join(", ")}`);
  const command = plainObject(input.command, "command");
  exactKeys(command, ["executable", "args", "cwd"], "command");
  const executable = resolveExecutable(command.executable);
  const args = resolveArguments(command.args ?? []);
  const cwd = canonicalPath(command.cwd, "command.cwd", "directory");
  const environment = resolveEnvironment(
    input.environment,
    options.environment ?? process.env,
    options.environmentBindingKey,
  );
  const publicSpec = {
    version: WORKLOAD_SPEC_VERSION,
    id: input.id,
    label: boundedString(input.label, "workload.label"),
    description: boundedString(input.description, "workload.description"),
    risk,
    command: Object.freeze({ executable, args, cwd }),
    environment: Object.freeze({
      bindingMode: environment.bindingMode,
      provenanceComplete: environment.bindingMode !== "unrecorded",
      bindings: environment.bindings,
    }),
    attempt: resolveAttempt(input.attempt),
    outcomes: resolveOutcomes(input.outcomes),
    capabilities: resolveCapabilities(input.capabilities),
    provenance: resolveArtifacts(input.provenance),
  };
  const digest = createHash("sha256").update(canonicalWorkloadJson(publicSpec)).digest("hex");
  const resolved = { ...publicSpec, digest };
  Object.defineProperty(resolved, WORKLOAD_ENVIRONMENT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: environment.execution,
  });
  Object.freeze(resolved);
  RESOLVED_WORKLOADS.add(resolved);
  return resolved;
}

export function workloadLaunchEnvironment(resolved) {
  if (!RESOLVED_WORKLOADS.has(resolved) || !DIGEST_RE.test(resolved.digest) ||
      !(WORKLOAD_ENVIRONMENT in resolved)) {
    fail("resolved workload is missing its private launch environment");
  }
  return { ...resolved[WORKLOAD_ENVIRONMENT] };
}

function verifyFileRecord(record, label, { executable = false } = {}) {
  const canonical = canonicalPath(record.path, label, "file");
  if (canonical !== record.path) {
    fail(`${label} no longer resolves to its recorded path`, "WORKLOAD_PROVENANCE_CHANGED");
  }
  const current = fileDigest(canonical, label);
  if (current.sha256 !== record.sha256 || current.bytes !== record.bytes ||
      current.mode !== record.mode || (executable && (current.mode & 0o111) === 0)) {
    fail(`${label} no longer matches its recorded identity`, "WORKLOAD_PROVENANCE_CHANGED");
  }
}

export function verifyWorkloadProvenance(resolved) {
  if (!RESOLVED_WORKLOADS.has(resolved) || !DIGEST_RE.test(resolved.digest)) {
    fail("resolved workload is invalid");
  }
  verifyFileRecord(resolved.command.executable, "command.executable", { executable: true });
  for (const [index, artifact] of resolved.provenance.files.entries()) {
    verifyFileRecord(artifact, `provenance.files[${index}]`);
  }
  return true;
}

function invalidAttempt(invalidReason, raw) {
  return Object.freeze({
    category: "operational-invalid",
    evidenceKind: "operational",
    label: invalidReason,
    validOutcome: false,
    invalidReason,
    raw: Object.freeze(raw),
  });
}

export function classifyWorkloadAttempt(resolved, observation) {
  if (!RESOLVED_WORKLOADS.has(resolved) || !DIGEST_RE.test(resolved.digest)) {
    fail("resolved workload is invalid");
  }
  const value = plainObject(observation, "attempt observation");
  exactKeys(value, [
    "exitCode",
    "signal",
    "terminalReason",
    "cleanupComplete",
    "launchErrorCode",
  ], "attempt observation");
  const rawExitCode = value.exitCode ?? null;
  const rawSignal = value.signal ?? null;
  const rawTerminalReason = value.terminalReason;
  const rawCleanupComplete = value.cleanupComplete;
  const rawLaunchErrorCode = value.launchErrorCode ?? null;
  const exitCodeValid = rawExitCode === null ||
    (Number.isSafeInteger(rawExitCode) && rawExitCode >= 0 && rawExitCode <= 255);
  const signalValid = rawSignal === null ||
    (typeof rawSignal === "string" && KNOWN_SIGNALS.has(rawSignal));
  const terminalReasonValid = ATTEMPT_TERMINAL_REASONS.includes(rawTerminalReason);
  const cleanupCompleteValid = typeof rawCleanupComplete === "boolean";
  const launchErrorCodeValid = rawLaunchErrorCode === null ||
    (typeof rawLaunchErrorCode === "string" && LAUNCH_ERROR_CODE_RE.test(rawLaunchErrorCode));
  const exitCode = exitCodeValid ? rawExitCode : null;
  const signal = signalValid ? rawSignal : null;
  const terminalReason = terminalReasonValid ? rawTerminalReason : null;
  const cleanupComplete = cleanupCompleteValid ? rawCleanupComplete : false;
  const launchErrorCode = launchErrorCodeValid ? rawLaunchErrorCode : null;
  const raw = { exitCode, signal, terminalReason, cleanupComplete, launchErrorCode };
  if (!terminalReasonValid || !cleanupCompleteValid) {
    return invalidAttempt("malformed-observation", raw);
  }
  if (!exitCodeValid) {
    return invalidAttempt("malformed-exit-code", raw);
  }
  if (!signalValid) {
    return invalidAttempt("malformed-signal", raw);
  }
  if (!launchErrorCodeValid) {
    return invalidAttempt("malformed-launch-error-code", raw);
  }
  if (exitCode !== null && signal !== null) return invalidAttempt("ambiguous-exit-status", raw);
  if (terminalReason === "cleanup-failure") return invalidAttempt("cleanup-failure", raw);
  if (!cleanupComplete) return invalidAttempt("cleanup-incomplete", raw);
  if (terminalReason === "launch-error") {
    if (launchErrorCode === null || exitCode !== null || signal !== null) {
      return invalidAttempt("malformed-launch-error", raw);
    }
    return invalidAttempt("launch-error", raw);
  }
  if (launchErrorCode !== null) return invalidAttempt("unexpected-launch-error", raw);
  if (terminalReason === "external-cancel") return invalidAttempt("external-cancel", raw);
  if (terminalReason === "observation-window-elapsed") {
    if (exitCode !== null || signal !== null) {
      return invalidAttempt("ambiguous-terminal-event", raw);
    }
    if (resolved.attempt.mode !== "survive-window") {
      return invalidAttempt("observation-window-before-exit", raw);
    }
    return Object.freeze({
      category: "pass",
      evidenceKind: "survived-window",
      label: "no-target-fault-within-window",
      validOutcome: true,
      invalidReason: null,
      raw: Object.freeze(raw),
    });
  }
  if (exitCode === null && signal === null) return invalidAttempt("missing-exit-status", raw);
  if (signal !== null) {
    const target = resolved.outcomes.targetSignals.includes(signal);
    return Object.freeze({
      category: target ? "target-fault" : "other-workload-failure",
      evidenceKind: "direct-signal",
      label: target ? signal.toLowerCase() : `unexpected-${signal.toLowerCase()}`,
      validOutcome: true,
      invalidReason: null,
      raw: Object.freeze(raw),
    });
  }
  if (exitCode === 0) {
    return Object.freeze({
      category: "pass",
      evidenceKind: "normal-exit",
      label: "exit-zero",
      validOutcome: true,
      invalidReason: null,
      raw: Object.freeze(raw),
    });
  }
  const mapping = resolved.outcomes.mappedExits.find((entry) => entry.code === exitCode);
  return Object.freeze({
    category: mapping?.category ?? "other-workload-failure",
    evidenceKind: mapping === undefined ? "unmapped-exit" : "mapped-exit",
    label: mapping?.label ?? `exit-${exitCode}`,
    validOutcome: true,
    invalidReason: null,
    raw: Object.freeze(raw),
  });
}
