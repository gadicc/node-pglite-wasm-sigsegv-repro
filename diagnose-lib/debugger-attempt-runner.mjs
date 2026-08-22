// Parent-side generic debugger attempt runner. One debugger attempt is the
// established Node process-group supervisor pair running the stable internal
// adapter (debugger-adapter.mjs) as its supervised workload. The adapter
// receives its launch package on a private stdin payload, revalidates
// last-moment provenance for the target and the debugger, and launches the
// fixed GDB command profile shell-free. The supervisor's two output channels
// carry the combined transcript and the private control stream separately;
// both are captured by the bounded attempt-I/O layer while the adapter's own
// lifecycle stays in the attempt-runner result. Nothing here launches GDB
// directly and no public command exists.
import { fileURLToPath } from "node:url";

import { runWorkloadAttempt } from "./attempt-runner.mjs";
import { captureDebuggerAttemptIo } from "./debugger-attempt-io.mjs";
import { buildDebuggerCommandProfile } from "./debugger-command-profile.mjs";
import { parseDebuggerPhaseManifest } from "./debugger-phase.mjs";
import { canonicalProtocolJson } from "./pinned-protocol.mjs";
import {
  buildWorkloadLaunchCapsule,
  resolveWorkloadSpec,
} from "./workload-spec.mjs";

export const DEBUGGER_ATTEMPT_RUNNER_VERSION = 1;
export const DEBUGGER_ADAPTER_PACKAGE_VERSION = 1;
export const DEBUGGER_LAUNCH_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;

const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));
export const DEBUGGER_ADAPTER_PATH = fileURLToPath(
  new URL("./debugger-adapter.mjs", import.meta.url),
);

// Every module the adapter loads at startup. Each one is hashed into the
// adapter workload's launch provenance and revalidated by the supervisor
// immediately before the adapter starts.
export const DEBUGGER_ADAPTER_MODULES = Object.freeze([
  DEBUGGER_ADAPTER_PATH,
  ...[
    "workload-spec",
    "debugger-phase",
    "debugger-command-profile",
    "pinned-protocol",
    "pinned-runner",
    "pinned-concurrent-evidence",
    "individual-evidence",
  ].map((name) => `${LIB_DIR}${name}.mjs`),
]);

export class DebuggerAttemptRunnerError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_ATTEMPT") {
    super(message);
    this.name = "DebuggerAttemptRunnerError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerAttemptRunnerError(message, code);
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

// The adapter receives a single workload launch capsule as its authority:
// the exact public workload identity, the private environment values, and —
// only for HMAC-bound workloads — the environment binding key, all inside the
// private stdin payload. The adapter's own environment stays empty. Exported
// so the attempt envelope layer builds the identical adapter workload.
export function debuggerAdapterWorkload(resolved, manifest) {
  return resolveWorkloadSpec({
    version: 1,
    id: "debugger-adapter",
    label: "Generic debugger adapter",
    description: "Internal supervised adapter for one fixed GDB command-profile attempt.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: [DEBUGGER_ADAPTER_PATH],
      cwd: "/",
    },
    environment: {},
    attempt: {
      mode: "exit",
      timeoutMs: manifest.execution.runTimeoutMs,
      termGraceMs: manifest.execution.termGraceMs,
      killGraceMs: manifest.execution.killGraceMs,
    },
    outcomes: {},
    capabilities: {},
    provenance: { completeness: "complete", files: [...DEBUGGER_ADAPTER_MODULES] },
  });
}

export async function runDebuggerAttempt(
  resolved,
  manifestValue,
  contextValue,
  options = {},
) {
  requireCondition(resolved !== null && typeof resolved === "object",
    "debugger attempt requires a resolved workload");
  requireCondition(options !== null && typeof options === "object" &&
    !Array.isArray(options) &&
    Object.keys(options).every((key) => key === "signal" ||
      key === "environmentBindingKey" || key === "stdoutExcerptBytes" ||
      key === "stderrExcerptBytes"),
  "debugger attempt options must contain only: signal, environmentBindingKey, " +
    "stdoutExcerptBytes, stderrExcerptBytes");
  // Validate the manifest, context, and command profile before any process
  // exists; the adapter rebuilds the same descriptor authoritatively from the
  // launch capsule.
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const descriptor = buildDebuggerCommandProfile(resolved, manifest, contextValue);
  const capsule = buildWorkloadLaunchCapsule(resolved, {
    environmentBindingKey: options.environmentBindingKey,
  });
  const adapterResolved = debuggerAdapterWorkload(resolved, manifest);
  const payload = canonicalProtocolJson({
    version: DEBUGGER_ADAPTER_PACKAGE_VERSION,
    capsule,
    manifest,
    context: { run: contextValue.run, nonce: contextValue.nonce },
  });
  requireCondition(Buffer.byteLength(payload) <= DEBUGGER_LAUNCH_PAYLOAD_MAX_BYTES,
    `debugger adapter launch package must be at most ${DEBUGGER_LAUNCH_PAYLOAD_MAX_BYTES} bytes`,
    "DEBUGGER_LAUNCH_PAYLOAD_TOO_LARGE");

  let ioPromise = null;
  const adapter = await runWorkloadAttempt(adapterResolved, {
    signal: options.signal,
    stdinPayload: payload,
    ...(options.stdoutExcerptBytes === undefined
      ? {}
      : { stdoutExcerptBytes: options.stdoutExcerptBytes }),
    ...(options.stderrExcerptBytes === undefined
      ? {}
      : { stderrExcerptBytes: options.stderrExcerptBytes }),
    cpuAffinity: {
      cpu: manifest.schedule.cpu,
      tasksetPath: manifest.execution.tasksetPath,
    },
    streamForward({ stdout, stderr }) {
      ioPromise = captureDebuggerAttemptIo(resolved, manifest, contextValue, {
        transcript: stdout ?? [],
        control: stderr ?? [],
      });
    },
  });
  const io = ioPromise === null ? null : await ioPromise;
  return deepFreeze({
    version: DEBUGGER_ATTEMPT_RUNNER_VERSION,
    descriptor,
    adapter,
    io,
  });
}
