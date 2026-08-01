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
  # Idempotent: restores every saved setting once, then disarms.
  [[ "$DIAG_RESTORE_ARMED" == "1" ]] || return 0
  [[ -n "$DIAG_RESTORE_FILE" && -f "$DIAG_RESTORE_FILE" ]] || return 0
  local path value
  # Restore in reverse save order.
  while IFS=$'\t' read -r path value; do
    [[ -n "$path" ]] || continue
    diag_log "restoring $path <- $value"
    diag_sysfs_write "$path" "$value" || diag_warn "failed to restore $path"
  done < <(tac "$DIAG_RESTORE_FILE" 2> /dev/null || tail -r "$DIAG_RESTORE_FILE")
  : > "$DIAG_RESTORE_FILE"
  DIAG_RESTORE_ARMED=0
}

diag_register_restore_trap() {
  trap 'diag_restore_now' EXIT
  trap 'diag_warn "interrupted (SIGINT)"; exit 130' INT
  trap 'diag_warn "terminated (SIGTERM)"; exit 143' TERM
}

# ---------------------------------------------------------------------------
# Frequency sampling
# ---------------------------------------------------------------------------
# Prefers turbostat when available and permitted; falls back to per-CPU
# scaling_cur_freq polling. Samples are appended as "epoch cpu khz" lines
# (sysfs) or kept raw (turbostat) under $DIAG_FREQ_DIR/<tag>.samples.
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
    turbostat --Summary --quiet --interval 1 >> "$samples" 2> /dev/null &
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
