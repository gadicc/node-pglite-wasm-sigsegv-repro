// Complete-only generic debugger attempt envelopes. One envelope binds one
// supervised debugger attempt: the phase manifest and command descriptor
// bindings, the adapter's lifecycle evidence, the bounded attempt-I/O channel
// evidence, the parsed control facts, and a typed outcome. An envelope exists
// only when the attempt is complete: the adapter lifecycle succeeded, both
// channels drained completely, and the control stream parsed. Anything less
// is refused here and can never be published as complete evidence.
import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";

import {
  attemptEvidenceBinding,
  buildAttemptEvidence,
  parseAttemptEvidence,
} from "./attempt-evidence.mjs";
import { DEBUGGER_ATTEMPT_IO_VERSION } from "./debugger-attempt-io.mjs";
import {
  DEBUGGER_ATTEMPT_RUNNER_VERSION,
  debuggerAdapterWorkload,
} from "./debugger-attempt-runner.mjs";
import { buildDebuggerCommandProfile } from "./debugger-command-profile.mjs";
import { DEBUGGER_CONTROL_MAX_BYTES, DEBUGGER_CONTROL_VERSION } from "./debugger-control.mjs";
import {
  DEBUGGER_PHASE_MANIFEST_VERSION,
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";
import { canonicalProtocolJson, canonicalProtocolJsonLine } from "./pinned-protocol.mjs";

export const DEBUGGER_ATTEMPT_ENVELOPE_VERSION = 1;

const GENERATION_RE = /^[a-f0-9]{32}$/;
const NONCE_RE = /^[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const START_TICKS_RE = /^(0|[1-9][0-9]{0,31})$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,31})$/;
const MAX_PID = 2_147_483_647;
const ERROR_STAGES = new Set(["launch", "observe", "capture"]);
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));
const CHANNEL_STATUSES = new Set([
  "complete",
  "overflow",
  "stream-error",
  "storage-error",
  "invalid",
]);
const OUTCOME_KINDS = new Set(["clean", "exited", "signaled", "captured", "error"]);

export class DebuggerAttemptEnvelopeError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_ATTEMPT_ENVELOPE") {
    super(message);
    this.name = "DebuggerAttemptEnvelopeError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerAttemptEnvelopeError(message, code);
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

function canonicalClone(value) {
  return deepFreeze(JSON.parse(canonicalProtocolJson(value)));
}

function parseContext(manifest, value) {
  exactKeys(value, ["run", "nonce"], "debugger attempt envelope context");
  canonicalInteger(value.run, "debugger attempt envelope run", 1, manifest.schedule.maxRuns);
  requireCondition(typeof value.nonce === "string" && NONCE_RE.test(value.nonce),
    "debugger attempt envelope nonce must be exactly 32 lowercase hexadecimal characters");
  return { run: value.run, nonce: value.nonce };
}

function validateWorkloadBinding(resolved, value, label) {
  exactKeys(value, ["contractVersion", "id", "digest"], label);
  requireCondition(value.contractVersion === resolved.version && value.id === resolved.id &&
    value.digest === resolved.digest,
  `${label} does not match the resolved workload`);
  return value;
}

function classifyOutcome(manifest, control) {
  if (control.error !== null) {
    return {
      kind: "error",
      stage: control.error.stage,
      code: control.error.code,
    };
  }
  const targetSignals = manifest.debugger.commandProfile.targetSignals;
  if (control.terminal.kind === "exited") {
    return control.terminal.exitCode === 0
      ? { kind: "clean" }
      : { kind: "exited", exitCode: control.terminal.exitCode };
  }
  if (control.terminal.kind === "signaled") {
    return {
      kind: "signaled",
      signal: control.terminal.signal,
      target: targetSignals.includes(control.terminal.signal),
    };
  }
  return {
    kind: "captured",
    signal: control.terminal.signal,
    target: targetSignals.includes(control.terminal.signal),
    sections: [...control.capture.sections],
  };
}

