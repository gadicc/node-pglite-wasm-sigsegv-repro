# Architecture decision 0021: Publish CPU-group orchestration through a bounded plan file

Status: Accepted

## Context

Schema-3 manifest version 3 already binds baseline, CPU-group, and exact-CPU
state without reinterpreting versions 1 or 2. A fresh version-3 bundle must
therefore know three schedules plus the complete, potentially overlapping group
topology before any phase starts. Expressing every context as repeated shell
flags would make review and reproduction unnecessarily fragile.

Topology discovery is also not neutral: a machine may need broad CPU classes,
cache clusters, administrative subsets, or another explicitly reviewed set of
overlapping contexts. The generic command should not silently choose that
experimental design.

## Decision

Add `fault-affinity groups`. Fresh creation takes `--plan-file FILE`, an
explicit workload selection, an output directory, and either `--dry-run` or
`--yes`. Plan-file version 1 contains exactly:

- a baseline child count and wave count;
- a CPU universe, ordered group contexts, child counts, rounds, and seed;
- a downstream exact CPU list, rounds, and seed.

CPU lists use the same canonical string grammar as command-line CPU lists. The
plan is a bounded, stable, single-link regular UTF-8 JSON file. It is read and
validated before output-directory creation. The normalized values are then
fully represented by immutable phase manifests; resume does not reopen or
trust the source plan file.

A fresh command creates manifest version 3 and advances only complete group
waves. `groups --resume` advances the stored group prefix. Existing
`baseline --resume` and `exact --resume` may independently advance their stored
prefixes in the same bundle. No command upgrades a version-1 or version-2
bundle in place.

Require baseline, groups, and isolated workload capabilities. Keep topology
explicit for this version rather than coupling the public contract to automatic
host discovery. Validate every scheduled CPU against the invoking process's
current Linux allowance before creating the bundle.

## Consequences

- One reviewable file captures the complete version-3 experimental design.
- Group contexts may overlap but their union must cover the declared universe,
  as enforced by the existing group manifest builder.
- The plan filename and formatting are not resume dependencies; canonical
  manifests carry the complete normalized schedule and topology.
- Baseline, group, and exact commands share one workload identity and one
  exclusive bundle lease while retaining independent contiguous prefixes.
- Automatic topology discovery and manifest version 4 remain separate public
  design decisions.

## Acceptance criteria

- Dry-run planning validates the plan, capabilities, executable, CPU allowance,
  and all three phase manifests without creating a directory or executing a
  workload.
- A harmless finite custom workload creates and completes a version-3 group
  prefix; group resume is idempotent; baseline and exact then resume the same
  bundle.
- Invalid, partial, or operationally incomplete waves consume no group slot.
- Symlinked, hard-linked, special, oversized, malformed, or forbidden-control
  plan inputs fail before bundle creation.
- Existing version-1/version-2 commands, built-in identities, legacy evidence,
  and privileged recovery paths remain unchanged.
