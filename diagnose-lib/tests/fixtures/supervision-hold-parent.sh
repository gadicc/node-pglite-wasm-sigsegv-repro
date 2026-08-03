#!/usr/bin/env bash
# Keep a launched process unreaped so parent-death tests exercise zombie state.
set -u

child_file="$1"
shift

"$@" &
child_pid=$!
printf '%s\n' "$child_pid" > "$child_file"
kill -STOP "$BASHPID"
wait "$child_pid" 2> /dev/null || true
