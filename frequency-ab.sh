#!/usr/bin/env bash
# frequency-ab.sh - controlled turbo A/B/A experiment on one CPU.
#
# diagnose.sh never changes system settings. This companion script is the
# only place that does, and it is meant to be reviewed and run manually:
#
#   sudo ./frequency-ab.sh <cpu> <runs-per-leg> <diagnostics-bundle-dir> [--cap KHZ]
#
# Sequence: A1 (original turbo state) -> B (no_turbo=1) -> A2 (original
# state restored). The original intel_pstate/no_turbo value (and, with
# --cap, the CPU's scaling_max_freq) is saved first and restored on normal
# exit, failure, SIGINT, or SIGTERM; the restore is verified and recorded.
# SIGKILL recovery state lives under a root-owned /run directory, never in
# the user-owned diagnostics bundle.
# Workload legs and final bundle placement run as the invoking user via
# runuser; direct-root invocation is refused.
# Results land in the bundle (results/frequency-ab.tsv|.meta); regenerate
# the report afterwards with:
#
#   ./diagnose.sh --resume <bundle> --yes
#
# Exit codes: 0 success, 2 usage, 4 not applicable / missing dependency.
set -Eeuo pipefail
ulimit -c 0
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=diagnose-lib/common.sh
source "$SCRIPT_DIR/diagnose-lib/common.sh"

# Never honor inherited output paths while privileged. All diagnostic output
# is assigned below to either the trusted restore area or private staging.
DIAG_LOG_FILE=""
DIAG_COMMANDS_LOG=""
DIAG_RESTORE_FILE=""

FREQUENCY_STAGE_DIR=""
FREQUENCY_STAGE_RECORD=""
FREQUENCY_OUTPUTS_PUBLISHED=0
FREQUENCY_OUTPUT_CLEANUP_ARMED=0
FREQUENCY_PUBLISH_CONTROL_NAME="publish-control.meta"
INVOKING_UID=""
INVOKING_GID=""
FREQUENCY_STATE_UID=""
FREQUENCY_STATE_GID=""

frequency_stage_record_clear() {
  [[ -n "$FREQUENCY_STAGE_RECORD" ]] || return 0
  rm -f -- "$FREQUENCY_STAGE_RECORD"
}

