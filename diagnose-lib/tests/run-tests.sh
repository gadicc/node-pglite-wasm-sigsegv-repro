#!/usr/bin/env bash
# run-tests.sh - test suite for the diagnostic runner tooling.
#
# Covers: CPU-list parsing, settings restore on SIGINT/SIGTERM/normal exit,
# script argument validation and exit codes, statistics, log/capture
# parsing, and an end-to-end collect+report run on a synthetic bundle.
# Nothing here runs the actual crash workload.
set -u

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/diagnose-lib"
FIX="$LIB/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1" >&2
}

check_eq() {
  # check_eq <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else
    bad "$1 (expected [$2], got [$3])"
  fi
}

# shellcheck source=../common.sh
source "$LIB/common.sh"

echo "== cpulist helpers =="
check_eq "expand ranges" $'0\n1\n2\n3\n8\n10\n11' "$(diag_cpulist_expand '0-3,8,10-11')"
check_eq "expand single" "5" "$(diag_cpulist_expand '5')"
mkdir -p "$TMP/canonical/base/bundle"
check_eq "canonical directory survives later cwd changes" "$TMP/canonical/base/bundle" "$(cd "$TMP/canonical" && diag_canonical_dir base/bundle)"
check_eq "compress" "0-3,8,10-11" "$(diag_cpulist_expand '0-3,8,10-11' | sort -n | diag_cpulist_compress)"
check_eq "compress single" "5" "$(printf '5\n' | diag_cpulist_compress)"
check_eq "count" "24" "$(diag_cpulist_count '0-23')"
check_eq "intersect CPU lists" "2-3" "$(diag_cpulist_intersect '0-7' '2-3,8')"
if diag_cpulist_contains '2-3,8' 8 && ! diag_cpulist_contains '2-3,8' 7; then
  ok "CPU-list membership"
else
  bad "CPU-list membership"
fi
if (diag_cpulist_expand 'bogus') 2> /dev/null; then
  bad "expand rejects garbage"
else
  ok "expand rejects garbage"
fi

echo "== settings restore on simulated interruption =="
run_restore_case() {
  # run_restore_case <signal|EXIT>; echoes value|rc|ready|ledger-empty|seconds|sampler-gone
  local sig="$1"
  local dir
  dir="$(mktemp -d "$TMP/restore.XXXXXX")"
  printf '0\n' > "$dir/no_turbo"
  local ready=0 start=$SECONDS rc
  if [[ "$sig" == "EXIT" ]]; then
    bash "$FIX/restore-child.sh" "$REPO_ROOT" "$dir/restore.tsv" "$dir/no_turbo" "$dir/ready" exit-now \
      > /dev/null 2>&1
    rc=$?
  else
    # The foreground fixture schedules its own signal after it has armed the
    # traps and published readiness. This avoids asynchronous-job signal
    # dispositions and parent/exec races in the test harness.
    bash "$FIX/restore-child.sh" "$REPO_ROOT" "$dir/restore.tsv" "$dir/no_turbo" "$dir/ready" "signal:$sig" \
      > /dev/null 2>&1
    rc=$?
  fi
  [[ -f "$dir/ready" ]] && ready=1
  local ledger_empty=0 sampler_gone=0 sampler_pid=""
  [[ ! -s "$dir/restore.tsv" ]] && ledger_empty=1
  sampler_pid="$(cat "$dir/ready" 2> /dev/null || true)"
  [[ -n "$sampler_pid" ]] && ! kill -0 "$sampler_pid" 2> /dev/null && sampler_gone=1
  printf '%s|%s|%s|%s|%s|%s\n' "$(cat "$dir/no_turbo")" "$rc" "$ready" "$ledger_empty" "$((SECONDS - start))" "$sampler_gone"
}
term_restore="$(run_restore_case TERM)"
int_restore="$(run_restore_case INT)"
exit_restore="$(run_restore_case EXIT)"
check_eq "SIGTERM restores promptly with rc=143 and reaps sampler" "1" "$([[ "$term_restore" =~ ^0\|143\|1\|1\|([0-4])\|1$ ]] && echo 1 || echo 0)"
check_eq "SIGINT restores promptly with rc=130 and reaps sampler" "1" "$([[ "$int_restore" =~ ^0\|130\|1\|1\|([0-4])\|1$ ]] && echo 1 || echo 0)"
check_eq "normal exit restores and reaps sampler" "1" "$([[ "$exit_restore" =~ ^0\|0\|1\|1\|([0-4])\|1$ ]] && echo 1 || echo 0)"

CLEANUP_ARTIFACT_MARKER="$TMP/cleanup-artifacts.marker"
(
  DIAG_WORKLOAD_PID=""
  DIAG_SAMPLER_PID=""
  DIAG_RESTORE_ARMED=0
  DIAG_RESTORE_LOCK_FILE=""
  diag_cleanup_artifacts() {
    printf 'partial evidence\n' > "$CLEANUP_ARTIFACT_MARKER"
  }
  diag_cleanup_signal SIGTERM 143
) > /dev/null 2>&1
cleanup_artifact_rc=$?
check_eq "handled interruption runs artifact cleanup hook" "1" \
  "$([[ $cleanup_artifact_rc -eq 143 && "$(cat "$CLEANUP_ARTIFACT_MARKER" 2> /dev/null)" == "partial evidence" ]] && echo 1 || echo 0)"

WORKLOAD_SIGNAL_DIR="$TMP/workload-signal"
mkdir -p "$WORKLOAD_SIGNAL_DIR/bin"
printf '0\n' > "$WORKLOAD_SIGNAL_DIR/no_turbo"
cat > "$WORKLOAD_SIGNAL_DIR/bin/taskset" << 'EOF'
#!/usr/bin/env bash
[[ "$1" == "-c" ]] || exit 2
shift 2
exec "$@"
EOF
cat > "$WORKLOAD_SIGNAL_DIR/bin/node" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "$WORKLOAD_PID_FILE"
exec sleep 300
EOF
chmod +x "$WORKLOAD_SIGNAL_DIR/bin/taskset" "$WORKLOAD_SIGNAL_DIR/bin/node"
workload_signal_start=$SECONDS
bash "$FIX/workload-restore-child.sh" \
  "$REPO_ROOT" \
  "$WORKLOAD_SIGNAL_DIR/restore.tsv" \
  "$WORKLOAD_SIGNAL_DIR/no_turbo" \
  "$WORKLOAD_SIGNAL_DIR/ready" \
  "$WORKLOAD_SIGNAL_DIR/bin" > /dev/null 2>&1
workload_signal_rc=$?
workload_signal_elapsed=$((SECONDS - workload_signal_start))
workload_signal_pid="$(cat "$WORKLOAD_SIGNAL_DIR/ready" 2> /dev/null || true)"
workload_signal_gone=0
[[ -n "$workload_signal_pid" ]] && ! kill -0 "$workload_signal_pid" 2> /dev/null && workload_signal_gone=1
check_eq "SIGTERM interrupts external workload and promptly restores" "1" \
  "$([[ $workload_signal_rc -eq 143 && "$(cat "$WORKLOAD_SIGNAL_DIR/no_turbo")" == 0 && $workload_signal_elapsed -le 5 && $workload_signal_gone -eq 1 ]] && echo 1 || echo 0)"

echo "== fail-closed settings restore =="
RESTORE_FAIL_DIR="$TMP/restore-fail"
mkdir -p "$RESTORE_FAIL_DIR"
printf 'original\n' > "$RESTORE_FAIL_DIR/value"
printf '%s\toriginal\n' "$RESTORE_FAIL_DIR/value" > "$RESTORE_FAIL_DIR/restore.tsv"
(
  DIAG_RESTORE_FILE="$RESTORE_FAIL_DIR/restore.tsv"
  DIAG_RESTORE_ARMED=1
  diag_restore_rules_set "$RESTORE_FAIL_DIR/value" '^original$'
  diag_sysfs_write() { return 1; }
  diag_restore_now
) > /dev/null 2>&1
restore_write_rc=$?
check_eq "restore write failure returns nonzero" "1" "$([[ $restore_write_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "restore write failure retains ledger" "1" "$([[ -s "$RESTORE_FAIL_DIR/restore.tsv" ]] && echo 1 || echo 0)"

