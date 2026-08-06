#!/usr/bin/env bash
# root-checks.sh - OPTIONAL privileged *read-only* evidence collection.
#
# diagnose.sh never elevates privileges. This companion script exists so
# you can review exactly which privileged reads are taken, then run it
# yourself:
#
#   sudo ./root-checks.sh [--fresh] <diagnostics-bundle-dir>
#
# It writes plain-text files under <bundle>/env/root/ and changes nothing.
# Afterwards regenerate the report with:
#
#   ./diagnose.sh --resume <bundle> --yes
#
# Staging is deterministic per invoking user and bundle:
#
#   /tmp/root-checks.<invoking_uid>.<first 16 hex chars of sha256(bundle)>
#
# so a SIGKILL can never strand an undiscoverable privileged-read stage.
# Before anything new is staged, that path is classified and recovered:
#
#   absent        nothing there: a fresh root-owned 0700 stage is created
#   pre-handoff   root's own interrupted stage (SIGKILL before handoff):
#                 a root-owned 0700 directory holding only a subset of the
#                 five known artifact names; the leftovers are removed and
#                 the stage is reused
#   handed-off    a complete stage already owned by the invoking user
#                 (SIGKILL after handoff): republished as-is through the
#                 unprivileged publisher, which revalidates the envelope and
#                 removes the stage; root mutates nothing inside it
#   unsafe        anything else: refused; inspect and remove it manually
#
# --fresh discards a proven handed-off orphan instead of republishing it
# (ownership and exact inventory are re-verified before any deletion) and
# then continues with a fresh collection. It is a no-op for every other
# orphan class.
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

# The exact artifact inventory of a root-checks stage. The unprivileged
# publisher (diagnose-lib/publish-root-checks-output.sh) revalidates the same
# inventory before publishing anything into a bundle.
ROOT_CHECKS_PAYLOAD_NAMES=(
  kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt
)
ROOT_CHECKS_OUTPUT_NAMES=("${ROOT_CHECKS_PAYLOAD_NAMES[@]}" root-checks.meta)

usage() {
  cat >&2 << EOF
usage: sudo $0 [--fresh] <diagnostics-bundle-dir>

Stages privileged read-only evidence and publishes it under
<bundle>/env/root/ as the invoking user. The staging directory is
deterministic per invoking user and bundle, so a stage orphaned by SIGKILL
is recovered on the next run: root's own interrupted stage is cleared and
reused, and a fully handed-off stage is republished as-is.

  --fresh   discard a proven handed-off orphan (ownership and exact
            inventory re-verified before any deletion) instead of
            republishing it, then collect fresh evidence.
EOF
  exit 2
}

# root_checks_stage_identity <path>
# Prints "uid:gid:mode:links" for a staging path. This is the single seam
# through which every ownership, mode, and link decision flows, so tests
# running as non-root can override it to present fixtures as root-owned.
root_checks_stage_identity() {
  stat -Lc '%u:%g:%a:%h' -- "$1" 2> /dev/null
}

# root_checks_stage_name_is_known <name>
root_checks_stage_name_is_known() {
  local candidate="$1" name
  for name in "${ROOT_CHECKS_OUTPUT_NAMES[@]}"; do
    [[ "$candidate" == "$name" ]] && return 0
  done
  return 1
}

