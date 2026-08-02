#!/usr/bin/env bash
# root-checks.sh - OPTIONAL privileged *read-only* evidence collection.
#
# diagnose.sh never elevates privileges. This companion script exists so
# you can review exactly which privileged reads are taken, then run it
# yourself:
#
#   sudo ./root-checks.sh <diagnostics-bundle-dir>
#
# It writes plain-text files under <bundle>/env/root/ and changes nothing.
# Afterwards regenerate the report with:
#
#   ./diagnose.sh --resume <bundle> --yes
#
# What it does, exhaustively:
#   1. dmesg excerpt: MCE / EDAC / thermal / TME / MKTME / microcode lines
#   2. intel-undervolt read (if installed) + service state
#   3. cctk reads of an EXPLICIT ALLOWLIST of BIOS settings (see below),
#      one no-argument property query per call
#   4. a 5-second turbostat sample (if installed)
#
# What it never does:
#   - no BIOS setting is ever written (cctk is only ever called with a
#     bare --Property, never --Property=value, -I/--infile, or -O/--outfile)
#   - no BIOS/system password is read, written, or placed on a command line
#   - no service tags, serial numbers, UUIDs, asset/owner tags
#     (--SvcTag, --Uuid, --SysId, --Asset, --PropOwnTag, ... are NOT queried)
#   - no full cctk export
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: sudo $0 <diagnostics-bundle-dir>" >&2
  exit 2
}

