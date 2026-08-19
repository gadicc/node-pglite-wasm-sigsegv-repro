# Architecture decision 0015: Separate managed auxiliary workloads

Status: Accepted

## Context

A generic controlled-load session needs condition workers that remain active
across several diagnostic workload attempts. The harness must know that each
worker reached a bound process identity and singleton CPU placement before a
measured leg begins, and it must stop every worker before releasing bundle
ownership.

These workers are not diagnostic attempts. Their intentionally unbounded
output must not pass through evidence pipes, and their planned cancellation
must not enter workload fault-rate denominators. Treating them as ordinary
attempt records would erase that distinction.

The historical Node A/B/A and Node-by-warmup modes also change the measured
executable. They cannot enter the current one-workload schema merely because
they share the same external-load controller.

## Decision

Add a distinct internal managed-workload runner on the existing stable attempt
supervisor. It accepts a resolved trusted auxiliary workload, applies the same
shell-free launch, provenance revalidation, optional singleton affinity,
bounded deadline, cancellation, process-group cleanup, and retained-directory
ownership as a diagnostic attempt.

Managed execution differs in two deliberate ways:

- Standard output and standard error go directly to the null device rather
  than evidence pipes.
- A synchronous readiness observer runs only after the supervisor and direct
  workload identities and allowed CPU lists have been validated.

The returned managed-workload result has its own version and records the
`discard` output policy, readiness status or error, workload digest, placement,
boundaries, process identities, terminal observation, normalized outcome, and
cleanup. It omits the canonical attempt-result version and output record, so
the attempt-evidence builder rejects it.

An observer that throws, returns an asynchronous value, or receives an
unbound workload identity makes the managed execution operationally invalid
and triggers bounded cleanup. An already-cancelled request launches nothing.

This is a lifecycle foundation only. It does not start the historical load
program in automation, publish a controlled-load phase envelope, add a public
command, or admit multi-workload comparisons to schema 3.

## Consequences

- A future load-worker set can wait for verified readiness without polling an
  unrelated process or parsing unbounded output.
- Auxiliary worker output cannot consume controller memory or masquerade as
  captured diagnostic output.
- Active supervisors can retain the bundle lease through outer-owner
  interruption while their existing parent-loss cleanup runs.
- Load-state A/B/A may later bind one measured workload; historical Node A/B/A
  and Node-by-warmup evidence remain on their separate multi-workload path.
- A controlled-load phase still needs a worker-set manager, boundary witnesses,
  whole-session envelopes, durable state, and schema-3 integration.

## Acceptance criteria

- Readiness exposes bound supervisor and workload identities plus exact allowed
  CPU lists.
- Singleton placement is witnessed before readiness is reported.
- Cancellation drains the complete process group within configured bounds.
- Managed output is discarded and absent from the managed result.
- Managed results are rejected by the canonical attempt-evidence builder.
- Invalid readiness observers stop the workload and return operationally
  invalid lifecycle evidence.
- Automated coverage uses only harmless lifecycle fixtures.
