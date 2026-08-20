# Architecture decision 0022: Publish controller-pinned wave orchestration

Status: Accepted

## Context

Manifest version 4 already binds baseline, CPU-group, pinned-concurrent, and
exact-CPU state. A pinned-concurrent wave is valid only when its coordinating
bundle owner is restricted to the scheduled controller CPU while independently
supervised children are restricted to the context's active CPUs.

The interactive CLI process cannot satisfy different controller placements
across a multi-context schedule. Treating its inherited affinity as evidence
would weaken the manifest-v4 contract. Workload stdout and stderr are also
unsuitable as a control protocol between a per-wave owner and the CLI.

## Decision

Add `fault-affinity pinned`. A fresh command accepts one explicit workload, a
bounded plan file, a new output directory, and either `--dry-run` or `--yes`.
Plan-file version 1 binds all four manifest-v4 schedules. Pinned contexts name
their active CPUs, a distinct controller CPU, kind, cluster identity, rounds,
and seed. The command does not infer topology.

For each durable wave, the CLI launches a short-lived Node owner under the
manifest's absolute `taskset` path and scheduled controller CPU. That process
acquires the bundle lease, validates its singleton controller witness, runs and
cleans the children, and commits at most one complete wave. It returns one
bounded structured record over a dedicated descriptor; workload stdout and
stderr are not control channels. The CLI then rereads the authoritative bundle
before reporting progress.

`SIGINT` and `SIGTERM` are forwarded to the active wave owner. A hard loss of
the CLI may still leave an already-started finite owner able to commit that one
valid wave. Resume derives progress only from durable bundle state. Competing
writers are rejected by the existing descriptor-backed bundle lease.

Require baseline, groups, pinnedConcurrent, and isolated capabilities. Validate
every group, exact, active, and controller CPU against the invoking process's
current allowance before bundle creation. Existing phase commands may advance
their matching prefixes in the version-4 bundle.

## Consequences

- The process holding the bundle lease is also the process whose controller
  placement is recorded.
- Controller placement can vary by wave without changing the interactive
  caller's affinity.
- A dedicated result descriptor remains separate from workload streams and is
  bounded before parsing.
- Resume never depends on the source plan file and never upgrades an older
  bundle.
- Automatic topology discovery remains a separate design decision.

## Acceptance criteria

- Dry-run validates all four schedules, workload capabilities, `taskset`, and
  CPU allowance without creating a bundle or executing a workload.
- A harmless finite custom workload completes one version-4 wave under its
  scheduled controller and resumes idempotently.
- Baseline, group, and exact commands can then complete their sibling prefixes.
- Controller mismatch, invalid child evidence, interrupted cleanup, malformed
  owner records, and lease contention do not consume an uncommitted wave.
- Built-in live workloads remain outside automation.
