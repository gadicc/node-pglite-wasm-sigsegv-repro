# Understand controlled-load A/B/A sessions

The internal controlled-load session adapter produces one complete comparison
for one measured workload:

1. **A1:** measured attempts without the condition workers
2. **B:** measured attempts bracketed by the same verified worker set
3. **A2:** measured attempts after complete worker cleanup and recovery

This is a complete-only evidence contract. A partial leg or condition interval
can be reported as an operational failure, but cannot become a session
envelope.

## Manifest identity

The version-1 manifest binds:

- Separate measured and auxiliary workload contract IDs and digests
- One singleton target CPU for every measured attempt
- A sorted worker CPU set that excludes the target CPU
- The absolute `taskset` path and discarded worker-output policy
- A fixed A1, B, A2 schedule and attempts per leg
- Minimum worker warm-up and post-stop recovery intervals
- One phase generation and schedule digest

The auxiliary workload must use `survive-window` lifecycle semantics. The
measured workload may use its declared diagnostic lifecycle and outcome map.

## Complete temporal bracket

Canonical monotonic timestamps establish this order:

```text
A1 cleanup
  < complete worker readiness
  < declared warm-up < before-b
  < all B attempts < after-b
  < complete worker stop
  < declared recovery < A2
```

The `before-b` and `after-b` records reread the original supervisor and direct
workload PID, start ticks, group/session placement, and singleton allowed CPU
list. Replacements do not satisfy the session.

Every measured slot stores canonical attempt evidence plus a separate affinity
witness for the manifest target CPU. This mirrors the existing exact-CPU phase:
placement is execution evidence and is not added to the canonical attempt
record itself.

## Failure and cleanup behavior

A1 failure prevents condition workers from starting. Any B attempt or boundary
failure cancels and fully accounts for the worker set. A2 starts only after a
valid planned stop and the recovery interval; an A2 failure still prevents the
whole session from being published.

External cancellation, runner errors, invalid attempt outcomes, worker drift,
early terminal status, cleanup failure, interval interruption, binding drift,
or temporal reordering all return no complete envelope. Retained bundle
ownership can span attempts and managed workers, but the direct workloads do
not inherit the bundle directory descriptor.

The internal [complete-only phase store](controlled-load-phase-storage.md) and
schema-3 manifest-v5 owner now consume this contract. No public command does.
The existing `load-state-aba.mjs` modes and their historical multi-workload
evidence remain unchanged.

See [ADR 0017](../decisions/0017-controlled-load-aba-sessions.md) for the
accepted boundary.
