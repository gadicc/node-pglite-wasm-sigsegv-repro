#!/usr/bin/env bash
# diagnose.sh - from-zero diagnostic runner for the concurrent-PGlite
# SIGSEGV reproduction.
#
# Phases:
#   1 preflight   read-only environment collection (sanitized)
#   2 baseline    concurrent reproduction, STOP_ON_FAILURE=0
#   3 groups      CPU-group isolation (topology discovered from sysfs)
#   4 individual  interleaved per-CPU single-child runs
#   5 pinned-concurrent exact-CPU topology-context waves
#   6 frequency   manual step only (see frequency-ab.sh; never automatic)
#   7 gdb         pristine fault-signature capture on the worst CPU
#   8 report      statistics, conclusions, manifest
#
# This script never requires root and never elevates privileges.
# Privileged reads live in root-checks.sh and the setting-changing
# frequency A/B/A experiment in frequency-ab.sh; both are reviewed and run
# manually, and their results are merged on --resume. It never changes
# BIOS settings and never puts a BIOS password anywhere.
#
# WARNING: the workload is memory-intensive (~1.2 GiB per child process),
# intentionally triggers crashes, and a full run can take hours.

set -Eeuo pipefail
ulimit -c 0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/diagnose-lib"
DIAG_INDIVIDUAL_NODE_BIN="$(command -v node || true)"
# shellcheck source=diagnose-lib/common.sh
source "$LIB/common.sh"
# shellcheck source=diagnose-lib/bundle-lock.sh
source "$LIB/bundle-lock.sh"

# This unprivileged entrypoint never changes settings and must never inherit
# restore authority from its environment or from a resumed bundle.
DIAG_RESTORE_FILE=""

# ---------------------------------------------------------------------------
# Defaults (mode presets applied after arg pre-pass)
# ---------------------------------------------------------------------------
MODE="default"
BASELINE_CHILDREN=16
BASELINE_WAVES=50
GROUP_WAVES=50
INDIVIDUAL_RUNS=200
PINNED_CONCURRENT_ROUNDS=200
PROTOCOL_SEED="auto"
PROTOCOL_SEED_MAX=4294967295
SKIP_PINNED_CONCURRENT=0
TELEMETRY_INTERVAL_MS=250
RUN_SCHEMA_VERSION=2
GDB_MAX_RUNS=12
GDB_MAX_CAPTURES=3
# The GDB evidence envelope's structural ceiling (GDB_MAX_RUNS_LIMIT in
# diagnose-lib/gdb-evidence.mjs); enforced up front so an out-of-range run
# limit fails at configuration time instead of after the workload.
GDB_MAX_RUNS_LIMIT=4096
OUT_DIR=""
OUT_DIR_EXPLICIT=0
RESUME_DIR=""
SKIP_GDB=0
DRY_RUN=0
ASSUME_YES=0
REDO_PHASES=""
declare -a REDO_PLAN=()
REDO_MARKER_TEMP=""
REDO_NEW_TXN_ID=""
REDO_TXN_ID=""
REDO_TXN_VERSION=""
REDO_TXN_HAS_CPU_TARGET=0
REDO_TXN_HAS_SCHEMA2=0
declare -a REDO_TXN_PHASES=()
declare -a REDO_TXN_OWNERS=()
declare -a REDO_TXN_PATHS=()
declare -A REDO_TXN_CONFIG=()
REDO_REQUEST_SATISFIED_BY_PENDING=0
REDO_RECOVERED_PENDING=0
META_UPDATE_TEMP=""
GROUP_PLAN_TEMP=""
PINNED_CONTEXTS_TEMP=""
GROUP_META_TEMP=""
GROUPS_META_GENERATION=""
PREFLIGHT_MANIFEST_TEMP=""
PREFLIGHT_META_TEMP=""
PRIVACY_REVIEW_TEMP=""
PRIVACY_INVENTORY_BEFORE=""
PRIVACY_INVENTORY_AFTER=""
PRIVACY_REVIEW_FD=""
PRIVACY_INVENTORY_BEFORE_FD=""
PRIVACY_INVENTORY_AFTER_FD=""
DERIVED_RESULTS_CANDIDATE=""
DERIVED_REPORT_CANDIDATE=""
DERIVED_MANIFEST_CANDIDATE=""
DERIVED_MANIFEST_FD=""
DERIVED_RESULTS_DEST_STATE=""
DERIVED_REPORT_DEST_STATE=""
DERIVED_PRIVACY_DEST_STATE=""
DERIVED_MANIFEST_DEST_STATE=""
DERIVED_FINALIZATION_ERROR=""
DERIVED_FINALIZATION_COMPLETE=0
GROUP_PLAN_DIGEST=""
TELEMETRY_ACTIVE_PHASE=""
TELEMETRY_ACTIVE_TAG=""
TELEMETRY_ACTIVE_GENERATION=""
TELEMETRY_ACTIVE_SEGMENT=""
TELEMETRY_ACTIVE_LOG=""
TELEMETRY_ACTIVE_BOUNDARY=""
TELEMETRY_ACTIVE_STATE=""
TELEMETRY_BOUNDARY_STARTED=0
TELEMETRY_DEGRADED=0
CPU_TARGET="auto"
WORST_CPU_OVERRIDE=""
SESSION_DID_WORK=0
MODE_EXPLICIT=0
GROUP_WAVES_EXPLICIT=0
INDIVIDUAL_RUNS_EXPLICIT=0
PINNED_CONCURRENT_ROUNDS_EXPLICIT=0
PROTOCOL_SEED_EXPLICIT=0
SKIP_PINNED_CONCURRENT_EXPLICIT=0
SKIP_PINNED_CONCURRENT_FLAG_SEEN=0
RUN_PINNED_CONCURRENT_FLAG_SEEN=0
TELEMETRY_INTERVAL_MS_EXPLICIT=0
GDB_MAX_RUNS_EXPLICIT=0
SKIP_GDB_EXPLICIT=0
SKIP_GDB_FLAG_SEEN=0
RUN_GDB_FLAG_SEEN=0
CPU_EXPLICIT=0
CPU_FLAG_SEEN=0
PENDING_CPU_TARGET_UNAVAILABLE=0
REQUIRED_COMMANDS=(
  awk basename bash cat chmod cmp cut date dirname find flock grep head mkdir mktemp mv node
  nproc paste readlink rm rmdir sed setsid sha256sum sleep sort stat sync tail taskset tee timeout
  touch tr uniq wc xargs
)
PREFLIGHT_ARTIFACTS=(
  cmdline.txt cpuinfo-extra.txt cpufreq.txt cctk.txt date.txt dependencies.txt
  dmi.txt kernel-warnings.txt lscpu.txt node.txt online.txt os-release.txt
  power.txt summary.env topology.tsv uname.txt undervolt.txt
)

usage() {
  cat << 'EOF'
Usage: ./diagnose.sh [options]

Modes (pick at most one):
  --quick               short run: 8x10 baseline, 10 group waves,
                        5 isolated rounds/CPU, 5 pinned-concurrent rounds,
                        6 gdb runs
  --full                long run: 16x100 baseline, 100 group waves,
                        400 isolated rounds/CPU, 400 pinned-concurrent rounds,
                        24 gdb runs
  (default)             16x50 baseline, 50 group waves, 200 isolated
                        rounds/CPU, 200 pinned-concurrent rounds, 12 gdb runs
                        (0/200 gives a one-sided 95% upper bound of 1.49%)

Options:
  --resume DIR          resume an interrupted run, skipping completed phases
                        (also regenerates the report, e.g. after running
                        root-checks.sh or frequency-ab.sh manually)
  --redo PHASES         with --resume: re-run phase(s) from scratch
                        (comma-separated: preflight,baseline,groups,individual,
                        pinned-concurrent,gdb,frequency). Redoing preflight
                        also redoes every later phase. Old data is preserved
                        under state/superseded/, never deleted.
  --out-dir DIR         output directory (default: diagnostics/<UTC timestamp>)
  --skip-gdb            skip the GDB capture phase
  --run-gdb             run GDB even when a resumed bundle stored --skip-gdb
  --individual-runs N   seeded, interleaved isolated rounds per usable CPU
                        (overrides mode default)
  --pinned-concurrent-rounds N
                        pinned-concurrent macro-rounds per topology context
  --protocol-seed auto|N
                        persisted uint32 schedule seed (auto for a fresh run)
  --skip-pinned-concurrent
                        omit the exact-CPU concurrent protocol explicitly
  --run-pinned-concurrent
                        run it even when a resumed bundle stored an explicit skip
  --telemetry-interval-ms N
                        read-only telemetry interval, 50..60000 (default 250)
  --group-waves N       waves per CPU group (overrides mode default)
  --gdb-max-runs N      max gdb attempts (overrides mode default)
  --cpu N|auto          use a fixed CPU for GDB/frequency evidence, or select
                        the worst failing CPU automatically (default)
  --dry-run             print the resolved plan and exit without running
  --yes                 accept the safety warning (required non-interactively)
  -h, --help            this help

Privileged steps are NEVER performed by this script. Two optional manual
companions exist for you to review and run yourself:
  sudo ./root-checks.sh <bundle>      read-only privileged evidence
                                      (dmesg excerpt, intel-undervolt read,
                                      allowlisted cctk BIOS reads, turbostat)
  sudo ./frequency-ab.sh <cpu> <runs-per-leg> <bundle> [--cap KHZ]
                                      turbo A/B/A experiment (restores all
                                      settings; the only script that changes
                                      anything)
Re-generate the report afterwards with: ./diagnose.sh --resume <bundle> --yes

WARNING: the workload is memory-intensive (~1.2 GiB per child; the default
baseline needs ~20 GiB), intentionally triggers SIGSEGV crashes, and can
take a long time. System core dumps are disabled for the test processes.
EOF
}

# ---------------------------------------------------------------------------
# Argument pre-pass: find --resume/--out-dir so stored config can seed
# defaults before the main parse applies CLI overrides.
# ---------------------------------------------------------------------------
pre_pass() {
  while (($#)); do
    case "$1" in
      -h | --help)
        # Help is side-effect free even when combined with --resume. Handle it
        # before resolving or locking any caller-supplied bundle path.
        usage
        exit 0
        ;;
      --dry-run)
        # A dry run must stay read-only everywhere, including the early resume
        # branch (interrupted-initialization recovery) before parse_args runs.
        DRY_RUN=1
        shift
        ;;
      --resume)
        RESUME_DIR="${2:?--resume needs a directory}"
        shift 2
        ;;
      --out-dir)
        OUT_DIR="${2:?--out-dir needs a directory}"
        OUT_DIR_EXPLICIT=1
        shift 2
        ;;
      *) shift ;;
    esac
  done
}

apply_mode_preset() {
  case "$MODE" in
    quick)
      BASELINE_CHILDREN=8
      BASELINE_WAVES=10
      GROUP_WAVES=10
      INDIVIDUAL_RUNS=5
      [[ "$RUN_SCHEMA_VERSION" == 2 ]] && PINNED_CONCURRENT_ROUNDS=5
      GDB_MAX_RUNS=6
      ;;
    full)
      BASELINE_CHILDREN=16
      BASELINE_WAVES=100
      GROUP_WAVES=100
      INDIVIDUAL_RUNS=400
      [[ "$RUN_SCHEMA_VERSION" == 2 ]] && PINNED_CONCURRENT_ROUNDS=400
      GDB_MAX_RUNS=24
      ;;
    default) : ;;
    *) diag_die "unknown mode '$MODE'" ;;
  esac
}

validate_count_config() {
  local label value
  while (($#)); do
    label="$1"
    value="$2"
    shift 2
    diag_is_safe_positive_uint "$value" ||
      diag_die "$label must be a canonical safe positive integer, got '$value'"
  done
}

load_stored_config() {
  local meta="$1/results/meta.env"
  [[ -d "$1/results" && ! -L "$1/results" ]] ||
    diag_die "stored results directory must be a real non-symlink directory"
  if [[ -e "$meta" || -L "$meta" ]]; then
    [[ -f "$meta" && ! -L "$meta" ]] ||
      diag_die "stored run metadata must be a real non-symlink regular file"
  else
    return 0
  fi
  # Bundles created before schema 2 remain on their original CPU-major
  # protocol. They must never silently acquire a newly introduced stress
  # phase merely because a newer diagnose.sh resumes them.
  RUN_SCHEMA_VERSION=1
  PINNED_CONCURRENT_ROUNDS=0
  SKIP_PINNED_CONCURRENT=1
  PROTOCOL_SEED="legacy"
  TELEMETRY_INTERVAL_MS=250
  local k v
  local -A config_seen=()
  while IFS='=' read -r k v || [[ -n "$k" || -n "$v" ]]; do
    case "$k" in
      MODE | RUN_SCHEMA_VERSION | BASELINE_CHILDREN | BASELINE_WAVES | GROUP_WAVES | \
        INDIVIDUAL_RUNS | PINNED_CONCURRENT_ROUNDS | PROTOCOL_SEED | \
        SKIP_PINNED_CONCURRENT | TELEMETRY_INTERVAL_MS | GDB_MAX_RUNS | SKIP_GDB | CPU_TARGET)
        [[ -z "${config_seen[$k]:-}" ]] || diag_die "stored metadata contains duplicate $k rows"
        config_seen[$k]=1
        ;;
    esac
    case "$k" in
      MODE) MODE="$v" ;;
      RUN_SCHEMA_VERSION)
        [[ "$v" == 1 || "$v" == 2 ]] ||
          diag_die "stored RUN_SCHEMA_VERSION must be 1 or 2, got '$v'"
        RUN_SCHEMA_VERSION="$v"
        ;;
      BASELINE_CHILDREN)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored BASELINE_CHILDREN must be a canonical safe positive integer, got '$v'"
        BASELINE_CHILDREN="$v"
        ;;
      BASELINE_WAVES)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored BASELINE_WAVES must be a canonical safe positive integer, got '$v'"
        BASELINE_WAVES="$v"
        ;;
      GROUP_WAVES)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored GROUP_WAVES must be a canonical safe positive integer, got '$v'"
        GROUP_WAVES="$v"
        ;;
      INDIVIDUAL_RUNS)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored INDIVIDUAL_RUNS must be a canonical safe positive integer, got '$v'"
        INDIVIDUAL_RUNS="$v"
        ;;
      PINNED_CONCURRENT_ROUNDS)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored PINNED_CONCURRENT_ROUNDS must be a canonical safe positive integer, got '$v'"
        PINNED_CONCURRENT_ROUNDS="$v"
        ;;
      PROTOCOL_SEED)
        [[ "$v" =~ ^(0|[1-9][0-9]*)$ ]] && ((${#v} < 10 || (${#v} == 10 && v <= PROTOCOL_SEED_MAX))) ||
          diag_die "stored PROTOCOL_SEED must be a canonical uint32, got '$v'"
        PROTOCOL_SEED="$v"
        ;;
      SKIP_PINNED_CONCURRENT) SKIP_PINNED_CONCURRENT="$v" ;;
      TELEMETRY_INTERVAL_MS)
        diag_is_safe_positive_uint "$v" && ((v >= 50 && v <= 60000)) ||
          diag_die "stored TELEMETRY_INTERVAL_MS must be 50..60000, got '$v'"
        TELEMETRY_INTERVAL_MS="$v"
        ;;
      GDB_MAX_RUNS)
        diag_is_safe_positive_uint "$v" ||
          diag_die "stored GDB_MAX_RUNS must be a canonical safe positive integer, got '$v'"
        ((v <= GDB_MAX_RUNS_LIMIT)) ||
          diag_die "stored GDB_MAX_RUNS must be at most $GDB_MAX_RUNS_LIMIT, got '$v'"
        GDB_MAX_RUNS="$v"
        ;;
      SKIP_GDB) SKIP_GDB="$v" ;;
      CPU_TARGET)
        [[ "$v" == auto || "$v" =~ ^(0|[1-9][0-9]*)$ ]] ||
          diag_die "stored CPU_TARGET must be auto or a canonical non-negative integer, got '$v'"
        CPU_TARGET="$v"
        ;;
    esac
  done < "$meta"
  [[ -n "${config_seen[BASELINE_CHILDREN]:-}" && -n "${config_seen[BASELINE_WAVES]:-}" &&
    -n "${config_seen[GROUP_WAVES]:-}" ]] ||
    diag_die "stored metadata is missing its exact baseline/group configuration"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    local required_new_key
    for required_new_key in RUN_SCHEMA_VERSION PINNED_CONCURRENT_ROUNDS PROTOCOL_SEED \
      SKIP_PINNED_CONCURRENT TELEMETRY_INTERVAL_MS; do
      [[ -n "${config_seen[$required_new_key]:-}" ]] ||
        diag_die "schema 2 stored metadata is missing $required_new_key"
    done
  else
    local unexpected_new_key
    for unexpected_new_key in PINNED_CONCURRENT_ROUNDS PROTOCOL_SEED \
      SKIP_PINNED_CONCURRENT TELEMETRY_INTERVAL_MS; do
      [[ -z "${config_seen[$unexpected_new_key]:-}" ]] ||
        diag_die "legacy stored metadata unexpectedly contains $unexpected_new_key"
    done
  fi
  apply_cpu_target_runtime
}

apply_cpu_target_runtime() {
  if [[ "$CPU_TARGET" == auto ]]; then
    WORST_CPU_OVERRIDE=""
  else
    WORST_CPU_OVERRIDE="$CPU_TARGET"
  fi
}

parse_args() {
  local -a argv=("$@")
  local mode_count=0
  # Resolve the preset first so explicit numeric overrides have the same
  # precedence regardless of where the mode flag appears.
  while (($#)); do
    case "$1" in
      --quick)
        MODE="quick"
        MODE_EXPLICIT=1
        mode_count=$((mode_count + 1))
        shift
        ;;
      --full)
        MODE="full"
        MODE_EXPLICIT=1
        mode_count=$((mode_count + 1))
        shift
        ;;
      --resume | --out-dir | --redo | --individual-runs | --pinned-concurrent-rounds | \
        --protocol-seed | --telemetry-interval-ms | --group-waves | --gdb-max-runs | --cpu)
        (($# >= 2)) || diag_die "$1 needs a value"
        shift 2
        ;;
      *) shift ;;
    esac
  done
  ((mode_count <= 1)) || diag_die "pick at most one mode (--quick or --full)"
  ((mode_count == 0)) || apply_mode_preset

  set -- "${argv[@]}"
  while (($#)); do
    case "$1" in
      --quick | --full) shift ;;
      --resume) RESUME_DIR="${2:?}"; shift 2 ;;
      --out-dir) OUT_DIR="${2:?}"; OUT_DIR_EXPLICIT=1; shift 2 ;;
      --skip-gdb)
        SKIP_GDB=1
        SKIP_GDB_EXPLICIT=1
        SKIP_GDB_FLAG_SEEN=1
        shift
        ;;
      --run-gdb)
        SKIP_GDB=0
        SKIP_GDB_EXPLICIT=1
        RUN_GDB_FLAG_SEEN=1
        shift
        ;;
      --redo) REDO_PHASES="${2:?--redo needs a phase list}"; shift 2 ;;
      --individual-runs) INDIVIDUAL_RUNS="${2:?}"; INDIVIDUAL_RUNS_EXPLICIT=1; shift 2 ;;
      --pinned-concurrent-rounds)
        PINNED_CONCURRENT_ROUNDS="${2:?}"
        PINNED_CONCURRENT_ROUNDS_EXPLICIT=1
        shift 2
        ;;
      --protocol-seed)
        PROTOCOL_SEED="${2:?}"
        PROTOCOL_SEED_EXPLICIT=1
        shift 2
        ;;
      --skip-pinned-concurrent)
        SKIP_PINNED_CONCURRENT=1
        SKIP_PINNED_CONCURRENT_EXPLICIT=1
        SKIP_PINNED_CONCURRENT_FLAG_SEEN=1
        shift
        ;;
      --run-pinned-concurrent)
        SKIP_PINNED_CONCURRENT=0
        SKIP_PINNED_CONCURRENT_EXPLICIT=1
        RUN_PINNED_CONCURRENT_FLAG_SEEN=1
        shift
        ;;
      --telemetry-interval-ms)
        TELEMETRY_INTERVAL_MS="${2:?}"
        TELEMETRY_INTERVAL_MS_EXPLICIT=1
        shift 2
        ;;
      --group-waves) GROUP_WAVES="${2:?}"; GROUP_WAVES_EXPLICIT=1; shift 2 ;;
      --gdb-max-runs) GDB_MAX_RUNS="${2:?}"; GDB_MAX_RUNS_EXPLICIT=1; shift 2 ;;
      --cpu)
        ((CPU_FLAG_SEEN == 0)) || diag_die "--cpu may be specified only once"
        CPU_FLAG_SEEN=1
        CPU_TARGET="${2:?}"
        CPU_EXPLICIT=1
        apply_cpu_target_runtime
        shift 2
        ;;
      --dry-run) DRY_RUN=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) diag_die "unknown option '$1' (see --help)" ;;
    esac
  done
  ((SKIP_GDB_FLAG_SEEN == 0 || RUN_GDB_FLAG_SEEN == 0)) ||
    diag_die "--skip-gdb and --run-gdb conflict; pick one"
  ((SKIP_PINNED_CONCURRENT_FLAG_SEEN == 0 || RUN_PINNED_CONCURRENT_FLAG_SEEN == 0)) ||
    diag_die "--skip-pinned-concurrent and --run-pinned-concurrent conflict; pick one"
}

validate_config() {
  case "$MODE" in
    default | quick | full) ;;
    *) diag_die "stored mode must be default, quick, or full, got '$MODE'" ;;
  esac
  validate_count_config \
    "--individual-runs" "$INDIVIDUAL_RUNS" \
    "--group-waves" "$GROUP_WAVES" \
    "--gdb-max-runs" "$GDB_MAX_RUNS" \
    "baseline children" "$BASELINE_CHILDREN" \
    "baseline waves" "$BASELINE_WAVES"
  [[ "$RUN_SCHEMA_VERSION" == 1 || "$RUN_SCHEMA_VERSION" == 2 ]] ||
    diag_die "RUN_SCHEMA_VERSION must be 1 or 2"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    validate_count_config "--pinned-concurrent-rounds" "$PINNED_CONCURRENT_ROUNDS"
    [[ "$PROTOCOL_SEED" == auto || "$PROTOCOL_SEED" =~ ^(0|[1-9][0-9]*)$ ]] ||
      diag_die "--protocol-seed must be auto or a canonical uint32"
    if [[ "$PROTOCOL_SEED" != auto ]]; then
      ((${#PROTOCOL_SEED} < 10 || (${#PROTOCOL_SEED} == 10 && PROTOCOL_SEED <= PROTOCOL_SEED_MAX))) ||
        diag_die "--protocol-seed must be at most $PROTOCOL_SEED_MAX"
    fi
    [[ "$SKIP_PINNED_CONCURRENT" == 0 || "$SKIP_PINNED_CONCURRENT" == 1 ]] ||
      diag_die "stored SKIP_PINNED_CONCURRENT must be 0 or 1"
    diag_is_safe_positive_uint "$TELEMETRY_INTERVAL_MS" &&
      ((TELEMETRY_INTERVAL_MS >= 50 && TELEMETRY_INTERVAL_MS <= 60000)) ||
      diag_die "--telemetry-interval-ms must be an integer from 50 through 60000"
    if [[ -n "$RESUME_DIR" && "$PROTOCOL_SEED_EXPLICIT" == 1 && "$PROTOCOL_SEED" == auto ]]; then
      diag_die "--protocol-seed auto is only valid for a fresh bundle; resume uses its persisted concrete seed"
    fi
  elif ((PINNED_CONCURRENT_ROUNDS_EXPLICIT == 1 || PROTOCOL_SEED_EXPLICIT == 1 ||
    SKIP_PINNED_CONCURRENT_EXPLICIT == 1 || TELEMETRY_INTERVAL_MS_EXPLICIT == 1)); then
    diag_die "this legacy bundle cannot be upgraded to the schema 2 pinned protocol in place; start a fresh bundle"
  fi
  ((GDB_MAX_RUNS <= GDB_MAX_RUNS_LIMIT)) ||
    diag_die "--gdb-max-runs must be at most $GDB_MAX_RUNS_LIMIT, got '$GDB_MAX_RUNS'"
  [[ "$SKIP_GDB" == "0" || "$SKIP_GDB" == "1" ]] ||
    diag_die "stored SKIP_GDB must be 0 or 1, got '$SKIP_GDB'"
  [[ "$CPU_TARGET" == auto || "$CPU_TARGET" =~ ^(0|[1-9][0-9]*)$ ]] ||
    diag_die "--cpu must be auto or a canonical non-negative integer, got '$CPU_TARGET'"
  apply_cpu_target_runtime
  if [[ -n "$REDO_PHASES" && -z "$RESUME_DIR" ]]; then
    diag_die "--redo requires --resume DIR (it re-runs phases of an existing bundle)"
  fi
  build_redo_plan
}

resolve_protocol_seed() {
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] || return 0
  [[ "$PROTOCOL_SEED" == auto ]] || return 0
  PROTOCOL_SEED="$($DIAG_INDIVIDUAL_NODE_BIN -e \
    'process.stdout.write(String(require("node:crypto").randomBytes(4).readUInt32LE(0)))')" ||
    diag_die "cannot generate the persisted protocol seed"
  [[ "$PROTOCOL_SEED" =~ ^(0|[1-9][0-9]*)$ ]] &&
    ((${#PROTOCOL_SEED} < 10 || (${#PROTOCOL_SEED} == 10 && PROTOCOL_SEED <= PROTOCOL_SEED_MAX))) ||
    diag_die "generated protocol seed is malformed"
}

require_dependencies() {
  local -a missing=()
  local command_name
  for command_name in "${REQUIRED_COMMANDS[@]}"; do
    command -v "$command_name" > /dev/null 2>&1 || missing+=("$command_name")
  done
  ((${#missing[@]} == 0)) ||
    diag_die "required commands missing from PATH: ${missing[*]}"
}

# ---------------------------------------------------------------------------
# Output-directory / meta helpers
# ---------------------------------------------------------------------------
META_FILE=""
STATE_DIR=""

bundle_owned_real_dir() {
  local path="$1" owner
  [[ -d "$path" && ! -L "$path" && -r "$path" && -w "$path" && -x "$path" ]] || return 1
  owner="$(stat -c '%u' -- "$path" 2> /dev/null)" || return 1
  [[ "$owner" == "$EUID" ]]
}

bundle_owned_single_regular() {
  local path="$1" metadata owner links
  [[ -f "$path" && ! -L "$path" && -r "$path" && -w "$path" ]] || return 1
  metadata="$(stat -c '%u:%h' -- "$path" 2> /dev/null)" || return 1
  [[ "$metadata" =~ ^([0-9]+):([0-9]+)$ ]] || return 1
  owner="${BASH_REMATCH[1]}"
  links="${BASH_REMATCH[2]}"
  [[ "$owner" == "$EUID" && "$links" == 1 ]]
}

bundle_create_empty_exclusive() {
  local path="$1" mode="${2:-0644}"
  [[ ! -e "$path" && ! -L "$path" ]] || return 1
  (umask 077; set -o noclobber; : > "$path") 2> /dev/null || return 1
  chmod "$mode" -- "$path" || return 1
  bundle_owned_single_regular "$path"
}

bundle_prepare_dir() {
  local relative="$1" path parent
  path="$OUT_DIR/$relative"
  parent="${relative%/*}"
  if [[ "$parent" == "$relative" ]]; then
    parent="$OUT_DIR"
  else
    parent="$OUT_DIR/$parent"
  fi
  bundle_owned_real_dir "$parent" || return 1
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    mkdir -- "$path" || return 1
  fi
  bundle_owned_real_dir "$path"
}

phase_name_supported() {
  case "$1" in
    preflight | baseline | groups | individual | pinned-concurrent | \
      pinned-concurrent-unavailable | frequency | gdb) return 0 ;;
  esac
  return 1
}

# Legacy bundles have no pinned-concurrent phase. Accepting a marker or any
# evidence for it would let a newer runner silently relabel schema-1 history.
validate_loaded_schema_artifacts() {
  [[ "$RUN_SCHEMA_VERSION" == 1 ]] || return 0
  local marker="$STATE_DIR/phase-pinned-concurrent.done"
  [[ ! -e "$marker" && ! -L "$marker" ]] ||
    diag_die "legacy bundle contains a schema-2 pinned-concurrent completion marker"
  phase_attempt_is_meaningful pinned-concurrent &&
    diag_die "legacy bundle contains schema-2 pinned-concurrent artifacts"
  return 0
}

phase_marker_is_valid() {
  local phase="$1" marker metadata
  phase_name_supported "$phase" || return 1
  marker="$STATE_DIR/phase-$phase.done"
  bundle_owned_single_regular "$marker" || return 1
  metadata="$(stat -c '%s' -- "$marker" 2> /dev/null)" || return 1
  [[ "$metadata" == 0 ]]
}

bundle_mutable_graph_validate() {
  local relative path name current_id
  [[ -n "$DIAG_BUNDLE_LOCK_ID" ]] ||
    diag_die "mutable bundle validation requires the writer lock"
  current_id="$(stat -Lc '%d:%i' -- "$OUT_DIR" 2> /dev/null)" ||
    diag_die "cannot inspect the locked diagnostics bundle"
  [[ "$current_id" == "$DIAG_BUNDLE_LOCK_ID" ]] ||
    diag_die "diagnostics bundle changed after its writer lock was acquired"
  bundle_owned_real_dir "$OUT_DIR" ||
    diag_die "diagnostics bundle must be an owned, writable real directory"

  for relative in results logs state env freq gdb telemetry \
    logs/individual logs/gdb logs/pinned-concurrent \
    state/individual-attempts state/individual-finalize \
    state/pinned-concurrent-waves state/pinned-concurrent-finalize \
    state/telemetry-baseline state/telemetry-groups state/telemetry-individual \
    state/telemetry-pinned-concurrent state/telemetry-gdb \
    telemetry/baseline telemetry/groups telemetry/individual \
    telemetry/pinned-concurrent telemetry/gdb; do
    path="$OUT_DIR/$relative"
    [[ ! -e "$path" && ! -L "$path" ]] && continue
    bundle_owned_real_dir "$path" ||
      diag_die "mutable bundle directory '$relative' is unsafe"
  done

  bundle_owned_real_dir "$OUT_DIR/results" &&
    bundle_owned_single_regular "$OUT_DIR/results/meta.env" ||
    diag_die "resume directory '$OUT_DIR' is not a safe diagnostic bundle"
  [[ ! -e "$OUT_DIR/.meta.env.initializing" &&
    ! -L "$OUT_DIR/.meta.env.initializing" ]] ||
    diag_die "resume bundle contains an incomplete metadata initializer"
  [[ ! -e "$OUT_DIR/results/.meta.env.initializing" &&
    ! -L "$OUT_DIR/results/.meta.env.initializing" ]] ||
    diag_die "resume bundle contains a legacy incomplete metadata initializer"

  for relative in results/meta.env commands.log run.log state/redo.pending; do
    path="$OUT_DIR/$relative"
    [[ ! -e "$path" && ! -L "$path" ]] && continue
    bundle_owned_single_regular "$path" ||
      diag_die "mutable bundle file '$relative' is unsafe"
  done

  for path in "$OUT_DIR"/state/phase-*.done; do
    [[ -e "$path" || -L "$path" ]] || continue
    name="${path##*/phase-}"
    name="${name%.done}"
    phase_marker_is_valid "$name" ||
      diag_die "completion marker '${path#"$OUT_DIR"/}' is unsafe"
  done
}

# A crash during fresh bundle initialization can strand a narrow set of
# artifacts: the empty preparation directories, the operational logs, the
# initial metadata (possibly only partially written), atomic metadata rewrite
# temps, and the legacy initializer sentinel. Such a tree holds no evidence
# and no resumable state, so a resume may discard exactly that validated set
# and continue as a fresh run on the same directory. Anything beyond the set
# means the bundle saw real work; recovery then refuses and the caller falls
# through to the ordinary resume validation, which fails closed as before.
fresh_init_meta_key() {
  case "$1" in
    MODE | RUN_SCHEMA_VERSION | START_EPOCH | START_ISO | BASELINE_CHILDREN | BASELINE_WAVES | \
      GROUP_WAVES | INDIVIDUAL_RUNS | PINNED_CONCURRENT_ROUNDS | PROTOCOL_SEED | \
      SKIP_PINNED_CONCURRENT | TELEMETRY_INTERVAL_MS | GDB_MAX_RUNS | SKIP_GDB | CPU_TARGET | \
      INTERRUPTED)
      return 0
      ;;
  esac
  return 1
}

fresh_init_meta_is_partial_config() {
  # Every line must be KEY=VALUE with an initialization key. The writer could
  # have died anywhere inside the initial block, so an empty file, missing
  # keys, duplicates, and a truncated trailing value are all acceptable;
  # unknown keys and malformed lines are not. The genuine block is a handful
  # of lines, so the read stays size-bounded.
  local path="$1" size line key
  size="$(stat -c '%s' -- "$path" 2> /dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  ((size <= 4096)) || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"
    fresh_init_meta_key "$key" || return 1
  done < "$path"
}

fresh_init_interrupted_recover() {
  [[ -n "$DIAG_BUNDLE_LOCK_ID" ]] ||
    diag_die "fresh initialization recovery requires the writer lock"
  local current_id
  current_id="$(stat -Lc '%d:%i' -- "$OUT_DIR" 2> /dev/null)" ||
    diag_die "cannot inspect the locked diagnostics bundle"
  [[ "$current_id" == "$DIAG_BUNDLE_LOCK_ID" ]] ||
    diag_die "diagnostics bundle changed after its writer lock was acquired"
  bundle_owned_real_dir "$OUT_DIR" || return 1

  # Survey the locked bundle first. Deletion starts only once every present
  # entry is proven to be an initialization artifact.
  local -a init_files=() init_dirs=()
  local entry name sub subname
  for entry in "$OUT_DIR"/* "$OUT_DIR"/.[!.]* "$OUT_DIR"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    case "$name" in
      results)
        bundle_owned_real_dir "$entry" || return 1
        for sub in "$entry"/* "$entry"/.[!.]* "$entry"/..?*; do
          [[ -e "$sub" || -L "$sub" ]] || continue
          subname="${sub##*/}"
          case "$subname" in
            meta.env)
              bundle_owned_single_regular "$sub" || return 1
              fresh_init_meta_is_partial_config "$sub" || return 1
              init_files+=("results/meta.env")
              ;;
            .meta.env.initializing)
              bundle_owned_single_regular "$sub" || return 1
              init_files+=("results/.meta.env.initializing")
              ;;
            *)
              [[ "$subname" =~ ^\.meta\.env\.[A-Za-z0-9]{6}$ ]] || return 1
              bundle_owned_single_regular "$sub" || return 1
              init_files+=("results/$subname")
              ;;
          esac
        done
        init_dirs+=("results")
        ;;
      logs)
        bundle_owned_real_dir "$entry" || return 1
        for sub in "$entry"/* "$entry"/.[!.]* "$entry"/..?*; do
          [[ -e "$sub" || -L "$sub" ]] || continue
          [[ "${sub##*/}" == individual ]] || return 1
          bundle_owned_real_dir "$sub" || return 1
          if find "$sub" -mindepth 1 -print -quit | grep -q .; then return 1; fi
          init_dirs+=("logs/individual")
        done
        init_dirs+=("logs")
        ;;
      state | env | freq | gdb)
        bundle_owned_real_dir "$entry" || return 1
        if find "$entry" -mindepth 1 -print -quit | grep -q .; then return 1; fi
        init_dirs+=("$name")
        ;;
      run.log | commands.log | .meta.env.initializing)
        bundle_owned_single_regular "$entry" || return 1
        init_files+=("$name")
        ;;
      *)
        return 1
        ;;
    esac
  done

  # Every present entry is an initialization artifact. A dry run must not
  # mutate the bundle: report the recovery the real run would perform.
  if ((DRY_RUN == 1)); then
    diag_warn "would recover an interrupted fresh bundle initialization: would discard partial initialization artifacts and continue as a fresh run in '$OUT_DIR'"
    return 0
  fi

  # Every present entry is an initialization artifact. Re-validate each one
  # immediately before its deletion; if anything changed since the survey,
  # abandon recovery and let the ordinary resume validation fail closed on
  # what remains.
  local victim
  for victim in "${init_files[@]}"; do
    bundle_owned_single_regular "$OUT_DIR/$victim" || return 1
    rm -f -- "$OUT_DIR/$victim" || return 1
    [[ ! -e "$OUT_DIR/$victim" && ! -L "$OUT_DIR/$victim" ]] || return 1
  done
  for victim in "${init_dirs[@]}"; do
    bundle_owned_real_dir "$OUT_DIR/$victim" || return 1
    if find "$OUT_DIR/$victim" -mindepth 1 -print -quit | grep -q .; then return 1; fi
    rmdir -- "$OUT_DIR/$victim" || return 1
  done
  sync -f "$OUT_DIR" > /dev/null 2>&1 || return 1
  diag_warn "recovered an interrupted fresh bundle initialization: discarded partial initialization artifacts; continuing as a fresh run in '$OUT_DIR'"
  return 0
}

meta_set() {
  local k="$1" v="$2"
  if [[ -f "$META_FILE" ]] && grep -q "^${k}=" "$META_FILE"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$META_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$META_FILE"
  fi
}

PHASE_MARKER_FD=""
PHASE_MARKER_ID=""
PHASE_MARKER_FD_PATH=""

phase_marker_fd_close() {
  if [[ -n "$PHASE_MARKER_FD" ]]; then
    exec {PHASE_MARKER_FD}>&- || return 1
  fi
  PHASE_MARKER_FD=""
  PHASE_MARKER_ID=""
  PHASE_MARKER_FD_PATH=""
}

phase_marker_owned_identity() {
  local phase="$1" expected_id="$2" marker metadata
  phase_name_supported "$phase" || return 1
  marker="$STATE_DIR/phase-$phase.done"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  metadata="$(stat -Lc '%d:%i:%u:%h:%s' -- "$marker" 2> /dev/null)" || return 1
  [[ "$metadata" == "$expected_id:$EUID:1:0" ]]
}

phase_marker_path_matches_open_fd() {
  local phase="$1" marker="$STATE_DIR/phase-$1.done"
  [[ -n "$PHASE_MARKER_FD" && -n "$PHASE_MARKER_FD_PATH" ]] || return 1
  [[ -f "$marker" && ! -L "$marker" && -O "$marker" ]] || return 1
  [[ "$marker" -ef "$PHASE_MARKER_FD_PATH" ]]
}

phase_marker_capture_identity() {
  stat -Lc '%d:%i' -- "$1" 2> /dev/null
}

phase_marker_open_exclusive() {
  local phase="$1" marker="$STATE_DIR/phase-$1.done" old_umask open_rc=0
  PHASE_MARKER_FD=""
  PHASE_MARKER_ID=""
  PHASE_MARKER_FD_PATH=""
  [[ ! -e "$marker" && ! -L "$marker" ]] || return 1

  # A mode-000 inode is not a valid completion marker. Keep it that way until
  # its identity is known through the still-open descriptor, then publish its
  # ordinary mode and validate the path-to-inode binding.
  old_umask="$(umask)"
  umask 0777
  if [[ -o noclobber ]]; then
    { exec {PHASE_MARKER_FD}> "$marker"; } 2> /dev/null || open_rc=$?
  else
    set -o noclobber
    { exec {PHASE_MARKER_FD}> "$marker"; } 2> /dev/null || open_rc=$?
    set +o noclobber
  fi
  umask "$old_umask"
  ((open_rc == 0)) || return 1

  PHASE_MARKER_FD_PATH="/proc/$BASHPID/fd/$PHASE_MARKER_FD"
  PHASE_MARKER_ID="$(phase_marker_capture_identity "$PHASE_MARKER_FD_PATH")" || return 1
  chmod 0644 -- "$PHASE_MARKER_FD_PATH" || return 1
  phase_marker_owned_identity "$phase" "$PHASE_MARKER_ID" || return 1
  phase_marker_is_valid "$phase"
}

mark_done() {
  local phase="$1" marker published_id meta_before_id meta_after_id expected_meta_hash actual_meta_hash
  phase_name_supported "$phase" || diag_die "cannot complete unknown phase '$phase'"
  marker="$STATE_DIR/phase-$phase.done"
  bundle_owned_real_dir "$STATE_DIR" || diag_die "phase completion state directory is unsafe"
  [[ ! -e "$marker" && ! -L "$marker" ]] ||
    diag_die "cannot create a fresh $phase completion marker"
  if ! phase_marker_open_exclusive "$phase"; then
    if [[ -n "$PHASE_MARKER_FD" ]]; then
      phase_marker_publish_rollback "$phase" "$PHASE_MARKER_ID" ||
        diag_die "cannot safely roll back a failed $phase completion marker creation"
    fi
    diag_die "cannot create a fresh $phase completion marker"
  fi
  if ! sync -f "$PHASE_MARKER_FD_PATH"; then
    phase_marker_publish_rollback "$phase" "$PHASE_MARKER_ID" ||
      diag_die "cannot safely roll back an unsynchronized $phase completion marker"
    diag_die "cannot synchronize $phase completion marker"
  fi
  phase_marker_owned_identity "$phase" "$PHASE_MARKER_ID" &&
    phase_marker_is_valid "$phase" || {
      phase_marker_publish_rollback "$phase" "$PHASE_MARKER_ID" ||
        diag_die "cannot safely roll back a replaced $phase completion marker"
      diag_die "$phase completion marker changed during publication"
    }
  if ! sync -f "$STATE_DIR"; then
    phase_marker_publish_rollback "$phase" "$PHASE_MARKER_ID" ||
      diag_die "cannot safely roll back $phase completion marker after directory sync failure"
    diag_die "cannot synchronize phase completion state directory"
  fi
  published_id="$PHASE_MARKER_ID"
  if ! phase_marker_published_fd_close; then
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after descriptor close failure"
    diag_die "cannot close $phase completion marker"
  fi
  bundle_owned_single_regular "$META_FILE" || {
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after unsafe metadata"
    diag_die "cannot inspect safe metadata before publishing phase completion"
  }
  meta_before_id="$(stat -Lc '%d:%i' -- "$META_FILE" 2> /dev/null)" || {
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after metadata inspection failure"
    diag_die "cannot identify metadata before publishing phase completion"
  }
  expected_meta_hash="$(completion_metadata_expected_hash)" || {
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after metadata projection failure"
    diag_die "cannot project completed phase metadata"
  }
  phase_completion_before_meta_recheck || {
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after metadata precheck failure"
    diag_die "cannot complete metadata publication precheck"
  }
  if [[ "$(stat -Lc '%d:%i' -- "$META_FILE" 2> /dev/null)" != "$meta_before_id" ]]; then
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after metadata changed"
    diag_die "metadata changed while preparing phase completion publication"
  fi
  if ! (rewrite_meta_atomic 0 1); then
    bundle_owned_single_regular "$META_FILE" ||
      phase_completion_rewrite_failure_fail "$phase" "$published_id" \
        "metadata became unsafe during phase completion publication"
    meta_after_id="$(stat -Lc '%d:%i' -- "$META_FILE" 2> /dev/null)" ||
      phase_completion_rewrite_failure_fail "$phase" "$published_id" \
        "cannot identify metadata after phase completion publication failure"
    if [[ "$meta_after_id" == "$meta_before_id" ]]; then
      phase_marker_publish_rollback "$phase" "$published_id" ||
        diag_die "cannot safely roll back $phase completion marker after metadata failure"
      diag_die "cannot publish completed phase metadata"
    fi
    actual_meta_hash="$(sha256sum -- "$META_FILE" 2> /dev/null | awk '{print $1}')" ||
      phase_completion_rewrite_failure_fail "$phase" "$published_id" \
        "cannot validate renamed metadata after completion publication failure"
    [[ -n "$actual_meta_hash" && "$actual_meta_hash" == "$expected_meta_hash" ]] ||
      phase_completion_rewrite_failure_fail "$phase" "$published_id" \
        "metadata was unexpectedly replaced during phase completion publication"
    diag_die "completed phase metadata crossed its rename commit point but directory synchronization failed; retaining its matching marker"
  fi
  phase_completion_after_meta_rewrite ||
    phase_completion_nominal_success_fail "$phase" "$published_id" \
      "cannot complete metadata publication verification"
  bundle_owned_single_regular "$META_FILE" ||
    phase_completion_nominal_success_fail "$phase" "$published_id" \
      "published completed phase metadata is unsafe"
  meta_after_id="$(stat -Lc '%d:%i' -- "$META_FILE" 2> /dev/null)" ||
    phase_completion_nominal_success_fail "$phase" "$published_id" \
      "cannot identify published completed phase metadata"
  if [[ "$meta_after_id" == "$meta_before_id" ]]; then
    phase_marker_publish_rollback "$phase" "$published_id" ||
      diag_die "cannot safely roll back $phase completion marker after metadata rename was not observed"
    diag_die "completed phase metadata did not cross its rename commit point"
  fi
  actual_meta_hash="$(sha256sum -- "$META_FILE" 2> /dev/null | awk '{print $1}')" ||
    phase_completion_nominal_success_fail "$phase" "$published_id" \
      "cannot validate published completed phase metadata"
  [[ -n "$actual_meta_hash" && "$actual_meta_hash" == "$expected_meta_hash" ]] ||
    phase_completion_nominal_success_fail "$phase" "$published_id" \
      "published completed phase metadata does not match its expected generation"
  SESSION_DID_WORK=1
}

phase_marker_publish_rollback() {
  local phase="$1" expected_id="$2" marker="$STATE_DIR/phase-$1.done" rc=0
  bundle_owned_real_dir "$STATE_DIR" || rc=1
  if ((rc == 0)); then
    if [[ -n "$expected_id" ]]; then
      phase_marker_owned_identity "$phase" "$expected_id" || rc=1
    else
      phase_marker_path_matches_open_fd "$phase" || rc=1
    fi
  fi
  ((rc != 0)) || rm -f -- "$marker" || rc=1
  ((rc != 0)) || [[ ! -e "$marker" && ! -L "$marker" ]] || rc=1
  phase_marker_fd_close || rc=1
  ((rc != 0)) || sync -f "$STATE_DIR" > /dev/null 2>&1 || rc=1
  ((rc == 0))
}

phase_marker_published_fd_close() {
  phase_marker_fd_close
}

phase_is_done() {
  local phase="$1" marker
  phase_name_supported "$phase" || diag_die "unknown phase completion predicate '$phase'"
  marker="$STATE_DIR/phase-$phase.done"
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    return 1
  fi
  phase_marker_is_valid "$phase" || diag_die "$phase completion marker is unsafe"
}

sync_meta_completed() {
  local list="" phase
  local -a phases=(preflight baseline groups individual)
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && phases+=(pinned-concurrent)
  phases+=(frequency gdb)
  for phase in "${phases[@]}"; do
    if phase_is_done "$phase"; then
      list="${list:+$list,}$phase"
    fi
  done
  meta_set COMPLETED_PHASES "$list"
}

completion_metadata_expected_hash() {
  local completed line key
  completed="$(completed_phases_value)" || return 1
  {
    while IFS= read -r line || [[ -n "$line" ]]; do
      key="${line%%=*}"
      [[ "$key" != COMPLETED_PHASES ]] || continue
      printf '%s\n' "$line"
    done < "$META_FILE"
    printf 'COMPLETED_PHASES=%s\n' "$completed"
  } | sha256sum | awk '{print $1}'
}

phase_completion_before_meta_recheck() {
  :
}

phase_completion_after_meta_rewrite() {
  :
}

phase_completion_nominal_success_fail() {
  local phase="$1" published_id="$2" message="$3"
  phase_marker_publish_rollback "$phase" "$published_id" ||
    diag_die "cannot safely roll back $phase completion marker after metadata verification failure"
  diag_die "$message"
}

phase_completion_rewrite_failure_fail() {
  local phase="$1" published_id="$2" message="$3"
  phase_marker_publish_rollback "$phase" "$published_id" ||
    diag_die "cannot safely roll back $phase completion marker after metadata rewrite failure"
  diag_die "$message"
}

persist_effective_config() {
  rewrite_meta_atomic 1 0
}

completed_phases_value() {
  local list="" phase
  local -a phases=(preflight baseline groups individual)
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && phases+=(pinned-concurrent)
  phases+=(frequency gdb)
  for phase in "${phases[@]}"; do
    if phase_is_done "$phase"; then
      list="${list:+$list,}$phase"
    fi
  done
  printf '%s\n' "$list"
}

meta_config_rename() {
  mv -T -- "$1" "$2"
}

# Replace the persisted execution configuration as one rename while retaining
# every unrelated metadata row verbatim. Redo completion state joins that same
# atomic rewrite only after all evidence moves have completed.
rewrite_meta_atomic() {
  local include_config="$1" include_completed="$2" tmp line key completed="" meta_dir
  meta_dir="${META_FILE%/*}"
  tmp="$(mktemp "$meta_dir/.meta.env.XXXXXX")" ||
    diag_die "cannot prepare atomic metadata update"
  META_UPDATE_TEMP="$tmp"
  if ((include_completed == 1)); then
    completed="$(completed_phases_value)"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    case "$key" in
      MODE | RUN_SCHEMA_VERSION | BASELINE_CHILDREN | BASELINE_WAVES | GROUP_WAVES | \
        INDIVIDUAL_RUNS | PINNED_CONCURRENT_ROUNDS | PROTOCOL_SEED | \
        SKIP_PINNED_CONCURRENT | TELEMETRY_INTERVAL_MS | GDB_MAX_RUNS | SKIP_GDB | CPU_TARGET)
        if ((include_config == 1)); then continue; fi
        ;;
      COMPLETED_PHASES)
        if ((include_completed == 1)); then continue; fi
        ;;
    esac
    printf '%s\n' "$line" >> "$tmp" || {
      rm -f -- "$tmp"
      META_UPDATE_TEMP=""
      diag_die "cannot write atomic metadata update"
    }
  done < "$META_FILE"
  {
    if ((include_config == 1)); then
      printf 'MODE=%s\n' "$MODE"
      printf 'RUN_SCHEMA_VERSION=%s\n' "$RUN_SCHEMA_VERSION"
      printf 'BASELINE_CHILDREN=%s\n' "$BASELINE_CHILDREN"
      printf 'BASELINE_WAVES=%s\n' "$BASELINE_WAVES"
      printf 'GROUP_WAVES=%s\n' "$GROUP_WAVES"
      printf 'INDIVIDUAL_RUNS=%s\n' "$INDIVIDUAL_RUNS"
      if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
        printf 'PINNED_CONCURRENT_ROUNDS=%s\n' "$PINNED_CONCURRENT_ROUNDS"
        printf 'PROTOCOL_SEED=%s\n' "$PROTOCOL_SEED"
        printf 'SKIP_PINNED_CONCURRENT=%s\n' "$SKIP_PINNED_CONCURRENT"
        printf 'TELEMETRY_INTERVAL_MS=%s\n' "$TELEMETRY_INTERVAL_MS"
      fi
      printf 'GDB_MAX_RUNS=%s\n' "$GDB_MAX_RUNS"
      printf 'SKIP_GDB=%s\n' "$SKIP_GDB"
      printf 'CPU_TARGET=%s\n' "$CPU_TARGET"
    fi
    ((include_completed == 0)) || printf 'COMPLETED_PHASES=%s\n' "$completed"
  } >> "$tmp" || {
    rm -f -- "$tmp"
    META_UPDATE_TEMP=""
    diag_die "cannot write atomic metadata update"
  }
  chmod --reference="$META_FILE" "$tmp" || {
    rm -f -- "$tmp"
    META_UPDATE_TEMP=""
    diag_die "cannot protect atomic metadata update"
  }
  sync -f "$tmp" || {
    rm -f -- "$tmp"
    META_UPDATE_TEMP=""
    diag_die "cannot synchronize atomic metadata update"
  }
  meta_config_rename "$tmp" "$META_FILE" || {
    rm -f -- "$tmp"
    META_UPDATE_TEMP=""
    diag_die "cannot publish atomic metadata update"
  }
  META_UPDATE_TEMP=""
  sync -f "$meta_dir" || diag_die "cannot synchronize metadata directory"
}

redo_plan_contains() {
  local wanted="$1" phase
  for phase in "${REDO_PLAN[@]}"; do
    [[ "$phase" == "$wanted" ]] && return 0
  done
  return 1
}

phase_redo_is_authorized() {
  local phase="$1"
  redo_plan_contains "$phase" && return 0
  [[ -n "$REDO_TXN_ID" ]] && redo_transaction_has_phase "$phase"
}

bundle_path_is_meaningful() {
  local path="$1"
  [[ -e "$path" || -L "$path" ]] || return 1
  if [[ -d "$path" && ! -L "$path" ]]; then
    [[ -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2> /dev/null)" ]]
  else
    return 0
  fi
}

phase_attempt_is_meaningful() {
  local phase="$1" path
  local -a paths=()
  case "$phase" in
    baseline)
      paths=(results/baseline.meta logs/baseline freq/baseline.samples
        freq/baseline.method results/telemetry-baseline.tsv
        results/telemetry-baseline.meta telemetry/baseline state/telemetry-baseline)
      ;;
    groups)
      paths=(results/groups.tsv results/groups.meta logs/groups
        results/telemetry-groups.tsv results/telemetry-groups.meta
        telemetry/groups state/telemetry-groups)
      ;;
    individual)
      paths=(results/individual.tsv results/individual.meta
        results/individual.plan.tsv results/individual.boundaries.ndjson
        logs/individual state/individual-attempts state/individual-finalize
        results/telemetry-individual.tsv results/telemetry-individual.meta
        telemetry/individual state/telemetry-individual)
      ;;
    pinned-concurrent)
      paths=(results/pinned-concurrent.tsv results/pinned-concurrent.meta
        results/pinned-concurrent.groups.tsv results/pinned-concurrent.plan.tsv
        results/pinned-concurrent.boundaries.ndjson logs/pinned-concurrent
        state/pinned-concurrent-waves state/pinned-concurrent-finalize
        results/pinned-concurrent.unavailable.meta
        state/phase-pinned-concurrent-unavailable.done
        results/telemetry-pinned-concurrent.tsv
        results/telemetry-pinned-concurrent.meta telemetry/pinned-concurrent
        state/telemetry-pinned-concurrent)
      ;;
    frequency)
      paths=(results/frequency-ab.tsv results/frequency-ab.meta
        results/frequency-cap.tsv results/frequency-cap.meta)
      ;;
    gdb)
      paths=(results/gdb.meta results/gdb.manifest gdb logs/gdb
        results/telemetry-gdb.tsv results/telemetry-gdb.meta
        telemetry/gdb state/telemetry-gdb)
      ;;
    *) return 1 ;;
  esac
  for path in "${paths[@]}"; do
    bundle_path_is_meaningful "$OUT_DIR/$path" && return 0
  done
  if [[ "$phase" == groups ]]; then
    for path in "$OUT_DIR"/freq/group-*; do
      [[ -e "$path" || -L "$path" ]] && return 0
    done
  elif [[ "$phase" == frequency ]]; then
    for path in "$OUT_DIR"/freq/freq-ab-*; do
      [[ -e "$path" || -L "$path" ]] && return 0
    done
  elif [[ "$phase" == gdb ]]; then
    for path in "$OUT_DIR"/results/.gdb.manifest.* "$OUT_DIR"/results/.gdb.meta.*; do
      [[ -e "$path" || -L "$path" ]] && return 0
    done
  fi
  return 1
}

metadata_value() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" 2> /dev/null | tail -1
}

metadata_exact_value() {
  local file="$1" key="$2" count value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  count="$(grep -c "^${key}=" "$file" 2> /dev/null || true)"
  [[ "$count" == 1 ]] || return 1
  value="$(sed -n "s/^${key}=//p" "$file")"
  printf '%s\n' "$value"
}

stored_cpu_target_value() {
  local file="$1" count value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  count="$(grep -c '^CPU_TARGET=' "$file" 2> /dev/null || true)"
  if [[ "$count" == 0 ]]; then
    printf 'auto\n'
    return 0
  fi
  [[ "$count" == 1 ]] || return 1
  value="$(sed -n 's/^CPU_TARGET=//p' "$file")"
  [[ "$value" == auto || "$value" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  printf '%s\n' "$value"
}

resolve_cpu_target_policy() {
  local policy="$1"
  if [[ "$policy" == auto ]]; then
    worst_cpu
  elif [[ "$policy" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf '%s\n' "$policy"
  else
    return 1
  fi
}

cpu_target_matches_completed_phase() {
  local policy="$1" phase="$2" meta actual expected
  phase_is_done "$phase" || return 0
  case "$phase" in
    frequency) meta="$OUT_DIR/results/frequency-ab.meta" ;;
    gdb) meta="" ;;
    *) return 1 ;;
  esac
  if [[ "$phase" == gdb ]]; then
    # Only the fully validated GDB envelope authorizes a CPU binding. Skip
    # envelopes stay independent of the CPU selection policy.
    actual="$(gdb_completed_envelope_cpu 2> /dev/null || true)"
    [[ "$actual" == - ]] && return 0
  else
    actual="$(metadata_exact_value "$meta" CPU 2> /dev/null || true)"
  fi
  [[ "$actual" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  expected="$(resolve_cpu_target_policy "$policy" 2> /dev/null || true)"
  [[ -n "$expected" && "$actual" == "$expected" ]]
}

validate_cpu_target_for_completed_phases() {
  local target="$1" phase
  for phase in frequency gdb; do
    cpu_target_matches_completed_phase "$target" "$phase" ||
      require_redo_for_completed_change "$phase" \
        "CPU selection policy $target is incompatible with recorded $phase CPU evidence"
  done
}

require_redo_for_completed_change() {
  local phase="$1" description="$2" evidence_state=completed
  if ! phase_is_done "$phase"; then
    phase_attempt_is_meaningful "$phase" || return 0
    evidence_state=incomplete
  fi
  redo_plan_contains "$phase" && return 0
  if [[ -n "$STATE_DIR" ]] && [[ -e "$STATE_DIR/redo.pending" || -L "$STATE_DIR/redo.pending" ]] &&
    redo_transaction_has_phase "$phase"; then
    return 0
  fi
  diag_die "$description changes $evidence_state $phase evidence; resume with --redo $phase"
}

validate_completed_phase_overrides() {
  [[ -n "$RESUME_DIR" ]] || return 0
  local meta="$OUT_DIR/results/meta.env" stored

  if ((MODE_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" MODE)"
    if [[ "$stored" != "$MODE" ]]; then
      local phase
      for phase in baseline groups individual pinned-concurrent gdb; do
        require_redo_for_completed_change "$phase" "changing mode from $stored to $MODE"
      done
    fi
  fi
  if ((GROUP_WAVES_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" GROUP_WAVES)"
    [[ "$stored" == "$GROUP_WAVES" ]] ||
      require_redo_for_completed_change groups "changing --group-waves from $stored to $GROUP_WAVES"
  fi
  if ((INDIVIDUAL_RUNS_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" INDIVIDUAL_RUNS)"
    [[ "$stored" == "$INDIVIDUAL_RUNS" ]] ||
      require_redo_for_completed_change individual "changing --individual-runs from $stored to $INDIVIDUAL_RUNS"
  fi
  if ((PINNED_CONCURRENT_ROUNDS_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" PINNED_CONCURRENT_ROUNDS)"
    [[ "$stored" == "$PINNED_CONCURRENT_ROUNDS" ]] ||
      require_redo_for_completed_change pinned-concurrent \
        "changing --pinned-concurrent-rounds from $stored to $PINNED_CONCURRENT_ROUNDS"
  fi
  if ((PROTOCOL_SEED_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" PROTOCOL_SEED)"
    if [[ "$stored" != "$PROTOCOL_SEED" ]]; then
      require_redo_for_completed_change individual \
        "changing --protocol-seed from $stored to $PROTOCOL_SEED"
      require_redo_for_completed_change pinned-concurrent \
        "changing --protocol-seed from $stored to $PROTOCOL_SEED"
    fi
  fi
  if ((SKIP_PINNED_CONCURRENT_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" SKIP_PINNED_CONCURRENT)"
    if [[ "$stored" != "$SKIP_PINNED_CONCURRENT" ]] &&
      ! phase_redo_is_authorized pinned-concurrent; then
      diag_die "changing the pinned-concurrent skip choice on resume requires --redo pinned-concurrent"
    fi
    [[ "$stored" == "$SKIP_PINNED_CONCURRENT" ]] ||
      require_redo_for_completed_change pinned-concurrent \
        "changing the pinned-concurrent skip choice from $stored to $SKIP_PINNED_CONCURRENT"
  fi
  if ((TELEMETRY_INTERVAL_MS_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" TELEMETRY_INTERVAL_MS)"
    if [[ "$stored" != "$TELEMETRY_INTERVAL_MS" ]]; then
      local telemetry_phase
      for telemetry_phase in baseline groups individual pinned-concurrent gdb; do
        require_redo_for_completed_change "$telemetry_phase" \
          "changing --telemetry-interval-ms from $stored to $TELEMETRY_INTERVAL_MS"
      done
    fi
  fi
  if ((GDB_MAX_RUNS_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" GDB_MAX_RUNS)"
    [[ "$stored" == "$GDB_MAX_RUNS" ]] ||
      require_redo_for_completed_change gdb "changing --gdb-max-runs from $stored to $GDB_MAX_RUNS"
  fi
  if ((SKIP_GDB_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" SKIP_GDB)"
    [[ "$stored" == "$SKIP_GDB" ]] ||
      require_redo_for_completed_change gdb "changing the GDB skip choice from $stored to $SKIP_GDB"
  fi
  stored="$(stored_cpu_target_value "$meta")" ||
    diag_die "stored CPU_TARGET metadata is malformed"
  if ((CPU_EXPLICIT == 1)) && [[ "$stored" != "$CPU_TARGET" ]]; then
    require_redo_for_completed_change frequency \
      "changing CPU selection policy from $stored to $CPU_TARGET"
    require_redo_for_completed_change gdb \
      "changing CPU selection policy from $stored to $CPU_TARGET"
  fi
  validate_cpu_target_for_completed_phases "$CPU_TARGET"
}

RUN_LOG_FD=""
RUN_LOG_FD_PATH=""
COMMANDS_LOG_FD=""
COMMANDS_LOG_FD_PATH=""

bundle_log_before_append_open() {
  :
}

bundle_log_after_exclusive_create() {
  :
}

bundle_just_created_log_cleanup() {
  local path="$1" fd_path="$2"
  [[ -f "$path" && ! -L "$path" && -O "$path" && "$path" -ef "$fd_path" ]] ||
    return 1
  rm -f -- "$path"
}

bundle_append_fd_binding_is_valid() {
  local path="$1" fd_path="$2" expected_id="$3" opened_metadata current_id
  [[ -f "$fd_path" ]] || return 1
  opened_metadata="$(stat -Lc '%d:%i:%u:%h' -- "$fd_path" 2> /dev/null)" || return 1
  current_id="$(stat -Lc '%d:%i' -- "$path" 2> /dev/null)" || return 1
  [[ "$opened_metadata" == "$expected_id:$EUID:1" && "$current_id" == "$expected_id" ]] ||
    return 1
  bundle_owned_single_regular "$path"
}

bundle_append_fd_open() {
  local kind="$1" path="$2" fd_name="$3" fd_path_name="$4" create="$5"
  local expected_id="" opened_fd="" opened_fd_path old_umask open_rc=0
  local -n fd_out="$fd_name" fd_path_out="$fd_path_name"
  fd_out=""
  fd_path_out=""

  if ((create == 0)); then
    bundle_owned_single_regular "$path" || return 1
    expected_id="$(stat -Lc '%d:%i' -- "$path" 2> /dev/null)" || return 1
    bundle_log_before_append_open "$kind" "$path" || return 1
    # O_RDWR does not block when a raced pathname becomes a FIFO. It performs
    # no content write; common logging later reopens this retained inode through
    # /proc with O_APPEND only after the complete identity check succeeds.
    { exec {opened_fd}<> "$path"; } 2> /dev/null || return 1
    opened_fd_path="/proc/$BASHPID/fd/$opened_fd"
  else
    [[ ! -e "$path" && ! -L "$path" ]] || return 1
    old_umask="$(umask)"
    umask 0777
    if [[ -o noclobber ]]; then
      { exec {opened_fd}> "$path"; } 2> /dev/null || open_rc=$?
    else
      set -o noclobber
      { exec {opened_fd}> "$path"; } 2> /dev/null || open_rc=$?
      set +o noclobber
    fi
    umask "$old_umask"
    ((open_rc == 0)) || return 1
    opened_fd_path="/proc/$BASHPID/fd/$opened_fd"
    expected_id="$(stat -Lc '%d:%i' -- "$opened_fd_path" 2> /dev/null)" || {
      bundle_just_created_log_cleanup "$path" "$opened_fd_path" || true
      exec {opened_fd}>&-
      return 1
    }
    bundle_log_after_exclusive_create "$kind" "$path" "$opened_fd_path" || {
      bundle_just_created_log_cleanup "$path" "$opened_fd_path" || true
      exec {opened_fd}>&-
      return 1
    }
    chmod 0644 -- "$opened_fd_path" || {
      bundle_just_created_log_cleanup "$path" "$opened_fd_path" || true
      exec {opened_fd}>&-
      return 1
    }
  fi

  if ! bundle_append_fd_binding_is_valid "$path" "$opened_fd_path" "$expected_id"; then
    ((create == 0)) || bundle_just_created_log_cleanup "$path" "$opened_fd_path" || true
    exec {opened_fd}>&-
    return 1
  fi
  fd_out="$opened_fd"
  fd_path_out="$opened_fd_path"
}

bundle_log_fds_close() {
  local rc=0
  DIAG_LOG_FILE=""
  DIAG_COMMANDS_LOG=""
  if [[ -n "$RUN_LOG_FD" ]]; then
    exec {RUN_LOG_FD}>&- || rc=1
  fi
  if [[ -n "$COMMANDS_LOG_FD" ]]; then
    exec {COMMANDS_LOG_FD}>&- || rc=1
  fi
  RUN_LOG_FD=""
  RUN_LOG_FD_PATH=""
  COMMANDS_LOG_FD=""
  COMMANDS_LOG_FD_PATH=""
  return "$rc"
}

prepare_commands_log() {
  local path="$DIAG_COMMANDS_LOG" resumed=0
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -n "$RESUME_DIR" ]] || diag_die "fresh command log destination already exists"
    bundle_owned_single_regular "$path" ||
      diag_die "command log destination is unsafe"
    resumed=1
  fi
  bundle_append_fd_open commands "$path" COMMANDS_LOG_FD COMMANDS_LOG_FD_PATH \
    "$((resumed == 0))" ||
    diag_die "cannot bind the command log to its validated inode"
  DIAG_COMMANDS_LOG="$COMMANDS_LOG_FD_PATH"
  ((resumed == 0)) || printf '\n# resumed %s\n' "$(date -Is)" >> "$DIAG_COMMANDS_LOG"
}

prepare_run_log() {
  local path="$1" create=0
  if [[ -e "$path" || -L "$path" ]]; then
    bundle_owned_single_regular "$path" || diag_die "run log destination is unsafe"
  else
    create=1
  fi
  bundle_append_fd_open run "$path" RUN_LOG_FD RUN_LOG_FD_PATH "$create" ||
    diag_die "cannot bind the run log to its validated inode"
  DIAG_LOG_FILE="$RUN_LOG_FD_PATH"
}

build_redo_plan() {
  REDO_PLAN=()
  [[ -n "$REDO_PHASES" ]] || return 0
  [[ ! "$REDO_PHASES" =~ (^,|,$|,,) ]] ||
    diag_die "--redo contains an empty phase name"
  local -a requested=()
  local phase
  declare -A seen=() wanted=()
  IFS=',' read -ra requested <<< "$REDO_PHASES"
  for phase in "${requested[@]}"; do
    case "$phase" in
      preflight | baseline | groups | individual | pinned-concurrent | gdb | frequency) ;;
      *)
        diag_die "--redo: unknown or unsupported phase '$phase' (supported: preflight,baseline,groups,individual,pinned-concurrent,gdb,frequency)"
        ;;
    esac
    [[ -z "${seen[$phase]:-}" ]] || diag_die "--redo phase '$phase' was listed more than once"
    seen[$phase]=1
    wanted[$phase]=1
  done
  if [[ "$RUN_SCHEMA_VERSION" == 1 && -n "${wanted[pinned-concurrent]:-}" ]]; then
    diag_die "--redo pinned-concurrent is unavailable for a legacy bundle; start a fresh schema 2 bundle"
  fi

  # A fresh environment snapshot cannot remain attached to retained workload
  # evidence. Redoing preflight therefore invalidates every later phase.
  if [[ -n "${wanted[preflight]:-}" ]]; then
    wanted[baseline]=1
    wanted[groups]=1
    wanted[individual]=1
    [[ "$RUN_SCHEMA_VERSION" == 2 ]] && wanted[pinned-concurrent]=1
    wanted[frequency]=1
    wanted[gdb]=1
  fi

  # Group results choose the CPUs tested individually; individual results in
  # turn choose the CPU used by the manual frequency and GDB phases. Repeating
  # an upstream phase therefore invalidates every completed dependent phase.
  if [[ -n "${wanted[groups]:-}" ]]; then
    wanted[individual]=1
    [[ "$RUN_SCHEMA_VERSION" == 2 ]] && wanted[pinned-concurrent]=1
  fi
  if [[ -n "${wanted[individual]:-}" ]]; then
    wanted[frequency]=1
    wanted[gdb]=1
  fi

  # Always execute the closure in dependency order, independent of the order
  # used on the command line.
  for phase in preflight baseline groups individual pinned-concurrent frequency gdb; do
    [[ -n "${wanted[$phase]:-}" ]] && REDO_PLAN+=("$phase")
  done
}

redo_phase_supported() {
  case "$1" in preflight | baseline | groups | individual | pinned-concurrent | frequency | gdb) return 0 ;; esac
  return 1
}

redo_relative_path_is_safe() {
  local path="$1"
  [[ -n "$path" && "$path" != /* && "$path" =~ ^[A-Za-z0-9._:/-]+$ ]] || return 1
  [[ "$path" != "." && "$path" != ".." && "$path" != ./* &&
    "$path" != */./* && "$path" != */. && "$path" != ../* &&
    "$path" != */../* && "$path" != */.. && "$path" != *//* ]]
}

redo_path_is_allowed() {
  local phase="$1" path="$2" suffix
  redo_relative_path_is_safe "$path" || return 1
  case "$phase:$path" in
    preflight:results/preflight.meta|preflight:env/preflight.manifest|preflight:env/cmdline.txt|preflight:env/cpuinfo-extra.txt|preflight:env/cpufreq.txt|preflight:env/cctk.txt|preflight:env/date.txt|preflight:env/dependencies.txt|preflight:env/dmi.txt|preflight:env/kernel-warnings.txt|preflight:env/lscpu.txt|preflight:env/node.txt|preflight:env/online.txt|preflight:env/os-release.txt|preflight:env/power.txt|preflight:env/summary.env|preflight:env/topology.tsv|preflight:env/uname.txt|preflight:env/undervolt.txt|preflight:env/root|baseline:results/baseline.meta|baseline:logs/baseline|baseline:freq/baseline.samples|baseline:freq/baseline.method|baseline:results/telemetry-baseline.tsv|baseline:results/telemetry-baseline.meta|baseline:telemetry/baseline|baseline:state/telemetry-baseline|groups:results/groups.tsv|groups:results/groups.meta|groups:logs/groups|groups:results/telemetry-groups.tsv|groups:results/telemetry-groups.meta|groups:telemetry/groups|groups:state/telemetry-groups|individual:results/individual.tsv|individual:results/individual.meta|individual:results/individual.plan.tsv|individual:results/individual.boundaries.ndjson|individual:logs/individual|individual:state/individual-attempts|individual:state/individual-finalize|individual:results/telemetry-individual.tsv|individual:results/telemetry-individual.meta|individual:telemetry/individual|individual:state/telemetry-individual|pinned-concurrent:results/pinned-concurrent.tsv|pinned-concurrent:results/pinned-concurrent.meta|pinned-concurrent:results/pinned-concurrent.groups.tsv|pinned-concurrent:results/pinned-concurrent.plan.tsv|pinned-concurrent:results/pinned-concurrent.boundaries.ndjson|pinned-concurrent:results/pinned-concurrent.unavailable.meta|pinned-concurrent:state/phase-pinned-concurrent-unavailable.done|pinned-concurrent:logs/pinned-concurrent|pinned-concurrent:state/pinned-concurrent-waves|pinned-concurrent:state/pinned-concurrent-finalize|pinned-concurrent:results/telemetry-pinned-concurrent.tsv|pinned-concurrent:results/telemetry-pinned-concurrent.meta|pinned-concurrent:telemetry/pinned-concurrent|pinned-concurrent:state/telemetry-pinned-concurrent|gdb:results/gdb.meta|gdb:results/gdb.manifest|gdb:gdb|gdb:logs/gdb|gdb:results/telemetry-gdb.tsv|gdb:results/telemetry-gdb.meta|gdb:telemetry/gdb|gdb:state/telemetry-gdb|frequency:results/frequency-ab.tsv|frequency:results/frequency-ab.meta|frequency:results/frequency-cap.tsv|frequency:results/frequency-cap.meta) return 0 ;;
  esac
  if [[ "$phase" == gdb && "$path" == results/.gdb.manifest.* ]]; then
    suffix="${path#results/.gdb.manifest.}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  if [[ "$phase" == gdb && "$path" == results/.gdb.meta.* ]]; then
    suffix="${path#results/.gdb.meta.}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  if [[ "$phase" == groups && "$path" == freq/group-* ]]; then
    suffix="${path#freq/group-}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  if [[ "$phase" == frequency && "$path" == freq/freq-ab-* ]]; then
    suffix="${path#freq/freq-ab-}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  if [[ "$phase" == preflight && "$path" == env/.preflight.manifest.* ]]; then
    suffix="${path#env/.preflight.manifest.}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  if [[ "$phase" == preflight && "$path" == results/.preflight.meta.* ]]; then
    suffix="${path#results/.preflight.meta.}"
    [[ -n "$suffix" && "$suffix" != */* ]]
    return
  fi
  return 1
}

redo_derived_path_is_allowed() {
  case "$1" in results.json | report.md | privacy-review.txt | manifest.txt) return 0 ;; esac
  return 1
}

# Parse pending redo state strictly as data. Never source this user-owned file.
redo_config_value_is_valid() {
  local key="$1" value="$2"
  case "$key" in
    MODE) [[ "$value" == default || "$value" == quick || "$value" == full ]] ;;
    RUN_SCHEMA_VERSION) [[ "$value" == 2 ]] ;;
    BASELINE_CHILDREN | BASELINE_WAVES | INDIVIDUAL_RUNS | PINNED_CONCURRENT_ROUNDS | GDB_MAX_RUNS)
      diag_is_safe_positive_uint "$value"
      ;;
    GROUP_WAVES)
      diag_is_safe_positive_uint "$value"
      ;;
    PROTOCOL_SEED)
      [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]] &&
        ((${#value} < 10 || (${#value} == 10 && value <= PROTOCOL_SEED_MAX)))
      ;;
    SKIP_PINNED_CONCURRENT | SKIP_GDB) [[ "$value" == 0 || "$value" == 1 ]] ;;
    TELEMETRY_INTERVAL_MS)
      diag_is_safe_positive_uint "$value" && ((value >= 50 && value <= 60000))
      ;;
    CPU_TARGET) [[ "$value" == auto || "$value" =~ ^(0|[1-9][0-9]*)$ ]] ;;
    *) return 1 ;;
  esac
}

redo_write_config_records() {
  printf 'CONFIG\tMODE\t%s\n' "$MODE"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    printf 'CONFIG\tRUN_SCHEMA_VERSION\t%s\n' "$RUN_SCHEMA_VERSION"
  fi
  printf 'CONFIG\tBASELINE_CHILDREN\t%s\n' "$BASELINE_CHILDREN"
  printf 'CONFIG\tBASELINE_WAVES\t%s\n' "$BASELINE_WAVES"
  printf 'CONFIG\tGROUP_WAVES\t%s\n' "$GROUP_WAVES"
  printf 'CONFIG\tINDIVIDUAL_RUNS\t%s\n' "$INDIVIDUAL_RUNS"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    printf 'CONFIG\tPINNED_CONCURRENT_ROUNDS\t%s\n' "$PINNED_CONCURRENT_ROUNDS"
    printf 'CONFIG\tPROTOCOL_SEED\t%s\n' "$PROTOCOL_SEED"
    printf 'CONFIG\tSKIP_PINNED_CONCURRENT\t%s\n' "$SKIP_PINNED_CONCURRENT"
    printf 'CONFIG\tTELEMETRY_INTERVAL_MS\t%s\n' "$TELEMETRY_INTERVAL_MS"
  fi
  printf 'CONFIG\tGDB_MAX_RUNS\t%s\n' "$GDB_MAX_RUNS"
  printf 'CONFIG\tSKIP_GDB\t%s\n' "$SKIP_GDB"
  printf 'CONFIG\tCPU_TARGET\t%s\n' "$CPU_TARGET"
}

redo_transaction_validate() {
  local marker="$1" line kind owner path version="" txn="" last_rank=0 rank section=version
  local config_index=0 expected_key
  local -a config_keys_v2=(MODE BASELINE_CHILDREN BASELINE_WAVES GROUP_WAVES INDIVIDUAL_RUNS GDB_MAX_RUNS SKIP_GDB CPU_TARGET)
  local -a config_keys_v3=(MODE RUN_SCHEMA_VERSION BASELINE_CHILDREN BASELINE_WAVES GROUP_WAVES INDIVIDUAL_RUNS PINNED_CONCURRENT_ROUNDS PROTOCOL_SEED SKIP_PINNED_CONCURRENT TELEMETRY_INTERVAL_MS GDB_MAX_RUNS SKIP_GDB CPU_TARGET)
  local -a config_keys=()
  local -A phases=() records=()
  REDO_TXN_ID=""
  REDO_TXN_VERSION=""
  REDO_TXN_HAS_CPU_TARGET=0
  REDO_TXN_HAS_SCHEMA2=0
  REDO_TXN_PHASES=()
  REDO_TXN_OWNERS=()
  REDO_TXN_PATHS=()
  REDO_TXN_CONFIG=()
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    IFS=$'\t' read -r kind owner path <<< "$line"
    case "$kind" in
      VERSION)
        [[ "$section" == version && "$line" == "VERSION"$'\t'"$owner" &&
          ("$owner" == 1 || "$owner" == 2 || "$owner" == 3) ]] || return 1
        version="$owner"
        if [[ "$version" == 2 ]]; then
          config_keys=("${config_keys_v2[@]}")
        elif [[ "$version" == 3 ]]; then
          config_keys=("${config_keys_v3[@]}")
        fi
        section=txn
        ;;
      TXN)
        [[ "$section" == txn && "$line" == "TXN"$'\t'"$owner" &&
          "$owner" =~ ^redo-[0-9]{8}T[0-9]{6}-[A-Za-z0-9]+$ ]] || return 1
        txn="$owner"
        if [[ "$version" == 2 || "$version" == 3 ]]; then section=config; else section=phases; fi
        ;;
      CONFIG)
        [[ ("$version" == 2 || "$version" == 3) && "$section" == config &&
          $config_index -lt ${#config_keys[@]} ]] || return 1
        expected_key="${config_keys[$config_index]}"
        [[ "$owner" == "$expected_key" && "$line" == "CONFIG"$'\t'"$owner"$'\t'"$path" ]] || return 1
        redo_config_value_is_valid "$owner" "$path" || return 1
        [[ -z "${REDO_TXN_CONFIG[$owner]:-}" ]] || return 1
        REDO_TXN_CONFIG[$owner]="$path"
        config_index=$((config_index + 1))
        ;;
      PHASE)
        if [[ "$version" == 2 ]]; then
          [[ ("$section" == config || "$section" == phases) &&
            ($config_index -eq 7 || $config_index -eq ${#config_keys[@]}) ]] || return 1
        elif [[ "$version" == 3 ]]; then
          [[ ("$section" == config || "$section" == phases) &&
            $config_index -eq ${#config_keys[@]} ]] || return 1
        else
          [[ "$section" == phases ]] || return 1
        fi
        [[ "$line" == "PHASE"$'\t'"$owner" ]] || return 1
        redo_phase_supported "$owner" && [[ -z "${phases[$owner]:-}" ]] || return 1
        [[ "$owner" != pinned-concurrent || "$version" == 3 ]] || return 1
        case "$owner" in preflight) rank=1 ;; baseline) rank=2 ;; groups) rank=3 ;; individual) rank=4 ;; pinned-concurrent) rank=5 ;; frequency) rank=6 ;; gdb) rank=7 ;; esac
        ((rank > last_rank)) || return 1
        last_rank=$rank
        phases[$owner]=1
        REDO_TXN_PHASES+=("$owner")
        section=phases
        ;;
      DERIVED)
        [[ "$section" == phases || "$section" == derived ]] || return 1
        [[ ${#REDO_TXN_PHASES[@]} -gt 0 && "$line" == "DERIVED"$'\t'"-"$'\t'"$path" ]] || return 1
        redo_derived_path_is_allowed "$path" && [[ -z "${records[derived:$path]:-}" ]] || return 1
        records[derived:$path]=1
        REDO_TXN_OWNERS+=(derived); REDO_TXN_PATHS+=("$path")
        section=derived
        ;;
      ARTIFACT)
        [[ "$section" == phases || "$section" == derived || "$section" == artifacts ]] || return 1
        [[ ${#REDO_TXN_PHASES[@]} -gt 0 && "$line" == "ARTIFACT"$'\t'"$owner"$'\t'"$path" ]] || return 1
        redo_phase_supported "$owner" && redo_path_is_allowed "$owner" "$path" || return 1
        [[ -z "${records[$owner:$path]:-}" ]] || return 1
        records[$owner:$path]=1
        REDO_TXN_OWNERS+=("$owner"); REDO_TXN_PATHS+=("$path")
        section=artifacts
        ;;
      *) return 1 ;;
    esac
  done < "$marker"
  [[ ("$version" == 1 || "$version" == 2 || "$version" == 3) && -n "$txn" &&
    ${#REDO_TXN_PHASES[@]} -gt 0 ]] || return 1
  [[ "$version" == 1 || ("$version" == 2 && ($config_index -eq 7 ||
    $config_index -eq ${#config_keys[@]})) || ("$version" == 3 &&
    $config_index -eq ${#config_keys[@]}) ]] || return 1
  if [[ "$version" == 2 ]]; then
    ((config_index == 8)) && REDO_TXN_HAS_CPU_TARGET=1
    case "${REDO_TXN_CONFIG[MODE]}" in
      quick)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 8 && "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 10 ]] || return 1
        ;;
      default)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 16 && "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 50 ]] || return 1
        ;;
      full)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 16 && "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 100 ]] || return 1
        ;;
    esac
  elif [[ "$version" == 3 ]]; then
    REDO_TXN_HAS_CPU_TARGET=1
    REDO_TXN_HAS_SCHEMA2=1
    [[ "${REDO_TXN_CONFIG[RUN_SCHEMA_VERSION]}" == 2 ]] || return 1
    case "${REDO_TXN_CONFIG[MODE]}" in
      quick)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 8 &&
          "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 10 ]] || return 1
        ;;
      default)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 16 &&
          "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 50 ]] || return 1
        ;;
      full)
        [[ "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" == 16 &&
          "${REDO_TXN_CONFIG[BASELINE_WAVES]}" == 100 ]] || return 1
        ;;
    esac
  fi
  local phase
  for phase in "${REDO_TXN_OWNERS[@]}"; do
    [[ "$phase" == derived || -n "${phases[$phase]:-}" ]] || return 1
  done
  if [[ -n "${phases[groups]:-}" ]]; then
    [[ -n "${phases[individual]:-}" && -n "${phases[frequency]:-}" && -n "${phases[gdb]:-}" ]] || return 1
    [[ "$version" != 3 || -n "${phases[pinned-concurrent]:-}" ]] || return 1
  fi
  if [[ -n "${phases[individual]:-}" ]]; then
    [[ -n "${phases[frequency]:-}" && -n "${phases[gdb]:-}" ]] || return 1
  fi
  if [[ -n "${phases[preflight]:-}" ]]; then
    [[ -n "${phases[baseline]:-}" && -n "${phases[groups]:-}" &&
      -n "${phases[individual]:-}" && -n "${phases[frequency]:-}" &&
      -n "${phases[gdb]:-}" ]] || return 1
    [[ "$version" != 3 || -n "${phases[pinned-concurrent]:-}" ]] || return 1
  fi
  REDO_TXN_VERSION="$version"
  REDO_TXN_ID="$txn"
}

redo_adopt_pending_config() {
  [[ "$REDO_TXN_VERSION" == 2 || "$REDO_TXN_VERSION" == 3 ]] || return 0
  MODE="${REDO_TXN_CONFIG[MODE]}"
  if [[ "$REDO_TXN_VERSION" == 3 ]]; then
    RUN_SCHEMA_VERSION="${REDO_TXN_CONFIG[RUN_SCHEMA_VERSION]}"
  fi
  BASELINE_CHILDREN="${REDO_TXN_CONFIG[BASELINE_CHILDREN]}"
  BASELINE_WAVES="${REDO_TXN_CONFIG[BASELINE_WAVES]}"
  GROUP_WAVES="${REDO_TXN_CONFIG[GROUP_WAVES]}"
  INDIVIDUAL_RUNS="${REDO_TXN_CONFIG[INDIVIDUAL_RUNS]}"
  if [[ "$REDO_TXN_VERSION" == 3 ]]; then
    PINNED_CONCURRENT_ROUNDS="${REDO_TXN_CONFIG[PINNED_CONCURRENT_ROUNDS]}"
    PROTOCOL_SEED="${REDO_TXN_CONFIG[PROTOCOL_SEED]}"
    SKIP_PINNED_CONCURRENT="${REDO_TXN_CONFIG[SKIP_PINNED_CONCURRENT]}"
    TELEMETRY_INTERVAL_MS="${REDO_TXN_CONFIG[TELEMETRY_INTERVAL_MS]}"
  fi
  GDB_MAX_RUNS="${REDO_TXN_CONFIG[GDB_MAX_RUNS]}"
  SKIP_GDB="${REDO_TXN_CONFIG[SKIP_GDB]}"
  if ((REDO_TXN_HAS_CPU_TARGET == 1)); then
    CPU_TARGET="${REDO_TXN_CONFIG[CPU_TARGET]}"
  fi
  apply_cpu_target_runtime
}

redo_transaction_has_phase() {
  local wanted="$1" phase
  for phase in "${REDO_TXN_PHASES[@]}"; do
    [[ "$phase" == "$wanted" ]] && return 0
  done
  return 1
}

redo_changed_config_authorized_for_phase() {
  local phase="$1"
  if phase_is_done "$phase" || phase_attempt_is_meaningful "$phase"; then
    redo_transaction_has_phase "$phase"
  else
    return 0
  fi
}

# A syntactically valid marker must not relabel completed evidence that it
# leaves in place. Only a transaction containing the affected phase may alter
# the config key that describes that phase's evidence.
redo_transaction_target_is_authorized() {
  [[ "$REDO_TXN_VERSION" == 2 || "$REDO_TXN_VERSION" == 3 ]] || return 0
  local key stored target phase target_cpu_policy
  local -a keys=(MODE BASELINE_CHILDREN BASELINE_WAVES GROUP_WAVES INDIVIDUAL_RUNS GDB_MAX_RUNS SKIP_GDB)
  if [[ "$REDO_TXN_VERSION" == 3 ]]; then
    keys+=(RUN_SCHEMA_VERSION PINNED_CONCURRENT_ROUNDS PROTOCOL_SEED SKIP_PINNED_CONCURRENT TELEMETRY_INTERVAL_MS)
  fi
  for key in "${keys[@]}"; do
    stored="$(metadata_value "$META_FILE" "$key")"
    target="${REDO_TXN_CONFIG[$key]}"
    [[ "$stored" == "$target" ]] && continue
    case "$key" in
      MODE)
        for phase in baseline groups individual pinned-concurrent gdb; do
          redo_changed_config_authorized_for_phase "$phase" || return 1
        done
        ;;
      RUN_SCHEMA_VERSION)
        return 1
        ;;
      BASELINE_CHILDREN | BASELINE_WAVES)
        redo_changed_config_authorized_for_phase baseline || return 1
        ;;
      GROUP_WAVES)
        redo_changed_config_authorized_for_phase groups || return 1
        ;;
      INDIVIDUAL_RUNS)
        redo_changed_config_authorized_for_phase individual || return 1
        ;;
      PINNED_CONCURRENT_ROUNDS | SKIP_PINNED_CONCURRENT)
        redo_changed_config_authorized_for_phase pinned-concurrent || return 1
        ;;
      PROTOCOL_SEED)
        redo_changed_config_authorized_for_phase individual || return 1
        redo_changed_config_authorized_for_phase pinned-concurrent || return 1
        ;;
      TELEMETRY_INTERVAL_MS)
        for phase in baseline groups individual pinned-concurrent gdb; do
          redo_changed_config_authorized_for_phase "$phase" || return 1
        done
        ;;
      GDB_MAX_RUNS | SKIP_GDB)
        redo_changed_config_authorized_for_phase gdb || return 1
        ;;
    esac
  done
  if ((REDO_TXN_HAS_CPU_TARGET == 1)); then
    target_cpu_policy="${REDO_TXN_CONFIG[CPU_TARGET]}"
  else
    target_cpu_policy="$(stored_cpu_target_value "$META_FILE")" || return 1
  fi
  for phase in frequency gdb; do
    cpu_target_matches_completed_phase "$target_cpu_policy" "$phase" ||
      redo_changed_config_authorized_for_phase "$phase" || return 1
  done
}

redo_pending_phase_request_matches() {
  ((${#REDO_PLAN[@]} == 0)) && return 0
  ((${#REDO_PLAN[@]} == ${#REDO_TXN_PHASES[@]})) || return 1
  local i
  for ((i = 0; i < ${#REDO_PLAN[@]}; i++)); do
    [[ "${REDO_PLAN[$i]}" == "${REDO_TXN_PHASES[$i]}" ]] || return 1
  done
}

redo_pending_explicit_config_matches_v2() {
  if ((MODE_EXPLICIT == 1)); then
    [[ "$MODE" == "${REDO_TXN_CONFIG[MODE]}" &&
      "$BASELINE_CHILDREN" == "${REDO_TXN_CONFIG[BASELINE_CHILDREN]}" &&
      "$BASELINE_WAVES" == "${REDO_TXN_CONFIG[BASELINE_WAVES]}" &&
      "$GROUP_WAVES" == "${REDO_TXN_CONFIG[GROUP_WAVES]}" &&
      "$INDIVIDUAL_RUNS" == "${REDO_TXN_CONFIG[INDIVIDUAL_RUNS]}" &&
      "$GDB_MAX_RUNS" == "${REDO_TXN_CONFIG[GDB_MAX_RUNS]}" ]] || return 1
    if [[ "$REDO_TXN_VERSION" == 3 ]]; then
      [[ "$RUN_SCHEMA_VERSION" == "${REDO_TXN_CONFIG[RUN_SCHEMA_VERSION]}" &&
        "$PINNED_CONCURRENT_ROUNDS" == "${REDO_TXN_CONFIG[PINNED_CONCURRENT_ROUNDS]}" &&
        "$PROTOCOL_SEED" == "${REDO_TXN_CONFIG[PROTOCOL_SEED]}" &&
        "$TELEMETRY_INTERVAL_MS" == "${REDO_TXN_CONFIG[TELEMETRY_INTERVAL_MS]}" ]] || return 1
    fi
  else
    ((GROUP_WAVES_EXPLICIT == 0)) || [[ "$GROUP_WAVES" == "${REDO_TXN_CONFIG[GROUP_WAVES]}" ]] || return 1
    ((INDIVIDUAL_RUNS_EXPLICIT == 0)) || [[ "$INDIVIDUAL_RUNS" == "${REDO_TXN_CONFIG[INDIVIDUAL_RUNS]}" ]] || return 1
    ((GDB_MAX_RUNS_EXPLICIT == 0)) || [[ "$GDB_MAX_RUNS" == "${REDO_TXN_CONFIG[GDB_MAX_RUNS]}" ]] || return 1
    if [[ "$REDO_TXN_VERSION" == 3 ]]; then
      ((PINNED_CONCURRENT_ROUNDS_EXPLICIT == 0)) ||
        [[ "$PINNED_CONCURRENT_ROUNDS" == "${REDO_TXN_CONFIG[PINNED_CONCURRENT_ROUNDS]}" ]] || return 1
      ((PROTOCOL_SEED_EXPLICIT == 0)) ||
        [[ "$PROTOCOL_SEED" == "${REDO_TXN_CONFIG[PROTOCOL_SEED]}" ]] || return 1
      ((TELEMETRY_INTERVAL_MS_EXPLICIT == 0)) ||
        [[ "$TELEMETRY_INTERVAL_MS" == "${REDO_TXN_CONFIG[TELEMETRY_INTERVAL_MS]}" ]] || return 1
    fi
  fi
  if [[ "$REDO_TXN_VERSION" == 3 ]]; then
    ((SKIP_PINNED_CONCURRENT_EXPLICIT == 0)) ||
      [[ "$SKIP_PINNED_CONCURRENT" == "${REDO_TXN_CONFIG[SKIP_PINNED_CONCURRENT]}" ]] || return 1
  fi
  ((SKIP_GDB_EXPLICIT == 0)) || [[ "$SKIP_GDB" == "${REDO_TXN_CONFIG[SKIP_GDB]}" ]] || return 1
  if ((CPU_EXPLICIT == 1)); then
    if ((REDO_TXN_HAS_CPU_TARGET == 1)); then
      [[ "$CPU_TARGET" == "${REDO_TXN_CONFIG[CPU_TARGET]}" ]]
    else
      [[ "$CPU_TARGET" == "$(stored_cpu_target_value "$META_FILE")" ]]
    fi
  fi
}

redo_pending_explicit_config_matches_v1() {
  local key
  if ((MODE_EXPLICIT == 1)); then
    for key in MODE BASELINE_CHILDREN BASELINE_WAVES GROUP_WAVES INDIVIDUAL_RUNS GDB_MAX_RUNS; do
      [[ "${!key}" == "$(metadata_value "$META_FILE" "$key")" ]] || return 1
    done
  else
    ((GROUP_WAVES_EXPLICIT == 0)) || [[ "$GROUP_WAVES" == "$(metadata_value "$META_FILE" GROUP_WAVES)" ]] || return 1
    ((INDIVIDUAL_RUNS_EXPLICIT == 0)) || [[ "$INDIVIDUAL_RUNS" == "$(metadata_value "$META_FILE" INDIVIDUAL_RUNS)" ]] || return 1
    ((GDB_MAX_RUNS_EXPLICIT == 0)) || [[ "$GDB_MAX_RUNS" == "$(metadata_value "$META_FILE" GDB_MAX_RUNS)" ]] || return 1
  fi
  ((SKIP_GDB_EXPLICIT == 0)) || [[ "$SKIP_GDB" == "$(metadata_value "$META_FILE" SKIP_GDB)" ]] || return 1
  ((CPU_EXPLICIT == 0)) || [[ "$CPU_TARGET" == "$(stored_cpu_target_value "$META_FILE")" ]]
}

# Reconcile an interrupted transaction before consent or any resumed-bundle
# mutation. A plain resume adopts V2's target. Repeating --redo must name the
# exact pending closure, and any explicitly repeated config must agree.
reconcile_pending_redo_request() {
  local marker="$STATE_DIR/redo.pending"
  [[ -e "$marker" || -L "$marker" ]] || return 0
  redo_transaction_validate "$marker" ||
    diag_die "pending redo transaction is malformed; refusing bundle mutation"
  redo_transaction_target_is_authorized ||
    diag_die "pending redo target would relabel completed evidence outside its phase closure"
  redo_transaction_pairs_are_recoverable ||
    diag_die "pending redo has an unsafe or conflicting source/archive state"
  redo_pending_phase_request_matches ||
    diag_die "requested --redo phases conflict with the pending redo transaction"
  if [[ "$REDO_TXN_VERSION" == 2 || "$REDO_TXN_VERSION" == 3 ]]; then
    redo_pending_explicit_config_matches_v2 ||
      diag_die "explicit configuration conflicts with the pending redo target"
    redo_adopt_pending_config
  else
    redo_pending_explicit_config_matches_v1 ||
      diag_die "explicit configuration conflicts with the V1 pending redo metadata"
  fi
  ((${#REDO_PLAN[@]} == 0)) || REDO_REQUEST_SATISFIED_BY_PENDING=1
}

redo_ensure_destination_parent() {
  local stash="$1" relative="$2" current="$stash" part
  local parent="${relative%/*}"
  [[ "$parent" != "$relative" ]] || return 0
  IFS='/' read -ra parts <<< "$parent"
  for part in "${parts[@]}"; do
    current="$current/$part"
    if [[ -e "$current" || -L "$current" ]]; then
      [[ -d "$current" && ! -L "$current" ]] || return 1
    else
      mkdir -- "$current" || return 1
    fi
  done
}

redo_source_parent_is_safe() {
  local relative="$1" current="$OUT_DIR" part
  local parent="${relative%/*}"
  [[ "$parent" != "$relative" ]] || return 0
  IFS='/' read -ra parts <<< "$parent"
  for part in "${parts[@]}"; do
    current="$current/$part"
    [[ -d "$current" && ! -L "$current" ]] || return 1
  done
}

redo_destination_parent_is_safe_readonly() {
  local stash="$1" relative="$2" current="$stash" part
  local parent="${relative%/*}"
  [[ "$parent" != "$relative" ]] || return 0
  if [[ -e "$current" || -L "$current" ]]; then
    [[ -d "$current" && ! -L "$current" ]] || return 1
  else
    return 0
  fi
  IFS='/' read -ra parts <<< "$parent"
  for part in "${parts[@]}"; do
    current="$current/$part"
    if [[ -e "$current" || -L "$current" ]]; then
      [[ -d "$current" && ! -L "$current" ]] || return 1
    else
      return 0
    fi
  done
}

redo_transaction_pair_is_recoverable() {
  local index="$1" source_exists="$2" dest_exists="$3"
  ((source_exists + dest_exists == 1)) && return 0
  # Older redo markers could record the top-level readiness token. Every
  # actual run now revokes that regenerable token before redo recovery, so a
  # retry can legitimately find neither the source nor an archived copy.
  [[ "$source_exists" == 0 && "$dest_exists" == 0 &&
    "${REDO_TXN_OWNERS[$index]}" == derived &&
    "${REDO_TXN_PATHS[$index]}" == manifest.txt ]]
}

# Validate the complete pending move set without creating archive directories.
# main calls this before consent-adjacent logging or mkdir can mutate a resumed
# bundle; execution repeats it to close the gap between reconciliation and use.
redo_transaction_pairs_are_recoverable() {
  local superseded="$STATE_DIR/superseded" stash="$STATE_DIR/superseded/$REDO_TXN_ID"
  local i source dest bucket source_exists dest_exists
  if [[ -e "$superseded" || -L "$superseded" ]]; then
    [[ -d "$superseded" && ! -L "$superseded" ]] || return 1
  fi
  if [[ -e "$stash" || -L "$stash" ]]; then
    [[ -d "$stash" && ! -L "$stash" ]] || return 1
  fi
  for ((i = 0; i < ${#REDO_TXN_PATHS[@]}; i++)); do
    source="$OUT_DIR/${REDO_TXN_PATHS[$i]}"
    bucket="${REDO_TXN_OWNERS[$i]}"
    dest="$stash/$bucket/${REDO_TXN_PATHS[$i]}"
    redo_source_parent_is_safe "${REDO_TXN_PATHS[$i]}" || return 1
    redo_destination_parent_is_safe_readonly "$stash" "$bucket/${REDO_TXN_PATHS[$i]}" || return 1
    source_exists=0
    dest_exists=0
    [[ -e "$source" || -L "$source" ]] && source_exists=1
    [[ -e "$dest" || -L "$dest" ]] && dest_exists=1
    redo_transaction_pair_is_recoverable "$i" "$source_exists" "$dest_exists" || return 1
  done
}

redo_transaction_execute() {
  local marker="$STATE_DIR/redo.pending"
  redo_transaction_validate "$marker" || diag_die "pending redo transaction is malformed; refusing bundle mutation"
  redo_transaction_target_is_authorized ||
    diag_die "pending redo target would relabel completed evidence outside its phase closure"
  redo_transaction_pairs_are_recoverable ||
    diag_die "pending redo has an unsafe or conflicting source/archive state"
  redo_adopt_pending_config
  local superseded="$STATE_DIR/superseded"
  if [[ -e "$superseded" || -L "$superseded" ]]; then
    [[ -d "$superseded" && ! -L "$superseded" ]] ||
      diag_die "pending redo archive parent is unsafe"
  else
    mkdir -- "$superseded" || diag_die "cannot create pending redo archive parent"
  fi
  local stash="$superseded/$REDO_TXN_ID" phase i source dest bucket
  if [[ -e "$stash" || -L "$stash" ]]; then
    [[ -d "$stash" && ! -L "$stash" ]] || diag_die "pending redo archive destination is unsafe"
  else
    mkdir -- "$stash" || diag_die "cannot create pending redo archive destination"
  fi

  # Validate every recorded source/archive pair before invalidating completion
  # metadata. During recovery, exactly one side must exist for every record.
  for ((i = 0; i < ${#REDO_TXN_PATHS[@]}; i++)); do
    source="$OUT_DIR/${REDO_TXN_PATHS[$i]}"
    bucket="${REDO_TXN_OWNERS[$i]}"
    dest="$stash/$bucket/${REDO_TXN_PATHS[$i]}"
    redo_source_parent_is_safe "${REDO_TXN_PATHS[$i]}" ||
      diag_die "pending redo source parent is unsafe for ${REDO_TXN_PATHS[$i]}"
    redo_ensure_destination_parent "$stash" "$bucket/${REDO_TXN_PATHS[$i]}" ||
      diag_die "pending redo archive parent is unsafe"
    local source_exists=0 dest_exists=0
    [[ -e "$source" || -L "$source" ]] && source_exists=1
    [[ -e "$dest" || -L "$dest" ]] && dest_exists=1
    redo_transaction_pair_is_recoverable "$i" "$source_exists" "$dest_exists" ||
      diag_die "pending redo has conflicting or missing source/archive state for ${REDO_TXN_PATHS[$i]}"
  done

  # Invalidate the complete dependency closure before the first evidence move.
  # meta.env remains on its previous, internally consistent generation until
  # every archive move is complete.
  for phase in "${REDO_TXN_PHASES[@]}"; do
    rm -f -- "$STATE_DIR/phase-$phase.done" ||
      diag_die "pending redo could not invalidate phase $phase"
    [[ ! -e "$STATE_DIR/phase-$phase.done" && ! -L "$STATE_DIR/phase-$phase.done" ]] ||
      diag_die "pending redo could not invalidate phase $phase"
  done
  SESSION_DID_WORK=1

  for ((i = 0; i < ${#REDO_TXN_PATHS[@]}; i++)); do
    source="$OUT_DIR/${REDO_TXN_PATHS[$i]}"
    bucket="${REDO_TXN_OWNERS[$i]}"
    dest="$stash/$bucket/${REDO_TXN_PATHS[$i]}"
    local source_exists=0 dest_exists=0
    [[ -e "$source" || -L "$source" ]] && source_exists=1
    [[ -e "$dest" || -L "$dest" ]] && dest_exists=1
    if ((source_exists == 1 && dest_exists == 0)); then
      redo_ensure_destination_parent "$stash" "$bucket/${REDO_TXN_PATHS[$i]}" ||
        diag_die "pending redo archive parent is unsafe"
      mv -T -- "$source" "$dest" || diag_die "pending redo could not archive ${REDO_TXN_PATHS[$i]}"
    elif ((source_exists == 0 && dest_exists == 1)); then
      : # already moved before an interruption
    elif redo_transaction_pair_is_recoverable "$i" "$source_exists" "$dest_exists"; then
      : # legacy manifest token was revoked before redo recovery
    else
      diag_die "pending redo has conflicting or missing source/archive state for ${REDO_TXN_PATHS[$i]}"
    fi
  done

  if [[ "$REDO_TXN_VERSION" == 2 || "$REDO_TXN_VERSION" == 3 ]]; then
    rewrite_meta_atomic 1 1
  else
    # V1 markers predate embedded config and were only published after their
    # target config had already reached meta.env.
    rewrite_meta_atomic 0 1
  fi
  redo_after_meta_publish ||
    diag_die "pending redo interrupted after metadata publication"
  rm -f -- "$marker" || diag_die "pending redo completed but its transaction marker could not be removed"
  sync -f "$STATE_DIR" || diag_die "pending redo could not synchronize transaction completion"
  diag_log "archive: previous evidence preserved under ${stash#"$OUT_DIR"/}; phases ${REDO_TXN_PHASES[*]} will run fresh"
}

redo_after_meta_publish() {
  :
}

redo_record_if_present() {
  local kind="$1" owner="$2" path="$3"
  [[ -e "$OUT_DIR/$path" || -L "$OUT_DIR/$path" ]] || return 0
  redo_source_parent_is_safe "$path" || diag_die "archive source parent is unsafe for $path"
  printf '%s\t%s\t%s\n' "$kind" "$owner" "$path"
}

redo_transaction_prepare() {
  local pending="$STATE_DIR/redo.pending"
  [[ ! -e "$pending" && ! -L "$pending" ]] ||
    diag_die "a pending redo transaction must be recovered before starting another"
  REDO_MARKER_TEMP="$(mktemp "$STATE_DIR/.redo.pending.XXXXXX")" ||
    diag_die "cannot prepare redo transaction"
  REDO_NEW_TXN_ID="redo-$(date +%Y%m%dT%H%M%S)-${REDO_MARKER_TEMP##*.}"
}

redo_transaction_publish() {
  local pending="$STATE_DIR/redo.pending"
  chmod 0600 "$REDO_MARKER_TEMP" || diag_die "cannot protect redo transaction"
  redo_transaction_validate "$REDO_MARKER_TEMP" ||
    diag_die "generated redo transaction failed validation"
  redo_marker_rename "$REDO_MARKER_TEMP" "$pending" || diag_die "cannot publish redo transaction"
  [[ ! -e "$REDO_MARKER_TEMP" ]] || diag_die "another redo transaction appeared concurrently"
  sync -f "$pending" || diag_die "cannot synchronize redo transaction"
  sync -f "$STATE_DIR" || diag_die "cannot synchronize redo transaction directory"
  REDO_MARKER_TEMP=""
  REDO_NEW_TXN_ID=""
  redo_after_marker_publish || diag_die "redo interrupted after transaction publication"
  redo_transaction_execute
}

redo_marker_rename() {
  mv -nT -- "$1" "$2"
}

redo_after_marker_publish() {
  :
}

apply_redo_plan() {
  ((${#REDO_PLAN[@]} > 0)) || return 0
  ((REDO_REQUEST_SATISFIED_BY_PENDING == 0)) || return 0
  redo_transaction_prepare
  local phase path artifact redo_format=2
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && redo_format=3
  {
    printf 'VERSION\t%s\nTXN\t%s\n' "$redo_format" "$REDO_NEW_TXN_ID"
    redo_write_config_records
    for phase in "${REDO_PLAN[@]}"; do printf 'PHASE\t%s\n' "$phase"; done
    for path in results.json report.md privacy-review.txt manifest.txt; do
      redo_record_if_present DERIVED - "$path"
    done
    for phase in "${REDO_PLAN[@]}"; do
      local -a paths=()
      case "$phase" in
        preflight)
          paths=(results/preflight.meta env/preflight.manifest)
          local preflight_name
          for preflight_name in "${PREFLIGHT_ARTIFACTS[@]}"; do
            paths+=("env/$preflight_name")
          done
          paths+=(env/root)
          ;;
        baseline) paths=(results/baseline.meta logs/baseline freq/baseline.samples freq/baseline.method results/telemetry-baseline.tsv results/telemetry-baseline.meta telemetry/baseline state/telemetry-baseline) ;;
        groups) paths=(results/groups.tsv results/groups.meta logs/groups results/telemetry-groups.tsv results/telemetry-groups.meta telemetry/groups state/telemetry-groups) ;;
        individual) paths=(results/individual.tsv results/individual.meta results/individual.plan.tsv results/individual.boundaries.ndjson logs/individual state/individual-attempts state/individual-finalize results/telemetry-individual.tsv results/telemetry-individual.meta telemetry/individual state/telemetry-individual) ;;
        pinned-concurrent) paths=(results/pinned-concurrent.tsv results/pinned-concurrent.meta results/pinned-concurrent.groups.tsv results/pinned-concurrent.plan.tsv results/pinned-concurrent.boundaries.ndjson results/pinned-concurrent.unavailable.meta state/phase-pinned-concurrent-unavailable.done logs/pinned-concurrent state/pinned-concurrent-waves state/pinned-concurrent-finalize results/telemetry-pinned-concurrent.tsv results/telemetry-pinned-concurrent.meta telemetry/pinned-concurrent state/telemetry-pinned-concurrent) ;;
        frequency) paths=(results/frequency-ab.tsv results/frequency-ab.meta results/frequency-cap.tsv results/frequency-cap.meta) ;;
        gdb) paths=(results/gdb.meta results/gdb.manifest gdb logs/gdb results/telemetry-gdb.tsv results/telemetry-gdb.meta telemetry/gdb state/telemetry-gdb) ;;
        *) diag_die "--redo: unsupported phase '$phase'" ;;
      esac
      if [[ "$phase" == groups ]]; then
        for artifact in "$OUT_DIR"/freq/group-*; do
          [[ -e "$artifact" || -L "$artifact" ]] && paths+=("${artifact#"$OUT_DIR"/}")
        done
      elif [[ "$phase" == frequency ]]; then
        for artifact in "$OUT_DIR"/freq/freq-ab-*; do
          [[ -e "$artifact" || -L "$artifact" ]] && paths+=("${artifact#"$OUT_DIR"/}")
        done
      elif [[ "$phase" == preflight ]]; then
        for artifact in "$OUT_DIR"/env/.preflight.manifest.* "$OUT_DIR"/results/.preflight.meta.*; do
          [[ -e "$artifact" || -L "$artifact" ]] && paths+=("${artifact#"$OUT_DIR"/}")
        done
      elif [[ "$phase" == gdb ]]; then
        for artifact in "$OUT_DIR"/results/.gdb.manifest.* "$OUT_DIR"/results/.gdb.meta.*; do
          [[ -e "$artifact" || -L "$artifact" ]] && paths+=("${artifact#"$OUT_DIR"/}")
        done
      fi
      for path in "${paths[@]}"; do redo_record_if_present ARTIFACT "$phase" "$path"; done
    done
  } > "$REDO_MARKER_TEMP" || diag_die "cannot write redo transaction"
  redo_transaction_publish
}

recover_pending_redo() {
  local pending="$STATE_DIR/redo.pending"
  [[ -e "$pending" || -L "$pending" ]] || return 0
  diag_log "recovering interrupted redo transaction before phase execution"
  redo_transaction_execute
  REDO_RECOVERED_PENDING=1
}

redo_marker_temp_cleanup() {
  if [[ -n "$REDO_MARKER_TEMP" ]]; then
    case "$REDO_MARKER_TEMP" in "$STATE_DIR"/.redo.pending.*) rm -f -- "$REDO_MARKER_TEMP" ;; esac
    REDO_MARKER_TEMP=""
    REDO_NEW_TXN_ID=""
  fi
  if [[ -n "$META_UPDATE_TEMP" ]]; then
    case "$META_UPDATE_TEMP" in "${META_FILE%/*}"/.meta.env.*) rm -f -- "$META_UPDATE_TEMP" ;; esac
    META_UPDATE_TEMP=""
  fi
  if [[ -n "$GROUP_PLAN_TEMP" ]]; then
    case "$GROUP_PLAN_TEMP" in /tmp/.groups.plan.*) rm -f -- "$GROUP_PLAN_TEMP" ;; esac
    GROUP_PLAN_TEMP=""
    GROUP_PLAN_DIGEST=""
  fi
  if [[ -n "$PINNED_CONTEXTS_TEMP" ]]; then
    case "$PINNED_CONTEXTS_TEMP" in /tmp/.pinned-contexts.*) rm -f -- "$PINNED_CONTEXTS_TEMP" ;; esac
    PINNED_CONTEXTS_TEMP=""
  fi
  if [[ -n "$GROUP_META_TEMP" ]]; then
    case "$GROUP_META_TEMP" in "${OUT_DIR:-}/results"/.groups.meta.*) rm -f -- "$GROUP_META_TEMP" ;; esac
    GROUP_META_TEMP=""
  fi
  GROUPS_META_GENERATION=""
  if [[ -n "$PREFLIGHT_MANIFEST_TEMP" ]]; then
    case "$PREFLIGHT_MANIFEST_TEMP" in "${OUT_DIR:-}/env"/.preflight.manifest.*) rm -f -- "$PREFLIGHT_MANIFEST_TEMP" ;; esac
    PREFLIGHT_MANIFEST_TEMP=""
  fi
  if [[ -n "$PREFLIGHT_META_TEMP" ]]; then
    case "$PREFLIGHT_META_TEMP" in "${OUT_DIR:-}/results"/.preflight.meta.*) rm -f -- "$PREFLIGHT_META_TEMP" ;; esac
    PREFLIGHT_META_TEMP=""
  fi
  if [[ -n "$GDB_META_TEMP" ]]; then
    case "$GDB_META_TEMP" in "${OUT_DIR:-}/results"/.gdb.meta.*) rm -f -- "$GDB_META_TEMP" ;; esac
    GDB_META_TEMP=""
  fi
  privacy_review_temp_cleanup || true
}

# ---------------------------------------------------------------------------
# Topology discovery (sysfs only; nothing hardcoded to this machine)
# ---------------------------------------------------------------------------
ONLINE_CPUS=""
KERNEL_ONLINE_CPUS=""
ALLOWED_CPUS=""
P_CORES=""
E_CORES=""
declare -a GROUP_NAME=()
declare -a GROUP_KIND=()
declare -a GROUP_CPUS=()
declare -a GROUP_CLUSTER=()
declare -a CONCURRENT_NAME=()
declare -a CONCURRENT_KIND=()
declare -a CONCURRENT_CPUS=()
declare -a CONCURRENT_CLUSTER=()
declare -a CONCURRENT_CONTROLLER=()
PINNED_CONCURRENT_UNAVAILABLE_REASON=""

add_group() {
  GROUP_NAME+=("$1")
  GROUP_KIND+=("$2")
  GROUP_CPUS+=("$3")
  GROUP_CLUSTER+=("$4")
}

add_concurrent_context() {
  CONCURRENT_NAME+=("$1")
  CONCURRENT_KIND+=("$2")
  CONCURRENT_CPUS+=("$3")
  CONCURRENT_CLUSTER+=("$4")
  CONCURRENT_CONTROLLER+=("$5")
}

# unique sorted cpu list from stdin expansion of $1
cpu_list_sorted() {
  diag_cpulist_expand "$1" | sort -n | uniq
}

cpulist_first_outside() {
  local active="$1" candidate
  while read -r candidate; do
    diag_cpulist_contains "$active" "$candidate" || {
      printf '%s\n' "$candidate"
      return 0
    }
  done < <(cpu_list_sorted "$ONLINE_CPUS")
  return 1
}

add_partitioned_concurrent_contexts() {
  local base_name="$1" kind="$2" cpulist="$3"
  local -a cpus=() unit_keys=()
  mapfile -t cpus < <(cpu_list_sorted "$cpulist")
  ((${#cpus[@]} >= 2)) || return 1
  declare -A units=()
  local cpu package_id core_id key
  for cpu in "${cpus[@]}"; do
    package_id="$(cat "/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id" 2> /dev/null || true)"
    core_id="$(cat "/sys/devices/system/cpu/cpu${cpu}/topology/core_id" 2> /dev/null || true)"
    [[ "$package_id" =~ ^(0|[1-9][0-9]*)$ ]] || package_id=unknown
    [[ "$core_id" =~ ^(0|[1-9][0-9]*)$ ]] || core_id="cpu${cpu}"
    key="$package_id:$core_id"
    units[$key]="${units[$key]:+${units[$key]},}$cpu"
  done
  mapfile -t unit_keys < <(printf '%s\n' "${!units[@]}" | LC_ALL=C sort)
  local -a left=() right=() members=()
  local index=0 member
  if ((${#unit_keys[@]} >= 2)); then
    for key in "${unit_keys[@]}"; do
      IFS=',' read -ra members <<< "${units[$key]}"
      if ((index % 2 == 0)); then left+=("${members[@]}"); else right+=("${members[@]}"); fi
      index=$((index + 1))
    done
  else
    for member in "${cpus[@]}"; do
      if ((index % 2 == 0)); then left+=("$member"); else right+=("$member"); fi
      index=$((index + 1))
    done
  fi
  ((${#left[@]} > 0 && ${#right[@]} > 0)) || return 1
  local left_list right_list left_controller right_controller
  left_list="$(printf '%s\n' "${left[@]}" | sort -n -u | diag_cpulist_compress)"
  right_list="$(printf '%s\n' "${right[@]}" | sort -n -u | diag_cpulist_compress)"
  left_controller="$(cpulist_first_outside "$left_list")" || return 1
  right_controller="$(cpulist_first_outside "$right_list")" || return 1
  add_concurrent_context "${base_name}-a" "$kind" "$left_list" "-" "$left_controller"
  add_concurrent_context "${base_name}-b" "$kind" "$right_list" "-" "$right_controller"
}

build_concurrent_contexts() {
  CONCURRENT_NAME=()
  CONCURRENT_KIND=()
  CONCURRENT_CPUS=()
  CONCURRENT_CLUSTER=()
  CONCURRENT_CONTROLLER=()
  PINNED_CONCURRENT_UNAVAILABLE_REASON=""
  local i controller
  for ((i = 0; i < ${#GROUP_NAME[@]}; i++)); do
    if controller="$(cpulist_first_outside "${GROUP_CPUS[$i]}")"; then
      add_concurrent_context "${GROUP_NAME[$i]}" "${GROUP_KIND[$i]}" \
        "${GROUP_CPUS[$i]}" "${GROUP_CLUSTER[$i]}" "$controller"
    elif ! add_partitioned_concurrent_contexts "${GROUP_NAME[$i]}" \
      "${GROUP_KIND[$i]}-partition" "${GROUP_CPUS[$i]}"; then
      PINNED_CONCURRENT_UNAVAILABLE_REASON="no topology partition leaves a controller CPU outside the active set"
      break
    fi
  done
  if [[ -n "$PINNED_CONCURRENT_UNAVAILABLE_REASON" ]]; then
    CONCURRENT_NAME=()
    CONCURRENT_KIND=()
    CONCURRENT_CPUS=()
    CONCURRENT_CLUSTER=()
    CONCURRENT_CONTROLLER=()
  fi
  if ((${#CONCURRENT_NAME[@]} == 0)) && [[ -z "$PINNED_CONCURRENT_UNAVAILABLE_REASON" ]]; then
    PINNED_CONCURRENT_UNAVAILABLE_REASON="no valid pinned-concurrent topology context was discovered"
  fi
}

pinned_contexts_prepare() {
  if [[ -n "$PINNED_CONTEXTS_TEMP" && -f "$PINNED_CONTEXTS_TEMP" &&
    ! -L "$PINNED_CONTEXTS_TEMP" ]]; then
    return 0
  fi
  ((${#CONCURRENT_NAME[@]} > 0)) || return 1
  PINNED_CONTEXTS_TEMP="$(mktemp /tmp/.pinned-contexts.XXXXXX)" || return 1
  chmod 0600 "$PINNED_CONTEXTS_TEMP" || return 1
  local i comma="" cpus_json
  printf '[' > "$PINNED_CONTEXTS_TEMP" || return 1
  for ((i = 0; i < ${#CONCURRENT_NAME[@]}; i++)); do
    [[ "${CONCURRENT_NAME[$i]}" =~ ^[a-z][a-z0-9_-]{0,63}$ &&
      "${CONCURRENT_KIND[$i]}" =~ ^[a-z][a-z0-9-]{0,31}$ &&
      "${CONCURRENT_CONTROLLER[$i]}" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
    cpus_json="$(cpu_list_sorted "${CONCURRENT_CPUS[$i]}" | paste -sd, -)" || return 1
    [[ -n "$cpus_json" ]] || return 1
    printf '%s{"group":"%s","kind":"%s","cpus":[%s],"cluster":"%s","controllerCpu":%s}' \
      "$comma" "${CONCURRENT_NAME[$i]}" "${CONCURRENT_KIND[$i]}" "$cpus_json" \
      "${CONCURRENT_CLUSTER[$i]}" "${CONCURRENT_CONTROLLER[$i]}" \
      >> "$PINNED_CONTEXTS_TEMP" || return 1
    comma=,
  done
  printf ']\n' >> "$PINNED_CONTEXTS_TEMP" || return 1
}

discover_topology() {
  KERNEL_ONLINE_CPUS="$(cat /sys/devices/system/cpu/online 2> /dev/null || echo "")"
  [[ -n "$KERNEL_ONLINE_CPUS" ]] || KERNEL_ONLINE_CPUS="0-$(( $(nproc) - 1 ))"
  ALLOWED_CPUS="$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status 2> /dev/null)"
  [[ -n "$ALLOWED_CPUS" ]] || ALLOWED_CPUS="$KERNEL_ONLINE_CPUS"
  ONLINE_CPUS="$(diag_cpulist_intersect "$KERNEL_ONLINE_CPUS" "$ALLOWED_CPUS")"
  [[ -n "$ONLINE_CPUS" ]] ||
    diag_die "no usable CPU is both online and allowed by this process's affinity/cpuset"

  if [[ -r /sys/devices/cpu_core/cpus ]]; then
    P_CORES="$(diag_cpulist_intersect "$(cat /sys/devices/cpu_core/cpus)" "$ONLINE_CPUS")"
  fi
  if [[ -r /sys/devices/cpu_atom/cpus ]]; then
    E_CORES="$(diag_cpulist_intersect "$(cat /sys/devices/cpu_atom/cpus)" "$ONLINE_CPUS")"
  fi

  if [[ -n "$P_CORES" || -n "$E_CORES" ]]; then
    local overlap classified
    overlap="$(diag_cpulist_intersect "$P_CORES" "$E_CORES")"
    [[ -z "$overlap" ]] ||
      diag_die "sysfs P/E CPU class masks overlap ($overlap); refusing an ambiguous topology plan"
    classified="$({ cpu_list_sorted "$P_CORES"; cpu_list_sorted "$E_CORES"; } |
      sort -n -u | diag_cpulist_compress)"
    [[ "$classified" == "$ONLINE_CPUS" ]] ||
      diag_die "sysfs P/E CPU class masks do not exactly cover the usable CPU set ($ONLINE_CPUS); discovered $classified"
  fi

  if [[ -n "$P_CORES" ]]; then
    add_group "pcores" "pcore" "$P_CORES" "-"
  fi
  if [[ -n "$E_CORES" ]]; then
    add_group "ecores" "ecore" "$E_CORES" "-"
    # Individual E-core clusters by topology/cluster_id (fallback: shared L2).
    declare -A cluster_map=()
    local cpu cid package_id cluster_key
    while read -r cpu; do
      cid="unknown"
      if [[ -r "/sys/devices/system/cpu/cpu${cpu}/topology/cluster_id" ]]; then
        local discovered_cid
        discovered_cid="$(cat "/sys/devices/system/cpu/cpu${cpu}/topology/cluster_id")"
        if [[ "$discovered_cid" =~ ^(0|[1-9][0-9]*)$ ]] &&
          ((${#discovered_cid} < 6 || (${#discovered_cid} == 5 && discovered_cid <= 65535))); then
          cid="$discovered_cid"
        fi
      fi
      if [[ "$cid" == unknown && -r "/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list" ]]; then
        local shared_l2
        shared_l2="$(cat "/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list")"
        shared_l2="$(diag_cpulist_intersect "$shared_l2" "$ONLINE_CPUS")"
        [[ -n "$shared_l2" ]] && cid="l2:$shared_l2"
      fi
      package_id="$(cat "/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id" 2> /dev/null || true)"
      [[ "$package_id" =~ ^(0|[1-9][0-9]*)$ ]] || package_id=unknown
      cluster_key="$package_id|$cid"
      cluster_map[$cluster_key]="${cluster_map[$cluster_key]:+${cluster_map[$cluster_key]},}$cpu"
    done < <(cpu_list_sorted "$E_CORES")
    local cid_key cpus group_name cluster_hash stored_cluster stored_package raw_cluster
    while read -r cid_key; do
      [[ -n "$cid_key" ]] || continue
      cpus="$(cpu_list_sorted "${cluster_map[$cid_key]}" | diag_cpulist_compress)"
      stored_package="${cid_key%%|*}"
      raw_cluster="${cid_key#*|}"
      if [[ "$raw_cluster" == l2:* ]]; then
        stored_cluster="$raw_cluster"
        cluster_hash="$(printf '%s' "$stored_cluster" | sha256sum | cut -c1-12)"
        group_name="ecluster-l2-$cluster_hash"
      else
        stored_cluster="topo:${stored_package}:${raw_cluster}"
        cluster_hash="$(printf '%s' "$stored_cluster" | sha256sum | cut -c1-12)"
        group_name="ecluster-topo-$cluster_hash"
      fi
      add_group "$group_name" "ecluster" "$cpus" "$stored_cluster"
    done < <(printf '%s\n' "${!cluster_map[@]}" | LC_ALL=C sort)
  fi
  if [[ -z "$P_CORES" && -z "$E_CORES" ]]; then
    add_group "all-cpus" "uniform" "$ONLINE_CPUS" "-"
  fi
  build_concurrent_contexts
}

group_children() {
  local n
  n="$(diag_cpulist_count "$1")"
  ((n > 16)) && n=16
  printf '%s' "$n"
}

# ---------------------------------------------------------------------------
# Safety warning, memory guard, consent
# ---------------------------------------------------------------------------
mem_available_kib() {
  awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2> /dev/null || echo 0
}

safety_gate() {
  local need_kib=$((BASELINE_CHILDREN * 1400000)) # ~1.3 GiB per child, in KiB
  local have_kib
  have_kib="$(mem_available_kib)"
  diag_warn "this workload is memory-intensive: the baseline phase runs"
  diag_warn "$BASELINE_CHILDREN concurrent children (~$((BASELINE_CHILDREN * 13 / 10)) GiB peak),"
  diag_warn "intentionally triggers SIGSEGV crashes, and may take considerable time."
  if ((have_kib > 0 && have_kib < need_kib)); then
    diag_warn "available memory (~$((have_kib / 1048576)) GiB) is below the estimated need (~$((need_kib / 1048576)) GiB)"
    if ((ASSUME_YES == 0)); then
      diag_die "insufficient memory for the baseline phase; try --quick"
    fi
  fi
  if ((ASSUME_YES == 1)); then
    return 0
  fi
  if [[ -t 0 ]]; then
    local reply
    read -r -p "Proceed with the diagnostic run? [y/N] " reply
    [[ "$reply" =~ ^[yY]([eE][sS])?$ ]] || diag_die "aborted by user"
  else
    diag_die "non-interactive run requires --yes to accept the safety warning"
  fi
}

# ---------------------------------------------------------------------------
# Phase runners
# ---------------------------------------------------------------------------

telemetry_active_clear() {
  TELEMETRY_ACTIVE_PHASE=""
  TELEMETRY_ACTIVE_TAG=""
  TELEMETRY_ACTIVE_GENERATION=""
  TELEMETRY_ACTIVE_SEGMENT=""
  TELEMETRY_ACTIVE_LOG=""
  TELEMETRY_ACTIVE_BOUNDARY=""
  TELEMETRY_ACTIVE_STATE=""
  TELEMETRY_BOUNDARY_STARTED=0
}

telemetry_unstarted_artifacts_discard() {
  [[ "$TELEMETRY_BOUNDARY_STARTED" == 0 && -z "${DIAG_TELEMETRY_PID:-}" &&
    -n "$TELEMETRY_ACTIVE_LOG" && -n "$TELEMETRY_ACTIVE_STATE" &&
    -n "$TELEMETRY_ACTIVE_BOUNDARY" ]] || return 1
  local path
  for path in "$TELEMETRY_ACTIVE_LOG" "$TELEMETRY_ACTIVE_STATE" \
    "$TELEMETRY_ACTIVE_BOUNDARY"; do
    [[ ! -e "$path" && ! -L "$path" ]] || bundle_owned_single_regular "$path" || return 1
  done
  bundle_owned_real_dir "${TELEMETRY_ACTIVE_LOG%/*}" &&
    bundle_owned_real_dir "${TELEMETRY_ACTIVE_STATE%/*}" || return 1
  for path in "$TELEMETRY_ACTIVE_LOG" "$TELEMETRY_ACTIVE_STATE" \
    "$TELEMETRY_ACTIVE_BOUNDARY"; do
    [[ ! -e "$path" && ! -L "$path" ]] || rm -f -- "$path" || return 1
  done
  sync -f "${TELEMETRY_ACTIVE_LOG%/*}" &&
    sync -f "${TELEMETRY_ACTIVE_STATE%/*}"
}

telemetry_phase_generation_read() {
  local phase="$1" directory="$STATE_DIR/telemetry-$phase"
  local file="$directory/generation" generation size lines
  bundle_prepare_dir telemetry || return 1
  bundle_prepare_dir "telemetry/$phase" || return 1
  bundle_prepare_dir "state/telemetry-$phase" || return 1
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    bundle_create_empty_exclusive "$file" 0600 || return 1
    generation="$(node "$LIB/telemetry-session.mjs" mint-generation)" || return 1
    [[ "$generation" =~ ^[a-f0-9]{32}$ ]] || return 1
    printf '%s\n' "$generation" > "$file" || return 1
    sync -f "$file" && sync -f "$directory" || return 1
  fi
  bundle_owned_single_regular "$file" || return 1
  size="$(stat -c %s -- "$file" 2> /dev/null)" || return 1
  lines="$(wc -l < "$file")" || return 1
  IFS= read -r generation < "$file" || return 1
  [[ "$size" == 33 && "$lines" == 1 && "$generation" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf '%s\n' "$generation"
}

telemetry_sampler_start() {
  local phase="$1" tag="$2" segment="$3" generation i pid expected_start
  [[ -z "${DIAG_TELEMETRY_PID:-}" && -z "$TELEMETRY_ACTIVE_PHASE" ]] || return 1
  [[ "$phase" =~ ^(baseline|groups|individual|pinned-concurrent|gdb)$ &&
    "$tag" =~ ^[a-z0-9][a-z0-9_.-]{0,127}$ &&
    "$segment" =~ ^[1-9][0-9]*$ ]] || return 1
  generation="$(telemetry_phase_generation_read "$phase")" || return 1
  TELEMETRY_ACTIVE_PHASE="$phase"
  TELEMETRY_ACTIVE_TAG="$tag"
  TELEMETRY_ACTIVE_GENERATION="$generation"
  TELEMETRY_ACTIVE_SEGMENT="$segment"
  TELEMETRY_ACTIVE_LOG="$OUT_DIR/telemetry/$phase/$generation-$segment.ndjson"
  TELEMETRY_ACTIVE_BOUNDARY="$OUT_DIR/telemetry/$phase/$generation-$segment.boundary.json"
  TELEMETRY_ACTIVE_STATE="$STATE_DIR/telemetry-$phase/$generation-$segment.start.json"
  [[ ! -e "$TELEMETRY_ACTIVE_LOG" && ! -L "$TELEMETRY_ACTIVE_LOG" &&
    ! -e "$TELEMETRY_ACTIVE_BOUNDARY" && ! -L "$TELEMETRY_ACTIVE_BOUNDARY" &&
    ! -e "$TELEMETRY_ACTIVE_STATE" && ! -L "$TELEMETRY_ACTIVE_STATE" ]] || {
    telemetry_active_clear
    return 1
  }
  diag_supervised_group_start DIAG_TELEMETRY_PID "telemetry sampler" \
    node "$LIB/telemetry-sampler.mjs" --output "$TELEMETRY_ACTIVE_LOG" \
    --cpus "$ONLINE_CPUS" --interval-ms "$TELEMETRY_INTERVAL_MS" \
    --no-turbo-path /sys/devices/system/cpu/intel_pstate/no_turbo || {
    if [[ -n "${DIAG_TELEMETRY_PID:-}" ]]; then
      telemetry_segment_stop || return "$DIAG_OPERATIONAL_ERROR_RC"
    else
      telemetry_unstarted_artifacts_discard || true
    fi
    telemetry_active_clear
    return "$DIAG_OPERATIONAL_ERROR_RC"
  }
  pid="$DIAG_TELEMETRY_PID"
  expected_start="${DIAG_SUPERVISED_GROUP_START_TICKS[DIAG_TELEMETRY_PID]:-}"
  for ((i = 0; i < 100; i++)); do
    grep -q '"type":"telemetry_sample"' "$TELEMETRY_ACTIVE_LOG" 2> /dev/null && return 0
    diag_is_uint "$expected_start" &&
      diag_process_identity_is_live "$pid" "$expected_start" || break
    sleep 0.05
  done
  diag_warn "$phase telemetry sampler did not produce its initial sample"
  telemetry_segment_stop || return "$DIAG_OPERATIONAL_ERROR_RC"
  return "$DIAG_OPERATIONAL_ERROR_RC"
}

telemetry_boundary_start() {
  [[ -n "$TELEMETRY_ACTIVE_PHASE" && -n "${DIAG_TELEMETRY_PID:-}" &&
    "$TELEMETRY_BOUNDARY_STARTED" == 0 ]] || return 1
  node "$LIB/telemetry-session.mjs" start \
    --state-file "$TELEMETRY_ACTIVE_STATE" --phase "$TELEMETRY_ACTIVE_PHASE" \
    --tag "$TELEMETRY_ACTIVE_TAG" --generation "$TELEMETRY_ACTIVE_GENERATION" \
    --segment "$TELEMETRY_ACTIVE_SEGMENT" \
    --no-turbo-path /sys/devices/system/cpu/intel_pstate/no_turbo > /dev/null || return 1
  TELEMETRY_BOUNDARY_STARTED=1
}

telemetry_segment_stop() {
  [[ -n "$TELEMETRY_ACTIVE_PHASE" || -n "${DIAG_TELEMETRY_PID:-}" ]] || {
    telemetry_active_clear
    return 0
  }
  local stop_rc=0 premature=0 pid="${DIAG_TELEMETRY_PID:-}"
  local expected_start="${DIAG_SUPERVISED_GROUP_START_TICKS[DIAG_TELEMETRY_PID]:-}"
  if [[ -n "$pid" ]]; then
    diag_is_uint "$expected_start" &&
      diag_process_identity_is_live "$pid" "$expected_start" || premature=1
  fi
  if [[ "$TELEMETRY_BOUNDARY_STARTED" == 1 ]]; then
    if node "$LIB/telemetry-session.mjs" finish \
      --state-file "$TELEMETRY_ACTIVE_STATE" \
      --boundary-output "$TELEMETRY_ACTIVE_BOUNDARY" \
      --no-turbo-path /sys/devices/system/cpu/intel_pstate/no_turbo \
      > /dev/null 2>&1; then
      TELEMETRY_BOUNDARY_STARTED=2
    else
      TELEMETRY_DEGRADED=1
      diag_warn "$TELEMETRY_ACTIVE_PHASE telemetry boundary could not be finalized; workload evidence is retained"
    fi
  fi
  diag_supervised_group_stop DIAG_TELEMETRY_PID "telemetry sampler" 40 || stop_rc=$?
  if ((stop_rc != 0)); then
    return "$stop_rc"
  fi
  if [[ "$TELEMETRY_BOUNDARY_STARTED" == 0 ]]; then
    telemetry_unstarted_artifacts_discard || {
      TELEMETRY_DEGRADED=1
      diag_warn "$TELEMETRY_ACTIVE_PHASE telemetry left an unstarted segment that could not be safely discarded"
    }
  fi
  if ((premature == 1)); then
    TELEMETRY_DEGRADED=1
    diag_warn "$TELEMETRY_ACTIVE_PHASE telemetry sampler ended before its workload boundary; workload evidence is retained"
  fi
  telemetry_active_clear
  return 0
}

TELEMETRY_WORKLOAD_GENERATION=""
TELEMETRY_WORKLOAD_BINDING_SHA256=""
TELEMETRY_WORKLOAD_BOUNDARIES_SHA256=""
TELEMETRY_WORKLOAD_BOUNDARY_ROW_COUNT=""
telemetry_workload_binding_read() {
  local phase="$1" output line key value count=0
  local version="" format="" bound_phase="" generation="" digest="" boundaries="" boundary_rows=""
  local -A seen=()
  output="$(node "$LIB/telemetry-workload-binding.mjs" "$phase" "$OUT_DIR" 2> /dev/null)" || return 1
  ((${#output} > 0 && ${#output} <= 1024)) || return 1
  [[ "$output" != *$'\r'* ]] || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]] || return 1
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]+x}" ]] || return 1
    seen["$key"]=1
    ((count += 1))
    case "$key" in
      VERSION) version="$value" ;;
      FORMAT) format="$value" ;;
      PHASE) bound_phase="$value" ;;
      WORKLOAD_GENERATION) generation="$value" ;;
      WORKLOAD_BINDING_SHA256) digest="$value" ;;
      WORKLOAD_BOUNDARIES_SHA256) boundaries="$value" ;;
      WORKLOAD_BOUNDARY_ROW_COUNT) boundary_rows="$value" ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ "$count" == 7 && "$version" == 1 &&
    "$format" == node-pglite-diagnostics/telemetry-workload-binding/v1 &&
    "$bound_phase" == "$phase" && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [[ "$phase" == baseline ]]; then
    [[ "$generation" == - ]] || return 1
  else
    [[ "$generation" =~ ^[0-9a-f]{32}$ ]] || return 1
  fi
  if [[ "$phase" == individual || "$phase" == pinned-concurrent ]]; then
    [[ "$boundaries" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$boundary_rows" =~ ^[1-9][0-9]*$ && ${#boundary_rows} -le 8 ]] || return 1
    ((boundary_rows <= 20000000)) || return 1
  else
    [[ "$boundaries" == - && "$boundary_rows" == - ]] || return 1
  fi
  TELEMETRY_WORKLOAD_GENERATION="$generation"
  TELEMETRY_WORKLOAD_BINDING_SHA256="$digest"
  TELEMETRY_WORKLOAD_BOUNDARIES_SHA256="$boundaries"
  TELEMETRY_WORKLOAD_BOUNDARY_ROW_COUNT="$boundary_rows"
}

telemetry_phase_publish() {
  local phase="$1" segments_json="$2" generation index meta output
  generation="$(telemetry_phase_generation_read "$phase")" || {
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry generation is unavailable; workload evidence is retained"
    return 0
  }
  index="$OUT_DIR/results/telemetry-$phase.tsv"
  meta="$OUT_DIR/results/telemetry-$phase.meta"
  if [[ -e "$index" || -L "$index" || -e "$meta" || -L "$meta" ]]; then
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry envelope already exists or is unsafe; workload evidence is retained"
    return 0
  fi
  telemetry_workload_binding_read "$phase" || {
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry could not bind the exact owning workload evidence; workload evidence is retained"
    return 0
  }
  output="$(node "$LIB/telemetry-session.mjs" envelope --bundle-dir "$OUT_DIR" \
    --phase "$phase" --generation "$generation" --interval-ms "$TELEMETRY_INTERVAL_MS" \
    --workload-generation "$TELEMETRY_WORKLOAD_GENERATION" \
    --workload-binding-sha256 "$TELEMETRY_WORKLOAD_BINDING_SHA256" \
    --workload-boundaries-sha256 "$TELEMETRY_WORKLOAD_BOUNDARIES_SHA256" \
    --workload-boundary-row-count "$TELEMETRY_WORKLOAD_BOUNDARY_ROW_COUNT" \
    --segments-json "$segments_json" --index-output "$index" --meta-output "$meta" \
    2> /dev/null)" || {
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry envelope could not be validated; workload evidence is retained"
    return 0
  }
  [[ "$output" =~ \"status\":\"(complete|incomplete)\" ]] || {
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry envelope returned an unknown status; workload evidence is retained"
    return 0
  }
  if [[ "${BASH_REMATCH[1]}" != complete ]]; then
    TELEMETRY_DEGRADED=1
    diag_warn "$phase telemetry is incomplete; workload evidence remains independently valid"
  fi
}

TELEMETRY_RESUME_NEXT_SEGMENT=""
TELEMETRY_RESUME_SEGMENTS_JSON=""
TELEMETRY_RESUME_AVAILABLE=0
telemetry_resumable_prepare() {
  local phase="$1" tag_prefix="$2" generation phase_dir state_dir name kind segment
  local -a segments=() state_segments=()
  local expected=1 json="[" comma="" entry_count=0 state_entry_count=0 state_index
  generation="$(telemetry_phase_generation_read "$phase")" || return 1
  phase_dir="$OUT_DIR/telemetry/$phase"
  state_dir="$STATE_DIR/telemetry-$phase"
  while IFS=$'\t' read -r name kind; do
    [[ -n "$name" ]] || continue
    ((entry_count += 1))
    [[ "$kind" == f ]] || return 1
    if [[ "$name" =~ ^${generation}-([1-9][0-9]*)\.ndjson$ ]]; then
      segments+=("${BASH_REMATCH[1]}")
    elif [[ "$name" =~ ^${generation}-([1-9][0-9]*)\.boundary\.json$ ]]; then
      :
    else
      return 1
    fi
  done < <(find "$phase_dir" -mindepth 1 -maxdepth 1 -printf '%f\t%y\n' | LC_ALL=C sort)
  if ((${#segments[@]} > 0)); then
    mapfile -t segments < <(printf '%s\n' "${segments[@]}" | sort -n)
  fi
  while IFS=$'\t' read -r name kind; do
    [[ -n "$name" ]] || continue
    ((state_entry_count += 1))
    [[ "$kind" == f ]] || return 1
    if [[ "$name" == generation ]]; then
      :
    elif [[ "$name" =~ ^${generation}-([1-9][0-9]*)\.start\.json$ ]]; then
      state_segments+=("${BASH_REMATCH[1]}")
    else
      return 1
    fi
  done < <(find "$state_dir" -mindepth 1 -maxdepth 1 -printf '%f\t%y\n' | LC_ALL=C sort)
  if ((${#state_segments[@]} > 0)); then
    mapfile -t state_segments < <(printf '%s\n' "${state_segments[@]}" | sort -n)
  fi
  ((${#state_segments[@]} == ${#segments[@]} &&
    state_entry_count == ${#segments[@]} + 1)) || return 1
  for ((state_index = 0; state_index < ${#segments[@]}; state_index++)); do
    [[ "${state_segments[$state_index]}" == "${segments[$state_index]}" ]] || return 1
  done
  for segment in "${segments[@]}"; do
    [[ "$segment" == "$expected" ]] || return 1
    bundle_owned_single_regular "$phase_dir/$generation-$segment.ndjson" || return 1
    bundle_owned_single_regular "$state_dir/$generation-$segment.start.json" || return 1
    if [[ ! -e "$phase_dir/$generation-$segment.boundary.json" &&
      ! -L "$phase_dir/$generation-$segment.boundary.json" ]]; then
      node "$LIB/telemetry-session.mjs" finish --recover \
        --state-file "$state_dir/$generation-$segment.start.json" \
        --boundary-output "$phase_dir/$generation-$segment.boundary.json" \
        --no-turbo-path /sys/devices/system/cpu/intel_pstate/no_turbo \
        > /dev/null || return 1
      ((entry_count += 1))
      TELEMETRY_DEGRADED=1
      diag_warn "$phase telemetry session $segment was recovered after interruption and remains descriptive"
    fi
    bundle_owned_single_regular "$phase_dir/$generation-$segment.boundary.json" || return 1
    printf -v json '%s%s{"segment":%s,"tag":"%s%s"}' \
      "$json" "$comma" "$segment" "$tag_prefix" "$segment"
    comma=,
    expected=$((expected + 1))
  done
  ((entry_count == ${#segments[@]} * 2)) || return 1
  TELEMETRY_RESUME_NEXT_SEGMENT="$expected"
  TELEMETRY_RESUME_SEGMENTS_JSON="$json]"
}

# Telemetry is deliberately descriptive and cannot own workload authority.
# Once a resumable workload has committed state, a damaged or cross-boot
# telemetry session is preserved for the collector to describe, but it must
# not erase or prevent completion of the generation-bound workload evidence.
telemetry_resumable_prepare_descriptive() {
  local phase="$1" tag_prefix="$2"
  TELEMETRY_RESUME_AVAILABLE=0
  TELEMETRY_RESUME_NEXT_SEGMENT=""
  TELEMETRY_RESUME_SEGMENTS_JSON="[]"
  if telemetry_resumable_prepare "$phase" "$tag_prefix"; then
    TELEMETRY_RESUME_AVAILABLE=1
    return 0
  fi
  TELEMETRY_DEGRADED=1
  diag_warn "$phase telemetry resume state is invalid or unavailable; preserving it and continuing the independently bound workload protocol without further telemetry"
  return 0
}

telemetry_resumable_append_active() {
  local tag_prefix="$1" segment="$2" json="$TELEMETRY_RESUME_SEGMENTS_JSON"
  [[ "$segment" == "$TELEMETRY_RESUME_NEXT_SEGMENT" && "$json" == \[*\] ]] || return 1
  if [[ "$json" == "[]" ]]; then
    TELEMETRY_RESUME_SEGMENTS_JSON="[{\"segment\":$segment,\"tag\":\"$tag_prefix$segment\"}]"
  else
    TELEMETRY_RESUME_SEGMENTS_JSON="${json%]},{\"segment\":$segment,\"tag\":\"$tag_prefix$segment\"}]"
  fi
  TELEMETRY_RESUME_NEXT_SEGMENT=$((segment + 1))
}

# Final protocol outputs are deterministic projections of generation-bound,
# immutable state. Keep their staging directories at fixed, redo-owned paths
# so SIGKILL cannot strand untracked wildcard directories. A retry discards
# only a fully validated set of known derived files, then regenerates them.
protocol_finalize_stage_prepare() {
  local stage="$1"
  shift
  case "$stage" in
    "$STATE_DIR/individual-finalize" | "$STATE_DIR/pinned-concurrent-finalize") ;;
    *) return 1 ;;
  esac
  bundle_owned_real_dir "$STATE_DIR" || return 1
  local -A allowed=()
  local name entry
  for name in "$@"; do
    [[ "$name" =~ ^[a-z0-9][a-z0-9.-]{0,127}$ ]] || return 1
    allowed[$name]=1
  done
  if [[ -e "$stage" || -L "$stage" ]]; then
    bundle_owned_real_dir "$stage" || return 1
    while IFS= read -r name; do
      [[ -n "$name" && -n "${allowed[$name]:-}" ]] || return 1
      entry="$stage/$name"
      bundle_owned_single_regular "$entry" || return 1
    done < <(find "$stage" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      rm -f -- "$stage/$name" || return 1
    done < <(find "$stage" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
    rmdir -- "$stage" || return 1
    sync -f "$STATE_DIR" || return 1
  fi
  mkdir -- "$stage" || return 1
  chmod 0700 -- "$stage" || return 1
  sync -f "$STATE_DIR" || return 1
  bundle_owned_real_dir "$stage"
}

protocol_finalize_stage_close() {
  local stage="$1"
  case "$stage" in
    "$STATE_DIR/individual-finalize" | "$STATE_DIR/pinned-concurrent-finalize") ;;
    *) return 1 ;;
  esac
  bundle_owned_real_dir "$stage" || return 1
  [[ -z "$(find "$stage" -mindepth 1 -maxdepth 1 -print -quit 2> /dev/null)" ]] || return 1
  rmdir -- "$stage" || return 1
  sync -f "$STATE_DIR"
}

protocol_file_is_exact_prefix() {
  local prefix="$1" complete="$2" prefix_size complete_size
  bundle_owned_single_regular "$prefix" && bundle_owned_single_regular "$complete" || return 1
  prefix_size="$(stat -c %s -- "$prefix" 2> /dev/null)" || return 1
  complete_size="$(stat -c %s -- "$complete" 2> /dev/null)" || return 1
  [[ "$prefix_size" =~ ^[0-9]+$ && "$complete_size" =~ ^[0-9]+$ ]] || return 1
  ((prefix_size <= complete_size)) || return 1
  cmp -n "$prefix_size" -- "$prefix" "$complete" > /dev/null 2>&1
}

protocol_destination_is_recoverable_prefix() {
  local destination="$1" complete="$2" allow_absent="$3"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    [[ "$allow_absent" == 1 ]]
    return
  fi
  protocol_file_is_exact_prefix "$destination" "$complete"
}

pinned_concurrent_v2_destination_is_recoverable() {
  local destination="$1" complete="$2"
  protocol_file_is_exact_prefix "$destination" "$complete" && return 0
  bundle_owned_single_regular "$destination" || return 1
  cmp -s -- "$destination" <(printf 'round\tgroup\tcpu\tlaunch_position\trc\telapsed_ms\n')
}

# Run repro.mjs with epoch-prefixed output. Always returns 0; REPRO_RC holds
# the repro exit code (1 = failed waves, an expected outcome).
REPRO_RC=0
run_repro_logged() {
  local logf="$1" cpulist="$2" children="$3" waves="$4"
  mkdir -p "$(dirname "$logf")"
  if [[ "$cpulist" == "-" ]]; then
    diag_log_cmd env STOP_ON_FAILURE=0 node repro.mjs "$children" "$waves"
  else
    diag_log_cmd env STOP_ON_FAILURE=0 taskset -c "$cpulist" node repro.mjs "$children" "$waves"
  fi
  if ! diag_process_group_start bash -c '
    logf=$1 cpulist=$2 children=$3 waves=$4 repo=$5 awk_program=$6 operational_rc=$7
    cd "$repo" || exit "$operational_rc"
    if [[ "$cpulist" == "-" ]]; then
      env STOP_ON_FAILURE=0 node repro.mjs "$children" "$waves" 2>&1 |
        awk "$awk_program" > "$logf"
    else
      env STOP_ON_FAILURE=0 taskset -c "$cpulist" node repro.mjs "$children" "$waves" 2>&1 |
        awk "$awk_program" > "$logf"
    fi
    statuses=("${PIPESTATUS[@]}")
    ((statuses[1] == 0)) || exit "$operational_rc"
    exit "${statuses[0]}"
  ' diag-repro "$logf" "$cpulist" "$children" "$waves" "$SCRIPT_DIR" \
    '{print systime()"\t"$0}' "$DIAG_OPERATIONAL_ERROR_RC"; then
    REPRO_RC="$DIAG_OPERATIONAL_ERROR_RC"
  elif diag_process_group_wait; then
    REPRO_RC=0
  else
    REPRO_RC=$?
  fi
}

run_individual_logged() {
  local cpu="$1" runs="$2" tsv="$3" first_run="$4" logf="$5"
  diag_process_group_start bash -c '
    repo=$1 cpu=$2 runs=$3 tsv=$4 first_run=$5 logf=$6 operational_rc=$7
    cd "$repo" || exit "$operational_rc"
    bash single.sh "$cpu" "$runs" "$tsv" "$first_run" 2>&1 |
      tee -a "$logf" | tail -1
    statuses=("${PIPESTATUS[@]}")
    ((statuses[1] == 0 && statuses[2] == 0)) || exit "$operational_rc"
    exit "${statuses[0]}"
  ' diag-individual "$SCRIPT_DIR" "$cpu" "$runs" "$tsv" "$first_run" "$logf" \
    "$DIAG_OPERATIONAL_ERROR_RC" || return "$DIAG_OPERATIONAL_ERROR_RC"
  diag_process_group_wait
}

# Run one pinned-protocol execution unit under the same supervised outer
# process-group contract as the legacy runners. The Node executor owns its
# pinned child process groups and responds to TERM/INT by aborting and reaping
# them before it exits. Canonical stdout stays separate from human diagnostics.
run_pinned_protocol_logged() {
  local output="$1" logf="$2" log_fd="" log_fd_path="" create=0 rc=0
  shift 2
  : > "$output" || return "$DIAG_OPERATIONAL_ERROR_RC"
  if [[ -e "$logf" || -L "$logf" ]]; then
    bundle_owned_single_regular "$logf" || return "$DIAG_OPERATIONAL_ERROR_RC"
  else
    create=1
  fi
  bundle_append_fd_open protocol "$logf" log_fd log_fd_path "$create" ||
    return "$DIAG_OPERATIONAL_ERROR_RC"
  if ! diag_process_group_start "$@" > "$output" 2>> "$log_fd_path"; then
    rc="$DIAG_OPERATIONAL_ERROR_RC"
  else
    diag_process_group_wait || rc=$?
  fi
  if ((rc != 0)) && [[ -s "$output" ]]; then
    printf '[executor rc=%s] %s\n' "$rc" "$(<"$output")" >&"$log_fd" || {
      exec {log_fd}>&- || true
      return "$DIAG_OPERATIONAL_ERROR_RC"
    }
  fi
  exec {log_fd}>&- || return "$DIAG_OPERATIONAL_ERROR_RC"
  return "$rc"
}

# The isolated executor is deliberately a short-lived process around one
# observation. If that process itself crashes, the observation state remains
# the source of truth and the executor can be replaced without restarting the
# phase. INT/TERM/HUP/QUIT remain operator controls rather than retry signals.
isolated_executor_status_is_retryable_crash() {
  case "${1:-}" in
    132 | 133 | 134 | 135 | 136 | 137 | 139 | 141 | 152 | 153 | 159) return 0 ;;
    *) return 1 ;;
  esac
}

ISOLATED_PROGRESS_COMMITTED=""
ISOLATED_PROGRESS_COMPLETE=""
isolated_protocol_progress_parse() {
  # usage: isolated_protocol_progress_parse <json> <total> <minimum>
  local progress="$1" total="$2" minimum="$3" committed complete
  ISOLATED_PROGRESS_COMMITTED=""
  ISOLATED_PROGRESS_COMPLETE=""
  diag_is_uint "$total" && diag_is_uint "$minimum" && ((minimum <= total)) ||
    return 1
  [[ "$progress" =~ \"committedRecords\":([0-9]+) ]] || return 1
  committed="${BASH_REMATCH[1]}"
  [[ "$progress" =~ \"complete\":(true|false) ]] || return 1
  complete="${BASH_REMATCH[1]}"
  ((committed >= minimum && committed <= total)) || return 1
  if [[ "$complete" == true ]]; then
    ((committed == total)) || return 1
  else
    ((committed < total)) || return 1
  fi
  ISOLATED_PROGRESS_COMMITTED="$committed"
  ISOLATED_PROGRESS_COMPLETE="$complete"
}

# The runner log is authoritative evidence: capture-fault.sh writes only its
# canonical ATTEMPT/COUNTS records to stdout, so that stream goes directly
# into an exclusively created private runner.log. Human progress stays on
# stderr (the console) and never enters the evidence file.
run_gdb_logged() {
  local cpu="$1" max_runs="$2" max_captures="$3" out_dir="$4" logf="$5" generation="$6"
  bundle_create_empty_exclusive "$logf" 0600 || return "$DIAG_OPERATIONAL_ERROR_RC"
  diag_process_group_start bash -c '
    repo=$1 cpu=$2 max_runs=$3 max_captures=$4 out_dir=$5 logf=$6 generation=$7 operational_rc=$8
    cd "$repo" || exit "$operational_rc"
    bash capture-fault.sh "$cpu" "$max_runs" "$max_captures" "$out_dir" "$generation" \
      > "$logf"
  ' diag-gdb "$SCRIPT_DIR" "$cpu" "$max_runs" "$max_captures" "$out_dir" "$logf" \
    "$generation" "$DIAG_OPERATIONAL_ERROR_RC" || return "$DIAG_OPERATIONAL_ERROR_RC"
  diag_process_group_wait
}

repro_result_is_complete() {
  local logf="$1" expected_children="$2" expected_waves="$3" rc="$4"
  node "$LIB/parse-repro-log.mjs" --validate-complete \
    "$logf" "$expected_children" "$expected_waves" "$rc"
}

baseline_evidence_is_complete() {
  local validation_mode="${1:---validate-complete}"
  node "$LIB/baseline-evidence.mjs" "$validation_mode" \
    "$OUT_DIR" "$BASELINE_CHILDREN" "$BASELINE_WAVES"
}

groups_plan_prepare() {
  [[ -n "$GROUP_PLAN_TEMP" && -f "$GROUP_PLAN_TEMP" && ! -L "$GROUP_PLAN_TEMP" ]] && return 0
  GROUP_PLAN_TEMP="$(mktemp /tmp/.groups.plan.XXXXXX)" || diag_die "cannot prepare the discovered groups plan"
  local i name kind cpus cluster children logf freq_tag
  for ((i = 0; i < ${#GROUP_NAME[@]}; i++)); do
    name="${GROUP_NAME[$i]}"
    kind="${GROUP_KIND[$i]}"
    cpus="${GROUP_CPUS[$i]}"
    cluster="${GROUP_CLUSTER[$i]}"
    children="$(group_children "$cpus")"
    logf="logs/groups/${name}.log"
    freq_tag="group-${name}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$kind" "$cpus" "$cluster" "$children" "$GROUP_WAVES" \
      "$logf" "$freq_tag" >> "$GROUP_PLAN_TEMP"
  done
  GROUP_PLAN_DIGEST="$(node "$LIB/groups-evidence.mjs" --plan-digest "$GROUP_PLAN_TEMP")" ||
    diag_die "rediscovered CPU-group plan is invalid"
}

groups_evidence_is_complete() {
  local validation_mode="${1:---validate-complete}"
  groups_plan_prepare
  node "$LIB/groups-evidence.mjs" "$validation_mode" \
    "$OUT_DIR" "$GROUP_PLAN_TEMP" "$GROUP_WAVES"
}

groups_meta_publish() {
  local completed="$1" total=${#GROUP_NAME[@]}
  # Mint one random generation per fresh phase attempt and keep it across both
  # publishes (COMPLETED=0, then 1): individual evidence binds this exact
  # generation, so a groups redo must never reuse an archived one.
  if [[ -z "$GROUPS_META_GENERATION" ]]; then
    GROUPS_META_GENERATION="$("$DIAG_INDIVIDUAL_NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" ||
      diag_die "cannot generate groups evidence generation"
  fi
  [[ "$GROUPS_META_GENERATION" =~ ^[a-f0-9]{32}$ ]] ||
    diag_die "cannot publish groups metadata with an invalid generation"
  GROUP_META_TEMP="$(mktemp "$OUT_DIR/results/.groups.meta.XXXXXX")" ||
    diag_die "cannot prepare groups metadata"
  {
    printf 'VERSION=2\n'
    printf 'GENERATION=%s\n' "$GROUPS_META_GENERATION"
    printf 'EXPECTED_ROWS=%s\n' "$total"
    printf 'GROUP_WAVES=%s\n' "$GROUP_WAVES"
    printf 'PLAN_DIGEST=%s\n' "$GROUP_PLAN_DIGEST"
    printf 'COMPLETED=%s\n' "$completed"
  } > "$GROUP_META_TEMP" || diag_die "cannot write groups metadata"
  chmod 0600 "$GROUP_META_TEMP" || diag_die "cannot protect groups metadata"
  mv -fT -- "$GROUP_META_TEMP" "$OUT_DIR/results/groups.meta" ||
    diag_die "cannot publish groups metadata"
  GROUP_META_TEMP=""
}

groups_prepare_fresh_targets() {
  # A fresh phase attempt always mints a new groups generation; never reuse a
  # generation left over from an archived or interrupted attempt.
  GROUPS_META_GENERATION=""
  groups_plan_prepare
  if ! node "$LIB/groups-evidence.mjs" --check-fresh \
    "$OUT_DIR" "$GROUP_PLAN_TEMP" "$GROUP_WAVES"; then
    diag_die "existing CPU-group evidence conflicts with a fresh phase; preserve it and resume with --redo groups"
  fi
  if [[ ! -e "$OUT_DIR/logs/groups" && ! -L "$OUT_DIR/logs/groups" ]]; then
    mkdir "$OUT_DIR/logs/groups" || diag_die "cannot create CPU-group log directory"
  fi
}

groups_require_fresh_row_targets() {
  local name="$1" freq_tag="$2"
  local log="$OUT_DIR/logs/groups/${name}.log"
  local samples="$OUT_DIR/freq/${freq_tag}.samples"
  local method="$OUT_DIR/freq/${freq_tag}.method"
  [[ -d "$OUT_DIR/logs/groups" && ! -L "$OUT_DIR/logs/groups" &&
    -d "$OUT_DIR/freq" && ! -L "$OUT_DIR/freq" &&
    -f "$OUT_DIR/results/groups.tsv" && ! -L "$OUT_DIR/results/groups.tsv" &&
    -f "$OUT_DIR/results/groups.meta" && ! -L "$OUT_DIR/results/groups.meta" &&
    ! -e "$log" && ! -L "$log" && ! -e "$samples" && ! -L "$samples" &&
    ! -e "$method" && ! -L "$method" ]] ||
    diag_die "CPU-group output target for $name appeared or became unsafe; preserve it and resume with --redo groups"
}

baseline_prepare_fresh_targets() {
  local meta="$OUT_DIR/results/baseline.meta"
  local log_dir="$OUT_DIR/logs/baseline"
  local log="$log_dir/run1.log"
  local marker="$STATE_DIR/phase-baseline.done"
  local samples="$OUT_DIR/freq/baseline.samples"
  local method="$OUT_DIR/freq/baseline.method"
  [[ -d "$OUT_DIR/results" && ! -L "$OUT_DIR/results" ]] ||
    diag_die "baseline results directory is unsafe; preserve the bundle and resume with --redo baseline"
  [[ -d "$OUT_DIR/logs" && ! -L "$OUT_DIR/logs" ]] ||
    diag_die "baseline log directory is unsafe; preserve the bundle and resume with --redo baseline"
  [[ -d "$OUT_DIR/freq" && ! -L "$OUT_DIR/freq" ]] ||
    diag_die "baseline frequency directory is unsafe; preserve the bundle and resume with --redo baseline"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] ||
    diag_die "baseline state directory is unsafe; preserve the bundle and resume with --redo baseline"
  [[ ! -e "$meta" && ! -L "$meta" && ! -e "$log" && ! -L "$log" &&
    ! -e "$marker" && ! -L "$marker" && ! -e "$samples" && ! -L "$samples" &&
    ! -e "$method" && ! -L "$method" ]] ||
    diag_die "existing baseline evidence conflicts with a fresh phase; preserve it and resume with --redo baseline"
  if [[ -e "$log_dir" || -L "$log_dir" ]]; then
    [[ -d "$log_dir" && ! -L "$log_dir" ]] ||
      diag_die "baseline log destination is unsafe; preserve the bundle and resume with --redo baseline"
  else
    mkdir "$log_dir" || diag_die "cannot create baseline log directory"
  fi
}

# ------------------------------------------------------------------
# Sanitization helpers. Known identifiers are minimized before they reach
# env/, but raw debugger/tool output still requires review before sharing.

# Retain only kernel parameters relevant to CPU/frequency behavior. A
# denylist cannot anticipate identifiers or credentials carried by arbitrary
# boot parameters (BOOTIF, machine IDs, network config, disk keys, etc.).
diag_sanitize_cmdline() {
  awk '
    BEGIN {
      split("tme mktme mem_encrypt intel_pstate amd_pstate intel_idle.max_cstate processor.max_cstate cpufreq.default_governor idle mitigations nosmt maxcpus nr_cpus nohz nohz_full isolcpus rcu_nocbs", names, " ")
      for (i in names) allowed[names[i]]=1
    }
    {
      for (i=1; i<=NF; i++) {
        token=$i
        key=token
        sub(/=.*/, "", key)
        if (!allowed[key]) continue
        if (token !~ /^[A-Za-z0-9_.-]+(=[A-Za-z0-9_,:+.^-]+)?$/) continue
        if (wrote++) printf " "
        printf "%s", token
      }
    }
    END { if (wrote) printf "\n" }
  '
}

# Substitute a leading $HOME prefix so paths under the user's home directory
# do not leak the account name (e.g. version-manager node installs).
diag_redact_home_prefix() {
  local path="$1"
  if [[ -n "${HOME:-}" && "$path" == "$HOME/"* ]]; then
    printf '~/%s\n' "${path#"$HOME"/}"
  else
    printf '%s\n' "$path"
  fi
}

# ------------------------------------------------------------------
preflight_evidence_is_complete() {
  local mode="${1:---validate-complete}"
  node "$LIB/preflight-evidence.mjs" "$mode" "$OUT_DIR"
}

preflight_prepare_fresh_targets() {
  preflight_evidence_is_complete --check-fresh ||
    diag_die "existing or unsafe preflight evidence conflicts with a fresh phase; preserve it and resume with --redo preflight"
}

preflight_publish_envelope() {
  local env_dir="$1" manifest="$env_dir/preflight.manifest"
  local meta="$OUT_DIR/results/preflight.meta" manifest_tmp meta_tmp
  local name digest generation collected_epoch inventory_digest

  manifest_tmp="$(mktemp "$env_dir/.preflight.manifest.XXXXXX")" ||
    diag_die "cannot prepare preflight manifest"
  PREFLIGHT_MANIFEST_TEMP="$manifest_tmp"
  for name in "${PREFLIGHT_ARTIFACTS[@]}"; do
    digest="$(sha256sum "$env_dir/$name" | awk '{print $1}')" ||
      diag_die "cannot hash preflight artifact $name"
    printf '%s\t%s\n' "$digest" "$name" >> "$manifest_tmp" ||
      diag_die "cannot write preflight manifest"
  done
  chmod 0644 "$manifest_tmp" || diag_die "cannot protect preflight manifest"
  sync -f "$manifest_tmp" || diag_die "cannot synchronize preflight manifest"
  mv -T -- "$manifest_tmp" "$manifest" || diag_die "cannot publish preflight manifest"
  PREFLIGHT_MANIFEST_TEMP=""
  sync -f "$env_dir" || diag_die "cannot synchronize preflight environment directory"

  generation="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" ||
    diag_die "cannot generate preflight evidence generation"
  [[ "$generation" =~ ^[0-9a-f]{32}$ ]] || diag_die "generated invalid preflight generation"
  collected_epoch="$(sed -n 's/^start_epoch=//p' "$env_dir/date.txt")"
  inventory_digest="$(sha256sum "$manifest" | awk '{print $1}')" ||
    diag_die "cannot hash preflight manifest"
  meta_tmp="$(mktemp "$OUT_DIR/results/.preflight.meta.XXXXXX")" ||
    diag_die "cannot prepare preflight metadata"
  PREFLIGHT_META_TEMP="$meta_tmp"
  {
    printf 'VERSION=1\n'
    printf 'GENERATION=%s\n' "$generation"
    printf 'COLLECTED_EPOCH=%s\n' "$collected_epoch"
    printf 'INVENTORY_SHA256=%s\n' "$inventory_digest"
    printf 'COMPLETED=1\n'
  } > "$meta_tmp" || diag_die "cannot write preflight metadata"
  chmod 0644 "$meta_tmp" || diag_die "cannot protect preflight metadata"
  sync -f "$meta_tmp" || diag_die "cannot synchronize preflight metadata"
  mv -T -- "$meta_tmp" "$meta" || diag_die "cannot publish preflight metadata"
  PREFLIGHT_META_TEMP=""
  sync -f "$OUT_DIR/results" || diag_die "cannot synchronize preflight metadata directory"
}

# ------------------------------------------------------------------
phase_preflight() {
  local env_dir="$OUT_DIR/env"
  preflight_prepare_fresh_targets
  mkdir -p "$env_dir"

  {
    printf 'start_iso=%s\n' "$(date -Is)"
    printf 'start_epoch=%s\n' "$(date +%s)"
  } > "$env_dir/date.txt"

  grep -h . /etc/os-release > "$env_dir/os-release.txt" 2> /dev/null || true
  # Kernel identity without the nodename field (the hostname identifies
  # the machine and is deliberately not collected).
  uname -srmv > "$env_dir/uname.txt"
  diag_log_cmd uname -srmv

  {
    printf 'node=%s\n' "$(node --version 2>&1)"
    printf 'v8=%s\n' "$(node -p 'process.versions.v8' 2>&1)"
    printf 'node_path=%s\n' "$(diag_redact_home_prefix "$(command -v node)")"
    printf 'pglite=%s\n' "$(node -e 'console.log(JSON.parse(require("fs").readFileSync("node_modules/@electric-sql/pglite/package.json","utf8")).version)' 2>&1 || echo unknown)"
  } > "$env_dir/node.txt"

  if command -v lscpu > /dev/null 2>&1; then
    diag_run lscpu > "$env_dir/lscpu.txt"
  else
    diag_warn "lscpu not found; CPU details limited to /proc/cpuinfo"
    : > "$env_dir/lscpu.txt"
  fi
  grep -m1 -E 'microcode|stepping' /proc/cpuinfo > "$env_dir/cpuinfo-extra.txt" 2> /dev/null || true
  grep -m1 microcode /proc/cpuinfo >> "$env_dir/cpuinfo-extra.txt" 2> /dev/null || true

  # DMI: explicit allowlist only. Serial numbers, UUIDs, asset tags and
  # chassis/board serials are deliberately never read.
  local dmi_allow=(
    sys_vendor product_name product_family board_vendor board_name
    board_version bios_vendor bios_version bios_date chassis_type
  )
  : > "$env_dir/dmi.txt"
  local f
  for f in "${dmi_allow[@]}"; do
    if [[ -r "/sys/class/dmi/id/$f" ]]; then
      printf '%s=%s\n' "$f" "$(cat "/sys/class/dmi/id/$f")" >> "$env_dir/dmi.txt"
    fi
  done

  # Kernel command line, allowlisted: arbitrary boot parameters can carry
  # stable identifiers or credentials, so only CPU/frequency-relevant tokens
  # are retained. The tme=off detection below reads an allowlisted token.
  diag_run cat /proc/cmdline | diag_sanitize_cmdline > "$env_dir/cmdline.txt"
  diag_run cat /sys/devices/system/cpu/online > "$env_dir/online.txt" 2> /dev/null || true

  # Per-CPU topology table.
  {
    printf '#cpu\tpackage\tcore_id\tcluster_id\tl2_shared\tcpufreq_policy\n'
    local cpu topo pol
    while read -r cpu; do
      topo="/sys/devices/system/cpu/cpu${cpu}/topology"
      pol="-"
      if [[ -e "/sys/devices/system/cpu/cpu${cpu}/cpufreq" ]]; then
        pol="$(basename "$(readlink -f "/sys/devices/system/cpu/cpu${cpu}/cpufreq")")"
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cpu" \
        "$(cat "$topo/physical_package_id" 2> /dev/null || echo -)" \
        "$(cat "$topo/core_id" 2> /dev/null || echo -)" \
        "$(cat "$topo/cluster_id" 2> /dev/null || echo -)" \
        "$(cat "/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list" 2> /dev/null || echo -)" \
        "$pol"
    done < <(cpu_list_sorted "$ONLINE_CPUS")
  } > "$env_dir/topology.tsv"

  # cpufreq state.
  {
    local p
    for p in /sys/devices/system/cpu/cpufreq/policy*; do
      [[ -d "$p" ]] || continue
      printf '[%s]\n' "$(basename "$p")"
      for f in scaling_driver scaling_governor energy_performance_preference \
        scaling_min_freq scaling_max_freq cpuinfo_min_freq cpuinfo_max_freq \
        related_cpus scaling_cur_freq; do
        [[ -r "$p/$f" ]] && printf '%s=%s\n' "$f" "$(cat "$p/$f")"
      done
    done
    if [[ -r /sys/devices/system/cpu/intel_pstate/no_turbo ]]; then
      printf 'intel_pstate/no_turbo=%s\n' "$(cat /sys/devices/system/cpu/intel_pstate/no_turbo)"
    fi
  } > "$env_dir/cpufreq.txt"

  # Power supply state (allowlisted keys only; battery serials excluded).
  {
    local ps u
    for ps in /sys/class/power_supply/*; do
      [[ -e "$ps" ]] || continue
      printf '[%s]\n' "$(basename "$ps")"
      u="$ps/uevent"
      [[ -r "$u" ]] || continue
      grep -E '^POWER_SUPPLY_(TYPE|ONLINE|STATUS|CAPACITY)=' "$u" 2> /dev/null || true
    done
  } > "$env_dir/power.txt"

  # Kernel warnings: unprivileged reads only (dmesg, then journalctl).
  # When neither is permitted, root-checks.sh can collect them manually.
  local kw="$env_dir/kernel-warnings.txt"
  : > "$kw"
  local dmesg_out=""
  if dmesg_out="$(dmesg 2> /dev/null)" && [[ -n "$dmesg_out" ]]; then
    printf '# source: dmesg (unprivileged)\n' >> "$kw"
  elif dmesg_out="$(journalctl -k -b --no-pager -o cat 2> /dev/null)" && [[ -n "$dmesg_out" ]]; then
    printf '# source: journalctl -k -b -o cat (unprivileged; prefix/hostname omitted)\n' >> "$kw"
  else
    printf '# kernel log unavailable unprivileged; run: sudo ./root-checks.sh <bundle>\n' >> "$kw"
    dmesg_out=""
  fi
  if [[ -n "$dmesg_out" ]]; then
    printf '%s\n' "$dmesg_out" |
      grep -iE 'mce|machine check|edac|thermal|tme|mktme|microcode' >> "$kw" || true
  fi

  # intel-undervolt: presence + service state only (unprivileged). The
  # actual read needs root and lives in root-checks.sh.
  local uv_status="not installed"
  {
    if command -v intel-undervolt > /dev/null 2>&1; then
      uv_status="installed; read requires root (see root-checks.sh)"
      printf 'intel-undervolt installed; `intel-undervolt read` requires root.\n'
      printf 'collect it with: sudo ./root-checks.sh <bundle>\n'
      if command -v systemctl > /dev/null 2>&1; then
        local uv_enabled uv_active
        uv_enabled="$(systemctl is-enabled intel-undervolt.service 2>&1 || true)"
        uv_active="$(systemctl is-active intel-undervolt.service 2>&1 || true)"
        printf 'service_enabled=%s\n' "$uv_enabled"
        printf 'service_active=%s\n' "$uv_active"
        uv_status="$uv_status; service $uv_enabled/$uv_active"
      fi
    else
      printf 'intel-undervolt not installed\n'
    fi
  } > "$env_dir/undervolt.txt" 2>&1

  # cctk (Dell Command | Configure): presence only. Every cctk invocation
  # needs root; the explicit read-only allowlist probe lives in
  # root-checks.sh so it can be reviewed before being run with sudo.
  {
    if command -v cctk > /dev/null 2>&1; then
      printf 'cctk installed; all queries require root.\n'
      printf 'allowlisted read-only probe available via: sudo ./root-checks.sh <bundle>\n'
    else
      printf 'cctk not installed\n'
    fi
  } > "$env_dir/cctk.txt" 2>&1

  # Dependency inventory.
  local opt=(gdb turbostat lscpu sudo journalctl systemctl intel-undervolt cctk tac)
  local missing_opt=() c
  {
    printf '# required\n'
    for c in "${REQUIRED_COMMANDS[@]}"; do
      local command_path
      command_path="$(command -v "$c" 2> /dev/null || echo MISSING)"
      printf '%-18s %s\n' "$c" "$(diag_redact_home_prefix "$command_path")"
    done
    printf '# optional\n'
    for c in "${opt[@]}"; do
      if command -v "$c" > /dev/null 2>&1; then
        printf '%-18s %s\n' "$c" "$(diag_redact_home_prefix "$(command -v "$c")")"
      else
        printf '%-18s MISSING\n' "$c"
        missing_opt+=("$c")
      fi
    done
  } > "$env_dir/dependencies.txt"

  # Headline summary for the report.
  local lscpu_field
  lscpu_field() {
    grep -m1 "^$1:" "$env_dir/lscpu.txt" 2> /dev/null | cut -d: -f2- | sed 's/^ *//'
  }
  local tme_state="unknown"
  if grep -qiE '(^| )tme=off( |$)' "$env_dir/cmdline.txt"; then
    tme_state="disabled (tme=off on kernel command line)"
  elif grep -qiE 'x86/tme:.*(enabled|disabled|not enabled)' "$kw" 2> /dev/null; then
    tme_state="$(grep -iE 'x86/tme:' "$kw" | head -1 | sed 's/^.*x86\/tme:/x86\/tme:/')"
  fi
  local power_source="unknown"
  local ac_online
  ac_online="$(cat /sys/class/power_supply/AC*/online 2> /dev/null | head -1 || echo "")"
  if [[ "$ac_online" == "1" ]]; then
    power_source="AC"
  elif [[ "$ac_online" == "0" ]]; then
    power_source="battery"
  fi

  local cpu_model
  cpu_model="$(lscpu_field 'Model name')"
  if [[ -z "$cpu_model" ]]; then
    cpu_model="$(grep -m1 'model name' /proc/cpuinfo 2> /dev/null | cut -d: -f2- | sed 's/^ *//')"
  fi

  {
    printf 'DISTRO=%s\n' "$(grep -m1 '^PRETTY_NAME=' "$env_dir/os-release.txt" 2> /dev/null | cut -d= -f2- | tr -d '"')"
    printf 'KERNEL=%s\n' "$(uname -sr)"
    printf 'CMDLINE=%s\n' "$(tr ' ' '|' < "$env_dir/cmdline.txt" 2> /dev/null)"
    printf 'NODE_VERSION=%s\n' "$(sed -n 's/^node=//p' "$env_dir/node.txt")"
    printf 'V8_VERSION=%s\n' "$(sed -n 's/^v8=//p' "$env_dir/node.txt")"
    printf 'PGLITE_VERSION=%s\n' "$(sed -n 's/^pglite=//p' "$env_dir/node.txt")"
    printf 'CPU_MODEL=%s\n' "$cpu_model"
    printf 'CPU_STEPPING=%s\n' "$(lscpu_field 'Stepping')"
    printf 'CPU_MICROCODE=%s\n' "$(grep -m1 microcode /proc/cpuinfo 2> /dev/null | cut -d: -f2- | sed 's/^ *//')"
    printf 'CPU_ADDRESS_SIZES=%s\n' "$(lscpu_field 'Address sizes')"
    printf 'CPU_LOGICAL=%s\n' "$(nproc)"
    printf 'ONLINE_CPUS=%s\n' "$ONLINE_CPUS"
    printf 'KERNEL_ONLINE_CPUS=%s\n' "$KERNEL_ONLINE_CPUS"
    printf 'ALLOWED_CPUS=%s\n' "$ALLOWED_CPUS"
    printf 'P_CORES=%s\n' "${P_CORES:-none-detected}"
    printf 'E_CORES=%s\n' "${E_CORES:-none-detected}"
    printf 'DMI_PRODUCT=%s\n' "$(sed -n 's/^product_name=//p' "$env_dir/dmi.txt")"
    printf 'DMI_BOARD=%s\n' "$(sed -n 's/^board_name=//p' "$env_dir/dmi.txt")"
    printf 'BIOS_VERSION=%s\n' "$(sed -n 's/^bios_version=//p' "$env_dir/dmi.txt")"
    printf 'BIOS_DATE=%s\n' "$(sed -n 's/^bios_date=//p' "$env_dir/dmi.txt")"
    printf 'CPUFREQ_DRIVER=%s\n' "$(sed -n 's/^scaling_driver=//p' "$env_dir/cpufreq.txt" | head -1)"
    printf 'GOVERNOR=%s\n' "$(sed -n 's/^scaling_governor=//p' "$env_dir/cpufreq.txt" | sort -u | paste -sd, -)"
    printf 'EPP=%s\n' "$(sed -n 's/^energy_performance_preference=//p' "$env_dir/cpufreq.txt" | sort -u | paste -sd, -)"
    printf 'NO_TURBO=%s\n' "$(cat /sys/devices/system/cpu/intel_pstate/no_turbo 2> /dev/null || echo n/a)"
    printf 'TME_STATE=%s\n' "$tme_state"
    printf 'POWER_SOURCE=%s\n' "$power_source"
    printf 'UNDERVOLT_STATE=%s\n' "$uv_status"
    printf 'CCTK_STATE=%s\n' "$(head -1 "$env_dir/cctk.txt")"
    printf 'MISSING_OPTIONAL=%s\n' "${missing_opt[*]:-none}"
  } > "$env_dir/summary.env"

  preflight_publish_envelope "$env_dir"
  preflight_evidence_is_complete --validate-before-mark ||
    diag_die "preflight did not produce a valid complete evidence envelope; preserve it and resume with --redo preflight"
  mark_done preflight
  preflight_evidence_is_complete --validate-complete ||
    diag_die "preflight completion metadata is invalid; preserve it and resume with --redo preflight"
  diag_log "preflight complete: $env_dir"
}

# ------------------------------------------------------------------
phase_baseline() {
  local logf="logs/baseline/run1.log"
  baseline_prepare_fresh_targets
  diag_log "baseline: $BASELINE_CHILDREN children x $BASELINE_WAVES waves, STOP_ON_FAILURE=0"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_sampler_start baseline baseline 1 ||
      diag_die "baseline telemetry failed before workload launch"
  fi
  diag_freq_sampler_start baseline ||
    diag_die "baseline frequency sampler failed before workload launch"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_boundary_start ||
      diag_die "baseline telemetry boundary failed before workload launch"
  fi
  run_repro_logged "$OUT_DIR/$logf" "-" "$BASELINE_CHILDREN" "$BASELINE_WAVES"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_segment_stop ||
      diag_die "baseline telemetry writer could not be confirmed stopped"
  fi
  diag_freq_sampler_stop ||
    diag_die "baseline sampler could not be confirmed stopped; refusing evidence publication"
  [[ -z "$DIAG_WORKLOAD_PID" ]] ||
    diag_die "baseline workload group could not be confirmed stopped; refusing evidence publication"
  {
    printf 'CHILDREN=%s\n' "$BASELINE_CHILDREN"
    printf 'WAVES=%s\n' "$BASELINE_WAVES"
    printf 'LOG=%s\n' "$logf"
    printf 'EXIT_CODE=%s\n' "$REPRO_RC"
  } > "$OUT_DIR/results/baseline.meta"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_phase_publish baseline '[{"segment":1,"tag":"baseline"}]'
  fi
  baseline_evidence_is_complete --validate-before-mark ||
    diag_die "baseline did not produce a valid complete evidence envelope (rc=$REPRO_RC); preserve it and resume with --redo baseline"
  mark_done baseline
}

# ------------------------------------------------------------------
phase_groups() {
  groups_prepare_fresh_targets
  if ! (set -o noclobber; : > "$OUT_DIR/results/groups.tsv") 2> /dev/null; then
    diag_die "cannot safely create groups results; preserve the bundle and resume with --redo groups"
  fi
  groups_meta_publish 0
  local i name kind cpus cluster children logf freq_tag telemetry_tag
  local segments_json="[" segments_comma=""
  local total=${#GROUP_NAME[@]}
  for ((i = 0; i < total; i++)); do
    name="${GROUP_NAME[$i]}"
    kind="${GROUP_KIND[$i]}"
    cpus="${GROUP_CPUS[$i]}"
    cluster="${GROUP_CLUSTER[$i]}"
    children="$(group_children "$cpus")"
    logf="logs/groups/${name}.log"
    freq_tag="group-${name}"
    telemetry_tag="group-${name}"
    groups_require_fresh_row_targets "$name" "$freq_tag"
    diag_log "group $((i + 1))/$total: $name cpus=$cpus children=$children waves=$GROUP_WAVES"
    if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
      telemetry_sampler_start groups "$telemetry_tag" "$((i + 1))" ||
        diag_die "group $name telemetry failed before workload launch"
    fi
    diag_freq_sampler_start "$freq_tag" ||
      diag_die "group $name frequency sampler failed before workload launch"
    if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
      telemetry_boundary_start ||
        diag_die "group $name telemetry boundary failed before workload launch"
    fi
    run_repro_logged "$OUT_DIR/$logf" "$cpus" "$children" "$GROUP_WAVES"
    if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
      telemetry_segment_stop ||
        diag_die "group $name telemetry writer could not be confirmed stopped"
    fi
    diag_freq_sampler_stop ||
      diag_die "group $name sampler could not be confirmed stopped; refusing evidence publication"
    [[ -z "$DIAG_WORKLOAD_PID" ]] ||
      diag_die "group $name workload could not be confirmed stopped; refusing evidence publication"
    repro_result_is_complete "$OUT_DIR/$logf" "$children" "$GROUP_WAVES" "$REPRO_RC" ||
      diag_die "group $name did not produce a complete $GROUP_WAVES-wave result (rc=$REPRO_RC); preserve it and resume with --redo groups"
    [[ -f "$OUT_DIR/results/groups.tsv" && ! -L "$OUT_DIR/results/groups.tsv" ]] ||
      diag_die "groups results became unsafe; preserve the bundle and resume with --redo groups"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$kind" "$cpus" "$cluster" "$children" "$GROUP_WAVES" \
      "$logf" "$freq_tag" "$REPRO_RC" >> "$OUT_DIR/results/groups.tsv"
    if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
      printf -v segments_json '%s%s{"segment":%s,"tag":"%s"}' \
        "$segments_json" "$segments_comma" "$((i + 1))" "$telemetry_tag"
      segments_comma=,
    fi
  done
  segments_json+="]"
  groups_meta_publish 1
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_phase_publish groups "$segments_json"
  fi
  groups_evidence_is_complete --validate-before-mark ||
    diag_die "groups did not produce a valid complete evidence envelope; preserve it and resume with --redo groups"
  mark_done groups
}

# ------------------------------------------------------------------
# Schema 2 tests every usable CPU in a seeded, interleaved schedule. Legacy
# bundles retain their original mode-dependent target policy exactly.
INDIVIDUAL_TARGET_CPUS=""
INDIVIDUAL_TARGET_POLICY=""
INDIVIDUAL_GROUP_PLAN_DIGEST=""
INDIVIDUAL_GROUP_GENERATION=""
compute_individual_targets() {
  local output line key value target_mode="$MODE"
  local seen_policy=0 seen_targets=0 seen_digest=0 seen_group_generation=0
  INDIVIDUAL_TARGET_CPUS=""
  INDIVIDUAL_TARGET_POLICY=""
  INDIVIDUAL_GROUP_PLAN_DIGEST=""
  INDIVIDUAL_GROUP_GENERATION=""
  groups_plan_prepare
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && target_mode=schema2
  output="$(node "$LIB/groups-evidence.mjs" --individual-targets \
    "$OUT_DIR" "$GROUP_PLAN_TEMP" "$GROUP_WAVES" "$target_mode")" ||
    diag_die "cannot derive individual CPU targets from the validated groups evidence; preserve it and resume with --redo groups"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] ||
      diag_die "groups target derivation produced malformed output"
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    case "$key" in
      TARGET_POLICY)
        ((seen_policy == 0)) || diag_die "groups target derivation duplicated its policy"
        [[ "$value" == failed-groups || "$value" == all-group-cpus ||
          "$value" == all-usable-cpus || "$value" == quick-skip ]] ||
          diag_die "groups target derivation produced an invalid policy"
        INDIVIDUAL_TARGET_POLICY="$value"; seen_policy=1
        ;;
      TARGET_CPUS)
        ((seen_targets == 0)) || diag_die "groups target derivation duplicated its CPU target"
        INDIVIDUAL_TARGET_CPUS="$value"; seen_targets=1
        ;;
      GROUP_PLAN_DIGEST)
        ((seen_digest == 0)) || diag_die "groups target derivation duplicated its plan digest"
        [[ "$value" =~ ^[a-f0-9]{64}$ ]] || diag_die "groups target derivation produced an invalid plan digest"
        INDIVIDUAL_GROUP_PLAN_DIGEST="$value"; seen_digest=1
        ;;
      GROUP_GENERATION)
        ((seen_group_generation == 0)) || diag_die "groups target derivation duplicated its group generation"
        [[ "$value" =~ ^[a-f0-9]{32}$ ]] || diag_die "groups target derivation produced an invalid group generation"
        INDIVIDUAL_GROUP_GENERATION="$value"; seen_group_generation=1
        ;;
      *) diag_die "groups target derivation produced an unknown field" ;;
    esac
  done <<< "$output"
  ((seen_policy == 1 && seen_targets == 1 && seen_digest == 1 && seen_group_generation == 1)) ||
    diag_die "groups target derivation omitted required evidence"
  if [[ "$INDIVIDUAL_TARGET_POLICY" == quick-skip ]]; then
    [[ -z "$INDIVIDUAL_TARGET_CPUS" && "$MODE" == quick ]] ||
      diag_die "groups target derivation produced an inconsistent skip policy"
    return 1
  fi
  individual_cpulist_is_canonical "$INDIVIDUAL_TARGET_CPUS" ||
    diag_die "groups target derivation produced an invalid CPU list"
  if [[ "$RUN_SCHEMA_VERSION" == 2 && ( "$INDIVIDUAL_TARGET_POLICY" != all-usable-cpus ||
    "$INDIVIDUAL_TARGET_CPUS" != "$ONLINE_CPUS" ) ]]; then
    diag_die "schema 2 individual targets do not exactly cover the usable CPU set ($ONLINE_CPUS)"
  fi
  return 0
}

phase_individual_v6() {
  local tsv="$OUT_DIR/results/individual.tsv"
  local meta="$OUT_DIR/results/individual.meta"
  local plan="$OUT_DIR/results/individual.plan.tsv"
  local boundaries="$OUT_DIR/results/individual.boundaries.ndjson"
  local attempt_state="$STATE_DIR/individual-attempts"
  local protocol_log="$OUT_DIR/logs/individual/protocol.log"
  local no_turbo_path=/sys/devices/system/cpu/intel_pstate/no_turbo
  local expected_plan_sha expected_plan_bytes expected_plan_rows
  local expected_generation expected_rows_sha expected_rows_bytes expected_row_count
  local expected_boundaries_sha expected_boundaries_bytes expected_boundary_rows
  local progress committed complete total output result stage staged_tsv staged_boundaries
  local recovered_committed previous_committed retry_delay
  local protocol_rc=0 telemetry_segment="" telemetry_started=0
  local executor_crashes=0 executor_crash_streak=0

  [[ "$RUN_SCHEMA_VERSION" == 2 && "$INDIVIDUAL_TARGET_POLICY" == all-usable-cpus &&
    "$INDIVIDUAL_TARGET_CPUS" == "$ONLINE_CPUS" ]] ||
    diag_die "schema-2 isolated protocol requires the exact usable CPU set"
  mkdir -p "$OUT_DIR/logs/individual"

  if [[ -e "$meta" || -L "$meta" ]]; then
    individual_meta_read "$meta" ||
      diag_die "existing schema-2 individual metadata is invalid; preserve it and use --redo individual"
    [[ "$INDIVIDUAL_META_VERSION" == 6 && "$INDIVIDUAL_META_SKIPPED" == 0 &&
      "$INDIVIDUAL_META_TARGET_CPUS" == "$INDIVIDUAL_TARGET_CPUS" &&
      "$INDIVIDUAL_META_RUNS" == "$INDIVIDUAL_RUNS" &&
      "$INDIVIDUAL_META_TARGET_POLICY" == all-usable-cpus &&
      "$INDIVIDUAL_META_GROUP_PLAN_DIGEST" == "$INDIVIDUAL_GROUP_PLAN_DIGEST" &&
      "$INDIVIDUAL_META_GROUP_GENERATION" == "$INDIVIDUAL_GROUP_GENERATION" &&
      "$INDIVIDUAL_META_PROTOCOL" == isolated-outcomes-v2 &&
      "$INDIVIDUAL_META_SCHEDULE_SEED" == "$PROTOCOL_SEED" &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 ]] ||
      diag_die "existing schema-2 individual metadata does not match this resumable protocol"
    expected_generation="$INDIVIDUAL_META_GENERATION"
    expected_plan_sha="$INDIVIDUAL_META_PLAN_SHA256"
    expected_plan_bytes="$INDIVIDUAL_META_PLAN_BYTES"
    expected_plan_rows="$INDIVIDUAL_META_PLAN_ROW_COUNT"
    expected_rows_sha="$INDIVIDUAL_META_ROWS_SHA256"
    expected_rows_bytes="$INDIVIDUAL_META_ROWS_BYTES"
    expected_row_count="$INDIVIDUAL_META_ROW_COUNT"
    expected_boundaries_sha="$INDIVIDUAL_META_BOUNDARIES_SHA256"
    expected_boundaries_bytes="$INDIVIDUAL_META_BOUNDARIES_BYTES"
    expected_boundary_rows="$INDIVIDUAL_META_BOUNDARY_ROW_COUNT"
    bundle_owned_real_dir "$attempt_state" && bundle_owned_single_regular "$plan" &&
      bundle_owned_single_regular "$tsv" && bundle_owned_single_regular "$boundaries" ||
      diag_die "schema-2 individual resume artifacts are missing or unsafe"
    individual_v6_binding_read "$plan" "$tsv" "$boundaries" \
      "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" \
      "$([[ "$INDIVIDUAL_META_COMPLETED" == 1 ]] && printf 1 || printf 0)" ||
      diag_die "schema-2 individual artifacts are not an exact plan-bound prefix"
    [[ "$INDIVIDUAL_META_PLAN_SHA256" == "$expected_plan_sha" &&
      "$INDIVIDUAL_META_PLAN_BYTES" == "$expected_plan_bytes" &&
      "$INDIVIDUAL_META_PLAN_ROW_COUNT" == "$expected_plan_rows" ]] ||
      diag_die "schema-2 individual plan does not match its metadata binding"
    INDIVIDUAL_META_GENERATION="$expected_generation"
    if [[ "$INDIVIDUAL_META_COMPLETED" == 1 ]]; then
      [[ "$INDIVIDUAL_META_ROWS_SHA256" == "$expected_rows_sha" &&
        "$INDIVIDUAL_META_ROWS_BYTES" == "$expected_rows_bytes" &&
        "$INDIVIDUAL_META_ROW_COUNT" == "$expected_row_count" &&
        "$INDIVIDUAL_META_BOUNDARIES_SHA256" == "$expected_boundaries_sha" &&
        "$INDIVIDUAL_META_BOUNDARIES_BYTES" == "$expected_boundaries_bytes" &&
        "$INDIVIDUAL_META_BOUNDARY_ROW_COUNT" == "$expected_boundary_rows" ]] ||
        diag_die "completed schema-2 individual artifacts do not match their terminal bindings"
      if [[ -e "$STATE_DIR/individual-finalize" ||
        -L "$STATE_DIR/individual-finalize" ]]; then
        protocol_finalize_stage_prepare "$STATE_DIR/individual-finalize" \
          individual.tsv individual.boundaries.ndjson &&
          protocol_finalize_stage_close "$STATE_DIR/individual-finalize" ||
          diag_die "completed isolated evidence has an unsafe stranded finalization stage"
      fi
      telemetry_resumable_prepare_descriptive individual individual-session-
      if ((TELEMETRY_RESUME_AVAILABLE == 1)) &&
        [[ ! -e "$OUT_DIR/results/telemetry-individual.tsv" &&
        ! -L "$OUT_DIR/results/telemetry-individual.tsv" &&
        ! -e "$OUT_DIR/results/telemetry-individual.meta" &&
        ! -L "$OUT_DIR/results/telemetry-individual.meta" &&
        "$TELEMETRY_RESUME_SEGMENTS_JSON" != "[]" ]]; then
        telemetry_phase_publish individual "$TELEMETRY_RESUME_SEGMENTS_JSON"
      fi
      node "$LIB/individual-evidence.mjs" v6-validate-complete "$OUT_DIR" > /dev/null ||
        diag_die "completed isolated evidence is not publication-ready before its marker"
      mark_done individual
      individual_evidence_read && [[ "$INDIVIDUAL_EVIDENCE_STATUS" == complete ]] ||
        diag_die "completed schema-2 individual evidence failed post-marker validation"
      return 0
    fi
  else
    [[ ! -e "$plan" && ! -L "$plan" && ! -e "$tsv" && ! -L "$tsv" &&
      ! -e "$boundaries" && ! -L "$boundaries" &&
      ! -e "$attempt_state" && ! -L "$attempt_state" ]] ||
      diag_die "existing schema-2 individual artifacts lack resumable metadata; preserve them and use --redo individual"
    bundle_prepare_dir state/individual-attempts ||
      diag_die "cannot create a safe isolated protocol state directory"
    bundle_create_empty_exclusive "$tsv" 0600 &&
      bundle_create_empty_exclusive "$boundaries" 0600 ||
      diag_die "cannot create isolated result sidecars exclusively"
    printf 'ordinal\tround\tposition\tcpu\toutcome\texit_code\tsignal\telapsed_sec\tstderr_sha256\tstderr_bytes\n' \
      > "$tsv" || diag_die "cannot initialize the V6 isolated results header"
    sync -f "$tsv" || diag_die "cannot synchronize the V6 isolated results header"
    diag_log_cmd node diagnose-lib/pinned-protocol.mjs plan-isolated \
      --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
      --seed "$PROTOCOL_SEED" --plan-output "$plan"
    node "$LIB/pinned-protocol.mjs" plan-isolated \
      --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
      --seed "$PROTOCOL_SEED" --plan-output "$plan" > /dev/null ||
      diag_die "cannot publish the immutable isolated protocol plan"
    individual_meta_reset_generation
    INDIVIDUAL_META_GENERATION="$("$DIAG_INDIVIDUAL_NODE_BIN" -e \
      'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" ||
      diag_die "cannot generate isolated evidence generation"
    INDIVIDUAL_META_PROTOCOL=isolated-outcomes-v2
    INDIVIDUAL_META_SCHEDULE_SEED="$PROTOCOL_SEED"
    INDIVIDUAL_META_SCHEDULE_ALGORITHM=balanced-cyclic-v1
    individual_v6_binding_read "$plan" "$tsv" "$boundaries" \
      "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 ||
      diag_die "cannot validate the fresh isolated protocol plan"
    individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 0 ""
  fi

  total=$(( $(diag_cpulist_count "$INDIVIDUAL_TARGET_CPUS") * INDIVIDUAL_RUNS ))
  progress="$(node "$LIB/pinned-protocol.mjs" next-isolated-v2 \
    --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
    --seed "$PROTOCOL_SEED" --generation "$INDIVIDUAL_META_GENERATION" \
    --state-dir "$attempt_state")" ||
    diag_die "isolated resume state is not an exact contiguous plan prefix"
  isolated_protocol_progress_parse "$progress" "$total" 0 ||
    diag_die "isolated executor returned malformed or inconsistent progress"
  committed="$ISOLATED_PROGRESS_COMMITTED"
  complete="$ISOLATED_PROGRESS_COMPLETE"
  if ((committed > 0)) && [[ "$complete" == false ]]; then
    diag_log "isolated protocol: resuming from durable observation $committed/$total"
  fi
  telemetry_resumable_prepare_descriptive individual individual-session-
  if [[ "$complete" == false && "$TELEMETRY_RESUME_AVAILABLE" == 1 ]]; then
    telemetry_segment="$TELEMETRY_RESUME_NEXT_SEGMENT"
    telemetry_sampler_start individual "individual-session-$telemetry_segment" \
      "$telemetry_segment" ||
      diag_die "isolated telemetry failed before workload launch"
    telemetry_boundary_start ||
      diag_die "isolated telemetry boundary failed before workload launch"
    telemetry_started=1
  fi
  output="$(mktemp /tmp/.diagnose-isolated.XXXXXX)" ||
    diag_die "cannot prepare isolated executor output"
  while [[ "$complete" == false ]]; do
    protocol_rc=0
    run_pinned_protocol_logged "$output" "$protocol_log" \
      "$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/pinned-protocol.mjs" attempt-isolated-v2 \
      --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
      --seed "$PROTOCOL_SEED" --generation "$INDIVIDUAL_META_GENERATION" \
      --state-dir "$attempt_state" --command "$DIAG_INDIVIDUAL_NODE_BIN" \
      --arg "$SCRIPT_DIR/child.mjs" --cwd "$SCRIPT_DIR" \
      --no-turbo-path "$no_turbo_path" || protocol_rc=$?
    result="$(<"$output")"
    if [[ "$protocol_rc" != 0 ]] &&
      isolated_executor_status_is_retryable_crash "$protocol_rc"; then
      executor_crashes=$((executor_crashes + 1))
      executor_crash_streak=$((executor_crash_streak + 1))
      previous_committed="$committed"
      progress="$(node "$LIB/pinned-protocol.mjs" next-isolated-v2 \
        --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
        --seed "$PROTOCOL_SEED" --generation "$INDIVIDUAL_META_GENERATION" \
        --state-dir "$attempt_state")" ||
        diag_die "isolated executor crashed and its durable frontier could not be validated"
      isolated_protocol_progress_parse "$progress" "$total" "$committed" ||
        diag_die "isolated executor crashed and its durable frontier regressed or became inconsistent"
      recovered_committed="$ISOLATED_PROGRESS_COMMITTED"
      complete="$ISOLATED_PROGRESS_COMPLETE"
      if ((recovered_committed > previous_committed)); then
        executor_crash_streak=0
        diag_warn "isolated executor crashed after durably committing observation $recovered_committed/$total (rc=$protocol_rc); continuing from that commit"
      else
        retry_delay="$executor_crash_streak"
        ((retry_delay <= 5)) || retry_delay=5
        diag_warn "isolated executor crashed before its next commit (rc=$protocol_rc); durable frontier remains $recovered_committed/$total, restarting in ${retry_delay}s (crash $executor_crashes)"
        sleep "$retry_delay"
      fi
      committed="$recovered_committed"
      continue
    fi
    [[ "$protocol_rc" == 0 && "$result" =~ \"committed\":true ]] ||
      diag_die "isolated attempt was operational-invalid (executor rc=$protocol_rc); phase remains resumable and the executor summary is $output"
    executor_crash_streak=0
    committed=$((committed + 1))
    ((committed <= total)) || diag_die "isolated executor committed beyond its immutable plan"
    if ((committed == total || committed % 25 == 0)); then
      diag_log "isolated protocol: committed $committed/$total observations"
    fi
    ((committed < total)) || complete=true
  done
  rm -f -- "$output"
  if ((telemetry_started == 1)); then
    telemetry_segment_stop ||
      diag_die "isolated telemetry writer could not be confirmed stopped"
    telemetry_resumable_append_active individual-session- "$telemetry_segment" ||
      diag_die "cannot append the completed isolated telemetry session"
  fi

  stage="$STATE_DIR/individual-finalize"
  protocol_finalize_stage_prepare "$stage" \
    individual.tsv individual.boundaries.ndjson ||
    diag_die "cannot prepare isolated finalization staging directory"
  staged_tsv="$stage/individual.tsv"
  staged_boundaries="$stage/individual.boundaries.ndjson"
  node "$LIB/pinned-protocol.mjs" finalize-isolated-v2 \
    --cpus "$INDIVIDUAL_TARGET_CPUS" --rounds "$INDIVIDUAL_RUNS" \
    --seed "$PROTOCOL_SEED" --generation "$INDIVIDUAL_META_GENERATION" \
    --state-dir "$attempt_state" --results-output "$staged_tsv" \
    --boundaries-output "$staged_boundaries" > /dev/null ||
    diag_die "isolated state is not complete enough to finalize"
  individual_v6_binding_read "$plan" "$staged_tsv" "$staged_boundaries" \
    "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 1 ||
    diag_die "isolated finalization did not reproduce the exact immutable plan"
  bundle_owned_single_regular "$tsv" && bundle_owned_single_regular "$boundaries" ||
    diag_die "isolated result destinations became unsafe before publication"
  mv -T -- "$staged_tsv" "$tsv" && mv -T -- "$staged_boundaries" "$boundaries" ||
    diag_die "cannot publish finalized isolated evidence"
  protocol_finalize_stage_close "$stage" ||
    diag_die "cannot close isolated finalization staging directory"
  sync -f "$tsv" && sync -f "$boundaries" && sync -f "$OUT_DIR/results" ||
    diag_die "cannot synchronize finalized isolated evidence"
  individual_v6_binding_read "$plan" "$tsv" "$boundaries" \
    "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 1 ||
    diag_die "published isolated evidence failed its terminal binding"
  INDIVIDUAL_META_PROTOCOL=isolated-outcomes-v2
  INDIVIDUAL_META_SCHEDULE_SEED="$PROTOCOL_SEED"
  INDIVIDUAL_META_SCHEDULE_ALGORITHM=balanced-cyclic-v1
  individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 1 ""
  if [[ "$TELEMETRY_RESUME_AVAILABLE" == 1 &&
    "$TELEMETRY_RESUME_SEGMENTS_JSON" != "[]" ]]; then
    telemetry_phase_publish individual "$TELEMETRY_RESUME_SEGMENTS_JSON"
  elif [[ "$TELEMETRY_RESUME_AVAILABLE" == 1 ]]; then
    TELEMETRY_DEGRADED=1
    diag_warn "isolated telemetry has no complete session envelope; workload evidence is retained"
  fi
  node "$LIB/individual-evidence.mjs" v6-validate-complete "$OUT_DIR" > /dev/null ||
    diag_die "isolated evidence is not publication-ready before its marker"
  mark_done individual
  individual_evidence_read && [[ "$INDIVIDUAL_EVIDENCE_STATUS" == complete ]] ||
    diag_die "completed isolated evidence failed post-marker validation"
}

phase_individual() {
  local tsv="$OUT_DIR/results/individual.tsv"
  local meta="$OUT_DIR/results/individual.meta"
  if [[ -e "$tsv" || -L "$tsv" ]]; then
    individual_rows_are_valid "$tsv" "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 ||
      diag_die "existing individual.tsv is not a valid resumable prefix; preserve it and use --redo individual"
  else
    : > "$tsv"
  fi
  if [[ -e "$meta" || -L "$meta" ]]; then
    # Resume authority requires the current strict envelope: legacy V2/V3
    # metadata is not bound to this groups generation and fails closed.
    individual_meta_read "$meta" &&
      [[ "$INDIVIDUAL_META_VERSION" == 4 &&
        "$INDIVIDUAL_META_SKIPPED" == 0 &&
        "$INDIVIDUAL_META_TARGET_CPUS" == "$INDIVIDUAL_TARGET_CPUS" &&
        "$INDIVIDUAL_META_RUNS" == "$INDIVIDUAL_RUNS" &&
        "$INDIVIDUAL_META_TARGET_POLICY" == "$INDIVIDUAL_TARGET_POLICY" &&
        "$INDIVIDUAL_META_GROUP_PLAN_DIGEST" == "$INDIVIDUAL_GROUP_PLAN_DIGEST" &&
        "$INDIVIDUAL_META_GROUP_GENERATION" == "$INDIVIDUAL_GROUP_GENERATION" ]] ||
      diag_die "existing individual.meta does not match this resumable phase; preserve it and use --redo individual"
  else
    # A completed-phase check earlier in this shell may have populated these
    # globals from evidence that --redo subsequently archived. Only an extant,
    # successfully read resumable V4 metadata file may preserve its generation.
    individual_meta_reset_generation
  fi
  individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 0 ""
  mkdir -p "$OUT_DIR/logs/individual"
  local -a cpus=()
  mapfile -t cpus < <(cpu_list_sorted "$INDIVIDUAL_TARGET_CPUS")
  local total=${#cpus[@]} idx=0 cpu existing deficit wrapper_rc
  for cpu in "${cpus[@]}"; do
    idx=$((idx + 1))
    # Intra-phase resume: skip CPUs already fully recorded; top up CPUs
    # with partial records by running only the deficit.
    existing="$(individual_cpu_row_count \
      "$tsv" "$cpu" "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS")" ||
      diag_die "individual results changed or became invalid while resuming; preserve them and use --redo individual"
    if ((existing >= INDIVIDUAL_RUNS)); then
      diag_log "cpu $cpu [$idx/$total]: already recorded ($existing runs), skipping"
      continue
    fi
    deficit=$((INDIVIDUAL_RUNS - existing))
    if ((existing > 0)); then
      diag_log "cpu $cpu [$idx/$total]: topping up $existing -> $INDIVIDUAL_RUNS runs"
    else
      diag_log "cpu $cpu [$idx/$total]: $INDIVIDUAL_RUNS runs"
    fi
    diag_log_cmd bash single.sh "$cpu" "$deficit" "$tsv" "$((existing + 1))"
    wrapper_rc=0
    run_individual_logged "$cpu" "$deficit" "$tsv" "$((existing + 1))" \
      "$OUT_DIR/logs/individual/cpu-${cpu}.log" || wrapper_rc=$?
    individual_rows_are_valid "$tsv" "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 &&
      individual_cpu_batch_matches_wrapper "$tsv" "$cpu" "$existing" "$INDIVIDUAL_RUNS" "$wrapper_rc" \
        "$INDIVIDUAL_TARGET_CPUS" ||
      diag_die "cpu $cpu did not produce $deficit valid clean/SIGSEGV result(s) (wrapper rc=$wrapper_rc); phase remains resumable"
  done
  individual_rows_binding_read "$tsv" "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 1 ||
    diag_die "individual results are incomplete or invalid; preserve them and use --redo individual if they cannot be resumed"
  individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 1 ""
  mark_done individual
}

individual_cpulist_is_canonical() {
  local list="$1" part lo hi previous=-1 first=1
  local -a parts=()
  [[ -n "$list" ]] || return 1
  IFS=',' read -ra parts <<< "$list"
  for part in "${parts[@]}"; do
    if [[ "$part" =~ ^(0|[1-9][0-9]*)-([1-9][0-9]*)$ ]]; then
      lo="${BASH_REMATCH[1]}"; hi="${BASH_REMATCH[2]}"
      ((lo < hi)) || return 1
    elif [[ "$part" =~ ^(0|[1-9][0-9]*)$ ]]; then
      lo="${BASH_REMATCH[1]}"; hi="$lo"
    else
      return 1
    fi
    ((hi <= 65535)) || return 1
    if ((first == 0)); then ((lo > previous + 1)) || return 1; fi
    first=0
    previous="$hi"
  done
}

# Validate the entire file before using any row for resume or completion.
# Each target CPU must contain the exact ordered prefix 1..N, never more than
# the configured total; require_complete=1 additionally requires N=total.
individual_rows_are_valid() {
  local tsv="$1" targets="$2" expected_total="$3" require_complete="$4"
  diag_is_safe_positive_uint "$expected_total" && [[ "$require_complete" =~ ^[01]$ ]] || return 1
  individual_cpulist_is_canonical "$targets" || return 1
  [[ -n "$DIAG_INDIVIDUAL_NODE_BIN" ]] || return 1
  "$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" rows \
    "$tsv" "$targets" "$expected_total" "$require_complete"
}

individual_cpu_row_count() {
  local tsv="$1" cpu="$2" targets="${3:-$2}" expected_total="${4:-9007199254740991}"
  [[ -n "$DIAG_INDIVIDUAL_NODE_BIN" ]] || return 1
  "$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" count \
    "$tsv" "$targets" "$expected_total" "$cpu"
}

individual_cpu_batch_matches_wrapper() {
  local tsv="$1" cpu="$2" before="$3" expected_total="$4" wrapper_rc="$5" targets="${6:-$2}"
  [[ "$wrapper_rc" == "0" || "$wrapper_rc" == "1" ]] || return 1
  [[ -n "$DIAG_INDIVIDUAL_NODE_BIN" ]] || return 1
  "$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" batch \
    "$tsv" "$targets" "$expected_total" "$cpu" "$before" "$wrapper_rc"
}

INDIVIDUAL_META_VERSION=""
INDIVIDUAL_META_TARGET_CPUS=""
INDIVIDUAL_META_RUNS=""
INDIVIDUAL_META_SKIPPED=""
INDIVIDUAL_META_COMPLETED=""
INDIVIDUAL_META_SKIP_REASON=""
INDIVIDUAL_META_TARGET_POLICY=""
INDIVIDUAL_META_GROUP_PLAN_DIGEST=""
INDIVIDUAL_META_GROUP_GENERATION=""
INDIVIDUAL_META_GENERATION=""
INDIVIDUAL_META_ROWS_SHA256=""
INDIVIDUAL_META_ROWS_BYTES=""
INDIVIDUAL_META_ROW_COUNT=""
INDIVIDUAL_META_PROTOCOL=""
INDIVIDUAL_META_SCHEDULE_SEED=""
INDIVIDUAL_META_SCHEDULE_ALGORITHM=""
INDIVIDUAL_META_PLAN_SHA256=""
INDIVIDUAL_META_PLAN_BYTES=""
INDIVIDUAL_META_PLAN_ROW_COUNT=""
INDIVIDUAL_META_BOUNDARIES_SHA256=""
INDIVIDUAL_META_BOUNDARIES_BYTES=""
INDIVIDUAL_META_BOUNDARY_ROW_COUNT=""

individual_meta_reset_generation() {
  INDIVIDUAL_META_GENERATION=""
  INDIVIDUAL_META_ROWS_SHA256=""
  INDIVIDUAL_META_ROWS_BYTES=""
  INDIVIDUAL_META_ROW_COUNT=""
  INDIVIDUAL_META_PROTOCOL=""
  INDIVIDUAL_META_SCHEDULE_SEED=""
  INDIVIDUAL_META_SCHEDULE_ALGORITHM=""
  INDIVIDUAL_META_PLAN_SHA256=""
  INDIVIDUAL_META_PLAN_BYTES=""
  INDIVIDUAL_META_PLAN_ROW_COUNT=""
  INDIVIDUAL_META_BOUNDARIES_SHA256=""
  INDIVIDUAL_META_BOUNDARIES_BYTES=""
  INDIVIDUAL_META_BOUNDARY_ROW_COUNT=""
}

individual_meta_read() {
  local file="$1" output line key value
  local -A seen=()
  INDIVIDUAL_META_VERSION=""
  INDIVIDUAL_META_TARGET_CPUS=""
  INDIVIDUAL_META_RUNS=""
  INDIVIDUAL_META_SKIPPED=""
  INDIVIDUAL_META_COMPLETED=""
  INDIVIDUAL_META_SKIP_REASON=""
  INDIVIDUAL_META_TARGET_POLICY=""
  INDIVIDUAL_META_GROUP_PLAN_DIGEST=""
  INDIVIDUAL_META_GROUP_GENERATION=""
  INDIVIDUAL_META_GENERATION=""
  INDIVIDUAL_META_ROWS_SHA256=""
  INDIVIDUAL_META_ROWS_BYTES=""
  INDIVIDUAL_META_ROW_COUNT=""
  INDIVIDUAL_META_PROTOCOL=""
  INDIVIDUAL_META_SCHEDULE_SEED=""
  INDIVIDUAL_META_SCHEDULE_ALGORITHM=""
  INDIVIDUAL_META_PLAN_SHA256=""
  INDIVIDUAL_META_PLAN_BYTES=""
  INDIVIDUAL_META_PLAN_ROW_COUNT=""
  INDIVIDUAL_META_BOUNDARIES_SHA256=""
  INDIVIDUAL_META_BOUNDARIES_BYTES=""
  INDIVIDUAL_META_BOUNDARY_ROW_COUNT=""
  [[ -n "$DIAG_INDIVIDUAL_NODE_BIN" ]] || return 1
  output="$("$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" meta "$file")" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      VERSION) INDIVIDUAL_META_VERSION="$value" ;;
      TARGET_CPUS) INDIVIDUAL_META_TARGET_CPUS="$value" ;;
      RUNS_PER_CPU) INDIVIDUAL_META_RUNS="$value" ;;
      SKIPPED) INDIVIDUAL_META_SKIPPED="$value" ;;
      COMPLETED) INDIVIDUAL_META_COMPLETED="$value" ;;
      SKIP_REASON) INDIVIDUAL_META_SKIP_REASON="$value" ;;
      TARGET_POLICY) INDIVIDUAL_META_TARGET_POLICY="$value" ;;
      GROUP_PLAN_DIGEST) INDIVIDUAL_META_GROUP_PLAN_DIGEST="$value" ;;
      GROUP_GENERATION) INDIVIDUAL_META_GROUP_GENERATION="$value" ;;
      GENERATION) INDIVIDUAL_META_GENERATION="$value" ;;
      ROWS_SHA256) INDIVIDUAL_META_ROWS_SHA256="$value" ;;
      ROWS_BYTES) INDIVIDUAL_META_ROWS_BYTES="$value" ;;
      ROW_COUNT) INDIVIDUAL_META_ROW_COUNT="$value" ;;
      PROTOCOL) INDIVIDUAL_META_PROTOCOL="$value" ;;
      SCHEDULE_SEED) INDIVIDUAL_META_SCHEDULE_SEED="$value" ;;
      SCHEDULE_ALGORITHM) INDIVIDUAL_META_SCHEDULE_ALGORITHM="$value" ;;
      PLAN_SHA256) INDIVIDUAL_META_PLAN_SHA256="$value" ;;
      PLAN_BYTES) INDIVIDUAL_META_PLAN_BYTES="$value" ;;
      PLAN_ROW_COUNT) INDIVIDUAL_META_PLAN_ROW_COUNT="$value" ;;
      BOUNDARIES_SHA256) INDIVIDUAL_META_BOUNDARIES_SHA256="$value" ;;
      BOUNDARIES_BYTES) INDIVIDUAL_META_BOUNDARIES_BYTES="$value" ;;
      BOUNDARY_ROW_COUNT) INDIVIDUAL_META_BOUNDARY_ROW_COUNT="$value" ;;
      SKIP_REASON_PRESENT)
        [[ "$value" =~ ^[01]$ ]] || return 1
        [[ "$value" == 0 ]] || INDIVIDUAL_META_SKIP_REASON=present
        ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ ( ${#seen[@]} == 13 || ${#seen[@]} == 22 ) &&
    -n "${seen[VERSION]:-}" && -n "${seen[TARGET_CPUS]:-}" &&
    -n "${seen[RUNS_PER_CPU]:-}" && -n "${seen[SKIPPED]:-}" &&
    -n "${seen[COMPLETED]:-}" && -n "${seen[SKIP_REASON_PRESENT]:-}" ]] || return 1
  if [[ "$INDIVIDUAL_META_VERSION" == 5 || "$INDIVIDUAL_META_VERSION" == 6 ]]; then
    [[ ${#seen[@]} == 22 && -n "${seen[PROTOCOL]:-}" &&
      -n "${seen[SCHEDULE_SEED]:-}" && -n "${seen[SCHEDULE_ALGORITHM]:-}" &&
      -n "${seen[PLAN_SHA256]:-}" && -n "${seen[PLAN_BYTES]:-}" &&
      -n "${seen[PLAN_ROW_COUNT]:-}" ]] || return 1
  else
    [[ ${#seen[@]} == 13 ]] || return 1
  fi
}

individual_meta_write() {
  local targets="$1" runs="$2" skipped="$3" completed="$4" reason="${5:-}" tmp
  [[ "$INDIVIDUAL_TARGET_POLICY" == failed-groups ||
    "$INDIVIDUAL_TARGET_POLICY" == all-group-cpus ||
    "$INDIVIDUAL_TARGET_POLICY" == all-usable-cpus ||
    "$INDIVIDUAL_TARGET_POLICY" == quick-skip ]] ||
    diag_die "cannot publish individual metadata without a valid target policy"
  [[ "$INDIVIDUAL_GROUP_PLAN_DIGEST" =~ ^[a-f0-9]{64}$ ]] ||
    diag_die "cannot publish individual metadata without a valid group plan digest"
  [[ "$INDIVIDUAL_GROUP_GENERATION" =~ ^[a-f0-9]{32}$ ]] ||
    diag_die "cannot publish individual metadata without a valid groups generation"
  if [[ -z "$INDIVIDUAL_META_GENERATION" ]]; then
    INDIVIDUAL_META_GENERATION="$("$DIAG_INDIVIDUAL_NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" ||
      diag_die "cannot generate individual evidence generation"
  fi
  [[ "$INDIVIDUAL_META_GENERATION" =~ ^[a-f0-9]{32}$ ]] ||
    diag_die "cannot publish individual metadata with an invalid generation"
  if [[ "$completed" == 1 ]]; then
    [[ "$INDIVIDUAL_META_ROWS_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
      { [[ "$INDIVIDUAL_META_ROWS_BYTES" == 0 ]] || diag_is_safe_positive_uint "$INDIVIDUAL_META_ROWS_BYTES"; } &&
      { [[ "$INDIVIDUAL_META_ROW_COUNT" == 0 ]] || diag_is_safe_positive_uint "$INDIVIDUAL_META_ROW_COUNT"; } ||
      diag_die "cannot publish completed individual metadata without a valid row binding"
  fi
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    [[ "$skipped" == 0 && "$INDIVIDUAL_TARGET_POLICY" == all-usable-cpus &&
      "$INDIVIDUAL_META_PROTOCOL" == isolated-outcomes-v2 &&
      "$INDIVIDUAL_META_SCHEDULE_SEED" == "$PROTOCOL_SEED" &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 &&
      "$INDIVIDUAL_META_PLAN_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_PLAN_BYTES" &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_PLAN_ROW_COUNT" ||
      diag_die "cannot publish schema-2 individual metadata without a valid immutable plan binding"
    if [[ "$completed" == 1 ]]; then
      [[ "$INDIVIDUAL_META_BOUNDARIES_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
        diag_is_safe_positive_uint "$INDIVIDUAL_META_BOUNDARIES_BYTES" &&
        diag_is_safe_positive_uint "$INDIVIDUAL_META_BOUNDARY_ROW_COUNT" ||
        diag_die "cannot publish completed schema-2 individual metadata without a valid boundary binding"
    fi
  fi
  tmp="$(mktemp "$OUT_DIR/results/.individual.meta.XXXXXX")" || diag_die "cannot create individual metadata"
  {
    printf 'VERSION=%s\nGENERATION=%s\nTARGET_CPUS=%s\nRUNS_PER_CPU=%s\n' \
      "$([[ "$RUN_SCHEMA_VERSION" == 2 ]] && printf 6 || printf 4)" \
      "$INDIVIDUAL_META_GENERATION" "$targets" "$runs"
    printf 'TARGET_POLICY=%s\nGROUP_PLAN_DIGEST=%s\nGROUP_GENERATION=%s\n' \
      "$INDIVIDUAL_TARGET_POLICY" "$INDIVIDUAL_GROUP_PLAN_DIGEST" "$INDIVIDUAL_GROUP_GENERATION"
    if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
      printf 'PROTOCOL=%s\nSCHEDULE_SEED=%s\nSCHEDULE_ALGORITHM=%s\n' \
        "$INDIVIDUAL_META_PROTOCOL" "$INDIVIDUAL_META_SCHEDULE_SEED" \
        "$INDIVIDUAL_META_SCHEDULE_ALGORITHM"
      printf 'PLAN_SHA256=%s\nPLAN_BYTES=%s\nPLAN_ROW_COUNT=%s\n' \
        "$INDIVIDUAL_META_PLAN_SHA256" "$INDIVIDUAL_META_PLAN_BYTES" \
        "$INDIVIDUAL_META_PLAN_ROW_COUNT"
    fi
    printf 'SKIPPED=%s\nCOMPLETED=%s\n' "$skipped" "$completed"
    [[ -z "$reason" ]] || printf 'SKIP_REASON=%s\n' "$reason"
    if [[ "$completed" == 1 ]]; then
      printf 'ROWS_SHA256=%s\nROWS_BYTES=%s\nROW_COUNT=%s\n' \
        "$INDIVIDUAL_META_ROWS_SHA256" "$INDIVIDUAL_META_ROWS_BYTES" \
        "$INDIVIDUAL_META_ROW_COUNT"
      if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
        printf 'BOUNDARIES_SHA256=%s\nBOUNDARIES_BYTES=%s\nBOUNDARY_ROW_COUNT=%s\n' \
          "$INDIVIDUAL_META_BOUNDARIES_SHA256" "$INDIVIDUAL_META_BOUNDARIES_BYTES" \
          "$INDIVIDUAL_META_BOUNDARY_ROW_COUNT"
      fi
    fi
  } > "$tmp" || diag_die "cannot write individual metadata"
  chmod 0600 "$tmp" || diag_die "cannot protect individual metadata"
  sync -f "$tmp" || diag_die "cannot synchronize individual metadata"
  mv -T -- "$tmp" "$OUT_DIR/results/individual.meta" || diag_die "cannot publish individual metadata"
  sync -f "$OUT_DIR/results" || diag_die "cannot synchronize individual metadata directory"
}

individual_rows_binding_read() {
  local tsv="$1" targets="$2" runs="$3" require_complete="$4" output line key value
  local -A seen=()
  output="$("$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" binding \
    "$tsv" "$targets" "$runs" "$require_complete")" || return 1
  INDIVIDUAL_META_ROWS_SHA256=""
  INDIVIDUAL_META_ROWS_BYTES=""
  INDIVIDUAL_META_ROW_COUNT=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      ROWS_SHA256) INDIVIDUAL_META_ROWS_SHA256="$value" ;;
      ROWS_BYTES) INDIVIDUAL_META_ROWS_BYTES="$value" ;;
      ROW_COUNT) INDIVIDUAL_META_ROW_COUNT="$value" ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ ${#seen[@]} == 3 && "$INDIVIDUAL_META_ROWS_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
    { [[ "$INDIVIDUAL_META_ROWS_BYTES" == 0 ]] || diag_is_safe_positive_uint "$INDIVIDUAL_META_ROWS_BYTES"; } &&
    { [[ "$INDIVIDUAL_META_ROW_COUNT" == 0 ]] || diag_is_safe_positive_uint "$INDIVIDUAL_META_ROW_COUNT"; }
}

individual_v6_binding_read() {
  local plan="$1" tsv="$2" boundaries="$3" targets="$4" runs="$5" require_complete="$6"
  local output line key value expected_fields=6
  local -A seen=()
  [[ "$require_complete" =~ ^[01]$ ]] || return 1
  output="$("$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" v6-binding \
    "$plan" "$tsv" "$boundaries" "$targets" "$runs" "$PROTOCOL_SEED" \
    "$require_complete")" || return 1
  INDIVIDUAL_META_PLAN_SHA256=""
  INDIVIDUAL_META_PLAN_BYTES=""
  INDIVIDUAL_META_PLAN_ROW_COUNT=""
  INDIVIDUAL_META_ROWS_SHA256=""
  INDIVIDUAL_META_ROWS_BYTES=""
  INDIVIDUAL_META_ROW_COUNT=""
  INDIVIDUAL_META_BOUNDARIES_SHA256=""
  INDIVIDUAL_META_BOUNDARIES_BYTES=""
  INDIVIDUAL_META_BOUNDARY_ROW_COUNT=""
  [[ "$require_complete" == 0 ]] || expected_fields=12
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      PLAN_SHA256) INDIVIDUAL_META_PLAN_SHA256="$value" ;;
      PLAN_BYTES) INDIVIDUAL_META_PLAN_BYTES="$value" ;;
      PLAN_ROW_COUNT) INDIVIDUAL_META_PLAN_ROW_COUNT="$value" ;;
      RESULT_PREFIX_ROW_COUNT | BOUNDARY_PREFIX_ROW_COUNT | COMMON_PREFIX_ROW_COUNT)
        [[ "$value" == 0 ]] || diag_is_safe_positive_uint "$value" || return 1
        ;;
      ROWS_SHA256) INDIVIDUAL_META_ROWS_SHA256="$value" ;;
      ROWS_BYTES) INDIVIDUAL_META_ROWS_BYTES="$value" ;;
      ROW_COUNT) INDIVIDUAL_META_ROW_COUNT="$value" ;;
      BOUNDARIES_SHA256) INDIVIDUAL_META_BOUNDARIES_SHA256="$value" ;;
      BOUNDARIES_BYTES) INDIVIDUAL_META_BOUNDARIES_BYTES="$value" ;;
      BOUNDARY_ROW_COUNT) INDIVIDUAL_META_BOUNDARY_ROW_COUNT="$value" ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ ${#seen[@]} -eq "$expected_fields" &&
    "$INDIVIDUAL_META_PLAN_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
    diag_is_safe_positive_uint "$INDIVIDUAL_META_PLAN_BYTES" &&
    diag_is_safe_positive_uint "$INDIVIDUAL_META_PLAN_ROW_COUNT" || return 1
  if [[ "$require_complete" == 1 ]]; then
    [[ "$INDIVIDUAL_META_ROWS_SHA256" =~ ^[a-f0-9]{64}$ &&
      "$INDIVIDUAL_META_BOUNDARIES_SHA256" =~ ^[a-f0-9]{64}$ ]] &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_ROWS_BYTES" &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_ROW_COUNT" &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_BOUNDARIES_BYTES" &&
      diag_is_safe_positive_uint "$INDIVIDUAL_META_BOUNDARY_ROW_COUNT"
  fi
}

individual_empty_rows_binding_read() {
  local tsv="$1" output line key value
  local -A seen=()
  output="$("$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" empty-binding "$tsv")" || return 1
  INDIVIDUAL_META_ROWS_SHA256=""
  INDIVIDUAL_META_ROWS_BYTES=""
  INDIVIDUAL_META_ROW_COUNT=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      ROWS_SHA256) INDIVIDUAL_META_ROWS_SHA256="$value" ;;
      ROWS_BYTES) INDIVIDUAL_META_ROWS_BYTES="$value" ;;
      ROW_COUNT) INDIVIDUAL_META_ROW_COUNT="$value" ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ ${#seen[@]} == 3 && "$INDIVIDUAL_META_ROWS_SHA256" =~ ^[a-f0-9]{64}$ &&
    "$INDIVIDUAL_META_ROWS_BYTES" == 0 && "$INDIVIDUAL_META_ROW_COUNT" == 0 ]]
}

individual_phase_matches_expected_targets() {
  local should_run="$1"
  local expected_version=4
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && expected_version=6
  [[ "$should_run" =~ ^[01]$ ]] || return 1
  individual_evidence_read || return 1
  [[ "$INDIVIDUAL_META_VERSION" == "$expected_version" &&
    "$INDIVIDUAL_META_RUNS" == "$INDIVIDUAL_RUNS" &&
    "$INDIVIDUAL_META_TARGET_POLICY" == "$INDIVIDUAL_TARGET_POLICY" &&
    "$INDIVIDUAL_META_GROUP_PLAN_DIGEST" == "$INDIVIDUAL_GROUP_PLAN_DIGEST" &&
    "$INDIVIDUAL_META_GROUP_GENERATION" == "$INDIVIDUAL_GROUP_GENERATION" ]] || return 1
  if [[ "$expected_version" == 6 ]]; then
    [[ "$INDIVIDUAL_META_PROTOCOL" == isolated-outcomes-v2 &&
      "$INDIVIDUAL_META_SCHEDULE_SEED" == "$PROTOCOL_SEED" &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 ]] || return 1
  fi
  if [[ "$should_run" == 1 ]]; then
    [[ "$INDIVIDUAL_META_SKIPPED" == 0 &&
      "$INDIVIDUAL_META_TARGET_CPUS" == "$INDIVIDUAL_TARGET_CPUS" ]]
  else
    [[ "$INDIVIDUAL_META_SKIPPED" == 1 && -z "$INDIVIDUAL_META_TARGET_CPUS" ]]
  fi
}

INDIVIDUAL_EVIDENCE_STATUS=""
INDIVIDUAL_EVIDENCE_WORST_CPU=""
individual_evidence_read() {
  local output line key value
  local -A seen=()
  output="$("$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/individual-evidence.mjs" bundle "$OUT_DIR")" || return 1
  INDIVIDUAL_EVIDENCE_STATUS=""
  INDIVIDUAL_EVIDENCE_WORST_CPU=""
  INDIVIDUAL_META_SKIP_REASON=""
  INDIVIDUAL_META_GROUP_GENERATION=""
  INDIVIDUAL_META_PROTOCOL=""
  INDIVIDUAL_META_SCHEDULE_SEED=""
  INDIVIDUAL_META_SCHEDULE_ALGORITHM=""
  INDIVIDUAL_META_PLAN_SHA256=""
  INDIVIDUAL_META_PLAN_BYTES=""
  INDIVIDUAL_META_PLAN_ROW_COUNT=""
  INDIVIDUAL_META_BOUNDARIES_SHA256=""
  INDIVIDUAL_META_BOUNDARIES_BYTES=""
  INDIVIDUAL_META_BOUNDARY_ROW_COUNT=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      STATUS) INDIVIDUAL_EVIDENCE_STATUS="$value" ;;
      VERSION) INDIVIDUAL_META_VERSION="$value" ;;
      TARGET_CPUS) INDIVIDUAL_META_TARGET_CPUS="$value" ;;
      RUNS_PER_CPU) INDIVIDUAL_META_RUNS="$value" ;;
      SKIPPED) INDIVIDUAL_META_SKIPPED="$value" ;;
      COMPLETED) INDIVIDUAL_META_COMPLETED="$value" ;;
      TARGET_POLICY) INDIVIDUAL_META_TARGET_POLICY="$value" ;;
      GROUP_PLAN_DIGEST) INDIVIDUAL_META_GROUP_PLAN_DIGEST="$value" ;;
      GROUP_GENERATION) INDIVIDUAL_META_GROUP_GENERATION="$value" ;;
      GENERATION) INDIVIDUAL_META_GENERATION="$value" ;;
      ROWS_SHA256) INDIVIDUAL_META_ROWS_SHA256="$value" ;;
      ROWS_BYTES) INDIVIDUAL_META_ROWS_BYTES="$value" ;;
      ROW_COUNT) INDIVIDUAL_META_ROW_COUNT="$value" ;;
      PROTOCOL) INDIVIDUAL_META_PROTOCOL="$value" ;;
      SCHEDULE_SEED) INDIVIDUAL_META_SCHEDULE_SEED="$value" ;;
      SCHEDULE_ALGORITHM) INDIVIDUAL_META_SCHEDULE_ALGORITHM="$value" ;;
      PLAN_SHA256) INDIVIDUAL_META_PLAN_SHA256="$value" ;;
      PLAN_BYTES) INDIVIDUAL_META_PLAN_BYTES="$value" ;;
      PLAN_ROW_COUNT) INDIVIDUAL_META_PLAN_ROW_COUNT="$value" ;;
      BOUNDARIES_SHA256) INDIVIDUAL_META_BOUNDARIES_SHA256="$value" ;;
      BOUNDARIES_BYTES) INDIVIDUAL_META_BOUNDARIES_BYTES="$value" ;;
      BOUNDARY_ROW_COUNT) INDIVIDUAL_META_BOUNDARY_ROW_COUNT="$value" ;;
      SKIP_REASON_PRESENT)
        [[ "$value" =~ ^[01]$ ]] || return 1
        [[ "$value" == 0 ]] || INDIVIDUAL_META_SKIP_REASON=present
        ;;
      WORST_CPU) INDIVIDUAL_EVIDENCE_WORST_CPU="$value" ;;
      *) return 1 ;;
    esac
  done <<< "$output"
  [[ ( ${#seen[@]} == 15 || ${#seen[@]} == 24 ) &&
    "$INDIVIDUAL_EVIDENCE_STATUS" =~ ^(not-run|incomplete|invalid|skipped|complete)$ ]] || return 1
  if [[ "$INDIVIDUAL_META_VERSION" == 5 ]]; then
    [[ ${#seen[@]} == 24 && "$INDIVIDUAL_META_PROTOCOL" == isolated-interleaved-v1 &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 ]]
  elif [[ "$INDIVIDUAL_META_VERSION" == 6 ]]; then
    [[ ${#seen[@]} == 24 && "$INDIVIDUAL_META_PROTOCOL" == isolated-outcomes-v2 &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 ]]
  else
    [[ ${#seen[@]} == 15 ]]
  fi
}

individual_phase_result_is_complete() {
  local expected_version=4
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && expected_version=6
  individual_evidence_read &&
    [[ "$INDIVIDUAL_META_VERSION" == "$expected_version" && "$INDIVIDUAL_META_COMPLETED" == 1 &&
      ("$INDIVIDUAL_EVIDENCE_STATUS" == complete || "$INDIVIDUAL_EVIDENCE_STATUS" == skipped) ]]
}

individual_phase_is_complete_and_matches_expected() {
  local should_run="$1"
  local expected_version=4
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && expected_version=6
  [[ "$should_run" =~ ^[01]$ ]] || return 1
  individual_evidence_read || return 1
  [[ "$INDIVIDUAL_META_VERSION" == "$expected_version" && "$INDIVIDUAL_META_COMPLETED" == 1 &&
    ("$INDIVIDUAL_EVIDENCE_STATUS" == complete || "$INDIVIDUAL_EVIDENCE_STATUS" == skipped) &&
    "$INDIVIDUAL_META_RUNS" == "$INDIVIDUAL_RUNS" &&
    "$INDIVIDUAL_META_TARGET_POLICY" == "$INDIVIDUAL_TARGET_POLICY" &&
    "$INDIVIDUAL_META_GROUP_PLAN_DIGEST" == "$INDIVIDUAL_GROUP_PLAN_DIGEST" &&
    "$INDIVIDUAL_META_GROUP_GENERATION" == "$INDIVIDUAL_GROUP_GENERATION" ]] || return 1
  if [[ "$expected_version" == 6 ]]; then
    [[ "$INDIVIDUAL_META_PROTOCOL" == isolated-outcomes-v2 &&
      "$INDIVIDUAL_META_SCHEDULE_SEED" == "$PROTOCOL_SEED" &&
      "$INDIVIDUAL_META_SCHEDULE_ALGORITHM" == balanced-cyclic-v1 ]] || return 1
  fi
  if [[ "$should_run" == 1 ]]; then
    [[ "$INDIVIDUAL_EVIDENCE_STATUS" == complete && "$INDIVIDUAL_META_SKIPPED" == 0 &&
      "$INDIVIDUAL_META_TARGET_CPUS" == "$INDIVIDUAL_TARGET_CPUS" ]]
  else
    [[ "$INDIVIDUAL_EVIDENCE_STATUS" == skipped && "$INDIVIDUAL_META_SKIPPED" == 1 &&
      -z "$INDIVIDUAL_META_TARGET_CPUS" ]]
  fi
}

phase_individual_skipped() {
  local tsv="$OUT_DIR/results/individual.tsv" meta="$OUT_DIR/results/individual.meta"
  [[ ! -e "$meta" && ! -L "$meta" ]] ||
    diag_die "existing individual metadata conflicts with a skipped phase; preserve it and use --redo individual"
  # A skipped phase always publishes a new envelope. Do not reuse a generation
  # left in this shell by completed evidence that a redo just archived.
  individual_meta_reset_generation
  if [[ -e "$tsv" || -L "$tsv" ]]; then
    individual_empty_rows_binding_read "$tsv" ||
      diag_die "existing individual results conflict with a skipped phase; preserve them and use --redo individual"
  else
    : > "$tsv"
    individual_empty_rows_binding_read "$tsv" ||
      diag_die "cannot validate empty individual results for a skipped phase"
  fi
  individual_meta_write "" "$INDIVIDUAL_RUNS" 1 1 no-failing-group-in-quick-mode
  mark_done individual
}

pinned_concurrent_plan_matches_topology() {
  local plan="$OUT_DIR/results/pinned-concurrent.plan.tsv"
  local groups="$OUT_DIR/results/pinned-concurrent.groups.tsv"
  local stage staged_plan staged_groups rc=0
  pinned_contexts_prepare || return 1
  stage="$(mktemp -d /tmp/.pinned-plan-check.XXXXXX)" || return 1
  staged_plan="$stage/plan.tsv"
  staged_groups="$stage/groups.tsv"
  node "$LIB/pinned-protocol.mjs" plan-concurrent \
    --contexts-file "$PINNED_CONTEXTS_TEMP" --rounds "$PINNED_CONCURRENT_ROUNDS" \
    --seed "$PROTOCOL_SEED" --plan-output "$staged_plan" \
    --groups-output "$staged_groups" > /dev/null || rc=1
  ((rc != 0)) || cmp -s -- "$staged_plan" "$plan" || rc=1
  ((rc != 0)) || cmp -s -- "$staged_groups" "$groups" || rc=1
  rm -f -- "$staged_plan" "$staged_groups"
  rmdir -- "$stage" || rc=1
  return "$rc"
}

pinned_concurrent_evidence_is_complete() {
  local meta="$OUT_DIR/results/pinned-concurrent.meta" generation
  bundle_owned_single_regular "$meta" || return 1
  generation="$(metadata_exact_value "$meta" GENERATION 2> /dev/null)" || return 1
  [[ "$generation" =~ ^[a-f0-9]{32}$ ]] || return 1
  node "$LIB/pinned-concurrent-evidence.mjs" validate-complete "$OUT_DIR" \
    "$generation" "$INDIVIDUAL_GROUP_GENERATION" "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
    "$PINNED_CONCURRENT_ROUNDS" "$PROTOCOL_SEED" > /dev/null 2>&1 &&
    pinned_concurrent_plan_matches_topology
}

pinned_concurrent_attempt_is_meaningful() {
  phase_attempt_is_meaningful pinned-concurrent
}

pinned_concurrent_workload_attempt_is_meaningful() {
  local relative
  local -a paths=(
    results/pinned-concurrent.tsv results/pinned-concurrent.meta
    results/pinned-concurrent.groups.tsv results/pinned-concurrent.plan.tsv
    results/pinned-concurrent.boundaries.ndjson logs/pinned-concurrent
    state/pinned-concurrent-waves state/pinned-concurrent-finalize
    results/telemetry-pinned-concurrent.tsv
    results/telemetry-pinned-concurrent.meta telemetry/pinned-concurrent
    state/telemetry-pinned-concurrent
  )
  for relative in "${paths[@]}"; do
    bundle_path_is_meaningful "$OUT_DIR/$relative" && return 0
  done
  return 1
}

PINNED_CONCURRENT_UNAVAILABLE_STATE=absent

pinned_concurrent_unavailable_meta_render() {
  [[ "$INDIVIDUAL_GROUP_GENERATION" =~ ^[a-f0-9]{32}$ &&
    "$INDIVIDUAL_GROUP_PLAN_DIGEST" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf 'VERSION=1\n'
  printf 'SOURCE_GROUP_GENERATION=%s\n' "$INDIVIDUAL_GROUP_GENERATION"
  printf 'SOURCE_GROUP_PLAN_DIGEST=%s\n' "$INDIVIDUAL_GROUP_PLAN_DIGEST"
  printf 'REASON=no-safe-topology-context\n'
}

pinned_concurrent_unavailable_decision_present() {
  [[ -n "$OUT_DIR" && -n "$STATE_DIR" ]] || return 1
  local meta="$OUT_DIR/results/pinned-concurrent.unavailable.meta"
  local marker="$STATE_DIR/phase-pinned-concurrent-unavailable.done"
  [[ -e "$meta" || -L "$meta" || -e "$marker" || -L "$marker" ]]
}

pinned_concurrent_unavailable_state_read() {
  local meta="$OUT_DIR/results/pinned-concurrent.unavailable.meta"
  local marker="$STATE_DIR/phase-pinned-concurrent-unavailable.done"
  local size
  PINNED_CONCURRENT_UNAVAILABLE_STATE=absent
  if [[ ! -e "$meta" && ! -L "$meta" && ! -e "$marker" && ! -L "$marker" ]]; then
    return 0
  fi
  PINNED_CONCURRENT_UNAVAILABLE_STATE=invalid
  [[ -e "$meta" || -L "$meta" ]] || return 1
  bundle_owned_single_regular "$meta" || return 1
  size="$(stat -c %s -- "$meta" 2> /dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] && ((size <= 512)) || return 1
  cmp -s -- "$meta" <(pinned_concurrent_unavailable_meta_render) || return 1
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    PINNED_CONCURRENT_UNAVAILABLE_STATE=recoverable
    return 0
  fi
  phase_marker_is_valid pinned-concurrent-unavailable || return 1
  PINNED_CONCURRENT_UNAVAILABLE_STATE=complete
}

pinned_concurrent_unavailable_publish() {
  local meta="$OUT_DIR/results/pinned-concurrent.unavailable.meta"
  local unavailable_fd="" unavailable_fd_path=""
  pinned_concurrent_unavailable_state_read || return 1
  if [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" == complete ]]; then
    return 0
  fi
  if [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" == absent ]]; then
    pinned_concurrent_workload_attempt_is_meaningful && return 1
    bundle_owned_real_dir "$OUT_DIR/results" && bundle_owned_real_dir "$STATE_DIR" || return 1
    bundle_create_empty_exclusive "$meta" 0600 || return 1
    bundle_append_fd_open pinned-concurrent-unavailable "$meta" \
      unavailable_fd unavailable_fd_path 0 || return 1
    if ! pinned_concurrent_unavailable_meta_render >&"$unavailable_fd" ||
      ! sync -f "$unavailable_fd_path" ||
      [[ ! "$meta" -ef "$unavailable_fd_path" ]] ||
      ! bundle_owned_single_regular "$meta"; then
      exec {unavailable_fd}>&- || true
      return 1
    fi
    exec {unavailable_fd}>&- || return 1
    sync -f "$meta" && sync -f "$OUT_DIR/results" || return 1
  elif [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" != recoverable ]]; then
    return 1
  fi
  mark_done pinned-concurrent-unavailable
  pinned_concurrent_unavailable_state_read &&
    [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" == complete ]]
}

pinned_concurrent_should_run() {
  [[ "$RUN_SCHEMA_VERSION" == 2 && "$SKIP_PINNED_CONCURRENT" == 0 &&
    ${#CONCURRENT_NAME[@]} -gt 0 ]] || return 1
  phase_redo_is_authorized pinned-concurrent && return 0
  if [[ -n "$STATE_DIR" ]] && phase_is_done pinned-concurrent; then
    return 1
  fi
  pinned_concurrent_unavailable_decision_present && return 1
  return 0
}

pinned_concurrent_final_stage_prepare() {
  local stage="$1" generation="$2" wave_state="$3"
  local groups="$4" plan="$5" tsv="$6" boundaries="$7" meta="$8"
  local staged_tsv="$stage/pinned-concurrent.tsv"
  local staged_boundaries="$stage/pinned-concurrent.boundaries.ndjson"
  local staged_meta="$stage/pinned-concurrent.meta"
  local staged_incomplete_meta="$stage/pinned-concurrent.incomplete.meta"
  protocol_finalize_stage_prepare "$stage" \
    pinned-concurrent.tsv pinned-concurrent.boundaries.ndjson \
    pinned-concurrent.meta pinned-concurrent.incomplete.meta || return 1
  node "$LIB/pinned-protocol.mjs" finalize-concurrent-v2 \
    --contexts-file "$PINNED_CONTEXTS_TEMP" --rounds "$PINNED_CONCURRENT_ROUNDS" \
    --seed "$PROTOCOL_SEED" --generation "$generation" --state-dir "$wave_state" \
    --results-output "$staged_tsv" --boundaries-output "$staged_boundaries" \
    > /dev/null || return 1
  node "$LIB/pinned-concurrent-evidence.mjs" build-meta \
    --version 2 \
    --generation "$generation" --source-group-generation "$INDIVIDUAL_GROUP_GENERATION" \
    --source-group-plan-digest "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
    --rounds "$PINNED_CONCURRENT_ROUNDS" --seed "$PROTOCOL_SEED" \
    --groups "$groups" --plan "$plan" --results "$staged_tsv" \
    --boundaries "$staged_boundaries" --completed 1 --output "$staged_meta" || return 1
  node "$LIB/pinned-concurrent-evidence.mjs" build-meta \
    --generation "$generation" --source-group-generation "$INDIVIDUAL_GROUP_GENERATION" \
    --source-group-plan-digest "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
    --rounds "$PINNED_CONCURRENT_ROUNDS" --seed "$PROTOCOL_SEED" \
    --groups "$groups" --plan "$plan" --completed 0 \
    --output "$staged_incomplete_meta" || return 1
  bundle_owned_single_regular "$meta" &&
    cmp -s -- "$meta" "$staged_incomplete_meta" || return 1
  pinned_concurrent_v2_destination_is_recoverable "$tsv" "$staged_tsv" || return 1
  protocol_destination_is_recoverable_prefix \
    "$boundaries" "$staged_boundaries" 1 || return 1
  rm -f -- "$staged_incomplete_meta" || return 1
  sync -f "$stage" || return 1
}

pinned_concurrent_final_publish() {
  local stage="$1" staged_tsv="$2" tsv="$3"
  local staged_boundaries="$4" boundaries="$5" staged_meta="$6" meta="$7"
  # The completed metadata is the terminal authority boundary. Make both
  # deterministic sidecars and their directory entries durable before that
  # metadata can become visible; a crash before its rename then remains an
  # exact, recoverable incomplete-meta prefix.
  mv -T -- "$staged_tsv" "$tsv" && mv -T -- "$staged_boundaries" "$boundaries" ||
    return 1
  sync -f "$tsv" && sync -f "$boundaries" && sync -f "$OUT_DIR/results" ||
    return 1
  mv -T -- "$staged_meta" "$meta" || return 1
  sync -f "$meta" && sync -f "$OUT_DIR/results" || return 1
  protocol_finalize_stage_close "$stage"
}

phase_pinned_concurrent() {
  local groups="$OUT_DIR/results/pinned-concurrent.groups.tsv"
  local plan="$OUT_DIR/results/pinned-concurrent.plan.tsv"
  local tsv="$OUT_DIR/results/pinned-concurrent.tsv"
  local boundaries="$OUT_DIR/results/pinned-concurrent.boundaries.ndjson"
  local meta="$OUT_DIR/results/pinned-concurrent.meta"
  local wave_state="$STATE_DIR/pinned-concurrent-waves"
  local protocol_log="$OUT_DIR/logs/pinned-concurrent/protocol.log"
  local generation progress result output controller complete committed_waves
  local progress_attempt progress_rc=1
  local total_waves stage staged_tsv staged_boundaries staged_meta protocol_rc=0
  local terminal_recovery=0 stage_ready=0
  local telemetry_segment="" telemetry_started=0

  pinned_contexts_prepare ||
    diag_die "cannot serialize the discovered pinned-concurrent topology contexts"
  total_waves=$(( ${#CONCURRENT_NAME[@]} * PINNED_CONCURRENT_ROUNDS ))
  ((total_waves > 0)) || diag_die "pinned-concurrent protocol has no topology waves"
  bundle_prepare_dir logs/pinned-concurrent ||
    diag_die "cannot prepare a safe pinned-concurrent log directory"

  if [[ -e "$meta" || -L "$meta" ]]; then
    bundle_owned_single_regular "$meta" ||
      diag_die "pinned-concurrent metadata is unsafe"
    generation="$(metadata_exact_value "$meta" GENERATION 2> /dev/null)" ||
      diag_die "pinned-concurrent metadata has no unique generation"
    [[ "$generation" =~ ^[a-f0-9]{32}$ ]] ||
      diag_die "pinned-concurrent generation is malformed"
    if node "$LIB/pinned-concurrent-evidence.mjs" validate-complete "$OUT_DIR" \
      "$generation" "$INDIVIDUAL_GROUP_GENERATION" "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
      "$PINNED_CONCURRENT_ROUNDS" "$PROTOCOL_SEED" > /dev/null 2>&1; then
      pinned_concurrent_plan_matches_topology ||
        diag_die "completed pinned-concurrent plan disagrees with rediscovered topology"
      if [[ -e "$STATE_DIR/pinned-concurrent-finalize" ||
        -L "$STATE_DIR/pinned-concurrent-finalize" ]]; then
        protocol_finalize_stage_prepare "$STATE_DIR/pinned-concurrent-finalize" \
          pinned-concurrent.tsv pinned-concurrent.boundaries.ndjson \
          pinned-concurrent.meta pinned-concurrent.incomplete.meta &&
          protocol_finalize_stage_close "$STATE_DIR/pinned-concurrent-finalize" ||
          diag_die "completed pinned-concurrent evidence has an unsafe stranded finalization stage"
      fi
      telemetry_resumable_prepare_descriptive pinned-concurrent pinned-concurrent-session-
      if ((TELEMETRY_RESUME_AVAILABLE == 1)) &&
        [[ ! -e "$OUT_DIR/results/telemetry-pinned-concurrent.tsv" &&
        ! -L "$OUT_DIR/results/telemetry-pinned-concurrent.tsv" &&
        ! -e "$OUT_DIR/results/telemetry-pinned-concurrent.meta" &&
        ! -L "$OUT_DIR/results/telemetry-pinned-concurrent.meta" &&
        "$TELEMETRY_RESUME_SEGMENTS_JSON" != "[]" ]]; then
        telemetry_phase_publish pinned-concurrent "$TELEMETRY_RESUME_SEGMENTS_JSON"
      fi
      mark_done pinned-concurrent
      pinned_concurrent_evidence_is_complete ||
        diag_die "completed pinned-concurrent evidence failed post-marker validation"
      return 0
    fi
    bundle_owned_real_dir "$wave_state" && pinned_concurrent_plan_matches_topology ||
      diag_die "pinned-concurrent resume state or immutable plan is unsafe"
    if ! node "$LIB/pinned-concurrent-evidence.mjs" validate-before "$OUT_DIR" \
      "$generation" "$INDIVIDUAL_GROUP_GENERATION" "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
      "$PINNED_CONCURRENT_ROUNDS" "$PROTOCOL_SEED" > /dev/null 2>&1; then
      # A killed terminal publication may already have atomically installed
      # one complete sidecar while the metadata still describes a resumable
      # prefix. Defer that one case until generation-bound state proves the
      # full plan complete and its deterministic projection matches exactly.
      terminal_recovery=1
    fi
  else
    [[ ! -e "$groups" && ! -L "$groups" && ! -e "$plan" && ! -L "$plan" &&
      ! -e "$tsv" && ! -L "$tsv" && ! -e "$boundaries" && ! -L "$boundaries" &&
      ! -e "$wave_state" && ! -L "$wave_state" ]] ||
      diag_die "existing pinned-concurrent artifacts lack resumable metadata; preserve them and use --redo pinned-concurrent"
    bundle_prepare_dir state/pinned-concurrent-waves ||
      diag_die "cannot create a safe pinned-concurrent wave state directory"
    generation="$("$DIAG_INDIVIDUAL_NODE_BIN" -e \
      'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" ||
      diag_die "cannot generate pinned-concurrent evidence generation"
    diag_log_cmd node diagnose-lib/pinned-protocol.mjs plan-concurrent \
      --contexts-file topology-contexts --rounds "$PINNED_CONCURRENT_ROUNDS" \
      --seed "$PROTOCOL_SEED"
    node "$LIB/pinned-protocol.mjs" plan-concurrent \
      --contexts-file "$PINNED_CONTEXTS_TEMP" --rounds "$PINNED_CONCURRENT_ROUNDS" \
      --seed "$PROTOCOL_SEED" --plan-output "$plan" --groups-output "$groups" \
      > /dev/null || diag_die "cannot publish the immutable pinned-concurrent plan"
    bundle_create_empty_exclusive "$tsv" 0600 ||
      diag_die "cannot create pinned-concurrent result prefix exclusively"
    printf 'round\tgroup\tcpu\tlaunch_position\trc\telapsed_ms\n' > "$tsv" ||
      diag_die "cannot initialize pinned-concurrent result prefix"
    sync -f "$tsv" || diag_die "cannot synchronize pinned-concurrent result prefix"
    node "$LIB/pinned-concurrent-evidence.mjs" build-meta \
      --generation "$generation" --source-group-generation "$INDIVIDUAL_GROUP_GENERATION" \
      --source-group-plan-digest "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
      --rounds "$PINNED_CONCURRENT_ROUNDS" --seed "$PROTOCOL_SEED" \
      --groups "$groups" --plan "$plan" --completed 0 --output "$meta" ||
      diag_die "cannot publish pinned-concurrent resumable metadata"
    sync -f "$meta" && sync -f "$OUT_DIR/results" ||
      diag_die "cannot synchronize pinned-concurrent resumable metadata"
    node "$LIB/pinned-concurrent-evidence.mjs" validate-before "$OUT_DIR" \
      "$generation" "$INDIVIDUAL_GROUP_GENERATION" "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
      "$PINNED_CONCURRENT_ROUNDS" "$PROTOCOL_SEED" > /dev/null ||
      diag_die "fresh pinned-concurrent evidence failed its resumable validation"
  fi

  # This is the run's only separate progress-reader process. It is
  # read-only, so retry a transient Node crash without touching durable state;
  # each successful wave response carries the next controller directly and
  # avoids launching another unpinned administrative Node process.
  for progress_attempt in 1 2 3; do
    if progress="$(node "$LIB/pinned-protocol.mjs" next-concurrent-v2 \
      --contexts-file "$PINNED_CONTEXTS_TEMP" --rounds "$PINNED_CONCURRENT_ROUNDS" \
      --seed "$PROTOCOL_SEED" --generation "$generation" --state-dir "$wave_state")"; then
      progress_rc=0
      break
    fi
  done
  ((progress_rc == 0)) ||
    diag_die "pinned-concurrent state/progress reader failed after three read-only attempts"
  [[ "$progress" =~ \"committedWaves\":([0-9]+) ]] ||
    diag_die "pinned-concurrent executor returned malformed progress"
  committed_waves="${BASH_REMATCH[1]}"
  [[ "$progress" =~ \"complete\":(true|false) ]] ||
    diag_die "pinned-concurrent executor omitted its completion state"
  complete="${BASH_REMATCH[1]}"
  ((committed_waves <= total_waves)) ||
    diag_die "pinned-concurrent state exceeds its immutable plan"
  controller=""
  if [[ "$complete" == false ]]; then
    [[ "$progress" =~ \"controllerCpu\":([0-9]+) ]] ||
      diag_die "pinned-concurrent progress omitted its controller CPU"
    controller="${BASH_REMATCH[1]}"
  fi
  if ((terminal_recovery == 1)); then
    [[ "$complete" == true ]] ||
      diag_die "pinned-concurrent evidence is not a valid resumable prefix; preserve it and use --redo pinned-concurrent"
    stage="$STATE_DIR/pinned-concurrent-finalize"
    pinned_concurrent_final_stage_prepare "$stage" "$generation" "$wave_state" \
      "$groups" "$plan" "$tsv" "$boundaries" "$meta" ||
      diag_die "interrupted pinned-concurrent finalization does not match its immutable state; preserve it and use --redo pinned-concurrent"
    stage_ready=1
  fi
  telemetry_resumable_prepare_descriptive pinned-concurrent pinned-concurrent-session-
  if [[ "$complete" == false && "$TELEMETRY_RESUME_AVAILABLE" == 1 ]]; then
    telemetry_segment="$TELEMETRY_RESUME_NEXT_SEGMENT"
    telemetry_sampler_start pinned-concurrent \
      "pinned-concurrent-session-$telemetry_segment" "$telemetry_segment" ||
      diag_die "pinned-concurrent telemetry failed before workload launch"
    telemetry_boundary_start ||
      diag_die "pinned-concurrent telemetry boundary failed before workload launch"
    telemetry_started=1
  fi
  output="$(mktemp /tmp/.diagnose-pinned-concurrent.XXXXXX)" ||
    diag_die "cannot prepare pinned-concurrent executor output"
  while [[ "$complete" == false ]]; do
    diag_cpulist_contains "$ONLINE_CPUS" "$controller" ||
      diag_die "pinned-concurrent controller CPU $controller is not usable"
    protocol_rc=0
    run_pinned_protocol_logged "$output" "$protocol_log" taskset -c "$controller" \
      "$DIAG_INDIVIDUAL_NODE_BIN" "$LIB/pinned-protocol.mjs" wave-concurrent-v2 \
      --contexts-file "$PINNED_CONTEXTS_TEMP" --rounds "$PINNED_CONCURRENT_ROUNDS" \
      --seed "$PROTOCOL_SEED" --generation "$generation" --state-dir "$wave_state" \
      --command "$DIAG_INDIVIDUAL_NODE_BIN" --arg "$SCRIPT_DIR/child.mjs" \
      --cwd "$SCRIPT_DIR" --no-turbo-path /sys/devices/system/cpu/intel_pstate/no_turbo \
      || protocol_rc=$?
    result="$(<"$output")"
    if [[ "$protocol_rc" != 0 || ! "$result" =~ \"committed\":true ]]; then
      local failure_reason=unknown
      if [[ "$result" =~ \"reason\":\"([a-z-]+)\" ]]; then
        failure_reason="${BASH_REMATCH[1]}"
      fi
      diag_die "pinned-concurrent wave did not produce a complete securely launched outcome set (reason=$failure_reason, executor rc=$protocol_rc); phase remains resumable; exact executor detail was appended to $protocol_log"
    fi
    committed_waves=$((committed_waves + 1))
    if ((committed_waves == total_waves || committed_waves % 10 == 0)); then
      diag_log "pinned-concurrent protocol: committed $committed_waves/$total_waves waves"
    fi
    [[ "$result" =~ \"complete\":(true|false) ]] ||
      diag_die "committed pinned-concurrent wave omitted its completion state"
    complete="${BASH_REMATCH[1]}"
    if [[ "$complete" == false ]]; then
      [[ "$result" =~ \"nextControllerCpu\":([0-9]+) ]] ||
        diag_die "committed pinned-concurrent wave omitted its next controller CPU"
      controller="${BASH_REMATCH[1]}"
    fi
  done
  rm -f -- "$output"
  if ((telemetry_started == 1)); then
    telemetry_segment_stop ||
      diag_die "pinned-concurrent telemetry writer could not be confirmed stopped"
    telemetry_resumable_append_active pinned-concurrent-session- "$telemetry_segment" ||
      diag_die "cannot append the completed pinned-concurrent telemetry session"
  fi

  stage="$STATE_DIR/pinned-concurrent-finalize"
  staged_tsv="$stage/pinned-concurrent.tsv"
  staged_boundaries="$stage/pinned-concurrent.boundaries.ndjson"
  staged_meta="$stage/pinned-concurrent.meta"
  if ((stage_ready == 0)); then
    pinned_concurrent_final_stage_prepare "$stage" "$generation" "$wave_state" \
      "$groups" "$plan" "$tsv" "$boundaries" "$meta" ||
      diag_die "pinned-concurrent finalization failed its strict state/evidence reconciliation"
  fi
  pinned_concurrent_final_publish "$stage" "$staged_tsv" "$tsv" \
    "$staged_boundaries" "$boundaries" "$staged_meta" "$meta" ||
    diag_die "cannot durably publish finalized pinned-concurrent evidence"
  node "$LIB/pinned-concurrent-evidence.mjs" validate-complete "$OUT_DIR" \
    "$generation" "$INDIVIDUAL_GROUP_GENERATION" "$INDIVIDUAL_GROUP_PLAN_DIGEST" \
    "$PINNED_CONCURRENT_ROUNDS" "$PROTOCOL_SEED" > /dev/null ||
    diag_die "pinned-concurrent evidence is not publication-ready before its marker"
  if [[ "$TELEMETRY_RESUME_AVAILABLE" == 1 &&
    "$TELEMETRY_RESUME_SEGMENTS_JSON" != "[]" ]]; then
    telemetry_phase_publish pinned-concurrent "$TELEMETRY_RESUME_SEGMENTS_JSON"
  elif [[ "$TELEMETRY_RESUME_AVAILABLE" == 1 ]]; then
    TELEMETRY_DEGRADED=1
    diag_warn "pinned-concurrent telemetry has no complete session envelope; workload evidence is retained"
  fi
  mark_done pinned-concurrent
  pinned_concurrent_evidence_is_complete ||
    diag_die "completed pinned-concurrent evidence failed post-marker validation"
}

# ------------------------------------------------------------------
# Worst CPU from a fully validated individual phase (highest SIGSEGV rate,
# ties: more SIGSEGVs, then lower CPU id). When this shell already derived the
# expected targets, the envelope must also bind that exact groups generation;
# the startup CPU-policy path runs before any derivation and is caught later
# by the phase-4 gate, so it intentionally skips that comparison.
worst_cpu() {
  local expected_version=4
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && expected_version=6
  individual_evidence_read || return 0
  [[ "$INDIVIDUAL_META_VERSION" == "$expected_version" &&
    "$INDIVIDUAL_EVIDENCE_STATUS" == complete ]] || return 0
  [[ -n "$INDIVIDUAL_GROUP_GENERATION" &&
    "$INDIVIDUAL_META_GROUP_GENERATION" != "$INDIVIDUAL_GROUP_GENERATION" ]] && return 0
  printf '%s\n' "$INDIVIDUAL_EVIDENCE_WORST_CPU"
}

# ------------------------------------------------------------------
# Phase 5 (frequency A/B/A) is never executed by this script: it changes a
# runtime setting, so it lives in frequency-ab.sh for the user to review
# and run with sudo. Here we only detect already-collected results or
# print the exact manual command.
phase_frequency() {
  local cpu="$1"
  if frequency_result_is_complete "$cpu"; then
    diag_log "frequency: frequency-ab.tsv present (manual frequency-ab.sh run); incorporating"
    mark_done frequency
    return 0
  fi
  if [[ -e "$OUT_DIR/results/frequency-ab.tsv" || -e "$OUT_DIR/results/frequency-ab.meta" ]]; then
    diag_warn "frequency: incomplete manual frequency results found; phase remains resumable"
  fi
  diag_warn "frequency: A/B/A not run by this script (it changes a runtime setting)."
  if [[ -n "$cpu" ]]; then
    diag_warn "  to run it manually:  sudo ./frequency-ab.sh $cpu $INDIVIDUAL_RUNS \"$OUT_DIR\""
    diag_warn "  then regenerate:     ./diagnose.sh --resume \"$OUT_DIR\" --yes"
  else
    diag_warn "  no failing CPU identified; nothing to test."
  fi
}

frequency_result_is_complete() {
  local expected_cpu="${1:-}"
  local mode="${2:---ready}"
  [[ "$expected_cpu" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  [[ "$mode" == --ready || "$mode" == --complete ]] || return 1
  node "$SCRIPT_DIR/diagnose-lib/frequency-evidence.mjs" \
    "$mode" "$OUT_DIR" "$expected_cpu" > /dev/null 2>&1
}

# ------------------------------------------------------------------
GDB_ATTEMPTED_RUNS=""
GDB_CLEAN_RUNS=""
GDB_CAPTURED_RUNS=""
GDB_ERROR_RUNS=""
GDB_RUNNER_EXIT_CODE=""
GDB_META_TEMP=""

# Read the generation-bound runner log produced by capture-fault.sh. The log
# is evidence only when every record is exact: contiguous ATTEMPT lines bound
# to the expected generation, CPU, and limits, one terminal COUNTS record as
# the last line, bounded bytes and lines, and terminal counts that reconcile
# with the configured attempt ceiling. Duplicate, overlong, nonterminal, or
# mixed records are rejected. diagnose-lib/gdb-evidence.mjs remains the final
# authority; this parser gates metadata publication and exit-status policy.
gdb_run_counts_read() {
  local logf="$1" generation="$2" cpu="$3" max_runs="$4" max_captures="$5"
  local size line_count line run=0 clean=0 captured=0 errors=0 cap_run=0
  local terminal="" expected outcome
  GDB_ATTEMPTED_RUNS=""
  GDB_CLEAN_RUNS=""
  GDB_CAPTURED_RUNS=""
  GDB_ERROR_RUNS=""
  GDB_RUNNER_EXIT_CODE=""
  [[ -f "$logf" && ! -L "$logf" ]] || return 1
  [[ "$generation" =~ ^[0-9a-f]{32}$ &&
    "$cpu" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  diag_is_safe_positive_uint "$max_runs" &&
    diag_is_safe_positive_uint "$max_captures" || return 1
  size="$(stat -c %s -- "$logf" 2> /dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  ((size > 0 && size <= (max_runs + 1) * 513)) || return 1
  line_count="$(wc -l < "$logf")" || return 1
  ((line_count >= 2 && line_count <= max_runs + 1)) || return 1
  # Canonical text only: tab and printable ASCII per line, LF-terminated.
  LC_ALL=C grep -q $'[^ -~\t]' "$logf" && return 1
  LC_ALL=C awk 'length($0) > 512 { exit 1 }' "$logf" || return 1
  [[ -z "$(tail -c 1 -- "$logf")" ]] || return 1
  while IFS= read -r line; do
    [[ -z "$terminal" ]] || return 1
    if [[ "$line" == $'ATTEMPT\t'* ]]; then
      ((cap_run == 0)) || return 1
      run=$((run + 1))
      printf -v expected 'ATTEMPT\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tRUN\t%s\tOUTCOME\t' \
        "$generation" "$cpu" "$max_runs" "$max_captures" "$run"
      [[ "$line" == "$expected"* ]] || return 1
      outcome="${line#"$expected"}"
      case "$outcome" in
        clean) clean=$((clean + 1)) ;;
        captured)
          captured=$((captured + 1))
          ((captured == max_captures)) && cap_run=$run
          ;;
        error) errors=$((errors + 1)) ;;
        *) return 1 ;;
      esac
    elif [[ "$line" == $'COUNTS\t'* ]]; then
      printf -v expected 'COUNTS\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tATTEMPTED\t%s\tCLEAN\t%s\tCAPTURED\t%s\tERRORS\t%s\tEXIT_CODE\t' \
        "$generation" "$cpu" "$max_runs" "$max_captures" \
        "$run" "$clean" "$captured" "$errors"
      [[ "$line" == "$expected"0 || "$line" == "$expected"3 ]] || return 1
      terminal="${line#"$expected"}"
    else
      return 1
    fi
  done < "$logf"
  [[ -n "$terminal" && "$terminal" =~ ^(0|3)$ ]] || return 1
  ((run >= 1 && run <= max_runs && run == clean + captured + errors)) || return 1
  if [[ "$terminal" == 0 ]]; then
    ((captured >= 1 && captured <= max_captures &&
      (run == max_runs || captured == max_captures))) || return 1
  else
    ((run == max_runs && captured == 0 && clean >= 1)) || return 1
  fi
  GDB_ATTEMPTED_RUNS="$run"
  GDB_CLEAN_RUNS="$clean"
  GDB_CAPTURED_RUNS="$captured"
  GDB_ERROR_RUNS="$errors"
  GDB_RUNNER_EXIT_CODE="$terminal"
}

# A fresh run or skip envelope starts from owned, empty transcript and runner
# directories. Anything left behind is a prior attempt that the dispatcher
# archives before this point; refuse to merge evidence across attempts.
gdb_prepare_fresh_dirs() {
  local relative path
  for relative in gdb logs/gdb; do
    bundle_prepare_dir "$relative" ||
      diag_die "cannot prepare safe bundle directory '$relative'"
    path="$OUT_DIR/$relative"
    [[ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2> /dev/null)" ]] ||
      diag_die "GDB directory '$relative' is not empty for a fresh attempt; preserve it and resume with --redo gdb"
  done
}

# Publish the legacy-shaped results/gdb.meta through a private temporary
# file, an fsync, and one atomic no-clobber rename. Usage:
#   gdb_meta_publish RUN <cpu> <exit-code> | gdb_meta_publish SKIP <reason>
gdb_meta_publish() {
  local kind="$1" meta="$OUT_DIR/results/gdb.meta" tmp
  [[ ! -e "$meta" && ! -L "$meta" ]] ||
    diag_die "existing gdb metadata conflicts with a fresh phase; preserve it and resume with --redo gdb"
  tmp="$(mktemp "$OUT_DIR/results/.gdb.meta.XXXXXX")" ||
    diag_die "cannot prepare gdb metadata"
  GDB_META_TEMP="$tmp"
  chmod 0600 "$tmp" || diag_die "cannot protect gdb metadata"
  case "$kind" in
    RUN)
      {
        printf 'CPU=%s\n' "$2"
        printf 'MAX_RUNS=%s\n' "$GDB_MAX_RUNS"
        printf 'EXIT_CODE=%s\n' "$3"
        printf 'ATTEMPTED_RUNS=%s\n' "$GDB_ATTEMPTED_RUNS"
        printf 'CLEAN_RUNS=%s\n' "$GDB_CLEAN_RUNS"
        printf 'CAPTURED_RUNS=%s\n' "$GDB_CAPTURED_RUNS"
        printf 'ERROR_RUNS=%s\n' "$GDB_ERROR_RUNS"
      } > "$tmp" || diag_die "cannot write gdb metadata"
      ;;
    SKIP)
      printf 'SKIPPED=1\nSKIP_REASON=%s\n' "$2" > "$tmp" ||
        diag_die "cannot write gdb metadata"
      ;;
    *) diag_die "unknown gdb metadata kind '$kind'" ;;
  esac
  sync -f "$tmp" || diag_die "cannot synchronize gdb metadata"
  mv -nT -- "$tmp" "$meta" || diag_die "cannot publish gdb metadata"
  [[ ! -e "$tmp" ]] || diag_die "another gdb metadata file appeared concurrently"
  GDB_META_TEMP=""
  sync -f "$OUT_DIR/results" || diag_die "cannot synchronize the gdb results directory"
}

# Build the hidden generation candidate, validate it, publish it as the
# authoritative results/gdb.manifest without clobbering, fsync the results
# directory, and re-validate the published envelope before the completion
# marker exists. Usage: gdb_evidence_publish <generation> <cpu|->
gdb_evidence_publish() {
  local generation="$1" cpu="$2"
  local candidate="$OUT_DIR/results/.gdb.manifest.$generation"
  node "$LIB/gdb-evidence.mjs" build "$OUT_DIR" "$candidate" "$generation" \
    "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" ||
    diag_die "cannot build validated gdb evidence; phase remains resumable"
  mv -nT -- "$candidate" "$OUT_DIR/results/gdb.manifest" ||
    diag_die "cannot publish gdb evidence manifest; phase remains resumable"
  [[ ! -e "$candidate" ]] ||
    diag_die "another gdb evidence manifest appeared concurrently"
  sync -f "$OUT_DIR/results" ||
    diag_die "cannot synchronize the gdb results directory"
  node "$LIB/gdb-evidence.mjs" validate-before "$OUT_DIR" \
    "$OUT_DIR/results/gdb.manifest" "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" ||
    diag_die "published gdb evidence failed validation; phase remains resumable"
}

# The completed envelope is the only authority for the recorded GDB CPU. The
# identity record is extracted under byte bounds, then validate-complete
# re-checks the entire envelope against that exact expectation. Prints the
# bound CPU id, or "-" for a CPU-independent skip envelope.
gdb_completed_envelope_cpu() {
  local manifest="$OUT_DIR/results/gdb.manifest"
  local size parsed cpu_count cpu skip_count kind extracted
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  diag_is_safe_positive_uint "$GDB_MAX_RUNS" || return 1
  size="$(stat -c %s -- "$manifest" 2> /dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  ((size > 0 && size <= (GDB_MAX_RUNS + 8) * 513)) || return 1
  parsed="$(LC_ALL=C awk -F '\t' '
    $1 == "CONFIG" && $2 == "CPU" && NF == 3 { cpu_count += 1; cpu = $3 }
    $1 == "SKIP" && NF == 2 { skip_count += 1; kind = $2 }
    END { printf "%s %s %s %s\n", cpu_count + 0, cpu, skip_count + 0, kind }
  ' "$manifest")" || return 1
  cpu_count="${parsed%% *}"; parsed="${parsed#* }"
  cpu="${parsed%% *}"; parsed="${parsed#* }"
  skip_count="${parsed%% *}"; kind="${parsed#* }"
  if [[ "$cpu_count" == 1 && "$skip_count" == 0 &&
    "$cpu" =~ ^(0|[1-9][0-9]*)$ ]]; then
    extracted="$cpu"
  elif [[ "$cpu_count" == 0 && "$skip_count" == 1 && ( "$kind" == "--skip-gdb" ||
    "$kind" == "gdb not installed" || "$kind" == "no failing CPU identified" ) ]]; then
    extracted="-"
  else
    return 1
  fi
  node "$LIB/gdb-evidence.mjs" validate-complete "$OUT_DIR" "$extracted" \
    "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" > /dev/null 2>&1 || return 1
  printf '%s\n' "$extracted"
}

# The completed-resume gate: the marker and legacy gdb.meta are not
# authoritative; only a fully validated generation-bound envelope completes
# the phase.
gdb_completed_resume_gate() {
  gdb_completed_envelope_cpu > /dev/null 2>&1 ||
    diag_die "completed gdb phase has missing, stale, or invalid evidence; preserve it and resume with --redo gdb"
}

phase_gdb() {
  local cpu="$1"
  local runner_log="$OUT_DIR/logs/gdb/runner.log"
  local telemetry_started=0
  gdb_prepare_fresh_dirs
  local generation
  generation="$(node "$LIB/gdb-evidence.mjs" new-generation)" ||
    diag_die "cannot generate a fresh gdb evidence generation"
  [[ "$generation" =~ ^[0-9a-f]{32}$ ]] ||
    diag_die "generated gdb evidence generation is malformed"
  diag_log_cmd bash capture-fault.sh "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb" "$generation"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_sampler_start gdb gdb 1 ||
      diag_die "gdb telemetry failed before workload launch"
    telemetry_boundary_start ||
      diag_die "gdb telemetry boundary failed before workload launch"
    telemetry_started=1
  fi
  local rc=0
  run_gdb_logged "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb" \
    "$runner_log" "$generation" || rc=$?
  if ((telemetry_started == 1)); then
    telemetry_segment_stop ||
      diag_die "gdb telemetry writer could not be confirmed stopped"
  fi
  case "$rc" in
    0 | 3) ;;
    4) diag_die "gdb capture lost a required dependency; phase remains resumable" ;;
    5) diag_die "gdb runner failed (see logs/gdb/runner.log); phase remains resumable" ;;
    *) diag_die "gdb runner returned unexpected exit code $rc; phase remains resumable" ;;
  esac
  gdb_run_counts_read "$runner_log" "$generation" "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" ||
    diag_die "gdb runner did not produce one valid terminal accounting record; phase remains resumable"
  [[ "$GDB_RUNNER_EXIT_CODE" == "$rc" ]] ||
    diag_die "gdb runner exit status conflicts with its terminal accounting; phase remains resumable"
  gdb_result_is_complete "$rc" "$GDB_MAX_RUNS" "$GDB_ATTEMPTED_RUNS" \
    "$GDB_CLEAN_RUNS" "$GDB_CAPTURED_RUNS" "$GDB_ERROR_RUNS" ||
    diag_die "gdb terminal accounting violates its run-count policy; phase remains resumable"
  gdb_meta_publish RUN "$cpu" "$rc"
  gdb_evidence_publish "$generation" "$cpu"
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    telemetry_phase_publish gdb '[{"segment":1,"tag":"gdb"}]'
  fi
  case "$rc" in
    0) diag_log "gdb: fault captured" ;;
    3) diag_log "gdb: no fault within $GDB_MAX_RUNS runs" ;;
  esac
  mark_done gdb
  node "$LIB/gdb-evidence.mjs" validate-complete "$OUT_DIR" "$cpu" \
    "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" > /dev/null 2>&1 ||
    diag_die "completed gdb evidence failed validation; preserve it and resume with --redo gdb"
}

phase_gdb_skipped() {
  local reason="$1"
  gdb_prepare_fresh_dirs
  local generation
  generation="$(node "$LIB/gdb-evidence.mjs" new-generation)" ||
    diag_die "cannot generate a fresh gdb evidence generation"
  [[ "$generation" =~ ^[0-9a-f]{32}$ ]] ||
    diag_die "generated gdb evidence generation is malformed"
  gdb_meta_publish SKIP "$reason"
  gdb_evidence_publish "$generation" -
  mark_done gdb
  node "$LIB/gdb-evidence.mjs" validate-complete "$OUT_DIR" - \
    "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" > /dev/null 2>&1 ||
    diag_die "completed gdb evidence failed validation; preserve it and resume with --redo gdb"
}

gdb_result_is_complete() {
  local rc="$1" max_runs="$2" attempted="$3" clean="$4" captured="$5" errors="$6"
  diag_is_safe_positive_uint "$max_runs" || return 1
  [[ "$attempted" =~ ^(0|[1-9][0-9]*)$ &&
    "$clean" =~ ^(0|[1-9][0-9]*)$ && "$captured" =~ ^(0|[1-9][0-9]*)$ &&
    "$errors" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  ((attempted <= max_runs && attempted == clean + captured + errors)) || return 1
  case "$rc" in
    0) ((captured >= 1)) ;;
    3) ((attempted == max_runs && captured == 0 && clean >= 1)) ;;
    *) return 1 ;;
  esac
}

gdb_attempt_path_is_meaningful() {
  local path="$1" entry=""
  [[ -e "$path" || -L "$path" ]] || return 1
  [[ -d "$path" && ! -L "$path" ]] || return 0
  entry="$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2> /dev/null)" ||
    return 0
  [[ -n "$entry" ]]
}

gdb_incomplete_attempt_is_meaningful() {
  phase_is_done gdb && return 1
  local candidate
  [[ -e "$OUT_DIR/results/gdb.meta" || -L "$OUT_DIR/results/gdb.meta" ]] && return 0
  [[ -e "$OUT_DIR/results/gdb.manifest" || -L "$OUT_DIR/results/gdb.manifest" ]] && return 0
  [[ -e "$OUT_DIR/results/telemetry-gdb.tsv" ||
    -L "$OUT_DIR/results/telemetry-gdb.tsv" ]] && return 0
  [[ -e "$OUT_DIR/results/telemetry-gdb.meta" ||
    -L "$OUT_DIR/results/telemetry-gdb.meta" ]] && return 0
  for candidate in "$OUT_DIR"/results/.gdb.manifest.*; do
    [[ -e "$candidate" || -L "$candidate" ]] && return 0
  done
  gdb_attempt_path_is_meaningful "$OUT_DIR/gdb" && return 0
  gdb_attempt_path_is_meaningful "$OUT_DIR/logs/gdb" && return 0
  gdb_attempt_path_is_meaningful "$OUT_DIR/telemetry/gdb" && return 0
  gdb_attempt_path_is_meaningful "$OUT_DIR/state/telemetry-gdb" && return 0
  return 1
}

archive_incomplete_gdb_attempt() {
  gdb_incomplete_attempt_is_meaningful || return 0
  redo_transaction_prepare
  local path candidate redo_format=2
  [[ "$RUN_SCHEMA_VERSION" == 2 ]] && redo_format=3
  {
    printf 'VERSION\t%s\nTXN\t%s\n' "$redo_format" "$REDO_NEW_TXN_ID"
    redo_write_config_records
    printf 'PHASE\tgdb\n'
    for path in results.json report.md privacy-review.txt manifest.txt; do
      redo_record_if_present DERIVED - "$path"
    done
    for path in results/gdb.meta results/gdb.manifest gdb logs/gdb \
      results/telemetry-gdb.tsv results/telemetry-gdb.meta telemetry/gdb \
      state/telemetry-gdb; do
      redo_record_if_present ARTIFACT gdb "$path"
    done
    for candidate in "$OUT_DIR"/results/.gdb.manifest.* "$OUT_DIR"/results/.gdb.meta.*; do
      [[ ! -e "$candidate" && ! -L "$candidate" ]] ||
        redo_record_if_present ARTIFACT gdb "${candidate#"$OUT_DIR"/}"
    done
  } > "$REDO_MARKER_TEMP" || diag_die "cannot write incomplete GDB archive transaction"
  redo_transaction_publish
}

phase_gdb_dispatch() {
  local target_cpu="$1"
  # A prior non-terminal attempt must be archived before any replacement,
  # including a skip result. Empty directories created for a fresh bundle do
  # not constitute an attempt.
  archive_incomplete_gdb_attempt
  if [[ "$SKIP_GDB" == "1" ]]; then
    diag_log "gdb: skipped (--skip-gdb)"
    phase_gdb_skipped "--skip-gdb"
  elif ! command -v gdb > /dev/null 2>&1; then
    diag_warn "gdb: gdb not installed; skipping"
    phase_gdb_skipped "gdb not installed"
  elif [[ -z "$target_cpu" ]]; then
    diag_warn "gdb: no failing CPU identified; skipping"
    phase_gdb_skipped "no failing CPU identified"
  else
    diag_log "gdb: signature capture on cpu $target_cpu (max $GDB_MAX_RUNS runs)"
    phase_gdb "$target_cpu"
  fi
}

# ------------------------------------------------------------------
finalization_checkpoint() {
  return 0
}

derived_manifest_revoke() {
  local manifest="$OUT_DIR/manifest.txt"
  [[ -d "$OUT_DIR" && ! -L "$OUT_DIR" ]] || return 1
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    [[ -f "$manifest" || -L "$manifest" ]] || return 1
    rm -f -- "$manifest" > /dev/null 2>&1 || return 1
    [[ ! -e "$manifest" && ! -L "$manifest" ]] || return 1
  fi
  # Always checkpoint the directory, including an absent/idempotent retry
  # after a prior unlink whose directory sync failed.
  sync -f "$OUT_DIR" > /dev/null 2>&1
}

derived_owned_single_regular() {
  local path="$1" metadata owner links
  [[ -f "$path" && ! -L "$path" ]] || return 1
  metadata="$(stat -c '%u:%h' -- "$path" 2> /dev/null)" || return 1
  [[ "$metadata" =~ ^([0-9]+):([0-9]+)$ ]] || return 1
  owner="${BASH_REMATCH[1]}"
  links="${BASH_REMATCH[2]}"
  [[ "$owner" == "$EUID" && "$links" == 1 ]]
}

derived_remove_validated_candidates() {
  local sync_dir="$1"
  shift
  local path removed=0
  for path in "$@"; do
    [[ -e "$path" || -L "$path" ]] || continue
    derived_owned_single_regular "$path" || return 1
  done
  for path in "$@"; do
    [[ -e "$path" || -L "$path" ]] || continue
    rm -f -- "$path" > /dev/null 2>&1 || return 1
    [[ ! -e "$path" && ! -L "$path" ]] || return 1
    removed=1
  done
  ((removed == 0)) || sync -f "$sync_dir" > /dev/null 2>&1
}

derived_fixed_candidates_cleanup_stranded() {
  derived_remove_validated_candidates "$OUT_DIR" \
    "$OUT_DIR/.results.json.pending" \
    "$OUT_DIR/.report.md.pending" \
    "$OUT_DIR/.manifest.txt.pending" \
    "$OUT_DIR/.privacy-review.pending" \
    "$OUT_DIR/.privacy-inventory-before.pending" \
    "$OUT_DIR/.privacy-inventory-after.pending"
}

derived_recover_stranded_candidates() {
  derived_fixed_candidates_cleanup_stranded
}

derived_paths_init() {
  DERIVED_RESULTS_CANDIDATE="$OUT_DIR/.results.json.pending"
  DERIVED_REPORT_CANDIDATE="$OUT_DIR/.report.md.pending"
  DERIVED_MANIFEST_CANDIDATE="$OUT_DIR/.manifest.txt.pending"
}

derived_destination_state() {
  local path="$1" state
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    printf 'absent\n'
    return 0
  fi
  [[ -f "$path" || -L "$path" ]] || return 1
  state="$(stat -c '%d:%i:%f:%h:%s:%y:%z' -- "$path" 2> /dev/null)" || return 1
  [[ -n "$state" ]] || return 1
  printf '%s\n' "$state"
}

derived_destination_matches() {
  local path="$1" expected="$2" actual
  if [[ "$expected" == absent ]]; then
    [[ ! -e "$path" && ! -L "$path" ]]
    return
  fi
  [[ -f "$path" || -L "$path" ]] || return 1
  actual="$(stat -c '%d:%i:%f:%h:%s:%y:%z' -- "$path" 2> /dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

derived_run_open() {
  DERIVED_FINALIZATION_COMPLETE=0
  derived_manifest_revoke || return 1
  derived_recover_stranded_candidates || return 1
}

derived_generation_begin() {
  DERIVED_FINALIZATION_COMPLETE=0
  DERIVED_FINALIZATION_ERROR=""
  derived_manifest_revoke || return 1
  derived_recover_stranded_candidates || return 1
  derived_paths_init
  DERIVED_RESULTS_DEST_STATE="$(derived_destination_state "$OUT_DIR/results.json")" || return 1
  DERIVED_REPORT_DEST_STATE="$(derived_destination_state "$OUT_DIR/report.md")" || return 1
  DERIVED_PRIVACY_DEST_STATE="$(derived_destination_state "$OUT_DIR/privacy-review.txt")" || return 1
  DERIVED_MANIFEST_DEST_STATE="$(derived_destination_state "$OUT_DIR/manifest.txt")" || return 1
  [[ "$DERIVED_MANIFEST_DEST_STATE" == absent ]] || return 1
  finalization_checkpoint generation-opened
}

derived_candidate_same_device() {
  local candidate="$1" bundle_device candidate_device
  bundle_device="$(stat -c '%d' -- "$OUT_DIR" 2> /dev/null)" || return 1
  candidate_device="$(stat -c '%d' -- "$candidate" 2> /dev/null)" || return 1
  [[ "$bundle_device" =~ ^[0-9]+$ && "$candidate_device" == "$bundle_device" ]]
}

derived_publish_candidate() {
  local candidate_name="$1" destination="$2" expected_state="$3"
  local -n candidate_ref="$candidate_name"
  local candidate="$candidate_ref"
  [[ -n "$candidate" ]] || return 1
  derived_owned_single_regular "$candidate" || return 1
  derived_candidate_same_device "$candidate" || return 1
  chmod 0644 "$candidate" > /dev/null 2>&1 || return 1
  sync -f "$candidate" > /dev/null 2>&1 || return 1
  derived_destination_matches "$destination" "$expected_state" || return 1
  node -e '
    const fs = require("fs");
    if (process.argv.length !== 3) process.exit(2);
    fs.renameSync(process.argv[1], process.argv[2]);
  ' -- "$candidate" "$destination" > /dev/null 2>&1 || return 1
  candidate_ref=""
  [[ -f "$destination" && ! -L "$destination" ]] || return 1
  sync -f "$OUT_DIR" > /dev/null 2>&1
}

derived_candidate_cleanup_tracked() {
  local cleanup_rc=0 removed=0 candidate_name candidate
  local -a candidate_names=(
    DERIVED_RESULTS_CANDIDATE DERIVED_REPORT_CANDIDATE DERIVED_MANIFEST_CANDIDATE
  )
  if [[ -n "$DERIVED_MANIFEST_FD" ]]; then
    if { exec {DERIVED_MANIFEST_FD}>&-; } 2> /dev/null; then
      DERIVED_MANIFEST_FD=""
    else
      cleanup_rc=1
    fi
  fi
  for candidate_name in "${candidate_names[@]}"; do
    local -n candidate_ref="$candidate_name"
    candidate="$candidate_ref"
    [[ -n "$candidate" ]] || continue
    case "$candidate_name:$candidate" in
      DERIVED_RESULTS_CANDIDATE:"$OUT_DIR/.results.json.pending" | \
        DERIVED_REPORT_CANDIDATE:"$OUT_DIR/.report.md.pending" | \
        DERIVED_MANIFEST_CANDIDATE:"$OUT_DIR/.manifest.txt.pending") ;;
      *) cleanup_rc=1; continue ;;
    esac
    if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      candidate_ref=""
      continue
    fi
    if derived_owned_single_regular "$candidate" &&
      rm -f -- "$candidate" > /dev/null 2>&1 &&
      [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      candidate_ref=""
      removed=1
    else
      cleanup_rc=1
    fi
  done
  if ((removed == 1)); then
    sync -f "$OUT_DIR" > /dev/null 2>&1 || cleanup_rc=1
  fi
  return "$cleanup_rc"
}

derived_generation_abort() {
  local abort_rc=0
  derived_manifest_revoke || abort_rc=1
  if ((abort_rc == 0)); then
    derived_candidate_cleanup_tracked || abort_rc=1
    privacy_review_temp_cleanup || abort_rc=1
  fi
  DERIVED_FINALIZATION_COMPLETE=0
  return "$abort_rc"
}

privacy_review_temp_cleanup() {
  local cleanup_rc=0 fd_name path_name path
  local -a fd_names=(
    PRIVACY_REVIEW_FD PRIVACY_INVENTORY_BEFORE_FD PRIVACY_INVENTORY_AFTER_FD
  )
  local -a path_names=(
    PRIVACY_REVIEW_TEMP PRIVACY_INVENTORY_BEFORE PRIVACY_INVENTORY_AFTER
  )
  for fd_name in "${fd_names[@]}"; do
    local -n fd_ref="$fd_name"
    [[ -n "$fd_ref" ]] || continue
    if { exec {fd_ref}>&-; } 2> /dev/null; then
      fd_ref=""
    else
      cleanup_rc=1
    fi
  done
  for path_name in "${path_names[@]}"; do
    local -n path_ref="$path_name"
    path="$path_ref"
    [[ -n "$path" ]] || continue
    case "$path_name:$path" in
      PRIVACY_REVIEW_TEMP:"${OUT_DIR:-}/.privacy-review.pending" | \
        PRIVACY_INVENTORY_BEFORE:"${OUT_DIR:-}/.privacy-inventory-before.pending" | \
        PRIVACY_INVENTORY_AFTER:"${OUT_DIR:-}/.privacy-inventory-after.pending") ;;
      *) cleanup_rc=1; continue ;;
    esac
  done
  if ((cleanup_rc == 0)); then
    derived_remove_validated_candidates "$OUT_DIR" \
      "$OUT_DIR/.privacy-review.pending" \
      "$OUT_DIR/.privacy-inventory-before.pending" \
      "$OUT_DIR/.privacy-inventory-after.pending" || cleanup_rc=1
  fi
  if ((cleanup_rc == 0)); then
    PRIVACY_REVIEW_TEMP=""
    PRIVACY_INVENTORY_BEFORE=""
    PRIVACY_INVENTORY_AFTER=""
  fi
  return "$cleanup_rc"
}

privacy_candidate_open() {
  local path_name="$1" fd_name="$2" expected="$3"
  local fd="" open_rc=0 noclobber_was_set=0 saved_umask
  local -n path_ref="$path_name" fd_ref="$fd_name"
  [[ -z "$path_ref" && -z "$fd_ref" && ! -e "$expected" && ! -L "$expected" ]] || return 1
  saved_umask="$(umask)" || return 1
  [[ "$saved_umask" =~ ^[0-7]{3,4}$ ]] || return 1
  umask 077 || return 1
  [[ -o noclobber ]] && noclobber_was_set=1 || set -o noclobber
  if { exec {fd}> "$expected"; } 2> /dev/null; then
    :
  else
    open_rc=1
  fi
  ((noclobber_was_set == 1)) || set +o noclobber
  if ! umask "$saved_umask"; then
    [[ -z "$fd" ]] || { exec {fd}>&-; } 2> /dev/null || true
    return 1
  fi
  ((open_rc == 0)) || return 1
  path_ref="$expected"
  fd_ref="$fd"
  derived_owned_single_regular "$expected"
}

privacy_candidate_close() {
  local fd_name="$1"
  local -n fd_ref="$fd_name"
  [[ -n "$fd_ref" ]] || return 0
  { exec {fd_ref}>&-; } 2> /dev/null || return 1
  fd_ref=""
}

privacy_manifest_invalidate() {
  derived_manifest_revoke || {
    echo "error: could not synchronize stale manifest invalidation" >&2
    return 1
  }
}

privacy_inventory_build() {
  local output_fd="$1"
  if ! LC_ALL=C find "$OUT_DIR" -mindepth 1 \
    ! -path "$OUT_DIR/.privacy-review.pending" \
    ! -path "$OUT_DIR/.privacy-inventory-before.pending" \
    ! -path "$OUT_DIR/.privacy-inventory-after.pending" -print0 2> /dev/null |
    LC_ALL=C sort -z >&"$output_fd" 2> /dev/null; then
    echo "error: could not enumerate the complete privacy inventory" >&2
    return 1
  fi
}

privacy_candidates_share_device() {
  local bundle_device temp_device tmp
  bundle_device="$(stat -c '%d' -- "$OUT_DIR" 2> /dev/null)" || {
    echo "error: could not validate privacy publication filesystem" >&2
    return 1
  }
  [[ "$bundle_device" =~ ^[0-9]+$ ]] || {
    echo "error: could not validate privacy publication filesystem" >&2
    return 1
  }
  for tmp in "$PRIVACY_REVIEW_TEMP" "$PRIVACY_INVENTORY_BEFORE" \
    "$PRIVACY_INVENTORY_AFTER"; do
    [[ -n "$tmp" ]] && derived_owned_single_regular "$tmp" || {
      echo "error: unsafe privacy publication candidate" >&2
      return 1
    }
    temp_device="$(stat -c '%d' -- "$tmp" 2> /dev/null)" || {
      echo "error: could not validate privacy publication filesystem" >&2
      return 1
    }
    [[ "$temp_device" =~ ^[0-9]+$ && "$temp_device" == "$bundle_device" ]] || {
      echo "error: privacy publication candidates are not on the bundle filesystem" >&2
      return 1
    }
  done
}

privacy_entry_fingerprint() {
  stat -c '%d:%i:%f:%h:%s:%y:%z' -- "$1" 2> /dev/null
}

privacy_inventory_validate() {
  local inventory="$1" stats_name="$2" file rel fingerprint
  local -n stats_ref="$stats_name"
  stats_ref=()
  while IFS= read -r -d '' file; do
    [[ "$file" == "$OUT_DIR/"* ]] || {
      echo "error: privacy inventory escaped the diagnostics bundle" >&2
      return 1
    }
    rel="${file#"$OUT_DIR"/}"
    [[ -n "$rel" && ! "$rel" =~ [[:cntrl:]] ]] || {
      echo "error: privacy inventory contains an unsafe control pathname" >&2
      return 1
    }
    # These are finalizer-controlled outputs, not scan inputs. Only their
    # exact top-level spellings are excluded; nested names remain ordinary.
    case "$rel" in
      privacy-review.txt | manifest.txt) continue ;;
    esac
    [[ ! -L "$file" ]] || {
      echo "error: privacy inventory contains a symbolic link" >&2
      return 1
    }
    if [[ -d "$file" ]]; then
      [[ -r "$file" && -x "$file" ]] || {
        echo "error: privacy inventory contains an unreadable directory" >&2
        return 1
      }
    elif [[ -f "$file" ]]; then
      [[ -r "$file" ]] || {
        echo "error: privacy inventory contains an unreadable file" >&2
        return 1
      }
    else
      echo "error: privacy inventory contains a special file" >&2
      return 1
    fi
    fingerprint="$(privacy_entry_fingerprint "$file")" || {
      echo "error: could not stat a privacy inventory entry" >&2
      return 1
    }
    [[ -n "$fingerprint" ]] || return 1
    stats_ref["$rel"]="$fingerprint"
  done < "$inventory"
}

privacy_grep_probe() {
  local category="$1" rel="$2" file="$3" output_fd="$4" grep_rc=0
  shift 4
  LC_ALL=C grep "$@" -- "$file" > /dev/null 2>&1 || grep_rc=$?
  case "$grep_rc" in
    0)
      printf '%s\t%s\n' "$category" "$rel" >&"$output_fd" || return 3
      return 0
      ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

privacy_review_abort() {
  privacy_review_temp_cleanup || true
  privacy_manifest_invalidate > /dev/null 2>&1 || true
  echo "error: privacy sentinel scan failed closed" >&2
  return 1
}

write_privacy_review() {
  local review="$OUT_DIR/privacy-review.txt" review_state="${1:-}"
  local file rel fingerprint probe_rc found=0 scan_failed=0 review_fd=""
  local -A stats_before=() stats_after=()

  [[ -d "$OUT_DIR" && ! -L "$OUT_DIR" && -r "$OUT_DIR" &&
    -w "$OUT_DIR" && -x "$OUT_DIR" ]] || {
    echo "error: diagnostics bundle is unsafe for privacy publication" >&2
    return 1
  }

  # Revoke the previous derived generation before any privacy failure can be
  # mistaken for a complete finalization.
  privacy_manifest_invalidate || return 1

  if [[ -z "$review_state" ]]; then
    review_state="$(derived_destination_state "$review")" || {
      privacy_review_abort
      return 1
    }
  fi

  privacy_candidate_open PRIVACY_INVENTORY_BEFORE PRIVACY_INVENTORY_BEFORE_FD \
    "$OUT_DIR/.privacy-inventory-before.pending" || {
    privacy_review_abort
    return 1
  }
  privacy_candidate_open PRIVACY_INVENTORY_AFTER PRIVACY_INVENTORY_AFTER_FD \
    "$OUT_DIR/.privacy-inventory-after.pending" || {
    privacy_review_abort
    return 1
  }
  privacy_candidate_open PRIVACY_REVIEW_TEMP PRIVACY_REVIEW_FD \
    "$OUT_DIR/.privacy-review.pending" || {
    privacy_review_abort
    return 1
  }
  privacy_candidates_share_device || {
    privacy_review_abort
    return 1
  }

  privacy_inventory_build "$PRIVACY_INVENTORY_BEFORE_FD" || {
    privacy_review_abort
    return 1
  }
  privacy_candidate_close PRIVACY_INVENTORY_BEFORE_FD || {
    privacy_review_abort
    return 1
  }
  privacy_inventory_validate "$PRIVACY_INVENTORY_BEFORE" stats_before || {
    privacy_review_abort
    return 1
  }

  review_fd="$PRIVACY_REVIEW_FD"
  if ! printf '# Automated privacy sentinel scan\n' >&"$review_fd" ||
    ! printf '# Matches list only category and relative file; inspect raw files before sharing.\n' >&"$review_fd"; then
    privacy_review_abort
    return 1
  fi

  while IFS= read -r -d '' file; do
    rel="${file#"$OUT_DIR"/}"
    case "$rel" in
      privacy-review.txt | manifest.txt) continue ;;
    esac
    [[ -f "$file" && ! -L "$file" ]] || continue
    fingerprint="$(privacy_entry_fingerprint "$file")" || {
      scan_failed=1
      break
    }
    [[ "$fingerprint" == "${stats_before[$rel]:-}" ]] || {
      scan_failed=1
      break
    }

    if [[ -n "${HOME:-}" && "$HOME" != "/" ]]; then
      probe_rc=0
      privacy_grep_probe known-home-path "$rel" "$file" "$review_fd" \
        -aFq -e "$HOME" || probe_rc=$?
      case "$probe_rc" in 0) found=1 ;; 1) : ;; *) scan_failed=1; break ;; esac
    fi
    probe_rc=0
    privacy_grep_probe known-bundle-path "$rel" "$file" "$review_fd" \
      -aFq -e "$OUT_DIR" || probe_rc=$?
    case "$probe_rc" in 0) found=1 ;; 1) : ;; *) scan_failed=1; break ;; esac
    probe_rc=0
    privacy_grep_probe known-repository-path "$rel" "$file" "$review_fd" \
      -aFq -e "$SCRIPT_DIR" || probe_rc=$?
    case "$probe_rc" in 0) found=1 ;; 1) : ;; *) scan_failed=1; break ;; esac
    probe_rc=0
    privacy_grep_probe uuid-shape "$rel" "$file" "$review_fd" \
      -aEq -e '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' || probe_rc=$?
    case "$probe_rc" in 0) found=1 ;; 1) : ;; *) scan_failed=1; break ;; esac
    probe_rc=0
    privacy_grep_probe mac-shape "$rel" "$file" "$review_fd" \
      -aEiq -e '(^|[^0-9a-f])([0-9a-f]{2}[:-]){5}[0-9a-f]{2}([^0-9a-f]|$)' || probe_rc=$?
    case "$probe_rc" in 0) found=1 ;; 1) : ;; *) scan_failed=1; break ;; esac

    fingerprint="$(privacy_entry_fingerprint "$file")" || {
      scan_failed=1
      break
    }
    [[ "$fingerprint" == "${stats_before[$rel]:-}" ]] || {
      scan_failed=1
      break
    }
  done < "$PRIVACY_INVENTORY_BEFORE"

  ((scan_failed == 0)) || {
    privacy_review_abort
    return 1
  }
  if ((found == 0)); then
    printf 'status\tno-known-sentinels\n' >&"$review_fd" || {
      privacy_review_abort
      return 1
    }
  else
    printf 'status\treview-required\n' >&"$review_fd" || {
      privacy_review_abort
      return 1
    }
  fi
  if ! privacy_candidate_close PRIVACY_REVIEW_FD; then
    privacy_review_abort
    return 1
  fi
  review_fd=""

  privacy_inventory_build "$PRIVACY_INVENTORY_AFTER_FD" || {
    privacy_review_abort
    return 1
  }
  privacy_candidate_close PRIVACY_INVENTORY_AFTER_FD || {
    privacy_review_abort
    return 1
  }
  cmp -s -- "$PRIVACY_INVENTORY_BEFORE" "$PRIVACY_INVENTORY_AFTER" || {
    privacy_review_abort
    return 1
  }
  privacy_inventory_validate "$PRIVACY_INVENTORY_AFTER" stats_after || {
    privacy_review_abort
    return 1
  }
  ((${#stats_before[@]} == ${#stats_after[@]})) || {
    privacy_review_abort
    return 1
  }
  for rel in "${!stats_before[@]}"; do
    [[ "${stats_after[$rel]:-}" == "${stats_before[$rel]}" ]] || {
      privacy_review_abort
      return 1
    }
  done

  [[ ! -e "$OUT_DIR/manifest.txt" && ! -L "$OUT_DIR/manifest.txt" ]] || {
    privacy_review_abort
    return 1
  }
  if [[ "$review_state" == absent ]]; then
    [[ ! -e "$review" && ! -L "$review" ]] || {
      privacy_review_abort
      return 1
    }
  else
    [[ "$(stat -c '%d:%i:%f:%h:%s:%y:%z' -- "$review" 2> /dev/null)" == "$review_state" ]] || {
      privacy_review_abort
      return 1
    }
  fi

  chmod 0644 "$PRIVACY_REVIEW_TEMP" || {
    privacy_review_abort
    return 1
  }
  sync -f "$PRIVACY_REVIEW_TEMP" > /dev/null 2>&1 || {
    privacy_review_abort
    return 1
  }
  privacy_candidates_share_device || {
    privacy_review_abort
    return 1
  }
  # Direct rename never degrades into a cross-filesystem copy-and-unlink if a
  # mount changes after the device recheck. Suppress runtime path disclosure.
  node -e '
    const fs = require("fs");
    if (process.argv.length !== 3) process.exit(2);
    fs.renameSync(process.argv[1], process.argv[2]);
  ' -- "$PRIVACY_REVIEW_TEMP" "$review" > /dev/null 2>&1 || {
    privacy_review_abort
    return 1
  }
  PRIVACY_REVIEW_TEMP=""
  sync -f "$OUT_DIR" > /dev/null 2>&1 || {
    privacy_review_abort
    return 1
  }
  privacy_review_temp_cleanup || {
    privacy_review_abort
    return 1
  }
}

derived_manifest_candidate_open() {
  local fd="" open_rc=0 noclobber_was_set=0 saved_umask
  [[ "$DERIVED_MANIFEST_CANDIDATE" == "$OUT_DIR/.manifest.txt.pending" &&
    ! -e "$DERIVED_MANIFEST_CANDIDATE" && ! -L "$DERIVED_MANIFEST_CANDIDATE" ]] || return 1
  saved_umask="$(umask)" || return 1
  [[ "$saved_umask" =~ ^[0-7]{3,4}$ ]] || return 1
  umask 077 || return 1
  [[ -o noclobber ]] && noclobber_was_set=1 || set -o noclobber
  if { exec {fd}> "$DERIVED_MANIFEST_CANDIDATE"; } 2> /dev/null; then
    :
  else
    open_rc=1
  fi
  ((noclobber_was_set == 1)) || set +o noclobber
  if ! umask "$saved_umask"; then
    [[ -z "$fd" ]] || { exec {fd}>&-; } 2> /dev/null || true
    return 1
  fi
  ((open_rc == 0)) || return 1
  DERIVED_MANIFEST_FD="$fd"
  derived_owned_single_regular "$DERIVED_MANIFEST_CANDIDATE"
}

derived_manifest_candidate_close() {
  [[ -n "$DERIVED_MANIFEST_FD" ]] || return 0
  { exec {DERIVED_MANIFEST_FD}>&-; } 2> /dev/null || return 1
  DERIVED_MANIFEST_FD=""
}

write_manifest() {
  if [[ -z "$DERIVED_MANIFEST_CANDIDATE" ]]; then
    [[ ! -e "$OUT_DIR/manifest.txt" && ! -L "$OUT_DIR/manifest.txt" ]] || return 1
    derived_fixed_candidates_cleanup_stranded || return 1
    derived_paths_init
    DERIVED_MANIFEST_DEST_STATE=absent
  fi
  derived_manifest_candidate_open || return 1
  if ! (
    cd "$OUT_DIR" || exit 1
    LC_ALL=C find . -type f \
      ! -path './manifest.txt' \
      ! -path './.manifest.txt.pending' -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum
  ) >&"$DERIVED_MANIFEST_FD" 2> /dev/null; then
    derived_manifest_candidate_close || true
    return 1
  fi
  derived_manifest_candidate_close || return 1
  if ! derived_publish_candidate DERIVED_MANIFEST_CANDIDATE \
    "$OUT_DIR/manifest.txt" "$DERIVED_MANIFEST_DEST_STATE"; then
    derived_manifest_revoke || true
    return 1
  fi
  [[ -f "$OUT_DIR/manifest.txt" && ! -L "$OUT_DIR/manifest.txt" ]] || {
    derived_manifest_revoke || true
    return 1
  }
}

persist_session_end() {
  # Re-rendering an already-complete bundle is not a new experiment. Preserve
  # its original end time so downtime between runs is not counted as duration.
  if ((SESSION_DID_WORK == 1)) || ! grep -q '^END_EPOCH=' "$META_FILE" 2> /dev/null; then
    meta_set END_EPOCH "$(date +%s)"
    meta_set END_ISO "$(date -Is)"
  fi
}

finalization_fail() {
  DERIVED_FINALIZATION_ERROR="$1"
  if ! derived_generation_abort; then
    bundle_log_fds_close || true
  fi
  if [[ -e "$OUT_DIR/manifest.txt" || -L "$OUT_DIR/manifest.txt" ]]; then
    bundle_log_fds_close || true
  fi
  return 1
}

diagnose_stop_tracked_groups() {
  local stop_rc=0 current_rc=0
  diag_process_group_stop || {
    current_rc=$?
    ((stop_rc == 0)) && stop_rc=$current_rc
  }
  # Close the workload boundary immediately after the workload group stops;
  # the legacy frequency sampler has no boundary clock and can drain second.
  telemetry_segment_stop || {
    current_rc=$?
    ((stop_rc == 0)) && stop_rc=$current_rc
  }
  diag_freq_sampler_stop || {
    current_rc=$?
    ((stop_rc == 0)) && stop_rc=$current_rc
  }
  return "$stop_rc"
}

finalize_report() {
  if [[ -n "${DIAG_WORKLOAD_PID:-}" || -n "${DIAG_SAMPLER_PID:-}" ||
    -n "${DIAG_TELEMETRY_PID:-}" ]]; then
    DERIVED_FINALIZATION_ERROR="tracked writer groups are not confirmed stopped"
    return 1
  fi
  derived_generation_begin || {
    finalization_fail "cannot open a safe derived-output generation"
    return 1
  }
  persist_session_end || {
    finalization_fail "cannot persist the diagnostic end time"
    return 1
  }
  sync_meta_completed || {
    finalization_fail "cannot persist completed phase metadata"
    return 1
  }
  diag_log "finalizing results, report, privacy review, and manifest" || {
    finalization_fail "cannot record finalization progress"
    return 1
  }

  node "$LIB/collect.mjs" "$OUT_DIR" "$DERIVED_RESULTS_CANDIDATE" \
    > /dev/null 2>&1 || {
    finalization_fail "collect.mjs failed before results publication"
    return 1
  }
  derived_owned_single_regular "$DERIVED_RESULTS_CANDIDATE" &&
    derived_candidate_same_device "$DERIVED_RESULTS_CANDIDATE" || {
    finalization_fail "collect.mjs produced an unsafe results candidate"
    return 1
  }
  node "$LIB/report.mjs" "$OUT_DIR" "$DERIVED_RESULTS_CANDIDATE" \
    "$DERIVED_REPORT_CANDIDATE" > /dev/null 2>&1 || {
    finalization_fail "report.mjs failed before report publication"
    return 1
  }
  derived_owned_single_regular "$DERIVED_REPORT_CANDIDATE" &&
    derived_candidate_same_device "$DERIVED_REPORT_CANDIDATE" || {
    finalization_fail "report.mjs produced an unsafe report candidate"
    return 1
  }

  derived_publish_candidate DERIVED_RESULTS_CANDIDATE "$OUT_DIR/results.json" \
    "$DERIVED_RESULTS_DEST_STATE" || {
    finalization_fail "results publication failed"
    return 1
  }
  finalization_checkpoint results-published || {
    finalization_fail "results publication checkpoint failed"
    return 1
  }
  derived_publish_candidate DERIVED_REPORT_CANDIDATE "$OUT_DIR/report.md" \
    "$DERIVED_REPORT_DEST_STATE" || {
    finalization_fail "report publication failed"
    return 1
  }
  finalization_checkpoint report-published || {
    finalization_fail "report publication checkpoint failed"
    return 1
  }

  # No bundled log or metadata write may occur after this point. The privacy
  # review and manifest therefore describe the exact generation that follows.
  bundle_log_fds_close || {
    finalization_fail "cannot close validated bundle log descriptors"
    return 1
  }
  write_privacy_review "$DERIVED_PRIVACY_DEST_STATE" || {
    finalization_fail "privacy sentinel scan failed"
    return 1
  }
  finalization_checkpoint privacy-published || {
    finalization_fail "privacy publication checkpoint failed"
    return 1
  }
  write_manifest || {
    finalization_fail "manifest generation failed"
    return 1
  }
  if ! finalization_checkpoint manifest-published; then
    derived_manifest_revoke || true
    finalization_fail "manifest publication checkpoint failed"
    return 1
  fi
  DERIVED_FINALIZATION_COMPLETE=1
}

complete_diagnostic() {
  # Success is terminal-only and follows the durable readiness token.
  diagnose_stop_tracked_groups ||
    diag_die "tracked process groups could not be confirmed stopped; refusing finalization"
  if ! finalize_report; then
    diag_die "${DERIVED_FINALIZATION_ERROR:-derived finalization failed}"
  fi
  printf '[%s] done. Bundle: %s\n' "$(date '+%H:%M:%S')" "$OUT_DIR"
  printf '[%s] report: %s/report.md\n' "$(date '+%H:%M:%S')" "$OUT_DIR"
}

diagnose_cleanup_exit() {
  local rc="$1" artifact_safe=1 stop_rc=0
  trap - EXIT INT TERM
  diagnose_stop_tracked_groups || stop_rc=$?
  if ((stop_rc != 0)); then
    diag_warn "tracked writer groups remain unconfirmed; retaining bundle authority and skipping all bundle cleanup"
    ((rc == 0)) && rc=$stop_rc
    exit "$rc"
  fi
  if [[ -n "$OUT_DIR" && -d "$OUT_DIR" ]] &&
    ((rc != 0 || DERIVED_FINALIZATION_COMPLETE == 0)); then
    if derived_manifest_revoke; then
      derived_candidate_cleanup_tracked || rc=1
      privacy_review_temp_cleanup || rc=1
    else
      bundle_log_fds_close || true
      artifact_safe=0
      rc=1
    fi
  fi
  ((artifact_safe == 0)) || redo_marker_temp_cleanup
  bundle_log_fds_close || rc=1
  # Children inherit the lock descriptor intentionally. Reap all writers
  # before closing our final descriptor so SIGKILL cannot expose live writes.
  diag_bundle_lock_release || rc=1
  exit "$rc"
}

on_interrupt() {
  local sig="$1" signal_rc=143 stop_rc=0
  [[ "$sig" == SIGINT ]] && signal_rc=130
  trap - EXIT INT TERM
  diagnose_stop_tracked_groups 2> /dev/null || stop_rc=$?
  if ((stop_rc != 0)); then
    diag_warn "received $sig but tracked writer groups remain unconfirmed; skipping all bundle mutation and retaining bundle authority"
    exit "$signal_rc"
  fi
  # The readiness token is the first possible bundle mutation. If it cannot
  # be revoked durably, stop processes with terminal-only diagnostics and do
  # not touch metadata, logs, or pending artifacts behind that token.
  if ! derived_manifest_revoke; then
    bundle_log_fds_close 2> /dev/null || true
    diag_bundle_lock_release 2> /dev/null || true
    echo "error: could not revoke diagnostic readiness after $sig" >&2
    exit "$signal_rc"
  fi
  derived_candidate_cleanup_tracked 2> /dev/null || true
  privacy_review_temp_cleanup 2> /dev/null || true
  redo_marker_temp_cleanup
  meta_set INTERRUPTED 1 2> /dev/null || true
  if [[ -e "$STATE_DIR/redo.pending" || -L "$STATE_DIR/redo.pending" ]]; then
    diag_warn "received $sig while redo archival is pending; skipping a misleading partial report (resume this bundle to recover)"
    exit "$signal_rc"
  fi
  diag_warn "received $sig - stopping frequency sampling and writing a partial report"
  # Best effort: a failed partial report must not mask the interrupt, so
  # the subshell contains diag_die's exit and the failure is swallowed.
  ( finalize_report ) 2> /dev/null || true
  bundle_log_fds_close 2> /dev/null || true
  diag_bundle_lock_release 2> /dev/null || true
  exit "$signal_rc"
}

# ---------------------------------------------------------------------------
# Plan printing (also used by --dry-run)
# ---------------------------------------------------------------------------
print_plan() {
  local ncpus_online cpu_policy i context_cpus
  local concurrent_waves=0 concurrent_child_runs=0 concurrent_peak=0
  ncpus_online="$(diag_cpulist_count "$ONLINE_CPUS")"
  if [[ "$CPU_TARGET" == auto ]]; then
    cpu_policy="auto (worst failing CPU from individual results)"
  else
    cpu_policy="fixed CPU $CPU_TARGET"
  fi
  for ((i = 0; i < ${#CONCURRENT_NAME[@]}; i++)); do
    context_cpus="$(diag_cpulist_count "${CONCURRENT_CPUS[$i]}")"
    concurrent_child_runs=$((concurrent_child_runs + context_cpus * PINNED_CONCURRENT_ROUNDS))
    ((context_cpus <= concurrent_peak)) || concurrent_peak="$context_cpus"
  done
  concurrent_waves=$(( ${#CONCURRENT_NAME[@]} * PINNED_CONCURRENT_ROUNDS ))
  cat << EOF
Resolved configuration:
  mode               $MODE
  out dir            ${OUT_DIR:-diagnostics/<timestamp>}$( [[ -n "$RESUME_DIR" ]] && printf ' (resume)' || true )
  baseline           $BASELINE_CHILDREN children x $BASELINE_WAVES waves (~$((BASELINE_CHILDREN * BASELINE_WAVES)) child runs)
  groups             ${#GROUP_NAME[@]} group(s) x $GROUP_WAVES waves
  individual runs    $INDIVIDUAL_RUNS per CPU ($( [[ "$RUN_SCHEMA_VERSION" == 2 ]] && printf 'all %s usable CPUs, seeded position-balanced order' "$ncpus_online" || printf "failing groups' CPUs, or all %s usable CPUs" "$ncpus_online" ))
  CPU selection      $cpu_policy
  redo phases        ${REDO_PLAN[*]:-none}
  frequency A/B/A    manual step (sudo ./frequency-ab.sh; never automatic)
  gdb capture        $( [[ "$SKIP_GDB" == "1" ]] && printf 'skipped' || printf 'up to %s runs using %s' "$GDB_MAX_RUNS" "$cpu_policy" )
EOF
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    printf '  protocol seed      %s\n' "$PROTOCOL_SEED"
    printf '  telemetry          %s ms interval (descriptive; read-only)\n' "$TELEMETRY_INTERVAL_MS"
    if [[ "$SKIP_PINNED_CONCURRENT" == 1 ]]; then
      printf '  pinned-concurrent  skipped by configuration\n'
    elif [[ -n "$STATE_DIR" ]] && phase_is_done pinned-concurrent &&
      ! phase_redo_is_authorized pinned-concurrent; then
      printf '  pinned-concurrent  already complete in this bundle\n'
    elif pinned_concurrent_unavailable_decision_present &&
      ! phase_redo_is_authorized pinned-concurrent; then
      printf '  pinned-concurrent  terminally unavailable in this bundle (--redo pinned-concurrent required to reassess)\n'
    elif ((${#CONCURRENT_NAME[@]} == 0)); then
      printf '  pinned-concurrent  unavailable (%s)\n' \
        "${PINNED_CONCURRENT_UNAVAILABLE_REASON:-no safe topology context}"
    elif pinned_concurrent_should_run; then
      printf '  pinned-concurrent  %s context(s) x %s rounds (%s waves, ~%s child runs)\n' \
        "${#CONCURRENT_NAME[@]}" "$PINNED_CONCURRENT_ROUNDS" \
        "$concurrent_waves" "$concurrent_child_runs"
    else
      printf '  pinned-concurrent  not scheduled (resume state requires validation)\n'
    fi
  fi
  cat << EOF

Discovered topology:
  online CPUs        $ONLINE_CPUS
  P-cores            ${P_CORES:-none detected}
  E-cores            ${E_CORES:-none detected}
EOF
  for ((i = 0; i < ${#GROUP_NAME[@]}; i++)); do
    printf '  group %-18s cpus=%-10s children=%s\n' \
      "${GROUP_NAME[$i]}" "${GROUP_CPUS[$i]}" "$(group_children "${GROUP_CPUS[$i]}")"
  done
  if pinned_concurrent_should_run; then
    for ((i = 0; i < ${#CONCURRENT_NAME[@]}; i++)); do
      printf '  context %-16s cpus=%-10s controller=%s\n' \
        "${CONCURRENT_NAME[$i]}" "${CONCURRENT_CPUS[$i]}" "${CONCURRENT_CONTROLLER[$i]}"
    done
  fi
  cat << EOF

Rough duration estimate (very approximate, ~6s/wave, ~3s/single run):
  baseline           ~$((BASELINE_WAVES * 6 / 60 + 1)) min
  groups             ~$(( ${#GROUP_NAME[@]} * GROUP_WAVES * 6 / 60 + 1)) min
  individual         ~$(( ncpus_online * INDIVIDUAL_RUNS * 3 / 60 + 1)) min worst case
$(if pinned_concurrent_should_run; then printf '  pinned-concurrent  ~%s min (peak %s concurrent children)\n' "$((concurrent_waves * 6 / 60 + 1))" "$concurrent_peak"; fi)
  frequency A/B/A    ~$(( 3 * INDIVIDUAL_RUNS * 3 / 60 + 1)) min (manual: sudo ./frequency-ab.sh)
  gdb                ~$(( GDB_MAX_RUNS * 40 / 60 + 1)) min worst case
EOF
}

# ---------------------------------------------------------------------------
main() {
  local caller_dir phase_total=7 frequency_phase=5 gdb_phase=6 report_phase=7
  caller_dir="$(pwd -P)"
  pre_pass "$@"

  local requested_out=""
  if ((OUT_DIR_EXPLICIT == 1)); then
    if [[ "$OUT_DIR" == /* ]]; then
      requested_out="$OUT_DIR"
    else
      requested_out="$caller_dir/$OUT_DIR"
    fi
    OUT_DIR="$requested_out"
  fi

  local resume_abs=""
  local fresh_init_recovered=0
  if [[ -n "$RESUME_DIR" ]]; then
    [[ -d "$RESUME_DIR" ]] || diag_die "resume directory '$RESUME_DIR' does not exist"
    resume_abs="$(cd "$RESUME_DIR" && pwd -P)"
    if ((OUT_DIR_EXPLICIT == 1)); then
      [[ -d "$OUT_DIR" ]] ||
        diag_die "--out-dir with --resume must name the same existing bundle"
      local explicit_out_abs
      explicit_out_abs="$(cd "$OUT_DIR" && pwd -P)"
      [[ "$explicit_out_abs" == "$resume_abs" ]] ||
        diag_die "--out-dir and --resume refer to different bundles"
    fi
    RESUME_DIR="$resume_abs"
    OUT_DIR="$resume_abs"
    # Lock before treating stored metadata, redo state, markers, or evidence
    # as authoritative. A resume dry-run also needs one coherent snapshot.
    local resume_lock_rc=0
    diag_bundle_lock_acquire "$OUT_DIR" || resume_lock_rc=$?
    ((resume_lock_rc == 0)) || return "$resume_lock_rc"
    [[ ! -e "$OUT_DIR/.frequency-publish.pending" &&
      ! -L "$OUT_DIR/.frequency-publish.pending" ]] ||
      diag_die "a frequency publication transaction is pending; retry frequency-ab.sh before resuming diagnostics"
    META_FILE="$OUT_DIR/results/meta.env"
    STATE_DIR="$OUT_DIR/state"
    if fresh_init_interrupted_recover; then
      # The bundle only ever reached initialization: it holds no evidence and
      # no resumable state, so continue as a fresh run on the same (now
      # emptied) directory. The fresh path below re-acquires the writer lock
      # and re-verifies emptiness under it before mutating anything.
      fresh_init_recovered=1
      RESUME_DIR=""
      diag_bundle_lock_release ||
        diag_die "cannot release the diagnostics bundle writer lock"
    else
      bundle_mutable_graph_validate
      load_stored_config "$OUT_DIR"
      validate_loaded_schema_artifacts
      # Stored values are already concrete; do not re-apply the mode preset.
    fi
  fi

  parse_args "$@"
  if ((OUT_DIR_EXPLICIT == 1)); then
    OUT_DIR="$requested_out"
  fi
  # parse_args sees the original relative spellings again. Keep the canonical
  # bundle identity resolved above so the later cd cannot retarget a resume.
  if [[ -n "$resume_abs" ]]; then
    RESUME_DIR="$resume_abs"
    OUT_DIR="$resume_abs"
  fi
  # parse_args re-applied --resume from the original argv; a recovered
  # interrupted fresh initialization instead runs fresh on the same directory.
  ((fresh_init_recovered == 0)) || RESUME_DIR=""
  validate_config
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    phase_total=8
    frequency_phase=6
    gdb_phase=7
    report_phase=8
  fi

  # A pending redo is authoritative for its embedded persisted configuration.
  # Read and reconcile it before dependency checks, topology discovery,
  # consent, or any mutation of the resumed bundle.
  if [[ -n "$RESUME_DIR" ]]; then
    reconcile_pending_redo_request
    # A V2 redo record owns the configuration adopted above. Re-run the full
    # validator so no future persisted field can bypass the ordinary contract.
    validate_config
  fi

  # Work from the repository root regardless of the caller's CWD.
  cd "$SCRIPT_DIR"
  [[ -f repro.mjs && -f child.mjs ]] ||
    diag_die "repro.mjs/child.mjs not found; run from the repository checkout"

  require_dependencies

  discover_topology

  if [[ -n "$WORST_CPU_OVERRIDE" ]] && ! diag_cpulist_contains "$ONLINE_CPUS" "$WORST_CPU_OVERRIDE"; then
    if [[ -n "$RESUME_DIR" ]] && [[ -e "$STATE_DIR/redo.pending" || -L "$STATE_DIR/redo.pending" ]]; then
      PENDING_CPU_TARGET_UNAVAILABLE=1
    else
      diag_die "configured CPU target $WORST_CPU_OVERRIDE is not in the usable CPU set ($ONLINE_CPUS); resume using --cpu auto"
    fi
  fi
  validate_completed_phase_overrides

  if [[ -z "$OUT_DIR" ]]; then
    OUT_DIR="diagnostics/$(date -u +%Y-%m-%dT%H%M%SZ)"
  fi
  if [[ -z "$RESUME_DIR" && "$fresh_init_recovered" == 0 && -e "$OUT_DIR" ]]; then
    [[ -d "$OUT_DIR" ]] || diag_die "output path '$OUT_DIR' exists and is not a directory"
    if find "$OUT_DIR" -mindepth 1 -print -quit | grep -q .; then
      diag_die "output directory '$OUT_DIR' is not empty; use --resume to continue that bundle"
    fi
  fi

  if ((DRY_RUN == 1)); then
    print_plan
    if [[ ! -d node_modules/@electric-sql/pglite ]]; then
      diag_warn "node_modules/@electric-sql/pglite missing; run 'npm ci' first"
    fi
    exit 0
  fi

  [[ -d node_modules/@electric-sql/pglite ]] ||
    diag_die "dependencies not installed; run 'npm ci' first"

  # Consent must precede every bundle mutation, especially redo archival and
  # metadata rewrites on an existing bundle.
  safety_gate
  resolve_protocol_seed
  print_plan

  if [[ -z "$RESUME_DIR" ]]; then
    # Only create the bundle root before locking. Recheck emptiness under the
    # lock so concurrent fresh writers cannot both initialize one directory.
    mkdir -p "$OUT_DIR"
    OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
    local fresh_lock_rc=0
    diag_bundle_lock_acquire "$OUT_DIR" || fresh_lock_rc=$?
    ((fresh_lock_rc == 0)) || return "$fresh_lock_rc"
    if find "$OUT_DIR" -mindepth 1 -print -quit | grep -q .; then
      diag_die "output directory '$OUT_DIR' became non-empty before initialization; use --resume to continue that bundle"
    fi
  fi
  # From this point onward the run may mutate commands, metadata, redo state,
  # logs, and phase evidence. Revoke the sole readiness token first while
  # bundled logging is still disabled, then recover only validated stranded
  # candidates from a prior killed finalization.
  if ! derived_run_open; then
    DIAG_LOG_FILE=""
    diag_die "cannot revoke diagnostic readiness or recover derived candidates"
  fi
  local output_relative
  for output_relative in results logs state env freq gdb logs/individual; do
    bundle_prepare_dir "$output_relative" ||
      diag_die "cannot prepare safe bundle directory '$output_relative'"
  done
  DIAG_BUNDLE_ROOT="$OUT_DIR"
  DIAG_REPO_ROOT="$SCRIPT_DIR"
  META_FILE="$OUT_DIR/results/meta.env"
  STATE_DIR="$OUT_DIR/state"
  DIAG_FREQ_DIR="$OUT_DIR/freq"

  trap 'diagnose_cleanup_exit $?' EXIT
  trap 'on_interrupt SIGINT' INT
  trap 'on_interrupt SIGTERM' TERM

  prepare_run_log "$OUT_DIR/run.log"
  DIAG_COMMANDS_LOG="$OUT_DIR/commands.log"
  prepare_commands_log

  if [[ -z "$RESUME_DIR" ]]; then
    bundle_create_empty_exclusive "$META_FILE" 0644 ||
      diag_die "cannot safely create run metadata"
    {
      printf 'MODE=%s\n' "$MODE"
      printf 'RUN_SCHEMA_VERSION=%s\n' "$RUN_SCHEMA_VERSION"
      printf 'START_EPOCH=%s\n' "$(date +%s)"
      printf 'START_ISO=%s\n' "$(date -Is)"
      printf 'BASELINE_CHILDREN=%s\n' "$BASELINE_CHILDREN"
      printf 'BASELINE_WAVES=%s\n' "$BASELINE_WAVES"
      printf 'GROUP_WAVES=%s\n' "$GROUP_WAVES"
      printf 'INDIVIDUAL_RUNS=%s\n' "$INDIVIDUAL_RUNS"
      printf 'PINNED_CONCURRENT_ROUNDS=%s\n' "$PINNED_CONCURRENT_ROUNDS"
      printf 'PROTOCOL_SEED=%s\n' "$PROTOCOL_SEED"
      printf 'SKIP_PINNED_CONCURRENT=%s\n' "$SKIP_PINNED_CONCURRENT"
      printf 'TELEMETRY_INTERVAL_MS=%s\n' "$TELEMETRY_INTERVAL_MS"
      printf 'GDB_MAX_RUNS=%s\n' "$GDB_MAX_RUNS"
      printf 'SKIP_GDB=%s\n' "$SKIP_GDB"
      printf 'CPU_TARGET=%s\n' "$CPU_TARGET"
      printf 'INTERRUPTED=0\n'
    } >> "$META_FILE"
  fi
  # Stored configuration seeds resume defaults, but explicit CLI overrides
  # describe the run that is about to execute and must be reflected in JSON.
  # A redo publishes its V2 target before changing config or evidence, then
  # commits config with completion metadata after all archive moves. Ordinary
  # resume overrides use the same atomic metadata rewrite without a marker.
  recover_pending_redo
  if ((PENDING_CPU_TARGET_UNAVAILABLE == 1)); then
    diag_die "pending redo recovered, but configured CPU target $CPU_TARGET is not usable ($ONLINE_CPUS); resume using --cpu auto"
  fi
  if ((REDO_RECOVERED_PENDING == 0)); then
    if ((${#REDO_PLAN[@]} > 0)); then
      apply_redo_plan
    else
      persist_effective_config
    fi
  fi

  # ---- phase 1 ----
  if phase_is_done preflight; then
    preflight_evidence_is_complete --validate-complete ||
      diag_die "completed preflight phase has missing, stale, or invalid evidence; preserve it and resume with --redo preflight"
    diag_log "phase 1/$phase_total preflight: already done, skipping (resume)"
  else
    diag_log "phase 1/$phase_total: preflight and environment collection"
    phase_preflight
  fi

  # ---- phase 2 ----
  if phase_is_done baseline; then
    baseline_evidence_is_complete ||
      diag_die "completed baseline phase has missing or invalid evidence; preserve it and resume with --redo baseline"
    diag_log "phase 2/$phase_total baseline: already done, skipping (resume)"
  else
    diag_log "phase 2/$phase_total: baseline reproduction"
    phase_baseline
  fi

  # ---- phase 3 ----
  if phase_is_done groups; then
    groups_evidence_is_complete ||
      diag_die "completed groups phase has missing, stale, or invalid evidence; preserve it and resume with --redo groups"
    diag_log "phase 3/$phase_total groups: already done, skipping (resume)"
  else
    diag_log "phase 3/$phase_total: CPU-group isolation (${#GROUP_NAME[@]} groups x $GROUP_WAVES waves)"
    phase_groups
  fi

  # ---- phase 4 ----
  # Resolve the expected policy even for a completed phase. This binds a
  # resumed individual result to the validated group generation that selected
  # its CPUs instead of accepting a self-consistent but unrelated result.
  local individual_should_run=0
  if compute_individual_targets; then
    individual_should_run=1
  fi
  if phase_is_done individual; then
    individual_phase_is_complete_and_matches_expected "$individual_should_run" ||
      diag_die "completed individual phase does not match the validated group target policy; preserve it and resume with --redo individual"
    diag_log "phase 4/$phase_total individual: already done, skipping (resume)"
  else
    if ((individual_should_run == 1)); then
      diag_log "phase 4/$phase_total: individual CPU isolation (cpus $INDIVIDUAL_TARGET_CPUS, $INDIVIDUAL_RUNS runs each)"
      if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
        phase_individual_v6
      else
        phase_individual
      fi
    else
      diag_log "phase 4/$phase_total: no failing group in quick mode; skipping individual tests"
      phase_individual_skipped
    fi
  fi

  # ---- schema-2 phase 5 ----
  # This phase is deliberately absent from legacy bundles. A configured skip
  # remains explicit and marker-free; an interrupted attempt must be archived
  # with --redo instead of being silently relabelled as skipped. A
  # topology-unavailable decision
  # is instead recorded in its own source-group-bound terminal envelope so
  # companion publishers and later report-only resumes cannot accidentally
  # turn it into a new workload when the usable topology changes.
  if [[ "$RUN_SCHEMA_VERSION" == 2 ]]; then
    if phase_is_done pinned-concurrent; then
      ! pinned_concurrent_unavailable_decision_present ||
        diag_die "completed pinned-concurrent evidence conflicts with a terminal-unavailable decision; preserve both and use --redo pinned-concurrent"
      [[ "$SKIP_PINNED_CONCURRENT" == 0 && ${#CONCURRENT_NAME[@]} -gt 0 ]] ||
        diag_die "completed pinned-concurrent evidence conflicts with the stored skip/topology state; preserve it and use --redo pinned-concurrent"
      pinned_concurrent_evidence_is_complete ||
        diag_die "completed pinned-concurrent phase has missing, stale, or invalid evidence; preserve it and resume with --redo pinned-concurrent"
      diag_log "phase 5/$phase_total pinned-concurrent: already done, skipping (resume)"
    elif pinned_concurrent_unavailable_decision_present; then
      [[ "$SKIP_PINNED_CONCURRENT" == 0 ]] ||
        diag_die "pinned-concurrent terminal-unavailable evidence conflicts with the stored explicit skip; preserve it and use --redo pinned-concurrent"
      ! phase_redo_is_authorized pinned-concurrent ||
        diag_die "pinned-concurrent redo left its terminal-unavailable decision in place; retry --redo pinned-concurrent"
      ! pinned_concurrent_workload_attempt_is_meaningful ||
        diag_die "pinned-concurrent terminal-unavailable evidence conflicts with workload artifacts; preserve them and use --redo pinned-concurrent"
      pinned_concurrent_unavailable_state_read ||
        diag_die "pinned-concurrent terminal-unavailable evidence is unsafe or disagrees with its source groups; preserve it and use --redo pinned-concurrent"
      if [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" == recoverable ]]; then
        pinned_concurrent_unavailable_publish ||
          diag_die "cannot recover the pinned-concurrent terminal-unavailable publication"
      fi
      [[ "$PINNED_CONCURRENT_UNAVAILABLE_STATE" == complete ]] ||
        diag_die "pinned-concurrent terminal-unavailable evidence is not complete"
      diag_warn "phase 5/$phase_total: pinned-concurrent remains unavailable by its recorded terminal decision (use --redo pinned-concurrent to request a new topology assessment)"
    elif [[ "$SKIP_PINNED_CONCURRENT" == 1 ]]; then
      pinned_concurrent_attempt_is_meaningful &&
        diag_die "an incomplete pinned-concurrent attempt exists; archive it with --redo pinned-concurrent before applying --skip-pinned-concurrent"
      diag_log "phase 5/$phase_total: pinned-concurrent explicitly skipped"
    elif ((${#CONCURRENT_NAME[@]} == 0)); then
      pinned_concurrent_attempt_is_meaningful &&
        diag_die "an incomplete pinned-concurrent attempt no longer matches usable topology; preserve it and use --redo pinned-concurrent"
      pinned_concurrent_unavailable_publish ||
        diag_die "cannot publish the source-group-bound pinned-concurrent unavailable decision"
      diag_warn "phase 5/$phase_total: pinned-concurrent unavailable: ${PINNED_CONCURRENT_UNAVAILABLE_REASON:-no safe topology context}"
    elif pinned_concurrent_should_run; then
      diag_log "phase 5/$phase_total: pinned-concurrent topology contexts (${#CONCURRENT_NAME[@]} contexts x $PINNED_CONCURRENT_ROUNDS rounds)"
      phase_pinned_concurrent
    else
      diag_die "pinned-concurrent execution decision is internally inconsistent"
    fi
  fi

  # Determine the CPU for the manual frequency and GDB phases.
  local target_cpu=""
  if [[ -n "$WORST_CPU_OVERRIDE" ]]; then
    target_cpu="$WORST_CPU_OVERRIDE"
  else
    target_cpu="$(worst_cpu)"
  fi
  if [[ -n "$target_cpu" ]] && ! diag_cpulist_contains "$ONLINE_CPUS" "$target_cpu"; then
    diag_die "resolved automatic worst CPU $target_cpu is not in the usable CPU set ($ONLINE_CPUS); resume using --cpu auto after redoing individual evidence"
  fi

  # ---- manual frequency phase (see frequency-ab.sh) ----
  if phase_is_done frequency; then
    frequency_result_is_complete "$target_cpu" --complete ||
      diag_die "completed frequency evidence is invalid or inconsistent; resume with --redo frequency"
    diag_log "phase $frequency_phase/$phase_total frequency: already done, skipping (resume)"
  elif frequency_result_is_complete "$target_cpu"; then
    diag_log "phase $frequency_phase/$phase_total: results from a manual frequency-ab.sh run found; incorporating"
    mark_done frequency
  elif [[ -z "$target_cpu" ]]; then
    diag_warn "phase $frequency_phase/$phase_total: no failing CPU identified; skipping frequency A/B/A"
  else
    diag_log "phase $frequency_phase/$phase_total: frequency A/B/A (manual step, run with sudo)"
    phase_frequency "$target_cpu"
  fi

  # ---- GDB phase ----
  if phase_is_done gdb; then
    gdb_completed_resume_gate
    diag_log "phase $gdb_phase/$phase_total gdb: already done, skipping (resume)"
  else
    diag_log "phase $gdb_phase/$phase_total: GDB fault-signature capture"
    phase_gdb_dispatch "$target_cpu"
  fi

  # ---- report phase ----
  diag_log "phase $report_phase/$phase_total: statistics, report, manifest"
  # A run that reaches here completed fully; clear any interrupted flag
  # left over from a previous, interrupted attempt on this bundle.
  meta_set INTERRUPTED 0
  complete_diagnostic
}

# Allow tests to source this file for individual functions without running.
if [[ "${DIAG_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
