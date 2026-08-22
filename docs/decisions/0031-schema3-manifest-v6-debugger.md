# Architecture decision 0031: Debugger-focused schema-3 manifest v6

Status: Accepted

## Context

The generic debugger stack now has a bound phase manifest (ADR 0026), a
structured control protocol (ADR 0027), bounded attempt I/O (ADR 0028), a
supervised adapter (ADR 0029), and complete-only attempt envelopes with
durable artifacts (ADR 0030). Executing a debugger phase inside a bundle
still needs a bundle manifest that binds the debugger phase beside the
exact-CPU phase, plus an owner that runs attempts under one exclusive lease.

## Decision

Add immutable schema-3 bundle manifest version 6, the debugger-focused
exact-CPU variant. Version 6 binds one target workload that declares both the
isolated and gdb capabilities, the exact-CPU phase context, and the debugger
phase manifest, each canonically. It owns exactly two private state
directories, `state/exact-cpu` and `state/debugger`, and never carries the
controlled-load auxiliary workload or controlled-load state. Composing
debugger capture with controlled load would be a later, explicitly separate
manifest version. Versions 1 through 5 keep their exact accepted shapes;
older parsers do not silently accept the new fields.

A dedicated owner runs one debugger attempt per call while holding the bundle
lease continuously across: the authoritative bundle/state reread, selection
of the next run from the committed prefix, fresh per-attempt nonce
generation, the supervised adapter launch, complete-only envelope
construction, the transcript/control/envelope commit, and the final reread.
An attempt that cannot complete publishes nothing, disposes its process-local
handles, and never advances the durable prefix. A retry of the same scheduled
run uses a new nonce and cleans only that run's bounded orphan parts while
holding the lease; no writer can race an in-progress triple publication. The
phase completes at the manifest's run cap or capture cap, and initialization
and complete-state rereads are idempotent.

The environment binding key and private environment values pass only through
process-local launch options and capsules. The harness never serializes them
into the bundle manifest, the debugger manifest, envelopes, summaries,
arguments, or logs. Workload and debugger output is a different boundary: the
transcript artifact retains it verbatim, and it can contain values the
workload itself prints.

The read-only schema-3 summary accepts version 6 and reports debugger run and
capture progress. Public debugger command orchestration and debugger-specific
summary fields remain Roadmap 6.

## Consequences

- Debugger capture gains the same exclusive-ownership, complete-only, and
  crash-recovery guarantees as the earlier phase variants.
- v6's exact accepted shape means a v1–v5 bundle can never be reinterpreted
  as a debugger bundle, and a v6 bundle can never grow controlled-load or
  auxiliary state.
- Sibling exact-CPU state and resume semantics are unchanged.
- A public debugger command and user-facing debugger summaries remain the
  only remaining roadmap boundary.
