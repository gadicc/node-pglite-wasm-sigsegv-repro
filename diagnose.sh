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
WORST_CPU_OVERRIDE=""

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
  while (($#)); do
    case "$1" in
      --quick) MODE="quick"; apply_mode_preset; shift ;;
      --full) MODE="full"; apply_mode_preset; shift ;;
      --resume) RESUME_DIR="${2:?}"; shift 2 ;;
      --out-dir) OUT_DIR="${2:?}"; OUT_DIR_EXPLICIT=1; shift 2 ;;
      --skip-gdb) SKIP_GDB=1; shift ;;
      --redo) REDO_PHASES="${2:?--redo needs a phase list}"; shift 2 ;;
      --individual-runs) INDIVIDUAL_RUNS="${2:?}"; shift 2 ;;
      --group-waves) GROUP_WAVES="${2:?}"; shift 2 ;;
      --gdb-max-runs) GDB_MAX_RUNS="${2:?}"; shift 2 ;;
      --cpu) WORST_CPU_OVERRIDE="${2:?}"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) diag_die "unknown option '$1' (see --help)" ;;
    esac
  done
}

validate_config() {
  diag_require_uint "--individual-runs" "$INDIVIDUAL_RUNS"
  diag_require_uint "--group-waves" "$GROUP_WAVES"
  diag_require_uint "--gdb-max-runs" "$GDB_MAX_RUNS"
  diag_require_uint "baseline children" "$BASELINE_CHILDREN"
  diag_require_uint "baseline waves" "$BASELINE_WAVES"
  [[ "$SKIP_GDB" == "0" || "$SKIP_GDB" == "1" ]] ||
    diag_die "stored SKIP_GDB must be 0 or 1, got '$SKIP_GDB'"
  ((INDIVIDUAL_RUNS >= 1 && GROUP_WAVES >= 1 && BASELINE_CHILDREN >= 1 && BASELINE_WAVES >= 1)) ||
    diag_die "runs/waves/children must all be >= 1"
  if [[ -n "$WORST_CPU_OVERRIDE" ]]; then
    diag_require_uint "--cpu" "$WORST_CPU_OVERRIDE"
  fi
  if [[ -n "$REDO_PHASES" && -z "$RESUME_DIR" ]]; then
    diag_die "--redo requires --resume DIR (it re-runs phases of an existing bundle)"
  fi
  build_redo_plan
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

build_redo_plan() {
  REDO_PLAN=()
  [[ -n "$REDO_PHASES" ]] || return 0
  [[ ! "$REDO_PHASES" =~ (^,|,$|,,) ]] ||
    diag_die "--redo contains an empty phase name"
  local -a requested=()
  local phase
  declare -A seen=()
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
    REDO_PLAN+=("$phase")
  done
}

# Move a phase's data aside (never delete) and clear its done marker so the
# phase re-runs from scratch on this resume. Used by --redo when a phase
# should be repeated in a single contiguous session rather than topped up.
redo_phase() {
  local phase="$1"
  local -a paths=()
  case "$phase" in
    baseline) paths=(results/baseline.meta logs/baseline) ;;
    groups) paths=(results/groups.tsv logs/groups) ;;
    individual) paths=(results/individual.tsv logs/individual) ;;
    gdb) paths=(results/gdb.meta gdb logs/gdb) ;;
    frequency)
      paths=(results/frequency-ab.tsv results/frequency-ab.meta
        results/frequency-cap.tsv results/frequency-cap.meta)
      ;;
    *)
      diag_die "--redo: unknown or unsupported phase '$phase' (supported: baseline,groups,individual,gdb,frequency)"
      ;;
  esac
  local -a existing=()
  local p
  for p in "${paths[@]}"; do
    if [[ -e "$OUT_DIR/$p" ]]; then
      existing+=("$p")
    fi
  done
  local stash=""
  if ((${#existing[@]} > 0)); then
    mkdir -p "$STATE_DIR/superseded"
    stash="$(mktemp -d "$STATE_DIR/superseded/${phase}-$(date +%Y%m%dT%H%M%S)-XXXXXX")"
    for p in "${existing[@]}"; do
      mkdir -p "$stash/$(dirname "$p")"
      mv "$OUT_DIR/$p" "$stash/$p"
    done
  fi
  rm -f "$STATE_DIR/phase-$phase.done"
  sync_meta_completed
  if [[ -n "$stash" ]]; then
    diag_log "--redo $phase: previous data preserved under ${stash#"$OUT_DIR"/}"
  else
    diag_log "--redo $phase: no previous data; phase will run fresh"
  fi
}

# ---------------------------------------------------------------------------
# Topology discovery (sysfs only; nothing hardcoded to this machine)
# ---------------------------------------------------------------------------
ONLINE_CPUS=""
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
  ONLINE_CPUS="$(cat /sys/devices/system/cpu/online 2> /dev/null || echo "")"
  [[ -n "$ONLINE_CPUS" ]] || ONLINE_CPUS="0-$(( $(nproc) - 1 ))"

  [[ -r /sys/devices/cpu_core/cpus ]] && P_CORES="$(cat /sys/devices/cpu_core/cpus)"
  [[ -r /sys/devices/cpu_atom/cpus ]] && E_CORES="$(cat /sys/devices/cpu_atom/cpus)"

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
  set +e
  if [[ "$cpulist" == "-" ]]; then
    diag_log_cmd env STOP_ON_FAILURE=0 node repro.mjs "$children" "$waves"
    env STOP_ON_FAILURE=0 node repro.mjs "$children" "$waves" 2>&1 |
      awk '{print systime()"\t"$0}' > "$logf"
  else
    diag_log_cmd env STOP_ON_FAILURE=0 taskset -c "$cpulist" node repro.mjs "$children" "$waves"
    env STOP_ON_FAILURE=0 taskset -c "$cpulist" node repro.mjs "$children" "$waves" 2>&1 |
      awk '{print systime()"\t"$0}' > "$logf"
  fi
  REPRO_RC=${PIPESTATUS[0]}
  set -e
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
  uname -a > "$env_dir/uname.txt"
  diag_log_cmd uname -a

  {
    printf 'node=%s\n' "$(node --version 2>&1)"
    printf 'v8=%s\n' "$(node -p 'process.versions.v8' 2>&1)"
    printf 'node_path=%s\n' "$(command -v node)"
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

  diag_run cat /proc/cmdline > "$env_dir/cmdline.txt"
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
  elif dmesg_out="$(journalctl -k -b --no-pager 2> /dev/null)" && [[ -n "$dmesg_out" ]]; then
    printf '# source: journalctl -k -b (unprivileged)\n' >> "$kw"
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
  local req=(bash node taskset awk grep sed timeout sha256sum date find xargs sort)
  local opt=(gdb turbostat lscpu sudo journalctl systemctl intel-undervolt cctk tac)
  local missing_opt=() c
  {
    printf '# required\n'
    for c in "${req[@]}"; do
      printf '%-18s %s\n' "$c" "$(command -v "$c" 2> /dev/null || echo MISSING)"
    done
    printf '# optional\n'
    for c in "${opt[@]}"; do
      if command -v "$c" > /dev/null 2>&1; then
        printf '%-18s %s\n' "$c" "$(command -v "$c")"
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
  if ((REPRO_RC != 0 && REPRO_RC != 1)); then
    diag_warn "baseline exited with unexpected code $REPRO_RC (0/1 expected)"
  fi
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
  mkdir -p "$OUT_DIR/logs/individual"
  touch "$tsv"
  local -a cpus=()
  mapfile -t cpus < <(cpu_list_sorted "$INDIVIDUAL_TARGET_CPUS")
  local total=${#cpus[@]} idx=0 cpu existing deficit
  for cpu in "${cpus[@]}"; do
    idx=$((idx + 1))
    # Intra-phase resume: skip CPUs already fully recorded; top up CPUs
    # with partial records by running only the deficit.
    existing="$(awk -F'\t' -v c="$cpu" '$1==c {n++} END {print n+0}' "$tsv")"
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
    set +e
    diag_log_cmd bash single.sh "$cpu" "$deficit" "$tsv"
    bash single.sh "$cpu" "$deficit" "$tsv" 2>&1 |
      tee "$OUT_DIR/logs/individual/cpu-${cpu}.log" | tail -1
    set -e
  done
  mark_done individual
}

# ------------------------------------------------------------------
# Worst CPU from individual.tsv (highest failure rate, ties: more failures).
worst_cpu() {
  awk -F'\t' '
    { rc=$3; if (rc==126 || rc==127) next; n[$1]++; if (rc!=0) f[$1]++ }
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
  if [[ -s "$OUT_DIR/results/frequency-ab.tsv" ]]; then
    diag_log "phase 5/7: frequency-ab.tsv present (manual frequency-ab.sh run); incorporating"
    mark_done frequency
    return 0
  fi
  diag_warn "phase 5/7: frequency A/B/A not run by this script (it changes a runtime setting)."
  if [[ -n "$cpu" ]]; then
    diag_warn "  to run it manually:  sudo ./frequency-ab.sh $cpu $INDIVIDUAL_RUNS \"$OUT_DIR\""
    diag_warn "  then regenerate:     ./diagnose.sh --resume \"$OUT_DIR\" --yes"
  else
    diag_warn "  no failing CPU identified; nothing to test."
  fi
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
  set +e
  diag_log_cmd bash capture-fault.sh "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb"
  bash capture-fault.sh "$cpu" "$GDB_MAX_RUNS" "$GDB_MAX_CAPTURES" "$OUT_DIR/gdb" 2>&1 |
    tee "$OUT_DIR/logs/gdb/runner.log"
  local rc=${PIPESTATUS[0]}
  set -e
  printf 'EXIT_CODE=%s\n' "$rc" >> "$meta"
  case "$rc" in
    0) diag_log "gdb: fault captured" ;;
    3) diag_log "gdb: no fault within $GDB_MAX_RUNS runs" ;;
    4) diag_warn "gdb: missing dependency" ;;
    5) diag_warn "gdb: runner failure (see logs/gdb/runner.log)" ;;
    *) diag_warn "gdb: unexpected exit code $rc" ;;
  esac
  mark_done gdb
}