printf 'changed\n' > "$RESTORE_FAIL_DIR/value"
(
  DIAG_RESTORE_FILE="$RESTORE_FAIL_DIR/restore.tsv"
  DIAG_RESTORE_ARMED=1
  diag_restore_rules_set "$RESTORE_FAIL_DIR/value" '^original$'
  diag_sysfs_write() { return 0; }
  diag_restore_now
) > /dev/null 2>&1
restore_verify_rc=$?
check_eq "restore readback mismatch returns nonzero" "1" "$([[ $restore_verify_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "restore readback mismatch retains ledger" "1" "$([[ -s "$RESTORE_FAIL_DIR/restore.tsv" ]] && echo 1 || echo 0)"

RECOVER_DIR="$TMP/recover-pending"
mkdir -p "$RECOVER_DIR"
printf 'changed\n' > "$RECOVER_DIR/value"
printf '%s\toriginal\n' "$RECOVER_DIR/value" > "$RECOVER_DIR/restore.tsv"
(
  DIAG_RESTORE_FILE="$RECOVER_DIR/restore.tsv"
  DIAG_RESTORE_ARMED=0
  DIAG_SUDO=""
  diag_restore_rules_set "$RECOVER_DIR/value" '^original$'
  diag_recover_pending_restore
) > /dev/null 2>&1
recover_rc=$?
check_eq "pending SIGKILL ledger is recovered before new work" "1" "$([[ $recover_rc -eq 0 && "$(cat "$RECOVER_DIR/value")" == original ]] && echo 1 || echo 0)"
check_eq "successful pending recovery clears ledger" "1" "$([[ ! -s "$RECOVER_DIR/restore.tsv" ]] && echo 1 || echo 0)"

UNARMED_DIR="$TMP/unarmed-restore"
mkdir -p "$UNARMED_DIR"
printf 'safe\n' > "$UNARMED_DIR/victim"
printf '%s\tpwned\n' "$UNARMED_DIR/victim" > "$UNARMED_DIR/restore.tsv"
(
  DIAG_RESTORE_FILE="$UNARMED_DIR/restore.tsv"
  DIAG_RESTORE_ARMED=0
  diag_restore_now
) > /dev/null 2>&1
check_eq "unarmed restore ledger is inert" "1" "$([[ "$(cat "$UNARMED_DIR/victim")" == safe && -s "$UNARMED_DIR/restore.tsv" ]] && echo 1 || echo 0)"

(
  DIAG_RESTORE_FILE="$UNARMED_DIR/restore.tsv"
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  [[ -z "$DIAG_RESTORE_FILE" ]]
  diagnose_cleanup_exit 0
) > /dev/null 2>&1
diagnose_restore_rc=$?
check_eq "diagnose.sh discards inherited restore authority" "1" "$([[ $diagnose_restore_rc -eq 0 && "$(cat "$UNARMED_DIR/victim")" == safe ]] && echo 1 || echo 0)"

LEDGER_GUARD_DIR="$TMP/ledger-guard"
mkdir -p "$LEDGER_GUARD_DIR"
printf 'safe\n' > "$LEDGER_GUARD_DIR/victim"
printf '%s\tpwned\n' "$LEDGER_GUARD_DIR/victim" > "$LEDGER_GUARD_DIR/restore.tsv"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv" /sys/allowed '^[01]$'; then
  ledger_guard_rc=0
else
  ledger_guard_rc=$?
fi
check_eq "restore ledger rejects arbitrary paths" "1" "$([[ $ledger_guard_rc -ne 0 && "$(cat "$LEDGER_GUARD_DIR/victim")" == safe ]] && echo 1 || echo 0)"
printf '/sys/allowed\t1\textra\n' > "$LEDGER_GUARD_DIR/restore.tsv"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv" /sys/allowed '^[01]$'; then
  malformed_ledger_rc=0
else
  malformed_ledger_rc=$?
fi
check_eq "restore ledger rejects malformed rows" "1" "$([[ $malformed_ledger_rc -ne 0 ]] && echo 1 || echo 0)"
printf '/sys/allowed\t1' > "$LEDGER_GUARD_DIR/restore.tsv"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv" /sys/allowed '^[01]$'; then
  unterminated_valid_rc=0
else
  unterminated_valid_rc=$?
fi
check_eq "restore ledger processes an allowlisted row without final newline" "0" "$unterminated_valid_rc"
printf '%s\tpwned' "$LEDGER_GUARD_DIR/victim" > "$LEDGER_GUARD_DIR/restore.tsv"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv" /sys/allowed '^[01]$'; then
  unterminated_forbidden_rc=0
else
  unterminated_forbidden_rc=$?
fi
check_eq "restore ledger rejects a forbidden row without final newline" "1" \
  "$([[ $unterminated_forbidden_rc -ne 0 ]] && echo 1 || echo 0)"
printf '\0' > "$LEDGER_GUARD_DIR/restore.tsv"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv" /sys/allowed '^[01]$'; then
  zero_row_ledger_rc=0
else
  zero_row_ledger_rc=$?
fi
check_eq "nonempty restore ledger cannot validate zero rows" "1" \
  "$([[ $zero_row_ledger_rc -ne 0 ]] && echo 1 || echo 0)"
printf '/sys/allowed\t1\n' > "$LEDGER_GUARD_DIR/real-ledger"
ln -s "$LEDGER_GUARD_DIR/real-ledger" "$LEDGER_GUARD_DIR/restore.tsv.symlink"
if diag_restore_ledger_is_valid "$LEDGER_GUARD_DIR/restore.tsv.symlink" /sys/allowed '^[01]$'; then
  symlink_ledger_rc=0
else
  symlink_ledger_rc=$?
fi
check_eq "restore ledger rejects symlinks" "1" "$([[ $symlink_ledger_rc -ne 0 ]] && echo 1 || echo 0)"

SNAPSHOT_DIR="$TMP/restore-snapshot"
mkdir -p "$SNAPSHOT_DIR"
printf 'changed\n' > "$SNAPSHOT_DIR/allowed"
printf 'safe\n' > "$SNAPSHOT_DIR/victim"
printf '%s\toriginal\n%s\tpwned\n' \
  "$SNAPSHOT_DIR/allowed" "$SNAPSHOT_DIR/victim" > "$SNAPSHOT_DIR/restore.tsv"
(
  DIAG_RESTORE_FILE="$SNAPSHOT_DIR/restore.tsv"
  DIAG_RESTORE_ARMED=1
  diag_restore_rules_set "$SNAPSHOT_DIR/allowed" '^original$'
  diag_sysfs_write() { touch "$SNAPSHOT_DIR/write-attempted"; return 0; }
  diag_restore_now
) > /dev/null 2>&1
snapshot_guard_rc=$?
check_eq "restore validates the complete snapshot before its first write" "1" \
  "$([[ $snapshot_guard_rc -ne 0 && ! -e "$SNAPSHOT_DIR/write-attempted" && "$(cat "$SNAPSHOT_DIR/victim")" == safe && -s "$SNAPSHOT_DIR/restore.tsv" ]] && echo 1 || echo 0)"

PRIVATE_STATE_DIR="$TMP/private-restore-state"
test_uid="$(id -u)"
test_gid="$(id -g)"
diag_restore_private_dir_prepare "$PRIVATE_STATE_DIR" "$test_uid" "$test_gid"
check_eq "restore state directory is private and correctly owned" \
  "$test_uid:$test_gid:700" "$(stat -Lc '%u:%g:%a' "$PRIVATE_STATE_DIR")"
