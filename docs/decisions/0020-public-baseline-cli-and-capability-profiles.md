# Architecture decision 0020: Publish baseline orchestration with stable capability profiles

Status: Accepted

## Context

The baseline phase and schema-3 manifest version 2 already bind complete
correlated waves beside an immutable exact-CPU schedule. ADR 0019 intentionally
published exact-CPU execution first. The missing layer is public creation,
planning, execution, and resume of the version-2 baseline prefix.

Phase capabilities are part of the resolved workload digest. Adding baseline
capability to the existing `wasm-churn` or `node-pglite` built-in would change
their published exact-only identities and prevent old version-1 bundles from
resuming with the same selection.

## Decision

Add `fault-affinity baseline`. A fresh command requires a child count, wave
count, output directory, and the exact-CPU schedule that the immutable
version-2 manifest will bind. Dry runs validate both schedules without creating
a bundle or launching a workload. Live runs require `--yes`, create one private
version-2 bundle, and advance only complete valid baseline waves.

`fault-affinity baseline --resume` advances only the stored baseline prefix.
The existing `fault-affinity exact --resume` may advance the exact prefix in the
same version-2 bundle. Neither command upgrades an existing bundle or changes a
stored schedule.

Keep `wasm-churn` and `node-pglite` byte-for-byte equivalent at the resolved
workload-contract level. Add separate `wasm-churn-suite` and
`node-pglite-suite` built-ins whose distinct IDs declare baseline, group,
isolated, and pinned-concurrent capabilities. Custom workloads declare the
capabilities they support directly in their JSON definition.

Every live selection remains explicit. Automated tests use only harmless
finite custom workloads; they never execute a built-in diagnostic workload.
The legacy schema-1/schema-2 suite and privileged recovery namespace remain
unchanged.

## Consequences

- Baseline and exact evidence share one workload identity and one exclusive
  bundle lease without losing their different schedule units.
- The exact-only built-ins and their existing version-1 bundles remain
  resumable under their original identities.
- Multi-phase built-ins are visibly distinct capability profiles, not silent
  mutations of an existing workload.
- A fresh baseline command must collect the downstream exact schedule up front
  because manifest version 2 is immutable.
- Group and pinned-concurrent public orchestration can reuse the suite profile
  identities without another built-in capability fork.

## Acceptance criteria

- Dry-run baseline planning executes nothing and creates no output directory.
- A harmless custom workload creates and completes a version-2 baseline
  prefix, resumes idempotently, and then completes its bound exact prefix.
- Invalid or operationally incomplete waves consume no schedule position.
- Baseline execution requires both declared baseline and isolated capability.
- Existing exact-only built-in workload digests remain unchanged.
- Listing, inspection, and every live confirmation boundary remain explicit.