function validateOutcome(manifest, control, value) {
  plainObject(value, "debugger attempt outcome");
  requireCondition(OUTCOME_KINDS.has(value.kind), "debugger attempt outcome kind is unknown");
  const expected = classifyOutcome(manifest, control);
  requireCondition(canonicalProtocolJson(value) === canonicalProtocolJson(expected),
    "debugger attempt outcome does not match the control facts");
  return value;
}

function validateChannelEvidence(value, label) {
  exactKeys(value, [
    "version", "limitBytes", "status", "errorCode", "observed", "retainedBytes",
    "overflowed",
  ], label);
  canonicalInteger(value.version, `${label}.version`, 1, Number.MAX_SAFE_INTEGER);
  canonicalInteger(value.limitBytes, `${label}.limitBytes`, 1, Number.MAX_SAFE_INTEGER);
  requireCondition(CHANNEL_STATUSES.has(value.status), `${label}.status is unknown`);
  requireCondition(value.errorCode === null ||
    (typeof value.errorCode === "string" && ERROR_CODE_RE.test(value.errorCode)),
  `${label}.errorCode is invalid`);
  requireCondition((value.status === "complete") === (value.errorCode === null),
  `${label} error code does not match its status`);
  exactKeys(value.observed, ["bytes", "sha256"], `${label}.observed`);
  requireCondition(typeof value.observed.bytes === "string" &&
    DECIMAL_RE.test(value.observed.bytes) &&
    BigInt(value.observed.bytes) <= BigInt(Number.MAX_SAFE_INTEGER),
  `${label}.observed.bytes is invalid`);
  requireCondition(typeof value.observed.sha256 === "string" &&
    DIGEST_RE.test(value.observed.sha256),
  `${label}.observed.sha256 is invalid`);
  canonicalInteger(value.retainedBytes, `${label}.retainedBytes`, 0, value.limitBytes);
  requireCondition(typeof value.overflowed === "boolean", `${label}.overflowed is invalid`);
  requireCondition(BigInt(value.retainedBytes) <= BigInt(value.observed.bytes),
  `${label} retains more bytes than it observed`);
  // A channel accepted as complete must reconcile exactly: no overflow, every
  // observed byte retained, and nothing beyond the channel limit.
  if (value.status === "complete") {
    requireCondition(value.overflowed === false,
      `${label} cannot be complete after overflow`);
    requireCondition(BigInt(value.observed.bytes) === BigInt(value.retainedBytes),
      `${label} must retain exactly the observed bytes when complete`);
    requireCondition(BigInt(value.observed.bytes) <= BigInt(value.limitBytes),
      `${label} exceeds its byte limit when complete`);
  }
  return value;
}

function validateIoEvidence(manifest, context, value) {
  exactKeys(value, ["version", "context", "transcript", "control", "complete"],
    "debugger attempt I/O evidence");
  requireCondition(value.version === DEBUGGER_ATTEMPT_IO_VERSION,
    `debugger attempt I/O evidence version must be ${DEBUGGER_ATTEMPT_IO_VERSION}`);
  exactKeys(value.context, ["generation", "manifestSha256", "run", "nonce"],
    "debugger attempt I/O context");
  requireCondition(value.context.generation === manifest.generation &&
    value.context.manifestSha256 === context.manifestSha256 &&
    value.context.run === context.run && value.context.nonce === context.nonce,
  "debugger attempt I/O context does not match the envelope context");
  validateChannelEvidence(value.transcript, "debugger attempt transcript evidence");
  validateChannelEvidence(value.control, "debugger attempt control evidence");
  requireCondition(value.transcript.version ===
    manifest.debugger.commandProfile.transcript.version &&
    value.transcript.limitBytes === manifest.debugger.commandProfile.transcript.maxBytes,
  "debugger attempt transcript evidence does not match the manifest profile");
  requireCondition(value.control.version === DEBUGGER_CONTROL_VERSION,
  "debugger attempt control evidence version is unsupported");
  requireCondition(value.control.limitBytes === DEBUGGER_CONTROL_MAX_BYTES,
  "debugger attempt control evidence limit does not match the control protocol bound");
  requireCondition(typeof value.complete === "boolean" &&
    value.complete ===
      (value.transcript.status === "complete" && value.control.status === "complete"),
  "debugger attempt I/O completeness does not reconcile");
  return value;
}

