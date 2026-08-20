import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CPU_ID } from "../diagnose-lib/pinned-runner.mjs";

const OWNER_PATH = fileURLToPath(new URL("./pinned-wave-owner.mjs", import.meta.url));
const MAX_OWNER_OUTPUT_BYTES = 64 * 1024;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const OWNER_RECORD_REASONS = new Set([
  "committed",
  "complete",
  "controller-invalid",
  "runner-error",
  "operational-invalid",
  "owner-error",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class PinnedWaveProcessError extends Error {
  constructor(message, code = "PINNED_WAVE_PROCESS_ERROR") {
    super(message);
    this.name = "PinnedWaveProcessError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new PinnedWaveProcessError(message, code);
}

function selectionArguments(selection) {
  if (selection?.source === "built-in") {
    return ["built-in", selection.resolved.id];
  }
  if (selection?.source === "custom-file" &&
      typeof selection.metadata?.file === "string") {
    return ["custom-file", selection.metadata.file];
  }
  fail("pinned wave selection is invalid");
}

function appendBounded(chunks, state, chunk, label, child) {
  state.bytes += chunk.length;
  if (state.bytes > MAX_OWNER_OUTPUT_BYTES) {
    child.kill("SIGTERM");
    fail(`pinned wave owner ${label} exceeded ${MAX_OWNER_OUTPUT_BYTES} bytes`,
      "PINNED_WAVE_OUTPUT_LIMIT");
  }
  chunks.push(chunk);
}

function parseOwnerRecord(bytes) {
  let text;
  try {
    text = UTF8_DECODER.decode(Buffer.concat(bytes));
  } catch {
    fail("pinned wave owner record is not valid UTF-8", "PINNED_WAVE_RECORD_INVALID");
  }
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    const newlineCount = [...text].filter((character) => character === "\n").length;
    fail("pinned wave owner did not emit exactly one newline-terminated record " +
      `(bytes=${Buffer.byteLength(text)}, newlines=${newlineCount})`,
      "PINNED_WAVE_RECORD_INVALID");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("pinned wave owner record is not valid JSON", "PINNED_WAVE_RECORD_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail("pinned wave owner record must be an object", "PINNED_WAVE_RECORD_INVALID");
  }
  const keys = Object.keys(value).sort();
  const expected = ["committed", "errorCode", "reason", "version", "wave"].sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) || value.version !== 1 ||
      typeof value.committed !== "boolean" ||
      !OWNER_RECORD_REASONS.has(value.reason) ||
      !(value.errorCode === null ||
        (typeof value.errorCode === "string" && ERROR_CODE_RE.test(value.errorCode))) ||
      !(value.wave === null ||
        (typeof value.wave === "object" && !Array.isArray(value.wave) &&
          Number.isSafeInteger(value.wave.ordinal) && value.wave.ordinal >= 1)) ||
      (value.committed !== (value.reason === "committed")) ||
      (value.committed && (value.wave === null || value.errorCode !== null)) ||
      (value.reason === "complete" && value.wave !== null) ||
      (value.reason === "owner-error" && value.wave !== null)) {
    fail("pinned wave owner record has an invalid shape", "PINNED_WAVE_RECORD_INVALID");
  }
  return Object.freeze(value);
}

function waitForChild(child, signal) {
  return new Promise((resolve, reject) => {
    const control = [];
    const stderr = [];
    const controlState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let outputError = null;
    const onAbort = () => child.kill("SIGTERM");
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    child.stdio[3].on("data", (chunk) => {
      if (outputError !== null) return;
      try {
        appendBounded(control, controlState, chunk, "control record", child);
      } catch (error) {
        outputError = error;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (outputError !== null) return;
      try {
        appendBounded(stderr, stderrState, chunk, "stderr", child);
      } catch (error) {
        outputError = error;
      }
    });
    child.once("error", settleReject);
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (outputError !== null) {
        reject(outputError);
        return;
      }
      let record;
      try {
        record = parseOwnerRecord(control);
      } catch (error) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        error.message = `${error.message}; owner exit=${code ?? "null"} ` +
          `signal=${childSignal ?? "null"}`;
        if (diagnostic.length > 0) {
          error.message = `${error.message}: ${diagnostic}`;
        }
        reject(error);
        return;
      }
      resolve(Object.freeze({
        record,
        code,
        signal: childSignal,
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function runPinnedWaveProcess({
  selection,
  bundleDir,
  controllerCpu,
  tasksetPath,
  signal,
  spawnProcess = spawn,
}) {
  if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir) ||
      bundleDir.includes("\0") || Buffer.byteLength(bundleDir) > 16 * 1024 ||
      !Number.isSafeInteger(controllerCpu) || controllerCpu < 0 ||
      controllerCpu > MAX_CPU_ID ||
      typeof tasksetPath !== "string" || !path.isAbsolute(tasksetPath) ||
      tasksetPath.includes("\0") || Buffer.byteLength(tasksetPath) > 16 * 1024 ||
      typeof spawnProcess !== "function") {
    fail("pinned wave process options are invalid");
  }
  const child = spawnProcess(tasksetPath, [
    "-c",
    String(controllerCpu),
    process.execPath,
    OWNER_PATH,
    bundleDir,
    ...selectionArguments(selection),
  ], {
    cwd: "/",
    env: {},
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  return await waitForChild(child, signal);
}
