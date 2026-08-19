# Understand internal baseline concurrent waves

Baseline phase version 1 is the internal bridge between the generic attempt
runner and schema-3 bundle manifest version 2. No current `diagnose.sh` phase or
legacy bundle writes this format.

## Treat one wave as the schedule unit

The phase manifest binds:

- One resolved workload ID, contract version, and digest
- A fresh 32-character phase generation
- The `independent-supervisors-v1` concurrency mode
- A fixed number of children per wave and total waves
- The exact total attempt count and canonical schedule digest

Children are homogeneous, so the schedule needs no randomized launch order.
Each child still receives a deterministic one-based position and global attempt
ordinal. Changing workload identity, children, waves, generation, concurrency
mode, or schedule digest invalidates resume.

## Commit only complete waves

A wave envelope contains one bound [attempt record](attempt-records.md) for
every child position. Each record preserves its process identity, raw exit or
signal, normalized outcome, monotonic boundaries, cleanup status, and bounded
output.

Every record must have a valid workload outcome and complete cleanup before the
wave can occupy its slot. If a child has a runner or operational failure, the
adapter cancels still-active peers. Their returned evidence remains available
to the caller, but no wave envelope is committed and the same wave remains next
on resume.

## Resume one exact prefix

The internal store uses this layout inside a caller-owned private directory:

| Path | Meaning |
| --- | --- |
| `baseline-phase.json` | Exclusive canonical phase manifest |
| `baseline-wave-NNNNNNNNN.json` | One exclusive canonical complete-wave envelope |

Publication uses private synchronized temporary files and an atomic no-clobber
link point. Readers accept only an exact contiguous wave prefix, reconcile a
known dead writer, refuse a live writer, and reject unknown files. The store
caps a wave at 64 children, one envelope at 64 MiB, and aggregate state at
512 MiB.

The store prevents conflicting publication but does not by itself prevent two
processes from executing the same next wave. Schema-3 manifest version 2 binds
the phase, and the bundle owner holds its descriptor-backed lease across
selection, execution, and commit. Manifest version 1 remains exact-only.

See [ADR 0011](../decisions/0011-baseline-concurrent-waves.md) for the accepted
format and migration boundary.
