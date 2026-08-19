# Architecture decision 0011: Persist complete baseline waves

Status: Accepted

## Context

A baseline wave launches several copies of one workload concurrently. Those
children are not independent schedule slots: the wave is one correlated trial,
and a controller or cleanup failure affecting one child can invalidate the
conditions observed by its peers.

The exact-CPU phase envelope binds one attempt to one scheduled CPU. Reusing it
for baseline execution would lose the wave boundary and could let a partial
wave advance the experiment. The legacy PGlite log format cannot become the
generic workload-bound schema.

## Decision

Introduce a separately versioned internal baseline phase manifest and wave
envelope. The manifest binds one resolved workload with declared baseline
capability, a fresh phase generation, the independent-supervisor concurrency
mode, children per wave, wave count, total attempt count, and a canonical
schedule digest.

Every wave envelope binds the phase generation, workload digest, schedule
digest, wave ordinal, child count, and exactly one canonical attempt record for
each deterministic child position. Each child attempt retains its raw process
status, normalized outcome, lifecycle boundaries, bounded output, and cleanup
evidence.

A wave can occupy its schedule slot only when every child attempt has a valid
workload outcome and complete cleanup. A runner or operational failure cancels
still-active peers through their shared abort signal. The returned attempt
records remain reviewable, but the wave does not advance.

The durable phase store publishes one immutable manifest followed by an exact
contiguous prefix of no-clobber whole-wave files. It recovers only known
dead-writer temporary files and rejects gaps, unknown entries, live writers,
changed manifests, and noncanonical evidence. The store is not an execution
lock; a schema-3 bundle owner must hold its exclusive lease around selecting,
running, and committing a wave.

This phase remains internal. It neither starts a live diagnostic workload in
automation nor changes the public Node/PGlite baseline.

## Consequences

- Baseline rates retain their correlated wave denominator.
- Partial or operationally invalid waves cannot reduce the planned sample count.
- Child positions and the complete workload identity remain reviewable on resume.
- Schema-3 manifest version 1 remains unchanged; manifest version 2 binds this
  phase alongside exact-CPU state.
- CPU-group screening can reuse the whole-wave evidence model but needs a
  separate topology and affinity-mask schedule contract.

## Acceptance criteria

- Tests prove canonical schedule identity, workload binding, child-slot binding,
  and whole-wave prefix resume.
- Tampered slots, records, bindings, generations, schedules, and manifests fail
  validation.
- One invalid child prevents publication and cancels still-active peers.
- Durable tests cover idempotent initialization, exact restart, duplicate and
  out-of-order commits, dead-writer recovery, live-writer refusal, gaps, and
  foreign files.
- A harmless finite workload completes a real multi-child wave.
- No public command, legacy bundle, or live diagnostic automation changes.
