# Architecture decision 0023: Publish the generic controlled-load command

Status: Accepted

## Context

The managed auxiliary lifecycle, verified worker-set controller, complete
A1/B/A2 envelope, complete-only store, and schema-3 manifest version 5 already
define a generic controlled-load transaction. They were not reachable through
the public command. The historical controlled-load script also contains
multi-executable and debugger modes whose evidence meanings cannot be folded
into this single-workload schema.

## Decision

Add `fault-affinity controlled-load` as the public manifest-version-5 owner.
It accepts one explicitly selected measured workload, one trusted custom
condition workload file, a bounded plan file, an output directory, and either
`--dry-run` or `--yes`.

The public plan binds:

- one measured target CPU;
- a nonempty, disjoint condition-worker CPU set;
- attempts per A1, B, and A2 leg;
- minimum warm-up and recovery intervals; and
- the sibling exact-CPU schedule.

The condition workload must declare `survive-window` semantics. A live owner
holds the bundle lease across the complete session and publishes nothing unless
all three legs, condition boundaries, cleanup, and temporal checks validate.
Resume restarts the whole session when the store is empty and is a no-op after
complete publication.

Manifest version 5 binds both workload identities. Therefore controlled-load
resume and exact resume of that bundle require the same condition workload
file. Exact resume verifies the auxiliary identity but does not start it.

Keep the historical `load-state-aba.mjs` surface unchanged. Its Node A/B/A,
matrix, and debugger modes remain separate experiments and formats.

## Consequences

- Operators can use custom scripts or binaries for both sides of a generic
  A1/B/A2 comparison without changing protocol code.
- Dry-run validation remains non-executing and creates no bundle.
- Partial session progress is intentionally not resumable; a replacement owner
  repeats all three legs.
- The plan does not infer topology or claim a causal mechanism.
- Debugger, privileged frequency, and legacy report integration remain separate
  migration decisions.
