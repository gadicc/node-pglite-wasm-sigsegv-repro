# Run a generic exact-CPU workload

The `fault-affinity` command runs one explicitly selected workload through a
bounded, deterministic exact-CPU schedule. This is the first public generic
path. It creates and resumes schema-3 evidence bundles, but it does not yet run
the generic baseline, topology-group, pinned-concurrent, controlled-load,
debugger, or frequency phases.

## Inspect before running

List the built-ins without executing them:

```sh
node fault-affinity.mjs workloads
node fault-affinity.mjs inspect --workload wasm-churn
node fault-affinity.mjs inspect --workload node-pglite --json
```

`wasm-churn` is the recommended dependency-free reduced workload.
`node-pglite` preserves the historical heavyweight reproduction and needs
`npm ci` before a live run. Listing and inspection only resolve and hash the
workload; they do not launch it.

## Plan an exact-CPU schedule

Choose CPUs from the invoking process's Linux CPU allowance. CPU lists must be
canonical, ascending, and contain no duplicates.

```sh
node fault-affinity.mjs exact \
  --workload wasm-churn \
  --cpus 18-21 \
  --rounds 10 \
  --seed 20260819 \
  --out-dir diagnostics/wasm-exact \
  --dry-run
```

A dry run validates the workload, provenance, executable, `taskset`, current
CPU allowance, and deterministic schedule. It neither creates the output
directory nor executes the workload.

## Start and resume a live run

Replace `--dry-run` with `--yes` only after reviewing the plan and workload
warning:

```sh
node fault-affinity.mjs exact \
  --workload wasm-churn \
  --cpus 18-21 \
  --rounds 10 \
  --seed 20260819 \
  --out-dir diagnostics/wasm-exact \
  --yes
```

The output directory must not exist. Fault Affinity creates it as a private
directory, writes an immutable workload and schedule manifest, and advances
only by complete valid attempts. Resume with the same explicit workload:

```sh
node fault-affinity.mjs exact \
  --resume diagnostics/wasm-exact \
  --workload wasm-churn \
  --yes
```

Resume re-resolves the workload and refuses a different executable, arguments,
environment binding, provenance, classifier, or lifecycle. One exclusive
bundle lease prevents two writers from advancing the same schedule.

`SIGINT` and `SIGTERM` cancel the active attempt, retain ownership through
bounded cleanup, and leave the interrupted schedule slot uncommitted so it can
be retried on resume.

## Supply a custom workload

Use `--workload-file` instead of `--workload`:

```sh
node fault-affinity.mjs inspect --workload-file workloads/my-workload.json
node fault-affinity.mjs exact \
  --workload-file workloads/my-workload.json \
  --cpus 19 \
  --rounds 20 \
  --out-dir diagnostics/my-workload \
  --dry-run
```

The JSON file uses workload-contract version 1. Paths inside it resolve from
the file's directory and become canonical absolute paths before execution.
Arguments are passed as an array without shell evaluation. The definition file
is automatically included in provenance.

Custom workloads are trusted local programs, not sandboxed code. They run with
the invoking account's access and must not daemonize or leave the supervised
process group. The initial resumable command rejects `environment.pass`; use
reviewed wrappers or explicit `environment.set` values. See the
[workload catalog](../../workloads/README.md) for the complete example.

## Interpret the bundle narrowly

A complete schema-3 exact bundle proves which bounded workload observations
were committed at which requested singleton CPU affinities. It does not, by
itself, prove CPU causation or produce the legacy diagnostic suite's final
report, telemetry, debugger capture, or privacy-review package.

Use the [exact-CPU envelope reference](../reference/exact-cpu-phase-envelopes.md)
for persisted semantics and [interpret experimental results](../concepts/interpreting-results.md)
for inference limits.
