# Fault Affinity

Fault Affinity is a Linux harness for bounded, resumable investigation of intermittent CPU-sensitive process faults. It runs an explicitly selected workload across deterministic CPU-affinity schedules and records reviewable evidence. Observed affinity is evidence about where a workload reproduced; it is not, by itself, proof of CPU causation.

The project began with native faults during Node.js and PGlite WebAssembly initialization. That workload remains as a historical heavyweight built-in and case study. The recommended reduced built-in is now the dependency-free WebAssembly churn workload.

The public generic commands own exact-only, baseline, explicit CPU-group, and
controller-aware pinned-concurrent schema-3 bundles. The broader legacy
diagnostic suite still provides telemetry, debugger, frequency, and final-report
phases specifically for the Node/PGlite investigation.

## Safety

> [!CAUTION]
> Live workloads are expected to consume CPU and may terminate abnormally. The original PGlite workload uses about 1.2 GiB per child; its default 16-child legacy baseline needs about 20 GiB. Always inspect and dry-run a plan first.

> [!WARNING]
> The native `churn-mem` experiment produced kernel oopses on the affected machine. One oops left an unkillable process until reboot. Do not run native churn modes unless a hang or forced reboot is acceptable.

Custom workloads are trusted local programs, not sandboxed code. They run with the invoking account's access and must not daemonize or leave the supervised process group.

The generic command and main legacy diagnostic runner do not require root. They do not change firmware, write sysfs settings, or alter unrelated process affinity. Optional root operations live in separate scripts for review before use.

## Start with the generic commands

Listing, inspection, and dry runs do not execute a workload:

```sh
node fault-affinity.mjs workloads
node fault-affinity.mjs inspect --workload wasm-churn-suite
node fault-affinity.mjs baseline \
  --workload wasm-churn-suite \
  --children 4 \
  --waves 10 \
  --exact-cpus 18-21 \
  --exact-rounds 10 \
  --out-dir diagnostics/wasm-baseline \
  --dry-run
node fault-affinity.mjs exact \
  --workload wasm-churn \
  --cpus 19 \
  --rounds 10 \
  --out-dir diagnostics/wasm-exact \
  --dry-run
```

A live run needs the same explicit selection plus `--yes`:

```sh
node fault-affinity.mjs exact \
  --workload wasm-churn \
  --cpus 19 \
  --rounds 10 \
  --out-dir diagnostics/wasm-exact \
  --yes

node fault-affinity.mjs exact \
  --resume diagnostics/wasm-exact \
  --workload wasm-churn \
  --yes
```

Use `--workload-file path/to/workload.json` to select a trusted local script or binary. `wasm-churn` and `node-pglite` preserve their exact-only identities; the `-suite` profiles declare baseline, group, pinned-concurrent, and exact capabilities without changing old bundle identities. Read [run generic baseline waves](docs/guides/generic-baseline.md) and [run a generic exact-CPU workload](docs/guides/generic-exact-cpu.md). These commands do not yet produce the legacy suite's complete report.

For CPU-group screening, a bounded JSON plan explicitly binds baseline, group
topology, and exact schedules before execution. See
[run generic CPU-group waves](docs/guides/generic-cpu-groups.md).

For controller-aware waves, a version-4 plan also binds one distinct controller
CPU and one independently supervised child per active CPU. See
[run generic pinned-concurrent waves](docs/guides/generic-pinned-concurrent.md).

## Reproduce the historical Node/PGlite failure

The original child creates an in-memory PGlite 0.5.4 client, runs `SELECT 1`, closes the client, and exits. There is no application framework, test runner, native add-on, or database persistence.

On Linux x64 with Node 24 or newer:

```sh
npm ci
npm run repro
```

The default runs 16 concurrent children for up to 50 waves and stops after the first failed wave. Supply another child and wave count as positional arguments:

```sh
npm run repro -- 16 50
STOP_ON_FAILURE=0 npm run repro -- 16 50
npm run repro:sequential
```

