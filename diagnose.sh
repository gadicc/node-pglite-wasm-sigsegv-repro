#!/usr/bin/env bash
# diagnose.sh - from-zero diagnostic runner for the concurrent-PGlite
# SIGSEGV reproduction.
#
# Phases:
#   1 preflight   read-only environment collection (sanitized)
#   2 baseline    concurrent reproduction, STOP_ON_FAILURE=0
#   3 groups      CPU-group isolation (topology discovered from sysfs)
#   4 individual  per-CPU single-child runs
#   5 frequency   manual step only (see frequency-ab.sh; never automatic)
#   6 gdb         pristine fault-signature capture on the worst CPU
#   7 report      statistics, conclusions, manifest
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
# shellcheck source=diagnose-lib/common.sh
source "$LIB/common.sh"

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
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
GDB_MAX_CAPTURES=3
OUT_DIR=""
OUT_DIR_EXPLICIT=0
RESUME_DIR=""
SKIP_GDB=0
DRY_RUN=0
ASSUME_YES=0
REDO_PHASES=""
declare -a REDO_PLAN=()
REDO_MARKER_TEMP=""
REDO_TXN_ID=""
declare -a REDO_TXN_PHASES=()
declare -a REDO_TXN_OWNERS=()
declare -a REDO_TXN_PATHS=()
WORST_CPU_OVERRIDE=""
SESSION_DID_WORK=0
MODE_EXPLICIT=0
GROUP_WAVES_EXPLICIT=0
INDIVIDUAL_RUNS_EXPLICIT=0
GDB_MAX_RUNS_EXPLICIT=0
SKIP_GDB_EXPLICIT=0
SKIP_GDB_FLAG_SEEN=0
RUN_GDB_FLAG_SEEN=0
CPU_EXPLICIT=0
REQUIRED_COMMANDS=(
  awk basename bash cat cut date dirname find grep head mkdir mktemp mv node
  nproc paste readlink rm sed setsid sha256sum sleep sort sync tail taskset tee timeout
  touch tr uniq wc xargs
)

usage() {
  cat << 'EOF'
Usage: ./diagnose.sh [options]

Modes (pick at most one):
  --quick               short run: 8x10 baseline, 10 group waves,
                        5 individual runs, 6 gdb runs
  --full                long run: 16x100 baseline, 100 group waves,
                        100 individual runs on every online CPU, 24 gdb runs
  (default)             16x50 baseline, 50 group waves, 50 individual runs,
                        12 gdb runs
                        (50 clean runs exclude per-run rates above ~5.8%)

Options:
  --resume DIR          resume an interrupted run, skipping completed phases
                        (also regenerates the report, e.g. after running
                        root-checks.sh or frequency-ab.sh manually)
  --redo PHASES         with --resume: re-run phase(s) from scratch
                        (comma-separated: baseline,groups,individual,gdb,
                        frequency). Old data is preserved under
                        state/superseded/, never deleted.
  --out-dir DIR         output directory (default: diagnostics/<UTC timestamp>)
  --skip-gdb            skip the GDB capture phase
  --run-gdb             run GDB even when a resumed bundle stored --skip-gdb
  --individual-runs N   runs per CPU (overrides mode default)
  --group-waves N       waves per CPU group (overrides mode default)
  --gdb-max-runs N      max gdb attempts (overrides mode default)
  --cpu N               force the CPU suggested for the gdb phase and for
                        the frequency-ab.sh hint
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
      GDB_MAX_RUNS=6
      ;;
    full)
      BASELINE_CHILDREN=16
      BASELINE_WAVES=100
      GROUP_WAVES=100
      INDIVIDUAL_RUNS=100
      GDB_MAX_RUNS=24
      ;;
    default) : ;;
    *) diag_die "unknown mode '$MODE'" ;;
  esac
}

load_stored_config() {
  local meta="$1/results/meta.env"
  [[ -f "$meta" ]] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      MODE) MODE="$v" ;;
      BASELINE_CHILDREN) BASELINE_CHILDREN="$v" ;;
      BASELINE_WAVES) BASELINE_WAVES="$v" ;;
      GROUP_WAVES) GROUP_WAVES="$v" ;;
      INDIVIDUAL_RUNS) INDIVIDUAL_RUNS="$v" ;;
      GDB_MAX_RUNS) GDB_MAX_RUNS="$v" ;;
      SKIP_GDB) SKIP_GDB="$v" ;;
    esac
  done < "$meta"
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
      --resume | --out-dir | --redo | --individual-runs | --group-waves | --gdb-max-runs | --cpu)
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
      --group-waves) GROUP_WAVES="${2:?}"; GROUP_WAVES_EXPLICIT=1; shift 2 ;;
      --gdb-max-runs) GDB_MAX_RUNS="${2:?}"; GDB_MAX_RUNS_EXPLICIT=1; shift 2 ;;
      --cpu) WORST_CPU_OVERRIDE="${2:?}"; CPU_EXPLICIT=1; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) diag_die "unknown option '$1' (see --help)" ;;
    esac
  done
  ((SKIP_GDB_FLAG_SEEN == 0 || RUN_GDB_FLAG_SEEN == 0)) ||
    diag_die "--skip-gdb and --run-gdb conflict; pick one"
}

validate_config() {
  case "$MODE" in
    default | quick | full) ;;
    *) diag_die "stored mode must be default, quick, or full, got '$MODE'" ;;
  esac
  diag_require_uint "--individual-runs" "$INDIVIDUAL_RUNS"
  diag_require_uint "--group-waves" "$GROUP_WAVES"
  diag_require_uint "--gdb-max-runs" "$GDB_MAX_RUNS"
  diag_require_uint "baseline children" "$BASELINE_CHILDREN"
  diag_require_uint "baseline waves" "$BASELINE_WAVES"
  [[ "$SKIP_GDB" == "0" || "$SKIP_GDB" == "1" ]] ||
    diag_die "stored SKIP_GDB must be 0 or 1, got '$SKIP_GDB'"
  ((INDIVIDUAL_RUNS >= 1 && GROUP_WAVES >= 1 && GDB_MAX_RUNS >= 1 && BASELINE_CHILDREN >= 1 && BASELINE_WAVES >= 1)) ||
    diag_die "runs, waves, children, and gdb attempts must all be >= 1"
  if [[ -n "$WORST_CPU_OVERRIDE" ]]; then
    diag_require_uint "--cpu" "$WORST_CPU_OVERRIDE"
  fi
  if [[ -n "$REDO_PHASES" && -z "$RESUME_DIR" ]]; then
    diag_die "--redo requires --resume DIR (it re-runs phases of an existing bundle)"
  fi
  build_redo_plan
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