frequency_stage_record_write() {
  local bundle="$1" tmp
  [[ "$bundle" == /* && "$bundle" != *$'\n'* && "$bundle" != *$'\r'* && "$bundle" != *$'\t'* ]] ||
    return 1
  tmp="$(mktemp "${FREQUENCY_STAGE_RECORD}.tmp.XXXXXX")" || return 1
  chmod 0600 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  printf '%s\n' "$bundle" > "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -fT -- "$tmp" "$FREQUENCY_STAGE_RECORD" || {
    rm -f -- "$tmp"
    return 1
  }
  diag_restore_private_file_is_safe "$FREQUENCY_STAGE_RECORD" "$FREQUENCY_STATE_UID" "$FREQUENCY_STATE_GID"
}

frequency_publish_control_write() {
  local path="$1" generation="$2" cap_requested="$3" tmp
  frequency_generation_is_valid "$generation" || return 1
  [[ "$cap_requested" == 0 || "$cap_requested" == 1 ]] || return 1
  tmp="$(mktemp "${path}.tmp.XXXXXX")" || return 1
  chmod 0600 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  {
    printf 'VERSION=1\n'
    printf 'GENERATION=%s\n' "$generation"
    printf 'CAP_REQUESTED=%s\n' "$cap_requested"
  } > "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -fT -- "$tmp" "$path" || {
    rm -f -- "$tmp"
    return 1
  }
  sync -f "$(dirname -- "$path")"
}

frequency_stage_record_read() {
  local output_name="$1"
  local -n output_ref="$output_name"
  output_ref=""
  diag_restore_private_file_is_safe "$FREQUENCY_STAGE_RECORD" "$FREQUENCY_STATE_UID" "$FREQUENCY_STATE_GID" || return 1
  local -a lines=()
  mapfile -t lines < "$FREQUENCY_STAGE_RECORD" || return 1
  ((${#lines[@]} == 1)) || return 1
  [[ "${lines[0]}" == /* && "${lines[0]}" != *$'\r'* && "${lines[0]}" != *$'\t'* ]] || return 1
  output_ref="${lines[0]}"
}

frequency_quarantine_stage() {
  local reason="$1" owner mode disposition
  owner="$(stat -Lc '%u' -- "$FREQUENCY_STAGE_DIR" 2> /dev/null)" || return 1
  mode="$(stat -Lc '%a' -- "$FREQUENCY_STAGE_DIR" 2> /dev/null)" || return 1
  [[ -d "$FREQUENCY_STAGE_DIR" && ! -L "$FREQUENCY_STAGE_DIR" && "$mode" == 700 ]] || return 1
  disposition="${FREQUENCY_STAGE_DIR}.unpublished.$(date +%s).$BASHPID"
  if [[ "$owner" == "$INVOKING_UID" ]]; then
    runuser -u "$SUDO_USER" -- mv -T -- "$FREQUENCY_STAGE_DIR" "$disposition" || return 1
    diag_warn "$reason; invoking user owns unpublished evidence at $disposition"
  elif [[ "$owner" == 0 ]]; then
    mv -T -- "$FREQUENCY_STAGE_DIR" "$disposition" || return 1
    diag_warn "$reason; root-private evidence quarantined at $disposition"
  else
    return 1
  fi
  frequency_stage_record_clear
}

frequency_publish_outputs() {
  [[ -n "$FREQUENCY_STAGE_DIR" ]] || return 0
  ((FREQUENCY_OUTPUTS_PUBLISHED == 0)) || return 0

  local dir rel file tag
  for dir in "$FREQUENCY_STAGE_DIR" "$FREQUENCY_STAGE_DIR/results" "$FREQUENCY_STAGE_DIR/freq"; do
    [[ -d "$dir" && ! -L "$dir" ]] || {
      diag_warn "frequency output staging directory became unsafe; partial evidence remains in $FREQUENCY_STAGE_DIR"
      return 1
    }
    [[ "$(stat -Lc '%u:%g:%a' -- "$dir" 2> /dev/null)" == "0:0:700" ]] || {
      diag_warn "frequency output staging directory has unsafe ownership or mode; partial evidence remains in $FREQUENCY_STAGE_DIR"
      return 1
    }
  done

  local -a staged_files=(commands.log)
  local -a candidates=(
    "$FREQUENCY_PUBLISH_CONTROL_NAME"
    results/frequency-ab.tsv
    results/frequency-ab.meta
    results/frequency-cap.tsv
    results/frequency-cap.meta
  )
  for tag in A1 B A2 cap; do
    candidates+=("freq/freq-ab-${tag}.samples" "freq/freq-ab-${tag}.method")
  done
  for rel in "${candidates[@]}"; do
    [[ -e "$FREQUENCY_STAGE_DIR/$rel" || -L "$FREQUENCY_STAGE_DIR/$rel" ]] && staged_files+=("$rel")
  done
  for rel in "${staged_files[@]}"; do
    file="$FREQUENCY_STAGE_DIR/$rel"
    [[ -f "$file" && ! -L "$file" ]] || {
      diag_warn "unsafe staged frequency artifact $rel; partial evidence remains in $FREQUENCY_STAGE_DIR"
      return 1
    }
    [[ "$(stat -Lc '%u:%g:%a:%h' -- "$file" 2> /dev/null)" == "0:0:600:1" ]] || {
      diag_warn "staged frequency artifact $rel has unsafe ownership, mode, or links; partial evidence remains in $FREQUENCY_STAGE_DIR"
      return 1
    }
  done

  # Root touches only the private staging tree. Once ownership is handed off,
  # this shell performs no more filesystem operations there or in the bundle;
  # the unprivileged helper does every destination open and rename.
  for rel in "${staged_files[@]}"; do
    chown "$INVOKING_UID:$INVOKING_GID" "$FREQUENCY_STAGE_DIR/$rel" || return 1
  done
  for dir in "$FREQUENCY_STAGE_DIR/results" "$FREQUENCY_STAGE_DIR/freq" "$FREQUENCY_STAGE_DIR"; do
    chown "$INVOKING_UID:$INVOKING_GID" "$dir" || return 1
  done
  local publish_rc=0
  runuser -u "$SUDO_USER" -- /bin/bash \
    "$SCRIPT_DIR/diagnose-lib/publish-frequency-output.sh" "$FREQUENCY_STAGE_DIR" "$BUNDLE" || publish_rc=$?
  if ((publish_rc != 0)); then
    diag_warn "could not publish partial frequency evidence; invoking user owns staging directory $FREQUENCY_STAGE_DIR"
    return "$publish_rc"
  fi
  FREQUENCY_OUTPUTS_PUBLISHED=1
  if ! frequency_stage_record_clear; then
    diag_warn "frequency evidence was published but its durable staging record could not be cleared"
    return 1
  fi
}

frequency_recover_pending_outputs() {
  local requested_bundle="$BUNDLE" pending_bundle="" stage_owner="" publish_rc=0
  local has_record=0
  [[ -e "$FREQUENCY_STAGE_RECORD" || -L "$FREQUENCY_STAGE_RECORD" ]] && has_record=1

  if [[ ! -e "$FREQUENCY_STAGE_DIR" && ! -L "$FREQUENCY_STAGE_DIR" ]]; then
    if ((has_record == 1)); then
      frequency_stage_record_read pending_bundle || {
        diag_warn "durable frequency staging record is malformed or unsafe"
        return 1
      }
      diag_warn "discarding stale frequency staging record because its exact stage is absent"
      frequency_stage_record_clear || return 1
    fi
    return 0
  fi

  [[ -d "$FREQUENCY_STAGE_DIR" && ! -L "$FREQUENCY_STAGE_DIR" ]] || {
    diag_warn "deterministic frequency staging path is unsafe; refusing to touch it"
    return 1
  }
  stage_owner="$(stat -Lc '%u:%a' -- "$FREQUENCY_STAGE_DIR" 2> /dev/null)" || return 1
  [[ "$stage_owner" == "0:700" || "$stage_owner" == "$INVOKING_UID:700" ]] || {
    diag_warn "frequency staging path has unexpected ownership or mode; refusing recovery"
    return 1
  }

  if ((has_record == 0)); then
    frequency_quarantine_stage "found an unrecorded stage left before durable tracking completed" || return 1
    return 0
  fi
  frequency_stage_record_read pending_bundle || {
    diag_warn "durable frequency staging record is malformed or unsafe"
    return 1
  }

  BUNDLE="$pending_bundle"
  FREQUENCY_OUTPUTS_PUBLISHED=0
  if [[ "$stage_owner" == "0:700" ]]; then
    frequency_publish_outputs || publish_rc=$?
    if ((publish_rc == 0)); then
      diag_log "recovered and published frequency evidence left by a killed invocation"
      BUNDLE="$requested_bundle"
      FREQUENCY_STAGE_DIR="/tmp/node-pglite-frequency-uid-$INVOKING_UID"
      FREQUENCY_OUTPUTS_PUBLISHED=0
      return 0
    fi
  else
    runuser -u "$SUDO_USER" -- /bin/bash \
      "$SCRIPT_DIR/diagnose-lib/publish-frequency-output.sh" "$FREQUENCY_STAGE_DIR" "$BUNDLE" || publish_rc=$?
    if ((publish_rc == 0)); then
      frequency_stage_record_clear || return 1
      diag_log "recovered and published user-owned frequency staging evidence"
      BUNDLE="$requested_bundle"
      FREQUENCY_STAGE_DIR="/tmp/node-pglite-frequency-uid-$INVOKING_UID"
      FREQUENCY_OUTPUTS_PUBLISHED=0
      return 0
    fi
  fi

  if ((publish_rc == 75)); then
    BUNDLE="$requested_bundle"
    FREQUENCY_STAGE_DIR="/tmp/node-pglite-frequency-uid-$INVOKING_UID"
    FREQUENCY_OUTPUTS_PUBLISHED=0
    diag_warn "diagnostics bundle is busy; retained frequency staging for a later retry"
    return 75
  fi

  BUNDLE="$requested_bundle"
  frequency_quarantine_stage "could not republish frequency evidence left by a killed invocation" || return 1
  FREQUENCY_STAGE_DIR="/tmp/node-pglite-frequency-uid-$INVOKING_UID"
  FREQUENCY_OUTPUTS_PUBLISHED=0
}

frequency_initial_no_turbo_read() {
  local path="$1" output_name="$2"
  local -n output_ref="$output_name"
  local -a lines=()
  output_ref=""
  [[ -f "$path" && ! -L "$path" ]] || return 1
  mapfile -t lines < "$path" || return 1
  ((${#lines[@]} == 1)) || return 1
  [[ "${lines[0]}" == 0 || "${lines[0]}" == 1 ]] || return 1
  output_ref="${lines[0]}"
}

# A killed prior invocation may have left no_turbo=1 together with durable
# restore/output state. Main calls this before any new applicability decision.
frequency_recover_prior_state() {
  diag_recover_pending_restore || return 10
  local publish_rc=0
  frequency_recover_pending_outputs || publish_rc=$?
  ((publish_rc == 0)) && return 0
  ((publish_rc == 75)) && return 75
  return 11
}

frequency_validate_initial_no_turbo() {
  local path="$1" output_name="$2"
  local -n output_ref="$output_name"
  output_ref=""
  frequency_initial_no_turbo_read "$path" "$output_name" || return 12
  [[ "$output_ref" == 0 ]] || return 13
}

frequency_validate_cap_target() {
  local cap_khz="$1" policy="$2" path_output_name="$3" value_output_name="$4"
  local -n path_output_ref="$path_output_name"
  local -n value_output_ref="$value_output_name"
  local canonical_policy="" cap_target_path="" canonical_target=""
  local -a values=()
  local i allowlisted=0

  path_output_ref=""
  value_output_ref=""
  [[ -n "$cap_khz" ]] || return 0

  [[ -n "$policy" && "$policy" == /* ]] || return 20
  canonical_policy="$(readlink -f -- "$policy" 2> /dev/null)" || return 20
  [[ "$canonical_policy" == "$policy" && -d "$canonical_policy" ]] || return 20

  cap_target_path="$canonical_policy/scaling_max_freq"
  canonical_target="$(readlink -f -- "$cap_target_path" 2> /dev/null)" || return 21
  [[ -f "$canonical_target" && ! -L "$canonical_target" &&
    -r "$canonical_target" && -w "$canonical_target" ]] || return 21
  mapfile -t values < "$canonical_target" || return 21
  ((${#values[@]} == 1)) && [[ "${values[0]}" =~ ^[1-9][0-9]*$ ]] || return 21

  for ((i = 0; i < ${#DIAG_RESTORE_RULES[@]}; i += 2)); do
    if [[ "${DIAG_RESTORE_RULES[$i]}" == "$canonical_target" ]]; then
      allowlisted=1
      break
    fi
  done
  ((allowlisted == 1)) || return 22

  path_output_ref="$canonical_target"
  value_output_ref="${values[0]}"
}

frequency_generation_is_valid() {
  [[ "${1:-}" =~ ^[0-9a-f]{32}$ ]]
}

frequency_file_sha256() {
  local path="$1" digest="" remainder=""
  [[ -f "$path" && ! -L "$path" ]] || return 1
  read -r digest remainder < <(sha256sum -- "$path") || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

frequency_not_applicable() {
  local message="$1"
  # No stage exists at this decision point. Clear its deterministic future
  # path so the EXIT cleanup does not mistake deliberate refusal for lost
  # partial evidence and try to publish it.
  FREQUENCY_STAGE_DIR=""
  FREQUENCY_OUTPUT_CLEANUP_ARMED=0
  echo "error: $message" >&2
  return 4
}

diag_cleanup_artifacts() {
  ((FREQUENCY_OUTPUT_CLEANUP_ARMED == 1)) || return 0
  frequency_publish_outputs
}

# Let the safe test suite exercise the staging transaction helpers without
# entering the privileged experiment.
if [[ "${FREQUENCY_AB_SOURCE_ONLY:-}" == "1" ]]; then
  return 0
fi

usage() {
  cat >&2 << 'EOF'
usage: sudo ./frequency-ab.sh <cpu> <runs-per-leg> <bundle-dir> [--cap KHZ]

  cpu          logical CPU to pin single-child runs to (use the worst CPU
               identified by diagnose.sh phase 4)
  runs-per-leg single-child runs per leg (A1, B, A2)
  bundle-dir   diagnostics bundle to write results into
  --cap KHZ    afterwards, additionally run the labelled per-CPU
               frequency-cap experiment (scaling_max_freq=KHZ on that
               CPU's cpufreq policy, then restore). intel_pstate/HWP does
               not guarantee the cap strictly clamps the effective clock;
               the measured samples in the report decide.
EOF
  exit 2
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage
(($# >= 3)) || usage

CPU="$1"
RUNS="$2"
BUNDLE="$3"
shift 3
CAP_KHZ=""
while (($#)); do
  case "$1" in
    --cap)
      CAP_KHZ="${2:?--cap needs a kHz value}"
      shift 2
      ;;
    *) usage ;;
  esac
done

diag_require_uint "cpu" "$CPU"
diag_require_safe_positive_uint "runs-per-leg" "$RUNS"
[[ "$CPU" =~ ^(0|[1-9][0-9]*)$ && ${#CPU} -le 15 ]] ||
  diag_die "cpu must be a canonical safe non-negative integer"
((CPU <= 65535)) || diag_die "cpu must be <= 65535"
if [[ -n "$CAP_KHZ" ]]; then
  diag_require_uint "--cap" "$CAP_KHZ"
  [[ "$CAP_KHZ" =~ ^[1-9][0-9]*$ && ${#CAP_KHZ} -le 15 ]] ||
    diag_die "--cap must be a canonical safe positive integer"
  ((CAP_KHZ >= 100000)) || diag_die "--cap must be >= 100000 kHz"
fi
[[ -d "$BUNDLE" ]] || diag_die "bundle directory '$BUNDLE' does not exist"
BUNDLE="$(diag_canonical_dir "$BUNDLE")"
[[ -f child.mjs ]] || diag_die "child.mjs not found; run from the repository checkout"

if ((EUID != 0)); then
  echo "error: this script changes intel_pstate settings; run it with sudo." >&2
  echo "       sudo $0 $CPU $RUNS $BUNDLE${CAP_KHZ:+ --cap $CAP_KHZ}" >&2
  exit 4
fi

for dep in flock node runuser setsid sha256sum stat sync taskset; do
  command -v "$dep" > /dev/null 2>&1 || diag_die "missing required command: $dep"
done

NO_TURBO_PATH="/sys/devices/system/cpu/intel_pstate/no_turbo"
if [[ ! -e "$NO_TURBO_PATH" ]]; then
  diag_die "intel_pstate/no_turbo not present; A/B/A not applicable on this system"
fi

POLICY="$(readlink -f "/sys/devices/system/cpu/cpu${CPU}/cpufreq" 2> /dev/null || echo "")"
[[ -n "$POLICY" ]] || diag_warn "no cpufreq policy found for cpu $CPU"
CAP_SCALING_MAX_PATH=""
CAP_PREFLIGHT_SCALING_MAX=""
CAP_REQUESTED=0
[[ -n "$CAP_KHZ" ]] && CAP_REQUESTED=1

DIAG_BUNDLE_ROOT="$BUNDLE"
DIAG_REPO_ROOT="$SCRIPT_DIR"

[[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]] ||
  diag_die "run through sudo from a non-root account so bundle output can be published without root privileges"
diag_require_uint "SUDO_UID" "${SUDO_UID:-}"
((SUDO_UID > 0)) || diag_die "SUDO_UID must identify a non-root invoking user"
INVOKING_UID="$(id -u "$SUDO_USER" 2> /dev/null)" ||
  diag_die "cannot resolve invoking user '$SUDO_USER'"
INVOKING_GID="$(id -g "$SUDO_USER" 2> /dev/null)" ||
  diag_die "cannot resolve invoking group for '$SUDO_USER'"
[[ "$INVOKING_UID" == "$SUDO_UID" ]] ||
  diag_die "SUDO_USER and SUDO_UID identify different invoking users"
FREQUENCY_STATE_UID=0
FREQUENCY_STATE_GID=0

# Runtime settings reset on reboot, so /run provides durable-enough SIGKILL
# recovery without placing privileged write authority in the user-owned
# bundle. One active experiment is allowed per invoking UID.
RESTORE_STATE_BASE="/run/node-pglite-wasm-sigsegv-repro"
RESTORE_STATE_DIR="$RESTORE_STATE_BASE/uid-$INVOKING_UID"
diag_restore_private_dir_prepare "$RESTORE_STATE_BASE" 0 0 ||
  diag_die "secure restore-state base must be a root-owned mode-0700 directory"
diag_restore_private_dir_prepare "$RESTORE_STATE_DIR" 0 0 ||
  diag_die "per-user restore-state directory must be root-owned and mode 0700"
diag_restore_lock_acquire "$RESTORE_STATE_DIR/active.lock" 0 0 ||
  diag_die "cannot acquire the per-user frequency experiment lock"

DIAG_RESTORE_FILE="$RESTORE_STATE_DIR/restore.tsv"
FREQUENCY_STAGE_RECORD="$RESTORE_STATE_DIR/output-stage.pending"
FREQUENCY_STAGE_DIR="/tmp/node-pglite-frequency-uid-$INVOKING_UID"
diag_register_cleanup_traps
diag_restore_private_file_prepare "$DIAG_RESTORE_FILE" 0 0 ||
  diag_die "secure restore ledger must be a root-owned mode-0600 regular file with one link"

# Enumerate exact trusted sysfs destinations. Including every current policy
# lets a later invocation recover a killed cap experiment even when it was
# launched with a different CPU argument.
declare -a restore_rules=("$NO_TURBO_PATH" '^[01]$')
for restore_path in /sys/devices/system/cpu/cpufreq/policy*/scaling_max_freq; do
  [[ -f "$restore_path" ]] || continue
  restore_path="$(readlink -f "$restore_path")"
  restore_rules+=("$restore_path" '^[0-9]+$')
done
diag_restore_rules_set "${restore_rules[@]}" ||
  diag_die "could not configure the trusted restore allowlist"

# Recovery always precedes legacy-bundle and new-experiment applicability
# checks, because restoring settings and publishing an older durable stage are
# required even when this invocation will refuse to start new work.
recovery_rc=0
frequency_recover_prior_state || recovery_rc=$?
case "$recovery_rc" in
  0) ;;
  75)
    diag_warn "another diagnostics bundle writer is active; retained pending frequency evidence for retry"
    exit 75
    ;;
  10) diag_die "refusing to start while a previous settings restore is pending" ;;
  11) diag_die "refusing to start while prior frequency staging cannot be safely recovered" ;;
  *) diag_die "could not recover prior frequency experiment state" ;;
