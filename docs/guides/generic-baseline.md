# Run a generic baseline and exact-CPU bundle

The `fault-affinity baseline` command runs complete correlated waves of one
explicitly selected workload. It creates schema-3 manifest version 2, which
binds the baseline schedule and a downstream exact-CPU schedule before any
evidence is collected.

## Choose a baseline-capable workload

Use the multi-phase built-in when you want the reduced WebAssembly trigger:

```sh
node fault-affinity.mjs inspect --workload wasm-churn-suite
```

`wasm-churn-suite` and `node-pglite-suite` are separate identities from their
exact-only counterparts. Capabilities participate in the workload digest, so
the separate IDs preserve resume compatibility for existing exact-only
bundles. The PGlite profile is high-memory: each child can use about 1.2 GiB,
and a concurrent wave multiplies that requirement.

A custom workload needs both capabilities because a version-2 bundle owns both
phases:

```json
"capabilities": {
  "baseline": true,
  "isolated": true
}
```

Declaring a capability does not make an arbitrary program safe. Custom
workloads remain trusted local programs and must stay inside the supervised
process group.

## Plan both immutable schedules

The baseline phase is not pinned to one CPU. Every child inherits the invoking
process's current CPU allowance. `--exact-cpus`, `--exact-rounds`, and
`--exact-seed` describe the exact-CPU phase stored beside it:

```sh
node fault-affinity.mjs baseline \
  --workload wasm-churn-suite \
  --children 4 \
  --waves 10 \
  --exact-cpus 18-21 \
  --exact-rounds 10 \
  --exact-seed 20260819 \
  --out-dir diagnostics/wasm-baseline \
  --dry-run
```

The dry run resolves and hashes the workload, validates `taskset`, checks the
exact CPU list against the current Linux allowance, builds both deterministic
schedules, and prints the resource warning. It creates no output directory and
executes no workload.

The current format allows at most 64 children in one wave and 65,536 waves,
with at most 1,000,000 attempts in either deterministic schedule. Start with a
small child count that fits the workload's memory and CPU needs.

## Start and resume baseline waves

After reviewing the dry run, replace `--dry-run` with `--yes`:

```sh
node fault-affinity.mjs baseline \
  --workload wasm-churn-suite \
  --children 4 \
  --waves 10 \
  --exact-cpus 18-21 \
  --exact-rounds 10 \
  --exact-seed 20260819 \
  --out-dir diagnostics/wasm-baseline \
  --yes
```

Each wave starts all child attempts through independent stable supervisors. A
wave advances the durable prefix only when every child has a valid workload
outcome and complete cleanup. A launcher, cancellation, cleanup, or other
operational failure leaves the same whole wave available on resume.

Resume with the same explicit workload profile:

```sh
node fault-affinity.mjs baseline \
  --resume diagnostics/wasm-baseline \
  --workload wasm-churn-suite \
  --yes
```

Resume reads the immutable stored child count, wave count, workload identity,
and exact schedule. Fresh schedule options are rejected with `--resume`.
`SIGINT` and `SIGTERM` cancel the active wave, retain the bundle lease through
bounded child cleanup, and do not publish a partial wave.

## Advance the bound exact phase

The existing exact command advances the exact prefix in the same bundle:

```sh
node fault-affinity.mjs exact \
  --resume diagnostics/wasm-baseline \
  --workload wasm-churn-suite \
  --yes
```

It uses the exact CPUs, rounds, seed, and `taskset` path stored at bundle
creation. Baseline and exact operations share one exclusive bundle lease, so
two writers cannot advance either schedule concurrently.

The two phases may be resumed independently, but they remain one evidence
bundle for one workload identity. Neither command upgrades version-1 bundles
or rewrites version-2 manifests.

## Interpret the result narrowly

A complete baseline prefix records correlated concurrent waves; it is not a
collection of independent child trials. A complete exact prefix records
singleton-affinity attempts. Compare those contexts without treating their
different denominators as interchangeable.

Schema-3 version 2 still does not provide topology-group state; use the
[generic CPU-group command](generic-cpu-groups.md) to create a version-3 bundle.
Pinned-concurrent and controlled-load protocols use their own later manifest
variants and public guides. Debugger, frequency, telemetry, privacy-review, and
final-report orchestration remain outside this baseline path. See the
[baseline wave reference](../reference/baseline-concurrent-waves.md)
for persisted semantics and [interpret experimental results](../concepts/interpreting-results.md)
for inference limits.
