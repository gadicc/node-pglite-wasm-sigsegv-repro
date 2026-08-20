import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";

import {
  debuggerPhaseManifestBinding,
  parseDebuggerPhaseManifest,
} from "./debugger-phase.mjs";
import {
  canonicalProtocolJson,
  canonicalProtocolJsonLine,
} from "./pinned-protocol.mjs";
import { workloadLaunchProvenance } from "./workload-spec.mjs";

export const DEBUGGER_COMMAND_DESCRIPTOR_VERSION = 1;
export const DEBUGGER_COMMAND_MAX_BYTES = 1024 * 1024;
export const DEBUGGER_COMMAND_MAX_ARGUMENTS = 4_128;
export const DEBUGGER_COMMAND_MAX_ARGUMENT_BYTES = 128 * 1024;

const NONCE_RE = /^[a-f0-9]{32}$/;
const PYTHON_EXEC_PREFIX = "--eval-command=python exec(";
const PYTHON_DRIVER_MARKER = "# GDB driver: only the section below imports gdb.";
const CONFIG_LINE_RE =
  /^CONFIG = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\.decode\("utf-8"\)\)$/m;
const CONFIG_KEYS = Object.freeze([
  "allowedCpuList",
  "captureCommands",
  "captureSections",
  "generation",
  "knownSignals",
  "manifestSha256",
  "nonce",
  "profileId",
  "run",
  "targetDigest",
  "targetId",
  "targetSignals",
]);

// The control protocol accepts exactly the signal names the local Node runtime
// publishes; embedding that table keeps the emitted records inside the parser's
// known-signal set instead of inventing a second signal taxonomy.
const KNOWN_SIGNALS = Object.freeze(Object.keys(osConstants.signals).sort());

// The capture sections bound by the phase manifest map to these fixed GDB
// commands. The profile never executes any other command text.
const CAPTURE_COMMANDS = Object.freeze({
  stop: "info program",
  backtrace: "thread apply all backtrace full",
  registers: "info registers",
  instructions: "x/16i $pc",
  threads: "info threads",
  mappings: "info proc mappings",
});

export class DebuggerCommandProfileError extends Error {
  constructor(message, code = "INVALID_DEBUGGER_COMMAND_PROFILE") {
    super(message);
    this.name = "DebuggerCommandProfileError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new DebuggerCommandProfileError(message, code);
}

function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function exactKeys(value, expected, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]),
  `${label} must contain exactly: ${wanted.join(", ")}`);
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
  exactKeys(value, ["run", "nonce"], "debugger command context");
  requireCondition(Number.isSafeInteger(value.run) && value.run >= 1 &&
    value.run <= manifest.schedule.maxRuns,
  `debugger command run must be an integer from 1 through ${manifest.schedule.maxRuns}`);
  requireCondition(typeof value.nonce === "string" && NONCE_RE.test(value.nonce),
    "debugger command nonce must be exactly 32 lowercase hexadecimal characters");
  return { run: value.run, nonce: value.nonce };
}

function captureCommandsFor(sections) {
  return Object.fromEntries(sections.map((section) => {
    requireCondition(Object.hasOwn(CAPTURE_COMMANDS, section),
      `debugger capture section '${section}' has no fixed command`);
    return [section, CAPTURE_COMMANDS[section]];
  }));
}

function pythonConfig(manifest, context, manifestSha256, resolved, capture) {
  return {
    generation: manifest.generation,
    manifestSha256,
    run: context.run,
    nonce: context.nonce,
    profileId: manifest.debugger.commandProfile.id,
    allowedCpuList: String(manifest.schedule.cpu),
    targetSignals: [...manifest.debugger.commandProfile.targetSignals],
    captureSections: capture.sections,
    captureCommands: capture.commands,
    targetId: resolved.id,
    targetDigest: resolved.digest,
    knownSignals: [...KNOWN_SIGNALS],
  };
}