chmod 0755 "$PRIVATE_STATE_DIR"
if diag_restore_private_dir_prepare "$PRIVATE_STATE_DIR" "$test_uid" "$test_gid"; then
  unsafe_state_dir_rc=0
else
  unsafe_state_dir_rc=$?
fi
check_eq "restore state directory rejects unsafe mode" "1" \
  "$([[ $unsafe_state_dir_rc -ne 0 ]] && echo 1 || echo 0)"
chmod 0700 "$PRIVATE_STATE_DIR"
diag_restore_private_file_prepare "$PRIVATE_STATE_DIR/restore.tsv" "$test_uid" "$test_gid"
check_eq "restore state file is private, owned, and singly linked" \
  "$test_uid:$test_gid:600:1" "$(stat -Lc '%u:%g:%a:%h' "$PRIVATE_STATE_DIR/restore.tsv")"
ln "$PRIVATE_STATE_DIR/restore.tsv" "$PRIVATE_STATE_DIR/restore-hardlink.tsv"
if diag_restore_private_file_is_safe "$PRIVATE_STATE_DIR/restore.tsv" "$test_uid" "$test_gid"; then
  hardlink_state_rc=0
else
  hardlink_state_rc=$?
fi
check_eq "restore state file rejects additional hard links" "1" \
  "$([[ $hardlink_state_rc -ne 0 ]] && echo 1 || echo 0)"
rm "$PRIVATE_STATE_DIR/restore-hardlink.tsv"

diag_restore_lock_acquire "$PRIVATE_STATE_DIR/active.lock" "$test_uid" "$test_gid"
bash -c '
  source "$1"
  diag_restore_lock_acquire "$2" "$3" "$4"
' _ "$LIB/common.sh" "$PRIVATE_STATE_DIR/active.lock" "$test_uid" "$test_gid" > /dev/null 2>&1
concurrent_lock_rc=$?
check_eq "per-user restore lock refuses a concurrent experiment" "1" \
  "$([[ $concurrent_lock_rc -ne 0 ]] && echo 1 || echo 0)"
diag_restore_lock_release

printf 'malformed\n' > "$PRIVATE_STATE_DIR/active.lock"
chmod 0600 "$PRIVATE_STATE_DIR/active.lock"
if diag_restore_lock_acquire "$PRIVATE_STATE_DIR/active.lock" "$test_uid" "$test_gid" 2> /dev/null; then
  malformed_lock_rc=0
else
  malformed_lock_rc=$?
fi
check_eq "malformed restore lock fails closed" "1" \
  "$([[ $malformed_lock_rc -ne 0 ]] && echo 1 || echo 0)"
rm "$PRIVATE_STATE_DIR/active.lock"

stale_ready="$PRIVATE_STATE_DIR/stale-ready"
stale_fifo="$PRIVATE_STATE_DIR/stale-fifo"
mkfifo "$stale_fifo"
bash -c '
  set -u
  source "$1"
  diag_restore_lock_acquire "$2" "$3" "$4"
  printf "ready\n" > "$5"
  exec {block_fd}<> "$6"
  read -r -u "$block_fd" _
' _ "$LIB/common.sh" "$PRIVATE_STATE_DIR/active.lock" "$test_uid" "$test_gid" \
  "$stale_ready" "$stale_fifo" > /dev/null 2>&1 &
stale_owner_pid=$!
stale_ready_seen=0
for _ in {1..100}; do
  if [[ -s "$stale_ready" ]]; then
    stale_ready_seen=1
    break
  fi
  sleep 0.01
done
kill -KILL "$stale_owner_pid" 2> /dev/null || true
wait "$stale_owner_pid" 2> /dev/null || true
diag_restore_lock_acquire "$PRIVATE_STATE_DIR/active.lock" "$test_uid" "$test_gid"
stale_recovery_rc=$?
diag_restore_lock_release
check_eq "dead experiment lock is reclaimed for SIGKILL recovery" "1" \
  "$([[ $stale_ready_seen -eq 1 && $stale_recovery_rc -eq 0 ]] && echo 1 || echo 0)"
rm -f "$stale_fifo"

(
  diag_require_not_symlink "$LEDGER_GUARD_DIR/restore.tsv.symlink"
) > /dev/null 2>&1
check_eq "privileged output guard rejects symlinks" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

echo "== single.sh validation =="
bash "$REPO_ROOT/single.sh" abc > /dev/null 2>&1
check_eq "single.sh rejects non-numeric cpu (rc=2)" "2" "$?"
bash "$REPO_ROOT/single.sh" 0 0 > /dev/null 2>&1
check_eq "single.sh rejects zero runs (rc=2)" "2" "$?"

echo "== capture-fault.sh exit codes =="
bash "$REPO_ROOT/capture-fault.sh" > /dev/null 2>&1
check_eq "capture-fault.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 x 1 "$TMP/out" > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-numeric runs (rc=2)" "2" "$?"
# Missing dependency: a PATH containing everything except gdb.
mkdir -p "$TMP/bin"
for c in bash grep rm mkdir cat date head tail sort find xargs timeout taskset node tee awk sed chmod tac printf; do
  src="$(command -v "$c" 2> /dev/null || true)"
  [[ -n "$src" && -x "$src" ]] && ln -sf "$src" "$TMP/bin/$c"
done
if command -v gdb > /dev/null 2>&1; then
  PATH="$TMP/bin" bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" > /dev/null 2>&1
  check_eq "capture-fault.sh missing gdb (rc=4)" "4" "$?"
else
  ok "capture-fault.sh missing gdb (rc=4) [skipped: gdb absent anyway]"
fi

