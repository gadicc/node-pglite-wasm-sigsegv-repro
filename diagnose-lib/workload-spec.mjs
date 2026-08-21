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
  "terminal-race-unresolved",
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
  plainObject(record, label);
  exactKeys(record, ["path", "sha256", "bytes", "mode"], label);
  if (typeof record.sha256 !== "string" || !DIGEST_RE.test(record.sha256) ||
      typeof record.bytes !== "string" || record.bytes.length > 10 ||
      !/^(0|[1-9][0-9]*)$/.test(record.bytes) ||
      BigInt(record.bytes) > BigInt(MAX_ARTIFACT_BYTES) ||
      !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777) {
    fail(`${label} contains malformed provenance fields`);
  }
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

export function workloadLaunchProvenance(resolved) {
  if (!RESOLVED_WORKLOADS.has(resolved) || !DIGEST_RE.test(resolved.digest)) {
    fail("resolved workload is invalid");
  }
  return Object.freeze({
    executable: resolved.command.executable,
    cwd: resolved.command.cwd,
    files: resolved.provenance.files,
  });
}

export function verifyWorkloadLaunchProvenance(snapshot) {
  const value = plainObject(snapshot, "workload launch provenance");
  exactKeys(value, ["executable", "cwd", "files"], "workload launch provenance");
  if (!Array.isArray(value.files) || value.files.length > MAX_ARTIFACTS) {
    fail(`workload launch provenance.files must contain at most ${MAX_ARTIFACTS} records`);
  }
  const canonicalCwd = canonicalPath(value.cwd, "workload launch provenance.cwd", "directory");
  if (canonicalCwd !== value.cwd) {
    fail("workload launch provenance.cwd no longer resolves to its recorded path",
      "WORKLOAD_PROVENANCE_CHANGED");
  }
  verifyFileRecord(value.executable, "workload launch provenance.executable", {
    executable: true,
  });
  const seen = new Set();
  for (const [index, record] of value.files.entries()) {
    verifyFileRecord(record, `workload launch provenance.files[${index}]`);
    if (seen.has(record.path)) fail(`workload launch provenance path '${record.path}' is duplicated`);
    seen.add(record.path);
  }
  return true;
}

export function verifyWorkloadProvenance(resolved) {
  return verifyWorkloadLaunchProvenance(workloadLaunchProvenance(resolved));
}

// A workload launch capsule is the single authority a supervised helper
// process receives for one launch: the exact public workload identity, the
// private environment values, and — only for HMAC-bound workloads — the
// environment binding key. The receiving process revalidates the workload
// digest against the public fields and every environment value against its
// digest-covered binding HMAC, so substituted values fail closed. The capsule
// travels only through private in-memory channels; it is never written to
// the filesystem, arguments, or environment.
export const WORKLOAD_LAUNCH_CAPSULE_VERSION = 1;

const CAPSULE_BINDING_MODES = new Set(["none", "unrecorded", "hmac-sha256"]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function capsuleEnvironmentHmac(key, source, name, value) {
  return createHmac("sha256", key)
    .update(source).update("\0").update(name).update("\0").update(value)
    .digest("hex");
}

function validateCapsuleIdentityRecord(value, label, { executable = false } = {}) {
  plainObject(value, label);
  exactKeys(value, ["path", "sha256", "bytes", "mode"], label);
  boundedString(value.path, `${label}.path`);
  if (!path.isAbsolute(value.path) || Buffer.byteLength(value.path) > MAX_PATH_BYTES) {
    fail(`${label}.path must be an absolute bounded path`, "INVALID_WORKLOAD_CAPSULE");
  }
  if (typeof value.sha256 !== "string" || !DIGEST_RE.test(value.sha256)) {
    fail(`${label}.sha256 is invalid`, "INVALID_WORKLOAD_CAPSULE");
  }
  if (typeof value.bytes !== "string" || value.bytes.length > 10 ||
      !/^(0|[1-9][0-9]*)$/.test(value.bytes) ||
      BigInt(value.bytes) > BigInt(MAX_ARTIFACT_BYTES)) {
    fail(`${label}.bytes is invalid`, "INVALID_WORKLOAD_CAPSULE");
  }
  canonicalInteger(value.mode, `${label}.mode`, 0, 0o777);
  if (executable && (value.mode & 0o111) === 0) {
    fail(`${label} must record an execute bit`, "INVALID_WORKLOAD_CAPSULE");
  }
  return value;
}

function validateCapsuleEnvironmentBindings(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ENVIRONMENT_ENTRIES) {
    fail(`${label} must be an array with at most ${MAX_ENVIRONMENT_ENTRIES} entries`,
      "INVALID_WORKLOAD_CAPSULE");
  }
  const names = new Set();
  for (const [index, binding] of value.entries()) {
    const entryLabel = `${label}[${index}]`;
    plainObject(binding, entryLabel);
    const hasHmac = Object.hasOwn(binding, "valueHmacSha256");
    exactKeys(binding, hasHmac ? ["name", "source", "valueHmacSha256"] : ["name", "source"],
      entryLabel);
    boundedString(binding.name, `${entryLabel}.name`);
    if (!ENVIRONMENT_NAME_RE.test(binding.name)) {
      fail(`${entryLabel}.name is invalid`, "INVALID_WORKLOAD_CAPSULE");
    }
    if (names.has(binding.name)) {
      fail(`${entryLabel}.name is duplicated`, "INVALID_WORKLOAD_CAPSULE");
    }
    names.add(binding.name);
    if (!["ambient", "set"].includes(binding.source)) {
      fail(`${entryLabel}.source is invalid`, "INVALID_WORKLOAD_CAPSULE");
    }
    if (hasHmac &&
        (typeof binding.valueHmacSha256 !== "string" || !DIGEST_RE.test(binding.valueHmacSha256))) {
      fail(`${entryLabel}.valueHmacSha256 is invalid`, "INVALID_WORKLOAD_CAPSULE");
    }
  }
  return value;
}

