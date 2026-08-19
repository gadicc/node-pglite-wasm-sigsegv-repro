# Understand internal exact-CPU phase envelopes

Exact-CPU phase-envelope version 1 is the internal bridge between the generic
workload runner and the repository's existing isolated balanced-cyclic
schedule. No current `diagnose.sh` phase or legacy bundle writes this format.

## Bind the phase before executing attempts

The phase manifest binds:

- A fresh 32-character generation
- The workload contract version, ID, and digest
- The `balanced-cyclic-v1` CPU order, seed, target CPUs, rounds, and exact plan digest
- The total number of scheduled attempts
- The inherited singleton-affinity method and absolute `taskset` path

The schedule is rebuilt during validation. Changed CPUs, rounds, seed, plan
bytes, algorithm, execution method, or workload identity invalidate the
manifest instead of silently changing the experiment on resume.

## Bind each attempt to one schedule slot

Each attempt envelope records the phase generation, schedule digest, workload
binding, ordinal, round, position, and CPU. It embeds one canonical
[attempt record](attempt-records.md) plus that record's byte length and SHA-256
digest.

Only evidence with a valid workload outcome can occupy a schedule slot.
Launch errors, cancellation, unresolved terminal races, or incomplete cleanup
remain reviewable attempt evidence but do not advance the phase frontier.

## Resume from one exact prefix

Resume validation accepts only ordinals `1..N` in the exact deterministic
order. It rejects gaps, reordering, duplicate slots, CPU substitutions,
schedule changes, workload changes, and record or digest tampering. The next
slot comes from the validated schedule rather than from caller-supplied state.

The internal store uses this layout inside a caller-owned private directory:

| Path | Meaning |
| --- | --- |
| `exact-cpu-phase.json` | Exclusive canonical phase manifest |
| `exact-cpu-attempt-NNNNNNNNN.json` | One exclusive canonical attempt envelope per ordinal |

Publication uses synchronized private temporary files and an atomic
no-clobber link point. A reader reconciles a dead writer's known temporary
file, refuses a live writer, rejects unknown files, and rereads the complete
exact prefix after every commit. The store caps one phase at 65,536 attempts,
8 MiB per envelope, and 256 MiB in aggregate.

The store prevents overwrite and conflicting publication, but it is not an
execution lock. A future bundle owner must hold one exclusive writer lease
across choosing, running, and committing the next attempt. This format still
does not authorize resume for a schema-1 or schema-2 bundle.

## Keep affinity outside workload identity

CPU selection is phase execution context, not part of the command contract.
The bounded runner starts its stable supervisor with a singleton CPU mask; the
workload then inherits that mask and is launched directly with its original
executable, argument array, working directory, and environment. Both the
supervisor and direct workload mask are checked before an attempt can become
valid evidence.

This keeps one workload digest stable across every CPU while avoiding shell
interpolation or a CPU-specific wrapper masquerading as the workload.

See [ADR 0009](../decisions/0009-exact-cpu-phase-envelopes.md) for the accepted
format and compatibility decision.