# root_checks_classify_existing_stage <dir>
# Prints exactly one of: absent | pre-handoff | handed-off | unsafe.
#   absent:      no such path (and no symlink)
#   pre-handoff: root-owned 0700 real directory whose entries are a subset of
#                the known artifact names, each a 0600 regular non-symlink
#                file with one link owned by root OR by the invoking user
#                (root's own interrupted stage — no unprivileged actor can
#                create entries inside a root-owned 0700 directory, so a
#                user-owned file there is provably root's own half-finished
#                handoff chown)
#   handed-off:  invoking-user-owned 0700 real directory holding EXACTLY the
#                known artifact names, each user-owned 0600, single link,
#                regular non-symlink (a fully handed-off orphaned stage)
#   unsafe:      anything else
# ROOT_CHECKS_STAGE_UID/ROOT_CHECKS_STAGE_GID identify the invoking user.
root_checks_classify_existing_stage() {
  local dir="$1"
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    printf 'absent\n'
    return 0
  fi
  if [[ -L "$dir" || ! -d "$dir" ]]; then
    printf 'unsafe\n'
    return 0
  fi
  local identity dir_uid dir_gid dir_mode rest
  identity="$(root_checks_stage_identity "$dir")"
  [[ -n "$identity" ]] || {
    printf 'unsafe\n'
    return 0
  }
  dir_uid="${identity%%:*}"
  rest="${identity#*:}"
  dir_gid="${rest%%:*}"
  rest="${rest#*:}"
  dir_mode="${rest%%:*}"
  local expected
  case "$dir_uid:$dir_gid" in
    0:0)
      expected=pre-handoff
      ;;
    "${ROOT_CHECKS_STAGE_UID:-}:${ROOT_CHECKS_STAGE_GID:-}")
      expected=handed-off
      ;;
    *)
      printf 'unsafe\n'
      return 0
      ;;
  esac
  [[ "$dir_mode" == 700 ]] || {
    printf 'unsafe\n'
    return 0
  }
  local -a entries=()
  local entry name file_identity known
  while IFS= read -r -d '' entry; do
    entries+=("$entry")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0)
  for entry in "${entries[@]}"; do
    name="${entry##*/}"
    root_checks_stage_name_is_known "$name" || {
      printf 'unsafe\n'
      return 0
    }
    [[ -f "$entry" && ! -L "$entry" ]] || {
      printf 'unsafe\n'
      return 0
    }
    file_identity="$(root_checks_stage_identity "$entry")"
    if [[ "$expected" == pre-handoff ]]; then
      # Inside a root-owned 0700 directory no unprivileged actor can create
      # entries, so a file there is provably root's own interrupted stage —
      # whether or not the per-file handoff chown had already run when the
      # process died. Accept either owner of that exact handoff pair.
      [[ "$file_identity" == "0:0:600:1" ||
        "$file_identity" == "${ROOT_CHECKS_STAGE_UID:-}:${ROOT_CHECKS_STAGE_GID:-}:600:1" ]] || {
        printf 'unsafe\n'
        return 0
      }
    else
      [[ "$file_identity" == "$dir_uid:$dir_gid:600:1" ]] || {
        printf 'unsafe\n'
        return 0
      }
    fi
  done
  if [[ "$expected" == handed-off ]]; then
    for known in "${ROOT_CHECKS_OUTPUT_NAMES[@]}"; do
      [[ -e "$dir/$known" && ! -L "$dir/$known" ]] || {
        printf 'unsafe\n'
        return 0
      }
    done
  fi
  printf '%s\n' "$expected"
}

# root_checks_stage_create <dir>
# Creates the deterministic staging directory root-owned and mode 0700 and
# re-verifies it. Fails without deleting anything if the path appeared
# between classification and creation.
root_checks_stage_create() {
  local stage_dir="$1"
  mkdir -m 0700 -- "$stage_dir" || {
    echo "error: could not create root-checks staging directory: $stage_dir" >&2
    return 1
  }
  [[ "$(root_checks_stage_identity "$stage_dir")" == "0:0:700:"* ]] || {
    echo "error: root-checks staging directory is not root-owned and mode 0700" >&2
    return 1
  }
}

# root_checks_stage_prune_pre_handoff <dir>
# Clears root's own interrupted stage: removes the known artifact names only,
# re-verifying ownership (root's or the invoking user's — the directory is
# root-owned 0700, so a file there is provably root's own staged artifact
# whether or not its handoff chown had run), type, and links immediately
# before each removal. The emptied directory is reused for the new attempt.
root_checks_stage_prune_pre_handoff() {
  local stage_dir="$1" name path
  [[ -d "$stage_dir" && ! -L "$stage_dir" ]] || {
    echo "error: interrupted root-checks stage is no longer a real directory: $stage_dir" >&2
    return 1
  }
  [[ "$(root_checks_stage_identity "$stage_dir")" == "0:0:700:"* ]] || {
    echo "error: interrupted root-checks stage changed ownership or mode: $stage_dir" >&2
    return 1
  }
  for name in "${ROOT_CHECKS_OUTPUT_NAMES[@]}"; do
    path="$stage_dir/$name"
    [[ ! -e "$path" && ! -L "$path" ]] && continue
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "error: refusing to remove non-regular staged root-checks artifact: $path" >&2
      return 1
    }
    [[ "$(root_checks_stage_identity "$path")" == "0:0:600:1" ||
      "$(root_checks_stage_identity "$path")" == \
        "${ROOT_CHECKS_STAGE_UID:-}:${ROOT_CHECKS_STAGE_GID:-}:600:1" ]] || {
      echo "error: refusing to remove staged root-checks artifact with unsafe ownership, mode, or links: $path" >&2
      return 1
    }
    rm -f -- "$path" || {
      echo "error: could not remove interrupted staged root-checks artifact: $path" >&2
      return 1
    }
  done
  echo "[root-checks] recovered an interrupted pre-handoff stage: $stage_dir" >&2
}

