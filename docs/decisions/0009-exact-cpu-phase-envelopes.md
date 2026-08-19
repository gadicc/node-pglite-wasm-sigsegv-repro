# Architecture decision 0009: Bind exact-CPU attempts to one deterministic phase

Status: Accepted

## Context

The generic attempt record deliberately has no CPU, schedule ordinal, phase
generation, or resume authority. The existing isolated protocol already has a
deterministic balanced-cyclic plan, but its workload-specific state format
cannot become the generic bundle contract. Treating `taskset` plus a CPU as the
workload command would also create a different workload identity for every CPU.

## Decision

Introduce separately versioned internal exact-CPU phase manifests and attempt
envelopes.

The manifest binds one resolved workload, phase generation, affinity method,
`taskset` path, CPU set, round count, seed, schedule algorithm, exact plan
binding, and schedule digest. Each attempt envelope binds one canonical valid
attempt record to the manifest's workload, generation, schedule digest, and
exact ordinal/round/position/CPU slot.

Resume accepts only an exact contiguous prefix of the deterministic plan.
Operationally invalid attempts remain evidence but do not occupy a slot or
advance the prefix.

CPU affinity is execution context outside the workload identity. The runner
starts its stable supervisor with a singleton mask, verifies that mask, then
directly launches and verifies the workload that inherits it. The workload's
executable and argument array never enter a shell program string.

This format remains internal until a separate durable publication adapter and
schema-3 bundle contract exist. Schema-1 and schema-2 bundles retain their
original formats and readers.

## Consequences

- One workload digest can be compared across every scheduled CPU.
- CPU order and resume position are reviewable and tamper-evident.
- A failed harness operation cannot reduce the planned sample count by
  consuming a schedule slot.
- The existing isolated schedule implementation is reused without teaching
  legacy bundle readers a new meaning.
- Phase storage must later publish the manifest and attempt envelopes
  transactionally before a public generic command can resume them.

## Acceptance criteria

- Tests prove deterministic scheduling and changed-seed identity.
- Tests reject workload, generation, plan, slot, record, and binding tampering.
- Tests reject gaps and reordering in a resumed prefix.
- A harmless process demonstrates and reports the requested singleton CPU.
- Operationally invalid attempts do not advance the schedule.
- No current bundle schema or public CLI behavior changes.
