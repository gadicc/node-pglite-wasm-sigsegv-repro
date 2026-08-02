#!/usr/bin/env bash
# Publish root-staged frequency evidence as the invoking, unprivileged user.
# This helper must never run as root: destination paths belong to the user and
# may change at any time, so all final opens and renames use only user authority.
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: publish-frequency-output.sh <staging-dir> <bundle-dir>" >&2
  exit 2
fi
if ((EUID == 0)); then
  echo "error: refusing to publish frequency output as root" >&2
  exit 4
fi

stage="$1"
bundle="$2"
[[ -d "$stage" && ! -L "$stage" ]] || {
  echo "error: unsafe frequency staging directory" >&2
  exit 1
}
[[ "$(stat -Lc '%u:%a' -- "$stage" 2> /dev/null)" == "$EUID:700" ]] || {
  echo "error: frequency staging directory has unsafe ownership or mode" >&2
  exit 1
}
[[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" ]] || {
  echo "error: diagnostics bundle is not a writable real directory" >&2
  exit 1
}

for dir in results freq; do
  target_dir="$bundle/$dir"
  if [[ -e "$target_dir" || -L "$target_dir" ]]; then
    [[ -d "$target_dir" && ! -L "$target_dir" ]] || {
      echo "error: unsafe bundle output directory: $dir" >&2
      exit 1
    }
  else
    mkdir -- "$target_dir"
  fi
done

declare -a relative_files=(
  results/frequency-ab.tsv
  results/frequency-ab.meta
  results/frequency-cap.tsv
  results/frequency-cap.meta
)
for tag in A1 B A2 cap; do
  relative_files+=("freq/freq-ab-${tag}.samples" "freq/freq-ab-${tag}.method")
done

declare -a present_files=()
for rel in "${relative_files[@]}"; do
  source_file="$stage/$rel"
  [[ -e "$source_file" || -L "$source_file" ]] || continue
  [[ -f "$source_file" && ! -L "$source_file" ]] || {
    echo "error: unsafe staged frequency artifact: $rel" >&2
    exit 1
  }
  [[ "$(stat -Lc '%u:%a:%h' -- "$source_file" 2> /dev/null)" == "$EUID:600:1" ]] || {
    echo "error: staged frequency artifact has unsafe ownership, mode, or links: $rel" >&2
    exit 1
  }
  destination="$bundle/$rel"
  [[ ! -e "$destination" || -f "$destination" || -L "$destination" ]] || {
    echo "error: bundle frequency destination is not replaceable: $rel" >&2
    exit 1
  }
  present_files+=("$rel")
done

staged_commands="$stage/commands.log"
[[ -f "$staged_commands" && ! -L "$staged_commands" ]] || {
  echo "error: staged command log is unsafe" >&2
  exit 1
}
[[ "$(stat -Lc '%u:%a:%h' -- "$staged_commands" 2> /dev/null)" == "$EUID:600:1" ]] || {
  echo "error: staged command log has unsafe ownership, mode, or links" >&2
  exit 1
}

commands_destination="$bundle/commands.log"
[[ ! -L "$commands_destination" && ( ! -e "$commands_destination" || -f "$commands_destination" ) ]] || {
  echo "error: refusing unsafe bundle command-log destination" >&2
  exit 1
}
commands_tmp="$(mktemp "$bundle/.frequency-commands.XXXXXX")"
cleanup_tmp() {
  [[ -z "${commands_tmp:-}" ]] || rm -f -- "$commands_tmp"
}
trap cleanup_tmp EXIT INT TERM
if [[ -f "$commands_destination" ]]; then
  cat -- "$commands_destination" > "$commands_tmp"
  if [[ -s "$commands_destination" && -s "$staged_commands" ]]; then
    printf '\n' >> "$commands_tmp"
  fi
fi
cat -- "$staged_commands" >> "$commands_tmp"

for rel in "${present_files[@]}"; do
  mv -fT -- "$stage/$rel" "$bundle/$rel"
done
mv -fT -- "$commands_tmp" "$commands_destination"
commands_tmp=""
rm -f -- "$staged_commands"
rmdir -- "$stage/results" "$stage/freq" "$stage"
trap - EXIT INT TERM
