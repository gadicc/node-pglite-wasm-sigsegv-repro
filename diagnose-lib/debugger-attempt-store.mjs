// Durable complete-only artifacts for generic debugger attempts. One private
// state directory holds the canonical debugger phase manifest plus, per
// scheduled run, a triple of artifacts: the bounded transcript bytes, the
// canonical control bytes, and — always last — the complete-only attempt
// envelope that binds both. Publication uses the proven no-clobber state
// adapter, so a crash can only leave bounded orphan parts, which are never
// evidence; the envelope is the sole completion marker for a run.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { DEBUGGER_CONTROL_MAX_BYTES, parseDebuggerControlTranscript } from "./debugger-control.mjs";
import {
  DebuggerAttemptEnvelopeError,
  buildDebuggerAttemptEnvelope,
  canonicalDebuggerAttemptEnvelopeLine,
  debuggerAttemptEnvelopeBinding,
  parseDebuggerAttemptEnvelope,
} from "./debugger-attempt-envelope.mjs";
import {
  debuggerPhaseManifestBinding,
  canonicalDebuggerPhaseManifestLine,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";
import { runDebuggerAttempt } from "./debugger-attempt-runner.mjs";
import { canonicalProtocolJson, createFileStateAdapter } from "./pinned-protocol.mjs";

export const DEBUGGER_ATTEMPT_STORE_VERSION = 1;
export const DEBUGGER_PHASE_FILE = "debugger-phase.json";
export const DEBUGGER_PHASE_MANIFEST_STORE_MAX_BYTES = 1024 * 1024;
export const DEBUGGER_ATTEMPT_ENVELOPE_STORE_MAX_BYTES = 8 * 1024 * 1024;

const ATTEMPT_PART_RE = /^debugger-attempt-([0-9]{9})-(envelope\.json|transcript|control)$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class DebuggerAttemptStoreError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_ATTEMPT_STORE") {
    super(message);
    this.name = "DebuggerAttemptStoreError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerAttemptStoreError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function resolveAdapter(options) {
  if (options.stateAdapter !== undefined && options.stateDir !== undefined) {
    fail("choose stateAdapter or stateDir, not both");
  }
  if (options.stateAdapter !== undefined) {
    const adapter = options.stateAdapter;
    requireCondition(adapter !== null && typeof adapter === "object" &&
      typeof adapter.list === "function" && typeof adapter.read === "function" &&
      typeof adapter.commit === "function" && typeof adapter.remove === "function",
    "debugger attempt state adapter must provide list, read, commit, and remove");
    return adapter;
  }
  requireCondition(typeof options.stateDir === "string" &&
    path.isAbsolute(options.stateDir),
  "debugger attempt state directory must be an absolute path");
  return createFileStateAdapter(options.stateDir);
}