// The generated Python profile is fixed text parameterized only by the
// canonical JSON config above. The prelude (imports, config decode, and the
// canonical control emitter) never imports gdb, so synthetic tests can execute
// it standalone with fd 3 redirected; the driver section implements the
// debugger-control.mjs state machine and nothing else.
function pythonSource(config) {
  const encodedConfig = Buffer.from(canonicalProtocolJson(config), "utf8").toString("base64");
  return `import base64
import json
import os

CONFIG = json.loads(base64.b64decode("${encodedConfig}").decode("utf-8"))
CONTROL_FD = 3
SEQUENCE = 0

def emit(record_type, **fields):
    global SEQUENCE
    SEQUENCE += 1
    record = {
        "version": 1,
        "type": record_type,
        "generation": CONFIG["generation"],
        "manifestSha256": CONFIG["manifestSha256"],
        "run": CONFIG["run"],
        "nonce": CONFIG["nonce"],
        "sequence": SEQUENCE,
    }
    record.update(fields)
    data = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\\n").encode("ascii")
    offset = 0
    while offset < len(data):
        written = os.write(CONTROL_FD, data[offset:])
        if written <= 0:
            raise RuntimeError("control write made no progress")
        offset += written

${PYTHON_DRIVER_MARKER}
import re
import signal

import gdb

STOP_EVENTS = []
EXIT_EVENTS = []
DIGITS_RE = re.compile(r"^[0-9]+$")
KNOWN_SIGNALS = frozenset(CONFIG["knownSignals"])

def on_stop(event):
    STOP_EVENTS.append(event)

def on_exit(event):
    EXIT_EVENTS.append(event)

def proc_identity(pid):
    with open("/proc/%d/stat" % pid, "r", encoding="ascii") as handle:
        stat_line = handle.read()
    close_paren = stat_line.rfind(")")
    if close_paren < 0:
        raise RuntimeError("process stat has no command terminator")
    stat_fields = stat_line[close_paren + 2:].split()
    if len(stat_fields) <= 19 or DIGITS_RE.match(stat_fields[19]) is None:
        raise RuntimeError("process stat has no canonical start ticks")
    start_ticks = str(int(stat_fields[19]))
    if len(start_ticks) > 32:
        raise RuntimeError("process stat start ticks exceed the protocol bound")
    allowed = None
    with open("/proc/%d/status" % pid, "r", encoding="ascii") as handle:
        for line in handle:
            if line.startswith("Cpus_allowed_list:"):
                allowed = line.split(":", 1)[1].strip()
                break
    if allowed != CONFIG["allowedCpuList"]:
        raise RuntimeError("inferior affinity does not match the scheduled CPU")
    return start_ticks, allowed

def exit_signal_name():
    try:
        value = str(gdb.parse_and_eval("$_exitsignal")).strip()
    except Exception:
        return None
    if value in KNOWN_SIGNALS:
        return value
    try:
        name = signal.Signals(int(value, 10)).name
    except Exception:
        return None
    return name if name in KNOWN_SIGNALS else None

def observe_events():
    gdb.events.stop.connect(on_stop)
    gdb.events.exited.connect(on_exit)
    try:
        try:
            gdb.execute("continue", to_string=False)
        except Exception:
            pass
    finally:
        try:
            gdb.events.stop.disconnect(on_stop)
        except Exception:
            pass
        try:
            gdb.events.exited.disconnect(on_exit)
        except Exception:
            pass

def run_profile():
    # The control descriptor must never leak into the inferior.
    os.set_inheritable(CONTROL_FD, False)
    emit("profile-ready", profileId=CONFIG["profileId"])
    try:
        try:
            for signal_name in CONFIG["targetSignals"]:
                gdb.execute("handle %s stop print nopass" % signal_name, to_string=False)
            gdb.execute("starti", to_string=False)
            pid = int(gdb.selected_inferior().pid)
            if pid <= 1:
                raise RuntimeError("inferior has no stable process identity")
            start_ticks, allowed = proc_identity(pid)
            emit("inferior-started", pid=pid, startTicks=start_ticks,
                 allowedCpuList=allowed)
        except Exception:
            emit("profile-error", stage="launch", code="GDB_LAUNCH_ERROR")
            return

        try:
            observe_events()
        except Exception:
            emit("profile-error", stage="observe", code="GDB_OBSERVE_ERROR")
            return
        if len(STOP_EVENTS) + len(EXIT_EVENTS) != 1:
            emit("profile-error", stage="observe", code="GDB_OBSERVE_ERROR")
            return

        if STOP_EVENTS:
            try:
                stop_signal = STOP_EVENTS[0].stop_signal
            except Exception:
                stop_signal = None
            if not isinstance(stop_signal, str) or stop_signal not in KNOWN_SIGNALS:
                emit("profile-error", stage="observe", code="GDB_OBSERVE_ERROR")
                return
            emit("inferior-stopped", signal=stop_signal)
            try:
                for section in CONFIG["captureSections"]:
                    gdb.execute(CONFIG["captureCommands"][section], to_string=False)
                emit("capture-complete", sections=CONFIG["captureSections"])
            except Exception:
                emit("profile-error", stage="capture", code="GDB_CAPTURE_ERROR")
            return

        try:
            exit_code = EXIT_EVENTS[0].exit_code
        except Exception:
            exit_code = None
        if isinstance(exit_code, int) and not isinstance(exit_code, bool) and \\
                0 <= exit_code <= 255:
            emit("inferior-exited", exitCode=exit_code)
            return
        signal_name = exit_signal_name()
        if signal_name is not None:
            emit("inferior-signaled", signal=signal_name)
            return
        emit("profile-error", stage="observe", code="GDB_OBSERVE_ERROR")
    finally:
        try:
            gdb.execute("kill", to_string=False)
        except Exception:
            pass
        emit("profile-complete")

try:
    run_profile()
except BaseException:
    # A broken control channel cannot be reported; still release the inferior.
    try:
        gdb.execute("kill", to_string=False)
    except Exception:
        pass
    raise
`;
}

