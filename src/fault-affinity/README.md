# Public command implementation

This directory owns argument parsing and orchestration for the public
`fault-affinity` command. The stable executable remains
[`../../fault-affinity.mjs`](../../fault-affinity.mjs), which is intentionally a thin
entry point so package and shell invocations do not depend on the internal
module layout.

Protocol, evidence, store, lease, and lifecycle modules still live in
`../../diagnose-lib/`. Many are shared with the historical diagnostic suite, and
their paths must not be changed casually: compatibility-sensitive scripts,
tests, and recovery behavior still import them directly.

New public phases should keep these boundaries:

- parse and validate all operator input before creating an output directory;
- resolve every explicit workload identity and check its declared capabilities
  or lifecycle role;
- build an immutable schema-3 manifest before launching anything;
- use the schema-3 bundle owner for selection, execution, cleanup, and commit;
- exercise live orchestration in automation only with harmless finite custom
  workloads.

`plan-file.mjs` owns the shared bounded, stable JSON read boundary.
`group-plan.mjs` normalizes the manifest-version-3 public plan,
`pinned-plan.mjs` normalizes the four schedules required by manifest version 4,
and `controlled-load-plan.mjs` normalizes the A1/B/A2 and sibling exact
schedules required by manifest version 5. The existing phase builders remain
authoritative for canonical topology and schedule validation.

Pinned waves use a separate process boundary. `pinned-wave-client.mjs` starts
one `pinned-wave-owner.mjs` process under the stored controller CPU. The owner
acquires the bundle lease, advances at most one wave, and returns a bounded
structured result over a dedicated descriptor rather than workload stdout or
stderr. The public coordinator then rereads durable bundle state.

Controlled-load orchestration resolves a second trusted custom workload for
the condition workers. That workload must use `survive-window` semantics. The
schema-3 owner retains one bundle lease across the complete A1/B/A2 session;
exact resume of the same v5 bundle receives the auxiliary identity only for
manifest validation and does not start the condition workload.

`schema3-summary.mjs` derives read-only text and versioned JSON from bundle
objects that have already passed the authoritative schema-3 reader. It reports
only committed observations, preserves incomplete and unbound phase status, and
writes no derived bundle artifact.

The top-level entry point re-exports the CLI error, parser, and runner for the
existing test and embedding boundary.
