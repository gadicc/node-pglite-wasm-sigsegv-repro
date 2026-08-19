# Understand the Fault Affinity direction

This page records the agreed destination for the repository without presenting unimplemented commands as current behavior. The working name is **Fault Affinity**.

## Define the intended scope

Fault Affinity is intended to become a Linux harness for reproducing, localizing, and collecting reviewable evidence for intermittent CPU-sensitive process faults.

The intended scope includes:

- CPU-group screening
- Exact logical-CPU localization
- Pinned concurrent topology contexts
- Controlled-load A/B/A experiments
- Telemetry and debugger capture
- Signals, handled crashes, data mismatches, and other workload failures
- User-supplied scripts or binaries

The project should not claim to be a universal crash debugger, hardware defect detector, fuzzer, or cross-platform tool. The current implementation depends on Linux facilities such as `taskset`, `/proc`, sysfs, `intel_pstate`, topology discovery, and GNU Debugger (GDB).

## Retain the original PGlite workload

The Node/PGlite workload remains valuable as the historical application-derived trigger and as a heavyweight regression workload. It records the path from a production-shaped failure to smaller WebAssembly probes.

PGlite should stop owning the root project identity once the generic interface exists. Until then, the current commands, dependency, Dockerfile, evidence schemas, and diagnostic phases still depend on it.

## Prefer WebAssembly churn as the reduced trigger

`mini-wasm-churn.mjs` is the recommended reduced trigger for future built-in support. It is dependency-free and reproduced in 15/15 and 10/10 documented loaded attempts on the affected machine.

The native harness remains an advanced control. Its pure-execution modes did not reproduce the userspace fault in the documented runs, while `churn-mem` produced kernel oopses and a wedged process. That risk makes it unsuitable as a default workload.

No built-in workload should run implicitly. A future invocation should require an explicit workload choice and display its resource and disruption risks.

## Introduce a workload contract before public commands

A generic harness needs more than a shell command string. It must record how the workload starts, when one attempt ends, and how each outcome is classified.

The planned workload contract should resolve and persist:

- A stable workload identifier and version
- An executable plus argument array, without shell evaluation
- A canonical working directory
- Explicit environment additions and secret-safe provenance
- Input files and executable hashes
- Resource and prerequisite warnings
- Exit-based or bounded survival-window completion
- Direct signals, handled-crash exits, corruption exits, other workload failures, and operational failures
- Protocol capabilities, including whether GDB and privileged phases apply

Literal exit `139`, direct `SIGSEGV`, a handled crash exit such as `42`, and a detected-corruption exit such as `43` must remain distinct evidence.

## Preserve legacy evidence and recovery state

New bundle, workload-contract, attempt-record, phase-envelope, and results schemas need separate versions. Existing schema-1 and schema-2 bundles must remain readable under their original meanings.

Migration must follow these constraints:

- Never upgrade an old bundle in place
- Never let resume silently change the workload, arguments, timeout, or classifier
- Make old runners fail closed on unsupported new bundles
- Preserve existing PGlite evidence as one workload; do not mix it with reduced-trigger evidence in the same bundle
- Keep the historical `/run/node-pglite-wasm-sigsegv-repro/` privileged recovery namespace readable
- Keep custom workloads out of privileged frequency experiments until the contract and supervision model are proven

The recovery namespace is operational state, not branding. Renaming it can strand a restore ledger or permit overlapping locks.

## Sequence the migration

The intended implementation sequence is:

1. Record architecture and compatibility decisions.
2. Split current-state documentation without changing behavior.
3. Establish safe automated tests that never run crash workloads.
4. Build a deadline-aware attempt runner with process-group cleanup tests.
5. Resolve canonical workload identities and bind them to evidence.
6. Migrate exact-CPU paths internally while checking PGlite compatibility.
7. Migrate baseline and group screening, then add a new bundle schema.
8. Migrate controlled-load, GDB, and frequency protocols.
9. Extract built-in workloads and reorganize the source tree.
10. Adopt the Fault Affinity package, command, and repository identity.

The documentation, safety-net, workload-spec, and bounded attempt-runner
foundations are complete. The runner is internal: current diagnostic phases do
not call it, it writes no public evidence schema, and it does not make
`fault-affinity` an executable command. The next migration step is to bind its
typed attempt result to versioned evidence before moving an existing diagnostic
path onto it.
