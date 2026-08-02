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

# Shared real/alternate CPU fixtures for persisted selection-policy tests.
TEST_ONLINE_CPUS="$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status)"
TEST_ONLINE_CPU="$(diag_cpulist_expand "$TEST_ONLINE_CPUS" | head -1)"
TEST_OTHER_CPU=$((TEST_ONLINE_CPU + 100000))
TEST_OFFLINE_CANONICAL_CPU=65535
while diag_cpulist_contains "$TEST_ONLINE_CPUS" "$TEST_OFFLINE_CANONICAL_CPU"; do
  TEST_OFFLINE_CANONICAL_CPU=$((TEST_OFFLINE_CANONICAL_CPU - 1))
done
CPU_POLICY_RB="$TMP/cpu-policy-bundle"
mkdir -p "$CPU_POLICY_RB"/{results,state}
cat > "$CPU_POLICY_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=$TEST_ONLINE_CPU
COMPLETED_PHASES=
EOF

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

echo "== tracked process groups and pipeline statuses =="
PROCESS_GROUP_DIR="$TMP/process-group"
mkdir -p "$PROCESS_GROUP_DIR"
DIAG_WORKLOAD_PID=""
diag_process_group_start bash "$FIX/process-group-child.sh" "$PROCESS_GROUP_DIR"
process_group_leader="$DIAG_WORKLOAD_PID"
for ((i = 0; i < 100; i++)); do
  [[ -s "$PROCESS_GROUP_DIR/leader.pid" && -s "$PROCESS_GROUP_DIR/child.pid" ]] && break
  sleep 0.01
done
process_group_child="$(cat "$PROCESS_GROUP_DIR/child.pid" 2> /dev/null || true)"
process_group_stop_start=$SECONDS
diag_process_group_stop
process_group_stop_elapsed=$((SECONDS - process_group_stop_start))
for ((i = 0; i < 40; i++)); do
  [[ -z "$process_group_child" ]] || ! kill -0 "$process_group_child" 2> /dev/null || {
    sleep 0.05
    continue
  }
  break
done
process_group_clean=0
[[ -n "$process_group_leader" && -n "$process_group_child" ]] &&
  ! kill -0 "$process_group_leader" 2> /dev/null &&
  ! kill -0 "$process_group_child" 2> /dev/null &&
  [[ -z "$DIAG_WORKLOAD_PID" ]] &&
  ((process_group_stop_elapsed <= 4)) && process_group_clean=1
check_eq "cleanup reaps a tracked group including a TERM-resistant descendant" "1" "$process_group_clean"

DIAG_WORKLOAD_PID=""
diag_process_group_start bash -c 'exit 7'
process_group_wait_rc=0
diag_process_group_wait || process_group_wait_rc=$?
check_eq "tracked wait preserves the primary exit status" "7" "$process_group_wait_rc"
check_eq "tracked wait clears the active group" "" "$DIAG_WORKLOAD_PID"

PROCESS_GROUP_EXIT_DIR="$TMP/process-group-exited-leader"
mkdir -p "$PROCESS_GROUP_EXIT_DIR"
DIAG_WORKLOAD_PID=""
diag_process_group_start bash "$FIX/process-group-child.sh" "$PROCESS_GROUP_EXIT_DIR" exit
for ((i = 0; i < 100; i++)); do
  [[ -s "$PROCESS_GROUP_EXIT_DIR/child.pid" ]] && break
  sleep 0.01
done
exited_leader_child="$(cat "$PROCESS_GROUP_EXIT_DIR/child.pid" 2> /dev/null || true)"
exited_leader_rc=0
diag_process_group_wait || exited_leader_rc=$?
for ((i = 0; i < 40; i++)); do
  [[ -z "$exited_leader_child" ]] || ! kill -0 "$exited_leader_child" 2> /dev/null || {
    sleep 0.05
    continue
  }
  break
done
exited_leader_clean=0
[[ $exited_leader_rc -eq 0 && -n "$exited_leader_child" ]] &&
  ! kill -0 "$exited_leader_child" 2> /dev/null &&
  [[ -z "$DIAG_WORKLOAD_PID" ]] && exited_leader_clean=1
check_eq "tracked wait drains descendants left by an exited leader" "1" "$exited_leader_clean"

PIPELINE_DIR="$TMP/pipeline-status"
mkdir -p "$PIPELINE_DIR/bin" "$PIPELINE_DIR/out"
cat > "$PIPELINE_DIR/bin/node" << 'EOF'
#!/usr/bin/env bash
printf 'synthetic workload output\n'
exit "${FAKE_NODE_RC:-0}"
EOF
cat > "$PIPELINE_DIR/bin/taskset" << 'EOF'
#!/usr/bin/env bash
case "$1" in
  -c) shift 2; exec "$@" ;;
  -pc) printf 'pid %s affinity: synthetic\n' "$2"; exit 0 ;;
  *) exit 2 ;;
esac
EOF
cat > "$PIPELINE_DIR/bin/gdb" << 'EOF'
#!/usr/bin/env bash
case "${FAKE_GDB_MODE:-clean}" in
  clean) printf 'Inferior 1 exited normally\n' ;;
  error) printf 'synthetic debugger error\n' ;;
  capture) printf 'Program received signal SIGSEGV, Segmentation fault.\n' ;;
  one-clean-rest-error)
    count=0
    [[ -f "$FAKE_GDB_COUNTER" ]] && count="$(cat "$FAKE_GDB_COUNTER")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_GDB_COUNTER"
    if ((count == 1)); then printf 'Inferior 1 exited normally\n'; else printf 'synthetic debugger error\n'; fi
    ;;
  *) exit 92 ;;
esac
EOF
cat > "$PIPELINE_DIR/bin/timeout" << 'EOF'
#!/usr/bin/env bash
[[ "$1" == "--foreground" && "$2" == "--signal=KILL" ]] || exit 91
shift 3
exec "$@"
EOF
chmod +x "$PIPELINE_DIR/bin/node" "$PIPELINE_DIR/bin/taskset" \
  "$PIPELINE_DIR/bin/gdb" "$PIPELINE_DIR/bin/timeout"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  export PATH="$PIPELINE_DIR/bin:$PATH"
  export FAKE_NODE_RC=1
  run_repro_logged "$PIPELINE_DIR/out/repro.log" - 1 1
  printf '%s\n' "$REPRO_RC" > "$PIPELINE_DIR/repro.rc"
)
check_eq "repro logging pipeline preserves the workload status" "1" "$(cat "$PIPELINE_DIR/repro.rc")"

cat > "$PIPELINE_DIR/bin/awk" << 'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$PIPELINE_DIR/bin/awk"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  export PATH="$PIPELINE_DIR/bin:$PATH"
  export FAKE_NODE_RC=0
  run_repro_logged "$PIPELINE_DIR/out/repro-awk-fail.log" - 1 1
  printf '%s\n' "$REPRO_RC" > "$PIPELINE_DIR/repro-awk-fail.rc"
)
check_eq "repro auxiliary-stage failure is operational status 125" "125" \
  "$(cat "$PIPELINE_DIR/repro-awk-fail.rc")"
rm "$PIPELINE_DIR/bin/awk"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  export PATH="$PIPELINE_DIR/bin:$PATH"
  export FAKE_NODE_RC=139
  individual_rc=0
  run_individual_logged 0 1 "$PIPELINE_DIR/out/individual.tsv" 1 \
    "$PIPELINE_DIR/out/individual.log" || individual_rc=$?
  individual_valid=0
  individual_cpu_batch_matches_wrapper \
    "$PIPELINE_DIR/out/individual.tsv" 0 0 1 "$individual_rc" && individual_valid=1
  printf '%s|%s\n' "$individual_rc" "$individual_valid" > "$PIPELINE_DIR/individual.status"
)
check_eq "individual pipeline preserves SIGSEGV batch semantics" "1|1" \
  "$(cat "$PIPELINE_DIR/individual.status")"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  export PATH="$PIPELINE_DIR/bin:$PATH"
  gdb_rc=0
  run_gdb_logged 0 1 1 "$PIPELINE_DIR/out/gdb" "$PIPELINE_DIR/out/gdb-runner.log" || gdb_rc=$?
  printf '%s\n' "$gdb_rc" > "$PIPELINE_DIR/gdb.rc"
)
check_eq "GDB logging pipeline preserves the no-fault status" "3" "$(cat "$PIPELINE_DIR/gdb.rc")"
check_eq "GDB logging pipeline preserves terminal all-clean accounting" \
  "GDB_RUN_COUNTS attempted=1 clean=1 captured=0 errors=0" \
  "$(tail -1 "$PIPELINE_DIR/out/gdb-runner.log")"

gdb_capture_case() {
  local label="$1" mode="$2" runs="$3" captures="$4" expected_rc="$5" expected_counts="$6"
  local case_dir="$PIPELINE_DIR/$label" output="$PIPELINE_DIR/$label.log" rc=0
  mkdir -p "$case_dir"
  rm -f "$PIPELINE_DIR/$label.counter"
  (
    cd "$REPO_ROOT" || exit 99
    PATH="$PIPELINE_DIR/bin:$PATH" FAKE_GDB_MODE="$mode" \
      FAKE_GDB_COUNTER="$PIPELINE_DIR/$label.counter" \
      bash ./capture-fault.sh 0 "$runs" "$captures" "$case_dir"
  ) > "$output" 2>&1 || rc=$?
  local record_count
  record_count="$(grep -c '^GDB_RUN_COUNTS ' "$output" || true)"
  check_eq "$label status and unique terminal accounting" \
    "$expected_rc|1|$expected_counts" "$rc|$record_count|$(tail -1 "$output")"
}
gdb_capture_case "gdb-all-clean" clean 3 1 3 \
  "GDB_RUN_COUNTS attempted=3 clean=3 captured=0 errors=0"
gdb_capture_case "gdb-clean-plus-errors" one-clean-rest-error 6 1 3 \
  "GDB_RUN_COUNTS attempted=6 clean=1 captured=0 errors=5"
gdb_capture_case "gdb-all-errors" error 3 1 5 \
  "GDB_RUN_COUNTS attempted=3 clean=0 captured=0 errors=3"
gdb_capture_case "gdb-early-capture" capture 6 1 0 \
  "GDB_RUN_COUNTS attempted=1 clean=0 captured=1 errors=0"
gdb_capture_case "gdb-exhausted-with-captures" capture 2 3 0 \
  "GDB_RUN_COUNTS attempted=2 clean=0 captured=2 errors=0"
grep -q 'timeout --foreground --signal=KILL' "$REPO_ROOT/capture-fault.sh"
check_eq "GDB timeout remains inside the tracked foreground group" "0" "$?"

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
bash "$REPO_ROOT/single.sh" 01 1 > /dev/null 2>&1
check_eq "single.sh rejects non-canonical CPU ids (rc=2)" "2" "$?"
bash "$REPO_ROOT/single.sh" 0 1 "" 01 > /dev/null 2>&1
check_eq "single.sh rejects non-canonical top-up ids (rc=2)" "2" "$?"

