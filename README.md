# CPU-localized PGlite/WebAssembly SIGSEGV reproduction for Node.js

Framework-free reproduction and diagnostic tooling for intermittent native
Node.js crashes while initializing PGlite's PostgreSQL WebAssembly module on
one affected machine. The crash was discovered under concurrent load, then
reduced to a single process pinned to one of several susceptible logical CPUs.

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
seeded per-CPU isolation, exact-CPU pinned-concurrent topology contexts,
read-only workload telemetry, GDB fault-signature capture, and a statistically
honest Markdown report. It is meant to take a machine "from zero" to a reviewable
evidence bundle with one command, and every conclusion in the generated
report is derived from that run's own measurements — nothing is assumed
from prior results. Known identifiers are minimized, but raw debugger and
third-party tool output must still be reviewed before sharing.

> [!CAUTION]
> The workload is memory-intensive (~1.2 GiB per child process; the default
> baseline needs ~20 GiB), intentionally triggers SIGSEGV crashes, and a
> full run can take one to several hours. System core dumps are disabled
> for the test processes; GDB captures are collected separately.

### Dependencies

Required: `bash`, `node` (with `npm ci` done here), `taskset`, `awk`, and
standard coreutils. Optional (recorded in the report when missing, never
fatal): `gdb` (phase 7), `turbostat` (preferred load-frequency sampling),
`lscpu`, `journalctl`/`systemctl`, `intel-undervolt`, and Dell `cctk`.
The runner never requires root and never elevates privileges itself.

Preflight collects distribution/kernel/Node/V8 versions, CPU model,
stepping, microcode, address sizes, topology (P/E cores, clusters, shared
L2, cpufreq policies), cpufreq state, `intel_pstate/no_turbo`, power
source, and relevant kernel warnings (MCE/EDAC/thermal/TME/microcode) from
unprivileged sources. Preflight intentionally excludes service tags, serial
numbers, UUIDs, MAC addresses, and BIOS passwords. Kernel-command-line
collection uses an explicit CPU/frequency allowlist (rather than trying to
denylist every possible identifier), and journal excerpts use message-only
output without timestamp/hostname prefixes. GDB mappings and optional tool
output can still contain local paths or unexpected identifiers, so inspect
`privacy-review.txt` and the flagged raw files before publishing a bundle.

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
  Run it through `sudo` from a non-root account. Privileged reads are collected
  in a private staging directory, then an unprivileged helper publishes the
  four allowlisted payloads plus strict digest metadata into the user-owned
  bundle. A zero-byte completion marker is published last; incomplete, mixed,
  oversized, or changed generations are excluded by the collector.
  The staging directory is deterministic (derived from the invoking user and
  the bundle), so an interrupted attempt is found on the next run: a fully
  handed-off orphan is republished as-is after revalidation (discard it with
  `--fresh` to re-collect instead), root's own half-staged leftovers are
  cleared and restaged, and anything unrecognized is refused for manual
  inspection rather than silently deleted.
- `frequency-ab.sh` is the only script that changes anything; see below.

Both companion publishers validate their complete staging and destination
sets before changing the bundle. A successful publication invalidates
`manifest.txt` first, then removes the stale privacy review, results JSON, and
report before replacing evidence. Run `diagnose.sh --resume` afterward to
regenerate those derived outputs for the new evidence generation.
Validated privileged reads remain an out-of-band supplemental point snapshot;
they are displayed for context but never used for causal conclusions.

### Frequency A/B/A (`frequency-ab.sh`)

The turbo A/B/A experiment temporarily changes a runtime setting, so it is
deliberately a separate manual step run as root. It saves the original
`intel_pstate/no_turbo` value first, then runs single-child tests on the
CPU you give it (use the highest-failure CPU from phase 4) as **A**
(original state) → **B** (turbo disabled) → **A** (original state
restored). Every setting is restored on normal exit, failure, SIGINT, or
SIGTERM, and the restore is verified and recorded in the bundle. Invoke the
script through `sudo` from a non-root account: workload legs run as that user,
while root writes evidence only to a private staging directory. After settings
are restored, a helper running as the invoking user publishes complete or
partial evidence into the bundle, including after a handled interruption.
Before replacing any frequency evidence, publication removes the previous
frequency completion marker; `diagnose.sh --resume` revalidates the new files
before recreating it.
Tracked child exits other than clean (`0`) or SIGSEGV (`139`) are retained as
descriptive non-target outcomes. They do not invalidate the completed
schedule, but they are excluded from the clean/SIGSEGV endpoint denominator
and disable the inferential A/B/A comparison. Exit `125` remains reserved for
an operational supervision failure and leaves the experiment incomplete.
The root-owned per-user state also tracks a deterministic staging location, so
the next invocation publishes or explicitly quarantines evidence left by
SIGKILL instead of silently orphaning an undiscoverable root-only directory.
Requested *and* measured frequencies (turbostat preferred,
`scaling_cur_freq` fallback) are reported per leg; never trust
`scaling_max_freq` alone on intel_pstate/HWP. A separate, clearly labelled
per-CPU cap experiment is available via `--cap KHZ`. BIOS settings are never
changed. SIGKILL recovery uses a mode-0700, root-owned per-invoking-UID directory under
`/run/node-pglite-wasm-sigsegv-repro/`; the restore ledger is never stored in
the user-owned diagnostics bundle. A live per-UID lock refuses overlapping
experiments, while a dead owner's lock is reclaimed so its validated ledger
can be recovered before new work begins.

