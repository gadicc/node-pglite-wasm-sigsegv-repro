# Architecture decision 0012: Version the schema-3 phase inventory

Status: Accepted

## Context

Schema-3 bundle manifest version 1 binds one resolved workload and its
deterministic exact-CPU phase. The baseline format now preserves complete
correlated waves, but adding a baseline field to version 1 would change the
meaning and required state inventory of already-valid manifests.

Baseline selection also needs the same exclusive execution boundary as
exact-CPU selection. A no-clobber wave file prevents replacement but cannot by
itself prevent two owners from running the same next wave.

## Decision

Keep manifest version 1 immutable and exact-only. Introduce manifest version 2,
which binds both the baseline and exact-CPU phase manifests, their canonical
content digests, and their fixed state directories. A version-2 workload must
declare both phase capabilities.

Derive the permitted and required state-directory inventory from the manifest
version. Version 1 owns only `state/exact-cpu/`; version 2 owns
`state/baseline/` and `state/exact-cpu/`. Unknown entries and missing state fail
closed during normal reads. Initialization may finish a partially created
inventory only when the already-published immutable manifest matches exactly.

Run one baseline wave under the existing descriptor-backed bundle lease. The
lease spans reading the current prefix, selecting the next wave, running every
child, and committing one complete valid envelope. Stable supervisors retain
the lease descriptor through bounded cleanup after outer-owner interruption.
An invalid or incomplete wave does not advance the prefix.

This is an internal integration boundary. It does not change `diagnose.sh`,
schema-1 or schema-2 interpretation, the historical recovery namespace, or the
public command surface.

## Consequences

- Existing version-1 manifests remain readable and executable as exact-only
  bundles, including for workloads that also declare baseline capability.
- Version 2 makes baseline and exact-CPU operations mutually exclusive through
  one bundle lease.
- Resume validates one workload plus both phase identities before accepting
  version-2 evidence.
- Later phase additions require another explicit manifest version rather than
  optional fields whose absence is ambiguous.
- Manifest version 3 adds the separately versioned group topology and
  affinity-mask contract without changing version 2.

## Acceptance criteria

- Manifest-only and partial-inventory initialization recover without changing
  the immutable version-2 manifest.
- Changed workloads, phase schedules, bindings, or directory inventories are
  rejected.
- Version-1 reads and exact-CPU transactions retain their previous shape and
  behavior.
- Competing baseline, exact-CPU, and read operations cannot overlap one
  baseline-wave transaction.
- Invalid waves consume no schedule position, while a complete harmless wave
  commits and resumes exactly.
- Interrupted-owner tests prove lease retention through baseline supervisor
  cleanup without running a live diagnostic workload.