echo "== capture-fault.sh exit codes =="
bash "$REPO_ROOT/capture-fault.sh" > /dev/null 2>&1
check_eq "capture-fault.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 x 1 "$TMP/out" > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-numeric runs (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 06 1 "$TMP/out" > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-canonical run counts (rc=2)" "2" "$?"
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
  mkdir -p "$PUBLISH_BUNDLE/results" "$PUBLISH_BUNDLE/freq" "$PUBLISH_BUNDLE/state" \
    "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  chmod 0700 "$PUBLISH_STAGE" "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  printf 'old command\n' > "$PUBLISH_BUNDLE/commands.log"
  touch "$PUBLISH_BUNDLE/state/phase-frequency.done"
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
    [[ ! -e "$PUBLISH_BUNDLE/state/phase-frequency.done" ]] &&
    [[ ! -e "$PUBLISH_STAGE" ]] && publish_safe=1
  check_eq "frequency publisher replaces a raced symlink and invalidates the old marker" "1" "$publish_safe"

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

  MARKER_FAIL_BUNDLE="$TMP/frequency-marker-fail-bundle"
  MARKER_FAIL_STAGE="$TMP/frequency-marker-fail-stage"
  mkdir -p "$MARKER_FAIL_BUNDLE/results" "$MARKER_FAIL_BUNDLE/freq" \
    "$MARKER_FAIL_BUNDLE/state/phase-frequency.done" \
    "$MARKER_FAIL_STAGE/results" "$MARKER_FAIL_STAGE/freq"
  chmod 0700 "$MARKER_FAIL_STAGE" "$MARKER_FAIL_STAGE/results" "$MARKER_FAIL_STAGE/freq"
  printf 'old evidence\n' > "$MARKER_FAIL_BUNDLE/results/frequency-ab.tsv"
  printf 'new evidence\n' > "$MARKER_FAIL_STAGE/results/frequency-ab.tsv"
  printf 'new command\n' > "$MARKER_FAIL_STAGE/commands.log"
  chmod 0600 "$MARKER_FAIL_STAGE/results/frequency-ab.tsv" "$MARKER_FAIL_STAGE/commands.log"
  bash "$LIB/publish-frequency-output.sh" "$MARKER_FAIL_STAGE" "$MARKER_FAIL_BUNDLE" \
    > /dev/null 2>&1
  marker_fail_rc=$?
  check_eq "frequency publisher aborts before artifact moves when marker invalidation fails" "1" \
    "$([[ $marker_fail_rc -ne 0 && "$(cat "$MARKER_FAIL_BUNDLE/results/frequency-ab.tsv")" == "old evidence" && "$(cat "$MARKER_FAIL_STAGE/results/frequency-ab.tsv")" == "new evidence" && -d "$MARKER_FAIL_BUNDLE/state/phase-frequency.done" ]] && echo 1 || echo 0)"

  MIXED_BUNDLE="$TMP/frequency-mixed-bundle"
  MIXED_STAGE="$TMP/frequency-mixed-stage"
  mkdir -p "$MIXED_BUNDLE/results" "$MIXED_BUNDLE/freq" "$MIXED_BUNDLE/state" \
    "$MIXED_STAGE/results" "$MIXED_STAGE/freq"
  chmod 0700 "$MIXED_STAGE" "$MIXED_STAGE/results" "$MIXED_STAGE/freq"
  printf 'A1\t1\t0\t1\nB\t1\t0\t1\nA2\t1\t0\t1\n' > "$MIXED_BUNDLE/results/frequency-ab.tsv"
  printf 'CPU=19\nRUNS_PER_LEG=1\nRESTORED=1\nCOMPLETED=1\nLEG_A1_NO_TURBO=0\nLEG_B_NO_TURBO=1\nLEG_A2_NO_TURBO=0\n' \
    > "$MIXED_BUNDLE/results/frequency-ab.meta"
  touch "$MIXED_BUNDLE/state/phase-frequency.done"
  printf 'A1\t1\t139\t2\nB\t1\t0\t2\nA2\t1\t139\t2\n' > "$MIXED_STAGE/results/frequency-ab.tsv"
  printf 'CPU=20\nRUNS_PER_LEG=1\nRESTORED=1\nCOMPLETED=1\nLEG_A1_NO_TURBO=0\nLEG_B_NO_TURBO=1\nLEG_A2_NO_TURBO=0\n' \
    > "$MIXED_STAGE/results/frequency-ab.meta"
  printf 'new command\n' > "$MIXED_STAGE/commands.log"
  chmod 0600 "$MIXED_STAGE/results/frequency-ab.tsv" \
    "$MIXED_STAGE/results/frequency-ab.meta" "$MIXED_STAGE/commands.log"
  bash -c 'DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_MOVE=1 bash "$1" "$2" "$3"; rc=$?; exit "$rc"' \
    _ "$LIB/publish-frequency-output.sh" "$MIXED_STAGE" "$MIXED_BUNDLE" \
    > /dev/null 2>&1
  mixed_publish_rc=$?
  node "$LIB/collect.mjs" "$MIXED_BUNDLE" > /dev/null 2>&1
  mixed_assessment="$(node -e \
    'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(`${r.frequencyAbStatus.status}|${r.frequencyAb === undefined}`)' \
    "$MIXED_BUNDLE/results.json")"
  check_eq "killed mixed-generation publish cannot satisfy assessFrequencyAb" "1" \
    "$([[ $mixed_publish_rc -ne 0 && ! -e "$MIXED_BUNDLE/state/phase-frequency.done" && "$(head -n 1 "$MIXED_BUNDLE/results/frequency-ab.tsv")" == $'A1\t1\t139\t2' && "$(head -n 1 "$MIXED_BUNDLE/results/frequency-ab.meta")" == 'CPU=19' && "$mixed_assessment" == 'incomplete|true' ]] && echo 1 || echo 0)"

  STAGE_RECOVERY="$TMP/frequency-stage-recovery"
  mkdir -p "$STAGE_RECOVERY/state" "$STAGE_RECOVERY/old-bundle/state" \
    "$STAGE_RECOVERY/current-bundle"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    unset FREQUENCY_AB_SOURCE_ONLY
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    FREQUENCY_STATE_UID="$INVOKING_UID"
    FREQUENCY_STATE_GID="$INVOKING_GID"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$STAGE_RECOVERY/stage"
    FREQUENCY_STAGE_RECORD="$STAGE_RECOVERY/state/output-stage.pending"
    BUNDLE="$STAGE_RECOVERY/current-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    mkdir -m 0700 "$FREQUENCY_STAGE_DIR" \
      "$FREQUENCY_STAGE_DIR/results" "$FREQUENCY_STAGE_DIR/freq"
    printf 'A1\t1\t0\t1\n' > "$FREQUENCY_STAGE_DIR/results/frequency-ab.tsv"
    printf 'CPU=19\n' > "$FREQUENCY_STAGE_DIR/results/frequency-ab.meta"
    printf 'staged command\n' > "$FREQUENCY_STAGE_DIR/commands.log"
    chmod 0600 "$FREQUENCY_STAGE_DIR/results/frequency-ab.tsv" \
      "$FREQUENCY_STAGE_DIR/results/frequency-ab.meta" \
      "$FREQUENCY_STAGE_DIR/commands.log"
    touch "$STAGE_RECOVERY/old-bundle/state/phase-frequency.done"
    frequency_stage_record_write "$STAGE_RECOVERY/old-bundle"
    frequency_recover_pending_outputs
    [[ "$BUNDLE" == "$STAGE_RECOVERY/current-bundle" ]]
  ) > /dev/null 2>&1
  stage_recovery_rc=$?
  check_eq "next invocation publishes SIGKILL-stranded frequency staging" "1" \
    "$([[ $stage_recovery_rc -eq 0 && ! -e "$STAGE_RECOVERY/stage" && ! -e "$STAGE_RECOVERY/state/output-stage.pending" && ! -e "$STAGE_RECOVERY/old-bundle/state/phase-frequency.done" && "$(cat "$STAGE_RECOVERY/old-bundle/results/frequency-ab.tsv")" == $'A1\t1\t0\t1' ]] && echo 1 || echo 0)"

  FORGED_RECOVERY="$TMP/frequency-forged-stage-record"
  mkdir -p "$FORGED_RECOVERY/state"
  printf '/tmp/allowed\t/forged\n' > "$FORGED_RECOVERY/state/output-stage.pending"
  chmod 0600 "$FORGED_RECOVERY/state/output-stage.pending"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    unset FREQUENCY_AB_SOURCE_ONLY
    FREQUENCY_STATE_UID="$(id -u)"
    FREQUENCY_STATE_GID="$(id -g)"
    FREQUENCY_STAGE_RECORD="$FORGED_RECOVERY/state/output-stage.pending"
    pending=""
    frequency_stage_record_read pending
  ) > /dev/null 2>&1
  forged_record_rc=$?
  check_eq "frequency staging record rejects control-character ambiguity" "1" \
    "$([[ $forged_record_rc -ne 0 && -s "$FORGED_RECOVERY/state/output-stage.pending" ]] && echo 1 || echo 0)"

  UNRECORDED_RECOVERY="$TMP/frequency-unrecorded-stage"
  mkdir -m 0700 "$UNRECORDED_RECOVERY"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    unset FREQUENCY_AB_SOURCE_ONLY
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$UNRECORDED_RECOVERY"
    FREQUENCY_STAGE_RECORD="$TMP/no-frequency-stage-record"
    BUNDLE="$TMP/unused-current-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    frequency_recover_pending_outputs
  ) > /dev/null 2>&1
  unrecorded_recovery_rc=$?
  check_eq "unrecorded deterministic stage is explicitly handed off" "1" \
    "$([[ $unrecorded_recovery_rc -eq 0 && ! -e "$UNRECORDED_RECOVERY" ]] && compgen -G "$UNRECORDED_RECOVERY.unpublished.*" > /dev/null && echo 1 || echo 0)"
else
  ok "frequency-ab.sh non-root guard [skipped while tests run as root]"
  ok "root-checks.sh non-root guard [skipped while tests run as root]"
  ok "frequency publisher replaces a raced symlink and invalidates the old marker [skipped while tests run as root]"
  ok "unprivileged frequency publisher rejects a command-log symlink [skipped while tests run as root]"
  ok "frequency publisher aborts before artifact moves when marker invalidation fails [skipped while tests run as root]"
  ok "killed mixed-generation publish cannot satisfy assessFrequencyAb [skipped while tests run as root]"
  ok "next invocation publishes SIGKILL-stranded frequency staging [skipped while tests run as root]"
  ok "frequency staging record rejects control-character ambiguity [skipped while tests run as root]"
  ok "unrecorded deterministic stage is explicitly handed off [skipped while tests run as root]"
fi

if ((EUID != 0)); then
  root_publish_stage_prepare() {
    local stage="$1" name
    mkdir -p "$stage"
    chmod 0700 "$stage"
    for name in kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt root-checks.meta; do
      printf 'staged %s\n' "$name" > "$stage/$name"
      chmod 0600 "$stage/$name"
    done
  }

  ROOT_PUBLISH="$TMP/root-checks-publish"
  root_publish_stage_prepare "$ROOT_PUBLISH/stage"
  mkdir -p "$ROOT_PUBLISH/bundle/env/root"
  printf 'safe root-checks victim\n' > "$ROOT_PUBLISH/victim"
  ln -s "$ROOT_PUBLISH/victim" "$ROOT_PUBLISH/bundle/env/root/cctk.txt"
  bash "$LIB/publish-root-checks-output.sh" "$ROOT_PUBLISH/stage" "$ROOT_PUBLISH/bundle" \
    > /dev/null 2>&1
  root_publish_rc=$?
  root_publish_safe=0
  [[ $root_publish_rc -eq 0 ]] &&
    [[ "$(cat "$ROOT_PUBLISH/victim")" == "safe root-checks victim" ]] &&
    [[ -f "$ROOT_PUBLISH/bundle/env/root/cctk.txt" && ! -L "$ROOT_PUBLISH/bundle/env/root/cctk.txt" ]] &&
    [[ "$(cat "$ROOT_PUBLISH/bundle/env/root/cctk.txt")" == "staged cctk.txt" ]] &&
    [[ "$(stat -Lc '%a' "$ROOT_PUBLISH/bundle/env/root/cctk.txt")" == "644" ]] &&
    [[ ! -e "$ROOT_PUBLISH/stage" ]] && root_publish_safe=1
  check_eq "unprivileged root-checks publisher safely replaces an output symlink" "1" "$root_publish_safe"

  ROOT_SUBSTITUTE="$TMP/root-checks-substitute"
  root_publish_stage_prepare "$ROOT_SUBSTITUTE/stage"
  mkdir -p "$ROOT_SUBSTITUTE/bundle/env" "$ROOT_SUBSTITUTE/substitute"
  printf 'safe directory victim\n' > "$ROOT_SUBSTITUTE/substitute/sentinel"
  ln -s "$ROOT_SUBSTITUTE/substitute" "$ROOT_SUBSTITUTE/bundle/env/root"
  bash "$LIB/publish-root-checks-output.sh" "$ROOT_SUBSTITUTE/stage" "$ROOT_SUBSTITUTE/bundle" \
    > /dev/null 2>&1
  root_substitute_rc=$?
  check_eq "unprivileged root-checks publisher rejects output-directory substitution" "1" \
    "$([[ $root_substitute_rc -ne 0 && "$(cat "$ROOT_SUBSTITUTE/substitute/sentinel")" == "safe directory victim" && ! -e "$ROOT_SUBSTITUTE/substitute/cctk.txt" && -f "$ROOT_SUBSTITUTE/stage/cctk.txt" ]] && echo 1 || echo 0)"
else
  ok "unprivileged root-checks publisher safely replaces an output symlink [skipped while tests run as root]"
  ok "unprivileged root-checks publisher rejects output-directory substitution [skipped while tests run as root]"
fi

echo "== --redo phase handling =="
RB="$TMP/redo-bundle"
mkdir -p "$RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n19\t2\t0\t2\n' > "$RB/results/individual.tsv"
printf 'VERSION=1\nTARGET_CPUS=19\nRUNS_PER_CPU=2\nSKIPPED=0\nCOMPLETED=1\n' > "$RB/results/individual.meta"
touch "$RB/state/phase-individual.done" "$RB/state/phase-baseline.done"
cat > "$RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=20
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=baseline,individual
EOF
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  # Set these after sourcing: diagnose.sh top-level initialises its own.
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  load_stored_config "$RB"
  REDO_PLAN=(individual frequency gdb)
  apply_redo_plan
) > /dev/null 2>&1
redo_stash="$(find "$RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
redo_ok=0
[[ ! -f "$RB/results/individual.tsv" ]] &&
  [[ ! -f "$RB/state/phase-individual.done" ]] &&
  [[ -f "$redo_stash/individual/results/individual.tsv" ]] &&
  [[ -f "$redo_stash/individual/results/individual.meta" ]] &&
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
  REDO_PLAN=(gdb)
  apply_redo_plan
) > /dev/null 2>&1
gdb_stash="$(find "$GB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
gdb_redo_ok=0
[[ -f "$gdb_stash/gdb/results/gdb.meta" ]] &&
  [[ -f "$gdb_stash/gdb/gdb/cpu19-run1.txt" ]] &&
  [[ -f "$gdb_stash/gdb/logs/gdb/runner.log" ]] &&
  [[ ! -f "$GB/state/phase-gdb.done" ]] && gdb_redo_ok=1
check_eq "--redo gdb preserves distinct capture and runner paths" "1" "$gdb_redo_ok"

GDB_PREDICATE_RB="$TMP/gdb-incomplete-predicate"
mkdir -p "$GDB_PREDICATE_RB"/{results,state,gdb,logs/gdb}
gdb_predicate_result="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_PREDICATE_RB"
  STATE_DIR="$GDB_PREDICATE_RB/state"
  empty=0 meta=0 capture=0 log_entry=0 nondir=0 symlink=0 completed=0
  gdb_incomplete_attempt_is_meaningful && empty=1
  printf 'CPU=19\n' > "$GDB_PREDICATE_RB/results/gdb.meta"
  gdb_incomplete_attempt_is_meaningful && meta=1
  rm -f "$GDB_PREDICATE_RB/results/gdb.meta"
  printf 'capture\n' > "$GDB_PREDICATE_RB/gdb/run1.txt"
  gdb_incomplete_attempt_is_meaningful && capture=1
  rm -f "$GDB_PREDICATE_RB/gdb/run1.txt"
  printf 'runner\n' > "$GDB_PREDICATE_RB/logs/gdb/runner.log"
  gdb_incomplete_attempt_is_meaningful && log_entry=1
  rm -rf "$GDB_PREDICATE_RB/gdb" "$GDB_PREDICATE_RB/logs/gdb"
  printf 'not a directory\n' > "$GDB_PREDICATE_RB/gdb"
  gdb_incomplete_attempt_is_meaningful && nondir=1
  rm -f "$GDB_PREDICATE_RB/gdb"
  mkdir -p "$GDB_PREDICATE_RB/logs"
  ln -s "$GDB_PREDICATE_RB/missing" "$GDB_PREDICATE_RB/logs/gdb"
  gdb_incomplete_attempt_is_meaningful && symlink=1
  touch "$GDB_PREDICATE_RB/state/phase-gdb.done"
  gdb_incomplete_attempt_is_meaningful && completed=1
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$empty" "$meta" "$capture" "$log_entry" "$nondir" "$symlink" "$completed"
)"
check_eq "incomplete GDB predicate distinguishes empty setup from attempt evidence" \
  "0|1|1|1|1|1|0" "$gdb_predicate_result"

