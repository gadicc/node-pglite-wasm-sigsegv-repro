# Run the current diagnostic suite

This guide explains how to collect a reviewable Node/PGlite evidence bundle with `diagnose.sh`. The runner gathers unprivileged evidence and never elevates itself.

## Review resource and crash risks

> [!CAUTION]
> The release PGlite workload uses about 1.2 GiB per child. The default baseline needs about 20 GiB, intentionally triggers `SIGSEGV`, and can run for hours.

The runner disables system core dumps for its test processes. GNU Debugger (GDB) captures use a separate bounded phase. Close or control unrelated workloads when you need interpretable timing, load, or frequency comparisons.

## Install the required tools

Run the suite on Linux with these required commands:

- `bash`
- Node.js 20 or newer
- `npm ci` completed in the repository
- `taskset`
- `awk`
- Standard GNU core utilities

The runner records, but does not require, these optional tools:

- `gdb` for live fault capture
- `turbostat` for preferred load-frequency sampling
- `lscpu`
- `journalctl` and `systemctl`
- `intel-undervolt`
- Dell Command Configure `cctk`

Preflight collects the distribution, kernel, Node, V8, CPU, stepping, microcode, address sizes, topology, cpufreq state, `intel_pstate/no_turbo`, power source, and relevant kernel warnings. It reads unprivileged sources only.

## Inspect the resolved plan

Install the pinned dependency and print the plan before running a live workload:

```sh
npm ci
./diagnose.sh --dry-run
```

The plan resolves the CPU topology, phase schedule, sample counts, output path, GDB choice, and target-CPU policy.

## Choose a preset

Use the shortest preset for an initial screen:

```sh
./diagnose.sh --quick --yes
```

Use the default or full preset for larger samples:

```sh
./diagnose.sh --yes
./diagnose.sh --full --yes
```

The presets contain these schedules:

| Preset | Baseline | Group waves | Isolated rounds per CPU | Pinned-concurrent rounds | GDB attempts |
| --- | ---: | ---: | ---: | ---: | ---: |
| `--quick` | 8 children × 10 waves | 10 | 5 | 5 | 6 |
| Default | 16 children × 50 waves | 50 | 200 | 200 | 12 |
| `--full` | 16 children × 100 waves | 100 | 400 | 400 | 24 |

`--yes` accepts the safety warning. It is required for non-interactive runs.

Useful overrides include:

- `--individual-runs N`
- `--pinned-concurrent-rounds N`
- `--protocol-seed auto|N`
- `--telemetry-interval-ms N`
- `--group-waves N`
- `--gdb-max-runs N`
- `--skip-gdb` or `--run-gdb`
- `--skip-pinned-concurrent` or `--run-pinned-concurrent`
- `--out-dir DIR`
- `--cpu N|auto`

The default `--cpu auto` policy selects the worst failing CPU from validated individual results for later GDB and frequency evidence. A numeric value fixes that target. `results.json` stores the number or `null` in `config.cpuTarget` and records the distinction in `config.cpuTargetPolicy`.

On resume, the stored GDB and pinned-concurrent choices remain defaults. Use `--run-gdb` or `--run-pinned-concurrent` to reverse a previous skip. If the skipped phase already has terminal evidence, also use `--redo` for that phase.

## Understand the diagnostic phases

The runner executes these evidence stages:

1. **Preflight**: environment, topology, kernel, runtime, and frequency configuration
2. **Baseline**: the original unpinned concurrent PGlite workload
3. **Groups**: CPU-topology affinity masks, reported as wave outcomes
4. **Individual**: seeded, position-balanced direct child attempts on every usable logical CPU
5. **Pinned concurrent**: one child per active logical CPU in validated topology contexts
6. **Telemetry**: read-only frequency, temperature when available, and turbo-state samples bound to workload generations
7. **GDB**: bounded live fault capture on the selected CPU, unless skipped
8. **Report generation**: derived machine-readable results, Markdown report, privacy review, and integrity manifest

A group phase identifies an affinity mask, not the CPU that faulted. The controller and children can migrate within that mask. Use individual and pinned-concurrent evidence for exact child-to-CPU attribution.

## Understand exact-CPU outcomes

Individual evidence version 6 records four outcome classes:

- `pass`: the child completed cleanly
- `sigsegv`: the prespecified primary endpoint
- `other-workload-failure`: a securely launched child exited nonzero or received another signal
- `operational-invalid`: launch, affinity, cancellation, boundary, or protocol failure

A valid non-`SIGSEGV` workload failure commits the scheduled observation and remains descriptive. An operationally invalid attempt commits nothing and retries the same observation.

Each version-6 row retains the exit code or signal, elapsed time, CPU, round, schedule position, both turbo-state boundaries, a bounded stderr excerpt, full stderr byte count, and SHA-256 digest. The report excludes other workload failures from the clean/`SIGSEGV` denominator.

Pinned-concurrent evidence version 2 uses the same outcome model. An operational failure leaves the whole wave uncommitted. A wave with another workload failure does not enter the primary `SIGSEGV`-positive wave denominator.

