# Compare related reports

This page compares public reports with the case study's exact CPU localization and recurring `intended address + 2^42` fault signature. Similar topology or symptoms do not prove the same mechanism.

As of 2026-08-19, no indexed public report contained the complete recurring signature captured here: an ordinary memory access with clean operands and a reported linear fault address exactly `2^42` above its intended address.

## Compare Ubuntu bug 2158237

[Ubuntu bug 2158237](https://bugs.launchpad.net/bugs/2158237) concerns another Dell Pro Max 18 Plus MB18250 with a Core Ultra 9 285HX.

During an NVIDIA Dynamic Kernel Module Support (DKMS) build, GCC failed while moving source locations, generated an incorrect configure-test result, and triggered a kernel page fault in `post_alloc_hook` on CPU 19.

Its affinity tests reported:

- CPUs 0-7 passed
- CPUs 8-15 passed
- CPUs 16-23 failed
- CPUs 16-19 produced the strongest failures, including hangs or wedges
- CPU 19 was the leading suspect

The investigator's [full affinity analysis](https://www.mail-archive.com/ubuntu-bugs%40lists.ubuntu.com/msg6288457.html) classified the issue as platform, kernel, firmware, or hardware rather than an NVIDIA source failure.

A second MB18250 with a Core Ultra 7 265HX passed the same build on every tested group, including CPUs 16-19. The [comparison-system follow-up](https://www.mail-archive.com/ubuntu-bugs%40lists.ubuntu.com/msg6288458.html) narrows the observation to the affected system, firmware, processor sample, or cluster combination rather than a generic build bug.

The affected Ubuntu system used BIOS 2.6.1 and microcode `0x11b`. This repository records E-core-localized failures on BIOS 3.3.2 and microcode `0x122`.

CPU 19 is the highest-rate isolated target and source of the clearest userspace and kernel captures in this repository. It is not the only logical CPU that faulted:

- Isolated failures appeared on CPUs 11, 19, 21, and 23
- Pinned-concurrent failures appeared on CPUs 9, 11, 17, 19, 21, 22, and 23

All were E-cores in this topology. The important overlap is E-core localization with strong CPU 19 involvement, not exclusivity to CPU 19 or cluster 16-19.

The Ubuntu report does not publish the complete `post_alloc_hook` oops or an effective-address calculation. It cannot establish the same `+2^42` mechanism. Its independently reported model, processor, E-core localization, nondeterministic userspace failures, kernel page fault, and CPU 19 involvement make it the closest public corroboration found.

## Compare Intel's Arrow Lake specification update

Intel's [Core Ultra Series 2 specification update](https://edc.intel.com/content/www/us/en/design/products/platforms/details/arrow-lake-s/core-ultra-200s-series-processors-specification-update/summary-tables-of-changes/) was revision 021, dated 2026-07-01, at the time of review.

None of ARL001 through ARL074 described:

- An Address Generation Unit (AGU) error
- A CR2 bit-42 addition
- An ordinary load or store using `effective address + 0x40000000000`

The nearest wording-level candidates were:

- ARL036: incorrect data and unpredictable behavior around C6+ transitions, marked fixed for HX
- ARL037: a core may hang entering or exiting C6+, with a planned HX fix
- ARL029: incorrect TLB entry after virtual-machine exit, marked fixed for HX
- ARL047: indirect branches may execute incorrect instructions, marked fixed for HX

Their stated triggers and implications do not match the captures in this repository.

Intel's [2026-08-11 microcode release](https://github.com/intel/Intel-Linux-Processor-Microcode-Data-Files/blob/main/releasenote.md) updated Arrow Lake-S/HX B0, CPUID `06-c6-02/82`, from `0x121` to `0x122`. The userspace and native kernel captures here reproduced on `0x122`.

## Compare the Arrow Lake-HX Windows report cluster

A large [Microsoft Q&A report cluster](https://learn.microsoft.com/en-us/answers/questions/5921413/recurring-0x1e-bugcheck-in-nt-exppooltrackercharge) covers Arrow Lake-HX 265HX, 275HX, and 285HX systems from several manufacturers.

Two full dumps reported `lock xadd qword ptr [r14+r8],rbp` raising a general-protection fault even though the computed address was valid, writable, and canonical.

A Lenovo 275HX reproducer reported failures only on E-cores, including logical CPU 19, and only under its Performance power profile. A P-core-only attempt passed.

Other dumps in the cluster contain stale or invalid pointers. The cluster is mixed evidence, not an exact duplicate.

A Dell community manager stated on 2026-08-11 that the associated issue was [under investigation with Microsoft and Intel](https://www.dell.com/community/en/conversations/alienware/aurora-16x-ac16251-bsods-and-kernel-pool-corrupted-0x1e-0x3b-0x7e-0xc0000005-during-idlebackground-activity-on-core-ultra-9-275hx/6a42b880e2a46e7a5aed9b63).

## Distinguish software reports with other signatures

These reports involve Node, V8, PGlite, or WebAssembly but have materially different failure modes:

- [Node.js issue 62393](https://github.com/nodejs/node/issues/62393): intermittent V8 garbage-collection crash on macOS arm64 with workers and `vm`
- [Node.js issue 63421](https://github.com/nodejs/node/issues/63421): deterministic V8 Turboshaft WebAssembly Zone out-of-memory failure
- [Node.js issue 41319](https://github.com/nodejs/node/issues/41319): large virtual-address reservations for WebAssembly modules
- [PGlite issue 339](https://github.com/electric-sql/pglite/issues/339): JavaScript `RuntimeError: Out of bounds memory access` on Bun and PGlite 0.2.6
- [PGlite issue 802](https://github.com/electric-sql/pglite/issues/802): retained PGlite WebAssembly memory in a larger application
- [V8 issue 42203228](https://issues.chromium.org/issues/42203228): lazy and background compilation feedback-vector handling across instances and isolates

Different platforms, failure modes, and sharing models make these useful background, not signature matches.

## State the comparison boundary

The public reports strengthen the case for investigating Arrow Lake-HX platform behavior, E-core sensitivity, and CPU 19 exposure. None independently proves the `+2^42` mechanism.

Treat model, topology, and symptom similarities as hypothesis support. Require a live fault-address calculation before claiming the same fault.
