# common.sh - shared helpers for diagnose.sh and its test suite.
# This file is meant to be *sourced*, not executed.
#
# Conventions:
#   - No eval anywhere. Commands are executed as "$@" arrays.
#   - All paths are quoted. Numeric inputs are validated with diag_is_uint.
#   - Setting writes go through diag_sysfs_write. The library never enables
#     sudo itself; privileged entrypoints must already be running as root.

# ---------------------------------------------------------------------------
# Output / logging
# ---------------------------------------------------------------------------

# DIAG_LOG_FILE, if set, receives a copy of every log line.
: "${DIAG_LOG_FILE:=}"
: "${DIAG_BUNDLE_ROOT:=}"
: "${DIAG_REPO_ROOT:=}"

diag_redact_log_text() {
  local text="$1"
  if [[ -n "$DIAG_BUNDLE_ROOT" ]]; then text="${text//"$DIAG_BUNDLE_ROOT"/<bundle>}"; fi
  if [[ -n "$DIAG_REPO_ROOT" ]]; then text="${text//"$DIAG_REPO_ROOT"/<repo>}"; fi
  if [[ -n "${HOME:-}" ]]; then text="${text//"$HOME"/~}"; fi
  printf '%s\n' "$text"
}

diag_log() {
  local msg
  msg="[$(date '+%H:%M:%S')] $(diag_redact_log_text "$*")"
  printf '%s\n' "$msg"
  if [[ -n "$DIAG_LOG_FILE" ]]; then
    printf '%s\n' "$msg" >> "$DIAG_LOG_FILE"
  fi
}

diag_warn() {
  diag_log "WARNING: $*" >&2
}

diag_err() {
  diag_log "ERROR: $*" >&2
}

diag_die() {
  diag_err "$*"
  exit 1
}

# Append a command line to the exact command log, shell-quoted.
diag_log_cmd() {
  [[ -n "${DIAG_COMMANDS_LOG:-}" ]] || return 0
  printf '+ ' >> "$DIAG_COMMANDS_LOG"
  local arg
  for arg in "$@"; do
    printf '%q ' "$(diag_redact_log_text "$arg")" >> "$DIAG_COMMANDS_LOG"
  done
  printf '\n' >> "$DIAG_COMMANDS_LOG"
}