GDB_EMPTY_RB="$TMP/gdb-empty-retry-bundle"
mkdir -p "$GDB_EMPTY_RB"/{results,state,gdb,logs/gdb}
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_EMPTY_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_EMPTY_RB"
  STATE_DIR="$GDB_EMPTY_RB/state"
  META_FILE="$GDB_EMPTY_RB/results/meta.env"
  archive_incomplete_gdb_attempt
) > /dev/null 2>&1
gdb_empty_archive_rc=$?
check_eq "empty precreated GDB directories do not create an archive transaction" "1" \
  "$([[ $gdb_empty_archive_rc -eq 0 && -d "$GDB_EMPTY_RB/gdb" && -d "$GDB_EMPTY_RB/logs/gdb" && ! -e "$GDB_EMPTY_RB/state/redo.pending" && ! -e "$GDB_EMPTY_RB/state/superseded" ]] && echo 1 || echo 0)"

GDB_RETRY_RB="$TMP/gdb-incomplete-retry-bundle"
mkdir -p "$GDB_RETRY_RB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\nMAX_RUNS=6\nEXIT_CODE=5\n' > "$GDB_RETRY_RB/results/gdb.meta"
printf 'old capture\n' > "$GDB_RETRY_RB/gdb/cpu19-run1.txt"
printf 'old runner\n' > "$GDB_RETRY_RB/logs/gdb/runner.log"
printf 'old results\n' > "$GDB_RETRY_RB/results.json"
printf 'old report\n' > "$GDB_RETRY_RB/report.md"
printf 'old review\n' > "$GDB_RETRY_RB/privacy-review.txt"
printf 'old manifest\n' > "$GDB_RETRY_RB/manifest.txt"
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_RETRY_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_RETRY_RB"
  STATE_DIR="$GDB_RETRY_RB/state"
  META_FILE="$GDB_RETRY_RB/results/meta.env"
  archive_incomplete_gdb_attempt
  archive_incomplete_gdb_attempt
) > /dev/null 2>&1
gdb_retry_archive_rc=$?
gdb_retry_stash="$(find "$GDB_RETRY_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
gdb_retry_archive_ok=0
[[ $gdb_retry_archive_rc -eq 0 ]] &&
  [[ "$(find "$GDB_RETRY_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' | wc -l)" -eq 1 ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/results/gdb.meta")" == $'CPU=19\nMAX_RUNS=6\nEXIT_CODE=5' ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/gdb/cpu19-run1.txt")" == "old capture" ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/logs/gdb/runner.log")" == "old runner" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/results.json")" == "old results" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/report.md")" == "old report" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/privacy-review.txt")" == "old review" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/manifest.txt")" == "old manifest" ]] &&
  [[ ! -e "$GDB_RETRY_RB/results/gdb.meta" && ! -e "$GDB_RETRY_RB/gdb" && ! -e "$GDB_RETRY_RB/logs/gdb" ]] &&
  [[ ! -e "$GDB_RETRY_RB/results.json" && ! -e "$GDB_RETRY_RB/report.md" ]] &&
  [[ ! -e "$GDB_RETRY_RB/state/redo.pending" ]] && gdb_retry_archive_ok=1
check_eq "incomplete GDB evidence and stale derived outputs share one stable archive" "1" "$gdb_retry_archive_ok"

GDB_RETRY_FAIL_RB="$TMP/gdb-incomplete-retry-failure"
mkdir -p "$GDB_RETRY_FAIL_RB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\nEXIT_CODE=5\n' > "$GDB_RETRY_FAIL_RB/results/gdb.meta"
printf 'old capture\n' > "$GDB_RETRY_FAIL_RB/gdb/run1.txt"
printf 'old runner\n' > "$GDB_RETRY_FAIL_RB/logs/gdb/runner.log"
printf 'old report\n' > "$GDB_RETRY_FAIL_RB/report.md"
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_RETRY_FAIL_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_RETRY_FAIL_RB"
  STATE_DIR="$GDB_RETRY_FAIL_RB/state"
  META_FILE="$GDB_RETRY_FAIL_RB/results/meta.env"
  move_count=0
  mv() {
    move_count=$((move_count + 1))
    ((move_count != 3)) || return 97
    command mv "$@"
  }
  archive_incomplete_gdb_attempt
) > /dev/null 2>&1
gdb_retry_fail_rc=$?
gdb_retry_fail_stash="$(find "$GDB_RETRY_FAIL_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
gdb_retry_failure_ok=0
[[ $gdb_retry_fail_rc -ne 0 ]] &&
  [[ -f "$GDB_RETRY_FAIL_RB/state/redo.pending" ]] &&
  [[ "$(stat -c '%a' "$GDB_RETRY_FAIL_RB/state/redo.pending")" == 600 ]] &&
  [[ "$(cat "$gdb_retry_fail_stash/derived/report.md")" == "old report" ]] &&
  [[ -f "$GDB_RETRY_FAIL_RB/results/gdb.meta" ]] &&
  [[ ! -e "$GDB_RETRY_FAIL_RB/state/phase-gdb.done" ]] && gdb_retry_failure_ok=1
check_eq "incomplete GDB archive failure leaves a recoverable transaction" "1" "$gdb_retry_failure_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_RETRY_FAIL_RB"
  STATE_DIR="$GDB_RETRY_FAIL_RB/state"
  META_FILE="$GDB_RETRY_FAIL_RB/results/meta.env"
  recover_pending_redo
  recover_pending_redo
) > /dev/null 2>&1
gdb_retry_recovery_rc=$?
gdb_retry_recovery_ok=0
[[ $gdb_retry_recovery_rc -eq 0 ]] &&
  [[ ! -e "$GDB_RETRY_FAIL_RB/state/redo.pending" ]] &&
  [[ "$(find "$GDB_RETRY_FAIL_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' | wc -l)" -eq 1 ]] &&
  [[ -f "$gdb_retry_fail_stash/gdb/results/gdb.meta" ]] &&
  [[ -f "$gdb_retry_fail_stash/gdb/gdb/run1.txt" ]] &&
  [[ -f "$gdb_retry_fail_stash/gdb/logs/gdb/runner.log" ]] &&
  [[ ! -e "$GDB_RETRY_FAIL_RB/results/gdb.meta" && ! -e "$GDB_RETRY_FAIL_RB/gdb" && ! -e "$GDB_RETRY_FAIL_RB/logs/gdb" ]] && gdb_retry_recovery_ok=1
check_eq "incomplete GDB recovery finishes the same transaction idempotently" "1" "$gdb_retry_recovery_ok"

GDB_SKIP_ORDER_RB="$TMP/gdb-incomplete-to-skip"
mkdir -p "$GDB_SKIP_ORDER_RB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\nEXIT_CODE=5\n' > "$GDB_SKIP_ORDER_RB/results/gdb.meta"
printf 'old capture\n' > "$GDB_SKIP_ORDER_RB/gdb/run1.txt"
printf 'old runner\n' > "$GDB_SKIP_ORDER_RB/logs/gdb/runner.log"
printf 'old report\n' > "$GDB_SKIP_ORDER_RB/report.md"
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_SKIP_ORDER_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_SKIP_ORDER_RB"
  STATE_DIR="$GDB_SKIP_ORDER_RB/state"
  META_FILE="$GDB_SKIP_ORDER_RB/results/meta.env"
  SKIP_GDB=1
  phase_gdb_dispatch 19
) > /dev/null 2>&1
gdb_skip_order_rc=$?
gdb_skip_order_stash="$(find "$GDB_SKIP_ORDER_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
gdb_skip_order_ok=0
[[ $gdb_skip_order_rc -eq 0 ]] &&
  [[ "$(cat "$gdb_skip_order_stash/gdb/results/gdb.meta")" == $'CPU=19\nEXIT_CODE=5' ]] &&
  [[ "$(cat "$gdb_skip_order_stash/gdb/gdb/run1.txt")" == "old capture" ]] &&
  [[ "$(cat "$gdb_skip_order_stash/gdb/logs/gdb/runner.log")" == "old runner" ]] &&
  [[ "$(cat "$gdb_skip_order_stash/derived/report.md")" == "old report" ]] &&
  [[ "$(cat "$GDB_SKIP_ORDER_RB/results/gdb.meta")" == $'SKIPPED=1\nSKIP_REASON=--skip-gdb' ]] &&
  [[ -f "$GDB_SKIP_ORDER_RB/state/phase-gdb.done" ]] &&
  [[ ! -e "$GDB_SKIP_ORDER_RB/state/redo.pending" ]] && gdb_skip_order_ok=1
check_eq "explicit skip archives an incomplete GDB attempt before replacing metadata" "1" "$gdb_skip_order_ok"

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
  REDO_PLAN=(frequency)
  apply_redo_plan
) > /dev/null 2>&1
frequency_stash="$(find "$FB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
frequency_redo_ok=0
[[ -f "$frequency_stash/frequency/results/frequency-ab.tsv" ]] &&
  [[ -f "$frequency_stash/frequency/results/frequency-ab.meta" ]] &&
  [[ "$(cat "$frequency_stash/frequency/freq/freq-ab-A1.samples")" == "old samples" ]] &&
  [[ -f "$frequency_stash/frequency/freq/freq-ab-A1.method" ]] &&
  [[ ! -e "$FB/freq/freq-ab-A1.samples" ]] && frequency_redo_ok=1
check_eq "--redo frequency preserves raw sampler evidence" "1" "$frequency_redo_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  REDO_PHASES=bogus-phase
  build_redo_plan
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
cat > "$DEPENDENT_RB/results/meta.env" << EOF
MODE=default
BASELINE_CHILDREN=16
BASELINE_WAVES=50
GROUP_WAVES=50
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
SKIP_GDB=0
COMPLETED_PHASES=baseline,groups,individual,frequency,gdb
EOF
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
dependent_stash="$(find "$DEPENDENT_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
dependent_redo_ok=0
[[ -f "$DEPENDENT_RB/state/phase-baseline.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-groups.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-individual.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-frequency.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/state/phase-gdb.done" ]] &&
  [[ ! -e "$DEPENDENT_RB/results.json" ]] &&
  [[ ! -e "$DEPENDENT_RB/report.md" ]] &&
  [[ ! -e "$DEPENDENT_RB/manifest.txt" ]] &&
  [[ -f "$dependent_stash/groups/results/groups.tsv" ]] &&
  [[ -f "$dependent_stash/individual/results/individual.tsv" ]] &&
  [[ -f "$dependent_stash/frequency/results/frequency-ab.tsv" ]] &&
  [[ -f "$dependent_stash/gdb/results/gdb.meta" ]] &&
  [[ -f "$dependent_stash/derived/results.json" ]] &&
  grep -q '^COMPLETED_PHASES=baseline$' "$DEPENDENT_RB/results/meta.env" && dependent_redo_ok=1
check_eq "redoing groups invalidates dependent phases and reports" "1" "$dependent_redo_ok"

REDO_FAIL_RB="$TMP/redo-failed-move-bundle"
mkdir -p "$REDO_FAIL_RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n' > "$REDO_FAIL_RB/results/individual.tsv"
printf 'individual log\n' > "$REDO_FAIL_RB/logs/individual/cpu-19.log"
touch "$REDO_FAIL_RB/state/phase-"{baseline,individual,frequency,gdb}.done
cat > "$REDO_FAIL_RB/results/meta.env" << EOF
MODE=default
BASELINE_CHILDREN=16
BASELINE_WAVES=50
GROUP_WAVES=50
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
SKIP_GDB=0
COMPLETED_PHASES=baseline,individual,frequency,gdb
EOF
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_FAIL_RB"
  STATE_DIR="$REDO_FAIL_RB/state"
  META_FILE="$REDO_FAIL_RB/results/meta.env"
  REDO_PLAN=(individual frequency gdb)
  move_count=0
  mv() {
    move_count=$((move_count + 1))
    ((move_count != 3)) || return 97
    command mv "$@"
  }
  apply_redo_plan
) > /dev/null 2>&1
redo_fail_rc=$?
redo_fail_stash="$(find "$REDO_FAIL_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
redo_failure_ok=0
[[ $redo_fail_rc -ne 0 ]] &&
  [[ -f "$REDO_FAIL_RB/state/redo.pending" ]] &&
  [[ "$(stat -c '%a' "$REDO_FAIL_RB/state/redo.pending")" == 600 ]] &&
  [[ -f "$redo_fail_stash/individual/results/individual.tsv" ]] &&
  [[ -f "$REDO_FAIL_RB/logs/individual/cpu-19.log" ]] &&
  [[ ! -e "$REDO_FAIL_RB/state/phase-individual.done" ]] &&
  [[ ! -e "$REDO_FAIL_RB/state/phase-frequency.done" ]] &&
  [[ ! -e "$REDO_FAIL_RB/state/phase-gdb.done" ]] &&
  grep -q '^COMPLETED_PHASES=baseline,individual,frequency,gdb$' "$REDO_FAIL_RB/results/meta.env" && redo_failure_ok=1
