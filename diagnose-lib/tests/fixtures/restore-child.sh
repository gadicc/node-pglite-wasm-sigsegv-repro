#!/usr/bin/env bash
# restore-child.sh - helper for the restore-on-signal tests.
# Usage: restore-child.sh <repo-root> <restore-file> <fake-sysfs-file> <ready-file> [exit-now|signal:INT|signal:TERM]
#
# Saves the current value of the fake sysfs file, arms the restore traps,
# writes 1 into it (simulating "turbo disabled"), signals readiness, then
# blocks in a shell builtin until a signal arrives (or exits immediately when exit-now is set,
# exercising the EXIT trap path).
set -u

repo_root="$1"
export DIAG_RESTORE_FILE="$2"
fake_file="$3"
ready_file="$4"
action="${5:-}"

export DIAG_SUDO=""
# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"

diag_restore_rules_set "$fake_file" '^[01]$'
diag_restore_save "$fake_file"
diag_register_restore_trap
diag_sysfs_write "$fake_file" 1

# Exercise cleanup ordering and reaping as well as the restore itself.
diag_supervised_group_start DIAG_SAMPLER_PID "frequency sampler" sleep 300
printf '%s\n' "$DIAG_SAMPLER_PID" > "$ready_file"
if [[ "$action" == "exit-now" ]]; then
  exit 0
fi
if [[ "$action" == signal:* ]]; then
  signal="${action#signal:}"
  (sleep 0.05; kill -s "$signal" "$$") &
fi

# A foreground external `sleep` makes non-interactive Bash defer traps until
# the child exits. A read/write FIFO has no writer process to clean up and lets
# the shell handle INT/TERM immediately while blocked in `read`.
fifo="$ready_file.fifo"
mkfifo "$fifo"
exec {signal_fd}<> "$fifo"
rm -f "$fifo"
read -r -u "$signal_fd" _
