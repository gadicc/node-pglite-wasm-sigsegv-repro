# Understand complete-only generic debugger attempt envelopes

The internal debugger attempt envelope is the canonical per-attempt record
for a future schema-3 debugger phase. It is built from one
[supervised adapter](generic-debugger-adapter.md) attempt and exists only
when that attempt is complete. A companion store publishes each attempt's
artifacts durably. Nothing here creates bundle state or adds a public
command.

## Bind one attempt completely

`diagnose-lib/debugger-attempt-envelope.mjs` builds a versioned frozen
envelope binding:

- the phase generation, canonical manifest digest, scheduled run, and
  per-attempt nonce;
- the target workload binding and the command-descriptor binding;
- the adapter workload binding and its full lifecycle attempt record, with
  that record's own SHA-256 and byte count;
- the bounded transcript and control channel evidence; and
- the parsed [control protocol](generic-debugger-control.md) facts — inferior
  identity, terminal event, capture witness, or staged operational error.

The typed outcome is `clean`, `exited`, `signaled`, `captured`, or `error`,
with target-signal classification for direct signals and captures. A
capture-stage error keeps the stopped-signal observation separate from the
error, exactly as the control facts record it.

## Refuse anything incomplete

The builder and parser share one rule: an envelope exists only when the
adapter lifecycle is operationally successful, both I/O channels drained
completely without overflow, and the control stream parsed. Partial,
overflowed, invalid, or incompletely drained input throws
`INCOMPLETE_DEBUGGER_ATTEMPT` at build time and fails parsing at read time,
so no stored envelope can masquerade as complete evidence.

## Publish three artifacts, envelope last

`diagnose-lib/debugger-attempt-store.mjs` keeps one private state directory
per phase: the canonical manifest line, then per run a transcript part, a
control part, and the canonical envelope line. Publication commits the
transcript, then the control, then the envelope through the no-clobber state
adapter, so the envelope is the sole completion marker. A crash can only
leave bounded orphan parts; they are never evidence and are cleaned only for
the exact run being recommitted.

Reads revalidate everything: the manifest byte-equals its canonical line,
envelope runs form a contiguous one-based prefix, each envelope parses, the
control bytes reparse to the envelope's control facts, and both byte parts
hash to the envelope's channel evidence. Runs complete at the manifest's run
cap or capture cap; out-of-order, duplicate, foreign, and tampered artifacts
fail closed.

## Remaining boundaries

A schema-3 bundle variant with lease integration, read-only summaries, and a
public command remain later steps. Until they exist, envelopes and stores are
exercised only by synthetic tests against the harmless fake-debugger fixture;
no test launches GDB or a fault workload.