// The control channel must account for exactly the bytes the control binding
// attests: observed and retained counts equal the binding's byte count, and
// the observed digest is the binding digest.
function reconcileControlChannelEvidence(ioEvidence, controlFacts) {
  requireCondition(ioEvidence.control.observed.bytes ===
    String(controlFacts.binding.bytes) &&
    ioEvidence.control.retainedBytes === controlFacts.binding.bytes &&
    ioEvidence.control.observed.sha256 === controlFacts.binding.sha256,
  "debugger control channel evidence does not match its binding");
}

function validateControlFacts(manifest, value) {
  exactKeys(value, ["inferior", "terminal", "capture", "error", "binding"],
    "debugger attempt control facts");
  if (value.inferior !== null) {
    exactKeys(value.inferior, ["pid", "startTicks", "allowedCpuList"],
      "debugger attempt inferior identity");
    canonicalInteger(value.inferior.pid, "debugger attempt inferior PID", 2, MAX_PID);
    requireCondition(typeof value.inferior.startTicks === "string" &&
      START_TICKS_RE.test(value.inferior.startTicks),
    "debugger attempt inferior start ticks are invalid");
    requireCondition(value.inferior.allowedCpuList === String(manifest.schedule.cpu),
    "debugger attempt inferior affinity does not match the scheduled CPU");
  }
  if (value.terminal !== null) {
    plainObject(value.terminal, "debugger attempt terminal fact");
    if (value.terminal.kind === "exited") {
      exactKeys(value.terminal, ["kind", "exitCode"], "debugger attempt terminal fact");
      canonicalInteger(value.terminal.exitCode, "debugger attempt exit code", 0, 255);
    } else if (value.terminal.kind === "signaled" || value.terminal.kind === "stopped") {
      exactKeys(value.terminal, ["kind", "signal"], "debugger attempt terminal fact");
      requireCondition(typeof value.terminal.signal === "string" &&
        KNOWN_SIGNALS.has(value.terminal.signal),
      "debugger attempt terminal signal is not a known signal");
    } else {
      fail("debugger attempt terminal kind is unknown");
    }
  }
  if (value.capture !== null) {
    exactKeys(value.capture, ["sections"], "debugger attempt capture fact");
    requireCondition(canonicalProtocolJson(value.capture.sections) ===
      canonicalProtocolJson(manifest.debugger.commandProfile.captureSections),
    "debugger attempt capture sections do not match the command profile");
  }
  if (value.error !== null) {
    exactKeys(value.error, ["stage", "code"], "debugger attempt control error");
    requireCondition(ERROR_STAGES.has(value.error.stage),
      "debugger attempt control error stage is unknown");
    requireCondition(typeof value.error.code === "string" &&
      ERROR_CODE_RE.test(value.error.code),
    "debugger attempt control error code is invalid");
  }
  exactKeys(value.binding, ["sha256", "bytes", "recordCount"], "debugger control binding");
  requireCondition(typeof value.binding.sha256 === "string" &&
    DIGEST_RE.test(value.binding.sha256),
  "debugger control binding digest is invalid");
  canonicalInteger(value.binding.bytes, "debugger control binding bytes", 1,
    Number.MAX_SAFE_INTEGER);
  canonicalInteger(value.binding.recordCount, "debugger control binding record count", 1, 8);
  // The control state machine's outcome shapes, restated for facts.
  if (value.error !== null) {
    if (value.error.stage === "launch") {
      requireCondition(value.inferior === null && value.terminal === null &&
        value.capture === null,
      "debugger launch-error facts must not record an inferior or outcome");
    } else if (value.error.stage === "observe") {
      requireCondition(value.inferior !== null && value.terminal === null &&
        value.capture === null,
      "debugger observe-error facts must not record a terminal event or capture");
    } else {
      requireCondition(value.inferior !== null && value.terminal?.kind === "stopped" &&
        value.capture === null,
      "debugger capture-error facts must record a stopped inferior without a capture");
    }
  } else {
    requireCondition(value.inferior !== null && value.terminal !== null,
      "debugger control facts must record an inferior and a terminal event");
    if (value.terminal?.kind === "stopped") {
      requireCondition(value.capture !== null,
        "debugger control facts must record a capture for a stopped inferior");
    } else {
      requireCondition(value.capture === null,
        "debugger control facts must not record a capture without a stop");
    }
  }
  return value;
}