// Fixed shell-free GDB invocation: no init files, no auto-loading or
// downloads, noninteractive, no startup shell, and exactly one embedded Python
// profile. Nothing after --args is interpreted by GDB.
function fixedDebuggerArguments(source) {
  return [
    "--quiet",
    "--nx",
    "--nh",
    "--batch",
    "--init-eval-command=set auto-load off",
    "--init-eval-command=set debuginfod enabled off",
    "--eval-command=set pagination off",
    "--eval-command=set confirm off",
    "--eval-command=set print thread-events off",
    "--eval-command=set startup-with-shell off",
    `${PYTHON_EXEC_PREFIX}${JSON.stringify(source)})`,
  ];
}

export function buildDebuggerCommandProfile(resolved, manifestValue, contextValue) {
  workloadLaunchProvenance(resolved);
  const manifest = parseDebuggerPhaseManifest(resolved, manifestValue);
  const context = parseContext(manifest, contextValue);
  const manifestSha256 = debuggerPhaseManifestBinding(resolved, manifest).sha256;
  const profile = manifest.debugger.commandProfile;
  const capture = {
    sections: [...profile.captureSections],
    commands: captureCommandsFor(profile.captureSections),
  };
  const config = pythonConfig(manifest, context, manifestSha256, resolved, capture);
  const source = pythonSource(config);
  const args = [
    ...fixedDebuggerArguments(source),
    "--args",
    resolved.command.executable.path,
    ...resolved.command.args,
  ];
  // The count bound is a guard for future fixed-argument growth: the workload
  // contract already caps target arguments at 4096, keeping the total below
  // this limit by construction.
  requireCondition(args.length <= DEBUGGER_COMMAND_MAX_ARGUMENTS,
    `debugger command must contain at most ${DEBUGGER_COMMAND_MAX_ARGUMENTS} arguments`,
    "DEBUGGER_COMMAND_TOO_LARGE");
  // execve rejects any single argument at or beyond MAX_ARG_STRLEN (128 KiB).
  for (const [index, argument] of args.entries()) {
    requireCondition(Buffer.byteLength(argument, "utf8") < DEBUGGER_COMMAND_MAX_ARGUMENT_BYTES,
      `debugger command argument ${index} exceeds the per-argument byte limit`,
      "DEBUGGER_COMMAND_TOO_LARGE");
  }

  const identity = {
    version: DEBUGGER_COMMAND_DESCRIPTOR_VERSION,
    profileId: profile.id,
    context: {
      generation: manifest.generation,
      manifestSha256,
      run: context.run,
      nonce: context.nonce,
    },
    workload: {
      id: resolved.id,
      digest: resolved.digest,
    },
    schedule: {
      cpu: manifest.schedule.cpu,
      allowedCpuList: String(manifest.schedule.cpu),
    },
    targetSignals: [...profile.targetSignals],
    capture,
    command: {
      executable: manifest.debugger.executable.path,
      args,
      cwd: resolved.command.cwd,
    },
  };
  // The identity line is the hashed content; the bound covers the complete
  // serialized descriptor including its binding.
  const identityBytes = canonicalProtocolJsonLine(identity);
  const descriptor = {
    ...identity,
    binding: {
      sha256: createHash("sha256").update(identityBytes).digest("hex"),
      bytes: identityBytes.length,
    },
  };
  requireCondition(canonicalProtocolJsonLine(descriptor).length <= DEBUGGER_COMMAND_MAX_BYTES,
    `debugger command descriptor must be at most ${DEBUGGER_COMMAND_MAX_BYTES} bytes`,
    "DEBUGGER_COMMAND_TOO_LARGE");
  return canonicalClone(descriptor);
}

