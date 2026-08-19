# Understand internal CPU-group waves

The internal group phase binds an explicit CPU universe and one or more named
execution contexts. A context records a stable ID, descriptive kind, sorted CPU
set, and child count. Contexts may overlap, matching topology plans that include
both a broad CPU class and narrower clusters, but their union must cover the
declared universe.

A seeded balanced-cyclic schedule visits every context once per round while
rotating its position. Each schedule slot is one correlated wave. Every child
is launched through an independent bounded supervisor under the context's
canonical `taskset` CPU mask, and both supervisor and direct workload must
report that exact inherited mask.

Only a wave with valid evidence and complete cleanup for every child is
published. A runner or operational failure cancels active peers and leaves the
same wave next on resume. The durable store accepts only a contiguous sequence
of `group-wave-NNNNNNNNN.json` files following one immutable
`group-phase.json` manifest.

Schema-3 manifest version 3 binds this store at `state/groups/` alongside the
version-2 baseline and exact-CPU inventory. The bundle lease covers the full
select, run, cleanup, and commit transaction. No current `diagnose.sh` phase or
legacy bundle writes this format.

See [ADR 0013](../decisions/0013-group-topology-and-manifest-v3.md) for the
accepted compatibility boundary.