The ordinary baseline/group sampler also fails closed: it must produce a
valid frequency row and remain live through the workload. An empty or dead
sampler aborts before evidence is published instead of becoming an apparent
`avg —, max —` measurement. Older bundles with empty samples are reported as
frequency unavailable.

The workload executable must also be treated as part of the experiment. In
particular, `sudo` plus `runuser` does not initialize an interactive NVM shell;
a bare `node` may therefore resolve to `/usr/bin/node` instead of the binary
used by `diagnose.sh`. Before interpreting a frequency comparison, verify the
privileged launch path itself, for example:

```sh
sudo runuser -u "$(id -un)" -- /bin/sh -c \
  'command -v node; node -p \
  "process.execPath + \" \" + process.version + \" V8 \" + process.versions.v8"'
```

Record that result with the bundle. Evidence collected with a different Node
binary remains useful for that binary's trigger rate, but it is not a
frequency control for the runtime measured by the other phases.

### Quick and full examples

```sh
npm ci
./diagnose.sh --quick --yes      # short: 10 group waves, 5 isolated rounds
                                 # per CPU, 5 pinned-concurrent rounds
./diagnose.sh --yes              # default: 16x50 baseline, 50 group waves,
                                 # 200 isolated + 200 pinned-concurrent rounds
./diagnose.sh --full --yes       # hours: 16x100 baseline, 100 group waves,
                                 # 400 isolated + 400 pinned-concurrent rounds
./diagnose.sh --dry-run          # print the resolved plan and exit
```

`--yes` accepts the safety warning (required when not interactive).
Useful overrides: `--individual-runs N`, `--pinned-concurrent-rounds N`,
`--protocol-seed auto|N`, `--telemetry-interval-ms N`, `--group-waves N`,
`--gdb-max-runs N` (bounded by the evidence envelope at 4096), `--skip-gdb`,
`--run-gdb`, `--skip-pinned-concurrent`, `--run-pinned-concurrent`,
`--out-dir DIR`, and `--cpu N|auto`. The CPU selection policy is persisted in the bundle:
`auto` (the default) uses the worst failing CPU from validated individual
results, while a number pins the manual frequency hint and GDB capture to that
CPU. Use `--cpu auto` on resume to clear a previously fixed choice; completed
frequency or GDB evidence must still match the resolved CPU or be redone.
In `results.json`, `config.cpuTarget` is the fixed CPU number or `null` for
automatic selection, and `config.cpuTargetPolicy` makes that distinction
explicit.
On resume, the stored GDB choice remains the default. Use `--run-gdb` to
reverse an earlier `--skip-gdb`; if that skipped phase is already complete,
also pass `--redo gdb` so its old terminal evidence is preserved first.

### Exact-CPU protocols and exploratory follow-ups

The main group phase answers whether a *shared CPU affinity mask* reproduces
the problem. It does not identify a CPU: the controller and its children can
migrate anywhere inside that mask. The schema-2 individual phase uses one
direct, pinned child at a time on every usable logical CPU. Its immutable
seeded plan interleaves CPUs in a position-balanced order, avoiding CPU-major
batches while retaining exact CPU attribution.

Individual evidence version 6 deliberately distinguishes four outcomes:
`pass`, the prespecified `sigsegv` primary endpoint,
`other-workload-failure` for a securely launched and affinity-verified child
that exits nonzero or receives another signal, and `operational-invalid` for
launch, affinity, cancellation, boundary, or protocol failures. A valid other
workload failure commits the current immutable-plan observation and advances
resume; an operational-invalid attempt commits nothing and retries the same
observation. V6 retains exact exit code or signal, elapsed time, CPU,
round/position, both `no_turbo` boundaries, and a bounded stderr excerpt plus
its full-stream byte count and SHA-256 digest. Other workload failures are
reported as descriptive exact-CPU evidence, never relabelled as passes or
SIGSEGVs, and are excluded from the clean/SIGSEGV denominator. Telemetry joins
keep all three committed outcomes in separate context/CPU/outcome strata.

