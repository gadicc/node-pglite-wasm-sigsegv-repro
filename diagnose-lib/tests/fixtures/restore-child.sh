#!/usr/bin/env bash
# restore-child.sh - helper for the restore-on-signal tests.
# Usage: restore-child.sh <repo-root> <restore-file> <fake-sysfs-file> <ready-file> [exit-now]
#
# Saves the current value of the fake sysfs file, arms the restore traps,
# writes 1 into it (simulating "turbo disabled"), signals readiness, then
# sleeps until a signal arrives (or exits immediately when exit-now is set,
# exercising the EXIT trap path).
set -u

repo_root="$1"
export DIAG_RESTORE_FILE="$2"
fake_file="$3"
ready_file="$4"
exit_now="${5:-}"

export DIAG_SUDO=""
# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"

diag_restore_save "$fake_file"
diag_register_restore_trap
diag_sysfs_write "$fake_file" 1

: > "$ready_file"
if [[ -n "$exit_now" ]]; then
  exit 0
fi
sleep 60