function envelopeFromParts(parts) {
  return canonicalClone(parts);
}

export function buildDebuggerAttemptEnvelope(
  resolved,
  manifestValue,
  contextValue,
  attemptValue,
) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const context = parseContext(manifest, contextValue);
  const manifestSha256 = debuggerPhaseManifestBinding(resolved, manifest).sha256;
  plainObject(attemptValue, "debugger attempt result");
  exactKeys(attemptValue, ["version", "descriptor", "adapter", "io"],
    "debugger attempt result");
  requireCondition(attemptValue.version === DEBUGGER_ATTEMPT_RUNNER_VERSION,
    "debugger attempt result version is unsupported");
  const descriptor = buildDebuggerCommandProfile(resolved, manifest, context);
  requireCondition(attemptValue.descriptor.binding.sha256 === descriptor.binding.sha256 &&
    attemptValue.descriptor.binding.bytes === descriptor.binding.bytes,
  "debugger attempt descriptor does not match the manifest and context");

  const adapterResolved = debuggerAdapterWorkload(resolved, manifest);
  const adapterEvidence = buildAttemptEvidence(adapterResolved, attemptValue.adapter);
  requireCondition(adapterEvidence.observation.terminalReason === "natural-exit" &&
    adapterEvidence.observation.exitCode === 0 &&
    adapterEvidence.observation.signal === null &&
    adapterEvidence.observation.cleanupComplete === true &&
    adapterEvidence.observation.launchErrorCode === null &&
    adapterEvidence.cleanup.failureReason === null,
  "debugger attempt adapter lifecycle is not operationally successful",
  "INCOMPLETE_DEBUGGER_ATTEMPT");

  requireCondition(attemptValue.io !== null, "debugger attempt I/O capture is missing",
    "INCOMPLETE_DEBUGGER_ATTEMPT");
  const ioEvidence = validateIoEvidence(manifest, { ...context, manifestSha256 },
    attemptValue.io.evidence);
  requireCondition(ioEvidence.complete === true,
    "debugger attempt I/O channels are not complete", "INCOMPLETE_DEBUGGER_ATTEMPT");
  requireCondition(ioEvidence.transcript.overflowed === false &&
    ioEvidence.control.overflowed === false,
  "debugger attempt channels overflowed", "INCOMPLETE_DEBUGGER_ATTEMPT");
  const control = attemptValue.io.control;
  requireCondition(control !== null, "debugger attempt control stream is not valid",
    "INCOMPLETE_DEBUGGER_ATTEMPT");
  const controlFacts = validateControlFacts(manifest, {
    inferior: control.inferior,
    terminal: control.terminal,
    capture: control.capture,
    error: control.error,
    binding: control.binding,
  });
  reconcileControlChannelEvidence(ioEvidence, controlFacts);
  requireCondition(controlFacts.terminal !== null || controlFacts.error !== null,
  "debugger attempt records neither a terminal event nor a typed error",
  "INCOMPLETE_DEBUGGER_ATTEMPT");
  const outcome = classifyOutcome(manifest, controlFacts);

  return envelopeFromParts({
    version: DEBUGGER_ATTEMPT_ENVELOPE_VERSION,
    phase: manifest.phase,
    generation: manifest.generation,
    workload: {
      contractVersion: resolved.version,
      id: resolved.id,
      digest: resolved.digest,
    },
    manifestSha256,
    run: context.run,
    nonce: context.nonce,
    descriptor: descriptor.binding,
    adapter: {
      workload: {
        contractVersion: adapterResolved.version,
        id: adapterResolved.id,
        digest: adapterResolved.digest,
      },
      binding: attemptEvidenceBinding(adapterResolved, adapterEvidence),
      evidence: adapterEvidence,
    },
    io: ioEvidence,
    control: controlFacts,
    outcome,
  });
}

