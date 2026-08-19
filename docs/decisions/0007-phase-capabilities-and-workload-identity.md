# Architecture decision 0007: Bind phase capabilities to one workload identity

Status: Accepted

## Context

The diagnostic phases impose different requirements. Baseline and group screening launch concurrent waves. Isolated and pinned-concurrent phases need exact process attribution. Debugger capture needs a meaningful target signal and debugger command. Frequency experiments need a safe unprivileged workload adapter plus privileged restoration. Resource requirements also differ between PGlite, `wasm-churn`, native probes, and custom commands.

Running different workloads in different phases of one bundle would make localization and comparison conclusions invalid unless the bundle explicitly represented a multi-workload experiment. That design is outside the current scope.

## Decision

Each schema-3 bundle resolves exactly one workload identity. Every plan, attempt state, phase envelope, telemetry binding, debugger result, frequency result, and derived report binds the same workload digest.

The workload contract declares support and phase-specific configuration for:

- Baseline concurrent waves.
- CPU-group screening.
- Isolated exact-CPU attempts.
- Pinned-concurrent topology contexts.
- Debugger capture, including target signals and lifecycle semantics.
- Controlled frequency experiments.
- Resource estimates, concurrency limits, and risk level.

A phase records one of four control states: `supported`, `unsupported`, `explicitly-skipped`, or `unavailable`. The last three states contribute no pass, no-fault, rate-bound, or localization evidence.

The harness advertises a workload only for implemented capabilities. Internal migration may adapt exact-CPU phases before baseline and groups, but a public schema-3 diagnostic must not mix those results with Node/PGlite phases.

Changing command, arguments, working directory, environment policy, provenance files, lifecycle, mappings, or capabilities creates a new workload identity and requires a new bundle.

## Consequences

Capability declarations have these consequences:

- Workload-specific resource warnings replace the current fixed PGlite estimate.
- Unsupported debugger or frequency phases can remain explicit without blocking core localization.
- Phase reports must distinguish absence of evidence from an observed clean result.
- A future multi-workload experiment will need a separate bundle design.

## Acceptance criteria

This decision is satisfied when:

- Every schema-3 phase validates the bundle's workload digest before launch and publication.
- A bundle cannot combine PGlite baseline evidence with `wasm-churn` exact-CPU evidence.
- Unsupported, skipped, and unavailable phases never enter fault-rate denominators.
- The displayed execution plan includes phase support, lifecycle, concurrency, resource estimate, and risk.
- The recommended built-in completes every phase that its public documentation advertises.
