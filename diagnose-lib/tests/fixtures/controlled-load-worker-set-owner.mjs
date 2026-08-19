import { fstatSync, writeFileSync } from "node:fs";

import {
  bundleExecutionLeaseAttemptRetention,
  withBundleExecutionLease,
} from "../../bundle-execution-lease.mjs";
import { startControlledLoadWorkerSet } from "../../controlled-load-workers.mjs";
import { resolveWorkloadSpec } from "../../workload-spec.mjs";

const [bundleDir, cwd, ownerReadyFile, workerReadyFile, cpuText] = process.argv.slice(2);
const cpu = Number(cpuText);
const workerCode = [
  "const { fstatSync, writeFileSync } = await import('node:fs');",
  "let inheritedBundleDirectory = false;",
  "try { inheritedBundleDirectory = fstatSync(4).isDirectory(); } catch {}",
  "writeFileSync(process.argv[1], JSON.stringify({ inheritedBundleDirectory }));",
  "setInterval(() => {}, 1000);",
].join("\n");

const resolved = resolveWorkloadSpec({
  version: 1,
  id: "controlled-load-retention-fixture",
  label: "Controlled-load retention fixture",
  description: "Harmless waiting process for retained worker-set ownership tests.",
  risk: "standard",
  command: {
    executable: process.execPath,
    args: ["-e", workerCode, workerReadyFile],
    cwd,
  },
  environment: {},
  attempt: {
    mode: "survive-window",
    timeoutMs: 10_000,
    termGraceMs: 50,
    killGraceMs: 500,
  },
  outcomes: { targetSignals: [], mappedExits: [] },
  capabilities: {},
  provenance: { completeness: "complete", files: [] },
});

await withBundleExecutionLease({ bundleDir }, async (lease) => {
  const retainedDirectory = bundleExecutionLeaseAttemptRetention(lease);
  const handle = await startControlledLoadWorkerSet({
    resolved,
    cpus: [cpu],
    tasksetPath: "/usr/bin/taskset",
    retainedDirectory,
  });
  const retained = fstatSync(retainedDirectory.fd, { bigint: true });
  writeFileSync(ownerReadyFile, JSON.stringify({
    supervisor: handle.startEvidence.workers[0].supervisor,
    retainedDevice: retained.dev.toString(),
    retainedInode: retained.ino.toString(),
  }));
  await new Promise(() => {});
});
