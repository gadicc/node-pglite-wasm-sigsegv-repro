# Architecture decision 0013: Bind group topology and CPU masks in manifest v3

Status: Accepted

## Context

CPU-group screening is not an unlabelled baseline. Each correlated wave runs
under one declared CPU mask, group contexts may overlap, and child counts may
differ by context. The phase therefore needs a stable topology identity,
deterministic context order, per-child affinity evidence, and whole-wave
publication.

Adding this inventory to schema-3 manifest version 2 would reinterpret existing
baseline-plus-exact bundles.

## Decision

Introduce a versioned internal group manifest that binds one workload with the
`groups` capability, a sorted CPU universe, an ordered set of named contexts,
each context's sorted CPU set and child count, the inherited-mask method, and a
deterministic balanced-cyclic schedule. Contexts may overlap, but together must
cover the declared universe.

Every group wave records its exact schedule slot and one canonical attempt
record plus verified supervisor/workload mask witness for every child. Only a
complete operationally valid wave advances the no-clobber contiguous prefix.

Introduce schema-3 manifest version 3 to bind baseline, groups, and exact-CPU
state. Versions 1 and 2 retain their exact prior fields and directory
inventories. One descriptor-backed bundle lease spans group selection,
execution, cleanup, and commit and excludes every other phase operation.

This remains internal and does not change topology discovery, `diagnose.sh`,
legacy evidence, or the public command surface.

## Consequences

- Group schedules remain reproducible without treating overlapping contexts as
  a partition.
- Mask drift in either the supervisor or direct workload invalidates the child
  and prevents whole-wave publication.
- Manifest v3 owns `state/groups/` in addition to the v2 state inventory.
- Pinned-concurrent contexts are the next phase needing a distinct controller
  CPU and per-child singleton-affinity contract.

## Acceptance criteria

- Topology, schedule, workload, affinity, slot, and attempt tampering fail
  validation.
- Complete waves resume as one exact prefix; gaps, foreign files, and active
  writer remnants fail closed.
- Invalid children cancel peers and consume no wave.
- Manifest versions 1 and 2 remain readable and executable with their previous
  state shapes.
- Group, baseline, exact-CPU, and read operations cannot overlap one group-wave
  transaction.
- Automated coverage uses only harmless finite lifecycle fixtures.
