# Architecture decision 0014: Bind pinned-concurrent waves in manifest v4

Status: Accepted

## Context

A pinned-concurrent context assigns one logical CPU to each workload child while
keeping the coordinating process on a separate controller CPU. The context is
one correlated wave: controller placement, child launch order, singleton
affinity, attempt outcomes, and cleanup all contribute to whether that wave is
valid.

The group phase cannot represent this contract. It gives every child the same
inherited mask and has no controller-CPU identity. Adding pinned-concurrent
state to schema-3 manifest version 3 would also reinterpret the fixed state
inventory of existing bundles.

## Decision

Introduce a versioned internal pinned-concurrent manifest. It binds one
workload with the `pinnedConcurrent` capability, an ordered set of named
contexts, each context's active CPU set and controller CPU, the absolute
`taskset` path, and a deterministic schedule. The schedule balances context
order across rounds and separately balances child launch order within each
context.

The bundle owner process must run with an allowed CPU list containing only the
scheduled controller CPU. Each child has an independent stable supervisor with
an allowed CPU list containing only its scheduled active CPU. A wave envelope
records both the controller witness and every child's supervisor and direct
workload witness.

Only a complete operationally valid wave advances the no-clobber contiguous
prefix. A controller mismatch consumes no slot. A runner or operational child
failure cancels active peers and publishes no partial wave.

Introduce schema-3 manifest version 4 to bind baseline, groups,
pinned-concurrent, and exact-CPU state. Versions 1 through 3 retain their prior
fields and directory inventories. One descriptor-backed bundle lease spans
wave selection, execution, cleanup, and commit. Each child supervisor retains
that descriptor through bounded cleanup if the outer owner is interrupted.

This decision originally established an internal integration boundary and did
not add a public command. [ADR 0022](0022-public-pinned-orchestration.md) now
supplies the public per-wave owner while preserving this evidence contract and
legacy behavior.

## Consequences

- Controller placement is evidence, not an assumed property of the caller.
- Active CPUs cannot include their context's controller CPU.
- Context and launch ordering remain deterministic across resume.
- Manifest version 4 owns `state/pinned-concurrent/` in addition to the
  version-3 state inventory.
- Controlled-load, debugger, and frequency phases still need explicit generic
  adapters before a public run can include them.

## Acceptance criteria

- Workload, topology, schedule, controller, child slot, affinity, and attempt
  mismatches fail validation.
- A wrong controller consumes no wave and launches no child.
- Invalid children cancel peers and consume no wave.
- Complete waves resume as one exact prefix; gaps, foreign files, and active
  writer remnants fail closed.
- Manifest versions 1 through 3 retain their previous state shapes and phase
  behavior.
- Other phase operations cannot overlap one pinned-concurrent wave transaction.
- Harmless lifecycle fixtures prove singleton placement and lease retention
  through interrupted-owner cleanup.
