# Architecture decision 0004: Preserve typed outcome evidence

Status: Accepted

## Context

The built-in workloads expose several distinct events. A process may terminate directly from `SIGSEGV`, return a literal exit code such as `139`, report a handled `SIGSEGV` through exit `42`, report corruption through exit `43`, or survive its observation window. Collapsing these events into one crash count would discard evidence quality and could create false conclusions.

## Decision

Every attempt record preserves the raw process result and a separate normalized interpretation.

The normalized record contains:

- `terminalReason`: why observation ended, such as `natural-exit`, `observation-window-elapsed`, `external-cancel`, `launch-error`, or `cleanup-failure`.
- `category`: one of `pass`, `target-fault`, `corruption`, `other-workload-failure`, or `operational-invalid`.
- `evidenceKind`: a stable type such as `normal-exit`, `direct-signal`, `mapped-exit`, or `survived-window`.
- `label`: a stable workload-defined description of the interpreted outcome.
- Raw `exitCode` and `signal` fields without shell-status reconstruction.

Only a null exit code paired with the process signal `SIGSEGV` is direct `SIGSEGV` evidence. Literal exit `139` remains an ordinary exit unless a workload mapping labels it otherwise, and such a mapping still uses `mapped-exit`.

For the native built-in, exit `42` means a handled `SIGSEGV` report and exit `43` means detected corruption. Neither is direct-signal evidence. Harness-generated cleanup signals never map to a workload category.

Outcome mappings are canonical, collision-free, versioned, and included in the workload identity digest. Reports must retain evidence kind when aggregating categories.

## Consequences

Typed outcomes have these consequences:

- General reports can discuss target faults without relabeling all events as `SIGSEGV`.
- Direct signals, handled reports, and corruption remain independently reviewable.
- Existing schema-1 and schema-2 classifications retain their historical meanings.
- New outcome categories require new attempt and phase-envelope versions.

## Acceptance criteria

This decision is satisfied when:

- Classifier tests distinguish direct `SIGSEGV`, literal exit `139`, mapped exit `42`, mapped exit `43`, and window survival.
- Conflicting or duplicate mappings fail workload validation.
- Raw status remains present beside every normalized authoritative outcome.
- Aggregates never describe mapped exits as direct signals.
- Operational failures remain outside pass and target-fault denominators.