meta_set() {
  local k="$1" v="$2"
  if [[ -f "$META_FILE" ]] && grep -q "^${k}=" "$META_FILE"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$META_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$META_FILE"
  fi
}

mark_done() {
  touch "$STATE_DIR/phase-$1.done"
  SESSION_DID_WORK=1
  sync_meta_completed
}

phase_is_done() {
  [[ -f "$STATE_DIR/phase-$1.done" ]]
}

sync_meta_completed() {
  local list=""
  local f
  for f in "$STATE_DIR"/phase-*.done; do
    [[ -e "$f" ]] || continue
    f="${f##*/phase-}"
    f="${f%.done}"
    list="${list:+$list,}$f"
  done
  meta_set COMPLETED_PHASES "$list"
}

persist_effective_config() {
  meta_set MODE "$MODE"
  meta_set BASELINE_CHILDREN "$BASELINE_CHILDREN"
  meta_set BASELINE_WAVES "$BASELINE_WAVES"
  meta_set GROUP_WAVES "$GROUP_WAVES"
  meta_set INDIVIDUAL_RUNS "$INDIVIDUAL_RUNS"
  meta_set GDB_MAX_RUNS "$GDB_MAX_RUNS"
  meta_set SKIP_GDB "$SKIP_GDB"
}

redo_plan_contains() {
  local wanted="$1" phase
  for phase in "${REDO_PLAN[@]}"; do
    [[ "$phase" == "$wanted" ]] && return 0
  done
  return 1
}

metadata_value() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" 2> /dev/null | tail -1
}

require_redo_for_completed_change() {
  local phase="$1" description="$2"
  [[ -f "$OUT_DIR/state/phase-$phase.done" ]] || return 0
  redo_plan_contains "$phase" && return 0
  diag_die "$description changes completed $phase evidence; resume with --redo $phase"
}

validate_completed_phase_overrides() {
  [[ -n "$RESUME_DIR" ]] || return 0
  local meta="$OUT_DIR/results/meta.env" stored

  if ((MODE_EXPLICIT == 1)); then
    stored="$(metadata_value "$meta" MODE)"
    if [[ "$stored" != "$MODE" ]]; then
      local phase
      for phase in baseline groups individual gdb; do
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
  if ((CPU_EXPLICIT == 1)); then
    stored="$(metadata_value "$OUT_DIR/results/gdb.meta" CPU)"
    [[ -z "$stored" || "$stored" == "$WORST_CPU_OVERRIDE" ]] ||
      require_redo_for_completed_change gdb "changing --cpu from $stored to $WORST_CPU_OVERRIDE"
    stored="$(metadata_value "$OUT_DIR/results/frequency-ab.meta" CPU)"
    [[ -z "$stored" || "$stored" == "$WORST_CPU_OVERRIDE" ]] ||
      require_redo_for_completed_change frequency "changing --cpu from $stored to $WORST_CPU_OVERRIDE"
  fi
}

prepare_commands_log() {
  if [[ -n "$RESUME_DIR" && -f "$DIAG_COMMANDS_LOG" ]]; then
    printf '\n# resumed %s\n' "$(date -Is)" >> "$DIAG_COMMANDS_LOG"
  else
    : > "$DIAG_COMMANDS_LOG"
  fi
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
      baseline | groups | individual | gdb | frequency) ;;
      *)
        diag_die "--redo: unknown or unsupported phase '$phase' (supported: baseline,groups,individual,gdb,frequency)"
        ;;
    esac
    [[ -z "${seen[$phase]:-}" ]] || diag_die "--redo phase '$phase' was listed more than once"
    seen[$phase]=1
    wanted[$phase]=1
  done

  # Group results choose the CPUs tested individually; individual results in
  # turn choose the CPU used by the manual frequency and GDB phases. Repeating
  # an upstream phase therefore invalidates every completed dependent phase.
  if [[ -n "${wanted[groups]:-}" ]]; then
    wanted[individual]=1
  fi
  if [[ -n "${wanted[individual]:-}" ]]; then
    wanted[frequency]=1
    wanted[gdb]=1
  fi

  # Always execute the closure in dependency order, independent of the order
  # used on the command line.
  for phase in baseline groups individual frequency gdb; do
    [[ -n "${wanted[$phase]:-}" ]] && REDO_PLAN+=("$phase")
  done
}

redo_phase_supported() {
  case "$1" in baseline | groups | individual | frequency | gdb) return 0 ;; esac
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
    baseline:results/baseline.meta|baseline:logs/baseline|baseline:freq/baseline.samples|baseline:freq/baseline.method|groups:results/groups.tsv|groups:logs/groups|individual:results/individual.tsv|individual:results/individual.meta|individual:logs/individual|gdb:results/gdb.meta|gdb:gdb|gdb:logs/gdb|frequency:results/frequency-ab.tsv|frequency:results/frequency-ab.meta|frequency:results/frequency-cap.tsv|frequency:results/frequency-cap.meta) return 0 ;;
  esac
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
  return 1
}

redo_derived_path_is_allowed() {
  case "$1" in results.json | report.md | privacy-review.txt | manifest.txt) return 0 ;; esac
  return 1
}

