#!/usr/bin/env bash
# restore-child.sh - helper for the restore-on-signal tests.
# Usage: restore-child.sh <repo-root> <restore-file> <fake-sysfs-file> <ready-file> [exit-now]
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
exit_now="${5:-}"

export DIAG_SUDO=""
# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"

diag_restore_save "$fake_file"
diag_register_restore_trap
diag_sysfs_write "$fake_file" 1

# Exercise cleanup ordering and reaping as well as the restore itself.
sleep 300 &
DIAG_SAMPLER_PID=$!
printf '%s\n' "$DIAG_SAMPLER_PID" > "$ready_file"
if [[ -n "$exit_now" ]]; then
  exit 0
fi

# A foreground external `sleep` makes non-interactive Bash defer traps until
# the child exits. A read/write FIFO has no writer process to clean up and lets
# the shell handle INT/TERM immediately while blocked in `read`.
fifo="$ready_file.fifo"
mkfifo "$fifo"
exec {signal_fd}<> "$fifo"
rm -f "$fifo"
read -r -u "$signal_fd" _
