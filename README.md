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
