# Review software controls

This page records runtime, compiler, build, kernel, and debugger controls. These controls change triggerability, but none explains the recurring exact-CPU fault-address signature.

## Preserve the native crash chain

One reproduction ran under `env -i` with only `HOME`, `PATH`, `LANG`, and `STOP_ON_FAILURE` retained before core collection.

A signal-only `strace` recorded this sequence:

1. Node's main thread received `SIGSEGV` with `SEGV_MAPERR` at a large guarded WebAssembly address.
2. `node::TrapWebAssemblyOrContinue` called `raise(SIGSEGV)` after V8 declined to treat the address as a valid WebAssembly trap.
3. The second `SI_TKILL` signal terminated the process and became the signal retained in the core.

One GNU Debugger (GDB) capture placed the crash in V8's lazy WebAssembly compilation path through `LiftoffAssembler::PrepareCall`, `ExecuteLiftoffCompilation`, `CompileLazy`, and `Runtime_WasmCompileLazy`, with background Turboshaft compilation active.

Another retained crash occurred in `v8::internal::MarkingBarrier::MarkValueLocal`.

The varied code sites are compatible with an anomaly affecting whichever memory access is in flight. They do not identify one V8 subsystem as causal.

## Compare JavaScript runtimes

The initial controls used PGlite 0.5.4, 16 processes per wave, `SELECT 1`, and explicit close.

| Runtime | Mode | Initial result |
| --- | --- | --- |
| Bun 1.3.11, JavaScriptCore | Node-compatible `child_process.fork()` | 50/50 clean waves |
| Deno 2.8.0, V8 `14.9.207.2` | Native subprocess, default flags | 50/50 clean waves |
| Deno 2.8.0, V8 `14.9.207.2` | Native subprocess, `--no-liftoff` | 50/50 clean waves |

Run the Deno control with:

```sh
deno run -A deno-repro.ts 16 50
CHILD_V8_FLAGS=--no-liftoff \
  deno run -A deno-repro.ts 16 50
```

Deno's Node-compatible `child_process.fork()` layer failed before spawning with `fd is not from BiPipe`, so it did not provide an exact IPC control.

The initial zero-failure Deno samples did not establish immunity. A later Deno 2.9.3 GDB attempt captured a related high-bit fault-address anomaly.

Runtime and build choices change exposure probability. They do not provide a clean Node-versus-V8 ownership boundary.

## Compare the PGlite debug build

The PGlite 0.5.4 source tag used commit `25d0a55e1f1e4c59f26d9e125150dda88a33fd00`. It was rebuilt with the project's `pnpm build:all:debug` workflow.

The PostgreSQL WebAssembly build used `-g`, `-gsource-map`, and `--no-wasm-opt`. Its 50,321,851-byte `pglite.wasm` contained 1,322 DWARF compilation units and passed LLVM's DWARF verifier.

With Node 25.2.1:

| Debug-build mode | Result |
| --- | --- |
| Sequential, one child | 5/5 clean waves |
| Eight concurrent children | 5/5 clean waves |
| Sixteen concurrent children | Wave 1 clean; child 9 received `SIGSEGV` in wave 2 |

The 16-child debug build reached 67,306,729,472 bytes, or 62.7 GiB, after the test cgroup counter was reset. The cgroup recorded `oom=0` and `oom_kill=0`.

The debug build preserved the crash despite Emscripten's `--no-wasm-opt` and source debug information. That option did not disable V8's runtime compilation tiers.

Later CPU-pinned tests showed that concurrency was not required. The debug build mainly demonstrated a high-memory variant of the same trigger.

## Compare Node and V8 flags

The original workload reproduced with:

- `--no-wasm-tier-up`
- `--liftoff-only`
- `--no-liftoff`
- `--no-concurrent-marking`
- `--single-threaded-gc`

`--no-wasm-lazy-compilation` avoided the observed `SIGSEGV` in one sweep but made the workload unusable. A single child exited 13 because top-level await remained unsettled inside `client.query`.

No tested V8 flag is a supported workaround.

## Compare kernels