esac

# Validate the recovered state before any check or mutation associated with a
# new experiment. Refusal happens before saving a new restore entry, changing
# a setting, or creating a new frequency result stage.
SAVED_NO_TURBO=""
initial_state_rc=0
frequency_validate_initial_no_turbo "$NO_TURBO_PATH" SAVED_NO_TURBO ||
  initial_state_rc=$?
case "$initial_state_rc" in
  0) ;;
  12)
    frequency_not_applicable \
      "intel_pstate/no_turbo must contain exactly 0 or 1; A/B/A is not applicable." || exit $?
    ;;
  13)
    frequency_not_applicable \
      "intel_pstate/no_turbo is already 1; A/B/A needs turbo-on A1/A2 conditions." || exit $?
    ;;
  *) diag_die "could not validate the initial intel_pstate/no_turbo state" ;;
esac

cap_target_rc=0
frequency_validate_cap_target \
  "$CAP_KHZ" "$POLICY" CAP_SCALING_MAX_PATH CAP_PREFLIGHT_SCALING_MAX || cap_target_rc=$?
case "$cap_target_rc" in
  0) ;;
  20)
    frequency_not_applicable \
      "--cap needs a resolvable canonical cpufreq policy for cpu $CPU." || exit $?
    ;;
  21)
    frequency_not_applicable \
      "--cap needs a safe, readable, writable scaling_max_freq file with one canonical positive value." || exit $?
    ;;
  22)
    frequency_not_applicable \
      "--cap scaling_max_freq target is outside the trusted restore allowlist." || exit $?
    ;;
  *) diag_die "could not validate the frequency-cap target" ;;