Expected behavior is a clean exit from every child. On the affected system, some children terminate from `SIGSEGV`:

```text
wave=8 passed=15/16
child=10 code=null signal=SIGSEGV elapsedMs=4315
failedWaves=1 completedWaves=8 requestedWaves=50
```

Sixteen release-build clients produced a measured cgroup peak of about 19 GiB. A smaller machine may produce a legitimate out-of-memory failure instead of the fault under investigation.

## Run the legacy Node/PGlite diagnostic suite

`diagnose.sh` preserves the original Node/PGlite workflow. It collects environment data, runs baseline and CPU-localization protocols, samples read-only telemetry, optionally captures a live GNU Debugger (GDB) fault, and creates an integrity-checked evidence bundle.

Inspect the plan before a live run:

```sh
npm ci
./diagnose.sh --dry-run
./diagnose.sh --quick --yes
```

The available presets are:

| Preset | Baseline | Group waves | Isolated rounds per CPU | Pinned-concurrent rounds | GDB attempts |
| --- | ---: | ---: | ---: | ---: | ---: |
| `--quick` | 8 × 10 | 10 | 5 | 5 | 6 |
| Default | 16 × 50 | 50 | 200 | 200 | 12 |
| `--full` | 16 × 100 | 100 | 400 | 400 | 24 |

`--yes` accepts the safety warning and is required outside an interactive terminal. Use `--skip-gdb` when you do not want debugger capture. Resume an interrupted bundle with:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

Read [run the diagnostic suite](docs/guides/run-diagnostics.md) before collecting evidence for publication or support.

## Run legacy controlled-load experiments

`load-state-aba.mjs` pins one `/usr/bin/yes` worker to each selected load CPU and verifies each worker through `/proc`. A dry run is the default. A live experiment requires `--yes`.

```sh
npm run load:aba
npm run load:aba -- --yes
```

The current modes compare:

- **Load state**: A1 without script-induced load, B with induced load, then recovered A2
- **GDB under load**: bounded live fault capture while verified load remains active
- **Node A/B/A**: exact Node A, Node B, then Node A under one uninterrupted load
- **Node matrix**: seeded Node and warmup combinations in separate recovered load cycles

See [run controlled-load experiments](docs/guides/controlled-load-experiments.md) for exact commands, controls, and interpretation.

## Use the reduced triggers

The repository now contains smaller triggers than PGlite:

| Trigger | Current role | Observed result on CPU 19 under package load |
| --- | --- | --- |
| `mini-wasm-churn.mjs` | Recommended reduced trigger | 15/15 and 10/10 `SIGSEGV` in two documented sessions |
| `mini-wasm.mjs` | Lower-rate static WebAssembly probe | 1/10, 1/20, then 0/20 |
| `child.mjs` with PGlite | Original application-derived trigger | 9/10 and 10/10 in matched sessions |
| `repro-c.c` | Native controls and disruptive experiments | Pure execution stayed clean; `churn-mem` produced two kernel oopses |

`mini-wasm-churn.mjs` compiles, instantiates, executes, and retires a fresh module each round. Through `fault-affinity --workload wasm-churn`, each attempt has a bounded survival window and supervised cleanup. Direct invocation remains unbounded.

Read [understand the reduced and native triggers](docs/case-study/reduced-and-native-triggers.md) before using the native harness.

## Key findings from the affected machine

The measurements in this repository describe one affected Dell Pro Max 18 Plus with a Core Ultra 9 285HX. They do not establish a defect in every system with that model or processor.

- Live GDB captures repeatedly recorded an ordinary memory access with a valid, mapped intended address and a reported fault address exactly `2^42` higher
- A later native test captured the same `+2^42` address anomaly in kernel mode during syscall entry
- Exact-CPU protocols observed failures only on E-cores in these sessions, with CPU 19 producing the highest isolated failure rate
- A single process pinned to a susceptible CPU reproduced the fault, so concurrency was not required
- Verified activity elsewhere on the package changed the CPU 19 failure rate from 0/20 to 19/20 and back to 0/20 in one A/B/A session
- Lower-frequency legs produced no observed failures in the documented CPU 19 A/B/A tests, but the sequential design did not prove a frequency mechanism
- Node, V8, PGlite, kernel, power-source, and memory-pressure controls changed triggerability without explaining the recurring address signature