# Parse pending redo state strictly as data. Never source this user-owned file.
redo_transaction_validate() {
  local marker="$1" line kind owner path version="" txn="" last_rank=0 rank section=version
  local -A phases=() records=()
  REDO_TXN_ID=""
  REDO_TXN_PHASES=()
  REDO_TXN_OWNERS=()
  REDO_TXN_PATHS=()
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    IFS=$'\t' read -r kind owner path <<< "$line"
    case "$kind" in
      VERSION)
        [[ "$section" == version && "$line" == "VERSION"$'\t'"$owner" && "$owner" == 1 ]] || return 1
        version=1
        section=txn
        ;;
      TXN)
        [[ "$section" == txn && "$line" == "TXN"$'\t'"$owner" &&
          "$owner" =~ ^redo-[0-9]{8}T[0-9]{6}-[A-Za-z0-9]+$ ]] || return 1
        txn="$owner"
        section=phases
        ;;
      PHASE)
        [[ "$section" == phases && "$line" == "PHASE"$'\t'"$owner" ]] || return 1
        redo_phase_supported "$owner" && [[ -z "${phases[$owner]:-}" ]] || return 1
        case "$owner" in baseline) rank=1 ;; groups) rank=2 ;; individual) rank=3 ;; frequency) rank=4 ;; gdb) rank=5 ;; esac
        ((rank > last_rank)) || return 1
        last_rank=$rank
        phases[$owner]=1
        REDO_TXN_PHASES+=("$owner")
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
  [[ "$version" == 1 && -n "$txn" && ${#REDO_TXN_PHASES[@]} -gt 0 ]] || return 1
  local phase
  for phase in "${REDO_TXN_OWNERS[@]}"; do
    [[ "$phase" == derived || -n "${phases[$phase]:-}" ]] || return 1
  done
  if [[ -n "${phases[groups]:-}" ]]; then
    [[ -n "${phases[individual]:-}" && -n "${phases[frequency]:-}" && -n "${phases[gdb]:-}" ]] || return 1
  fi
  if [[ -n "${phases[individual]:-}" ]]; then
    [[ -n "${phases[frequency]:-}" && -n "${phases[gdb]:-}" ]] || return 1
  fi
  REDO_TXN_ID="$txn"
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

redo_transaction_execute() {
  local marker="$STATE_DIR/redo.pending"
  redo_transaction_validate "$marker" || diag_die "pending redo transaction is malformed; refusing bundle mutation"
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
    ((source_exists + dest_exists == 1)) ||
      diag_die "pending redo has conflicting or missing source/archive state for ${REDO_TXN_PATHS[$i]}"
  done

  # Invalidate the complete dependency closure before the first evidence move.
  for phase in "${REDO_TXN_PHASES[@]}"; do
    rm -f -- "$STATE_DIR/phase-$phase.done" ||
      diag_die "pending redo could not invalidate phase $phase"
    [[ ! -e "$STATE_DIR/phase-$phase.done" && ! -L "$STATE_DIR/phase-$phase.done" ]] ||
      diag_die "pending redo could not invalidate phase $phase"
  done
  sync_meta_completed || diag_die "pending redo could not synchronize completed phases"
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
    else
      diag_die "pending redo has conflicting or missing source/archive state for ${REDO_TXN_PATHS[$i]}"
    fi
  done
  rm -f -- "$marker" || diag_die "pending redo completed but its transaction marker could not be removed"
  diag_log "--redo: previous evidence preserved under ${stash#"$OUT_DIR"/}; phases ${REDO_TXN_PHASES[*]} will run fresh"
}

redo_record_if_present() {
  local kind="$1" owner="$2" path="$3"
  [[ -e "$OUT_DIR/$path" || -L "$OUT_DIR/$path" ]] || return 0
  redo_source_parent_is_safe "$path" || diag_die "--redo source parent is unsafe for $path"
  printf '%s\t%s\t%s\n' "$kind" "$owner" "$path"
}

apply_redo_plan() {
  ((${#REDO_PLAN[@]} > 0)) || return 0
  local pending="$STATE_DIR/redo.pending"
  [[ ! -e "$pending" && ! -L "$pending" ]] || diag_die "a pending redo transaction must be recovered before starting another"
  REDO_MARKER_TEMP="$(mktemp "$STATE_DIR/.redo.pending.XXXXXX")" || diag_die "cannot prepare redo transaction"
  local txn="redo-$(date +%Y%m%dT%H%M%S)-${REDO_MARKER_TEMP##*.}" phase path artifact
  {
    printf 'VERSION\t1\nTXN\t%s\n' "$txn"
    for phase in "${REDO_PLAN[@]}"; do printf 'PHASE\t%s\n' "$phase"; done
    for path in results.json report.md privacy-review.txt manifest.txt; do
      redo_record_if_present DERIVED - "$path"
    done
    for phase in "${REDO_PLAN[@]}"; do
      local -a paths=()
      case "$phase" in
        baseline) paths=(results/baseline.meta logs/baseline freq/baseline.samples freq/baseline.method) ;;
        groups) paths=(results/groups.tsv logs/groups) ;;
        individual) paths=(results/individual.tsv results/individual.meta logs/individual) ;;
        frequency) paths=(results/frequency-ab.tsv results/frequency-ab.meta results/frequency-cap.tsv results/frequency-cap.meta) ;;
        gdb) paths=(results/gdb.meta gdb logs/gdb) ;;
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
      fi
      for path in "${paths[@]}"; do redo_record_if_present ARTIFACT "$phase" "$path"; done
    done
  } > "$REDO_MARKER_TEMP" || diag_die "cannot write redo transaction"
  chmod 0600 "$REDO_MARKER_TEMP" || diag_die "cannot protect redo transaction"
  redo_transaction_validate "$REDO_MARKER_TEMP" || diag_die "generated redo transaction failed validation"
  mv -nT -- "$REDO_MARKER_TEMP" "$pending" || diag_die "cannot publish redo transaction"
  [[ ! -e "$REDO_MARKER_TEMP" ]] || diag_die "another redo transaction appeared concurrently"
  REDO_MARKER_TEMP=""
  redo_transaction_execute
}

recover_pending_redo() {
  local pending="$STATE_DIR/redo.pending"
  [[ -e "$pending" || -L "$pending" ]] || return 0
  diag_log "recovering interrupted redo transaction before phase execution"
  redo_transaction_execute
}

redo_marker_temp_cleanup() {
  [[ -n "$REDO_MARKER_TEMP" ]] || return 0
  case "$REDO_MARKER_TEMP" in "$STATE_DIR"/.redo.pending.*) rm -f -- "$REDO_MARKER_TEMP" ;; esac
  REDO_MARKER_TEMP=""
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

add_group() {
  GROUP_NAME+=("$1")
  GROUP_KIND+=("$2")
  GROUP_CPUS+=("$3")
  GROUP_CLUSTER+=("$4")
}

# unique sorted cpu list from stdin expansion of $1
cpu_list_sorted() {
  diag_cpulist_expand "$1" | sort -n | uniq
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

  if [[ -n "$P_CORES" ]]; then
    add_group "pcores" "pcore" "$P_CORES" "-"
  fi
  if [[ -n "$E_CORES" ]]; then
    add_group "ecores" "ecore" "$E_CORES" "-"
    # Individual E-core clusters by topology/cluster_id (fallback: shared L2).
    declare -A cluster_map=()
    local cpu cid
    while read -r cpu; do
      cid="-"
      if [[ -r "/sys/devices/system/cpu/cpu${cpu}/topology/cluster_id" ]]; then
        cid="$(cat "/sys/devices/system/cpu/cpu${cpu}/topology/cluster_id")"
      elif [[ -r "/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list" ]]; then
        cid="l2:$(cat "/sys/devices/system/cpu/cpu${cpu}/cache/index2/shared_cpu_list")"
      fi
      cluster_map[$cid]="${cluster_map[$cid]:+${cluster_map[$cid]},}$cpu"
    done < <(cpu_list_sorted "$E_CORES")
    local cid_key cpus
    while read -r cid_key; do
      [[ -n "$cid_key" ]] || continue
      cpus="$(cpu_list_sorted "${cluster_map[$cid_key]}" | diag_cpulist_compress)"
      add_group "ecluster-${cid_key}" "ecluster" "$cpus" "$cid_key"
    done < <(printf '%s\n' "${!cluster_map[@]}" | sort -n)
  fi
  if [[ -z "$P_CORES" && -z "$E_CORES" ]]; then
    add_group "all-cpus" "uniform" "$ONLINE_CPUS" "-"
  fi
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

run_gdb_logged() {
  local cpu="$1" max_runs="$2" max_captures="$3" out_dir="$4" logf="$5"
  diag_process_group_start bash -c '
    repo=$1 cpu=$2 max_runs=$3 max_captures=$4 out_dir=$5 logf=$6 operational_rc=$7
    cd "$repo" || exit "$operational_rc"
    bash capture-fault.sh "$cpu" "$max_runs" "$max_captures" "$out_dir" 2>&1 |
      tee "$logf"
    statuses=("${PIPESTATUS[@]}")
    ((statuses[1] == 0)) || exit "$operational_rc"
    exit "${statuses[0]}"
  ' diag-gdb "$SCRIPT_DIR" "$cpu" "$max_runs" "$max_captures" "$out_dir" "$logf" \
    "$DIAG_OPERATIONAL_ERROR_RC" || return "$DIAG_OPERATIONAL_ERROR_RC"
  diag_process_group_wait
}

repro_result_is_complete() {
  local logf="$1" expected_waves="$2" rc="$3"
  [[ "$rc" == "0" || "$rc" == "1" ]] || return 1
  awk -v expected="$expected_waves" '
    {
      sub(/^[0-9]+\t/, "")
      if ($0 ~ "^failedWaves=[0-9]+ completedWaves=" expected " requestedWaves=" expected "$") complete=1
    }
    END { exit complete ? 0 : 1 }
  ' "$logf"
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
phase_preflight() {
  local env_dir="$OUT_DIR/env"
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

  mark_done preflight
  diag_log "preflight complete: $env_dir"
}

# ------------------------------------------------------------------
phase_baseline() {
  local logf="logs/baseline/run1.log"
  diag_log "baseline: $BASELINE_CHILDREN children x $BASELINE_WAVES waves, STOP_ON_FAILURE=0"
  diag_freq_sampler_start baseline
  run_repro_logged "$OUT_DIR/$logf" "-" "$BASELINE_CHILDREN" "$BASELINE_WAVES"
  diag_freq_sampler_stop
  {
    printf 'CHILDREN=%s\n' "$BASELINE_CHILDREN"
    printf 'WAVES=%s\n' "$BASELINE_WAVES"
    printf 'LOG=%s\n' "$logf"
    printf 'EXIT_CODE=%s\n' "$REPRO_RC"
  } > "$OUT_DIR/results/baseline.meta"
  repro_result_is_complete "$OUT_DIR/$logf" "$BASELINE_WAVES" "$REPRO_RC" ||
    diag_die "baseline did not produce a complete $BASELINE_WAVES-wave result (rc=$REPRO_RC); phase remains resumable"
  mark_done baseline
}

# ------------------------------------------------------------------
phase_groups() {
  : > "$OUT_DIR/results/groups.tsv"
  local i name kind cpus cluster children logf freq_tag
  local total=${#GROUP_NAME[@]}
  for ((i = 0; i < total; i++)); do
    name="${GROUP_NAME[$i]}"
    kind="${GROUP_KIND[$i]}"
    cpus="${GROUP_CPUS[$i]}"
    cluster="${GROUP_CLUSTER[$i]}"
    children="$(group_children "$cpus")"
    logf="logs/groups/${name}.log"
    freq_tag="group-${name}"
    diag_log "group $((i + 1))/$total: $name cpus=$cpus children=$children waves=$GROUP_WAVES"
    diag_freq_sampler_start "$freq_tag"
    run_repro_logged "$OUT_DIR/$logf" "$cpus" "$children" "$GROUP_WAVES"
    diag_freq_sampler_stop
    repro_result_is_complete "$OUT_DIR/$logf" "$GROUP_WAVES" "$REPRO_RC" ||
      diag_die "group $name did not produce a complete $GROUP_WAVES-wave result (rc=$REPRO_RC); phase remains resumable"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$kind" "$cpus" "$cluster" "$children" "$GROUP_WAVES" \
      "$logf" "$freq_tag" "$REPRO_RC" >> "$OUT_DIR/results/groups.tsv"
  done
  mark_done groups
}

# ------------------------------------------------------------------
# CPUs of groups that observed failures (from group logs), or all online
# CPUs when nothing failed (default/full) or nobody (quick, skip).
INDIVIDUAL_TARGET_CPUS=""
compute_individual_targets() {
  local failing=()
  local row logf
  while IFS=$'\t' read -r name kind cpus cluster children waves logf freq_tag rc; do
    [[ -n "$name" ]] || continue
    # repro.mjs only prints "child=" lines for failures.
    if [[ -f "$OUT_DIR/$logf" ]] && grep -qE $'^[0-9]+\tchild=[0-9]+ code=' "$OUT_DIR/$logf"; then
      failing+=("$cpus")
    fi
  done < "$OUT_DIR/results/groups.tsv"

  if ((${#failing[@]} > 0)); then
    INDIVIDUAL_TARGET_CPUS="$(
      printf '%s\n' "${failing[@]}" | tr ',' '\n' |
        while read -r part; do diag_cpulist_expand "$part"; done |
        sort -n | uniq | diag_cpulist_compress
    )"
    return 0
  fi
  if [[ "$MODE" == "quick" ]]; then
    INDIVIDUAL_TARGET_CPUS=""
    return 1
  fi
  INDIVIDUAL_TARGET_CPUS="$ONLINE_CPUS"
  return 0
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
    individual_meta_read "$meta" &&
      [[ "$INDIVIDUAL_META_SKIPPED" == 0 && "$INDIVIDUAL_META_TARGET_CPUS" == "$INDIVIDUAL_TARGET_CPUS" &&
        "$INDIVIDUAL_META_RUNS" == "$INDIVIDUAL_RUNS" ]] ||
      diag_die "existing individual.meta does not match this resumable phase; preserve it and use --redo individual"
  fi
  individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 0
  mkdir -p "$OUT_DIR/logs/individual"
  local -a cpus=()
  mapfile -t cpus < <(cpu_list_sorted "$INDIVIDUAL_TARGET_CPUS")
  local total=${#cpus[@]} idx=0 cpu existing deficit wrapper_rc
  for cpu in "${cpus[@]}"; do
    idx=$((idx + 1))
    # Intra-phase resume: skip CPUs already fully recorded; top up CPUs
    # with partial records by running only the deficit.
    existing="$(individual_cpu_row_count "$tsv" "$cpu")"
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
      individual_cpu_batch_matches_wrapper "$tsv" "$cpu" "$existing" "$INDIVIDUAL_RUNS" "$wrapper_rc" ||
      diag_die "cpu $cpu did not produce $deficit valid clean/SIGSEGV result(s) (wrapper rc=$wrapper_rc); phase remains resumable"
  done
  individual_rows_are_valid "$tsv" "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 1 ||
    diag_die "individual results are incomplete or invalid; preserve them and use --redo individual if they cannot be resumed"
  individual_meta_write "$INDIVIDUAL_TARGET_CPUS" "$INDIVIDUAL_RUNS" 0 1
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
  local tsv="$1" targets="$2" expected_total="$3" require_complete="$4" target_csv
  [[ -f "$tsv" && ! -L "$tsv" ]] || return 1
  [[ "$expected_total" =~ ^[1-9][0-9]*$ && "$require_complete" =~ ^[01]$ ]] || return 1
  individual_cpulist_is_canonical "$targets" || return 1
  target_csv="$(cpu_list_sorted "$targets" | paste -sd, -)"
  awk -F'\t' -v targets="$target_csv" -v expected="$expected_total" -v complete="$require_complete" '
    function uint(s) { return s ~ /^(0|[1-9][0-9]*)$/ }
    BEGIN {
      n = split(targets, target, ",")
      for (i = 1; i <= n; i++) allowed[target[i]] = 1
    }
    {
      if (NF != 4 || !uint($1) || !uint($2) || !uint($3) || !uint($4) ||
          !($1 in allowed) || ($3 != "0" && $3 != "139")) bad = 1
      else {
        count[$1]++
        if (($2 + 0) != count[$1] || count[$1] > expected) bad = 1
      }
    }
    END {
      if (complete) for (cpu in allowed) if ((count[cpu] + 0) != expected) bad = 1
      exit bad ? 1 : 0
    }
  ' "$tsv"
}

individual_cpu_row_count() {
  local tsv="$1" cpu="$2"
  awk -F'\t' -v cpu="$cpu" '$1 == cpu { count++ } END { print count + 0 }' "$tsv"
}

individual_cpu_batch_matches_wrapper() {
  local tsv="$1" cpu="$2" before="$3" expected_total="$4" wrapper_rc="$5"
  [[ "$wrapper_rc" == "0" || "$wrapper_rc" == "1" ]] || return 1
  awk -F'\t' -v cpu="$cpu" -v before="$before" -v expected="$expected_total" -v wrapper="$wrapper_rc" '
    $1 == cpu && $2 > before { count++; if ($3 == 139) new_sigsegv++ }
    END {
      wrapper_ok = (wrapper == 0 && new_sigsegv == 0) || (wrapper == 1 && new_sigsegv > 0)
      exit (count == expected - before && wrapper_ok) ? 0 : 1
    }
  ' "$tsv"
}

INDIVIDUAL_META_TARGET_CPUS=""
INDIVIDUAL_META_RUNS=""
INDIVIDUAL_META_SKIPPED=""
INDIVIDUAL_META_COMPLETED=""
INDIVIDUAL_META_SKIP_REASON=""

individual_meta_read() {
  local file="$1" line key value
  local -A seen=()
  INDIVIDUAL_META_TARGET_CPUS=""
  INDIVIDUAL_META_RUNS=""
  INDIVIDUAL_META_SKIPPED=""
  INDIVIDUAL_META_COMPLETED=""
  INDIVIDUAL_META_SKIP_REASON=""
  [[ -f "$file" && ! -L "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || return 1
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || return 1
    seen[$key]=1
    case "$key" in
      VERSION) [[ "$value" == 1 ]] || return 1 ;;
      TARGET_CPUS) INDIVIDUAL_META_TARGET_CPUS="$value" ;;
      RUNS_PER_CPU) INDIVIDUAL_META_RUNS="$value" ;;
      SKIPPED) INDIVIDUAL_META_SKIPPED="$value" ;;
      COMPLETED) INDIVIDUAL_META_COMPLETED="$value" ;;
      SKIP_REASON) INDIVIDUAL_META_SKIP_REASON="$value" ;;
      *) return 1 ;;
    esac
  done < "$file"
  [[ -n "${seen[VERSION]:-}" && -n "${seen[TARGET_CPUS]:-}" && -n "${seen[RUNS_PER_CPU]:-}" &&
    -n "${seen[SKIPPED]:-}" && -n "${seen[COMPLETED]:-}" ]] || return 1
  [[ "$INDIVIDUAL_META_RUNS" =~ ^[1-9][0-9]*$ && "$INDIVIDUAL_META_SKIPPED" =~ ^[01]$ &&
    "$INDIVIDUAL_META_COMPLETED" =~ ^[01]$ ]] || return 1
  if [[ "$INDIVIDUAL_META_SKIPPED" == 1 ]]; then
    [[ -z "$INDIVIDUAL_META_TARGET_CPUS" && "$INDIVIDUAL_META_COMPLETED" == 1 &&
      -n "$INDIVIDUAL_META_SKIP_REASON" ]] || return 1
  else
    [[ -z "$INDIVIDUAL_META_SKIP_REASON" ]] || return 1
    individual_cpulist_is_canonical "$INDIVIDUAL_META_TARGET_CPUS" || return 1
  fi
}

individual_meta_write() {
  local targets="$1" runs="$2" skipped="$3" completed="$4" reason="${5:-}" tmp
  tmp="$(mktemp "$OUT_DIR/results/.individual.meta.XXXXXX")" || diag_die "cannot create individual metadata"
  {
    printf 'VERSION=1\nTARGET_CPUS=%s\nRUNS_PER_CPU=%s\n' "$targets" "$runs"
    printf 'SKIPPED=%s\nCOMPLETED=%s\n' "$skipped" "$completed"
    [[ -z "$reason" ]] || printf 'SKIP_REASON=%s\n' "$reason"
  } > "$tmp" || diag_die "cannot write individual metadata"
  mv -T -- "$tmp" "$OUT_DIR/results/individual.meta" || diag_die "cannot publish individual metadata"
}

individual_phase_result_is_complete() {
  local meta="$OUT_DIR/results/individual.meta" tsv="$OUT_DIR/results/individual.tsv"
  individual_meta_read "$meta" && [[ "$INDIVIDUAL_META_COMPLETED" == 1 ]] || return 1
  if [[ "$INDIVIDUAL_META_SKIPPED" == 1 ]]; then
    [[ ! -s "$tsv" ]]
  else
    individual_rows_are_valid "$tsv" "$INDIVIDUAL_META_TARGET_CPUS" "$INDIVIDUAL_META_RUNS" 1
  fi
}

phase_individual_skipped() {
  local tsv="$OUT_DIR/results/individual.tsv" meta="$OUT_DIR/results/individual.meta"
  [[ ! -e "$meta" && ! -L "$meta" ]] ||
    diag_die "existing individual metadata conflicts with a skipped phase; preserve it and use --redo individual"
  if [[ -e "$tsv" || -L "$tsv" ]]; then
    [[ -f "$tsv" && ! -L "$tsv" && ! -s "$tsv" ]] ||
      diag_die "existing individual results conflict with a skipped phase; preserve them and use --redo individual"
  else
    : > "$tsv"
  fi
  individual_meta_write "" "$INDIVIDUAL_RUNS" 1 1 no-failing-group-in-quick-mode
  mark_done individual
}

# ------------------------------------------------------------------
# Worst CPU from a fully validated individual phase (highest SIGSEGV rate,
# ties: more SIGSEGVs, then lower CPU id).
worst_cpu() {
  individual_phase_result_is_complete || return 0
  [[ "$INDIVIDUAL_META_SKIPPED" == 0 ]] || return 0
  awk -F'\t' '
    { rc=$3; if (rc!=0 && rc!=139) next; n[$1]++; if (rc==139) f[$1]++ }
    END {
      best=-1; bestr=-1; bestf=0
      for (c in n) {
        r=(f[c]+0)/n[c]
        if (r>bestr || (r==bestr && (f[c]+0)>bestf) || (r==bestr && (f[c]+0)==bestf && c+0<best+0)) { best=c; bestr=r; bestf=f[c]+0 }
      }
      if (best>=0 && bestf>0) print best
    }' "$OUT_DIR/results/individual.tsv" 2> /dev/null || true
}

# ------------------------------------------------------------------
# Phase 5 (frequency A/B/A) is never executed by this script: it changes a
# runtime setting, so it lives in frequency-ab.sh for the user to review
# and run with sudo. Here we only detect already-collected results or
# print the exact manual command.
phase_frequency() {
  local cpu="$1"
  if frequency_result_is_complete; then
    diag_log "phase 5/7: frequency-ab.tsv present (manual frequency-ab.sh run); incorporating"
    mark_done frequency
    return 0
  fi
  if [[ -e "$OUT_DIR/results/frequency-ab.tsv" || -e "$OUT_DIR/results/frequency-ab.meta" ]]; then
    diag_warn "phase 5/7: incomplete manual frequency results found; phase remains resumable"
  fi
  diag_warn "phase 5/7: frequency A/B/A not run by this script (it changes a runtime setting)."
  if [[ -n "$cpu" ]]; then
    diag_warn "  to run it manually:  sudo ./frequency-ab.sh $cpu $INDIVIDUAL_RUNS \"$OUT_DIR\""
    diag_warn "  then regenerate:     ./diagnose.sh --resume \"$OUT_DIR\" --yes"
  else
    diag_warn "  no failing CPU identified; nothing to test."
  fi
}

frequency_result_is_complete() {
  local tsv="$OUT_DIR/results/frequency-ab.tsv"
  local meta="$OUT_DIR/results/frequency-ab.meta"
  [[ -f "$meta" ]] || return 1
  local runs restored completed
  runs="$(metadata_value "$meta" RUNS_PER_LEG)"
  restored="$(metadata_value "$meta" RESTORED)"
  completed="$(metadata_value "$meta" COMPLETED)"
  [[ "$restored" == "1" && "$completed" == "1" ]] || return 1
  diag_frequency_rows_are_complete "$tsv" "$runs"
}

# ------------------------------------------------------------------
phase_gdb() {
  local cpu="$1"
  local meta="$OUT_DIR/results/gdb.meta"
  {
    printf 'CPU=%s\n' "$cpu"
    printf 'MAX_RUNS=%s\n' "$GDB_MAX_RUNS"
  } > "$meta"
  mkdir -p "$OUT_DIR/logs/gdb"
  diag_log_cmd bash capture-fault.sh "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb"
  local rc=0
  run_gdb_logged "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb" \
    "$OUT_DIR/logs/gdb/runner.log" || rc=$?
  printf 'EXIT_CODE=%s\n' "$rc" >> "$meta"
  if ! gdb_result_is_complete "$rc"; then
    case "$rc" in
      4) diag_die "gdb capture lost a required dependency; phase remains resumable" ;;
      5) diag_die "gdb runner failed (see logs/gdb/runner.log); phase remains resumable" ;;
      *) diag_die "gdb runner returned unexpected exit code $rc; phase remains resumable" ;;
    esac
  fi
  case "$rc" in
    0) diag_log "gdb: fault captured" ;;
    3) diag_log "gdb: no fault within $GDB_MAX_RUNS runs" ;;
  esac
  mark_done gdb
}

