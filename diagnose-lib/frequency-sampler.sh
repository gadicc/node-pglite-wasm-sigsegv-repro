#!/usr/bin/env bash
# Poll per-CPU scaling_cur_freq. Production callers pass the fixed kernel
# sysfs root; tests may pass a fixture root and --once.
set -u

once=0
if [[ "${1:-}" == --once ]]; then
  once=1
  shift
fi
cpu_root="${1:-/sys/devices/system/cpu}"
[[ "$cpu_root" == /* && -d "$cpu_root" ]] || exit 2

while :; do
  now="$(date +%s)"
  found=0
  for file in "$cpu_root"/cpu[0-9]*/cpufreq/scaling_cur_freq; do
    [[ -r "$file" ]] || continue
    cpu="${file%/cpufreq/scaling_cur_freq}"
    cpu="${cpu##*/cpu}"
    [[ "$cpu" =~ ^[0-9]+$ ]] || continue
    value="$(cat "$file")" || continue
    [[ "$value" =~ ^[0-9]+$ ]] || continue
    printf '%s %s %s\n' "$now" "$cpu" "$value"
    found=1
  done
  ((found == 1)) || exit 3
  ((once == 0)) || exit 0
  sleep 1
done
