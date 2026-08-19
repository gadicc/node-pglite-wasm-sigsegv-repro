# Understand managed auxiliary workloads

Managed auxiliary workloads are internal long-lived processes that establish a
controlled condition around diagnostic attempts. The first intended use is one
load worker per declared CPU during the B leg of a load-state A/B/A session.
They are infrastructure, not fault observations.

## Reuse bounded supervision

The managed runner uses the same stable supervisor as a diagnostic attempt. It
therefore preserves:

- Shell-free executable and argument-array launch
- Immediate executable, working-directory, and file-provenance revalidation
- Optional singleton CPU placement for supervisor and direct workload
- Deadline and external-cancellation handling
- TERM and KILL grace periods
- Process-group drain checks
- Optional retained bundle-directory ownership

The auxiliary workload must still use the trusted local
[workload contract](../project-direction.md#introduce-a-workload-contract-before-public-commands).

## Wait for verified readiness

The caller supplies a synchronous readiness observer. It runs once, only after
the supervisor and direct workload have bound Linux process identities and the
expected allowed CPU list. Its immutable witness contains:

- A monotonic workload-start boundary
- Supervisor PID, process-group ID, session ID, start ticks, and allowed CPUs
- Direct workload PID, start ticks, and allowed CPUs

Returning a promise or throwing from the observer invalidates the managed run
and starts cleanup. This keeps readiness as an observation, not a second
unbounded control lifecycle.

## Keep managed results out of attempt evidence

Managed result version 1 records workload identity, placement, readiness status
or error, lifecycle boundaries, terminal status, normalized outcome, and
cleanup. It explicitly records `outputMode: "discard"` and contains no output
record.

That shape is intentionally incompatible with the versioned
[diagnostic attempt record](attempt-records.md). A planned external cancellation
of an auxiliary worker is operational lifecycle evidence, not a pass, clean
result, or fault-rate sample.

No public command or current `load-state-aba.mjs` mode uses this internal path
yet. The next controlled-load layer must manage a complete worker set, recheck
the original identities at measurement boundaries, publish only complete
single-workload A/B/A sessions, and retain the existing historical modes
without reinterpretation.

See [ADR 0015](../decisions/0015-managed-auxiliary-workloads.md) for the accepted
boundary.