gdb_result_is_complete() {
  [[ "$1" == "0" || "$1" == "3" ]]
}

# ------------------------------------------------------------------
write_privacy_review() {
  local review="$OUT_DIR/privacy-review.txt" file rel found=0
  {
    printf '# Automated privacy sentinel scan\n'
    printf '# Matches list only category and relative file; inspect raw files before sharing.\n'
  } > "$review"

  while IFS= read -r -d '' file; do
    rel="${file#"$OUT_DIR"/}"
    case "$rel" in
      privacy-review.txt | manifest.txt) continue ;;
    esac
    if [[ -n "${HOME:-}" && "$HOME" != "/" ]] && grep -aFq -- "$HOME" "$file" 2> /dev/null; then
      printf 'known-home-path\t%s\n' "$rel" >> "$review"
      found=1
    fi
    if grep -aFq -- "$OUT_DIR" "$file" 2> /dev/null; then
      printf 'known-bundle-path\t%s\n' "$rel" >> "$review"
      found=1
    fi
    if grep -aFq -- "$SCRIPT_DIR" "$file" 2> /dev/null; then
      printf 'known-repository-path\t%s\n' "$rel" >> "$review"
      found=1
    fi
    if grep -aEq '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "$file" 2> /dev/null; then
      printf 'uuid-shape\t%s\n' "$rel" >> "$review"
      found=1
    fi
    if grep -aEiq '(^|[^0-9a-f])([0-9a-f]{2}[:-]){5}[0-9a-f]{2}([^0-9a-f]|$)' "$file" 2> /dev/null; then
      printf 'mac-shape\t%s\n' "$rel" >> "$review"
      found=1
    fi
  done < <(find "$OUT_DIR" -type f -print0 | sort -z)

  if ((found == 0)); then
    printf 'status\tno-known-sentinels\n' >> "$review"
  else
    printf 'status\treview-required\n' >> "$review"
  fi
}

