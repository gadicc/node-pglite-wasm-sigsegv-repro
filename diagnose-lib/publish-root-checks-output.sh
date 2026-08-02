#!/usr/bin/env bash
# Publish root-staged read-only evidence as the invoking, unprivileged user.
# Destination paths are user-mutable, so this helper must never run as root.
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: publish-root-checks-output.sh <staging-dir> <bundle-dir>" >&2
  exit 2
fi
if ((EUID == 0)); then
  echo "error: refusing to publish root-checks output as root" >&2
  exit 4
fi

stage="$1"
bundle="$2"
[[ -d "$stage" && ! -L "$stage" ]] || {
  echo "error: unsafe root-checks staging directory" >&2
  exit 1
}
[[ "$(stat -Lc '%u:%a' -- "$stage" 2> /dev/null)" == "$EUID:700" ]] || {
  echo "error: root-checks staging directory has unsafe ownership or mode" >&2
  exit 1
}
[[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" ]] || {
  echo "error: diagnostics bundle is not a writable real directory" >&2
  exit 1
}

parent="$bundle/env"
destination_dir="$parent/root"
for dir in "$parent" "$destination_dir"; do
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" ]] || {
      echo "error: refusing unsafe bundle output directory: $dir" >&2
      exit 1
    }
  else
    mkdir -- "$dir"
  fi
done
[[ -w "$destination_dir" ]] || {
  echo "error: root-checks output directory is not writable by the invoking user" >&2
  exit 1
}

declare -a output_names=(
  kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt root-checks.meta
)
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
  destination="$destination_dir/$name"
  [[ ! -e "$destination" || -f "$destination" || -L "$destination" ]] || {
    echo "error: root-checks destination is not replaceable: $name" >&2
    exit 1
  }
done

for name in "${output_names[@]}"; do
  chmod 0644 "$stage/$name"
  mv -fT -- "$stage/$name" "$destination_dir/$name"
done
rmdir -- "$stage"