The separate pinned-concurrent phase launches one child per active logical CPU
in each validated topology
context, with the controller pinned outside the active set. This preserves
simultaneous load while retaining exact child-to-CPU attribution. Contexts
remain separate strata because sibling load and active-set size differ.
Pinned-concurrent evidence version 2 uses the same four-way outcome model as
individual V6: securely launched non-SIGSEGV failures commit as descriptive
outcomes, while operational failures leave the whole wave uncommitted and
retryable. A resumed V1 checkpoint remains usable as a disclosed contiguous
legacy prefix: its stored 0/139 classifications are preserved without
inventing exact signal or stderr provenance, and all later V2 rows retain the
exact exit/signal and bounded stderr evidence. Waves containing another
workload failure are excluded from the primary SIGSEGV-positive wave
denominator.

`targeted-cpu-test.mjs` remains available for exploratory follow-ups outside
the authoritative diagnostic bundle. It leaves all frequency settings
untouched.

First preserve the concurrent cluster load but pin one child to each CPU:

```sh
node targeted-cpu-test.mjs --mode one-to-one --cpus 8-11 --rounds 50 --dry-run
node targeted-cpu-test.mjs --mode one-to-one --cpus 16-19 --rounds 50 --dry-run
node targeted-cpu-test.mjs --mode one-to-one --cpus 20-23 --rounds 50 --dry-run
```

Then compare the previously observed candidates 11, 19, and 21 with matched
clean controls using a balanced randomized order and exactly the same child
launcher:

```sh
node targeted-cpu-test.mjs --mode interleaved \
  --cpus 10,11,18,19,20,21 --rounds 50 --seed 20260808 --dry-run
```

Review each plan, replace `--dry-run` with `--yes` to execute it, and use
`--out-dir DIR` when a specific destination is wanted. The controller is
automatically pinned to an allowed CPU outside the target set. Each output
directory records the `intel_pstate/no_turbo` value at both ends, a JSONL row
for every child, and a short report with the measured per-CPU percentages.
The script never changes turbo or any other system setting.

GDB confirmation on a candidate remains a separate live workload. Do not
overwrite a completed diagnostic bundle's CPU 19 capture merely to add CPU 11
or 21; use separate capture directories, or make a new diagnostic bundle.
The controlled frequency A/B/A script deliberately refuses to start when
`intel_pstate/no_turbo` is already `1`: restore turbo manually only when ready
to test, then let `frequency-ab.sh` perform and verify its own A/B/A
restoration.

### Output layout and resumability

Everything lands in a timestamped bundle, `diagnostics/<UTC timestamp>/`
(override with `--out-dir`):

- `report.md` — the human report (see below)
- `results.json` — machine-readable results
- `commands.log`, `run.log` — shell-quoted command/progress logs, with known
  bundle, repository, and home-directory prefixes replaced
- `env/` — sanitized system-information files (`env/root/` if
  `root-checks.sh` was run)
- `logs/` — raw stdout/stderr per phase
- `freq/` — frequency samples per phase
- `telemetry/` — read-only, timestamped per-CPU `scaling_cur_freq`, dynamically
  mapped core/package temperatures, and `intel_pstate/no_turbo` samples. Each
  published telemetry envelope is digest-bound to the exact owning workload
  generation; the groups binding covers its metadata, TSV, and every canonical
  TSV-named outcome log, while exact-CPU phases also bind their per-child
  boundary sidecar.
- `results/individual.plan.tsv`, `results/individual.boundaries.ndjson` — the
  immutable isolated schedule and exact committed outcome, status, bounded
  stderr evidence, time, and `no_turbo` boundaries
- `results/pinned-concurrent.*` — topology contexts, immutable launch plan,
  whole-wave outcomes, and exact per-child boundaries
- `gdb/` — capture transcripts, bound by the authoritative generation-stamped
  `results/gdb.manifest` envelope (exact runner log, metadata, and transcript
  digests); `results/gdb.meta` is the legacy descriptive summary only
- `privacy-review.txt` — category/file-only sentinel scan for paths, UUIDs,
  and MAC-shaped values; a flag means review the raw file, not that it is unsafe
- `manifest.txt` — file names and SHA-256 checksums

`manifest.txt` is the bundle's sole readiness token. Treat `results.json`,
`report.md`, and `privacy-review.txt` as one authoritative generation only when
the manifest is present and `sha256sum -c manifest.txt` succeeds from inside
the bundle. Every real run or resume revokes that token before changing logs,
metadata, phase evidence, or derived outputs. An interruption can therefore
leave useful old/new files behind an absent manifest, but those files are not a
completed generation; rerunning `diagnose.sh --resume ... --yes` cleans any
validated finalization candidates and regenerates the complete set.

