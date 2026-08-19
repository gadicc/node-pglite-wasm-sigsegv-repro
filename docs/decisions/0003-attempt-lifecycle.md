# Architecture decision 0003: Bound every workload attempt

Status: Accepted

## Context

Node/PGlite attempts normally exit. The recommended `wasm-churn` workload intentionally runs until it faults, reports corruption, or the harness ends its observation window. Treating both workloads as ordinary child processes would either hang forever or misclassify harness-generated termination as a fault.

Cleanup also races with natural process exit, external interruption, and descendant shutdown. Evidence must identify which event ended the observation and whether cleanup completed.

## Decision

Every workload attempt has a hard execution deadline and a separate bounded cleanup deadline.

The workload contract selects one completion mode:

- `exit`: The workload must exit naturally before its execution deadline. Reaching the deadline is operationally invalid.
- `survive-window`: Remaining alive at the monotonic deadline is a valid observed outcome, subject to confirmed cleanup. Natural exit before that point uses its raw exit or signal status.

At the deadline, the runner establishes one terminal-event linearization point. An already available natural status wins. Otherwise, the runner verifies the bound process identity is live before recording `observation-window-elapsed` and starting harness-owned termination. If it cannot resolve the race, it records an operationally invalid attempt.

External cancellation always records an operationally invalid attempt. It never counts as successful survival. Harness-generated `SIGTERM` and `SIGKILL` statuses are cleanup evidence, not workload outcomes.

Cleanup sends `SIGTERM`, waits for the configured grace period, sends `SIGKILL` when needed, and verifies that the supervised process group has drained. The runner commits no workload observation until cleanup succeeds. Privileged callers must retain recovery authority when cleanup cannot be confirmed.

## Consequences

The bounded lifecycle has these consequences:

- Survival is a first-class outcome instead of a timeout error.
- An attempt can finish its execution window but still fail operationally during cleanup.
- Attempt records need monotonic boundaries, terminal reason, raw process status, and cleanup status.
- Output capture must remain bounded while pipes continue draining.

## Acceptance criteria

This decision is satisfied when:

- Tests cover natural exit, direct signal, deadline survival, deadline failure in `exit` mode, and external cancellation.
- Tests cover a fault racing the deadline and require either one deterministic outcome or `operational-invalid`.
- Tests cover `SIGTERM` resistance, descendant cleanup, retained output descriptors, and cleanup deadline exhaustion.
- No controller wait remains unbounded after an execution or cleanup deadline.
- Planned termination never appears as a workload signal in authoritative evidence.
