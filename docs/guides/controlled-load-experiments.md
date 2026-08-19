# Run controlled-load experiments

This guide explains the four current modes in `load-state-aba.mjs`. Each mode changes one declared condition while verified external load and machine-state boundaries remain visible in the evidence.

## Understand the shared load control

The harness starts one `/usr/bin/yes` worker per selected load CPU. It pins every worker through `taskset` and verifies its process identifier, executable, and affinity through `/proc` before measurement.

The harness rechecks the original workers at every mode-specific boundary. A failed check stops the comparison and marks the bundle operationally incomplete. It stops and reaps every worker process group on completion, errors, `SIGINT`, and `SIGTERM`.

The harness does not change BIOS settings, turbo, frequency, unrelated process affinity, or sysfs values. It does not require root. It writes a new directory below `diagnostics/` unless you supply `--out-dir`.

Every mode defaults to a dry run. Add `--yes` only after reviewing the exact plan. Each Node executable resolves to a canonical path and SHA-256 digest before the plan is fixed.

## Compare load off, on, and off

The default mode runs one sequential PGlite child pinned to the target CPU. It measures A1 without script-induced load, B with verified load, and A2 after load removal and a settling interval.

Inspect and then run the default plan:

```sh
npm run load:aba
npm run load:aba -- --yes
```

Select other load CPUs or sample counts explicitly:

```sh
npm run load:aba -- \
  --load-cpus 16-18 --runs 30 --yes
```

An A leg means only that the script did not induce load. Close or control unrelated applications before describing an A leg as idle.

The default target is CPU 19, the default load mask is CPUs 0-7, and the controller selects a disjoint CPU. Override them with `--target-cpu`, `--load-cpus`, and `--controller-cpu`.

## Capture a bounded GDB fault under load

GDB mode invokes `capture-fault.sh` against `child.mjs` while the same verified induced load remains active. The sequence is settle, start workers, verify, warm the load, verify, capture, recheck, then stop the workers.

Inspect and run a capture against an exact Node binary:

```sh
npm run load:gdb -- \
  --node-bin /home/dragon/.nvm/versions/node/v25.2.1/bin/node
npm run load:gdb -- \
  --node-bin /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --yes
```

The capture defaults to 10 attempts and one retained fault. Change the bounds with `--gdb-max-runs` and `--gdb-max-captures`, each limited to 1 through 4096.

The runner retains canonical `ATTEMPT` and `COUNTS` accounting, 64 MiB generation-bound transcripts, and clean, captured, or error classification. It requires the runner process status to agree with the terminal `COUNTS` status before publishing the evidence envelope.

The bundle stores the runner log at `logs/gdb/runner.log`, transcripts as `gdb/cpuN-runM.txt`, the legacy summary at `results/gdb.meta`, and the authoritative envelope at `results/gdb.manifest`.

A no-fault result within the bound is an experimental outcome, not an operational error. The harness records the capture runner's exit-code-3 convention but completes successfully with `no-fault`.

Compare the faulting instruction, `SI_ADDR`, registers, and backtrace with the documented [fault-address signature](../case-study/fault-signature-and-cpu-localization.md#identify-the-recurring-fault-address-signature) before treating the loaded capture as the same failure.

## Compare two Node executables under constant load

Node A/B/A mode changes only the Node executable. It settles, starts and verifies one load generation, warms the load, then runs Node A, Node B, and Node A again. The load does not stop or re-pin between legs.

Inspect and run a comparison:

```sh
npm run load:node-aba -- \
  --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --node-b /usr/bin/node
npm run load:node-aba -- \
  --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --node-b /usr/bin/node --yes
```

`--node-bin` remains the Node A default when `--node-a` is absent. The dry-run plan prints the resolved paths, versions, V8 versions, module versions, and hashes. Do not infer current versions from historical paths in this repository.

This mode differs from load-state A/B/A. Load-state mode changes external load for one executable. Node A/B/A changes the executable under one constant induced load.

The fixed A1, B, A2 order can still confound time and thermal drift. Repeat complete sessions instead of pooling legs across sessions.

## Compare Node and warmup combinations

Node matrix mode gives every Node and warmup combination a separate load cycle. Each cycle settles, starts fresh workers, warms for that condition, verifies, runs one exact Node executable, rechecks, then stops and reaps the workers.

The defaults use five child runs per cycle, two cycles per condition, 5-second and 60-second warmups, and a 60-second settle before each cycle. A seeded permutation determines the first order. The second repetition reverses that order.

Inspect a replayable plan:

```sh
npm run load:node-matrix -- \
  --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --node-b /usr/bin/node \
  --matrix-seed 20260818
```

Run the default matrix:

```sh
npm run load:node-matrix -- \
  --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --node-b /usr/bin/node \
  --matrix-seed 20260818 --yes
```

Increase complete paired repetitions explicitly:

```sh
npm run load:node-matrix -- \
  --node-a /home/dragon/.nvm/versions/node/v25.2.1/bin/node \
  --node-b /usr/bin/node \
  --matrix-repeats 4 --runs 5 \
  --matrix-seed 20260818 --yes
```

The default fixed waits total about 12 minutes 20 seconds, plus child runtimes and validation checks. Set warmups with `--matrix-warmups A,B`, repetitions with `--matrix-repeats`, and the ordering seed with `--matrix-seed`.

The cycle is the experimental unit for load-onset effects. Multiple child runs within one cycle share the same onset and machine history. `report.md` therefore shows a per-cycle table before descriptive condition totals.

Even repetition counts pair each seeded order with its reverse. An odd final repetition remains recorded as unpaired.

## Configure shared timing and output

All modes accept:

- `--target-cpu N`
- `--load-cpus LIST`
- `--controller-cpu N|auto`
- `--runs N`
- `--node-bin PATH`
- `--settle-seconds N`
- `--load-warmup-seconds N`
- `--interval-ms N`, from 50 to 60000
- `--out-dir DIR`
- `--dry-run` or `--yes`

GDB and Node A/B/A default to a five-second load warmup. Default load-state mode has no additional load warmup. Node matrix uses its condition-specific warmup values.

## Inspect the controlled-load bundle

Every bundle contains:

- `metadata.json`: configuration, platform, topology, and exact binary identities
- `events.jsonl`: worker validation plus phase or cycle boundaries
- `telemetry.ndjson`: 100 ms default samples of frequency, exposed temperatures, and turbo state
- `report.md`: separate A1, B, A2, cycle, or capture results

Load-state, Node A/B/A, and Node matrix bundles add `results.jsonl` with one exact child outcome per row. GDB mode publishes the validated GDB evidence envelope instead.

Kernel `scaling_cur_freq` is a point-in-time value. It is not an effective-frequency measurement.

## Choose the next comparison

Use this sequence when investigating the same fault:

1. Run GDB mode under load to confirm the fault signature.
2. Run Node A/B/A under the same load to measure executable dependence.
3. Run Node matrix mode when fixed-order results suggest warmup or time drift.
4. Repeat complete bundles before treating condition totals as stable rates.

Each bundle samples one interval in the machine's broader history. No mode removes unmeasured firmware, thermal, voltage, scheduler, or unrelated-workload effects.