# Log and execute a command (no eval; arguments stay separate).
diag_run() {
  diag_log_cmd "$@"
  "$@"
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

diag_is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

diag_require_uint() {
  local name="$1" value="$2"
  diag_is_uint "$value" || diag_die "$name must be a non-negative integer, got '$value'"
}

diag_canonical_dir() {
  local dir="$1"
  (cd -- "$dir" && pwd -P)
}

# ---------------------------------------------------------------------------
# CPU list handling ("0-3,8,10-11" <-> individual ids)
# ---------------------------------------------------------------------------

# Expand a kernel-style CPU list to individual ids, one per line.
diag_cpulist_expand() {
  local list="$1" part lo hi i
  local -a out=()
  IFS=',' read -ra parts <<< "$list"
  for part in "${parts[@]}"; do
    [[ -z "$part" ]] && continue
    if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      lo="${BASH_REMATCH[1]}"
      hi="${BASH_REMATCH[2]}"
      for ((i = lo; i <= hi; i++)); do
        out+=("$i")
      done
    elif [[ "$part" =~ ^[0-9]+$ ]]; then
      out+=("$part")
    else
      diag_die "cannot parse CPU list element '$part' in '$list'"
    fi
  done
  printf '%s\n' "${out[@]}"
}

# Compress a sorted list of ids (one per line) back to kernel range form.
diag_cpulist_compress() {
  local -a cpus=()
  local c
  while read -r c; do
    [[ -n "$c" ]] && cpus+=("$c")
  done
  ((${#cpus[@]} > 0)) || return 0
  local start="${cpus[0]}" prev="${cpus[0]}" first=1
  local emit_range
  emit_range() {
    if ((first == 0)); then printf ','; fi
    first=0
    if [[ "$1" == "$2" ]]; then
      printf '%s' "$1"
    else
      printf '%s-%s' "$1" "$2"
    fi
  }
  local i
  for ((i = 1; i < ${#cpus[@]}; i++)); do
    c="${cpus[$i]}"
    if ((c == prev + 1)); then
      prev="$c"
      continue
    fi
    emit_range "$start" "$prev"
    start="$c"
    prev="$c"
  done
  emit_range "$start" "$prev"
  printf '\n'
}

diag_cpulist_count() {
  diag_cpulist_expand "$1" | wc -l
}

diag_cpulist_intersect() {
  local left="$1" right="$2" cpu
  declare -A permitted=()
  while read -r cpu; do
    [[ -n "$cpu" ]] && permitted[$cpu]=1
  done < <(diag_cpulist_expand "$right")
  local -a overlap=()
  while read -r cpu; do
    [[ -n "${permitted[$cpu]:-}" ]] && overlap+=("$cpu")
  done < <(diag_cpulist_expand "$left")
  printf '%s\n' "${overlap[@]}" | sort -n -u | diag_cpulist_compress
}

diag_cpulist_contains() {
  local list="$1" wanted="$2" cpu
  while read -r cpu; do
    [[ "$cpu" == "$wanted" ]] && return 0
  done < <(diag_cpulist_expand "$list")
  return 1
}

# ---------------------------------------------------------------------------
# Privilege handling
# ---------------------------------------------------------------------------
# No function in this library ever elevates privileges by itself.
# DIAG_SUDO is only used for writes in scripts that the user has chosen to
# run with sudo already (EUID 0 -> DIAG_SUDO empty -> direct writes), or in
# tests (DIAG_SUDO="" against fixture paths). Interactive scripts that need
# root check EUID themselves and tell the user to re-run them with sudo.

if [[ -z "${DIAG_SUDO+x}" ]]; then
  DIAG_SUDO=""
fi

# Write a value to a (typically sysfs) file. Prefers a direct write; uses
# sudo tee only when the file is not writable and the caller arranged sudo.
# No passwords on command lines, ever.
diag_sysfs_write() {
  local path="$1" value="$2"
  diag_log_cmd write "$path" "$value"
  if [[ -w "$path" ]]; then
    printf '%s\n' "$value" > "$path"
  elif [[ -n "$DIAG_SUDO" ]]; then
    printf '%s\n' "$value" | "$DIAG_SUDO" tee "$path" > /dev/null
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Runtime-settings restore (frequency phase safety net)
# ---------------------------------------------------------------------------
# Saved settings live in a private state file with one "path<TAB>value" pair
# per line, so restoration works even after SIGKILL of a parent shell cannot
# be handled. Privileged callers must put that file in a root-owned directory,
# hold a per-user experiment lock, and configure an explicit restore allowlist.
# Every restore validates the exact in-memory snapshot before its first write.

: "${DIAG_RESTORE_FILE:=}"
DIAG_RESTORE_ARMED=0
declare -a DIAG_RESTORE_RULES=()
DIAG_RESTORE_LOCK_FILE=""
DIAG_RESTORE_LOCK_TOKEN=""

diag_restore_private_dir_prepare() {
  # usage: diag_restore_private_dir_prepare <dir> <owner-uid> <owner-gid>
  local dir="$1" owner_uid="$2" owner_gid="$3"
  diag_is_uint "$owner_uid" && diag_is_uint "$owner_gid" || return 1
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    mkdir -m 0700 -- "$dir" || return 1
  fi
  [[ -d "$dir" && ! -L "$dir" ]] || return 1
  [[ "$(stat -Lc '%u:%g:%a' -- "$dir" 2> /dev/null)" == "$owner_uid:$owner_gid:700" ]]
}

diag_restore_private_file_is_safe() {
  # usage: diag_restore_private_file_is_safe <file> <owner-uid> <owner-gid>
  local file="$1" owner_uid="$2" owner_gid="$3"
  diag_is_uint "$owner_uid" && diag_is_uint "$owner_gid" || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$file" 2> /dev/null)" == "$owner_uid:$owner_gid:600:1" ]]
}

diag_restore_private_file_prepare() {
  # Parent directories must already be private and trusted.
  local file="$1" owner_uid="$2" owner_gid="$3"
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    (umask 077; : > "$file") || return 1
  fi
  diag_restore_private_file_is_safe "$file" "$owner_uid" "$owner_gid"
}

diag_process_start_ticks() {
  local pid="$1" stat_line rest ticks
  local -a fields=()
  diag_is_uint "$pid" || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  read -ra fields <<< "$rest"
  ((${#fields[@]} >= 20)) || return 1
  ticks="${fields[19]}"
  diag_is_uint "$ticks" || return 1
  printf '%s\n' "$ticks"
}

diag_restore_lock_owner_is_live() {
  local lock_file="$1" pid ticks extra current_ticks
  # Status: 0 live owner, 1 valid but dead/reused owner, 2 malformed record.
  IFS=' ' read -r pid ticks extra < "$lock_file" || return 2
  diag_is_uint "$pid" && diag_is_uint "$ticks" && [[ -z "$extra" ]] || return 2
  current_ticks="$(diag_process_start_ticks "$pid")" || return 1
  [[ "$current_ticks" == "$ticks" ]]
}

diag_restore_lock_acquire() {
  # The short-lived flock serializes stale-lock recovery. The durable active
  # record contains this shell's PID and process start time; unlike an open FD,
  # it is not inherited by workload children and can be reclaimed after
  # SIGKILL without weakening live-run concurrency refusal.
  local lock_file="$1" owner_uid="$2" owner_gid="$3"
  [[ -z "$DIAG_RESTORE_LOCK_FILE" ]] || return 1
  local guard_file="${lock_file}.guard" guard_fd="" tmp="" start_ticks
  local owner_pid="$BASHPID"
  diag_restore_private_file_prepare "$guard_file" "$owner_uid" "$owner_gid" || return 1
  exec {guard_fd}>> "$guard_file" || return 1
  if ! flock -n "$guard_fd"; then
    exec {guard_fd}>&-
    diag_warn "another restore-lock operation is in progress; refusing to race it"
    return 1
  fi

  if [[ -e "$lock_file" || -L "$lock_file" ]]; then
    if ! diag_restore_private_file_is_safe "$lock_file" "$owner_uid" "$owner_gid"; then
      exec {guard_fd}>&-
      diag_warn "restore lock has unsafe ownership, mode, type, or link count"
      return 1
    fi
    local owner_status=0
    diag_restore_lock_owner_is_live "$lock_file" || owner_status=$?
    case "$owner_status" in
      0)
        exec {guard_fd}>&-
        diag_warn "another frequency experiment is already active for this invoking user"
        return 1
        ;;
      1) ;; # stale PID/start-time pair; reclaim below
      *)
        exec {guard_fd}>&-
        diag_warn "restore lock owner record is malformed; refusing recovery"
        return 1
        ;;
    esac
    rm -f -- "$lock_file" || {
      exec {guard_fd}>&-
      return 1
    }
  fi

  start_ticks="$(diag_process_start_ticks "$owner_pid")" || {
    exec {guard_fd}>&-
    return 1
  }
  tmp="$(mktemp "${lock_file}.tmp.XXXXXX")" || {
    exec {guard_fd}>&-
    return 1
  }
  chmod 0600 "$tmp" || {
    rm -f -- "$tmp"
    exec {guard_fd}>&-
    return 1
  }
  printf '%s %s\n' "$owner_pid" "$start_ticks" > "$tmp" || {
    rm -f -- "$tmp"
    exec {guard_fd}>&-
    return 1
  }
  if ! mv -fT -- "$tmp" "$lock_file"; then
    rm -f -- "$tmp"
    exec {guard_fd}>&-
    return 1
  fi
  if ! diag_restore_private_file_is_safe "$lock_file" "$owner_uid" "$owner_gid"; then
    rm -f -- "$lock_file"
    exec {guard_fd}>&-
    return 1
  fi
  DIAG_RESTORE_LOCK_FILE="$lock_file"
  DIAG_RESTORE_LOCK_TOKEN="$owner_pid $start_ticks"
  exec {guard_fd}>&-
}

diag_restore_lock_release() {
  [[ -n "$DIAG_RESTORE_LOCK_FILE" ]] || return 0
  local actual=""
  if [[ -f "$DIAG_RESTORE_LOCK_FILE" && ! -L "$DIAG_RESTORE_LOCK_FILE" ]]; then
    IFS= read -r actual < "$DIAG_RESTORE_LOCK_FILE" || true
  fi
  if [[ "$actual" != "$DIAG_RESTORE_LOCK_TOKEN" ]]; then
    diag_warn "restore lock ownership changed; refusing to remove it"
    return 1
  fi
  rm -f -- "$DIAG_RESTORE_LOCK_FILE" || return 1
  DIAG_RESTORE_LOCK_FILE=""
  DIAG_RESTORE_LOCK_TOKEN=""
}

diag_restore_rules_set() {
  (($# > 0 && $# % 2 == 0)) || return 1
  local -a rules=("$@")
  local i
  for ((i = 0; i < ${#rules[@]}; i += 2)); do
    [[ -n "${rules[$i]}" && -n "${rules[$((i + 1))]}" ]] || return 1
  done
  DIAG_RESTORE_RULES=("${rules[@]}")
}

diag_restore_entries_are_valid() {
  # usage: diag_restore_entries_are_valid <array-name> <allowed-path> <value-regex> ...
  local entries_name="$1"
  shift
  (($# > 0 && $# % 2 == 0)) || return 1
  local -a rules=("$@")
  local -n entries_ref="$entries_name"
  ((${#entries_ref[@]} > 0)) || return 1

  local line path value allowed pattern matched
  declare -A seen=()
  local i rule_i
  for ((i = 0; i < ${#entries_ref[@]}; i++)); do
    line="${entries_ref[$i]}"
    [[ "$line" == *$'\t'* ]] || return 1
    path="${line%%$'\t'*}"
    value="${line#*$'\t'}"
    [[ -n "$path" && -n "$value" && "$value" != *$'\t'* && -z "${seen[$path]:-}" ]] || return 1
    seen[$path]=1
    matched=0
    for ((rule_i = 0; rule_i < ${#rules[@]}; rule_i += 2)); do
      allowed="${rules[$rule_i]}"
      pattern="${rules[$((rule_i + 1))]}"
      if [[ "$path" == "$allowed" && "$value" =~ $pattern ]]; then
        matched=1
        break
      fi
    done
    ((matched == 1)) || return 1
  done
}

diag_restore_save() {
  # usage: diag_restore_save <path>   -- records current value for restore
  local path="$1"
  [[ -n "$DIAG_RESTORE_FILE" ]] || diag_die "DIAG_RESTORE_FILE is not set"
  ((${#DIAG_RESTORE_RULES[@]} > 0)) || diag_die "restore allowlist is not configured"
  [[ ! -L "$DIAG_RESTORE_FILE" && ( ! -e "$DIAG_RESTORE_FILE" || -f "$DIAG_RESTORE_FILE" ) ]] ||
    diag_die "restore ledger is not a safe regular file"
  [[ -r "$path" ]] || diag_die "cannot read $path to save it"
  local value
  value="$(cat "$path")"
  local -a candidate=()
  if [[ -s "$DIAG_RESTORE_FILE" ]]; then
    mapfile -t candidate < "$DIAG_RESTORE_FILE" || diag_die "cannot read restore ledger"
  fi
  candidate+=("$path"$'\t'"$value")
  diag_restore_entries_are_valid candidate "${DIAG_RESTORE_RULES[@]}" ||
    diag_die "refusing to save a non-allowlisted or malformed restore entry"
  printf '%s\t%s\n' "$path" "$value" >> "$DIAG_RESTORE_FILE"
  DIAG_RESTORE_ARMED=1
}

diag_restore_now() {
  # Restore in reverse save order, but only remove entries whose writes can be
  # read back exactly. A failed restore remains durable for the next recovery
  # attempt instead of being silently discarded.
  # A nonempty path alone is never authority to restore: callers must arm the
  # ledger, and this function validates its own immutable snapshot before any
  # write rather than trusting an earlier check of a mutable file.
  ((DIAG_RESTORE_ARMED == 1)) || return 0
  ((${#DIAG_RESTORE_RULES[@]} > 0)) || {
    diag_warn "restore allowlist is not configured; refusing restore"
    return 1
  }
  [[ -n "$DIAG_RESTORE_FILE" && -s "$DIAG_RESTORE_FILE" && -f "$DIAG_RESTORE_FILE" && ! -L "$DIAG_RESTORE_FILE" ]] || {
    diag_warn "armed restore ledger is missing, empty, or unsafe"
    return 1
  }

  local -a entries=() failed=()
  mapfile -t entries < "$DIAG_RESTORE_FILE" || {
    diag_warn "could not read armed restore ledger"
    return 1
  }
  if ! diag_restore_entries_are_valid entries "${DIAG_RESTORE_RULES[@]}"; then
    diag_warn "restore ledger snapshot is malformed or outside the trusted allowlist"
    return 1
  fi
  local i line path value actual
  local restore_failed=0
  for ((i = ${#entries[@]} - 1; i >= 0; i--)); do
    line="${entries[$i]}"
    IFS=$'\t' read -r path value <<< "$line"
    [[ -n "$path" ]] || continue
    diag_log "restoring $path <- $value"
    if ! diag_sysfs_write "$path" "$value"; then
      diag_warn "failed to restore $path (write failed; recovery entry retained)"
      failed[$i]="$line"
      restore_failed=1
      continue
    fi
    actual="$(cat "$path" 2> /dev/null || true)"
    if [[ "$actual" != "$value" ]]; then
      diag_warn "failed to verify restore of $path (read '$actual'; recovery entry retained)"
      failed[$i]="$line"
      restore_failed=1
    fi
  done

  local tmp
  if ! tmp="$(mktemp "${DIAG_RESTORE_FILE}.tmp.XXXXXX")"; then
    DIAG_RESTORE_ARMED=1
    diag_warn "could not update restore ledger; all recovery entries retained"
    return 1
  fi
  for ((i = 0; i < ${#entries[@]}; i++)); do
    [[ -n "${failed[$i]:-}" ]] && printf '%s\n' "${failed[$i]}" >> "$tmp"
  done
  if ! mv -- "$tmp" "$DIAG_RESTORE_FILE"; then
    rm -f -- "$tmp"
    DIAG_RESTORE_ARMED=1
    diag_warn "could not replace restore ledger; all recovery entries retained"
    return 1
  fi

  if ((restore_failed == 1)); then
    DIAG_RESTORE_ARMED=1
    return 1
  fi
  DIAG_RESTORE_ARMED=0
}

diag_recover_pending_restore() {
  [[ -n "$DIAG_RESTORE_FILE" && -s "$DIAG_RESTORE_FILE" ]] || return 0
  DIAG_RESTORE_ARMED=1
  diag_warn "pending settings restore detected; recovering it before starting new work"
  if ! diag_restore_now; then
    diag_warn "pending settings restore could not be completed; ledger retained at $DIAG_RESTORE_FILE"
    return 1
  fi
  diag_log "pending settings restore completed and verified"
}

diag_restore_ledger_is_valid() {
  # usage: diag_restore_ledger_is_valid <ledger> <allowed-path> <value-regex> ...
  local ledger="$1"
  shift
  (($# > 0 && $# % 2 == 0)) || return 1
  [[ -f "$ledger" && ! -L "$ledger" ]] || return 1
  [[ -s "$ledger" ]] || return 0
  local -a entries=()
  mapfile -t entries < "$ledger" || return 1
  diag_restore_entries_are_valid entries "$@"
}

diag_require_not_symlink() {
  local path
  for path in "$@"; do
    [[ ! -L "$path" ]] || diag_die "refusing privileged write through symlink: $path"
  done
}

diag_cleanup_now() {
  # A workload and sampler may still be using a setting we are about to
  # restore. Stop and reap both first, then perform the verified restore.
  diag_workload_stop
  diag_freq_sampler_stop
  diag_restore_now
}

# Privileged callers may override this to hand staged artifacts to an
# unprivileged publisher after workloads stop and settings are restored.
diag_cleanup_artifacts() {
  return 0
}

diag_cleanup_exit() {
  local rc="$1" cleanup_rc=0 artifact_rc=0
  trap - EXIT INT TERM
  if diag_cleanup_now; then
    :
  else
    cleanup_rc=$?
  fi
  diag_cleanup_artifacts || artifact_rc=$?
  if ((artifact_rc != 0)); then
    if ((cleanup_rc == 0 && artifact_rc == 75)); then
      cleanup_rc=75
    else
      cleanup_rc=1
    fi
  fi
  if ! diag_restore_lock_release; then
    cleanup_rc=1
  fi
  ((rc == 0 && cleanup_rc != 0)) && rc=$cleanup_rc
  exit "$rc"
}

diag_cleanup_signal() {
  local name="$1" rc="$2"
  trap - EXIT INT TERM
  diag_warn "received $name"
  diag_cleanup_now || true
  diag_cleanup_artifacts || true
  diag_restore_lock_release || true
  exit "$rc"
}

diag_register_cleanup_traps() {
  trap 'diag_cleanup_exit $?' EXIT
  trap 'diag_cleanup_signal SIGINT 130' INT
  trap 'diag_cleanup_signal SIGTERM 143' TERM
}

diag_register_restore_trap() {
  # Backward-compatible name for callers/tests that only save restore state.
  diag_register_cleanup_traps
}

# ---------------------------------------------------------------------------
# Frequency sampling
# ---------------------------------------------------------------------------
# Prefers turbostat when available and permitted; falls back to per-CPU
# scaling_cur_freq polling. Samples are appended as "epoch cpu khz" lines
# (sysfs) or kept raw (turbostat per-CPU rows) under
# $DIAG_FREQ_DIR/<tag>.samples.
# Sample method is recorded in $DIAG_FREQ_DIR/<tag>.method.

: "${DIAG_FREQ_DIR:=.}"
DIAG_SAMPLER_PID=""
DIAG_WORKLOAD_PID=""
: "${DIAG_OPERATIONAL_ERROR_RC:=125}"

diag_process_group_start() {
  # Start one externally managed command in a private session. In these
  # non-interactive scripts the background child is not already a process-
  # group leader, so setsid preserves its PID as the new process-group ID.
  [[ -z "$DIAG_WORKLOAD_PID" ]] || {
    diag_warn "refusing to replace tracked process group $DIAG_WORKLOAD_PID"
    return "$DIAG_OPERATIONAL_ERROR_RC"
  }
  setsid "$@" &
  DIAG_WORKLOAD_PID=$!
}

diag_process_group_wait() {
  [[ -n "$DIAG_WORKLOAD_PID" ]] || return "$DIAG_OPERATIONAL_ERROR_RC"
  local pid="$DIAG_WORKLOAD_PID" rc=0 i
  wait "$pid" || rc=$?
  # A wrapper can exit after its direct command ends while a descendant is
  # still alive in the private group (notably an inferior launched by a
  # foreground timeout). Do not discard the only handle to that descendant.
  if kill -0 -- "-$pid" 2> /dev/null; then
    diag_warn "tracked process leader exited with descendants still running; stopping them"
    kill -TERM -- "-$pid" 2> /dev/null || true
    for ((i = 0; i < 40; i++)); do
      kill -0 -- "-$pid" 2> /dev/null || break
      sleep 0.05
    done
    if kill -0 -- "-$pid" 2> /dev/null; then
      diag_warn "tracked descendants did not stop after SIGTERM; sending SIGKILL"
      kill -KILL -- "-$pid" 2> /dev/null || true
    fi
  fi
  # A signal trap may already have stopped and cleared this group.
  [[ "$DIAG_WORKLOAD_PID" != "$pid" ]] || DIAG_WORKLOAD_PID=""
  return "$rc"
}

diag_process_group_stop() {
  [[ -n "$DIAG_WORKLOAD_PID" ]] || return 0
  local pid="$DIAG_WORKLOAD_PID" watchdog
  # Signal the entire pipeline/process tree. Reap the leader concurrently
  # with the bounded watchdog: polling only the leader mistakes a zombie for
  # a live workload and cannot detect descendants left behind by an exited
  # leader.
  kill -TERM -- "-$pid" 2> /dev/null || kill -TERM "$pid" 2> /dev/null || true
  (
    local i
    for ((i = 0; i < 40; i++)); do
      kill -0 -- "-$pid" 2> /dev/null || exit 0
      sleep 0.05
    done
    diag_warn "workload process group did not stop after SIGTERM; sending SIGKILL"
    kill -KILL -- "-$pid" 2> /dev/null || kill -KILL "$pid" 2> /dev/null || true
  ) &
  watchdog=$!
  wait "$pid" 2> /dev/null || true
  wait "$watchdog" 2> /dev/null || true
  # Close the race where the leader exited just as a descendant was forked.
  kill -KILL -- "-$pid" 2> /dev/null || true
  DIAG_WORKLOAD_PID=""
}

diag_workload_stop() {
  # Backward-compatible name retained for cleanup callers and fixtures.
  diag_process_group_stop
}

diag_turbostat_usable() {
  command -v turbostat > /dev/null 2>&1 || return 1
  # turbostat needs MSR access, i.e. root. No sudo attempt here: scripts
  # that want turbostat are expected to be run with sudo by the user.
  ((EUID == 0))
}

diag_freq_sampler_start() {
  local tag="$1"
  local samples="$DIAG_FREQ_DIR/${tag}.samples"
  : > "$samples"
  if diag_turbostat_usable; then
    printf 'turbostat\n' > "$DIAG_FREQ_DIR/${tag}.method"
    turbostat --quiet --interval 1 >> "$samples" 2> /dev/null &
    DIAG_SAMPLER_PID=$!
  else
    printf 'scaling_cur_freq\n' > "$DIAG_FREQ_DIR/${tag}.method"
    (
      while :; do
        now="$(date +%s)"
        for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq; do
          [[ -r "$f" ]] || continue
          cpu="${f%/cpufreq/scaling_cur_freq}"
          cpu="${cpu##*/cpu}"
          printf '%s %s %s\n' "$now" "$cpu" "$(cat "$f")"
        done
        sleep 1
      done
    ) >> "$samples" 2> /dev/null &
    DIAG_SAMPLER_PID=$!
  fi
}

diag_freq_sampler_stop() {
  if [[ -n "$DIAG_SAMPLER_PID" ]]; then
    kill "$DIAG_SAMPLER_PID" 2> /dev/null || true
    local i
    for ((i = 0; i < 20; i++)); do
      kill -0 "$DIAG_SAMPLER_PID" 2> /dev/null || break
      sleep 0.05
    done
    # Do not let an uncooperative sampler indefinitely block restoration.
    if kill -0 "$DIAG_SAMPLER_PID" 2> /dev/null; then
      diag_warn "frequency sampler did not stop after SIGTERM; sending SIGKILL"
      kill -KILL "$DIAG_SAMPLER_PID" 2> /dev/null || true
    fi
    wait "$DIAG_SAMPLER_PID" 2> /dev/null || true
    DIAG_SAMPLER_PID=""
  fi
}

# Run single-child workload legs on one pinned CPU, appending
# "leg<TAB>run<TAB>rc<TAB>elapsed" rows. Optional command prefix (e.g.
# "runuser -u user --") runs the workload as another user.
# Callers must tolerate nonzero child exits (handled here).
diag_run_single_runs() {
  # usage: diag_run_single_runs <tsv> <leg> <cpu> <runs> [cmd-prefix...]
  local tsv="$1" leg="$2" cpu="$3" runs="$4"
  shift 4
  local i rc start elapsed
  diag_freq_sampler_start "freq-ab-${leg}"
  for ((i = 1; i <= runs; i++)); do
    start=$SECONDS
    if ! diag_process_group_start "$@" taskset -c "$cpu" node child.mjs > /dev/null 2>&1; then
      rc="$DIAG_OPERATIONAL_ERROR_RC"
    elif diag_process_group_wait; then
      rc=0
    else
      rc=$?
    fi
    elapsed=$((SECONDS - start))
    printf '%s\t%s\t%s\t%s\n' "$leg" "$i" "$rc" "$elapsed" >> "$tsv"
    if ((rc != 0)); then
      diag_log "  leg $leg run $i/$runs: FAIL rc=$rc"
    elif ((i % 5 == 0)); then
      diag_log "  leg $leg run $i/$runs: ok"
    fi
  done
  diag_freq_sampler_stop
}

diag_frequency_rows_are_complete() {
  local tsv="$1" runs="$2"
  diag_is_uint "$runs" && ((runs >= 1)) || return 1
  [[ -f "$tsv" ]] || return 1
  awk -F'\t' -v runs="$runs" '
    BEGIN { valid=1 }
    {
      if (NF != 4 || ($1 != "A1" && $1 != "B" && $1 != "A2") ||
          $2 !~ /^[1-9][0-9]*$/ || $2 < 1 || $2 > runs ||
          ($3 != 0 && $3 != 139) || $4 !~ /^(0|[1-9][0-9]*)$/) {
        valid=0
        next
      }
      key=$1 SUBSEP $2
      if (seen[key]++) valid=0
      count[$1]++
    }
    END {
      exit (valid && count["A1"] == runs && count["B"] == runs && count["A2"] == runs) ? 0 : 1
    }
  ' "$tsv"
}

diag_frequency_cap_rows_are_complete() {
  local tsv="$1" runs="$2"
  diag_is_uint "$runs" && ((runs >= 1)) || return 1
  [[ -f "$tsv" ]] || return 1
  awk -F'\t' -v runs="$runs" '
    BEGIN { valid=1 }
    {
      if (NF != 4 || $1 != "cap" ||
          $2 !~ /^[1-9][0-9]*$/ || $2 < 1 || $2 > runs ||
          ($3 != 0 && $3 != 139) || $4 !~ /^(0|[1-9][0-9]*)$/) {
        valid=0
        next
      }
      if (seen[$2]++) valid=0
      count++
    }
    END { exit (valid && count == runs) ? 0 : 1 }
  ' "$tsv"
}
