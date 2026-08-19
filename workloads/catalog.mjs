import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkloadSpec } from "../diagnose-lib/workload-spec.mjs";

export const CUSTOM_WORKLOAD_FILE_MAX_BYTES = 1024 * 1024;

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BUILT_INS = Object.freeze({
  "wasm-churn": Object.freeze({
    id: "wasm-churn",
    label: "WebAssembly churn",
    recommended: true,
    role: "Recommended dependency-free reduced trigger",
    risk: "standard",
    liveWarning: "Continuously compiles, instantiates, and executes fresh WebAssembly modules until the bounded attempt ends.",
    buildSpec() {
      const script = path.join(REPOSITORY_ROOT, "mini-wasm-churn.mjs");
      return {
        version: 1,
        id: "wasm-churn",
        label: "WebAssembly churn",
        description: "Dependency-free reduced trigger with fresh WebAssembly module lifecycle churn.",
        risk: "standard",
        command: {
          executable: process.execPath,
          args: [script, "200000", "1000"],
          cwd: REPOSITORY_ROOT,
        },
        environment: {},
        attempt: {
          mode: "survive-window",
          timeoutMs: 10_000,
          termGraceMs: 500,
          killGraceMs: 1_000,
        },
        outcomes: {
          targetSignals: ["SIGSEGV"],
          mappedExits: [{ code: 43, category: "corruption", label: "data-mismatch" }],
        },
        capabilities: { isolated: true },
        provenance: { completeness: "complete", files: [script] },
      };
    },
  }),
  "node-pglite": Object.freeze({
    id: "node-pglite",
    label: "Node/PGlite historical reproduction",
    recommended: false,
    role: "Historical heavyweight application-derived trigger",
    risk: "high-memory",
    liveWarning: "One PGlite client can use about 1.2 GiB; run npm ci before selecting this workload.",
    buildSpec() {
      const child = path.join(REPOSITORY_ROOT, "child.mjs");
      const packageJson = path.join(REPOSITORY_ROOT, "package.json");
      const lock = path.join(REPOSITORY_ROOT, "package-lock.json");
      return {
        version: 1,
        id: "node-pglite",
        label: "Node/PGlite historical reproduction",
        description: "Historical application-derived PGlite initialization and query trigger.",
        risk: "high-memory",
        command: {
          executable: process.execPath,
          args: [child],
          cwd: REPOSITORY_ROOT,
        },
        environment: {},
        attempt: {
          mode: "exit",
          timeoutMs: 120_000,
          termGraceMs: 1_000,
          killGraceMs: 2_000,
        },
        outcomes: { targetSignals: ["SIGSEGV"], mappedExits: [] },
        capabilities: { isolated: true },
        provenance: {
          completeness: "partial",
          files: [child, packageJson, lock],
        },
      };
    },
  }),
});

export class WorkloadCatalogError extends Error {
  constructor(message, code = "INVALID_WORKLOAD_SELECTION") {
    super(message);
    this.name = "WorkloadCatalogError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new WorkloadCatalogError(message, code);
}

function stableFile(filename) {
  let canonical;
  let fd;
  try {
    canonical = realpathSync(filename);
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n ||
        before.size > BigInt(CUSTOM_WORKLOAD_FILE_MAX_BYTES) || before.nlink !== 1n) {
      fail(`custom workload file must be a nonempty singly-linked regular file no larger than ${CUSTOM_WORKLOAD_FILE_MAX_BYTES} bytes`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || bytes.length !== Number(before.size)) {
      fail("custom workload file changed while it was read", "WORKLOAD_FILE_CHANGED");
    }
    return { canonical, bytes };
  } catch (error) {
    if (error instanceof WorkloadCatalogError) throw error;
    fail(`custom workload file could not be read safely: ${error?.code ?? "unknown error"}`,
      "WORKLOAD_FILE_ERROR");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function relativePath(base, value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a nonempty NUL-free path`);
  }
  return path.resolve(base, value);
}

function normalizeCustomSpec(raw, filename) {
  const value = structuredClone(plainObject(raw, "custom workload"));
  const base = path.dirname(filename);
  plainObject(value.command, "custom workload command");
  value.command.executable = relativePath(base, value.command.executable,
    "custom workload command.executable");
  value.command.cwd = relativePath(base, value.command.cwd,
    "custom workload command.cwd");
  const environment = plainObject(value.environment ?? {}, "custom workload environment");
  if ((environment.pass?.length ?? 0) !== 0) {
    fail("custom workload environment.pass is not supported by the initial resumable CLI; use a reviewed wrapper or explicit environment.set values");
  }
  plainObject(value.provenance, "custom workload provenance");
  if (!Array.isArray(value.provenance.files)) {
    fail("custom workload provenance.files must be an array");
  }
  value.provenance.files = value.provenance.files.map((entry, index) =>
    relativePath(base, entry, `custom workload provenance.files[${index}]`));
  const bindsDefinition = value.provenance.files.some((entry) => {
    try {
      return realpathSync(entry) === filename;
    } catch {
      return false;
    }
  });
  if (!bindsDefinition) value.provenance.files.push(filename);
  return value;
}

export function listBuiltInWorkloads() {
  return Object.freeze(Object.values(BUILT_INS).map((entry) => Object.freeze({
    id: entry.id,
    label: entry.label,
    recommended: entry.recommended,
    role: entry.role,
    risk: entry.risk,
    liveWarning: entry.liveWarning,
  })));
}

export function resolveBuiltInWorkload(id) {
  const entry = BUILT_INS[id];
  if (entry === undefined) {
    fail(`unknown built-in workload '${id}'; choose: ${Object.keys(BUILT_INS).join(", ")}`);
  }
  return Object.freeze({
    source: "built-in",
    metadata: listBuiltInWorkloads().find((candidate) => candidate.id === id),
    resolved: resolveWorkloadSpec(entry.buildSpec()),
  });
}

export function resolveCustomWorkloadFile(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0")) {
    fail("custom workload file path must be nonempty and NUL-free");
  }
  const { canonical, bytes } = stableFile(path.resolve(filename));
  let raw;
  try {
    raw = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    fail("custom workload file must contain valid UTF-8 JSON");
  }
  const spec = normalizeCustomSpec(raw, canonical);
  const environmentSet = spec.environment?.set ?? {};
  const bindingKey = Object.keys(environmentSet).length === 0
    ? undefined
    : createHash("sha256").update("fault-affinity/custom-workload/v1\0")
      .update(bytes).digest();
  const resolved = resolveWorkloadSpec(spec,
    bindingKey === undefined ? {} : { environmentBindingKey: bindingKey });
  const specRecord = resolved.provenance.files.find((record) => record.path === canonical);
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  if (specRecord?.sha256 !== expectedDigest) {
    fail("custom workload file changed between parsing and provenance binding",
      "WORKLOAD_FILE_CHANGED");
  }
  return Object.freeze({
    source: "custom-file",
    metadata: Object.freeze({
      id: resolved.id,
      label: resolved.label,
      recommended: false,
      role: "Trusted user-supplied workload",
      risk: resolved.risk,
      liveWarning: "Trusted and not sandboxed; runs with the invoking account's access and must remain inside the supervised process group.",
      file: canonical,
    }),
    resolved,
  });
}

export function resolveWorkloadSelection({ workload, workloadFile }) {
  if ((workload === undefined) === (workloadFile === undefined)) {
    fail("select exactly one --workload ID or --workload-file PATH");
  }
  return workload === undefined
    ? resolveCustomWorkloadFile(workloadFile)
    : resolveBuiltInWorkload(workload);
}
