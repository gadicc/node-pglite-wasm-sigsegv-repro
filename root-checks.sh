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

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage
bundle="${1:-}"
[[ -n "$bundle" && -d "$bundle" ]] || usage

if ((EUID != 0)); then
  echo "error: this script performs privileged reads; run it with sudo." >&2
  echo "       sudo $0 $bundle" >&2
  exit 4
fi

out_dir="$bundle/env/root"
mkdir -p "$out_dir"

# cctk read-only allowlist (bare-property queries only). Labels are used
# for the report; values are the exact cctk property names.
CCTK_ALLOWLIST=(
  "TurboMode"        # turbo
  "IntelTME"         # TME
  "IntelSagv"        # System Agent Geyserville
  "Speedstep"        # SpeedStep
  "CStatesCtrl"      # C-states
  "AdaptiveCStates"  # adaptive C-states
  "ThermalManagement" # Dell performance/thermal mode
  "SpeedShift"       # Intel SpeedShift (HWP)
)

echo "[root-checks] writing privileged reads to $out_dir"

# 1. kernel warnings -------------------------------------------------------
{
  echo "# source: dmesg (as root, $(date -Is))"
  dmesg | grep -iE 'mce|machine check|edac|thermal|tme|mktme|microcode' || true
} > "$out_dir/kernel-warnings.txt"

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
} > "$out_dir/intel-undervolt.txt"

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
} > "$out_dir/cctk.txt"

# 4. turbostat sample ------------------------------------------------------
{
  if command -v turbostat > /dev/null 2>&1; then
    echo "# turbostat --Summary --quiet --interval 1 --num_iterations 5 ($(date -Is))"
    turbostat --Summary --quiet --interval 1 --num_iterations 5 2>&1 || true
  else
    echo "turbostat not installed"
  fi
} > "$out_dir/turbostat.txt"

{
  echo "date=$(date -Is)"
  echo "host_bundle=$bundle"
} > "$out_dir/root-checks.meta"

# Hand ownership back to the invoking user so the bundle stays writable.
if [[ -n "${SUDO_USER:-}" ]]; then
  chown -R "$SUDO_USER":"$(id -gn "$SUDO_USER")" "$out_dir" 2> /dev/null || true
fi

echo "[root-checks] done. Regenerate the report with:"
echo "  ./diagnose.sh --resume \"$bundle\" --yes"
