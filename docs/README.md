# Find the right project document

This index separates instructions for running the current tooling from the results measured on the affected machine. Start with an operational guide when you are collecting new evidence. Use the case study when you are evaluating the existing investigation.

## Understand the project

- [Project direction](project-direction.md): scope, public identity, retained workloads, and migration boundaries
- [Repository README](../README.md): safety, current commands, findings summary, and entry points

## Run the current tools

- [Run a generic exact-CPU workload](guides/generic-exact-cpu.md): built-in and custom workload selection, dry runs, live execution, and schema-3 resume
- [Run generic baseline waves](guides/generic-baseline.md): correlated-wave planning, schema-3 v2 creation, resume, and its bound exact phase
- [Run generic CPU-group waves](guides/generic-cpu-groups.md): explicit topology plans, schema-3 v3 creation, whole-wave resume, and sibling phases
- [Run generic pinned-concurrent waves](guides/generic-pinned-concurrent.md): explicit controller/active plans, schema-3 v4 creation, controller placement, and sibling phases
- [Run a generic controlled-load comparison](guides/generic-controlled-load.md): trusted measured and condition workloads, schema-3 v5 creation, complete-only A1/B/A2 resume, and its sibling exact phase
- [Summarize a schema-3 bundle](guides/schema3-summaries.md): read-only text and JSON views of validated v1-v5 progress, outcomes, contexts, legs, and CPUs
- [Run the diagnostic suite](guides/run-diagnostics.md): prerequisites, presets, exact-CPU protocols, optional privileged steps, and exploratory follow-ups
- [Run controlled-load experiments](guides/controlled-load-experiments.md): load-state A/B/A, GDB capture, Node A/B/A, and Node/warmup matrix modes
- [Understand evidence bundles](reference/evidence-bundles.md): output layout, integrity, privacy, resume, redo, and phase validation
- [Interpret experimental results](concepts/interpreting-results.md): denominators, confidence intervals, dependence, causal limits, and fault-signature matching

## Review the investigation

- [Case-study index](case-study/README.md): investigation chronology and inference boundaries
- [Trace the original PGlite reproduction](case-study/origin-and-reproduction.md): original workload, Node matrix, and post-report flag sweep
- [Understand the fault signature and CPU localization](case-study/fault-signature-and-cpu-localization.md): live captures, topology, load, frequency, and power controls
- [Understand the reduced and native triggers](case-study/reduced-and-native-triggers.md): minimal WebAssembly probes, the C harness, and kernel oopses
- [Review software controls](case-study/software-controls.md): runtime, PGlite debug build, kernels, and Node/V8 provenance
- [Apply temporary workarounds](case-study/workarounds.md): tested mitigations and their limits
- [Compare related reports](case-study/related-reports.md): independent platform reports, Intel errata, and software reports with different signatures
- [Review preliminary raw CPU-isolation notes](../core-isolation-test.md): superseded console transcript retained for history

## Develop the tooling

- [Architecture decisions](decisions/README.md): trust, lifecycle, evidence typing, schema compatibility, and privileged-state boundaries
- [Workload catalog](../workloads/README.md): built-in roles and custom workload-contract JSON
- [Develop and test the tooling](development.md): offline tests, safe test scope, and repository boundaries
- [Understand internal attempt records](reference/attempt-records.md): workload binding, typed outcomes, cleanup evidence, and canonical record bindings
- [Understand internal exact-CPU phase envelopes](reference/exact-cpu-phase-envelopes.md): schedule identity, attempt slots, affinity, durable publication, and exact-prefix resume
- [Understand baseline concurrent waves](reference/baseline-concurrent-waves.md): correlated wave identity, child slots, all-or-nothing publication, and exact-prefix resume
- [Understand CPU-group waves](reference/group-topology-waves.md): overlapping topology contexts, inherited masks, balanced scheduling, and whole-wave resume
- [Understand pinned-concurrent waves](reference/pinned-concurrent-waves.md): controller placement, singleton child affinity, balanced scheduling, and whole-wave resume
- [Understand managed auxiliary workloads](reference/managed-auxiliary-workloads.md): verified readiness, silent output, bounded cleanup, and separation from diagnostic attempts
- [Understand controlled-load worker sets](reference/controlled-load-worker-sets.md): complete readiness, stable boundary identities, peer cancellation, and stop evidence
- [Understand controlled-load A/B/A sessions](reference/controlled-load-aba-sessions.md): one target workload, complete B bracketing, and all-or-nothing session evidence
- [Understand controlled-load phase storage](reference/controlled-load-phase-storage.md): complete-only no-clobber publication, manifest-v5 identity, and exclusive ownership
- [Node/V8 source-history review](../research/node-v8-25.2.1-to-26.7.0-review.md): 5,693-commit source and provenance screen
- [Node/V8 screened-commit audit](../research/node-v8-screened-commits.tsv): complete disposition table for the source-history review

The unpublished Ubuntu follow-up draft in `research/` is intentionally outside this navigation map. Review and publication require a separate decision.