# root_checks_stage_republish_handed_off <dir> <bundle>
# Publishes a fully handed-off orphaned stage as-is through the unprivileged
# publisher (which revalidates the envelope and removes the stage). Root
# performs no filesystem mutation on a handed-off stage.
root_checks_stage_republish_handed_off() {
  local stage_dir="$1" bundle="$2" collected_at publish_rc=0
  # The orphan's metadata is user-controlled content: read it only as the
  # invoking user, never as root. First match wins, bounded for the notice.
  collected_at="$(runuser -u "$SUDO_USER" -- \
    sed -n 's/^COLLECTED_AT=//p' -- "$stage_dir/root-checks.meta" 2>/dev/null |
    head -1 | cut -c1-64)"
  {
    echo "[root-checks] RECOVERY: found a fully handed-off orphaned stage:"
    echo "[root-checks]   stage:     $stage_dir"
    echo "[root-checks]   collected: ${collected_at:-unknown} (root-checks.meta)"
    echo "[root-checks] publishing the orphan as-is; not collecting new evidence."
    echo "[root-checks] (rerun with --fresh to discard such an orphan and re-collect)"
  } >&2
  runuser -u "$SUDO_USER" -- /bin/bash \
    "$SCRIPT_DIR/diagnose-lib/publish-root-checks-output.sh" "$stage_dir" "$bundle" ||
    publish_rc=$?
  if ((publish_rc != 0)); then
    echo "error: could not publish orphaned root-checks evidence; invoking user owns staging directory $stage_dir" >&2
    return "$publish_rc"
  fi
}

# root_checks_stage_discard_handed_off <dir>
# --fresh handling for a handed-off orphan: re-proves the full handed-off
# classification (ownership plus exact inventory), then removes the five
# known artifacts and the directory. Refuses anything else and deletes
# nothing it cannot prove.
root_checks_stage_discard_handed_off() {
  local stage_dir="$1" name path
  [[ "$(root_checks_classify_existing_stage "$stage_dir")" == handed-off ]] || {
    echo "error: refusing to discard an unproven root-checks stage: $stage_dir" >&2
    return 1
  }
  for name in "${ROOT_CHECKS_OUTPUT_NAMES[@]}"; do
    path="$stage_dir/$name"
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "error: refusing to discard: staged root-checks artifact changed: $path" >&2
      return 1
    }
    [[ "$(root_checks_stage_identity "$path")" == \
      "${ROOT_CHECKS_STAGE_UID:-}:${ROOT_CHECKS_STAGE_GID:-}:600:1" ]] || {
      echo "error: refusing to discard: staged root-checks artifact identity changed: $path" >&2
      return 1
    }
    rm -f -- "$path" || {
      echo "error: could not discard staged root-checks artifact: $path" >&2
      return 1
    }
  done
  rmdir -- "$stage_dir" || {
    echo "error: could not remove discarded root-checks staging directory: $stage_dir" >&2
    return 1
  }
  echo "[root-checks] discarded a handed-off orphaned stage (--fresh): $stage_dir" >&2
}

# root_checks_stage_dispatch <class> <dir> <bundle> <fresh>
# Recovery dispatch for the deterministic staging path, acting on the class
# printed by root_checks_classify_existing_stage:
#   absent       -> create the stage, ready for collection (returns 0)
#   pre-handoff  -> prune known leftovers, reuse the stage (returns 0)
#   handed-off   -> fresh=1: discard the proven orphan and create a fresh
#                   stage (returns 0); fresh=0: republish the orphan as-is
#                   (returns 100: published, so the caller must NOT re-collect)
#   unsafe/other -> refuse, naming the path; nothing is deleted (returns 1)
root_checks_stage_dispatch() {
  local class="$1" stage_dir="$2" bundle="$3" fresh="${4:-0}"
  case "$class" in
    absent)
      root_checks_stage_create "$stage_dir"
      ;;
    pre-handoff)
      root_checks_stage_prune_pre_handoff "$stage_dir"
      ;;
    handed-off)
      if ((fresh)); then
        root_checks_stage_discard_handed_off "$stage_dir" &&
          root_checks_stage_create "$stage_dir"
      else
        root_checks_stage_republish_handed_off "$stage_dir" "$bundle" && return 100
      fi
      ;;
    *)
      echo "error: unsafe root-checks staging path, refusing to touch it: $stage_dir" >&2
      echo "       inspect it manually and remove it only once its contents are understood" >&2
      return 1
      ;;
  esac
}

