# Architecture decision 0016: Bind controlled-load worker sets

Status: Accepted

## Context

A load-state B leg depends on a complete set of long-lived condition workers,
not on whichever workers happen to remain at the end. Every declared load CPU
must reach verified readiness, and the same process identities and singleton
CPU placement must remain valid at both measurement boundaries.

Individual managed-workload results provide safe lifecycle evidence, but do not
establish all-or-nothing set readiness, peer cancellation, boundary identity,
or a complete stop record.

## Decision

Introduce an internal controlled-load worker-set controller. One resolved
trusted auxiliary workload with `survive-window` semantics is launched once per
canonical sorted CPU through independent managed supervisors. The set becomes
running only after every worker reports identity-bound singleton readiness.

Start evidence binds the auxiliary workload digest, `taskset` path, discarded
output mode, CPU list, common ready boundary, and every supervisor and direct
workload identity. A named boundary check rereads the original process
identities and allowed CPU lists; it never substitutes a replacement process.

Any launch failure, early terminal status, external cancellation, or boundary
mismatch invalidates the set and cancels every active peer. Stop evidence binds
one parsed managed-workload result or runner error to every CPU and is valid
only when all ready workers end through planned cancellation with complete
group and output cleanup.

The start, boundary, managed-result, and stop records have strict versioned
parsers and canonical line encodings. A stable supervisor may retain the bundle
directory descriptor. If the outer owner is interrupted, the lease remains
active until supervisor parent-loss cleanup finishes, while the direct worker
does not inherit that descriptor.

This controller is internal. It does not run `/usr/bin/yes` or another live load
program in automation, alter the current `load-state-aba.mjs`, publish an A/B/A
session, or add schema-3 state.

## Consequences

- A future B leg can prove that the exact original worker set bracketed its
  measured attempts.
- Replacing a worker after readiness cannot silently satisfy a later boundary.
- One worker failure invalidates the correlated condition instead of reducing
  its worker count.
- The same bundle lease can cover worker start, target attempts, worker stop,
  and eventual whole-session publication.
- The next layer still needs a single-workload A1/B/A2 manifest, attempt slots,
  complete-session envelope, durable store, and schema-3 integration.

## Acceptance criteria

- Start requires every declared CPU and rejects duplicate or noncanonical CPU
  lists.
- Start and boundary records preserve exact PID, start ticks, and singleton CPU
  identity for every worker.
- Early termination, affinity drift, identity drift, and external cancellation
  invalidate the set and cancel peers.
- Valid stop evidence contains complete parsed managed results for every CPU.
- Interrupted-owner coverage proves lease retention through cleanup and proves
  that the direct auxiliary workload receives no bundle descriptor.
- Automated coverage uses harmless waiting fixtures only.

[ADR 0023](0023-public-controlled-load-command.md) later composes this
controller into the public single-workload controlled-load command without
changing the worker-set records.
