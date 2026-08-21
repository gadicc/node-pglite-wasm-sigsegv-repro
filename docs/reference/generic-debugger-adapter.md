# Understand the supervised generic debugger adapter

The internal debugger attempt runner executes one generic debugger attempt
under the established Node process-group supervisor. It never launches GDB
directly, never uses the historical shell supervisor, and adds no public
command, attempt envelope, or durable bundle artifact.

## Layer the responsibilities

One attempt involves four pieces:

- the [phase manifest](generic-debugger-phase.md) binds the workload,
  debugger provenance, schedule, and fixed command profile;
- the materialized command profile supplies the exact shell-free GDB argv and
  the embedded control-emitting Python profile;
- the stable internal adapter (`diagnose-lib/debugger-adapter.mjs`) runs as
  the supervised process-group member and owns debugger launch and channel
  routing; and
- the parent runner (`diagnose-lib/debugger-attempt-runner.mjs`) combines the
  established attempt runner's lifecycle result with the
  [bounded attempt-I/O](generic-debugger-attempt-io.md) capture of the two
  output channels.

## Deliver the launch package privately

The runner materializes an internal adapter workload whose command is the
Node interpreter plus the adapter module; its provenance files cover every
module the adapter loads. The supervisor revalidates that provenance
immediately before the adapter starts.

The adapter's configuration travels as a bounded stdin payload through the
version-4 supervisor launch protocol. It never appears in arguments,
environment, or files, and the adapter's own environment stays empty.

The payload carries a single workload launch capsule as the adapter's only
workload authority: the exact public workload identity, the private
environment values, and — only for HMAC-bound workloads — the environment
binding key. Resolving the capsule revalidates the workload digest against
the public fields and every environment value against its digest-covered
binding HMAC, so the project's HMAC-bound custom workloads keep their digest
and substituted private values fail closed. Nothing is re-resolved from a
spec.

## Revalidate provenance at the last moment

The adapter trusts nothing it receives: it resolves the workload from the
delivered spec, validates the manifest against that resolution, rebuilds the
fixed command descriptor, and revalidates the target and debugger executables
immediately before spawning GDB. A drifted target or debugger stops the
attempt with a typed single-line transcript record and a nonzero adapter exit
before any debugger process exists.

## Keep the two channels and two lifecycles separate

The adapter launches GDB shell-free with the materialized argv. Combined GDB
stdout and stderr forward to the adapter's stdout (the transcript channel);
the profile's private control descriptor forwards to the adapter's stderr
(the control channel). The adapter never interprets control bytes.

The parent captures two distinct results:

- the adapter's attempt-runner result — supervisor and adapter identities,
  deadline, cleanup escalation, and exit status; and
- the bounded attempt-I/O capture — transcript and control channel evidence
  plus the parsed [control protocol](generic-debugger-control.md) result.

A debugger that stays silent or emits garbage leaves the control channel
invalid without faking completion. A valid `profile-error` sequence remains
complete control evidence. The debugger's own completion is adapter-lifecycle
evidence: a valid control transcript followed by a nonzero or signaled
debugger exit still leaves the adapter operationally unsuccessful. Partial,
overflowed, invalid, or incompletely drained channels never qualify as a
complete attempt.

## Remaining boundaries

[Complete-only attempt envelopes](generic-debugger-attempt-envelopes.md) and
their durable artifact store bind one successful attempt into a canonical
record. Schema-3 bundle integration, read-only summaries, and a public
command remain later steps. Until they exist, the supervised adapter is
exercised only by synthetic tests with a harmless finite fake-debugger
fixture; no test launches GDB.