root_checks_main() {
  local fresh=0
  if [[ "${1:-}" == "--fresh" ]]; then
    fresh=1
    shift
  fi
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
  local dependency
  for dependency in od sha256sum; do
    command -v "$dependency" > /dev/null 2>&1 || {
      echo "error: missing required command: $dependency" >&2
      exit 4
    }
  done
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
  local -a payload_names=("${ROOT_CHECKS_PAYLOAD_NAMES[@]}")
  local -a output_names=("${ROOT_CHECKS_OUTPUT_NAMES[@]}")

  # Collect outside the user-owned bundle. Root never opens or renames a
  # destination beneath the bundle; final placement is delegated below.
  # The stage path is deterministic per invoking user and bundle (see the
  # header), so an attempt interrupted by SIGKILL is always discoverable:
  # classify whatever is already there and recover it before staging anew.
  local stage_dir
  stage_dir="/tmp/root-checks.${invoking_uid}.$(printf '%s' "$bundle" | sha256sum | cut -c1-16)"
  ROOT_CHECKS_STAGE_UID="$invoking_uid"
  ROOT_CHECKS_STAGE_GID="$invoking_gid"
  local stage_class dispatch_rc=0
  stage_class="$(root_checks_classify_existing_stage "$stage_dir")"
  root_checks_stage_dispatch "$stage_class" "$stage_dir" "$bundle" "$fresh" ||
    dispatch_rc=$?
  case "$dispatch_rc" in
    0)
      ;;
    100)
      echo "[root-checks] done. Regenerate the report with:"
      echo "  ./diagnose.sh --resume \"$bundle\" --yes"
      return 0
      ;;
    *)
      return "$dispatch_rc"
      ;;
  esac
  [[ "$(root_checks_stage_identity "$stage_dir")" == "0:0:700:"* ]] || {
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

local generation collected_at kernel_sha undervolt_sha cctk_sha turbostat_sha
generation="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" || {
  echo "error: could not generate a root-checks evidence generation" >&2
  exit 1
}
[[ "$generation" =~ ^[0-9a-f]{32}$ ]] || {
  echo "error: generated root-checks evidence generation is malformed" >&2
  exit 1
}
collected_at="$(date -Is)" || exit 1
kernel_sha="$(sha256sum -- "$stage_dir/kernel-warnings.txt")" || exit 1
undervolt_sha="$(sha256sum -- "$stage_dir/intel-undervolt.txt")" || exit 1
cctk_sha="$(sha256sum -- "$stage_dir/cctk.txt")" || exit 1
turbostat_sha="$(sha256sum -- "$stage_dir/turbostat.txt")" || exit 1
kernel_sha="${kernel_sha%% *}"
undervolt_sha="${undervolt_sha%% *}"
cctk_sha="${cctk_sha%% *}"
turbostat_sha="${turbostat_sha%% *}"
{
  printf 'VERSION=1\n'
  printf 'GENERATION=%s\n' "$generation"
  printf 'COLLECTED_AT=%s\n' "$collected_at"
  printf 'KERNEL_WARNINGS_SHA256=%s\n' "$kernel_sha"
  printf 'INTEL_UNDERVOLT_SHA256=%s\n' "$undervolt_sha"
  printf 'CCTK_SHA256=%s\n' "$cctk_sha"
  printf 'TURBOSTAT_SHA256=%s\n' "$turbostat_sha"
  printf 'COMPLETED=1\n'
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
local publish_rc=0
runuser -u "$SUDO_USER" -- /bin/bash \
  "$SCRIPT_DIR/diagnose-lib/publish-root-checks-output.sh" "$stage_dir" "$bundle" || publish_rc=$?
if ((publish_rc != 0)); then
  echo "error: could not publish root-checks evidence; invoking user owns staging directory $stage_dir" >&2
  return "$publish_rc"
fi
stage_dir=""
trap - INT TERM
echo "[root-checks] done. Regenerate the report with:"
echo "  ./diagnose.sh --resume \"$bundle\" --yes"
}

if [[ "${ROOT_CHECKS_SOURCE_ONLY:-}" != "1" ]]; then
  root_checks_main "$@"
fi