esac

# Older versions placed restore authority in the bundle. It is intentionally
# never trusted or migrated by this privileged script.
LEGACY_RESTORE_FILE="$BUNDLE/state/restore-frequency-ab.tsv"
if [[ -L "$LEGACY_RESTORE_FILE" || -s "$LEGACY_RESTORE_FILE" ]]; then
  diag_die "legacy bundle restore state cannot be trusted; inspect and remove it manually before continuing"
fi

FREQUENCY_GENERATION="$(cat /proc/sys/kernel/random/uuid 2> /dev/null || true)"
FREQUENCY_GENERATION="${FREQUENCY_GENERATION//-/}"
frequency_generation_is_valid "$FREQUENCY_GENERATION" ||
  diag_die "could not create a canonical frequency evidence generation token"

# Confirm the destination is usable as the invoking user. Directory creation
# is deferred to the locked unprivileged publisher; root never opens or creates
# an output inside the user-mutable bundle.
runuser -u "$SUDO_USER" -- test -d "$BUNDLE" &&
  runuser -u "$SUDO_USER" -- test -w "$BUNDLE" ||
  diag_die "invoking user cannot write the diagnostics bundle"
declare -a AS_USER=(runuser -u "$SUDO_USER" --)
diag_log "workload legs and bundle placement run as user $SUDO_USER (via runuser)"

