# On problematic system, CPUs 0–7 are P-cores and 8–23 are E-cores.

## Yes, we can isolate to groups of cores

```bash
# P-Cores all fine.
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 0-7  node repro.mjs 16 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=16 waves=50
wave=1 passed=16/16
# ...
wave=50 passed=16/16
failedWaves=0 completedWaves=50 requestedWaves=50

# E-Cores 8-15 fail
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8-15 node repro.mjs 16 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=16 waves=50
wave=1 passed=15/16
child=2 code=null signal=SIGSEGV elapsedMs=2285
failedWaves=1 completedWaves=1 requestedWaves=50
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8-15 node repro.mjs 16 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=16 waves=50
wave=1 passed=12/16
child=5 code=null signal=SIGSEGV elapsedMs=1821
child=8 code=null signal=SIGSEGV elapsedMs=5835
child=9 code=null signal=SIGSEGV elapsedMs=3844
child=11 code=null signal=SIGSEGV elapsedMs=1551
failedWaves=1 completedWaves=1 requestedWaves=50

# P-Cores passing again.
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 0-7  node repro.mjs 8 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=8 waves=50
wave=1 passed=8/8
# ...
wave=50 passed=8/8
failedWaves=0 completedWaves=50 requestedWaves=50

# E-Cores 8-15 failing again
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8-15 node repro.mjs 8 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=8 waves=50
wave=1 passed=8/8
wave=2 passed=6/8
child=1 code=null signal=SIGSEGV elapsedMs=1879
child=2 code=null signal=SIGSEGV elapsedMs=1595
failedWaves=1 completedWaves=2 requestedWaves=50

[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8-15 node repro.mjs 8 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=8 waves=50
wave=1 passed=7/8
child=6 code=null signal=SIGSEGV elapsedMs=1714
failedWaves=1 completedWaves=1 requestedWaves=50


# E-Cores 8-11 fail
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8-11  node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=3/4
child=2 code=null signal=SIGSEGV elapsedMs=1547
failedWaves=1 completedWaves=1 requestedWaves=50

# E-Cores 12-15 pass
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 12-15 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=4/4
# ...
wave=50 passed=4/4
failedWaves=0 completedWaves=50 requestedWaves=50

# E-Cores 16-19 fail
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 16-19 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=1/4
child=1 code=null signal=SIGSEGV elapsedMs=3299
child=3 code=null signal=SIGSEGV elapsedMs=1532
child=4 code=null signal=SIGSEGV elapsedMs=3621
failedWaves=1 completedWaves=1 requestedWaves=50

[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 16-19 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=1/4
child=2 code=null signal=SIGSEGV elapsedMs=1406
child=3 code=null signal=SIGSEGV elapsedMs=2080
child=4 code=null signal=SIGSEGV elapsedMs=1515
failedWaves=1 completedWaves=1 requestedWaves=50

# E-Cores 20-23 fail too
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 20-23 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=3/4
child=2 code=null signal=SIGSEGV elapsedMs=4531
failedWaves=1 completedWaves=1 requestedWaves=50

[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 20-23 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=2/4
child=1 code=null signal=SIGSEGV elapsedMs=1342
child=3 code=null signal=SIGSEGV elapsedMs=1442
failedWaves=1 completedWaves=1 requestedWaves=50

# E-Cores 12-15 passing again
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 12-15 node repro.mjs 4 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=4 waves=50
wave=1 passed=4/4
#...
wave=50 passed=4/4
failedWaves=0 completedWaves=50 requestedWaves=50
```

## Preliminary single-CPU localization

### Within CPUs 16–19, only CPU 19 reproduced the failure

- CPU 16: no failure observed in 50 waves.
- CPU 17: no failure observed in 50 waves.
- CPU 18: no failure observed in 50 waves.
- CPU 19: reproduced in three runs, failing at waves 2, 10, and 3.

```bash
# Core 16 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 16 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
#...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 17 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 17 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 18 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 18 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 19 problematic
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 19 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=4201
failedWaves=1 completedWaves=2 requestedWaves=50

[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 19 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=1/1
wave=3 passed=1/1
wave=4 passed=1/1
wave=5 passed=1/1
wave=6 passed=1/1
wave=7 passed=1/1
wave=8 passed=1/1
wave=9 passed=1/1
wave=10 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=1201
failedWaves=1 completedWaves=10 requestedWaves=50

[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 19 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=1/1
wave=3 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=1052
failedWaves=1 completedWaves=3 requestedWaves=50
```

### Within CPUs 20–23, only CPU 21 reproduced the failure

- CPU 20: no failure observed in 50 waves.
- CPU 21: reproduced once, at wave 22.
- CPU 22: no failure observed in 50 waves.
- CPU 23: no failure observed in 50 waves.

```bash
# Core 20 good
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 20 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 21 fails, but less often than other failing cores.
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 21 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=1/1
wave=3 passed=1/1
wave=4 passed=1/1
wave=5 passed=1/1
wave=6 passed=1/1
wave=7 passed=1/1
wave=8 passed=1/1
wave=9 passed=1/1
wave=10 passed=1/1
wave=11 passed=1/1
wave=12 passed=1/1
wave=13 passed=1/1
wave=14 passed=1/1
wave=15 passed=1/1
wave=16 passed=1/1
wave=17 passed=1/1
wave=18 passed=1/1
wave=19 passed=1/1
wave=20 passed=1/1
wave=21 passed=1/1
wave=22 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=1165
failedWaves=1 completedWaves=22 requestedWaves=50

# Core 22 good
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 22 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 23 good
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 23 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50
```

### Within CPUs 8–11, only CPU 11 reproduced the failure

- CPU 8: no failure observed in 50 waves.
- CPU 9: no failure observed in 50 waves.
- CPU 10: no failure observed in 50 waves.
- CPU 11: reproduced in two runs, failing at waves 7 and 14.

```bash
# Core 8 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 8 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 9 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 9 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 10 fine
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 10 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
# ...
wave=50 passed=1/1
failedWaves=0 completedWaves=50 requestedWaves=50

# Core 11 fails
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 11 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=1/1
wave=3 passed=1/1
wave=4 passed=1/1
wave=5 passed=1/1
wave=6 passed=1/1
wave=7 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=1019
failedWaves=1 completedWaves=7 requestedWaves=50
[dragon@dragon-pro18 node-pglite-wasm-sigsegv-repro]$ taskset -c 11 node repro.mjs 1 50
node=v25.2.1 v8=14.1.146.11-node.14 platform=linux arch=x64 children=1 waves=50
wave=1 passed=1/1
wave=2 passed=1/1
wave=3 passed=1/1
wave=4 passed=1/1
wave=5 passed=1/1
wave=6 passed=1/1
wave=7 passed=1/1
wave=8 passed=1/1
wave=9 passed=1/1
wave=10 passed=1/1
wave=11 passed=1/1
wave=12 passed=1/1
wave=13 passed=1/1
wave=14 passed=0/1
child=1 code=null signal=SIGSEGV elapsedMs=1045
failedWaves=1 completedWaves=14 requestedWaves=50
```

## Preliminary conclusion

With execution restricted to one logical CPU, SIGSEGV reproduced on:

- CPU 11
- CPU 19
- CPU 21

No failure was observed in 50 waves each on CPUs 8–10, 16–18, 20, and
22–23. CPUs 12–15 were not tested individually here, although the preceding
four-CPU cluster tests passed 400/400 child-runs.

These results localize reproduction to particular CPUs, but additional runs
are required before concluding that the remaining CPUs cannot fail.