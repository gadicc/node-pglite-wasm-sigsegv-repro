#!/usr/bin/env bash
# Shared fail-closed helpers for unprivileged companion-output publishers.

publish_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bundle-lock.sh
source "$publish_common_dir/bundle-lock.sh"
unset publish_common_dir

publish_invalidate_derived_outputs() {
  local bundle="$1" path
  local -a derived=(manifest.txt privacy-review.txt results.json report.md)

  [[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" ]] || {
    echo "error: diagnostics bundle is not a writable real directory" >&2
    return 1
  }

  # Validate the entire deletion set before removing the manifest. A directory,
  # FIFO, device, or socket must not turn invalidation into a partial deletion.
  for path in "${derived[@]}"; do
    path="$bundle/$path"
    [[ ! -e "$path" && ! -L "$path" ]] && continue
    [[ -f "$path" || -L "$path" ]] || {
      echo "error: derived bundle output is not safely removable: ${path##*/}" >&2
      return 1
    }
  done

  path="$bundle/manifest.txt"
  rm -f -- "$path" || {
    echo "error: could not invalidate stale bundle manifest" >&2
    return 1
  }
  [[ ! -e "$path" && ! -L "$path" ]] || {
    echo "error: stale bundle manifest is still present" >&2
    return 1
  }
  # Make manifest invalidation durable before any evidence can be changed.
  sync -f "$bundle" || {
    echo "error: could not synchronize stale manifest invalidation" >&2
    return 1
  }

  # Test-only crash injection exercises the safety boundary shared by both
  # publishers. At this point no evidence, marker, directory, or log changed.
  if [[ "${DIAG_TEST_PUBLISH_KILL_AFTER_MANIFEST_INVALIDATION:-0}" == "1" ]]; then
    kill -KILL "$BASHPID"
  fi

  for path in privacy-review.txt results.json report.md; do
    path="$bundle/$path"
    rm -f -- "$path" || {
      echo "error: could not invalidate stale derived output: ${path##*/}" >&2
      return 1
    }
    [[ ! -e "$path" && ! -L "$path" ]] || {
      echo "error: stale derived output is still present: ${path##*/}" >&2
      return 1
    }
  done
  sync -f "$bundle" || {
    echo "error: could not synchronize derived-output invalidation" >&2
    return 1
  }
}