# All privileged writes remain inside this deterministic root-owned directory;
# its per-user identity makes a pre-record SIGKILL discoverable on the next run.
# The cleanup hook publishes complete or partial evidence only after stopping
# children/samplers and restoring settings.
mkdir -m 0700 -- "$FREQUENCY_STAGE_DIR" ||
  diag_die "could not create deterministic private frequency output staging directory"
[[ "$(stat -Lc '%u:%g:%a' -- "$FREQUENCY_STAGE_DIR" 2> /dev/null)" == "0:0:700" ]] ||
  diag_die "frequency output staging directory is not root-owned and mode 0700"
mkdir -m 0700 -- "$FREQUENCY_STAGE_DIR/results" "$FREQUENCY_STAGE_DIR/freq"
FREQUENCY_OUTPUT_CLEANUP_ARMED=1
DIAG_FREQ_DIR="$FREQUENCY_STAGE_DIR/freq"
DIAG_COMMANDS_LOG="$FREQUENCY_STAGE_DIR/commands.log"
: > "$DIAG_COMMANDS_LOG"
chmod 0600 "$DIAG_COMMANDS_LOG"
printf '# frequency-ab %s\n' "$(date -Is)" > "$DIAG_COMMANDS_LOG"
frequency_publish_control_write \
  "$FREQUENCY_STAGE_DIR/$FREQUENCY_PUBLISH_CONTROL_NAME" "$FREQUENCY_GENERATION" "$CAP_REQUESTED" ||
  diag_die "could not durably record the frequency publication inventory"