check_eq "redo move failure leaves a private recoverable transaction" "1" "$redo_failure_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_FAIL_RB"
  STATE_DIR="$REDO_FAIL_RB/state"
  META_FILE="$REDO_FAIL_RB/results/meta.env"
  recover_pending_redo
) > /dev/null 2>&1
redo_recovery_rc=$?
redo_recovery_ok=0
[[ $redo_recovery_rc -eq 0 ]] &&
  [[ ! -e "$REDO_FAIL_RB/state/redo.pending" ]] &&
  [[ ! -e "$REDO_FAIL_RB/results/individual.tsv" ]] &&
  [[ ! -e "$REDO_FAIL_RB/logs/individual" ]] &&
  [[ -f "$redo_fail_stash/individual/results/individual.tsv" ]] &&
  [[ -f "$redo_fail_stash/individual/logs/individual/cpu-19.log" ]] &&
  [[ "$(find "$REDO_FAIL_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' | wc -l)" -eq 1 ]] && redo_recovery_ok=1
check_eq "redo recovery resumes the same transaction idempotently" "1" "$redo_recovery_ok"

REDO_SIGNAL_RB="$TMP/redo-signal-bundle"
mkdir -p "$REDO_SIGNAL_RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n' > "$REDO_SIGNAL_RB/results/individual.tsv"
touch "$REDO_SIGNAL_RB/state/phase-"{individual,frequency,gdb}.done
printf 'COMPLETED_PHASES=individual,frequency,gdb\n' > "$REDO_SIGNAL_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_SIGNAL_RB"
  STATE_DIR="$REDO_SIGNAL_RB/state"
  META_FILE="$REDO_SIGNAL_RB/results/meta.env"
  REDO_PLAN=(individual frequency gdb)
  finalize_report() { touch "$REDO_SIGNAL_RB/finalized"; }
  move_count=0
  mv() {
    move_count=$((move_count + 1))
    if ((move_count == 2)); then
      kill -TERM "$BASHPID"
      return 98
    fi
    command mv "$@"
  }
  trap 'on_interrupt SIGTERM' TERM
  apply_redo_plan
) > /dev/null 2>&1
redo_signal_rc=$?
redo_signal_ok=0
[[ $redo_signal_rc -eq 143 ]] &&
  [[ -f "$REDO_SIGNAL_RB/state/redo.pending" ]] &&
  [[ -f "$REDO_SIGNAL_RB/results/individual.tsv" ]] &&
  [[ ! -e "$REDO_SIGNAL_RB/finalized" ]] &&
  [[ ! -e "$REDO_SIGNAL_RB/state/phase-individual.done" ]] &&
  grep -q '^INTERRUPTED=1$' "$REDO_SIGNAL_RB/results/meta.env" && redo_signal_ok=1
check_eq "SIGTERM during redo preserves recovery state and skips partial finalization" "1" "$redo_signal_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_SIGNAL_RB"
  STATE_DIR="$REDO_SIGNAL_RB/state"
  META_FILE="$REDO_SIGNAL_RB/results/meta.env"
  recover_pending_redo
) > /dev/null 2>&1
redo_signal_recovery_rc=$?
check_eq "redo resumes after a handled signal" "1" \
  "$([[ $redo_signal_recovery_rc -eq 0 && ! -e "$REDO_SIGNAL_RB/state/redo.pending" && ! -e "$REDO_SIGNAL_RB/results/individual.tsv" ]] && echo 1 || echo 0)"

redo_atomic_bundle_setup() {
  local bundle="$1"
  mkdir -p "$bundle"/{results,state,logs/individual}
  printf '19\t1\t139\t2\n' > "$bundle/results/individual.tsv"
  printf 'old individual log\n' > "$bundle/logs/individual/cpu-19.log"
  touch "$bundle/state/phase-"{baseline,individual,frequency,gdb}.done
  cat > "$bundle/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
UNRELATED_NOTE=preserve-this-row
COMPLETED_PHASES=baseline,individual,frequency,gdb
EOF
}

REDO_MARKER_FAIL="$TMP/redo-marker-publish-failure"
redo_atomic_bundle_setup "$REDO_MARKER_FAIL"
cp "$REDO_MARKER_FAIL/results/meta.env" "$REDO_MARKER_FAIL/meta.before"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_MARKER_FAIL"
  STATE_DIR="$REDO_MARKER_FAIL/state"
  META_FILE="$REDO_MARKER_FAIL/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=1
  REDO_PLAN=(individual frequency gdb)
  redo_marker_rename() { return 97; }
  apply_redo_plan
) > /dev/null 2>&1
redo_marker_fail_rc=$?
redo_marker_fail_ok=0
[[ $redo_marker_fail_rc -ne 0 ]] &&
  [[ ! -e "$REDO_MARKER_FAIL/state/redo.pending" ]] &&
  [[ -f "$REDO_MARKER_FAIL/results/individual.tsv" ]] &&
  [[ -f "$REDO_MARKER_FAIL/state/phase-individual.done" ]] &&
  cmp -s "$REDO_MARKER_FAIL/meta.before" "$REDO_MARKER_FAIL/results/meta.env" && redo_marker_fail_ok=1
check_eq "redo marker publication failure precedes config and evidence mutation" "1" "$redo_marker_fail_ok"
find "$REDO_MARKER_FAIL/state" -maxdepth 1 -type f -name '.redo.pending.*' -delete

REDO_EXACT_RETRY="$TMP/redo-exact-pending-retry"
redo_atomic_bundle_setup "$REDO_EXACT_RETRY"
printf 'original pending command log\n' > "$REDO_EXACT_RETRY/commands.log"
printf 'original pending run log\n' > "$REDO_EXACT_RETRY/run.log"
cp "$REDO_EXACT_RETRY/results/meta.env" "$REDO_EXACT_RETRY/meta.before"
cp "$REDO_EXACT_RETRY/commands.log" "$REDO_EXACT_RETRY/commands.before"
cp "$REDO_EXACT_RETRY/run.log" "$REDO_EXACT_RETRY/run.before"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_EXACT_RETRY"
  STATE_DIR="$REDO_EXACT_RETRY/state"
  META_FILE="$REDO_EXACT_RETRY/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=1
  REDO_PLAN=(individual frequency gdb)
  redo_after_marker_publish() { return 98; }
  apply_redo_plan
) > /dev/null 2>&1
redo_post_publish_rc=$?
redo_post_publish_ok=0
[[ $redo_post_publish_rc -ne 0 ]] &&
  grep -q $'^VERSION\t2$' "$REDO_EXACT_RETRY/state/redo.pending" &&
  grep -q $'^CONFIG\tINDIVIDUAL_RUNS\t9$' "$REDO_EXACT_RETRY/state/redo.pending" &&
  [[ -f "$REDO_EXACT_RETRY/results/individual.tsv" ]] &&
  [[ -f "$REDO_EXACT_RETRY/state/phase-individual.done" ]] &&
  cmp -s "$REDO_EXACT_RETRY/meta.before" "$REDO_EXACT_RETRY/results/meta.env" && redo_post_publish_ok=1
check_eq "post-publication interruption leaves old config and evidence behind a V2 marker" "1" "$redo_post_publish_ok"

"$REPO_ROOT/diagnose.sh" --resume "$REDO_EXACT_RETRY" --redo gdb --yes > /dev/null 2>&1
redo_phase_conflict_rc=$?
redo_phase_conflict_ok=0
[[ $redo_phase_conflict_rc -ne 0 ]] &&
  [[ -f "$REDO_EXACT_RETRY/state/redo.pending" ]] &&
  [[ -f "$REDO_EXACT_RETRY/results/individual.tsv" ]] &&
  [[ ! -e "$REDO_EXACT_RETRY/state/superseded" ]] &&
  cmp -s "$REDO_EXACT_RETRY/meta.before" "$REDO_EXACT_RETRY/results/meta.env" &&
  cmp -s "$REDO_EXACT_RETRY/commands.before" "$REDO_EXACT_RETRY/commands.log" &&
  cmp -s "$REDO_EXACT_RETRY/run.before" "$REDO_EXACT_RETRY/run.log" && redo_phase_conflict_ok=1
check_eq "mismatched repeated redo closure fails before logs, config, evidence, or archive mutate" "1" "$redo_phase_conflict_ok"

cp "$REDO_EXACT_RETRY/results/meta.env" "$REDO_EXACT_RETRY/conflict.before"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_EXACT_RETRY"
  STATE_DIR="$REDO_EXACT_RETRY/state"
  META_FILE="$REDO_EXACT_RETRY/results/meta.env"
  REDO_PLAN=(individual frequency gdb)
  INDIVIDUAL_RUNS=10
  INDIVIDUAL_RUNS_EXPLICIT=1
  reconcile_pending_redo_request
) > /dev/null 2>&1
redo_conflicting_retry_rc=$?
redo_conflicting_retry_ok=0
[[ $redo_conflicting_retry_rc -ne 0 ]] &&
  [[ -f "$REDO_EXACT_RETRY/state/redo.pending" ]] &&
  [[ -f "$REDO_EXACT_RETRY/results/individual.tsv" ]] &&
  [[ ! -e "$REDO_EXACT_RETRY/state/superseded" ]] &&
  cmp -s "$REDO_EXACT_RETRY/conflict.before" "$REDO_EXACT_RETRY/results/meta.env" && redo_conflicting_retry_ok=1
check_eq "conflicting pending retry fails before bundle mutation" "1" "$redo_conflicting_retry_ok"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_EXACT_RETRY"
  STATE_DIR="$REDO_EXACT_RETRY/state"
  META_FILE="$REDO_EXACT_RETRY/results/meta.env"
  REDO_PLAN=(individual frequency gdb)
  INDIVIDUAL_RUNS=9
  INDIVIDUAL_RUNS_EXPLICIT=1
  reconcile_pending_redo_request
  printf '%s|%s|%s\n' "$MODE" "$SKIP_GDB" "$REDO_REQUEST_SATISFIED_BY_PENDING" > "$TMP/redo-exact-adopted"
  recover_pending_redo
  apply_redo_plan
) > /dev/null 2>&1
redo_exact_retry_rc=$?
redo_exact_stash="$(find "$REDO_EXACT_RETRY/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
redo_exact_retry_ok=0
[[ $redo_exact_retry_rc -eq 0 ]] &&
  [[ "$(cat "$TMP/redo-exact-adopted")" == 'quick|1|1' ]] &&
  [[ ! -e "$REDO_EXACT_RETRY/state/redo.pending" ]] &&
  [[ "$(find "$REDO_EXACT_RETRY/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' | wc -l)" -eq 1 ]] &&
  [[ -f "$redo_exact_stash/individual/results/individual.tsv" ]] &&
  [[ "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$REDO_EXACT_RETRY/results/meta.env")" == 9 ]] &&
  [[ "$(sed -n 's/^SKIP_GDB=//p' "$REDO_EXACT_RETRY/results/meta.env")" == 1 ]] &&
  grep -q '^UNRELATED_NOTE=preserve-this-row$' "$REDO_EXACT_RETRY/results/meta.env" &&
  grep -q '^COMPLETED_PHASES=baseline$' "$REDO_EXACT_RETRY/results/meta.env" && redo_exact_retry_ok=1
check_eq "exact pending retry adopts target and finishes one archive" "1" "$redo_exact_retry_ok"

REDO_CONFIG_RENAME="$TMP/redo-config-rename-failure"
redo_atomic_bundle_setup "$REDO_CONFIG_RENAME"
cp "$REDO_CONFIG_RENAME/results/meta.env" "$REDO_CONFIG_RENAME/meta.before"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_CONFIG_RENAME"
  STATE_DIR="$REDO_CONFIG_RENAME/state"
  META_FILE="$REDO_CONFIG_RENAME/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=1
  REDO_PLAN=(individual frequency gdb)
  meta_config_rename() { return 97; }
  apply_redo_plan
) > /dev/null 2>&1
redo_config_rename_rc=$?
redo_config_rename_ok=0
[[ $redo_config_rename_rc -ne 0 ]] &&
  [[ -f "$REDO_CONFIG_RENAME/state/redo.pending" ]] &&
  [[ ! -e "$REDO_CONFIG_RENAME/results/individual.tsv" ]] &&
  [[ ! -e "$REDO_CONFIG_RENAME/state/phase-individual.done" ]] &&
  cmp -s "$REDO_CONFIG_RENAME/meta.before" "$REDO_CONFIG_RENAME/results/meta.env" &&
  ! find "$REDO_CONFIG_RENAME/results" -maxdepth 1 -name '.meta.env.*' -print -quit | grep -q . && redo_config_rename_ok=1
check_eq "config rename failure leaves recoverable archive with old metadata" "1" "$redo_config_rename_ok"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_CONFIG_RENAME"
  STATE_DIR="$REDO_CONFIG_RENAME/state"
  META_FILE="$REDO_CONFIG_RENAME/results/meta.env"
  REDO_PLAN=()
  reconcile_pending_redo_request
  printf '%s|%s|%s\n' "$MODE" "$INDIVIDUAL_RUNS" "$SKIP_GDB" > "$TMP/redo-plain-adopted"
  recover_pending_redo
) > /dev/null 2>&1
redo_plain_recovery_rc=$?
redo_plain_recovery_ok=0
[[ $redo_plain_recovery_rc -eq 0 ]] &&
  [[ "$(cat "$TMP/redo-plain-adopted")" == 'quick|9|1' ]] &&
  [[ ! -e "$REDO_CONFIG_RENAME/state/redo.pending" ]] &&
  [[ "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$REDO_CONFIG_RENAME/results/meta.env")" == 9 ]] &&
  grep -q '^UNRELATED_NOTE=preserve-this-row$' "$REDO_CONFIG_RENAME/results/meta.env" && redo_plain_recovery_ok=1
check_eq "plain recovery adopts the embedded target before phase execution" "1" "$redo_plain_recovery_ok"

REDO_POST_META="$TMP/redo-post-meta-interruption"
redo_atomic_bundle_setup "$REDO_POST_META"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_POST_META"
  STATE_DIR="$REDO_POST_META/state"
  META_FILE="$REDO_POST_META/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=1
  REDO_PLAN=(individual frequency gdb)
  redo_after_meta_publish() { return 99; }
  apply_redo_plan
) > /dev/null 2>&1
redo_post_meta_rc=$?
redo_post_meta_ok=0
[[ $redo_post_meta_rc -ne 0 ]] &&
  [[ -f "$REDO_POST_META/state/redo.pending" ]] &&
  [[ ! -e "$REDO_POST_META/results/individual.tsv" ]] &&
  [[ "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$REDO_POST_META/results/meta.env")" == 9 ]] &&
  grep -q '^COMPLETED_PHASES=baseline$' "$REDO_POST_META/results/meta.env" && redo_post_meta_ok=1
check_eq "post-config pre-unlink interruption retains the committed target and marker" "1" "$redo_post_meta_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$REDO_POST_META"
  STATE_DIR="$REDO_POST_META/state"
  META_FILE="$REDO_POST_META/results/meta.env"
  recover_pending_redo
) > /dev/null 2>&1
redo_post_meta_recovery_rc=$?
check_eq "post-config recovery removes marker without a second archive" "1" \
  "$([[ $redo_post_meta_recovery_rc -eq 0 && ! -e "$REDO_POST_META/state/redo.pending" && "$(find "$REDO_POST_META/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' | wc -l)" -eq 1 ]] && echo 1 || echo 0)"

