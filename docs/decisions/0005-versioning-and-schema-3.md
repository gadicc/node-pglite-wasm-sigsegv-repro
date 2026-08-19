# Architecture decision 0005: Separate format versions and fail closed

Status: Accepted

## Context

The repository currently uses `RUN_SCHEMA_VERSION` for run-protocol behavior and a separate `schemaVersion` in derived results. Individual phase envelopes, pinned-concurrent envelopes, preflight evidence, telemetry, and debugger evidence also have independent versions. Calling the next design schema 3 without separating these meanings would create ambiguous compatibility rules.

An older runner must not mistake a generic bundle for a schema-2 Node/PGlite bundle. Ignoring an unknown new metadata key while accepting `RUN_SCHEMA_VERSION=2` could mix workloads during resume.

## Decision

Version numbers describe distinct surfaces:

- Bundle format version 3 identifies the generic persisted run contract.
- Workload contract version 1 defines command, environment, provenance, lifecycle, mappings, and capabilities.
- Attempt record versions define raw and normalized per-attempt evidence.
- Each phase envelope retains an independent version.
- Derived results schema version 3 defines the collected machine-readable output.
- Schedule protocol versions remain independent of the bundle format.

New bundles persist an explicit bundle-format field and `RUN_SCHEMA_VERSION=3`. The latter is a compatibility barrier so existing writers that accept only 1 or 2 reject the bundle before mutation. New code must not reuse that value as the schedule algorithm version.

Unknown bundle, workload, attempt, or phase versions fail closed for mutation. Read-only tools may report an unsupported version without treating its evidence as authoritative.

Every schema-3 phase envelope binds the canonical workload digest. Legacy-shaped artifacts appearing in a schema-3 bundle are conflicts, not compatible evidence.

## Consequences

The version split has these consequences:

- Older diagnostic runners cannot resume schema-3 bundles.
- New readers require explicit adapters for schema 1, schema 2, and schema 3.
- Phase formats can evolve without renumbering the whole bundle when their compatibility rules permit it.
- The implementation must distinguish stored source evidence from regenerated derived output.

## Acceptance criteria

This decision is satisfied when:

- A test proves the current schema-2 runner rejects schema-3 metadata before bundle mutation.
- New readers identify schema 1, schema 2, and schema 3 without heuristic ambiguity.
- Unknown versions cannot publish completion markers or derived readiness tokens.
- Every schema-3 resumable state and completed phase validates the same workload digest.
- A schema-3 validator rejects legacy frequency, debugger, or workload artifacts that lack the required binding.
