# Run generic pinned-concurrent waves

`fault-affinity pinned` runs one independently supervised workload child on
each active CPU while the durable wave owner runs on a separate controller CPU.
A fresh command creates schema-3 manifest version 4 and immutably binds
baseline, CPU-group, pinned-concurrent, and exact-CPU schedules.

## Write the complete plan

Pinned plan-file version 1 uses canonical CPU-list strings:

```json
{
  "version": 1,
  "baseline": {
    "children": 4,
    "waves": 10
  },
  "groups": {
    "cpuUniverse": "18-21",
    "contexts": [
      {
        "id": "active_pair",
        "kind": "subset",
        "cpus": "18-19",
        "children": 2
      }
    ],
    "rounds": 10,
    "seed": 20260819
  },
  "pinnedConcurrent": {
    "contexts": [
      {
        "id": "active_pair",
        "kind": "subset",
        "cpus": "18-19",
        "cluster": "l2:18-19",
        "controllerCpu": 20
      }
    ],
    "rounds": 10,
    "seed": 20260819
  },
  "exact": {
    "cpus": "18-19",
    "rounds": 10,
    "seed": 20260819
  }
}
```

Each controller CPU must be outside its context's active set. Context IDs,
kinds, cluster labels, active CPU order, controller CPUs, rounds, and seed all
participate in immutable schedule identity. The pinned context does not have a
`children` field: it launches exactly one child per active CPU.

The plan is a bounded, nonempty, single-link regular UTF-8 JSON file. Symbolic
links, additional hard links, carriage returns, NUL bytes, unknown fields,
noncanonical CPU lists, duplicate context IDs, and unsafe controller placement
are rejected.

Fault Affinity does not infer cache or topology contexts. Choose and review the
active/controller relationship appropriate to your experiment.

## Validate without execution

Choose a multi-phase profile and dry-run the complete design:

```sh
node fault-affinity.mjs pinned \
  --workload wasm-churn-suite \
  --plan-file plans/my-host-pinned.json \
  --out-dir diagnostics/wasm-pinned \
  --dry-run
```

The dry run resolves and hashes the workload, safely reads the plan, validates
`taskset`, checks every scheduled CPU against the invoking process allowance,
builds all four manifests, and prints the schedule sizes and resource warning.
It creates no output directory and executes no workload.

## Start and resume pinned waves

After reviewing the plan, replace `--dry-run` with `--yes`:

```sh
node fault-affinity.mjs pinned \
  --workload wasm-churn-suite \
  --plan-file plans/my-host-pinned.json \
  --out-dir diagnostics/wasm-pinned \
  --yes
```

For each wave, the CLI starts one short-lived Node owner under the scheduled
controller CPU. That process owns the bundle lease through child execution,
bounded cleanup, and complete-wave publication. Each child records singleton
placement for both its stable supervisor and direct workload. The owner result
uses a dedicated bounded control descriptor, separate from workload streams.

Resume with the same explicit workload identity:

```sh
node fault-affinity.mjs pinned \
  --resume diagnostics/wasm-pinned \
  --workload wasm-churn-suite \
  --yes
```

Resume uses only the stored workload, topology, schedules, and `taskset` path;
`--plan-file` is rejected. `SIGINT` or `SIGTERM` is forwarded to the active
owner. If the CLI is lost after starting a wave, that already-bounded owner may
still publish one valid complete wave. Rerun the resume command and trust the
durable prefix rather than terminal output.

## Advance sibling phases

The same version-4 bundle also owns baseline, group, and exact prefixes:

```sh
node fault-affinity.mjs baseline \
  --resume diagnostics/wasm-pinned \
  --workload wasm-churn-suite \
  --yes

node fault-affinity.mjs groups \
  --resume diagnostics/wasm-pinned \
  --workload wasm-churn-suite \
  --yes

node fault-affinity.mjs exact \
  --resume diagnostics/wasm-pinned \
  --workload wasm-churn-suite \
  --yes
```

The phases have independent complete prefixes, but one bundle lease permits
only one writer at a time. No command changes or upgrades an existing bundle.

Pinned children in one wave are correlated observations, not independent
trials. See the [pinned-concurrent wave reference](../reference/pinned-concurrent-waves.md)
and [interpretation guide](../concepts/interpreting-results.md).
