# Architecture decision 0017: Publish only complete controlled-load A/B/A sessions

Status: Accepted

## Context

A controlled-load comparison is meaningful only when the same measured
workload and target CPU are observed before, during, and after one verified
condition-worker interval. Independent leg files do not prove that B was
bracketed by a complete stable worker set, that the set stopped before A2, or
that all attempts used the same singleton target placement.

The historical Node A/B/A and Node-by-warmup modes compare multiple measured
workloads. They cannot be represented as this single-workload session without
changing their meaning.

## Decision

Introduce an internal, complete-only single-workload A1/B/A2 session contract.
Its manifest binds separate measured and auxiliary workload identities, one
target CPU, a disjoint canonical worker CPU set, the absolute `taskset` path,
attempts per leg, and bounded worker warm-up and post-stop recovery intervals.

The adapter runs every measured attempt on the same singleton target CPU. A1
must finish before condition-worker readiness. The exact worker set then
reaches complete readiness, remains identity- and affinity-valid at named
`before-b` and `after-b` boundaries, and stops with complete planned cleanup
before A2 starts. The recorded monotonic boundaries must also prove at least
the declared warm-up and recovery intervals.

Each measured slot binds canonical attempt evidence beside its target-affinity
witness. The complete session envelope binds the worker-set start, both
boundaries, and stop records with canonical byte digests. Operationally invalid
attempts, runner errors, placement drift, early worker termination, incomplete
cleanup, interrupted intervals, missing slots, or temporal reordering produce
no session envelope.

The adapter still returns bounded operational detail after an incomplete run
so an owner can report or recover it, but only the complete envelope is phase
evidence. This layer does not modify `load-state-aba.mjs`, publish bundle state,
change schema 3, or reinterpret historical multi-workload results.

## Consequences

- A later schema-3 phase can bind one indivisible A1/B/A2 comparison rather
  than three independently publishable legs.
- The load condition is attributable to the exact original worker identities,
  not merely to process names or a final worker count.
- All measured samples retain the same target-CPU placement across conditions.
- Warm-up and recovery declarations become evidence-backed minimum intervals.
- Historical Node comparison and GDB modes remain on their existing evidence
  path until a separate multi-workload contract is designed.
- Durable complete-session storage, phase ownership, and schema-3 integration
  remain the next internal layer.

## Acceptance criteria

- Manifests reject overlapping target and worker CPUs and bind both workloads.
- Every leg contains the exact scheduled count of valid, target-affinity-bound
  attempts in A1, B, A2 order.
- Worker readiness follows A1; both named boundaries bracket B; complete stop
  and the recovery interval precede A2.
- Any incomplete attempt or worker lifecycle publishes no session envelope.
- Automated coverage uses only harmless finite and waiting fixtures.
