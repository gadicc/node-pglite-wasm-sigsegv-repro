# Run generic CPU-group waves

`fault-affinity groups` runs correlated workload waves under explicit CPU
masks. A fresh command creates schema-3 manifest version 3, which immutably
binds baseline, group-topology, and downstream exact-CPU schedules.

## Write the complete plan

Plan-file version 1 uses canonical CPU-list strings:

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
        "id": "all",
        "kind": "broad",
        "cpus": "18-21",
        "children": 4
      },
      {
        "id": "pair_a",
        "kind": "subset",
        "cpus": "18-19",
        "children": 2
      },
      {
        "id": "pair_b",
        "kind": "subset",
        "cpus": "20-21",
        "children": 2
      }
    ],
    "rounds": 10,
    "seed": 20260819
  },
  "exact": {
    "cpus": "18-21",
    "rounds": 10,
    "seed": 20260819
  }
}
```

Contexts may overlap, but every CPU in `cpuUniverse` must appear in at least
one context and no context may name a CPU outside it. Context order is part of
the topology identity; a seeded balanced-cyclic schedule varies its position
across rounds. `children` is the number of concurrent workload attempts in one
wave under that shared mask.

The plan must be a nonempty, bounded, single-link regular UTF-8 JSON file.
Symbolic links, additional hard links, carriage returns, NUL bytes, unknown
fields, and noncanonical CPU lists are rejected. Use a new output directory for
each distinct plan.

## Validate without execution

Choose a multi-phase workload profile and dry-run the complete design:

```sh
node fault-affinity.mjs groups \
  --workload wasm-churn-suite \
  --plan-file plans/my-host-groups.json \
  --out-dir diagnostics/wasm-groups \
  --dry-run
```

The dry run resolves and hashes the workload, safely reads the plan, validates
`taskset`, checks every group and exact CPU against the current process
allowance, builds all three immutable phase manifests, and prints schedule
sizes and the resource warning. It creates no output directory and executes no
workload.

Fault Affinity does not currently invent group contexts from host topology.
That keeps cache, core, NUMA, and administrative grouping choices explicit and
reviewable. Use topology data appropriate to the question you are testing.

## Start and resume group waves

After reviewing the plan, replace `--dry-run` with `--yes`:

```sh
node fault-affinity.mjs groups \
  --workload wasm-churn-suite \
  --plan-file plans/my-host-groups.json \
  --out-dir diagnostics/wasm-groups \
  --yes
```

Every child in a group wave inherits the context's whole CPU mask. Both its
stable supervisor and direct workload must witness that mask. A wave advances
only when all children produce valid outcomes and complete cleanup.

Resume group state with the same explicit workload identity:

```sh
node fault-affinity.mjs groups \
  --resume diagnostics/wasm-groups \
  --workload wasm-churn-suite \
  --yes
```

Resume uses only the immutable stored topology and schedules; `--plan-file` is
rejected. `SIGINT` or `SIGTERM` cancels the active wave and leaves its whole
schedule slot available after bounded cleanup.

## Advance the sibling phases

The same version-3 bundle also owns baseline and exact prefixes:

```sh
node fault-affinity.mjs baseline \
  --resume diagnostics/wasm-groups \
  --workload wasm-churn-suite \
  --yes

node fault-affinity.mjs exact \
  --resume diagnostics/wasm-groups \
  --workload wasm-churn-suite \
  --yes
```

The phases can be advanced independently, but one descriptor-backed lease
allows only one writer at a time. No command upgrades an older bundle or
changes its workload, plan, `taskset` path, or schedule.

Group waves are correlated execution contexts, not independent child trials.
Compare their wave-level and child-level evidence carefully. See the
[CPU-group wave reference](../reference/group-topology-waves.md) and
[interpretation guide](../concepts/interpreting-results.md).
