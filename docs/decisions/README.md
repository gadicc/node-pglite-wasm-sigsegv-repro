# Architecture decisions

These architecture decision records (ADRs) define the accepted direction for
Fault Affinity before the public runtime is generalized. They describe required
behavior and compatibility boundaries, not current runtime capabilities.

| Decision | Status | Summary |
| --- | --- | --- |
| [ADR 0001](0001-fault-affinity-direction.md) | Accepted | Adopt the Fault Affinity scope and name, with `wasm-churn` as the recommended explicit built-in. |
| [ADR 0002](0002-trusted-workload-boundary.md) | Accepted | Run trusted user workloads without claiming sandboxing or hostile-code containment. |
| [ADR 0003](0003-attempt-lifecycle.md) | Accepted | Give every attempt a hard deadline and distinguish finite execution from survival windows. |
| [ADR 0004](0004-typed-outcome-evidence.md) | Accepted | Preserve raw process status and classify outcomes without conflating distinct evidence types. |
| [ADR 0005](0005-versioning-and-schema-3.md) | Accepted | Separate format versions and make schema-3 bundles fail closed with older writers. |
| [ADR 0006](0006-legacy-bundle-compatibility.md) | Accepted | Keep schema-1 and schema-2 bundles on a separate Node/PGlite compatibility path. |
| [ADR 0007](0007-phase-capabilities-and-workload-identity.md) | Accepted | Declare phase support and bind every phase to one workload identity. |
| [ADR 0008](0008-privileged-frequency-compatibility.md) | Accepted | Retain the historical recovery namespace and defer generic privileged workloads. |
| [ADR 0009](0009-exact-cpu-phase-envelopes.md) | Accepted | Bind valid exact-CPU attempts to one workload and deterministic resumable schedule. |
| [ADR 0010](0010-schema-3-bundle-ownership.md) | Accepted | Own one immutable schema-3 workload and serialize each exact-CPU attempt transaction. |
| [ADR 0011](0011-baseline-concurrent-waves.md) | Accepted | Persist baseline execution as an exact prefix of complete correlated waves. |
| [ADR 0012](0012-schema-3-manifest-v2.md) | Accepted | Keep manifest v1 exact-only and bind baseline plus exact-CPU state in v2. |
| [ADR 0013](0013-group-topology-and-manifest-v3.md) | Accepted | Bind overlapping group contexts, inherited CPU masks, and whole-wave state in manifest v3. |
| [ADR 0014](0014-pinned-concurrent-and-manifest-v4.md) | Accepted | Bind controller placement, per-child singleton affinity, and whole-wave state in manifest v4. |
| [ADR 0015](0015-managed-auxiliary-workloads.md) | Accepted | Separate verified long-lived condition workers from canonical diagnostic attempt evidence. |
| [ADR 0016](0016-controlled-load-worker-sets.md) | Accepted | Bind complete worker readiness, stable boundary identities, peer cancellation, and stop evidence. |
| [ADR 0017](0017-controlled-load-aba-sessions.md) | Accepted | Publish only complete single-workload A1/B/A2 sessions with a verified B condition. |
| [ADR 0018](0018-controlled-load-store-and-manifest-v5.md) | Accepted | Own complete controlled-load sessions in a no-clobber store and schema-3 manifest-v5 variant. |
| [ADR 0019](0019-public-exact-cli-and-project-identity.md) | Accepted | Publish the exact-CPU schema-3 command and adopt the Fault Affinity package identity without renaming legacy state. |
| [ADR 0020](0020-public-baseline-cli-and-capability-profiles.md) | Accepted | Publish schema-3 baseline orchestration while preserving exact-only built-in identities through explicit multi-phase profiles. |
| [ADR 0021](0021-public-group-cli-and-plan-file.md) | Accepted | Publish explicit CPU-group orchestration through a bounded plan file that binds all manifest-v3 schedules. |
| [ADR 0022](0022-public-pinned-orchestration.md) | Accepted | Publish manifest-v4 waves through short-lived controller-pinned bundle owners and a dedicated result descriptor. |
| [ADR 0023](0023-public-controlled-load-command.md) | Accepted | Publish complete-only generic A1/B/A2 orchestration with separate measured and condition workload identities. |
| [ADR 0024](0024-read-only-schema3-summaries.md) | Accepted | Add a read-only v1-v5 summary surface without treating derived output as evidence. |
| [ADR 0025](0025-internal-source-layout.md) | Accepted | Move internal public-command modules under `src/` while preserving stable entry points and workload paths. |
| [ADR 0026](0026-generic-debugger-phase-manifest.md) | Accepted | Bind workload, GDB provenance, capture profile, CPU, and bounded schedule before generic debugger execution. |
| [ADR 0027](0027-generic-debugger-control-protocol.md) | Accepted | Separate bounded machine-readable debugger lifecycle evidence from human-readable transcripts. |
| [ADR 0028](0028-bounded-debugger-attempt-io.md) | Accepted | Retain distinct bounded transcript and control streams while draining complete debugger-attempt output. |
| [ADR 0029](0029-supervised-debugger-adapter.md) | Accepted | Supervise debugger attempts through the established Node supervisor with a private stdin launch payload. |
