# Architecture decision 0010: Own schema-3 attempt transactions

Status: Accepted

## Context

No-clobber attempt files prevent overwriting evidence, but they cannot prevent
two processes from selecting and executing the same next schedule slot. Bundle
identity must also survive restart, and an interrupted outer process must not
make the bundle available while its supervised workload is still being cleaned
up.

The public diagnostic remains Node/PGlite-specific. The generic ownership
contract therefore needs an internal migration path that does not reinterpret
or mutate schema-1 and schema-2 bundles.

## Decision

Introduce an internal bundle-format-3 owner with one immutable canonical
`fault-affinity-bundle.json` manifest. Manifest version 1 records bundle and
run schema versions, a fresh bundle generation, the complete resolved workload
and digest binding, phase capability states, and the bound exact-CPU phase
manifest. Manifest version 2 retains those fields and also binds the baseline
phase. A retry may complete initialization after the manifest was published,
but it may not replace or change that manifest.

Store mutable exact-CPU state below `state/exact-cpu/` and, in manifest version
2, baseline state below `state/baseline/`. Phase completion is derived from the
valid contiguous attempt or whole-wave prefix and its final no-clobber commit;
there is no separate completion marker that could disagree.

Every operation that may reconcile or publish state holds an exclusive lease
on an already-open canonical private bundle-directory descriptor. The lease
spans reading the current prefix, selecting the next slot, running the attempt,
and committing valid evidence. Nonblocking contention returns a typed busy
result; callers may instead request a bounded wait.

When an attempt starts, the stable process supervisor inherits a duplicate of
the leased directory descriptor. The workload does not receive that descriptor.
If the outer bundle owner is interrupted, the inherited description keeps the
lease active until the supervisor completes its bounded process-group cleanup.
A replacement owner therefore cannot overlap a still-active attempt.

The owner is internal only. It does not add public `fault-affinity` commands or
change the current `diagnose.sh`, legacy metadata, reporting, or privileged
recovery namespace.

## Consequences

- One schema-3 bundle has one immutable workload and version-specific phase identities.
- Selection, execution, and publication form one exclusive transaction.
- Operationally invalid attempts leave the schedule slot available.
- Restart can recover a manifest-only initialization and known interrupted
  temporary files without changing bundle identity.
- Read operations also take the lease because interrupted-file reconciliation
  can mutate internal housekeeping state.
- Manifest version 1 remains exact-only; version 2 binds baseline and exact-CPU
  without reinterpreting version 1.
- Group, controlled-load, debugger, and frequency phases still need explicit
  schema-3 bundle adapters before a public generic run can include them.

## Acceptance criteria

- Canonical initialization is idempotent and rejects a changed workload,
  manifest, directory identity, unknown entry, or live writer.
- Competing readers and writers cannot enter while one next-attempt transaction
  owns the bundle.
- A harmless production-runner fixture proves that the supervisor validates and
  retains the bundle descriptor.
- A harmless interrupted-owner fixture proves that ownership remains active
  through supervisor cleanup and that no uncommitted slot is consumed.
- Exact completion is derived from the final valid prefix.
- Schema-1, schema-2, the public CLI, and live diagnostic workloads remain
  unchanged.
