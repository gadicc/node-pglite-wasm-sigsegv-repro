# Summarize a schema-3 bundle

Use `fault-affinity summarize` to inspect committed evidence in any schema-3
manifest version from 1 through 6. The command re-resolves the workload,
validates the complete bundle and every committed phase envelope, and writes a
derived summary to standard output.

It does not start a workload, create or modify bundle files, or claim that an
observed CPU association is causal.

## Read the text summary

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-exact \
  --workload wasm-churn
```

Use the same workload identity that created the bundle. For a custom workload,
use `--workload-file` with the same definition file. Resolution refuses changed
commands, arguments, lifecycle, classifiers, capabilities, or provenance.

The text output includes:

- schema-3 manifest version, generation, and workload digest;
- `not-bound`, `empty`, `incomplete`, or `complete` phase status;
- committed and scheduled wave, session, or attempt counts;
- outcome category and label counts;
- per-context CPU-group and pinned-concurrent counts;
- per-leg controlled-load counts;
- per-run debugger capture counts (manifest v6); and
- per-CPU exact counts.

Only committed, already validated outcomes appear. An incomplete phase remains
explicit and its uncommitted slot is not counted.

## Read JSON

Add `--json` for summary schema version 1:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-exact \
  --workload wasm-churn \
  --json
```

JSON preserves category and label as separate fields. Consumers should check
the top-level `version`, each phase `status`, and the committed and scheduled
counts rather than inferring completion from a nonempty outcome list.

## Summarize a controlled-load bundle

Manifest version 5 binds a second workload identity. Supply the same condition
definition used at creation:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/controlled-load \
  --workload-file workloads/measured.json \
  --condition-workload-file workloads/condition.json
```

The condition definition is resolved only to validate the stored identity. No
condition worker starts. `--condition-workload-file` is rejected for manifest
versions 1 through 4 and 6.

## Keep the interpretation narrow

The summary is a read-only view, not a persisted evidence format or the legacy
suite's final report. It does not add telemetry, debugger capture, privacy
review, confidence intervals, or cross-phase causal conclusions. Share the
complete validated bundle alongside any copied summary.
