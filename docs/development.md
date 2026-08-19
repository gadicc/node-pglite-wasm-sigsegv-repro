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
- Draft workload-spec validation and typed outcome classification
- Internal shell-free attempt execution, deadlines, bounded output, and process-group cleanup
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

Controlled-load tests use stubs and fake runners. They validate:

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

The internal workload contract, attempt runner, exact-CPU phase adapter, and
durable phase store are implemented as a foundation, but no current
`diagnose.sh` phase, legacy bundle, or public command uses the new formats. The
offline tests prove:

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

They also exercise fast child exit, retained output descriptors, unavailable
process-group observations, launch-time provenance drift, parent IPC loss, and
TERM-to-KILL grace timing. All fixtures are harmless process-lifecycle programs.

The exact-CPU adapter reuses the current balanced-cyclic isolated schedule and
places each valid attempt record in a versioned envelope. Schema-3 manifest
version 1 binds only this phase. The owner publishes an exact prefix to a
private store and holds one bundle lease across selecting, running, and
committing the next slot.

The internal baseline adapter separately binds fixed concurrent waves and
publishes only complete whole-wave envelopes. Schema-3 manifest version 2 binds
baseline and exact-CPU state without adding fields to version 1 in place. The
same bundle lease covers selecting, running, and committing an entire baseline
wave. Before exposing a public generic interface, extend that versioned
ownership contract to the remaining applicable phases without changing legacy
bundle interpretation.

Schema-3 manifest version 3 additionally binds CPU-group contexts. Contexts
may overlap, their order is deterministically balanced, and every child must
witness the scheduled inherited mask before its complete wave can advance.
Manifest version 4 adds pinned-concurrent contexts. The bundle owner must
witness its scheduled controller CPU, and each child supervisor and workload
must witness one scheduled singleton CPU before the complete wave can advance.

Custom commands should be documented as trusted local workloads, not sandboxed code. They must not daemonize or escape the supervised process group.

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

Documentation commands must reflect the current `--help` output. Do not publish future `fault-affinity` commands until the executable exists.

When headings move, search for repository-relative anchors:

```sh
rg -n 'README\.md#|docs/.*\.md#' \
  --glob '*.md'
```

Review all external evidence links and update measured dates only when a new documented experiment supports the change.
