# Architecture decision 0027: Separate debugger control evidence from transcripts

Status: Accepted

## Context

The generic debugger-phase manifest binds a fixed capture profile, but a future
runner still needs to distinguish debugger lifecycle evidence from arbitrary
debugger and workload output. Parsing human-readable GDB text for process
identity, affinity, terminal state, or completion would make those decisions
dependent on presentation details and unbounded output.

A control channel can also fail independently of the transcript. Missing or
reordered records must not be repaired from plausible-looking text, and a
capture failure must not erase an already observed workload stop.

## Decision

Use a private, bounded, versioned stream of canonical JSON records as the
debugger control protocol. Every record binds:

- the debugger-phase generation and canonical manifest digest;
- one scheduled run ordinal;
- one unpredictable per-attempt nonce; and
- a contiguous one-based sequence number.

The accepted state machine begins with `profile-ready`, then records either a
stable inferior identity and singleton CPU witness or a launch-stage error. A
started inferior records exactly one exit, direct signal, stop, or
observe-stage error. A stop requires either the manifest's exact capture-section
list or a capture-stage error. Every terminal path ends with
`profile-complete`.

The protocol preserves inferior terminal state, capture completion, and
operational error as separate fields. In particular, a capture-stage error
does not replace the preceding stopped-signal observation.

Control input is valid only when it is canonical newline-delimited UTF-8,
within the 64 KiB and eight-record limits, and exactly follows the bound state
machine. Unknown fields, unknown signals, noncanonical values, affinity drift,
binding mismatches, omissions, duplicates, and records after completion fail
closed.

This decision defines parsing and evidence binding only. It does not launch
GDB, expose a public command, or publish a bundle artifact.

## Consequences

- Human-readable transcript bytes remain useful diagnostic evidence but are
  not an authority for lifecycle or completion.
- A future runner must give its fixed command profile a dedicated control
  descriptor and capture those bytes separately from stdout and stderr.
- Only a complete valid control sequence can support a complete phase
  envelope; partial bytes remain operationally invalid.
- Raw transcript limits, runner cleanup evidence, typed phase outcomes,
  complete-only storage, and schema-3 integration remain later boundaries.