frequency_stage_record_write "$BUNDLE" ||
  diag_die "could not durably record the frequency output staging transaction"

cd "$SCRIPT_DIR"

TSV="$FREQUENCY_STAGE_DIR/results/frequency-ab.tsv"
META="$FREQUENCY_STAGE_DIR/results/frequency-ab.meta"
: > "$TSV"
chmod 0600 "$TSV"

diag_restore_save "$NO_TURBO_PATH"
diag_log "saved no_turbo=$SAVED_NO_TURBO (restored on exit/interrupt)"

{
  printf 'GENERATION=%s\n' "$FREQUENCY_GENERATION"
  printf 'CPU=%s\n' "$CPU"
  printf 'RUNS_PER_LEG=%s\n' "$RUNS"
  printf 'SAVED_NO_TURBO=%s\n' "$SAVED_NO_TURBO"
  printf 'CAP_REQUESTED=%s\n' "$CAP_REQUESTED"
  printf 'REQUESTED_CAP_KHZ=%s\n' "${CAP_KHZ:--}"
} > "$META"
chmod 0600 "$META"

for leg in A1 B A2; do
  case "$leg" in
    B)
      diag_log "leg B: disabling turbo (no_turbo=1)"
      diag_sysfs_write "$NO_TURBO_PATH" 1
      ;;
    A2)
      diag_log "leg A2: restoring original turbo state (no_turbo=$SAVED_NO_TURBO)"
      diag_sysfs_write "$NO_TURBO_PATH" "$SAVED_NO_TURBO"
      ;;
  esac
  nt="$(cat "$NO_TURBO_PATH")"
  smax="-"
  [[ -n "$POLICY" ]] && smax="$(cat "$POLICY/scaling_max_freq" 2> /dev/null || echo -)"
  printf 'LEG_%s_NO_TURBO=%s\n' "$leg" "$nt" >> "$META"
  printf 'LEG_%s_SCALING_MAX_KHZ=%s\n' "$leg" "$smax" >> "$META"
  diag_log "leg $leg: no_turbo=$nt scaling_max_freq=$smax; $RUNS runs on cpu $CPU"
  diag_run_single_runs "$TSV" "$leg" "$CPU" "$RUNS" "${AS_USER[@]}"