# ------------------------------------------------------------------
write_manifest() {
  (
    cd "$OUT_DIR"
    find . -type f ! -name manifest.txt -print0 |
      sort -z |
      xargs -0 sha256sum > manifest.txt
  )
  diag_log "manifest written: $OUT_DIR/manifest.txt"
}

finalize_report() {
  meta_set END_EPOCH "$(date +%s)"
  meta_set END_ISO "$(date -Is)"
  sync_meta_completed
  node "$LIB/collect.mjs" "$OUT_DIR" || diag_warn "collect.mjs failed"
  node "$LIB/report.mjs" "$OUT_DIR" || diag_warn "report.mjs failed"
  write_manifest || diag_warn "manifest generation failed"
}

on_interrupt() {
  local sig="$1"
  diag_warn "received $sig - restoring settings and writing a partial report"
  meta_set INTERRUPTED 1 2> /dev/null || true
  diag_freq_sampler_stop 2> /dev/null || true
  diag_restore_now 2> /dev/null || true
  finalize_report 2> /dev/null || true
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
  pre_pass "$@"

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
    load_stored_config "$OUT_DIR"
    # Stored values are already concrete; do not re-apply the mode preset.
  fi

  parse_args "$@"
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

  command -v node > /dev/null 2>&1 || diag_die "node is required but not found in PATH"

  discover_topology

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

  mkdir -p "$OUT_DIR"/{results,logs/individual,state,env,freq,gdb}
  OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  META_FILE="$OUT_DIR/results/meta.env"
  STATE_DIR="$OUT_DIR/state"
  DIAG_RESTORE_FILE="$OUT_DIR/state/restore.tsv"
  DIAG_FREQ_DIR="$OUT_DIR/freq"
  DIAG_LOG_FILE="$OUT_DIR/run.log"
  DIAG_COMMANDS_LOG="$OUT_DIR/commands.log"
  : > "$DIAG_COMMANDS_LOG"

  trap 'diag_restore_now' EXIT
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
  persist_effective_config

  if ((${#REDO_PLAN[@]} > 0)); then
    local rp
    for rp in "${REDO_PLAN[@]}"; do
      redo_phase "$rp"
    done
  fi

  safety_gate
  print_plan

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
    diag_log "phase 4/7 individual: already done, skipping (resume)"
  else
    if compute_individual_targets; then
      diag_log "phase 4/7: individual CPU isolation (cpus $INDIVIDUAL_TARGET_CPUS, $INDIVIDUAL_RUNS runs each)"
      phase_individual
    else
      diag_log "phase 4/7: no failing group in quick mode; skipping individual tests"
      mark_done individual
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
  elif [[ -s "$OUT_DIR/results/frequency-ab.tsv" ]]; then
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
  finalize_report

  diag_log "done. Bundle: $OUT_DIR"
  diag_log "report: $OUT_DIR/report.md"
}

# Allow tests to source this file for individual functions without running.
if [[ "${DIAG_SOURCE_ONLY:-}" != "1" ]]; then
  main "$@"
fi
