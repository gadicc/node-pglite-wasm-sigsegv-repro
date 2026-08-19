// Durable no-clobber storage for one internal exact-CPU phase. The schema-3
// bundle owner holds the exclusive lease that fences workload execution.
import { lstatSync } from "node:fs";
import path from "node:path";

import {
  assessExactCpuPhasePrefix,
  canonicalExactCpuAttemptEnvelopeLine,
  canonicalExactCpuPhaseManifestLine,
  parseExactCpuAttemptEnvelope,
  parseExactCpuPhaseManifest,
} from "./exact-cpu-phase.mjs";
import {
  PinnedProtocolStateError,
  createFileStateAdapter,
} from "./pinned-protocol.mjs";
import { MAX_SCHEDULE_ENTRIES } from "./pinned-runner.mjs";

export const EXACT_CPU_PHASE_FILE = "exact-cpu-phase.json";
export const EXACT_CPU_PHASE_FILE_MAX_BYTES = 1024 * 1024;
export const EXACT_CPU_ATTEMPT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const EXACT_CPU_PHASE_STORE_MAX_ATTEMPTS = 65_536;
export const EXACT_CPU_PHASE_STORE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const ATTEMPT_FILE_RE = /^exact-cpu-attempt-([0-9]{9})\.json$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ExactCpuPhaseStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExactCpuPhaseStoreError";
    this.code = "INVALID_EXACT_CPU_PHASE_STORE";
  }
}

