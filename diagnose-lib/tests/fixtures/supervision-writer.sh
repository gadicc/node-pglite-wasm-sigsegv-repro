#!/usr/bin/env bash
# Infinite TERM-resistant writer used to exercise parent-death supervision.
set -u

ready_file="$1"
counter_file="$2"
tag="$3"
bundle_path="$4"
restore_path="$5"
run_path="$6"
commands_path="$7"

stat_line="$(< "/proc/$BASHPID/stat")"
stat_rest="${stat_line##*) }"
read -ra stat_fields <<< "$stat_rest"

target_is_held() {
  local expected="$1" result_name="$2" fd_path
  local -n result_ref="$result_name"
  result_ref=0
  for fd_path in "/proc/$$/fd/"*; do
    [[ "$fd_path" -ef "$expected" ]] && {
      result_ref=1
      return
    }
  done
}

bundle_open=0
restore_open=0
run_open=0
commands_open=0
lease_pipe_open=0
target_is_held "$bundle_path" bundle_open
target_is_held "$restore_path" restore_open
target_is_held "$run_path" run_open
target_is_held "$commands_path" commands_open
for fd_path in "/proc/$$/fd/"*; do
  fd_number="${fd_path##*/}"
  ((fd_number >= 3)) && [[ -p "$fd_path" ]] && lease_pipe_open=1
done

{
  printf 'PID=%s\n' "$BASHPID"
  printf 'PGRP=%s\n' "${stat_fields[2]}"
  printf 'SESSION=%s\n' "${stat_fields[3]}"
  printf 'BUNDLE_FD_OPEN=%s\n' "$bundle_open"
  printf 'RESTORE_FD_OPEN=%s\n' "$restore_open"
  printf 'RUN_FD_OPEN=%s\n' "$run_open"
  printf 'COMMANDS_FD_OPEN=%s\n' "$commands_open"
  printf 'LEASE_PIPE_OPEN=%s\n' "$lease_pipe_open"
} > "$ready_file"

trap '' TERM
while :; do
  printf '%s\n' "$tag" >> "$counter_file"
  sleep 0.02
done
