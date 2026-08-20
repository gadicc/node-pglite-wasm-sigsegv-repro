# Architecture decision 0028: Bound debugger attempt I/O before execution

Status: Accepted

## Context

The generic debugger control protocol separates lifecycle records from
presentation-oriented debugger and workload output. A future supervised runner
still needs to retain those byte streams without placing a large transcript in
memory, granting the target access to a bundle directory, or treating partial
input as complete evidence.

Transcript limits and stream cleanup interact. Stopping reads at the evidence
limit can leave output descriptors open and make process cleanup ambiguous.
Continuing to store bytes after the limit can instead exhaust local storage.

## Decision

Collect generic debugger-attempt output through two distinct parent-side
channels:

- one human-readable transcript channel, limited by the phase manifest's fixed
  64 MiB transcript profile; and
- one structured control channel, limited by the control protocol's fixed
  64 KiB bound.

Retain the transcript in a private regular file that is unlinked immediately
after creation. Only the parent keeps its descriptor. The target receives no
scratch or bundle-directory descriptor. Keep the bounded control bytes in
memory and validate them only with the versioned control-protocol parser.

After either limit is reached, continue draining and hashing accepted input
bytes while discarding bytes beyond the retained bound. Record the total
observed byte count, digest, retained byte count, overflow flag, channel
status, and stable error code. Stream errors, storage errors, overflow, and
invalid control are distinct incomplete states. A valid `profile-error` record
is complete control evidence and remains separate from these I/O failures.

Expose retained transcript bytes through a descriptor-backed chunk iterator
and control bytes through a copy. The internal capture owner must dispose the
descriptor after complete-only publication or failure handling.

This decision adds no process launch, public command, phase state, or durable
bundle artifact.

## Consequences

- Large presentation transcripts do not occupy proportional JavaScript heap.
- Over-limit attempts still drain both channels, so later supervised cleanup
  can distinguish output completion from process-group cleanup.
- Human-readable text cannot repair missing, malformed, or incomplete control
  evidence.
- Partial bytes remain available to the current process for diagnostics but
  cannot qualify as a complete attempt.
- The next layer can connect these channels to the established supervisor and
  then define typed attempt envelopes and complete-only storage separately.
