#!/usr/bin/env bash
# Keep one private process group tied to the exact lifetime of its caller.
#
# The normal role is an exec wrapper. It arms a detached watchdog before it
# execs the payload, so the wrapper PID remains the payload PID, process-group
# ID, and session ID. The watchdog owns only the read end of an anonymous pipe;
# the payload and its descendants inherit the write end as a generation lease.
set -u

SUPERVISION_ERROR_RC=125

supervision_is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

supervision_proc_read() {
  local pid="$1" stat_line rest
  local -a fields=()
  supervision_is_uint "$pid" || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  read -ra fields <<< "$rest"
  ((${#fields[@]} >= 20)) || return 1
  supervision_is_uint "${fields[2]}" &&
    supervision_is_uint "${fields[3]}" &&
    supervision_is_uint "${fields[19]}" || return 1
  SUPERVISION_PROC_STATE="${fields[0]}"
  SUPERVISION_PROC_PGRP="${fields[2]}"
  SUPERVISION_PROC_SESSION="${fields[3]}"
  SUPERVISION_PROC_START="${fields[19]}"
}

supervision_identity_matches() {
  local pid="$1" expected_start="$2"
  supervision_proc_read "$pid" || return 1
  [[ "$SUPERVISION_PROC_START" == "$expected_start" ]]
}

supervision_identity_is_live() {
  supervision_identity_matches "$1" "$2" || return 1
  case "$SUPERVISION_PROC_STATE" in Z | X | x) return 1 ;; esac
}

supervision_fd_is_safe() {
  supervision_is_uint "$1" && ((3 <= 10#$1))
}

supervision_fd_close() {
  local close_fd="$1"
  supervision_fd_is_safe "$close_fd" || return 1
  [[ -e "/proc/$BASHPID/fd/$close_fd" ]] || return 1
  exec {close_fd}>&-
}

supervision_lease_poll() {
  local ignored="" rc=0
  if ((SUPERVISION_LEASE_OPEN == 1)); then
    IFS= read -r -t 0.05 ignored || rc=$?
    # Bash returns 1 for EOF and a status greater than 128 for a timeout.
    ((rc != 1)) || SUPERVISION_LEASE_OPEN=0
  fi
  # EOF is immediate. Keep every watch/termination loop bounded even when a
  # payload deliberately closes all descriptors other than stdio.
  ((SUPERVISION_LEASE_OPEN == 1)) || /bin/sleep 0.05
}

supervision_group_terminate() {
  local target_pid="$1" target_start="$2" i

  # An exact leader identity binds the group even if the leader is a zombie.
  # If it was already reaped, an open generation lease means that a descendant
  # from this exact launch still exists. Fixed diagnostic payloads do not
  # daemonize into another session.
  if ! supervision_identity_matches "$target_pid" "$target_start" &&
    ((SUPERVISION_LEASE_OPEN == 0)); then
    return 0
  fi

  kill -TERM -- "-$target_pid" 2> /dev/null || true
  for ((i = 0; i < 40; i++)); do
    supervision_lease_poll
    if ((SUPERVISION_LEASE_OPEN == 0)) &&
      ! supervision_identity_is_live "$target_pid" "$target_start"; then
      return 0
    fi
    kill -0 -- "-$target_pid" 2> /dev/null || return 0
  done

  kill -KILL -- "-$target_pid" 2> /dev/null || true
  # Repeated checks cover a descendant fork racing the first group signal.
  # An uninterruptible task may retain the lease and inherited writer lock;
  # that lock deliberately keeps every recovery invocation fenced out.
  for ((i = 0; i < 20; i++)); do
    supervision_lease_poll
    ((SUPERVISION_LEASE_OPEN == 1)) || return 0
    kill -KILL -- "-$target_pid" 2> /dev/null || true
  done
}

supervision_watch() {
  (($# == 4)) || exit "$SUPERVISION_ERROR_RC"
  local parent_pid="$1" parent_start="$2" target_pid="$3" target_start="$4"
  supervision_is_uint "$parent_pid" && supervision_is_uint "$parent_start" &&
    supervision_is_uint "$target_pid" && supervision_is_uint "$target_start" ||
    exit "$SUPERVISION_ERROR_RC"

  supervision_proc_read "$BASHPID" || exit "$SUPERVISION_ERROR_RC"
  [[ "$SUPERVISION_PROC_PGRP" == "$BASHPID" &&
    "$SUPERVISION_PROC_SESSION" == "$BASHPID" &&
    "$BASHPID" != "$target_pid" ]] || exit "$SUPERVISION_ERROR_RC"
  supervision_identity_is_live "$parent_pid" "$parent_start" ||
    exit "$SUPERVISION_ERROR_RC"
  supervision_identity_is_live "$target_pid" "$target_start" ||
    exit "$SUPERVISION_ERROR_RC"

  printf 'READY\n' || exit "$SUPERVISION_ERROR_RC"
  exec > /dev/null 2>&1
  SUPERVISION_LEASE_OPEN=1

  while :; do
    supervision_lease_poll
    if ! supervision_identity_is_live "$parent_pid" "$parent_start"; then
      supervision_group_terminate "$target_pid" "$target_start"
      exit 0
    fi
    if ! supervision_identity_is_live "$target_pid" "$target_start"; then
      ((SUPERVISION_LEASE_OPEN == 0)) ||
        supervision_group_terminate "$target_pid" "$target_start"
      exit 0
    fi
  done
}

supervision_wrapper() {
  local parent_pid="" parent_start="" helper_path="${BASH_SOURCE[0]}"
  local -a watchdog_close_fds=() payload_close_fds=() payload=()
  while (($#)); do
    case "$1" in
      --parent)
        (($# >= 3)) || return "$SUPERVISION_ERROR_RC"
        parent_pid="$2"
        parent_start="$3"
        shift 3
        ;;
      --watchdog-close-fd)
        (($# >= 2)) || return "$SUPERVISION_ERROR_RC"
        watchdog_close_fds+=("$2")
        shift 2
        ;;
      --payload-close-fd)
        (($# >= 2)) || return "$SUPERVISION_ERROR_RC"
        payload_close_fds+=("$2")
        shift 2
        ;;
      --)
        shift
        payload=("$@")
        break
        ;;
      *) return "$SUPERVISION_ERROR_RC" ;;
    esac
  done
  supervision_is_uint "$parent_pid" && supervision_is_uint "$parent_start" &&
    ((${#payload[@]} > 0)) || return "$SUPERVISION_ERROR_RC"

  local target_pid="$BASHPID" target_start
  supervision_proc_read "$target_pid" || return "$SUPERVISION_ERROR_RC"
  target_start="$SUPERVISION_PROC_START"
  [[ "$SUPERVISION_PROC_STATE" != Z && "$SUPERVISION_PROC_STATE" != X &&
    "$SUPERVISION_PROC_STATE" != x &&
    "$SUPERVISION_PROC_PGRP" == "$target_pid" &&
    "$SUPERVISION_PROC_SESSION" == "$target_pid" ]] ||
    return "$SUPERVISION_ERROR_RC"

  local fd
  for fd in "${watchdog_close_fds[@]}" "${payload_close_fds[@]}"; do
    supervision_fd_is_safe "$fd" || return "$SUPERVISION_ERROR_RC"
    [[ -e "/proc/$BASHPID/fd/$fd" ]] || return "$SUPERVISION_ERROR_RC"
  done

  coproc DIAG_SUPERVISION_GUARD {
    local close_fd
    for close_fd in "${watchdog_close_fds[@]}"; do
      supervision_fd_close "$close_fd" || exit "$SUPERVISION_ERROR_RC"
    done
    exec setsid /bin/bash "$helper_path" --watch \
      "$parent_pid" "$parent_start" "$target_pid" "$target_start"
  }
  local guard_read_fd="${DIAG_SUPERVISION_GUARD[0]}"
  local guard_write_fd="${DIAG_SUPERVISION_GUARD[1]}"
  local guard_pid="$DIAG_SUPERVISION_GUARD_PID" lease_fd="" ready=""

  # Bash marks coprocess-derived duplicates to be closed at exec. Reopening
  # the pipe through procfs creates an ordinary inherited descriptor instead.
  if ! exec {lease_fd}> "/proc/self/fd/$guard_write_fd"; then
    { exec {guard_read_fd}<&-; } 2> /dev/null || true
    { exec {guard_write_fd}>&-; } 2> /dev/null || true
    wait "$guard_pid" 2> /dev/null || true
    return "$SUPERVISION_ERROR_RC"
  fi
  { exec {guard_write_fd}>&-; } 2> /dev/null || true
  if ! IFS= read -r ready <&"$guard_read_fd" || [[ "$ready" != READY ]]; then
    { exec {guard_read_fd}<&-; } 2> /dev/null || true
    { exec {lease_fd}>&-; } 2> /dev/null || true
    wait "$guard_pid" 2> /dev/null || true
    return "$SUPERVISION_ERROR_RC"
  fi
  { exec {guard_read_fd}<&-; } 2> /dev/null || true

  # Close the last arming race: the parent may have died after the watchdog's
  # check but before READY reached this wrapper.
  supervision_identity_is_live "$parent_pid" "$parent_start" || {
    { exec {lease_fd}>&-; } 2> /dev/null || true
    return "$SUPERVISION_ERROR_RC"
  }
  for fd in "${payload_close_fds[@]}"; do
    supervision_fd_close "$fd" || {
      { exec {lease_fd}>&-; } 2> /dev/null || true
      return "$SUPERVISION_ERROR_RC"
    }
  done

  exec "${payload[@]}"
}

if [[ "${1:-}" == --watch ]]; then
  shift
  supervision_watch "$@"
  exit "$?"
fi

supervision_wrapper "$@"
exit "$?"
