import { fileURLToPath } from "node:url";

export const LEASE_RETENTION_CODE = [
  "const { fstatSync, writeFileSync } = await import('node:fs');",
  "let inheritedBundleDirectory = false;",
  "try { inheritedBundleDirectory = fstatSync(4).isDirectory(); } catch {}",
  "writeFileSync(process.argv[1], JSON.stringify({",
  "  pid: process.pid,",
  "  parentPid: process.ppid,",
  "  inheritedBundleDirectory,",
  "}));",
  "setInterval(() => {}, 1000);",
].join("\n");

export function leaseRetentionWorkloadSpec({ cwd, readyFile }) {
  return {
    version: 1,
    id: "schema3-lease-retention-fixture",
    label: "Schema 3 lease-retention fixture",
    description: "Harmless waiting process used to verify inherited bundle ownership.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", LEASE_RETENTION_CODE, readyFile],
      cwd,
    },
    environment: {},
    attempt: {
      mode: "survive-window",
      timeoutMs: 10_000,
      termGraceMs: 750,
      killGraceMs: 1_000,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
  };
}

// Running this file directly makes it the disposable bundle owner used by the
// parent-interruption test. Importing it only exposes the shared workload spec.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [bundleDir, cwd, readyFile] = process.argv.slice(2);
  const [{ resolveWorkloadSpec }, { runOneSchema3ExactCpuAttempt }] = await Promise.all([
    import("../../workload-spec.mjs"),
    import("../../schema3-bundle.mjs"),
  ]);
  const resolved = resolveWorkloadSpec(leaseRetentionWorkloadSpec({ cwd, readyFile }));
  await runOneSchema3ExactCpuAttempt({ resolved, bundleDir });
}