function attemptNames(run) {
  const stem = `debugger-attempt-${String(run).padStart(9, "0")}`;
  return {
    envelope: `${stem}-envelope.json`,
    transcript: `${stem}-transcript`,
    control: `${stem}-control`,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonicalLine(bytes, maxBytes, label) {
  requireCondition(bytes.length > 0 && bytes.length <= maxBytes,
    `${label} must contain 1 through ${maxBytes} bytes`);
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  requireCondition(text.endsWith("\n") && !text.includes("\r") && !text.includes("\0"),
  `${label} is not canonical newline-delimited JSON`);
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return value;
}

export function assessDebuggerAttemptProgress(resolved, manifestValue, attemptValues = []) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  requireCondition(Array.isArray(attemptValues), "debugger attempt list must be an array");
  const attempts = attemptValues.map((attempt, index) => {
    requireCondition(attempt !== null && typeof attempt === "object" &&
      Number.isSafeInteger(attempt.run) && attempt.run === index + 1,
    "debugger attempt runs must form a contiguous one-based prefix");
    return {
      run: attempt.run,
      envelope: parseDebuggerAttemptEnvelope(resolved, manifest, attempt.envelope),
    };
  });
  const committedRuns = attempts.length;
  const capturedRuns = attempts.filter((attempt) =>
    attempt.envelope.outcome.kind === "captured").length;
  const complete = committedRuns === manifest.schedule.maxRuns ||
    capturedRuns >= manifest.schedule.maxCaptures;
  return deepFreeze({
    status: committedRuns === 0 ? "empty" : complete ? "complete" : "incomplete",
    committedRuns,
    capturedRuns,
    maxRuns: manifest.schedule.maxRuns,
    maxCaptures: manifest.schedule.maxCaptures,
    complete,
    nextRun: complete ? null : committedRuns + 1,
  });
}

export async function readDebuggerPhaseStore(options) {
  const { resolved } = options;
  const adapter = resolveAdapter(options);
  const names = await adapter.list();
  const parts = new Map();
  let manifestName = null;
  const orphans = [];
  for (const name of names) {
    if (name === DEBUGGER_PHASE_FILE) {
      requireCondition(manifestName === null, "debugger phase manifest is duplicated");
      manifestName = name;
      continue;
    }
    const match = name.match(ATTEMPT_PART_RE);
    requireCondition(match !== null, `foreign debugger attempt store file '${name}'`);
    const run = Number(match[1]);
    requireCondition(Number.isSafeInteger(run) && run >= 1,
      `debugger attempt part '${name}' has an invalid run`);
    if (!parts.has(run)) parts.set(run, {});
    const entry = parts.get(run);
    const part = match[2] === "envelope.json" ? "envelope" : match[2];
    requireCondition(entry[part] === undefined,
      `debugger attempt run ${run} has a duplicate ${part} part`);
    entry[part] = name;
  }

  if (manifestName === null) {
    requireCondition(parts.size === 0,
      "debugger attempt artifacts exist without a phase manifest");
    return deepFreeze({
      version: DEBUGGER_ATTEMPT_STORE_VERSION,
      manifest: null,
      attempts: [],
      orphans: [],
      progress: null,
    });
  }

  const manifestBytes = await adapter.read(
    DEBUGGER_PHASE_FILE,
    DEBUGGER_PHASE_MANIFEST_STORE_MAX_BYTES,
  );
  const manifest = parseDebuggerPhaseManifest(
    resolved,
    decodeCanonicalLine(manifestBytes, DEBUGGER_PHASE_MANIFEST_STORE_MAX_BYTES,
      "debugger phase manifest"),
  );
  requireCondition(manifestBytes.equals(canonicalDebuggerPhaseManifestLine(resolved, manifest)),
    "debugger phase manifest is not canonical");

  const envelopeRuns = [...parts.keys()]
    .filter((run) => parts.get(run).envelope !== undefined)
    .sort((left, right) => left - right);
  for (const [run, entry] of parts.entries()) {
    if (entry.envelope === undefined) orphans.push(...Object.values(entry));
  }
  orphans.sort();
  requireCondition(envelopeRuns.every((run, index) => run === index + 1),
    "debugger attempt envelopes must form a contiguous one-based prefix");

  const attempts = [];
  for (const run of envelopeRuns) {
    const entry = parts.get(run);
    requireCondition(entry.transcript !== undefined && entry.control !== undefined,
      `debugger attempt run ${run} is missing its transcript or control part`);
    const names = attemptNames(run);
    const envelopeBytes = await adapter.read(
      names.envelope,
      DEBUGGER_ATTEMPT_ENVELOPE_STORE_MAX_BYTES,
    );
    const envelope = parseDebuggerAttemptEnvelope(resolved, manifest,
      decodeCanonicalLine(envelopeBytes, DEBUGGER_ATTEMPT_ENVELOPE_STORE_MAX_BYTES,
        `debugger attempt run ${run} envelope`));
    requireCondition(envelopeBytes.equals(
      canonicalDebuggerAttemptEnvelopeLine(resolved, manifest, envelope)),
    `debugger attempt run ${run} envelope is not canonical`);
    requireCondition(envelope.run === run,
      `debugger attempt run ${run} envelope records a different run`);

    const controlBytes = await adapter.read(names.control, DEBUGGER_CONTROL_MAX_BYTES);
    const control = parseDebuggerControlTranscript(resolved, manifest,
      { run: envelope.run, nonce: envelope.nonce }, controlBytes);
    requireCondition(canonicalProtocolJson({
      inferior: control.inferior,
      terminal: control.terminal,
      capture: control.capture,
      error: control.error,
      binding: control.binding,
    }) === canonicalProtocolJson(envelope.control),
    `debugger attempt run ${run} control bytes do not match the envelope facts`);
    requireCondition(controlBytes.length === envelope.io.control.retainedBytes &&
      sha256(controlBytes) === envelope.io.control.observed.sha256,
    `debugger attempt run ${run} control bytes do not match the channel evidence`);

    const transcriptBytes = await adapter.read(
      names.transcript,
      manifest.debugger.commandProfile.transcript.maxBytes,
    );
    requireCondition(transcriptBytes.length === envelope.io.transcript.retainedBytes &&
      sha256(transcriptBytes) === envelope.io.transcript.observed.sha256,
    `debugger attempt run ${run} transcript bytes do not match the channel evidence`);

    attempts.push({ run, envelope });
  }

  return deepFreeze({
    version: DEBUGGER_ATTEMPT_STORE_VERSION,
    manifest,
    attempts,
    orphans,
    progress: assessDebuggerAttemptProgress(resolved, manifest, attempts),
  });
}

export async function initializeDebuggerPhaseStore(options) {
  const { resolved } = options;
  const manifest = parseDebuggerPhaseManifest(resolved, options.manifest);
  const adapter = resolveAdapter(options);
  const names = await adapter.list();
  if (names.length === 0) {
    try {
      await adapter.commit(
        DEBUGGER_PHASE_FILE,
        canonicalDebuggerPhaseManifestLine(resolved, manifest),
      );
    } catch (error) {
      // A concurrent initializer may win the no-clobber race; the reread below
      // decides whether the stored manifest is the requested one.
      if (!/already exists/.test(error?.message ?? "")) throw error;
    }
  }
  const store = await readDebuggerPhaseStore(options);
  requireCondition(store.manifest !== null, "debugger phase store could not initialize");
  requireCondition(canonicalProtocolJson(store.manifest) === canonicalProtocolJson(manifest),
    "existing debugger phase store belongs to a different manifest");
  return store;
}

export async function commitDebuggerPhaseAttempt(options) {
  const { resolved } = options;
  const manifest = parseDebuggerPhaseManifest(resolved, options.manifest);
  const envelope = parseDebuggerAttemptEnvelope(resolved, manifest, options.envelope);
  const adapter = resolveAdapter(options);
  const store = await readDebuggerPhaseStore(options);
  requireCondition(store.manifest !== null,
    "debugger phase store is not initialized");
  requireCondition(canonicalProtocolJson(store.manifest) === canonicalProtocolJson(manifest),
    "debugger phase store belongs to a different manifest");
  requireCondition(store.progress.complete === false,
    "debugger attempt schedule is already complete");
  requireCondition(envelope.run === store.progress.nextRun,
    `debugger attempt run ${envelope.run} is not the exact next run`);

  const io = options.io;
  requireCondition(io !== null && typeof io === "object" && io.disposed === false,
  "debugger attempt I/O capture must be open");
  const transcriptBytes = Buffer.concat([...io.transcriptChunks()]);
  const controlBytes = io.controlTranscriptBytes();
  requireCondition(transcriptBytes.length === envelope.io.transcript.retainedBytes &&
    sha256(transcriptBytes) === envelope.io.transcript.observed.sha256,
  "debugger attempt transcript bytes do not match the envelope evidence");
  requireCondition(controlBytes.length === envelope.io.control.retainedBytes &&
    sha256(controlBytes) === envelope.io.control.observed.sha256,
  "debugger attempt control bytes do not match the envelope evidence");

  const names = attemptNames(envelope.run);
  // A crashed earlier attempt at this run can only have left bounded orphan
  // parts (the envelope is always committed last); they are never evidence.
  for (const orphan of store.orphans) {
    if (Object.values(names).includes(orphan)) await adapter.remove(orphan);
  }
  await adapter.commit(names.transcript, transcriptBytes);
  await adapter.commit(names.control, controlBytes);
  await adapter.commit(
    names.envelope,
    canonicalDebuggerAttemptEnvelopeLine(resolved, manifest, envelope),
  );
  io.dispose();

  const committed = await readDebuggerPhaseStore(options);
  requireCondition(committed.progress.committedRuns === store.progress.committedRuns + 1 &&
    committed.attempts.at(-1).run === envelope.run,
  "debugger attempt commit did not advance the run frontier");
  requireCondition(debuggerAttemptEnvelopeBinding(resolved, manifest,
    committed.attempts.at(-1).envelope).sha256 ===
    debuggerAttemptEnvelopeBinding(resolved, manifest, envelope).sha256,
  "debugger attempt committed envelope does not match the requested envelope");
  return committed;
}

// Choose and execute the next scheduled debugger run against the committed
// prefix. The caller (the schema-3 lease owner) supplies the authoritative
// attempt list and holds the exclusive bundle lease across the whole
// transaction. A fresh per-attempt nonce is generated here. An incomplete
// attempt returns a typed operational result with its process-local handle
// disposed; it never advances the durable prefix and never publishes a
// completion envelope.
export async function runNextDebuggerPhaseAttempt({
  resolved,
  manifest: manifestValue,
  attempts = [],
  runAttempt = runDebuggerAttempt,
  environmentBindingKey,
  attemptOptions,
} = {}) {
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  requireCondition(runAttempt === undefined || typeof runAttempt === "function",
    "debugger runAttempt must be a function");
  const runner = runAttempt ?? runDebuggerAttempt;
  requireCondition(attemptOptions === undefined ||
    (attemptOptions !== null && typeof attemptOptions === "object" &&
      !Array.isArray(attemptOptions) &&
      Object.keys(attemptOptions).every((key) => key === "signal" ||
        key === "stdoutExcerptBytes" || key === "stderrExcerptBytes")),
  "debugger attempt options must contain only: signal, stdoutExcerptBytes, stderrExcerptBytes");
  requireCondition(environmentBindingKey === undefined ||
    Buffer.isBuffer(environmentBindingKey),
  "debugger environmentBindingKey must be a Buffer");
  const progress = assessDebuggerAttemptProgress(resolved, manifest, attempts);
  if (progress.complete) {
    return deepFreeze({
      committed: false,
      reason: "complete",
      run: null,
      outcome: null,
      envelope: null,
      attempt: null,
    });
  }

  const context = {
    run: progress.nextRun,
    nonce: randomBytes(16).toString("hex"),
  };
  let attempt = null;
  try {
    attempt = await runner(resolved, manifest, context, {
      ...attemptOptions,
      ...(environmentBindingKey === undefined ? {} : { environmentBindingKey }),
    });
    const envelope = buildDebuggerAttemptEnvelope(resolved, manifest, context, attempt);
    return deepFreeze({
      committed: true,
      reason: "committed",
      run: context.run,
      outcome: envelope.outcome,
      envelope,
      attempt,
    });
  } catch (error) {
    if (attempt !== null && attempt.io !== null && attempt.io.disposed === false) {
      attempt.io.dispose();
    }
    if (error instanceof DebuggerAttemptEnvelopeError &&
        error.code === "INCOMPLETE_DEBUGGER_ATTEMPT") {
      return deepFreeze({
        committed: false,
        reason: "operational-invalid",
        run: context.run,
        outcome: null,
        envelope: null,
        attempt,
      });
    }
    throw error;
  }
}
