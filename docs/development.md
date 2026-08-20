# Develop and test the tooling

This guide describes the current offline test suite and safety boundary. The automated tests do not run the crash workload or change system settings.

## Run the offline suite

Install dependencies, then run:

```sh
npm ci
npm test
```

The direct script remains available:

```sh
bash diagnose-lib/tests/run-tests.sh
```

The suite covers:

- CPU-list parsing
- Argument and exit-code validation
- Workload-spec and catalog validation, including custom-file provenance
- Public exact-CPU CLI parsing, dry-run safety, fresh bundle creation, and resume
- Public baseline, CPU-group, pinned-concurrent, and controlled-load CLI planning, fresh bundle creation, and complete-unit resume
- Read-only schema-3 v1-v5 summaries with phase, context, leg, CPU, and typed-outcome counts
- Generic debugger-phase manifest and structured control-protocol validation without launching GDB
- Internal shell-free attempt execution, deadlines, bounded output, and process-group cleanup
- Managed auxiliary-workload readiness, discarded output, and bounded cancellation
- Controlled-load worker-set readiness, boundary identity checks, peer cancellation, and stop evidence
- Complete controlled-load A1/B/A2 ordering, target affinity, interval proof, and failure cleanup
- Complete-only controlled-load storage, manifest-v5 dual-workload binding, and whole-session lease ownership
- Versioned workload-bound attempt records and tamper rejection
- Deterministic exact-CPU manifests, attempt envelopes, affinity witnesses, durable commits, and prefix resume
- Immutable schema-3 bundle manifest versions and exclusive phase transactions
- Workload-bound baseline manifests, correlated wave envelopes, and whole-wave resume
- Workload-bound group topology, inherited CPU-mask witnesses, and whole-wave resume
- Workload-bound pinned-concurrent topology, controller witnesses, singleton child affinity, and whole-wave resume
- Settings restoration under simulated signals
- Statistics and parser fixtures
- Evidence-envelope validation
- Generation and workload binding
- Derived-output write guards
- Process-group supervision
- Telemetry association and session handling
- Synthetic collect-and-report integration

It does not invoke `child.mjs`, `mini-wasm.mjs`, `mini-wasm-churn.mjs`, `repro-c`, or any other live fault trigger.

## Test controlled-load orchestration safely

Historical controlled-load tests use stubs and fake runners. Generic public
integration tests use only a harmless finite measured process and a harmless
waiting condition process. Together they validate:

- Mode and argument handling
- Mode-specific phase plans
- Constant-load Node A/B/A sequencing
- Repeated worker identity and affinity checks
- Controller signal forwarding
- Exact Node provenance
- GDB process and accounting reconciliation
- Publication of a validated fake capture envelope

The tests must not start `/usr/bin/yes` workers or execute the real PGlite child.

## Keep privileged behavior separate

`diagnose.sh` must remain unprivileged. Root-only behavior belongs in reviewable companion scripts with explicit staging, publication, restoration, and recovery contracts.

Tests for privileged flows should simulate sysfs and process state in fixtures. They must not write real firmware, BIOS, cpufreq, turbo, or `/run` state.

The historical recovery namespace `/run/node-pglite-wasm-sigsegv-repro/` is a compatibility boundary. Do not rename it as part of cosmetic project rebranding.

## Preserve evidence semantics

When changing a phase or record format:

1. Define whether outcome meaning or liveness changes.
2. Add a new version when old evidence cannot retain the same interpretation.
3. Keep old readers faithful to their original semantics.
4. Fail closed on missing, malformed, mismatched, or future-version evidence.
5. Preserve superseded generations instead of overwriting them.
6. Add adversarial resume and partial-publication fixtures.

Do not infer missing signal, stderr, boundary, or generation data for a legacy protocol.

## Keep workload execution bounded

The public `fault-affinity exact` command composes the workload contract,
attempt runner, exact-CPU phase adapter, durable phase store, and schema-3
bundle owner. Legacy `diagnose.sh` phases and schema-1/schema-2 bundles retain
their original formats. The offline tests prove:

- Deadline-aware process-group termination
- Cleanup of descendants on success, failure, timeout, `SIGINT`, and `SIGTERM`
- Distinction between harness termination and workload signals
- Canonical executable and working-directory resolution
- Argument-array execution without a shell
- Secret-safe environment provenance
- Workload digest binding across resume
- Distinct direct signals, handled-crash exits, corruption exits, and operational failures
- Singleton CPU inheritance, schedule binding, and exact-prefix resume
- Private no-clobber state publication and bounded interrupted-write recovery
- Reader/writer contention, manifest-only restart, and interrupted-owner lease retention
- Baseline peer cancellation and refusal to commit partial or invalid waves
- Pinned-concurrent controller validation, peer cancellation, and interrupted-owner lease retention
- Separation of long-lived condition-worker lifecycle results from canonical diagnostic attempt evidence
- Retained bundle ownership through interrupted managed worker-set cleanup

They also exercise fast child exit, retained output descriptors, unavailable
process-group observations, launch-time provenance drift, parent IPC loss, and
TERM-to-KILL grace timing. All fixtures are harmless process-lifecycle programs.

