# Understand internal attempt records

Attempt-record version 1 is the internal evidence boundary between the generic
workload runner and future phase envelopes. No current `diagnose.sh` phase
writes this format, and legacy schema-1 or schema-2 bundles must not acquire it.

## Bind one resolved workload

Each record stores the workload contract version, stable workload ID, and
canonical workload digest. A record validates only against the exact resolved
workload that produced it. Command, argument, environment-policy, provenance,
lifecycle, mapping, or capability changes therefore invalidate the binding.

## Preserve raw and normalized outcomes

The record retains:

- Monotonic attempt, workload-start, terminal-choice, and cleanup boundaries
- Bound supervisor and workload process identities
- Raw exit code or process signal
- The terminal reason and recomputed typed outcome
- TERM, KILL, process-group drain, output drain, and supervisor-completion evidence
- Full observed byte counts and SHA-256 digests with bounded output excerpts

Deserialized records are accepted only when their normalized outcome exactly
matches a fresh classification of the raw observation. Planned cleanup signals
remain in cleanup status and never become authoritative workload outcomes.

## Fail closed on inconsistent evidence

Validation rejects unknown fields and versions, workload mismatches,
non-monotonic boundaries, malformed identities, premature TERM-to-KILL
escalation, inconsistent cleanup summaries, non-canonical output excerpts, and
changed full-content digests when the complete output fits in its excerpt.

Canonical JSON-line bytes and their digest/length binding are consumed by the
internal [exact-CPU phase envelope](exact-cpu-phase-envelopes.md). The attempt
record itself does not provide an ordinal, phase generation, schedule binding,
durable publication transaction, or bundle resume authority; those remain the
responsibility of its owning phase format.

See [ADR 0003](../decisions/0003-attempt-lifecycle.md),
[ADR 0004](../decisions/0004-typed-outcome-evidence.md), and
[ADR 0005](../decisions/0005-versioning-and-schema-3.md) for the accepted
lifecycle and compatibility rules.