A resumed version-1 pinned checkpoint remains a disclosed legacy prefix. Its stored `0` and `139` classifications keep their original meanings. Later version-2 rows add exact signal and stderr provenance.

## Run exploratory exact-CPU follow-ups

`targeted-cpu-test.mjs` runs outside the authoritative diagnostic bundle. It leaves all frequency settings untouched.

Preserve concurrent cluster load while pinning one child per CPU:

```sh
node targeted-cpu-test.mjs --mode one-to-one \
  --cpus 8-11 --rounds 50 --dry-run
node targeted-cpu-test.mjs --mode one-to-one \
  --cpus 16-19 --rounds 50 --dry-run
node targeted-cpu-test.mjs --mode one-to-one \
  --cpus 20-23 --rounds 50 --dry-run
```

Compare candidate CPUs with matched controls in a balanced seeded order:

```sh
node targeted-cpu-test.mjs --mode interleaved \
  --cpus 10,11,18,19,20,21 --rounds 50 \
  --seed 20260808 --dry-run
```

Review each plan, then replace `--dry-run` with `--yes`. Set `--out-dir DIR` when you need a specific destination. The controller selects an allowed CPU outside the target set.

Each exploratory output directory records turbo state at both boundaries, one JSON Lines row per child, and a per-CPU report. Keep additional GDB captures in separate directories rather than overwriting a completed diagnostic bundle.

## Collect optional privileged reads

`root-checks.sh` performs only allowlisted reads:

- A `dmesg` excerpt for machine check, Error Detection and Correction (EDAC), thermal, Total Memory Encryption (TME), and microcode messages
- `intel-undervolt read` and its service state
- A five-second `turbostat` sample
- `cctk` reads for `--TurboMode`, `--IntelTME`, `--IntelSagv`, `--Speedstep`, `--CStatesCtrl`, `--AdaptiveCStates`, `--ThermalManagement`, and `--SpeedShift`

Run it through `sudo` from a non-root account:

```sh
sudo ./root-checks.sh diagnostics/bundle_name
./diagnose.sh --resume diagnostics/bundle_name --yes
```

The root script stages evidence privately. An unprivileged publisher validates and publishes four allowlisted payloads with digest metadata. The completion marker is published last. Unrecognized interrupted state is refused for manual review instead of being deleted.

Published root reads provide context only. They do not authorize causal conclusions.

## Run the optional frequency A/B/A

`frequency-ab.sh` is the only script that changes a system setting. It saves the original `intel_pstate/no_turbo` value, runs A1 in the original state, B with turbo disabled, and A2 after restoration.

Run it only after the individual phase identifies a target CPU:

```sh
sudo ./frequency-ab.sh 19 20 diagnostics/bundle_name
./diagnose.sh --resume diagnostics/bundle_name --yes
```

Add `--cap KHZ` to run a separate per-CPU frequency-cap experiment after the turbo comparison:

```sh
sudo ./frequency-ab.sh 19 20 diagnostics/bundle_name --cap 2100000
```

The script verifies restoration on normal exit, errors, `SIGINT`, and `SIGTERM`. Root maintains a mode-0700 per-invoking-user restore ledger under `/run/node-pglite-wasm-sigsegv-repro/` for `SIGKILL` recovery. A per-user lock prevents overlapping experiments.

Workload legs run as the invoking user. Root writes only to a private staging directory, and an unprivileged helper publishes the evidence after settings are restored.

Tracked child exits other than clean `0` or `SIGSEGV` classification `139` remain descriptive. They disable inference but do not invalidate a completed schedule. Exit `125` is reserved for operational supervision failure and leaves the experiment incomplete.

The runner records requested and measured frequencies for each leg. It prefers `turbostat` and falls back to `scaling_cur_freq`. Do not infer an effective clock from `scaling_max_freq` alone under `intel_pstate` and Hardware-controlled Performance States (HWP).

The baseline and group sampler also fails closed. It must publish a valid frequency row and stay alive through the workload. An empty or dead sampler aborts the phase instead of becoming an apparent missing-frequency measurement. Older bundles with empty samples report frequency as unavailable.

## Verify the privileged workload executable

`sudo` and `runuser` do not initialize an interactive Node Version Manager (NVM) shell. A bare `node` can resolve to `/usr/bin/node` instead of the binary used by `diagnose.sh`.

Inspect the privileged launch path before interpreting a frequency comparison:

```sh
sudo runuser -u "$(id -un)" -- /bin/sh -c \
  'command -v node; node -p \
  "process.execPath + \" \" + process.version + \
  \" V8 \" + process.versions.v8"'
```

Record the result with the bundle. Evidence from another Node binary remains valid for that binary, but it is not a frequency control for the runtime used by other phases.

## Resume or repeat a phase

Resume an interrupted run without discarding validated completed work:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

Repeat a phase in one new contiguous session with `--redo`:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z \
  --redo individual --individual-runs 50 --yes
```

The runner moves prior evidence to `state/superseded/`; it does not delete it. Redoing preflight invalidates the complete downstream closure.

Read [understand evidence bundles](../reference/evidence-bundles.md) before recovering an incomplete or legacy bundle.
