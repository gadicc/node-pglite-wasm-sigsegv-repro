# Architecture decision 0030: Publish complete-only debugger attempt envelopes

Status: Accepted

## Context

The supervised debugger adapter (ADR 0029) produces two distinct results per
attempt: the adapter's process-lifecycle record and the bounded attempt-I/O
capture with its parsed control facts (ADRs 0027–0028). A durable debugger
phase still needs a canonical per-attempt record and crash-safe artifacts
before any schema-3 bundle integration.

Transcript and control bytes make one attempt three artifacts, not one.
Partial evidence must never be publishable: an incomplete drain, an invalid
control stream, an overflowed channel, or an unsuccessful adapter lifecycle
cannot describe what happened to the target.

## Decision

Add a versioned, complete-only debugger attempt envelope. One envelope binds:

- the phase generation, canonical manifest digest, scheduled run, and
  per-attempt nonce;
- the target workload binding and the command-descriptor binding;
- the adapter workload binding and its full lifecycle attempt record with
  that record's own binding;
- the bounded transcript and control channel evidence;
- the parsed control facts (inferior identity, terminal event, capture
  witness, or staged operational error); and
- a typed outcome: `clean`, `exited`, `signaled`, `captured`, or `error`
  (with target-signal classification for signals).

An envelope exists only when the attempt is complete: the adapter lifecycle
is operationally successful, both channels drained completely without
overflow, and the control stream parsed. The builder and parser both refuse
anything less, so a stored envelope is always complete evidence.

One private state directory per phase holds the canonical manifest plus, per
run, three artifacts — bounded transcript bytes, canonical control bytes, and
the canonical envelope line, always committed in that order through the
no-clobber state adapter. The envelope is the sole completion marker; orphan
parts from a crashed attempt are never evidence and are cleaned only for the
exact run being recommitted. Runs form a contiguous one-based prefix and the
schedule completes at the manifest's run cap or capture cap.

This decision adds no schema-3 manifest change, no public command, and no
summary support.

## Consequences

- A complete debugger attempt has one canonical, tamper-evident durable form;
  anything else remains process-local diagnostics.
- Envelope-last publication keeps crash windows to bounded, cleanable orphan
  parts; the state-commit recovery table recognizes the debugger prefixes.
- The artifact triple stays within the manifest's 64 MiB transcript and
  64 KiB control bounds; envelopes stay within an 8 MiB store bound.
- Schema-3 bundle integration, summaries, and public orchestration remain
  later boundaries.
