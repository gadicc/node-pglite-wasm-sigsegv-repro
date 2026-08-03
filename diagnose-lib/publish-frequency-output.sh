#!/usr/bin/env bash
# Publish root-staged frequency evidence as the invoking, unprivileged user.
# This helper must never run as root: destination paths belong to the user and
# may change at any time, so all final opens and renames use only user authority.
set -Eeuo pipefail
umask 077

publisher_lib_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=publish-common.sh
source "$publisher_lib_dir/publish-common.sh"
# shellcheck source=publish-frequency-transaction.sh
source "$publisher_lib_dir/publish-frequency-transaction.sh"

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
  unsafe_stage_rc=76
  if [[ -e "$stage/publish-journal.tsv" || -L "$stage/publish-journal.tsv" ||
    -e "$bundle/.frequency-publish.pending" || -L "$bundle/.frequency-publish.pending" ]]; then
    unsafe_stage_rc=1
  fi
  exit "$unsafe_stage_rc"
}
[[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" && -x "$bundle" ]] || {
  echo "error: diagnostics bundle is not a writable real directory" >&2
  exit 1
}

lock_rc=0
diag_bundle_lock_acquire "$bundle" || lock_rc=$?
((lock_rc == 0)) || exit "$lock_rc"

# Exit 76 identifies an unsafe or malformed staging payload. Ordinary
# environment, destination, and journal conflicts remain retryable.
publish_rc=0
publish_frequency_transaction "$stage" "$bundle" || publish_rc=$?
exit "$publish_rc"