write_test_v2_marker() {
  local marker="$1" mode="$2" baseline_children="$3" baseline_waves="$4"
  cat > "$marker" << EOF
VERSION	2
TXN	redo-20260802T000000-v2test
CONFIG	MODE	$mode
CONFIG	BASELINE_CHILDREN	$baseline_children
CONFIG	BASELINE_WAVES	$baseline_waves
CONFIG	GROUP_WAVES	10
CONFIG	INDIVIDUAL_RUNS	5
CONFIG	GDB_MAX_RUNS	6
CONFIG	SKIP_GDB	0
PHASE	gdb
EOF
}

FORGED_CONFIG_RB="$TMP/redo-forged-config-closure"
mkdir -p "$FORGED_CONFIG_RB"/{results,state}
cat > "$FORGED_CONFIG_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=baseline,gdb
EOF
touch "$FORGED_CONFIG_RB/state/phase-baseline.done" "$FORGED_CONFIG_RB/state/phase-gdb.done"
write_test_v2_marker "$FORGED_CONFIG_RB/state/redo.pending" default 16 50
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FORGED_CONFIG_RB"
  STATE_DIR="$FORGED_CONFIG_RB/state"
  META_FILE="$FORGED_CONFIG_RB/results/meta.env"
  reconcile_pending_redo_request
) > /dev/null 2>&1
forged_config_rc=$?
forged_config_ok=0
[[ $forged_config_rc -ne 0 ]] &&
  [[ -f "$FORGED_CONFIG_RB/state/phase-baseline.done" ]] &&
  [[ -f "$FORGED_CONFIG_RB/state/phase-gdb.done" ]] &&
  [[ "$(sed -n 's/^MODE=//p' "$FORGED_CONFIG_RB/results/meta.env")" == quick ]] &&
  [[ ! -e "$FORGED_CONFIG_RB/state/superseded" ]] && forged_config_ok=1
check_eq "V2 target cannot relabel completed evidence outside its phase closure" "1" "$forged_config_ok"

MISSING_STORED_CONFIG_RB="$TMP/redo-missing-stored-config"
mkdir -p "$MISSING_STORED_CONFIG_RB"/{results,state}
cat > "$MISSING_STORED_CONFIG_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
COMPLETED_PHASES=baseline,gdb
EOF
touch "$MISSING_STORED_CONFIG_RB/state/phase-baseline.done" "$MISSING_STORED_CONFIG_RB/state/phase-gdb.done"
write_test_v2_marker "$MISSING_STORED_CONFIG_RB/state/redo.pending" quick 8 10
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MISSING_STORED_CONFIG_RB"
  STATE_DIR="$MISSING_STORED_CONFIG_RB/state"
  META_FILE="$MISSING_STORED_CONFIG_RB/results/meta.env"
  reconcile_pending_redo_request
) > /dev/null 2>&1
missing_stored_config_rc=$?
check_eq "missing stored config cannot authorize relabeling completed evidence" "1" \
  "$([[ $missing_stored_config_rc -ne 0 && -f "$MISSING_STORED_CONFIG_RB/state/phase-baseline.done" && ! -e "$MISSING_STORED_CONFIG_RB/state/superseded" ]] && echo 1 || echo 0)"

INVALID_V2_DIR="$TMP/redo-invalid-v2"
mkdir -p "$INVALID_V2_DIR"
write_test_v2_marker "$INVALID_V2_DIR/valid" quick 8 10
sed '/^CONFIG	SKIP_GDB	/d' "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/missing"
awk '{ print; if ($0 == "CONFIG\tMODE\tquick") print }' "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/duplicate"
awk '
  /^CONFIG\tBASELINE_CHILDREN\t/ { child=$0; next }
  /^CONFIG\tBASELINE_WAVES\t/ { print; print child; next }
  { print }
' "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/out-of-order"
sed 's/^CONFIG	INDIVIDUAL_RUNS	5$/CONFIG	INDIVIDUAL_RUNS	05/' \
  "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/noncanonical"
write_test_v2_marker "$INVALID_V2_DIR/unreachable-mode" quick 16 50
sed 's/^VERSION	2$/VERSION	1/' "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/v1-with-config"
sed '/^PHASE	gdb$/i CONFIG\tCPU_TARGET\tauto' \
  "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/valid-current"
sed 's/^CONFIG	CPU_TARGET	auto$/CONFIG\tCPU_TARGET\t01/' \
  "$INVALID_V2_DIR/valid-current" > "$INVALID_V2_DIR/bad-cpu-target"
sed '/^CONFIG	MODE	quick$/a CONFIG\tCPU_TARGET\tauto' \
  "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/cpu-out-of-order"
invalid_v2_result="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  valid=0 current=0 rejected=0 current_profile=0
  redo_transaction_validate "$INVALID_V2_DIR/valid" && valid=1
  if redo_transaction_validate "$INVALID_V2_DIR/valid-current"; then
    current=1
    current_profile=$REDO_TXN_HAS_CPU_TARGET
  fi
  for marker in missing duplicate out-of-order noncanonical unreachable-mode v1-with-config bad-cpu-target cpu-out-of-order; do
    redo_transaction_validate "$INVALID_V2_DIR/$marker" || rejected=$((rejected + 1))
  done
  printf '%s|%s|%s|%s\n' "$valid" "$current" "$current_profile" "$rejected"
)"
check_eq "V2 grammar accepts exact legacy/current profiles and rejects malformed CPU rows" \
  "1|1|1|8" "$invalid_v2_result"

generated_config_rows="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=5 GDB_MAX_RUNS=6 SKIP_GDB=0 CPU_TARGET=auto
  redo_write_config_records
)"
check_eq "generated V2 config ends with the eighth CPU_TARGET row" "1" \
  "$([[ "$(printf '%s\n' "$generated_config_rows" | grep -c '^CONFIG')" -eq 8 && "$(printf '%s\n' "$generated_config_rows" | tail -1)" == $'CONFIG\tCPU_TARGET\tauto' ]] && echo 1 || echo 0)"

echo "== pending CPU policy recovery =="
make_cpu_pending_bundle() {
  local bundle="$1" stored="$2" profile="$3" target="$4"
  mkdir -p "$bundle"/{results,state}
  cat > "$bundle/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=$stored
COMPLETED_PHASES=
EOF
  if [[ "$profile" == v1 ]]; then
    printf 'VERSION\t1\nTXN\tredo-20260802T000000-cpuv1\nPHASE\tgdb\n' > "$bundle/state/redo.pending"
  else
    write_test_v2_marker "$bundle/state/redo.pending" quick 8 10
    if [[ "$profile" == current8 ]]; then
      sed -i "/^PHASE\tgdb$/i CONFIG\tCPU_TARGET\t$target" "$bundle/state/redo.pending"
    fi
  fi
}

LEGACY7_CPU_PENDING="$TMP/pending-cpu-legacy7"
make_cpu_pending_bundle "$LEGACY7_CPU_PENDING" "$TEST_ONLINE_CPU" legacy7 auto
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$LEGACY7_CPU_PENDING" STATE_DIR="$LEGACY7_CPU_PENDING/state"
  META_FILE="$LEGACY7_CPU_PENDING/results/meta.env" CPU_TARGET="$TEST_ONLINE_CPU"
  apply_cpu_target_runtime
  recover_pending_redo
) > /dev/null 2>&1
check_eq "legacy seven-key pending recovery retains the stored CPU target" "$TEST_ONLINE_CPU" \
  "$(sed -n 's/^CPU_TARGET=//p' "$LEGACY7_CPU_PENDING/results/meta.env")"

V1_CPU_PENDING="$TMP/pending-cpu-v1"
make_cpu_pending_bundle "$V1_CPU_PENDING" "$TEST_ONLINE_CPU" v1 auto
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$V1_CPU_PENDING" STATE_DIR="$V1_CPU_PENDING/state"
  META_FILE="$V1_CPU_PENDING/results/meta.env" CPU_TARGET="$TEST_ONLINE_CPU"
  apply_cpu_target_runtime
  recover_pending_redo
) > /dev/null 2>&1
check_eq "V1 pending recovery retains the stored CPU target" "$TEST_ONLINE_CPU" \
  "$(sed -n 's/^CPU_TARGET=//p' "$V1_CPU_PENDING/results/meta.env")"

CURRENT8_CPU_PENDING="$TMP/pending-cpu-current8"
make_cpu_pending_bundle "$CURRENT8_CPU_PENDING" auto current8 "$TEST_ONLINE_CPU"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CURRENT8_CPU_PENDING" STATE_DIR="$CURRENT8_CPU_PENDING/state"
  META_FILE="$CURRENT8_CPU_PENDING/results/meta.env" CPU_TARGET=auto
  apply_cpu_target_runtime
  recover_pending_redo
) > /dev/null 2>&1
check_eq "current eight-key pending target is authoritative and restart-safe" "$TEST_ONLINE_CPU" \
  "$(sed -n 's/^CPU_TARGET=//p' "$CURRENT8_CPU_PENDING/results/meta.env")"

CURRENT8_CPU_POST_META="$TMP/pending-cpu-post-meta"
make_cpu_pending_bundle "$CURRENT8_CPU_POST_META" auto current8 "$TEST_ONLINE_CPU"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CURRENT8_CPU_POST_META" STATE_DIR="$CURRENT8_CPU_POST_META/state"
  META_FILE="$CURRENT8_CPU_POST_META/results/meta.env" CPU_TARGET=auto
  apply_cpu_target_runtime
  redo_after_meta_publish() { return 97; }
  recover_pending_redo
) > /dev/null 2>&1
current8_post_meta_rc=$?
current8_post_meta_staged=0
[[ $current8_post_meta_rc -ne 0 && -f "$CURRENT8_CPU_POST_META/state/redo.pending" &&
  "$(sed -n 's/^CPU_TARGET=//p' "$CURRENT8_CPU_POST_META/results/meta.env")" == "$TEST_ONLINE_CPU" ]] &&
  current8_post_meta_staged=1
check_eq "fixed CPU target is committed before pending-marker unlink" "1" "$current8_post_meta_staged"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CURRENT8_CPU_POST_META" STATE_DIR="$CURRENT8_CPU_POST_META/state"
  META_FILE="$CURRENT8_CPU_POST_META/results/meta.env" CPU_TARGET="$TEST_ONLINE_CPU"
  apply_cpu_target_runtime
  recover_pending_redo
) > /dev/null 2>&1
check_eq "fresh-shell recovery retains fixed CPU after post-meta interruption" "1" \
  "$([[ ! -e "$CURRENT8_CPU_POST_META/state/redo.pending" && "$(sed -n 's/^CPU_TARGET=//p' "$CURRENT8_CPU_POST_META/results/meta.env")" == "$TEST_ONLINE_CPU" ]] && echo 1 || echo 0)"

LEGACY_CPU_CONFLICT="$TMP/pending-cpu-legacy-conflict"
make_cpu_pending_bundle "$LEGACY_CPU_CONFLICT" "$TEST_ONLINE_CPU" legacy7 auto
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$LEGACY_CPU_CONFLICT" STATE_DIR="$LEGACY_CPU_CONFLICT/state"
  META_FILE="$LEGACY_CPU_CONFLICT/results/meta.env"
  CPU_TARGET="$TEST_OTHER_CPU" CPU_EXPLICIT=1
  apply_cpu_target_runtime
  reconcile_pending_redo_request
) > /dev/null 2>&1
legacy_cpu_conflict_rc=$?
check_eq "legacy seven-key pending target rejects an explicit CPU mismatch" "1" \
  "$([[ $legacy_cpu_conflict_rc -ne 0 && -f "$LEGACY_CPU_CONFLICT/state/redo.pending" ]] && echo 1 || echo 0)"

echo "== completed CPU-target evidence gates =="
CPU_EVIDENCE_RB="$TMP/cpu-evidence-gates"
mkdir -p "$CPU_EVIDENCE_RB"/{results,state}
cat > "$CPU_EVIDENCE_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=1
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=individual,gdb
EOF
printf 'VERSION=1\nTARGET_CPUS=%s\nRUNS_PER_CPU=1\nSKIPPED=0\nCOMPLETED=1\n' \
  "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/individual.meta"
printf '%s\t1\t139\t1\n' "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/individual.tsv"
printf 'CPU=%s\nMAX_RUNS=6\nEXIT_CODE=3\n' "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/gdb.meta"
touch "$CPU_EVIDENCE_RB/state/phase-individual.done" "$CPU_EVIDENCE_RB/state/phase-gdb.done"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET=auto
  validate_completed_phase_overrides
)
check_eq "auto CPU policy accepts matching completed GDB evidence" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET="$TEST_OTHER_CPU"
  validate_completed_phase_overrides
) > /dev/null 2>&1
cpu_evidence_mismatch_rc=$?
check_eq "incompatible completed GDB CPU requires redo even without an explicit delta gate" "1" \
  "$([[ $cpu_evidence_mismatch_rc -ne 0 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET="$TEST_OTHER_CPU"
  REDO_PLAN=(gdb)
  validate_completed_phase_overrides
)
check_eq "redo closure authorizes replacement of incompatible GDB CPU evidence" "0" "$?"