write_manifest() {
  # The hash pass must be the last filesystem write into the bundle: emit
  # the log line first, because diag_log appends to run.log, which is
  # itself hashed below.
  diag_log "writing manifest: $OUT_DIR/manifest.txt"
  local tmp
  # Keep the candidate beside (not inside) the bundle: it must not hash
  # itself, and the final same-filesystem rename must be atomic.
  tmp="$(mktemp "${OUT_DIR}.manifest.XXXXXX")" || return 1
  if ! (
    cd "$OUT_DIR"
    find . -type f ! -path './manifest.txt' -print0 |
      sort -z |
      xargs -0 sha256sum
  ) > "$tmp"; then
    rm -f -- "$tmp"
    return 1
  fi
  chmod 0644 "$tmp" || {
    rm -f -- "$tmp"
    return 1
  }
  mv -fT -- "$tmp" "$OUT_DIR/manifest.txt" || {
    rm -f -- "$tmp"
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

finalize_report() {
  persist_session_end
  sync_meta_completed
  node "$LIB/collect.mjs" "$OUT_DIR" || diag_die "collect.mjs failed; results.json may be stale"
  node "$LIB/report.mjs" "$OUT_DIR" || diag_die "report.mjs failed; report.md may be stale"
  write_privacy_review || diag_die "privacy sentinel scan failed"
  write_manifest || diag_die "manifest generation failed"
}

complete_diagnostic() {
  # Bundle logging must stop before write_manifest hashes run.log. Emit only
  # a non-success progress line first, then print success to the terminal
  # after every finalization step has completed.
  diag_log "finalizing report and manifest"
  finalize_report
  printf '[%s] done. Bundle: %s\n' "$(date '+%H:%M:%S')" "$OUT_DIR"
  printf '[%s] report: %s/report.md\n' "$(date '+%H:%M:%S')" "$OUT_DIR"
}

diagnose_cleanup_exit() {
  local rc="$1"
  trap - EXIT INT TERM
  redo_marker_temp_cleanup
  diag_process_group_stop
  diag_freq_sampler_stop
  exit "$rc"
}

on_interrupt() {
  local sig="$1"
  trap - EXIT INT TERM
  redo_marker_temp_cleanup
  meta_set INTERRUPTED 1 2> /dev/null || true
  diag_process_group_stop 2> /dev/null || true
  diag_freq_sampler_stop 2> /dev/null || true
  if [[ -e "$STATE_DIR/redo.pending" || -L "$STATE_DIR/redo.pending" ]]; then
    diag_warn "received $sig while redo archival is pending; skipping a misleading partial report (resume this bundle to recover)"
    if [[ "$sig" == "SIGINT" ]]; then exit 130; else exit 143; fi
  fi
  diag_warn "received $sig - stopping frequency sampling and writing a partial report"
  # Best effort: a failed partial report must not mask the interrupt, so
  # the subshell contains diag_die's exit and the failure is swallowed.
  ( finalize_report ) 2> /dev/null || true
  if [[ "$sig" == "SIGINT" ]]; then exit 130; else exit 143; fi
}

# ---------------------------------------------------------------------------
# Plan printing (also used by --dry-run)
# ---------------------------------------------------------------------------
print_plan() {
  local ncpus_online
  ncpus_online="$(diag_cpulist_count "$ONLINE_CPUS")"
  cat << EOF
Resolved configuration:
  mode               $MODE
  out dir            ${OUT_DIR:-diagnostics/<timestamp>}$( [[ -n "$RESUME_DIR" ]] && printf ' (resume)' || true )
  baseline           $BASELINE_CHILDREN children x $BASELINE_WAVES waves (~$((BASELINE_CHILDREN * BASELINE_WAVES)) child runs)
  groups             ${#GROUP_NAME[@]} group(s) x $GROUP_WAVES waves
  individual runs    $INDIVIDUAL_RUNS per CPU (failing groups' CPUs, or all $ncpus_online online CPUs)
  redo phases        ${REDO_PLAN[*]:-none}
  frequency A/B/A    manual step (sudo ./frequency-ab.sh; never automatic)
  gdb capture        $( [[ "$SKIP_GDB" == "1" ]] && printf 'skipped' || printf 'up to %s runs on the worst CPU' "$GDB_MAX_RUNS" )

Discovered topology:
  online CPUs        $ONLINE_CPUS
  P-cores            ${P_CORES:-none detected}
  E-cores            ${E_CORES:-none detected}
EOF
  local i
  for ((i = 0; i < ${#GROUP_NAME[@]}; i++)); do
    printf '  group %-18s cpus=%-10s children=%s\n' \
      "${GROUP_NAME[$i]}" "${GROUP_CPUS[$i]}" "$(group_children "${GROUP_CPUS[$i]}")"
  done
  cat << EOF

Rough duration estimate (very approximate, ~6s/wave, ~3s/single run):
  baseline           ~$((BASELINE_WAVES * 6 / 60 + 1)) min
  groups             ~$(( ${#GROUP_NAME[@]} * GROUP_WAVES * 6 / 60 + 1)) min
  individual         ~$(( ncpus_online * INDIVIDUAL_RUNS * 3 / 60 + 1)) min worst case
  frequency A/B/A    ~$(( 3 * INDIVIDUAL_RUNS * 3 / 60 + 1)) min (manual: sudo ./frequency-ab.sh)
  gdb                ~$(( GDB_MAX_RUNS * 40 / 60 + 1)) min worst case
EOF
}

# ---------------------------------------------------------------------------
main() {
  local caller_dir
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
    [[ -f "$OUT_DIR/results/meta.env" ]] ||
      diag_die "resume directory '$OUT_DIR' is not a diagnostic bundle (missing results/meta.env)"
    load_stored_config "$OUT_DIR"
    # Stored values are already concrete; do not re-apply the mode preset.
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
  validate_config

  # Work from the repository root regardless of the caller's CWD.
  cd "$SCRIPT_DIR"
  [[ -f repro.mjs && -f child.mjs ]] ||
    diag_die "repro.mjs/child.mjs not found; run from the repository checkout"

  require_dependencies

  discover_topology

  if [[ -n "$WORST_CPU_OVERRIDE" ]] && ! diag_cpulist_contains "$ONLINE_CPUS" "$WORST_CPU_OVERRIDE"; then
    diag_die "--cpu $WORST_CPU_OVERRIDE is not in the usable CPU set ($ONLINE_CPUS)"
  fi
  validate_completed_phase_overrides

  if [[ -z "$OUT_DIR" ]]; then
    OUT_DIR="diagnostics/$(date -u +%Y-%m-%dT%H%M%SZ)"
  fi
  if [[ -z "$RESUME_DIR" && -e "$OUT_DIR" ]]; then
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
  print_plan

  mkdir -p "$OUT_DIR"/{results,logs/individual,state,env,freq,gdb}
  OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  DIAG_BUNDLE_ROOT="$OUT_DIR"
  DIAG_REPO_ROOT="$SCRIPT_DIR"
  META_FILE="$OUT_DIR/results/meta.env"
  STATE_DIR="$OUT_DIR/state"
  DIAG_FREQ_DIR="$OUT_DIR/freq"
  DIAG_LOG_FILE="$OUT_DIR/run.log"
  DIAG_COMMANDS_LOG="$OUT_DIR/commands.log"
  prepare_commands_log

  trap 'diagnose_cleanup_exit $?' EXIT
  trap 'on_interrupt SIGINT' INT
  trap 'on_interrupt SIGTERM' TERM

  if [[ -z "$RESUME_DIR" ]] || [[ ! -f "$META_FILE" ]]; then
    {
      printf 'MODE=%s\n' "$MODE"
      printf 'START_EPOCH=%s\n' "$(date +%s)"
      printf 'START_ISO=%s\n' "$(date -Is)"
      printf 'BASELINE_CHILDREN=%s\n' "$BASELINE_CHILDREN"
      printf 'BASELINE_WAVES=%s\n' "$BASELINE_WAVES"
      printf 'GROUP_WAVES=%s\n' "$GROUP_WAVES"
      printf 'INDIVIDUAL_RUNS=%s\n' "$INDIVIDUAL_RUNS"
      printf 'GDB_MAX_RUNS=%s\n' "$GDB_MAX_RUNS"
      printf 'SKIP_GDB=%s\n' "$SKIP_GDB"
      printf 'INTERRUPTED=0\n'
    } > "$META_FILE"
  fi
  # Stored configuration seeds resume defaults, but explicit CLI overrides
  # describe the run that is about to execute and must be reflected in JSON.
  recover_pending_redo
  persist_effective_config

  apply_redo_plan

  # ---- phase 1 ----
  if phase_is_done preflight; then
    diag_log "phase 1/7 preflight: already done, skipping (resume)"
  else
    diag_log "phase 1/7: preflight and environment collection"
    phase_preflight
  fi

  # ---- phase 2 ----
  if phase_is_done baseline; then
    diag_log "phase 2/7 baseline: already done, skipping (resume)"
  else
    diag_log "phase 2/7: baseline reproduction"
    phase_baseline
  fi

  # ---- phase 3 ----
  if phase_is_done groups; then
    diag_log "phase 3/7 groups: already done, skipping (resume)"
  else
    diag_log "phase 3/7: CPU-group isolation (${#GROUP_NAME[@]} groups x $GROUP_WAVES waves)"
    phase_groups
  fi

  # ---- phase 4 ----
  if phase_is_done individual; then
    individual_phase_result_is_complete ||
      diag_die "completed individual phase has missing or invalid evidence; preserve it and resume with --redo individual"
    diag_log "phase 4/7 individual: already done, skipping (resume)"
  else
    if compute_individual_targets; then
      diag_log "phase 4/7: individual CPU isolation (cpus $INDIVIDUAL_TARGET_CPUS, $INDIVIDUAL_RUNS runs each)"
      phase_individual
    else
      diag_log "phase 4/7: no failing group in quick mode; skipping individual tests"
      phase_individual_skipped
    fi
  fi

  # Determine the CPU for phases 5/6.
  local target_cpu=""
  if [[ -n "$WORST_CPU_OVERRIDE" ]]; then
    target_cpu="$WORST_CPU_OVERRIDE"
  elif [[ -s "$OUT_DIR/results/individual.tsv" ]]; then
    target_cpu="$(worst_cpu)"
  fi

  # ---- phase 5 (manual; see frequency-ab.sh) ----
  if phase_is_done frequency; then
    diag_log "phase 5/7 frequency: already done, skipping (resume)"
  elif frequency_result_is_complete; then
    diag_log "phase 5/7: results from a manual frequency-ab.sh run found; incorporating"
    mark_done frequency
  elif [[ -z "$target_cpu" ]]; then
    diag_warn "phase 5/7: no failing CPU identified; skipping frequency A/B/A"
  else
    diag_log "phase 5/7: frequency A/B/A (manual step, run with sudo)"
    phase_frequency "$target_cpu"
  fi

  # ---- phase 6 ----
  if phase_is_done gdb; then
    diag_log "phase 6/7 gdb: already done, skipping (resume)"
  elif [[ "$SKIP_GDB" == "1" ]]; then
    diag_log "phase 6/7: skipped (--skip-gdb)"
    printf 'SKIPPED=1\nSKIP_REASON=--skip-gdb\n' > "$OUT_DIR/results/gdb.meta"
    mark_done gdb
  elif ! command -v gdb > /dev/null 2>&1; then
    diag_warn "phase 6/7: gdb not installed; skipping"
    printf 'SKIPPED=1\nSKIP_REASON=gdb not installed\n' > "$OUT_DIR/results/gdb.meta"
    mark_done gdb
  elif [[ -z "$target_cpu" ]]; then
    diag_warn "phase 6/7: no failing CPU identified; skipping"
    printf 'SKIPPED=1\nSKIP_REASON=no failing CPU identified\n' > "$OUT_DIR/results/gdb.meta"
    mark_done gdb
  else
    diag_log "phase 6/7: gdb signature capture on cpu $target_cpu (max $GDB_MAX_RUNS runs)"
    phase_gdb "$target_cpu"
  fi

  # ---- phase 7 ----
  diag_log "phase 7/7: statistics, report, manifest"
  # A run that reaches here completed fully; clear any interrupted flag
  # left over from a previous, interrupted attempt on this bundle.
  meta_set INTERRUPTED 0
  complete_diagnostic
}

# Allow tests to source this file for individual functions without running.
if [[ "${DIAG_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