The evidence points toward a platform-dependent execution anomaly, not a conventional Node or PGlite address-generation bug. It remains evidence, not formal proof of a defective CPU or a universal root cause.

Read the [case-study index](docs/case-study/README.md) for measured results and inference boundaries.

## Legacy evidence integrity and privacy

Completed legacy diagnostic bundles contain `report.md`, machine-readable results, phase logs, telemetry, a privacy-review aid, and `manifest.txt`. Generic schema-3 bundles use their own complete-prefix semantics described in the generic guides.

`manifest.txt` is the readiness token. Treat a bundle as complete only when this command succeeds inside the bundle:

```sh
sha256sum -c manifest.txt
```

Review `privacy-review.txt` and every flagged raw file before sharing. The collectors exclude known service tags, serial numbers, UUIDs, Media Access Control (MAC) addresses, and BIOS passwords. Raw debugger and third-party output can still contain local paths or unexpected identifiers.

Send the whole verified bundle through an appropriate secure channel. Do not add a service tag to the archive; provide it separately through the support case.

See [understand evidence bundles](docs/reference/evidence-bundles.md) for generation binding, resume rules, superseded data, and privileged evidence publication.

## Optional privileged companions

The diagnostic runner never elevates itself. Review the companion scripts before invoking them:

```sh
sudo ./root-checks.sh diagnostics/bundle_name
sudo ./frequency-ab.sh 19 20 diagnostics/bundle_name
./diagnose.sh --resume diagnostics/bundle_name --yes
```

`root-checks.sh` performs allowlisted reads. `frequency-ab.sh` temporarily changes `intel_pstate/no_turbo`, verifies restoration, and records the A/B/A result. It is the only repository script that changes a system setting.

## Docker and runtime controls

The Dockerfile pins an official `node:26-bookworm` image digest and uses the checked-in lockfile:

```sh
docker build -t pglite-node-sigsegv-repro .
docker run --rm pglite-node-sigsegv-repro
```

Docker changes userspace and the Node installation, but it shares the host kernel and CPU.

Run the Deno control with:

```sh
deno run -A deno-repro.ts 16 50
CHILD_V8_FLAGS=--no-liftoff deno run -A deno-repro.ts 16 50
```

See [software controls](docs/case-study/software-controls.md) for the recorded Node, Deno, Bun, V8 flag, build, and kernel comparisons.

## Documentation

- [Documentation map](docs/README.md)
- [Project direction](docs/project-direction.md)
- [Run generic baseline waves](docs/guides/generic-baseline.md)
- [Run generic CPU-group waves](docs/guides/generic-cpu-groups.md)
- [Run generic pinned-concurrent waves](docs/guides/generic-pinned-concurrent.md)
- [Run a generic exact-CPU workload](docs/guides/generic-exact-cpu.md)
- [Run the diagnostic suite](docs/guides/run-diagnostics.md)
- [Run controlled-load experiments](docs/guides/controlled-load-experiments.md)
- [Understand evidence bundles](docs/reference/evidence-bundles.md)
- [Interpret experimental results](docs/concepts/interpreting-results.md)
- [Case-study index](docs/case-study/README.md)
- [Develop and test the tooling](docs/development.md)

## Filed reports

- [Node.js issue 64500](https://github.com/nodejs/node/issues/64500)
- [PGlite issue 1053](https://github.com/electric-sql/pglite/issues/1053)

The closest independent platform report is [Ubuntu bug 2158237](https://bugs.launchpad.net/bugs/2158237). See [related reports](docs/case-study/related-reports.md) for the comparison and important differences.
