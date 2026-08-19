# Architecture decisions

These architecture decision records (ADRs) define the accepted direction for
Fault Affinity before the public runtime is generalized. They describe required
behavior and compatibility boundaries, not current runtime capabilities.

| Decision | Status | Summary |
| --- | --- | --- |
| [ADR 0001](0001-fault-affinity-direction.md) | Accepted | Adopt the Fault Affinity scope and working name, with `wasm-churn` as the recommended explicit built-in. |
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