For a Dell support handoff, first run `sha256sum -c manifest.txt` from inside
the completed bundle, then review `privacy-review.txt` and every raw file it
flags. Archive and send the entire bundle directory, not `report.md` alone, so
the report, machine-readable results, raw evidence, telemetry, and validation
manifests remain reviewable together. Service tags and serial numbers are
deliberately excluded; provide the service tag separately through the secure
Dell support case or another Dell-approved secure channel rather than adding
it to the bundle.

Phases mark completion under `state/`; an interrupted run (SIGINT/SIGTERM
writes a partial report first) can be resumed without discarding finished
work — including partially completed per-CPU tables, which are topped up
by running only the missing runs. A run that died during fresh bundle
initialization (before any phase produced evidence) is likewise resumable:
`--resume` proves the directory holds only initialization-era artifacts,
discards them, and starts fresh instead of refusing a non-empty directory:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

The preflight snapshot has a fixed artifact inventory, per-file SHA-256
manifest, generation identifier, strict summary schema, and zero-byte
completion marker. Completed preflight evidence is revalidated before a
resume can use it; partial or changed files are preserved and require
`--redo preflight` rather than being overwritten.

Before a completed baseline is skipped, its fixed metadata/log envelope is
validated against the stored child/wave configuration and completion marker.
Missing, malformed, mismatched, or unsafe file types are preserved and require
`--redo baseline`; they are never silently overwritten or used for conclusions.

Group and individual evidence are bound by exact generations, not just by a
reproducible plan: `results/groups.meta` carries a fresh random generation per
attempt, and `results/individual.meta` records the exact groups generation
that authorized its CPU targets. Redoing groups mints a new generation even
when the rediscovered topology plan is identical, so stale individual evidence
fails closed and requires `--redo individual`. Legacy envelopes without these
generation bindings stay descriptive and cannot authorize conclusions.

V1–V5 individual envelopes remain readable with their original meanings.
Because accepting securely launched non-SIGSEGV workload failures changes
liveness and statistics, V6 is a new protocol rather than a reinterpretation
of V5. A schema-2 bundle containing an incomplete V5 individual attempt must
be restarted explicitly with `--redo individual`; the V5 plan/state and its
individual telemetry sessions are archived together under
`state/superseded/`, while completed baseline and group evidence remains
current.

To instead *repeat* a phase from scratch in one contiguous session (for
example the per-CPU tests, so all runs share one turbo/load regime), use
`--redo`. The previous data is moved to `state/superseded/`, never
deleted:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z \
  --redo individual --individual-runs 50 --yes
