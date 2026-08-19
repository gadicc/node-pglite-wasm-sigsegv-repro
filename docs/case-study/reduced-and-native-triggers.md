# Understand the reduced and native triggers

This page records the minimal WebAssembly probes and native C controls created after exact-CPU localization. WebAssembly module churn is the practical reduced trigger. The native `churn-mem` mode is disruptive and can wedge the machine.

## Compare the reduced workload under matched load

The reduced probes used the same controlled-load recipe as the PGlite child:

- Target CPU 19
- One verified `/usr/bin/yes` worker on each P-core, CPUs 0-7
- Controller pinned outside the target and load sets

In matched sessions, the PGlite child produced 9/10 `SIGSEGV` on `7.1.8-1-cachyos` and 10/10 on `7.1.8-arch1-3`.

## Run the static WebAssembly probe

`mini-wasm.mjs` is a dependency-free Node script with a hand-encoded two-function WebAssembly module. `spin(n)` calls `bump()` repeatedly, and `bump()` increments `memory[0]`.

The instruction shape includes the same per-call Liftoff budget bump seen in PGlite captures. JavaScript verifies the counter after each round and exits `43` on a mismatch.

Its steady-state `strace -c` syscall profile is flat, so the main loop is userspace execution.

Recorded CPU 19 results under P-core load were:

| Static probe | Result |
| --- | --- |
| Five-second attempts | 1/10, 1/20, and 0/20 `SIGSEGV` across three sessions |
| `--liftoff-only`, five-second attempts | 0/20 |
| GDB with 15-second attempts | 0/40 |

This probe preserved an instruction shape but reproduced at a lower rate than PGlite.

## Run the WebAssembly churn probe

`mini-wasm-churn.mjs` compiles and instantiates a fresh module every round. A custom section contains the round number to prevent V8's module cache from reusing the bytes.

The process continually exercises compile, instantiate, execute, and destroy behavior.

Recorded CPU 19 results were:

| Kernel | Attempt window | Result |
| --- | ---: | ---: |
| `7.1.8-1-cachyos` | 8 seconds | 15/15 `SIGSEGV` |
| `7.1.8-arch1-3` | 8 seconds | 10/10 `SIGSEGV` |

Fresh WebAssembly module churn is therefore the practical reduced trigger. It replaces PGlite with a dependency-free script while retaining the high measured failure rate.

The script currently runs until it faults or receives an external termination request. The diagnostic suite does not yet provide bounded built-in supervision for it. Use an external deadline carefully and preserve termination as a control outcome, not a workload signal.

## Interpret the rate ladder

The observed rate changes track module lifecycle work:

- The PGlite child spends much of its short life compiling and initializing WebAssembly
- Static `mini-wasm.mjs` has one brief startup burst followed by steady execution
- `mini-wasm-churn.mjs` repeats the lifecycle continuously
- Static native replicas avoid V8's module and code-page lifecycle

This evidence identifies module churn as important for triggerability. It does not identify which V8 codegen, allocator, code-page, guard-page, or background-thread action provides the necessary condition.

## Build the native harness

Compile the self-contained C harness with:

```sh
cc -O2 -Wall -Wextra -pthread -o repro-c repro-c.c
```

Run one A/B/A mode with:

```sh
./repro-c-aba.sh 19 20 0-7 churn
```

The positional arguments are target CPU, attempts per leg, load CPUs, and native mode.

## Understand native outcome detection

The harness uses two detection paths:

- A `SA_SIGINFO` handler prints `si_addr`, instruction pointer, instruction bytes, and general-purpose registers from `ucontext`, then exits `42`
- Batch counter verification detects a corruption that lands on mapped memory, then exits `43`

Keep handled exit `42`, detected-corruption exit `43`, direct signals, and supervision failures distinct when interpreting output.

## Compare native execution modes

The native harness contains four modes:

- **`rmw`**: long-lived base pointers execute read-modify-write, load, store, and indirect-call shapes; an optional 1 GiB shuffled-page span adds TLB-missing operations
- **`clone`**: position-independent code recreates the Liftoff instruction shapes in a fresh executable mapping with instance, budget, and 4 GiB guard-paged memory regions
- **`churn`**: each round creates writable code, patches a fresh round number, flips the mapping to executable, creates instance and budget mappings, executes, verifies, and retires mappings to a reaper thread
- **`churn-mem`**: each round also creates a fresh 4 GiB reservation and tears down mappings inline, producing four `mmap`, two `mprotect`, and four `munmap` calls per round

`clone` uses a byte-faithful instruction shape but does not reproduce V8's complete code production and maintenance behavior.

## Review the native userspace results

| Mode | Kernel | A1 | B under load | A2 |
| --- | --- | ---: | ---: | ---: |
| `rmw` | `7.1.8-1-cachyos` | 0/10 | 0/10 | 0/10 |
| `rmw` with 1 GiB span | `7.1.8-1-cachyos` | 0/10 | 0/10 | 0/10 |
| `clone` | `7.1.8-1-cachyos` | 0/20 | 0/20 | 0/20 |
| `churn-mem` | `7.1.8-1-cachyos` | 0/20 | 0/20 userspace faults; two kernel oopses in about 75 loaded runs | 0/20 |
| `churn-mem` | `7.1.8-arch1-3` | Not run | 0/60, no oops | Not run |
| `churn` | `7.1.8-arch1-3` | 0/40 | 0/40 | 0/40 |

Billions of vulnerable-shape operations in pure-execution modes stayed clean. The instruction stream alone was insufficient in these sessions.

## Review the kernel-mode manifestation

> [!WARNING]
> On `7.1.8-1-cachyos`, `churn-mem` produced two kernel oopses on CPU 19. The second left the process in unkillable D-state until reboot. Run this mode only when a hang and forced reboot are acceptable.

The repository retains the full excerpts in [kernel-oops-cpu19-20260818.txt](../../captures/kernel-oops-cpu19-20260818.txt).

Both oopses occurred on CPU 19 in process `repro-c` at `entry_SYSCALL_64_after_hwframe+0x11`. That instruction was `push %r14`, which saves a register on the kernel stack.

Incoming registers identified syscall 10, `mprotect(code, 256 KiB, PROT_READ|PROT_EXEC)`. This was the churn loop's writable-to-executable transition.

The first oops preserved the address relationship:

```text
RSP: ffffd20d8b2d3f68
intended push address: ffffd20d8b2d3f60
CR2: ffffd60d8b2d3f60
```

CR2 equals the intended address with bit 42 set. The fault was a supervisor write to a non-present page.

The second oops occurred at the same instruction and syscall shape. It left the process stuck in `exit_mmap` through `__mmput` and `do_exit`. The oops interrupted syscall entry with interrupts disabled during teardown, so `SIGKILL` could not recover it.

The runner observed one unexplained nonzero exit and one hung A/B/A leg. Userspace signal and counter detectors cannot classify an anomaly that faults in the kernel.

## Compare the stock Arch kernel batch

On `7.1.8-arch1-3`, the same `churn-mem` shape completed 60 loaded attempts without a userspace fault or kernel oops.

If the earlier oops probability were 2.5% per independent attempt, a clean 60-attempt sample would occur about 20% of the time. The result is suggestive, not proof that the stock Arch build prevents the kernel manifestation.

The userspace WebAssembly fault rate remained high on both kernels. The PGlite child and `mini-wasm-churn.mjs` each produced 10/10 faults on the Arch kernel in the matched session.

## State the reduced-trigger conclusion

Pure native instruction replicas did not reproduce the userspace fault. Mapping-heavy native churn exposed the same address anomaly in kernel mode, but at substantial operational risk.

The residual difference may lie in how V8 produces and maintains code: Liftoff code generation, zone allocation, executable mappings, memory reservations, or background code collection. The current evidence does not isolate one action.

Use `mini-wasm-churn.mjs` as the reduced research trigger. Retain PGlite as the application-derived reference, and treat native churn modes as advanced disruptive experiments.