The managed auxiliary-workload path reuses that supervisor for controlled
conditions. It reports readiness only after identity and CPU-list validation,
discards intentionally unbounded worker output, and returns a separate result
shape that cannot be published as a diagnostic attempt record. The public
controlled-load command reaches it only through the complete worker-set and
session owners.

The controlled-load worker-set layer starts one managed worker per canonical
CPU, reports running only after complete readiness, rechecks the same PID and
start-ticks identities at named boundaries, and returns one complete stop
record. Early termination or placement drift cancels the set. The historical
multi-mode controlled-load script remains unchanged.

The controlled-load session adapter pins all measured attempts to one target
CPU and publishes only a complete A1/B/A2 envelope. Its B attempts are enclosed
by the same worker-set readiness, identity boundaries, and valid stop record;
declared warm-up and recovery times are checked against monotonic evidence.
The private phase store publishes only one complete session. Schema-3 manifest
version 5 binds that store, the auxiliary workload identity, and exact-CPU
state as a controlled-load variant. One bundle lease covers the whole session
and commit. The public command supplies a bounded plan and both trusted
workload identities.

The exact-CPU adapter reuses the current balanced-cyclic isolated schedule and
places each valid attempt record in a versioned envelope. Schema-3 manifest
version 1 binds only this phase. The owner publishes an exact prefix to a
private store and holds one bundle lease across selecting, running, and
committing the next slot. The public command creates and resumes this variant;
its integration fixture is a harmless finite process, never a built-in trigger.

The baseline adapter separately binds fixed concurrent waves and publishes only
complete whole-wave envelopes. Schema-3 manifest version 2 binds baseline and
exact-CPU state without adding fields to version 1 in place. The same bundle
lease covers selecting, running, and committing an entire baseline wave. The
public baseline command uses harmless finite custom processes in automation and
keeps published exact-only built-in identities separate from multi-phase
profiles.

Schema-3 manifest version 3 additionally binds CPU-group contexts. Contexts
may overlap, their order is deterministically balanced, and every child must
witness the scheduled inherited mask before its complete wave can advance. The
public groups command reads a bounded explicit plan before creating a bundle;
automation exercises it only with finite custom processes.
Manifest version 4 adds pinned-concurrent contexts. The public command creates
one short-lived bundle owner under each scheduled controller CPU and receives
its bounded result through a dedicated descriptor. That owner must witness its
controller placement, and each child supervisor and workload must witness one
scheduled singleton CPU before the complete wave can advance. Automation uses
only a finite custom process and checks all sibling phase resumes.
Manifest version 5 is a separate controlled-load variant. It binds the measured
and auxiliary workload identities, exact-CPU state, and one complete-only
controlled-load store without requiring baseline, group, or pinned-concurrent
capabilities. Its public integration fixture completes and resumes A1/B/A2,
then resumes the sibling exact phase with the same auxiliary identity.

The public summary command reuses the authoritative schema-3 reader and writes
only text or versioned JSON to stdout. It never creates a bundle artifact. Unit
fixtures cover every phase shape, and public integration tests summarize both
exact-only and dual-workload version-5 bundles.

The generic debugger foundation currently stops at a canonical phase manifest
and synthetic structured control records. Its tests use a temporary inert
executable to cover workload capability, target signals, GDB provenance,
schedule limits, canonical bindings, tamper rejection, pre-launch drift
detection, record ordering, attempt binding, affinity witnesses, and incomplete
control streams. They never start GDB or a fault workload.

Custom commands should be documented as trusted local workloads, not sandboxed code. They must not daemonize or escape the supervised process group.

## Keep the public entry point stable

`fault-affinity.mjs` is the package binary and compatibility-facing entry
point. Keep it thin: argument parsing and orchestration live under
`src/fault-affinity/`, while protocol and persistence modules remain under
`diagnose-lib/` as long as the public command and historical suite share them.
See the [`src/` layout](../src/README.md) and
[ADR 0025](decisions/0025-internal-source-layout.md).

Do not move built-in scripts merely to make the tree look tidier. Their
canonical command and provenance paths participate in persisted workload
identities. A compatibility-safe move needs either a stable old identity or an
explicitly new workload profile.

## Keep crash workloads out of automation

Continuous integration should run only hermetic tests, syntax checks, and native compilation checks. It must not:

- Start the PGlite reproduction
- Run reduced WebAssembly churn
- Execute native churn modes
- Invoke GDB against a live fault trigger
- Change sysfs or BIOS state
- Require root

Manual crash experiments need an explicit operator, a reviewed plan, and a disposable or recoverable environment appropriate to the stated risk.

## Check documentation changes

Documentation commands must reflect the current `--help` output. Do not present
debugger or frequency adapters as public generic commands until their
orchestration exists.

When headings move, search for repository-relative anchors:

```sh
rg -n 'README\.md#|docs/.*\.md#' \
  --glob '*.md'
```

Review all external evidence links and update measured dates only when a new documented experiment supports the change.
