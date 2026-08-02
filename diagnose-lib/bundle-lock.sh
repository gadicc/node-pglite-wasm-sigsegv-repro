#!/usr/bin/env bash
# Serialize cooperating writers without adding a lock artifact to the bundle.

: "${DIAG_BUNDLE_LOCK_FD:=}"
: "${DIAG_BUNDLE_LOCK_ID:=}"

DIAG_BUNDLE_LOCK_BUSY=75

diag_bundle_lock_release() {
  [[ -n "$DIAG_BUNDLE_LOCK_FD" ]] || return 0
  exec {DIAG_BUNDLE_LOCK_FD}<&- || return 1
  DIAG_BUNDLE_LOCK_FD=""
  DIAG_BUNDLE_LOCK_ID=""
}

diag_bundle_lock_acquire() {
  local bundle="$1" lock_rc=0 path_id_before="" path_id_after="" fd_id=""

  [[ -z "$DIAG_BUNDLE_LOCK_FD" ]] || {
    echo "error: diagnostics bundle writer lock is already held" >&2
    return 1
  }
  command -v flock > /dev/null 2>&1 || {
    echo "error: flock is required to serialize diagnostics bundle writers" >&2
    return 1
  }
  [[ -d "$bundle" && ! -L "$bundle" && -r "$bundle" && -x "$bundle" ]] || {
    echo "error: diagnostics bundle lock target is not a readable real directory" >&2
    return 1
  }

  exec {DIAG_BUNDLE_LOCK_FD}< "$bundle" || {
    DIAG_BUNDLE_LOCK_FD=""
    echo "error: could not open diagnostics bundle directory for locking" >&2
    return 1
  }
  # A dedicated conflict code keeps expected contention distinct from an
  # operational flock failure (both otherwise commonly use status 1).
  flock -n -E "$DIAG_BUNDLE_LOCK_BUSY" -x "$DIAG_BUNDLE_LOCK_FD" || lock_rc=$?
  if ((lock_rc != 0)); then
    diag_bundle_lock_release || true
    if ((lock_rc == DIAG_BUNDLE_LOCK_BUSY)); then
      echo "error: another writer is active for this diagnostics bundle; retry after it exits" >&2
      return "$DIAG_BUNDLE_LOCK_BUSY"
    fi
    echo "error: could not lock diagnostics bundle directory" >&2
    return 1
  fi

  # Bind subsequent path-based validation to the directory inode that was
  # actually locked. This catches substitution between the preliminary check
  # and open without creating any persistent object inside the bundle.
  path_id_before="$(stat -Lc '%d:%i' -- "$bundle" 2> /dev/null)" || {
    diag_bundle_lock_release || true
    echo "error: could not revalidate diagnostics bundle lock target" >&2
    return 1
  }
  fd_id="$(stat -Lc '%d:%i' -- "/proc/self/fd/$DIAG_BUNDLE_LOCK_FD" 2> /dev/null)" || {
    diag_bundle_lock_release || true
    echo "error: could not inspect diagnostics bundle lock descriptor" >&2
    return 1
  }
  path_id_after="$(stat -Lc '%d:%i' -- "$bundle" 2> /dev/null)" || {
    diag_bundle_lock_release || true
    echo "error: could not complete diagnostics bundle lock target revalidation" >&2
    return 1
  }
  if [[ -z "$path_id_before" || "$path_id_before" != "$fd_id" ||
    "$path_id_after" != "$fd_id" || ! -d "$bundle" || -L "$bundle" ]]; then
    diag_bundle_lock_release || true
    echo "error: diagnostics bundle changed while its writer lock was acquired" >&2
    return 1
  fi
  DIAG_BUNDLE_LOCK_ID="$fd_id"
}
