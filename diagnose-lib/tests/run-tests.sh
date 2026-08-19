#!/usr/bin/env bash
# run-tests.sh - test suite for the diagnostic runner tooling.
#
# Covers: CPU-list parsing, settings restore on SIGINT/SIGTERM/normal exit,
# script argument validation and exit codes, workload-contract validation,
# statistics, log/capture parsing, and an end-to-end collect+report run on a
# synthetic bundle.
# Nothing here runs the actual crash workload.
set -u

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/diagnose-lib"
FIX="$LIB/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Keep every main-script test hermetic even when a fixture unexpectedly gets
# farther than intended. Capture the real interpreter before prepending a
# fail-closed wrapper; diagnostic helpers still run normally, while the two
# memory-intensive workload entrypoints can never be launched by this suite.
DIAG_TEST_REAL_NODE_BIN="$(command -v node)"
DIAG_TEST_HERMETIC_BIN="$TMP/hermetic-bin"
mkdir -p "$DIAG_TEST_HERMETIC_BIN"
cat > "$DIAG_TEST_HERMETIC_BIN/node" << 'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  repro.mjs | child.mjs | */repro.mjs | */child.mjs)
    printf 'test harness refused workload entrypoint: %s\n' "$1" >&2
    exit 97
    ;;
esac
exec "$DIAG_TEST_REAL_NODE_BIN" "$@"
EOF
chmod +x "$DIAG_TEST_HERMETIC_BIN/node"
export DIAG_TEST_REAL_NODE_BIN
export DIAG_TEST_FORBID_WORKLOAD=1
export PATH="$DIAG_TEST_HERMETIC_BIN:$PATH"

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

safe_uint_boundaries="$({
  for value in 1 9 9007199254740991; do
    diag_is_safe_positive_uint "$value" && printf 'accept:%s\n' "$value"
  done
  for value in '' 0 00 01 +1 -1 ' 1' '1 ' 9007199254740992 10000000000000000; do
    diag_is_safe_positive_uint "$value" || printf 'reject:%s\n' "$value"
  done
})"
check_eq "safe positive integer validation uses JavaScript boundaries" \
  $'accept:1\naccept:9\naccept:9007199254740991\nreject:\nreject:0\nreject:00\nreject:01\nreject:+1\nreject:-1\nreject: 1\nreject:1 \nreject:9007199254740992\nreject:10000000000000000' \
  "$safe_uint_boundaries"

SAMPLER_SYSFS="$TMP/sampler-sysfs"
mkdir -p "$SAMPLER_SYSFS/cpu7/cpufreq"
printf '4700000\n' > "$SAMPLER_SYSFS/cpu7/cpufreq/scaling_cur_freq"
sampler_one_shot="$(/bin/bash "$LIB/frequency-sampler.sh" --once "$SAMPLER_SYSFS")"
check_eq "scaling frequency sampler emits a valid one-shot row" "1" \
  "$([[ "$sampler_one_shot" =~ ^[0-9]{9,}[[:space:]]7[[:space:]]4700000$ ]] && echo 1 || echo 0)"
printf '%s\n' "$sampler_one_shot" > "$TMP/sampler-valid.samples"
check_eq "frequency sample validator accepts sampler output" "1" \
  "$(diag_frequency_samples_have_valid_row "$TMP/sampler-valid.samples" scaling_cur_freq && echo 1 || echo 0)"

write_preflight_fixture() {
  local bundle="$1" generation="${2:-0123456789abcdef0123456789abcdef}"
  local -a files=(
    cmdline.txt cpuinfo-extra.txt cpufreq.txt cctk.txt date.txt dependencies.txt
    dmi.txt kernel-warnings.txt lscpu.txt node.txt online.txt os-release.txt
    power.txt summary.env topology.tsv uname.txt undervolt.txt
  )
  local name file_digest manifest_digest
  mkdir -p "$bundle"/{env,results,state}
  for name in "${files[@]}"; do
    [[ "$name" == summary.env ]] && continue
    [[ -e "$bundle/env/$name" ]] || printf '%s\n' "$name" > "$bundle/env/$name"
  done
  if [[ ! -e "$bundle/env/summary.env" ]]; then
    cat > "$bundle/env/summary.env" << EOF
DISTRO=TestOS
KERNEL=Linux 6.0-test
CMDLINE=
NODE_VERSION=v25.2.1
V8_VERSION=14.1-test
PGLITE_VERSION=0.3.0
CPU_MODEL=Test CPU
CPU_STEPPING=1
CPU_MICROCODE=0x123
CPU_ADDRESS_SIZES=46 bits physical, 48 bits virtual
CPU_LOGICAL=2
ONLINE_CPUS=0-1
KERNEL_ONLINE_CPUS=0-1
ALLOWED_CPUS=0-1
P_CORES=0
E_CORES=1
DMI_PRODUCT=Test Product
DMI_BOARD=Test Board
BIOS_VERSION=1.0
BIOS_DATE=01/01/2026
CPUFREQ_DRIVER=intel_pstate
GOVERNOR=powersave
EPP=balance_performance
NO_TURBO=0
TME_STATE=unknown
POWER_SOURCE=AC
UNDERVOLT_STATE=not installed
CCTK_STATE=not installed
MISSING_OPTIONAL=none
EOF
  fi
  printf 'start_iso=2026-08-02T00:00:00+00:00\nstart_epoch=1785686400\n' > "$bundle/env/date.txt"
  : > "$bundle/env/preflight.manifest"
  for name in "${files[@]}"; do
    file_digest="$(sha256sum "$bundle/env/$name" | awk '{print $1}')"
    printf '%s\t%s\n' "$file_digest" "$name" >> "$bundle/env/preflight.manifest"
  done
  manifest_digest="$(sha256sum "$bundle/env/preflight.manifest" | awk '{print $1}')"
  cat > "$bundle/results/preflight.meta" << EOF
VERSION=1
GENERATION=$generation
COLLECTED_EPOCH=1785686400
INVENTORY_SHA256=$manifest_digest
COMPLETED=1
EOF
  : > "$bundle/state/phase-preflight.done"
}

write_frequency_ab_fixture_meta() {
  local bundle="$1" cpu="$2" runs="$3"
  local generation=0123456789abcdef0123456789abcdef
  local rows_sha a1_samples_sha a1_method_sha b_samples_sha b_method_sha a2_samples_sha a2_method_sha
  rows_sha="$(sha256sum "$bundle/results/frequency-ab.tsv" | awk '{print $1}')"
  a1_samples_sha="$(sha256sum "$bundle/freq/freq-ab-A1.samples" | awk '{print $1}')"
  a1_method_sha="$(sha256sum "$bundle/freq/freq-ab-A1.method" | awk '{print $1}')"
  b_samples_sha="$(sha256sum "$bundle/freq/freq-ab-B.samples" | awk '{print $1}')"
  b_method_sha="$(sha256sum "$bundle/freq/freq-ab-B.method" | awk '{print $1}')"
  a2_samples_sha="$(sha256sum "$bundle/freq/freq-ab-A2.samples" | awk '{print $1}')"
  a2_method_sha="$(sha256sum "$bundle/freq/freq-ab-A2.method" | awk '{print $1}')"
  cat > "$bundle/results/frequency-ab.meta" << EOF
GENERATION=$generation
CPU=$cpu
RUNS_PER_LEG=$runs
SAVED_NO_TURBO=0
CAP_REQUESTED=0
REQUESTED_CAP_KHZ=-
LEG_A1_NO_TURBO=0
LEG_A1_SCALING_MAX_KHZ=5500000
LEG_B_NO_TURBO=1
LEG_B_SCALING_MAX_KHZ=5500000
LEG_A2_NO_TURBO=0
LEG_A2_SCALING_MAX_KHZ=5500000
RESTORED=1
ROWS_SHA256=$rows_sha
LEG_A1_SAMPLES_SHA256=$a1_samples_sha
LEG_A1_METHOD_SHA256=$a1_method_sha
LEG_B_SAMPLES_SHA256=$b_samples_sha
LEG_B_METHOD_SHA256=$b_method_sha
LEG_A2_SAMPLES_SHA256=$a2_samples_sha
LEG_A2_METHOD_SHA256=$a2_method_sha
CAP_COMPLETED=0
COMPLETED=1
EOF
}

# Shared groups-envelope generation for fixtures whose individual evidence must
# bind the exact validated groups generation (individual.meta GROUP_GENERATION).
GROUPS_TEST_GENERATION=00112233445566778899aabbccddeeff

write_individual_v4_meta() {
  local bundle="$1" targets="$2" runs="$3" policy="$4" plan_digest="$5"
  local group_generation="$6" skipped="$7" completed="$8" reason="${9:-}"
  local rows_sha rows_bytes row_count
  rows_sha="$(sha256sum "$bundle/results/individual.tsv" | awk '{print $1}')"
  rows_bytes="$(stat -c %s "$bundle/results/individual.tsv")"
  row_count="$(awk 'END { print NR + 0 }' "$bundle/results/individual.tsv")"
  {
    printf 'VERSION=4\nGENERATION=%s\n' 0123456789abcdef0123456789abcdef
    printf 'TARGET_CPUS=%s\nRUNS_PER_CPU=%s\n' "$targets" "$runs"
    printf 'TARGET_POLICY=%s\nGROUP_PLAN_DIGEST=%s\nGROUP_GENERATION=%s\n' \
      "$policy" "$plan_digest" "$group_generation"
    printf 'SKIPPED=%s\nCOMPLETED=%s\n' "$skipped" "$completed"
    [[ -z "$reason" ]] || printf 'SKIP_REASON=%s\n' "$reason"
    if [[ "$completed" == 1 ]]; then
      printf 'ROWS_SHA256=%s\nROWS_BYTES=%s\nROW_COUNT=%s\n' \
        "$rows_sha" "$rows_bytes" "$row_count"
    fi
  } > "$bundle/results/individual.meta"
}

# Build a complete, valid, marked-done GDB evidence envelope in a test
# bundle: synthetic runner.log, provenance-bound transcripts for retained
# attempts, the legacy-shaped results/gdb.meta, and the authoritative
# results/gdb.manifest built and validated by diagnose-lib/gdb-evidence.mjs.
# A captured outcome stops at the capture cap (or run exhaustion when the cap
# exceeds the run limit); captured-then-clean records exactly one capture and
# then clean runs to exhaustion. Both keep the terminal accounting
# reconciled. The capture limit must match the runner configuration
# (diagnose.sh GDB_MAX_CAPTURES) or later envelope validation fails closed.
# Usage: write_gdb_run_fixture <bundle> <cpu> <max_runs> <max_captures> \
#          <captured|captured-then-clean|no-fault> [transcript-body-file]
write_gdb_run_fixture() {
  local bundle="$1" cpu="$2" max_runs="$3" max_captures="$4" outcome="$5" body="${6:-}"
  local generation=0123456789abcdef0123456789abcdef
  local runner="$bundle/logs/gdb/runner.log"
  local run attempts clean=0 captured=0 errors=0 rc capture_runs run_outcome
  mkdir -p "$bundle"/{results,state,gdb,logs/gdb}
  : > "$runner"
  case "$outcome" in
    captured)
      rc=0
      if ((max_captures < max_runs)); then
        attempts="$max_captures"
      else
        attempts="$max_runs"
      fi
      capture_runs="$attempts"
      ;;
    captured-then-clean)
      rc=0
      attempts="$max_runs"
      capture_runs=1
      ;;
    no-fault)
      rc=3
      attempts="$max_runs"
      capture_runs=0
      ;;
    *)
      printf 'FIXTURE FAILURE: unknown gdb fixture outcome %s\n' "$outcome" >&2
      exit 1
      ;;
  esac
  for ((run = 1; run <= attempts; run++)); do
    run_outcome=clean
    ((run <= capture_runs)) && run_outcome=captured
    if [[ "$run_outcome" == captured ]]; then
      {
        printf 'GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tRUN\t%s\tOUTCOME\tcaptured\n' \
          "$generation" "$cpu" "$max_runs" "$max_captures" "$run"
        if [[ -n "$body" && "$run" == 1 ]]; then
          cat -- "$body"
        else
          printf 'Program received signal SIGSEGV, Segmentation fault.\n'
        fi
        printf 'GDB_TRANSCRIPT_END\tGENERATION\t%s\tCPU\t%s\tRUN\t%s\tOUTCOME\tcaptured\n' \
          "$generation" "$cpu" "$run"
      } > "$bundle/gdb/cpu${cpu}-run${run}.txt"
      captured=$((captured + 1))
    else
      clean=$((clean + 1))
    fi
    printf 'ATTEMPT\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tRUN\t%s\tOUTCOME\t%s\n' \
      "$generation" "$cpu" "$max_runs" "$max_captures" "$run" "$run_outcome" >> "$runner"
  done
  printf 'COUNTS\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tATTEMPTED\t%s\tCLEAN\t%s\tCAPTURED\t%s\tERRORS\t%s\tEXIT_CODE\t%s\n' \
    "$generation" "$cpu" "$max_runs" "$max_captures" \
    "$attempts" "$clean" "$captured" "$errors" "$rc" >> "$runner"
  {
    printf 'CPU=%s\n' "$cpu"
    printf 'MAX_RUNS=%s\n' "$max_runs"
    printf 'EXIT_CODE=%s\n' "$rc"
    printf 'ATTEMPTED_RUNS=%s\n' "$attempts"
    printf 'CLEAN_RUNS=%s\n' "$clean"
    printf 'CAPTURED_RUNS=%s\n' "$captured"
    printf 'ERROR_RUNS=%s\n' "$errors"
  } > "$bundle/results/gdb.meta"
  node "$LIB/gdb-evidence.mjs" build "$bundle" \
    "$bundle/results/.gdb.manifest.$generation" "$generation" \
    "$cpu" "$max_runs" "$max_captures" > /dev/null || {
    printf 'FIXTURE FAILURE: gdb run envelope build failed for %s\n' "$bundle" >&2
    exit 1
  }
  mv -n -- "$bundle/results/.gdb.manifest.$generation" "$bundle/results/gdb.manifest" || {
    printf 'FIXTURE FAILURE: gdb manifest rename failed for %s\n' "$bundle" >&2
    exit 1
  }
  : > "$bundle/state/phase-gdb.done"
  node "$LIB/gdb-evidence.mjs" validate-complete "$bundle" \
    "$cpu" "$max_runs" "$max_captures" > /dev/null || {
    printf 'FIXTURE FAILURE: gdb run envelope does not validate for %s\n' "$bundle" >&2
    exit 1
  }
}

# Build a complete, valid, marked-done GDB skip envelope in a test bundle.
# Usage: write_gdb_skip_fixture <bundle> <reason> [max_runs] [max_captures]
write_gdb_skip_fixture() {
  local bundle="$1" reason="$2" max_runs="${3:-6}" max_captures="${4:-3}"
  local generation=0123456789abcdef0123456789abcdef
  mkdir -p "$bundle"/{results,state,gdb,logs/gdb}
  printf 'SKIPPED=1\nSKIP_REASON=%s\n' "$reason" > "$bundle/results/gdb.meta"
  node "$LIB/gdb-evidence.mjs" build "$bundle" \
    "$bundle/results/.gdb.manifest.$generation" "$generation" \
    - "$max_runs" "$max_captures" > /dev/null || {
    printf 'FIXTURE FAILURE: gdb skip envelope build failed for %s\n' "$bundle" >&2
    exit 1
  }
  mv -n -- "$bundle/results/.gdb.manifest.$generation" "$bundle/results/gdb.manifest" || {
    printf 'FIXTURE FAILURE: gdb manifest rename failed for %s\n' "$bundle" >&2
    exit 1
  }
  : > "$bundle/state/phase-gdb.done"
  node "$LIB/gdb-evidence.mjs" validate-complete "$bundle" \
    - "$max_runs" "$max_captures" > /dev/null || {
    printf 'FIXTURE FAILURE: gdb skip envelope does not validate for %s\n' "$bundle" >&2
    exit 1
  }
}

prepare_frequency_publish_stage() {
  local stage="$1" cap_requested="$2"
  mkdir -p "$stage/results" "$stage/freq"
  chmod 0700 "$stage" "$stage/results" "$stage/freq"
  printf 'new A/B/A evidence\n' > "$stage/results/frequency-ab.tsv"
  printf 'new command\n' > "$stage/commands.log"
  {
    printf 'VERSION=1\n'
    printf 'GENERATION=0123456789abcdef0123456789abcdef\n'
    printf 'CAP_REQUESTED=%s\n' "$cap_requested"
  } > "$stage/publish-control.meta"
  chmod 0600 "$stage/results/frequency-ab.tsv" "$stage/commands.log" \
    "$stage/publish-control.meta"
}

write_derived_output_fixture() {
  local bundle="$1" name
  for name in manifest.txt privacy-review.txt results.json report.md; do
    printf 'stale %s\n' "$name" > "$bundle/$name"
  done
}

write_frequency_snapshot_node_wrapper() {
  local path="$1"
  cat > "$path" <<'EOF'
#!/usr/bin/env bash
output="$("$REAL_NODE_BIN" "$@")"
rc=$?
((rc == 0)) || exit "$rc"
if [[ "$2" == "$SNAPSHOT_KIND" && "$3" == "$SNAPSHOT_SOURCE" &&
  ! -e "$SNAPSHOT_ONCE" ]]; then
  case "$SNAPSHOT_REPLACEMENT" in
    fifo)
      rm -f -- "$SNAPSHOT_SOURCE"
      mkfifo "$SNAPSHOT_SOURCE"
      chmod 0600 "$SNAPSHOT_SOURCE"
      ;;
    symlink)
      mv -T -- "$SNAPSHOT_SOURCE" "$SNAPSHOT_TARGET"
      ln -s "$SNAPSHOT_TARGET" "$SNAPSHOT_SOURCE"
      ;;
    *) exit 91 ;;
  esac
  : > "$SNAPSHOT_ONCE"
fi
printf '%s\n' "$output"
EOF
  chmod 0700 "$path"
}

derived_outputs_absent() {
  local bundle="$1" name
  for name in manifest.txt privacy-review.txt results.json report.md; do
    [[ ! -e "$bundle/$name" && ! -L "$bundle/$name" ]] || return 1
  done
}

derived_outputs_present() {
  local bundle="$1" name
  for name in manifest.txt privacy-review.txt results.json report.md; do
    [[ -e "$bundle/$name" || -L "$bundle/$name" ]] || return 1
  done
}

derived_transaction_temps_absent() {
  local bundle="$1" name
  for name in \
    .results.json.pending .report.md.pending .manifest.txt.pending \
    .privacy-review.pending .privacy-inventory-before.pending \
    .privacy-inventory-after.pending; do
    [[ ! -e "$bundle/$name" && ! -L "$bundle/$name" ]] || return 1
  done
}

seal_root_checks_fixture() {
  local directory="$1" generation="${2:-abcdef0123456789abcdef0123456789}"
  local kernel_sha undervolt_sha cctk_sha turbostat_sha
  kernel_sha="$(sha256sum "$directory/kernel-warnings.txt" | awk '{print $1}')"
  undervolt_sha="$(sha256sum "$directory/intel-undervolt.txt" | awk '{print $1}')"
  cctk_sha="$(sha256sum "$directory/cctk.txt" | awk '{print $1}')"
  turbostat_sha="$(sha256sum "$directory/turbostat.txt" | awk '{print $1}')"
  cat > "$directory/root-checks.meta" << EOF
VERSION=1
GENERATION=$generation
COLLECTED_AT=2026-08-02T20:00:00+00:00
KERNEL_WARNINGS_SHA256=$kernel_sha
INTEL_UNDERVOLT_SHA256=$undervolt_sha
CCTK_SHA256=$cctk_sha
TURBOSTAT_SHA256=$turbostat_sha
COMPLETED=1
EOF
}

write_root_checks_fixture() {
  local bundle="$1" generation="${2:-abcdef0123456789abcdef0123456789}" name
  local directory="$bundle/env/root"
  mkdir -p "$directory"
  for name in kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt; do
    [[ -e "$directory/$name" ]] || printf 'root-check payload %s\n' "$name" > "$directory/$name"
  done
  seal_root_checks_fixture "$directory" "$generation"
  : > "$directory/root-checks.done"
}

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

(
  diag_cleanup_now() { :; }
  diag_cleanup_artifacts() { return 75; }
  diag_restore_lock_release() { :; }
  diag_cleanup_exit 0
) > /dev/null 2>&1
cleanup_busy_rc=$?
check_eq "normal cleanup preserves retryable publisher contention status" "75" \
  "$cleanup_busy_rc"

CLEANUP_DRAIN_FAIL_LOG="$TMP/cleanup-drain-fail.log"
(
  diag_workload_stop() { printf 'workload\n' >> "$CLEANUP_DRAIN_FAIL_LOG"; return 125; }
  diag_freq_sampler_stop() { printf 'sampler\n' >> "$CLEANUP_DRAIN_FAIL_LOG"; return 125; }
  diag_restore_now() { printf 'restore\n' >> "$CLEANUP_DRAIN_FAIL_LOG"; }
  diag_cleanup_artifacts() { printf 'publish\n' >> "$CLEANUP_DRAIN_FAIL_LOG"; }
  diag_restore_lock_release() { printf 'unlock\n' >> "$CLEANUP_DRAIN_FAIL_LOG"; }
  diag_cleanup_exit 0
) > /dev/null 2>&1
cleanup_drain_fail_rc=$?
check_eq "failed writer drain blocks restore, publication, and restore-lock release" \
  $'125:workload\nsampler' \
  "$cleanup_drain_fail_rc:$(cat "$CLEANUP_DRAIN_FAIL_LOG")"

CLEANUP_SIGNAL_DRAIN_FAIL_LOG="$TMP/cleanup-signal-drain-fail.log"
(
  diag_workload_stop() { printf 'workload\n' >> "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG"; return 125; }
  diag_freq_sampler_stop() { printf 'sampler\n' >> "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG"; return 125; }
  diag_restore_now() { printf 'restore\n' >> "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG"; }
  diag_cleanup_artifacts() { printf 'publish\n' >> "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG"; }
  diag_restore_lock_release() { printf 'unlock\n' >> "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG"; }
  diag_cleanup_signal SIGTERM 143
) > /dev/null 2>&1
cleanup_signal_drain_fail_rc=$?
check_eq "signal cleanup preserves signal status while retaining failed-drain recovery authority" \
  $'143:workload\nsampler' \
  "$cleanup_signal_drain_fail_rc:$(cat "$CLEANUP_SIGNAL_DRAIN_FAIL_LOG")"

FREQUENCY_DRAIN_FAIL_LOG="$TMP/frequency-drain-fail.log"
FREQUENCY_DRAIN_FAIL_TSV="$TMP/frequency-drain-fail.tsv"
(
  DIAG_WORKLOAD_PID=""
  DIAG_SAMPLER_PID=""
  diag_freq_sampler_start() {
    printf 'sampler-start\n' >> "$FREQUENCY_DRAIN_FAIL_LOG"
    DIAG_SAMPLER_PID=456
  }
  diag_process_group_start() {
    printf 'workload-start\n' >> "$FREQUENCY_DRAIN_FAIL_LOG"
    DIAG_WORKLOAD_PID=123
  }
  diag_process_group_wait() {
    printf 'workload-wait\n' >> "$FREQUENCY_DRAIN_FAIL_LOG"
    return 125
  }
  diag_process_group_stop() {
    printf 'workload-stop\n' >> "$FREQUENCY_DRAIN_FAIL_LOG"
    return 125
  }
  diag_freq_sampler_stop() {
    printf 'sampler-stop\n' >> "$FREQUENCY_DRAIN_FAIL_LOG"
    DIAG_SAMPLER_PID=""
  }
  diag_run_single_runs "$FREQUENCY_DRAIN_FAIL_TSV" A1 0 3
) > /dev/null 2>&1
frequency_drain_fail_rc=$?
check_eq "frequency legs stop after the first operational drain failure" \
  $'125:1:sampler-start\nworkload-start\nworkload-wait\nworkload-stop\nsampler-stop' \
  "$frequency_drain_fail_rc:$(wc -l < "$FREQUENCY_DRAIN_FAIL_TSV"):$(cat "$FREQUENCY_DRAIN_FAIL_LOG")"

FREQUENCY_START_FAIL_LOG="$TMP/frequency-start-fail.log"
FREQUENCY_START_FAIL_TSV="$TMP/frequency-start-fail.tsv"
(
  diag_freq_sampler_start() {
    printf 'sampler-start\n' >> "$FREQUENCY_START_FAIL_LOG"
    return 125
  }
  diag_process_group_start() {
    printf 'workload-start\n' >> "$FREQUENCY_START_FAIL_LOG"
  }
  diag_run_single_runs "$FREQUENCY_START_FAIL_TSV" A1 0 3
) > /dev/null 2>&1
frequency_start_fail_rc=$?
check_eq "frequency sampler start failure prevents every workload launch" \
  "125:absent:sampler-start" \
  "$frequency_start_fail_rc:$([[ -e "$FREQUENCY_START_FAIL_TSV" ]] && echo present || echo absent):$(cat "$FREQUENCY_START_FAIL_LOG")"

FREQUENCY_OTHER_TSV="$TMP/frequency-other-workload.tsv"
(
  DIAG_WORKLOAD_PID=""
  DIAG_SAMPLER_PID=""
  frequency_other_attempt=0
  diag_freq_sampler_start() { DIAG_SAMPLER_PID=456; }
  diag_process_group_start() { DIAG_WORKLOAD_PID=123; }
  diag_process_group_wait() {
    frequency_other_attempt=$((frequency_other_attempt + 1))
    DIAG_WORKLOAD_PID=""
    ((frequency_other_attempt == 1)) && return 1
    return 0
  }
  diag_freq_sampler_stop() { DIAG_SAMPLER_PID=""; }
  diag_run_single_runs "$FREQUENCY_OTHER_TSV" A1 0 2
) > /dev/null 2>&1
frequency_other_rc=$?
check_eq "frequency legs retain non-target outcomes and continue" \
  $'0:A1\t1\t1\t0\nA1\t2\t0\t0' \
  "$frequency_other_rc:$(cat "$FREQUENCY_OTHER_TSV")"

FREQUENCY_OTHER_COMPLETE="$TMP/frequency-other-complete.tsv"
printf 'A1\t1\t1\t0\nB\t1\t0\t0\nA2\t1\t139\t0\n' > "$FREQUENCY_OTHER_COMPLETE"
diag_frequency_rows_are_complete "$FREQUENCY_OTHER_COMPLETE" 1
check_eq "frequency completeness accepts descriptive non-target outcomes" "0" "$?"
sed -i 's/^A1\t1\t1\t/A1\t1\t125\t/' "$FREQUENCY_OTHER_COMPLETE"
diag_frequency_rows_are_complete "$FREQUENCY_OTHER_COMPLETE" 1
frequency_other_operational_rc=$?
check_eq "frequency completeness rejects the operational sentinel" "1" \
  "$([[ $frequency_other_operational_rc -ne 0 ]] && echo 1 || echo 0)"

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

test_process_is_live() {
  local pid="$1" stat_line rest state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  state="${rest%% *}"
  [[ "$state" != Z && "$state" != X && "$state" != x ]]
}

test_process_is_zombie() {
  local pid="$1" stat_line rest state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  state="${rest%% *}"
  [[ "$state" == Z || "$state" == X || "$state" == x ]]
}

test_process_identity_is_live() {
  local pid="$1" expected_start="$2" stat_line rest
  local -a fields=()
  [[ "$pid" =~ ^[0-9]+$ && "$expected_start" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  read -ra fields <<< "$rest"
  ((${#fields[@]} >= 20)) || return 1
  [[ "${fields[19]}" == "$expected_start" ]] || return 1
  case "${fields[0]}" in Z | X | x) return 1 ;; esac
}

test_process_group_is_live() {
  local expected_pgrp="$1" stat_path stat_line rest
  local -a fields=()
  [[ "$expected_pgrp" =~ ^[0-9]+$ ]] || return 1
  for stat_path in /proc/[0-9]*/stat; do
    IFS= read -r stat_line 2> /dev/null < "$stat_path" || continue
    rest="${stat_line##*) }"
    fields=()
    read -ra fields <<< "$rest"
    ((${#fields[@]} >= 3)) || continue
    [[ "${fields[2]}" == "$expected_pgrp" ]] || continue
    case "${fields[0]}" in Z | X | x) continue ;; esac
    return 0
  done
  return 1
}

test_process_cpu_ticks() {
  local pid="$1" stat_line rest
  local -a fields=()
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat_line 2> /dev/null < "/proc/$pid/stat" || return 1
  rest="${stat_line##*) }"
  read -ra fields <<< "$rest"
  ((${#fields[@]} >= 13)) || return 1
  printf '%s\n' "$((10#${fields[11]} + 10#${fields[12]}))"
}

test_supervision_watchdog_for_leader() {
  local leader="$1" child cmdline
  [[ "$leader" =~ ^[0-9]+$ &&
    -r "/proc/$leader/task/$leader/children" ]] || return 1
  for child in $(< "/proc/$leader/task/$leader/children"); do
    cmdline="$(tr '\0' ' ' < "/proc/$child/cmdline" 2> /dev/null || true)"
    if [[ "$cmdline" == *supervise-process-group.sh*--watch* ]]; then
      printf '%s\n' "$child"
      return 0
    fi
  done
  return 1
}

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
diag_process_group_start bash "$FIX/process-group-child.sh" \
  "$PROCESS_GROUP_EXIT_DIR" exit "$PROCESS_GROUP_EXIT_DIR/exit.gate"
exited_leader_pid="$DIAG_WORKLOAD_PID"
for ((i = 0; i < 100; i++)); do
  [[ -s "$PROCESS_GROUP_EXIT_DIR/leader.pid" &&
    -s "$PROCESS_GROUP_EXIT_DIR/child.pid" ]] && break
  sleep 0.01
done
exited_leader_child="$(cat "$PROCESS_GROUP_EXIT_DIR/child.pid" 2> /dev/null || true)"
exited_leader_watchdog="$(test_supervision_watchdog_for_leader "$exited_leader_pid" || true)"
exited_leader_watchdog_start="$(diag_process_start_ticks "$exited_leader_watchdog" 2> /dev/null || true)"
exited_leader_lease_open=0
for exited_leader_fd_path in "/proc/$exited_leader_pid/fd/"*; do
  exited_leader_fd="${exited_leader_fd_path##*/}"
  [[ "$exited_leader_fd" =~ ^[0-9]+$ ]] && ((exited_leader_fd >= 3)) &&
    [[ -p "$exited_leader_fd_path" ]] &&
    exited_leader_lease_open=1
done
: > "$PROCESS_GROUP_EXIT_DIR/exit.gate"
exited_leader_rc=0
diag_process_group_wait || exited_leader_rc=$?
for ((i = 0; i < 40; i++)); do
  [[ -z "$exited_leader_child" ]] || ! test_process_is_live "$exited_leader_child" || {
    sleep 0.05
    continue
  }
  break
done
exited_leader_watchdog_gone=0
for ((i = 0; i < 100; i++)); do
  if ! test_process_identity_is_live \
    "$exited_leader_watchdog" "$exited_leader_watchdog_start"; then
    exited_leader_watchdog_gone=1
    break
  fi
  sleep 0.05
done
exited_leader_clean=0
[[ $exited_leader_rc -eq 0 && -n "$exited_leader_child" &&
  $exited_leader_lease_open -eq 1 && $exited_leader_watchdog_gone -eq 1 ]] &&
  ! test_process_is_live "$exited_leader_child" &&
  [[ -z "$DIAG_WORKLOAD_PID" ]] && exited_leader_clean=1
check_eq "tracked wait delegates exited-leader descendants to the lease-bound watchdog" \
  "1" "$exited_leader_clean"

echo "== parent-death process supervision =="
supervision_statuses=""
for supervision_expected_rc in 0 7 125 139; do
  DIAG_WORKLOAD_PID=""
  diag_process_group_start bash -c 'exit "$1"' supervised-status "$supervision_expected_rc"
  supervision_actual_rc=0
  diag_process_group_wait || supervision_actual_rc=$?
  supervision_statuses+="${supervision_statuses:+,}$supervision_actual_rc"
done
check_eq "exec supervision preserves payload exit statuses" "0,7,125,139" \
  "$supervision_statuses"

SUPERVISION_STDERR="$TMP/supervision-payload.stderr"
DIAG_WORKLOAD_PID=""
diag_process_group_start bash -c 'printf "payload stderr survived\n" >&2' \
  2> "$SUPERVISION_STDERR"
supervision_stderr_rc=0
diag_process_group_wait || supervision_stderr_rc=$?
check_eq "watchdog descriptor closure does not redirect payload stderr" "1" \
  "$([[ $supervision_stderr_rc -eq 0 && "$(cat "$SUPERVISION_STDERR")" == 'payload stderr survived' ]] && echo 1 || echo 0)"

DIAG_WORKLOAD_PID=""
diag_process_group_start bash -c 'kill -TERM "$BASHPID"'
supervision_signal_rc=0
diag_process_group_wait || supervision_signal_rc=$?
check_eq "exec supervision preserves payload signal status" "143" \
  "$supervision_signal_rc"

SUPERVISION_EOF_READY="$TMP/supervision-lease-eof.ready"
DIAG_WORKLOAD_PID=""
diag_process_group_start bash -c '
  ready_file=$1
  for fd_path in /proc/$BASHPID/fd/*; do
    payload_fd=${fd_path##*/}
    [[ "$payload_fd" =~ ^[0-9]+$ ]] && ((payload_fd >= 3)) || continue
    { exec {payload_fd}>&-; } 2> /dev/null || true
  done
  : > "$ready_file"
  /bin/sleep 1
' supervised-lease-eof "$SUPERVISION_EOF_READY"
supervision_eof_leader="$DIAG_WORKLOAD_PID"
for _ in {1..200}; do
  [[ -e "$SUPERVISION_EOF_READY" ]] && break
  sleep 0.005
done
supervision_eof_watchdog="$(test_supervision_watchdog_for_leader \
  "$supervision_eof_leader" || true)"
supervision_eof_watchdog_start="$(diag_process_start_ticks \
  "$supervision_eof_watchdog" 2> /dev/null || true)"
supervision_eof_ticks_before="$(test_process_cpu_ticks \
  "$supervision_eof_watchdog" 2> /dev/null || true)"
sleep 0.4
supervision_eof_ticks_after="$(test_process_cpu_ticks \
  "$supervision_eof_watchdog" 2> /dev/null || true)"
supervision_eof_bounded=0
if [[ "$supervision_eof_ticks_before" =~ ^[0-9]+$ &&
  "$supervision_eof_ticks_after" =~ ^[0-9]+$ ]] &&
  ((supervision_eof_ticks_after - supervision_eof_ticks_before <= 10)) &&
  test_process_is_live "$supervision_eof_leader"; then
  supervision_eof_bounded=1
fi
supervision_eof_rc=0
diag_process_group_wait || supervision_eof_rc=$?
supervision_eof_watchdog_gone=0
for _ in {1..100}; do
  if ! test_process_identity_is_live \
    "$supervision_eof_watchdog" "$supervision_eof_watchdog_start"; then
    supervision_eof_watchdog_gone=1
    break
  fi
  sleep 0.05
done
check_eq "lease EOF polling remains bounded while the payload stays live" "1" \
  "$([[ $supervision_eof_bounded -eq 1 && $supervision_eof_rc -eq 0 &&
    $supervision_eof_watchdog_gone -eq 1 ]] && echo 1 || echo 0)"

arming_races_clean=0
for arming_iteration in {1..8}; do
  ARMING_ROOT="$TMP/supervision-arming-$arming_iteration"
  mkdir -p "$ARMING_ROOT"
  bash "$FIX/supervision-hold-parent.sh" "$ARMING_ROOT/parent" \
    bash "$FIX/supervision-launch-parent.sh" "$REPO_ROOT" \
    "$ARMING_ROOT/leader" "$ARMING_ROOT/payload" > /dev/null 2>&1 &
  arming_holder=$!
  for _ in {1..200}; do
    [[ -s "$ARMING_ROOT/parent" && -s "$ARMING_ROOT/leader" ]] && break
    sleep 0.005
  done
  arming_parent="$(cat "$ARMING_ROOT/parent" 2> /dev/null || true)"
  arming_leader="$(cat "$ARMING_ROOT/leader" 2> /dev/null || true)"
  kill -KILL "$arming_parent" 2> /dev/null || true
  arming_parent_zombie=0
  for _ in {1..200}; do
    test_process_is_zombie "$arming_parent" && {
      arming_parent_zombie=1
      break
    }
    sleep 0.005
  done
  for _ in {1..600}; do
    test_process_group_is_live "$arming_leader" || break
    sleep 0.01
  done
  arming_group_live=0
  test_process_group_is_live "$arming_leader" && arming_group_live=1
  if [[ $arming_parent_zombie -eq 1 && $arming_group_live -eq 0 ]]; then
    arming_races_clean=$((arming_races_clean + 1))
  fi
  ((arming_group_live == 0)) || kill -KILL -- "-$arming_leader" 2> /dev/null || true
  kill -CONT "$arming_holder" 2> /dev/null || true
  wait "$arming_holder" 2> /dev/null || true
done
check_eq "SIGKILL during the post-fork arming window leaves no payload group" \
  "8" "$arming_races_clean"

SUPERVISION_ROOT="$TMP/supervision-parent-death"
SUPERVISION_BUNDLE="$SUPERVISION_ROOT/bundle"
SUPERVISION_RESTORE_LOCK="$SUPERVISION_ROOT/restore.lock"
SUPERVISION_RUN_LOG="$SUPERVISION_ROOT/run.log"
SUPERVISION_COMMANDS_LOG="$SUPERVISION_ROOT/commands.log"
SUPERVISION_READY="$SUPERVISION_ROOT/ready"
mkdir -p "$SUPERVISION_BUNDLE" "$SUPERVISION_READY"
: > "$SUPERVISION_RUN_LOG"
: > "$SUPERVISION_COMMANDS_LOG"
bash "$FIX/supervision-hold-parent.sh" "$SUPERVISION_READY/parent.pid" \
  bash "$FIX/supervision-parent.sh" "$REPO_ROOT" "$SUPERVISION_BUNDLE" \
  "$SUPERVISION_RESTORE_LOCK" "$SUPERVISION_RUN_LOG" \
  "$SUPERVISION_COMMANDS_LOG" "$SUPERVISION_READY" > /dev/null 2>&1 &
supervision_holder=$!
for _ in {1..400}; do
  [[ -s "$SUPERVISION_READY/parent.pid" &&
    -s "$SUPERVISION_READY/parent.ready" &&
    -s "$SUPERVISION_READY/workload.ready" &&
    -s "$SUPERVISION_READY/sampler.ready" ]] && break
  sleep 0.01
done
supervision_parent="$(cat "$SUPERVISION_READY/parent.pid" 2> /dev/null || true)"
supervision_workload="$(sed -n 's/^WORKLOAD=//p' "$SUPERVISION_READY/parent.ready" 2> /dev/null)"
supervision_sampler="$(sed -n 's/^SAMPLER=//p' "$SUPERVISION_READY/parent.ready" 2> /dev/null)"
supervision_payload_fds_ok=0
if [[ "$(sed -n 's/^PID=//p' "$SUPERVISION_READY/workload.ready")" == "$supervision_workload" &&
  "$(sed -n 's/^PGRP=//p' "$SUPERVISION_READY/workload.ready")" == "$supervision_workload" &&
  "$(sed -n 's/^SESSION=//p' "$SUPERVISION_READY/workload.ready")" == "$supervision_workload" &&
  "$(sed -n 's/^BUNDLE_FD_OPEN=//p' "$SUPERVISION_READY/workload.ready")" == 1 &&
  "$(sed -n 's/^RESTORE_FD_OPEN=//p' "$SUPERVISION_READY/workload.ready")" == 1 &&
  "$(sed -n 's/^RUN_FD_OPEN=//p' "$SUPERVISION_READY/workload.ready")" == 0 &&
  "$(sed -n 's/^COMMANDS_FD_OPEN=//p' "$SUPERVISION_READY/workload.ready")" == 0 &&
  "$(sed -n 's/^LEASE_PIPE_OPEN=//p' "$SUPERVISION_READY/workload.ready")" == 1 &&
  "$(sed -n 's/^PID=//p' "$SUPERVISION_READY/sampler.ready")" == "$supervision_sampler" &&
  "$(sed -n 's/^PGRP=//p' "$SUPERVISION_READY/sampler.ready")" == "$supervision_sampler" &&
  "$(sed -n 's/^SESSION=//p' "$SUPERVISION_READY/sampler.ready")" == "$supervision_sampler" &&
  "$(sed -n 's/^BUNDLE_FD_OPEN=//p' "$SUPERVISION_READY/sampler.ready")" == 1 &&
  "$(sed -n 's/^RESTORE_FD_OPEN=//p' "$SUPERVISION_READY/sampler.ready")" == 1 &&
  "$(sed -n 's/^RUN_FD_OPEN=//p' "$SUPERVISION_READY/sampler.ready")" == 0 &&
  "$(sed -n 's/^COMMANDS_FD_OPEN=//p' "$SUPERVISION_READY/sampler.ready")" == 0 &&
  "$(sed -n 's/^LEASE_PIPE_OPEN=//p' "$SUPERVISION_READY/sampler.ready")" == 1 ]]; then
  supervision_payload_fds_ok=1
fi
check_eq "workload and sampler retain inherited fences and leases but not log descriptors" "1" \
  "$supervision_payload_fds_ok"

supervision_watchdogs_ok=1
supervision_watchdog_pids=()
supervision_watchdog_starts=()
for supervision_leader in "$supervision_workload" "$supervision_sampler"; do
  supervision_watchdog=""
  if [[ -r "/proc/$supervision_leader/task/$supervision_leader/children" ]]; then
    for supervision_child in $(< "/proc/$supervision_leader/task/$supervision_leader/children"); do
      supervision_cmdline="$(tr '\0' ' ' < "/proc/$supervision_child/cmdline" 2> /dev/null || true)"
      if [[ "$supervision_cmdline" == *supervise-process-group.sh*--watch* ]]; then
        supervision_watchdog="$supervision_child"
        break
      fi
    done
  fi
  [[ "$supervision_watchdog" =~ ^[0-9]+$ ]] || {
    supervision_watchdogs_ok=0
    continue
  }
  supervision_watchdog_stat="$(< "/proc/$supervision_watchdog/stat")"
  supervision_watchdog_rest="${supervision_watchdog_stat##*) }"
  read -ra supervision_watchdog_fields <<< "$supervision_watchdog_rest"
  [[ "${supervision_watchdog_fields[2]}" == "$supervision_watchdog" &&
    "${supervision_watchdog_fields[3]}" == "$supervision_watchdog" ]] ||
    supervision_watchdogs_ok=0
  supervision_watchdog_pids+=("$supervision_watchdog")
  supervision_watchdog_starts+=("${supervision_watchdog_fields[19]}")
  for supervision_fd_path in "/proc/$supervision_watchdog/fd/"*; do
    supervision_fd_target="$(readlink -- "$supervision_fd_path" 2> /dev/null || true)"
    case "$supervision_fd_target" in
      "$SUPERVISION_BUNDLE"|"${SUPERVISION_RESTORE_LOCK}.guard"|"$SUPERVISION_RUN_LOG"|"$SUPERVISION_COMMANDS_LOG")
        supervision_watchdogs_ok=0
        ;;
    esac
  done
done
check_eq "detached watchdogs hold no bundle, restore, or log descriptors" "1" \
  "$supervision_watchdogs_ok"

workload_counter_before="$(wc -l < "$SUPERVISION_READY/workload.counter")"
sampler_counter_before="$(wc -l < "$SUPERVISION_READY/sampler.counter")"
kill -KILL "$supervision_parent" 2> /dev/null || true
supervision_parent_zombie=0
for _ in {1..200}; do
  test_process_is_zombie "$supervision_parent" && {
    supervision_parent_zombie=1
    break
  }
  sleep 0.005
done

exec {supervision_bundle_probe}< "$SUPERVISION_BUNDLE"
exec {supervision_restore_probe}<> "${SUPERVISION_RESTORE_LOCK}.guard"
supervision_bundle_busy=0
supervision_restore_busy=0
flock -n -x "$supervision_bundle_probe" 2> /dev/null || supervision_bundle_busy=1
flock -n -x "$supervision_restore_probe" 2> /dev/null || supervision_restore_busy=1

supervision_released=0
for _ in {1..700}; do
  if flock -n -x "$supervision_bundle_probe" 2> /dev/null &&
    flock -n -x "$supervision_restore_probe" 2> /dev/null; then
    supervision_released=1
    break
  fi
  sleep 0.01
done
workload_counter_after="$(wc -l < "$SUPERVISION_READY/workload.counter")"
sampler_counter_after="$(wc -l < "$SUPERVISION_READY/sampler.counter")"
sleep 0.1
supervision_counters_stopped=0
if [[ "$(wc -l < "$SUPERVISION_READY/workload.counter")" == "$workload_counter_after" &&
  "$(wc -l < "$SUPERVISION_READY/sampler.counter")" == "$sampler_counter_after" ]]; then
  supervision_counters_stopped=1
fi
flock -u "$supervision_bundle_probe" 2> /dev/null || true
flock -u "$supervision_restore_probe" 2> /dev/null || true
exec {supervision_bundle_probe}<&-
exec {supervision_restore_probe}>&-
kill -CONT "$supervision_holder" 2> /dev/null || true
wait "$supervision_holder" 2> /dev/null || true
for supervision_leader in "$supervision_workload" "$supervision_sampler"; do
  test_process_is_live "$supervision_leader" &&
    kill -KILL -- "-$supervision_leader" 2> /dev/null || true
done
supervision_watchdogs_gone=1
for supervision_watchdog_i in "${!supervision_watchdog_pids[@]}"; do
  for _ in {1..100}; do
    test_process_identity_is_live \
      "${supervision_watchdog_pids[$supervision_watchdog_i]}" \
      "${supervision_watchdog_starts[$supervision_watchdog_i]}" || break
    sleep 0.05
  done
  test_process_identity_is_live \
    "${supervision_watchdog_pids[$supervision_watchdog_i]}" \
    "${supervision_watchdog_starts[$supervision_watchdog_i]}" &&
    supervision_watchdogs_gone=0
done
check_eq "unreaped parent SIGKILL retains bundle and restore fences until writer groups stop" "1" \
  "$([[ $supervision_parent_zombie -eq 1 && $supervision_bundle_busy -eq 1 &&
    $supervision_restore_busy -eq 1 && $supervision_released -eq 1 &&
    $supervision_counters_stopped -eq 1 && $supervision_watchdogs_gone -eq 1 &&
    $workload_counter_after -ge $workload_counter_before &&
    $sampler_counter_after -ge $sampler_counter_before ]] && echo 1 || echo 0)"

PIPELINE_DIR="$TMP/pipeline-status"
mkdir -p "$PIPELINE_DIR/bin" "$PIPELINE_DIR/out"
# The fake node keeps every workload invocation synthetic. Only the bounded
# GDB transcript helper and the GDB evidence module are delegated to the real
# node binary.
REAL_NODE_BIN="$DIAG_TEST_REAL_NODE_BIN"
cat > "$PIPELINE_DIR/bin/node" << 'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  */diagnose-lib/gdb-attempt-io.mjs | */diagnose-lib/gdb-evidence.mjs) exec "$REAL_NODE_BIN" "$@" ;;
esac
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
[[ -z "${FAKE_GDB_ARGS_LOG:-}" ]] || printf '%s\n' "$*" >> "$FAKE_GDB_ARGS_LOG"
case "${FAKE_GDB_MODE:-clean}" in
  clean) printf 'Inferior 1 exited normally\n' ;;
  error) printf 'synthetic debugger error\n' ;;
  capture) printf 'Program received signal SIGSEGV, Segmentation fault.\n' ;;
  overflow) head -c 70000000 /dev/zero | tr '\0' 'x' ;;
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

GDB_TEST_GENERATION=0123456789abcdef0123456789abcdef
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  export PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN"
  gdb_rc=0
  run_gdb_logged 0 1 1 "$PIPELINE_DIR/out/gdb" "$PIPELINE_DIR/out/gdb-runner.log" \
    "$GDB_TEST_GENERATION" || gdb_rc=$?
  printf '%s\n' "$gdb_rc" > "$PIPELINE_DIR/gdb.rc"
)
check_eq "GDB logging pipeline preserves the no-fault status" "3" "$(cat "$PIPELINE_DIR/gdb.rc")"
check_eq "GDB logging pipeline preserves terminal all-clean accounting" \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t1\tMAX_CAPTURES\t1\tATTEMPTED\t1\tCLEAN\t1\tCAPTURED\t0\tERRORS\t0\tEXIT_CODE\t3' \
  "$(tail -1 "$PIPELINE_DIR/out/gdb-runner.log")"
check_eq "GDB runner log contains only canonical records" \
  $'ATTEMPT\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t1\tMAX_CAPTURES\t1\tRUN\t1\tOUTCOME\tclean' \
  "$(head -1 "$PIPELINE_DIR/out/gdb-runner.log")"
check_eq "GDB clean run retains no transcript" "0" \
  "$(find "$PIPELINE_DIR/out/gdb" -mindepth 1 -print -quit | wc -l)"

# Each case runs capture-fault.sh directly. stdout must carry only canonical
# ATTEMPT records plus at most one terminal COUNTS record; rc 5 means the log
# is intentionally left without a terminal record and stays unpublishable.
gdb_capture_case() {
  local label="$1" mode="$2" runs="$3" captures="$4" expected_rc="$5" expected_last="$6"
  local expected_counts_lines="$7" expected_attempt_lines="$8"
  local case_dir="$PIPELINE_DIR/$label" output="$PIPELINE_DIR/$label.log" rc=0
  mkdir -p "$case_dir"
  rm -f "$PIPELINE_DIR/$label.counter"
  (
    cd "$REPO_ROOT" || exit 99
    PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" \
      FAKE_GDB_MODE="$mode" FAKE_GDB_COUNTER="$PIPELINE_DIR/$label.counter" \
      bash ./capture-fault.sh 0 "$runs" "$captures" "$case_dir" "$GDB_TEST_GENERATION"
  ) > "$output" 2> "$PIPELINE_DIR/$label.stderr" || rc=$?
  local counts_lines attempt_lines
  counts_lines="$(grep -c $'^COUNTS\t' "$output" || true)"
  attempt_lines="$(grep -c $'^ATTEMPT\t' "$output" || true)"
  check_eq "$label status and terminal accounting" \
    "$expected_rc|$expected_counts_lines|$expected_attempt_lines|$expected_last" \
    "$rc|$counts_lines|$attempt_lines|$(tail -1 "$output")"
  if grep -qvE $'^(ATTEMPT|COUNTS)\t' "$output"; then
    bad "$label stdout carries only canonical runner records"
  else
    ok "$label stdout carries only canonical runner records"
  fi
}
gdb_capture_case "gdb-all-clean" clean 3 1 3 \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t3\tMAX_CAPTURES\t1\tATTEMPTED\t3\tCLEAN\t3\tCAPTURED\t0\tERRORS\t0\tEXIT_CODE\t3' 1 3
check_eq "gdb-all-clean retains no transcripts" "0" \
  "$(find "$PIPELINE_DIR/gdb-all-clean" -mindepth 1 -print -quit | wc -l)"
gdb_capture_case "gdb-clean-plus-errors" one-clean-rest-error 6 1 3 \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tATTEMPTED\t6\tCLEAN\t1\tCAPTURED\t0\tERRORS\t5\tEXIT_CODE\t3' 1 6
check_eq "gdb-clean-plus-errors retains only the five error transcripts" "5" \
  "$(find "$PIPELINE_DIR/gdb-clean-plus-errors" -mindepth 1 -name 'cpu0-run*.txt' -print | wc -l)"
gdb_capture_case "gdb-all-errors" error 3 1 5 \
  $'ATTEMPT\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t3\tMAX_CAPTURES\t1\tRUN\t3\tOUTCOME\terror' 0 3
check_eq "gdb-all-errors retains the three error transcripts" "3" \
  "$(find "$PIPELINE_DIR/gdb-all-errors" -mindepth 1 -name 'cpu0-run*.txt' -print | wc -l)"
gdb_capture_case "gdb-early-capture" capture 6 1 0 \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tATTEMPTED\t1\tCLEAN\t0\tCAPTURED\t1\tERRORS\t0\tEXIT_CODE\t0' 1 1
gdb_capture_case "gdb-capture-cap-stop" capture 6 2 0 \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t2\tATTEMPTED\t2\tCLEAN\t0\tCAPTURED\t2\tERRORS\t0\tEXIT_CODE\t0' 1 2
gdb_capture_case "gdb-exhausted-with-captures" capture 2 3 0 \
  $'COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t2\tMAX_CAPTURES\t3\tATTEMPTED\t2\tCLEAN\t0\tCAPTURED\t2\tERRORS\t0\tEXIT_CODE\t0' 1 2
# The retained capture transcript is bound to the exact run generation.
check_eq "captured transcript carries the generation-bound provenance header" \
  $'GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tRUN\t1\tOUTCOME\tcaptured' \
  "$(head -1 "$PIPELINE_DIR/gdb-early-capture/cpu0-run1.txt")"
check_eq "captured transcript carries the generation-bound provenance footer" \
  $'GDB_TRANSCRIPT_END\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tRUN\t1\tOUTCOME\tcaptured' \
  "$(tail -1 "$PIPELINE_DIR/gdb-early-capture/cpu0-run1.txt")"
# An output stream beyond the evidence limit is truncated to a bounded error
# transcript and counted as an error attempt, never a capture.
gdb_capture_case "gdb-overflow" overflow 2 1 5 \
  $'ATTEMPT\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t2\tMAX_CAPTURES\t1\tRUN\t2\tOUTCOME\terror' 0 2
overflow_size="$(stat -c %s "$PIPELINE_DIR/gdb-overflow/cpu0-run1.txt")"
check_eq "overflow transcript is bounded at the evidence limit" "1" \
  "$([[ "$overflow_size" -le 67108864 ]] && echo 1 || echo 0)"
check_eq "overflow transcript records its truncation" "1" \
  "$(tail -2 "$PIPELINE_DIR/gdb-overflow/cpu0-run1.txt" | head -1 |
    grep -c '^\[gdb output truncated at the evidence size limit\]$')"
# A helper I/O failure aborts the run without any publishable record.
GDB_HELPER_FAIL_DIR="$PIPELINE_DIR/gdb-helper-failure"
mkdir -p "$GDB_HELPER_FAIL_DIR"
chmod 0555 "$GDB_HELPER_FAIL_DIR"
helper_fail_rc=0
(
  cd "$REPO_ROOT" || exit 99
  PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" FAKE_GDB_MODE=capture \
    bash ./capture-fault.sh 0 3 1 "$GDB_HELPER_FAIL_DIR" "$GDB_TEST_GENERATION"
) > "$PIPELINE_DIR/gdb-helper-failure.log" 2> /dev/null || helper_fail_rc=$?
chmod 0755 "$GDB_HELPER_FAIL_DIR"
check_eq "helper I/O failure aborts without publishable runner records" "5|0" \
  "$helper_fail_rc|$(grep -cE $'^(ATTEMPT|COUNTS)\t' "$PIPELINE_DIR/gdb-helper-failure.log" || true)"
# A pre-existing destination of any shape is refused, never replaced.
for refusal_kind in symlink fifo hardlink regular; do
  GDB_REFUSAL_DIR="$PIPELINE_DIR/gdb-refusal-$refusal_kind"
  mkdir -p "$GDB_REFUSAL_DIR"
  printf 'preexisting destination\n' > "$GDB_REFUSAL_DIR/victim"
  case "$refusal_kind" in
    symlink) ln -s "$GDB_REFUSAL_DIR/victim" "$GDB_REFUSAL_DIR/cpu0-run1.txt" ;;
    fifo) mkfifo "$GDB_REFUSAL_DIR/cpu0-run1.txt" ;;
    hardlink) ln "$GDB_REFUSAL_DIR/victim" "$GDB_REFUSAL_DIR/cpu0-run1.txt" ;;
    regular) cp "$GDB_REFUSAL_DIR/victim" "$GDB_REFUSAL_DIR/cpu0-run1.txt" ;;
  esac
  refusal_rc=0
  (
    cd "$REPO_ROOT" || exit 99
    PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" FAKE_GDB_MODE=capture \
      bash ./capture-fault.sh 0 3 1 "$GDB_REFUSAL_DIR" "$GDB_TEST_GENERATION"
  ) > "$PIPELINE_DIR/gdb-refusal-$refusal_kind.log" 2> /dev/null || refusal_rc=$?
  refusal_intact=0
  [[ "$(cat "$GDB_REFUSAL_DIR/victim")" == "preexisting destination" ]] &&
    [[ -e "$GDB_REFUSAL_DIR/cpu0-run1.txt" || -L "$GDB_REFUSAL_DIR/cpu0-run1.txt" ]] &&
    refusal_intact=1
  check_eq "GDB transcript destination refusal: $refusal_kind" "5|1|0" \
    "$refusal_rc|$refusal_intact|$(grep -cE $'^(ATTEMPT|COUNTS)\t' "$PIPELINE_DIR/gdb-refusal-$refusal_kind.log" || true)"
done
grep -q 'timeout --foreground --signal=KILL' "$REPO_ROOT/capture-fault.sh"
check_eq "GDB timeout remains inside the tracked foreground group" "0" "$?"

# The optional sixth capture-fault.sh argument selects the exact debug target.
# The transcript helper keeps running under the PATH-resolved node; only the
# --args target changes. Five-argument callers keep the historical default.
EXPLICIT_TARGET_DIR="$PIPELINE_DIR/explicit-target"
mkdir -p "$EXPLICIT_TARGET_DIR"
cat > "$EXPLICIT_TARGET_DIR/node-a" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$EXPLICIT_TARGET_DIR/node-a"
ln -s "$EXPLICIT_TARGET_DIR/node-a" "$EXPLICIT_TARGET_DIR/node-a-link"

default_target_dir="$PIPELINE_DIR/gdb-default-target"
mkdir -p "$default_target_dir"
default_target_rc=0
(
  cd "$REPO_ROOT" || exit 99
  PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" FAKE_GDB_MODE=clean \
    FAKE_GDB_ARGS_LOG="$PIPELINE_DIR/gdb-default-target.args" \
    bash ./capture-fault.sh 0 1 1 "$default_target_dir" "$GDB_TEST_GENERATION"
) > /dev/null 2>&1 || default_target_rc=$?
check_eq "five-argument default still targets the PATH-resolved node" "3|1" \
  "$default_target_rc|$([[ "$(tail -1 "$PIPELINE_DIR/gdb-default-target.args")" == *"--args $PIPELINE_DIR/bin/node child.mjs" ]] && echo 1 || echo 0)"

nodebin_dir="$PIPELINE_DIR/gdb-nodebin"
mkdir -p "$nodebin_dir"
nodebin_rc=0
(
  cd "$REPO_ROOT" || exit 99
  PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" FAKE_GDB_MODE=capture \
    FAKE_GDB_ARGS_LOG="$PIPELINE_DIR/gdb-nodebin.args" \
    bash ./capture-fault.sh 0 3 1 "$nodebin_dir" "$GDB_TEST_GENERATION" \
    "$EXPLICIT_TARGET_DIR/node-a"
) > "$PIPELINE_DIR/gdb-nodebin.log" 2> /dev/null || nodebin_rc=$?
check_eq "explicit NODE_BIN run keeps canonical terminal accounting" \
  $'0|COUNTS\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t3\tMAX_CAPTURES\t1\tATTEMPTED\t1\tCLEAN\t0\tCAPTURED\t1\tERRORS\t0\tEXIT_CODE\t0' \
  "$nodebin_rc|$(tail -1 "$PIPELINE_DIR/gdb-nodebin.log")"
check_eq "explicit NODE_BIN reaches the fake GDB invocation exactly" "1" \
  "$([[ "$(tail -1 "$PIPELINE_DIR/gdb-nodebin.args")" == *"--args $EXPLICIT_TARGET_DIR/node-a child.mjs" ]] && echo 1 || echo 0)"
check_eq "explicit NODE_BIN capture retains the generation-bound transcript" \
  $'GDB_TRANSCRIPT\tVERSION\t1\tGENERATION\t0123456789abcdef0123456789abcdef\tCPU\t0\tMAX_RUNS\t3\tMAX_CAPTURES\t1\tRUN\t1\tOUTCOME\tcaptured' \
  "$(head -1 "$nodebin_dir/cpu0-run1.txt")"

nodebin_link_dir="$PIPELINE_DIR/gdb-nodebin-link"
mkdir -p "$nodebin_link_dir"
nodebin_link_rc=0
(
  cd "$REPO_ROOT" || exit 99
  PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" FAKE_GDB_MODE=clean \
    FAKE_GDB_ARGS_LOG="$PIPELINE_DIR/gdb-nodebin-link.args" \
    bash ./capture-fault.sh 0 1 1 "$nodebin_link_dir" "$GDB_TEST_GENERATION" \
    "$EXPLICIT_TARGET_DIR/node-a-link"
) > /dev/null 2>&1 || nodebin_link_rc=$?
check_eq "symlink NODE_BIN resolves to the canonical target before GDB" "3|1" \
  "$nodebin_link_rc|$([[ "$(tail -1 "$PIPELINE_DIR/gdb-nodebin-link.args")" == *"--args $EXPLICIT_TARGET_DIR/node-a child.mjs" ]] && echo 1 || echo 0)"

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

RESTORE_FENCE_DIR="$TMP/restore-fence-overlap"
RESTORE_FENCE_LOCK="$RESTORE_FENCE_DIR/active.lock"
RESTORE_FENCE_READY="$RESTORE_FENCE_DIR/ready"
mkdir -p "$RESTORE_FENCE_READY"
chmod 0700 "$RESTORE_FENCE_DIR"
bash -c '
  set -u
  source "$1"
  diag_restore_lock_acquire "$2" "$3" "$4"
  diag_process_group_start bash -c '\''
    trap "" TERM
    printf "%s\n" "$BASHPID" > "$1"
    while :; do sleep 1; done
  '\'' restore-fence-writer "$5/writer"
  for _ in {1..200}; do [[ -s "$5/writer" ]] && break; sleep 0.005; done
  {
    printf "PARENT=%s\n" "$BASHPID"
    printf "GROUP=%s\n" "$DIAG_WORKLOAD_PID"
  } > "$5/owner"
  while :; do sleep 1; done
' _ "$LIB/common.sh" "$RESTORE_FENCE_LOCK" "$test_uid" "$test_gid" \
  "$RESTORE_FENCE_READY" > /dev/null 2>&1 &
restore_fence_parent=$!
for _ in {1..300}; do
  [[ -s "$RESTORE_FENCE_READY/owner" && -s "$RESTORE_FENCE_READY/writer" ]] && break
  sleep 0.01
done
restore_fence_group="$(sed -n 's/^GROUP=//p' "$RESTORE_FENCE_READY/owner" 2> /dev/null)"
kill -KILL "$restore_fence_parent" 2> /dev/null || true
restore_fence_busy=0
if diag_restore_lock_acquire "$RESTORE_FENCE_LOCK" "$test_uid" "$test_gid" 2> /dev/null; then
  diag_restore_lock_release
else
  restore_fence_busy=1
fi
wait "$restore_fence_parent" 2> /dev/null || true
restore_fence_recovered=0
for _ in {1..200}; do
  if diag_restore_lock_acquire "$RESTORE_FENCE_LOCK" "$test_uid" "$test_gid" 2> /dev/null; then
    restore_fence_recovered=1
    break
  fi
  sleep 0.025
done
restore_fence_fd_retained=0
if ((restore_fence_recovered == 1)) &&
  [[ -n "$DIAG_RESTORE_LOCK_FD" &&
    -e "/proc/$BASHPID/fd/$DIAG_RESTORE_LOCK_FD" &&
    "/proc/$BASHPID/fd/$DIAG_RESTORE_LOCK_FD" -ef "${RESTORE_FENCE_LOCK}.guard" ]]; then
  restore_fence_fd_retained=1
fi
((restore_fence_recovered == 0)) || diag_restore_lock_release
restore_fence_group_live=0
test_process_group_is_live "$restore_fence_group" && restore_fence_group_live=1
check_eq "retained restore flock fences SIGKILL recovery until inherited writer groups exit" "1" \
  "$([[ $restore_fence_busy -eq 1 && $restore_fence_recovered -eq 1 &&
    $restore_fence_fd_retained -eq 1 && $restore_fence_group_live -eq 0 &&
    ! -e "$RESTORE_FENCE_LOCK" ]] && echo 1 || echo 0)"

echo "== diagnostics bundle writer lock =="
BUNDLE_LOCK_ROOT="$TMP/bundle-writer-lock"
mkdir -p "$BUNDLE_LOCK_ROOT/real/bundle"
ln -s "$BUNDLE_LOCK_ROOT/real" "$BUNDLE_LOCK_ROOT/alias"
exec {bundle_lock_holder}< "$BUNDLE_LOCK_ROOT/real/bundle"
flock -x "$bundle_lock_holder"
bash -c '
  source "$1"
  diag_bundle_lock_acquire "$2"
' _ "$LIB/bundle-lock.sh" "$BUNDLE_LOCK_ROOT/alias/bundle" > /dev/null 2>&1
bundle_lock_busy_rc=$?
check_eq "directory lock serializes same-inode bundle aliases with busy rc 75" "75" \
  "$bundle_lock_busy_rc"
LOCK_ERROR_BIN="$TMP/bundle-lock-error-bin"
mkdir -p "$LOCK_ERROR_BIN"
printf '#!/usr/bin/env bash\nexit 7\n' > "$LOCK_ERROR_BIN/flock"
chmod +x "$LOCK_ERROR_BIN/flock"
PATH="$LOCK_ERROR_BIN:$PATH" bash -c '
  source "$1"
  diag_bundle_lock_acquire "$2"
' _ "$LIB/bundle-lock.sh" "$BUNDLE_LOCK_ROOT/real/bundle" > /dev/null 2>&1
bundle_lock_error_rc=$?
check_eq "operational flock failures remain distinct from retryable contention" "1" \
  "$bundle_lock_error_rc"

LOCK_SWAP_ROOT="$TMP/bundle-lock-path-swap"
LOCK_SWAP_BIN="$LOCK_SWAP_ROOT/bin"
LOCK_SWAP_BUNDLE="$LOCK_SWAP_ROOT/bundle"
LOCK_SWAP_MOVED="$LOCK_SWAP_ROOT/original-inode"
LOCK_SWAP_MARKER="$LOCK_SWAP_ROOT/swapped"
mkdir -p "$LOCK_SWAP_BIN" "$LOCK_SWAP_BUNDLE"
cat > "$LOCK_SWAP_BIN/stat" << 'EOF'
#!/usr/bin/env bash
last_arg="${!#}"
if [[ "$last_arg" == /proc/self/fd/* && ! -e "$DIAG_TEST_STAT_SWAP_MARKER" ]]; then
  stat_output="$("$DIAG_TEST_REAL_STAT" "$@")" || exit $?
  mv -T -- "$DIAG_TEST_STAT_SWAP_BUNDLE" "$DIAG_TEST_STAT_SWAP_MOVED" || exit 1
  mkdir -- "$DIAG_TEST_STAT_SWAP_BUNDLE" || exit 1
  : > "$DIAG_TEST_STAT_SWAP_MARKER"
  printf '%s\n' "$stat_output"
  exit 0
fi
exec "$DIAG_TEST_REAL_STAT" "$@"
EOF
chmod +x "$LOCK_SWAP_BIN/stat"
LOCK_SWAP_REAL_STAT="$(command -v stat)"
PATH="$LOCK_SWAP_BIN:$PATH" \
  DIAG_TEST_REAL_STAT="$LOCK_SWAP_REAL_STAT" \
  DIAG_TEST_STAT_SWAP_MARKER="$LOCK_SWAP_MARKER" \
  DIAG_TEST_STAT_SWAP_BUNDLE="$LOCK_SWAP_BUNDLE" \
  DIAG_TEST_STAT_SWAP_MOVED="$LOCK_SWAP_MOVED" \
  timeout --signal=TERM --kill-after=1 5 bash -c '
    source "$1"
    diag_bundle_lock_acquire "$2"
  ' _ "$LIB/bundle-lock.sh" "$LOCK_SWAP_BUNDLE" > /dev/null 2>&1
bundle_lock_swap_rc=$?
bundle_lock_swap_retry_rc=1
if [[ $bundle_lock_swap_rc -ne 0 && -d "$LOCK_SWAP_BUNDLE" &&
  -d "$LOCK_SWAP_MOVED" && -f "$LOCK_SWAP_MARKER" ]]; then
  bash -c '
    source "$1"
    diag_bundle_lock_acquire "$2"
    diag_bundle_lock_release
  ' _ "$LIB/bundle-lock.sh" "$LOCK_SWAP_BUNDLE" > /dev/null 2>&1
  bundle_lock_swap_retry_rc=$?
fi
check_eq "bundle replacement during lock acquisition fails closed" "1" \
  "$([[ $bundle_lock_swap_rc -eq 1 && $bundle_lock_swap_retry_rc -eq 0 ]] && echo 1 || echo 0)"
flock -u "$bundle_lock_holder"
exec {bundle_lock_holder}<&-
(
  source "$LIB/bundle-lock.sh"
  diag_bundle_lock_acquire "$BUNDLE_LOCK_ROOT/alias/bundle"
  diag_bundle_lock_release
)
bundle_lock_retry_rc=$?
check_eq "directory lock can be acquired immediately after the writer exits" "0" \
  "$bundle_lock_retry_rc"
check_eq "directory lock creates no persistent bundle artifact" "0" \
  "$(find "$BUNDLE_LOCK_ROOT/real/bundle" -mindepth 1 -print -quit | wc -l)"

# The dynamic lock FD is deliberately inherited. If a writer is killed while
# its child can still write, contenders remain excluded until that child exits.
INHERITED_LOCK_BUNDLE="$TMP/inherited-bundle-writer-lock"
INHERITED_LOCK_READY="$TMP/inherited-bundle-writer.ready"
INHERITED_LOCK_FIFO="$TMP/inherited-bundle-writer.fifo"
mkdir -p "$INHERITED_LOCK_BUNDLE"
mkfifo "$INHERITED_LOCK_FIFO"
exec {inherited_lock_control_fd}<> "$INHERITED_LOCK_FIFO"
setsid bash -c '
  source "$1"
  diag_bundle_lock_acquire "$2"
  bash -c '\''printf "%s\n" "$BASHPID" > "$1"; read -r -u "$2" _'\'' _ "$3" "$4" &
  wait
' _ "$LIB/bundle-lock.sh" "$INHERITED_LOCK_BUNDLE" "$INHERITED_LOCK_READY" \
  "$inherited_lock_control_fd" > /dev/null 2>&1 &
inherited_lock_parent=$!
inherited_lock_ready=0
for _ in {1..100}; do
  if [[ -s "$INHERITED_LOCK_READY" ]]; then
    inherited_lock_ready=1
    break
  fi
  sleep 0.01
done
kill -KILL "$inherited_lock_parent" 2> /dev/null || true
inherited_parent_stopped=0
for _ in {1..100}; do
  inherited_parent_state=""
  if [[ -r "/proc/$inherited_lock_parent/stat" ]]; then
    read -r _ _ inherited_parent_state _ < "/proc/$inherited_lock_parent/stat" || true
  fi
  if [[ -z "$inherited_parent_state" || "$inherited_parent_state" == Z ||
    "$inherited_parent_state" == X ]]; then
    inherited_parent_stopped=1
    break
  fi
  sleep 0.01
done
if ((inherited_parent_stopped == 1)); then
  wait "$inherited_lock_parent" 2> /dev/null || true
fi
bash -c '
  source "$1"
  diag_bundle_lock_acquire "$2"
' _ "$LIB/bundle-lock.sh" "$INHERITED_LOCK_BUNDLE" > /dev/null 2>&1
inherited_lock_busy_rc=$?
printf 'release\n' >&"$inherited_lock_control_fd"
inherited_lock_released=0
for _ in {1..100}; do
  if bash -c '
    source "$1"
    diag_bundle_lock_acquire "$2"
    diag_bundle_lock_release
  ' _ "$LIB/bundle-lock.sh" "$INHERITED_LOCK_BUNDLE" > /dev/null 2>&1; then
    inherited_lock_released=1
    break
  fi
  sleep 0.01
done
if ((inherited_lock_released == 0)); then
  # The parent was a dedicated session leader, so this cleans up any orphaned
  # lock-holding child without relying on a potentially blocking wait.
  kill -KILL -- "-$inherited_lock_parent" 2> /dev/null || true
  inherited_lock_child="$(cat "$INHERITED_LOCK_READY" 2> /dev/null || true)"
  [[ "$inherited_lock_child" =~ ^[0-9]+$ ]] &&
    kill -KILL "$inherited_lock_child" 2> /dev/null || true
fi
check_eq "SIGKILL retains the lock while an inherited writer child lives" "1" \
  "$([[ $inherited_lock_ready -eq 1 && $inherited_parent_stopped -eq 1 && $inherited_lock_busy_rc -eq 75 && $inherited_lock_released -eq 1 ]] && echo 1 || echo 0)"
exec {inherited_lock_control_fd}<&-
rm -f "$INHERITED_LOCK_FIFO"

exec {source_only_lock}< "$BUNDLE_LOCK_ROOT/real/bundle"
flock -x "$source_only_lock"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
)
source_only_lock_rc=$?
flock -u "$source_only_lock"
exec {source_only_lock}<&-
check_eq "source-only diagnose acquires no bundle lock" "0" "$source_only_lock_rc"

# Main must lock a resumed bundle before even a dry-run trusts its metadata.
# Contention is a retryable status and cannot append logs, rewrite metadata,
# or otherwise change the bundle snapshot.
resume_busy_tree_before="$(find "$CPU_POLICY_RB" -printf '%P\t%y\t%s\n' | sort)"
resume_busy_meta_before="$(sha256sum "$CPU_POLICY_RB/results/meta.env")"
exec {resume_busy_fd}< "$CPU_POLICY_RB"
flock -x "$resume_busy_fd"
"$REPO_ROOT/diagnose.sh" --resume "$CPU_POLICY_RB" --dry-run --yes > /dev/null 2>&1
resume_busy_rc=$?
resume_busy_tree_after="$(find "$CPU_POLICY_RB" -printf '%P\t%y\t%s\n' | sort)"
resume_busy_meta_after="$(sha256sum "$CPU_POLICY_RB/results/meta.env")"
check_eq "resume dry-run returns busy rc 75 without mutating its bundle" "1" \
  "$([[ $resume_busy_rc -eq 75 && "$resume_busy_tree_after" == "$resume_busy_tree_before" && "$resume_busy_meta_after" == "$resume_busy_meta_before" && ! -e "$CPU_POLICY_RB/commands.log" ]] && echo 1 || echo 0)"

# Locks are per directory inode rather than process-global: another complete
# bundle remains readable while the first one is busy.
DISTINCT_LOCK_BUNDLE="$TMP/distinct-writer-lock-bundle"
cp -a "$CPU_POLICY_RB" "$DISTINCT_LOCK_BUNDLE"
"$REPO_ROOT/diagnose.sh" --resume "$DISTINCT_LOCK_BUNDLE" --dry-run --yes \
  > /dev/null 2>&1
distinct_lock_rc=$?
check_eq "distinct diagnostics bundles do not contend" "0" "$distinct_lock_rc"
flock -u "$resume_busy_fd"
exec {resume_busy_fd}<&-
"$REPO_ROOT/diagnose.sh" --resume "$CPU_POLICY_RB" --dry-run --yes > /dev/null 2>&1
check_eq "resume dry-run retries after the active writer exits" "0" "$?"

FRESH_DRY_RUN_OUT="$TMP/fresh-dry-run-no-create"
"$REPO_ROOT/diagnose.sh" --out-dir "$FRESH_DRY_RUN_OUT" --dry-run --yes \
  > /dev/null 2>&1
fresh_dry_run_rc=$?
check_eq "fresh dry-run neither creates nor locks its output directory" "1" \
  "$([[ $fresh_dry_run_rc -eq 0 && ! -e "$FRESH_DRY_RUN_OUT" ]] && echo 1 || echo 0)"

# Help must stay side-effect free even if a busy resume path is also supplied.
exec {help_busy_fd}< "$CPU_POLICY_RB"
flock -x "$help_busy_fd"
"$REPO_ROOT/diagnose.sh" --resume "$CPU_POLICY_RB" --help > /dev/null 2>&1
help_busy_rc=$?
flock -u "$help_busy_fd"
exec {help_busy_fd}<&-
check_eq "help does not acquire a diagnostics bundle lock" "0" "$help_busy_rc"

# Pause the first real fresh diagnose invocation inside its successful flock
# call. A second invocation must see rc 75. Before releasing the first, add a
# competing entry so its under-lock emptiness check proves that initialization
# cannot proceed from a stale pre-lock observation.
FRESH_RACE_ROOT="$TMP/fresh-writer-race"
FRESH_RACE_BUNDLE="$FRESH_RACE_ROOT/bundle"
FRESH_RACE_SHIM="$FRESH_RACE_ROOT/bin"
FRESH_RACE_READY="$FRESH_RACE_ROOT/ready"
FRESH_RACE_FIFO="$FRESH_RACE_ROOT/release.fifo"
mkdir -p "$FRESH_RACE_SHIM"
mkfifo "$FRESH_RACE_FIFO"
exec {fresh_race_control_fd}<> "$FRESH_RACE_FIFO"
cat > "$FRESH_RACE_SHIM/flock" << 'EOF'
#!/usr/bin/env bash
"$DIAG_TEST_REAL_FLOCK" "$@"
lock_rc=$?
if ((lock_rc == 0)) && [[ "$DIAG_TEST_FLOCK_MODE" == pause ]]; then
  : > "$DIAG_TEST_FLOCK_READY"
  read -r -u "$DIAG_TEST_FLOCK_FD" _
elif ((lock_rc == 0)) && [[ "$DIAG_TEST_FLOCK_MODE" == reject ]]; then
  exit 97
fi
exit "$lock_rc"
EOF
chmod +x "$FRESH_RACE_SHIM/flock"
FRESH_RACE_REAL_FLOCK="$(command -v flock)"
PATH="$FRESH_RACE_SHIM:$PATH" \
  DIAG_TEST_REAL_FLOCK="$FRESH_RACE_REAL_FLOCK" \
  DIAG_TEST_FLOCK_MODE=pause \
  DIAG_TEST_FLOCK_READY="$FRESH_RACE_READY" \
  DIAG_TEST_FLOCK_FD="$fresh_race_control_fd" \
  timeout --signal=TERM --kill-after=1 15 \
  "$REPO_ROOT/diagnose.sh" --out-dir "$FRESH_RACE_BUNDLE" --yes \
  > "$FRESH_RACE_ROOT/first.output" 2>&1 &
fresh_race_first_pid=$!
fresh_race_ready=0
for _ in {1..300}; do
  if [[ -e "$FRESH_RACE_READY" ]]; then
    fresh_race_ready=1
    break
  fi
  kill -0 "$fresh_race_first_pid" 2> /dev/null || break
  sleep 0.01
done
fresh_race_second_rc=1
if ((fresh_race_ready == 1)); then
  PATH="$FRESH_RACE_SHIM:$PATH" \
    DIAG_TEST_REAL_FLOCK="$FRESH_RACE_REAL_FLOCK" \
    DIAG_TEST_FLOCK_MODE=reject \
    timeout --signal=TERM --kill-after=1 5 \
    "$REPO_ROOT/diagnose.sh" --out-dir "$FRESH_RACE_BUNDLE" --yes \
    > "$FRESH_RACE_ROOT/second.output" 2>&1
  fresh_race_second_rc=$?
  printf 'concurrent creator\n' > "$FRESH_RACE_BUNDLE/late-entry"
fi
# This cannot block: the harness holds both ends of the control FIFO. If the
# fixture died, the byte remains buffered and timeout still bounds the wait.
printf 'release\n' >&"$fresh_race_control_fd"
wait "$fresh_race_first_pid"
fresh_race_first_rc=$?
exec {fresh_race_control_fd}<&-
fresh_race_entries=""
if [[ -d "$FRESH_RACE_BUNDLE" ]]; then
  fresh_race_entries="$(find "$FRESH_RACE_BUNDLE" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
fi
check_eq "concurrent fresh writers serialize and recheck emptiness under lock" "1" \
  "$([[ $fresh_race_ready -eq 1 && $fresh_race_second_rc -eq 75 && $fresh_race_first_rc -ne 0 && "$fresh_race_entries" == late-entry ]] && echo 1 || echo 0)"

(
  diag_require_not_symlink "$LEDGER_GUARD_DIR/restore.tsv.symlink"
) > /dev/null 2>&1
check_eq "privileged output guard rejects symlinks" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

echo "== mutable bundle path graph =="
write_mutable_graph_fixture() {
  local bundle="$1"
  mkdir -p "$bundle/results"
  cat > "$bundle/results/meta.env" << 'EOF'
MODE=default
START_EPOCH=1
START_ISO=2026-01-01T00:00:00+00:00
BASELINE_CHILDREN=16
BASELINE_WAVES=50
GROUP_WAVES=50
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
SKIP_GDB=1
CPU_TARGET=auto
COMPLETED_PHASES=
INTERRUPTED=0
EOF
  printf 'authoritative-before-resume\n' > "$bundle/manifest.txt"
}

mutable_fixed_rejected=0
for mutable_case in commands-symlink run-symlink commands-hardlink commands-fifo; do
  MUTABLE_ROOT="$TMP/mutable-$mutable_case"
  MUTABLE_BUNDLE="$MUTABLE_ROOT/bundle"
  MUTABLE_VICTIM="$MUTABLE_ROOT/victim"
  mkdir -p "$MUTABLE_ROOT"
  write_mutable_graph_fixture "$MUTABLE_BUNDLE"
  printf 'victim-before-resume\n' > "$MUTABLE_VICTIM"
  case "$mutable_case" in
    commands-symlink) ln -s "$MUTABLE_VICTIM" "$MUTABLE_BUNDLE/commands.log" ;;
    run-symlink) ln -s "$MUTABLE_VICTIM" "$MUTABLE_BUNDLE/run.log" ;;
    commands-hardlink) ln "$MUTABLE_VICTIM" "$MUTABLE_BUNDLE/commands.log" ;;
    commands-fifo) mkfifo "$MUTABLE_BUNDLE/commands.log" ;;
  esac
  timeout --signal=TERM --kill-after=1 5 \
    "$REPO_ROOT/diagnose.sh" --resume "$MUTABLE_BUNDLE" --yes \
    > "$MUTABLE_ROOT/output" 2>&1
  mutable_rc=$?
  if [[ $mutable_rc -eq 1 &&
    "$(cat "$MUTABLE_BUNDLE/manifest.txt")" == authoritative-before-resume &&
    "$(cat "$MUTABLE_VICTIM")" == victim-before-resume ]]; then
    mutable_fixed_rejected=$((mutable_fixed_rejected + 1))
  fi
done
check_eq "resume rejects unsafe fixed mutable files before readiness revocation" \
  "4" "$mutable_fixed_rejected"

log_open_race_rejected=0
for log_kind in run commands; do
 for log_replacement in symlink fifo; do
  LOG_OPEN_ROOT="$TMP/log-open-race-$log_kind-$log_replacement"
  mkdir -p "$LOG_OPEN_ROOT"
  printf 'original log\n' > "$LOG_OPEN_ROOT/$log_kind.log"
  printf 'victim before\n' > "$LOG_OPEN_ROOT/victim"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    RESUME_DIR="$LOG_OPEN_ROOT"
    bundle_log_before_append_open() {
      mv -- "$2" "$2.original"
      if [[ "$log_replacement" == symlink ]]; then
        ln -s "$LOG_OPEN_ROOT/victim" "$2"
      else
        mkfifo "$2"
      fi
    }
    if [[ "$log_kind" == run ]]; then
      prepare_run_log "$LOG_OPEN_ROOT/run.log"
    else
      DIAG_COMMANDS_LOG="$LOG_OPEN_ROOT/commands.log"
      prepare_commands_log
    fi
  ) > /dev/null 2>&1
  log_open_rc=$?
  if [[ $log_open_rc -eq 1 && "$(cat "$LOG_OPEN_ROOT/victim")" == 'victim before' &&
    "$(cat "$LOG_OPEN_ROOT/$log_kind.log.original")" == 'original log' ]]; then
    log_open_race_rejected=$((log_open_race_rejected + 1))
  fi
 done
done
check_eq "validated log append open rejects path replacement without writing victims" \
  "4" "$log_open_race_rejected"

log_create_swap_rejected=0
for log_kind in run commands; do
  LOG_CREATE_ROOT="$TMP/log-create-swap-$log_kind"
  mkdir -p "$LOG_CREATE_ROOT"
  printf 'victim before\n' > "$LOG_CREATE_ROOT/victim"
  victim_mode_before="$(stat -c '%a' "$LOG_CREATE_ROOT/victim")"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    bundle_log_after_exclusive_create() {
      mv -- "$2" "$2.created"
      ln -s "$LOG_CREATE_ROOT/victim" "$2"
    }
    if [[ "$log_kind" == run ]]; then
      prepare_run_log "$LOG_CREATE_ROOT/run.log"
    else
      DIAG_COMMANDS_LOG="$LOG_CREATE_ROOT/commands.log"
      prepare_commands_log
    fi
  ) > /dev/null 2>&1
  log_create_rc=$?
  victim_mode_after="$(stat -c '%a' "$LOG_CREATE_ROOT/victim")"
  if [[ $log_create_rc -eq 1 && "$victim_mode_after" == "$victim_mode_before" &&
    "$(cat "$LOG_CREATE_ROOT/victim")" == 'victim before' &&
    -f "$LOG_CREATE_ROOT/$log_kind.log.created" ]]; then
    log_create_swap_rejected=$((log_create_swap_rejected + 1))
  fi
done
check_eq "exclusive log creation chmods only its retained inode after a path swap" \
  "2" "$log_create_swap_rejected"

STABLE_LOG_ROOT="$TMP/stable-log-fds"
mkdir -p "$STABLE_LOG_ROOT"
printf 'run original\n' > "$STABLE_LOG_ROOT/run.log"
printf 'commands original\n' > "$STABLE_LOG_ROOT/commands.log"
printf 'run victim\n' > "$STABLE_LOG_ROOT/run-victim"
printf 'commands victim\n' > "$STABLE_LOG_ROOT/commands-victim"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RESUME_DIR="$STABLE_LOG_ROOT"
  prepare_run_log "$STABLE_LOG_ROOT/run.log"
  DIAG_COMMANDS_LOG="$STABLE_LOG_ROOT/commands.log"
  prepare_commands_log
  [[ "$DIAG_LOG_FILE" =~ ^/proc/[0-9]+/fd/[0-9]+$ &&
    "$DIAG_COMMANDS_LOG" =~ ^/proc/[0-9]+/fd/[0-9]+$ ]] || exit 1
  run_fd="$RUN_LOG_FD"
  commands_fd="$COMMANDS_LOG_FD"
  mv -- "$STABLE_LOG_ROOT/run.log" "$STABLE_LOG_ROOT/run.bound"
  mv -- "$STABLE_LOG_ROOT/commands.log" "$STABLE_LOG_ROOT/commands.bound"
  ln -s "$STABLE_LOG_ROOT/run-victim" "$STABLE_LOG_ROOT/run.log"
  ln -s "$STABLE_LOG_ROOT/commands-victim" "$STABLE_LOG_ROOT/commands.log"
  diag_log "stable run append"
  diag_log_cmd printf '%s' "stable command append"
  bundle_log_fds_close
  [[ -z "$DIAG_LOG_FILE" && -z "$DIAG_COMMANDS_LOG" &&
    ! -e "/proc/$BASHPID/fd/$run_fd" && ! -e "/proc/$BASHPID/fd/$commands_fd" ]]
) > /dev/null 2>&1
stable_log_rc=$?
check_eq "common logging remains inode-stable after path replacement and closes descriptors" "1" \
  "$([[ $stable_log_rc -eq 0 && "$(cat "$STABLE_LOG_ROOT/run-victim")" == 'run victim' &&
    "$(cat "$STABLE_LOG_ROOT/commands-victim")" == 'commands victim' ]] &&
    grep -q 'stable run append' "$STABLE_LOG_ROOT/run.bound" &&
    grep -q 'stable.*command.*append' "$STABLE_LOG_ROOT/commands.bound" && echo 1 || echo 0)"

SPARSE_MUTABLE_BUNDLE="$TMP/sparse-mutable-bundle"
write_mutable_graph_fixture "$SPARSE_MUTABLE_BUNDLE"
sparse_tree_before="$(find "$SPARSE_MUTABLE_BUNDLE" -printf '%P\t%y\t%s\n' | sort)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$SPARSE_MUTABLE_BUNDLE"
  META_FILE="$SPARSE_MUTABLE_BUNDLE/results/meta.env"
  STATE_DIR="$SPARSE_MUTABLE_BUNDLE/state"
  diag_bundle_lock_acquire "$SPARSE_MUTABLE_BUNDLE"
  bundle_mutable_graph_validate
  diag_bundle_lock_release
)
sparse_graph_rc=$?
sparse_tree_after="$(find "$SPARSE_MUTABLE_BUNDLE" -printf '%P\t%y\t%s\n' | sort)"
check_eq "resume graph accepts absent subordinate directories without creating them" "1" \
  "$([[ $sparse_graph_rc -eq 0 && "$sparse_tree_after" == "$sparse_tree_before" ]] && echo 1 || echo 0)"

mutable_directory_rejected=0
for mutable_relative in \
  state logs env freq gdb telemetry \
  logs/individual logs/gdb logs/pinned-concurrent \
  state/individual-attempts state/individual-finalize \
  state/pinned-concurrent-waves state/pinned-concurrent-finalize \
  state/telemetry-baseline state/telemetry-groups state/telemetry-individual \
  state/telemetry-pinned-concurrent state/telemetry-gdb \
  telemetry/baseline telemetry/groups telemetry/individual \
  telemetry/pinned-concurrent telemetry/gdb; do
  mutable_slug="${mutable_relative//\//-}"
  MUTABLE_ROOT="$TMP/mutable-directory-$mutable_slug"
  MUTABLE_BUNDLE="$MUTABLE_ROOT/bundle"
  MUTABLE_EXTERNAL="$MUTABLE_ROOT/external"
  mkdir -p "$MUTABLE_EXTERNAL"
  write_mutable_graph_fixture "$MUTABLE_BUNDLE"
  mkdir -p "$MUTABLE_BUNDLE/$(dirname -- "$mutable_relative")"
  ln -s "$MUTABLE_EXTERNAL" "$MUTABLE_BUNDLE/$mutable_relative"
  timeout --signal=TERM --kill-after=1 5 \
    "$REPO_ROOT/diagnose.sh" --resume "$MUTABLE_BUNDLE" --yes \
    > "$MUTABLE_ROOT/output" 2>&1
  mutable_rc=$?
  if [[ $mutable_rc -eq 1 &&
    "$(cat "$MUTABLE_BUNDLE/manifest.txt")" == authoritative-before-resume &&
    -z "$(find "$MUTABLE_EXTERNAL" -mindepth 1 -print -quit)" ]]; then
    mutable_directory_rejected=$((mutable_directory_rejected + 1))
  fi
done
check_eq "resume rejects symlinked mutable directories before readiness revocation" \
  "23" "$mutable_directory_rejected"

INITIALIZING_META_BUNDLE="$TMP/mutable-initializing-meta/bundle"
write_mutable_graph_fixture "$INITIALIZING_META_BUNDLE"
printf 'partial metadata\n' > "$INITIALIZING_META_BUNDLE/.meta.env.initializing"
"$REPO_ROOT/diagnose.sh" --resume "$INITIALIZING_META_BUNDLE" --yes > /dev/null 2>&1
initializing_meta_rc=$?
check_eq "normal resume rejects a stranded fresh metadata initializer" "1" \
  "$([[ $initializing_meta_rc -eq 1 && "$(cat "$INITIALIZING_META_BUNDLE/manifest.txt")" == authoritative-before-resume && -f "$INITIALIZING_META_BUNDLE/.meta.env.initializing" ]] && echo 1 || echo 0)"

echo "== fresh-init interrupted recovery =="
# A crash during fresh bundle initialization can strand only the narrow
# artifact set main() creates before the first phase mutation. --resume must
# recover exactly that tree and continue as a fresh run on the same
# directory; anything beyond the set keeps the old resume behavior (ordinary
# validation, tree untouched). The fake node refuses every workload invocation,
# delegates only the random-generation primitive needed during setup, and makes
# phase 1 evidence generation fail deterministically -- well past the old
# "not a safe diagnostic bundle" rejection.
INIT_FAKE_BIN="$TMP/fresh-init-fake-bin"
mkdir -p "$INIT_FAKE_BIN"
cat > "$INIT_FAKE_BIN/node" << 'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -e) exec "$REAL_NODE_BIN" "$@" ;;
  */diagnose-lib/preflight-evidence.mjs)
    printf 'synthetic preflight evidence failure\n' >&2
    exit 1
    ;;
  */diagnose-lib/gdb-attempt-io.mjs | */diagnose-lib/gdb-evidence.mjs) exec "$REAL_NODE_BIN" "$@" ;;
  repro.mjs | child.mjs | */repro.mjs | */child.mjs)
    printf 'fresh-init fixture refused workload entrypoint: %s\n' "$1" >&2
    exit 97
    ;;
esac
printf 'synthetic workload output\n'
exit 0
EOF
cat > "$INIT_FAKE_BIN/taskset" << 'EOF'
#!/usr/bin/env bash
case "$1" in
  -c) shift 2; exec "$@" ;;
  -pc) printf 'pid %s affinity: synthetic\n' "$2"; exit 0 ;;
  *) exit 2 ;;
esac
EOF
cat > "$INIT_FAKE_BIN/gdb" << 'EOF'
#!/usr/bin/env bash
printf 'Inferior 1 exited normally\n'
EOF
cat > "$INIT_FAKE_BIN/timeout" << 'EOF'
#!/usr/bin/env bash
[[ "$1" == "--foreground" && "$2" == "--signal=KILL" ]] || exit 91
shift 3
exec "$@"
EOF
chmod +x "$INIT_FAKE_BIN/node" "$INIT_FAKE_BIN/taskset" \
  "$INIT_FAKE_BIN/gdb" "$INIT_FAKE_BIN/timeout"

write_init_dirs_fixture() {
  # The seven directories bundle_prepare_dir creates, and nothing else.
  mkdir -p "$1/results" "$1/logs/individual" "$1/state" "$1/env" "$1/freq" "$1/gdb"
}

write_init_meta_fixture() {
  # A complete initial config block with stale values, distinct from the CLI
  # overrides below so the fresh rewrite is observable.
  cat > "$1/results/meta.env" << 'EOF'
MODE=default
START_EPOCH=1
START_ISO=2026-01-01T00:00:00+00:00
BASELINE_CHILDREN=16
BASELINE_WAVES=50
GROUP_WAVES=50
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
SKIP_GDB=0
CPU_TARGET=auto
INTERRUPTED=0
EOF
}

write_partial_init_meta_fixture() {
  # Only initialization keys, but missing the baseline/group rows that
  # load_stored_config requires. Alone this is still init-era; paired with
  # any non-init artifact it proves recovery refused by falling through to
  # the old stored-config failure.
  cat > "$1/results/meta.env" << 'EOF'
MODE=default
INDIVIDUAL_RUNS=50
GDB_MAX_RUNS=12
SKIP_GDB=0
CPU_TARGET=auto
INTERRUPTED=0
EOF
}

run_fresh_init_resume() {
  # run_fresh_init_resume <bundle> <output-file> <timeout-seconds>
  local bundle="$1" output="$2" seconds="$3"
  timeout --signal=TERM --kill-after=2 "$seconds" \
    env PATH="$INIT_FAKE_BIN:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" \
    "$REPO_ROOT/diagnose.sh" --resume "$bundle" --yes \
    --quick --individual-runs 1 --group-waves 1 --gdb-max-runs 1 --skip-gdb \
    > "$output" 2>&1
}

fresh_init_recovery_observed() {
  # fresh_init_recovery_observed <bundle> <output-file> <rc>: the run
  # recovered, continued as a fresh run past the old rejection point, and
  # wrote fresh current-configuration metadata.
  local bundle="$1" output="$2" rc="$3"
  [[ $rc -eq 1 ]] &&
    grep -q 'recovered an interrupted fresh bundle initialization' "$output" &&
    ! grep -q 'not a safe diagnostic bundle' "$output" &&
    ! grep -q 'is not empty' "$output" &&
    grep -q 'phase 1/8: preflight' "$output" &&
    grep -qF "out dir            $bundle" "$output" &&
    ! grep -q '(resume)' "$output" &&
    [[ -f "$bundle/results/meta.env" && ! -L "$bundle/results/meta.env" ]] &&
    grep -q '^MODE=quick$' "$bundle/results/meta.env" &&
    grep -q '^GROUP_WAVES=1$' "$bundle/results/meta.env" &&
    grep -q '^INDIVIDUAL_RUNS=1$' "$bundle/results/meta.env" &&
    grep -q '^GDB_MAX_RUNS=1$' "$bundle/results/meta.env" &&
    grep -q '^SKIP_GDB=1$' "$bundle/results/meta.env"
}

fresh_init_recovery_refused() {
  # fresh_init_recovery_refused <bundle> <output> <rc> <message> <tree-before>:
  # recovery did not fire, the run died with the old message, and the tree is
  # byte-for-byte untouched.
  local bundle="$1" output="$2" rc="$3" message="$4" tree_before="$5"
  [[ $rc -eq 1 ]] &&
    grep -qF "$message" "$output" &&
    ! grep -q 'recovered an interrupted fresh bundle initialization' "$output" &&
    [[ "$(find "$bundle" -printf '%P\t%y\t%s\n' | sort)" == "$tree_before" ]]
}

INIT_P1="$TMP/fresh-init-empty-dirs"
write_init_dirs_fixture "$INIT_P1"
run_fresh_init_resume "$INIT_P1" "$INIT_P1.output" 90
init_p1_rc=$?
check_eq "fresh-init recovery accepts the seven empty preparation directories" "1" \
  "$(fresh_init_recovery_observed "$INIT_P1" "$INIT_P1.output" "$init_p1_rc" && echo 1 || echo 0)"

INIT_P2="$TMP/fresh-init-empty-bundle"
mkdir -p "$INIT_P2"
run_fresh_init_resume "$INIT_P2" "$INIT_P2.output" 90
init_p2_rc=$?
check_eq "fresh-init recovery accepts a completely empty bundle directory" "1" \
  "$(fresh_init_recovery_observed "$INIT_P2" "$INIT_P2.output" "$init_p2_rc" && echo 1 || echo 0)"

# A dry run must stay read-only: the recovery is reported, the plan is the
# fresh plan, and the tree is byte-for-byte untouched.
INIT_DRY="$TMP/fresh-init-dry-run"
write_init_dirs_fixture "$INIT_DRY"
write_init_meta_fixture "$INIT_DRY"
init_dry_before="$(find "$INIT_DRY" -printf '%P\t%y\t%s\n' | sort)"
timeout --signal=TERM --kill-after=2 30 \
  "$REPO_ROOT/diagnose.sh" --resume "$INIT_DRY" --dry-run --yes \
  > "$INIT_DRY.output" 2>&1
init_dry_rc=$?
check_eq "fresh-init recovery dry run reports without mutating" "1" \
  "$([[ $init_dry_rc -eq 0 ]] &&
    grep -q 'would recover an interrupted fresh bundle initialization' "$INIT_DRY.output" &&
    ! grep -q '(resume)' "$INIT_DRY.output" &&
    [[ "$(find "$INIT_DRY" -printf '%P\t%y\t%s\n' | sort)" == "$init_dry_before" ]] && echo 1 || echo 0)"

INIT_P3="$TMP/fresh-init-full-meta"
write_init_dirs_fixture "$INIT_P3"
write_init_meta_fixture "$INIT_P3"
run_fresh_init_resume "$INIT_P3" "$INIT_P3.output" 90
init_p3_rc=$?
check_eq "fresh-init recovery rewrites a complete stale initial config block" "1" \
  "$(fresh_init_recovery_observed "$INIT_P3" "$INIT_P3.output" "$init_p3_rc" &&
    ! grep -q '^INDIVIDUAL_RUNS=50$' "$INIT_P3/results/meta.env" && echo 1 || echo 0)"

INIT_P4="$TMP/fresh-init-truncated-meta"
write_init_dirs_fixture "$INIT_P4"
# SIGKILL mid-write shape: missing keys, a truncated trailing value, and no
# trailing newline.
printf 'MODE=default\nSTART_EPOCH=1\nBASELINE_CHILDREN=16\nCPU_TARGET=au' > "$INIT_P4/results/meta.env"
run_fresh_init_resume "$INIT_P4" "$INIT_P4.output" 90
init_p4_rc=$?
check_eq "fresh-init recovery tolerates a truncated initial config block" "1" \
  "$(fresh_init_recovery_observed "$INIT_P4" "$INIT_P4.output" "$init_p4_rc" && echo 1 || echo 0)"

INIT_P5="$TMP/fresh-init-zero-meta"
write_init_dirs_fixture "$INIT_P5"
: > "$INIT_P5/results/meta.env"
run_fresh_init_resume "$INIT_P5" "$INIT_P5.output" 90
init_p5_rc=$?
check_eq "fresh-init recovery accepts a zero-byte initial metadata file" "1" \
  "$(fresh_init_recovery_observed "$INIT_P5" "$INIT_P5.output" "$init_p5_rc" && echo 1 || echo 0)"

INIT_P6="$TMP/fresh-init-operational-logs"
write_init_dirs_fixture "$INIT_P6"
write_init_meta_fixture "$INIT_P6"
printf 'sentinel run log from the interrupted init\n' > "$INIT_P6/run.log"
printf 'sentinel command log from the interrupted init\n' > "$INIT_P6/commands.log"
run_fresh_init_resume "$INIT_P6" "$INIT_P6.output" 90
init_p6_rc=$?
check_eq "fresh-init recovery discards interrupted operational logs" "1" \
  "$(fresh_init_recovery_observed "$INIT_P6" "$INIT_P6.output" "$init_p6_rc" &&
    ! grep -q sentinel "$INIT_P6/run.log" &&
    ! grep -q sentinel "$INIT_P6/commands.log" && echo 1 || echo 0)"

INIT_P7="$TMP/fresh-init-stranded-meta-temp"
write_init_dirs_fixture "$INIT_P7"
write_init_meta_fixture "$INIT_P7"
printf 'partial atomic rewrite\n' > "$INIT_P7/results/.meta.env.a1B2c3"
run_fresh_init_resume "$INIT_P7" "$INIT_P7.output" 90
init_p7_rc=$?
check_eq "fresh-init recovery discards a stranded atomic metadata temp" "1" \
  "$(fresh_init_recovery_observed "$INIT_P7" "$INIT_P7.output" "$init_p7_rc" &&
    [[ -z "$(find "$INIT_P7/results" -mindepth 1 -name '.meta.env.*' -print -quit)" ]] && echo 1 || echo 0)"

INIT_P8="$TMP/fresh-init-legacy-root-initializer"
write_init_dirs_fixture "$INIT_P8"
write_init_meta_fixture "$INIT_P8"
printf 'partial metadata\n' > "$INIT_P8/.meta.env.initializing"
run_fresh_init_resume "$INIT_P8" "$INIT_P8.output" 90
init_p8_rc=$?
check_eq "fresh-init recovery discards a legacy root metadata initializer" "1" \
  "$(fresh_init_recovery_observed "$INIT_P8" "$INIT_P8.output" "$init_p8_rc" &&
    [[ ! -e "$INIT_P8/.meta.env.initializing" && ! -L "$INIT_P8/.meta.env.initializing" ]] && echo 1 || echo 0)"

INIT_P9="$TMP/fresh-init-legacy-results-initializer"
write_init_dirs_fixture "$INIT_P9"
write_init_meta_fixture "$INIT_P9"
printf 'partial metadata\n' > "$INIT_P9/results/.meta.env.initializing"
run_fresh_init_resume "$INIT_P9" "$INIT_P9.output" 90
init_p9_rc=$?
check_eq "fresh-init recovery discards a legacy results metadata initializer" "1" \
  "$(fresh_init_recovery_observed "$INIT_P9" "$INIT_P9.output" "$init_p9_rc" &&
    [[ ! -e "$INIT_P9/results/.meta.env.initializing" && ! -L "$INIT_P9/results/.meta.env.initializing" ]] && echo 1 || echo 0)"

INIT_N1="$TMP/fresh-init-reject-completed-phases"
write_init_dirs_fixture "$INIT_N1"
write_partial_init_meta_fixture "$INIT_N1"
printf 'COMPLETED_PHASES=\n' >> "$INIT_N1/results/meta.env"
init_n1_before="$(find "$INIT_N1" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N1" "$INIT_N1.output" 15
init_n1_rc=$?
check_eq "fresh-init recovery refuses metadata carrying completion keys" "1" \
  "$(fresh_init_recovery_refused "$INIT_N1" "$INIT_N1.output" "$init_n1_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n1_before" && echo 1 || echo 0)"

INIT_N2="$TMP/fresh-init-reject-unknown-key"
write_init_dirs_fixture "$INIT_N2"
write_partial_init_meta_fixture "$INIT_N2"
printf 'BOGUS_KEY=1\n' >> "$INIT_N2/results/meta.env"
init_n2_before="$(find "$INIT_N2" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N2" "$INIT_N2.output" 15
init_n2_rc=$?
check_eq "fresh-init recovery refuses metadata carrying unknown keys" "1" \
  "$(fresh_init_recovery_refused "$INIT_N2" "$INIT_N2.output" "$init_n2_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n2_before" && echo 1 || echo 0)"

INIT_N3="$TMP/fresh-init-reject-state-marker"
write_init_dirs_fixture "$INIT_N3"
write_partial_init_meta_fixture "$INIT_N3"
: > "$INIT_N3/state/phase-baseline.done"
init_n3_before="$(find "$INIT_N3" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N3" "$INIT_N3.output" 15
init_n3_rc=$?
check_eq "fresh-init recovery refuses a bundle with a completion marker" "1" \
  "$(fresh_init_recovery_refused "$INIT_N3" "$INIT_N3.output" "$init_n3_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n3_before" && echo 1 || echo 0)"

INIT_N4="$TMP/fresh-init-reject-redo-pending"
write_init_dirs_fixture "$INIT_N4"
write_partial_init_meta_fixture "$INIT_N4"
printf 'garbage pending redo\n' > "$INIT_N4/state/redo.pending"
init_n4_before="$(find "$INIT_N4" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N4" "$INIT_N4.output" 15
init_n4_rc=$?
check_eq "fresh-init recovery refuses a bundle with a pending redo record" "1" \
  "$(fresh_init_recovery_refused "$INIT_N4" "$INIT_N4.output" "$init_n4_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n4_before" && echo 1 || echo 0)"

INIT_N5="$TMP/fresh-init-reject-long-temp-suffix"
write_init_dirs_fixture "$INIT_N5"
write_partial_init_meta_fixture "$INIT_N5"
printf 'stale temp\n' > "$INIT_N5/results/.meta.env.toolong7"
init_n5_before="$(find "$INIT_N5" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N5" "$INIT_N5.output" 15
init_n5_rc=$?
check_eq "fresh-init recovery refuses a non-mktemp metadata temp name" "1" \
  "$(fresh_init_recovery_refused "$INIT_N5" "$INIT_N5.output" "$init_n5_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n5_before" && echo 1 || echo 0)"

INIT_N6="$TMP/fresh-init-reject-malformed-meta-line"
write_init_dirs_fixture "$INIT_N6"
write_partial_init_meta_fixture "$INIT_N6"
printf 'garbage-without-equals\n' >> "$INIT_N6/results/meta.env"
init_n6_before="$(find "$INIT_N6" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N6" "$INIT_N6.output" 15
init_n6_rc=$?
check_eq "fresh-init recovery refuses a malformed metadata line" "1" \
  "$(fresh_init_recovery_refused "$INIT_N6" "$INIT_N6.output" "$init_n6_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n6_before" && echo 1 || echo 0)"

INIT_N7="$TMP/fresh-init-reject-oversized-meta"
write_init_dirs_fixture "$INIT_N7"
write_partial_init_meta_fixture "$INIT_N7"
for _ in $(seq 1 800); do printf 'START_EPOCH=1\n'; done >> "$INIT_N7/results/meta.env"
init_n7_before="$(find "$INIT_N7" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N7" "$INIT_N7.output" 15
init_n7_rc=$?
check_eq "fresh-init recovery refuses an oversized metadata file" "1" \
  "$(fresh_init_recovery_refused "$INIT_N7" "$INIT_N7.output" "$init_n7_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n7_before" && echo 1 || echo 0)"

# Recovery must fire before the --redo validation: a recoverable tree is
# emptied, then the run dies because --redo requires a real resumable bundle.
INIT_REDO="$TMP/fresh-init-redo-after-recovery"
write_init_dirs_fixture "$INIT_REDO"
write_init_meta_fixture "$INIT_REDO"
timeout --signal=TERM --kill-after=2 30 \
  env PATH="$INIT_FAKE_BIN:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN" \
  "$REPO_ROOT/diagnose.sh" --resume "$INIT_REDO" --redo preflight --yes \
  > "$INIT_REDO.output" 2>&1
init_redo_rc=$?
check_eq "fresh-init recovery precedes the --redo resume requirement" "1" \
  "$([[ $init_redo_rc -eq 1 ]] &&
    grep -q 'recovered an interrupted fresh bundle initialization' "$INIT_REDO.output" &&
    grep -qF -- '--redo requires --resume DIR' "$INIT_REDO.output" &&
    [[ ! -e "$INIT_REDO/results" && ! -L "$INIT_REDO/results" ]] && echo 1 || echo 0)"

init_evidence_refused=0
for init_evidence_dir in env freq gdb logs logs/individual; do
  init_evidence_slug="${init_evidence_dir//\//-}"
  INIT_NEV="$TMP/fresh-init-reject-evidence-$init_evidence_slug"
  write_init_dirs_fixture "$INIT_NEV"
  write_partial_init_meta_fixture "$INIT_NEV"
  printf 'evidence\n' > "$INIT_NEV/$init_evidence_dir/foo.txt"
  init_nev_before="$(find "$INIT_NEV" -printf '%P\t%y\t%s\n' | sort)"
  run_fresh_init_resume "$INIT_NEV" "$INIT_NEV.output" 15
  init_nev_rc=$?
  if fresh_init_recovery_refused "$INIT_NEV" "$INIT_NEV.output" "$init_nev_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_nev_before"; then
    init_evidence_refused=$((init_evidence_refused + 1))
  fi
done
check_eq "fresh-init recovery refuses any evidence-directory entry" "5" \
  "$init_evidence_refused"

INIT_N10="$TMP/fresh-init-reject-derived-output"
write_init_dirs_fixture "$INIT_N10"
write_partial_init_meta_fixture "$INIT_N10"
printf '{}\n' > "$INIT_N10/results.json"
init_n10_before="$(find "$INIT_N10" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N10" "$INIT_N10.output" 15
init_n10_rc=$?
check_eq "fresh-init recovery refuses a bundle with derived outputs" "1" \
  "$(fresh_init_recovery_refused "$INIT_N10" "$INIT_N10.output" "$init_n10_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n10_before" && echo 1 || echo 0)"

INIT_N11_ROOT="$TMP/fresh-init-reject-run-symlink"
INIT_N11="$INIT_N11_ROOT/bundle"
write_init_dirs_fixture "$INIT_N11"
write_partial_init_meta_fixture "$INIT_N11"
printf 'victim before resume\n' > "$INIT_N11_ROOT/victim"
ln -s "$INIT_N11_ROOT/victim" "$INIT_N11/run.log"
init_n11_before="$(find "$INIT_N11" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N11" "$INIT_N11_ROOT/output" 15
init_n11_rc=$?
check_eq "fresh-init recovery refuses a symlinked run log" "1" \
  "$(fresh_init_recovery_refused "$INIT_N11" "$INIT_N11_ROOT/output" "$init_n11_rc" \
    "mutable bundle file 'run.log' is unsafe" "$init_n11_before" &&
    [[ "$(cat "$INIT_N11_ROOT/victim")" == 'victim before resume' ]] && echo 1 || echo 0)"

INIT_N12_ROOT="$TMP/fresh-init-reject-meta-symlink"
INIT_N12="$INIT_N12_ROOT/bundle"
write_init_dirs_fixture "$INIT_N12"
printf 'stored metadata\n' > "$INIT_N12_ROOT/victim"
ln -s "$INIT_N12_ROOT/victim" "$INIT_N12/results/meta.env"
init_n12_before="$(find "$INIT_N12" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N12" "$INIT_N12_ROOT/output" 15
init_n12_rc=$?
check_eq "fresh-init recovery refuses a symlinked metadata file" "1" \
  "$(fresh_init_recovery_refused "$INIT_N12" "$INIT_N12_ROOT/output" "$init_n12_rc" \
    'is not a safe diagnostic bundle' "$init_n12_before" &&
    [[ "$(cat "$INIT_N12_ROOT/victim")" == 'stored metadata' ]] && echo 1 || echo 0)"

INIT_N13_ROOT="$TMP/fresh-init-reject-meta-hardlink"
INIT_N13="$INIT_N13_ROOT/bundle"
write_init_dirs_fixture "$INIT_N13"
write_partial_init_meta_fixture "$INIT_N13"
mv "$INIT_N13/results/meta.env" "$INIT_N13_ROOT/meta.env"
ln "$INIT_N13_ROOT/meta.env" "$INIT_N13/results/meta.env"
init_n13_before="$(find "$INIT_N13" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N13" "$INIT_N13_ROOT/output" 15
init_n13_rc=$?
check_eq "fresh-init recovery refuses a hardlinked metadata file" "1" \
  "$(fresh_init_recovery_refused "$INIT_N13" "$INIT_N13_ROOT/output" "$init_n13_rc" \
    'is not a safe diagnostic bundle' "$init_n13_before" &&
    [[ "$(cat "$INIT_N13_ROOT/meta.env")" == "$(cat "$INIT_N13/results/meta.env")" ]] && echo 1 || echo 0)"

INIT_N14="$TMP/fresh-init-reject-run-dir"
write_init_dirs_fixture "$INIT_N14"
write_partial_init_meta_fixture "$INIT_N14"
mkdir "$INIT_N14/run.log"
init_n14_before="$(find "$INIT_N14" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N14" "$INIT_N14.output" 15
init_n14_rc=$?
check_eq "fresh-init recovery refuses a directory named run.log" "1" \
  "$(fresh_init_recovery_refused "$INIT_N14" "$INIT_N14.output" "$init_n14_rc" \
    "mutable bundle file 'run.log' is unsafe" "$init_n14_before" && echo 1 || echo 0)"

INIT_N15="$TMP/fresh-init-reject-unknown-root-file"
write_init_dirs_fixture "$INIT_N15"
write_partial_init_meta_fixture "$INIT_N15"
printf 'unrelated\n' > "$INIT_N15/foo.txt"
init_n15_before="$(find "$INIT_N15" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N15" "$INIT_N15.output" 15
init_n15_rc=$?
check_eq "fresh-init recovery refuses an unknown file at the bundle root" "1" \
  "$(fresh_init_recovery_refused "$INIT_N15" "$INIT_N15.output" "$init_n15_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n15_before" && echo 1 || echo 0)"

INIT_N16="$TMP/fresh-init-reject-unknown-results-file"
write_init_dirs_fixture "$INIT_N16"
write_partial_init_meta_fixture "$INIT_N16"
printf 'groups\n' > "$INIT_N16/results/groups.tsv"
init_n16_before="$(find "$INIT_N16" -printf '%P\t%y\t%s\n' | sort)"
run_fresh_init_resume "$INIT_N16" "$INIT_N16.output" 15
init_n16_rc=$?
check_eq "fresh-init recovery refuses unknown result evidence" "1" \
  "$(fresh_init_recovery_refused "$INIT_N16" "$INIT_N16.output" "$init_n16_rc" \
    'stored metadata is missing its exact baseline/group configuration' "$init_n16_before" && echo 1 || echo 0)"

UNKNOWN_MARKER_BUNDLE="$TMP/mutable-unknown-marker/bundle"
write_mutable_graph_fixture "$UNKNOWN_MARKER_BUNDLE"
mkdir -p "$UNKNOWN_MARKER_BUNDLE/state"
: > "$UNKNOWN_MARKER_BUNDLE/state/phase-unknown.done"
"$REPO_ROOT/diagnose.sh" --resume "$UNKNOWN_MARKER_BUNDLE" --yes > /dev/null 2>&1
unknown_marker_rc=$?
check_eq "resume rejects unknown completion markers before readiness revocation" "1" \
  "$([[ $unknown_marker_rc -eq 1 && "$(cat "$UNKNOWN_MARKER_BUNDLE/manifest.txt")" == authoritative-before-resume ]] && echo 1 || echo 0)"

unsafe_predicate_rejected=0
for marker_predicate in cpu-target completed-change redo-authorization; do
  PREDICATE_ROOT="$TMP/marker-predicate-$marker_predicate"
  mkdir -p "$PREDICATE_ROOT/bundle/results" "$PREDICATE_ROOT/bundle/state"
  printf 'COMPLETED_PHASES=\n' > "$PREDICATE_ROOT/bundle/results/meta.env"
  predicate_phase=individual
  [[ "$marker_predicate" != cpu-target ]] || predicate_phase=frequency
  ln -s "$PREDICATE_ROOT/victim" "$PREDICATE_ROOT/bundle/state/phase-$predicate_phase.done"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$PREDICATE_ROOT/bundle"
    STATE_DIR="$PREDICATE_ROOT/bundle/state"
    META_FILE="$PREDICATE_ROOT/bundle/results/meta.env"
    DIAG_LOG_FILE=""
    case "$marker_predicate" in
      cpu-target) cpu_target_matches_completed_phase auto frequency ;;
      completed-change) require_redo_for_completed_change individual "test change" ;;
      redo-authorization) redo_changed_config_authorized_for_phase individual ;;
    esac
  ) > /dev/null 2>&1
  predicate_rc=$?
  if [[ $predicate_rc -eq 1 && ! -e "$PREDICATE_ROOT/victim" &&
    -L "$PREDICATE_ROOT/bundle/state/phase-$predicate_phase.done" ]]; then
    unsafe_predicate_rejected=$((unsafe_predicate_rejected + 1))
  fi
done
check_eq "all completion predicates reject unsafe markers" "3" \
  "$unsafe_predicate_rejected"

marker_symlink_rejected=0
for marker_phase in individual gdb; do
  MARKER_ROOT="$TMP/marker-$marker_phase"
  mkdir -p "$MARKER_ROOT/bundle/results" "$MARKER_ROOT/bundle/state"
  printf 'COMPLETED_PHASES=\n' > "$MARKER_ROOT/bundle/results/meta.env"
  ln -s "$MARKER_ROOT/victim" "$MARKER_ROOT/bundle/state/phase-$marker_phase.done"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$MARKER_ROOT/bundle"
    STATE_DIR="$MARKER_ROOT/bundle/state"
    META_FILE="$MARKER_ROOT/bundle/results/meta.env"
    DIAG_LOG_FILE=""
    mark_done "$marker_phase"
  ) > /dev/null 2>&1
  marker_rc=$?
  if [[ $marker_rc -eq 1 && ! -e "$MARKER_ROOT/victim" &&
    -L "$MARKER_ROOT/bundle/state/phase-$marker_phase.done" ]]; then
    marker_symlink_rejected=$((marker_symlink_rejected + 1))
  fi
done
check_eq "exclusive completion markers never follow dangling symlinks" \
  "2" "$marker_symlink_rejected"

marker_sync_rollback=0
for sync_failure in chmod marker directory; do
  SYNC_FAILURE_ROOT="$TMP/marker-sync-$sync_failure"
  mkdir -p "$SYNC_FAILURE_ROOT/results" "$SYNC_FAILURE_ROOT/state"
  printf 'COMPLETED_PHASES=\n' > "$SYNC_FAILURE_ROOT/results/meta.env"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$SYNC_FAILURE_ROOT"
    STATE_DIR="$SYNC_FAILURE_ROOT/state"
    META_FILE="$SYNC_FAILURE_ROOT/results/meta.env"
    DIAG_LOG_FILE=""
    state_sync_failed=0
    chmod() {
      [[ "$sync_failure" != chmod ]] || return 1
      command chmod "$@"
    }
    sync() {
      if [[ "$sync_failure" == marker && "$2" == "$PHASE_MARKER_FD_PATH" ]]; then
        return 1
      fi
      if [[ "$sync_failure" == directory && "$2" == "$STATE_DIR" && $state_sync_failed -eq 0 ]]; then
        state_sync_failed=1
        return 1
      fi
      return 0
    }
    mark_done individual
  ) > /dev/null 2>&1
  sync_failure_rc=$?
  if [[ $sync_failure_rc -eq 1 &&
    ! -e "$SYNC_FAILURE_ROOT/state/phase-individual.done" &&
    ! -L "$SYNC_FAILURE_ROOT/state/phase-individual.done" &&
    "$(cat "$SYNC_FAILURE_ROOT/results/meta.env")" == 'COMPLETED_PHASES=' ]]; then
    marker_sync_rollback=$((marker_sync_rollback + 1))
  fi
done
check_eq "completion publication rolls back marker and metadata on creation or sync failure" \
  "3" "$marker_sync_rollback"

MARKER_CLOSE_FAIL_ROOT="$TMP/marker-close-failure"
mkdir -p "$MARKER_CLOSE_FAIL_ROOT/results" "$MARKER_CLOSE_FAIL_ROOT/state"
printf 'COMPLETED_PHASES=\n' > "$MARKER_CLOSE_FAIL_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MARKER_CLOSE_FAIL_ROOT"
  STATE_DIR="$MARKER_CLOSE_FAIL_ROOT/state"
  META_FILE="$MARKER_CLOSE_FAIL_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  phase_marker_published_fd_close() { return 1; }
  mark_done individual
) > /dev/null 2>&1
marker_close_fail_rc=$?
check_eq "completion descriptor close failure exact-rolls back before metadata" "1" \
  "$([[ $marker_close_fail_rc -eq 1 && ! -e "$MARKER_CLOSE_FAIL_ROOT/state/phase-individual.done" &&
    ! -L "$MARKER_CLOSE_FAIL_ROOT/state/phase-individual.done" &&
    "$(cat "$MARKER_CLOSE_FAIL_ROOT/results/meta.env")" == 'COMPLETED_PHASES=' ]] && echo 1 || echo 0)"

PRE_ID_MARKER_ROOT="$TMP/marker-pre-id-failure"
mkdir -p "$PRE_ID_MARKER_ROOT/results" "$PRE_ID_MARKER_ROOT/state"
printf 'COMPLETED_PHASES=\n' > "$PRE_ID_MARKER_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PRE_ID_MARKER_ROOT"
  STATE_DIR="$PRE_ID_MARKER_ROOT/state"
  META_FILE="$PRE_ID_MARKER_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  phase_marker_capture_identity() { return 1; }
  mark_done individual
) > /dev/null 2>&1
pre_id_marker_rc=$?
check_eq "pre-identity failure removes the exact mode-invalid marker through its open FD" "1" \
  "$([[ $pre_id_marker_rc -eq 1 && ! -e "$PRE_ID_MARKER_ROOT/state/phase-individual.done" &&
    ! -L "$PRE_ID_MARKER_ROOT/state/phase-individual.done" &&
    "$(cat "$PRE_ID_MARKER_ROOT/results/meta.env")" == 'COMPLETED_PHASES=' ]] && echo 1 || echo 0)"

MARKER_META_FAIL_ROOT="$TMP/marker-metadata-failure"
mkdir -p "$MARKER_META_FAIL_ROOT/results" "$MARKER_META_FAIL_ROOT/state"
printf 'COMPLETED_PHASES=\n' > "$MARKER_META_FAIL_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MARKER_META_FAIL_ROOT"
  STATE_DIR="$MARKER_META_FAIL_ROOT/state"
  META_FILE="$MARKER_META_FAIL_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  meta_config_rename() { return 1; }
  mark_done individual
) > /dev/null 2>&1
marker_meta_fail_rc=$?
check_eq "metadata publication failure rolls back the exact durable completion marker" "1" \
  "$([[ $marker_meta_fail_rc -eq 1 && ! -e "$MARKER_META_FAIL_ROOT/state/phase-individual.done" &&
    ! -L "$MARKER_META_FAIL_ROOT/state/phase-individual.done" &&
    "$(cat "$MARKER_META_FAIL_ROOT/results/meta.env")" == 'COMPLETED_PHASES=' &&
    -z "$(find "$MARKER_META_FAIL_ROOT/results" -maxdepth 1 -name '.meta.env.*' -print -quit)" ]] && echo 1 || echo 0)"

META_FAILED_RENAME_TAMPER_ROOT="$TMP/marker-metadata-failed-rename-tamper"
mkdir -p "$META_FAILED_RENAME_TAMPER_ROOT/results" "$META_FAILED_RENAME_TAMPER_ROOT/state"
printf 'MODE=quick\nCOMPLETED_PHASES=\n' > "$META_FAILED_RENAME_TAMPER_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$META_FAILED_RENAME_TAMPER_ROOT"
  STATE_DIR="$META_FAILED_RENAME_TAMPER_ROOT/state"
  META_FILE="$META_FAILED_RENAME_TAMPER_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  meta_config_rename() {
    mv -T -- "$1" "$2" || return 1
    printf 'TAMPERED_AFTER_RENAME=1\n' >> "$2"
    return 1
  }
  mark_done individual
) > /dev/null 2>&1
meta_failed_rename_tamper_rc=$?
check_eq "failed rename with a changed mismatched metadata inode rolls back completion" "1" \
  "$([[ $meta_failed_rename_tamper_rc -eq 1 &&
    ! -e "$META_FAILED_RENAME_TAMPER_ROOT/state/phase-individual.done" &&
    ! -L "$META_FAILED_RENAME_TAMPER_ROOT/state/phase-individual.done" &&
    "$(grep -c '^COMPLETED_PHASES=individual$' "$META_FAILED_RENAME_TAMPER_ROOT/results/meta.env")" == 1 &&
    "$(grep -c '^TAMPERED_AFTER_RENAME=1$' "$META_FAILED_RENAME_TAMPER_ROOT/results/meta.env")" == 1 ]] && echo 1 || echo 0)"

META_PRE_RECHECK_ROOT="$TMP/marker-metadata-pre-recheck-replacement"
mkdir -p "$META_PRE_RECHECK_ROOT/results" "$META_PRE_RECHECK_ROOT/state"
printf 'MODE=quick\nCOMPLETED_PHASES=\n' > "$META_PRE_RECHECK_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$META_PRE_RECHECK_ROOT"
  STATE_DIR="$META_PRE_RECHECK_ROOT/state"
  META_FILE="$META_PRE_RECHECK_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  phase_completion_before_meta_recheck() {
    mv -- "$META_FILE" "$META_FILE.before-replacement"
    printf 'MODE=replaced\nCOMPLETED_PHASES=\n' > "$META_FILE"
  }
  mark_done individual
) > /dev/null 2>&1
meta_pre_recheck_rc=$?
check_eq "pre-rewrite metadata replacement rolls back the exact completion marker" "1" \
  "$([[ $meta_pre_recheck_rc -eq 1 && ! -e "$META_PRE_RECHECK_ROOT/state/phase-individual.done" &&
    ! -L "$META_PRE_RECHECK_ROOT/state/phase-individual.done" &&
    "$(sed -n 's/^MODE=//p' "$META_PRE_RECHECK_ROOT/results/meta.env")" == replaced &&
    -f "$META_PRE_RECHECK_ROOT/results/meta.env.before-replacement" ]] && echo 1 || echo 0)"

META_NO_RENAME_ROOT="$TMP/marker-metadata-success-without-rename"
mkdir -p "$META_NO_RENAME_ROOT/results" "$META_NO_RENAME_ROOT/state"
printf 'MODE=quick\nCOMPLETED_PHASES=\n' > "$META_NO_RENAME_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$META_NO_RENAME_ROOT"
  STATE_DIR="$META_NO_RENAME_ROOT/state"
  META_FILE="$META_NO_RENAME_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  rewrite_meta_atomic() { :; }
  mark_done individual
) > /dev/null 2>&1
meta_no_rename_rc=$?
check_eq "nominal metadata success without an inode change rolls back completion" "1" \
  "$([[ $meta_no_rename_rc -eq 1 && ! -e "$META_NO_RENAME_ROOT/state/phase-individual.done" &&
    "$(cat "$META_NO_RENAME_ROOT/results/meta.env")" == $'MODE=quick\nCOMPLETED_PHASES=' ]] && echo 1 || echo 0)"

META_POST_REWRITE_ROOT="$TMP/marker-metadata-post-rewrite-tamper"
mkdir -p "$META_POST_REWRITE_ROOT/results" "$META_POST_REWRITE_ROOT/state"
printf 'MODE=quick\nCOMPLETED_PHASES=\n' > "$META_POST_REWRITE_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$META_POST_REWRITE_ROOT"
  STATE_DIR="$META_POST_REWRITE_ROOT/state"
  META_FILE="$META_POST_REWRITE_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  phase_completion_after_meta_rewrite() {
    printf 'TAMPERED=1\n' >> "$META_FILE"
  }
  mark_done individual
) > /dev/null 2>&1
meta_post_rewrite_rc=$?
check_eq "post-success metadata digest mismatch fails closed after the rename commit" "1" \
  "$([[ $meta_post_rewrite_rc -eq 1 && ! -e "$META_POST_REWRITE_ROOT/state/phase-individual.done" &&
    ! -L "$META_POST_REWRITE_ROOT/state/phase-individual.done" &&
    "$(grep -c '^COMPLETED_PHASES=individual$' "$META_POST_REWRITE_ROOT/results/meta.env")" == 1 &&
    "$(grep -c '^TAMPERED=1$' "$META_POST_REWRITE_ROOT/results/meta.env")" == 1 ]] && echo 1 || echo 0)"

META_DIR_SYNC_FAIL_ROOT="$TMP/marker-metadata-directory-sync-failure"
mkdir -p "$META_DIR_SYNC_FAIL_ROOT/results" "$META_DIR_SYNC_FAIL_ROOT/state"
printf 'MODE=quick\nCOMPLETED_PHASES=\n' > "$META_DIR_SYNC_FAIL_ROOT/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$META_DIR_SYNC_FAIL_ROOT"
  STATE_DIR="$META_DIR_SYNC_FAIL_ROOT/state"
  META_FILE="$META_DIR_SYNC_FAIL_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  sync() {
    [[ "$2" != "$META_DIR_SYNC_FAIL_ROOT/results" ]]
  }
  mark_done individual
) > /dev/null 2>&1
meta_dir_sync_fail_rc=$?
meta_dir_sync_marker="$(stat -c '%u:%h:%s' "$META_DIR_SYNC_FAIL_ROOT/state/phase-individual.done" 2> /dev/null || true)"
check_eq "post-rename metadata directory sync failure retains a matching authoritative marker" "1" \
  "$([[ $meta_dir_sync_fail_rc -eq 1 && "$meta_dir_sync_marker" == "$EUID:1:0" &&
    "$(grep -c '^COMPLETED_PHASES=individual$' "$META_DIR_SYNC_FAIL_ROOT/results/meta.env")" == 1 &&
    -z "$(find "$META_DIR_SYNC_FAIL_ROOT/results" -maxdepth 1 -name '.meta.env.*' -print -quit)" ]] && echo 1 || echo 0)"

VALID_MARKER_ROOT="$TMP/valid-exclusive-marker"
mkdir -p "$VALID_MARKER_ROOT/results" "$VALID_MARKER_ROOT/state"
printf 'COMPLETED_PHASES=\n' > "$VALID_MARKER_ROOT/results/meta.env"
VALID_MARKER_SYNC_TRACE="$VALID_MARKER_ROOT/sync.trace"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$VALID_MARKER_ROOT"
  STATE_DIR="$VALID_MARKER_ROOT/state"
  META_FILE="$VALID_MARKER_ROOT/results/meta.env"
  DIAG_LOG_FILE=""
  sync() {
    printf '%s\n' "$2" >> "$VALID_MARKER_SYNC_TRACE"
  }
  mark_done individual
)
valid_marker_state="$(stat -c '%u:%h:%s' "$VALID_MARKER_ROOT/state/phase-individual.done")"
check_eq "completion marker publication is owned, single-link, and zero-byte" "1" \
  "$([[ "$valid_marker_state" == "$EUID:1:0" ]] && grep -qx 'COMPLETED_PHASES=individual' "$VALID_MARKER_ROOT/results/meta.env" &&
    [[ "$(sed -n '1p' "$VALID_MARKER_SYNC_TRACE")" =~ ^/proc/[0-9]+/fd/[0-9]+$ ]] &&
    [[ "$(sed -n '2p' "$VALID_MARKER_SYNC_TRACE")" == "$VALID_MARKER_ROOT/state" ]] &&
    [[ "$(sed -n '3p' "$VALID_MARKER_SYNC_TRACE")" == "$VALID_MARKER_ROOT/results/".meta.env.* ]] &&
    [[ "$(sed -n '4p' "$VALID_MARKER_SYNC_TRACE")" == "$VALID_MARKER_ROOT/results" ]] &&
    [[ "$(wc -l < "$VALID_MARKER_SYNC_TRACE")" == 4 ]] && echo 1 || echo 0)"

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
bash "$REPO_ROOT/capture-fault.sh" 0 x 1 "$TMP/out" 0123456789abcdef0123456789abcdef > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-numeric runs (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 06 1 "$TMP/out" 0123456789abcdef0123456789abcdef > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-canonical run counts (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" not-a-generation > /dev/null 2>&1
check_eq "capture-fault.sh rejects a non-hex generation (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789ABCDEF0123456789ABCDEF > /dev/null 2>&1
check_eq "capture-fault.sh rejects an uppercase generation (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" > /dev/null 2>&1
check_eq "capture-fault.sh requires the generation argument (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 65536 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef > /dev/null 2>&1
check_eq "capture-fault.sh rejects an out-of-range CPU (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 0 1 "$TMP/out" 0123456789abcdef0123456789abcdef > /dev/null 2>&1
check_eq "capture-fault.sh rejects zero runs (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 0 "$TMP/out" 0123456789abcdef0123456789abcdef > /dev/null 2>&1
check_eq "capture-fault.sh rejects zero captures (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef node > /dev/null 2>&1
check_eq "capture-fault.sh rejects a relative NODE_BIN (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef /definitely/missing/node > /dev/null 2>&1
check_eq "capture-fault.sh rejects a missing NODE_BIN (rc=2)" "2" "$?"
printf 'not executable\n' > "$TMP/not-executable-node"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef "$TMP/not-executable-node" > /dev/null 2>&1
check_eq "capture-fault.sh rejects a non-executable NODE_BIN (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef "$TMP" > /dev/null 2>&1
check_eq "capture-fault.sh rejects a directory NODE_BIN (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" 0123456789abcdef0123456789abcdef "$TMP" extra > /dev/null 2>&1
check_eq "capture-fault.sh rejects a seventh argument (rc=2)" "2" "$?"
# Missing dependency: a PATH containing everything except gdb.
mkdir -p "$TMP/bin"
for c in bash grep rm mkdir cat date head tail sort find xargs timeout taskset node tee awk sed chmod tac printf; do
  src="$(command -v "$c" 2> /dev/null || true)"
  [[ -n "$src" && -x "$src" ]] && ln -sf "$src" "$TMP/bin/$c"
done
if command -v gdb > /dev/null 2>&1; then
  PATH="$TMP/bin" bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" \
    0123456789abcdef0123456789abcdef > /dev/null 2>&1
  check_eq "capture-fault.sh missing gdb (rc=4)" "4" "$?"
else
  ok "capture-fault.sh missing gdb (rc=4) [skipped: gdb absent anyway]"
fi

echo "== privileged companion script guards =="
bash "$REPO_ROOT/frequency-ab.sh" > /dev/null 2>&1
check_eq "frequency-ab.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/root-checks.sh" > /dev/null 2>&1
check_eq "root-checks.sh usage error (rc=2)" "2" "$?"
root_checks_usage_text="$(bash "$REPO_ROOT/root-checks.sh" --help 2>&1 || true)"
check_eq "root-checks.sh usage documents --fresh orphan recovery" "1" \
  "$(grep -q -- '--fresh' <<< "$root_checks_usage_text" && echo 1 || echo 0)"
check_eq "root-checks.sh staging no longer uses a random mktemp directory" "0" \
  "$(grep -c 'mktemp -d /tmp/root-checks' "$REPO_ROOT/root-checks.sh")"
check_eq "root-checks.sh derives the stage from the invoking uid and bundle hash" "1" \
  "$(grep -qF 'root-checks.${invoking_uid}.$(printf' "$REPO_ROOT/root-checks.sh" && echo 1 || echo 0)"

FREQUENCY_INITIAL="$TMP/frequency-initial-state"
mkdir -p "$FREQUENCY_INITIAL"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  printf '0\n' > "$FREQUENCY_INITIAL/no-turbo"
  value=""
  frequency_initial_no_turbo_read "$FREQUENCY_INITIAL/no-turbo" value
  [[ "$value" == 0 ]]
) > /dev/null 2>&1
check_eq "frequency A/B/A accepts canonical initial no_turbo=0" "0" "$?"

frequency_initial_invalid=1
for value in 01 '0 ' 2 ''; do
  printf '%s\n' "$value" > "$FREQUENCY_INITIAL/no-turbo"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    parsed=""
    frequency_initial_no_turbo_read "$FREQUENCY_INITIAL/no-turbo" parsed
  ) > /dev/null 2>&1 && frequency_initial_invalid=0
done
printf '0\n\n' > "$FREQUENCY_INITIAL/no-turbo"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  parsed=""
  frequency_initial_no_turbo_read "$FREQUENCY_INITIAL/no-turbo" parsed
) > /dev/null 2>&1 && frequency_initial_invalid=0
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  parsed=""
  frequency_initial_no_turbo_read "$FREQUENCY_INITIAL/missing" parsed
) > /dev/null 2>&1 && frequency_initial_invalid=0
printf '0\n' > "$FREQUENCY_INITIAL/no-turbo-target"
ln -s "$FREQUENCY_INITIAL/no-turbo-target" "$FREQUENCY_INITIAL/no-turbo-link"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  parsed=""
  frequency_initial_no_turbo_read "$FREQUENCY_INITIAL/no-turbo-link" parsed
) > /dev/null 2>&1 && frequency_initial_invalid=0
check_eq "frequency A/B/A rejects noncanonical or unsafe initial no_turbo sources" "1" "$frequency_initial_invalid"

printf '1\n' > "$FREQUENCY_INITIAL/no-turbo"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  recovery_order=""
  diag_recover_pending_restore() {
    recovery_order="${recovery_order}restore,"
    printf '0\n' > "$FREQUENCY_INITIAL/no-turbo"
  }
  frequency_recover_pending_outputs() { recovery_order="${recovery_order}stage,"; }
  parsed=""
  frequency_recover_prior_state
  frequency_validate_initial_no_turbo "$FREQUENCY_INITIAL/no-turbo" parsed
  [[ "$recovery_order" == "restore,stage," && "$parsed" == 0 ]]
) > /dev/null 2>&1
check_eq "frequency applicability is evaluated after durable recovery" "0" "$?"

frequency_recovery_line="$(awk '/frequency_recover_prior_state \|\| recovery_rc=/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_cap_semantic_line="$(awk '/diag_require_uint "--cap"/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_dependency_line="$(awk '/for dep in dd find node runuser setsid sha256sum sync taskset/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_bundle_gate_line="$(awk '/\[\[ -d "\$BUNDLE" \]\]/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_child_gate_line="$(awk '/^frequency_workload_script_available \|\|/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_no_turbo_gate_line="$(awk '/\[\[ -e "\$NO_TURBO_PATH" \]\]/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_legacy_gate_line="$(awk '/^LEGACY_RESTORE_FILE=/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_restore_rules_line="$(awk '/^declare -a restore_rules=/ { print NR; exit }' "$REPO_ROOT/frequency-ab.sh")"
frequency_ordering_ok=0
if [[ -n "$frequency_recovery_line" && -n "$frequency_cap_semantic_line" &&
  -n "$frequency_dependency_line" && -n "$frequency_bundle_gate_line" &&
  -n "$frequency_child_gate_line" && -n "$frequency_no_turbo_gate_line" &&
  -n "$frequency_legacy_gate_line" && -n "$frequency_restore_rules_line" ]] &&
  ((frequency_restore_rules_line < frequency_recovery_line &&
    frequency_recovery_line < frequency_cap_semantic_line &&
    frequency_recovery_line < frequency_dependency_line &&
    frequency_recovery_line < frequency_bundle_gate_line &&
    frequency_recovery_line < frequency_child_gate_line &&
    frequency_recovery_line < frequency_no_turbo_gate_line &&
    frequency_recovery_line < frequency_legacy_gate_line)); then
  frequency_ordering_ok=1
fi
check_eq "frequency restore/stage recovery precedes every new-run-only gate" "1" "$frequency_ordering_ok"

FREQUENCY_MISSING_PUBLISHER_DEP="$TMP/frequency-missing-publisher-dependency"
mkdir -m 0700 "$FREQUENCY_MISSING_PUBLISHER_DEP" \
  "$FREQUENCY_MISSING_PUBLISHER_DEP/stage" "$FREQUENCY_MISSING_PUBLISHER_DEP/state"
printf '/missing/recorded/bundle\n' > "$FREQUENCY_MISSING_PUBLISHER_DEP/state/output-stage.pending"
chmod 0600 "$FREQUENCY_MISSING_PUBLISHER_DEP/state/output-stage.pending"
printf 'pending\n' > "$FREQUENCY_MISSING_PUBLISHER_DEP/setting"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  INVOKING_UID="$(id -u)"
  INVOKING_GID="$(id -g)"
  FREQUENCY_STATE_UID="$INVOKING_UID"
  FREQUENCY_STATE_GID="$INVOKING_GID"
  FREQUENCY_STAGE_DIR="$FREQUENCY_MISSING_PUBLISHER_DEP/stage"
  FREQUENCY_STAGE_RECORD="$FREQUENCY_MISSING_PUBLISHER_DEP/state/output-stage.pending"
  BUNDLE="$FREQUENCY_MISSING_PUBLISHER_DEP/missing-requested-bundle"
  recovery_order=""
  diag_recover_pending_restore() {
    recovery_order="${recovery_order}restore,"
    printf 'restored\n' > "$FREQUENCY_MISSING_PUBLISHER_DEP/setting"
  }
  frequency_command_available() {
    recovery_order="${recovery_order}dependency-$1,"
    [[ "$1" != runuser ]]
  }
  recovery_rc=0
  frequency_recover_prior_state || recovery_rc=$?
  [[ "$recovery_rc" == 11 &&
    "$recovery_order" == "restore,dependency-dd,dependency-find,dependency-node,dependency-runuser," &&
    "$(cat "$FREQUENCY_MISSING_PUBLISHER_DEP/setting")" == restored &&
    -d "$FREQUENCY_STAGE_DIR" && -f "$FREQUENCY_STAGE_RECORD" ]] &&
    ! compgen -G "$FREQUENCY_MISSING_PUBLISHER_DEP/stage.unpublished.*" > /dev/null
) > /dev/null 2>&1
check_eq "settings restore precedes missing publisher dependencies and retains exact stage" "0" "$?"

(
  cd "$TMP"
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  frequency_workload_script_available && [[ "$PWD" != "$SCRIPT_DIR" ]]
) > /dev/null 2>&1
check_eq "frequency workload path is repository-absolute outside the checkout" "0" "$?"

printf '1\n' > "$FREQUENCY_INITIAL/no-turbo"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  diag_recover_pending_restore() { :; }
  frequency_recover_pending_outputs() { :; }
  parsed=""
  frequency_recover_prior_state
  frequency_validate_initial_no_turbo "$FREQUENCY_INITIAL/no-turbo" parsed
) > /dev/null 2>&1
check_eq "frequency A/B/A refuses an already disabled-turbo initial state" "13" "$?"

FREQUENCY_CAP_POLICY="$FREQUENCY_INITIAL/policy0"
mkdir -p "$FREQUENCY_CAP_POLICY"
printf '5500000\n' > "$FREQUENCY_CAP_POLICY/scaling_max_freq"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target="unexpected"
  saved="unexpected"
  frequency_validate_cap_target "" "$FREQUENCY_INITIAL/missing-policy" target saved
  [[ -z "$target" && -z "$saved" ]]
) > /dev/null 2>&1
check_eq "frequency A/B/A does not require a cpufreq policy without --cap" "0" "$?"

(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target=""
  saved=""
  frequency_validate_cap_target 4200000 "" target saved
) > /dev/null 2>&1
check_eq "frequency --cap refuses a missing cpufreq policy" "20" "$?"

(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target=""
  saved=""
  DIAG_RESTORE_RULES=(
    "$FREQUENCY_CAP_POLICY/scaling_max_freq" '^[0-9]+$'
  )
  frequency_validate_cap_target 4200000 "$FREQUENCY_CAP_POLICY" target saved
  [[ "$target" == "$FREQUENCY_CAP_POLICY/scaling_max_freq" && "$saved" == 5500000 ]]
) > /dev/null 2>&1
check_eq "frequency --cap accepts a safe allowlisted scaling_max_freq target" "0" "$?"

FREQUENCY_CAP_ALIAS_POLICY="$FREQUENCY_INITIAL/policy-alias"
mkdir -p "$FREQUENCY_CAP_ALIAS_POLICY"
ln -s "$FREQUENCY_CAP_POLICY/scaling_max_freq" "$FREQUENCY_CAP_ALIAS_POLICY/scaling_max_freq"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target=""
  saved=""
  DIAG_RESTORE_RULES=(
    "$FREQUENCY_CAP_POLICY/scaling_max_freq" '^[0-9]+$'
  )
  frequency_validate_cap_target 4200000 "$FREQUENCY_CAP_ALIAS_POLICY" target saved
  [[ "$target" == "$FREQUENCY_CAP_POLICY/scaling_max_freq" && "$saved" == 5500000 ]]
) > /dev/null 2>&1
check_eq "frequency --cap safely canonicalizes a scaling_max_freq symlink" "0" "$?"

FREQUENCY_CAP_MALFORMED_POLICY="$FREQUENCY_INITIAL/policy-malformed"
mkdir -p "$FREQUENCY_CAP_MALFORMED_POLICY"
printf '05500000\n' > "$FREQUENCY_CAP_MALFORMED_POLICY/scaling_max_freq"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target=""
  saved=""
  DIAG_RESTORE_RULES=(
    "$FREQUENCY_CAP_MALFORMED_POLICY/scaling_max_freq" '^[0-9]+$'
  )
  frequency_validate_cap_target 4200000 "$FREQUENCY_CAP_MALFORMED_POLICY" target saved
) > /dev/null 2>&1
check_eq "frequency --cap rejects a noncanonical saved scaling_max_freq value" "21" "$?"

(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  target=""
  saved=""
  DIAG_RESTORE_RULES=("$FREQUENCY_INITIAL/other-target" '^[0-9]+$')
  frequency_validate_cap_target 4200000 "$FREQUENCY_CAP_POLICY" target saved
) > /dev/null 2>&1
check_eq "frequency --cap rejects a scaling_max_freq target outside restore authority" "22" "$?"

(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  FREQUENCY_STAGE_DIR="$FREQUENCY_INITIAL/absent-new-stage"
  FREQUENCY_OUTPUT_CLEANUP_ARMED=0
  refusal_rc=0
  frequency_not_applicable "test refusal" > /dev/null 2>&1 || refusal_rc=$?
  publisher_called=0
  frequency_publish_outputs() { publisher_called=1; }
  diag_cleanup_artifacts > "$FREQUENCY_INITIAL/refusal-cleanup-output" 2>&1
  cleanup_output="$(cat "$FREQUENCY_INITIAL/refusal-cleanup-output")"
  [[ "$refusal_rc" == 4 && -z "$FREQUENCY_STAGE_DIR" && -z "$cleanup_output" &&
    "$publisher_called" == 0 && ! -e "$FREQUENCY_INITIAL/absent-new-stage" ]]
) > /dev/null 2>&1
check_eq "frequency applicability refusal creates and publishes no new stage" "0" "$?"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  FREQUENCY_STAGE_DIR="$FREQUENCY_INITIAL/absent-cap-stage"
  FREQUENCY_OUTPUT_CLEANUP_ARMED=0
  cap_rc=0
  target=""
  saved=""
  frequency_validate_cap_target 4200000 "" target saved || cap_rc=$?
  [[ "$cap_rc" == 20 ]] || exit 1
  refusal_rc=0
  frequency_not_applicable "cap target missing" > /dev/null 2>&1 || refusal_rc=$?
  publisher_called=0
  frequency_publish_outputs() { publisher_called=1; }
  diag_cleanup_artifacts > /dev/null 2>&1
  [[ "$refusal_rc" == 4 && -z "$FREQUENCY_STAGE_DIR" && "$publisher_called" == 0 &&
    ! -e "$FREQUENCY_INITIAL/absent-cap-stage" ]]
) > /dev/null 2>&1
check_eq "frequency --cap target refusal creates and publishes no new stage" "0" "$?"
(
  FREQUENCY_AB_SOURCE_ONLY=1
  source "$REPO_ROOT/frequency-ab.sh"
  control="$FREQUENCY_INITIAL/publish-control.meta"
  frequency_publish_control_write "$control" 0123456789abcdef0123456789abcdef 0
  [[ "$(stat -Lc '%a:%h' "$control")" == "600:1" ]] &&
    [[ "$(cat "$control")" == $'VERSION=1\nGENERATION=0123456789abcdef0123456789abcdef\nCAP_REQUESTED=0' ]]
) > /dev/null 2>&1
check_eq "frequency producer writes a strict private publication control" "0" "$?"
if ((EUID != 0)); then
  (cd "$REPO_ROOT" && bash ./frequency-ab.sh 19 1 "$TMP") > /dev/null 2>&1
  check_eq "frequency-ab.sh refuses non-root (rc=4)" "4" "$?"
  bash "$REPO_ROOT/root-checks.sh" "$TMP" > /dev/null 2>&1
  check_eq "root-checks.sh refuses non-root (rc=4)" "4" "$?"

  FREQUENCY_BUSY="$TMP/frequency-publisher-busy"
  mkdir -p "$FREQUENCY_BUSY/real/bundle"/{results,freq,state}
  ln -s "$FREQUENCY_BUSY/real" "$FREQUENCY_BUSY/alias"
  prepare_frequency_publish_stage "$FREQUENCY_BUSY/stage" 0
  printf 'old evidence\n' > "$FREQUENCY_BUSY/real/bundle/results/frequency-ab.tsv"
  printf 'old command\n' > "$FREQUENCY_BUSY/real/bundle/commands.log"
  touch "$FREQUENCY_BUSY/real/bundle/state/phase-frequency.done"
  write_derived_output_fixture "$FREQUENCY_BUSY/real/bundle"
  exec {frequency_busy_fd}< "$FREQUENCY_BUSY/real/bundle"
  flock -x "$frequency_busy_fd"
  bash "$LIB/publish-frequency-output.sh" \
    "$FREQUENCY_BUSY/stage" "$FREQUENCY_BUSY/alias/bundle" > /dev/null 2>&1
  frequency_busy_rc=$?
  frequency_busy_unchanged=0
  [[ $frequency_busy_rc -eq 75 ]] &&
    [[ "$(cat "$FREQUENCY_BUSY/real/bundle/results/frequency-ab.tsv")" == "old evidence" ]] &&
    [[ "$(cat "$FREQUENCY_BUSY/real/bundle/commands.log")" == "old command" ]] &&
    [[ -f "$FREQUENCY_BUSY/real/bundle/state/phase-frequency.done" ]] &&
    derived_outputs_present "$FREQUENCY_BUSY/real/bundle" &&
    [[ -f "$FREQUENCY_BUSY/stage/results/frequency-ab.tsv" ]] && frequency_busy_unchanged=1
  check_eq "busy frequency publisher returns 75 without mutating stage or bundle" "1" \
    "$frequency_busy_unchanged"
  flock -u "$frequency_busy_fd"
  exec {frequency_busy_fd}<&-
  bash "$LIB/publish-frequency-output.sh" \
    "$FREQUENCY_BUSY/stage" "$FREQUENCY_BUSY/alias/bundle" > /dev/null 2>&1
  frequency_busy_retry_rc=$?
  check_eq "frequency publication retries after the bundle lock is released" "1" \
    "$([[ $frequency_busy_retry_rc -eq 0 && ! -e "$FREQUENCY_BUSY/stage" && ! -e "$FREQUENCY_BUSY/real/bundle/state/phase-frequency.done" ]] && derived_outputs_absent "$FREQUENCY_BUSY/real/bundle" && echo 1 || echo 0)"

  PUBLISH_BUNDLE="$TMP/frequency-publish-bundle"
  PUBLISH_STAGE="$TMP/frequency-publish-stage"
  mkdir -p "$PUBLISH_BUNDLE/results" "$PUBLISH_BUNDLE/freq" "$PUBLISH_BUNDLE/state" \
    "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  chmod 0700 "$PUBLISH_STAGE" "$PUBLISH_STAGE/results" "$PUBLISH_STAGE/freq"
  printf 'old command\n' > "$PUBLISH_BUNDLE/commands.log"
  touch "$PUBLISH_BUNDLE/state/phase-frequency.done"
  write_derived_output_fixture "$PUBLISH_BUNDLE"
  printf 'safe derived victim\n' > "$TMP/frequency-derived-victim"
  rm -f "$PUBLISH_BUNDLE/privacy-review.txt"
  ln -s "$TMP/frequency-derived-victim" "$PUBLISH_BUNDLE/privacy-review.txt"
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
    derived_outputs_absent "$PUBLISH_BUNDLE" &&
    [[ "$(cat "$TMP/frequency-derived-victim")" == "safe derived victim" ]] &&
    [[ ! -e "$PUBLISH_STAGE" ]] && publish_safe=1
  check_eq "frequency publisher invalidates derived outputs before replacing evidence" "1" "$publish_safe"

  DERIVED_CRASH_BUNDLE="$TMP/frequency-derived-crash-bundle"
  DERIVED_CRASH_STAGE="$TMP/frequency-derived-crash-stage"
  mkdir -p "$DERIVED_CRASH_BUNDLE"/{results,freq,state}
  prepare_frequency_publish_stage "$DERIVED_CRASH_STAGE" 0
  printf 'old evidence\n' > "$DERIVED_CRASH_BUNDLE/results/frequency-ab.tsv"
  printf 'old command\n' > "$DERIVED_CRASH_BUNDLE/commands.log"
  touch "$DERIVED_CRASH_BUNDLE/state/phase-frequency.done"
  write_derived_output_fixture "$DERIVED_CRASH_BUNDLE"
  DIAG_TEST_PUBLISH_KILL_AFTER_MANIFEST_INVALIDATION=1 \
    bash "$LIB/publish-frequency-output.sh" "$DERIVED_CRASH_STAGE" "$DERIVED_CRASH_BUNDLE" \
    > /dev/null 2>&1
  derived_crash_rc=$?
  check_eq "post-manifest crash leaves evidence untouched behind an absent manifest" "1" \
    "$([[ $derived_crash_rc -ne 0 && ! -e "$DERIVED_CRASH_BUNDLE/manifest.txt" && -f "$DERIVED_CRASH_BUNDLE/privacy-review.txt" && -f "$DERIVED_CRASH_BUNDLE/results.json" && -f "$DERIVED_CRASH_BUNDLE/report.md" && "$(cat "$DERIVED_CRASH_BUNDLE/results/frequency-ab.tsv")" == "old evidence" && "$(cat "$DERIVED_CRASH_BUNDLE/commands.log")" == "old command" && -f "$DERIVED_CRASH_BUNDLE/state/phase-frequency.done" && -f "$DERIVED_CRASH_STAGE/results/frequency-ab.tsv" ]] && echo 1 || echo 0)"

  NO_CAP_BUNDLE="$TMP/frequency-no-cap-bundle"
  NO_CAP_STAGE="$TMP/frequency-no-cap-stage"
  mkdir -p "$NO_CAP_BUNDLE/results" "$NO_CAP_BUNDLE/freq" "$NO_CAP_BUNDLE/state"
  prepare_frequency_publish_stage "$NO_CAP_STAGE" 0
  printf 'old cap rows\n' > "$NO_CAP_BUNDLE/results/frequency-cap.tsv"
  printf 'old cap meta\n' > "$NO_CAP_BUNDLE/results/frequency-cap.meta"
  printf 'old cap method\n' > "$NO_CAP_BUNDLE/freq/freq-ab-cap.method"
  printf 'safe stale-cap victim\n' > "$TMP/frequency-stale-cap-victim"
  ln -s "$TMP/frequency-stale-cap-victim" "$NO_CAP_BUNDLE/freq/freq-ab-cap.samples"
  printf 'keep me\n' > "$NO_CAP_BUNDLE/results/unrelated.txt"
  touch "$NO_CAP_BUNDLE/state/phase-frequency.done"
  bash "$LIB/publish-frequency-output.sh" "$NO_CAP_STAGE" "$NO_CAP_BUNDLE" > /dev/null 2>&1
  no_cap_publish_rc=$?
  check_eq "explicit no-cap publication removes only stale cap artifacts" "1" \
    "$([[ $no_cap_publish_rc -eq 0 && ! -e "$NO_CAP_BUNDLE/results/frequency-cap.tsv" && ! -e "$NO_CAP_BUNDLE/results/frequency-cap.meta" && ! -e "$NO_CAP_BUNDLE/freq/freq-ab-cap.samples" && ! -e "$NO_CAP_BUNDLE/freq/freq-ab-cap.method" && "$(cat "$TMP/frequency-stale-cap-victim")" == "safe stale-cap victim" && "$(cat "$NO_CAP_BUNDLE/results/unrelated.txt")" == "keep me" && ! -e "$NO_CAP_BUNDLE/state/phase-frequency.done" && ! -e "$NO_CAP_STAGE" ]] && echo 1 || echo 0)"

  PRESERVE_CAP_BUNDLE="$TMP/frequency-preserve-cap-bundle"
  mkdir -p "$PRESERVE_CAP_BUNDLE/results" "$PRESERVE_CAP_BUNDLE/freq"
  printf 'old cap rows\n' > "$PRESERVE_CAP_BUNDLE/results/frequency-cap.tsv"
  CAP_REQUESTED_STAGE="$TMP/frequency-cap-requested-stage"
  prepare_frequency_publish_stage "$CAP_REQUESTED_STAGE" 1
  bash "$LIB/publish-frequency-output.sh" "$CAP_REQUESTED_STAGE" "$PRESERVE_CAP_BUNDLE" > /dev/null 2>&1
  cap_requested_publish_rc=$?
  LEGACY_STAGE="$TMP/frequency-legacy-publish-stage"
  prepare_frequency_publish_stage "$LEGACY_STAGE" 0
  rm -f "$LEGACY_STAGE/publish-control.meta"
  bash "$LIB/publish-frequency-output.sh" "$LEGACY_STAGE" "$PRESERVE_CAP_BUNDLE" > /dev/null 2>&1
  legacy_publish_rc=$?
  check_eq "cap-requested and legacy stages never delete absent cap artifacts" "1" \
    "$([[ $cap_requested_publish_rc -eq 0 && $legacy_publish_rc -eq 0 && "$(cat "$PRESERVE_CAP_BUNDLE/results/frequency-cap.tsv")" == "old cap rows" ]] && echo 1 || echo 0)"

  UNSAFE_CAP_BUNDLE="$TMP/frequency-unsafe-cap-bundle"
  UNSAFE_CAP_STAGE="$TMP/frequency-unsafe-cap-stage"
  mkdir -p "$UNSAFE_CAP_BUNDLE/results/frequency-cap.tsv" "$UNSAFE_CAP_BUNDLE/freq" \
    "$UNSAFE_CAP_BUNDLE/state"
  prepare_frequency_publish_stage "$UNSAFE_CAP_STAGE" 0
  printf 'old A/B/A evidence\n' > "$UNSAFE_CAP_BUNDLE/results/frequency-ab.tsv"
  touch "$UNSAFE_CAP_BUNDLE/state/phase-frequency.done"
  bash "$LIB/publish-frequency-output.sh" "$UNSAFE_CAP_STAGE" "$UNSAFE_CAP_BUNDLE" > /dev/null 2>&1
  unsafe_cap_publish_rc=$?
  check_eq "unsafe stale cap destination aborts before marker or evidence mutation" "1" \
    "$([[ $unsafe_cap_publish_rc -ne 0 && -f "$UNSAFE_CAP_BUNDLE/state/phase-frequency.done" && "$(cat "$UNSAFE_CAP_BUNDLE/results/frequency-ab.tsv")" == "old A/B/A evidence" && -f "$UNSAFE_CAP_STAGE/results/frequency-ab.tsv" && -d "$UNSAFE_CAP_BUNDLE/results/frequency-cap.tsv" ]] && echo 1 || echo 0)"

  MALFORMED_CONTROL_BUNDLE="$TMP/frequency-malformed-control-bundle"
  MALFORMED_CONTROL_STAGE="$TMP/frequency-malformed-control-stage"
  mkdir -p "$MALFORMED_CONTROL_BUNDLE/results" "$MALFORMED_CONTROL_BUNDLE/freq" \
    "$MALFORMED_CONTROL_BUNDLE/state"
  prepare_frequency_publish_stage "$MALFORMED_CONTROL_STAGE" 0
  printf 'CAP_REQUESTED=0\n' >> "$MALFORMED_CONTROL_STAGE/publish-control.meta"
  touch "$MALFORMED_CONTROL_BUNDLE/state/phase-frequency.done"
  write_derived_output_fixture "$MALFORMED_CONTROL_BUNDLE"
  bash "$LIB/publish-frequency-output.sh" "$MALFORMED_CONTROL_STAGE" "$MALFORMED_CONTROL_BUNDLE" > /dev/null 2>&1
  malformed_control_rc=$?
  check_eq "malformed staging preserves derived outputs, marker, and evidence" "1" \
    "$([[ $malformed_control_rc -ne 0 && -f "$MALFORMED_CONTROL_BUNDLE/state/phase-frequency.done" && -f "$MALFORMED_CONTROL_STAGE/results/frequency-ab.tsv" ]] && derived_outputs_present "$MALFORMED_CONTROL_BUNDLE" && [[ "$(cat "$MALFORMED_CONTROL_BUNDLE/manifest.txt")" == "stale manifest.txt" ]] && echo 1 || echo 0)"

  NONREPLACEABLE_DERIVED_BUNDLE="$TMP/frequency-nonreplaceable-derived-bundle"
  NONREPLACEABLE_DERIVED_STAGE="$TMP/frequency-nonreplaceable-derived-stage"
  mkdir -p "$NONREPLACEABLE_DERIVED_BUNDLE"/{results,freq,state}
  prepare_frequency_publish_stage "$NONREPLACEABLE_DERIVED_STAGE" 0
  printf 'old evidence\n' > "$NONREPLACEABLE_DERIVED_BUNDLE/results/frequency-ab.tsv"
  touch "$NONREPLACEABLE_DERIVED_BUNDLE/state/phase-frequency.done"
  write_derived_output_fixture "$NONREPLACEABLE_DERIVED_BUNDLE"
  rm -f "$NONREPLACEABLE_DERIVED_BUNDLE/report.md"
  mkdir "$NONREPLACEABLE_DERIVED_BUNDLE/report.md"
  bash "$LIB/publish-frequency-output.sh" \
    "$NONREPLACEABLE_DERIVED_STAGE" "$NONREPLACEABLE_DERIVED_BUNDLE" > /dev/null 2>&1
  nonreplaceable_derived_rc=$?
  check_eq "nonreplaceable derived output is rejected before manifest or evidence mutation" "1" \
    "$([[ $nonreplaceable_derived_rc -ne 0 && -f "$NONREPLACEABLE_DERIVED_BUNDLE/manifest.txt" && -d "$NONREPLACEABLE_DERIVED_BUNDLE/report.md" && "$(cat "$NONREPLACEABLE_DERIVED_BUNDLE/results/frequency-ab.tsv")" == "old evidence" && -f "$NONREPLACEABLE_DERIVED_BUNDLE/state/phase-frequency.done" && -f "$NONREPLACEABLE_DERIVED_STAGE/results/frequency-ab.tsv" ]] && echo 1 || echo 0)"

  UNSAFE_FREQUENCY_STATE="$TMP/frequency-unsafe-state-preflight"
  mkdir -p "$UNSAFE_FREQUENCY_STATE/bundle"/{results,freq} \
    "$UNSAFE_FREQUENCY_STATE/state-target"
  ln -s "$UNSAFE_FREQUENCY_STATE/state-target" "$UNSAFE_FREQUENCY_STATE/bundle/state"
  touch "$UNSAFE_FREQUENCY_STATE/state-target/phase-frequency.done"
  prepare_frequency_publish_stage "$UNSAFE_FREQUENCY_STATE/stage" 0
  write_derived_output_fixture "$UNSAFE_FREQUENCY_STATE/bundle"
  bash "$LIB/publish-frequency-output.sh" "$UNSAFE_FREQUENCY_STATE/stage" \
    "$UNSAFE_FREQUENCY_STATE/bundle" > /dev/null 2>&1
  unsafe_frequency_state_rc=$?
  check_eq "frequency directory and marker preflight precedes derived invalidation" "1" \
    "$([[ $unsafe_frequency_state_rc -ne 0 &&
      -f "$UNSAFE_FREQUENCY_STATE/state-target/phase-frequency.done" &&
      -f "$UNSAFE_FREQUENCY_STATE/stage/results/frequency-ab.tsv" ]] &&
      derived_outputs_present "$UNSAFE_FREQUENCY_STATE/bundle" && echo 1 || echo 0)"

  UNTERMINATED_CONTROL_BUNDLE="$TMP/frequency-unterminated-control-bundle"
  UNTERMINATED_CONTROL_STAGE="$TMP/frequency-unterminated-control-stage"
  mkdir -p "$UNTERMINATED_CONTROL_BUNDLE/results" "$UNTERMINATED_CONTROL_BUNDLE/freq" \
    "$UNTERMINATED_CONTROL_BUNDLE/state"
  prepare_frequency_publish_stage "$UNTERMINATED_CONTROL_STAGE" 0
  printf 'VERSION=1\nGENERATION=0123456789abcdef0123456789abcdef\nCAP_REQUESTED=0' \
    > "$UNTERMINATED_CONTROL_STAGE/publish-control.meta"
  touch "$UNTERMINATED_CONTROL_BUNDLE/state/phase-frequency.done"
  bash "$LIB/publish-frequency-output.sh" \
    "$UNTERMINATED_CONTROL_STAGE" "$UNTERMINATED_CONTROL_BUNDLE" > /dev/null 2>&1
  unterminated_control_rc=$?
  check_eq "unterminated publication control fails bounded preflight" "1" \
    "$([[ $unterminated_control_rc -ne 0 && -f "$UNTERMINATED_CONTROL_BUNDLE/state/phase-frequency.done" && -f "$UNTERMINATED_CONTROL_STAGE/results/frequency-ab.tsv" ]] && echo 1 || echo 0)"
  printf 'VERSION=1\nGENERATION=0123456789abcdef0123456789abcdef\nCAP_REQUESTED=0\0' \
    > "$UNTERMINATED_CONTROL_STAGE/publish-control.meta"
  bash "$LIB/publish-frequency-output.sh" \
    "$UNTERMINATED_CONTROL_STAGE" "$UNTERMINATED_CONTROL_BUNDLE" > /dev/null 2>&1
  nul_control_rc=$?
  check_eq "NUL-terminated 70-byte publication control fails canonical preflight" "1" \
    "$([[ $nul_control_rc -ne 0 && "$(stat -Lc '%s' "$UNTERMINATED_CONTROL_STAGE/publish-control.meta")" == 70 && -f "$UNTERMINATED_CONTROL_BUNDLE/state/phase-frequency.done" && -f "$UNTERMINATED_CONTROL_STAGE/results/frequency-ab.tsv" ]] && echo 1 || echo 0)"

  FREQUENCY_CONTROL_SNAPSHOT="$TMP/frequency-control-snapshot"
  mkdir -p "$FREQUENCY_CONTROL_SNAPSHOT/bundle"/{results,freq,state} \
    "$FREQUENCY_CONTROL_SNAPSHOT/fake-bin"
  prepare_frequency_publish_stage "$FREQUENCY_CONTROL_SNAPSHOT/stage" 0
  cp "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta" \
    "$FREQUENCY_CONTROL_SNAPSHOT/original-control.meta"
  touch "$FREQUENCY_CONTROL_SNAPSHOT/bundle/state/phase-frequency.done"
  write_derived_output_fixture "$FREQUENCY_CONTROL_SNAPSHOT/bundle"
  write_frequency_snapshot_node_wrapper "$FREQUENCY_CONTROL_SNAPSHOT/fake-bin/node"
  real_node_bin="$(command -v node)"
  PATH="$FREQUENCY_CONTROL_SNAPSHOT/fake-bin:$PATH" REAL_NODE_BIN="$real_node_bin" \
    SNAPSHOT_SOURCE="$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta" \
    SNAPSHOT_ONCE="$FREQUENCY_CONTROL_SNAPSHOT/control-mutated" SNAPSHOT_KIND=control \
    SNAPSHOT_REPLACEMENT=fifo timeout 10 bash "$LIB/publish-frequency-output.sh" \
    "$FREQUENCY_CONTROL_SNAPSHOT/stage" \
    "$FREQUENCY_CONTROL_SNAPSHOT/bundle" > /dev/null 2>&1
  control_snapshot_rc=$?
  control_snapshot_bounded=0
  [[ $control_snapshot_rc -ne 0 && $control_snapshot_rc -ne 124 &&
      -e "$FREQUENCY_CONTROL_SNAPSHOT/control-mutated" &&
      -p "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta" &&
      ! -e "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-journal.tsv" &&
      ! -e "$FREQUENCY_CONTROL_SNAPSHOT/bundle/.frequency-publish.pending" &&
      -f "$FREQUENCY_CONTROL_SNAPSHOT/bundle/state/phase-frequency.done" ]] &&
      derived_outputs_present "$FREQUENCY_CONTROL_SNAPSHOT/bundle" &&
      control_snapshot_bounded=1
  rm -f "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta"
  cp "$FREQUENCY_CONTROL_SNAPSHOT/original-control.meta" \
    "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta"
  chmod 0600 "$FREQUENCY_CONTROL_SNAPSHOT/stage/publish-control.meta"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_CONTROL_SNAPSHOT/stage" \
    "$FREQUENCY_CONTROL_SNAPSHOT/bundle" > /dev/null 2>&1
  control_snapshot_finish_rc=$?
  check_eq "fd-bound control parsing cannot be redirected to a replacement FIFO" "1" \
    "$([[ $control_snapshot_bounded -eq 1 && $control_snapshot_finish_rc -eq 0 &&
      ! -e "$FREQUENCY_CONTROL_SNAPSHOT/stage" ]] && echo 1 || echo 0)"

  FREQUENCY_JOURNAL_SNAPSHOT="$TMP/frequency-journal-snapshot"
  mkdir -p "$FREQUENCY_JOURNAL_SNAPSHOT/bundle"/{results,freq,state} \
    "$FREQUENCY_JOURNAL_SNAPSHOT/fake-bin"
  prepare_frequency_publish_stage "$FREQUENCY_JOURNAL_SNAPSHOT/stage" 0
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=journal-prepared \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_JOURNAL_SNAPSHOT/stage" \
    "$FREQUENCY_JOURNAL_SNAPSHOT/bundle" > /dev/null 2>&1
  journal_snapshot_kill_rc=$?
  write_frequency_snapshot_node_wrapper "$FREQUENCY_JOURNAL_SNAPSHOT/fake-bin/node"
  PATH="$FREQUENCY_JOURNAL_SNAPSHOT/fake-bin:$PATH" REAL_NODE_BIN="$real_node_bin" \
    SNAPSHOT_SOURCE="$FREQUENCY_JOURNAL_SNAPSHOT/stage/publish-journal.tsv" \
    SNAPSHOT_ONCE="$FREQUENCY_JOURNAL_SNAPSHOT/journal-mutated" SNAPSHOT_KIND=journal \
    SNAPSHOT_REPLACEMENT=symlink \
    SNAPSHOT_TARGET="$FREQUENCY_JOURNAL_SNAPSHOT/original-journal.tsv" \
    timeout 10 bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_JOURNAL_SNAPSHOT/stage" \
    "$FREQUENCY_JOURNAL_SNAPSHOT/bundle" > /dev/null 2>&1
  journal_snapshot_rc=$?
  journal_snapshot_bounded=0
  [[ $journal_snapshot_kill_rc -ne 0 && $journal_snapshot_rc -ne 0 &&
      $journal_snapshot_rc -ne 124 &&
      -e "$FREQUENCY_JOURNAL_SNAPSHOT/journal-mutated" &&
      -L "$FREQUENCY_JOURNAL_SNAPSHOT/stage/publish-journal.tsv" &&
      -f "$FREQUENCY_JOURNAL_SNAPSHOT/original-journal.tsv" &&
      -f "$FREQUENCY_JOURNAL_SNAPSHOT/bundle/.frequency-publish.pending/transaction.id" &&
      -f "$FREQUENCY_JOURNAL_SNAPSHOT/stage/results/frequency-ab.tsv" ]] &&
      journal_snapshot_bounded=1
  rm -f "$FREQUENCY_JOURNAL_SNAPSHOT/stage/publish-journal.tsv"
  mv -T "$FREQUENCY_JOURNAL_SNAPSHOT/original-journal.tsv" \
    "$FREQUENCY_JOURNAL_SNAPSHOT/stage/publish-journal.tsv"
  chmod 0600 "$FREQUENCY_JOURNAL_SNAPSHOT/stage/publish-journal.tsv"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_JOURNAL_SNAPSHOT/stage" \
    "$FREQUENCY_JOURNAL_SNAPSHOT/bundle" > /dev/null 2>&1
  journal_snapshot_finish_rc=$?
  check_eq "fd-bound journal parsing rejects pathname replacement without reopening it" "1" \
    "$([[ $journal_snapshot_bounded -eq 1 && $journal_snapshot_finish_rc -eq 0 &&
      ! -e "$FREQUENCY_JOURNAL_SNAPSHOT/stage" ]] && echo 1 || echo 0)"

  CAP_DELETE_BUNDLE="$TMP/frequency-cap-delete-retry-bundle"
  CAP_DELETE_STAGE="$TMP/frequency-cap-delete-retry-stage"
  mkdir -p "$CAP_DELETE_BUNDLE/results" "$CAP_DELETE_BUNDLE/freq" "$CAP_DELETE_BUNDLE/state"
  prepare_frequency_publish_stage "$CAP_DELETE_STAGE" 0
  for cap_file in results/frequency-cap.tsv results/frequency-cap.meta \
    freq/freq-ab-cap.samples freq/freq-ab-cap.method; do
    printf 'stale cap\n' > "$CAP_DELETE_BUNDLE/$cap_file"
  done
  touch "$CAP_DELETE_BUNDLE/state/phase-frequency.done"
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_CAP_DELETE=1 \
    bash "$LIB/publish-frequency-output.sh" "$CAP_DELETE_STAGE" "$CAP_DELETE_BUNDLE" \
    > /dev/null 2>&1
  cap_delete_kill_rc=$?
  cap_files_after_kill=0
  for cap_file in results/frequency-cap.tsv results/frequency-cap.meta \
    freq/freq-ab-cap.samples freq/freq-ab-cap.method; do
    [[ -e "$CAP_DELETE_BUNDLE/$cap_file" || -L "$CAP_DELETE_BUNDLE/$cap_file" ]] &&
      cap_files_after_kill=$((cap_files_after_kill + 1))
  done
  control_survived=0
  [[ -f "$CAP_DELETE_STAGE/publish-control.meta" ]] && control_survived=1
  bash "$LIB/publish-frequency-output.sh" "$CAP_DELETE_STAGE" "$CAP_DELETE_BUNDLE" > /dev/null 2>&1
  cap_delete_retry_rc=$?
  cap_files_after_retry=0
  for cap_file in results/frequency-cap.tsv results/frequency-cap.meta \
    freq/freq-ab-cap.samples freq/freq-ab-cap.method; do
    [[ -e "$CAP_DELETE_BUNDLE/$cap_file" || -L "$CAP_DELETE_BUNDLE/$cap_file" ]] &&
      cap_files_after_retry=$((cap_files_after_retry + 1))
  done
  check_eq "SIGKILL after one stale cap deletion retries from durable control" "1" \
    "$([[ $cap_delete_kill_rc -ne 0 && $cap_files_after_kill -eq 3 && $control_survived -eq 1 && ! -e "$CAP_DELETE_BUNDLE/state/phase-frequency.done" && $cap_delete_retry_rc -eq 0 && $cap_files_after_retry -eq 0 && ! -e "$CAP_DELETE_STAGE" ]] && echo 1 || echo 0)"

  FREQUENCY_TX_CUTS="$TMP/frequency-journal-cut-points"
  mkdir -p "$FREQUENCY_TX_CUTS"
  frequency_cut_points_ok=1
  for cut in derived-invalidated state-synced binding-pending work-ready \
    journal-prepared-pending journal-prepared commands-copying artifact-copying \
    first-artifact-installed \
    commands-published journal-committed-pending journal-committed \
    first-source-cleaned binding-removed first-stage-dir-removed journal-removed; do
    cut_root="$FREQUENCY_TX_CUTS/$cut"
    cut_stage="$cut_root/stage"
    cut_bundle="$cut_root/bundle"
    mkdir -p "$cut_bundle/results" "$cut_bundle/freq" "$cut_bundle/state"
    prepare_frequency_publish_stage "$cut_stage" 0
    printf 'old command\n' > "$cut_bundle/commands.log"
    printf 'old evidence\n' > "$cut_bundle/results/frequency-ab.tsv"
    touch "$cut_bundle/state/phase-frequency.done"
    write_derived_output_fixture "$cut_bundle"
    DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT="$cut" \
      bash "$LIB/publish-frequency-output.sh" "$cut_stage" "$cut_bundle" \
      > /dev/null 2>&1
    cut_kill_rc=$?
    if [[ $cut_kill_rc -eq 0 ]] ||
      compgen -G "$cut_bundle/.frequency-commands.*" > /dev/null; then
      frequency_cut_points_ok=0
      continue
    fi
    case "$cut" in
      derived-invalidated)
        derived_outputs_absent "$cut_bundle" &&
          [[ -f "$cut_bundle/state/phase-frequency.done" &&
          "$(cat "$cut_bundle/results/frequency-ab.tsv")" == 'old evidence' &&
          ! -e "$cut_stage/publish-journal.tsv" &&
          ! -e "$cut_bundle/.frequency-publish.pending" ]] ||
          frequency_cut_points_ok=0
        ;;
      state-synced)
        derived_outputs_absent "$cut_bundle" &&
          [[ ! -e "$cut_bundle/state/phase-frequency.done" &&
          ! -e "$cut_stage/publish-journal.tsv" &&
          ! -e "$cut_bundle/.frequency-publish.pending" ]] ||
          frequency_cut_points_ok=0
        ;;
      binding-pending)
        [[ ! -e "$cut_bundle/manifest.txt" &&
          ! -e "$cut_bundle/state/phase-frequency.done" &&
          ! -e "$cut_stage/publish-journal.tsv" &&
          -f "$cut_bundle/.frequency-publish.pending/transaction.id.pending" &&
          ! -e "$cut_bundle/.frequency-publish.pending/transaction.id" ]] ||
          frequency_cut_points_ok=0
        ;;
      work-ready)
        [[ ! -e "$cut_bundle/manifest.txt" &&
          ! -e "$cut_bundle/state/phase-frequency.done" &&
          ! -e "$cut_stage/publish-journal.tsv" &&
          -f "$cut_bundle/.frequency-publish.pending/transaction.id" ]] ||
          frequency_cut_points_ok=0
        ;;
      journal-prepared-pending)
        [[ ! -e "$cut_bundle/manifest.txt" &&
          ! -e "$cut_bundle/state/phase-frequency.done" &&
          ! -e "$cut_stage/publish-journal.tsv" &&
          -f "$cut_stage/publish-journal.pending" &&
          -f "$cut_bundle/.frequency-publish.pending/transaction.id" ]] ||
          frequency_cut_points_ok=0
        ;;
      journal-prepared)
        [[ ! -e "$cut_bundle/manifest.txt" &&
          ! -e "$cut_bundle/state/phase-frequency.done" &&
          -f "$cut_stage/publish-journal.tsv" &&
          -f "$cut_bundle/.frequency-publish.pending/transaction.id" ]] ||
          frequency_cut_points_ok=0
        ;;
      *)
        [[ ! -e "$cut_bundle/manifest.txt" &&
          ! -e "$cut_bundle/state/phase-frequency.done" ]] ||
          frequency_cut_points_ok=0
        ;;
    esac
    if [[ "$cut" == work-ready ]]; then
      printf 'wrong artifact candidate\n' \
        > "$cut_bundle/results/.artifact.frequency-ab.tsv.frequency-publish.pending"
      printf 'wrong command candidate\n' \
        > "$cut_bundle/.commands.log.frequency-publish.pending"
      chmod 0600 "$cut_bundle/results/.artifact.frequency-ab.tsv.frequency-publish.pending" \
        "$cut_bundle/.commands.log.frequency-publish.pending"
    fi
    if [[ "$cut" == artifact-copying &&
      ! -f "$cut_bundle/results/.artifact.frequency-ab.tsv.frequency-publish.pending.copying" ]]; then
      frequency_cut_points_ok=0
    fi
    bash "$LIB/publish-frequency-output.sh" "$cut_stage" "$cut_bundle" \
      > /dev/null 2>&1
    cut_retry_rc=$?
    if [[ $cut_retry_rc -ne 0 || -e "$cut_stage" ||
      -e "$cut_bundle/.frequency-publish.pending" ||
      -e "$cut_bundle/.commands.log.frequency-publish.pending" ||
      -e "$cut_bundle/results/.artifact.frequency-ab.tsv.frequency-publish.pending" ||
      -e "$cut_bundle/results/.artifact.frequency-ab.tsv.frequency-publish.pending.copying" ||
      "$(grep -c '^new command$' "$cut_bundle/commands.log")" != 1 ||
      "$(cat "$cut_bundle/results/frequency-ab.tsv")" != 'new A/B/A evidence' ]] ||
      ! derived_outputs_absent "$cut_bundle"; then
      frequency_cut_points_ok=0
    fi
  done
  check_eq "journaled frequency publication converges after every durable cut point" "1" \
    "$frequency_cut_points_ok"

  FREQUENCY_STATE_SYNC="$TMP/frequency-state-sync-failure"
  mkdir -p "$FREQUENCY_STATE_SYNC/bundle"/{results,freq,state} \
    "$FREQUENCY_STATE_SYNC/fake-bin"
  prepare_frequency_publish_stage "$FREQUENCY_STATE_SYNC/stage" 0
  printf 'old evidence\n' > "$FREQUENCY_STATE_SYNC/bundle/results/frequency-ab.tsv"
  touch "$FREQUENCY_STATE_SYNC/bundle/state/phase-frequency.done"
  write_derived_output_fixture "$FREQUENCY_STATE_SYNC/bundle"
  real_sync_bin="$(command -v sync)"
  cat > "$FREQUENCY_STATE_SYNC/fake-bin/sync" <<'EOF'
#!/usr/bin/env bash
last=""
for last in "$@"; do :; done
if [[ "$last" == "${FAIL_SYNC_PATH:-}" ]]; then exit 1; fi
exec "$REAL_SYNC_BIN" "$@"
EOF
  chmod 0700 "$FREQUENCY_STATE_SYNC/fake-bin/sync"
  PATH="$FREQUENCY_STATE_SYNC/fake-bin:$PATH" REAL_SYNC_BIN="$real_sync_bin" \
    FAIL_SYNC_PATH="$FREQUENCY_STATE_SYNC/bundle/state" \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_STATE_SYNC/stage" \
    "$FREQUENCY_STATE_SYNC/bundle" > /dev/null 2>&1
  frequency_state_sync_rc=$?
  state_sync_retained=0
  [[ $frequency_state_sync_rc -eq 1 &&
    ! -e "$FREQUENCY_STATE_SYNC/stage/publish-journal.tsv" &&
    ! -e "$FREQUENCY_STATE_SYNC/bundle/.frequency-publish.pending" &&
    ! -e "$FREQUENCY_STATE_SYNC/bundle/state/phase-frequency.done" &&
    "$(cat "$FREQUENCY_STATE_SYNC/bundle/results/frequency-ab.tsv")" == 'old evidence' ]] &&
    derived_outputs_absent "$FREQUENCY_STATE_SYNC/bundle" && state_sync_retained=1
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_STATE_SYNC/stage" \
    "$FREQUENCY_STATE_SYNC/bundle" > /dev/null 2>&1
  frequency_state_sync_retry_rc=$?
  check_eq "frequency marker unlink is directory-synced before fence or evidence mutation" "1" \
    "$([[ $state_sync_retained -eq 1 && $frequency_state_sync_retry_rc -eq 0 &&
      ! -e "$FREQUENCY_STATE_SYNC/stage" &&
      "$(cat "$FREQUENCY_STATE_SYNC/bundle/results/frequency-ab.tsv")" == 'new A/B/A evidence' ]] && echo 1 || echo 0)"

  FREQUENCY_PENDING_BINDING="$TMP/frequency-malformed-pending-binding"
  mkdir -p "$FREQUENCY_PENDING_BINDING/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_PENDING_BINDING/stage" 0
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=binding-pending \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_PENDING_BINDING/stage" \
    "$FREQUENCY_PENDING_BINDING/bundle" > /dev/null 2>&1
  pending_binding_kill_rc=$?
  cp "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending/transaction.id.pending" \
    "$FREQUENCY_PENDING_BINDING/original.pending"
  printf 'malformed pending binding\n' \
    > "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending/transaction.id.pending"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_PENDING_BINDING/stage" \
    "$FREQUENCY_PENDING_BINDING/bundle" > /dev/null 2>&1
  malformed_pending_rc=$?
  malformed_pending_preserved=0
  [[ $pending_binding_kill_rc -ne 0 && $malformed_pending_rc -eq 1 &&
    "$(cat "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending/transaction.id.pending")" == 'malformed pending binding' &&
    ! -e "$FREQUENCY_PENDING_BINDING/stage/publish-journal.tsv" &&
    -f "$FREQUENCY_PENDING_BINDING/stage/results/frequency-ab.tsv" ]] &&
    malformed_pending_preserved=1
  cp "$FREQUENCY_PENDING_BINDING/original.pending" \
    "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending/transaction.id.pending"
  chmod 0600 "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending/transaction.id.pending"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_PENDING_BINDING/stage" \
    "$FREQUENCY_PENDING_BINDING/bundle" > /dev/null 2>&1
  pending_binding_finish_rc=$?
  check_eq "frequency recovery preserves and rejects a noncanonical pending binding" "1" \
    "$([[ $malformed_pending_preserved -eq 1 && $pending_binding_finish_rc -eq 0 &&
      ! -e "$FREQUENCY_PENDING_BINDING/stage" &&
      ! -e "$FREQUENCY_PENDING_BINDING/bundle/.frequency-publish.pending" ]] && echo 1 || echo 0)"

  FREQUENCY_DEVICE_GUARD="$TMP/frequency-candidate-device-guard"
  mkdir -p "$FREQUENCY_DEVICE_GUARD/results"
  printf 'candidate\n' > "$FREQUENCY_DEVICE_GUARD/results/candidate"
  chmod 0600 "$FREQUENCY_DEVICE_GUARD/results/candidate"
  (
    source "$LIB/publish-frequency-transaction.sh"
    stat() {
      local last="${!#}"
      case "$last" in
        "$FREQUENCY_DEVICE_GUARD/results/candidate") printf '101\n' ;;
        "$FREQUENCY_DEVICE_GUARD/results") printf '202\n' ;;
        *) command stat "$@" ;;
      esac
    }
    frequency_tx_same_device "$FREQUENCY_DEVICE_GUARD/results/candidate" \
      "$FREQUENCY_DEVICE_GUARD/results/final"
  ) > /dev/null 2>&1
  frequency_device_guard_rc=$?
  check_eq "frequency candidate device guard rejects a cross-device publication" "1" \
    "$([[ $frequency_device_guard_rc -ne 0 &&
      "$(cat "$FREQUENCY_DEVICE_GUARD/results/candidate")" == candidate ]] && echo 1 || echo 0)"

  frequency_bounds_ok=1
  for bound_case in \
    'results/frequency-ab.meta:65537' \
    'results/frequency-ab.tsv:16777217' \
    'freq/freq-ab-A1.samples:67108865' \
    'commands.log:16777217'; do
    bound_rel="${bound_case%%:*}"
    bound_size="${bound_case#*:}"
    bound_root="$TMP/frequency-bound-${bound_rel//\//-}"
    mkdir -p "$bound_root/bundle"/{results,freq,state}
    prepare_frequency_publish_stage "$bound_root/stage" 0
    mkdir -p "$(dirname -- "$bound_root/stage/$bound_rel")"
    truncate -s "$bound_size" "$bound_root/stage/$bound_rel"
    chmod 0600 "$bound_root/stage/$bound_rel"
    touch "$bound_root/bundle/state/phase-frequency.done"
    write_derived_output_fixture "$bound_root/bundle"
    bash "$LIB/publish-frequency-output.sh" "$bound_root/stage" "$bound_root/bundle" \
      > /dev/null 2>&1
    bound_rc=$?
    if [[ $bound_rc -ne 76 || -e "$bound_root/stage/publish-journal.tsv" ||
      -e "$bound_root/bundle/.frequency-publish.pending" ]] ||
      ! derived_outputs_present "$bound_root/bundle" ||
      [[ ! -e "$bound_root/bundle/state/phase-frequency.done" ]]; then
      frequency_bounds_ok=0
    fi
  done
  check_eq "frequency publication enforces bounded artifact and command payloads" "1" \
    "$frequency_bounds_ok"

  FREQUENCY_UNKNOWN_STAGE="$TMP/frequency-unknown-stage-entry"
  FREQUENCY_UNKNOWN_BUNDLE="$TMP/frequency-unknown-stage-bundle"
  mkdir -p "$FREQUENCY_UNKNOWN_BUNDLE"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_UNKNOWN_STAGE" 0
  printf 'unknown\n' > "$FREQUENCY_UNKNOWN_STAGE/results/.unexpected"
  chmod 0600 "$FREQUENCY_UNKNOWN_STAGE/results/.unexpected"
  touch "$FREQUENCY_UNKNOWN_BUNDLE/state/phase-frequency.done"
  write_derived_output_fixture "$FREQUENCY_UNKNOWN_BUNDLE"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_UNKNOWN_STAGE" \
    "$FREQUENCY_UNKNOWN_BUNDLE" > /dev/null 2>&1
  frequency_unknown_rc=$?
  check_eq "frequency fixed-name inventory rejects unknown entries before journaling" "1" \
    "$([[ $frequency_unknown_rc -eq 76 &&
      ! -e "$FREQUENCY_UNKNOWN_STAGE/publish-journal.tsv" &&
      -e "$FREQUENCY_UNKNOWN_BUNDLE/state/phase-frequency.done" ]] &&
      derived_outputs_present "$FREQUENCY_UNKNOWN_BUNDLE" && echo 1 || echo 0)"

  FREQUENCY_FIND_FAIL="$TMP/frequency-find-failure"
  mkdir -p "$FREQUENCY_FIND_FAIL/bundle"/{results,freq,state} \
    "$FREQUENCY_FIND_FAIL/fake-bin"
  prepare_frequency_publish_stage "$FREQUENCY_FIND_FAIL/stage" 0
  printf '#!/usr/bin/env bash\nexit 1\n' > "$FREQUENCY_FIND_FAIL/fake-bin/find"
  chmod 0700 "$FREQUENCY_FIND_FAIL/fake-bin/find"
  touch "$FREQUENCY_FIND_FAIL/bundle/state/phase-frequency.done"
  write_derived_output_fixture "$FREQUENCY_FIND_FAIL/bundle"
  PATH="$FREQUENCY_FIND_FAIL/fake-bin:$PATH" \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_FIND_FAIL/stage" \
    "$FREQUENCY_FIND_FAIL/bundle" > /dev/null 2>&1
  frequency_find_fail_rc=$?
  check_eq "frequency inventory find failure is checked before journaling" "1" \
    "$([[ $frequency_find_fail_rc -eq 76 &&
      ! -e "$FREQUENCY_FIND_FAIL/stage/publish-journal.tsv" &&
      -e "$FREQUENCY_FIND_FAIL/bundle/state/phase-frequency.done" ]] &&
      derived_outputs_present "$FREQUENCY_FIND_FAIL/bundle" && echo 1 || echo 0)"

  FREQUENCY_FIFO_STAGE="$TMP/frequency-nonblocking-stage"
  FREQUENCY_FIFO_BUNDLE="$TMP/frequency-nonblocking-bundle"
  mkdir -p "$FREQUENCY_FIFO_BUNDLE"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_FIFO_STAGE" 0
  rm -f "$FREQUENCY_FIFO_STAGE/results/frequency-ab.tsv"
  mkfifo "$FREQUENCY_FIFO_STAGE/results/frequency-ab.tsv"
  chmod 0600 "$FREQUENCY_FIFO_STAGE/results/frequency-ab.tsv"
  timeout 5 bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_FIFO_STAGE" \
    "$FREQUENCY_FIFO_BUNDLE" > /dev/null 2>&1
  frequency_fifo_rc=$?
  check_eq "frequency publisher rejects special staged sources without blocking" "1" \
    "$([[ $frequency_fifo_rc -eq 76 &&
      ! -e "$FREQUENCY_FIFO_STAGE/publish-journal.tsv" ]] && echo 1 || echo 0)"

  FREQUENCY_IO_HELPER="$TMP/frequency-io-helper"
  mkdir -p "$FREQUENCY_IO_HELPER"
  printf 'stable source\n' > "$FREQUENCY_IO_HELPER/source"
  frequency_io_copy_output="$(node "$LIB/publish-frequency-io.mjs" copy \
    "$FREQUENCY_IO_HELPER/source" "$FREQUENCY_IO_HELPER/copy" 64)"
  frequency_io_copy_rc=$?
  mkfifo "$FREQUENCY_IO_HELPER/fifo"
  timeout 5 node "$LIB/publish-frequency-io.mjs" hash \
    "$FREQUENCY_IO_HELPER/fifo" 64 > /dev/null 2>&1
  frequency_io_fifo_hash_rc=$?
  timeout 5 node "$LIB/publish-frequency-io.mjs" copy \
    "$FREQUENCY_IO_HELPER/fifo" "$FREQUENCY_IO_HELPER/fifo-copy" 64 > /dev/null 2>&1
  frequency_io_fifo_copy_rc=$?
  timeout 5 node "$LIB/publish-frequency-io.mjs" control \
    "$FREQUENCY_IO_HELPER/fifo" > /dev/null 2>&1
  frequency_io_fifo_control_rc=$?
  timeout 5 node "$LIB/publish-frequency-io.mjs" journal \
    "$FREQUENCY_IO_HELPER/fifo" > /dev/null 2>&1
  frequency_io_fifo_journal_rc=$?
  frequency_io_expected_sha="$(sha256sum "$FREQUENCY_IO_HELPER/source")"
  frequency_io_expected_sha="${frequency_io_expected_sha%% *}"
  check_eq "fd-bound frequency I/O reports exact copy size and rejects FIFOs without blocking" "1" \
    "$([[ $frequency_io_copy_rc -eq 0 &&
      "$frequency_io_copy_output" == $'14\t'"$frequency_io_expected_sha" &&
      "$(stat -Lc '%s:%a:%h' "$FREQUENCY_IO_HELPER/copy")" == '14:600:1' &&
      $frequency_io_fifo_hash_rc -ne 0 && $frequency_io_fifo_hash_rc -ne 124 &&
      $frequency_io_fifo_copy_rc -ne 0 && $frequency_io_fifo_copy_rc -ne 124 &&
      $frequency_io_fifo_control_rc -ne 0 && $frequency_io_fifo_control_rc -ne 124 &&
      $frequency_io_fifo_journal_rc -ne 0 && $frequency_io_fifo_journal_rc -ne 124 &&
      ! -e "$FREQUENCY_IO_HELPER/fifo-copy" ]] && echo 1 || echo 0)"

  FREQUENCY_TX_TAMPER="$TMP/frequency-journal-third-value"
  mkdir -p "$FREQUENCY_TX_TAMPER/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_TX_TAMPER/stage" 0
  printf 'old evidence\n' > "$FREQUENCY_TX_TAMPER/bundle/results/frequency-ab.tsv"
  printf 'old command\n' > "$FREQUENCY_TX_TAMPER/bundle/commands.log"
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=first-artifact-installed \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_TAMPER/stage" \
    "$FREQUENCY_TX_TAMPER/bundle" > /dev/null 2>&1
  frequency_tamper_kill_rc=$?
  printf 'third value\n' > "$FREQUENCY_TX_TAMPER/bundle/results/frequency-ab.tsv"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_TAMPER/stage" \
    "$FREQUENCY_TX_TAMPER/bundle" > /dev/null 2>&1
  frequency_tamper_first_rc=$?
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_TAMPER/stage" \
    "$FREQUENCY_TX_TAMPER/bundle" > /dev/null 2>&1
  frequency_tamper_second_rc=$?
  frequency_tamper_retained=0
  [[ $frequency_tamper_kill_rc -ne 0 && $frequency_tamper_first_rc -eq 1 &&
    $frequency_tamper_second_rc -eq 1 &&
    -f "$FREQUENCY_TX_TAMPER/stage/publish-journal.tsv" &&
    -f "$FREQUENCY_TX_TAMPER/stage/results/frequency-ab.tsv" &&
    "$(cat "$FREQUENCY_TX_TAMPER/bundle/results/frequency-ab.tsv")" == 'third value' ]] &&
    frequency_tamper_retained=1
  cp "$FREQUENCY_TX_TAMPER/stage/results/frequency-ab.tsv" \
    "$FREQUENCY_TX_TAMPER/bundle/results/frequency-ab.tsv"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_TAMPER/stage" \
    "$FREQUENCY_TX_TAMPER/bundle" > /dev/null 2>&1
  frequency_tamper_repair_rc=$?
  check_eq "journal rejects repeatable third-value tamper then resumes from matching new evidence" "1" \
    "$([[ $frequency_tamper_retained -eq 1 && $frequency_tamper_repair_rc -eq 0 &&
      ! -e "$FREQUENCY_TX_TAMPER/stage" &&
      "$(grep -c '^new command$' "$FREQUENCY_TX_TAMPER/bundle/commands.log")" == 1 ]] && echo 1 || echo 0)"

  FREQUENCY_TX_COMMITTED="$TMP/frequency-journal-committed-cleanup"
  mkdir -p "$FREQUENCY_TX_COMMITTED/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_TX_COMMITTED/stage" 0
  printf 'old command\n' > "$FREQUENCY_TX_COMMITTED/bundle/commands.log"
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=journal-committed \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_COMMITTED/stage" \
    "$FREQUENCY_TX_COMMITTED/bundle" > /dev/null 2>&1
  committed_kill_rc=$?
  printf 'post-commit writer\n' >> "$FREQUENCY_TX_COMMITTED/bundle/commands.log"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_COMMITTED/stage" \
    "$FREQUENCY_TX_COMMITTED/bundle" > /dev/null 2>&1
  committed_cleanup_rc=$?
  check_eq "COMMITTED retry performs cleanup only without revalidating or appending commands" "1" \
    "$([[ $committed_kill_rc -ne 0 && $committed_cleanup_rc -eq 0 &&
      ! -e "$FREQUENCY_TX_COMMITTED/stage" &&
      ! -e "$FREQUENCY_TX_COMMITTED/bundle/.frequency-publish.pending" &&
      "$(grep -c '^new command$' "$FREQUENCY_TX_COMMITTED/bundle/commands.log")" == 1 &&
      "$(grep -c '^post-commit writer$' "$FREQUENCY_TX_COMMITTED/bundle/commands.log")" == 1 ]] && echo 1 || echo 0)"

  FREQUENCY_FOREIGN_FENCE="$TMP/frequency-foreign-generation-fence"
  mkdir -p "$FREQUENCY_FOREIGN_FENCE/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_FOREIGN_FENCE/stage" 0
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=journal-committed \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_FOREIGN_FENCE/stage" \
    "$FREQUENCY_FOREIGN_FENCE/bundle" > /dev/null 2>&1
  foreign_fence_kill_rc=$?
  cp "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id" \
    "$FREQUENCY_FOREIGN_FENCE/original-transaction.id"
  foreign_bundle_id="$(stat -Lc '%d:%i' "$FREQUENCY_FOREIGN_FENCE/bundle")"
  printf 'TRANSACTION\tffffffffffffffffffffffffffffffff\nBUNDLE_ID\t%s\n' \
    "$foreign_bundle_id" \
    > "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id"
  printf 'foreign candidate\n' \
    > "$FREQUENCY_FOREIGN_FENCE/bundle/.commands.log.frequency-publish.pending"
  chmod 0600 "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id" \
    "$FREQUENCY_FOREIGN_FENCE/bundle/.commands.log.frequency-publish.pending"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_FOREIGN_FENCE/stage" \
    "$FREQUENCY_FOREIGN_FENCE/bundle" > /dev/null 2>&1
  foreign_fence_retry_rc=$?
  foreign_fence_preserved=0
  [[ $foreign_fence_kill_rc -ne 0 && $foreign_fence_retry_rc -eq 1 &&
    "$(sed -n 's/^TRANSACTION\t//p' "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id")" == ffffffffffffffffffffffffffffffff &&
    "$(cat "$FREQUENCY_FOREIGN_FENCE/bundle/.commands.log.frequency-publish.pending")" == 'foreign candidate' &&
    -f "$FREQUENCY_FOREIGN_FENCE/stage/publish-journal.tsv" &&
    -f "$FREQUENCY_FOREIGN_FENCE/stage/results/frequency-ab.tsv" ]] &&
    foreign_fence_preserved=1
  cp "$FREQUENCY_FOREIGN_FENCE/original-transaction.id" \
    "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id"
  chmod 0600 "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending/transaction.id"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_FOREIGN_FENCE/stage" \
    "$FREQUENCY_FOREIGN_FENCE/bundle" > /dev/null 2>&1
  foreign_fence_finish_rc=$?
  check_eq "COMMITTED cleanup preserves a foreign generation fence and its candidates" "1" \
    "$([[ $foreign_fence_preserved -eq 1 && $foreign_fence_finish_rc -eq 0 &&
      ! -e "$FREQUENCY_FOREIGN_FENCE/stage" &&
      ! -e "$FREQUENCY_FOREIGN_FENCE/bundle/.frequency-publish.pending" ]] && echo 1 || echo 0)"

  FREQUENCY_TX_RETRYABLE="$TMP/frequency-journal-retryable-validation"
  mkdir -p "$FREQUENCY_TX_RETRYABLE/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_TX_RETRYABLE/stage" 0
  DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT=journal-prepared \
    bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_RETRYABLE/stage" \
    "$FREQUENCY_TX_RETRYABLE/bundle" > /dev/null 2>&1
  retryable_kill_rc=$?
  chmod 0755 "$FREQUENCY_TX_RETRYABLE/stage"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_RETRYABLE/stage" \
    "$FREQUENCY_TX_RETRYABLE/bundle" > /dev/null 2>&1
  retryable_validation_rc=$?
  retryable_retained=0
  [[ $retryable_kill_rc -ne 0 && $retryable_validation_rc -eq 1 &&
    -f "$FREQUENCY_TX_RETRYABLE/stage/publish-journal.tsv" &&
    -f "$FREQUENCY_TX_RETRYABLE/bundle/.frequency-publish.pending/transaction.id" ]] &&
    retryable_retained=1
  chmod 0700 "$FREQUENCY_TX_RETRYABLE/stage"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_RETRYABLE/stage" \
    "$FREQUENCY_TX_RETRYABLE/bundle" > /dev/null 2>&1
  retryable_finish_rc=$?
  check_eq "post-journal validation failures stay retryable and retain the exact transaction" "1" \
    "$([[ $retryable_retained -eq 1 && $retryable_finish_rc -eq 0 &&
      ! -e "$FREQUENCY_TX_RETRYABLE/stage" &&
      ! -e "$FREQUENCY_TX_RETRYABLE/bundle/.frequency-publish.pending" ]] && echo 1 || echo 0)"

  FREQUENCY_TX_PARENT="$TMP/frequency-nonwritable-parent"
  FREQUENCY_TX_PARENT_STAGE="$TMP/frequency-nonwritable-parent-stage"
  mkdir -p "$FREQUENCY_TX_PARENT/bundle"/{results,freq,state}
  prepare_frequency_publish_stage "$FREQUENCY_TX_PARENT_STAGE" 0
  chmod 0555 "$FREQUENCY_TX_PARENT"
  bash "$LIB/publish-frequency-output.sh" "$FREQUENCY_TX_PARENT_STAGE" \
    "$FREQUENCY_TX_PARENT/bundle" > /dev/null 2>&1
  nonwritable_parent_rc=$?
  chmod 0700 "$FREQUENCY_TX_PARENT"
  check_eq "frequency transaction needs only bundle write access, not parent write access" "1" \
    "$([[ $nonwritable_parent_rc -eq 0 && ! -e "$FREQUENCY_TX_PARENT_STAGE" &&
      ! -e "$FREQUENCY_TX_PARENT/bundle/.frequency-publish.pending" ]] && echo 1 || echo 0)"

  FREQUENCY_FENCE_BUNDLE="$TMP/frequency-publisher-fence-resume"
  cp -a "$CPU_POLICY_RB" "$FREQUENCY_FENCE_BUNDLE"
  mkdir -m 0700 "$FREQUENCY_FENCE_BUNDLE/.frequency-publish.pending"
  frequency_fence_output="$(
    "$REPO_ROOT/diagnose.sh" --resume "$FREQUENCY_FENCE_BUNDLE" --dry-run --yes 2>&1
  )"
  frequency_fence_rc=$?
  check_eq "diagnose refuses a bundle fenced by a frequency publication" "1" \
    "$([[ $frequency_fence_rc -ne 0 && "$frequency_fence_output" == *'frequency publication transaction is pending'* ]] && echo 1 || echo 0)"

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

  BUSY_RECOVERY="$TMP/frequency-busy-stage-recovery"
  mkdir -p "$BUSY_RECOVERY/state" "$BUSY_RECOVERY/old-bundle" \
    "$BUSY_RECOVERY/current-bundle"
  prepare_frequency_publish_stage "$BUSY_RECOVERY/stage" 0
  write_derived_output_fixture "$BUSY_RECOVERY/old-bundle"
  exec {busy_recovery_fd}< "$BUSY_RECOVERY/old-bundle"
  flock -x "$busy_recovery_fd"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    unset FREQUENCY_AB_SOURCE_ONLY
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    FREQUENCY_STATE_UID="$INVOKING_UID"
    FREQUENCY_STATE_GID="$INVOKING_GID"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$BUSY_RECOVERY/stage"
    FREQUENCY_STAGE_RECORD="$BUSY_RECOVERY/state/output-stage.pending"
    BUNDLE="$BUSY_RECOVERY/current-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    diag_recover_pending_restore() { :; }
    frequency_stage_record_write "$BUSY_RECOVERY/old-bundle"
    frequency_recover_prior_state
  ) > /dev/null 2>&1
  busy_recovery_rc=$?
  flock -u "$busy_recovery_fd"
  exec {busy_recovery_fd}<&-
  check_eq "busy frequency recovery retains its exact stage and record for retry" "1" \
    "$([[ $busy_recovery_rc -eq 75 && -f "$BUSY_RECOVERY/stage/results/frequency-ab.tsv" && -f "$BUSY_RECOVERY/state/output-stage.pending" ]] && derived_outputs_present "$BUSY_RECOVERY/old-bundle" && ! compgen -G "$BUSY_RECOVERY/stage.unpublished.*" > /dev/null && echo 1 || echo 0)"

  MISSING_DEST_RECOVERY="$TMP/frequency-missing-recorded-destination"
  mkdir -p "$MISSING_DEST_RECOVERY/state"
  prepare_frequency_publish_stage "$MISSING_DEST_RECOVERY/stage" 0
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    FREQUENCY_STATE_UID="$INVOKING_UID"
    FREQUENCY_STATE_GID="$INVOKING_GID"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$MISSING_DEST_RECOVERY/stage"
    FREQUENCY_STAGE_RECORD="$MISSING_DEST_RECOVERY/state/output-stage.pending"
    BUNDLE="$MISSING_DEST_RECOVERY/missing-requested-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    frequency_stage_record_write "$MISSING_DEST_RECOVERY/recorded-bundle"
    recovery_rc=0
    frequency_recover_prior_state || recovery_rc=$?
    [[ "$recovery_rc" == 11 && "$BUNDLE" == "$MISSING_DEST_RECOVERY/missing-requested-bundle" ]]
  ) > /dev/null 2>&1
  missing_dest_first_rc=$?
  missing_dest_retained=0
  [[ $missing_dest_first_rc -eq 0 &&
    -f "$MISSING_DEST_RECOVERY/stage/results/frequency-ab.tsv" &&
    -f "$MISSING_DEST_RECOVERY/state/output-stage.pending" ]] &&
    ! compgen -G "$MISSING_DEST_RECOVERY/stage.unpublished.*" > /dev/null &&
    missing_dest_retained=1
  mkdir -p "$MISSING_DEST_RECOVERY/recorded-bundle"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    FREQUENCY_STATE_UID="$INVOKING_UID"
    FREQUENCY_STATE_GID="$INVOKING_GID"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$MISSING_DEST_RECOVERY/stage"
    FREQUENCY_STAGE_RECORD="$MISSING_DEST_RECOVERY/state/output-stage.pending"
    BUNDLE="$MISSING_DEST_RECOVERY/still-missing-requested-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    frequency_recover_prior_state
    [[ "$BUNDLE" == "$MISSING_DEST_RECOVERY/still-missing-requested-bundle" ]]
  ) > /dev/null 2>&1
  missing_dest_retry_rc=$?
  check_eq "missing recorded destination retains exact stage then publishes before bad requested-bundle gates" "1" \
    "$([[ $missing_dest_retained -eq 1 && $missing_dest_retry_rc -eq 0 &&
      ! -e "$MISSING_DEST_RECOVERY/stage" &&
      ! -e "$MISSING_DEST_RECOVERY/state/output-stage.pending" &&
      -f "$MISSING_DEST_RECOVERY/recorded-bundle/results/frequency-ab.tsv" ]] && echo 1 || echo 0)"

  MALFORMED_RECOVERY="$TMP/frequency-malformed-stage-recovery"
  mkdir -p "$MALFORMED_RECOVERY/state" "$MALFORMED_RECOVERY/recorded-bundle"
  prepare_frequency_publish_stage "$MALFORMED_RECOVERY/stage" 0
  printf 'malformed\n' > "$MALFORMED_RECOVERY/stage/publish-control.meta"
  chmod 0600 "$MALFORMED_RECOVERY/stage/publish-control.meta"
  (
    FREQUENCY_AB_SOURCE_ONLY=1
    source "$REPO_ROOT/frequency-ab.sh"
    INVOKING_UID="$(id -u)"
    INVOKING_GID="$(id -g)"
    FREQUENCY_STATE_UID="$INVOKING_UID"
    FREQUENCY_STATE_GID="$INVOKING_GID"
    SUDO_USER="$(id -un)"
    FREQUENCY_STAGE_DIR="$MALFORMED_RECOVERY/stage"
    FREQUENCY_STAGE_RECORD="$MALFORMED_RECOVERY/state/output-stage.pending"
    BUNDLE="$MALFORMED_RECOVERY/requested-bundle"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    frequency_stage_record_write "$MALFORMED_RECOVERY/recorded-bundle"
    frequency_recover_prior_state
  ) > /dev/null 2>&1
  malformed_recovery_rc=$?
  check_eq "malformed recorded staging is quarantined instead of retried" "1" \
    "$([[ $malformed_recovery_rc -eq 0 &&
      ! -e "$MALFORMED_RECOVERY/stage" &&
      ! -e "$MALFORMED_RECOVERY/state/output-stage.pending" ]] &&
      compgen -G "$MALFORMED_RECOVERY/stage.unpublished.*" > /dev/null && echo 1 || echo 0)"

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
  ok "busy frequency publisher returns 75 without mutating stage or bundle [skipped while tests run as root]"
  ok "frequency publication retries after the bundle lock is released [skipped while tests run as root]"
  ok "frequency publisher invalidates derived outputs before replacing evidence [skipped while tests run as root]"
  ok "post-manifest crash leaves evidence untouched behind an absent manifest [skipped while tests run as root]"
  ok "malformed staging preserves derived outputs, marker, and evidence [skipped while tests run as root]"
  ok "nonreplaceable derived output is rejected before manifest or evidence mutation [skipped while tests run as root]"
  ok "unprivileged frequency publisher rejects a command-log symlink [skipped while tests run as root]"
  ok "frequency publisher aborts before artifact moves when marker invalidation fails [skipped while tests run as root]"
  ok "killed mixed-generation publish cannot satisfy assessFrequencyAb [skipped while tests run as root]"
  ok "next invocation publishes SIGKILL-stranded frequency staging [skipped while tests run as root]"
  ok "busy frequency recovery retains its exact stage and record for retry [skipped while tests run as root]"
  ok "frequency staging record rejects control-character ambiguity [skipped while tests run as root]"
  ok "unrecorded deterministic stage is explicitly handed off [skipped while tests run as root]"
  ok "journaled frequency publication converges after every durable cut point [skipped while tests run as root]"
  ok "journal rejects repeatable third-value tamper then resumes from matching new evidence [skipped while tests run as root]"
  ok "COMMITTED retry performs cleanup only without revalidating or appending commands [skipped while tests run as root]"
  ok "post-journal validation failures stay retryable and retain the exact transaction [skipped while tests run as root]"
  ok "frequency transaction needs only bundle write access, not parent write access [skipped while tests run as root]"
  ok "diagnose refuses a bundle fenced by a frequency publication [skipped while tests run as root]"
fi

if ((EUID != 0)); then
  root_publish_stage_prepare() {
    local stage="$1" generation="${2:-0123456789abcdef0123456789abcdef}" name
    mkdir -p "$stage"
    chmod 0700 "$stage"
    for name in kernel-warnings.txt intel-undervolt.txt cctk.txt turbostat.txt; do
      printf 'staged %s\n' "$name" > "$stage/$name"
    done
    seal_root_checks_fixture "$stage" "$generation"
    chmod 0600 "$stage"/*
  }

  ROOT_BUSY="$TMP/root-checks-publisher-busy"
  root_publish_stage_prepare "$ROOT_BUSY/stage"
  mkdir -p "$ROOT_BUSY/real/bundle/env/root"
  ln -s "$ROOT_BUSY/real" "$ROOT_BUSY/alias"
  printf 'old root evidence\n' > "$ROOT_BUSY/real/bundle/env/root/cctk.txt"
  write_derived_output_fixture "$ROOT_BUSY/real/bundle"
  exec {root_busy_fd}< "$ROOT_BUSY/real/bundle"
  flock -x "$root_busy_fd"
  bash "$LIB/publish-root-checks-output.sh" \
    "$ROOT_BUSY/stage" "$ROOT_BUSY/alias/bundle" > /dev/null 2>&1
  root_busy_rc=$?
  root_busy_unchanged=0
  [[ $root_busy_rc -eq 75 ]] &&
    [[ "$(cat "$ROOT_BUSY/real/bundle/env/root/cctk.txt")" == "old root evidence" ]] &&
    derived_outputs_present "$ROOT_BUSY/real/bundle" &&
    [[ -f "$ROOT_BUSY/stage/cctk.txt" && -f "$ROOT_BUSY/stage/root-checks.meta" ]] &&
    root_busy_unchanged=1
  check_eq "busy root-checks publisher returns 75 without mutating stage or bundle" "1" \
    "$root_busy_unchanged"
  flock -u "$root_busy_fd"
  exec {root_busy_fd}<&-
  bash "$LIB/publish-root-checks-output.sh" \
    "$ROOT_BUSY/stage" "$ROOT_BUSY/alias/bundle" > /dev/null 2>&1
  root_busy_retry_rc=$?
  check_eq "root-check publication retries after the bundle lock is released" "1" \
    "$([[ $root_busy_retry_rc -eq 0 && ! -e "$ROOT_BUSY/stage" ]] && derived_outputs_absent "$ROOT_BUSY/real/bundle" && node "$LIB/root-checks-evidence.mjs" --validate-complete "$ROOT_BUSY/real/bundle" > /dev/null 2>&1 && echo 1 || echo 0)"

  ROOT_FREQUENCY_FENCE="$TMP/root-checks-frequency-fence"
  root_publish_stage_prepare "$ROOT_FREQUENCY_FENCE/stage"
  mkdir -p "$ROOT_FREQUENCY_FENCE/bundle/.frequency-publish.pending"
  bash "$LIB/publish-root-checks-output.sh" "$ROOT_FREQUENCY_FENCE/stage" \
    "$ROOT_FREQUENCY_FENCE/bundle" > /dev/null 2>&1
  root_frequency_fence_rc=$?
  check_eq "root-check publisher refuses a pending frequency transaction" "1" \
    "$([[ $root_frequency_fence_rc -eq 75 &&
      -f "$ROOT_FREQUENCY_FENCE/stage/root-checks.meta" &&
      -d "$ROOT_FREQUENCY_FENCE/bundle/.frequency-publish.pending" ]] && echo 1 || echo 0)"

  ROOT_PUBLISH="$TMP/root-checks-publish"
  root_publish_stage_prepare "$ROOT_PUBLISH/stage"
  mkdir -p "$ROOT_PUBLISH/bundle/env/root"
  write_derived_output_fixture "$ROOT_PUBLISH/bundle"
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
    [[ -f "$ROOT_PUBLISH/bundle/env/root/root-checks.done" && ! -s "$ROOT_PUBLISH/bundle/env/root/root-checks.done" ]] &&
    node "$LIB/root-checks-evidence.mjs" --validate-complete "$ROOT_PUBLISH/bundle" > /dev/null 2>&1 &&
    derived_outputs_absent "$ROOT_PUBLISH/bundle" &&
    [[ ! -e "$ROOT_PUBLISH/stage" ]] && root_publish_safe=1
  check_eq "root-checks publisher invalidates derived outputs before replacing evidence" "1" "$root_publish_safe"

  ROOT_RETRY="$TMP/root-checks-kill-retry"
  root_publish_stage_prepare "$ROOT_RETRY/stage" 11111111111111111111111111111111
  mkdir -p "$ROOT_RETRY/bundle"
  write_root_checks_fixture "$ROOT_RETRY/bundle" 22222222222222222222222222222222
  write_derived_output_fixture "$ROOT_RETRY/bundle"
  DIAG_TEST_ROOT_PUBLISH_KILL_AFTER_FIRST_PAYLOAD=1 \
    bash "$LIB/publish-root-checks-output.sh" "$ROOT_RETRY/stage" "$ROOT_RETRY/bundle" \
    > /dev/null 2>&1
  root_retry_kill_rc=$?
  node "$LIB/collect.mjs" "$ROOT_RETRY/bundle" > /dev/null 2>&1
  root_retry_mixed_status="$(node -e \
    'const r=require(process.argv[1]); process.stdout.write(`${r.rootChecksStatus.status}|${r.rootChecks === undefined}`)' \
    "$ROOT_RETRY/bundle/results.json")"
  root_retry_kill_ok=0
  [[ $root_retry_kill_rc -ne 0 ]] &&
    [[ "$root_retry_mixed_status" == "invalid|true" ]] &&
    [[ ! -e "$ROOT_RETRY/bundle/env/root/root-checks.done" ]] &&
    [[ "$(cat "$ROOT_RETRY/bundle/env/root/kernel-warnings.txt")" == "staged kernel-warnings.txt" ]] &&
    [[ "$(cat "$ROOT_RETRY/bundle/env/root/cctk.txt")" == "root-check payload cctk.txt" ]] &&
    [[ -f "$ROOT_RETRY/stage/kernel-warnings.txt" && -f "$ROOT_RETRY/stage/root-checks.meta" ]] &&
    root_retry_kill_ok=1
  check_eq "killed root-check publication exposes no mixed or hash-mismatched snapshot" "1" "$root_retry_kill_ok"

  bash "$LIB/publish-root-checks-output.sh" "$ROOT_RETRY/stage" "$ROOT_RETRY/bundle" \
    > /dev/null 2>&1
  root_retry_publish_rc=$?
  node "$LIB/collect.mjs" "$ROOT_RETRY/bundle" > /dev/null 2>&1
  root_retry_complete="$(node -e \
    'const r=require(process.argv[1]); process.stdout.write(`${r.rootChecksStatus.status}|${r.rootChecksStatus.generation}|${r.rootChecks?.["cctk.txt"]}`)' \
    "$ROOT_RETRY/bundle/results.json")"
  check_eq "root-check publication retry completes one validated generation" "1" \
    "$([[ $root_retry_publish_rc -eq 0 && "$root_retry_complete" == 'complete|11111111111111111111111111111111|staged cctk.txt' && ! -e "$ROOT_RETRY/stage" && ! -s "$ROOT_RETRY/bundle/env/root/root-checks.done" ]] && echo 1 || echo 0)"

  ROOT_INVALID_STAGE="$TMP/root-checks-invalid-stage"
  root_publish_stage_prepare "$ROOT_INVALID_STAGE/stage"
  mkdir -p "$ROOT_INVALID_STAGE/bundle/env/root"
  printf 'old root evidence\n' > "$ROOT_INVALID_STAGE/bundle/env/root/cctk.txt"
  write_derived_output_fixture "$ROOT_INVALID_STAGE/bundle"
  rm -f "$ROOT_INVALID_STAGE/stage/cctk.txt"
  mkdir "$ROOT_INVALID_STAGE/stage/cctk.txt"
  bash "$LIB/publish-root-checks-output.sh" \
    "$ROOT_INVALID_STAGE/stage" "$ROOT_INVALID_STAGE/bundle" > /dev/null 2>&1
  root_invalid_stage_rc=$?
  check_eq "invalid root-checks staging preserves every derived output and evidence" "1" \
    "$([[ $root_invalid_stage_rc -ne 0 && "$(cat "$ROOT_INVALID_STAGE/bundle/env/root/cctk.txt")" == "old root evidence" && -d "$ROOT_INVALID_STAGE/stage/cctk.txt" ]] && derived_outputs_present "$ROOT_INVALID_STAGE/bundle" && [[ "$(cat "$ROOT_INVALID_STAGE/bundle/manifest.txt")" == "stale manifest.txt" ]] && echo 1 || echo 0)"

  ROOT_UNREADABLE="$TMP/root-checks-unreadable-destination"
  root_publish_stage_prepare "$ROOT_UNREADABLE/stage"
  mkdir -p "$ROOT_UNREADABLE/bundle"
  write_root_checks_fixture "$ROOT_UNREADABLE/bundle"
  write_derived_output_fixture "$ROOT_UNREADABLE/bundle"
  chmod 0300 "$ROOT_UNREADABLE/bundle/env/root"
  bash "$LIB/publish-root-checks-output.sh" \
    "$ROOT_UNREADABLE/stage" "$ROOT_UNREADABLE/bundle" > /dev/null 2>&1
  root_unreadable_rc=$?
  chmod 0700 "$ROOT_UNREADABLE/bundle/env/root"
  check_eq "unreadable root-check destination fails before derived invalidation" "1" \
    "$([[ $root_unreadable_rc -ne 0 && -f "$ROOT_UNREADABLE/stage/cctk.txt" ]] && derived_outputs_present "$ROOT_UNREADABLE/bundle" && echo 1 || echo 0)"

  ROOT_UNSEARCHABLE_PARENT="$TMP/root-checks-unsearchable-parent"
  root_publish_stage_prepare "$ROOT_UNSEARCHABLE_PARENT/stage"
  mkdir -p "$ROOT_UNSEARCHABLE_PARENT/bundle"
  write_root_checks_fixture "$ROOT_UNSEARCHABLE_PARENT/bundle"
  write_derived_output_fixture "$ROOT_UNSEARCHABLE_PARENT/bundle"
  chmod 0200 "$ROOT_UNSEARCHABLE_PARENT/bundle/env"
  bash "$LIB/publish-root-checks-output.sh" \
    "$ROOT_UNSEARCHABLE_PARENT/stage" "$ROOT_UNSEARCHABLE_PARENT/bundle" > /dev/null 2>&1
  root_unsearchable_parent_rc=$?
  chmod 0700 "$ROOT_UNSEARCHABLE_PARENT/bundle/env"
  check_eq "unsearchable env parent fails before derived or evidence mutation" "1" \
    "$([[ $root_unsearchable_parent_rc -ne 0 && -f "$ROOT_UNSEARCHABLE_PARENT/stage/cctk.txt" && -f "$ROOT_UNSEARCHABLE_PARENT/bundle/env/root/root-checks.done" && "$(cat "$ROOT_UNSEARCHABLE_PARENT/bundle/env/root/cctk.txt")" == "root-check payload cctk.txt" ]] && derived_outputs_present "$ROOT_UNSEARCHABLE_PARENT/bundle" && echo 1 || echo 0)"

  ROOT_EXTRA="$TMP/root-checks-extra-destination"
  root_publish_stage_prepare "$ROOT_EXTRA/stage"
  mkdir -p "$ROOT_EXTRA/bundle"
  write_root_checks_fixture "$ROOT_EXTRA/bundle"
  write_derived_output_fixture "$ROOT_EXTRA/bundle"
  printf 'unknown\n' > "$ROOT_EXTRA/bundle/env/root/unknown.txt"
  bash "$LIB/publish-root-checks-output.sh" "$ROOT_EXTRA/stage" "$ROOT_EXTRA/bundle" \
    > /dev/null 2>&1
  root_extra_rc=$?
  check_eq "unknown root-check destination fails before derived invalidation" "1" \
    "$([[ $root_extra_rc -ne 0 && -f "$ROOT_EXTRA/bundle/env/root/unknown.txt" && -f "$ROOT_EXTRA/stage/cctk.txt" ]] && derived_outputs_present "$ROOT_EXTRA/bundle" && echo 1 || echo 0)"

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

  root_stage_classify() {
    # root_stage_classify <dir> [root]
    # Classifies <dir> through the sourced root-checks.sh internals. With the
    # literal second argument "root", the identity seam reports the fixture
    # as root-owned so non-root tests can exercise the pre-handoff class.
    local dir="$1" as_root="${2:-}"
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    if [[ "$as_root" == root ]]; then
      root_checks_stage_identity() {
        local real
        real="$(stat -Lc '%u:%g:%a:%h' -- "$1" 2> /dev/null)" || return 1
        printf '0:0:%s\n' "${real#*:*:}"
      }
    fi
    root_checks_classify_existing_stage "$dir"
  }

  ROOT_STAGE_CLASSIFY="$TMP/root-checks-stage-classify"
  mkdir -p "$ROOT_STAGE_CLASSIFY"
  check_eq "root-checks stage classification reports an absent path as absent" "absent" \
    "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/does-not-exist")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/handed-off"
  check_eq "root-checks stage classification accepts a complete user-owned stage as handed-off" \
    "handed-off" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/handed-off")"
  check_eq "root-checks stage classification reports a root-owned complete stage as pre-handoff" \
    "pre-handoff" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/handed-off" root)"

  ln -s "$ROOT_STAGE_CLASSIFY/handed-off" "$ROOT_STAGE_CLASSIFY/stage-link"
  check_eq "root-checks stage classification rejects a symlinked stage as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/stage-link")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/foreign"
  printf 'foreign\n' > "$ROOT_STAGE_CLASSIFY/foreign/foreign.txt"
  chmod 0600 "$ROOT_STAGE_CLASSIFY/foreign/foreign.txt"
  check_eq "root-checks stage classification rejects an extra foreign entry as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/foreign")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/missing"
  rm -f "$ROOT_STAGE_CLASSIFY/missing/cctk.txt"
  check_eq "root-checks stage classification rejects a missing payload as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/missing")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/wrong-mode"
  chmod 0755 "$ROOT_STAGE_CLASSIFY/wrong-mode"
  check_eq "root-checks stage classification rejects a wrong-mode stage as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/wrong-mode")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/fifo"
  rm -f "$ROOT_STAGE_CLASSIFY/fifo/cctk.txt"
  mkfifo "$ROOT_STAGE_CLASSIFY/fifo/cctk.txt"
  # Pin the entry-type check specifically: with mode 600 the fifo passes every
  # ownership/mode/link rule, so only the regular-file requirement rejects it.
  chmod 0600 "$ROOT_STAGE_CLASSIFY/fifo/cctk.txt"
  check_eq "root-checks stage classification rejects a fifo payload as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/fifo")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/payload-link"
  rm -f "$ROOT_STAGE_CLASSIFY/payload-link/cctk.txt"
  printf 'valid target\n' > "$ROOT_STAGE_CLASSIFY/payload-link-target"
  chmod 0600 "$ROOT_STAGE_CLASSIFY/payload-link-target"
  ln -s "$ROOT_STAGE_CLASSIFY/payload-link-target" "$ROOT_STAGE_CLASSIFY/payload-link/cctk.txt"
  check_eq "root-checks stage classification rejects a symlinked payload as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/payload-link")"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/foreign-owner"
  foreign_owner_class="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    root_checks_stage_identity() {
      local real
      real="$(stat -Lc '%a:%h' -- "$1" 2> /dev/null)" || return 1
      printf '4321:4321:%s\n' "$real"
    }
    root_checks_classify_existing_stage "$ROOT_STAGE_CLASSIFY/foreign-owner"
  )"
  check_eq "root-checks stage classification rejects a foreign-owner stage as unsafe" \
    "unsafe" "$foreign_owner_class"

  root_publish_stage_prepare "$ROOT_STAGE_CLASSIFY/hardlink"
  ln "$ROOT_STAGE_CLASSIFY/hardlink/cctk.txt" "$ROOT_STAGE_CLASSIFY/cctk-hardlink"
  check_eq "root-checks stage classification rejects a hardlinked payload as unsafe" \
    "unsafe" "$(root_stage_classify "$ROOT_STAGE_CLASSIFY/hardlink")"

  ROOT_PRE_HANDOFF="$TMP/root-checks-pre-handoff-recovery"
  mkdir -p -m 0700 "$ROOT_PRE_HANDOFF/stage"
  printf 'partial kernel warnings\n' > "$ROOT_PRE_HANDOFF/stage/kernel-warnings.txt"
  printf 'partial cctk\n' > "$ROOT_PRE_HANDOFF/stage/cctk.txt"
  chmod 0600 "$ROOT_PRE_HANDOFF/stage/kernel-warnings.txt" "$ROOT_PRE_HANDOFF/stage/cctk.txt"
  pre_handoff_recovery="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    root_checks_stage_identity() {
      local real
      real="$(stat -Lc '%u:%g:%a:%h' -- "$1" 2> /dev/null)" || return 1
      printf '0:0:%s\n' "${real#*:*:}"
    }
    class="$(root_checks_classify_existing_stage "$ROOT_PRE_HANDOFF/stage")"
    rc=0
    root_checks_stage_dispatch "$class" "$ROOT_PRE_HANDOFF/stage" \
      "$ROOT_PRE_HANDOFF/bundle" 0 2> /dev/null || rc=$?
    leftovers="$(find "$ROOT_PRE_HANDOFF/stage" -mindepth 1 -maxdepth 1 -print | wc -l)"
    stage_state=lost
    if [[ -d "$ROOT_PRE_HANDOFF/stage" && ! -L "$ROOT_PRE_HANDOFF/stage" ]]; then
      stage_state=reused
    fi
    printf '%s:%s:%s:%s\n' "$class" "$rc" "$leftovers" "$stage_state"
  )"
  check_eq "pre-handoff recovery removes root-owned known payloads and reuses the stage" \
    "pre-handoff:0:0:reused" "$pre_handoff_recovery"

  # The half-chowned window: root's directory is intact, but the per-file
  # handoff already ran, so the payloads are user-owned. Root provably owns
  # the directory, so this is still root's own interrupted stage.
  ROOT_MIXED_HANDOFF="$TMP/root-checks-pre-handoff-mixed"
  mkdir -p -m 0700 "$ROOT_MIXED_HANDOFF/stage"
  printf 'partial kernel warnings\n' > "$ROOT_MIXED_HANDOFF/stage/kernel-warnings.txt"
  printf 'partial cctk\n' > "$ROOT_MIXED_HANDOFF/stage/cctk.txt"
  chmod 0600 "$ROOT_MIXED_HANDOFF/stage/kernel-warnings.txt" "$ROOT_MIXED_HANDOFF/stage/cctk.txt"
  mixed_handoff_recovery="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    root_checks_stage_identity() {
      local real
      real="$(stat -Lc '%u:%g:%a:%h' -- "$1" 2> /dev/null)" || return 1
      if [[ "$1" == "$ROOT_MIXED_HANDOFF/stage" ]]; then
        printf '0:0:%s\n' "${real#*:*:}"
      else
        printf '%s\n' "$real"
      fi
    }
    class="$(root_checks_classify_existing_stage "$ROOT_MIXED_HANDOFF/stage")"
    rc=0
    root_checks_stage_dispatch "$class" "$ROOT_MIXED_HANDOFF/stage" \
      "$ROOT_MIXED_HANDOFF/bundle" 0 2> /dev/null || rc=$?
    leftovers="$(find "$ROOT_MIXED_HANDOFF/stage" -mindepth 1 -maxdepth 1 -print | wc -l)"
    stage_state=lost
    if [[ -d "$ROOT_MIXED_HANDOFF/stage" && ! -L "$ROOT_MIXED_HANDOFF/stage" ]]; then
      stage_state=reused
    fi
    printf '%s:%s:%s:%s\n' "$class" "$rc" "$leftovers" "$stage_state"
  )"
  check_eq "pre-handoff recovery accepts the half-chowned handoff window" \
    "pre-handoff:0:0:reused" "$mixed_handoff_recovery"

  ROOT_PRE_FOREIGN="$TMP/root-checks-pre-handoff-foreign"
  mkdir -p -m 0700 "$ROOT_PRE_FOREIGN/stage"
  printf 'partial cctk\n' > "$ROOT_PRE_FOREIGN/stage/cctk.txt"
  printf 'foreign\n' > "$ROOT_PRE_FOREIGN/stage/foreign.txt"
  chmod 0600 "$ROOT_PRE_FOREIGN/stage/cctk.txt" "$ROOT_PRE_FOREIGN/stage/foreign.txt"
  pre_foreign_result="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    root_checks_stage_identity() {
      local real
      real="$(stat -Lc '%u:%g:%a:%h' -- "$1" 2> /dev/null)" || return 1
      printf '0:0:%s\n' "${real#*:*:}"
    }
    class="$(root_checks_classify_existing_stage "$ROOT_PRE_FOREIGN/stage")"
    rc=0
    root_checks_stage_dispatch "$class" "$ROOT_PRE_FOREIGN/stage" \
      "$ROOT_PRE_FOREIGN/bundle" 0 2> /dev/null || rc=$?
    refused=0
    if ((rc != 0)); then refused=1; fi
    kept=0
    if [[ -f "$ROOT_PRE_FOREIGN/stage/cctk.txt" && -f "$ROOT_PRE_FOREIGN/stage/foreign.txt" ]]; then
      kept=1
    fi
    printf '%s:%s:%s\n' "$class" "$refused" "$kept"
  )"
  check_eq "pre-handoff recovery refuses a foreign entry without deleting anything" \
    "unsafe:1:1" "$pre_foreign_result"

  ROOT_ORPHAN="$TMP/root-checks-handed-off-orphan"
  root_publish_stage_prepare "$ROOT_ORPHAN/stage" 33333333333333333333333333333333
  mkdir -p "$ROOT_ORPHAN/bundle"
  (
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    SUDO_USER="$(id -un)"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    runuser() {
      [[ "$1" == -u && "$3" == -- ]] || return 1
      shift 3
      "$@"
    }
    class="$(root_checks_classify_existing_stage "$ROOT_ORPHAN/stage")"
    [[ "$class" == handed-off ]] || exit 3
    rc=0
    root_checks_stage_dispatch "$class" "$ROOT_ORPHAN/stage" "$ROOT_ORPHAN/bundle" 0 \
      > /dev/null 2> "$ROOT_ORPHAN/notice" || rc=$?
    [[ "$rc" == 100 ]]
  )
  check_eq "handed-off orphan recovery dispatch republishes instead of re-collecting" "0" "$?"
  check_eq "handed-off orphan recovery publishes one validated generation and removes the stage" "1" \
    "$([[ ! -e "$ROOT_ORPHAN/stage" && ! -L "$ROOT_ORPHAN/stage" ]] &&
      node "$LIB/root-checks-evidence.mjs" --validate-complete "$ROOT_ORPHAN/bundle" > /dev/null 2>&1 &&
      echo 1 || echo 0)"
  check_eq "handed-off orphan recovery notice names the stage and collection time" "1" \
    "$(grep -qF "$ROOT_ORPHAN/stage" "$ROOT_ORPHAN/notice" &&
      grep -qF '2026-08-02T20:00:00' "$ROOT_ORPHAN/notice" && echo 1 || echo 0)"

  ROOT_FRESH="$TMP/root-checks-fresh-discard"
  root_publish_stage_prepare "$ROOT_FRESH/stage"
  mkdir -p "$ROOT_FRESH/bundle"
  fresh_discard_result="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    SUDO_USER="$(id -un)"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    runuser() { return 99; }
    rc=0
    root_checks_stage_discard_handed_off "$ROOT_FRESH/stage" 2> /dev/null || rc=$?
    stage_state=gone
    if [[ -e "$ROOT_FRESH/stage" || -L "$ROOT_FRESH/stage" ]]; then stage_state=present; fi
    published=no
    if [[ -e "$ROOT_FRESH/bundle/env/root" ]]; then published=yes; fi
    printf '%s:%s:%s\n' "$rc" "$stage_state" "$published"
  )"
  check_eq "--fresh discards a proven handed-off orphan without publishing" \
    "0:gone:no" "$fresh_discard_result"

  ROOT_FRESH_FOREIGN="$TMP/root-checks-fresh-foreign"
  root_publish_stage_prepare "$ROOT_FRESH_FOREIGN/stage"
  printf 'foreign\n' > "$ROOT_FRESH_FOREIGN/stage/foreign.txt"
  chmod 0600 "$ROOT_FRESH_FOREIGN/stage/foreign.txt"
  fresh_foreign_result="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    SUDO_USER="$(id -un)"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    class="$(root_checks_classify_existing_stage "$ROOT_FRESH_FOREIGN/stage")"
    rc=0
    root_checks_stage_dispatch "$class" "$ROOT_FRESH_FOREIGN/stage" \
      "$ROOT_FRESH_FOREIGN/bundle" 1 2> /dev/null || rc=$?
    refused=0
    if ((rc != 0)); then refused=1; fi
    kept=0
    if [[ -f "$ROOT_FRESH_FOREIGN/stage/foreign.txt" &&
      -f "$ROOT_FRESH_FOREIGN/stage/root-checks.meta" &&
      -d "$ROOT_FRESH_FOREIGN/stage" ]]; then
      kept=1
    fi
    printf '%s:%s:%s\n' "$class" "$refused" "$kept"
  )"
  check_eq "--fresh on a foreign-entry stage refuses and deletes nothing" \
    "unsafe:1:1" "$fresh_foreign_result"

  ROOT_FRESH_INCOMPLETE="$TMP/root-checks-fresh-incomplete"
  root_publish_stage_prepare "$ROOT_FRESH_INCOMPLETE/stage"
  rm -f "$ROOT_FRESH_INCOMPLETE/stage/cctk.txt"
  fresh_incomplete_result="$(
    ROOT_CHECKS_SOURCE_ONLY=1
    source "$REPO_ROOT/root-checks.sh"
    SUDO_USER="$(id -un)"
    ROOT_CHECKS_STAGE_UID="$(id -u)"
    ROOT_CHECKS_STAGE_GID="$(id -g)"
    rc=0
    root_checks_stage_discard_handed_off "$ROOT_FRESH_INCOMPLETE/stage" \
      > /dev/null 2>&1 || rc=$?
    refused=0
    if ((rc != 0)); then refused=1; fi
    kept=0
    if [[ -f "$ROOT_FRESH_INCOMPLETE/stage/kernel-warnings.txt" &&
      -f "$ROOT_FRESH_INCOMPLETE/stage/root-checks.meta" &&
      -d "$ROOT_FRESH_INCOMPLETE/stage" ]]; then
      kept=1
    fi
    printf '%s:%s\n' "$refused" "$kept"
  )"
  check_eq "--fresh discard refuses an incomplete stage and deletes nothing" \
    "1:1" "$fresh_incomplete_result"
else
  ok "busy root-checks publisher returns 75 without mutating stage or bundle [skipped while tests run as root]"
  ok "root-check publication retries after the bundle lock is released [skipped while tests run as root]"
  ok "root-check publisher refuses a pending frequency transaction [skipped while tests run as root]"
  ok "root-checks publisher invalidates derived outputs before replacing evidence [skipped while tests run as root]"
  ok "killed root-check publication exposes no mixed or hash-mismatched snapshot [skipped while tests run as root]"
  ok "root-check publication retry completes one validated generation [skipped while tests run as root]"
  ok "invalid root-checks staging preserves every derived output and evidence [skipped while tests run as root]"
  ok "unreadable root-check destination fails before derived invalidation [skipped while tests run as root]"
  ok "unsearchable env parent fails before derived or evidence mutation [skipped while tests run as root]"
  ok "unknown root-check destination fails before derived invalidation [skipped while tests run as root]"
  ok "unprivileged root-checks publisher rejects output-directory substitution [skipped while tests run as root]"
  ok "root-checks stage classification reports an absent path as absent [skipped while tests run as root]"
  ok "root-checks stage classification accepts a complete user-owned stage as handed-off [skipped while tests run as root]"
  ok "root-checks stage classification reports a root-owned complete stage as pre-handoff [skipped while tests run as root]"
  ok "root-checks stage classification rejects a symlinked stage as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects an extra foreign entry as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a missing payload as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a wrong-mode stage as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a fifo payload as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a symlinked payload as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a foreign-owner stage as unsafe [skipped while tests run as root]"
  ok "root-checks stage classification rejects a hardlinked payload as unsafe [skipped while tests run as root]"
  ok "pre-handoff recovery removes root-owned known payloads and reuses the stage [skipped while tests run as root]"
  ok "pre-handoff recovery accepts the half-chowned handoff window [skipped while tests run as root]"
  ok "pre-handoff recovery refuses a foreign entry without deleting anything [skipped while tests run as root]"
  ok "handed-off orphan recovery dispatch republishes instead of re-collecting [skipped while tests run as root]"
  ok "handed-off orphan recovery publishes one validated generation and removes the stage [skipped while tests run as root]"
  ok "handed-off orphan recovery notice names the stage and collection time [skipped while tests run as root]"
  ok "--fresh discards a proven handed-off orphan without publishing [skipped while tests run as root]"
  ok "--fresh on a foreign-entry stage refuses and deletes nothing [skipped while tests run as root]"
  ok "--fresh discard refuses an incomplete stage and deletes nothing [skipped while tests run as root]"
fi

echo "== --redo phase handling =="
preflight_redo_plan="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  REDO_PHASES=preflight
  build_redo_plan
  printf '%s\n' "${REDO_PLAN[*]}"
)"
check_eq "--redo preflight expands to the complete downstream closure" \
  "preflight baseline groups individual frequency gdb" "$preflight_redo_plan"

preflight_pending_closure_ok=1
for missing_phase in baseline groups individual frequency gdb; do
  PREFLIGHT_BAD_PENDING="$TMP/preflight-bad-pending-$missing_phase"
  mkdir -p "$PREFLIGHT_BAD_PENDING"/{results,state}
  cat > "$PREFLIGHT_BAD_PENDING/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=
EOF
  {
    printf 'VERSION\t1\n'
    printf 'TXN\tredo-20260802T000000-%s\n' "$missing_phase"
    printf 'PHASE\tpreflight\n'
    for pending_phase in baseline groups individual frequency gdb; do
      [[ "$pending_phase" == "$missing_phase" ]] || printf 'PHASE\t%s\n' "$pending_phase"
    done
  } > "$PREFLIGHT_BAD_PENDING/state/redo.pending"
  "$REPO_ROOT/diagnose.sh" --resume "$PREFLIGHT_BAD_PENDING" --dry-run --yes \
    > "$PREFLIGHT_BAD_PENDING/resume.output" 2>&1
  pending_closure_rc=$?
  if [[ $pending_closure_rc -eq 0 || ! -f "$PREFLIGHT_BAD_PENDING/state/redo.pending" ]] ||
    ! grep -q 'pending redo transaction is malformed' "$PREFLIGHT_BAD_PENDING/resume.output"; then
    preflight_pending_closure_ok=0
  fi
done
check_eq "pending preflight redo rejects every incomplete downstream closure" "1" "$preflight_pending_closure_ok"

PREFLIGHT_REDO="$TMP/redo-preflight-bundle"
mkdir -p "$PREFLIGHT_REDO"/{env/root,results,state}
printf 'old summary\n' > "$PREFLIGHT_REDO/env/summary.env"
printf 'old manifest\n' > "$PREFLIGHT_REDO/env/preflight.manifest"
printf 'stranded manifest temp\n' > "$PREFLIGHT_REDO/env/.preflight.manifest.stranded"
printf 'stranded metadata temp\n' > "$PREFLIGHT_REDO/results/.preflight.meta.stranded"
printf 'old root evidence\n' > "$PREFLIGHT_REDO/env/root/cctk.txt"
printf 'old preflight metadata\n' > "$PREFLIGHT_REDO/results/preflight.meta"
for phase in preflight baseline groups individual frequency gdb; do
  : > "$PREFLIGHT_REDO/state/phase-$phase.done"
done
cat > "$PREFLIGHT_REDO/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=preflight,baseline,groups,individual,frequency,gdb
EOF
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$PREFLIGHT_REDO"
  STATE_DIR="$PREFLIGHT_REDO/state"
  META_FILE="$PREFLIGHT_REDO/results/meta.env"
  REDO_PHASES=preflight
  build_redo_plan
  apply_redo_plan
) > /dev/null 2>&1
preflight_redo_rc=$?
preflight_redo_stash="$(find "$PREFLIGHT_REDO/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
preflight_redo_ok=0
[[ $preflight_redo_rc -eq 0 ]] &&
  [[ "$(cat "$preflight_redo_stash/preflight/env/summary.env")" == "old summary" ]] &&
  [[ "$(cat "$preflight_redo_stash/preflight/env/root/cctk.txt")" == "old root evidence" ]] &&
  [[ "$(cat "$preflight_redo_stash/preflight/results/preflight.meta")" == "old preflight metadata" ]] &&
  [[ "$(cat "$preflight_redo_stash/preflight/env/.preflight.manifest.stranded")" == "stranded manifest temp" ]] &&
  [[ "$(cat "$preflight_redo_stash/preflight/results/.preflight.meta.stranded")" == "stranded metadata temp" ]] &&
  [[ ! -e "$PREFLIGHT_REDO/env/summary.env" && ! -e "$PREFLIGHT_REDO/env/root" ]] &&
  [[ "$(find "$PREFLIGHT_REDO/state" -maxdepth 1 -name 'phase-*.done' | wc -l)" -eq 0 ]] &&
  grep -q '^COMPLETED_PHASES=$' "$PREFLIGHT_REDO/results/meta.env" && preflight_redo_ok=1
check_eq "--redo preflight archives environment/root evidence and clears the full closure" "1" "$preflight_redo_ok"

PREFLIGHT_PARTIAL="$TMP/preflight-partial-resume"
mkdir -p "$PREFLIGHT_PARTIAL"/{env,results,state}
printf 'partial snapshot\n' > "$PREFLIGHT_PARTIAL/env/summary.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PREFLIGHT_PARTIAL"
  preflight_prepare_fresh_targets
) > /dev/null 2>&1
preflight_partial_rc=$?
check_eq "partial preflight evidence is preserved and refuses an implicit overwrite" "1" \
  "$([[ $preflight_partial_rc -ne 0 && "$(cat "$PREFLIGHT_PARTIAL/env/summary.env")" == "partial snapshot" ]] && echo 1 || echo 0)"

PREFLIGHT_PRODUCED="$TMP/preflight-produced"
mkdir -p "$PREFLIGHT_PRODUCED"/{env,results,state}
cat > "$PREFLIGHT_PRODUCED/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=
EOF
(
  cd "$REPO_ROOT"
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PREFLIGHT_PRODUCED"
  STATE_DIR="$PREFLIGHT_PRODUCED/state"
  META_FILE="$PREFLIGHT_PRODUCED/results/meta.env"
  DIAG_LOG_FILE=""
  DIAG_COMMANDS_LOG="$PREFLIGHT_PRODUCED/commands.log"
  discover_topology
  phase_preflight
) > /dev/null 2>&1
preflight_produced_rc=$?
node "$LIB/preflight-evidence.mjs" --validate-complete "$PREFLIGHT_PRODUCED" > /dev/null 2>&1
preflight_produced_validate_rc=$?
check_eq "preflight producer publishes a validator-complete zero-marker envelope" "1" \
  "$([[ $preflight_produced_rc -eq 0 && $preflight_produced_validate_rc -eq 0 && ! -s "$PREFLIGHT_PRODUCED/state/phase-preflight.done" ]] && echo 1 || echo 0)"

PREFLIGHT_INVALID_RESUME="$TMP/preflight-invalid-completed-resume"
mkdir -p "$PREFLIGHT_INVALID_RESUME"/{env,results,state}
cat > "$PREFLIGHT_INVALID_RESUME/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=10
INDIVIDUAL_RUNS=5
GDB_MAX_RUNS=6
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=preflight
EOF
write_preflight_fixture "$PREFLIGHT_INVALID_RESUME"
printf 'tampered after publication\n' >> "$PREFLIGHT_INVALID_RESUME/env/cpufreq.txt"
"$REPO_ROOT/diagnose.sh" --resume "$PREFLIGHT_INVALID_RESUME" --yes \
  > "$PREFLIGHT_INVALID_RESUME/resume.output" 2>&1
preflight_invalid_resume_rc=$?
check_eq "main resume rejects invalid marked-complete preflight evidence before skipping" "1" \
  "$([[ $preflight_invalid_resume_rc -ne 0 && -f "$PREFLIGHT_INVALID_RESUME/state/phase-preflight.done" && ! -e "$PREFLIGHT_INVALID_RESUME/state/phase-baseline.done" ]] && grep -q 'completed preflight phase has missing, stale, or invalid evidence' "$PREFLIGHT_INVALID_RESUME/resume.output" && echo 1 || echo 0)"

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

# Model the live-bundle frontier: complete baseline/groups, an immutable V5
# individual plan with no committed observations, and three telemetry
# sessions. Redo must archive only the individual/downstream closure.
ACTIVE_V5_REDO="$TMP/redo-active-v5-bundle"
mkdir -p "$ACTIVE_V5_REDO"/{results,state/individual-attempts,logs/individual,telemetry/individual,state/telemetry-individual}
printf 'baseline retained\n' > "$ACTIVE_V5_REDO/results/baseline.meta"
printf 'groups retained\n' > "$ACTIVE_V5_REDO/results/groups.tsv"
printf 'ordinal\tround\tposition\tcpu\n1\t1\t1\t12\n2\t1\t2\t22\n' \
  > "$ACTIVE_V5_REDO/results/individual.plan.tsv"
: > "$ACTIVE_V5_REDO/results/individual.tsv"
: > "$ACTIVE_V5_REDO/results/individual.boundaries.ndjson"
cat > "$ACTIVE_V5_REDO/results/individual.meta" << EOF
VERSION=5
GENERATION=623ee623ee623ee623ee623ee623ee62
TARGET_CPUS=0-23
RUNS_PER_CPU=400
TARGET_POLICY=all-usable-cpus
GROUP_PLAN_DIGEST=$(printf 'b%.0s' {1..64})
GROUP_GENERATION=$(printf 'c%.0s' {1..32})
PROTOCOL=isolated-interleaved-v1
SCHEDULE_SEED=131738620
SCHEDULE_ALGORITHM=balanced-cyclic-v1
PLAN_SHA256=$(printf 'd%.0s' {1..64})
PLAN_BYTES=52
PLAN_ROW_COUNT=9600
SKIPPED=0
COMPLETED=0
EOF
for session in 1 2 3; do
  printf 'telemetry session %s\n' "$session" \
    > "$ACTIVE_V5_REDO/telemetry/individual/session-$session.ndjson"
  printf 'telemetry state %s\n' "$session" \
    > "$ACTIVE_V5_REDO/state/telemetry-individual/session-$session.boundary.json"
done
printf 'telemetry rows\n' > "$ACTIVE_V5_REDO/results/telemetry-individual.tsv"
printf 'telemetry metadata\n' > "$ACTIVE_V5_REDO/results/telemetry-individual.meta"
touch "$ACTIVE_V5_REDO/state/phase-preflight.done" \
  "$ACTIVE_V5_REDO/state/phase-baseline.done" "$ACTIVE_V5_REDO/state/phase-groups.done"
cat > "$ACTIVE_V5_REDO/results/meta.env" << EOF
MODE=full
RUN_SCHEMA_VERSION=2
BASELINE_CHILDREN=16
BASELINE_WAVES=100
GROUP_WAVES=100
INDIVIDUAL_RUNS=400
PINNED_CONCURRENT_ROUNDS=400
PROTOCOL_SEED=131738620
SKIP_PINNED_CONCURRENT=0
TELEMETRY_INTERVAL_MS=250
GDB_MAX_RUNS=24
SKIP_GDB=1
CPU_TARGET=auto
COMPLETED_PHASES=preflight,baseline,groups
EOF
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$ACTIVE_V5_REDO"
  STATE_DIR="$ACTIVE_V5_REDO/state"
  META_FILE="$ACTIVE_V5_REDO/results/meta.env"
  load_stored_config "$ACTIVE_V5_REDO"
  REDO_PHASES=individual
  build_redo_plan
  apply_redo_plan
) > /dev/null 2>&1
active_v5_redo_rc=$?
active_v5_stash="$(find "$ACTIVE_V5_REDO/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
active_v5_redo_ok=0
[[ $active_v5_redo_rc -eq 0 ]] &&
  [[ "$(cat "$ACTIVE_V5_REDO/results/baseline.meta")" == "baseline retained" ]] &&
  [[ "$(cat "$ACTIVE_V5_REDO/results/groups.tsv")" == "groups retained" ]] &&
  [[ -f "$ACTIVE_V5_REDO/state/phase-baseline.done" && -f "$ACTIVE_V5_REDO/state/phase-groups.done" ]] &&
  [[ -f "$active_v5_stash/individual/results/individual.meta" ]] &&
  [[ -f "$active_v5_stash/individual/results/individual.plan.tsv" ]] &&
  [[ "$(find "$active_v5_stash/individual/telemetry/individual" -type f | wc -l)" -eq 3 ]] &&
  [[ "$(find "$active_v5_stash/individual/state/telemetry-individual" -type f | wc -l)" -eq 3 ]] &&
  [[ -f "$active_v5_stash/individual/results/telemetry-individual.tsv" ]] &&
  [[ ! -e "$ACTIVE_V5_REDO/results/individual.meta" && ! -e "$ACTIVE_V5_REDO/telemetry/individual" ]] &&
  grep -q '^COMPLETED_PHASES=preflight,baseline,groups$' "$ACTIVE_V5_REDO/results/meta.env" &&
  active_v5_redo_ok=1
check_eq "--redo individual archives the active V5 attempt and telemetry while preserving baseline/groups" \
  "1" "$active_v5_redo_ok"

GB="$TMP/redo-gdb-bundle"
mkdir -p "$GB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\n' > "$GB/results/gdb.meta"
printf 'capture\n' > "$GB/gdb/cpu19-run1.txt"
printf 'runner\n' > "$GB/logs/gdb/runner.log"
printf 'final manifest\n' > "$GB/results/gdb.manifest"
printf 'hidden candidate\n' > "$GB/results/.gdb.manifest.0123456789abcdef0123456789abcdef"
printf 'orphaned metadata temp\n' > "$GB/results/.gdb.meta.ab12cd"
touch "$GB/state/phase-gdb.done"
printf 'COMPLETED_PHASES=gdb\n' > "$GB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GB"
  STATE_DIR="$GB/state"
  META_FILE="$GB/results/meta.env"
  REDO_PLAN=(gdb)
  apply_redo_plan
) > /dev/null 2>&1
gdb_stash="$(find "$GB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
gdb_redo_ok=0
[[ -f "$gdb_stash/gdb/results/gdb.meta" ]] &&
  [[ -f "$gdb_stash/gdb/results/gdb.manifest" ]] &&
  [[ -f "$gdb_stash/gdb/results/.gdb.manifest.0123456789abcdef0123456789abcdef" ]] &&
  [[ -f "$gdb_stash/gdb/results/.gdb.meta.ab12cd" ]] &&
  [[ -f "$gdb_stash/gdb/gdb/cpu19-run1.txt" ]] &&
  [[ -f "$gdb_stash/gdb/logs/gdb/runner.log" ]] &&
  [[ ! -e "$GB/results/gdb.manifest" ]] &&
  [[ ! -e "$GB/results/.gdb.manifest.0123456789abcdef0123456789abcdef" ]] &&
  [[ ! -e "$GB/results/.gdb.meta.ab12cd" ]] &&
  [[ ! -f "$GB/state/phase-gdb.done" ]] && gdb_redo_ok=1
check_eq "--redo gdb preserves distinct capture, runner, and manifest paths" "1" "$gdb_redo_ok"

GDB_PREDICATE_RB="$TMP/gdb-incomplete-predicate"
mkdir -p "$GDB_PREDICATE_RB"/{results,state,gdb,logs/gdb}
gdb_predicate_result="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_PREDICATE_RB"
  STATE_DIR="$GDB_PREDICATE_RB/state"
  empty=0 meta=0 manifest=0 candidate=0 capture=0 log_entry=0 nondir=0 symlink=0 completed=0
  gdb_incomplete_attempt_is_meaningful && empty=1
  printf 'CPU=19\n' > "$GDB_PREDICATE_RB/results/gdb.meta"
  gdb_incomplete_attempt_is_meaningful && meta=1
  rm -f "$GDB_PREDICATE_RB/results/gdb.meta"
  printf 'manifest\n' > "$GDB_PREDICATE_RB/results/gdb.manifest"
  gdb_incomplete_attempt_is_meaningful && manifest=1
  rm -f "$GDB_PREDICATE_RB/results/gdb.manifest"
  printf 'candidate\n' > "$GDB_PREDICATE_RB/results/.gdb.manifest.0123456789abcdef0123456789abcdef"
  gdb_incomplete_attempt_is_meaningful && candidate=1
  rm -f "$GDB_PREDICATE_RB/results/.gdb.manifest.0123456789abcdef0123456789abcdef"
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
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$empty" "$meta" "$manifest" "$candidate" \
    "$capture" "$log_entry" "$nondir" "$symlink" "$completed"
)"
check_eq "incomplete GDB predicate distinguishes empty setup from attempt evidence" \
  "0|1|1|1|1|1|1|1|0" "$gdb_predicate_result"

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
printf 'old final manifest\n' > "$GDB_RETRY_RB/results/gdb.manifest"
printf 'old hidden candidate\n' > "$GDB_RETRY_RB/results/.gdb.manifest.0123456789abcdef0123456789abcdef"
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
  RUN_SCHEMA_VERSION=1
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
  [[ "$(cat "$gdb_retry_stash/gdb/results/gdb.manifest")" == "old final manifest" ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/results/.gdb.manifest.0123456789abcdef0123456789abcdef")" == "old hidden candidate" ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/gdb/cpu19-run1.txt")" == "old capture" ]] &&
  [[ "$(cat "$gdb_retry_stash/gdb/logs/gdb/runner.log")" == "old runner" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/results.json")" == "old results" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/report.md")" == "old report" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/privacy-review.txt")" == "old review" ]] &&
  [[ "$(cat "$gdb_retry_stash/derived/manifest.txt")" == "old manifest" ]] &&
  [[ ! -e "$GDB_RETRY_RB/results/gdb.meta" && ! -e "$GDB_RETRY_RB/gdb" && ! -e "$GDB_RETRY_RB/logs/gdb" ]] &&
  [[ ! -e "$GDB_RETRY_RB/results/gdb.manifest" &&
    ! -e "$GDB_RETRY_RB/results/.gdb.manifest.0123456789abcdef0123456789abcdef" ]] &&
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
gdb_skip_generation="$(sed -n 's/^GENERATION\t//p' "$GDB_SKIP_ORDER_RB/results/gdb.manifest")"
node "$LIB/gdb-evidence.mjs" validate-complete "$GDB_SKIP_ORDER_RB" - 12 3 > /dev/null 2>&1
gdb_skip_validate_rc=$?
check_eq "explicit skip publishes a validated generation-bound skip envelope" "0|1" \
  "$gdb_skip_validate_rc|$([[ "$gdb_skip_generation" =~ ^[0-9a-f]{32}$ ]] && echo 1 || echo 0)"

echo "== gdb evidence publication =="
GDB_PUB_BASE="$TMP/gdb-publication"
mkdir -p "$GDB_PUB_BASE"
GDB_STALE_GENERATION=0123456789abcdef0123456789abcdef

# Run the dispatcher inside a sourced shell against the synthetic toolchain.
run_gdb_dispatch_fixture() {
  local bundle="$1" cpu="$2" skip_gdb="$3" mode="$4" hide_gdb="$5"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    RUN_SCHEMA_VERSION=1
    OUT_DIR="$bundle" STATE_DIR="$bundle/state" META_FILE="$bundle/results/meta.env"
    GDB_MAX_RUNS=6 GDB_MAX_CAPTURES=3 SKIP_GDB="$skip_gdb"
    export PATH="$PIPELINE_DIR/bin:$PATH" REAL_NODE_BIN="$REAL_NODE_BIN"
    export FAKE_GDB_MODE="$mode" FAKE_GDB_COUNTER="$bundle/gdb.counter"
    if [[ "$hide_gdb" == 1 ]]; then
      command() {
        if [[ "${1:-} ${2:-}" == "-v gdb" ]]; then return 1; fi
        builtin command "$@"
      }
    fi
    phase_gdb_dispatch "$cpu"
  ) > "$bundle/dispatch.stdout" 2> "$bundle/dispatch.stderr"
}

check_skip_envelope() {
  local label="$1" bundle="$2" reason="$3" generation validate_rc cpu_independent_rc=0
  generation="$(sed -n 's/^GENERATION\t//p' "$bundle/results/gdb.manifest")"
  node "$LIB/gdb-evidence.mjs" validate-complete "$bundle" - 6 3 > /dev/null 2>&1
  validate_rc=$?
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$bundle" STATE_DIR="$bundle/state"
    GDB_MAX_RUNS=6 GDB_MAX_CAPTURES=3
    cpu_target_matches_completed_phase 99 gdb
  ) > /dev/null 2>&1 || cpu_independent_rc=$?
  check_eq "$label" "0|0|1|1|1" \
    "$validate_rc|$cpu_independent_rc|$([[ "$generation" =~ ^[0-9a-f]{32}$ && "$generation" != "$GDB_STALE_GENERATION" ]] && echo 1 || echo 0)|$([[ "$(cat "$bundle/results/gdb.meta")" == $'SKIPPED=1\nSKIP_REASON='"$reason" ]] && echo 1 || echo 0)|$([[ -f "$bundle/state/phase-gdb.done" && ! -e "$bundle/state/redo.pending" ]] && echo 1 || echo 0)"
}

# All three skip reasons publish the same generation-bound skip envelope.
GDB_SKIP_FLAG_RB="$GDB_PUB_BASE/skip-flag"
mkdir -p "$GDB_SKIP_FLAG_RB"/{results,state,logs}
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_SKIP_FLAG_RB/results/meta.env"
run_gdb_dispatch_fixture "$GDB_SKIP_FLAG_RB" 19 1 capture 0
check_eq "--skip-gdb dispatch completes" "0" "$?"
check_skip_envelope "--skip-gdb publishes a validated skip envelope" \
  "$GDB_SKIP_FLAG_RB" "--skip-gdb"

GDB_SKIP_MISSING_RB="$GDB_PUB_BASE/skip-missing"
mkdir -p "$GDB_SKIP_MISSING_RB"/{results,state,logs}
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_SKIP_MISSING_RB/results/meta.env"
run_gdb_dispatch_fixture "$GDB_SKIP_MISSING_RB" 19 0 capture 1
check_eq "missing-gdb dispatch completes" "0" "$?"
check_skip_envelope "gdb not installed publishes a validated skip envelope" \
  "$GDB_SKIP_MISSING_RB" "gdb not installed"

GDB_SKIP_NOCPU_RB="$GDB_PUB_BASE/skip-nocpu"
mkdir -p "$GDB_SKIP_NOCPU_RB"/{results,state,logs}
printf 'COMPLETED_PHASES=baseline\n' > "$GDB_SKIP_NOCPU_RB/results/meta.env"
run_gdb_dispatch_fixture "$GDB_SKIP_NOCPU_RB" "" 0 capture 0
check_eq "no-failing-CPU dispatch completes" "0" "$?"
check_skip_envelope "no failing CPU publishes a validated skip envelope" \
  "$GDB_SKIP_NOCPU_RB" "no failing CPU identified"

# A crashed attempt at any publication stage is archived whole, and the retry
# publishes a new generation.
write_gdb_stale_attempt() {
  local bundle="$1" stage="$2"
  mkdir -p "$bundle/results"
  write_gdb_run_fixture "$bundle" 19 6 3 captured
  rm -f "$bundle/state/phase-gdb.done"
  case "$stage" in
    runner) rm -f "$bundle/results/gdb.meta" "$bundle/results/gdb.manifest" ;;
    meta) rm -f "$bundle/results/gdb.manifest" ;;
    candidate)
      mv "$bundle/results/gdb.manifest" \
        "$bundle/results/.gdb.manifest.$GDB_STALE_GENERATION"
      ;;
    final) ;;
    *) return 1 ;;
  esac
  # A crash during metadata publication can strand its private temp; the
  # archive must sweep that namespace too (every stage past the runner).
  [[ "$stage" == runner ]] ||
    printf 'orphaned metadata temp\n' > "$bundle/results/.gdb.meta.$GDB_STALE_GENERATION"
  printf 'COMPLETED_PHASES=baseline\n' > "$bundle/results/meta.env"
}

for crash_stage in runner meta candidate final; do
  GDB_CRASH_RB="$GDB_PUB_BASE/crash-$crash_stage"
  mkdir -p "$GDB_CRASH_RB"
  write_gdb_stale_attempt "$GDB_CRASH_RB" "$crash_stage"
  run_gdb_dispatch_fixture "$GDB_CRASH_RB" 19 0 clean 0
  crash_retry_rc=$?
  crash_stash="$(find "$GDB_CRASH_RB/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
  crash_generation="$(sed -n 's/^GENERATION\t//p' "$GDB_CRASH_RB/results/gdb.manifest")"
  node "$LIB/gdb-evidence.mjs" validate-complete "$GDB_CRASH_RB" 19 6 3 > /dev/null 2>&1
  crash_validate_rc=$?
  crash_archived=1
  [[ -f "$crash_stash/gdb/logs/gdb/runner.log" ]] || crash_archived=0
  [[ "$crash_stage" == runner ]] || [[ -f "$crash_stash/gdb/results/gdb.meta" ]] || crash_archived=0
  [[ "$crash_stage" == runner ]] ||
    [[ -f "$crash_stash/gdb/results/.gdb.meta.$GDB_STALE_GENERATION" ]] || crash_archived=0
  case "$crash_stage" in
    candidate)
      [[ -f "$crash_stash/gdb/results/.gdb.manifest.$GDB_STALE_GENERATION" ]] || crash_archived=0 ;;
    final)
      [[ -f "$crash_stash/gdb/results/gdb.manifest" ]] || crash_archived=0 ;;
  esac
  [[ -f "$crash_stash/gdb/gdb/cpu19-run1.txt" ]] || crash_archived=0
  check_eq "crash after GDB $crash_stage publication archives the attempt and retries with a new generation" \
    "0|0|1|1|1" \
    "$crash_retry_rc|$crash_validate_rc|$crash_archived|$([[ "$crash_generation" =~ ^[0-9a-f]{32}$ && "$crash_generation" != "$GDB_STALE_GENERATION" ]] && echo 1 || echo 0)|$([[ -f "$GDB_CRASH_RB/state/phase-gdb.done" && ! -e "$GDB_CRASH_RB/state/redo.pending" ]] && echo 1 || echo 0)"
done

# A crash after the completion marker is a completed phase, not an attempt:
# the resume gate accepts the intact envelope without archiving anything.
GDB_CRASH_MARKER_RB="$GDB_PUB_BASE/crash-marker"
mkdir -p "$GDB_CRASH_MARKER_RB/results"
write_gdb_run_fixture "$GDB_CRASH_MARKER_RB" 19 6 3 captured
printf 'COMPLETED_PHASES=baseline,gdb\n' > "$GDB_CRASH_MARKER_RB/results/meta.env"
sha256sum "$GDB_CRASH_MARKER_RB/results/gdb.manifest" > "$GDB_CRASH_MARKER_RB/manifest.sha"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_CRASH_MARKER_RB" STATE_DIR="$GDB_CRASH_MARKER_RB/state"
  META_FILE="$GDB_CRASH_MARKER_RB/results/meta.env"
  GDB_MAX_RUNS=6 GDB_MAX_CAPTURES=3
  gdb_completed_resume_gate
) > /dev/null 2>&1
crash_marker_rc=$?
check_eq "crash after the GDB completion marker resumes on the intact envelope" "0|1|1" \
  "$crash_marker_rc|$(sha256sum -c "$GDB_CRASH_MARKER_RB/manifest.sha" > /dev/null 2>&1 && echo 1 || echo 0)|$([[ ! -e "$GDB_CRASH_MARKER_RB/state/superseded" ]] && echo 1 || echo 0)"

# Completed resume rejects missing, tampered, wrong-generation, wrong-CPU, and
# wrong-config envelopes.
gdb_resume_gate_rejected() {
  local label="$1" bundle="$2"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$bundle" STATE_DIR="$bundle/state" META_FILE="$bundle/results/meta.env"
    GDB_MAX_RUNS=6 GDB_MAX_CAPTURES=3
    ! gdb_completed_envelope_cpu
  ) > /dev/null 2>&1
  check_eq "$label" "0" "$?"
}

GDB_RESUME_BASE="$GDB_PUB_BASE/resume"
mkdir -p "$GDB_RESUME_BASE"

cp -a "$GDB_CRASH_MARKER_RB" "$GDB_RESUME_BASE/missing"
rm "$GDB_RESUME_BASE/missing/results/gdb.manifest"
gdb_resume_gate_rejected "completed resume rejects a missing GDB manifest" "$GDB_RESUME_BASE/missing"

cp -a "$GDB_CRASH_MARKER_RB" "$GDB_RESUME_BASE/tampered-manifest"
sed -i 's/^STATUS\tRUN/STATUS\tSKIPPED/' "$GDB_RESUME_BASE/tampered-manifest/results/gdb.manifest"
gdb_resume_gate_rejected "completed resume rejects a tampered GDB manifest" "$GDB_RESUME_BASE/tampered-manifest"

cp -a "$GDB_CRASH_MARKER_RB" "$GDB_RESUME_BASE/wrong-generation"
sed -i "s/^GENERATION\t$GDB_STALE_GENERATION/GENERATION\tffffffffffffffffffffffffffffffff/" \
  "$GDB_RESUME_BASE/wrong-generation/results/gdb.manifest"
gdb_resume_gate_rejected "completed resume rejects a wrong-generation GDB manifest" \
  "$GDB_RESUME_BASE/wrong-generation"

cp -a "$GDB_CRASH_MARKER_RB" "$GDB_RESUME_BASE/tampered-transcript"
printf 'tampered transcript tail\n' >> "$GDB_RESUME_BASE/tampered-transcript/gdb/cpu19-run1.txt"
gdb_resume_gate_rejected "completed resume rejects a tampered GDB transcript" \
  "$GDB_RESUME_BASE/tampered-transcript"

cp -a "$GDB_CRASH_MARKER_RB" "$GDB_RESUME_BASE/tampered-runner"
printf 'ATTEMPT\tGENERATION\t%s\tCPU\t19\tMAX_RUNS\t6\tMAX_CAPTURES\t3\tRUN\t4\tOUTCOME\terror\n' \
  "$GDB_STALE_GENERATION" >> "$GDB_RESUME_BASE/tampered-runner/logs/gdb/runner.log"
gdb_resume_gate_rejected "completed resume rejects a tampered GDB runner log" \
  "$GDB_RESUME_BASE/tampered-runner"

node "$LIB/gdb-evidence.mjs" validate-complete "$GDB_CRASH_MARKER_RB" 20 6 3 > /dev/null 2>&1
check_eq "completed resume rejects the GDB envelope under a wrong expected CPU" "1" \
  "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
node "$LIB/gdb-evidence.mjs" validate-complete "$GDB_CRASH_MARKER_RB" 19 7 3 > /dev/null 2>&1
check_eq "completed resume rejects the GDB envelope under a wrong run limit" "1" \
  "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
node "$LIB/gdb-evidence.mjs" validate-complete "$GDB_CRASH_MARKER_RB" 19 6 2 > /dev/null 2>&1
check_eq "completed resume rejects the GDB envelope under a wrong capture limit" "1" \
  "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

# Marker-only legacy GDB evidence (done marker plus an old-style gdb.meta, no
# manifest) is not authoritative anymore and requires --redo gdb.
GDB_LEGACY_RB="$GDB_PUB_BASE/legacy-marker-only"
mkdir -p "$GDB_LEGACY_RB"/{results,state,gdb,logs/gdb}
printf 'CPU=19\nMAX_RUNS=6\nEXIT_CODE=0\nATTEMPTED_RUNS=1\nCLEAN_RUNS=0\nCAPTURED_RUNS=1\nERROR_RUNS=0\n' \
  > "$GDB_LEGACY_RB/results/gdb.meta"
printf 'legacy capture\n' > "$GDB_LEGACY_RB/gdb/cpu19-run1.txt"
printf 'legacy runner\n' > "$GDB_LEGACY_RB/logs/gdb/runner.log"
touch "$GDB_LEGACY_RB/state/phase-gdb.done"
printf 'COMPLETED_PHASES=baseline,gdb\n' > "$GDB_LEGACY_RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$GDB_LEGACY_RB" STATE_DIR="$GDB_LEGACY_RB/state"
  META_FILE="$GDB_LEGACY_RB/results/meta.env"
  GDB_MAX_RUNS=6 GDB_MAX_CAPTURES=3
  gdb_completed_resume_gate
) > /dev/null 2> "$GDB_LEGACY_RB/gate.stderr"
legacy_gate_rc=$?
check_eq "marker-only legacy GDB evidence now requires --redo gdb" "1|1" \
  "$([[ $legacy_gate_rc -ne 0 ]] && echo 1 || echo 0)|$(grep -c -- '--redo gdb' "$GDB_LEGACY_RB/gate.stderr")"

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
  RUN_SCHEMA_VERSION=1
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
printf 'groups meta\n' > "$DEPENDENT_RB/results/groups.meta"
printf 'individual\n' > "$DEPENDENT_RB/results/individual.tsv"
printf 'frequency\n' > "$DEPENDENT_RB/results/frequency-ab.tsv"
printf 'gdb\n' > "$DEPENDENT_RB/results/gdb.meta"
printf 'gdb manifest\n' > "$DEPENDENT_RB/results/gdb.manifest"
printf 'gdb hidden candidate\n' > "$DEPENDENT_RB/results/.gdb.manifest.0123456789abcdef0123456789abcdef"
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
  RUN_SCHEMA_VERSION=1
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
  [[ -f "$dependent_stash/groups/results/groups.meta" ]] &&
  [[ -f "$dependent_stash/individual/results/individual.tsv" ]] &&
  [[ -f "$dependent_stash/frequency/results/frequency-ab.tsv" ]] &&
  [[ -f "$dependent_stash/gdb/results/gdb.meta" ]] &&
  [[ -f "$dependent_stash/gdb/results/gdb.manifest" ]] &&
  [[ -f "$dependent_stash/gdb/results/.gdb.manifest.0123456789abcdef0123456789abcdef" ]] &&
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
sed 's/INDIVIDUAL_RUNS.*5$/INDIVIDUAL_RUNS\t9007199254740992/' \
  "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/oversized-individual"
sed 's/GDB_MAX_RUNS.*6$/GDB_MAX_RUNS\t9007199254740992/' \
  "$INVALID_V2_DIR/valid" > "$INVALID_V2_DIR/oversized-gdb"
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
  for marker in missing duplicate out-of-order noncanonical oversized-individual oversized-gdb unreachable-mode v1-with-config bad-cpu-target cpu-out-of-order; do
    redo_transaction_validate "$INVALID_V2_DIR/$marker" || rejected=$((rejected + 1))
  done
  printf '%s|%s|%s|%s\n' "$valid" "$current" "$current_profile" "$rejected"
)"
check_eq "V2 grammar accepts exact legacy/current profiles and rejects malformed CPU rows" \
  "1|1|1|10" "$invalid_v2_result"

generated_config_rows="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
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
GDB_MAX_RUNS=12
SKIP_GDB=0
CPU_TARGET=auto
COMPLETED_PHASES=individual,gdb
EOF
printf '%s\t1\t139\t1\n' "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/individual.tsv"
write_individual_v4_meta "$CPU_EVIDENCE_RB" "$TEST_ONLINE_CPU" 1 \
  failed-groups "$(printf '0%.0s' {1..64})" "$GROUPS_TEST_GENERATION" 0 1
write_gdb_run_fixture "$CPU_EVIDENCE_RB" "$TEST_ONLINE_CPU" 12 3 no-fault
touch "$CPU_EVIDENCE_RB/state/phase-individual.done"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET=auto
  validate_completed_phase_overrides
)
check_eq "auto CPU policy accepts matching completed GDB evidence" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
  RESUME_DIR="$CPU_EVIDENCE_RB" OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  META_FILE="$CPU_EVIDENCE_RB/results/meta.env" CPU_TARGET=auto
  validate_completed_phase_overrides
) > /dev/null 2>&1
unresolved_auto_rc=$?
check_eq "auto policy requires redo when its worst CPU cannot be resolved" "1" \
  "$([[ $unresolved_auto_rc -ne 0 ]] && echo 1 || echo 0)"

rm -f "$CPU_EVIDENCE_RB/state/phase-individual.done"
rm -f "$CPU_EVIDENCE_RB/results/gdb.manifest" "$CPU_EVIDENCE_RB/logs/gdb/runner.log" \
  "$CPU_EVIDENCE_RB/state/phase-gdb.done"
write_gdb_skip_fixture "$CPU_EVIDENCE_RB" "no failing CPU identified" 12 3
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  cpu_target_matches_completed_phase "$TEST_OTHER_CPU" gdb
)
check_eq "strict no-CPU GDB skip is independent of CPU selection" "0" "$?"
printf 'CPU=%s\nSKIPPED=1\nSKIP_REASON=crafted\n' "$TEST_ONLINE_CPU" > "$CPU_EVIDENCE_RB/results/gdb.meta"
printf 'CONFIG\tCPU\t%s\n' "$TEST_ONLINE_CPU" >> "$CPU_EVIDENCE_RB/results/gdb.manifest"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CPU_EVIDENCE_RB" STATE_DIR="$CPU_EVIDENCE_RB/state"
  ! cpu_target_matches_completed_phase "$TEST_OTHER_CPU" gdb
)
check_eq "a GDB envelope cannot claim both a CPU and skip exemption" "0" "$?"

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
write_gdb_run_fixture "$CRAFTED_CPU_MARKER" "$TEST_ONLINE_CPU" 6 3 no-fault
write_test_v2_marker "$CRAFTED_CPU_MARKER/state/redo.pending" quick 8 10
sed -i "s/^PHASE\tgdb$/CONFIG\tCPU_TARGET\t$TEST_OTHER_CPU\nPHASE\tbaseline/" \
  "$CRAFTED_CPU_MARKER/state/redo.pending"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$CRAFTED_CPU_MARKER" STATE_DIR="$CRAFTED_CPU_MARKER/state"
  META_FILE="$CRAFTED_CPU_MARKER/results/meta.env"
  GDB_MAX_RUNS=6
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
mkdir -p "$AUTO_OFFLINE_RB"/{results,state,logs/baseline,freq}
sed 's/^CPU_TARGET=.*/CPU_TARGET=auto/; s/^COMPLETED_PHASES=.*/COMPLETED_PHASES=preflight,baseline,groups,individual/' \
  "$CPU_POLICY_RB/results/meta.env" > "$AUTO_OFFLINE_RB/results/meta.env"
sed -i 's/^BASELINE_CHILDREN=.*/BASELINE_CHILDREN=4/; s/^BASELINE_WAVES=.*/BASELINE_WAVES=5/' \
  "$AUTO_OFFLINE_RB/results/meta.env"
cp "$FIX/repro-fail.log" "$AUTO_OFFLINE_RB/logs/baseline/run1.log"
printf 'CHILDREN=4\nWAVES=5\nLOG=logs/baseline/run1.log\nEXIT_CODE=1\n' \
  > "$AUTO_OFFLINE_RB/results/baseline.meta"
printf 'VERSION=1\nTARGET_CPUS=%s\nRUNS_PER_CPU=1\nSKIPPED=0\nCOMPLETED=1\n' \
  "$TEST_OFFLINE_CANONICAL_CPU" > "$AUTO_OFFLINE_RB/results/individual.meta"
printf '%s\t1\t139\t1\n' "$TEST_OFFLINE_CANONICAL_CPU" > "$AUTO_OFFLINE_RB/results/individual.tsv"
# This fixture deliberately reaches the post-individual automatic-CPU guard;
# construct a genuine topology-bound completed group envelope so phase 3 does
# not fail first for the unrelated (and now invalid) marker-only condition.
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$AUTO_OFFLINE_RB" STATE_DIR="$AUTO_OFFLINE_RB/state" GROUP_WAVES=10
  discover_topology
  mkdir -p "$AUTO_OFFLINE_RB/logs/groups"
  groups_plan_prepare
  : > "$AUTO_OFFLINE_RB/results/groups.tsv"
  for ((group_i = 0; group_i < ${#GROUP_NAME[@]}; group_i++)); do
    group_name="${GROUP_NAME[$group_i]}"
    group_children_count="$(group_children "${GROUP_CPUS[$group_i]}")"
    group_log="logs/groups/${group_name}.log"
    {
      printf 'node=v25.2.1 v8=test platform=linux arch=x64 children=%s waves=10\n' "$group_children_count"
      for group_wave in $(seq 1 10); do
        printf 'wave=%s passed=%s/%s\n' "$group_wave" "$group_children_count" "$group_children_count"
      done
      printf 'failedWaves=0 completedWaves=10 requestedWaves=10\n'
    } > "$AUTO_OFFLINE_RB/$group_log"
    printf '%s\t%s\t%s\t%s\t%s\t10\t%s\tgroup-%s\t0\n' \
      "$group_name" "${GROUP_KIND[$group_i]}" "${GROUP_CPUS[$group_i]}" \
      "${GROUP_CLUSTER[$group_i]}" "$group_children_count" "$group_log" "$group_name" \
      >> "$AUTO_OFFLINE_RB/results/groups.tsv"
  done
  groups_meta_publish 1
  rm -f -- "$GROUP_PLAN_TEMP"
) > /dev/null 2>&1
write_preflight_fixture "$AUTO_OFFLINE_RB"
touch "$AUTO_OFFLINE_RB/state"/phase-{preflight,baseline,groups,individual}.done
auto_offline_output="$("$REPO_ROOT/diagnose.sh" --resume "$AUTO_OFFLINE_RB" --yes 2>&1)"
auto_offline_rc=$?
check_eq "stale automatic worst-CPU evidence is rejected by group target provenance" "1" \
  "$([[ $auto_offline_rc -ne 0 && "$auto_offline_output" == *"does not match the validated group target policy"* && ! -e "$AUTO_OFFLINE_RB/state/phase-frequency.done" && ! -e "$AUTO_OFFLINE_RB/state/phase-gdb.done" ]] && echo 1 || echo 0)"

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

PREFLIGHT_TEMP_CLEANUP="$TMP/preflight-temp-cleanup"
mkdir -p "$PREFLIGHT_TEMP_CLEANUP"/{env,results,state}
printf 'manifest temp\n' > "$PREFLIGHT_TEMP_CLEANUP/env/.preflight.manifest.interrupted"
printf 'metadata temp\n' > "$PREFLIGHT_TEMP_CLEANUP/results/.preflight.meta.interrupted"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PREFLIGHT_TEMP_CLEANUP"
  STATE_DIR="$PREFLIGHT_TEMP_CLEANUP/state"
  PREFLIGHT_MANIFEST_TEMP="$PREFLIGHT_TEMP_CLEANUP/env/.preflight.manifest.interrupted"
  PREFLIGHT_META_TEMP="$PREFLIGHT_TEMP_CLEANUP/results/.preflight.meta.interrupted"
  redo_marker_temp_cleanup
)
check_eq "interruption cleanup removes tracked preflight envelope temps" "1" \
  "$([[ ! -e "$PREFLIGHT_TEMP_CLEANUP/env/.preflight.manifest.interrupted" && ! -e "$PREFLIGHT_TEMP_CLEANUP/results/.preflight.meta.interrupted" ]] && echo 1 || echo 0)"

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
privacy_chmod_dependency="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  for command_name in "${REQUIRED_COMMANDS[@]}"; do
    [[ "$command_name" == chmod ]] && printf 1 && exit 0
  done
  printf 0
)"
check_eq "privacy publication declares chmod as a required command" "1" "$privacy_chmod_dependency"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 2 3 0
)
check_eq "complete repro footer is accepted" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 2 4 0
) > /dev/null 2>&1
check_eq "truncated repro output is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 2 3 2
) > /dev/null 2>&1
check_eq "unexpected repro exit is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

REPRO_FOOTER_ONLY="$TMP/repro-footer-only.log"
printf '%s\n' \
  'node=v25.2.1 v8=14.1 platform=linux arch=x64 children=2 waves=3' \
  'failedWaves=0 completedWaves=3 requestedWaves=3' > "$REPRO_FOOTER_ONLY"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$REPRO_FOOTER_ONLY" 2 3 0
) > /dev/null 2>&1
check_eq "footer-only repro output is not phase-complete" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  repro_result_is_complete "$FIX/repro-clean.log" 4 3 0
) > /dev/null 2>&1
check_eq "repro header must match configured children" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

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
  RUN_SCHEMA_VERSION=1
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
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$INDIVIDUAL_COMPLETE"
  STATE_DIR="$INDIVIDUAL_COMPLETE/state"
  META_FILE="$INDIVIDUAL_COMPLETE/results/meta.env"
  INDIVIDUAL_TARGET_CPUS=19
  INDIVIDUAL_TARGET_POLICY=failed-groups
  INDIVIDUAL_GROUP_PLAN_DIGEST="$(printf '0%.0s' {1..64})"
  INDIVIDUAL_GROUP_GENERATION="$GROUPS_TEST_GENERATION"
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
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$INDIVIDUAL_SKIPPED"
  STATE_DIR="$INDIVIDUAL_SKIPPED/state"
  META_FILE="$INDIVIDUAL_SKIPPED/results/meta.env"
  INDIVIDUAL_TARGET_POLICY=quick-skip
  INDIVIDUAL_GROUP_PLAN_DIGEST="$(printf '0%.0s' {1..64})"
  INDIVIDUAL_GROUP_GENERATION="$GROUPS_TEST_GENERATION"
  INDIVIDUAL_RUNS=5
  phase_individual_skipped
) > /dev/null 2>&1
skipped_individual_rc=$?
check_eq "skipped individual phase publishes explicit terminal metadata" "1" \
  "$([[ $skipped_individual_rc -eq 0 && -f "$INDIVIDUAL_SKIPPED/state/phase-individual.done" && ! -s "$INDIVIDUAL_SKIPPED/results/individual.tsv" ]] && grep -q '^SKIPPED=1$' "$INDIVIDUAL_SKIPPED/results/individual.meta" && grep -q '^COMPLETED=1$' "$INDIVIDUAL_SKIPPED/results/individual.meta" && echo 1 || echo 0)"

STALE_INDIVIDUAL_GENERATION=dddddddddddddddddddddddddddddddd
INDIVIDUAL_FRESH_AFTER_REDO="$TMP/individual-fresh-after-redo"
mkdir -p "$INDIVIDUAL_FRESH_AFTER_REDO"/{results,state}
printf '19\t1\t0\t2\n' > "$INDIVIDUAL_FRESH_AFTER_REDO/results/individual.tsv"
printf 'COMPLETED_PHASES=\n' > "$INDIVIDUAL_FRESH_AFTER_REDO/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$INDIVIDUAL_FRESH_AFTER_REDO"
  STATE_DIR="$INDIVIDUAL_FRESH_AFTER_REDO/state"
  META_FILE="$INDIVIDUAL_FRESH_AFTER_REDO/results/meta.env"
  INDIVIDUAL_TARGET_CPUS=19
  INDIVIDUAL_TARGET_POLICY=failed-groups
  INDIVIDUAL_GROUP_PLAN_DIGEST="$(printf '0%.0s' {1..64})"
  INDIVIDUAL_GROUP_GENERATION="$GROUPS_TEST_GENERATION"
  INDIVIDUAL_RUNS=1
  INDIVIDUAL_META_GENERATION="$STALE_INDIVIDUAL_GENERATION"
  INDIVIDUAL_META_ROWS_SHA256="$(printf 'a%.0s' {1..64})"
  INDIVIDUAL_META_ROWS_BYTES=999
  INDIVIDUAL_META_ROW_COUNT=999
  phase_individual
) > /dev/null 2>&1
fresh_individual_rc=$?
fresh_generation="$(sed -n 's/^GENERATION=//p' "$INDIVIDUAL_FRESH_AFTER_REDO/results/individual.meta")"
check_eq "new individual phase never reuses a stale pre-redo generation" "1" \
  "$([[ $fresh_individual_rc -eq 0 && "$fresh_generation" =~ ^[a-f0-9]{32}$ && "$fresh_generation" != "$STALE_INDIVIDUAL_GENERATION" ]] && echo 1 || echo 0)"

INDIVIDUAL_FRESH_SKIP_AFTER_REDO="$TMP/individual-fresh-skip-after-redo"
mkdir -p "$INDIVIDUAL_FRESH_SKIP_AFTER_REDO"/{results,state}
printf 'COMPLETED_PHASES=\n' > "$INDIVIDUAL_FRESH_SKIP_AFTER_REDO/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$INDIVIDUAL_FRESH_SKIP_AFTER_REDO"
  STATE_DIR="$INDIVIDUAL_FRESH_SKIP_AFTER_REDO/state"
  META_FILE="$INDIVIDUAL_FRESH_SKIP_AFTER_REDO/results/meta.env"
  INDIVIDUAL_TARGET_POLICY=quick-skip
  INDIVIDUAL_GROUP_PLAN_DIGEST="$(printf '0%.0s' {1..64})"
  INDIVIDUAL_GROUP_GENERATION="$GROUPS_TEST_GENERATION"
  INDIVIDUAL_RUNS=5
  INDIVIDUAL_META_GENERATION="$STALE_INDIVIDUAL_GENERATION"
  INDIVIDUAL_META_ROWS_SHA256="$(printf 'a%.0s' {1..64})"
  INDIVIDUAL_META_ROWS_BYTES=999
  INDIVIDUAL_META_ROW_COUNT=999
  phase_individual_skipped
) > /dev/null 2>&1
fresh_skip_rc=$?
fresh_skip_generation="$(sed -n 's/^GENERATION=//p' "$INDIVIDUAL_FRESH_SKIP_AFTER_REDO/results/individual.meta")"
check_eq "new skipped individual phase never reuses a stale pre-redo generation" "1" \
  "$([[ $fresh_skip_rc -eq 0 && "$fresh_skip_generation" =~ ^[a-f0-9]{32}$ && "$fresh_skip_generation" != "$STALE_INDIVIDUAL_GENERATION" ]] && echo 1 || echo 0)"

# worst_cpu must rank by the SIGSEGV endpoint only: CPU 3 fails every run
# with a launcher-style exit 1, CPU 4 has one real SIGSEGV.
WORST_CPU_DIR="$TMP/worst-cpu-bundle"
mkdir -p "$WORST_CPU_DIR"/{results,state}
printf '3\t1\t1\t2\n3\t2\t1\t2\n4\t1\t139\t2\n4\t2\t0\t2\n' > "$WORST_CPU_DIR/results/individual.tsv"
write_individual_v4_meta "$WORST_CPU_DIR" 3-4 2 failed-groups \
  "$(printf '0%.0s' {1..64})" "$GROUPS_TEST_GENERATION" 0 1
touch "$WORST_CPU_DIR/state/phase-individual.done"
worst_cpu_out="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$WORST_CPU_DIR"
  worst_cpu
)"
check_eq "worst_cpu rejects an invalid completed individual phase" "" "$worst_cpu_out"
printf '3\t1\t0\t2\n3\t2\t0\t2\n4\t1\t139\t2\n4\t2\t0\t2\n' > "$WORST_CPU_DIR/results/individual.tsv"
write_individual_v4_meta "$WORST_CPU_DIR" 3-4 2 failed-groups \
  "$(printf '0%.0s' {1..64})" "$GROUPS_TEST_GENERATION" 0 1
worst_cpu_out="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$WORST_CPU_DIR"
  worst_cpu
)"
check_eq "worst_cpu ranks only a fully validated individual phase" "4" "$worst_cpu_out"

INDIVIDUAL_FIFO_BASE="$TMP/individual-fifo-base"
mkdir -p "$INDIVIDUAL_FIFO_BASE"/{results,state}
printf '19\t1\t139\t1\n' > "$INDIVIDUAL_FIFO_BASE/results/individual.tsv"
write_individual_v4_meta "$INDIVIDUAL_FIFO_BASE" 19 1 failed-groups \
  "$(printf '0%.0s' {1..64})" "$GROUPS_TEST_GENERATION" 0 1
: > "$INDIVIDUAL_FIFO_BASE/state/phase-individual.done"
individual_fifo_guards=1
for relative in results/individual.tsv results/individual.meta state/phase-individual.done; do
  fifo_bundle="$TMP/individual-fifo-${relative//\//-}"
  cp -a "$INDIVIDUAL_FIFO_BASE" "$fifo_bundle"
  rm "$fifo_bundle/$relative"
  mkfifo "$fifo_bundle/$relative"
  timeout 2 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    individual_phase_result_is_complete
  ' _ "$REPO_ROOT" "$fifo_bundle" > /dev/null 2>&1
  fifo_rc=$?
  [[ "$fifo_rc" != 0 && "$fifo_rc" != 124 ]] || individual_fifo_guards=0
done
check_eq "individual completion reads reject FIFO marker, metadata, and rows without blocking" \
  "1" "$individual_fifo_guards"
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

GDB_COUNTS_GEN=0123456789abcdef0123456789abcdef
# Emit a syntactically canonical runner log: <file> <gen> <cpu> <max_runs>
# <max_captures> <attempted> <clean> <captured> <errors> <exit_code>
write_gdb_counts_log() {
  local file="$1" gen="$2" cpu="$3" mr="$4" mc="$5" att="$6" cl="$7" cap="$8" err="$9" rc="${10}"
  local run c=0 k=0 outcome
  : > "$file"
  for ((run = 1; run <= att; run++)); do
    if ((c < cl)); then c=$((c + 1)); outcome=clean
    elif ((k < cap)); then k=$((k + 1)); outcome=captured
    else outcome=error; fi
    printf 'ATTEMPT\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tRUN\t%s\tOUTCOME\t%s\n' \
      "$gen" "$cpu" "$mr" "$mc" "$run" "$outcome" >> "$file"
  done
  printf 'COUNTS\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tATTEMPTED\t%s\tCLEAN\t%s\tCAPTURED\t%s\tERRORS\t%s\tEXIT_CODE\t%s\n' \
    "$gen" "$cpu" "$mr" "$mc" "$att" "$cl" "$cap" "$err" "$rc" >> "$file"
}

GDB_COUNTS_LOG="$TMP/gdb-counts.log"
write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
gdb_counts_status="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  if gdb_run_counts_read "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1; then
    printf '%s|%s|%s|%s|%s\n' "$GDB_ATTEMPTED_RUNS" "$GDB_CLEAN_RUNS" \
      "$GDB_CAPTURED_RUNS" "$GDB_ERROR_RUNS" "$GDB_RUNNER_EXIT_CODE"
  fi
)"
check_eq "terminal GDB accounting parser retains clean/error split" "6|1|0|5|3" "$gdb_counts_status"

gdb_counts_rejected() {
  local label="$1" gen="$2" cpu="$3" max_runs="$4" max_captures="$5"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    ! gdb_run_counts_read "$GDB_COUNTS_LOG" "$gen" "$cpu" "$max_runs" "$max_captures"
  ) > /dev/null 2>&1
  check_eq "$label" "0" "$?"
}

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
printf 'COUNTS\tGENERATION\t%s\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tATTEMPTED\t6\tCLEAN\t1\tCAPTURED\t0\tERRORS\t5\tEXIT_CODE\t3\n' \
  "$GDB_COUNTS_GEN" >> "$GDB_COUNTS_LOG"
gdb_counts_rejected "duplicate GDB terminal records are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
printf 'ATTEMPT\tGENERATION\t%s\tCPU\t0\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tRUN\t7\tOUTCOME\terror\n' \
  "$GDB_COUNTS_GEN" >> "$GDB_COUNTS_LOG"
gdb_counts_rejected "nonterminal GDB records after the terminal line are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
sed -i '1i run=1 clean' "$GDB_COUNTS_LOG"
gdb_counts_rejected "mixed non-record GDB runner lines are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
sed -i "1s/^/$(printf 'x%.0s' {1..513})/" "$GDB_COUNTS_LOG"
gdb_counts_rejected "overlong GDB runner records are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 7 1 0 6 3
gdb_counts_rejected "GDB attempts beyond the run ceiling are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
gdb_counts_rejected "wrong-generation GDB runner logs are rejected" 00000000000000000000000000000000 0 6 1
gdb_counts_rejected "wrong-CPU GDB runner logs are rejected" "$GDB_COUNTS_GEN" 1 6 1
gdb_counts_rejected "wrong-run-limit GDB runner logs are rejected" "$GDB_COUNTS_GEN" 0 7 1
gdb_counts_rejected "wrong-capture-limit GDB runner logs are rejected" "$GDB_COUNTS_GEN" 0 6 2

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 2 0 2 0 0
gdb_counts_rejected "GDB attempts after the capture cap are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 5
gdb_counts_rejected "GDB terminal records with a runner-failure exit are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
sed -i '2d' "$GDB_COUNTS_LOG"
gdb_counts_rejected "non-contiguous GDB attempt records are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
sed -i '1s/$/\r/' "$GDB_COUNTS_LOG"
gdb_counts_rejected "GDB runner records with carriage returns are rejected" "$GDB_COUNTS_GEN" 0 6 1

write_gdb_counts_log "$GDB_COUNTS_LOG" "$GDB_COUNTS_GEN" 0 6 1 6 1 0 5 3
head -n -1 "$GDB_COUNTS_LOG" > "$GDB_COUNTS_LOG.truncated"
printf '%s' "$(tail -1 "$GDB_COUNTS_LOG")" >> "$GDB_COUNTS_LOG.truncated"
mv "$GDB_COUNTS_LOG.truncated" "$GDB_COUNTS_LOG"
gdb_counts_rejected "GDB runner logs without a trailing newline are rejected" "$GDB_COUNTS_GEN" 0 6 1

GDB_MALFORMED_PHASE="$TMP/gdb-malformed-phase"
mkdir -p "$GDB_MALFORMED_PHASE"/{results,state,logs/gdb,gdb}
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GDB_MALFORMED_PHASE"
  STATE_DIR="$GDB_MALFORMED_PHASE/state"
  GDB_MAX_RUNS=6
  GDB_MAX_CAPTURES=1
  run_gdb_logged() {
    local gen="$6"
    {
      printf 'ATTEMPT\tGENERATION\t%s\tCPU\t19\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tRUN\t1\tOUTCOME\tclean\n' "$gen"
      printf 'COUNTS\tGENERATION\t%s\tCPU\t19\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tATTEMPTED\t1\tCLEAN\t1\tCAPTURED\t0\tERRORS\t4\tEXIT_CODE\t3\n' "$gen"
    } > "$5"
    return 3
  }
  phase_gdb 19
) > /dev/null 2>&1
malformed_phase_rc=$?
check_eq "malformed GDB accounting cannot close the phase" "1" \
  "$([[ $malformed_phase_rc -ne 0 && ! -e "$GDB_MALFORMED_PHASE/state/phase-gdb.done" ]] && echo 1 || echo 0)"

# A self-consistent terminal record whose EXIT_CODE disagrees with the runner
# process status must die at the agreement check, not at a later stage.
GDB_DISAGREE_PHASE="$TMP/gdb-exit-disagreement-phase"
mkdir -p "$GDB_DISAGREE_PHASE"/{results,state,logs/gdb,gdb}
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GDB_DISAGREE_PHASE"
  STATE_DIR="$GDB_DISAGREE_PHASE/state"
  GDB_MAX_RUNS=6
  GDB_MAX_CAPTURES=1
  run_gdb_logged() {
    local gen="$6"
    {
      printf 'ATTEMPT\tGENERATION\t%s\tCPU\t19\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tRUN\t1\tOUTCOME\tcaptured\n' "$gen"
      printf 'COUNTS\tGENERATION\t%s\tCPU\t19\tMAX_RUNS\t6\tMAX_CAPTURES\t1\tATTEMPTED\t1\tCLEAN\t0\tCAPTURED\t1\tERRORS\t0\tEXIT_CODE\t0\n' "$gen"
    } > "$5"
    return 3
  }
  phase_gdb 19
) > /dev/null 2> "$GDB_DISAGREE_PHASE.stderr"
disagree_phase_rc=$?
check_eq "a runner status disagreeing with its terminal accounting cannot close the phase" \
  "1" "$([[ $disagree_phase_rc -ne 0 && ! -e "$GDB_DISAGREE_PHASE/state/phase-gdb.done" ]] &&
    grep -q 'exit status conflicts with its terminal accounting' \
      "$GDB_DISAGREE_PHASE.stderr" && echo 1 || echo 0)"

FREQUENCY_COMPLETE="$TMP/frequency-complete"
mkdir -p "$FREQUENCY_COMPLETE/results" "$FREQUENCY_COMPLETE/freq"
printf 'A1\t1\t139\t2\nB\t1\t0\t3\nA2\t1\t0\t2\n' > "$FREQUENCY_COMPLETE/results/frequency-ab.tsv"
for leg in A1 B A2; do
  printf 'scaling_cur_freq\n' > "$FREQUENCY_COMPLETE/freq/freq-ab-${leg}.method"
  printf '1753950000 19 4200000\n' > "$FREQUENCY_COMPLETE/freq/freq-ab-${leg}.samples"
done
write_frequency_ab_fixture_meta "$FREQUENCY_COMPLETE" 19 1
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete 19
)
check_eq "complete restored frequency A/B/A evidence is accepted" "0" "$?"
mkdir -p "$FREQUENCY_COMPLETE/state"
touch "$FREQUENCY_COMPLETE/state/phase-frequency.done"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  frequency_result_is_complete 19 --complete
) > /dev/null 2>&1
check_eq "completed frequency marker authorizes only its strict evidence envelope" "0" "$?"
rm -f "$FREQUENCY_COMPLETE/state/phase-frequency.done"
ln -s "$FREQUENCY_COMPLETE/state/missing-marker" "$FREQUENCY_COMPLETE/state/phase-frequency.done"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$FREQUENCY_COMPLETE"
  ! frequency_result_is_complete 19 --ready && ! frequency_result_is_complete 19 --complete
) > /dev/null 2>&1
check_eq "frequency evidence rejects a dangling completion marker in every mode" "0" "$?"
rm -f "$FREQUENCY_COMPLETE/state/phase-frequency.done"
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
# A completely empty directory is recovered as an interrupted fresh
# initialization (see the fresh-init recovery tests); this fixture keeps an
# entry so the directory stays a non-bundle.
mkdir -p "$TMP/not-a-bundle"
printf 'unrelated content\n' > "$TMP/not-a-bundle/notes.txt"
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
"$REPO_ROOT/diagnose.sh" --individual-runs 01 --dry-run --yes > /dev/null 2>&1
noncanonical_individual_rc=$?
check_eq "non-canonical individual runs are rejected before execution" "1" \
  "$([[ $noncanonical_individual_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --individual-runs 9007199254740992 --dry-run --yes > /dev/null 2>&1
oversized_individual_rc=$?
check_eq "oversized individual runs are rejected before execution" "1" \
  "$([[ $oversized_individual_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --gdb-max-runs 9007199254740992 --dry-run --yes > /dev/null 2>&1
oversized_gdb_rc=$?
check_eq "oversized gdb attempts are rejected before execution" "1" \
  "$([[ $oversized_gdb_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --gdb-max-runs 4097 --dry-run --yes > /dev/null 2>&1
overlimit_gdb_rc=$?
check_eq "gdb attempts above the evidence envelope limit are rejected before execution" "1" \
  "$([[ $overlimit_gdb_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --gdb-max-runs 4096 --dry-run --yes > /dev/null 2>&1
check_eq "gdb attempts at the evidence envelope limit are accepted" "0" "$?"
GDB_LIMIT_BUNDLE="$TMP/gdb-overlimit-stored"
mkdir -p "$GDB_LIMIT_BUNDLE/results"
cp "$RB/results/meta.env" "$GDB_LIMIT_BUNDLE/results/meta.env"
sed -i 's/^GDB_MAX_RUNS=.*/GDB_MAX_RUNS=4097/' "$GDB_LIMIT_BUNDLE/results/meta.env"
"$REPO_ROOT/diagnose.sh" --resume "$GDB_LIMIT_BUNDLE" --dry-run --yes > /dev/null 2>&1
overlimit_stored_rc=$?
check_eq "stored gdb attempts above the envelope limit are rejected before resume mutation" "1" \
  "$([[ $overlimit_stored_rc -ne 0 && ! -e "$GDB_LIMIT_BUNDLE/commands.log" ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --group-waves 010 --dry-run --yes > /dev/null 2>&1
noncanonical_group_waves_rc=$?
check_eq "non-canonical group waves are rejected before execution" "1" \
  "$([[ $noncanonical_group_waves_rc -ne 0 ]] && echo 1 || echo 0)"
"$REPO_ROOT/diagnose.sh" --cpu 01 --dry-run --yes > /dev/null 2>&1
noncanonical_cpu_rc=$?
check_eq "non-canonical CPU overrides are rejected before execution" "1" \
  "$([[ $noncanonical_cpu_rc -ne 0 ]] && echo 1 || echo 0)"
unsafe_stored_counts_rejected=0
for unsafe_key in INDIVIDUAL_RUNS GDB_MAX_RUNS; do
  UNSAFE_COUNT_BUNDLE="$TMP/unsafe-count-bundle-${unsafe_key,,}"
  mkdir -p "$UNSAFE_COUNT_BUNDLE/results"
  cp "$RB/results/meta.env" "$UNSAFE_COUNT_BUNDLE/results/meta.env"
  sed -i "s/^${unsafe_key}=.*/${unsafe_key}=9007199254740992/" \
    "$UNSAFE_COUNT_BUNDLE/results/meta.env"
  if ! "$REPO_ROOT/diagnose.sh" --resume "$UNSAFE_COUNT_BUNDLE" --dry-run --yes > /dev/null 2>&1; then
    unsafe_stored_counts_rejected=$((unsafe_stored_counts_rejected + 1))
  fi
done
check_eq "oversized stored individual and gdb counts are rejected before resume mutation" \
  "2" "$unsafe_stored_counts_rejected"
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

write_gdb_skip_fixture "$GDB_SKIP_RB" "--skip-gdb" 6 3
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
write_gdb_run_fixture "$GDB_RUN_RB" 0 6 3 no-fault
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
write_gdb_run_fixture "$OVERRIDE_RB" 19 6 3 captured
touch "$OVERRIDE_RB/state/phase-individual.done"
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
mkdir -p "$PRIVACY_BUNDLE/raw" "$PRIVACY_BUNDLE/nested"
printf 'path=%s/private token=550e8400-e29b-41d4-a716-446655440000\n' "$HOME" > "$PRIVACY_BUNDLE/raw/tool.txt"
printf 'nested token 11111111-2222-3333-4444-555555555555\n' \
  > "$PRIVACY_BUNDLE/nested/privacy-review.txt"
printf 'nested mac aa:bb:cc:dd:ee:ff\n' > "$PRIVACY_BUNDLE/nested/manifest.txt"
printf 'stale manifest\n' > "$PRIVACY_BUNDLE/manifest.txt"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PRIVACY_BUNDLE"
  SCRIPT_DIR="$REPO_ROOT"
  write_privacy_review
)
check_eq "privacy scan flags files without copying sentinel values" "1" \
  "$([[ "$(grep -c $'^known-home-path\traw/tool.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c $'^uuid-shape\traw/tool.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c $'^uuid-shape\tnested/privacy-review.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c $'^mac-shape\tnested/manifest.txt$' "$PRIVACY_BUNDLE/privacy-review.txt")" == 1 && "$(grep -c '550e8400' "$PRIVACY_BUNDLE/privacy-review.txt")" == 0 && ! -e "$PRIVACY_BUNDLE/manifest.txt" && "$(stat -c '%a' "$PRIVACY_BUNDLE/privacy-review.txt")" == 644 ]] && ! compgen -G "$PRIVACY_BUNDLE.privacy-*" > /dev/null && echo 1 || echo 0)"

privacy_write_fixture() {
  local bundle="$1" output="$2"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    OUT_DIR="$bundle"
    SCRIPT_DIR="$REPO_ROOT"
    write_privacy_review
  ) > "$output" 2>&1
}

PRIVACY_LINK_DEST="$TMP/privacy-link-destination"
mkdir -p "$PRIVACY_LINK_DEST/bundle/raw"
printf 'clean payload\n' > "$PRIVACY_LINK_DEST/bundle/raw/data.txt"
printf 'do not overwrite symlink victim\n' > "$PRIVACY_LINK_DEST/victim"
ln -s "$PRIVACY_LINK_DEST/victim" "$PRIVACY_LINK_DEST/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_LINK_DEST/bundle/manifest.txt"
privacy_write_fixture "$PRIVACY_LINK_DEST/bundle" "$PRIVACY_LINK_DEST/output"
privacy_link_dest_rc=$?
check_eq "privacy publication atomically replaces a stale review symlink without following it" "1" \
  "$([[ $privacy_link_dest_rc -eq 0 && "$(cat "$PRIVACY_LINK_DEST/victim")" == 'do not overwrite symlink victim' && -f "$PRIVACY_LINK_DEST/bundle/privacy-review.txt" && ! -L "$PRIVACY_LINK_DEST/bundle/privacy-review.txt" && ! -e "$PRIVACY_LINK_DEST/bundle/manifest.txt" ]] && grep -Fxq $'status\tno-known-sentinels' "$PRIVACY_LINK_DEST/bundle/privacy-review.txt" && ! compgen -G "$PRIVACY_LINK_DEST/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

for unsafe_review_kind in directory fifo; do
  PRIVACY_UNSAFE_DEST="$TMP/privacy-unsafe-review-$unsafe_review_kind"
  mkdir -p "$PRIVACY_UNSAFE_DEST/bundle/raw"
  printf 'clean payload\n' > "$PRIVACY_UNSAFE_DEST/bundle/raw/data.txt"
  printf 'stale manifest\n' > "$PRIVACY_UNSAFE_DEST/bundle/manifest.txt"
  if [[ "$unsafe_review_kind" == directory ]]; then
    mkdir "$PRIVACY_UNSAFE_DEST/bundle/privacy-review.txt"
  else
    mkfifo "$PRIVACY_UNSAFE_DEST/bundle/privacy-review.txt"
  fi
  timeout --signal=TERM --kill-after=1 5 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    SCRIPT_DIR="$1"
    write_privacy_review
  ' _ "$REPO_ROOT" "$PRIVACY_UNSAFE_DEST/bundle" \
    > "$PRIVACY_UNSAFE_DEST/output" 2>&1
  privacy_unsafe_dest_rc=$?
  check_eq "privacy publication rejects a $unsafe_review_kind review destination without blocking" "1" \
    "$([[ $privacy_unsafe_dest_rc -eq 1 && ! -e "$PRIVACY_UNSAFE_DEST/bundle/manifest.txt" ]] && [[ $unsafe_review_kind == directory && -d "$PRIVACY_UNSAFE_DEST/bundle/privacy-review.txt" || $unsafe_review_kind == fifo && -p "$PRIVACY_UNSAFE_DEST/bundle/privacy-review.txt" ]] && ! compgen -G "$PRIVACY_UNSAFE_DEST/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"
done

PRIVACY_UNSAFE_LINK="$TMP/privacy-unsafe-link"
mkdir -p "$PRIVACY_UNSAFE_LINK/bundle/raw"
printf 'old review\n' > "$PRIVACY_UNSAFE_LINK/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_UNSAFE_LINK/bundle/manifest.txt"
printf 'external payload\n' > "$PRIVACY_UNSAFE_LINK/victim"
ln -s "$PRIVACY_UNSAFE_LINK/victim" "$PRIVACY_UNSAFE_LINK/bundle/raw/link"
privacy_write_fixture "$PRIVACY_UNSAFE_LINK/bundle" "$PRIVACY_UNSAFE_LINK/output"
privacy_unsafe_link_rc=$?
check_eq "privacy inventory rejects non-control symlinks without touching their targets" "1" \
  "$([[ $privacy_unsafe_link_rc -ne 0 && "$(cat "$PRIVACY_UNSAFE_LINK/victim")" == 'external payload' && "$(cat "$PRIVACY_UNSAFE_LINK/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_UNSAFE_LINK/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_UNSAFE_LINK/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

PRIVACY_SPECIAL="$TMP/privacy-special-entry"
mkdir -p "$PRIVACY_SPECIAL/bundle/raw"
printf 'old review\n' > "$PRIVACY_SPECIAL/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_SPECIAL/bundle/manifest.txt"
mkfifo "$PRIVACY_SPECIAL/bundle/raw/fifo"
timeout --signal=TERM --kill-after=1 5 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  SCRIPT_DIR="$1"
  write_privacy_review
' _ "$REPO_ROOT" "$PRIVACY_SPECIAL/bundle" > "$PRIVACY_SPECIAL/output" 2>&1
privacy_special_rc=$?
check_eq "privacy inventory rejects special files without blocking" "1" \
  "$([[ $privacy_special_rc -eq 1 && "$(cat "$PRIVACY_SPECIAL/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_SPECIAL/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_SPECIAL/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

PRIVACY_CONTROL_NAME="$TMP/privacy-control-name"
mkdir -p "$PRIVACY_CONTROL_NAME/bundle/raw"
printf 'unsafe pathname\n' > "$PRIVACY_CONTROL_NAME/bundle/raw/"$'tab\tname'
printf 'old review\n' > "$PRIVACY_CONTROL_NAME/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_CONTROL_NAME/bundle/manifest.txt"
privacy_write_fixture "$PRIVACY_CONTROL_NAME/bundle" "$PRIVACY_CONTROL_NAME/output"
privacy_control_name_rc=$?
check_eq "privacy inventory rejects control characters in relative names" "1" \
  "$([[ $privacy_control_name_rc -ne 0 && "$(cat "$PRIVACY_CONTROL_NAME/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_CONTROL_NAME/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_CONTROL_NAME/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

if ((EUID != 0)); then
  PRIVACY_UNREADABLE="$TMP/privacy-unreadable"
  mkdir -p "$PRIVACY_UNREADABLE/bundle/raw"
  printf 'unreadable payload\n' > "$PRIVACY_UNREADABLE/bundle/raw/data.txt"
  chmod 000 "$PRIVACY_UNREADABLE/bundle/raw/data.txt"
  printf 'old review\n' > "$PRIVACY_UNREADABLE/bundle/privacy-review.txt"
  printf 'stale manifest\n' > "$PRIVACY_UNREADABLE/bundle/manifest.txt"
  privacy_write_fixture "$PRIVACY_UNREADABLE/bundle" "$PRIVACY_UNREADABLE/output"
  privacy_unreadable_rc=$?
  chmod 0600 "$PRIVACY_UNREADABLE/bundle/raw/data.txt"
  check_eq "privacy inventory rejects unreadable regular files" "1" \
    "$([[ $privacy_unreadable_rc -ne 0 && "$(cat "$PRIVACY_UNREADABLE/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_UNREADABLE/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_UNREADABLE/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

  PRIVACY_UNREADABLE_DIR="$TMP/privacy-unreadable-directory"
  mkdir -p "$PRIVACY_UNREADABLE_DIR/bundle/raw/locked"
  printf 'hidden payload\n' > "$PRIVACY_UNREADABLE_DIR/bundle/raw/locked/data.txt"
  chmod 000 "$PRIVACY_UNREADABLE_DIR/bundle/raw/locked"
  printf 'old review\n' > "$PRIVACY_UNREADABLE_DIR/bundle/privacy-review.txt"
  printf 'stale manifest\n' > "$PRIVACY_UNREADABLE_DIR/bundle/manifest.txt"
  privacy_write_fixture "$PRIVACY_UNREADABLE_DIR/bundle" "$PRIVACY_UNREADABLE_DIR/output"
  privacy_unreadable_dir_rc=$?
  chmod 0700 "$PRIVACY_UNREADABLE_DIR/bundle/raw/locked"
  check_eq "privacy inventory rejects unreadable directories" "1" \
    "$([[ $privacy_unreadable_dir_rc -ne 0 && "$(cat "$PRIVACY_UNREADABLE_DIR/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_UNREADABLE_DIR/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_UNREADABLE_DIR/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"
else
  ok "privacy inventory rejects unreadable regular files [skipped while tests run as root]"
  ok "privacy inventory rejects unreadable directories [skipped while tests run as root]"
fi

PRIVACY_COMMAND_FAIL="$TMP/privacy-command-failures"
mkdir -p "$PRIVACY_COMMAND_FAIL/bin" "$PRIVACY_COMMAND_FAIL/find-bundle/raw" \
  "$PRIVACY_COMMAND_FAIL/sort-bundle/raw" "$PRIVACY_COMMAND_FAIL/grep-bundle/raw" \
  "$PRIVACY_COMMAND_FAIL/node-bundle/raw"
PRIVACY_REAL_FIND="$(command -v find)"
PRIVACY_REAL_GREP="$(command -v grep)"
cat > "$PRIVACY_COMMAND_FAIL/bin/find" << 'EOF'
#!/usr/bin/env bash
"$DIAG_TEST_REAL_FIND" "$@"
exit 7
EOF
cat > "$PRIVACY_COMMAND_FAIL/bin/grep" << 'EOF'
#!/usr/bin/env bash
exit 2
EOF
cat > "$PRIVACY_COMMAND_FAIL/bin/sort" << 'EOF'
#!/usr/bin/env bash
exit 7
EOF
cat > "$PRIVACY_COMMAND_FAIL/bin/node" << 'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$PRIVACY_COMMAND_FAIL/bin/find" "$PRIVACY_COMMAND_FAIL/bin/sort" \
  "$PRIVACY_COMMAND_FAIL/bin/grep" "$PRIVACY_COMMAND_FAIL/bin/node"
for command_case in find sort grep node; do
  command_bundle="$PRIVACY_COMMAND_FAIL/${command_case}-bundle"
  printf 'private-secret-550e8400-e29b-41d4-a716-446655440000\n' \
    > "$command_bundle/raw/data.txt"
  printf 'old review\n' > "$command_bundle/privacy-review.txt"
  printf 'stale manifest\n' > "$command_bundle/manifest.txt"
  command_bin="$PRIVACY_COMMAND_FAIL/${command_case}-bin"
  mkdir -p "$command_bin"
  ln -s "$PRIVACY_COMMAND_FAIL/bin/$command_case" "$command_bin/$command_case"
  PATH="$command_bin:$PATH" \
    DIAG_TEST_REAL_FIND="$PRIVACY_REAL_FIND" \
    timeout --signal=TERM --kill-after=1 5 bash -c '
      DIAG_SOURCE_ONLY=1
      source "$1/diagnose.sh"
      OUT_DIR="$2"
      SCRIPT_DIR="$1"
      write_privacy_review
    ' _ "$REPO_ROOT" "$command_bundle" > "$PRIVACY_COMMAND_FAIL/$command_case.output" 2>&1
  command_fail_rc=$?
  check_eq "privacy scan fails closed without secret leakage when $command_case fails" "1" \
    "$([[ $command_fail_rc -eq 1 && "$(cat "$command_bundle/privacy-review.txt")" == 'old review' && ! -e "$command_bundle/manifest.txt" ]] && ! grep -q 'private-secret\|550e8400' "$PRIVACY_COMMAND_FAIL/$command_case.output" && ! compgen -G "$command_bundle.privacy-*" > /dev/null && echo 1 || echo 0)"
done

PRIVACY_DEVICE_MISMATCH="$TMP/privacy-device-mismatch"
mkdir -p "$PRIVACY_DEVICE_MISMATCH/bin" "$PRIVACY_DEVICE_MISMATCH/bundle/raw"
printf 'private-secret-550e8400-e29b-41d4-a716-446655440000\n' \
  > "$PRIVACY_DEVICE_MISMATCH/bundle/raw/data.txt"
printf 'old review\n' > "$PRIVACY_DEVICE_MISMATCH/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_DEVICE_MISMATCH/bundle/manifest.txt"
PRIVACY_REAL_STAT="$(command -v stat)"
cat > "$PRIVACY_DEVICE_MISMATCH/bin/stat" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == -c && "$2" == '%d' && "${@: -1}" == *.privacy-review.* ]]; then
  printf '999999999\n'
  exit 0
fi
exec "$DIAG_TEST_REAL_STAT" "$@"
EOF
chmod +x "$PRIVACY_DEVICE_MISMATCH/bin/stat"
PATH="$PRIVACY_DEVICE_MISMATCH/bin:$PATH" \
  DIAG_TEST_REAL_STAT="$PRIVACY_REAL_STAT" \
  timeout --signal=TERM --kill-after=1 5 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    SCRIPT_DIR="$1"
    write_privacy_review
  ' _ "$REPO_ROOT" "$PRIVACY_DEVICE_MISMATCH/bundle" \
  > "$PRIVACY_DEVICE_MISMATCH/output" 2>&1
privacy_device_mismatch_rc=$?
check_eq "privacy publication rejects cross-device sibling candidates before scanning" "1" \
  "$([[ $privacy_device_mismatch_rc -eq 1 && "$(cat "$PRIVACY_DEVICE_MISMATCH/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_DEVICE_MISMATCH/bundle/manifest.txt" ]] && grep -Fxq 'error: privacy publication candidates are not on the bundle filesystem' "$PRIVACY_DEVICE_MISMATCH/output" && ! grep -q 'private-secret\|550e8400' "$PRIVACY_DEVICE_MISMATCH/output" && ! compgen -G "$PRIVACY_DEVICE_MISMATCH/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

PRIVACY_RACE="$TMP/privacy-inventory-race"
mkdir -p "$PRIVACY_RACE/bin" "$PRIVACY_RACE/bundle/raw"
printf 'stable payload\n' > "$PRIVACY_RACE/bundle/raw/data.txt"
printf 'old review\n' > "$PRIVACY_RACE/bundle/privacy-review.txt"
printf 'stale manifest\n' > "$PRIVACY_RACE/bundle/manifest.txt"
cat > "$PRIVACY_RACE/bin/grep" << 'EOF'
#!/usr/bin/env bash
if (set -o noclobber; : > "$DIAG_TEST_RACE_MARKER") 2> /dev/null; then
  printf 'late inventory entry\n' > "$DIAG_TEST_RACE_FILE"
fi
exec "$DIAG_TEST_REAL_GREP" "$@"
EOF
chmod +x "$PRIVACY_RACE/bin/grep"
PATH="$PRIVACY_RACE/bin:$PATH" \
  DIAG_TEST_REAL_GREP="$PRIVACY_REAL_GREP" \
  DIAG_TEST_RACE_MARKER="$PRIVACY_RACE/triggered" \
  DIAG_TEST_RACE_FILE="$PRIVACY_RACE/bundle/raw/late.txt" \
  timeout --signal=TERM --kill-after=1 5 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    SCRIPT_DIR="$1"
    write_privacy_review
  ' _ "$REPO_ROOT" "$PRIVACY_RACE/bundle" > "$PRIVACY_RACE/output" 2>&1
privacy_race_rc=$?
check_eq "privacy scan rejects inventory growth during sentinel probes" "1" \
  "$([[ $privacy_race_rc -eq 1 && -f "$PRIVACY_RACE/bundle/raw/late.txt" && "$(cat "$PRIVACY_RACE/bundle/privacy-review.txt")" == 'old review' && ! -e "$PRIVACY_RACE/bundle/manifest.txt" ]] && ! compgen -G "$PRIVACY_RACE/bundle.privacy-*" > /dev/null && echo 1 || echo 0)"

PRIVACY_FD_FAIL="$TMP/privacy-fd-cleanup"
mkdir -p "$PRIVACY_FD_FAIL/bin" "$PRIVACY_FD_FAIL/bundle/raw"
printf 'payload\n' > "$PRIVACY_FD_FAIL/bundle/raw/data.txt"
ln -s "$PRIVACY_COMMAND_FAIL/bin/grep" "$PRIVACY_FD_FAIL/bin/grep"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$PRIVACY_FD_FAIL/bundle"
  SCRIPT_DIR="$REPO_ROOT"
  PATH="$PRIVACY_FD_FAIL/bin:$PATH"
  before_fds="$(find /proc/self/fd -mindepth 1 -maxdepth 1 -printf x | wc -c)"
  for _ in 1 2 3; do
    write_privacy_review > /dev/null 2>&1 && exit 1
  done
  after_fds="$(find /proc/self/fd -mindepth 1 -maxdepth 1 -printf x | wc -c)"
  [[ "$after_fds" == "$before_fds" && -z "$PRIVACY_REVIEW_FD" &&
    -z "$PRIVACY_INVENTORY_BEFORE_FD" && -z "$PRIVACY_INVENTORY_AFTER_FD" ]]
) > /dev/null 2>&1
check_eq "repeated privacy scan failures close their candidate descriptor" "0" "$?"

PRIVACY_FINALIZE_FAIL="$TMP/privacy-finalization-failure"
mkdir -p "$PRIVACY_FINALIZE_FAIL/bundle"/{raw,results,state}
printf 'payload\n' > "$PRIVACY_FINALIZE_FAIL/bundle/raw/data.txt"
printf 'MODE=quick\n' > "$PRIVACY_FINALIZE_FAIL/bundle/results/meta.env"
printf 'stale manifest\n' > "$PRIVACY_FINALIZE_FAIL/bundle/manifest.txt"
timeout --signal=TERM --kill-after=1 5 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  META_FILE="$2/results/meta.env"
  STATE_DIR="$2/state"
  SCRIPT_DIR="$1"
  DIAG_LOG_FILE=""
  PATH="$3:$PATH"
  manifest_called="$4"
  persist_session_end() { :; }
  sync_meta_completed() { :; }
  node() { :; }
  write_manifest() { : > "$manifest_called"; }
  complete_diagnostic
' _ "$REPO_ROOT" "$PRIVACY_FINALIZE_FAIL/bundle" "$PRIVACY_FD_FAIL/bin" \
  "$PRIVACY_FINALIZE_FAIL/manifest-called" > "$PRIVACY_FINALIZE_FAIL/output" 2>&1
privacy_finalize_fail_rc=$?
check_eq "privacy failure suppresses manifest generation and final success" "1" \
  "$([[ $privacy_finalize_fail_rc -eq 1 && ! -e "$PRIVACY_FINALIZE_FAIL/manifest-called" && ! -e "$PRIVACY_FINALIZE_FAIL/bundle/manifest.txt" ]] && ! grep -q 'done\. Bundle' "$PRIVACY_FINALIZE_FAIL/output" && echo 1 || echo 0)"

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

echo "== baseline evidence envelope =="
BASELINE_RUNNER="$TMP/baseline-runner"
mkdir -p "$BASELINE_RUNNER"/{results,logs,state,freq}
printf 'BASELINE_CHILDREN=4\nBASELINE_WAVES=5\nCOMPLETED_PHASES=\n' > "$BASELINE_RUNNER/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$BASELINE_RUNNER"
  STATE_DIR="$BASELINE_RUNNER/state"
  META_FILE="$BASELINE_RUNNER/results/meta.env"
  DIAG_LOG_FILE=""
  BASELINE_CHILDREN=4
  BASELINE_WAVES=5
  diag_freq_sampler_start() { :; }
  diag_freq_sampler_stop() { :; }
  run_repro_logged() { cp "$FIX/repro-fail.log" "$1"; REPRO_RC=1; }
  phase_baseline
) > "$TMP/baseline-runner.output" 2>&1
baseline_runner_rc=$?
check_eq "baseline validates its envelope before publishing completion" "1" \
  "$([[ $baseline_runner_rc -eq 0 && -f "$BASELINE_RUNNER/state/phase-baseline.done" ]] && echo 1 || echo 0)"

baseline_fresh_guards=1
for relative in results/baseline.meta logs/baseline/run1.log state/phase-baseline.done freq/baseline.samples freq/baseline.method; do
  guard="$TMP/baseline-guard-${relative//\//-}"
  mkdir -p "$guard"/{results,logs/baseline,state,freq}
  : > "$guard/$relative"
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    RUN_SCHEMA_VERSION=1
    OUT_DIR="$guard"
    STATE_DIR="$guard/state"
    baseline_prepare_fresh_targets
  ) > "$guard/output" 2>&1 && baseline_fresh_guards=0
  grep -q -- '--redo baseline' "$guard/output" || baseline_fresh_guards=0
done
check_eq "fresh baseline refuses every preexisting fixed output and requires redo" "1" "$baseline_fresh_guards"

BASELINE_SYMLINK_GUARD="$TMP/baseline-symlink-guard"
mkdir -p "$BASELINE_SYMLINK_GUARD"/{results,logs/baseline,state,freq}
ln -s "$TMP/outside-baseline-samples" "$BASELINE_SYMLINK_GUARD/freq/baseline.samples"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$BASELINE_SYMLINK_GUARD"
  STATE_DIR="$BASELINE_SYMLINK_GUARD/state"
  baseline_prepare_fresh_targets
) > "$BASELINE_SYMLINK_GUARD/output" 2>&1
baseline_symlink_rc=$?
check_eq "fresh baseline refuses dangling sampler symlink" "1" \
  "$([[ $baseline_symlink_rc -ne 0 ]] && grep -q -- '--redo baseline' "$BASELINE_SYMLINK_GUARD/output" && echo 1 || echo 0)"

echo "== groups evidence envelope runner =="
GROUPS_RUNNER="$TMP/groups-runner"
mkdir -p "$GROUPS_RUNNER"/{results,logs,state,freq}
printf 'BASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\nCOMPLETED_PHASES=\n' > "$GROUPS_RUNNER/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_RUNNER"
  STATE_DIR="$GROUPS_RUNNER/state"
  META_FILE="$GROUPS_RUNNER/results/meta.env"
  DIAG_LOG_FILE=""
  GROUP_WAVES=5
  GROUP_NAME=(pcores ecluster-64)
  GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19)
  GROUP_CLUSTER=(- 64)
  diag_freq_sampler_start() { :; }
  diag_freq_sampler_stop() { :; }
  run_repro_logged() {
    if [[ "$1" == */pcores.log ]]; then cp "$FIX/repro-clean-4x5.log" "$1"; REPRO_RC=0
    else cp "$FIX/repro-fail.log" "$1"; REPRO_RC=1
    fi
  }
  phase_groups
) > "$GROUPS_RUNNER/output" 2>&1
groups_runner_rc=$?
check_eq "groups validates its exact plan envelope before publishing completion" "1" \
  "$([[ $groups_runner_rc -eq 0 && -f "$GROUPS_RUNNER/state/phase-groups.done" && "$(sed -n 's/^COMPLETED=//p' "$GROUPS_RUNNER/results/groups.meta")" == 1 ]] && echo 1 || echo 0)"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_RUNNER" STATE_DIR="$GROUPS_RUNNER/state" GROUP_WAVES=5
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
  groups_evidence_is_complete
) > /dev/null 2>&1
check_eq "completed groups envelope validates on resume" "0" "$?"

full_runner_target="$(
 (
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_RUNNER" STATE_DIR="$GROUPS_RUNNER/state" GROUP_WAVES=5 MODE=full
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
  if compute_individual_targets; then
    result="$INDIVIDUAL_TARGET_CPUS|$INDIVIDUAL_TARGET_POLICY|$INDIVIDUAL_GROUP_PLAN_DIGEST|$INDIVIDUAL_GROUP_GENERATION"
  else
    result="unexpected-skip"
  fi
  redo_marker_temp_cleanup
  printf '%s\n' "$result"
 ) 2> /dev/null
)"
IFS='|' read -r full_runner_cpus full_runner_policy full_runner_digest full_runner_generation <<< "$full_runner_target"
check_eq "full-mode runner targets every validated stored-plan CPU after a group failure" \
  "0-3,16-19|all-group-cpus|1|1" \
  "$full_runner_cpus|$full_runner_policy|$([[ "$full_runner_digest" =~ ^[a-f0-9]{64}$ ]] && echo 1 || echo 0)|$([[ "$full_runner_generation" =~ ^[a-f0-9]{32}$ ]] && echo 1 || echo 0)"
groups_runner_generation="$(sed -n 's/^GENERATION=//p' "$GROUPS_RUNNER/results/groups.meta")"
check_eq "validated groups envelope carries its published generation" "1" \
  "$([[ "$groups_runner_generation" == "$full_runner_generation" ]] && echo 1 || echo 0)"

FULL_TARGET_RESUME="$TMP/full-target-resume"
mkdir -p "$FULL_TARGET_RESUME"/{results,state}
for cpu in 16 17 18 19; do printf '%s\t1\t0\t1\n' "$cpu"; done > "$FULL_TARGET_RESUME/results/individual.tsv"
write_individual_v4_meta "$FULL_TARGET_RESUME" 16-19 1 failed-groups \
  "$full_runner_digest" "$full_runner_generation" 0 1
: > "$FULL_TARGET_RESUME/state/phase-individual.done"
full_stale_resume="$(
 (
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$FULL_TARGET_RESUME" INDIVIDUAL_RUNS=1
  INDIVIDUAL_TARGET_CPUS=0-3,16-19 INDIVIDUAL_TARGET_POLICY=all-group-cpus
  INDIVIDUAL_GROUP_PLAN_DIGEST="$full_runner_digest"
  INDIVIDUAL_GROUP_GENERATION="$full_runner_generation"
  self_consistent=0 compatible=0
  individual_phase_result_is_complete && self_consistent=1
  individual_phase_matches_expected_targets 1 && compatible=1
  printf '%s|%s\n' "$self_consistent" "$compatible"
 ) 2> /dev/null
)"
check_eq "full-mode resume rejects self-consistent failed-group-only evidence" "1|0" "$full_stale_resume"

for cpu in 0 1 2 3 16 17 18 19; do printf '%s\t1\t0\t1\n' "$cpu"; done > "$FULL_TARGET_RESUME/results/individual.tsv"
write_individual_v4_meta "$FULL_TARGET_RESUME" 0-3,16-19 1 all-group-cpus \
  "$full_runner_digest" "$full_runner_generation" 0 1
full_current_resume="$(
 (
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$FULL_TARGET_RESUME" INDIVIDUAL_RUNS=1
  INDIVIDUAL_TARGET_CPUS=0-3,16-19 INDIVIDUAL_TARGET_POLICY=all-group-cpus
  INDIVIDUAL_GROUP_PLAN_DIGEST="$full_runner_digest"
  INDIVIDUAL_GROUP_GENERATION="$full_runner_generation"
  self_consistent=0 compatible=0
  individual_phase_result_is_complete && self_consistent=1
  individual_phase_matches_expected_targets 1 && compatible=1
  printf '%s|%s\n' "$self_consistent" "$compatible"
 ) 2> /dev/null
)"
check_eq "full-mode resume accepts complete all-plan evidence" "1|1" "$full_current_resume"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_RUNNER" STATE_DIR="$GROUPS_RUNNER/state" GROUP_WAVES=5
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 20-23) GROUP_CLUSTER=(- 64)
  groups_evidence_is_complete
) > /dev/null 2>&1
groups_plan_mismatch_rc=$?
check_eq "resume rejects a rediscovered topology-plan generation mismatch" "1" "$([[ $groups_plan_mismatch_rc -ne 0 ]] && echo 1 || echo 0)"

GROUPS_PARTIAL="$TMP/groups-partial"
mkdir -p "$GROUPS_PARTIAL"/{results,logs,state,freq}
printf 'BASELINE_CHILDREN=4\nBASELINE_WAVES=5\nGROUP_WAVES=5\nCOMPLETED_PHASES=\n' > "$GROUPS_PARTIAL/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_PARTIAL" STATE_DIR="$GROUPS_PARTIAL/state" META_FILE="$GROUPS_PARTIAL/results/meta.env"
  DIAG_LOG_FILE="" GROUP_WAVES=5
  GROUP_NAME=(pcores) GROUP_KIND=(pcore) GROUP_CPUS=(0-3) GROUP_CLUSTER=(-)
  diag_freq_sampler_start() { :; }
  diag_freq_sampler_stop() { :; }
  run_repro_logged() { cp "$FIX/repro-truncated.log" "$1"; REPRO_RC=1; }
  phase_groups
) > "$GROUPS_PARTIAL/first.output" 2>&1
groups_partial_first_rc=$?
groups_partial_before="$(sha256sum "$GROUPS_PARTIAL/results/groups.tsv" "$GROUPS_PARTIAL/results/groups.meta" "$GROUPS_PARTIAL/logs/groups/pcores.log")"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_PARTIAL" STATE_DIR="$GROUPS_PARTIAL/state" META_FILE="$GROUPS_PARTIAL/results/meta.env"
  DIAG_LOG_FILE="" GROUP_WAVES=5
  GROUP_NAME=(pcores) GROUP_KIND=(pcore) GROUP_CPUS=(0-3) GROUP_CLUSTER=(-)
  phase_groups
) > "$GROUPS_PARTIAL/second.output" 2>&1
groups_partial_second_rc=$?
groups_partial_after="$(sha256sum "$GROUPS_PARTIAL/results/groups.tsv" "$GROUPS_PARTIAL/results/groups.meta" "$GROUPS_PARTIAL/logs/groups/pcores.log")"
check_eq "interrupted groups evidence is preserved and explicitly requires redo" "1" \
  "$([[ $groups_partial_first_rc -ne 0 && $groups_partial_second_rc -ne 0 && "$groups_partial_before" == "$groups_partial_after" ]] && grep -q -- '--redo groups' "$GROUPS_PARTIAL/second.output" && echo 1 || echo 0)"

echo "== groups redo invalidates stale individual generation bindings =="
STALE_BIND="$TMP/stale-groups-bind"
mkdir -p "$STALE_BIND"/{results,logs,state,freq}
cat > "$STALE_BIND/results/meta.env" << EOF
MODE=quick
BASELINE_CHILDREN=8
BASELINE_WAVES=10
GROUP_WAVES=5
INDIVIDUAL_RUNS=1
GDB_MAX_RUNS=6
SKIP_GDB=1
CPU_TARGET=auto
COMPLETED_PHASES=
EOF
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND"
  STATE_DIR="$STALE_BIND/state"
  META_FILE="$STALE_BIND/results/meta.env"
  DIAG_LOG_FILE=""
  GROUP_WAVES=5
  GROUP_NAME=(pcores ecluster-64)
  GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19)
  GROUP_CLUSTER=(- 64)
  diag_freq_sampler_start() { :; }
  diag_freq_sampler_stop() { :; }
  run_repro_logged() {
    if [[ "$1" == */pcores.log ]]; then cp "$FIX/repro-clean-4x5.log" "$1"; REPRO_RC=0
    else cp "$FIX/repro-fail.log" "$1"; REPRO_RC=1
    fi
  }
  phase_groups
) > /dev/null 2>&1
stale_bind_groups_rc=$?
stale_bind_plan_digest="$(cut -f1-8 "$STALE_BIND/results/groups.tsv" | sha256sum | cut -d' ' -f1)"
stale_bind_generation="$(sed -n 's/^GENERATION=//p' "$STALE_BIND/results/groups.meta")"
for cpu in 16 17 18 19; do printf '%s\t1\t139\t1\n' "$cpu"; done > "$STALE_BIND/results/individual.tsv"
write_individual_v4_meta "$STALE_BIND" 16-19 1 failed-groups \
  "$stale_bind_plan_digest" "$stale_bind_generation" 0 1
: > "$STALE_BIND/state/phase-individual.done"
stale_gate_before_rc=0
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND" STATE_DIR="$STALE_BIND/state" GROUP_WAVES=5 MODE=default INDIVIDUAL_RUNS=1
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
  compute_individual_targets
  individual_phase_is_complete_and_matches_expected 1
  redo_marker_temp_cleanup
) > /dev/null 2>&1 || stale_gate_before_rc=$?
check_eq "completed individual evidence bound to the validated groups generation passes the resume gate" "1" \
  "$([[ $stale_bind_groups_rc -eq 0 && $stale_gate_before_rc -eq 0 && "$stale_bind_generation" =~ ^[a-f0-9]{32}$ ]] && echo 1 || echo 0)"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND"
  STATE_DIR="$STALE_BIND/state"
  META_FILE="$STALE_BIND/results/meta.env"
  MODE=quick BASELINE_CHILDREN=8 BASELINE_WAVES=10 GROUP_WAVES=5
  INDIVIDUAL_RUNS=1 GDB_MAX_RUNS=6 SKIP_GDB=1 CPU_TARGET=auto
  REDO_PHASES=groups
  build_redo_plan
  apply_redo_plan
) > /dev/null 2>&1
stale_redo_rc=$?
stale_stash="$(find "$STALE_BIND/state/superseded" -mindepth 1 -maxdepth 1 -type d -name 'redo-*' -print -quit)"
stale_archived_generation="$(sed -n 's/^GENERATION=//p' "$stale_stash/groups/results/groups.meta")"
check_eq "redo groups archives the exact previous groups generation" "1" \
  "$([[ $stale_redo_rc -eq 0 && -n "$stale_stash" && "$stale_archived_generation" == "$stale_bind_generation" && ! -e "$STALE_BIND/results/groups.meta" && ! -e "$STALE_BIND/results/individual.meta" ]] && echo 1 || echo 0)"

(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND"
  STATE_DIR="$STALE_BIND/state"
  META_FILE="$STALE_BIND/results/meta.env"
  DIAG_LOG_FILE=""
  GROUP_WAVES=5
  GROUP_NAME=(pcores ecluster-64)
  GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19)
  GROUP_CLUSTER=(- 64)
  diag_freq_sampler_start() { :; }
  diag_freq_sampler_stop() { :; }
  run_repro_logged() {
    if [[ "$1" == */pcores.log ]]; then cp "$FIX/repro-clean-4x5.log" "$1"; REPRO_RC=0
    else cp "$FIX/repro-fail.log" "$1"; REPRO_RC=1
    fi
  }
  phase_groups
) > /dev/null 2>&1
stale_regroups_rc=$?
stale_regroups_generation="$(sed -n 's/^GENERATION=//p' "$STALE_BIND/results/groups.meta")"
# The redone plan is byte-identical (same topology), so only the fresh random
# generation distinguishes the new envelope from the archived one.
check_eq "same-topology redo groups mints a different generation for the same plan digest" "1" \
  "$([[ $stale_regroups_rc -eq 0 && "$stale_regroups_generation" =~ ^[a-f0-9]{32}$ && "$stale_regroups_generation" != "$stale_archived_generation" && "$(cut -f1-8 "$STALE_BIND/results/groups.tsv" | sha256sum | cut -d' ' -f1)" == "$stale_bind_plan_digest" ]] && echo 1 || echo 0)"

# Adversarial restore: the archived individual envelope reappears beside the
# redone groups evidence. Its plan digest still matches; its GROUP_GENERATION
# binds the archived groups generation, so the completed-phase gate must fail.
cp "$stale_stash/individual/results/individual.tsv" "$STALE_BIND/results/individual.tsv"
cp "$stale_stash/individual/results/individual.meta" "$STALE_BIND/results/individual.meta"
: > "$STALE_BIND/state/phase-individual.done"
stale_gate_output="$(
 (
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND" STATE_DIR="$STALE_BIND/state" GROUP_WAVES=5 MODE=default INDIVIDUAL_RUNS=1
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
  compute_individual_targets
  individual_phase_is_complete_and_matches_expected 1 ||
    diag_die "completed individual phase does not match the validated group target policy; preserve it and resume with --redo individual"
 ) 2>&1
)"
stale_gate_rc=$?
check_eq "individual evidence bound to a redone groups generation requires --redo individual" "1" \
  "$([[ $stale_gate_rc -ne 0 ]] && grep -q -- '--redo individual' <<< "$stale_gate_output" && echo 1 || echo 0)"

# Forgery: rewrite the stale envelope's GROUP_GENERATION to the current groups
# generation but leave its row binding untouched, then flip one row's outcome.
# The version 4 row binding must still fail closed.
sed -i "s/^GROUP_GENERATION=.*/GROUP_GENERATION=$stale_regroups_generation/" "$STALE_BIND/results/individual.meta"
sed -i 's/^16\t1\t139\t/16\t1\t0\t/' "$STALE_BIND/results/individual.tsv"
stale_forged_status="$(node "$LIB/individual-evidence.mjs" bundle "$STALE_BIND" 2> /dev/null | sed -n 's/^STATUS=//p')"
stale_forged_gate_rc=0
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$STALE_BIND" STATE_DIR="$STALE_BIND/state" GROUP_WAVES=5 MODE=default INDIVIDUAL_RUNS=1
  GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
  GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
  compute_individual_targets
  individual_phase_is_complete_and_matches_expected 1
) > /dev/null 2>&1 || stale_forged_gate_rc=$?
check_eq "forged v4 group generation with a tampered row binding assesses invalid" "invalid" "$stale_forged_status"
check_eq "forged v4 group generation with a tampered row binding fails the resume gate" "1" \
  "$([[ $stale_forged_gate_rc -ne 0 ]] && echo 1 || echo 0)"

# A well-formed legacy v3 envelope (valid plan digest, valid row binding, no
# GROUP_GENERATION) must fail the shell authority gates too: only v4 is
# authoritative, even when the groups envelope validates.
cp "$stale_stash/individual/results/individual.tsv" "$STALE_BIND/results/individual.tsv"
write_individual_v4_meta "$STALE_BIND" 16-19 1 failed-groups \
  "$stale_bind_plan_digest" "$stale_regroups_generation" 0 1
sed -i 's/^VERSION=4/VERSION=3/; /^GROUP_GENERATION=/d' "$STALE_BIND/results/individual.meta"
: > "$STALE_BIND/state/phase-individual.done"
stale_v3_gate_output="$(
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    RUN_SCHEMA_VERSION=1
    OUT_DIR="$STALE_BIND" STATE_DIR="$STALE_BIND/state" GROUP_WAVES=5 MODE=default INDIVIDUAL_RUNS=1
    GROUP_NAME=(pcores ecluster-64) GROUP_KIND=(pcore ecluster)
    GROUP_CPUS=(0-3 16-19) GROUP_CLUSTER=(- 64)
    compute_individual_targets
    individual_phase_is_complete_and_matches_expected 1 ||
      diag_die "completed individual phase does not match the validated group target policy; preserve it and resume with --redo individual"
  ) 2>&1
)"
stale_v3_gate_rc=$?
check_eq "legacy v3 individual evidence fails the shell resume gate" "1" \
  "$([[ $stale_v3_gate_rc -ne 0 ]] && grep -q -- '--redo individual' <<< "$stale_v3_gate_output" && echo 1 || echo 0)"

# Publishing v4 metadata without a derived groups generation must die before
# any file is written.
INDIVIDUAL_WRITE_GUARD="$TMP/individual-write-guard"
mkdir -p "$INDIVIDUAL_WRITE_GUARD/results"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$INDIVIDUAL_WRITE_GUARD"
  INDIVIDUAL_TARGET_POLICY=failed-groups
  INDIVIDUAL_GROUP_PLAN_DIGEST="$stale_bind_plan_digest"
  INDIVIDUAL_GROUP_GENERATION=""
  individual_meta_write 16-19 1 0 0 ""
) > "$INDIVIDUAL_WRITE_GUARD/output" 2>&1
individual_write_guard_rc=$?
check_eq "individual metadata publication requires a valid groups generation" "1" \
  "$([[ $individual_write_guard_rc -ne 0 ]] && grep -q 'valid groups generation' \
    "$INDIVIDUAL_WRITE_GUARD/output" && echo 1 || echo 0)"

GROUPS_TARGET_GUARD="$TMP/groups-target-guard"
mkdir -p "$GROUPS_TARGET_GUARD"/{results,logs,state,freq}
ln -s "$TMP/outside-group-samples" "$GROUPS_TARGET_GUARD/freq/group-pcores.samples"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  RUN_SCHEMA_VERSION=1
  OUT_DIR="$GROUPS_TARGET_GUARD" STATE_DIR="$GROUPS_TARGET_GUARD/state" GROUP_WAVES=5
  GROUP_NAME=(pcores) GROUP_KIND=(pcore) GROUP_CPUS=(0-3) GROUP_CLUSTER=(-)
  groups_prepare_fresh_targets
) > "$GROUPS_TARGET_GUARD/output" 2>&1
groups_target_guard_rc=$?
check_eq "fresh groups refuses dangling fixed sampler targets" "1" \
  "$([[ $groups_target_guard_rc -ne 0 ]] && grep -q -- '--redo groups' "$GROUPS_TARGET_GUARD/output" && echo 1 || echo 0)"

baseline_config_guards=1
for variant in duplicate noncanonical meta-symlink results-symlink; do
  config_bundle="$TMP/baseline-config-$variant"
  config_outside="$TMP/baseline-config-$variant-outside"
  mkdir -p "$config_bundle/results" "$config_outside"
  printf 'MODE=quick\nBASELINE_CHILDREN=4\nBASELINE_WAVES=5\n' > "$config_bundle/results/meta.env"
  case "$variant" in
    duplicate) printf 'BASELINE_CHILDREN=4\n' >> "$config_bundle/results/meta.env" ;;
    noncanonical) sed -i 's/BASELINE_WAVES=5/BASELINE_WAVES=05/' "$config_bundle/results/meta.env" ;;
    meta-symlink)
      mv "$config_bundle/results/meta.env" "$config_outside/meta.env"
      ln -s "$config_outside/meta.env" "$config_bundle/results/meta.env"
      ;;
    results-symlink)
      mv "$config_bundle/results/meta.env" "$config_outside/meta.env"
      rmdir "$config_bundle/results"
      ln -s "$config_outside" "$config_bundle/results"
      ;;
  esac
  (
    DIAG_SOURCE_ONLY=1
    source "$REPO_ROOT/diagnose.sh"
    load_stored_config "$config_bundle"
  ) > "$config_bundle.output" 2>&1 && baseline_config_guards=0
done
check_eq "stored baseline config is unique, canonical, and loaded without symlinks" "1" "$baseline_config_guards"

echo "== node unit tests =="
if (cd "$LIB" && node --test 'tests/*.test.mjs') > "$TMP/node-tests.log" 2>&1; then
  ok "node --test unit modules"
else
  bad "node --test unit modules"
  sed 's/^/    /' "$TMP/node-tests.log" >&2
fi

echo "== diagnose schema-2 shell integration =="
if bash "$LIB/tests/diagnose-schema2-integration.test.sh" \
  > "$TMP/diagnose-schema2-integration.log" 2>&1; then
  ok "diagnose schema-2 shell integration"
else
  bad "diagnose schema-2 shell integration"
  sed 's/^/    /' "$TMP/diagnose-schema2-integration.log" >&2
fi

echo "== end-to-end collect + report on synthetic bundle =="
B="$TMP/bundle"
mkdir -p "$B"/{results,logs/baseline,logs/groups,env,freq,gdb,state}
touch "$B/state/phase-baseline.done" "$B/state/phase-groups.done" "$B/state/phase-individual.done" "$B/state/phase-frequency.done" "$B/state/phase-gdb.done"

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
CMDLINE=tme=off
NODE_VERSION=v25.2.1
V8_VERSION=14.1.146.11-node.14
PGLITE_VERSION=0.3.0
CPU_MODEL=Test CPU
CPU_STEPPING=1
CPU_MICROCODE=0x123
CPU_ADDRESS_SIZES=46 bits physical, 48 bits virtual
CPU_LOGICAL=24
ONLINE_CPUS=0-23
KERNEL_ONLINE_CPUS=0-23
ALLOWED_CPUS=0-23
P_CORES=0-7
E_CORES=8-23
DMI_PRODUCT=Test Product
DMI_BOARD=Test Board
BIOS_VERSION=1.0
BIOS_DATE=01/01/2026
CPUFREQ_DRIVER=intel_pstate
GOVERNOR=powersave
EPP=balance_performance
NO_TURBO=0
TME_STATE=disabled (tme=off on kernel command line)
POWER_SOURCE=battery
UNDERVOLT_STATE=not installed
CCTK_STATE=not installed
MISSING_OPTIONAL=turbostat
EOF
write_preflight_fixture "$B"

cp "$FIX/repro-fail.log" "$B/logs/baseline/run1.log"
cat > "$B/results/baseline.meta" << EOF
CHILDREN=4
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=1
EOF

cp "$FIX/repro-fail.log" "$B/logs/groups/ecluster-64.log"
cp "$FIX/repro-clean-4x5.log" "$B/logs/groups/pcores.log"
cat > "$B/results/groups.tsv" << EOF
pcores	pcore	0-3	-	4	5	logs/groups/pcores.log	group-pcores	0
ecluster-64	ecluster	16-19	64	4	5	logs/groups/ecluster-64.log	group-ecluster-64	1
EOF
groups_plan_digest="$(cut -f1-8 "$B/results/groups.tsv" | sha256sum | cut -d' ' -f1)"
cat > "$B/results/groups.meta" << EOF
VERSION=2
GENERATION=$GROUPS_TEST_GENERATION
EXPECTED_ROWS=2
GROUP_WAVES=5
PLAN_DIGEST=$groups_plan_digest
COMPLETED=1
EOF

# CPUs 16-18: 20 clean runs each; CPU 19: 6 SIGSEGV in 20 runs. These
# exactly match the validated failing-group target policy.
: > "$B/results/individual.tsv"
for cpu in 16 17 18; do
  for i in $(seq 1 20); do
    printf '%s\t%s\t0\t2\n' "$cpu" "$i" >> "$B/results/individual.tsv"
  done
done
for i in $(seq 1 20); do
  if ((i <= 6)); then
    printf '19\t%s\t139\t2\n' "$i" >> "$B/results/individual.tsv"
  else
    printf '19\t%s\t0\t2\n' "$i" >> "$B/results/individual.tsv"
  fi
done
write_individual_v4_meta "$B" 16-19 20 failed-groups "$groups_plan_digest" "$GROUPS_TEST_GENERATION" 0 1

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
for leg in A1 B A2; do
  printf 'scaling_cur_freq\n' > "$B/freq/freq-ab-${leg}.method"
  if [[ "$leg" == "B" ]]; then mhz=2100000; else mhz=4700000; fi
  printf '1753950000 19 %s\n1753950001 19 %s\n' "$mhz" "$mhz" > "$B/freq/freq-ab-${leg}.samples"
done
write_frequency_ab_fixture_meta "$B" 19 4

cp "$FIX/gdb-known.txt" "$B/gdb-known-body.txt"
rm -f "$B/state/phase-gdb.done"
write_gdb_run_fixture "$B" 19 6 3 captured-then-clean "$B/gdb-known-body.txt"
rm -f "$B/gdb-known-body.txt"

# Simulated manual root-checks.sh output.
mkdir -p "$B/env/root"
printf '# cctk read-only allowlist probe\nTurboMode=Enabled\nIntelTME=Disabled\n' > "$B/env/root/cctk.txt"
printf '# intel-undervolt read\ncore (0): voltage offset: 0 mV\n' > "$B/env/root/intel-undervolt.txt"
write_root_checks_fixture "$B"

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
check("wave-level clustered counts propagated", r.baseline.sigsegvWaveCount === 2 &&
  r.baseline.sigsegvResolvedWaveCount === 5 && r.baseline.sigsegvUnresolvedWaveCount === 0 &&
  r.groups[1].sigsegvWaveCount === 2 && r.groups[0].sigsegvResolvedWaveCount === 5);
check("baseline completion structure", r.baseline.completionStatus === "complete" && r.baseline.issues.length === 0);
check("baseline evidence envelope", r.baselineStatus.status === "complete" && r.baselineStatus.reasons.length === 0);
check("worst cpu is 19", r.worstCpu === 19);
check("individual tally", r.individual.length === 4 && r.individual[3].sigsegv === 6 && r.individual.slice(0, 3).every((cpu) => cpu.failures === 0));
check("individual phase completion status", r.individualStatus.status === "complete" && r.individual[3].runs === 20);
check("gdb signature match", r.gdb.status === "captured" && r.gdb.captures.length === 1 && r.gdb.captures[0].matchesKnownSignature === true);
check("gdb attempt accounting", r.gdb.attemptedRuns === 6 && r.gdb.cleanRuns === 5 && r.gdb.capturedRuns === 1 && r.gdb.errorRuns === 0);
check("gdb capture file trimmed", r.gdb.captures[0].mappings === undefined);
check("freq ab restored + legs", r.frequencyAb.restored === true && r.frequencyAb.legs.length === 3);
check("freq leg B measured clock", r.frequencyAb.legs[1].frequency.avgMHz === 2100);
check("group failure tally", r.groups.length === 2 && r.groups[1].sigsegvCount === 2 && r.groups[0].sigsegvCount === 0);
check("group completion structure", r.groups.every((group) => group.completionStatus === "complete"));
check("root checks merged", r.rootChecksStatus.status === "complete" &&
  Boolean(r.rootChecks) && r.rootChecks["cctk.txt"].includes("IntelTME=Disabled"));
process.exit(failures === 0 ? 0 : 1);
EOF
if node "$TMP/check-results.mjs" "$B/results.json"; then
  pass=$((pass + 18))
else
  fail=$((fail + 1))
fi

grep -q "Single-process per-CPU screen (this run only)" "$B/report.md"
check_eq "report contains localization conclusion" "0" "$?"
grep -q "Permutation test" "$B/report.md"
check_eq "report omits invalid permutation localization test" "1" "$?"
grep -q "statistically significant (Fisher exact" "$B/report.md"
check_eq "post-selected Fisher significance claim is gone" "1" "$?"
grep -q "documented pattern" "$B/report.md"
check_eq "report contains signature conclusion" "0" "$?"
grep -q "Fisher exact" "$B/report.md"
check_eq "report contains Fisher test" "0" "$?"
grep -q "TME state at preflight" "$B/report.md"
check_eq "report retains descriptive TME snapshot" "0" "$?"
grep -q "Power source at preflight.*battery" "$B/report.md"
check_eq "report retains descriptive battery snapshot" "0" "$?"
grep -q "TME/MKTME is not required" "$B/report.md"
check_eq "report omits preflight-derived TME rule-out" "1" "$?"
grep -q "External power delivery is not required" "$B/report.md"
check_eq "report omits preflight-derived power rule-out" "1" "$?"
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
mkdir -p "$B2"/{results,logs/baseline,state,freq}
printf 'BASELINE_CHILDREN=2\nBASELINE_WAVES=5\n' > "$B2/results/meta.env"
cp "$FIX/repro-truncated.log" "$B2/logs/baseline/run1.log"
cat > "$B2/results/baseline.meta" << EOF
CHILDREN=2
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=1
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
grep -Eq 'The problem reproduced|No failure reproduced' "$B2/report.md"
check_eq "truncated envelope is descriptive and excluded from reproduction conclusions" "1" \
  "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

# Collector expectations are evidence: a clean-looking log whose header does
# not match baseline.meta is structurally inconsistent and cannot become a
# clean conclusion or rate bound.
B3="$TMP/bundle-repro-mismatch"
mkdir -p "$B3"/{results,logs/baseline,state,freq}
printf 'BASELINE_CHILDREN=4\nBASELINE_WAVES=3\n' > "$B3/results/meta.env"
touch "$B3/state/phase-baseline.done"
cp "$FIX/repro-clean.log" "$B3/logs/baseline/run1.log"
cat > "$B3/results/baseline.meta" << EOF
CHILDREN=4
WAVES=3
LOG=logs/baseline/run1.log
EXIT_CODE=0
EOF
node "$LIB/collect.mjs" "$B3" > /dev/null
node "$LIB/report.mjs" "$B3" > /dev/null
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.exit(r.baseline.completionStatus === "inconsistent" &&
    r.baseline.issues.some((issue) => issue.code === "expected-children-mismatch") ? 0 : 1);
' "$B3/results.json"
check_eq "collector reconciles repro logs with baseline metadata" "0" "$?"
grep -Eq 'No failure reproduced|0/6 \(95% upper' "$B3/report.md"
check_eq "metadata-mismatched repro evidence cannot support clean claims" "1" "$([[ $? -ne 0 ]] && echo 1 || echo 0)"

echo "== finalization failure handling =="
MAIN_CLEANUP_DRAIN_FAIL_LOG="$TMP/main-cleanup-drain-fail.log"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$TMP/main-cleanup-drain-fail-bundle"
  mkdir -p "$OUT_DIR"
  diag_process_group_stop() { printf 'workload\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; return 125; }
  diag_freq_sampler_stop() { printf 'sampler\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; return 125; }
  derived_manifest_revoke() { printf 'revoke\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  derived_candidate_cleanup_tracked() { printf 'candidates\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  privacy_review_temp_cleanup() { printf 'privacy\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  redo_marker_temp_cleanup() { printf 'redo\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  bundle_log_fds_close() { printf 'logs-close\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  diag_bundle_lock_release() { printf 'unlock\n' >> "$MAIN_CLEANUP_DRAIN_FAIL_LOG"; }
  diagnose_cleanup_exit 0
) > /dev/null 2>&1
main_cleanup_drain_fail_rc=$?
check_eq "main EXIT cleanup mutates nothing and retains bundle authority after drain failure" \
  $'125:workload\nsampler' \
  "$main_cleanup_drain_fail_rc:$(cat "$MAIN_CLEANUP_DRAIN_FAIL_LOG")"

MAIN_SIGNAL_DRAIN_FAIL_LOG="$TMP/main-signal-drain-fail.log"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$TMP/main-signal-drain-fail-bundle"
  diag_process_group_stop() { printf 'workload\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; return 125; }
  diag_freq_sampler_stop() { printf 'sampler\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; return 125; }
  derived_manifest_revoke() { printf 'revoke\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  derived_candidate_cleanup_tracked() { printf 'candidates\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  meta_set() { printf 'meta\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  finalize_report() { printf 'finalize\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  bundle_log_fds_close() { printf 'logs-close\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  diag_bundle_lock_release() { printf 'unlock\n' >> "$MAIN_SIGNAL_DRAIN_FAIL_LOG"; }
  on_interrupt SIGTERM
) > /dev/null 2>&1
main_signal_drain_fail_rc=$?
check_eq "main signal cleanup preserves signal status without mutation or finalization after drain failure" \
  $'143:workload\nsampler' \
  "$main_signal_drain_fail_rc:$(cat "$MAIN_SIGNAL_DRAIN_FAIL_LOG")"

MAIN_COMPLETE_DRAIN_FAIL_LOG="$TMP/main-complete-drain-fail.log"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  diag_process_group_stop() { printf 'workload\n' >> "$MAIN_COMPLETE_DRAIN_FAIL_LOG"; return 125; }
  diag_freq_sampler_stop() { printf 'sampler\n' >> "$MAIN_COMPLETE_DRAIN_FAIL_LOG"; return 125; }
  finalize_report() { printf 'finalize\n' >> "$MAIN_COMPLETE_DRAIN_FAIL_LOG"; }
  complete_diagnostic
) > /dev/null 2>&1
main_complete_drain_fail_rc=$?
check_eq "terminal completion refuses finalization after drain failure" \
  $'1:workload\nsampler' \
  "$main_complete_drain_fail_rc:$(cat "$MAIN_COMPLETE_DRAIN_FAIL_LOG")"

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

echo "== derived-output generation transaction =="
NODE_CANDIDATE_ROOT="$TMP/node-candidate-outputs"
NODE_CANDIDATE_BUNDLE="$NODE_CANDIDATE_ROOT/bundle"
mkdir -p "$NODE_CANDIDATE_ROOT"
cp -a "$B" "$NODE_CANDIDATE_BUNDLE"
printf 'old final results\n' > "$NODE_CANDIDATE_BUNDLE/results.json"
printf 'old final report\n' > "$NODE_CANDIDATE_BUNDLE/report.md"
node "$LIB/collect.mjs" "$NODE_CANDIDATE_BUNDLE" \
  "$NODE_CANDIDATE_BUNDLE/.explicit-results" > /dev/null
check_eq "collector writes only its explicit exclusive candidate" "1" \
  "$([[ "$(cat "$NODE_CANDIDATE_BUNDLE/results.json")" == 'old final results' && -s "$NODE_CANDIDATE_BUNDLE/.explicit-results" ]] && echo 1 || echo 0)"
node "$LIB/report.mjs" "$NODE_CANDIDATE_BUNDLE" \
  "$NODE_CANDIDATE_BUNDLE/.explicit-results" \
  "$NODE_CANDIDATE_BUNDLE/.explicit-report" > /dev/null
check_eq "report reads the candidate generation and leaves the old final untouched" "1" \
  "$([[ "$(cat "$NODE_CANDIDATE_BUNDLE/report.md")" == 'old final report' ]] && grep -q 'Diagnostic report' "$NODE_CANDIDATE_BUNDLE/.explicit-report" && echo 1 || echo 0)"

NODE_EARLY_BUNDLE="$NODE_CANDIDATE_ROOT/early-bundle"
mkdir -p "$NODE_EARLY_BUNDLE"
ln -s "$NODE_CANDIDATE_ROOT/missing-results" "$NODE_EARLY_BUNDLE/results"
node "$LIB/collect.mjs" "$NODE_EARLY_BUNDLE" \
  "$NODE_EARLY_BUNDLE/.explicit-results" > /dev/null
check_eq "collector early unsafe-results branch honors the explicit candidate" "1" \
  "$([[ -s "$NODE_EARLY_BUNDLE/.explicit-results" && ! -e "$NODE_EARLY_BUNDLE/results.json" ]] && echo 1 || echo 0)"

printf 'do not follow\n' > "$NODE_CANDIDATE_ROOT/victim"
ln -s "$NODE_CANDIDATE_ROOT/victim" "$NODE_CANDIDATE_BUNDLE/.blocked-results"
timeout --signal=TERM --kill-after=1 3 node "$LIB/collect.mjs" \
  "$NODE_CANDIDATE_BUNDLE" "$NODE_CANDIDATE_BUNDLE/.blocked-results" \
  > /dev/null 2>&1
node_symlink_candidate_rc=$?
mkfifo "$NODE_CANDIDATE_BUNDLE/.blocked-report"
timeout --signal=TERM --kill-after=1 3 node "$LIB/report.mjs" \
  "$NODE_CANDIDATE_BUNDLE" "$NODE_CANDIDATE_BUNDLE/.explicit-results" \
  "$NODE_CANDIDATE_BUNDLE/.blocked-report" > /dev/null 2>&1
node_fifo_candidate_rc=$?
check_eq "exclusive Node outputs reject symlink and FIFO candidates without blocking" "1" \
  "$([[ $node_symlink_candidate_rc -ne 0 && $node_fifo_candidate_rc -ne 0 && "$(cat "$NODE_CANDIDATE_ROOT/victim")" == 'do not follow' && -p "$NODE_CANDIDATE_BUNDLE/.blocked-report" ]] && echo 1 || echo 0)"
node "$LIB/collect.mjs" "$NODE_CANDIDATE_BUNDLE" "" > /dev/null 2>&1
empty_collect_output_rc=$?
node "$LIB/report.mjs" "$NODE_CANDIDATE_BUNDLE" "" \
  "$NODE_CANDIDATE_BUNDLE/.empty-input-report" > /dev/null 2>&1
empty_report_input_rc=$?
check_eq "explicit Node path forms reject empty paths instead of falling back to finals" "1" \
  "$([[ $empty_collect_output_rc -eq 2 && $empty_report_input_rc -eq 2 && ! -e "$NODE_CANDIDATE_BUNDLE/.empty-input-report" ]] && echo 1 || echo 0)"

CHECKPOINT_ROOT="$TMP/finalization-checkpoints"
mkdir -p "$CHECKPOINT_ROOT"
for checkpoint in generation-opened results-published report-published privacy-published manifest-published; do
  checkpoint_case="$CHECKPOINT_ROOT/$checkpoint"
  checkpoint_bundle="$checkpoint_case/bundle"
  mkdir -p "$checkpoint_case"
  cp -a "$B" "$checkpoint_bundle"
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    fail_checkpoint="$3"
    finalization_checkpoint() { [[ "$1" != "$fail_checkpoint" ]]; }
    if finalize_report; then exit 0; else exit $?; fi
  ' _ "$REPO_ROOT" "$checkpoint_bundle" "$checkpoint" \
    > "$checkpoint_case/output" 2>&1
  checkpoint_rc=$?
  check_eq "checkpoint failure revokes readiness and cleans candidates: $checkpoint" "1" \
    "$([[ $checkpoint_rc -ne 0 && ! -e "$checkpoint_bundle/manifest.txt" ]] && derived_transaction_temps_absent "$checkpoint_bundle" && ! grep -q 'done\. Bundle' "$checkpoint_case/output" && echo 1 || echo 0)"
done

for checkpoint in results-published report-published; do
  checkpoint_bundle="$CHECKPOINT_ROOT/$checkpoint/bundle"
  retry_sentinel="2099-12-31T23:59:${checkpoint:0:2}+00:00"
  sed -i "s|^START_ISO=.*|START_ISO=$retry_sentinel|" \
    "$checkpoint_bundle/results/meta.env"
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    finalize_report
  ' _ "$REPO_ROOT" "$checkpoint_bundle" > /dev/null 2>&1
  checkpoint_retry_rc=$?
  (cd "$checkpoint_bundle" && sha256sum -c manifest.txt) > /dev/null 2>&1
  checkpoint_retry_manifest_rc=$?
  node -e '
    const fs = require("fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(result.config.startedAt === process.argv[2] ? 0 : 1);
  ' "$checkpoint_bundle/results.json" "$retry_sentinel"
  checkpoint_retry_results_rc=$?
  check_eq "partial publication prefix converges on retry: $checkpoint" "1" \
    "$([[ $checkpoint_retry_rc -eq 0 && $checkpoint_retry_manifest_rc -eq 0 && $checkpoint_retry_results_rc -eq 0 ]] && grep -Fq "$retry_sentinel" "$checkpoint_bundle/report.md" && derived_transaction_temps_absent "$checkpoint_bundle" && echo 1 || echo 0)"
done

PAYLOAD_FAILURE_ROOT="$TMP/derived-payload-failures"
mkdir -p "$PAYLOAD_FAILURE_ROOT"
for failure_kind in results-sync results-rename report-sync report-rename; do
  failure_case="$PAYLOAD_FAILURE_ROOT/$failure_kind"
  failure_bundle="$failure_case/bundle"
  mkdir -p "$failure_case"
  cp -a "$B" "$failure_bundle"
  target_name="${failure_kind%%-*}"
  target_path="$failure_bundle/$target_name.$([[ "$target_name" == results ]] && echo json || echo md)"
  target_before="$(sha256sum "$target_path")"
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    failure_kind="$3"
    target_name="${failure_kind%%-*}"
    target_extension=json
    [[ "$target_name" == report ]] && target_extension=md
    if [[ "$failure_kind" == *-sync ]]; then
      sync() {
        if [[ "${*: -1}" == "$OUT_DIR/.$target_name.$target_extension.pending" ]]; then return 73; fi
        command sync "$@"
      }
    else
      node() {
        if [[ "${1:-}" == -e && "${*: -1}" == "$OUT_DIR/$target_name.$target_extension" ]]; then return 73; fi
        command node "$@"
      }
    fi
    if finalize_report; then exit 0; else exit $?; fi
  ' _ "$REPO_ROOT" "$failure_bundle" "$failure_kind" \
    > "$failure_case/output" 2>&1
  payload_failure_rc=$?
  target_after="$(sha256sum "$target_path")"
  check_eq "$failure_kind preserves its old final behind absent readiness" "1" \
    "$([[ $payload_failure_rc -ne 0 && "$target_after" == "$target_before" && ! -e "$failure_bundle/manifest.txt" ]] && derived_transaction_temps_absent "$failure_bundle" && echo 1 || echo 0)"
done

MANIFEST_COMMAND_FAILURE_ROOT="$TMP/manifest-command-failures"
mkdir -p "$MANIFEST_COMMAND_FAILURE_ROOT"
for failure_kind in find sort hash chmod candidate-sync rename final-sync; do
  failure_case="$MANIFEST_COMMAND_FAILURE_ROOT/$failure_kind"
  failure_bundle="$failure_case/bundle"
  mkdir -p "$failure_case/bin"
  cp -a "$B" "$failure_bundle"
  if [[ "$failure_kind" == hash ]]; then
    printf '%s\n' '#!/usr/bin/env bash' 'exit 73' > "$failure_case/bin/sha256sum"
    chmod +x "$failure_case/bin/sha256sum"
  fi
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    failure_kind="$3"
    failure_once="$4"
    if [[ "$failure_kind" == hash ]]; then
      PATH="$5:$PATH"
      hash -r
    fi
    case "$failure_kind" in
      find)
        find() {
          if [[ "$PWD" == "$OUT_DIR" && "${1:-}" == . ]]; then return 73; fi
          command find "$@"
        }
        ;;
      sort)
        sort() {
          if [[ "$PWD" == "$OUT_DIR" ]]; then return 73; fi
          command sort "$@"
        }
        ;;
      chmod)
        chmod() {
          if [[ "${*: -1}" == "$OUT_DIR/.manifest.txt.pending" ]]; then return 73; fi
          command chmod "$@"
        }
        ;;
      candidate-sync)
        sync() {
          if [[ "${*: -1}" == "$OUT_DIR/.manifest.txt.pending" ]]; then return 73; fi
          command sync "$@"
        }
        ;;
      rename)
        node() {
          if [[ "${1:-}" == -e && "${*: -1}" == "$OUT_DIR/manifest.txt" ]]; then return 73; fi
          command node "$@"
        }
        ;;
      final-sync)
        sync() {
          if [[ "${*: -1}" == "$OUT_DIR" && -f "$OUT_DIR/manifest.txt" && ! -e "$failure_once" ]]; then
            : > "$failure_once"
            return 73
          fi
          command sync "$@"
        }
        ;;
    esac
    if finalize_report; then exit 0; else exit $?; fi
  ' _ "$REPO_ROOT" "$failure_bundle" "$failure_kind" "$failure_case/failed-once" \
    "$failure_case/bin" \
    > "$failure_case/output" 2>&1
  manifest_command_failure_rc=$?
  check_eq "manifest $failure_kind failure leaves no readiness token or candidate" "1" \
    "$([[ $manifest_command_failure_rc -ne 0 && ! -e "$failure_bundle/manifest.txt" ]] && derived_transaction_temps_absent "$failure_bundle" && echo 1 || echo 0)"
done

MANIFEST_FD_ROOT="$TMP/manifest-fd-reuse"
mkdir -p "$MANIFEST_FD_ROOT/bundle"
printf 'manifest payload\n' > "$MANIFEST_FD_ROOT/bundle/payload.txt"
manifest_fd_result="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$MANIFEST_FD_ROOT/bundle"
  DIAG_LOG_FILE=""
  sort() {
    if [[ "$PWD" == "$OUT_DIR" ]]; then return 73; fi
    command sort "$@"
  }
  before_fds="$(find /proc/self/fd -mindepth 1 -maxdepth 1 -printf x | wc -c)"
  failures=0
  for _ in 1 2 3 4; do
    if write_manifest; then
      failures=99
      break
    fi
    derived_generation_abort || failures=98
    [[ -z "$DERIVED_MANIFEST_FD" ]] || failures=97
    failures=$((failures + 1))
  done
  after_fds="$(find /proc/self/fd -mindepth 1 -maxdepth 1 -printf x | wc -c)"
  printf '%s:%s:%s:%s\n' "$failures" "$before_fds" "$after_fds" \
    "$([[ -z "$DERIVED_MANIFEST_FD" ]] && echo closed || echo open)"
)"
manifest_fd_failures="${manifest_fd_result%%:*}"
manifest_fd_tail="${manifest_fd_result#*:}"
manifest_fd_before="${manifest_fd_tail%%:*}"
manifest_fd_tail="${manifest_fd_tail#*:}"
manifest_fd_after="${manifest_fd_tail%%:*}"
manifest_fd_state="${manifest_fd_tail##*:}"
check_eq "repeated post-open manifest failures do not leak a descriptor" "1" \
  "$([[ "$manifest_fd_failures" == 4 && "$manifest_fd_before" == "$manifest_fd_after" && "$manifest_fd_state" == closed ]] && derived_transaction_temps_absent "$MANIFEST_FD_ROOT/bundle" && echo 1 || echo 0)"

UNSAFE_FINAL_ROOT="$TMP/unsafe-derived-finals"
mkdir -p "$UNSAFE_FINAL_ROOT"
for unsafe_kind in directory fifo; do
  unsafe_case="$UNSAFE_FINAL_ROOT/$unsafe_kind"
  unsafe_bundle="$unsafe_case/bundle"
  mkdir -p "$unsafe_case"
  cp -a "$B" "$unsafe_bundle"
  rm -f "$unsafe_bundle/report.md"
  if [[ "$unsafe_kind" == directory ]]; then
    mkdir "$unsafe_bundle/report.md"
  else
    mkfifo "$unsafe_bundle/report.md"
  fi
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    if finalize_report; then exit 0; else exit $?; fi
  ' _ "$REPO_ROOT" "$unsafe_bundle" > "$unsafe_case/output" 2>&1
  unsafe_final_rc=$?
  check_eq "unsafe $unsafe_kind final destination fails before candidate generation" "1" \
    "$([[ $unsafe_final_rc -ne 0 && ! -e "$unsafe_bundle/manifest.txt" ]] && [[ "$unsafe_kind" == directory && -d "$unsafe_bundle/report.md" || "$unsafe_kind" == fifo && -p "$unsafe_bundle/report.md" ]] && derived_transaction_temps_absent "$unsafe_bundle" && echo 1 || echo 0)"
done

SYMLINK_FINAL_ROOT="$TMP/symlink-derived-final"
SYMLINK_FINAL_BUNDLE="$SYMLINK_FINAL_ROOT/bundle"
mkdir -p "$SYMLINK_FINAL_ROOT"
cp -a "$B" "$SYMLINK_FINAL_BUNDLE"
printf 'external report victim\n' > "$SYMLINK_FINAL_ROOT/victim"
rm -f "$SYMLINK_FINAL_BUNDLE/report.md"
ln -s "$SYMLINK_FINAL_ROOT/victim" "$SYMLINK_FINAL_BUNDLE/report.md"
timeout --signal=TERM --kill-after=1 15 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  DIAG_BUNDLE_ROOT="$2"
  DIAG_REPO_ROOT="$1"
  META_FILE="$2/results/meta.env"
  STATE_DIR="$2/state"
  DIAG_LOG_FILE="$2/run.log"
  finalize_report
' _ "$REPO_ROOT" "$SYMLINK_FINAL_BUNDLE" > /dev/null 2>&1
symlink_final_rc=$?
(cd "$SYMLINK_FINAL_BUNDLE" && sha256sum -c manifest.txt) > /dev/null 2>&1
symlink_final_manifest_rc=$?
check_eq "validated final symlink is replaced without following its victim" "1" \
  "$([[ $symlink_final_rc -eq 0 && $symlink_final_manifest_rc -eq 0 && -f "$SYMLINK_FINAL_BUNDLE/report.md" && ! -L "$SYMLINK_FINAL_BUNDLE/report.md" && "$(cat "$SYMLINK_FINAL_ROOT/victim")" == 'external report victim' ]] && echo 1 || echo 0)"

SIGNAL_CHECKPOINT_ROOT="$TMP/finalization-signals"
mkdir -p "$SIGNAL_CHECKPOINT_ROOT"
for signal_case in generation-opened:TERM results-published:INT manifest-published:TERM; do
  signal_checkpoint="${signal_case%%:*}"
  signal_name="${signal_case#*:}"
  signal_root="$SIGNAL_CHECKPOINT_ROOT/${signal_checkpoint}-${signal_name}"
  signal_bundle="$signal_root/bundle"
  mkdir -p "$signal_root"
  cp -a "$B" "$signal_bundle"
  timeout --signal=KILL 20 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE="$2/run.log"
    signal_checkpoint="$3"
    signal_name="$4"
    signal_once="$5"
    trap "on_interrupt SIGTERM" TERM
    trap "on_interrupt SIGINT" INT
    finalization_checkpoint() {
      if [[ "$1" == "$signal_checkpoint" && ! -e "$signal_once" ]]; then
        : > "$signal_once"
        kill -s "$signal_name" "$BASHPID"
      fi
    }
    finalize_report
  ' _ "$REPO_ROOT" "$signal_bundle" "$signal_checkpoint" "$signal_name" \
    "$signal_root/fired" > "$signal_root/output" 2>&1
  signal_checkpoint_rc=$?
  if [[ -f "$signal_bundle/manifest.txt" ]]; then
    (cd "$signal_bundle" && sha256sum -c manifest.txt) > /dev/null 2>&1
    signal_manifest_rc=$?
  else
    signal_manifest_rc=1
  fi
  expected_signal_rc=143
  [[ "$signal_name" == INT ]] && expected_signal_rc=130
  check_eq "handled $signal_name at $signal_checkpoint leaves one verified partial generation" "1" \
    "$([[ $signal_checkpoint_rc -eq $expected_signal_rc && $signal_manifest_rc -eq 0 ]] && derived_transaction_temps_absent "$signal_bundle" && ! grep -q 'done\. Bundle' "$signal_root/output" && echo 1 || echo 0)"
done

SIGNAL_PARTIAL_FAIL_ROOT="$TMP/finalization-signal-partial-failure"
SIGNAL_PARTIAL_FAIL_BUNDLE="$SIGNAL_PARTIAL_FAIL_ROOT/bundle"
mkdir -p "$SIGNAL_PARTIAL_FAIL_ROOT"
cp -a "$B" "$SIGNAL_PARTIAL_FAIL_BUNDLE"
timeout --signal=KILL 20 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  DIAG_BUNDLE_ROOT="$2"
  DIAG_REPO_ROOT="$1"
  META_FILE="$2/results/meta.env"
  STATE_DIR="$2/state"
  DIAG_LOG_FILE="$2/run.log"
  fired="$3"
  trap "on_interrupt SIGTERM" TERM
  finalization_checkpoint() {
    if [[ "$1" == results-published && ! -e "$fired" ]]; then
      : > "$fired"
      kill -TERM "$BASHPID"
      return 0
    fi
    [[ ! -e "$fired" || "$1" != generation-opened ]]
  }
  finalize_report
' _ "$REPO_ROOT" "$SIGNAL_PARTIAL_FAIL_BUNDLE" "$SIGNAL_PARTIAL_FAIL_ROOT/fired" \
  > "$SIGNAL_PARTIAL_FAIL_ROOT/output" 2>&1
signal_partial_fail_rc=$?
check_eq "failed best-effort signal finalization leaves readiness absent and candidates closed" "1" \
  "$([[ $signal_partial_fail_rc -eq 143 && ! -e "$SIGNAL_PARTIAL_FAIL_BUNDLE/manifest.txt" ]] && derived_transaction_temps_absent "$SIGNAL_PARTIAL_FAIL_BUNDLE" && echo 1 || echo 0)"

SIGKILL_RECOVERY_ROOT="$TMP/derived-sigkill-recovery"
SIGKILL_RECOVERY_BUNDLE="$SIGKILL_RECOVERY_ROOT/bundle"
mkdir -p "$SIGKILL_RECOVERY_ROOT"
cp -a "$B" "$SIGKILL_RECOVERY_BUNDLE"
printf 'unrelated review sibling\n' > "$SIGKILL_RECOVERY_BUNDLE.privacy-review.backup"
printf 'unrelated inventory sibling\n' > "$SIGKILL_RECOVERY_BUNDLE.privacy-inventory-before.abc123"
printf 'ordinary in-bundle sentinel 11111111-2222-3333-4444-555555555555\n' \
  > "$SIGKILL_RECOVERY_BUNDLE/.privacy-review.backup"
printf 'ordinary in-bundle inventory near-match\n' \
  > "$SIGKILL_RECOVERY_BUNDLE/.privacy-inventory-before.abc123"
timeout --signal=KILL 5 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  DIAG_BUNDLE_ROOT="$2"
  DIAG_REPO_ROOT="$1"
  META_FILE="$2/results/meta.env"
  STATE_DIR="$2/state"
  DIAG_LOG_FILE="$2/run.log"
  finalization_checkpoint() {
    [[ "$1" != results-published ]] || kill -KILL "$BASHPID"
  }
  finalize_report
' _ "$REPO_ROOT" "$SIGKILL_RECOVERY_BUNDLE" > /dev/null 2>&1
sigkill_generation_rc=$?
timeout --signal=TERM --kill-after=1 15 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  DIAG_BUNDLE_ROOT="$2"
  DIAG_REPO_ROOT="$1"
  META_FILE="$2/results/meta.env"
  STATE_DIR="$2/state"
  DIAG_LOG_FILE="$2/run.log"
  derived_run_open
  finalize_report
' _ "$REPO_ROOT" "$SIGKILL_RECOVERY_BUNDLE" \
  > "$SIGKILL_RECOVERY_ROOT/resume.output" 2>&1
sigkill_resume_rc=$?
(cd "$SIGKILL_RECOVERY_BUNDLE" && sha256sum -c manifest.txt) > /dev/null 2>&1
sigkill_resume_manifest_rc=$?
check_eq "resume cleans validated SIGKILL-stranded candidates and publishes one generation" "1" \
  "$([[ $sigkill_generation_rc -eq 137 && $sigkill_resume_rc -eq 0 && $sigkill_resume_manifest_rc -eq 0 && "$(cat "$SIGKILL_RECOVERY_BUNDLE.privacy-review.backup")" == 'unrelated review sibling' && "$(cat "$SIGKILL_RECOVERY_BUNDLE.privacy-inventory-before.abc123")" == 'unrelated inventory sibling' && "$(cat "$SIGKILL_RECOVERY_BUNDLE/.privacy-inventory-before.abc123")" == 'ordinary in-bundle inventory near-match' ]] && grep -Fxq $'uuid-shape\t.privacy-review.backup' "$SIGKILL_RECOVERY_BUNDLE/privacy-review.txt" && grep -Fq '  ./.privacy-review.backup' "$SIGKILL_RECOVERY_BUNDLE/manifest.txt" && grep -Fq '  ./.privacy-inventory-before.abc123' "$SIGKILL_RECOVERY_BUNDLE/manifest.txt" && derived_transaction_temps_absent "$SIGKILL_RECOVERY_BUNDLE" && echo 1 || echo 0)"

EARLY_REVOKE_ROOT="$TMP/early-readiness-revoke"
EARLY_REVOKE_BUNDLE="$EARLY_REVOKE_ROOT/bundle"
mkdir -p "$EARLY_REVOKE_ROOT"
cp -a "$B" "$EARLY_REVOKE_BUNDLE"
mkdir "$EARLY_REVOKE_BUNDLE/.results.json.pending"
early_revoke_before="$(sha256sum "$EARLY_REVOKE_BUNDLE/results/meta.env" "$EARLY_REVOKE_BUNDLE/run.log")"
timeout --signal=TERM --kill-after=1 15 \
  "$REPO_ROOT/diagnose.sh" --resume "$EARLY_REVOKE_BUNDLE" --yes \
  > "$EARLY_REVOKE_ROOT/output" 2>&1
early_revoke_rc=$?
early_revoke_after="$(sha256sum "$EARLY_REVOKE_BUNDLE/results/meta.env" "$EARLY_REVOKE_BUNDLE/run.log")"
check_eq "actual resume revokes readiness before logs, metadata, or candidate recovery failure" "1" \
  "$([[ $early_revoke_rc -ne 0 && ! -e "$EARLY_REVOKE_BUNDLE/manifest.txt" && ! -e "$EARLY_REVOKE_BUNDLE/commands.log" && -d "$EARLY_REVOKE_BUNDLE/.results.json.pending" && "$early_revoke_after" == "$early_revoke_before" ]] && echo 1 || echo 0)"

REVOKE_SYNC_ROOT="$TMP/readiness-revoke-sync-failure"
REVOKE_SYNC_BUNDLE="$REVOKE_SYNC_ROOT/bundle"
mkdir -p "$REVOKE_SYNC_ROOT"
cp -a "$B" "$REVOKE_SYNC_BUNDLE"
revoke_sync_before="$(sha256sum "$REVOKE_SYNC_BUNDLE/results/meta.env" "$REVOKE_SYNC_BUNDLE/run.log")"
timeout --signal=TERM --kill-after=1 5 bash -c '
  DIAG_SOURCE_ONLY=1
  source "$1/diagnose.sh"
  OUT_DIR="$2"
  DIAG_LOG_FILE=""
  sync() {
    if [[ "${*: -1}" == "$OUT_DIR" ]]; then return 73; fi
    command sync "$@"
  }
  if derived_run_open; then exit 0; else exit $?; fi
' _ "$REPO_ROOT" "$REVOKE_SYNC_BUNDLE" > "$REVOKE_SYNC_ROOT/output" 2>&1
revoke_sync_rc=$?
revoke_sync_after="$(sha256sum "$REVOKE_SYNC_BUNDLE/results/meta.env" "$REVOKE_SYNC_BUNDLE/run.log")"
check_eq "initial readiness revoke sync failure stops before metadata or log mutation" "1" \
  "$([[ $revoke_sync_rc -ne 0 && ! -e "$REVOKE_SYNC_BUNDLE/manifest.txt" && "$revoke_sync_after" == "$revoke_sync_before" ]] && echo 1 || echo 0)"

LEGACY_REDO_ROOT="$TMP/legacy-redo-manifest-recovery"
LEGACY_REDO_BUNDLE="$LEGACY_REDO_ROOT/bundle"
mkdir -p "$LEGACY_REDO_BUNDLE/state"
printf 'old readiness token\n' > "$LEGACY_REDO_BUNDLE/manifest.txt"
cat > "$LEGACY_REDO_BUNDLE/state/redo.pending" << 'EOF'
VERSION	1
TXN	redo-20260802T120000-ABC123
PHASE	gdb
DERIVED	-	manifest.txt
EOF
legacy_redo_result="$(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$LEGACY_REDO_BUNDLE"
  STATE_DIR="$LEGACY_REDO_BUNDLE/state"
  redo_transaction_validate "$STATE_DIR/redo.pending" &&
    redo_transaction_pairs_are_recoverable
  before_rc=$?
  derived_run_open
  revoke_rc=$?
  redo_transaction_validate "$STATE_DIR/redo.pending" &&
    redo_transaction_pairs_are_recoverable
  after_rc=$?
  printf '%s:%s:%s:%s\n' "$before_rc" "$revoke_rc" "$after_rc" \
    "$([[ ! -e "$OUT_DIR/manifest.txt" ]] && echo absent || echo present)"
)"
check_eq "early revocation remains compatible with legacy redo manifest records" \
  "0:0:0:absent" "$legacy_redo_result"

check_eq "successful manifest publication closes its descriptor and all candidates" "1" \
  "$(derived_transaction_temps_absent "$B" && echo 1 || echo 0)"

if ((EUID != 0)); then
  FINALIZER_LOCK_ROOT="$TMP/finalizer-writer-lock"
  FINALIZER_LOCK_READY="$FINALIZER_LOCK_ROOT/ready"
  FINALIZER_LOCK_FIFO="$FINALIZER_LOCK_ROOT/release.fifo"
  FINALIZER_FREQUENCY_STAGE="$FINALIZER_LOCK_ROOT/frequency-stage"
  FINALIZER_ROOT_STAGE="$FINALIZER_LOCK_ROOT/root-stage"
  mkdir -p "$FINALIZER_LOCK_ROOT"
  mkfifo "$FINALIZER_LOCK_FIFO"
  exec {finalizer_lock_control_fd}<> "$FINALIZER_LOCK_FIFO"
  prepare_frequency_publish_stage "$FINALIZER_FREQUENCY_STAGE" 0
  root_publish_stage_prepare "$FINALIZER_ROOT_STAGE"
  timeout --signal=TERM --kill-after=1 15 bash -c '
    DIAG_SOURCE_ONLY=1
    source "$1/diagnose.sh"
    OUT_DIR="$2"
    DIAG_BUNDLE_ROOT="$2"
    DIAG_REPO_ROOT="$1"
    META_FILE="$2/results/meta.env"
    STATE_DIR="$2/state"
    DIAG_LOG_FILE=""
    diag_bundle_lock_acquire "$2"
    finalize_report
    : > "$3"
    read -r -u "$4" _
    diag_bundle_lock_release
  ' _ "$REPO_ROOT" "$B" "$FINALIZER_LOCK_READY" "$finalizer_lock_control_fd" \
    > "$FINALIZER_LOCK_ROOT/finalizer.output" 2>&1 &
  finalizer_lock_pid=$!
  finalizer_lock_ready=0
  for _ in {1..300}; do
    if [[ -e "$FINALIZER_LOCK_READY" ]]; then
      finalizer_lock_ready=1
      break
    fi
    kill -0 "$finalizer_lock_pid" 2> /dev/null || break
    sleep 0.01
  done
  finalizer_outputs_before=""
  finalizer_frequency_rc=1
  finalizer_root_rc=1
  if ((finalizer_lock_ready == 1)); then
    finalizer_outputs_before="$(sha256sum "$B/manifest.txt" "$B/privacy-review.txt" "$B/results.json" "$B/report.md")"
    timeout --signal=TERM --kill-after=1 5 \
      bash "$LIB/publish-frequency-output.sh" "$FINALIZER_FREQUENCY_STAGE" "$B" \
      > /dev/null 2>&1
    finalizer_frequency_rc=$?
    timeout --signal=TERM --kill-after=1 5 \
      bash "$LIB/publish-root-checks-output.sh" "$FINALIZER_ROOT_STAGE" "$B" \
      > /dev/null 2>&1
    finalizer_root_rc=$?
  fi
  printf 'release\n' >&"$finalizer_lock_control_fd"
  wait "$finalizer_lock_pid"
  finalizer_lock_rc=$?
  exec {finalizer_lock_control_fd}<&-
  finalizer_outputs_after="$(sha256sum "$B/manifest.txt" "$B/privacy-review.txt" "$B/results.json" "$B/report.md" 2> /dev/null)"
  check_eq "diagnose finalization excludes both unprivileged publishers" "1" \
    "$([[ $finalizer_lock_ready -eq 1 && $finalizer_lock_rc -eq 0 && $finalizer_frequency_rc -eq 75 && $finalizer_root_rc -eq 75 && "$finalizer_outputs_after" == "$finalizer_outputs_before" && -f "$FINALIZER_FREQUENCY_STAGE/results/frequency-ab.tsv" && -f "$FINALIZER_ROOT_STAGE/root-checks.meta" ]] && echo 1 || echo 0)"
else
  ok "diagnose finalization excludes both unprivileged publishers [skipped while tests run as root]"
fi

echo
printf 'passed=%d failed=%d\n' "$pass" "$fail"
((fail == 0))