done

diag_restore_now || diag_die "no_turbo restore failed; secure recovery state was retained"
now="$(cat "$NO_TURBO_PATH")"
printf 'RESTORED=%s\n' "$([[ "$now" == "$SAVED_NO_TURBO" ]] && echo 1 || echo 0)" >> "$META"
[[ "$now" == "$SAVED_NO_TURBO" ]] || diag_warn "no_turbo restore verification FAILED (now $now)"

# Optional, clearly labelled per-CPU frequency-cap experiment.
if [[ -n "$CAP_KHZ" ]]; then
  cap_phase_path=""
  saved_smax=""
  frequency_validate_cap_target \
    "$CAP_KHZ" "$POLICY" cap_phase_path saved_smax ||
    diag_die "frequency-cap target became unsafe or unusable before the cap leg"
  [[ "$cap_phase_path" == "$CAP_SCALING_MAX_PATH" ]] ||
    diag_die "frequency-cap target changed after preflight"
  smax_path="$cap_phase_path"
  diag_warn "per-CPU frequency-cap experiment: intel_pstate/HWP may not"
  diag_warn "strictly clamp scaling_max_freq; measured samples decide."
  diag_restore_save "$smax_path"
  diag_sysfs_write "$smax_path" "$CAP_KHZ"
  {
    printf 'GENERATION=%s\n' "$FREQUENCY_GENERATION"
    printf 'CPU=%s\n' "$CPU"
    printf 'CAP_KHZ=%s\n' "$CAP_KHZ"
    printf 'SAVED_SCALING_MAX_KHZ=%s\n' "$saved_smax"
    printf 'RUNS_PER_LEG=%s\n' "$RUNS"
  } > "$FREQUENCY_STAGE_DIR/results/frequency-cap.meta"
  chmod 0600 "$FREQUENCY_STAGE_DIR/results/frequency-cap.meta"
  diag_log "cap leg: scaling_max_freq=$CAP_KHZ on $(basename "$POLICY"); $RUNS runs on cpu $CPU"
  diag_run_single_runs "$TSV" "cap" "$CPU" "$RUNS" "${AS_USER[@]}"
  grep -P '^cap\t' "$TSV" > "$FREQUENCY_STAGE_DIR/results/frequency-cap.tsv" || true
  chmod 0600 "$FREQUENCY_STAGE_DIR/results/frequency-cap.tsv"
  sed -i '/^cap\t/d' "$TSV"
  diag_restore_now || diag_die "scaling_max_freq restore failed; secure recovery state was retained"
  now="$(cat "$smax_path")"
  printf 'RESTORED=%s\n' "$([[ "$now" == "$saved_smax" ]] && echo 1 || echo 0)" >> "$FREQUENCY_STAGE_DIR/results/frequency-cap.meta"
  [[ "$now" == "$saved_smax" ]] || diag_warn "scaling_max_freq restore verification FAILED"
  diag_frequency_cap_rows_are_complete "$FREQUENCY_STAGE_DIR/results/frequency-cap.tsv" "$RUNS" ||
    diag_die "frequency-cap output is incomplete or contains non-SIGSEGV operational failures"
  cap_rows_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/results/frequency-cap.tsv")" ||
    diag_die "could not hash frequency-cap rows"
  cap_samples_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-cap.samples")" ||
    diag_die "could not hash frequency-cap samples"
  cap_method_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-cap.method")" ||
    diag_die "could not hash frequency-cap method"
  {
    printf 'ROWS_SHA256=%s\n' "$cap_rows_sha256"
    printf 'SAMPLES_SHA256=%s\n' "$cap_samples_sha256"
    printf 'METHOD_SHA256=%s\n' "$cap_method_sha256"
    printf 'COMPLETED=1\n'
  } >> "$FREQUENCY_STAGE_DIR/results/frequency-cap.meta"
