# Node v25.2.1 to v26.7.0: V8/Wasm SIGSEGV change review

Date: 2026-08-17
Scope: read-only source-history and local-evidence review. No crash workload was run, no dependency was installed, and no diagnostic code was changed.

## Executive conclusion

**No Node or V8 change in the reviewed range convincingly explains the captured fault as a corrected software address-generation bug.** The later `/usr/bin/node` v26.7.0 observation is best described as a large reduction in exposure probability, not proof of a fix.

The strongest reasons are:

1. Three validated Node v25.2.1 captures show ordinary x86-64 base-plus-displacement instructions, an unchanged and correct `r13`, a mapped intended address, and an unmapped `si_addr` exactly `2^42` higher. For example, `r13=0x6720080` plus `0x1c0` is `0x6720240`, but the kernel reported `0x40006720240`. With the recorded instruction bytes and architectural register state, V8's emitted instruction has no operand that can add bit 42.
2. The best direct V8 effective-address fix, [`89ab7b1e`](https://chromium.googlesource.com/v8/v8/+/89ab7b1efb333b85f5669b10659b8b4abf14bb9b), fixes signed 32-bit displacement overflow for an optimized `Load64 >> 32` fold near `0x7ffffffc`. It does not match the small `0xa8`/`0x1c0` displacements, the observed store/add forms, or the unchanged base register.
3. Official Node v26.5.1, which already uses V8 `14.6.202.34`, also crashed in the repository's subsequent sweep; so did Node v25.9.0 and a Node 27 V8 canary. The v26.7.0 campaign itself had one endpoint-resolved failure. These observations directly rule out “V8 14.6.202.34 universally fixed it.” See [the post-report flag sweep](../docs/case-study/origin-and-reproduction.md#repeat-the-post-report-flag-sweep).
4. The two headline binaries are not controlled builds. The v25.2.1 NVM binary is a 123,759,744-byte, Clang-built, statically bundled official-style binary without PGO. `/usr/bin/node` is a 54,306,160-byte Arch-style, GCC-built, PGO-enabled, dynamically linked system binary. Compiler, PGO, layout, linkage, packaging, and potentially downstream patches change together with Node/V8.
5. Several changes can plausibly perturb code layout, memory layout, spill placement, tiering timing, or signal/trap exposure. The strongest are V8's lazy Wasm `ArrayBuffer` allocation and its new default spill placement. They are credible **trigger perturbations**, not matches for the observed `+2^42` computation.

The exact recurring bit and CPU localization are positive evidence for a CPU/platform-dependent execution path. They are not, by themselves, proof of a hardware defect: debugger timing, signal attribution, corrupted code outside the captured bytes, and unusual kernel/runtime interactions remain possible. The source history mainly says that a conventional V8 wrong-register/wrong-displacement fix is not supported by the evidence found.

## Evidence and inference boundaries

Direct observations used here:

- Node v25.2.1 / V8 `14.1.146.11-node.14`, PGlite 0.5.4.
- CPU 19 isolated single-process rate `146/398 = 36.7%`; pinned-concurrent contexts approached 100%.
- Three validated GDB captures from the 2026-08-11 diagnostic bundle, matching the [documented fault-address signature](../docs/case-study/fault-signature-and-cpu-localization.md#identify-the-recurring-fault-address-signature), all with a mapped/writable intended address and `si_addr = intended + 2^42`.
- Different instruction forms reproduced the same bit: `addl $1,0x1c0(%r13)` and `mov %r10,0xa8(%r13)`.
- The current v26.7.0 observation was 20/20 immediate clean and nearly clean in the larger A/B/A campaign, but not failure-free over all trials.
- PGlite 0.5.4 and the query stayed constant within the comparison.

Inferences:

- Source changes may change the probability of reaching the condition without being its root cause.
- CPU localization and the stable `+2^42` signature make a platform-dependent path more likely than ordinary random memory corruption.
- No negative issue search or commit review proves absence. It reduces the plausibility of known, conventional Node/V8 bugs matching this signature.

## Exact provenance

### Node endpoints

| Endpoint | Annotated tag object | Peeled commit | Commit date | Embedded upstream V8 | Runtime suffix |
|---|---|---|---|---|---|
| [`v25.2.1`](https://github.com/nodejs/node/releases/tag/v25.2.1) | `0945b8d354607543c67f22b2cbf3c1b2c99eac10` | [`4cac2b94`](https://github.com/nodejs/node/commit/4cac2b94bed4bf02810be054e8f63c0048c66564) | 2025-11-16 | `14.1.146.11` | `-node.14` |
| [`v26.7.0`](https://github.com/nodejs/node/releases/tag/v26.7.0) | `18c668e401ad21a01927684279a87006792f1205` | [`b4f23d36`](https://github.com/nodejs/node/commit/b4f23d3619c98bed09af93a21192f6080197a8c6) | 2026-08-05 | `14.6.202.34` | `-node.28` |

The `-node.N` value is Node's embedder patch suffix, not an upstream V8 revision.

The Node release graph is not linear between these tags. Their merge base is `59b70e5fe397db2457e10469985cb47fd7af0687` (2025-10-13). The symmetric difference contains 2,412 commits on the v26.7.0 side and 206 on the v25.2.1 side. Both sides were screened; using only `v25.2.1..v26.7.0` would silently omit the 206 old-branch commits.

### Upstream V8 endpoints

| Version | Official V8 commit | Date |
|---|---|---|
| `14.1.146.11` | [`ad8af0fc`](https://chromium.googlesource.com/v8/v8/+/ad8af0fc661d278e87627fcaa3a7cf795ee80dd8) | 2025-09-22 |
| `14.6.202.34` | [`f9116f3b`](https://chromium.googlesource.com/v8/v8/+/f9116f3bf9a50b0f7925daacfdc6fed503a9dbe2) | 2026-04-23 |

These V8 tags are also not related by a simple first-parent line. Their merge base is `cd6944c05d268ef7d734cf33af86bc94c6172c2f`; the symmetric difference contains 3,052 commits on the newer side and 23 on the older side. All 3,075 were included in the screen.

### Binary provenance confounder

| Property | NVM v25.2.1 | `/usr/bin/node` v26.7.0 |
|---|---|---|
| Size | 123,759,744 bytes | 54,306,160 bytes |
| Compiler/config evidence | Clang; PGO-use false | GCC; PGO-use true |
| Dependency model | statically bundled official-style | dynamically linked Arch system libraries |
| Pointer compression | disabled | disabled |
| V8 sandbox/shared cage | disabled | disabled |
| GNU x86 property note | no IBT requirement found | baseline through v4 capability notes; no IBT requirement found |

The version strings map to the official source tags, but `/usr/bin/node` has not been shown byte-for-byte equivalent to the official Node release binary. Until identical build recipes are tested, the comparison is “runtime package A versus runtime package B,” not a clean source-version experiment.

## V8 roll and release timeline

Node 25 did **not** receive the V8 14.2 or 14.3 rolls. Those are Node 26 development ancestry and were superseded before the first Node 26 release.

| Date | Node roll | V8 commit/version | First official Node release | Notes |
|---|---|---|---|---|
| 2025-09-25 | [`7772a2df`](https://github.com/nodejs/node/commit/7772a2df9d0b4db9947dbb902b4aec33c35401c0) | [`ad8af0fc`](https://chromium.googlesource.com/v8/v8/+/ad8af0fc661d278e87627fcaa3a7cf795ee80dd8), 14.1.146.11 | v25 line | v25.2.1 ships this plus Node patches. |
| 2025-10-23 | [`c2843b72`](https://github.com/nodejs/node/commit/c2843b722ca161692c6848e19d375f35b7a08c60), [#60111](https://github.com/nodejs/node/pull/60111) | [`02c660ae`](https://chromium.googlesource.com/v8/v8/+/02c660ae896a5d69bc999a65692d1e675d6efe3c), 14.2.231.9 | none exact | First released only ancestrally in v26.0.0. |
| 2025-10-28 | [`e0ca9935`](https://github.com/nodejs/node/commit/e0ca993514df0f48e4a714d70fb79f713e0530d5) | `bb294624`, 14.2.231.14 | none exact | Patch roll. |
| 2025-11-04 | [`76d6be5f`](https://github.com/nodejs/node/commit/76d6be5fc5aedbf612bf73b5ce15ed29972d0043) | `2ae7c979`, 14.2.231.16 | none exact | Patch roll. |
| 2025-11-11 | [`baefd4d5`](https://github.com/nodejs/node/commit/baefd4d5e274bdccd2070b61ba12effad224612b) | `4427aa4a`, 14.2.231.17 | none exact | Patch roll. |
| 2025-11-13 | [`53379f37`](https://github.com/nodejs/node/commit/53379f370695378b1be07b452c4cf3a43edd4fcd), [#60488](https://github.com/nodejs/node/pull/60488) | [`5a1e4e05`](https://chromium.googlesource.com/v8/v8/+/5a1e4e05abda4c55073df6d06c07f5a56d04d1b2), 14.3.127.12 | none exact | First released only ancestrally in v26.0.0. |
| 2025-11-18 | [`8716146d`](https://github.com/nodejs/node/commit/8716146d5b21652eb529cde4c500be1a863389f2) | `bab80cef`, 14.3.127.14 | none exact | Patch roll. |
| 2025-11-25 | [`bfc729cf`](https://github.com/nodejs/node/commit/bfc729cf197f732483ac6ad264fc9e289f47aa1e) | `beee9f5c`, 14.3.127.16 | none exact | Patch roll. |
| 2025-12-21 | [`9d27d9a3`](https://github.com/nodejs/node/commit/9d27d9a39337bb26a4d05e852e7574065e0da03c) | `326f5f8c`, 14.3.127.17 | none exact | Patch roll. |
| 2026-01-20 | [`87d7db19`](https://github.com/nodejs/node/commit/87d7db19185462e485e721a6f6897dab3e1891fb) | `333f0ea5`, 14.3.127.18 | none exact | Last 14.3 patch roll. |
| 2026-04-27 | [`cc547428`](https://github.com/nodejs/node/commit/cc547428e15e9dbabceb76978d9b030f46e6db5e), [#61898](https://github.com/nodejs/node/pull/61898) | [`f09a9128`](https://chromium.googlesource.com/v8/v8/+/f09a91282a26caa91d016c962d785d852cfdec36), 14.6.202.33 | **v26.0.0** | v26.x cherry-pick of main `f1e0b83e`. |
| 2026-05-05 | [`3dee18f7`](https://github.com/nodejs/node/commit/3dee18f72f38b1a89809b1a519031bc9e3fd15b6), [#62964](https://github.com/nodejs/node/pull/62964) | [`f9116f3b`](https://chromium.googlesource.com/v8/v8/+/f9116f3bf9a50b0f7925daacfdc6fed503a9dbe2), 14.6.202.34 | **v26.1.0** | v26.7.0 remains on this upstream V8 tag. |

## Screening method and audit trail

The companion [TSV](./node-v8-screened-commits.tsv) contains one row for every commit in the two symmetric source ranges:

- Node: 2,412 newer-side plus 206 older-side commits.
- V8: 3,052 newer-side plus 23 older-side commits.
- Total: **5,693 commits**, plus the header row.

Each row records repository, full hash, author date, subject, subsystem, disposition, and relevance reason. The first pass retained subject matches for Wasm, Liftoff, TurboFan/Turboshaft, compiler/backend, register allocation, memory/buffer/backing store, trap/signal, pointer compression/sandbox, x64/CET/APX, and CPU/platform vocabulary. A changed-path pass retained V8 compiler, codegen, Wasm, heap, sandbox, base/platform, and Node V8/embedder paths even where the subject was generic. Node V8 rolls and carry patches were separately provenance-reviewed. Detailed diffs were then inspected for the most plausible generated-code, memory-layout, trap, and register-allocation candidates.

Disposition totals:

| Disposition | Count |
|---|---:|
| detailed diff review | 24 |
| Node roll/carry provenance review | 58 |
| retained by changed path | 854 |
| retained by subject | 1,073 |
| screened out | 3,684 |

“Retained” is deliberately broad; it is not a claim of causal relevance. The full TSV prevents the negative screen from becoming an unverifiable assertion.

## Ranked explanations and candidates

The confidence column means confidence that the item explains the *observed reduction*, not confidence that the underlying patch is correct.

| Rank | Candidate | First Node release | Classification | Confidence | Assessment |
|---:|---|---|---|---|---|
| 1 | Binary build/PGO/linkage/layout difference | n/a | trigger/provenance confounder | **strong as a confounder** | Directly present and large; can change layout, scheduling, and exposure. It is not a source fix. |
| 2 | V8 [`8f1931ca`](https://chromium.googlesource.com/v8/v8/+/8f1931ca118f481836cf622bca45f123cbc89d21), lazy Wasm ArrayBuffers | v26.0.0 | trigger/layout perturbation | **plausible trigger; weak direct cause** | Broad Wasm memory object/backing-store lifetime and mapping change; all tiers. No generated EA change. |
| 3 | V8 [`51d20674`](https://chromium.googlesource.com/v8/v8/+/51d20674162731ffe3a191cf6a2369b1655cadaf), default spill placement | v26.0.0 | trigger/code-layout perturbation | **plausible trigger; weak direct cause** | Changes optimized-tier spill stores, register lifetimes, and code layout. Liftoff unaffected. |
| 4 | V8 [`89ab7b1e`](https://chromium.googlesource.com/v8/v8/+/89ab7b1efb333b85f5669b10659b8b4abf14bb9b), x64 folded-load displacement overflow | 14.2 dev roll / v26.0.0 ancestry | direct correctness fix, poor signature match | **weak** | A real x64 Wasm-capable EA fix, but wrong operation, displacement regime, and tier coverage. |
| 5 | V8 [`28045378`](https://chromium.googlesource.com/v8/v8/+/28045378aeda4b56e573e85175831f58b997d3b0) and [`58ab28f3`](https://chromium.googlesource.com/v8/v8/+/58ab28f3e051fbe4ac14f4aed84538e6af32ebbd), SIMD256 revectorizer indices | v26.0.0 | direct optimized-Wasm EA fixes | **ruled out as a direct match** | Experimental x64 SIMD256/AVX2 revectorization only; Liftoff and scalar captures do not match. |
| 6 | Node [`59f43189`](https://github.com/nodejs/node/commit/59f4318976ee64429587c1cf3adcc6de54f5c29d), x64 CET Wasm jump slot overflow | v26.6.0 | direct correctness fix, wrong site | **ruled out as a direct match** | Jump-table slot emission, not a function-body linear-memory access; observed binary has no IBT requirement note. |
| 7 | Node [`79262ff8`](https://github.com/nodejs/node/commit/79262ff8609d7019b1df2800093552bc0104dcc4) trap-handler low-address-space behavior plus reservation API [`44f64f1d`](https://github.com/nodejs/node/commit/44f64f1dd9b2e7c99431b40bc927959700a9d418) | v26.0.0 | trap-mode perturbation | **weak** | Can select explicit bounds checks under low `RLIMIT_AS`; no evidence that this condition differs in the observed runs. |
| 8 | V8 code-range, allocation, `memory.grow`, and scheduler changes detailed below | v26.0.0 | exposure perturbation | **weak** | Could move JIT code/data or timing; none accounts for the exact architectural operands. |

### 1. Lazy Wasm `ArrayBuffer` allocation

- Commit/date: [`8f1931ca118f481836cf622bca45f123cbc89d21`](https://chromium.googlesource.com/v8/v8/+/8f1931ca118f481836cf622bca45f123cbc89d21), 2026-01-08 (landed 2026-01-14).
- Title/issues: `[wasm] Lazily allocate ArrayBuffers for Wasm memories`; [434565978](https://issues.chromium.org/issues/434565978), [475195978](https://issues.chromium.org/issues/475195978).
- Principal files/functions: `src/objects/backing-store.{h,cc}`; `src/wasm/wasm-objects-{inl.h,h,cc,tq}` including `WasmMemoryObject::New`, `GetArrayBuffer`, `Grow`, `RefreshBuffer`, `UpdateInstances`; `src/wasm/module-instantiate.cc`; `src/runtime/runtime-wasm.cc`; `src/api/api.cc`.
- Behavior: `WasmMemoryObject` directly owns `Managed<BackingStore>`; the JS `ArrayBuffer` becomes lazy. Grow, atomics, C API, imports, instance updates, and mapping paths use the backing store directly. Exposed buffers are detached/cleared/recreated as required.
- Mechanism: memory object allocation count, object addresses, backing-store lifetime, memory accounting, and grow timing can change. This could alter whether a platform-sensitive condition is reached.
- Why it is not a direct match: no compiler/backend file changes and no modification to x64 linear-memory effective-address selection.
- Classification/confidence: **plausible trigger; weak direct cause**.

### 2. Spill placer default for non-loop-top phis

- Commit/date: [`51d20674162731ffe3a191cf6a2369b1655cadaf`](https://chromium.googlesource.com/v8/v8/+/51d20674162731ffe3a191cf6a2369b1655cadaf), 2026-01-22.
- Title/issue: `[regalloc] Enable spill placer for non loop-top phis`; [475502210](https://issues.chromium.org/issues/475502210).
- Files/functions: `src/compiler/backend/spill-placer.cc`, `SpillPlacer::Add`; `src/flags/flag-definitions.h`.
- Behavior: normal optimized compilation now sends more live ranges through late spill placement. Spill stores can move from every iteration to successor blocks; register lifetimes and code size/layout change.
- Scope: shared TurboFan backend, including optimized x64 Wasm. It does not affect Liftoff.
- Mechanism: plausible trigger perturbation through a different register/spill/code-layout schedule.
- Why it is not a direct match: it does not change Wasm linear-memory base/index/displacement calculation, and the repro survives configurations that remove optimized-tier necessity.
- Classification/confidence: **plausible trigger; weak direct cause**.

### 3. x64 `Load >> 32` displacement overflow

- Commit/date: [`89ab7b1efb333b85f5669b10659b8b4abf14bb9b`](https://chromium.googlesource.com/v8/v8/+/89ab7b1efb333b85f5669b10659b8b4abf14bb9b), 2025-09-15.
- Title/issue: `[compiler] Avoid overflow in Load>>32 ISEL optimization`; [444049512](https://issues.chromium.org/issues/444049512).
- File/functions: `src/compiler/backend/x64/instruction-selector-x64.cc`, `TryEmitLoadForLoadWord64AndShiftRight`, reached from `VisitWord64Shr`, `VisitWord64Sar`, and `VisitTruncateInt64ToInt32`; regression `test/mjsunit/regress/wasm/regress-444049512.js`.
- Behavior: before folding `Load64 >> 32` into a 32-bit load at displacement `+4`, V8 now uses `SignedAddOverflow32` and rechecks immediate encodability. The regression uses offset `0x7ffffffc`.
- Scope: x64 optimizing instruction selection, including optimized Wasm; not Liftoff.
- Mechanism: this is the best direct source-level EA correction in the range.
- Mismatch: captured operations are a store and an add, with displacements `0xa8`/`0x1c0`; bit 42 appears in the reported fault address while `r13` remains correct. The bug would instead expose a visibly wrapped 32-bit displacement in a particular folded load.
- Classification/confidence: **direct correctness fix; weak explanatory confidence**.

### 4. SIMD256 revectorizer address corrections

- [`28045378aeda4b56e573e85175831f58b997d3b0`](https://chromium.googlesource.com/v8/v8/+/28045378aeda4b56e573e85175831f58b997d3b0), 2025-12-17, `[wasm][revec] Fix invalid constant memory indices`, [467628265](https://issues.chromium.org/issues/467628265) / [42202660](https://issues.chromium.org/issues/42202660). `StoreLoadInfo` now keeps constant indices separate and refuses unsafe packing.
- [`58ab28f3e051fbe4ac14f4aed84538e6af32ebbd`](https://chromium.googlesource.com/v8/v8/+/58ab28f3e051fbe4ac14f4aed84538e6af32ebbd), 2026-01-06, `[wasm][revec] Fix offset for reordered Load extends`, [42202660](https://issues.chromium.org/issues/42202660). `SLPTree::BuildTreeRec` and `WasmRevecReducer::REDUCE_INPUT_GRAPH(Simd128LoadTransform)` reconstruct the packed first address from the correct member.
- Files: `src/compiler/turboshaft/wasm-revec-reducer.{cc,h}` and Wasm SIMD cctests.
- Scope: experimental optimized x64 SIMD256 revectorization, with AVX2 in the tests. Liftoff is unaffected.
- Classification/confidence: **real direct address fixes; ruled out as a direct match to the scalar body operations and cross-tier reproduction**.

### 5. x64 CET Wasm jump-table slot overflow

- Node/upstream: [`59f4318976ee64429587c1cf3adcc6de54f5c29d`](https://github.com/nodejs/node/commit/59f4318976ee64429587c1cf3adcc6de54f5c29d), upstream V8 [`1158ae71974987dc6492c7f407e8a7c005756ffc`](https://chromium.googlesource.com/v8/v8/+/1158ae71974987dc6492c7f407e8a7c005756ffc), authored 2026-07-14; [Node #64432](https://github.com/nodejs/node/pull/64432), [Node #64424](https://github.com/nodejs/node/issues/64424).
- Title: `[wasm] Fix jump table slot overflow on x64 with CET enabled`.
- Files/functions: `src/wasm/jump-table-assembler.{cc,h}`, `JumpTableAssembler::EmitJumpSlot` and slot-size constants.
- Behavior: checks relative displacement before emitting the CET `ENDBR`/NOP jump-slot sequence so the fixed-size slot cannot overflow.
- First Node release: v26.6.0.
- Mismatch: the captures stop on ordinary function-body memory operations, not in a jump slot. The system binary does not advertise an ELF IBT requirement even though the CPU flags include IBT. This patch is therefore a tempting title with the wrong code site and likely inactive build condition.
- Classification/confidence: **direct x64 Wasm correctness fix; ruled out as a direct match**.

### 6. Trap handler and memory reservation

Node's 14.6 roll includes an upstream API for Wasm memory reservation size ([`44f64f1d`](https://github.com/nodejs/node/commit/44f64f1dd9b2e7c99431b40bc927959700a9d418)). Node [`79262ff8609d7019b1df2800093552bc0104dcc4`](https://github.com/nodejs/node/commit/79262ff8609d7019b1df2800093552bc0104dcc4), [#62132](https://github.com/nodejs/node/pull/62132), auto-disables the Wasm trap handler when the process address-space limit is below the reservation; an unlimited limit retains previous behavior. It first ships in v26.0.0.

This can materially change generated code: trap-handler mode may rely on guarded memory plus signal recovery, while explicit-check mode emits bounds checks. It would explain a rate change only if the package/environment selected different modes. The current record has no such demonstrated `RLIMIT_AS` difference, and the validated old fault was rejected as a Wasm OOB trap precisely because its address was outside the expected guarded range. Classification: **possible trap-mode perturbation; weak confidence**.

### 7. Code-range, allocation, `memory.grow`, and scheduler perturbations

These four changes were retained because they can alter allocation, GC scheduling, virtual-address layout, or generated-code layout. Each first appears in a released Node line through V8 14.6.202.33 in **Node v26.0.0**. None changes the x64 base-plus-small-displacement calculation seen in the captures.

- [`f5913edf349caeffee96a08f4349edaef6db330f`](https://chromium.googlesource.com/v8/v8/+/f5913edf349caeffee96a08f4349edaef6db330f), authored 2026-01-13 and landed 2026-01-14, `[heap] Use RetryCustomAllocate in WasmCodeManager`; [448848875](https://issues.chromium.org/issues/448848875). In `src/wasm/wasm-code-manager.cc`, `WasmCodeManager::NewNativeModule` replaces a bespoke two-GC retry loop with the heap allocator's `RetryCustomAllocate` path when reserving initial Wasm code space. It may perturb GC and code-space placement under allocation pressure. **Weak**.
- [`b9c304c38feac22803b6bb1802881d4542392e5a`](https://chromium.googlesource.com/v8/v8/+/b9c304c38feac22803b6bb1802881d4542392e5a), authored 2025-09-05 and landed 2025-09-08, `Reland "Reland "[heap] Fix CodeRange red zone allocation for contiguous RO space""`; [442942399](https://issues.chromium.org/issues/442942399), [429538831](https://issues.chromium.org/issues/429538831). In `src/heap/code-range.cc`, `CodeRange::InitReservation` scans aligned red-zone candidates instead of checking only the first overlapping region. The commit explicitly says the feature was disabled pending later enablement, and both endpoint binaries have pointer compression disabled. It is therefore **ruled out as a direct endpoint mechanism**; retained only as provenance for code-range review.
- [`5dd4e7c28beda06cb8ae890a779fa578adae057c`](https://chromium.googlesource.com/v8/v8/+/5dd4e7c28beda06cb8ae890a779fa578adae057c), 2025-09-19, `[wasm] Mark memory.grow builtin as CanAllocate()`; [445870128](https://issues.chromium.org/issues/445870128). In `src/compiler/turboshaft/builtin-call-descriptors.h`, the `WasmMemoryGrow` descriptor now tells Turboshaft that the builtin can allocate on-heap; the regression is `test/mjsunit/regress/wasm/regress-445870128.js`. This is a real compiler-effect correction if the relevant path executes `memory.grow`, but no grow is tied to the captured instruction and it does not explain `+2^42`. **Weak**.
- [`768b63d080ceb2d0bae1442593245fc896067780`](https://chromium.googlesource.com/v8/v8/+/768b63d080ceb2d0bae1442593245fc896067780), 2025-10-22, `[compiler] Make the scheduler faster`; no linked issue. It changes `src/compiler/backend/instruction-scheduler.{cc,h}`, `instruction-selector.{cc,h}`, and `instruction.{cc,h}`, principally `InstructionScheduler` graph/queue construction and `InstructionSequence::EndBlock`. Ready/waiting lists, operand/successor containers, cached instruction flags, and terminator handling change. The intended result is semantically equivalent scheduling, though code ordering under ties and compilation timing can be perturbed. It supplies no direct address-generation repair. **Weak**.

## Complete Node-local V8 patch inventory

The roll history was reviewed separately from the upstream V8 range because Node reapplies carry patches and cherry-picks fixes.

### Patches carried after each major roll

After 14.2.231.9: `7bc0f245` (zlib duplicate symbol), `6e5f3b9f` (Windows `V8_PRESERVE_MOST`), `ea3d14ea` (header comment), `39eb88ea` (MSVC `std::map` for `EphemeronRememberedSet`), `46f72577` (illumos), `710105ba` (illumos `madvise`).

After 14.3.127.12, the same stack was reapplied as `7c8483a4`, `ecca2b0d`, `4157964c`, `2243e58e`, `5e41e522`, and `72d719dc`.

After 14.6.202.33: `a10bf1e6` (zlib), `bef7b31a` (Windows macro), `0660b942` (header comment), `947ec321` (illumos), `9f2b7d40` (illumos `madvise`), `8c1f7adb` (Windows build), `15d406c1` (AIX race). The MSVC `EphemeronRememberedSet` patch was no longer needed.

These are portability/build patches, not Linux x64 Wasm execution fixes.

### Upstream cherry-picks and patch rolls

Between 14.2.231.9 and 14.3.127.12: `de8386de` (empty `getOwnPropertySymbols` fast case), `1acd8df3` (GCC build), `f819aec2` (module DCHECKs), rolls `e0ca9935`/`76d6be5f`/`baefd4d5`, `8f66bec9` (Loong64 build), `f9a83ffc` (heap statistics), `96f7a2be` (PPC/S390 host architecture).

Between 14.3.127.12 and 14.6.202.33: `6494c7bc` (PPC/S390 host architecture), `b59af772` (refresh backing store for `AtomicWait` after shared-memory growth), `bf5c6a8b` (GCC build for that code), `da71ab68` (Highway), rolls `8716146d`/`bfc729cf`/`9d27d9a3`/`87d7db19`, `859332bf` (ArrayBuffer detach key), `b220fbe4` (RISC-V stack), `6682787d` (`WriteUtf8V2`), `a0d8ea42` (PPC/S390 Wasm jump table), `8ea96e65` (UTF-16 length), `cc967413` (big-endian Wasm `S128Const`). The only memory-growth item is shared `AtomicWait`; it does not match the PGlite function-body store/add captures.

With the 14.6.202.33 roll: `3cbd3404` (Highway), `5e0dc169` (PPC/S390 jump table), `80907c02` (proxy padding), `3ee1ea7d` (old libstdc++), `d7eccac9` (endian const copy), `1f8f288e` (big-endian `S128Const`), `44f64f1d` (Wasm memory reservation API), `3839c4a7` (transition-array rehash), `784431d6` (contextual stores), `46852d2d` (RISC-V JSPI). A downstream array-index collision bundle is `089d6c77`.

After 14.6.202.33 through v26.7.0: `d936c30f` then revert `b7fab70d` and corrected `ce0f498d` (AIX clang), `dae2219c` (heap profiler), roll `3dee18f7`, `a34c4ea1` (`WebAssembly.Exception` API), `0bf8e123` (`CopyArrayBufferBytes` API), `feefd179`/`a640543a`/`879fdc4d` (promise API/lifetime), `d7a4b22c` (restricted global lookup), `59f43189` (x64 CET Wasm jump slot), `8eeae28e` (Loong64), `308c6b2a` (ICU4X/Temporal DEPS), `2b59984c` (inspector promise lifetime).

The TSV contains the full hashes, dates, subjects, and dispositions. None of the Node-only carry patches modifies Linux x64 Wasm linear-memory address formation.

## Mechanism analysis of the `+2^42` signature

For the captured forms, the architectural effective address is:

```text
EA = r13 + sign_extend(displacement)
0x6720080 + 0x1c0 = 0x6720240
0x6720080 + 0x0a8 = 0x6720128
```

The reported addresses were:

```text
0x40006720240 - 0x06720240 = 0x40000000000 = 2^42
0x40006720128 - 0x06720128 = 0x40000000000 = 2^42
```

There is no index register in these instructions and no V8-side bounds-check arithmetic participates in the CPU's final base-plus-displacement calculation. If V8 emitted the wrong base, the stopped `r13` would show it. If V8 emitted a wrong displacement, the instruction bytes/disassembly would show it. If a compiler register allocator chose the wrong live value, the architectural `r13` at the stop would ordinarily be wrong. The recorded state instead describes the intended mapped address while the fault record describes a different address.

That makes the following distinction important:

- A Node/V8 change **could** avoid or perturb the susceptible instruction stream, layout, timing, tier, or CPU scheduling often enough to suppress failures.
- The reviewed source changes do **not** explain how those frozen architectural operands conventionally compute the observed `si_addr`.

Ordinary software corruption is not impossible. It could affect code or state before the snapshot, interact with asynchronous signal handling, or induce a platform fault whose architectural reconstruction is misleading. But the recurrence across two operation types with exactly one stable high bit is unlike an unconstrained V8 use-after-free or random bad pointer.

## Categories ruled out or strongly down-ranked

### Pointer compression, V8 sandbox, and shared cage

Both observed binaries report pointer compression, sandbox, and shared cage disabled. Pointer-compression-only store folding such as [`1bf7afc9`](https://chromium.googlesource.com/v8/v8/+/1bf7afc9d6af178f215300e7822606f26e15c457) is inactive. Isolate-group/cage changes are therefore not a viable endpoint difference.

### APX

V8 gained APX detection/configuration changes in the range, but the CPU flags supplied in the evidence do not include `apx`. The captured instructions use ordinary legacy addressing. Down-ranked to inactive.

### CET/IBT and shadow stack

The host advertises `ibt` and `user_shstk`, but capability is not the same as process enablement. The system Node ELF does not advertise an IBT requirement, and the sole x64 CET Wasm fix changes jump-table slots, not body memory operations. Strongly down-ranked.

### Wasm memory growth and backing-store refresh

The Node backport for `AtomicWait` after memory growth refreshes the backing-store pointer for shared-memory wait calls. The broad lazy-ArrayBuffer refactor affects grow and mapping, but no evidence ties the captured store/add sites to a stale shared backing store. A stale base would also normally appear in `r13`; here `r13` points to the mapped intended object. Direct stale-backing-store explanations are down-ranked; layout perturbation remains plausible.

### Liftoff correctness changes

[`7180099f`](https://chromium.googlesource.com/v8/v8/+/7180099f2cfe694d5abdadb598951fc444d1db55) fixes an invalidated out-of-line trap label in `LiftoffCompiler::CallIndirectImpl`; [`a5a3253e`](https://chromium.googlesource.com/v8/v8/+/a5a3253e03dbdf7b42c6c680808a19e82cc44b55) freezes cache state in `LoadOldFramePointer` for experimental growable stacks. Both are real but concern indirect calls or an experimental stack feature, not scalar linear-memory EA formation.

### TurboFan/Turboshaft-only candidates

The spill-placer and revectorizer changes affect optimized code. Existing flag experiments show the failure is not dependent on one optimized tier. That does not eliminate layout effects from optimized background compilation, but it argues against these fixes being necessary correctness repairs.

### mmap/code range and JIT allocation

Code manager retry, red-zone, reservation-size, and mapping changes were retained. They can alter virtual-address layout or allocation success. None changes an instruction's base-plus-displacement semantics, and the intended data address was mapped/writable in all validated captures. These remain low-confidence exposure modifiers.

### PGlite-generated Wasm changes

PGlite stayed at 0.5.4 across the endpoint comparison, so the module-generating package did not change. PGlite is PostgreSQL compiled to WebAssembly ([official repository](https://github.com/electric-sql/pglite)). A historical PGlite [issue #339](https://github.com/electric-sql/pglite/issues/339) reports a flaky Wasm out-of-bounds trap under Bun 1.1.29/PGlite 0.2.6; it is a normal Wasm trap on different versions, not a native `SIGSEGV` with the bit-42 signature.

### Generic Node/V8 known bugs

Official Node, V8, and PGlite issue searches found no report matching all of: Linux x64, unchanged correct base register, `si_addr = intended + 2^42`, E-core/CPU localization, PGlite 0.5.4, and Node 25/26. This is a negative search result, not proof that no private, duplicate, or differently described bug exists.

## Uncertainty and alternative interpretations

1. The v26.7.0 rate is not precisely estimated by 20 immediate clean trials. Even 0/20 has an approximate one-sided 95% upper failure bound near 14%; 0/100 would reduce it to about 3%.
2. The larger campaign has one v26.7.0 failure, so “fixed” is empirically false even before source attribution.
3. The `/usr/bin/node` package provenance is not equivalent to an official binary/source boundary. PGO alone can substantially rearrange hot code.
4. The exact generated Wasm function has not been minimized or mapped back to its module instruction sequence, limiting candidate-specific comparison.
5. `si_addr` is kernel-reported fault state, while GDB observes a stopped process. The consistency is strong, but the measurement chain is not a formal proof that every relevant transient microarchitectural state is represented in the register dump.
6. CPU/core localization may be entangled with temperature, power, cluster topology, scheduling, or firmware state. The interleaved campaigns reduce but do not erase those confounders.
7. A V8 change outside the manually detailed set could alter exposure indirectly. The full TSV makes that residual set inspectable.

## Minimal high-information test and bisect plan

No further workload should be run until binary provenance is controlled. Then:

1. **Build/package control.** Compare official upstream binaries first, then preferably self-build both endpoints with the same compiler, linker, PGO setting, Node configure flags, and dependency model. Record SHA-256, ELF build ID/properties, `process.config`, compiler version, and linked libraries.
2. **Workload control.** Freeze the PGlite package/module hash, query, environment, CPU 19 affinity, child count, wave scheduling, kernel, microcode, BIOS settings, governor, and temperature/power logging.
3. **Statistical design.** Use randomized A/B/A blocks on the same boot. At the old baseline rate, tens of trials find gross regressions; require at least 100 clean pinned trials before calling a boundary strongly suppressive. Preserve every failure's instruction bytes, registers, `si_addr`, maps, and faulting CPU.
4. **Locate the major-roll boundary.** Test identical-build commits immediately before/after each of the three Node V8 roll boundaries listed below. Do not start by bisecting all 5,693 commits.
5. **Split upstream from Node carry patches.** If a roll boundary changes the rate, compare the raw roll commit with the successive Node carry/cherry-pick stack. Then bisect the upstream V8 tags using the same Node embedder/build.
6. **Candidate toggles/reverts.** At a localized boundary, revert/cherry-pick `8f1931ca`, `51d20674`, `89ab7b1e`, and the two revectorizer commits one at a time. Use Liftoff-only/optimized-only and revectorization on/off only as diagnostic partitions, not claimed workarounds.
7. **Trap-mode check.** Record `RLIMIT_AS` and whether V8's trap handler is enabled. Compare explicit-check versus trap-handler builds only after this state is observable and controlled.
8. **Platform discriminator.** If the same binary and code hash alternates between high and low failure states across CPU/core, boot, firmware, or microcode while the source boundary does not, prioritize platform investigation. If a single source commit reproducibly toggles the fault on the same core/boot, capture the generated code diff and narrow its mechanism.

## The three highest-information next boundaries

These source boundaries provide more information than three arbitrary released binaries because they isolate the major embedded-V8 transitions:

1. **Node `c2843b722ca161692c6848e19d375f35b7a08c60^` versus `c2843b722ca161692c6848e19d375f35b7a08c60`**: V8 14.1 to 14.2. This brackets the direct x64 folded-load EA fix and the first major codegen change set. No official release shipped 14.2.231.9 exactly, so identical local builds are required.
2. **Node `53379f370695378b1be07b452c4cf3a43edd4fcd^` versus `53379f370695378b1be07b452c4cf3a43edd4fcd`**: V8 14.2 to 14.3. This separates the Liftoff fixes and the Node `AtomicWait` growth backport from the prior roll.
3. **Node `cc547428e15e9dbabceb76978d9b030f46e6db5e^` versus `cc547428e15e9dbabceb76978d9b030f46e6db5e`**: V8 14.3.127.18 to 14.6.202.33. This brackets the lazy Wasm `ArrayBuffer`, spill placer, and revectorizer changes and is first available as released **Node v26.0.0**.

For release-only triage before local builds, test official Node **v26.0.0**, **v26.1.0**, and the **v26.5.1 → v26.6.0** boundary. They respectively isolate the 14.6.202.33 debut, the `.33 → .34` patch roll, and the post-v26.5 x64 CET jump-table fix. Because v26.5.1 is already known to fail, a clean v26.6.0 would be informative but would still require an identical-build commit test before attributing causality.

## Bottom line

The source review found real x64/Wasm bugs, but none matches an unchanged correct `r13`, a small encoded displacement, and a kernel fault address with exactly bit 42 added. The most defensible interpretation is that Node/V8/build changes alter exposure to a rare platform-dependent condition. The next experiment should therefore control the build and test the three major roll boundaries above, rather than treating `/usr/bin/node` v26.7.0 as evidence of a V8 fix.
