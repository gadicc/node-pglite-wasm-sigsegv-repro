# Understand the fault signature and CPU localization

This page records the live fault-address captures, exact-CPU measurements, and controlled platform experiments. The results point toward a platform-dependent execution anomaly but do not prove a defective CPU.

## Identify the recurring fault-address signature

GNU Debugger (GDB) ran each child with `handle SIGSEGV stop nopass`, preserving the first fault context before Node's trap handler re-raised the signal.

Every captured Node fault had the same structure: an ordinary register-relative memory instruction had a valid intended address, but the kernel-reported `si_addr` or CR2 value added one high bit.

| Capture | Faulting instruction | Intended address | `si_addr` | Intended address mapped |
| --- | --- | --- | --- | --- |
| Node 25.2.1, GDB | `addl $1, 0x1c0(%r13)`, `r13=0x6720080` | `0x6720240` | `0x40006720240` | Yes, writable heap |
| Node 25.2.1, GDB | `mov %rbp, 0xb0(%r13)`, `r13=0x6720080` | `0x6720130` | `0x40006720130` | Yes, writable heap |
| Node 25.2.1, GDB, CPU 19 with TME disabled | `mov %rbp, 0xb0(%r13)`, `r13=0x6720080` | `0x6720130` | `0x40006720130` | Yes, writable heap |
| Node 25.2.1, `strace` | `mov %rbp, 0xb0(%r13)` at WebAssembly entry | `0x44905130` | `0x40044905130` | Not recorded in this capture |

`strace -e %memory` showed that the reported fault address was never mapped, unmapped, or protected by the process. The captured register state and instruction bytes were self-consistent.

No ordinary x86-64 calculation represented by these instructions adds `2^42` to the base-plus-displacement address. Page-table and Translation Lookaside Buffer (TLB) translation happens after the linear address recorded in CR2 is formed.

A conventional wrong-register or wrong-displacement compiler bug should appear in the architectural registers or instruction bytes. Neither did. Less conventional kernel, signal, debugger, firmware, code-corruption, and CPU interactions remain possible.

Bit 42 lies in the Page Map Level 4 (PML4) index field of a 48-bit linear address. It selects another top-level page-table slot. Dynamic Random Access Memory (DRAM) data corruption alone cannot change CR2, which records a linear address.

## Preserve live fault context

Post-mortem siginfo from systemd-coredump was misleading in this case. The core contained Node's fatal `SI_TKILL` re-raise, so `$_siginfo` decoded the sender process and user identifiers instead of the original address.

Use a live GDB stop with `handle SIGSEGV stop nopass` or a signal-aware `strace` when the first fault address matters.

Raw cores are not included in the repository because process memory can contain environment values and other sensitive data.

## Compare independent cross-checks

The investigation recorded these cross-checks:

- Deno 2.9.3 with V8 `14.9.207.2` faulted under the same GDB harness with `si_addr=0x167f20915dad` and live pointer `rbx=0x127f20915c71`, an approximate bit-34 addition
- A second PC with an i9-10885H passed 100 waves and 1,600 child runs
- The affected machine reproduced on kernels 6.18 and 7.1.5, with later captures on 7.1.8 builds
- The affected machine's journal contained crashes from Chromium and Electron/Signal V8 processes with anomalous fault addresses
- A generic 24-thread computed-address store test ran for 10 minutes without reproduction

On the affected machine, the early unpinned rate was about one crash per 40 to 80 child runs. Under an illustrative independent-child model with rate 1/80, zero failures in 1,600 runs has probability about `1.82e-9`. Children within a wave share state, so independence is optimistic. This is a strong contrast, not a conclusive hardware bound.

The clean generic stress test shows that ordinary memory traffic was insufficient in that sample. It does not establish that non-V8 code cannot trigger the anomaly.

## Localize the initial topology groups

The affected machine exposes CPUs 0-7 as P-cores and CPUs 8-23 as four E-core clusters. Each E-core cluster shares one L2 cache.

| CPU set | Topology | Initial result |
| --- | --- | --- |
| 0-7 | P-cores | Clean: 16 and 8 children × 50 waves, 1,200 child runs |
| 8-11 | E-cluster 16 | `SIGSEGV` at wave 1, four children |
| 12-15 | E-cluster 24 | Clean: two repetitions of 4 children × 50 waves, 400 child runs |
| 16-19 | E-cluster 64 | `SIGSEGV` at wave 1 in both runs, six failures among eight child runs |
| 20-23 | E-cluster 72 | `SIGSEGV` at wave 1 in both runs, three failures among eight child runs |

These tests name affinity masks. They do not identify the CPU that executed a faulting child.

## Localize initial single-CPU failures

The first one-child-per-run screen observed:

| CPU | Initial result |
| --- | --- |
| 8, 9, 10, 16, 17, 18, 20, 22, 23 | 50 clean waves each |
| 11 | `SIGSEGV` at waves 7 and 14 in two runs |
| 19 | `SIGSEGV` at waves 2, 10, and 3 in three runs |
| 21 | One `SIGSEGV` at wave 22 |

No failure was observed in the initial cluster-24 group sample or P-core samples. Finite zero-failure runs do not prove those CPUs fault-free.

Three of six GDB attempts pinned to CPU 19 captured the same `addl $1, 0x1c0(%r13)` fault with `si_addr = intended + 2^42`. Because `taskset` restricted every thread to CPU 19, those captures provided exact target-CPU attribution.

The initial raw console transcript remains in [core-isolation-test.md](../../core-isolation-test.md). It is superseded by the larger protocols below.

