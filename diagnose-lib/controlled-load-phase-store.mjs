// Durable no-clobber storage for one complete-only controlled-load session.
// The schema-3 bundle owner holds the exclusive lease across execution and
// publishes the session only after A1, B, worker cleanup, recovery, and A2.
import { lstatSync } from "node:fs";
import path from "node:path";

import {
  canonicalControlledLoadSessionEnvelopeLine,
  canonicalControlledLoadSessionManifestLine,
  parseControlledLoadSessionEnvelope,
  parseControlledLoadSessionManifest,
} from "./controlled-load-session.mjs";
import {
  PinnedProtocolStateError,
  createFileStateAdapter,
} from "./pinned-protocol.mjs";

export const CONTROLLED_LOAD_PHASE_FILE = "controlled-load-phase.json";
export const CONTROLLED_LOAD_SESSION_FILE = "controlled-load-session.json";
export const CONTROLLED_LOAD_PHASE_FILE_MAX_BYTES = 1024 * 1024;
export const CONTROLLED_LOAD_SESSION_FILE_MAX_BYTES = 256 * 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ControlledLoadPhaseStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "ControlledLoadPhaseStoreError";
    this.code = "INVALID_CONTROLLED_LOAD_PHASE_STORE";
  }
}

function fail(message) {
  throw new ControlledLoadPhaseStoreError(message);
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
  requireCondition(Array.isArray(names) && names.length <= 2,
    "controlled-load phase store listing is invalid or oversized");
  const seen = new Set();
  for (const name of names) {
    requireCondition(typeof name === "string" && name.length > 0 && name.length <= 255 &&
      !name.includes("\0") && !name.includes("/") && name !== "." && name !== "..",
    "controlled-load phase store contains an unsafe file name");
    requireCondition(!seen.has(name),
      "controlled-load phase store contains a duplicate file name");
    requireCondition(name === CONTROLLED_LOAD_PHASE_FILE ||
      name === CONTROLLED_LOAD_SESSION_FILE,
    `controlled-load phase store contains unknown file '${name}'`);
    seen.add(name);
  }
  return seen;
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

function progressFor(envelope) {
  const complete = envelope !== null;
  return Object.freeze({
    status: complete ? "complete" : "empty",
    complete,
    committedSessions: complete ? 1 : 0,
    totalSessions: 1,
  });
}

async function readStoreWithAdapter(measured, auxiliary, adapter) {
  const names = await adapterList(adapter);
  requireCondition(names.has(CONTROLLED_LOAD_PHASE_FILE),
    "controlled-load phase store manifest is missing");
  const manifestBytes = await adapterRead(
    adapter,
    CONTROLLED_LOAD_PHASE_FILE,
    CONTROLLED_LOAD_PHASE_FILE_MAX_BYTES,
  );
  const manifest = parseControlledLoadSessionManifest(
    measured,
    auxiliary,
    decodeJsonLine(manifestBytes, "controlled-load phase manifest"),
  );
  requireCondition(manifestBytes.equals(canonicalControlledLoadSessionManifestLine(
    measured,
    auxiliary,
    manifest,
  )), "controlled-load phase manifest is not canonical");

  let envelope = null;
  if (names.has(CONTROLLED_LOAD_SESSION_FILE)) {
    const bytes = await adapterRead(
      adapter,
      CONTROLLED_LOAD_SESSION_FILE,
      CONTROLLED_LOAD_SESSION_FILE_MAX_BYTES,
    );
    envelope = parseControlledLoadSessionEnvelope(
      measured,
      auxiliary,
      manifest,
      decodeJsonLine(bytes, "controlled-load session envelope"),
    );
    requireCondition(bytes.equals(canonicalControlledLoadSessionEnvelopeLine(
      measured,
      auxiliary,
      manifest,
      envelope,
    )), "controlled-load session envelope is not canonical");
  }
  return Object.freeze({ manifest, envelope, progress: progressFor(envelope) });
}

function wrapStoreError(error, operation) {
  if (error instanceof ControlledLoadPhaseStoreError) throw error;
  if (error instanceof PinnedProtocolStateError ||
      error?.code === "INVALID_CONTROLLED_LOAD_SESSION") {
    throw new ControlledLoadPhaseStoreError(`${operation}: ${error.message}`);
  }
  throw error;
}

export async function readControlledLoadPhaseStore({
  measured,
  auxiliary,
  stateDir,
  stateAdapter,
}) {
  try {
    return await readStoreWithAdapter(
      measured,
      auxiliary,
      resolveAdapter({ stateDir, stateAdapter }),
    );
  } catch (error) {
    wrapStoreError(error, "cannot read controlled-load phase store");
  }
}

export async function initializeControlledLoadPhaseStore({
  measured,
  auxiliary,
  manifest: manifestValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const manifest = parseControlledLoadSessionManifest(measured, auxiliary, manifestValue);
    const expectedBytes = canonicalControlledLoadSessionManifestLine(
      measured,
      auxiliary,
      manifest,
    );
    requireCondition(expectedBytes.length <= CONTROLLED_LOAD_PHASE_FILE_MAX_BYTES,
      "controlled-load manifest exceeds the phase-store byte limit");
    const names = await adapterList(adapter);
    if (names.size === 0) {
      try {
        await adapterCommit(adapter, CONTROLLED_LOAD_PHASE_FILE, expectedBytes);
      } catch (error) {
        if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
      }
    }
    const store = await readStoreWithAdapter(measured, auxiliary, adapter);
    requireCondition(expectedBytes.equals(canonicalControlledLoadSessionManifestLine(
      measured,
      auxiliary,
      store.manifest,
    )), "existing controlled-load phase store belongs to a different manifest");
    return store;
  } catch (error) {
    wrapStoreError(error, "cannot initialize controlled-load phase store");
  }
}

export async function commitControlledLoadSession({
  measured,
  auxiliary,
  envelope: envelopeValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const before = await readStoreWithAdapter(measured, auxiliary, adapter);
    requireCondition(!before.progress.complete,
      "controlled-load phase already contains a complete session");
    const envelope = parseControlledLoadSessionEnvelope(
      measured,
      auxiliary,
      before.manifest,
      envelopeValue,
    );
    const bytes = canonicalControlledLoadSessionEnvelopeLine(
      measured,
      auxiliary,
      before.manifest,
      envelope,
    );
    requireCondition(bytes.length <= CONTROLLED_LOAD_SESSION_FILE_MAX_BYTES,
      "controlled-load session envelope exceeds the phase-store byte limit");
    await adapterCommit(adapter, CONTROLLED_LOAD_SESSION_FILE, bytes);
    const after = await readStoreWithAdapter(measured, auxiliary, adapter);
    requireCondition(after.progress.complete &&
      after.progress.committedSessions === before.progress.committedSessions + 1,
    "controlled-load phase-store frontier did not advance by exactly one session");
    requireCondition(bytes.equals(canonicalControlledLoadSessionEnvelopeLine(
      measured,
      auxiliary,
      after.manifest,
      after.envelope,
    )), "published controlled-load session does not match the requested commit");
    return after;
  } catch (error) {
    wrapStoreError(error, "cannot commit controlled-load session");
  }
}
