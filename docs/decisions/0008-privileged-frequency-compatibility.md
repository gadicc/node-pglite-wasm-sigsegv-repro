# Architecture decision 0008: Preserve privileged frequency recovery compatibility

Status: Accepted

## Context

The controlled frequency experiment changes sysfs settings and therefore maintains a root-owned restore ledger, a per-user lock, and pending publication state. Recovery must survive an uncatchable parent termination. The historical state lives below `/run/node-pglite-wasm-sigsegv-repro/`, with deterministic staging below `/tmp/node-pglite-frequency-uid-*`.

Renaming those paths would let an older checkout and a newer checkout use separate locks while changing the same system setting. Moving only the state present during an upgrade would not protect against an older checkout used later.

## Decision

The historical `/run` lock and restore namespace and `/tmp` staging name remain compatibility identifiers indefinitely. The Fault Affinity public rename does not change them.

Every privileged invocation recovers and verifies pending historical restore and publication state before checking the requested bundle, workload, platform applicability, or new-run options.

Generic and custom workloads are initially unsupported in the privileged frequency experiment. The existing legacy companion remains bound to its historical Node/PGlite semantics.

A future generic frequency runner must meet all of these conditions before enabling another workload:

- Root parses no user command through a shell and never executes the workload as root.
- A fixed trusted helper drops to the invoking user before applying the workload's working directory or environment.
- The workload receives no privileged restore-lock, ledger, bundle-writer, or staging descriptor.
- A trusted guardian retains recovery authority until every workload and sampler process is confirmed stopped.
- Restoration completes and verifies before unprivileged evidence publication.
- Frequency evidence binds the schema-3 workload digest and typed attempt records.

Any future recovery-namespace migration requires a separately reviewed dual-lock protocol that remains safe while old binaries exist.

## Consequences

Retaining the namespace has these consequences:

- Internal recovery paths continue to contain the historical project name.
- The initial generic harness may report frequency as unsupported without weakening core diagnostic evidence.
- Privileged code accepts a smaller input surface than the unprivileged harness.
- A public rename cannot strand an outstanding restore ledger or permit concurrent old and new experiments.

## Acceptance criteria

This decision is satisfied when:

- Recovery tests use the historical namespace after the public rename.
- Recovery runs before every new schema, workload, and applicability rejection path.
- An older companion and a newer companion cannot acquire independent locks for the same invoking user.
- Schema-3 reports reject legacy frequency evidence as unbound rather than incorporating it.
- No custom workload runs in the privileged phase until the trusted-helper and descriptor-isolation requirements pass review and tests.
