# Architecture decision 0002: Treat custom workloads as trusted code

Status: Accepted

## Context

Fault Affinity will run user-supplied scripts and binaries. Process supervision can bound cooperative workloads, but it does not create a security sandbox. A custom workload runs with access to the invoking account and can consume resources, modify accessible files, crash, or destabilize the host.

The current process-group design also assumes that a workload does not daemonize into another session. Extending the interface without stating that constraint would overpromise cleanup and evidence integrity.

## Decision

Custom workloads are trusted user code. Fault Affinity will not claim to contain hostile code or protect evidence from a malicious same-user workload.

A workload and its descendants must remain inside the attempt's supervised process group or session. They must not daemonize, create a detached session, or deliberately evade cleanup. Workloads that need those behaviors require a future cgroup-backed execution design.

The initial command contract must require a canonical absolute executable, an exact argument array, and a canonical existing working directory. It must pass arguments without shell interpolation or `eval`.

The harness must use a documented minimal environment. Additional literal variables or named passthrough variables must be explicit. Secret values must not enter the evidence bundle by default, and an unrecorded value must be marked as provenance-incomplete.

## Consequences

This trust boundary has these consequences:

- The harness may execute destructive or unstable code because the operator selected it.
- Command provenance supports review and resume checks, not hostile-code attestation.
- Same-user modification races remain outside the security guarantee unless execution later uses immutable file descriptors or a stronger sandbox.
- Custom workloads cannot use privileged frequency experiments in the initial generic implementation.

## Acceptance criteria

This decision is satisfied when:

- Live-run consent states that custom workloads are trusted and not sandboxed.
- The parser rejects relative executables, malformed arguments, invalid working directories, and ambiguous environment declarations.
- No user-controlled command text enters a shell program string.
- Cleanup tests cover descendants that ignore `SIGTERM` and descendants that retain output descriptors.
- Documentation states that daemonization and session escape violate the workload contract.
