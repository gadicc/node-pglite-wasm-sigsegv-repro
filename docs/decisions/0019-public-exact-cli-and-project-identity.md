# Architecture decision 0019: Publish the exact-CPU CLI and Fault Affinity identity

Status: Accepted

## Context

ADR 0001 deferred the public rename until a generic path could create and
resume its own evidence bundles. The workload contract, bounded attempt owner,
exact-CPU phase envelopes, durable phase store, and schema-3 bundle owner now
satisfy that gate. The remaining generic phase adapters do not need to be
misrepresented as public merely to adopt the project identity.

## Decision

The package and public command are named **Fault Affinity** and
`fault-affinity`. The first public command exposes only exact-CPU schema-3
execution.

Every fresh or resumed live run selects exactly one built-in or custom workload
and requires `--yes`. Listing, inspection, and dry-run planning never execute a
workload. A fresh run creates a private schema-3 bundle; resume re-resolves the
same workload identity and advances its exact durable prefix.

The catalog recommends the dependency-free `wasm-churn` workload and retains
`node-pglite` as the historical heavyweight built-in. A custom JSON definition
may use paths relative to its own directory, but the resolver converts them to
canonical absolute executable, working-directory, and provenance paths before
building the workload identity. Commands are always launched without a shell.

The legacy `diagnose.sh`, reproduction scripts, Dockerfile, schema-1 and
schema-2 evidence readers, and controlled-load commands remain available under
their existing meanings. The repository checkout directory and root-owned
`/run/node-pglite-wasm-sigsegv-repro/` recovery namespace are compatibility
state and are not renamed by this decision.

## Consequences

- The root identity no longer implies that PGlite is the only workload.
- Public generic claims must remain exact-CPU-only until additional phase
  orchestrators are exposed.
- Schema-3 exact bundles are internal evidence records, not substitutes for the
  legacy suite's complete report and sharing workflow.
- The PGlite dependency remains installed for the retained built-in and legacy
  commands.
- Physical repository-host renaming can be handled separately without changing
  evidence or privileged recovery semantics.

## Acceptance criteria

- `fault-affinity workloads` and `inspect` perform no workload execution.
- A dry run performs no execution and creates no output directory.
- A harmless custom workload can create, complete, and resume its own exact
  schema-3 bundle.
- Live operation requires explicit workload selection and `--yes`.
- Automated tests never invoke either built-in workload.
- Legacy commands and recovery names remain unchanged.
