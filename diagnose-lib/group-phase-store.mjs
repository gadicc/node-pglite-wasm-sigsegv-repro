import { lstatSync } from "node:fs";
import path from "node:path";

import {
  assessGroupPhasePrefix,
  canonicalGroupPhaseManifestLine,
  canonicalGroupWaveEnvelopeLine,
  parseGroupPhaseManifest,
  parseGroupWaveEnvelope,
} from "./group-phase.mjs";
import {
  PinnedProtocolStateError,
  createFileStateAdapter,
} from "./pinned-protocol.mjs";

export const GROUP_PHASE_FILE = "group-phase.json";
export const GROUP_PHASE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const GROUP_WAVE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const GROUP_PHASE_STORE_MAX_WAVES = 1_000_000;
export const GROUP_PHASE_STORE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const WAVE_FILE_RE = /^group-wave-([0-9]{9})\.json$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class GroupPhaseStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "GroupPhaseStoreError";
    this.code = "INVALID_GROUP_PHASE_STORE";
  }
}

function fail(message) {
  throw new GroupPhaseStoreError(message);
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
  requireCondition(Array.isArray(names) && names.length <= GROUP_PHASE_STORE_MAX_WAVES + 1,
    "group phase store listing is invalid or oversized");
  const seen = new Set();
  for (const name of names) {
    requireCondition(typeof name === "string" && name.length > 0 && name.length <= 255 &&
      !name.includes("\0") && !name.includes("/") && name !== "." && name !== "..",
    "group phase store listing contains an unsafe file name");
    requireCondition(!seen.has(name),
      "group phase store listing contains a duplicate file name");
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

function waveFileName(ordinal) {
  requireCondition(Number.isSafeInteger(ordinal) && ordinal >= 1 &&
    ordinal <= GROUP_PHASE_STORE_MAX_WAVES,
  "group wave ordinal is out of range");
  return `group-wave-${String(ordinal).padStart(9, "0")}.json`;
}

function parseStoreNames(names) {
  let manifestPresent = false;
  const waves = [];
  for (const name of names) {
    if (name === GROUP_PHASE_FILE) {
      requireCondition(!manifestPresent, "group phase store contains a duplicate manifest");
      manifestPresent = true;
      continue;
    }
    const match = name.match(WAVE_FILE_RE);
    requireCondition(match !== null, `group phase store contains unknown file '${name}'`);
    const ordinal = Number(match[1]);
    requireCondition(Number.isSafeInteger(ordinal) && ordinal >= 1 &&
      name === waveFileName(ordinal),
    "group phase store contains a malformed wave file name");
    waves.push({ name, ordinal });
  }
  waves.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < waves.length; index += 1) {
    requireCondition(waves[index].ordinal === index + 1,
      "group phase store is not an exact contiguous wave-file prefix");
  }
  return { manifestPresent, waves };
}

function validateStoreCapacity(manifest) {
  requireCondition(manifest.schedule.waveCount <= GROUP_PHASE_STORE_MAX_WAVES,
    `group schedule exceeds the ${GROUP_PHASE_STORE_MAX_WAVES}-wave store limit`);
}

async function readStoreWithAdapter(resolved, adapter) {
  const inventory = parseStoreNames(await adapterList(adapter));
  requireCondition(inventory.manifestPresent, "group phase store manifest is missing");
  const manifestBytes = await adapterRead(adapter, GROUP_PHASE_FILE, GROUP_PHASE_FILE_MAX_BYTES);
  const manifest = parseGroupPhaseManifest(
    resolved,
    decodeJsonLine(manifestBytes, "group phase store manifest"),
  );
  validateStoreCapacity(manifest);
  requireCondition(manifestBytes.equals(canonicalGroupPhaseManifestLine(resolved, manifest)),
    "group phase store manifest is not canonical");

  const envelopes = [];
  let totalBytes = manifestBytes.length;
  for (const item of inventory.waves) {
    const bytes = await adapterRead(adapter, item.name, GROUP_WAVE_FILE_MAX_BYTES);
    totalBytes += bytes.length;
    requireCondition(totalBytes <= GROUP_PHASE_STORE_MAX_TOTAL_BYTES,
      "group phase store exceeds its aggregate byte limit");
    const envelope = parseGroupWaveEnvelope(
      resolved,
      manifest,
      decodeJsonLine(bytes, item.name),
    );
    requireCondition(envelope.wave.ordinal === item.ordinal,
      `${item.name} does not match its wave ordinal`);
    requireCondition(bytes.equals(canonicalGroupWaveEnvelopeLine(
      resolved,
      manifest,
      envelope,
    )), `${item.name} is not canonical`);
    envelopes.push(envelope);
  }
  return Object.freeze({
    manifest,
    envelopes: Object.freeze(envelopes),
    progress: assessGroupPhasePrefix(resolved, manifest, envelopes),
  });
}

function wrapStoreError(error, operation) {
  if (error instanceof GroupPhaseStoreError) throw error;
  if (error instanceof PinnedProtocolStateError || error?.code === "INVALID_GROUP_PHASE") {
    throw new GroupPhaseStoreError(`${operation}: ${error.message}`);
  }
  throw error;
}

export async function readGroupPhaseStore({ resolved, stateDir, stateAdapter }) {
  try {
    return await readStoreWithAdapter(resolved, resolveAdapter({ stateDir, stateAdapter }));
  } catch (error) {
    wrapStoreError(error, "cannot read group phase store");
  }
}

export async function initializeGroupPhaseStore({
  resolved,
  manifest: manifestValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const manifest = parseGroupPhaseManifest(resolved, manifestValue);
    validateStoreCapacity(manifest);
    const expectedBytes = canonicalGroupPhaseManifestLine(resolved, manifest);
    requireCondition(expectedBytes.length <= GROUP_PHASE_FILE_MAX_BYTES,
      "group phase manifest exceeds the store byte limit");
    const names = await adapterList(adapter);
    if (names.length === 0) {
      try {
        await adapterCommit(adapter, GROUP_PHASE_FILE, expectedBytes);
      } catch (error) {
        if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
      }
    }
    const store = await readStoreWithAdapter(resolved, adapter);
    requireCondition(expectedBytes.equals(canonicalGroupPhaseManifestLine(
      resolved,
      store.manifest,
    )), "existing group phase store belongs to a different manifest");
    return store;
  } catch (error) {
    wrapStoreError(error, "cannot initialize group phase store");
  }
}

export async function commitGroupPhaseWave({
  resolved,
  envelope: envelopeValue,
  stateDir,
  stateAdapter,
}) {
  try {
    const adapter = resolveAdapter({ stateDir, stateAdapter });
    const before = await readStoreWithAdapter(resolved, adapter);
    requireCondition(!before.progress.complete, "group phase is already complete");
    const envelope = parseGroupWaveEnvelope(resolved, before.manifest, envelopeValue);
    requireCondition(envelope.wave.ordinal === before.progress.nextWave.ordinal,
      "group wave envelope is not the exact next phase wave");
    const name = waveFileName(envelope.wave.ordinal);
    const bytes = canonicalGroupWaveEnvelopeLine(resolved, before.manifest, envelope);
    requireCondition(bytes.length <= GROUP_WAVE_FILE_MAX_BYTES,
      "group wave envelope exceeds the store byte limit");
    await adapterCommit(adapter, name, bytes);
    const after = await readStoreWithAdapter(resolved, adapter);
    requireCondition(after.progress.committedWaves === before.progress.committedWaves + 1,
      "group phase frontier did not advance by exactly one wave");
    requireCondition(bytes.equals(canonicalGroupWaveEnvelopeLine(
      resolved,
      after.manifest,
      after.envelopes.at(-1),
    )), "published group wave does not match the requested commit");
    return after;
  } catch (error) {
    wrapStoreError(error, "cannot commit group phase wave");
  }
}