export function parseDebuggerAttemptEnvelope(resolved, manifestValue, value) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const envelope = plainObject(value, "debugger attempt envelope");
  exactKeys(envelope, [
    "version", "phase", "generation", "workload", "manifestSha256", "run", "nonce",
    "descriptor", "adapter", "io", "control", "outcome",
  ], "debugger attempt envelope");
  requireCondition(envelope.version === DEBUGGER_ATTEMPT_ENVELOPE_VERSION,
    `debugger attempt envelope version must be ${DEBUGGER_ATTEMPT_ENVELOPE_VERSION}`);
  requireCondition(envelope.phase === manifest.phase &&
    typeof envelope.generation === "string" && GENERATION_RE.test(envelope.generation) &&
    envelope.generation === manifest.generation,
  "debugger attempt envelope does not belong to the phase generation");
  validateWorkloadBinding(resolved, envelope.workload, "debugger attempt workload binding");
  const manifestSha256 = debuggerPhaseManifestBinding(resolved, manifest).sha256;
  requireCondition(envelope.manifestSha256 === manifestSha256,
  "debugger attempt manifest binding is invalid");
  const context = parseContext(manifest, { run: envelope.run, nonce: envelope.nonce });
  const descriptor = buildDebuggerCommandProfile(resolved, manifest, context);
  requireCondition(canonicalProtocolJson(envelope.descriptor) ===
    canonicalProtocolJson(descriptor.binding),
  "debugger attempt descriptor binding does not match the manifest and context");

  const adapterResolved = debuggerAdapterWorkload(resolved, manifest);
  exactKeys(envelope.adapter, ["workload", "binding", "evidence"],
    "debugger attempt adapter section");
  requireCondition(canonicalProtocolJson(envelope.adapter.workload) ===
    canonicalProtocolJson({
      contractVersion: adapterResolved.version,
      id: adapterResolved.id,
      digest: adapterResolved.digest,
    }),
  "debugger attempt adapter workload binding is invalid");
  const adapterEvidence = parseAttemptEvidence(adapterResolved, envelope.adapter.evidence);
  requireCondition(canonicalProtocolJson(envelope.adapter.binding) ===
    canonicalProtocolJson(attemptEvidenceBinding(adapterResolved, adapterEvidence)),
  "debugger attempt adapter evidence binding is invalid");
  requireCondition(adapterEvidence.observation.terminalReason === "natural-exit" &&
    adapterEvidence.observation.exitCode === 0 &&
    adapterEvidence.observation.signal === null &&
    adapterEvidence.observation.cleanupComplete === true &&
    adapterEvidence.observation.launchErrorCode === null &&
    adapterEvidence.cleanup.failureReason === null,
  "debugger attempt adapter lifecycle is not operationally successful");

  const ioEvidence = validateIoEvidence(manifest, { ...context, manifestSha256 },
    envelope.io);
  requireCondition(ioEvidence.complete === true &&
    ioEvidence.transcript.overflowed === false &&
    ioEvidence.control.overflowed === false,
  "debugger attempt I/O channels are not complete");
  const controlFacts = validateControlFacts(manifest, envelope.control);
  reconcileControlChannelEvidence(ioEvidence, controlFacts);
  validateOutcome(manifest, controlFacts, envelope.outcome);
  return canonicalClone(envelope);
}

export function canonicalDebuggerAttemptEnvelopeLine(resolved, manifestValue, value) {
  return canonicalProtocolJsonLine(parseDebuggerAttemptEnvelope(resolved, manifestValue, value));
}

export function debuggerAttemptEnvelopeBinding(resolved, manifestValue, value) {
  const line = canonicalDebuggerAttemptEnvelopeLine(resolved, manifestValue, value);
  return Object.freeze({
    sha256: createHash("sha256").update(line).digest("hex"),
    bytes: line.length,
  });
}