## Interpret the initial localization

Single-process reproduction changed two conclusions:

- Concurrency was not required. It raised scheduler exposure to CPUs that reproduced in the sample.
- The wave harness was not essential. Repeated `taskset -c 19 node child.mjs` runs provided a lower-resource oracle for controlled tests.

Fifty clean runs exclude only larger rates under an independent stationary model. A rate near CPU 21's early 1/22 observation can evade a 50-run screen.

## Review the full exact-CPU follow-up

A full 2026-08-11 diagnostic run used seeded, position-balanced isolated trials and pinned-concurrent topology contexts.

The isolated phase observed:

| CPU | `SIGSEGV` count |
| --- | ---: |
| 11 | 24/400 |
| 19 | 146/398 |
| 21 | 71/398 |
| 23 | 1/400 |
| Other 20 CPUs combined | 0/8,000 |

Pinned-concurrent contexts expanded the observed set to CPUs 9, 11, 17, 19, 21, 22, and 23. All were E-cores in this topology.

Do not pool isolated and pinned-concurrent rates. Sibling load and active-set size differ across contexts.

Three additional live CPU 19 captures reproduced the mapped intended address versus `intended + 2^42` signature across `addl $1,0x1c0(%r13)` and `mov %r10,0xa8(%r13)`.

The expanded set does not establish an intrinsic defect in every listed CPU. It records where this workload produced an exact-CPU failure under the tested contexts.

## Measure reversible package-load association

On 2026-08-17, after BIOS 3.3.2 and Linux `7.1.8-1-cachyos`, the load-state A/B/A harness ran a sequential Node v25.2.1 child on CPU 19. The controller ran on CPU 8. Leg B pinned one verified `/usr/bin/yes` worker to each P-core, CPUs 0-7.

| Leg | Condition | `SIGSEGV` | Package temperature, mean / max | CPU 19 temperature, mean / max |
| --- | --- | ---: | --- | --- |
| A1 | No script-induced load | 0/20 | 63.6 / 89 C | 61.2 / 68 C |
| B | Load on CPUs 0-7 | 19/20 | 103.4 / 105 C | 80.3 / 90 C |
| A2 | Load removed, 15-second settle | 0/20 | 65.0 / 87 C | 64.2 / 72 C |

CPU 19's sampled mean `scaling_cur_freq` was 4.59, 4.34, and 4.57 GHz in A1, B, and A2. This run does not support a claim that the target failed only at its highest sampled clock.

The result establishes a strong, rapidly reversible association with activity elsewhere on the package in that session. It does not distinguish temperature, power demand, voltage regulation, firmware power management, or interactions among them.

The fixed order and unrelated applications that remained open make independent quiet replication important.

## Measure lower-frequency association

An earlier Node v25.2.1 frequency experiment on CPU 19 produced:

| Condition | Requested ceiling | Observed effective clock | Result |
| --- | --- | --- | --- |
| Baseline | 4.7 GHz | About 4.7 GHz boost | 6/20 `SIGSEGV` |
| Capped | 800 MHz | About 1.3 to 2.8 GHz | 0/20 |
| Restored | 4.7 GHz | About 4.7 GHz boost | 9/20 `SIGSEGV` |
| Turbo disabled | 2.1 GHz | Non-turbo | 0/20 |

The one-sided Fisher exact contrasts for the A/cap/A reversal were 6/20 versus 0/20 with `p = 0.0101`, and 9/20 versus 0/20 with `p = 0.000614`. The replicated gate reports the larger value, `0.0101`.

The Hardware-controlled Performance States (HWP) cap did not strictly clamp to 800 MHz. The sequential design also leaves time and order effects. The result supports an association between the tested lower-frequency conditions and fewer observed failures. It does not establish an exact threshold or a causal voltage-margin mechanism.

The pattern is consistent with marginal voltage at boost from firmware, power delivery, or silicon. It does not distinguish among them.

Disabling System Agent Geyserville (SaGV) did not remove the fault. CPU 19 still failed 9/20. SaGV is not required for the observed behavior.

## Exclude external power as a requirement

CPU 19 reproduced with turbo enabled through either USB-C port and on battery:

| Power condition | Result |
| --- | --- |
| Front USB-C port | 1/20 `SIGSEGV` |
| Rear USB-C port | 2/20 `SIGSEGV` |
| Battery only | 2/20 `SIGSEGV` |

Battery-only failures show that the dock, USB-C input path, external adapter, household mains, and unstable external supply are not required.

The lower counts are small samples within documented rate drift. They are not evidence of improvement.

## Evaluate TME and the physical-address boundary

The affected machine used a Core Ultra 9 285HX, stepping 2, with microcode `0x122` at the later stage.

In the initial Total Memory Encryption (TME) configuration, the CPU reported 42-bit physical addressing. The flipped bit appeared to match the maximum physical address boundary.

A controlled cold boot with TME disabled restored 46-bit physical addressing. CPU 19 still failed 9/20, and a live GDB capture retained the exact `intended + 2^42` signature.

TME and Multi-Key TME (MKTME) are not required. The original maximum-physical-address correspondence was incidental.

## State the supported conclusion

Node/PGlite is an effective trigger, while the captured architectural state argues against a conventional emitted-address bug. The recurring bit, exact-CPU dependence, reversible package-load association, and native kernel manifestation support a platform-dependent execution anomaly.

The residual possibilities include unusual firmware, kernel, signal, debugger, code-integrity, and CPU interactions. The evidence does not prove a defect in every Core Ultra 9 285HX or every Dell Pro Max 18 Plus.