// Extract and verify the embedded Python profile and its decoded config from a
// built descriptor. This is inspection-only; it never executes anything.
export function debuggerCommandProfileEmbedded(descriptor) {
  exactKeys(descriptor, [
    "binding", "capture", "command", "context", "profileId", "schedule",
    "targetSignals", "version", "workload",
  ], "debugger command descriptor");
  exactKeys(descriptor.command, ["args", "cwd", "executable"], "debugger command");
  const matches = descriptor.command.args.filter((argument) =>
    typeof argument === "string" && argument.startsWith(PYTHON_EXEC_PREFIX) &&
    argument.endsWith(")"));
  requireCondition(matches.length === 1,
    "debugger command must embed exactly one Python profile");
  const encoded = matches[0].slice(PYTHON_EXEC_PREFIX.length, -1);
  let source;
  try {
    source = JSON.parse(encoded);
  } catch {
    fail("embedded Python profile is not canonical JSON string data");
  }
  requireCondition(typeof source === "string" && JSON.stringify(source) === encoded,
    "embedded Python profile does not round-trip its encoding");
  const configMatch = source.match(CONFIG_LINE_RE);
  requireCondition(configMatch !== null,
    "embedded Python profile is missing its canonical config");
  let config;
  try {
    config = JSON.parse(Buffer.from(configMatch[1], "base64").toString("utf-8"));
  } catch {
    fail("embedded Python config is not valid base64-encoded JSON");
  }
  exactKeys(config, CONFIG_KEYS, "embedded Python config");
  requireCondition(config.generation === descriptor.context.generation &&
    config.manifestSha256 === descriptor.context.manifestSha256 &&
    config.run === descriptor.context.run &&
    config.nonce === descriptor.context.nonce &&
    config.profileId === descriptor.profileId &&
    config.allowedCpuList === descriptor.schedule.allowedCpuList &&
    config.targetId === descriptor.workload.id &&
    config.targetDigest === descriptor.workload.digest &&
    canonicalProtocolJson(config.targetSignals) ===
      canonicalProtocolJson(descriptor.targetSignals) &&
    canonicalProtocolJson(config.captureSections) ===
      canonicalProtocolJson(descriptor.capture.sections) &&
    canonicalProtocolJson(config.captureCommands) ===
      canonicalProtocolJson(descriptor.capture.commands) &&
    canonicalProtocolJson(config.knownSignals) === canonicalProtocolJson(KNOWN_SIGNALS),
  "embedded Python config does not match the descriptor bindings");
  requireCondition(source.includes(PYTHON_DRIVER_MARKER),
    "embedded Python profile is missing its GDB driver marker");
  return deepFreeze({ source, config: canonicalClone(config) });
}
