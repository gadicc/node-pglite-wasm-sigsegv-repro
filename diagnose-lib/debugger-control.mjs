import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";

import {
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";

export const DEBUGGER_CONTROL_VERSION = 1;
export const DEBUGGER_CONTROL_MAX_BYTES = 64 * 1024;
export const DEBUGGER_CONTROL_MAX_FRAMES = 8;

const NONCE_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const START_TICKS_RE = /^(0|[1-9][0-9]{0,31})$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_PID = 2_147_483_647;
const MAX_FRAME_BYTES = 16 * 1024;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const ERROR_STAGES = new Set(["launch", "observe", "capture"]);
const FRAME_TYPES = new Set([
  "profile-ready",
  "inferior-started",
  "inferior-stopped",
  "inferior-exited",
  "inferior-signaled",
  "capture-complete",
  "profile-error",
  "profile-complete",
]);
const COMMON_KEYS = Object.freeze([
  "version",
  "type",
  "generation",
  "manifestSha256",
  "run",
  "nonce",
  "sequence",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class DebuggerControlError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_CONTROL") {
    super(message);
    this.name = "DebuggerControlError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerControlError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
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

function canonicalInteger(value, label, minimum, maximum) {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail("debugger control transcript must be a string, Buffer, or Uint8Array");
}

function parseContext(manifest, value) {
  exactKeys(value, ["run", "nonce"], "debugger control context");
  const run = canonicalInteger(value.run, "debugger control run", 1,
    manifest.schedule.maxRuns);
  requireCondition(typeof value.nonce === "string" && NONCE_RE.test(value.nonce),
    "debugger control nonce must be exactly 32 lowercase hexadecimal characters");
  return { run, nonce: value.nonce };
}

function decodeRecords(bytes) {
  requireCondition(bytes.length > 0 && bytes.length <= DEBUGGER_CONTROL_MAX_BYTES,
    `debugger control transcript must contain 1 through ${DEBUGGER_CONTROL_MAX_BYTES} bytes`);
  requireCondition(bytes.at(-1) === 0x0a,
    "debugger control transcript must end with exactly one newline-delimited record");
  requireCondition(!bytes.includes(0x00) && !bytes.includes(0x0d),
    "debugger control transcript contains a forbidden control byte");
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail("debugger control transcript is not valid UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  requireCondition(lines.length >= 1 && lines.length <= DEBUGGER_CONTROL_MAX_FRAMES,
    `debugger control transcript must contain 1 through ${DEBUGGER_CONTROL_MAX_FRAMES} records`);
  return lines.map((line, index) => {
    const label = `debugger control record ${index + 1}`;
    requireCondition(line.length > 0 && Buffer.byteLength(line) <= MAX_FRAME_BYTES,
      `${label} must be non-empty and at most ${MAX_FRAME_BYTES} bytes`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(`${label} is not valid JSON`);
    }
    plainObject(record, label);
    requireCondition(line === canonicalProtocolJson(record), `${label} is not canonical JSON`);
    return record;
  });
}

function validateCommon(record, expected, sequence) {
  requireCondition(record.version === DEBUGGER_CONTROL_VERSION,
    `debugger control version must be ${DEBUGGER_CONTROL_VERSION}`);
  requireCondition(typeof record.type === "string" && FRAME_TYPES.has(record.type),
    "debugger control record type is unknown");
  requireCondition(record.generation === expected.generation,
    "debugger control generation does not match the phase manifest");
  requireCondition(typeof record.manifestSha256 === "string" &&
    DIGEST_RE.test(record.manifestSha256) &&
    record.manifestSha256 === expected.manifestSha256,
  "debugger control manifest binding is invalid");
  requireCondition(record.run === expected.run,
    "debugger control run does not match its context");
  requireCondition(record.nonce === expected.nonce,
    "debugger control nonce does not match its context");
  requireCondition(record.sequence === sequence,
    "debugger control sequence must be contiguous and one-based");
}

function validateSignal(value, label) {
  requireCondition(typeof value === "string" && KNOWN_SIGNALS.has(value),
    `${label} is not a known signal`);
  return value;
}

function validateFrame(record, expected, sequence) {
  validateCommon(record, expected, sequence);
  switch (record.type) {
    case "profile-ready":
      exactKeys(record, [...COMMON_KEYS, "profileId"], "debugger profile-ready record");
      requireCondition(record.profileId === expected.profileId,
        "debugger control profile does not match the phase manifest");
      return;
    case "inferior-started":
      exactKeys(record, [...COMMON_KEYS, "pid", "startTicks", "allowedCpuList"],
        "debugger inferior-started record");
      canonicalInteger(record.pid, "debugger inferior PID", 2, MAX_PID);
      requireCondition(typeof record.startTicks === "string" &&
        START_TICKS_RE.test(record.startTicks),
      "debugger inferior start ticks are not canonical");
      requireCondition(record.allowedCpuList === expected.allowedCpuList,
        "debugger inferior did not witness the scheduled singleton CPU");
      return;
    case "inferior-stopped":
      exactKeys(record, [...COMMON_KEYS, "signal"], "debugger inferior-stopped record");
      validateSignal(record.signal, "debugger stopped signal");
      return;
    case "inferior-exited":
      exactKeys(record, [...COMMON_KEYS, "exitCode"], "debugger inferior-exited record");
      canonicalInteger(record.exitCode, "debugger inferior exit code", 0, 255);
      return;
    case "inferior-signaled":
      exactKeys(record, [...COMMON_KEYS, "signal"], "debugger inferior-signaled record");
      validateSignal(record.signal, "debugger inferior signal");
      return;
    case "capture-complete":
      exactKeys(record, [...COMMON_KEYS, "sections"], "debugger capture-complete record");
      requireCondition(canonicalProtocolJson(record.sections) ===
        canonicalProtocolJson(expected.captureSections),
      "debugger capture sections do not match the command profile");
      return;
    case "profile-error":
      exactKeys(record, [...COMMON_KEYS, "stage", "code"], "debugger profile-error record");
      requireCondition(typeof record.stage === "string" && ERROR_STAGES.has(record.stage),
        "debugger profile error stage is unknown");
      requireCondition(typeof record.code === "string" && ERROR_CODE_RE.test(record.code),
        "debugger profile error code is invalid");
      return;
    case "profile-complete":
      exactKeys(record, COMMON_KEYS, "debugger profile-complete record");
      return;
    default:
      fail("debugger control record type is unknown");
  }
}

function validateSequence(records, expected) {
  let state = "ready";
  let inferior = null;
  let terminal = null;
  let capture = null;
  let error = null;

  for (const [index, record] of records.entries()) {
    validateFrame(record, expected, index + 1);
    if (state === "ready") {
      requireCondition(record.type === "profile-ready",
        "debugger control transcript must begin with profile-ready");
      state = "launch";
      continue;
    }
    if (state === "launch") {
      if (record.type === "inferior-started") {
        inferior = {
          pid: record.pid,
          startTicks: record.startTicks,
          allowedCpuList: record.allowedCpuList,
        };
        state = "terminal";
        continue;
      }
      requireCondition(record.type === "profile-error" && record.stage === "launch",
        "debugger launch must record inferior-started or a launch-stage error");
      error = { stage: record.stage, code: record.code };
      state = "complete";
      continue;
    }
    if (state === "terminal") {
      if (record.type === "inferior-stopped") {
        terminal = { kind: "stopped", signal: record.signal };
        state = "capture";
        continue;
      }
      if (record.type === "inferior-exited") {
        terminal = { kind: "exited", exitCode: record.exitCode };
        state = "complete";
        continue;
      }
      if (record.type === "inferior-signaled") {
        terminal = { kind: "signaled", signal: record.signal };
        state = "complete";
        continue;
      }
      requireCondition(record.type === "profile-error" && record.stage === "observe",
        "debugger observation must record one terminal event or an observe-stage error");
      error = { stage: record.stage, code: record.code };
      state = "complete";
      continue;
    }
    if (state === "capture") {
      if (record.type === "capture-complete") {
        capture = { sections: [...record.sections] };
        state = "complete";
        continue;
      }
      requireCondition(record.type === "profile-error" && record.stage === "capture",
        "debugger stop must record a complete capture or a capture-stage error");
      error = { stage: record.stage, code: record.code };
      state = "complete";
      continue;
    }
    if (state === "complete") {
      requireCondition(record.type === "profile-complete",
        "debugger terminal record must be followed by profile-complete");
      state = "done";
      continue;
    }
    fail("debugger control transcript contains records after profile-complete");
  }

  requireCondition(state === "done",
    "debugger control transcript is incomplete");
  return { inferior, terminal, capture, error };
}

export function parseDebuggerControlTranscript(resolved, manifestValue, contextValue, value) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const context = parseContext(manifest, contextValue);
  const manifestBinding = debuggerPhaseManifestBinding(resolved, manifest);
  const expected = {
    generation: manifest.generation,
    manifestSha256: manifestBinding.sha256,
    run: context.run,
    nonce: context.nonce,
    profileId: manifest.debugger.commandProfile.id,
    captureSections: manifest.debugger.commandProfile.captureSections,
    allowedCpuList: String(manifest.schedule.cpu),
  };
  const bytes = exactBytes(value);
  const records = decodeRecords(bytes);
  const result = validateSequence(records, expected);
  return deepFreeze({
    version: DEBUGGER_CONTROL_VERSION,
    context: {
      generation: manifest.generation,
      manifestSha256: manifestBinding.sha256,
      run: context.run,
      nonce: context.nonce,
    },
    inferior: result.inferior,
    terminal: result.terminal,
    capture: result.capture,
    error: result.error,
    records,
    binding: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      recordCount: records.length,
    },
  });
}