```

Redoing preflight invalidates and repeats the complete downstream phase
closure (`baseline`, `groups`, `individual`, `pinned-concurrent`, `frequency`,
and `gdb`). Its
archive includes the fixed environment snapshot and `env/root/`, so manual
privileged reads from an older preflight generation cannot survive as current
evidence.

GDB capture attempts are not combined across resumes. Before phase 7 runs or
writes any terminal skip result, a prior incomplete attempt (metadata, capture
transcripts, runner log, and any published or hidden manifest) and its stale
derived reports are preserved together under one `state/superseded/`
transaction. Empty setup directories are ignored, and an interrupted archive
is recovered before phase execution on the next resume. A completed phase is
accepted on resume only after the full generation-bound manifest envelope
revalidates; bundles from before the manifest existed (marker plus legacy
`gdb.meta` alone) are preserved and require `--redo gdb`.

### Interpreting the report

Per-CPU rates and baseline/group **wave** rates are reported with Wilson 95%
confidence intervals. A group result such as `50/50` means 50 of 50 waves had
at least one confirmed SIGSEGV; it does **not** mean every child failed. The
separate child column gives the measured child failure count and percentage,
without a child-level interval because children within a wave are correlated.
A group row names an affinity mask, not the faulting CPU. Exact-CPU localization
is still descriptive: the seeded, position-balanced isolated schedule reduces
systematic order bias but does not remove time, temperature, warm-up, or
workload-drift confounding, and pinned-concurrent children within one wave are
correlated. For V6 individual evidence, Wilson intervals and zero-failure
bounds use only primary-eligible `pass + sigsegv` observations; committed
observations and `other-workload-failure` counts are shown separately. A CPU
with only other workload failures therefore has no primary denominator and no
interval. A zero there means
only that this run did not reproduce under that protocol; it does not erase a
failure captured in an older diagnostic session. For the prespecified frequency A/B/A reversal,
each turbo-on leg is compared separately with the turbo-off leg using a
one-sided Fisher exact test on confirmed SIGSEGV counts over endpoint-resolved
runs. A
replicated reduction is claimed only when both comparisons are in the
prespecified direction and both have p < 0.05 (reported conservatively as the
larger p-value); the legs are not pooled, and an invalid run disables that
inference. A tracked non-target outcome is not an invalid run, but also
disables inference because it does not resolve the primary endpoint.
Concurrent children in a
wave share timing, load, and machine state, so they are correlated rather than
independent trials: child failure totals are descriptive, while a wave is
positive if it contains at least one confirmed SIGSEGV, negative only when all
children passed, and otherwise unresolved. Wave-rate intervals use only
resolved sequential waves and assume those waves are independent and
stationary. Excluding unresolved waves can bias the resulting interval, so
their count is displayed explicitly. Rates are not directly comparable when
the number of concurrent children differs, because that changes the chance
that at least one child fails. Wave failures are kept distinct from individual
child-process failures. Baseline and group logs are also reconciled against
their stored child/wave configuration and exit status;
malformed, duplicated, missing, or contradictory structure is retained only as
descriptive evidence and cannot support a clean conclusion or rate bound. The
conclusions section states only what this run supports: whether the problem
reproduced,
whether it localized to particular CPUs or topology groups, whether lower
frequency suppressed it, whether the GDB fault matches the documented
`intended + 2^42` signature, which hypotheses the collected configuration
rules out, and what remains uncertain.

**Zero-failure statistics are one-sided.** No failures observed in `n` runs
never proves a zero rate; the report shows the exact pointwise 95% upper bound
`1 - 0.05^(1/n)` (approximately `3/n`). Under the working assumption that
attempts are independent and stationary, 50 runs with no failures observed
have a nominal upper bound of ~5.8%. Temporal or thermal dependence can make
that bound too narrow, so it is not proof of correct hardware. For GDB capture,
`n` includes only attempts that actually
ran the workload cleanly: debugger/runner errors are reported separately and
never inflate the no-fault denominator. Every captured or no-fault conclusion
requires the validated generation-bound manifest envelope; legacy bundles
without one keep their evidence descriptive only — it is displayed but
authorizes no conclusion and no numerical bound.

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

The newest available official Node V8 canary was also tested after verifying
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
universally required. The clean sequential sample initially made concurrency
look necessary; later exact-CPU tests showed that it was instead increasing
scheduler exposure to susceptible CPUs. A single pinned process reproduces
with no other workload.

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
  optimizing compilation and concurrent GC threads are not required.
- Later exact-CPU isolation showed that cross-process load is not required;
  concurrency primarily increased scheduler exposure to the affected logical
  CPUs in these tests.

## Platform-level fault-address investigation (2026-07-30 onward)

A native investigation on the affected machine found evidence that is hard to
reconcile with an ordinary Node, V8, or PGlite address-generation
bug. Repeated captures point instead to sporadic single-bit corruption in the
fault-address path while this workload executes. That is strong evidence for
a platform-dependent execution anomaly, but it is not by itself formal proof
of a defective CPU or proof that every software and kernel interaction has
been excluded.

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

`strace -e %memory` showed that the reported fault address was never mapped,
unmapped, or protected by the process. The register state at each fault is
clean and self-consistent. No ordinary x86-64 address calculation represented
by the captured instruction (including segment bases, LAM, or canonicalization)
adds 2^42 to this plain register-relative access, and page-table or TLB
translation occurs after the linear address reported in CR2 is formed. A
conventional wrong-register or wrong-displacement compiler bug should be
visible in the architectural register state or instruction bytes; neither is.
The varying crash sites seen earlier are consistent with the anomaly striking
whichever memory access is in flight. Less conventional kernel, signal,
debugger, firmware, or CPU interactions remain part of the residual
uncertainty.

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
  child-runs. Under an illustrative independent-child model at the
  conservative 1/80 rate, the probability of 0/1,600 is about 1.82e-9.
  Children within a wave share timing and machine state, so independence can
  be optimistic; this is strong model-based contrast, not a conclusive bound.
- Reproduced on kernels 6.18 (CachyOS) and 7.1.5 (Arch).
- The affected machine's journal shows other applications (Chromium, and
  Electron/Signal V8 `int3` aborts) crashing with anomalous fault addresses
  over the same period.
- A generic non-V8 stress test (24 threads of dense computed-address
  stores, 10 minutes) did not reproduce. The PGlite/V8 workload is therefore
  an unusually effective trigger; generic memory load alone was insufficient
  in this sample.

### Forensic notes

Post-mortem siginfo from systemd-coredump cores is misleading for this
crash: the core records the fatal `SI_TKILL` re-raise, so `$_siginfo`
decodes to the sender's pid/uid rather than the original fault address.
Trustworthy fault addresses require a live gdb stop
(`handle SIGSEGV stop nopass`) or a signal-capturing strace.

### Conclusion

The affected machine (Core Ultra 9 285HX, stepping 2, microcode 0x122)
repeatedly reports sporadic single-high-bit corruption of faulting linear
addresses while this workload executes. In the initial TME-enabled
configuration the CPU reported 42-bit physical addressing, so the flipped bit
appeared to be exactly the MAXPHYADDR boundary. A controlled cold-boot test
with TME disabled restored 46-bit physical addressing, but CPU 19 still failed
9/20 runs and a pristine gdb capture retained the exact
`intended_address + 2^42` signature.
TME/MKTME is therefore not required for the observed failure, and the earlier
MAXPHYADDR correspondence was incidental. Disabling Intel System Agent
Geyserville (SaGV) also had no effect: CPU 19 still failed 9/20 runs.
Node+PGlite is an unusually effective trigger, while the captured architectural
state argues strongly against a conventional Node/V8 address-calculation bug.
Observed crashes are necessarily the subset where the reported address is
unmapped; if the same kind of address corruption can land on a mapped page, it
could in principle cause silent memory corruption. Next steps are firmware
updates and stock BIOS settings on the affected machine and, if the behavior
persists, a platform service case or erratum report to Intel.

### Initial exact-CPU localization (2026-07-31)

`taskset` isolation on the affected machine localized the observed failures
to individual CPUs in this session. CPUs 0-7 are P-cores; 8-23 are E-cores in
four clusters of four sharing one L2 (sysfs cluster ids: 16 = cpus 8-11,
24 = cpus 12-15, 64 = cpus 16-19, 72 = cpus 20-23).

| CPU set | Topology | Result |
| --- | --- | --- |
| 0-7 | P-cores | clean: 16 and 8 children x 50 waves (1,200 child-runs) |
| 8-11 | E-cluster 16 | SIGSEGV at wave 1 (4 children) |
| 12-15 | E-cluster 24 | clean: 2 x (4 children x 50 waves) = 400 child-runs |
| 16-19 | E-cluster 64 | SIGSEGV at wave 1 in both runs (3 + 3 of 8 child-runs) |
| 20-23 | E-cluster 72 | SIGSEGV at wave 1 in both runs (1 + 2 of 8 child-runs) |

Single-child pinning (one child per run, 50 waves per core) observed failures
on one CPU in each of the three affected clusters:

| CPU | Result |
| --- | --- |
| 8, 9, 10, 16, 17, 18, 20, 22, 23 | 50/50 waves clean, each |
| 11 | SIGSEGV at waves 7 and 14 |
| 19 | SIGSEGV at waves 2, 10, and 3 across three runs |
| 21 | SIGSEGV at wave 22 (single observation) |

Failures were observed on CPUs 11, 19, and 21: one in each of three E-core
clusters. No failure was observed in cluster 24 or on a P-core in these
samples (the P-core runs above gave every P-core thread exposure across 1,200
zero-failure child-runs). This localizes the observed failures to particular
pinned CPUs and is more consistent with per-core susceptibility than a
cluster-wide common failure, but finite zero-failure samples cannot exclude
intermittent failures elsewhere or a shared mechanism.

Running one child under the same gdb harness pinned to core 19
(`capture-fault.sh`; transcripts `captures/cpu19-run{1,5,6}.txt`) captured
three faults in six runs. Each is identical to the original capture above:
`addl $1, 0x1c0(%r13)` with `r13=0x6720080`, intended address `0x6720240`
(inside `[heap]`, rw), `si_addr=0x40006720240` = intended + 2^42, with clean
self-consistent registers. The faulting CPU is core 19 by construction:
taskset confined every thread of the process to it.

Consequences:

- Concurrency is not required. A single process pinned to an observed failing
  CPU faults with no other workload. The earlier apparent concurrency
  dependence, and the unpinned rate of one crash per 40-80 child-runs, are
  explained by greater scheduler exposure to the three CPUs that failed in
  these tests among 24.
- "Good core" verdicts are provisional at low rates: 50 clean single-child
  runs exclude per-run crash rates only above roughly 5%, and core 21's
  observed rate (1 in 22) sits at that boundary. Cluster 24's 400 fully
  exposed zero-failure child-runs provide a stronger screen than the 50-run
  samples, but they still do not prove a zero failure rate.
- The minimal trigger no longer needs the wave harness:
  `while taskset -c 19 node child.mjs; do :; done` faults within a few
  runs in a single ~1.2 GiB process. This is a cheap oracle for firmware
  A/B tests and, if it comes to it, an Intel erratum report.

An earlier Node v25.2.1 frequency A/B/A test on core 19 (single-child runs,
back-to-back in one session) showed an association with the tested clock
conditions:

| Condition | scaling_max_freq | Effective clock under load | Result |
| --- | --- | --- | --- |
| Baseline | 4.7 GHz | ~4.7 GHz boost | 6/20 runs SIGSEGV |
| Capped | 800 MHz | ~1.3-2.8 GHz observed | 0/20 runs SIGSEGV |
| Restored | 4.7 GHz | ~4.7 GHz boost | 9/20 runs SIGSEGV |
| Turbo disabled (`intel_pstate/no_turbo=1`) | 2.1 GHz | non-turbo | 0/20 runs SIGSEGV |

For the prespecified A/cap/A reversal, the one-sided Fisher exact contrasts
are 6/20 vs 0/20 (p = 0.0101) and 9/20 vs 0/20 (p = 0.000614), so the
replicated gate reports the larger p-value, 0.0101. The independent no-turbo
control also passed 20/20; with turbo disabled, sysfs reported a 2.1 GHz
ceiling for CPU 19. Two caveats: the 800 MHz policy cap did not fully clamp
(`scaling_cur_freq` still sampled 1.3-2.8 GHz under load, an intel_pstate/HWP
behavior that prevents assigning an exact threshold from that test), and the
stock per-run rate itself drifts between batches (30% then 45%). The repeated
zero observed lower-frequency legs are associated with fewer failures in this
session, but the sequential, non-randomized design does not establish a
frequency or voltage-margin mechanism as causal and cannot exclude time/order
effects. The pattern is consistent with marginal voltage at boost—whether
from firmware/BIOS voltage configuration, platform power delivery, or
out-of-spec silicon—but does not distinguish among those explanations.
Disabling SaGV did not change the result (9/20), so system-agent
voltage/frequency scaling is not required for the observed failure. The
highest-value remaining control is a full stock-BIOS retest, ahead of any
erratum report.

Power-source controls on core 19, all with turbo enabled, reproduced the
fault through either USB-C port and with the machine running on battery:

| Power condition | Result |
| --- | --- |
| USB-C port nearer the front | 1/20 runs SIGSEGV |
| USB-C port nearer the rear | 2/20 runs SIGSEGV |
| Battery only | 2/20 runs SIGSEGV |

The battery-only failures show that the dock, USB-C input path, external
adapter, household mains, and unstable external supply are not required for
the observed fault. The lower counts in these small batches are not evidence
of an improvement given the previously observed rate drift. The leading
platform candidates are internal power delivery and the CPU itself; both are
replaced together by a system-board replacement on this model.

### Full diagnostic follow-up (2026-08-11)

A later full diagnostic run used seeded, position-balanced isolated trials and
exact-CPU pinned-concurrent topology contexts. The isolated phase observed
SIGSEGVs on CPUs 11 (24/400), 19 (146/398), 21 (71/398), and 23 (1/400), with
0/8,000 on the other 20 CPUs in that phase. Under pinned-concurrent contexts,
exact child attribution expanded the observed set to CPUs 9, 11, 17, 19, 21,
22, and 23. Contexts are separate strata because sibling load differs, so
their rates should not be pooled with the isolated rates.

Three further live GDB captures on CPU 19 reproduced the same mapped intended
address versus `intended + 2^42` signature across `addl $1,0x1c0(%r13)` and
`mov %r10,0xa8(%r13)`. The expanded CPU set does not establish that every
listed CPU has an intrinsic defect or that every zero-failure CPU is sound; it
records where this workload produced exact-CPU failures under the tested
contexts.

## Temporary workarounds

These mitigate the observed trigger but do not resolve the underlying anomaly.
Because an incorrectly formed address could in principle land on a mapped
page, clean application runs are not a hardware-integrity guarantee. If the
fault survives current firmware and a full stock-BIOS retest, platform service
or system-board replacement remains the conservative response.

The most conservative frequency workaround tested so far is to disable turbo
globally. Core 19 passed 20/20 runs with the resulting 2.1 GHz ceiling:

```bash
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo
```

Writing `0` restores turbo. This sysfs setting is not persistent across a
reboot.

A more targeted workaround is to prevent the scheduler from using every
logical CPU with an exact-CPU SIGSEGV in the completed protocols on this
machine (9, 11, 17, 19, 21, 22, and 23):

```bash
for cpu in 9 11 17 19 21 22 23; do
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

