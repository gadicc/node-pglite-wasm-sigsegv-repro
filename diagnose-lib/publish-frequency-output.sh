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

declare -a cap_relative_files=(
  results/frequency-cap.tsv
  results/frequency-cap.meta
  freq/freq-ab-cap.samples
  freq/freq-ab-cap.method
)

publish_control="$stage/publish-control.meta"
cap_cleanup_authorized=0
if [[ -e "$publish_control" || -L "$publish_control" ]]; then
  [[ -f "$publish_control" && ! -L "$publish_control" ]] || {
    echo "error: unsafe frequency publication control" >&2
    exit 1
  }
  [[ "$(stat -Lc '%u:%a:%h:%s' -- "$publish_control" 2> /dev/null)" == "$EUID:600:1:70" ]] || {
    echo "error: frequency publication control has unsafe ownership, mode, links, or size" >&2
    exit 1
  }
  declare -a control_lines=()
  mapfile -t control_lines < "$publish_control" || {
    echo "error: could not read frequency publication control" >&2
    exit 1
  }
  [[ ${#control_lines[@]} -eq 3 && "${control_lines[0]}" == "VERSION=1" &&
    "${control_lines[1]}" =~ ^GENERATION=[0-9a-f]{32}$ &&
    "${control_lines[2]}" =~ ^CAP_REQUESTED=([01])$ ]] || {
    echo "error: malformed frequency publication control" >&2
    exit 1
  }
  control_generation="${control_lines[1]#GENERATION=}"
  control_cap_requested="${control_lines[2]#CAP_REQUESTED=}"
  control_expected_sha="$(
    printf 'VERSION=1\nGENERATION=%s\nCAP_REQUESTED=%s\n' \
      "$control_generation" "$control_cap_requested" | sha256sum
  )" || {
    echo "error: could not hash canonical frequency publication control" >&2
    exit 1
  }
  control_actual_sha="$(sha256sum -- "$publish_control")" || {
    echo "error: could not hash frequency publication control" >&2
    exit 1
  }
  control_expected_sha="${control_expected_sha%% *}"
  control_actual_sha="${control_actual_sha%% *}"
  [[ "$control_expected_sha" =~ ^[0-9a-f]{64}$ &&
    "$control_actual_sha" == "$control_expected_sha" ]] || {
    echo "error: frequency publication control is not canonical byte-for-byte" >&2
    exit 1
  }
  if [[ "$control_cap_requested" == 0 ]]; then
    cap_cleanup_authorized=1
    for rel in "${cap_relative_files[@]}"; do
      [[ ! -e "$stage/$rel" && ! -L "$stage/$rel" ]] || {
        echo "error: no-cap publication control conflicts with staged cap artifacts" >&2
        exit 1
      }
    done
  fi
fi

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

if ((cap_cleanup_authorized == 1)); then
  for rel in "${cap_relative_files[@]}"; do
    destination="$bundle/$rel"
    [[ ! -e "$destination" && ! -L "$destination" ]] && continue
    [[ -f "$destination" || -L "$destination" ]] || {
      echo "error: stale cap destination is not safely removable: $rel" >&2
      exit 1
    }
  done
fi

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

# An existing marker belongs to the previous artifact generation. Invalidate
# it before changing any evidence so interruption can only leave a generation
# that diagnose --resume must revalidate. The publisher never recreates it.
state_dir="$bundle/state"
if [[ -e "$state_dir" || -L "$state_dir" ]]; then
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || {
    echo "error: refusing unsafe bundle state directory" >&2
    exit 1
  }
else
  mkdir -- "$state_dir"
fi
[[ -w "$state_dir" ]] || {
  echo "error: bundle state directory is not writable by the invoking user" >&2
  exit 1
}
completion_marker="$state_dir/phase-frequency.done"
if ! rm -f -- "$completion_marker"; then
  echo "error: could not invalidate the previous frequency completion marker" >&2
  exit 1
fi
[[ ! -e "$completion_marker" && ! -L "$completion_marker" ]] || {
  echo "error: previous frequency completion marker is still present" >&2
  exit 1
}

if ((cap_cleanup_authorized == 1)); then
  cap_deletions_completed=0
  for rel in "${cap_relative_files[@]}"; do
    destination="$bundle/$rel"
    had_destination=0
    [[ -e "$destination" || -L "$destination" ]] && had_destination=1
    rm -f -- "$destination"
    if ((had_destination == 1)); then
      ((cap_deletions_completed += 1))
      # Test-only crash injection proves the durable control authorizes an
      # idempotent retry after only part of the stale cap set was removed.
      if [[ "${DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_CAP_DELETE:-0}" == "1" &&
        $cap_deletions_completed -eq 1 ]]; then
        kill -KILL "$BASHPID"
      fi
    fi
  done
fi

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

moves_completed=0
for rel in "${present_files[@]}"; do
  mv -fT -- "$stage/$rel" "$bundle/$rel"
  ((moves_completed += 1))
  # Test-only crash injection proves the absent marker protects a bundle left
  # between per-file moves; a real SIGKILL has the same publication state.
  if [[ "${DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_MOVE:-0}" == "1" && $moves_completed -eq 1 ]]; then
    kill -KILL "$BASHPID"
  fi
done
mv -fT -- "$commands_tmp" "$commands_destination"
commands_tmp=""
rm -f -- "$staged_commands"
[[ ! -e "$publish_control" && ! -L "$publish_control" ]] || rm -f -- "$publish_control"
rmdir -- "$stage/results" "$stage/freq" "$stage"
trap - EXIT INT TERM
