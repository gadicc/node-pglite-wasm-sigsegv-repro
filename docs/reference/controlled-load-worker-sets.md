# Understand controlled-load worker sets

The internal worker-set controller turns several
[managed auxiliary workloads](managed-auxiliary-workloads.md) into one verified
controlled condition. Its first intended consumer is the load-on B leg of a
single-workload A/B/A session.

## Start the complete set

The controller takes one trusted resolved auxiliary workload with
`survive-window` semantics, a sorted CPU list, and an absolute `taskset` path.
It starts one independent managed supervisor per CPU and does not report the set
as running until every direct workload has a bound identity and exact singleton
allowed CPU list.

Version-1 start evidence records:

- Auxiliary workload contract version, ID, and digest
- `taskset` path and discarded-output policy
- Canonical worker CPU list
- Common complete-readiness boundary
- Per-worker supervisor PID, process-group ID, session ID, start ticks, and CPU
- Per-worker direct workload PID, start ticks, and CPU

If any worker finishes or fails before complete readiness, the controller
cancels the rest and returns no running handle.

## Recheck the original identities

A named boundary check rereads `/proc` for each recorded supervisor and direct
workload. The PID, start ticks, group/session placement, and allowed CPU list
must still match the start evidence. A replacement process with a reused PID
does not pass because its start ticks differ.

The controller invalidates and cancels the set on any identity or affinity
mismatch. A future A/B/A envelope will require checks immediately before and
after its measured B leg.

## Stop and account for every worker

Stopping aborts every managed worker and waits for all supervisor cleanup.
Version-1 stop evidence binds each CPU to either a parsed managed-workload
result or a canonical runner error. A valid stop requires every ready worker to
show planned external cancellation, complete cleanup, a drained process group,
and its original start identity and singleton affinity.

The start, boundary, and stop shapes have strict parsers and canonical line
encodings for later phase-envelope binding. They are not themselves diagnostic
attempts and contribute nothing to fault-rate denominators.

The controller can pass the bundle owner's retained directory descriptor to
each stable supervisor. The direct condition workload does not receive it. If
the outer owner is interrupted, replacement ownership remains unavailable only
until those supervisors finish bounded parent-loss cleanup.

No public command or current controlled-load bundle writes these records yet.
The next layer is a complete single-workload A1/B/A2 session contract; the
historical multi-Node modes remain separate.

See [ADR 0016](../decisions/0016-controlled-load-worker-sets.md) for the accepted
worker-set boundary.