echo "== privileged companion script guards =="
bash "$REPO_ROOT/frequency-ab.sh" > /dev/null 2>&1
check_eq "frequency-ab.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/root-checks.sh" > /dev/null 2>&1
check_eq "root-checks.sh usage error (rc=2)" "2" "$?"
if ((EUID != 0)); then
  (cd "$REPO_ROOT" && bash ./frequency-ab.sh 19 1 "$TMP") > /dev/null 2>&1
  check_eq "frequency-ab.sh refuses non-root (rc=4)" "4" "$?"
  bash "$REPO_ROOT/root-checks.sh" "$TMP" > /dev/null 2>&1
  check_eq "root-checks.sh refuses non-root (rc=4)" "4" "$?"

  PUBLISH_BUNDLE="$TMP/frequency-publish-bundle"
  PUBLISH_STAGE="$TMP/frequency-publish-stage"
  mkdir -p "$PUBLISH_BUNDLE/results" "$PUBLISH_BUNDLE/freq" \
    "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  chmod 0700 "$PUBLISH_STAGE" "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  printf 'old command\n' > "$PUBLISH_BUNDLE/commands.log"
  printf 'safe victim\n' > "$TMP/frequency-publish-victim"
  ln -s "$TMP/frequency-publish-victim" "$PUBLISH_BUNDLE/results/frequency-ab.tsv"
  printf 'new evidence\n' > "$PUBLISH_STAGE/results/frequency-ab.tsv"
  printf 'CPU=19\n' > "$PUBLISH_STAGE/results/frequency-ab.meta"
  printf 'sample\n' > "$PUBLISH_STAGE/freq/freq-ab-A1.samples"
  printf 'scaling_cur_freq\n' > "$PUBLISH_STAGE/freq/freq-ab-A1.method"
  printf 'new command\n' > "$PUBLISH_STAGE/commands.log"
  chmod 0600 \
    "$PUBLISH_STAGE/results/frequency-ab.tsv" \
    "$PUBLISH_STAGE/results/frequency-ab.meta" \
    "$PUBLISH_STAGE/freq/freq-ab-A1.samples" \
    "$PUBLISH_STAGE/freq/freq-ab-A1.method" \
    "$PUBLISH_STAGE/commands.log"
  bash "$LIB/publish-frequency-output.sh" "$PUBLISH_STAGE" "$PUBLISH_BUNDLE" \
    > /dev/null 2>&1
  publish_rc=$?
  publish_safe=0
  [[ $publish_rc -eq 0 ]] &&
    [[ "$(cat "$TMP/frequency-publish-victim")" == "safe victim" ]] &&
    [[ -f "$PUBLISH_BUNDLE/results/frequency-ab.tsv" && ! -L "$PUBLISH_BUNDLE/results/frequency-ab.tsv" ]] &&
    [[ "$(cat "$PUBLISH_BUNDLE/results/frequency-ab.tsv")" == "new evidence" ]] &&
    [[ "$(cat "$PUBLISH_BUNDLE/freq/freq-ab-A1.method")" == "scaling_cur_freq" ]] &&
    grep -q '^old command$' "$PUBLISH_BUNDLE/commands.log" &&
    grep -q '^new command$' "$PUBLISH_BUNDLE/commands.log" &&
    [[ ! -e "$PUBLISH_STAGE" ]] && publish_safe=1
  check_eq "unprivileged frequency publisher safely replaces a raced output symlink" "1" "$publish_safe"

  COMMAND_LINK_BUNDLE="$TMP/frequency-command-link-bundle"
  COMMAND_LINK_STAGE="$TMP/frequency-command-link-stage"
  mkdir -p "$COMMAND_LINK_BUNDLE/results" "$COMMAND_LINK_BUNDLE/freq" \
    "$COMMAND_LINK_STAGE/results" "$COMMAND_LINK_STAGE/freq"
  chmod 0700 "$COMMAND_LINK_STAGE" "$COMMAND_LINK_STAGE/results" "$COMMAND_LINK_STAGE/freq"
  printf 'partial command\n' > "$COMMAND_LINK_STAGE/commands.log"
  chmod 0600 "$COMMAND_LINK_STAGE/commands.log"
  printf 'safe command victim\n' > "$TMP/frequency-command-victim"
  ln -s "$TMP/frequency-command-victim" "$COMMAND_LINK_BUNDLE/commands.log"
  bash "$LIB/publish-frequency-output.sh" "$COMMAND_LINK_STAGE" "$COMMAND_LINK_BUNDLE" \
    > /dev/null 2>&1
  command_link_rc=$?
  check_eq "unprivileged frequency publisher rejects a command-log symlink" "1" \
    "$([[ $command_link_rc -ne 0 && "$(cat "$TMP/frequency-command-victim")" == "safe command victim" && -f "$COMMAND_LINK_STAGE/commands.log" ]] && echo 1 || echo 0)"
else
  ok "frequency-ab.sh non-root guard [skipped while tests run as root]"
  ok "root-checks.sh non-root guard [skipped while tests run as root]"
  ok "unprivileged frequency publisher safely replaces a raced output symlink [skipped while tests run as root]"
  ok "unprivileged frequency publisher rejects a command-log symlink [skipped while tests run as root]"
fi

ROOT_GUARD="$TMP/root-checks-guard"
mkdir -p "$ROOT_GUARD/bundle/env" "$ROOT_GUARD/redirect"
ln -s "$ROOT_GUARD/redirect" "$ROOT_GUARD/bundle/env/root"
(
  ROOT_CHECKS_SOURCE_ONLY=1
  source "$REPO_ROOT/root-checks.sh"
  root_checks_prepare_out_dir "$ROOT_GUARD/bundle"
) > /dev/null 2>&1
check_eq "root-checks rejects symlinked output directory" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
rm "$ROOT_GUARD/bundle/env/root"
mkdir "$ROOT_GUARD/bundle/env/root"
printf 'safe\n' > "$ROOT_GUARD/victim"
ln -s "$ROOT_GUARD/victim" "$ROOT_GUARD/bundle/env/root/cctk.txt"
(
  ROOT_CHECKS_SOURCE_ONLY=1
  source "$REPO_ROOT/root-checks.sh"
  root_checks_validate_destinations "$ROOT_GUARD/bundle/env/root" cctk.txt
) > /dev/null 2>&1
root_file_guard_rc=$?
check_eq "root-checks rejects symlinked output file" "1" \
  "$([[ $root_file_guard_rc -ne 0 && "$(cat "$ROOT_GUARD/victim")" == safe ]] && echo 1 || echo 0)"

echo "== --redo phase handling =="
RB="$TMP/redo-bundle"
mkdir -p "$RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n19\t2\t0\t2\n' > "$RB/results/individual.tsv"
touch "$RB/state/phase-individual.done" "$RB/state/phase-baseline.done"
printf 'MODE=quick\nINDIVIDUAL_RUNS=20\nCOMPLETED_PHASES=baseline,individual\n' > "$RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  # Set these after sourcing: diagnose.sh top-level initialises its own.
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  redo_phase individual
) > /dev/null 2>&1
redo_ok=0
[[ ! -f "$RB/results/individual.tsv" ]] &&
  [[ ! -f "$RB/state/phase-individual.done" ]] &&
  compgen -G "$RB/state/superseded/individual-*/results/individual.tsv" > /dev/null &&
  grep -q '^COMPLETED_PHASES=baseline$' "$RB/results/meta.env" && redo_ok=1
check_eq "--redo individual stashes data, clears marker" "1" "$redo_ok"

GB="$TMP/redo-gdb-bundle"
mkdir -p "$GB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\n' > "$GB/results/gdb.meta"
printf 'capture\n' > "$GB/gdb/cpu19-run1.txt"
printf 'runner\n' > "$GB/logs/gdb/runner.log"
touch "$GB/state/phase-gdb.done"
printf 'COMPLETED_PHASES=gdb\n' > "$GB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GB"
  STATE_DIR="$GB/state"
  META_FILE="$GB/results/meta.env"
  redo_phase gdb
) > /dev/null 2>&1
gdb_stash="$(find "$GB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'gdb-*' -print -quit)"
gdb_redo_ok=0
[[ -f "$gdb_stash/results/gdb.meta" ]] &&
  [[ -f "$gdb_stash/gdb/cpu19-run1.txt" ]] &&
  [[ -f "$gdb_stash/logs/gdb/runner.log" ]] &&
  [[ ! -f "$GB/state/phase-gdb.done" ]] && gdb_redo_ok=1
check_eq "--redo gdb preserves distinct capture and runner paths" "1" "$gdb_redo_ok"

FB="$TMP/redo-frequency-bundle"
mkdir -p "$FB"/{results,state,freq}
printf 'A1\t1\t0\t2\n' > "$FB/results/frequency-ab.tsv"
printf 'CPU=19\n' > "$FB/results/frequency-ab.meta"
printf 'old samples\n' > "$FB/freq/freq-ab-A1.samples"
printf 'scaling_cur_freq\n' > "$FB/freq/freq-ab-A1.method"
touch "$FB/state/phase-frequency.done"
printf 'COMPLETED_PHASES=frequency\n' > "$FB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FB"
  STATE_DIR="$FB/state"
  META_FILE="$FB/results/meta.env"
  redo_phase frequency
) > /dev/null 2>&1
frequency_stash="$(find "$FB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'frequency-*' -print -quit)"
frequency_redo_ok=0
[[ -f "$frequency_stash/results/frequency-ab.tsv" ]] &&
  [[ -f "$frequency_stash/results/frequency-ab.meta" ]] &&
  [[ "$(cat "$frequency_stash/freq/freq-ab-A1.samples")" == "old samples" ]] &&
  [[ -f "$frequency_stash/freq/freq-ab-A1.method" ]] &&
  [[ ! -e "$FB/freq/freq-ab-A1.samples" ]] && frequency_redo_ok=1
