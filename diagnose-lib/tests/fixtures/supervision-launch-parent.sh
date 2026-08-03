#!/usr/bin/env bash
# Expose the immediate post-fork arming window without starting unsafe work.
set -u

repo_root="$1"
leader_file="$2"
payload_file="$3"

# shellcheck source=../../common.sh
source "$repo_root/diagnose-lib/common.sh"
diag_process_group_start bash -c '
  printf "%s\n" "$BASHPID" > "$1"
  while :; do sleep 1; done
' supervised-arming "$payload_file"
printf '%s\n' "$DIAG_WORKLOAD_PID" > "$leader_file"
while :; do sleep 1; done
