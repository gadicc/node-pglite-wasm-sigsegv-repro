# Architecture decision 0024: Add read-only schema-3 summaries

Status: Accepted

## Context

Schema-3 manifest versions 1 through 5 already validate workload identities,
phase schedules, committed prefixes, affinity witnesses, and typed outcomes.
The public command reports progress while running, but has no common way to
inspect an existing bundle after the process exits. Reusing the legacy
schema-2 report would mix formats and imply telemetry, debugger, privacy, and
inference support that schema 3 does not yet provide.

## Decision

Add `fault-affinity summarize` as a read-only command. It accepts one existing
bundle directory, the explicit measured workload selection, the auxiliary
workload file required by manifest version 5, and optional `--json` output.

The command uses the authoritative schema-3 reader before deriving anything.
It writes only to standard output and does not create a derived artifact in the
bundle. Summary schema version 1 reports:

- manifest and workload identity;
- bound and unbound phase status;
- committed versus scheduled units;
- typed outcome category and label counts;
- group and pinned context breakdowns;
- controlled-load leg breakdowns; and
- exact logical-CPU breakdowns.

Counts include only committed valid attempt evidence. The renderer carries an
explicit interpretation boundary and makes no causal claim.

## Consequences

- Every current schema-3 variant gains one consistent inspection surface.
- Workload or auxiliary identity drift fails before output is produced.
- Empty and incomplete phases remain visible without inventing observations.
- JSON consumers have a small versioned derived schema that is not itself
  evidence or a bundle readiness token.
- A later persisted report, telemetry view, or statistical layer requires its
  own decision and binding contract.
