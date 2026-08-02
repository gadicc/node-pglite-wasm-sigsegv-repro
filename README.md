# Concurrent PGlite processes can SIGSEGV Node.js

Minimal, framework-free reproduction for intermittent native Node.js crashes
while multiple processes initialize PGlite's PostgreSQL WebAssembly module.

Each child creates an in-memory PGlite 0.5.4 client, runs `SELECT 1`, awaits
`client.close()`, and exits. There is no Vitest, Vite, test runner, native
addon, application code, or database persistence.

## Filed reports

- [nodejs/node#64500](https://github.com/nodejs/node/issues/64500)
- [electric-sql/pglite#1053](https://github.com/electric-sql/pglite/issues/1053)

## Reproduce

> [!CAUTION]
> Sixteen concurrent PGlite clients require substantial memory. The observed
> cgroup peak was approximately 19 GiB. Use a machine or container with at
> least 20 GiB available; a smaller machine may experience a legitimate OOM
> instead of the reported crash.

On Linux x64 with Node 22 or newer:

```sh
npm ci
npm run repro
```

The default is 16 concurrent children for up to 50 waves. The run stops after
the first failed wave. The child count and wave count can be changed:

```sh
npm run repro -- 16 50
```

To continue after failures and collect full-run statistics:

```sh
STOP_ON_FAILURE=0 npm run repro -- 16 50
```

The sequential control runs the same workload one child at a time:

```sh
npm run repro:sequential
```

## Diagnostic runner (`diagnose.sh`)

`diagnose.sh` automates the full investigation this repository documents:
environment collection, baseline reproduction, CPU-group isolation,
per-CPU isolation, GDB fault-signature capture, and a statistically honest
Markdown report. It is meant to take a machine "from zero" to a shareable
evidence bundle with one command, and every conclusion in the generated
report is derived from that run's own measurements — nothing is assumed
from prior results.

> [!CAUTION]
> The workload is memory-intensive (~1.2 GiB per child process; the default
> baseline needs ~20 GiB), intentionally triggers SIGSEGV crashes, and a
> full run can take one to several hours. System core dumps are disabled
> for the test processes; GDB captures are collected separately.

### Dependencies

Required: `bash`, `node` (with `npm ci` done here), `taskset`, `awk`, and
standard coreutils. Optional (recorded in the report when missing, never
fatal): `gdb` (phase 6), `turbostat` (preferred load-frequency sampling),
`lscpu`, `journalctl`/`systemctl`, `intel-undervolt`, and Dell `cctk`.
The runner never requires root and never elevates privileges itself.

Preflight collects distribution/kernel/Node/V8 versions, CPU model,
stepping, microcode, address sizes, topology (P/E cores, clusters, shared
L2, cpufreq policies), cpufreq state, `intel_pstate/no_turbo`, power
source, and relevant kernel warnings (MCE/EDAC/thermal/TME/microcode) from
unprivileged sources. Service tags, serial numbers, UUIDs, MAC addresses,
and BIOS passwords are never collected.

### Privileged companion scripts (manual, reviewable)

Everything that needs root is kept out of `diagnose.sh` in two small
standalone scripts, meant to be read before being run:

```sh
sudo ./root-checks.sh diagnostics/<bundle>       # read-only evidence
sudo ./frequency-ab.sh 19 20 diagnostics/<bundle> # the A/B/A experiment
./diagnose.sh --resume diagnostics/<bundle> --yes # regenerate the report
```

- `root-checks.sh` performs only *reads*: a `dmesg` excerpt
  (MCE/EDAC/thermal/TME/microcode), `intel-undervolt read` plus its
  service state, a 5-second `turbostat` sample, and an explicit allowlist
  of read-only `cctk` BIOS settings (`--TurboMode`, `--IntelTME`,
  `--IntelSagv`, `--Speedstep`, `--CStatesCtrl`, `--AdaptiveCStates`,
  `--ThermalManagement`, `--SpeedShift`). It never writes BIOS settings,
  never takes a password, and never produces a full `cctk` export.
- `frequency-ab.sh` is the only script that changes anything; see below.

### Frequency A/B/A (`frequency-ab.sh`)

The turbo A/B/A experiment temporarily changes a runtime setting, so it is
deliberately a separate manual step run as root. It saves the original
`intel_pstate/no_turbo` value first, then runs single-child tests on the
CPU you give it (use the highest-failure CPU from phase 4) as **A**
(original state) → **B** (turbo disabled) → **A** (original state
restored). Every setting is restored on normal exit, failure, SIGINT, or
SIGTERM, and the restore is verified and recorded in the bundle. Workload
legs run as the invoking user via `runuser` when possible. Requested *and*
measured frequencies (turbostat preferred, `scaling_cur_freq` fallback)
are reported per leg; never trust `scaling_max_freq` alone on
intel_pstate/HWP. A separate, clearly labelled per-CPU cap experiment is
available via `--cap KHZ`. BIOS settings are never changed.

### Quick and full examples

```sh
npm ci
./diagnose.sh --quick --yes      # ~10 minutes: small baseline, 10 group
                                 # waves, 5 runs per CPU, 6 gdb runs
./diagnose.sh --yes              # default: 16x50 baseline, 50 group waves,
                                 # 50 runs per CPU, 12 gdb runs
./diagnose.sh --full --yes       # hours: 16x100 baseline, 100 group waves,
                                 # 100 runs on every online CPU, 24 gdb runs
./diagnose.sh --dry-run          # print the resolved plan and exit
```

`--yes` accepts the safety warning (required when not interactive).
Useful overrides: `--individual-runs N`, `--group-waves N`,
`--gdb-max-runs N`, `--skip-gdb`, `--out-dir DIR`, `--cpu N`.

### Output layout and resumability

Everything lands in a timestamped bundle, `diagnostics/<UTC timestamp>/`
(override with `--out-dir`):

- `report.md` — the human report (see below)
- `results.json` — machine-readable results
- `commands.log`, `run.log` — exact command log and progress log
- `env/` — sanitized system-information files (`env/root/` if
  `root-checks.sh` was run)
- `logs/` — raw stdout/stderr per phase
- `freq/` — frequency samples per phase
- `gdb/` — capture transcripts
- `manifest.txt` — file names and SHA-256 checksums

Phases mark completion under `state/`; an interrupted run (SIGINT/SIGTERM
writes a partial report first) can be resumed without discarding finished
work — including partially completed per-CPU tables, which are topped up
by running only the missing runs:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

To instead *repeat* a phase from scratch in one contiguous session (for
example the per-CPU tests, so all runs share one turbo/load regime), use
`--redo`. The previous data is moved to `state/superseded/`, never
deleted:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z \
  --redo individual --individual-runs 50 --yes
```

### Interpreting the report

Rates are reported with Wilson 95% confidence intervals; the concentration
of failures across CPUs is assessed with a permutation test (chi-square
statistic over the per-CPU counts, seeded shuffles — never a Fisher test on
an outcome-defined grouping); the frequency legs get an exact
comparison on SIGSEGV counts over valid runs plus, separately labelled, the
binomial probability of the
clean leg *under an assumed fixed baseline rate*. Wave failures are kept
distinct from individual child-process failures. The conclusions section
states only what this run supports: whether the problem reproduced,
whether it localized to particular CPUs or topology groups, whether lower
frequency suppressed it, whether the GDB fault matches the documented
`intended + 2^42` signature, which hypotheses the collected configuration
rules out, and what remains uncertain.

**Clean-run statistics are one-sided.** Zero failures in `n` runs never
prove a zero rate; the report shows the exact 95% upper bound
`1 - 0.05^(1/n)` (approximately `3/n`). A CPU with 50 clean runs is only
cleared of per-run rates above ~5.8%, and observed rates can drift between
batches, so treat "clean" verdicts as exclusions of high rates, not proof
of correct hardware.

### Testing the tooling

`bash diagnose-lib/tests/run-tests.sh` runs the offline test suite:
CPU-list parsing, settings-restore-on-signal simulation, argument and
exit-code checks, statistics and parser unit tests with fixtures, and an
end-to-end collect+report pass on a synthetic bundle. It does not run the
crash workload.

## Docker

The Dockerfile pins the tested official `node:26-bookworm` image digest and
uses the checked-in npm lockfile:

```sh
docker build -t pglite-node-sigsegv-repro .
docker run --rm pglite-node-sigsegv-repro
```

Docker replaces the host userspace and Node installation, but still shares the
host kernel and CPU.

## Expected and actual behavior

Expected: every child exits with code 0 after closing its PGlite client.

Actual: an intermittent child terminates from `SIGSEGV`, for example:

```text
node=v26.5.0 v8=14.6.202.34-node.24 platform=linux arch=x64 children=16 waves=50
wave=1 passed=16/16
...
wave=8 passed=15/16
child=10 code=null signal=SIGSEGV elapsedMs=4315
failedWaves=1 completedWaves=8 requestedWaves=50
```

One Node 25.2.1 run failed 4 of 20 waves, with five children receiving
`SIGSEGV`. The cgroup recorded `oom=0` and `oom_kill=0`.

## Reproduction matrix

Official `node:<major>-bookworm` images on the same host:

| Node | Default Node flags (no V8 CLI overrides) |
| --- | --- |
| 26 | Two clean runs failed at waves 13 and 8; the final Docker build failed at wave 8 |
| 25 | 1/20 waves failed |
| 24 | 4/45 waves failed; the final locked Docker build failed at wave 15 |
| 22 | 1/10 waves failed |
| 20 | 0/40 waves failed |

The Node 20 result is a non-reproduction in 40 intermittent waves, not evidence
that Node 20 is unaffected. The relevant exposed defaults are the same in the
official Node 20, 22, 24, and 26 images: Liftoff, lazy compilation, dynamic
tiering, and WASM tier-up are enabled, with up to 128 compilation tasks. Node
20 did reproduce when `--no-liftoff` forced the optimizing compiler, so the
underlying crash is not established as a post-20 regression.

The newest available official Node V8-canary was also tested after verifying
its published SHA-256 checksum:

- Node `v27.0.0-v8-canary202607066c1f8ebea4`
- V8 `15.2.20-node.7`

| Node 27 canary mode | Result |
| --- | --- |
| Default `child_process.fork()`, 16 children | SIGSEGV at wave 17 |
| `--no-wasm-tier-up`, 16 children | SIGSEGV at wave 12 |
| `--liftoff-only`, 16 children | SIGSEGV at wave 12 |
| Ordinary `child_process.spawn()`, 16 children | 48/50 waves passed; SIGSEGV at waves 3 and 14 |
| Sequential `child_process.fork()`, one child | 50/50 waves passed |

The canary results show that neither IPC nor optimized WASM compilation is
universally required. Concurrency is the stable trigger in the measured Node
configurations.

> **Update (2026-07-31):** "Concurrency is the stable trigger" is superseded.
> A single process pinned to a defective core reproduces the crash with no
> other load; concurrency only ensured scheduler exposure to the defective
> cores. See "Update (2026-07-31): isolated to three physical cores" below.

## Post-report flag and version sweep

After filing, the host (Linux x64, 24 cores, Node v25.2.1, V8
14.1.146.11-node.14) reproduced the crash far more aggressively than the
Docker matrix: every run failed between waves 1 and 5. A systematic sweep
found no V8 flag and no released Node version that prevents the crash.
Each row used 16 children for up to 100 waves and stopped at the first
failed wave:

| Configuration | Result |
| --- | --- |
| Node v25.2.1, default | SIGSEGV at wave 5 |
| `--no-wasm-tier-up` | SIGSEGV at wave 4 |
| `--no-wasm-lazy-compilation` | no SIGSEGV, but unusable: even a single child deterministically exits 13 with an unsettled top-level await in `client.query` |
| `--liftoff-only` | SIGSEGV at wave 3 (two children) |
| `--no-concurrent-marking` | SIGSEGV at wave 1 |
| `--single-threaded-gc` | SIGSEGV at wave 2 (two children) |
| Node v25.9.0 (V8 14.1.146.11-node.25), default | SIGSEGV at wave 1 |
| Node v26.5.1 (V8 14.6.202.34-node.24), default | SIGSEGV at wave 1 |

Two consequences:

- The Node report's observation that `--no-wasm-tier-up` passed 100/100
  waves did not reproduce and was luck; a single clean run is not evidence
  of mitigation for this intermittent crash.
- The crash survives `--liftoff-only`, `--no-wasm-tier-up`,
  `--no-concurrent-marking`, and `--single-threaded-gc`, so background
  optimizing compilation and concurrent GC threads are not required. The
  remaining shared paths are lazy Liftoff compilation and the WASM trap
  handling on the main thread, with cross-process machine load as the
  likely timing perturber.

> **Update (2026-07-31):** the "likely timing perturber" framing is also
> superseded — no cross-process load is required. See "Update (2026-07-31):
> isolated to three physical cores" below.

## Root-cause investigation (2026-07-30): platform-level address corruption

A full native investigation on the affected machine found that the crashes
are not caused by Node, V8, or PGlite. The evidence points to sporadic
single-bit corruption of faulting linear addresses in the CPU's address
path under heavy concurrent load.

### The fault-address signature

Children were run under `gdb --batch` with `handle SIGSEGV stop nopass`,
capturing the pristine fault context before Node's trap handler runs. Every
captured fault had the same shape: the faulting instruction is an ordinary
register-relative memory access whose architecturally intended address is
valid and mapped, but the kernel-reported fault address (`si_addr`/CR2)
equals the intended address with an extra high bit set.

| Capture | Faulting instruction | Intended address | `si_addr` | Intended address mapped? |
| --- | --- | --- | --- | --- |
| Node 25.2.1, gdb | `addl $1, 0x1c0(%r13)`, `r13=0x6720080` | `0x6720240` | `0x40006720240` | yes, inside `[heap]` (rw) |
| Node 25.2.1, gdb | `mov %rbp, 0xb0(%r13)`, `r13=0x6720080` | `0x6720130` | `0x40006720130` | yes, inside `[heap]` (rw) |
| Node 25.2.1, gdb, CPU 19 with TME disabled | `mov %rbp, 0xb0(%r13)`, `r13=0x6720080` | `0x6720130` | `0x40006720130` | yes, inside `[heap]` (rw) |
| Node 25.2.1, strace | `mov %rbp, 0xb0(%r13)` (wasm entry) | `0x44905130` | `0x40044905130` | — |

`strace -e %memory` showed the faulting address was never mapped, unmapped,
or protected by the process at any point. The register state at each fault
is clean and self-consistent. No x86-64 mechanism (segment bases, LAM,
canonicalization) adds 2^42 to a plain register-relative access, and
page-table or TLB-shootdown bugs cannot change the linear address reported
in CR2. A software bug can only corrupt architectural state, which would be
visible in the register dump. The varying crash sites seen earlier (Liftoff
code emission, wasm entry, GC marking barrier) are explained by the anomaly
striking whatever memory access is in flight.

Bit 42 sits inside the PML4 index field of a 48-bit linear address, so the
corrupted fault address names a different top-level page-table slot than
the intended access. This is consistent with a glitch in the CPU's
address-generation/TLB path rather than RAM data corruption, which cannot
change CR2 (a linear address) at all.

### Cross-checks

- Deno 2.9.3 (V8 14.9.207.2) crashes under the same gdb harness with a
  flipped-high-bit fault address (`si_addr=0x167f20915dad` versus live
  pointer `rbx=0x127f20915c71`, approximately bit 34). The earlier "Deno
  clean" control was insufficient sampling.
- A second PC (i9-10885H, Comet Lake) passed 100/100 waves (1,600
  child-runs). On the affected machine a crash occurs roughly every 40-80
  child-runs; the clean run is conclusive to better than 1e-14.
- Reproduced on kernels 6.18 (CachyOS) and 7.1.5 (Arch).
- The affected machine's journal shows other applications (Chromium, and
  Electron/Signal V8 `int3` aborts) crashing with anomalous fault addresses
  over the same period.
- A generic non-V8 stress test (24 threads of dense computed-address
  stores, 10 minutes) did not reproduce. The anomaly appears to require the
  specific concurrent V8 WASM-compilation workload, not merely memory load.

### Forensic notes

Post-mortem siginfo from systemd-coredump cores is misleading for this
crash: the core records the fatal `SI_TKILL` re-raise, so `$_siginfo`
decodes to the sender's pid/uid rather than the original fault address.
Trustworthy fault addresses require a live gdb stop
(`handle SIGSEGV stop nopass`) or a signal-capturing strace.

### Conclusion

The affected machine (Core Ultra 9 285HX, stepping 2, microcode 0x122)
exhibits sporadic single-high-bit corruption of faulting linear addresses
under heavy concurrent load. In the initial TME-enabled configuration the
CPU reported 42-bit physical addressing, so the flipped bit appeared to be
exactly the MAXPHYADDR boundary. A controlled cold-boot test with TME disabled
restored 46-bit physical addressing, but CPU 19 still failed 9/20 runs and a
pristine gdb capture retained the exact `intended_address + 2^42` signature.
TME/MKTME is therefore not required for the failure, and the earlier
MAXPHYADDR correspondence was incidental. Disabling Intel System Agent
Geyserville (SaGV) also had no effect: CPU 19 still failed 9/20 runs.
Node+PGlite is an unusually effective trigger but not the cause. Observed
crashes are the subset where the corrupted address is unmapped; a corrupted
store address landing on a mapped page would silently corrupt memory. Next
steps are firmware updates and stock BIOS settings on the affected machine
and, if the behavior persists, an erratum report to Intel.

### Update (2026-07-31): isolated to three physical cores

`taskset` isolation on the affected machine localized the defect to
individual cores. CPUs 0-7 are P-cores; 8-23 are E-cores in four clusters
of four sharing one L2 (sysfs cluster ids: 16 = cpus 8-11, 24 = cpus 12-15,
64 = cpus 16-19, 72 = cpus 20-23).

| CPU set | Topology | Result |
| --- | --- | --- |
| 0-7 | P-cores | clean: 16 and 8 children x 50 waves (1,200 child-runs) |
| 8-11 | E-cluster 16 | SIGSEGV at wave 1 (4 children) |
| 12-15 | E-cluster 24 | clean: 2 x (4 children x 50 waves) = 400 child-runs |
| 16-19 | E-cluster 64 | SIGSEGV at wave 1 in both runs (3 + 3 of 8 child-runs) |
| 20-23 | E-cluster 72 | SIGSEGV at wave 1 in both runs (1 + 2 of 8 child-runs) |

Single-child pinning (one child per run, 50 waves per core) refined this to
exactly one defective core per affected cluster:

| CPU | Result |
| --- | --- |
| 8, 9, 10, 16, 17, 18, 20, 22, 23 | 50/50 waves clean, each |
| 11 | SIGSEGV at waves 7 and 14 |
| 19 | SIGSEGV at waves 2, 10, and 3 across three runs |
| 21 | SIGSEGV at wave 22 (single observation) |

The defective cores are 11, 19, and 21: one in each of three E-core
clusters, none in cluster 24, none on a P-core (the P-core runs above gave
every P-core full thread exposure across 1,200 clean child-runs). The
defect is per-core, not cluster-shared logic such as the common L2.

Running one child under the same gdb harness pinned to core 19
(`capture-fault.sh`; transcripts `captures/cpu19-run{1,5,6}.txt`) captured
three faults in six runs. Each is identical to the original capture above:
`addl $1, 0x1c0(%r13)` with `r13=0x6720080`, intended address `0x6720240`
(inside `[heap]`, rw), `si_addr=0x40006720240` = intended + 2^42, with clean
self-consistent registers. The faulting CPU is core 19 by construction:
taskset confined every thread of the process to it.

Consequences:

- Concurrency is not required, superseding "concurrency is the stable
  trigger" and "cross-process machine load as the likely timing perturber"
  above. A single process pinned to a defective core faults while its V8
  background threads sit idle. The earlier concurrency dependence, and the
  unpinned rate of one crash per 40-80 child-runs, were scheduler exposure
  to three defective cores among 24.
- "Good core" verdicts are provisional at low rates: 50 clean single-child
  runs exclude per-run crash rates only above roughly 5%, and core 21's
  observed rate (1 in 22) sits at that boundary. Cluster 24's 400 fully
  exposed child-runs remain conclusive even against a weak-core rate.
- The minimal trigger no longer needs the wave harness:
  `while taskset -c 19 node child.mjs; do :; done` faults within a few
  runs in a single ~1.2 GiB process. This is a cheap oracle for firmware
  A/B tests and, if it comes to it, an Intel erratum report.

A frequency A/B/A test on core 19 (single-child runs, back-to-back in one
session) shows the defect tracks the clock:

| Condition | scaling_max_freq | Effective clock under load | Result |
| --- | --- | --- | --- |
| Baseline | 4.7 GHz | ~4.7 GHz boost | 6/20 runs SIGSEGV |
| Capped | 800 MHz | ~1.3-2.8 GHz observed | 0/20 runs SIGSEGV |
| Restored | 4.7 GHz | ~4.7 GHz boost | 9/20 runs SIGSEGV |
| Turbo disabled (`intel_pstate/no_turbo=1`) | 2.1 GHz | non-turbo | 0/20 runs SIGSEGV |

Against the combined stock rate of 15/40, the binomial probability of the
capped 0/20 is ~8e-5. The independent no-turbo control also passed 20/20;
with turbo disabled, sysfs reported a 2.1 GHz ceiling for CPU 19. Two
caveats: the 800 MHz policy cap did not fully clamp (`scaling_cur_freq`
still sampled 1.3-2.8 GHz under load, an intel_pstate/HWP behavior that
prevents assigning an exact threshold from that test), and the stock
per-run rate itself drifts between batches (30% then 45%). The two clean
lower-frequency controls are nonetheless decisive: this is a
frequency/voltage margin, not hard logic. The defective cores fail at high
boost and pass when downclocked, consistent with marginal voltage at boost
- firmware/BIOS voltage configuration, platform power delivery, or
out-of-spec silicon. Disabling SaGV did not change the result (9/20), so
system-agent voltage/frequency scaling is not required. The highest-value
remaining control is a full stock-BIOS retest, ahead of any erratum report.

Power-source controls on core 19, all with turbo enabled, reproduced the
fault through either USB-C port and with the machine running on battery:

| Power condition | Result |
| --- | --- |
| USB-C port nearer the front | 1/20 runs SIGSEGV |
| USB-C port nearer the rear | 2/20 runs SIGSEGV |
| Battery only | 2/20 runs SIGSEGV |

The battery-only failures show that the dock, USB-C input path, external
adapter, household mains, and unstable external supply are not required for
the defect. The lower counts in these small batches are not evidence of an
improvement given the previously observed rate drift. The remaining hardware
candidates are internal platform power delivery and the CPU itself; both are
replaced together by a system-board replacement on this model.

## Temporary workarounds

These mitigate the observed trigger but are not substitutes for hardware
replacement: the failure can potentially become silent memory corruption when
the corrupted address happens to be mapped.

The most conservative frequency workaround tested so far is to disable turbo
globally. Core 19 passed 20/20 runs with the resulting 2.1 GHz ceiling:

```bash
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
```

Writing `0` restores turbo. This sysfs setting is not persistent across a
reboot.

A more targeted workaround is to prevent the scheduler from using the known
affected logical CPUs on this machine (11, 19, and 21):

```bash
for cpu in 11 19 21; do
  echo 0 | sudo tee "/sys/devices/system/cpu/cpu${cpu}/online"
done
```

Writing `1` to the same files brings them back online. These CPU numbers are
specific to this machine and should be revalidated after a firmware or
system-board change. Verdicts for the other cores also remain statistical,
rather than a guarantee of hardware correctness.

For an application-only workaround, affinity can keep the complete process,
including its threads, on the extensively tested P-cores:

```bash
taskset -c 0-7 node app.mjs
```

Finally, `scaling_max_freq` can cap only CPUs 11, 19, and 21 while preserving
turbo elsewhere. A 2.1 GHz ceiling is a conservative starting point suggested
by the successful no-turbo test, but this exact per-CPU configuration has not
yet been independently validated and the earlier intel_pstate/HWP cap did not
strictly match the observed effective clock. Confirm the actual frequency
under load and run a much longer validation before relying on it:

```bash
for cpu in 11 19 21; do
  echo 2100000 | sudo tee \
    "/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_max_freq"
done
```

Node/V8 flags are not workarounds: the repro survives `--no-wasm-tier-up`,
`--liftoff-only`, `--no-liftoff`, and the other flag combinations tested above.

## Native crash evidence

A reproduction was run under `env -i` with only `HOME`, `PATH`, `LANG`, and
`STOP_ON_FAILURE` retained before collecting a core.

A signal-only `strace` captured this sequence:

1. The Node main thread received `SIGSEGV` with `SEGV_MAPERR` at a large guarded
   WASM address.
2. Node's `node::TrapWebAssemblyOrContinue` handler called `raise(SIGSEGV)`
   after V8 declined to treat the address as a valid WASM trap.
3. The second `SI_TKILL` signal terminated the process and was retained in the
   core.

GDB placed another crash in V8's lazy WASM compilation path through
`LiftoffAssembler::PrepareCall`, `ExecuteLiftoffCompilation`, `CompileLazy`, and
`Runtime_WasmCompileLazy`, with background Turboshaft compilation active. A
separate retained crash was in `v8::internal::MarkingBarrier::MarkValueLocal`.

Raw cores are intentionally not included because process memory can contain
environment values and other sensitive data.

## Runtime controls

Every control used PGlite 0.5.4, 16 concurrent processes per wave, `SELECT 1`,
and explicit close:

| Runtime | Mode | Result |
| --- | --- | --- |
| Bun 1.3.11 / JavaScriptCore | Node-compatible `child_process.fork()` | 50/50 waves passed |
| Deno 2.8.0 / V8 14.9.207.2 | Native subprocess, default flags | 50/50 waves passed |
| Deno 2.8.0 / V8 14.9.207.2 | Native subprocess, `--no-liftoff` | 50/50 waves passed |

Run the Deno control with:

```sh
deno run -A deno-repro.ts 16 50
CHILD_V8_FLAGS=--no-liftoff deno run -A deno-repro.ts 16 50
```

Deno's Node-compatible `child_process.fork()` could not provide an exact IPC
control because its compatibility layer failed before spawning with
`fd is not from BiPipe`.

## PGlite debug-build control

The exact PGlite 0.5.4 tag (source commit
`25d0a55e1f1e4c59f26d9e125150dda88a33fd00`) was also built with the official
`pnpm build:all:debug` workflow. The PostgreSQL WASM build used `-g`,
`-gsource-map`, and `--no-wasm-opt`. Its 50,321,851-byte `pglite.wasm`
contained 1,322 DWARF compilation units and passed LLVM's DWARF verifier.

Using Node 25.2.1 and the same harness:

| Debug-build mode | Result |
| --- | --- |
| Sequential, one child | 5/5 waves passed |
| Eight concurrent children | 5/5 waves passed |
| Sixteen concurrent children | Wave 1 passed; child 9 received `SIGSEGV` in wave 2 |

After resetting the test scope's cgroup counter, the 16-child run peaked at
67,306,729,472 bytes (62.7 GiB). The cgroup recorded `oom=0` and `oom_kill=0`.
The debug build therefore preserves the concurrency-dependent crash despite
Emscripten's `--no-wasm-opt` build setting and the inclusion of source-level
debug information. V8's runtime compilation tiers were not disabled by that
setting. The debug build also requires much more memory than the release-build
reproduction.

## Node versus V8 attribution

> **Superseded (2026-07-30):** see "Root-cause investigation: platform-level
> address corruption" above. The evidence now points to a hardware/platform
> anomaly on the affected machine, with Node as the trigger rather than the
> cause. This section is retained for historical context.

The exact ownership is not yet proven.

The results establish a Node-runtime-specific interaction under the tested
configurations, but Node both embeds and configures V8 and supplies
`TrapWebAssemblyOrContinue`. Deno's V8 build is clean, while a newer V8 inside
the official Node canary still fails. Plausible locations therefore include:

- Node's WASM trap integration;
- Node-specific V8 build flags or platform configuration;
- a V8 defect exposed only by Node's embedding; or
- a concurrency/resource interaction specific to Node processes executing a
  large WASM module.

`d8` is V8's standalone JavaScript shell. A reproduction that loads and runs
the relevant WASM directly in `d8`, without Node or its APIs, would establish
that the same bug exists in V8 independently of Node. The recommended initial
report target is Node, with maintainers routing or cross-linking it to V8 if
appropriate.

## Related reports

No exact open duplicate was found as of 2026-07-14. Related but materially
different reports include:

- [nodejs/node#62393](https://github.com/nodejs/node/issues/62393): intermittent
  V8 GC crash on macOS/arm64 using workers and `vm`, without this WASM repro.
- [nodejs/node#63421](https://github.com/nodejs/node/issues/63421): deterministic
  V8 Turboshaft WASM Zone OOM, rather than `SIGSEGV`.
- [nodejs/node#41319](https://github.com/nodejs/node/issues/41319): large virtual
  address reservations for WebAssembly modules.
- [electric-sql/pglite#339](https://github.com/electric-sql/pglite/issues/339):
  JavaScript `RuntimeError: Out of bounds memory access` on Bun/PGlite 0.2.6.
- [electric-sql/pglite#802](https://github.com/electric-sql/pglite/issues/802):
  retained PGlite WASM memory in a larger application.
- [V8 issue 42203228](https://issues.chromium.org/issues/42203228): lazy and
  background compilation feedback-vector handling across instances/isolates.

Those reports have different platforms, failure modes, or sharing models; none
currently covers independent concurrent Node processes running this workload.
