# Architecture decision 0026: Bind a generic debugger phase before execution

Status: Accepted

## Context

The historical debugger phase launches GNU Debugger (GDB) around `child.mjs`,
publishes schema-2 paths and completion markers, and interprets a
Node/PGlite-specific fault signature. Its process and transcript handling remain
valuable, but its evidence meaning cannot be copied into a generic schema-3
bundle.

Workload-contract version 1 already records whether debugger capture applies
and which direct signals are target outcomes. It does not bind the debugger
executable, capture schedule, transcript profile, or debugger-specific timeout
and cleanup policy.

## Decision

Add an internal debugger-phase manifest version 1 before implementing any live
generic debugger runner. The manifest binds:

- the exact resolved workload contract version, ID, and digest;
- a canonical, hashed, executable GDB file identity;
- a fixed versioned batch-command and transcript profile;
- the workload's declared target signals;
- one logical CPU and bounded maximum run and capture counts;
- inherited singleton affinity and the `taskset` path; and
- explicit per-run timeout, TERM grace, and KILL grace intervals.

The phase requires `capabilities.gdb: true` and at least one declared target
signal. The schedule is deterministic and sequential on one CPU. Canonical
manifest bytes and their SHA-256/length binding are available to a future
schema-3 bundle variant.

Stored parsing validates the complete manifest without requiring the recorded
GDB binary to remain installed. A separate launch-provenance check reopens and
rehashes that canonical path immediately before any future execution. This
keeps old evidence inspectable while refusing a changed executable on resume.

This decision adds no public command, runs no debugger, creates no bundle, and
does not change schema-3 manifest versions 1 through 5.

## Consequences

- Generic debugger work begins from a workload-bound contract instead of the
  legacy PGlite result grammar.
- GDB upgrades do not make stored manifests structurally unreadable, but they
  require a new bundle before another live run.
- Transcript classification, the bounded runner, phase envelopes, durable
  storage, schema-3 integration, summaries, and public orchestration remain
  separate reviewable steps.
- Existing legacy debugger evidence and commands retain their original meaning.
