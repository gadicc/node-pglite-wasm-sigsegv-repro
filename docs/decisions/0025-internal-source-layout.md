# Architecture decision 0025: Separate internal public-command source

Status: Accepted

## Context

The stable `fault-affinity.mjs` executable is already a thin package entry
point, but its implementation lived in another top-level directory named
`fault-affinity-lib/`. That name described neither a public library nor the
long-term source layout, and it added to an already busy repository root.

A broad move is not compatibility-neutral. The historical diagnostic scripts
import `diagnose-lib/` directly, while built-in workload command and provenance
paths participate in persisted workload identities. Moving either set merely
for tidiness could break existing commands or make an existing schema-3 bundle
unresumable.

## Decision

Move only the internal public-command parsing, plan-file, orchestration, pinned
owner, and summary modules to `src/fault-affinity/`.

Keep these boundaries unchanged:

- `fault-affinity.mjs` remains the package executable and re-export surface;
- package scripts and public command syntax remain unchanged;
- `diagnose-lib/` remains at its compatibility-sensitive shared path;
- built-in workload executables retain their canonical repository-root paths;
- historical top-level operator commands retain their existing paths; and
- schema-3 formats, workload digests, manifests, and bundle directories do not
  change.

The former `fault-affinity-lib/` path was internal and receives no compatibility
shim. Callers that need the supported embedding boundary import the top-level
`fault-affinity.mjs` module.

## Consequences

- The root now distinguishes the stable public executable from its internal
  implementation.
- Future generic CLI-only modules have one clear home under `src/fault-affinity/`.
- This move changes module paths in repository tests but changes no workload
  identity or evidence meaning.
- Further relocation of shared protocols, legacy commands, or built-in workload
  files requires a separate compatibility decision.
