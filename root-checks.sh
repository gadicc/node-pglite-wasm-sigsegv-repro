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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: sudo $0 <diagnostics-bundle-dir>" >&2
  exit 2
}

root_checks_prepare_out_dir() {
  local bundle="$1" env_dir="$1/env" out_dir="$1/env/root"
  [[ -d "$bundle" && ! -L "$bundle" ]] || {
    echo "error: bundle must be a real directory, not a symlink: $bundle" >&2
    return 1
  }
  if [[ -e "$env_dir" || -L "$env_dir" ]]; then
    [[ -d "$env_dir" && ! -L "$env_dir" ]] || {
      echo "error: refusing unsafe env path: $env_dir" >&2
      return 1
    }
  else
    mkdir -- "$env_dir" || return 1
  fi
  if [[ -e "$out_dir" || -L "$out_dir" ]]; then
    [[ -d "$out_dir" && ! -L "$out_dir" ]] || {
      echo "error: refusing unsafe privileged output path: $out_dir" >&2
      return 1
    }
  else
    mkdir -- "$out_dir" || return 1
  fi
}

root_checks_validate_files() {
  local out_dir="$1" name target
  shift
  [[ -d "$out_dir" ]] || return 1
  for name in "$@"; do
    target="$out_dir/$name"
    [[ ! -L "$target" ]] || return 1
    [[ ! -e "$target" || -f "$target" ]] || return 1
  done
}

root_checks_validate_destinations() {
  local out_dir="$1"
  shift
  [[ -d "$out_dir" && ! -L "$out_dir" ]] || return 1
  root_checks_validate_files "$out_dir" "$@"
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

  bundle="$(cd -- "$bundle" && pwd -P)"
  root_checks_prepare_out_dir "$bundle" || exit 1
  local out_dir="$bundle/env/root"
  local out_fd anchored_out
  exec {out_fd}< "$out_dir" || exit 1
  anchored_out="/proc/self/fd/$out_fd"
  local -a output_names=(
    kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt root-checks.meta
  )
  root_checks_validate_destinations "$out_dir" "${output_names[@]}" || {
    echo "error: refusing symlink or non-file privileged output destination under $out_dir" >&2
    exit 1
  }

  # Collect outside the user-owned bundle. Only completed regular files are
  # moved into destinations that are revalidated immediately before use.
  local stage_dir
  stage_dir="$(mktemp -d /tmp/root-checks.XXXXXX)" || exit 1
  cleanup_stage() {
    local name
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

echo "[root-checks] staging privileged reads for $out_dir"

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

[[ -d "$out_dir" && ! -L "$out_dir" && "$out_dir" -ef "$anchored_out" ]] || {
  echo "error: privileged output directory changed during collection; refusing placement" >&2
  exit 1
}
root_checks_validate_files "$anchored_out" "${output_names[@]}" || {
  echo "error: privileged output destinations changed during collection; refusing placement" >&2
  exit 1
}
local name target
for name in "${output_names[@]}"; do
  chmod 0644 "$stage_dir/$name"
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown "$SUDO_USER":"$(id -gn "$SUDO_USER")" "$stage_dir/$name" 2> /dev/null || true
  fi
done
for name in "${output_names[@]}"; do
  target="$anchored_out/$name"
  root_checks_validate_files "$anchored_out" "$name" || {
    echo "error: unsafe destination appeared before placing $name" >&2
    exit 1
  }
  mv -fT -- "$stage_dir/$name" "$target"
done

exec {out_fd}<&-
trap - EXIT INT TERM
cleanup_stage
echo "[root-checks] done. Regenerate the report with:"
echo "  ./diagnose.sh --resume \"$bundle\" --yes"
}

if [[ "${ROOT_CHECKS_SOURCE_ONLY:-}" != "1" ]]; then
  root_checks_main "$@"
fi
