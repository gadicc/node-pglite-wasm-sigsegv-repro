# Trace the original PGlite reproduction

This page records how the failure first reproduced across Node versions and runtime controls. Later exact-CPU evidence changed the interpretation from a concurrency-dependent software crash to a CPU-sensitive platform anomaly.

## Define the original workload

Each child creates an in-memory PGlite 0.5.4 client, runs `SELECT 1`, awaits `client.close()`, and exits. The harness contains no Vitest, Vite, application code, native add-on, or persistent database.

The original command ran 16 concurrent children for up to 50 waves:

```sh
npm ci
npm run repro
```

Expected behavior was exit code `0` from every child. Actual failures terminated a child from `SIGSEGV`:

```text
node=v26.5.0 v8=14.6.202.34-node.24 \
platform=linux arch=x64 children=16 waves=50
wave=1 passed=16/16
wave=8 passed=15/16
child=10 code=null signal=SIGSEGV elapsedMs=4315
failedWaves=1 completedWaves=8 requestedWaves=50
```

One Node 25.2.1 session failed four of 20 waves, with five children receiving `SIGSEGV`. The cgroup counters recorded `oom=0` and `oom_kill=0`.

## Compare official Node images

Official `node:major-bookworm` images produced these results on the same host:

| Node | Default Node flags, without V8 command-line overrides |
| --- | --- |
| 26 | Two runs failed at waves 13 and 8; the final locked Docker build failed at wave 8 |
| 25 | 1/20 waves failed |
| 24 | 4/45 waves failed; the final locked Docker build failed at wave 15 |
| 22 | 1/10 waves failed |
| 20 | 0/40 waves failed |

The Node 20 result is a non-reproduction in 40 intermittent waves. It does not establish immunity. Node 20 later reproduced when `--no-liftoff` forced the optimizing compiler, so the failure is not established as a post-20 regression.

The exposed defaults in the tested official Node 20, 22, 24, and 26 images enabled Liftoff, lazy compilation, dynamic tiering, and WebAssembly tier-up, with up to 128 compilation tasks.

## Compare the Node 27 V8 canary

The newest available official canary at the time was Node `v27.0.0-v8-canary202607066c1f8ebea4` with V8 `15.2.20-node.7`. Its published SHA-256 checksum was verified before testing.

| Canary mode | Result |
| --- | --- |
| Default `child_process.fork()`, 16 children | `SIGSEGV` at wave 17 |
| `--no-wasm-tier-up`, 16 children | `SIGSEGV` at wave 12 |
| `--liftoff-only`, 16 children | `SIGSEGV` at wave 12 |
| `child_process.spawn()`, 16 children | 48/50 clean waves; `SIGSEGV` at waves 3 and 14 |
| Sequential `child_process.fork()`, one child | 50/50 clean waves |

These results show that Inter-Process Communication (IPC) and optimized WebAssembly compilation are not universally required. The clean sequential sample initially suggested a concurrency requirement. Later exact-CPU tests showed that concurrency mainly increased scheduler exposure to susceptible CPUs.

## Repeat the post-report flag sweep

After the upstream reports were filed, the affected host reproduced more aggressively with Node v25.2.1 and V8 `14.1.146.11-node.14`. Each row used 16 children for up to 100 waves and stopped at the first failed wave.

| Configuration | Result |
| --- | --- |
| Node v25.2.1, default | `SIGSEGV` at wave 5 |
| `--no-wasm-tier-up` | `SIGSEGV` at wave 4 |
| `--no-wasm-lazy-compilation` | No `SIGSEGV`, but unusable: one child exited 13 with unsettled top-level await in `client.query` |
| `--liftoff-only` | `SIGSEGV` at wave 3, two children |
| `--no-concurrent-marking` | `SIGSEGV` at wave 1 |
| `--single-threaded-gc` | `SIGSEGV` at wave 2, two children |
| Node v25.9.0, V8 `14.1.146.11-node.25` | `SIGSEGV` at wave 1 |
| Node v26.5.1, V8 `14.6.202.34-node.24` | `SIGSEGV` at wave 1 |

The earlier 100-wave pass with `--no-wasm-tier-up` did not repeat. One zero-failure run was not a mitigation result.

The crash survives `--liftoff-only`, `--no-wasm-tier-up`, `--no-concurrent-marking`, and `--single-threaded-gc`. Background optimizing compilation and concurrent garbage-collection threads are not required.

## Interpret the origin stage

The original matrix established a portable application-derived trigger across several Node and V8 versions on the affected host. It did not identify the failing CPU or root cause.

Later stages established:

- A single pinned process can reproduce without concurrent sibling processes
- PGlite is not required once the WebAssembly churn pattern is retained
- Node and build choices change exposure probability but do not remove the recurring captured signature

Continue with [the fault signature and CPU localization](fault-signature-and-cpu-localization.md).