The userspace fault reproduced on Linux 6.18, 7.1.5, `7.1.8-1-cachyos`, and `7.1.8-arch1-3` during different investigation stages.

The native `churn-mem` kernel oops appeared twice on the CachyOS build and did not appear in 60 loaded attempts on the Arch build. The reduced WebAssembly userspace trigger remained 10/10 on the Arch kernel.

Kernel build and configuration may change the kernel-mode manifestation. They do not eliminate the userspace trigger in the available sample.

## Correct the Node executable confounder

The 2026-08-11 diagnostic bundle recorded 5,032 confirmed `SIGSEGV` outcomes across 31,203 child-process attempts. Its three CPU 19 GDB captures retained the `intended + 2^42` signature across two instruction forms.

A later comparison first appeared to show a large Node-version effect:

- Interactive Node Version Manager (NVM) Node v25.2.1 faulted 7/20 times on CPU 19
- `PATH=/usr/bin:/bin ./single.sh 19 20` with Node v26.7.0 passed 20/20

The privileged frequency phase had made the same unintended executable switch. `sudo` and `runuser` resolved a bare `node` to `/usr/bin/node` v26.7.0 instead of the NVM v25.2.1 binary used by the main phases.

Its turbo-on legs contained one confirmed `SIGSEGV` among 799 endpoint-resolved attempts. The experiment therefore cannot answer whether disabling turbo suppresses the high-rate Node v25.2.1 trigger.

At documentation time, `/usr/bin/node` identified as Node v26.7.0, V8 `14.6.202.34-node.28`, modules 147, with SHA-256 `0beb7f253288ac762b8db4ededf5608ded416392da95d3bd67f24ae4db740256`. The NVM binary identified as Node v25.2.1, V8 `14.1.146.11-node.14`, modules 141. These are historical identities, not assumptions about the current paths.

This does not show that Node 26 or V8 14.6 fixed the anomaly:

- Official Node v26.5.1 with V8 `14.6.202.34` reproduced
- An official Node 27 canary with V8 15.2 reproduced
- The system Node v26.7.0 campaign contained one confirmed `SIGSEGV`

## Separate source version from binary production

The two compared binaries changed more than Node and V8 source:

| Property | NVM Node v25.2.1 | Arch `/usr/bin/node` v26.7.0 |
| --- | --- | --- |
| Size | 123,759,744 bytes | 54,306,160 bytes |
| Compiler evidence | Clang | GCC |
| Profile-guided optimization | Disabled | Enabled |
| Linkage | Official-style static bundle | Dynamic system libraries |
| Pointer compression | Disabled | Disabled |
| V8 sandbox and shared cage | Disabled | Disabled |

Compiler, Profile-Guided Optimization (PGO), linkage, dependency, packaging, and layout differences vary with source version. The comparison is runtime package A versus runtime package B, not a controlled source experiment.

## Review the source-history audit

The [Node/V8 source-history review](../../research/node-v8-25.2.1-to-26.7.0-review.md) screened 5,693 commits. The companion [audit table](../../research/node-v8-screened-commits.tsv) preserves every disposition.

The review found real x64 and WebAssembly correctness fixes, but none matched the captured combination:

- Small `0xa8`, `0xb0`, or `0x1c0` displacements
- Store or add instructions
- A correct live base register
- A reported fault address exactly `2^42` higher

Several changes could alter memory layout, code layout, spill placement, or timing. The strongest candidates were lazy WebAssembly `ArrayBuffer` allocation and default spill placement. They are plausible trigger perturbations, not direct matches for the address calculation.

The next controlled comparison is same-source binary production: interleave an official upstream Node v26.7.0 binary with Arch's `/usr/bin/node` v26.7.0 on CPU 19, recording exact hashes and build metadata. Compare official v25.2.1 within the same randomized session before attempting a source-history bisect.

## State the software-control conclusion

Software choices materially change triggerability. The recurring fault signature, exact-CPU localization, cross-version reproduction, and native kernel capture remain more consistent with a platform-dependent anomaly than a conventional corrected Node or V8 address-generation bug.

Negative controls narrow the mechanism only within their sample. They do not establish that a runtime, compiler, build, or kernel is immune.