function validateCapsuleWorkload(value) {
  const workload = plainObject(value, "workload launch capsule workload");
  exactKeys(workload, [
    "version", "id", "label", "description", "risk", "command", "environment",
    "attempt", "outcomes", "capabilities", "provenance",
  ], "workload launch capsule workload");
  if (workload.version !== WORKLOAD_SPEC_VERSION) {
    fail(`workload launch capsule workload version must be ${WORKLOAD_SPEC_VERSION}`,
      "INVALID_WORKLOAD_CAPSULE");
  }
  if (typeof workload.id !== "string" || !WORKLOAD_ID_RE.test(workload.id)) {
    fail("workload launch capsule workload id is invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  boundedString(workload.label, "workload launch capsule workload label");
  boundedString(workload.description, "workload launch capsule workload description");
  if (!WORKLOAD_RISKS.includes(workload.risk)) {
    fail("workload launch capsule workload risk is invalid", "INVALID_WORKLOAD_CAPSULE");
  }

  const command = plainObject(workload.command, "workload launch capsule command");
  exactKeys(command, ["executable", "args", "cwd"], "workload launch capsule command");
  validateCapsuleIdentityRecord(command.executable, "workload launch capsule executable", {
    executable: true,
  });
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGUMENTS) {
    fail("workload launch capsule command args are invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  for (const [index, argument] of command.args.entries()) {
    boundedString(argument, `workload launch capsule command args[${index}]`, {
      allowEmpty: true,
    });
  }
  boundedString(command.cwd, "workload launch capsule command cwd");
  if (!path.isAbsolute(command.cwd) || Buffer.byteLength(command.cwd) > MAX_PATH_BYTES) {
    fail("workload launch capsule command cwd must be an absolute bounded path",
      "INVALID_WORKLOAD_CAPSULE");
  }

  const environment = plainObject(workload.environment,
    "workload launch capsule environment");
  exactKeys(environment, ["bindingMode", "provenanceComplete", "bindings"],
    "workload launch capsule environment");
  if (!CAPSULE_BINDING_MODES.has(environment.bindingMode)) {
    fail("workload launch capsule environment binding mode is invalid",
      "INVALID_WORKLOAD_CAPSULE");
  }
  if (environment.provenanceComplete !== (environment.bindingMode !== "unrecorded")) {
    fail("workload launch capsule environment provenance completeness is inconsistent",
      "INVALID_WORKLOAD_CAPSULE");
  }
  validateCapsuleEnvironmentBindings(environment.bindings,
    "workload launch capsule environment bindings");
  if (environment.bindingMode === "hmac-sha256") {
    if (environment.bindings.length === 0 ||
        environment.bindings.some((binding) => !Object.hasOwn(binding, "valueHmacSha256"))) {
      fail("workload launch capsule hmac-sha256 bindings must all carry value HMACs",
        "INVALID_WORKLOAD_CAPSULE");
    }
  } else if (environment.bindings.some((binding) => Object.hasOwn(binding, "valueHmacSha256"))) {
    fail("workload launch capsule value HMACs require the hmac-sha256 binding mode",
      "INVALID_WORKLOAD_CAPSULE");
  }

  const attempt = plainObject(workload.attempt, "workload launch capsule attempt");
  exactKeys(attempt, ["mode", "timeoutMs", "termGraceMs", "killGraceMs"],
    "workload launch capsule attempt");
  if (!WORKLOAD_ATTEMPT_MODES.includes(attempt.mode)) {
    fail("workload launch capsule attempt mode is invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  canonicalInteger(attempt.timeoutMs, "workload launch capsule attempt timeoutMs", 1,
    MAX_TIMEOUT_MS);
  canonicalInteger(attempt.termGraceMs, "workload launch capsule attempt termGraceMs", 0,
    MAX_GRACE_MS);
  canonicalInteger(attempt.killGraceMs, "workload launch capsule attempt killGraceMs", 0,
    MAX_GRACE_MS);

  const outcomes = plainObject(workload.outcomes, "workload launch capsule outcomes");
  exactKeys(outcomes, ["targetSignals", "mappedExits"], "workload launch capsule outcomes");
  if (!Array.isArray(outcomes.targetSignals) || outcomes.targetSignals.length > 64) {
    fail("workload launch capsule target signals are invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  const signalSet = new Set();
  for (const signal of outcomes.targetSignals) {
    if (typeof signal !== "string" || !KNOWN_SIGNALS.has(signal) || signalSet.has(signal)) {
      fail("workload launch capsule target signals are invalid", "INVALID_WORKLOAD_CAPSULE");
    }
    signalSet.add(signal);
  }
  if (!Array.isArray(outcomes.mappedExits) || outcomes.mappedExits.length > 256) {
    fail("workload launch capsule mapped exits are invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  const codeSet = new Set();
  for (const [index, mapped] of outcomes.mappedExits.entries()) {
    const mappedLabel = `workload launch capsule mappedExits[${index}]`;
    plainObject(mapped, mappedLabel);
    exactKeys(mapped, ["code", "category", "label"], mappedLabel);
    canonicalInteger(mapped.code, `${mappedLabel}.code`, 1, 255);
    if (codeSet.has(mapped.code)) {
      fail(`${mappedLabel}.code is duplicated`, "INVALID_WORKLOAD_CAPSULE");
    }
    codeSet.add(mapped.code);
    if (!WORKLOAD_OUTCOME_CATEGORIES.includes(mapped.category)) {
      fail(`${mappedLabel}.category is invalid`, "INVALID_WORKLOAD_CAPSULE");
    }
    boundedString(mapped.label, `${mappedLabel}.label`);
  }

  const capabilities = plainObject(workload.capabilities,
    "workload launch capsule capabilities");
  exactKeys(capabilities, WORKLOAD_CAPABILITIES, "workload launch capsule capabilities");
  for (const name of WORKLOAD_CAPABILITIES) {
    if (typeof capabilities[name] !== "boolean") {
      fail(`workload launch capsule capabilities.${name} must be boolean`,
        "INVALID_WORKLOAD_CAPSULE");
    }
  }

  const provenance = plainObject(workload.provenance, "workload launch capsule provenance");
  exactKeys(provenance, ["completeness", "files"], "workload launch capsule provenance");
  if (!["complete", "partial"].includes(provenance.completeness)) {
    fail("workload launch capsule provenance completeness is invalid",
      "INVALID_WORKLOAD_CAPSULE");
  }
  if (!Array.isArray(provenance.files) || provenance.files.length > MAX_ARTIFACTS) {
    fail("workload launch capsule provenance files are invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  const seen = new Set();
  for (const [index, record] of provenance.files.entries()) {
    validateCapsuleIdentityRecord(record, `workload launch capsule provenance.files[${index}]`);
    if (seen.has(record.path)) {
      fail("workload launch capsule provenance path is duplicated", "INVALID_WORKLOAD_CAPSULE");
    }
    seen.add(record.path);
  }
  return workload;
}

function validateCapsuleEnvironmentValues(capsule, workload) {
  const values = plainObject(capsule.environment, "workload launch capsule environment values");
  const names = Object.keys(values);
  if (names.length > MAX_ENVIRONMENT_ENTRIES) {
    fail("workload launch capsule environment values are invalid", "INVALID_WORKLOAD_CAPSULE");
  }
  const bindingNames = new Set(workload.environment.bindings.map((binding) => binding.name));
  for (const name of names) {
    if (!ENVIRONMENT_NAME_RE.test(name) || !bindingNames.has(name)) {
      fail("workload launch capsule environment values do not match the bindings",
        "INVALID_WORKLOAD_CAPSULE");
    }
    boundedString(values[name], `workload launch capsule environment value '${name}'`, {
      allowEmpty: true,
    });
  }
  if (bindingNames.size !== names.length) {
    fail("workload launch capsule environment values do not match the bindings",
      "INVALID_WORKLOAD_CAPSULE");
  }

  if (workload.environment.bindingMode === "hmac-sha256") {
    if (typeof capsule.environmentBindingKey !== "string") {
      fail("workload launch capsule requires its environment binding key",
        "WORKLOAD_CAPSULE_KEY_REQUIRED");
    }
    const key = Buffer.from(capsule.environmentBindingKey, "base64");
    try {
      if (key.length < ENVIRONMENT_BINDING_KEY_BYTES ||
          key.toString("base64") !== capsule.environmentBindingKey) {
        fail("workload launch capsule environment binding key is invalid",
          "INVALID_WORKLOAD_CAPSULE");
      }
      for (const binding of workload.environment.bindings) {
        if (capsuleEnvironmentHmac(key, binding.source, binding.name, values[binding.name]) !==
            binding.valueHmacSha256) {
          fail("workload launch capsule environment values do not match their binding HMACs",
            "WORKLOAD_CAPSULE_ENVIRONMENT_MISMATCH");
        }
      }
    } finally {
      key.fill(0);
    }
  } else if (capsule.environmentBindingKey !== null) {
    fail("workload launch capsule environment binding key requires the hmac-sha256 binding mode",
      "INVALID_WORKLOAD_CAPSULE");
  }
  return Object.freeze({ ...values });
}

export function buildWorkloadLaunchCapsule(resolved, options = {}) {
  plainObject(options, "workload launch capsule options");
  exactKeys(options, ["environmentBindingKey"], "workload launch capsule options");
  workloadLaunchProvenance(resolved);
  const values = workloadLaunchEnvironment(resolved);
  let encodedKey = null;
  if (resolved.environment.bindingMode === "hmac-sha256") {
    const key = options.environmentBindingKey;
    if (!Buffer.isBuffer(key) || key.length < ENVIRONMENT_BINDING_KEY_BYTES) {
      fail("options.environmentBindingKey must be a Buffer of at least " +
        `${ENVIRONMENT_BINDING_KEY_BYTES} bytes`,
      "WORKLOAD_CAPSULE_KEY_REQUIRED");
    }
    for (const binding of resolved.environment.bindings) {
      if (capsuleEnvironmentHmac(key, binding.source, binding.name, values[binding.name]) !==
          binding.valueHmacSha256) {
        fail("environment binding key does not reproduce the workload environment bindings",
          "WORKLOAD_CAPSULE_ENVIRONMENT_MISMATCH");
      }
    }
    encodedKey = key.toString("base64");
  } else if (options.environmentBindingKey !== undefined) {
    fail("options.environmentBindingKey applies only to hmac-sha256-bound workloads",
      "INVALID_WORKLOAD_CAPSULE");
  }
  return deepFreeze({
    version: WORKLOAD_LAUNCH_CAPSULE_VERSION,
    workload: {
      version: resolved.version,
      id: resolved.id,
      label: resolved.label,
      description: resolved.description,
      risk: resolved.risk,
      command: resolved.command,
      environment: resolved.environment,
      attempt: resolved.attempt,
      outcomes: resolved.outcomes,
      capabilities: resolved.capabilities,
      provenance: resolved.provenance,
    },
    environment: values,
    environmentBindingKey: encodedKey,
  });
}

export function resolveWorkloadLaunchCapsule(value) {
  const capsule = plainObject(value, "workload launch capsule");
  exactKeys(capsule, ["version", "workload", "environment", "environmentBindingKey"],
    "workload launch capsule");
  if (capsule.version !== WORKLOAD_LAUNCH_CAPSULE_VERSION) {
    fail(`workload launch capsule version must be ${WORKLOAD_LAUNCH_CAPSULE_VERSION}`,
      "INVALID_WORKLOAD_CAPSULE");
  }
  const workload = validateCapsuleWorkload(capsule.workload);
  const environment = validateCapsuleEnvironmentValues(capsule, workload);
  const digest = createHash("sha256").update(canonicalWorkloadJson(workload)).digest("hex");
  const resolved = { ...workload, digest };
  Object.defineProperty(resolved, WORKLOAD_ENVIRONMENT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: environment,
  });
  Object.freeze(resolved);
  RESOLVED_WORKLOADS.add(resolved);
  return resolved;
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
  if (terminalReason === "terminal-race-unresolved") {
    return invalidAttempt("terminal-race-unresolved", raw);
  }
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
