# common.sh - shared helpers for diagnose.sh and its test suite.
# This file is meant to be *sourced*, not executed.
#
# Conventions:
#   - No eval anywhere. Commands are executed as "$@" arrays.
#   - All paths are quoted. Numeric inputs are validated with diag_is_uint.
#   - Privileged writes go through diag_sysfs_write, which prefers a direct
#     write and falls back to sudo tee. DIAG_SUDO can be emptied in tests.

# ---------------------------------------------------------------------------
# Output / logging
# ---------------------------------------------------------------------------

# DIAG_LOG_FILE, if set, receives a copy of every log line.
: "${DIAG_LOG_FILE:=}"

diag_log() {
  local msg="[$(date '+%H:%M:%S')] $*"
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
  printf '%q ' "$@" >> "$DIAG_COMMANDS_LOG"
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
  if ((EUID == 0)); then
    DIAG_SUDO=""
  elif command -v sudo > /dev/null 2>&1; then
    DIAG_SUDO="sudo"
  else
    DIAG_SUDO=""
  fi
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
# Saved settings live in a state file with one "path<TAB>value" pair per
# line, so restoration works even after SIGKILL of a parent shell cannot be
# handled -- but for INT/TERM/EXIT we restore from the same file.
# DIAG_RESTORE_FILE must point at the state file.

: "${DIAG_RESTORE_FILE:=}"
DIAG_RESTORE_ARMED=0

diag_restore_save() {
  # usage: diag_restore_save <path>   -- records current value for restore
  local path="$1"
  [[ -n "$DIAG_RESTORE_FILE" ]] || diag_die "DIAG_RESTORE_FILE is not set"
  [[ -r "$path" ]] || diag_die "cannot read $path to save it"
  local value
  value="$(cat "$path")"
  printf '%s\t%s\n' "$path" "$value" >> "$DIAG_RESTORE_FILE"
  DIAG_RESTORE_ARMED=1
}

diag_restore_now() {
  # Restore in reverse save order, but only remove entries whose writes can be
  # read back exactly. A failed restore remains durable for the next recovery
  # attempt instead of being silently discarded.
  [[ -n "$DIAG_RESTORE_FILE" && -s "$DIAG_RESTORE_FILE" ]] || {
    DIAG_RESTORE_ARMED=0
    return 0
  }

  local -a entries=() failed=()
  mapfile -t entries < "$DIAG_RESTORE_FILE"
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

  local path value extra allowed pattern matched
  declare -A seen=()
  while IFS=$'\t' read -r path value extra; do
    [[ -n "$path" && -n "$value" && -z "$extra" && -z "${seen[$path]:-}" ]] || return 1
    seen[$path]=1
    matched=0
    local -a rules=("$@")
    local i
    for ((i = 0; i < ${#rules[@]}; i += 2)); do
      allowed="${rules[$i]}"
      pattern="${rules[$((i + 1))]}"
      if [[ "$path" == "$allowed" && "$value" =~ $pattern ]]; then
        matched=1
        break
      fi
    done
    ((matched == 1)) || return 1
  done < "$ledger"
}

diag_require_not_symlink() {
  local path
  for path in "$@"; do
    [[ ! -L "$path" ]] || diag_die "refusing privileged write through symlink: $path"
  done
}

diag_cleanup_now() {
  # A sampler may still be reading a setting we are about to restore. Stop and
  # reap it first, then perform the verified restore.
  diag_freq_sampler_stop
  diag_restore_now
}

diag_cleanup_exit() {
  local rc="$1" cleanup_rc=0
  trap - EXIT INT TERM
  if diag_cleanup_now; then
    :
  else
    cleanup_rc=$?
  fi
  ((rc == 0 && cleanup_rc != 0)) && rc=1
  exit "$rc"
}

diag_cleanup_signal() {
  local name="$1" rc="$2"
  trap - EXIT INT TERM
  diag_warn "received $name"
  diag_cleanup_now || true
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
    set +e
    "$@" taskset -c "$cpu" node child.mjs > /dev/null 2>&1
    rc=$?
    set -e
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
          $2 !~ /^[0-9]+$/ || $2 < 1 || $2 > runs ||
          ($3 != 0 && $3 != 139) || $4 !~ /^[0-9]+$/) {
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
