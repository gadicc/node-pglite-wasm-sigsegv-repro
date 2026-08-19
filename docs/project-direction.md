# Understand the Fault Affinity direction

This page separates the implemented Fault Affinity foundation from the
remaining migration work. **Fault Affinity** is now the package and public
command identity. Exact-CPU execution was the first generic public path;
correlated baseline waves and explicit CPU-group contexts are now public through
schema-3 manifest versions 2 and 3.

## Define the intended scope

Fault Affinity is a Linux harness for reproducing, localizing, and collecting
reviewable evidence for intermittent CPU-sensitive process faults. Its current
public generic surface is deliberately narrower than the full intended scope.

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

PGlite no longer owns the package or README identity. Its dependency,
Dockerfile, legacy evidence schemas, and diagnostic commands remain because the
historical reproduction and broader legacy suite still use them.

## Prefer WebAssembly churn as the reduced trigger

`mini-wasm-churn.mjs` is the recommended `wasm-churn` built-in. It is
dependency-free and reproduced in 15/15 and 10/10 documented loaded attempts
on the affected machine.

The native harness remains an advanced control. Its pure-execution modes did not reproduce the userspace fault in the documented runs, while `churn-mem` produced kernel oopses and a wedged process. That risk makes it unsuitable as a default workload.

No built-in runs implicitly. Fresh and resumed live invocations require an
explicit workload choice, and inspection and planning display the declared
resource or disruption risk without launching it.

## Bind public commands to a workload contract

A generic harness needs more than a shell command string. The version-1
workload contract records how the workload starts, when one attempt ends, and
how each outcome is classified.

The resolver and schema-3 evidence persist:

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
7. Add the internal schema-3 bundle owner, then migrate baseline and group screening.
8. Migrate controlled-load, GDB, and frequency protocols.
9. Extract built-in workloads and reorganize the source tree.
10. Adopt the Fault Affinity package, command, and repository identity.

The documentation, safety-net, workload-spec, bounded attempt-runner,
versioned attempt-record, exact-CPU phase-envelope, durable phase-store,
internal schema-3 bundle owner, baseline whole-wave, CPU-group, and
pinned-concurrent foundations are complete. Bundle manifest version 1 binds one
workload and deterministic exact-CPU manifest. Version 2 additionally binds
correlated baseline waves, version 3 binds overlapping CPU-group contexts and
inherited masks, and version 4 binds a separate controller CPU plus one
singleton-affinity child per active CPU. Version 5 is a separate controlled-load
variant that binds measured and auxiliary workload identities, exact-CPU state,
and one complete A1/B/A2 store.
The owner holds one exclusive lease across selecting, running, and committing
an exact attempt, complete baseline/group/pinned-concurrent wave, or complete
controlled-load session and derives completion from durable publication. Its
stable supervisors retain the lease through bounded cleanup if the outer owner
is interrupted.

The `fault-affinity` command now exposes reviewed workload listing, inspection,
dry-run planning, fresh exact-only schema-3 bundle creation, exact-prefix
resume, complete correlated baseline waves in manifest-v2 bundles, and complete
CPU-group waves in manifest-v3 bundles. A baseline command pre-binds the
downstream exact schedule. A groups command safely reads one explicit plan that
pre-binds baseline, group topology, and exact schedules. The phase commands can
then advance their matching prefixes in that same bundle. Trusted custom JSON
workloads declare their own capabilities.

The published `wasm-churn` and `node-pglite` IDs retain their exact-only
workload identities. Separate `wasm-churn-suite` and `node-pglite-suite`
profiles declare baseline, group, isolated, and pinned-concurrent capability so
later public phases do not mutate old bundle identities. This completes the
package/command portion of steps 9 and 10 without requiring a physical checkout
or repository-host rename.

The internal pinned-concurrent adapter is not yet publicly orchestrated for
arbitrary workloads. The controlled-load foundation has a
managed auxiliary lifecycle, verified worker sets, complete A1/B/A2 envelopes,
a complete-only store, and schema-3 manifest-v5 ownership, but still has no
generic public command. Debugger and frequency protocols still need
workload-bound adapters where applicable. Historical Node A/B/A and
Node-by-warmup modes remain multi-workload experiments outside the current
schema.

The next high-value migration is to expose additional generic phases only where
their capability, provenance, and compatibility contracts are complete. Legacy
schema-1/schema-2 interpretation and the privileged recovery namespace remain
unchanged throughout.
