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

The adapter's configuration — workload spec, manifest, and attempt context —
travels as a bounded stdin payload through the version-4 supervisor launch
protocol. It never appears in arguments, environment, or files. The adapter's
own environment contains exactly the values that pass-style target environment
names resolve to, so the adapter re-resolves the workload specification and
reproduces its digest while nothing else from the operator environment
reaches it.

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
complete control evidence. Partial, overflowed, invalid, or incompletely
drained channels never qualify as a complete attempt.

## Remaining boundaries

Typed complete-only debugger attempt envelopes, durable artifacts, a schema-3
bundle variant, summaries, and a public command remain later steps. Until
they exist, the supervised adapter is exercised only by synthetic tests with
a harmless finite fake-debugger fixture; no test launches GDB.
