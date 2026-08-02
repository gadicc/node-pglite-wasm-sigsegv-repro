#!/usr/bin/env bash
# Exercise signal cleanup while diag_run_single_runs is waiting on a real
# external child process. The caller supplies fake taskset/node commands.
set -u

repo_root="$1"
export DIAG_RESTORE_FILE="$2"
fake_file="$3"
ready_file="$4"
fake_bin="$5"

export DIAG_SUDO=""
export PATH="$fake_bin:$PATH"
export WORKLOAD_PID_FILE="$ready_file"
# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"

# Keep this regression focused on workload-process cleanup rather than the
# sampler, whose signal behavior is covered by restore-child.sh.
diag_freq_sampler_start() { :; }
diag_freq_sampler_stop() { :; }

diag_restore_save "$fake_file"
diag_register_cleanup_traps
diag_sysfs_write "$fake_file" 1

# Bash handles the signal promptly while interrupted in `wait`. The fake node
# writes its PID before blocking, so the signal cannot race workload startup.
(
  while [[ ! -s "$ready_file" ]]; do sleep 0.01; done
  kill -TERM "$$"
) &

diag_run_single_runs "$ready_file.tsv" A1 0 1
