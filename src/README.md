# Source layout

The `src/` tree contains implementation modules whose filesystem paths are not
part of a persisted workload identity or a historical operator command.

- [`fault-affinity/`](fault-affinity/README.md) owns parsing and orchestration
  for the public `fault-affinity` command.
- The stable package executable remains [`../fault-affinity.mjs`](../fault-affinity.mjs).
- Shared phase, evidence, lifecycle, and persistence modules remain in
  [`../diagnose-lib/`](../diagnose-lib/) while the generic command and historical
  diagnostic suite both depend on them.

Root-level historical commands and workload executables are intentionally not
moved as part of an internal cleanup. Some are documented operator entry points;
others participate in canonical command or provenance paths stored in resumable
evidence bundles. Move those only with an explicit compatibility design.
