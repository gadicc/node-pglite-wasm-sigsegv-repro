#!/usr/bin/env bash
# Hold two writer fences and launch simultaneous supervised writer groups.
set -u

repo_root="$1"
bundle="$2"
restore_lock="$3"
run_log="$4"
commands_log="$5"
ready_dir="$6"

# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"
# shellcheck source=../../bundle-lock.sh
source "$repo_root/diagnose-lib/bundle-lock.sh"

diag_bundle_lock_acquire "$bundle"
diag_restore_lock_acquire "$restore_lock" "$(id -u)" "$(id -g)"
exec {RUN_LOG_FD}<> "$run_log"
exec {COMMANDS_LOG_FD}<> "$commands_log"

writer="$repo_root/diagnose-lib/tests/fixtures/supervision-writer.sh"
diag_supervised_group_start DIAG_WORKLOAD_PID workload \
  bash "$writer" "$ready_dir/workload.ready" "$ready_dir/workload.counter" workload \
  "$bundle" "${restore_lock}.guard" "$run_log" "$commands_log"
diag_supervised_group_start DIAG_SAMPLER_PID "frequency sampler" \
  bash "$writer" "$ready_dir/sampler.ready" "$ready_dir/sampler.counter" sampler \
  "$bundle" "${restore_lock}.guard" "$run_log" "$commands_log"

{
  printf 'PARENT=%s\n' "$BASHPID"
  printf 'WORKLOAD=%s\n' "$DIAG_WORKLOAD_PID"
  printf 'SAMPLER=%s\n' "$DIAG_SAMPLER_PID"
} > "$ready_dir/parent.ready"

while :; do sleep 1; done