Finally, `scaling_max_freq` can cap the seven observed CPUs while preserving
turbo elsewhere. A 2.1 GHz ceiling is a conservative starting point suggested
only by the CPU 19 no-turbo test; this per-CPU configuration has not been
independently validated, especially on the other six CPUs, and the earlier
intel_pstate/HWP cap did not strictly match the observed effective clock.
Confirm the actual frequency under load and run a much longer validation
before relying on it:

```bash
for cpu in 9 11 17 19 21 22 23; do
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
| Deno 2.8.0 / V8 14.9.207.2 | Native subprocess, default flags | 50/50 waves passed in this sample |
| Deno 2.8.0 / V8 14.9.207.2 | Native subprocess, `--no-liftoff` | 50/50 waves passed in this sample |

Run the Deno control with:

```sh
deno run -A deno-repro.ts 16 50
CHILD_V8_FLAGS=--no-liftoff deno run -A deno-repro.ts 16 50
```

Deno's Node-compatible `child_process.fork()` could not provide an exact IPC
control because its compatibility layer failed before spawning with
`fd is not from BiPipe`.

These Deno 2.8.0 zero-failure samples did not establish that Deno or its V8
build was immune. A later Deno 2.9.3 run under GDB captured a related
high-bit fault-address anomaly on the same machine. Runtime and build choices
therefore change triggerability, but they do not provide a clean Node-versus-V8
ownership boundary.

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
The debug build therefore preserves the crash under concurrent scheduling
despite Emscripten's `--no-wasm-opt` build setting and the inclusion of
source-level debug information. Later CPU-pinned tests established that
concurrency itself is not required. V8's runtime compilation tiers were not
disabled by the Emscripten setting. The debug build also requires much more
memory than the release-build reproduction.

## Node/V8 source and binary-provenance review (2026-08-17)

The completed 2026-08-11 diagnostic bundle recorded 5,032 confirmed SIGSEGVs
across 31,203 child-process runs. Its three live GDB captures on CPU 19 all
reproduce the mapped intended address versus `intended + 2^42` signature
across two ordinary memory-instruction forms. Diagnostic bundles are ignored
by Git because they can contain machine-specific raw evidence; the durable
findings are summarized here and in the source-history review below.

A subsequent comparison initially appeared to show a major Node-version
effect: interactive NVM Node v25.2.1 reproduced 7/20 times on CPU 19, while
`PATH=/usr/bin:/bin ./single.sh 19 20` with Node v26.7.0 passed 20/20. The
frequency A/B/A phase had unknowingly made the same runtime switch. Because it
was launched through `sudo` and `runuser` with a bare `node`, it resolved to
`/usr/bin/node` v26.7.0 rather than the NVM Node v25.2.1 used by the main
diagnostic phases. Its turbo-on legs contained one SIGSEGV among 799
endpoint-resolved runs, but the experiment cannot answer whether disabling
turbo suppresses the known high-rate Node v25.2.1 trigger.

This is also not evidence that Node v26 or V8 14.6 fixed the underlying fault:

- Official Node v26.5.1 with V8 14.6.202.34 had already reproduced.
- An official Node 27 V8 canary with V8 15.2 reproduced.
- The system Node v26.7.0 campaign itself contained one confirmed SIGSEGV.

The two headline binaries confound source version with their production
recipes. The NVM v25.2.1 binary is a large Clang-built, statically bundled,
non-PGO official-style binary. Arch's `/usr/bin/node` v26.7.0 is a much smaller
GCC-built, PGO-enabled, dynamically linked system binary. Those compiler,
profile-guided optimization, linkage, dependency, and layout differences come
primarily from how the official and Arch packages are built and published;
they are not a single identifiable Node or V8 source change. Node/V8 source
also changed between versions, so both dimensions currently vary together.

The complete
[Node/V8 source-history review](research/node-v8-25.2.1-to-26.7.0-review.md)
screened 5,693 commits, with every disposition retained in the companion
[audit TSV](research/node-v8-screened-commits.tsv). It found real x64/Wasm
correctness fixes, but none matches the captured small-displacement store/add
instructions, correct live base register, and exact `+2^42` fault address.
Several changes could alter code layout, memory layout, spill placement, or
timing and thereby change exposure probability. The defensible interpretation
is therefore that runtime source and build choices materially affect
**triggerability**, while the recurring fault signature and CPU localization
continue to point toward a platform-dependent execution anomaly.

The next high-value comparison is same-source before source-history bisection:
interleave the official upstream Node v26.7.0 binary with Arch's
`/usr/bin/node` v26.7.0 on CPU 19, while recording hashes and build metadata.
That isolates packaging/build layout from the nominal Node/V8 version. Compare
official v25.2.1 in the same randomized session, then test the major V8-roll
boundaries only if the controlled binaries justify a source bisect.

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
currently matches the exact CPU localization and recurring high-bit
fault-address signature captured here.