check_eq "--redo frequency preserves raw sampler evidence" "1" "$frequency_redo_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  redo_phase bogus-phase
) > /dev/null 2>&1
[[ $? -ne 0 ]]
check_eq "--redo rejects unknown phase" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  REDO_PHASES=individual
  RESUME_DIR=""
  validate_config
) > /dev/null 2>&1
[[ $? -ne 0 ]]
check_eq "--redo without --resume is rejected" "0" "$?"

INVALID_RB="$TMP/redo-invalid-bundle"
mkdir -p "$INVALID_RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n' > "$INVALID_RB/results/individual.tsv"
touch "$INVALID_RB/state/phase-individual.done"
cat > "$INVALID_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=20
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=individual
EOF
"$REPO_ROOT/diagnose.sh" --resume "$INVALID_RB" --redo individual,bogus --dry-run --yes > /dev/null 2>&1
invalid_redo_rc=$?
check_eq "mixed invalid redo list is rejected" "1" "$([[ $invalid_redo_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "invalid redo list leaves phase data in place" "1" "$([[ -f "$INVALID_RB/results/individual.tsv" && -f "$INVALID_RB/state/phase-individual.done" ]] && echo 1 || echo 0)"
redo_plan="$($REPO_ROOT/diagnose.sh --resume "$INVALID_RB" --redo individual --dry-run --yes 2>&1)"
check_eq "dry run shows the dependent redo plan" "1" "$([[ "$redo_plan" == *"redo phases        individual frequency gdb"* ]] && echo 1 || echo 0)"

DEPENDENT_RB="$TMP/redo-dependent-bundle"
mkdir -p "$DEPENDENT_RB"/{results,state,logs/groups,logs/individual,gdb,logs/gdb,freq}
printf 'groups\n' > "$DEPENDENT_RB/results/groups.tsv"
printf 'individual\n' > "$DEPENDENT_RB/results/individual.tsv"
printf 'frequency\n' > "$DEPENDENT_RB/results/frequency-ab.tsv"
printf 'gdb\n' > "$DEPENDENT_RB/results/gdb.meta"
printf 'group log\n' > "$DEPENDENT_RB/logs/groups/ecores.log"
printf 'individual log\n' > "$DEPENDENT_RB/logs/individual/cpu-19.log"
printf 'capture\n' > "$DEPENDENT_RB/gdb/cpu19-run1.txt"
printf 'runner\n' > "$DEPENDENT_RB/logs/gdb/runner.log"
printf 'sample\n' > "$DEPENDENT_RB/freq/group-ecores.samples"
printf '{}\n' > "$DEPENDENT_RB/results.json"
printf 'old report\n' > "$DEPENDENT_RB/report.md"
printf 'old manifest\n' > "$DEPENDENT_RB/manifest.txt"
touch "$DEPENDENT_RB/state/phase-"{baseline,groups,individual,frequency,gdb}.done
printf 'COMPLETED_PHASES=baseline,groups,individual,frequency,gdb\n' > "$DEPENDENT_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$DEPENDENT_RB"
  STATE_DIR="$DEPENDENT_RB/state"
  META_FILE="$DEPENDENT_RB/results/meta.env"
  REDO_PHASES=groups
  build_redo_plan
  apply_redo_plan
) > /dev/null 2>&1
dependent_redo_ok=0
[[ -f "$DEPENDENT_RB/state/phase-baseline.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-groups.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-individual.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-frequency.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-gdb.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/results.json" ]] &&
  [[ ! -e "$DEPENDENT_RB/report.md" ]] &&
  [[ ! -e "$DEPENDENT_RB/manifest.txt" ]] &&
  compgen -G "$DEPENDENT_RB/state/superseded/groups-*/results/groups.tsv" > /dev/null &&
  compgen -G "$DEPENDENT_RB/state/superseded/individual-*/results/individual.tsv" > /dev/null &&
  compgen -G "$DEPENDENT_RB/state/superseded/frequency-*/results/frequency-ab.tsv" > /dev/null &&
  compgen -G "$DEPENDENT_RB/state/superseded/gdb-*/results/gdb.meta" > /dev/null &&
  compgen -G "$DEPENDENT_RB/state/superseded/derived-*/results.json" > /dev/null &&
  grep -q '^COMPLETED_PHASES=baseline$' "$DEPENDENT_RB/results/meta.env" && dependent_redo_ok=1
check_eq "redoing groups invalidates dependent phases and reports" "1" "$dependent_redo_ok"

CONSENT_RB="$TMP/redo-consent-bundle"
mkdir -p "$CONSENT_RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n' > "$CONSENT_RB/results/individual.tsv"
printf 'old command log\n' > "$CONSENT_RB/commands.log"
touch "$CONSENT_RB/state/phase-individual.done"
cat > "$CONSENT_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=individual
EOF
cp "$CONSENT_RB/results/meta.env" "$CONSENT_RB/meta.before"
"$REPO_ROOT/diagnose.sh" --resume "$CONSENT_RB" --redo individual > /dev/null 2>&1
consent_rc=$?
consent_redo_ok=0
[[ $consent_rc -ne 0 ]] &&
  [[ -f "$CONSENT_RB/results/individual.tsv" ]] &&
  [[ -f "$CONSENT_RB/state/phase-individual.done" ]] &&
  [[ ! -e "$CONSENT_RB/state/superseded" ]] &&
  cmp -s "$CONSENT_RB/meta.before" "$CONSENT_RB/results/meta.env" &&
  [[ "$(cat "$CONSENT_RB/commands.log")" == "old command log" ]] && consent_redo_ok=1
check_eq "redo does not mutate bundle before consent" "1" "$consent_redo_ok"

COMMAND_LOG="$TMP/commands.log"
printf '+ original command\n' > "$COMMAND_LOG"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$TMP/existing-bundle"
  DIAG_COMMANDS_LOG="$COMMAND_LOG"
  prepare_commands_log
)
command_log_ok=0
grep -q '^+ original command$' "$COMMAND_LOG" &&
  grep -q '^# resumed ' "$COMMAND_LOG" && command_log_ok=1
check_eq "resume preserves command history" "1" "$command_log_ok"

END_META="$TMP/end-meta.env"
printf 'END_EPOCH=123\nEND_ISO=old\n' > "$END_META"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  META_FILE="$END_META"
  SESSION_DID_WORK=0
  persist_session_end
)
check_eq "report-only resume preserves end time" "123" "$(sed -n 's/^END_EPOCH=//p' "$END_META")"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  META_FILE="$END_META"
  SESSION_DID_WORK=1
  persist_session_end
)
end_after_work="$(sed -n 's/^END_EPOCH=//p' "$END_META")"
check_eq "resume with phase work updates end time" "1" "$([[ "$end_after_work" =~ ^[0-9]+$ && "$end_after_work" != 123 ]] && echo 1 || echo 0)"

echo "== resumed metadata validation =="
INJECTION_SENTINEL="$TMP/arithmetic-injection-ran"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  SKIP_GDB='probe[$(touch '"$INJECTION_SENTINEL"')]'
  validate_config
) > /dev/null 2>&1
injection_rc=$?
check_eq "crafted SKIP_GDB metadata is rejected" "1" "$([[ $injection_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "crafted SKIP_GDB metadata is not evaluated" "0" "$([[ -e "$INJECTION_SENTINEL" ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  MODE=unexpected
  validate_config
) > /dev/null 2>&1
invalid_mode_rc=$?
check_eq "unknown stored mode is rejected" "1" "$([[ $invalid_mode_rc -ne 0 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  REQUIRED_COMMANDS=(codex-test-command-that-does-not-exist)
  require_dependencies
) > /dev/null 2>&1
missing_required_rc=$?
check_eq "missing required command aborts preflight" "1" "$([[ $missing_required_rc -ne 0 ]] && echo 1 || echo 0)"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 3 0
)
check_eq "complete repro footer is accepted" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 4 0
) > /dev/null 2>&1
check_eq "truncated repro output is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 3 2
) > /dev/null 2>&1
check_eq "unexpected repro exit is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

