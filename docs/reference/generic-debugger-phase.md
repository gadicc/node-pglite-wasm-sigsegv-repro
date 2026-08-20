# Understand the generic debugger phase manifest

The internal debugger-phase manifest is the first compatibility boundary for a
future schema-3 GDB capture. It describes exactly what a debugger phase would
run, but it does not execute GDB or create durable phase state.

## Bind one workload and target-signal policy

The selected workload must declare `capabilities.gdb: true` and at least one
target signal. The manifest stores its workload-contract version, stable ID,
and digest. Changing the command, arguments, working directory, environment
policy, provenance, lifecycle, outcomes, or capabilities therefore requires a
new workload identity and bundle.

The fixed command profile records the sorted target-signal list and these
capture sections:

- stop information;
- backtrace;
- registers;
- instructions around the program counter;
- thread information; and
- process mappings.

The transcript profile has its own version and a fixed 64 MiB upper bound. A
later runner must implement this exact profile rather than accepting arbitrary
GDB command text in a bundle.

## Bind debugger provenance and execution

The manifest resolves GDB to a canonical regular executable and records its
path, byte count, mode, and full SHA-256 digest. It also binds one target CPU,
maximum run and capture counts, singleton-affinity mode, `taskset` path,
per-run timeout, and cleanup grace intervals.

Stored parsing is intentionally filesystem-independent. Immediately before a
future launch, the runner must re-open and hash the recorded GDB path and refuse
execution if it differs. The target workload has its own equivalent launch
provenance check.

## Keep this foundation distinct from evidence

The manifest does not claim that a capture occurred. A complete generic phase
still needs:

1. a supervised GDB runner connecting the [structured control protocol](generic-debugger-control.md) to the [bounded attempt-I/O layer](generic-debugger-attempt-io.md);
2. typed clean, captured, error, and operational outcomes;
3. affinity and process-cleanup evidence;
4. complete-only durable publication;
5. schema-3 bundle inventory and lease integration; and
6. read-only summary and public CLI support.

Until those pieces exist, `capabilities.gdb` is a contract input rather than an
advertised public phase. The historical `capture-fault.sh` and schema-2 GDB
evidence remain separate.