rm -f "$CPU_EVIDENCE_RB/results/individual.meta" "$CPU_EVIDENCE_RB/results/individual.tsv"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET=auto
  validate_completed_phase_overrides
) > /dev/null 2>&1
unresolved_auto_rc=$?
check_eq "auto policy requires redo when its worst CPU cannot be resolved" "1" \
  "$([[ $unresolved_auto_rc -ne 0 ]] && echo 1 || echo 0)"

rm -f "$CPU_EVIDENCE_RB/state/phase-individual.done"
printf 'SKIPPED=1\nSKIP_REASON=no failing CPU identified\n' > "$CPU_EVIDENCE_RB/results/gdb.meta"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  cpu_target_matches_completed_phase "$TEST_OTHER_CPU" gdb
)
check_eq "strict no-CPU GDB skip is independent of CPU selection" "0" "$?"
printf 'CPU=%s\nSKIPPED=1\nSKIP_REASON=crafted\n' "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/gdb.meta"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  ! cpu_target_matches_completed_phase "$TEST_OTHER_CPU" gdb
)
check_eq "a GDB record cannot claim both a CPU and skip exemption" "0" "$?"

touch "$CPU_EVIDENCE_RB/state/phase-frequency.done"
printf 'CPU=%s\nRUNS_PER_LEG=1\nRESTORED=1\nCOMPLETED=1\nSKIPPED=1\n' \
  "$TEST_OTHER_CPU" > "$CPU_EVIDENCE_RB/results/frequency-ab.meta"
printf 'A1\t1\t139\t1\nB\t1\t0\t1\nA2\t1\t139\t1\n' > "$CPU_EVIDENCE_RB/results/frequency-ab.tsv"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  ! cpu_target_matches_completed_phase "$TEST_ONLINE_CPU" frequency &&
    ! frequency_result_is_complete "$TEST_ONLINE_CPU"
)
check_eq "frequency skip text cannot bypass exact expected-CPU validation" "0" "$?"

CRAFTED_CPU_MARKER="$TMP/crafted-cpu-marker"
mkdir -p "$CRAFTED_CPU_MARKER"/{results,state}
cp "$CPU_POLICY_RB/results/meta.env" "$CRAFTED_CPU_MARKER/results/meta.env"
printf 'CPU=%s\nMAX_RUNS=6\nEXIT_CODE=3\n' "$TEST_ONLINE_CPU" > "$CRAFTED_CPU_MARKER/results/gdb.meta"
touch "$CRAFTED_CPU_MARKER/state/phase-gdb.done"
write_test_v2_marker "$CRAFTED_CPU_MARKER/state/redo.pending" quick 8 10
sed -i "s/^PHASE\tgdb$/CONFIG\tCPU_TARGET\t$TEST_OTHER_CPU\nPHASE\tbaseline/" \
  "$CRAFTED_CPU_MARKER/state/redo.pending"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CRAFTED_CPU_MARKER" STATE_DIR="$CRAFTED_CPU_MARKER/state"
  META_FILE="$CRAFTED_CPU_MARKER/results/meta.env"
  redo_transaction_validate "$CRAFTED_CPU_MARKER/state/redo.pending" &&
    ! redo_transaction_target_is_authorized
)
check_eq "crafted current V2 target cannot retain mismatched completed CPU evidence" "0" "$?"

echo "== unavailable CPU recovery ordering =="
OFFLINE_PENDING_RB="$TMP/offline-pending-cpu"
make_cpu_pending_bundle "$OFFLINE_PENDING_RB" auto current8 999999
offline_pending_output="$("$REPO_ROOT/diagnose.sh" --resume "$OFFLINE_PENDING_RB" --yes 2>&1)"
offline_pending_rc=$?
check_eq "offline pending CPU target recovers its transaction before stopping" "1" \
  "$([[ $offline_pending_rc -ne 0 && ! -e "$OFFLINE_PENDING_RB/state/redo.pending" && "$(sed -n 's/^CPU_TARGET=//p' "$OFFLINE_PENDING_RB/results/meta.env")" == 999999 && "$offline_pending_output" == *"resume using --cpu auto"* ]] && echo 1 || echo 0)"

OFFLINE_STORED_RB="$TMP/offline-stored-cpu"
mkdir -p "$OFFLINE_STORED_RB"/{results,state}
sed "s/^CPU_TARGET=.*/CPU_TARGET=999999/" "$CPU_POLICY_RB/results/meta.env" > "$OFFLINE_STORED_RB/results/meta.env"
"$REPO_ROOT/diagnose.sh" --resume "$OFFLINE_STORED_RB" --yes > /dev/null 2>&1
offline_stored_rc=$?
check_eq "ordinary stored offline CPU fails before bundle mutation" "1" \
  "$([[ $offline_stored_rc -ne 0 && ! -e "$OFFLINE_STORED_RB/commands.log" ]] && echo 1 || echo 0)"

AUTO_OFFLINE_RB="$TMP/auto-offline-worst"
mkdir -p "$AUTO_OFFLINE_RB"/{results,state}
sed 's/^CPU_TARGET=.*/CPU_TARGET=auto/; s/^COMPLETED_PHASES=.*/COMPLETED_PHASES=preflight,baseline,groups,individual/' \
  "$CPU_POLICY_RB/results/meta.env" > "$AUTO_OFFLINE_RB/results/meta.env"
printf 'VERSION=1\nTARGET_CPUS=%s\nRUNS_PER_CPU=1\nSKIPPED=0\nCOMPLETED=1\n' \
  "$TEST_OFFLINE_CANONICAL_CPU" > "$AUTO_OFFLINE_RB/results/individual.meta"
printf '%s\t1\t139\t1\n' "$TEST_OFFLINE_CANONICAL_CPU" > "$AUTO_OFFLINE_RB/results/individual.tsv"
touch "$AUTO_OFFLINE_RB/state"/phase-{preflight,baseline,groups,individual}.done
auto_offline_output="$("$REPO_ROOT/diagnose.sh" --resume "$AUTO_OFFLINE_RB" --yes 2>&1)"
auto_offline_rc=$?
check_eq "resolved automatic worst CPU must still be online before targeted phases" "1" \
  "$([[ $auto_offline_rc -ne 0 && "$auto_offline_output" == *"resolved automatic worst CPU $TEST_OFFLINE_CANONICAL_CPU"* && ! -e "$AUTO_OFFLINE_RB/state/phase-frequency.done" && ! -e "$AUTO_OFFLINE_RB/state/phase-gdb.done" ]] && echo 1 || echo 0)"

COLLECT_CPU_RB="$TMP/collect-cpu-policy"
mkdir -p "$COLLECT_CPU_RB/results"
printf 'MODE=quick\nCPU_TARGET=%s\n' "$TEST_ONLINE_CPU" > "$COLLECT_CPU_RB/results/meta.env"
node "$LIB/collect.mjs" "$COLLECT_CPU_RB" > /dev/null
collect_fixed_cpu="$(node -e 'const r=require(process.argv[1]); console.log(`${r.config.cpuTarget}|${r.config.cpuTargetPolicy}`)' "$COLLECT_CPU_RB/results.json")"
check_eq "results JSON exposes numeric fixed CPU target and policy" "$TEST_ONLINE_CPU|fixed" "$collect_fixed_cpu"
printf 'MODE=quick\nCPU_TARGET=auto\n' > "$COLLECT_CPU_RB/results/meta.env"
node "$LIB/collect.mjs" "$COLLECT_CPU_RB" > /dev/null
collect_auto_cpu="$(node -e 'const r=require(process.argv[1]); console.log(`${r.config.cpuTarget}|${r.config.cpuTargetPolicy}`)' "$COLLECT_CPU_RB/results.json")"
check_eq "results JSON exposes null plus explicit policy for auto selection" "null|auto" "$collect_auto_cpu"

META_TEMP_CLEANUP="$TMP/meta-temp-cleanup"
mkdir -p "$META_TEMP_CLEANUP"/{results,state}
printf 'MODE=quick\n' > "$META_TEMP_CLEANUP/results/meta.env"
touch "$META_TEMP_CLEANUP/results/.meta.env.interrupted"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  STATE_DIR="$META_TEMP_CLEANUP/state"
  META_FILE="$META_TEMP_CLEANUP/results/meta.env"
  META_UPDATE_TEMP="$META_TEMP_CLEANUP/results/.meta.env.interrupted"
  redo_marker_temp_cleanup
)
check_eq "interruption cleanup removes a tracked atomic metadata temp" "1" \
  "$([[ ! -e "$META_TEMP_CLEANUP/results/.meta.env.interrupted" ]] && echo 1 || echo 0)"

CRAFTED_REDO_RB="$TMP/redo-crafted-marker-bundle"
mkdir -p "$CRAFTED_REDO_RB"/{results,state}
printf 'gdb evidence\n' > "$CRAFTED_REDO_RB/results/gdb.meta"
touch "$CRAFTED_REDO_RB/state/phase-gdb.done"
printf 'COMPLETED_PHASES=gdb\n' > "$CRAFTED_REDO_RB/results/meta.env"
{
  printf 'VERSION\t1\n'
  printf 'TXN\tredo-20260802T000000-crafted\n'
  printf 'PHASE\tgdb\n'
  printf 'ARTIFACT\tgdb\t../victim\n'
  printf 'EVIL=$(touch %s)\n' "$CRAFTED_REDO_RB/evaluated"
} > "$CRAFTED_REDO_RB/state/redo.pending"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CRAFTED_REDO_RB"
  STATE_DIR="$CRAFTED_REDO_RB/state"
  META_FILE="$CRAFTED_REDO_RB/results/meta.env"
  recover_pending_redo
) > /dev/null 2>&1
crafted_redo_rc=$?
crafted_redo_ok=0
[[ $crafted_redo_rc -ne 0 ]] &&
  [[ ! -e "$CRAFTED_REDO_RB/evaluated" ]] &&
  [[ -f "$CRAFTED_REDO_RB/results/gdb.meta" ]] &&
  [[ -f "$CRAFTED_REDO_RB/state/phase-gdb.done" ]] &&
  [[ -f "$CRAFTED_REDO_RB/state/redo.pending" ]] &&
  [[ ! -e "$CRAFTED_REDO_RB/state/superseded" ]] && crafted_redo_ok=1
check_eq "crafted redo marker is data-only and fails closed" "1" "$crafted_redo_ok"

CONFLICT_REDO_RB="$TMP/redo-conflicting-marker-bundle"
conflict_txn="redo-20260802T000000-conflict"
mkdir -p "$CONFLICT_REDO_RB"/{results,state/superseded/$conflict_txn/gdb/results}
printf 'source evidence\n' > "$CONFLICT_REDO_RB/results/gdb.meta"
printf 'archive evidence\n' > "$CONFLICT_REDO_RB/state/superseded/$conflict_txn/gdb/results/gdb.meta"
touch "$CONFLICT_REDO_RB/state/phase-gdb.done"
printf 'COMPLETED_PHASES=gdb\n' > "$CONFLICT_REDO_RB/results/meta.env"
printf 'original command log\n' > "$CONFLICT_REDO_RB/commands.log"
printf 'original run log\n' > "$CONFLICT_REDO_RB/run.log"
printf 'VERSION\t1\nTXN\t%s\nPHASE\tgdb\nARTIFACT\tgdb\tresults/gdb.meta\n' "$conflict_txn" \
  > "$CONFLICT_REDO_RB/state/redo.pending"
cp "$CONFLICT_REDO_RB/results/meta.env" "$CONFLICT_REDO_RB/meta.before"
cp "$CONFLICT_REDO_RB/results/gdb.meta" "$CONFLICT_REDO_RB/source.before"
cp "$CONFLICT_REDO_RB/state/superseded/$conflict_txn/gdb/results/gdb.meta" "$CONFLICT_REDO_RB/archive.before"
cp "$CONFLICT_REDO_RB/commands.log" "$CONFLICT_REDO_RB/commands.before"
cp "$CONFLICT_REDO_RB/run.log" "$CONFLICT_REDO_RB/run.before"
find "$CONFLICT_REDO_RB" -type d -printf '%P\n' | sort > "$CONFLICT_REDO_RB/dirs.before"
"$REPO_ROOT/diagnose.sh" --resume "$CONFLICT_REDO_RB" --yes > /dev/null 2>&1
conflict_redo_rc=$?
conflict_redo_ok=0
[[ $conflict_redo_rc -ne 0 ]] &&
  cmp -s "$CONFLICT_REDO_RB/source.before" "$CONFLICT_REDO_RB/results/gdb.meta" &&
  cmp -s "$CONFLICT_REDO_RB/archive.before" "$CONFLICT_REDO_RB/state/superseded/$conflict_txn/gdb/results/gdb.meta" &&
  cmp -s "$CONFLICT_REDO_RB/meta.before" "$CONFLICT_REDO_RB/results/meta.env" &&
  cmp -s "$CONFLICT_REDO_RB/commands.before" "$CONFLICT_REDO_RB/commands.log" &&
  cmp -s "$CONFLICT_REDO_RB/run.before" "$CONFLICT_REDO_RB/run.log" &&
  [[ -f "$CONFLICT_REDO_RB/state/phase-gdb.done" ]] &&
  [[ -f "$CONFLICT_REDO_RB/state/redo.pending" ]] &&
  find "$CONFLICT_REDO_RB" -type d -printf '%P\n' | sort | cmp -s "$CONFLICT_REDO_RB/dirs.before" - && conflict_redo_ok=1
