# Architecture decision 0006: Keep legacy bundles on a separate path

Status: Accepted

## Context

Schema-1 and schema-2 bundles predate an immutable workload contract. Their files and phase meanings assume the Node/PGlite reproduction, and incomplete bundles may contain resumable protocol state. Adding workload identity after collection would invent provenance that the original run did not record.

## Decision

Schema-1 and schema-2 bundles use an implicit `node-pglite-legacy` compatibility profile. The new runner selects that profile from stored schema before it considers fresh-run workload defaults.

Legacy bundles never upgrade in place. Resume must reject custom workload flags, schema-3 phase options, and any attempt to change the workload identity. A legacy resume continues only the original phase formats and semantics.

Read-only collection and reporting may describe legacy workload identity as implicit and provenance-unbound. They must not present it as equivalent to a schema-3 digest binding.

Compatibility wrappers and required Node/PGlite files remain available until completed and partial legacy fixtures pass the new resume path. Historical filenames, format identifiers, and outcome meanings remain unchanged.

## Consequences

The separate compatibility path has these consequences:

- Legacy resume keeps historical value without weakening schema-3 guarantees.
- Moving Node/PGlite files requires wrappers or an adapter that preserves old invocation semantics.
- A workload or dependency change that cannot satisfy the legacy contract requires a new bundle.
- Schema-3 features cannot repair missing legacy provenance.

## Acceptance criteria

This decision is satisfied when:

- Completed schema-1 and schema-2 fixtures remain readable.
- Partial schema-1 and schema-2 fixtures resume only through `node-pglite-legacy`.
- Legacy resume rejects every workload-selection or schema-3-only override.
- No legacy bundle gains schema-3 metadata, state files, or phase meanings.
- Reports disclose that legacy workload provenance was implicit rather than digest-bound.
