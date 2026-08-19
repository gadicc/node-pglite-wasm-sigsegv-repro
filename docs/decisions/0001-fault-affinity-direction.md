# Architecture decision 0001: Adopt the Fault Affinity direction

Status: Accepted

## Context

The repository began as a Node.js and PGlite reproduction. Its diagnostic code now localizes intermittent faults by Linux CPU affinity, topology, and controlled load. The project needs a scope and identity that describe that broader work without claiming to diagnose every crash or prove a hardware defect.

## Decision

The project will become a Linux harness for reproducing, localizing, and collecting reviewable evidence for intermittent CPU-sensitive process faults.

The working project name is **Fault Affinity**. The planned repository slug and command name are `fault-affinity`. The external rename remains deferred until the generic workload interface and compatibility path exist.

`wasm-churn` will be the recommended built-in workload. Every live run must select a workload explicitly, so recommendation does not imply silent execution. The Node/PGlite workload will remain available as the historical heavyweight reproduction.

The project will not claim universal crash debugging, hardware-defect detection, cross-platform support, fault injection, or fuzzing.

## Consequences

This direction has these consequences:

- New interfaces and reports must use workload-neutral fault terminology.
- Linux-specific behavior may rely on `/proc`, sysfs, `taskset`, and Linux debugger semantics.
- The historical case study may retain Node.js, PGlite, WebAssembly, and `SIGSEGV` terminology.
- Existing package, command, directory, and recovery names remain until their compatibility requirements are met.

## Acceptance criteria

This decision is satisfied when:

- A scope statement distinguishes observed CPU affinity from a claim of CPU causation.
- A fresh live run requires an explicit workload selection.
- Documentation labels `wasm-churn` as recommended and Node/PGlite as historical and heavyweight.
- The public rename occurs only after the generic path can create and resume its own evidence bundles.
