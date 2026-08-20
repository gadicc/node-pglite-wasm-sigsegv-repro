# Architecture decision 0018: Own controlled-load sessions in manifest v5

Status: Accepted

## Context

A complete controlled-load envelope is indivisible evidence, but it still needs
durable no-clobber publication and one owner across execution. Publishing A1,
B, worker records, or A2 separately would create resumable prefixes whose
meaning differs from the complete-only session contract.

The existing schema-3 manifest versions are fixed compatibility boundaries.
Versions 2 through 4 progressively add baseline, group, and pinned-concurrent
phases to the exact-CPU foundation. Requiring all those unrelated capabilities
for controlled-load evidence would prevent otherwise valid measured workloads
from using the new protocol.

## Decision

Add a private controlled-load phase store with two final names:

- `controlled-load-phase.json` for the canonical session manifest
- `controlled-load-session.json` for the one canonical complete envelope

Initialization publishes only the manifest. A failed or interrupted session
leaves no partial phase evidence and consumes no frontier. The complete
envelope is published once with the existing private, durable, no-clobber state
adapter. Readers reject foreign files, manifest drift, noncanonical bytes,
live-writer remnants, and any second session.

Introduce schema-3 manifest version 5 as a controlled-load variant, not as a
superset of version 4. It binds:

- The measured workload and its existing exact-CPU capability
- A separate complete auxiliary workload identity and digest
- Exact-CPU state at `state/exact-cpu/`
- Controlled-load state at `state/controlled-load/`
- The controlled-load session manifest and canonical byte binding

The `controlledLoad` phase control is a bundle-level composed protocol because
it relates measured and auxiliary workload roles; it does not change workload
contract version 1 or retroactively add a field to every workload digest.
Manifest versions 1 through 4 retain their exact keys, phase controls, and
state inventories.

One descriptor-backed bundle lease spans store selection, A1, worker startup,
B, worker cleanup, recovery, A2, and final publication. Measured and managed
supervisors retain the open bundle descriptor through bounded cleanup, while
their direct workloads do not inherit it. An incomplete run returns operational
detail but leaves the durable store empty. Once complete, another run is a
no-op.

This remains internal. It does not modify `diagnose.sh`, `load-state-aba.mjs`,
legacy bundle readers, current reports, historical multi-workload evidence, or
the privileged recovery namespace.

## Consequences

- A controlled-load session becomes one exclusive execution-and-publication
  transaction.
- Restart never resumes halfway through an A1/B/A2 comparison.
- The auxiliary workload identity is immutable bundle evidence and must be
  supplied to version-5 readers and owners.
- Version 5 can serve a measured workload that supports exact CPU placement
  without requiring baseline, group, or pinned-concurrent capabilities.
- A later combined manifest version may bind additional phase variants; it
  must do so without changing versions 1 through 5 in place.
- Public workload selection and orchestration remain the next layer.

## Acceptance criteria

- Empty stores contain only the canonical manifest; complete stores add exactly
  one canonical session envelope.
- Manifest drift, envelope drift, foreign files, and live writers fail closed.
- Version 5 binds both workload identities, exact-CPU state, controlled-load
  state, and no unrelated phase directories.
- One lease excludes readers and other phase operations throughout B and final
  commit.
- A complete retry launches no new attempts.
- Automated coverage uses harmless finite and waiting fixtures only.

[ADR 0023](0023-public-controlled-load-command.md) later adds the public
selection, plan, creation, and resume layer for this unchanged manifest-v5
ownership contract.
