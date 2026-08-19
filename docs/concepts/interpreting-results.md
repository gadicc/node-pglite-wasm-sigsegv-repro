# Interpret experimental results

This page explains what the current reports can and cannot establish. Keep protocol, denominator, dependence, and machine history visible when comparing failure rates.

## Separate waves from child processes

Baseline and group phases report wave outcomes with Wilson 95% confidence intervals. A group result of `50/50` means every wave contained at least one confirmed `SIGSEGV`. It does not mean every child failed.

The report shows child failures separately. Children in one wave share timing, load, and machine state, so their outcomes are correlated. The child percentage is descriptive and has no child-level confidence interval.

A wave is:

- Positive when at least one child has a confirmed `SIGSEGV`
- Negative when every child passes
- Unresolved when it contains another workload failure or invalid structure

Wave intervals use resolved sequential waves and assume those waves are independent and stationary. Excluding unresolved waves can bias the interval, so the report shows their count.

Do not compare wave rates with different child counts as if they used the same exposure. More concurrent children increase the chance that at least one child fails.

## Distinguish affinity masks from exact CPUs

A group row names a shared affinity mask. The controller and children can migrate anywhere within it. Group evidence screens topology regions but cannot attribute a fault to one CPU.

Individual trials pin one direct child to one logical CPU. Their seeded, position-balanced schedule reduces CPU-major order bias. It does not remove time, temperature, warmup, or workload drift.

Pinned-concurrent contexts preserve simultaneous load and exact child-to-CPU attribution. Contexts differ in sibling load and active-set size, so keep them as separate strata.

## Preserve all workload outcomes

Version-6 individual evidence separates:

- `pass`
- `sigsegv`
- `other-workload-failure`
- `operational-invalid`

The primary denominator contains only `pass + sigsegv` observations. The report shows committed observations and other workload failures separately.

A CPU with only other workload failures has no primary denominator, interval, or valid zero-failure claim. Do not relabel another exit or signal as a pass.

Pinned-concurrent version 2 applies the same classification. A wave with a non-target workload failure remains descriptive but does not enter the primary wave denominator.

## Interpret zero observed failures

No failures in `n` attempts does not prove a zero failure rate. The report uses the exact pointwise one-sided 95% upper bound:

```text
1 - 0.05^(1/n)
```

For 50 attempts with no failures, the nominal upper bound is about 5.8%. The common approximation is `3/n`.

This bound assumes independent, stationary attempts. Thermal, temporal, and machine-state dependence can make it too narrow. It is not proof of correct hardware.

For a bounded GDB phase, `n` includes only attempts that ran the workload cleanly. Runner or debugger errors remain separate and do not inflate the no-fault denominator.

## Interpret frequency A/B/A

The prespecified frequency experiment compares each turbo-on A leg with the turbo-off B leg using a one-sided Fisher exact test on endpoint-resolved runs.

The report claims a replicated reduction only when:

1. Both A-versus-B comparisons point in the prespecified direction.
2. Both comparisons have `p < 0.05`.
3. The experiment completed with valid boundaries and restoration.

The report uses the larger of the two p-values as the conservative replicated result. It does not pool A1 and A2.

A tracked non-target workload outcome does not invalidate the schedule, but it disables the inferential comparison because the attempt does not resolve the primary endpoint. Operational failure also disables inference.

The fixed A1, B, A2 order cannot eliminate time, warmup, or thermal drift. A repeated reversal strengthens an association but does not identify voltage, frequency, power delivery, firmware, or silicon as the mechanism.

## Interpret controlled package load

The default load-state experiment changes verified script-induced activity elsewhere on the package. A strong A1, B, A2 reversal establishes an association with that controlled condition during the session.

It does not distinguish among:

- Package temperature
- Power or current demand
- Voltage regulation
- Firmware power management
- Scheduler behavior
- Interactions among those factors

An A leg means only that the script did not induce load. Unrelated applications can remain a confounder.

Node A/B/A keeps the load generation constant but uses a fixed executable order. Node matrix mode gives each Node and warmup condition a separate load onset in a seeded order. In matrix mode, the cycle is the experimental unit, not each child within a cycle.

## Match a fault signature before pooling crashes

The case study's defining live capture has these features:

- An ordinary base-plus-displacement memory instruction
- A clean, self-consistent base register
- A valid mapped intended address
- A reported `si_addr` exactly `2^42` above the intended address

Compare new GDB captures at the instruction, operand, intended-address, mapping, `si_addr`, register, and backtrace levels. Do not pool every `SIGSEGV` as the same mechanism.

Post-mortem systemd-coredump siginfo is not reliable for this case. Node's trap handler re-raised the fatal signal, so the core retained the later `SI_TKILL` sender fields instead of the original fault address. Use a live GDB stop with `handle SIGSEGV stop nopass` or signal-aware `strace` when the address matters.

## Separate observation from inference

The current evidence directly supports claims such as:

- The workload reproduced in a specific session
- A specific pinned child faulted on a recorded logical CPU
- A captured fault matched the documented address signature
- A lower-frequency or loaded leg had a measured count
- A configuration was present or absent during collection

The same evidence does not directly prove:

- A CPU is physically defective
- Every unobserved CPU is safe
- One software component owns the root cause
- A clean runtime or kernel fixes the anomaly
- A frequency threshold exists
- Results from different contexts share one stationary rate

Generated reports should state what the current bundle supports, then state remaining uncertainty. Older sessions can provide context, but they must not authorize conclusions in a new bundle.