fi

diag_frequency_rows_are_complete "$TSV" "$RUNS" ||
  diag_die "frequency A/B/A output is incomplete or contains non-SIGSEGV operational failures"
ab_rows_sha256="$(frequency_file_sha256 "$TSV")" || diag_die "could not hash frequency A/B/A rows"
a1_samples_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-A1.samples")" ||
  diag_die "could not hash A1 frequency samples"
a1_method_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-A1.method")" ||
  diag_die "could not hash A1 frequency method"
b_samples_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-B.samples")" ||
  diag_die "could not hash B frequency samples"
b_method_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-B.method")" ||
  diag_die "could not hash B frequency method"
a2_samples_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-A2.samples")" ||
  diag_die "could not hash A2 frequency samples"
a2_method_sha256="$(frequency_file_sha256 "$FREQUENCY_STAGE_DIR/freq/freq-ab-A2.method")" ||
  diag_die "could not hash A2 frequency method"
{
  printf 'ROWS_SHA256=%s\n' "$ab_rows_sha256"
  printf 'LEG_A1_SAMPLES_SHA256=%s\n' "$a1_samples_sha256"
  printf 'LEG_A1_METHOD_SHA256=%s\n' "$a1_method_sha256"
  printf 'LEG_B_SAMPLES_SHA256=%s\n' "$b_samples_sha256"
  printf 'LEG_B_METHOD_SHA256=%s\n' "$b_method_sha256"
  printf 'LEG_A2_SAMPLES_SHA256=%s\n' "$a2_samples_sha256"
  printf 'LEG_A2_METHOD_SHA256=%s\n' "$a2_method_sha256"
  printf 'CAP_COMPLETED=%s\n' "$CAP_REQUESTED"
  printf 'COMPLETED=1\n'
} >> "$META"

diag_log "frequency A/B/A complete. Regenerate the report with:"
diag_log "  ./diagnose.sh --resume \"$BUNDLE\" --yes"