root_checks_main() {
  [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage
  local bundle="${1:-}"
  [[ -n "$bundle" && -d "$bundle" && ! -L "$bundle" ]] || usage

  if ((EUID != 0)); then
    echo "error: this script performs privileged reads; run it with sudo." >&2
    echo "       sudo $0 $bundle" >&2
    exit 4
  fi

  command -v runuser > /dev/null 2>&1 || {
    echo "error: missing required command: runuser" >&2
    exit 4
  }
  [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]] || {
    echo "error: run through sudo from a non-root account so evidence can be published without root privileges" >&2
    exit 1
  }
  [[ "${SUDO_UID:-}" =~ ^[0-9]+$ && "$SUDO_UID" != "0" ]] || {
    echo "error: SUDO_UID must identify a non-root invoking user" >&2
    exit 1
  }
  local invoking_uid invoking_gid
  invoking_uid="$(id -u "$SUDO_USER" 2> /dev/null)" || {
    echo "error: cannot resolve invoking user '$SUDO_USER'" >&2
    exit 1
  }
  invoking_gid="$(id -g "$SUDO_USER" 2> /dev/null)" || {
    echo "error: cannot resolve invoking group for '$SUDO_USER'" >&2
    exit 1
  }
  [[ "$invoking_uid" == "$SUDO_UID" ]] || {
    echo "error: SUDO_USER and SUDO_UID identify different invoking users" >&2
    exit 1
  }

  bundle="$(cd -- "$bundle" && pwd -P)"
  runuser -u "$SUDO_USER" -- test -d "$bundle" &&
    runuser -u "$SUDO_USER" -- test -w "$bundle" || {
      echo "error: invoking user cannot write the diagnostics bundle" >&2
      exit 1
    }
  local -a output_names=(
    kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt root-checks.meta
  )

  # Collect outside the user-owned bundle. Root never opens or renames a
  # destination beneath the bundle; final placement is delegated below.
  local stage_dir
  stage_dir="$(mktemp -d /tmp/root-checks.XXXXXX)" || exit 1
  [[ "$(stat -Lc '%u:%g:%a' -- "$stage_dir" 2> /dev/null)" == "0:0:700" ]] || {
    echo "error: root-checks staging directory is not root-owned and mode 0700" >&2
    exit 1
  }
  cleanup_stage() {
    local name
    [[ -n "$stage_dir" ]] || return 0
    for name in "${output_names[@]}"; do rm -f -- "$stage_dir/$name"; done
    rmdir -- "$stage_dir" 2> /dev/null || true
  }
  trap cleanup_stage EXIT
  trap 'cleanup_stage; exit 130' INT
  trap 'cleanup_stage; exit 143' TERM

# cctk read-only allowlist (bare-property queries only). Labels are used
# for the report; values are the exact cctk property names.
local -a CCTK_ALLOWLIST=(
  "TurboMode"        # turbo
  "IntelTME"         # TME
  "IntelSagv"        # System Agent Geyserville
  "Speedstep"        # SpeedStep
  "CStatesCtrl"      # C-states
  "AdaptiveCStates"  # adaptive C-states
  "ThermalManagement" # Dell performance/thermal mode
  "SpeedShift"       # Intel SpeedShift (HWP)
)

echo "[root-checks] staging privileged reads for $bundle/env/root"

# 1. kernel warnings -------------------------------------------------------
{
  echo "# source: dmesg (as root, $(date -Is))"
  dmesg | grep -iE 'mce|machine check|edac|thermal|tme|mktme|microcode' || true
} > "$stage_dir/kernel-warnings.txt"

# 2. intel-undervolt -------------------------------------------------------
{
  if command -v intel-undervolt > /dev/null 2>&1; then
    echo "# intel-undervolt read ($(date -Is))"
    intel-undervolt read 2>&1 || echo "read failed"
    if command -v systemctl > /dev/null 2>&1; then
      echo "service_enabled=$(systemctl is-enabled intel-undervolt.service 2>&1 || true)"
      echo "service_active=$(systemctl is-active intel-undervolt.service 2>&1 || true)"
    fi
  else
    echo "intel-undervolt not installed"
  fi
} > "$stage_dir/intel-undervolt.txt"

# 3. cctk allowlist --------------------------------------------------------
{
  if command -v cctk > /dev/null 2>&1; then
    echo "# cctk read-only allowlist probe ($(date -Is))"
    echo "# bare --Property queries only; no writes, no passwords, no export"
    for prop in "${CCTK_ALLOWLIST[@]}"; do
      printf '%s=' "$prop"
      out="$(timeout 60 cctk "--$prop" 2>&1)" && [[ -n "$out" ]] \
        && printf '%s\n' "$out" \
        || printf 'unavailable\n'
    done
  else
    echo "cctk not installed"
  fi
} > "$stage_dir/cctk.txt"

# 4. turbostat sample ------------------------------------------------------
{
  if command -v turbostat > /dev/null 2>&1; then
    echo "# turbostat --Summary --quiet --interval 1 --num_iterations 5 ($(date -Is))"
    turbostat --Summary --quiet --interval 1 --num_iterations 5 2>&1 || true
  else
    echo "turbostat not installed"
  fi
} > "$stage_dir/turbostat.txt"

{
  echo "date=$(date -Is)"
  echo "host_bundle=."
} > "$stage_dir/root-checks.meta"

local name
for name in "${output_names[@]}"; do
  [[ -f "$stage_dir/$name" && ! -L "$stage_dir/$name" ]] || {
    echo "error: unsafe staged root-checks artifact: $name" >&2
    exit 1
  }
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$stage_dir/$name" 2> /dev/null)" == "0:0:600:1" ]] || {
    echo "error: staged root-checks artifact has unsafe ownership, mode, or links: $name" >&2
    exit 1
  }
done
for name in "${output_names[@]}"; do
  chown "$invoking_uid:$invoking_gid" "$stage_dir/$name" || {
    echo "error: could not hand staged artifact to the invoking user: $name" >&2
    exit 1
  }
done

# The parent directory remains root-only until every exact artifact has been
# handed off. Disable privileged cleanup before granting the user access: from
# this point onward, root performs no filesystem operation on staging/bundle.
trap - EXIT INT TERM
trap '' INT TERM
if ! chown "$invoking_uid:$invoking_gid" "$stage_dir"; then
  trap - INT TERM
  cleanup_stage
  echo "error: could not hand staging directory to the invoking user" >&2
  exit 1
fi
trap 'exit 130' INT
trap 'exit 143' TERM
if ! runuser -u "$SUDO_USER" -- /bin/bash \
  "$SCRIPT_DIR/diagnose-lib/publish-root-checks-output.sh" "$stage_dir" "$bundle"; then
  echo "error: could not publish root-checks evidence; invoking user owns staging directory $stage_dir" >&2
  exit 1
fi
stage_dir=""
trap - INT TERM
echo "[root-checks] done. Regenerate the report with:"
echo "  ./diagnose.sh --resume \"$bundle\" --yes"
}

if [[ "${ROOT_CHECKS_SOURCE_ONLY:-}" != "1" ]]; then
  root_checks_main "$@"
fi
