# Architecture decision 0029: Supervise debugger attempts through the established Node supervisor

Status: Accepted

## Context

The generic debugger foundation binds a phase manifest (ADR 0026), a
structured control protocol (ADR 0027), bounded attempt I/O (ADR 0028), and a
materialized fixed command profile. Executing one attempt still needs a
process-lifecycle authority. The historical shell supervisor is tied to the
legacy PGlite phase and cannot become the generic execution contract.

The established internal Node attempt runner and supervisor already give one
workload attempt a detached process group, shell-free exact-argv launch,
last-moment provenance revalidation, deadlines, group cleanup escalation, and
typed lifecycle evidence. A generic debugger attempt is one more consumer of
that lifecycle, with two extra needs: a small private runner-to-member
configuration channel, and separate transcript/control output routing.

## Decision

Run every generic debugger attempt as the stable internal adapter
`diagnose-lib/debugger-adapter.mjs` supervised by the established Node attempt
runner and supervisor, never as GDB directly and never under the historical
shell supervisor.

Extend the supervisor launch protocol to version 4 with an optional bounded
stdin payload of at most 2 MiB. The payload carries the adapter launch
package: the workload spec, the debugger-phase manifest, and the attempt
context. The payload never travels through command-line arguments,
environment, or the filesystem.

The adapter's only workload authority is a single launch capsule carried in
the payload: the exact public workload identity, the private environment
values, and — only for HMAC-bound workloads — the environment binding key.
Resolving the capsule revalidates the workload digest against the public
fields and every environment value against its digest-covered binding HMAC,
so HMAC-bound custom workloads keep their digest and substituted private
values fail closed. The adapter does not re-resolve a spec and its own
environment stays empty.

The adapter rebuilds the fixed command profile from the capsule-validated
manifest and context, and revalidates target and debugger provenance
immediately before spawning GDB. The supervisor revalidates the adapter's own
launch provenance (the interpreter plus every module it loads) in the same
window.

The adapter launches GDB shell-free with the materialized descriptor. GDB
stdout and stderr forward together to the adapter's stdout (the transcript
channel); the profile's private control descriptor forwards to the adapter's
stderr (the control channel). The bounded attempt-I/O layer captures both
while the attempt runner keeps the adapter's own lifecycle evidence distinct.

Adapter operational failure is a typed single-line transcript record and a
nonzero adapter exit; it never produces control bytes. The debugger's own
completion is also adapter-lifecycle evidence: a valid control transcript
followed by a nonzero or signaled debugger exit still leaves the adapter
operationally unsuccessful. Partial, overflowed, invalid, or incompletely
drained channels can never qualify as a complete attempt.

This decision adds no public command, no attempt envelope, no durable bundle
artifact, and no schema-3 manifest change.

## Consequences

- Debugger attempts inherit the proven deadline, cleanup-escalation, and
  group-identity behavior of the established supervisor instead of a second
  lifecycle implementation.
- Launch configuration reaches the adapter without exposing target
  environment values in arguments, environment, or files.
- The adapter's lifecycle evidence (the supervised process result) cannot be
  mistaken for inferior lifecycle evidence (the control protocol).
- Complete-only debugger attempt envelopes, schema-3 bundle integration,
  summaries, and public orchestration remain later boundaries.
