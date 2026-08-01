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
# Workload legs run as the invoking user (via runuser) when possible.
# Results land in the bundle (results/frequency-ab.tsv|.meta); regenerate
# the report afterwards with:
#
#   ./diagnose.sh --resume <bundle> --yes
#
# Exit codes: 0 success, 2 usage, 4 not applicable / missing dependency.
set -Eeuo pipefail
ulimit -c 0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=diagnose-lib/common.sh
source "$SCRIPT_DIR/diagnose-lib/common.sh"

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
diag_require_uint "runs-per-leg" "$RUNS"
((RUNS >= 1)) || diag_die "runs-per-leg must be >= 1"
if [[ -n "$CAP_KHZ" ]]; then
  diag_require_uint "--cap" "$CAP_KHZ"
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

NO_TURBO_PATH="/sys/devices/system/cpu/intel_pstate/no_turbo"
if [[ ! -e "$NO_TURBO_PATH" ]]; then
  diag_die "intel_pstate/no_turbo not present; A/B/A not applicable on this system"
fi

POLICY="$(readlink -f "/sys/devices/system/cpu/cpu${CPU}/cpufreq" 2> /dev/null || echo "")"
[[ -n "$POLICY" ]] || diag_warn "no cpufreq policy found for cpu $CPU"

declare -a protected_bundle_paths=(
  "$BUNDLE/results" "$BUNDLE/freq" "$BUNDLE/state" "$BUNDLE/commands.log"
  "$BUNDLE/results/frequency-ab.tsv" "$BUNDLE/results/frequency-ab.meta"
  "$BUNDLE/results/frequency-cap.tsv" "$BUNDLE/results/frequency-cap.meta"
  "$BUNDLE/state/restore-frequency-ab.tsv"
)
for tag in A1 B A2 cap; do
  protected_bundle_paths+=(
    "$BUNDLE/freq/freq-ab-${tag}.samples"
    "$BUNDLE/freq/freq-ab-${tag}.method"
  )
done
diag_require_not_symlink "${protected_bundle_paths[@]}"

mkdir -p "$BUNDLE/results" "$BUNDLE/freq" "$BUNDLE/state"
DIAG_RESTORE_FILE="$BUNDLE/state/restore-frequency-ab.tsv"
DIAG_FREQ_DIR="$BUNDLE/freq"
DIAG_COMMANDS_LOG="$BUNDLE/commands.log"

diag_register_cleanup_traps

# SIGKILL cannot run a trap. Recover any durable ledger left by a previous
# killed invocation before replacing output files or saving new state.
if [[ -s "$DIAG_RESTORE_FILE" ]]; then
  declare -a restore_rules=("$NO_TURBO_PATH" '^[01]$')
  if [[ -n "$POLICY" ]]; then
    restore_rules+=("$POLICY/scaling_max_freq" '^[0-9]+$')
  fi
  diag_restore_ledger_is_valid "$DIAG_RESTORE_FILE" "${restore_rules[@]}" ||
    diag_die "pending restore ledger is malformed or names a non-allowlisted setting; refusing privileged recovery"
fi
diag_recover_pending_restore ||
  diag_die "refusing to start while a previous settings restore is pending"

# Run workload legs as the invoking user when we can.
declare -a AS_USER=()
if [[ -n "${SUDO_USER:-}" ]] && command -v runuser > /dev/null 2>&1; then
  AS_USER=(runuser -u "$SUDO_USER" --)
  diag_log "workload legs run as user $SUDO_USER (via runuser)"
else
  diag_warn "workload legs run as root (no SUDO_USER/runuser)"
fi

cd "$SCRIPT_DIR"

TSV="$BUNDLE/results/frequency-ab.tsv"
META="$BUNDLE/results/frequency-ab.meta"
: > "$TSV"

SAVED_NO_TURBO="$(cat "$NO_TURBO_PATH")"
diag_restore_save "$NO_TURBO_PATH"
diag_log "saved no_turbo=$SAVED_NO_TURBO (restored on exit/interrupt)"

{
  printf 'CPU=%s\n' "$CPU"
  printf 'RUNS_PER_LEG=%s\n' "$RUNS"
  printf 'SAVED_NO_TURBO=%s\n' "$SAVED_NO_TURBO"
} > "$META"

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

diag_restore_now || diag_die "no_turbo restore failed; pending recovery is recorded in $DIAG_RESTORE_FILE"
now="$(cat "$NO_TURBO_PATH")"
printf 'RESTORED=%s\n' "$([[ "$now" == "$SAVED_NO_TURBO" ]] && echo 1 || echo 0)" >> "$META"
[[ "$now" == "$SAVED_NO_TURBO" ]] || diag_warn "no_turbo restore verification FAILED (now $now)"

# Optional, clearly labelled per-CPU frequency-cap experiment.
if [[ -n "$CAP_KHZ" && -n "$POLICY" ]]; then
  smax_path="$POLICY/scaling_max_freq"
  saved_smax="$(cat "$smax_path")"
  diag_warn "per-CPU frequency-cap experiment: intel_pstate/HWP may not"
  diag_warn "strictly clamp scaling_max_freq; measured samples decide."
  diag_restore_save "$smax_path"
  diag_sysfs_write "$smax_path" "$CAP_KHZ"
  {
    printf 'CPU=%s\n' "$CPU"
    printf 'CAP_KHZ=%s\n' "$CAP_KHZ"
    printf 'SAVED_SCALING_MAX_KHZ=%s\n' "$saved_smax"
    printf 'RUNS_PER_LEG=%s\n' "$RUNS"
  } > "$BUNDLE/results/frequency-cap.meta"
  diag_log "cap leg: scaling_max_freq=$CAP_KHZ on $(basename "$POLICY"); $RUNS runs on cpu $CPU"
  diag_run_single_runs "$TSV" "cap" "$CPU" "$RUNS" "${AS_USER[@]}"
  grep -P '^cap\t' "$TSV" > "$BUNDLE/results/frequency-cap.tsv" || true
  sed -i '/^cap\t/d' "$TSV"
  diag_restore_now || diag_die "scaling_max_freq restore failed; pending recovery is recorded in $DIAG_RESTORE_FILE"
  now="$(cat "$smax_path")"
  printf 'RESTORED=%s\n' "$([[ "$now" == "$saved_smax" ]] && echo 1 || echo 0)" >> "$BUNDLE/results/frequency-cap.meta"
  [[ "$now" == "$saved_smax" ]] || diag_warn "scaling_max_freq restore verification FAILED"
fi

# Hand ownership back to the invoking user.
if [[ -n "${SUDO_USER:-}" ]]; then
  chown -R "$SUDO_USER":"$(id -gn "$SUDO_USER")" \
    "$BUNDLE/results" "$BUNDLE/freq" "$BUNDLE/state" "$BUNDLE/commands.log" 2> /dev/null || true
fi

diag_log "frequency A/B/A complete. Regenerate the report with:"
diag_log "  ./diagnose.sh --resume \"$BUNDLE\" --yes"
