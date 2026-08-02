#!/usr/bin/env bash
# Publish root-staged read-only evidence as the invoking, unprivileged user.
# Destination paths are user-mutable, so this helper must never run as root.
set -Eeuo pipefail
umask 077

publisher_lib_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=publish-common.sh
source "$publisher_lib_dir/publish-common.sh"

if [[ $# -ne 2 ]]; then
  echo "usage: publish-root-checks-output.sh <staging-dir> <bundle-dir>" >&2
  exit 2
fi
if ((EUID == 0)); then
  echo "error: refusing to publish root-checks output as root" >&2
  exit 4
fi
command -v node > /dev/null 2>&1 || {
  echo "error: node is required to validate root-checks evidence" >&2
  exit 4
}

stage="$1"
bundle="$2"
[[ -d "$stage" && ! -L "$stage" && -r "$stage" && -x "$stage" ]] || {
  echo "error: unsafe root-checks staging directory" >&2
  exit 1
}
[[ "$(stat -Lc '%u:%a' -- "$stage" 2> /dev/null)" == "$EUID:700" ]] || {
  echo "error: root-checks staging directory has unsafe ownership or mode" >&2
  exit 1
}
[[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" && -x "$bundle" ]] || {
  echo "error: diagnostics bundle is not a writable real directory" >&2
  exit 1
}

declare -a payload_names=(
  kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt
)
declare -a output_names=("${payload_names[@]}" root-checks.meta)
marker_name=root-checks.done

# Validate every staged byte, the exact inventory, metadata schema/order, and
# payload digests before invalidating any derived bundle output.
for name in "${output_names[@]}"; do
  source_file="$stage/$name"
  [[ -f "$source_file" && ! -L "$source_file" ]] || {
    echo "error: unsafe staged root-checks artifact: $name" >&2
    exit 1
  }
  [[ "$(stat -Lc '%u:%a:%h' -- "$source_file" 2> /dev/null)" == "$EUID:600:1" ]] || {
    echo "error: staged root-checks artifact has unsafe ownership, mode, or links: $name" >&2
    exit 1
  }
done
node "$publisher_lib_dir/root-checks-evidence.mjs" --validate-stage "$stage" || {
  echo "error: staged root-checks evidence envelope is invalid" >&2
  exit 1
}
generation="$(sed -n 's/^GENERATION=//p' "$stage/root-checks.meta")"
[[ "$generation" =~ ^[0-9a-f]{32}$ ]] || {
  echo "error: validated root-checks generation could not be read" >&2
  exit 1
}

parent="$bundle/env"
destination_dir="$parent/root"
for dir in "$parent" "$destination_dir"; do
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" && -w "$dir" && -x "$dir" ]] || {
      echo "error: refusing unsafe bundle output directory: $dir" >&2
      exit 1
    }
  fi
done

# Existing root evidence must itself have an exact, replaceable inventory.
if [[ -d "$destination_dir" && ! -L "$destination_dir" ]]; then
  [[ -r "$destination_dir" && -x "$destination_dir" ]] || {
    echo "error: root-checks destination cannot be enumerated safely" >&2
    exit 1
  }
  inventory_list="$(mktemp)" || exit 1
  cleanup_inventory_list() { rm -f -- "${inventory_list:-}"; }
  trap cleanup_inventory_list EXIT INT TERM
  if ! find "$destination_dir" -mindepth 1 -maxdepth 1 -print0 > "$inventory_list"; then
    echo "error: root-checks destination enumeration failed" >&2
    exit 1
  fi
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    case "$name" in
      kernel-warnings.txt | intel-undervolt.txt | cctk.txt | turbostat.txt | root-checks.meta | root-checks.done) ;;
      *)
        echo "error: unexpected existing root-checks destination: $name" >&2
        exit 1
        ;;
    esac
  done < "$inventory_list"
  rm -f -- "$inventory_list"
  inventory_list=""
  trap - EXIT INT TERM
