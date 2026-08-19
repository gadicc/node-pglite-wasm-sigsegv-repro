# Review the CPU-localized fault case study

This case study records measurements from one affected Dell Pro Max 18 Plus with a Core Ultra 9 285HX. It separates direct observations from interpretation and does not claim that every system with the same model or processor is affected.

## Follow the investigation

Read the study in this order:

1. [Trace the original PGlite reproduction](origin-and-reproduction.md)
2. [Understand the fault signature and CPU localization](fault-signature-and-cpu-localization.md)
3. [Understand the reduced and native triggers](reduced-and-native-triggers.md)
4. [Review software controls](software-controls.md)
5. [Apply temporary workarounds](workarounds.md)
6. [Compare related reports](related-reports.md)

The [Node/V8 source-history review](../../research/node-v8-25.2.1-to-26.7.0-review.md) preserves a separate 5,693-commit audit of candidate source changes and binary-provenance confounders.

## Keep the evidence boundary visible

The strongest recurring observations are:

- Live userspace captures with a mapped intended address and `si_addr = intended + 2^42`
- A kernel-mode oops with the same `+2^42` address relationship
- Exact-CPU reproduction concentrated on E-cores in the tested protocols
- A high rate on CPU 19 under package load
- Reproduction across several Node/V8 versions and two tested kernels

These observations make a platform-dependent execution anomaly more plausible than a conventional Node, V8, or PGlite address-generation bug. They do not formally prove defective silicon or exclude every debugger, kernel, firmware, signal, and runtime interaction.

## Distinguish historical stages

The investigation changed its working model as evidence improved:

- Concurrency first appeared necessary because it increased scheduler exposure
- Single-process CPU pinning later showed that concurrency was not required
- Group masks first identified topology regions but not exact faulting CPUs
- Seeded individual and pinned-concurrent protocols expanded the observed CPU set
- PGlite first appeared essential, but WebAssembly module churn later reproduced without it
- Native pure-execution replicas stayed clean, while a mapping-heavy native mode exposed a kernel manifestation

Read old zero-failure observations in their original sample and protocol context. They do not override later positive captures.