function fail(message) {
  throw new ExactCpuPhaseStoreError(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  fail(`${label} must be bytes`);
}

function resolveAdapter({ stateDir, stateAdapter }) {
  requireCondition(!(stateDir !== undefined && stateAdapter !== undefined),
    "choose stateDir or stateAdapter, not both");
  if (stateDir !== undefined) {
    requireCondition(typeof stateDir === "string" && path.isAbsolute(stateDir) &&
      !stateDir.includes("\0"), "stateDir must be an absolute NUL-free path");
    let stat;
    try {
      stat = lstatSync(stateDir, { bigint: true });
    } catch {
      fail("stateDir is missing or could not be inspected");
    }
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    requireCondition(stat.isDirectory() && (uid === null || stat.uid === uid) &&
      (stat.mode & 0o077n) === 0n,
    "stateDir must be a real private directory owned by the current user");
  }
  const adapter = stateAdapter ??
    (stateDir === undefined ? null : createFileStateAdapter(stateDir));
  requireCondition(adapter !== null && typeof adapter === "object" &&
    typeof adapter.list === "function" && typeof adapter.read === "function" &&
    typeof adapter.commit === "function",
  "a stateDir or stateAdapter is required");
  return adapter;
}

async function adapterList(adapter) {
  const names = await adapter.list();
  requireCondition(Array.isArray(names) &&
    names.length <= EXACT_CPU_PHASE_STORE_MAX_ATTEMPTS + 1,
    "phase store listing is invalid or oversized");
  const seen = new Set();
  for (const name of names) {
    requireCondition(typeof name === "string" && name.length > 0 && name.length <= 255 &&
      !name.includes("\0") && !name.includes("/") && name !== "." && name !== "..",
    "phase store listing contains an unsafe file name");
    requireCondition(!seen.has(name), "phase store listing contains a duplicate file name");
    seen.add(name);
  }
  return names;
}

async function adapterRead(adapter, name, maxBytes) {
  const bytes = exactBytes(await adapter.read(name, maxBytes), `${name} content`);
  requireCondition(bytes.length > 0 && bytes.length <= maxBytes,
    `${name} is empty or exceeds its byte limit`);
  return bytes;
}

async function adapterCommit(adapter, name, bytes) {
  await adapter.commit(name, exactBytes(bytes, `${name} content`));
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

function attemptFileName(ordinal) {
  requireCondition(Number.isSafeInteger(ordinal) && ordinal >= 1 &&
    ordinal <= MAX_SCHEDULE_ENTRIES, "attempt ordinal is out of range");
  return `exact-cpu-attempt-${String(ordinal).padStart(9, "0")}.json`;
}

function parseStoreNames(names) {
  let manifestPresent = false;
  const attempts = [];
  for (const name of names) {
    if (name === EXACT_CPU_PHASE_FILE) {
      requireCondition(!manifestPresent, "phase store contains a duplicate manifest");
      manifestPresent = true;
      continue;
    }
    const match = name.match(ATTEMPT_FILE_RE);
    requireCondition(match !== null, `phase store contains unknown file '${name}'`);
    const ordinal = Number(match[1]);
    requireCondition(Number.isSafeInteger(ordinal) && ordinal >= 1 &&
      name === attemptFileName(ordinal), "phase store contains a malformed attempt file name");
    attempts.push({ name, ordinal });
  }
  attempts.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < attempts.length; index += 1) {
    requireCondition(attempts[index].ordinal === index + 1,
      "phase store is not an exact contiguous attempt-file prefix");
  }
  return { manifestPresent, attempts };
}

function validateStoreCapacity(manifest) {
  requireCondition(manifest.schedule.attemptCount <= EXACT_CPU_PHASE_STORE_MAX_ATTEMPTS,
    `phase schedule exceeds the ${EXACT_CPU_PHASE_STORE_MAX_ATTEMPTS}-attempt store limit`);
}

async function readStoreWithAdapter(resolved, adapter) {
  const inventory = parseStoreNames(await adapterList(adapter));
  requireCondition(inventory.manifestPresent, "phase store manifest is missing");
  const manifestBytes = await adapterRead(
    adapter,
    EXACT_CPU_PHASE_FILE,
    EXACT_CPU_PHASE_FILE_MAX_BYTES,
  );
  const manifestValue = decodeJsonLine(manifestBytes, "phase store manifest");
  const manifest = parseExactCpuPhaseManifest(resolved, manifestValue);
  validateStoreCapacity(manifest);
  requireCondition(manifestBytes.equals(canonicalExactCpuPhaseManifestLine(resolved, manifest)),
    "phase store manifest is not canonical");

  const envelopes = [];
  let totalBytes = manifestBytes.length;
  for (const item of inventory.attempts) {
    const bytes = await adapterRead(adapter, item.name, EXACT_CPU_ATTEMPT_FILE_MAX_BYTES);
    totalBytes += bytes.length;
    requireCondition(totalBytes <= EXACT_CPU_PHASE_STORE_MAX_TOTAL_BYTES,
      "phase store exceeds its aggregate byte limit");
    const value = decodeJsonLine(bytes, item.name);
    const envelope = parseExactCpuAttemptEnvelope(resolved, manifest, value);
    requireCondition(envelope.slot.ordinal === item.ordinal,
      `${item.name} does not match its attempt ordinal`);
    requireCondition(bytes.equals(canonicalExactCpuAttemptEnvelopeLine(
      resolved,
      manifest,
      envelope,
    )), `${item.name} is not canonical`);
    envelopes.push(envelope);
  }
  const progress = assessExactCpuPhasePrefix(resolved, manifest, envelopes);
  return Object.freeze({
    manifest,
    envelopes: Object.freeze(envelopes),
    progress,
  });
}

function wrapStoreError(error, operation) {
  if (error instanceof ExactCpuPhaseStoreError) throw error;
  if (error instanceof PinnedProtocolStateError || error?.code === "INVALID_EXACT_CPU_PHASE") {
    throw new ExactCpuPhaseStoreError(`${operation}: ${error.message}`);
  }
  throw error;
}

export async function readExactCpuPhaseStore({ resolved, stateDir, stateAdapter }) {
  try {
    return await readStoreWithAdapter(resolved, resolveAdapter({ stateDir, stateAdapter }));
  } catch (error) {
    wrapStoreError(error, "cannot read exact-CPU phase store");
  }
}

export async function initializeExactCpuPhaseStore({
  resolved,
  manifest: manifestValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const manifest = parseExactCpuPhaseManifest(resolved, manifestValue);
    validateStoreCapacity(manifest);
    const expectedBytes = canonicalExactCpuPhaseManifestLine(resolved, manifest);
    requireCondition(expectedBytes.length <= EXACT_CPU_PHASE_FILE_MAX_BYTES,
      "phase manifest exceeds the phase-store byte limit");
    const names = await adapterList(adapter);
    if (names.length === 0) {
      try {
        await adapterCommit(adapter, EXACT_CPU_PHASE_FILE, expectedBytes);
      } catch (error) {
        // A concurrent initializer may have won the no-clobber publication
        // point. The complete reread below accepts only the exact same phase.
        if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
      }
    }
    const store = await readStoreWithAdapter(resolved, adapter);
    requireCondition(expectedBytes.equals(canonicalExactCpuPhaseManifestLine(
      resolved,
      store.manifest,
    )), "existing phase store belongs to a different manifest");
    return store;
  } catch (error) {
    wrapStoreError(error, "cannot initialize exact-CPU phase store");
  }
}

export async function commitExactCpuPhaseAttempt({
  resolved,
  envelope: envelopeValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const before = await readStoreWithAdapter(resolved, adapter);
    requireCondition(!before.progress.complete, "exact-CPU phase is already complete");
    const envelope = parseExactCpuAttemptEnvelope(
      resolved,
      before.manifest,
      envelopeValue,
    );
    requireCondition(envelope.slot.ordinal === before.progress.nextSlot.ordinal,
      "attempt envelope is not the exact next phase slot");
    const name = attemptFileName(envelope.slot.ordinal);
    const bytes = canonicalExactCpuAttemptEnvelopeLine(resolved, before.manifest, envelope);
    requireCondition(bytes.length <= EXACT_CPU_ATTEMPT_FILE_MAX_BYTES,
      "attempt envelope exceeds the phase-store byte limit");
    await adapterCommit(adapter, name, bytes);
    const after = await readStoreWithAdapter(resolved, adapter);
    requireCondition(after.progress.committedAttempts === before.progress.committedAttempts + 1,
      "phase-store frontier did not advance by exactly one attempt");
    requireCondition(bytes.equals(canonicalExactCpuAttemptEnvelopeLine(
      resolved,
      after.manifest,
      after.envelopes.at(-1),
    )), "published attempt envelope does not match the requested commit");
    return after;
  } catch (error) {
    wrapStoreError(error, "cannot commit exact-CPU phase attempt");
  }
}
