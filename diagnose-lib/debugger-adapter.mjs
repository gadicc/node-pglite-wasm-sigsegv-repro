#!/usr/bin/env node
// Internal supervised debugger adapter. This process is the workload the
// established Node attempt supervisor launches for one generic debugger
// attempt. It receives a small launch package on stdin, revalidates every
// last-moment provenance guarantee, then launches the fixed GDB command
// profile shell-free. GDB stdout and stderr are forwarded together to this
// process's stdout (the transcript channel); the profile's private control fd
// is forwarded to this process's stderr (the control channel). The adapter
// never interprets control bytes and never exposes target environment values
// in its own environment: the target environment is resolved locally and
// applied only to the GDB child.
import { spawn } from "node:child_process";
import { once } from "node:events";

import { buildDebuggerCommandProfile } from "./debugger-command-profile.mjs";
import {
  parseDebuggerPhaseManifest,
  verifyDebuggerPhaseLaunchProvenance,
} from "./debugger-phase.mjs";
import {
  resolveWorkloadSpec,
  verifyWorkloadProvenance,
  workloadLaunchEnvironment,
} from "./workload-spec.mjs";

const PACKAGE_VERSION = 1;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function normalizeErrorCode(error, fallback) {
  return typeof error?.code === "string" && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function adapterErrorLine(error) {
  const code = normalizeErrorCode(error, "DEBUGGER_ADAPTER_ERROR");
  const message = String(error?.message ?? "unknown error")
    .replace(/[\t\n\r]+/g, " ")
    .slice(0, 512);
  return `DEBUGGER_ADAPTER_ERROR\t${code}\t${message}\n`;
}

async function readPackage() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_PACKAGE_BYTES) {
      fail("DEBUGGER_ADAPTER_PACKAGE_INVALID",
        "debugger adapter launch package exceeds its byte bound");
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    fail("DEBUGGER_ADAPTER_PACKAGE_INVALID",
      "debugger adapter launch package is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail("DEBUGGER_ADAPTER_PACKAGE_INVALID",
      "debugger adapter launch package must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "context,manifest,version,workloadSpec" ||
      value.version !== PACKAGE_VERSION) {
    fail("DEBUGGER_ADAPTER_PACKAGE_INVALID",
      "debugger adapter launch package has an unsupported shape");
  }
  return value;
}

function forward(from, to) {
  return new Promise((resolve, reject) => {
    from.once("error", reject);
    from.once("end", resolve);
    from.pipe(to, { end: false });
  });
}

async function run() {
  const launchPackage = await readPackage();
  // The adapter re-derives every authority locally instead of trusting the
  // delivered bytes: the workload is resolved from its spec, the manifest is
  // validated against that resolution, and the command profile is rebuilt
  // from the validated manifest and context.
  const resolved = resolveWorkloadSpec(launchPackage.workloadSpec, {
    environment: process.env,
  });
  const manifest = parseDebuggerPhaseManifest(resolved, launchPackage.manifest);
  const descriptor = buildDebuggerCommandProfile(
    resolved,
    manifest,
    launchPackage.context,
  );
  // Last-moment provenance: the supervisor already revalidated this adapter's
  // own launch provenance; the target and the debugger are revalidated here,
  // immediately before the debugger is spawned.
  verifyWorkloadProvenance(resolved);
  verifyDebuggerPhaseLaunchProvenance(resolved, manifest);

  const gdb = spawn(descriptor.command.executable, descriptor.command.args, {
    cwd: descriptor.command.cwd,
    env: workloadLaunchEnvironment(resolved),
    detached: false,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const spawned = new Promise((resolve, reject) => {
    gdb.once("spawn", resolve);
    gdb.once("error", reject);
  });
  await spawned;
  gdb.on("error", () => {});
  const [control] = gdb.stdio.slice(3);
  if (control === undefined) {
    fail("DEBUGGER_ADAPTER_SPAWN_ERROR", "debugger control channel is unavailable");
  }
  await Promise.all([
    once(gdb, "exit"),
    forward(gdb.stdout, process.stdout),
    forward(gdb.stderr, process.stdout),
    forward(control, process.stderr),
  ]);
}

run().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    try {
      process.stdout.write(adapterErrorLine(error), () => {
        process.exitCode = 1;
      });
    } catch {
      process.exitCode = 1;
    }
  },
);
