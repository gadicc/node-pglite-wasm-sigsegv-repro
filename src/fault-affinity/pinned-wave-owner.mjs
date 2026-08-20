import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runOneSchema3PinnedConcurrentWave } from "../../diagnose-lib/schema3-bundle.mjs";
import { resolveWorkloadSelection } from "../../workloads/catalog.mjs";

const OWNER_RECORD_VERSION = 1;

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 ||
      argv.some((value) => typeof value !== "string" || value.length === 0 ||
        value.includes("\0"))) {
    throw new TypeError("pinned wave owner requires bundle, selection type, and selection value");
  }
  const [bundleDir, selectionType, selectionValue] = argv;
  if (selectionType !== "built-in" && selectionType !== "custom-file") {
    throw new TypeError("pinned wave owner selection type is invalid");
  }
  return { bundleDir, selectionType, selectionValue };
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

export async function runPinnedWaveOwner(argv, io = {}) {
  const writeRecord = io.record ?? ((value) => writeSync(3, value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  const signalSource = io.signalSource ?? process;
  const controller = new AbortController();
  let receivedSignal = null;
  const handlers = new Map([
    ["SIGINT", () => { receivedSignal ??= "SIGINT"; controller.abort(); }],
    ["SIGTERM", () => { receivedSignal ??= "SIGTERM"; controller.abort(); }],
  ]);
  for (const [signal, handler] of handlers) signalSource.once(signal, handler);
  try {
    const parsed = parseArguments(argv);
    const selection = resolveWorkloadSelection(parsed.selectionType === "built-in"
      ? { workload: parsed.selectionValue }
      : { workloadFile: parsed.selectionValue });
    const execution = await runOneSchema3PinnedConcurrentWave({
      resolved: selection.resolved,
      bundleDir: parsed.bundleDir,
      attemptOptions: { signal: controller.signal },
    });
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: execution.result.committed,
      reason: execution.result.reason,
      errorCode: execution.result.errorCode ?? null,
      wave: execution.result.wave,
    })}\n`);
    return receivedSignal === null ? 0 : signalExitCode(receivedSignal);
  } catch (error) {
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: false,
      reason: "owner-error",
      errorCode: typeof error?.code === "string" ? error.code : "PINNED_WAVE_OWNER_ERROR",
      wave: null,
    })}\n`);
    stderr(`pinned wave owner: ${error?.message ?? "unknown error"}\n`);
    return receivedSignal === null ? 2 : signalExitCode(receivedSignal);
  } finally {
    for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
  }
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runPinnedWaveOwner(process.argv.slice(2));
}