check_eq "conflicting redo pair fails before logs, directories, config, or evidence mutate" "1" "$conflict_redo_ok"

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
printf 'VERSION\t1\nTXN\tredo-20260802T000000-consent\nPHASE\tindividual\nPHASE\tfrequency\nPHASE\tgdb\nARTIFACT\tindividual\tresults/individual.tsv\n' \
  > "$CONSENT_RB/state/redo.pending"
"$REPO_ROOT/diagnose.sh" --resume "$CONSENT_RB" > /dev/null 2>&1
pending_consent_rc=$?
pending_consent_ok=0
[[ $pending_consent_rc -ne 0 ]] &&
  [[ -f "$CONSENT_RB/state/redo.pending" ]] &&
  [[ -f "$CONSENT_RB/results/individual.tsv" ]] &&
  [[ -f "$CONSENT_RB/state/phase-individual.done" ]] &&
  [[ ! -e "$CONSENT_RB/state/superseded" ]] && pending_consent_ok=1
check_eq "pending redo recovery waits for safety consent" "1" "$pending_consent_ok"

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
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 2 1 &&
    individual_cpu_batch_matches_wrapper "$INDIVIDUAL_VALID" 19 0 2 1
)
check_eq "complete clean/SIGSEGV individual result is accepted" "0" "$?"
printf '19\t2\t1\t0\n' >> "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 3 1
) > /dev/null 2>&1
check_eq "launcher exit is rejected as individual evidence" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
printf '19\t1\t0\t2\n19\t3\t139\t2\n' > "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 3 0
) > /dev/null 2>&1
check_eq "individual run-id gaps are rejected" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
printf '19\t1\t0\t2\n20\t1\t0\t2\n' > "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 2 0
) > /dev/null 2>&1
check_eq "individual rows outside the target CPU set are rejected" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
printf '19\t01\t0\t2\n' > "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 2 0
) > /dev/null 2>&1
check_eq "individual rows require four canonical numeric fields" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
printf '19\t1\t0\t2\textra\n' > "$INDIVIDUAL_VALID"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  individual_rows_are_valid "$INDIVIDUAL_VALID" 19 2 0
) > /dev/null 2>&1
check_eq "individual rows reject extra TSV fields" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

INDIVIDUAL_TOPUP="$TMP/individual-topup"
mkdir -p "$INDIVIDUAL_TOPUP/bin"
cat > "$INDIVIDUAL_TOPUP/bin/taskset" << 'EOF'
#!/usr/bin/env bash
shift 2
exec "$@"
EOF
cat > "$INDIVIDUAL_TOPUP/bin/node" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$INDIVIDUAL_TOPUP/bin/taskset" "$INDIVIDUAL_TOPUP/bin/node"
PATH="$INDIVIDUAL_TOPUP/bin:$PATH" bash "$REPO_ROOT/single.sh" 19 2 "$INDIVIDUAL_TOPUP/results.tsv" 3 > /dev/null 2>&1
check_eq "single.sh top-up records continuing run ids" $'19\t3\t0\t0\n19\t4\t0\t0' \
  "$(cat "$INDIVIDUAL_TOPUP/results.tsv")"

INDIVIDUAL_LEGACY="$TMP/individual-invalid-legacy"
mkdir -p "$INDIVIDUAL_LEGACY"/{results,state}
printf '19\t1\t0\t2\n19\t1\t139\t2\n' > "$INDIVIDUAL_LEGACY/results/individual.tsv"
cp "$INDIVIDUAL_LEGACY/results/individual.tsv" "$INDIVIDUAL_LEGACY/before.tsv"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$INDIVIDUAL_LEGACY"
  STATE_DIR="$INDIVIDUAL_LEGACY/state"
  META_FILE="$INDIVIDUAL_LEGACY/results/meta.env"
  INDIVIDUAL_TARGET_CPUS=19
  INDIVIDUAL_RUNS=2
  phase_individual
) > /dev/null 2>&1
legacy_individual_rc=$?
check_eq "invalid legacy individual rows are preserved and require redo" "1" \
  "$([[ $legacy_individual_rc -ne 0 && ! -e "$INDIVIDUAL_LEGACY/results/individual.meta" ]] && cmp -s "$INDIVIDUAL_LEGACY/before.tsv" "$INDIVIDUAL_LEGACY/results/individual.tsv" && echo 1 || echo 0)"

INDIVIDUAL_COMPLETE="$TMP/individual-complete"
mkdir -p "$INDIVIDUAL_COMPLETE"/{results,state}
printf '19\t1\t0\t2\n19\t2\t139\t2\n' > "$INDIVIDUAL_COMPLETE/results/individual.tsv"
printf 'COMPLETED_PHASES=\n' > "$INDIVIDUAL_COMPLETE/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$INDIVIDUAL_COMPLETE"
  STATE_DIR="$INDIVIDUAL_COMPLETE/state"
  META_FILE="$INDIVIDUAL_COMPLETE/results/meta.env"
  INDIVIDUAL_TARGET_CPUS=19
  INDIVIDUAL_RUNS=2
  phase_individual
) > /dev/null 2>&1
check_eq "individual phase validates all rows and publishes completion metadata" "1" \
  "$([[ $? -eq 0 && -f "$INDIVIDUAL_COMPLETE/state/phase-individual.done" ]] && grep -q '^COMPLETED=1$' "$INDIVIDUAL_COMPLETE/results/individual.meta" && echo 1 || echo 0)"

INDIVIDUAL_SKIPPED="$TMP/individual-skipped"
mkdir -p "$INDIVIDUAL_SKIPPED"/{results,state}
printf 'COMPLETED_PHASES=\n' > "$INDIVIDUAL_SKIPPED/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$INDIVIDUAL_SKIPPED"
  STATE_DIR="$INDIVIDUAL_SKIPPED/state"
  META_FILE="$INDIVIDUAL_SKIPPED/results/meta.env"
  INDIVIDUAL_RUNS=5
  phase_individual_skipped
) > /dev/null 2>&1
skipped_individual_rc=$?
check_eq "skipped individual phase publishes explicit terminal metadata" "1" \
  "$([[ $skipped_individual_rc -eq 0 && -f "$INDIVIDUAL_SKIPPED/state/phase-individual.done" && ! -s "$INDIVIDUAL_SKIPPED/results/individual.tsv" ]] && grep -q '^SKIPPED=1$' "$INDIVIDUAL_SKIPPED/results/individual.meta" && grep -q '^COMPLETED=1$' "$INDIVIDUAL_SKIPPED/results/individual.meta" && echo 1 || echo 0)"

# worst_cpu must rank by the SIGSEGV endpoint only: CPU 3 fails every run
# with a launcher-style exit 1, CPU 4 has one real SIGSEGV.
WORST_CPU_DIR="$TMP/worst-cpu-bundle"
mkdir -p "$WORST_CPU_DIR"/{results,state}
printf '3\t1\t1\t2\n3\t2\t1\t2\n4\t1\t139\t2\n4\t2\t0\t2\n' > "$WORST_CPU_DIR/results/individual.tsv"
printf 'VERSION=1\nTARGET_CPUS=3-4\nRUNS_PER_CPU=2\nSKIPPED=0\nCOMPLETED=1\n' > "$WORST_CPU_DIR/results/individual.meta"
touch "$WORST_CPU_DIR/state/phase-individual.done"
worst_cpu_out="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$WORST_CPU_DIR"
  worst_cpu
)"
check_eq "worst_cpu rejects an invalid completed individual phase" "" "$worst_cpu_out"
printf '3\t1\t0\t2\n3\t2\t0\t2\n4\t1\t139\t2\n4\t2\t0\t2\n' > "$WORST_CPU_DIR/results/individual.tsv"
worst_cpu_out="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$WORST_CPU_DIR"
  worst_cpu
)"
check_eq "worst_cpu ranks only a fully validated individual phase" "4" "$worst_cpu_out"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  gdb_result_is_complete 0 6 2 1 1 0 &&
    gdb_result_is_complete 3 6 6 1 0 5 &&
    ! gdb_result_is_complete 3 6 6 0 0 6 &&
    ! gdb_result_is_complete 3 6 5 5 0 0 &&
    ! gdb_result_is_complete 0 6 6 6 0 0 &&
    ! gdb_result_is_complete 5 6 6 0 0 6
)
check_eq "only reconciled captured/no-fault GDB outcomes are phase-complete" "0" "$?"

GDB_COUNTS_LOG="$TMP/gdb-counts.log"
printf 'run=1 clean\nGDB_RUN_COUNTS attempted=6 clean=1 captured=0 errors=5\n' > "$GDB_COUNTS_LOG"
gdb_counts_status="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  if gdb_run_counts_read "$GDB_COUNTS_LOG" 6; then
    printf '%s|%s|%s|%s\n' "$GDB_ATTEMPTED_RUNS" "$GDB_CLEAN_RUNS" \
      "$GDB_CAPTURED_RUNS" "$GDB_ERROR_RUNS"
  fi
)"
check_eq "terminal GDB accounting parser retains clean/error split" "6|1|0|5" "$gdb_counts_status"
printf 'GDB_RUN_COUNTS attempted=6 clean=1 captured=0 errors=5\nGDB_RUN_COUNTS attempted=6 clean=1 captured=0 errors=5\n' > "$GDB_COUNTS_LOG"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  ! gdb_run_counts_read "$GDB_COUNTS_LOG" 6
)
check_eq "duplicate GDB accounting records are rejected" "0" "$?"

GDB_MALFORMED_PHASE="$TMP/gdb-malformed-phase"
mkdir -p "$GDB_MALFORMED_PHASE"/{results,state,logs/gdb,gdb}
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_MALFORMED_PHASE"
  STATE_DIR="$GDB_MALFORMED_PHASE/state"
  GDB_MAX_RUNS=6
  GDB_MAX_CAPTURES=1
  run_gdb_logged() {
    printf 'GDB_RUN_COUNTS attempted=6 clean=1 captured=0 errors=4\n' > "$5"
    return 3
  }
  phase_gdb 19
) > /dev/null 2>&1
malformed_phase_rc=$?
check_eq "malformed GDB accounting cannot close the phase" "1" \
  "$([[ $malformed_phase_rc -ne 0 && ! -e "$GDB_MALFORMED_PHASE/state/phase-gdb.done" ]] && echo 1 || echo 0)"

FREQUENCY_COMPLETE="$TMP/frequency-complete"
mkdir -p "$FREQUENCY_COMPLETE/results"
printf 'A1\t1\t139\t2\nB\t1\t0\t3\nA2\t1\t0\t2\n' > "$FREQUENCY_COMPLETE/results/frequency-ab.tsv"
printf 'CPU=19\nRUNS_PER_LEG=1\nRESTORED=1\nCOMPLETED=1\n' > "$FREQUENCY_COMPLETE/results/frequency-ab.meta"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete 19
)
check_eq "complete restored frequency A/B/A evidence is accepted" "0" "$?"
sed -i '/^A2/d' "$FREQUENCY_COMPLETE/results/frequency-ab.tsv"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete 19
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
"$REPO_ROOT/diagnose.sh" --gdb-max-runs 06 --dry-run --yes > /dev/null 2>&1
noncanonical_gdb_rc=$?
check_eq "non-canonical gdb attempts are rejected before execution" "1" \
  "$([[ $noncanonical_gdb_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --cpu 01 --dry-run --yes > /dev/null 2>&1
noncanonical_cpu_rc=$?
check_eq "non-canonical CPU overrides are rejected before execution" "1" \
  "$([[ $noncanonical_cpu_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --cpu 999999 --dry-run --yes > /dev/null 2>&1
unusable_cpu_rc=$?
check_eq "unusable CPU override is rejected" "1" "$([[ $unusable_cpu_rc -ne 0 ]] && echo 1 || echo 0)"

echo "== persistent CPU selection policy =="
fixed_cpu_plan="$($REPO_ROOT/diagnose.sh --cpu "$TEST_ONLINE_CPU" --dry-run --yes 2>&1)"
check_eq "numeric --cpu selects a fixed persisted policy" "1" \
  "$([[ "$fixed_cpu_plan" == *"CPU selection      fixed CPU $TEST_ONLINE_CPU"* ]] && echo 1 || echo 0)"

stored_cpu_plan="$($REPO_ROOT/diagnose.sh --resume "$CPU_POLICY_RB" --dry-run --yes 2>&1)"
auto_cpu_plan="$($REPO_ROOT/diagnose.sh --resume "$CPU_POLICY_RB" --cpu auto --dry-run --yes 2>&1)"
check_eq "resume keeps a stored fixed CPU policy" "1" \
  "$([[ "$stored_cpu_plan" == *"CPU selection      fixed CPU $TEST_ONLINE_CPU"* ]] && echo 1 || echo 0)"
check_eq "--cpu auto clears a stored fixed CPU policy" "1" \
  "$([[ "$auto_cpu_plan" == *"CPU selection      auto (worst failing CPU from individual results)"* ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --cpu auto --cpu "$TEST_ONLINE_CPU" --dry-run --yes > /dev/null 2>&1
repeated_cpu_rc=$?
check_eq "repeated --cpu flags are rejected" "1" "$([[ $repeated_cpu_rc -ne 0 ]] && echo 1 || echo 0)"

LEGACY_CPU_RB="$TMP/legacy-cpu-policy"
mkdir -p "$LEGACY_CPU_RB"/{results,state}
sed '/^CPU_TARGET=/d' "$CPU_POLICY_RB/results/meta.env" > "$LEGACY_CPU_RB/results/meta.env"
legacy_cpu_plan="$($REPO_ROOT/diagnose.sh --resume "$LEGACY_CPU_RB" --dry-run --yes 2>&1)"
check_eq "legacy metadata without CPU_TARGET defaults to auto" "1" \
  "$([[ "$legacy_cpu_plan" == *"CPU selection      auto (worst failing CPU from individual results)"* ]] && echo 1 || echo 0)"
