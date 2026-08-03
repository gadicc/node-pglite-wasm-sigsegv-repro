#!/usr/bin/env bash
# A cooperative group leader with one descendant that ignores SIGTERM.
# Used only to verify that cleanup tracks the whole private process group.
set -u

ready_dir="$1"
leader_mode="${2:-wait}"
exit_gate="${3:-}"
trap 'exit 0' TERM

(
  trap '' TERM
  printf '%s\n' "$BASHPID" > "$ready_dir/child.pid"
  while :; do sleep 1; done
) &

printf '%s\n' "$$" > "$ready_dir/leader.pid"
if [[ "$leader_mode" == "exit" ]]; then
  while [[ -n "$exit_gate" && ! -e "$exit_gate" ]]; do
    sleep 0.01
  done
  exec true
fi
wait