INDIVIDUAL_VALID="$TMP/individual-valid.tsv"
printf '19\t1\t0\t2\n19\t2\t139\t2\n' > "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_cpu_result_is_complete "$INDIVIDUAL_VALID" 19 0 2 1
)
check_eq "complete clean/SIGSEGV individual result is accepted" "0" "$?"
printf '19\t2\t1\t0\n' >> "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_cpu_result_is_complete "$INDIVIDUAL_VALID" 19 0 3 1
) > /dev/null 2>&1
check_eq "launcher exit is rejected as individual evidence" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_cpu_result_is_complete "$INDIVIDUAL_VALID" 19 0 4 1
) > /dev/null 2>&1
check_eq "individual row deficit is rejected" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

# worst_cpu must rank by the SIGSEGV endpoint only: CPU 3 fails every run
# with a launcher-style exit 1, CPU 4 has one real SIGSEGV.
WORST_CPU_DIR="$TMP/worst-cpu-bundle"
mkdir -p "$WORST_CPU_DIR/results"
printf '3\t1\t1\t2\n3\t2\t1\t2\n4\t1\t139\t2\n4\t2\t0\t2\n' > "$WORST_CPU_DIR/results/individual.tsv"
worst_cpu_out="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$WORST_CPU_DIR"
  worst_cpu
)"
check_eq "worst_cpu counts only SIGSEGV exits" "4" "$worst_cpu_out"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  gdb_result_is_complete 0 && gdb_result_is_complete 3 && ! gdb_result_is_complete 5
)
check_eq "only captured/no-fault gdb outcomes are phase-complete" "0" "$?"

FREQUENCY_COMPLETE="$TMP/frequency-complete"
mkdir -p "$FREQUENCY_COMPLETE/results"
printf 'A1\t1\t139\t2\nB\t1\t0\t3\nA2\t1\t0\t2\n' > "$FREQUENCY_COMPLETE/results/frequency-ab.tsv"
printf 'RUNS_PER_LEG=1\nRESTORED=1\nCOMPLETED=1\n' > "$FREQUENCY_COMPLETE/results/frequency-ab.meta"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete
)
check_eq "complete restored frequency A/B/A evidence is accepted" "0" "$?"
sed -i '/^A2/d' "$FREQUENCY_COMPLETE/results/frequency-ab.tsv"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete
) > /dev/null 2>&1
check_eq "partial frequency A/B/A evidence is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

echo "== resume bundle identity =="
resume_plan="$(cd "$TMP" && "$REPO_ROOT/diagnose.sh" --resume redo-bundle --dry-run --yes 2>&1)"
check_eq "relative resume keeps its caller-resolved bundle" "1" "$([[ "$resume_plan" == *"out dir            $RB (resume)"* ]] && echo 1 || echo 0)"
mkdir -p "$TMP/different-bundle"
(cd "$TMP" && "$REPO_ROOT/diagnose.sh" --resume redo-bundle --out-dir different-bundle --dry-run --yes) > /dev/null 2>&1
resume_conflict_rc=$?
check_eq "resume rejects a different --out-dir" "1" "$([[ $resume_conflict_rc -ne 0 ]] && echo 1 || echo 0)"
mkdir -p "$TMP/not-a-bundle"
"$REPO_ROOT/diagnose.sh" --resume "$TMP/not-a-bundle" --dry-run --yes > /dev/null 2>&1
not_bundle_rc=$?
check_eq "resume requires diagnostic bundle metadata" "1" "$([[ $not_bundle_rc -ne 0 ]] && echo 1 || echo 0)"
mkdir -p "$TMP/nonempty-output"
printf 'existing evidence\n' > "$TMP/nonempty-output/results.json"
"$REPO_ROOT/diagnose.sh" --out-dir "$TMP/nonempty-output" --dry-run --yes > /dev/null 2>&1
nonempty_output_rc=$?
check_eq "new run rejects a nonempty output directory" "1" "$([[ $nonempty_output_rc -ne 0 ]] && echo 1 || echo 0)"
relative_out_plan="$(cd "$TMP" && "$REPO_ROOT/diagnose.sh" --out-dir relative-output --dry-run --yes 2>&1)"
check_eq "relative output directory is resolved from caller cwd" "1" "$([[ "$relative_out_plan" == *"out dir            $TMP/relative-output"* ]] && echo 1 || echo 0)"

quick_override_before="$($REPO_ROOT/diagnose.sh --individual-runs 7 --quick --dry-run --yes 2>&1)"
quick_override_after="$($REPO_ROOT/diagnose.sh --quick --individual-runs 7 --dry-run --yes 2>&1)"
check_eq "mode flag order does not override explicit run count" "1" "$([[ "$quick_override_before" == *"individual runs    7 per CPU"* && "$quick_override_after" == *"individual runs    7 per CPU"* ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --quick --full --dry-run --yes > /dev/null 2>&1
mode_conflict_rc=$?
check_eq "conflicting mode flags are rejected" "1" "$([[ $mode_conflict_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --gdb-max-runs 0 --dry-run --yes > /dev/null 2>&1
zero_gdb_rc=$?
check_eq "zero gdb attempts are rejected" "1" "$([[ $zero_gdb_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --cpu 999999 --dry-run --yes > /dev/null 2>&1
unusable_cpu_rc=$?
check_eq "unusable CPU override is rejected" "1" "$([[ $unusable_cpu_rc -ne 0 ]] && echo 1 || echo 0)"

echo "== effective resume configuration =="
printf 'MODE=quick\nINDIVIDUAL_RUNS=20\nCOMPLETED_PHASES=baseline\n' > "$RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  META_FILE="$RB/results/meta.env"
  MODE=quick
  BASELINE_CHILDREN=8
  BASELINE_WAVES=10
  GROUP_WAVES=10
  INDIVIDUAL_RUNS=50
  GDB_MAX_RUNS=6
  SKIP_GDB=0
  persist_effective_config
)
check_eq "incomplete phase accepts overridden individual run count" "50" "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$RB/results/meta.env")"
check_eq "persisting incomplete-phase override retains other completion metadata" "baseline" "$(sed -n 's/^COMPLETED_PHASES=//p' "$RB/results/meta.env")"

OVERRIDE_RB="$TMP/completed-override-bundle"
mkdir -p "$OVERRIDE_RB"/{results,state}
cat > "$OVERRIDE_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=20
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=individual,gdb
EOF
printf '19\t1\t139\t2\n' > "$OVERRIDE_RB/results/individual.tsv"
printf 'CPU=19\nMAX_RUNS=6\nEXIT_CODE=0\n' > "$OVERRIDE_RB/results/gdb.meta"
touch "$OVERRIDE_RB/state/phase-individual.done" "$OVERRIDE_RB/state/phase-gdb.done"
"$REPO_ROOT/diagnose.sh" --resume "$OVERRIDE_RB" --individual-runs 50 --dry-run --yes > /dev/null 2>&1
completed_override_rc=$?
check_eq "completed individual evidence rejects changed run count without redo" "1" "$([[ $completed_override_rc -ne 0 && "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$OVERRIDE_RB/results/meta.env")" == 20 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --resume "$OVERRIDE_RB" --individual-runs 50 --redo individual --dry-run --yes > /dev/null 2>&1
check_eq "completed individual override is accepted with redo" "0" "$?"
"$REPO_ROOT/diagnose.sh" --resume "$OVERRIDE_RB" --gdb-max-runs 12 --dry-run --yes > /dev/null 2>&1
completed_gdb_override_rc=$?
check_eq "completed gdb evidence rejects changed attempt count without redo" "1" "$([[ $completed_gdb_override_rc -ne 0 ]] && echo 1 || echo 0)"

