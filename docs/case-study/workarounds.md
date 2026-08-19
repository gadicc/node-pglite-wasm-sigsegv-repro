# Apply temporary workarounds

This page records mitigations tested on the affected machine. They reduce exposure to the observed trigger but do not resolve the underlying anomaly or guarantee data integrity.

> [!CAUTION]
> An incorrectly formed address could land on a mapped page and corrupt data without a crash. Clean application runs do not prove hardware integrity. If the fault survives current firmware and a stock-BIOS retest, platform service or system-board replacement remains the conservative response.

## Disable turbo globally

CPU 19 produced no observed failures in 20 attempts with turbo disabled and a reported 2.1 GHz ceiling.

Disable turbo until the next reboot:

```sh
echo 1 | sudo tee \
  /sys/devices/system/cpu/intel_pstate/no_turbo
```

Restore turbo with:

```sh
echo 0 | sudo tee \
  /sys/devices/system/cpu/intel_pstate/no_turbo
```

The sequential A/B/A result supports an association with fewer failures under the tested condition. It does not prove a frequency or voltage mechanism.

## Keep processes on tested P-cores

The completed exact-CPU protocols observed failures only on E-cores. An application-specific affinity can restrict the complete process and its threads to the extensively tested P-cores:

```sh
taskset -c 0-7 node app.mjs
```

This CPU numbering belongs to the affected machine. Verify topology and retest after firmware or hardware changes.

An affinity mask reduces scheduler exposure. It does not establish that every allowed CPU is permanently safe.

## Offline observed CPUs

The completed protocols observed exact-CPU failures on CPUs 9, 11, 17, 19, 21, 22, and 23 in at least one tested context.

Offline those logical CPUs with:

```sh
for cpu in 9 11 17 19 21 22 23; do
  echo 0 | sudo tee \
    "/sys/devices/system/cpu/cpu${cpu}/online"
done
```

Bring them online again with:

```sh
for cpu in 9 11 17 19 21 22 23; do
  echo 1 | sudo tee \
    "/sys/devices/system/cpu/cpu${cpu}/online"
done
```

These numbers should not be copied to another machine. They can also change in meaning after firmware, kernel, or system-board changes.

The listed CPUs include observations from different isolated and pinned-concurrent contexts. A failure in one context does not prove an intrinsic defect in that logical CPU.

## Apply a per-policy frequency cap

A 2.1 GHz ceiling is a conservative starting point based only on CPU 19's no-turbo sample. The per-CPU cap was not independently validated across all observed CPUs.

Apply the requested cap with:

```sh
for cpu in 9 11 17 19 21 22 23; do
  echo 2100000 | sudo tee \
    "/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_max_freq"
done
```

`intel_pstate` with Hardware-controlled Performance States (HWP) may not clamp the effective clock to `scaling_max_freq`. The earlier 800 MHz request still produced sampled frequencies from about 1.3 to 2.8 GHz.

Measure effective frequency under load and run a longer validation before relying on a cap. Check whether multiple logical CPUs share one cpufreq policy before assuming the write affects only one target.

## Avoid unsupported software mitigations

The reproduction survives these V8 controls:

- `--no-wasm-tier-up`
- `--liftoff-only`
- `--no-liftoff`
- `--no-concurrent-marking`
- `--single-threaded-gc`

Do not treat them as workarounds.

Different Node binaries and kernels changed trigger rates, but each available zero-failure sample had either a later positive observation or an uncontrolled build difference. Do not describe a runtime or kernel switch as a fix without a controlled, adequately sampled comparison.

## Prefer service over indefinite mitigation

The battery-only reproduction excludes the dock, adapter, mains, and external input path as requirements. The leading platform candidates remain internal power delivery, firmware interactions, and the CPU. A system-board replacement changes internal power delivery and the processor together on this model.

Preserve a verified diagnostic bundle and relevant live captures for a support case. Provide service identifiers through the support channel, not inside the evidence archive.