fi
for name in "${output_names[@]}" "$marker_name"; do
  destination="$destination_dir/$name"
  [[ (! -e "$destination" && ! -L "$destination") || -f "$destination" || -L "$destination" ]] || {
    echo "error: root-checks destination is not replaceable: $name" >&2
    exit 1
  }
done

# A deterministic top-level temp survives SIGKILL without contaminating the
# exact env/root inventory. Its type is validated before derived invalidation.
publish_tmp="$bundle/.root-checks-publish.tmp"
[[ (! -e "$publish_tmp" && ! -L "$publish_tmp") || (-f "$publish_tmp" && ! -L "$publish_tmp") ]] || {
  echo "error: root-checks publication temp is unsafe" >&2
  exit 1
}

# This is the first bundle mutation. No stale report or manifest can remain
# authoritative while the evidence generation is replaced.
publish_invalidate_derived_outputs "$bundle" || exit 1

for dir in "$parent" "$destination_dir"; do
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    mkdir -- "$dir"
  fi
  [[ -d "$dir" && ! -L "$dir" && -w "$dir" && -x "$dir" ]] || {
    echo "error: refusing unsafe bundle output directory after invalidation: $dir" >&2
    exit 1
  }
done

# The prior generation marker is invalidated durably before the first payload
# changes. The publisher recreates a zero-byte marker only after validation.
completion_marker="$destination_dir/$marker_name"
rm -f -- "$completion_marker" || {
  echo "error: could not invalidate the old root-checks completion marker" >&2
  exit 1
}
[[ ! -e "$completion_marker" && ! -L "$completion_marker" ]] || {
  echo "error: old root-checks completion marker is still present" >&2
  exit 1
}
sync -f "$destination_dir" || {
  echo "error: could not synchronize root-checks marker invalidation" >&2
  exit 1
}

cleanup_tmp() {
  [[ -z "${publish_tmp:-}" ]] || rm -f -- "$publish_tmp"
}
trap cleanup_tmp EXIT INT TERM

publish_regular_file() {
  local source_file="$1" destination="$2"
  rm -f -- "$publish_tmp"
  (set -o noclobber; : > "$publish_tmp") 2> /dev/null || {
    echo "error: could not create root-checks publication temp" >&2
    return 1
  }
  chmod 0600 "$publish_tmp"
  cat -- "$source_file" > "$publish_tmp"
  chmod 0644 "$publish_tmp"
  sync -f "$publish_tmp"
  mv -fT -- "$publish_tmp" "$destination"
  sync -f "$destination_dir"
}

payloads_published=0
for name in "${payload_names[@]}"; do
  publish_regular_file "$stage/$name" "$destination_dir/$name"
  ((payloads_published += 1))
  if [[ "${DIAG_TEST_ROOT_PUBLISH_KILL_AFTER_FIRST_PAYLOAD:-0}" == "1" &&
    $payloads_published -eq 1 ]]; then
    kill -KILL "$BASHPID"
  fi
done
publish_regular_file "$stage/root-checks.meta" "$destination_dir/root-checks.meta"

node "$publisher_lib_dir/root-checks-evidence.mjs" --validate-before-marker "$bundle" || {
  echo "error: published root-checks payload generation failed validation" >&2
  exit 1
}

# Publish the completion marker last, after the complete payload generation is
# durable. It is the only authority that lets the collector expose the data.
rm -f -- "$publish_tmp"
(set -o noclobber; : > "$publish_tmp") 2> /dev/null || {
  echo "error: could not create root-checks marker temp" >&2
  exit 1
}
chmod 0644 "$publish_tmp"
sync -f "$publish_tmp"
mv -fT -- "$publish_tmp" "$completion_marker"
sync -f "$destination_dir"

node "$publisher_lib_dir/root-checks-evidence.mjs" --validate-complete "$bundle" || {
  rm -f -- "$completion_marker"
  sync -f "$destination_dir" || true
  echo "error: completed root-checks evidence failed final validation" >&2
  exit 1
}

publish_tmp=""
for name in "${output_names[@]}"; do rm -f -- "$stage/$name"; done
rmdir -- "$stage"
trap - EXIT INT TERM