echo "== environment redaction =="
fake_cmdline='BOOT_IMAGE=/vmlinuz-linux root=UUID=550e8400-e29b-41d4-a716-446655440000 BOOTIF=01-aa-bb-cc-dd-ee-ff systemd.machine_id=0123456789abcdef console=ttyS0 rd.luks.key=secret tme=off intel_pstate=active processor.max_cstate=2 quiet'
sanitized_cmdline="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  printf '%s\n' "$fake_cmdline" | diag_sanitize_cmdline
)"
check_eq "cmdline allowlist drops identifiers and credentials" "tme=off intel_pstate=active processor.max_cstate=2" "$sanitized_cmdline"
check_eq "cmdline BOOTIF MAC is omitted" "0" "$([[ "$sanitized_cmdline" == *aa-bb-cc-dd-ee-ff* ]] && echo 1 || echo 0)"
check_eq "cmdline machine ID is omitted" "0" "$([[ "$sanitized_cmdline" == *0123456789abcdef* ]] && echo 1 || echo 0)"
printf '%s\n' "$sanitized_cmdline" | grep -qiE '(^| )tme=off( |$)'
check_eq "tme=off detection still matches the sanitized cmdline" "0" "$?"
grep -q 'journalctl -k -b --no-pager -o cat' "$REPO_ROOT/diagnose.sh"
check_eq "journal fallback omits hostname-bearing prefixes" "0" "$?"
redacted_node_path="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  diag_redact_home_prefix "$HOME/.nvm/versions/node/v25.2.1/bin/node"
)"
check_eq "node_path under \$HOME is redacted" "~/.nvm/versions/node/v25.2.1/bin/node" "$redacted_node_path"
system_node_path="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  diag_redact_home_prefix /usr/bin/node
)"
check_eq "node_path outside \$HOME is unchanged" "/usr/bin/node" "$system_node_path"

PRIVACY_BUNDLE="$TMP/privacy-bundle"
mkdir -p "$PRIVACY_BUNDLE/raw"
printf 'path=%s/private token=550e8400-e29b-41d4-a716-446655440000\n' "$HOME" > "$PRIVACY_BUNDLE/raw/tool.txt"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PRIVACY_BUNDLE"
  SCRIPT_DIR="$REPO_ROOT"
  write_privacy_review
)
check_eq "privacy scan flags files without copying sentinel values" "1" \
  "$([[ "$(grep -c $'^known-home-path\traw/tool.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c $'^uuid-shape\traw/tool.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c '550e8400' "$PRIVACY_BUNDLE/privacy-review.txt")" == 0 ]] && echo 1 || echo 0)"

echo "== manifest covers the final bundled log lines =="
MB="$TMP/manifest-bundle"
mkdir -p "$MB"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MB"
  DIAG_BUNDLE_ROOT="$MB"
  DIAG_REPO_ROOT="$REPO_ROOT"
  DIAG_LOG_FILE="$MB/run.log"
  # Reproduce the real ordering: every log line precedes the hash pass.
  diag_log "finalizing report and manifest for $OUT_DIR"
  write_manifest
) > /dev/null 2>&1
check_eq "write_manifest succeeds after the final bundled log lines" "0" "$?"
check_eq "bundle log redacts local roots" "1" \
  "$([[ "$(grep -Fc "$MB" "$MB/run.log")" == 0 && "$(grep -Fc "$REPO_ROOT" "$MB/run.log")" == 0 && "$(grep -Fc '<bundle>' "$MB/run.log")" -gt 0 ]] && echo 1 || echo 0)"
(cd "$MB" && sha256sum -c manifest.txt) > /dev/null 2>&1
check_eq "manifest verifies immediately after the run" "0" "$?"

echo "== node unit tests (stats, parsers) =="
if (cd "$LIB" && node --test 'tests/*.test.mjs') > "$TMP/node-tests.log" 2>&1; then
  ok "node --test stats+parsers"
else
  bad "node --test stats+parsers"
  sed 's/^/    /' "$TMP/node-tests.log" >&2
fi

echo "== end-to-end collect + report on synthetic bundle =="
B="$TMP/bundle"
mkdir -p "$B"/{results,logs/baseline,logs/groups,env,freq,gdb,state}
touch "$B/state/phase-frequency.done" "$B/state/phase-gdb.done"

cat > "$B/results/meta.env" << EOF
MODE=default
START_EPOCH=1753950000
START_ISO=2026-07-31T15:00:00+00:00
END_EPOCH=1753953600
END_ISO=2026-07-31T16:00:00+00:00
BASELINE_CHILDREN=4
BASELINE_WAVES=5
GROUP_WAVES=5
INDIVIDUAL_RUNS=20
GDB_MAX_RUNS=6
FREQUENCY_AB=1
SKIP_GDB=0
COMPLETED_PHASES=preflight,baseline,groups,individual,frequency,gdb
INTERRUPTED=0
EOF

cat > "$B/env/summary.env" << EOF
DISTRO=TestOS
KERNEL=6.0.0-test
NODE_VERSION=v25.2.1
V8_VERSION=14.1.146.11-node.14
CPU_MODEL=Test CPU
ONLINE_CPUS=0-23
TME_STATE=disabled (tme=off on kernel command line)
POWER_SOURCE=battery
NO_TURBO=0
MISSING_OPTIONAL=turbostat
EOF

cp "$FIX/repro-fail.log" "$B/logs/baseline/run1.log"
cat > "$B/results/baseline.meta" << EOF
CHILDREN=4
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=1
EOF

cp "$FIX/repro-fail.log" "$B/logs/groups/ecluster-64.log"
cp "$FIX/repro-clean.log" "$B/logs/groups/pcores.log"
cat > "$B/results/groups.tsv" << EOF
pcores	pcore	0-7	-	4	5	logs/groups/pcores.log	group-pcores	0
ecluster-64	ecluster	16-19	64	4	5	logs/groups/ecluster-64.log	group-ecluster-64	1
EOF

# CPU 8: 20 clean runs; CPU 19: 6 SIGSEGV in 20 runs plus one launch error
# (rc 126) that must be excluded from the run counts as an invalid run.
: > "$B/results/individual.tsv"
for i in $(seq 1 20); do
  printf '8\t%s\t0\t2\n' "$i" >> "$B/results/individual.tsv"
done
for i in $(seq 1 20); do
  if ((i <= 6)); then
    printf '19\t%s\t139\t2\n' "$i" >> "$B/results/individual.tsv"
  else
    printf '19\t%s\t0\t2\n' "$i" >> "$B/results/individual.tsv"
  fi
done
printf '19\t21\t126\t0\n' >> "$B/results/individual.tsv"

# Leg B also carries one launch-error row (rc 126): excluded from the valid
# runs the frequency inference is based on.
cat > "$B/results/frequency-ab.tsv" << EOF
A1	1	139	2
A1	2	0	2
A1	3	139	2
A1	4	0	2
B	1	0	3
B	2	0	3
B	3	0	3
B	4	0	3
A2	1	139	2
A2	2	139	2
A2	3	0	2
A2	4	0	2
EOF
cat > "$B/results/frequency-ab.meta" << EOF
CPU=19
RUNS_PER_LEG=4
SAVED_NO_TURBO=0
LEG_A1_NO_TURBO=0
LEG_A1_SCALING_MAX_KHZ=5500000
LEG_B_NO_TURBO=1
LEG_B_SCALING_MAX_KHZ=5500000
LEG_A2_NO_TURBO=0
LEG_A2_SCALING_MAX_KHZ=5500000
RESTORED=1
COMPLETED=1
EOF
for leg in A1 B A2; do
  printf 'scaling_cur_freq\n' > "$B/freq/freq-ab-${leg}.method"
  if [[ "$leg" == "B" ]]; then mhz=2100000; else mhz=4700000; fi
  printf '1753950000 19 %s\n1753950001 19 %s\n' "$mhz" "$mhz" > "$B/freq/freq-ab-${leg}.samples"
