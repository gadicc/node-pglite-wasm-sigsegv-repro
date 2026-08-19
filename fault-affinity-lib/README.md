# Public command implementation

This directory owns argument parsing and orchestration for the public
`fault-affinity` command. The stable executable remains
[`../fault-affinity.mjs`](../fault-affinity.mjs), which is intentionally a thin
entry point so package and shell invocations do not depend on the internal
module layout.

Protocol, evidence, store, lease, and lifecycle modules still live in
`../diagnose-lib/`. Many are shared with the historical diagnostic suite, and
their paths must not be changed casually: compatibility-sensitive scripts,
tests, and recovery behavior still import them directly.

New public phases should keep these boundaries:

- parse and validate all operator input before creating an output directory;
- resolve one explicit workload identity and check its declared capabilities;
- build an immutable schema-3 manifest before launching anything;
- use the schema-3 bundle owner for selection, execution, cleanup, and commit;
- exercise live orchestration in automation only with harmless finite custom
  workloads.

The top-level entry point re-exports the CLI error, parser, and runner for the
existing test and embedding boundary.