for malformed_cpu_meta in duplicate malformed unterminated; do
  BAD_CPU_RB="$TMP/bad-cpu-$malformed_cpu_meta"
  mkdir -p "$BAD_CPU_RB"/{results,state}
  cp "$CPU_POLICY_RB/results/meta.env" "$BAD_CPU_RB/results/meta.env"
  case "$malformed_cpu_meta" in
    duplicate) printf 'CPU_TARGET=auto\n' >> "$BAD_CPU_RB/results/meta.env" ;;
    malformed) sed -i 's/^CPU_TARGET=.*/CPU_TARGET=01/' "$BAD_CPU_RB/results/meta.env" ;;
    unterminated)
      sed '/^CPU_TARGET=/d' "$BAD_CPU_RB/results/meta.env" > "$BAD_CPU_RB/meta.tmp"
      mv "$BAD_CPU_RB/meta.tmp" "$BAD_CPU_RB/results/meta.env"
      printf 'CPU_TARGET=01' >> "$BAD_CPU_RB/results/meta.env"
      ;;
  esac
  "$REPO_ROOT/diagnose.sh" --resume "$BAD_CPU_RB" --dry-run --yes > /dev/null 2>&1
  bad_cpu_meta_rc=$?
  check_eq "malformed stored CPU policy fails closed: $malformed_cpu_meta" "1" \
    "$([[ $bad_cpu_meta_rc -ne 0 && ! -e "$BAD_CPU_RB/commands.log" ]] && echo 1 || echo 0)"
done

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_POLICY_RB"
  STATE_DIR="$CPU_POLICY_RB/state"
  META_FILE="$CPU_POLICY_RB/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=5 GDB_MAX_RUNS=6 SKIP_GDB=0 CPU_TARGET=auto
  apply_cpu_target_runtime
  persist_effective_config
)
check_eq "ordinary atomic config rewrite persists one canonical CPU_TARGET" "1" \
  "$([[ "$(grep -c '^CPU_TARGET=auto$' "$CPU_POLICY_RB/results/meta.env")" -eq 1 ]] && echo 1 || echo 0)"

echo "== reversible GDB skip choice =="
GDB_SKIP_RB="$TMP/gdb-skip-bundle"
mkdir -p "$GDB_SKIP_RB"/{results,state}
cat > "$GDB_SKIP_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=1
COMPLETED_PHASES=
EOF
stored_skip_plan="$($REPO_ROOT/diagnose.sh --resume "$GDB_SKIP_RB" --dry-run --yes 2>&1)"
check_eq "resume keeps the stored GDB skip choice by default" "1" \
  "$([[ "$stored_skip_plan" == *"gdb capture        skipped"* ]] && echo 1 || echo 0)"
run_gdb_plan="$($REPO_ROOT/diagnose.sh --resume "$GDB_SKIP_RB" --run-gdb --dry-run --yes 2>&1)"
check_eq "--run-gdb overrides a stored skip for an incomplete phase" "1" \
  "$([[ "$run_gdb_plan" == *"gdb capture        up to 6 runs"* ]] && echo 1 || echo 0)"
check_eq "dry-run GDB override does not rewrite stored metadata" "1" \
  "$([[ "$(sed -n 's/^SKIP_GDB=//p' "$GDB_SKIP_RB/results/meta.env")" == 1 && ! -e "$GDB_SKIP_RB/commands.log" ]] && echo 1 || echo 0)"

cp "$GDB_SKIP_RB/results/meta.env" "$GDB_SKIP_RB/meta.before"
for inverse_order in \
  "--skip-gdb --run-gdb" \
  "--run-gdb --skip-gdb"; do
  # Deliberately split the fixed test strings into arguments.
  # shellcheck disable=SC2086
  "$REPO_ROOT/diagnose.sh" --resume "$GDB_SKIP_RB" $inverse_order --yes > /dev/null 2>&1
  inverse_conflict_rc=$?
  check_eq "conflicting GDB choices are rejected: $inverse_order" "1" \
    "$([[ $inverse_conflict_rc -ne 0 ]] && echo 1 || echo 0)"
done
check_eq "conflicting GDB choices fail before bundle mutation" "1" \
  "$(cmp -s "$GDB_SKIP_RB/meta.before" "$GDB_SKIP_RB/results/meta.env" && [[ ! -e "$GDB_SKIP_RB/commands.log" && ! -e "$GDB_SKIP_RB/state/superseded" ]] && echo 1 || echo 0)"

printf 'SKIPPED=1\nSKIP_REASON=--skip-gdb\n' > "$GDB_SKIP_RB/results/gdb.meta"
touch "$GDB_SKIP_RB/state/phase-gdb.done"
sed -i 's/^COMPLETED_PHASES=.*/COMPLETED_PHASES=gdb/' "$GDB_SKIP_RB/results/meta.env"
cp "$GDB_SKIP_RB/results/meta.env" "$GDB_SKIP_RB/completed-meta.before"
cp "$GDB_SKIP_RB/results/gdb.meta" "$GDB_SKIP_RB/gdb-meta.before"
"$REPO_ROOT/diagnose.sh" --resume "$GDB_SKIP_RB" --run-gdb --yes > /dev/null 2>&1
completed_skip_override_rc=$?
completed_skip_unchanged=0
[[ $completed_skip_override_rc -ne 0 ]] &&
  cmp -s "$GDB_SKIP_RB/completed-meta.before" "$GDB_SKIP_RB/results/meta.env" &&
  cmp -s "$GDB_SKIP_RB/gdb-meta.before" "$GDB_SKIP_RB/results/gdb.meta" &&
  [[ -f "$GDB_SKIP_RB/state/phase-gdb.done" ]] &&
  [[ ! -e "$GDB_SKIP_RB/commands.log" && ! -e "$GDB_SKIP_RB/state/superseded" ]] && completed_skip_unchanged=1
check_eq "completed skipped GDB phase rejects --run-gdb without redo" "1" "$completed_skip_unchanged"
completed_run_gdb_plan="$($REPO_ROOT/diagnose.sh --resume "$GDB_SKIP_RB" --run-gdb --redo gdb --dry-run --yes 2>&1)"
check_eq "completed skipped GDB phase accepts --run-gdb with redo" "1" \
  "$([[ "$completed_run_gdb_plan" == *"redo phases        gdb"* && "$completed_run_gdb_plan" == *"gdb capture        up to 6 runs"* ]] && echo 1 || echo 0)"
dependent_run_gdb_plan="$($REPO_ROOT/diagnose.sh --resume "$GDB_SKIP_RB" --run-gdb --redo individual --dry-run --yes 2>&1)"
check_eq "dependent redo closure authorizes reversing the GDB skip" "1" \
  "$([[ "$dependent_run_gdb_plan" == *"redo phases        individual frequency gdb"* && "$dependent_run_gdb_plan" == *"gdb capture        up to 6 runs"* ]] && echo 1 || echo 0)"

GDB_RUN_RB="$TMP/gdb-run-bundle"
mkdir -p "$GDB_RUN_RB"/{results,state}
sed 's/^SKIP_GDB=1$/SKIP_GDB=0/; s/^COMPLETED_PHASES=$/COMPLETED_PHASES=gdb/' \
  "$GDB_SKIP_RB/meta.before" > "$GDB_RUN_RB/results/meta.env"
printf 'CPU=0\nMAX_RUNS=6\nEXIT_CODE=3\n' > "$GDB_RUN_RB/results/gdb.meta"
touch "$GDB_RUN_RB/state/phase-gdb.done"
"$REPO_ROOT/diagnose.sh" --resume "$GDB_RUN_RB" --skip-gdb --dry-run --yes > /dev/null 2>&1
completed_run_to_skip_rc=$?
check_eq "completed enabled GDB phase rejects --skip-gdb without redo" "1" \
  "$([[ $completed_run_to_skip_rc -ne 0 ]] && echo 1 || echo 0)"
completed_skip_gdb_plan="$($REPO_ROOT/diagnose.sh --resume "$GDB_RUN_RB" --skip-gdb --redo gdb --dry-run --yes 2>&1)"
check_eq "completed enabled GDB phase accepts --skip-gdb with redo" "1" \
  "$([[ "$completed_skip_gdb_plan" == *"redo phases        gdb"* && "$completed_skip_gdb_plan" == *"gdb capture        skipped"* ]] && echo 1 || echo 0)"

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

ATOMIC_OVERRIDE_RB="$TMP/atomic-ordinary-override"
mkdir -p "$ATOMIC_OVERRIDE_RB"/{results,state}
cat > "$ATOMIC_OVERRIDE_RB/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
UNRELATED_NOTE=keep=verbatim
COMPLETED_PHASES=baseline
EOF
cp "$ATOMIC_OVERRIDE_RB/results/meta.env" "$ATOMIC_OVERRIDE_RB/meta.before"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$ATOMIC_OVERRIDE_RB"
  STATE_DIR="$ATOMIC_OVERRIDE_RB/state"
  META_FILE="$ATOMIC_OVERRIDE_RB/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=0
  meta_config_rename() { return 97; }
  persist_effective_config
) > /dev/null 2>&1
atomic_override_fail_rc=$?
atomic_override_fail_ok=0
[[ $atomic_override_fail_rc -ne 0 ]] &&
  cmp -s "$ATOMIC_OVERRIDE_RB/meta.before" "$ATOMIC_OVERRIDE_RB/results/meta.env" &&
  ! find "$ATOMIC_OVERRIDE_RB/results" -maxdepth 1 -name '.meta.env.*' -print -quit | grep -q . && atomic_override_fail_ok=1
check_eq "ordinary override rename failure preserves the previous metadata generation" "1" "$atomic_override_fail_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$ATOMIC_OVERRIDE_RB"
  STATE_DIR="$ATOMIC_OVERRIDE_RB/state"
  META_FILE="$ATOMIC_OVERRIDE_RB/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=10
  INDIVIDUAL_RUNS=9 GDB_MAX_RUNS=6 SKIP_GDB=0
  persist_effective_config
)
atomic_override_ok=0
[[ "$(sed -n 's/^INDIVIDUAL_RUNS=//p' "$ATOMIC_OVERRIDE_RB/results/meta.env")" == 9 ]] &&
  [[ "$(grep -c '^INDIVIDUAL_RUNS=' "$ATOMIC_OVERRIDE_RB/results/meta.env")" -eq 1 ]] &&
  grep -q '^UNRELATED_NOTE=keep=verbatim$' "$ATOMIC_OVERRIDE_RB/results/meta.env" &&
  grep -q '^COMPLETED_PHASES=baseline$' "$ATOMIC_OVERRIDE_RB/results/meta.env" && atomic_override_ok=1
check_eq "ordinary override publishes one atomic config while preserving unrelated metadata" "1" "$atomic_override_ok"

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
mkdir -p "$MB/nested"
printf 'nested historical manifest\n' > "$MB/nested/manifest.txt"
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
grep -q '  \./nested/manifest\.txt$' "$MB/manifest.txt"
check_eq "manifest excludes only its own top-level output" "0" "$?"
(cd "$MB" && sha256sum -c manifest.txt) > /dev/null 2>&1
check_eq "manifest verifies immediately after the run" "0" "$?"

MANIFEST_FAIL_BUNDLE="$TMP/manifest-failure-bundle"
MANIFEST_FAIL_BIN="$TMP/manifest-failure-bin"
mkdir -p "$MANIFEST_FAIL_BUNDLE" "$MANIFEST_FAIL_BIN"
printf 'payload\n' > "$MANIFEST_FAIL_BUNDLE/payload.txt"
printf 'previous manifest\n' > "$MANIFEST_FAIL_BUNDLE/manifest.txt"
printf '#!/usr/bin/env bash\nexit 7\n' > "$MANIFEST_FAIL_BIN/sha256sum"
chmod +x "$MANIFEST_FAIL_BIN/sha256sum"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MANIFEST_FAIL_BUNDLE"
  DIAG_LOG_FILE=""
  PATH="$MANIFEST_FAIL_BIN:$PATH"
  write_manifest
) > /dev/null 2>&1
manifest_failure_rc=$?
check_eq "failed hash pass preserves the previous manifest atomically" "1" \
  "$([[ $manifest_failure_rc -ne 0 && "$(cat "$MANIFEST_FAIL_BUNDLE/manifest.txt")" == 'previous manifest' ]] && ! compgen -G "${MANIFEST_FAIL_BUNDLE}.manifest.*" > /dev/null && echo 1 || echo 0)"

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
touch "$B/state/phase-individual.done" "$B/state/phase-frequency.done" "$B/state/phase-gdb.done"

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

# CPU 8: 20 clean runs; CPU 19: 6 SIGSEGV in 20 runs.
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
cat > "$B/results/individual.meta" << EOF
VERSION=1
TARGET_CPUS=8,19
RUNS_PER_CPU=20
SKIPPED=0
COMPLETED=1
EOF

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
ATTEMPTED_RUNS=1
CLEAN_RUNS=0
CAPTURED_RUNS=1
ERROR_RUNS=0
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
check("individual phase completion status", r.individualStatus.status === "complete" && r.individual[1].runs === 20);
check("gdb signature match", r.gdb.status === "captured" && r.gdb.captures.length === 1 && r.gdb.captures[0].matchesKnownSignature === true);
check("gdb attempt accounting", r.gdb.attemptedRuns === 1 && r.gdb.cleanRuns === 0 && r.gdb.capturedRuns === 1 && r.gdb.errorRuns === 0);
check("gdb capture file trimmed", r.gdb.captures[0].mappings === undefined);
check("freq ab restored + legs", r.frequencyAb.restored === true && r.frequencyAb.legs.length === 3);
check("freq leg B measured clock", r.frequencyAb.legs[1].frequency.avgMHz === 2100);
check("group failure tally", r.groups.length === 2 && r.groups[1].sigsegvCount === 2 && r.groups[0].sigsegvCount === 0);
check("root checks merged", Boolean(r.rootChecks) && r.rootChecks["cctk.txt"].includes("IntelTME=Disabled"));
process.exit(failures === 0 ? 0 : 1);
EOF
if node "$TMP/check-results.mjs" "$B/results.json"; then
  pass=$((pass + 14))
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