done

cp "$FIX/gdb-known.txt" "$B/gdb/cpu19-run1.txt"
cat > "$B/results/gdb.meta" << EOF
CPU=19
MAX_RUNS=6
EXIT_CODE=0
EOF

# Simulated manual root-checks.sh output.
mkdir -p "$B/env/root"
printf '# cctk read-only allowlist probe\nTurboMode=Enabled\nIntelTME=Disabled\n' > "$B/env/root/cctk.txt"
printf '# intel-undervolt read\ncore (0): voltage offset: 0 mV\n' > "$B/env/root/intel-undervolt.txt"

node "$LIB/collect.mjs" "$B" > /dev/null
node "$LIB/report.mjs" "$B" > /dev/null

# All JSON assertions in one place; prints one line per failure.
cat > "$TMP/check-results.mjs" << 'EOF'
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};
check("baseline sigsegv count", r.baseline.sigsegvCount === 2);
check("bundle path is relative", r.outDir === ".");
check("baseline other failures", r.baseline.otherFailureCount === 1);
check("baseline invocations", r.baseline.totalChildInvocations === 20);
check("worst cpu is 19", r.worstCpu === 19);
check("individual tally", r.individual.length === 2 && r.individual[1].sigsegv === 6 && r.individual[0].failures === 0);
check("individual invalid runs excluded", r.individual[1].runs === 20 && r.individual[1].invalidRuns.length === 1 && r.individual[1].invalidRuns[0].rc === 126);
check("gdb signature match", r.gdb.status === "captured" && r.gdb.captures.length === 1 && r.gdb.captures[0].matchesKnownSignature === true);
check("gdb capture file trimmed", r.gdb.captures[0].mappings === undefined);
check("freq ab restored + legs", r.frequencyAb.restored === true && r.frequencyAb.legs.length === 3);
check("freq leg B measured clock", r.frequencyAb.legs[1].frequency.avgMHz === 2100);
check("group failure tally", r.groups.length === 2 && r.groups[1].sigsegvCount === 2 && r.groups[0].sigsegvCount === 0);
check("root checks merged", Boolean(r.rootChecks) && r.rootChecks["cctk.txt"].includes("IntelTME=Disabled"));
process.exit(failures === 0 ? 0 : 1);
EOF
if node "$TMP/check-results.mjs" "$B/results.json"; then
  pass=$((pass + 13))
else
  fail=$((fail + 1))
fi

grep -q "CPU localization" "$B/report.md"
check_eq "report contains localization conclusion" "0" "$?"
grep -q "Permutation test" "$B/report.md"
check_eq "report omits invalid permutation localization test" "1" "$?"
grep -q "statistically significant (Fisher exact" "$B/report.md"
check_eq "post-selected Fisher significance claim is gone" "1" "$?"
grep -q "documented pattern" "$B/report.md"
check_eq "report contains signature conclusion" "0" "$?"
grep -q "Fisher exact" "$B/report.md"
check_eq "report contains Fisher test" "0" "$?"
grep -q "TME" "$B/report.md"
check_eq "report contains TME rule-out" "0" "$?"
grep -q "battery" "$B/report.md"
check_eq "report contains battery rule-out" "0" "$?"
grep -q "Privileged reads" "$B/report.md"
check_eq "report contains privileged-reads section" "0" "$?"
grep -q "IntelTME=Disabled" "$B/report.md"
check_eq "report includes cctk allowlist data" "0" "$?"
grep -q "log truncated" "$B/report.md"
check_eq "complete bundle report has no truncation marker" "1" "$?"

# A truncated baseline log (no completion footer) must still yield usable
# counts: collect.mjs spreads the parser output into the baseline entry, so
# the recovered counts and the partial flag reach results.json and the
# report with no collect.mjs changes.
B2="$TMP/bundle-truncated"
mkdir -p "$B2"/{results,logs/baseline}
cp "$FIX/repro-truncated.log" "$B2/logs/baseline/run1.log"
cat > "$B2/results/baseline.meta" << EOF
CHILDREN=2
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=139
EOF
node "$LIB/collect.mjs" "$B2" > /dev/null
node "$LIB/report.mjs" "$B2" > /dev/null

cat > "$TMP/check-truncated.mjs" << 'EOF'
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};
check("truncated baseline marked partial", r.baseline.partial === true);
check("truncated baseline recovered waves", r.baseline.processedWaves === 2 && r.baseline.completedWaves === 2 && r.baseline.failedWaves === 1);
check("truncated baseline invocations nonzero", r.baseline.totalChildInvocations === 4);
process.exit(failures === 0 ? 0 : 1);
EOF
if node "$TMP/check-truncated.mjs" "$B2/results.json"; then
  pass=$((pass + 3))
else
  fail=$((fail + 1))
fi
grep -q "log truncated; partial data" "$B2/report.md"
check_eq "report marks truncated baseline as partial" "0" "$?"
grep -q "1 SIGSEGV(s) across 4 child-process runs" "$B2/report.md"
check_eq "truncated run conclusion counts recovered invocations" "0" "$?"

echo "== finalization failure handling =="
# collect.mjs cannot write results.json into a missing bundle directory.
FINALIZE_FAIL_LOG="$TMP/finalize-fail.log"
FINALIZE_FAIL_OUTPUT="$TMP/finalize-fail.output"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$TMP/finalize-missing-bundle"
  META_FILE="$TMP/finalize-fail.meta"
  STATE_DIR="$TMP/finalize-fail-state"
  DIAG_LOG_FILE="$FINALIZE_FAIL_LOG"
  mkdir -p "$STATE_DIR"
  complete_diagnostic
) > "$FINALIZE_FAIL_OUTPUT" 2>&1
finalize_fail_rc=$?
check_eq "finalization aborts nonzero when collect.mjs fails" "1" "$([[ $finalize_fail_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "failed finalization never reports completion" "0" "$([[ ! -e "$FINALIZE_FAIL_LOG" || "$(grep -c 'done\. Bundle' "$FINALIZE_FAIL_LOG")" == 0 ]] && [[ "$(grep -c 'done\. Bundle' "$FINALIZE_FAIL_OUTPUT")" == 0 ]] && echo 0 || echo 1)"

# The happy path on the synthetic bundle above still succeeds, and the
# manifest it leaves behind verifies (success is terminal-only and follows it).
touch "$B/state"/phase-{preflight,baseline,groups,individual,frequency,gdb}.done
FINALIZE_OK_OUTPUT="$TMP/finalize-ok.output"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$B"
  DIAG_BUNDLE_ROOT="$B"
  DIAG_REPO_ROOT="$REPO_ROOT"
  META_FILE="$B/results/meta.env"
  STATE_DIR="$B/state"
  DIAG_LOG_FILE="$B/run.log"
  complete_diagnostic
) > "$FINALIZE_OK_OUTPUT" 2>&1
check_eq "finalization succeeds on a complete bundle" "0" "$?"
grep -q 'done\. Bundle' "$FINALIZE_OK_OUTPUT"
check_eq "successful finalization reports completion afterward" "0" "$?"
check_eq "success claim is not appended after the manifest hash pass" "0" "$([[ "$(grep -c 'done\. Bundle' "$B/run.log")" == 0 ]] && echo 0 || echo 1)"
grep -q $'^status\t' "$B/privacy-review.txt"
check_eq "finalization writes privacy review" "0" "$?"
(cd "$B" && sha256sum -c manifest.txt) > /dev/null 2>&1
check_eq "end-to-end bundle manifest verifies" "0" "$?"

echo
printf 'passed=%d failed=%d\n' "$pass" "$fail"
((fail == 0))
